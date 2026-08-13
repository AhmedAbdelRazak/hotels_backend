# OTA financial display and inventory correction — 2026-08-13

## Scope

This change was opened after reservation `5482777647` / Agoda
`2041081954` displayed unavailable nightly, gross, and net totals in the admin
reservation table even though a complete reviewed pricing tuple was stored.
The review was expanded to the paid and inventory tabs for hotel
`6a40b6a1a6efe70450536038`, inclusive date range 2026-07-15 through
2026-08-13.

The HotelRunner integration remains disabled. This correction does not call,
probe, reactivate, or depend on HotelRunner. Authenticated OTA inbound email
remains the sole active OTA lifecycle transport.

## Financial findings and active contract

The affected Agoda reservation has two legitimate generations of financial
facts:

- immutable authenticated source evidence: gross SAR 490.90 and payout SAR
  303.69;
- a later, explicitly audited OTA pricing review: gross SAR 481.20, payout/net
  SAR 297.68, OTA expense SAR 183.52, hotel base SAR 408.00, and platform
  margin SAR -110.32.

The reviewed tuple is complete and reconciles exactly across its server-owned
override marker, review actor/timestamp, reservation total, admin totals, and
eight nightly rows. The canonical display resolver now recognizes only that
strict exceptional shape. It still fails closed for incomplete, unaudited,
foreign-currency, malformed, cross-generation, or internally inconsistent
overrides. Original OTA evidence remains immutable and is not rewritten.

Expected admin-table values for this reservation are:

- nightly gross: SAR 60.15;
- gross total: SAR 481.20;
- net total: SAR 297.68.

The paid report deliberately keeps payment-ledger facts separate from booking
gross/net facts. For the audited range, the payment cards add exactly to SAR
91,933.06. This total is not expected to equal gross or net. No payment value
or employee-entered amount is changed by this release.

Before this correction, the canonical financial subtotal excluded two rows.
The audited Agoda override becomes available. A cancelled Trip row
(`3977450949` / `1539366680929675`) remains unavailable because a later
non-authoritative cancellation-request email had overwritten its canonical
commercial evidence with a partial, different generation. That historical row
is not auto-repaired without reservation-specific authorization. The inbound
mapper is corrected so future non-authoritative updates stage their proposed
evidence for review without replacing canonical evidence; authoritative
refreshes continue to persist the evidence built with their complete pricing
document.

Expected post-release paid scorecards for the 425-row screenshot snapshot,
before any separately authorized Trip repair, are:

- paid: SAR 91,933.06 (unchanged);
- net: SAR 75,077.92, 424/425 financially included, one unavailable, one net
  fallback;
- gross: SAR 93,049.56, 424/425 financially included, one unavailable.

The report is live: bookings added after the screenshot legitimately change
the row count and totals. Deployment verification must reconcile both the
fixed 425-row snapshot and the current query result rather than force the live
report back to the screenshot totals.

The final pre-deploy read-only query contained 426 rows: paid SAR 91,981.81,
gross SAR 93,098.31, and net SAR 75,123.97, with 425 financially included,
one unavailable, and one net fallback. These values remain time-sensitive.

## Inventory findings and active contract

Three independent inventory defects were confirmed:

1. Releasing an OTA Platform Review reservation to the hotel did not explicitly
   set `pendingConfirmation.inventoryBlocks=true`. The pending reservation
   therefore did not block availability.
2. `controllers/hotel_inventory.js` interpreted UTC-midnight calendar dates in
   the production host's `America/Los_Angeles` timezone, moving some stays and
   calendar rates to the preceding day.
3. The shared status matcher treated `Finance Rejected` as if the hotel had
   rejected or cancelled the booking. In this application it is an internal
   amount/commission correction state reached only after hotel confirmation;
   the active stay must continue holding inventory.

The release action now blocks inventory atomically. Hotel confirmation,
financial-review transitions, correction resubmission, generic admin status
changes, agent resubmission, Excel import, and authenticated OTA lifecycle
updates all stamp the appropriate inventory decision. Reverting a reservation
to OTA Platform Review or moving to cancellation/no-show/hotel rejection
explicitly clears the block. Exact `Finance Rejected` remains marker-controlled
and inventory-blocking; exact hotel `Rejected` remains terminal and
nonblocking. The finance exception is localized to inventory evaluation and
does not broaden pending-queue or visibility filters.
Inventory range, day, availability, reservation-overlap, and calendar-rate
operations now use one UTC date-only basis with checkout exclusive. Stored
reservation dates are not rewritten.

The historical reconciliation utility is dry-run by default and admits only
two exact OTA-release lifecycle shapes: Pending Confirmation with a pending
hotel decision, or a hotel-confirmed financial workflow (`Pending Finance
Review`, `Pending Agent Commission Approval`, or `Finance Rejected`). Every
candidate must have a non-expired UTC stay, valid hotel and mirrored complete
room rows, a globally unique provider identity, an exact current release
audit/timestamp/actor, and a missing inventory flag. A post-confirmation row
also requires one same-actor transition triple in the immutable audit log:
reservation status, pending-confirmation object, and confirmed decision. An
explicit false flag is preserved as a deliberate decision. Apply uses a
reviewed plan/proof plus per-document version/state/audit CAS, sets only the
inventory block and a bounded audit marker, and is idempotent. Cancelled,
expired, reverted, or otherwise contradictory rows are excluded for manual
review and remain unchanged.

The final pre-deploy dry run scanned 82 tightly filtered rows and made zero
writes. It admitted 81 reservations / 89 rooms, including 71 reservations for
the selected hotel. The sole exclusion carries a historical reversion marker.
The plan includes one exact audited Pending Finance Review row and the selected
hotel's active Finance Rejected correction row. Its proof is intentionally not
recorded as an apply authorization here: deployment must generate and review a
fresh proof against the then-current database before any write.

## Verification and deployment

Required before publication:

- canonical financial resolver, projection, admin-list, and report regressions;
- complete OTA inbound regression suite, including staged versus authoritative
  evidence persistence;
- inventory calendar/day/availability tests under Pacific host time;
- release/revert inventory-lifecycle tests;
- historical reconciliation unit tests and production dry run;
- syntax and diff checks.

Required after deployment:

- verify the exact affected reservation resolves to 481.20 / 297.68 SAR from
  `audited_ota_pricing_override` in both full and report projections;
- verify the payment-ledger subtotal is unchanged for the same live row set,
  and reconcile current gross/net coverage against the documented 425-row
  screenshot snapshot rather than forcing live totals;
- verify the Trip conflict remains explicitly unavailable;
- apply only the reviewed, exact historical inventory plan, then verify an
  idempotent second dry run finds no eligible row;
- verify inventory dates and impacted occupancy/availability using UTC date
  keys;
- verify the backend and frontend are healthy, OTA-email health is healthy,
  the HotelRunner callback remains absent, and
  `xhotelpro-hotelrunner-sync.service` remains disabled/inactive.

Production observations and applied reconciliation counts must be appended
only after live verification; source changes alone are not deployment proof.
