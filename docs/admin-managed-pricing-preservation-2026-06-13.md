# Admin-managed pricing preservation runbook

Date: 2026-06-13

## Why this exists

Admin-managed OTA/Jannat Employee reservations can have a private pricing split:

- Client-facing total and nightly price
- Hotel/root total and nightly price
- OTA expense
- Platform margin
- General commission

Normal reservation edits must not rewrite that split. Date, source, guest, status,
comment, payment, and other non-pricing saves should preserve the existing pricing
distribution unless the user intentionally saves the pricing modal.

## Incident reference

Confirmation `7183544960` was accidentally rewritten by a regular reservation
edit. The saved audit trail showed the correct previous split:

- Client total: `766.08`
- Hotel/root total: `490.00`
- OTA expense total: `203.08`
- Platform margin total: `73.00`
- Commission: `70.00`

The bad save inverted the client/root totals because the general edit form sent
daily pricing rows even though the user was not intentionally editing pricing.

## Backend invariant

`controllers/reservations.js` now treats `adminPricingVisibility.rootOnlyForHotelManagement === true`
as a strict lock.

- General edits may include stale pricing fields from the frontend, but the
  backend strips those derived pricing fields before normalization.
- A platform admin/SUPER Admin pricing update is accepted only when the payload
  includes an explicit pricing intent flag and complete `pickedRoomsPricing`.
- Date changes without pricing intent project the existing admin-managed daily
  pricing across the new stay dates instead of recalculating from hotel calendar
  defaults.
- Material room/hotel selection changes without pricing intent are rejected so
  the user must use the pricing modal and save a complete daily split.
- Hotel-management updates cannot accidentally change client-facing totals for
  admin-managed pricing. Non-pricing saves preserve the stored client/root split.

Accepted pricing intent flags:

- `__adminPricingUpdateIntent`
- `__pricingUpdateIntent`
- `pricingUpdateIntent`

The controller deletes these flags before persisting anything.

## Frontend contract

Only admin edit components that actually receive an update from the pricing
modal should send `__adminPricingUpdateIntent: true`.

Files updated:

- `hotels_frontend/src/AdminModule/AllReservation/EditReservationMain.js`
- `hotels_frontend/src/HotelModule/HotelReports/EditReservationMain.js`

Both files reset the local pricing intent state whenever a different reservation
loads and after a successful save.

## Verification checklist

For an admin-managed reservation:

1. Edit guest/source/status/comment only.
2. Confirm `total_amount`, `sub_total`, `adminPricing`, `pickedRoomsType`, and
   `pickedRoomsPricing` remain unchanged.
3. Edit dates only.
4. Confirm existing nightly client/root/OTA/margin split is projected to the new
   stay dates and does not revert to hotel calendar defaults.
5. Edit pricing through the pricing modal.
6. Confirm the saved payload includes `__adminPricingUpdateIntent: true` and the
   new `pickedRoomsPricing`/`adminPricing` values persist.
7. From hotel-management routes, confirm non-pricing updates do not change the
   client-facing total.

## Production correction

Applied after deploying backend commit `b4fa381` and frontend commit `55af358`.
Backend commit `560d4e5` then tightened same-night-count date shifts so the
existing pricing rows are projected by row order, preserving the adjusted final
night instead of cloning the nearest date and introducing one-halala drift.

Production read-back after correction:

- Reservation id: `6a2af2c06f49b37157452ab4`
- Confirmation: `7183544960`
- Check-in/check-out kept as the user's latest date change: `2026-06-10` to
  `2026-06-17`
- Booking source kept as the user's latest source change: `jannat employee`
- `total_amount`: `766.08`
- `sub_total`: `490.00`
- `commission`: `70.00`
- `adminPricing.clientTotal`: `766.08`
- `adminPricing.rootTotal`: `490.00`
- `adminPricing.netAfterExpensesTotal`: `563.00`
- `adminPricing.otaExpenseTotal`: `203.08`
- `adminPricing.platformMarginTotal`: `73.00`

The latest `reservationAuditLog` entry was written with:

- `action`: `pricing_restore`
- `field`: `admin_managed_pricing`
- `reason`: restored the exact audited pricing split after same-length date
  shift rounding drift.

Final read-back confirmed the nightly rows cover `2026-06-10` through
`2026-06-16`, with the final row keeping `netAfterExpenses: 80.42`,
`otaExpenseAmount: 29.02`, and `platformMargin: 10.42` so totals remain exact.

## 2026-06-15 OTA sync and edit-pricing hardening

The Expedia reservation sync work tightened this same invariant for both new
OTA-created reservations and existing admin-managed reservations opened from
`/admin/all-reservations`.

New OTA sync reservations:

- Store PMS-facing values in SAR.
- Use Expedia `Total guest payment` as the client/main total.
- Use Expedia `Your total payout` / `Amount to charge Expedia Group` as net
  after OTA expenses when available.
- Build hotel/root total from PMS room pricing: calendar `rootPrice`, then
  calendar `price`, then room `defaultCost`, then room `price.basePrice`.
- Default General commission to 10% of the hotel/root total, not the Expedia
  client total.

Existing admin-managed reservations:

- OTA sync must not overwrite `total_amount`, `sub_total`, `commission`,
  `financial_cycle`, `pickedRoomsType`, `pickedRoomsPricing`, `adminPricing`,
  payment fields, or hotel assignment.
- Sync may apply only terminal status changes such as cancelled/no-show when the
  PMS document already exists.
- Non-pricing edits in `EditReservationMain` preserve the saved explicit
  commission for admin-managed pricing unless a SUPER Admin intentionally edits
  commission.
- The shared `EditPricingModal` keeps `totalPriceWithoutCommission` aligned with
  `rootPrice` during client-price edits, distribution, and inherit-first-row
  actions. It must never silently copy client/main price into the hotel/root
  bucket.

Reference example still protected by this invariant:

- Reservation id: `6a2af2c06f49b37157452ab4`
- Confirmation: `7183544960`
- Client total: `766.08`
- Hotel/root total: `490.00`
- Net after OTA expenses: `563.00`
- OTA expense total: `203.08`
- Platform margin: `73.00`
- General commission: `70.00`

The MoreDetails summary for that reservation is the source of truth. Opening
Edit Pricing must prefill the same split and saving unrelated fields must not
mutate any nightly money row.
