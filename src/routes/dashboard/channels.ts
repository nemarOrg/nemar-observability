// Recorded hours by channel count: everything the explorer decides before it
// draws, with no DOM access, so the tests run this exact code. It finds the
// payload in a snapshot, orders the modalities, answers "how much at N or more
// channels" from the exact bins, picks the slider's stops, and reads and
// writes the shareable #hours= view. Hours themselves are formatted in format.ts.
//
// Part of the inlined client script (see client.ts): a String.raw template, so
// no backticks and no dollar-brace sequences.

export const CHANNELS_JS = String.raw`
// ---------- recorded hours: readout text ----------
// The large readout figure, split so the unit can be set smaller than the number.
function measureFigure(measure, value) {
  if (measure === "hours") {
    const text = hoursNumber(value);
    return { number: text, unit: text === "1" ? "hour" : "hours" };
  }
  if (measure === "recordings") return { number: num(value), unit: value === 1 ? "recording" : "recordings" };
  return { number: num(value), unit: value === 1 ? "dataset" : "datasets" };
}
function measureText(measure, value) {
  const figure = measureFigure(measure, value);
  return figure.number + " " + figure.unit;
}
// A share that never reads 0% for a small nonzero part or 100% for a part short of the whole.
function partShare(value, total) {
  if (!total) return "";
  // Summed hours carry floating-point noise; a part within a billionth of the
  // whole is the whole.
  if (Math.abs(total - value) <= total * 1e-9) return "100%";
  const p = (value / total) * 100;
  if (value > 0 && p < 0.1) return "<0.1%";
  if (value < total && p > 99.9) return ">99.9%";
  return (Math.round(p * 10) / 10).toLocaleString("en-US") + "%";
}
function thresholdText(minChannels) {
  return minChannels <= 1 ? "any number of channels" : num(minChannels) + " or more channels";
}
// The sentence under the large figure: "2,445 hours / of EEG recorded with 16
// or more channels", "47 datasets / have EEG recordings with ...".
function hoursClaim(measure, name, minChannels, value) {
  const threshold = thresholdText(minChannels);
  if (measure === "datasets") return (value === 1 ? "has " : "have ") + name + " recordings with " + threshold;
  if (measure === "recordings") return "of " + name + " with " + threshold;
  return "of " + name + " recorded with " + threshold;
}
// "52.6% of the 4,646 EEG hours".
function hoursShareLine(measure, value, total, name) {
  if (!total) return "No " + name + " " + measureFigure(measure, 0).unit + " are measured yet.";
  const whole = measureFigure(measure, total);
  return partShare(value, total) + " of the " + whole.number + " " + name + " " + whole.unit;
}
// Channel-hours: channels times hours, a measure of how much signal there is.
function channelHoursText(n) { return n < 10000 ? num(Math.round(n)) : shortScaled(n); }
// The two measures the large figure is not showing, then channel-hours.
function hoursFacts(measure, part) {
  const facts = [];
  if (measure !== "hours") facts.push({ label: "Hours", value: humanHours(part.hours) });
  if (measure !== "recordings") facts.push({ label: "Recordings", value: num(part.recordings) });
  if (measure !== "datasets") facts.push({ label: "Datasets", value: num(part.datasets) });
  facts.push({ label: "Channel-hours", value: channelHoursText(part.channelHours) });
  return facts;
}
// Hours in the exact-values table, where the column names the unit.
function tableHours(n) {
  if (n > 0 && n < 0.05) return "<0.1";
  return (Math.round(n * 10) / 10).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

// ---------- recorded hours: the payload ----------
const CHANNEL_MEASURES = ["hours", "recordings", "datasets"];
const DEFAULT_MIN_CHANNELS = 16;
// Where the payload is: the section the Zarr indexer pushes (key recordings),
// or failing that the first section that carries one. The state says what the
// page can honestly show: missing (nothing indexed yet), no-payload (the
// section is there but this run reported no hours), invalid, or ok.
function isCount(value) { return typeof value === "number" && Number.isInteger(value) && value >= 0; }
function isAmount(value) { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function validChannelHours(payload) {
  return isObject(payload) && isCount(payload.datasets_scanned) && isCount(payload.datasets_unavailable)
    && isCount(payload.recordings_unmeasured) && Array.isArray(payload.modalities) && payload.modalities.length > 0
    && payload.modalities.every(function (m) {
      return isObject(m) && typeof m.modality === "string" && m.modality.length > 0
        && isAmount(m.hours) && isCount(m.recordings) && isCount(m.datasets)
        && Array.isArray(m.bins) && m.bins.length > 0 && Array.isArray(m.dataset_peaks)
        && m.bins.every(function (b) { return isObject(b) && isCount(b.channels) && b.channels >= 1 && isAmount(b.hours) && isCount(b.recordings); })
        && m.dataset_peaks.every(function (p) { return isObject(p) && isCount(p.channels) && p.channels >= 1 && isCount(p.datasets); });
    });
}
function findChannelHours(snap) {
  const sections = snap && Array.isArray(snap.sections) ? snap.sections : [];
  const carrying = sections.filter(function (s) { return isObject(s) && s.channel_hours !== undefined; });
  const section = carrying.find(function (s) { return s.key === "recordings"; }) || carrying[0]
    || sections.find(function (s) { return isObject(s) && s.key === "recordings"; });
  if (!section) return { state: "missing", section: null, payload: null };
  if (section.channel_hours === undefined) return { state: "no-payload", section: section, payload: null };
  if (!validChannelHours(section.channel_hours)) return { state: "invalid", section: section, payload: null };
  return { state: "ok", section: section, payload: section.channel_hours };
}
// Modalities by hours, most first (ties by name), each with a lowercase key for
// the URL and ids, and its bins and dataset peaks in channel order.
function modalityKey(name) { return String(name).toLowerCase(); }
function prepareModalities(payload) {
  function byChannels(a, b) { return a.channels - b.channels; }
  return payload.modalities.map(function (m) {
    return {
      name: m.modality,
      key: modalityKey(m.modality),
      hours: m.hours,
      recordings: m.recordings,
      datasets: m.datasets,
      bins: m.bins.slice().sort(byChannels),
      peaks: m.dataset_peaks.slice().sort(byChannels)
    };
  }).sort(function (a, b) { return b.hours - a.hours || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0); });
}
// Everything recorded with minChannels channels or more. Hours, recordings and
// channel-hours come from the exact bins; datasets from the dataset peaks, so a
// dataset with recordings at several counts is counted once.
function atLeast(modality, minChannels) {
  const out = { hours: 0, recordings: 0, datasets: 0, channelHours: 0 };
  modality.bins.forEach(function (b) {
    if (b.channels < minChannels) return;
    out.hours += b.hours;
    out.recordings += b.recordings;
    out.channelHours += b.channels * b.hours;
  });
  modality.peaks.forEach(function (p) { if (p.channels >= minChannels) out.datasets += p.datasets; });
  return out;
}
// The marks the chart draws for one measure: hours or recordings at each exact
// channel count, or datasets by the channel count of their largest recording.
function channelSeries(modality, measure) {
  if (measure === "datasets") return modality.peaks.map(function (p) { return { channels: p.channels, value: p.datasets }; });
  return modality.bins.map(function (b) { return { channels: b.channels, value: measure === "recordings" ? b.recordings : b.hours }; });
}

// One row per channel count that has recordings or is some dataset's largest,
// with zeros where a measure has nothing at that count.
function hoursTableRows(modality) {
  const rows = {};
  function row(channels) {
    if (!rows[channels]) rows[channels] = { channels: channels, hours: 0, recordings: 0, datasets: 0 };
    return rows[channels];
  }
  modality.bins.forEach(function (b) { const r = row(b.channels); r.hours = b.hours; r.recordings = b.recordings; });
  modality.peaks.forEach(function (p) { row(p.channels).datasets = p.datasets; });
  return Object.keys(rows).map(function (k) { return rows[k]; }).sort(function (a, b) { return a.channels - b.channels; });
}

// ---------- recorded hours: the channel axis and slider stops ----------
// One axis for every modality, so switching tabs never moves the scale: powers
// of two from 1 up to the first one past the largest count, and at least 512 so
// "256 or more" always has room on its right.
function axisMaxFor(modalities) {
  let largest = 1;
  modalities.forEach(function (m) {
    m.bins.forEach(function (b) { largest = Math.max(largest, b.channels); });
    m.peaks.forEach(function (p) { largest = Math.max(largest, p.channels); });
  });
  return Math.max(512, Math.pow(2, Math.floor(Math.log2(largest)) + 1));
}
function axisPowers(axisMax) {
  const out = [];
  for (let p = 1; p <= axisMax; p *= 2) out.push(p);
  return out;
}
// Where the slider can rest: the powers of two people think in (1 is any
// count) and every exact count that occurs in this modality.
function channelStops(modality, axisMax) {
  const set = {};
  axisPowers(axisMax / 2).forEach(function (p) { set[p] = true; });
  modality.bins.forEach(function (b) { set[b.channels] = true; });
  modality.peaks.forEach(function (p) { set[p.channels] = true; });
  return Object.keys(set).map(Number).filter(function (c) { return c >= 1 && c < axisMax; }).sort(function (a, b) { return a - b; });
}
// The next stop above (direction 1) or below (-1) a value. With nothing further
// that way it stays put, so a step never moves against its own direction (a
// minimum from a link can sit beyond the last stop).
function stepStop(stops, current, direction) {
  if (direction > 0) {
    for (let i = 0; i < stops.length; i++) if (stops[i] > current) return stops[i];
    return current;
  }
  for (let i = stops.length - 1; i >= 0; i--) if (stops[i] < current) return stops[i];
  return current;
}
// Page Up and Page Down jump between powers of two; past the last power they
// fall back to the next exact count, so 256 then Page Up still reaches 257.
function stepPower(stops, current, direction) {
  const powers = stops.filter(function (c) { return (c & (c - 1)) === 0; });
  const next = stepStop(powers, current, direction);
  return next === current ? stepStop(stops, current, direction) : next;
}
// Gridlines for a measure that counts things: whole numbers only, never a
// 2.5 step whose labels would round to the wrong value. Three to five lines.
function countScale(max) {
  const top = Math.max(1, Math.ceil(max));
  const parts = [3, 4, 2, 5];
  for (let k = 0; k < parts.length; k++) {
    const raw = top / parts[k];
    const base = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / base;
    const step = Math.max(1, (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * base);
    if (!Number.isInteger(step)) continue;
    const ceiling = Math.ceil(top / step) * step;
    const ticks = [];
    for (let v = 0; v <= ceiling; v += step) ticks.push(v);
    return { max: ceiling, ticks: ticks };
  }
  return { max: top, ticks: [0, top] };
}
// The stop nearest a dragged position, measured on the log axis.
function nearestStop(stops, channels) {
  const target = Math.log2(Math.max(1, channels));
  let best = stops[0];
  stops.forEach(function (c) { if (Math.abs(Math.log2(c) - target) < Math.abs(Math.log2(best) - target)) best = c; });
  return best;
}

// ---------- recorded hours: shareable view ----------
// #hours=eeg:16 or #hours=ieeg:64:datasets. A part that does not parse makes
// the whole hash ignored rather than half applied.
function parseHoursHash(hash) {
  const match = /^#hours=([^:]+):(\d{1,6})(?::([a-z]+))?$/.exec(String(hash || ""));
  if (!match) return null;
  let key;
  try { key = decodeURIComponent(match[1]).toLowerCase(); } catch (err) { return null; }
  const min = Number(match[2]);
  const measure = match[3] || "hours";
  if (!key || min < 1 || CHANNEL_MEASURES.indexOf(measure) < 0) return null;
  return { modality: key, min: min, measure: measure };
}
function hoursHash(view) {
  return "#hours=" + encodeURIComponent(view.modality) + ":" + view.min + (view.measure && view.measure !== "hours" ? ":" + view.measure : "");
}
`;
