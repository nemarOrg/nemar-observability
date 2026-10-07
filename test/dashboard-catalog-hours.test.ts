// "What does NEMAR hold?" with the recorded-hours explorer inside it: where the
// explorer sits, the two figures it adds to the catalog strip, and the Dataset
// size card's tabs, which follow the explorer's type and move it in turn. The
// page's own script runs in a real DOM against the captured snapshot (see
// test/helpers/catalog-page.ts and hours-page.ts); the numbers expected here are
// written out from the helper's inputs, not read from the page's code.

import { afterEach, describe, expect, test } from "bun:test";
import { RECORDED, SIZES_BY_TYPE, catalogSnapshot } from "./helpers/catalog-page";
import {
  type Doc,
  all,
  closePages,
  key,
  openPage,
  payloadWithExtraTypes,
  q,
  text,
  until,
} from "./helpers/hours-page";

afterEach(closePages);

const open = (
  snapshotOptions: Parameters<typeof catalogSnapshot>[0] = {},
  hash = "",
  options = {},
) => openPage(null, hash, { snapshotBody: catalogSnapshot(snapshotOptions), ...options });

type Clickable = { click(): void };
const click = (doc: Doc, selector: string) => (q(doc, selector) as unknown as Clickable).click();
const name = (doc: Doc, tab: { id: string }) => text(doc, `#${tab.id} .hours-tab-name`);
/** The tab with this name in a strip: "#channel-hours" (explorer) or "#catalog-size" (size card). */
function tabIn(doc: Doc, root: string, tabName: string) {
  const tab = all(doc, `${root} [role=tab]`).find((t) => name(doc, t) === tabName);
  if (!tab) throw new Error(`no ${tabName} tab in ${root}`);
  return tab as unknown as Clickable & { id: string };
}
const chosen = (doc: Doc, root: string) => {
  const tabs = all(doc, `${root} [role=tab][aria-selected=true]`);
  expect(tabs).toHaveLength(1);
  return name(doc, tabs[0]);
};
const sizeCard = (doc: Doc) => q(doc, ".size-card");
const sizeTone = (doc: Doc) => sizeCard(doc).getAttribute("data-tone");
const exploreTone = (doc: Doc) => q(doc, ".hours-card").getAttribute("data-tone");
const note = (doc: Doc) => {
  const node = q(doc, ".size-note") as unknown as { hidden: boolean; textContent: string };
  return node.hidden ? null : node.textContent;
};

describe("where the explorer sits", () => {
  test("in the catalog, after its cards and before the size card, and not in the pipeline section", async () => {
    const { document, errors } = await open();
    const ids = all(document, "#datasets > *").map((n) => n.id || "head");
    expect(ids).toEqual(["head", "catalog", "recorded-hours", "catalog-size"]);
    // The cards above it, and the size card below it, not in the card grid.
    expect(all(document, "#catalog .catalog-grid .card-title").map((n) => n.textContent)).toEqual([
      "Recording modality",
      "License",
      "Largest datasets",
    ]);
    expect(all(document, "#catalog-size .card-title").map((n) => n.textContent)).toEqual([
      "Dataset size",
    ]);
    expect(document.querySelector("#pipelines #recorded-hours")).toBeNull();
    expect(document.querySelector("#pipelines #channel-hours")).toBeNull();
    expect(text(document, "#recorded-hours h3")).toBe("Recorded hours by channel count");
    // The recordings card on the pipeline side still points at it.
    expect(q(document, "#card-recordings .card-link").getAttribute("href")).toBe("#recorded-hours");
    expect(errors).toEqual([]);
  });

  test("the per-type size histograms are tabs of the size card, not cards of their own", async () => {
    const { document } = await open();
    expect(all(document, ".catalog-card")).toHaveLength(4);
    expect(document.querySelector('[id*="sizes.histogram."]')).toBeNull();
    expect(text(document, "#catalog")).not.toContain("Size distribution");
  });
});

describe("the figures the catalog strip adds", () => {
  const items = (doc: Doc) =>
    all(doc, "#catalog .stat-item").map((n) => ({
      label: text(
        doc,
        `#catalog .stat-item:nth-child(${all(doc, "#catalog .stat-item").indexOf(n) + 1}) dt > span`,
      ),
      node: n,
    }));
  const labels = (doc: Doc) => items(doc).map((i) => i.label);

  test("recordings and recorded hours follow the catalog's own figures", async () => {
    const { document } = await open();
    expect(labels(document)).toEqual([
      "Public datasets",
      "Private datasets",
      "With DOI",
      "Total data",
      "Recordings",
      "Recorded hours",
    ]);
    const [recordings, hours] = items(document).slice(4);
    const dd = (item: (typeof recordings)["node"]) =>
      item as unknown as {
        querySelector(s: string): { textContent: string; firstChild: { textContent: string } };
      };
    expect(dd(recordings.node).querySelector("dd").firstChild.textContent).toBe("233,194");
    // 233,194 of 236,660 is 98.5%.
    expect(dd(recordings.node).querySelector(".stat-share").textContent).toBe("98.5% of 236,660");
    expect(dd(hours.node).querySelector("dd").textContent).toBe("145k h");
    expect(RECORDED.hours).toBeGreaterThan(144_500);
    expect(RECORDED.hours).toBeLessThan(145_500);
  });

  test("each says what it counts: only datasets converted for in-browser viewing", async () => {
    const { document } = await open();
    for (const which of ["Recordings", "Recorded hours"]) {
      const info = [...document.querySelectorAll("#catalog .stat-item")]
        .map((n) => n as unknown as { textContent: string })
        .find((n) => n.textContent.startsWith(which));
      expect(info?.textContent).toContain(
        "Counts only the public datasets converted for in-browser viewing so far, not the whole archive.",
      );
    }
  });

  test("without a recordings section the strip is the catalog's four, and the explorer says so", async () => {
    const { document, errors } = await open({ recordings: "none" });
    expect(labels(document)).toEqual([
      "Public datasets",
      "Private datasets",
      "With DOI",
      "Total data",
    ]);
    expect(text(document, "#channel-hours")).toContain(
      "No recorded-hours data is available right now",
    );
    expect(errors).toEqual([]);
  });

  test("a zero figure is left out too, not shown as 0", async () => {
    const { document } = await open({ zeroRecorded: true });
    expect(labels(document)).toEqual([
      "Public datasets",
      "Private datasets",
      "With DOI",
      "Total data",
    ]);
  });

  test("a failed collector run leaves them out rather than showing zero", async () => {
    const { document } = await open({ recordings: "failed" });
    expect(labels(document)).toEqual([
      "Public datasets",
      "Private datasets",
      "With DOI",
      "Total data",
    ]);
  });
});

describe("the size card's tabs", () => {
  test("All, then the types the explorer also has, with their dataset counts, opening on All", async () => {
    const { document, errors } = await open();
    const strip = q(document, "#catalog-size [role=tablist]");
    expect(strip.getAttribute("aria-label")).toBe("Recording type");
    const tabs = all(document, "#catalog-size [role=tab]");
    expect(tabs.map((t) => name(document, t))).toEqual(["All", "EEG", "MEG", "iEEG", "EMG"]);
    // What shows under each name (a reader hears the count with "datasets" after it).
    const shown = (t: { id: string }) =>
      text(document, `#${t.id} .hours-tab-total > [aria-hidden]`);
    const spoken = (t: { id: string }) => text(document, `#${t.id} .hours-tab-total .sr-only`);
    // The helper's per-type lists have 10, 4, 3 and 2 datasets; All is the whole catalog.
    expect(tabs.slice(1).map(shown)).toEqual(["10", "4", "3", "2"]);
    expect(tabs.slice(1).map(spoken)).toEqual([
      "10 datasets",
      "4 datasets",
      "3 datasets",
      "2 datasets",
    ]);
    expect(shown(tabs[0])).toBe(spoken(tabs[0]).replace(" datasets", ""));
    expect(Object.values(SIZES_BY_TYPE).map((l) => l.length)).toEqual([10, 4, 3, 2]);
    expect(tabs.map((t) => t.getAttribute("aria-selected"))).toEqual([
      "true",
      "false",
      "false",
      "false",
      "false",
    ]);
    expect(tabs.map((t) => t.getAttribute("aria-controls"))).toEqual(Array(5).fill("size-panel"));
    const panel = q(document, "#size-panel");
    expect(panel.getAttribute("role")).toBe("tabpanel");
    expect(panel.getAttribute("aria-labelledby")).toBe(tabs[0].id);
    // All is the plain, uncolored card; the explorer, on EEG, is not mirrored.
    expect(sizeTone(document)).toBeNull();
    expect(chosen(document, "#channel-hours")).toBe("EEG");
    expect(errors).toEqual([]);
  });

  test("a snapshot from before the per-type histograms shows the card as it was, with no tabs", async () => {
    const { document, errors } = await open({ withoutSizeTypes: true });
    expect(document.querySelector("#catalog-size [role=tablist]")).toBeNull();
    expect(text(document, "#catalog-size .card-title")).toBe("Dataset size");
    expect(text(document, "#catalog-size")).toContain("Show exact values (23 bins)");
    // Moving the explorer around is harmless with no card to follow it.
    click(document, "#channel-hours [role=tab]:nth-child(2)");
    expect(errors).toEqual([]);
  });

  test("each tab has its own histogram, table, and line under the title", async () => {
    const { document } = await open();
    const sub = () => text(document, "#catalog-size .card-sub");
    expect(sub()).toBe("How many public datasets fall in each size range, on a log scale.");
    tabIn(document, "#catalog-size", "MEG").click();
    expect(sub()).toBe("Public datasets that include MEG recordings, by size, on a log scale.");
    const visible = all(document, "#catalog-size .size-block").filter(
      (b) => !(b as unknown as { hidden: boolean }).hidden,
    );
    expect(visible).toHaveLength(1);
    // The MEG table lists the same 23 bins, with the helper's four datasets in them.
    const rows = [
      ...(
        visible[0] as unknown as { querySelectorAll(s: string): Iterable<{ textContent: string }> }
      ).querySelectorAll("tbody td"),
    ].map((c) => Number(c.textContent));
    expect(rows).toHaveLength(23);
    expect(rows.reduce((a, b) => a + b, 0)).toBe(4);
    tabIn(document, "#catalog-size", "All").click();
    expect(sub()).toBe("How many public datasets fall in each size range, on a log scale.");
  });
});

describe("one choice drives both selectors", () => {
  test("a type chosen in the size card moves the explorer, its tone, and the address", async () => {
    const { document, window, errors } = await open();
    tabIn(document, "#catalog-size", "iEEG").click();
    expect(chosen(document, "#catalog-size")).toBe("iEEG");
    expect(chosen(document, "#channel-hours")).toBe("iEEG");
    expect(exploreTone(document)).toBe("ieeg");
    expect(sizeTone(document)).toBe("ieeg");
    // The address is the one record of the choice; it lands after its short delay.
    await until(() => window.location.hash.startsWith("#hours=ieeg:"), "the address");
    expect(errors).toEqual([]);
  });

  test("a type chosen in the explorer moves the size card", async () => {
    const { document } = await open();
    tabIn(document, "#channel-hours", "MEG").click();
    expect(chosen(document, "#catalog-size")).toBe("MEG");
    expect(sizeTone(document)).toBe("meg");
    tabIn(document, "#channel-hours", "EMG").click();
    expect(chosen(document, "#catalog-size")).toBe("EMG");
    expect(sizeTone(document)).toBe("emg");
  });

  test("a minimum or a measure chosen in the explorer leaves the size card where the reader put it", async () => {
    const { document } = await open();
    tabIn(document, "#channel-hours", "MEG").click();
    tabIn(document, "#catalog-size", "All").click();
    click(document, '#channel-hours [data-measure="datasets"]');
    key(document, document.defaultView as never, "#hours-min", "ArrowRight");
    expect(chosen(document, "#catalog-size")).toBe("All");
    expect(chosen(document, "#channel-hours")).toBe("MEG");
  });

  test("All in the size card does not move the explorer", async () => {
    const { document } = await open();
    tabIn(document, "#catalog-size", "MEG").click();
    tabIn(document, "#catalog-size", "All").click();
    expect(chosen(document, "#catalog-size")).toBe("All");
    expect(sizeTone(document)).toBeNull();
    expect(chosen(document, "#channel-hours")).toBe("MEG");
    expect(exploreTone(document)).toBe("meg");
    // The next choice in the explorer moves the card again.
    tabIn(document, "#channel-hours", "EMG").click();
    expect(chosen(document, "#catalog-size")).toBe("EMG");
  });

  test("All in the size card stays the card's own even when a recording type is named All", async () => {
    const payload = payloadWithExtraTypes();
    payload.modalities[0] = { ...payload.modalities[0] };
    payload.modalities.push({ ...structuredClone(payload.modalities[1]), modality: "All" });
    const { document } = await open({ payload });
    expect(chosen(document, "#channel-hours")).toBe("EEG");
    tabIn(document, "#catalog-size", "MEG").click();
    tabIn(document, "#catalog-size", "All").click();
    // The explorer's own All tab is a different thing and stays unchosen.
    expect(chosen(document, "#channel-hours")).toBe("MEG");
    expect(chosen(document, "#catalog-size")).toBe("All");
  });

  test("a type the catalog is not grouped by (ECG, MISC) shows All and says why", async () => {
    const { document, errors } = await open({ payload: payloadWithExtraTypes() });
    tabIn(document, "#channel-hours", "ECG").click();
    expect(chosen(document, "#catalog-size")).toBe("All");
    expect(sizeTone(document)).toBeNull();
    expect(note(document)).toBe("Datasets are not grouped by ECG, so all datasets are shown.");
    tabIn(document, "#channel-hours", "MISC").click();
    expect(note(document)).toBe("Datasets are not grouped by MISC, so all datasets are shown.");
    // A real type takes the note away; so does choosing a size tab.
    tabIn(document, "#channel-hours", "MEG").click();
    expect(note(document)).toBeNull();
    expect(chosen(document, "#catalog-size")).toBe("MEG");
    tabIn(document, "#channel-hours", "ECG").click();
    tabIn(document, "#catalog-size", "EEG").click();
    expect(chosen(document, "#channel-hours")).toBe("EEG");
    expect(note(document)).toBeNull();
    expect(errors).toEqual([]);
  });
});

describe("what a link to a view does to the size card", () => {
  test("a link to a type opens both on it", async () => {
    const { document } = await open({}, "#hours=emg:64");
    expect(chosen(document, "#channel-hours")).toBe("EMG");
    expect(chosen(document, "#catalog-size")).toBe("EMG");
    expect(sizeTone(document)).toBe("emg");
    expect(exploreTone(document)).toBe("emg");
  });

  test("a link to a type the catalog is not grouped by opens the size card on All, with the note", async () => {
    const { document } = await open({ payload: payloadWithExtraTypes() }, "#hours=ecg:8");
    expect(chosen(document, "#channel-hours")).toBe("ECG");
    expect(chosen(document, "#catalog-size")).toBe("All");
    expect(note(document)).toBe("Datasets are not grouped by ECG, so all datasets are shown.");
  });

  test("a link that names no view here leaves the size card on All", async () => {
    const { document } = await open({}, "#hours=zzz:8");
    expect(chosen(document, "#catalog-size")).toBe("All");
  });

  test("changing the address by hand moves the size card with the explorer", async () => {
    const { document, window } = await open();
    window.location.hash = "#hours=meg:8";
    await until(
      () => chosen(document, "#channel-hours") === "MEG",
      "the explorer to follow the address",
    );
    expect(chosen(document, "#catalog-size")).toBe("MEG");
  });

  test("a link into the explorer scrolls to it in its new place", async () => {
    const scrolled: string[] = [];
    await open({}, "#hours=meg:16", {
      beforeWrite: (window: { HTMLElement: { prototype: object } }) => {
        (window.HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView =
          function (this: { id: string }) {
            scrolled.push(this.id);
          };
      },
    });
    await until(() => scrolled.includes("recorded-hours"), "the page to scroll to the explorer");
  });
});

describe("the size card's tabs by keyboard", () => {
  test("arrows, Home and End move the choice, and the explorer with it", async () => {
    const { document, window } = await open();
    (q(document, "#size-tab-0") as unknown as { focus(): void }).focus();
    const press = (name: string) => key(document, window, "#catalog-size [role=tablist]", name);
    const focused = () => (document.activeElement as unknown as { id: string }).id;
    press("ArrowRight");
    expect(focused()).toBe("size-tab-1");
    expect(chosen(document, "#catalog-size")).toBe("EEG");
    press("ArrowRight");
    expect(chosen(document, "#catalog-size")).toBe("MEG");
    expect(chosen(document, "#channel-hours")).toBe("MEG");
    press("End");
    expect(focused()).toBe("size-tab-4");
    expect(chosen(document, "#channel-hours")).toBe("EMG");
    press("ArrowRight");
    expect(focused()).toBe("size-tab-0");
    expect(chosen(document, "#catalog-size")).toBe("All");
    // All moves nothing else.
    expect(chosen(document, "#channel-hours")).toBe("EMG");
    press("ArrowLeft");
    expect(focused()).toBe("size-tab-4");
    press("Home");
    expect(chosen(document, "#catalog-size")).toBe("All");
    // One tab is in the tab order at a time.
    expect(all(document, "#catalog-size [role=tab][tabindex='0']")).toHaveLength(1);
  });

  test("the choice is announced politely, once, for the reader who changed it", async () => {
    const { document } = await open();
    tabIn(document, "#catalog-size", "iEEG").click();
    expect(text(document, "#size-panel [aria-live=polite]")).toBe("Showing iEEG datasets by size.");
    tabIn(document, "#catalog-size", "All").click();
    expect(text(document, "#size-panel [aria-live=polite]")).toBe("Showing all datasets by size.");
  });
});

describe("the tooltip names the type", () => {
  // Without a resize observer the page draws at once, so the chart has bars.
  test("on a type's histogram it speaks of that type's datasets; on All, of the catalog", async () => {
    const { document } = await open({}, "", { withoutResizeObserver: true });
    const tooltip = () => {
      (
        q(document, "#catalog-size .size-block:not([hidden]) .chart") as unknown as {
          focus(): void;
        }
      ).focus();
      return text(document, "#catalog-size .size-block:not([hidden]) .chart-tooltip");
    };
    expect(tooltip()).toContain("of the catalog");
    tabIn(document, "#catalog-size", "EEG").click();
    // The type's chart is built when its tab is first chosen, and drawn a frame later.
    await until(
      () => document.querySelector("#catalog-size .size-block:not([hidden]) svg") !== null,
      "the EEG histogram",
    );
    const eeg = tooltip();
    expect(eeg).toContain("of EEG datasets");
    expect(eeg).toMatch(/EEG datasets?/);
    expect(
      q(document, "#catalog-size .size-block:not([hidden]) .chart").getAttribute("aria-label"),
    ).toBe("Public EEG datasets by size, 23 log-scaled bins");
  });
});

describe("the size card without the explorer", () => {
  test("its tabs still work when there are no recorded hours to move", async () => {
    const { document, errors } = await open({ recordings: "none" });
    tabIn(document, "#catalog-size", "MEG").click();
    expect(chosen(document, "#catalog-size")).toBe("MEG");
    expect(sizeTone(document)).toBe("meg");
    tabIn(document, "#catalog-size", "All").click();
    expect(sizeTone(document)).toBeNull();
    expect(errors).toEqual([]);
  });
});

describe("when the snapshot cannot be shown", () => {
  test("an error that replaces the drawn catalog takes the size card with it", async () => {
    // The catalog draws first; the rolling-usage section after it cannot be
    // drawn (a breakdown row that is not a row), so the page replaces the
    // catalog with its error and must not leave the size card behind.
    const snap = catalogSnapshot();
    snap.sections.push({
      key: "access",
      label: "Dataset reads",
      source: "analytics-engine",
      updated_at: new Date().toISOString(),
      metrics: [
        {
          key: "access.broken",
          label: "Broken",
          value: 1,
          unit: "count",
          severity: "info",
          breakdown: [null as never],
        },
      ],
    } as never);
    const { document, logged } = await openPage(null, "", { snapshotBody: snap });
    expect(logged.join(" ")).toContain("snapshot display failed");
    expect(text(document, "#catalog")).toContain("Could not display catalog figures");
    expect(document.querySelector("#catalog-size")?.childNodes.length).toBe(0);
  });

  test("the size card is cleared with the rest of the catalog, and returns on Try again", async () => {
    const { document } = await open({}, "", { failSnapshotOnce: true });
    expect(text(document, "#catalog")).toContain("Could not load catalog figures");
    expect(document.querySelector("#catalog-size")?.childNodes.length).toBe(0);
    click(document, "#catalog button");
    await until(() => document.querySelector("#catalog-size .size-card") !== null, "the size card");
    expect(all(document, "#catalog-size [role=tab]")).toHaveLength(5);
  });
});
