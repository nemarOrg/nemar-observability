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

  test("root serves the dashboard hub listing both dashboards", async () => {
    const res = await worker.fetch(new Request("https://x/"), env, ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
    const html = await res.text();
    expect(html).toContain("NEMAR Dashboards");
    expect(html).toContain('href="/observability"');
    expect(html).toContain('href="/citations"');
  });
});

// The section-ingest guards reject before any D1 access, so they are testable
// with only the OBS_INGEST_TOKEN var set (no binding / no mocks).
describe("section ingest guards", () => {
  const ingestEnv = { OBS_INGEST_TOKEN: "secret-token" } as unknown as Bindings;
  const post = (path: string, headers: Record<string, string> = {}, bodyKey = "qa") =>
    worker.fetch(
      new Request(`https://x${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({
          key: bodyKey,
          label: "QA",
          source: "qa",
          metrics: [{ key: "qa.x", label: "X", value: 1 }],
        }),
      }),
      ingestEnv,
      ctx,
    );

  test("503 when ingest is not configured", async () => {
    const res = await worker.fetch(
      new Request("https://x/observability/api/sections/qa", { method: "POST", body: "{}" }),
      {} as Bindings,
      ctx,
    );
    expect(res.status).toBe(503);
  });

  test("401 on a wrong bearer token", async () => {
    const res = await post("/observability/api/sections/qa", { Authorization: "Bearer wrong" });
    expect(res.status).toBe(401);
  });

  test("409 when shadowing a built-in section key", async () => {
    const res = await post(
      "/observability/api/sections/datasets",
      { Authorization: "Bearer secret-token" },
      "datasets",
    );
    expect(res.status).toBe(409);
  });
});
