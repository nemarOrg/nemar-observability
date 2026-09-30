// The collector failure paths for the storage collector, run against the real
// Worker served over local HTTP with a real SQLite-backed D1. Nothing here
// talks to AWS or the production dashboard.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { postSection, runCollector } from "../scripts/lib/s3-cloudwatch";
import {
  STORAGE_COLLECTOR,
  collectStorage,
  latestStorageObservation,
  storageSection,
  storageWindow,
} from "../scripts/push-s3-storage";
import worker from "../src/index";
import { loadPushedSections } from "../src/lib/store";
import type { Bindings } from "../src/types";
import { asD1 } from "./helpers/d1";
import { MIGRATIONS } from "./helpers/migrations";

const capture = await readFile(
  new URL("./fixtures/cloudwatch-s3-storage-2026-09-22-to-2026-09-28.json", import.meta.url),
  "utf8",
);
const captureWindow = storageWindow("2026-09-28");
const payload = storageSection(
  latestStorageObservation(capture, captureWindow.startDate, captureWindow.endDate),
);

const TOKEN = "storage-collector-token";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
// Variables the collector reads; each test sets exactly what it needs.
const COLLECTOR_ENV = [
  STORAGE_COLLECTOR.tokenVariable,
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_REGION",
];

let engine: Database;
let server: ReturnType<typeof Bun.serve>;
let sectionsUrl: string;
let requests: number;
let saved: Record<string, string | undefined>;
/** What the local endpoint does with a request after the real Worker saw it. */
let respond: (workerResponse: Response) => Response;

beforeEach(() => {
  engine = new Database(":memory:");
  for (const migration of MIGRATIONS) engine.run(migration);
  const env = {
    OBS_DB: asD1(engine),
    OBS_INGEST_TOKENS_JSON: JSON.stringify({ storage: TOKEN }),
  } as unknown as Bindings;
  requests = 0;
  respond = (workerResponse) => workerResponse;
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      requests += 1;
      return respond(await worker.fetch(request, env, ctx));
    },
  });
  sectionsUrl = new URL("/observability/api/sections", server.url).href;
  saved = Object.fromEntries(COLLECTOR_ENV.map((name) => [name, process.env[name]]));
  for (const name of COLLECTOR_ENV) delete process.env[name];
});

afterEach(() => {
  server.stop(true);
  engine.close();
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const storedMetrics = async () =>
  (await loadPushedSections(asD1(engine))).flatMap((section) =>
    section.metrics.map(({ key, value, severity }) => ({ key, value, severity })),
  );

describe("storage collector failure reporting", () => {
  test("a collection failure publishes the generic error status", async () => {
    process.env[STORAGE_COLLECTOR.tokenVariable] = TOKEN;
    // No AWS key is set, so the real collector fails before querying AWS.
    const code = await runCollector({
      ...STORAGE_COLLECTOR,
      collect: () => collectStorage(sectionsUrl),
      sectionsUrl,
    });
    expect(code).toBe(1);
    expect(requests).toBe(1);
    expect(await storedMetrics()).toEqual([
      { key: "storage.collector.errors", value: 1, severity: "error" },
    ]);
  });

  test("without an ingest token it fails without any write", async () => {
    const code = await runCollector({
      ...STORAGE_COLLECTOR,
      collect: () => collectStorage(sectionsUrl),
      sectionsUrl,
    });
    expect(code).toBe(1);
    expect(requests).toBe(0);
  });

  test("an ambiguous write is never followed by a second write", async () => {
    process.env[STORAGE_COLLECTOR.tokenVariable] = TOKEN;
    // The Worker commits the section, but the client sees a gateway timeout,
    // as when the connection drops after D1 has written.
    respond = () => new Response("upstream timed out", { status: 504 });
    const code = await runCollector({
      ...STORAGE_COLLECTOR,
      collect: () => postSection(STORAGE_COLLECTOR.sectionKey, TOKEN, payload, sectionsUrl),
      sectionsUrl,
    });
    expect(code).toBe(1);
    expect(requests).toBe(1);
    // The committed success stays; no error status overwrote it.
    expect(await storedMetrics()).toContainEqual({
      key: "storage.bucket_bytes",
      value: 121_650_377_907_484,
      severity: "info",
    });
    expect(await storedMetrics()).toContainEqual({
      key: "storage.collector.errors",
      value: 0,
      severity: "ok",
    });
  });

  test("a rejected error status is reported once and not retried", async () => {
    process.env[STORAGE_COLLECTOR.tokenVariable] = "a-token-the-worker-does-not-know";
    const code = await runCollector({
      ...STORAGE_COLLECTOR,
      collect: () => collectStorage(sectionsUrl),
      sectionsUrl,
    });
    expect(code).toBe(1);
    expect(requests).toBe(1);
    expect(await storedMetrics()).toEqual([]);
  });

  test("a successful run exits zero after one write", async () => {
    const code = await runCollector({
      ...STORAGE_COLLECTOR,
      collect: () => postSection(STORAGE_COLLECTOR.sectionKey, TOKEN, payload, sectionsUrl),
      sectionsUrl,
    });
    expect(code).toBe(0);
    expect(requests).toBe(1);
  });
});
