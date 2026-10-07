// The recorded-hours explorer under the pipeline cards: one tab per modality,
// a minimum-channels slider that sits on the chart's own channel axis, a
// readout that answers "how much at N or more channels" in words, and the
// distribution of hours, recordings, or datasets over exact channel counts.
//
// Every number comes from channels.ts (tested without a DOM); this module only
// draws. The view (modality, minimum, measure) is kept in the address as
// #hours=eeg:16 so it can be shared; nothing is stored in the browser.
//
// Part of the inlined client script (see client.ts): a String.raw template, so
// no backticks and no dollar-brace sequences.

export const EXPLORER_JS = String.raw`
const HOURS_MEASURE_LABELS = { hours: "Hours", recordings: "Recordings", datasets: "Datasets" };
const HOURS_CHART_TITLES = {
  hours: "Hours at each channel count",
  recordings: "Recordings at each channel count",
  datasets: "Datasets by their largest channel count"
};
// The thumb is 24px wide; its center travels the track from 12px in at either end.
const HOURS_THUMB_RADIUS = 12;
const hoursView = { modalities: [], axisMax: 512, key: null, min: DEFAULT_MIN_CHANNELS, measure: "hours", found: null, nodes: null, hashTimer: null, scrolled: false };

function hoursModality() {
  return hoursView.modalities.find(function (m) { return m.key === hoursView.key; }) || hoursView.modalities[0];
}
function hoursStops() { return channelStops(hoursModality(), hoursView.axisMax); }
function hoursPosition(channels) { return Math.round(1000 * Math.log2(Math.max(1, channels))); }
// Applies a #hours= view when it names a modality that is present. A hash for
// another modality, or one that does not parse, is ignored as a whole.
function applyHoursHash(hash) {
  const parsed = parseHoursHash(hash);
  if (!parsed || !hoursView.modalities.some(function (m) { return m.key === parsed.modality; })) return false;
  hoursView.key = parsed.modality;
  hoursView.min = Math.min(parsed.min, hoursView.axisMax);
  hoursView.measure = parsed.measure;
  return true;
}
function scheduleHoursHash() {
  clearTimeout(hoursView.hashTimer);
  hoursView.hashTimer = setTimeout(function () {
    const next = hoursHash({ modality: hoursView.key, min: hoursView.min, measure: hoursView.measure });
    if (location.hash === next) return;
    // Replaced, not pushed: moving the slider should not fill the back button.
    try { history.replaceState(null, "", next); } catch (err) { console.error("[ui] could not put this view in the address:", err); }
  }, 250);
}
window.addEventListener("hashchange", function () {
  if (hoursView.nodes && applyHoursHash(location.hash)) updateHours(false, true);
});

function renderRecordedHours(snap) {
  const root = document.getElementById("channel-hours");
  if (!root) return;
  const found = findChannelHours(snap);
  hoursView.nodes = null;
  if (found.state === "missing") {
    stateMessage(root, "info", "Recorded hours are not measured yet", "They appear here once the Zarr copies of public datasets have been indexed. Until then the hours are unknown, which is not the same as zero.");
    return;
  }
  if (found.state === "no-payload") {
    stateMessage(root, "info", "Recorded hours are not in the latest snapshot", "The latest indexing run did not report them, so they are unknown right now, which is not the same as zero.");
    return;
  }
  if (found.state === "invalid") {
    stateMessage(root, "error", "Could not display recorded hours", "The latest snapshot holds them in a form this page does not recognize.");
    return;
  }
  settle(root);
  hoursView.found = found;
  hoursView.modalities = prepareModalities(found.payload);
  hoursView.axisMax = axisMaxFor(hoursView.modalities);
  const linked = applyHoursHash(location.hash);
  if (!hoursView.modalities.some(function (m) { return m.key === hoursView.key; })) hoursView.key = hoursView.modalities[0].key;
  if (CHANNEL_MEASURES.indexOf(hoursView.measure) < 0) hoursView.measure = "hours";
  root.appendChild(buildHoursExplorer());
  updateHours(false);
  if (linked && !hoursView.scrolled) {
    hoursView.scrolled = true;
    revealHoursFromLink();
  }
}
// A shared link opens on the explorer. The blocks above it are still loading
// and growing, so it is kept in view for a few seconds, until the reader
// scrolls, taps, or types on their own.
function revealHoursFromLink() {
  const block = document.getElementById("recorded-hours");
  if (!block || !block.scrollIntoView) return;
  let readerMoved = false;
  ["wheel", "touchstart", "keydown", "pointerdown"].forEach(function (type) {
    window.addEventListener(type, function () { readerMoved = true; }, { once: true, passive: true });
  });
  const reveal = function () { if (!readerMoved) block.scrollIntoView({ block: "start", behavior: "instant" }); };
  requestAnimationFrame(reveal);
  if ("ResizeObserver" in window) {
    const observer = new ResizeObserver(reveal);
    observer.observe(document.body);
    setTimeout(function () { observer.disconnect(); }, 4000);
  }
}

function buildHoursExplorer() {
  const view = hoursView;
  const nodes = {};
  const card = el("div", "card hours-card");

  // Modality tabs (automatic activation) and the measure toggle.
  const top = el("div", "hours-top");
  const tablist = el("div", "hours-tabs");
  tablist.setAttribute("role", "tablist");
  tablist.setAttribute("aria-label", "Recording type");
  nodes.tabs = view.modalities.map(function (m, index) {
    const tab = el("button", "hours-tab");
    tab.type = "button";
    tab.id = "hours-tab-" + index;
    tab.dataset.modality = m.key;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", "hours-panel");
    tab.appendChild(el("span", "hours-tab-name", m.name));
    tab.appendChild(figure("span", "hours-tab-total", humanHours(m.hours), exactHours(m.hours)));
    tab.addEventListener("click", function () { selectHoursModality(m.key); });
    tablist.appendChild(tab);
    return tab;
  });
  tablist.addEventListener("keydown", function (event) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const index = nodes.tabs.indexOf(document.activeElement);
    if (index < 0) return;
    const count = nodes.tabs.length;
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % count;
    else if (event.key === "ArrowLeft") next = (index - 1 + count) % count;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = count - 1;
    else return;
    event.preventDefault();
    nodes.tabs[next].focus();
    selectHoursModality(view.modalities[next].key);
  });
  top.appendChild(tablist);
  nodes.tablist = tablist;
  const measures = el("div", "segmented hours-measures");
  measures.setAttribute("role", "group");
  measures.setAttribute("aria-label", "What to count");
  nodes.measures = CHANNEL_MEASURES.map(function (measure) {
    const button = el("button", null, HOURS_MEASURE_LABELS[measure]);
    button.type = "button";
    button.dataset.measure = measure;
    button.addEventListener("click", function () {
      if (view.measure === measure) return;
      view.measure = measure;
      updateHours(true, true);
    });
    measures.appendChild(button);
    return button;
  });
  top.appendChild(measures);
  card.appendChild(top);

  const panel = el("div", "hours-panel");
  panel.id = "hours-panel";
  panel.setAttribute("role", "tabpanel");
  nodes.panel = panel;
  const body = el("div", "hours-body");

  // The answer, in words and figures.
  const readout = el("div", "hours-readout");
  const value = el("p", "hours-value");
  nodes.number = el("span", "hours-value-number");
  nodes.unit = el("span", "hours-value-unit");
  value.appendChild(nodes.number);
  value.appendChild(nodes.unit);
  readout.appendChild(value);
  nodes.claim = el("p", "hours-claim");
  readout.appendChild(nodes.claim);
  const meter = el("div", "meter meter-lg hours-meter");
  meter.setAttribute("aria-hidden", "true");
  nodes.fill = el("div", "meter-fill");
  meter.appendChild(nodes.fill);
  readout.appendChild(meter);
  nodes.share = el("p", "hours-share");
  readout.appendChild(nodes.share);
  const facts = el("dl", "hours-facts");
  nodes.facts = [0, 1, 2].map(function (i) {
    const item = el("div", "hours-fact");
    const dt = el("dt");
    const label = el("span");
    dt.appendChild(label);
    if (i === 2) dt.appendChild(infoDisclosure("About channel-hours", "Channel-hours add up every channel's recording time: one hour from a 64-channel recording is 64 channel-hours. They measure the amount of signal, as when sizing data for training models."));
    const dd = el("dd");
    item.appendChild(dt); item.appendChild(dd);
    facts.appendChild(item);
    return { label: label, value: dd };
  });
  readout.appendChild(facts);
  body.appendChild(readout);

  // The distribution, with the slider on the chart's channel axis.
  const plot = el("div", "hours-plot");
  const head = el("div", "hours-plot-head");
  nodes.title = el("p", "hours-plot-title");
  head.appendChild(nodes.title);
  head.appendChild(infoDisclosure("How to read this chart", [
    "Each bar is one exact channel count, and each step along the axis doubles the channels, so the common montages at 32, 64, and 128 channels sit evenly apart.",
    "Bars at and above the minimum are drawn in color on a shaded band; bars below it are gray. Hours are summed recording time.",
    "A dataset counts toward a minimum when its largest recording in this modality reaches it, so each dataset is counted once."
  ]));
  plot.appendChild(head);
  nodes.chart = hoursChart();
  plot.appendChild(nodes.chart.wrap);
  const slider = el("div", "hours-slider");
  const range = el("input", "hours-range");
  range.type = "range";
  range.id = "hours-min";
  range.min = "0";
  range.max = String(hoursPosition(view.axisMax));
  range.step = "1";
  slider.appendChild(range);
  plot.appendChild(slider);
  const sliderRow = el("div", "hours-slider-row");
  const label = el("label", "hours-slider-label", "Minimum channels per recording");
  label.htmlFor = "hours-min";
  sliderRow.appendChild(label);
  plot.appendChild(sliderRow);
  nodes.range = range;
  body.appendChild(plot);
  panel.appendChild(body);

  // A drag lands on the nearest stop; a keyboard or assistive-technology step
  // moves to the next stop in its direction, so a one-unit nudge never sticks.
  let dragging = false;
  range.addEventListener("pointerdown", function () { dragging = true; });
  ["pointerup", "pointercancel", "change", "blur"].forEach(function (type) { range.addEventListener(type, function () { dragging = false; }); });
  range.addEventListener("input", function () {
    const raw = Math.pow(2, Number(range.value) / 1000);
    const stops = hoursStops();
    let next = view.min;
    if (dragging) next = nearestStop(stops, raw);
    else if (raw > view.min) next = stepStop(stops, view.min, 1);
    else if (raw < view.min) next = stepStop(stops, view.min, -1);
    setHoursMin(next);
  });
  range.addEventListener("keydown", function (event) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const stops = hoursStops();
    let next = null;
    if (event.key === "ArrowRight" || event.key === "ArrowUp") next = stepStop(stops, view.min, 1);
    else if (event.key === "ArrowLeft" || event.key === "ArrowDown") next = stepStop(stops, view.min, -1);
    else if (event.key === "PageUp") next = stepPower(stops, view.min, 1);
    else if (event.key === "PageDown") next = stepPower(stops, view.min, -1);
    else if (event.key === "Home") next = stops[0];
    else if (event.key === "End") next = stops[stops.length - 1];
    if (next === null) return;
    event.preventDefault();
    setHoursMin(next);
  });

  // The exact values, and where they come from.
  const foot = el("div", "hours-foot");
  nodes.details = disclosure("Show exact values", "values");
  nodes.details.addEventListener("toggle", function () {
    if (nodes.details.open && view.nodes === nodes) fillHoursTable(hoursModality());
  });
  const table = el("table", "data-table hours-table");
  // The datasets column holds dataset peaks, so the caption says how they count.
  table.appendChild(el("caption", "hours-caption", "Each dataset is counted once, at the channel count of its largest recording."));
  const thead = el("thead");
  const hr = el("tr");
  [["Channels", ""], ["Hours", "num"], ["Recordings", "num"], ["Datasets", "num"]].forEach(function (h) {
    hr.appendChild(scoped(el("th", h[1] || null, h[0]), "col"));
  });
  thead.appendChild(hr);
  table.appendChild(thead);
  nodes.tbody = el("tbody");
  table.appendChild(nodes.tbody);
  const scroll = el("div", "table-scroll");
  scroll.appendChild(table);
  nodes.details.appendChild(scroll);
  foot.appendChild(nodes.details);
  hoursSourceNotes(view.found).forEach(function (text) { foot.appendChild(el("p", "fine", text)); });
  panel.appendChild(foot);
  // Focus stays on a tab or the measure toggle while the readout changes below
  // it, so the new answer is read out once, politely.
  nodes.live = el("p", "sr-only hours-live");
  nodes.live.setAttribute("aria-live", "polite");
  panel.appendChild(nodes.live);
  card.appendChild(panel);
  view.nodes = nodes;
  return card;
}
function hoursSourceNotes(found) {
  const payload = found.payload;
  const notes = [];
  const updated = found.section && found.section.updated_at ? ", updated " + relativeTime(found.section.updated_at) : "";
  notes.push("From the Zarr copies of " + plural(payload.datasets_scanned, "public dataset", "public datasets") + updated + ".");
  if (payload.datasets_unavailable) notes.push(plural(payload.datasets_unavailable, "dataset", "datasets") + " with a Zarr copy could not be read in the latest run and " + (payload.datasets_unavailable === 1 ? "is" : "are") + " not counted.");
  if (payload.recordings_unmeasured) notes.push(plural(payload.recordings_unmeasured, "recording", "recordings") + " without a known duration or channel count " + (payload.recordings_unmeasured === 1 ? "is" : "are") + " left out.");
  return notes;
}
// A tab chosen by a link or the arrow keys can sit past the strip's edge on a
// phone. The strip scrolls itself to center it; scrollIntoView could scroll the
// whole page instead. The strip is positioned, so offsetLeft is measured in it.
function centerHoursTab(tab) {
  const strip = hoursView.nodes.tablist;
  if (strip.scrollWidth <= strip.clientWidth) return;
  strip.scrollLeft = Math.max(0, tab.offsetLeft - (strip.clientWidth - tab.offsetWidth) / 2);
}
function selectHoursModality(key) {
  if (hoursView.key === key) return;
  hoursView.key = key;
  updateHours(true, true);
}
function setHoursMin(channels) {
  const nodes = hoursView.nodes;
  if (channels === hoursView.min) {
    // Snap the thumb back onto the stop it left.
    if (nodes) nodes.range.value = String(hoursPosition(channels));
    return;
  }
  hoursView.min = channels;
  updateHours(true);
}

// Everything that follows the view, in one place, so the readout, slider,
// chart, and table never disagree. announce reads the new answer aloud.
function updateHours(fromUser, announce) {
  const view = hoursView;
  const nodes = view.nodes;
  if (!nodes) return;
  const modality = hoursModality();
  view.key = modality.key;
  nodes.tabs.forEach(function (tab) {
    const on = tab.dataset.modality === view.key;
    tab.setAttribute("aria-selected", String(on));
    tab.tabIndex = on ? 0 : -1;
    if (on) {
      nodes.panel.setAttribute("aria-labelledby", tab.id);
      centerHoursTab(tab);
    }
  });
  nodes.measures.forEach(function (button) { button.setAttribute("aria-pressed", String(button.dataset.measure === view.measure)); });

  const part = atLeast(modality, view.min);
  // The denominator is summed the same way as the part, so "any number" is 100%.
  const total = atLeast(modality, 1)[view.measure];
  const value = part[view.measure];
  const shown = measureFigure(view.measure, value);
  nodes.number.textContent = shown.number;
  nodes.unit.textContent = " " + shown.unit;
  nodes.claim.textContent = hoursClaim(view.measure, modality.name, view.min, value);
  nodes.fill.style.width = (total ? Math.min(100, (value / total) * 100) : 0) + "%";
  nodes.share.textContent = hoursShareLine(view.measure, value, total, modality.name);
  hoursFacts(view.measure, part).forEach(function (fact, i) {
    nodes.facts[i].label.textContent = fact.label;
    nodes.facts[i].value.textContent = fact.value;
  });

  nodes.range.value = String(hoursPosition(view.min));
  nodes.range.setAttribute("aria-valuetext", thresholdText(view.min) + ": " + measureText(view.measure, value));
  nodes.title.textContent = HOURS_CHART_TITLES[view.measure];
  nodes.chart.update();
  // The table is rebuilt only while it is open; opening it fills it.
  nodes.details.querySelector("summary").textContent = "Show exact values (" + plural(hoursTableRows(modality).length, "channel count", "channel counts") + ")";
  if (nodes.details.open) fillHoursTable(modality);
  if (announce) nodes.live.textContent = shown.number + " " + shown.unit + " " + nodes.claim.textContent + ". " + nodes.share.textContent + ".";
  if (fromUser) scheduleHoursHash();
}

// Rows for every channel count, with a labeled divider where the minimum
// falls: the cut is named in words, not only by the muted rows below it.
function fillHoursTable(modality) {
  const nodes = hoursView.nodes;
  const rows = hoursTableRows(modality);
  const body = nodes.tbody;
  body.textContent = "";
  function divider(text) {
    const tr = el("tr", "hours-cut");
    const cell = el("td", null, text);
    cell.colSpan = 4;
    tr.appendChild(cell);
    body.appendChild(tr);
  }
  let cut = hoursView.min <= rows[0].channels;
  rows.forEach(function (row) {
    if (!cut && row.channels >= hoursView.min) {
      cut = true;
      divider("Counted: " + thresholdText(hoursView.min));
    }
    const tr = el("tr", row.channels < hoursView.min ? "is-below" : null);
    tr.appendChild(scoped(el("th", null, num(row.channels)), "row"));
    tr.appendChild(el("td", "num", tableHours(row.hours)));
    tr.appendChild(el("td", "num", num(row.recordings)));
    tr.appendChild(el("td", "num", num(row.datasets)));
    body.appendChild(tr);
  });
  if (!cut) divider("None with " + thresholdText(hoursView.min));
}

// ---------- the chart ----------
function hoursChart() {
  const frame = chartFrame("Recorded hours by channel count", "Each bar is one exact channel count on a doubling axis. Bars at and above the minimum set by the slider are drawn in color on a shaded band; bars below it are gray.");
  frame.wrap.classList.add("hours-chart");
  let width = 0;
  let geometry = null;
  let points = [];
  let bars = [];
  let svgRoot = null;
  let active = -1;
  function draw() {
    const view = hoursView;
    const nodes = view.nodes;
    if (!nodes || !width) return;
    const modality = hoursModality();
    points = channelSeries(modality, view.measure).filter(function (p) { return p.value > 0; });
    frame.wrap.setAttribute("aria-label", HOURS_CHART_TITLES[view.measure] + ", " + modality.name + ", channel counts 1 to " + num(view.axisMax) + " on a doubling axis");
    frame.canvas.textContent = "";
    const height = width < 480 ? 180 : 210;
    const max = points.reduce(function (m, p) { return Math.max(m, p.value); }, 0);
    const scale = view.measure === "hours" ? niceScale(max, "count", 3) : countScale(max);
    const tickText = function (t) { return view.measure === "hours" ? humanHours(t) : compact(t); };
    let labelChars = 0;
    scale.ticks.forEach(function (t) { labelChars = Math.max(labelChars, tickText(t).length); });
    const margin = { l: Math.max(34, labelChars * 6.6 + 10), r: 10, t: 26, b: 26 };
    const plotW = Math.max(40, width - margin.l - margin.r);
    const plotH = height - margin.t - margin.b;
    const pad = 8;
    const x0 = margin.l + pad;
    const span = plotW - 2 * pad;
    const octaves = Math.log2(view.axisMax);
    function xOf(c) { return x0 + (Math.log2(c) / octaves) * span; }
    function yOf(v) { return margin.t + plotH - (v / (scale.max || 1)) * plotH; }
    // One width for every bar, so width never reads as amount: half of a
    // tight gap between neighbors (the first quartile), between 2px (3px on
    // a wide chart) and 8px. Dense modalities get thin bars that may touch;
    // sparse ones get bars that are easy to point at.
    const gaps = [];
    for (let i = 1; i < points.length; i++) gaps.push(xOf(points[i].channels) - xOf(points[i - 1].channels));
    gaps.sort(function (a, b) { return a - b; });
    const typical = gaps.length ? gaps[Math.floor(gaps.length / 4)] : 16;
    const barW = Math.max(span > 600 ? 3 : 2, Math.min(8, Math.floor(typical / 2)));
    const ruleX = xOf(Math.max(1, view.min)) - barW / 2 - 2;
    const svg = svgEl("svg", { width: width, height: height, viewBox: "0 0 " + width + " " + height, "aria-hidden": "true", focusable: "false" });
    svg.appendChild(svgEl("rect", { x: ruleX, y: margin.t, width: Math.max(0, margin.l + plotW - ruleX), height: plotH, class: "hours-band" }));
    scale.ticks.forEach(function (t, index) {
      const ty = yOf(t);
      svg.appendChild(svgEl("line", { x1: margin.l, x2: margin.l + plotW, y1: ty, y2: ty, class: index === 0 ? "chart-axis" : "chart-grid" }));
      const label = svgEl("text", { x: margin.l - 8, y: ty + 4, "text-anchor": "end", class: "chart-tick" });
      label.textContent = tickText(t);
      svg.appendChild(label);
    });
    // Powers of two along the bottom; every other one when they would crowd.
    const powers = axisPowers(view.axisMax);
    const every = span / octaves < 30 ? 2 : 1;
    powers.forEach(function (p, i) {
      const tx = xOf(p);
      svg.appendChild(svgEl("line", { x1: tx, x2: tx, y1: margin.t + plotH, y2: margin.t + plotH + 4, class: "chart-axis" }));
      if (i % every !== 0) return;
      const label = svgEl("text", { x: tx, y: height - 8, "text-anchor": "middle", class: "chart-tick" });
      label.textContent = num(p);
      svg.appendChild(label);
    });
    bars = points.map(function (p) {
      const top = Math.min(yOf(p.value), margin.t + plotH - 2);
      const bar = svgEl("path", { d: columnPath(xOf(p.channels) - barW / 2, top, barW, margin.t + plotH - top, Math.min(2, barW / 2)), class: "hours-bar" + (p.channels >= view.min ? " is-in" : "") });
      svg.appendChild(bar);
      return bar;
    });
    svg.appendChild(svgEl("line", { x1: ruleX, x2: ruleX, y1: margin.t - 14, y2: margin.t + plotH, class: "hours-rule" }));
    const ruleText = view.min <= 1 ? "Any number" : num(view.min) + " or more";
    const fitsRight = ruleX + 6 + ruleText.length * 6.8 <= width - 2;
    const note = svgEl("text", { x: fitsRight ? ruleX + 6 : ruleX - 6, y: margin.t - 6, "text-anchor": fitsRight ? "start" : "end", class: "chart-annotation" });
    note.textContent = ruleText;
    svg.appendChild(note);
    frame.canvas.appendChild(svg);
    svgRoot = svg;
    geometry = { xOf: xOf, yOf: yOf, plotBottom: margin.t + plotH };
    // The slider's thumb center travels exactly the chart's channel axis.
    const left = x0 - HOURS_THUMB_RADIUS;
    const trackWidth = span + 2 * HOURS_THUMB_RADIUS;
    nodes.range.style.marginLeft = left + "px";
    nodes.range.style.width = trackWidth + "px";
    nodes.range.style.setProperty("--cut", (HOURS_THUMB_RADIUS + (Math.log2(Math.max(1, view.min)) / octaves) * span) + "px");
    if (active >= points.length) active = -1;
    if (active >= 0 && frame.tooltip.classList.contains("visible")) show(active, false);
  }
  function content(i) {
    const view = hoursView;
    const p = points[i];
    const modality = hoursModality();
    const bin = modality.bins.find(function (b) { return b.channels === p.channels; });
    const notes = [];
    if (view.measure === "hours" && bin) notes.push(plural(bin.recordings, "recording", "recordings"));
    if (view.measure === "recordings" && bin) notes.push(exactHours(bin.hours));
    notes.push(p.channels >= view.min ? "Counted in " + thresholdText(view.min) : "Below the minimum of " + thresholdText(view.min));
    return {
      title: (view.measure === "datasets" ? "Largest recording: " : "") + plural(p.channels, "channel", "channels"),
      value: measureText(view.measure, p.value),
      notes: notes
    };
  }
  function show(i, announce) {
    if (!geometry || i < 0 || i >= points.length) return;
    active = i;
    const c = content(i);
    fillTooltip(frame.tooltip, c);
    frame.tooltip.classList.add("visible");
    const rect = frame.wrap.getBoundingClientRect();
    positionFloatingTooltip(frame.tooltip, frame.wrap, rect.left + geometry.xOf(points[i].channels), rect.top + Math.min(geometry.yOf(points[i].value), geometry.plotBottom - 8));
    svgRoot.classList.add("has-active");
    bars.forEach(function (bar, index) { bar.classList.toggle("is-active", index === i); });
    if (announce) frame.live.textContent = tooltipText(c);
  }
  function hide() {
    frame.tooltip.classList.remove("visible");
    if (svgRoot) svgRoot.classList.remove("has-active");
    bars.forEach(function (bar) { bar.classList.remove("is-active"); });
  }
  // The nearest bar within reach of the pointer, so a 2px bar need not be hit dead on.
  function indexAt(clientX) {
    if (!geometry || !points.length) return -1;
    const px = clientX - frame.wrap.getBoundingClientRect().left;
    let best = -1; let distance = 20;
    points.forEach(function (p, i) {
      const d = Math.abs(geometry.xOf(p.channels) - px);
      if (d <= distance) { distance = d; best = i; }
    });
    return best;
  }
  function firstCounted() {
    const i = points.findIndex(function (p) { return p.channels >= hoursView.min; });
    return i >= 0 ? i : 0;
  }
  frame.wrap.addEventListener("pointermove", function (event) { const i = indexAt(event.clientX); if (i >= 0) show(i, false); else if (document.activeElement !== frame.wrap) hide(); });
  frame.wrap.addEventListener("pointerdown", function (event) { const i = indexAt(event.clientX); if (i >= 0) show(i, false); });
  frame.wrap.addEventListener("pointerleave", function () { if (document.activeElement !== frame.wrap) hide(); });
  frame.wrap.addEventListener("focus", function () { show(active >= 0 ? active : firstCounted(), true); });
  frame.wrap.addEventListener("blur", hide);
  frame.wrap.addEventListener("keydown", function (event) {
    if (!points.length || event.altKey || event.ctrlKey || event.metaKey) return;
    let next = active < 0 ? firstCounted() : active;
    if (event.key === "ArrowRight") next = Math.min(points.length - 1, next + 1);
    else if (event.key === "ArrowLeft") next = Math.max(0, next - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = points.length - 1;
    else if (event.key === "Escape") { hide(); return; }
    else return;
    event.preventDefault();
    show(next, true);
  });
  observeWidth(frame.canvas, function (w) { if (w !== width) { width = w; draw(); } });
  return {
    wrap: frame.wrap,
    update: function () {
      // Drawn at once from the laid-out width, so the slider is placed before the
      // first resize report arrives.
      if (!width) width = Math.floor(frame.canvas.clientWidth || frame.wrap.clientWidth || 0) || 600;
      active = -1;
      hide();
      draw();
    }
  };
}
`;
