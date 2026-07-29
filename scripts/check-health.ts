#!/usr/bin/env bun
/**
 * Poll /observability/health and report whether the dashboard is lying.
 *
 * Extracted from the monitoring workflow so the alerting logic is testable and
 * runnable by hand (`bun scripts/check-health.ts`) instead of living as
 * untestable YAML. The workflow supplies the URL and turns a non-zero exit into
 * a GitHub issue.
 *
 * Exit 0 = healthy, 1 = unhealthy or unreachable. A network failure counts as
 * unhealthy on purpose: "the monitor could not reach the monitor" is exactly
 * the silence issue #7 is about.
 */

import { appendFileSync } from "node:fs";

const DEFAULT_URL = "https://dashboard.nemar.org/observability/health";
const TIMEOUT_MS = 20_000;

export interface HealthVerdict {
  ok: boolean;
  /** One-line summary suitable for an issue title or an alert body. */
  summary: string;
  /** Full detail for the issue body. */
  detail: string;
}

interface HealthBody {
  ok?: unknown;
  stale?: unknown;
  snapshot?: unknown;
  snapshot_error?: unknown;
  section_errors?: unknown;
  error?: unknown;
  cron?: { last_success_at?: string | null; last_error?: string | null } | null;
}

/**
 * Turn a health response into a verdict. Pure, so the interesting cases are
 * unit-testable without a live endpoint.
 *
 * Anything other than an explicit `ok: true` is unhealthy. A body that does not
 * even parse as the expected shape is unhealthy too rather than being given the
 * benefit of the doubt -- an unrecognizable health response means the contract
 * changed or something else is answering, and both warrant a look.
 */
export function verdictFor(status: number, body: HealthBody | null): HealthVerdict {
  if (body === null) {
    return {
      ok: false,
      summary: `unreachable or unparseable (HTTP ${status})`,
      detail: `The health endpoint returned HTTP ${status} with a body that could not be parsed as JSON.`,
    };
  }
  if (body.ok === true) {
    return { ok: true, summary: "healthy", detail: "" };
  }

  const reasons: string[] = [];
  if (body.error === "store_unavailable") reasons.push("OBS_DB is unreadable");
  if (body.stale === true) {
    const last = body.cron?.last_success_at ?? "never";
    reasons.push(`snapshot is stale (last successful cron: ${last})`);
  }
  const sections = Array.isArray(body.section_errors) ? body.section_errors : [];
  if (sections.length > 0) reasons.push(`sections failed to compute: ${sections.join(", ")}`);
  if (body.snapshot === "unreadable") {
    reasons.push(`stored snapshot is unreadable (${String(body.snapshot_error ?? "unknown")})`);
  }
  if (reasons.length === 0) reasons.push(`ok=${String(body.ok)} with no recognized reason field`);

  return {
    ok: false,
    summary: reasons.join("; "),
    detail: [
      `HTTP ${status}`,
      "",
      "```json",
      JSON.stringify(body, null, 2),
      "```",
      "",
      ...(body.cron?.last_error ? [`Last cron error: \`${body.cron.last_error}\``] : []),
    ].join("\n"),
  };
}

async function main(): Promise<void> {
  const url = process.argv[2] ?? DEFAULT_URL;
  let status = 0;
  let body: HealthBody | null = null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    status = res.status;
    try {
      body = (await res.json()) as HealthBody;
    } catch {
      body = null;
    }
  } catch (err) {
    // Network failure / timeout: unhealthy, not "unknown". Treating an
    // unreachable dashboard as inconclusive would reproduce the blind spot.
    const v: HealthVerdict = {
      ok: false,
      summary: `unreachable: ${String(err).slice(0, 120)}`,
      detail: `\`GET ${url}\` did not complete within ${TIMEOUT_MS}ms or failed outright.`,
    };
    report(v, url);
    process.exit(1);
  }

  const v = verdictFor(status, body);
  report(v, url);
  process.exit(v.ok ? 0 : 1);
}

function report(v: HealthVerdict, url: string): void {
  console.log(`url: ${url}`);
  console.log(`ok: ${v.ok}`);
  console.log(`summary: ${v.summary}`);
  if (v.detail) console.log(`\n${v.detail}`);
  // Consumed by the workflow to build the issue body. APPEND, and synchronously:
  // GITHUB_OUTPUT accumulates across steps, so a truncating write would drop
  // earlier entries, and an async write can be lost to the process.exit below.
  const outFile = process.env.GITHUB_OUTPUT;
  if (outFile) {
    appendFileSync(
      outFile,
      `${[
        `ok=${v.ok}`,
        `summary=${v.summary.replace(/\n/g, " ")}`,
        "detail<<HEALTH_EOF",
        v.detail,
        "HEALTH_EOF",
      ].join("\n")}\n`,
    );
  }
}

if (import.meta.main) await main();
