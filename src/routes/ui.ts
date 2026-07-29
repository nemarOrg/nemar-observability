// The dashboard page: one server-rendered HTML document with embedded CSS and a
// self-contained client script (DOM-built, no framework). The script fetches
// /observability/api/snapshot, renders tiles, and opens admin drill-downs using
// an API key the admin pastes (stored in localStorage). Drill-down requests
// carry the key as a Bearer token; the public snapshot never includes private
// dataset ids.
//
// The client script deliberately avoids template literals and innerHTML for
// data (uses createElement/textContent) so it is safe inside this TS template
// and free of injection from dataset ids / labels.

const CLIENT_JS = String.raw`
const API = "/observability/api";
const KEY_STORE = "nemar_obs_key";
const WW2 = "https://ww2.nemar.org/dataset/";

function getKey() { return localStorage.getItem(KEY_STORE) || ""; }
function setKey(v) { if (v) localStorage.setItem(KEY_STORE, v); else localStorage.removeItem(KEY_STORE); }

// Cached /me role for owner-gating the Delete button. The client gate is
// cosmetic; the authoritative owner check is server-side (proxy + upstream
// ownerMiddleware). fetchMe() runs at bootstrap and after the key changes.
let ME = null; // { username, role } or null
function isOwner() { return !!ME && ME.role === "owner"; }
// Only one publication approve loop at a time across all rows: each loop drives
// the CI-check + GitHub-heavy orchestrator, and running several at once trips
// GitHub's secondary rate limit (see bulk-approval guidance). MUST-FIX #5.
let APPROVE_BUSY = false;
function fetchMe() {
  const k = getKey();
  if (!k) { ME = null; return Promise.resolve(); }
  return fetch(API + "/me", { headers: { Authorization: "Bearer " + k } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) { ME = j && j.role ? { username: j.username, role: j.role } : null; })
    .catch(function () { ME = null; });
}

function humanBytes(n) {
  if (!n || n < 1) return "0 B";
  const u = ["B","KB","MB","GB","TB","PB"]; let i = 0; let x = n;
  while (x >= 1024 && i < u.length - 1) { x /= 1024; i++; }
  return (i === 0 ? x : x.toFixed(1)) + " " + u[i];
}
function fmt(metric) {
  if (metric.unit === "bytes") return humanBytes(metric.value);
  return Number(metric.value).toLocaleString();
}
function pct(value, total) {
  if (!total) return null;
  return Math.round((value / total) * 1000) / 10;
}
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = String(text);
  return e;
}

// A breakdown can be denominated differently from its tile: "Most read
// datasets" is a count of datasets whose bars are bytes each. metric.breakdown_unit
// carries that; absent, the bars share the tile's unit.
function renderBreakdown(parent, items, unit) {
  const max = items.reduce(function (m, it) { return Math.max(m, it.value); }, 0) || 1;
  const fmtVal = unit === "bytes" ? humanBytes : function (v) { return Number(v).toLocaleString(); };
  const list = el("div", "breakdown");
  items.slice(0, 8).forEach(function (it) {
    const row = el("div", "bd-row");
    row.appendChild(el("span", "bd-label", it.label));
    const barWrap = el("span", "bd-bar");
    const bar = el("span", "bd-fill");
    bar.style.width = Math.max(2, (it.value / max) * 100) + "%";
    barWrap.appendChild(bar);
    row.appendChild(barWrap);
    row.appendChild(el("span", "bd-val", fmtVal(it.value)));
    list.appendChild(row);
  });
  if (items.length > 8) list.appendChild(el("div", "bd-more", "+" + (items.length - 8) + " more"));
  parent.appendChild(list);
}

function tile(metric) {
  const t = el("div", "tile sev-" + (metric.severity || "info"));
  if (metric.drilldown) { t.classList.add("clickable"); t.tabIndex = 0; }
  t.appendChild(el("div", "tile-label", metric.label));
  const valRow = el("div", "tile-value");
  valRow.appendChild(el("span", "v", fmt(metric)));
  const p = pct(metric.value, metric.total);
  if (p != null) valRow.appendChild(el("span", "pct", p + "%"));
  t.appendChild(valRow);
  if (metric.total != null && metric.unit !== "bytes") {
    const barWrap = el("div", "pbar");
    const fill = el("div", "pfill");
    fill.style.width = Math.min(100, p || 0) + "%";
    barWrap.appendChild(fill);
    t.appendChild(barWrap);
  }
  if (metric.hint) t.appendChild(el("div", "tile-hint", metric.hint));
  if (metric.breakdown && metric.breakdown.length) renderBreakdown(t, metric.breakdown, metric.breakdown_unit || metric.unit);
  if (metric.drilldown) {
    const open = function () { openDrilldown(metric.drilldown, metric.label); };
    t.addEventListener("click", open);
    t.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
    t.appendChild(el("div", "tile-cta", "View details ->"));
  }
  return t;
}

function renderSnapshot(snap) {
  const root = document.getElementById("sections");
  root.textContent = "";
  if (snap.section_errors && snap.section_errors.length) {
    const bar = el("div", "errbar");
    bar.appendChild(el("strong", null, "Some sections failed to load: "));
    bar.appendChild(el("span", null, snap.section_errors.map(function (e) { return e.key; }).join(", ")));
    bar.appendChild(el("span", " errbar-hint", " (data shown may be incomplete)"));
    root.appendChild(bar);
  }
  snap.sections.forEach(function (section) {
    const card = el("section", "card");
    const head = el("div", "card-head");
    head.appendChild(el("h2", null, section.label));
    head.appendChild(el("span", "src", section.source));
    card.appendChild(head);
    const grid = el("div", "tiles");
    section.metrics.forEach(function (m) { grid.appendChild(tile(m)); });
    card.appendChild(grid);
    root.appendChild(card);
  });
  const ts = el("span", null, "Updated " + new Date(snap.generated_at).toLocaleString());
  const meta = document.getElementById("meta");
  meta.textContent = "";
  meta.appendChild(ts);
}

function drawerEl() { return document.getElementById("drawer"); }
function closeDrawer() { drawerEl().classList.remove("open"); }

function datasetLink(item) {
  const wrap = el("div", "dl-links");
  const a = el("a", "dl-link", item.dataset_id);
  a.href = WW2 + encodeURIComponent(item.dataset_id);
  a.target = "_blank"; a.rel = "noopener";
  wrap.appendChild(a);
  if (item.github_repo) {
    const g = el("a", "dl-gh", "repo");
    // Build via URL so a stray scheme (e.g. javascript:) in github_repo can't
    // become the href scheme -- it lands in the pathname, encoded.
    try {
      const u = new URL("https://github.com/");
      u.pathname = "/" + item.github_repo;
      g.href = u.href;
      g.target = "_blank"; g.rel = "noopener";
      wrap.appendChild(g);
    } catch (e) { /* skip a malformed repo */ }
  }
  return wrap;
}

// Small inline status line appended to a row's action cell.
function rowFeedback(cell) {
  const fb = el("div", "row-fb");
  cell.appendChild(fb);
  return {
    info: function (m) { fb.className = "row-fb"; fb.textContent = m; },
    ok: function (m) { fb.className = "row-fb ok"; fb.textContent = m; },
    err: function (m) { fb.className = "row-fb err"; fb.textContent = m; },
  };
}

// Strike-through + tag a row after a successful action, without wiping content.
function maskRow(tr, label) {
  tr.classList.add("removed");
  const cells = tr.getElementsByTagName("td");
  if (cells.length) cells[cells.length - 1].appendChild(el("span", "removed-tag", label || "removed"));
}

function userRow(item) {
  const tr = el("tr");
  // col 1: identity (username + email/@github)
  const td1 = el("td");
  td1.appendChild(el("div", "u-name", item.username || "(no username)"));
  const sub = el("div", "u-sub");
  if (item.email) sub.appendChild(el("span", "u-email", item.email));
  if (item.github_username) {
    sub.appendChild(el("span", "u-sep", " · "));
    sub.appendChild(el("span", "u-gh", "@" + item.github_username));
  }
  td1.appendChild(sub);
  tr.appendChild(td1);
  // col 2: status + source + created
  const td2 = el("td", "dl-detail");
  td2.appendChild(el("span", "u-status status-" + (item.status || "unknown"), item.status || "?"));
  if (item.signup_source) {
    td2.appendChild(el("span", "u-sep", " · "));
    td2.appendChild(el("span", null, item.signup_source));
  }
  if (item.created_at) td2.appendChild(el("div", "u-when", item.created_at));
  tr.appendChild(td2);
  // col 3: actions
  const td3 = el("td", "dl-actions");
  const fb = rowFeedback(td3);
  // Approve only for status='verified' (nemar-cli approves verified/revoked only).
  if (item.status === "verified" && item.username) {
    const ap = el("button", "btn btn-ok", "Approve");
    ap.addEventListener("click", function () {
      ap.disabled = true; fb.info("Approving…");
      fetch(API + "/actions/users/" + encodeURIComponent(item.username) + "/approve",
        { method: "POST", headers: { Authorization: "Bearer " + getKey() } })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }, function () { return { ok: r.ok, j: {} }; }); })
        .then(function (res) {
          if (res.ok) { fb.ok("Approved"); maskRow(tr, "approved"); }
          else { ap.disabled = false; fb.err((res.j && res.j.error) || "Failed"); }
        })
        .catch(function () { ap.disabled = false; fb.err("Network error"); });
    });
    td3.appendChild(ap);
  }
  // Owner-only Delete (by id). Never in the DOM for non-owners.
  if (isOwner() && item.id != null) {
    const del = el("button", "btn btn-danger", "Delete");
    del.addEventListener("click", function () {
      if (!window.confirm("Permanently delete user '" + (item.username || ("#" + item.id)) + "'? This cannot be undone.")) return;
      del.disabled = true; fb.info("Deleting…");
      fetch(API + "/actions/users/" + encodeURIComponent(item.id),
        { method: "DELETE", headers: { Authorization: "Bearer " + getKey() } })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }, function () { return { ok: r.ok, j: {} }; }); })
        .then(function (res) {
          if (res.ok) { fb.ok("Removed"); maskRow(tr, "removed"); }
          else { del.disabled = false; fb.err((res.j && res.j.error) || "Failed"); }
        })
        .catch(function () { del.disabled = false; fb.err("Network error"); });
    });
    td3.appendChild(del);
  }
  tr.appendChild(td3);
  return tr;
}

// Build a GitHub repo link via URL (scheme-safe) — links to the dataset repo
// under nemarDatasets (NOT ww2). dataset_id is the repo name.
function githubDatasetLink(datasetId) {
  const a = el("a", "dl-link", datasetId);
  try {
    const u = new URL("https://github.com/");
    u.pathname = "/nemarDatasets/" + datasetId;
    a.href = u.href; a.target = "_blank"; a.rel = "noopener";
  } catch (e) { return el("span", null, datasetId); }
  return a;
}

// Progress bar host for the approve loop. Best-effort: width tracks
// steps_completed.length against a soft ceiling; label shows j.step verbatim.
function pbHost(bar) {
  bar.textContent = "";
  const track = el("div", "pb-track");
  const fill = el("div", "pb-fill");
  track.appendChild(fill);
  const step = el("div", "pb-step", "starting…");
  bar.appendChild(track); bar.appendChild(step);
  return {
    set: function (label, completedCount, ceiling) {
      step.textContent = label;
      if (completedCount != null && ceiling) {
        fill.style.width = Math.min(100, Math.round((completedCount / ceiling) * 100)) + "%";
      }
    },
    done: function () { fill.style.width = "100%"; },
  };
}

// A 5xx whose step is ci_check is almost always GitHub's secondary rate limit
// during bulk approval (the upstream wraps that as a 500 "CI check failed").
// Don't blind-retry it: surface it and let the admin retry later or skip CI.
function isCiCheckFailure(j) {
  return !!j && j.step === "ci_check";
}

// Generic publish-approve loop. NEVER hardcodes the step list or s3-lock math:
// it blind-echoes back the continuation fields the server returned, terminates
// on absence of j.hasMore, and is bounded by an absolute iteration cap.
function runPublishApprove(datasetId, fb, bar) {
  const pb = pbHost(bar);
  const skip_ci_check = false;
  let body = { resume: false, skip_ci_check: skip_ci_check };
  let maxCompleted = 1;       // soft ceiling for the progress bar, grows as we learn
  let transientRetries = 0;
  const MAX_TRANSIENT = 4;
  let iterations = 0;
  const MAX_ITERATIONS = 200; // belt-and-suspenders vs a server that never clears hasMore

  function delay(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }

  function step() {
    if (++iterations > MAX_ITERATIONS) {
      fb.err("Stopped after " + MAX_ITERATIONS + " steps without completing — re-open and retry.");
      return false;
    }
    fb.info("Publishing…");
    return fetch(API + "/actions/publish/" + encodeURIComponent(datasetId) + "/approve", {
      method: "POST",
      headers: { Authorization: "Bearer " + getKey(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(function (r) {
      return r.json().then(function (j) { return { status: r.status, ok: r.ok, j: j }; },
        function () { return { status: r.status, ok: r.ok, j: {} }; });
    }).then(function (res) {
      const j = res.j || {};
      const completed = Array.isArray(j.steps_completed) ? j.steps_completed.length : null;
      if (completed != null && completed + 1 > maxCompleted) maxCompleted = completed + 1;
      if (j.step || completed != null) pb.set(j.step || "working…", completed, maxCompleted);

      if (!res.ok) {
        // GitHub secondary-rate-limit on ci_check: surface, don't blind-retry.
        if (res.status >= 500 && isCiCheckFailure(j)) {
          fb.err((j.error || "CI check failed") + " — likely GitHub rate limit. Retry later or skip CI.");
          return false;
        }
        // 426 + other 4xx are non-retryable; only 5xx (+ network) retry, bounded.
        const retryable = res.status >= 500 && transientRetries < MAX_TRANSIENT;
        if (retryable) {
          transientRetries++;
          fb.info("Transient error (" + res.status + "), retrying " + transientRetries + "/" + MAX_TRANSIENT + "…");
          body = { resume: true, skip_ci_check: skip_ci_check };
          if (j.s3_lock_continuation_token !== undefined) body.s3_lock_continuation_token = j.s3_lock_continuation_token;
          if (j.s3_lock_total !== undefined) body.s3_lock_total = j.s3_lock_total;
          return delay(1500 * transientRetries).then(step);
        }
        fb.err((j.error || ("Failed (" + res.status + ")")) + (j.step ? " at " + j.step : ""));
        return false;
      }

      transientRetries = 0; // a clean 2xx resets the transient budget

      if (j.hasMore) {
        // More work: echo back EXACTLY the continuation fields the server gave us.
        body = {
          resume: true,
          skip_ci_check: skip_ci_check,
          s3_lock_continuation_token: j.s3_lock_continuation_token,
          s3_lock_total: j.s3_lock_total,
        };
        return step();
      }

      // No hasMore => terminal. Success iff published / "already completed".
      // Fold any warning into the same success line so it doesn't clobber the
      // confirmation (rowFeedback is a single slot).
      pb.done();
      if (j.status === "published" || /already completed/i.test(j.message || "")) {
        fb.ok((j.message || "Published") + (j.warning ? " — " + String(j.warning) : ""));
      } else {
        fb.ok(j.message || "Done");
      }
      return true;
    }).catch(function () {
      if (transientRetries < MAX_TRANSIENT) {
        transientRetries++;
        fb.info("Network error, retrying " + transientRetries + "/" + MAX_TRANSIENT + "…");
        // Preserve the last continuation state (don't drop the s3_lock token on a
        // network blip, or the server restarts object-locking from the start).
        body = Object.assign({}, body, { resume: true });
        return delay(1500 * transientRetries).then(step);
      }
      fb.err("Network error — publication may be partially complete; re-open and retry.");
      return false;
    });
  }

  return step();
}

function publicationRow(item) {
  const tr = el("tr");
  const td1 = el("td");
  td1.appendChild(githubDatasetLink(item.dataset_id));
  tr.appendChild(td1);
  const td2 = el("td", "dl-detail");
  if (item.status) td2.appendChild(el("span", "p-status", item.status));
  if (item.prescreen_status) {
    td2.appendChild(el("span", "u-sep", " · "));
    td2.appendChild(el("span", null, "prescreen " + item.prescreen_status));
  }
  if (item.current_step) td2.appendChild(el("div", "u-when", "step: " + item.current_step));
  if (item.last_error) td2.appendChild(el("div", "p-err", item.last_error));
  tr.appendChild(td2);
  const td3 = el("td", "dl-actions");
  const fb = rowFeedback(td3);
  const bar = el("div", "pub-bar");
  // Deny
  const deny = el("button", "btn btn-warn", "Deny");
  deny.addEventListener("click", function () {
    if (APPROVE_BUSY) { fb.err("An approval is in progress — wait for it to finish."); return; }
    const reason = window.prompt("Reason for denying " + item.dataset_id + ":", "");
    if (reason === null || reason.trim() === "") return;
    deny.disabled = true; fb.info("Denying…");
    fetch(API + "/actions/publish/" + encodeURIComponent(item.dataset_id) + "/deny",
      { method: "POST", headers: { Authorization: "Bearer " + getKey(), "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() }) })
      .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }, function () { return { ok: r.ok, j: {} }; }); })
      .then(function (res) {
        if (res.ok) { fb.ok("Denied"); maskRow(tr, "denied"); }
        else { deny.disabled = false; fb.err((res.j && res.j.error) || "Failed"); }
      })
      .catch(function () { deny.disabled = false; fb.err("Network error"); });
  });
  td3.appendChild(deny);
  // Approve (typed-confirmation gate → generic loop). The DOI is permanent.
  const appr = el("button", "btn btn-ok", "Approve");
  appr.addEventListener("click", function () {
    if (APPROVE_BUSY) { fb.err("Another approval is in progress — wait for it to finish."); return; }
    const typed = window.prompt("Approving mints a PERMANENT DOI. Type the dataset id (" + item.dataset_id + ") to confirm:", "");
    if (typed === null) return;
    if (typed.trim() !== item.dataset_id) { fb.err("Confirmation did not match — aborted."); return; }
    APPROVE_BUSY = true;
    appr.disabled = true; deny.disabled = true;
    // runPublishApprove resolves true on success, false on a terminal failure.
    // On success the row is done -> mask it; on failure re-enable both buttons so
    // the admin can retry or Deny without reloading the panel.
    Promise.resolve(runPublishApprove(item.dataset_id, fb, bar)).then(
      function (ok) {
        APPROVE_BUSY = false;
        if (ok) { maskRow(tr, "published"); }
        else { appr.disabled = false; deny.disabled = false; }
      },
      function () { APPROVE_BUSY = false; appr.disabled = false; deny.disabled = false; },
    );
  });
  td3.appendChild(appr);
  td3.appendChild(bar);
  tr.appendChild(td3);
  return tr;
}

function renderDrilldown(result) {
  const body = document.getElementById("drawer-body");
  body.textContent = "";
  if (!result.items.length) { body.appendChild(el("p", "muted", "Nothing here — all clear.")); return; }
  const table = el("table", "dl-table");
  result.items.forEach(function (item) {
    if (result.kind === "user") table.appendChild(userRow(item));
    else if (result.kind === "publication") table.appendChild(publicationRow(item));
    else {
      // dataset (unchanged): dataset link + a muted detail cell.
      const tr = el("tr");
      const td1 = el("td");
      if (item.dataset_id) td1.appendChild(datasetLink(item));
      else td1.appendChild(el("span", null, item.username || ""));
      tr.appendChild(td1);
      const detail = item.name || item.status || item.last_error || "";
      tr.appendChild(el("td", "dl-detail", detail));
      table.appendChild(tr);
    }
  });
  body.appendChild(table);
}

function openDrilldown(key, label) {
  const d = drawerEl();
  d.classList.add("open");
  document.getElementById("drawer-title").textContent = label;
  const body = document.getElementById("drawer-body");
  body.textContent = "";
  const apiKey = getKey();
  if (!apiKey) {
    body.appendChild(el("p", "muted", "Admin sign-in required to view the list. Click 'Admin' above and paste your NEMAR API key."));
    return;
  }
  body.appendChild(el("p", "muted", "Loading..."));
  fetch(API + "/drilldown/" + encodeURIComponent(key), { headers: { Authorization: "Bearer " + apiKey } })
    .then(function (r) {
      if (r.status === 401) { body.textContent = ""; body.appendChild(el("p", "muted", "Not authorized. Your API key is missing, invalid, or not an admin key.")); return null; }
      if (!r.ok) { body.textContent = ""; body.appendChild(el("p", "muted", "Failed to load (" + r.status + ").")); return null; }
      return r.json();
    })
    .then(function (result) { if (result) renderDrilldown(result); })
    .catch(function () { body.textContent = ""; body.appendChild(el("p", "muted", "Network error.")); });
}

function refreshAdminBtn() {
  const btn = document.getElementById("admin-btn");
  btn.textContent = getKey() ? "Admin: on" : "Admin";
  btn.classList.toggle("on", !!getKey());
}

function setupAdmin() {
  document.getElementById("admin-btn").addEventListener("click", function () {
    const current = getKey();
    const next = window.prompt(current ? "Update or clear your NEMAR admin API key (empty to sign out):" : "Paste your NEMAR admin API key (stored in this browser only):", current);
    if (next === null) return;
    setKey(next.trim());
    refreshAdminBtn();
    fetchMe();
  });
  document.getElementById("drawer-close").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeDrawer(); });
  refreshAdminBtn();
}

function load() {
  fetch(API + "/snapshot")
    .then(function (r) { return r.json(); })
    .then(renderSnapshot)
    .catch(function () {
      document.getElementById("sections").appendChild(el("p", "muted", "Could not load metrics."));
    });
}

setupAdmin();
fetchMe();
load();
`;

const STYLES = String.raw`
:root {
  --bg: #0f1216; --panel: #161b22; --panel-2: #1c2230; --border: #2a3340;
  --fg: #e7edf3; --muted: #8b97a6; --accent: #4aa3ff;
  --ok: #2ea043; --warn: #d29922; --error: #f85149; --info: #6e7b8a;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg);
  font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
a { color: var(--accent); }
header { display: flex; align-items: center; gap: 16px; padding: 18px 24px;
  border-bottom: 1px solid var(--border); position: sticky; top: 0; background: rgba(15,18,22,.9);
  backdrop-filter: blur(6px); z-index: 5; }
header h1 { font-size: 18px; margin: 0; font-weight: 650; }
header .sub { color: var(--muted); font-size: 13px; }
header .spacer { flex: 1; }
#meta { color: var(--muted); font-size: 12px; margin-right: 4px; }
#admin-btn { background: var(--panel-2); color: var(--fg); border: 1px solid var(--border);
  border-radius: 8px; padding: 6px 12px; cursor: pointer; font-size: 13px; }
#admin-btn.on { border-color: var(--ok); color: var(--ok); }
main { padding: 20px 24px 60px; max-width: 1200px; margin: 0 auto; }
.card { background: var(--panel); border: 1px solid var(--border); border-radius: 14px;
  padding: 16px 18px 18px; margin-bottom: 18px; }
.card-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 14px; }
.card-head h2 { font-size: 15px; margin: 0; font-weight: 600; letter-spacing: .01em; }
.card-head .src { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
.tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 12px; }
.tile { background: var(--panel-2); border: 1px solid var(--border); border-left-width: 3px;
  border-radius: 10px; padding: 12px 13px; }
.tile.clickable { cursor: pointer; }
.tile.clickable:hover { border-color: var(--accent); }
.tile.sev-ok { border-left-color: var(--ok); }
.tile.sev-warn { border-left-color: var(--warn); }
.tile.sev-error { border-left-color: var(--error); }
.tile.sev-info { border-left-color: var(--info); }
.tile-label { color: var(--muted); font-size: 12.5px; margin-bottom: 6px; }
.tile-value { display: flex; align-items: baseline; gap: 8px; }
.tile-value .v { font-size: 26px; font-weight: 680; letter-spacing: -.01em; }
.tile-value .pct { color: var(--muted); font-size: 13px; }
.pbar { height: 4px; background: #0c1015; border-radius: 3px; margin-top: 8px; overflow: hidden; }
.pfill { height: 100%; background: var(--accent); }
.tile-hint { color: var(--muted); font-size: 11.5px; margin-top: 7px; line-height: 1.35; }
.tile-cta { color: var(--accent); font-size: 12px; margin-top: 8px; }
.breakdown { margin-top: 10px; display: flex; flex-direction: column; gap: 4px; }
.bd-row { display: grid; grid-template-columns: 76px 1fr 46px; align-items: center; gap: 6px; font-size: 11.5px; }
.bd-label { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bd-bar { background: #0c1015; height: 7px; border-radius: 4px; overflow: hidden; }
.bd-fill { display: block; height: 100%; background: var(--accent); opacity: .8; }
.bd-val { text-align: right; color: var(--fg); }
.bd-more { color: var(--muted); font-size: 11px; margin-top: 2px; }
.muted { color: var(--muted); }
.errbar { background: rgba(248,81,73,.12); border: 1px solid var(--error); color: #ffd7d4;
  border-radius: 10px; padding: 10px 14px; margin-bottom: 16px; font-size: 13px; }
.errbar-hint { color: var(--muted); }
#drawer { position: fixed; top: 0; right: 0; height: 100%; width: min(460px, 92vw);
  background: var(--panel); border-left: 1px solid var(--border); transform: translateX(100%);
  transition: transform .18s ease; z-index: 20; display: flex; flex-direction: column; }
#drawer.open { transform: translateX(0); box-shadow: -20px 0 50px rgba(0,0,0,.4); }
.drawer-head { display: flex; align-items: center; gap: 10px; padding: 16px 18px; border-bottom: 1px solid var(--border); }
.drawer-head h3 { margin: 0; font-size: 15px; flex: 1; }
#drawer-close { background: none; border: none; color: var(--muted); font-size: 22px; cursor: pointer; line-height: 1; }
#drawer-body { padding: 14px 18px; overflow: auto; }
.dl-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.dl-table td { padding: 7px 6px; border-bottom: 1px solid var(--border); vertical-align: top; }
.dl-links { display: flex; gap: 8px; align-items: center; }
.dl-gh { font-size: 11px; color: var(--muted); }
.dl-detail { color: var(--muted); }
.dl-actions { white-space: nowrap; text-align: right; }
.btn { background: var(--panel-2); color: var(--fg); border: 1px solid var(--border);
  border-radius: 7px; padding: 4px 10px; font-size: 12px; cursor: pointer; margin-left: 6px; }
.btn:disabled { opacity: .5; cursor: default; }
.btn-ok { border-color: var(--ok); color: var(--ok); }
.btn-warn { border-color: var(--warn); color: var(--warn); }
.btn-danger { border-color: var(--error); color: var(--error); }
.row-fb { font-size: 11.5px; margin-top: 5px; color: var(--muted); }
.row-fb.ok { color: var(--ok); }
.row-fb.err { color: var(--error); }
.removed { opacity: .45; }
.removed td { text-decoration: line-through; }
.removed-tag { margin-left: 8px; font-size: 11px; color: var(--muted); text-decoration: none; display: inline-block; }
.u-name { font-weight: 600; }
.u-sub { color: var(--muted); font-size: 11.5px; }
.u-status { text-transform: uppercase; letter-spacing: .04em; font-size: 10.5px; padding: 1px 6px;
  border: 1px solid var(--border); border-radius: 6px; }
.status-verified { color: var(--warn); border-color: var(--warn); }
.status-pending { color: var(--muted); }
.status-approved { color: var(--ok); border-color: var(--ok); }
.u-when { color: var(--muted); font-size: 11px; margin-top: 3px; }
.p-status { text-transform: capitalize; }
.p-err { color: var(--error); font-size: 11.5px; margin-top: 3px; }
.pub-bar { margin-top: 6px; min-height: 4px; }
.pb-track { height: 5px; background: #0c1015; border-radius: 3px; overflow: hidden; margin-top: 4px; }
.pb-fill { height: 100%; background: var(--accent); width: 0%; transition: width .2s; }
.pb-step { font-size: 11px; color: var(--muted); margin-top: 4px; }
`;

export function renderDashboardPage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>NEMAR Observability</title><meta name="robots" content="noindex"><style>${STYLES}</style></head><body><header><h1>NEMAR Observability</h1><span class="sub">dataset &amp; pipeline health</span><span class="spacer"></span><span id="meta"></span><button id="admin-btn">Admin</button></header><main><div id="sections"></div></main><aside id="drawer"><div class="drawer-head"><h3 id="drawer-title"></h3><button id="drawer-close" aria-label="Close">&times;</button></div><div id="drawer-body"></div></aside><script>${CLIENT_JS}</script></body></html>`;
}
