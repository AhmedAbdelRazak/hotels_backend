# Chatbot Production Stabilization - 2026-06-22

## Purpose

This note documents the production chatbot stabilization work done after the
June 21/22 live testing session. It is intentionally written for future us:
before changing the chatbot again, read this file together with:

- `docs/chatbot-direct-answer-and-multilingual-parsing-2026-06-21.md`
- `docs/chatbot-price-date-guard-2026-06-22.md`
- `docs/chatbot-post-booking-close-and-typing-2026-06-22.md`
- `aiagent/READEME.md`

The main lesson: the chatbot quality depends on deterministic state recovery,
not only prompt wording. A small scheduling or hydration mistake can make the
agent ask for dates, nationality, or names again even when the guest already
provided them.

## Production Symptoms We Saw

During live hotel-chat testing, the guest experience became unstable in several
ways:

- The frontend sometimes showed `Message Failed`, or the send button felt
  disabled/slow.
- The tester did not always see `Aisha is typing...` during slower AI planning.
- Room type answers could be hard to read when too many options were presented
  in one inline sentence.
- The bot asked again for check-in and checkout dates even though the guest had
  already supplied a full stay date range.
- The bot asked again for nationality after the guest wrote `French` and later a
  French nationality answer in Arabic.
- The bot sometimes treated `French` as a language-switch command instead of a
  nationality answer during reservation-detail collection.
- One idle/continuation reply addressed the guest as `30`, because date text
  was incorrectly eligible as a name fallback.
- A guest pause such as "I will talk later, thanks anyway" could be followed by
  a sales/quote nudge instead of a warm pause acknowledgement.
- The chat could appear closed in the frontend while the backend support case
  was still open, or stay open longer than expected.
- PM2 logs showed repeated Node.js out-of-memory crashes near the 4 GB heap
  limit.

## Root Causes

### 1. Memory Pressure From Support-Case Broadcasting

The support-case change stream was too heavy for production traffic because it
could fetch full support-case documents for every conversation update. During
polling and active chat, this contributed to large heap growth and eventual
Node.js OOM crashes.

Fix commit:

- `f8fa57d Fix support chat memory pressure`

Important changes:

- Avoided `fullDocument: "updateLookup"` for support-case watcher broadcasts.
- Broadcasted from update descriptions and last-message slices instead of full
  documents.
- Added lean reads where possible.
- Narrowed notification reservation projections.
- Removed large crash core dumps from the home server after confirming they
  were old generated crash artifacts.

### 2. Restart Recovery Was Not Strong Enough

The bot initially worked because in-memory state knew the selected room, date
range, quote, and review stage. After PM2 restart/OOM recovery, the in-memory
state was gone and had to be rebuilt from the saved Mongo support-case
conversation.

The parser itself correctly understood examples like:

- Arabic "30 June to 4 July"
- Arabic same-month Gregorian ranges
- Ramadan/Hijri ranges

The issue was that the recovered state did not always rehydrate all slots before
the next planner branch ran. This caused the bot to ask for dates again even
after it had already quoted or reviewed the same dates.

Fix commits:

- `7d94bef Fix chatbot date memory and fact priority`
- `4a90be9 Fix chatbot price date prompt loop`
- `4256ea5 Fix AI booking detail state recovery`

Important changes:

- Rehydrate known slots from the saved transcript before routing the turn.
- Let the latest complete guest-provided date range win.
- Recover dates from the guest message or, if needed, the AI review summary.
- Keep `dateRaw` consistent with the active ISO date range.
- Rebuild reservation-detail stage from prior mandatory-detail prompts.

### 3. Language Switching Ran Before Detail Capture

In the Ashraf/Amira test, the guest sent mandatory details in one message:

- full name
- phone number
- `French`
- `4 persons`

The bot captured some details, but later `French` and the Arabic French
nationality answer could be treated as language-switch requests. That produced a
confusing French acknowledgement instead of saving the nationality.

Fix commit:

- `4256ea5 Fix AI booking detail state recovery`

Important changes:

- Hydration and booking-stage recovery now run before language-switch routing.
- When the bot is in reservation-detail collection, short nationality answers
  such as `French`, `France`, and Arabic French nationality variants are treated
  as nationality, not as language commands.
- Real language commands such as "speak Arabic" still switch language.

### 4. Name Safety Was Too Permissive

After the guest re-sent dates, date-like text could enter the name fallback path.
That created the bad UX where the bot addressed the guest as `30`.

Fix commit:

- `4256ea5 Fix AI booking detail state recovery`

Important changes:

- Date-like text is rejected as a full-name candidate.
- Pure numeric names are rejected for display addressing.
- If a bad transient slot exists, the display name falls back to the known
  support-case customer name instead of using the bad slot.

### 5. Frontend Sending Needed Optimistic UX

The support widget originally made some sends feel blocked because the UI waited
too much on the backend result. Testers perceived this as lag and sometimes saw
`Message Failed`.

Fix commit:

- SSR `0ca22e8 Smooth support chat sending`

Important changes:

- Added optimistic local message rendering using `clientTag`.
- Kept the user's message visible while the backend request completes.
- Restored the message on failed send instead of making the chat feel frozen.
- Avoided showing fake immediate AI typing the instant the guest sends a
  message.

### 6. Recovery And Idle Timers Needed Durable Boundaries

The one-minute no-rush follow-up and five-minute close are useful, but they can
be dangerous if scheduling and recovery overlap. The issue was not the idea of
the feature; it was making sure delayed jobs do not re-answer stale turns or
close a truly unanswered latest guest message.

Fix commits:

- `41ea7af Stabilize AI chat recovery delivery`
- `4256ea5 Fix AI booking detail state recovery`

Important changes:

- Recovery jobs are claimed with `aiRecoveryScheduledAt` so the same unanswered
  turn is not scheduled repeatedly.
- Maintenance recovers only recent genuinely unanswered guest turns.
- Idle close does not close a case where the latest guest turn still has no AI
  answer after it.
- Post-booking close is separate from ordinary idle close and can close quickly
  after a guest clearly ends the chat, giving the rating panel a chance to show.

## Current Chatbot Behavior Contract

Preserve this contract when improving the bot:

- First opening uses a readable Islamic greeting in the guest's active language.
- On a single-hotel page, the hotel is preselected and the chat is the hotel
  reception/reservation context.
- Direct questions are answered first before booking prompts:
  - hotel distance
  - map/location
  - bus/shuttle
  - room types
  - direct hotel/reception relationship
  - invoice/confirmation usability
  - payment/link help
- If dates are already known, do not ask for dates again.
- If room type is already known, do not ask for room type again.
- If the guest asks for room options and dates are known, list room options and
  ask only for the room choice or guest fit.
- Reservation detail collection should be one concise prompt for:
  - full name
  - phone
  - nationality
  - guest count
- Optional email comes after mandatory details.
- Creating the reservation must be user-driven by the final `Place Reservation`
  quick-reply action.
- `There's Something Wrong` / correction must let the guest adjust details
  before creation.
- A pause/later/no-thanks message must be acknowledged warmly and must not
  trigger another sales nudge.
- The bot must stay within the selected hotel scope and must not recommend or
  compare other hotels inside a selected-hotel support case.

## Implementation Map

Main backend paths:

- `aiagent/core/orchestrator.js`
  - turn planner
  - slot hydration
  - language switching
  - direct-answer routing
  - idle and recovery wording
  - reservation detail state machine
- `aiagent/core/nlu.js`
  - deterministic date parsing
  - Hijri/Gregorian date handling
  - room type mapping
- `models/supportcase.js`
  - support-case schema and AI recovery fields
- `services/supportCaseMaintenance.js`
  - idle close and unanswered-turn recovery scheduling
- `server.js`
  - support-case socket broadcasting and DB watcher
- `controllers/supportcase.js`
  - public support-case send/update paths and `clientAction`
- `services/reservationConfirmationDispatcher.js`
  - reservation confirmation delivery and PDF safety

Main SSR paths:

- `jannatbooking_ssr/components/SupportWidget.js`
  - public chat widget, optimistic send, typing display, rating close UX
- `jannatbooking_ssr/lib/chatQueryParams.js`
  - chat query/opening context helpers

## Verification Checklist Before Future Deployment

Use this checklist before pushing chatbot changes to production:

1. Run syntax checks:
   - `node --check aiagent/core/orchestrator.js`
   - `node --check aiagent/core/nlu.js` when date/language parsing changes.
   - `node --check services/supportCaseMaintenance.js` when recovery changes.
2. Test a transcript-style state recovery case:
   - guest gives dates
   - AI quotes/reviews
   - guest confirms
   - AI asks mandatory details
   - guest sends full name, phone, nationality, and guest count in one message
   - verify no repeat date/nationality/name prompt occurs.
3. Test nationality-vs-language:
   - `French` during nationality collection means nationality.
   - an explicit command like "speak French" means language switch.
4. Test name safety:
   - date-like text cannot become `st.slots.name`.
   - pure numbers cannot be used as the displayed guest name.
5. Test direct hotel facts:
   - location/map
   - bus/shuttle
   - distance
   - invoice/confirmation question
   - after the direct fact answer, confirm the earlier quote still advances to
     reservation review instead of payment help.
6. Test pause/later:
   - guest says they will talk later
   - bot acknowledges warmly
   - no quote/proceed nudge follows.
7. Test final action:
   - details complete
   - bot shows final `Place Reservation` prompt
   - reservation is not created until the button action is received.
8. After production pull/restart:
   - `pm2 status hotels-backend`
   - backend root HTTP 200
   - recent PM2 out log has startup lines and normal 200s
   - error log timestamp did not advance
   - memory stays in the expected hundreds of MB, not multi-GB
   - no new `core*` files appear in the backend directory

## Production Health Notes From This Session

After the final deployment:

- Backend production commit: `4256ea5`
- `hotels-backend` restarted successfully under PM2.
- Root health check returned HTTP 200 in a few milliseconds.
- Memory stayed around 278-312 MB during the short post-deploy watch.
- CPU settled to low single digits.
- Server RAM had about 12 GiB available, swap unused.
- CPU temperature was around 36 C and NVMe around 37 C.
- The scary OOM lines still visible in the PM2 error tail were old. The error
  log timestamp stayed before the final deployment and did not move afterward.

### Follow-up: Quote Confirmation After Side Questions

Issue seen in production:

- Guest received a valid quote, then asked a side question such as the Google
  Maps location.
- The assistant answered the side question correctly.
- When the guest later wrote a confirmation phrase such as "confirm the booking
  above" or repeated the hotel/total, recovery looked only at the last assistant
  message. Because that last message was the map answer, the quote/proceed stage
  could be lost and broad payment/reservation keyword routing could hijack the
  turn.
- Bad symptom: the assistant asked for a payment receipt/reference instead of
  continuing to the reservation review.

Fix deployed:

- Recover booking stage from the latest meaningful stage-bearing assistant
  message, not merely the last assistant message.
- Rehydrate room type from assistant quote/review messages when the guest did
  not explicitly type the room name.
- Treat active-quote confirmation phrases and repeated quote totals as proceed
  confirmations before direct payment/help routing.
- Keep genuine payment questions outside the quote-confirmation path.
- Public guest updates and client-close updates now clear stale
  `aiRecoveryScheduledAt` so unanswered-turn recovery is not blocked by an old
  marker.
- The SSR widget now waits for the backend close response before clearing local
  chat state, preventing a UI-only close when the server did not close yet.

Verification added for this case:

- Transcript harness: quote -> map question -> map answer -> Arabic total
  confirmation.
- Expected recovery: room `quadRooms`, dates `2026-07-22` to `2026-07-30`,
  total `600 SAR`, stage `proceed`.
- Expected action: confirmation sends reservation review with
  `confirm/correction` quick replies and does not ask for receipt/payment
  reference.
- Server check after deployment: the old Yasmin case was closed and no longer
  waiting for an AI reply.

## Future-Us Rules

- Do not fix chatbot behavior only by adding prompt instructions when the issue
  is state, scheduling, or deterministic routing.
- Do not remove the one-minute follow-up or five-minute close unless the
  scheduling/recovery contract is broken and cannot be repaired. The feature is
  valuable when guarded properly.
- Do not let delayed planner turns append replies when a newer guest message or
  an existing AI reply already exists.
- Do not let direct fact answers, like maps or distance, erase the active quote
  stage.
- Do not let active-quote confirmation text fall through into payment help.
- Do not close an AI chat whose latest guest message is still unanswered.
- Do not let the language detector outrank reservation-detail collection.
- Do not let previous support cases leak into selected-hotel support scope.
- Keep room/date/nationality/detail collection deterministic where possible.
- Keep UI sends optimistic and visible; never make guests feel their message
  disappeared while the backend is thinking.
- Always check PM2 error-log timestamps before assuming old OOM lines are new.
