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
import { CLIENT_JS } from "./dashboard/client";
import { STYLES } from "./dashboard/styles";

const WORLD_COUNTRY_PATHS_JSON = JSON.stringify(WORLD_COUNTRY_PATHS);
const WORLD_COUNTRY_MARKERS_JSON = JSON.stringify(WORLD_COUNTRY_MARKERS);
const WORLD_COUNTRY_NAMES_JSON = JSON.stringify(WORLD_COUNTRY_NAMES);
const WORLD_COUNTRY_CODES_BY_NAME_JSON = JSON.stringify(WORLD_COUNTRY_CODES_BY_NAME);

const ADMIN_PORTAL = "https://app.nemar.org/admin";

/** Anchor targets for the top bar, in page order. */
export const DASHBOARD_SECTIONS = [
  { id: "overview", label: "Overview" },
  { id: "usage", label: "Usage" },
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
// An EEG-like trace: the archive's subject matter, drawn as the brand mark.
const BRAND_MARK =
  '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M3 13h3.2l1.6-4.5 2.6 9 2.7-11 2.2 8.2 1.3-1.7H21"/></svg>';

const navLinks = DASHBOARD_SECTIONS.map(
  (s) => `<a href="#${s.id}" data-nav-link>${s.label}</a>`,
).join("");

const skeletonCard = (extra = "") =>
  `<div class="card skeleton-card"><div class="skeleton skeleton-title"></div>${extra}<div class="skeleton skeleton-line"></div><div class="skeleton skeleton-line short"></div></div>`;
const KPI_SKELETONS = Array.from(
  { length: 6 },
  () =>
    '<div class="card kpi" aria-hidden="true"><div class="skeleton skeleton-line short"></div><div class="skeleton skeleton-value"></div><div class="skeleton skeleton-line"></div></div>',
).join("");
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
  <meta name="description" content="What the NEMAR open data archive holds, how it is used, and whether its data pipelines are healthy.">
  <meta name="robots" content="noindex">
  <style>${STYLES}</style>
</head>
<body>
  <a class="skip-link" href="#main">Skip to content</a>
  <header class="topbar">
    <div class="topbar-row">
      <a class="brand" href="#overview" aria-label="NEMAR Observability, back to the overview">
        <span class="brand-mark">${BRAND_MARK}</span>
        <span class="brand-name">NEMAR</span>
        <span class="brand-product">Observability</span>
      </a>
      <nav class="topnav" aria-label="Page sections">${navLinks}</nav>
      <div class="topbar-actions">
        <button id="theme-toggle" class="icon-button theme-toggle" type="button" data-mode="system" aria-label="Theme: system. Switch to dark.">${THEME_ICONS}</button>
        <a class="button portal-link" href="${ADMIN_PORTAL}" target="_blank" rel="noopener">Admin portal ${ICON_EXTERNAL}</a>
        <details class="popover nav-menu">
          <summary class="icon-button" aria-label="Open the section menu">${ICON_MENU}</summary>
          <nav class="popover-panel nav-menu-panel" aria-label="Page sections">${navLinks}<hr><a href="${ADMIN_PORTAL}" target="_blank" rel="noopener">Admin portal</a></nav>
        </details>
      </div>
    </div>
    <div class="filterbar">
      <div class="segmented range-presets" role="group" aria-label="Date range presets">
        <button type="button" data-range="7" aria-label="Last 7 days">7d</button>
        <button type="button" data-range="30" aria-label="Last 30 days">30d</button>
        <button type="button" data-range="90" aria-label="Last 90 days">90d</button>
        <button type="button" data-range="365" aria-label="Last 365 days">1y</button>
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
      <p class="filterbar-note">The date range applies to usage and reach. Catalog and pipeline figures come from the latest hourly snapshot.</p>
    </div>
  </header>
  <main id="main">
    <section id="overview" class="hero" aria-labelledby="overview-title">
      <h1 id="overview-title" class="hero-title" aria-live="polite">NEMAR shares open neurophysiology data with researchers worldwide.</h1>
      <p class="hero-lede">The Neuroelectromagnetic Data Archive and Tools Resource (NEMAR) hosts open electroencephalography (EEG), magnetoencephalography (MEG), and related recordings. This page shows what the archive holds, how it is used, and whether its data pipelines are healthy.</p>
      <div id="kpis" class="kpi-grid" aria-busy="true">${KPI_SKELETONS}</div>
    </section>

    <section id="usage" aria-labelledby="usage-title">
      <div class="section-head">
        <div>
          <h2 id="usage-title">How is NEMAR being used?</h2>
          <p class="section-lede">Daily totals from each reporting source for the selected dates.</p>
        </div>
        <div class="section-tools">
          <label class="select-field">View by<select id="grouping"><option value="day">Day</option><option value="week">Calendar week</option><option value="month">Calendar month</option></select></label>
          ${info("How to read these charts", "Counts and bytes can be grouped by calendar week or month; the first and last groups may be partial and are drawn dashed. Days without data are shaded and left as gaps, because unknown is not zero. Visitor and session totals are queried for the selected range and are not added across days.")}
        </div>
      </div>
      <p id="range-note" class="range-note">All dates are UTC, with complete days through yesterday.</p>
      <div id="series" class="series-grid" aria-live="polite">${CHART_SKELETON}</div>
      <div class="subsection-head">
        <h3>Totals for the selected dates</h3>
        <p>Website activity and requests, each from its own source.</p>
      </div>
      <div id="audience" aria-live="polite">${GRID_SKELETON}</div>
      <div class="subsection-head">
        <h3>Rolling 30-day measures</h3>
        <p>From the latest hourly snapshot; these do not follow the date range.</p>
      </div>
      <div id="usage-snapshot" class="stack" aria-live="polite">${GRID_SKELETON}</div>
    </section>

    <section id="reach" aria-labelledby="reach-title">
      <div class="section-head">
        <div>
          <h2 id="reach-title">Where are requests coming from?</h2>
          <p class="section-lede">Cloudflare request counts by country for the selected dates. Website sessions are shown separately when available.</p>
        </div>
        <div class="section-tools">
          <span class="geography-period">Selected period (UTC)</span>
          ${info("About the location map", "Cloudflare counts requests for individual pages, files, images, and API calls; one page view can create many requests, and automated traffic is included. Website sessions are a separate measure. S3 bucket downloads include internal reads and have no location data.")}
        </div>
      </div>
      <div id="geography" aria-live="polite">${MAP_SKELETON}</div>
    </section>

    <section id="datasets" aria-labelledby="datasets-title">
      <div class="section-head">
        <div>
          <h2 id="datasets-title">What does NEMAR hold?</h2>
          <p class="section-lede">The public catalog by recording type, license, and size, from the latest hourly snapshot.</p>
        </div>
      </div>
      <div id="catalog" aria-live="polite">${GRID_SKELETON}</div>
    </section>

    <section id="pipelines" aria-labelledby="pipelines-title">
      <div class="section-head">
        <div>
          <h2 id="pipelines-title">What is the latest state of datasets and pipelines?</h2>
          <p class="section-lede">Counts for archive building, Zarr conversion for in-browser viewing, OpenNeuro imports, publication review, and accounts. Admins manage these in the admin portal.</p>
        </div>
      </div>
      <p id="health-meta" class="health-meta" aria-live="polite">Loading the latest snapshot.</p>
      <div id="sections" class="health-grid">${GRID_SKELETON}</div>
    </section>
  </main>
  <footer class="page-footer">
    <p>NEMAR Observability is read-only. It stores nothing in your browser and makes no changes to NEMAR.</p>
    <nav aria-label="Related links"><a href="/">All dashboards</a><a href="https://nemar.org">nemar.org</a><a href="https://docs.nemar.org">Documentation</a><a href="${ADMIN_PORTAL}" target="_blank" rel="noopener">Admin portal</a></nav>
  </footer>
  <script>const WORLD_COUNTRY_PATHS = ${WORLD_COUNTRY_PATHS_JSON};const WORLD_COUNTRY_MARKERS = ${WORLD_COUNTRY_MARKERS_JSON};const WORLD_COUNTRY_NAMES = ${WORLD_COUNTRY_NAMES_JSON};const WORLD_COUNTRY_CODES_BY_NAME = ${WORLD_COUNTRY_CODES_BY_NAME_JSON};${CLIENT_JS}</script>
</body>
</html>`;
}
