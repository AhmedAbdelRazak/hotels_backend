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
- `OTA_AIRBNB_EMAIL_HOTEL_MAP` for Airbnb inbound email hotel mapping.
  Use semicolon-separated entries such as
  `host:Salaam Marwa=68da202900a070e8123c27c4`. Supported source prefixes
  are `host:`, `listing:`, `title:`, `to:`, and `from:`. Values may be a PMS
  hotel `_id` or a hotel name. Unknown Airbnb hosts/listings remain saved as
  inbound audits and routed to review instead of creating a reservation in an
  uncertain hotel.
- Optional timing/cap controls:
  - `OTA_EXPEDIA_SYNC_MAX_RUN_MS`
  - `OTA_EXPEDIA_SYNC_BASE_RUN_MS`
  - `OTA_EXPEDIA_SYNC_RUN_MS_PER_HOTEL`
  - `OTA_EXPEDIA_SYNC_MIN_RUN_MS`
  - `OTA_EXPEDIA_SYNC_MAX_DYNAMIC_RUN_MS`
  - `OTA_EXPEDIA_COLLECTOR_HARD_TIMEOUT_MS`
  - `OTA_EXPEDIA_SYNC_MAX_RESERVATIONS_PER_HOTEL`
  - `OTA_EXPEDIA_SYNC_MAX_DETAIL_PAGES_PER_HOTEL`
  - `OTA_EXPEDIA_SYNC_KEEP_AUDIT_SCREENSHOTS`

If `OTA_EXPEDIA_SYNC_MAX_RUN_MS` is set, it remains a fixed override for the
collector's soft run budget. Otherwise the collector computes a dynamic budget
from the selected hotel count:

```text
soft run budget = OTA_EXPEDIA_SYNC_BASE_RUN_MS + selected hotels * OTA_EXPEDIA_SYNC_RUN_MS_PER_HOTEL
```

The defaults are 30 seconds base plus 90 seconds per selected hotel, with a
minimum of 55 seconds and a default dynamic cap of 20 minutes. The hard browser
timeout defaults to the larger of 12 minutes or the soft run budget plus 2
minutes, unless `OTA_EXPEDIA_COLLECTOR_HARD_TIMEOUT_MS` is set.

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

## Guest metadata capture

OTA-created reservations should preserve guest metadata when the OTA source
actually provides it:

- Guest nationality/country is saved to `customer_details.nationality`.
- Guest notes, comments, remarks, messages, or special requests are saved to
  `comment` and mirrored to `booking_comment`, matching the OrderTaker/import
  reservation shape.
- The same values are preserved under `supplierData.otaNationality` and
  `supplierData.otaGuestNotes` for audit/debugging.

For general OTA inbound emails, the deterministic parser reads common labels
such as `Nationality`, `Guest nationality`, `Guest notes`, `Special request`,
`Booking note`, `Comments`, and `Remarks`. The AI fallback may also return
`guestNotes` / `comment`, but those values are accepted only when the text
appears in the email body.

For Expedia dashboard sync, the collector reads the visible detail-page labels
and the embedded Expedia `jsonPayload` when available. Expedia placeholder
values such as `N/A`, `Not provided`, `None`, or empty booking notes are ignored
so they do not overwrite meaningful PMS data.

Existing PMS reservations keep employee-managed comments authoritative. OTA
updates fill `comment` / `booking_comment` only when those fields are empty; if
an OTA note arrives later for an existing reservation, it is still retained in
`supplierData.otaGuestNotes`.

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

When Expedia payout is missing for an Expedia Collect dashboard-sync candidate,
the apply step must keep the candidate in review instead of auto-creating with a
generic fallback. When payout is present, payout wins.

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

## OTA inbound email pricing fallback

The generic OTA inbound email mapper shares the same admin pricing buckets, but
its fallback is provider-aware:

- Expedia Collect inbound emails may auto-create when the rest of the
  reservation payload is complete. If Partner Central payout lookup is
  unavailable and no explicit payout is captured, the fallback sets
  `netAfterExpensesTotal = clientTotal`, making OTA expense zero for that
  email-created reservation.
- Non-Expedia OTA inbound emails may still auto-create when the rest of the
  reservation payload is complete. If no explicit OTA payout is captured, the
  default `netAfterExpensesTotal` is `clientTotal - 20%`, configurable through
  `OTA_INBOUND_EMAIL_DEFAULT_DEDUCTION_RATE` or `OTA_EMAIL_DEFAULT_DEDUCTION_RATE`.
- Non-email and non-inbound fallback pricing keeps the older
  `OTA_REVIEW_DEFAULT_DEDUCTION_RATE` behavior, defaulting to 10%.

`Quadruple`/`Quad` Expedia room labels can map safely to the PMS quad room type.
The mapper still prefers a confident PMS room match; semantic room fallback is
used only when no confident room config is available.

## Admin pricing preservation

Admin-managed pricing remains authoritative after creation. For reservations
with `adminPricingVisibility.rootOnlyForHotelManagement === true` or an OTA /
admin three-price mode:

## Collector Reliability Notes

- The Expedia collector must prefer the legacy reservation detail URL
  (`legacyReservationDetails.html?...reservationIds=...`) for payout/pricing.
  The modern drawer is only a fallback. If the drawer fallback is needed, the
  collector must prefer the actual `See all reservation details` button;
  full-screen drawer/backdrop nodes can contain the same text but must not be
  clicked as the target.
- Browser/login reads are bounded with short timeouts so a stuck Expedia login
  renderer returns `needs_login` or `collector_failed` instead of leaving the job
  in `running` forever.
- Existing preview jobs keep their captured payload. After collector click or
  parsing fixes, prepare and run a fresh frontend sync so payout is re-read from
  Expedia.

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
- limit date entry automation to editable date text inputs. Expedia names the
  radio group `dateTypeFilter`; the old generic selector could treat those
  radio buttons as date fields and leave the real From/To inputs empty.
- de-duplicate button text before matching commands such as `Apply`, because
  Partner Central can expose a button as `Apply Apply` when `innerText` and
  `textContent` are joined.
- scope booking parsing around the reservation number before extracting dates
  or status. This prevents filter/header text such as `Cancelled on` or the
  selected date range from being mistaken for the row's reservation status and
  stay dates.
- retry the full login-to-property-discovery segment when Expedia destroys a
  page execution context during redirects.

This fix is intentionally read-only until the normal apply step. It should make
the Zad Al Qimma run reach `preview_ready` and show `2485791085` as a new
candidate if Expedia still exposes the row with enough required data.

Final read-only verification on the home server:

- Job: `OTA-RES-SYNC-20260616060923-1QTHA`
- Status: `preview_ready`
- Expedia property match: `Al-Qemma Hotel` / `120208625`
- Preview result: `newReservations: 1`, `matchedExisting: 1`,
  `paymentOrVccAvailable: 2`, `appliedWrites: 0`
- Captured new candidate: `2485791085`, guest `Rowena Indasan`, stay
  `2026-06-17` to `2026-06-23`, booked `2026-06-16`, room
  `Comfort Triple Room, City View`, source amount `132.62 USD`
- No Save Safe Writes/apply call was run during this verification.

Follow-up payout capture hardening:

- A later run `OTA-RES-SYNC-20260616171552-ZCRC3` reached the modern Expedia
  drawer for `2485791085` but stopped at the `Payment summary` card; the apply
  guard correctly returned `apply_needs_review` with `appliedWrites: 0` because
  `Your total payout` was still missing.
- The collector payment expander now prefers the visible `See payment details`
  control, clicks it with real mouse events plus a DOM fallback, and waits only
  for detailed payout labels such as `Your total payout`,
  `Amount to charge Expedia Group`, Expedia compensation, accelerator, or
  nightly-rate rows before treating the payment panel as open. If the modern
  drawer still does not expose payout, it clicks `See all reservation details`
  and parses the full legacy details page before allowing the apply guard to
  create anything.
- Expedia can open `See all reservation details` in a new browser tab/window.
  The collector now watches for a legacy detail page matching the same
  reservation ID, switches scraping to that page, and parses payout from there
  instead of continuing to read the old modern drawer.
- On the legacy details page, Expedia may render the payout card visually while
  omitting those labels from `document.body.innerText`. The collector now also
  reads Expedia's embedded `jsonPayload.bookingAmounts` data and formats the
  structured `TOTAL_BOOKING_AMOUNT`, `EC_COMMISSION`, accelerator, tax, and
  `AMOUNT_TO_CHARGE_EXPEDIA_GROUP` values into the same payment parser. For
  reservation `2485791085`, that payload exposed `Total guest payment`
  `132.62 USD` and `Your total payout` `101.12 USD`.

## 2026-06-20 AlSukareya row identity hardening

Production preview job `OTA-RES-SYNC-20260620062847-KG5LQ` did read Expedia
reservation `2487038094` for guest `JAMIU MAJOLAGBE` under `AlSukareya HOTEL`,
but the preview incorrectly placed it in `matchedExisting`. The row/detail
candidate carried an unrelated neighboring reservation number, `2474052067`, as
`hotelConfirmationNumber`; duplicate protection then matched the wrong PMS
reservation before the new candidate could appear.

The collector and apply guard now share stricter Expedia identity rules:

- Expedia reservation ID remains the primary identity.
- Hotel confirmation numbers are accepted only from a clear table confirmation
  cell or a labeled detail value such as `Hotel confirmation code`.
- Detail values such as `Submit`, `Edit`, or empty placeholders are ignored.
- Itinerary numbers are accepted only when they are labeled as `Itinerary
  number`.
- Unlabeled alternate numbers from broad DOM containers are ignored during both
  preview classification and Save Safe Writes.

Read-only verification against the old preview payload showed the bad lookup
`2474052067` is no longer used; with the new rules JAMIU is checked by
`2487038094` and labeled itinerary `72075643558909`, neither of which exists in
PMS at the time of the audit.

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
