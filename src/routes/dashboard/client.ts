// The dashboard's client script, inlined into the page by routes/ui.ts.
//
// Each part is a String.raw template, so none may contain a backtick or a
// dollar-brace sequence. The parts share one script scope and are joined in
// dependency order. The legacy part still carries its own boot sequence.
//
// The script builds every node with createElement / createElementNS and sets
// data through textContent, never innerHTML, so dataset ids, labels, and
// country names cannot inject markup. Every request is a GET to the public read
// API; it holds no credential and never writes (#8).

import { CORE_JS } from "./core";
import { LEGACY_JS } from "./legacy";

export const CLIENT_JS = [CORE_JS, LEGACY_JS].join("\n");
