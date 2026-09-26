#!/usr/bin/env bash
set -euo pipefail

die() {
  printf '[s3-egress] ERROR: %s\n' "$*" >&2
  exit 2
}

if (($# != 1)); then
  die "usage: $0 /opt/nemar-observability/scripts/push-s3-egress.ts"
fi
COLLECTOR="$1"
EXPECTED_COLLECTOR="/opt/nemar-observability/scripts/push-s3-egress.ts"
[[ "$COLLECTOR" == "$EXPECTED_COLLECTOR" ]] || die "collector path must be $EXPECTED_COLLECTOR"
[ -r "$COLLECTOR" ] || die "collector script is not readable"

INFISICAL_CLI="${INFISICAL_CLI:-${HOME}/.local/bin/infisical}"
[ -x "$INFISICAL_CLI" ] || INFISICAL_CLI="$(command -v infisical 2>/dev/null || true)"
[ -n "$INFISICAL_CLI" ] && [ -x "$INFISICAL_CLI" ] || die "Infisical CLI is not executable"

BUN_BIN="${BUN_BIN:-${HOME}/.bun/bin/bun}"
[ -x "$BUN_BIN" ] || BUN_BIN="$(command -v bun 2>/dev/null || true)"
[ -n "$BUN_BIN" ] && [ -x "$BUN_BIN" ] || die "Bun is not executable"

TOKEN_FILE="${HOME}/.config/infisical/nemar-observability-egress.token"
if [ ! -f "$TOKEN_FILE" ] || [ -L "$TOKEN_FILE" ] || [ ! -r "$TOKEN_FILE" ]; then
  die "the scoped Infisical token must be a readable regular file"
fi
TOKEN_OWNER="$(stat -c '%u' -- "$TOKEN_FILE")"
TOKEN_MODE="$(stat -c '%a' -- "$TOKEN_FILE")"
[ "$TOKEN_OWNER" = "$(id -u)" ] || die "the Infisical token file must be owned by the current user"
[ "$TOKEN_MODE" = "600" ] || die "the Infisical token file must have mode 0600"

INFISICAL_TOKEN="$(<"$TOKEN_FILE")"
[ -n "$INFISICAL_TOKEN" ] || die "the Infisical token file is empty"
INFISICAL_RUN_ENV=()
[[ ${EGRESS_START_DATE+x} ]] && INFISICAL_RUN_ENV+=("EGRESS_START_DATE=$EGRESS_START_DATE")
[[ ${EGRESS_LOOKBACK_DAYS+x} ]] && INFISICAL_RUN_ENV+=("EGRESS_LOOKBACK_DAYS=$EGRESS_LOOKBACK_DAYS")

# Use nemaring's local listener; the public hostname requires Cloudflare Access.
exec env -i \
  HOME="$HOME" \
  PATH="${PATH:-/usr/local/bin:/usr/bin:/bin}" \
  INFISICAL_TOKEN="$INFISICAL_TOKEN" \
  INFISICAL_DISABLE_UPDATE_CHECK=true \
  NO_COLOR=1 \
  "${INFISICAL_RUN_ENV[@]}" \
  "$INFISICAL_CLI" run \
  --domain "http://127.0.0.1:8080" \
  --projectId "817f7473-a318-4e99-9cf4-a89db057f5fc" \
  --env prod \
  --path /observability/egress \
  --include-imports=false \
  --silent \
  -- \
  env -u INFISICAL_TOKEN -u INFISICAL_DOMAIN -u INFISICAL_PROFILE \
    AWS_CONFIG_FILE=/dev/null \
    AWS_SHARED_CREDENTIALS_FILE=/dev/null \
    AWS_EC2_METADATA_DISABLED=true \
    "$BUN_BIN" "$COLLECTOR"
