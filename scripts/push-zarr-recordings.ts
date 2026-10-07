#!/usr/bin/env bun

// "Recorded data" collector, run three times a day. For every public NEMAR dataset it reads the
// dataset's public Zarr index (https://nemar.s3.us-east-2.amazonaws.com/<id>/zarr/index.json),
// totals the hours of converted raw recordings per modality and exact channel
// count, and pushes the result as section `recordings` (source
// `nemar-zarr-index`) with the `channel_hours` payload the dashboard's
// "hours of data" explorer draws.
//
// It runs on nemaring, not in the Worker: one index is over 300 MB, far beyond
// what a Worker can parse. Indexes are streamed (see lib/json-stream.ts), and
// each dataset's summary is cached by the index's ETag (lib/zarr-index-source.ts),
// so after the first run a run downloads almost nothing. Needs only the
// section's ingest token: no AWS credentials, and nothing is read that is not
// anonymously public.
//
//   bun scripts/push-zarr-recordings.ts --dry-run --out /tmp/recordings.json
//
// `--dry-run` computes and prints everything and writes the payload to --out,
// but never reads the ingest token, never posts, and never publishes a failure
// status. Other flags: --state-dir DIR (cache location), --api-base URL,
// --index-base URL, --concurrency N.

import { writeFile } from "node:fs/promises";
import { argv, env, exit } from "node:process";
import type { SectionIngest } from "../src/lib/schema";
import {
  CollectionError,
  IngestError,
  codeUpdateProblem,
  postSection,
  requiredSecret,
  runCollectorAndExit,
} from "./lib/s3-cloudwatch";
import {
  type DatasetOutcome,
  type RecordingsAggregate,
  aggregateOutcomes,
  assertPublishable,
  recordingsFailureStatus,
  recordingsSection,
  round4,
  topContributors,
} from "./lib/zarr-aggregate";
import {
  DEFAULT_API_BASE,
  DEFAULT_INDEX_BASE,
  SummaryCache,
  assertCatalogPlausible,
  listPublicDatasets,
  scanDatasets,
} from "./lib/zarr-index-source";

export const RECORDINGS_COLLECTOR = {
  tag: "zarr-recordings",
  sectionKey: "recordings",
  tokenVariable: "OBS_RECORDINGS_INGEST_TOKEN",
  failureStatus: () => recordingsFailureStatus(),
} as const;

export type CollectOptions = {
  apiBase?: string;
  indexBase?: string;
  /** Parent of the `summaries/` cache directory; null disables the cache. */
  stateDir?: string | null;
  concurrency?: number;
  /** Tries per dataset and the pause before the second one (tests shorten these). */
  attempts?: number;
  retryDelayMs?: number;
  /** Tries per catalog page; the default waits out about five minutes of 5xx. */
  catalogAttempts?: number;
  headerTimeoutMs?: number;
  idleTimeoutMs?: number;
  /** Longest one index may take, and most bytes it may have; see ReadOptions. */
  deadlineMs?: number;
  maxBytes?: number;
  /**
   * Share, by dataset count and by last-known hours, of unreadable indexes above
   * which the run fails instead of publishing; default 0.1.
   */
  maxUnavailableFraction?: number;
  /** Where the update service records a stalled checkout; default as in s3-cloudwatch.ts. */
  codeMarker?: string | URL;
  /** Pushes: further tries and the pause before each (default 3 tries at 5 s, 15 s, 45 s). */
  postRetries?: number;
  postBackoffMs?: readonly number[];
  log?: (line: string) => void;
};

export type CollectResult = {
  payload: SectionIngest;
  aggregate: RecordingsAggregate;
  outcomes: DatasetOutcome[];
  elapsedMs: number;
};

/**
 * Where the summary cache lives: the explicit directory, else
 * `RECORDINGS_STATE_DIR`, else systemd's `STATE_DIRECTORY` (the service's
 * writable state directory), else `~/.cache/nemar-observability/recordings`.
 * The cache itself is the `summaries/` subdirectory.
 */
export function resolveStateDir(
  explicit: string | undefined,
  environment: Record<string, string | undefined> = env,
): string | null {
  const chosen =
    explicit ??
    environment.RECORDINGS_STATE_DIR ??
    environment.STATE_DIRECTORY?.split(":")[0] ??
    (environment.HOME ? `${environment.HOME}/.cache/nemar-observability/recordings` : undefined);
  return chosen && chosen.length > 0 ? chosen : null;
}

/** Read the catalog and every index, and build the validated section payload. */
export async function buildRecordings(
  options: CollectOptions = {},
  codeStaleSince: string | null = null,
): Promise<CollectResult> {
  const started = Date.now();
  const log = options.log ?? ((line: string) => console.info(line));
  const tag = RECORDINGS_COLLECTOR.tag;

  const stateDir = options.stateDir === undefined ? resolveStateDir(undefined) : options.stateDir;
  const cache = await SummaryCache.open(stateDir === null ? null : `${stateDir}/summaries`);
  const datasets = await listPublicDatasets(options.apiBase ?? DEFAULT_API_BASE, {
    retryDelayMs: options.retryDelayMs,
    attempts: options.catalogAttempts,
  });
  log(`[${tag}] ${datasets.length} public datasets in the catalog`);
  assertCatalogPlausible(datasets, await cache.count());

  const outcomes = await scanDatasets(datasets, {
    indexBase: options.indexBase ?? DEFAULT_INDEX_BASE,
    cache,
    concurrency: options.concurrency,
    attempts: options.attempts,
    retryDelayMs: options.retryDelayMs,
    headerTimeoutMs: options.headerTimeoutMs,
    idleTimeoutMs: options.idleTimeoutMs,
    deadlineMs: options.deadlineMs,
    maxBytes: options.maxBytes,
    onUnavailable: (id, reason) => console.warn(`[${tag}] ${id} unavailable: ${reason}`),
    onNote: (id, message) => console.warn(`[${tag}] ${id}: ${message}`),
  });

  const aggregate = aggregateOutcomes(datasets.length, outcomes);
  const payload = recordingsSection(aggregate, codeStaleSince);
  assertPublishable(aggregate, payload, options.maxUnavailableFraction);
  // Housekeeping only after the result is publishable: a catalog that came back
  // short must not also erase the cache entries that would have exposed it.
  const pruned = await cache.prune(new Set(datasets.map((dataset) => dataset.id)));
  if (pruned > 0) log(`[${tag}] removed ${pruned} cache entries for datasets no longer public`);
  return { payload, aggregate, outcomes, elapsedMs: Date.now() - started };
}

const hours = (value: number) =>
  value.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const count = (value: number) => value.toLocaleString("en-US");

/** A plain-text account of a run: what was read, what it adds up to, and who dominates it. */
export function formatReport(result: CollectResult): string[] {
  const { aggregate, outcomes, elapsedMs } = result;
  const modalityTotal = round4(
    aggregate.modalities.reduce((total, modality) => total + modality.hours, 0),
  );
  const lines = [
    `public datasets ${count(aggregate.publicDatasets)}: scanned ${count(aggregate.scanned)} (cache ${count(aggregate.fromCache)}, downloaded ${count(aggregate.fromNetwork)}), no Zarr index ${count(aggregate.withoutIndex)}, unavailable ${count(aggregate.unavailable)}`,
    `datasets with at least one measured recording ${count(aggregate.contributingDatasets)}`,
    `recordings measured ${count(aggregate.measuredRecordings)} (each store once); unmeasured stores ${count(aggregate.unmeasuredStores)}; failed ${count(aggregate.failedRecordings)}; pending ${count(aggregate.pendingRecordings)}`,
    `skipped as derived or non-raw ${count(aggregate.excludedStores)}; stores with several groups ${count(aggregate.multiGroupStores)}, with several modalities ${count(aggregate.multiModalityStores)}`,
    `recordings_unmeasured in channel_hours ${count(aggregate.unmeasuredRecordings)}`,
    `hours, each recording once (headline): ${hours(aggregate.recordedSeconds / 3600)}`,
    `hours, sum of the modality totals: ${hours(modalityTotal)}`,
  ];
  const top = topContributors(outcomes);
  for (const modality of aggregate.modalities) {
    lines.push(
      `${modality.modality}: ${hours(modality.hours)} h, ${count(modality.recordings)} recordings, ${count(modality.datasets)} datasets, ${modality.bins.length} channel counts`,
    );
    const contributors = top.get(modality.modality)?.top ?? [];
    for (const { id, hours: h, share } of contributors) {
      lines.push(`  ${id}: ${hours(h)} h (${(share * 100).toFixed(1)}%)`);
    }
  }
  lines.push(`elapsed ${(elapsedMs / 1000).toFixed(1)} s`);
  return lines;
}

/**
 * Collect once and push the section to `sectionsUrl` (production by default).
 *
 * The report is built before the push and nothing after a successful push can
 * throw: the runner answers any error with a failure status that replaces the
 * section, so an error after the write would erase the data it just stored. An
 * exception that is not one of the collector's own (a bug) is logged with its
 * name and stack here, since the runner's journal line for it is generic.
 */
export async function collectRecordings(options: CollectOptions & { sectionsUrl?: string } = {}) {
  const log = options.log ?? ((line: string) => console.info(line));
  const tag = RECORDINGS_COLLECTOR.tag;
  try {
    const ingestToken = requiredSecret(RECORDINGS_COLLECTOR.tokenVariable);
    const result = await buildRecordings(
      options,
      await codeUpdateProblem(Date.now(), options.codeMarker),
    );
    const report = formatReport(result).map((line) => `[${tag}] ${line}`);
    await postSection(
      RECORDINGS_COLLECTOR.sectionKey,
      ingestToken,
      result.payload,
      options.sectionsUrl,
      { retries: options.postRetries, backoffMs: options.postBackoffMs },
    );
    try {
      for (const line of report) log(line);
      log(`[${tag}] posted ${result.payload.channel_hours?.modalities.length} modalities`);
    } catch {
      // The section is stored; a failing logger must not turn that into a failure.
    }
  } catch (error) {
    if (!(error instanceof CollectionError || error instanceof IngestError)) {
      const name = error instanceof Error ? error.name : typeof error;
      console.error(
        `[${tag}] unexpected ${name}: ${error instanceof Error ? error.message : error}`,
      );
      if (error instanceof Error && error.stack) console.error(error.stack);
    }
    throw error;
  }
}

export type CliArguments = CollectOptions & { dryRun: boolean; out?: string };

export function parseArguments(args: string[]): CliArguments {
  const parsed: CliArguments = { dryRun: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const [flag, inline] = arg.split(/=(.*)/s, 2);
    // `--flag value` or `--flag=value`
    const take = (): string => {
      if (inline !== undefined) return inline;
      const next = args[index + 1];
      if (next === undefined || next.startsWith("--")) throw new Error(`${flag} needs a value`);
      index += 1;
      return next;
    };
    switch (flag) {
      case "--dry-run":
        parsed.dryRun = true;
        break;
      case "--out":
        parsed.out = take();
        break;
      case "--state-dir":
        parsed.stateDir = take();
        break;
      case "--api-base":
        parsed.apiBase = take();
        break;
      case "--index-base":
        parsed.indexBase = take();
        break;
      case "--concurrency": {
        const value = Number.parseInt(take(), 10);
        if (!Number.isInteger(value) || value < 1 || value > 32) {
          throw new Error("--concurrency must be an integer from 1 to 32");
        }
        parsed.concurrency = value;
        break;
      }
      default:
        throw new Error(`unknown argument ${arg}`);
    }
  }
  if (parsed.out !== undefined && !parsed.dryRun) throw new Error("--out is only for --dry-run");
  return parsed;
}

/** Compute and print everything; write the payload to --out; never post. */
export async function runDryRun(args: CliArguments): Promise<number> {
  try {
    const result = await buildRecordings(args);
    for (const line of formatReport(result)) console.info(line);
    if (args.out !== undefined) {
      await writeFile(args.out, `${JSON.stringify(result.payload, null, 1)}\n`);
      console.info(`payload written to ${args.out}`);
    }
    return 0;
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : "unexpected error");
    return 1;
  }
}

function readArguments(): CliArguments {
  try {
    return parseArguments(argv.slice(2));
  } catch (error: unknown) {
    console.error(
      `[${RECORDINGS_COLLECTOR.tag}] ${error instanceof Error ? error.message : error}`,
    );
    return exit(2);
  }
}

if ((import.meta as ImportMeta & { main?: boolean }).main) {
  const args = readArguments();
  if (args.dryRun) exit(await runDryRun(args));
  await runCollectorAndExit({
    ...RECORDINGS_COLLECTOR,
    collect: () => collectRecordings(args),
  });
}
