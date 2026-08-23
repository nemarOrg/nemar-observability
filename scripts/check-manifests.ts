#!/usr/bin/env bun
/**
 * Probe every published version of every public dataset for a servable file
 * index, exactly the way a nemar.org visitor's browser does (#34).
 *
 * The failure this catches: a `dataset_versions` row and DOI exist, but the
 * canonical manifest `<id>/version/v<X>.json` never landed in S3, so
 * data.nemar.org answers `{"error":"Version not published"}` and the dataset
 * page renders "File index unavailable" (the nm000225 incident,
 * nemarOrg/nemar-cli#1130: 10 published versions were in this state for up
 * to 2.5 months with nobody told). Because the probe goes through the public
 * surface, it also catches data-worker regressions, S3 permission drift, and
 * CDN faults -- anything that breaks what users actually see.
 *
 * Zero credentials, no dependencies outside the Bun runtime (a monitor that
 * breaks when the thing it monitors breaks is not a monitor). The workflow
 * turns a non-zero exit into a labeled alert issue.
 *
 * Exit 0 = every advertised version serves an index, 1 = problems or the
 * catalog itself is unreachable. An unreachable catalog counts as a problem
 * on purpose: silence is the failure mode this exists to end.
 */

import { appendFileSync } from "node:fs";

const DEFAULT_API_BASE = "https://api.nemar.org";
const DEFAULT_DATA_BASE = "https://data.nemar.org";
const TIMEOUT_MS = 30_000;
const CONCURRENCY = 8;
/** Cloudflare bot filtering 403s generic runtime user agents; identify honestly. */
const USER_AGENT = "nemar-manifest-monitor/1 (+https://github.com/nemarOrg/nemar-observability)";

export interface Problem {
  dataset_id: string;
  /** Absent when the dataset's landing itself failed. */
  version?: string;
  kind: "landing" | "index";
  http: number;
  error?: string;
}

export interface ManifestVerdict {
  ok: boolean;
  summary: string;
  detail: string;
}

interface LandingVersion {
  version?: unknown;
}

interface LandingBody {
  versions?: unknown;
}

/**
 * Versions a landing payload advertises. Defensive against shape drift: a
 * landing without a parseable versions array yields [], and the caller
 * separately records non-200 landings as problems.
 */
export function versionsOf(landing: LandingBody | null): string[] {
  if (!landing || !Array.isArray(landing.versions)) return [];
  return (landing.versions as LandingVersion[])
    .map((v) => v.version)
    .filter((v): v is string => typeof v === "string" && v.length > 0);
}

/**
 * Turn the sweep outcome into a verdict. Pure, so the aggregation and issue
 * copy are unit-testable without 750 live requests.
 */
export function verdictFor(checked: number, problems: Problem[]): ManifestVerdict {
  if (problems.length === 0) {
    return {
      ok: true,
      summary: `all ${checked} public datasets serve their file indexes`,
      detail: "",
    };
  }
  const lines = problems.map((p) => {
    const target = p.version ? `${p.dataset_id}@${p.version}` : `${p.dataset_id} (landing)`;
    return `- \`${target}\`: HTTP ${p.http}${p.error ? ` (${p.error})` : ""}`;
  });
  const broken = new Set(problems.map((p) => p.dataset_id));
  return {
    ok: false,
    summary: `${broken.size} of ${checked} public datasets have an unservable version index`,
    detail: [
      "Each entry is a version the public catalog advertises whose file index probe",
      "(`data.nemar.org/<id>/<version>/?format=json`) did not return 200 -- users see",
      '"File index unavailable" on that dataset page.',
      "",
      ...lines,
      "",
      "Remediation: `nemar admin doctor fix missing-manifest` (nemarOrg/nemar-cli#1130),",
      "then re-run this workflow to confirm recovery and auto-close this issue.",
    ].join("\n"),
  };
}

async function getJson(
  url: string,
): Promise<{ status: number; body: Record<string, unknown> | null }> {
  try {
    const res = await fetch(url, {
      headers: { accept: "application/json", "user-agent": USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    let body: Record<string, unknown> | null = null;
    try {
      body = (await res.json()) as Record<string, unknown>;
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } catch {
    return { status: 0, body: null };
  }
}

async function listPublicDatasets(apiBase: string): Promise<string[] | null> {
  const ids: string[] = [];
  let offset = 0;
  for (;;) {
    const { status, body } = await getJson(`${apiBase}/datasets?limit=100&offset=${offset}`);
    if (status !== 200 || body === null || !Array.isArray(body.datasets)) return null;
    const batch = (body.datasets as Array<Record<string, unknown>>)
      .map((d) => d.dataset_id)
      .filter((id): id is string => typeof id === "string");
    if (batch.length === 0) break;
    ids.push(...batch);
    offset += batch.length;
    if (typeof body.total === "number" && offset >= body.total) break;
  }
  return ids;
}

async function checkDataset(dataBase: string, datasetId: string): Promise<Problem[]> {
  const { status, body } = await getJson(`${dataBase}/${datasetId}/`);
  if (status !== 200 || body === null) {
    return [{ dataset_id: datasetId, kind: "landing", http: status }];
  }
  const problems: Problem[] = [];
  for (const version of versionsOf(body)) {
    const probe = await getJson(`${dataBase}/${datasetId}/${version}/?format=json`);
    if (probe.status !== 200) {
      problems.push({
        dataset_id: datasetId,
        version,
        kind: "index",
        http: probe.status,
        error: typeof probe.body?.error === "string" ? probe.body.error : undefined,
      });
    }
  }
  return problems;
}

async function sweep(apiBase: string, dataBase: string): Promise<ManifestVerdict> {
  const ids = await listPublicDatasets(apiBase);
  if (ids === null) {
    return {
      ok: false,
      summary: "public catalog is unreachable",
      detail: `\`GET ${apiBase}/datasets\` did not return a parseable page; the sweep could not run.`,
    };
  }
  console.log(`catalog: ${ids.length} public datasets`);

  const problems: Problem[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, ids.length) }, async () => {
    while (next < ids.length) {
      const id = ids[next++];
      problems.push(...(await checkDataset(dataBase, id)));
    }
  });
  await Promise.all(workers);
  return verdictFor(ids.length, problems);
}

function report(v: ManifestVerdict): void {
  console.log(`ok: ${v.ok}`);
  console.log(`summary: ${v.summary}`);
  if (v.detail) console.log(`\n${v.detail}`);
  // Consumed by the workflow to build the issue body. APPEND, and synchronously:
  // GITHUB_OUTPUT accumulates across steps, and an async write can be lost to
  // the process.exit in main.
  const outFile = process.env.GITHUB_OUTPUT;
  if (outFile) {
    appendFileSync(
      outFile,
      `${[
        `ok=${v.ok}`,
        `summary=${v.summary.replace(/\n/g, " ")}`,
        "detail<<MANIFEST_EOF",
        v.detail,
        "MANIFEST_EOF",
      ].join("\n")}\n`,
    );
  }
}

async function main(): Promise<void> {
  const apiBase = (process.argv[2] ?? DEFAULT_API_BASE).replace(/\/$/, "");
  const dataBase = (process.argv[3] ?? DEFAULT_DATA_BASE).replace(/\/$/, "");
  const v = await sweep(apiBase, dataBase);
  report(v);
  process.exit(v.ok ? 0 : 1);
}

if (import.meta.main) await main();
