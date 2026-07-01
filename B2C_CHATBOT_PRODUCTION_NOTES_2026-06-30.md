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
  - The same live case also showed that mild frustration such as "impossible, check again" should not immediately escalate. The escalation rule was tightened so AI keeps helping unless there is clear abuse, threats, severe/repeated anger, a sensitive complaint, or an explicit human/manager request.
- `6a4469c09cfa84dc6e6f942b` was a Codex-marked production API verification case for an Arabic initial message.
  - It opened with the edited guest message, not the default widget text.
  - The automatic AI scheduler replied in about 5.0 seconds.
  - The reply identified as the hotel reception/reservations team for Zad Ajyad.
  - The test case was deleted after verification.
- `6a4467f7b20693e523ba462f` later showed a false unavailable response after the guest changed dates.
  - Direct production pricing for Zad Ajyad double room from `2026-08-15` to `2026-08-21` returned available: 6 nights at 85 SAR/night, total 510 SAR.
  - The risk was stale conversation memory: if a guest changes only part of a previous stay, old check-out dates or old quotes must not be reused.
  - The orchestrator now clears stale `checkoutISO`, `quote`, Hijri date display text, and pending review state when the guest changes check-in, check-out, room type, room count, or guest counts.
  - The prompt also tells OpenAI that "check again", "impossible", or similar sales pushback should trigger a re-check when facts are known, not immediate escalation.
- `6a446a9e68269fb742c575b9` showed OpenAI being too cautious/redundant despite hotel facts being present.
  - The hotel facts included Safar offer guidance, Nusuk availability, bus details, and Haram distance.
  - The AI answered with "cannot confirm" style wording and repeatedly redirected to dates.
  - The prompt now requires the AI to review the full transcript and Known facts before every reply, answer the latest unresolved guest question first, avoid repeating the same request, and answer confidently when hotel facts explicitly include a service, offer, distance, or policy.
- `6a44755fd911792efe6cfd47` showed a quote-promise loop:
  - The guest supplied a double room, dates `2026-09-01` to `2026-09-11`, and two guests.
  - OpenAI replied that it would check availability/price, but did not return structured `checkinISO`, `checkoutISO`, `adults`, or action `get_quote`.
  - Direct quote verification showed the stay is available: 10 nights, total 860 SAR.
  - The prompt now forbids customer-facing "I will check now" replies unless OpenAI returns `get_quote` with structured facts.
  - The orchestrator now guards these replies: if a checking/quote promise is about to be sent without a tool action, it asks OpenAI for a structured correction first. If facts are still missing, it asks the guest for the one missing detail instead of sending fake progress.
  - The same case also showed that hotel-fact questions such as "is the hotel listed on Nusuk?" must override pending quote flow.
  - The prompt now says latest hotel-fact questions about Nusuk, bus/shuttle, cancellation/refund policy, distance/location, amenities, meals, parking, Wi-Fi, or hotel services must be answered from Hotel facts first.
  - A safety guard prevents `get_quote` from taking over fact-only questions. If OpenAI still tries, the orchestrator requests a corrected OpenAI reply and falls back to exact hotel facts only if needed.
  - The case then showed OpenAI could write a booking review as plain text, which meant no operational buttons appeared in the guest widget.
  - The prompt now says OpenAI must not write final booking reviews as normal replies. It should return `send_review`; the orchestrator sends the official review with buttons.
  - The official review now always includes the exact room display name/type, dates, nights, guest count, name, phone, nationality, email status, and total.
  - Optional email remains optional. If OpenAI asks for email, the orchestrator can attach a "continue without email" quick reply so the flow does not get stuck.
  - A later live turn showed a guest can ask for the review and then send a short nudge such as "يا أميرة؟" before the delayed turn completes.
  - Review requests now go directly to the orchestrator review action, and a short nudge immediately after an unanswered review request still produces the official review instead of a generic "I am here" reply.

## PMS And Server Health Notes

- During earlier production QA, the AI turn path caused backend memory to grow sharply after OpenAI/worker fallback attempts.
- AI was temporarily kept off with `AI_AGENT_ENABLED=false` while investigating PMS safety.
- After the worker path answered `6a4467f7b20693e523ba462f` in about 3.9 seconds with stable memory, production was re-enabled with `AI_AGENT_ENABLED=true`.
- A fresh Codex-marked initial-message case also replied automatically in about 5.0 seconds and was deleted.
- When making future AI changes, run one controlled chat while watching:
  - PM2 memory and CPU
  - `sensors`
  - PMS support-case/reservation pages
  - OpenAI response time
  - whether the worker/fallback path increases backend RSS

## Safe Production Environment Used

- `AI_AGENT_ENABLED=true`
- `OPENAI_CHATBOT_WRITER_MODEL=gpt-5.4-mini`
- `OPENAI_CHATBOT_MODEL=gpt-5.4-mini`
- `OPENAI_CHATBOT_ANALYSIS_MODEL=gpt-5.4-mini`
- `OPENAI_CHATBOT_NLU_MODEL=gpt-5.4-mini`
- `OPENAI_CHATBOT_TIMEOUT_MS=12000`
- `OPENAI_CHATBOT_MAX_PROMPT_CHARS=14000`
- `AI_PLAN_USE_WORKER=false`
- `AI_PLAN_WORKER_TIMEOUT_MS=12000`
- `AI_PLAN_WORKER_HEAP_MB=384`
- `AI_IDLE_AUTO_CLOSE_MS=300000`

Note: `AI_PLAN_USE_WORKER=false` is currently preferred for this slim OpenAI-led B2C flow. The worker subprocess path timed out during live review testing and briefly raised backend memory; direct turns stayed around 270 MB after restart.

## Legacy Env Cleanup

- On 2026-06-30, unused legacy AI plan env lines were removed from production `.env` after verifying the slim OpenAI-led orchestrator does not read them.
- Removed legacy/confusing keys:
  - `AI_PLAN_MAX_CONCURRENT`
  - `AI_PLAN_QUEUE_NOTICE_MS`
  - `AI_PLAN_WORKER_OLD_SPACE_MB`
  - `AI_PLAN_MIN_AVAILABLE_MEMORY_MB`
  - `AI_PLAN_MEMORY_PER_ACTIVE_MB`
  - `AI_PLAN_LOAD_LIMIT_PERCENT`
  - malformed `nAI_PLAN_TEMP_*` line
  - `AI_PLAN_WORKER_EARLY_FALLBACK_MS`
- The current path still has per-case protection through the in-memory `activeTurns` set, so the same case cannot receive overlapping AI turns. Different support cases are not capped by those removed env lines.

## Cleanup Rule

- Remove only Codex QA support cases with strict Codex markers, such as:
  - `clientName` beginning with `Codex QA`
  - `clientContact` containing `codex.qa`
  - `sourcePage`, `sourceUrl`, or conversation `clientTag` containing `codex_b2c_prod_qa`
- Do not delete real guest/support cases or Ahmed manual test cases unless explicitly requested.
