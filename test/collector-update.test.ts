// The nemaring collectors update themselves from main before every run
// (ops/update-checkout.sh, started by the update service). These tests run the
// real script against real git repositories, and check that a checkout that has
// stopped updating becomes an error metric the dashboard health check reports.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  CODE_STALE_AFTER_MS,
  codeStaleMetrics,
  codeUpdateProblem,
} from "../scripts/lib/s3-cloudwatch";
import { aggregateOutcomes, recordingsSection } from "../scripts/lib/zarr-aggregate";
import { summarizeIndex } from "../scripts/lib/zarr-recordings";
import { egressSection } from "../scripts/push-s3-egress";
import { storageSection } from "../scripts/push-s3-storage";
import { fixtureObject } from "./helpers/zarr-fixtures";

const SCRIPT = new URL("../ops/update-checkout.sh", import.meta.url).pathname;
let root: string;
let origin: string;
let work: string;
let repo: string;
let marker: string;

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: root,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.org",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.org",
    },
  });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.toString().trim();
}

function publish(file: string, content: string): void {
  writeFileSync(join(work, file), content);
  git(work, "add", file);
  git(work, "commit", "-q", "-m", `edit ${file}`);
  git(work, "push", "-q", "origin", "main");
}

function runUpdate(): { code: number; out: string } {
  const result = Bun.spawnSync(["bash", SCRIPT], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: root,
      NEMAR_OBSERVABILITY_REPO: repo,
      NEMAR_OBSERVABILITY_MARKER: marker,
    },
  });
  return { code: result.exitCode, out: `${result.stdout}${result.stderr}` };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "obs-update-"));
  origin = join(root, "origin.git");
  work = join(root, "work");
  repo = join(root, "checkout");
  marker = join(root, "state", "update-failed-since");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, work);
  git(work, "checkout", "-q", "-b", "main");
  publish("collector.ts", "v1\n");
  git(root, "clone", "-q", origin, repo);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("ops/update-checkout.sh", () => {
  test("brings the checkout to the newest origin/main and reports the commit", () => {
    publish("collector.ts", "v2\n");
    const { code, out } = runUpdate();
    expect(code).toBe(0);
    expect(readFileSync(join(repo, "collector.ts"), "utf8")).toBe("v2\n");
    expect(git(repo, "rev-parse", "HEAD")).toBe(git(origin, "rev-parse", "main"));
    expect(out).toContain("[update] checkout at");
    expect(existsSync(marker)).toBe(false);
  });

  test("recovers from a dirty tree, another branch, and a stray local commit", () => {
    git(repo, "checkout", "-q", "-b", "scratch");
    writeFileSync(join(repo, "collector.ts"), "local edit\n");
    git(repo, "commit", "-q", "-am", "local commit");
    writeFileSync(join(repo, "collector.ts"), "uncommitted\n");
    publish("collector.ts", "v2\n");

    expect(runUpdate().code).toBe(0);
    expect(git(repo, "branch", "--show-current")).toBe("main");
    expect(readFileSync(join(repo, "collector.ts"), "utf8")).toBe("v2\n");
    expect(git(repo, "rev-parse", "HEAD")).toBe(git(origin, "rev-parse", "main"));
  });

  test("a failed update leaves the code as it was and records when failing began", () => {
    git(repo, "remote", "set-url", "origin", join(root, "gone.git"));
    const first = runUpdate();
    expect(first.code).toBe(1);
    expect(first.out).toContain("[update] ERROR");
    expect(readFileSync(join(repo, "collector.ts"), "utf8")).toBe("v1\n");
    const since = readFileSync(marker, "utf8").trim();
    expect(since).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

    // A second failure keeps the time the failures began.
    expect(runUpdate().code).toBe(1);
    expect(readFileSync(marker, "utf8").trim()).toBe(since);
  });

  test("the next successful update clears the marker", () => {
    git(repo, "remote", "set-url", "origin", join(root, "gone.git"));
    expect(runUpdate().code).toBe(1);
    expect(existsSync(marker)).toBe(true);
    git(repo, "remote", "set-url", "origin", origin);
    publish("collector.ts", "v2\n");
    expect(runUpdate().code).toBe(0);
    expect(existsSync(marker)).toBe(false);
  });
});

describe("collector code that has stopped updating", () => {
  const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();
  const writeMarker = (text: string) => {
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, text);
  };

  test("is not reported without a marker, or while the failure is under a day old", async () => {
    expect(await codeUpdateProblem(Date.now(), join(root, "no-such-marker"))).toBeNull();
    writeMarker(`${hoursAgo(3)}\n`);
    expect(await codeUpdateProblem(Date.now(), marker)).toBeNull();
  });

  test("is reported, with the time it began, once the failure is over a day old", async () => {
    const began = hoursAgo(30);
    writeMarker(`${began}\n`);
    expect(await codeUpdateProblem(Date.now(), marker)).toBe(began);
    expect(CODE_STALE_AFTER_MS).toBe(24 * 3_600_000);
  });

  test("an unreadable marker still counts as a failure", async () => {
    writeMarker("garbage");
    expect(await codeUpdateProblem(Date.now(), marker)).toBe("an unknown time");
  });

  test("becomes an error metric in each collector section, and only then", () => {
    expect(codeStaleMetrics("egress", null)).toEqual([]);
    const [metric] = codeStaleMetrics("egress", "2026-09-28T00:00:00.000Z");
    expect(metric).toMatchObject({
      key: "egress.collector.code_stale",
      severity: "error",
      value: 1,
    });

    const points = [{ date: "2026-09-29", value: 1 }];
    const keys = (s: { metrics: { key: string }[] }) => s.metrics.map((m) => m.key);
    expect(keys(egressSection(points))).not.toContain("egress.collector.code_stale");
    expect(keys(egressSection(points, "2026-09-28T00:00:00.000Z"))).toContain(
      "egress.collector.code_stale",
    );

    const observation = {
      date: "2026-09-29",
      bucketBytes: 1,
      objectCount: 1,
      byClass: [{ storageType: "StandardStorage", bytes: 1 }],
    };
    expect(keys(storageSection(observation))).not.toContain("storage.collector.code_stale");
    expect(keys(storageSection(observation, "2026-09-28T00:00:00.000Z"))).toContain(
      "storage.collector.code_stale",
    );

    const recordings = aggregateOutcomes(1, [
      {
        id: "nm000118",
        kind: "summary",
        summary: summarizeIndex(fixtureObject("nm000118"), "nm000118"),
        from: "network",
      },
    ]);
    expect(keys(recordingsSection(recordings))).not.toContain("recordings.collector.code_stale");
    expect(keys(recordingsSection(recordings, "2026-09-28T00:00:00.000Z"))).toContain(
      "recordings.collector.code_stale",
    );
  });
});
