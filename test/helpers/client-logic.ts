// Runs the dashboard's DOM-free client modules exactly as the browser does:
// the same source strings, joined in page order and evaluated in one function
// scope. Nothing is reimplemented or replaced; the tests call the page's code.

import { CHANNELS_JS } from "../../src/routes/dashboard/channels";
import { FORMAT_JS } from "../../src/routes/dashboard/format";
import { MODEL_JS } from "../../src/routes/dashboard/model";
import { RANGE_JS } from "../../src/routes/dashboard/range";
import { SCALE_JS } from "../../src/routes/dashboard/scale";
import { SERIES_JS } from "../../src/routes/dashboard/series";
import { THEME_JS } from "../../src/routes/dashboard/theme";

export const PURE_MODULES = [
  FORMAT_JS,
  RANGE_JS,
  THEME_JS,
  SERIES_JS,
  MODEL_JS,
  CHANNELS_JS,
  SCALE_JS,
];

// biome-ignore lint/suspicious/noExplicitAny: the client script is untyped JavaScript.
export function clientLogic(names: string[]): Record<string, any> {
  const body = `${PURE_MODULES.join("\n")}\nreturn { ${names.join(", ")} };`;
  return new Function(body)();
}
