# OTA inbound coverage monitor - 2026-08-13

## Status

The monitor implementation and systemd templates are versioned with the backend. The two timers were installed and enabled in production on 2026-08-14 UTC after the support index and clean baseline audit were verified. A later application deployment does not reinstall or silently alter the systemd units; installed-file hashes, timer state, and aggregate results must be rechecked after each monitor-affecting release.

HotelRunner API access is not used. The monitor reads the existing MongoDB email and Reservation archives only. It never calls HotelRunner, an OTA, an exchange-rate service, a notification provider, or any other vendor API. It does not create, update, retry, release, cancel, or delete a Reservation or inbound email.

## Why the recurring check is needed

`GET /api/inbound/sendgrid` is endpoint liveness only. Per-email forwarding and Socket.IO updates can report an individual processing problem, but they do not prove that every authenticated new-reservation identity has a Reservation. The independent coverage audit closes that gap.

An authenticated email with a canonical new-reservation identity is eligible for the alert on the next five-minute run. A delivery that is still missing a canonical identity is allowed the existing 30-minute inbound claim lease before it is called stalled. This avoids racing a healthy webhook request.

Coverage report version 4 also checks financial completeness for a narrowly proven case: an active or pending Reservation created by `ota-email-orchestrator` must have materialized property-currency gross and payout totals when an authenticated direct OTA archive contains positive, source-backed gross and payout evidence with verified SAR conversion. This detects a represented Reservation whose identity exists but whose commercial totals were lost during cross-transport creation. It does not infer a payout when the direct archive does not provide one.

## Versioned files

- `services/otaInboundCoverageAudit20260813.js`: read-only coverage classifier and bounded loaders
- `scripts/auditOtaInboundCoverage20260813.js`: manual privacy-safe full report
- `scripts/ops/ota-inbound-coverage-monitor.sh`: locked, timeout-bounded wrapper
- `scripts/ops/otaInboundCoverageMonitorState.js`: aggregate-only atomic state writer
- `ops/systemd/xhotelpro-ota-inbound-coverage.service`: seven-day recent check
- `ops/systemd/xhotelpro-ota-inbound-coverage.timer`: five-minute recent schedule
- `ops/systemd/xhotelpro-ota-inbound-coverage-full.service`: comprehensive check from 2026-05-12
- `ops/systemd/xhotelpro-ota-inbound-coverage-full.timer`: daily comprehensive schedule

The recent and full checks have separate locks and state files. A fixed safety limit makes an unexpectedly large query fail closed with exit `1`; it can never be reported as clean. The recent timer combines `OnBootSec=7min` with `OnUnitActiveSec=5min`, the systemd-documented repeating pattern. The next run is scheduled from the last activation even when the prior oneshot exits `2` and enters a failed state.

## Query and index safety

The candidate-email query includes aligned authenticated new-reservation records whose identity exists in `normalizedReservation` even when a top-level provider, confirmation, or intent copy is only partially finalized. The model defines the narrow `inbound_authenticated_received_at` index so that this transport/date check does not depend on the missing fields it is trying to detect.

Reservation coverage is loaded through separate indexed queries for canonical identity, cross-transport identity, each supported legacy confirmation alias, and any authenticated archive link. Results are unioned by Reservation `_id` under one shared unique-document limit. The canonical and cross-transport queries repeat the partial-index predicate (`string` and nonempty), which allows MongoDB to select their unique partial indexes. A broad multi-field `$or`/collection scan is not used.

The financial-completeness check reuses those same bounded Reservation identity results and the same bounded authenticated-email candidates; it adds projections only, not a collection scan or another database query. It alerts only when all of the following are true:

- the direct transport is authenticated and supplies positive source gross and payout amounts;
- both amounts have verified positive SAR property totals and a consistent property-currency payment summary;
- the matched Reservation carries the exact OTA email creation pipeline/source markers;
- its lifecycle is active or pending, with no later authenticated terminal email; and
- the property gross or payout was not materialized on the Reservation.

Manual/legacy Reservations without the exact creation markers, terminal stays, unverified foreign conversion, and direct archives with no payout evidence are excluded. The check never substitutes HotelRunner relay money for authenticated direct OTA commercial evidence.

Before enabling the timer, run the dated, idempotent index ensure command from the exact deployed backend checkout:

```bash
cd /home/ahmedadmin/Hotels/hotels_backend
npm run ota:inbound-coverage-index-ensure-20260813
```

This command accepts no arguments and has no drop/rollback mode. It disables Mongoose `autoIndex` and `autoCreate`, preflights the catalog for same-name/different-specification or same-pattern/different-name conflicts, and creates only the exact nonunique `{ authenticatedAligned, receivedAt, _id }` index when absent. It then rereads the catalog and runs a bounded, projected, explicitly hinted `executionStats` verification. Repeating the command after success returns `already_ready` without rebuilding the index.

MongoDB 8 uses its optimized online index build path: it takes an exclusive collection lock briefly at the beginning and end, while allowing interleaved reads and writes during the main build. The obsolete `background` option is intentionally omitted because current MongoDB ignores it. The command prints only status, index name/key, and query counters; it does not print a database URL, record, email identity, or other PII. Do not put an external shell timeout around the index build. If the terminal disconnects, reconnect and rerun the same idempotent command.

## Private state and PII boundary

The manual CLI report contains operational provider/confirmation identities so an authorized operator can resolve a finding. The recurring wrapper never preserves that report. It captures it in a mode-`0600` temporary file, validates and reduces it to aggregate state, then removes the temporary report.

Systemd creates `/var/lib/xhotelpro-ota-inbound-coverage` with mode `0700`. Its `recent.json` and `full.json` contain only:

- checked time, mode, status, and exit code;
- active identity, incomplete-pipeline, and total issue counts;
- aggregate reason/provider and integrity-flag counts, including financial-completeness reason counts;
- bounded query counts;
- a SHA-256 `alertFingerprint` and transition state.

The state and journal never contain email bodies, subjects, sender/recipient addresses, guest names, hotel names, confirmation numbers, payment data, credentials, or database connection details. An unchanged alert fingerprint does not emit another application log line. Exit `2` remains nonzero so the systemd unit remains visibly unhealthy until the issue is resolved.

## Exit and transition semantics

- `0`: clean; state is `clean`
- `1`: audit incomplete, timed out, malformed, or over a safety limit; state is `error`
- `2`: active missing identity, incomplete authenticated pipeline delivery, or proven represented-reservation financial-completeness failure; state is `alert`

`alertFingerprint` hashes only the active OTA identity set, stable pipeline archive identifiers, and active financial-integrity identity keys. Audit time, age buckets, query statistics, and terminal/expired findings do not change it. The recurring state retains only the resulting hash and aggregate counts, never the financial issue's OTA confirmation or Reservation ID. Transitions are `alert_new`, `alert_changed`, `alert_unchanged`, `resolved`, `clean_unchanged`, or `audit_error`.

Exit `1` and exit `2` must both be monitored. A timer that writes state but whose failure state is never observed is not an alerting system. The current safe local signal is the failed oneshot unit plus the aggregate state file; any future external health integration must read this cached aggregate state and must not execute the database audit on each public HTTP request.

## Pre-install verification

From the deployed backend checkout:

```bash
node --test services/otaInboundCoverageAudit20260813.test.js
node --test scripts/ensureOtaInboundCoverageIndex20260813.test.js
node scripts/auditOtaInboundCoverage20260813.js
bash -n scripts/ops/ota-inbound-coverage-monitor.sh
```

The manual audit may exit `2` while a known active incident is still unresolved. Do not enable the recurring timer until the intended recovery is complete and a new comprehensive run exits `0`.

## Controlled installation

After the exact release is deployed, the index is ready, tests pass, and the full audit is clean:

```bash
sudo install -m 0644 ops/systemd/xhotelpro-ota-inbound-coverage.service /etc/systemd/system/
sudo install -m 0644 ops/systemd/xhotelpro-ota-inbound-coverage.timer /etc/systemd/system/
sudo install -m 0644 ops/systemd/xhotelpro-ota-inbound-coverage-full.service /etc/systemd/system/
sudo install -m 0644 ops/systemd/xhotelpro-ota-inbound-coverage-full.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now xhotelpro-ota-inbound-coverage.timer
sudo systemctl enable --now xhotelpro-ota-inbound-coverage-full.timer
```

Enabling these timers does not enable or start `xhotelpro-hotelrunner-sync.service`.

## Verification and rollback

```bash
systemctl list-timers --all --no-pager | grep xhotelpro-ota-inbound-coverage
sudo systemctl start xhotelpro-ota-inbound-coverage.service
systemctl status xhotelpro-ota-inbound-coverage.service --no-pager
sudo cat /var/lib/xhotelpro-ota-inbound-coverage/recent.json
journalctl -u xhotelpro-ota-inbound-coverage.service --since today --no-pager
```

To stop recurring reads without touching application data:

```bash
sudo systemctl disable --now xhotelpro-ota-inbound-coverage.timer
sudo systemctl disable --now xhotelpro-ota-inbound-coverage-full.timer
```

Disabling the coverage timers does not alter OTA email ingestion, Reservations, HotelRunner flags, or the disabled HotelRunner sync service.
