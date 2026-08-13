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
const {
	hotelRunnerEmailCommercialEvidenceHash,
} = require("./otaReservationMapper");

const HASH = "a".repeat(64);

const rehashLegacyMarker = (reservation) => {
	const marker =
		reservation.supplierData.hotelRunnerEmailCommercialEvidence;
	marker.evidenceHash = hotelRunnerEmailCommercialEvidenceHash(marker);
};

const verifiedEvidence = ({
	provider = "agoda",
	gross,
	net,
	sourceType = "authenticated_provider_portal",
}) =>
	buildAuthenticatedProviderCommercialEvidence({
		provider,
		authenticatedProvider: provider,
		sourceAuthenticated: true,
		sourceTrusted: true,
		sourceType,
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

const auditedOtaPricingOverride = () => {
	const actorId = "64a000000000000000000001";
	const reviewedAt = "2026-08-13T19:35:15.199Z";
	const otaIdentityKey = "agoda:2041081954";
	const legacyMarker = {
		version: 2,
		verified: true,
		source: "authenticated_ota_email",
		provider: "agoda",
		otaIdentityKey,
		grossTotalSar: 490.9,
		payoutTotalSar: 303.69,
		otaExpenseTotalSar: 187.21,
		otaCommissionSar: null,
		deductionComponents: [],
		unclassifiedDeductionSar: 187.21,
		unpricedDeductionLabels: [],
		currency: "SAR",
		inboundEmailId: "agoda-reservation-1",
		sourceTextHash: HASH,
		sourceReceivedAt: "2026-08-09T12:00:00.000Z",
		appliedAt: new Date("2026-08-13T18:01:00.000Z"),
	};
	legacyMarker.evidenceHash =
		hotelRunnerEmailCommercialEvidenceHash(legacyMarker);
	const pricingByDay = Array.from({ length: 8 }, (_, index) => ({
		date: `2026-08-${String(index + 13).padStart(2, "0")}`,
		price: 60.15,
		totalPriceWithCommission: 60.15,
		rootPrice: 51,
		totalPriceWithoutCommission: 51,
		clientPrice: 60.15,
		netAfterExpenses: 37.21,
		netAfterOtaExpenses: 37.21,
		otaExpenseAmount: 22.94,
		platformMargin: -13.79,
	}));
	return {
		otaIdentityKey,
		booking_source: "agoda",
		currency: "sar",
		total_amount: 481.2,
		adminPricing: {
			mode: "admin_three_price",
			clientTotal: 481.2,
			rootTotal: 408,
			netAfterExpensesTotal: 297.68,
			otaExpenseTotal: 183.52,
			platformMarginTotal: -110.32,
			commercialVerified: true,
			sourceCurrency: "SAR",
			sourceClientTotalSar: 490.9,
			sourceClientTotalSource: "supplierData.otaAmountSar",
			clientTotalOverrideActive: true,
			clientTotalOverrideSar: 481.2,
			clientTotalOverrideOriginalSar: 490.9,
			clientTotalOverrideAt: reviewedAt,
			clientTotalOverrideBy: { _id: actorId, role: 1000 },
			clientTotalOverrideSource: "platform_ota_pricing_review",
		},
		otaPlatformReview: {
			status: "released",
			lastPricingUpdatedAt: reviewedAt,
			lastPricingUpdatedBy: { _id: actorId, role: 1000 },
		},
		ota_financial_summary: {
			clientTotal: 490.9,
			netAfterExpenses: 303.69,
			netAfterOtaExpenses: 303.69,
			otaExpenseTotal: 187.21,
			propertyCurrency: "SAR",
		},
		pickedRoomsPricing: [
			{
				room_type: "doubleRooms",
				displayName: "Double Room",
				count: 1,
				pricingByDay,
			},
		],
		supplierData: {
			otaProvider: "agoda",
			otaCommercialEvidenceStaleReason: "",
			hotelRunnerEmailCommercialEvidence: legacyMarker,
			otaCommercialEvidence: verifiedEvidence({
				provider: "agoda",
				gross: 490.9,
				net: 303.69,
				sourceType: "authenticated_ota_email",
			}),
		},
	};
};

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

test("a fully reconciled audited OTA review override supersedes immutable source evidence for display", () => {
	const totals = resolveAdminReservationFinancialTotals(
		auditedOtaPricingOverride()
	);
	assert.deepEqual(totals, {
		grossTotalAmount: 481.2,
		netTotalAmount: 297.68,
		currency: "SAR",
		grossAvailable: true,
		netAvailable: true,
		grossSource: "audited_ota_pricing_override",
		netSource: "audited_ota_pricing_override",
		isOtaManaged: true,
		isHotelRunner: false,
	});
});

test("audited OTA overrides fail closed when any server stamp or pricing invariant is broken", () => {
	const variants = [
		(reservation) => {
			reservation.adminPricing.clientTotalOverrideActive = false;
		},
		(reservation) => {
			reservation.adminPricing.clientTotalOverrideSource = "manual";
		},
		(reservation) => {
			reservation.adminPricing.clientTotalOverrideBy = {};
		},
		(reservation) => {
			reservation.adminPricing.clientTotalOverrideAt = "invalid";
		},
		(reservation) => {
			reservation.otaPlatformReview.lastPricingUpdatedAt =
				"2026-08-13T19:35:16.199Z";
		},
		(reservation) => {
			reservation.adminPricing.clientTotalOverrideSar = 482;
		},
		(reservation) => {
			reservation.adminPricing.clientTotalOverrideOriginalSar = 490;
		},
		(reservation) => {
			reservation.adminPricing.netAfterExpensesTotal = 297;
		},
		(reservation) => {
			reservation.pickedRoomsPricing[0].pricingByDay[0].netAfterExpenses =
				37.2;
		},
		(reservation) => {
			reservation.currency = "USD";
		},
		(reservation) => {
			reservation.supplierData.otaCommercialEvidence = JSON.parse(
				JSON.stringify(reservation.supplierData.otaCommercialEvidence)
			);
			reservation.supplierData.otaCommercialEvidence.roles.guestGross.propertyAmount = 999;
		},
		(reservation) => {
			reservation.supplierData.hotelRunnerEmailCommercialEvidence.sourceTextHash =
				"b".repeat(64);
			rehashLegacyMarker(reservation);
		},
		(reservation) => {
			reservation.supplierData.hotelRunnerEmailCommercialEvidence.inboundEmailId =
				"another-inbound-email";
			rehashLegacyMarker(reservation);
		},
		(reservation) => {
			reservation.supplierData.hotelRunnerEmailCommercialEvidence.sourceReceivedAt =
				"2026-08-09T12:00:01.000Z";
			rehashLegacyMarker(reservation);
		},
		(reservation) => {
			reservation.supplierData.hotelRunnerEmailCommercialEvidence.version = "2";
		},
		(reservation) => {
			reservation.supplierData.hotelRunnerEmailCommercialEvidence.grossTotalSar =
				"490.90";
		},
		(reservation) => {
			reservation.supplierData.hotelRunnerEmailCommercialEvidence.deductionComponents =
				{};
		},
		(reservation) => {
			reservation.supplierData.hotelRunnerEmailCommercialEvidence.provider =
				"trip";
			rehashLegacyMarker(reservation);
		},
		(reservation) => {
			reservation.supplierData.otaProvider = "trip";
		},
		(reservation) => {
			reservation.supplierData.otaCommercialEvidence = JSON.parse(
				JSON.stringify(reservation.supplierData.otaCommercialEvidence)
			);
			reservation.supplierData.otaCommercialEvidence.provenance.primary.sourceType =
				"authenticated_provider_portal";
		},
		(reservation) => {
			reservation.pickedRoomsPricing[0].count = 1.5;
		},
		(reservation) => {
			reservation.ota_financial_summary.otaExpenseTotal = 187.2;
		},
		(reservation) => {
			const marker =
				reservation.supplierData.hotelRunnerEmailCommercialEvidence;
			marker.payoutTotalSar = 303.68;
			marker.otaExpenseTotalSar = 187.22;
			marker.unclassifiedDeductionSar = 187.22;
			rehashLegacyMarker(reservation);
		},
		(reservation) => {
			reservation.supplierData.otaCommercialEvidence = JSON.parse(
				JSON.stringify(reservation.supplierData.otaCommercialEvidence)
			);
			reservation.supplierData.otaCommercialEvidence.roles.hotelPayout.propertyAmount =
				303.68;
		},
	];
	for (const mutate of variants) {
		const reservation = auditedOtaPricingOverride();
		mutate(reservation);
		const totals = resolveAdminReservationFinancialTotals(reservation);
		assert.equal(totals.grossTotalAmount, null);
		assert.equal(totals.netTotalAmount, null);
	}
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
