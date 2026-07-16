# Expedia Web Scraping Approval Evidence - 2026-06-11

## Evidence File

- Screenshot:
  - `docs/evidence/expedia-web-scraping-approval-2026-06-11.png`

## Email Metadata Visible In Screenshot

- Sender:
  - Expedia Group Partner Central support
- Recipient:
  - Ahmed Abdelrazak
- Case:
  - `153773315`
- Account:
  - Al-Rehab Hotel `120233940`
- Visible received time:
  - 2026-06-11 7:10 AM

## Approval Summary

The screenshot shows Expedia Group support responding that web scraping jobs may be set up to synchronize with Expedia Partner Central. The key visible approval sentence is:

> Yes, you can absolutely set up Web Scraping Jobs to synchronize with Expedia Partner Central.

They also state that the integration should not disrupt the account or connection because it operates externally to Expedia Group.

## Engineering Notes

- Treat this as written support approval evidence, not as a replacement for legal/contract review.
- Preserve the original email, headers, and screenshot in case Expedia asks for escalation context.
- Any scraper should be conservative:
  - Use only authorized Expedia Partner Central credentials.
  - Avoid bypassing security controls, CAPTCHA, MFA, or access restrictions.
  - Rate-limit requests and use backoff.
  - Keep a clear audit log of sync actions.
  - Never scrape beyond the approved account/workflow scope.
  - Prefer official Expedia connectivity/API options if Expedia later provides them.

## Future Work

When building the Expedia sync scraper, start from this evidence and design the automation as a safe external synchronization job for PMS data only.

## 2026-06-15 Implementation Follow-up

The first supervised Expedia reservation sync was implemented as an on-demand
SUPER Admin workflow from `/admin/all-reservations`.

Implementation references:

- `routes/expedia_reservation_sync.js`
- `controllers/expedia_reservation_sync.js`
- `models/ota_reservation_sync_job.js`
- `services/expediaReservationSync.js`
- `services/expediaReservationCollector.js`
- `services/expediaReservationApply.js`
- `services/otaReservationMapper.js`
- Durable architecture reference: `application_structure_backend.txt`

Operating policy:

- Use one persistent browser profile/session and process hotels sequentially.
- Keep the collector read-only until a SUPER Admin reviews preview buckets.
- Apply only safe writes: new non-cancelled reservations and cancelled/no-show
  status updates for already-saved reservations.
- Preserve existing PMS pricing, commission, finance, payment, and nightly
  admin-managed pricing rows.
- Never store Expedia credentials, cookies, session tokens, or raw VCC data in a
  sync job or reservation document.
- Keep PMS-facing money in SAR while retaining source USD amounts only as safe
  audit metadata where useful.
