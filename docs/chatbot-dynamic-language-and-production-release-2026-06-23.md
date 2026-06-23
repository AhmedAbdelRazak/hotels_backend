# Chatbot Dynamic Language And Production Release - 2026-06-23

## Why This Change Exists

This release improves the public hotel reception chatbot after reviewing the Ahmed Test / Amira conversation in production PM2 logs.

The visible problems were:

- The generated guest opener, such as "Assalamu alaikum Jannat Booking, I would like to ask about Zad Al Safa", appeared as if the guest typed it.
- The initial waiting message sounded like an internal support status instead of a warm reception message.
- A Nusuk question was incorrectly answered with cancellation policy.
- Bus details could sound raw because they reflected admin field wording too directly.
- A simple acknowledgement like "Ok" after a room-list answer could incorrectly advance the booking flow.
- Direct factual answers needed lower latency without making the chatbot less dynamic.

## Files Changed

- `controllers/supportcase.js`
  - Creates the new localized waiting message.
  - Suppresses generated initial guest starter messages from the visible conversation.
  - Keeps manually typed guest first messages visible.

- `aiagent/core/orchestrator_rebuilt.js`
  - Uses private inquiry context when the generated starter is hidden.
  - Sends compact reservation context to OpenAI when the chat is reservation-related.
  - Adds verified direct-answer routing for safe hotel facts.
  - Fixes Nusuk classification before policy classification.
  - Polishes bus wording for known bus field patterns.
  - Prevents room/date recovery from generic assistant room-list answers.
  - Handles acknowledgement-only guest messages without restarting booking prompts.
  - Detects Hindi and Urdu message text before Arabic fallback.
  - Adds an OpenAI localization layer for deterministic/template replies in non-English/non-Arabic languages.

- `aiagent/core/db.js`
  - Adds reservation lookup by reservation id for prompt context.

- `jannatbooking_frontend/src/Chat/ChatWindow.js`
  - Aligns legacy widget waiting messages with the new professional "representative will be with you shortly" wording.

## Initial Message Behavior

The persisted system/waiting message is now dynamic and localized. English hotel cases use wording like:

> A representative from Zad Al Safa reception will be with you shortly. You are in the right place, and we will help from here.

Jannat Booking support cases use "Jannat Booking support" instead of hotel reception.

Generated starter messages are still accepted as private context through `inquiryDetails`, but they are no longer displayed as a visible guest bubble. This keeps the AI informed without making the transcript look fake.

## Language Switching

The agent now treats the latest guest message language as stronger than the saved preferred language.

Examples:

- If the user selected English but writes in Hindi script, the turn is treated as Hindi.
- If the user selected English but writes in Urdu script or common Urdu wording, the turn is treated as Urdu.
- Arabic script still falls back to Arabic when it does not look like Urdu.
- Supported Latin-script language switches are also detected for Spanish, French, Indonesian, and Malay using lightweight reception/chat vocabulary cues.
- For OpenAI-planned turns, the prompt includes both `preferredLanguage` and `latestGuest.detectedLanguage`.
- For deterministic/template replies in languages other than English or Arabic, OpenAI is used as a localization layer so the response can stay in the guest's latest language without hardcoding every sentence.

## Reservation Context

When a chat appears reservation-related, the planner now attempts to attach compact reservation context from:

- `supportCase.aiReservation.reservationId`
- `supportCase.aiReservation.confirmationNumber`
- confirmation numbers found in the latest message or transcript

The context is intentionally compact and avoids unnecessary sensitive detail. It includes high-value orchestration facts such as confirmation number, status, stay dates, room summary, payment status, and limited guest fields.

## Latency Notes

Safe direct questions can bypass the full planning call when the answer is deterministic from verified hotel data:

- cancellation policy
- bus/shuttle
- location
- distance
- Nusuk status
- room options
- room description
- amenities

For English and Arabic, these can be answered immediately with local templates. For other languages, the deterministic answer is localized through OpenAI. OpenAI-generated final replies are not localized again, avoiding redundant model calls.

## Verification Performed

Local checks before deployment:

- `node --check aiagent/core/db.js`
- `node --check aiagent/core/orchestrator_rebuilt.js`
- `node --check controllers/supportcase.js`
- Focused Node harness for:
  - hidden generated starter as private context
  - initial system hold not blocking first AI reply
  - Nusuk detection
  - acknowledgement-only "Ok" behavior
  - polished bus wording
  - Hindi/Urdu quick replies and localization routing
- `npm run build` in `jannatbooking_ssr`
- `npm run build` in `jannatbooking_frontend`

Known unrelated frontend build warnings remained:

- ReactPixel source-map warning
- unused `hasOffers` in `src/components/Navbar/Navbar.js`
- old Create React App / Browserslist notices

## Production Rollout Checklist

1. Commit and push `hotels_backend`.
2. Commit and push `jannatbooking_frontend`.
3. Pull latest code on the production server.
4. Run backend syntax checks on production.
5. Build any updated frontend app if its production process serves built assets.
6. Restart affected PM2 processes.
7. Confirm PM2 status is online.
8. Check recent PM2 logs for chatbot startup/runtime errors.

## Important Operational Notes

- The active backend PM2 process is `hotels-backend`.
- The backend production path observed on 2026-06-23 was `/home/ahmedadmin/Hotels/hotels_backend`.
- The chatbot planner is socket-driven through `aiagent/core/orchestrator_rebuilt.js`.
- Do not remove the private inquiry fallback unless the SSR widget stops sending generated starter context or another private context channel replaces it.

## Production Test Follow-Up - Same Day

The first live test after the hidden-starter release exposed a no-reply issue. The generated starter was stored in the first system conversation entry's `inquiryDetails`, not on a top-level support-case field. The planner now reads private opener context from the system conversation entry as well.

A second live test exposed quality issues:

- The hidden generated opener made the bot reply "Wa alaikum assalam" even though the visible guest had not said it.
- Room-list questions could be converted into a single room-fit answer such as only recommending Double Room.
- The bot asked for dates after acknowledgement or feedback such as "No worries" and "Are you lost?"
- The AI could send while the guest was actively typing.
- SSR could suppress the visible "Nadia is typing..." state right after the guest sent or typed.
- Longer chats routed too many deterministic room questions through OpenAI, causing 10-20 second responses.

Follow-up fixes:

- Initial hidden generated openers now become neutral private context and use a deterministic welcome.
- Room-options questions always render the active room-type list.
- Specific room existence questions such as "Do you have triple rooms?" are treated as room-options questions.
- Bot-challenge text such as "Are you lost?" receives a concise apology and context-aware correction.
- Common acknowledgements such as "No worries" do not trigger booking/date prompts.
- The backend tracks guest typing and defers AI sending while the guest is actively composing.
- The SSR widget now shows AI typing events even immediately after the guest sends a message.
- Room-list display names are lightly cleaned so emoji or leading marks from admin room names do not leak into the guest answer.
