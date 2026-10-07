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
// Notices shown above the readout when the data should not be read at face
// value: it is more than three days old, or some datasets could not be read in
// the run that produced it. now is for tests; the page passes nothing.
const STALE_AFTER_HOURS = 72;
function hoursDataNotices(section, payload, now) {
  const notes = [];
  const nowMs = typeof now === "number" ? now : Date.now();
  const updated = section ? Date.parse(section.updated_at) : Number.NaN;
  if (Number.isFinite(updated) && nowMs - updated > STALE_AFTER_HOURS * 3600000) {
    notes.push("This was last updated " + relativeTime(section.updated_at, nowMs) + ".");
  }
  if (payload && payload.datasets_unavailable > 0) {
    notes.push(plural(payload.datasets_unavailable, "dataset", "datasets") + " could not be read in the last run, so these totals are incomplete.");
  }
  return notes;
}
// Hours in the exact-values table, where the column names the unit.
function tableHours(n) {
  if (n > 0 && n < 0.05) return "<0.1";
  return (Math.round(n * 10) / 10).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

// ---------- recorded hours: the payload ----------
const CHANNEL_MEASURES = ["hours", "recordings", "datasets"];
const DEFAULT_MIN_CHANNELS = 16;
// The page checks the payload by the same rules as the server's
// ChannelHoursSchema (src/lib/schema.ts), so a payload that reached the page by
// another route cannot hang the axis (a huge channel count), select two tabs at
// once (EEG and eeg), or print NaN. test/channel-hours.test.ts holds the two to
// parity: whatever the schema rejects, this rejects too.
const MODALITY_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const MAX_CHANNELS = 100000;
function isCount(value) { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function isAmount(value) { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function isChannels(value) { return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_CHANNELS; }
function onlyKeys(value, keys) { return Object.keys(value).every(function (k) { return keys.indexOf(k) >= 0; }); }
function ascending(items) {
  for (let i = 1; i < items.length; i++) if (!(items[i].channels > items[i - 1].channels)) return false;
  return true;
}
function validModality(m, scanned) {
  if (!isObject(m) || !onlyKeys(m, ["modality", "hours", "recordings", "datasets", "bins", "dataset_peaks"])) return false;
  if (typeof m.modality !== "string" || !MODALITY_NAME.test(m.modality)) return false;
  if (!isAmount(m.hours) || !isCount(m.recordings) || !isCount(m.datasets) || m.datasets > scanned) return false;
  if (!Array.isArray(m.bins) || m.bins.length < 1 || m.bins.length > 1024) return false;
  if (!Array.isArray(m.dataset_peaks) || m.dataset_peaks.length < 1 || m.dataset_peaks.length > 1024) return false;
  const binsOk = m.bins.every(function (b) {
    return isObject(b) && onlyKeys(b, ["channels", "hours", "recordings"]) && isChannels(b.channels) && isAmount(b.hours) && isCount(b.recordings) && b.recordings >= 1;
  });
  const peaksOk = m.dataset_peaks.every(function (p) {
    return isObject(p) && onlyKeys(p, ["channels", "datasets"]) && isChannels(p.channels) && isCount(p.datasets) && p.datasets >= 1;
  });
  if (!binsOk || !peaksOk || !ascending(m.bins) || !ascending(m.dataset_peaks)) return false;
  const binRecordings = Object.create(null);
  let hours = 0; let recordings = 0; let datasets = 0;
  m.bins.forEach(function (b) { hours += b.hours; recordings += b.recordings; binRecordings[b.channels] = b.recordings; });
  for (let i = 0; i < m.dataset_peaks.length; i++) {
    const peak = m.dataset_peaks[i];
    const inBin = binRecordings[peak.channels];
    if (inBin === undefined || peak.datasets > inBin) return false;
    datasets += peak.datasets;
  }
  // Both lists ascend, so their last entries are the largest counts.
  if (m.bins[m.bins.length - 1].channels !== m.dataset_peaks[m.dataset_peaks.length - 1].channels) return false;
  return recordings === m.recordings && datasets === m.datasets && Math.abs(hours - m.hours) <= Math.max(1e-6, m.hours * 1e-9);
}
function validChannelHours(payload) {
  if (!isObject(payload) || !onlyKeys(payload, ["datasets_scanned", "datasets_unavailable", "recordings_unmeasured", "modalities"])) return false;
  if (!isCount(payload.datasets_scanned) || !isCount(payload.datasets_unavailable) || !isCount(payload.recordings_unmeasured)) return false;
  if (!Array.isArray(payload.modalities) || payload.modalities.length < 1 || payload.modalities.length > 32) return false;
  const seen = Object.create(null);
  return payload.modalities.every(function (m) {
    if (!validModality(m, payload.datasets_scanned)) return false;
    // Names are unique regardless of case: EEG and eeg are one modality.
    const key = m.modality.toLowerCase();
    if (seen[key]) return false;
    seen[key] = true;
    return true;
  });
}
// Where the payload is: only the section the Zarr indexer pushes (key
// recordings), because the explorer names its source; another section that
// happens to carry channel_hours is not shown. The state says what the page
// can honestly show: missing (no such section), no-payload (the section has no
// hours this run), invalid, or ok.
function findChannelHours(snap) {
  const sections = snap && Array.isArray(snap.sections) ? snap.sections : [];
  const section = sections.find(function (s) { return isObject(s) && s.key === "recordings"; });
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
  return Math.max(512, Math.pow(2, Math.floor(Math.log2(Math.min(largest, MAX_CHANNELS))) + 1));
}
// Capped at 2^20 whatever it is given, so a bad axis can never loop forever.
function axisPowers(axisMax) {
  const out = [];
  for (let p = 1; p <= axisMax && out.length <= 20; p *= 2) out.push(p);
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
// The largest channel count that occurs in a modality: where End goes, so it
// never lands on an empty power of two (EMG in the sample tops out at 32).
function largestCount(modality) {
  return modality.bins.reduce(function (m, b) { return Math.max(m, b.channels); }, 1);
}
// Page Up and Page Down jump between powers of two; past the last power they
// fall back to the next occurring count (in the sample, EEG's 256 then Page Up
// reaches 257).
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
// #hours=eeg:16 or #hours=ieeg:64:datasets, matched without regard to case.
// null means the address is not an explorer link at all; { valid: false } means
// it is one that cannot be read, so the page can say so instead of quietly
// showing something else. A part that does not parse invalidates the whole link
// rather than half applying it.
function parseHoursHash(hash) {
  const text = String(hash || "");
  if (text.indexOf("#hours=") !== 0) return null;
  const invalid = { valid: false };
  const match = /^#hours=([^:]+):(\d{1,6})(?::([A-Za-z]+))?$/.exec(text);
  if (!match) return invalid;
  let key;
  try {
    key = decodeURIComponent(match[1]).toLowerCase();
  } catch (err) {
    console.warn("[ui] a #hours= link has a malformed escape:", err);
    return invalid;
  }
  const min = Number(match[2]);
  const measure = (match[3] || "hours").toLowerCase();
  if (!key || min < 1 || CHANNEL_MEASURES.indexOf(measure) < 0) return invalid;
  return { valid: true, modality: key, min: min, measure: measure };
}
function hoursHash(view) {
  return "#hours=" + encodeURIComponent(view.modality) + ":" + view.min + (view.measure && view.measure !== "hours" ? ":" + view.measure : "");
}
`;
