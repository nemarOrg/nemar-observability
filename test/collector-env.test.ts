// The exact environment each collector's child process gets, from real bash
// running the real ops/collector-profiles.sh (the same functions the wrapper
// runs). Infisical's injection is the one thing simulated, by exporting the
// variables the Infisical path holds; the filtering, the unsetting, and the
// fixed settings are the wrapper's own code. Each case runs under every bash on
// the machine, including the system bash 3.2 of macOS when present, because the
// functions must not need a newer one. The whole wrapper (token file, Infisical
// CLI, GNU stat) can only run on nemaring; everything about the child's
// environment is here.

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";

const PROFILES = new URL("../ops/collector-profiles.sh", import.meta.url).pathname;

/** Every distinct bash found: the PATH one and the system one. */
const bashes = [...new Set([Bun.which("bash"), "/bin/bash", "/usr/bin/bash"])].filter(
  (path): path is string => typeof path === "string" && existsSync(path),
);
const ENV_BIN = Bun.which("env") ?? "/usr/bin/env";

const version = (bash: string) =>
  Bun.spawnSync([bash, "-c", 'echo "${BASH_VERSINFO[0]}.${BASH_VERSINFO[1]}"'])
    .stdout.toString()
    .trim();

/** What `infisical run` injects from prod:/observability/egress, plus its own variables. */
const INJECTED = {
  OBS_EGRESS_INGEST_TOKEN: "egress-token",
  OBS_STORAGE_INGEST_TOKEN: "storage-token",
  OBS_RECORDINGS_INGEST_TOKEN: "recordings-token",
  AWS_ACCESS_KEY_ID: "aws-id",
  AWS_SECRET_ACCESS_KEY: "aws-secret",
  AWS_REGION: "us-east-2",
  INFISICAL_TOKEN: "infisical-service-token",
  INFISICAL_DOMAIN: "https://infisical.nemar.org",
  INFISICAL_PROFILE: "profile",
};

/** What the collector units and a careless caller might have exported. */
const INHERITED = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/yahya",
  EGRESS_START_DATE: "2026-08-01",
  EGRESS_LOOKBACK_DAYS: "3",
  STATE_DIRECTORY: "/var/lib/nemar-observability-recordings",
  INFISICAL_CLI: "/home/yahya/.local/bin/infisical",
  BUN_BIN: "/home/yahya/.bun/bin/bun",
  RECORDINGS_STATE_DIR: "/elsewhere",
  AWS_PROFILE: "inherited-profile",
  LD_PRELOAD: "/tmp/evil.so",
  UNRELATED: "1",
};

/** Variables bash itself adds to an `env -i` shell; not part of what the wrapper decides. */
const SHELL_NOISE = new Set(["PWD", "OLDPWD", "SHLVL", "_"]);

/**
 * Run the wrapper's steps for one collector and return the environment of the
 * final command, exactly as `infisical run -- env ... COMMAND` would give it.
 * `env` itself stands in for Bun as COMMAND.
 */
function childEnvironment(bash: string, script: string): Record<string, string> {
  const steps = [
    `. "${PROFILES}"`,
    `collector_profile "$1" || exit 3`,
    "collector_clear_inherited || exit 4",
    "collector_env_unset_args",
    // Infisical's injection, after the inherited environment was filtered.
    ...Object.entries(INJECTED).map(([name, value]) => `export ${name}='${value}'`),
    "collector_set_runtime_env",
    `exec "${ENV_BIN}" "\${COLLECTOR_ENV_UNSET[@]}" "\${COLLECTOR_ENV_FIXED[@]}" "${ENV_BIN}"`,
  ];
  const result = Bun.spawnSync([bash, "-c", steps.join("\n"), "wrapper", script], {
    env: INHERITED,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(`bash ${bash} exited ${result.exitCode}: ${result.stderr.toString()}`);
  }
  const seen: Record<string, string> = {};
  for (const line of result.stdout.toString().split("\n")) {
    const at = line.indexOf("=");
    if (at > 0 && !SHELL_NOISE.has(line.slice(0, at))) seen[line.slice(0, at)] = line.slice(at + 1);
  }
  return seen;
}

/** What every child gets, whichever collector it is. */
const COMMON = {
  HOME: "/home/yahya",
  PATH: "/usr/bin:/bin",
  INFISICAL_DISABLE_UPDATE_CHECK: "true",
  NO_COLOR: "1",
  AWS_CONFIG_FILE: "/dev/null",
  AWS_SHARED_CREDENTIALS_FILE: "/dev/null",
  AWS_EC2_METADATA_DISABLED: "true",
};

/**
 * The environment each collector saw before the recordings collector existed,
 * plus nothing new: its own token, the AWS key (the S3 collectors), and the
 * settings it reads. The recordings child gets its token, its state directory,
 * and no AWS key.
 */
const EXPECTED: Record<string, Record<string, string>> = {
  "push-s3-egress.ts": {
    ...COMMON,
    OBS_EGRESS_INGEST_TOKEN: "egress-token",
    AWS_ACCESS_KEY_ID: "aws-id",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    AWS_REGION: "us-east-2",
    EGRESS_START_DATE: "2026-08-01",
    EGRESS_LOOKBACK_DAYS: "3",
  },
  "push-s3-storage.ts": {
    ...COMMON,
    OBS_STORAGE_INGEST_TOKEN: "storage-token",
    AWS_ACCESS_KEY_ID: "aws-id",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    AWS_REGION: "us-east-2",
  },
  "push-zarr-recordings.ts": {
    ...COMMON,
    OBS_RECORDINGS_INGEST_TOKEN: "recordings-token",
    STATE_DIRECTORY: "/var/lib/nemar-observability-recordings",
  },
};

describe("the environment each collector's child sees", () => {
  test("at least one real bash is available", () => {
    expect(bashes.length).toBeGreaterThan(0);
    console.info(`[collector-env] bash: ${bashes.map((b) => `${b} ${version(b)}`).join(", ")}`);
  });

  for (const bash of bashes) {
    for (const [script, expected] of Object.entries(EXPECTED)) {
      test(`${script} under bash ${version(bash)} (${bash})`, () => {
        expect(childEnvironment(bash, script)).toEqual(expected);
      });
    }
  }

  test("each collector sees its own token and no other collector's", () => {
    const tokens = Object.keys(INJECTED).filter((name) => name.endsWith("_INGEST_TOKEN"));
    for (const [script, expected] of Object.entries(EXPECTED)) {
      const seen = Object.keys(expected).filter((name) => tokens.includes(name));
      expect({ script, count: seen.length }).toEqual({ script, count: 1 });
    }
    // Together they cover every token, so the check above means "exactly its own".
    const owned = Object.values(EXPECTED).flatMap((env) =>
      Object.keys(env).filter((name) => tokens.includes(name)),
    );
    expect(owned.sort()).toEqual(tokens.sort());
  });

  test("a secret nobody listed does not reach the recordings child through the token set", () => {
    // The lists are derived from COLLECTOR_INGEST_TOKENS: a fourth collector's token,
    // added there, is dropped from the other three with no other edit.
    const source = Bun.spawnSync(
      [
        bashes[0],
        "-c",
        `. "${PROFILES}"; COLLECTOR_INGEST_TOKENS+=(OBS_FUTURE_INGEST_TOKEN); collector_profile push-s3-storage.ts; collector_env_unset_args; printf '%s\\n' "\${COLLECTOR_ENV_UNSET[@]}"`,
      ],
      { stdout: "pipe", env: INHERITED },
    )
      .stdout.toString()
      .split("\n");
    expect(source).toContain("OBS_FUTURE_INGEST_TOKEN");
    expect(source).toContain("OBS_EGRESS_INGEST_TOKEN");
    expect(source).toContain("OBS_RECORDINGS_INGEST_TOKEN");
    expect(source).not.toContain("OBS_STORAGE_INGEST_TOKEN");
  });

  test("an unknown collector name is refused and sets nothing", () => {
    for (const name of [
      "push-s3-egress.ts.bak",
      "../scripts/push-s3-egress.ts",
      "check-health.ts",
      "",
    ]) {
      const result = Bun.spawnSync(
        [
          bashes[0],
          "-c",
          `. "${PROFILES}"; collector_profile "$1" && echo known || echo "refused:\${COLLECTOR_TAG:-unset}"`,
          "x",
          name,
        ],
        { stdout: "pipe", env: INHERITED },
      );
      expect(result.stdout.toString().trim()).toBe("refused:unset");
    }
  });

  test("sourcing the file changes nothing in the shell", () => {
    const result = Bun.spawnSync(
      [
        bashes[0],
        "-c",
        `before="$(compgen -e | sort | tr '\\n' ' ')"; . "${PROFILES}"; after="$(compgen -e | sort | tr '\\n' ' ')"; [ "$before" = "$after" ] && echo same`,
      ],
      { stdout: "pipe", env: INHERITED },
    );
    expect(result.stdout.toString().trim()).toBe("same");
  });
});
