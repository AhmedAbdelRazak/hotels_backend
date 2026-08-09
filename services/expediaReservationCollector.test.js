/** @format */

process.env.SENDGRID_API_KEY = /^SG\./.test(process.env.SENDGRID_API_KEY || "")
	? process.env.SENDGRID_API_KEY
	: "SG.test";

const test = require("node:test");
const assert = require("node:assert/strict");
const { __private } = require("./expediaReservationCollector");

test("Expedia collector reads commercial detail for an existing PMS match", () => {
	assert.equal(
		__private.shouldFetchExpediaReservationDetails({
			bucket: "matchedExisting",
		}),
		true
	);
	assert.equal(
		__private.shouldFetchExpediaReservationDetails({ bucket: "conflicts" }),
		false
	);
});

test("Expedia collector preserves source money and rejects fallback FX as canonical", () => {
	const candidate = __private.normalizeCandidateMoneyToSar({
		sourceCurrency: "USD",
		sourceAmount: 146.46,
		paymentSummary: {
			sourceCurrency: "USD",
			sourceTotalGuestPaymentAmount: 146.46,
			sourceTotalPayoutAmount: 112.92,
		},
	});

	assert.equal(candidate.sourceAmount, 146.46);
	assert.equal(candidate.sourceCurrency, "USD");
	assert.equal(candidate.exchangeRateSource, "fallback_default");
	assert.equal(candidate.propertyConversionVerified, false);
	assert.equal(candidate.totalAmountSar, null);
	assert.equal(candidate.amount, null);
	assert.equal(candidate.currency, "USD");
	assert.equal(candidate.paymentSummary.sourceTotalPayoutAmount, 112.92);
	assert.equal(candidate.paymentSummary.totalGuestPaymentAmount, null);
	assert.equal(candidate.paymentSummary.totalPayoutAmount, null);
});

test("Expedia collector preserves an absent payout as null instead of zero evidence", () => {
	const candidate = __private.normalizeCandidateMoneyToSar({
		sourceCurrency: "USD",
		sourceAmount: 146.46,
		paymentSummary: {
			sourceCurrency: "USD",
			sourceTotalGuestPaymentAmount: 146.46,
		},
	});

	assert.equal(candidate.paymentSummary.sourceTotalPayoutAmount, null);
	assert.equal(candidate.paymentSummary.totalPayoutAmount, null);
});

test("Expedia collector never assumes SAR when source currency is absent", () => {
	const candidate = __private.normalizeCandidateMoneyToSar({
		sourceAmount: 146.46,
		paymentSummary: { sourceTotalGuestPaymentAmount: 146.46 },
	});

	assert.equal(candidate.sourceCurrency, "");
	assert.equal(candidate.exchangeRateSource, "missing_source_currency");
	assert.equal(candidate.propertyConversionVerified, false);
	assert.equal(candidate.totalAmountSar, null);
	assert.equal(candidate.paymentSummary.totalGuestPaymentAmount, null);
});

test("Expedia collector materializes same-currency SAR amounts", () => {
	const candidate = __private.normalizeCandidateMoneyToSar({
		sourceCurrency: "SAR",
		sourceAmount: 100.01,
		paymentSummary: {
			sourceCurrency: "SAR",
			sourceTotalGuestPaymentAmount: 100.01,
			sourceTotalPayoutAmount: 85.01,
		},
	});

	assert.equal(candidate.propertyConversionVerified, true);
	assert.equal(candidate.totalAmountSar, 100.01);
	assert.equal(candidate.paymentSummary.totalPayoutAmount, 85.01);
});

test("Expedia detail aliases must agree before payout evidence is usable", async () => {
	const detail = __private.parseExpediaReservationDetailText(
		[
			"Reservation # 2530158461",
			"Payment details",
			"Total guest payment USD 146.46",
			"Your total payout USD 112.92",
			"Amount to charge Expedia Group USD 111.92",
			"Expedia Collect",
		].join("\n"),
		{
			confirmationNumber: "2530158461",
			currency: "USD",
			checkinDate: "2026-10-05",
			checkoutDate: "2026-10-11",
		}
	);

	assert.equal(detail.commercialEvidenceConflict, true);
	assert.deepEqual(detail.commercialEvidenceConflicts, [
		"conflicting_payout_aliases",
	]);
	const classification = await __private.classifyCandidate(detail, {
		findReservation: async () => ({
			_id: "reservation-1",
			confirmation_number: "7255791395",
		}),
	});
	assert.equal(classification.bucket, "needsReview");
	assert.equal(
		classification.item.actionPreview,
		"commercial_evidence_conflict_no_write"
	);
});

test("Expedia collector classifies an existing reservation with a provider-scoped lookup", async () => {
	const calls = [];
	const existing = {
		_id: "reservation-2",
		hotelId: "hotel-2",
		confirmation_number: "pms-456",
		otaIdentityKey: "expedia:exp-456",
		reservation_id: "exp-456",
		reservation_status: "confirmed",
		customer_details: {
			confirmation_number2: "exp-456",
		},
		supplierData: {
			otaProvider: "expedia",
			otaConfirmationNumber: "exp-456",
			platformConfirmationNumber: "exp-456",
		},
	};

	const classification = await __private.classifyCandidate(
		{
			confirmationNumber: "EXP-456",
			statusToApply: "cancelled",
			statusRaw: "Cancelled",
		},
		{
			findReservation: async (...args) => {
				calls.push(args);
				return existing;
			},
		}
	);

	assert.equal(calls.length, 1);
	assert.equal(calls[0][0], "exp-456");
	assert.equal(calls[0][1], "expedia");
	assert.match(calls[0][2], /confirmation_number/);
	assert.equal(classification.bucket, "statusChanged");
	assert.equal(classification.item.matchedLookupValue, "exp-456");
	assert.ok(classification.item.matchedReservationBy.includes("otaIdentityKey"));
	assert.ok(
		classification.item.matchedReservationBy.includes(
			"supplierData.otaConfirmationNumber"
		)
	);
});
