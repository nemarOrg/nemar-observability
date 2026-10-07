#!/usr/bin/env bash
set -euo pipefail

# Runs one installed collector with secrets injected from the read-only
# Infisical path prod:/observability/egress. The two S3 CloudWatch collectors
# (egress, storage) reuse its CloudWatch read key; the Zarr recordings collector
# needs no AWS key and loses it. Each child is denied the other collectors'
# known section-ingest tokens. That is a deny-list of the known names, not an
# allow-list: a secret added to the Infisical path and not yet listed in
# collector-profiles.sh reaches every collector's child. Which collector is
# denied what is defined once, in collector-profiles.sh next to this file,
# which is also what the environment test runs.

case "${BASH_SOURCE[0]}" in
  */*) SELF_DIR="${BASH_SOURCE[0]%/*}" ;;
  *) SELF_DIR=. ;;
esac
# shellcheck source=collector-profiles.sh
. "$SELF_DIR/collector-profiles.sh"

INSTALL_ROOT="/opt/nemar-observability"
LOG_TAG="s3-collector"

die() {
  printf '[%s] ERROR: %s\n' "${LOG_TAG:-s3-collector}" "$*" >&2
  exit 2
}

if (($# != 1)); then
  die "usage: $0 $INSTALL_ROOT/scripts/push-s3-egress.ts|push-s3-storage.ts|push-zarr-recordings.ts"
fi
COLLECTOR="$1"
# Only a collector the profile table knows, directly under scripts/ (so no
# `..`, no subdirectory, no suffix).
if [[ "$COLLECTOR" != "$INSTALL_ROOT/scripts/"* ]] \
  || ! collector_profile "${COLLECTOR#"$INSTALL_ROOT"/scripts/}"; then
  die "collector path must be $INSTALL_ROOT/scripts/push-s3-egress.ts, push-s3-storage.ts, or push-zarr-recordings.ts"
fi
LOG_TAG="$COLLECTOR_TAG"

# Keep only an allowlist of inherited exported variables, so nothing else
# reaches Infisical or the collector. The Infisical token is exported below
# rather than passed to a command, so it never appears in a process argv.
collector_clear_inherited || die "cannot clear inherited variable ${COLLECTOR_CLEAR_FAILED:-?}"
collector_env_unset_args

[ -r "$COLLECTOR" ] || die "collector script is not readable"
[ -n "${HOME:-}" ] || die "HOME must be set"

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
export INFISICAL_TOKEN
# The tool paths are only needed here, not in the children's environment.
collector_set_runtime_env

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
  env "${COLLECTOR_ENV_UNSET[@]}" "${COLLECTOR_ENV_FIXED[@]}" "$BUN_BIN" "$COLLECTOR"
