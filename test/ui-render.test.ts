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
  style: Record<string, string>;
  children: FakeNode[];
  classList: {
    add(c: string): void;
    remove(c: string): void;
    toggle(c: string, on?: boolean): void;
  };
  appendChild(n: FakeNode): FakeNode;
  addEventListener(): void;
}

function makeNode(tagName: string): FakeNode {
  const node: FakeNode = {
    tagName,
    className: "",
    textContent: "",
    style: {},
    children: [],
    classList: { add() {}, remove() {}, toggle() {} },
    appendChild(child) {
      node.children.push(child);
      return child;
    },
    addEventListener() {},
  };
  return node;
}

/** Depth-first text of a rendered tree, for asserting what reached the page. */
function textOf(n: FakeNode): string {
  return [n.textContent, ...n.children.map(textOf)].join(" ");
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
): Promise<{ sections: FakeNode; meta: FakeNode }> {
  const js = renderDashboardPage().match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
  expect(js.length).toBeGreaterThan(0);

  const sections = makeNode("div");
  const meta = makeNode("span");
  const byId: Record<string, FakeNode> = { sections, meta };

  const document = {
    createElement: (tag: string) => makeNode(tag),
    getElementById: (id: string) => byId[id] ?? makeNode("div"),
    addEventListener() {},
  };

  let settle: () => void;
  const done = new Promise<void>((r) => {
    settle = r;
  });
  const fetchImpl = async (url: string) => {
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
  return { sections, meta };
}

describe("client script renders a real snapshot", () => {
  test("renders every section without throwing", async () => {
    const { sections } = await renderClientScript(SNAPSHOT);
    const text = textOf(sections);
    expect(text).toContain("Datasets");
    // The regression: this section is the one carrying a `drilldown` tile.
    expect(text).toContain("Archives");
    expect(text).toContain("Edge traffic (30d)");
    // If rendering had thrown, load()'s catch would have appended this instead.
    expect(text).not.toContain("Could not load metrics");
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

  // renderBreakdown has two formatter branches and a >8 item cap; the fixture
  // above only exercised the bytes branch. Both branches live in the same
  // function, so an undefined identifier in either would crash a real render.
  test("caps a long breakdown and counts the remainder", async () => {
    // BREAKDOWN_MAX is 24 (enough for the 23-bin size histogram); 30 items
    // therefore render 24 rows plus a "+6 more" line.
    const items = Array.from({ length: 30 }, (_, i) => ({ label: `mod${i}`, value: 30 - i }));
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
    expect(text).toContain("+6 more");
    expect(text).not.toContain("B ");
  });

  test("surfaces the section_errors banner when the snapshot reports one", async () => {
    const { sections } = await renderClientScript({
      ...SNAPSHOT,
      section_errors: [{ key: "sync", error: "D1_ERROR" }],
    });
    expect(textOf(sections)).toContain("sync");
  });
});
