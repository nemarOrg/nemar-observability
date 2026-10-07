#!/usr/bin/env bash
# The one definition of which secrets and settings each nemaring collector may
# see. Sourced by ops/with-collector-secrets.sh (which runs a collector with its
# secrets injected from Infisical) and by test/collector-env.test.ts (which runs
# these functions under real bash and checks the environment a child would get).
# Sourcing this file defines data and functions only; it changes nothing.
#
# Adding a collector means adding its ingest token to COLLECTOR_INGEST_TOKENS
# and one branch to collector_profile. Every other collector then stops seeing
# the new token, with no second or third list to edit.
#
# Plain bash 3.2 is enough (no associative arrays, no mapfile), so this also
# runs under the system bash of macOS.

# Every collector's section-ingest token. A collector sees only its own.
COLLECTOR_INGEST_TOKENS=(
  OBS_EGRESS_INGEST_TOKEN
  OBS_STORAGE_INGEST_TOKEN
  OBS_RECORDINGS_INGEST_TOKEN
)
# The CloudWatch read key, held in the same Infisical path; only the S3
# collectors use it.
COLLECTOR_AWS_VARS=(AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_REGION)
# Settings inherited from the unit that only the egress collector reads.
COLLECTOR_EGRESS_VARS=(EGRESS_START_DATE EGRESS_LOOKBACK_DAYS)
# Inherited from the unit (systemd's writable state directory) and read only by
# the collector that keeps a cache.
COLLECTOR_STATE_VAR=STATE_DIRECTORY
# Fixed for every child: no AWS profile, shared credentials file, or instance
# metadata credential can substitute for (or leak beside) the injected key.
COLLECTOR_ENV_FIXED=(
  AWS_CONFIG_FILE=/dev/null
  AWS_SHARED_CREDENTIALS_FILE=/dev/null
  AWS_EC2_METADATA_DISABLED=true
)

# collector_profile SCRIPT
#   SCRIPT is a collector's file name under scripts/. Sets, for that collector:
#     COLLECTOR_TAG                 the journal tag
#     COLLECTOR_TOKEN               its own ingest token variable
#     COLLECTOR_USES_AWS            1 if it needs the CloudWatch read key
#     COLLECTOR_USES_STATE_DIR      1 if it keeps a cache in STATE_DIRECTORY
#     COLLECTOR_USES_EGRESS_ENV     1 if it reads the egress backfill settings
#   Returns 1, setting nothing, for any other name.
collector_profile() {
  case "$1" in
    push-s3-egress.ts)
      COLLECTOR_TAG=s3-egress
      COLLECTOR_TOKEN=OBS_EGRESS_INGEST_TOKEN
      COLLECTOR_USES_AWS=1
      COLLECTOR_USES_STATE_DIR=0
      COLLECTOR_USES_EGRESS_ENV=1
      ;;
    push-s3-storage.ts)
      COLLECTOR_TAG=s3-storage
      COLLECTOR_TOKEN=OBS_STORAGE_INGEST_TOKEN
      COLLECTOR_USES_AWS=1
      COLLECTOR_USES_STATE_DIR=0
      COLLECTOR_USES_EGRESS_ENV=0
      ;;
    push-zarr-recordings.ts)
      COLLECTOR_TAG=zarr-recordings
      COLLECTOR_TOKEN=OBS_RECORDINGS_INGEST_TOKEN
      COLLECTOR_USES_AWS=0
      COLLECTOR_USES_STATE_DIR=1
      COLLECTOR_USES_EGRESS_ENV=0
      ;;
    *)
      return 1
      ;;
  esac
}

# collector_clear_inherited
#   Keep only an allowlist of the inherited exported variables, so nothing else
#   reaches Infisical or the collector, then drop the allowlisted ones this
#   collector does not use. Needs collector_profile first. On failure returns 1
#   with the variable's name in COLLECTOR_CLEAR_FAILED.
collector_clear_inherited() {
  local name
  while IFS= read -r name; do
    case "$name" in
      HOME | PATH | INFISICAL_CLI | BUN_BIN | EGRESS_START_DATE | EGRESS_LOOKBACK_DAYS | STATE_DIRECTORY) ;;
      *)
        if ! unset "$name" 2>/dev/null; then
          COLLECTOR_CLEAR_FAILED="$name"
          return 1
        fi
        ;;
    esac
  done < <(compgen -e)
  if [ "$COLLECTOR_USES_EGRESS_ENV" != 1 ]; then
    for name in "${COLLECTOR_EGRESS_VARS[@]}"; do unset "$name"; done
  fi
  if [ "$COLLECTOR_USES_STATE_DIR" != 1 ]; then unset "$COLLECTOR_STATE_VAR"; fi
  return 0
}

# collector_set_runtime_env
#   What the wrapper exports for the Infisical CLI and its child, and the tool
#   paths it must not pass on (they are only needed by the wrapper itself).
collector_set_runtime_env() {
  export INFISICAL_DISABLE_UPDATE_CHECK=true NO_COLOR=1
  export PATH="${PATH:-/usr/local/bin:/usr/bin:/bin}"
  export -n INFISICAL_CLI BUN_BIN
}

# collector_env_unset_args
#   Sets COLLECTOR_ENV_UNSET to the `-u NAME` arguments for the `env` that runs
#   the collector inside `infisical run`: Infisical's own variables, every other
#   collector's ingest token, and the AWS key unless this collector uses it.
#   Needs collector_profile first. The child command is then
#     env "${COLLECTOR_ENV_UNSET[@]}" "${COLLECTOR_ENV_FIXED[@]}" COMMAND...
collector_env_unset_args() {
  local name
  COLLECTOR_ENV_UNSET=(-u INFISICAL_TOKEN -u INFISICAL_DOMAIN -u INFISICAL_PROFILE)
  for name in "${COLLECTOR_INGEST_TOKENS[@]}"; do
    if [ "$name" != "$COLLECTOR_TOKEN" ]; then COLLECTOR_ENV_UNSET+=(-u "$name"); fi
  done
  if [ "$COLLECTOR_USES_AWS" != 1 ]; then
    for name in "${COLLECTOR_AWS_VARS[@]}"; do COLLECTOR_ENV_UNSET+=(-u "$name"); done
  fi
}
