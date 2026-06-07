// Exercises the real admin relay routes end-to-end through the worker router.
// resolveAdmin and relayToNemar both cross the network boundary via the global
// fetch; we intercept ONLY that boundary (canned upstream Response objects +
// a call recorder) so we can assert the proxy's own logic: owner-gating before
// any upstream call, /me shape + no-store, and encodeURIComponent on path
// params. This is a network seam, not a mock of the code under test.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import worker from "../src/index";
import type { Bindings } from "../src/types";

const NEMAR_API_BASE = "https://api.nemar.test";
const env = { NEMAR_API_BASE } as unknown as Bindings;
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

// Tokens map to a role for the fake /users/me. Any other token => 401 upstream.
const ROLE_BY_TOKEN: Record<string, string | undefined> = {
  "owner-key": "owner",
  "admin-key": "admin",
  "user-key": "user", // not an admin role
};

type Call = { url: string; method: string; body: string | null; auth: string | null };
let calls: Call[] = [];
const realFetch = globalThis.fetch;

// Upstream responder: /users/me reflects the token's role; everything else is a
// canned 200 echoing the path so we can assert what the proxy forwarded.
function installFetch() {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    const auth =
      (init?.headers as Record<string, string> | undefined)?.Authorization ??
      (init?.headers as Record<string, string> | undefined)?.authorization ??
      null;
    const body = typeof init?.body === "string" ? init.body : null;
    calls.push({ url, method, body, auth });

    const token = /^Bearer\s+(.+)$/i.exec((auth ?? "").trim())?.[1]?.trim();

    if (url === `${NEMAR_API_BASE}/users/me`) {
      const role = token ? ROLE_BY_TOKEN[token] : undefined;
      if (!role) return new Response("unauthorized", { status: 401 });
      return new Response(JSON.stringify({ user: { username: token, role } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    // Any relayed admin endpoint: echo the path + method so tests can inspect.
    return new Response(JSON.stringify({ relayed: true, path: new URL(url).pathname, method }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

beforeEach(installFetch);
afterEach(() => {
  globalThis.fetch = realFetch;
});

function req(path: string, method: string, token?: string, jsonBody?: unknown): Request {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  const init: RequestInit = { method, headers };
  if (jsonBody !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(jsonBody);
  }
  return new Request(`https://x${path}`, init);
}

const upstreamCalls = () => calls.filter((c) => !c.url.endsWith("/users/me"));

describe("GET /me", () => {
  test("returns {username, role} + no-store for an admin", async () => {
    const res = await worker.fetch(req("/observability/api/me", "GET", "admin-key"), env, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ username: "admin-key", role: "admin" });
  });

  test("401 for a non-admin token", async () => {
    const res = await worker.fetch(req("/observability/api/me", "GET", "user-key"), env, ctx);
    expect(res.status).toBe(401);
  });

  test("401 when no bearer is present", async () => {
    const res = await worker.fetch(req("/observability/api/me", "GET"), env, ctx);
    expect(res.status).toBe(401);
  });
});

describe("DELETE /actions/users/:id owner gate", () => {
  test("403 for a non-owner admin WITHOUT hitting upstream delete", async () => {
    const res = await worker.fetch(
      req("/observability/api/actions/users/42", "DELETE", "admin-key"),
      env,
      ctx,
    );
    expect(res.status).toBe(403);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    // Only /users/me was called (the resolveAdmin check); no delete relay.
    expect(upstreamCalls()).toHaveLength(0);
  });

  test("401 for a non-admin token without any upstream delete", async () => {
    const res = await worker.fetch(
      req("/observability/api/actions/users/42", "DELETE", "user-key"),
      env,
      ctx,
    );
    expect(res.status).toBe(401);
    expect(upstreamCalls()).toHaveLength(0);
  });

  test("owner forwards to DELETE /admin/users/by-id/:id with the same bearer", async () => {
    const res = await worker.fetch(
      req("/observability/api/actions/users/42", "DELETE", "owner-key"),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const relay = upstreamCalls();
    expect(relay).toHaveLength(1);
    expect(relay[0].method).toBe("DELETE");
    expect(relay[0].url).toBe(`${NEMAR_API_BASE}/admin/users/by-id/42`);
    expect(relay[0].auth).toBe("Bearer owner-key"); // admin's own key forwarded
  });
});

describe("encodeURIComponent on path params", () => {
  test("a hostile :id with '/' and '..' lands URL-encoded in the upstream path", async () => {
    const res = await worker.fetch(
      req(
        `/observability/api/actions/users/${encodeURIComponent("../../evil")}`,
        "DELETE",
        "owner-key",
      ),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const relay = upstreamCalls();
    expect(relay).toHaveLength(1);
    // The encoded segment must NOT introduce extra path segments.
    expect(relay[0].url).toBe(`${NEMAR_API_BASE}/admin/users/by-id/..%2F..%2Fevil`);
  });

  test("a hostile :username for approve is encoded, no path traversal", async () => {
    const res = await worker.fetch(
      req(
        `/observability/api/actions/users/${encodeURIComponent("a/b")}/approve`,
        "POST",
        "admin-key",
      ),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const relay = upstreamCalls();
    expect(relay).toHaveLength(1);
    expect(relay[0].method).toBe("POST");
    expect(relay[0].url).toBe(`${NEMAR_API_BASE}/admin/approve/a%2Fb`);
  });
});

describe("publish relays", () => {
  test("deny forwards {reason} verbatim to /admin/publish/:id/deny", async () => {
    const res = await worker.fetch(
      req("/observability/api/actions/publish/nm000132/deny", "POST", "admin-key", {
        reason: "incomplete metadata",
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const relay = upstreamCalls();
    expect(relay).toHaveLength(1);
    expect(relay[0].url).toBe(`${NEMAR_API_BASE}/admin/publish/nm000132/deny`);
    expect(JSON.parse(relay[0].body ?? "{}")).toEqual({ reason: "incomplete metadata" });
  });

  test("deny with invalid JSON body returns 400 before relaying", async () => {
    const r = new Request("https://x/observability/api/actions/publish/nm000132/deny", {
      method: "POST",
      headers: { Authorization: "Bearer admin-key", "Content-Type": "application/json" },
      body: "{not json",
    });
    const res = await worker.fetch(r, env, ctx);
    expect(res.status).toBe(400);
    expect(upstreamCalls()).toHaveLength(0);
  });

  test("approve forwards the body verbatim to /admin/publish/:id/approve", async () => {
    const res = await worker.fetch(
      req("/observability/api/actions/publish/nm000132/approve", "POST", "admin-key", {
        resume: false,
        skip_ci_check: false,
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    const relay = upstreamCalls();
    expect(relay).toHaveLength(1);
    expect(relay[0].url).toBe(`${NEMAR_API_BASE}/admin/publish/nm000132/approve`);
    expect(JSON.parse(relay[0].body ?? "{}")).toEqual({ resume: false, skip_ci_check: false });
  });
});
