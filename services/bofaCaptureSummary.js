"use strict";

const clean = (value, maxLength = 160) =>
	String(value == null ? "" : value)
		.trim()
		.slice(0, maxLength);

const positiveMoney = (...values) => {
	for (const value of values) {
		const amount = Number(value);
		if (Number.isFinite(amount) && amount > 0) {
			return Math.round(amount * 100) / 100;
		}
	}
	return 0;
};

const getVerifiedBofaCaptureSummary = (reservation = {}) => {
	const paymentDetails = reservation?.payment_details || {};
	const bofa = reservation?.bofa_payment || {};
	const vcc = bofa.vcc || {};
	const secureAcceptance = bofa.secure_acceptance || {};
	const lastCapture = vcc.last_capture || {};

	const verifiedAcceptedCapture =
		vcc.charged === true &&
		paymentDetails.bofaVccCharged === true &&
		paymentDetails.bofaSaAccepted === true &&
		clean(secureAcceptance.status, 30).toLowerCase() === "accepted" &&
		secureAcceptance.last_response_signature_valid === true &&
		clean(lastCapture.decision, 30).toUpperCase() === "ACCEPT" &&
		clean(lastCapture.reason_code, 20) === "100";

	if (!verifiedAcceptedCapture) return null;

	const currency = clean(
		lastCapture.currency || secureAcceptance.currency || "USD",
		3,
	).toUpperCase();
	const amountUsd = positiveMoney(
		vcc.total_captured_usd,
		lastCapture.amount_usd,
		secureAcceptance.amount_usd,
	);
	if (currency !== "USD" || amountUsd <= 0) return null;

	return {
		verified: true,
		status: "captured",
		amountUsd,
		currency: "USD",
		capturedAt:
			vcc.last_success_at || paymentDetails.bofaVccChargedAt || null,
		provider: clean(vcc.source || reservation?.booking_source, 60),
		referenceNumber: clean(
			lastCapture.reference_number ||
				secureAcceptance.last_reference_number,
			50,
		),
		transactionId: clean(
			lastCapture.transaction_id ||
				vcc.last_transaction_id ||
				paymentDetails.bofaVccTransactionId,
			100,
		),
		reconciliationId: clean(
			lastCapture.reconciliation_id || vcc.last_reconciliation_id,
			100,
		),
		chargeCount: Math.max(1, Number(vcc.charge_count || 1)),
	};
};

module.exports = { getVerifiedBofaCaptureSummary };
