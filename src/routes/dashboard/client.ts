// The dashboard's client script, inlined into the page by routes/ui.ts.
//
// Each part is a String.raw template, so none may contain a backtick or a
// dollar-brace sequence. The parts share one script scope and are joined in
// dependency order; BOOT_JS runs last and starts every load.
//
// The script builds every node with createElement / createElementNS and sets
// data through textContent, never innerHTML, so dataset ids, labels, and
// country names cannot inject markup. Every request is a GET to the public read
// API; it holds no credential and never writes (#8).

import { CHARTS_JS } from "./charts";
import { CORE_JS } from "./core";
import { LEGACY_JS } from "./legacy";
import { REACH_JS } from "./reach";
import { USAGE_JS } from "./usage";

const BOOT_JS = String.raw`
load();
const initialRange = rangeFor(30);
document.getElementById("range-start").value = initialRange.start;
document.getElementById("range-end").value = initialRange.end;
document.querySelectorAll("[data-range]").forEach(function (button) { button.addEventListener("click", function () { const r = rangeFor(Number(button.dataset.range)); document.getElementById("range-start").value = r.start; document.getElementById("range-end").value = r.end; const custom = document.getElementById("range-custom"); if (custom) custom.open = false; loadSelectedRange(); }); });
document.getElementById("range-start").addEventListener("change", loadSelectedRange);
document.getElementById("range-end").addEventListener("change", loadSelectedRange);
document.getElementById("grouping").addEventListener("change", regroupSeries);
loadSelectedRange();
`;

export const CLIENT_JS = [CORE_JS, CHARTS_JS, USAGE_JS, REACH_JS, LEGACY_JS, BOOT_JS].join("\n");
