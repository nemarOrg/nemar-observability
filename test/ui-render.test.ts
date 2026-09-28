import { describe, expect, test } from "bun:test";
import { CLIENT_JS } from "../src/routes/dashboard/client";
import { DASHBOARD_SECTIONS, renderDashboardPage } from "../src/routes/ui";

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
      "reach",
      "datasets",
      "pipelines",
    ]);
    for (const section of DASHBOARD_SECTIONS) {
      expect(html).toContain(`href="#${section.id}" data-nav-link>${section.label}</a>`);
      expect(html).toMatch(new RegExp(`<section id="${section.id}"[^>]*aria-labelledby=`));
    }
  });

  test("the overview has a headline and a KPI container that starts busy", () => {
    expect(html).toContain('<h1 id="overview-title"');
    expect(html).toContain('id="kpis" class="kpi-grid" aria-busy="true"');
    // Six placeholder cards hold the layout until data arrives.
    const kpiBlock = html.slice(html.indexOf('id="kpis"'), html.indexOf("</section>"));
    expect(kpiBlock.match(/class="card kpi"/g)?.length).toBe(6);
  });

  test("theme follows the system by default and the toggle overrides it per page view", () => {
    expect(html).toContain('<html lang="en" data-theme="system">');
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
    expect(html).toContain('id="theme-toggle"');
    // Dark tokens apply under the OS setting unless light was picked, and under
    // an explicit dark pick regardless of the OS setting.
    expect(html).toContain("@media (prefers-color-scheme: dark)");
    expect(html).toContain(':root:not([data-theme="light"])');
    expect(html).toContain(':root[data-theme="dark"]');
  });

  test("the status pill links to pipeline health and starts in a loading state", () => {
    expect(html).toMatch(/<a id="status-pill"[^>]*href="#pipelines"[^>]*data-state="loading"/);
    expect(html).toContain('id="health-summary"');
  });

  test("loading states are skeletons, and motion respects the reduced-motion setting", () => {
    expect(html).not.toContain("Loading…");
    expect(html).toContain('class="skeleton skeleton-chart"');
    expect(html).toContain("@media (prefers-reduced-motion: reduce)");
  });

  test("the page makes no external requests", () => {
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+rel="stylesheet"/i);
    expect(html).not.toMatch(/<img\b/i);
    expect(html).not.toContain("@import");
    expect(html).not.toMatch(/url\(\s*["']?https?:/i);
    // Every absolute URL is a plain link or the SVG namespace, never a fetched resource.
    const allowed = [
      "https://app.nemar.org/admin",
      "https://nemar.org",
      "https://docs.nemar.org",
      "http://www.w3.org/2000/svg",
    ];
    const urls = html.match(/https?:\/\/[^"'\s)<]+/g) ?? [];
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(allowed).toContain(url);
  });

  test("the client script is safe to inline and only reads", () => {
    // It lives in a String.raw template: a backtick or a dollar-brace would end
    // or interpolate the template instead of reaching the browser.
    expect(CLIENT_JS).not.toContain("`");
    expect(CLIENT_JS).not.toContain("${");
    // Data reaches the DOM through textContent, never parsed as markup.
    expect(CLIENT_JS).not.toContain("innerHTML");
    expect(CLIENT_JS).not.toContain("insertAdjacentHTML");
    // Every fetch is a default GET: no method, body, or credentials option.
    expect(CLIENT_JS).not.toMatch(/method\s*:/);
    expect(CLIENT_JS).not.toMatch(/body\s*:/);
    expect(CLIENT_JS).not.toMatch(/credentials\s*:/);
    const fetches = CLIENT_JS.match(/fetch\(API \+ "\/[a-z/]+/g) ?? [];
    expect(fetches.sort()).toEqual([
      'fetch(API + "/audience',
      'fetch(API + "/snapshot',
      'fetch(API + "/snapshot/history',
      'fetch(API + "/timeseries',
    ]);
  });
});
