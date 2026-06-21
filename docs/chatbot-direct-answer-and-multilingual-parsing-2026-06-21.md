# Chatbot Direct Answer and Multilingual Parsing - 2026-06-21

## Scope

This note documents the current production chatbot contract for direct guest
questions, miscellaneous hotel questions, multilingual wording, number/date
parsing, and light emoji behavior.

The goal is simple: when the guest asks a concrete question, the chatbot must
answer that request first before moving the reservation flow forward.

## Primary Code Paths

- `aiagent/core/orchestrator.js`
  - Main turn routing, direct-request guard, hotel fact answers, contact answers,
    direct hotel relationship answers, payment/discount routing, and writer rules.
- `aiagent/core/scriptSignals.js`
  - Shared semantic signal layer for multilingual, transliterated, mixed-script,
    and misspelled intent words.
- `aiagent/core/numberWords.js`
  - Shared written-number normalization for supported languages.
- `aiagent/core/nlu.js`
  - Date parsing, room/capacity parsing, and NLU fast paths.

## Direct-Answer Rule

The orchestrator now treats direct requests as first-class routing events.

If the guest asks for one of these, the chatbot must answer it first:

- Hotel phone, WhatsApp, reception, manager, responsible person, or contact.
- Whether the agent is working directly with the hotel or hotel reception.
- Hotel distance from Al Haram.
- Hotel address, location, or map/location wording.
  - If selected hotel coordinates are valid, include a labeled Google Maps
    driving-directions link from the hotel's exact location to Al Haram.
  - The coordinates use the database GeoJSON order `[longitude, latitude]`; the
    Google Maps origin must be sent as `latitude,longitude`.
- Hotel bus/shuttle/transport to Al Haram.
- Hotel room facts, room capacity, room type, or whether a room exists.
- Hotel amenities.
- Company EIN, tax ID, VAT number, legal paperwork, registration papers,
  licenses, certificates, or other confidential company/partner documents.
- Payment or payment-link help.
- Discount or offer questions.
- Broad support questions that can be answered from verified context.

The chatbot must not ask for check-in/check-out dates, room type, phone, email,
or confirmation number before answering the concrete request, unless the direct
request itself cannot be answered without that missing information.

## Miscellaneous Question Examples

These guest questions and their close derivatives are expected to answer first:

- "How far is the hotel from Al Haram?"
  - Answer from verified selected hotel distance facts.
- "Can you send me the hotel location?"
  - Answer with the written address when available.
  - Include the exact Google Maps driving route from the hotel coordinates to Al
    Haram when valid hotel coordinates exist.
  - Do not invent map links from a text address when coordinates are missing or
    still the default `[0, 0]`.
- "Do you guys have a bus?"
  - Answer from `hasBusService` and `busDetails`.
- "Can I get a phone number to talk directly to the hotel?"
  - Answer the contact request with the approved reception/live-chat wording.
  - Do not expose internal hotel, owner, manager, account, or training-example
    phone numbers.
- "Are you working directly with Hotel X?"
  - Answer yes in the guest language, using the meaning:
    "Yes sir, I work directly with the Hotel X reception and reservations team."
- "Can you give me your company EIN or official documents?"
  - Answer professionally that support/reception chat cannot provide confidential
    company paperwork, tax IDs, registration papers, licenses, or internal
    documents.
  - Explain that after a reservation and arrival at the hotel, the guest may ask
    the manager in person, and management can review what can be shown through
    the proper official channel.
  - Do not search stored/uploaded documents or expose partner paperwork.

The same behavior applies to derivatives such as:

- "Are you official?"
- "Are you authorized by the hotel?"
- "Are you connected with reception?"
- "Do you work with reservations?"
- "Can I speak to the hotel?"
- Arabic, Spanish, French, Urdu, Hindi, Indonesian, Malay, romanized, or
  mixed-script versions of the same intent.

## Direct Request Guard

`directGuestRequestKind()` classifies direct requests before normal booking
flow can ask for missing reservation details.

`tryAnswerDirectGuestRequest()` handles the direct request and returns early.
It is called:

- Before normal NLU slot collection.
- After NLU has added more context.
- Before late fallback booking/date-question logic.

This layered placement protects against both deterministic and LLM planner
misclassification.

## Patient Escalation Rule

The chatbot should not escalate ordinary guest confusion immediately.

- Rude/abusive messages still pause AI and escalate immediately.
- Ordinary repeated questions escalate only after the same unresolved question is
  asked three or more times in the same support case.
- Repeat detection uses normalized semantic keys for contact, location,
  distance, bus, direct-hotel relationship, confidential-document, payment,
  discount, amenity, room, and broad support questions.
- Confirmation replies, phone/email-only answers, greetings, patient "take your
  time" replies, and normal booking details are not counted as repeated
  questions.

## Availability Recovery

When a requested room type has no priced availability for the chosen dates, the
chatbot should try to solve the booking before asking the guest to start over.

- First offer one best active alternative room type for the same hotel and same
  date range.
- Prefer a natural upsell path, such as double room to triple or quad, and sell
  the benefit briefly without flooding options.
- If no other room type is open for the same dates, offer one nearby date option
  for the same requested room type.
- Store the pending option in case state and only switch room/date slots after
  the guest accepts.
- If the guest declines, types a different room type, or sends new dates, check
  that new path instead of repeating the unavailable answer.

## Multilingual and Mixed-Script Signals

`scriptSignals.js` provides reusable semantic categories instead of one-off
hardcoded replies. It recognizes intent families such as:

- `location`
- `distance`
- `bus`
- `phone`
- `whatsapp`
- `contact`
- `confirmation`
- `reservation`
- `payment`
- `confidentialDocument`
- `direct`
- `workWith`
- `hotel`
- `reception`

This covers native script, romanized text, mixed language, Arabic-script English
loanwords, common misspellings, and code-switching.

Examples:

- Arabic-script "location" wording such as `\u0644\u0648\u0643\u064a\u0634\u0646`.
- Arabic-script "WhatsApp" variants such as `\u0648\u0627\u062a\u0633\u0627\u0628`
  and `\u0648\u062a\u0633\u0627\u0628`.
- Arabic-script "confirmation" variants such as
  `\u0643\u0648\u0646\u0641\u0631\u0645\u064a\u0634\u0646`.
- Spanish/French/Indonesian/Malay/Hindi/Urdu and romanized variants for direct,
  reservation, payment, contact, and hotel terms.
- Company paperwork variants such as EIN, tax ID, VAT, legal documents,
  registration papers, licenses, certificates, Spanish/French/Indonesian/Malay
  equivalents, and Arabic-script loanwords for documents/tax/license.

## Phone Versus Confirmation Safety

Phone and WhatsApp context is checked before treating a numeric value as a
reservation confirmation number.

This prevents messages like "my WhatsApp is 15555550123" from being handled as
"confirmation number 15555550123".

Relevant behavior:

- `confirmationLooksLikePhoneInText()` uses contact/phone/WhatsApp semantic
  signals around the number.
- `confirmationFromText()` rejects confirmation candidates that look like the
  guest's phone number in context.
- `latestKnownConfirmation()` also avoids phone-context candidates.

## Number and Date Parsing

`numberWords.js` normalizes written numbers before date, room, adult, child, and
guest-count parsing.

Supported examples include:

- English: "twenty one July to twenty five July 2026".
- Spanish: "veintiuno de julio al veinticinco de julio 2026".
- French: "vingt et un juillet au vingt cinq juillet 2026".
- Indonesian/Malay: "dua puluh satu juli sampai dua puluh lima juli 2026".
- Arabic digits and Arabic written counts.
- Hindi/Urdu romanized and script-based counts/months.

Existing numeric formats remain supported:

- `2026-07-21 to 2026-07-25`
- `21/07/2026 to 25/07/2026`
- `21.07.2026 to 25.07.2026`

## Emoji Rule

The chatbot may use at most one tasteful emoji only when it naturally fits a
warm, excited, thankful, or reassuring moment.

The chatbot must not use emojis in:

- Payment replies.
- Cancellation or policy replies.
- Error replies.
- Confirmation-number replies.
- Confirmation/link delivery replies.
- AI identity or official relationship disclosure replies.

Emoji use should be occasional, not constant.

## Production Validation Used

Validation was intentionally lightweight and did not create live chatbot test
documents or reservations.

Checks used:

- `node --check aiagent/core/orchestrator.js`
- `node --check aiagent/core/nlu.js`
- `node --check aiagent/core/numberWords.js`
- `node --check aiagent/core/scriptSignals.js`
- Focused local parser assertions for:
  - Arabic-script location/WhatsApp/confirmation signals.
  - Spanish/French/Arabic/Indonesian/Hindi written numbers.
  - Room capacity mapping from written guest counts.
  - ISO, slash, dot, English, Spanish, French, Indonesian, Hindi, and Arabic
    date ranges.
- Production PM2 health checks.
- Backend HTTP 200 check.

## Operational Notes

- Do not replace the direct-request guard with prompt-only instructions.
  Deterministic routing is required so the chatbot cannot drift into asking
  date questions for direct guest requests.
- Keep new wording variants in `scriptSignals.js` or `numberWords.js` when they
  are reusable semantic patterns.
- Avoid one-off response hardcoding unless the behavior is a true fixed policy.
- Keep availability recovery deterministic: one best same-date room alternative
  first, then one close-date fallback only if no same-date room type is open.
- Keep repeated-question escalation deterministic at the three-repeat threshold;
  do not replace it with prompt-only instructions.
- Company EIN/tax/legal-document requests are a fixed confidentiality policy.
  The chatbot may explain the support boundary, but must not reveal, quote,
  link, summarize, or search confidential partner/company documents.
- Do not create production support-case or reservation test documents unless the
  owner explicitly asks for live testing.
- Google Maps location/directions links should be rendered as readable chat
  links, not as full raw URLs. In SSR this is handled by the support widget link
  renderer.

## Responsive Follow-Up and SSR Chat Polish

Additional tightening added:

- The orchestrator refuses to run a new planner pass for a guest turn that
  already has an AI reply after it in the conversation. This prevents queued or
  delayed turns from re-answering the same guest message with different wording.
- The planner also has a top-level per-case async lock, acquired before policy
  checks or hotel lookup, so concurrent socket/HTTP scheduled turns cannot enter
  the same support case together before the in-memory turn state is ready.
- AI message saving has a second guard for stale planners: if the latest guest
  turn was already answered by another pass, the save is cancelled before it can
  append another assistant bubble.
- Queued turns are now consumed only when the latest customer message is newer
  or the current turn is still genuinely unanswered. Otherwise the stale queue
  is dropped after the successful reply.
- Idle chat handling remains lightweight and guest-friendly: one follow-up only
  after 15 seconds of true silence, then automatic read/close only after 5
  minutes of inactivity. There is no second reminder. Guest typing counts as
  activity, so the reminder and close both defer while the guest is composing.
  The reminder says there is no rush and, when possible, references the active
  booking context instead of asking a generic "are you there" question.
- Boundary/contact replies such as hotel-phone requests do not schedule idle
  nudges. They preserve the active booking wait state so the agent does not feel
  lost after answering a direct request.
- If the guest complains that the agent is rushing, lost, repeating itself, or
  ignoring already-shared details, the bot uses a deterministic recovery reply:
  apologize briefly, keep the active request, and ask only for the true missing
  next detail.
- Each support case is treated as self-contained by default. If a guest asks to
  resume or complete an old chat, the bot explains the security/privacy boundary
  warmly, thanks the guest for patience, reassures them it is fine to start
  fresh, and asks for a short current-chat summary so the sale/support can keep
  moving.
- Each guest turn records whether an AI reply was actually saved. If a cooldown
  branch would leave the guest without an answer, the orchestrator sends one
  short contextual follow-up in the active language.
- Missing-date, missing-room, and unclear-proceed states now use contextual
  follow-ups instead of silent returns when the same question was asked recently.
- "Not now", "later", and similar decline turns pause quote/proceed nudges for a
  short window, so later factual questions are answered without sales pressure.
- Stored hotel distance values such as `56 min` are normalized before display,
  so Arabic, Spanish, French, Indonesian, Malay, English, Urdu, and Hindi chats
  do not show mixed raw `min` units.
- Explicit language-only turns such as "arabic", "Spanish please", or
  script-based equivalents switch the active response language and acknowledge
  the change. Mixed language plus service questions can still be answered in the
  newly requested language.
- SSR chat UI keeps links as readable underlined labels, wraps long textarea
  content on desktop and mobile, supports emoji text input, localizes the rating
  panel labels, and uses a visible red end-chat button with the existing
  post-reservation heartbeat state.
- Hotel, room, single-hotel, and deal CTAs use "Chat With Reception" in English
  and "تحدث مع الاستقبال" in Arabic.
