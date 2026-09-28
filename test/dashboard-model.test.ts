import { describe, expect, test } from "bun:test";
import audience from "./fixtures/audience-2026-09-21-to-2026-09-27.json";
import { clientLogic } from "./helpers/client-logic";

const {
  normalizeThemeChoice,
  themeOrder,
  nextThemeFor,
  priorAudienceWanted,
  fullyMeasured,
  comparisonFor,
  priorRange,
  NO_COMPARISON,
} = clientLogic([
  "normalizeThemeChoice",
  "themeOrder",
  "nextThemeFor",
  "priorAudienceWanted",
  "fullyMeasured",
  "comparisonFor",
  "priorRange",
  "NO_COMPARISON",
]);

// A real /audience answer for a fully covered week (see the fixture's source
// line): the network edge reported it available, website analytics are not set up.
const week = audience.response;

describe("theme cycle", () => {
  test("the first click always shows the opposite of the system", () => {
    expect(nextThemeFor("system", "light")).toBe("dark");
    expect(nextThemeFor("system", "dark")).toBe("light");
  });

  test("three clicks come back to following the system", () => {
    for (const system of ["light", "dark"]) {
      let choice = "system";
      const seen = [];
      for (let i = 0; i < 3; i++) {
        choice = nextThemeFor(choice, system);
        seen.push(choice);
      }
      expect(seen).toEqual([...themeOrder(system).slice(1), "system"]);
    }
  });

  test("an unknown attribute value is treated as following the system", () => {
    expect(normalizeThemeChoice("sepia")).toBe("system");
    expect(normalizeThemeChoice(null)).toBe("system");
    expect(normalizeThemeChoice("dark")).toBe("dark");
    expect(nextThemeFor("sepia", "light")).toBe("dark");
  });
});

describe("prior-period requests", () => {
  const today = "2026-09-28";

  test("the network edge's 30-day retention decides whether to ask", () => {
    expect(week.cloudflare.status).toBe("available");
    // The oldest kept day is today minus 29 (30 days, today included).
    expect(priorAudienceWanted(week, { start: "2026-08-30" }, today)).toBe(true);
    expect(priorAudienceWanted(week, { start: "2026-08-29" }, today)).toBe(false);
    expect(priorAudienceWanted(week, { start: "2026-08-28" }, today)).toBe(false);
  });

  test("a partly measured current period never asks", () => {
    const partial = { ...week, cloudflare: { ...week.cloudflare, status: "partial" } };
    expect(priorAudienceWanted(partial, { start: "2026-09-14" }, today)).toBe(false);
  });
});

describe("comparisons", () => {
  const current = { start: week.start, end: week.end, payload: week };
  const period = priorRange(week.start, week.end);

  test("full measurement needs available status and exact coverage", () => {
    expect(fullyMeasured(week.cloudflare, week.start, week.end, "coverage")).toBe(true);
    expect(fullyMeasured(week.cloudflare, "2026-09-20", week.end, "coverage")).toBe(false);
    expect(fullyMeasured(week.umami, week.start, week.end, "coverage")).toBe(false);
  });

  test("nothing is claimed while either period loads", () => {
    const compute = () => ({ direction: "up", text: "+1%" });
    expect(
      comparisonFor(current, true, { ...period, payload: week, loading: false }, compute),
    ).toBeNull();
    expect(
      comparisonFor(current, false, { ...period, payload: null, loading: true }, compute),
    ).toBeNull();
    expect(comparisonFor(null, false, null, compute)).toBeNull();
  });

  test("a prior period for other dates is never compared", () => {
    const compute = () => ({ direction: "up", text: "+1%" });
    const wrong = { start: "2026-09-01", end: "2026-09-07", payload: week, loading: false };
    expect(comparisonFor(current, false, wrong, compute)).toBe(NO_COMPARISON);
    const right = { start: period.start, end: period.end, payload: week, loading: false };
    expect(comparisonFor(current, false, right, compute)).toEqual({ direction: "up", text: "+1%" });
  });
});
