import { describe, expect, test } from "bun:test";
import { buildSnapshot } from "../src/lib/metrics";
import type { Bindings } from "../src/types";
import history from "./fixtures/history-datasets-public-2026-09-28.json";
import snapshot from "./fixtures/snapshot-2026-09-28.json";
import timeseries from "./fixtures/timeseries-2026-07-01-to-2026-09-28.json";
import { clientLogic } from "./helpers/client-logic";

const { allTimeSpecs, seriesArchiveWindow, validSnapshot, validTimeseries, validHistory } =
  clientLogic([
    "allTimeSpecs",
    "seriesArchiveWindow",
    "validSnapshot",
    "validTimeseries",
    "validHistory",
  ]);

// Real answers from the public API (see each fixture's source line).
const live = snapshot.response;
const archive = timeseries.response;
const archiveWindow = seriesArchiveWindow("2026-09-28");
type Spec = { label: string; value?: string; note?: string; loading?: boolean; muted?: boolean };
const byLabel = (specs: Spec[]) => Object.fromEntries(specs.map((s) => [s.label, s]));

describe("all-time strip", () => {
  test("the captured answers are well formed", () => {
    expect(validSnapshot(live)).toBe(true);
    expect(validTimeseries(archive)).toBe(true);
    expect(validHistory(history.response)).toBe(true);
  });

  test("figures come from the snapshot and the reported days, labeled with their start", () => {
    const specs = byLabel(
      allTimeSpecs({
        snapshot: live,
        history: { "datasets.public": history.response.points },
        historyFailed: {},
        archive,
        archiveWindow,
      }),
    );
    const pub = live.sections.flatMap((s) => s.metrics).find((m) => m.key === "datasets.public");
    expect(specs["Public datasets"].value).toBe(pub?.value.toLocaleString("en-US"));
    expect(specs["Data served"].note).toStartWith(
      "Since Aug 1, 2026, 57 days reported, through Sep 26, 2026",
    );
    expect(specs["Data served"].note).not.toContain("window limited");
    expect(specs["Usage records begin"].value).toBe("Aug 1, 2026");
  });

  test("with no request series, requests are not recorded, never zero", () => {
    const specs = byLabel(allTimeSpecs({ snapshot: live, archive, archiveWindow }));
    expect(specs.Requests).toMatchObject({ value: "Not recorded", muted: true });
    const noSeries = byLabel(
      allTimeSpecs({ snapshot: live, archive: { ...archive, series: [] }, archiveWindow }),
    );
    for (const label of ["Data served", "Requests", "Usage records begin"]) {
      expect(noSeries[label].value).toBe("Not recorded");
    }
    for (const spec of Object.values(noSeries)) expect(spec.value).not.toMatch(/^0( |$)/);
  });

  test("a window that cuts off earlier days says it is window limited", () => {
    const specs = byLabel(
      allTimeSpecs({
        snapshot: live,
        archive,
        archiveWindow: { start: "2026-09-01", end: "2026-09-28" },
      }),
    );
    expect(specs["Data served"].note).toContain("Since Sep 1, 2026");
    expect(specs["Data served"].note).toContain("window limited to the last 3,660 days");
  });

  test("a partial snapshot from the real builder shows Unavailable and does not throw", async () => {
    // With no database bound, the real snapshot builder records section errors
    // for every database-backed section: the partial snapshot a fresh deploy
    // or an outage produces.
    const partial = await buildSnapshot({} as Bindings);
    expect(partial.section_errors?.length).toBeGreaterThan(0);
    expect(validSnapshot(partial)).toBe(true);
    const specs = byLabel(allTimeSpecs({ snapshot: partial, archive, archiveWindow }));
    expect(specs["Public datasets"]).toMatchObject({
      value: "Unavailable",
      note: "Not in the latest snapshot.",
    });
    expect(specs["Data volume"]).toMatchObject({ value: "Unavailable" });
  });

  test("loading, failed, and history-failed states each say so", () => {
    const loading = allTimeSpecs({});
    expect(loading.every((s: Spec) => s.loading)).toBe(true);
    const failed = byLabel(allTimeSpecs({ snapshotFailed: true, archiveFailed: true }));
    expect(failed["Public datasets"].note).toBe("The latest snapshot did not load.");
    expect(failed["Data served"]).toMatchObject({
      value: "Unavailable",
      note: "Daily usage did not load.",
    });
    const noHistory = byLabel(
      allTimeSpecs({
        snapshot: live,
        historyFailed: { "datasets.public": true },
        archive,
        archiveWindow,
      }),
    );
    expect(noHistory["Public datasets"].note).toContain("recent change could not load");
  });
});

describe("response checks", () => {
  test("malformed answers are rejected where they arrive", () => {
    expect(validSnapshot({ sections: "nope" })).toBe(false);
    expect(validSnapshot({ sections: [{ key: "x" }] })).toBe(false);
    expect(validSnapshot({ sections: [], section_errors: "x" })).toBe(false);
    expect(validTimeseries({ series: [{ section: "egress", unit: "bytes" }] })).toBe(false);
    expect(validHistory({ points: null })).toBe(false);
    expect(validSnapshot(null)).toBe(false);
  });
});

describe("all-time strip wording", () => {
  test("labels stay fixed; each note says which period its figure covers", () => {
    const specs: Spec[] = allTimeSpecs({ snapshot: live, archive, archiveWindow });
    expect(specs.map((s) => s.label)).toEqual([
      "Public datasets",
      "Data volume",
      "Data served",
      "Requests",
      "Usage records begin",
    ]);
    for (const spec of specs) expect(spec.label).not.toMatch(/\d/);
    const notes = byLabel(specs);
    expect(notes["Public datasets"].note).toStartWith("Now");
    expect(notes["Data volume"].note).toStartWith("Now");
    expect(notes["Data served"].note).toStartWith("Since Aug 1, 2026");
  });
});
