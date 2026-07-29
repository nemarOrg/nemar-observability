// The write surface must stay at zero (#8).
//
// This Worker used to relay four admin mutations, authenticated by a long-lived
// `nm_...` token pasted into the page. All four are live in the website admin
// portal behind an HttpOnly, host-scoped, revocable session cookie, so they were
// removed: with no mutation route, an XSS or a spoof of dashboard.nemar.org can
// no longer be turned into a state change anywhere in NEMAR.
//
// These assertions are the guard rail. Deleting code is easy to undo by
// accident -- a future "just add a quick approve button" would otherwise sail
// through review.

import { describe, expect, test } from "bun:test";
import worker from "../src/index";
import type { Bindings } from "../src/types";

const env = {} as Bindings;
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

const call = (method: string, path: string) =>
  worker.fetch(
    new Request(`https://x${path}`, {
      method,
      headers: { Authorization: "Bearer nm_pretend_admin_token" },
      ...(method === "POST" ? { body: "{}" } : {}),
    }),
    env,
    ctx,
  );

describe("removed admin action relays", () => {
  const gone: [string, string][] = [
    ["POST", "/observability/api/actions/users/someone/approve"],
    ["DELETE", "/observability/api/actions/users/42"],
    ["POST", "/observability/api/actions/publish/nm000103/approve"],
    ["POST", "/observability/api/actions/publish/nm000103/deny"],
  ];

  for (const [method, path] of gone) {
    test(`${method} ${path} is not routed`, async () => {
      const res = await call(method, path);
      expect(res.status).toBe(404);
    });
  }

  // /me existed solely to owner-gate the delete button in the UI. With the
  // button gone it had no consumer -- verified nothing in website/ or
  // nemar-cli/ calls it -- so it went too.
  test("GET /me is not routed", async () => {
    expect((await call("GET", "/observability/api/me")).status).toBe(404);
  });
});

describe("surviving surface", () => {
  // Read-only drill-downs stay until the website grows equivalent
  // dataset-health lists (epic #12 phase 2). They still demand admin auth:
  // a 401 here, not a 404, is the proof they were kept deliberately.
  test("drilldown still exists and still requires auth", async () => {
    const res = await worker.fetch(
      new Request("https://x/observability/api/drilldown/archive.missing"),
      env,
      ctx,
    );
    expect(res.status).toBe(401);
  });

  // Proves the public routes survived the deletion without needing a binding:
  // /snapshot/history validates its query param and 400s before touching D1.
  test("the public snapshot routes are untouched by the removal", async () => {
    const res = await worker.fetch(
      new Request("https://x/observability/api/snapshot/history"),
      env,
      ctx,
    );
    expect(res.status).toBe(400);
  });
});
