# Chatbot Review Snapshot And Guest Count Hardening - 2026-07-05

## Context

A live Zad Ajyad support case reached a successful reservation, but the audit found two data risks:

- A clarification phrase like "I do not understand" could be accepted as a booking name in some flows.
- A later admin reservation update could accidentally reset an AI-reviewed multi-guest booking to the default one-adult payload.

## Changes

- Official booking reviews now save an `officialReviewSnapshot` of the approved guest facts.
- Reservation submit restores name, phone, nationality, stay dates, room selection, adults, and children from that approved snapshot before creation.
- Clarification/confusion phrases are rejected as booking-name candidates across common language roots for "understand", "clear", and "mean".
- Guest-count closure phrases such as "that makes four" or Arabic equivalents are rejected as booking-name candidates.
- A separate child-only answer after an adult/child question, such as "and one child", now preserves existing adults and updates children.
- AI-chat reservations are protected from accidental admin update payloads that reduce a multi-guest booking to default `1 adult / 0 children` unless an explicit guest-count update intent is present.

## Verification

- `npm run test:chatbot`
- `node --check aiagent/core/orchestrator.js`
- `node --check controllers/reservations.js`

Result: 31 chatbot regression checks passed.
