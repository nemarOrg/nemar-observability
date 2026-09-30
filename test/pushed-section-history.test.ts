import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { MetricSnapshot, Section } from "../src/lib/schema";
import {
  loadMetricHistory,
  loadPushedSections,
  savePushedSection,
  saveSnapshot,
} from "../src/lib/store";
import { asD1 } from "./helpers/d1";
import { MIGRATIONS } from "./helpers/migrations";

let engine: Database;
let db: D1Database;

beforeEach(() => {
  engine = new Database(":memory:");
  for (const migration of MIGRATIONS) engine.run(migration);
  db = asD1(engine);
});
afterEach(() => engine.close());

function section(value: number, updatedAt: string): Section {
  return {
    key: "website",
    label: "Website usage",
    source: "umami",
    updated_at: updatedAt,
    metrics: [
      { key: "website.pageviews", label: "Pageviews", value, unit: "count", severity: "info" },
    ],
  };
}

function snapshot(sections: Section[], generatedAt: string): MetricSnapshot {
  return { schema_version: "1.0", generated_at: generatedAt, sections };
}

describe("pushed section history", () => {
  test("snapshot history returns pushed metrics across successive captures", async () => {
    const first = section(12, "2026-09-26T10:00:00.000Z");
    await savePushedSection(db, first);
    await saveSnapshot(db, snapshot(await loadPushedSections(db), "2026-09-26T10:00:00.000Z"));

    const second = section(19, "2026-09-26T11:00:00.000Z");
    await savePushedSection(db, second);
    await saveSnapshot(db, snapshot(await loadPushedSections(db), "2026-09-26T11:00:00.000Z"));

    const points = await loadMetricHistory(db, "website.pageviews");
    expect(points.map(({ at, value }) => ({ at, value }))).toEqual([
      { at: "2026-09-26T10:00:00.000Z", value: 12 },
      { at: "2026-09-26T11:00:00.000Z", value: 19 },
    ]);
  });
});
