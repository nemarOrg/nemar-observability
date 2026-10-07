// What the two modality selectors share: the tone each recording type is drawn
// in, and the tab strip itself. The recorded-hours explorer and the Dataset
// size card both build their tabs here, so they behave the same (automatic
// activation, arrow keys, Home and End), scroll the same on a phone, and look
// alike.
//
// A tone is only a name in the script ("eeg", "meg", "ieeg", "emg", "nirs",
// "motion", or "other"); styles.ts maps it to the NEMAR website's color for
// that recording type, in light and dark. The color is never the only cue: each
// tab carries its type's name.
//
// Part of the inlined client script (see client.ts): a String.raw template, so
// no backticks and no dollar-brace sequences.

export const MODALITY_JS = String.raw`
const MODALITY_TONES = ["eeg", "meg", "ieeg", "emg", "nirs", "motion"];
// The tone for a recording type. Anything the palette does not name (ECG, MISC)
// reads as "other", the way the website draws a type it has no color for.
function modalityTone(key) {
  const tone = String(key === null || key === undefined ? "" : key).toLowerCase();
  return MODALITY_TONES.indexOf(tone) >= 0 ? tone : "other";
}
// A strip of tabs. options: label (the tablist's name), idPrefix (tab ids are
// idPrefix + index), panelId (the tabpanel they control), className (extra
// class on the strip), items [{ key, name, tone, total, spoken }] (total is the
// short figure under the name; spoken, when given, is what a screen reader
// hears in its place), onSelect(key). Selection is shown by markModalityTabs.
function buildModalityTabs(options) {
  const tablist = el("div", "hours-tabs" + (options.className ? " " + options.className : ""));
  tablist.setAttribute("role", "tablist");
  tablist.setAttribute("aria-label", options.label);
  const tabs = options.items.map(function (item, index) {
    const tab = el("button", "hours-tab");
    tab.type = "button";
    tab.id = options.idPrefix + index;
    tab.dataset.modality = item.key;
    if (item.tone) tab.dataset.tone = item.tone;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", options.panelId);
    tab.appendChild(el("span", "hours-tab-name", item.name));
    if (item.total !== null && item.total !== undefined) tab.appendChild(figure("span", "hours-tab-total", item.total, item.spoken));
    tab.addEventListener("click", function () { options.onSelect(item.key); });
    tablist.appendChild(tab);
    return tab;
  });
  tablist.addEventListener("keydown", function (event) {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const index = tabs.indexOf(document.activeElement);
    if (index < 0) return;
    const count = tabs.length;
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % count;
    else if (event.key === "ArrowLeft") next = (index - 1 + count) % count;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = count - 1;
    else return;
    event.preventDefault();
    tabs[next].focus();
    options.onSelect(options.items[next].key);
  });
  return { tablist: tablist, tabs: tabs };
}
// Shows which tab is chosen: aria-selected, the roving tab stop, and the panel's
// name. Returns the chosen tab, or null when no tab has that key.
function markModalityTabs(strip, key, panel) {
  let chosen = null;
  strip.tabs.forEach(function (tab) {
    const on = tab.dataset.modality === key;
    tab.setAttribute("aria-selected", String(on));
    tab.tabIndex = on ? 0 : -1;
    if (on) {
      chosen = tab;
      if (panel) panel.setAttribute("aria-labelledby", tab.id);
    }
  });
  return chosen;
}
// Marks a strip that scrolls, for its edge shadows.
function syncTabStrip(tablist) {
  if (!tablist) return;
  tablist.classList.toggle("is-scrollable", stripScrolls(tablist.clientWidth, tablist.scrollWidth));
}
// A tab chosen by a link or the arrow keys can sit past the strip's edge on a
// phone. The strip scrolls itself to center it; scrollIntoView could scroll the
// whole page instead. The strip is positioned, so offsetLeft is measured in it.
function centerStripTab(tablist, tab) {
  syncTabStrip(tablist);
  const left = centeredScroll(tab.offsetLeft, tab.offsetWidth, tablist.clientWidth, tablist.scrollWidth);
  if (left !== null) tablist.scrollLeft = left;
}
`;
