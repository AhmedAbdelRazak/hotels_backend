# Chatbot Rebuilt Conversation Engine - 2026-06-23

## Current Source Of Truth

The active chatbot is now wired through:

- `aiagent/index.js`
- `aiagent/core/orchestrator_rebuilt.js`
- `aiagent/core/actions.js`
- `aiagent/core/countryCodes.js`
- `jannatbooking_ssr/components/SupportWidget.js`

`aiagent/core/orchestrator.js` is legacy reference code and is no longer the
production entry point. Do not add new behavior there unless the entry point is
changed back intentionally.

## Why It Was Rebuilt

Live tests showed the old structure was too branch-heavy:

- It could ask for optional email as an extra stop.
- It could ask for multiple confirmations before the final reservation action.
- It could misread a nationality or hurry message as a guest name.
- It could treat post-booking bus/detail questions as payment or quote flow.
- It carried too much stale in-memory state and could lose the real topic after
  side questions.

The new engine makes one full conversation-review decision per guest turn, then
uses deterministic backend tools for anything that writes data.

## Behavior Contract

- The OpenAI planner reviews the saved support-case transcript on every turn.
- The planner returns structured JSON only: action, answer kind, language, and
  booking slots.
- Pricing, availability, reservation creation, confirmation numbers, duplicate
  locks, and pending-confirmation state remain backend-owned.
- The bot answers direct questions first: rooms, room description, amenities,
  bus, location, distance, policies, payment links, and reservation details.
- Room descriptions are concise and based only on hotel room settings.
- If a detail is not confirmed, the bot says so professionally and asks one
  relevant follow-up.
- No artificial human delay is added after planning. Typing starts immediately,
  and the answer sends as soon as it is ready.
- One support case can have only one active planner pass. Queued duplicate
  schedules collapse into one retry after the current pass finishes.
- Timers are per-case, cleared after firing, and unref'd so they do not keep the
  Node process alive.

## Reservation Flow

The current booking flow is intentionally shorter:

1. If room and dates are missing, ask only for the missing item.
2. Once room and dates are known, quote price and request missing mandatory guest
   details in the same message.
3. Mandatory details are full name, phone, nationality, and adult count.
4. Children default to `0` if not supplied.
5. Email is optional and must not become a separate required-feeling step.
6. When details are complete, send one final reservation review with quick
   replies.
7. Create the reservation only after `place_reservation` / `Complete
   Reservation`, or an equally clear confirmation after that final review.

## Nationality Storage

AI-created reservations now save `customer_details.nationality` as ISO-3166
alpha-2 country codes, matching OrderTaker/Jannat Tools behavior.

Examples:

- `Egyptian` / Arabic Egyptian variants -> `EG`
- `Jordanian` -> `JO`
- `Burkina Faso` -> `BF`
- `French` -> `FR`

The OpenAI planner is asked for the ISO code, and `countryCodes.js` provides a
deterministic fallback using `i18n-iso-countries` plus common demonym aliases.

## Post-Booking Behavior

After `aiReservation.status="created"` or a confirmation number exists:

- Hotel facts such as bus, distance, location, and policies answer directly.
- Reservation details and payment questions return the confirmation number,
  reservation-details link, and payment link.
- The bot must not restart quote flow unless the guest clearly asks for a new
  booking.

## SSR Widget

`jannatbooking_ssr/components/SupportWidget.js` now classifies bubbles by stable
sender role:

- AI/system/support identities render as agent bubbles.
- Client-tagged and matching-contact messages render as guest bubbles.
- Optimistic local messages and server echoes merge even if one side has a
  generated server `_id` and the other has only `clientTag`.

This prevents duplicate visible guest messages and keeps guest/CSR backgrounds
visibly different.

## 2026-06-23 Latency And Duplicate Message Follow-Up

Live PM2/database timing showed the backend process was healthy, but basic
guest questions could still spend 9-30 seconds in the full OpenAI planner path.
The production quality setting is now OpenAI-first again: the planner reviews
the saved transcript on every guest turn, then the backend validates and renders
structured hotel/reservation behavior. Deterministic code must be used as a
guardrail only:

- recover obvious structured slots from the transcript when the JSON omits them
  (room, dates, phone, email, nationality, adult count);
- protect against stale replies, duplicate client messages, and duplicate AI
  turns;
- render pricing, final review, reservation creation, and created-reservation
  links from backend state;
- answer policy/fact output only after the planner selects the answer kind, or
  as a timeout/fallback path.

`AI_AGENT_FAST_PATH_ENABLED=true` can opt back into the pre-model fast path for
emergencies, but it is not the default production behavior. The fast path must
never treat guest details after a quote as a new room-fit question.

Every planned AI turn now logs a compact non-PII timing row:
`[aiagent] rebuilt turn { caseId, source, action, kind, sent, elapsedMs }`.
Use this in `pm2 logs hotels-backend` to separate fast-path latency from true
OpenAI latency.

The active low-cost model trial is `gpt-5.4-mini` for chatbot analysis/NLU,
with low reasoning effort. Keep the override in chatbot-specific env keys
(`OPENAI_CHATBOT_ANALYSIS_MODEL`, `OPENAI_CHATBOT_NLU_MODEL`) so broader
OpenAI jobs can keep their existing model quality.

The 2026-06-23 live Arabic receipt/email flow also added guardrails for the
common details line shape:

- optional email is mentioned in the details request and shown in the final
  review when supplied;
- receipt/confirmation-by-email questions answer directly and continue the
  reservation flow;
- Arabic guest-count words such as `شخصين` are recovered as adult count while
  still allowing OpenAI to decide intent;
- nationality recovery strips emails first and does not overwrite a valid
  nationality from unrelated email/receipt wording.

## 2026-06-23 Live Stale Reply Follow-Up

A live Zad Al Safa test showed two related edge cases:

- if the guest sent another message while OpenAI was still planning, the stale
  reply could be skipped without a reliable immediate retry;
- if a reserve-room case started with smalltalk, the booking context could make
  the bot ask for dates before answering the greeting naturally.

Current contract:

- stale sends mark the case queued and schedule a retry after the active planner
  clears;
- exact duplicate AI suppression uses a short window so legitimate repeated
  booking prompts are not hidden for minutes;
- smalltalk/greetings answer first unless the latest guest line itself contains
  booking details;
- if the guest chases the assistant after giving a booking detail, acknowledge
  the delay briefly and continue the booking step from recovered state;
- when the latest text contains a room capacity such as "room for 3 persons",
  room-fit rendering wins over a generic room-options answer.
- greeting-only or smalltalk-only openings must receive a warm reception
  greeting and one open-ended help question. They must not immediately ask for
  check-in dates, room type, phone, nationality, or booking details.
- public client support cases must always include a guest-visible first turn.
  If SSR or another public client omits `initialClientMessage`, the backend
  falls back to the cleaned `inquiryDetails` text so the AI is never scheduled
  against a case that only contains the system hold message.

`controllers/supportcase.js` also treats public `clientTag` values as
idempotency keys. If a browser retries the same guest message, the backend
returns the case without appending or scheduling that same client-tagged
message again.

Follow-up production monitoring found one remaining legacy scheduling path:
`controllers/supportcase.js` was still importing `aiagent/core/orchestrator.js`
for public client-message scheduling while `aiagent/index.js` used the rebuilt
engine. That could run the legacy planner alongside the rebuilt planner and pin
the Node process. Active support-case scheduling must import only
`aiagent/core/orchestrator_rebuilt.js`.

## Policy

Cancellation/refund defaults remain:

- 14+ days before check-in: free cancellation and full refund.
- 4-13 days before check-in: cancellation can be processed; hotel keeps one
  night and refunds the remainder.
- 3 days or less before check-in: non-cancellable and non-refundable under the
  general policy.

The answer should sound like hotel reception: "Based on the hotel's terms and
conditions..." Never say "I checked a document" or imply the assistant is
outside the hotel/support team.

## Verification Checklist

Before deployment:

- `node --check aiagent/core/countryCodes.js`
- `node --check aiagent/core/actions.js`
- `node --check aiagent/core/orchestrator_rebuilt.js`
- `node --check aiagent/index.js`
- `node --check components/SupportWidget.js` in `jannatbooking_ssr`
- Backend health check after restart.
- PM2 memory/CPU check for `hotels-backend`.
- Live smoke from the existing admin route:
  `/admin/customer-service?tab=active-client-cases&caseId=...`

Do not create a new admin monitoring route for this behavior.

## SSR Rating Close Flow

`jannatbooking_ssr/components/SupportWidget.js` now treats `ratingVisible` as a
full chat-window state. After the guest ends/closes the support case, the
message transcript and composer are hidden and the rating view occupies the
chat body until the guest submits or skips feedback.

Keep this behavior aligned with the old `jannatbooking_frontend` flow, but keep
the SSR visual styling in the SSR component. The rating screen should remain
localized, compact on mobile, and should not remount the reply composer while a
case is awaiting feedback.
