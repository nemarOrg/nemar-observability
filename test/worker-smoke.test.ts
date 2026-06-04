// Boots the real worker (Hono app) and exercises the routes that don't touch
// D1: the health check and the server-rendered dashboard page. No mocks — real
// Request/Response through the actual router.

import { describe, expect, test } from "bun:test";
import worker from "../src/index";
import type { Bindings } from "../src/types";

const env = {} as Bindings; // health + page never read bindings
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

describe("worker routing", () => {
  test("health responds ok", async () => {
    const res = await worker.fetch(new Request("https://x/observability/health"), env, ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, service: "nemar-observability" });
  });

  test("serves the dashboard page", async () => {
    const res = await worker.fetch(new Request("https://x/observability"), env, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
    const html = await res.text();
    expect(html).toContain("NEMAR Observability");
    expect(html).toContain('id="sections"');
    expect(html).toContain('"/observability/api"');
  });

  test("bare root redirects to the dashboard", async () => {
    const res = await worker.fetch(new Request("https://x/"), env, ctx);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/observability");
  });
});
