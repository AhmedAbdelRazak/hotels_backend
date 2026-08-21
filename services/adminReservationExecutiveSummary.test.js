const assert = require("node:assert/strict");
const test = require("node:test");
const {
	buildAuthenticatedProviderCommercialEvidence,
} = require("./otaCommercialEvidence");
const {
	buildExecutiveComparisonWindow,
	buildExecutiveDateWindow,
	buildExecutiveReservationMatch,
	buildExecutiveReservationSummary,
	normalizeExecutiveDayFilter,
	reconcileReservationAmount,
} = require("./adminReservationExecutiveSummary");

test("executive day filters normalize and use Riyadh calendar boundaries", () => {
	const now = new Date("2026-07-19T02:00:00.000Z");
	assert.equal(normalizeExecutiveDayFilter("Tomorrow"), "tomorrow");
	assert.equal(normalizeExecutiveDayFilter("not-valid"), "today");

	const today = buildExecutiveDateWindow("today", now);
	assert.equal(today.date, "2026-07-19");
	assert.equal(today.start.toISOString(), "2026-07-18T21:00:00.000Z");
	assert.equal(today.end.toISOString(), "2026-07-19T21:00:00.000Z");

	const yesterday = buildExecutiveDateWindow("yesterday", now);
	assert.equal(yesterday.date, "2026-07-18");
	const tomorrow = buildExecutiveDateWindow("tomorrow", now);
	assert.equal(tomorrow.date, "2026-07-20");
});

test("executive match is one read-only OR query with active arrival rules", () => {
	const window = buildExecutiveDateWindow("today", new Date("2026-07-19T02:00:00.000Z"));
	const match = buildExecutiveReservationMatch(window);
	assert.equal(match.$or.length, 3);
	assert.deepEqual(match.$or[0].checkin_date, {
		$gte: window.start,
		$lt: window.end,
	});
	assert.ok(match.$or[0].reservation_status.$nin.includes("cancelled"));
	assert.deepEqual(match.$or[2], {
		createdAt: { $gte: window.start, $lt: window.end },
	});
});

test("executive summary categorizes unique rows without exposing private fields", () => {
	const window = buildExecutiveDateWindow("today", new Date("2026-07-19T02:00:00.000Z"));
	const reservations = [
		{
			_id: "r1",
			confirmation_number: "CONF-1",
			reservation_status: "confirmed",
			checkin_date: "2026-07-19T00:00:00.000Z",
			checkout_date: "2026-07-21T00:00:00.000Z",
			createdAt: "2026-07-19T03:00:00.000Z",
			customer_details: {
				name: "Safe Guest",
				cardNumber: "must-not-leak",
			},
			hotelId: { _id: "h1", hotelName: "Zad Ajyad" },
			total_amount: 560,
			total_rooms: 1,
			total_guests: 2,
			pickedRoomsType: [
				{
					room_type: "doubleRooms",
					displayName: "City View",
					count: 1,
					chosenPrice: 280,
					pricingByDay: [{ price: 280 }, { price: 280 }],
				},
			],
			roomId: [
				{
					_id: "room-101",
					room_number: "101",
					room_type: "doubleRooms",
					display_name: "City View",
				},
			],
		},
		{
			_id: "r2",
			confirmation_number: "CONF-2",
			reservation_status: "confirmed",
			checkout_date: "2026-07-19T04:00:00.000Z",
			createdAt: "2026-07-17T03:00:00.000Z",
		},
		{
			_id: "r3",
			confirmation_number: "CONF-3",
			reservation_status: "cancelled",
			checkin_date: "2026-07-19T02:00:00.000Z",
			createdAt: "2026-07-19T05:00:00.000Z",
		},
	];

	const result = buildExecutiveReservationSummary(reservations, window);
	assert.equal(result.summary.checkins, 1);
	assert.equal(result.summary.checkouts, 1);
	assert.equal(result.summary.newReservations, 2);
	assert.equal(result.summary.metrics.checkins.nights, 2);
	assert.equal(result.summary.metrics.checkouts.nights, 0);
	assert.equal(result.summary.metrics.newReservations.nights, 2);
	assert.equal(result.summary.totalUniqueReservations, 3);
	assert.equal(result.summary.totalAmount, 560);
	assert.equal(result.summary.currency, "SAR");
	assert.equal(result.summary.verifiedAmounts, 1);
	assert.equal(result.timezoneLabel, "Makkah Time");
	assert.deepEqual(result.reservations[0].activityTypes, ["checkin", "new-reservation"]);
	assert.equal(result.reservations[0].nights, 2);
	assert.equal(result.reservations[0].averageNightlyAmount, 280);
	assert.equal(result.reservations[0].grossTotalAmount, 560);
	assert.equal(result.reservations[0].netTotalAmount, 560);
	assert.equal(result.reservations[0].financialTotalsCurrency, "SAR");
	assert.equal(result.reservations[0].amountQuality.status, "verified");
	assert.deepEqual(result.reservations[0].roomTypes, [
		"City View",
	]);
	assert.deepEqual(result.reservations[0].roomNumbers, ["101"]);
	assert.deepEqual(result.reservations[2].activityTypes, ["new-reservation"]);
	assert.equal(JSON.stringify(result).includes("must-not-leak"), false);
});

test("executive rows expose persisted same-role gross and net scalars for Excel", () => {
	const window = buildExecutiveDateWindow(
		"today",
		new Date("2026-07-19T02:00:00.000Z")
	);
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
		sourceTimestamp: "2026-07-19T01:00:00.000Z",
		sourceId: "agoda-executive-export-1",
		guestGross: { verified: true, amount: 148.96 },
		hotelPayout: { verified: true, amount: 92.18 },
	});
	const result = buildExecutiveReservationSummary(
		[
			{
				_id: "verified-ota",
				createdAt: "2026-07-19T03:00:00.000Z",
				booking_source: "agoda",
				total_amount: 148.96,
				currency: "SAR",
				adminPricing: {
					mode: "hotelrunner_api",
					propertyCurrency: "SAR",
					clientTotal: 148.96,
					netAfterExpensesTotal: 92.18,
					commercialVerified: false,
				},
				ota_financial_summary: {
					propertyCurrency: "SAR",
					clientTotal: 148.96,
					netAfterExpenses: 92.18,
					commercialVerified: false,
				},
				supplierData: {
					otaProvider: "agoda",
					otaCommercialEvidenceStaleReason: "",
					otaCommercialEvidence: evidence,
					hotelRunner: { transport: "hotelrunner_api" },
				},
			},
			{
				_id: "unverified-ota",
				createdAt: "2026-07-19T04:00:00.000Z",
				booking_source: "trip.com",
				total_amount: 63.11,
				currency: "SAR",
				adminPricing: {
					mode: "hotelrunner_api",
					propertyCurrency: "SAR",
					clientTotal: 63.11,
					netAfterExpensesTotal: 59.59,
					commercialVerified: false,
				},
			},
			{
				_id: "negative-net",
				createdAt: "2026-07-19T05:00:00.000Z",
				booking_source: "OTA",
				total_amount: 100,
				currency: "SAR",
				adminPricing: {
					mode: "admin_three_price",
					propertyCurrency: "SAR",
					clientTotal: 100,
					netAfterExpensesTotal: -10,
				},
			},
		],
		window
	);

	const verified = result.reservations.find((row) => row.id === "verified-ota");
	assert.equal(verified.totalAmount, 148.96, "dashboard amount stays unchanged");
	assert.equal(verified.grossTotalAmount, 148.96);
	assert.equal(verified.netTotalAmount, 92.18);
	assert.equal(verified.financialTotalsCurrency, "SAR");
	assert.equal(verified.grossTotalAvailable, true);
	assert.equal(verified.netTotalAvailable, true);

	const unverified = result.reservations.find(
		(row) => row.id === "unverified-ota"
	);
	assert.equal(unverified.grossTotalAmount, 63.11);
	assert.equal(unverified.netTotalAmount, 59.59);
	assert.equal(unverified.grossTotalAvailable, true);
	assert.equal(unverified.netTotalAvailable, true);

	const negative = result.reservations.find((row) => row.id === "negative-net");
	assert.equal(negative.grossTotalAmount, 100);
	assert.equal(negative.netTotalAmount, -10);
	assert.equal(
		JSON.stringify(result).includes("otaCommercialEvidence"),
		false,
		"nested commercial evidence must not reach the executive response"
	);
});

test("amount audit reconciles a long-stay total without changing its stored value", () => {
	const result = reconcileReservationAmount({
		checkin_date: "2027-02-14T00:00:00.000Z",
		checkout_date: "2027-03-12T00:00:00.000Z",
		total_amount: 15842.58,
		pickedRoomsType: [
			{
				count: 1,
				chosenPrice: "609.33",
				pricingByDay: Array.from({ length: 26 }, () => ({ price: 609.33 })),
			},
		],
	});

	assert.equal(result.nights, 26);
	assert.equal(result.averageNightlyAmount, 609.33);
	assert.equal(result.amountQuality.status, "verified");
	assert.equal(result.amountQuality.expectedAmount, 15842.58);
	assert.equal(result.amountQuality.difference, 0);

	const discrepancy = reconcileReservationAmount({
		checkin_date: "2027-02-14T00:00:00.000Z",
		checkout_date: "2027-03-12T00:00:00.000Z",
		total_amount: 15000,
		pickedRoomsType: [
			{
				count: 1,
				chosenPrice: "609.33",
				pricingByDay: Array.from({ length: 26 }, () => ({ price: 609.33 })),
			},
		],
	});
	assert.equal(discrepancy.amountQuality.status, "discrepancy");
	assert.equal(discrepancy.amountQuality.expectedAmount, 15842.58);
});

test("executive totals never add unlike currencies together", () => {
	const window = buildExecutiveDateWindow(
		"today",
		new Date("2026-07-19T02:00:00.000Z")
	);
	const result = buildExecutiveReservationSummary(
		[
			{
				_id: "sar-row",
				createdAt: "2026-07-19T03:00:00.000Z",
				total_amount: 100,
				currency: "sar",
			},
			{
				_id: "usd-row",
				createdAt: "2026-07-19T04:00:00.000Z",
				total_amount: 50,
				currency: "usd",
			},
		],
		window
	);

	assert.equal(result.summary.mixedCurrencies, true);
	assert.equal(result.summary.totalAmount, null);
	assert.deepEqual(result.summary.totalsByCurrency, { SAR: 100, USD: 50 });
});

test("activity scorecards include SAR totals and prior Makkah-day count variance", () => {
	const window = buildExecutiveDateWindow(
		"today",
		new Date("2026-07-19T02:00:00.000Z")
	);
	const comparisonWindow = buildExecutiveComparisonWindow(window);
	assert.equal(comparisonWindow.date, "2026-07-18");
	assert.equal(comparisonWindow.start.toISOString(), "2026-07-17T21:00:00.000Z");

	const result = buildExecutiveReservationSummary(
		[
			{
				_id: "current-1",
				reservation_status: "confirmed",
				checkin_date: "2026-07-19T02:00:00.000Z",
				checkout_date: "2026-08-08T02:00:00.000Z",
				total_amount: 400,
				currency: "SAR",
			},
			{
				_id: "current-2",
				reservation_status: "confirmed",
				checkin_date: "2026-07-19T05:00:00.000Z",
				checkout_date: "2026-08-17T05:00:00.000Z",
				total_amount: 200,
				currency: "sar",
			},
			{
				_id: "current-3",
				reservation_status: "confirmed",
				checkin_date: "2026-07-19T08:00:00.000Z",
				checkout_date: "2026-07-20T08:00:00.000Z",
				total_amount: 75,
				currency: "USD",
			},
			{
				_id: "current-new",
				createdAt: "2026-07-19T03:00:00.000Z",
				total_amount: 50,
				currency: "SAR",
			},
			{
				_id: "previous-1",
				reservation_status: "confirmed",
				checkin_date: "2026-07-18T02:00:00.000Z",
				total_amount: 100,
				currency: "SAR",
			},
			{
				_id: "previous-2",
				reservation_status: "confirmed",
				checkin_date: "2026-07-18T07:00:00.000Z",
				total_amount: 50,
				currency: "SAR",
			},
		],
		window,
		comparisonWindow
	);

	assert.equal(result.comparison.date, "2026-07-18");
	assert.deepEqual(result.summary.metrics.checkins, {
		count: 3,
		nights: 50,
		sarAmount: 600,
		excludedNonSarCount: 1,
		invalidAmountCount: 0,
		previousCount: 2,
		previousSarAmount: 150,
		variancePercent: 50,
		amountVariancePercent: 300,
		varianceState: "increase",
	});
	assert.equal(result.summary.metrics.newReservations.count, 1);
	assert.equal(result.summary.metrics.newReservations.sarAmount, 50);
	assert.equal(result.summary.metrics.newReservations.variancePercent, null);
	assert.equal(result.summary.metrics.newReservations.varianceState, "new");
	assert.equal(result.summary.metrics.checkouts.variancePercent, 0);
});
