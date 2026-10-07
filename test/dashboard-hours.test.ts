// The recorded-hours explorer in the real page (see test/helpers/hours-page.ts
// for how the page is opened). Expected numbers are summed here from the
// fixture, independently of the page's code.

import { afterEach, describe, expect, test } from "bun:test";
import { CHANNELS_JS } from "../src/routes/dashboard/channels";
import { EXPLORER_JS } from "../src/routes/dashboard/explorer";
import { MODALITY_JS } from "../src/routes/dashboard/modality";
import { STYLES } from "../src/routes/dashboard/styles";
import sample from "./fixtures/channel-hours.sample.json";
import {
  all,
  at,
  closePages,
  eeg,
  expectThumbAt,
  key,
  oneDecimal,
  openPage,
  openTable,
  q,
  range,
  readout,
  recordingsSection,
  text,
  until,
  whole,
} from "./helpers/hours-page";
import { JARGON } from "./helpers/public-copy";

afterEach(closePages);

describe("recorded hours before the collector reports", () => {
  test("no section at all says plainly that no data is available, and the page is otherwise intact", async () => {
    const { document, errors } = await openPage(null);
    expect(text(document, "#channel-hours")).toContain(
      "No recorded-hours data is available right now",
    );
    expect(text(document, "#channel-hours")).toContain("not the same as zero");
    // No promise about when it will appear.
    expect(text(document, "#channel-hours")).not.toMatch(/once|soon|appear/i);
    expect(document.querySelector("[role=tablist]")).toBeNull();
    expect(errors).toEqual([]);
  });

  test("a section without hours this run says the same, without guessing why", async () => {
    const { document, errors } = await openPage(recordingsSection(false));
    expect(text(document, "#channel-hours")).toContain(
      "No recorded-hours data is available right now",
    );
    // Its pipeline card still shows, and offers no link to an explorer that is not there.
    await until(() => document.getElementById("card-recordings") !== null, "the recordings card");
    expect(text(document, "#card-recordings")).not.toContain("Explore hours by channel count");
    expect(errors).toEqual([]);
  });
});

describe("data that should not be read at face value", () => {
  test("data more than three days old says when it was last updated", async () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 86_400_000).toISOString();
    const { document } = await openPage(recordingsSection(true, { updatedAt: tenDaysAgo }));
    expect(text(document, ".hours-notices")).toBe("This was last updated 10 days ago.");
    // The answer is still shown, under the notice.
    expect(readout(document).claim).toBe("of EEG recorded with 16 or more channels");
  });

  test("fresh, complete data shows no notice", async () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const { document } = await openPage(recordingsSection(true, { updatedAt: twoDaysAgo }));
    expect(text(document, ".hours-notices")).toBe("");
  });

  test("datasets that could not be read make the totals incomplete, and it says so", async () => {
    const partial = { ...structuredClone(sample), datasets_unavailable: 3 };
    const { document } = await openPage(recordingsSection(true, { payload: partial }));
    expect(text(document, ".hours-notices")).toBe(
      "3 datasets could not be read in the last run, so these totals are incomplete.",
    );
  });
});

describe("the tab strip on a narrow screen", () => {
  // happy-dom does no layout, so this pins the rule that keeps the page from
  // scrolling sideways: each tab total carries screen-reader text that is
  // absolutely positioned, and only a positioned strip clips it. Checked in
  // headless Chrome with twelve tabs at 390 px: the page stays 390 px wide.
  test("the strip is positioned and scrolls on its own", () => {
    expect(STYLES).toMatch(/\.sr-only \{ position: absolute;/);
    expect(STYLES).toMatch(/\.hours-tabs \{\s*position: relative;[^}]*overflow-x: auto;/);
    // Edge shadows only on a strip the script has found to scroll.
    expect(STYLES).toMatch(/\.hours-tabs\.is-scrollable \{\s*background:/);
    expect(MODALITY_JS).toContain(
      'tablist.classList.toggle("is-scrollable", stripScrolls(tablist.clientWidth, tablist.scrollWidth))',
    );
  });
});

describe("recorded hours explorer", () => {
  test("tabs, panel, and slider carry their roles and labels", async () => {
    const { document, errors } = await openPage(recordingsSection());
    const tablist = q(document, "#channel-hours [role=tablist]");
    expect(tablist.getAttribute("aria-label")).toBe("Recording type, recorded hours");
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
      `${oneDecimal(want.hours, eeg.hours)} of the ${whole(eeg.hours)} EEG hours`,
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
    // Closed, the table is not built; opening it fills it for the current view.
    expect(all(document, ".hours-table tbody tr")).toHaveLength(0);
    openTable(document);
    expect(all(document, ".hours-table tbody tr:not(.hours-cut)")).toHaveLength(eeg.bins.length);
    expect(all(document, ".hours-table .is-below")).toHaveLength(
      eeg.bins.filter((b) => b.channels < 16).length,
    );
    expect(text(document, ".hours-table .hours-cut")).toBe("Counted: 16 or more channels");
    expect(text(document, ".hours-foot")).toContain(
      `Read from ${sample.datasets_scanned} public datasets converted for in-browser viewing`,
    );
    expect(text(document, ".hours-caption")).toBe(
      "Datasets are counted once, at the channel count of their largest recording. Hours and recordings are counted at each recording's own channel count.",
    );
  });

  test("the slider steps through stops with the keyboard and says where it is", async () => {
    const { window, document, errors } = await openPage(recordingsSection());
    // EEG has recordings at 19 channels, the next count above 16.
    expectThumbAt(document, 16);
    key(document, window, "#hours-min", "ArrowRight");
    expect(readout(document).slider).toBe(`19 or more channels: ${whole(at(eeg, 19).hours)} hours`);
    expectThumbAt(document, 19);
    key(document, window, "#hours-min", "ArrowLeft");
    key(document, window, "#hours-min", "PageUp");
    expect(readout(document).claim).toBe("of EEG recorded with 32 or more channels");
    expect(readout(document).value).toBe(`${whole(at(eeg, 32).hours)} hours`);
    expectThumbAt(document, 32);
    key(document, window, "#hours-min", "End");
    // The largest EEG count in the sample is 257 channels, 3.6 hours.
    expect(readout(document).slider).toBe("257 or more channels: 3.6 hours");
    expectThumbAt(document, 257);
    // Page Up at the end stays at the end rather than falling back to 256.
    key(document, window, "#hours-min", "PageUp");
    expect(readout(document).claim).toBe("of EEG recorded with 257 or more channels");
    key(document, window, "#hours-min", "Home");
    expect(readout(document).slider).toBe(`any number of channels: ${whole(eeg.hours)} hours`);
    expect(readout(document).share).toBe(`100% of the ${whole(eeg.hours)} EEG hours`);
    expect(all(document, "#channel-hours .hours-bar.is-in")).toHaveLength(eeg.bins.length);
    expect(errors).toEqual([]);
  });

  test("a step from assistive technology moves to the next stop, not back to the same one", async () => {
    const { window, document } = await openPage(recordingsSection());
    const r = range(document);
    // One unit up from 16 channels is still nearest to 16; it must not stick there.
    r.value = String(Number(r.value) + 1);
    r.dispatchEvent(new window.Event("input", { bubbles: true }));
    expect(readout(document).claim).toBe("of EEG recorded with 19 or more channels");
    expectThumbAt(document, 19);
  });

  test("a drag lands on the stop nearest the pointer", async () => {
    const { window, document } = await openPage(recordingsSection());
    const r = range(document);
    r.dispatchEvent(new window.Event("pointerdown", { bubbles: true }));
    // 62 channels sits between the 60 and 63 that EEG has; 63 is nearer on the log axis.
    r.value = String(Math.round(1000 * Math.log2(62)));
    r.dispatchEvent(new window.Event("input", { bubbles: true }));
    expect(readout(document).claim).toBe("of EEG recorded with 63 or more channels");
    expectThumbAt(document, 63);
    r.value = String(Math.round(1000 * Math.log2(128)));
    r.dispatchEvent(new window.Event("input", { bubbles: true }));
    expect(readout(document).claim).toBe("of EEG recorded with 128 or more channels");
    r.dispatchEvent(new window.Event("pointerup", { bubbles: true }));
    // Once released, a one-unit nudge steps again instead of snapping back.
    r.value = String(Number(r.value) - 1);
    r.dispatchEvent(new window.Event("input", { bubbles: true }));
    expect(readout(document).claim).toBe("of EEG recorded with 127 or more channels");
  });

  test("browser shortcuts with a modifier key are left alone", async () => {
    const { window, document } = await openPage(recordingsSection());
    const event = new window.KeyboardEvent("keydown", {
      key: "ArrowRight",
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    range(document).dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
    expect(readout(document).claim).toBe("of EEG recorded with 16 or more channels");
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
    expectThumbAt(document, 16);
    // Focus stays on the tab, so the new answer is announced once.
    expect(text(document, "#hours-panel .hours-live")).toBe(
      `${whole(emg.hours)} hours of EMG recorded with 16 or more channels. 100% of the ${whole(emg.hours)} EMG hours.`,
    );
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
      `${oneDecimal(at(eeg, 16).datasets, eeg.datasets)} of the ${eeg.datasets} EEG datasets`,
    );
    // Gridlines for a count are whole numbers (the tallest peak is 9 datasets).
    const ticks = all(document, "#channel-hours .chart-tick").map((t) => t.textContent ?? "");
    expect(ticks.every((t) => /^\d{1,3}(,\d{3})*$/.test(t))).toBe(true);
    expect(ticks.slice(0, 3)).toEqual(["0", "5", "10"]);
    expect(text(document, ".hours-plot-title")).toBe("Datasets by their largest channel count");
    expect(all(document, "#channel-hours .hours-bar")).toHaveLength(eeg.dataset_peaks.length);
  });

  test("a shared link opens that view, and moving the slider rewrites the link", async () => {
    const { window, document } = await openPage(recordingsSection(), "#hours=emg:32:datasets");
    expect(text(document, '[role=tab][aria-selected="true"] .hours-tab-name')).toBe("EMG");
    expect(readout(document).value).toBe("1 dataset");
    expect(readout(document).claim).toBe("has EMG recordings with 32 or more channels");
    expectThumbAt(document, 32);
    key(document, window, "#hours-min", "ArrowLeft");
    await until(
      () => window.location.hash === "#hours=emg:16:datasets",
      "the address to follow the view",
    );
  });

  test("a link past the largest count shows the largest count, and says so", async () => {
    const { window, document } = await openPage(recordingsSection(), "#hours=eeg:400");
    // EEG in the sample tops out at 257 channels.
    expect(readout(document).slider).toBe("257 or more channels: 3.6 hours");
    expect(text(document, ".hours-notices")).toBe(
      "This link's view is not available. Showing EEG, 257 or more channels.",
    );
    expect(window.location.hash).toBe("#hours=eeg:257");
  });

  test("a minimum carried over from another tab steps down, never up", async () => {
    // MEG reaches 415 channels; the minimum is kept when the tab changes, so
    // EEG then shows 415 or more, beyond its last stop.
    const { window, document } = await openPage(recordingsSection(), "#hours=meg:415");
    q(document, "#hours-tab-0").click();
    expect(readout(document).slider).toBe("415 or more channels: 0 hours");
    expectThumbAt(document, 415);
    for (const name of ["ArrowRight", "PageUp"]) {
      key(document, window, "#hours-min", name);
      expect(readout(document).claim).toBe("of EEG recorded with 415 or more channels");
    }
    key(document, window, "#hours-min", "ArrowLeft");
    expect(readout(document).claim).toBe("of EEG recorded with 257 or more channels");
  });

  test("a failure while redrawing stays in the explorer, and the address still follows", async () => {
    const { window, document, errors, logged } = await openPage(
      recordingsSection(),
      "#hours=eeg:16",
    );
    await until(() => document.getElementById("card-recordings") !== null, "the recordings card");
    // happy-dom keeps the page script's functions private, so the fault goes
    // into something the redraw touches: the slider's setAttribute, which the
    // redraw calls after it has already changed the readout. The failure then
    // travels the real path from a key press.
    const slider = document.getElementById("hours-min") as unknown as Record<string, unknown>;
    slider.setAttribute = () => {
      throw new Error("injected for this test");
    };
    key(document, window, "#hours-min", "ArrowRight");
    expect(text(document, "#channel-hours")).toContain("Could not display recorded hours");
    expect(document.querySelector("#channel-hours [role=tablist]")).toBeNull();
    // The rest of the page is untouched, and nothing escaped as an uncaught error.
    expect(document.getElementById("card-recordings")).not.toBeNull();
    expect(errors).toEqual([]);
    expect(logged).toContain("[ui] recorded hours display failed: injected for this test");
    // Try again at once, while the address still says 16: it draws afresh (the
    // injected fault went with the old slider) and keeps the view the reader
    // chose, not the address that lags it.
    expect(window.location.hash).toBe("#hours=eeg:16");
    (document.querySelector("#channel-hours .button") as unknown as { click(): void }).click();
    expect(document.querySelector("#channel-hours [role=tablist]")).not.toBeNull();
    expect(readout(document).claim).toBe("of EEG recorded with 19 or more channels");
    // The address update was scheduled before the drawing failed, so it still
    // lands once its 250 ms debounce runs out.
    await until(() => window.location.hash === "#hours=eeg:19", "the address to follow the view");
    expect(errors).toEqual([]);
  });

  test("End goes to the largest count the selected modality has", async () => {
    const { window, document } = await openPage(recordingsSection(), "#hours=emg:16");
    key(document, window, "#hours-min", "End");
    // EMG in the sample tops out at 32 channels, below the 256 stop.
    expect(readout(document).claim).toBe("of EMG recorded with 32 or more channels");
    expectThumbAt(document, 32);
  });

  test("a link this snapshot cannot show says so, and the address shows what is shown", async () => {
    for (const hash of [
      "#hours=nope:16",
      "#hours=eeg:0",
      "#hours=eeg:16:minutes",
      "#hours=%E0%A4%A:16",
      "#hours=eeg",
    ]) {
      const { window, document } = await openPage(recordingsSection(), hash);
      expect(text(document, '[role=tab][aria-selected="true"] .hours-tab-name')).toBe("EEG");
      expect(readout(document).claim).toBe("of EEG recorded with 16 or more channels");
      expect(text(document, ".hours-notices")).toBe(
        "This link's view is not available. Showing EEG, 16 or more channels.",
      );
      expect(window.location.hash).toBe("#hours=eeg:16");
    }
  });

  test("a link asking for far more channels than exist states the minimum shown", async () => {
    const { window, document } = await openPage(recordingsSection(), "#hours=emg:100000");
    // EMG in the sample tops out at 32 channels.
    expect(readout(document).claim).toBe("of EMG recorded with 32 or more channels");
    expect(text(document, ".hours-notices")).toBe(
      "This link's view is not available. Showing EMG, 32 or more channels.",
    );
    expect(window.location.hash).toBe("#hours=emg:32");
    // The note lasts until the reader moves on.
    key(document, window, "#hours-min", "ArrowLeft");
    expect(text(document, ".hours-notices")).toBe("");
    expect(q(document, ".hours-notices").getAttribute("hidden")).not.toBeNull();
  });

  test("case does not matter in a link, and a good link shows no notice", async () => {
    const { window, document } = await openPage(recordingsSection(), "#hours=EEG:16:Hours");
    expect(readout(document).claim).toBe("of EEG recorded with 16 or more channels");
    expect(text(document, ".hours-notices")).toBe("");
    expect(window.location.hash).toBe("#hours=EEG:16:Hours");
  });

  test("a failed snapshot offers Try again, which draws one explorer", async () => {
    const { document, errors } = await openPage(recordingsSection(), "", {
      failSnapshotOnce: true,
    });
    expect(text(document, "#channel-hours")).toContain("Could not load recorded hours");
    expect(text(document, "#channel-hours")).toContain("Service unavailable.");
    (document.querySelector("#channel-hours .button") as unknown as { click(): void }).click();
    await until(
      () => document.getElementById("hours-panel") !== null,
      "the explorer after a retry",
    );
    expect(all(document, "#hours-panel")).toHaveLength(1);
    expect(all(document, "#channel-hours [role=tablist]")).toHaveLength(1);
    expect(readout(document).claim).toBe("of EEG recorded with 16 or more channels");
    expect(errors).toEqual([]);
  });

  test("the recordings pipeline card formats hours and links to the explorer", async () => {
    const { document } = await openPage(recordingsSection());
    await until(() => document.getElementById("card-recordings") !== null, "the recordings card");
    const card = text(document, "#card-recordings");
    expect(card).toContain(`Recording types${sample.modalities.length}`);
    expect(card).toContain(`EEG${whole(eeg.hours)} h`);
    expect(card).toContain("From public datasets converted for in-browser viewing");
    expect(q(document, "#card-recordings .card-link").getAttribute("href")).toBe("#recorded-hours");
  });

  test("the title area says what the hours cover", async () => {
    const { document } = await openPage(recordingsSection());
    expect(text(document, "#recorded-hours-scope")).toBe(
      `Counts only the public datasets converted for in-browser viewing so far (${sample.datasets_scanned} of them), not the whole archive. A recording of two types at once is counted under each type, so totals across tabs overlap.`,
    );
  });

  // The words a neuroscientist reads, checked for pipeline jargon. JARGON is the
  // shared pattern from test/helpers/public-copy.ts (vendor names, file names,
  // issue numbers, em dashes). The explorer adds its own storage terms.
  // Readers see "recording type"; "modality" is the payload's word, not theirs.
  const EXPLORER_JARGON = /\bZarr\b|\bindex(?:ed|ing)?\b|\bmodalit(?:y|ies)\b|signal types?/i;

  test("the explorer's words are plain", async () => {
    const { window, document } = await openPage(recordingsSection());
    openTable(document);
    // Show a tooltip too, so its words are on the page.
    const chart = document.querySelector(".hours-chart") as unknown as { focus(): void };
    chart.focus();
    const shown = `${text(document, "#recorded-hours")} ${text(document, "#card-recordings")}`;
    expect(shown).not.toMatch(JARGON);
    expect(shown).not.toMatch(EXPLORER_JARGON);
    // Every string the explorer's script can put on the page, including notices
    // and empty states that this view does not show. The payload checks' reasons
    // go only to the console, for developers, in the payload's own terms, so
    // that block is left out.
    const consoleOnly = /function modalityProblem[\s\S]*?function validChannelHours/;
    expect(CHANNELS_JS).toMatch(consoleOnly);
    const readerCode = CHANNELS_JS.replace(consoleOnly, "") + EXPLORER_JS;
    const literals = [...readerCode.matchAll(/"((?:[^"\\\n]|\\.){12,})"/g)].map((m) => m[1]);
    // Words with spaces; not log lines, and not code caught between two
    // string literals on one line.
    const prose = literals.filter(
      (s) => / /.test(s) && !/^\[ui\]/.test(s) && !/[{}();=]|^ \+ | \+ $/.test(s),
    );
    expect(prose.length).toBeGreaterThan(20);
    expect(prose.filter((s) => JARGON.test(s) || EXPLORER_JARGON.test(s))).toEqual([]);
    // No em dash anywhere on the page, its scripts included.
    expect(window.document.body.textContent ?? "").not.toContain("—");
  });
});
