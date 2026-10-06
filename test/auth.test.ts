// resolveAdmin against a local HTTP server standing in for nemar-cli's
// GET /users/me, the one request the Worker makes of it. The cases are the
// statuses and faults the identity service can produce: a verdict on the token
// (admin, non-admin, 401, 403) versus the service being unable to give one
// (5xx, 429, a wrong base, a body that is not JSON, a hang).

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { IDENTITY_TIMEOUT_MS, resolveAdmin } from "../src/lib/auth";
import type { Bindings } from "../src/types";

let identity: ReturnType<typeof Bun.serve>;
let seen: string[] = [];
beforeAll(() => {
  identity = Bun.serve({
    port: 0,
    idleTimeout: 30,
    fetch(req) {
      const auth = req.headers.get("authorization") ?? "";
      seen.push(auth);
      switch (auth) {
        case "Bearer admin-key":
          return Response.json({ user: { username: "ada", role: "admin" } });
        case "Bearer owner-key":
          return Response.json({ user: { username: "olu", role: "owner" } });
        case "Bearer user-key":
          return Response.json({ user: { username: "bob", role: "user" } });
        case "Bearer no-role-key":
          return Response.json({ user: { username: "eve" } });
        case "Bearer wrapped-key":
          return Response.json({ data: { user: { username: "ada", role: "admin" } } });
        case "Bearer numeric-role-key":
          return Response.json({ user: { username: "ada", role: 1 } });
        case "Bearer viewer-key":
          return Response.json({ user: { username: "val", role: "viewer" } });
        case "Bearer stall-key":
          // Headers and the start of a body, then nothing: only the caller giving up ends it.
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"user":'));
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        case "Bearer expired-key":
          return new Response("no", { status: 401 });
        case "Bearer revoked-key":
          return new Response("no", { status: 403 });
        case "Bearer down-key":
          return new Response("upstream is down", { status: 503 });
        case "Bearer throttled-key":
          return new Response("slow down", { status: 429 });
        case "Bearer missing-key":
          return new Response("not here", { status: 404 });
        case "Bearer html-key":
          return new Response("<html>maintenance</html>", {
            headers: { "content-type": "text/html" },
          });
        case "Bearer hang-key":
          // Never answers: only the caller giving up ends this request.
          return new Promise<Response>((resolve) =>
            req.signal.addEventListener("abort", () =>
              resolve(new Response(null, { status: 499 })),
            ),
          );
        default:
          return new Response("no", { status: 401 });
      }
    },
  });
});
afterAll(() => identity.stop(true));
beforeEach(() => {
  seen = [];
});

const env = () => ({ NEMAR_API_BASE: `http://localhost:${identity.port}` }) as unknown as Bindings;
const quiet = () => {
  const real = console.error;
  const lines: string[] = [];
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  return {
    lines,
    restore: () => {
      console.error = real;
    },
  };
};

describe("resolveAdmin: a verdict on the token", () => {
  test("an admin and an owner are admins", async () => {
    expect(await resolveAdmin(env(), "Bearer admin-key")).toEqual({
      status: "admin",
      admin: { username: "ada", role: "admin" },
    });
    expect(await resolveAdmin(env(), "bearer owner-key")).toEqual({
      status: "admin",
      admin: { username: "olu", role: "owner" },
    });
  });

  test("a non-admin, an unknown role, an expired and a revoked token are denied, without a log", async () => {
    const log = quiet();
    try {
      for (const header of [
        "Bearer user-key",
        "Bearer viewer-key",
        "Bearer expired-key",
        "Bearer revoked-key",
      ]) {
        expect(await resolveAdmin(env(), header)).toEqual({ status: "denied" });
      }
    } finally {
      log.restore();
    }
    expect(log.lines).toEqual([]);
  });

  test("a missing or malformed header is denied without asking nemar-cli", async () => {
    for (const header of [null, "", "Basic abc", "Bearer ", "Bearer    "]) {
      expect(await resolveAdmin(env(), header)).toEqual({ status: "denied" });
    }
    expect(seen).toEqual([]);
  });
});

describe("resolveAdmin: the identity service could not say", () => {
  test("a 503, a 429 and a 404 are unavailable and logged with the status, never the token", async () => {
    const log = quiet();
    try {
      for (const [header, status] of [
        ["Bearer down-key", "503"],
        ["Bearer throttled-key", "429"],
        ["Bearer missing-key", "404"],
      ] as const) {
        expect(await resolveAdmin(env(), header)).toEqual({ status: "unavailable" });
        expect(log.lines.at(-1)).toContain(status);
      }
    } finally {
      log.restore();
    }
    expect(log.lines).toHaveLength(3);
    // Neither the token nor what the service said in its body reaches a log line.
    for (const line of log.lines) {
      for (const leak of ["-key", "upstream is down", "slow down", "not here"]) {
        expect(line).not.toContain(leak);
      }
    }
  });

  test("a 200 that is not JSON is unavailable, and the log carries none of the body", async () => {
    const log = quiet();
    try {
      expect(await resolveAdmin(env(), "Bearer html-key")).toEqual({ status: "unavailable" });
    } finally {
      log.restore();
    }
    expect(log.lines).toHaveLength(1);
    expect(log.lines[0]).toContain("not JSON");
    for (const leak of ["html", "maintenance", "-key"]) expect(log.lines[0]).not.toContain(leak);
  });

  test("a 200 whose body stalls after the headers is unavailable, and says it timed out", async () => {
    const log = quiet();
    const started = Date.now();
    try {
      expect(await resolveAdmin(env(), "Bearer stall-key", 150)).toEqual({ status: "unavailable" });
    } finally {
      log.restore();
    }
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(log.lines).toHaveLength(1);
    expect(log.lines[0]).toContain("did not arrive in time");
    expect(log.lines[0]).not.toContain("not JSON");
  });

  test("JSON without a user and a string role is unavailable and logged, never a silent denial", async () => {
    const log = quiet();
    try {
      for (const header of [
        "Bearer no-role-key",
        "Bearer wrapped-key",
        "Bearer numeric-role-key",
      ]) {
        expect(await resolveAdmin(env(), header)).toEqual({ status: "unavailable" });
      }
    } finally {
      log.restore();
    }
    expect(log.lines).toHaveLength(3);
    for (const line of log.lines) {
      expect(line).toContain("shape changed");
      expect(line).not.toContain("-key");
    }
  });

  test("a server that never answers is unavailable once the timeout passes", async () => {
    const log = quiet();
    const started = Date.now();
    try {
      expect(await resolveAdmin(env(), "Bearer hang-key", 150)).toEqual({ status: "unavailable" });
    } finally {
      log.restore();
    }
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(100);
    expect(took).toBeLessThan(2_000);
    expect(log.lines[0]).toContain("unreachable");
    expect(log.lines.join(" ")).not.toContain("-key");
  });

  test("the default timeout is five seconds", () => {
    expect(IDENTITY_TIMEOUT_MS).toBe(5_000);
  });

  test("an unreachable server is unavailable", async () => {
    const dead = Bun.serve({ port: 0, fetch: () => new Response("x") });
    const base = `http://localhost:${dead.port}`;
    dead.stop(true);
    const log = quiet();
    try {
      expect(
        await resolveAdmin({ NEMAR_API_BASE: base } as unknown as Bindings, "Bearer admin-key"),
      ).toEqual({ status: "unavailable" });
    } finally {
      log.restore();
    }
    expect(log.lines[0]).toContain("unreachable");
    expect(log.lines.join(" ")).not.toContain("-key");
  });
});
