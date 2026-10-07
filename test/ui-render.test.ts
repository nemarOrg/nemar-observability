import { describe, expect, test } from "bun:test";
import { CLIENT_JS } from "../src/routes/dashboard/client";
import {
  ADMIN_PORTAL,
  DASHBOARD_SECTIONS,
  FOOTER_COLUMNS,
  NEMAR_LINKS,
  renderDashboardPage,
} from "../src/routes/ui";

describe("public dashboard page", () => {
  test("renders question-led sections and UTC range controls", () => {
    const html = renderDashboardPage();

    expect(html).toContain("How is NEMAR being used?");
    expect(html).toContain('data-range="7"');
    expect(html).toContain('data-range="30"');
    expect(html).toContain('data-range="90"');
    expect(html).toContain('data-range="365"');
    expect(html).toContain('id="range-start"');
    expect(html).toContain('id="range-end"');
    expect(html).toContain('id="grouping"');
    expect(html).toContain("Calendar week");
    expect(html).toContain("Calendar month");
    expect(html).toContain("Where are requests coming from?");
    expect(html).toContain("What does NEMAR hold?");
    expect(html).toContain("What is the latest state of datasets and pipelines?");
  });
});

describe("dashboard shell", () => {
  const html = renderDashboardPage();

  test("the top bar links every section and every anchor has a target", () => {
    expect(DASHBOARD_SECTIONS.map((s) => s.id)).toEqual([
      "overview",
      "usage",
      "viewer",
      "reach",
      "datasets",
      "pipelines",
    ]);
    for (const section of DASHBOARD_SECTIONS) {
      expect(html).toContain(`href="#${section.id}" data-nav-link>${section.label}</a>`);
      expect(html).toMatch(new RegExp(`<section id="${section.id}"[^>]*aria-labelledby=`));
    }
  });

  test("the overview has a headline, range KPIs, and an all-time strip that start busy", () => {
    expect(html).toContain('<h1 id="overview-title"');
    expect(html).toContain('id="kpis" class="kpi-grid" aria-busy="true"');
    // Four placeholder cards hold the layout until the range data arrives.
    const kpiBlock = html.slice(html.indexOf('id="kpis"'), html.indexOf('class="alltime"'));
    expect(kpiBlock.match(/class="card kpi"/g)?.length).toBe(4);
    // The all-time strip sits after the range cards, inside the overview.
    const overview = html.slice(
      html.indexOf('<section id="overview"'),
      html.indexOf('<section id="usage"'),
    );
    expect(overview.indexOf('id="kpis"')).toBeLessThan(overview.indexOf('id="all-time"'));
    expect(overview).toContain('<dl id="all-time" class="alltime-grid" aria-busy="true">');
    expect(overview).toContain(">All time</h2>");
  });

  test("range-driven blocks name their dates, and snapshot blocks say Current state", () => {
    const section = (id: string) =>
      html.slice(
        html.indexOf(`<section id="${id}"`),
        html.indexOf("</section>", html.indexOf(`<section id="${id}"`)),
      );
    // The overview cards and the usage section follow the range control.
    expect(section("overview")).toContain("data-range-chip");
    expect(section("usage").slice(0, section("usage").indexOf("Rolling 30 days"))).toContain(
      "data-range-chip",
    );
    // Figures from the latest snapshot are labeled as such, never as a range.
    for (const id of ["datasets", "pipelines"]) {
      expect(section(id)).toContain('<span class="scope-chip scope-current">Current state</span>');
      expect(section(id)).not.toContain("data-range-chip");
    }
    const rolling = section("usage").slice(section("usage").indexOf("Rolling 30 days"));
    expect(rolling).toContain("Current state");
    expect(rolling).toContain('id="rolling-window"');
    expect(html).not.toContain("Rolling 30-day measures");
    // The client fills every chip from the one range control, and keeps the
    // fixed-window copies of range-driven metrics out of the rolling group.
    expect(CLIENT_JS).toContain('querySelectorAll("[data-range-chip]")');
    expect(CLIENT_JS).toContain('const RANGE_DRIVEN_METRICS = ["cf.requests", "cf.by_country"];');
  });

  test("theme follows the system by default and the toggle overrides it per page view", () => {
    // No data-theme on the root: the media query alone decides, and a host that
    // sets data-theme (an embedding viewer) is not fighting a server value.
    expect(html).toContain('<html lang="en">');
    expect(html).not.toMatch(/<html[^>]*data-theme/);
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
    expect(html).toMatch(/<button id="theme-toggle"[^>]*data-mode="system"/);
    for (const mode of ["theme-system", "theme-dark", "theme-light"]) expect(html).toContain(mode);
    // Light tokens on bare :root; dark under the OS setting unless light was
    // picked, and under an explicit dark pick regardless of the OS setting.
    const css = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
    expect(css).toMatch(/:root \{[^}]*--bg:/);
    expect(css).toMatch(
      /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \{[^}]*--bg:/,
    );
    expect(css).toMatch(/:root\[data-theme="dark"\] \{[^}]*--bg:/);
    expect(css).toMatch(/body \{[^}]*background: var\(--bg\)/);
    // The choice is never persisted.
    expect(CLIENT_JS).not.toContain("sessionStorage");
    expect(CLIENT_JS).not.toContain("document.cookie");
    expect(CLIENT_JS).toContain('removeAttribute("data-theme")');
  });

  test("the public page renders no global health verdict", () => {
    // Pipeline cards show current state; status belongs to the admin portal.
    for (const text of [
      "status-pill",
      "need attention",
      "health-summary",
      "Everything is healthy",
    ]) {
      expect(html).not.toContain(text);
    }
    expect(CLIENT_JS).not.toMatch(/badge\("(warn|error)"/);
    expect(html).toContain('id="sections"');
  });

  test("loading states are skeletons, and motion respects the reduced-motion setting", () => {
    expect(html).not.toContain("Loading…");
    expect(html).toContain('class="skeleton skeleton-chart"');
    expect(html).toContain("@media (prefers-reduced-motion: reduce)");
  });

  test("the stylesheet is well formed", () => {
    // A cut rule silently drops every rule after it, so check the braces balance
    // and that no selector list ends in a dangling comma.
    const css = html.slice(html.indexOf("<style>") + 7, html.indexOf("</style>"));
    let depth = 0;
    let lowest = 0;
    for (const ch of css) {
      if (ch === "{") depth++;
      if (ch === "}") depth--;
      lowest = Math.min(lowest, depth);
    }
    expect(lowest).toBe(0);
    expect(depth).toBe(0);
    expect(css).not.toMatch(/,\s*\}/);
  });

  test("the page makes no external requests", () => {
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/<img\b/i);
    expect(html).not.toMatch(/<(iframe|video|audio|source|object|embed)\b/i);
    expect(html).not.toContain("@import");
    expect(html).not.toMatch(/url\(\s*["']?https?:/i);
    // In the markup an absolute URL is only ever a link target or the SVG
    // namespace; in the script only the admin portal link and the namespace.
    const script = html.slice(html.indexOf("<script>"), html.indexOf("</script>"));
    const markup = html.replace(script, "");
    const inMarkup = [...markup.matchAll(/(\S{0,7})(https?:\/\/[^"'\s)<]+)/g)];
    expect(inMarkup.length).toBeGreaterThan(0);
    for (const [, before, url] of inMarkup) {
      expect(['href="', 'xmlns="'].some((ctx) => before.endsWith(ctx))).toBe(true);
      expect(url).toMatch(/^https:\/\/|^http:\/\/www\.w3\.org\/2000\/svg$/);
    }
    const inScript = new Set(script.match(/https?:\/\/[^"'\s)<]+/g) ?? []);
    expect([...inScript].sort()).toEqual([
      "http://www.w3.org/2000/svg",
      "https://app.nemar.org/admin",
    ]);
  });

  test("the header and footer carry the NEMAR website links and cross-link Citations", () => {
    const utility = html.slice(html.indexOf('class="site-utility__nav"'), html.indexOf("</nav>"));
    const labels = [...utility.matchAll(/<a href="([^"]+)"[^>]*>([^<]+)/g)].map((m) => [
      m[2],
      m[1],
    ]);
    expect(labels).toEqual(NEMAR_LINKS.map((l) => [l.label, l.href]));
    expect(NEMAR_LINKS.map((l) => l.label)).toEqual([
      "About",
      "Discover",
      "Citation Dashboard",
      "Observability",
      "Documentation",
      "Support",
    ]);
    expect(utility).toContain('<a href="/observability" aria-current="page">Observability</a>');
    expect(utility).toContain('<a href="/citations/">Citation Dashboard</a>');
    // The website's logo is inlined, and the brand links to this dashboard.
    expect(html).toMatch(
      /<a class="site-brand" href="\/observability"[^>]*><svg class="brand-logo"/,
    );
    const footer = html.slice(
      html.indexOf('<footer class="site-footer">'),
      html.indexOf("</footer>"),
    );
    expect(FOOTER_COLUMNS.map((c) => c.heading)).toEqual(["Explore", "Project", "Data", "GitHub"]);
    for (const column of FOOTER_COLUMNS) {
      expect(footer).toContain(`<h3>${column.heading}</h3>`);
      for (const link of column.links) expect(footer).toContain(`href="${link.href}"`);
    }
    expect(footer).toContain("NIMH R24MH120037");
    expect(footer).toContain("About Observability");
    // Links to other hosts open in a new tab and say so.
    expect(html).toContain(
      'href="https://docs.nemar.org" target="_blank" rel="noopener noreferrer">Documentation<span class="sr-only"> (opens in a new tab)</span>',
    );
  });

  test("accessibility: names, live regions, focus, and forced colors", () => {
    // Preset buttons say what they do, with no accessible name that differs
    // from the visible one (WCAG 2.5.3).
    const presets = [...html.matchAll(/<button type="button" data-range="(\d+)"([^>]*)>([^<]+)</g)];
    expect(presets.map((m) => m[3])).toEqual(["7 days", "30 days", "90 days", "1 year"]);
    for (const m of presets) expect(m[2]).not.toContain("aria-label");
    // Only the range summary and one announcer are live;
    // the headline and the big containers are not.
    const live = [...html.matchAll(/<(\w+)[^>]*id="([^"]+)"[^>]*aria-live=/g)].map((m) => m[2]);
    expect(live.sort()).toEqual(["range-announcer", "range-summary"]);
    expect(html).toContain('<h1 id="overview-title" class="hero-title">');
    // Anchors and focused elements stop below the sticky header.
    const css = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
    expect(css).toMatch(/html \{[^}]*scroll-padding-top: calc\(var\(--topbar-h\) \+ 16px\)/);
    // The pressed preset is marked by more than color, and in forced colors.
    expect(css).toMatch(
      /\.segmented button\[aria-pressed="true"\] \{[^}]*inset 0 -2px 0 var\(--accent\)/,
    );
    expect(css).toMatch(
      /@media \(forced-colors: active\) \{\s*\.segmented button\[aria-pressed="true"\], \.section-nav a\[aria-current="true"\]/,
    );
    // Exact values are read to screen readers, not hidden in title tooltips.
    expect(CLIENT_JS).not.toContain('setAttribute("title", spec.exact)');
    expect(CLIENT_JS).toContain("function figure(tag, cls, visible, exact)");
    // The map is one image with a summary and a readout, and tables mark
    // their header cells.
    expect(CLIENT_JS).toContain('role: "img", class: "geography-map", tabindex: "0"');
    expect(CLIENT_JS).toContain('readout.setAttribute("aria-live", "polite")');
    expect(CLIENT_JS).toContain('scoped(el("th", null, it.label), "row")');
  });

  test("the admin portal URL is written once and shared with the script", () => {
    expect(ADMIN_PORTAL).toBe("https://app.nemar.org/admin");
    expect(html).toContain(`<script>const ADMIN_PORTAL = ${JSON.stringify(ADMIN_PORTAL)};`);
    expect(html).toContain(`href="${ADMIN_PORTAL}"`);
    expect(CLIENT_JS).not.toContain("https://app.nemar.org");
  });

  test("the page names sources in plain words, not vendor names", () => {
    // Visible text says "network edge", "website analytics", and "storage";
    // the footer's data-sources note and partner links are where vendors are
    // named on purpose.
    const literals = CLIENT_JS.match(/"(?:[^"\\]|\\.)*"/g) ?? [];
    expect(literals.filter((s) => /Cloudflare|Umami|\bS3\b/.test(s))).toEqual([]);
    const markup = html
      .slice(0, html.indexOf("<script>"))
      .replace(/<style>[\s\S]*?<\/style>/, "")
      .replace(/<footer[\s\S]*<\/footer>/, "");
    expect(markup).not.toMatch(/Cloudflare|Umami|\bS3\b/);
    expect(CLIENT_JS).toContain('"Manage in admin portal (administrators)"');
    expect(CLIENT_JS).toContain('"Review in admin portal (administrators)"');
  });

  test("the client script is safe to inline and only reads", () => {
    // It lives in a String.raw template: a backtick or a dollar-brace would end
    // or interpolate the template instead of reaching the browser.
    expect(CLIENT_JS).not.toContain("`");
    expect(CLIENT_JS).not.toContain("${");
    // Data reaches the DOM through textContent, never parsed as markup.
    expect(CLIENT_JS).not.toContain("innerHTML");
    expect(CLIENT_JS).not.toContain("insertAdjacentHTML");
    expect(CLIENT_JS).not.toContain("outerHTML");
    expect(CLIENT_JS).not.toContain("document.write");
    // No string ever runs as code.
    expect(CLIENT_JS).not.toMatch(/\beval\s*\(/);
    expect(CLIENT_JS).not.toMatch(/\bnew Function\b/);
    expect(CLIENT_JS).not.toMatch(/set(Timeout|Interval)\(\s*["']/);
    // Every fetch is a default GET: no method, body, or credentials option.
    expect(CLIENT_JS).not.toMatch(/method\s*:/);
    expect(CLIENT_JS).not.toMatch(/body\s*:/);
    expect(CLIENT_JS).not.toMatch(/credentials\s*:/);
    // One fetch call site, a bare GET to the public API, and the five reads
    // that go through it.
    expect(CLIENT_JS.match(/\bfetch\(/g) ?? []).toEqual(["fetch("]);
    expect(CLIENT_JS).toContain("return fetch(API + path)");
    const reads = [...CLIENT_JS.matchAll(/getJson\("(\/[a-z/]+)/g)].map((m) => m[1]);
    expect(reads.sort()).toEqual([
      "/audience",
      "/embeds",
      "/snapshot",
      "/snapshot/history",
      "/timeseries",
    ]);
  });
});
