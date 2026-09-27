import { geoEqualEarth, geoPath } from "d3-geo";
import { buildCountryNameIndex } from "../src/lib/country-map";

const sourceUrl =
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/ca96624a56bd078437bca8184e78163e5039ad19/geojson/ne_110m_admin_0_countries.geojson";
const response = await fetch(sourceUrl);
if (!response.ok) throw new Error(`Natural Earth map source returned HTTP ${response.status}`);

type CountryFeature = GeoJSON.Feature<GeoJSON.Geometry, Record<string, unknown>>;
const collection = (await response.json()) as GeoJSON.FeatureCollection<
  GeoJSON.Geometry,
  Record<string, unknown>
>;
const projection = geoEqualEarth().fitExtent(
  [
    [8, 8],
    [992, 492],
  ],
  collection,
);
const path = geoPath(projection).digits(2);
const countries = new Map<string, { path: string; names: string[] }>();

for (const feature of collection.features as CountryFeature[]) {
  const properties = feature.properties;
  const sourceCode = properties.ISO_A2_EH ?? properties.ISO_A2;
  if (typeof sourceCode !== "string") continue;
  const code = sourceCode.toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) continue;
  const shape = path(feature);
  if (!shape) continue;
  const names = [
    properties.NAME_LONG,
    properties.NAME,
    properties.ADMIN,
    properties.BRK_NAME,
    properties.NAME_CIAWF,
    properties.FORMAL_EN,
    properties.NAME_EN,
  ].filter((name): name is string => typeof name === "string" && name.trim().length > 0);
  countries.set(code, { path: shape, names: [...new Set(names.map((name) => name.trim()))] });
}

const sortedCountries = [...countries.entries()].sort(([a], [b]) => a.localeCompare(b));
const paths = sortedCountries
  .map(([code, country]) => `  ${code}: ${JSON.stringify(country.path)},`)
  .join("\n");
const names = sortedCountries
  .map(([code, country]) => `  ${code}: ${JSON.stringify(country.names)},`)
  .join("\n");
const countryNamesByCode = Object.fromEntries(
  sortedCountries.map(([code, country]) => [code, country.names]),
);
const codesByName = Object.entries(buildCountryNameIndex(countryNamesByCode))
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([name, code]) => `  ${JSON.stringify(name)}: ${JSON.stringify(code)},`)
  .join("\n");
const output = `// Generated from Natural Earth 1:110m Admin 0 country boundaries (public domain).\n// Regenerate with: bun run scripts/generate-world-map.ts\nexport const WORLD_COUNTRY_PATHS: Record<string, string> = {\n${paths}\n};\n\nexport const WORLD_COUNTRY_NAMES: Record<string, string[]> = {\n${names}\n};\n\nexport const WORLD_COUNTRY_CODES_BY_NAME: Record<string, string> = {\n${codesByName}\n};\n`;
const outputPath = new URL("../src/lib/world-map.ts", import.meta.url);
await Bun.write(outputPath, output);
const formatter = Bun.spawn(["bun", "run", "biome", "format", "--write", outputPath.pathname], {
  stdout: "inherit",
  stderr: "inherit",
});
if ((await formatter.exited) !== 0) throw new Error("Biome could not format the generated map.");
console.info(`Wrote ${countries.size} country paths from ${sourceUrl}`);
