// The Signal viewer entry in a real DOM (happy-dom) against the real Worker: the
// page's own script, the real router and API handlers, and a real SQLite store
// behind the D1 surface with the real migrations. Requests the page makes are
// handed to the Worker in process. Where an external service is involved the
// answer is a live capture (the website audience answer, the Analytics Engine
// answers in test/helpers/ae-fixtures, a real /embeds answer from the dev Worker)
// or a refused read; the daily totals shown come from rows written through the
// real store.

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import worker from "../src/index";
import { resetEmbedListsMemo } from "../src/lib/embed-lists";
import { recordEmbedSync, saveEmbedDays } from "../src/lib/embed-store";
import { renderDashboardPage } from "../src/routes/ui";
import type { Bindings } from "../src/types";
import audienceWeek from "./fixtures/audience-week-2026-09-23-to-2026-09-29.json";
import embedsCapture from "./fixtures/embeds-api-2026-09-06-to-2026-10-05.json";
import { type AeStub, stubAe } from "./helpers/ae-fixtures";
import { clientLogic } from "./helpers/client-logic";
import { asD1 } from "./helpers/d1";
import { MIGRATIONS } from "./helpers/migrations";

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const ORIGIN = "https://dashboard.nemar.org";

const open: { window: Window; engine: Database; catalog: Database }[] = [];
let ae: AeStub | null = null;
afterEach(async () => {
  ae?.restore();
  ae = null;
  resetEmbedListsMemo();
  for (const page of open.splice(0)) {
    await page.window.happyDOM.close();
    page.engine.close();
    page.catalog.close();
  }
});

const day = (back: number) => new Date(Date.now() - back * 86_400_000).toISOString().slice(0, 10);

interface PageOptions {
  /** Seed the stored daily totals the way the cron writes them, matching the captured lists. */
  embeds?: boolean;
  configured?: boolean;
  /** Record a successful sync (the normal state once the cron has run). */
  synced?: boolean;
  /** Record a failed first sync. */
  syncFailed?: boolean;
  /** Dataset ids that are public in the catalog. */
  publicDatasets?: string[];
  /** Answer /embeds with the captured live answer from the dev Worker. */
  capturedEmbeds?: boolean;
  /** Fail the first N /embeds requests with an HTTP 503. */
  failEmbeds?: number;
}

async function openPage(options: PageOptions = {}) {
  const engine = new Database(":memory:");
  for (const migration of MIGRATIONS) engine.run(migration);
  const db = asD1(engine);
  const catalog = new Database(":memory:");
  catalog.run(`CREATE TABLE datasets (
    dataset_id TEXT PRIMARY KEY, owner_user_id INTEGER NOT NULL, is_sandbox INTEGER DEFAULT 0,
    status TEXT, visibility TEXT)`);
  for (const id of options.publicDatasets ?? []) {
    catalog.query("INSERT INTO datasets VALUES (?, 1, 0, 'active', 'public')").run(id);
  }
  if (options.embeds) {
    // The totals of the captured traffic: 307 embedded, 19 opened directly, 6 other.
    await saveEmbedDays(
      db,
      (["iframe", "document", "none", "other"] as const).map((kind, i) => ({
        date: day(2),
        kind,
        loads: [307, 19, 6, 0][i],
      })),
      new Date().toISOString(),
    );
  }
  if (options.synced) await recordEmbedSync(db, true, new Date().toISOString());
  if (options.syncFailed)
    await recordEmbedSync(db, false, new Date().toISOString(), "read the edge: AE SQL 403");
  const env = {
    OBS_DB: db,
    NEMAR_DB: asD1(catalog),
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
  open.push({ window, engine, catalog });
  const errors: string[] = [];
  window.addEventListener("error", (event) =>
    errors.push(String((event as unknown as { error?: unknown }).error)),
  );
  const asked: string[] = [];
  let failures = options.failEmbeds ?? 0;
  (window as unknown as { fetch: unknown }).fetch = async (input: unknown) => {
    const url = new URL(String(input), ORIGIN);
    asked.push(url.pathname);
    const json = (body: unknown, status = 200) =>
      new window.Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    // The website audience answer is a captured live response, as in
    // dashboard-page.test.ts; everything else is the real Worker.
    if (url.pathname.endsWith("/audience")) return json(audienceWeek.response);
    if (url.pathname.endsWith("/embeds") && failures > 0) {
      failures--;
      return json({ error: "Service unavailable" }, 503);
    }
    if (options.capturedEmbeds && url.pathname.endsWith("/embeds")) {
      return json(embedsCapture.response);
    }
    const response = await worker.fetch(new Request(url.href), env, ctx);
    return new window.Response(await response.text(), {
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
    });
  };
  window.document.write(renderDashboardPage());
  return { window, document: window.document, errors, asked, engine };
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
const quiet = () => {
  const real = console.error;
  console.error = () => {};
  return () => {
    console.error = real;
  };
};

async function openThird(options: PageOptions = {}) {
  const page = await openPage(options);
  await until(() => text(page.document, "viewer-body").includes("Viewer mounts"), "first-party");
  filter(page.document, "third").click();
  await until(
    () =>
      text(page.document, "viewer-body").includes("Embed page loads on other sites") ||
      text(page.document, "viewer-body").includes("Could not load embed loads"),
    "third-party",
  );
  return page;
}

describe("Signal viewer entry", () => {
  test("is a section of its own with a First-party and a Third-party filter", () => {
    const html = renderDashboardPage();
    expect(html).toContain('<section id="viewer"');
    expect(html).toContain('href="#viewer" data-nav-link>Signal viewer</a>');
    expect(html).toContain('data-viewer-filter="first" aria-pressed="true"');
    expect(html).toContain('data-viewer-filter="third" aria-pressed="false"');
  });

  test("the First-party copy says events are recorded unless the visitor has opted out", () => {
    const html = renderDashboardPage();
    expect(html).toContain("recorded unless the visitor has opted out");
    expect(html).not.toContain("after a visitor accepts");
    expect(html).not.toContain("recorded only after");
    expect(html).not.toContain("after consent");
  });

  test("the date inputs cannot be set past today", async () => {
    const { document } = await openPage();
    await until(() => text(document, "viewer-body").includes("Viewer mounts"), "first-party");
    const today = new Date().toISOString().slice(0, 10);
    for (const id of ["range-start", "range-end"]) {
      expect((document.getElementById(id) as unknown as { max: string }).max).toBe(today);
    }
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
    expect(body).toContain("opted out");
    expect(filter(document, "first").getAttribute("aria-pressed")).toBe("true");
  });

  test("Third-party is fetched only when chosen, then shows totals, site counts and datasets", async () => {
    ae = stubAe();
    const { document, errors, asked } = await openPage({
      embeds: true,
      configured: true,
      synced: true,
      publicDatasets: ["on007753"],
    });
    await until(() => text(document, "viewer-body").includes("Viewer mounts"), "first-party");
    expect(asked.some((p) => p.endsWith("/embeds"))).toBe(false);

    filter(document, "third").click();
    await until(
      () => text(document, "viewer-body").includes("Embed page loads on other sites"),
      "third-party",
    );
    expect(errors).toEqual([]);
    expect(asked.filter((p) => p.endsWith("/embeds"))).toHaveLength(1);
    expect(filter(document, "third").getAttribute("aria-pressed")).toBe("true");
    expect(filter(document, "first").getAttribute("aria-pressed")).toBe("false");

    const body = text(document, "viewer-body");
    expect(body).toMatch(/Embedded in another site\s*307/);
    expect(body).toMatch(/Opened directly\s*19/);
    expect(body).toMatch(/Other requests \(scripts, crawlers\)\s*6/);
    // The two measures are never merged into one viewer count, and the first-party
    // figures are not on this view.
    expect(body).not.toContain("Viewer mounts on nemar.org");
    // Days not recorded are unknown, not zero.
    expect(body).toContain("of 30 days");
    // Sites are counted, never named; the real hosts are in the admin list only.
    expect(body).toMatch(/From 1 distinct site\s*1/);
    expect(body).toMatch(/Unknown or local\s*306/);
    for (const host of ["localhost", "127.0.0.1", "example.org", "after-review.invalid"]) {
      const rows = Array.from(document.querySelectorAll("#viewer-body .ranked-row"))
        .map((r) => r.textContent)
        .join(" | ");
      expect(rows).not.toContain(host);
      if (host !== "localhost") expect(body).not.toContain(host);
    }
    expect(body).not.toContain("fewer than");
    // A public dataset is named with a link to this environment's website.
    expect(body).toMatch(/on007753[^0-9]*277/);
    const link = document.querySelector("#viewer-body .ranked-label a") as unknown as {
      href: string;
    };
    expect(link.href).toBe("https://nemar.org/dataset/on007753");
    expect(body).toMatch(/Other datasets \(not named\)\s*30/);
    expect(body).not.toContain("xx099901");
    expect(body).not.toContain("nm000292");
    expect(body).toContain("available to administrators through the API");
    // No promise of a portal screen that does not exist yet (website#425).
    expect(body).not.toContain("admin portal");
    expect(document.querySelector("#viewer-body .portal-cta")).toBeNull();
  });

  // The answer the dev Worker gave for the website's own test traffic: localhost,
  // 127.0.0.1 and the empty host, real hosts each under a handful of loads, and
  // datasets that are not public in the dev catalog.
  test("a captured live /embeds answer is drawn with every host and dataset name withheld", async () => {
    const { document, errors } = await openThird({ capturedEmbeds: true });
    await until(() => text(document, "viewer-body").includes("Embedding sites"), "lists");
    expect(errors).toEqual([]);
    const body = text(document, "viewer-body");
    expect(body).toMatch(/Embedded in another site\s*\d+/);
    expect(body).toMatch(/Unknown or local\s*\d+/);
    expect(body).toMatch(/Other datasets \(not named\)\s*\d+/);
    for (const withheld of [
      "127.0.0.1",
      "example.org",
      "after-review.invalid",
      "xx099901",
      "on007753",
      "nm000292",
    ]) {
      expect(body).not.toContain(withheld);
    }
    expect(
      Array.from(document.querySelectorAll("#viewer-body .ranked-row"))
        .map((r) => r.textContent)
        .join("|"),
    ).not.toContain("localhost");
    expect(document.querySelectorAll("#viewer-body .ranked-label a")).toHaveLength(0);
  });

  test("with embed counting not configured, Third-party says so and shows no zero", async () => {
    const { document, errors } = await openThird();
    expect(errors).toEqual([]);
    const body = text(document, "viewer-body");
    expect(body).toContain("Not configured");
    expect(body).toContain("Embed counting is not configured");
    expect(body).not.toMatch(/Embedded in another site\s*0\b/);
  });

  test("zero embeds after a successful sync is a normal state, not a failure", async () => {
    ae = stubAe({ sites: () => ({ data: [] }), datasets: () => ({ data: [] }) });
    const { document, errors } = await openThird({ configured: true, synced: true });
    await until(() => text(document, "viewer-body").includes("Embedding sites"), "lists");
    expect(errors).toEqual([]);
    const body = text(document, "viewer-body");
    expect(body).toContain("None recorded");
    expect(body).toContain("None recorded yet");
    expect(body).not.toContain("Measured Embedded in another site");
    expect(body).toContain("No embed loads are recorded for these dates");
    expect(body).not.toContain("Could not load");
    // The empty lists say none recorded yet too, not Measured.
    const badges = Array.from(document.querySelectorAll("#viewer-body .badge")).map(
      (b) => b.textContent,
    );
    expect(badges.filter((b) => b === "None recorded yet").length).toBe(3);
    expect(badges).not.toContain("Measured");
  });

  test("a fresh deploy whose first sync failed is unavailable, never none recorded yet", async () => {
    const restore = quiet();
    ae = stubAe({ sites: () => new Response("forbidden", { status: 403 }) });
    const { document, errors } = await openThird({ configured: true, syncFailed: true });
    await until(() => text(document, "viewer-body").includes("Embedding sites"), "lists");
    restore();
    expect(errors).toEqual([]);
    const body = text(document, "viewer-body");
    expect(body).toContain("update of embed totals has failed");
    expect(body).not.toContain("None recorded");
    expect(body).toContain("Embed detail is currently unavailable");
    expect(body).not.toContain("forbidden");
    expect(body).not.toContain("403");
  });

  test("a store that is not migrated shows the totals unavailable, not zero", async () => {
    const restore = quiet();
    ae = stubAe();
    const page = await openPage({ configured: true });
    await until(() => text(page.document, "viewer-body").includes("Viewer mounts"), "first-party");
    page.engine.run("DROP TABLE embed_daily_loads");
    filter(page.document, "third").click();
    await until(
      () => text(page.document, "viewer-body").includes("Embed totals are currently unavailable"),
      "unavailable totals",
    );
    restore();
    expect(page.errors).toEqual([]);
    expect(text(page.document, "viewer-body")).not.toMatch(/Embedded in another site\s*0\b/);
  });

  test("switching back to First-party restores it", async () => {
    ae = stubAe();
    const { document, errors } = await openThird({ embeds: true, configured: true, synced: true });
    filter(document, "first").click();
    await until(
      () => text(document, "viewer-body").includes("Viewer mounts on nemar.org"),
      "first-party again",
    );
    expect(errors).toEqual([]);
    expect(text(document, "viewer-body")).not.toContain("Embedded in another site");
  });

  // As in dashboard-page.test.ts: the request itself fails once, Try again asks
  // again, and the card recovers with the real answer.
  test("a failed /embeds request offers Try again, which recovers", async () => {
    const restore = quiet();
    ae = stubAe();
    const { document, errors } = await openThird({
      embeds: true,
      configured: true,
      synced: true,
      failEmbeds: 1,
    });
    expect(text(document, "viewer-body")).toContain("Could not load embed loads");
    expect(text(document, "viewer-body")).toContain("Service unavailable.");
    expect(text(document, "viewer-body")).not.toMatch(/Embedded in another site\s*0\b/);
    (document.querySelector("#viewer-body .button") as unknown as { click(): void }).click();
    await until(
      () => text(document, "viewer-body").includes("Embedded in another site"),
      "the retry to recover",
    );
    restore();
    expect(errors).toEqual([]);
    expect(text(document, "viewer-body")).toMatch(/Embedded in another site\s*307/);
    expect(text(document, "viewer-body")).not.toContain("Could not load");
  });

  test("the chart follows the page's day, week or month grouping", async () => {
    ae = stubAe();
    const { document, errors } = await openThird({ embeds: true, configured: true, synced: true });
    const chartLabel = () =>
      document.querySelector("#viewer-body .chart")?.getAttribute("aria-label") ?? "";
    expect(chartLabel()).toContain("by day");
    const select = document.getElementById("grouping") as unknown as {
      value: string;
      dispatchEvent(e: unknown): void;
    };
    select.value = "week";
    select.dispatchEvent(
      new (document.defaultView as unknown as { Event: new (t: string) => unknown }).Event(
        "change",
      ),
    );
    await until(() => chartLabel().includes("by week"), "the weekly chart");
    expect(errors).toEqual([]);
  });

  test("a range before counting began says so on every card", async () => {
    ae = stubAe();
    const { document, errors } = await openPage({ embeds: true, configured: true, synced: true });
    await until(() => text(document, "viewer-body").includes("Viewer mounts"), "first-party");
    const startInput = document.getElementById("range-start") as unknown as {
      value: string;
      dispatchEvent(e: unknown): void;
    };
    const endInput = document.getElementById("range-end") as unknown as {
      value: string;
      dispatchEvent(e: unknown): void;
    };
    const Event = (document.defaultView as unknown as { Event: new (t: string) => unknown }).Event;
    startInput.value = day(60);
    endInput.value = day(40);
    filter(document, "third").click();
    endInput.dispatchEvent(new Event("change"));
    await until(() => text(document, "viewer-body").includes("Before counting began"), "the note");
    expect(errors).toEqual([]);
    const badges = Array.from(document.querySelectorAll("#viewer-body .badge")).map(
      (b) => b.textContent,
    );
    expect(badges).toEqual([
      "Before counting began",
      "Before counting began",
      "Before counting began",
    ]);
    const body = text(document, "viewer-body");
    expect(body).toContain("Unknown");
    expect(body).not.toContain("None recorded yet");
  });

  test("a range wholly in the future says so", async () => {
    ae = stubAe();
    const { document, errors } = await openPage({ embeds: true, configured: true, synced: true });
    await until(() => text(document, "viewer-body").includes("Viewer mounts"), "first-party");
    const startInput = document.getElementById("range-start") as unknown as {
      value: string;
      dispatchEvent(e: unknown): void;
    };
    const endInput = document.getElementById("range-end") as unknown as {
      value: string;
      dispatchEvent(e: unknown): void;
    };
    const Event = (document.defaultView as unknown as { Event: new (t: string) => unknown }).Event;
    startInput.value = "2999-01-01";
    endInput.value = "2999-01-31";
    filter(document, "third").click();
    endInput.dispatchEvent(new Event("change"));
    await until(() => text(document, "viewer-body").includes("in the future"), "the future note");
    expect(errors).toEqual([]);
    const body = text(document, "viewer-body");
    expect(body).toContain("Future dates");
    expect(body).not.toContain("None recorded");
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

  // The audience API sends numbers for a measured figure and null for one it did
  // not measure; a real measured capture waits on UMAMI_EVENTS_COVERAGE_START
  // being set in production (test_requirements.md).
  test("measured figures pass through and a null stays unknown, a real zero stays zero", () => {
    const figures = viewerFirstParty({
      umami: {
        event_metrics: {
          status: "available",
          coverage: { start: "2026-09-01", end: "2026-09-30" },
          metrics: [
            { name: "viewer_open", events: 40, visitors: 12 },
            { name: "viewer_interaction", events: null, visitors: 0 },
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

  test("the embed headline is words without recorded days and a count with them, a real zero included", () => {
    expect(embedHeadline({ totals: null, days_recorded: 0, empty_reason: "none_yet" })).toEqual({
      text: "None recorded",
      value: null,
    });
    expect(embedHeadline({ totals: null, days_recorded: 0, empty_reason: null })).toEqual({
      text: "None recorded",
      value: null,
    });
    expect(
      embedHeadline({ totals: null, days_recorded: 0, empty_reason: "before_counting" }),
    ).toEqual({
      text: "Unknown",
      value: null,
    });
    expect(embedHeadline({ totals: null, days_recorded: 0, empty_reason: "future" })).toEqual({
      text: "Not yet counted",
      value: null,
    });
    expect(
      embedHeadline({
        totals: { embedded: 0, direct: 0, other: 0 },
        days_recorded: 3,
        empty_reason: null,
      }),
    ).toEqual({ text: "0", value: 0 });
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
