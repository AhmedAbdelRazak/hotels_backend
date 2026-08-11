/** @format */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
	buildAuthenticatedProviderCommercialEvidence,
} = require("./otaCommercialEvidence");
const {
	ADMIN_REPORT_FINANCIAL_AMOUNT_PROJECTION,
	aggregateAdminReportFinancialAmounts,
	normalizeAdminReportFinancialMode,
	resolveAdminReportFinancialAmount,
} = require("./adminReportFinancialAmount");

const verifiedOtaReservation = ({ gross = 148.96, net = 92.18 } = {}) => {
	const evidence = buildAuthenticatedProviderCommercialEvidence({
		provider: "agoda",
		authenticatedProvider: "agoda",
		sourceAuthenticated: true,
		sourceTrusted: true,
		sourceType: "authenticated_provider_portal",
		sourceCurrency: "SAR",
		propertyCurrency: "SAR",
		bookingBasis: "reservation_total",
		sourceHash: "a".repeat(64),
		sourceTimestamp: "2026-08-10T12:00:00.000Z",
		sourceId: "agoda-admin-report-1",
		guestGross: { verified: true, amount: gross },
		hotelPayout: { verified: true, amount: net },
	});

	return {
		booking_source: "agoda",
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
			propertyCurrency: "SAR",
			clientTotal: gross,
			netAfterExpenses: net,
			commercialVerified: false,
		},
		supplierData: {
			otaProvider: "agoda",
			otaCommercialEvidenceStaleReason: "",
			otaCommercialEvidence: evidence,
			hotelRunner: { transport: "hotelrunner_api" },
		},
	};
};

test("normalizes only gross and net, defaulting every unsupported mode to gross", () => {
	assert.equal(normalizeAdminReportFinancialMode(" NET "), "net");
	assert.equal(normalizeAdminReportFinancialMode("Gross"), "gross");
	for (const value of [undefined, null, "", "payout", "net_total", 1]) {
		assert.equal(normalizeAdminReportFinancialMode(value), "gross");
	}
});

test("exports every field needed by the canonical financial resolver", () => {
	const fields = new Set(ADMIN_REPORT_FINANCIAL_AMOUNT_PROJECTION.split(/\s+/));
	for (const field of [
		"total_amount",
		"currency",
		"booking_source",
		"adminPricing",
		"adminPricingVisibility.rootOnlyForHotelManagement",
		"ota_financial_summary",
		"otaFinancialSummary",
		"otaPlatformReview",
		"supplierData.otaCommercialEvidence",
		"supplierData.hotelRunnerEmailCommercialEvidence",
		"supplierData.hotelRunner.transport",
		"supplierData.otaAutomationPipeline",
		"supplierData.otaPaymentSummary",
		"otaIdentityKey",
		"otaCrossTransportIdentityKey",
		"pickedRoomsPricing",
		"commission_ota",
	]) {
		assert.equal(fields.has(field), true, `${field} must be projected`);
	}
});

test("direct reservations use their guest total for both gross and net", () => {
	const reservation = {
		booking_source: "direct",
		currency: "SAR",
		total_amount: 2000,
		adminPricing: { mode: "standard" },
	};
	const gross = resolveAdminReportFinancialAmount(reservation, "gross");
	const net = resolveAdminReportFinancialAmount(reservation, "net");

	assert.equal(gross.amount, 2000);
	assert.equal(net.amount, 2000);
	assert.equal(net.netFallback, false);
});

test("verified OTA evidence selects distinct guest gross and hotel payout", () => {
	const reservation = verifiedOtaReservation();
	const gross = resolveAdminReportFinancialAmount(reservation, "gross");
	const net = resolveAdminReportFinancialAmount(reservation, "net");

	assert.deepEqual(
		{ amount: gross.amount, currency: gross.currency, sourceMode: gross.sourceMode },
		{ amount: 148.96, currency: "SAR", sourceMode: "gross" }
	);
	assert.deepEqual(
		{ amount: net.amount, currency: net.currency, sourceMode: net.sourceMode },
		{ amount: 92.18, currency: "SAR", sourceMode: "net" }
	);
});

test("net mode falls back only to a canonical available gross", () => {
	const reservation = {
		booking_source: "trip.com",
		currency: "SAR",
		total_amount: 63.11,
		adminPricing: { mode: "", netAfterExpensesTotal: 0 },
	};
	const selected = resolveAdminReportFinancialAmount(reservation, "net");
	const aggregate = aggregateAdminReportFinancialAmounts([reservation], "net");

	assert.equal(selected.amount, 63.11);
	assert.equal(selected.netFallback, true);
	assert.equal(selected.sourceMode, "gross");
	assert.deepEqual(aggregate.metadata, {
		netFallback: 1,
		unavailable: 0,
		foreignCurrency: 0,
	});
});

test("valid zero and negative calculated nets remain available", () => {
	const reservations = [];
	for (const net of [0, -10]) {
		const reservation = {
			booking_source: "OTA",
			currency: "SAR",
			total_amount: 100,
			adminPricing: {
				mode: "admin_three_price",
				clientTotal: 100,
				netAfterExpensesTotal: net,
			},
		};
		reservations.push(reservation);
		const selected = resolveAdminReportFinancialAmount(reservation, "net");
		assert.equal(selected.available, true);
		assert.equal(selected.amount, net);
		assert.equal(selected.netFallback, false);
	}

	const aggregate = aggregateAdminReportFinancialAmounts(reservations, "net");
	assert.equal(aggregate.totalAmount, -10);
	assert.equal(aggregate.includedCount, 2);
});

test("an unavailable canonical gross fails closed", () => {
	const reservation = {
		booking_source: "agoda",
		currency: "SAR",
		total_amount: 77,
		adminPricing: { mode: "hotelrunner_api" },
		supplierData: { hotelRunner: { transport: "hotelrunner_api" } },
	};
	const selected = resolveAdminReportFinancialAmount(reservation, "gross");
	const aggregate = aggregateAdminReportFinancialAmounts([reservation], "gross");

	assert.equal(selected.available, false);
	assert.equal(selected.amount, null);
	assert.equal(selected.reason, "gross_unavailable");
	assert.equal(aggregate.totalAmount, 0);
	assert.equal(aggregate.includedCount, 0);
	assert.equal(aggregate.metadata.unavailable, 1);
});

test("aggregation excludes foreign currencies without relabelling them as SAR", () => {
	const aggregate = aggregateAdminReportFinancialAmounts(
		[
			{ booking_source: "direct", currency: "SAR", total_amount: 100 },
			{ booking_source: "direct", currency: "USD", total_amount: 200 },
		],
		"gross"
	);

	assert.equal(aggregate.totalAmount, 100);
	assert.equal(aggregate.totalCents, 10000);
	assert.equal(aggregate.includedCount, 1);
	assert.deepEqual(aggregate.metadata, {
		netFallback: 0,
		unavailable: 0,
		foreignCurrency: 1,
	});
});

test("aggregation sums integer cents without floating-point drift", () => {
	const aggregate = aggregateAdminReportFinancialAmounts(
		[
			{ booking_source: "direct", currency: "SAR", total_amount: 0.1 },
			{ booking_source: "direct", currency: "SAR", total_amount: 0.2 },
			{ booking_source: "direct", currency: "SAR", total_amount: 10.01 },
		],
		"gross"
	);

	assert.equal(aggregate.totalCents, 1031);
	assert.equal(aggregate.totalAmount, 10.31);
	assert.equal(aggregate.includedCount, 3);
});
