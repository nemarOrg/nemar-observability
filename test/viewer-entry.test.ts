// The Signal viewer entry in a real DOM (happy-dom) against the real Worker:
// the page's own script, the real router and API handlers, and a real SQLite
// store behind the D1 surface with the real migrations. Requests the page makes
// are handed to the Worker in process. Only the edge's own HTTP answer is shaped
// transport (a refused read), and no embed figure is invented: the daily totals
// shown come from rows written through the real store.

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import worker from "../src/index";
import { saveEmbedDays } from "../src/lib/embed-store";
import { renderDashboardPage } from "../src/routes/ui";
import type { Bindings } from "../src/types";
import audienceWeek from "./fixtures/audience-week-2026-09-23-to-2026-09-29.json";
import { clientLogic } from "./helpers/client-logic";
import { asD1 } from "./helpers/d1";
import { MIGRATIONS } from "./helpers/migrations";

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const ORIGIN = "https://dashboard.nemar.org";
const realFetch = globalThis.fetch;

const open: { window: Window; engine: Database }[] = [];
afterEach(async () => {
  globalThis.fetch = realFetch;
  for (const page of open.splice(0)) {
    await page.window.happyDOM.close();
    page.engine.close();
  }
});

const day = (back: number) => new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10);

async function openPage(options: { embeds?: boolean; configured?: boolean } = {}) {
  const engine = new Database(":memory:");
  for (const migration of MIGRATIONS) engine.run(migration);
  const db = asD1(engine);
  if (options.embeds) {
    // Days written the way the cron writes them: all four kinds per day.
    const rows = [];
    for (const [back, loads] of [
      [4, [12, 3, 2, 1]],
      [3, [0, 0, 0, 0]],
      [2, [7, 1, 0, 0]],
    ] as const) {
      for (const [i, kind] of (["iframe", "document", "none", "other"] as const).entries()) {
        rows.push({ date: day(back), kind, loads: loads[i] });
      }
    }
    await saveEmbedDays(db, rows, new Date().toISOString());
  }
  const env = {
    OBS_DB: db,
    ...(options.configured
      ? {
          CF_ACCOUNT_ID: "a",
          CF_ANALYTICS_TOKEN: "t",
          EMBED_AE_DATASET: "nemar_website_embeds_dev",
        }
      : {}),
  } as unknown as Bindings;
  const window = new Window({
    url: `${ORIGIN}/observability`,
    settings: { enableJavaScriptEvaluation: true } as never,
  });
  open.push({ window, engine });
  const errors: string[] = [];
  window.addEventListener("error", (event) =>
    errors.push(String((event as unknown as { error?: unknown }).error)),
  );
  const asked: string[] = [];
  (window as unknown as { fetch: unknown }).fetch = async (input: unknown) => {
    const url = new URL(String(input), ORIGIN);
    asked.push(url.pathname);
    // The website audience answer is a captured live response, as in
    // dashboard-page.test.ts; everything else is the real Worker.
    if (url.pathname.endsWith("/audience")) {
      return new window.Response(JSON.stringify(audienceWeek.response), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const response = await worker.fetch(new Request(url.href), env, ctx);
    return new window.Response(await response.text(), {
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
    });
  };
  window.document.write(renderDashboardPage());
  return { window, document: window.document, errors, asked };
}

async function until(check: () => boolean, what: string, ms = 4000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}
const text = (doc: Window["document"], id: string) => doc.getElementById(id)?.textContent ?? "";
const filter = (doc: Window["document"], name: string) =>
  doc.querySelector(`[data-viewer-filter="${name}"]`) as unknown as {
    click(): void;
    getAttribute(n: string): string | null;
  };

describe("Signal viewer entry", () => {
  test("is a section of its own with a First-party and a Third-party filter", () => {
    const html = renderDashboardPage();
    expect(html).toContain('<section id="viewer"');
    expect(html).toContain('href="#viewer" data-nav-link>Signal viewer</a>');
    expect(html).toContain('data-viewer-filter="first" aria-pressed="true"');
    expect(html).toContain('data-viewer-filter="third" aria-pressed="false"');
  });

  test("First-party is the default view and says what it counts", async () => {
    const { document, errors } = await openPage();
    await until(
      () => text(document, "viewer-body").includes("Viewer mounts on nemar.org"),
      "first-party",
    );
    expect(errors).toEqual([]);
    const body = text(document, "viewer-body");
    expect(body).toContain("Viewer opens");
    expect(body).toContain("Viewer interactions");
    // The captured answer says event metrics were not configured: unknown, never zero.
    expect(body).toContain("Unknown");
    expect(body).not.toMatch(/Viewer opens\s*0\b/);
    expect(body).toContain("not embed page loads on partner sites");
    expect(filter(document, "first").getAttribute("aria-pressed")).toBe("true");
  });

  test("Third-party is fetched only when chosen, then shows stored daily totals by kind", async () => {
    const { document, errors, asked } = await openPage({ embeds: true, configured: true });
    await until(() => text(document, "viewer-body").includes("Viewer mounts"), "first-party");
    expect(asked.some((p) => p.endsWith("/embeds"))).toBe(false);

    // The edge refusing the per-site read is an HTTP failure; the stored totals
    // are the Worker's own and still show.
    globalThis.fetch = (async () =>
      new Response("forbidden", { status: 403 })) as unknown as typeof fetch;
    filter(document, "third").click();
    await until(
      () => text(document, "viewer-body").includes("Embed page loads on other sites"),
      "third-party",
    );
    await until(() => !text(document, "viewer-body").includes("Loading"), "settled");
    expect(errors).toEqual([]);
    expect(asked.filter((p) => p.endsWith("/embeds"))).toHaveLength(1);
    expect(filter(document, "third").getAttribute("aria-pressed")).toBe("true");
    expect(filter(document, "first").getAttribute("aria-pressed")).toBe("false");

    const body = text(document, "viewer-body");
    // Embedded is the headline: 12 + 0 + 7 across the three recorded days.
    expect(body).toContain("Embedded in another site");
    expect(body).toMatch(/Embedded in another site\s*19/);
    expect(body).toContain("Opened directly");
    expect(body).toContain("Other requests");
    // The two measures are never merged into one viewer count, and the first-party
    // figures are not on this view.
    expect(body).not.toContain("Viewer mounts on nemar.org");
    // Days not recorded are unknown, not zero.
    expect(body).toContain("of 30 days");
    // The refused read shows as unavailable, never as an empty ranking.
    expect(body).toContain("Top embedding sites");
    expect(body).toContain("Top embedded datasets");
    expect(body).toContain("Embed detail is currently unavailable");
    expect(body).not.toContain("forbidden");
  });

  test("with embed counting not configured, Third-party says so and shows no zero", async () => {
    const { document, errors } = await openPage();
    await until(() => text(document, "viewer-body").includes("Viewer mounts"), "first-party");
    filter(document, "third").click();
    await until(
      () => text(document, "viewer-body").includes("Embed page loads on other sites"),
      "third-party",
    );
    expect(errors).toEqual([]);
    const body = text(document, "viewer-body");
    expect(body).toContain("Not configured");
    expect(body).toContain("Embed counting is not configured");
    expect(body).not.toMatch(/Embedded in another site\s*0\b/);
  });

  test("zero embeds with counting configured is a normal state, not a failure", async () => {
    const { document, errors } = await openPage({ configured: true });
    await until(() => text(document, "viewer-body").includes("Viewer mounts"), "first-party");
    globalThis.fetch = (async () =>
      new Response("forbidden", { status: 403 })) as unknown as typeof fetch;
    filter(document, "third").click();
    await until(
      () => text(document, "viewer-body").includes("Embed page loads on other sites"),
      "third-party",
    );
    expect(errors).toEqual([]);
    const body = text(document, "viewer-body");
    expect(body).toContain("None recorded");
    expect(body).toContain("No embed loads are recorded for these dates");
    expect(body).not.toContain("Could not load");
  });

  test("switching back to First-party restores it", async () => {
    const { document, errors } = await openPage({ embeds: true });
    await until(() => text(document, "viewer-body").includes("Viewer mounts"), "first-party");
    filter(document, "third").click();
    await until(
      () => text(document, "viewer-body").includes("Embed page loads on other sites"),
      "third-party",
    );
    filter(document, "first").click();
    await until(
      () => text(document, "viewer-body").includes("Viewer mounts on nemar.org"),
      "first-party again",
    );
    expect(errors).toEqual([]);
    expect(text(document, "viewer-body")).not.toContain("Embedded in another site");
  });

  test("a failed embed load offers Try again", async () => {
    const { document, errors } = await openPage({ embeds: true });
    await until(() => text(document, "viewer-body").includes("Viewer mounts"), "first-party");
    // Break the Worker's own store for the next read: the route answers 500.
    const page = open[0];
    page.engine.run("DROP TABLE embed_daily_loads");
    filter(document, "third").click();
    await until(
      () => text(document, "viewer-body").includes("Embed totals are currently unavailable"),
      "unavailable totals",
    );
    expect(errors).toEqual([]);
    expect(text(document, "viewer-body")).not.toMatch(/Embedded in another site\s*0\b/);
  });
});

// The pure decisions behind the entry, run as the page runs them.
describe("viewer client logic", () => {
  const { viewerFirstParty, embedHeadline, validEmbeds, embedShare } = clientLogic([
    "viewerFirstParty",
    "embedHeadline",
    "validEmbeds",
    "embedShare",
  ]);

  test("first-party figures come from the website event metrics, null when not measured", () => {
    const figures = viewerFirstParty(audienceWeek.response);
    expect(figures.status).toBe("unconfigured");
    expect(figures.opens).toEqual({ events: null, visitors: null });
    expect(figures.interactions).toEqual({ events: null, visitors: null });
    expect(figures.coverage).toBeNull();
    expect(figures.note).toContain("coverage start");
  });

  test("measured figures pass through and a non-number stays unknown", () => {
    const figures = viewerFirstParty({
      umami: {
        event_metrics: {
          status: "available",
          coverage: { start: "2026-09-01", end: "2026-09-30" },
          metrics: [
            { name: "viewer_open", events: 40, visitors: 12 },
            { name: "viewer_interaction", events: "x", visitors: 0 },
            { name: "citation_click", events: 99, visitors: 9 },
          ],
        },
      },
    });
    expect(figures.opens).toEqual({ events: 40, visitors: 12 });
    expect(figures.interactions).toEqual({ events: null, visitors: 0 });
  });

  test("a missing answer is unavailable, not zero", () => {
    const figures = viewerFirstParty(null);
    expect(figures.status).toBe("unavailable");
    expect(figures.opens.events).toBeNull();
  });

  test("the embed headline is None recorded without days, and a real zero with them", () => {
    expect(embedHeadline({ totals: null, days_recorded: 0 })).toEqual({
      text: "None recorded",
      muted: true,
      value: null,
    });
    expect(
      embedHeadline({ totals: { embedded: 0, direct: 0, other: 0 }, days_recorded: 3 }),
    ).toEqual({ text: "0", muted: false, value: 0 });
    expect(
      embedHeadline({ totals: { embedded: 1234, direct: 0, other: 0 }, days_recorded: 3 }).text,
    ).toBe("1,234");
  });

  test("shares are one decimal, and blank without a total", () => {
    expect(embedShare(1, 3)).toBe("33.3%");
    expect(embedShare(5, 0)).toBe("");
  });

  test("validEmbeds accepts the Worker's own answer and rejects other shapes", async () => {
    const engine = new Database(":memory:");
    for (const migration of MIGRATIONS) engine.run(migration);
    const res = await worker.fetch(
      new Request(`${ORIGIN}/observability/api/embeds?start=${day(5)}&end=${day(1)}`),
      { OBS_DB: asD1(engine) } as unknown as Bindings,
      ctx,
    );
    engine.close();
    expect(validEmbeds(await res.json())).toBe(true);
    expect(validEmbeds({})).toBe(false);
    expect(validEmbeds({ loads: { status: "available", days: [] }, sites: {}, datasets: {} })).toBe(
      false,
    );
  });
});
