# HotelRunner integration: dormant architecture and OTA-email-only operating contract

## Document purpose

This is the authoritative engineering and operations document for the dormant xHotelPro HotelRunner integration. It records:

- what is implemented;
- what is deployed but deliberately inactive;
- how HotelRunner data reaches the local PMS;
- how duplicates, stale events, room mappings, credentials, and API quotas are handled;
- how HotelRunner and the existing OTA-email pipeline coexist without duplicate reservation authority;
- the controlled activation, validation, rollback, and incident procedures; and
- the 2026-08-13 retirement of the HotelRunner administration UI and the historical, deferred integration design.

This document must never contain API tokens, HR IDs, guest names, email addresses, phone numbers, reservation numbers, MongoDB IDs, raw callback URLs containing query strings, or environment-file contents. Live identifiers belong only in access-controlled operational records.

## Current operating mode — 2026-08-13: OTA inbound email only

**This section is authoritative and supersedes every earlier “current,” rollout-gate, callback, worker, admin-page, lifecycle-authority, and activation statement retained later in this document.** The later sections preserve engineering history and safeguards for a possible future, separately reviewed reactivation; they are not instructions to activate HotelRunner now.

The HotelRunner API subscription was cancelled on **2026-08-13** because its current cost is not justified. Until the owner purchases a new subscription and explicitly approves a new reviewed activation, xHotelPro operates under this contract:

- Authenticated OTA inbound email is the sole active inbound reservation lifecycle transport. Direct OTA create, update, and cancellation emails follow the existing inline OTA reconciliation path; they are not held for, queued behind, or reconciled through HotelRunner.
- `HOTELRUNNER_INTEGRATION_ENABLED=false` is the master runtime boundary. The four legacy gates must also remain explicitly false: `HOTELRUNNER_PROJECTION_ENABLED=false`, `HOTELRUNNER_PULL_ENABLED=false`, `HOTELRUNNER_ROOM_LIST_SYNC_ENABLED=false`, and `HOTELRUNNER_CONFIRM_DELIVERY_ENABLED=false`. The activation cutoff must remain blank.
- The HotelRunner callback is disabled. Both callback health and callback delivery requests must receive a generic `404` before credential authentication, body parsing, event persistence, or any HotelRunner authority decision.
- The independent HotelRunner worker's desired production state is disabled and stopped. Because the previously installed systemd unit may still have `Restart=always` and noninteractive sudo may be unavailable during deployment, a residual launch while the master boundary is false must enter an inert signal-only wait before any database connection/model, client, or vendor initialization. This prevents restart churn while guaranteeing zero leases, quota claims, database work, vendor requests, or reservation projection. Record the exact supervisor/process state only after live verification; source changes alone do not prove the unit is disabled or stopped.
- HotelRunner client construction must fail closed before quota reservation or network access while the master boundary is false. Release, health, and regression checks must use local inspection, mocks, and fixtures only. Do not make a HotelRunner authentication, room-list, reservation-history, delivery-confirmation, or other vendor request merely to test the shutdown.
- Existing HotelRunner event, mirror, mapping, source, pricing, and audit fields may remain as historical provenance. They do not have current reservation lifecycle authority, and a historical direct-projection marker must not prevent a trusted OTA email from updating or cancelling the corresponding local reservation.
- The `/admin/hotelrunner` frontend route, its English and Arabic side-menu links, its route-permission mapping, and its dedicated page/API-view-model modules are retired. No active browser UI should expose or invoke the dormant integration. Existing HotelRunner-labelled historical pricing/provenance shown inside ordinary reservation or report screens does not reactivate the integration.
- The protected backend token, HR ID, and property binding may be retained dormant for a future reviewed reactivation. Retention is not configuration readiness or permission to call the vendor. These values remain backend-only and must never be copied into React, logs, documentation, shell history, or ordinary application data.
- Reactivation requires a new paid subscription, explicit owner approval, a dated code/security/operations review, a fresh deployment plan, and deliberate reconfiguration of the master and legacy gates. Do not infer reactivation from retained credentials, historical records, old mappings, old service files, or the historical runbook below.

Required post-deployment verification must be write-safe and make **zero HotelRunner vendor calls**: confirm the five flags above and blank cutoff without printing secrets; confirm whether the worker service reached the desired disabled/stopped state; if administrator access is still needed, record the residual supervisor state and prove any residual process is in the master-disabled inert wait with no database connection/model/client/vendor initialization; confirm callback and backend admin routes return generic not-found responses; confirm the removed frontend route/menu/modules are absent from the production build; and confirm representative OTA inbound email create/update/cancel behavior continues through the normal inline path. Before shutdown, count `awaiting_hotelrunner`/`recovery_pending` inbound archives, nonterminal fallback jobs, actionable HotelRunner events, direct API-projected reservations, and pending/retry fallback notifications. Any nonzero result requires evidence-bound local-only review or recovery; never run the dormant fallback worker or call the vendor to resolve it. Record the results separately with the deployed revisions once those checks are complete; this document does not pre-claim them.

## Historical decision summary — inactive

The earlier architectural decision was **local-first, background-only synchronization**. It is retained as design provenance and is inactive under the 2026-08-13 email-only contract:

```text
OTA
  -> HotelRunner push (primary) and separately approved reconciliation pull
  -> HotelRunnerEvent (durable local inbox)
  -> hotelrunner-sync worker
  -> HotelRunnerReservation (identity/projection mirror)
  -> existing Reservations collection
  -> all existing PMS screens, reports, and local APIs
```

The browser and ordinary PMS APIs never retrieve a reservation directly from HotelRunner. In the historical design HotelRunner was a background transport; in the current mode it is not a transport at all. MongoDB remains the operational source of truth for xHotelPro.

The former inbound rollout was intentionally separate from the proposed outbound availability/rate phase. The following bullets are historical safeguards, not permission to resume rollout:

- `HOTELRUNNER_PROJECTION_ENABLED=false` was the original safety gate;
- **Can update room calendar** was kept disabled in HotelRunner;
- the independent worker was held until credential rotation and mapping approval;
- an explicit room-list-only command was designed to discover mappings while pull and projection remained off;
- the existing OTA-email pipeline remained active for reservations not directly projected by HotelRunner; and
- no real guest reservation was to be used as a destructive test.

The current contract is stricter: the master boundary and all four legacy gates are false, no HotelRunner discovery or test call is allowed, and OTA inbound email owns lifecycle handling for every supported OTA reservation.

## Important interpretation of the live fallback incident

A real HotelRunner push failed while production still had the earlier backend behavior. A redacted read-only review of the historical Nginx logs later proved the transport cause: 17 callback `POST` requests reached the exact path during the incident window and all returned `404`; the one callback token value in those requests matches the current backend credential, without printing either value. HotelRunner then placed the reservation in its email fallback path. The existing OTA-email pipeline created one local reservation, and a later cancellation email updated that same local record instead of creating a duplicate.

That is valuable evidence, but its meaning must be stated precisely:

- **Proven:** the existing email transport's provider identity, update/cancellation handling, and local deduplication worked for a real booking lifecycle.
- **Proven:** the failed push was an unavailable production callback route at that time, not a HotelRunner API quota failure or a projection error.
- **Not yet proven:** a real HotelRunner API payload links to that already-existing local reservation without creating a second record.

That linking claim remains unproven historical context and must not be pursued while the subscription is cancelled. Do not request a payload, call HotelRunner, or edit, reopen, or cancel the real booking for testing.

## Production status snapshot

Snapshot date: **2026-08-07**. This is operational evidence, not a substitute for checking the current runtime before an operation.

**Superseded on 2026-08-13:** this table records the pre-cancellation deployment only. It must not be read as the current operating mode or as authority to call HotelRunner. The email-only contract above now controls; the production shutdown facts require the post-deployment verification described there.

| Area | Snapshot state |
| --- | --- |
| Backend source | PR #35 application release deployed at exact merge `538678e0fcabe4df56621b5328612ff382da0871` |
| Frontend source | PR #26 deployed at exact merge `3e25743572da2890eef4d4ebe2eca4894cd2db5a` |
| Main backend/frontend | Online under PM2 |
| Public callback health | HTTPS GET returns `200 {"ok":true}` |
| Callback authentication | Invalid credentials return `401`; the configured credential returned `422` for an intentionally empty reservation array, proving authentication and parsing succeeded while stopping before persistence; GET remains an intentionally unauthenticated health check |
| Callback proxy logging | Exact Nginx callback location has `access_log off` and `error_log /dev/null crit`; the hardened configuration passed `nginx -t`, reloaded successfully, and a synthetic public POST did not increase the callback access-log count |
| Origin exposure | Backend/frontend listen only on `127.0.0.1:8080` and `127.0.0.1:3080` |
| Projection | OFF |
| Reservation-history pull | OFF |
| Automatic room-list refresh | OFF |
| Delivery confirmation | OFF |
| Projection activation cutoff | Blank while projection is off |
| Independent HotelRunner worker | OFF |
| HotelRunner API calls made during deployment/testing | Exactly one approved room-list GET; zero reservation-history or delivery-confirmation calls |
| Room-list discovery | Completed once; six inventory codes were saved in one complete generation |
| Room mappings | Five verified non-master codes remain `pending`; one HotelRunner master fallback remains blocked as `conflict`; awaiting owner approval |
| Existing OTA-email path | Active; health returns `200`, invalid-secret POST returns `401` before parsing, dedupe index is present, and per-reservation coexistence rules are deployed |
| Token status | Exactly one value is configured locally and in production and it authenticated successfully. It is the same credential present in 17 historical Nginx lines; the owner explicitly instructed retention after log hardening. A one-time rotation remains the recommended way to revoke that historical exposure. |
| Room-calendar update permission | Must remain disabled |
| Frontend environment | Mode `600`; clean PR #26 build deployed and scanned across 50 files against 40 protected production values with no match; historically exposed provider credential rotations remain an external security task |

The reservation involved in the live fallback incident had an unchanged secure document hash across deployment. Exact hashes and identifiers are intentionally retained outside this repository.

Current release boundary: the reviewed backend/frontend hardening is deployed and the one-call discovery gate is complete. Production is stopped at Gate 3 for explicit room-mapping approval. No mapping has been activated, no persistent worker has been installed or started, projection remains false, and no reservation history, delivery confirmation, reservation projection, or controlled live lifecycle test has occurred. “Deployed” below means code is present with every HotelRunner reservation-mutation gate false; it does not yet mean inbound projection is live.

Traceability recorded at this snapshot:

| Artifact | Revision / rollback evidence |
| --- | --- |
| Backend application production revision | `538678e0fcabe4df56621b5328612ff382da0871` |
| Backend repository/documentation production revision before this update | `145487c6afe83d698cd9af5378242d38475079c1` |
| Backend HotelRunner baseline | GitHub PR #33 / merge `05702cf981532815998858f8f7a37bc5205524bf` |
| Backend environment baseline | GitHub PR #34 / merge `c42d2d5ae2dbe3899d43dd5d7f36ead92c08b6db` |
| Backend hardening implementation | `ce7217159c13e10cb0ae3135714d86385c5a044e`; GitHub PR #35 / merge `538678e0fcabe4df56621b5328612ff382da0871` |
| Frontend production revision | `3e25743572da2890eef4d4ebe2eca4894cd2db5a` |
| Frontend production baseline | GitHub PR #25 / merge `34c2daf672ca8c3b29466ee57d5acbcf629fa97e` |
| Frontend hardening deployment | GitHub PR #26; head `b1f937e8d5137f642e8dfb5274b4a0e8f88e0751`; merge `3e25743572da2890eef4d4ebe2eca4894cd2db5a` |
| Nginx pre-change file | `/etc/nginx/sites-available/xhotelpro.pre-hotelrunner-20260806T203000Z` |
| Nginx pre-log-hardening file | `/etc/nginx/sites-available/xhotelpro.pre-hotelrunner-log-hardening-20260807T011419Z` |
| Frontend pre-change build | `build.pre-hotelrunner-20260806T205200Z` |
| Secure environment rollback filename | `.env.pre-hotelrunner-runtime-20260806T204200Z` |
| Safe bootstrap-flag rollback | `/home/ahmedadmin/secure_env_backups/hotels_backend/.env.pre-bootstrap-hardening-20260806T223020704199Z-190045` |
| Frontend secret-removal rollback | `/home/ahmedadmin/secure_env_backups/hotels_frontend/.env.pre-client-secret-removal-20260806T224430661Z-190806` |
| Frontend pre-PR-26 build rollback | `/home/ahmedadmin/secure_build_backups/hotels_frontend/build.pre-hotelrunner-hardening-20260807T003850Z` |

### Controlled Gate-0 deployment evidence

The exact PR #35 and PR #26 merge revisions were deployed on 2026-08-06 local time without starting HotelRunner processing:

- both production repositories were tracked-clean; intentional untracked/ignored artifacts were enumerated, and the candidate introduced-path collision count was zero;
- the frontend was built from the exact merge in an isolated mode-`700` temporary directory using the existing reviewed lock/dependency tree; its server-value scan passed before installation;
- the installed frontend build manifest matched the isolated candidate manifest, the previous build was moved to the retained rollback path above, and the public HTML referenced the same hashed main asset as the installed build;
- only `hotels-backend` and `hotels-frontend` were restarted; every unrelated PM2 name, PID, and online status remained unchanged;
- both origins moved from wildcard listeners to loopback-only listeners, while loopback and public HTTPS health stayed `200`;
- invalid HotelRunner callback form POSTs returned `401` before parsing both directly and through Nginx; the GET health route returned `200` by design;
- all four HotelRunner gates remained false, the cutoff remained blank, the systemd unit remained uninstalled/inactive, and the worker-process count remained zero;
- the observation-only production index verifier passed, and the production Node runtime passed all 205 mock-only HotelRunner tests with no vendor request;
- reservation count and the protected fallback reservation's secure hash were unchanged; it remained exactly one cancelled, email-owned, non-HotelRunner record;
- all five isolated HotelRunner collections remained empty, proving the deployment itself archived or projected nothing; and
- the OTA inbound endpoint, exact dedupe index, audit count, and latest processed audit remained intact; a synthetic invalid-secret probe was rejected before multipart parsing and created no audit record.

The versioned Nginx hardener was installed on 2026-08-07. The exact callback location now has both `access_log off;` and `error_log /dev/null crit;`. The active site and symlink were verified, both Nginx syntax tests passed, reload succeeded, and a synthetic invalid-credential HTTPS callback returned `401` without increasing the 19 historical callback access-log lines.

The Nginx installer was a timestamped one-shot operation and must not be rerun blindly. The later environment helpers create a new unique mode-`600` rollback for every accepted atomic update, reject duplicate or unexpected keys, and fail closed unless projection, history pull, recurring room discovery, and delivery confirmation remain false during bootstrap. A rotated token still requires a fresh reviewed invocation; never copy or print it in command history or documentation.

### Controlled Gate-1 authentication and Gate-2 discovery evidence

The following production checks were completed on 2026-08-07 with projection, history pull, recurring room-list sync, and delivery confirmation all false:

- the backend and frontend repositories were tracked-clean and matched their GitHub upstream revisions;
- both protected environment files remained regular mode-`600` files, and local/production HotelRunner token, HR ID, and supported-property settings matched without printing values or hashes;
- there was exactly one configured supported PMS property and it resolved to active Zad Ajyad with an owner, currency, and five active local room configurations;
- all ten PM2 applications were online, the two PMS targets remained on loopback-only `127.0.0.1:8080` and `127.0.0.1:3080`, no PM2 process inherited a `HOTELRUNNER_*` override, and no HotelRunner worker or systemd unit was running;
- public PMS, OTA inbound, and callback health each returned `200`; an invalid callback returned `401` and did not enter Nginx access logs;
- one authenticated callback probe used `data={"reservations":[]}` and returned the expected `422`, proving the current credential reached the parser while the empty-array guard stopped before hotel loading or persistence;
- that callback probe left the reservation count, protected incident reservation hash, all HotelRunner collection counts, and historical Nginx callback counts unchanged;
- the read-only reservation-index verifier passed for `uniq_ota_identity_key` and `uniq_ota_cross_transport_identity_key`;
- the room-list-only entry point completed with six inventory codes and exactly one HotelRunner API call; conservative budget counters recorded one claim in each of the application-minute, property-minute, and property-day scopes;
- the room-list sync state ended `idle`, with one successful room-list pull, no pull failure, no active pull/projection lease, and no error;
- HotelRunner event and mirror counts remained zero, the PMS reservation count remained `18,238`, and the protected real fallback reservation remained exactly one cancelled, email-owned record with its original hash;
- the OTA-email audit remained at `1,833` records with its latest record processed and its exact partial-unique dedupe index intact; and
- production load remained low during verification (load averages below `0.4`, about `12.4 GiB` memory available, and root disk at `10%`).

The first npm-wrapped discovery launch created only the isolated collection indexes and made zero quota claims/API requests; its silent wrapper did not print a completion result. The entry point was therefore invoked directly once. That invocation is the single vendor request recorded above and must not be repeated merely as a health check.

### Discovered room mapping proposal — approval required

No row below is active yet. The proposed pairing is based on the exact HotelRunner capacity/name and the exact active PMS room configuration. The owner must approve it before any mapping update or projection activation.

| HotelRunner inventory | HotelRunner room | Capacity | Proposed local PMS room | Current state |
| --- | --- | ---: | --- | --- |
| `HR:1329539` | Default room type | 0 | **Never map** | `conflict`; `is_master=true` fallback |
| `HR:1332317` | Comfort Family Room - 4 beds | 4 | `quadRooms` — Quadruple Room – Comfort & Privacy (`6a40e45a1a6d1850eb25c58b`) | verified, `pending` |
| `HR:1332547` | Comfort Double Room | 2 | `doubleRooms` — Double Room – Comfort & Relaxation (`6a40df5f1a6d1850eb25c183`) | verified, `pending` |
| `HR:1332566` | Comfort Family - 5 Beds | 5 | `familyRooms` — Family Quintuple Room (`6a40e4ec1a6d1850eb25c635`) | verified, `pending` |
| `HR:1332585` | Comfort Family Room - 6 beds | 6 | `familyRooms` — Spacious Six-Bed Room (`6a4a84216022cd7f31729011`) | verified, `pending` |
| `HR:1332587` | Comfort Triple Room - 3 beds | 3 | `tripleRooms` — Triple Room - Premium Comfort (`6a40e0981a6d1850eb25c27c`) | verified, `pending` |

Each non-master code exposes its standard and non-refundable rate-code variants and reports SAR plus availability/restriction/price-update capability. Those capabilities do not authorize outbound updates: **Can update room calendar remains disabled**, and outbound availability/rates remain a later phase.

## Dormant integration safeguards

These safeguards remain relevant to preserved historical data and any future reactivation, but the 2026-08-13 email-only operating contract takes precedence. In particular, no safeguard below authorizes a vendor call, callback, worker, projection, or admin UI while the master boundary is false.

1. Every PMS view and report reads local MongoDB data.
2. HotelRunner credentials are never stored in React, source control, documentation, or ordinary application data. Dormant values may remain only in the protected backend environment and must not transit a callback or vendor request while the master boundary is false.
3. Callback receipt and reservation projection are separate operations.
4. A callback is acknowledged only after every item in the received batch has been durably attempted. A partial persistence failure returns `503`; a retry is safe because event inserts are idempotent.
5. Projection defaults to off.
6. Pulling and projection have separate fail-closed switches. Pull defaults off; projection requires an explicit timezone-qualified activation cutoff.
7. One HotelRunner business reservation can link to only one local PMS reservation, and one local PMS reservation can have only one HotelRunner mirror link.
8. Unknown, conflicting, stale, foreign-currency, or ambiguously identified data fails closed into review; it is never guessed into the PMS.
9. An inventory code discovered only in a reservation cannot be activated until HotelRunner's room-list response verifies it.
10. HotelRunner's `is_master=true` fallback can never be mapped automatically or manually to a PMS room category.
11. HotelRunner-reported payment data is informational. It never marks local money as captured, paid, transferred, settled, or reconciled.
12. Active room/stay rewrites are blocked when local housing, finance, processor, or ownership guards show local control. Cancellation has a narrower rule: it is blocked for in-house, checked-out, and no-show stays, but may cancel a future room-assigned booking while leaving all finance/processor data untouched.
13. OTA-email handling is never disabled property-wide. While `HOTELRUNNER_INTEGRATION_ENABLED=false`, trusted OTA email is the active lifecycle authority even when a reservation retains a historical direct HotelRunner projection marker. Any future per-reservation HotelRunner authority rule requires explicit reviewed reactivation.
14. Authenticated, source-backed OTA email remains able to create/update/cancel reservations that HotelRunner did not deliver, including uncovered Airbnb accounts/listings. Other hotel IDs retain their existing behavior.
15. Historical HotelRunner provenance remains protected from fabrication, but it does not block the normal guarded OTA-email lifecycle mapper while the master boundary is false. Existing finance, payment, ownership, deduplication, and source-backed-email validation rules still apply.
16. HotelRunner's documented gross pricing is preserved separately. OTA commission or hotel net payout is never inferred from `paid_amount`, taxes, fees, discounts, promotions, or adjustments.
17. The desired current production state is no enabled/running HotelRunner supervisor or worker. If a residual `Restart=always` unit cannot yet be stopped, its process must remain in the master-disabled inert wait before any database connection/model/client/vendor initialization, and the residual state must be recorded until an administrator closes it. A future reviewed reactivation must use exactly one approved supervisor and retain database-backed property serialization; it must never add an accidental PM2 duplicate.
18. Outbound availability, prices, restrictions, reservation responses, delivery confirmations, and guest messaging are outside the active inbound phase.
19. A reused message UID with different content can never revoke another worker's active lease. Non-owned or expired work is quarantined; active first-payload-wins processing records the conflict durably and finishes as operator-visible `attention`.
20. HotelRunner financial reports never derive OTA expense, hotel net, platform margin, or chargeable commission from gross minus local room/base pricing. Missing verified commercial evidence is counted and displayed as unavailable.
21. A frontend build fails before Create React App runs if any server-only credential name is present in a loaded `REACT_APP_*` environment. Every `REACT_APP_*` value is browser-public by definition; HotelRunner tokens and provider secrets are backend-only.
22. The existing generic reservation-update route authorizes against the reservation's persisted hotel before mutation. A client-supplied hotel ID, actor ID, or ownership field cannot widen that scope.
23. Generic reservation updates cannot replace server-managed HotelRunner/OTA identity, review, pricing, or audit markers. Receipt supplier edits are leaf updates; they never round-trip the `supplierData.hotelRunner` snapshot.
24. Ordinary HotelRunner status/date edits preserve source-owned rooms and pricing. Early checkout changes lifecycle/date facts without recomputing or resubmitting the canonical gross from local room prices.
25. A HotelRunner `updated_at` more than five minutes after local receipt time is invalid and quarantined rather than becoming an ordering watermark.
26. Generic reservation writes use an optimistic `_id`/`__v`/`updatedAt`/hotel/owner snapshot. Direct HotelRunner records also require the same source markers and watermark at commit time. A concurrent worker/editor change returns `409`; stale UI data can never overwrite a newer projection.
27. HotelRunner owns the projected stay, room-category/rate mapping, gross monetary fields, transport identity, and commercial-evidence snapshots. The PMS `roomId` array remains a local physical-room assignment and can still be changed by authorized hotel operations.
28. Direct HotelRunner commission review through the generic editor is limited to the configured super administrator. Derived `commissionData`, finance-assignment evidence, OTA net, expense, margin, and verification markers are server-owned and cannot be fabricated by a client payload.
29. Nginx must remain the only public application edge. While the integration is dormant, the callback must fail with a generic `404` before authentication or persistence, and its request query must remain absent from application and proxy logs. A future callback restoration requires a fresh logging and credential review.
30. Guest payment and platform-commission settlement remain separate facts. Existing-reservation PayPal authorization/capture paths preserve payment, `paid_amount`, processor ledger, and finance-status updates but cannot mark an unreviewed, invalid, or conflicting direct-HotelRunner platform commission paid. The canonical finance resolver must first prove an explicit consistent staff assignment; an explicitly reviewed zero remains valid.

## Dormant backend repository surface

The backend files below are retained dormant so historical provenance remains readable and a future reactivation can be reviewed rather than improvised. Their presence is not an active runtime surface: `HOTELRUNNER_INTEGRATION_ENABLED=false` must dominate callback, client, worker, OTA-authority, and projection behavior.

### Dedicated backend files

- `controllers/hotelrunner.js` - master-disabled callback boundary plus dormant historical authentication/parsing/persistence and admin status/mapping handlers.
- `routes/hotelrunner.js` - isolated dormant HotelRunner callback and authenticated admin routes; there is no frontend admin route.
- `models/hotelrunner_event.js` - durable event inbox, integrity state, retry/lease state, and processing result.
- `models/hotelrunner_reservation.js` - immutable HotelRunner-to-PMS reservation mirror and source watermarks.
- `models/hotelrunner_room_mapping.js` - verified HotelRunner inventory-code to local room-category mapping.
- `models/hotelrunner_sync_state.js` - pull cursor, separate pull/projection leases, backoff, timestamps, and metrics.
- `models/hotelrunner_api_budget.js` - persistent local quota buckets.
- `services/hotelrunnerConfig.js` - fail-closed configuration and bounded defaults.
- `services/hotelrunnerPayload.js` - bounded normalization, validation, hashes, and normalized stored snapshot.
- `services/hotelrunnerEventService.js` - explicit isolated-collection index bootstrap, configured-hotel loading, and idempotent event persistence; it never initializes or changes `Reservations` indexes.
- `services/hotelrunnerApiQuota.js` - property/day, property/minute, and application/minute call reservation.
- `services/hotelrunnerClient.js` - allowlisted HTTPS HotelRunner client with timeouts, response bounds, and no redirects.
- `services/hotelrunnerPullSync.js` - quota-limited room-list and reservation-history reconciliation.
- `services/hotelrunnerReservationAdapter.js` - identity linking and guarded projection into the existing reservation schema.
- `services/hotelrunnerWorker.js` - leases, retry schedule, ordering, pull checks, and projection execution.
- `services/hotelrunnerOtaEmailBoundary.js` - reservation-level detection of direct HotelRunner ownership.
- `services/hotelrunnerLogSafety.js` - callback URL/query redaction for application logs.
- `services/hotelrunnerLegacyLocalReservation.js` - safe local reservation response without live HotelRunner retrieval or sensitive processor leakage.
- `services/hotelrunnerReportPricing.js` - shared fail-closed HotelRunner report expressions and verified commercial-evidence checks.
- `services/hotelrunnerPlatformFinance.js` - canonical platform-commission resolver shared by JavaScript and MongoDB reporting paths.
- `services/hotelrunnerCommissionAssignment.js` - server-owned, cent-exact direct-HotelRunner commission review evidence and client-field stripping.
- `services/hotelrunnerGuestPaymentFinance.js` - keeps PayPal guest-payment persistence separate from direct-HotelRunner commission settlement.
- `services/hotelrunnerReservationIndexReadiness.js` - exact, observation-only proof of the two required partial-unique `Reservations` identity indexes.
- `services/paypalOwnerAccess.js` - authenticated capability and exact-hotel scoping for owner payment/finance routes.
- `workers/hotelrunnerSyncWorker.js` - independent long-running/one-shot worker entry point.
- `ops/systemd/xhotelpro-hotelrunner-sync.service` - the isolated production worker service, installed/enabled only after mapping and activation approval.
- `scripts/hotelrunnerEnvGate.js` - versioned, atomic environment status/bootstrap/token-rotation/activation/deactivation guard.
- `scripts/verifyHotelRunnerReservationIndexes.js` - read-only production index-readiness entry point with implicit Mongoose index creation disabled before model import.
- `scripts/ops/hardenHotelRunnerNginxLogging.sh` - surgical Nginx callback log hardener with config test and rollback.

### Deliberately small changes to existing backend code

- `server.js` always sanitizes logged request URLs. It mounts the callback authentication preflight and loads the isolated HotelRunner router only when the master boundary is true; otherwise the exact callback is tombstoned before body parsing and all HotelRunner routes remain absent.
- `controllers/reservations.js`, `routes/reservations.js`, and the related regression tests keep single-reservation reads, hotel financial-report reads, and generic reservation mutations local, authenticated, and property-scoped. The generic mutation path also strips server-managed OTA/HotelRunner markers, applies source-pricing preservation, and logs bounded request metadata rather than the update body.
- `controllers/adminreports.js`, `services/adminReservationOverview.js`, and `controllers/overall_dashboard.js` preserve legacy non-HotelRunner reporting while making HotelRunner net/expense/profit unavailable unless commercial evidence is explicit and verified.
- `controllers/paypal_reservation.js` keeps four existing-reservation authorization/capture paths intact while preventing guest payment from settling an unreviewed direct-HotelRunner commission. `controllers/paypal_owner.js` and `controllers/admin_payouts.js` use the same canonical finance availability boundary before HotelRunner commission payout/reconciliation.
- `controllers/rooms.js` no longer acts as an on-demand HotelRunner retrieval path.
- `services/otaReservationMapper.js` keeps source-backed email reservations active; while the master boundary is false it does not let a historical direct projection marker suppress normal guarded OTA-email lifecycle reconciliation.
- `package.json` adds isolated HotelRunner test and worker commands.

### Retired frontend surface — 2026-08-13

The dedicated HotelRunner administration frontend is removed, not merely hidden:

- `App.js` no longer registers `/admin/hotelrunner`;
- the route-permission map no longer recognizes that path;
- the English and Arabic admin side-navigation links and selection mappings are removed; and
- the dedicated HotelRunner page, local admin-API wrapper, view model, and their dedicated tests are removed.

The production build and route/menu/module scans still require post-deployment verification. No frontend should navigate to or invoke a HotelRunner administration endpoint. The existing `/admin/ota-reservations` workflow remains the operator surface for OTA inbound-email review.

Local-data-only pricing/provenance helpers elsewhere in reservation and reporting screens may remain because historical HotelRunner rows must still be represented accurately. They do not make network calls and must not confer current HotelRunner lifecycle authority. The client-environment preflight remains required: no HotelRunner token, HR ID, vendor endpoint, or direct vendor fetch may exist in React.

## Processes and authority boundaries

### Main API process

The normal backend process continues to serve the PMS and OTA inbound-email routes. With `HOTELRUNNER_INTEGRATION_ENABLED=false`, the HotelRunner boundary returns a generic `404` before callback authentication, parsing, or persistence. The removed frontend makes no HotelRunner admin request, and the normal backend process never runs the long-running HotelRunner projection loop.

### Dormant `hotelrunner-sync` process

The worker is not part of the current operating mode. Its desired production state is supervisor-disabled/stopped with zero HotelRunner worker processes. If the residual `Restart=always` systemd unit launches before an administrator can disable it, the master-disabled entry point must remain in an inert signal-only wait before any database connection/model, client, or vendor initialization. That temporary inert process performs no database lease, quota claim, vendor request, or reservation projection and avoids a restart loop. The exact operational state must be verified after deployment rather than inferred from source.

The following capabilities describe the historical implementation only. If a future reviewed reactivation restores the worker, it:

- runs as exactly one approved dedicated supervisor, never as an additional PM2 duplicate;
- obtains a separate database-backed projection lease before claiming any event, guaranteeing one projection at a time for the property even if a second process is accidentally started;
- renews that property lease during work and fails closed if ownership is lost;
- checks for a due pull no more often than every 30 seconds;
- obtains a persisted 10-minute pull lease before external reconciliation;
- refreshes the room list when due only when the independent room-list switch is enabled;
- retrieves at most three 50-item history pages per cycle;
- stores push and pull deliveries through the same event service;
- projects local events only when projection is enabled; and
- uses five-minute event/projection leases with recoverable retries.

Stopping this process was one historical safety boundary. The current shutdown additionally requires the master flag and all four legacy flags to be false so an accidental process launch still cannot access HotelRunner.

### Projection-off behavior

The master boundary now dominates every legacy switch combination:

| Master integration | Callback | Client/worker | OTA inbound email |
| --- | --- | --- | --- |
| `false` | Generic `404` before authentication or persistence | Client rejects; any residual worker waits inertly before DB connection/model/client/vendor initialization | Normal inline create/update/cancel authority |
| `true` | Not currently approved | Not currently approved | Requires a new reviewed authority design |

Projection false by itself was never sufficient to prevent room-list or reservation-history GETs. That is why the current contract requires the master boundary plus projection, history pull, recurring room-list sync, and delivery confirmation all to be explicitly false, with the worker stopped.

## HTTP endpoints

### Public callback

`GET /api/hotelrunner/callback` and `POST /api/hotelrunner/callback` are disabled while `HOTELRUNNER_INTEGRATION_ENABLED=false`. Both must return a generic `404` before credential comparison, request-body parsing, event persistence, or any other integration work. Verification must not include a real token or ask HotelRunner to deliver a test callback.

The old authenticated form-processing behavior remains dormant code provenance only. Restoring it requires the future reactivation review defined at the top of this document.

### Dormant authenticated admin API — no frontend route

- `GET /api/hotelrunner/admin/status/:userId`
- `GET /api/hotelrunner/admin/room-mappings/:userId`
- `PUT /api/hotelrunner/admin/room-mappings/:mappingId/:userId`

These route shapes are retained only with the dormant implementation and historical collections. While the master boundary is false, they must return the same generic `404` before authentication, collection reads, or mutation. They have no current frontend route, side-menu entry, or supported operator workflow and must not be invoked as a substitute for the removed UI. If they are ever restored, they must retain sign-in, self/auth, platform-admin, property-scope, optimistic-concurrency, payload-redaction, and superadministrator-only mutation safeguards.

No dormant admin read may authenticate against or fetch from HotelRunner. No mapping write is part of the current email-only operating mode.

### Existing generic reservation mutation boundary

`PUT /api/reservation-update/:reservationId` remains an existing PMS route rather than a HotelRunner admin endpoint, but it is also part of the integration's safety boundary:

- it requires sign-in, loads the existing reservation and its persisted `HotelDetails` record, and checks the authenticated actor against that hotel before applying an update;
- request-supplied `hotelId`, `belongsTo`, `requestingUserId`, or similar fields do not determine authorization;
- server-managed identity, audit, OTA-review, and pricing markers are removed, while whole `supplierData` input is converted to permitted dotted leaves and any `supplierData.hotelRunner*` or `supplierData.ota*` input is discarded;
- ordinary HotelRunner edits strip source-owned room/total/pricing fields, and room/property replacement requires the authorized pricing workflow; and
- the route's request diagnostic contains only bounded reservation/actor IDs, not the request body or supplier/pricing payload.

The deployed PR #26 frontend applies the same boundary before transport: ordinary editors protect HotelRunner source fields, early-checkout handlers do not derive a new gross from `chosenPrice`, and receipt editors send only `supplierData.supplierName` or `supplierData.suppliedBookingNo` when that leaf is edited. Non-HotelRunner status and receipt behavior retains its legacy calculations and editable fields.

## Retired `/admin/hotelrunner` page — 2026-08-13

There is no current HotelRunner administration page. The `/admin/hotelrunner` route, route-permission entry, English and Arabic side-menu links, dedicated page, frontend admin-API wrapper, and frontend view model were removed when the subscription was cancelled. The old page behavior and permission roadmap are retired; future contributors must not restore them from history without the explicit reactivation process defined above.

The files named `HotelRunnerReservationList` elsewhere in older Reception/New Reservation modules are legacy local reservation/import screens. They are not a direct integration console and must not be repurposed to call HotelRunner.

Ordinary reservation/report screens may continue to display stored HotelRunner gross-pricing and provenance from historical local records. That display is local-data-only, cannot establish lifecycle authority, and must never trigger a vendor request. OTA email review continues through `/admin/ota-reservations`.

## Environment configuration

All values belong in the backend `.env` only. The repository ignores `.env`, `.env.*`, log files, and credential-like artifacts. Environment files and backups on production must be mode `600`; their containing backup directory must be mode `700`.

| Variable | Default / bound | Purpose |
| --- | --- | --- |
| `HOTELRUNNER_INTEGRATION_ENABLED` | `false` | Master runtime boundary; false disables callback authority, client access, worker work, and HotelRunner-first OTA routing regardless of legacy flags |
| `HOTELRUNNER_API_TOKEN` | dormant; required only for reviewed reactivation | Secret token; retention does not authorize use; never print, log, commit, or place in React |
| `HOTELRUNNER_API_HR_ID` | dormant; required only for reviewed reactivation | Secret-equivalent HotelRunner property/application identifier |
| `HOTELRUNNER_SUPPORTED_HOTELIDS` | dormant one-property binding | Local `HotelDetails._id` retained only for provenance and possible reviewed reactivation |
| `HOTELRUNNER_PROJECTION_ENABLED` | `false` | Legacy guarded event-to-PMS mutation gate; must remain false in email-only mode |
| `HOTELRUNNER_PROJECTION_NOT_BEFORE` | blank | Historical activation cutoff; must remain blank in email-only mode |
| `HOTELRUNNER_PULL_ENABLED` | `false` | Explicitly enables reservation reconciliation GETs; malformed/blank explicit booleans invalidate configuration |
| `HOTELRUNNER_ROOM_LIST_SYNC_ENABLED` | `false` | Independently enables due room-list refreshes; malformed/blank explicit booleans invalidate configuration |
| `HOTELRUNNER_CONFIRM_DELIVERY_ENABLED` | `false` | Separate outbound PUT gate; also requires projection plus bounded PMS/message identifiers |
| `HOTELRUNNER_REQUIRE_OTA_REVIEW` | inactive while master is false | Historical projection-review preference; it must not affect ordinary OTA inbound email processing in email-only mode |
| `HOTELRUNNER_PULL_INTERVAL_MINUTES` | 30; bounded 15-360 | Due interval with +/-10% jitter and at least five minutes |
| `HOTELRUNNER_ROOM_LIST_INTERVAL_HOURS` | 24; bounded 6-168 | Room-list refresh interval |
| `HOTELRUNNER_REQUEST_TIMEOUT_MS` | 12000; bounded 3000-30000 | Vendor request timeout |
| `HOTELRUNNER_CALLBACK_BODY_LIMIT_BYTES` | 1 MiB; bounded 64 KiB-2 MiB | Maximum callback `data` size |
| `HOTELRUNNER_CALLBACK_MAX_RESERVATIONS` | 100; bounded 1-250 | Maximum reservations accepted in one callback/pull envelope |
| `HOTELRUNNER_OTA_EMAIL_FALLBACK_GRACE_MS` | 180000; bounded 30000-900000 | Grace period in which HotelRunner callback/API ownership has priority over an authenticated direct-OTA email |
| `HOTELRUNNER_OTA_EMAIL_FALLBACK_LEASE_MS` | 300000; bounded 30000-900000 | Crash-recoverable lease for one durable email-fallback identity job |
| `HOTELRUNNER_OTA_EMAIL_FALLBACK_PROOF_TTL_MS` | 120000; bounded 30000-600000 | Maximum age of an identity-bound confirmed-empty HotelRunner lookup proof |
| `HOTELRUNNER_OTA_EMAIL_FALLBACK_MAX_ATTEMPTS` | 12; bounded 3-30 | Retry ceiling before the job fails closed into manual review; it never silently falls back on lookup uncertainty |
| `HOTELRUNNER_PROPERTY_DAILY_BUDGET` | 225; maximum 240 | Internal per-property daily call budget |
| `HOTELRUNNER_PROPERTY_MINUTE_BUDGET` | 4; maximum 5 | Internal per-property minute budget |
| `HOTELRUNNER_APPLICATION_MINUTE_BUDGET` | 60; maximum 75 | Internal per-application minute budget |
| `HOTELRUNNER_API_BASE_URL` | official v2 Apps URL | Test seam only; do not override in production |
| `BIND_HOST` | `127.0.0.1` | Node origin bind address; production must remain loopback because Nginx is the public edge |

The required current production values are the master boundary and all four legacy gates explicitly false, with the cutoff blank. Protected credentials may remain populated and dormant. Verify this state after deployment without printing secret values and without making a vendor request.

The vendor's documented ceilings are 250 calls/day/property, 5 calls/minute/property, and 75 calls/minute/application. The lower xHotelPro defaults are deliberate safety headroom, not HotelRunner's published limits. Quota buckets are conservative call reservations: the three scopes are claimed sequentially, so an earlier bucket may remain incremented if a later bucket rejects before network I/O. Treat the counters as an upper bound on attempted calls, not an exact network-call ledger.

The production client rejects any base URL that is not exactly HTTPS `app.hotelrunner.com` at `/api/v2/apps`, rejects URL user info/query/hash, rejects redirects, caps responses at 2 MiB, and requires JSON.

### Versioned environment gate

Under the 2026-08-13 email-only contract, the only approved HotelRunner gate operations are read-only `status` and, when needed to close the boundary, `deactivate`. `deactivate` must set the master boundary and all four legacy gates false and clear the cutoff. The bootstrap, discovery, token-rotation, activation, and review-mode material below is retained for historical implementation context only and must not be executed without a future dated reactivation approval. None of these local commands is permission to make a HotelRunner vendor call.

Never use an unversioned home-directory helper to change HotelRunner production settings. Use the script from the exact deployed backend revision. It accepts one explicit regular `.env` path, refuses symlinks/duplicates/inherited conflicts, creates a unique atomic mode-`600` backup before every accepted mutation, and reports names/state only—never values.

Run this environment tool as the application service account (`ahmedadmin` in the current deployment), never through `sudo`. Atomic replacement makes the invoking account the new file owner; a root-owned mode-`600` file would make PM2 unable to read it. Before and after every mutation, verify the `.env` and backup owner/group are the service account and their modes are `600`, while the backup directory is `700`, without printing file contents.

Historical status/bootstrap/discovery commands — only `status` is currently approved:

```sh
npm run hotelrunner:env-gate -- status --env-file /home/ahmedadmin/Hotels/hotels_backend/.env
npm run hotelrunner:env-gate -- bootstrap --env-file /home/ahmedadmin/Hotels/hotels_backend/.env --backup-dir /home/ahmedadmin/secure_env_backups/hotels_backend
npm run hotelrunner:env-gate -- assert-room-discovery --env-file /home/ahmedadmin/Hotels/hotels_backend/.env
```

Token rotation is stdin-only so the value is absent from argv, process listings, output, and documentation. Use a hidden shell prompt; never paste a token into the command itself:

```sh
read -r -s -p 'Replacement HotelRunner token: ' hotelrunner_replacement_token
printf '%s' "$hotelrunner_replacement_token" | npm run hotelrunner:env-gate -- rotate-token --env-file /home/ahmedadmin/Hotels/hotels_backend/.env --backup-dir /home/ahmedadmin/secure_env_backups/hotels_backend
unset hotelrunner_replacement_token
```

Historically, `rotate-token` was allowed only while the master boundary and all four legacy gates were explicitly false and the activation cutoff was blank. It also required the existing HR ID and exactly one valid local hotel binding. `activate` atomically set the master boundary, push projection, and bounded recurring room-list verification true, kept history pull and delivery confirmation false, and required a reviewed timezone-qualified cutoff. The current `deactivate` operation closes the master boundary and all four legacy gates and clears the cutoff.

Review mode is changed independently so activation/deactivation and token rotation do not silently alter the business workflow:

```sh
npm run hotelrunner:env-gate -- set-review-mode --enabled true --env-file /home/ahmedadmin/Hotels/hotels_backend/.env --backup-dir /home/ahmedadmin/secure_env_backups/hotels_backend
```

`set-review-mode` accepts an explicit boolean, changes only `HOTELRUNNER_REQUIRE_OTA_REVIEW`, creates the same protected atomic backup, and never prints any environment value. Restart the backend and the single systemd HotelRunner worker after changing it because both load configuration at process start.

The gate compares the explicit file with variables inherited by its own shell process. PM2 state is separate: before every restart, verify the target xHotelPro processes contain no inherited `HOTELRUNNER_*` overrides, then restart only those named processes with the protected `.env` behavior. Never dump PM2 environments to shared logs because other applications may contain secrets.

### One-property binding in this phase

The environment variable name is plural for compatibility, but the current configuration intentionally requires exactly one local hotel ID. A token/HR-ID pair must never be assumed to authorize multiple unrelated local properties.

Future multi-property support must introduce an explicit configuration collection or secret-backed binding per property, for example:

```text
local HotelDetails._id
  <-> HotelRunner property identity
  <-> token secret reference
  <-> HR-ID secret reference
  <-> independent feature flags and quota state
```

Do not append another hotel ID to the current environment variable.

## HotelRunner Custom App settings for inbound phase

Use:

- integration type `HR-v1`;
- **Enforce SSL** enabled; and
- callback `https://xhotelpro.com/api/hotelrunner/callback` with no manually pasted query string.

Enable only:

- **Can fetch room list**;
- **Can fetch reservations**; and
- **Can receive push reservation updates** with Confirmed, Modified, and Canceled selected.

Keep **Can update room calendar** disabled until the separate outbound phase is designed, tested, and approved.

During token rotation/bootstrap, temporarily disable push updates so live requests are not repeatedly sent while credentials/processes are intentionally changing. Re-enable push only at the documented approval gate; do not enable push and projection simultaneously without first reviewing archived data and mappings.

HotelRunner appends `token` and `hr_id` to callback requests. Entering the bare callback URL is correct. A GET to that URL is only a route health check.

## Credential rotation and log safety

The current backend token appeared in 17 historical callback access-log entries and must be treated as compromised. A separate legacy HotelRunner token was also embedded in the historical frontend bundle; a value-only in-memory comparison proved it is different from the current backend token and did not print either value. Disabling later logging or removing the frontend variables does not make either token safe again. Revoke the current app token and every still-active legacy token.

### Required rotation gate

1. Temporarily disable HotelRunner push updates.
2. Regenerate/revoke the current HotelRunner token and revoke every still-active legacy custom-app token in the HotelRunner UI.
3. Replace only `HOTELRUNNER_API_TOKEN` in the local backend `.env` unless HotelRunner explicitly changes the HR ID. Use the versioned stdin-only `rotate-token` command while every gate is false and the cutoff is blank.
4. Never paste either value into chat, documentation, source control, shell history, screenshots, or issue/PR text.
5. Install the changed secret in production with the same exact Git-revision env-gate command; do not use an unversioned helper whose content differs between local and production.
6. Confirm the tool atomically replaced the environment file, preserved mode `600`, and created a mode-`600` rollback in a mode-`700` directory.
7. Restart only processes that need the new environment.
8. Verify the revoked token fails, the new token authenticates using the minimum safe request, and neither value appears in application/Nginx logs.
9. Verify the callback exact location bypasses both general Nginx access and error logs, and the raw Node origin cannot be reached externally.

Do not print the old or new token to perform these comparisons. Use redacted/fingerprinted checks where needed.

### Nginx callback location

The exact callback location must precede generic proxy handling:

```nginx
location = /api/hotelrunner/callback {
    access_log off;
    error_log /dev/null crit;
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
}
```

Run the versioned surgical hardener, which creates a unique backup, requires the active `sites-enabled` link to target this exact file, runs `nginx -t` before reload, and rolls back on either test/reload failure. Do not rerun the old one-shot full-site installer or redirect the callback to another host.

Because TLS terminates at the edge/proxy, the callback query is necessarily visible to that infrastructure. Confirm that CDN log export, WAF events, APM, error reporting, and application request logging do not retain full callback URLs. The REST documentation publishes query-credential authentication but no webhook signature or source-IP allowlist, so this integration must not claim either control exists.

## Event intake and idempotency

### Transport identity

`message_uid` identifies a delivery message, not the durable business reservation. xHotelPro derives `eventKey` from the HR-ID fingerprint and `message_uid`.

- The first delivery inserts an event.
- An exact redelivery increments `deliveryCount` without inserting another event.
- The same message UID with a different raw payload hash is classified atomically. Pending, retry, failed, `needs_mapping`, expired-processing, or ownerless-processing work is quarantined. A genuinely active leased projection keeps the first payload and its lease, increments a durable integrity-conflict counter, and finishes as visible `attention` while preserving its local reservation/mirror result.
- A previously failed exact event may be revived only if it has no integrity conflict.

### Business identity

Business linking uses the HotelRunner reservation ID plus validated provider/HR aliases. Supported normalized provider families are Booking.com, Agoda, Expedia/Hotels.com, Trip.com, Airbnb, and HotelRunner.

Link order:

1. exact existing `supplierData.hotelRunner.reservationId`;
2. exact provider/HR alias plus matching hotel, recognized provider, and stay dates;
3. for a modification/cancellation only, a unique exact validated alias when dates changed or are absent;
4. otherwise quarantine or create only if a recognized provider and shared OTA identity exist.

Provider fields that contradict the incoming aliases reject the candidate. Multiple candidates quarantine as ambiguous. New reservations do not use fuzzy names, guest email, phone, or a wildcard lookup.

Canonical provider fields and recognized legacy provider labels must also reach one consistent provider result. Contradictory values across `supplierData`, reservation booking source, and customer booking source fail closed before lookup or mutation; a convenient display label cannot override canonical transport/business identity.

Trip.com has an explicit cross-transport identity bridge so its existing email-created record can be linked to the direct HotelRunner event. This bridge still requires exact validated provider identity and rejects contradictory providers.

### Historical HotelRunner-first direct-OTA email ingress — inactive

This entire subsection describes the former activated design. It is inactive while `HOTELRUNNER_INTEGRATION_ENABLED=false`: eligible direct OTA email bypasses HotelRunner-first queuing and vendor lookup and proceeds through the existing inline OTA mapper. The preserved description below is not current behavior and must not be used to hold or delay an OTA email.

When projection is active, an authenticated direct-OTA `new_reservation` email that resolves from source-backed hotel evidence to the one configured active HotelRunner property is not reconciled inline by the SendGrid process. The controller first persists the complete normalized `InboundEmail` audit with `processingStatus=awaiting_hotelrunner`, then inserts a durable identity job and returns HTTP 200. Important-email forwarding may still run after acceptance. Reservation refresh and Airbnb creation WhatsApp notifications are materialized only from the durable terminal result and delivered once through the backend notification outbox.

Historically, if that configured property's projection/configuration gate was unavailable, the same direct email was archived as `recovery_pending` and answered retryably; it did not fall through to the inline creator. Authenticated HotelRunner relay emails were audit-only corroboration and did not own an email fallback job, lifecycle creation, or commercial pricing. Neither rule applies while the master boundary is false; current email-only behavior is defined above.

The HotelRunner worker always drains due callback/API event work before these fallback jobs. After the grace period it checks durable local HotelRunner state, performs one exact reservation-number GET only when no callback evidence exists, and permits email creation only from a current identity-bound confirmed-empty proof. An exact HotelRunner result is persisted to the normal event queue and projected there; an uncertain, ambiguous, conflicting, or unavailable response retries or enters review and never authorizes email fallback.

The creation boundary has one explicit cross-process linearization contract:

1. A HotelRunner callback first compare-and-sets the exact active fallback identity to `api_observed`, then persists its event. Failure of that first write is retryable and is never acknowledged; failure between the marker and event insert leaves a non-consuming barrier that clears any negative proof until redelivery or event visibility lets the API path win.
2. Email mapping performs every awaited validation before it compare-and-sets that exact owned job and proof from `open` to `email_authorized`. The authorization is therefore taken at the reservation insert boundary, not when the coordinator first calls the mapper.
3. While `email_authorized` exists, callbacks receive a retryable response and cannot preempt it merely because a short timer elapsed. The exclusion is bound to the owned fallback-job lease; stale recovery belongs to a reclaimed coordinator after fresh local/vendor checks.
4. The email insert carries the exact authorization token and proof in its immutable creation marker. Success commits `email_committed`; an insert failure releases the exact token, while acknowledgement-loss recovery adopts only the exact token-stamped reservation.
5. These states are MongoDB compare-and-set decisions. Process memory and the absence of a JavaScript `await` are not ordering guarantees.

The archive-before-enqueue boundary is crash recoverable. An enqueue failure returns retryable HTTP 503 while retaining the audit and dedupe claim, and the worker recovers stale `awaiting_hotelrunner` archives that do not yet have a job. Duplicate deliveries cannot re-enter inline reservation creation.

### Historical OTA platform-review workflow

`HOTELRUNNER_REQUIRE_OTA_REVIEW=true` reuses the PMS workflow; it does not introduce a second lifecycle status:

```text
HotelRunner Confirmed push
  -> state = "OTA Platform Review"
  -> reservation_status = "OTA Platform Review"
  -> otaPlatformReview.status = "pending"
  -> HotelRunner source/link metadata
  -> /admin/ota-reservations
  -> existing pricing review and release action
  -> Pending Confirmation
```

The operator-facing list derives the label **OTA Platform Review HotelRunner** from the canonical status plus trusted HotelRunner metadata. The longer label is never persisted in `state` or `reservation_status`, so existing review filters, hotel-facing exclusions, permissions, reporting, pricing validation, and release concurrency continue to use the established canonical values.

While pending review, a HotelRunner modification updates source-owned guest, stay, room, and gross-pricing fields on the same reservation and does not release it. Local room, housing, finance, settlement, or reviewed-pricing ownership continues to protect or quarantine conflicting changes. A later flag rollback cannot silently release an already-created HotelRunner review; staff must use the dedicated release workflow. A cancellation updates that same reservation to `cancelled` and marks its pending review metadata cancelled.

An exact HotelRunner match to a legacy email-created OTA review links the durable HotelRunner mirror to that existing reservation. Original email provenance is retained, HotelRunner management metadata is added, and no second reservation is created. For new eligible direct-OTA messages, the durable HotelRunner-first queue now prevents that email/API creation race; email ingestion remains active as the confirmed-empty fallback and for other properties or message types. With `HOTELRUNNER_REQUIRE_OTA_REVIEW=false`, new confirmed HotelRunner reservations keep the previously tested direct `confirmed` behavior; deduplication, modifications, and cancellations are unchanged.

### Ordering and watermarks

- Events are claimed oldest source timestamp first.
- The mirror records observed and applied source timestamps/canonical hashes.
- An older event is ignored.
- An identical already-applied version is ignored.
- Same-timestamp conflicting content is quarantined.
- A direct HotelRunner watermark prevents an older direct event from overwriting a newer direct projection.
- A timezone-qualified provider `updated_at` more than five minutes after local receipt is marked `source_updated_at_too_far_in_future`; it is not accepted as a watermark and the event is quarantined.
- Email receipt time is not compared blindly with HotelRunner's provider `updated_at` because those clocks describe different events.

## Local event and mirror states

### `HotelRunnerEvent.status`

| Status | Meaning |
| --- | --- |
| `pending` | Stored and eligible when projection is enabled |
| `processing` | Held by a five-minute event lease while the property projection lease is also held |
| `retry` | Transient/CAS failure; scheduled with exponential backoff |
| `completed` | Created, updated, or canceled locally |
| `ignored` | Safe no-op such as stale/already-applied data |
| `needs_mapping` | Exact verified room mapping is missing |
| `attention` | Projection result is preserved, but an overbooking/shortage or active-processing payload-integrity conflict requires durable operator attention |
| `quarantined` | Integrity, identity, currency, terminal-state, or other unsafe conflict |
| `failed` | Ordinary attempts plus recovery behavior have been exhausted |

Ordinary event retries begin at five seconds, double with attempts, cap at 30 minutes, and honor a longer retry-after value. There are eight normal claims. An expired final normal lease gets one idempotent recovery pass; a second abandoned recovery becomes an explicit failed record.

Immediately before PMS projection, the worker reasserts event status, lease owner, lease expiry, payload hash, and absence of a blocking integrity conflict in one compare-and-set. Completion and retry writes also require the same owned lease. Queue metrics advance only after the corresponding event-state compare-and-set succeeds, so a lost lease cannot be reported as a false completion.

### `HotelRunnerReservation.projectionStatus`

The mirror records `pending`, `created`, `updated`, `cancelled`, `ignored`, `needs_mapping`, or `quarantined`. Its unique indexes enforce:

- one mirror per local property plus HotelRunner reservation ID; and
- at most one mirror linked to a given local PMS reservation.

The mirror is the durable identity/watermark record. The PMS reservation remains the application record.

### Stored data and privacy

The event stores a bounded normalized operational snapshot, not the unbounded original request object. It may still contain guest name, address, phone, email, stay, notes, price, and non-card payment metadata. The payload and mirror snapshots are excluded from normal Mongoose selection; dormant admin handlers must not expose them if a future review restores those routes.

This is still personal data. Future event-detail pages must default to redacted metadata, require a more specific permission for any sensitive reveal, record an audit event, and define a retention policy. Never render full event JSON into `/admin/hotelrunner` by default.

HotelRunner's public docs state card information is not shared through this reservation API. Even payment method/status/amount fields must remain informational and cannot prove that xHotelPro captured funds.

## Room mapping

HotelRunner's room list can return multiple rate rows with the same `inv_code`. xHotelPro groups these rows into one inventory mapping and retains rate codes/names for review.

Mapping rules:

- `inv_code` is the allocation group used for a local room category.
- A payload-only discovery creates/updates awareness but cannot be activated.
- Every successful complete room-list sync stages one shared generation/time across all mapping rows and publishes that generation only after every write succeeds and the final sync-state compare-and-set succeeds. Until publication, the previous active generation remains authoritative.
- Codes omitted from that complete response are retired/disabled and lose their local mapping; they require review if they later return.
- Structurally inconsistent variants for one `inv_code` (master flag, capacity, or sales currency) become `conflict` and fail closed. Different legitimate rate codes/names alone do not create a conflict.
- Room-list sync sets fresh `roomListVerifiedAt`/generation evidence only for codes in that response.
- Projection and mapping activation reject generation-less, conflicting, future-dated, or stale room-list evidence. With the default 24-hour refresh, proof is held after 72 hours without a successful refresh.
- `is_master=true` marks HotelRunner's unmatched fallback and forces `conflict` with no local mapping.
- An administrator selects an exact active `HotelDetails.roomCountDetails._id`.
- Enable/disable writes are version-checked.
- Room refresh/publication and event projection share the same property lock, so a worker cannot project against a half-published generation.
- Enabling a safe mapping through the admin route requeues all local `needs_mapping` events for that hotel; each event is revalidated and unresolved combinations are held again.
- Separately, after a complete room-list generation is published, the durable post-publication marker recovers stale-mapping events only when their recorded stale/missing code sets are subsets of the newly active mappings. That recovery does not spend another vendor call.
- Unknown codes and mixed unsafe rooms never fall back to a similar name.

Before approval, compare for every non-master inventory code:

- HotelRunner inventory code and display name;
- all returned rate codes/rate-plan codes;
- HotelRunner capacity information;
- `sales_currency` (expected `SAR` for the current property);
- HotelRunner availability/restriction/price update capability flags; and
- exact local room category, display name, active state, and physical count.

The retired admin response/UI did not expose the `sales_currency` saved in mapping notes. This is historical mapping-review context; there is no current page and no current mapping approval workflow.

The mapping reviewer must sign off before projection is enabled.

## Reservation projection rules

### New active reservation

A new reservation is created only when validation, recognized provider identity, currency, and every room mapping succeed.

- HotelRunner `confirmed` becomes local `confirmed`.
- HotelRunner `reserved` becomes local `Pending Confirmation` that still blocks inventory and appears confirmed to the client-facing availability layer.
- The provider/HR confirmation remains the external identity.
- xHotelPro allocates its own local confirmation/PMS number.
- HotelRunner reservation ID and message metadata remain under `supplierData.hotelRunner` and the mirror.
- local paid amount is `0`, finance state is `not paid`, and processor captured is `false`.
- HotelRunner payout/commission is not invented; commercial verification remains false.

### Modification

A modification can update source-owned guest/stay/room/price fields only when ownership guards permit it.

- local housing or terminal stay blocks critical rewrites;
- finance/settlement activity protects commercial data;
- local/admin changes that diverge from the last source-owned projection are preserved;
- guest descriptive fields are updated only where safe;
- room/stay changes use optimistic concurrency and inventory validation;
- an overbooking condition is recorded for attention rather than silently discarding the upstream fact; and
- no modification can reopen a local terminal record.

### Cancellation

- An unmatched cancellation never creates or guesses a reservation.
- A cancellation cannot automatically change an in-house, checked-out, or no-show stay.
- A first alias-only cancellation keeps strict stay protection.
- An established immutable HotelRunner link can accept a changed/missing stay after an earlier modification was missed.
- Cancellation changes lifecycle status only; local payment/processor/settlement records remain intact.

### Currency and pricing

- Same-currency HotelRunner pricing can project directly after the normal
  identity, mapping, and ownership checks.
- A source-currency amount may bridge to an already-created SAR reservation
  only through that reservation's exact, authenticated OTA-email audit. The
  source currency and amount, identity, hotel stay, and room count must all
  agree. No exchange rate is invented by the HotelRunner worker.
- If the corresponding email record has not arrived yet, the foreign-currency
  event remains visibly retryable. A mismatch fails closed into quarantine; it
  never creates a second reservation or rewrites the SAR amount.
- Monetary parsing uses integer cents.
- Multi-room totals are allocated deterministically and checked before conversion to the existing PMS pricing structure.
- Existing local root-price maps are reused where appropriate.
- HotelRunner's client total is not misrepresented as a verified hotel payout.

The normalized vendor breakdown is stored separately at `supplierData.hotelRunner.pricing` so the existing PMS meaning of `sub_total` (local/root pricing) is not changed. The snapshot is bounded, card/credential-like fields are excluded, and cancellation-only deliveries preserve the last complete pricing snapshot when they contain no replacement pricing.

The snapshot preserves:

- reservation `sub_total`, `extras_total`, `adjustments_total`, `item_total`, `tax_total`, grand `total`, `paid_amount`, currency, and deposit-tax-inclusive flag;
- bounded extra-adjustment, adjustment, price-adjustment, and cancellation-policy details;
- each room's before-tax price, after-tax total, base price, subtotal, extras, fixed adjustments, included taxes, excluded fees/taxes, promotions, cancellation refund/penalty values and tax types;
- nightly date, final price, original price, discount, rate code, and pricing version;
- bounded room extras with price/base/discount/total/quantity/date/repeat/included-in-price facts; and
- safe payment state, amount/currency, exchanged amount/property currency, exchange rate, time, method, installment, and response code.

`paid_amount` and HotelRunner payment rows describe vendor-reported payment facts; they do not mean xHotelPro collected money and do not establish the OTA's remittance to the hotel. Likewise, taxes, excluded fees, discounts, promotions, cancellation penalties, and adjustments are not automatically OTA commission.

The hotel-facing contract is therefore:

- show HotelRunner's canonical gross/grand total and its documented components in reservation details, tables, and receipts; never describe local contracted/base pricing as OTA net, payout, expense, or commission;
- keep local root/contracted price explicitly separate;
- show net after OTA expenses only when a trusted, authenticated, source-backed OTA email explicitly supplies both gross and payout and passes exact identity, hotel, stay, room-count, currency, arithmetic, and protected-finance checks;
- label that value as verified OTA-email evidence, not HotelRunner payout;
- compute OTA expense only as verified gross minus verified payout; and
- otherwise show net/commission as unavailable or awaiting verified payout—never zero, gross, local root, `paid_amount`, or an estimated percentage.

The frontend's canonical guest-gross/report adapters retain missing money as `null` with `available: false`; renderers use an unavailable marker instead of coercing that absence to zero. Receipt summaries use the HotelRunner canonical grand total when present and keep the legacy receipt amount/wording path for non-HotelRunner reservations.

Verified email evidence is recorded in `supplierData.hotelRunnerEmailCommercialEvidence`. It survives a later matching HotelRunner update only while provider, reservation identity, currency/amount role, stay/room ownership, and commercial totals remain compatible. A provider, critical-stay, or commercial-amount change invalidates both the evidence and `commission_ota` rather than carrying a stale amount forward. A minimal cancellation without replacement pricing preserves still-valid evidence.

Two commission fields are intentionally separate:

- `commission` is the legacy xHotelPro/platform commission field. Direct
  HotelRunner ownership writes it as numeric `0`; this does not mean that the
  OTA charged no fee and does not create finance-assignment evidence.
- `commission_ota` is a nullable numeric SAR field for an exact OTA
  deduction proven by authenticated commercial evidence. `null` means unknown
  or unverified. It is never populated from HotelRunner taxes, discounts,
  adjustments, local room cost, `paid_amount`, or a default percentage.

The field name follows the PMS contract requested for this integration. Its
provenance remains explicit: the generic HotelRunner reservation schema does
not guarantee a dedicated OTA-commission value, so the stored number is the
verified difference between OTA guest gross and hotel payout. Depending on the
OTA contract, that difference can include commission and other OTA deductions.
The generic reservation editor cannot write `commission_ota`; only the guarded
background/email-evidence paths can set or clear it.

Availability is consensus-based, not first-value-wins. Every explicitly verified finite candidate for a report metric across `adminPricing`, `ota_financial_summary`, and `otaFinancialSummary` must agree to cents; malformed or contradictory candidates make that metric unavailable. The separate PMS platform-commission workflow likewise requires an explicit assignment (including an intentional zero), valid money, and agreement between assigned finance records. Missing, malformed, or conflicting evidence remains `null`/unavailable in detail views and is counted as unavailable in aggregates.

### Financial reports and actions

The same policy applies outside the reservation-detail screen:

- admin/hotel overview aggregations use explicit verified HotelRunner OTA expense only and include `commissionUnavailableCount` for excluded reservations;
- overall profit reporting keeps gross/client totals visible but does not treat HotelRunner room subtotal as hotel net or taxes/extras as platform profit;
- CSV/Excel normalization preserves unavailable text instead of coercing it into a fabricated number;
- payment dialogs cannot derive a chargeable commission from HotelRunner room prices; commission-based options require an explicit staff-reviewed PMS commission; and
- a later unrelated finance update cannot reconstruct commission from HotelRunner room pricing when no reviewed commission exists.

Legacy non-HotelRunner calculations retain their existing semantics. These guards are transport-specific and do not globally change the PMS financial model.

### Targeted production consistency audit on 2026-08-07

The activation audit examined the eight HotelRunner pushes that existed for
the supported Zad Ajyad property at the cutoff. No vendor API request was made.
The result was:

- all eight pushes were already durably archived;
- no duplicate PMS reservation was found for any of the eight identities;
- four Trip.com pushes were held because HotelRunner reported the booking in
  USD while the existing email-created PMS rows were in SAR;
- three active Agoda pushes were linked to their one existing PMS reservation,
  but the earlier generic gross assumption had marked their otherwise exact
  commercial evidence stale;
- one Agoda cancellation had updated the same linked reservation; and
- all five approved room mappings were active and used as expected. The master
  fallback remained unmapped and was not involved.

The observed provider amount roles were not treated as universal vendor
contracts. In these audited records, Trip.com HotelRunner totals matched the
email's source-currency guest total. The email's fixed-rate conversion was
enough to link/protect the SAR gross, but its default percentage deduction was
only an estimate, so `commission_ota` remains `null`. The audited Agoda
HotelRunner totals matched the authenticated email payout; where that email
also supplied exact guest gross and payout, `commission_ota` can be stored as
their exact difference while the original HotelRunner pricing snapshot remains
unchanged.

That earlier lifecycle-first convergence rule is superseded for new eligible
mail. Creation is now transport-prioritized: a durable HotelRunner callback or
exact reservation-number lookup gets the first opportunity to create the local
row, and direct email may create only after a current, identity-bound,
documented confirmed-empty API response. The authenticated direct email remains
commercial evidence for fields the HotelRunner schema does not guarantee.
Uncovered properties and non-eligible message types retain their existing email
handling.

### One-time audited reconciliation

The 2026-08-07 repair is deliberately fixed to those exact eight archived
pushes and is dry-run-only unless the immutable repair ID is supplied. It never
calls HotelRunner, creates a reservation, or changes lifecycle, guest, stay,
room, or payment data.

Run the production dry-run first:

```bash
npm run hotelrunner:reconcile-priority-commission-20260807
```

Apply only after that output reports eight exact targets, four Trip requeues,
four Agoda commercial backfills, zero reservation creations, zero lifecycle
mutations, and zero vendor API calls:

```bash
npm run hotelrunner:reconcile-priority-commission-20260807 -- \
  --apply \
  --repair-id=hotelrunner-zad-ajyad-20260807-api-priority-commission-v1
```

The apply path uses exact event/mirror/reservation compare-and-set filters,
majority writes, and an immutable resumable manifest. A changed identity,
payload proof, mirror proof, reservation version, commission value, active
lease, configuration gate, or authenticated email fact stops the repair. Trip
events are handed back to the normal serialized worker; Agoda records receive
only the already-proven financial aliases and stale commercial-attention
cleanup. Re-running the command is idempotent and must not repeat a completed
target.

## Current OTA-email authority boundary

While `HOTELRUNNER_INTEGRATION_ENABLED=false`, authenticated, source-backed OTA inbound email is the sole active reservation lifecycle transport for supported OTA reservations:

1. direct OTA new-reservation email follows the normal inline mapper instead of the HotelRunner-first queue;
2. direct OTA modification and cancellation email may update the matching local reservation through the existing guarded mapper even when that row retains historical HotelRunner source or projection markers;
3. no callback event, vendor lookup, negative lookup proof, fallback grace period, or HotelRunner worker job may delay or outrank the email; and
4. existing email authentication, provider identity, hotel scoping, deduplication, optimistic concurrency, local housing/finance/payment ownership, and audit safeguards remain mandatory.

Authenticated HotelRunner-branded relay email is treated only as inbound-email transport in this mode and may reach the ordinary guarded email mapper; it never becomes API authority or permission to call the vendor. Its sender authentication, embedded OTA identity, ambiguity, ordering, deduplication, hotel, housing, finance, and payment safeguards still apply. Historical HotelRunner event, mirror, mapping, pricing, and source fields remain intact for audit/report correctness, but they do not suppress trusted inbound-email lifecycle changes in this mode.

Turning the master boundary off does not erase or rewrite past reservations. Turning it on in the future is not sufficient by itself to restore the former HotelRunner-first authority rules; that requires the new paid subscription and explicit dated reactivation review described at the top of this document.

## Historical reconciliation and API quota design — inactive

This design is dormant. No reconciliation, room-list, delivery-confirmation, or other HotelRunner vendor request is permitted under the 2026-08-13 email-only contract.

Push is the fast path; limited history retrieval is the repair path.

### Pull behavior

- Initial history window: 29 days.
- Completed cycle overlap: two days.
- Maximum pages per cycle: three.
- Implementation page size: 50.
- Incomplete pagination resumes with a one-page overlap.
- Pull cursor, page, cycle start, and next due time are persisted.
- When independently enabled, room-list sync defaults to one refresh every 24 hours.
- Pull interval defaults to 30 minutes with jitter.
- A ten-minute database lease prevents concurrent workers from running the same property pull.
- Background history pull and automatic room-list refresh both default off. `npm run hotelrunner:rooms:once` is the explicit bootstrap path and can run while both switches and projection are false. On a fresh/due bootstrap it performs exactly one room-list request, publishes the complete generation, performs zero reservation-history calls, and exits. It returns with zero calls when the refresh is not due, the same failed credential is still on hold, or another pull/projection lease owns the property; changed credentials may immediately clear the credential hold.

The first due cycle can use one room-list call plus up to three reservation calls, exactly matching the internal four-calls/minute property budget. Subsequent cycles normally use only reservation history calls.

The vendor documentation limits creation-date lookback to 30 days. The integration uses `from_last_update_date` for reconciliation and persists every received event locally; HotelRunner is not treated as the permanent archive.

### Backoff

- `401`/`403` credentials hold the same credential fingerprint for 24 hours.
- Changing the credential fingerprint allows immediate recovery.
- Other non-retryable client errors wait at least six hours.
- Retryable failures wait at least five minutes and honor `Retry-After`.
- Local quota exhaustion blocks the call before network I/O.

### Deliberately disabled outbound actions

The client contains a delivery-confirmation primitive, but the outbound PUT boundary enforces three independent requirements: the canonical confirmation flag, active projection, and non-empty bounded PMS/message identifiers. The public generic request primitive is GET-only, so it cannot bypass this gate. HotelRunner requires separate enablement, and confirming transport delivery is not the same as proving successful PMS projection. It may be activated only in a later reviewed phase, after a local projection succeeds and the final PMS number is known.

Reservation-state response is also disabled. Even when `requires_response=true`, xHotelPro currently stores the fact for staff visibility but does not automatically accept or cancel the reservation upstream.

## Security controls

- Secrets are backend-only and Git-ignored.
- Production environment and backups have restrictive filesystem permissions.
- Deployed frontend PR #26 adds `prestart`/`prebuild` checks for the same dotenv file families Create React App loads plus inherited environment names and refuses server-only credential markers without printing values.
- Callback token and HR ID are both required and compared safely.
- Callback credential/property readiness is separated from worker-only feature-flag validity: callback archival can remain available while an invalid worker configuration still prevents every worker/database action.
- Callback authentication happens before parsing the form body.
- Body, field, part, reservation-count, text, room, night, and response limits bound memory/work.
- The deployed Nginx hardener disables both `access_log` and callback error logging in the exact callback location; it preserves the rest of the active site, tests the candidate config, reloads, and rolls back on failure. Its root installation completed on 2026-08-07, and the active block now has `access_log off;` plus `error_log /dev/null crit;`.
- The deployed backend and frontend default their production servers to loopback, and post-deploy listener checks proved only `127.0.0.1:8080` and `127.0.0.1:3080`; Nginx/Cloudflare and local health monitors continue through loopback.
- Application URL sanitization removes the complete callback query, not only known keys.
- Error sanitization redacts common credentials and truncates messages.
- External API host/path/protocol are allowlisted; credentials/userinfo in the base URL are rejected.
- Redirects are rejected to avoid credential forwarding.
- Persistent unique indexes enforce transport and business identity.
- Admin status/mapping endpoints are authenticated and property-scoped.
- The deployed backend makes the generic reservation mutation endpoint repeat server-side hotel authorization against the stored reservation, strip server-managed HotelRunner/OTA markers, and avoid logging update payloads.
- The deployed backend makes existing hotel financial-report endpoints that can expose HotelRunner reservation data require sign-in and repeat server-side hotel authorization before querying.
- Event and mirror payloads are hidden from default model queries.
- Projection, pull, and future outbound inventory/rate operations use separate activation controls.

Security limitations to remember:

- query credentials are part of HotelRunner's documented contract and are visible to any trusted TLS termination layer;
- the published REST callback documentation does not specify a webhook signature or source-IP allowlist;
- normalized event storage contains PII and needs retention/access controls; and
- four exact legacy UI-only variables (`REACT_APP_REPORTS`, `REACT_APP_CUSTOMER_SERVICE`, `REACT_APP_INTEGRATOR_PASSWORD`, and `REACT_APP_PASSCODE`) remain browser-public convenience gates. They are explicitly grandfathered by the build guard, are not authorization boundaries, and backend authentication/authorization remains authoritative. Every new password/passcode name and all HotelRunner/token/server-secret markers are still rejected; migrating these four legacy gates is separate security debt; and
- the dedicated frontend/admin permission still needs the least-privilege correction documented above.

### Frontend bundle credential incident and build boundary

The pre-existing frontend `.env` and compiled static bundle contained unused copies of server credentials under `REACT_APP_*` names. Create React App embeds every such value into public JavaScript even when a normal user interface does not display it. The affected frontend names were removed locally and from production with protected rollback copies, and the production frontend environment was tightened to mode `600`. No current frontend source referenced those removed names, so this environment cleanup does not disable a PMS feature.

Historical static assets must nevertheless be treated as compromised until all of the following are complete:

1. deploy a clean build that passed `npm run prebuild`;
2. prove the removed values are absent from every newly served JavaScript asset without logging the values;
3. remove/replace the old hashed assets and invalidate any external cache that may retain them; and
4. rotate/revoke the exposed provider credentials: every exposed HotelRunner token, the Google OAuth client secret, the Stripe secret key, and the provider credential previously stored as a frontend access token.

OAuth client IDs, payment publishable keys, PayPal client IDs, and properly provider-restricted browser Maps keys are public identifiers by design and are not rejected merely for being browser-readable. Their provider-side origin/referrer restrictions still need normal review. The guard explicitly rejects HotelRunner API-key aliases such as the separated and compact `HOTEL_RUNNER`/`HOTELRUNNER` forms plus `HR_API_KEY`/`HR_KEY`; it also rejects current and future names containing server-only markers such as client/private/signing/encryption secrets, access/API/auth/bearer/refresh tokens, database URIs, service-account keys, and webhook/session/JWT secrets. It does not ban every generic browser API-key name, because some restricted browser keys are intentionally public.

## Historical controlled deployment and activation runbook — do not execute

This runbook records the pre-cancellation rollout design. It was superseded on 2026-08-13 and must not be executed while the subscription is cancelled. In particular, do not rotate/test HotelRunner credentials, run room discovery or history pulls, enable callbacks, start projection, or make any vendor request. The only current gate actions are read-only status inspection and fail-closed deactivation as described above.

### Git and shared-server deployment discipline

1. Publish reviewed backend and frontend commits to GitHub and record their complete SHAs. The deployed and verified loopback network-boundary revisions are now rollback floors; HotelRunner feature rollback must not reopen wildcard origin listeners.
2. On production, fetch without merging. Verify the expected commit objects and ancestry, tracked worktrees, branch/upstream state, and the candidate commit-to-commit path list.
3. Enumerate existing untracked paths and prove none collides with a candidate tracked path. Production contains intentional untracked backups/build artifacts: never use `git clean`, `git reset --hard`, or blanket checkout to remove them.
4. Record target PM2 names/PIDs/status, loopback/public health, listener addresses, relevant database counts, queue/mapping counts, and a secure sample reservation hash before changing code.
5. Fast-forward only to the exact recorded GitHub SHA. Do not copy a random local source tree or deploy an uncommitted helper.
6. Run dependency installation only if the reviewed lock/package change requires it. Back up the existing frontend build to a unique verified path before the production build replaces it.
7. Restart only `hotels-backend` and `hotels-frontend`. Do not restart, delete, renumber, or globally save unrelated PM2 applications.
8. Verify exact Git SHAs, loopback listeners, Nginx/Cloudflare public health, callback behavior/log isolation, frontend asset integrity, OTA-email continuity, and unchanged unrelated PM2 PIDs/status. Keep the HotelRunner worker absent/stopped and every mutation/network gate false.
9. If a named check fails, roll back only the affected repository/process to its recorded security-floor SHA/build backup. Once loopback edge hardening has been deployed and verified, do not roll back behind it. Never alter reservation data as part of code rollback.

### Gate 0 - historical pre-discovery stop point

This was the production stop point before the 2026-08-07 Nginx hardening, authenticated callback probe, and one-call discovery. The owner explicitly instructed retention of the one current credential after being told it matches the historical logged value; rotation remains recommended but was not performed. The persistent worker and projection must still not start before mapping approval.

- Projection stays false.
- Worker stays stopped.
- Room-calendar update permission stays off.
- No live reservation test is performed.
- The existing OTA-email pipeline remains active.
- Do not publish a frontend build unless the client-environment guard passes.
- Replace the historical secret-bearing static assets before claiming the frontend deployment is clean.
- The recorded backend/frontend merges are deployed. Any Gate-0 redeploy must use those exact reviewed revisions (or a newer separately reviewed release), keep all four HotelRunner gates false, and run no room-list or reservation-history command.
- Run the versioned Nginx callback-log hardener and restart only `hotels-backend`/`hotels-frontend`; verify their listeners are exactly loopback while all unrelated PM2 process IDs/statuses remain unchanged.
- Verify public xHotelPro and Jannat Booking health through Nginx/Cloudflare, and verify direct external connections to origin ports `8080`/`3080` fail. Roll back only the named application revision if any named health check fails.

### Gate 1 - rotate and install credentials

1. Disable live push temporarily.
2. Rotate/revoke every exposed HotelRunner token. Separately rotate the exposed Google OAuth, Stripe, and unidentified legacy access-token provider credentials after the clean frontend build is served.
3. Run the versioned env-gate `status`, then install the replacement token locally and in production with its stdin-only `rotate-token` command. Do not use the drifted/unversioned home-directory updater and do not place the value in argv, chat, Git, output, or command history.
4. Preserve `.env` permissions and a secure rollback copy.
5. Run `assert-room-discovery`; independently confirm the target PM2 processes have no inherited `HOTELRUNNER_*` overrides. Restart only the main backend with projection, history pull, room-list sync, and delivery confirmation still false.
6. Verify revoked credential rejection, new credential acceptance, callback health, and log non-disclosure without making a HotelRunner room-list/history call. Authentication may be proven by callback checks or the single approved discovery at Gate 2; do not add a throwaway vendor request merely as a health probe.
7. Check the normal PMS health, OTA-email worker health, and baseline reservation counts/hash samples.

Stop on any credential/logging anomaly.

### Gate 2 - one-call room discovery, worker and projection off

1. Verify production config reports exactly one property, pull false, projection false, and internal budgets 225/4/60 (unless a reviewed lower value is used).
2. Run `npm run hotelrunner:indexes:verify`. This observation-only gate proves the exact `uniq_ota_identity_key` and `uniq_ota_cross_transport_identity_key` partial-unique definitions on `Reservations`; it does not initialize any collection or index. It must never call broad `Reservations.init()` or create an index automatically on production. If either index is absent/mismatched, stop for a duplicate preflight and separately approved index migration.
3. Do not start the persistent worker yet. Run `npm run hotelrunner:rooms:once` exactly once. Before the one approved vendor GET, the worker explicitly creates only the five isolated HotelRunner collection indexes and repeats the read-only `Reservations` identity-index proof. It never initializes or creates an index on the packed `Reservations` collection.
4. Confirm it reports one room-list API call and zero reservation-history calls.
5. Confirm the complete mapping generation was persisted, omitted old codes were retired, and structural conflicts are held.
6. Treat API-budget counters as conservative reservations and reconcile them with the one expected network request/log outcome.
7. Confirm PMS reservation documents have not changed.
8. Confirm no mirror/projection mutation occurred.

At this gate, exactly one approved GET is expected and PMS mutation is forbidden. Historical pull remains off until a separate preview/reconciliation phase is approved.

### Gate 3 - mapping and reconciliation review

1. Open `/admin/hotelrunner` as the trusted configured super administrator.
2. Export or capture the room mapping status without credentials or guest data.
3. Map every verified non-master inventory code to one exact active local room category.
   For the owner-approved 2026-08-07 Zad Ajyad release, first run `npm run hotelrunner:mappings:activate-approved-20260807` as a write-free preflight. Apply only with `npm run hotelrunner:mappings:activate-approved-20260807 -- --apply --approval=owner-2026-08-07`. This versioned tool accepts no caller-supplied mapping values, keeps every HotelRunner gate closed, checks the exact six-code discovery generation/currency/capacity/name evidence, leaves the master fallback unmapped, reuses the controller's optimistic compare-and-set, skips already-correct rows on a safe rerun, and makes no vendor request.
4. Verify `SAR`, capacities, rate variants, and channel mappings in HotelRunner/OTA extranets.
5. Leave every master fallback unmapped.
6. Review all pending, needs-mapping, attention, quarantined, and failed events.
7. Keep every pre-activation delivery audit-only. The real fallback incident must not be projected, edited, reopened, or canceled for testing. Its already-proven email reservation remains the local record.
8. Compare reservation counts and secure hashes with the pre-worker baseline.

**Stop and show the mapping/status report to the owner. Do not enable projection without explicit approval.**

#### Activation backlog hazard

Projection off archives events as `pending`, but production activation no longer authorizes that backlog. When projection is true, configuration is invalid unless `HOTELRUNNER_PROJECTION_NOT_BEFORE` is a timezone-qualified ISO timestamp. Every ordinary and recovery claim is restricted to push events whose callback `receivedAt` and source `updated_at` are both at or after the cutoff. Pulled history remains archival in this push-only phase and cannot be claimed.

Set the cutoff immediately before production activation. Deliveries archived before it remain immutable audit evidence and are reported separately as `archive.preActivationEventCount`; they cannot be projected by the worker. A HotelRunner redelivery with the same old `message_uid` remains the same old event and also stays excluded. This is the production bulk-mutation barrier.

Do not backdate the cutoff, remove it, or enable history pull to work around this barrier. A future backlog reconciliation needs a write-free preview or isolated database and explicit review; aggregate counts alone are not approval.

### Gate 4 - activate push-only inbound projection

After the owner approves every room mapping:

1. keep HotelRunner push temporarily disabled and stop any worker;
2. record a reviewed current timezone-qualified activation timestamp (including `Z` or an explicit offset);
3. run the versioned env-gate `activate --not-before <reviewed timestamp>` command. It sets `HOTELRUNNER_PROJECTION_ENABLED=true` and `HOTELRUNNER_ROOM_LIST_SYNC_ENABLED=true`, keeps `HOTELRUNNER_PULL_ENABLED=false` and `HOTELRUNNER_CONFIRM_DELIVERY_ENABLED=false`, and creates the protected rollback;
4. if staff review is required, run `set-review-mode --enabled true`; then run env-gate `status` and independently confirm the target PM2 processes have no inherited HotelRunner override;
5. restart the main backend and verify the status API reports projection true, the exact cutoff, pull false, and the pre-activation archive count;
6. verify/install the versioned `ops/systemd/xhotelpro-hotelrunner-sync.service`, then enable/start that one dedicated unit and verify its database projection lease. Confirm no `hotelrunner-sync` PM2 app exists;
7. prove the worker does not claim any pre-cutoff event and the normal PMS remains healthy;
8. re-enable HotelRunner push for Confirmed, Modified, and Canceled only; and
9. monitor each new event, mirror, reservation, inventory result, and audit entry. Keep **Can update room calendar** off.

Both configuration and the database lease protect this mode: an accidental second worker cannot project concurrently, and old archived events cannot drain. Callback batches can persist quickly, but reservation mutation is serialized one event at a time for this property.

Production worker installation (only at this approved gate):

```sh
sudo systemd-analyze verify ops/systemd/xhotelpro-hotelrunner-sync.service
sudo install -o root -g root -m 0644 ops/systemd/xhotelpro-hotelrunner-sync.service /etc/systemd/system/xhotelpro-hotelrunner-sync.service
sudo systemctl daemon-reload
sudo systemctl enable --now xhotelpro-hotelrunner-sync.service
```

The unit changes no PM2 state, passes no credentials in arguments or `EnvironmentFile`, runs as `ahmedadmin`, loads the protected backend `.env` through the worker, restarts after failure/reboot, and has a 256 MiB memory bound plus systemd sandboxing. A HotelRunner PM2 process is unsupported and must remain absent. Verify with `systemctl status xhotelpro-hotelrunner-sync.service` and a read-only database lease check; do not print the environment.

### Gate 5 - controlled lifecycle validation and steady state

Use HotelRunner's interactive test property if available. If a production OTA test is unavoidable, use one explicitly controlled non-guest test booking approved by the owner. Do not use or alter a real guest reservation as a test.

Test in this order:

1. create;
2. exact push redelivery;
3. modification;
4. cancellation;
5. multi-room case; and
6. one controlled case per connected OTA because upstream codes differ.

Keep history pull off during this validation; a pull duplicate is tested synthetically until the separate reconciliation-preview gate is approved.

For every case verify:

- exactly one local `Reservations` document and one HotelRunner mirror link;
- no duplicate inventory blocking;
- correct room/dates/guest counts/status and `reserved` handling;
- complete HotelRunner gross pricing snapshot and gross display;
- no fabricated net/commission; verified email payout enriches only commercial fields when present;
- modification affects only source-owned fields;
- any allowed overbooking modification appears as durable `attention`;
- cancellation does not disturb payment/finance history;
- local paid/captured/transferred values remain unchanged unless a separate local payment flow changed them;
- uncovered OTA/Airbnb email create/update/cancel still works, while lower-authority email for a direct-owned reservation is audit-only;
- queue and audit records reach expected states; and
- API calls remain inside budgets.

If the main backend and worker do not use the same projection/cutoff setting, or any invariant fails, stop the worker, set projection false, and investigate without stopping the normal PMS.

## Historical verification commands — local/mock use only

These commands document earlier release evidence. Do not run any command that can reach HotelRunner. Current shutdown verification must be limited to local source/configuration inspection, mocks/fixtures, internal endpoints that fail before credential handling, and OTA inbound-email regression checks.

Local/synthetic tests do not consume HotelRunner quota:

```sh
npm run test:hotelrunner
npm run test:ota-inbound
```

Worker commands:

```sh
npm run hotelrunner:indexes:verify
npm run hotelrunner:rooms:once
npm run hotelrunner:worker
npm run hotelrunner:worker:once
```

`hotelrunner:rooms:once` performs at most one room-list call and never performs a reservation pull; due-date, lease, and credential-hold guards can make it a zero-call no-op. `hotelrunner:worker:once` checks the pull path before processing the eligible queue; it makes reservation GETs only when pull is explicitly enabled and due. Neither command is a health probe, and live commands must never be repeated casually.

Do **not** run `pm2 save` as part of this procedure. This server hosts unrelated processes, and a global save snapshots the entire shared PM2 application list. Process persistence is a separate shared-server operation that requires its own backup, complete process-list review, and explicit approval; HotelRunner activation does not authorize it.

### Release and production regression evidence (refresh at each immutable SHA)

The final clean checks for backend implementation commit `ce7217159c13e10cb0ae3135714d86385c5a044e` included:

- 205 HotelRunner tests;
- 371 OTA-inbound tests;
- 24 single-reservation access regressions;
- 9 reservation inventory/authority regressions;
- 25 admin-list tests;
- 12 admin-room tests;
- 7 admin-overview tests;
- 8 reservation-pricing/date tests;
- 2 PayPal owner-access tests;
- 12 environment-gate tests: 11 passed and the Windows-only symbolic-link fixture was skipped because that local environment cannot create symlinks; the production implementation still rejects symlinked environment/backup paths;
- the exact read-only `Reservations` identity-index readiness proof;
- Node syntax checks for all 63 changed/untracked JavaScript files at the time of commit, Git whitespace checks, remote Bash syntax parsing of the Nginx hardener without execution, and a value-based secret scan across 366 tracked/untracked files for 27 protected local environment values.

Frontend PR #26 head `b1f937e8d5137f642e8dfb5274b4a0e8f88e0751`, merged as `3e25743572da2890eef4d4ebe2eca4894cd2db5a`, passed 430 tests across 69 suites, the optimized production build, the client-environment scanner, and a compiled-asset scan covering 50 assets and 39 protected server values with no matches.

These checks used mocks/fixtures or read-only local database inspection and made zero live HotelRunner API calls. Production now runs backend application merge `538678e0fcabe4df56621b5328612ff382da0871` and frontend merge `3e25743572da2890eef4d4ebe2eca4894cd2db5a`, with the worker absent and all HotelRunner gates false. Deployment results are not activation evidence. Re-run the relevant checks after any code change.

## Monitoring and status interpretation

There is no current HotelRunner admin page. The retired page formerly aggregated:

- **Waiting:** pending, processing, and retry events.
- **Needs mapping:** events held for exact room mapping.
- **Attention:** explicit attention, quarantined, and failed events.
- **Processed:** completed and ignored events.
- **Projected:** created, updated, and canceled mirror results.

While the integration is dormant, operational monitoring focuses on the OTA inbound-email endpoint, email audit/deduplication health, inline create/update/cancel results, the five false HotelRunner flags, the disabled callback, and the desired disabled/stopped worker state. It must not call HotelRunner.

The following HotelRunner-specific checks are historical reactivation guidance only:

- callback route and persistence probe (never containing a real token in saved command output);
- last callback/event receipt;
- last pull start/completion/success;
- next pull time and sync status;
- room-list last refresh;
- pull/event failure metrics;
- queue age, not only queue count;
- needs-mapping/quarantine/failed reasons;
- projected versus local reservation counts;
- API budget bucket consumption;
- duplicate/mirror-link conflicts;
- worker process count (zero before Gate 4; exactly one after approved activation);
- active database projection lease/owner and pre-activation audit-only count; and
- absence of callback queries in every logging layer.

Historical alert ideas for a future, newly approved monitoring design:

- callback/pull silence outside an agreed operational window;
- after activation, worker missing or more than one worker;
- stale pull or room-list timestamp;
- any failed event;
- growing retry/processing queue;
- any identity or equal-timestamp integrity conflict;
- quota usage above warning thresholds;
- credential hold;
- unexpected currency;
- master/unverified mapping attempts; or
- lower-authority email mutation attempts for a direct-owned reservation, plus any unexpected failure of uncovered email fallback.

## Failure handling and rollback

### Current email-only safe state

1. Run the versioned env-gate `deactivate` command so the master boundary, projection, pull, recurring room-list sync, and delivery confirmation all become false and the cutoff is cleared atomically.
2. Restart the normal backend with the closed environment. Do not start a HotelRunner worker for testing.
3. The desired supervisor state is `xhotelpro-hotelrunner-sync.service` disabled/stopped with no PM2 duplicate. If the deployer cannot run the required administrator command, do not claim completion: record the residual `Restart=always` unit/process state and verify the master-disabled worker remains in its inert signal-only wait before database connection/model/client/vendor initialization until an administrator disables/stops it.
4. Verify the callback returns a generic `404` before authentication or persistence and verify normal OTA-email create/update/cancel remains inline, including for rows with historical HotelRunner markers. Do not use real HotelRunner credentials or a vendor call for these checks.
5. Preserve historical event/mirror/mapping/audit data and protected dormant credentials; preservation does not grant lifecycle authority.

The mapping, duplicate, credential, and recovery notes below are historical incident guidance. They do not authorize reactivation.

### Mapping problem

- Disable HotelRunner push, stop the dedicated worker, and run env-gate `deactivate` before any mapping write. The backend rejects mapping mutations while projection is enabled so an in-flight event cannot use a just-retired mapping.
- Disable the incorrect mapping using its current version.
- Keep the affected events in review.
- Correct HotelRunner/OTA upstream room/rate mapping when needed.
- Refresh the room list once due/approved.
- Activate only the verified exact mapping and allow held events to requeue.

### Duplicate suspicion

- Stop projection, not the whole PMS.
- Do not delete either reservation.
- Compare HotelRunner mirror, primary ID, provider/HR aliases, hotel, stay, source watermarks, and local audit logs.
- Resolve with an auditable repair procedure; never bypass the unique mirror link casually.

### Credential or log exposure

- Disable push if callbacks cannot authenticate safely.
- Revoke/rotate the token.
- purge or restrict retained logs according to policy;
- verify all termination/logging layers; and
- resume only after revoked/new/log checks pass.

### Recovery characteristics

- exact event/mirror keys make callbacks and pulls idempotent;
- persisted leases recover from process death;
- overlapping pull windows tolerate duplicate delivery;
- the master-disabled mode stops future HotelRunner mutation and restores trusted direct OTA new/update/cancel email to the normal inline path, while existing source markers remain auditable provenance only;
- no rollback requires deleting local reservations; and
- code rollback uses exact Git revisions and retained deployment backups. Preserve the now-deployed network-boundary revisions when rolling back HotelRunner feature code so raw origin ports do not reopen.

## Retired frontend and deferred backend roadmap — no current HotelRunner route

As of **2026-08-13**, there is no current `/admin/hotelrunner` route and no committed plan to add HotelRunner screens. The route, side-menu links, permission mapping, isolated page, API wrapper, and view model are removed. Every phase and route described below is a retired or deferred historical proposal, not a current route, deployment instruction, or promise. A future paid reactivation must produce a new dated roadmap instead of silently resuming this one. Credentials must never become browser-readable.

Inbound reservations that require staff review continue to use the existing `/admin/ota-reservations` component and release API. Historical HotelRunner presentation labels may remain on historical rows, but there is no HotelRunner operational console. Any future admin navigation requires explicit owner approval and a new security/operations review.

### Retired Phase 1A — page removed

Retired route (not registered):

- `/admin/hotelrunner` — removed on 2026-08-13; it is not a current route.

The following were historical ideas before cancellation. They are deferred and must not be treated as required near-term work:

- make `HotelRunnerIntegration` a real assignable least-privilege permission;
- add a write-free identity/projection preview that reuses the production matching rules;
- add a controlled historical backlog review/release mechanism; once projection is explicitly enabled, the activation implementation will exclude all pre-cutoff events, but production is not activated;
- add a clear projection/pull state banner;
- show last callback and last successful pull age;
- show API budget consumption without secrets;
- add a redacted export of mapping/status for owner approval; and
- add explicit read-only wording while projection is off.

### Deferred historical Phase 1B — no routes registered

Retired/deferred route proposals (none are registered or approved):

- `/admin/hotelrunner/room-mappings` - full mapping workflow, filters, version conflicts, verification evidence, and audit actor/time.
- `/admin/hotelrunner/events` - initially read-only redacted event queue, source, state, timestamps, retry/quarantine codes, and mirror/local link.
- `/admin/hotelrunner/quarantine` - read-only held/conflicting records with safe reasons and remediation guidance.
- `/admin/hotelrunner/monitoring` - callback/pull health, worker lease/process status, queue age, quota buckets, and alerts.
- `/admin/hotelrunner/credentials-health` - superadmin-only presence, last persisted authentication outcome, and rotation-required state; never values, fingerprints, secret references, or a refresh-triggered vendor call.
- `/admin/hotelrunner/audit-log` - mapping changes and future operator actions with immutable actor/time/before/after evidence.
- `/admin/hotelrunner/settings` - read-only configuration readiness and feature-flag state; never token/HR-ID values or editing.

Backend additions should use separate controllers/routes rather than expanding unrelated PMS controllers. Event details must expose an allowlisted redacted view, not the stored payload object. Any replay/retry action must be idempotent, audited, version-checked, and disabled while prerequisites are unsafe.

Suggested permission separation as these pages grow:

- `HotelRunnerRead` for overview/monitoring;
- `HotelRunnerMappings` for room mapping;
- `HotelRunnerOperations` for one-event retry after review;
- `HotelRunnerOutboundPreview` for future dry-run inventory/rates; and
- `HotelRunnerOutboundManage` for future approved outbound activation.

Each subroute must be exact and server-enforced. A broad prefix route must not let a read-only user reach mapping or future outbound mutations. Projection, worker activation, and actual secrets remain deployment controls, not ordinary browser buttons.

The first event/quarantine UI is read-only and cursor-paginated. Its server allowlist may include event ID, property, push/pull source, state/status, safe channel label, timestamps, sanitized reason, masked external reference, and an authorized local reservation link. It must exclude raw payload/snapshot objects, guest/contact data, callback queries/headers, payment details, and unredacted integrity evidence.

A later single-event retry requires a separate operations permission, expected version, operator reason, immutable audit record, and all existing idempotency/mapping/currency/identity/finance safeguards. It cannot edit/delete raw events or bypass projection controls.

### Deferred historical Phase 1C — not active

Only after create/modify/cancel is flawless:

- consider delivery confirmation after successful local projection and PMS-number assignment;
- consider a staff-reviewed response queue for `requires_response=true`;
- use separate feature flags and explicit HotelRunner enablement;
- never automatically cancel/accept based only on transport receipt; and
- add full audit, idempotency, quota, retry, and rollback tests.

### Deferred historical Phase 2 — no outbound project is active

This is a separate project. Proposed routes:

- `/admin/hotelrunner/inventory` - availability/restriction synchronization status, dry-run diffs, failures, and emergency stop.
- `/admin/hotelrunner/rates` - rate mappings, source-of-truth rules, proposed deltas, validation, and transaction results.

Required architecture:

```text
local reservation / room / pricing change
  -> durable HotelRunner outbox
  -> coalescer (latest value per property/room/date/rate/channel)
  -> validation and dry-run diff
  -> quota-aware batched sender
  -> transaction/result tracker
  -> retry or operator attention
```

Phase 2 requirements:

- xHotelPro is the single inventory/rate source of truth;
- separate `HOTELRUNNER_INVENTORY_PUSH_ENABLED` and `HOTELRUNNER_RATE_PUSH_ENABLED` gates default off;
- enable **Can update room calendar** only after dry-run and controlled sandbox proof;
- use room-list capability flags (`availability_update`, `restrictions_update`, `price_update`);
- distinguish `inv_code` allocation from rate-specific `rate_code` pricing;
- send only changed values and batch dates/rooms where the official endpoint supports it;
- coalesce rapid local edits rather than issuing one API call per UI action;
- persist every outbound intent/result with idempotency and a transaction identifier;
- enforce hotel timezone, date range, currency, occupancy, min/max stay, stop-sell, CTA, and CTD validation;
- implement per-channel/date safeguards and preview before broad activation;
- share the persistent quota budget with reservation reconciliation;
- provide an immediate server-side stop switch;
- define conflict ownership when staff edit HotelRunner/OTA extranets directly;
- roll out one room/rate/date/channel at a time before full automation; and
- never infer successful OTA propagation merely from a successful xHotelPro-to-HotelRunner request.

### Deferred historical Phase 3 — not active

- replace the singular environment binding with explicit per-property credential secret references;
- independent flags, room mappings, cursors, budgets, and worker leases per property;
- admin route property selection constrained by user assignments;
- staggered/jittered schedules across properties;
- application-wide quota coordination; and
- per-property rollout and rollback.

### Not promised by the documented Custom Apps API

Do not place these on the committed roadmap without private HotelRunner documentation and a new security review:

- reading/replying to OTA guest conversation threads;
- attachments/read receipts/message webhooks;
- retrieving full OTA virtual-card credentials; or
- automatically charging an OTA virtual card.

HotelRunner reservation comments and payment metadata are not substitutes for messaging or a virtual-card terminal.

## Historical reactivation acceptance checklist — not a current plan

This checklist is retained only as historical safety context. The subscription is cancelled, HotelRunner is disabled, OTA inbound email is the sole current lifecycle transport, and no inbound HotelRunner go-live is planned. Nothing in this checklist authorizes a vendor call or activation. A future paid reactivation requires a new dated acceptance plan and may reuse only the safeguards that are re-reviewed then.

Inbound HotelRunner authority is not done until all are true:

- exposed token revoked and replacement installed safely;
- a guard-clean frontend build replaced every historical secret-bearing static asset, removed values were proved absent without logging them, caches were addressed, and all exposed provider credentials were rotated/revoked;
- revoked/new/logging checks passed;
- exact code revisions recorded in GitHub and production;
- callback POST persistence verified;
- exactly one dedicated systemd worker healthy and reboot-enabled, with no HotelRunner PM2 duplicate;
- database-backed property serialization verified;
- both exact Reservations partial-unique identity indexes verified read-only before any projection;
- projection remained off during discovery;
- exactly one room-list-only discovery completed within quota; history pull remained off;
- all non-master inventory codes reviewed and mapped exactly;
- master fallback unmapped;
- currency verified;
- queue/attention/quarantine review complete and the activation cutoff excludes every pre-activation event;
- the real email-fallback record remains untouched and audit-only;
- controlled create/redelivery/modify/cancel/multi-room tests passed (pull duplicate remains synthetic until reconciliation is approved);
- payment/finance/local ownership protections verified;
- complete HotelRunner gross pricing preservation verified; net payout is either explicitly verified from trusted OTA evidence or visibly unavailable;
- OTA-email fallback verified for uncovered reservations/accounts/listings, direct-owned lifecycle suppression verified per reservation, and other hotels verified unchanged;
- owner explicitly approved mappings and activation;
- backend and worker share projection true only at activation;
- push re-enabled only after the receiving side is healthy; and
- room-calendar update permission remains off.

## Official HotelRunner references

- [Custom Apps overview and limits](https://developers.hotelrunner.com/custom-apps)
- [REST API authentication](https://developers.hotelrunner.com/custom-apps/rest-api)
- [Real-time reservation push](https://developers.hotelrunner.com/custom-apps/rest-api/reservations/realtime-push)
- [Retrieve reservations](https://developers.hotelrunner.com/custom-apps/rest-api/reservations/retrieve-reservations)
- [Get room list](https://developers.hotelrunner.com/custom-apps/rest-api/inventory/get-room-list)
- [Confirm reservation delivery](https://developers.hotelrunner.com/custom-apps/rest-api/reservations/confirm-reservation-delivery)
- [Reservation state update](https://developers.hotelrunner.com/custom-apps/rest-api/reservations/reservation-state-update)
- [PMS partner getting started/test property](https://developers.hotelrunner.com/custom-apps/getting-started)
- [Inventory integration guidance](https://developers.hotelrunner.com/custom-apps/rest-api/inventory)
- [Date-range inventory update](https://developers.hotelrunner.com/custom-apps/rest-api/inventory/update-room)
- [Multi-room/daily inventory update](https://developers.hotelrunner.com/custom-apps/rest-api/inventory/update-room-multi-rooms-dates)

Vendor documentation does not publish a guaranteed REST retry count or email-fallback contract. The production email fallback described here is an observed incident, not a contractual retry guarantee.

## Change log

- **2026-08-13:** Recorded the owner-requested cancellation of the HotelRunner API subscription and made OTA inbound email the sole active reservation lifecycle transport. Added the fail-closed `HOTELRUNNER_INTEGRATION_ENABLED=false` master contract alongside all four legacy gates false and a blank cutoff; disabled callback authority; required the client to reject and any residual `Restart=always` worker to wait inertly before database connection/model/client/vendor initialization; restored trusted direct OTA email to inline lifecycle handling even for historical HotelRunner-marked rows; retained credentials and stored HotelRunner data as dormant provenance only; retired `/admin/hotelrunner`, its English/Arabic side-menu and permission wiring, and its dedicated frontend modules; prohibited live vendor test calls; and explicitly deferred all old activation/UI roadmap material. Production flag, callback, build, OTA-email, and supervisor facts remain subject to post-deployment verification and must not be inferred from this source update.
- **2026-08-07:** Audited the eight current Zad Ajyad HotelRunner pushes with zero vendor calls and zero writes: every identity had exactly one PMS reservation, four were already API-owned, and four foreign-currency events were safely held against existing email-created rows. Added the authenticated email-commercial bridge, direct-source `commission=0`, nullable evidence-only `commission_ota`, and the immutable one-time reconciliation runbook. The production dry-run proved four Trip handoffs plus four Agoda evidence backfills without reservation creation or lifecycle/stay/room/payment mutation.
- **2026-08-07:** Installed and verified the versioned Nginx callback log hardener, proved configured callback authentication with a write-free `422` probe, completed exactly one six-code room-list discovery with zero reservation-history calls, preserved PMS/OTA invariants, and stopped with five verified mappings pending owner approval plus the master fallback permanently unmapped.
- **2026-08-06:** Added a fail-closed frontend environment preflight, removed unused server credential names from local and production frontend environments with protected rollback copies, tightened the production frontend environment to mode `600`, and recorded clean-build/cache/provider-rotation requirements for the historical public-bundle incident.
- **2026-08-06:** Deployed, but did not activate, reservation-level OTA-email coexistence, verified commercial-only payout enrichment, the complete sanitized HotelRunner gross-pricing snapshot, fail-closed pull/configuration, one-call room discovery, room-list generations/retirement/conflict checks, outbound confirmation boundary enforcement, a mandatory production activation cutoff, database-backed one-at-a-time property projection, durable overbooking attention, and removal of only the top-navbar shortcut. Production remains Gate 0 with the worker absent and all HotelRunner gates false.
- **2026-08-06:** Merged backend implementation commit `ce7217159c13e10cb0ae3135714d86385c5a044e` and this runbook through PR #35; deployed application merge `538678e0fcabe4df56621b5328612ff382da0871` and passed the controlled Gate-0 checks recorded above.
- **2026-08-06:** Frontend safeguards merged through PR #26 (head `b1f937e8d5137f642e8dfb5274b4a0e8f88e0751`, merge `3e25743572da2890eef4d4ebe2eca4894cd2db5a`); 430 tests across 69 suites and the optimized build passed, and that exact clean artifact is deployed.
- **2026-08-06:** Recorded the exact Gate-0 production deployment, rollback artifact, health/security checks, unchanged database invariants, OTA-inbound continuity, and remaining Nginx/token gates through documentation PR #36.
- **2026-08-06:** Replaced the short runbook with the complete local-first architecture, security controls, production snapshot, live-fallback interpretation, staged activation, rollback, admin roadmap, and outbound inventory/rate design. Recorded token rotation and dedicated admin permission as outstanding gates.
