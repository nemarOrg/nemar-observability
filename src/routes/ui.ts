// The dashboard page: one server-rendered HTML document with embedded CSS and a
// self-contained client script (DOM-built, no framework). It fetches the public
// read API under /observability/api and renders it. That is all it does.
//
// ZERO AUTH, ZERO WRITES (#8). This page holds no credential and performs no
// mutation. The approve/deny/delete controls and the paste-your-`nm_…`-API-key
// prompt are both gone: every action lives in the website admin portal on
// app.nemar.org, behind an HttpOnly host-scoped session cookie. A spoof of this
// origin now has nothing to steal and nothing to trigger.
//
// Metrics that have a `drilldown` key link out to the admin portal instead of
// opening a list here. GET /api/drilldown/:key still exists for programmatic
// use (Bearer, admin-only) and is removed in phase 3 (#13) once the website
// carries equivalent dataset-health lists (phase 2: nemar-cli#1032 + website#195).
//
// The page stores nothing in the browser. With no data-theme attribute the page
// follows the system color scheme, live; the toggle cycles system, dark, light
// for the current page view only, and a host that sets data-theme wins.
//
// No external requests: fonts are the system stack, icons are inline SVG, and
// the world map ships as path data from lib/world-map. Styles and the client
// script live in ./dashboard, one module per concern.

import {
  WORLD_COUNTRY_CODES_BY_NAME,
  WORLD_COUNTRY_MARKERS,
  WORLD_COUNTRY_NAMES,
  WORLD_COUNTRY_PATHS,
} from "../lib/world-map";
import { NEMAR_LOGO_SVG } from "./dashboard/brand";
import { CLIENT_JS } from "./dashboard/client";
import { STYLES } from "./dashboard/styles";

const WORLD_COUNTRY_PATHS_JSON = JSON.stringify(WORLD_COUNTRY_PATHS);
const WORLD_COUNTRY_MARKERS_JSON = JSON.stringify(WORLD_COUNTRY_MARKERS);
const WORLD_COUNTRY_NAMES_JSON = JSON.stringify(WORLD_COUNTRY_NAMES);
const WORLD_COUNTRY_CODES_BY_NAME_JSON = JSON.stringify(WORLD_COUNTRY_CODES_BY_NAME);

// Where every admin action lives (#8); the client script reads the same value.
export const ADMIN_PORTAL = "https://app.nemar.org/admin";

interface ChromeLink {
  label: string;
  href: string;
  /** Opens in a new tab with an arrow, as the website does for other hosts. */
  external?: boolean;
  current?: boolean;
}

// The NEMAR-wide links, in the website's order (website Nav.astro), with this
// dashboard added beside the Citation Dashboard as the cross-link.
export const NEMAR_LINKS: ChromeLink[] = [
  { label: "About", href: "https://nemar.org/about" },
  { label: "Discover", href: "https://nemar.org/discover" },
  { label: "Citation Dashboard", href: "/citations/" },
  { label: "Observability", href: "/observability", current: true },
  { label: "Documentation", href: "https://docs.nemar.org", external: true },
  { label: "Support", href: "https://nemar.org/support" },
];

// Footer columns as on nemar.org (website Footer.astro), plus Observability.
export const FOOTER_COLUMNS: { heading: string; links: ChromeLink[] }[] = [
  {
    heading: "Explore",
    links: [
      { label: "Discover", href: "https://nemar.org/discover" },
      { label: "Citations", href: "/citations/" },
      { label: "Observability", href: "/observability", current: true },
      { label: "Documentation", href: "https://docs.nemar.org", external: true },
    ],
  },
  {
    heading: "Project",
    links: [
      { label: "About", href: "https://nemar.org/about" },
      { label: "Support", href: "https://nemar.org/support" },
      { label: "Privacy Policy", href: "https://docs.nemar.org/policies/privacy/", external: true },
      { label: "Terms &amp; Policies", href: "https://docs.nemar.org/policies/", external: true },
    ],
  },
  {
    heading: "Data",
    links: [
      { label: "data.nemar.org", href: "https://data.nemar.org/", external: true },
      { label: "api.nemar.org", href: "https://api.nemar.org/", external: true },
      { label: "docs.nemar.org", href: "https://docs.nemar.org/", external: true },
      { label: "llms.txt", href: "https://nemar.org/llms.txt" },
    ],
  },
  {
    heading: "GitHub",
    links: [
      { label: "nemarOrg", href: "https://github.com/nemarOrg", external: true },
      { label: "nemarDatasets", href: "https://github.com/nemarDatasets", external: true },
    ],
  },
];

const MAKERS: ChromeLink[] = [
  { label: "SCCN", href: "https://sccn.ucsd.edu", external: true },
  { label: "SDSC", href: "https://www.sdsc.edu", external: true },
];
const PARTNERS: ChromeLink[] = [
  { label: "NIH", href: "https://www.nih.gov", external: true },
  { label: "AWS Open Data", href: "https://aws.amazon.com/opendata/", external: true },
  { label: "UC San Diego Library", href: "https://library.ucsd.edu", external: true },
  { label: "EZID", href: "https://ezid.cdlib.org", external: true },
  { label: "OpenNeuro", href: "https://openneuro.org", external: true },
  { label: "BIDS", href: "https://bids.neuroimaging.io", external: true },
  { label: "HED", href: "https://www.hedtags.org", external: true },
];

/** Anchor targets for the top bar, in page order. */
export const DASHBOARD_SECTIONS = [
  { id: "overview", label: "Overview" },
  { id: "usage", label: "Usage" },
  { id: "viewer", label: "Signal viewer" },
  { id: "reach", label: "Reach" },
  { id: "datasets", label: "Datasets" },
  { id: "pipelines", label: "Pipelines" },
] as const;

const icon = (paths: string[], cls = "icon") =>
  `<svg class="${cls}" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">${paths
    .map((d) => `<path d="${d}"/>`)
    .join("")}</svg>`;

// Theme icons use the NEMAR website's 24px strokes; the visible one names the
// current choice (monitor when following the system).
const themeIcon = (cls: string, body: string) =>
  `<svg class="theme-icon ${cls}" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
const THEME_ICONS = [
  themeIcon(
    "theme-system",
    '<rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/>',
  ),
  themeIcon("theme-dark", '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>'),
  themeIcon(
    "theme-light",
    '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>',
  ),
].join("");
const ICON_CALENDAR = icon([
  "M3 3.75h10a.75.75 0 0 1 .75.75v8.75H2.25V4.5A.75.75 0 0 1 3 3.75z",
  "M2.25 6.75h11.5M5.5 2.25v2.5M10.5 2.25v2.5",
]);
const ICON_MENU = icon(["M2.75 4.5h10.5M2.75 8h10.5M2.75 11.5h10.5"]);
const ICON_EXTERNAL = icon(["M6.5 3.5h6v6", "M12.5 3.5L4 12"]);
// The website's ExternalLink arrow.
const EXTERNAL_ARROW =
  '<svg class="external-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M7 17 17 7M9 7h8v8"/></svg>';

const chromeLink = (link: ChromeLink) =>
  link.external
    ? `<a href="${link.href}" target="_blank" rel="noopener noreferrer">${link.label}<span class="sr-only"> (opens in a new tab)</span>${EXTERNAL_ARROW}</a>`
    : `<a href="${link.href}"${link.current ? ' aria-current="page"' : ""}>${link.label}</a>`;
const nemarLinks = NEMAR_LINKS.map(chromeLink).join("");
const listOf = (links: ChromeLink[]) =>
  `<ul>${links.map((l) => `<li>${chromeLink(l)}</li>`).join("")}</ul>`;
const footerColumns = FOOTER_COLUMNS.map(
  (col) => `<div><h3>${col.heading}</h3>${listOf(col.links)}</div>`,
).join("");

const navLinks = DASHBOARD_SECTIONS.map(
  (s) => `<a href="#${s.id}" data-nav-link>${s.label}</a>`,
).join("");

const skeletonCard = (extra = "") =>
  `<div class="card skeleton-card"><div class="skeleton skeleton-title"></div>${extra}<div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line short"></div></div>`;
const KPI_SKELETONS = Array.from(
  { length: 4 },
  () =>
    '<div class="card kpi" aria-hidden="true"><div class="skeleton skeleton-line short"></div><div class="skeleton skeleton-value"></div><div class="skeleton skeleton-line"></div></div>',
).join("");
const ALL_TIME_SKELETONS = Array.from(
  { length: 5 },
  () =>
    '<div class="alltime-item" aria-hidden="true"><div class="skeleton skeleton-line short"></div><div class="skeleton skeleton-line"></div></div>',
).join("");
// Marks a block that shows the latest snapshot rather than the chosen dates.
const CURRENT_STATE = '<span class="scope-chip scope-current">Current state</span>';
// Marks a block that follows the range control; the client fills in the dates.
const RANGE_CHIP = '<span class="scope-chip scope-range" data-range-chip>Last 30 days</span>';
const GRID_SKELETON = `<div class="skeleton-grid">${skeletonCard()}${skeletonCard()}${skeletonCard()}</div>`;
const CHART_SKELETON =
  '<div class="card skeleton-card"><div class="skeleton skeleton-title"></div><div class="skeleton skeleton-chart"></div></div>';
const MAP_SKELETON =
  '<div class="geo-layout"><div class="card skeleton-card"><div class="skeleton skeleton-map"></div></div><div class="card skeleton-card"><div class="skeleton skeleton-title"></div><div class="skeleton skeleton-value"></div><div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line short"></div></div></div>';

const info = (label: string, text: string) =>
  `<details class="popover info"><summary class="info-trigger" aria-label="${label}">${icon([
    "M8 1.75a6.25 6.25 0 1 0 0 12.5a6.25 6.25 0 1 0 0-12.5z",
    "M8 7.3v3.7",
    "M8 5v.05",
  ])}</summary><div class="popover-panel info-panel"><p>${text}</p></div></details>`;

export function renderDashboardPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="light dark">
  <title>NEMAR Observability</title>
  <meta name="description" content="What the NEMAR open data archive holds, how it is used, and the current state of its data pipelines.">
  <meta name="robots" content="noindex">
  <style>${STYLES}</style>
</head>
<body>
  <a class="skip-link" href="#main">Skip to content</a>
  <div class="site-utility">
    <div class="container site-utility__inner">
      <nav class="site-utility__nav" aria-label="NEMAR">${nemarLinks}</nav>
    </div>
  </div>
  <header class="site-header">
    <div class="container site-header__inner">
      <a class="site-brand" href="/observability" aria-label="NEMAR Observability home">${NEMAR_LOGO_SVG}<span class="site-brand__product">Observability</span></a>
      <nav class="section-nav" aria-label="Page sections">${navLinks}</nav>
      <div class="site-header__actions">
        <button id="theme-toggle" class="icon-button theme-toggle" type="button" data-mode="system" aria-label="Theme: system. Switch to dark.">${THEME_ICONS}</button>
        <a class="pill-link portal-link" href="${ADMIN_PORTAL}" target="_blank" rel="noopener">Admin portal ${ICON_EXTERNAL}</a>
        <details class="popover nav-menu">
          <summary class="icon-button" aria-label="Open the menu">${ICON_MENU}</summary>
          <nav class="popover-panel nav-menu-panel" aria-label="Menu"><span class="menu-label">On this page</span>${navLinks}<hr><span class="menu-label">NEMAR</span>${nemarLinks}<hr><a href="${ADMIN_PORTAL}" target="_blank" rel="noopener">Admin portal</a></nav>
        </details>
      </div>
    </div>
    <div class="container filterbar">
      <div class="segmented range-presets" role="group" aria-label="Date range presets">
        <button type="button" data-range="7">7 days</button>
        <button type="button" data-range="30">30 days</button>
        <button type="button" data-range="90">90 days</button>
        <button type="button" data-range="365">1 year</button>
      </div>
      <details class="popover range-custom" id="range-custom">
        <summary aria-label="Choose custom dates">${ICON_CALENDAR}<span class="custom-label">Custom</span></summary>
        <div class="popover-panel range-custom-panel">
          <label class="field">Start date (UTC)<input id="range-start" type="date"></label>
          <label class="field">End date (UTC)<input id="range-end" type="date"></label>
          <p class="fine">Dates are whole UTC days. Ranges can span up to 3,660 days.</p>
        </div>
      </details>
      <p id="range-summary" class="range-summary" aria-live="polite">Last 30 days</p>
      <p id="range-announcer" class="sr-only" aria-live="polite"></p>
      <p class="filterbar-note">The dates drive the overview cards, usage, and reach. Blocks marked Current state show the latest hourly snapshot.</p>
    </div>
  </header>
  <main id="main">
    <section id="overview" class="hero" aria-labelledby="overview-title">
      <h1 id="overview-title" class="hero-title">NEMAR shares open neurophysiology data with researchers worldwide.</h1>
      <p class="hero-lede">The Neuroelectromagnetic Data Archive and Tools Resource (NEMAR) hosts open electroencephalography (EEG), magnetoencephalography (MEG), and related recordings. This page shows what the archive holds, how it is used, and the current state of its data pipelines.</p>
      <p class="kpi-scope">For the selected dates ${RANGE_CHIP}</p>
      <div id="kpis" class="kpi-grid" aria-busy="true">${KPI_SKELETONS}</div>
      <section class="alltime" aria-labelledby="alltime-title">
        <div class="alltime-head">
          <h2 id="alltime-title">All time</h2>
          <p>The catalog as it is now, and usage added up over every day a source has reported. These do not follow the date range.</p>
        </div>
        <dl id="all-time" class="alltime-grid" aria-busy="true">${ALL_TIME_SKELETONS}</dl>
      </section>
    </section>

    <section id="usage" aria-labelledby="usage-title">
      <div class="section-head">
        <div>
          <h2 id="usage-title">How is NEMAR being used?</h2>
          <p class="section-lede">Daily totals from each reporting source for the selected dates.</p>
        </div>
        <div class="section-tools">
          ${RANGE_CHIP}
          <label class="select-field">View by<select id="grouping"><option value="day">Day</option><option value="week">Calendar week</option><option value="month">Calendar month</option></select></label>
          ${info("How to read these charts", "Counts and bytes can be grouped by calendar week or month; the first and last groups may be partial and are drawn dashed. Days without data are shaded and left as gaps, because unknown is not zero. Visitor and session totals are queried for the selected range and are not added across days.")}
        </div>
      </div>
      <p id="range-note" class="range-note">All dates are UTC, with complete days through yesterday.</p>
      <div id="series" class="series-grid">${CHART_SKELETON}</div>
      <div class="subsection-head">
        <h3>Totals for the selected dates</h3>
        <p>Website activity and requests, each from its own source.</p>
      </div>
      <div id="audience">${GRID_SKELETON}</div>
      <div class="subsection-head">
        <h3>Rolling 30 days</h3>
        ${CURRENT_STATE}
        <p id="rolling-window">The 30 days up to the latest hourly snapshot. These do not follow the date range.</p>
      </div>
      <div id="usage-snapshot" class="stack">${GRID_SKELETON}</div>
    </section>

    <section id="viewer" aria-labelledby="viewer-title">
      <div class="section-head">
        <div>
          <h2 id="viewer-title">How is the signal viewer used?</h2>
          <p class="section-lede">The viewer opens on nemar.org, and other sites can embed it. The two filters count different things, viewer opens on our own pages and page loads of the embeddable viewer on partner pages, so they are shown separately and never added together.</p>
        </div>
        <div class="section-tools">
          ${RANGE_CHIP}
          <div class="segmented viewer-filter" role="group" aria-label="Where the viewer was used">
            <button type="button" data-viewer-filter="first" aria-pressed="true"><span>First-party</span><span class="viewer-filter-note">On nemar.org</span></button>
            <button type="button" data-viewer-filter="third" aria-pressed="false"><span>Third-party</span><span class="viewer-filter-note">Embedded elsewhere</span></button>
          </div>
          ${info("What each filter counts", "First-party counts times the signal viewer opened on a nemar.org page and actions taken inside it, from website analytics recorded after a visitor accepts them. Third-party counts page loads of the embeddable viewer on other sites, recorded by NEMAR's servers with no script on the partner's page. A viewer open and an embed page load are different events, so their counts are not comparable and are never summed.")}
        </div>
      </div>
      <div id="viewer-body" aria-busy="true">${GRID_SKELETON}</div>
    </section>

    <section id="reach" aria-labelledby="reach-title">
      <div class="section-head">
        <div>
          <h2 id="reach-title">Where are requests coming from?</h2>
          <p class="section-lede">Request counts by country at the network edge for the selected dates. Website sessions are shown separately when available.</p>
        </div>
        <div class="section-tools">
          <span class="scope-chip scope-range geography-period">Selected period (UTC)</span>
          ${info("About the location map", "The network edge counts requests for individual pages, files, images, and API calls; one page view can create many requests, and automated traffic is included. Website sessions are a separate measure. Data served from storage includes internal processing and has no location data.")}
        </div>
      </div>
      <div id="geography">${MAP_SKELETON}</div>
    </section>

    <section id="datasets" aria-labelledby="datasets-title">
      <div class="section-head">
        <div>
          <h2 id="datasets-title">What does NEMAR hold?</h2>
          <p class="section-lede">The public catalog by recording type, license, and size, from the latest hourly snapshot.</p>
        </div>
        <div class="section-tools">${CURRENT_STATE}</div>
      </div>
      <div id="catalog">${GRID_SKELETON}</div>
    </section>

    <section id="pipelines" aria-labelledby="pipelines-title">
      <div class="section-head">
        <div>
          <h2 id="pipelines-title">What is the latest state of datasets and pipelines?</h2>
          <p class="section-lede">Counts for archive building, Zarr conversion for in-browser viewing, OpenNeuro imports, publication review, and accounts. Admins manage these in the admin portal.</p>
        </div>
        <div class="section-tools">${CURRENT_STATE}</div>
      </div>
      <p id="health-meta" class="health-meta">Loading the latest snapshot.</p>
      <div id="sections" class="health-grid">${GRID_SKELETON}</div>
    </section>
  </main>
  <footer class="site-footer">
    <div class="container">
      <div class="site-footer__top">
        <div class="site-footer__about">
          <h2 class="site-footer__heading">NEMAR</h2>
          <p>The Neuroelectromagnetic Data Archive and Tools Resource. Funded by the National Institutes of Health under award number NIMH R24MH120037.</p>
          <p class="site-footer__caveat">Opinions, findings, and conclusions are those of the authors and do not necessarily reflect the views of the National Institutes of Health or any other sponsor.</p>
        </div>
        <nav class="site-footer__nav" aria-label="Footer">${footerColumns}</nav>
      </div>
      <div class="site-footer__sources">
        <p class="site-footer__label">About Observability</p>
        <p>This dashboard is read-only and stores nothing in your browser. Catalog and pipeline figures come from the NEMAR database in an hourly snapshot; usage comes from Cloudflare zone analytics, AWS S3 CloudWatch metrics for the NEMAR bucket, and anonymous Umami website analytics where configured. Requests and sessions are not people, and storage bytes include internal reads.</p>
      </div>
      <div class="site-footer__credits">
        <p class="site-footer__label">A project of</p>
        ${listOf(MAKERS)}
        <p class="site-footer__label">Sponsors and partners</p>
        ${listOf(PARTNERS)}
      </div>
      <div class="site-footer__bottom">
        <span>&copy; ${new Date().getUTCFullYear()} The Regents of the University of California</span>
        <a href="/">All NEMAR dashboards</a>
      </div>
    </div>
  </footer>
  <script>const ADMIN_PORTAL = ${JSON.stringify(ADMIN_PORTAL)};const WORLD_COUNTRY_PATHS = ${WORLD_COUNTRY_PATHS_JSON};const WORLD_COUNTRY_MARKERS = ${WORLD_COUNTRY_MARKERS_JSON};const WORLD_COUNTRY_NAMES = ${WORLD_COUNTRY_NAMES_JSON};const WORLD_COUNTRY_CODES_BY_NAME = ${WORLD_COUNTRY_CODES_BY_NAME_JSON};${CLIENT_JS}</script>
</body>
</html>`;
}
