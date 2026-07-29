// The dashboard.nemar.org landing/hub: a small index of the NEMAR dashboards.
// Served at the host root by the observability worker (a root-only Worker route,
// so /citations stays on the nemar-dashboard Pages project). To add a dashboard,
// append to DASHBOARDS — that is the whole maintenance surface.

interface DashboardLink {
  name: string;
  path: string;
  description: string;
  /** Accent color for the card. */
  accent: string;
}

const DASHBOARDS: DashboardLink[] = [
  {
    name: "Observability",
    path: "/observability",
    description:
      "Operational health of datasets and pipelines — public/private counts, archive and Zarr status, import backlog, publication queue, and most-accessed data. Admins can drill into what needs attention.",
    accent: "#4aa3ff",
  },
  {
    name: "Citations",
    path: "/citations",
    description:
      "How NEMAR datasets are used in the academic literature — citation discovery and insights across published work.",
    accent: "#2ea043",
  },
];

const STYLES = `
:root { --bg:#0f1216; --panel:#161b22; --panel-2:#1c2230; --border:#2a3340; --fg:#e7edf3; --muted:#8b97a6; }
* { box-sizing:border-box; }
body { margin:0; background:var(--bg); color:var(--fg);
  font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
.wrap { max-width:760px; margin:0 auto; padding:64px 24px 80px; }
.head h1 { font-size:26px; margin:0 0 6px; font-weight:680; letter-spacing:-.01em; }
.head p { color:var(--muted); margin:0 0 36px; }
.grid { display:flex; flex-direction:column; gap:14px; }
.card { display:block; text-decoration:none; color:inherit; background:var(--panel);
  border:1px solid var(--border); border-left-width:4px; border-radius:14px; padding:20px 22px;
  transition:border-color .15s, transform .15s; }
.card:hover { border-color:var(--muted); transform:translateY(-1px); }
.card h2 { margin:0 0 6px; font-size:18px; font-weight:620; display:flex; align-items:center; gap:8px; }
.card .arrow { color:var(--muted); font-weight:400; }
.card p { margin:0; color:var(--muted); font-size:14px; line-height:1.5; }
footer { margin-top:40px; color:var(--muted); font-size:12.5px; }
footer a { color:var(--muted); }
`;

export function renderHubPage(): string {
  const cards = DASHBOARDS.map(
    (d) =>
      `<a class="card" href="${d.path}" style="border-left-color:${d.accent}"><h2>${d.name} <span class="arrow">&rarr;</span></h2><p>${d.description}</p></a>`,
  ).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>NEMAR Dashboards</title><style>${STYLES}</style></head><body><div class="wrap"><div class="head"><h1>NEMAR Dashboards</h1><p>Dashboards for the Neuroelectromagnetic Data Archive and Tools Resource.</p></div><div class="grid">${cards}</div><footer>NEMAR &middot; <a href="https://ww2.nemar.org">browse datasets</a></footer></div></body></html>`;
}
