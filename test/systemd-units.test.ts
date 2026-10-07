// Conventions the nemaring unit files must keep, checked on the files
// themselves: every collector service is installed by ops/install-units.sh, runs
// through the secrets wrapper on a script the wrapper allows, no two timers can
// fire in the same moment, and the recordings unit carries exactly the settings
// that were reviewed. `systemd-analyze verify` (run by install-units.sh on the
// host) is the authority on syntax; it does not exist on the machines that run
// these tests.

import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { EXPECTED_SECTION_MAX_AGE_MS } from "../src/lib/freshness";

const OPS = new URL("../ops/", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, OPS), "utf8");
const units = readdirSync(new URL("systemd/", OPS)).sort();
const installer = read("install-units.sh");
const wrapper = read("with-collector-secrets.sh");
const profiles = read("collector-profiles.sh");

const collectors = ["egress", "storage", "recordings"] as const;

/** A unit file as { section: { key: [values...] } }; a repeated key keeps every value. */
function parseUnit(unit: string): Record<string, Record<string, string[]>> {
  const sections: Record<string, Record<string, string[]>> = {};
  let current = "";
  for (const line of read(`systemd/${unit}`).split("\n")) {
    const header = /^\[(\w+)\]$/.exec(line);
    if (header) {
      current = header[1];
      sections[current] = {};
      continue;
    }
    const pair = /^(\w+)=(.*)$/.exec(line);
    if (pair && current) {
      sections[current][pair[1]] = [...(sections[current][pair[1]] ?? []), pair[2]];
    }
  }
  return sections;
}
const setting = (unit: string, section: string, key: string): string[] =>
  parseUnit(unit)[section]?.[key] ?? [];

/** Seconds in a systemd time span such as "2m", "55min", "5h", "1G" handled elsewhere. */
function seconds(span: string): number {
  const match = /^(\d+)\s*(s|m|min|h)$/.exec(span);
  if (!match) throw new Error(`unrecognized time span ${span}`);
  return Number(match[1]) * { s: 1, m: 60, min: 60, h: 3600 }[match[2] as "s" | "m" | "min" | "h"];
}
const bytes = (size: string): number => {
  const match = /^(\d+)([MG])$/.exec(size);
  if (!match) throw new Error(`unrecognized size ${size}`);
  return Number(match[1]) * (match[2] === "G" ? 1024 ** 3 : 1024 ** 2);
};

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

  // A collector shipped unjudged once (recordings, until the health table named it).
  // The unit directory is the list of collectors on this host: each timer is one,
  // and its section key is its name. The Umami pusher lives in the nemar-umami repo.
  test("every collector timer is judged by /health, and only the Umami pusher besides", () => {
    const timers = units
      .filter((unit) => unit.endsWith(".timer"))
      .map((unit) => unit.replace(/^nemar-observability-/, "").replace(/\.timer$/, ""));
    expect([...timers].sort()).toEqual([...collectors].sort());
    expect(Object.keys(EXPECTED_SECTION_MAX_AGE_MS).sort()).toEqual([...timers, "website"].sort());
  });

  test("each timer starts its own service", () => {
    for (const name of collectors) {
      expect(setting(`nemar-observability-${name}.timer`, "Timer", "Unit")).toEqual([
        `nemar-observability-${name}.service`,
      ]);
      expect(setting(`nemar-observability-${name}.timer`, "Install", "WantedBy")).toEqual([
        "timers.target",
      ]);
    }
  });

  test("each service runs its script through the wrapper, which allows that script", () => {
    const scripts = {
      egress: "push-s3-egress.ts",
      storage: "push-s3-storage.ts",
      recordings: "push-zarr-recordings.ts",
    };
    for (const name of collectors) {
      const unit = `nemar-observability-${name}.service`;
      expect(setting(unit, "Service", "ExecStart")).toEqual([
        `/opt/nemar-observability/ops/with-collector-secrets.sh /opt/nemar-observability/scripts/${scripts[name]}`,
      ]);
      expect(profiles).toContain(`${scripts[name]})`);
      expect(setting(unit, "Unit", "Wants")[0]).toContain("nemar-observability-update.service");
    }
    expect(wrapper).toContain("collector-profiles.sh");
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
        expect({ unit, key, value: setting(unit, "Service", key)[0] }).toEqual({
          unit,
          key,
          value,
        });
      }
    }
  });
});

describe("the recordings unit", () => {
  const service = "nemar-observability-recordings.service";
  const timer = "nemar-observability-recordings.timer";

  test("carries exactly the reviewed settings, so nothing untested on the host slips in", () => {
    const sections = parseUnit(service);
    const flat = (section: string) =>
      Object.fromEntries(
        Object.entries(sections[section]).map(([key, values]) => [key, values.join("|")]),
      );
    expect(Object.keys(sections)).toEqual(["Unit", "Service"]);
    expect(flat("Unit")).toEqual({
      Description:
        "Collect recorded hours by channel count from the NEMAR Zarr indexes for observability",
      Wants: "network-online.target nemar-observability-update.service",
      After: "network-online.target nemar-observability-update.service",
      StartLimitIntervalSec: "5h",
      StartLimitBurst: "3",
    });
    expect(flat("Service")).toEqual({
      Type: "oneshot",
      User: "yahya",
      Group: "yahya",
      Environment:
        "HOME=/home/yahya|PATH=/home/yahya/.local/bin:/home/yahya/.bun/bin:/usr/local/bin:/usr/bin:/bin",
      WorkingDirectory: "/opt/nemar-observability",
      Restart: "on-failure",
      RestartSec: "55min",
      TimeoutStartSec: "45min",
      StateDirectory: "nemar-observability-recordings",
      StateDirectoryMode: "0700",
      MemoryHigh: "768M",
      MemoryMax: "1G",
      ExecStart:
        "/opt/nemar-observability/ops/with-collector-secrets.sh /opt/nemar-observability/scripts/push-zarr-recordings.ts",
      NoNewPrivileges: "true",
      PrivateTmp: "true",
      ProtectSystem: "strict",
      ProtectHome: "read-only",
      ProtectKernelTunables: "true",
      ProtectKernelModules: "true",
      ProtectControlGroups: "true",
      LockPersonality: "true",
      RestrictSUIDSGID: "true",
      RestrictAddressFamilies: "AF_UNIX AF_INET AF_INET6",
      CapabilityBoundingSet: "",
      RestrictNamespaces: "true",
      SystemCallArchitectures: "native",
    });
    // Reviewed and deliberately left out: this unit has never run on the host.
    expect(read(`systemd/${service}`)).not.toMatch(/^PrivateDevices=/m);
  });

  test("memory is capped below the hard limit first, and a retry loop cannot run away", () => {
    expect(bytes(setting(service, "Service", "MemoryHigh")[0])).toBeLessThan(
      bytes(setting(service, "Service", "MemoryMax")[0]),
    );
    expect(setting(service, "Service", "Restart")).toEqual(["on-failure"]);
    expect(setting(service, "Unit", "StartLimitBurst")).toEqual(["3"]);
    // The start-limit window closes before the next timer slot, six hours on.
    expect(seconds(setting(service, "Unit", "StartLimitIntervalSec")[0])).toBeLessThan(6 * 3600);
  });

  test("the run timeout covers a healthy slow run: 5 minutes of catalog waits plus the largest read", () => {
    const timeout = seconds(setting(service, "Service", "TimeoutStartSec")[0]);
    const catalogWait = 5 * 60;
    const deadlinePerIndex = 15 * 60; // ReadOptions.deadlineMs
    const wholeCatalogAtTheSlowestAcceptedRate = (500 / 308) * deadlinePerIndex;
    expect(timeout).toBeGreaterThanOrEqual(
      1.4 * (catalogWait + wholeCatalogAtTheSlowestAcceptedRate),
    );
    expect(timeout).toBeGreaterThan(deadlinePerIndex + catalogWait);
  });

  test("three slots a day, six hours apart, all after the nemar-db export window", () => {
    const slots = setting(timer, "Timer", "OnCalendar");
    expect(slots).toEqual(["*-*-* 06:50:00 UTC", "*-*-* 12:50:00 UTC", "*-*-* 18:50:00 UTC"]);
    expect(setting(timer, "Timer", "Persistent")).toEqual(["true"]);
    for (const slot of slots) {
      const minute = Number(/ \d\d:(\d\d):00 UTC$/.exec(slot)?.[1]);
      expect(minute).toBeGreaterThan(40); // the hourly export lands between about :10 and :40
    }
    // A retry begins RestartSec after the failure, which is just after the slot, so it
    // is also after :40 of some hour.
    const retryMinute = (50 + seconds(setting(service, "Service", "RestartSec")[0]) / 60) % 60;
    expect(retryMinute).toBeGreaterThan(40);
  });
});

describe("no two timers fire in the same moment", () => {
  // Each timer's start times as minutes of the UTC day, and how long after one a run
  // may actually begin (the randomized delay plus the accuracy window).
  function starts(timerUnit: string): { minutes: number[]; spread: number } {
    const spread =
      (seconds(setting(timerUnit, "Timer", "RandomizedDelaySec")[0] ?? "0s") +
        seconds(setting(timerUnit, "Timer", "AccuracySec")[0] ?? "0s")) /
      60;
    const minutes: number[] = [];
    for (const spec of setting(timerUnit, "Timer", "OnCalendar")) {
      const [, hour, minute] = /^\*-\*-\* (\*|\d\d):(\d\d):00 UTC$/.exec(spec) ?? [];
      const hours = hour === "*" ? Array.from({ length: 24 }, (_, h) => h) : [Number(hour)];
      for (const h of hours) minutes.push(h * 60 + Number(minute));
    }
    return { minutes, spread };
  }

  const timers = collectors.map((name) => ({
    name,
    ...starts(`nemar-observability-${name}.timer`),
  }));
  const wrangler = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  const cronMinute = Number(/crons\s*=\s*\["(\d+) \* \* \* \*"\]/.exec(wrangler)?.[1]);

  test("the table covers all three collectors and the snapshot cron", () => {
    expect(timers.map((t) => t.minutes.length)).toEqual([24, 2, 3]);
    expect(cronMinute).toBe(47);
  });

  test("their start windows never overlap", () => {
    for (let i = 0; i < timers.length; i += 1) {
      for (let j = i + 1; j < timers.length; j += 1) {
        for (const a of timers[i].minutes) {
          for (const b of timers[j].minutes) {
            // A run may begin anywhere in [start, start + spread]; the windows overlap
            // when each start is within the other's spread (wrapping at midnight).
            const gap = Math.min((a - b + 1440) % 1440, (b - a + 1440) % 1440);
            const reach = timers[i].spread + timers[j].spread;
            expect({
              pair: `${timers[i].name} ${a} / ${timers[j].name} ${b}`,
              clear: gap > reach,
            }).toEqual({ pair: `${timers[i].name} ${a} / ${timers[j].name} ${b}`, clear: true });
          }
        }
      }
    }
  });

  test("no recordings run starts in the minute of the Worker's snapshot cron", () => {
    // Only this collector: the storage timer's 08:45 and 14:45 slots (older than
    // this change) already reach :47 with their randomized delay.
    for (const timer of timers.filter((t) => t.name === "recordings")) {
      for (const start of timer.minutes) {
        const minuteOfHour = start % 60;
        const within = minuteOfHour <= cronMinute && cronMinute <= minuteOfHour + timer.spread;
        expect({ timer: timer.name, start, within }).toEqual({
          timer: timer.name,
          start,
          within: false,
        });
      }
    }
  });
});

describe("the wrapper hides secrets from the child that does not own them", () => {
  test("a table in one sourced file drives the lists", () => {
    expect(profiles).toContain("COLLECTOR_INGEST_TOKENS");
    for (const token of [
      "OBS_EGRESS_INGEST_TOKEN",
      "OBS_STORAGE_INGEST_TOKEN",
      "OBS_RECORDINGS_INGEST_TOKEN",
    ]) {
      expect(profiles).toContain(token);
      // and nowhere else: the wrapper itself names none of them
      expect(wrapper).not.toContain(token);
    }
    expect(profiles).toContain("STATE_DIRECTORY");
  });
});
