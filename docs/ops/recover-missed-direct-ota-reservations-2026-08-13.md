# Strict direct-OTA recovery — 2026-08-13

## Scope and release status

This runbook covers exactly three authenticated direct OTA archives that were received but did not create reservations:

- Agoda `689553735`
- Agoda `689554695`
- Trip.com `1567953939695657`

It does not authorize a broader replay, mailbox scan, HotelRunner import, or manual reservation reconstruction.

**No production recovery, production deployment, or production mutation was performed as part of the 2026-08-13 implementation work.** A future production operator must first deploy the reviewed implementation, run the dry-run against the intended production database, inspect its current evidence, and obtain explicit operational approval before using the apply command.

The recovery must not contain or print guest names, email addresses, phone numbers, or other guest PII. Identity comparisons that need a guest name are performed in memory using a normalized hash and are reported only as a match/no-match result.

## Immutable direct-source evidence

Every value in this table is a required equality check. Any mismatch is source drift and must stop the recovery; it must never be "fixed" by weakening a check.

| Provider | Confirmation | Direct inbound audit ID | Archive email hash | Current archive text hash |
| --- | --- | --- | --- | --- |
| Agoda | `689553735` | `6a7e336d0efaa0e2faa437a9` | `b16366888702c6a57190c52e84c3271e21463efcf0f91f5a9310b26ee6096869` | `4f637ee7dc8f55ad8fcf38b2e37d0351f938d583be55acddb997f8f27d86c56d` |
| Agoda | `689554695` | `6a7e34400efaa0e2faa43887` | `91f49120593c3e970bf985e02836a101f36bd30790c3b2ff1333989df3607420` | `322ac57abaa385ad78022c982f2c2e28334d4f5d1bd82353c8b69d2aa41c50fd` |
| Trip.com | `1567953939695657` | `6a778411bf632980ba060016` | `45d0378aebd409e4fa03395f12d257b28024249dd7e2c10a67419f997a3847a9` | `51cf294c36171862d72880b2551f680c28a639fa60dc4350b4e070cd7f917beb` |

| Confirmation | Message-ID hash | Dedupe-key hash | Source message time | Archive delivery time |
| --- | --- | --- | --- | --- |
| `689553735` | `1a983f9174becdc613fe3b98689eaa781d240ca975646d44bd8705380ed627e5` | `43abcf4fa6767fd17d034111e3cfdabd98b9056a4db973f2918cb3d38ccc3d93` | `2026-08-13T21:13:12.000Z` | `2026-08-13T21:13:17.712Z` |
| `689554695` | `a8b381ab5f625c177c27836ca2981d4f72b8b26c9ff63170db668d489ee09de1` | `3088767716f4827f0290ac4abd5b03fe03d5db2d81fec5b23f60540278ae516a` | `2026-08-13T21:16:44.000Z` | `2026-08-13T21:16:48.917Z` |
| `1567953939695657` | `c622ffc5d925444213f2732814d5fd7e4a780da4cd6d0b5fdf7a016021f6cd47` | `0553cc4522c1c6d6e95c56eebf96b10baff63b0faadc810dd85f61563e2a6b94` | `2026-08-08T19:31:24.000Z` | `2026-08-08T19:31:29.694Z` |

The two Agoda messages must be direct messages from `agoda.com` with aligned, passing DKIM for `agoda.com`; the Trip.com message must be direct from `trip.com` with aligned, passing DKIM for `trip.com`. For all three, the archived sender-authentication tuple must still report an authenticated aligned sender, `authenticatedAligned=true`, `dkimAlignedPass=true`, and the expected aligned domain. A relay, forwarded copy, unaligned SPF result, or stored parser snapshot is not an acceptable substitute.

The recovery reparses the currently stored archive body. The newly parsed source hash must equal the current archive text hash above, and the provider, confirmation, event intent, dates, room quantity, property/hotel mapping, amounts, and authentication must all be derived again from that body. In particular, the Trip.com hash above is the current-body hash; a stale earlier normalized-body hash must not be used as recovery authority.

## Expected reservation materialization

All three reservations map to hotel ID `6a40b6a1a6efe70450536038`. Agoda messages must also carry direct Property ID `90720772`.

| Confirmation | Stay nights | Room configuration ID | Expected rows | Booking gross | OTA payout | OTA expense | Hotel root total | Platform margin |
| --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: |
| `689553735` | 2026-08-20, 2026-08-21 | `6a40df5f1a6d1850eb25c183` (`doubleRooms`) | 2 separate rows, each `count=1`, each containing both nights | SAR 288.00 | SAR 178.20 | SAR 109.80 | SAR 300.00 | SAR -121.80 |
| `689554695` | 2026-08-14 | `6a40e4ec1a6d1850eb25c635` (`familyRooms`) | 2 separate rows, each `count=1`, each containing the full one-night stay | SAR 176.40 | SAR 109.16 | SAR 67.24 | SAR 150.00 | SAR -40.84 |
| `1567953939695657` | 2026-08-12, 2026-08-13, 2026-08-14 | `6a40e0981a6d1850eb25c27c` (`tripleRooms`) | 2 separate rows, each `count=1`, each containing all three nights | SAR 372.83 | SAR 352.13 | SAR 20.70 | SAR 450.00 | SAR -97.87 |

The expected per-night/per-room allocation is:

- Agoda `689553735`: each of the two room rows has SAR 72.00 gross, SAR 44.55 payout, SAR 27.45 expense, and SAR 75.00 hotel root price on each night. Each complete row therefore totals SAR 144.00 gross, SAR 89.10 payout, SAR 54.90 expense, and SAR 150.00 root price.
- Agoda `689554695`: each of the two room rows has SAR 88.20 gross, SAR 54.58 payout, SAR 33.62 expense, and SAR 75.00 root price for the night.
- Trip.com `1567953939695657`: combined nightly gross amounts are SAR 120.45, SAR 120.45, and SAR 131.93; combined nightly payouts are SAR 113.78, SAR 113.78, and SAR 124.57. These are cent-allocated across two `count=1` rows while preserving the exact booking totals. The deterministic room-major split is gross `60.23/60.22`, `60.23/60.22`, `65.97/65.96` and payout `56.89/56.89`, `56.89/56.89`, `62.29/62.28`.

The Trip.com source amounts are USD 99.42 gross and USD 93.90 payout. The archive does **not** contain ordinary cryptographically trusted currency-conversion evidence, and recovery must not fabricate `currencyConversionEvidence`. Instead, this one dated repair pins the complete historical cached tuple: rate `3.75`, source `exchange_rate_api_cached`, source message time `2026-08-08T19:31:24.000Z`, conversion time `2026-08-08T19:31:30.244Z`, legacy stored gross SAR 372.82, and legacy stored payout SAR 352.13. Together with the exact archive ID, email/text hashes, USD nightly rows, repair ID, and policy date, its canonical repair-only tuple hash is `ff333154cdbdad71b406deb7e3c3cca041245d861638bc2bc48b05e122b572e5`.

The narrowly scoped recovery boundary independently recomputes the following with exact decimal half-up arithmetic, performs no network lookup, and persists only `datedRecoveryConversionEvidence` marked `evidenceType=dated_recovery_historical_archive_tuple`, `trustedForOrdinaryAutomation=false`, and `networkUsed=false`:

- Gross: `99.42 × 3.75 = 372.825`, decimal half-up to **SAR 372.83**.
- Payout: `93.90 × 3.75 = 352.125`, decimal half-up to **SAR 352.13**.

The skipped legacy audit represented the gross as SAR 372.82. That obsolete binary-rounding result is not carried forward. The direct recovery audit must record the intentional one-halalah correction (`+0.01`) and its decimal-half-up arithmetic, without fabricating ordinary conversion evidence or retroactively changing the archived source. The dated evidence is explicitly untrusted for every ordinary inbound-automation path. Prepared, persisted, lost-ack, and already-applied verification compare the complete boundary object and its recomputed hash to the exact pinned tuple above; a merely well-formed but different 64-character hash is rejected.

The recovery uses the ordinary authenticated OTA reconciler and its normal inventory validation and reservation creation path. It must not call OrderTaker normalization, reconstruct these as manual reservations, import HotelRunner values, or bypass the unique OTA identity fence.

### Preserved dormant HotelRunner evidence

The two Agoda targets must have no HotelRunner event, mirror, fallback job, or notification-outbox state. Trip.com `1567953939695657` has one pre-existing, exhausted, unlinked HotelRunner projection attempt that is evidence to preserve—not authority to import and not state for this repair to mutate:

- `hotelrunnerevents` ID `6a77841ed8cbed2f4bad4714`, hotel `6a40b6a1a6efe70450536038`, event key `63f73679f12514dcf9edc19a5253b49d0c2b851082c54cf9aa236d2da944d328`, message UID `895182ac5f05d0aa26d5cd707bdd1883`, payload hash `f5ed38f11a35d0ceec74732cb6b4f9edfc7d6cc83668ed3059b90d0553fd9ed7`, canonical hash `cc168a699384b6cccba3921066ccdc354cf2199fcdaac189d5287c5677a32593`, source `push`, HR ID `40367538`, HR number `R367587618`, channel `tripcom`, state `confirmed`, source update `2026-08-08T19:31:38.000Z`, status `failed`, attempts `8`, error code `hotelrunner_currency_waiting_for_email_bridge`, integrity conflict false/count zero, final recovery attempted false, and both reservation/mirror links empty.
- `hotelrunnerreservations` ID `6a77841fde7b4b5990ab845a`, HR fingerprint `841c04f692db5420e2c631afd2e1f3d916e9aa4699a8d778e883b376d48f0a07`, the same exact hotel/HR/provider/channel/state/source timestamp/canonical hash/message UID, aliases exactly `R367587618` and `1567953939695657`, projection `pending` version `0`, identity conflict false, and applied timestamp/hash/reservation/link fields empty.
- No fallback job or notification outbox exists for this identity.

Dry-run, immediate pre-insert, and post-apply verification compare every selected non-PII event/mirror field to the compiled allowlist. Any added record, link, status change, integrity change, attempt change, hash change, or projection change stops recovery. The recovery never updates either dormant document. If HotelRunner is deliberately re-enabled in the future, its adapter derives `trip:1567953939695657` and must resolve the recovered reservation by exact provider alias plus hotel/stay; the unique primary and cross-transport identity indexes remain the final duplicate fences.

## Mandatory stop fences

Dry-run and apply must stop and require human review if any of these checks fails:

1. **Exact scope:** the compiled target set is not exactly the three confirmations and direct audit IDs listed above.
2. **Immutable archive:** an audit ID, archive hash, Message-ID hash, dedupe hash, timestamp, direct source/authentication tuple, sender/provider, or current-body parse differs from the pinned evidence.
3. **Current-body parse:** fresh parsing does not produce a new/confirmed reservation with the expected hotel, room configuration, full stay, `roomCount=2`, source totals, and no blocking/manual-review ambiguity.
4. **HotelRunner off:** all HotelRunner master/projection/pull/room-list/confirmation-delivery gates are explicitly `false`; the HotelRunner sync service is disabled and inactive; and no HotelRunner client, adapter, worker, configuration, or network path is loaded by the recovery.
5. **Later terminal event:** any later direct, relay, or guest-related audit for the same identity freshly parses as cancellation, no-show, or another terminal transition. Non-terminal relay and guest audits are preserved and are never rewritten by this repair.
6. **Existing OTA identity:** the provider identity, cross-transport identity, bare confirmation, or confirmation in any plausible reservation field already resolves to a reservation, unless it is the one fully verified, direct-audit-linked recovery row being finalized after a lost acknowledgement.
7. **Possible manual duplicate:** a reservation without OTA identity plausibly matches the confirmation in any field, or conservatively matches the same hotel, exact stay, normalized primary-guest hash, and room-count/room-type evidence. The dry-run must report only safe IDs and match reasons—not PII—and halt for review.
8. **Index safety:** either required unique OTA identity index (`otaIdentityKey` or `otaCrossTransportIdentityKey`) is absent, non-unique, malformed, or not ready. Both database indexes remain final concurrency fences.
9. **Pre-insert drift:** immediately before the ordinary reconciler inserts, the script repeats the archive, terminal-event, HotelRunner-off, exact-identity, possible-manual-duplicate, both unique-index, exact dormant-state, and full inventory-fingerprint checks. The canonical inventory proof includes every nonvolatile validation field, every issue and warning detail, and the complete room/day capacity, reserved, requested, and availability snapshot; only insertion-time `capturedAt` is excluded. Any new candidate or changed evidence aborts the insert.
10. **Materialization mismatch:** the prepared or created reservation does not have exactly two separate `count=1` room rows with every night represented once per row, the exact totals above, the expected inventory snapshot/warnings, and exact report-driving per-night aliases (`price`, `clientPrice`, `mainPrice`, gross/root totals, payout/post-OTA payout, OTA expense, platform margin, and commission rate) plus room-level chosen/gross/root totals.

Known overbooking is evidence to preserve, not a reason to silently erase the booking or warnings. The `689553735` and `1567953939695657` stays are already overbooked in the audited inventory state. If eventually applied, their normal reconciler results must retain `overbooked=true`, the availability snapshot, and every issue detail. `689554695` was not overbooked in the audited state. Current inventory is re-evaluated during every run, so a changed result is surfaced for review rather than overwritten with these historical observations.

## Dry-run and apply contract

Run from the deployed backend directory. The command is dry-run unless all apply arguments are present:

```sh
npm run ota:recover-missed-direct-20260813
```

The dry-run performs all read-only preflight checks, freshly reparses the three current archives, builds the exact ordinary-reconciler materialization in memory, and prints a PII-free plan. It emits a short-lived proof token only when all three targets are ready. The token binds the immutable target set, current database evidence, expected materialization, repair ID, and planning timestamp. Evidence drift or token expiry requires a new dry-run; a token from another environment or plan must not be accepted.

### 2026-08-13 verification record

After the final persisted-evidence, pricing-alias, complete-inventory, and shared parser safeguards were added, a configured production-database dry-run completed successfully at `2026-08-13T23:21:08.444Z` with plan hash `0ba363eadf382a693c7c9006d0af0ad6b4fbdbd4ecf9158f2dea4354677426fb`. It was read-only and performed no recovery, insert, audit update, HotelRunner call, outbound HTTP request, deployment, restart, or service change. All three targets planned `create_via_ordinary_ota_reconciler`; the two known overbooking warnings retained issue counts `2` and `3`, while `689554695` retained issue count `0`. The focused recovery suite passed `20/20`, and the complete OTA inbound safety suite passed `242/242`. The emitted proof was deliberately not used and must be treated as expired operational evidence, not apply authorization; any future apply requires a new dry-run and explicit approval.

The only valid repair ID is:

```text
missed-direct-ota-email-recovery-20260813-v1
```

After review and explicit production authorization, apply exactly the proved plan:

```sh
npm run ota:recover-missed-direct-20260813 -- --apply --repair-id=missed-direct-ota-email-recovery-20260813-v1 --proof=<DRY_RUN_PROOF_TOKEN>
```

Apply must reject a missing, malformed, stale, or mismatched proof; a different repair ID; extra targets; failed pre-insert checks; or a changed plan. It creates only through the ordinary OTA reconciler. The direct authoritative audit is linked to the resulting reservation with the dated repair marker, while relay/guest audits remain unchanged.

Run the focused automated verification before considering a release:

```sh
npm run test:ota-recovery-20260813
```

## Idempotence, lost acknowledgement, and incident posture

The unique OTA identity index is the final insert fence. A repeated apply must not create another reservation. If the create succeeded but the process lost its acknowledgement before updating the direct audit, a later run may adopt only the single reservation that passes the complete expected-shape check and is already linked to the exact direct inbound audit. It then finalizes that audit link. It must never adopt a merely similar manual reservation or choose between multiple candidates.

If a run stops before all three targets complete, do not delete, cancel, edit, or manually recreate anything. Preserve logs and the PII-free plan, run a fresh dry-run, and let the idempotent/lost-ack checks distinguish completed targets from untouched ones. A partial result is an incident requiring review, not permission to weaken checks.

If post-apply verification finds a mismatch, halt inbound repair work and preserve the reservation, direct audit, availability snapshot, warnings, and all relay/guest audits for investigation. Do not use destructive rollback. Any corrective action must be separately designed and approved from the preserved evidence.
