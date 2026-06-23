# AI Agent (Hotels – Makkah/Madinah)

## Production Stabilization Runbooks

- `../docs/chatbot-rebuilt-conversation-engine-2026-06-23.md` is the current
  active chatbot source of truth. The active planner is
  `core/orchestrator_rebuilt.js`; the older `core/orchestrator.js` is legacy
  reference code unless deliberately wired again.
- `../docs/chatbot-production-stabilization-2026-06-22.md` documents the June 21/22
  production chatbot stabilization: memory pressure, restart recovery,
  repeated date/nationality prompts, nationality-vs-language routing, bad
  numeric/date names, idle close, typing/sending UX, verification, and future
  guardrails.
- `../docs/chatbot-direct-answer-and-multilingual-parsing-2026-06-21.md` documents
  direct-answer priority, multilingual parsing, Islamic greeting, pause intent,
  final reservation action, and date memory contracts.
- `../docs/chatbot-price-date-guard-2026-06-22.md` documents the price/date prompt
  loop guard.
- `../docs/chatbot-post-booking-close-and-typing-2026-06-22.md` documents
  post-booking close, rating UX, and typing behavior.
- `../docs/chatbot-admin-monitor-and-latency-2026-06-23.md` documents the
  admin support-case AI monitor, repeat-price/details fast paths, shorter
  chatbot timeouts, and the optional-email flow reduction.

## Current Production Contract - 2026-06-06

- The AI agent is B2C support only. B2B/internal chats must never trigger it.
- It mounts only when `AI_AGENT_ENABLED=true`; hotel/case/global switches still gate every reply.
- Janat/global AI switch, hotel owner activation, Jannat/XHotelPro platform activation, hotel `aiToRespond`, and support-case `aiToRespond` must all allow the reply.
- `AI_FORCE_RESPOND=true` is local QA-only and should not be used as production behavior.
- The writer reads the full support-case conversation before replying and should not ask again for information already supplied.
- Arabic customer-facing replies should address known clients respectfully as `أستاذ {first name}`, for example `أستاذ ناصر`.
- Respectful addressing should not be repeated at the start of every message.
  Use it for greetings, apologies, confirmations, reservation reviews, and
  re-engagement after pauses. Known female guests use `أستاذة {first name}`;
  known male guests use `أستاذ {first name}`; unknown gender should stay neutral.
- Visible CSR names in the default pool are female. In Arabic, the assistant's
  self-reference must be feminine or neutral (`أنا معك`, `أتابع معك`,
  `أنا موجودة معك`) and must not use masculine `أنا موجود`. Keep CSR gender
  separate from guest honorific gender in every language with gendered forms.
- Tone is official, concise, warm, and useful. Brand must remain exactly `Jannat Booking`.
- The assistant may help with hotels near Al Haram, date-range pricing, payment troubleshooting, and reservation triage.
- Cancellation, refunds, and existing-reservation mutation are human handoff paths.
- New-reservation finalization can be completed by the AI only after the guest explicitly confirms the review summary and provides mandatory full name, phone, nationality, adults count, and children count. Email is optional after those required details. The AI-created reservation must use inventory validation, save an availability snapshot, and enter the internal hotel pending-confirmation workflow while the guest-facing copy says the reservation is confirmed.
- Human handoff paths are real escalations: the support case is saved with
  `escalationStatus=active`, `escalationSource=ai`, and an escalation reason.
- If the orchestrator decides the request is outside available context or should
  be reviewed before answering, it can choose `human_escalation` and stop AI.
- Admin Customer Service has an escalated cases tab. Staff must mark
  `escalationStatus=addressed` after resolving the escalation.
- AI replies are saved with `support@jannatbooking.com`, `userId=jannat-ai-support`, and the case `aiResponderName`.
- Admin/staff messages pause AI through `aiToRespond=false`, `aiPausedAt`, `humanTakeoverAt`, and `aiHandoffReason`.
- SendGrid support-case email notification failures must not fail a saved support case.

- **Delays**:
  - Greeting and replies use configurable human-style pacing.
  - Normal short replies should show the AI responder typing and land around 2-4 seconds after the guest message when deterministic context is enough; longer replies can take longer based on length and verified-context lookups.
  - Progress acknowledgements must go through the same humanized send path, not instant direct database appends.
  - If guest is typing (or typed within 800ms), agent **waits** and reschedules
    (max 30s).
- **Guard**: Replies only if `hotel.aiToRespond === true`; else emits
  `aiPaused`.
- **LLM fallback** (optional): set `OPENAI_API_KEY` to let the agent clarify
  ambiguous inputs (typos, mixed languages). Otherwise local extractors are
  used.
- **Model latency**:
  - Default chatbot model is `gpt-5.5`, configurable through the central OpenAI model env keys.
  - GPT-5-style chatbot calls use `OPENAI_CHATBOT_REASONING_EFFORT=medium` by default for quality-first live-chat behavior.
  - `AI_INSTANT_PROGRESS_ENABLED=false` is preferred in production so guests receive one thoughtful typed answer instead of extra bot-like progress messages.
  - Detailed AI step logs are off unless `AI_AGENT_DEBUG=true`, so production PM2 logs do not include guest names, phones, or slot state during normal operation.
- **Warm CS opening**: Agent reads `inquiryAbout` from SupportCase as private
  context, but still opens like a helpful hotel support agent. Even when a
  new-reservation intent is known, the first reply should ask how it can help
  and may gently confirm the guest wants to reserve a room; it must not open by
  asking for check-in/check-out dates.
- **Direct room answers**: When a guest asks whether the hotel has a room for a
  capacity or room type, the answer should first confirm the fit using real
  `roomCountDetails` facts in a natural hospitality/sales tone, then invite dates
  only as the next step for availability and price.
- **Room descriptions and amenities**: The writer context includes compact room
  descriptions, translated descriptions, amenities, views, extra amenities, room
  size, beds count, and gender suitability from hotel settings. Use those facts
  directly, translate/adapt them professionally, and keep room descriptions to
  1-2 short natural lines unless the guest asks for full details. Say a detail
  is not currently shown instead of inventing missing amenities.
- **Unsupported answers**: For ordinary unsupported broad questions, say the
  detail is not confirmed/verified in this chat and pivot back to the relevant
  hotel or reservation topic. Do not turn this into an email deflection unless a
  separate sensitive/safety path explicitly requires it.
- **Pricing**:
  - Middle-day `price = 0` ⇒ **blocked**.
  - Missing calendar day ⇒ `basePrice`.
  - `basePrice` blank/0 ⇒ `defaultCost`.
  - Commission = `room.roomCommission || hotel.commission || 10`.
- **Flow**:
  1. Understand and answer the guest's latest question first
  2. Room type/capacity if the guest asks about it first
  3. Check-in and check-out dates after the guest is ready for availability/price
  4. Review quote and ask the guest to confirm, with localized Confirm / Something is wrong quick replies when the public widget can render them
  5. Ask once, in one message, for full name as in passport, phone, nationality, adults count, and children count
  6. Move to the final create prompt once mandatory details are present. Optional email can still be captured if the guest sends it, but it should not create an automatic extra stop in the normal flow.
- **Review & Confirm**:
  - Agent summarizes and asks to proceed.
- On **confirm** after the review, the AI collects missing guest details and creates the reservation through `aiagent/core/actions.js`.
  - The saved reservation uses `booking_source="AI Chat"`, `payment="Not Paid"`, `pendingConfirmation.status="pending"`, `pendingConfirmation.clientVisibleStatus="confirmed"`, and `availabilitySnapshot.source="ai_chat_reservation_create"`.
  - Keep `booking_source="AI Chat"` in storage for platform auditing. Hotel-management responses mask this source to `Jannat Employee`; only platform /admin views and configured SUPER ADMIN/platform admin users outside hotel-management should see the real AI source.
  - The confirmation number follows the normal PMS reservation pattern: a unique 10-digit value checked against saved and pending/uncompleted reservations. Do not use AI-only 6-digit numbers.
  - The guest receives a friendly confirmed response with the confirmation number, details link, and payment link. Internally the hotel team still reviews the pending-confirmation reservation.
  - If inventory is no longer available or creation fails, the AI escalates to human support with `aiHandoffReason=reservation_finalize_failed`.
- **Dates**:
  - The chatbot accepts Gregorian/Miladi and Hijri date ranges.
  - Hijri ranges such as `20 ذو الحجة 1447 إلى 22 ذو الحجة 1447` are converted to Gregorian ISO for pricing/reservation storage while keeping the Hijri range in `dateRaw` so replies can mention both calendars.
- **Languages**: English, Arabic, Spanish, French,
  Urdu, Hindi with Islamic-friendly assistant names.
  - The active response language follows the latest clear guest language. For example, if the frontend preference is English but the guest writes Arabic or French, the bot answers in Arabic or French rather than asking permission to switch.
  - The frontend should expose a single Arabic option; the orchestrator infers Arabic dialect/tone from the guest's actual wording.

  ## Debug API

- `GET /api/aiagent/health` → `{ ok, openai, model }`
- `GET /api/aiagent/state/:caseId` →
  `{ ok, aiAllowed, hotel, case, state, conversation }`
- `POST /api/aiagent/clear/:caseId` → `{ ok }`
- `GET /api/aiagent/preview-quote?caseId=&checkin=&checkout=&roomType=&displayName=`
  → quote preview (pricing rules applied)
- `GET /api/aiagent/reservation-by-confirmation/:cn` → loads a reservation by
  confirmation number

These endpoints are read‑only (except `clear`) and help test flows before wiring
to UI.

## ENV
