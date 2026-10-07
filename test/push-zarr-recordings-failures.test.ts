// How a recordings run behaves when the push or the data goes wrong: what the
// dashboard answers, what is retried, what is reported, and above all that a
// good section is never replaced by a failure status after it was stored. The
// Worker is the real Worker over local HTTP with a SQLite-backed D1; where a
// test needs a status the real Worker will not produce on demand (a gateway 502,
// a 413 for a body the collector refuses to send) the server answers with that
// HTTP response in its place.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IngestError,
  IngestRejectedError,
  postSection,
  runCollector,
} from "../scripts/lib/s3-cloudwatch";
import { MAX_PAYLOAD_BYTES } from "../scripts/lib/zarr-aggregate";
import { SummaryCache } from "../scripts/lib/zarr-index-source";
import { summarizeIndex } from "../scripts/lib/zarr-recordings";
import {
  RECORDINGS_COLLECTOR,
  buildRecordings,
  collectRecordings,
} from "../scripts/push-zarr-recordings";
import worker from "../src/index";
import { loadPushedSections } from "../src/lib/store";
import type { Bindings } from "../src/types";
import { asD1 } from "./helpers/d1";
import { MIGRATIONS } from "./helpers/migrations";
import {
  FIXTURES,
  type IndexServer,
  allFixtureObjects,
  datasetIdOf,
  fixtureObject,
  startCatalogServer,
  startIndexServer,
} from "./helpers/zarr-fixtures";

const TOKEN = "recordings-collector-token";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const FIXTURE_IDS = FIXTURES.map(datasetIdOf);

let dir: string;
let stateDir: string;
let catalog: ReturnType<typeof startCatalogServer>;
let index: IndexServer;
let engine: Database;
let server: ReturnType<typeof Bun.serve>;
let sectionsUrl: string;
let ingestRequests: number;
/** What the local endpoint does with a request; the default is the real Worker's answer. */
let respond: (attempt: number, answer: () => Promise<Response>) => Promise<Response>;
let saved: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "recordings-failures-"));
  stateDir = join(dir, "state");
  catalog = startCatalogServer(FIXTURE_IDS.map((dataset_id) => ({ dataset_id })));
  index = startIndexServer(allFixtureObjects());
  engine = new Database(":memory:");
  for (const migration of MIGRATIONS) engine.run(migration);
  const env = {
    OBS_DB: asD1(engine),
    OBS_INGEST_TOKENS_JSON: JSON.stringify({ recordings: TOKEN }),
  } as unknown as Bindings;
  ingestRequests = 0;
  respond = (_attempt, answer) => answer();
  server = Bun.serve({
    port: 0,
    fetch(request) {
      ingestRequests += 1;
      return respond(ingestRequests, () => worker.fetch(request, env, ctx));
    },
  });
  sectionsUrl = new URL("/observability/api/sections", server.url).href;
  saved = process.env[RECORDINGS_COLLECTOR.tokenVariable];
  process.env[RECORDINGS_COLLECTOR.tokenVariable] = TOKEN;
});

afterEach(async () => {
  catalog.stop();
  index.stop();
  server.stop(true);
  engine.close();
  await rm(dir, { recursive: true, force: true });
  if (saved === undefined) delete process.env[RECORDINGS_COLLECTOR.tokenVariable];
  else process.env[RECORDINGS_COLLECTOR.tokenVariable] = saved;
});

const options = () => ({
  apiBase: catalog.url,
  indexBase: index.url,
  stateDir,
  retryDelayMs: 0,
  catalogAttempts: 3,
  postBackoffMs: [0, 0, 0],
  log: () => undefined,
});

const run = (extra: Record<string, unknown> = {}) =>
  runCollector({
    ...RECORDINGS_COLLECTOR,
    collect: () => collectRecordings({ ...options(), sectionsUrl, ...extra }),
    sectionsUrl,
  });
const stored = async () =>
  (await loadPushedSections(asD1(engine))).find((s) => s.key === "recordings");
const goodSectionStored = async () => {
  const section = await stored();
  return (
    section?.channel_hours !== undefined &&
    section.metrics.some((m) => m.key === "recordings.collector.errors" && m.value === 0)
  );
};

describe("a definite refusal by the dashboard", () => {
  test("a 413 is not retried, says nothing was stored, and replaces the section with the error status", async () => {
    respond = (attempt, answer) =>
      attempt === 1
        ? Promise.resolve(Response.json({ error: "Section payload exceeds 1 MB" }, { status: 413 }))
        : answer();
    const failure = await collectRecordings({ ...options(), sectionsUrl }).catch((e) => e);
    expect(failure).toBeInstanceOf(IngestRejectedError);
    expect(failure.message).toContain("HTTP 413");
    expect(failure.message).toContain("nothing was stored");
    expect(failure.message).toContain("Section payload exceeds 1 MB");
    expect(failure.message).not.toContain("may be unknown");
    expect(ingestRequests).toBe(1);

    // Through the runner: the refusal is a collection failure, so the failure status is tried.
    ingestRequests = 0;
    respond = (attempt, answer) =>
      attempt === 1
        ? Promise.resolve(Response.json({ error: "Section payload exceeds 1 MB" }, { status: 413 }))
        : answer();
    expect(await run()).toBe(1);
    expect(ingestRequests).toBe(2);
    expect((await stored())?.metrics.map((m) => [m.key, m.severity])).toEqual([
      ["recordings.collector.errors", "error"],
    ]);
  });

  test("a 422 keeps the first 500 characters of the Worker's explanation", async () => {
    const issues = Array.from({ length: 40 }, (_, i) => ({
      path: ["channel_hours", "modalities", i, "bins"],
      message: `issue number ${i} in the schema check`,
    }));
    respond = () =>
      Promise.resolve(
        Response.json({ error: "Section does not match schema", issues }, { status: 422 }),
      );
    const failure = await collectRecordings({ ...options(), sectionsUrl }).catch((e) => e);
    expect(failure).toBeInstanceOf(IngestRejectedError);
    expect(failure.message).toContain("HTTP 422");
    expect(failure.message).toContain("Section does not match schema");
    expect(failure.message).toContain("issue number 0");
    expect(failure.message).not.toContain("issue number 39"); // cut at 500 characters
    expect(failure.message.length).toBeLessThan(700);
    expect(ingestRequests).toBe(1);
  });

  test("the real Worker's 422 for an invalid section carries its issue list", async () => {
    const { payload } = await buildRecordings(options());
    const invalid = structuredClone(payload) as {
      channel_hours: { modalities: { recordings: number }[] };
    };
    invalid.channel_hours.modalities[0].recordings += 1;
    const failure = await postSection("recordings", TOKEN, invalid, sectionsUrl, {
      backoffMs: [0],
    }).catch((e) => e);
    expect(failure).toBeInstanceOf(IngestRejectedError);
    expect(failure.message).toContain("HTTP 422");
    expect(failure.message).toContain("recordings must equal the sum over bins");
    expect(await stored()).toBeUndefined();
  });

  test("without the opt-in a 4xx keeps the message egress and storage have always had", async () => {
    respond = () => Promise.resolve(Response.json({ error: "nope" }, { status: 422 }));
    const failure = await postSection("recordings", TOKEN, { x: 1 }, sectionsUrl).catch((e) => e);
    expect(failure).toBeInstanceOf(IngestError);
    expect(failure).not.toBeInstanceOf(IngestRejectedError);
    expect(failure.message).toBe("dashboard returned HTTP 422; the write outcome may be unknown");
    expect(ingestRequests).toBe(1); // and a single attempt
  });

  test("the Worker accepts a body of the collector's own size limit and refuses one over its own", async () => {
    const { payload } = await buildRecordings(options());
    const padded = structuredClone(payload);
    const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;
    padded.metrics[0].hint = "x".repeat(
      MAX_PAYLOAD_BYTES - (size(padded) - (padded.metrics[0].hint?.length ?? 0)),
    );
    expect(size(padded)).toBe(MAX_PAYLOAD_BYTES);
    await postSection("recordings", TOKEN, padded, sectionsUrl, { retries: 0 });
    expect((await stored())?.metrics[0].hint?.length).toBeGreaterThan(MAX_PAYLOAD_BYTES - 5_000);

    // The Worker's cap is 1,000,000 bytes: one byte over is a 413.
    const over = structuredClone(payload);
    over.metrics[0].hint = "x".repeat(
      1_000_001 - (size(over) - (over.metrics[0].hint?.length ?? 0)),
    );
    expect(size(over)).toBe(1_000_001);
    const failure = await postSection("recordings", TOKEN, over, sectionsUrl, { retries: 0 }).catch(
      (e) => e,
    );
    expect(failure).toBeInstanceOf(IngestRejectedError);
    expect(failure.message).toContain("HTTP 413");
    // and it is the collector's limit that keeps a real payload far from that.
    expect(MAX_PAYLOAD_BYTES).toBeLessThan(1_000_000);
  });
});

describe("an outage of the dashboard", () => {
  test("a 503 then a 429 then success is one successful run", async () => {
    respond = (attempt, answer) =>
      attempt === 1
        ? Promise.resolve(new Response("unavailable", { status: 503 }))
        : attempt === 2
          ? Promise.resolve(new Response("slow down", { status: 429 }))
          : answer();
    expect(await run()).toBe(0);
    expect(ingestRequests).toBe(3);
    expect(await goodSectionStored()).toBe(true);
  });

  test("a gateway error that persists is unknown, not a rejection, and is not followed by an error status", async () => {
    respond = () => Promise.resolve(new Response("bad gateway", { status: 502 }));
    const failure = await collectRecordings({ ...options(), sectionsUrl }).catch((e) => e);
    expect(failure).toBeInstanceOf(IngestError);
    expect(failure.message).toContain("HTTP 502; the write outcome may be unknown");
    expect(failure.message).toContain("after 4 tries");
    expect(ingestRequests).toBe(4);
    ingestRequests = 0;
    expect(await run()).toBe(1);
    expect(ingestRequests).toBe(4); // no fifth request carrying a failure status
  });

  test("a push that throws every time (connection dropped) is retried, then reported unknown, with no error status", async () => {
    let connections = 0;
    const dropper = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open(socket) {
          connections += 1;
          socket.end();
        },
        data() {},
      },
    });
    try {
      const url = `http://127.0.0.1:${dropper.port}/observability/api/sections`;
      const failure = await collectRecordings({ ...options(), sectionsUrl: url }).catch((e) => e);
      expect(failure).toBeInstanceOf(IngestError);
      expect(failure.message).toContain("the write outcome is unknown");
      expect(failure.message).toContain("after 4 tries");
      expect(connections).toBe(4);
      connections = 0;
      const code = await runCollector({
        ...RECORDINGS_COLLECTOR,
        collect: () => collectRecordings({ ...options(), sectionsUrl: url }),
        sectionsUrl: url,
      });
      expect(code).toBe(1);
      expect(connections).toBe(4); // nothing further was sent
    } finally {
      dropper.stop(true);
    }
  });
});

describe("an error after the section was stored", () => {
  test("a logger that throws once the push succeeded does not replace the section with a failure status", async () => {
    let pushed = false;
    respond = async (_attempt, answer) => {
      const response = await answer();
      pushed = true;
      return response;
    };
    const code = await run({
      log: (line: string) => {
        if (pushed) throw new Error(`the journal broke on: ${line.slice(0, 20)}`);
      },
    });
    expect(code).toBe(0);
    expect(ingestRequests).toBe(1);
    expect(await goodSectionStored()).toBe(true);
  });

  test("an error before the push, in code that is not the collector's own, still fails the run and says so", async () => {
    let calls = 0;
    const code = await run({
      log: () => {
        calls += 1;
        throw new TypeError("a bug before anything was posted");
      },
    });
    expect(calls).toBe(1);
    expect(code).toBe(1);
    // Nothing had been stored, so the error status is the only write.
    expect(ingestRequests).toBe(1);
    expect((await stored())?.metrics.map((m) => m.severity)).toEqual(["error"]);
  });
});

describe("cache housekeeping and a suspicious catalog", () => {
  const writeStale = async (ids: string[]) => {
    const cache = await SummaryCache.open(join(stateDir, "summaries"));
    const summary = summarizeIndex(fixtureObject("nm000118"), "nm000118");
    for (const id of ids) await cache.write(id, '"stale"', summary);
    return cache;
  };
  const files = async () => (await readdir(join(stateDir, "summaries"))).sort();

  test("entries for datasets that are no longer public are removed after a publishable run", async () => {
    await writeStale(["nm000555"]);
    await buildRecordings(options());
    const names = await files();
    expect(names).not.toContain("nm000555.json");
    expect(names).toHaveLength(7);
  });

  test("a run that is not publishable prunes nothing", async () => {
    await writeStale(["nm000555"]);
    for (const id of FIXTURE_IDS.slice(0, 5)) index.state.failures.set(id, [500, 500, 500]);
    await expect(buildRecordings(options())).rejects.toThrow("could not be read");
    expect(await files()).toContain("nm000555.json");
  });

  test("a catalog far smaller than the cache is refused, and the cache is left alone", async () => {
    const stale = Array.from({ length: 20 }, (_, i) => `nm${String(900 + i).padStart(6, "0")}`);
    await writeStale(stale);
    await expect(buildRecordings(options())).rejects.toThrow(
      "the public dataset catalog lists 7 datasets but the cache holds 20",
    );
    expect(await files()).toHaveLength(20);
    expect(index.requests).toEqual([]); // and nothing was downloaded for it
  });
});

describe("a checkout that has stopped updating", () => {
  const marker = () => join(dir, "update-failed-since");
  const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

  test("a marker over a day old puts the code_stale error metric in the pushed section", async () => {
    await writeFile(marker(), `${hoursAgo(30)}\n`);
    expect(await run({ codeMarker: marker() })).toBe(0);
    const metric = (await stored())?.metrics.find(
      (m) => m.key === "recordings.collector.code_stale",
    );
    expect(metric).toMatchObject({ value: 1, severity: "error" });
    expect(metric?.hint).toContain("has not been able to update its code since");
    // The data is still delivered beside it.
    expect((await stored())?.channel_hours).toBeDefined();
  });

  test("a recent marker, and no marker, add nothing", async () => {
    await writeFile(marker(), `${hoursAgo(3)}\n`);
    expect(await run({ codeMarker: marker() })).toBe(0);
    expect((await stored())?.metrics.map((m) => m.key)).not.toContain(
      "recordings.collector.code_stale",
    );
    expect(await run({ codeMarker: join(dir, "no-such-marker") })).toBe(0);
    expect((await stored())?.metrics.map((m) => m.key)).not.toContain(
      "recordings.collector.code_stale",
    );
  });
});
