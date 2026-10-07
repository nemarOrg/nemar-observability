// Number, byte, and date formatting for the client script, with no DOM
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
function fmt(metric) {
  if (metric.unit === "bytes") return humanBytes(metric.value);
  if (metric.unit === "percent") return num(metric.value) + "%";
  if (metric.unit === "status") return metric.severity === "ok" ? "Healthy" : metric.severity === "warn" ? "Warning" : "Failing";
  return num(metric.value);
}
function pct(value, total) {
  if (!total) return null;
  return Math.round((value / total) * 1000) / 10;
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
  umami: "website analytics"
};
const SECTION_LABELS = {
  datasets: "Datasets", sizes: "Dataset sizes", archive: "Archives", zarr: "Zarr conversion",
  imports: "OpenNeuro import", publication: "Publication", access: "Access", cf: "Edge traffic",
  users: "Users", egress: "Storage egress", pushed: "Pipeline sections"
};
function readableId(id) {
  const words = String(id == null ? "" : id).replace(/[_-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Unnamed";
}
function sourceLabel(id) { return Object.prototype.hasOwnProperty.call(SOURCE_LABELS, id) ? SOURCE_LABELS[id] : readableId(id).toLowerCase(); }
function sectionLabel(key) { return Object.prototype.hasOwnProperty.call(SECTION_LABELS, key) ? SECTION_LABELS[key] : readableId(key); }
`;
