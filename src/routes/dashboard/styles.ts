// Styles for the dashboard page, inlined by routes/ui.ts.

export const STYLES = String.raw`
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
header .portal { color: var(--muted); font-size: 13px; text-decoration: none;
  border: 1px solid var(--border); border-radius: 8px; padding: 6px 12px; }
header .portal:hover { color: var(--fg); border-color: var(--accent); }
main { padding: 20px 24px 60px; max-width: 1440px; margin: 0 auto; }
.card { background: var(--panel); border: 1px solid var(--border); border-radius: 14px;
  padding: 15px 16px 16px; margin-bottom: 14px; }
.card-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 14px; }
.card-head h2 { font-size: 15px; margin: 0; font-weight: 600; letter-spacing: .01em; }
.card-head .src { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
.tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(210px, 1fr)); gap: 12px; align-items: start; }
/* Distribution + companion list: ~2/3 and ~1/3, stacking on narrow screens. */
.tiles.split { grid-template-columns: 2fr 1fr; }
@media (max-width: 720px) { .tiles.split { grid-template-columns: 1fr; } }
.tile { background: var(--panel-2); border: 1px solid var(--border); border-left-width: 3px;
  border-radius: 10px; padding: 12px 13px; }
.tile.sev-ok { border-left-color: var(--ok); }
.tile.sev-warn { border-left-color: var(--warn); }
.tile.sev-error { border-left-color: var(--error); }
.tile.sev-info { border-left-color: var(--info); }
.tile-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
.tile-label { color: var(--muted); font-size: 12.5px; margin-bottom: 6px; }
.info-disclosure { position: relative; display: inline-flex; flex: none; }
.info-icon { display: inline-grid; place-items: center; width: 19px; height: 19px; border: 1px solid var(--border); border-radius: 50%; color: var(--muted); cursor: pointer; font-size: 12px; font-weight: 700; line-height: 1; list-style: none; }
.info-icon::-webkit-details-marker { display: none; }
.info-icon:hover, .info-icon:focus-visible { border-color: var(--accent); color: var(--fg); }
.info-content { position: absolute; z-index: 10; top: 25px; left: 0; width: min(320px, 78vw); padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; background: #111820; box-shadow: 0 8px 24px rgba(0,0,0,.35); color: var(--fg); font-size: 12px; font-weight: 400; line-height: 1.45; }
.tile .info-content { right: 0; left: auto; }
.tile-status { border-radius: 4px; flex: none; font-size: 9px; font-weight: 700; letter-spacing: .04em; padding: 2px 5px; text-transform: uppercase; }
.tile-status.status-warn { background: rgba(210,153,34,.16); color: #f0c65a; }
.tile-status.status-error { background: rgba(248,81,73,.16); color: #ff8178; }
.tile-value { display: flex; align-items: baseline; gap: 8px; }
.tile-value .v { font-size: 26px; font-weight: 680; letter-spacing: -.01em; }
.tile-value .pct { color: var(--muted); font-size: 13px; }
.pbar { height: 4px; background: #0c1015; border-radius: 3px; margin-top: 8px; overflow: hidden; }
.pfill { height: 100%; background: var(--accent); }
.tile-cta { color: var(--accent); font-size: 12px; margin-top: 8px; }
.breakdown { margin-top: 10px; display: flex; flex-direction: column; gap: 4px; }
.bd-row { display: grid; grid-template-columns: 92px 1fr 62px; align-items: center; gap: 6px; font-size: 11.5px; }
.bd-ranked { grid-template-columns: 1fr auto; gap: 12px; }
.bd-label { color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bd-bar { background: #0c1015; height: 7px; border-radius: 4px; overflow: hidden; }
.bd-fill { display: block; height: 100%; background: var(--accent); opacity: .8; }
.bd-val { text-align: right; color: var(--fg); white-space: nowrap; }
.bd-more { color: var(--muted); font-size: 11px; margin-top: 2px; }
.breakdown-more { color: var(--muted); font-size: 11px; margin-top: 5px; }
.breakdown-more summary, .range-help summary, .audience-source-details summary, .audience-events summary, .audience-observation-details summary, .series-source-details summary, .series-values summary, .geography-values summary, .geography-details summary { cursor: pointer; }
.muted { color: var(--muted); }
.errbar { background: rgba(248,81,73,.12); border: 1px solid var(--error); color: #ffd7d4;
  border-radius: 10px; padding: 10px 14px; margin-bottom: 16px; font-size: 13px; }
.errbar-hint { color: var(--muted); }
.series-controls { display: flex; flex-wrap: wrap; align-items: end; gap: 10px; margin-bottom: 16px; }
.series-controls label { display: grid; color: var(--muted); font-size: 12px; gap: 3px; }
.series-controls button, .series-controls input, .series-controls select { color: var(--fg); background: var(--panel-2); border: 1px solid var(--border); border-radius: 6px; padding: 6px 9px; }
.series-controls button { cursor: pointer; }
.series-controls button:hover, .series-controls button:focus-visible { border-color: var(--accent); }
.series-controls button[aria-pressed="true"] { border-color: var(--accent); background: rgba(74,163,255,.14); color: var(--fg); }
.range-help { color: var(--muted); font-size: 11px; margin: -7px 0 10px; }
.range-help p { max-width: 760px; margin: 6px 0 0; }
.audience-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; align-items: start; max-width: 1180px; }
.audience-source { min-width: 0; background: var(--panel-2); border: 1px solid var(--border); border-radius: 10px; padding: 13px; }
.audience-source-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.audience-source h3 { margin: 0; font-size: 14px; }
.audience-status { flex: none; border-radius: 999px; padding: 2px 8px; font-size: 10px; font-weight: 650; }
.audience-status-available { background: rgba(46,160,67,.16); color: #65d17a; }
.audience-status-partial { background: rgba(210,153,34,.16); color: #f0c65a; }
.audience-status-unconfigured, .audience-status-unavailable, .audience-status-unknown { background: rgba(139,151,166,.16); color: var(--muted); }
.audience-coverage, .audience-note { color: var(--muted); font-size: 11.5px; line-height: 1.45; margin: 8px 0; }
.audience-observation-details { color: var(--muted); font-size: 11px; margin: 0 0 10px; }
.audience-source-details { color: var(--muted); font-size: 11px; margin-top: 8px; }
.audience-measures { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 8px; margin: 12px 0; }
.audience-measure { display: grid; gap: 3px; border: 1px solid var(--border); border-radius: 8px; padding: 8px; min-width: 0; }
.audience-measure-label { color: var(--muted); font-size: 10.5px; }
.audience-measure-value { font-size: 18px; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.audience-note { margin-bottom: 0; }
.audience-events { border-top: 1px solid var(--border); margin-top: 10px; padding-top: 8px; color: var(--muted); font-size: 11px; }
.audience-events summary { display: flex; justify-content: space-between; gap: 8px; }
.audience-event-table { border-collapse: collapse; font-size: 11px; margin-top: 8px; width: 100%; }
.audience-event-table th, .audience-event-table td { border-bottom: 1px solid var(--border); padding: 5px; text-align: left; }
.audience-event-table th:not(:first-child), .audience-event-table td { font-variant-numeric: tabular-nums; }
.series-card { max-width: 1180px; background: var(--panel); border: 1px solid var(--border); border-radius: 12px; margin: 14px 0 10px; padding: 14px; }
.series-heading { display: flex; align-items: center; gap: 8px; }
.series-card h3 { margin: 0; font-size: 15px; }
.series-card h4, .series-measure h4 { margin: 4px 0 0; font-size: 14px; }
.series-measure { border-top: 1px solid var(--border); margin-top: 14px; padding-top: 10px; }
.health-intro { margin: 0 0 14px; color: var(--muted); font-size: 13px; }
.health-meta { color: var(--muted); font-size: 12px; margin: -4px 0 12px; }
.range-note { color: var(--muted); font-size: 12px; margin: -8px 0 12px; }
.series-meta { color: var(--muted); font-size: 11px; margin: 4px 0; }
.series-meta.stale { color: var(--warn); }
.series-source-details { color: var(--muted); font-size: 11px; margin-top: 4px; }
.series-chart-wrap { position: relative; width: 100%; }
.series-chart { display: block; width: 100%; min-height: 150px; }
.series-chart text { fill: var(--muted); font-size: 11px; }
.series-point { fill: var(--accent); stroke: var(--panel); stroke-width: 2; cursor: crosshair; }
.series-point:hover, .series-point:focus { fill: #fff; stroke: var(--accent); stroke-width: 3; outline: none; }
.series-tooltip, .geography-tooltip { position: absolute; z-index: 3; display: none; max-width: min(320px, calc(100vw - 32px)); padding: 7px 10px; border: 1px solid var(--border); border-radius: 7px; background: #0c1118; box-shadow: 0 5px 18px rgba(0,0,0,.4); color: var(--fg); font-size: 12px; line-height: 1.35; pointer-events: none; transform: translate(-50%, -100%); white-space: normal; }
.geography-tooltip { width: max-content; }
.series-tooltip.visible, .geography-tooltip.visible { display: block; }
.series-values { color: var(--muted); font-size: 12px; margin-top: 8px; }
.series-values summary { cursor: pointer; }
.series-values table { border-collapse: collapse; margin-top: 8px; width: 100%; }
.series-values th, .series-values td { border-bottom: 1px solid var(--border); padding: 5px 8px; text-align: left; }
.series-values th:last-child, .series-values td:last-child { text-align: right; font-variant-numeric: tabular-nums; }
.geography-heading { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.geography-heading h2 { margin: 0; font-size: 15px; }
.geography-heading .health-intro { margin: 4px 0 0; }
.geography-period { color: var(--muted); font-size: 12px; margin-left: auto; font-variant-numeric: tabular-nums; }
.geography-sources { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 12px; }
.geography-source { display: flex; align-items: center; gap: 8px; color: var(--fg); background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px; padding: 7px 10px; cursor: pointer; font: inherit; font-size: 12px; }
.geography-source[aria-pressed="true"] { border-color: var(--accent); background: rgba(74,163,255,.12); }
.geography-source:disabled { opacity: .55; cursor: not-allowed; }
.geography-source-status { color: var(--muted); font-size: 10px; }
.geography-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(220px, 270px); gap: 14px; align-items: center; max-width: 1260px; }
.geography-map-frame { position: relative; min-width: 0; overflow: hidden; border: 1px solid var(--border); border-radius: 10px; background: #111820; }
.geography-map { display: block; width: 100%; height: auto; }
.map-country { stroke: #111820; stroke-width: 1; stroke-linejoin: round; }
.map-country-marker { stroke: #111820; stroke-width: 1; }
.map-country[tabindex="0"], .map-country-marker[tabindex="0"] { cursor: pointer; }
.map-country[tabindex="0"]:hover, .map-country[tabindex="0"]:focus, .map-country-marker[tabindex="0"]:hover, .map-country-marker[tabindex="0"]:focus { stroke: var(--fg); stroke-width: 2; outline: none; }
.geography-summary { display: grid; align-content: start; gap: 8px; min-width: 0; padding: 14px; border: 1px solid var(--border); border-radius: 10px; background: var(--panel-2); }
.geography-summary-label, .geography-summary-date { color: var(--muted); font-size: 11px; }
.geography-summary-value { font-size: 24px; font-variant-numeric: tabular-nums; }
.geography-summary-date, .geography-map-hint, .geography-map-legend { margin: 0; }
.geography-map-hint { color: var(--muted); font-size: 11px; }
.geography-map-legend { display: grid; grid-template-columns: auto minmax(50px, 1fr) auto; align-items: center; gap: 6px; color: var(--muted); font-size: 10px; }
.geography-map-legend-scale { height: 7px; border-radius: 999px; background: linear-gradient(90deg, rgba(74,163,255,.22), rgba(74,163,255,1)); }
.geography-values, .geography-details { color: var(--muted); font-size: 11px; margin-top: 10px; }
.geography-values table { border-collapse: collapse; margin-top: 8px; width: 100%; }
.geography-values th, .geography-values td { border-bottom: 1px solid var(--border); padding: 5px 8px; text-align: left; }
.geography-values td:last-child, .geography-values th:last-child { text-align: right; font-variant-numeric: tabular-nums; }
.geography-details p { margin: 6px 0; }
@media (max-width: 600px) { header { padding: 12px; flex-wrap: wrap; } main { padding: 14px 12px 40px; } #meta { display: none; } }
@media (max-width: 720px) { .audience-grid { grid-template-columns: 1fr; } .geography-layout { grid-template-columns: 1fr; } .geography-heading { align-items: flex-start; flex-wrap: wrap; } .geography-period { margin-left: 0; } }
`;
