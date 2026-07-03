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

## Current Deployment State

Backend repository:

- Local path: `D:\JannatBooking\hotels_backend`
- Production path: `/home/ahmedadmin/Hotels/hotels_backend`
- GitHub branch: `master`
- Production PM2 app: `hotels-backend`
- Files changed locally in this pass:
  - `aiagent/core/orchestrator.js`
  - `aiagent/core/nlu.js`
  - `docs/chatbot-arabic-french-date-price-required-details-hardening-2026-07-03.md`

Frontend repository:

- Local path: `D:\JannatBooking\jannatbooking_ssr`
- Production path: `/home/ahmedadmin/Hotels/jannatbooking_ssr`
- Production PM2 app: `jannat-ssr`
- No frontend code changed in this pass.

Important deployment caveat:

- The code changes documented here were validated locally and are ready for a
  clean production push/deploy, but production had not yet pulled this patch at
  the time this document was written.
- Production backend was still on commit `9a37fa3` during the read-only health
  check.
- Production SSR was still on commit `2f5d1f1` during the read-only health check.

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

Local backend status before this document:

- Intended modified tracked files:
  - `aiagent/core/orchestrator.js`
  - `aiagent/core/nlu.js`
- After this document, this new `.md` file is also intended.

Local SSR status:

- `jannatbooking_ssr` was clean.
- No SSR/widget code changed.

Code-scope risk:

- No schema changes.
- No database migrations.
- No support-case schema changes.
- No frontend rendering changes.
- No new environment variables.
- No reservation creation or dispatch behavior changed.
- No destructive operations were run.

The patch is production-ready from a local validation perspective once reviewed,
committed, and pushed.

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
