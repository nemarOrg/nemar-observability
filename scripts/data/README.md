# Country map source data

These checked-in Natural Earth GeoJSON files are the source for the embedded country map. The
dashboard serves the generated paths from its own Worker; it does not request tiles or map data
from a third-party host at runtime. Regeneration is offline:

```sh
bun run scripts/generate-world-map.ts
```

## Provenance

- `natural-earth-110m-admin-0-countries.geojson` is the complete 1:110m Admin 0 country file at
  [`geojson/ne_110m_admin_0_countries.geojson`](https://github.com/nvkelso/natural-earth-vector/blob/ca96624a56bd078437bca8184e78163e5039ad19/geojson/ne_110m_admin_0_countries.geojson)
  in Natural Earth's `nvkelso/natural-earth-vector` repository.
- `natural-earth-50m-small-country-supplement.geojson` is a six-feature subset of
  [`geojson/ne_50m_admin_0_countries.geojson`](https://github.com/nvkelso/natural-earth-vector/blob/ca96624a56bd078437bca8184e78163e5039ad19/geojson/ne_50m_admin_0_countries.geojson)
  from the same repository. It contains the features whose `ISO_A2_EH` codes are SG, HK, BH, MU,
  BB, and MT because those country shapes are absent from the 1:110m source.
- Both sources are pinned to commit `ca96624a56bd078437bca8184e78163e5039ad19`.
- Natural Earth states that its raster and vector map data are public domain:
  <https://www.naturalearthdata.com/about/terms-of-use/>.

SHA-256:

| File | SHA-256 |
| --- | --- |
| `natural-earth-110m-admin-0-countries.geojson` | `6866c877d39cba9c357620878839b336d569f8c662d3cfab4cb1dbe2d39c977f` |
| `natural-earth-50m-small-country-supplement.geojson` | `baeb2ca03d838fcc9f21ce2cf0d8303df37a9434daf884c50ecb4ddbc271155e` |

Réunion is reported separately by Cloudflare but is not a separate Natural Earth Admin 0 feature.
The generated map uses a point marker at 55.5°E, 21.1°S so its activity is not merged with France.
