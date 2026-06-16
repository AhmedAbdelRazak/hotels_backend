# OTA reservation sync and Expedia collector runbook

Date: 2026-06-15

## Scope

This document covers the on-demand OTA reservation sync work added for Expedia
Partner Central. The architecture is intentionally OTA-general, but Expedia is
the first provider wired end to end.

The sync is not a background cron. A SUPER Admin starts it from
`/admin/all-reservations`, selects the hotel(s), runs a supervised read-only
collector, reviews the preview buckets, and only then clicks Save Safe Writes.

## Frontend entry point

- Route: `/admin/all-reservations`
- File: `hotels_frontend/src/AdminModule/AllReservation/EnhancedContentTable.js`
- Main modal title: `OTA Reservation Sync`
- Main actions:
  - Prepare Sync
  - Run Read-only Collector
  - Submit Expedia verification code when MFA is required
  - Save Safe Writes

The modal must stay wide, centered, and above the admin top navbar. Its confirm
dialogs use a higher z-index than the main sync modal so the Save Safe Writes
confirmation cannot appear behind the job panel.

Hotel selection is checkbox-based. The user can sync one hotel, all hotels, or
any subset. This matters because the Expedia browser session is intentionally
single-session and sequential: one hotel is opened, processed, and then the
collector moves to the next selected hotel.

## Backend route map

General OTA endpoints:

```text
POST /api/admin/ota-reservation-sync/jobs/:userId/prepare
GET  /api/admin/ota-reservation-sync/jobs/:userId/:jobId
POST /api/admin/ota-reservation-sync/jobs/:userId/:jobId/run
POST /api/admin/ota-reservation-sync/jobs/:userId/:jobId/mfa
POST /api/admin/ota-reservation-sync/jobs/:userId/:jobId/apply
```

Expedia aliases are kept for compatibility:

```text
POST /api/admin/expedia-reservation-sync/jobs/:userId/prepare
GET  /api/admin/expedia-reservation-sync/jobs/:userId/:jobId
POST /api/admin/expedia-reservation-sync/jobs/:userId/:jobId/run
POST /api/admin/expedia-reservation-sync/jobs/:userId/:jobId/mfa
POST /api/admin/expedia-reservation-sync/jobs/:userId/:jobId/apply
```

Important backend files:

- `routes/expedia_reservation_sync.js`
- `controllers/expedia_reservation_sync.js`
- `models/ota_reservation_sync_job.js`
- `services/expediaReservationSync.js`
- `services/expediaReservationCollector.js`
- `services/expediaReservationApply.js`
- `services/otaReservationMapper.js`

Only SUPER Admin / platform admin actors with the proper admin reservation
access should be able to prepare, read, run, submit MFA for, or apply sync jobs.

## Configuration

The collector reads credentials only from server environment variables. The
frontend must never send passwords, cookies, tokens, or session data.

- `OTA_EXPEDIA_USERNAME`
- `OTA_PASSWORD`
- `OTA_INBOUND_EMAIL_HOTEL_IDS`
- Optional timing/cap controls:
  - `OTA_EXPEDIA_SYNC_MAX_RUN_MS`
  - `OTA_EXPEDIA_SYNC_MAX_RESERVATIONS_PER_HOTEL`
  - `OTA_EXPEDIA_SYNC_MAX_DETAIL_PAGES_PER_HOTEL`
  - `OTA_EXPEDIA_SYNC_KEEP_AUDIT_SCREENSHOTS`

`OTA_INBOUND_EMAIL_HOTEL_IDS` is reused for Expedia sync hotel allowlisting so
the same PMS-to-OTA mapping behavior used by inbound OTA email is respected.
Allowlisted inactive PMS hotels are still included when the hotel document
exists, because OTA sync must be able to capture their Expedia reservations.

The hotel count shown in the modal is not hardcoded. It comes from the backend
job target hotel list and, after login, the Expedia property list discovered on
the Partner Central manage-property page.

## Read-only collector behavior

The collector uses a persistent browser profile so Expedia login can survive
between runs on the HomeServer. If Expedia asks for login, the backend attempts
to sign in with the configured environment credentials. If MFA appears, the job
moves to `needs_mfa` and the frontend shows an input field so the SUPER Admin
can submit the code into the running collector.

If the stored credentials cannot complete login, the job moves to `needs_login`
or `needs_manual_verification`. In that case a manual sign-in on the server's
persistent browser profile may be required before running the job again.

The collector should:

- use one browser/session, not multiple parallel browsers;
- process selected hotels sequentially;
- avoid aggressive refresh loops;
- keep the job under the configured max run window where possible;
- never save reservations during the read-only phase;
- write only job status, preview buckets, and safe audit metadata.

Expedia page flow observed and supported:

1. Open Partner Central.
2. Read the manage-property list and property IDs.
3. Match Expedia properties to PMS hotels using the same name-expansion logic as
   OTA inbound mapping.
4. Open the reservations/bookings page for a property.
5. Apply the selected date range.
6. Read table rows.
7. Open the reservation drawer/details.
8. Open the legacy reservation details page when available.
9. Expand and parse payment details, including nightly details.

The payment parser specifically looks for labels such as:

- `Nightly rates`
- `Taxes`
- `Total guest payment`
- `Expedia Group's compensation`
- `Your total payout`
- `Amount to charge Expedia Group`

`Your total payout` is the preferred source for PMS net-after-OTA-expenses.

## Preview buckets

Preview buckets exist so the user can inspect what will happen before any write:

- `newReservations`
- `skippedCancelled`
- `matchedExisting`
- `statusChanged`
- `conflicts`
- `needsReview`
- `paymentOrVccAvailable`

Cancelled/no-show reservations are not created as new PMS documents. If a
reservation already exists in PMS and Expedia later shows it as cancelled or
no-show, the apply phase may update only the terminal status while keeping the
existing document.

## Safe apply policy

Apply is intentionally narrow:

1. Create new non-cancelled Expedia reservations that have enough required data.
2. Update existing reservations only for safe terminal status changes:
   cancelled or no-show.

For existing matched reservations, sync must not overwrite employee-managed
pricing or operational fields. In particular, do not overwrite:

- `total_amount`
- `sub_total`
- `commission`
- `financial_cycle`
- `pickedRoomsType`
- `pickedRoomsPricing`
- `adminPricing`
- payment fields
- hotel assignment
- any nightly admin-managed pricing rows

For existing reservations, Expedia amounts and payout signals can be preserved
only as safe audit metadata under `supplierData` / OTA summary fields where the
mapper already allows it. The user-facing and hotel-facing money split remains
owned by the PMS after employees have adjusted it.

Duplicate protection checks Expedia reservation ID, hotel confirmation number,
itinerary number, PMS confirmation number, and normalized alternate confirmation
values through `findReservationByOtaConfirmation`.

## New-reservation pricing policy

All PMS-facing amounts must be stored/displayed in SAR. Source USD amounts may
be retained in safe metadata for audit, but admin/hotel UI totals must use SAR.

For a new Expedia-created reservation:

```text
clientTotal = Expedia Total guest payment converted to SAR
netAfterOtaExpenses = Expedia Your total payout converted to SAR
otaExpenseTotal = clientTotal - netAfterOtaExpenses
hotelBaseTotal = sum of PMS room root/base prices for each night
generalCommission = 10% of hotelBaseTotal
platformMargin = netAfterOtaExpenses - hotelBaseTotal
```

When Expedia payout is missing, the mapper may use the configured default OTA
review deduction fallback. When payout is present, payout wins.

Hotel base/root fallback for each night follows the PMS checkout idea:

1. Room calendar `rootPrice`
2. Room calendar `price`
3. Room `defaultCost`
4. Room `price.basePrice`

This is why the hotel base total may be much lower than the Expedia client
total. The client paid total, Expedia payout, OTA expense, hotel-visible root,
platform margin, and general commission are separate buckets.

Nightly rows must preserve these fields:

- `clientPrice` / `mainPrice` / `price`
- `rootPrice`
- `totalPriceWithoutCommission` aligned with `rootPrice`
- `netAfterExpenses` / `netAfterOtaExpenses`
- `otaExpenseAmount`
- `platformMargin`
- `commissionRate`

`Quadruple`/`Quad` Expedia room labels can map safely to the PMS quad room type.
The mapper still prefers a confident PMS room match; semantic room fallback is
used only when no confident room config is available.

## Admin pricing preservation

Admin-managed pricing remains authoritative after creation. For reservations
with `adminPricingVisibility.rootOnlyForHotelManagement === true` or an OTA /
admin three-price mode:

- MoreDetails should show the saved PMS split.
- Edit Pricing should prefill from saved nightly rows.
- Changing client/main price must not rewrite root/base price.
- General reservation edit must preserve an explicit saved commission unless a
  SUPER Admin intentionally changes it.

The 2026-06-15 hardening fixed the shared admin pricing editor so
`totalPriceWithoutCommission` remains tied to `rootPrice` during client-price
changes, distribution, and inherit-first-row operations.

The admin full reservation editor now treats admin-managed pricing as locked
unless the pricing modal intentionally saves a new complete pricing payload. It
preserves saved commission for normal edits and mirrors explicit SUPER Admin
commission updates into `adminPricing.commissionAmount`.

## Virtual card safety

The sync may detect VCC/payment signals, but it must not persist raw virtual
card numbers, CVV, full cardholder secrets, cookies, or login/session data.
Follow the same safe-field pattern used by OTA inbound email:

- keep provider/payment model and safe amount indicators;
- keep source payout/guest-payment totals where needed for accounting;
- never store raw card data from Expedia pages;
- never expose VCC details in hotel-management views.

## HomeServer operations

The HomeServer should keep the browser profile persistent, but not leave
unbounded browser processes running. After each sync:

- the collector should close browser/page handles it owns unless waiting for MFA;
- no temporary screenshots should remain unless
  `OTA_EXPEDIA_SYNC_KEEP_AUDIT_SCREENSHOTS=true`;
- PM2 services should remain online;
- logs should show one job moving through prepared/running/preview_ready/apply;
- `/admin/ota-reservations` should remain fast because list reads use the
  optimized paginated backend query.

If Git ownership blocks server updates under `.git/objects`, fix ownership for
the repo user and then pull/deploy normally. Prefer normal commits and pulls over
force resets.

## 2026-06-16 Zad Al Qimma collector hardening

Production job `OTA-RES-SYNC-20260616053001-9ZOCY` failed before property
discovery for Zad Al Qimma with Puppeteer lifecycle errors:

```text
Protocol error (Page.navigate): Target closed
Requesting main frame too early!
```

The previous read-only Zad Al Qimma preview had successfully matched Expedia
property `Al-Qemma Hotel` / `120208625`, but it only saw the already-saved
reservation `2480268687`. PMS did not yet contain Expedia reservation
`2485791085`, and the next collector run failed before scanning the property
again, so that new Expedia booking never reached the preview buckets.

The collector was hardened without changing apply/write policy:

- close restored/stale Expedia tabs before starting a new supervised page;
- retry initial Partner Central navigation in a fresh page when Puppeteer reports
  target-closed, detached-frame, or main-frame lifecycle errors;
- make page snapshots and property extraction tolerant of pages that are still
  settling after Expedia redirects;
- scan modern Expedia row/card containers, not only table rows, so newer
  Partner Central booking-list layouts remain visible to the parser;
- recognize modern Expedia booking URLs that expose `bookingItemId=...`, in
  addition to legacy `reservationIds=...`;
- treat Expedia `Unconfirmed` rows as active, non-terminal booking candidates so
  they remain eligible for new-reservation preview and human-reviewed Save Safe
  Writes.
- add a narrow `Booked on` recent-date pass after the normal stay-date scan so
  same-day new bookings are not hidden behind Expedia pagination or broad-range
  list slicing.
- read Expedia's default `Showing your next reservations` list before the
  date-filtered passes, then keep only candidates whose stay/booked dates still
  fit the job range. This catches Partner Central rows such as reservation
  `2485791085` that are visible in the default list/detail drawer but absent
  from the broad filtered result.

This fix is intentionally read-only until the normal apply step. It should make
the Zad Al Qimma run reach `preview_ready` and show `2485791085` as a new
candidate if Expedia still exposes the row with enough required data.

## Production correction reference

Two Expedia reservations previously saved before payout parsing was tightened
were corrected without deleting documents:

- Expedia/PMS reference `2393202936`
- Expedia/PMS reference `2393202939`

Corrected accounting shape:

- Client total: `8653.05 SAR`
- Expedia payout source: `1955.13 USD`
- Expedia payout SAR at 3.75: `7331.74 SAR`
- OTA expense: `1321.31 SAR`
- Hotel base: `864.00 SAR`
- General commission: `86.40 SAR`
- Platform margin: `6467.74 SAR`

These examples confirm the important distinction:

```text
net after OTA expenses = Expedia payout
hotel base = PMS calendar/root/default room cost
general commission = 10% of hotel base
```

## Future enhancement notes

- Add other OTA providers behind the same `/admin/ota-reservation-sync/*`
  endpoints.
- Keep provider-specific selectors/parsers isolated in provider collector files.
- Add official API/channel-manager connectivity if Expedia or another OTA gives
  a supported API path later.
- Add a compact sync history page if operators need to review old jobs outside
  the modal.
- Keep any future auto-apply rules narrower than human-reviewed Save Safe Writes
  unless the business explicitly approves a broader write policy.
