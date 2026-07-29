/**
 * Dataset size distribution: a log-binned histogram plus the largest datasets.
 *
 * WHY LOG BINS. Public dataset sizes span seven orders of magnitude (0.36 MB to
 * 9.58 TB, median 13 GB). Twenty equal-width bins put 736 of 754 datasets in the
 * first bin and leave 13 bins empty -- a picture of nothing. Verified both ways
 * before choosing.
 *
 * WHY 1-2-5 BOUNDARIES rather than evenly-spaced powers. Two reasons: the edges
 * are round numbers a reader already thinks in (1, 2, 5, 10, 20, 50 GB...), and
 * 100 GB falls on an EXACT boundary. That matters because 100 GB is the archive
 * cutoff (nemar-cli #752): with arbitrary log edges the cutoff lands mid-bin and
 * cannot be drawn honestly, and this tile's whole job is to explain why ~16% of
 * the catalog has no archive.
 */

/** Ascending 1-2-5 boundaries, 1 MB up to 10 TB. Decimal (1e6) not binary,
 *  to match the human-readable sizes shown everywhere else in NEMAR. */
export function sizeBinEdges(): number[] {
  const edges: number[] = [];
  for (let decade = 1_000_000; decade <= 10_000_000_000_000; decade *= 10) {
    for (const m of [1, 2, 5]) {
      const v = decade * m;
      if (v <= 10_000_000_000_000) edges.push(v);
    }
  }
  return edges;
}

/** The 100 GB archive cutoff, which is deliberately one of the bin edges. */
export const ARCHIVE_CUTOFF_BYTES = 100_000_000_000;

function humanSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let x = bytes;
  while (x >= 1000 && i < units.length - 1) {
    x /= 1000;
    i++;
  }
  // Bin edges are round by construction, so no decimals are needed here.
  return `${Math.round(x)} ${units[i]}`;
}

/**
 * Bucket sizes into labelled bins. The bin whose lower edge is the archive
 * cutoff is labelled so, which is how the cutoff becomes visible without a
 * schema change or a bespoke renderer -- the existing breakdown bars carry it.
 */
export function buildSizeHistogram(sizes: number[]): { label: string; value: number }[] {
  const edges = sizeBinEdges();
  const counts = new Array(edges.length + 1).fill(0);
  for (const s of sizes) {
    if (s <= 0) continue;
    if (s < edges[0]) {
      counts[0]++;
      continue;
    }
    let idx = edges.length;
    for (let i = 0; i < edges.length; i++) {
      if (s < edges[i]) {
        idx = i;
        break;
      }
    }
    counts[idx]++;
  }

  const out: { label: string; value: number }[] = [];
  for (let i = 0; i < counts.length; i++) {
    const lo = i === 0 ? 0 : edges[i - 1];
    // Label by LOWER EDGE only. A full "20 GB-50 GB" range does not fit the
    // breakdown's label column and gets ellipsed to uselessness; ascending
    // lower edges read as an axis, which is what a histogram wants.
    let label: string;
    if (i === 0) label = `< ${humanSize(edges[0])}`;
    else label = humanSize(lo);
    if (lo === ARCHIVE_CUTOFF_BYTES) label += " \u2500 cutoff";
    // Empty bins are kept: a gap in the distribution is information, and
    // dropping them would make the axis non-uniform and the shape a lie.
    out.push({ label, value: counts[i] });
  }
  return out;
}
