// The exact environment each collector's child process gets, from real bash
// running the real wrapper code. Two levels, each under every bash on the machine
// (including the system bash 3.2 of macOS when present, because none of it may
// need a newer one):
//
//  1. the wrapper's own functions in ops/collector-profiles.sh, with Infisical's
//     injection simulated by exporting the variables its path holds;
//  2. the whole ops/with-collector-secrets.sh under its `set -euo pipefail`, with
//     stand-ins for the external tools it execs: an `infisical` that injects those
//     variables and runs what follows `--`, a `bun` that prints its environment,
//     and (only where `stat -c` is not GNU, as on macOS) a `stat` shim with GNU
//     semantics. The one edit to the script under test is its install root
//     constant, pointed at a temporary directory.
//
// What this does not cover: the real Infisical CLI (that it injects what its path
// holds, that its own token stays out of every argv) and the real Bun. And it
// pins a limitation rather than fixing it: the wrapper is a deny-list, so a
// secret nobody listed, added to /observability/egress, reaches every collector's
// child. What is hidden from whom is the known tokens and AWS keys.

import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

/** The expectation above with the home and PATH of the run it is compared to. */
const expectedFor = (script: string, home: string, path: string) => ({
  ...EXPECTED[script],
  HOME: home,
  PATH: path,
});

const GNU_STAT =
  Bun.spawnSync(["stat", "-c", "%u", "/"], { stdout: "pipe", stderr: "pipe" }).exitCode === 0;
const REPO_OPS = new URL("../ops/", import.meta.url).pathname;

/**
 * Lay out a temporary install root, home and bin directory, run the real wrapper
 * on `script` under `bash`, and return the stand-in `bun`'s environment.
 */
function runWholeWrapper(
  bash: string,
  script: string,
  extraInjected: Record<string, string> = {},
): { code: number; stderr: string; env: Record<string, string>; home: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), "collector-wrapper-"));
  try {
    const install = join(root, "install");
    const home = join(root, "home");
    const bin = join(root, "bin");
    mkdirSync(join(install, "scripts"), { recursive: true });
    mkdirSync(join(home, ".config", "infisical"), { recursive: true });
    mkdirSync(bin);
    for (const name of Object.keys(EXPECTED)) {
      writeFileSync(join(install, "scripts", name), "// stand-in\n");
    }
    const token = join(home, ".config", "infisical", "nemar-observability-egress.token");
    writeFileSync(token, "scoped-token");
    chmodSync(token, 0o600);

    // The script under test, with only its install root changed, beside its profile table.
    const source = readFileSync(join(REPO_OPS, "with-collector-secrets.sh"), "utf8");
    const rooted = source.replace(
      'INSTALL_ROOT="/opt/nemar-observability"',
      `INSTALL_ROOT="${install}"`,
    );
    if (rooted === source) {
      throw new Error("the wrapper no longer has the install root line this test edits");
    }
    const wrapper = join(root, "with-collector-secrets.sh");
    writeFileSync(wrapper, rooted);
    chmodSync(wrapper, 0o755);
    writeFileSync(
      join(root, "collector-profiles.sh"),
      readFileSync(join(REPO_OPS, "collector-profiles.sh"), "utf8"),
    );

    // The stand-in tools. `infisical run ... -- COMMAND` injects the variables its path holds.
    const injected = { ...INJECTED, ...extraInjected };
    const exports = Object.entries(injected)
      .map(([name, value]) => `export ${name}='${value}'`)
      .join("\n");
    writeFileSync(
      join(bin, "infisical"),
      `#!/usr/bin/env bash\nwhile [ "$1" != "--" ]; do shift; done\nshift\n${exports}\nexec "$@"\n`,
    );
    writeFileSync(join(bin, "bun"), `#!/bin/sh\nexec "${ENV_BIN}"\n`);
    if (!GNU_STAT) {
      writeFileSync(
        join(bin, "stat"),
        '#!/usr/bin/env bash\ncase "$2" in\n  %u) /usr/bin/stat -f %u "$4" ;;\n  %a) /usr/bin/stat -f %Lp "$4" ;;\nesac\n',
      );
    }
    for (const tool of ["infisical", "bun", "stat"]) {
      if (existsSync(join(bin, tool))) chmodSync(join(bin, tool), 0o755);
    }

    const path = `${bin}:/usr/bin:/bin`;
    const result = Bun.spawnSync([bash, wrapper, join(install, "scripts", script)], {
      env: {
        HOME: home,
        PATH: path,
        INFISICAL_CLI: join(bin, "infisical"),
        BUN_BIN: join(bin, "bun"),
        EGRESS_START_DATE: "2026-08-01",
        EGRESS_LOOKBACK_DAYS: "3",
        STATE_DIRECTORY: "/var/lib/nemar-observability-recordings",
        RECORDINGS_STATE_DIR: "/elsewhere",
        AWS_PROFILE: "inherited-profile",
        LD_PRELOAD: "/tmp/evil.so",
        UNRELATED: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const env: Record<string, string> = {};
    for (const line of result.stdout.toString().split("\n")) {
      const at = line.indexOf("=");
      if (at > 0 && !SHELL_NOISE.has(line.slice(0, at)))
        env[line.slice(0, at)] = line.slice(at + 1);
    }
    return { code: result.exitCode, stderr: result.stderr.toString(), env, home, path };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("the whole wrapper with stand-in external tools", () => {
  for (const bash of bashes) {
    for (const script of Object.keys(EXPECTED)) {
      test(`${script} under bash ${version(bash)}: the child's exact environment`, () => {
        const run = runWholeWrapper(bash, script);
        expect({ code: run.code, stderr: run.stderr }).toEqual({ code: 0, stderr: "" });
        expect(run.env).toEqual(expectedFor(script, run.home, run.path));
      });
    }
  }

  test("a secret nobody listed reaches the child: the known tokens and AWS keys are hidden, unknown ones are not", () => {
    // The pinned limitation. Switching to an allow-list would change what egress and storage
    // see and could not be checked on the host, so the lists are explicit and documented instead.
    const run = runWholeWrapper(bashes[0], "push-zarr-recordings.ts", {
      OBS_UNLISTED_SECRET: "surprise",
    });
    expect(run.code).toBe(0);
    expect(run.env.OBS_UNLISTED_SECRET).toBe("surprise");
    // while everything that was listed is still hidden
    expect(run.env.OBS_EGRESS_INGEST_TOKEN).toBeUndefined();
    expect(run.env.AWS_ACCESS_KEY_ID).toBeUndefined();
  });

  test("the wrapper stops, under its own tag, when a requirement is missing", () => {
    // No collector installed at the real root and no token file: it fails before running anything.
    const root = mkdtempSync(join(tmpdir(), "collector-wrapper-missing-"));
    try {
      const result = Bun.spawnSync(
        [
          bashes[0],
          join(REPO_OPS, "with-collector-secrets.sh"),
          "/opt/nemar-observability/scripts/push-s3-egress.ts",
        ],
        { env: { HOME: root, PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe" },
      );
      expect(result.exitCode).toBe(2);
      expect(result.stderr.toString()).toContain("[s3-egress] ERROR:");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
