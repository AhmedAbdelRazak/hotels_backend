# Chatbot Direct-Booking Discount + 27 Scenario QA - 2026-07-05

## Purpose

Guests are asking for discounts, especially for Zad Ajyad. The B2C chatbot now presents available quote prices as a direct-reception booking offer:

- Original price = final quote / 0.75.
- Final quote = 25% direct-booking discount.
- Original price is emitted as `<s class="message-price-old">...</s>`.
- Final price is emitted as `<strong class="message-price-new">...</strong>`.
- Both prices stay on the same row, followed by a direct-booking discount badge.
- If asked why, the answer is: direct booking through reception has no middleman commission.

## Code Changes

- `aiagent/core/orchestrator.js`
  - Added deterministic direct-booking discount helpers.
  - Quote fallbacks and quote tool-result summaries include exact old/new display lines.
  - Quote writer validation rejects available quotes that omit the `<s>` original price or green final price markup.
  - Budget/discount objection reply is shorter and no longer repeats the long multi-choice script.
  - Zad Ajyad value pitch mentions Ajyad as a lively area with restaurants and a walk suitable for guests comfortable walking.
  - Guest quiet time default increased from 2s to 3s.
  - AI turn concurrency default reduced from 2 active turns to 1 active turn.
  - Worker heap default increased from 384 MB to 512 MB.
  - Guarded unlabeled booking-name parsing so hotel/service questions, especially bus questions, are not saved as guest names.
  - Added one-room correction support for phrasing like "غرفة ثلاثية واحدة".

- Public Jannat widget (`jannatbooking_ssr/components/SupportWidget.js`)
  - Safely parses only the known price tags/classes and renders them as React elements.
  - Does not use `dangerouslySetInnerHTML`.
  - Adds red old price, green final price, and direct-booking badge styling.

- PMS customer-service chat (`hotels_frontend/src/AdminModule/CustomerService/ChatDetail.js`)
  - Safely parses the same price tags/classes.
  - Staff view now matches the guest-facing discount presentation.

## Scenario Matrix

The previous live matrix remains the 22 scenarios from the July 3 hardening document.

Five new support-case scenarios added for the next full live QA round:

23. Available quote displays 25% direct-booking discount with `<s>` old price and green final price.
24. Budget/discount objection stays concise, explains no middleman commission, and avoids repeated unnecessary options.
25. Ambiguous "03 غرفة ثلاثية" can be corrected to one triple room for three guests.
26. Combined name/nationality/phone details preserve the already-quoted room setup and total.
27. Hotel-service detour such as a bus question is answered as a fact and never saved as the guest full name.

## Local Verification

Run on 2026-07-05:

- `node --check aiagent/core/orchestrator.js`
- `node --check scripts/chatbotRegressionChecks.js`
- `npm run test:chatbot`
  - Result: `PASS 22 chatbot regression checks`
- `node --check jannatbooking_ssr/components/SupportWidget.js`
- `npm run build` in `jannatbooking_ssr`
- `node --check hotels_frontend/src/AdminModule/CustomerService/ChatDetail.js`
- `npm run build` in `hotels_frontend`

Notes:

- The deterministic harness is now 17 previous checks + 5 new support-case checks = 22 local checks.
- The next full live QA matrix is 27 scenarios: the prior 22 live scenarios + the 5 new support cases above.
