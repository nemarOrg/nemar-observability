// Opens the real dashboard page with the recorded-hours explorer: the page's
// own script in a real DOM (happy-dom), the real Worker and snapshot API in
// process, and a real SQLite store holding a pushed "recordings" section built
// around the real channel-hours fixture. Shared by the explorer's page tests.

import { Database } from "bun:sqlite";
import { expect } from "bun:test";
import { Window } from "happy-dom";
import worker from "../../src/index";
import type { Section } from "../../src/lib/schema";
import { savePushedSection } from "../../src/lib/store";
import { renderDashboardPage } from "../../src/routes/ui";
import type { Bindings } from "../../src/types";
import sample from "../fixtures/channel-hours.sample.json";
import { asD1 } from "./d1";
import { MIGRATIONS } from "./migrations";

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
export const ORIGIN = "https://dashboard.nemar.org";
export type Doc = Window["document"];
export type Payload = typeof sample;

const open: { window: Window; engine: Database }[] = [];
/** Call from afterEach: closes every page opened since the last call. */
export async function closePages() {
  for (const page of open.splice(0)) {
    await page.window.happyDOM.close();
    page.engine.close();
  }
}

// The section the Zarr indexer pushes: metrics derived from the same fixture,
// and the fixture itself as the channel_hours payload. Hours are listed per
// recording type only: a recording with two types counts under each, so the
// sum over types is not a total and no metric here presents it as one.
export function recordingsSection(
  withHours = true,
  options: { updatedAt?: string; payload?: Payload } = {},
): Section {
  const payload = options.payload ?? sample;
  return {
    key: "recordings",
    label: "Recorded hours",
    source: "nemar-zarr-index",
    updated_at: options.updatedAt ?? new Date().toISOString(),
    metrics: [
      {
        key: "recordings.types",
        label: "Recording types",
        value: payload.modalities.length,
        unit: "count",
        severity: "info",
        breakdown_unit: "hours",
        breakdown: payload.modalities.map((m) => ({ label: m.modality, value: m.hours })),
      },
      {
        key: "recordings.datasets",
        label: "Datasets read",
        value: payload.datasets_scanned,
        unit: "datasets",
        severity: "info",
      },
    ],
    ...(withHours ? { channel_hours: payload } : {}),
  };
}

export interface OpenOptions {
  /** Answer the first /snapshot request with a 503, for the error state and Try again. */
  failSnapshotOnce?: boolean;
  /**
   * Answer /snapshot with this body instead of the Worker's, for a payload the
   * store would refuse to keep (it drops sections that fail the schema).
   */
  snapshotBody?: unknown;
  /**
   * Start the page without ResizeObserver, as an older browser would, so its
   * charts follow window resize events instead (a path a test can trigger).
   */
  withoutResizeObserver?: boolean;
}

export async function openPage(section: Section | null, hash = "", options: OpenOptions = {}) {
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
  // What the page logs with console.error, so a test can check that a failure
  // was reported and not only shown.
  const logged: string[] = [];
  (window as unknown as { console: { error: (...args: unknown[]) => void } }).console.error = (
    ...args: unknown[]
  ) => logged.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(" "));
  let failures = options.failSnapshotOnce ? 1 : 0;
  (window as unknown as { fetch: unknown }).fetch = async (input: unknown) => {
    const url = new URL(String(input), ORIGIN);
    const isSnapshot = url.pathname.endsWith("/snapshot");
    let response: Response;
    if (isSnapshot && failures-- > 0) {
      response = new Response(JSON.stringify({ error: "Service unavailable" }), { status: 503 });
    } else if (isSnapshot && options.snapshotBody !== undefined) {
      response = new Response(JSON.stringify(options.snapshotBody), { status: 200 });
    } else {
      response = await worker.fetch(new Request(url.href), env, ctx);
    }
    return new window.Response(await response.text(), {
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
    });
  };
  if (options.withoutResizeObserver) {
    // biome-ignore lint/performance/noDelete: the page tests "ResizeObserver" in window, so the name must be gone, not undefined.
    delete (window as unknown as Record<string, unknown>).ResizeObserver;
  }
  window.document.write(renderDashboardPage());
  const document = window.document;
  await until(
    () => document.getElementById("channel-hours")?.getAttribute("aria-busy") !== "true",
    "the explorer to settle",
  );
  return { window, document, errors, logged };
}

export async function until(check: () => boolean, what: string, ms = 4000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}

type Node = { textContent: string | null; getAttribute(name: string): string | null };
export const q = (doc: Doc, selector: string) =>
  doc.querySelector(selector) as unknown as Node & { focus(): void; click(): void; id: string };
export const all = (doc: Doc, selector: string) =>
  Array.from(doc.querySelectorAll(selector)) as unknown as (Node & { id: string })[];
export const text = (doc: Doc, selector: string) => q(doc, selector)?.textContent ?? "";
export const readout = (doc: Doc) => ({
  value: text(doc, ".hours-value"),
  claim: text(doc, ".hours-claim"),
  share: text(doc, ".hours-share"),
  facts: all(doc, ".hours-fact").map((f) => f.textContent),
  slider: q(doc, "#hours-min").getAttribute("aria-valuetext"),
});
export function key(doc: Doc, window: Window, selector: string, name: string) {
  const target = doc.querySelector(selector) as unknown as { dispatchEvent(e: unknown): void };
  target.dispatchEvent(
    new window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }),
  );
}
// Opens Show exact values the way a reader does, by clicking its summary.
export function openTable(doc: Doc) {
  (doc.querySelector(".hours-foot summary") as unknown as { click(): void }).click();
}
export const sum = (list: number[]) => list.reduce((s, v) => s + v, 0);
export const eeg = sample.modalities[0];
export const at = (m: Payload["modalities"][number], min: number) => ({
  hours: sum(m.bins.filter((b) => b.channels >= min).map((b) => b.hours)),
  recordings: sum(m.bins.filter((b) => b.channels >= min).map((b) => b.recordings)),
  datasets: sum(m.dataset_peaks.filter((p) => p.channels >= min).map((p) => p.datasets)),
});
export const whole = (n: number) => Math.round(n).toLocaleString("en-US");
export const oneDecimal = (part: number, total: number) =>
  `${(Math.round((part / total) * 1000) / 10).toLocaleString("en-US")}%`;
type Range = {
  value: string;
  style: { width: string; getPropertyValue(name: string): string };
  dispatchEvent(e: unknown): void;
};
export const range = (doc: Doc) => doc.getElementById("hours-min") as unknown as Range;
// Where the thumb sits on the doubling axis from 1 to 512 channels, as a
// fraction of its travel: the slider's own value, and the colored track's cut.
function thumb(doc: Doc) {
  const r = range(doc);
  const width = Number.parseFloat(r.style.width);
  return {
    value: Number(r.value),
    cut: (Number.parseFloat(r.style.getPropertyValue("--cut")) - 12) / (width - 24),
  };
}
export function expectThumbAt(doc: Doc, min: number) {
  const t = thumb(doc);
  expect(t.value).toBe(Math.round(1000 * Math.log2(min)));
  expect(t.cut).toBeCloseTo(Math.log2(min) / 9, 6);
}
