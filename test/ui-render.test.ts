// Executes the inlined client script against a realistic snapshot.
//
// WHY THIS EXISTS: the previous guard only did `new Function(js)`, which parses
// but never runs. A cut that removed the `ADMIN_PORTAL` constant while leaving
// its use in tile() therefore passed every check and shipped a page that
// rendered the first section, hit a ReferenceError on the first tile with a
// `drilldown` key, and printed "Could not load metrics." in production.
//
// Parsing is not evidence the page works. This runs renderSnapshot for real
// against a minimal DOM, so an undefined identifier on any code path a real
// snapshot exercises fails the suite.
//
// The DOM stand-in is the same category as test/helpers/d1.ts: a thin adapter
// over a browser API the runtime does not provide, not a mock of our logic.
// Every line of dashboard code under test is the real thing.

import { describe, expect, test } from "bun:test";
import { renderDashboardPage } from "../src/routes/ui";

interface FakeNode {
  tagName: string;
  className: string;
  textContent: string;
  href?: string;
  target?: string;
  rel?: string;
  tabIndex?: number;
  value?: string;
  style: Record<string, string>;
  namespaceURI: string;
  attributes: Record<string, string>;
  children: FakeNode[];
  listeners: Record<string, (() => void)[]>;
  classList: {
    add(c: string): void;
    remove(c: string): void;
    toggle(c: string, on?: boolean): void;
  };
  appendChild(n: FakeNode): FakeNode;
  addEventListener(type: string, listener: () => void): void;
  dispatch(type: string): void;
  setAttribute(name: string, value: string): void;
}

function makeNode(tagName: string): FakeNode {
  let textContent = "";
  const node: FakeNode = {
    tagName,
    className: "",
    get textContent() {
      return textContent;
    },
    set textContent(value: string) {
      textContent = value;
      if (value === "") node.children = [];
    },
    style: {},
    namespaceURI: "http://www.w3.org/2000/svg",
    attributes: {},
    children: [],
    listeners: {} as Record<string, (() => void)[]>,
    classList: { add() {}, remove() {}, toggle() {} },
    appendChild(child) {
      node.children.push(child);
      return child;
    },
    addEventListener(type, listener) {
      node.listeners[type] = [...(node.listeners[type] ?? []), listener];
    },
    dispatch(type) {
      node.listeners[type]?.forEach((listener) => listener());
    },
    setAttribute(name: string, value: string) {
      node.attributes[name] = value;
    },
  };
  return node;
}

/** Depth-first text of a rendered tree, for asserting what reached the page. */
function textOf(n: FakeNode): string {
  return [n.textContent, ...n.children.map(textOf)].join(" ");
}

function attributeValues(n: FakeNode, name: string): string[] {
  return [
    n.attributes[name],
    ...n.children.flatMap((child) => attributeValues(child, name)),
  ].filter((value): value is string => value !== undefined);
}

/** A snapshot shaped like production: a plain section, a section with a
 *  drilldown tile (the path that crashed), bytes, percent, and a breakdown
 *  carrying its own unit. */
const SNAPSHOT = {
  schema_version: "1.0",
  generated_at: "2026-07-29T14:17:07.455Z",
  sections: [
    {
      key: "datasets",
      label: "Datasets",
      source: "nemar-cli",
      updated_at: "2026-07-29T14:17:07.455Z",
      metrics: [
        {
          key: "datasets.public",
          label: "Public datasets",
          value: 754,
          total: 785,
          unit: "datasets",
          severity: "info",
          hint: "Active",
        },
        {
          key: "datasets.bytes",
          label: "Total data",
          value: 60810257409170,
          unit: "bytes",
          severity: "info",
        },
      ],
    },
    {
      // The section that broke production: its tiles carry `drilldown`.
      key: "archive",
      label: "Archives",
      source: "nemar-cli",
      updated_at: "2026-07-29T14:17:07.455Z",
      metrics: [
        {
          key: "archive.missing",
          label: "Missing archive",
          value: 32,
          total: 754,
          unit: "datasets",
          severity: "warn",
          drilldown: "archive.missing",
          hint: "Published but no archive",
        },
      ],
    },
    {
      key: "cf",
      label: "Edge traffic (30d)",
      source: "cloudflare",
      updated_at: "2026-07-29T14:17:07.455Z",
      metrics: [
        {
          key: "cf.cache_ratio",
          label: "Served from cache",
          value: 0.1,
          unit: "percent",
          severity: "info",
        },
        {
          key: "cf.bytes_by_host",
          label: "Bytes by host",
          value: 5,
          unit: "count",
          severity: "info",
          breakdown: [{ label: "data.nemar.org", value: 180000000 }],
          breakdown_unit: "bytes",
        },
      ],
    },
  ],
};

/** Run the page's client script with a minimal DOM and a stubbed snapshot
 *  fetch, returning the #sections tree it built. */
async function renderClientScript(
  snapshot: unknown,
  omitDayOffset?: number,
  deferTimeseries = false,
): Promise<{
  sections: FakeNode;
  meta: FakeNode;
  series: FakeNode;
  grouping: FakeNode;
  rangeStart: FakeNode;
  rangeEnd: FakeNode;
  seriesRequests: { url: string; respond: () => void }[];
  getTimeseriesFetchCount: () => number;
}> {
  const js = renderDashboardPage().match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
  expect(js.length).toBeGreaterThan(0);

  const sections = makeNode("div");
  const meta = makeNode("span");
  const byId: Record<string, FakeNode> = {
    sections,
    meta,
    "range-start": makeNode("input"),
    "range-end": makeNode("input"),
    grouping: makeNode("select"),
    series: makeNode("div"),
  };
  byId.grouping.value = "day";

  const document = {
    createElement: (tag: string) => makeNode(tag),
    createElementNS: (_ns: string, tag: string) => makeNode(tag),
    getElementById: (id: string) => byId[id] ?? makeNode("div"),
    querySelectorAll: () => [],
    addEventListener() {},
  };

  let settle: () => void;
  const done = new Promise<void>((r) => {
    settle = r;
  });
  const seriesRequests: { url: string; respond: () => void }[] = [];
  let timeseriesFetchCount = 0;
  function makeTimeseriesResponse(url: string) {
    const query = new URL(url, "https://test.local").searchParams;
    const start = query.get("start") ?? "2026-07-01";
    const end = query.get("end") ?? start;
    const points: { date: string; value: number }[] = [];
    let offset = 0;
    for (let cursor = start; cursor <= end; ) {
      if (offset !== omitDayOffset) points.push({ date: cursor, value: 1 });
      const next = new Date(`${cursor}T00:00:00.000Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      cursor = next.toISOString().slice(0, 10);
      offset++;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        series: [
          {
            section: "website",
            source: "umami",
            key: "views",
            label: "Pageviews",
            unit: "count",
            coverage_start: start,
            coverage_end: end,
            latest_observation_date: end,
            freshness_after_hours: 36,
            updated_at: "2026-07-03T12:00:00.000Z",
            points,
          },
        ],
      }),
    };
  }
  const fetchImpl = async (url: string) => {
    if (url.includes("/timeseries")) {
      timeseriesFetchCount++;
      if (deferTimeseries) {
        return await new Promise<unknown>((resolve) =>
          seriesRequests.push({ url, respond: () => resolve(makeTimeseriesResponse(url)) }),
        );
      }
      return makeTimeseriesResponse(url);
    }
    expect(url).toContain("/snapshot");
    return {
      ok: true,
      status: 200,
      json: async () => {
        queueMicrotask(() => queueMicrotask(() => settle()));
        return snapshot;
      },
    };
  };

  // Real script, real functions — only the browser surface is supplied.
  new Function("document", "fetch", "window", "localStorage", js)(
    document,
    fetchImpl,
    { addEventListener() {} },
    { getItem: () => null, setItem() {}, removeItem() {} },
  );
  await done;
  await new Promise((resolve) => setTimeout(resolve, 0));
  return {
    sections,
    meta,
    series: byId.series,
    grouping: byId.grouping,
    rangeStart: byId["range-start"],
    rangeEnd: byId["range-end"],
    seriesRequests,
    getTimeseriesFetchCount: () => timeseriesFetchCount,
  };
}

function tableValues(n: FakeNode): number[] {
  const cells: FakeNode[] = [];
  const visit = (node: FakeNode) => {
    if (node.tagName === "td") cells.push(node);
    node.children.forEach(visit);
  };
  visit(n);
  return cells
    .filter((_, index) => index % 2 === 1)
    .map((cell) => Number(cell.textContent))
    .filter(Number.isFinite);
}

describe("client script renders a real snapshot", () => {
  test("renders every section without throwing", async () => {
    const { sections } = await renderClientScript(SNAPSHOT);
    const text = textOf(sections);
    expect(text).toContain("Datasets");
    // The regression: this section is the one carrying a `drilldown` tile.
    expect(text).toContain("Archives");
    expect(text).toContain("Edge traffic (30d)");
    expect(text).toContain("4.2%"); // the existing value/total conversion-ratio case
    expect(text).toContain("Warning"); // collector-health warn is explicit, not color only
    // If rendering had thrown, load()'s catch would have appended this instead.
    expect(text).not.toContain("Could not load metrics");
    expect(attributeValues(sections, "role")).toContain("status");
  });

  test("a drilldown tile links to the admin portal", async () => {
    const { sections } = await renderClientScript(SNAPSHOT);
    const hrefs: string[] = [];
    const walk = (n: FakeNode) => {
      if (n.href) hrefs.push(n.href);
      for (const c of n.children) walk(c);
    };
    walk(sections);
    expect(hrefs).toContain("https://app.nemar.org/admin");
  });

  test("formats bytes, percent, and a byte-denominated breakdown", async () => {
    const { sections } = await renderClientScript(SNAPSHOT);
    const text = textOf(sections);
    expect(text).toContain("TB"); // datasets.bytes
    expect(text).toContain("0.1%"); // cf.cache_ratio, unit=percent
    expect(text).toContain("MB"); // breakdown_unit=bytes, not a raw integer
  });

  test("renders exact bucket values and marks missing days unknown", async () => {
    const { series } = await renderClientScript(SNAPSHOT, 2);
    const text = textOf(series);
    expect(attributeValues(series, "aria-label")).toContain("Pageviews by day in count");
    expect(text).toContain("Show exact values");
    expect(text).toContain("Unknown");
    expect(tableValues(series).reduce((sum, value) => sum + value, 0)).toBe(29);
  });

  test("week and month grouping sum the daily points", async () => {
    const { series, grouping, getTimeseriesFetchCount } = await renderClientScript(SNAPSHOT);
    grouping.value = "week";
    grouping.dispatch("change");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getTimeseriesFetchCount()).toBe(1);
    expect(attributeValues(series, "aria-label")).toContain("Pageviews by week in count");
    const weekly = tableValues(series);
    expect(weekly.reduce((sum, value) => sum + value, 0)).toBe(30);
    expect(weekly).toContain(7);

    grouping.value = "month";
    grouping.dispatch("change");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(attributeValues(series, "aria-label")).toContain("Pageviews by month in count");
    expect(tableValues(series).reduce((sum, value) => sum + value, 0)).toBe(30);
  });

  // renderBreakdown has two formatter branches and a >8 item cap; the fixture
  // above only exercised the bytes branch. Both branches live in the same
  // function, so an undefined identifier in either would crash a real render.
  test("caps a long breakdown at 8 rows and counts the remainder", async () => {
    const items = Array.from({ length: 12 }, (_, i) => ({ label: `mod${i}`, value: 12 - i }));
    const { sections } = await renderClientScript({
      ...SNAPSHOT,
      sections: [
        {
          key: "datasets",
          label: "Datasets",
          source: "nemar-cli",
          updated_at: "2026-07-29T14:17:07.455Z",
          metrics: [
            {
              key: "datasets.by_modality",
              label: "By modality",
              value: 754,
              unit: "datasets",
              severity: "info",
              breakdown: items,
            },
          ],
        },
      ],
    });
    const text = textOf(sections);
    // Non-bytes breakdown: plain counts, not humanBytes output.
    expect(text).toContain("mod0");
    expect(text).toContain("+4 more");
    expect(text).not.toContain("B ");
  });

  test("surfaces the section_errors banner when the snapshot reports one", async () => {
    const { sections } = await renderClientScript({
      ...SNAPSHOT,
      section_errors: [{ key: "sync", error: "D1_ERROR" }],
    });
    expect(textOf(sections)).toContain("sync");
  });

  test("page exposes grouping controls and renders an accessible chart with gaps", async () => {
    const html = renderDashboardPage();
    expect(html).toContain('data-range="7"');
    expect(html).toContain('id="grouping"');
    expect(html).toContain('id="range-start"');
    const { series } = await renderClientScript(SNAPSHOT, 2);
    expect(textOf(series)).toContain("Pageviews");
    expect(textOf(series)).toContain("incomplete buckets plot as gaps");
    expect(series.children[0]?.children[2]?.attributes.role).toBe("img");
  });

  test("a late response for an older range cannot replace the selected range", async () => {
    const { series, rangeStart, rangeEnd, seriesRequests } = await renderClientScript(
      SNAPSHOT,
      undefined,
      true,
    );
    expect(seriesRequests).toHaveLength(1);
    rangeStart.value = "2026-08-01";
    rangeEnd.value = "2026-08-02";
    rangeEnd.dispatch("change");
    expect(seriesRequests).toHaveLength(2);

    seriesRequests[1].respond();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(tableValues(series)).toHaveLength(2);
    seriesRequests[0].respond();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(tableValues(series)).toHaveLength(2);
  });

  test("uses full dates on chart axes when the selected range crosses years", async () => {
    const { series, rangeStart, rangeEnd } = await renderClientScript(SNAPSHOT);
    rangeStart.value = "2025-12-31";
    rangeEnd.value = "2026-01-02";
    rangeEnd.dispatch("change");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const chart = series.children[0]?.children[2];
    expect(textOf(chart)).toContain("2025-12-31");
    expect(textOf(chart)).toContain("2026-01-01");
  });

  test("explains the public API's maximum custom range", async () => {
    const { series, rangeStart, rangeEnd, getTimeseriesFetchCount } =
      await renderClientScript(SNAPSHOT);
    rangeStart.value = "2000-01-01";
    rangeEnd.value = "2026-01-01";
    rangeEnd.dispatch("change");
    expect(textOf(series)).toContain("3,660 days or fewer");
    expect(getTimeseriesFetchCount()).toBe(1);
  });
});
