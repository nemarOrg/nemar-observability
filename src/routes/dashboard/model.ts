// Audience comparison rules with no DOM access, so the tests can run this
// exact code: when the prior period is worth requesting, when a source fully
// measured a period, and which change (or plain statement) a card shows.
//
// Part of the inlined client script (see client.ts): a String.raw template, so
// no backticks and no dollar-brace sequences.

export const MODEL_JS = String.raw`
// ---------- audience comparisons ----------
// The period before the selected one is requested only when it could be fully
// measured: the network edge keeps 30 days, and a partly covered current
// period has nothing like-for-like to compare against.
function priorAudienceWanted(payload, prior, today) {
  const oldestKept = shiftDay(today || isoDay(new Date()), 1 - CLOUDFLARE_RETENTION_DAYS);
  const cloudflare = payload.cloudflare && payload.cloudflare.status === "available" && prior.start >= oldestKept;
  const umami = payload.umami && payload.umami.status === "available";
  return Boolean(cloudflare || umami);
}
// A source measured a period only when it reports it available and its
// coverage is exactly the period.
function fullyMeasured(source, start, end, coverageKey) {
  const coverage = source && source[coverageKey];
  return Boolean(source && source.status === "available" && coverage && coverage.start === start && coverage.end === end);
}
// The change against the prior period, from compute(priorPayload, period), or
// the plain statement that there is none. Null while either period loads.
// current is { start, end, payload } or null; prior is the loaded prior-period
// state { start, end, payload, loading } or null.
function comparisonFor(current, currentLoading, prior, compute) {
  if (!current || currentLoading || !prior || prior.loading) return null;
  const expected = priorRange(current.start, current.end);
  if (prior.start !== expected.start || prior.end !== expected.end || !prior.payload) return NO_COMPARISON;
  return compute(prior.payload, expected) || NO_COMPARISON;
}
`;
