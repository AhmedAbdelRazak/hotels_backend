# AI Agent (Hotels – Makkah/Madinah)

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
  - On **Yes**: create reservation (or update if a confirmation number was
    recognized and loaded).
  - Reception is considered **notified** (field saved; backend staff sees
    instantly).
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
