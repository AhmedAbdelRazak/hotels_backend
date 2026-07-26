"use strict";

const crypto = require("node:crypto");

const {
	getReservationVccCaptureSummary,
} = require("./bofaCaptureSummary");

const EXTERNAL_CAPTURE_CHANNEL = "VCC_PAYPAL_VIRTUAL_TERMINAL_EXTERNAL";
const BACKUP_COLLECTION = "reservation_reconciliation_backups";
const MAX_BATCH_SIZE = 25;

const ALLOWED_EVIDENCE_FIELDS = new Set([
	"invoiceId",
	"transactionId",
	"status",
	"currency",
	"grossAmountUsd",
	"transactionFeeUsd",
	"netAmountUsd",
	"transactionAt",
	"cardType",
	"cardLast4",
	"cscResult",
	"avsResult",
	"payerName",
	"shippingAddressOnFile",
	"provider",
]);

const TRANSACTION_PATHS = [
	"payment_details.vccCaptureId",
	"payment_details.finalCaptureTransactionId",
	"paypal_details.initial.capture_id",
	"paypal_details.external_virtual_terminal.transaction_id",
];

const clean = (value, maxLength = 160) =>
	String(value == null ? "" : value)
		.trim()
		.slice(0, maxLength);

const clone = (value) => {
	if (value == null) return value;
	return JSON.parse(JSON.stringify(value));
};

const stableHash = (value) =>
	crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

const normalizeProvider = (value) => {
	const provider = clean(value, 40).toLowerCase().replace(/\s+/g, " ");
	if (provider === "booking" || provider === "booking.com") return "booking.com";
	if (["agoda", "expedia"].includes(provider)) return provider;
	throw new Error("provider must be Agoda, Expedia, or Booking.com.");
};

const normalizeCardType = (value) => {
	const cardType = clean(value, 30).toUpperCase().replace(/[\s_-]+/g, "");
	if (["MC", "MCARD", "MASTERCARD"].includes(cardType)) return "MASTERCARD";
	if (cardType === "VISA") return "VISA";
	throw new Error("cardType must be Mastercard or Visa.");
};

const parseMoneyToCents = (value, label, { positive = false } = {}) => {
	if (typeof value !== "string" && typeof value !== "number") {
		throw new Error(`${label} must be a USD amount with no more than two decimals.`);
	}
	const text = String(value).trim();
	if (!/^\d+(?:\.\d{1,2})?$/.test(text)) {
		throw new Error(`${label} must be a non-negative USD amount with no more than two decimals.`);
	}
	const [whole, fraction = ""] = text.split(".");
	const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
	if (!Number.isSafeInteger(cents) || (positive && cents <= 0)) {
		throw new Error(`${label} is outside the supported range.`);
	}
	return cents;
};

const centsToNumber = (cents) => Number((cents / 100).toFixed(2));
const centsToFixed = (cents) => (cents / 100).toFixed(2);

const requireText = (value, label, pattern, maxLength) => {
	const text = clean(value, maxLength);
	if (!text || (pattern && !pattern.test(text))) {
		throw new Error(`${label} is missing or invalid.`);
	}
	return text;
};

const normalizeEvidence = (raw = {}) => {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("Each evidence item must be a JSON object.");
	}
	const unknownFields = Object.keys(raw).filter(
		(key) => !ALLOWED_EVIDENCE_FIELDS.has(key),
	);
	if (unknownFields.length) {
		throw new Error(
			`Unsupported evidence field(s): ${unknownFields.join(
				", ",
			)}. Raw PAN, CVV/CVC, expiry, and billing-address data must never be supplied.`,
		);
	}

	const invoiceId = requireText(
		raw.invoiceId,
		"invoiceId",
		/^[A-Za-z0-9][A-Za-z0-9._-]{2,79}$/,
		80,
	);
	const transactionId = requireText(
		raw.transactionId,
		"transactionId",
		/^[A-Za-z0-9][A-Za-z0-9._-]{7,99}$/,
		100,
	);
	const status = clean(raw.status, 30).toUpperCase();
	if (status !== "COMPLETED") {
		throw new Error("status must be COMPLETED. Declined, pending, or inconclusive attempts cannot be reconciled as captured.");
	}
	const currency = clean(raw.currency, 3).toUpperCase();
	if (currency !== "USD") throw new Error("currency must be USD.");

	const grossCents = parseMoneyToCents(raw.grossAmountUsd, "grossAmountUsd", {
		positive: true,
	});
	const feeCents = parseMoneyToCents(raw.transactionFeeUsd, "transactionFeeUsd");
	const netCents = parseMoneyToCents(raw.netAmountUsd, "netAmountUsd");
	if (grossCents !== feeCents + netCents) {
		throw new Error(
			`grossAmountUsd must equal transactionFeeUsd + netAmountUsd (${centsToFixed(
				grossCents,
			)} != ${centsToFixed(feeCents)} + ${centsToFixed(netCents)}).`,
		);
	}

	const transactionAtText = clean(raw.transactionAt, 50);
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(transactionAtText)) {
		throw new Error(
			"transactionAt must be an ISO-8601 timestamp with an explicit Z or UTC offset.",
		);
	}
	const transactionAt = new Date(transactionAtText);
	if (Number.isNaN(transactionAt.getTime())) {
		throw new Error("transactionAt is not a real date/time.");
	}

	const cardLast4 = requireText(raw.cardLast4, "cardLast4", /^\d{4}$/, 4);
	const payerName = requireText(raw.payerName, "payerName", null, 120);
	const cscResult = requireText(raw.cscResult, "cscResult", /^[A-Za-z0-9 _.-]{1,40}$/, 40).toUpperCase();
	const avsResult = requireText(raw.avsResult, "avsResult", /^[A-Za-z0-9 _.[\]()-]{1,80}$/, 80).toUpperCase();
	if (typeof raw.shippingAddressOnFile !== "boolean") {
		throw new Error("shippingAddressOnFile must be true or false.");
	}

	return {
		invoiceId,
		transactionId,
		status: "COMPLETED",
		currency: "USD",
		grossCents,
		feeCents,
		netCents,
		grossAmountUsd: centsToNumber(grossCents),
		transactionFeeUsd: centsToNumber(feeCents),
		netAmountUsd: centsToNumber(netCents),
		transactionAt: transactionAt.toISOString(),
		cardType: normalizeCardType(raw.cardType),
		cardLast4,
		cscResult,
		avsResult,
		payerName,
		shippingAddressOnFile: raw.shippingAddressOnFile,
		provider: normalizeProvider(raw.provider),
	};
};

const normalizeEvidenceBatch = (raw) => {
	const batch = Array.isArray(raw) ? raw : [raw];
	if (!batch.length) throw new Error("The evidence batch is empty.");
	if (batch.length > MAX_BATCH_SIZE) {
		throw new Error(`A single run is limited to ${MAX_BATCH_SIZE} reservations.`);
	}
	const normalized = batch.map(normalizeEvidence);
	const invoiceIds = new Set();
	const transactionIds = new Set();
	for (const evidence of normalized) {
		if (invoiceIds.has(evidence.invoiceId)) {
			throw new Error(`Duplicate invoiceId in evidence batch: ${evidence.invoiceId}.`);
		}
		if (transactionIds.has(evidence.transactionId)) {
			throw new Error(`Duplicate transactionId in evidence batch: ${evidence.transactionId}.`);
		}
		invoiceIds.add(evidence.invoiceId);
		transactionIds.add(evidence.transactionId);
	}
	return normalized;
};

const transactionCollisionQuery = (transactionId) => ({
	$or: TRANSACTION_PATHS.map((path) => ({ [path]: transactionId })),
});

const reservationIdentityQuery = (invoiceId) => ({
	$or: [
		{ reservation_id: invoiceId },
		{ confirmation_number: invoiceId },
		{ "customer_details.confirmation_number": invoiceId },
		{ "customer_details.confirmation_number2": invoiceId },
		{ "otaPlatformReview.confirmationNumber": invoiceId },
	],
});

const providerFromReservation = (reservation = {}) => {
	const source = clean(
		reservation.booking_source ||
			reservation.customer_details?.booking_source ||
			reservation.supplierData?.provider,
		40,
	).toLowerCase();
	if (source.includes("booking")) return "booking.com";
	if (source.includes("expedia")) return "expedia";
	if (source.includes("agoda")) return "agoda";
	return source;
};

const paymentBreakdownTotalCents = (breakdown = {}) =>
	Object.entries(breakdown || {}).reduce((sum, [key, value]) => {
		if (key === "payment_comments") return sum;
		const amount = Number(value);
		return Number.isFinite(amount) && amount > 0
			? sum + Math.round(amount * 100)
			: sum;
	}, 0);

const hasAnyCaptureState = (reservation = {}) =>
	reservation.payment_details?.captured === true ||
	reservation.payment_details?.vccCharged === true ||
	reservation.payment_details?.bofaVccCharged === true ||
	reservation.vcc_payment?.charged === true ||
	reservation.bofa_payment?.vcc?.charged === true ||
	Number(reservation.paypal_details?.captured_total_usd || 0) > 0;

const isSameCompletedCapture = (reservation = {}, evidence = {}) => {
	const summary = getReservationVccCaptureSummary(reservation);
	if (!summary) return false;
	return (
		summary.gateway === "PayPal Virtual Terminal" &&
		summary.transactionId === evidence.transactionId &&
		summary.referenceNumber === evidence.invoiceId &&
		summary.currency === "USD" &&
		Math.round(Number(summary.amountUsd) * 100) === evidence.grossCents
	);
};

const formatDateOnly = (value) => {
	if (!value) return "";
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
};

const buildExternalCaptureSet = ({
	reservation,
	evidence,
	hotelName,
	recordedAt = new Date(),
	backupId,
}) => {
	const transactionAt = new Date(evidence.transactionAt);
	const recordedAtIso = new Date(recordedAt).toISOString();
	const metadata = {
		channel: "paypal_virtual_terminal",
		payment_kind: "OTA_VIRTUAL_CARD",
		ota: evidence.provider,
		hotel_name: clean(hotelName, 120),
		ota_confirmation_number: evidence.invoiceId,
		pms_confirmation_number: clean(reservation.confirmation_number, 80),
		checkin_date: formatDateOnly(reservation.checkin_date),
		checkout_date: formatDateOnly(reservation.checkout_date),
	};
	return {
		"payment_details.captured": true,
		"payment_details.vccCharged": true,
		"payment_details.vccChargedAt": transactionAt,
		"payment_details.vccCaptureId": evidence.transactionId,
		"payment_details.finalCaptureTransactionId": evidence.transactionId,
		"payment_details.finalCaptureStatus": "COMPLETED",
		"payment_details.lastChargeAt": transactionAt,
		"payment_details.lastChargeVia": EXTERNAL_CAPTURE_CHANNEL,
		"paypal_details.captured_total_usd": evidence.grossAmountUsd,
		"paypal_details.initial": {
			capture_id: evidence.transactionId,
			capture_status: "COMPLETED",
			status: "COMPLETED",
			amount: centsToFixed(evidence.grossCents),
			currency: "USD",
			captured_at: transactionAt,
		},
		"paypal_details.external_virtual_terminal": {
			provider: "PayPal",
			channel: "Virtual Terminal",
			transaction_id: evidence.transactionId,
			status: "COMPLETED",
			invoice_id: evidence.invoiceId,
			gross_amount_usd: evidence.grossAmountUsd,
			transaction_fee_usd: evidence.transactionFeeUsd,
			net_amount_usd: evidence.netAmountUsd,
			currency: "USD",
			transaction_at: transactionAt,
			card_type: evidence.cardType,
			card_last4: evidence.cardLast4,
			csc_result: evidence.cscResult,
			avs_result: evidence.avsResult,
			payer_name: evidence.payerName,
			shipping_address_on_file: evidence.shippingAddressOnFile,
			metadata,
			reconciled_at: new Date(recordedAt),
			reconciled_from: "OPERATOR_SUPPLIED_PAYPAL_COMPLETION_EVIDENCE",
			backup_id: backupId ? String(backupId) : "",
		},
		"vcc_payment.source": evidence.provider,
		"vcc_payment.charged": true,
		"vcc_payment.processing": false,
		"vcc_payment.charge_count": 1,
		"vcc_payment.total_captured_usd": evidence.grossAmountUsd,
		"vcc_payment.last_success_at": transactionAt,
		"vcc_payment.last_transaction_id": evidence.transactionId,
		"vcc_payment.last_capture": {
			provider: "PayPal",
			channel: "Virtual Terminal",
			status: "COMPLETED",
			transaction_id: evidence.transactionId,
			invoice_id: evidence.invoiceId,
			amount_usd: evidence.grossAmountUsd,
			currency: "USD",
			captured_at: transactionAt,
			metadata,
		},
		updatedAt: new Date(recordedAt),
		__audit: {
			at: new Date(recordedAt),
			action: "external_ota_vcc_capture_reconciled",
			actor: "controlled-reconciliation-script",
			source: EXTERNAL_CAPTURE_CHANNEL,
			provider: evidence.provider,
			invoiceId: evidence.invoiceId,
			transactionId: evidence.transactionId,
			amountUsd: evidence.grossAmountUsd,
			currency: "USD",
			backupId: backupId ? String(backupId) : "",
			recordedAt: recordedAtIso,
		},
	};
};

const splitSetAndAudit = (captureSet) => {
	const set = { ...captureSet };
	const audit = set.__audit;
	delete set.__audit;
	return { set, audit };
};

const buildConcurrencyFilter = (reservation) => {
	const filter = {
		_id: reservation._id,
		reservation_id: reservation.reservation_id,
		"payment_details.captured": { $ne: true },
		"payment_details.vccCharged": { $ne: true },
		"payment_details.bofaVccCharged": { $ne: true },
		"vcc_payment.charged": { $ne: true },
		"bofa_payment.vcc.charged": { $ne: true },
	};
	if (reservation.updatedAt) filter.updatedAt = reservation.updatedAt;
	else filter.updatedAt = { $exists: false };
	return filter;
};

const protectedReservationSnapshot = (reservation = {}) => ({
	reservation_id: reservation.reservation_id,
	confirmation_number: reservation.confirmation_number,
	hotelId: reservation.hotelId,
	booking_source: reservation.booking_source,
	reservedBy: reservation.reservedBy,
	checkin_date: reservation.checkin_date,
	checkout_date: reservation.checkout_date,
	days_of_residence: reservation.days_of_residence,
	pickedRoomsType: reservation.pickedRoomsType,
	pickedRoomsPricing: reservation.pickedRoomsPricing,
	room_numbers: reservation.room_numbers,
	total_amount: reservation.total_amount,
	sub_total: reservation.sub_total,
	paid_amount: reservation.paid_amount,
	paid_amount_breakdown: reservation.paid_amount_breakdown,
	adminPricing: reservation.adminPricing,
	financial_cycle: reservation.financial_cycle,
	reservation_status: reservation.reservation_status,
	state: reservation.state,
	pendingConfirmation: reservation.pendingConfirmation,
	customer_details: reservation.customer_details,
});

const verifyProtectedReservationSnapshot = (before, after) =>
	stableHash(protectedReservationSnapshot(before)) ===
	stableHash(protectedReservationSnapshot(after));

const verifyCompletedCapture = ({ reservation, evidence }) => {
	const summary = getReservationVccCaptureSummary(reservation);
	if (!summary) throw new Error("The saved reservation does not expose a verified reconciled capture summary.");
	if (summary.gateway !== "PayPal Virtual Terminal") {
		throw new Error("The saved capture summary identifies the wrong gateway.");
	}
	if (summary.transactionId !== evidence.transactionId) {
		throw new Error("The saved capture transaction ID does not match the supplied evidence.");
	}
	if (summary.referenceNumber !== evidence.invoiceId) {
		throw new Error("The saved invoice does not match the reservation OTA confirmation.");
	}
	if (Math.round(Number(summary.amountUsd) * 100) !== evidence.grossCents) {
		throw new Error("The saved captured amount does not match the supplied evidence.");
	}
	return summary;
};

module.exports = {
	ALLOWED_EVIDENCE_FIELDS,
	BACKUP_COLLECTION,
	EXTERNAL_CAPTURE_CHANNEL,
	MAX_BATCH_SIZE,
	TRANSACTION_PATHS,
	buildConcurrencyFilter,
	buildExternalCaptureSet,
	clone,
	hasAnyCaptureState,
	isSameCompletedCapture,
	normalizeEvidence,
	normalizeEvidenceBatch,
	paymentBreakdownTotalCents,
	protectedReservationSnapshot,
	providerFromReservation,
	reservationIdentityQuery,
	splitSetAndAudit,
	stableHash,
	transactionCollisionQuery,
	verifyCompletedCapture,
	verifyProtectedReservationSnapshot,
};
