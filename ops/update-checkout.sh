#!/usr/bin/env bash

# Brings the collector checkout to origin/main. Run by
# nemar-observability-update.service, as the collector user, before each
# collector run; merging to main is the deploy for the collectors.
#
# It resets to origin/main instead of pulling, so a dirty tree, a stray local
# commit, or another branch cannot stop the update. On failure it records when
# the failures began in the marker file (the collectors report it as an error
# metric once it is a day old) and exits non-zero; the collector
# still runs on the code already on disk. The whole body is one compound
# command, so bash has parsed it all before the reset rewrites this file.

{
  set -uo pipefail
  REPO="${NEMAR_OBSERVABILITY_REPO:-/opt/nemar-observability}"
  # In the service's StateDirectory, outside the checkout being reset.
  MARKER="${NEMAR_OBSERVABILITY_MARKER:-/var/lib/nemar-observability/update-failed-since}"

  # A stuck connection must not hold the collector's start for long.
  git_bounded() {
    if command -v timeout > /dev/null 2>&1; then
      timeout 90 git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=30 "$@"
    else
      git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=30 "$@"
    fi
  }

  if git_bounded -C "$REPO" fetch --quiet origin main \
    && git -C "$REPO" checkout --quiet --force -B main origin/main; then
    rm -f "$MARKER"
    echo "[update] checkout at $(git -C "$REPO" rev-parse --short HEAD)"
    exit 0
  fi

  if [ ! -e "$MARKER" ]; then
    mkdir -p "$(dirname "$MARKER")" && date -u +%Y-%m-%dT%H:%M:%SZ > "$MARKER" \
      || echo "[update] ERROR: cannot record the failure in $MARKER" >&2
  fi
  echo "[update] ERROR: could not update $REPO; failing since $(cat "$MARKER" 2> /dev/null || echo unknown)" >&2
  exit 1
}
