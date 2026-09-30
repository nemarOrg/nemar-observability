#!/usr/bin/env bash
set -euo pipefail

# Installs or refreshes the collector systemd units from the checkout and makes
# sure both timers are enabled. Idempotent; run as root on nemaring:
#
#   sudo /opt/nemar-observability/ops/install-units.sh
#
# The collector code itself needs no install step: every collector run starts
# the update service first, which resets the checkout to origin/main. Only a
# change under ops/systemd/ needs this script, so run it after such a change
# merges.

REPO="${NEMAR_OBSERVABILITY_REPO:-/opt/nemar-observability}"
OWNER="${COLLECTOR_USER:-yahya}"
UNITS=(
  nemar-observability-update.service
  nemar-observability-egress.service
  nemar-observability-egress.timer
  nemar-observability-storage.service
  nemar-observability-storage.timer
)

[ "$(id -u)" = 0 ] || { echo "run as root: sudo $0" >&2; exit 2; }
[ -d "$REPO/.git" ] || { echo "$REPO is not a git checkout" >&2; exit 2; }

# The update service runs as $OWNER, so the whole checkout must belong to
# $OWNER. An earlier root-run `git pull` left root-owned objects that break it.
chown -R "$OWNER:$OWNER" "$REPO"

# Catch a broken update path now, not a day later: the fetch must work as $OWNER.
sudo -u "$OWNER" env HOME="$(getent passwd "$OWNER" | cut -d: -f6)" GIT_TERMINAL_PROMPT=0 \
  git -C "$REPO" fetch --dry-run --quiet origin main \
  || { echo "cannot fetch origin/main as $OWNER; fix that before installing" >&2; exit 1; }

# A warning here does not stop the install; it is for the person reading it.
(cd "$REPO/ops/systemd" && systemd-analyze verify "${UNITS[@]}") \
  || echo "WARNING: systemd-analyze verify reported the problems above" >&2

for unit in "${UNITS[@]}"; do
  install -m 0644 "$REPO/ops/systemd/$unit" "/etc/systemd/system/$unit"
done
systemctl daemon-reload
systemctl enable --now nemar-observability-egress.timer nemar-observability-storage.timer
# Run the update once now, so a broken update path shows up in this output.
systemctl start nemar-observability-update.service
journalctl -u nemar-observability-update.service -n 5 --no-pager
systemctl list-timers 'nemar-observability-*' --no-pager
