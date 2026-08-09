/** @format */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
	buildAuthenticatedProviderCommercialEvidence,
} = require("./otaCommercialEvidence");
const {
	hasOtaManagedPricingSignal,
	resolveAdminReservationFinancialTotals,
} = require("./adminReservationFinancialTotals");

const HASH = "a".repeat(64);

const verifiedEvidence = ({ provider = "agoda", gross, net }) =>
	buildAuthenticatedProviderCommercialEvidence({
		provider,
		authenticatedProvider: provider,
		sourceAuthenticated: true,
		sourceTrusted: true,
		sourceType: "authenticated_provider_portal",
		sourceCurrency: "SAR",
		propertyCurrency: "SAR",
		bookingBasis: "reservation_total",
		sourceHash: HASH,
		sourceTimestamp: "2026-08-09T12:00:00.000Z",
		sourceId: `${provider}-reservation-1`,
		guestGross: { verified: true, amount: gross },
		hotelPayout: { verified: true, amount: net },
	});

const hotelRunnerReservation = ({ gross = 77, net = 47.64, provider = "agoda" } = {}) => ({
	booking_source: provider === "trip" ? "trip.com" : provider,
	currency: "SAR",
	total_amount: gross,
	adminPricing: {
		mode: "hotelrunner_api",
		propertyCurrency: "SAR",
		clientTotal: gross,
		netAfterExpensesTotal: net,
		otaExpenseTotal: Number((gross - net).toFixed(2)),
		commercialVerified: false,
	},
	ota_financial_summary: {
		clientTotal: gross,
		netAfterExpenses: net,
		commercialVerified: false,
	},
	supplierData: {
		otaProvider: provider,
		otaCommercialEvidenceStaleReason: "",
		otaCommercialEvidence: verifiedEvidence({ provider, gross, net }),
		hotelRunner: { transport: "hotelrunner_api" },
	},
});

test("direct reservations use their actual guest total for both gross and net", () => {
	assert.deepEqual(
		resolveAdminReservationFinancialTotals({
			booking_source: "direct",
			currency: "SAR",
			total_amount: 2000,
			adminPricing: {
				mode: "standard",
				clientTotal: 0,
				netAfterExpensesTotal: 0,
			},
		}),
		{
			grossTotalAmount: 2000,
			netTotalAmount: 2000,
			currency: "SAR",
			grossAvailable: true,
			netAvailable: true,
			grossSource: "reservation_total",
			netSource: "no_ota_deduction",
			isOtaManaged: false,
			isHotelRunner: false,
		}
	);
});

test("calculated admin pricing preserves gross, net, and a genuine zero payout", () => {
	const priced = resolveAdminReservationFinancialTotals({
		booking_source: "OTA",
		currency: "SAR",
		total_amount: 1200,
		adminPricing: {
			mode: "admin_three_price",
			clientTotal: 1200,
			netAfterExpensesTotal: 950,
		},
	});
	assert.equal(priced.grossTotalAmount, 1200);
	assert.equal(priced.netTotalAmount, 950);

	const zero = resolveAdminReservationFinancialTotals({
		booking_source: "OTA",
		currency: "SAR",
		total_amount: 100,
		adminPricing: {
			mode: "ota_review",
			clientTotal: 100,
			netAfterExpensesTotal: 0,
		},
	});
	assert.equal(zero.netTotalAmount, 0);
	assert.equal(zero.netAvailable, true);

	const negative = resolveAdminReservationFinancialTotals({
		booking_source: "OTA",
		currency: "SAR",
		total_amount: 100,
		adminPricing: {
			mode: "admin_three_price",
			clientTotal: 100,
			netAfterExpensesTotal: -10,
		},
	});
	assert.equal(negative.netTotalAmount, -10);
	assert.equal(negative.netAvailable, true);
});

test("validated OTA evidence remains authoritative when legacy verification flags are false", () => {
	for (const fixture of [
		{ gross: 77, net: 47.64, provider: "agoda" },
		{ gross: 148.96, net: 92.18, provider: "agoda" },
		{ gross: 63.11, net: 59.59, provider: "trip" },
	]) {
		const totals = resolveAdminReservationFinancialTotals(
			hotelRunnerReservation(fixture)
		);
		assert.equal(totals.grossTotalAmount, fixture.gross, fixture.provider);
		assert.equal(totals.netTotalAmount, fixture.net, fixture.provider);
		assert.equal(totals.grossAvailable, true, fixture.provider);
		assert.equal(totals.netAvailable, true, fixture.provider);
		assert.equal(totals.grossSource, "ota_commercial_evidence");
		assert.equal(totals.netSource, "ota_commercial_evidence");
	}
});

test("tampered or conflicting OTA evidence fails closed instead of using paid or root amounts", () => {
	const reservation = hotelRunnerReservation();
	reservation.paid_amount = 75;
	reservation.sub_total = 75;
	reservation.adminPricing.netAfterExpensesTotal = 46;
	const totals = resolveAdminReservationFinancialTotals(reservation);
	assert.equal(totals.grossTotalAmount, 77);
	assert.equal(totals.netTotalAmount, null);
	assert.equal(totals.netAvailable, false);

	reservation.supplierData.otaCommercialEvidence = JSON.parse(
		JSON.stringify(reservation.supplierData.otaCommercialEvidence)
	);
	reservation.supplierData.otaCommercialEvidence.roles.hotelPayout.propertyAmount = 999;
	const tampered = resolveAdminReservationFinancialTotals(reservation);
	assert.equal(tampered.grossTotalAmount, null);
	assert.equal(tampered.netTotalAmount, null);
});

test("source-only foreign currency evidence is never relabelled as a SAR total", () => {
	const evidence = buildAuthenticatedProviderCommercialEvidence({
		provider: "expedia",
		authenticatedProvider: "expedia",
		sourceAuthenticated: true,
		sourceTrusted: true,
		sourceType: "authenticated_provider_portal",
		sourceCurrency: "USD",
		propertyCurrency: "SAR",
		bookingBasis: "reservation_total",
		sourceHash: HASH,
		sourceTimestamp: "2026-08-09T12:00:00.000Z",
		sourceId: "expedia-usd-1",
		guestGross: { verified: true, amount: 146.46 },
		hotelPayout: { verified: true, amount: 112.92 },
	});
	const totals = resolveAdminReservationFinancialTotals({
		booking_source: "expedia",
		adminPricing: { mode: "hotelrunner_api" },
		supplierData: {
			otaProvider: "expedia",
			otaCommercialEvidence: evidence,
			hotelRunner: { transport: "hotelrunner_api" },
		},
	});
	assert.equal(totals.grossTotalAmount, null);
	assert.equal(totals.netTotalAmount, null);
});

test("Trip.com is recognized as OTA-managed and an unmarked schema zero is not a payout", () => {
	const reservation = {
		booking_source: "trip.com",
		currency: "SAR",
		total_amount: 63.11,
		adminPricing: { mode: "", netAfterExpensesTotal: 0 },
	};
	assert.equal(hasOtaManagedPricingSignal(reservation), true);
	const totals = resolveAdminReservationFinancialTotals(reservation);
	assert.equal(totals.grossTotalAmount, 63.11);
	assert.equal(totals.netTotalAmount, null);

	const explicitlyUncalculated = resolveAdminReservationFinancialTotals({
		...reservation,
		adminPricing: {
			mode: "admin_three_price_not_calculated",
			netAfterExpensesTotal: 0,
		},
	});
	assert.equal(explicitlyUncalculated.netTotalAmount, null);
});
