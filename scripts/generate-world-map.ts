import { geoEqualEarth, geoPath } from "d3-geo";
import { buildCountryNameIndex } from "../src/lib/country-map";

type CountryFeature = GeoJSON.Feature<GeoJSON.Geometry, Record<string, unknown>>;
const EXPECTED_BASE_FEATURE_COUNT = 177;
const EXPECTED_BASE_COUNTRY_COUNT = 175;
const REQUIRED_SUPPLEMENT_COUNTRY_CODES = ["BB", "BH", "HK", "MT", "MU", "SG"] as const;
const collection = (await Bun.file(
  new URL("./data/natural-earth-110m-admin-0-countries.geojson", import.meta.url),
).json()) as GeoJSON.FeatureCollection<GeoJSON.Geometry, Record<string, unknown>>;
const detailCollection = (await Bun.file(
  new URL("./data/natural-earth-50m-small-country-supplement.geojson", import.meta.url),
).json()) as GeoJSON.FeatureCollection<GeoJSON.Geometry, Record<string, unknown>>;
const projection = geoEqualEarth().fitExtent(
  [
    [8, 8],
    [992, 492],
  ],
  collection,
);
const path = geoPath(projection).digits(2);
const countries = new Map<string, { path: string; names: string[] }>();

function countryCode(feature: CountryFeature): string | null {
  const sourceCode = feature.properties.ISO_A2_EH ?? feature.properties.ISO_A2;
  if (typeof sourceCode !== "string") return null;
  const code = sourceCode.toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

function assertSourceContract(): void {
  if (collection.features.length !== EXPECTED_BASE_FEATURE_COUNT) {
    throw new Error(
      `Expected ${EXPECTED_BASE_FEATURE_COUNT} Natural Earth 1:110m features, found ${collection.features.length}.`,
    );
  }
  const baseCodes = collection.features
    .map((feature) => countryCode(feature as CountryFeature))
    .filter((code): code is string => code !== null);
  if (new Set(baseCodes).size !== EXPECTED_BASE_COUNTRY_COUNT) {
    throw new Error(
      `Expected ${EXPECTED_BASE_COUNTRY_COUNT} distinct coded Natural Earth 1:110m countries, found ${new Set(baseCodes).size}.`,
    );
  }

  const supplementCodes = detailCollection.features
    .map((feature) => countryCode(feature as CountryFeature))
    .filter((code): code is string => code !== null);
  const actual = new Set(supplementCodes);
  const required = new Set<string>(REQUIRED_SUPPLEMENT_COUNTRY_CODES);
  const missing = [...required].filter((code) => !actual.has(code));
  const unexpected = [...actual].filter((code) => !required.has(code));
  if (
    detailCollection.features.length !== REQUIRED_SUPPLEMENT_COUNTRY_CODES.length ||
    missing.length > 0 ||
    unexpected.length > 0
  ) {
    throw new Error(
      `Natural Earth 1:50m supplement mismatch. Missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"}.`,
    );
  }
}

function countryNames(feature: CountryFeature): string[] {
  const properties = feature.properties;
  return [
    properties.NAME_LONG,
    properties.NAME,
    properties.ADMIN,
    properties.BRK_NAME,
    properties.NAME_CIAWF,
    properties.FORMAL_EN,
    properties.NAME_EN,
  ]
    .filter((name): name is string => typeof name === "string" && name.trim().length > 0)
    .map((name) => name.trim())
    .filter((name, index, all) => all.indexOf(name) === index);
}

function addCountry(feature: CountryFeature): void {
  const code = countryCode(feature);
  if (!code || countries.has(code)) return;
  const shape = path(feature);
  if (!shape) return;
  countries.set(code, { path: shape, names: countryNames(feature) });
}

assertSourceContract();
for (const feature of collection.features as CountryFeature[]) addCountry(feature);
if (countries.size !== EXPECTED_BASE_COUNTRY_COUNT) {
  throw new Error(
    `Expected ${EXPECTED_BASE_COUNTRY_COUNT} drawable base countries, found ${countries.size}.`,
  );
}

// The 1:110m dataset omits several small countries at world-map scale. Add only
// their detailed paths, preserving the compact 1:110m baseline for other shapes.
for (const feature of detailCollection.features as CountryFeature[]) addCountry(feature);
const missingSupplementPaths = REQUIRED_SUPPLEMENT_COUNTRY_CODES.filter(
  (code) => !countries.has(code),
);
if (missingSupplementPaths.length > 0) {
  throw new Error(`Missing required small-country paths: ${missingSupplementPaths.join(", ")}.`);
}

// Réunion is reported separately by Cloudflare but Natural Earth includes it as
// part of France. Give that location a generated point marker without merging
// its counts into France.
const markerLocations = new Map<string, { coordinates: [number, number]; names: string[] }>([
  ["RE", { coordinates: [55.5, -21.1], names: ["Réunion"] }],
]);
const markers = new Map(
  [...markerLocations].map(([code, location]) => {
    const coordinates = projection(location.coordinates);
    if (!coordinates) throw new Error(`Could not project the ${code} map marker.`);
    return [code, coordinates] as const;
  }),
);

const sortedCountries = [...countries.entries()].sort(([a], [b]) => a.localeCompare(b));
const paths = sortedCountries
  .map(([code, country]) => `  ${code}: ${JSON.stringify(country.path)},`)
  .join("\n");
const namesByCode: Record<string, string[]> = Object.fromEntries(
  sortedCountries.map(([code, country]) => [code, country.names]),
);
for (const [code, location] of markerLocations) namesByCode[code] = location.names;
const sortedNames = Object.entries(namesByCode).sort(([a], [b]) => a.localeCompare(b));
const names = sortedNames
  .map(([code, countryNames]) => `  ${code}: ${JSON.stringify(countryNames)},`)
  .join("\n");
const markerEntries = [...markers.entries()].sort(([a], [b]) => a.localeCompare(b));
const markerOutput = markerEntries
  .map(([code, coordinates]) => `  ${code}: ${JSON.stringify(coordinates)},`)
  .join("\n");
const codesByName = Object.entries(buildCountryNameIndex(namesByCode))
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([name, code]) => `  ${JSON.stringify(name)}: ${JSON.stringify(code)},`)
  .join("\n");
const output = `// Generated from Natural Earth 1:110m and 1:50m Admin 0 country boundaries (public domain),\n// plus explicit location markers defined in this generator.\n// Regenerate with: bun run scripts/generate-world-map.ts\nexport const WORLD_COUNTRY_PATHS: Record<string, string> = {\n${paths}\n};\n\nexport const WORLD_COUNTRY_NAMES: Record<string, string[]> = {\n${names}\n};\n\nexport const WORLD_COUNTRY_MARKERS: Record<string, [number, number]> = {\n${markerOutput}\n};\n\nexport const WORLD_COUNTRY_CODES_BY_NAME: Record<string, string> = {\n${codesByName}\n};\n`;
const outputPath = new URL("../src/lib/world-map.ts", import.meta.url);
await Bun.write(outputPath, output);
const formatter = Bun.spawn(["bun", "run", "biome", "format", "--write", outputPath.pathname], {
  stdout: "inherit",
  stderr: "inherit",
});
if ((await formatter.exited) !== 0) throw new Error("Biome could not format the generated map.");
console.info(
  `Wrote ${countries.size} country paths and ${markers.size} location markers from checked-in Natural Earth data.`,
);
