// The pushed `storage` section end to end: its per-section ingest gate, the
// ingest of the payload the collector builds from a real CloudWatch capture,
// and the snapshot and history endpoints that expose it.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  latestStorageObservation,
  storageFailureStatus,
  storageSection,
  storageWindow,
} from "../scripts/push-s3-storage";
import worker from "../src/index";
import { BUILTIN_SECTION_KEYS, type MetricSnapshot } from "../src/lib/schema";
import { loadDailySeries, loadPushedSections } from "../src/lib/store";
import type { Bindings } from "../src/types";
import { asD1 } from "./helpers/d1";

const MIGRATIONS = await Promise.all(
  ["0001_init.sql", "0003_daily_series.sql", "0004_atomic_section_ingest.sql"].map((name) =>
    Bun.file(new URL(`../src/db/migrations/${name}`, import.meta.url)).text(),
  ),
);
const capture = await readFile(
  new URL("./fixtures/cloudwatch-s3-storage-2026-09-22-to-2026-09-28.json", import.meta.url),
  "utf8",
);
const { startDate, endDate } = storageWindow("2026-09-28");
const payload = storageSection(latestStorageObservation(capture, startDate, endDate));

const STORAGE_TOKEN = "storage-ingest-token";
const EGRESS_TOKEN = "egress-ingest-token";
const TOKENS = JSON.stringify({ storage: STORAGE_TOKEN, egress: EGRESS_TOKEN });
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

let engine: Database;
let db: D1Database;

beforeEach(() => {
  engine = new Database(":memory:");
  for (const migration of MIGRATIONS) engine.run(migration);
  db = asD1(engine);
});
afterEach(() => engine.close());

function env(tokens = TOKENS): Bindings {
  return { OBS_DB: db, OBS_INGEST_TOKENS_JSON: tokens } as unknown as Bindings;
}

function push(path: string, token: string, body: unknown, tokens = TOKENS): Promise<Response> {
  return worker.fetch(
    new Request(`https://x/observability/api/sections/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    env(tokens),
    ctx,
  );
}

async function getJson<T>(path: string): Promise<T> {
  const response = await worker.fetch(
    new Request(`https://x/observability/api${path}`),
    env(),
    ctx,
  );
  expect(response.status).toBe(200);
  return (await response.json()) as T;
}

describe("storage section ingest gate", () => {
  test("storage is a pushed key, not a reserved built-in", () => {
    expect(BUILTIN_SECTION_KEYS.has("storage")).toBe(false);
  });

  test("only the storage token can push storage", async () => {
    expect((await push("storage", EGRESS_TOKEN, payload)).status).toBe(401);
    expect((await push("egress", STORAGE_TOKEN, { ...payload, key: "egress" })).status).toBe(401);
    expect((await push("storage", STORAGE_TOKEN, payload)).status).toBe(200);
  });

  test("a deploy without a storage token entry rejects the push", async () => {
    const response = await push(
      "storage",
      STORAGE_TOKEN,
      payload,
      JSON.stringify({ egress: EGRESS_TOKEN }),
    );
    expect(response.status).toBe(401);
    expect(await loadPushedSections(db)).toEqual([]);
  });
});

describe("storage section ingest and snapshot", () => {
  test("stores the collector payload from a real capture without a daily series", async () => {
    const response = await push("storage", STORAGE_TOKEN, payload);
    expect(await response.json()).toEqual({
      ok: true,
      key: "storage",
      merged_on_next_snapshot: true,
    });

    const [section] = await loadPushedSections(db);
    expect(section).toMatchObject({
      key: "storage",
      label: "S3 storage",
      source: "aws-s3-cloudwatch",
    });
    expect(section.metrics.map((metric) => metric.key)).toEqual([
      "storage.bucket_bytes",
      "storage.object_count",
      "storage.by_class",
      "storage.collector.errors",
    ]);
    expect(await loadDailySeries(db, "2026-09-01", "2026-09-30")).toEqual([]);
  });

  test("the snapshot and history endpoints expose the storage metrics", async () => {
    expect((await push("storage", STORAGE_TOKEN, payload)).status).toBe(200);

    const snapshot = await getJson<MetricSnapshot>("/snapshot");
    const storage = snapshot.sections.find((section) => section.key === "storage");
    const metrics = new Map(storage?.metrics.map((metric) => [metric.key, metric]));
    expect(metrics.get("storage.bucket_bytes")).toMatchObject({
      value: 121_650_377_907_484,
      unit: "bytes",
    });
    expect(metrics.get("storage.object_count")).toMatchObject({
      value: 1_347_607_631,
      unit: "count",
    });
    expect(metrics.get("storage.by_class")).toMatchObject({
      breakdown: [{ label: "StandardStorage", value: 121_650_377_907_484 }],
      breakdown_unit: "bytes",
    });

    const history = await getJson<{ points: { value: number }[] }>(
      "/snapshot/history?metric=storage.bucket_bytes",
    );
    expect(history.points.map((point) => point.value)).toEqual([121_650_377_907_484]);
  });

  test("a failure status replaces the stored amount, so it reads as unknown", async () => {
    expect((await push("storage", STORAGE_TOKEN, payload)).status).toBe(200);
    const failure = storageFailureStatus("CloudWatch query failed (AccessDenied)");
    expect((await push("storage", STORAGE_TOKEN, failure)).status).toBe(200);

    const [section] = await loadPushedSections(db);
    expect(section.metrics).toEqual([
      expect.objectContaining({ key: "storage.collector.errors", value: 1, severity: "error" }),
    ]);
  });
});
