// The recording-type colors and the tab strip the two modality selectors share.
// The token values are the NEMAR website's (website/src/styles/tokens.css,
// "Modality - recording technique. Doubles as chart fills"), written out here
// so a drift from them fails; the page tests run the real page script in a real
// DOM (see test/helpers/hours-page.ts).

import { afterEach, describe, expect, test } from "bun:test";
import { MODALITY_JS } from "../src/routes/dashboard/modality";
import { renderDashboardPage } from "../src/routes/ui";
import {
  all,
  closePages,
  openPage,
  payloadWithExtraTypes,
  q,
  recordingsSection,
  text,
} from "./helpers/hours-page";

afterEach(closePages);

const LIGHT = {
  eeg: "#2563eb",
  meg: "#7c3aed",
  ieeg: "#db2777",
  emg: "#ea580c",
  nirs: "#0891b2",
  motion: "#16a34a",
  other: "#64748b",
};
const DARK = {
  eeg: "#60a5fa",
  meg: "#a78bfa",
  ieeg: "#f472b6",
  emg: "#fb923c",
  nirs: "#22d3ee",
  motion: "#34d399",
  other: "#94a3b8",
};
const TONES = Object.keys(LIGHT) as (keyof typeof LIGHT)[];

const html = renderDashboardPage();
const css = html.slice(html.indexOf("<style>") + 7, html.indexOf("</style>"));
/** The declarations of the first rule that starts with this text. */
function rule(start: string): string {
  const at = css.indexOf(start);
  expect(at).toBeGreaterThan(-1);
  return css.slice(at, css.indexOf("}", at));
}
const tokens = (block: string) =>
  Object.fromEntries(
    [...block.matchAll(/--modality-(\w+):\s*(#[0-9a-f]{6});/g)].map((m) => [m[1], m[2]]),
  );

describe("modality color tokens", () => {
  test("light values are the website's, on bare :root", () => {
    expect(tokens(rule(":root {\n  color-scheme: light;"))).toEqual(LIGHT);
  });

  test("dark values are the website's, under the OS setting and under an explicit pick", () => {
    expect(tokens(rule(':root:not([data-theme="light"]) {'))).toEqual(DARK);
    expect(tokens(rule(':root[data-theme="dark"] {'))).toEqual(DARK);
  });

  // The colors are marks (underline, bars, meter, slider), which need 3:1 against
  // the surface they sit on; the card surface is white in light and #111d36 in dark.
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a: string, b: string) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };

  test("every color keeps 3:1 against its card surface in both themes", () => {
    expect(rule(":root {\n  color-scheme: light;")).toContain("--surface: #ffffff;");
    expect(rule(':root[data-theme="dark"] {')).toContain("--surface: #111d36;");
    for (const tone of TONES) {
      expect(contrast(LIGHT[tone], "#ffffff")).toBeGreaterThanOrEqual(3);
      expect(contrast(DARK[tone], "#111d36")).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("tones in the stylesheet", () => {
  test("every tone maps to its token", () => {
    for (const tone of TONES) {
      expect(css).toContain(`[data-tone="${tone}"] { --tone: var(--modality-${tone}); }`);
    }
  });

  test("a card with a tone draws its accent in it", () => {
    expect(css).toContain(
      ".hours-card[data-tone], .size-card[data-tone] { --accent: var(--tone); }",
    );
    // The chosen tab's underline and each tab's dot use the tab's own tone.
    expect(css).toContain(
      '.hours-tab[aria-selected="true"] { color: var(--text); border-bottom-color: var(--tone, var(--accent)); }',
    );
    expect(css).toMatch(
      /\.hours-tab\[data-tone\] \.hours-tab-name::before \{[^}]*background: var\(--tone\)/,
    );
  });

  test("the tinted parts keep the blue tint as the fallback for a browser without color-mix", () => {
    for (const selector of [".hours-band", ".hours-meter", ".hours-table .hours-cut td"]) {
      const at = css.indexOf(`.hours-card[data-tone] ${selector} {`);
      expect(at).toBeGreaterThan(-1);
      const declarations = css.slice(at, css.indexOf("}", at));
      expect(declarations.indexOf("var(--")).toBeGreaterThan(-1);
      expect(declarations.indexOf("color-mix")).toBeGreaterThan(declarations.indexOf("var(--"));
    }
  });
});

describe("modalityTone", () => {
  const modalityTone = new Function(`${MODALITY_JS}; return modalityTone;`)() as (
    key: unknown,
  ) => string;

  test("the types the website colors keep their name, whatever the case", () => {
    for (const [given, expected] of [
      ["EEG", "eeg"],
      ["eeg", "eeg"],
      ["iEEG", "ieeg"],
      ["IEEG", "ieeg"],
      ["MEG", "meg"],
      ["EMG", "emg"],
      ["nirs", "nirs"],
      ["Motion", "motion"],
    ]) {
      expect(modalityTone(given)).toBe(expected);
    }
  });

  test("anything else is other, as is a missing name", () => {
    for (const given of ["ECG", "MISC", "", null, undefined, "eeg ", 7]) {
      expect(modalityTone(given)).toBe("other");
    }
  });
});

describe("the explorer in the page", () => {
  const selected = (document: Parameters<typeof q>[0]) =>
    q(document, "#channel-hours [role=tab][aria-selected=true]");

  test("each tab carries its type's tone, and unknown types are other", async () => {
    const { document } = await openPage(
      recordingsSection(true, { payload: payloadWithExtraTypes() }),
    );
    const tones = Object.fromEntries(
      all(document, "#channel-hours [role=tab]").map((t) => [
        text(document, `#${t.id} .hours-tab-name`),
        t.getAttribute("data-tone"),
      ]),
    );
    expect(tones).toEqual({
      EEG: "eeg",
      EMG: "emg",
      ECG: "other",
      MISC: "other",
      iEEG: "ieeg",
      MEG: "meg",
    });
  });

  test("the card takes the chosen tab's tone, and follows it as the tab changes", async () => {
    const { document, errors } = await openPage(
      recordingsSection(true, { payload: payloadWithExtraTypes() }),
    );
    const card = () => q(document, ".hours-card").getAttribute("data-tone");
    expect(card()).toBe("eeg");
    for (const [name, tone] of [
      ["iEEG", "ieeg"],
      ["MEG", "meg"],
      ["EMG", "emg"],
      ["ECG", "other"],
      ["MISC", "other"],
      ["EEG", "eeg"],
    ]) {
      const tab = all(document, "#channel-hours [role=tab]").find(
        (t) => text(document, `#${t.id} .hours-tab-name`) === name,
      );
      (tab as unknown as { click(): void }).click();
      expect(text(document, `#${selected(document).id} .hours-tab-name`)).toBe(name);
      expect(card()).toBe(tone);
    }
    expect(errors).toEqual([]);
  });

  test("a link to a type opens the card in that type's tone", async () => {
    const { document } = await openPage(recordingsSection(), "#hours=meg:8");
    expect(q(document, ".hours-card").getAttribute("data-tone")).toBe("meg");
  });
});
