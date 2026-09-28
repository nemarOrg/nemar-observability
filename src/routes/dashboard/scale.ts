// The map's continuous color scale, with no DOM access, so the tests can run
// this exact code against real country distributions.
//
// Country request counts are heavy-tailed: a few countries carry most of the
// traffic, and most report a few hundred. A log scale compresses the top (the
// United States at four times China looked the same), and a linear or square
// root scale washes out the long tail. Each country's position on the ramp is
// therefore half its rank among reporting countries and half the square root
// of its share of the largest value. Rank spreads the long tail across the
// ramp; the square root keeps big ratios at the top far apart. The position is
// continuous in the value, so the legend ticks sit where the same function puts
// them, and the page mixes the fill smoothly between three ramp colors.
//
// Part of the inlined client script (see client.ts): a String.raw template, so
// no backticks and no dollar-brace sequences.

export const SCALE_JS = String.raw`
// ---------- continuous map scale ----------
const MAP_RANK_WEIGHT = 0.5;
function mapScale(values) {
  const sorted = Array.from(new Set(values.filter(function (v) { return typeof v === "number" && Number.isFinite(v) && v > 0; }))).sort(function (a, b) { return a - b; });
  const count = sorted.length;
  const min = count ? sorted[0] : 0;
  const max = count ? sorted[count - 1] : 0;
  // The share of reporting countries below the value, interpolated on a log
  // axis between neighbors so it never jumps.
  function rank(v) {
    if (count < 2 || v >= max) return 1;
    if (v <= min) return 0;
    let lo = 0; let hi = count - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (sorted[mid] <= v) lo = mid; else hi = mid; }
    const a = Math.log(sorted[lo]); const b = Math.log(sorted[hi]);
    return (lo + (b > a ? (Math.log(v) - a) / (b - a) : 0)) / (count - 1);
  }
  function position(v) {
    if (!(v > 0) || !(max > 0)) return 0;
    const t = MAP_RANK_WEIGHT * rank(v) + (1 - MAP_RANK_WEIGHT) * Math.sqrt(Math.min(v, max) / max);
    return Math.max(0, Math.min(1, t));
  }
  // Labeled values for the legend: the smallest and largest reported values
  // and round numbers between them, kept only where their positions are far
  // enough apart to read.
  function ticks(minGap) {
    if (!count) return [];
    if (count === 1) return [{ value: max, position: 1 }];
    const gap = typeof minGap === "number" ? minGap : 0.16;
    const candidates = [];
    for (let p = Math.pow(10, Math.ceil(Math.log10(min))); p < max; p *= 10) {
      if (p > min) candidates.push(p);
    }
    if (candidates.length < 2) {
      [2, 5, 20, 50, 200, 500, 2000, 5000, 20000, 50000].forEach(function (f) {
        const scaled = f * Math.pow(10, Math.floor(Math.log10(min)));
        if (scaled > min && scaled < max) candidates.push(scaled);
      });
    }
    const interior = Array.from(new Set(candidates)).sort(function (a, b) { return a - b; });
    const kept = [{ value: min, position: position(min) }];
    const last = { value: max, position: position(max) };
    interior.forEach(function (v) {
      const t = position(v);
      if (t - kept[kept.length - 1].position >= gap && last.position - t >= gap) kept.push({ value: v, position: t });
    });
    kept.push(last);
    return kept;
  }
  return { min: min, max: max, count: count, position: position, ticks: ticks };
}
// The fill for a position: the lower half mixes the light and middle ramp
// colors, the upper half the middle and dark ones, as a percentage.
function mapMix(t) {
  const clamped = Math.max(0, Math.min(1, t));
  return clamped <= 0.5
    ? { half: "a", percent: Math.round(clamped * 2000) / 10 }
    : { half: "b", percent: Math.round((clamped - 0.5) * 2000) / 10 };
}
`;
