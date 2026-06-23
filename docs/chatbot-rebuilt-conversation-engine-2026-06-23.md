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
`aiagent/core/orchestrator_rebuilt.js` now has a deterministic fast path before
the model for common hotel facts and simple booking continuation:

- room options, room descriptions, amenities, bus, location, distance, payment,
  reservation details, and policy questions;
- room-fit messages such as asking for a room for three guests;
- the next room/date quote step after the conversation already contains room
  type and stay dates.

Every planned AI turn now logs a compact non-PII timing row:
`[aiagent] rebuilt turn { caseId, source, action, kind, sent, elapsedMs }`.
Use this in `pm2 logs hotels-backend` to separate fast-path latency from true
OpenAI latency.

The active low-cost model trial is `gpt-5.4-mini` for chatbot analysis/NLU,
with low reasoning effort. Keep the override in chatbot-specific env keys
(`OPENAI_CHATBOT_ANALYSIS_MODEL`, `OPENAI_CHATBOT_NLU_MODEL`) so broader
OpenAI jobs can keep their existing model quality.

`controllers/supportcase.js` also treats public `clientTag` values as
idempotency keys. If a browser retries the same guest message, the backend
returns the case without appending or scheduling that same client-tagged
message again.

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
