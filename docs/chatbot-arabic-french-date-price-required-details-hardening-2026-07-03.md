# Chatbot Arabic/French Date, Price, and Required-Details Hardening

Date: 2026-07-03

This document records the chatbot hardening work done after reviewing the real
Jannat Booking/Zad Ajyad support cases shared on 2026-07-03.

The main goal was to fix the Arabic date/price failure without damaging the
current chatbot structure. The secondary goal was to make required booking
details present better in the existing support widget UI.

The most important rule from this pass:

OpenAI remains the brain. The backend orchestrator should preserve known facts,
route obvious tool turns, and prevent stale or destructive memory changes from
overwriting a better guest-derived state.

## Final Outcome Summary

Final deployed backend commit:

- `4ffb298` - `Harden chatbot date price recovery`

Final production state after deployment:

- GitHub `master` contains the patch.
- Production backend `/home/ahmedadmin/Hotels/hotels_backend` is on `4ffb298`.
- `hotels-backend` was restarted through PM2 after the pull.
- `jannatbooking_ssr` was not changed and was not restarted.
- Public AI health returned HTTP `200` after deployment.
- `https://jannatbooking.com` returned HTTP `200` after deployment.
- PM2 showed `hotels-backend` online after restart.
- Backend logs after restart showed:
  - `[aiagent] slim OpenAI-led orchestrator active.`
  - `[aiagent] initialized.`
  - `[socket] DB watcher broadcasting conversation updates enabled.`
  - `Server is running on port 8080`
  - `MongoDB Atlas is connected`

Final local validation:

- `node --check aiagent\core\orchestrator.js`
- `node --check aiagent\core\nlu.js`
- `git diff --check`
- Focused local regression harness: `PASS 35 chatbot regression checks`

Final sync check:

- Local backend: `4ffb298`, clean working tree.
- Production backend tracked tree: `4ffb298`, in sync with `origin/master`.
- Local SSR: `2f5d1f1`, clean working tree.
- Production SSR tracked tree: `2f5d1f1`, in sync with `origin/main`.

## Current Deployment State

Backend repository:

- Local path: `D:\JannatBooking\hotels_backend`
- Production path: `/home/ahmedadmin/Hotels/hotels_backend`
- GitHub branch: `master`
- Production PM2 app: `hotels-backend`
- Production deployed commit after this pass: `4ffb298`
- Files changed locally in this pass:
  - `aiagent/core/orchestrator.js`
  - `aiagent/core/nlu.js`
  - `docs/chatbot-arabic-french-date-price-required-details-hardening-2026-07-03.md`

Frontend repository:

- Local path: `D:\JannatBooking\jannatbooking_ssr`
- Production path: `/home/ahmedadmin/Hotels/jannatbooking_ssr`
- Production PM2 app: `jannat-ssr`
- No frontend code changed in this pass.

Important deployment note:

- The production backend was originally observed at `9a37fa3` during the
  read-only pre-deploy check.
- It was then fast-forwarded to `4ffb298`.
- The production SSR stayed at `2f5d1f1` because this patch did not require any
  frontend change.

## Production Health Check Before Deploy

Read-only production checks were run from the local machine and over the `jannat`
SSH alias.

Public HTTP checks:

- `https://xhotelpro.com/api/aiagent/health` returned HTTP `200`.
- Health payload reported:
  - `ok: true`
  - `openai: true`
  - `model: gpt-5.4-mini`
  - `reasoningEffort: low`
- `https://jannatbooking.com` returned HTTP `200`.
- `https://xhotelpro.com` returned HTTP `200`.

PM2 status on production at `2026-07-03 13:16 UTC`:

- `hotels-backend`: online, uptime about `6h`, restarts `0`, memory about `301 MB`.
- `jannat-ssr`: online, uptime about `6h`, restarts `0`, memory about `78 MB`.
- `zad-ssr`: online.
- `hotels-frontend`: online.
- Other apps were also online.

Recent backend PM2 log tail:

- Recent `hotels-backend` entries were normal HTTP `200`/`304` traffic.
- Recent `/api/aiagent/health` checks returned `200`.
- No new backend crash was seen in the tail checked during this pass.

Recent SSR PM2 log tail:

- `jannat-ssr` was online.
- Error tail still showed two image warnings:
  - `/assets/janat/1755216831611.jpg`
  - `/assets/janat/1755216844209.jpg`
- These were not caused by this backend chatbot patch.

Production working tree note:

- `/home/ahmedadmin/Hotels/hotels_backend` had many pre-existing untracked
  `.env.backup-*` and `.bak-*` files.
- The tracked production backend tree was not showing modified tracked files.
- Do not delete the backup files casually during deployment.

## Runtime Architecture Map For Future Work

The chatbot structure around this patch has four important layers.

### 1. Public Support Widget

Main frontend area:

- `jannatbooking_ssr/components/SupportWidget.js`

Ownership:

- Displays public chat messages.
- Renders markdown-style `**bold**` text used by the required-details rows.
- Shows quick replies/buttons returned by the backend.
- Should not own booking memory, pricing logic, date parsing, or room selection
  recovery.

Important UI contract:

- The backend can safely send plain text with line breaks.
- The backend can safely send bullet rows such as:
  - `- **Full Name:** Needed`
  - `- **Phone:** Needed`
- This pass intentionally did not introduce a new structured frontend data
  contract because the widget already renders the needed formatting.

Future caution:

- If a future patch introduces real structured required-field payloads, keep the
  current text fallback until all deployed widgets understand the new shape.

### 2. Backend Socket/API Entrypoints

Main backend area:

- `server.js`
- `controllers/supportcase.js`
- `routes/supportcase.js`
- `services/supportCaseMaintenance.js`

Ownership:

- Accepts support-case messages.
- Emits socket updates.
- Schedules AI turns.
- Maintains AI idle/recovery behavior.
- Keeps public/client endpoints separate from admin endpoints.

Future caution:

- Do not move conversational interpretation into `server.js`.
- Do not make support-case socket handlers parse booking meaning directly.
- Keep AI turn scheduling separate from fact recovery and quote execution.

### 3. Orchestrator / Memory / Guards

Main backend file:

- `aiagent/core/orchestrator.js`

Ownership:

- Rebuilds `known` facts from:
  - `SupportCase.aiStateSnapshot.known`
  - support-case `conversation`
  - assistant quote/review messages
  - guest messages
- Runs deterministic guards before and after the brain-first path.
- Chooses when a tool action must run before a free-form reply.
- Protects the guest from stale assistant memory and bad generic replies.

Important principle:

- The orchestrator is not the writer.
- The orchestrator may send action-owned system messages such as quote/review
  fallbacks and required-details rows.
- Normal conversational wording should still come from the brain unless a guard
  must prevent a bad or unsafe reply.

### 4. NLU / Room / Date / Quote Helpers

Main files:

- `aiagent/core/nlu.js`
- `aiagent/core/actions.js`
- `aiagent/core/db.js`

Ownership:

- `nlu.js` maps quick room/date/amenity signals and falls back to LLM intent
  classification when needed.
- `actions.js` owns quote/reservation actions and must remain the source of
  price/availability truth.
- `db.js` loads support cases, hotels, previous chats, and safe compact data.

Important principle:

- Price must come from quote/action helpers, not from brain prose.
- Room/date extraction can be deterministic when clear, but should not guess
  beyond what the guest or trusted tool result supports.

## Support Case Fields To Respect

The support-case document is the durable source of conversation history. Future
chatbot changes should respect these fields:

- `conversation`
  - Ordered chat transcript.
  - Each entry may be guest, AI/support, or system.
  - Recovery must read this defensively because old cases may have partial,
    stale, or malformed entries.
- `aiStateSnapshot.known`
  - Compact saved memory for the current support case.
  - Should be treated as useful but not infallible.
  - Conversation recovery exists because this snapshot can be thin after worker
    fallback, restart, or older code paths.
- `aiToRespond`
  - AI may respond only when this is true and policy allows it.
- `caseStatus`
  - Closed cases should not be mutated by QA unless explicitly intended.
- `aiResponderName`
  - Controls assistant display identity.
  - Should not drive parsing logic.
- `supportScope`
  - Distinguishes hotel reception scope from Jannat platform support scope.
  - Do not let hotel-specific booking logic accidentally run before Jannat
    platform handoff is complete.
- `clientAction`
  - Important for quick replies and deterministic continuation.
  - Must remain stable where frontend buttons depend on it.
- `quickReplies`
  - Guest-facing choices.
  - Keep them language-appropriate and aligned with the current action.

Field safety rule:

- Do not add new required support-case fields for chatbot behavior unless there
  is a migration/backfill plan and the old message text fallback still works.

## Fact Priority Rules

When future work touches memory recovery, use this priority order:

1. Explicit latest guest message.
2. Fresh tool result or quote/review action.
3. Existing valid saved `aiStateSnapshot.known`.
4. Clear earlier guest messages in the same case.
5. Assistant acknowledgements anchored by valid facts.
6. Brain prose without structured facts.

Practical rules:

- A complete valid guest-derived date range should not be overwritten by one
  assistant date echo.
- An assistant acknowledgement can restore missing state, but should not replace
  stronger current state.
- A quote that no longer matches current dates/room selections must be dropped
  or refreshed.
- A room type from assistant prose should not overwrite a conflicting current
  room type unless there is a new guest selection or a tool result.
- Guest corrections sent quickly after each other should be accepted when they
  answer the same outstanding question.

## No-Hardcoding Policy From This Pass

The production fixes are intentionally dynamic.

Not allowed in chatbot logic:

- Support case IDs.
- Guest names.
- AI responder names.
- Hotel names.
- Fixed real guest dates.
- Fixed real quote prices.
- Fixed nationality or room outcome tied to one transcript.

Allowed:

- Generic language terms such as `الحساب`, `المبلغ`, `personnes adultes`.
- Generic context rules such as "Arabic-script slash date prefers day/month".
- Generic confidence anchors such as "assistant message contains two valid ISO
  dates in chronological order".
- Generic UI labels such as `Full Name`, `Phone`, and their Arabic equivalents.

Why this matters:

- The two real cases were used as regression examples, not as code branches.
- The same logic should work for other guests, other responders, and other
  hotels using the same chatbot structure.

## Real Cases Reviewed

### French Case

Case:

- Case ID: `6a477a85f7652de71c82cb0a`
- Guest: Raham Abdel
- Language: French
- Hotel: Zad Ajyad

Observed conversation:

1. Guest said he is Algerian and wants to reserve a room for `03` adult men.
2. AI correctly answered in French.
3. AI suggested a triple room and asked for dates.
4. Guest said he would coordinate with companions and come back.
5. AI closed politely.

Conclusion:

- The French conversation was customer-facing fine.
- The invisible weakness was memory quality:
  - `adults: 3` was not reliably preserved from `03 personnes adultes`.
  - `Algerian` nationality was not reliably preserved from French `algérien`.
  - The triple-room mapping depended too much on assistant text instead of the
    guest's original request.

Fix intent:

- Preserve those facts in deterministic recovery without changing the good
  conversational behavior.

### Arabic Rapid-Date Case

Case:

- Case ID: `6a47a8a6f7652de71c82e518`
- Guest: Ibrahim
- Language: Arabic
- Hotel: Zad Ajyad

Observed conversation:

1. Guest asked for the price for `6` nights.
2. Guest asked room capacity and price for a room for two.
3. Guest sent `5/8/2026`.
4. AI correctly registered arrival as `2026-08-05` and asked for checkout.
5. Guest sent `22/8/2026`.
6. Guest quickly sent `12/8/2026`.
7. AI ended up treating `12/8/2026` as a new arrival date and asked for checkout
   again.

Root cause:

- Recovery treated the first date-only answer after the AI checkout question as
  checkout, then cleared the "AI asked checkout" context too early.
- When the guest immediately sent another date-only message before a useful AI
  reply, the second date was no longer understood as a checkout correction.
- A later assistant echo containing only one date and arrival wording could
  overwrite the valid range and turn the stay into a partial stay.

Correct behavior:

- Keep `2026-08-05` as check-in.
- Treat the later `12/8/2026` as the corrected checkout.
- Quote `2026-08-05` to `2026-08-12` once room facts are known.

### Arabic Price Follow-Up Case

Case:

- Case ID: `6a47a9a5f7652de71c82e7c2`
- Guest: Ibrahim
- Language: Arabic
- Hotel: Zad Ajyad

Observed conversation:

1. AI had verbally acknowledged a stay from `2026-08-12` to `2026-08-20`.
2. Guest asked:
   - `بدي أعرف الحساب`
   - `تقريبي`
   - `أريد معرفة السعر`
3. AI should have quoted or re-quoted.
4. Instead, the flow drifted:
   - It asked for extra confirmation.
   - It interpreted `تقريبي` like a hotel-distance/context question.
   - It gave generic price wording instead of using the quote tool.

Root cause:

- Arabic price intent did not include `الحساب` / `المبلغ`.
- A short follow-up like `تقريبي` is ambiguous by itself, but after "I want to
  know the total/account" it should inherit price context.
- The brain-first path could run before the deterministic date/price quote guard.

Correct behavior:

- If known facts are enough for a quote and the guest asks for price/total, run
  the quote tool before the brain writes a generic reply.
- Treat contextual `تقريبي` as a price estimate request when the previous guest
  or AI turn was about price/total.

## Code Changes

### 1. Safer Date Recovery

File:

- `aiagent/core/orchestrator.js`

New helper:

- `mergeAssistantBoundaryFactsSafely`
- `assistantAcknowledgedStayFacts`
- `mergeAssistantAcknowledgedStayFacts`

Purpose:

- Prevent a single assistant date echo from destructively overwriting a complete
  valid guest-derived stay range.
- Recover clearly acknowledged stay facts from the transcript when the stored
  `aiStateSnapshot` is thin or stale.

Specific protection:

- If current memory has both `checkinISO` and `checkoutISO`, and an assistant
  message has only one conflicting `checkinISO`, ignore that assistant boundary
  fact.
- If an assistant-only checkout would make the stay invalid, ignore it.
- If current memory already has a complete valid stay and a later assistant
  acknowledgement contains a different complete stay, the assistant dates do not
  overwrite the current range.
- If current memory already has a room type and an assistant acknowledgement has
  a conflicting room type, the assistant room type does not overwrite it.

Additional recovery change:

- After a guest answers a checkout-date prompt, recovery no longer clears the
  checkout-question context immediately.
- This allows consecutive date-only guest messages to behave as checkout
  corrections until an AI response changes the context.

Assistant acknowledgement recovery:

- The recovery is not case-specific.
- It does not hard-code Ibrahim, Rania, Zad Ajyad, a support case ID, or a price.
- It can recover dates from any assistant message that contains a valid ISO date
  range such as `2026-08-12` to `2026-08-20`.
- Room and guest recovery uses the existing generic room/guest NLU helpers.
- Arabic/English acknowledgement words are only extra confidence signals for
  transcript recovery; a valid ISO stay range can anchor recovery across
  languages.
- Generic option text is still protected because room/guest extraction from AI
  messages requires either an acknowledgement signal or an ISO date-range anchor.

Why this is safe:

- It only protects complete valid ranges from weaker assistant-only boundary
  facts.
- It does not block explicit guest date ranges or normal quote facts.
- It recovers missing state from conversation history without introducing
  customer-specific rules.

### 2. Arabic Price Intent and Contextual Estimate Follow-Up

File:

- `aiagent/core/orchestrator.js`

Changed helpers:

- `guestAsksPriceAvailabilityOrBooking`
- `latestGuestAsksPriceGuidance`
- `shouldForceQuote`

New helpers:

- `shortApproximateOnlyText`
- `shortApproximatePriceFollowup`
- `latestGuestAsksPriceWithContext`

New Arabic price signals:

- `الحساب`
- `المبلغ`
- contextual `تقريبي`
- contextual `تقريبا`
- contextual `تقريبًا`
- contextual `تقديري`

Important distinction:

- `تقريبي` alone is not treated as a hotel/location fact.
- `تقريبي` after `بدي أعرف الحساب` is treated as price intent.

Pre-brain quote guard:

- If the latest turn has price intent or a date-boundary correction, and quote
  inputs are known, the orchestrator saves facts and runs `handleBrainQuote`
  before handing the turn to the brain-first path.

Why this matters:

- It prevents the AI from asking for already-known details.
- It prevents hotel-fact/distance drift during a price request.
- It preserves the current architecture: the quote tool remains the source of
  price truth.

### 2b. Arabic Single-Date and English Location Classifier Edges

File:

- `aiagent/core/orchestrator.js`

Additional parser/classifier hardening:

- `singleGregorianDateFromText` now accepts a single slash-date inside
  Arabic-script text using day/month order.
- This covers short answers like `من تاريخ 5/8/2026` without tying logic to a
  specific support case.
- Approximate-only text such as `تقريبي` is blocked from the hotel-fact path so
  it cannot be misread as `قريب`.
- English location wording like `How far is the hotel from Haram?` is recognized
  as a hotel-fact question.

Why this is safe:

- The Arabic date fallback only applies when the message itself contains
  Arabic script.
- Existing known-date context still controls ambiguous non-Arabic slash dates.
- The hotel-fact adjustment is lexical and generic; it does not hardcode guest
  names, case IDs, hotel names, or fixed dates.

### 3. French Guest Count, Nationality, and Room Capacity

Files:

- `aiagent/core/orchestrator.js`
- `aiagent/core/nlu.js`

Added support for:

- `algérien`, `algérienne`, `algerian`, `algeria`
- French nationality context like `je suis ...`
- `personnes adultes`
- `adultes`
- `hommes`
- `voyageurs`
- `enfants`

Important edge fixed:

- `03 personnes adultes` now maps as `3` guests.
- Leading-zero room capacity counts such as `03` now map correctly to room
  capacity in `nlu.js`.

Expected result for the French case:

- `adults: 3`
- `children: 0`
- `nationality: Algerian`
- `roomTypeKey: tripleRooms`

### 4. Required Booking Details UI/UX Text

File:

- `aiagent/core/orchestrator.js`

New helpers:

- `bookingDetailLabels`
- `bookingDetailsMissingValue`
- `bookingRoomSummaryForDetails`
- `bookingDetailValueForField`
- `bookingDetailRowsForMessage`

Changed behavior:

- `buildMandatoryDetailsMessage` now returns structured rows with bold labels.
- `buildNationalityNeededMessage` now reuses the same structured details format
  when nationality is the only missing field.

English example shape:

```text
Almost ready. Please send the missing details below:
- **Full Name:** Needed
- **Phone:** Needed
- **Checkin to Checkout:** 2026-08-05 to 2026-08-12
- **Room Type:** Double Room
- **Guests:** 2 adults
- **Nationality:** Needed
Then I can prepare the booking review.
```

Arabic example shape:

```text
تمام، أرسل لي البيانات الناقصة:
- **الاسم الكامل:** مطلوب
- **رقم الهاتف:** مطلوب
- **الوصول إلى المغادرة:** 2026-08-05 إلى 2026-08-12
- **نوع الغرفة:** غرفة مزدوجة
- **الضيوف:** ٢ بالغين
- **الجنسية:** مطلوب
بعدها أجهز لك مراجعة الحجز.
```

Frontend note:

- `jannatbooking_ssr/components/SupportWidget.js` already supports `**bold**`
  rendering and label/value line styling.
- No widget code change was needed.
- This avoids a new frontend contract and keeps the change low risk.

## Helper Contract Notes

These helper contracts matter if future us enhances the chatbot.

### `recoverKnownFactsFromConversation`

Purpose:

- Rebuild a stable `known` object from saved state plus transcript.

Must preserve:

- Guest-provided facts should win over assistant echoes.
- Valid quote facts can restore quote memory only when they still match known
  dates and room selection.
- Profile name/phone can be used as provisional facts, but should be marked for
  confirmation when appropriate.
- The function must be safe for old support cases with incomplete entries.

Do not:

- Add external network calls here.
- Create reservations here.
- Depend on current PM2 memory only.
- Hardcode one support case transcript.

### `mergeAssistantBoundaryFactsSafely`

Purpose:

- Merge assistant single-date boundary facts without damaging a complete stay.

Must preserve:

- A complete current range such as `2026-08-05` to `2026-08-12` should remain
  intact if an assistant later says only `arrival: 2026-08-12`.
- Assistant-only date facts should never make checkout earlier than or equal to
  check-in.

Do not:

- Make assistant single-date facts stronger than guest facts.

### `assistantAcknowledgedStayFacts`

Purpose:

- Recover missing dates/room/guest count from assistant acknowledgements when
  saved memory is thin.

Trusted anchors:

- Valid ISO range in chronological order.
- Clear acknowledgement language.
- Existing generic room/guest NLU helpers.

Must preserve:

- Generic option lists must not be mistaken for confirmed selections.
- Assistant acknowledgements can fill missing fields, but should not replace a
  stronger current complete range or conflicting current room type.

Do not:

- Use hotel names, responder names, or guest names as confidence anchors.

### `latestGuestAsksPriceWithContext`

Purpose:

- Detect direct and contextual price/quote intent.

Must preserve:

- Direct price words should trigger price intent.
- `تقريبي` alone should stay context-sensitive.
- `تقريبي` after `بدي أعرف الحساب`, `أريد معرفة السعر`, or similar price
  context should trigger price intent.
- Hotel fact questions must remain hotel facts when they truly ask for location,
  parking, breakfast, bus, policies, etc.

Do not:

- Treat every short Arabic word as price intent.
- Let approximate-price words route to location just because they contain a
  root similar to `قريب`.

### `singleGregorianDateFromText`

Purpose:

- Convert a single date-like guest answer into an ISO date when context makes it
  safe.

Must preserve:

- Arabic-script slash dates prefer day/month order.
- Existing known date context still helps disambiguate.
- Ambiguous non-Arabic slash dates should not be over-guessed when context is
  missing.

Do not:

- Change global date interpretation for every language without regression
  tests.

### `buildMandatoryDetailsMessage`

Purpose:

- Ask for missing required booking details in a readable, frontend-friendly way.

Must preserve:

- Bold label rows.
- Existing text fallback.
- Required fields only:
  - full name
  - phone
  - check-in/check-out
  - room type/selection
  - guest counts
  - nationality
- Optional email remains optional and should not appear before required details
  are handled.

Do not:

- Ask for passport number, ID number, or other unsupported booking fields.
- Require frontend changes unless a new payload contract is introduced safely.

## Safe Extension Guide

When adding a new language, phrase, or chatbot behavior, follow this sequence:

1. Identify whether the change is:
   - a fact parser change,
   - a price/quote routing change,
   - a hotel-fact answer change,
   - a required-details UX change,
   - or a reservation action change.
2. Add the smallest generic parser/routing rule possible.
3. Add or update focused regression assertions.
4. Confirm the change does not depend on one guest, case, responder, hotel, or
   exact date.
5. Run syntax checks.
6. Run focused chatbot regression checks.
7. Update this documentation with:
   - trigger phrase,
   - expected structured facts,
   - expected action,
   - risk avoided,
   - production verification notes.

Good examples:

- Add `personnes adultes` as a French guest-count signal.
- Add `الحساب` as an Arabic price/total signal.
- Add "how far from Haram" as a generic English hotel-location signal.

Bad examples:

- `if caseId === "6a47..."`.
- `if guestName.includes("Ibrahim")`.
- `if hotelName === "Zad Ajyad" then force double room`.
- Guessing a price in prose because the guest asked for `تقريبي`.

## Action Routing Rules To Preserve

Price / quote:

- If dates and room selection are known and the guest asks for price, use quote
  flow before free-form brain prose.
- If a quote exists but no longer matches the current stay, refresh it.
- If dates or room are missing, ask only for the missing stay facts first.

Hotel facts:

- Location, distance, parking, bus, breakfast, policy, branch, airport-distance,
  and similar questions may be answered as hotel facts.
- Hotel facts must not overwrite booking facts.
- Hotel fact detours should resume booking context afterward instead of
  restarting the flow.

Required details:

- Do not ask for full name, phone, or nationality before a quote if the guest is
  clearly asking for price and quote inputs are known.
- After a quote is shown and the guest wants to continue, ask for missing
  required details in structured rows.
- Ask only the missing fields, but it is okay to display known fields in the row
  summary so the guest can review the context.

Reservation creation:

- Never create a reservation from a normal conversational "yes" unless the
  official review/confirmation path has been satisfied.
- Confirmation-number requests before creation should be answered as pending,
  not fabricated.

## Validation Run Locally

Syntax checks:

```powershell
cd D:\JannatBooking\hotels_backend
node --check aiagent\core\orchestrator.js
node --check aiagent\core\nlu.js
```

Result:

- Passed.

Whitespace/diff check:

```powershell
git diff --check -- aiagent\core\orchestrator.js aiagent\core\nlu.js
```

Result:

- Passed.
- Git only warned that LF may be converted to CRLF when Git touches the files.

Focused regression harness:

- Local Node assertion harness requiring `./aiagent/core/orchestrator`.
- Result: `PASS 35 chatbot regression checks`.

Warnings seen while requiring backend modules:

- `API key does not start with "SG."`
- `Twilio env incomplete: messages will fail unless DRY_RUN is true`

These are environment warnings from local module loading and did not affect the
chatbot assertions.

## Regression Scenarios Covered

New 2026-07-03 scenarios:

1. French case:
   - `algérien`
   - `03 personnes adultes`
   - triple-room inference
   - nationality preservation
2. Arabic rapid-date correction:
   - Arabic-script single date `من تاريخ 5/8/2026`
   - `2026-08-05` check-in
   - `22/8/2026` first checkout
   - `12/8/2026` corrected checkout
   - stale assistant arrival echo ignored
3. Arabic price follow-up:
   - `بدي أعرف الحساب`
   - contextual `تقريبي`
   - `أريد معرفة السعر`
   - `تقريبي` is not treated as a hotel-distance/fact question
4. Required-details UX:
   - English bold rows
   - Arabic bold rows
   - current widget-compatible markdown format

Previous documented scenario categories rechecked:

1. Hotel fact short reactions:
   - `ok` is not a hotel fact.
   - location question is a hotel fact.
   - `How far is the hotel from Haram?` is a hotel fact.
2. Arabic identity and double-room path:
   - Arabic price intent still works.
   - Arabic double-room selection still maps to `doubleRooms`.
3. Known profile phone flow:
   - `same number` still works.
4. Budget/value objection:
   - expensive/discount request still detected.
5. Closer-hotel request:
   - closer-to-Haram request still detected.
6. Date vs guest-count confusion:
   - `26/7/2026` after checkout question is checkout, not 26 adults.
7. Mixed room selection:
   - `1 double room and 1 quad room` preserves both room selections.
8. Split-stay periods:
   - two date ranges parse as two stay periods.
9. Confirmation-number guard:
   - guest asking for confirmation delivery is detected.
10. Thank-you/later outro:
   - later/no further help is detected.
11. Booking process after fact detour:
   - booking-process request is detected.
12. Same-day invalid boundary:
   - checkout equal to check-in is rejected.
13. Ten people recommendation basis:
   - `10 adults` remains guest count.
14. Arabic one-night checkout:
   - Arabic checkout wording is recognized for date boundary.

Additional exact transcript guard added after the first validation:

- Replayed the Arabic Rania/Ibrahim transcript shape before `بدي أعرف الحساب`.
- Confirmed recovery has:
  - `checkinISO: 2026-08-12`
  - `checkoutISO: 2026-08-20`
  - `roomTypeKey: doubleRooms`
  - `adults: 2`
- Confirmed missing fields before the price request are only:
  - `quote`
  - `fullName`
  - `phone`
  - `nationality`
- Confirmed `بدي أعرف الحساب` is price intent.
- Confirmed contextual `تقريبي` after the account/price request is price intent.
- Therefore the patched flow has the facts needed to run the quote tool instead
  of asking add-on/breakfast confirmation questions.

## Cleanliness / Production Readiness

Local backend final status:

- Commit `4ffb298` was created and pushed to GitHub.
- Local backend working tree was clean after commit.

Production backend final status:

- Production was fast-forwarded from `9a37fa3` to `4ffb298`.
- `node --check aiagent/core/orchestrator.js` passed on production.
- `node --check aiagent/core/nlu.js` passed on production.
- `pm2 restart hotels-backend --update-env` completed successfully.
- `pm2 status --no-color` showed `hotels-backend` online.
- Public AI health returned HTTP `200`.

Local and production SSR status:

- `jannatbooking_ssr` stayed clean.
- Local SSR remained at `2f5d1f1`.
- Production SSR remained at `2f5d1f1`.
- No SSR/widget code changed or restarted.

Code-scope risk:

- No schema changes.
- No database migrations.
- No support-case schema changes.
- No frontend rendering changes.
- No new environment variables.
- No reservation creation or dispatch behavior changed.
- No destructive operations were run.

The runtime code patch was deployed and verified. Future edits should repeat the
same local checks and a production health/log check before considering the
chatbot safe.

## Safe Production Deployment Checklist

Use this sequence after committing and pushing the backend changes:

```bash
ssh jannat

cd /home/ahmedadmin/Hotels/hotels_backend
git fetch origin master
git status -sb
git pull --ff-only origin master

node --check aiagent/core/orchestrator.js
node --check aiagent/core/nlu.js

pm2 restart hotels-backend --update-env
pm2 status --no-color
pm2 logs hotels-backend --lines 120 --nostream --no-color
```

From local machine after restart:

```powershell
Invoke-WebRequest https://xhotelpro.com/api/aiagent/health -UseBasicParsing
Invoke-WebRequest https://jannatbooking.com -UseBasicParsing
Invoke-WebRequest https://xhotelpro.com -UseBasicParsing
```

Expected post-deploy results:

- `hotels-backend` online.
- No restart loop.
- Memory in the normal hundreds of MB.
- `https://xhotelpro.com/api/aiagent/health` returns HTTP `200`.
- Recent backend PM2 logs show normal HTTP traffic and no new crash/error burst.

Frontend deployment:

- Not required for this patch.
- Restarting `jannat-ssr` is not necessary unless another frontend change is
  added before deployment.

Actual deployment executed for this pass:

- `git pull --ff-only origin master` on production backend.
- Production moved to `4ffb298`.
- Server-side syntax checks passed.
- `hotels-backend` restarted through PM2.
- AI health endpoint returned HTTP `200`.
- Jannat website returned HTTP `200`.
- Backend log tail showed normal traffic and startup initialization.

## Recommended Live Smoke Test After Deploy

Use one supervised live case only first.

Test Arabic rapid-date path:

1. Ask in Arabic for price for a double room / two people.
2. Give check-in `5/8/2026`.
3. When asked checkout, send `22/8/2026`.
4. Immediately send `12/8/2026`.
5. Expected:
   - The bot quotes or continues with `2026-08-05` to `2026-08-12`.
   - It does not change arrival to `2026-08-12`.

Test Arabic price follow-up:

1. Establish dates, room type, and guest count.
2. Ask `بدي أعرف الحساب`.
3. Optionally follow with `تقريبي`.
4. Expected:
   - The bot treats this as price intent.
   - It uses the quote flow when quote facts are missing/stale.

Test required-details display:

1. Continue after quote.
2. Stop before giving name/phone/nationality.
3. Expected:
   - The bot shows bold structured rows for missing details.
   - The support widget renders labels clearly.

## Future Regression Matrix

Before changing the chatbot again, rerun or recreate focused checks for these
areas.

Date/state recovery:

- Arabic single date after arrival prompt:
  - input: `من تاريخ 5/8/2026`
  - expected check-in: `2026-08-05`
- Arabic consecutive checkout correction:
  - known check-in: `2026-08-05`
  - first checkout: `22/8/2026`
  - corrected checkout: `12/8/2026`
  - expected range: `2026-08-05` to `2026-08-12`
- Assistant stale echo:
  - assistant says only `2026-08-12` as arrival after a valid range exists
  - expected: do not overwrite complete range

Arabic price routing:

- input: `بدي أعرف الحساب`
  - expected: price intent
- input: `تقريبي` after a price/account request
  - expected: price intent
- input: `تقريبي` alone
  - expected: not hotel-fact-only
- input: `قريب من الحرم؟`
  - expected: hotel fact
- input: `أريد معرفة السعر`
  - expected: price intent

French parsing:

- input: `je suis algérien`
  - expected nationality: `Algerian`
- input: `03 personnes adultes`
  - expected adults: `3`
- input: `chambre pour 03 personnes adultes`
  - expected room key: `tripleRooms`

Room and guest safety:

- input: `1 double room and 1 quad room`
  - expected two room selections, not one overwritten room type
- input: `26/7/2026` while asking for guest count
  - expected date-like token, not `26` adults
- input: `10 adults`
  - expected guest count, not room count

Hotel fact detours:

- input: `ok`
  - expected not hotel fact
- input: `How far is the hotel from Haram?`
  - expected hotel fact
- input: closer-hotel request
  - expected closer-hotel handling / human-safe path
- after hotel fact answer, guest asks booking process
  - expected contextual booking next step, not generic restart

Required details:

- English rows include:
  - `**Full Name:** Needed`
  - `**Phone:** Needed`
  - `**Checkin to Checkout:** ...`
- Arabic rows include:
  - `**الاسم الكامل:** مطلوب`
  - `**رقم الهاتف:** مطلوب`
  - `**الوصول إلى المغادرة:** ...`

Reservation safety:

- Guest asking for confirmation number before reservation exists:
  - expected no fake confirmation number
- Guest says thanks/later:
  - expected polite outro/close behavior, not forced booking
- Guest asks booking process with known facts:
  - expected summary of known facts and exact next required action

## Known Warnings / Non-Issues Seen During This Pass

Local module-load warnings:

- `API key does not start with "SG."`
- `Twilio env incomplete: messages will fail unless DRY_RUN is true`

Meaning:

- These appeared while requiring backend modules locally for the assertion
  harness.
- They were environment warnings, not chatbot regression failures.
- They did not prevent syntax checks or the focused regression harness from
  passing.

Git warnings:

- Windows Git warned that LF may be converted to CRLF on touched files.
- `git diff --check` passed.
- No whitespace errors were found.

GitHub push warning:

- GitHub reported existing dependency vulnerabilities on push.
- This patch did not change dependencies.
- Dependency remediation should be handled separately, not inside a chatbot
  behavior patch.

Production server artifacts:

- Existing untracked `.env.backup-*` and `.bak-*` files were present before this
  deployment.
- They were not created by this pass.
- They should not be broadly removed during chatbot work.

## Rollback / Recovery Notes

If production behaves badly after a future chatbot patch:

1. Check health first:
   - `https://xhotelpro.com/api/aiagent/health`
   - PM2 status/logs for `hotels-backend`
2. Confirm the deployed commit:
   - `cd /home/ahmedadmin/Hotels/hotels_backend`
   - `git rev-parse --short HEAD`
3. If rollback is required, prefer a normal Git revert commit over destructive
   checkout/reset.
4. Restart only `hotels-backend` for backend-only chatbot changes.
5. Restart `jannat-ssr` only if frontend widget code changes.
6. After rollback/revert, run:
   - server-side `node --check` on changed JS files
   - PM2 restart/status/log tail
   - public AI health check

Rollback caution:

- Do not reset production with untracked backup files present unless explicitly
  planned.
- Do not delete support cases or reservations to fix chatbot behavior.
- Real support cases used for diagnosis should remain read-only unless there is
  an explicit data-repair task.

## Future Cautions

- Do not remove the quote-tool guard just because the brain can answer in
  natural language. Price must remain tool-backed.
- Do not let assistant-only single-date messages overwrite complete guest-derived
  ranges.
- Keep contextual short replies language-aware. Words like `تقريبي` need previous
  turn context.
- Keep the required details as frontend-friendly text unless a real frontend data
  contract is introduced later.
- If production logs show old `.bak` or `.env.backup-*` files, treat them as
  existing server artifacts and avoid broad cleanup during chatbot deploys.
