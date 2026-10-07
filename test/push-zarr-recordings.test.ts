// The recordings collector end to end: a local catalog and S3-like index server
// serving real indexes, the real collector code, and the real Worker (with a
// SQLite-backed D1) receiving the push. Nothing here talks to the network
// outside localhost.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { postSection, runCollector } from "../scripts/lib/s3-cloudwatch";
import {
  RECORDINGS_COLLECTOR,
  buildRecordings,
  collectRecordings,
  formatReport,
  parseArguments,
  resolveStateDir,
  runDryRun,
} from "../scripts/push-zarr-recordings";
import worker from "../src/index";
import { SectionIngestSchema } from "../src/lib/schema";
import type { MetricSnapshot } from "../src/lib/schema";
import { loadPushedSections } from "../src/lib/store";
import type { Bindings } from "../src/types";
import { asD1 } from "./helpers/d1";
import { MIGRATIONS } from "./helpers/migrations";
import {
  FIXTURES,
  type IndexServer,
  allFixtureObjects,
  datasetIdOf,
  startCatalogServer,
  startIndexServer,
} from "./helpers/zarr-fixtures";

const expected = JSON.parse(
  await readFile(new URL("./fixtures/zarr-recordings-expected.json", import.meta.url), "utf8"),
) as { dedup_hours: number; measured: number; unconverted: number };

const TOKEN = "recordings-collector-token";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const COLLECTOR_ENV = [RECORDINGS_COLLECTOR.tokenVariable];

// Public catalog: the seven fixture datasets, one that is not converted and has
// no index (not scanned, not a fault), and one private dataset that must never
// be counted or fetched.
const FIXTURE_IDS = FIXTURES.map(datasetIdOf);
const catalogRows = () => [
  ...FIXTURE_IDS.map((dataset_id) => ({ dataset_id })),
  { dataset_id: "on000001", zarr_status: "failed" },
  { dataset_id: "nm000777", visibility: "private" },
];

let dir: string;
let stateDir: string;
let catalog: ReturnType<typeof startCatalogServer>;
let index: IndexServer;
let saved: Record<string, string | undefined>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "recordings-collector-"));
  stateDir = join(dir, "state");
  catalog = startCatalogServer(catalogRows());
  index = startIndexServer(allFixtureObjects());
  saved = Object.fromEntries(COLLECTOR_ENV.map((name) => [name, process.env[name]]));
  for (const name of COLLECTOR_ENV) delete process.env[name];
});

afterEach(async () => {
  catalog.stop();
  index.stop();
  await rm(dir, { recursive: true, force: true });
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const options = () => ({
  apiBase: catalog.url,
  indexBase: index.url,
  stateDir,
  retryDelayMs: 0,
  log: () => undefined,
});

describe("buildRecordings", () => {
  test("reads the public catalog and every index, and builds a valid section", async () => {
    const result = await buildRecordings(options());
    expect(SectionIngestSchema.safeParse(result.payload).success).toBe(true);
    // 7 fixture datasets + 1 unconverted public dataset; the private one is not counted.
    expect(result.aggregate).toMatchObject({
      publicDatasets: 8,
      scanned: 7,
      withoutIndex: 1,
      unavailable: 0,
      measuredRecordings: expected.measured,
    });
    const metric = (key: string) => result.payload.metrics.find((m) => m.key === key);
    expect(metric("recordings.hours")?.value).toBe(expected.dedup_hours);
    expect(metric("recordings.datasets")).toMatchObject({ value: 6, total: 8 });
    expect(metric("recordings.recordings")).toMatchObject({
      value: expected.measured,
      total: expected.measured + expected.unconverted,
    });
    expect(result.payload.channel_hours?.modalities.map((m) => m.modality)).toEqual([
      "EMG",
      "EEG",
      "ECG",
      "MEG",
      "iEEG",
    ]);
    // The private dataset was never requested from the index server.
    expect(index.requests.some((request) => request.id === "nm000777")).toBe(false);
    expect(catalog.seen.every((request) => request.authorization === null)).toBe(true);
  });

  test("a second run downloads nothing and gives the identical payload", async () => {
    const first = await buildRecordings(options());
    expect((await readdir(join(stateDir, "summaries"))).length).toBe(7);
    index.requests.length = 0;
    const second = await buildRecordings(options());
    expect(second.payload).toEqual(first.payload);
    expect(second.aggregate.fromCache).toBe(7);
    expect(second.aggregate.fromNetwork).toBe(0);
    const bodies = index.requests.filter((request) => request.status === 200);
    expect(bodies).toEqual([]);
    expect(index.requests.filter((request) => request.status === 304)).toHaveLength(7);
  });

  test("a dataset that cannot be read is counted unavailable and its old summary is not reused", async () => {
    await buildRecordings(options());
    index.state.failures.set("on004457", [500, 500, 500]);
    // One of eight is above the default 10% limit, so this run raises it.
    const result = await buildRecordings({ ...options(), maxUnavailableFraction: 0.5 });
    expect(result.aggregate.unavailable).toBe(1);
    expect(result.aggregate.scanned).toBe(6);
    expect(result.payload.channel_hours).toMatchObject({
      datasets_scanned: 6,
      datasets_unavailable: 1,
    });
    // iEEG came only from on004457, so it is absent rather than carried over.
    expect(result.payload.channel_hours?.modalities.map((m) => m.modality)).not.toContain("iEEG");
    expect(result.payload.metrics.find((m) => m.key === "recordings.recordings")?.total).toBe(
      undefined,
    );
  });

  test("a catalog dataset marked ready with no index is unavailable, not skipped", async () => {
    catalog.stop();
    catalog = startCatalogServer([...catalogRows(), { dataset_id: "on000002" }]);
    const result = await buildRecordings({ ...options(), maxUnavailableFraction: 0.5 });
    expect(result.aggregate.unavailable).toBe(1);
    expect(result.aggregate.withoutIndex).toBe(1);
  });

  test("fails rather than publish when more than a tenth of the indexes are unreadable", async () => {
    for (const id of FIXTURE_IDS.slice(0, 5)) index.state.failures.set(id, [500, 500, 500]);
    await expect(buildRecordings(options())).rejects.toThrow("could not be read");
    index.state.failures.clear();
    index.state.failures.set("on004457", [500, 500, 500]);
    await expect(buildRecordings(options())).rejects.toThrow(
      "1 of 7 Zarr indexes could not be read",
    );
  });

  test("the report shows the headline, the modality total, and who dominates each modality", async () => {
    const lines = formatReport(await buildRecordings(options())).join("\n");
    expect(lines).toContain("hours, each recording once (headline): 206.8");
    expect(lines).toContain("hours, sum of the modality totals: 248.5");
    expect(lines).toContain("EMG: 133.9 h");
    expect(lines).toMatch(/on005873: 69\.4 h \(97\.0%\)/);
  });
});

describe("pushing to the Worker", () => {
  let engine: Database;
  let server: ReturnType<typeof Bun.serve>;
  let sectionsUrl: string;
  let ingestRequests: number;
  let respond: (workerResponse: Response) => Response;

  beforeEach(() => {
    engine = new Database(":memory:");
    for (const migration of MIGRATIONS) engine.run(migration);
    const env = {
      OBS_DB: asD1(engine),
      OBS_INGEST_TOKENS_JSON: JSON.stringify({ recordings: TOKEN }),
    } as unknown as Bindings;
    ingestRequests = 0;
    respond = (workerResponse) => workerResponse;
    server = Bun.serve({
      port: 0,
      async fetch(request) {
        ingestRequests += 1;
        return respond(await worker.fetch(request, env, ctx));
      },
    });
    sectionsUrl = new URL("/observability/api/sections", server.url).href;
  });

  afterEach(() => {
    server.stop(true);
    engine.close();
  });

  const run = () =>
    runCollector({
      ...RECORDINGS_COLLECTOR,
      collect: () => collectRecordings({ ...options(), sectionsUrl }),
      sectionsUrl,
    });
  const stored = async () =>
    (await loadPushedSections(asD1(engine))).find((s) => s.key === "recordings");

  test("a successful run writes once, and the dashboard snapshot carries channel_hours", async () => {
    process.env[RECORDINGS_COLLECTOR.tokenVariable] = TOKEN;
    expect(await run()).toBe(0);
    expect(ingestRequests).toBe(1);

    const section = await stored();
    expect(section).toMatchObject({
      key: "recordings",
      label: "Recorded data",
      source: "nemar-zarr-index",
    });
    expect(section?.channel_hours?.datasets_scanned).toBe(7);
    expect(section?.channel_hours?.modalities.map((m) => m.modality)).toEqual([
      "EMG",
      "EEG",
      "ECG",
      "MEG",
      "iEEG",
    ]);

    const response = await worker.fetch(
      new Request("https://x/observability/api/snapshot"),
      {
        OBS_DB: asD1(engine),
        OBS_INGEST_TOKENS_JSON: JSON.stringify({ recordings: TOKEN }),
      } as unknown as Bindings,
      ctx,
    );
    expect(response.status).toBe(200);
    const snapshot = (await response.json()) as MetricSnapshot;
    const served = snapshot.sections.find((s) => s.key === "recordings");
    expect(served?.channel_hours).toEqual(section?.channel_hours);
    expect(served?.metrics.find((m) => m.key === "recordings.hours")).toMatchObject({
      value: expected.dedup_hours,
      unit: "hours",
    });
  });

  test("a collection failure replaces the section with the generic error status", async () => {
    process.env[RECORDINGS_COLLECTOR.tokenVariable] = TOKEN;
    expect(await run()).toBe(0);
    catalog.state.failWith = 500;
    expect(await run()).toBe(1);
    expect(ingestRequests).toBe(2);
    const section = await stored();
    expect(section?.metrics.map((m) => [m.key, m.value, m.severity])).toEqual([
      ["recordings.collector.errors", 1, "error"],
    ]);
    expect(section?.channel_hours).toBeUndefined();
  });

  test("without an ingest token it fails without any write", async () => {
    expect(await run()).toBe(1);
    expect(ingestRequests).toBe(0);
    // and without reading anything
    expect(index.requests).toEqual([]);
    expect(catalog.seen).toEqual([]);
  });

  test("an ambiguous write is never followed by a second write", async () => {
    process.env[RECORDINGS_COLLECTOR.tokenVariable] = TOKEN;
    respond = () => new Response("upstream timed out", { status: 504 });
    expect(await run()).toBe(1);
    expect(ingestRequests).toBe(1);
    // The Worker committed the success; no error status overwrote it.
    expect(
      (await stored())?.metrics.find((m) => m.key === "recordings.collector.errors"),
    ).toMatchObject({
      value: 0,
      severity: "ok",
    });
  });

  test("a token the Worker does not know is reported once and not retried", async () => {
    process.env[RECORDINGS_COLLECTOR.tokenVariable] = "not-the-recordings-token";
    expect(await run()).toBe(1);
    expect(ingestRequests).toBe(1);
    expect(await stored()).toBeUndefined();
  });

  test("the section key is writable only with its own token", async () => {
    const { payload } = await buildRecordings(options());
    await expect(postSection("recordings", "wrong", payload, sectionsUrl)).rejects.toThrow("401");
    await postSection("recordings", TOKEN, payload, sectionsUrl);
    expect((await stored())?.channel_hours).toEqual(payload.channel_hours);
  });
});

describe("dry run", () => {
  test("needs no token, writes the payload, and posts nothing", async () => {
    const out = join(dir, "payload.json");
    const code = await runDryRun({ ...options(), dryRun: true, out });
    expect(code).toBe(0);
    const written = JSON.parse(await readFile(out, "utf8"));
    expect(SectionIngestSchema.safeParse(written).success).toBe(true);
    expect(written.metrics[0].value).toBe(expected.dedup_hours);
  });

  test("a failed dry run exits non-zero and writes nothing", async () => {
    catalog.state.failWith = 500;
    const out = join(dir, "payload.json");
    expect(await runDryRun({ ...options(), dryRun: true, out })).toBe(1);
    expect(await readdir(dir)).not.toContain("payload.json");
  });

  test("the real command line works end to end as a separate process", async () => {
    const out = join(dir, "cli-payload.json");
    const script = new URL("../scripts/push-zarr-recordings.ts", import.meta.url).pathname;
    const child = Bun.spawn(
      [
        process.execPath,
        script,
        "--dry-run",
        `--out=${out}`,
        "--state-dir",
        stateDir,
        "--api-base",
        catalog.url,
        "--index-base",
        index.url,
        "--concurrency",
        "2",
      ],
      { env: { PATH: process.env.PATH ?? "", HOME: dir }, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(code).toBe(0);
    expect(stdout).toContain("hours, each recording once (headline): 206.8");
    const written = JSON.parse(await readFile(out, "utf8"));
    expect(written.channel_hours.datasets_scanned).toBe(7);
    // A second process reuses the cache the first one wrote.
    index.requests.length = 0;
    const again = Bun.spawn(
      [
        process.execPath,
        script,
        "--dry-run",
        "--state-dir",
        stateDir,
        "--api-base",
        catalog.url,
        "--index-base",
        index.url,
      ],
      { env: { PATH: process.env.PATH ?? "", HOME: dir }, stdout: "pipe", stderr: "pipe" },
    );
    expect(await again.exited).toBe(0);
    // Seven revalidations and the unconverted dataset's missing index; no body.
    expect(index.requests.filter((request) => request.status === 304)).toHaveLength(7);
    expect(index.requests.filter((request) => request.status === 200)).toEqual([]);
  });

  test("a bad command line exits 2 and says what is wrong", async () => {
    const script = new URL("../scripts/push-zarr-recordings.ts", import.meta.url).pathname;
    const child = Bun.spawn([process.execPath, script, "--nonsense"], {
      env: { PATH: process.env.PATH ?? "", HOME: dir },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(2);
    expect(stderr).toContain("unknown argument --nonsense");
  });
});

describe("arguments and state directory", () => {
  test("parses flags in both spellings", () => {
    expect(
      parseArguments([
        "--dry-run",
        "--out",
        "/tmp/p.json",
        "--concurrency=4",
        "--state-dir=/tmp/s",
      ]),
    ).toEqual({ dryRun: true, out: "/tmp/p.json", concurrency: 4, stateDir: "/tmp/s" });
    expect(parseArguments([])).toEqual({ dryRun: false });
    expect(
      parseArguments(["--api-base", "http://a", "--index-base=http://b", "--dry-run"]),
    ).toEqual({
      dryRun: true,
      apiBase: "http://a",
      indexBase: "http://b",
    });
  });

  test("rejects unknown flags, missing values, bad numbers, and --out without --dry-run", () => {
    expect(() => parseArguments(["--wat"])).toThrow("unknown argument");
    expect(() => parseArguments(["--out"])).toThrow("--out needs a value");
    expect(() => parseArguments(["--out", "--dry-run"])).toThrow("--out needs a value");
    expect(() => parseArguments(["--dry-run", "--concurrency", "0"])).toThrow("1 to 32");
    expect(() => parseArguments(["--concurrency", "x", "--dry-run"])).toThrow("1 to 32");
    expect(() => parseArguments(["--out", "/tmp/x.json"])).toThrow("only for --dry-run");
  });

  test("the cache directory comes from the flag, then the environment, systemd, and HOME", () => {
    expect(
      resolveStateDir("/flag", {
        RECORDINGS_STATE_DIR: "/env",
        STATE_DIRECTORY: "/sd",
        HOME: "/h",
      }),
    ).toBe("/flag");
    expect(
      resolveStateDir(undefined, {
        RECORDINGS_STATE_DIR: "/env",
        STATE_DIRECTORY: "/sd",
        HOME: "/h",
      }),
    ).toBe("/env");
    expect(
      resolveStateDir(undefined, { STATE_DIRECTORY: "/var/lib/a:/var/lib/b", HOME: "/h" }),
    ).toBe("/var/lib/a");
    expect(resolveStateDir(undefined, { HOME: "/home/yahya" })).toBe(
      "/home/yahya/.cache/nemar-observability/recordings",
    );
    expect(resolveStateDir(undefined, {})).toBeNull();
  });
});
