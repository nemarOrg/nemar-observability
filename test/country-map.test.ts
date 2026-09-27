import { describe, expect, test } from "bun:test";
import { buildCountryNameIndex, normalizeCountryName } from "../src/lib/country-map";
import { WORLD_COUNTRY_CODES_BY_NAME, WORLD_COUNTRY_NAMES } from "../src/lib/world-map";

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
});
