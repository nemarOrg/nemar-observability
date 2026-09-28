// Latest-snapshot sections: pipeline health cards and the attention summary,
// the top-bar status pill, the catalog cards, and the rolling 30-day tiles.
//
// Part of the inlined client script (see client.ts): a String.raw template, so
// no backticks and no dollar-brace sequences.

export const SNAPSHOT_JS = String.raw`
const SNAPSHOT_STALE_MS = 2 * 60 * 60 * 1000;
const CATALOG_SECTIONS = ["datasets", "sizes"];
const USAGE_SECTIONS = ["access", "cf"];
// ---------- generic stat tiles (rolling 30-day measures, pushed sections) ----------
function tile(metric) {
  const hasBreakdown = Boolean(metric.breakdown && metric.breakdown.length);
  const t = el("div", "tile" + (hasBreakdown ? " tile-list" : "") + (metric.severity === "warn" || metric.severity === "error" ? " tile-" + metric.severity : ""));
  const heading = el("div", "tile-head");
  heading.appendChild(el("span", "tile-label", metric.label));
  if (metric.hint) heading.appendChild(infoDisclosure("About " + metric.label, metric.hint));
  t.appendChild(heading);
  const valRow = el("div", "tile-value");
  valRow.appendChild(el("span", "v", fmt(metric)));
  if (metric.severity === "warn" || metric.severity === "error") {
    const status = badge(metric.severity, SEVERITY_TEXT[metric.severity]);
    status.setAttribute("role", "status");
    valRow.appendChild(status);
  }
  const p = pct(metric.value, metric.total);
  if (p != null) valRow.appendChild(el("span", "tile-pct", p + "% of " + (metric.unit === "bytes" ? humanBytes(metric.total) : num(metric.total))));
  t.appendChild(valRow);
  if (metric.total != null && metric.unit !== "bytes") {
    const barWrap = el("div", "meter");
    const fill = el("div", "meter-fill sev-" + (metric.severity || "info"));
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
  if (metric.drilldown) t.appendChild(portalLink("Manage in admin portal"));
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
  return "From " + section.source + (section.updated_at ? ", updated " + relativeTime(section.updated_at) : "");
}

// ---------- snapshot ----------
function renderSnapshot(snap) {
  const sections = Array.isArray(snap.sections) ? snap.sections : [];
  const catalog = sections.filter(function (s) { return CATALOG_SECTIONS.indexOf(s.key) >= 0; });
  const usage = sections.filter(function (s) { return USAGE_SECTIONS.indexOf(s.key) >= 0; });
  const health = sections.filter(function (s) { return CATALOG_SECTIONS.indexOf(s.key) < 0 && USAGE_SECTIONS.indexOf(s.key) < 0; });
  renderCatalog(catalog);
  renderUsageSnapshot(usage);
  renderHealth(health);
  renderStatus(snap, sections);
  const meta = document.getElementById("health-meta");
  meta.textContent = "Latest snapshot generated " + formatDateTime(snap.generated_at) + " (" + relativeTime(snap.generated_at) + "). It refreshes every hour.";
}
function renderSnapshotError() {
  const retry = function () {
    ["catalog", "usage-snapshot", "sections"].forEach(function (id) {
      const root = document.getElementById(id);
      root.textContent = "";
      root.appendChild(gridSkeleton());
    });
    state.snapshotFailed = false;
    load();
  };
  document.getElementById("health-meta").textContent = "Could not load the latest snapshot.";
  stateMessage(document.getElementById("sections"), "error", "Could not load the latest snapshot", "Pipeline health is unknown until it loads. This is not the same as healthy.", retry);
  stateMessage(document.getElementById("catalog"), "error", "Could not load catalog figures", "The latest snapshot did not load.", retry);
  stateMessage(document.getElementById("usage-snapshot"), "error", "Could not load the rolling 30-day measures", "The latest snapshot did not load.", retry);
  const summary = document.getElementById("health-summary");
  summary.textContent = "";
  setPill("unknown", "Status unavailable", "Pipeline status is unavailable because the latest snapshot did not load.");
}
function attentionItems(snap, sections) {
  const items = [];
  (snap.section_errors || []).forEach(function (error) {
    items.push({ severity: "error", label: "Section failed to compute", value: error.key, section: "Snapshot", anchor: "pipelines" });
  });
  const generated = Date.parse(snap.generated_at);
  if (!Number.isFinite(generated) || Date.now() - generated > SNAPSHOT_STALE_MS) {
    items.push({ severity: "warn", label: "Snapshot is out of date", value: relativeTime(snap.generated_at), section: "Snapshot", anchor: "pipelines" });
  }
  sections.forEach(function (section) {
    (section.metrics || []).forEach(function (metric) {
      if (metric.severity === "warn" || metric.severity === "error") {
        // Catalog cards are keyed by metric, not section, so point at the section.
        const anchor = CATALOG_SECTIONS.indexOf(section.key) >= 0 ? "datasets" : cardId(section.key);
        items.push({ severity: metric.severity, label: metric.label, value: fmt(metric), section: section.label, anchor: anchor });
      }
    });
  });
  items.sort(function (a, b) { return (a.severity === "error" ? 0 : 1) - (b.severity === "error" ? 0 : 1); });
  return items;
}
function setPill(tone, text, label, count) {
  const pill = document.getElementById("status-pill");
  pill.setAttribute("data-state", tone);
  pill.setAttribute("aria-label", label);
  pill.textContent = "";
  pill.appendChild(icon(tone === "ok" ? "ok" : tone === "warn" ? "warn" : tone === "error" ? "error" : "neutral"));
  if (count != null) pill.appendChild(el("span", "pill-count", num(count)));
  pill.appendChild(el("span", "pill-text", text));
}
function renderStatus(snap, sections) {
  const items = attentionItems(snap, sections);
  const errors = items.filter(function (i) { return i.severity === "error"; }).length;
  const warnings = items.length - errors;
  let checks = 0;
  sections.forEach(function (s) { (s.metrics || []).forEach(function (m) { if (m.severity === "ok" || m.severity === "warn" || m.severity === "error") checks++; }); });
  const tone = errors ? "error" : warnings ? "warn" : "ok";
  const breakdown = [errors ? plural(errors, "error", "errors") : "", warnings ? plural(warnings, "warning", "warnings") : ""].filter(Boolean).join(" and ");
  if (items.length) setPill(tone, "need attention", items.length + " items need attention: " + breakdown + ". Go to pipeline health.", items.length);
  else setPill("ok", "All healthy", "All monitored checks are healthy. Go to pipeline health.");
  const root = document.getElementById("health-summary");
  root.textContent = "";
  const banner = el("div", "summary-banner tone-" + tone);
  const head = el("div", "summary-head");
  head.appendChild(icon(tone === "ok" ? "ok" : tone === "warn" ? "warn" : "error", "summary-icon"));
  const copy = el("div", "summary-copy");
  copy.appendChild(el("p", "summary-title", items.length ? plural(items.length, "item needs attention", "items need attention") : "Everything is healthy"));
  copy.appendChild(el("p", "summary-body", items.length
    ? breakdown.charAt(0).toUpperCase() + breakdown.slice(1) + " in the latest snapshot. Warnings are worth a look; errors need action in the admin portal."
    : "All " + plural(checks, "monitored check is", "monitored checks are") + " passing in the latest snapshot."));
  head.appendChild(copy);
  if (items.length) head.appendChild(portalLink("Open admin portal"));
  banner.appendChild(head);
  if (snap.section_errors && snap.section_errors.length) {
    banner.appendChild(el("p", "summary-body", "Some sections failed to compute, so the figures below may be incomplete."));
  }
  if (items.length) {
    const list = el("ul", "attention-list");
    items.forEach(function (item) {
      const li = el("li");
      const link = el("a", "attention-item sev-" + item.severity);
      link.href = "#" + item.anchor;
      link.appendChild(severityIcon(item.severity));
      link.appendChild(srOnly(SEVERITY_TEXT[item.severity] + ": "));
      const text = el("span", "attention-text");
      text.appendChild(el("span", "attention-label", item.label));
      text.appendChild(el("span", "attention-section", item.section));
      link.appendChild(text);
      link.appendChild(el("span", "attention-value", item.value));
      li.appendChild(link);
      list.appendChild(li);
    });
    banner.appendChild(list);
  }
  root.appendChild(banner);
}
function worstSeverity(metrics) {
  let errors = 0; let warnings = 0; let ok = 0;
  metrics.forEach(function (m) { if (m.severity === "error") errors++; else if (m.severity === "warn") warnings++; else if (m.severity === "ok") ok++; });
  return { errors: errors, warnings: warnings, ok: ok };
}
function ring(percent, severity) {
  const size = 64; const stroke = 6; const r = (size - stroke) / 2; const c = 2 * Math.PI * r;
  const wrap = el("div", "ring");
  const s = svgEl("svg", { viewBox: "0 0 " + size + " " + size, width: size, height: size, "aria-hidden": "true", focusable: "false" });
  s.appendChild(svgEl("circle", { cx: size / 2, cy: size / 2, r: r, class: "ring-track", "stroke-width": stroke }));
  const value = Math.max(0, Math.min(100, percent));
  s.appendChild(svgEl("circle", { cx: size / 2, cy: size / 2, r: r, class: "ring-fill sev-" + severity, "stroke-width": stroke, "stroke-dasharray": (c * value / 100) + " " + c, transform: "rotate(-90 " + size / 2 + " " + size / 2 + ")" }));
  wrap.appendChild(s);
  wrap.appendChild(el("span", "ring-label", (Math.round(value * 10) / 10) + "%"));
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
  const counts = worstSeverity(metrics);
  const parts = [counts.errors ? plural(counts.errors, "error", "errors") : "", counts.warnings ? plural(counts.warnings, "warning", "warnings") : ""].filter(Boolean);
  head.appendChild(counts.errors ? badge("error", parts.join(", ")) : counts.warnings ? badge("warn", parts.join(", ")) : counts.ok ? badge("ok", "Healthy") : badge("neutral", "Informational"));
  card.appendChild(head);
  const coverage = metrics.find(function (m) { return m.severity === "ok" && m.total && m.unit !== "bytes" && m.unit !== "percent"; });
  if (coverage) {
    const block = el("div", "coverage");
    block.appendChild(ring(pct(coverage.value, coverage.total) || 0, coverage.severity));
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
    const row = el("li", "health-row sev-" + (metric.severity || "info"));
    row.appendChild(severityIcon(metric.severity));
    const label = el("span", "health-label");
    label.appendChild(srOnly(SEVERITY_TEXT[metric.severity || "info"] + ": "));
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
    foot.appendChild(portalLink("Review in admin portal"));
    card.appendChild(foot);
  }
  return card;
}
function renderHealth(sections) {
  const root = document.getElementById("sections");
  settle(root);
  if (!sections.length) {
    stateMessage(root, "info", "No pipeline sections in this snapshot", "Pipeline health is unknown until a pipeline reports.");
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
  hr.appendChild(el("th", null, "Size bin")); hr.appendChild(el("th", "num", "Datasets"));
  head.appendChild(hr); table.appendChild(head);
  const body = el("tbody");
  metric.breakdown.forEach(function (it) {
    const tr = el("tr");
    tr.appendChild(el("td", null, it.label));
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
  fetch(API + "/snapshot")
    .then(function (r) { if (!r.ok) throw new Error("snapshot " + r.status); return r.json(); })
    .then(function (snap) {
      state.snapshot = snap;
      state.snapshotFailed = false;
      renderSnapshot(snap);
    })
    .catch(function (err) {
      console.error("[ui] snapshot load failed:", err);
      state.snapshotFailed = true;
      renderSnapshotError();
    });
}

`;
