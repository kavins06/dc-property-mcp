#!/usr/bin/env bash
set -euo pipefail

readonly unit="${1:-unknown}"
readonly destination="${DC_PROPERTY_ALERT_EMAIL:-kavins@quoindata.com}"
readonly state_dir="/var/lib/dc-property-mcp/alerts"
readonly stamp="$(date -u +%Y%m%dT%H%M%SZ)"

install -d -o root -g root -m 0700 "$state_dir"
printf '{"event":"backup_failure","unit":"%s","destination":"%s","occurred_at":"%s"}\n' \
  "$unit" "$destination" "$stamp" \
  > "$state_dir/$stamp-$unit.json"
logger -p daemon.err -t dc-property-backup \
  "backup failure unit=$unit alert_destination=$destination"
