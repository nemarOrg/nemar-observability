// The dashboard page: one server-rendered HTML document with embedded CSS and a
// self-contained client script (DOM-built, no framework). It fetches
// /observability/api/snapshot and renders tiles. That is all it does.
//
// ZERO AUTH, ZERO WRITES (#8). This page holds no credential and performs no
// mutation. The approve/deny/delete controls and the paste-your-`nm_…`-API-key
// prompt are both gone: every action lives in the website admin portal on
// app.nemar.org, behind an HttpOnly host-scoped session cookie. A spoof of this
// origin now has nothing to steal and nothing to trigger.
//
// Tiles that have a `drilldown` key link out to the admin portal instead of
// opening a list here. GET /api/drilldown/:key still exists for programmatic
// use (Bearer, admin-only) and is removed in phase 3 (#13) once the website
// carries equivalent dataset-health lists (phase 2: nemar-cli#1032 + website#195).
//
// The client script deliberately avoids template literals and innerHTML for
// data (uses createElement/textContent) so it is safe inside this TS template
// and free of injection from dataset ids / labels.

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

export function renderDashboardPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>NEMAR Observability</title>
  <meta name="robots" content="noindex">
  <style>${STYLES}</style>
</head>
<body>
  <header>
    <h1>NEMAR Observability</h1>
    <span class="sub">usage and latest dataset &amp; pipeline health</span>
    <span class="spacer"></span>
    <a class="portal" href="https://app.nemar.org/admin" target="_blank" rel="noopener">Admin portal &rarr;</a>
  </header>
  <main>
    <section class="card usage-card">
      <h2>How is NEMAR being used?</h2>
      <p class="health-intro">Daily totals from each reporting source.</p>
      <div class="series-controls">
        <button type="button" data-range="7">Last 7 days</button>
        <button type="button" data-range="30">Last 30 days</button>
        <button type="button" data-range="90">Last 90 days</button>
        <button type="button" data-range="365">Last 365 days</button>
        <label>Start date (UTC)<input id="range-start" type="date"></label>
        <label>End date (UTC)<input id="range-end" type="date"></label>
        <label>View by<select id="grouping"><option value="day">Day</option><option value="week">Calendar week</option><option value="month">Calendar month</option></select></label>
      </div>
      <p id="range-note" class="range-note">UTC · complete days through yesterday</p>
      <details class="range-help">
        <summary>How to read these charts</summary>
        <p>Counts and bytes can be grouped by week or month. Visitor and session totals are queried for the selected range and are not added across days.</p>
      </details>
      <div id="series" aria-live="polite"></div>
    </section>
    <section class="card">
      <h2>What activity happens on the website?</h2>
      <p class="health-intro">Website activity and Cloudflare requests for the selected dates.</p>
      <div id="audience" aria-live="polite"><p class="muted">Loading audience metrics…</p></div>
    </section>
    <section class="card geography-card">
      <div class="geography-heading">
        <div>
          <h2>Where are requests coming from?</h2>
          <p class="health-intro">Cloudflare request counts by country for the selected dates. Website sessions are shown separately when available.</p>
        </div>
        <span class="geography-period">Selected period · UTC</span>
        <details class="info-disclosure">
          <summary class="info-icon" aria-label="About the location map">i</summary>
          <span class="info-content">Cloudflare counts requests for individual pages, files, images, and API calls; one page view can create many requests, and automated traffic is included. Website sessions are a separate measure. S3 bucket downloads include internal reads and have no location data.</span>
        </details>
      </div>
      <div id="geography" aria-live="polite"><p class="muted">Loading country activity…</p></div>
    </section>
    <section class="card">
      <h2>What is the latest state of datasets and pipelines?</h2>
      <p class="health-intro">Latest snapshot.</p>
      <p id="health-meta" class="health-meta" aria-live="polite">Loading latest-state snapshot…</p>
      <div id="sections"></div>
    </section>
  </main>
  <script>const WORLD_COUNTRY_PATHS = ${WORLD_COUNTRY_PATHS_JSON};const WORLD_COUNTRY_MARKERS = ${WORLD_COUNTRY_MARKERS_JSON};const WORLD_COUNTRY_NAMES = ${WORLD_COUNTRY_NAMES_JSON};const WORLD_COUNTRY_CODES_BY_NAME = ${WORLD_COUNTRY_CODES_BY_NAME_JSON};${CLIENT_JS}</script>
</body>
</html>`;
}
