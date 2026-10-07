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
  const listCount = hasBreakdown && metric.breakdown_unit && metric.breakdown_unit !== metric.unit;
  valRow.appendChild(el("span", listCount ? "tile-caption" : "v", listCount ? "Top " + Math.min(metric.breakdown.length, 10) + (metric.value > 10 ? " of " + num(metric.value) : "") + " listed" : fmt(metric)));
  const p = pct(metric.value, metric.total);
  if (p != null) valRow.appendChild(el("span", "tile-pct", partShare(metric.value, metric.total) + " of " + unitFormatter(metric.unit)(metric.total)));
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
  // With stat tiles and several lists, the last (tallest) list takes the right
  // column and everything else stacks in the left, so the two sides balance.
  const split = scalars.childNodes.length && lists.childNodes.length >= 1;
  if (split) {
    const main = el("div", "split-main");
    main.appendChild(scalars);
    const tall = lists.lastChild;
    if (lists.childNodes.length > 1) { lists.removeChild(tall); main.appendChild(lists); }
    const side = el("div", "tile-lists");
    side.appendChild(tall);
    body.appendChild(main);
    body.appendChild(side);
    card.classList.add("card-split");
  } else {
    if (scalars.childNodes.length) body.appendChild(scalars);
    if (lists.childNodes.length) body.appendChild(lists);
  }
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
  renderHoursSafely(snap);
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
// A failure drawing the explorer stays in its own block, so every other figure
// still shows.
function renderHoursSafely(snap) {
  try {
    renderRecordedHours(snap);
  } catch (err) {
    failHoursExplorer(err);
  }
}
// A snapshot that failed to load and one that loaded but could not be drawn
// get different words; both offer Try again, which also asks for the history
// again, so nothing is left on a skeleton.
function renderSnapshotError(kind, err) {
  const retry = function () {
    ["catalog", "usage-snapshot", "sections", "channel-hours"].forEach(function (id) {
      const root = document.getElementById(id);
      if (!root) return;
      root.dataset.ready = "false";
      markRefreshing(root, id === "channel-hours" ? chartSkeleton : gridSkeleton);
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
  sizeView = null;
  const sizeRoot = document.getElementById("catalog-size");
  if (sizeRoot) sizeRoot.textContent = "";
  stateMessage(document.getElementById("usage-snapshot"), "error", display ? "Could not display the rolling 30-day measures" : "Could not load the rolling 30-day measures", (reason + "These measures are unknown right now.").trim(), retry);
  hoursView.nodes = null;
  const hours = document.getElementById("channel-hours");
  if (hours) stateMessage(hours, "error", display ? "Could not display recorded hours" : "Could not load recorded hours", (reason + "Recorded hours are unknown right now.").trim(), retry);
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
    text.appendChild(el("p", "coverage-value", unitFormatter(coverage.unit)(coverage.value) + " of " + unitFormatter(coverage.unit)(coverage.total)));
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
    if (p != null) value.appendChild(el("span", "health-share", partShare(metric.value, metric.total) + " of " + unitFormatter(metric.unit)(metric.total)));
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
  // Only the section the explorer is drawing, and only when it can draw it.
  const drawn = findChannelHours(state.snapshot);
  const hasHours = drawn.state === "ok" && drawn.section === section;
  if (metrics.some(function (m) { return m.drilldown; }) || hasHours) {
    const foot = el("div", "card-foot");
    // The section behind the recorded-hours explorer points to it.
    if (hasHours) {
      const explore = el("a", "card-link", "Explore hours by channel count");
      explore.href = "#recorded-hours";
      foot.appendChild(explore);
    }
    if (metrics.some(function (m) { return m.drilldown; })) foot.appendChild(portalLink("Review in admin portal (administrators)"));
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
  const cards = sections.map(healthCard);
  const place = function () { packCards(root, cards); };
  place();
  if (!root.dataset.packed) {
    root.dataset.packed = "1";
    let timer = null;
    window.addEventListener("resize", function () { clearTimeout(timer); timer = setTimeout(place, 150); });
  }
}
// Cards go into plain stacked columns, each to the shortest one so far, so short
// cards leave no holes. (CSS multi-column was tried and could leave the page unpainted.)
function packCards(root, cards) {
  const width = root.clientWidth || 0;
  const count = Math.max(1, Math.min(3, Math.floor((width + 24) / 344)));
  root.textContent = "";
  const columns = [];
  for (let i = 0; i < count; i++) { const col = el("div", "health-col"); root.appendChild(col); columns.push(col); }
  const heights = columns.map(function () { return 0; });
  cards.forEach(function (card) {
    let shortest = 0;
    heights.forEach(function (h, i) { if (h < heights[shortest]) shortest = i; });
    columns[shortest].appendChild(card);
    heights[shortest] += card.offsetHeight + 24;
  });
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
const CATALOG_ORDER = ["datasets.by_modality", "datasets.by_license", "sizes.largest"];
function histogramCard(metric, typeName) {
  const items = metric.breakdown;
  const cutoffIndex = items.findIndex(function (it) { return /cutoff/i.test(it.label); });
  const cleaned = items.map(function (it) { return String(it.label).replace(/\s*[^\w<>.\s]+\s*cutoff\s*$/i, "").replace(/\s*cutoff\s*$/i, "").trim(); });
  const total = items.reduce(function (sum, it) { return sum + it.value; }, 0);
  const points = items.map(function (it, i) { return { value: it.value, tick: cleaned[i] }; });
  const whose = typeName ? typeName + " datasets" : "the catalog";
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
    ariaLabel: (typeName ? "Public " + typeName + " datasets" : "Public datasets") + " by size, " + items.length + " log-scaled bins",
    description: cutoffName ? "Bins from " + cutoffName + " up are shaded: those datasets are too large for a downloadable archive." : "",
    tooltip: function (i) {
      const p = pct(items[i].value, total);
      return {
        title: rangeLabel(i),
        value: plural(items[i].value, typeName ? typeName + " dataset" : "dataset", typeName ? typeName + " datasets" : "datasets"),
        notes: [p != null ? p + "% of " + whose : "", cutoffIndex >= 0 && i >= cutoffIndex ? "Too large for a downloadable archive" : ""]
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
// The head every catalog card starts with: title, one line under it, and the
// About popover. sub overrides the stock line.
function catalogHead(metric, sub) {
  const titles = CATALOG_TITLES[metric.key];
  const head = el("div", "card-head");
  const text = el("div", "card-titles");
  text.appendChild(el("h3", "card-title", titles ? titles[0] : metric.label));
  const line = sub === undefined ? (titles ? titles[1] : "") : sub;
  const subNode = line ? el("p", "card-sub", line) : null;
  if (subNode) text.appendChild(subNode);
  head.appendChild(text);
  const notes = [metric.hint, CATALOG_NOTES[metric.key]].filter(Boolean);
  if (notes.length) head.appendChild(infoDisclosure("About " + (titles ? titles[0] : metric.label), notes));
  return { head: head, sub: subNode };
}
function catalogCard(metric, publicCount) {
  const isRanked = metric.breakdown_style === "ranked";
  const card = el("article", "card catalog-card" + (isRanked ? " card-ranked" : ""));
  card.id = cardId(metric.key);
  let sub;
  if (isRanked && metric.total) sub = "The ten largest hold " + pct(metric.value, metric.total) + "% of all public data (" + humanBytes(metric.value) + " of " + humanBytes(metric.total) + ").";
  card.appendChild(catalogHead(metric, sub).head);
  if (isRanked) {
    card.appendChild(rankedList(metric, metric.breakdown));
  } else {
    const shareOf = metric.unit === "datasets" && (metric.breakdown_unit || metric.unit) === "datasets" ? metric.value || publicCount : 0;
    card.appendChild(hbars(metric, metric.breakdown, { shareOf: shareOf }));
  }
  return card;
}
// ---------- the Dataset size card ----------
// "All" is the whole catalog's histogram; the other tabs are the same bins for
// the datasets that include one recording type (the sizes.histogram.<type>
// metrics). The tabs are the explorer's own strip, and the two follow one
// choice: picking a type in either moves the other, through hoursView (whose
// modality is also what the address carries). "All" is only the size card's:
// picking it leaves the explorer where it is. Not stored anywhere.
const SIZE_METRIC_PREFIX = "sizes.histogram.";
const SIZE_TAB_CODES = ["eeg", "meg", "ieeg", "emg"];
let sizeView = null;
function sizeTypeName(key) { return MODALITY_NAMES[key] || String(key).toUpperCase(); }
function sizeCardFor(all, byModality) {
  const card = el("article", "card catalog-card card-wide size-card");
  card.id = cardId(all.key);
  const codes = SIZE_TAB_CODES.filter(function (code) { return byModality[code]; });
  const made = catalogHead(all);
  card.appendChild(made.head);
  if (!codes.length) {
    card.appendChild(histogramCard(all, null));
    card.appendChild(histogramTable(all));
    sizeView = null;
    return card;
  }
  const view = { node: card, codes: codes, all: all, byModality: byModality, key: "all", followed: null, seen: false, sub: made.sub, stock: made.sub ? made.sub.textContent : "", strip: null, panel: null, note: null, live: null, shown: {} };
  const spokenCount = function (metric) { return plural(metric.value, "dataset", "datasets"); };
  const items = [{ key: "all", name: "All", total: num(all.value), spoken: spokenCount(all) }].concat(codes.map(function (code) {
    const metric = byModality[code];
    return { key: code, name: sizeTypeName(code), tone: modalityTone(code), total: num(metric.value), spoken: spokenCount(metric) };
  }));
  view.strip = buildModalityTabs({ label: "Recording type", idPrefix: "size-tab-", panelId: "size-panel", className: "size-tabs", items: items, onSelect: chooseSizeTab });
  const top = el("div", "size-top");
  top.appendChild(view.strip.tablist);
  card.appendChild(top);
  const panel = el("div", "size-panel");
  panel.id = "size-panel";
  panel.setAttribute("role", "tabpanel");
  view.panel = panel;
  // Said when the explorer is on a type the catalog is not grouped by.
  view.note = el("p", "size-note");
  view.note.hidden = true;
  panel.appendChild(view.note);
  view.live = el("p", "sr-only");
  view.live.setAttribute("aria-live", "polite");
  panel.appendChild(view.live);
  card.appendChild(panel);
  sizeView = view;
  showSizeView();
  syncSizeCard();
  return card;
}
// Draws the chosen tab: its own histogram (built the first time it is shown),
// the card's tone, and the line under the title.
function showSizeView() {
  const view = sizeView;
  if (!view) return;
  const key = view.key;
  const metric = key === "all" ? view.all : view.byModality[key];
  const name = key === "all" ? null : sizeTypeName(key);
  if (!view.shown[key]) {
    const block = el("div", "size-block");
    block.appendChild(histogramCard(metric, name));
    block.appendChild(histogramTable(metric));
    view.panel.appendChild(block);
    view.shown[key] = block;
  }
  Object.keys(view.shown).forEach(function (k) { view.shown[k].hidden = k !== key; });
  const chosen = markModalityTabs(view.strip, key, view.panel);
  if (chosen) centerStripTab(view.strip.tablist, chosen);
  if (key === "all") view.node.removeAttribute("data-tone");
  else view.node.dataset.tone = modalityTone(key);
  if (view.sub) view.sub.textContent = key === "all" ? view.stock : "Public datasets that include " + name + " recordings, by size, on a log scale.";
  const explorerType = hoursView.nodes ? hoursView.key : null;
  const unsorted = key === "all" && explorerType !== null && view.followed === explorerType && view.codes.indexOf(explorerType) < 0;
  view.note.hidden = !unsorted;
  view.note.textContent = unsorted ? "Datasets are not grouped by " + hoursModality().name + ", so all datasets are shown." : "";
}
function chooseSizeTab(key) {
  const view = sizeView;
  if (!view) return;
  view.key = key;
  showSizeView();
  view.live.textContent = "Showing " + (key === "all" ? "all datasets" : sizeTypeName(key) + " datasets") + " by size.";
  // A type moves the explorer too, when it has that type; "All" does not.
  if (key !== "all" && hoursView.nodes && hoursView.key !== key && hoursView.modalities.some(function (m) { return m.key === key; })) selectHoursModality(key);
}
// The explorer's type changed (or was set by a link): the size card follows it.
// A type the card has no tab for shows "All" with a note; a change of minimum or
// measure does not touch the card, and neither does the explorer's first draw
// unless the address named a view, so the card opens on "All".
function syncSizeCard() {
  const view = sizeView;
  if (!view) return;
  const target = hoursView.nodes ? hoursView.key : null;
  if (target === view.followed) return;
  view.followed = target;
  if (target === null) return;
  const first = !view.seen;
  view.seen = true;
  if (first && !hoursView.linkedView) return;
  view.key = view.codes.indexOf(target) >= 0 ? target : "all";
  showSizeView();
}

// The catalog's two recorded-data figures come from the pushed recordings
// section; without it (not collected yet, or a failed run) they are not shown.
const RECORDED_SCOPE = "Counts only the public datasets converted for in-browser viewing so far, not the whole archive.";
function statItem(metric, label, hint) {
  const item = el("div", "stat-item");
  const dt = el("dt");
  dt.appendChild(el("span", null, label || metric.label));
  const note = hint === undefined ? metric.hint : hint;
  if (note) dt.appendChild(infoDisclosure("About " + (label || metric.label), note));
  item.appendChild(dt);
  const dd = el("dd", null, fmt(metric));
  const p = pct(metric.value, metric.total);
  if (p != null) dd.appendChild(el("span", "stat-share", partShare(metric.value, metric.total) + " of " + unitFormatter(metric.unit)(metric.total)));
  item.appendChild(dd);
  return item;
}
function recordedStatItems() {
  const index = metricIndex(state.snapshot);
  const items = [];
  [["recordings.recordings", "Recordings"], ["recordings.hours", "Recorded hours"]].forEach(function (pair) {
    const metric = index[pair[0]];
    if (!metric || !(metric.value > 0)) return;
    items.push(statItem(metric, pair[1], RECORDED_SCOPE + (metric.hint ? " " + metric.hint : "")));
  });
  return items;
}
function renderCatalog(sections) {
  const root = document.getElementById("catalog");
  const sizeRoot = document.getElementById("catalog-size");
  settle(root);
  sizeView = null;
  if (sizeRoot) sizeRoot.textContent = "";
  if (!sections.length) {
    stateMessage(root, "info", "Catalog figures are not in this snapshot", "They are unknown right now, which is not the same as zero.");
    return;
  }
  const scalars = []; const charts = []; const sizeByType = {};
  sections.forEach(function (section) {
    (section.metrics || []).forEach(function (metric) {
      // The per-type size histograms belong to the Dataset size card's tabs.
      if (String(metric.key).indexOf(SIZE_METRIC_PREFIX) === 0) {
        if (metric.breakdown && metric.breakdown.length) sizeByType[metric.key.slice(SIZE_METRIC_PREFIX.length)] = metric;
        return;
      }
      if (metric.breakdown && metric.breakdown.length) charts.push(metric); else scalars.push(metric);
    });
  });
  const index = metricIndex(state.snapshot);
  const publicCount = index["datasets.public"] ? index["datasets.public"].value : 0;
  const recorded = recordedStatItems();
  if (scalars.length || recorded.length) {
    const strip = el("dl", "stat-strip");
    scalars.forEach(function (metric) { strip.appendChild(statItem(metric)); });
    recorded.forEach(function (item) { strip.appendChild(item); });
    root.appendChild(strip);
  }
  charts.sort(function (a, b) {
    const ia = CATALOG_ORDER.indexOf(a.key); const ib = CATALOG_ORDER.indexOf(b.key);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  // The size card sits below the recorded-hours explorer, not in the grid.
  const sizes = charts.find(function (metric) { return metric.key === "sizes.histogram"; });
  const grid = el("div", "catalog-grid");
  charts.forEach(function (metric) { if (metric !== sizes) grid.appendChild(catalogCard(metric, publicCount)); });
  if (grid.childNodes.length) root.appendChild(grid);
  if (sizes && sizeRoot) sizeRoot.appendChild(sizeCardFor(sizes, sizeByType));
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
