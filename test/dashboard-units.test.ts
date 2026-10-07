// Metric units where the page draws generic metrics: rolling tiles, the
// catalog strip and ranked lists, pipeline coverage blocks, and the share
// beside a total. The snapshot is the captured live one, stored as the latest
// and served by the real Worker; the added metrics take their hours from the
// channel-hours sample.

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import worker from "../src/index";
import type { MetricSnapshot } from "../src/lib/schema";
import { saveSnapshot } from "../src/lib/store";
import { renderDashboardPage } from "../src/routes/ui";
import type { Bindings } from "../src/types";
import sample from "./fixtures/channel-hours.sample.json";
import snapshotFixture from "./fixtures/snapshot-2026-09-28.json";
import { asD1 } from "./helpers/d1";
import { MIGRATIONS } from "./helpers/migrations";

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const ORIGIN = "https://dashboard.nemar.org";
const open: { window: Window; engine: Database }[] = [];
afterEach(async () => {
  for (const page of open.splice(0)) {
    await page.window.happyDOM.close();
    page.engine.close();
  }
});

const eeg = sample.modalities.find((m) => m.modality === "EEG");
if (!eeg) throw new Error("fixture has no EEG");
// About half of the EEG hours: 2,462.2 of 4,645.6, which reads "53%".
const half = 2462.2;
const longest = [...eeg.bins].sort((a, b) => b.hours - a.hours).slice(0, 12);

function snapshotWithHours(): MetricSnapshot {
  const snap = structuredClone(snapshotFixture.response) as MetricSnapshot;
  snap.generated_at = new Date().toISOString();
  const section = (key: string) => {
    const s = snap.sections.find((x) => x.key === key);
    if (!s) throw new Error(`fixture snapshot has no ${key}`);
    return s;
  };
  const hours = { unit: "hours", severity: "info" as const };
  // A rolling tile (the cf section draws as tiles under Usage).
  section("cf").metrics.push({
    key: "cf.recorded",
    label: "Recorded time",
    value: half,
    total: eeg?.hours,
    ...hours,
  });
  // The catalog strip, and a ranked list longer than ten rows.
  section("datasets").metrics.push({
    key: "datasets.recorded",
    label: "Recorded time",
    value: half,
    total: eeg?.hours,
    ...hours,
  });
  section("sizes").metrics.push({
    key: "sizes.longest",
    label: "Longest channel counts",
    value: longest.length,
    unit: "count",
    severity: "info",
    breakdown_unit: "hours",
    breakdown_style: "ranked",
    breakdown: longest.map((b) => ({ label: `${b.channels} channels`, value: b.hours })),
  });
  // A pipeline card: its coverage block, a share beside a total, a sliver,
  // and a unit the page does not know.
  snap.sections.push({
    key: "conversion_time",
    label: "Conversion time",
    source: "test-pipeline",
    updated_at: snap.generated_at,
    metrics: [
      {
        key: "conversion_time.done",
        label: "Hours converted",
        value: eeg?.hours ?? 0,
        total: 5000.25,
        unit: "hours",
        severity: "ok",
      },
      {
        key: "conversion_time.half",
        label: "Hours checked",
        value: half,
        total: eeg?.hours,
        ...hours,
      },
      {
        key: "conversion_time.sliver",
        label: "Hours failed",
        value: 1,
        total: eeg?.hours,
        ...hours,
      },
      {
        key: "conversion_time.wait",
        label: "Median wait",
        value: 12,
        unit: "minutes",
        severity: "info",
      },
    ],
  });
  return snap;
}

async function openPage(snap: MetricSnapshot) {
  const engine = new Database(":memory:");
  for (const migration of MIGRATIONS) engine.run(migration);
  const db = asD1(engine);
  await saveSnapshot(db, snap);
  const env = { OBS_DB: db } as unknown as Bindings;
  const window = new Window({
    url: `${ORIGIN}/observability`,
    settings: { enableJavaScriptEvaluation: true } as never,
  });
  open.push({ window, engine });
  (window as unknown as { fetch: unknown }).fetch = async (input: unknown) => {
    const response = await worker.fetch(new Request(new URL(String(input), ORIGIN).href), env, ctx);
    return new window.Response(await response.text(), {
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
    });
  };
  window.document.write(renderDashboardPage());
  const document = window.document;
  const start = Date.now();
  while (!document.getElementById("card-conversion_time")) {
    if (Date.now() - start > 4000) throw new Error("timed out waiting for the snapshot");
    await Bun.sleep(20);
  }
  return document;
}
const text = (doc: Window["document"], selector: string) =>
  doc.querySelector(selector)?.textContent ?? "";

describe("metrics in hours across the page", () => {
  test("a rolling tile shows its value and total in hours", async () => {
    const doc = await openPage(snapshotWithHours());
    const tile = Array.from(doc.querySelectorAll("#usage-snapshot .tile")).find((t) =>
      (t.textContent ?? "").includes("Recorded time"),
    );
    expect(tile?.querySelector(".tile-value .v")?.textContent).toBe("2,462 h");
    expect(tile?.querySelector(".tile-pct")?.textContent).toBe("53% of 4,646 h");
  });

  test("the catalog strip and a ranked list carry the unit on every value", async () => {
    const doc = await openPage(snapshotWithHours());
    const strip = Array.from(doc.querySelectorAll("#catalog .stat-item")).find((t) =>
      (t.textContent ?? "").includes("Recorded time"),
    );
    expect(strip?.querySelector("dd")?.textContent).toBe("2,462 h53% of 4,646 h");
    const card = doc.getElementById("card-sizes-longest");
    const values = Array.from(card?.querySelectorAll(".ranked-value") ?? []).map(
      (v) => v.firstChild?.textContent ?? "",
    );
    expect(values).toHaveLength(longest.length);
    expect(values[0]).toBe("1,156 h");
    expect(values.every((v) => / h$/.test(v))).toBe(true);
  });

  test("a pipeline card's coverage, shares, slivers, and unknown units read with their units", async () => {
    const doc = await openPage(snapshotWithHours());
    const card = text(doc, "#card-conversion_time");
    expect(text(doc, "#card-conversion_time .coverage-value")).toBe("4,646 h of 5,000 h");
    expect(card).toContain("53% of 4,646 h");
    // One hour of 4,646 is not 0%.
    expect(card).toContain("<0.1% of 4,646 h");
    expect(card).not.toContain("0% of 4,646 h1");
    expect(card).toContain("12 minutes");
  });
});
