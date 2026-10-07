// The recorded-hours explorer in the real page: the page's own script in a real
// DOM (happy-dom), the real Worker and snapshot API in process, and a real
// SQLite store holding the pushed "recordings" section built around the real
// channel-hours fixture. Expected numbers are summed here from the fixture.

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import worker from "../src/index";
import type { Section } from "../src/lib/schema";
import { savePushedSection } from "../src/lib/store";
import { renderDashboardPage } from "../src/routes/ui";
import type { Bindings } from "../src/types";
import sample from "./fixtures/channel-hours.sample.json";
import { asD1 } from "./helpers/d1";
import { MIGRATIONS } from "./helpers/migrations";

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const ORIGIN = "https://dashboard.nemar.org";
type Doc = Window["document"];

const open: { window: Window; engine: Database }[] = [];
afterEach(async () => {
  for (const page of open.splice(0)) {
    await page.window.happyDOM.close();
    page.engine.close();
  }
});

const totalHours = sample.modalities.reduce((s, m) => s + m.hours, 0);
// The section the Zarr indexer pushes: headline metrics derived from the same
// fixture, and the fixture itself as the channel_hours payload.
function recordingsSection(withHours = true): Section {
  return {
    key: "recordings",
    label: "Recorded hours",
    source: "nemar-zarr-index",
    updated_at: new Date().toISOString(),
    metrics: [
      {
        key: "recordings.hours",
        label: "Recorded hours",
        value: totalHours,
        unit: "hours",
        severity: "info",
        breakdown: sample.modalities.map((m) => ({ label: m.modality, value: m.hours })),
      },
      {
        key: "recordings.datasets",
        label: "Datasets indexed",
        value: sample.datasets_scanned,
        unit: "datasets",
        severity: "info",
      },
    ],
    ...(withHours ? { channel_hours: sample } : {}),
  };
}

async function openPage(section: Section | null, hash = "") {
  const engine = new Database(":memory:");
  for (const migration of MIGRATIONS) engine.run(migration);
  const db = asD1(engine);
  if (section) await savePushedSection(db, section);
  // No NEMAR_DB: the built-in sections fail for real, and the pushed section
  // still reaches the snapshot, as it would on a deploy with a database outage.
  const env = { OBS_DB: db } as unknown as Bindings;
  const window = new Window({
    url: `${ORIGIN}/observability${hash}`,
    settings: { enableJavaScriptEvaluation: true } as never,
  });
  open.push({ window, engine });
  const errors: string[] = [];
  window.addEventListener("error", (event) =>
    errors.push(String((event as unknown as { error?: unknown }).error)),
  );
  window.addEventListener("unhandledrejection", (event) =>
    errors.push(`unhandled: ${String((event as unknown as { reason?: unknown }).reason)}`),
  );
  (window as unknown as { fetch: unknown }).fetch = async (input: unknown) => {
    const response = await worker.fetch(new Request(new URL(String(input), ORIGIN).href), env, ctx);
    return new window.Response(await response.text(), {
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
    });
  };
  window.document.write(renderDashboardPage());
  const document = window.document;
  await until(
    () => document.getElementById("channel-hours")?.getAttribute("aria-busy") !== "true",
    "the explorer to settle",
  );
  return { window, document, errors };
}

async function until(check: () => boolean, what: string, ms = 4000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}

type Node = { textContent: string | null; getAttribute(name: string): string | null };
const q = (doc: Doc, selector: string) =>
  doc.querySelector(selector) as unknown as Node & { focus(): void; click(): void; id: string };
const all = (doc: Doc, selector: string) =>
  Array.from(doc.querySelectorAll(selector)) as unknown as (Node & { id: string })[];
const text = (doc: Doc, selector: string) => q(doc, selector)?.textContent ?? "";
const readout = (doc: Doc) => ({
  value: text(doc, ".hours-value"),
  claim: text(doc, ".hours-claim"),
  share: text(doc, ".hours-share"),
  facts: all(doc, ".hours-fact").map((f) => f.textContent),
  slider: q(doc, "#hours-min").getAttribute("aria-valuetext"),
});
function key(doc: Doc, window: Window, selector: string, name: string) {
  const target = doc.querySelector(selector) as unknown as { dispatchEvent(e: unknown): void };
  target.dispatchEvent(
    new window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }),
  );
}
const sum = (list: number[]) => list.reduce((s, v) => s + v, 0);
const eeg = sample.modalities[0];
const at = (m: (typeof sample.modalities)[number], min: number) => ({
  hours: sum(m.bins.filter((b) => b.channels >= min).map((b) => b.hours)),
  recordings: sum(m.bins.filter((b) => b.channels >= min).map((b) => b.recordings)),
  datasets: sum(m.dataset_peaks.filter((p) => p.channels >= min).map((p) => p.datasets)),
});
const whole = (n: number) => Math.round(n).toLocaleString("en-US");

describe("recorded hours before the collector reports", () => {
  test("no section at all is a quiet not-measured state, and the page is otherwise intact", async () => {
    const { document, errors } = await openPage(null);
    expect(text(document, "#channel-hours")).toContain("Recorded hours are not measured yet");
    expect(text(document, "#channel-hours")).toContain("not the same as zero");
    expect(document.querySelector("[role=tablist]")).toBeNull();
    expect(errors).toEqual([]);
  });

  test("a section without hours this run says they are not in the snapshot", async () => {
    const { document, errors } = await openPage(recordingsSection(false));
    expect(text(document, "#channel-hours")).toContain(
      "Recorded hours are not in the latest snapshot",
    );
    // Its pipeline card still shows, and offers no link to an explorer that is not there.
    await until(() => document.getElementById("card-recordings") !== null, "the recordings card");
    expect(text(document, "#card-recordings")).not.toContain("Explore hours by channel count");
    expect(errors).toEqual([]);
  });
});

describe("recorded hours explorer", () => {
  test("tabs, panel, and slider carry their roles and labels", async () => {
    const { document, errors } = await openPage(recordingsSection());
    const tablist = q(document, "#channel-hours [role=tablist]");
    expect(tablist.getAttribute("aria-label")).toBe("Recording type");
    const tabs = all(document, "[role=tab]");
    // Ordered by hours: EEG 4,646, EMG 627, iEEG 294, MEG 74.
    expect(tabs.map((t) => text(document, `#${t.id} .hours-tab-name`))).toEqual([
      "EEG",
      "EMG",
      "iEEG",
      "MEG",
    ]);
    expect(tabs.map((t) => t.getAttribute("aria-selected"))).toEqual([
      "true",
      "false",
      "false",
      "false",
    ]);
    expect(tabs.map((t) => t.getAttribute("tabindex"))).toEqual(["0", "-1", "-1", "-1"]);
    for (const t of tabs) expect(t.getAttribute("aria-controls")).toBe("hours-panel");
    // Each tab states its total, rounded on screen and exact for screen readers.
    expect(tabs[0].textContent).toContain(`${whole(eeg.hours)} h`);
    expect(tabs[0].textContent).toContain(`${whole(eeg.hours)} hours`);
    const panel = q(document, "#hours-panel");
    expect(panel.getAttribute("role")).toBe("tabpanel");
    expect(panel.getAttribute("aria-labelledby")).toBe(tabs[0].id);
    const range = q(document, "#hours-min");
    expect(range.getAttribute("type")).toBe("range");
    expect(text(document, 'label[for="hours-min"]')).toBe("Minimum channels per recording");
    expect(errors).toEqual([]);
  });

  test("opens on the owner's question: hours of EEG at 16 or more channels", async () => {
    const { document } = await openPage(recordingsSection());
    const want = at(eeg, 16);
    const r = readout(document);
    expect(r.value).toBe(`${whole(want.hours)} hours`);
    expect(r.claim).toBe("of EEG recorded with 16 or more channels");
    expect(r.share).toBe(
      `${(Math.round((want.hours / eeg.hours) * 1000) / 10).toFixed(1)}% of the ${whole(eeg.hours)} EEG hours`,
    );
    expect(r.facts).toEqual([
      `Recordings${want.recordings.toLocaleString("en-US")}`,
      `Datasets${want.datasets}`,
      expect.stringMatching(/^Channel-hours.*195k$/),
    ]);
    expect(r.slider).toBe(`16 or more channels: ${whole(want.hours)} hours`);
  });

  test("the chart colors exactly the counts at or above the minimum, and the table marks the cut", async () => {
    const { document } = await openPage(recordingsSection());
    const bars = all(document, "#channel-hours .hours-bar");
    expect(bars).toHaveLength(eeg.bins.filter((b) => b.hours > 0).length);
    expect(all(document, "#channel-hours .hours-bar.is-in")).toHaveLength(
      eeg.bins.filter((b) => b.channels >= 16).length,
    );
    expect(text(document, "#channel-hours .chart-annotation")).toBe("16 or more");
    expect(text(document, ".hours-foot summary")).toBe(
      `Show exact values (${eeg.bins.length} channel counts)`,
    );
    expect(all(document, ".hours-table tbody tr:not(.hours-cut)")).toHaveLength(eeg.bins.length);
    expect(all(document, ".hours-table .is-below")).toHaveLength(
      eeg.bins.filter((b) => b.channels < 16).length,
    );
    expect(text(document, ".hours-table .hours-cut")).toBe("Counted: 16 or more channels");
    expect(text(document, ".hours-foot")).toContain(
      `From the Zarr copies of ${sample.datasets_scanned} public datasets`,
    );
  });

  test("the slider steps through stops with the keyboard and says where it is", async () => {
    const { window, document, errors } = await openPage(recordingsSection());
    // EEG has recordings at 19 channels, the next count above 16.
    key(document, window, "#hours-min", "ArrowRight");
    expect(readout(document).slider).toBe(`19 or more channels: ${whole(at(eeg, 19).hours)} hours`);
    key(document, window, "#hours-min", "ArrowLeft");
    key(document, window, "#hours-min", "PageUp");
    expect(readout(document).claim).toBe("of EEG recorded with 32 or more channels");
    expect(readout(document).value).toBe(`${whole(at(eeg, 32).hours)} hours`);
    key(document, window, "#hours-min", "End");
    // The largest EEG count in the sample is 257 channels, 3.6 hours.
    expect(readout(document).slider).toBe("257 or more channels: 3.6 hours");
    key(document, window, "#hours-min", "Home");
    expect(readout(document).slider).toBe(`any number of channels: ${whole(eeg.hours)} hours`);
    expect(readout(document).share).toBe(`100% of the ${whole(eeg.hours)} EEG hours`);
    expect(all(document, "#channel-hours .hours-bar.is-in")).toHaveLength(eeg.bins.length);
    expect(errors).toEqual([]);
  });

  test("a step from assistive technology moves to the next stop, not back to the same one", async () => {
    const { window, document } = await openPage(recordingsSection());
    const range = document.getElementById("hours-min") as unknown as {
      value: string;
      dispatchEvent(e: unknown): void;
    };
    // One unit up from 16 channels is still nearest to 16; it must not stick there.
    range.value = String(Number(range.value) + 1);
    range.dispatchEvent(new window.Event("input", { bubbles: true }));
    expect(readout(document).claim).toBe("of EEG recorded with 19 or more channels");
  });

  test("tabs switch with arrow keys and keep the minimum", async () => {
    const { window, document } = await openPage(recordingsSection());
    q(document, "#hours-tab-0").focus();
    key(document, window, "[role=tablist]", "ArrowRight");
    expect(q(document, "#hours-tab-1").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement?.id).toBe("hours-tab-1");
    expect(q(document, "#hours-panel").getAttribute("aria-labelledby")).toBe("hours-tab-1");
    // All EMG in the sample has 16 or 32 channels, so 16 or more is all of it.
    const emg = sample.modalities.find((m) => m.modality === "EMG");
    if (!emg) throw new Error("fixture has no EMG");
    expect(readout(document).value).toBe(`${whole(emg.hours)} hours`);
    expect(readout(document).share).toBe(`100% of the ${whole(emg.hours)} EMG hours`);
    key(document, window, "[role=tablist]", "End");
    expect(text(document, '[role=tab][aria-selected="true"] .hours-tab-name')).toBe("MEG");
    key(document, window, "[role=tablist]", "ArrowRight");
    expect(text(document, '[role=tab][aria-selected="true"] .hours-tab-name')).toBe("EEG");
  });

  test("counting datasets uses each dataset's largest recording", async () => {
    const { document } = await openPage(recordingsSection());
    q(document, '[data-measure="datasets"]').click();
    expect(q(document, '[data-measure="datasets"]').getAttribute("aria-pressed")).toBe("true");
    expect(readout(document).value).toBe(`${at(eeg, 16).datasets} datasets`);
    expect(readout(document).claim).toBe("have EEG recordings with 16 or more channels");
    expect(readout(document).share).toBe(
      `${Math.round((at(eeg, 16).datasets / eeg.datasets) * 100)}% of the ${eeg.datasets} EEG datasets`,
    );
    expect(text(document, ".hours-plot-title")).toBe("Datasets by their largest channel count");
    expect(all(document, "#channel-hours .hours-bar")).toHaveLength(eeg.dataset_peaks.length);
  });

  test("a shared link opens that view, and moving the slider rewrites the link", async () => {
    const { window, document } = await openPage(recordingsSection(), "#hours=emg:32:datasets");
    expect(text(document, '[role=tab][aria-selected="true"] .hours-tab-name')).toBe("EMG");
    expect(readout(document).value).toBe("1 dataset");
    expect(readout(document).claim).toBe("has EMG recordings with 32 or more channels");
    key(document, window, "#hours-min", "ArrowLeft");
    await until(
      () => window.location.hash === "#hours=emg:16:datasets",
      "the address to follow the view",
    );
  });

  test("a link to a modality that is not present is ignored", async () => {
    const { document } = await openPage(recordingsSection(), "#hours=fnirs:8");
    expect(text(document, '[role=tab][aria-selected="true"] .hours-tab-name')).toBe("EEG");
    expect(readout(document).claim).toBe("of EEG recorded with 16 or more channels");
  });

  test("the recordings pipeline card formats hours and links to the explorer", async () => {
    const { document } = await openPage(recordingsSection());
    await until(() => document.getElementById("card-recordings") !== null, "the recordings card");
    const card = text(document, "#card-recordings");
    expect(card).toContain(`${whole(totalHours)} h`);
    expect(card).toContain(`EEG${whole(eeg.hours)} h`);
    expect(card).toContain("From the Zarr copies of public datasets");
    expect(q(document, "#card-recordings .card-link").getAttribute("href")).toBe("#recorded-hours");
  });
});
