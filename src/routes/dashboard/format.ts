// Number, byte, hour, and date formatting for the client script, with no DOM
// access, so the tests can run this exact code.
//
// Part of the inlined client script (see client.ts): a String.raw template, so
// no backticks and no dollar-brace sequences.

export const FORMAT_JS = String.raw`
// ---------- formatting ----------
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function humanBytes(n) {
  if (!n || n < 1) return "0 B";
  const u = ["B","kB","MB","GB","TB","PB"]; let i = 0; let x = n;
  while (x >= 1000 && i < u.length - 1) { x /= 1000; i++; }
  return (i === 0 ? x : x.toFixed(1)) + " " + u[i];
}
function num(n) { return Number(n).toLocaleString("en-US"); }
const compactFormatter = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
function compact(n) {
  if (!Number.isFinite(n)) return "Unknown";
  return Math.abs(n) < 10000 ? Math.round(n).toLocaleString("en-US") : compactFormatter.format(n);
}
// Three significant figures with a k or M suffix, so 31,234 reads 31.2k and
// 143,000 reads 143k; 999,999 rounds up to 1M rather than reading 1000k.
function shortScaled(n) {
  const millions = Number((n / 1e6).toPrecision(3));
  if (millions >= 1) return String(millions) + "M";
  return String(Number((n / 1e3).toPrecision(3))) + "k";
}
// The number part of a spelled-out hours figure: one decimal under 10, whole
// hours with commas above, and a small nonzero amount never reads as zero.
function hoursNumber(n) {
  if (n === 0) return "0";
  if (n < 0.05) return "less than 0.1";
  if (n < 10) return (Math.round(n * 10) / 10).toLocaleString("en-US", { maximumFractionDigits: 1 });
  return Math.round(n).toLocaleString("en-US");
}
// Recorded time as a short label: 0.4 h, 7.1 h, 1,234 h, 31.2k h, 143k h, 1.23M h.
function humanHours(n) {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "Unknown";
  if (n === 0) return "0 h";
  if (n < 0.05) return "<0.1 h";
  return (n < 10000 ? hoursNumber(n) : shortScaled(n)) + " h";
}
// Hours spelled out for sentences and screen readers, rounded like the
// readout: 7.1 hours, 2,445 hours (4,645.6 reads 4,646 hours).
function spelledOutHours(n) {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "an unknown number of hours";
  const text = hoursNumber(n);
  return text + (text === "1" ? " hour" : " hours");
}
// Units that read as a plain number: the label beside the figure already says
// what is counted. fmt() also knows percent and status.
const PLAIN_UNITS = ["count", "datasets", "errors", "requests", "users", "recordings", "percent", "status"];
// How an amount in a unit reads in a list, beside a total, or as a tile value:
// bytes and hours carry their unit, plain counts are a number, and a unit this
// page does not know keeps its name ("12 minutes") rather than passing as a count.
function unitFormatter(unit) {
  if (unit === "bytes") return humanBytes;
  if (unit === "hours") return humanHours;
  if (!unit || PLAIN_UNITS.indexOf(unit) >= 0) return num;
  // Exactly as the producer wrote it: "GB" stays GB, "wall_clock_s" stays as is.
  return function (v) { return num(v) + " " + unit; };
}
function fmt(metric) {
  if (metric.unit === "hours") return humanHours(metric.value);
  if (metric.unit && metric.unit !== "bytes" && PLAIN_UNITS.indexOf(metric.unit) < 0) return unitFormatter(metric.unit)(metric.value);
  if (metric.unit === "bytes") return humanBytes(metric.value);
  if (metric.unit === "percent") return num(metric.value) + "%";
  return num(metric.value);
}
function pct(value, total) {
  if (!total) return null;
  return Math.round((value / total) * 1000) / 10;
}
// A share in words that never reads 0% for a small nonzero part or 100% for a
// part short of the whole; empty without a total.
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
function parseDay(day) { return new Date(day + "T00:00:00Z"); }
function shortDay(day) { const d = parseDay(day); return MONTHS[d.getUTCMonth()] + " " + d.getUTCDate(); }
function longDay(day) { const d = parseDay(day); return MONTHS[d.getUTCMonth()] + " " + d.getUTCDate() + ", " + d.getUTCFullYear(); }
function rangeText(start, end) {
  if (start === end) return longDay(start);
  if (start.slice(0, 4) === end.slice(0, 4)) return shortDay(start) + " to " + longDay(end);
  return longDay(start) + " to " + longDay(end);
}
function formatDateTime(iso) {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "an unknown time";
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" }) + " UTC";
}
function relativeTime(iso, now) {
  const ms = (typeof now === "number" ? now : Date.now()) - Date.parse(iso);
  if (!Number.isFinite(ms)) return "at an unknown time";
  const minutes = Math.round(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return minutes + (minutes === 1 ? " minute ago" : " minutes ago");
  const hours = Math.round(minutes / 60);
  if (hours < 48) return hours + (hours === 1 ? " hour ago" : " hours ago");
  const days = Math.round(hours / 24);
  return days + " days ago";
}
function plural(count, one, many) { return num(count) + " " + (count === 1 ? one : many); }

// ---------- plain names ----------
// The public page names sources and sections in plain words; the ids stay in
// the API for machines. An id not listed here is shown as readable words.
const SOURCE_LABELS = {
  "nemar-cli": "the NEMAR database",
  access: "NEMAR access logs",
  cloudflare: "network edge analytics",
  "aws-s3-cloudwatch": "storage metrics",
  umami: "website analytics",
  "nemar-zarr-index": "public datasets converted for in-browser viewing"
};
const SECTION_LABELS = {
  datasets: "Datasets", sizes: "Dataset sizes", archive: "Archives", zarr: "Zarr conversion",
  imports: "OpenNeuro import", publication: "Publication", access: "Access", cf: "Edge traffic",
  users: "Users", egress: "Storage egress", recordings: "Recorded hours", pushed: "Pipeline sections"
};
function readableId(id) {
  const words = String(id == null ? "" : id).replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Unnamed";
}
function sourceLabel(id) { return Object.prototype.hasOwnProperty.call(SOURCE_LABELS, id) ? SOURCE_LABELS[id] : readableId(id).toLowerCase(); }
function sectionLabel(key) { return Object.prototype.hasOwnProperty.call(SECTION_LABELS, key) ? SECTION_LABELS[key] : readableId(key); }
`;
