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

const savedHotelRunnerPricing = () => ({
	booking_source: "channel-partner",
	currency: "SAR",
	total_amount: 65.03,
	adminPricing: {
		mode: "ota_review",
		clientTotal: 65.03,
		rootTotal: 75,
		netAfterExpensesTotal: 52.02,
		otaExpenseTotal: 13.01,
		platformMarginTotal: -22.98,
	},
	adminPricingVisibility: { rootOnlyForHotelManagement: true },
	supplierData: {
		hotelRunner: {
			transport: "hotelrunner_api",
			reservationId: "channel-reservation-1",
		},
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

test("stored calculated pricing roles feed HotelRunner rows for any OTA provider", () => {
	for (const bookingSource of ["channel-partner-a", "channel-partner-b"]) {
		const totals = resolveAdminReservationFinancialTotals({
			booking_source: bookingSource,
			currency: "sar",
			total_amount: 65.03,
			adminPricing: {
				mode: "ota_review",
				clientTotal: 65.03,
				rootTotal: 75,
				netAfterExpensesTotal: 52.02,
				otaExpenseTotal: 13.01,
				platformMarginTotal: -22.98,
			},
			adminPricingVisibility: { rootOnlyForHotelManagement: true },
			supplierData: {
				otaProvider: bookingSource,
				hotelRunner: {
					transport: "hotelrunner_api",
					reservationId: `${bookingSource}-reservation-1`,
				},
			},
		});

		assert.equal(totals.grossTotalAmount, 65.03);
		assert.equal(totals.netTotalAmount, 52.02);
		assert.equal(totals.currency, "SAR");
		assert.equal(totals.grossAvailable, true);
		assert.equal(totals.netAvailable, true);
		assert.equal(totals.grossSource, "saved_pricing_breakdown");
		assert.equal(totals.netSource, "saved_pricing_breakdown");
	}
});

test("raw HotelRunner API totals remain unavailable without commercial evidence", () => {
	const reservation = savedHotelRunnerPricing();
	reservation.adminPricing.mode = "hotelrunner_api";
	const totals = resolveAdminReservationFinancialTotals(reservation);
	assert.equal(totals.grossTotalAmount, null);
	assert.equal(totals.netTotalAmount, null);
	assert.equal(totals.grossAvailable, false);
	assert.equal(totals.netAvailable, false);
});

test("saved HotelRunner pricing rejects schema zero, incomplete roles, and missing currency", () => {
	const schemaZero = savedHotelRunnerPricing();
	Object.assign(schemaZero.adminPricing, {
		clientTotal: 0,
		netAfterExpensesTotal: 0,
		otaExpenseTotal: 0,
	});

	const incomplete = savedHotelRunnerPricing();
	delete incomplete.adminPricing.otaExpenseTotal;

	const missingCurrency = savedHotelRunnerPricing();
	delete missingCurrency.currency;

	for (const reservation of [schemaZero, incomplete, missingCurrency]) {
		const totals = resolveAdminReservationFinancialTotals(reservation);
		assert.equal(totals.grossTotalAmount, null);
		assert.equal(totals.netTotalAmount, null);
	}
});

test("saved HotelRunner pricing permits zero and negative net roles when the paired breakdown reconciles", () => {
	for (const [net, expense] of [
		[0, 65.03],
		[-1, 66.03],
	]) {
		const reservation = savedHotelRunnerPricing();
		reservation.adminPricing.netAfterExpensesTotal = net;
		reservation.adminPricing.otaExpenseTotal = expense;
		const totals = resolveAdminReservationFinancialTotals(reservation);
		assert.equal(totals.grossTotalAmount, 65.03);
		assert.equal(totals.netTotalAmount, net);
	}
});

test("saved HotelRunner pricing uses the 0.50 reconciliation and summary boundary", () => {
	const reconciliationBoundary = savedHotelRunnerPricing();
	reconciliationBoundary.adminPricing.otaExpenseTotal = 12.51;
	assert.equal(
		resolveAdminReservationFinancialTotals(reconciliationBoundary)
			.grossTotalAmount,
		65.03
	);

	const reconciliationConflict = savedHotelRunnerPricing();
	reconciliationConflict.adminPricing.otaExpenseTotal = 12.5;
	assert.equal(
		resolveAdminReservationFinancialTotals(reconciliationConflict)
			.grossTotalAmount,
		null
	);

	const summaryBoundary = savedHotelRunnerPricing();
	summaryBoundary.ota_financial_summary = {
		currency: "SAR",
		clientTotal: 65.53,
		netAfterExpenses: 51.52,
	};
	assert.equal(
		resolveAdminReservationFinancialTotals(summaryBoundary).netTotalAmount,
		52.02
	);

	const summaryConflict = savedHotelRunnerPricing();
	summaryConflict.ota_financial_summary = {
		currency: "SAR",
		clientTotal: 65.54,
		netAfterExpenses: 52.02,
	};
	assert.equal(
		resolveAdminReservationFinancialTotals(summaryConflict).netTotalAmount,
		null
	);
});

test("present invalid, stale, or conflicting evidence never falls back to saved pricing", () => {
	const invalid = savedHotelRunnerPricing();
	invalid.supplierData.otaCommercialEvidence = { invalid: true };

	const stale = savedHotelRunnerPricing();
	stale.supplierData.otaCommercialEvidence = verifiedEvidence({
		gross: 65.03,
		net: 52.02,
	});
	stale.supplierData.otaCommercialEvidenceStaleReason = "superseded";

	const conflicting = savedHotelRunnerPricing();
	conflicting.supplierData.otaCommercialEvidence = verifiedEvidence({
		gross: 90,
		net: 80,
	});

	for (const reservation of [invalid, stale, conflicting]) {
		const totals = resolveAdminReservationFinancialTotals(reservation);
		assert.equal(totals.grossTotalAmount, null);
		assert.equal(totals.netTotalAmount, null);
	}
});

test("malformed or explicitly present evidence markers block the saved-pricing fallback", () => {
	for (const marker of [
		{ otaCommercialEvidence: "tampered" },
		{ otaCommercialEvidence: [] },
		{ otaCommercialEvidence: null },
		{ hotelRunnerEmailCommercialEvidence: "tampered" },
		{ hotelRunnerEmailCommercialEvidence: [] },
		{ otaCommercialEvidenceStaleReason: "stale_without_payload" },
	]) {
		const reservation = savedHotelRunnerPricing();
		Object.assign(reservation.supplierData, marker);
		reservation.adminPricing.commercialVerified = true;
		reservation.ota_financial_summary = {
			commercialVerified: true,
			currency: "SAR",
			clientTotal: 65.03,
			netAfterExpenses: 52.02,
			netAfterOtaExpenses: 52.02,
			otaExpenseTotal: 13.01,
		};
		const totals = resolveAdminReservationFinancialTotals(reservation);
		assert.equal(totals.grossTotalAmount, null);
		assert.equal(totals.netTotalAmount, null);
	}
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
