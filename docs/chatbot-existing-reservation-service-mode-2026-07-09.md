# Chatbot Existing Reservation Service Mode - 2026-07-09

## Purpose

This document records the 2026-07-09 hardening pass for already-created reservations, payment reassurance, restricted reception contact handling, and the final follow-up fixes made while protecting the existing 43 live chatbot scenarios.

Read this before changing:

- `aiagent/core/orchestrator.js`
- `aiagent/core/db.js`
- `scripts/chatbotRegressionChecks.js`
- `scripts/liveChatbotQa.js`
- `scripts/liveExistingReservationServiceQa.js`

The core principle remains: the chatbot is brain-first, but the server must protect payment truth, reservation truth, pricing truth, role/contact policy, and tool execution.

## Final Status

Local validation completed:

```bash
npm run test:chatbot
node scripts/liveChatbotQa.js --marker=codex-scenario10-pay-at-hotel-20260709 --scenario=10
node scripts/liveExistingReservationServiceQa.js --marker=codex-existing-paid-reservation-service-8-20260709
node scripts/liveChatbotQa.js --marker=codex-existing-reservation-service-final-10-43-20260709 --from=10 --to=43
node scripts/liveChatbotQa.js --marker=codex-scenario29-split-stay-fix2-20260709 --scenario=29
node scripts/liveChatbotQa.js --marker=codex-final-from29-to43-20260709 --from=29 --to=43
node scripts/liveChatbotQa.js --marker=codex-scenario38-post-confirmation-facts-20260709 --scenario=38
node scripts/liveChatbotQa.js --marker=codex-final-from39-to43-20260709 --from=39 --to=43
node scripts/liveChatbotQa.js --marker=codex-final-from42-to43b-20260709 --from=42 --to=43
```

Results:

- Deterministic chatbot regression suite passed: 108/108.
- Scenario 10 passed after the pay-at-hotel wording guard.
- Existing paid reservation service QA passed.
- Live scenarios 10-28 passed before the later split-stay/date follow-up fixes.
- Scenario 29 passed after split-stay quote idempotency was fixed.
- Live scenarios 29-37 passed in the resumed slice.
- Scenario 38 passed after post-confirmation hotel facts were prioritized over lookup/update tools.
- Live scenarios 39-41 passed in the resumed slice.
- Live scenarios 42-43 passed after brain-first date-boundary fallback was constrained to true follow-up turns.

Do not publish chatbot changes unless the deterministic suite passes and any touched live area is covered by the relevant live slice.

## Behavioral Contract

### Brain First, Server Guarded

The guest message goes to the OpenAI brain as the conversation owner. The brain decides whether to reply, quote, review, submit, look up, update, cancel, close, or hand off.

The server/orchestrator must still:

- Execute quote, review, submit, lookup, and support-contact tools.
- Correct stale or unsafe tool choices.
- Keep exact payment values from the database.
- Keep exact reservation values from the database.
- Prevent invented pending payments, double-payment claims, totals, links, or confirmation numbers.
- Prevent restricted phone leakage.
- Preserve the 43 scenario booking flow.

### Existing Reservation Service Mode

This mode is for guests who already have a reservation or claim they paid a deposit.

It should trigger for messages like:

- "I paid a deposit."
- "I already booked."
- "Can you confirm my payment?"
- "What is my remaining balance?"
- "I want to change/extend my existing reservation."
- A bare 8-12 digit confirmation number after the bot asked for confirmation.

It must not trigger for normal booking intents like:

- "I want to book."
- "I want a room."
- "How much is a double room?"

Normal booking intents must keep using the existing quote/review/create flow.

### Lookup Without Confirmation

If the guest does not provide a confirmation number, ask professionally for either:

- The confirmation number, or
- Exact reservation name plus check-in and checkout dates.

If exact name + dates find one reservation, the bot may answer from that record.

If exact name + dates find more than one reservation, the bot must ask for the confirmation number to avoid returning the wrong guest record.

If nothing is found, the bot must ask for confirmation number or exact details again. It must not invent a reservation.

### Payment Reassurance

For existing reservation payment questions:

- Use DB fields only.
- Say payment is confirmed when captured/paid amount exists.
- Give remaining balance only when asked.
- Give payment link only when asked.
- Never mention pending review or double payment unless the DB shows pending review amount.
- Never tell a guest to accept, cancel, or confirm PayPal pending transactions from guesswork.

The PayPal duplicate/pending incident showed why this matters. PayPal can show a pending review transaction outside the main captured payment path. If that pending amount is not represented in our DB, the chatbot must not claim it as known.

### Contact Number Policy

Public administration WhatsApp:

```text
+1 (909) 222-3374
https://wa.me/19092223374
```

This can be shared with anyone who needs help.

Restricted paid-guest Saudi reception number:

```text
+966541981804
```

This number is only for confirmed paid/deposit guests, and only after the public 909 administration contact was already given or the guest insists on the Saudi reception number.

The bot should not volunteer the Saudi number immediately. First provide the 909 WhatsApp administration contact and explain they can coordinate reception/arrival support.

When the Saudi number is allowed, keep the answer contact-only. Do not mix in totals, confirmation summaries, or unrelated booking data.

### Answer Only What Was Asked

Existing reservation mode should be calm and narrow:

- If the guest asks "Did my deposit arrive?", answer that.
- If the guest asks "How much remains?", answer the balance.
- If the guest asks "Can I extend?", ask for the desired new dates and explain it needs availability/repricing.
- If the guest asks "Where is the bus stop?", answer hotel facts.

Do not reopen the full booking funnel unless the guest asks to book a new stay.

### Hotel Facts After Confirmation

After confirmation, hotel facts must stay hotel facts.

If the guest asks about bus, Nusuk, location, meals, parking, map, or distance after booking:

- Answer from hotel facts.
- Do not run lookup/update just because the guest said "after booking."
- Do not ask again for dates or room details.
- For bus facts at Zad Ajyad, include the confirmed Martyrs/Shuhada stop when asked.

### Separate Date Messages

If the guest gives check-in first, then checkout later in a separate message:

- Do not quote on check-in-only.
- Ask only for checkout.
- When checkout arrives, combine it with the known check-in, room plan, and pricing intent, then quote.

The brain-first fallback now deterministically treats a standalone date as checkout only when the previous state already had check-in or the previous AI explicitly asked for checkout.

## Root Causes Fixed

### 1. Existing Reservation Questions Could Be Routed Like New Bookings

Root cause:

- The original booking brain was optimized for the 43 new-booking scenarios.
- Payment/deposit language could be interpreted as "start/continue a booking" instead of "look up an existing reservation."

Fix:

- Added service-mode detection for existing reservation/payment language.
- Added safe lookup by confirmation and exact name + dates.
- Added deterministic handling for bare confirmation numbers after the AI asks for confirmation.
- Added DB reservation query support in `aiagent/core/db.js`.

### 2. Payment Replies Could Overstate Pending/Double Payment State

Root cause:

- The bot had no reliable way to know PayPal pending-review transactions that were outside captured DB payment state.
- It could infer too much from conversation context.

Fix:

- Payment summaries now distinguish captured/paid, remaining balance, not captured, and DB-visible pending review amount.
- Pending/double language is disallowed unless pending-review amount exists in DB.
- The paid-reservation QA explicitly asserts no pending/double wording when pending review is zero.

### 3. Restricted Saudi Reception Number Needed Policy Enforcement

Root cause:

- Phone-number replies were generic support replies.
- There was no enforced difference between public admin WhatsApp and restricted reception contact.

Fix:

- Added restricted phone leakage guards.
- Added deterministic public-contact fallback.
- Added allowed path only for paid/deposit reservations after 909 contact or explicit insistence.
- Added tests for "no Saudi first" and "Saudi after insist, contact-only."

### 4. Split-Stay Quote Could Repeat Instead Of Advancing

Root cause:

- The split-stay recovery branch re-quoted whenever split periods existed, even when a valid split quote was already saved.

Fix:

- Made split-stay quoting idempotent.
- Quote only when the saved split quote is missing or stale.
- If the split quote already matches, continue to missing details, optional email, review, or submit.

Protected by live scenario 29.

### 5. Post-Confirmation Hotel Facts Could Be Stolen By Lookup/Update

Root cause:

- "After booking, do you have bus/Nusuk/location?" could be interpreted as existing-reservation service/update context.

Fix:

- Hotel-fact-only messages now have priority before reservation lookup/update tooling.
- This is especially important after a reservation is created.

Protected by live scenario 38.

### 6. Brain-First Checkout Follow-Up Could Flake

Root cause:

- In a separate-message checkout flow, the brain sometimes returned `get_quote` without carrying the checkout facts.
- The deterministic parser handled it, but the brain-first route needed a backup.

Fix:

- Added a brain-first date-boundary fallback.
- Constrained it so the first check-in-only message does not become a premature quote.

Protected by live scenario 42 and deterministic checkout-follow-up tests.

## New And Updated Test Coverage

### Deterministic Suite

Run:

```bash
npm run test:chatbot
```

Important checks added or protected:

- Existing reservation lookup reports confirmed payment without inventing pending review.
- Bare confirmation inherits prior deposit question.
- Bare number after reservation-confirmation ask is lookup, not booking phone.
- Existing reservation service mode is not triggered by ordinary booking intent.
- PayPal pending review is separated from confirmed paid amount.
- Existing reservation without confirmation asks safe lookup details only.
- Saudi reception number is gated to paid guests after 909 administration contact.
- Post-confirmation pay-at-hotel questions get a clear confirmation answer.
- Arabic checkout-only follow-up completes separate-message stay.
- Split-stay quote facts remain stable.

### Existing Reservation Live QA

Run:

```bash
node scripts/liveExistingReservationServiceQa.js --marker=codex-existing-paid-reservation-service-8-20260709
```

This creates and cleans up a synthetic paid reservation and tests:

- Guest says they paid deposit without confirmation.
- Bot asks safe lookup details.
- Guest sends confirmation.
- Bot confirms captured payment and remaining balance from DB.
- Bot does not mention pending/double when not in DB.
- Bot does not send payment link unless asked.
- Bot answers contact + bus with public 909 WhatsApp and bus facts.
- Bot withholds Saudi phone until the guest insists.
- Bot gives Saudi phone only in contact-only mode after allowed.

### Live 43 Scenario Protection

Do not rerun from 1 unless needed. Use slices based on touched behavior.

Recorded 2026-07-09 slices:

- 10-28 passed in the resumed suite before split/date follow-up fixes.
- 29 passed isolated after split-stay idempotency.
- 29-37 passed in a resumed slice.
- 38 passed isolated after post-confirmation hotel-fact priority.
- 39-41 passed in a resumed slice.
- 42-43 passed after date-boundary fallback tightening.

Useful commands:

```bash
node scripts/liveChatbotQa.js --marker=<marker> --from=10 --to=43
node scripts/liveChatbotQa.js --marker=<marker> --scenario=29
node scripts/liveChatbotQa.js --marker=<marker> --scenario=38
node scripts/liveChatbotQa.js --marker=<marker> --from=42 --to=43
```

## Future Scenario Guidance

When adding a new scenario, first decide which mode it belongs to:

- New booking mode: quote, review, create reservation.
- Existing reservation service mode: lookup/payment/remaining/change/extend.
- Hotel fact mode: bus, Nusuk, meals, location, parking, policy, support contact.
- Jannat support handoff mode: broad Jannat lead handling across hotels.

Do not solve a new mode by weakening another mode.

Examples:

- A guest asking for a new booking should not be forced into existing-reservation lookup.
- A guest asking about an existing paid reservation should not be asked for full new-booking identity details.
- A guest asking a hotel fact after confirmation should not be asked again for dates.
- A guest asking for 2 double rooms should not be pushed into 1 quad room unless they ask for comparison or the requested setup is unsuitable.

## Rating

After this pass, I would rate the chatbot flow at 9.7/10 for the protected flows:

- New-booking scenarios are still protected by the 43 live scenarios.
- Existing paid-reservation reassurance is now much safer.
- Payment truth is stricter.
- Restricted contact policy is enforced.
- Separate-message dates and split-stay flows have targeted guards.

The remaining 0.3 is operational caution: live LLM behavior can still vary, so future changes must keep the deterministic guards and use focused live slices before production.
