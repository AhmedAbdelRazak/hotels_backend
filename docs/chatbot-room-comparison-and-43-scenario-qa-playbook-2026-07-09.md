# Chatbot Room Comparison And 43-Scenario QA Playbook - 2026-07-09

## Purpose

This document records the 2026-07-09 chatbot hardening pass for the Jannat Booking/Zad Ajyad AI support and reservation flow.

The short version:

- The chatbot is brain-first.
- The server preserves truth, pricing, availability, review, and reservation creation.
- The bot must respect the guest's chosen room plan.
- The bot must compare/recommend alternatives only when the guest asks, is unsure, asks for cheaper/better, or the requested setup is unsuitable.
- The current 43 live scenarios are the protected behavior contract. Future work must keep them intact.

This file is intentionally written as a future-us playbook. If a future change touches `aiagent/core/orchestrator.js`, `aiagent/core/nlu.js`, `scripts/chatbotRegressionChecks.js`, or `scripts/liveChatbotQa.js`, read this document before changing behavior.

## Final Status

Production commit:

```text
6690137 Tighten AI booking comparison flow
```

Validation completed before production release:

```bash
node --check aiagent/core/orchestrator.js
npm run test:chatbot
node scripts/liveChatbotQa.js --marker=codex-chatbot-full-20260709k
```

Results:

- Local syntax check passed.
- Local deterministic chatbot regression suite passed: 100/100.
- Full live chatbot QA passed: 43/43.
- Production deterministic chatbot regression suite passed: 100/100.
- Production live scenario 42 passed: separate checkout follow-up.
- Production live scenario 43 passed: Arabic room comparison, typed double-room choice, final reservation created with exactly two double rooms.
- QA residue check passed: 0 test support cases and 0 test reservations left behind.

Production health after deploy:

```text
/api/aiagent/health -> ok: true
OpenAI model: gpt-5.4-mini
Reasoning effort: medium
PM2 app: hotels-backend online
```

## Behavioral Contract

### Brain First

The guest sends a message, then the OpenAI brain receives the conversation state and decides the next action.

The server/orchestrator must not replace the brain as the conversation owner. Its job is to:

- Give the brain the hotel facts, room facts, service facts, known booking state, latest message hints, and conversation memory.
- Execute tools the brain asks for, especially quote, review, submit reservation, lookup, and handoff.
- Protect correctness when the brain is vague, incomplete, or drifts from known facts.
- Prevent fake prices, fake confirmation numbers, stale dates, stale room choices, and invalid room capacities.

### Respect The Guest's Explicit Room Plan

If the guest clearly asks for a room setup, keep that setup.

Examples:

- Guest asks for 2 double rooms: quote and continue with 2 double rooms.
- Guest asks for 1 quad room: quote and continue with 1 quad room.
- Guest asks for 3 family rooms: preserve 3 family rooms unless availability or capacity makes it impossible.

Do not suggest or compare another room type just because it might be cheaper.

### Compare Only On Demand

The bot may compare room options only when the guest explicitly asks or signals uncertainty.

Allowed comparison triggers:

- "Which is better?"
- "Which is cheaper?"
- "Give me both prices."
- "We are 4 guests, should we take 2 double rooms or 1 quad room?"
- "I am confused between these options."
- A requested setup is unsuitable, such as 5 people in one double room.

Not allowed:

- Guest asks for 2 double rooms and the bot pushes a quad room.
- Guest asks for a quote and the bot recommends multiple room types without being asked.
- Guest asks to complete a reservation and the bot reopens a comparison.

### Professional Sales Tone

When comparison is requested, sell both options honestly:

- 2 double rooms are usually more comfortable and easier for privacy/space.
- 1 quad room usually saves money for the same date range when available.
- Let the guest choose, then continue the reservation with the chosen option.

Never force the change. Never hide the tradeoff.

### Exact Prices Only From The Quote Tool

The brain can ask for a quote, but exact money must come from the server quote tool.

Guest-facing quote replies must:

- Use the actual quote dates.
- Use the actual room selection.
- Use the actual total, currency, and discount markup from the tool.
- Avoid invented deposits, fake payment rules, or made-up totals.

### No Premature Identity Collection

Do not ask for name, phone, nationality, or email before an exact quote is shown, unless the guest explicitly wants a human handoff or provides identity details voluntarily.

The normal booking path is:

1. Understand stay dates and room plan.
2. Quote exact price.
3. Ask if the guest wants to continue.
4. Collect required details.
5. Send official review.
6. Create reservation only after the guest confirms the review.

### Guest Name And Addressing

The bot should address the chat guest naturally when the name is known from the support case or conversation.

Important distinction:

- `clientName` or the chat display name can be the person being addressed.
- Booking holder `fullName` can be different.
- Review messages must not accidentally address the booking holder if the chat guest is different.

Protected by live scenario 28 and deterministic guest-address checks.

### Hotel Facts And Booking Checkpoints

If the guest asks a hotel fact while in a booking flow, answer the fact and preserve the booking checkpoint.

Examples:

- Distance to Haram.
- Bus/shuttle/Nusuk.
- Meals/room-only policy.
- Payment at hotel.
- Support contact.

After answering, continue naturally from the latest booking state instead of forgetting the quote or asking irrelevant questions.

### Split Stays Are Real Separate Reservations

If the guest asks for two separate reservations or two separate date periods in one chat:

- Quote each period separately.
- Keep them separate in memory.
- Do not merge periods into one stay.
- On submit, create separate reservation records.

Protected by live scenario 29.

## Root Causes Fixed

### 1. Separate Check-In And Checkout Messages Could Stall Or Repeat

Observed weakness:

- Guest asked for a room price.
- Bot asked for date details.
- Guest sent check-in date.
- Later, guest sent checkout date in a separate message.
- The bot could become redundant or ask for unnecessary extra details instead of quoting.

Root cause:

- The follow-up checkout-only turn was not always strong enough to merge with previous check-in, room type, and pricing intent.
- The brain could acknowledge dates but not route to quote.
- The orchestrator needed a guard that a date acknowledgement after a pricing context means quote, not another generic question.

Fix:

- Added deterministic parsing/regression coverage for separate checkout follow-up.
- Hardened brain/orchestrator behavior so acknowledged complete dates after a price request trigger `get_quote`.
- Added live scenario 42: `Arabic separate checkout follow-up quotes after bot asks`.

Important invariant:

- Check-in-only should not quote prematurely.
- Checkout follow-up should quote when the earlier check-in, room type, and party facts are known.

### 2. The Bot Asked Guest Count When It Was Not Needed For Simple Pricing

Observed weakness:

- Guest asked for double room pricing and then provided dates.
- Bot asked "كم عدد الضيوف: كم بالغ وكم طفل؟"
- For basic room-type pricing, this created unnecessary friction.

Root cause:

- The prompt/tool contract overvalued guest count as required for all pricing turns.
- For a specific room type and room count, the quote can be produced without asking adult/child breakdown unless capacity, party composition, or suitability matters.

Fix:

- The brain contract now allows quote-first behavior when room type and dates are known.
- Added deterministic check: `Brain acknowledged dates after price context are enough to quote`.
- Added deterministic check: `Brain acknowledged checkin-only text cannot trigger premature quote`.
- Added live scenario 43 coverage for the Ahmed flow.

Important invariant:

- Ask guest count only when it matters for capacity, suitability, party split, or the guest asks for a party-based recommendation.

### 3. Room Comparison Was Not Giving Both Prices

Observed weakness:

- Guest asked whether 2 double rooms or 1 quad room would be better.
- Bot replied with text about options but did not produce a real pricing overview.
- Guest had to repeat "both" and still did not receive both prices.

Root cause:

- The brain understood alternatives conversationally but did not consistently turn same-date alternatives into multiple quote-tool calls.
- The server did not yet have a strong same-date room-comparison path that prepared comparable quote options and quick replies.

Fix:

- Added same-date room comparison extraction.
- Added `handleBrainRoomComparisonQuote`.
- Both options are quoted through the normal quote tool.
- The reply includes a pricing overview plus quick replies.
- Quick replies use `action: select_room_option`.
- The same logic also works when the guest types their choice instead of clicking.

Protected by:

- Deterministic check: `On-demand Arabic room comparison splits alternatives for pricing`.
- Deterministic check: `Same-date room comparison accepts quick-reply and typed room choices`.
- Live scenario 43.

### 4. The Unchosen Room Option Could Leak Into Review Or Submit

Observed weakness:

- After a comparison, the guest chose 2 double rooms.
- The old/alternate quad option could remain in known facts and leak back into review or submit.

Root cause:

- Comparison options lived in memory as active alternatives.
- The chosen option was not locked as the one truth for the final reservation.
- The brain could still see both options and drift back to the unchosen one.

Fix:

- Added selected comparison option lock:
  - `sameDateRoomSelectionLocked`
  - `sameDateRoomSelectedOption`
- Added selected-option merge helpers:
  - `sameDateRoomChoiceFromText`
  - `mergeSameDateRoomChoiceIntoKnown`
  - `applySelectedSameDateRoomOptionLock`
  - `clearSelectedSameDateRoomOptionLock`
- `compactKnownFactsForPrompt` now hides `sameDateRoomOptions` when a choice is locked.
- Review and submit paths reapply the selected option before writing reservation data.

Protected by:

- Deterministic check: `Selected same-date room option locks the final reservation room mix`.
- Live scenario 43 final reservation assertion:
  - `total_rooms === 2`
  - picked rooms include `doubleRooms`
  - picked rooms do not include `quadRooms`

Important invariant:

- After the guest chooses one comparison option, all downstream paths must treat that option as the active room plan.

### 5. The Brain Could Recommend Too Aggressively

Observed risk:

- The bot is a salesperson, but it must not change a guest's mind when the guest already knows what they want.

Root cause:

- Helpful sales prompts can easily over-recommend when the distinction between "sell" and "suggest alternatives" is not explicit.

Fix:

- Updated the brain contract:
  - Respect clear room requests.
  - Compare only when asked or when the setup is unsuitable.
  - If the requested setup cannot fit, explain professionally and suggest a suitable active room plan.
  - Exact quote still comes only after server quote.

Important invariant:

- Sales tone means confidence, clarity, and conversion help.
- Sales tone does not mean unsolicited alternatives.

### 6. Hotel Fact Replies Could Miss The Booking Bridge

Observed weakness:

- A hotel fact answer could be correct but fail to guide the guest back to booking.

Root cause:

- The reply validator allowed weak bridge suffixes that were too generic or missing concrete booking next steps.

Fix:

- Hardened `hotelFactReplyHasConcreteBookingBridge`.
- Fact replies now need a concrete bridge when a booking checkpoint exists.

Protected by:

- Deterministic hotel fact checkpoint checks.
- Live scenarios 1, 13, 21, 34, 36, 37, 38.

### 7. Split-Stay Live QA Could Fail On A Bad Test Date, Not Bad Product Behavior

Observed failure:

- Full live QA scenario 29 failed because the second split period selected by the fixture had no inventory.

Root cause:

- The test derived the second period from the first available stay without preflighting that second period.
- Live inventory changes over time, so this was a fixture weakness.

Fix:

- Added `findAvailableSplitStay`.
- Scenario 29 now preflights both split periods through the same quote tool used by production.

Important invariant:

- Live QA must test product behavior, not accidentally depend on unavailable fixture dates.

### 8. Test Cleanup Needed Strict Query Protection

Observed risk:

- Mongoose `strictQuery` can strip unknown query paths. In cleanup code, that can turn a targeted delete into a broader query if the schema rejects a path.

Fix:

- Added schema-level `strictQuery: false` protection for the support case and reservation models used by QA cleanup.
- Live QA cleanup still uses exact case ids and tracked reservation ids, not broad deletes.

Important invariant:

- Never use broad production deletes for QA cleanup.
- Use marker-scoped support cases and tracked reservation ids.
- Always verify residue after live QA.

## Files And Responsibilities

### `aiagent/core/orchestrator.js`

Primary brain/tool coordinator.

Responsibilities:

- Build the brain prompt and known-facts package.
- Route brain decisions.
- Execute quote, review, submit, comparison, hotel fact, and handoff actions.
- Apply safety guards around prices, dates, rooms, review, confirmation, and hotel facts.
- Preserve selected room option locks across review/submit.

Important functions and concepts:

- `roomPriceComparisonOptionsFromText`
- `handleBrainRoomComparisonQuote`
- `sameDateRoomChoiceFromText`
- `mergeSameDateRoomChoiceIntoKnown`
- `applySelectedSameDateRoomOptionLock`
- `clearSelectedSameDateRoomOptionLock`
- `compactKnownFactsForPrompt`
- `hotelFactReplyHasConcreteBookingBridge`

### `aiagent/core/nlu.js`

Deterministic extraction support.

Responsibilities:

- Parse multilingual dates and room signals.
- Support separate-message date flows.
- Avoid treating child ages, room names, or date-like numbers as the wrong facts.

### `scripts/chatbotRegressionChecks.js`

Fast deterministic protection.

Run it before commit and after server pull:

```bash
npm run test:chatbot
```

Use it for:

- Parser behavior.
- Prompt contract invariants.
- Tool reply validators.
- Memory merging.
- Selected room option lock.
- Guest/address/review safety.
- Quote/review/submit guardrails.

### `scripts/liveChatbotQa.js`

End-to-end live behavior protection.

Run full suite:

```bash
node scripts/liveChatbotQa.js --marker=codex-chatbot-full-YYYYMMDDx
```

Run focused scenario by number:

```bash
node scripts/liveChatbotQa.js --scenario=43 --marker=codex-chatbot-s43-YYYYMMDDx
```

Run focused scenario by name:

```bash
node scripts/liveChatbotQa.js --scenario="Two separate reservations" --marker=codex-chatbot-s29-YYYYMMDDx
```

Important:

- `--fast` is useful for smoke tests only.
- Do not use `--fast` as the final approval gate for reservation-creation scenarios because final brain/tool replies may need normal timing.
- Final production gate should use normal live timing for critical scenarios.

### `models/supportcase.js` And `models/reservations.js`

QA cleanup safety.

The schema-level `strictQuery: false` setting exists so marker/id-scoped cleanup queries do not silently lose fields. Do not remove it without replacing the cleanup strategy and rerunning live residue checks.

## The Current 43 Live Scenarios

These are the protected live scenarios as of 2026-07-09. Keep their names stable unless there is a strong reason to rename them.

1. Arabic distance answer with sales bridge
2. Arabic bus answer human, not source label
3. Meals question says room-only and nearby restaurants
4. Simple Arabic quote shows discount markup
5. Budget objection stays concise and sells direct discount
6. Quote then proceed asks only missing booking details
7. Combined name phone nationality moves to review
8. Optional email skip reaches official review
9. Final review confirmation creates reservation
10. After confirmation, pay at hotel is answered yes
11. Support contact number is provided when asked
12. Eight guests uses real room combination, not imaginary 8-bed room
13. Hotel fact after quote restores booking checkpoint
14. Burst messages are processed in one turn after quiet wait
15. French booking quote
16. Date correction triggers fresh quote with corrected date
17. Same-day check-in is blocked cleanly
18. Unavailable large-room request gives alternatives, no fake progress
19. Hotel unavailable can hand back to Jannat Booking without Ajyad loop
20. Jannat Booking recommends priority Ajyad with sales framing
21. Booking process question preserves known quote
22. Confirmation number request before booking does not invent one
23. Thanks after help closes warmly without repeating facts
24. Ambiguous 03 triple room request becomes one triple for 3 guests
25. Relationship wording captures adults/children naturally
26. Required-details confusion is explained simply
27. Shaimaa-style full flow stays human, creates booking, answers pay and contact
28. Initial chat name remains address source when booking holder differs
29. Two separate reservations in one chat stay separated
30. Long Arabic quote stays plain customer text
31. Child age phrase does not become seven children
32. Three-room quote survives capacity wording
33. Quote is shown before identity details
34. Compound hotel facts stay consistent
35. Live payment-at-arrival wording after confirmed booking is answered yes
36. Bus Nusuk and location detours preserve review on request
37. Initial compound bus Nusuk location answer then booking continues
38. Post-confirmation service facts stay factual and do not reopen booking
39. Arabic Levant month checkout day-only quote
40. Arabic slash range with extra booking facts quotes
41. Arabic burst slash messages wait and quote all facts
42. Arabic separate checkout follow-up quotes after bot asks
43. Arabic Ahmed price follow-up and on-demand room comparison

## Scenario Groups

### Hotel Facts And Service Questions

Protected by scenarios 1, 2, 3, 11, 13, 21, 34, 36, 37, 38.

Rules:

- Answer facts naturally from the hotel fact pack.
- Avoid source-label phrases like "stored details" or "according to hotel data".
- Preserve booking checkpoint when the guest asks a detour question.
- After confirmation, service facts must not reopen the booking flow.

### Quote And Pricing Correctness

Protected by scenarios 4, 5, 15, 16, 18, 30, 33, 39, 40, 41, 42, 43.

Rules:

- Quote exact server-tool prices only.
- Show direct-booking discount markup.
- Show or mention the correct date range.
- Do not ask identity before quote.
- Do not invent money amounts.
- Do not quote with missing checkout.

### Reservation Completion

Protected by scenarios 6, 7, 8, 9, 10, 27, 28, 29, 35, 36, 38, 43.

Rules:

- Ask only missing required details after quote.
- Persist optional email skip.
- Send official review before creating a reservation.
- Create reservation only after review confirmation.
- Preserve selected room counts and guest counts.
- Keep split stays as separate records.

### Dates, Follow-Ups, And Corrections

Protected by scenarios 14, 16, 17, 39, 40, 41, 42.

Rules:

- Burst messages must be processed as one coherent turn after quiet wait.
- Separate check-in/checkout messages must merge correctly.
- Checkout-only follow-up should complete the earlier stay.
- Same-day check-in should be blocked.
- Date correction after quote requires a fresh quote.

### Room Planning And Capacity

Protected by scenarios 12, 18, 24, 25, 31, 32, 43.

Rules:

- Do not rely on unreliable raw `bedsCount` for Zad Ajyad capacity.
- Use canonical room type capacity:
  - `doubleRooms` = 2
  - `tripleRooms` = 3
  - `quadRooms` = 4
  - `familyRooms` = 5
- Do not invent 8-bed rooms.
- Do not reduce explicit multi-room requests unless the guest corrects them or suitability requires replanning.

### Room Comparison

Protected by scenario 43 and deterministic checks 12 through 14 in the current regression suite.

Rules:

- Compare only on demand.
- Quote both options with the same date range.
- Provide quick replies for each option.
- Accept both clicked quick replies and typed selections.
- Lock the selected option.
- Do not leak the unchosen option into review or submit.

## Deterministic Regression Suite Themes

The fast suite currently has 100 checks. Do not think of it as "unit tests only"; it is the safety net for prompt contracts and data integrity.

Major themes:

- Brain reasoning effort cannot be demoted below medium.
- Protocol JSON cannot leak to the guest.
- Arabic/French/Turkish parsing remains stable.
- Separate checkout follow-up works.
- Guest count and child-age parsing do not corrupt each other.
- Room plans are capacity-safe and do not invent room types.
- Hotel fact detours restore quote/review checkpoints.
- Confirmed bus/Nusuk/payment facts stay factual.
- Direct booking discount markup is required.
- Quote replies must match tool dates and tool money.
- Official review must not create a reservation prematurely.
- Guest addressing respects chat guest vs booking holder.
- Optional email skip is persisted.
- Split-stay periods survive identity collection.
- Submit restores reviewed facts before reservation creation.
- Jannat support handoff and recommendation behavior remains stable.
- Room comparison supports quick reply and typed selection.
- Selected comparison option locks final reservation room mix.

## How To Add A New Scenario Safely

### Step 1: Decide The Test Layer

Add a deterministic check when the behavior can be verified without live OpenAI/database state:

```bash
scripts/chatbotRegressionChecks.js
```

Add a live scenario when behavior depends on:

- OpenAI brain decisions.
- Conversation memory over multiple turns.
- Quote tool with real inventory.
- Review/submit behavior.
- Reservation rows.
- Production-like timing.

```bash
scripts/liveChatbotQa.js
```

Often the best protection is both:

- Deterministic test for the parser/guard/merge invariant.
- Live scenario for the end-to-end guest journey.

### Step 2: Use Real Inventory Helpers

Do not hard-code future dates unless the scenario is specifically about an unavailable or same-day date.

Prefer helpers:

- `findAvailableStay`
- `findAvailableComparisonStay`
- `findAvailableSplitStay`

If a new scenario needs two room options on the same date, preflight both options. If it needs split stays, preflight both periods. Live QA should fail only for product behavior, not because a test date lost inventory.

### Step 3: Give The Scenario A Stable Name

Use a name that explains the behavior:

```js
name: "Arabic separate checkout follow-up quotes after bot asks"
```

Avoid generic names like:

```js
name: "Test new chatbot fix"
```

### Step 4: Assert The Guest-Facing Outcome

Every quote scenario should assert at least:

- Discount markup appears when available.
- Date range is correct.
- Room type/count is correct.
- No premature identity request.
- No protocol JSON leak.

Every reservation scenario should assert:

- Official review appears before submit.
- Confirmation appears only after submit.
- Reservation row exists after submit.
- Room selections in the row match the final reviewed selection.
- Cleanup deletes the test reservation.

Every comparison scenario should assert:

- At least two priced options.
- Same date range across options.
- Quick replies exist and use `select_room_option`.
- Typed selection is understood.
- Review excludes unchosen option.
- Reservation row excludes unchosen option.

### Step 5: Run Focused, Then Full

For a new deterministic check:

```bash
npm run test:chatbot
```

For a new live scenario:

```bash
node scripts/liveChatbotQa.js --scenario=NEW_NUMBER --marker=codex-chatbot-sNEW-YYYYMMDDa
```

Then run the full live suite:

```bash
node scripts/liveChatbotQa.js --marker=codex-chatbot-full-YYYYMMDDa
```

Do not call the work done until the focused scenario and full suite both pass.

### Step 6: Verify Cleanup

After live QA:

```js
const caseCount = await SupportCase.countDocuments({ caseSummary: /^codex-chatbot-/ });
const reservationCount = await Reservations.countDocuments({
  $or: [
    { customer_details: /codex-chatbot-/i },
    { seenByAdmin: /codex-chatbot-/i },
    { reservation_status: /codex-chatbot-/i }
  ]
});
```

Expected:

```json
{"caseCount":0,"reservationCount":0}
```

If cleanup fails, stop and inspect the exact marker and ids. Do not run broad delete commands.

## Common Future Changes And Required Tests

### Changing The Brain Prompt

Required:

```bash
npm run test:chatbot
node scripts/liveChatbotQa.js --marker=codex-chatbot-full-YYYYMMDDa
```

Also run focused scenarios based on touched behavior:

- Hotel facts: scenarios 1, 13, 34, 36, 38.
- Date parsing: scenarios 16, 39, 40, 41, 42.
- Reservation review/submit: scenarios 8, 9, 27, 29, 43.
- Room comparison: scenario 43.

### Changing Room Parsing

Required:

- Deterministic room/guest/date checks.
- Live scenarios 12, 18, 24, 25, 31, 32, 43.

Watch for:

- Date numbers becoming room counts.
- Child ages becoming child counts.
- "3 triple room" becoming 3 rooms instead of one triple for 3 guests.
- Explicit multi-room selections being silently reduced.

### Changing Quote Formatting

Required:

- Discount markup checks.
- Tool date checks.
- Money amount validation checks.
- Live scenarios 4, 5, 15, 30, 39, 40, 41, 42, 43.

Watch for:

- Fake old/new prices.
- Missing green final price.
- Wrong date range.
- Asking identity before showing quote.

### Changing Reservation Submit

Required:

- Review-before-submit checks.
- Reservation row assertions.
- Live scenarios 9, 27, 29, 35, 36, 38, 43.

Watch for:

- Creating before review confirmation.
- Losing optional email skip.
- Losing selected room option lock.
- Merging split stays.
- Changing guest count between review and submit.

### Changing Cleanup

Required:

- Run a focused live scenario with reservation creation.
- Verify residue is zero.
- Inspect deletion filters manually.

Never use a broad cleanup query without exact marker/case/reservation constraints.

## Future Scenarios Worth Adding

These are not blockers for the 2026-07-09 release, but they are good next additions.

1. Live quick-reply button path for room comparison
   - Current live scenario 43 covers typed choice.
   - Deterministic checks cover quick reply.
   - A future live scenario can simulate `clientAction: select_room_option` directly.

2. Unsuitable explicit request
   - Example: 5 guests ask for one double room.
   - Expected: explain professionally that double is not suitable and offer an active suitable room plan with exact quote after tool call.

3. No-unsolicited-comparison live scenario
   - Guest asks directly for 2 double rooms.
   - Expected: bot quotes 2 double rooms only and does not mention quad/family unless unavailable.

4. English and French same-date comparison
   - Same behavior as Arabic scenario 43, but in English/French.

5. Comparison with one unavailable option
   - Guest asks for 2 options.
   - One option is unavailable.
   - Expected: clearly say which option is available/unavailable, offer the available option, do not fake both prices.

6. Guest changes mind after selection lock
   - Guest chooses 2 double rooms, then says "Actually make it quad."
   - Expected: clear the old lock, quote the new requested option, and review only the new option.

7. Detour after comparison before selection
   - Guest asks comparison, then asks about bus, then chooses one option.
   - Expected: answer bus, preserve comparison options, accept choice.

8. Detour after selection lock
   - Guest chooses one option, asks about payment/location, then continues.
   - Expected: answer fact and preserve locked chosen option.

9. Staff/human message in thread
   - Human staff message should be context, not guest intent.
   - The bot must not parse staff text as a new guest booking change.

10. Two reservations with different room types
   - Example: one double for first period, one quad for second period.
   - Expected: separate quote/review/submit records.

## Deployment Checklist

Local:

```bash
git status -sb
node --check aiagent/core/orchestrator.js
npm run test:chatbot
node scripts/liveChatbotQa.js --marker=codex-chatbot-full-YYYYMMDDa
git add aiagent/core/nlu.js aiagent/core/orchestrator.js models/reservations.js models/supportcase.js scripts/chatbotRegressionChecks.js scripts/liveChatbotQa.js docs/...
git commit -m "Tighten chatbot behavior"
git push origin master
```

Production:

```bash
ssh jannat
cd ~/Hotels/hotels_backend
git status -sb
git pull --ff-only origin master
node --check aiagent/core/orchestrator.js
npm run test:chatbot
pm2 restart hotels-backend --update-env
curl -sS http://127.0.0.1:8080/api/aiagent/health
pm2 status hotels-backend --no-color
```

Production smoke:

```bash
node scripts/liveChatbotQa.js --scenario=42 --marker=codex-chatbot-prod-s42-YYYYMMDDa
node scripts/liveChatbotQa.js --scenario=43 --marker=codex-chatbot-prod-s43-YYYYMMDDa
```

Residue check:

```bash
# Expected result after live QA cleanup:
# {"caseCount":0,"reservationCount":0}
```

## Red Flags

Stop and investigate if any of these happen:

- The bot asks for guest count before a simple room/date quote.
- The bot recommends an alternative when the guest already picked a suitable room plan.
- A comparison reply does not show both prices.
- A selected comparison option leaks the unchosen option into review.
- A reservation row contains a room type that was not selected.
- The bot creates a reservation before official review confirmation.
- A hotel fact question makes the bot forget the quote/review checkpoint.
- A same-day check-in gets quoted.
- `--fast` passes but normal live timing fails, or vice versa. Use normal timing as the release gate.
- QA cleanup leaves support cases or reservations behind.

## The Quality Bar

The chatbot is not just answering questions. It is guiding a guest toward a correct reservation.

The quality bar is:

- Warm and professional.
- Brain-first and context-aware.
- Exact with prices, dates, room counts, and confirmation numbers.
- Sales-minded without being pushy.
- Flexible with language and message order.
- Strict about not damaging reservation data.
- Fully tested before production.

The 2026-07-09 work moved the system from "very good" to "production-grade with a strong safety net." Future changes should raise the bar from here, not reopen solved failure modes.
