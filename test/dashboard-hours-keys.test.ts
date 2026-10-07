// The explorer's keyboard, ARIA state, links, and edge cases in the real page.
// Expected values come from the channel-hours fixture.

import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { CHANNELS_JS } from "../src/routes/dashboard/channels";
import { CHARTS_JS } from "../src/routes/dashboard/charts";
import { CLIENT_JS } from "../src/routes/dashboard/client";
import { CORE_JS } from "../src/routes/dashboard/core";
import { EXPLORER_JS } from "../src/routes/dashboard/explorer";
import { FORMAT_JS } from "../src/routes/dashboard/format";
import { MODEL_JS } from "../src/routes/dashboard/model";
import { OVERVIEW_JS } from "../src/routes/dashboard/overview";
import { RANGE_JS } from "../src/routes/dashboard/range";
import { REACH_JS } from "../src/routes/dashboard/reach";
import { SCALE_JS } from "../src/routes/dashboard/scale";
import { SERIES_JS } from "../src/routes/dashboard/series";
import { SNAPSHOT_JS } from "../src/routes/dashboard/snapshot";
import { THEME_JS } from "../src/routes/dashboard/theme";
import { USAGE_JS } from "../src/routes/dashboard/usage";
import { renderDashboardPage } from "../src/routes/ui";
import sample from "./fixtures/channel-hours.sample.json";
import snapshotFixture from "./fixtures/snapshot-2026-09-28.json";
import { PURE_MODULES, clientLogic } from "./helpers/client-logic";
import {
  ORIGIN,
  type Payload,
  all,
  at,
  closePages,
  eeg,
  key,
  openPage,
  q,
  readout,
  recordingsSection,
  text,
  until,
} from "./helpers/hours-page";

afterEach(closePages);

const selectedTab = (doc: Window["document"]) =>
  text(doc, '[role=tab][aria-selected="true"] .hours-tab-name');
const live = (doc: Window["document"]) => text(doc, ".hours-chart .sr-only[aria-live]");

describe("the chart from the keyboard", () => {
  test("arrow keys, Home, End, and Escape read the bars", async () => {
    const { window, document } = await openPage(recordingsSection());
    const chart = document.querySelector(".hours-chart") as unknown as {
      focus(): void;
      getAttribute(name: string): string | null;
    };
    expect(chart.getAttribute("aria-label")).toBe(
      "Hours at each channel count, EEG, channel counts 1 to 512 on a doubling axis",
    );
    // Focus lands on the first counted bar: 16 channels.
    chart.focus();
    expect(live(document)).toBe(
      "16 channels. 2.5 hours. 25 recordings. Counted: 16 or more channels",
    );
    // Step right to 64 channels, the montage the owner asks about.
    const counts = eeg.bins.filter((b) => b.hours > 0).map((b) => b.channels);
    for (let i = counts.indexOf(16); i < counts.indexOf(64); i++)
      key(document, window, ".hours-chart", "ArrowRight");
    expect(live(document)).toBe(
      "64 channels. 146.5 hours. 811 recordings. Counted: 16 or more channels",
    );
    key(document, window, ".hours-chart", "Home");
    expect(live(document)).toBe("2 channels. 837.9 hours. 58 recordings. Below 16 channels");
    key(document, window, ".hours-chart", "End");
    expect(live(document)).toBe(
      "257 channels. 3.6 hours. 24 recordings. Counted: 16 or more channels",
    );
    expect(q(document, ".hours-chart .chart-tooltip").getAttribute("class")).toContain("visible");
    key(document, window, ".hours-chart", "Escape");
    expect(q(document, ".hours-chart .chart-tooltip").getAttribute("class")).not.toContain(
      "visible",
    );
  });

  test("at any number of channels every bar is counted, and the label follows the view", async () => {
    const { window, document } = await openPage(recordingsSection(), "#hours=emg:1:datasets");
    const chart = document.querySelector(".hours-chart") as unknown as {
      focus(): void;
      getAttribute(name: string): string | null;
    };
    expect(chart.getAttribute("aria-label")).toBe(
      "Datasets by their largest channel count, EMG, channel counts 1 to 512 on a doubling axis",
    );
    chart.focus();
    expect(live(document)).toBe(
      "Largest recording: 16 channels. 3 datasets. Counted: any number of channels",
    );
    key(document, window, ".hours-chart", "ArrowRight");
    expect(live(document)).toBe(
      "Largest recording: 32 channels. 1 dataset. Counted: any number of channels",
    );
  });
});

describe("the slider from the keyboard", () => {
  test("from Home, Arrow Right visits every power of two and every count that occurs", async () => {
    const { window, document } = await openPage(recordingsSection());
    key(document, window, "#hours-min", "Home");
    const visited = [1];
    for (let i = 0; i < 80; i++) {
      key(document, window, "#hours-min", "ArrowRight");
      const shown = Number((readout(document).slider ?? "").replace(/,/g, "").split(" ")[0]);
      if (shown === visited[visited.length - 1]) break;
      visited.push(shown);
    }
    const counts = eeg.bins.map((b) => b.channels);
    const powers = [1, 2, 4, 8, 16, 32, 64, 128, 256];
    expect(visited).toEqual([...new Set([...powers, ...counts])].sort((a, b) => a - b));
    // Arrow Up is Arrow Right; Arrow Down and Page Down step back.
    key(document, window, "#hours-min", "PageDown");
    expect(readout(document).claim).toBe("of EEG recorded with 256 or more channels");
    key(document, window, "#hours-min", "ArrowDown");
    expect(readout(document).claim).toBe("of EEG recorded with 144 or more channels");
    key(document, window, "#hours-min", "ArrowUp");
    expect(readout(document).claim).toBe("of EEG recorded with 256 or more channels");
    key(document, window, "#hours-min", "PageDown");
    expect(readout(document).claim).toBe("of EEG recorded with 128 or more channels");
  });
});

describe("tabs and toggles", () => {
  test("Arrow Left wraps to the last tab, Home returns to the first, and ARIA follows", async () => {
    const { window, document } = await openPage(recordingsSection());
    const pressed = () =>
      all(document, "[data-measure]").map((b) => b.getAttribute("aria-pressed"));
    const tabindex = () => all(document, "[role=tab]").map((t) => t.getAttribute("tabindex"));
    expect(pressed()).toEqual(["true", "false", "false"]);
    expect(tabindex()).toEqual(["0", "-1", "-1", "-1"]);
    q(document, "#hours-tab-0").focus();
    key(document, window, "[role=tablist]", "ArrowLeft");
    expect(selectedTab(document)).toBe("MEG");
    expect(document.activeElement?.id).toBe("hours-tab-3");
    key(document, window, "[role=tablist]", "Home");
    expect(selectedTab(document)).toBe("EEG");
    key(document, window, "[role=tablist]", "ArrowRight");
    expect(tabindex()).toEqual(["-1", "0", "-1", "-1"]);
    q(document, '[data-measure="datasets"]').click();
    expect(pressed()).toEqual(["false", "false", "true"]);
  });

  test("the Recordings toggle counts recordings", async () => {
    const { document } = await openPage(recordingsSection());
    q(document, '[data-measure="recordings"]').click();
    const want = at(eeg, 16);
    expect(readout(document).value).toBe(`${want.recordings.toLocaleString("en-US")} recordings`);
    expect(readout(document).claim).toBe("of EEG with 16 or more channels");
    expect(readout(document).slider).toBe(
      `16 or more channels: ${want.recordings.toLocaleString("en-US")} recordings`,
    );
    expect(text(document, ".hours-plot-title")).toBe("Recordings at each channel count");
  });
});

describe("links after the page has loaded", () => {
  test("a new #hours= address switches the view, clamps, or says it is not available", async () => {
    const { window, document } = await openPage(recordingsSection());
    const go = async (hash: string) => {
      window.location.hash = hash;
      await Bun.sleep(30);
    };
    await go("#hours=emg:32");
    expect(selectedTab(document)).toBe("EMG");
    expect(readout(document).claim).toBe("of EMG recorded with 32 or more channels");
    expect(text(document, ".hours-notices")).toBe("");
    await go("#hours=eeg:999999");
    expect(readout(document).claim).toBe("of EEG recorded with 512 or more channels");
    expect(text(document, ".hours-notices")).toBe(
      "This link's view is not available. Showing EEG, 512 or more channels.",
    );
    for (const bad of ["#hours=eeg:0", "#hours=eeg:16:bytes"]) {
      await go(bad);
      expect(text(document, ".hours-notices")).toBe(
        "This link's view is not available. Showing EEG, 512 or more channels.",
      );
      expect(window.location.hash).toBe("#hours=eeg:512");
    }
  });
});

describe("payloads the checks refuse", () => {
  test("a malformed payload shows an error in the explorer and the rest of the page still draws", async () => {
    const snap = structuredClone(snapshotFixture.response) as { sections: unknown[] };
    const corrupt = structuredClone(sample);
    corrupt.modalities[0].bins.reverse();
    snap.sections.push({ ...recordingsSection(true), channel_hours: corrupt });
    const { document, errors } = await openPage(null, "", { snapshotBody: snap });
    expect(text(document, "#channel-hours")).toContain("Could not display recorded hours");
    expect(document.querySelector("#channel-hours [role=tablist]")).toBeNull();
    await until(() => text(document, "#catalog").includes("Recording modality"), "the catalog");
    expect(document.getElementById("card-zarr")).not.toBeNull();
    expect(errors).toEqual([]);
  });

  // The checks refuse markup and punctuation in names, so this goes straight
  // to the drawing step with a payload built outside the schema, to show the
  // drawing is safe on its own: names reach only textContent and an encoded
  // address. The page's script runs as it would, minus the start-up requests.
  const BOOT_FREE = [
    FORMAT_JS,
    RANGE_JS,
    THEME_JS,
    SERIES_JS,
    MODEL_JS,
    CHANNELS_JS,
    SCALE_JS,
    CORE_JS,
    CHARTS_JS,
    USAGE_JS,
    REACH_JS,
    EXPLORER_JS,
    SNAPSHOT_JS,
    OVERVIEW_JS,
  ].join("\n");
  async function drawDirectly(payload: Payload, hash = "") {
    const found = { state: "ok", section: { updated_at: new Date().toISOString() }, payload };
    const call = `drawRecordedHours(document.getElementById("channel-hours"), ${JSON.stringify(found)});`;
    const window = new Window({
      url: `${ORIGIN}/observability${hash}`,
      settings: { enableJavaScriptEvaluation: true } as never,
    });
    const html = renderDashboardPage().replace(CLIENT_JS, `${BOOT_FREE}\n${call}`);
    expect(html).toContain("drawRecordedHours(document");
    window.document.write(html);
    await until(() => window.document.getElementById("hours-panel") !== null, "the explorer");
    return window;
  }
  const hostile = () => {
    const p = structuredClone(sample);
    p.modalities[1].modality = "a:b%#c";
    p.modalities[2].modality = "<img src=x onerror=alert(1)>";
    return p;
  };

  test("hostile names are drawn as text and survive the address", async () => {
    const window = await drawDirectly(hostile());
    const doc = window.document;
    try {
      expect(doc.querySelectorAll("img")).toHaveLength(0);
      const names = all(doc, ".hours-tab-name").map((t) => t.textContent);
      expect(names).toContain("a:b%#c");
      expect(names).toContain("<img src=x onerror=alert(1)>");
      const tab = all(doc, "[role=tab]").find((t) => t.textContent?.startsWith("a:b%#c"));
      (tab as unknown as { click(): void }).click();
      await until(() => window.location.hash === "#hours=a%3Ab%25%23c:16", "the encoded address");
    } finally {
      await window.happyDOM.close();
    }
    const reopened = await drawDirectly(hostile(), "#hours=a%3Ab%25%23c:16");
    try {
      expect(selectedTab(reopened.document)).toBe("a:b%#c");
      expect(text(reopened.document, ".hours-notices")).toBe("");
    } finally {
      await reopened.happyDOM.close();
    }
  });
});

describe("edge cases in the data", () => {
  test("a modality whose recordings have no duration reads plainly", async () => {
    const payload = structuredClone(sample);
    const emg = payload.modalities.find((m) => m.modality === "EMG");
    if (!emg) throw new Error("fixture has no EMG");
    const zero = { ...structuredClone(emg), modality: "Zero" };
    for (const b of zero.bins) b.hours = 0;
    zero.hours = 0;
    payload.modalities.push(zero);
    const { document } = await openPage(recordingsSection(true, { payload }), "#hours=zero:16");
    expect(selectedTab(document)).toBe("Zero");
    expect(readout(document).value).toBe("0 hours");
    expect(readout(document).share).toBe(
      "These Zero recordings have no recorded duration, so there are no hours to compare.",
    );
    expect(text(document, "#recorded-hours")).not.toContain("NaN");
  });
});

describe("pure pieces", () => {
  const { axisMaxFor, channelStops, prepareModalities, measureFigure } = clientLogic([
    "axisMaxFor",
    "channelStops",
    "prepareModalities",
    "measureFigure",
  ]);

  test("the axis never shrinks below 512, and 256 channels fits inside it", () => {
    const emgOnly = {
      ...structuredClone(sample),
      modalities: sample.modalities.filter((m) => m.modality === "EMG"),
    };
    const emg = prepareModalities(emgOnly);
    expect(axisMaxFor(emg)).toBe(512);
    expect(channelStops(emg[0], 512).at(-1)).toBe(256);
    const at256 = structuredClone(emgOnly);
    at256.modalities[0].bins[1].channels = 256;
    at256.modalities[0].dataset_peaks[1].channels = 256;
    expect(axisMaxFor(prepareModalities(at256))).toBe(512);
  });

  test("equal hours are ordered by name", () => {
    const tied = structuredClone(sample);
    const emg = tied.modalities.find((m) => m.modality === "EMG");
    tied.modalities.push({
      ...structuredClone(emg),
      modality: "ECG",
    } as Payload["modalities"][number]);
    const names = prepareModalities(tied).map((m: { name: string }) => m.name);
    expect(names.indexOf("ECG")).toBe(names.indexOf("EMG") - 1);
  });

  test("one hour is singular", () => {
    expect(measureFigure("hours", 1)).toEqual({ number: "1", unit: "hour" });
  });

  test("the test helper runs every module the page runs", () => {
    for (const part of PURE_MODULES) expect(CLIENT_JS).toContain(part);
  });
});
