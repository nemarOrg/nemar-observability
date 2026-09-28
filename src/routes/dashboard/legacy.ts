// Pre-redesign renderers kept working while their replacements land. Each
// later module retires part of this file; it goes away entirely once the
// snapshot sections are rebuilt.
//
// Part of the inlined client script (see client.ts): a String.raw template, so
// no backticks and no dollar-brace sequences.

export const LEGACY_JS = String.raw`
// A breakdown can be denominated differently from its tile: "Most read
// datasets" is a count of datasets whose bars are bytes each. metric.breakdown_unit
// carries that; absent, the bars share the tile's unit.
function renderBreakdown(parent, items, unit, style) {
  const max = items.reduce(function (m, it) { return Math.max(m, it.value); }, 0) || 1;
  const fmtVal = unit === "bytes" ? humanBytes : function (v) { return Number(v).toLocaleString(); };
  const ranked = style === "ranked";
  const list = el("div", "breakdown");
  function appendRows(target, rows) {
    rows.forEach(function (it) {
      const row = el("div", ranked ? "bd-row bd-ranked" : "bd-row");
      row.appendChild(el("span", "bd-label", it.label));
      // A ranked list prints its value; a bar there would restate it, and one
      // dominant entry would flatten the rest into identical stubs.
      if (!ranked) {
        const barWrap = el("span", "bd-bar");
        const bar = el("span", "bd-fill");
        bar.style.width = Math.max(2, (it.value / max) * 100) + "%";
        barWrap.appendChild(bar);
        row.appendChild(barWrap);
      }
      row.appendChild(el("span", "bd-val", fmtVal(it.value)));
      target.appendChild(row);
    });
  }
  const visibleCount = ranked ? 5 : BREAKDOWN_MAX;
  appendRows(list, items.slice(0, visibleCount));
  parent.appendChild(list);
  if (ranked && items.length > visibleCount) {
    const details = el("details", "breakdown-more");
    details.appendChild(el("summary", null, "Show all " + items.length + " datasets"));
    const remaining = el("div", "breakdown");
    appendRows(remaining, items.slice(visibleCount, BREAKDOWN_MAX));
    details.appendChild(remaining);
    if (items.length > BREAKDOWN_MAX) details.appendChild(el("div", "bd-more", "+" + (items.length - BREAKDOWN_MAX) + " more"));
    parent.appendChild(details);
  }
}

function tile(metric) {
  const t = el("div", "tile sev-" + (metric.severity || "info"));
  const heading = el("div", "tile-heading");
  heading.appendChild(el("div", "tile-label", metric.label));
  if (metric.hint) heading.appendChild(infoDisclosure("About " + metric.label, metric.hint));
  if (metric.severity === "warn" || metric.severity === "error") {
    const status = el("span", "tile-status status-" + metric.severity, metric.severity === "warn" ? "Warning" : "Error");
    status.setAttribute("role", "status");
    heading.appendChild(status);
  }
  t.appendChild(heading);
  const valRow = el("div", "tile-value");
  valRow.appendChild(el("span", "v", fmt(metric)));
  const p = pct(metric.value, metric.total);
  if (p != null) valRow.appendChild(el("span", "pct", p + "%"));
  t.appendChild(valRow);
  if (metric.total != null && metric.unit !== "bytes") {
    const barWrap = el("div", "pbar");
    const fill = el("div", "pfill");
    fill.style.width = Math.min(100, p || 0) + "%";
    barWrap.appendChild(fill);
    t.appendChild(barWrap);
  }
  if (metric.breakdown && metric.breakdown.length) renderBreakdown(t, metric.breakdown, metric.breakdown_unit || metric.unit, metric.breakdown_style);
  // A drilldown key used to open an in-page list gated by a pasted API token.
  // The list now lives in the admin portal behind a session cookie, so the tile
  // links there instead of asking anyone for a credential (#8).
  if (metric.drilldown) {
    const cta = el("a", "tile-cta", "Manage in admin portal ->");
    cta.href = ADMIN_PORTAL;
    cta.target = "_blank"; cta.rel = "noopener";
    t.appendChild(cta);
  }
  return t;
}

function renderSnapshot(snap) {
  const root = document.getElementById("sections");
  root.textContent = "";
  if (snap.section_errors && snap.section_errors.length) {
    const bar = el("div", "errbar");
    bar.appendChild(el("strong", null, "Some sections failed to load: "));
    bar.appendChild(el("span", null, snap.section_errors.map(function (e) { return e.key; }).join(", ")));
    bar.appendChild(el("span", " errbar-hint", " (data shown may be incomplete)"));
    root.appendChild(bar);
  }
  snap.sections.forEach(function (section) {
    const card = el("section", "card");
    const head = el("div", "card-head");
    head.appendChild(el("h2", null, section.label));
    head.appendChild(el("span", "src", section.source));
    card.appendChild(head);
    const grid = el("div", "tiles" + (section.layout === "split" ? " split" : ""));
    section.metrics.forEach(function (m) { grid.appendChild(tile(m)); });
    card.appendChild(grid);
    root.appendChild(card);
  });
  const ts = el("span", null, "Latest state generated " + new Date(snap.generated_at).toLocaleString());
  const meta = document.getElementById("health-meta");
  meta.textContent = "";
  meta.appendChild(ts);
}

function load() {
  fetch(API + "/snapshot")
    .then(function (r) { return r.json(); })
    .then(renderSnapshot)
    .catch(function () {
      document.getElementById("health-meta").textContent = "Could not load latest-state snapshot.";
      document.getElementById("sections").appendChild(el("p", "muted", "Could not load metrics."));
    });
}

`;
