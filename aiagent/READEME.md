# AI Agent (Hotels – Makkah/Madinah)

## Current Production Contract - 2026-06-06

- The AI agent is B2C support only. B2B/internal chats must never trigger it.
- It mounts only when `AI_AGENT_ENABLED=true`; hotel/case/global switches still gate every reply.
- Janat/global AI switch, hotel owner activation, Jannat/XHotelPro platform activation, hotel `aiToRespond`, and support-case `aiToRespond` must all allow the reply.
- `AI_FORCE_RESPOND=true` is local QA-only and should not be used as production behavior.
- The writer reads the full support-case conversation before replying and should not ask again for information already supplied.
- Arabic customer-facing replies should address known clients respectfully as `أستاذ {first name}`, for example `أستاذ ناصر`.
- Tone is official, concise, warm, and useful. Brand must remain exactly `Jannat Booking`.
- The assistant may help with hotels near Al Haram, date-range pricing, payment troubleshooting, and reservation triage.
- Cancellation, refunds, and existing-reservation mutation are human handoff paths.
- New-reservation finalization can be completed by the AI only after the guest explicitly confirms the review summary and provides full name, nationality, phone, and email/skip. The AI-created reservation must use inventory validation, save an availability snapshot, and enter the internal hotel pending-confirmation workflow.
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
  - Normal short replies should show the AI responder typing and land around 3 seconds after the reply is ready; longer replies can take longer based on length.
  - Progress acknowledgements must go through the same humanized send path, not instant direct database appends.
  - If guest is typing (or typed within 800ms), agent **waits** and reschedules
    (max 30s).
- **Guard**: Replies only if `hotel.aiToRespond === true`; else emits
  `aiPaused`.
- **LLM fallback** (optional): set `OPENAI_API_KEY` to let the agent clarify
  ambiguous inputs (typos, mixed languages). Otherwise local extractors are
  used.
- **Model latency**:
  - Default chatbot model is `gpt-5-mini`, configurable through the central OpenAI model env keys.
  - GPT-5-style chatbot calls use `OPENAI_CHATBOT_REASONING_EFFORT=minimal` by default for live-chat latency.
  - Detailed AI step logs are off unless `AI_AGENT_DEBUG=true`, so production PM2 logs do not include guest names, phones, or slot state during normal operation.
- **No redundancy**: Agent reads `inquiryAbout` from SupportCase and starts the
  exact flow without “How can I help?”.
- **Pricing**:
  - Middle-day `price = 0` ⇒ **blocked**.
  - Missing calendar day ⇒ `basePrice`.
  - `basePrice` blank/0 ⇒ `defaultCost`.
  - Commission = `room.roomCommission || hotel.commission || 10`.
- **Flow** (one question each step):
  1. Check-in date
  2. Check-out date
  3. Room type (from `roomCountDetails`)
  4. Review quote and ask the guest to confirm
  5. Full name in English
  6. Nationality
  7. Phone
  8. Email, or `skip` if the guest does not want to provide one
- **Review & Confirm**:
  - Agent summarizes and asks to proceed.
- On **confirm** after the review, the AI collects missing guest details and creates the reservation through `aiagent/core/actions.js`.
  - The saved reservation uses `booking_source="AI Chat"`, `payment="Not Paid"`, `pendingConfirmation.status="pending"`, `pendingConfirmation.clientVisibleStatus="confirmed"`, and `availabilitySnapshot.source="ai_chat_reservation_create"`.
  - The guest receives a friendly created/confirmation response with the confirmation number, details link, and payment link. Internally the hotel team still reviews the pending-confirmation reservation.
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
