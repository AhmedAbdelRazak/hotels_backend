# B2C Chat, B2B Boundary, and SEO Audit - 2026-05-26

## Scope

- JannatBooking backend: support cases, B2B chat, dormant `aiagent`, Socket.IO.
- PMS frontend: `/admin/customer-service` B2C support monitoring and `/hotel-management/b2b-chat` internal B2B chat.
- Public frontend: `jannatbooking_frontend` chat widget and crawl/SEO files.
- Reference system studied: `D:\SereneJannat\serene_backend\controllers` and `D:\SereneJannat\serene_ssr\src`.

## SereneJannat Patterns Studied

- Serene keeps B2C support automation tied to customer-opened support cases only.
- Staff messages are blocked or require AI to be disabled before staff takeover.
- `aiToRespond` is a per-case operational switch.
- AI handoff and closed-case states stop automation.
- SSR uses reusable SEO metadata, JSON-LD, sitemap routes, and crawler-support content.
- Important difference: Serene's `robots.js` blocks multiple AI crawlers. JannatBooking should not copy that because public AI/search crawling is desired.

## Findings

- JannatBooking B2B chat is separate (`models/b2b_chat.js`, `controllers/b2b_chat.js`, PMS `/hotel-management/b2b-chat`) and has no direct AI integration. This matches the requirement that B2B chats should not have bots.
- JannatBooking B2C support uses `models/supportcase.js` and `controllers/supportcase.js`.
- The old AI policy defaulted to allow when no hotel existed and did not enforce client-opened support cases. That was unsafe if the dormant agent was re-enabled.
- The public frontend chat was calling the admin support-case read/update route. Dedicated public client endpoints are safer and keep admin routes admin-only.
- `jannatbooking_frontend` already hides the public chat widget on URLs containing `admin` or `management`.
- `robots.txt` allowed crawling but did not advertise a sitemap or LLM-readable brand summary.

## Changes Completed

- Added per-support-case AI control fields: `aiToRespond`, `aiResponderName`, `aiPausedAt`, `aiHandoffReason`, `humanTakeoverAt`, `humanTakeoverBy`.
- Added per-support-case escalation fields: `escalationStatus`, `escalationReason`, `escalationSource`, `escalatedAt`, `escalatedBy`, `escalationAddressedAt`, `escalationAddressedBy`, and `escalationAddressedNote`.
- New B2C public endpoints:
  - `GET /api/support-cases/client/:id`
  - `PUT /api/support-cases/client/:id`
- Public client updates can append customer messages or close/rate the case, but cannot change hotel assignment, supporter, admin fields, or AI control.
- Admin/staff messages on B2C cases now automatically set `aiToRespond=false`, record takeover metadata, and emit `aiPaused`.
- B2B cases reject AI-control toggles.
- AI policy now requires all of the following:
  - `AI_AGENT_ENABLED=true` or explicit force flag.
  - support case opened by `client`.
  - support case status is `open`.
  - support case `aiToRespond === true`.
  - hotel `aiToRespond === true` unless forced.
- AI socket planner now re-checks policy on join and each turn.
- AI messages use `support@jannatbooking.com` and a stable `aiResponderName` from the support case.
- Cancellation and reservation-update requests trigger human handoff and stop AI.
- AI handoff is now a real escalation (`escalationStatus=active`) and admin staff can mark it addressed after review.
- Final reservation commits are handed to a human Jannat Booking team member instead of being auto-created by the AI planner.
- Public chat copy now frames room/bed inquiries as pricing and availability support.
- Public frontend now uses client support endpoints instead of admin support endpoints.
- Added public crawl aids:
  - `public/sitemap.xml`
  - `public/llms.txt`
  - sitemap entry in `robots.txt`
  - global JSON-LD for Organization, WebSite, and TravelAgency.

## Operational Notes

- The AI agent remains opt-in through `AI_AGENT_ENABLED=true`. This is intentional; enabling should happen only after production environment variables, OpenAI key, hotel opt-ins, and support-team monitoring are ready.
- Hotel-level `aiToRespond` remains the business toggle for whether a hotel may receive B2C AI support.
- Case-level `aiToRespond` is the live takeover switch and should be treated as the source of truth for whether automation may respond to that case.
- Cancellation, refunds, and reservation mutations should remain human-only.
- Active escalations should be worked from `/admin/customer-service?tab=escalated-client-cases`; addressed escalations should leave that tab while preserving the case audit trail.

## SSR Recommendation

The current public frontend is CRA with `react-helmet`, so crawlers that do not execute JavaScript may miss some metadata. The best next structural upgrade is a `jannatbooking_ssr` app inspired by Serene SSR, but with AI crawlers allowed. The SSR version should generate:

- Dynamic sitemap entries for every active hotel and room page.
- Server-rendered canonical metadata.
- Hotel and room JSON-LD with distance to Al Haram, amenities, city, image, and offer availability.
- FAQ content for Umrah/Haj hotel booking, payments, reservation changes, and cancellation handoff.
- Crawl-visible brand proof points such as the 10,000+ reservations statement where approved for public display.

## Post-Audit QA Addendum - 2026-05-27

- Long Arabic B2C conversations were tested for casual client tone, hotel recommendations, date-range pricing, payment troubleshooting, and reservation update handoff.
- The AI now saves replies after the human-like typing delay; the previous `reason is not defined` send-path error was fixed.
- The writer prompt now requires respectful Arabic address for known clients, e.g. `أستاذ ناصر`, while keeping responses concise and official.
- Hotel recommendation links are returned as markdown links with title-cased hotel names.
- Payment replies now receive known confirmation numbers as context so they do not ask for the same reference again.
- The orchestrator can choose `human_escalation` when the request needs human review or is outside available context.
- AI handoff writes escalation fields and emits escalation socket events for the PMS escalated-cases tab.
- Support-case email notifications are best-effort; SendGrid failure no longer turns a saved support case into a failed create response.
- Confirmed behavior:
  - Pricing flow can quote active hotel inventory by date range.
  - Payment flow avoids card details and stays concise.
  - Reservation update/cancellation-style requests hand off to a human and pause AI.
  - Typing/stopTyping events are visible for admin and public clients.
