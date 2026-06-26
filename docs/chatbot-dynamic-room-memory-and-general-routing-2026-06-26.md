# Chatbot Dynamic Room Memory and General Routing - 2026-06-26

## Why this was changed

The latest Arabic production chat showed two dynamic behavior gaps:

- A live/current question about an Egypt match was answered with stale hotel facts.
- A room recommendation for two guests was later quoted as a different room because older exploratory room mentions could override later meaningful recommendations.

## Production contract

- Generic live/current questions such as sports fixtures, weather, news, schedules, exchange rates, and similar topics must route to the dynamic OpenAI writer and preserve the active reservation flow.
- The writer must not answer live/current questions with hotel address, distance, policy, map, room, or other hotel facts unless the guest explicitly asks for those facts.
- Room memory is chronological and semantic. Exploratory room questions such as "what is quintuple?" or "what rooms do you have?" must not become the selected room.
- Meaningful guest choices, guest-count requests, assistant recommendations, quotes, reviews, and correction/memory challenges can update the active room slot.
- Quote, proceed, memory-summary, and final-review paths re-check the latest room signal before pricing or summarizing so stale state does not leak into the guest reply.

## Notes for future tuning

- Prefer category-level routing and semantic signals over one-sentence hard coding.
- Add multilingual room synonyms to `aiagent/core/nlu.js` when they are genuine vocabulary gaps. Arabic "غرفة زوجية" now maps to `doubleRooms`.
- If a future chat shows a wrong quote, first inspect `slots.room_changed_from_conversation` logs and compare `signalSource` with the conversation chronology.
