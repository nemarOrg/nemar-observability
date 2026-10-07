// Design tokens and component styles for the dashboard page, inlined by ui.ts.
//
// Colors are roles, not raw values: every component reads a custom property, so
// light and dark are two token sets over one stylesheet. The neutrals, brand
// teal, link and focus colors, and type stacks are the NEMAR website's
// (website/src/styles/tokens.css), so this page and nemar.org read as one site.
// The chart and map ramps follow the dataviz reference palette (one blue hue,
// safe for color vision deficiency), checked against these surfaces. The map
// ramp runs from a light tint to a deep blue (the reverse on dark), and its
// light end still stands apart from the gray of countries with no data.
//
// Light tokens live on bare :root, so the page is complete with no attribute
// at all. Dark tokens are declared twice on purpose: the media query follows
// the OS setting unless the root says data-theme="light", and the
// data-theme="dark" scope follows the in-page toggle or an embedding host,
// which must win in both directions.

const DARK_TOKENS = `
  color-scheme: dark;
  --bg: #0a1224;
  --surface: #111d36;
  --surface-2: #0e1830;
  --surface-3: #18254a;
  --surface-raised: #152342;
  --border: #1e293b;
  --border-strong: #334155;
  --text: #f1f5f9;
  --text-2: #cbd5e1;
  --text-3: #94a3b8;
  --control-border: #6b7c93;
  --accent: #3987e5;
  --accent-text: #93c5fd;
  --accent-soft: rgba(57, 135, 229, 0.18);
  --accent-track: rgba(57, 135, 229, 0.2);
  --focus: #60a5fa;
  --brand-electrode: #f4d06b;
  --brand-teal-text: #5bbad5;
  --grid: #1a2742;
  --axis: #334155;
  --crosshair: #64748b;
  --gap-band: rgba(148, 163, 184, 0.07);
  --region: rgba(250, 178, 25, 0.07);
  --mark-muted: #5c6b81;
  --hours-band: rgba(57, 135, 229, 0.11);
  --edge-shadow: rgba(0, 0, 0, 0.55);
  --ok: #0ca30c;
  --ok-text: #4ade80;
  --ok-soft: rgba(74, 222, 128, 0.14);
  --warn: #fab219;
  --warn-text: #fbbf24;
  --error: #e5534b;
  --error-text: #fca5a5;
  --neutral-soft: rgba(148, 163, 184, 0.14);
  --map-lo: #2263b5;
  --map-mid: #5598e7;
  --map-hi: #cde2fb;
  --map-land: #1e293b;
  --map-hatch: #3b4a63;
  --map-sea: #0a1224;
  --map-stroke: #111d36;
  --skeleton: #18254a;
  --skeleton-shine: #1f2f57;
  --header-bg: rgba(10, 18, 36, 0.9);
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.35);
  --shadow-pop: 0 18px 40px rgba(0, 0, 0, 0.55), 0 2px 8px rgba(0, 0, 0, 0.4);
`;

export const STYLES = String.raw`
:root {
  color-scheme: light;
  --font: "Inter", "Open Sans", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --font-display: "Rubik", var(--font);
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px; --space-5: 24px; --space-6: 32px; --space-7: 48px; --space-8: 64px;
  --radius-sm: 6px; --radius-md: 8px; --radius-lg: 12px; --radius-pill: 999px;
  --fs-xs: 12px; --fs-sm: 13px; --fs-base: 14px; --fs-md: 16px; --fs-lg: 20px; --fs-xl: 24px; --fs-2xl: 30px;
  --gutter: 24px;
  --content: 1280px;
  --header-h: 64px;
  --filter-h: 52px;
  --topbar-h: calc(var(--header-h) + var(--filter-h));
  --ease: cubic-bezier(0.2, 0.7, 0.2, 1);

  --brand-navy: #0b1a3a;
  --brand-accent: #5bbad5;
  --brand-electrode: #b8860b;
  --brand-teal-text: #0e7490;
  --bg: #f7f8fb;
  --surface: #ffffff;
  --surface-2: #f7f8fb;
  --surface-3: #eef1f6;
  --surface-raised: #ffffff;
  --border: #e2e8f0;
  --border-strong: #cbd5e1;
  --text: #0f172a;
  --text-2: #475569;
  --text-3: #56657a;
  --control-border: #7b8aa0;
  --accent: #2a78d6;
  --accent-text: #1d4ed8;
  --accent-soft: rgba(42, 120, 214, 0.1);
  --accent-track: rgba(42, 120, 214, 0.14);
  --focus: #2563eb;
  --grid: #eef1f6;
  --axis: #cbd5e1;
  --crosshair: #94a3b8;
  --gap-band: rgba(100, 116, 139, 0.07);
  --region: rgba(250, 178, 25, 0.08);
  --mark-muted: #8894a5;
  --hours-band: rgba(42, 120, 214, 0.07);
  --edge-shadow: rgba(15, 23, 42, 0.16);
  --ok: #0ca30c;
  --ok-text: #166534;
  --ok-soft: rgba(21, 128, 61, 0.1);
  --warn: #fab219;
  --warn-text: #a14906;
  --error: #d03b3b;
  --error-text: #b91c1c;
  --neutral-soft: rgba(100, 116, 139, 0.1);
  --map-lo: #6fa6ea;
  --map-mid: #3987e5;
  --map-hi: #0d366b;
  --map-land: #e2e8f0;
  --map-hatch: #a8b4c4;
  --map-sea: #f7f8fb;
  --map-stroke: #ffffff;
  --skeleton: #eef1f6;
  --skeleton-shine: #f7f8fb;
  --header-bg: rgba(255, 255, 255, 0.92);
  --shadow-sm: 0 1px 2px rgba(15, 23, 42, 0.05);
  --shadow-pop: 0 16px 36px rgba(15, 23, 42, 0.14), 0 2px 6px rgba(15, 23, 42, 0.08);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {${DARK_TOKENS}}
}
:root[data-theme="dark"] {${DARK_TOKENS}}

*, *::before, *::after { box-sizing: border-box; }
html { scroll-behavior: smooth; scroll-padding-top: calc(var(--topbar-h) + 16px); -webkit-text-size-adjust: 100%; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font: 400 var(--fs-base)/1.5 var(--font);
  -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
  overflow-x: hidden;
}
a { color: var(--accent-text); text-underline-offset: 2px; }
p { margin: 0; }
h1, h2, h3, h4 { margin: 0; color: var(--text); font-family: var(--font-display); }
button, input, select { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; border-radius: var(--radius-sm); }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.skip-link { position: absolute; left: var(--space-4); top: -48px; z-index: 100; background: var(--surface); color: var(--text); padding: var(--space-2) var(--space-3); border-radius: var(--radius-md); box-shadow: var(--shadow-pop); }
.skip-link:focus { top: var(--space-3); }
.icon { width: 16px; height: 16px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.fine { color: var(--text-3); font-size: var(--fs-xs); line-height: 1.5; }
.fine + .fine { margin-top: var(--space-2); }
.fine.stale { color: var(--warn-text); }
.container { max-width: var(--content); margin: 0 auto; padding: 0 var(--gutter); }
.external-icon { width: 0.75em; height: 0.75em; opacity: 0.7; flex: none; }

/* ---------- NEMAR chrome: utility row, header, filter bar (matches nemar.org and /citations) ---------- */
.site-utility { background: var(--surface-2); border-bottom: 1px solid var(--border); }
.site-utility__inner { display: flex; justify-content: flex-end; }
.site-utility__nav { display: flex; flex-wrap: wrap; gap: 0 var(--space-4); }
.site-utility__nav a { display: inline-flex; align-items: center; gap: 0.25em; min-height: 2rem; color: var(--text-2); font-size: 0.75rem; font-weight: 500; text-decoration: none; border-bottom: 2px solid transparent; }
.site-utility__nav a:hover { color: var(--text); }
.site-utility__nav a[aria-current="page"] { color: var(--text); border-bottom-color: var(--brand-accent); }
.site-header { position: sticky; top: 0; z-index: 40; background: var(--header-bg); -webkit-backdrop-filter: saturate(180%) blur(10px); backdrop-filter: saturate(180%) blur(10px); border-bottom: 1px solid var(--border); }
.site-header__inner { height: var(--header-h); display: flex; align-items: center; gap: var(--space-5); }
.site-brand { display: inline-flex; align-items: center; gap: 12px; min-height: 44px; color: var(--text); text-decoration: none; flex: none; }
.brand-logo { display: block; height: 32px; width: auto; }
.site-brand__product { font-family: var(--font-display); font-weight: 700; font-size: 1.125rem; letter-spacing: -0.01em; color: var(--brand-teal-text); padding-left: 12px; border-left: 1px solid var(--border-strong); line-height: 1.2; }
.section-nav { display: flex; align-items: center; gap: 2px; }
.section-nav a, .nav-menu-panel a { color: var(--text-2); text-decoration: none; font-size: 0.875rem; font-weight: 500; padding: 0.5rem 0.75rem; border-radius: var(--radius-md); }
.section-nav a:hover, .nav-menu-panel a:hover { color: var(--text); background: var(--surface-3); }
.section-nav a[aria-current="true"] { color: var(--text); background: var(--surface-3); box-shadow: inset 0 -2px 0 var(--brand-accent); }
.site-header__actions { margin-left: auto; display: flex; align-items: center; gap: var(--space-2); }
.icon-button { display: inline-grid; place-items: center; width: 40px; height: 40px; border-radius: var(--radius-md); border: 0; background: transparent; color: var(--text-2); cursor: pointer; }
.icon-button:hover { color: var(--text); background: var(--surface-3); }
.theme-toggle .theme-icon { display: none; }
.theme-toggle[data-mode="system"] .theme-system, .theme-toggle[data-mode="dark"] .theme-dark, .theme-toggle[data-mode="light"] .theme-light { display: block; }
.pill-link { display: inline-flex; align-items: center; gap: 6px; min-height: 40px; padding: 0 1.25rem; border: 1px solid var(--border-strong); border-radius: var(--radius-pill); color: var(--text); font-size: 0.875rem; font-weight: 500; text-decoration: none; background: transparent; white-space: nowrap; }
.pill-link:hover { background: var(--surface-2); border-color: var(--text-2); }
.button { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px; border-radius: var(--radius-md); border: 1px solid var(--border); background: var(--surface); color: var(--text); font-size: var(--fs-sm); font-weight: 500; text-decoration: none; cursor: pointer; white-space: nowrap; }
.button:hover { border-color: var(--border-strong); background: var(--surface-2); }
.button .icon { width: 14px; height: 14px; color: var(--text-3); }
.button-quiet { margin-top: var(--space-3); }
.popover.nav-menu { display: none; }
.nav-menu-panel { right: 0; left: auto; top: 46px; width: 240px; display: grid; gap: 2px; padding: 6px; }
.nav-menu-panel a { display: flex; align-items: center; gap: 0.25em; padding: 8px 10px; }
.nav-menu-panel hr { border: 0; border-top: 1px solid var(--border); margin: 4px 0; }
.nav-menu-panel .menu-label { padding: 6px 10px 2px; color: var(--text-3); font-size: 0.75rem; font-weight: 600; }

.filterbar { height: var(--filter-h); display: flex; align-items: center; gap: var(--space-3); border-top: 1px solid var(--border); }
.segmented { display: inline-flex; align-items: stretch; gap: 2px; padding: 2px; border-radius: var(--radius-md); background: var(--surface-3); }
.segmented button { border: 0; background: transparent; color: var(--text-2); font-size: var(--fs-sm); font-weight: 500; padding: 4px 10px; border-radius: var(--radius-sm); cursor: pointer; min-height: 32px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.segmented button:hover:not(:disabled) { color: var(--text); }
.segmented button[aria-pressed="true"] { background: var(--surface); color: var(--text); font-weight: 600; box-shadow: inset 0 -2px 0 var(--accent), var(--shadow-sm), 0 0 0 1px var(--border); }
.segmented button:disabled { cursor: not-allowed; opacity: 0.55; }
.range-custom { position: relative; }
.range-custom > summary { list-style: none; display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 10px; border-radius: var(--radius-md); border: 1px solid var(--border); background: var(--surface); color: var(--text-2); font-size: var(--fs-sm); font-weight: 500; cursor: pointer; }
.range-custom > summary::-webkit-details-marker { display: none; }
.range-custom > summary:hover { color: var(--text); border-color: var(--border-strong); }
.range-custom.is-active > summary { color: var(--text); border-color: var(--accent); background: var(--accent-soft); }
.range-custom-panel { top: 40px; left: 0; width: 280px; padding: var(--space-4); display: grid; gap: var(--space-3); }
.field { display: grid; gap: 4px; color: var(--text-2); font-size: var(--fs-xs); font-weight: 500; }
.field input, .field select, .select-field select { height: 32px; border: 1px solid var(--control-border); border-radius: var(--radius-md); background: var(--surface); color: var(--text); padding: 0 10px; font-size: var(--fs-sm); }
.range-summary { color: var(--text-2); font-size: var(--fs-sm); font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.filterbar-note { margin-left: auto; min-width: 0; color: var(--text-3); font-size: var(--fs-xs); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
@media (max-width: 1179px) { .filterbar-note { display: none; } }

/* ---------- popovers ---------- */
.popover { position: relative; display: inline-flex; flex: none; }
.popover > summary { list-style: none; }
.popover > summary::-webkit-details-marker { display: none; }
.popover-panel { position: absolute; z-index: 30; background: var(--surface-raised); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-pop); }
.info-trigger { display: inline-grid; place-items: center; width: 32px; height: 32px; margin: -8px -5px; border-radius: var(--radius-pill); color: var(--text-3); cursor: pointer; }
.info-trigger:hover, .info[open] > .info-trigger { color: var(--text); background: var(--surface-3); }
.info-trigger .icon { width: 15px; height: 15px; }
.info-panel { top: 30px; left: -4px; width: min(320px, calc(100vw - 32px)); padding: var(--space-3) 14px; color: var(--text-2); font-size: var(--fs-sm); font-weight: 400; line-height: 1.55; text-align: left; letter-spacing: 0; white-space: normal; }
.info-panel p + p { margin-top: var(--space-2); }

/* ---------- layout ---------- */
main { max-width: var(--content); margin: 0 auto; padding: 0 var(--gutter) var(--space-8); }
main > section { scroll-margin-top: calc(var(--topbar-h) + 16px); padding-top: var(--space-7); }
.section-head { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: var(--space-3) var(--space-5); margin-bottom: var(--space-5); }
.section-head h2 { font-size: var(--fs-lg); font-weight: 650; letter-spacing: -0.012em; line-height: 1.3; }
.section-lede { margin-top: 6px; color: var(--text-2); max-width: 68ch; }
.section-tools { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2) var(--space-3); }
.select-field { display: inline-flex; align-items: center; gap: var(--space-2); color: var(--text-2); font-size: var(--fs-sm); font-weight: 500; }
.subsection-head { margin: var(--space-6) 0 var(--space-3); display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px var(--space-3); }
.subsection-head h3 { font-size: var(--fs-md); font-weight: 600; }
.subsection-head p { color: var(--text-3); font-size: var(--fs-sm); }
.range-note { margin: calc(-1 * var(--space-3)) 0 var(--space-4); color: var(--text-3); font-size: var(--fs-xs); }
.stack { display: grid; gap: var(--space-4); }

/* ---------- cards ---------- */
.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); box-shadow: var(--shadow-sm); padding: 20px; min-width: 0; }
.card[id] { scroll-margin-top: calc(var(--topbar-h) + 16px); }
.card:target { box-shadow: 0 0 0 2px var(--focus), var(--shadow-sm); }
.card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-3); margin-bottom: var(--space-4); }
.card-titles { min-width: 0; }
.card-title { font-size: var(--fs-base); font-weight: 600; line-height: 1.35; }
.card-sub { margin-top: 2px; color: var(--text-3); font-size: var(--fs-xs); }
.title-row { display: flex; align-items: center; gap: 6px; }
.card-foot { display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-5); margin-top: var(--space-4); padding-top: var(--space-3); border-top: 1px solid var(--border); }
.portal-cta { display: inline-flex; align-items: center; gap: 4px; color: var(--accent-text); font-size: var(--fs-sm); font-weight: 500; text-decoration: none; }
.portal-cta:hover { text-decoration: underline; }
.portal-cta .icon { width: 13px; height: 13px; }
.badge { display: inline-flex; align-items: center; gap: 5px; flex: none; height: 24px; padding: 0 9px 0 7px; border-radius: var(--radius-pill); font-size: var(--fs-xs); font-weight: 600; white-space: nowrap; background: var(--neutral-soft); color: var(--text-2); }
.badge .icon { width: 14px; height: 14px; }
.badge-ok { background: var(--ok-soft); color: var(--ok-text); }
.is-refreshing { opacity: 0.55; transition: opacity 160ms var(--ease); }

/* ---------- disclosures and tables ---------- */
.more { margin-top: var(--space-3); color: var(--text-2); font-size: var(--fs-sm); }
.more > summary { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; list-style: none; color: var(--text-2); font-weight: 500; border-radius: var(--radius-sm); padding: 2px 0; }
.more > summary::-webkit-details-marker { display: none; }
.more > summary::before { content: ""; width: 6px; height: 6px; border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor; transform: rotate(-45deg); transition: transform 140ms var(--ease); margin: 0 2px; }
.more[open] > summary::before { transform: rotate(45deg); }
.more > summary:hover { color: var(--text); }
.more[open] > :not(summary) { margin-top: var(--space-2); }
.table-scroll { max-height: 360px; overflow: auto; border: 1px solid var(--border); border-radius: var(--radius-md); }
.data-table { width: 100%; border-collapse: collapse; font-size: var(--fs-sm); }
.data-table th, .data-table td { padding: 7px 12px; border-bottom: 1px solid var(--border); text-align: left; font-weight: 400; }
.data-table thead th { position: sticky; top: 0; background: var(--surface-2); color: var(--text-3); font-size: var(--fs-xs); font-weight: 600; }
.data-table tbody tr:last-child th, .data-table tbody tr:last-child td { border-bottom: 0; }
.data-table tbody th { color: var(--text); }
.data-table .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.data-table td { color: var(--text-2); }

/* ---------- loading, empty and error states ---------- */
.skeleton { background: linear-gradient(90deg, var(--skeleton) 0%, var(--skeleton-shine) 50%, var(--skeleton) 100%); background-size: 200% 100%; animation: shimmer 1.6s ease-in-out infinite; border-radius: var(--radius-sm); }
@keyframes shimmer { from { background-position: 150% 0; } to { background-position: -50% 0; } }
.skeleton-title { height: 14px; width: 40%; margin-bottom: var(--space-4); }
.skeleton-value { height: 30px; width: 55%; margin: 6px 0 10px; }
.skeleton-line { height: 10px; width: 80%; margin-top: 10px; }
.skeleton-line.short { width: 45%; }
.skeleton-chart { height: 220px; }
.skeleton-map { aspect-ratio: 2 / 1; width: 100%; }
.skeleton-grid { display: grid; gap: var(--space-4); grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); }
.empty-state { grid-column: 1 / -1; display: flex; gap: var(--space-3); align-items: flex-start; padding: 18px 20px; border: 1px dashed var(--border-strong); border-radius: var(--radius-lg); background: var(--surface); color: var(--text-2); }
.empty-state > .icon { width: 18px; height: 18px; margin-top: 2px; color: var(--text-3); }
.empty-error { border-style: solid; border-color: var(--border); box-shadow: inset 3px 0 0 var(--error); }
.empty-error > .icon { color: var(--error-text); }
.empty-title { color: var(--text); font-weight: 600; }
.empty-body { margin-top: 2px; font-size: var(--fs-sm); }

/* ---------- overview ---------- */
.hero { padding-top: var(--space-7); }
.hero-title { font-size: clamp(24px, 1.6vw + 16px, 36px); line-height: 1.22; font-weight: 600; letter-spacing: -0.022em; color: var(--text-2); max-width: 30em; text-wrap: balance; }
.hero-title .fact { color: var(--text); }
.hero-lede { margin-top: var(--space-3); color: var(--text-2); font-size: var(--fs-md); max-width: 70ch; }
.kpi-scope { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); margin-top: var(--space-6); color: var(--text-3); font-size: var(--fs-xs); font-weight: 500; }
.kpi-grid { display: grid; gap: var(--space-3); margin-top: var(--space-3); grid-template-columns: repeat(2, minmax(0, 1fr)); }
.kpi { display: flex; flex-direction: column; gap: 4px; padding: 16px 18px; min-height: 156px; }
.kpi-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); }
.kpi-label { color: var(--text-2); font-size: var(--fs-sm); font-weight: 500; }
.kpi-value { margin-top: 6px; font-size: var(--fs-2xl); font-weight: 600; line-height: 1.1; letter-spacing: -0.024em; }
.kpi-value.is-muted { font-size: var(--fs-lg); color: var(--text-3); font-weight: 500; letter-spacing: -0.01em; padding: 4px 0 2px; }
.kpi-delta { display: inline-flex; align-items: center; gap: 4px; color: var(--text-2); font-size: var(--fs-xs); font-weight: 500; font-variant-numeric: tabular-nums; }
.kpi-delta .icon { width: 13px; height: 13px; }
.kpi-delta.delta-none { color: var(--text-3); font-weight: 400; }
.kpi-context { color: var(--text-3); font-size: var(--fs-xs); line-height: 1.45; }
.kpi-caveat { color: var(--text-2); font-size: var(--fs-xs); line-height: 1.45; }
.map-caption { padding: var(--space-1) var(--space-2) 0; color: var(--text-3); font-size: var(--fs-xs); line-height: 1.45; }
.kpi-foot { margin-top: auto; padding-top: var(--space-2); }
.alltime { margin-top: var(--space-4); padding: 14px 20px 16px; border: 1px solid var(--border); border-radius: var(--radius-lg); background: var(--surface-2); }
.alltime-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px var(--space-3); margin-bottom: var(--space-3); }
.alltime-head h2 { font-family: var(--font); font-size: var(--fs-xs); font-weight: 600; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-2); }
.alltime-head p { color: var(--text-3); font-size: var(--fs-xs); }
.alltime-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(135px, 1fr)); gap: var(--space-3) var(--space-5); margin: 0; }
.alltime-item { min-width: 0; }
.alltime-item dt { display: flex; align-items: center; gap: 4px; color: var(--text-3); font-size: var(--fs-xs); }
.alltime-item dd { margin: 0; }
.alltime-value { margin-top: 2px; font-size: var(--fs-lg); font-weight: 600; letter-spacing: -0.01em; line-height: 1.3; font-variant-numeric: tabular-nums; }
.alltime-value.is-muted { color: var(--text-3); font-weight: 500; font-size: var(--fs-md); }
.alltime-note { margin-top: 2px; color: var(--text-3); font-size: var(--fs-xs); line-height: 1.45; }
.scope-chip { display: inline-flex; align-items: center; gap: 6px; min-height: 24px; padding: 2px 10px; border: 1px solid var(--border); border-radius: var(--radius-pill); background: var(--surface); color: var(--text-2); font-size: var(--fs-xs); font-weight: 500; line-height: 1.3; font-variant-numeric: tabular-nums; }
.scope-chip::before { content: ""; flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--accent); }
.scope-current::before { background: var(--text-3); }
.scope-note::before { background: transparent; border: 1.5px solid var(--text-3); width: 7px; height: 7px; }
.meter { height: 4px; border-radius: var(--radius-pill); background: var(--accent-track); overflow: hidden; margin-top: var(--space-2); }
.meter-lg { height: 6px; }
.meter-fill { height: 100%; border-radius: var(--radius-pill); background: var(--accent); }

/* ---------- charts ---------- */
.chart { position: relative; border-radius: var(--radius-md); touch-action: pan-y; }
.chart-canvas { width: 100%; }
.chart svg { display: block; overflow: visible; }
.chart-compact { margin: 0 -4px; }
.chart-tick { fill: var(--text-3); font-size: 12px; font-variant-numeric: tabular-nums; }
.chart-grid { stroke: var(--grid); stroke-width: 1; }
.chart-axis { stroke: var(--axis); stroke-width: 1; }
.chart-gap { fill: var(--gap-band); }
.chart-region { fill: var(--region); }
.chart-marker { stroke: var(--warn); stroke-width: 1.5; }
.chart-annotation { fill: var(--text-2); font-size: 12px; font-weight: 600; }
.grad-top { stop-color: var(--accent); stop-opacity: 0.24; }
.grad-bottom { stop-color: var(--accent); stop-opacity: 0; }
.chart-compact .grad-top { stop-opacity: 0.16; }
.chart-line { fill: none; stroke: var(--accent); stroke-width: 2; stroke-linejoin: round; stroke-linecap: round; }
.chart-compact .chart-line { stroke-width: 1.75; }
.chart-line.is-partial { stroke-dasharray: 4 4; }
.chart-dot { fill: var(--accent); stroke: var(--surface); stroke-width: 2; }
.chart-bar { fill: var(--accent); transition: opacity 120ms var(--ease); }
.has-active .chart-bar { opacity: 0.4; }
.has-active .chart-bar.is-active { opacity: 1; }
.chart-crosshair { stroke: var(--crosshair); stroke-width: 1; opacity: 0; }
.chart-hover-dot { fill: var(--accent); stroke: var(--surface); stroke-width: 2.5; opacity: 0; }
.chart-crosshair.visible, .chart-hover-dot.visible { opacity: 1; }
.chart-tooltip, .geography-tooltip { position: absolute; z-index: 20; display: none; min-width: 120px; max-width: min(300px, calc(100vw - 32px)); padding: 8px 11px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface-raised); box-shadow: var(--shadow-pop); color: var(--text); font-size: var(--fs-xs); line-height: 1.4; pointer-events: none; white-space: normal; }
.geography-tooltip { width: max-content; }
.chart-tooltip.visible, .geography-tooltip.visible { display: block; }
.tt-title { color: var(--text-3); font-size: 12px; }
.tt-value { margin-top: 2px; font-size: var(--fs-base); font-weight: 600; font-variant-numeric: tabular-nums; }
.tt-note { margin-top: 2px; color: var(--text-3); font-size: 12px; }
.chart-legend { display: flex; flex-wrap: wrap; gap: 6px var(--space-4); margin-top: var(--space-2); color: var(--text-3); font-size: var(--fs-xs); }
.legend-item { display: inline-flex; align-items: center; gap: 6px; }
.legend-key { display: inline-block; width: 16px; }
.key-dashed { height: 0; border-top: 2px dashed var(--accent); }
.key-gap { height: 10px; border-radius: 2px; background: var(--gap-band); border: 1px solid var(--border); }

/* ---------- usage ---------- */
.series-grid { display: grid; gap: var(--space-4); }
.series-measure + .series-measure { margin-top: var(--space-5); padding-top: var(--space-5); border-top: 1px solid var(--border); }
.measure-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-3); margin-bottom: var(--space-3); }
.measure-title { font-size: var(--fs-sm); font-weight: 500; color: var(--text-2); }
.measure-total-label { margin-top: 6px; color: var(--text-3); font-size: var(--fs-xs); }
.measure-total { font-size: var(--fs-xl); font-weight: 600; letter-spacing: -0.02em; line-height: 1.2; }
.measure-foot { display: flex; flex-wrap: wrap; gap: 0 var(--space-5); }
.measure-foot > .more { flex: 1 1 260px; }
.audience-grid { display: grid; gap: var(--space-4); grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); }
.measures { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: var(--space-3); }
.measure { display: grid; gap: 2px; min-width: 0; }
.measure-label { color: var(--text-3); font-size: var(--fs-xs); }
.measure-value { font-size: var(--fs-lg); font-weight: 600; letter-spacing: -0.01em; overflow-wrap: anywhere; }
.measure-value.is-muted { color: var(--text-3); font-weight: 500; font-size: var(--fs-md); }
.audience-events { border-top: 1px solid var(--border); padding-top: var(--space-3); }
.howto-inline { margin-top: var(--space-3); }
.tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: var(--space-3); align-items: stretch; }
.split-main { min-width: 0; }
.tile-lists { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 340px), 1fr)); gap: var(--space-3); align-items: start; }
.tiles + .tile-lists, .split-main > * + * { margin-top: var(--space-3); }
@media (min-width: 1000px) {
  .card-split .section-body { display: grid; grid-template-columns: minmax(0, 1fr) minmax(340px, 40%); gap: var(--space-3); align-items: start; }
  .card-split .split-main + .tile-lists { margin-top: 0; }
}
.split-main + .tile-lists { margin-top: var(--space-3); }
.tile { display: flex; flex-direction: column; gap: 4px; min-width: 0; padding: 14px; border-radius: var(--radius-md); background: var(--surface-2); border: 1px solid var(--border); }
.tile-head { display: flex; align-items: flex-start; gap: 6px; }
.tile-label { color: var(--text-2); font-size: var(--fs-sm); flex: 1; min-width: 0; }
.tile-value { display: flex; flex-wrap: wrap; align-items: center; gap: 4px var(--space-2); }
.tile-value .v { font-size: var(--fs-xl); font-weight: 600; letter-spacing: -0.02em; line-height: 1.25; }
.tile-list .tile-value .v { font-size: var(--fs-md); letter-spacing: -0.01em; }
.tile-caption { color: var(--text-2); font-size: var(--fs-sm); font-weight: 600; }
.tile-pct { color: var(--text-3); font-size: var(--fs-xs); font-variant-numeric: tabular-nums; }
.tile .portal-cta { margin-top: var(--space-2); }
.tile .hbars-wrap { margin-top: var(--space-2); }

/* ---------- bars and ranked lists ---------- */
.hbars { display: grid; gap: 2px; list-style: none; margin: 0; padding: 0; }
.hbar { display: grid; grid-template-columns: minmax(84px, 36%) minmax(40px, 1fr) auto; align-items: center; gap: var(--space-3); min-height: 26px; font-size: var(--fs-sm); border-radius: var(--radius-sm); }
.hbar-label { color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hbar-track { height: 8px; border-radius: 0 4px 4px 0; overflow: hidden; }
.hbar-fill { display: block; height: 100%; background: var(--accent); border-radius: 0 4px 4px 0; }
.hbar-value { color: var(--text); font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; font-weight: 500; }
.hbar-share { display: inline-block; min-width: 3.2em; margin-left: 6px; color: var(--text-3); font-weight: 400; font-size: var(--fs-xs); text-align: right; }
.ranked { list-style: none; margin: 0; padding: 0; display: grid; }
.ranked-row { display: grid; grid-template-columns: 22px minmax(0, 1fr) auto; align-items: center; gap: var(--space-3); min-height: 32px; border-top: 1px solid var(--border); font-size: var(--fs-sm); }
.ranked-row:first-child { border-top: 0; }
.ranked-rank { color: var(--text-3); font-size: var(--fs-xs); font-variant-numeric: tabular-nums; text-align: right; }
.ranked-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ranked-value { font-variant-numeric: tabular-nums; font-weight: 500; white-space: nowrap; text-align: right; }

/* ---------- signal viewer ---------- */
.viewer-filter button { display: inline-flex; flex-direction: column; align-items: flex-start; gap: 0; padding: 5px 12px; line-height: 1.25; }
.viewer-filter-note { color: var(--text-3); font-size: 12px; font-weight: 400; }
.viewer-measure { margin-top: 0; }
.viewer-grid { display: grid; gap: var(--space-4); }
.viewer-lists { display: grid; gap: var(--space-4); grid-template-columns: repeat(auto-fit, minmax(min(100%, 340px), 1fr)); align-items: start; }
.viewer-loads .measure-total-label { margin-top: 0; }
.viewer-loads .measure-total.is-muted { color: var(--text-3); font-weight: 500; font-size: var(--fs-lg); }
.viewer-split { margin-top: var(--space-3); }
.viewer-loads .fine { margin-top: var(--space-3); }
.viewer-loads .chart { margin-top: var(--space-4); }
.viewer-card .ranked-label a { color: var(--accent-text); }
.ranked-aggregate { color: var(--text-3); }
.ranked-aggregate .ranked-value { font-weight: 400; }
.viewer-card > .ranked + .fine { margin-top: var(--space-3); }

/* ---------- reach ---------- */
.geo-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); margin-bottom: var(--space-4); }
.geography-sources button { display: inline-flex; flex-direction: column; align-items: flex-start; gap: 0; padding: 5px 12px; line-height: 1.25; }
.geography-source-status { color: var(--text-3); font-size: 12px; font-weight: 400; }
.geo-layout { display: grid; gap: var(--space-4); grid-template-columns: minmax(0, 1fr); align-items: stretch; }
.geo-map-card { padding: var(--space-3); display: flex; flex-direction: column; }
.geography-map-frame { position: relative; flex: 1; display: flex; align-items: center; overflow: hidden; border-radius: var(--radius-md); background: var(--map-sea); }
.geography-map { display: block; width: 100%; height: auto; }
.map-country { fill: url(#map-nodata) var(--map-land); stroke: var(--map-stroke); stroke-width: 0.6; stroke-linejoin: round; }
.map-country-marker { fill: var(--map-land); stroke: var(--map-stroke); stroke-width: 1; }
/* Continuous fill: --m is the mix within one half of the ramp (scale.ts). */
.map-country.map-a, .map-country-marker.map-a, .map-country.map-b, .map-country-marker.map-b { fill: var(--map-mid); }
@supports (color: color-mix(in oklab, red, blue)) {
  .map-country.map-a, .map-country-marker.map-a { fill: color-mix(in oklab, var(--map-lo), var(--map-mid) var(--m, 50%)); }
  .map-country.map-b, .map-country-marker.map-b { fill: color-mix(in oklab, var(--map-mid), var(--map-hi) var(--m, 50%)); }
}
.map-a, .map-b { cursor: pointer; }
.map-a:hover, .map-b:hover, .map-country.is-selected, .map-country-marker.is-selected { stroke: var(--text); stroke-width: 1.8; }
.geography-map:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; border-radius: var(--radius-md); }
.map-readout { min-height: 1.5em; padding: var(--space-2) var(--space-2) 0; color: var(--text); font-size: var(--fs-sm); font-variant-numeric: tabular-nums; }
.map-legend { display: flex; flex-wrap: wrap; align-items: flex-start; justify-content: space-between; gap: var(--space-3) var(--space-5); padding: var(--space-3) var(--space-2) var(--space-1); }
.map-scale { flex: 1 1 280px; max-width: 460px; min-width: 0; }
.map-gradient { height: 10px; border-radius: 2px; background: linear-gradient(to right, var(--map-lo), var(--map-mid), var(--map-hi)); }
@supports (background-image: linear-gradient(to right in oklab, red, blue)) {
  .map-gradient { background: linear-gradient(to right in oklab, var(--map-lo), var(--map-mid), var(--map-hi)); }
}
.map-ticks { position: relative; height: 20px; }
.map-tick { position: absolute; top: 0; padding-top: 6px; transform: translateX(-50%); color: var(--text-3); font-size: 12px; line-height: 1.2; white-space: nowrap; font-variant-numeric: tabular-nums; }
.map-tick::before { content: ""; position: absolute; top: 0; left: 50%; width: 1px; height: 4px; background: var(--text-3); }
.map-tick.is-first { transform: none; }
.map-tick.is-first::before { left: 0; }
.map-tick.is-last { transform: translateX(-100%); }
.map-tick.is-last::before { left: auto; right: 0; }
.map-swatch { display: block; height: 10px; border-radius: 2px; }
.map-swatch.map-none { width: 20px; background: repeating-linear-gradient(-45deg, var(--map-land) 0 3px, var(--map-hatch) 3px 4px); border: 1px solid var(--control-border); }
.map-nodata-bg { fill: var(--map-land); }
.map-nodata-line { stroke: var(--map-hatch); stroke-width: 1.2; }
.map-legend-label { color: var(--text-3); font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.map-legend-empty { display: flex; align-items: center; gap: 6px; }
.geo-side { display: grid; gap: 4px; align-content: start; }
.geo-total-label { color: var(--text-2); font-size: var(--fs-sm); font-weight: 500; }
.geo-total { font-size: var(--fs-2xl); font-weight: 600; letter-spacing: -0.024em; line-height: 1.15; }
.geo-date { color: var(--text-3); font-size: var(--fs-xs); }
.geo-list-title { margin: var(--space-4) 0 var(--space-1); color: var(--text-2); font-size: var(--fs-xs); font-weight: 600; }
.geo-side .fine { margin-top: var(--space-3); }
.geo-side .hbars { gap: 10px; }
.geo-side .hbar { grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "label value" "track track"; row-gap: 3px; min-height: 0; }
.geo-side .hbar-label { grid-area: label; }
.geo-side .hbar-value { grid-area: value; }
.geo-side .hbar-track { grid-area: track; height: 6px; }
.geo-more { display: flex; flex-wrap: wrap; gap: 0 var(--space-6); }
.geo-more > .more { flex: 1 1 320px; }
.geography-period { color: var(--text-3); font-size: var(--fs-xs); font-variant-numeric: tabular-nums; }

/* ---------- catalog ---------- */
.stat-strip { display: flex; flex-wrap: wrap; gap: var(--space-3) var(--space-6); margin: 0 0 var(--space-5); padding: 14px 20px; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); }
.stat-item dt { display: flex; align-items: center; gap: 4px; color: var(--text-3); font-size: var(--fs-xs); }
.stat-item dd { margin: 2px 0 0; font-size: var(--fs-md); font-weight: 600; }
.stat-share { margin-left: 6px; color: var(--text-3); font-size: var(--fs-xs); font-weight: 400; }
.catalog-grid { display: grid; gap: var(--space-4); grid-template-columns: minmax(0, 1fr); align-items: start; }
.card-wide { grid-column: 1 / -1; }

/* ---------- pipelines ---------- */
.health-meta { margin: calc(-1 * var(--space-3)) 0 var(--space-4); color: var(--text-3); font-size: var(--fs-xs); }
.health-grid { display: grid; gap: var(--space-4); grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); align-items: start; }
.health-col { display: flex; flex-direction: column; gap: var(--space-4); min-width: 0; }
.health-card { display: flex; flex-direction: column; }
.coverage { display: flex; align-items: center; gap: var(--space-4); padding: var(--space-3); margin-bottom: var(--space-2); border-radius: var(--radius-md); background: var(--surface-2); }
.ring { position: relative; width: 64px; height: 64px; flex: none; }
.ring svg { display: block; }
.ring-track { fill: none; stroke: var(--surface-3); }
.ring-fill { fill: none; stroke: var(--accent); stroke-linecap: round; }
.ring-label { position: absolute; inset: 0; display: grid; place-items: center; font-size: var(--fs-sm); font-weight: 600; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
.coverage-label { display: flex; align-items: center; gap: 4px; font-size: var(--fs-sm); font-weight: 500; }
.coverage-value { color: var(--text-3); font-size: var(--fs-xs); font-variant-numeric: tabular-nums; }
.health-rows { list-style: none; margin: 0; padding: 0; }
.state-mark { display: inline-grid; place-items: center; width: 16px; height: 16px; }
.mark-ok { color: var(--ok-text); opacity: 0.8; }
.mark-review { width: 10px; height: 10px; fill: var(--warn); stroke: none; }
.health-row { display: grid; grid-template-columns: 16px minmax(0, 1fr) auto; align-items: center; gap: 10px; padding: 9px 2px; border-top: 1px solid var(--border); }
.health-row:first-child { border-top: 0; }
.health-label { display: flex; align-items: center; gap: 4px; min-width: 0; font-size: var(--fs-sm); }
.health-value { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.health-value strong { font-weight: 600; }
.health-share { margin-right: 10px; color: var(--text-3); font-size: var(--fs-xs); }
.health-breakdown { grid-column: 2 / -1; }
.health-card .card-foot { margin-top: auto; }
.health-card .health-rows { margin-bottom: var(--space-2); }
.card-link { color: var(--accent-text); font-size: var(--fs-sm); font-weight: 500; text-decoration: none; }
.card-link:hover { text-decoration: underline; }

/* ---------- recorded hours ---------- */
/* Included bars are the accent, excluded bars the muted gray: validated as a
   pair on both surfaces (3:1 against the card, normal-vision and color-vision
   separation above the floors). Position against the rule, the shaded band,
   and the table's divider row carry the same split without color. */
.hours-block { margin-top: var(--space-6); }
.hours-block > .subsection-head { margin-top: 0; }
.hours-block .hours-scope { flex-basis: 100%; max-width: 75ch; color: var(--text-2); }
.hours-card { padding: 0; }
.hours-top { display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: space-between; gap: var(--space-2) var(--space-4); padding: 10px 20px 0; border-bottom: 1px solid var(--border); }
/* Positioned, so the screen-reader text inside each tab total (absolutely
   positioned) is clipped by the strip's own scrolling instead of widening the
   page. When the strip scrolls, a soft shadow marks each edge with more tabs
   beyond it: the local covers move with the tabs and hide it at the ends.
   The script marks a strip that scrolls; one that fits paints no shadow at all.
   The layers stop 2px short of the bottom, so the strip's underline shows. */
.hours-tabs { position: relative; display: flex; gap: 2px; min-width: 0; max-width: 100%; overflow-x: auto; scrollbar-width: thin; margin-bottom: -1px; }
.hours-tabs.is-scrollable {
  background:
    linear-gradient(to right, var(--surface) 50%, transparent) left top / 28px calc(100% - 2px) no-repeat local,
    linear-gradient(to left, var(--surface) 50%, transparent) right top / 28px calc(100% - 2px) no-repeat local,
    radial-gradient(farthest-side at 0 50%, var(--edge-shadow), transparent) left -1px top / 12px calc(100% - 2px) no-repeat scroll,
    radial-gradient(farthest-side at 100% 50%, var(--edge-shadow), transparent) right -1px top / 12px calc(100% - 2px) no-repeat scroll;
}
.hours-tab { display: inline-flex; flex: none; flex-direction: column; align-items: flex-start; gap: 1px; min-width: 72px; min-height: 52px; padding: 8px 14px 9px; border: 0; border-bottom: 2px solid transparent; border-radius: var(--radius-md) var(--radius-md) 0 0; background: transparent; color: var(--text-2); cursor: pointer; text-align: left; }
.hours-tab:hover { color: var(--text); background: var(--surface-2); }
.hours-tab[aria-selected="true"] { color: var(--text); border-bottom-color: var(--accent); }
.hours-tab:focus-visible { outline-offset: -2px; }
.hours-tab-name { font-family: var(--font-display); font-size: var(--fs-md); font-weight: 600; line-height: 1.25; }
.hours-tab-total { color: var(--text-3); font-size: var(--fs-xs); font-variant-numeric: tabular-nums; white-space: nowrap; }
.hours-tab[aria-selected="true"] .hours-tab-total { color: var(--text-2); }
.hours-measures { margin-bottom: 10px; }
.hours-panel { padding: 20px; }
.hours-notices { display: grid; gap: var(--space-2); margin-bottom: var(--space-4); }
.hours-notices[hidden] { display: none; }
.hours-notice { display: flex; align-items: flex-start; gap: var(--space-2); padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface-2); color: var(--text); font-size: var(--fs-sm); line-height: 1.45; box-shadow: inset 3px 0 0 var(--warn); }
.hours-notice .icon { margin-top: 2px; color: var(--text-2); }
.hours-body { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--space-5); }
.hours-readout { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.hours-value { font-size: 40px; font-weight: 600; letter-spacing: -0.03em; line-height: 1.05; overflow-wrap: anywhere; }
.hours-value-unit { color: var(--text-2); font-size: var(--fs-lg); font-weight: 500; letter-spacing: -0.01em; }
.hours-claim { min-height: 2.8em; color: var(--text); font-size: var(--fs-md); line-height: 1.4; }
.hours-meter { margin-top: var(--space-1); }
.hours-meter .meter-fill { transition: width 160ms var(--ease); }
.hours-share { color: var(--text-3); font-size: var(--fs-sm); }
.hours-facts { display: grid; margin: var(--space-3) 0 0; }
.hours-fact { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); min-height: 36px; border-top: 1px solid var(--border); }
.hours-facts dt { display: flex; align-items: center; gap: 4px; color: var(--text-2); font-size: var(--fs-sm); }
.hours-facts dd { margin: 0; font-size: var(--fs-md); font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
.hours-plot { min-width: 0; }
.hours-plot-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-3); margin-bottom: var(--space-1); }
.hours-plot-title { color: var(--text-2); font-size: var(--fs-sm); font-weight: 600; }
.hours-band { fill: var(--hours-band); }
.hours-rule { stroke: var(--text-2); stroke-width: 1.5; }
.hours-bar { fill: var(--mark-muted); transition: opacity 120ms var(--ease); }
.hours-bar.is-in { fill: var(--accent); }
.has-active .hours-bar { opacity: 0.4; }
.has-active .hours-bar.is-active { opacity: 1; }
.hours-slider { height: 32px; }
.hours-range { --cut: 0px; display: block; height: 32px; margin: 0; padding: 0; background: transparent; cursor: pointer; touch-action: pan-y; -webkit-appearance: none; appearance: none; }
.hours-range::-webkit-slider-runnable-track { height: 6px; border-radius: var(--radius-pill); background: linear-gradient(to right, var(--border-strong) 0 var(--cut), var(--accent) var(--cut) 100%); }
.hours-range::-moz-range-track { height: 6px; border-radius: var(--radius-pill); background: linear-gradient(to right, var(--border-strong) 0 var(--cut), var(--accent) var(--cut) 100%); }
.hours-range::-webkit-slider-thumb { box-sizing: border-box; width: 24px; height: 24px; margin-top: -9px; border: 2px solid var(--accent); border-radius: 50%; background: var(--surface); box-shadow: var(--shadow-sm); -webkit-appearance: none; appearance: none; }
.hours-range::-moz-range-thumb { box-sizing: border-box; width: 24px; height: 24px; border: 2px solid var(--accent); border-radius: 50%; background: var(--surface); box-shadow: var(--shadow-sm); }
.hours-range:focus-visible { outline: none; }
.hours-range:focus-visible::-webkit-slider-thumb { box-shadow: 0 0 0 2px var(--surface), 0 0 0 4px var(--focus); }
.hours-range:focus-visible::-moz-range-thumb { box-shadow: 0 0 0 2px var(--surface), 0 0 0 4px var(--focus); }
.hours-slider-row { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 2px var(--space-3); font-size: var(--fs-sm); }
.hours-slider-label { color: var(--text-2); }
.hours-foot { margin-top: var(--space-4); padding-top: var(--space-1); border-top: 1px solid var(--border); }
.hours-foot .fine:first-of-type { margin-top: var(--space-3); }
.hours-table .is-below th, .hours-table .is-below td { color: var(--text-3); }
.hours-caption { padding: 8px 12px; caption-side: top; color: var(--text-3); font-size: var(--fs-xs); text-align: left; }
.hours-table .hours-cut td { padding: 5px 12px; background: var(--hours-band); color: var(--text); font-size: var(--fs-xs); font-weight: 600; }
@media (min-width: 600px) and (max-width: 899px) {
  .hours-readout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(220px, 280px); align-content: start; gap: 6px var(--space-6); }
  .hours-readout > * { grid-column: 1; }
  .hours-readout > .hours-facts { grid-column: 2; grid-row: 1 / span 4; align-self: start; margin-top: 0; }
}
@media (min-width: 900px) {
  .hours-body { grid-template-columns: minmax(240px, 290px) minmax(0, 1fr); gap: var(--space-6); }
}

/* ---------- NEMAR footer (matches nemar.org) ---------- */
.site-footer { margin-top: var(--space-8); padding: 4rem 0 3rem; background: var(--surface); border-top: 1px solid var(--border); color: var(--text-2); font-size: 0.875rem; }
.site-footer__top { display: grid; grid-template-columns: minmax(0, 1.4fr) 2fr; gap: 3rem; }
.site-footer__heading { font-family: var(--font-display); font-size: 1.5rem; font-weight: 600; line-height: 1.15; letter-spacing: -0.01em; color: var(--text); margin-bottom: var(--space-3); }
.site-footer__about p + p { margin-top: var(--space-3); }
.site-footer__caveat { color: var(--text-3); }
.site-footer__nav { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 2rem; }
.site-footer__nav h3 { font-family: var(--font); font-size: 0.875rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text); font-weight: 600; margin-bottom: 0.75rem; }
.site-footer__nav ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
.site-footer a { color: var(--text-2); text-decoration: none; display: inline-flex; align-items: center; gap: 0.25em; }
.site-footer a:hover { color: var(--text); text-decoration: underline; }
.site-footer__sources { margin-top: 3rem; padding-top: 2rem; border-top: 1px solid var(--border); display: grid; grid-template-columns: minmax(0, 1.4fr) 2fr; gap: 1rem 3rem; }
.site-footer__label { color: var(--text-3); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.1em; font-weight: 600; }
.site-footer__sources p { max-width: 72ch; }
.site-footer__credits { margin-top: 2rem; display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.5rem 1.25rem; }
.site-footer__credits ul { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 0.5rem 1.25rem; }
.site-footer__bottom { margin-top: 2.5rem; display: flex; flex-wrap: wrap; gap: 0.75rem 1.5rem; color: var(--text-3); }
@media (max-width: 720px) {
  .site-footer__top, .site-footer__sources { grid-template-columns: minmax(0, 1fr); gap: 2rem; }
}

/* ---------- responsive ---------- */
@media (min-width: 720px) {
  .catalog-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .catalog-grid .card-ranked { grid-column: 1 / -1; }
}
@media (min-width: 900px) {
  .kpi-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
}
@media (min-width: 1000px) {
  .geo-layout { grid-template-columns: minmax(0, 1fr) minmax(300px, 340px); }
}
@media (min-width: 1180px) {
  .catalog-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .catalog-grid .card-ranked { grid-column: auto; }
  .series-grid { grid-template-columns: repeat(auto-fit, minmax(520px, 1fr)); }
}
@media (max-width: 1099px) {
  .section-nav { display: none; }
  .popover.nav-menu { display: inline-flex; }
}
@media (max-width: 720px) {
  :root { --gutter: 16px; --header-h: 56px; --filter-h: 48px; }
  .site-utility { display: none; }
  .site-header__inner { gap: var(--space-3); }
  .site-header__actions { gap: 0; }
  .brand-logo { height: 26px; }
  .site-brand { gap: 10px; }
  .site-brand__product { font-size: 1rem; padding-left: 10px; }
  .portal-link { display: none; }
  .filterbar { gap: var(--space-2); }
  .filterbar-note { display: none; }
  .segmented button { padding: 4px 9px; }
  .range-custom > summary .custom-label { display: none; }
  main > section { padding-top: var(--space-6); }
  .hero { padding-top: var(--space-5); }
  .card { padding: 16px; }
  .kpi { padding: 14px; min-height: 140px; }
  .kpi-value { font-size: 26px; }
  .alltime { padding: 12px 14px 14px; }
  .alltime-grid { column-gap: var(--space-4); }
  .tiles { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--space-2); }
  .tile { padding: 12px; }
  .tile-value .v { font-size: var(--fs-lg); }
  .hbars { gap: 10px; }
  .hbar { grid-template-columns: minmax(0, 1fr) auto; grid-template-areas: "label value" "track track"; row-gap: 3px; min-height: 0; }
  .hbar-label { grid-area: label; }
  .hbar-value { grid-area: value; }
  .hbar-track { grid-area: track; }
  .geo-side .hbar { grid-template-columns: minmax(0, 1fr) auto; }
  .map-scale { flex-basis: 100%; max-width: none; }
  .hours-top { flex-direction: column; align-items: stretch; padding: 6px 12px 0; border-bottom: 0; }
  .hours-tabs { margin-bottom: 0; box-shadow: inset 0 -1px 0 var(--border); }
  .hours-measures { align-self: flex-start; margin: var(--space-3) 4px 0; }
  .hours-tab { min-width: 64px; padding: 8px 10px 9px; }
  .hours-panel { padding: 16px; }
  .hours-value { font-size: 34px; }
  .hours-table th, .hours-table td { padding-left: 8px; padding-right: 8px; }
}
@media (max-width: 420px) {
  .range-summary { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  *, *::before, *::after { animation-duration: 0.001ms !important; animation-iteration-count: 1 !important; transition-duration: 0.001ms !important; }
  .skeleton { animation: none; }
}
@media (forced-colors: active) {
  .segmented button[aria-pressed="true"], .section-nav a[aria-current="true"], .site-utility__nav a[aria-current="page"] { forced-color-adjust: none; background: Highlight; color: HighlightText; }
  .range-custom.is-active > summary { outline: 2px solid Highlight; }
  .chart-line, .chart-bar, .hbar-fill, .meter-fill, .ring-fill, .geography-map, .map-gradient { forced-color-adjust: none; }
  .badge { border: 1px solid CanvasText; }
  .hours-tab[aria-selected="true"] { border-bottom-color: Highlight; }
  .hours-bar, .hours-band, .hours-rule, .hours-range { forced-color-adjust: none; }
  .hours-bar { fill: GrayText; }
  .hours-bar.is-in { fill: Highlight; }
  .hours-band { fill: transparent; }
  .hours-rule { stroke: CanvasText; }
  .hours-range::-webkit-slider-runnable-track { background: linear-gradient(to right, GrayText 0 var(--cut), Highlight var(--cut) 100%); }
  .hours-range::-moz-range-track { background: linear-gradient(to right, GrayText 0 var(--cut), Highlight var(--cut) 100%); }
  .hours-range::-webkit-slider-thumb { background: Canvas; border-color: Highlight; }
  .hours-range::-moz-range-thumb { background: Canvas; border-color: Highlight; }
}
`;
