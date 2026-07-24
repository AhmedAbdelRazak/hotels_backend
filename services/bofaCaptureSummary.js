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

const sameMoney = (left, right) =>
	Math.round(Number(left) * 100) === Math.round(Number(right) * 100);

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

const getRecordedExternalVccCaptureSummary = (reservation = {}) => {
	const paymentDetails = reservation?.payment_details || {};
	const paypal = reservation?.paypal_details || {};
	const external = paypal.external_virtual_terminal || {};
	const initial = paypal.initial || {};
	const vcc = reservation?.vcc_payment || {};
	const transactionId = clean(external.transaction_id, 100);
	const amountUsd = positiveMoney(external.gross_amount_usd);
	const invoiceId = clean(external.invoice_id, 80);
	const reservationReference = clean(reservation?.reservation_id, 80);
	const status = clean(external.status, 30).toUpperCase();
	const currency = clean(external.currency, 3).toUpperCase();
	const lastChargeVia = clean(paymentDetails.lastChargeVia, 80).toUpperCase();
	const initialStatus = clean(
		initial.capture_status || initial.status,
		30,
	).toUpperCase();

	const reconciled =
		paymentDetails.captured === true &&
		paymentDetails.vccCharged === true &&
		vcc.charged === true &&
		lastChargeVia === "VCC_PAYPAL_VIRTUAL_TERMINAL_EXTERNAL" &&
		status === "COMPLETED" &&
		currency === "USD" &&
		amountUsd > 0 &&
		transactionId &&
		clean(paymentDetails.vccCaptureId, 100) === transactionId &&
		clean(paymentDetails.finalCaptureTransactionId, 100) === transactionId &&
		clean(initial.capture_id, 100) === transactionId &&
		initialStatus === "COMPLETED" &&
		clean(initial.currency, 3).toUpperCase() === "USD" &&
		sameMoney(initial.amount, amountUsd) &&
		sameMoney(paypal.captured_total_usd, amountUsd) &&
		sameMoney(vcc.total_captured_usd, amountUsd) &&
		invoiceId &&
		invoiceId === reservationReference;

	if (!reconciled) return null;

	return {
		verified: true,
		status: "captured",
		amountUsd,
		currency: "USD",
		capturedAt:
			external.transaction_at ||
			vcc.last_success_at ||
			paymentDetails.lastChargeAt ||
			null,
		provider: clean(vcc.source || reservation?.booking_source, 60),
		referenceNumber: invoiceId,
		transactionId,
		chargeCount: Math.max(1, Number(vcc.charge_count || 1)),
	};
};

const getReservationVccCaptureSummary = (reservation = {}) => {
	const bofaCapture = getVerifiedBofaCaptureSummary(reservation);
	if (bofaCapture) {
		return {
			...bofaCapture,
			evidence: "Verified",
			gateway: "Bank of America",
			referenceLabel: "Merchant reference",
		};
	}

	const externalCapture = getRecordedExternalVccCaptureSummary(reservation);
	if (!externalCapture) return null;
	return {
		...externalCapture,
		evidence: "Reconciled",
		gateway: "PayPal Virtual Terminal",
		referenceLabel: "OTA confirmation",
	};
};

module.exports = {
	getVerifiedBofaCaptureSummary,
	getRecordedExternalVccCaptureSummary,
	getReservationVccCaptureSummary,
};
