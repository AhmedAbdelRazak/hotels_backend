"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
	buildAbandonedSessionAudit,
	canResumeActiveHostedSession,
	canReleaseAbandonedHostedSession,
} = require("./bofaHostedSessionState");

const blankExpiredSession = () => ({
	payment_details: { bofaVccCharged: false },
	bofa_payment: {
		secure_acceptance: {
			status: "expired_unconfirmed",
			last_reference_number: "JB-RES-1",
			last_transaction_uuid: "uuid-1",
			amount_usd: 13,
			last_callback_at: null,
			last_request_id: "",
			last_transaction_id: "",
			callbacks: [],
		},
		vcc: {
			charged: false,
			outcome_unknown: true,
			last_request_id: "",
			last_transaction_id: "",
		},
	},
});

test("only an expired form with no callback or gateway identifier can be released", () => {
	const reservation = blankExpiredSession();
	assert.equal(canReleaseAbandonedHostedSession(reservation, "JB-RES-1"), true);
	assert.equal(canReleaseAbandonedHostedSession(reservation, "JB-OTHER"), false);

	for (const mutate of [
		(value) => (value.bofa_payment.vcc.charged = true),
		(value) => (value.payment_details.bofaVccCharged = true),
		(value) => (value.bofa_payment.secure_acceptance.last_callback_at = new Date()),
		(value) => (value.bofa_payment.secure_acceptance.last_transaction_id = "txn-1"),
		(value) => value.bofa_payment.secure_acceptance.callbacks.push({ event_id: "1" }),
	]) {
		const changed = blankExpiredSession();
		mutate(changed);
		assert.equal(canReleaseAbandonedHostedSession(changed, "JB-RES-1"), false);
	}
});

test("abandoned session audit keeps payment context but no card data", () => {
	const audit = buildAbandonedSessionAudit(blankExpiredSession(), {
		actorId: "super-admin-1",
		at: new Date("2026-07-24T02:00:00.000Z"),
	});
	assert.equal(audit.reference_number, "JB-RES-1");
	assert.equal(audit.transaction_uuid, "uuid-1");
	assert.equal(audit.amount_usd, 13);
	assert.equal(audit.confirmed_by, "super-admin-1");
	assert.equal(audit.gateway_identifiers_present, false);
	assert.equal(JSON.stringify(audit).includes("card_number"), false);
});

test("an active callback-free checkout can be resumed but not after expiry", () => {
	const reservation = blankExpiredSession();
	reservation.bofa_payment.secure_acceptance.status = "pending";
	reservation.bofa_payment.secure_acceptance.expires_at = new Date(
		"2026-07-24T02:00:00.000Z",
	);
	reservation.bofa_payment.vcc.processing = true;
	reservation.bofa_payment.vcc.outcome_unknown = false;
	assert.equal(
		canResumeActiveHostedSession(
			reservation,
			new Date("2026-07-24T01:30:00.000Z"),
		),
		true,
	);
	assert.equal(
		canResumeActiveHostedSession(
			reservation,
			new Date("2026-07-24T02:00:01.000Z"),
		),
		false,
	);
	reservation.bofa_payment.secure_acceptance.last_transaction_id = "txn-1";
	assert.equal(
		canResumeActiveHostedSession(
			reservation,
			new Date("2026-07-24T01:30:00.000Z"),
		),
		false,
	);
});
