# External OTA virtual-card capture reconciliation

## Purpose

Use this procedure only when an Agoda, Expedia, or Booking.com virtual card was charged successfully outside Jannat Booking, currently through PayPal Virtual Terminal, and the matching reservation must show that completed USD capture.

This is a reconciliation workflow. It does **not** charge a card, retry a card, or turn a declined/pending gateway attempt into a success. The external processor must already show a completed sale.

The safe command is:

```text
node scripts/reconcileExternalVccCapture.js --stdin
```

It is read-only unless `--apply` is supplied. Every run must start without `--apply`.

## Non-negotiable safety boundaries

- Require authoritative proof that the external sale status is `COMPLETED`.
- Require currency `USD`.
- Use the PayPal Invoice ID as the OTA confirmation number. It must equal the reservation's authoritative `reservation_id` exactly.
- Require the external transaction ID to be unique across all reservations.
- Refuse any target that already contains structured captured-card evidence, unless the exact same transaction is already fully reconciled. Existing reservation accounting in `paid_amount` or `paid_amount_breakdown` is not capture evidence: those fields are SAR business records and must remain unchanged.
- Require gross amount to equal transaction fee plus net amount, to the cent.
- Require an ISO-8601 transaction timestamp with an explicit timezone/UTC offset.
- Never accept or store the full card number, CVV/CVC, expiry, billing street address, credentials, screenshots, or secret keys in the evidence JSON.
- Never infer success from a Bank of America decline, reason code, or inconclusive callback.
- Never alter reservation price, SAR accounting, room assignment, stay dates, status, guest details, or hotel assignment as part of this workflow.
- Never perform an ad hoc `updateOne` in a shell when this checked script is available.

## Evidence required from the operator

Obtain both the PayPal confirmation and transaction-details evidence when possible. Before preparing input, confirm all of the following agree:

| Evidence | Requirement | Saved destination |
| --- | --- | --- |
| Transaction status | Exactly `Completed` | `paypal_details.external_virtual_terminal.status`, linked capture status fields |
| Invoice ID | Exact OTA confirmation number | `reservation_id` lookup and all capture reference fields |
| Transaction ID | Exact PayPal transaction ID | All linked capture ID fields |
| Gross amount | Exact USD amount, including cents | Capture totals and reservation payment breakdown |
| Transaction fee | Exact USD fee | External evidence record only |
| Net amount | Exact USD net | External evidence record only |
| Date/time | Exact transaction time with source timezone | Capture timestamp fields, normalized to UTC |
| Card type | Mastercard or Visa | Sanitized external evidence record |
| Card suffix | Last four digits only | Sanitized external evidence record |
| CSC result | Exact displayed result, usually `Match` | Sanitized external evidence record |
| AVS result | Exact displayed result | Sanitized external evidence record |
| Payer name | Exact displayed payer name | Sanitized external evidence record |
| Shipping address | Whether PayPal says one is on file | Boolean only; no address is stored |
| OTA | Agoda, Expedia, or Booking.com | Cross-checked against the reservation source |

If PayPal's confirmation page and transaction-details page differ by one second, use the timestamp on the detailed transaction record and mention the discrepancy in the work report. Never guess the timezone.

For PayPal times shown as PDT in July, use `-07:00`. Example:

```text
July 25, 2026 7:29:19 PM PDT
2026-07-25T19:29:19-07:00
normalized saved value: 2026-07-26T02:29:19.000Z
```

For PST use `-08:00`. Do not label a PDT time as PST.

## Evidence JSON schema

Prepare the file outside the repository, for example in the operator's temporary directory. One reservation can be an object. Multiple reservations can be an array of objects, with a maximum of 25 per run.

```json
{
  "invoiceId": "681965411",
  "transactionId": "2U9190880F967015X",
  "status": "COMPLETED",
  "currency": "USD",
  "grossAmountUsd": "28.46",
  "transactionFeeUsd": "1.25",
  "netAmountUsd": "27.21",
  "transactionAt": "2026-07-25T19:29:19-07:00",
  "cardType": "MASTERCARD",
  "cardLast4": "5409",
  "cscResult": "MATCH",
  "avsResult": "MATCH",
  "payerName": "Agoda Company Pte Ltd",
  "shippingAddressOnFile": false,
  "provider": "agoda"
}
```

The parser rejects every unknown property. This is deliberate: a property such as `cardNumber`, `pan`, `cvv`, `expiry`, or `billingAddress` must fail rather than enter application storage or logs.

Amounts may be strings or numbers, but strings are preferred so the submitted cents are visually explicit. The validator performs integer-cent arithmetic. It does not use floating-point rounding to decide whether gross, fee, and net agree.

## Step 1: confirm deployment and repository state

Before changing data:

1. Confirm the backend working tree is clean and on the deployed commit.
2. Confirm the local backend, `origin/master`, and `/home/ahmedadmin/Hotels/hotels_backend` on `jannat` have the same commit.
3. Confirm the reconciliation tests pass:

```powershell
cd D:\JannatBooking\hotels_backend
npm run test:external-vcc-reconciliation
```

Production comparison commands:

```powershell
git rev-parse HEAD
git rev-parse origin/master
ssh jannat "git -C /home/ahmedadmin/Hotels/hotels_backend rev-parse HEAD"
```

Do not deploy or restart the frontend for a data-only reconciliation.

## Step 2: run the production dry run

Keep evidence outside the checkout. Pipe it over SSH so it is not copied into the server repository:

```powershell
Get-Content -Raw C:\secure-temp\vcc-evidence.json | ssh jannat "cd /home/ahmedadmin/Hotels/hotels_backend && node scripts/reconcileExternalVccCapture.js --stdin"
```

The report must say:

- `"ok": true`
- `"mode": "dry-run"`
- `"writesPerformed": false`
- `"action": "would_reconcile"` for every new capture
- the expected invoice, transaction, exact amount, provider, hotel, check-in, check-out, and reservation Mongo ID
- `"protectedFields": "unchanged"`

If the exact capture was already saved correctly, the dry run instead reports `"action": "existing_reconciliation_verified"` and says that no apply is needed.

Stop if any field differs from the processor evidence or the intended reservation. Do not edit the script to bypass a rejection.

The dry run independently checks:

1. The invoice matches exactly one reservation across known identity fields.
2. The invoice equals that reservation's authoritative `reservation_id`.
3. OTA source matches the supplied provider.
4. Check-in and check-out exist.
5. Hotel name resolves.
6. Transaction ID is not linked to another reservation.
7. No structured captured-card state already exists. Ordinary SAR reservation payment accounting may exist and is protected rather than overwritten.
8. Existing same-transaction data, if any, is internally complete and matches the evidence.

## Step 3: apply the identical evidence

Only after manually comparing every dry-run row with the source evidence, rerun the identical JSON with `--apply`:

```powershell
Get-Content -Raw C:\secure-temp\vcc-evidence.json | ssh jannat "cd /home/ahmedadmin/Hotels/hotels_backend && node scripts/reconcileExternalVccCapture.js --stdin --apply"
```

The command performs this sequence:

1. Repeats all validation and discovery checks.
2. Creates one full pre-change reservation snapshot in `reservation_reconciliation_backups` for each target.
3. Reads every backup back and verifies its hash before updating any reservation.
4. Re-reads every target and confirms it is byte-for-byte equivalent to its preflight state before the first reservation update.
5. Uses a conditional single-document update guarded by `_id`, authoritative `reservation_id`, original `updatedAt`, and uncaptured state.
6. Writes only the approved payment evidence paths and appends one audit entry.
7. Re-reads the saved reservation and verifies its capture summary.
8. Confirms exactly one reservation owns the transaction ID and exactly one backup exists.
9. Hash-compares protected reservation facts before and after the update.

A successful new result says `"action": "reconciled_and_verified"` and returns the sanitized capture summary. A safe identical rerun says `"already_reconciled_and_verified"` only when the exact evidence and workflow backup both exist.

MongoDB in this deployment may be standalone, so a batch is not advertised as a multi-document transaction. All backups and all preflight rechecks are completed before the first reservation update; each reservation update is atomic and compare-and-set guarded. If a batch stops partway, already completed rows remain valid and idempotent, while untouched rows can be rerun after investigation.

## Fields written

The workflow writes capture evidence only under these top-level areas:

- `payment_details`
  - captured and VCC-charged flags
  - transaction IDs
  - completed status
  - external-channel name
  - transaction timestamp
- `paypal_details`
  - USD captured total
  - normalized initial capture link
  - detailed external Virtual Terminal evidence, including fee/net, last four, verification results, and reservation metadata
- `vcc_payment`
  - OTA source
  - charged state/count
  - USD captured total
  - last success, transaction, and sanitized capture metadata
- `reservationAuditLog`
  - one appended reconciliation entry with invoice, transaction, amount, source, timestamp, and backup ID
- `updatedAt`

The stored metadata includes OTA, hotel name, OTA confirmation, PMS confirmation, check-in, and check-out. This supports traceability without storing cardholder secrets.

## Fields explicitly protected and never changed

The post-write hash check verifies that these facts remain identical:

- `reservation_id`
- `confirmation_number`
- `hotelId`
- `booking_source`
- `reservedBy`
- `checkin_date`
- `checkout_date`
- `days_of_residence`
- `pickedRoomsType`
- `pickedRoomsPricing`
- `room_numbers`
- `total_amount`
- `sub_total`
- `paid_amount`
- `paid_amount_breakdown`
- `adminPricing`
- `financial_cycle`
- `reservation_status`
- `state`
- `pendingConfirmation`
- `customer_details`

This separation is intentional. The external capture amount is USD evidence; it must not overwrite SAR guest price, existing payment breakdowns/comments, OTA payout, hotel cost, platform margin, commission, room inventory, or lifecycle state.

## Step 4: verify the application and database

After apply:

1. Run the identical command again without `--apply`; it should identify an existing verified reconciliation rather than propose another charge.
2. Open the exact reservation using its Mongo ID or search by the OTA confirmation.
3. Confirm the payment summary displays:
   - Captured
   - exact amount with two USD decimals
   - `PayPal Virtual Terminal`
   - evidence `Reconciled`
   - OTA confirmation
   - transaction ID and timestamp
4. Confirm `Enter OTA Virtual Card` is disabled for that captured reservation.
5. Confirm reservation price, dates, room, guest, status, and financial cycle did not change.
6. Check PM2 only for new errors; a data reconciliation does not require a restart:

```powershell
ssh jannat "pm2 logs hotels-backend --lines 100 --nostream"
```

The UI capture summary is recognized by `services/bofaCaptureSummary.js`. It requires all linked transaction IDs, amounts, currency, status, channel, and invoice identity to agree. Setting one loose `captured` flag is intentionally insufficient.

## Failure handling and rollback

If dry run fails, no database write occurred. Correct the evidence or investigate the reservation; never weaken the guard.

If apply reports that the document changed concurrently, run a new dry run. Another user or process updated the reservation between inspection and apply.

If post-write verification fails:

1. Stop the batch and preserve the complete command output.
2. Do not retry, charge, or manually edit the reservation.
3. Locate the backup by the returned backup ID or reconciliation key in `reservation_reconciliation_backups`.
4. Compare the current document, audit entry, `updatedAt`, and transaction ID with the backup.
5. Take another current-state backup before any rollback.
6. Restore only after confirming no legitimate change happened after reconciliation. Prefer restoring the payment paths from the backup rather than blindly replacing the entire reservation.
7. Re-run protected-field and capture-summary verification.

A blind full-document replacement can erase legitimate concurrent hotel, guest, room, pricing, or status changes and is therefore prohibited.

## GitHub and production synchronization

This runbook and its script are application code. Changes to either follow the normal branch, test, pull-request, merge, fast-forward deployment, and verification flow. Database evidence JSON and database backups are operational data and must never be committed.

Before declaring synchronization complete, compare all three backend revisions:

```powershell
git -C D:\JannatBooking\hotels_backend rev-parse HEAD
git -C D:\JannatBooking\hotels_backend rev-parse origin/master
ssh jannat "git -C /home/ahmedadmin/Hotels/hotels_backend rev-parse HEAD"
```

Also verify the frontend is independently clean and synchronized, even though this reconciliation workflow does not change frontend code:

```powershell
git -C D:\JannatBooking\hotels_frontend status --short --branch
git -C D:\JannatBooking\hotels_frontend rev-parse HEAD
git -C D:\JannatBooking\hotels_frontend rev-parse origin/master
ssh jannat "git -C /home/ahmedadmin/Hotels/hotels_frontend rev-parse HEAD"
```

## Quick future-session checklist

When asked to “update the reservation virtual-card captured payment”:

1. Read this entire runbook.
2. Verify the supplied evidence says completed, not declined/pending.
3. Map Invoice ID to the exact `reservation_id`.
4. Prepare only the allowed sanitized JSON fields outside Git.
5. Confirm gross = fee + net and use an explicit timezone.
6. Run production dry run.
7. Compare every reported identity and amount with the evidence.
8. Apply the identical input.
9. Confirm backup, uniqueness, protected-field hash, and capture summary.
10. Verify the reservation UI and disabled payment button.
11. Report the exact invoice IDs, transaction IDs, USD amounts, backup IDs, and verification outcome—never raw card data.
