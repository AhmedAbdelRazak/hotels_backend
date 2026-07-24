"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
	getVerifiedBofaCaptureSummary,
	getRecordedExternalVccCaptureSummary,
	getReservationVccCaptureSummary,
} = require("./bofaCaptureSummary");

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

const externalVirtualTerminalReservation = () => ({
	reservation_id: "675894003",
	booking_source: "agoda",
	payment_details: {
		captured: true,
		vccCharged: true,
		vccCaptureId: "3KS57024FW675651X",
		finalCaptureTransactionId: "3KS57024FW675651X",
		lastChargeVia: "VCC_PAYPAL_VIRTUAL_TERMINAL_EXTERNAL",
		lastChargeAt: "2026-07-24T17:11:28.000Z",
	},
	paypal_details: {
		captured_total_usd: 67,
		initial: {
			capture_id: "3KS57024FW675651X",
			capture_status: "COMPLETED",
			amount: "67.00",
			currency: "USD",
		},
		external_virtual_terminal: {
			transaction_id: "3KS57024FW675651X",
			status: "COMPLETED",
			invoice_id: "675894003",
			gross_amount_usd: 67,
			currency: "USD",
			transaction_at: "2026-07-24T17:11:28.000Z",
		},
	},
	vcc_payment: {
		source: "agoda",
		charged: true,
		charge_count: 1,
		total_captured_usd: 67,
		last_success_at: "2026-07-24T17:11:28.000Z",
	},
});

test("returns a sanitized reconciled external virtual-terminal summary", () => {
	const reservation = externalVirtualTerminalReservation();
	assert.deepEqual(getRecordedExternalVccCaptureSummary(reservation), {
		verified: true,
		status: "captured",
		amountUsd: 67,
		currency: "USD",
		capturedAt: "2026-07-24T17:11:28.000Z",
		provider: "agoda",
		referenceNumber: "675894003",
		transactionId: "3KS57024FW675651X",
		chargeCount: 1,
	});
	assert.deepEqual(getReservationVccCaptureSummary(reservation), {
		...getRecordedExternalVccCaptureSummary(reservation),
		evidence: "Reconciled",
		gateway: "PayPal Virtual Terminal",
		referenceLabel: "OTA confirmation",
	});
});

test("rejects external capture evidence when any linked amount disagrees", () => {
	const reservation = externalVirtualTerminalReservation();
	reservation.paypal_details.captured_total_usd = 66.99;
	assert.equal(getRecordedExternalVccCaptureSummary(reservation), null);
	assert.equal(getReservationVccCaptureSummary(reservation), null);
});
