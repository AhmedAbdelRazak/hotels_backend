#!/usr/bin/env bash
set -euo pipefail

ROOT="${JANNAT_REBOOT_WATCHER_ROOT:-$HOME/ops/reboot-watcher}"
SCRIPT_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/reboot-watcher.sh"
SCRIPT_DST="$ROOT/reboot-watcher.sh"
CRON_BEGIN="# JANNAT_REBOOT_WATCHER_BEGIN"
CRON_END="# JANNAT_REBOOT_WATCHER_END"

if [ ! -f "$SCRIPT_SRC" ]; then
	echo "reboot-watcher.sh not found next to installer: $SCRIPT_SRC" >&2
	exit 1
fi

mkdir -p "$ROOT/logs" "$ROOT/state"
cp "$SCRIPT_SRC" "$SCRIPT_DST"
chmod 0755 "$SCRIPT_DST"

installed_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
host="$(hostname 2>/dev/null || echo unknown)"
commit="$(git -C "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)" rev-parse --short HEAD 2>/dev/null || echo unknown)"

cat > "$ROOT/INSTALLED.md" <<EOF
# Jannat Reboot Watcher

Installed: $installed_at
Host: $host
User: $(id -un 2>/dev/null || echo unknown)
Source commit: $commit

This watcher is intentionally low risk:
- It does not restart services.
- It does not edit app code or environment files.
- It writes only inside: $ROOT
- It runs from the user crontab under: $(id -un 2>/dev/null || echo unknown)

Cron block marker:
- JANNAT_REBOOT_WATCHER_BEGIN
- JANNAT_REBOOT_WATCHER_END

Commands:
- Show cron: crontab -l
- Run manually: $SCRIPT_DST
- Latest snapshots: tail -20 $ROOT/logs/snapshots.tsv
- Boot evidence: ls -lh $ROOT/logs/boot-evidence-*.log

Tracked source:
- hotels_backend/scripts/ops/reboot-watcher.sh
- hotels_backend/scripts/ops/install-reboot-watcher.sh
- hotels_backend/docs/ops/reboot-watcher.md
EOF

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

crontab -l 2>/dev/null | sed "/^$CRON_BEGIN\$/,/^$CRON_END\$/d" > "$tmp" || true
cat >> "$tmp" <<EOF
$CRON_BEGIN
@reboot $SCRIPT_DST >/dev/null 2>&1
*/3 * * * * $SCRIPT_DST >/dev/null 2>&1
$CRON_END
EOF
crontab "$tmp"

"$SCRIPT_DST"

echo "Installed Jannat reboot watcher."
echo "Root: $ROOT"
echo "Snapshots: $ROOT/logs/snapshots.tsv"
echo "Marker: $ROOT/INSTALLED.md"
