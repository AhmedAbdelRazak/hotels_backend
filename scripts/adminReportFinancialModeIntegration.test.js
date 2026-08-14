/** @format */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const Reservations = require("../models/reservations");
const HotelDetails = require("../models/hotel_details");
const {
	buildAuthenticatedProviderCommercialEvidence,
} = require("../services/otaCommercialEvidence");
const {
	bookingSourcePaymentSummary,
	checkoutDatePaymentSummary,
	hotelOccupancyCalendar,
	paidBreakdownReportAdmin,
} = require("../controllers/adminreports");

const HOTEL_ID = "68b74714fb50e159d48c714d";

const makeResponse = () => ({
	statusCode: 200,
	payload: undefined,
	headers: {},
	status(code) {
		this.statusCode = code;
		return this;
	},
	set(name, value) {
		this.headers[name] = value;
		return this;
	},
	json(payload) {
		this.payload = payload;
		return payload;
	},
});

const verifiedOtaReservation = ({
	confirmation = "OTA-VERIFIED",
	gross = 148.96,
	net = 92.18,
} = {}) => {
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
		sourceId: `${confirmation}-source`,
		guestGross: { verified: true, amount: gross },
		hotelPayout: { verified: true, amount: net },
	});

	return {
		confirmation_number: confirmation,
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

const savedTripSourceOnlyReservation = () => ({
	confirmation_number: "TRIP-SAVED-SOURCE-ONLY",
	booking_source: "trip.com",
	currency: "SAR",
	total_amount: 372.83,
	adminPricing: {
		mode: "ota_review",
		propertyCurrency: "SAR",
		clientTotal: 372.83,
		rootTotal: 306,
		netAfterExpensesTotal: 352.13,
		otaExpenseTotal: 20.7,
	},
	supplierData: {
		otaProvider: "trip",
		otaCommercialEvidence: buildAuthenticatedProviderCommercialEvidence({
			provider: "trip",
			authenticatedProvider: "trip",
			sourceAuthenticated: true,
			sourceTrusted: true,
			sourceType: "authenticated_ota_email",
			sourceCurrency: "USD",
			propertyCurrency: "SAR",
			bookingBasis: "reservation_total",
			sourceHash: "b".repeat(64),
			sourceTimestamp: "2026-08-14T05:00:00.000Z",
			sourceId: "trip-1567953939695657",
			guestGross: { verified: true, amount: 99.42 },
			hotelPayout: { verified: true, amount: 93.9 },
		}),
	},
	paid_amount_breakdown: { paid_online_other_platforms: 6 },
});

const paidReportFixtures = () => [
	{
		...verifiedOtaReservation(),
		paid_amount_breakdown: { paid_online_via_link: 10 },
	},
	{
		confirmation_number: "DIRECT",
		booking_source: "direct",
		currency: "SAR",
		total_amount: 20.01,
		adminPricing: { mode: "standard" },
		paid_amount_breakdown: { paid_at_hotel_cash: 2 },
	},
	{
		confirmation_number: "NET-FALLBACK",
		booking_source: "trip.com",
		currency: "SAR",
		total_amount: 63.11,
		adminPricing: { mode: "", netAfterExpensesTotal: 0 },
		paid_amount_breakdown: { paid_at_hotel_card: 3 },
	},
	{
		confirmation_number: "ZERO-NET",
		booking_source: "OTA",
		currency: "SAR",
		total_amount: 100,
		adminPricing: {
			mode: "admin_three_price",
			clientTotal: 100,
			netAfterExpensesTotal: 0,
		},
		paid_amount_breakdown: { paid_to_hotel: 4 },
	},
	{
		confirmation_number: "NEGATIVE-NET",
		booking_source: "OTA",
		currency: "SAR",
		total_amount: 100,
		adminPricing: {
			mode: "admin_three_price",
			clientTotal: 100,
			netAfterExpensesTotal: -10,
		},
		paid_amount_breakdown: { paid_online_jannatbooking: 5 },
	},
	savedTripSourceOnlyReservation(),
	{
		confirmation_number: "FOREIGN",
		booking_source: "direct",
		currency: "USD",
		total_amount: 50,
		adminPricing: { mode: "standard" },
		paid_amount_breakdown: { paid_online_via_instapay: 7 },
	},
];

const paidAggregateSummary = {
	totalAmount: 9999,
	paidAmount: 37,
	paid_online_via_link: 10,
	paid_at_hotel_cash: 2,
	paid_at_hotel_card: 3,
	paid_to_hotel: 4,
	paid_online_jannatbooking: 5,
	paid_online_other_platforms: 6,
	paid_online_via_instapay: 7,
	paid_no_show: 0,
};

const withPaidReportMocks = async (reservations, callback) => {
	const originals = {
		countDocuments: Reservations.countDocuments,
		find: Reservations.find,
		aggregate: Reservations.aggregate,
	};
	const observed = { countFilters: [], findCalls: [], aggregateMatches: [] };

	Reservations.countDocuments = async (filter) => {
		observed.countFilters.push(filter);
		return reservations.length;
	};
	Reservations.find = (filter) => {
		const call = { filter, projection: null };
		observed.findCalls.push(call);
		return {
			sort() {
				return this;
			},
			skip() {
				return this;
			},
			limit() {
				return this;
			},
			populate() {
				return this;
			},
			select(projection) {
				call.projection = projection;
				return this;
			},
			lean: async () => reservations,
		};
	};
	Reservations.aggregate = async (pipeline) => {
		observed.aggregateMatches.push(pipeline?.[0]?.$match || null);
		return [{ ...paidAggregateSummary }];
	};

	try {
		await callback(observed);
	} finally {
		Reservations.countDocuments = originals.countDocuments;
		Reservations.find = originals.find;
		Reservations.aggregate = originals.aggregate;
	}
};

const paidReportResponse = async (totalMode) => {
	const res = makeResponse();
	await paidBreakdownReportAdmin(
		{
			query: { hotelId: HOTEL_ID, totalMode },
			profile: { role: 8000 },
		},
		res,
	);
	assert.equal(res.statusCode, 200);
	return res.payload;
};

const rowsByConfirmation = (payload) =>
	new Map(
		(payload?.data || []).map((row) => [row.confirmation_number, row]),
	);

test("paid admin rows and scorecards select canonical gross/net while paid facts stay fixed", async () => {
	const reservations = paidReportFixtures();
	await withPaidReportMocks(reservations, async (observed) => {
		const gross = await paidReportResponse("gross");
		const net = await paidReportResponse("net");
		const grossRows = rowsByConfirmation(gross);
		const netRows = rowsByConfirmation(net);

		assert.equal(gross.totalDocuments, reservations.length);
		assert.equal(net.totalDocuments, reservations.length);
		assert.equal(gross.scorecards.totalAmount, 804.91);
		assert.equal(net.scorecards.totalAmount, 517.43);
		assert.equal(gross.scorecards.financialIncludedCount, 6);
		assert.equal(net.scorecards.financialIncludedCount, 6);
		assert.deepEqual(gross.scorecards.financialMetadata, {
			netFallback: 0,
			unavailable: 0,
			foreignCurrency: 1,
		});
		assert.deepEqual(net.scorecards.financialMetadata, {
			netFallback: 1,
			unavailable: 0,
			foreignCurrency: 1,
		});

		assert.equal(grossRows.get("OTA-VERIFIED").report_total_amount, 148.96);
		assert.equal(netRows.get("OTA-VERIFIED").report_total_amount, 92.18);
		assert.equal(grossRows.get("DIRECT").report_total_amount, 20.01);
		assert.equal(netRows.get("DIRECT").report_total_amount, 20.01);
		assert.equal(netRows.get("NET-FALLBACK").report_total_amount, 63.11);
		assert.equal(netRows.get("NET-FALLBACK").report_total_net_fallback, true);
		assert.equal(netRows.get("ZERO-NET").report_total_amount, 0);
		assert.equal(netRows.get("ZERO-NET").report_total_available, true);
		assert.equal(netRows.get("NEGATIVE-NET").report_total_amount, -10);
		assert.equal(netRows.get("NEGATIVE-NET").report_total_available, true);
		assert.equal(netRows.get("NEGATIVE-NET").paid_breakdown_remaining, 0);
		assert.equal(
			grossRows.get("TRIP-SAVED-SOURCE-ONLY").report_total_amount,
			372.83,
		);
		assert.equal(
			netRows.get("TRIP-SAVED-SOURCE-ONLY").report_total_amount,
			352.13,
		);
		assert.equal(
			netRows.get("TRIP-SAVED-SOURCE-ONLY").paid_breakdown_remaining,
			346.13,
		);
		assert.equal(grossRows.get("FOREIGN").financial_totals_currency, "USD");
		assert.equal(grossRows.get("FOREIGN").report_total_available, false);
		assert.equal(netRows.get("FOREIGN").report_total_amount, null);

		assert.deepEqual(
			gross.data.map((row) => row.paid_breakdown_total),
			net.data.map((row) => row.paid_breakdown_total),
		);
		assert.equal(gross.scorecards.paidAmount, 37);
		assert.equal(net.scorecards.paidAmount, 37);
		assert.deepEqual(
			gross.scorecards.breakdownTotals,
			net.scorecards.breakdownTotals,
		);
		assert.notEqual(gross.scorecards.totalAmount, paidAggregateSummary.totalAmount);

		assert.equal(observed.countFilters.length, 2);
		assert.equal(observed.findCalls.length, 4);
		assert.equal(observed.aggregateMatches.length, 2);
		for (let index = 0; index < 2; index += 1) {
			const rowFind = observed.findCalls[index * 2];
			const financialFind = observed.findCalls[index * 2 + 1];
			assert.equal(rowFind.filter, observed.countFilters[index]);
			assert.equal(financialFind.filter, observed.aggregateMatches[index]);
			assert.match(financialFind.projection, /\bsupplierData\b/);
		}
	});
});

test("paid continuation pages can skip full-dataset scorecard recomputation", async () => {
	const reservations = paidReportFixtures();
	await withPaidReportMocks(reservations, async (observed) => {
		const res = makeResponse();
		await paidBreakdownReportAdmin(
			{
				query: {
					hotelId: HOTEL_ID,
					totalMode: "net",
					includeScorecards: "false",
				},
				profile: { role: 8000 },
			},
			res
		);

		assert.equal(res.statusCode, 200);
		assert.equal(res.payload?.scorecards, null);
		assert.equal(res.payload?.totalMode, "net");
		assert.equal(observed.countFilters.length, 1);
		assert.equal(observed.findCalls.length, 1);
		assert.equal(observed.aggregateMatches.length, 0);
	});
});

const inventoryMatrixFixtures = () =>
	paidReportFixtures().map((reservation, index) => ({
		...reservation,
		checkin_date: new Date(
			`2026-07-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
		),
		checkout_date: new Date(
			`2026-07-${String(index + 2).padStart(2, "0")}T00:00:00.000Z`,
		),
		reservation_status: "confirmed",
	}));

const withInventoryMatrixMocks = async (reservations, callback) => {
	const originalFind = Reservations.find;
	const observed = { findCalls: [] };

	Reservations.find = (filter) => {
		const call = { filter, projection: null };
		observed.findCalls.push(call);
		return {
			select(projection) {
				call.projection = projection;
				return this;
			},
			lean: async () => reservations,
		};
	};

	try {
		await callback(observed);
	} finally {
		Reservations.find = originalFind;
	}
};

const inventorySummaryResponse = async (
	handler,
	{ totalMode, dateBasis = "stay" },
) => {
	const res = makeResponse();
	await handler(
		{
			query: {
				hotelId: HOTEL_ID,
				start: "2026-07-01",
				end: "2026-07-08",
				dateBasis,
				totalMode,
			},
			profile: { role: 8000 },
		},
		res,
	);
	assert.equal(res.statusCode, 200);
	assert.equal(res.payload?.success, true);
	assert.equal(res.payload?.totalMode, totalMode);
	assert.equal(res.payload?.data?.totalMode, totalMode);
	return res.payload.data;
};

const cents = (value) => Math.round(Number(value || 0) * 100);

const assertMatrixReconciles = (summary, expectedOverall) => {
	assert.equal(summary.overallTotal, expectedOverall);
	assert.equal(summary.columnTotals.Captured, expectedOverall);
	assert.equal(
		Object.values(summary.columnTotals).reduce(
			(sum, value) => sum + cents(value),
			0,
		),
		cents(summary.overallTotal),
	);
	assert.equal(
		summary.rows.reduce((sum, row) => sum + cents(row.rowTotal), 0),
		cents(summary.overallTotal),
	);
	for (const row of summary.rows) {
		assert.equal(
			Object.values(row.totalsByStatus).reduce(
				(sum, value) => sum + cents(value),
				0,
			),
			cents(row.rowTotal),
		);
	}
};

const rowTotalsBy = (summary, key) =>
	Object.fromEntries(
		summary.rows.map((row) => [row[key], row.rowTotal]),
	);

test("inventory booking-source and check-in/checkout matrices reconcile every gross/net total", async () => {
	const reservations = inventoryMatrixFixtures();
	await withInventoryMatrixMocks(reservations, async (observed) => {
		const sourceGross = await inventorySummaryResponse(
			bookingSourcePaymentSummary,
			{ totalMode: "gross" },
		);
		const sourceNet = await inventorySummaryResponse(
			bookingSourcePaymentSummary,
			{ totalMode: "net" },
		);
		const checkinGross = await inventorySummaryResponse(
			checkoutDatePaymentSummary,
			{ totalMode: "gross", dateBasis: "checkin" },
		);
		const checkinNet = await inventorySummaryResponse(
			checkoutDatePaymentSummary,
			{ totalMode: "net", dateBasis: "checkin" },
		);
		const checkoutGross = await inventorySummaryResponse(
			checkoutDatePaymentSummary,
			{ totalMode: "gross", dateBasis: "checkout" },
		);
		const checkoutNet = await inventorySummaryResponse(
			checkoutDatePaymentSummary,
			{ totalMode: "net", dateBasis: "checkout" },
		);

		for (const summary of [sourceGross, checkinGross, checkoutGross]) {
			assertMatrixReconciles(summary, 804.91);
			assert.deepEqual(summary.financialMetadata, {
				netFallback: 0,
				unavailable: 0,
				foreignCurrency: 1,
			});
		}
		for (const summary of [sourceNet, checkinNet, checkoutNet]) {
			assertMatrixReconciles(summary, 517.43);
			assert.deepEqual(summary.financialMetadata, {
				netFallback: 1,
				unavailable: 0,
				foreignCurrency: 1,
			});
		}

		assert.deepEqual(rowTotalsBy(sourceGross, "booking_source"), {
			agoda: 148.96,
			direct: 20.01,
			"trip.com": 435.94,
			OTA: 200,
		});
		assert.deepEqual(rowTotalsBy(sourceNet, "booking_source"), {
			agoda: 92.18,
			direct: 20.01,
			"trip.com": 415.24,
			OTA: -10,
		});

		assert.deepEqual(rowTotalsBy(checkinGross, "checkin_date"), {
			"2026-07-01": 148.96,
			"2026-07-02": 20.01,
			"2026-07-03": 63.11,
			"2026-07-04": 100,
			"2026-07-05": 100,
			"2026-07-06": 372.83,
			"2026-07-07": 0,
		});
		assert.deepEqual(rowTotalsBy(checkinNet, "checkin_date"), {
			"2026-07-01": 92.18,
			"2026-07-02": 20.01,
			"2026-07-03": 63.11,
			"2026-07-04": 0,
			"2026-07-05": -10,
			"2026-07-06": 352.13,
			"2026-07-07": 0,
		});
		assert.deepEqual(rowTotalsBy(checkoutGross, "checkout_date"), {
			"2026-07-02": 148.96,
			"2026-07-03": 20.01,
			"2026-07-04": 63.11,
			"2026-07-05": 100,
			"2026-07-06": 100,
			"2026-07-07": 372.83,
			"2026-07-08": 0,
		});
		assert.deepEqual(rowTotalsBy(checkoutNet, "checkout_date"), {
			"2026-07-02": 92.18,
			"2026-07-03": 20.01,
			"2026-07-04": 63.11,
			"2026-07-05": 0,
			"2026-07-06": -10,
			"2026-07-07": 352.13,
			"2026-07-08": 0,
		});

		assert.equal(checkinGross.overallReservationsCount, reservations.length);
		assert.equal(checkinNet.overallReservationsCount, reservations.length);
		assert.equal(checkoutGross.overallReservationsCount, reservations.length);
		assert.equal(checkoutNet.overallReservationsCount, reservations.length);
		assert.equal(observed.findCalls.length, 6);
		observed.findCalls.forEach((call) => {
			assert.match(call.projection, /\badminPricingVisibility\b/);
			assert.match(call.projection, /\bsupplierData\b/);
			assert.deepEqual(call.filter["otaPlatformReview.status"], {
				$ne: "pending",
			});
		});
	});
});

const withOccupancyMocks = async (reservation, callback) => {
	const originals = {
		findById: HotelDetails.findById,
		find: Reservations.find,
	};
	const observed = { hotelProjection: null, reservationProjections: [] };

	HotelDetails.findById = () => ({
		select(projection) {
			observed.hotelProjection = projection;
			return this;
		},
		lean: async () => ({
			_id: HOTEL_ID,
			hotelName: "Ajyad",
			roomCountDetails: [
				{
					roomType: "standard",
					displayName: "Standard",
					count: 2,
				},
			],
		}),
	});
	Reservations.find = () => {
		const call = { projection: null };
		return {
			select(projection) {
				call.projection = projection;
				observed.reservationProjections.push(projection);
				return this;
			},
			lean: async () => [reservation],
		};
	};

	try {
		await callback(observed);
	} finally {
		HotelDetails.findById = originals.findById;
		Reservations.find = originals.find;
	}
};

const occupancyResponse = async (totalMode) => {
	const res = makeResponse();
	await hotelOccupancyCalendar(
		{
			query: {
				hotelId: HOTEL_ID,
				start: "2026-07-15",
				end: "2026-07-16",
				totalMode,
			},
			profile: { role: 8000 },
		},
		res,
	);
	assert.equal(res.statusCode, 200);
	return res.payload;
};

const occupancyOnlySummary = (summary = {}) => ({
	soldRoomNights: summary.soldRoomNights,
	availableRoomNights: summary.availableRoomNights,
	totalRoomsAll: summary.totalRoomsAll,
	totalPhysicalRooms: summary.totalPhysicalRooms,
	capacityRoomNights: summary.capacityRoomNights,
	bookedRoomNights: summary.bookedRoomNights,
	occupiedRoomNights: summary.occupiedRoomNights,
	remainingRoomNights: summary.remainingRoomNights,
	averageOccupancyRate: summary.averageOccupancyRate,
	peakDay: summary.peakDay,
	occupancyByType: summary.occupancyByType,
	warnings: summary.warnings,
});

test("occupancy inventory stays byte-for-byte invariant when financial mode changes", async () => {
	const reservation = {
		...verifiedOtaReservation({ confirmation: "OCCUPANCY" }),
		checkin_date: new Date("2026-07-15T00:00:00.000Z"),
		checkout_date: new Date("2026-07-16T00:00:00.000Z"),
		reservation_status: "confirmed",
		pickedRoomsType: [
			{ room_type: "standard", displayName: "Standard", count: 1 },
		],
		paid_amount_breakdown: { paid_at_hotel_cash: 25 },
	};

	await withOccupancyMocks(reservation, async (observed) => {
		const gross = await occupancyResponse("gross");
		const net = await occupancyResponse("net");

		assert.equal(gross.summary.totalAmount, 148.96);
		assert.equal(net.summary.totalAmount, 92.18);
		assert.equal(gross.summary.checkoutTotal, 148.96);
		assert.equal(net.summary.checkoutTotal, 92.18);
		assert.equal(gross.summary.checkinTotal, 148.96);
		assert.equal(net.summary.checkinTotal, 92.18);
		assert.deepEqual(gross.days, net.days);
		assert.deepEqual(gross.roomTypes, net.roomTypes);
		assert.deepEqual(
			occupancyOnlySummary(gross.summary),
			occupancyOnlySummary(net.summary),
		);
		assert.equal(gross.summary.bookedRoomNights, 1);
		assert.equal(net.summary.bookedRoomNights, 1);
		assert.equal(gross.summary.paymentBreakdown[0].count, 1);
		assert.equal(net.summary.paymentBreakdown[0].count, 1);
		assert.equal(gross.summary.paymentBreakdown[0].paidAmount, 148.96);
		assert.equal(net.summary.paymentBreakdown[0].paidAmount, 148.96);
		assert.equal(observed.reservationProjections.length, 2);
		observed.reservationProjections.forEach((projection) => {
			assert.match(projection, /\bpickedRoomsType\b/);
			assert.match(projection, /\bota_financial_summary\b/);
			assert.match(projection, /\bsupplierData\b/);
		});
	});
});
