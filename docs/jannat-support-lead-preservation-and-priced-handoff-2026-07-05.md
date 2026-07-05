# Jannat Support Lead Preservation And Priced Handoff - 2026-07-05

## Issue

A guest entered through Jannat Booking, was handed to Zad Al Mashaer, received an unavailable quote for fixed dates, then said thanks. The hotel-side AI treated the thanks as a normal close signal after `quote_unavailable`, so the lead could be closed without Jannat Booking review.

## Root Cause

The initial Jannat Booking handoff worked. The missing behavior was after the handoff: hotel chat did not distinguish a normal hotel-origin unavailable quote from a Jannat-origin transferred lead. Therefore, fixed dates or a polite exit after an unavailable result could end the case.

## Fix

- Added Jannat-origin detection using `known.jannatPlatformTransfer`, the Jannat support snapshot, and the transparent `jannat_hotel_transfer` conversation action.
- Added a guard before the generic close-case path:
  - Jannat-transferred lead
  - previous AI action is `quote_unavailable` or `split_stay_quote_unavailable`
  - latest guest says dates are fixed, requests review, or politely exits
  - result: send a lead-preservation message, pause AI, mark escalation active, and route the case back to Jannat Booking support scope.
- Updated unavailable quote buttons for Jannat-transferred leads to show `Review same dates` / `راجعوا نفس التواريخ` instead of only alternative dates.
- Kept normal hotel-origin unavailable chats unchanged.

## Hotel-Origin Recovery To Jannat Support

Hotel-origin chats now recover to Jannat Booking only when the hotel has no available room type at all for the requested dates.

- If the requested room type is unavailable but another room type exists at the same hotel, the hotel bot keeps helping and can work alternatives.
- If every room type at that hotel is unavailable for those dates, the case is moved to Jannat Booking support scope with a visible transfer message.
- Jannat then searches the configured marketing hotels for a suitable option with availability.
- `JANNATSUPPORT_PRIORITY` remains first priority, currently expected to be Zad Ajyad in production.
- If the guest just came from the priority hotel, Jannat skips that same hotel and checks the next configured available hotel instead.
- If no configured alternative has confirmed availability, Jannat keeps the case for human review rather than recommending an unavailable hotel.

## Jannat Booking Pre-Handoff Pricing

Jannat Booking support now avoids unnecessary early handoff for booking/price/availability requests when key pricing details are missing.

- If dates are known but room/guest info is missing, Jannat asks only for room type or guest count.
- If room/guest info is known but dates are missing, Jannat asks only for check-in and checkout.
- If dates plus room type or inferred room are known, Jannat builds a quote before handoff.
- Jannat recommendation messages now include the same direct-booking discount markup:
  - `<s class="message-price-old">original price</s>`
  - `<strong class="message-price-new">discounted price</strong>`
  - discount badge on the same row.
- Zad Ajyad recommendations include sales context for the Ajyad area, nearby restaurants/services, walkability to Al Haram for healthy guests, and the active 25% direct-booking discount.
- The quote is saved into `aiStateSnapshot.known.quote`, so the hotel-side bot receives the same context after the guest confirms handoff.

## Verification

Local checks passed:

```bash
node --check aiagent/core/orchestrator.js
node --check aiagent/jannatSupport/orchestrator.js
node --check aiagent/jannatSupport/brain.js
node --check scripts/chatbotRegressionChecks.js
npm run test:chatbot
```

Result: `PASS 27 chatbot regression checks`.
