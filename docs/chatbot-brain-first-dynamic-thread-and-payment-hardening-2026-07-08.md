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

- `npm run test:chatbot` passed locally and in production with `80` regression checks after the final production hardening patches.
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
- Regression suite count is now `80`.
- Important production markers:
  - `codex-proddeploy-brainfirst-20260708-s10-payment-b`
  - `codex-proddeploy-brainfirst-20260708-s32-fixed`
  - `codex-proddeploy-brainfirst-20260708-s28to34-b`
  - `codex-proddeploy-brainfirst-20260708-s29-no-generic-number-check`
- The next best confidence booster is still one uninterrupted production-connected `1-34` run using a fresh marker, after a quiet traffic window.
