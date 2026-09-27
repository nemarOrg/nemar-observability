import { geoEqualEarth, geoPath } from "d3-geo";

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
const countries = new Map<string, string>();

for (const feature of collection.features as CountryFeature[]) {
  const properties = feature.properties;
  const sourceCode = properties.ISO_A2_EH ?? properties.ISO_A2;
  if (typeof sourceCode !== "string") continue;
  const code = sourceCode.toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) continue;
  const shape = path(feature);
  if (shape) countries.set(code, shape);
}

const sorted = Object.fromEntries([...countries.entries()].sort(([a], [b]) => a.localeCompare(b)));
const output = `// Generated from Natural Earth 1:110m Admin 0 country boundaries (public domain).\n// Regenerate with: bun run scripts/generate-world-map.ts\nexport const WORLD_COUNTRY_PATHS: Record<string, string> = ${JSON.stringify(sorted)};\n`;
await Bun.write(new URL("../src/lib/world-map.ts", import.meta.url), output);
console.info(`Wrote ${countries.size} country paths from ${sourceUrl}`);
