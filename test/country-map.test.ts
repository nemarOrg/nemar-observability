import { describe, expect, test } from "bun:test";
import { buildCountryNameIndex, normalizeCountryName } from "../src/lib/country-map";
import {
  WORLD_COUNTRY_CODES_BY_NAME,
  WORLD_COUNTRY_MARKERS,
  WORLD_COUNTRY_NAMES,
  WORLD_COUNTRY_PATHS,
} from "../src/lib/world-map";

describe("country map labels", () => {
  test("matches Umami country names to map country codes", () => {
    const namesByCode = buildCountryNameIndex(WORLD_COUNTRY_NAMES);

    expect(namesByCode[normalizeCountryName("United States")]).toBe("US");
    expect(namesByCode[normalizeCountryName("China")]).toBe("CN");
    expect(WORLD_COUNTRY_CODES_BY_NAME).toEqual(namesByCode);
  });

  test("normalizes diacritics and punctuation consistently", () => {
    expect(normalizeCountryName("Côte d’Ivoire")).toBe(normalizeCountryName("Cote d'Ivoire"));
  });

  test("includes small countries omitted from the base map and marks Réunion separately", () => {
    const namesByCode = buildCountryNameIndex(WORLD_COUNTRY_NAMES);
    for (const code of ["SG", "HK", "BH", "MU", "BB", "MT"]) {
      expect(WORLD_COUNTRY_PATHS[code]).toBeTruthy();
      const name = WORLD_COUNTRY_NAMES[code]?.[0];
      expect(name).toBeTruthy();
      if (name) expect(namesByCode[normalizeCountryName(name)]).toBe(code);
    }

    expect(namesByCode[normalizeCountryName("Réunion")]).toBe("RE");
    const reunion = WORLD_COUNTRY_MARKERS.RE;
    expect(reunion?.every(Number.isFinite)).toBe(true);
    if (reunion) {
      expect(reunion[0]).toBeGreaterThanOrEqual(0);
      expect(reunion[0]).toBeLessThanOrEqual(1000);
      expect(reunion[1]).toBeGreaterThanOrEqual(0);
      expect(reunion[1]).toBeLessThanOrEqual(500);
    }
  });
});
