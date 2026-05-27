# AI Agent (Hotels – Makkah/Madinah)

## Current Production Contract - 2026-05-27

- The AI agent is B2C support only. B2B/internal chats must never trigger it.
- It mounts only when `AI_AGENT_ENABLED=true`; hotel/case/global switches still gate every reply.
- Janat/global AI switch, hotel owner activation, Jannat/XHotelPro platform activation, hotel `aiToRespond`, and support-case `aiToRespond` must all allow the reply.
- `AI_FORCE_RESPOND=true` is local QA-only and should not be used as production behavior.
- The writer reads the full support-case conversation before replying and should not ask again for information already supplied.
- Arabic customer-facing replies should address known clients respectfully as `أستاذ {first name}`, for example `أستاذ ناصر`.
- Tone is official, concise, warm, and useful. Brand must remain exactly `Jannat Booking`.
- The assistant may help with hotels near Al Haram, date-range pricing, payment troubleshooting, and reservation triage.
- Cancellation, refunds, existing-reservation mutation, and final booking confirmation are human handoff paths.
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
  - 5s greeting after case creation, context-aware (new reservation vs update).
  - 1.5s minimum delay for every reply.
  - If guest is typing (or typed within 800ms), agent **waits** and reschedules
    (max 30s).
- **Guard**: Replies only if `hotel.aiToRespond === true`; else emits
  `aiPaused`.
- **LLM fallback** (optional): set `OPENAI_API_KEY` to let the agent clarify
  ambiguous inputs (typos, mixed languages). Otherwise local extractors are
  used.
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
  4. Confirm name (or ask full name)
  5. Phone
  6. Nationality
  7. Email
- **Review & Confirm**:
  - Agent summarizes and asks to proceed.
  - On **Yes**: hand off to a Jannat Booking team member for verification,
    payment, and final reservation confirmation.
  - The AI does not directly create, cancel, refund, or mutate reservations in
    production support flow.
- **Languages**: English, Arabic (Fos7a/Egyptian/Saudi tone), Spanish, French,
  Urdu, Hindi with Islamic-friendly assistant names.

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
