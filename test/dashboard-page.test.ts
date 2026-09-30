// Runs the real dashboard page in a real DOM (happy-dom) against the real
// Worker: the page's own script, the real router and API handlers, and a real
// SQLite store behind the D1 surface. Requests the page makes are handed to
// the Worker in process instead of over a socket; nothing in the page or the
// API is replaced. Some tests shape transport only: one holds an answer back to
// make it arrive late, one returns an HTTP error once to exercise Try again, and
// the website map tests answer /audience with captured live responses.

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import worker from "../src/index";
import { saveDailySeries } from "../src/lib/store";
import { renderDashboardPage } from "../src/routes/ui";
import type { Bindings } from "../src/types";
import audienceDay from "./fixtures/audience-day-2026-09-29-to-2026-09-29.json";
import audienceWeek from "./fixtures/audience-week-2026-09-23-to-2026-09-29.json";
import timeseries from "./fixtures/timeseries-2026-07-01-to-2026-09-28.json";
import { asD1 } from "./helpers/d1";
import { MIGRATIONS } from "./helpers/migrations";

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const ORIGIN = "https://dashboard.nemar.org";

const open: { window: Window; engine: Database }[] = [];
afterEach(async () => {
  for (const page of open.splice(0)) {
    await page.window.happyDOM.close();
    page.engine.close();
  }
});

// An observability store as a fresh deploy has it: migrated, nothing else.
// With seed, it also holds the captured live egress series.
async function store(seed: boolean) {
  const engine = new Database(":memory:");
  for (const migration of MIGRATIONS) engine.run(migration);
  const db = asD1(engine);
  if (seed) {
    const s = timeseries.response.series[0];
    await saveDailySeries(
      db,
      s.section,
      s.source,
      [
        {
          key: s.key,
          label: s.label,
          unit: s.unit as "bytes",
          aggregation: "sum",
          timezone: "UTC",
          coverage_start: s.coverage_start,
          coverage_end: s.coverage_end,
          freshness_after_hours: s.freshness_after_hours,
          points: s.points,
        },
      ],
      s.updated_at,
    );
  }
  return { engine, db };
}

type Route = (request: Request, env: Bindings) => Promise<Response>;
const direct: Route = (request, env) => worker.fetch(request, env, ctx);

async function openPage(seed: boolean, route: Route = direct) {
  const { engine, db } = await store(seed);
  // No NEMAR_DB and no analytics tokens: catalog sections fail for real and
  // the network edge and website analytics report themselves unconfigured.
  const env = { OBS_DB: db } as unknown as Bindings;
  const window = new Window({
    url: `${ORIGIN}/observability`,
    settings: { enableJavaScriptEvaluation: true } as never,
  });
  open.push({ window, engine });
  const errors: string[] = [];
  window.addEventListener("error", (event) =>
    errors.push(String((event as unknown as { error?: unknown }).error)),
  );
  window.addEventListener("unhandledrejection", (event) =>
    errors.push(`unhandled: ${String((event as unknown as { reason?: unknown }).reason)}`),
  );
  (window as unknown as { fetch: unknown }).fetch = async (input: unknown) => {
    const response = await route(new Request(new URL(String(input), ORIGIN).href), env);
    return new window.Response(await response.text(), {
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
    });
  };
  window.document.write(renderDashboardPage());
  return { window, document: window.document, errors };
}

async function until(check: () => boolean, what: string, ms = 4000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
}
const text = (doc: Window["document"], id: string) => doc.getElementById(id)?.textContent ?? "";
const busy = (doc: Window["document"], id: string) =>
  doc.getElementById(id)?.getAttribute("aria-busy") === "true";

describe("dashboard page in a real DOM", () => {
  test("a fresh deploy with no data shows every state without a script error", async () => {
    const { document, errors } = await openPage(false);
    await until(
      () => !busy(document, "all-time") && !busy(document, "kpis"),
      "the overview to settle",
    );
    await until(
      () => text(document, "health-meta").includes("Not in this snapshot"),
      "the snapshot line",
    );
    expect(errors).toEqual([]);
    const strip = text(document, "all-time");
    expect(strip).toContain("Public datasetsUnavailable");
    expect(strip).toContain("Data servedNot recorded");
    expect(strip).not.toMatch(/(^|[^\d.])0 B/);
    expect(text(document, "kpis")).toContain("Not measured");
    // Section errors are named in plain words, not raw keys.
    expect(text(document, "health-meta")).toContain("Datasets, Dataset sizes, Archives");
    for (const id of ["series", "audience", "geography", "catalog", "sections"])
      expect(busy(document, id)).toBe(false);
  });

  test("reported daily usage fills the all-time strip from its first day", async () => {
    const { document, errors } = await openPage(true);
    await until(
      () => text(document, "all-time").includes("Since Aug 1, 2026"),
      "the lifetime total",
    );
    expect(errors).toEqual([]);
    expect(text(document, "all-time")).toContain("Data served394.9 TB");
  });

  test("an older answer that arrives late does not replace a newer range", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let heldStart = "";
    const route: Route = async (request, env) => {
      const url = new URL(request.url);
      // Hold back the first audience answer (the default 30 days).
      if (url.pathname.endsWith("/audience") && !heldStart) {
        heldStart = url.searchParams.get("start") ?? "";
        await held;
      }
      return direct(request, env);
    };
    const { window, document, errors } = await openPage(false, route);
    await until(() => heldStart !== "", "the first audience request");
    (document.querySelector('[data-range="7"]') as unknown as { click(): void }).click();
    const sevenDays = document.getElementById("range-summary")?.textContent ?? "";
    await until(() => text(document, "geography").includes("Requests"), "the 7-day map");
    const chip = () => document.querySelector(".geography-period")?.textContent ?? "";
    const afterNewer = chip();
    release();
    await Bun.sleep(200);
    await window.happyDOM.waitUntilComplete();
    expect(errors).toEqual([]);
    expect(chip()).toBe(afterNewer);
    expect(chip()).toContain(sevenDays.replace(" (UTC)", ""));
  });

  test("a failed load offers Try again, which recovers without a stuck skeleton", async () => {
    let failures = 1;
    const route: Route = async (request, env) => {
      if (new URL(request.url).pathname.endsWith("/timeseries") && failures > 0) {
        failures--;
        return new Response(JSON.stringify({ error: "Service unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        });
      }
      return direct(request, env);
    };
    const { document, errors } = await openPage(true, route);
    await until(
      () => text(document, "series").includes("Could not load daily usage"),
      "the load error",
    );
    expect(text(document, "series")).toContain("Service unavailable.");
    expect(text(document, "all-time")).toContain("Daily usage did not load.");
    (document.querySelector("#series .button") as unknown as { click(): void }).click();
    await until(() => !text(document, "series").includes("Could not load"), "the retry");
    await until(() => !busy(document, "series"), "the series to settle");
    expect(errors).toEqual([]);
    expect(text(document, "series")).not.toContain("Could not load");
  });

  // Website analytics map one completed UTC day. For a longer range the page
  // loads the newest closed day inside it, so the website map works and says
  // which day it shows. The two audience answers are captured live responses.
  test("the website map works for a multi-day range by showing the newest closed day", async () => {
    const requested: string[] = [];
    const route: Route = async (request, env) => {
      const url = new URL(request.url);
      if (!url.pathname.endsWith("/audience")) return direct(request, env);
      const start = url.searchParams.get("start");
      const end = url.searchParams.get("end");
      requested.push(`${start}..${end}`);
      const body = start === end ? audienceDay.response : audienceWeek.response;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const { document, errors } = await openPage(false, route);
    const sources = () =>
      Array.from(document.querySelectorAll(".geography-source")) as unknown as {
        textContent: string;
        disabled: boolean;
        click(): void;
      }[];
    await until(
      () => sources().some((b) => b.textContent.includes("Website sessions") && !b.disabled),
      "the website source to enable",
    );
    // One request for the range, one for its newest closed day (which is yesterday).
    const day = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    expect(requested).toContain(`${day}..${day}`);

    const website = sources().find((b) => b.textContent.includes("Website sessions"));
    expect(website?.textContent).toContain("Newest closed day");
    website?.click();
    await until(
      () => (document.querySelector(".geography-period")?.textContent ?? "").includes("Sep 29"),
      "the website map period",
    );
    expect(document.querySelector(".scope-note")?.textContent).toContain(
      "newest completed UTC day in these dates",
    );
    // The captured day: 778 anonymous sessions, the United States first.
    expect(text(document, "geography")).toContain("Anonymous unique sessions");
    expect(text(document, "geography")).toContain("778");
    expect(text(document, "geography")).toContain("United States");
    expect(errors).toEqual([]);
  });

  describe("the website map when its day cannot simply load", () => {
    type AudienceFixture = typeof audienceDay.response;
    const clone = (body: AudienceFixture): AudienceFixture => JSON.parse(JSON.stringify(body));
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    const websiteButton = (document: Window["document"]) =>
      (
        Array.from(document.querySelectorAll(".geography-source")) as unknown as {
          textContent: string;
          disabled: boolean;
        }[]
      ).find((b) => b.textContent.includes("Website sessions"));
    const chip = (document: Window["document"]) =>
      document.querySelector(".scope-note")?.textContent ?? "";

    test("a failed day load says so and offers Try again, which recovers", async () => {
      let failures = 1;
      const route: Route = async (request, env) => {
        const url = new URL(request.url);
        if (!url.pathname.endsWith("/audience")) return direct(request, env);
        const single = url.searchParams.get("start") === url.searchParams.get("end");
        if (single && failures > 0) {
          failures--;
          return json({ error: "Service unavailable" }, 503);
        }
        return json(single ? audienceDay.response : audienceWeek.response);
      };
      const { document, errors } = await openPage(false, route);
      await until(() => chip(document).includes("Could not load the website map"), "the failure");
      // Not the permanent-limitation wording: this one is a failure.
      expect(websiteButton(document)?.textContent).toContain("Could not load");
      expect(websiteButton(document)?.textContent).not.toContain("Single day only");
      expect(chip(document)).toContain("Try again");

      (document.querySelector(".scope-note .button") as unknown as { click(): void }).click();
      await until(
        () => (websiteButton(document)?.textContent ?? "").includes("Newest closed day"),
        "the retry to load the day",
      );
      expect(websiteButton(document)?.disabled).toBe(false);
      expect(errors).toEqual([]);
    });

    test("a day with no country data is labeled by its coverage, not as a map", async () => {
      const partialDay = clone(audienceDay.response);
      partialDay.umami.status = "partial";
      partialDay.umami.country_coverage = null as never;
      partialDay.umami.countries = [];
      const route: Route = async (request, env) => {
        const url = new URL(request.url);
        if (!url.pathname.endsWith("/audience")) return direct(request, env);
        const single = url.searchParams.get("start") === url.searchParams.get("end");
        return json(single ? partialDay : audienceWeek.response);
      };
      const { document, errors } = await openPage(false, route);
      await until(() => chip(document).includes("no country data"), "the no-data notice");
      expect(websiteButton(document)?.textContent).toContain("Partial coverage");
      expect(websiteButton(document)?.textContent).not.toContain("Newest closed day");
      expect(websiteButton(document)?.disabled).toBe(true);
      expect(errors).toEqual([]);
    });

    test("no day request is made when website analytics are already unavailable", async () => {
      const down = clone(audienceWeek.response);
      down.umami.status = "unavailable";
      const requested: string[] = [];
      const route: Route = async (request, env) => {
        const url = new URL(request.url);
        if (!url.pathname.endsWith("/audience")) return direct(request, env);
        requested.push(`${url.searchParams.get("start")}..${url.searchParams.get("end")}`);
        return json(down);
      };
      const { document, errors } = await openPage(false, route);
      await until(() => websiteButton(document) !== undefined, "the map toolbar");
      await Bun.sleep(150);
      const single = requested.filter((r) => r.split("..")[0] === r.split("..")[1]);
      expect(single).toEqual([]);
      expect(errors).toEqual([]);
    });
  });
});
