"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
	buildConcurrencyFilter,
	buildExternalCaptureSet,
	hasAnyCaptureState,
	normalizeEvidence,
	normalizeEvidenceBatch,
	protectedReservationSnapshot,
	splitSetAndAudit,
	verifyCompletedCapture,
	verifyProtectedReservationSnapshot,
} = require("./externalVccReconciliation");
const {
	existingCaptureMatchesEvidence,
} = require("../scripts/reconcileExternalVccCapture");

const evidence = (overrides = {}) => ({
	invoiceId: "681965411",
	transactionId: "2U9190880F967015X",
	status: "COMPLETED",
	currency: "USD",
	grossAmountUsd: "28.46",
	transactionFeeUsd: "1.25",
	netAmountUsd: "27.21",
	transactionAt: "2026-07-25T19:29:19-07:00",
	cardType: "MCARD",
	cardLast4: "5409",
	cscResult: "Match",
	avsResult: "Match",
	payerName: "Agoda Company Pte Ltd",
	shippingAddressOnFile: false,
	provider: "Agoda",
	...overrides,
});

const reservation = () => ({
	_id: "6a0000000000000000000001",
	reservation_id: "681965411",
	confirmation_number: "99887766",
	booking_source: "agoda",
	hotelId: "6a0000000000000000000002",
	checkin_date: new Date("2026-07-25T00:00:00.000Z"),
	checkout_date: new Date("2026-07-27T00:00:00.000Z"),
	days_of_residence: 2,
	total_amount: 140,
	sub_total: 92,
	paid_amount: 0,
	pickedRoomsType: [{ room_type: "familyRooms", count: 1 }],
	pickedRoomsPricing: [{ room_type: "familyRooms", count: 1 }],
	room_numbers: ["501"],
	adminPricing: { clientTotal: 140, rootTotal: 92 },
	financial_cycle: { status: "open" },
	reservation_status: "confirmed",
	state: "confirmed",
	pendingConfirmation: { status: "confirmed" },
	customer_details: { name: "Example Guest" },
	payment_details: {},
	paypal_details: {},
	vcc_payment: { charged: false, charge_count: 0 },
	paid_amount_breakdown: {
		paid_online_via_link: 0,
		paid_at_hotel_cash: 0,
		paid_online_other_platforms: 0,
		payment_comments: "",
	},
	updatedAt: new Date("2026-07-25T20:00:00.000Z"),
});

const applyDotSet = (target, set) => {
	for (const [path, value] of Object.entries(set)) {
		const segments = path.split(".");
		let cursor = target;
		for (let index = 0; index < segments.length - 1; index += 1) {
			const segment = segments[index];
			cursor[segment] = cursor[segment] || {};
			cursor = cursor[segment];
		}
		cursor[segments.at(-1)] = value;
	}
	return target;
};

test("normalizes exact-cent completed USD evidence and its explicit timezone", () => {
	const normalized = normalizeEvidence(evidence());
	assert.equal(normalized.grossCents, 2846);
	assert.equal(normalized.feeCents, 125);
	assert.equal(normalized.netCents, 2721);
	assert.equal(normalized.transactionAt, "2026-07-26T02:29:19.000Z");
	assert.equal(normalized.cardType, "MASTERCARD");
	assert.equal(normalized.provider, "agoda");
});

test("rejects inconsistent money, ambiguous time, non-USD, or non-completed evidence", () => {
	assert.throws(
		() => normalizeEvidence(evidence({ netAmountUsd: "27.20" })),
		/grossAmountUsd must equal/,
	);
	assert.throws(
		() => normalizeEvidence(evidence({ transactionAt: "2026-07-25T19:29:19" })),
		/explicit Z or UTC offset/,
	);
	assert.throws(
		() => normalizeEvidence(evidence({ currency: "SAR" })),
		/currency must be USD/,
	);
	assert.throws(
		() => normalizeEvidence(evidence({ status: "PENDING" })),
		/status must be COMPLETED/,
	);
});

test("rejects unknown fields so raw PAN, CVV, expiry, or address cannot enter the workflow", () => {
	assert.throws(
		() => normalizeEvidence(evidence({ cardNumber: "4111111111111111" })),
		/Unsupported evidence field/,
	);
	assert.throws(
		() => normalizeEvidence(evidence({ cvv: "123" })),
		/Unsupported evidence field/,
	);
	assert.throws(
		() => normalizeEvidence(evidence({ billingAddress: "Do not store" })),
		/Unsupported evidence field/,
	);
});

test("rejects duplicate invoice and transaction identities inside a batch", () => {
	assert.throws(
		() => normalizeEvidenceBatch([evidence(), evidence({ transactionId: "9ZZ99999999999999" })]),
		/Duplicate invoiceId/,
	);
	assert.throws(
		() =>
			normalizeEvidenceBatch([
				evidence(),
				evidence({ invoiceId: "999111222" }),
			]),
		/Duplicate transactionId/,
	);
});

test("builds a capture record that the UI summary recognizes without changing protected facts", () => {
	const original = reservation();
	const saved = structuredClone(original);
	const normalized = normalizeEvidence(evidence());
	const captureSet = buildExternalCaptureSet({
		reservation: original,
		evidence: normalized,
		hotelName: "Zad Ajyad",
		recordedAt: new Date("2026-07-26T03:00:00.000Z"),
		backupId: "backup-1",
	});
	const { set, audit } = splitSetAndAudit(captureSet);
	applyDotSet(saved, set);
	saved.reservationAuditLog = [audit];

	assert.equal(verifyProtectedReservationSnapshot(original, saved), true);
	assert.deepEqual(protectedReservationSnapshot(saved), protectedReservationSnapshot(original));
	assert.deepEqual(verifyCompletedCapture({ reservation: saved, evidence: normalized }), {
		verified: true,
		status: "captured",
		amountUsd: 28.46,
		currency: "USD",
		capturedAt: new Date("2026-07-26T02:29:19.000Z"),
		provider: "agoda",
		referenceNumber: "681965411",
		transactionId: "2U9190880F967015X",
		chargeCount: 1,
		evidence: "Reconciled",
		gateway: "PayPal Virtual Terminal",
		referenceLabel: "OTA confirmation",
	});
	assert.equal(saved.paypal_details.external_virtual_terminal.transaction_fee_usd, 1.25);
	assert.equal(saved.paypal_details.external_virtual_terminal.net_amount_usd, 27.21);
	assert.equal(saved.paypal_details.external_virtual_terminal.metadata.hotel_name, "Zad Ajyad");
	assert.equal(saved.paid_amount_breakdown.paid_online_other_platforms, 28.46);
	assert.equal(audit.backupId, "backup-1");
});

test("detects any existing money and builds an updatedAt compare-and-set guard", () => {
	const original = reservation();
	assert.equal(hasAnyCaptureState(original), false);
	original.paid_amount_breakdown.paid_online_via_link = 0.01;
	assert.equal(hasAnyCaptureState(original), true);

	const filter = buildConcurrencyFilter(reservation());
	assert.equal(filter.reservation_id, "681965411");
	assert.deepEqual(filter.updatedAt, new Date("2026-07-25T20:00:00.000Z"));
	assert.deepEqual(filter["payment_details.captured"], { $ne: true });
	assert.deepEqual(filter["vcc_payment.charged"], { $ne: true });
});

test("an idempotent rerun requires every sanitized evidence field to agree", () => {
	const original = reservation();
	const normalized = normalizeEvidence(evidence());
	const saved = structuredClone(original);
	const { set } = splitSetAndAudit(
		buildExternalCaptureSet({
			reservation: original,
			evidence: normalized,
			hotelName: "Zad Ajyad",
			recordedAt: new Date("2026-07-26T03:00:00.000Z"),
			backupId: "backup-1",
		}),
	);
	applyDotSet(saved, set);
	assert.equal(existingCaptureMatchesEvidence(saved, normalized), true);

	saved.paypal_details.external_virtual_terminal.net_amount_usd = 27.2;
	assert.equal(existingCaptureMatchesEvidence(saved, normalized), false);
	saved.paypal_details.external_virtual_terminal.net_amount_usd = 27.21;
	saved.paypal_details.external_virtual_terminal.card_last4 = "9999";
	assert.equal(existingCaptureMatchesEvidence(saved, normalized), false);
});
