#!/usr/bin/env bash
set -euo pipefail

target_file="/etc/nginx/sites-available/xhotelpro"
enabled_file="/etc/nginx/sites-enabled/xhotelpro"
resolved_target="$(readlink -f -- "$target_file")"
expected_target="/etc/nginx/sites-available/xhotelpro"

if [[ "$resolved_target" != "$expected_target" ]]; then
	printf '%s\n' "Refusing unexpected Nginx target: $resolved_target" >&2
	exit 1
fi
if [[ ! -f "$target_file" ]]; then
	printf '%s\n' "Missing Nginx site file: $target_file" >&2
	exit 1
fi
if [[ ! -L "$enabled_file" ]] ||
	[[ "$(readlink -f -- "$enabled_file")" != "$expected_target" ]]; then
	printf '%s\n' "Refusing inactive or unexpected Nginx site link: $enabled_file" >&2
	exit 1
fi

backup_file="${target_file}.pre-hotelrunner-log-hardening-$(date -u +%Y%m%dT%H%M%SZ)"
if [[ -e "$backup_file" ]]; then
	printf '%s\n' "Refusing existing backup path: $backup_file" >&2
	exit 1
fi

temporary_file="$(mktemp /tmp/xhotelpro-hotelrunner-nginx.XXXXXX)"
cleanup() {
	rm -f -- "$temporary_file"
}
trap cleanup EXIT

python3 - "$target_file" "$temporary_file" <<'PY'
from pathlib import Path
import re
import sys

source = Path(sys.argv[1])
destination = Path(sys.argv[2])
lines = source.read_text(encoding="utf-8").splitlines(keepends=True)
starts = [
    index
    for index, line in enumerate(lines)
    if re.match(r"^\s*location\s*=\s*/api/hotelrunner/callback\s*\{\s*$", line)
]
if len(starts) != 1:
    raise SystemExit(
        f"Expected exactly one HotelRunner callback location, found {len(starts)}"
    )

start = starts[0]
depth = 0
end = None
for index in range(start, len(lines)):
    depth += lines[index].count("{") - lines[index].count("}")
    if depth == 0:
        end = index
        break
if end is None:
    raise SystemExit("HotelRunner callback location is not balanced")

block = lines[start : end + 1]
access_lines = [line for line in block if re.match(r"^\s*access_log\s+", line)]
if len(access_lines) != 1 or not re.match(
    r"^\s*access_log\s+off\s*;\s*$", access_lines[0]
):
    raise SystemExit("HotelRunner callback must contain exactly 'access_log off;'")

error_lines = [line for line in block if re.match(r"^\s*error_log\s+", line)]
expected_error = "error_log /dev/null crit;"
if error_lines:
    if len(error_lines) != 1 or expected_error not in error_lines[0]:
        raise SystemExit("Unexpected HotelRunner callback error_log policy")
else:
    access_index = next(
        index for index in range(start, end + 1)
        if re.match(r"^\s*access_log\s+off\s*;\s*$", lines[index])
    )
    indent = re.match(r"^(\s*)", lines[access_index]).group(1)
    lines.insert(access_index + 1, f"{indent}{expected_error}\n")

destination.write_text("".join(lines), encoding="utf-8")
PY

cp -a -- "$target_file" "$backup_file"
install -o root -g root -m 0644 -- "$temporary_file" "$target_file"

rollback() {
	cp -a -- "$backup_file" "$target_file"
	nginx -t
	systemctl reload nginx
}

if ! nginx -t; then
	rollback
	exit 1
fi
if ! systemctl reload nginx; then
	rollback
	exit 1
fi

nginx -t
printf '%s\n' \
	"HotelRunner callback access/error logging hardened; backup retained at $backup_file"
