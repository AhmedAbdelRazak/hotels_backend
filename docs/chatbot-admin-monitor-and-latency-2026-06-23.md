# Chatbot Admin Monitor And Latency Tightening - 2026-06-23

## Why This Exists

Live testing from `/admin/customer-service?tab=active-client-cases&caseId=...`
showed that the chatbot could still feel slow and repetitive even when the
final guest rating was good. The `Ahmed kareem` / `zad al qimma` case was the
main reference:

- The case closed with a positive rating, but several replies took 20-50+
  seconds.
- A stalled-turn recovery ran during the test.
- "Booking details" repeated the final prompt instead of summarizing the current
  booking state.
- "Price again" fell back into a date/request path even though the quote was
  already known.
- Optional email collection added another conversational stop after mandatory
  guest details were already supplied.

The goal of this update is not to create another dashboard. The admin monitor is
inside the existing selected support case route, so staff can open the same
customer-service case URL and immediately see AI health signals beside the chat.

## Backend Changes

Main files:

- `aiagent/core/orchestrator.js`
- `aiagent/core/openai.js`
- `services/supportCaseMaintenance.js`

Changes:

- Chatbot OpenAI calls now cap at 6 seconds even when the broader backend
  `OPENAI_TIMEOUT_MS` is higher. `OPENAI_CHATBOT_TIMEOUT_MS` can still lower it
  further, but broad backend defaults should not make live chat wait 12 seconds.
- Default reply pacing now aims closer to 2.2-3.6 seconds instead of 3.2-4.8
  seconds.
- Planning typing starts sooner by default.
- NLU soft-timeout fallback is 4 seconds instead of 6.5 seconds.
- Unanswered-turn recovery defaults to 15 seconds instead of 25 seconds.
- Hotel policy, direct hotel facts, and bus/shuttle answers use soft-timeout
  writer calls with deterministic fallbacks instead of waiting indefinitely for
  polished wording.
- Bus details are not dumped raw across language boundaries. If owner notes are
  English and the guest is Arabic, the deterministic fallback says the bus
  service exists without pasting English notes.
- New deterministic booking-state fast paths answer from the current state:
  - repeat price / total / "how much"
  - reservation or booking details / summary
- These fast replies preserve the active `waitFor` stage. They do not knock a
  case backward from finalization to dates.
- If a price question is the first moment where room and dates are complete, the
  fast path advances to `proceed` and provides the normal proceed quick replies.
- Optional email is no longer asked automatically after mandatory details. Email
  remains capturable if the guest provides it or an older case is already in the
  `email_or_skip` stage.

## Admin UI Changes

Main file:

- `hotels_frontend/src/AdminModule/CustomerService/ChatDetail.js`

The existing selected case detail now shows a compact AI monitor:

- AI responder name
- average reply delay
- max reply delay
- last reply delay
- current waiting time for an unanswered guest turn
- answered guest turns / total guest turns
- unanswered latest turn count
- duplicate consecutive AI replies
- status badge: healthy, watch, slow, or paused

Each AI reply also shows a small delay badge beside its timestamp. This makes it
easy to scroll a case and see which exact turn was slow.

## Behavior Contract

Preserve these rules when changing this area again:

- Do not move the monitor to a new route. It belongs inside the existing
  `/admin/customer-service` selected case panel.
- Do not remove the final `Place Reservation` action. Creating a reservation
  must still be deliberate and user-driven.
- Do not reintroduce automatic optional-email collection as a required-feeling
  step after mandatory details.
- Repeat-price and booking-details questions must answer from saved/current
  state before broad NLU or support-decision routing.
- Direct hotel facts should answer quickly from verified hotel settings; LLM
  polishing is allowed only behind a short soft timeout.
- If the bot does not know a fact, it should say that professionally and then
  ask one relevant hotel/reservation follow-up.
- Avoid long copy-paste room or policy descriptions. Summaries should be short
  unless the guest asks for full details.

## Live Ayman Incident - Guest Name Protection

During the `Ayman / zad al qimma` live tests on 2026-06-23, two reservations
were created successfully but with incorrect guest names:

- `6915160582` saved `ممكن السرعة` as the guest name after a slow finalization
  prompt caused the guest to chase the bot.
- `8939348710` saved `بوركينا فاسو` as the guest name because a nationality
  answer was accepted as a name.

Production data was corrected immediately:

- `6915160582` -> `ايمن شوقى عبد العظيم`
- `8939348710` -> `ايمن شوقى`

Follow-up guardrails added:

- Polite filler, hurry/chase messages, booking-detail requests, and
  confirmation-number requests are rejected as guest names.
- Nationality-only values, including Burkina Faso, are rejected as guest names.
- A fuller real name may replace a shorter support-case name, but ambiguous
  later text cannot overwrite a valid name.
- The reservation creation action now rejects bad AI guest names as a final
  database safety gate.
- Post-booking price/details/confirmation-number questions are answered from
  the completed reservation state instead of falling back into a new quote flow.

## Verification Used

- `node --check aiagent/core/openai.js`
- `node --check aiagent/core/orchestrator.js`
- `node --check services/supportCaseMaintenance.js`
- `npx eslint src/AdminModule/CustomerService/ChatDetail.js --max-warnings=0`

Before production deployment, also run:

- `npm run build` in `hotels_frontend`
- PM2 restart and health checks for `hotels-backend`
- Admin route smoke check for an active client support case with `caseId`
