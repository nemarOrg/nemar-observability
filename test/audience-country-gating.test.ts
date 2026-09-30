// Website country data is limited to ONE completed UTC day: distinct sessions
// are never summed across days, and range-overlap differences could expose
// suppressed small cells. The server derives that scope from its own clock, so a
// client cannot ask for more. This runs the real /audience route against a real
// local HTTP server standing in for Umami and counts the country queries it
// actually receives.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import worker from "../src/index";
import { resetUmamiLivenessCache } from "../src/lib/umami";
import type { Bindings } from "../src/types";

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const day = (offset: number) =>
  new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

let server: ReturnType<typeof Bun.serve>;
let countryQueries: { startAt: string; endAt: string }[] = [];
let statsQueries = 0;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.endsWith("/daterange")) {
        // Umami has data from long ago up to this moment.
        return Response.json({ startAt: Date.parse("2026-01-01T00:00:00Z"), endAt: Date.now() });
      }
      if (url.pathname.endsWith("/stats")) {
        statsQueries++;
        return Response.json({ visitors: 40, visits: 44, pageviews: 90 });
      }
      if (url.pathname.endsWith("/metrics") && url.searchParams.get("type") === "country") {
        countryQueries.push({
          startAt: url.searchParams.get("startAt") ?? "",
          endAt: url.searchParams.get("endAt") ?? "",
        });
        return Response.json([
          { x: "US", y: 25 },
          { x: "DE", y: 15 },
        ]);
      }
      return new Response("not found", { status: 404 });
    },
  });
});
afterAll(() => server.stop(true));
beforeEach(() => {
  countryQueries = [];
  statsQueries = 0;
  resetUmamiLivenessCache();
});

async function audience(start: string, end: string) {
  const env = {
    UMAMI_BASE_URL: `http://localhost:${server.port}`,
    UMAMI_WEBSITE_ID: "site-1",
    UMAMI_API_KEY: "key-1",
  } as unknown as Bindings;
  const res = await worker.fetch(
    new Request(`https://x/observability/api/audience?start=${start}&end=${end}`),
    env,
    ctx,
  );
  expect(res.status).toBe(200);
  return (await res.json()) as {
    country_breakdown_scope: string;
    umami: { visitors: number | null; countries: { label: string; value: number }[] };
  };
}

describe("website country data is one completed UTC day only", () => {
  test("yesterday, one completed day: one country query, countries returned", async () => {
    const body = await audience(day(-1), day(-1));
    expect(body.country_breakdown_scope).toBe("single_completed_day");
    expect(countryQueries).toHaveLength(1);
    expect(body.umami.countries.length).toBeGreaterThan(0);
  });

  test("a week ending yesterday: totals but no country query and no countries", async () => {
    const body = await audience(day(-7), day(-1));
    expect(body.country_breakdown_scope).toBe("multi_day");
    expect(statsQueries).toBe(1);
    expect(countryQueries).toEqual([]);
    expect(body.umami.countries).toEqual([]);
    expect(body.umami.visitors).toBe(40);
  });

  test("today alone, still in progress: no country query", async () => {
    const body = await audience(day(0), day(0));
    expect(body.country_breakdown_scope).toBe("in_progress_day");
    expect(countryQueries).toEqual([]);
    expect(body.umami.countries).toEqual([]);
  });

  test("a week that ends today: no country query", async () => {
    const body = await audience(day(-6), day(0));
    expect(body.country_breakdown_scope).toBe("multi_day");
    expect(countryQueries).toEqual([]);
    expect(body.umami.countries).toEqual([]);
  });

  test("a future day: no country query", async () => {
    const body = await audience(day(2), day(2));
    expect(body.country_breakdown_scope).toBe("future_day");
    expect(countryQueries).toEqual([]);
  });

  test("the one country query covers exactly that UTC day", async () => {
    await audience(day(-3), day(-3));
    const [query] = countryQueries;
    expect(new Date(Number(query.startAt)).toISOString()).toBe(`${day(-3)}T00:00:00.000Z`);
    expect(new Date(Number(query.endAt)).toISOString()).toBe(`${day(-3)}T23:59:59.999Z`);
  });
});
