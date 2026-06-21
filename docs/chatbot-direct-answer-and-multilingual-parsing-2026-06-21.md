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
- Company EIN/tax/legal-document requests are a fixed confidentiality policy.
  The chatbot may explain the support boundary, but must not reveal, quote,
  link, summarize, or search confidential partner/company documents.
- Do not create production support-case or reservation test documents unless the
  owner explicitly asks for live testing.
