"use strict";

// The admin reservations list returns a deliberately compact row shape. These
// append-only histories and gateway diagnostic payloads are never used by its
// search, filters, scorecards, visibility sanitizers, VCC summary, or response
// mapper. Keep this as an exclusion projection so newly-added business fields
// continue to reach the existing formatting and role-visibility logic by
// default.
const ADMIN_RESERVATION_LIST_PROJECTION = Object.freeze({
  adminChangeLog: 0,
  reservationAuditLog: 0,
  "bofa_payment.secure_acceptance.callbacks": 0,
  "bofa_payment.secure_acceptance.last_response_payload": 0,
  "bofa_payment.secure_acceptance.outbound_metadata": 0,
  "bofa_payment.secure_acceptance.request_context": 0,
  "bofa_payment.vcc.attempts": 0,
  "braintree_payment.attempts": 0,
  "vcc_payment.attempts": 0,
});

module.exports = {
  ADMIN_RESERVATION_LIST_PROJECTION,
};
