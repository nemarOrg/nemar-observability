#!/usr/bin/env bash
set -euo pipefail

# Runs one installed collector with secrets injected from the read-only
# Infisical path prod:/observability/egress. The two S3 CloudWatch collectors
# (egress, storage) reuse its CloudWatch read key; the Zarr recordings collector
# needs no AWS key and loses it. Each child sees only its own section-ingest
# token.

die() {
  printf '[%s] ERROR: %s\n' "${LOG_TAG:-s3-collector}" "$*" >&2
  exit 2
}

# Keep only an allowlist of inherited exported variables, so nothing else
# reaches Infisical or the collector. The Infisical token is exported below
# rather than passed to a command, so it never appears in a process argv.
while IFS= read -r name; do
  case "$name" in
    HOME | PATH | INFISICAL_CLI | BUN_BIN | EGRESS_START_DATE | EGRESS_LOOKBACK_DAYS) ;;
    # systemd's writable state directory (the recordings collector's cache);
    # unset for the units that declare none.
    STATE_DIRECTORY) ;;
    *) unset "$name" 2>/dev/null || die "cannot clear inherited variable $name" ;;
  esac
done < <(compgen -e)

INSTALL_ROOT="/opt/nemar-observability"
LOG_TAG="s3-collector"

if (($# != 1)); then
  die "usage: $0 $INSTALL_ROOT/scripts/push-s3-egress.ts|push-s3-storage.ts|push-zarr-recordings.ts"
fi
COLLECTOR="$1"
# Variables the Infisical path holds that this child must not see: every other
# collector's ingest token, plus the AWS key for a collector that does not use it.
DROP_VARS=()
case "$COLLECTOR" in
  "$INSTALL_ROOT/scripts/push-s3-egress.ts")
    LOG_TAG="s3-egress"
    DROP_VARS=(OBS_STORAGE_INGEST_TOKEN OBS_RECORDINGS_INGEST_TOKEN)
    unset STATE_DIRECTORY
    ;;
  "$INSTALL_ROOT/scripts/push-s3-storage.ts")
    LOG_TAG="s3-storage"
    DROP_VARS=(OBS_EGRESS_INGEST_TOKEN OBS_RECORDINGS_INGEST_TOKEN)
    unset EGRESS_START_DATE EGRESS_LOOKBACK_DAYS STATE_DIRECTORY
    ;;
  "$INSTALL_ROOT/scripts/push-zarr-recordings.ts")
    LOG_TAG="zarr-recordings"
    DROP_VARS=(
      OBS_EGRESS_INGEST_TOKEN OBS_STORAGE_INGEST_TOKEN
      AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_REGION
    )
    unset EGRESS_START_DATE EGRESS_LOOKBACK_DAYS
    ;;
  *)
    die "collector path must be $INSTALL_ROOT/scripts/push-s3-egress.ts, push-s3-storage.ts, or push-zarr-recordings.ts"
    ;;
esac
ENV_UNSET=(-u INFISICAL_TOKEN -u INFISICAL_DOMAIN -u INFISICAL_PROFILE)
for name in "${DROP_VARS[@]}"; do ENV_UNSET+=(-u "$name"); done
[ -r "$COLLECTOR" ] || die "collector script is not readable"
[ -n "${HOME:-}" ] || die "HOME must be set"

INFISICAL_CLI="${INFISICAL_CLI:-${HOME}/.local/bin/infisical}"
[ -x "$INFISICAL_CLI" ] || INFISICAL_CLI="$(command -v infisical 2>/dev/null || true)"
[ -n "$INFISICAL_CLI" ] && [ -x "$INFISICAL_CLI" ] || die "Infisical CLI is not executable"

BUN_BIN="${BUN_BIN:-${HOME}/.bun/bin/bun}"
[ -x "$BUN_BIN" ] || BUN_BIN="$(command -v bun 2>/dev/null || true)"
[ -n "$BUN_BIN" ] && [ -x "$BUN_BIN" ] || die "Bun is not executable"
# The tool paths are only needed here, not in the children's environment.
export -n INFISICAL_CLI BUN_BIN

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
export INFISICAL_TOKEN
export INFISICAL_DISABLE_UPDATE_CHECK=true NO_COLOR=1
export PATH="${PATH:-/usr/local/bin:/usr/bin:/bin}"

# Use the public Infisical hostname through the nemar-infisical tunnel. Cloudflare Access
# bypasses the exact hostname; Infisical still authenticates this scoped service token.
exec "$INFISICAL_CLI" run \
  --domain "https://infisical.nemar.org" \
  --projectId "817f7473-a318-4e99-9cf4-a89db057f5fc" \
  --env prod \
  --path /observability/egress \
  --include-imports=false \
  --silent \
  -- \
  env "${ENV_UNSET[@]}" \
    AWS_CONFIG_FILE=/dev/null \
    AWS_SHARED_CREDENTIALS_FILE=/dev/null \
    AWS_EC2_METADATA_DISABLED=true \
    "$BUN_BIN" "$COLLECTOR"
