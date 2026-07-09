# Chatbot Brain-First Dynamic Thread And Payment Hardening - 2026-07-08

## Purpose

This document records the latest chatbot hardening pass for the B2C hotel support/reservation agent, focused on making the OpenAI brain the real conversation owner while keeping the server/orchestrator as a tool executor.

The main goal was to remove legacy behavior that could override a good brain response, especially after reservation confirmation, and to make hotel facts available to the brain up front so service questions are answered dynamically, naturally, and from facts.

## Final Direction

The chatbot is now much closer to the desired structure:

- The brain receives a comprehensive prompt with hotel facts, room facts, service facts, policies, payment policy, support-widget intent, known conversation facts, and latest-message parsing hints.
- The brain decides whether to answer directly, get a quote, ask for missing details, send review, submit reservation, look up reservation, cancel/route, or close.
- The orchestrator executes actions such as quote, review, reservation creation, lookup, and cleanup.
- Legacy pre-brain hotel-fact routing is disabled by default.
- Legacy hotel-fact reply repair guards are disabled by default.
- The server should not inject canned sales bridges into normal brain replies.

## Major Changes

### OpenAI Thread / Brain State

- Added `chatWithState` support in `aiagent/core/openai.js`.
- Uses the OpenAI Responses API when enabled.
- Stores/continues a response thread using previous response ids.
- Sends the system instructions as `instructions` and the latest conversation state as structured input.
- Keeps a hotel-level prompt cache key so the hotel fact pack can be reused more efficiently.
- Keeps a Chat Completions compatibility path only for situations where Responses continuation cannot be used; the intended/default structure is the Responses thread with the brain in control.

### Default Reasoning

- Changed the default `reasoning` effort from `low` to `medium` in `services/openaiModelConfig.js`.
- Added a minimum reasoning-effort guard so chatbot `default`, `booking`, `writer`, `nlu`, and `analysis` calls cannot run below `medium`, even if an environment variable is accidentally set to `low`.
- Verified testing/local `.env` and production `pm2 env 5` use `medium` for the chatbot reasoning variables.
- Reason: the brain reads date, room-count, child-age, split-stay, and payment context more cleanly at `medium`; `low` was too risky for this booking flow.

### Brain-First Orchestrator

- Added an early brain-first handoff in `planTurn`.
- Disabled old pre-brain fact router behavior by default:
  - `AI_LEGACY_PRE_BRAIN_ORCHESTRATOR=false`
  - `AI_PRE_BRAIN_HOTEL_FACT_ROUTER=false`
  - `AI_HOTEL_FACT_REPLY_GUARDS=false`
  - `AI_OPENING_REPLY_GUARD=false`
- The brain is now expected to answer hotel facts directly when the answer exists in the fact pack.
- The orchestrator still executes quote/review/reservation actions and protects data integrity.

### Comprehensive Hotel Fact Pack

The brain now receives structured hotel facts covering:

- Hotel identity in English and Arabic.
- Property type and room-only hotel room rules.
- Active room types, display names, capacity, amenities, views, public offers, monthly packages, and public pricing guidance.
- Location, Google Maps URL, address, city/state/country, walking/driving distance to Al Haram.
- Transport/bus facts from `hasBusService` and `busDetails`.
- Nusuk facts from `isNusuk` and `isNusukText`.
- Parking facts.
- Cancellation/change guidance.
- Room-only meals policy across current Jannat Booking stays.
- Direct booking 25% discount guidance.
- Payment policy.

### Payment Policy Added To Facts

Added an explicit payment fact:

- Guests can pay at the hotel on arrival.
- After confirmation, the guest can show the confirmation number at reception.
- The payment link remains available if online payment is preferred.
- The chatbot must never ask for card details in chat.

This fixed the bad case where the guest asked:

`ينفع ادفع في الفندق؟`

and the previous logic incorrectly repeated the booking review.

After the fix, the tested PMS reply was brain-written and relevant:

`نعم يا أستاذ عمر، يمكنك الدفع في فندق زاد أجياد عند الوصول إن شاء الله...`

### Post-Confirmation Flow Fix

Root cause:

- After a reservation was confirmed, old review/rebooking checkpoint logic could still see completed booking facts plus `emailSkipped`.
- That stale state could override the brain's `reply` and force `send_review` again.
- This caused unrelated post-confirmation questions, especially payment questions, to receive an irrelevant final review.

Fix:

- Added a `reservationAlreadyConfirmed` check using:
  - known confirmation/reservation facts
  - conversation action `reservation_confirmed`
- Prevented the stale review override after reservation confirmation.
- Changed the email-skip review trigger to use only `emailSkippedThisTurn`, not stale `nextKnown.emailSkipped`.
- Aligned confirmation-delivery guard so it does not act like a pre-confirmation flow after a confirmed reservation.

### Opening / Hotel Name Quality

Strengthened prompt instructions so the first agent message:

- Identifies the real hotel name.
- Never says `[hotel name]`.
- Never opens with generic "this hotel" / "هذا الفندق" when the real hotel name is available.
- Uses the real Arabic/English hotel name from facts.

A small sanitizer remains only as a safety net for placeholders/generic hotel identity wording. It does not add facts, bridges, or canned guest replies.

### Multi-Message / Burst Handling

Added latest-message hinting that can combine consecutive unprocessed guest messages before the AI reply.

This helps when a guest sends:

- check-in date
- checkout date
- guest count
- room count

as separate quick messages. The brain sees them as one customer turn and can quote without asking again.

### Meals / Bus / Location Prompt Quality

The prompt now clearly tells the brain:

- Meals are room-only across current Jannat Booking hotel stays.
- Do not promise breakfast, buffet, or hotel meals.
- Positively mention nearby restaurants/services.
- If bus facts exist, answer confidently from exact `busDetails`.
- Do not invent direct Haram service, return trips, free shuttle, prayer schedules, or timings unless explicitly present.
- For location/map questions, include the relevant stored facts cleanly.

### QA Harness Fix

The live QA harness now deletes reservations created by a passed scenario before moving to the next scenario.

Reason:

- Earlier scenarios were creating real test reservations on the same preflight dates.
- Later scenarios could then fail with `inventory_overbook`, even though the chatbot behavior was correct.
- Per-scenario reservation cleanup prevents test data from poisoning later availability checks.

Support cases are still cleaned at the end unless `--keep` is used.

## Live Test Results

All final targeted tests after their related fixes passed.

### Batch 1-9

Marker:

`codex-brainfirst-defaultmedium-01-09-1783487000042`

Result:

- Passed scenarios 1-9.
- Cleanup completed.
- `casesDeleted=9`
- `reservationsDeleted=1`
- `remainingCases=0`
- `remainingReservations=0`

Covered:

- Arabic distance answer with sales bridge.
- Bus answer from hotel facts.
- Meals room-only answer with nearby restaurants.
- Quote markup and 25% discount.
- Budget objection.
- Missing booking details.
- Combined identity details.
- Optional email skip to review.
- Final booking creation.

### Scenario 14 Isolated

Marker:

`codex-brainfirst-s14-inspect-1783487000044`

Result:

- Passed.
- Verified burst messages are processed as one turn after quiet wait.
- Cleanup completed manually afterward.
- `casesDeleted=1`
- `reservationsDeleted=0`
- `remainingCases=0`
- `remainingReservations=0`

### Scenario 10 Payment Regression

Marker:

`codex-payment-fix-s10-1783487000046`

Result:

- Passed after post-confirmation flow fix.
- Verified the final payment question stayed as `action=reply`.
- PMS text was relevant and did not repeat the review.
- Cleanup completed.
- `casesDeleted=1`
- `reservationsDeleted=1`
- `remainingCases=0`
- `remainingReservations=0`

Important verified behavior:

- Guest asked: `ينفع ادفع في الفندق؟`
- Brain answered payment-at-hotel directly.
- No review repeated.
- No hardcoded bridge was injected.

### Scenario 27 Full Human Flow

Marker:

`codex-payment-fix-s27-1783487000047`

Result:

- Passed.
- Reservation created during the scenario.
- Scenario-level reservation cleanup deleted the created reservation.
- Final cleanup deleted the support case.
- `remainingCases=0`
- `remainingReservations=0`

Covered:

- Distance question.
- Bus/service question.
- Quote.
- Required details.
- Optional email skip.
- Review addressed chat guest correctly when booking holder differs.
- Reservation creation.
- Pay-at-hotel after confirmation.
- Contact/photos follow-up.

## Important Testing Note

A full `1-29` rerun was not performed after the final post-confirmation patch because the user asked to stop testing and document.

Before that stop request:

- Scenarios 1-9 passed as a batch.
- Scenario 10 passed after the payment fix.
- Scenario 14 passed isolated after QA harness cleanup investigation.
- Scenario 27 passed after the payment fix.
- The earlier 10-29 run reached scenario 27 and failed only because of the stale post-confirmation review override; that exact failure was fixed and scenario 27 then passed.

Recommended future full regression command:

```powershell
node .\scripts\liveChatbotQa.js --fast --from=1 --to=29 --marker=codex-brainfirst-final-01-29-YYYYMMDD
```

## Cleanup Discipline

Known latest markers were cleaned:

- `codex-brainfirst-s14-inspect-1783487000044`
- `codex-payment-fix-s10-1783487000046`
- `codex-payment-fix-s27-1783487000047`

The QA harness now also removes created reservations scenario-by-scenario when not running with `--keep`.

## Quality Assessment

This version is materially better than the previous legacy orchestrator-heavy setup.

Strengths:

- More dynamic brain-owned replies.
- Better hotel fact awareness.
- Better Arabic opening quality.
- Better multi-message handling.
- Better bus/meals/location/payment facts.
- Less legacy pre-routing.
- Less unnecessary back-and-forth.
- Post-confirmation support questions no longer get dragged back into booking review.
- Lower risk of test inventory poisoning.

Remaining future improvement:

- Run a final uninterrupted full 1-29 regression after deployment/production pull.
- Consider measuring latency by stage again after production restart.
- Continue replacing any remaining deterministic customer-facing fallback paths with brain-authored tool-result replies where practical.

Current rating after this pass:

`9.3 / 10`

Why not 10 yet:

- The brain-first direction is now strong and much cleaner.
- The most painful regression was fixed.
- However, I would only call it 9.7+ after one final clean full 1-29 run on the final patch and a production health check.

## 2026-07-08 Addendum - Last-10 Case Review And 34-Case Hardening

This addendum records the later July 8 pass after reviewing the recent support-case conversations, production `pm2` signals, and the expanded live QA suite.

The architectural direction remains unchanged:

- The first real contact point for guest text is the OpenAI brain.
- Room counts, adult counts, child counts, child ages, split stays, date interpretation, language, tone, and guest-facing wording should be handled by the brain.
- The server is only the executor and integrity layer: it supplies facts, executes quote/review/reservation/payment-message actions, validates that tool results were not corrupted, and sends the final message.
- There must be no return to the legacy hardcoded orchestrator.

### Last-10 Support Case Findings

The last-10 review had several actionable patterns. Some recent cases had little or no guest back-and-forth, so the meaningful findings came from the conversations where the guest and bot actually exchanged booking details.

- `6a4e6398efb662a468439b92` and `6a4e33fcefb662a4684334b7`: a raw protocol fragment reached the guest, for example text shaped like `{"action":"reply","reply":"..."}`. Root cause was an incomplete OpenAI response being accepted after `max_output_tokens`, then the raw action JSON was treated as text.
- `6a4e416cefb662a4684351db`: child age wording could be interpreted incorrectly. The guest meant one adult and two children with age 7, but wording like "7 years" was risky because the system could confuse child age with child count.
- `6a4e3a5defb662a4684344b4`: a three-room / six-adult request could collapse into a one-room family-room quote, and payment wording could appear in the wrong phase.
- `6a4dfa3aefb662a46842f11f`: the bot asked for identity details before showing the quote. This is backwards for the desired flow; the guest should see available room/pricing first, then provide reservation identity.
- `6a4da9ef47bb921351163c7b`: service/location facts such as bus and distance could be answered inconsistently or without a natural booking bridge.
- Staff/admin messages were being treated too much like guest messages in the prompt history, which could confuse the brain's understanding of who said what.
- A plain known fact containing `confirmation` could be too broad and could block official reservation creation, even when no reservation had actually been created.
- Split-stay requests could accidentally multiply room counts by the number of periods when the guest meant one room for each separate period.
- Review text could address the booking holder when the active chat guest was different, for example when the chat guest was arranging the booking for another person.
- Unavailable or partial-inventory quotes could sound like a normal quote if they only listed inventory numbers without clearly saying the request was not fully available.

### Brain-First Fixes Added

The fixes intentionally strengthen the brain, facts, and prompt contract rather than adding a new external decision-maker.

- Added protocol-text sanitation so raw action JSON cannot be sent as guest-facing text.
- Added Responses incomplete-output handling: if OpenAI returns incomplete output because of token limits, the call is retried with more output budget instead of accepting truncated protocol.
- Raised writer/review/submit output budgets and kept reasoning at `medium`.
- Enforced chatbot reasoning effort minimum `medium` in code, so `low` is not allowed even if an env var drifts.
- Updated local `.env` and verified production `pm2 env 5`:
  - `OPENAI_TIMEOUT_MS=45000`
  - `OPENAI_CHATBOT_TIMEOUT_MS=45000`
  - `OPENAI_CHATBOT_REASONING_EFFORT=medium`
  - `OPENAI_CHATBOT_BOOKING_REASONING_EFFORT=medium`
  - `OPENAI_CHATBOT_WRITER_REASONING_EFFORT=medium`
  - `OPENAI_CHATBOT_NLU_REASONING_EFFORT=medium`
  - `OPENAI_CHATBOT_ANALYSIS_REASONING_EFFORT=medium`
- Strengthened the system prompt so quote/pricing comes before identity collection.
- Strengthened child-age instructions: "7 years old", "سنة", "سنين", "سنوات", and similar phrases should be treated as age unless the guest clearly says seven children.
- Added brain fact preservation for split-stay periods and one-room-per-period wording.
- Repaired mojibake-aware intent matching so Arabic confirmation text still reaches the submit-reservation action when the browser/transport mangles encoding.
- Changed official-review confirmation gates to require a created reservation signal, not just a generic `confirmation` string.
- Added chat-guest addressing data to review tool results so the brain can address the active guest politely even when the booking holder differs.
- Moved split-stay review text through the OpenAI writer path, so the brain writes the customer-facing split review instead of a direct server template.
- Added discount visibility to split-stay review facts and validation so discount lines are not silently dropped.
- Added unavailable-quote clarity validation: if the requested inventory is not available, the brain must clearly say that and guide the guest to available alternatives.
- Added a brain-authored hotel-fact bridge repair when a direct service answer is correct but lacks a natural next step toward dates/rooms/discounts.

### Payment Policy Clarification

Payment at the hotel is available and remains valid.

The desired professional wording is:

- The reservation remains confirmed/valid even if the guest does not pay online immediately.
- Paying through the payment link is still recommended, even as a partial payment or deposit when available, because it better secures the room and shows the hotel the guest is serious.
- If the guest does not pay online, that is still acceptable; the hotel may contact the guest to confirm arrival.
- The bot must not invent a required deposit amount.
- The bot must not ask for card details in chat.
- The payment link should be presented as the safe way to pay online.

This is now in the brain instructions and in the post-confirmation payment-message path.

### 34 Meaningful Live Cases

The live QA suite now contains 34 meaningful scenarios. The "meaningful" count is intentional: cases where the client ignored the bot or did not continue the conversation are not the standard for human-like back-and-forth quality.

Important additions after the previous 29-case suite:

- Scenario 30: Long Arabic quote stays as plain customer text and never leaks protocol JSON.
- Scenario 31: Child age phrases do not become child counts.
- Scenario 32: Three-room quotes survive capacity wording and do not collapse into one room.
- Scenario 33: The guest receives quote/pricing before identity details are requested.
- Scenario 34: Compound hotel facts such as distance, bus, meals, and payment stay consistent in one flow.

The harness also now globally checks:

- No raw protocol leak in any customer-facing message.
- No premature identity request before a quote.
- No missing discount markup where the quote/review has a discount.
- No unclear unavailable quote wording.

### Validation Performed

- `npm run test:chatbot` passed locally and in production with `84` regression checks after the final production hardening patches and the 909 contact enhancement.
- Targeted live scenarios passed after the fixes:
  - Scenario 1: Arabic distance answer with a natural sales bridge.
  - Scenario 9: official review confirmation reaches submit reservation after mojibake repair.
  - Scenario 10: post-confirmation pay-at-hotel answer stays relevant.
  - Scenario 18: unavailable request clearly says not fully available and offers alternatives.
  - Scenario 28: review addresses the chat guest correctly when booking holder differs.
  - Scenario 29: split-stay review/submit keeps discount, separate periods, and confirmation details.
- Local live `28-34` passed.
- Remote-tunnel live `28-34` passed against production Mongo test data.
- Production scenario 10 payment flow passed after deployment with marker `codex-proddeploy-brainfirst-20260708-s10-payment-b`.
- Production scenario 32 passed after deployment with marker `codex-proddeploy-brainfirst-20260708-s32-fixed`; the explicit three-family-room request stayed `familyRooms:3` and did not collapse into capacity-optimized alternatives.
- Production live `28-34` passed after deployment with marker `codex-proddeploy-brainfirst-20260708-s28to34-b`.
- Production scenario 29 passed after the final confirmation validation patch with marker `codex-proddeploy-brainfirst-20260708-s29-no-generic-number-check`; no server tool-reply fallback warning was emitted for that final run.
- A local `18-34` run passed through scenario 27 and then stopped because the local `127.0.0.1:27019` Mongo tunnel disappeared before scenario 28. The interrupted QA marker was cleaned later.

Because the local Mongo tunnel failed mid-run, the evidence is assembled from targeted and ranged runs rather than one uninterrupted final `1-34` run. The behavior coverage is still strong, but future-us should run one uninterrupted final sweep after deployment:

```powershell
node .\scripts\liveChatbotQa.js --fast --from=1 --to=34 --marker=codex-brainfirst-final-01-34-YYYYMMDD
```

If local Mongo is not available, use the temporary remote tunnel pattern first:

```powershell
$remoteDb = ssh jannat "cd /home/ahmedadmin/Hotels/hotels_backend && grep '^DATABASE=' .env | cut -d= -f2-"
$env:DATABASE = ($remoteDb.Trim() -replace '127\.0\.0\.1:27017','127.0.0.1:27019')
$tunnel = Start-Process -FilePath ssh -ArgumentList @('-N','-L','27019:127.0.0.1:27017','jannat') -WindowStyle Hidden -PassThru
node .\scripts\liveChatbotQa.js --fast --from=1 --to=34 --marker=codex-brainfirst-final-01-34-YYYYMMDD
Stop-Process -Id $tunnel.Id -Force
```

### PM2 / Production Notes

- Production env was updated and verified with `pm2 env 5`; chatbot reasoning is `medium`, not `low`.
- Production code was deployed directly to `/home/ahmedadmin/Hotels/hotels_backend`, then `pm2 restart hotels-backend --update-env` and `pm2 save --force` were run.
- Production health endpoint returned `ok: true`, model `gpt-5.4-mini`, and all chatbot reasoning lanes at `medium`.
- Production PM2 showed `hotels-backend` online after restart.
- Runtime files synced to production:
  - `aiagent/core/openai.js`
  - `aiagent/core/orchestrator.js`
  - `services/openaiModelConfig.js`
  - `scripts/chatbotRegressionChecks.js`
  - `scripts/liveChatbotQa.js`
  - `docs/chatbot-brain-first-dynamic-thread-and-payment-hardening-2026-07-08.md`
- Production deploy backups were kept under:
  - `deploy-backups/codex-brain-first-20260708-123423`
  - `deploy-backups/codex-review-facts-20260708-123957`
  - `deploy-backups/codex-explicit-room-selection-20260708-130059`
  - `deploy-backups/codex-split-writer-budget-20260708-131246`
  - `deploy-backups/codex-required-confirmation-lines-20260708-131829`
  - `deploy-backups/codex-submit-specific-validation-20260708-132256`
- Final production log spot-check for marker `codex-proddeploy-brainfirst-20260708-s29-no-generic-number-check` did not show a server tool-reply fallback warning. A compact brain-authored repair can still appear for review writing when OpenAI needs a tighter second pass; that is still the brain path, not a server-authored guest reply.
- Temporary/kept QA markers cleaned after the interrupted run:
  - `codexqa-brainfirst-hardening-20260708-s18to34a`
  - `codexqa-brainfirst-hardening-20260708-s18inspect`
  - `codexqa-brainfirst-hardening-20260708-s28inspect`
  - `codexqa-brainfirst-hardening-20260708-s28-remote-b`

### Current Rating After This Addendum

`9.6 / 10`

Why not higher yet:

- The new brain-first structure is much stronger.
- The major real-case failures were directly addressed.
- The regression suite is broader and stricter.
- I still want one clean uninterrupted `1-34` run after deployment before calling this `9.7+`.

### 2026-07-08 Production Deployment Addendum

The production push surfaced two useful final lessons that were fixed without returning to the legacy orchestrator.

- Scenario 32 showed that explicit room selection must beat capacity optimization. When the guest says they want three family rooms, the brain/tools must preserve that as `familyRooms:3` instead of rewriting the request into cheaper or denser alternatives such as quad plus double rooms.
- Scenario 29 showed that split-reservation confirmation text needs a very explicit tool-result contract. The submit-reservation tool now exposes exact confirmation, booking details, and payment-link lines for the brain to copy, while the brain still writes the surrounding human message.
- Submit-reservation validation now uses confirmation-specific checks for confirmation numbers, reservation IDs, booking names, dates, and payment links. The generic visible-number comparison is skipped only for successful submit confirmations because confirmation messages naturally contain many official numbers that were not present in the guest's last message.
- Review validation now distinguishes real official tool facts from vague progress text, so a correct brain review is not rejected just because it says the reservation will be completed after guest confirmation.
- Conditional wording such as "after you confirm" or "not confirmed yet" no longer counts as a completed reservation claim.
- The live QA fixture for scenario 29 now uses a booking holder name that matches the intended split-reservation behavior. Scenario 28 remains the dedicated case for "chat guest differs from booking holder".

Future-us clues:

- Meaningful live suite count remains `34` back-and-forth cases.
- Regression suite count is now `84`.
- Important production markers:
  - `codex-proddeploy-brainfirst-20260708-s10-payment-b`
  - `codex-proddeploy-brainfirst-20260708-s32-fixed`
  - `codex-proddeploy-brainfirst-20260708-s28to34-b`
  - `codex-proddeploy-brainfirst-20260708-s29-no-generic-number-check`
- The next best confidence booster is still one uninterrupted production-connected `1-34` run using a fresh marker, after a quiet traffic window.

### 2026-07-08 909 Contact Enhancement Addendum

This follow-up keeps the same brain-first architecture while making human/reception contact handling clearer and safer.

- The brain prompt now explicitly says that if the brain chooses `action="escalate"`, or the guest asks for a human, manager, reception, or escalation, the guest-facing reply must include:
  - `+1 (909) 222-3374`
  - `https://wa.me/19092223374`
- The prompt also calls out arrival/operational coordination, including very early arrival such as "I am going to the hotel at 4:00 AM". The brain should answer any known hotel policy first, then include the 909 WhatsApp/call contact when live reception coordination or approval is needed.
- The normal brain-first escalation path now runs through an OpenAI writer tool result named `human_escalation_contact`. The tool result gives the brain the exact phone/link and asks OpenAI to write the final customer-facing message.
- The existing tool-reply validation now treats `required_contact_missing` as a repairable OpenAI-writing issue. If a brain-authored escalation/tool reply omits the required phone or WhatsApp link, the repair prompt asks OpenAI to rewrite it with the exact contact facts.
- The older internal human-handoff helper is now also contact-complete, so rare operational handoff paths do not leave the guest without the 909 number.
- Hotel facts now expose `serviceFacts.humanSupportContact` and `serviceFacts.arrivalCoordination`, both carrying the same 909 phone and WhatsApp link for the brain.

Focused regression checks added:

- Brain escalation and arrival contract requires 909 WhatsApp contact.
- Human escalation contact tool facts expose exact 909 phone and WhatsApp.
- Human escalation fallback wording includes 909 phone and WhatsApp.
- Hotel facts expose human support contact for arrival coordination.

Validation:

- Local `npm run test:chatbot` passed with `84` checks.
- Production `npm run test:chatbot` passed with `84` checks after PM2 restart.
- Production focused live scenario 11 passed with marker `codex-prod-909-contact-s11-20260708`; cleanup reported `remainingCases=0` and `remainingReservations=0`.

### 2026-07-08 Public Reservation Date Display + Existing-Reservation Support Addendum

Follow-up case reviewed:

- Contact-page case for confirmation `8602335422`.
- Guest said the public reservation showed arrival/departure as `22` to `26`, while the requested stay was `23` to `27`.
- Production DB reservation was correct:
  - `booking_source`: `online jannat booking`
  - hotel: `zad ajyad`
  - check-in: `2026-07-23`
  - checkout: `2026-07-27`
  - stay dates: `2026-07-23`, `2026-07-24`, `2026-07-25`, `2026-07-26`
  - status: `confirmed`
  - pending confirmation is client-visible confirmed and inventory was blocked
- No admin change log or reservation audit log entries showed a manual date mutation.

Root cause:

- The public SSR receipt and backend PDF receipt formatted hotel stay dates with `new Date(value).toLocaleDateString(...)` without forcing date-only/UTC display.
- The API returned correct UTC-midnight dates such as `2026-07-23T00:00:00.000Z`, but the live SSR server rendered that as `Jul 22, 2026` in its local timezone.
- The guest was therefore seeing a display bug, not a bad reservation record.

Fixes applied:

- `jannatbooking_ssr/app/single-reservation/[confirmation]/page.js`
  - Guest receipt dates now render with `Intl.DateTimeFormat(..., { timeZone: "UTC" })`.
  - Night count now compares UTC calendar days.
- `jannatbooking_ssr/components/ClientPaymentLinkClient.js`
  - Gregorian and Hijri payment-link reservation date display now uses UTC.
- `jannatbooking_ssr/components/DashboardClient.js`
  - Guest dashboard reservation date display now uses UTC.
- `hotels_backend/controllers/assets.js`
  - PDF receipt check-in/check-out display now uses UTC date-only formatting.
- `hotels_backend/aiagent/jannatSupport/brain.js`
  - The brain now receives contact-page `inquiryDetails`, including metadata such as `[Reservation Reference: ...]`.
  - The prompt now tells the brain that existing reservation corrections, cancellations, payment/receipt issues, arrival coordination, and escalation are platform support issues, not new pricing/availability leads.
  - This is intentionally brain-first: no new external mini-router was added to decide for the brain.

Support-response finding:

- The old support reply was wrong for this case. The brain summary understood the guest was asking to correct reservation dates, but the Jannat support flow still produced the generic pricing-detail question because the contact form topic was `room_availability`.
- After this enhancement, the brain has the reservation-reference context and explicit instruction to reply as existing-reservation support instead of asking for room type/guest count.

Validation:

- Local `jannatbooking_ssr` `npm run build` passed.
- Local `hotels_backend` `npm run test:chatbot` passed with `85` checks.
- Production `jannatbooking_ssr` `npm run build` passed.
- Production `hotels_backend` `npm run test:chatbot` passed with `85` checks.
- Production `https://jannatbooking.com/single-reservation/8602335422?codexVerify=20260708` returned:
  - contains `Jul 23, 2026`
  - contains `Jul 27, 2026`
  - does not contain `Jul 22, 2026`
  - does not contain `Jul 26, 2026`
- Production `/api/aiagent/health` returned `ok=true`, OpenAI enabled, and all reasoning effort values at `medium`.

Sync points:

- `jannatbooking_ssr` commit: `aeed7f379e1a220e95076f7d6fdbf15e555dd50c`
- `hotels_backend` commit: `e44e7c9ac814230c37ce6e89528212eb85a4c8d5`
- PM2 services restarted and online:
  - `jannat-ssr`
  - `hotels-backend`

Future-us clue:

- If a guest says an online Jannat Booking reservation is one day early, check the rendered public receipt/payment/dashboard page first before changing reservation data. The DB may already be correct while the display layer is shifting UTC-midnight hotel dates.

### 2026-07-08 Confirmed Bus Fact Reply Addendum

Follow-up case reviewed:

- Support case: `6a4ed970a00e977f5b1a0f0d`.
- Hotel: Zad Ajyad / `6a40b6a1a6efe70450536038`.
- Guest completed a normal booking-style conversation for a double room:
  - check-in: `2026-07-19`
  - checkout: `2026-07-25`
  - nights: `6`
  - guests: `2 adults`
  - quoted total: `450 SAR`
- The pricing and review path was not the failure in this case.
- The guest then asked whether the hotel has buses/transport to the Haram.

Production hotel facts:

- `hasBusService: true`
- `busDetails: "يوفر الفندق باصًا خاصًا لنقل الضيوف إلى موقف الشهداء لتسهيل الوصول والتنقل بكل راحة."`
- Distance facts were also present:
  - walking to Haram: `15 min`
  - driving to Haram: `2 min`

Failure observed:

- The brain answered vaguely instead of using the confirmed hotel fact:
  - it said transport differs by daily operation and asked for stay date/time.
  - after the guest objected, it said it could not confirm bus existence without checking the current hotel policy.
- This was frustrating for the guest because the hotel profile already had a clear bus fact.
- PM2 logs showed normal support-case API traffic and no backend crash or exception. This was a reply-quality/fact-grounding issue, not an infrastructure failure.

Root cause:

- Existing hotel-fact correction logic could catch some hard contradictions and overpromises, but it did not catch this softer Arabic deferral style:
  - `لا أقدر أؤكد لك وجوده الآن...`
  - `خدمة النقل تختلف حسب التشغيل اليومي...`
- The first bad answer was not a direct "no bus" contradiction, so it slipped through even though confirmed `busDetails` existed.

Fix applied:

- `aiagent/core/orchestrator.js`
  - Expanded Arabic deferral detection for known hotel facts, including `لا أقدر أؤكد`, `ما أقدر`, and `مش أقدر` styles.
  - Added a narrow confirmed-bus-fact correction check.
  - When `hasBusService`/`busDetails` confirm bus service and the guest asks about bus/transport, vague deferrals are rejected.
  - When `busDetails` names a concrete stop such as `الشهداء`/Martyrs/Shuhada, the final answer must include that detail instead of giving a generic transport answer.

Brain-first safety note:

- This is not a legacy-orchestrator fallback and not a new external brain.
- The brain still decides the response and owns the conversation.
- The added check only rejects an unsafe/vague final answer when it fails to use already-known hotel facts, then asks the same brain path to repair the answer from those facts.
- No pricing, availability, reservation creation, payment, or guest-detail extraction logic was changed.

Validation:

- Added regression: `Confirmed bus facts reject vague transport deferrals`.
- The regression uses the exact failure pattern from this case and verifies:
  - vague "daily operation / send date or time" transport answers are corrected.
  - Arabic "I cannot confirm now" deferrals are corrected.
  - a good answer that confirms the bus and mentions `الشهداء` passes.
- Local `npm run test:chatbot` passed with `86` checks.
- Production `npm run test:chatbot` passed with `86` checks.
- Production `/api/aiagent/health` returned `ok=true`, OpenAI enabled, model `gpt-5.4-mini`, and all reasoning effort values at `medium`.
- Production PM2 `hotels-backend` restarted and is online.

Sync points:

- Code hardening commit: `38e2ccb881c100f2e7ca377fc92c77000d3df407`
- After the documentation addendum is committed, verify local VS Code workspace, GitHub `origin/master`, and production `/home/ahmedadmin/Hotels/hotels_backend` are all on the same final HEAD.

Future-us clue:

- If a hotel profile has confirmed service facts, especially bus, meals, location, or payment facts, the brain should answer from those facts confidently. For Zad Ajyad bus questions, the expected answer is not "send me your stay date/time"; it should confirm the hotel provides a bus/private transport to `موقف الشهداء` while avoiding guarantees about exact operating times unless those times are present in hotel facts.

### 2026-07-09 Brain-First Payment, Review, and Compound-Fact Addendum

Context:

- Follow-up live-style QA focused on the new brain-first structure after the payment-at-hotel conversation and the bus/Nusuk/location detours.
- The architecture rule remains: the first point of contact is the OpenAI brain, the brain decides the action, and the server only executes tools, validates authoritative facts, sends messages, and asks the same brain path to repair unsafe or incomplete replies.
- No return to the legacy orchestrator was made.
- No external mini-brain was added for room counts, dates, adults/children, payment, bus, Nusuk, or location.

Main findings:

1. Payment-at-hotel answer after a confirmed booking could be too restrictive.
   - The problematic answer said the only available option was the payment link and that the chatbot could not confirm payment on arrival.
   - Correct policy: payment at hotel/reception/on arrival is possible; paying online or paying a deposit through the payment link is recommended because it better secures the room and shows seriousness; online payment is not mandatory; if the reservation is already confirmed, not paying online immediately does not cancel it, but the hotel may contact the guest to confirm arrival.

2. Official review replies could occasionally omit required identity facts.
   - The official pre-submission review is the last checkpoint before reservation creation.
   - The brain-written review is now validated against `toolResult.review.fullName` and `toolResult.review.nationality`. If either is missing, the reply is rejected and rewritten by the brain from the authoritative review facts.

3. A normal reply could invite the guest to confirm issuing the booking before the official review.
   - Example wording caught during QA: `هل تؤكد المضي في إصدار الحجز؟`
   - The existing confirmation-invitation detector now catches Arabic variants such as `تؤكد`, `تأكد`, `توكيد`, `المضي`, and `إصدار الحجز`.
   - When all booking facts and the quote are complete, this routes to `send_review` instead of sending a normal text reply.

4. Hotel-fact detours containing "continue" words could be swallowed by the quote continuation path.
   - Example: `قبل ما أكمل، هل عندكم أتوبيس للحرم؟`
   - `latestGuestContinuesAfterQuote` now refuses to treat a message as simple continuation when the latest message is actually a hotel fact/service question.

5. Compound service questions could answer bus/location but omit Nusuk.
   - Scenario 38 caught a post-confirmation question asking about bus, Nusuk, and location together.
   - The hotel-fact validation already rejected contradictions for Nusuk; it now also rejects omission when the guest asked about Nusuk and the hotel facts say `isNusuk=true` or provide Nusuk details.

6. QA cleanup needed stronger database safety.
   - During manual cleanup, a custom query used the wrong reservation field name (`supportCaseId`) against Mongoose.
   - Because Mongoose `strictQuery` can strip unknown query fields, the query matched far more than intended on the production-connected Mongo tunnel.
   - This deleted `17657` documents from `hotels.reservations`.
   - Immediate recovery was performed from `/home/ahmedadmin/backups/mongodb/critical/hotels-reservations-20260708-200001.archive.gz` using `mongorestore --gzip --archive=... --nsInclude=hotels.reservations --drop`.
   - Restore result: `17657 document(s) restored successfully`, `0` failed.
   - Verification after restore: reservation count returned to `17657`; support cases with `reservation_confirmed` since `2026-07-09T03:00:00Z` were `0`, so there was no evidence of a real guest reservation lost during the short window.
   - A post-restore backup was created at `/home/ahmedadmin/backups/mongodb/manual-restore/codex-reservations-restore-20260708-2005/hotels-reservations-post-restore.archive.gz`.
   - Future-us rule: never run cleanup/deletion queries using uncertain field names, and never allow Mongoose to strip unknown cleanup fields silently.

Code enhancements:

- `aiagent/core/orchestrator.js`
  - Added payment-at-hotel policy validation:
    - `replyContradictsPayAtHotelPolicy`
    - `replyAffirmsPayAtHotelPolicy`
    - `replyMentionsConfirmedPaymentContext`
    - `replyMentionsPaymentLinkDepositGuidance`
    - `paymentAtHotelReplyNeedsCorrection`
  - Added official-review identity validation:
    - `reviewReplyMissingBookingIdentity`
    - repair reason: `review_identity_missing`
  - Expanded Arabic confirmation-invitation detection so pseudo-review wording routes to official review.
  - Hardened hotel-fact detour handling so a fact question is not misclassified as "continue after quote".
  - Added confirmed-Nusuk omission validation:
    - `replyOmitsConfirmedNusukFact`

- `scripts/chatbotRegressionChecks.js`
  - Added/updated regression coverage for payment-at-hotel, official review identity, Arabic issue-booking handoff, continuation-versus-hotel-fact intent, and compound Nusuk omission.

- `scripts/liveChatbotQa.js`
  - Added live QA scenarios after the original 34 back-and-forth scenarios:
    - Scenario 35: `Live payment-at-arrival wording after confirmed booking is answered yes`
    - Scenario 36: `Bus Nusuk and location detours preserve review on request`
    - Scenario 37: `Initial compound bus Nusuk location answer then booking continues`
    - Scenario 38: `Post-confirmation service facts stay factual and do not reopen booking`
  - Total active back-and-forth live QA scenarios in the script are now `38`.
  - Scenario 36 review-name assertion accepts both Arabic spelling forms `منى كودكس` and `مني كودكس`; this is QA tolerance only, not product logic.

Validation completed before this addendum:

- Static checks passed:
  - `node --check aiagent/core/orchestrator.js`
  - `node --check scripts/chatbotRegressionChecks.js`
  - `node --check scripts/liveChatbotQa.js`
- Regression suite passed locally:
  - `npm run test:chatbot`
  - `89` checks.
- Live QA targeted checks:
  - Scenario 35 passed in the 35-38 run.
  - Scenario 38 passed isolated after the compound Nusuk omission fix.
  - The 35-38 combined run then stopped on scenario 36 because the QA expected only `منى كودكس`, while the brain can naturally render `مني كودكس`; the assertion was corrected to accept both forms.
  - Per the user's instruction to stop broad testing and proceed to documentation/deploy, the full 1-38 live suite was not rerun after this final QA-tolerance change.

Brain-first note:

- These changes are narrow fact/action validators and same-brain repair prompts.
- The customer-facing payment, review, bus, Nusuk, and location language is still generated by the OpenAI brain.
- The server does not introduce a new hard-coded room/adult/child/date/payment interpreter as the main decision maker.
- The server's role is to protect authoritative facts and prevent impossible states:
  - no raw protocol JSON in guest messages;
  - no official review missing booking identity;
  - no confirmed hotel fact being contradicted or omitted;
  - no payment policy contradiction;
  - no reservation submission before the official review checkpoint.

Future-us clues:

- If a guest asks `هل يمكن الدفع عند الوصول` after reservation confirmation, expected answer is yes, with a professional nudge toward the payment link/deposit and reassurance that the confirmed reservation remains valid if the guest does not pay online immediately.
- If the brain says "only payment link" or "I cannot confirm payment at arrival", treat it as a policy contradiction.
- If a guest asks multiple service facts in one message (`bus + Nusuk + location`), the final reply must answer all requested facts, not just one or two.
- If the brain asks the guest to confirm "issuing" or "creating" the booking after all required details are present, the correct next action is official review, not a normal text reply.
- If a QA cleanup script touches reservations, it must use known schema fields, disable strict query stripping, print counts before deletion, and refuse broad deletes.
