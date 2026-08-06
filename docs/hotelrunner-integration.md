# HotelRunner integration runbook

## Purpose and boundaries

HotelRunner is a background transport only. The PMS, reports, inventory, and frontend always read the local `Reservations` collection. Callback and reconciliation deliveries are first stored durably in `HotelRunnerEvent`; a separate worker then projects validated events into the existing reservation model.

The integration does not mark HotelRunner-reported payments as locally captured, paid, transferred, or reconciled. It does not push room calendar changes to HotelRunner, confirm/cancel a reservation back to HotelRunner, or expose HotelRunner credentials to the browser.

## Required environment

Keep these values in the backend environment only:

- `HOTELRUNNER_API_TOKEN`
- `HOTELRUNNER_API_HR_ID`
- `HOTELRUNNER_SUPPORTED_HOTELIDS` — exactly one active `HotelDetails._id` for this credential

One `hr_id`/token pair identifies one HotelRunner property binding, so this phase intentionally refuses a multi-ID worker configuration. A future second property needs its own explicit credential-to-hotel binding; do not append another physical property ID to the current credential. This prevents two local hotels from silently sharing one reservation stream.

Optional safe tuning:

- `HOTELRUNNER_PULL_ENABLED` (default `true`)
- `HOTELRUNNER_PROJECTION_ENABLED` (default `false`; enable only after the bootstrap review below)
- `HOTELRUNNER_PULL_INTERVAL_MINUTES` (default `30`, minimum `15`)
- `HOTELRUNNER_ROOM_LIST_INTERVAL_HOURS` (default `24`, minimum `6`)
- `HOTELRUNNER_REQUEST_TIMEOUT_MS` (default `12000`)
- `HOTELRUNNER_PROPERTY_DAILY_BUDGET` (default `225`, hard maximum `240`)
- `HOTELRUNNER_PROPERTY_MINUTE_BUDGET` (default `4`, hard maximum `5`)
- `HOTELRUNNER_APPLICATION_MINUTE_BUDGET` (default `60`, hard maximum `75`)
- `HOTELRUNNER_CALLBACK_BODY_LIMIT_BYTES` (default `1048576`)
- `HOTELRUNNER_CALLBACK_MAX_RESERVATIONS` (default `100`)

Do not add these values to React environment variables or frontend code. Explicit pull-delivery confirmation is intentionally disabled until it can occur after a successful local projection with the real PMS number.

## HotelRunner Custom App settings

Use integration type `HR-v1`, enable **Enforce SSL**, and use:

`https://xhotelpro.com/api/hotelrunner/callback`

Enable only:

- Can fetch room list
- Can fetch reservations
- Can receive push reservation updates
  - Confirmed
  - Modified
  - Canceled

Leave **Can update room calendar** disabled for this phase.

Enter the callback as the bare URL above. HotelRunner appends the application's `token` and `hr_id` query credentials to each POST; never paste either credential into the callback field. A browser GET is only a generic health response and does not validate or generate a token.

## Safe activation order

1. Run the HotelRunner, OTA inbound, reservation/admin, and frontend regressions plus the production frontend build. These tests are synthetic and make no HotelRunner calls.
2. Take and verify a recoverable production MongoDB backup, and record baseline reservation/status counts.
3. In every connected OTA channel, repair HotelRunner room/rate mappings first; no reservation should use HotelRunner's master fallback.
4. Deploy and restart the main backend with `HOTELRUNNER_PROJECTION_ENABLED=false`, so callbacks and pulls can be archived without mutating PMS reservations.
5. Deploy the frontend and verify `/admin/hotelrunner` is accessible only to an authorized hotel administrator.
6. Confirm the reverse proxy accepts HTTPS form POSTs, preserves the query string, and redacts the entire callback query from proxy/CDN/APM logs. Browser GET health proves routing only.
7. Verify the new MongoDB unique indexes exist, then start exactly one worker with `ecosystem.hotelrunner-sync.config.js`.
8. Let its first quota-governed room-list reconciliation verify HotelRunner `inv_code` values and archive the history window.
9. Confirm room `sales_currency` and a controlled reservation currency are `SAR`. Foreign currencies are intentionally held for review.
10. Open `/admin/hotelrunner` and explicitly map every verified, non-master `inv_code` to the exact local `roomCountDetails._id`.
11. Review queued and quarantined events against the baseline, especially exact-alias modifications/cancellations from the earlier email transport.
12. Stop the worker, set `HOTELRUNNER_PROJECTION_ENABLED=true`, restart the main backend with the updated environment, and confirm `/api/hotelrunner/admin/status/...` reports `projectionEnabled: true`. Only then start exactly one worker with the same environment and verify the queue drains safely. Restarting both processes is mandatory: this same switch makes the configured HotelRunner hotel authoritative in the API, so alternate OTA inbound events remain archived but cannot create, update, or cancel its PMS reservations. Hotels outside the configured ID retain the existing OTA behavior.
13. Send one controlled create → modification → cancellation lifecycle, plus a push/pull duplicate and a multi-room case. Confirm one local reservation, correct inventory blocking, and untouched local payment/finance state.
14. Repeat a controlled reservation for each connected OTA because upstream mapping codes can differ by channel.

Unknown room codes are never guessed. A code discovered only inside a reservation payload cannot be activated until the room-list API verifies it. HotelRunner's `is_master=true` unmatched fallback is permanently blocked from automatic mapping. Held events are replayed after an administrator saves an exact verified mapping.

For the current Nginx layout, add an exact callback location before activation so query credentials never enter the general access log while the complete URI still reaches Express:

```nginx
location = /api/hotelrunner/callback {
    access_log off;
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

Validate with `nginx -t` before reloading. Do not redirect this callback because HotelRunner's query credentials must never be forwarded to another host.

## Processes

- Main API: handles the durable callback and local admin endpoints.
- `hotelrunner-sync`: one independent PM2 worker that processes local events and runs quota-limited reconciliation.

Useful commands:

```sh
npm run test:hotelrunner
npm run hotelrunner:worker:once
pm2 start ecosystem.hotelrunner-sync.config.js --update-env
pm2 save
```

The one-shot command performs one due reconciliation pull, processes the resulting local queue, and exits. It consumes real HotelRunner quota and must not be used as a test loop.

## Operational safeguards

- Callback acknowledgements happen only after durable local storage.
- Callback query credentials are removed from access logs; the complete callback query is redacted.
- Message UID and canonical payload hashes provide idempotency and conflict quarantine.
- One HotelRunner reservation has one immutable mirror link to one local reservation.
- Exact provider/HR aliases support cross-transport deduplication; ambiguous matches fail closed.
- First-time alias-only cancellations retain strict stay-date protection; an established immutable HotelRunner link can still apply a cancellation that carries revised dates after a missed modification.
- Stale direct-source events cannot overwrite a newer direct HotelRunner projection.
- Source events are processed oldest-first so creation normally precedes modification or cancellation; source watermarks still reject stale late arrivals.
- Local housing, terminal-stay, finance, and payment state is protected from source updates.
- A new `reserved` delivery creates an inventory-blocking local `Pending Confirmation` reservation. A later authoritative `confirmed` delivery promotes an untouched pending record, while a later `reserved` delivery cannot downgrade a confirmed record.
- A reservation whose currency differs from the hotel's configured currency is archived and quarantined for review; the integration never invents an exchange rate.
- Reconciliation uses a persisted multi-cycle cursor with overlap, so downtime and pagination do not reset it to a short moving window.
- Local budgets stay below HotelRunner's published property/application limits.
- Authentication failures hold the same credential fingerprint for 24 hours instead of repeatedly burning quota. Changing the credential resumes immediately. Other permanent client errors back off for six hours; transient errors retry no sooner than five minutes.
- Worker leases are recoverable. An event abandoned on its eighth ordinary claim receives one idempotent recovery pass; a second abandoned recovery becomes an explicit `failed` record rather than remaining invisibly stuck in `processing`.
- HotelRunner delivery confirmation remains disabled because that endpoint requires separate enablement and must only run after a successful local projection with the final PMS number.
- HotelRunner reservation-state updates remain disabled. `requires_response=true` is stored locally for staff visibility but no business acceptance/cancellation decision is sent automatically.

## Recovery

Stopping `hotelrunner-sync` stops all outbound HotelRunner traffic without affecting the PMS or callback storage. The callback can continue storing events. After resolving configuration or mapping issues, restart one worker; idempotent event and mirror keys prevent duplicate reservation creation. Do not repeatedly run the one-shot command as a health check because each due pull consumes real API quota.
