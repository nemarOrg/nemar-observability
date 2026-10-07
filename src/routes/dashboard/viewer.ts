// Signal viewer entry: one section, two filters that measure different things.
//
//   First-party   viewer opens and interactions on nemar.org, from the website
//                 event metrics the audience answer already carries.
//   Third-party   embed page loads on other sites: daily totals by kind, the top
//                 embedding sites, and the top embedded datasets, from /embeds.
//
// The two are never added into one number, and each says what it counts. The
// server has already applied the public rules (small sites, localhost and
// non-public datasets are folded into unnamed counts), so this script only
// draws what it is given. It stores nothing and sends only GETs (#8).
//
// Part of the inlined client script (see client.ts): a String.raw template, so
// no backticks and no dollar-brace sequences.

export const VIEWER_JS = String.raw`
// ---------- signal viewer ----------
state.viewerFilter = "first";
state.embeds = null;
state.embedsFailed = null;

const EMBEDS_CACHE_MS = 5 * 60000;
const embedsCache = createRequestCache(function (key) {
  const parts = key.split("|");
  return getJson("/embeds?start=" + encodeURIComponent(parts[0]) + "&end=" + encodeURIComponent(parts[1]), validEmbeds, "embed loads");
}, EMBEDS_CACHE_MS);
const embedsGuard = createLatestGuard();

function viewerMeasure(title, sub) {
  const head = el("div", "subsection-head viewer-measure");
  head.appendChild(el("h3", null, title));
  head.appendChild(el("p", null, sub));
  return head;
}

// ---------- first-party ----------
function renderViewerFirst(root) {
  const range = selectedRange();
  if (!validRange(range.start, range.end)) {
    stateMessage(root, "info", "Choose a valid UTC date range.", "The start date must be a real day on or before the end date.");
    return;
  }
  if (state.audienceFailed) {
    stateMessage(root, "error", "Could not load viewer activity", "Website figures for these dates are unknown right now, which is not the same as zero.", loadAudience);
    return;
  }
  if (state.audienceLoading || !state.audience || state.audience.start !== range.start || state.audience.end !== range.end) {
    markRefreshing(root, gridSkeleton);
    return;
  }
  const figures = viewerFirstParty(state.audience.payload);
  settle(root);
  root.appendChild(viewerMeasure("Viewer mounts on nemar.org", "Counted when the signal viewer opens on a nemar.org page. Embedded copies on other sites are not included; see Third-party."));
  const card = el("article", "card viewer-card");
  const head = el("div", "card-head");
  const titles = el("div", "card-titles");
  const titleRow = el("div", "title-row");
  titleRow.appendChild(el("h4", "card-title", "Viewer on nemar.org"));
  titleRow.appendChild(infoDisclosure("About viewer activity on nemar.org", "An open is one time the signal viewer mounted on a nemar.org page, and an interaction is an action taken inside it. Both are recorded unless the visitor has opted out of website analytics, so they undercount. Sessions are anonymous browsers, not identified people."));
  titles.appendChild(titleRow);
  head.appendChild(titles);
  head.appendChild(audienceBadge(figures.status));
  card.appendChild(head);
  const measures = el("div", "measures");
  audienceMeasure(measures, "Viewer opens", figures.opens.events);
  audienceMeasure(measures, "Anonymous sessions that opened it", figures.opens.visitors);
  audienceMeasure(measures, "Viewer interactions", figures.interactions.events);
  audienceMeasure(measures, "Anonymous sessions that interacted", figures.interactions.visitors);
  card.appendChild(measures);
  const details = disclosure("Coverage and source details");
  details.appendChild(el("p", "fine", "Verified event coverage: " + (figures.coverage ? rangeText(figures.coverage.start, figures.coverage.end) + " (UTC)" : "unavailable")));
  details.appendChild(el("p", "fine", "Measured by website analytics on nemar.org pages, so these are viewer mounts on our own pages, not embed page loads on partner sites."));
  if (figures.note) details.appendChild(el("p", "fine", figures.note));
  card.appendChild(details);
  root.appendChild(card);
}

// ---------- third-party ----------
function embedSeriesFor(loads) {
  return {
    points: loads.days.map(function (d) { return { date: d.date, value: d.embedded }; }),
    coverage_start: loads.coverage ? loads.coverage.start : "",
    coverage_end: loads.coverage ? loads.coverage.end : ""
  };
}
function embedValuesTable(loads) {
  const details = disclosure("Show exact values (" + loads.days.length + (loads.days.length === 1 ? " day)" : " days)"), "values");
  const table = el("table", "data-table");
  const headRow = el("tr");
  ["UTC day", "Embedded", "Opened directly", "Other"].forEach(function (label, i) {
    headRow.appendChild(scoped(el("th", i ? "num" : null, label), "col"));
  });
  const thead = el("thead"); thead.appendChild(headRow); table.appendChild(thead);
  const body = el("tbody");
  loads.days.forEach(function (d) {
    const row = el("tr");
    row.appendChild(scoped(el("th", null, longDay(d.date)), "row"));
    [d.embedded, d.direct, d.other].forEach(function (v) { row.appendChild(el("td", "num", num(v))); });
    body.appendChild(row);
  });
  table.appendChild(body);
  const scroll = el("div", "table-scroll"); scroll.appendChild(table);
  details.appendChild(scroll);
  return details;
}
function emptyBadgeText(reason) {
  if (reason === "before_counting") return "Before counting began";
  if (reason === "future") return "Future dates";
  return "None recorded yet";
}
function embedLoadsCard(loads, start, end) {
  const card = el("article", "card viewer-card viewer-loads");
  const head = el("div", "card-head");
  const titles = el("div", "card-titles");
  const titleRow = el("div", "title-row");
  titleRow.appendChild(el("h4", "card-title", "Embed page loads"));
  titleRow.appendChild(infoDisclosure("About embed page loads", "Each load of the embeddable signal viewer is counted once when NEMAR's servers answer the request. No script runs on the partner's page or on the visitor's device. A load is not a person: a browser may reuse a page for a minute, and some requests come from scripts and crawlers, which are counted separately. At high volume the counts are estimated from sampled records."));
  titles.appendChild(titleRow);
  head.appendChild(titles);
  // "Measured" would overstate a card with nothing recorded: say so instead.
  const nothingRecorded = loads.status === "available" && !loads.days_recorded;
  head.appendChild(nothingRecorded ? badge("neutral", emptyBadgeText(loads.empty_reason)) : audienceBadge(loads.status));
  card.appendChild(head);
  if (loads.status === "unconfigured" || loads.status === "unavailable") {
    card.appendChild(el("p", "fine", loads.note || "Embed loads are unavailable."));
    return card;
  }
  const headline = embedHeadline(loads);
  card.appendChild(el("p", "measure-total-label", "Embedded in another site"));
  if (nothingRecorded) {
    card.appendChild(figure("p", "measure-total is-muted", headline.text));
    card.appendChild(el("p", "fine", loads.note || "No embed loads are recorded for these dates."));
    return card;
  }
  card.appendChild(figure("p", "measure-total", headline.text));
  const measures = el("div", "measures viewer-split");
  audienceMeasure(measures, "Opened directly", loads.totals ? loads.totals.direct : null);
  audienceMeasure(measures, "Other requests (scripts, crawlers)", loads.totals ? loads.totals.other : null);
  card.appendChild(measures);
  card.appendChild(el("p", "fine", "Embedded is a page load inside another site's frame, and is the headline. Opened directly is someone visiting the embed address itself. Other requests carry no frame information."));
  if (loads.days.length) {
    const grouping = document.getElementById("grouping").value;
    const buckets = seriesBuckets(embedSeriesFor(loads), start, end, grouping);
    const gap = buckets.some(function (b) { return b.value === null; });
    card.appendChild(lineChart({
      points: buckets,
      unit: "count",
      ariaLabel: "Embedded loads by " + grouping + " in " + rangeText(start, end) + " (UTC)",
      description: "Embedded loads of the signal viewer on other sites, grouped by " + grouping + " in UTC.",
      tickLabel: function (i) { return bucketTick(buckets[i], grouping, start, end); },
      tooltip: function (i) {
        const bucket = buckets[i];
        return {
          title: (grouping === "day" && !bucket.partial ? longDay(bucket.start) : bucket.label) + " (UTC)",
          value: bucket.value === null ? "No data reported" : num(bucket.value),
          notes: [bucket.value === null ? "Unknown, not zero" : "", bucket.partial && bucket.value !== null ? "Partial period" : ""]
        };
      }
    }));
    const legend = el("div", "chart-legend");
    if (buckets.some(function (b) { return b.partial && b.value !== null; })) {
      const item = el("span", "legend-item");
      item.appendChild(el("span", "legend-key key-dashed"));
      item.appendChild(el("span", null, grouping === "day" ? "Partial day" : "Partial period"));
      legend.appendChild(item);
    }
    if (gap) {
      const item = el("span", "legend-item");
      item.appendChild(el("span", "legend-key key-gap"));
      item.appendChild(el("span", null, "Shaded: not recorded, unknown rather than zero"));
      legend.appendChild(item);
    }
    if (legend.childNodes.length) card.appendChild(legend);
    card.appendChild(embedValuesTable(loads));
  }
  const details = disclosure("Coverage and source details");
  details.appendChild(el("p", "fine", "Recorded for " + loads.days_recorded + " of " + loads.days_in_range + " days in these dates" + (loads.coverage ? ", from " + rangeText(loads.coverage.start, loads.coverage.end) + " (UTC)" : "") + ". Daily totals are kept after the detailed records expire."));
  if (loads.last_synced_at) details.appendChild(el("p", "fine", "Last updated " + formatDateTime(loads.last_synced_at) + "."));
  if (loads.note) details.appendChild(el("p", "fine", loads.note));
  card.appendChild(details);
  return card;
}
function embedRow(rank, label, value, total, aggregate, link) {
  const row = el("li", "ranked-row" + (aggregate ? " ranked-aggregate" : ""));
  row.appendChild(el("span", "ranked-rank", rank));
  const name = el("span", "ranked-label");
  if (link) {
    const a = el("a", null, label);
    a.href = link;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    name.appendChild(a);
    name.appendChild(srOnly(" (opens in a new tab)"));
  } else {
    name.textContent = label;
  }
  row.appendChild(name);
  const figureNode = el("span", "ranked-value", num(value));
  const share = embedShare(value, total);
  if (share) figureNode.appendChild(el("span", "hbar-share", share));
  row.appendChild(figureNode);
  return row;
}
function embedListCard(title, infoFor, block, build) {
  const card = el("article", "card viewer-card");
  const head = el("div", "card-head");
  const titles = el("div", "card-titles");
  const titleRow = el("div", "title-row");
  titleRow.appendChild(el("h4", "card-title", title));
  titleRow.appendChild(infoDisclosure("About " + title.toLowerCase(), infoFor(block)));
  titles.appendChild(titleRow);
  head.appendChild(titles);
  // A card with nothing to show says why, instead of "Measured".
  const empty = block.status === "available" || block.status === "partial"
    ? (!block.summary ? (block.reason === "future" ? "Future dates" : block.reason === "before_counting" ? "Before counting began" : "No detail") : block.summary.total === 0 ? "None recorded yet" : null)
    : null;
  head.appendChild(empty ? badge("neutral", empty) : audienceBadge(block.status));
  card.appendChild(head);
  if (!block.summary) {
    card.appendChild(el("p", "fine", block.note || "Unavailable."));
    return card;
  }
  build(card, block.summary, block);
  const details = disclosure("Coverage and source details");
  details.appendChild(el("p", "fine", "Counted over " + (block.window ? rangeText(block.window.start, block.window.end) + " (UTC)" : "no days") + ", embedded loads only. Detailed records are kept for about three months."));
  if (block.note) details.appendChild(el("p", "fine", block.note));
  card.appendChild(details);
  return card;
}
function embedSitesCard(block) {
  return embedListCard(
    "Embedding sites",
    function () { return "Sites are counted here, not named. The site that framed the viewer is reported by the visitor's browser, which anyone can set to any name, and a site's address can identify a person, so no name is shown on this page. The list of sites is available to administrators through the API. At high volume the counts are estimated from sampled records."; },
    block,
    function (card, summary) {
      if (!summary.total) { card.appendChild(el("p", "fine", "No embedded loads in these dates.")); return; }
      const list = el("ol", "ranked");
      const distinct = plural(summary.distinct_sites, "distinct site", "distinct sites") + (summary.capped ? " or more" : "");
      list.appendChild(embedRow("", "From " + distinct, summary.sites_loads, summary.total, false, null));
      list.appendChild(embedRow("", "Unknown or local", summary.unknown_or_local, summary.total, false, null));
      card.appendChild(list);
      card.appendChild(el("p", "fine", "Unknown or local covers loads with no site reported, localhost, and private addresses. The number of sites is as claimed by the visitors' browsers. The list of sites is available to administrators through the API."));
    }
  );
}
function embedDatasetsCard(block) {
  return embedListCard(
    "Top embedded datasets",
    function () { return "Public datasets ranked by embedded loads. A dataset that is private or unpublished is never named; its loads are part of the unnamed count. At high volume the counts are estimated from sampled records."; },
    block,
    function (card, summary) {
      if (!summary.total) { card.appendChild(el("p", "fine", "No embedded loads in these dates.")); return; }
      const list = el("ol", "ranked");
      summary.rows.forEach(function (r, i) { list.appendChild(embedRow(i + 1, r.label, r.value, summary.total, false, r.href)); });
      if (summary.other > 0) list.appendChild(embedRow("", "Other datasets (not named)", summary.other, summary.total, true, null));
      card.appendChild(list);
      card.appendChild(el("p", "fine", "Only public datasets are named. Other datasets covers private and unpublished datasets and any public dataset not shown here."));
    }
  );
}
function renderViewerThird(root) {
  const range = selectedRange();
  if (!validRange(range.start, range.end)) {
    stateMessage(root, "info", "Choose a valid UTC date range.", "The start date must be a real day on or before the end date, and a range can span up to 3,660 days.");
    return;
  }
  if (state.embedsFailed) {
    stateMessage(root, "error", "Could not load embed loads", failureDetail(state.embedsFailed, "Embed loads for these dates are unknown right now, which is not the same as zero."), loadEmbeds);
    return;
  }
  const entry = state.embeds;
  if (!entry || entry.start !== range.start || entry.end !== range.end) {
    markRefreshing(root, gridSkeleton);
    return;
  }
  const payload = entry.payload;
  settle(root);
  root.appendChild(viewerMeasure("Embed page loads on other sites", "Counted when another site's page loads the embeddable viewer. Opens of the viewer on nemar.org are not included; see First-party."));
  const layout = el("div", "viewer-grid");
  layout.appendChild(embedLoadsCard(payload.loads, range.start, range.end));
  const lists = el("div", "viewer-lists");
  lists.appendChild(embedSitesCard(payload.sites));
  lists.appendChild(embedDatasetsCard(payload.datasets));
  layout.appendChild(lists);
  root.appendChild(layout);
}

// ---------- wiring ----------
function renderViewer() {
  const root = document.getElementById("viewer-body");
  if (!root) return;
  try {
    if (state.viewerFilter === "third") renderViewerThird(root);
    else renderViewerFirst(root);
  } catch (err) {
    console.error("[ui] signal viewer display failed:", err);
    stateMessage(root, "error", "Could not display the signal viewer figures", "They loaded, but this page could not show them. Try again, or reload the page.", renderViewer);
  }
}
// Embed loads are fetched only while the Third-party filter is showing, and
// again when the dates change; an answer for earlier dates never replaces the
// current ones.
function loadEmbeds() {
  const token = embedsGuard.begin();
  state.embedsFailed = null;
  if (state.viewerFilter !== "third") return;
  const range = selectedRange();
  if (!validRange(range.start, range.end)) { renderViewer(); return; }
  const key = range.start + "|" + range.end;
  renderViewer();
  embedsCache.get(key).then(function (payload) {
    if (!embedsGuard.isCurrent(token) || !isSelected(range.start, range.end)) return;
    state.embeds = { start: range.start, end: range.end, payload: payload };
    renderViewer();
  }, function (err) {
    if (!embedsGuard.isCurrent(token)) return;
    console.error("[ui] embed loads failed:", err);
    state.embedsFailed = err || new Error("failed");
    renderViewer();
  });
}
function setViewerFilter(filter) {
  if (filter !== "first" && filter !== "third") return;
  state.viewerFilter = filter;
  // The old filter's figures must not linger, dimmed, behind the new one's skeleton.
  const root = document.getElementById("viewer-body");
  if (root) root.dataset.ready = "false";
  document.querySelectorAll("[data-viewer-filter]").forEach(function (button) {
    button.setAttribute("aria-pressed", String(button.getAttribute("data-viewer-filter") === filter));
  });
  if (filter === "third") loadEmbeds(); else renderViewer();
}
// The chart follows the page's day, week or month grouping, like the other
// additive series, so changing it redraws a loaded embed card.
document.getElementById("grouping").addEventListener("change", function () {
  if (state.viewerFilter === "third" && state.embeds) renderViewer();
});
document.querySelectorAll("[data-viewer-filter]").forEach(function (button) {
  button.addEventListener("click", function () { setViewerFilter(button.getAttribute("data-viewer-filter")); });
});
`;
