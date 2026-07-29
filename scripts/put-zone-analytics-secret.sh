#!/usr/bin/env bash
# Install CF_ZONE_ANALYTICS_TOKEN on nemar-observability (prod + dev).
#
# The token needs BOTH:
#   Account -> Analytics -> Read        (Analytics Engine SQL API)
#   Zone    -> Analytics -> Read        (nemar.org, GraphQL httpRequests*Groups)
#
# Prompts once, verifies the token against the zone BEFORE writing it anywhere,
# and never echoes it or leaves it on disk. Run from the repo root:
#   ./scripts/put-zone-analytics-secret.sh
set -euo pipefail

ACCOUNT_ID=da8d7a2a8680dab01592bbbc6f67f12c
ZONE_ID=e684135de46029c91fd6c93715ace4ce

cd "$(dirname "$0")/.."

read -rsp "Paste CF_ZONE_ANALYTICS_TOKEN (input hidden): " TOKEN
echo
[ -n "$TOKEN" ] || { echo "Empty token, aborting."; exit 1; }

# --- verify before writing -------------------------------------------------
# A wrong-scope token is silently useless once it is a secret (the section just
# reports "unavailable"), so prove both permissions here while we still hold the
# plaintext and can tell the user exactly which scope is missing.

echo "==> checking Zone Analytics: Read on nemar.org"
zone_probe=$(curl -s -X POST https://api.cloudflare.com/client/v4/graphql \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data @- <<EOF
{"query":"query(\$zone:String!){viewer{zones(filter:{zoneTag:\$zone}){httpRequests1dGroups(limit:1,filter:{date_geq:\"2026-07-01\"}){sum{requests}}}}}","variables":{"zone":"$ZONE_ID"}}
EOF
)
if echo "$zone_probe" | grep -q '"errors":\[{'; then
  echo "FAILED. Zone analytics rejected the token:"
  echo "$zone_probe" | python3 -c 'import json,sys;[print("  -",e["message"]) for e in json.load(sys.stdin)["errors"]]'
  echo "Add Zone -> Analytics -> Read for nemar.org and re-run."
  exit 1
fi
echo "    ok"

echo "==> checking Account Analytics: Read (Analytics Engine SQL)"
ae_probe=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/analytics_engine/sql" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: text/plain" \
  --data-binary "SELECT COUNT() AS n FROM nemar_access_metrics WHERE timestamp > NOW() - INTERVAL '1' DAY")
if [ "$ae_probe" != "200" ]; then
  echo "WARNING: Analytics Engine SQL returned HTTP $ae_probe."
  echo "The zone section will work, but this token cannot replace CF_ANALYTICS_TOKEN."
else
  echo "    ok (this token could also serve as CF_ANALYTICS_TOKEN)"
fi

# --- write -----------------------------------------------------------------
put() {
  printf '%s' "$TOKEN" | env -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID" \
    npx cfman wrangler --account sccn secret put CF_ZONE_ANALYTICS_TOKEN -c wrangler.toml "$@"
}

echo "==> writing secret to nemar-observability (prod)"
put
echo "==> writing secret to nemar-observability-dev"
put --env dev

unset TOKEN
echo
echo "Done. Verify with:"
echo "  npx cfman wrangler --account sccn secret list -c wrangler.toml"
