#!/usr/bin/env bash
set -euo pipefail

# Read-only OTA inbound coverage monitor. This wrapper never calls an OTA,
# HotelRunner, or a notification API; it only reads MongoDB through the audited
# backend CLI and writes a private aggregate state file for local operations.

umask 077

MODE="${1:-recent}"
case "$MODE" in
	recent|full) ;;
	*)
		echo "[ota-coverage-monitor] invalid_mode" >&2
		exit 1
		;;
esac

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_DIR="${OTA_COVERAGE_BACKEND_DIR:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
STATE_DIR="${OTA_COVERAGE_STATE_DIR:-${STATE_DIRECTORY:-$HOME/ops/ota-inbound-coverage}}"
LOCK_FILE="${OTA_COVERAGE_LOCK_FILE:-$STATE_DIR/$MODE.lock}"
LOOKBACK_DAYS="${OTA_COVERAGE_MONITOR_LOOKBACK_DAYS:-7}"
TIMEOUT_SECONDS="${OTA_COVERAGE_MONITOR_TIMEOUT_SECONDS:-120}"
STATE_FILE="$STATE_DIR/$MODE.json"

case "$LOOKBACK_DAYS" in
	''|*[!0-9]*)
		echo "[ota-coverage-monitor] invalid_lookback" >&2
		exit 1
		;;
esac
case "$TIMEOUT_SECONDS" in
	''|*[!0-9]*)
		echo "[ota-coverage-monitor] invalid_timeout" >&2
		exit 1
		;;
esac
if [ "$LOOKBACK_DAYS" -lt 1 ] || [ "$LOOKBACK_DAYS" -gt 31 ]; then
	echo "[ota-coverage-monitor] invalid_lookback" >&2
	exit 1
fi
if [ "$TIMEOUT_SECONDS" -lt 30 ] || [ "$TIMEOUT_SECONDS" -gt 300 ]; then
	echo "[ota-coverage-monitor] invalid_timeout" >&2
	exit 1
fi

AUDIT_SCRIPT="$BACKEND_DIR/scripts/auditOtaInboundCoverage20260813.js"
STATE_SCRIPT="$BACKEND_DIR/scripts/ops/otaInboundCoverageMonitorState.js"
if [ ! -r "$BACKEND_DIR/.env" ] || [ ! -r "$AUDIT_SCRIPT" ] || [ ! -r "$STATE_SCRIPT" ]; then
	echo "[ota-coverage-monitor] required_input_unavailable" >&2
	exit 1
fi

mkdir -p "$STATE_DIR"
chmod 0700 "$STATE_DIR"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
	echo "[ota-coverage-monitor] already_running"
	exit 0
fi

REPORT_FILE="$(mktemp "$STATE_DIR/.report.$MODE.XXXXXX")"
ERROR_FILE="$(mktemp "$STATE_DIR/.error.$MODE.XXXXXX")"
cleanup() {
	rm -f -- "$REPORT_FILE" "$ERROR_FILE"
}
trap cleanup EXIT

AS_OF="$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")"
AUDIT_ARGS=("--as-of=$AS_OF")
if [ "$MODE" = "recent" ]; then
	SINCE="$(date -u -d "$LOOKBACK_DAYS days ago" +"%Y-%m-%dT%H:%M:%S.000Z")"
	AUDIT_ARGS+=("--since=$SINCE")
fi

set +e
(
	cd "$BACKEND_DIR"
	timeout --signal=TERM --kill-after=10s "${TIMEOUT_SECONDS}s" \
		/usr/bin/node "$AUDIT_SCRIPT" "${AUDIT_ARGS[@]}"
) >"$REPORT_FILE" 2>"$ERROR_FILE"
AUDIT_EXIT=$?
set -e

case "$AUDIT_EXIT" in
	0|2)
		/usr/bin/node "$STATE_SCRIPT" \
			"--audit-exit=$AUDIT_EXIT" \
			"--mode=$MODE" \
			"--report-file=$REPORT_FILE" \
			"--state-file=$STATE_FILE"
		exit "$AUDIT_EXIT"
		;;
	124|137)
		ERROR_CODE="audit_timeout"
		;;
	*)
		ERROR_CODE="audit_exit_$AUDIT_EXIT"
		;;
esac

# The CLI deliberately emits only a generic error, but the wrapper does not
# relay even that captured stream. The persisted error state is code-only.
/usr/bin/node "$STATE_SCRIPT" \
	"--audit-exit=1" \
	"--error-code=$ERROR_CODE" \
	"--mode=$MODE" \
	"--state-file=$STATE_FILE" || true
exit 1
