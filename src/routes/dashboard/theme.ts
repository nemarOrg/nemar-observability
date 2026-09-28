// Theme choice and cycle order, with no DOM access, so the tests can run this
// exact code. core.ts wires it to the toggle button and the root attribute.
//
// No data-theme attribute means follow the system, live. The toggle cycles
// system and the two explicit themes, opposite of the system first, so the
// first click always changes what is on screen. Any other attribute value (an
// embedding host's typo, say) is treated as following the system.
//
// Part of the inlined client script (see client.ts): a String.raw template, so
// no backticks and no dollar-brace sequences.

export const THEME_JS = String.raw`
// ---------- theme order ----------
function normalizeThemeChoice(value) { return value === "light" || value === "dark" ? value : "system"; }
function themeOrder(system) { return system === "dark" ? ["system", "light", "dark"] : ["system", "dark", "light"]; }
function nextThemeFor(choice, system) {
  const order = themeOrder(system);
  return order[(order.indexOf(normalizeThemeChoice(choice)) + 1) % order.length];
}
`;
