# Chatbot OpenAI-First Engine - 2026-06-28

## Purpose

The B2C hotel chatbot now has a small OpenAI-first engine in
`aiagent/core/openaiFirstOrchestrator.js`. The previous rule-heavy planner in
`aiagent/core/orchestrator.js` is preserved as the legacy engine.

Default engine:

```env
AI_AGENT_ENGINE=openai_first
```

Legacy rollback:

```env
AI_AGENT_ENGINE=legacy
```

`AI_AGENT_USE_LEGACY=true` is also accepted as a rollback flag.

## Flow

1. The opening greeting is a short local reception/reservations greeting so a
   new chat does not spend heap on OpenAI before the guest asks a question.
2. The guest message waits for a short quiet window so replies do not overlap
   with typing.
3. The engine sends a structured OpenAI payload in this exact order:
   `reservationDetails`, `hotelDetails`, `conversation`, then request metadata.
   Reservation/update/cancellation/payment questions therefore see booking
   context first; hotel/room/Nusuk/bus/meal/distance/policy questions see the
   confirmed hotel facts next.
4. Calendar pricing arrays are not included in the first call.
5. OpenAI returns a strict JSON plan with the topic, language, whether pricing
   is needed, dates/room hints if present, guest details, and the next action.
6. If pricing is needed and dates are known, the backend computes pricing with
   `priceRoomForStay` / `listAvailableRoomsForStay`, then sends only the
   compact pricing summary back to OpenAI for the final guest-facing answer.
7. Reservation creation remains deterministic and only happens after the guest
   presses the `confirm_reservation` quick-reply button on the final review.

## Guardrails

- OpenAI owns wording, language matching, hotel question handling, bus/Nusuk
  policy answers, sales tone, and non-redundant phrasing.
- Backend owns availability math, room matching, reservation locks,
  confirmation numbers, duplicate prevention, Socket.IO events, and final
  reservation creation.
- Hotel details are grouped as identity, public presentation, room inventory
  summary, transportation/pilgrimage facts, and policies/rules so OpenAI gets
  the useful facts without a noisy admin document dump.
- AI hotel context caches compact calendar pricing rows only
  (`calendarDate`, `price`, `rootPrice`, `commissionRate`), and pricing helpers
  map only the requested stay dates. This keeps exact pricing while avoiding
  large temporary calendar maps during live chat turns.
- Email is optional. The engine can show a `skip_email` quick reply.
- Controller-level hard-coded quick trust replies are legacy-only so the
  default engine does not bypass OpenAI.
- Controller-level safety retries are also legacy-only. The OpenAI-first engine
  uses its own per-case timer map, active-turn lock, quiet window, and final
  latest-message check, so the public route should not stack an older retry
  loop beside it.
- The legacy scheduler and socket planner remain available without changing
  route/controller imports.

## Timing

Defaults can be tuned by environment:

```env
AI_OPENAI_FIRST_QUIET_MS=2000
AI_OPENAI_FIRST_TYPING_HOLD_MS=2000
AI_OPENAI_FIRST_TARGET_MIN_MS=3800
AI_OPENAI_FIRST_TARGET_MAX_MS=6200
AI_OPENAI_FIRST_MAX_TOTAL_MS=10000
AI_OPENAI_FIRST_CONTEXT_TURNS=60
AI_OPENAI_FIRST_WRITER_KIND=nlu
```

OpenAI request timeout remains centralized in `aiagent/core/openai.js` through
`OPENAI_CHATBOT_TIMEOUT_MS` / `OPENAI_TIMEOUT_MS` and is clamped to 1.5-6s.
The OpenAI-first engine defaults guest-facing prose calls to the fast chatbot
kind (`nlu`) for production latency and heap stability; set
`AI_OPENAI_FIRST_WRITER_KIND=writer` only after measuring memory and latency.

## Verification

Local checks used for this change:

```bash
node --check aiagent/core/openaiFirstOrchestrator.js
node --check aiagent/core/orchestrator.js
node --check controllers/supportcase.js
node -e "const mod=require('./aiagent/core/openaiFirstOrchestrator'); console.log(Object.keys(mod).sort().join(','));"
node -e "const mod=require('./aiagent/core/orchestrator'); console.log(Object.keys(mod).sort().join(','));"
git diff --check
```
