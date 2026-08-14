# OTA inbound commercial-null incident — 2026-08-13

## Current operating contract

HotelRunner API access remains cancelled and disabled. The master switch and all
four legacy HotelRunner execution gates must remain explicitly `false`, and the
HotelRunner worker must remain disabled and inactive. A HotelRunner-originated
email is private audit evidence only: it must never create, price, update, or
cancel a PMS reservation. Direct authenticated OTA email remains the sole active
automatic OTA reservation lifecycle transport.

## Incident

Agoda booking `2041108213` was represented by PMS reservation `2207032113`, but
its commercial values were unavailable. The reservation screen therefore showed
SAR 0 for guest gross, payout, and OTA expense while retaining the SAR 75 hotel
base, which produced a misleading SAR -75 platform margin.

This was not missing email delivery and was not caused by missing Agoda values.
The authenticated direct Agoda email arrived first and contained a complete,
internally consistent one-room/one-night tuple:

- guest gross: SAR 60.76;
- hotel payout: SAR 37.60;
- OTA expense: SAR 23.16;
- explicit Agoda commission: SAR 9.11;
- other explicit deductions: SAR 6.08 and SAR 2.28;
- unclassified gross-to-payout remainder: SAR 5.69; and
- hotel base: SAR 75.00.

The direct email was falsely held for manual review because its plain-text MIME
wrapped `Reference sell rate (incl. taxes & fees)` across a line break, while the
HTML representation kept the label on one line. The label-presence check handled
the whitespace, but the amount extractor did not, so equal SAR 60.76 evidence was
mistaken for a MIME conflict.

About one minute later, an authenticated HotelRunner relay email for the same
Agoda identity arrived. Because the HotelRunner integration master switch was
off, the preliminary controller gate returned before classifying the message as
relay audit-only. It then fell through to ordinary OTA reconciliation. That relay
contained only SAR 37.60, which is the hotel payout rather than the Agoda guest
gross. Commercial authority correctly refused to promote it, but the legacy
unmapped creation path still created the review reservation with null commercial
totals.

A bounded production audit found this was the only active OTA-email reservation
with the same complete-commercial-evidence/materialization failure in the
reviewed release window.

## Permanent prevention

The fix is general and does not special-case a booking value:

1. Agoda label extraction now tokenizes and escapes label words, joining them
   with flexible whitespace. Equivalent MIME line wrapping is accepted, while
   unequal money, stay, room, guest, or deduction evidence remains fail-closed.
2. Every authenticated HotelRunner transport email is classified terminally as
   `hotelrunner_relay_audit_only`, independent of API feature flags, embedded OTA
   identity completeness, or lifecycle intent.
3. Relay audit-only deliveries never enter inline reconciliation, HotelRunner
   queues, AI/FX work, OTA notifications, important-email forwarding, or any
   Reservation mutation. Their dedupe claim is terminal and non-reclaimable.
4. The shared reconciliation service independently rejects authenticated
   HotelRunner transport before queue, database, conversion, or mutation work,
   protecting manual and script callers as well as the HTTP controller.
5. Coverage report version 4 adds a read-only financial-completeness backstop. It
   alerts when an active/pending OTA-email-created reservation is represented by
   identity but failed to materialize positive, source-backed, verified direct-OTA
   gross or payout evidence. Aggregate recurring monitor state remains PII-free.

## Existing-row repair boundary

The existing reservation is repaired only through the dated, dry-run-by-default
utility `scripts/recoverAgoda2041108213Commercial20260813.js`. The utility pins
the exact reservation, direct archive, relay archive, hotel, room configuration,
stay, authentication, immutable content hashes, null-commercial baseline, and
version/timestamp state. It reparses the authenticated direct Agoda archive and
uses the ordinary OTA commercial-refresh reconciler with outbound HTTP blocked.

Apply requires an unexpired dry-run proof and exact repair ID. Immediately before
the one atomic Reservation update it repeats the full scope check and adds an
immutable recovery marker. It then links/finalizes only the direct Agoda audit.
The historical HotelRunner relay audit remains byte-equivalent and truthful.
Lost acknowledgement is idempotently recoverable, and any concurrent drift stops
the operation rather than broadening it.

The intended repair changes only commercial/provenance fields required by the
verified direct email. It preserves the PMS number, hotel, stay, guest totals,
room count, canonical room mapping, physical-room assignment state, OTA review
lifecycle, and SAR 75 hotel base.

## Verification requirements

Before publication or repair:

- run the complete OTA inbound and HotelRunner regression suites;
- run focused controller, mapper, dedupe, classifier, coverage, and repair tests;
- verify the production checkout is clean and exactly matches the reviewed merge;
- verify all HotelRunner gates are false and its worker is disabled/inactive;
- generate a fresh production dry-run proof after deployment; and
- inspect the proof before the single guarded apply.

After repair:

- read back the reservation and both inbound audits;
- require gross SAR 60.76, payout SAR 37.60, OTA expense SAR 23.16, hotel base
  SAR 75.00, and platform margin SAR -37.40 across top-level, admin, summary, and
  nightly aliases;
- require exactly one room row with one August 18, 2026 nightly row;
- require the direct audit to link to the existing PMS reservation and the relay
  audit to remain unchanged;
- rerun the repair dry-run and require `already_applied_noop`;
- rerun recent and full OTA coverage and require no unexplained active issue;
- verify PM2 health/logs, OTA inbound health, public site health, and the complete
  HotelRunner-off boundary without making a vendor request.

The exact merged and deployed revision, proof/apply result, and post-production
checks are recorded only after those operations complete; source text alone is
not deployment evidence.
