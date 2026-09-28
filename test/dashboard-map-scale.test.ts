import { describe, expect, test } from "bun:test";
import { SCALE_JS } from "../src/routes/dashboard/scale";
import fixture from "./fixtures/audience-countries-2026-09-27.json";

// The page's own scale code, run as the browser runs it.
const { mapScale, mapMix } = new Function(`${SCALE_JS}\nreturn { mapScale, mapMix };`)();

// Real Cloudflare request counts by country for 30 days (see the fixture's
// source line): heavy-tailed, with the United States about 3.3 times China.
const rows = fixture.countries as { label: string; value: number }[];
const values = rows.map((r) => r.value);
const requestsFrom = (code: string) => rows.find((r) => r.label === code)?.value ?? 0;

describe("continuous map scale on real country data", () => {
  const scale = mapScale(values);

  test("a several-fold lead at the top is clearly stronger", () => {
    const us = scale.position(requestsFrom("US"));
    const cn = scale.position(requestsFrom("CN"));
    expect(requestsFrom("US") / requestsFrom("CN")).toBeGreaterThan(3);
    // A fifth of the ramp or more; the old log steps put them in one class.
    expect(us - cn).toBeGreaterThanOrEqual(0.2);
    const logPosition = (v: number) =>
      (Math.log(v) - Math.log(scale.min)) / (Math.log(scale.max) - Math.log(scale.min));
    expect(us - cn).toBeGreaterThan(
      2 * (logPosition(requestsFrom("US")) - logPosition(requestsFrom("CN"))),
    );
  });

  test("countries four times apart almost always differ visibly", () => {
    let pairs = 0;
    let visible = 0;
    for (let i = 0; i < values.length; i++) {
      for (let j = i + 1; j < values.length; j++) {
        const [lo, hi] = values[i] < values[j] ? [values[i], values[j]] : [values[j], values[i]];
        if (hi / lo < 4) continue;
        pairs++;
        if (scale.position(hi) - scale.position(lo) >= 0.1) visible++;
      }
    }
    expect(pairs).toBeGreaterThan(1000);
    expect(visible / pairs).toBeGreaterThanOrEqual(0.9);
  });

  test("the scale is continuous, increasing, and never reaches no-data", () => {
    const sorted = [...values].sort((a, b) => a - b);
    let previous = -1;
    for (const v of sorted) {
      const t = scale.position(v);
      expect(t).toBeGreaterThan(0);
      expect(t).toBeGreaterThanOrEqual(previous);
      previous = t;
    }
    expect(scale.position(scale.max)).toBe(1);
    // No jump between neighboring values.
    const a = scale.position(1000);
    const b = scale.position(1001);
    expect(Math.abs(b - a)).toBeLessThan(0.005);
  });

  test("legend ticks sit where the same scale puts their values", () => {
    const ticks = scale.ticks();
    expect(ticks[0].value).toBe(scale.min);
    expect(ticks[ticks.length - 1].value).toBe(scale.max);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    for (let i = 0; i < ticks.length; i++) {
      expect(ticks[i].position).toBe(scale.position(ticks[i].value));
      if (i > 0) expect(ticks[i].position - ticks[i - 1].position).toBeGreaterThanOrEqual(0.16);
    }
  });
});

describe("map fill mixing", () => {
  test("each position mixes within one half of the ramp", () => {
    expect(mapMix(0)).toEqual({ half: "a", percent: 0 });
    expect(mapMix(0.25)).toEqual({ half: "a", percent: 50 });
    expect(mapMix(0.5)).toEqual({ half: "a", percent: 100 });
    expect(mapMix(0.75)).toEqual({ half: "b", percent: 50 });
    expect(mapMix(1)).toEqual({ half: "b", percent: 100 });
  });

  test("a single reporting country takes the strongest color", () => {
    const one = mapScale([42]);
    expect(one.position(42)).toBe(1);
    expect(one.ticks()).toEqual([{ value: 42, position: 1 }]);
    expect(mapScale([]).ticks()).toEqual([]);
  });
});
