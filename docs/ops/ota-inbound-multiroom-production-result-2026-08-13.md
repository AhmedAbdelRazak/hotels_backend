# OTA inbound multi-room production result — 2026-08-13

## Outcome

On 2026-08-13, production was moved from the reviewed release
`d3090b66454208c027d8558118c4ce1833039ecd` through two recovery-verifier
hotfixes, ending at `8d07453a7964f4c4fe02b520d49bd2958a385909`.
The application remains OTA-email-only. All five HotelRunner execution gates
were verified `false`, `xhotelpro-hotelrunner-sync.service` remained disabled,
inactive, and `MainPID=0`, and the public HotelRunner callback/admin surfaces
continued to return `404`.

The comprehensive authenticated-email coverage audit initially found exactly
three active/nonterminal OTA identities without a Reservation:

- Agoda `689553735`
- Agoda `689554695`
- Trip.com `1567953939695657`

It also found three identities followed by authenticated cancellations and one
expired identity. Those four were deliberately preserved without creating a
Reservation. There were no incomplete pipeline archives and no integrity flags.

## Cause and recurrence prevention

The two Agoda emails had arrived, passed aligned sender authentication, parsed
their hotel, stay, amount, payout, guests, and explicit room quantity, and were
durably archived. They were not materialized because the old guard treated any
quantity greater than one as ambiguous, even when the source contained exactly
one homogeneous room-product row.

The released parser now:

- distinguishes one homogeneous room row with quantity `2` from genuinely
  heterogeneous room blocks;
- requires text/HTML critical-field consensus and fails closed on conflicting,
  truncated, or oversized evidence;
- persists one canonical room entry per physical room, each with `count: 1`;
- cent-allocates whole-booking gross, payout, OTA expense, and hotel-base totals
  across every room-night without duplicating nightly OTA money;
- permits corrected-parser redelivery only while a review/mapping audit remains
  completely unlinked; and
- stops oversized raw MIME before `mailparser`, archives only bounded
  header/authentication evidence, and skips reservation, AI, live-FX,
  notification, and HotelRunner paths.

Coverage report version 3 retains field-local provider/confirmation provenance,
so values stored in different reservation sections can never be Cartesian-combined
into a false clean result. The production support index
`inbound_authenticated_received_at` was created online and verified against the
bounded hinted query: 343 rows returned, 563 keys/documents examined, 7 ms.

## Guarded recovery

The recovery was fixed to the three exact authenticated direct archives. It
used the ordinary OTA email reconciler, both unique OTA identity indexes,
current inventory snapshots, deterministic room mappings, no outbound HTTP,
and no HotelRunner API/client/worker path.

The first apply created Agoda `689553735` correctly, then stopped before the
other two targets because the post-insert verifier's inclusion projection had
omitted top-level `currency`. The persisted row itself passed the full strict
shape assertion (`currency=sar`); its direct audit remained unlinked, and no
duplicate was created. The projection-only hotfix expanded the evidence read to
all asserted financial, currency, review, housing, and audit fields. A new proof
then classified this row as `finalize_lost_ack_only`, performed no Reservation
mutation, CAS-linked its direct audit, and safely created the remaining two.

The completed Reservations are:

| Provider identity | PMS confirmation | Reservation ID | Room shape | Gross / payout / OTA expense / hotel base (SAR) |
| --- | --- | --- | --- | --- |
| Agoda `689553735` | `9004274978` | `6a7e57a822f36e873fa045d6` | two `doubleRooms` rows, each `count=1`, two nights each | `288.00 / 178.20 / 109.80 / 300.00` |
| Agoda `689554695` | `7775833699` | `6a7e58d1062cbae93951b4e9` | two `familyRooms` rows, each `count=1`, one night each | `176.40 / 109.16 / 67.24 / 150.00` |
| Trip.com `1567953939695657` | `4445162233` | `6a7e58d5062cbae93951b502` | two `tripleRooms` rows, each `count=1`, three nights each | `372.83 / 352.13 / 20.70 / 450.00` |

All three have exactly one primary OTA identity owner, remain in
`OTA Platform Review` with review status `pending`, and have their direct inbound
audit linked with repair ID `missed-direct-ota-email-recovery-20260813-v1`.
Known overbooking evidence for Agoda `689553735` and the Trip booking was
retained; it was not hidden or used to discard an external OTA booking.

After completion, the recovery verifier initially exposed a separate no-write
idempotence assertion: Trip's applied audit correctly displays exact-decimal SAR
`372.83`, while the pinned historical archive tuple remains SAR `372.82`. The
final hotfix makes subsequent checks rebuild only from the complete hash-pinned
dated boundary rather than reinterpret the promoted display value. The final
production dry-run reports all three actions as `already_applied_noop`.

## Final verification

- Full OTA inbound suite: `550/550` after the evidence-projection regression.
- HotelRunner suite: `532/532`.
- OTA financial/inventory suite: `55/55`.
- Focused recovery suite: `21/21` on the final production checkout.
- Public OTA inbound health: `200`.
- Public site: `200`.
- HotelRunner callback: `404`.
- HotelRunner admin API: `404`.
- Comprehensive coverage report v3: 170 represented identities, 0 active
  nonterminal misses, 0 incomplete pipeline archives, 0 integrity flags; exit
  code `0`.
- Read-only database verification: one Reservation per target; both room arrays
  have exactly two `count=1` rows; all gross, payout, expense, and root cent sums
  match their whole-booking totals; all three direct audits are linked.

## Recurring monitor installation

The reviewed recent (five-minute) and comprehensive (daily) systemd monitor
templates were installed by an administrator and independently verified:

- `xhotelpro-ota-inbound-coverage.timer`: enabled, active, and waiting; its
  initial service run exited `0` with `Result=success`.
- `xhotelpro-ota-inbound-coverage-full.timer`: enabled, active, and waiting;
  its initial service run exited `0` with `Result=success`.
- `/var/lib/xhotelpro-ota-inbound-coverage` is owned by `ahmedadmin` with mode
  `0700`; `recent.json` and `full.json` are mode `0600`.
- Both state files report `status=clean`, `auditExitCode=0`, zero active
  identities, zero incomplete pipeline archives, and zero integrity flags.
- The service journals contain only systemd start/success/resource messages;
  they contain no provider confirmation, email, guest, hotel, payment, database,
  or credential data.

After installation, `xhotelpro-hotelrunner-sync.service` was reverified as
disabled, inactive, and `MainPID=0`; all five HotelRunner execution gates
remained explicitly `false`. Installing and running the monitors did not start
or enable HotelRunner.
