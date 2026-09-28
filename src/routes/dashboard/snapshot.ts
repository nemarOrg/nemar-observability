// Latest-snapshot sections: the pipeline state cards, the catalog cards, and
// the rolling 30-day tiles. None of these follow the date range, so each group
// is labeled Current state, and the page never renders a global health
// verdict: admins see status in their portal.
//
// Part of the inlined client script (see client.ts): a String.raw template, so
// no backticks and no dollar-brace sequences.

export const SNAPSHOT_JS = String.raw`
const CATALOG_SECTIONS = ["datasets", "sizes"];
const USAGE_SECTIONS = ["access", "cf"];
// Their range-driven versions are the Requests card and the Reach map, so a
// fixed 30-day copy beside them would only disagree with the chosen dates.
const RANGE_DRIVEN_METRICS = ["cf.requests", "cf.by_country"];
const ROLLING_WINDOW_DAYS = 30;
// ---------- generic stat tiles (rolling 30-day measures, pushed sections) ----------
function tile(metric) {
  const hasBreakdown = Boolean(metric.breakdown && metric.breakdown.length);
  const t = el("div", "tile" + (hasBreakdown ? " tile-list" : ""));
  const heading = el("div", "tile-head");
  heading.appendChild(el("span", "tile-label", metric.label));
  if (metric.hint) heading.appendChild(infoDisclosure("About " + metric.label, metric.hint));
  t.appendChild(heading);
  const valRow = el("div", "tile-value");
  valRow.appendChild(el("span", "v", fmt(metric)));
  const p = pct(metric.value, metric.total);
  if (p != null) valRow.appendChild(el("span", "tile-pct", p + "% of " + (metric.unit === "bytes" ? humanBytes(metric.total) : num(metric.total))));
  t.appendChild(valRow);
  if (metric.total != null && metric.unit !== "bytes") {
    const barWrap = el("div", "meter");
    const fill = el("div", "meter-fill");
    fill.style.width = Math.min(100, p || 0) + "%";
    barWrap.appendChild(fill);
    t.appendChild(barWrap);
  }
  if (metric.breakdown && metric.breakdown.length) {
    if (metric.breakdown_style === "ranked") t.appendChild(rankedList(metric, metric.breakdown));
    else t.appendChild(hbars(metric, metric.breakdown, { visible: 5 }));
  }
  // A drilldown key used to open an in-page list gated by a pasted API token.
  // The list now lives in the admin portal behind a session cookie, so the tile
  // links there instead of asking anyone for a credential (#8).
  if (metric.drilldown) t.appendChild(portalLink("Manage in admin portal (administrators)"));
  return t;
}
function portalLink(text) {
  const cta = el("a", "portal-cta", text);
  cta.href = ADMIN_PORTAL;
  cta.target = "_blank"; cta.rel = "noopener";
  cta.appendChild(icon("external"));
  return cta;
}
function sectionCard(section, headingTag) {
  const card = el("section", "card section-card");
  card.id = cardId(section.key);
  const head = el("div", "card-head");
  const titles = el("div", "card-titles");
  titles.appendChild(el(headingTag || "h4", "card-title", section.label));
  titles.appendChild(el("p", "card-sub", sourceLine(section)));
  head.appendChild(titles);
  card.appendChild(head);
  const body = el("div", "section-body");
  const scalars = el("div", "tiles");
  const lists = el("div", "tile-lists");
  section.metrics.forEach(function (m) { (m.breakdown && m.breakdown.length ? lists : scalars).appendChild(tile(m)); });
  if (scalars.childNodes.length) body.appendChild(scalars);
  if (lists.childNodes.length) body.appendChild(lists);
  // One list beside the stat tiles reads better than a lone full-width list.
  if (scalars.childNodes.length && lists.childNodes.length === 1) card.classList.add("card-split");
  card.appendChild(body);
  return card;
}
function sourceLine(section) {
  return "From " + sourceLabel(section.source) + (section.updated_at ? ", updated " + relativeTime(section.updated_at) : "");
}

// ---------- snapshot ----------
function renderSnapshot(snap) {
  const sections = Array.isArray(snap.sections) ? snap.sections : [];
  const catalog = sections.filter(function (s) { return CATALOG_SECTIONS.indexOf(s.key) >= 0; });
  const usage = sections.filter(function (s) { return USAGE_SECTIONS.indexOf(s.key) >= 0; }).map(function (s) {
    return Object.assign({}, s, { metrics: (s.metrics || []).filter(function (m) { return RANGE_DRIVEN_METRICS.indexOf(m.key) < 0; }) });
  }).filter(function (s) { return s.metrics.length; });
  const health = sections.filter(function (s) { return CATALOG_SECTIONS.indexOf(s.key) < 0 && USAGE_SECTIONS.indexOf(s.key) < 0; });
  renderCatalog(catalog);
  renderUsageSnapshot(usage);
  renderHealth(health);
  renderAllTime();
  renderHeadline();
  const generated = new Date(snap.generated_at);
  const windowNote = document.getElementById("rolling-window");
  if (windowNote && Number.isFinite(generated.getTime())) {
    const endDay = isoDay(generated);
    windowNote.textContent = "The " + ROLLING_WINDOW_DAYS + " days up to the latest snapshot, " + rangeText(shiftDay(endDay, 1 - ROLLING_WINDOW_DAYS), endDay) + " (UTC). These do not follow the date range.";
  }
  const meta = document.getElementById("health-meta");
  const missing = (snap.section_errors || []).map(function (e) { return sectionLabel(e && e.key); });
  meta.textContent = "Latest snapshot generated " + formatDateTime(snap.generated_at) + " (" + relativeTime(snap.generated_at) + "). It refreshes every hour."
    + (missing.length ? " Not in this snapshot: " + missing.join(", ") + "." : "");
}
// A snapshot that failed to load and one that loaded but could not be drawn
// get different words; both offer Try again, which also asks for the history
// again, so nothing is left on a skeleton.
function renderSnapshotError(kind, err) {
  const retry = function () {
    ["catalog", "usage-snapshot", "sections"].forEach(function (id) {
      const root = document.getElementById(id);
      root.dataset.ready = "false";
      markRefreshing(root, gridSkeleton);
    });
    document.getElementById("health-meta").textContent = "Loading the latest snapshot.";
    state.snapshot = null;
    state.snapshotFailed = false;
    renderAllTime();
    load();
    loadHistory();
  };
  const display = kind === "display";
  const title = display ? "Could not display the latest snapshot" : "Could not load the latest snapshot";
  const reason = display ? "It loaded, but this page could not show it. " : failureDetail(err, "") + " ";
  document.getElementById("health-meta").textContent = title + ".";
  stateMessage(document.getElementById("sections"), "error", title, (reason + "The current state of the pipelines is unknown until it " + (display ? "can be shown." : "loads.")).trim(), retry);
  stateMessage(document.getElementById("catalog"), "error", display ? "Could not display catalog figures" : "Could not load catalog figures", (reason + "Catalog figures are unknown right now.").trim(), retry);
  stateMessage(document.getElementById("usage-snapshot"), "error", display ? "Could not display the rolling 30-day measures" : "Could not load the rolling 30-day measures", (reason + "These measures are unknown right now.").trim(), retry);
  renderAllTime();
  renderHeadline();
}
function ring(percent) {
  const size = 64; const stroke = 6; const r = (size - stroke) / 2; const c = 2 * Math.PI * r;
  const wrap = el("div", "ring");
  const s = svgEl("svg", { viewBox: "0 0 " + size + " " + size, width: size, height: size, "aria-hidden": "true", focusable: "false" });
  s.appendChild(svgEl("circle", { cx: size / 2, cy: size / 2, r: r, class: "ring-track", "stroke-width": stroke }));
  const value = Math.max(0, Math.min(100, percent));
  s.appendChild(svgEl("circle", { cx: size / 2, cy: size / 2, r: r, class: "ring-fill", "stroke-width": stroke, "stroke-dasharray": (c * value / 100) + " " + c, transform: "rotate(-90 " + size / 2 + " " + size / 2 + ")" }));
  wrap.appendChild(s);
  wrap.appendChild(el("span", "ring-label", (Math.round(value * 10) / 10) + "%"));
  return wrap;
}
// A calm per-row cue, never a verdict: a check for normal, a dot for items an
// admin may want to review, nothing for plain counts. Shape carries it, and the
// same words are there for screen readers.
function stateMark(severity) {
  const wrap = el("span", "state-mark");
  if (severity === "ok") {
    wrap.appendChild(icon("check", "mark-ok"));
    wrap.appendChild(srOnly("Normal: "));
  } else if (severity === "warn" || severity === "error") {
    wrap.appendChild(icon("dot", "mark-review"));
    wrap.appendChild(srOnly("May need review: "));
  }
  return wrap;
}
function healthCard(section) {
  const metrics = section.metrics || [];
  const card = el("article", "card health-card");
  card.id = cardId(section.key);
  const head = el("div", "card-head");
  const titles = el("div", "card-titles");
  titles.appendChild(el("h3", "card-title", section.label));
  titles.appendChild(el("p", "card-sub", sourceLine(section)));
  head.appendChild(titles);
  card.appendChild(head);
  const coverage = metrics.find(function (m) { return m.severity === "ok" && m.total && m.unit !== "bytes" && m.unit !== "percent"; });
  if (coverage) {
    const block = el("div", "coverage");
    block.appendChild(ring(pct(coverage.value, coverage.total) || 0));
    const text = el("div", "coverage-text");
    const label = el("div", "coverage-label");
    label.appendChild(el("span", null, coverage.label));
    if (coverage.hint) label.appendChild(infoDisclosure("About " + coverage.label, coverage.hint));
    text.appendChild(label);
    text.appendChild(el("p", "coverage-value", num(coverage.value) + " of " + num(coverage.total)));
    block.appendChild(text);
    card.appendChild(block);
  }
  const list = el("ul", "health-rows");
  metrics.forEach(function (metric) {
    if (metric === coverage) return;
    const row = el("li", "health-row");
    row.appendChild(stateMark(metric.severity));
    const label = el("span", "health-label");
    label.appendChild(el("span", null, metric.label));
    if (metric.hint) label.appendChild(infoDisclosure("About " + metric.label, metric.hint));
    row.appendChild(label);
    const value = el("span", "health-value");
    const p = pct(metric.value, metric.total);
    if (p != null) value.appendChild(el("span", "health-share", p + "% of " + num(metric.total)));
    value.appendChild(el("strong", null, fmt(metric)));
    row.appendChild(value);
    if (metric.breakdown && metric.breakdown.length) {
      const extra = el("div", "health-breakdown");
      extra.appendChild(hbars(metric, metric.breakdown, { visible: 6 }));
      row.appendChild(extra);
    }
    list.appendChild(row);
  });
  card.appendChild(list);
  if (metrics.some(function (m) { return m.drilldown; })) {
    const foot = el("div", "card-foot");
    foot.appendChild(portalLink("Review in admin portal (administrators)"));
    card.appendChild(foot);
  }
  return card;
}
function renderHealth(sections) {
  const root = document.getElementById("sections");
  settle(root);
  if (!sections.length) {
    stateMessage(root, "info", "No pipeline sections in this snapshot", "Their current state is unknown until a pipeline reports.");
    return;
  }
  sections.forEach(function (section) { root.appendChild(healthCard(section)); });
}
function renderUsageSnapshot(sections) {
  const root = document.getElementById("usage-snapshot");
  settle(root);
  if (!sections.length) {
    stateMessage(root, "info", "No rolling 30-day measures in this snapshot", "These measures are unknown right now, which is not the same as zero.");
    return;
  }
  sections.forEach(function (section) { root.appendChild(sectionCard(section, "h4")); });
}
const CATALOG_TITLES = {
  "datasets.by_modality": ["Recording modality", "Share of public datasets that include each kind of recording."],
  "datasets.by_license": ["License", "Public datasets grouped by how permissive their license is."],
  "sizes.histogram": ["Dataset size", "How many public datasets fall in each size range, on a log scale."],
  "sizes.largest": ["Largest datasets", "The ten biggest public datasets and their share of all data."]
};
const CATALOG_NOTES = {
  "datasets.by_modality": "One dataset can include several modalities, so the bars add up to more than the number of datasets. EEG is electroencephalography, MEG magnetoencephalography, iEEG intracranial EEG, fNIRS functional near-infrared spectroscopy, EMG electromyography, and MRI magnetic resonance imaging.",
  "datasets.by_license": "Public domain covers CC0 and similar dedications; attribution covers CC BY and ODC-BY. A license that combines clauses counts in its most restrictive group."
};
const CATALOG_ORDER = ["datasets.by_modality", "datasets.by_license", "sizes.largest", "sizes.histogram"];
function histogramCard(metric) {
  const items = metric.breakdown;
  const cutoffIndex = items.findIndex(function (it) { return /cutoff/i.test(it.label); });
  const cleaned = items.map(function (it) { return String(it.label).replace(/\s*[^\w<>.\s]+\s*cutoff\s*$/i, "").replace(/\s*cutoff\s*$/i, "").trim(); });
  const total = items.reduce(function (sum, it) { return sum + it.value; }, 0);
  const points = items.map(function (it, i) { return { value: it.value, tick: cleaned[i] }; });
  function rangeLabel(i) {
    const low = cleaned[i];
    if (/^</.test(low)) return "Under " + low.replace(/^<\s*/, "");
    if (i === cleaned.length - 1) return low + " and larger";
    return low + " to " + cleaned[i + 1];
  }
  const cutoffName = cutoffIndex >= 0 ? cleaned[cutoffIndex] : null;
  return columnChart({
    points: points,
    unit: "count",
    cutoffIndex: cutoffIndex,
    cutoffLabel: cutoffName ? "Archive cutoff, " + cutoffName : "",
    ariaLabel: "Public datasets by size, " + items.length + " log-scaled bins",
    description: cutoffName ? "Bins from " + cutoffName + " up are shaded: those datasets are too large for a downloadable archive." : "",
    tooltip: function (i) {
      const p = pct(items[i].value, total);
      return {
        title: rangeLabel(i),
        value: plural(items[i].value, "dataset", "datasets"),
        notes: [p != null ? p + "% of the catalog" : "", cutoffIndex >= 0 && i >= cutoffIndex ? "Too large for a downloadable archive" : ""]
      };
    }
  });
}
function histogramTable(metric) {
  const details = disclosure("Show exact values (" + metric.breakdown.length + " bins)", "values");
  const table = el("table", "data-table");
  const head = el("thead"); const hr = el("tr");
  hr.appendChild(scoped(el("th", null, "Size bin"), "col")); hr.appendChild(scoped(el("th", "num", "Datasets"), "col"));
  head.appendChild(hr); table.appendChild(head);
  const body = el("tbody");
  metric.breakdown.forEach(function (it) {
    const tr = el("tr");
    tr.appendChild(scoped(el("th", null, it.label), "row"));
    tr.appendChild(el("td", "num", num(it.value)));
    body.appendChild(tr);
  });
  table.appendChild(body);
  const scroll = el("div", "table-scroll"); scroll.appendChild(table);
  details.appendChild(scroll);
  return details;
}
function catalogCard(metric, publicCount) {
  const titles = CATALOG_TITLES[metric.key];
  const isHistogram = metric.key === "sizes.histogram";
  const isRanked = metric.breakdown_style === "ranked";
  const card = el("article", "card catalog-card" + (isHistogram ? " card-wide" : "") + (isRanked ? " card-ranked" : ""));
  card.id = cardId(metric.key);
  const head = el("div", "card-head");
  const text = el("div", "card-titles");
  text.appendChild(el("h3", "card-title", titles ? titles[0] : metric.label));
  let sub = titles ? titles[1] : "";
  if (isRanked && metric.total) sub = "The ten largest hold " + pct(metric.value, metric.total) + "% of all public data (" + humanBytes(metric.value) + " of " + humanBytes(metric.total) + ").";
  if (sub) text.appendChild(el("p", "card-sub", sub));
  head.appendChild(text);
  const notes = [metric.hint, CATALOG_NOTES[metric.key]].filter(Boolean);
  if (notes.length) head.appendChild(infoDisclosure("About " + (titles ? titles[0] : metric.label), notes));
  card.appendChild(head);
  if (isHistogram) {
    card.appendChild(histogramCard(metric));
    card.appendChild(histogramTable(metric));
  } else if (isRanked) {
    card.appendChild(rankedList(metric, metric.breakdown));
  } else {
    const shareOf = metric.unit === "datasets" && (metric.breakdown_unit || metric.unit) === "datasets" ? metric.value || publicCount : 0;
    card.appendChild(hbars(metric, metric.breakdown, { shareOf: shareOf }));
  }
  return card;
}
function renderCatalog(sections) {
  const root = document.getElementById("catalog");
  settle(root);
  if (!sections.length) {
    stateMessage(root, "info", "Catalog figures are not in this snapshot", "They are unknown right now, which is not the same as zero.");
    return;
  }
  const scalars = []; const charts = [];
  sections.forEach(function (section) {
    (section.metrics || []).forEach(function (metric) {
      if (metric.breakdown && metric.breakdown.length) charts.push(metric); else scalars.push(metric);
    });
  });
  const index = metricIndex(state.snapshot);
  const publicCount = index["datasets.public"] ? index["datasets.public"].value : 0;
  if (scalars.length) {
    const strip = el("dl", "stat-strip");
    scalars.forEach(function (metric) {
      const item = el("div", "stat-item");
      const dt = el("dt");
      dt.appendChild(el("span", null, metric.label));
      if (metric.hint) dt.appendChild(infoDisclosure("About " + metric.label, metric.hint));
      item.appendChild(dt);
      const dd = el("dd", null, fmt(metric));
      const p = pct(metric.value, metric.total);
      if (p != null) dd.appendChild(el("span", "stat-share", p + "% of " + num(metric.total)));
      item.appendChild(dd);
      strip.appendChild(item);
    });
    root.appendChild(strip);
  }
  charts.sort(function (a, b) {
    const ia = CATALOG_ORDER.indexOf(a.key); const ib = CATALOG_ORDER.indexOf(b.key);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  const grid = el("div", "catalog-grid");
  charts.forEach(function (metric) { grid.appendChild(catalogCard(metric, publicCount)); });
  root.appendChild(grid);
}

function load() {
  getJson("/snapshot", validSnapshot, "the latest snapshot").then(function (snap) {
    state.snapshot = snap;
    state.snapshotFailed = false;
    try {
      renderSnapshot(snap);
    } catch (err) {
      console.error("[ui] snapshot display failed:", err);
      state.snapshot = null;
      state.snapshotFailed = true;
      renderSnapshotError("display", err);
    }
  }, function (err) {
    console.error("[ui] snapshot load failed:", err);
    state.snapshotFailed = true;
    renderSnapshotError("load", err);
  });
}

`;
