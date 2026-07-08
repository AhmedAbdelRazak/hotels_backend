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
- Falls back to Chat Completions if Responses continuation fails.

### Default Reasoning

- Changed the default `reasoning` effort from `low` to `medium` in `services/openaiModelConfig.js`.
- Kept `analysis`, `nlu`, `writer`, and `default` at `low`.
- Reason: the brain reads better and reasons more cleanly without raising every helper call cost/latency.

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

