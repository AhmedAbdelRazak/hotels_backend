"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { getVerifiedBofaCaptureSummary } = require("./bofaCaptureSummary");

const acceptedReservation = () => ({
	booking_source: "agoda",
	payment_details: {
		bofaVccCharged: true,
		bofaVccChargedAt: "2026-07-24T01:00:00.000Z",
		bofaVccTransactionId: "txn-safe-123",
		bofaSaAccepted: true,
	},
	bofa_payment: {
		secure_acceptance: {
			status: "accepted",
			currency: "USD",
			amount_usd: 67.3,
			last_reference_number: "JB-123",
			last_response_signature_valid: true,
		},
		vcc: {
			source: "agoda",
			charged: true,
			charge_count: 1,
			total_captured_usd: 67.3,
			last_success_at: "2026-07-24T01:00:00.000Z",
			last_capture: {
				decision: "ACCEPT",
				reason_code: "100",
				currency: "USD",
				amount_usd: 67.3,
				reference_number: "JB-123",
				transaction_id: "txn-safe-123",
				reconciliation_id: "recon-safe-123",
			},
		},
	},
});

test("returns a sanitized USD summary only for a verified accepted capture", () => {
	assert.deepEqual(getVerifiedBofaCaptureSummary(acceptedReservation()), {
		verified: true,
		status: "captured",
		amountUsd: 67.3,
		currency: "USD",
		capturedAt: "2026-07-24T01:00:00.000Z",
		provider: "agoda",
		referenceNumber: "JB-123",
		transactionId: "txn-safe-123",
		reconciliationId: "recon-safe-123",
		chargeCount: 1,
	});
});

test("never reports declined, unsigned, or non-USD attempts as captured", () => {
	const declined = acceptedReservation();
	declined.bofa_payment.secure_acceptance.status = "declined";
	assert.equal(getVerifiedBofaCaptureSummary(declined), null);

	const unsigned = acceptedReservation();
	unsigned.bofa_payment.secure_acceptance.last_response_signature_valid = false;
	assert.equal(getVerifiedBofaCaptureSummary(unsigned), null);

	const nonUsd = acceptedReservation();
	nonUsd.bofa_payment.vcc.last_capture.currency = "SAR";
	assert.equal(getVerifiedBofaCaptureSummary(nonUsd), null);
});
