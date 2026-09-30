#!/usr/bin/env bash
set -euo pipefail

# Installs or refreshes the collector systemd units from the checkout and makes
# sure both timers are enabled. Idempotent; run as root on nemaring:
#
#   sudo /opt/nemar-observability/ops/install-units.sh
#
# The collector code itself needs no install step: each run pulls main first
# (ExecStartPre in the service units). Only a change under ops/systemd/ needs
# this script, so run it after such a change merges.

REPO=/opt/nemar-observability
OWNER=yahya

[ "$(id -u)" = 0 ] || { echo "run as root: sudo $0" >&2; exit 2; }
[ -d "$REPO/.git" ] || { echo "$REPO is not a git checkout" >&2; exit 2; }

# The services pull as $OWNER, so the whole checkout must belong to $OWNER.
# An earlier root-run `git pull` left root-owned objects that break the pull.
chown -R "$OWNER:$OWNER" "$REPO"

install -m 0644 "$REPO"/ops/systemd/nemar-observability-{egress,storage}.{service,timer} /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now nemar-observability-egress.timer nemar-observability-storage.timer
systemctl list-timers 'nemar-observability-*' --no-pager
