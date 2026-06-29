#!/usr/bin/env bash
set -u

# Lightweight reboot evidence watcher for the Jannat production host.
# It is intentionally read-only apart from writing its own logs/state files.

PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$HOME/.local/bin:$HOME/.npm-global/bin"

ROOT="${JANNAT_REBOOT_WATCHER_ROOT:-$HOME/ops/reboot-watcher}"
LOG_DIR="$ROOT/logs"
STATE_DIR="$ROOT/state"
SNAPSHOT_LOG="$LOG_DIR/snapshots.tsv"
STATE_BOOT_ID="$STATE_DIR/last_boot_id"
STATE_INSTALLED="$ROOT/INSTALLED.md"

mkdir -p "$LOG_DIR" "$STATE_DIR"

now_utc() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
now_file() { date -u +"%Y%m%dT%H%M%SZ"; }

safe_one_line() {
	printf "%s" "$1" | tr '\t\r\n' '   ' | sed 's/  */ /g; s/^ *//; s/ *$//'
}

append_section() {
	local file="$1"
	local title="$2"
	shift 2
	{
		printf "\n===== %s =====\n" "$title"
		"$@" 2>&1 || true
	} >> "$file"
}

maybe_rotate_snapshots() {
	if [ -f "$SNAPSHOT_LOG" ]; then
		local bytes
		bytes="$(wc -c < "$SNAPSHOT_LOG" 2>/dev/null || echo 0)"
		if [ "${bytes:-0}" -gt 10485760 ]; then
			mv "$SNAPSHOT_LOG" "$SNAPSHOT_LOG.$(now_file)"
		fi
	fi
	find "$LOG_DIR" -maxdepth 1 -type f -name "boot-evidence-*.log" -mtime +45 -delete 2>/dev/null || true
}

write_install_marker() {
	if [ -f "$STATE_INSTALLED" ]; then
		return
	fi
	cat > "$STATE_INSTALLED" <<EOF
# Jannat Reboot Watcher

Installed: $(now_utc)
Host: $(hostname 2>/dev/null || echo unknown)
User: $(id -un 2>/dev/null || echo unknown)

Purpose:
- Record tiny uptime/health snapshots every few minutes.
- Capture extra evidence immediately after a new OS boot is detected.
- Help future operators distinguish app restarts from full host reboots.

Cron block marker:
- JANNAT_REBOOT_WATCHER_BEGIN
- JANNAT_REBOOT_WATCHER_END

Logs:
- $SNAPSHOT_LOG
- $LOG_DIR/boot-evidence-*.log

State:
- $STATE_BOOT_ID

Source:
- hotels_backend/scripts/ops/reboot-watcher.sh
- hotels_backend/docs/ops/reboot-watcher.md
EOF
}

curl_status() {
	local url="$1"
	if ! command -v curl >/dev/null 2>&1; then
		printf "curl_missing"
		return
	fi
	curl -fsS -o /dev/null -w "%{http_code}" --max-time 8 "$url" 2>/dev/null || printf "curl_error"
}

service_active() {
	local service="$1"
	if ! command -v systemctl >/dev/null 2>&1; then
		printf "systemctl_missing"
		return
	fi
	systemctl is-active "$service" 2>/dev/null || true
}

pm2_summary() {
	if command -v pm2 >/dev/null 2>&1; then
		pm2 status --no-color 2>/dev/null | awk '/hotels-backend|jannat-ssr|cloudflared/ { gsub(/[[:space:]]+/, " "); print }' | paste -sd ';' -
	else
		printf "pm2_missing"
	fi
}

capture_boot_evidence() {
	local previous_boot_id="$1"
	local current_boot_id="$2"
	local reason="$3"
	local file="$LOG_DIR/boot-evidence-$(now_file)-${current_boot_id}.log"

	{
		printf "Jannat reboot watcher evidence\n"
		printf "captured_utc=%s\n" "$(now_utc)"
		printf "reason=%s\n" "$reason"
		printf "host=%s\n" "$(hostname 2>/dev/null || echo unknown)"
		printf "user=%s\n" "$(id -un 2>/dev/null || echo unknown)"
		printf "previous_boot_id=%s\n" "$previous_boot_id"
		printf "current_boot_id=%s\n" "$current_boot_id"
		printf "uptime=%s\n" "$(uptime 2>/dev/null || true)"
	} > "$file"

	append_section "$file" "last reboot/shutdown records" bash -lc "last -x reboot shutdown | head -40"
	append_section "$file" "journal boot list" journalctl --list-boots --no-pager
	append_section "$file" "current boot warnings" journalctl -b 0 -p warning..alert --no-pager -n 220
	append_section "$file" "previous boot final lines" journalctl -b -1 --no-pager -n 260
	append_section "$file" "previous boot warnings" journalctl -b -1 -p warning..alert --no-pager -n 260
	append_section "$file" "previous kernel reboot indicators" bash -lc "journalctl -k -b -1 --no-pager 2>&1 | grep -Ei 'oom|out of memory|killed process|panic|watchdog|thermal|temperature|power|reset|reboot|fatal|segfault|ext4|nvme|i/o error|shutdown|suspend|hibernate' | tail -180"
	append_section "$file" "cloudflared previous boot" journalctl -u cloudflared -b -1 --no-pager -n 220
	append_section "$file" "cloudflared current boot" journalctl -u cloudflared -b 0 --no-pager -n 220
	append_section "$file" "memory" free -h
	append_section "$file" "disk" df -h
	append_section "$file" "thermal sensors" bash -lc "sensors 2>/dev/null || true"
	append_section "$file" "network summary" bash -lc "ip -brief addr 2>/dev/null; resolvectl status 2>/dev/null | sed -n '1,140p'"
	append_section "$file" "pm2 status" bash -lc "command -v pm2 >/dev/null 2>&1 && pm2 status --no-color || true"
}

main() {
	maybe_rotate_snapshots
	write_install_marker

	local timestamp boot_id previous_boot_id uptime_seconds loadavg mem_available_kb disk_root_pct
	local cloudflared_active backend_local_health backend_public_health pm2_line

	timestamp="$(now_utc)"
	boot_id="$(cat /proc/sys/kernel/random/boot_id 2>/dev/null || echo unknown)"
	previous_boot_id="$(cat "$STATE_BOOT_ID" 2>/dev/null || true)"
	uptime_seconds="$(awk '{print int($1)}' /proc/uptime 2>/dev/null || echo 0)"
	loadavg="$(safe_one_line "$(cat /proc/loadavg 2>/dev/null || echo unknown)")"
	mem_available_kb="$(awk '/MemAvailable/ {print $2}' /proc/meminfo 2>/dev/null || echo unknown)"
	disk_root_pct="$(df -P / 2>/dev/null | awk 'NR==2 {print $5}' || echo unknown)"
	cloudflared_active="$(service_active cloudflared)"
	backend_local_health="$(curl_status "http://127.0.0.1:8080/api/aiagent/health")"
	backend_public_health="$(curl_status "https://xhotelpro.com/api/aiagent/health")"
	pm2_line="$(safe_one_line "$(pm2_summary)")"

	if [ ! -f "$SNAPSHOT_LOG" ]; then
		printf "timestamp_utc\tboot_id\tuptime_seconds\tloadavg\tmem_available_kb\tdisk_root_pct\tcloudflared\tbackend_local\tbackend_public\tpm2_summary\n" > "$SNAPSHOT_LOG"
	fi
	printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" \
		"$timestamp" "$boot_id" "$uptime_seconds" "$loadavg" "$mem_available_kb" \
		"$disk_root_pct" "$cloudflared_active" "$backend_local_health" \
		"$backend_public_health" "$pm2_line" >> "$SNAPSHOT_LOG"

	if [ -z "$previous_boot_id" ]; then
		capture_boot_evidence "none" "$boot_id" "first_run"
	elif [ "$previous_boot_id" != "$boot_id" ]; then
		capture_boot_evidence "$previous_boot_id" "$boot_id" "boot_id_changed"
	fi
	printf "%s\n" "$boot_id" > "$STATE_BOOT_ID"
}

main "$@"
