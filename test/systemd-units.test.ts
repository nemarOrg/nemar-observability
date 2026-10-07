// Conventions the nemaring unit files must keep, checked on the files
// themselves: every collector service is installed by ops/install-units.sh, runs
// through the secrets wrapper on a script the wrapper allows, and no two timers
// fire at the same time of day. `systemd-analyze verify` (run by install-units.sh
// on the host) is the authority on syntax; it does not exist on the machines
// that run these tests.

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";

const OPS = new URL("../ops/", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, OPS), "utf8");
const units = readdirSync(new URL("systemd/", OPS)).sort();
const installer = read("install-units.sh");
const wrapper = read("with-collector-secrets.sh");

const collectors = ["egress", "storage", "recordings"] as const;
const setting = (unit: string, key: string): string[] =>
  read(`systemd/${unit}`)
    .split("\n")
    .filter((line) => line.startsWith(`${key}=`))
    .map((line) => line.slice(key.length + 1));

describe("collector units", () => {
  test("each collector has a service and a timer, and the installer lists and enables them", () => {
    for (const name of collectors) {
      expect(units).toContain(`nemar-observability-${name}.service`);
      expect(units).toContain(`nemar-observability-${name}.timer`);
      expect(installer).toContain(`nemar-observability-${name}.service`);
      expect(installer.match(new RegExp(`nemar-observability-${name}\\.timer`, "g"))?.length).toBe(
        2,
      );
    }
    expect(units).toContain("nemar-observability-update.service");
  });

  test("each service runs its script through the wrapper, which allows that script", () => {
    const scripts = {
      egress: "push-s3-egress.ts",
      storage: "push-s3-storage.ts",
      recordings: "push-zarr-recordings.ts",
    };
    for (const name of collectors) {
      const [exec] = setting(`nemar-observability-${name}.service`, "ExecStart");
      expect(exec).toBe(
        `/opt/nemar-observability/ops/with-collector-secrets.sh /opt/nemar-observability/scripts/${scripts[name]}`,
      );
      expect(wrapper).toContain(`"$INSTALL_ROOT/scripts/${scripts[name]}")`);
      expect(setting(`nemar-observability-${name}.service`, "Wants")[0]).toContain(
        "nemar-observability-update.service",
      );
    }
  });

  test("the recordings service has a writable state directory the wrapper passes through", () => {
    const service = "nemar-observability-recordings.service";
    expect(setting(service, "StateDirectory")).toEqual(["nemar-observability-recordings"]);
    expect(setting(service, "ProtectSystem")).toEqual(["strict"]);
    expect(setting(service, "MemoryMax")).toEqual(["1G"]);
    expect(wrapper).toMatch(/STATE_DIRECTORY\) ;;/);
    // The egress and storage services declare none, so nothing can write there.
    expect(setting("nemar-observability-egress.service", "StateDirectory")).toEqual([]);
    expect(setting("nemar-observability-storage.service", "StateDirectory")).toEqual([]);
  });

  test("every collector service keeps the shared hardening", () => {
    for (const name of collectors) {
      const unit = `nemar-observability-${name}.service`;
      for (const [key, value] of [
        ["NoNewPrivileges", "true"],
        ["PrivateTmp", "true"],
        ["ProtectSystem", "strict"],
        ["ProtectHome", "read-only"],
        ["User", "yahya"],
      ]) {
        expect({ unit, key, value: setting(unit, key)[0] }).toEqual({ unit, key, value });
      }
    }
  });

  test("the recordings timer runs once a day, away from the other collectors", () => {
    const times = (unit: string) => setting(unit, "OnCalendar");
    expect(times("nemar-observability-recordings.timer")).toEqual(["*-*-* 06:20:00 UTC"]);
    expect(times("nemar-observability-egress.timer")).toEqual(["*-*-* *:15:00 UTC"]);
    expect(times("nemar-observability-storage.timer")).toEqual([
      "*-*-* 08:45:00 UTC",
      "*-*-* 14:45:00 UTC",
    ]);
    // The snapshot cron runs at :47; the recordings run starts at :20 plus under 2 minutes.
    expect(setting("nemar-observability-recordings.timer", "RandomizedDelaySec")).toEqual(["2m"]);
    expect(setting("nemar-observability-recordings.timer", "Persistent")).toEqual(["true"]);
  });

  test("the wrapper hides each collector's token from the others, and the AWS key from recordings", () => {
    const section = (script: string) =>
      wrapper.slice(wrapper.indexOf(`"$INSTALL_ROOT/scripts/${script}")`)).split(";;")[0];
    expect(section("push-s3-egress.ts")).toContain("OBS_STORAGE_INGEST_TOKEN");
    expect(section("push-s3-egress.ts")).toContain("OBS_RECORDINGS_INGEST_TOKEN");
    expect(section("push-s3-storage.ts")).toContain("OBS_EGRESS_INGEST_TOKEN");
    expect(section("push-s3-storage.ts")).toContain("OBS_RECORDINGS_INGEST_TOKEN");
    const recordings = section("push-zarr-recordings.ts");
    for (const name of [
      "OBS_EGRESS_INGEST_TOKEN",
      "OBS_STORAGE_INGEST_TOKEN",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_REGION",
    ]) {
      expect(recordings).toContain(name);
    }
    expect(recordings).not.toContain("OBS_RECORDINGS_INGEST_TOKEN");
  });
});
