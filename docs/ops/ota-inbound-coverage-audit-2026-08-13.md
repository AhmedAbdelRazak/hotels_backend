# OTA inbound email coverage audit — 2026-08-13

## Purpose

HotelRunner API access was discontinued on 2026-08-13. OTA reservation intake is email-only. The read-only coverage auditor added on this date verifies that every authenticated new-reservation email identity is represented by a `Reservations` document or is safely classified as later-terminal or expired. It also detects authenticated deliveries stranded before a canonical OTA identity could be extracted, so a processing crash cannot produce a falsely clean report.

The auditor does not call HotelRunner or any OTA, does not poll a vendor, does not enqueue fallback work, and does not write to MongoDB. HotelRunner-originated emails remain valid email-transport evidence; they are not HotelRunner API usage.

Implementation:

- `services/otaInboundCoverageAudit20260813.js` — reusable read-only loader and classifier
- `scripts/auditOtaInboundCoverage20260813.js` — privacy-safe operations CLI
- `services/otaInboundCoverageAudit20260813.test.js` — classification, identity, safety, and CLI regression coverage

## Audit scope and identity policy

The comprehensive default window begins at the archive's operational start, `2026-05-12T00:00:00.000Z`.

Only records with aligned authenticated sender evidence are admitted. Covered transports are Agoda, Airbnb, Booking.com, Expedia, Hotels.com, Trip.com, and HotelRunner email transport. Internal Jannat messages and untrusted or unaligned messages are excluded.

A HotelRunner email relay is grouped under its source OTA identity when source evidence is unambiguous. If the direct OTA email exists, it is the identity winner and the HotelRunner email is classified as corroborating transport evidence. A HotelRunner-only Direct Plus booking remains in the `hotelrunner:<confirmation>` namespace. Reservations are matched through indexed canonical identity, cross-transport identity, confirmation aliases, or an authenticated archive link whose confirmation and commercial provider both agree.

For a missing identity, classification order is:

1. `later_terminal` when a later authenticated cancellation or no-show email exists;
2. `expired` when every usable checkout date is before the audit date;
3. `active_nonterminal` otherwise, including missing or conflicting future/current checkout evidence.

`active_nonterminal` is an alert. An authenticated `failed`, `needs_review`, or `needs_mapping` delivery without a canonical identity is also an alert when its intent is new-reservation or still unclassified. A `received` delivery becomes an alert only after the 30-minute inbound claim lease expires. Explicit non-reservation intents are excluded from this pipeline signal. Terminal and expired identities remain visible in the report but must not be resurrected.

## Verified snapshot

Read-only snapshot at `2026-08-13T22:00:00.000Z`:

- 341 authenticated new-reservation email archive records
- 173 canonical/cross-transport identities
- 166 identities represented by Reservations
- 7 identities with no Reservation
- 3 active/nonterminal misses: Agoda `689553735`, Agoda `689554695`, Trip `1567953939695657`
- 3 later-cancelled identities: Agoda `686896959`, Airbnb `HM3QZAZ2CK`, HotelRunner email-only `R411331378`
- 1 expired identity: Trip `1567953895146560`
- 0 incomplete/stalled authenticated pipeline archives under the version 3 lease-aware check
- 0 archive-link integrity flags across both represented and missing identities under the version 3 provider-consistent check

Version 3 preserves each provider/confirmation pair from the field where it was
actually stored. It never Cartesian-combines a provider from one reservation
section with a confirmation from another section; ambiguous legacy provider
signals remain unrepresented and produce only an aggregate, PII-free integrity
flag.

The two current Agoda misses and the current Trip miss each have corroborating HotelRunner email-transport records. This strengthens the booking evidence but does not replace the direct OTA email as commercial authority. The HotelRunner Direct Plus / Google identity `R411331378` was followed by an authenticated cancellation email approximately 100 seconds later, so no Reservation should be created for it.

The current multi-room recovery invariant is one canonical room entry per physical room, each with `count: 1`. Do not collapse a two-room booking into one room entry with `count: 2`, and do not create only one room from a two-room email.

Lifecycle emails must be retained. Removing cancellation or no-show archives would make a safely suppressed identity appear active and could cause an obsolete booking to be proposed for recovery.

## 2026-08-13 recurrence prevention

The inbound mapper now distinguishes a single homogeneous room-table row with an
explicit quantity from genuinely heterogeneous room blocks. An authenticated
Agoda or Trip confirmation with one source-backed room product and quantity
`2` is materialized as two separate `count: 1` rows with complete nightly
coverage and exact cent allocation. Multiple room products, conflicting MIME
representations, truncated tables, inconsistent quantities, dates, occupancy,
or money still stop in review without a Reservation mutation.

Trusted OTA text and HTML are compared across MIME representations before they
can authorize a write. Raw MIME larger than 16 MiB is stopped before
`mailparser`; only a bounded header/authentication window and hash are archived,
the body remains blank, and the delivery is finalized as
`ota_inbound_parser_resource_limit` with every reservation, AI, live-FX,
notification, and HotelRunner path skipped.

An unlinked `needs_review` or `needs_mapping` delivery can now relinquish its
dedupe claim for a corrected-parser redelivery. Any reservation link or staged
reconciliation link keeps the claim blocking, so this retry boundary cannot
create a second Reservation or replay a linked lifecycle event.

## Operations command

Run from the backend directory:

```powershell
node scripts\auditOtaInboundCoverage20260813.js
```

Optional deterministic window:

```powershell
node scripts\auditOtaInboundCoverage20260813.js --since=2026-05-12T00:00:00.000Z --as-of=2026-08-13T22:00:00.000Z
```

Exit codes:

- `0` — no active/nonterminal missing identity and no incomplete authenticated pipeline delivery
- `1` — the audit could not complete safely, including a query safety-limit failure
- `2` — at least one active/nonterminal identity has no Reservation, or an authenticated delivery is incomplete/stalled before canonical identity extraction

The report contains counts and operational provider/confirmation identities only. Pipeline anomalies are aggregate counts by status, reason, age bucket, and trusted transport; their raw archive contents are not emitted. The report never outputs email bodies, subjects, sender addresses, guest details, hotel details, payment data, credentials, or secrets. A fixed `since` and `asOf` produce a deterministic cache key, so an operations health endpoint may cache the same read-only result for a short interval.

`alertFingerprint` is a separate stable SHA-256 signal for recurring operations. It hashes only the active missing-identity set and stable incomplete-pipeline archive identifiers. Unlike `cacheKey`, it does not change merely because `asOf`, age buckets, or query counters change.

The loader also covers an authenticated new-reservation identity found in `normalizedReservation` when its top-level archive copy is only partially finalized. Reservation candidates are loaded through separate indexed canonical, cross-transport, alias, and authenticated-link queries and unioned under one shared unique-document limit; the recurring path does not use a broad Reservation `$or` scan.

## Recurring detection recommendation

Run the CLI after every inbound deployment and on a short recurring schedule. Alert on exit code `2`, and alert separately on exit code `1` because an incomplete audit must never be interpreted as clean. Keep the all-time May 12 start for the comprehensive check; a shorter window may be used only as an additional fast signal.

The versioned, aggregate-only wrapper and non-installed systemd templates are documented in `docs/ops/ota-inbound-coverage-monitor-2026-08-13.md`. The proposed schedule is a seven-day check every five minutes plus the comprehensive check daily. The wrapper retains no manual report and makes no vendor/API call.

Before resolving an alert, verify the authenticated archive, all lifecycle emails, canonical/cross-transport identity ownership, and the absence of an existing Reservation. Recovery is a separate reviewed operation and is intentionally outside this auditor.
