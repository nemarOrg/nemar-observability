// Runs the real ops/with-collector-secrets.sh under bash. These cases stop
// before any secret is read, so they are safe anywhere bash exists.
//
// Not covered here: that Infisical injects the shared AWS key, that each child
// loses the other collector's ingest token, and that the Infisical token stays
// out of every argv. Those steps need the installed checkout under
// /opt/nemar-observability, the real Infisical CLI, and the scoped token file
// (with GNU stat), which exist only on nemaring; a stand-in CLI would be a stub.

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";

const WRAPPER = new URL("../ops/with-collector-secrets.sh", import.meta.url).pathname;
const BASH = Bun.which("bash");
const INSTALLED_STORAGE = "/opt/nemar-observability/scripts/push-s3-storage.ts";

function run(...args: string[]) {
  if (!BASH) throw new Error("bash is required");
  const result = Bun.spawnSync([BASH, WRAPPER, ...args], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/nonexistent-home" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: result.exitCode, stderr: result.stderr.toString() };
}

describe.skipIf(!BASH)("collector secrets wrapper", () => {
  test("requires exactly one collector path", () => {
    expect(run()).toMatchObject({ code: 2 });
    expect(run().stderr).toContain("usage:");
    expect(run(INSTALLED_STORAGE, INSTALLED_STORAGE).code).toBe(2);
  });

  test("runs only the two installed collectors", () => {
    for (const path of [
      "/tmp/push-s3-storage.ts",
      "/opt/nemar-observability/scripts/../scripts/push-s3-storage.ts",
      "/opt/nemar-observability/scripts/push-s3-storage.ts.bak",
      "/opt/nemar-observability/scripts/check-health.ts",
    ]) {
      const result = run(path);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("[s3-collector] ERROR: collector path must be");
    }
  });

  test.skipIf(existsSync(INSTALLED_STORAGE))(
    "an allowlisted collector that is not installed stops before reading secrets",
    () => {
      const result = run(INSTALLED_STORAGE);
      expect(result.code).toBe(2);
      expect(result.stderr).toBe("[s3-storage] ERROR: collector script is not readable\n");
    },
  );
});
