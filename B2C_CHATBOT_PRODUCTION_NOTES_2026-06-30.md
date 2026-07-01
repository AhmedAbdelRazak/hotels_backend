# B2C Chatbot Production Notes - 2026-06-30

## Current Architecture

- OpenAI is the conversation lead for B2C guest-facing replies.
- The orchestrator is intentionally slim and should only handle exact tools/actions:
  - exact availability and pricing quote
  - booking review buttons
  - reservation creation
  - reservation update/cancellation flows
  - case escalation/closure
- The orchestrator should not write normal customer-facing sales/support copy except for action-owned review/confirmation messages.
- New chat openings now go through OpenAI:
  - `new_chat_intro` is used only when no guest request exists yet.
  - `new_chat_first_guest_message` is used when the guest already sent one or more messages before the first AI reply.
  - OpenAI is instructed to read the full transcript, not only the latest message, so a booking request followed by a greeting is handled together.

## Prompt Rules Added

- Match the guest's language and dialect naturally.
- Address agent and guest names in the chosen language when natural.
- Never ask "which year" just because a date year is omitted.
- Dates without a year should resolve to the next future occurrence.
- Hijri dates should be converted internally to Gregorian/Melady ISO, while Arabic replies/reviews can show both Hijri and Melady when the guest used Hijri.
- If a guest explicitly gives past dates, politely flag the issue and ask for intended future dates.
- Do not create quick-reply buttons for free-text fields such as dates, year, name, phone, nationality, email, or open questions.
- If the guest is angry, disrespectful, asks for a human, or the situation is risky, escalate.
- For polite off-topic comments, answer briefly when possible and return naturally to helping with the stay.
- Use Islamic-friendly manners naturally without overdoing it.

## Hotel Context Added

- The OpenAI prompt now receives compact hotel facts:
  - hotel identity, address, services, distances, and policy Q&A
  - active room names, Arabic names, descriptions, amenities, views, extra amenities, and capacities
  - room meanings such as double/triple/quad/family suitability
  - compact public room offers and monthly packages
- Full calendars are still not sent to OpenAI.
- Public offer fields sent to OpenAI:
  - offer name
  - public offer dates
  - public offer price
  - monthly package name/dates/Hijri dates/public package price
- Internal fields are not sent to OpenAI:
  - root price
  - cost
  - commission
  - margins
  - internal inventory implementation details

## Ticket Lessons

- `6a446280b1a2b3da462d431d` showed two important issues:
  - the bot sent a free-text date quick-reply button, which is now suppressed
  - the bot asked which Hijri year, which is now discouraged in the prompt
- The same ticket also confirmed that Hijri facts can be stored correctly:
  - check-in Gregorian: `2026-09-01`
  - check-out Gregorian: `2026-09-08`
  - check-in Hijri: `18 Rabi al-Awwal 1448`
  - check-out Hijri: `25 Rabi al-Awwal 1448`
- `6a4467f7b20693e523ba462f` showed that the SSR widget and backend do save a real initial guest message when the guest edits the chat text before opening the case.
  - Initial guest message: "wanted a double room for me and my son"
  - The default/generated widget message is filtered out and not treated as a real guest request.
  - The no-response cause was operational: production had `AI_AGENT_ENABLED=false`, so the scheduler was not running.
  - A forced single worker run answered the case in about 3.9 seconds and kept backend memory stable.
  - The prompt was tightened so first AI replies identify as the hotel reception/reservations team, not generic Jannat Booking support.

## PMS And Server Health Notes

- During production QA, the AI turn path caused backend memory to grow sharply after OpenAI/worker fallback attempts.
- To protect PMS operations, production currently keeps `AI_AGENT_ENABLED=false`.
- Backend, PMS, and SSR services should remain healthy with AI disabled.
- Before re-enabling AI in production, run one controlled chat while watching:
  - PM2 memory and CPU
  - `sensors`
  - PMS support-case/reservation pages
  - OpenAI response time
  - whether the worker/fallback path increases backend RSS

## Safe Production Environment Used

- `AI_AGENT_ENABLED=false`
- `OPENAI_CHATBOT_WRITER_MODEL=gpt-5.4-mini`
- `OPENAI_CHATBOT_MODEL=gpt-5.4-mini`
- `OPENAI_CHATBOT_ANALYSIS_MODEL=gpt-5.4-mini`
- `OPENAI_CHATBOT_NLU_MODEL=gpt-5.4-mini`
- `OPENAI_CHATBOT_TIMEOUT_MS=12000`
- `OPENAI_CHATBOT_MAX_PROMPT_CHARS=14000`
- `AI_PLAN_USE_WORKER=true`
- `AI_PLAN_WORKER_TIMEOUT_MS=12000`
- `AI_PLAN_WORKER_HEAP_MB=384`
- `AI_IDLE_AUTO_CLOSE_MS=300000`

## Cleanup Rule

- Remove only Codex QA support cases with strict Codex markers, such as:
  - `clientName` beginning with `Codex QA`
  - `clientContact` containing `codex.qa`
  - `sourcePage`, `sourceUrl`, or conversation `clientTag` containing `codex_b2c_prod_qa`
- Do not delete real guest/support cases or Ahmed manual test cases unless explicitly requested.
