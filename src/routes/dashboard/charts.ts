// Client chart primitives: tooltip placement, the line/area and column chart
// engine with a shared pointer and keyboard cursor, horizontal bars, and ranked
// lists. Every value a chart shows is also in a table or printed label.
//
// Part of the inlined client script (see client.ts): a String.raw template, so
// no backticks and no dollar-brace sequences.

export const CHARTS_JS = String.raw`
// ---------- tooltips ----------
function positionFloatingTooltip(tooltip, frame, clientX, clientY) {
  const rect = frame.getBoundingClientRect();
  tooltip.style.maxWidth = Math.max(0, rect.width - 16) + "px";
  tooltip.style.transform = "translateX(-50%)";
  const half = tooltip.offsetWidth / 2;
  const left = Math.min(rect.width - half - 8, Math.max(half + 8, clientX - rect.left));
  const pointerY = clientY - rect.top;
  const tooltipHeight = tooltip.offsetHeight;
  const roomBelow = rect.height - pointerY - 12;
  const roomAbove = pointerY - 12;
  const showBelow = roomBelow >= tooltipHeight || roomBelow >= roomAbove;
  const proposedTop = showBelow ? pointerY + 12 : pointerY - tooltipHeight - 12;
  const top = Math.min(
    Math.max(8, rect.height - tooltipHeight - 8),
    Math.max(8, proposedTop),
  );
  tooltip.style.left = left + "px";
  tooltip.style.top = top + "px";
}
function fillTooltip(tooltip, content) {
  tooltip.textContent = "";
  if (content.title) tooltip.appendChild(el("div", "tt-title", content.title));
  if (content.value) tooltip.appendChild(el("div", "tt-value", content.value));
  (content.notes || []).forEach(function (note) { if (note) tooltip.appendChild(el("div", "tt-note", note)); });
}
function tooltipText(content) {
  return [content.title, content.value].concat(content.notes || []).filter(Boolean).join(". ");
}
function observeWidth(target, callback) {
  if ("ResizeObserver" in window) {
    const observer = new ResizeObserver(function (entries) {
      const width = Math.floor(entries[0].contentRect.width);
      if (width > 0) callback(width);
    });
    observer.observe(target);
  } else {
    requestAnimationFrame(function () { callback(target.clientWidth || 600); });
    window.addEventListener("resize", function () { callback(target.clientWidth || 600); });
  }
}

// ---------- chart engine ----------
let chartSeq = 0;
function niceStep(raw) {
  if (!(raw > 0)) return 1;
  const exponent = Math.floor(Math.log10(raw));
  const base = Math.pow(10, exponent);
  const f = raw / base;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * base;
}
function niceScale(max, unit, count) {
  const top = max > 0 ? max : 1;
  if (unit === "bytes") {
    const units = ["B","kB","MB","GB","TB","PB"]; let i = 0; let scaled = top;
    while (scaled >= 1000 && i < units.length - 1) { scaled /= 1000; i++; }
    const factor = Math.pow(1000, i);
    const step = niceStep(scaled / count);
    const ceiling = Math.ceil(scaled / step - 1e-9) * step;
    const ticks = [];
    for (let v = 0; v <= ceiling + step / 2; v += step) ticks.push(v * factor);
    return { max: ceiling * factor, ticks: ticks, format: function (v) { return (Math.round((v / factor) * 100) / 100).toLocaleString("en-US") + " " + units[i]; } };
  }
  const step = Math.max(1, niceStep(top / count));
  const ceiling = Math.ceil(top / step - 1e-9) * step;
  const ticks = [];
  for (let v = 0; v <= ceiling + step / 2; v += step) ticks.push(v);
  return { max: ceiling, ticks: ticks, format: compact };
}
function chartFrame(ariaLabel, description) {
  const id = ++chartSeq;
  const wrap = el("div", "chart");
  wrap.tabIndex = 0;
  wrap.setAttribute("role", "group");
  wrap.setAttribute("aria-label", ariaLabel);
  const canvas = el("div", "chart-canvas");
  const tooltip = el("div", "chart-tooltip");
  tooltip.setAttribute("aria-hidden", "true");
  const desc = el("p", "sr-only", (description ? description + " " : "") + "Use the left and right arrow keys to read each value, or expand Show exact values below to read them all as a table.");
  desc.id = "chart-desc-" + id;
  wrap.setAttribute("aria-describedby", desc.id);
  const live = el("p", "sr-only");
  live.setAttribute("aria-live", "polite");
  wrap.appendChild(canvas); wrap.appendChild(tooltip); wrap.appendChild(desc); wrap.appendChild(live);
  return { id: id, wrap: wrap, canvas: canvas, tooltip: tooltip, live: live };
}
// Pointer, touch and keyboard all move one cursor over the same indexes, and
// every value the cursor reveals is also in the chart's table.
function attachCursor(frame, count, api) {
  let active = -1;
  function show(index, announce) {
    if (index < 0 || index >= count) return;
    active = index;
    const anchor = api.anchor(index);
    if (!anchor) return;
    const content = api.content(index);
    fillTooltip(frame.tooltip, content);
    frame.tooltip.classList.add("visible");
    const rect = frame.wrap.getBoundingClientRect();
    positionFloatingTooltip(frame.tooltip, frame.wrap, rect.left + anchor.x, rect.top + anchor.y);
    api.highlight(index);
    if (announce) frame.live.textContent = tooltipText(content);
  }
  function hide() {
    frame.tooltip.classList.remove("visible");
    api.highlight(-1);
  }
  frame.wrap.addEventListener("pointermove", function (event) { const i = api.indexAt(event.clientX); if (i >= 0) show(i, false); });
  frame.wrap.addEventListener("pointerdown", function (event) { const i = api.indexAt(event.clientX); if (i >= 0) show(i, false); });
  frame.wrap.addEventListener("pointerleave", function () { if (document.activeElement !== frame.wrap) hide(); });
  frame.wrap.addEventListener("focus", function () { show(active >= 0 ? active : api.initial(), true); });
  frame.wrap.addEventListener("blur", hide);
  frame.wrap.addEventListener("keydown", function (event) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    let next = active < 0 ? api.initial() : active;
    if (event.key === "ArrowRight") next = Math.min(count - 1, next + 1);
    else if (event.key === "ArrowLeft") next = Math.max(0, next - 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = count - 1;
    else if (event.key === "Escape") { hide(); return; }
    else return;
    event.preventDefault();
    show(next, true);
  });
  return { refresh: function () { if (active >= 0 && frame.tooltip.classList.contains("visible")) show(active, false); } };
}
function tickIndexes(count, maxTicks, anchor) {
  const step = Math.max(1, Math.ceil(count / Math.max(1, maxTicks)));
  const indexes = [];
  for (let i = 0; i < count; i++) if (((i - anchor) % step + step) % step === 0) indexes.push(i);
  return indexes;
}
// Line or area chart over evenly spaced buckets. value null means unknown and is
// drawn as a gap with a shaded band, never as zero.
function lineChart(opts) {
  const frame = chartFrame(opts.ariaLabel, opts.description);
  if (opts.compact) frame.wrap.classList.add("chart-compact");
  const points = opts.points;
  const n = points.length;
  let geometry = null;
  let hoverLine = null; let hoverDot = null;
  function draw(width) {
    frame.canvas.textContent = "";
    const height = opts.height || (opts.compact ? 40 : 220);
    const observed = points.filter(function (p) { return p.value !== null; }).map(function (p) { return p.value; });
    let yMin = 0; let yMax = 1; let scale = null;
    if (opts.compact) {
      const lo = observed.length ? Math.min.apply(null, observed) : 0;
      const hi = observed.length ? Math.max.apply(null, observed) : 1;
      // A floor of 1% of the value keeps a tiny wobble from reading as a cliff.
      const pad = Math.max((hi - lo) * 0.18, Math.abs(hi) * 0.01, 1e-9);
      yMin = lo - pad; yMax = hi + pad;
    } else {
      scale = niceScale(observed.length ? Math.max.apply(null, observed) : 0, opts.unit, 4);
      yMax = scale.max;
    }
    let labelWidth = 0;
    if (scale) scale.ticks.forEach(function (t) { labelWidth = Math.max(labelWidth, scale.format(t).length); });
    const margin = opts.compact ? { l: 4, r: 6, t: 6, b: 6 } : { l: Math.max(34, labelWidth * 6.4 + 12), r: 14, t: 10, b: 28 };
    const plotW = Math.max(10, width - margin.l - margin.r);
    const plotH = height - margin.t - margin.b;
    const step = n > 1 ? plotW / (n - 1) : plotW;
    function x(i) { return n === 1 ? margin.l + plotW / 2 : margin.l + i * step; }
    function y(v) { return margin.t + plotH - ((v - yMin) / (yMax - yMin || 1)) * plotH; }
    const svg = svgEl("svg", { width: width, height: height, viewBox: "0 0 " + width + " " + height, "aria-hidden": "true", focusable: "false" });
    const gradientId = "chart-grad-" + frame.id;
    const defs = svgEl("defs");
    const gradient = svgEl("linearGradient", { id: gradientId, x1: 0, y1: 0, x2: 0, y2: 1 });
    gradient.appendChild(svgEl("stop", { offset: "0%", class: "grad-top" }));
    gradient.appendChild(svgEl("stop", { offset: "100%", class: "grad-bottom" }));
    defs.appendChild(gradient); svg.appendChild(defs);
    const half = n > 1 ? step / 2 : plotW / 2;
    let gapStart = -1;
    for (let i = 0; i <= n; i++) {
      const missing = i < n && points[i].value === null;
      if (missing && gapStart < 0) gapStart = i;
      if (!missing && gapStart >= 0) {
        const x0 = Math.max(margin.l, x(gapStart) - half);
        const x1 = Math.min(margin.l + plotW, x(i - 1) + half);
        svg.appendChild(svgEl("rect", { x: x0, y: margin.t, width: Math.max(1, x1 - x0), height: plotH, class: "chart-gap" }));
        gapStart = -1;
      }
    }
    if (scale) {
      scale.ticks.forEach(function (t, index) {
        const ty = y(t);
        svg.appendChild(svgEl("line", { x1: margin.l, x2: margin.l + plotW, y1: ty, y2: ty, class: index === 0 ? "chart-axis" : "chart-grid" }));
        const label = svgEl("text", { x: margin.l - 8, y: ty + 4, "text-anchor": "end", class: "chart-tick" });
        label.textContent = scale.format(t);
        svg.appendChild(label);
      });
      const labelChars = opts.tickLabel ? Math.max.apply(null, points.map(function (_, i) { return opts.tickLabel(i).length; })) : 6;
      tickIndexes(n, Math.floor(plotW / (labelChars * 6.6 + 22)), 0).forEach(function (i) {
        const tx = x(i);
        const anchor = tx - margin.l < 24 ? "start" : margin.l + plotW - tx < 24 ? "end" : "middle";
        const label = svgEl("text", { x: tx, y: height - 8, "text-anchor": anchor, class: "chart-tick" });
        label.textContent = opts.tickLabel ? opts.tickLabel(i) : String(i + 1);
        svg.appendChild(label);
      });
    }
    let run = [];
    const runs = [];
    points.forEach(function (p, i) {
      if (p.value === null) { if (run.length) runs.push(run); run = []; return; }
      run.push(i);
    });
    if (run.length) runs.push(run);
    const baseY = y(Math.max(yMin, 0));
    runs.forEach(function (indexes) {
      if (indexes.length < 2) return;
      let area = "M" + x(indexes[0]) + " " + baseY;
      indexes.forEach(function (i) { area += " L" + x(i) + " " + y(points[i].value); });
      area += " L" + x(indexes[indexes.length - 1]) + " " + baseY + " Z";
      svg.appendChild(svgEl("path", { d: area, class: "chart-area", fill: "url(#" + gradientId + ")" }));
    });
    let solid = ""; let dashed = "";
    runs.forEach(function (indexes) {
      for (let k = 0; k < indexes.length - 1; k++) {
        const a = indexes[k]; const b = indexes[k + 1];
        const segment = "M" + x(a) + " " + y(points[a].value) + " L" + x(b) + " " + y(points[b].value) + " ";
        if (points[a].partial || points[b].partial) dashed += segment; else solid += segment;
      }
    });
    if (solid) svg.appendChild(svgEl("path", { d: solid, class: "chart-line" }));
    if (dashed) svg.appendChild(svgEl("path", { d: dashed, class: "chart-line is-partial" }));
    runs.forEach(function (indexes) {
      if (indexes.length === 1) svg.appendChild(svgEl("circle", { cx: x(indexes[0]), cy: y(points[indexes[0]].value), r: 4, class: "chart-dot" }));
    });
    const lastRun = runs[runs.length - 1];
    if (lastRun && lastRun.length > 1) {
      const last = lastRun[lastRun.length - 1];
      svg.appendChild(svgEl("circle", { cx: x(last), cy: y(points[last].value), r: opts.compact ? 3 : 4, class: "chart-dot" }));
    }
    hoverLine = svgEl("line", { x1: 0, x2: 0, y1: margin.t, y2: margin.t + plotH, class: "chart-crosshair" });
    hoverDot = svgEl("circle", { cx: 0, cy: 0, r: 4.5, class: "chart-hover-dot" });
    svg.appendChild(hoverLine); svg.appendChild(hoverDot);
    frame.canvas.appendChild(svg);
    geometry = { x: x, y: y, margin: margin, plotW: plotW, plotH: plotH, step: step };
    cursor.refresh();
  }
  const cursor = attachCursor(frame, n, {
    indexAt: function (clientX) {
      if (!geometry) return -1;
      const rect = frame.wrap.getBoundingClientRect();
      const px = clientX - rect.left;
      if (n === 1) return 0;
      return Math.max(0, Math.min(n - 1, Math.round((px - geometry.margin.l) / geometry.step)));
    },
    anchor: function (i) {
      if (!geometry) return null;
      const p = points[i];
      return { x: geometry.x(i), y: p.value === null ? geometry.margin.t + geometry.plotH / 2 : geometry.y(p.value) };
    },
    content: opts.tooltip,
    initial: function () {
      for (let i = n - 1; i >= 0; i--) if (points[i].value !== null) return i;
      return n - 1;
    },
    highlight: function (i) {
      if (!hoverLine || !geometry) return;
      if (i < 0) { hoverLine.classList.remove("visible"); hoverDot.classList.remove("visible"); return; }
      const cx = geometry.x(i);
      hoverLine.setAttribute("x1", cx); hoverLine.setAttribute("x2", cx);
      hoverLine.classList.add("visible");
      if (points[i].value === null) { hoverDot.classList.remove("visible"); return; }
      hoverDot.setAttribute("cx", cx); hoverDot.setAttribute("cy", geometry.y(points[i].value));
      hoverDot.classList.add("visible");
    }
  });
  observeWidth(frame.canvas, draw);
  return frame.wrap;
}
function columnPath(x0, y0, w, h, r) {
  const rr = Math.min(r, w / 2, h);
  return "M" + x0 + " " + (y0 + h) + " V" + (y0 + rr) + " Q" + x0 + " " + y0 + " " + (x0 + rr) + " " + y0
    + " H" + (x0 + w - rr) + " Q" + (x0 + w) + " " + y0 + " " + (x0 + w) + " " + (y0 + rr) + " V" + (y0 + h) + " Z";
}
// Column chart for an ordered distribution. cutoffIndex, when set, shades the
// bins at and above a policy threshold and labels it.
function columnChart(opts) {
  const frame = chartFrame(opts.ariaLabel, opts.description);
  const points = opts.points;
  const n = points.length;
  let geometry = null; let bars = []; let svgRoot = null;
  function draw(width) {
    frame.canvas.textContent = "";
    const height = opts.height || 220;
    const scale = niceScale(Math.max.apply(null, points.map(function (p) { return p.value; }).concat([0])), opts.unit, 4);
    let labelWidth = 0;
    scale.ticks.forEach(function (t) { labelWidth = Math.max(labelWidth, scale.format(t).length); });
    const margin = { l: Math.max(30, labelWidth * 6.4 + 12), r: 8, t: opts.cutoffLabel ? 26 : 10, b: 28 };
    const plotW = Math.max(10, width - margin.l - margin.r);
    const plotH = height - margin.t - margin.b;
    const band = plotW / n;
    const barW = Math.max(2, Math.min(24, band - 3));
    function y(v) { return margin.t + plotH - (v / (scale.max || 1)) * plotH; }
    const svg = svgEl("svg", { width: width, height: height, viewBox: "0 0 " + width + " " + height, "aria-hidden": "true", focusable: "false" });
    if (opts.cutoffIndex != null && opts.cutoffIndex >= 0) {
      const cx = margin.l + band * opts.cutoffIndex;
      svg.appendChild(svgEl("rect", { x: cx, y: margin.t, width: margin.l + plotW - cx, height: plotH, class: "chart-region" }));
      svg.appendChild(svgEl("line", { x1: cx, x2: cx, y1: margin.t - 16, y2: margin.t + plotH, class: "chart-marker" }));
      // Label on the right of the marker when it fits, else on the left.
      const text = opts.cutoffLabel || "";
      const estimate = text.length * 6.4;
      const fitsRight = cx + 6 + estimate <= width - 2;
      const note = svgEl("text", { x: fitsRight ? cx + 6 : cx - 6, y: margin.t - 6, "text-anchor": fitsRight ? "start" : "end", class: "chart-annotation" });
      note.textContent = text;
      svg.appendChild(note);
    }
    scale.ticks.forEach(function (t, index) {
      const ty = y(t);
      svg.appendChild(svgEl("line", { x1: margin.l, x2: margin.l + plotW, y1: ty, y2: ty, class: index === 0 ? "chart-axis" : "chart-grid" }));
      const label = svgEl("text", { x: margin.l - 8, y: ty + 4, "text-anchor": "end", class: "chart-tick" });
      label.textContent = scale.format(t);
      svg.appendChild(label);
    });
    bars = [];
    points.forEach(function (p, i) {
      const x0 = margin.l + band * i + (band - barW) / 2;
      const top = y(p.value);
      const h = margin.t + plotH - top;
      const bar = h > 0.5 ? svgEl("path", { d: columnPath(x0, top, barW, h, 4), class: "chart-bar" }) : null;
      if (bar) svg.appendChild(bar);
      bars.push(bar);
    });
    const maxChars = Math.max.apply(null, points.map(function (p) { return p.tick.length; }));
    tickIndexes(n, Math.floor(plotW / (maxChars * 6.6 + 10)), opts.cutoffIndex != null && opts.cutoffIndex >= 0 ? opts.cutoffIndex : 0).forEach(function (i) {
      const label = svgEl("text", { x: margin.l + band * (i + 0.5), y: height - 8, "text-anchor": "middle", class: "chart-tick" });
      label.textContent = points[i].tick;
      svg.appendChild(label);
    });
    frame.canvas.appendChild(svg);
    svgRoot = svg;
    geometry = { margin: margin, band: band, y: y, plotH: plotH };
    cursor.refresh();
  }
  const cursor = attachCursor(frame, n, {
    indexAt: function (clientX) {
      if (!geometry) return -1;
      const rect = frame.wrap.getBoundingClientRect();
      const i = Math.floor((clientX - rect.left - geometry.margin.l) / geometry.band);
      return i >= 0 && i < n ? i : -1;
    },
    anchor: function (i) {
      if (!geometry) return null;
      return { x: geometry.margin.l + geometry.band * (i + 0.5), y: Math.min(geometry.y(points[i].value), geometry.margin.t + geometry.plotH - 8) };
    },
    content: opts.tooltip,
    initial: function () { return 0; },
    highlight: function (i) {
      if (!svgRoot) return;
      svgRoot.classList.toggle("has-active", i >= 0);
      bars.forEach(function (bar, index) { if (bar) bar.classList.toggle("is-active", index === i); });
    }
  });
  observeWidth(frame.canvas, draw);
  return frame.wrap;
}

// ---------- bars and lists ----------
const MODALITY_NAMES = {
  eeg: "EEG", meg: "MEG", ieeg: "iEEG", anat: "Anatomical MRI", func: "Functional MRI", beh: "Behavioral",
  nirs: "fNIRS", fmap: "MRI field maps", emg: "EMG", dwi: "Diffusion MRI", motion: "Motion capture",
  perf: "Perfusion MRI", pet: "PET", micr: "Microscopy"
};
const LICENSE_NAMES = {
  public: "Public domain", attribution: "Attribution", sharealike: "Share-alike",
  noncommercial: "Noncommercial", noderiv: "No derivatives", unknown: "Not specified"
};
function breakdownLabel(metric, label) {
  if (metric.key === "datasets.by_modality" && MODALITY_NAMES[label]) return MODALITY_NAMES[label];
  if (metric.key === "datasets.by_license" && LICENSE_NAMES[label]) return LICENSE_NAMES[label];
  if (metric.key === "cf.by_country") return countryName(label);
  return label;
}
// A breakdown can be denominated differently from its tile: "Most read
// datasets" is a count of datasets whose bars are bytes each. metric.breakdown_unit
// carries that; absent, the bars share the tile's unit.
function hbars(metric, items, options) {
  const unit = metric.breakdown_unit || metric.unit;
  const fmtVal = unitFormatter(unit);
  const max = items.reduce(function (m, it) { return Math.max(m, it.value); }, 0) || 1;
  const share = options && options.shareOf ? options.shareOf : 0;
  const visible = options && options.visible ? options.visible : BREAKDOWN_VISIBLE;
  function rows(target, list) {
    list.forEach(function (it) {
      const row = el("li", "hbar");
      const name = breakdownLabel(metric, it.label);
      const label = el("span", "hbar-label", name);
      // The full name, for a label cut short by the column width.
      label.title = name;
      row.appendChild(label);
      const track = el("span", "hbar-track");
      const fill = el("span", "hbar-fill");
      fill.style.width = (it.value > 0 ? Math.max(1.5, (it.value / max) * 100) : 0) + "%";
      track.appendChild(fill);
      row.appendChild(track);
      const value = el("span", "hbar-value", fmtVal(it.value));
      const p = share ? pct(it.value, share) : null;
      if (p != null) value.appendChild(el("span", "hbar-share", (p < 1 && p > 0 ? "<1" : Math.round(p)) + "%"));
      row.appendChild(value);
      target.appendChild(row);
    });
  }
  const wrap = el("div", "hbars-wrap");
  const list = el("ul", "hbars");
  rows(list, items.slice(0, visible));
  wrap.appendChild(list);
  if (items.length > visible) {
    const more = disclosure("Show all " + items.length);
    const rest = el("ul", "hbars");
    rows(rest, items.slice(visible, BREAKDOWN_MAX));
    more.appendChild(rest);
    if (items.length > BREAKDOWN_MAX) more.appendChild(el("p", "fine", "+" + (items.length - BREAKDOWN_MAX) + " more not shown"));
    wrap.appendChild(more);
  }
  return wrap;
}
// A ranked list prints its value; a bar there would restate it, and one
// dominant entry would flatten the rest into identical stubs.
const RANKED_VISIBLE = 10;
function rankedList(metric, items) {
  const unit = metric.breakdown_unit || metric.unit;
  const fmtVal = unitFormatter(unit);
  const wrap = el("div", "ranked-wrap");
  const rows = function (list, from, to) {
    items.slice(from, to).forEach(function (it, offset) {
      const row = el("li", "ranked-row");
      row.appendChild(el("span", "ranked-rank", from + offset + 1));
      row.appendChild(el("span", "ranked-label", breakdownLabel(metric, it.label)));
      const value = el("span", "ranked-value", fmtVal(it.value));
      const p = metric.total ? pct(it.value, metric.total) : null;
      if (p != null) value.appendChild(el("span", "hbar-share", p.toFixed(1) + "%"));
      row.appendChild(value);
      list.appendChild(row);
    });
  };
  const head = el("ol", "ranked");
  rows(head, 0, RANKED_VISIBLE);
  wrap.appendChild(head);
  const shown = Math.min(items.length, BREAKDOWN_MAX);
  if (shown > RANKED_VISIBLE) {
    const more = disclosure("Show top " + shown);
    const rest = el("ol", "ranked");
    rest.start = RANKED_VISIBLE + 1;
    rows(rest, RANKED_VISIBLE, shown);
    more.appendChild(rest);
    wrap.appendChild(more);
  }
  return wrap;
}

`;
