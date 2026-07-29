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
import { renderDashboardPage } from "../src/routes/ui";
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

// The page itself must hold no credential (#8). This is the property that makes
// a phishing clone of dashboard.nemar.org pointless: there is nothing to steal
// and nothing to trigger. Asserted against the rendered HTML rather than the
// source, so it covers both the markup and the inlined client script.
describe("the dashboard page holds no credential", () => {
  const html = renderDashboardPage();

  for (const forbidden of [
    "localStorage", // where the pasted admin token used to live
    "Authorization", // no request from this page is ever authenticated
    "Bearer",
    "nemar_obs_key",
    "/actions/",
    "drilldown/", // the endpoint survives, but this page must not call it
  ]) {
    test(`does not reference ${forbidden}`, () => {
      expect(html).not.toContain(forbidden);
    });
  }

  test("still renders the snapshot and links out to the admin portal", () => {
    expect(html).toContain("/observability/api");
    expect(html).toContain('id="sections"');
    expect(html).toContain("https://app.nemar.org/admin");
  });

  // A cut inside the client-script template string can produce a page that
  // serves fine and throws in the browser, which no other test would catch.
  test("the inlined client script parses", () => {
    const js = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
    expect(js.length).toBeGreaterThan(0);
    expect(() => new Function(js)).not.toThrow();
  });
});
