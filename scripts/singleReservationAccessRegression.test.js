/** @format */

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const mongoose = require("mongoose");

process.env.SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "SG.test";
process.env.JWT_SECRET2 = process.env.JWT_SECRET2 || "offline-reservation-test-secret";
process.env.AI_AGENT_TEST_EXPORTS = "true";

const Reservations = require("../models/reservations");
const HotelDetails = require("../models/hotel_details");
const User = require("../models/user");
const { encryptWithSecret } = require("../controllers/utils");
const {
	ADMIN_RESERVATION_LIST_PROJECTION,
} = require("../services/adminReservationListProjection");
const reservationsController = require("../controllers/reservations");
const reservationAccess = reservationsController.__test;
const hotelReview = require("../controllers/hoteldetails").__test;
const {
	resolveHotelRunnerPlatformCommission,
} = require("../services/hotelrunnerPlatformFinance");

const collectObjectKeys = (value, keys = new Set()) => {
	if (!value || typeof value !== "object") return keys;
	if (Array.isArray(value)) {
		value.forEach((item) => collectObjectKeys(item, keys));
		return keys;
	}
	Object.entries(value).forEach(([key, nestedValue]) => {
		keys.add(key);
		collectObjectKeys(nestedValue, keys);
	});
	return keys;
};

test("public legacy payment projection preserves checkout fields only", () => {
	const source = {
		_id: "reservation-a",
		confirmation_number: "CONF-100",
		total_amount: 1250,
		booked_at: "2026-07-01T00:00:00.000Z",
		checkin_date: "2026-07-15T00:00:00.000Z",
		checkout_date: "2026-07-17T00:00:00.000Z",
		days_of_residence: 2,
		total_guests: 3,
		customer_details: {
			name: "Guest Name",
			phone: "+966500000000",
			email: "guest@example.com",
			nationality: "Saudi Arabia",
			cardNumber: "encrypted-card",
			cardExpiryDate: "encrypted-expiry",
			cardCVV: "123",
			cardHolderName: "Guest Name",
		},
		hotelId: {
			_id: "hotel-a",
			hotelName: "Hotel A",
			belongsTo: "owner-a",
			commission: 25,
			roomCountDetails: [{ _id: "room-type-a" }],
		},
		pickedRoomsType: [
			{
				room_type: "Triple Room",
				roomId: "room-a",
				roomDetails: { room_number: "303" },
				bedNumber: "3",
			},
			{ roomType: "Quadruple Room", room_numbers: ["404"] },
		],
		payment_details: {
			transactionId: "transaction-a",
			paymentToken: "internal-token",
		},
		belongsTo: { _id: "owner-a", email: "owner@example.com" },
		financial_cycle: { status: "open" },
		paid_amount_breakdown: { paid_online: 1250 },
		commission: 250,
		root_price: 900,
		reservation_status_history: [{ status: "confirmed" }],
	};

	const payload = reservationAccess.buildLegacyClientPaymentPayload({
		toObject: () => source,
	});

	assert.deepEqual(payload, {
		_id: "reservation-a",
		confirmation_number: "CONF-100",
		total_amount: 1250,
		booked_at: "2026-07-01T00:00:00.000Z",
		checkin_date: "2026-07-15T00:00:00.000Z",
		checkout_date: "2026-07-17T00:00:00.000Z",
		days_of_residence: 2,
		total_guests: 3,
		customer_details: {
			name: "Guest Name",
			phone: "+966500000000",
			email: "guest@example.com",
			nationality: "Saudi Arabia",
		},
		hotelId: { _id: "hotel-a", hotelName: "Hotel A" },
		pickedRoomsType: [
			{ room_type: "Triple Room" },
			{ room_type: "Quadruple Room" },
		],
		payment_details: { transactionId: "transaction-a" },
	});

	const projectedKeys = collectObjectKeys(payload);
	for (const forbiddenKey of [
		"cardNumber",
		"cardExpiryDate",
		"cardCVV",
		"cardHolderName",
		"belongsTo",
		"commission",
		"root_price",
		"roomId",
		"roomDetails",
		"room_numbers",
		"bedNumber",
		"financial_cycle",
		"paid_amount_breakdown",
		"reservation_status_history",
		"paymentToken",
	]) {
		assert.equal(projectedKeys.has(forbiddenKey), false, forbiddenKey);
	}
});

test("full legacy reservation policy is active, permissioned, and hotel scoped", () => {
	const reservation = {
		_id: "reservation-a",
		hotelId: { _id: "hotel-a", belongsTo: "owner-a" },
	};

	assert.equal(
		reservationAccess.canReadFullLegacyReservation(null, reservation),
		false
	);
	assert.equal(
		reservationAccess.canReadFullLegacyReservation(
			{ activeUser: false },
			reservation,
			{ verifiedReservationId: "reservation-a", superAdminIds: ["disabled"] }
		),
		false
	);

	for (const accessKey of [
		"AdminDashboard",
		"AllReservations",
		"HotelsReservations",
		"HotelReports",
		"OTAReservations",
	]) {
		assert.equal(
			reservationAccess.canReadFullLegacyReservation(
				{
					_id: "platform-a",
					activeUser: true,
					role: 1000,
					accessTo: [accessKey],
					hotelsToSupport: ["hotel-a"],
				},
				reservation,
				{ superAdminIds: [] }
			),
			true,
			accessKey
		);
	}

	assert.equal(
		reservationAccess.canReadFullLegacyReservation(
			{
				_id: "platform-a",
				activeUser: true,
				role: 1000,
				accessTo: ["AllReservations"],
				hotelsToSupport: ["hotel-b"],
			},
			reservation,
			{ superAdminIds: [] }
		),
		false
	);
	assert.equal(
		reservationAccess.canReadFullLegacyReservation(
			{
				_id: "platform-a",
				activeUser: true,
				role: 1000,
				accessTo: ["JannatBookingWebsite"],
				hotelIdWork: "hotel-a",
			},
			reservation,
			{ superAdminIds: [] }
		),
		false
	);
	assert.equal(
		reservationAccess.canReadFullLegacyReservation(
			{
				_id: "platform-a",
				activeUser: true,
				role: 1000,
				accessTo: ["AllReservations"],
			},
			reservation,
			{ superAdminIds: [] }
		),
		false
	);

	assert.equal(
		reservationAccess.canReadFullLegacyReservation(
			{
				_id: "reception-a",
				activeUser: true,
				role: 3000,
				hotelIdsWork: ["hotel-a"],
			},
			reservation,
			{ superAdminIds: [] }
		),
		true
	);
	assert.equal(
		reservationAccess.canReadFullLegacyReservation(
			{
				_id: "reception-a",
				activeUser: true,
				roleDescription: "reception",
				hotelIdWork: "hotel-b",
			},
			reservation,
			{ superAdminIds: [] }
		),
		false
	);
	assert.equal(
		reservationAccess.canReadFullLegacyReservation(
			{ _id: "owner-a", activeUser: true, role: 2000 },
			reservation,
			{ superAdminIds: [] }
		),
		true
	);
	assert.equal(
		reservationAccess.canReadFullLegacyReservation(
			{ _id: "unknown-a", activeUser: true, hotelIdWork: "hotel-a" },
			reservation,
			{ superAdminIds: [] }
		),
		false
	);
	assert.equal(
		reservationAccess.canReadFullLegacyReservation(
			{ _id: "configured-admin", activeUser: true },
			reservation,
			{ superAdminIds: ["configured-admin"] }
		),
		true
	);
});

test("verified review scope never bypasses current actor and hotel policy", () => {
	const actor = { _id: "review-admin", activeUser: true };
	assert.equal(
		reservationAccess.canReadFullLegacyReservation(
			actor,
			{ _id: "reservation-a", hotelId: "hotel-a" },
			{ verifiedReservationId: "reservation-a", superAdminIds: [] }
		),
		false
	);
	assert.equal(
		reservationAccess.canReadFullLegacyReservation(
			{
				...actor,
				role: 1000,
				accessTo: ["AllReservations"],
				hotelsToSupport: ["hotel-a"],
			},
			{ _id: "reservation-a", hotelId: "hotel-b" },
			{ verifiedReservationId: "reservation-a", superAdminIds: [] }
		),
		false
	);
});

const responseStub = () => ({
	statusCode: 200,
	body: null,
	setHeader() {},
	status(code) {
		this.statusCode = code;
		return this;
	},
	json(body) {
		this.body = body;
		return this;
	},
	send(body) {
		this.body = body;
		return this;
	},
});

test("hotel financial report endpoints reject unauthenticated reservation access", async () => {
	const hotelId = new mongoose.Types.ObjectId().toString();
	const dateParams = {
		accountId: hotelId,
		channel: "undefined",
		startDate: "2026-08-01",
		endDate: "2026-08-31",
	};
	const cases = [
		[reservationsController.totalCheckoutRecords, dateParams],
		[
			reservationsController.checkedoutReport,
			{ ...dateParams, page: "1", records: "20" },
		],
		[
			reservationsController.totalGeneralReservationsRecords,
			{
				...dateParams,
				dateBy: "checkin",
				noshow: "0",
				cancel: "0",
				inhouse: "0",
				checkedout: "0",
				payment: "false",
			},
		],
		[
			reservationsController.generalReservationsReport,
			{
				...dateParams,
				page: "1",
				records: "20",
				dateBy: "checkin",
				noshow: "0",
				cancel: "0",
				inhouse: "0",
				checkedout: "0",
				payment: "false",
			},
		],
		[
			reservationsController.pendingPaymentReservations,
			{ hotelId, page: "1", records: "20" },
		],
		[
			reservationsController.commissionPaidReservations,
			{ hotelId, page: "1", records: "20" },
		],
	];

	for (const [handler, params] of cases) {
		const response = responseStub();
		await handler({ params, auth: null }, response);
		assert.equal(response.statusCode, 401, handler.name);
		assert.deepEqual(response.body, { error: "Authentication required." });
	}
});

test("hotel financial report routes require a signed-in user", () => {
	const source = fs.readFileSync(
		require.resolve("../routes/reservations"),
		"utf8",
	);
	for (const routePrefix of [
		"/reservations-summary-checkedout/",
		"/reservations-checkedout/",
		"/reservations-pending/",
		"/reservations-paid-commission/",
		"/general-report-reservations/list/",
		"/reservations-general-report/",
	]) {
		const offset = source.indexOf(routePrefix);
		assert.notEqual(offset, -1, routePrefix);
		assert.match(source.slice(offset, offset + 260), /requireSignin/);
	}
});

test("an unrelated finance snapshot never derives HotelRunner commission from room prices", () => {
	const roomPricing = [
		{
			count: 1,
			pricingByDay: [
				{ price: 1000, rootPrice: 700, totalPriceWithoutCommission: 700 },
			],
		},
	];
	const hotelRunnerCycle = reservationAccess.buildFinancialCycleSnapshot({
		total_amount: 1000,
		pickedRoomsType: roomPricing,
		adminPricing: { mode: "hotelrunner_api" },
		financial_cycle: {},
	});
	assert.equal(hotelRunnerCycle.commissionAmount, 0);
	assert.equal(hotelRunnerCycle.commissionAssigned, false);

	const legacyCycle = reservationAccess.buildFinancialCycleSnapshot({
		total_amount: 1000,
		pickedRoomsType: roomPricing,
		financial_cycle: {},
	});
	assert.equal(legacyCycle.commissionAmount, 300);
});

test("HotelRunner finance snapshots ignore stale status and unassigned amounts", () => {
	const staleUnreviewed = reservationAccess.buildFinancialCycleSnapshot({
		total_amount: 1000,
		commission: 175,
		commissionStatus: "commission paid",
		adminPricing: { mode: "hotelrunner_api" },
		commissionData: { assigned: false, amount: 175 },
		financial_cycle: {
			commissionAssigned: false,
			commissionAmount: 175,
		},
	});

	assert.equal(staleUnreviewed.commissionAmount, 0);
	assert.equal(staleUnreviewed.commissionAssigned, false);

	const explicitlyReviewed = reservationAccess.buildFinancialCycleSnapshot(
		{
			total_amount: 1000,
			adminPricing: { mode: "hotelrunner_api" },
			financial_cycle: {},
		},
		{ commission: 0 },
		"finance-user"
	);
	assert.equal(explicitlyReviewed.commissionAmount, 0);
	assert.equal(explicitlyReviewed.commissionAssigned, true);

	const mongooseLikeReservation = {};
	for (const [key, value] of Object.entries({
		total_amount: 1000,
		commission: 125,
		commissionStatus: "commission paid",
		adminPricing: { mode: "hotelrunner_api" },
		commissionData: { assigned: false, amount: 125 },
		financial_cycle: { commissionAssigned: false, commissionAmount: 125 },
	})) {
		Object.defineProperty(mongooseLikeReservation, key, {
			configurable: true,
			enumerable: false,
			value,
		});
	}
	const mongooseLikeCycle = reservationAccess.buildFinancialCycleSnapshot(
		mongooseLikeReservation
	);
	assert.equal(mongooseLikeCycle.commissionAmount, 0);
	assert.equal(mongooseLikeCycle.commissionAssigned, false);

	const unreviewedPaidCycle = reservationAccess.buildFinancialCycleSnapshot(
		{
			total_amount: 1000,
			payment: "offline",
			adminPricing: { mode: "hotelrunner_api" },
			financial_cycle: { collectionModel: "hotel_collected" },
		},
		{ commissionPaid: true, commissionStatus: "commission paid" }
	);
	assert.equal(unreviewedPaidCycle.commissionAssigned, false);
	assert.equal(unreviewedPaidCycle.status, "open");
	assert.equal(unreviewedPaidCycle.closedAt, null);
});

test("HotelRunner commission cannot be marked paid before explicit finance review", () => {
	const base = {
		commission: 0,
		adminPricing: { mode: "hotelrunner_api" },
		financial_cycle: {},
		commissionData: {},
	};
	const unreviewed = reservationAccess.resolveCommissionPaidReview(base, {});
	assert.equal(unreviewed.allowed, false);
	assert.equal(unreviewed.statusCode, 409);
	assert.equal(
		unreviewed.code,
		"hotelrunner_platform_finance_review_required"
	);

	const explicitZero = reservationAccess.resolveCommissionPaidReview(base, {
		commission: 0,
	});
	assert.equal(explicitZero.allowed, true);
	assert.equal(explicitZero.amount, 0);

	const explicitAmount = reservationAccess.resolveCommissionPaidReview(base, {
		commission: "25.50",
	});
	assert.equal(explicitAmount.allowed, true);
	assert.equal(explicitAmount.amount, 25.5);
	const staleConflictingAliases = reservationAccess.resolveCommissionPaidReview(
		{
			...base,
			commission: 10,
			commissionData: {
				assigned: true,
				amount: 10,
				commissionAmount: 11,
				commissionValue: 12,
			},
			financial_cycle: {
				commissionAssigned: true,
				commissionAmount: 13,
				commissionValue: 14,
			},
		},
		{ commission: "25.50" }
	);
	assert.equal(staleConflictingAliases.allowed, true);
	assert.equal(staleConflictingAliases.amount, 25.5);

	const invalid = reservationAccess.resolveCommissionPaidReview(base, {
		commission: -1,
	});
	assert.equal(invalid.allowed, false);
	assert.equal(invalid.statusCode, 400);
	for (const invalidCommission of ["", "   ", null, true, "1.234"]) {
		const malformed = reservationAccess.resolveCommissionPaidReview(base, {
			commission: invalidCommission,
		});
		assert.equal(malformed.allowed, false, String(invalidCommission));
		assert.equal(malformed.statusCode, 400, String(invalidCommission));
	}

	const legacy = reservationAccess.resolveCommissionPaidReview(
		{ commission: 0 },
		{}
	);
	assert.equal(legacy.allowed, true);
	assert.equal(legacy.isHotelRunner, false);
});

test("every generic HotelRunner paid transition requires finance review", () => {
	const unreviewed = {
		commission: 0,
		adminPricing: { mode: "hotelrunner_api" },
		financial_cycle: {},
		commissionData: {},
	};
	assert.equal(
		reservationAccess.resolveHotelRunnerCommissionPaidTransition(
			unreviewed,
			{ commissionPaid: true }
		).allowed,
		false
	);
	assert.equal(
		reservationAccess.resolveHotelRunnerCommissionPaidTransition(
			unreviewed,
			{ commissionStatus: "commission paid" }
		).allowed,
		false
	);
	assert.equal(
		reservationAccess.resolveHotelRunnerCommissionPaidTransition(
			unreviewed,
			{ commissionPaid: true, commission: 0 }
		).allowed,
		true
	);
	assert.equal(
		reservationAccess.resolveHotelRunnerCommissionPaidTransition(
			unreviewed,
			{ commissionPaid: false }
		).allowed,
		true
	);
});

const directHotelRunnerIdentityFixture = () => ({
	reservation_id: "1306270127602764",
	hr_number: "R048727033",
	confirmation_number: "hotelrunner-r048727033",
	pms_number: "hotelrunner-r048727033",
	booking_source: "Trip.com",
	customer_details: {
		booking_source: "Trip.com",
		confirmation_number2: "1306270127602764",
		name: "Guest Name",
	},
	financial_cycle: {
		bookingSource: "Trip.com",
		sourceName: "Trip.com",
		status: "open",
	},
	supplierData: {
		otaAutomationPipeline: "hotelrunner-background-worker",
		otaSourceAuthority: 4,
		hotelRunner: {
			transport: "hotelrunner_api",
			reservationId: "R048727033",
		},
	},
});

test("direct HotelRunner identity echoes are stripped while guest edits survive", () => {
	const existing = directHotelRunnerIdentityFixture();
	const update = {
		reservation_id: existing.reservation_id,
		hr_number: existing.hr_number,
		confirmation_number: existing.confirmation_number,
		pms_number: existing.pms_number,
		bookingSource: existing.booking_source,
		customerDetails: {
			booking_source: existing.customer_details.booking_source,
			confirmation_number2:
				existing.customer_details.confirmation_number2,
			name: "Corrected Guest Name",
		},
		financial_cycle: {
			bookingSource: existing.financial_cycle.bookingSource,
			sourceName: existing.financial_cycle.sourceName,
			status: "closed",
		},
	};

	const result = reservationAccess.protectDirectHotelRunnerIdentityUpdate(
		update,
		existing
	);

	assert.deepEqual(result, { allowed: true });
	assert.deepEqual(update, {
		customerDetails: { name: "Corrected Guest Name" },
		financial_cycle: { status: "closed" },
	});
});

test("direct HotelRunner identity changes fail closed for root and nested aliases", () => {
	const existing = directHotelRunnerIdentityFixture();
	for (const [payload, expectedField] of [
		[{ reservation_id: "different" }, "reservation_id"],
		[{ confirmationNumber: "different" }, "confirmationNumber"],
		[{ hrNumber: "different" }, "hrNumber"],
		[{ transport: "manual" }, "transport"],
		[
			{ customer_details: { confirmation_number2: "different" } },
			"customer_details.confirmation_number2",
		],
		[
			{ customerDetails: { reservationId: "different" } },
			"customerDetails.reservationId",
		],
		[
			{ "customer_details.confirmationNumber": "different" },
			"customer_details.confirmationNumber",
		],
		[
			{ financial_cycle: { sourceName: "manual" } },
			"financial_cycle.sourceName",
		],
	]) {
		const result = reservationAccess.protectDirectHotelRunnerIdentityUpdate(
			payload,
			existing
		);
		assert.equal(result.allowed, false);
		assert.equal(result.status, 409);
		assert.equal(result.field, expectedField);
		assert.equal(
			result.code,
			"hotelrunner_source_identity_requires_projection"
		);
	}
});

test("generic reservation updates strip server-owned pricing and audit evidence", () => {
	const update = {
		comment: "Keep this local note",
		availabilitySnapshot: { available: true },
		"availabilitySnapshot.available": false,
		adminPricing: { commercialVerified: true, netAfterExpensesTotal: 900 },
		"adminPricing.commercialVerified": true,
		adminPricingVisibility: { netAvailable: true },
		ota_financial_summary: { commercialVerified: true },
		"otaFinancialSummary.otaExpenseTotal": 75,
		hotelRunnerPricing: { grandTotal: 1000 },
		"hotelrunnerPricing.grandTotal": 1000,
		otaIdentityKey: "fabricated",
		"otaPlatformReview.status": "approved",
		commission_ota: 75,
	};

	reservationAccess.stripServerManagedReservationUpdateFields(update);
	assert.deepEqual(update, { comment: "Keep this local note" });
});

const directHotelRunnerSourceFixture = () => ({
	...directHotelRunnerIdentityFixture(),
	_id: new mongoose.Types.ObjectId(),
	__v: 7,
	updatedAt: new Date("2026-08-06T18:00:00.000Z"),
	hotelId: new mongoose.Types.ObjectId(),
	belongsTo: new mongoose.Types.ObjectId(),
	booked_at: new Date("2026-08-05T12:30:00.000Z"),
	checkin_date: new Date("2026-08-10T00:00:00.000Z"),
	checkout_date: new Date("2026-08-12T00:00:00.000Z"),
	days_of_residence: 2,
	pickedRoomsType: [{ room_type: "Double", count: 1 }],
	pickedRoomsPricing: [{ room_type: "Double", totalPrice: 1000 }],
	total_rooms: 1,
	total_amount: 1000,
	sub_total: 850,
	extras_total: 20,
	adjustments_total: -10,
	tax_total: 140,
	item_total: 990,
	currency: "SAR",
	commission_ota: 150,
});

test("direct HotelRunner source echoes are removed while local housing remains editable", () => {
	const existing = directHotelRunnerSourceFixture();
	const update = {
		hotelId: String(existing.hotelId),
		belongsTo: String(existing.belongsTo),
		booked_at: existing.booked_at.toISOString(),
		checkin_date: "2026-08-10",
		checkout_date: "2026-08-12",
		days_of_residence: "2",
		pickedRoomsType: existing.pickedRoomsType,
		pickedRoomsPricing: existing.pickedRoomsPricing,
		total_rooms: "1",
		total_amount: "1000.00",
		sub_total: 850,
		extras_total: 20,
		adjustments_total: -10,
		tax_total: 140,
		item_total: 990,
		currency: "sar",
		commission_ota: "150.00",
		roomId: [new mongoose.Types.ObjectId().toString()],
		comment: "Local operational note",
	};
	const expectedRoomId = update.roomId;

	const result = reservationAccess.protectDirectHotelRunnerSourceUpdate(
		update,
		existing
	);

	assert.deepEqual(result, { allowed: true });
	assert.deepEqual(update, {
		roomId: expectedRoomId,
		comment: "Local operational note",
	});
});

test("direct HotelRunner source changes fail closed", () => {
	const existing = directHotelRunnerSourceFixture();
	for (const [payload, expectedField] of [
		[{ hotelId: new mongoose.Types.ObjectId().toString() }, "hotelId"],
		[{ checkin_date: "2026-08-11" }, "checkin_date"],
		[{ pickedRoomsType: [{ room_type: "Triple", count: 1 }] }, "pickedRoomsType"],
		[{ pickedRoomsPricing: [{ room_type: "Double", totalPrice: 1 }] }, "pickedRoomsPricing"],
		[{ total_amount: 1 }, "total_amount"],
		[{ adjustments_total: 1 }, "adjustments_total"],
		[{ currency: "USD" }, "currency"],
		[{ commission_ota: 1 }, "commission_ota"],
	]) {
		const result = reservationAccess.protectDirectHotelRunnerSourceUpdate(
			payload,
			existing
		);
		assert.equal(result.allowed, false);
		assert.equal(result.status, 409);
		assert.equal(result.field, expectedField);
		assert.equal(result.code, "hotelrunner_source_field_requires_projection");
	}
});

test("authorized admin pricing intent can pass only HotelRunner pricing and explicit stay fields", () => {
	const existing = directHotelRunnerSourceFixture();
	const nextPricing = [{ room_type: "Double", totalPrice: 925 }];
	const update = {
		checkin_date: "2026-08-10",
		checkout_date: "2026-08-13",
		days_of_residence: 3,
		pickedRoomsType: [{ room_type: "Double", count: 1 }],
		pickedRoomsPricing: nextPricing,
		total_rooms: 1,
		total_amount: 925,
		sub_total: 750,
	};

	const result = reservationAccess.protectDirectHotelRunnerSourceUpdate(
		update,
		existing,
		{
			allowAuthorizedAdminPricing: true,
			allowAuthorizedAdminStayChange: true,
		},
	);

	assert.deepEqual(result, { allowed: true });
	assert.deepEqual(update.pickedRoomsPricing, nextPricing);
	assert.equal(update.checkout_date, "2026-08-13");
	assert.equal(update.total_amount, 925);
});

test("authorized admin pricing intent does not authorize HotelRunner property or OTA commission changes", () => {
	const existing = directHotelRunnerSourceFixture();
	for (const [payload, expectedField] of [
		[{ hotelId: new mongoose.Types.ObjectId().toString() }, "hotelId"],
		[{ commission_ota: 1 }, "commission_ota"],
	]) {
		const result = reservationAccess.protectDirectHotelRunnerSourceUpdate(
			payload,
			existing,
			{ allowAuthorizedAdminPricing: true },
		);
		assert.equal(result.allowed, false);
		assert.equal(result.field, expectedField);
	}
});

test("direct HotelRunner commercial evidence is server-owned and explicit commission is configured-super-admin only", () => {
	const existing = directHotelRunnerSourceFixture();
	const denied = reservationAccess.protectDirectHotelRunnerCommercialUpdate(
		{ commission: 25 },
		existing,
		{ _id: new mongoose.Types.ObjectId(), role: 1000 }
	);
	assert.equal(denied.allowed, false);
	assert.equal(denied.status, 403);
	assert.equal(denied.code, "hotelrunner_platform_commission_superadmin_only");

	const noOpEcho = { commission: 0, comment: "pricing form echo" };
	assert.deepEqual(
		reservationAccess.protectDirectHotelRunnerCommercialUpdate(
			noOpEcho,
			existing,
			{ _id: new mongoose.Types.ObjectId(), role: 1000 },
		),
		{ allowed: true },
	);
	assert.deepEqual(noOpEcho, { comment: "pricing form echo" });

	const evidenceOnly = {
		commissionData: { assigned: true, amount: 125 },
		"commissionData.assigned": true,
		commissionAmount: 125,
		commissionAssigned: true,
		financial_cycle: {
			status: "closed",
			commissionType: "percent",
			commissionAssigned: true,
			commissionAmount: 125,
		},
		"financial_cycle.commissionAssignedBy": "fabricated",
	};
	assert.deepEqual(
		reservationAccess.protectDirectHotelRunnerCommercialUpdate(
			evidenceOnly,
			existing,
			{}
		),
		{ allowed: true }
	);
	assert.deepEqual(evidenceOnly, { financial_cycle: { status: "closed" } });

	const previousSuperAdminId = process.env.SUPER_ADMIN_ID;
	const configuredSuperAdminId = new mongoose.Types.ObjectId().toString();
	process.env.SUPER_ADMIN_ID = configuredSuperAdminId;
	try {
		const explicitReview = {
			commission: "25.50",
			commissionData: { assigned: true, amount: 25.5 },
			financial_cycle: {
				status: "closed",
				commissionAssigned: true,
				commissionAmount: 25.5,
			},
		};
		assert.deepEqual(
			reservationAccess.protectDirectHotelRunnerCommercialUpdate(
				explicitReview,
				existing,
				{ _id: configuredSuperAdminId }
			),
			{ allowed: true }
		);
		assert.deepEqual(explicitReview, {
			commission: 25.5,
			financial_cycle: { status: "closed" },
		});

		for (const invalidCommission of [null, "", true, -1, "1.001", Infinity]) {
			const invalid = { commission: invalidCommission };
			const result =
				reservationAccess.protectDirectHotelRunnerCommercialUpdate(
					invalid,
					existing,
					{ _id: configuredSuperAdminId }
				);
			assert.equal(result.allowed, false);
			assert.equal(result.status, 400);
			assert.equal(result.code, "hotelrunner_platform_commission_invalid");
		}
	} finally {
		if (previousSuperAdminId === undefined) delete process.env.SUPER_ADMIN_ID;
		else process.env.SUPER_ADMIN_ID = previousSuperAdminId;
	}
});

test("configured super-admin HotelRunner commission review synthesizes consistent trusted evidence", () => {
	const previousSuperAdminId = process.env.SUPER_ADMIN_ID;
	const configuredSuperAdminId = new mongoose.Types.ObjectId().toString();
	process.env.SUPER_ADMIN_ID = configuredSuperAdminId;
	try {
		const existing = {
			...directHotelRunnerSourceFixture(),
			commission: 10,
			commissionStatus: "commission due",
			adminPricing: {
				mode: "hotelrunner_api",
				rootTotal: 850,
				commissionAmount: 10,
			},
			commissionData: {
				assigned: true,
				amount: 10,
				commissionAmount: 11,
				commissionValue: 12,
				assignedBy: "prior-reviewer",
				settlementNote: "preserve trusted history",
			},
			financial_cycle: {
				status: "open",
				collectionModel: "hotel_collected",
				commissionAssigned: true,
				commissionAmount: 13,
				commissionValue: 14,
				commissionAssignedBy: "prior-reviewer",
			},
		};
		const update = {
			commission: "25.50",
			commissionStatus: "commission due",
			adminPricing: {
				commercialVerified: true,
				netAfterExpensesTotal: 9999,
				commissionAmount: 9999,
			},
			commissionData: {
				assigned: true,
				amount: 9999,
				assignedBy: "fabricated-reviewer",
			},
			commissionAssigned: true,
			commissionAmount: 9999,
			financial_cycle: {
				status: "closed",
				notes: "reviewed locally",
				commissionType: "percent",
				commissionAssigned: true,
				commissionAmount: 9999,
				commissionValue: 9999,
				commissionAssignedBy: "fabricated-reviewer",
			},
		};

		reservationAccess.stripServerManagedReservationUpdateFields(update);
		assert.deepEqual(
			reservationAccess.protectDirectHotelRunnerCommercialUpdate(
				update,
				existing,
				{ _id: configuredSuperAdminId }
			),
			{ allowed: true }
		);
		assert.deepEqual(update, {
			commission: 25.5,
			commissionStatus: "commission due",
			financial_cycle: {
				status: "closed",
				notes: "reviewed locally",
			},
		});

		const assignedAt = new Date("2026-08-06T21:00:00.000Z");
		const assignment =
			reservationAccess.buildTrustedDirectHotelRunnerCommissionAssignment({
				update,
				existingReservation: existing,
				amount: update.commission,
				actorId: configuredSuperAdminId,
				assignedAt,
			});

		assert.equal(assignment.commission, 25.5);
		assert.equal(assignment.adminPricing.commissionAmount, 25.5);
		assert.equal(assignment.adminPricing.commercialVerified, undefined);
		assert.equal(assignment.commissionData.assigned, true);
		assert.equal(assignment.commissionData.amount, 25.5);
		assert.equal(assignment.commissionData.commissionAmount, 25.5);
		assert.equal(assignment.commissionData.commissionValue, 25.5);
		assert.equal(assignment.commissionData.assignedBy, configuredSuperAdminId);
		assert.equal(assignment.commissionData.assignedAt, assignedAt);
		assert.equal(assignment.commissionData.proposedByAgent, false);
		assert.equal(
			assignment.commissionData.settlementNote,
			"preserve trusted history"
		);
		assert.equal(assignment.financial_cycle.commissionType, "amount");
		assert.equal(assignment.financial_cycle.commissionAssigned, true);
		assert.equal(assignment.financial_cycle.commissionAmount, 25.5);
		assert.equal(assignment.financial_cycle.commissionValue, 25.5);
		assert.equal(
			assignment.financial_cycle.commissionAssignedBy,
			configuredSuperAdminId
		);
		assert.equal(assignment.financial_cycle.commissionAssignedAt, assignedAt);
		assert.equal(assignment.financial_cycle.notes, "reviewed locally");

		const finance = resolveHotelRunnerPlatformCommission({
			...existing,
			...assignment,
		});
		assert.equal(finance.available, true);
		assert.equal(finance.amount, 25.5);
		const zeroAssignment =
			reservationAccess.buildTrustedDirectHotelRunnerCommissionAssignment({
				update: { commission: 0 },
				existingReservation: existing,
				amount: 0,
				actorId: configuredSuperAdminId,
				assignedAt,
			});
		assert.equal(zeroAssignment.commissionStatus, "no commission due");
		assert.equal(zeroAssignment.commissionData.amount, 0);
		assert.equal(zeroAssignment.financial_cycle.commissionAmount, 0);
		const zeroFinance = resolveHotelRunnerPlatformCommission({
			...existing,
			...zeroAssignment,
		});
		assert.equal(zeroFinance.available, true);
		assert.equal(zeroFinance.amount, 0);

		const source = fs.readFileSync(
			require.resolve("../controllers/reservations"),
			"utf8"
		);
		assert.match(
			source,
			/normalizedUpdateData\s*=\s*buildTrustedDirectHotelRunnerCommissionAssignment\s*\(/
		);
	} finally {
		if (previousSuperAdminId === undefined) delete process.env.SUPER_ADMIN_ID;
		else process.env.SUPER_ADMIN_ID = previousSuperAdminId;
	}
});

test("direct HotelRunner pending finance is super-admin-only while lifecycle decisions remain available", () => {
	const previousSuperAdminId = process.env.SUPER_ADMIN_ID;
	const configuredSuperAdminId = new mongoose.Types.ObjectId().toString();
	const ordinaryActor = { _id: new mongoose.Types.ObjectId().toString(), role: 1000 };
	const configuredActor = { _id: configuredSuperAdminId };
	const reservation = directHotelRunnerSourceFixture();
	process.env.SUPER_ADMIN_ID = configuredSuperAdminId;
	try {
		for (const action of ["confirm", "reject", "cancel"]) {
			assert.deepEqual(
				reservationAccess.protectDirectHotelRunnerPendingFinanceActor({
					reservation,
					actor: ordinaryActor,
					payload: {},
					action,
				}),
				{ allowed: true }
			);
		}

		for (const scenario of [
			{ action: "finance", payload: {} },
			{ action: "confirm", payload: { commission: 25 } },
			{ action: "confirm", payload: { commissionPaid: true } },
			{ action: "confirm", payload: { commissionData: { assigned: true } } },
			{
				action: "confirm",
				payload: { financial_cycle: { commissionAssigned: true } },
			},
		]) {
			const denied =
				reservationAccess.protectDirectHotelRunnerPendingFinanceActor({
					reservation,
					actor: ordinaryActor,
					...scenario,
				});
			assert.equal(denied.allowed, false);
			assert.equal(denied.status, 403);
			assert.equal(denied.code, "hotelrunner_finance_superadmin_only");
		}

		assert.equal(
			reservationAccess.protectDirectHotelRunnerPendingFinanceActor({
				reservation,
				actor: configuredActor,
				payload: { commission: "25.50" },
				action: "finance",
			}).allowed,
			true
		);
		assert.deepEqual(
			reservationAccess.protectDirectHotelRunnerPendingFinanceActor({
				reservation: { commission: 0 },
				actor: ordinaryActor,
				payload: { commission: 25 },
				action: "finance",
			}),
			{ allowed: true }
		);
	} finally {
		if (previousSuperAdminId === undefined) delete process.env.SUPER_ADMIN_ID;
		else process.env.SUPER_ADMIN_ID = previousSuperAdminId;
	}
});

test("mark-paid keeps reviewed HotelRunner status permissions but protects amount evidence", () => {
	const previousSuperAdminId = process.env.SUPER_ADMIN_ID;
	const configuredSuperAdminId = new mongoose.Types.ObjectId().toString();
	const ordinaryActor = { _id: new mongoose.Types.ObjectId().toString(), role: 1000 };
	const reservation = directHotelRunnerSourceFixture();
	process.env.SUPER_ADMIN_ID = configuredSuperAdminId;
	try {
		assert.deepEqual(
			reservationAccess.protectDirectHotelRunnerCommissionEvidenceActor({
				reservation,
				actor: ordinaryActor,
				payload: { commissionPaid: true },
			}),
			{ allowed: true }
		);
		for (const payload of [
			{ commission: 25 },
			{ commissionData: { assigned: true, amount: 25 } },
			{ "financial_cycle.commissionAmount": 25 },
			{ adminPricing: { commissionAmount: 25 } },
		]) {
			const denied =
				reservationAccess.protectDirectHotelRunnerCommissionEvidenceActor({
					reservation,
					actor: ordinaryActor,
					payload,
				});
			assert.equal(denied.allowed, false);
			assert.equal(denied.status, 403);
			assert.equal(
				denied.code,
				"hotelrunner_platform_commission_superadmin_only"
			);
		}
		assert.equal(
			reservationAccess.protectDirectHotelRunnerCommissionEvidenceActor({
				reservation,
				actor: { _id: configuredSuperAdminId },
				payload: { commission: 25 },
			}).allowed,
			true
		);
	} finally {
		if (previousSuperAdminId === undefined) delete process.env.SUPER_ADMIN_ID;
		else process.env.SUPER_ADMIN_ID = previousSuperAdminId;
	}
});

test("pending and mark-paid HotelRunner routes retain CAS writes and trusted assignment wiring", () => {
	const source = fs.readFileSync(
		require.resolve("../controllers/reservations"),
		"utf8"
	);
	const pendingStart = source.indexOf(
		"exports.updatePendingConfirmationReservation"
	);
	const markPaidStart = source.indexOf("exports.markReservationCommissionPaid");
	const agentApprovalStart = source.indexOf("exports.updateAgentCommissionApproval");
	const ownerReportStart = source.indexOf("exports.ownerReport");
	assert.ok(pendingStart > -1 && markPaidStart > pendingStart);
	assert.ok(agentApprovalStart > markPaidStart && ownerReportStart > agentApprovalStart);

	const pendingRoute = source.slice(pendingStart, markPaidStart);
	assert.match(pendingRoute, /protectDirectHotelRunnerPendingFinanceActor\s*\(/);
	assert.match(
		pendingRoute,
		/buildTrustedDirectHotelRunnerCommissionAssignment\s*\(/
	);
	assert.match(
		pendingRoute,
		/Reservations\.findOneAndUpdate\(\s*buildGenericReservationUpdateFilter\(reservation\),\s*addReservationVersionBump\(updateOperation\)/
	);

	const markPaidRoute = source.slice(markPaidStart, agentApprovalStart);
	assert.match(
		markPaidRoute,
		/protectDirectHotelRunnerCommissionEvidenceActor\s*\(/
	);
	assert.match(
		markPaidRoute,
		/buildTrustedDirectHotelRunnerCommissionAssignment\s*\(/
	);
	assert.match(
		markPaidRoute,
		/Reservations\.findOneAndUpdate\(\s*buildGenericReservationUpdateFilter\(reservation\),\s*addReservationVersionBump\(updateOperation\)/
	);

	const agentApprovalRoute = source.slice(agentApprovalStart, ownerReportStart);
	assert.doesNotMatch(agentApprovalRoute, /body\.commission\b/);
	assert.doesNotMatch(agentApprovalRoute, /updatePayload\.commission\s*=/);
	assert.doesNotMatch(agentApprovalRoute, /updatePayload\.commissionData\s*=/);
});

test("generic reservation writes use a versioned source-scoped compare-and-swap", () => {
	const existing = directHotelRunnerSourceFixture();
	existing.supplierData.otaLastSourceReceivedAt = new Date(
		"2026-08-06T17:59:00.000Z"
	);
	const filter = reservationAccess.buildGenericReservationUpdateFilter(existing);

	assert.equal(String(filter._id), String(existing._id));
	assert.equal(filter.__v, 7);
	assert.equal(filter.updatedAt, existing.updatedAt);
	assert.equal(filter.hotelId, existing.hotelId);
	assert.equal(filter.belongsTo, existing.belongsTo);
	assert.equal(filter.booking_source, "Trip.com");
	assert.equal(
		filter["supplierData.hotelRunner.transport"],
		"hotelrunner_api"
	);
	assert.equal(
		filter["supplierData.hotelRunner.reservationId"],
		"R048727033"
	);
	assert.equal(
		filter["supplierData.otaAutomationPipeline"],
		"hotelrunner-background-worker"
	);
	assert.equal(filter["supplierData.otaSourceAuthority"], 4);
	assert.equal(
		filter["supplierData.otaLastSourceReceivedAt"],
		existing.supplierData.otaLastSourceReceivedAt
	);

	const source = fs.readFileSync(require.resolve("../controllers/reservations"), "utf8");
	assert.match(
		source,
		/Reservations\.findOneAndUpdate\(\s*reservationUpdateFilter,\s*addReservationVersionBump\(updateOperation\)/
	);
	assert.match(source, /code:\s*"reservation_update_concurrent_change"/);
});

test("non-HotelRunner reservations retain legacy editable identity behavior", () => {
	const update = {
		reservation_id: "legacy-updated-id",
		booking_source: "manual",
		customer_details: { confirmation_number2: "legacy-alias" },
	};
	const result = reservationAccess.protectDirectHotelRunnerIdentityUpdate(
		update,
		{ reservation_id: "legacy-id", booking_source: "affiliate" }
	);
	assert.deepEqual(result, { allowed: true });
	assert.deepEqual(update, {
		reservation_id: "legacy-updated-id",
		booking_source: "manual",
		customer_details: { confirmation_number2: "legacy-alias" },
	});
});

test("authenticated legacy local lookup never returns card or processor secrets", async () => {
	const actorId = new mongoose.Types.ObjectId();
	const hotelId = new mongoose.Types.ObjectId();
	const reservationId = new mongoose.Types.ObjectId();
	const reservationNumber = "LOCAL-HR-100";
	const bookedAt = new Date("2026-08-01T07:30:00.000Z");
	const checkinDate = new Date("2026-08-10T12:00:00.000Z");
	const checkoutDate = new Date("2026-08-12T12:00:00.000Z");
	const encryptedCard = encryptWithSecret("4111111111111111");
	const encryptedExpiry = encryptWithSecret("12/30");
	const secretValues = [
		"4111111111111111",
		"12/30",
		"cvv-secret-987",
		"processor-authorization-secret",
		"processor-payment-token",
		"processor-api-key",
		"paypal-vault-secret",
		"paypal-cmid-secret",
		"paypal-capture-secret",
		"vcc-access-secret",
		"vcc-attempt-secret",
		"braintree-client-secret",
		"bofa-context-secret",
		"bofa-outbound-secret",
		"bofa-callback-secret",
		"bofa-signature-secret",
		"bofa-lock-secret",
		"snake-card-number-secret",
		"snake-card-cvv-secret",
		"snake-card-expiry-secret",
		"snake-card-holder-secret",
		"generic-token-secret",
		"generic-refresh-token-secret",
		"generic-nested-secret",
	];
	const localReservation = {
		_id: reservationId,
		hotelId,
		belongsTo: actorId,
		confirmation_number: reservationNumber,
		booked_at: bookedAt,
		checkin_date: checkinDate,
		checkout_date: checkoutDate,
		reservation_status: "confirmed",
		total_amount: 900,
		customer_details: {
			name: "Safe Guest",
			cardNumber: encryptedCard,
			cardExpiryDate: encryptedExpiry,
			cardCVV: "cvv-secret-987",
			cardHolderName: "Safe Guest",
			card_number: "snake-card-number-secret",
			card_cvv: "snake-card-cvv-secret",
			card_expiry: "snake-card-expiry-secret",
			card_holder: "snake-card-holder-secret",
		},
		payment_details: {
			transactionId: "safe-transaction-reference",
			captured: true,
			onsite_paid_amount: 50,
			authorizationId: "processor-authorization-secret",
			paymentToken: "processor-payment-token",
			token: "generic-token-secret",
			refresh_token: "generic-refresh-token-secret",
			nested: {
				api_key: "processor-api-key",
				secret: "generic-nested-secret",
			},
		},
		paypal_details: {
			captured_total_sar: 850,
			vault_id: "paypal-vault-secret",
			initial: {
				status: "COMPLETED",
				authorization_id: "processor-authorization-secret",
				cmid: "paypal-cmid-secret",
			},
			captures: [{ raw_response: "paypal-capture-secret" }],
		},
		vcc_payment: {
			charged: true,
			metadata: {
				card_last4: "4321",
				access_token: "vcc-access-secret",
			},
			attempts: [{ raw_request: "vcc-attempt-secret" }],
		},
		braintree_payment: {
			processing: false,
			client_token: "braintree-client-secret",
		},
		bofa_payment: {
			secure_acceptance: {
				status: "accepted",
				request_context: { value: "bofa-context-secret" },
				outbound_metadata: { value: "bofa-outbound-secret" },
				callbacks: [{ value: "bofa-callback-secret" }],
				hosted_request_fields: {
					signature: "bofa-signature-secret",
				},
			},
			vcc: {
				charged: true,
				lock_token: "bofa-lock-secret",
			},
		},
	};

	const originalUserFindById = User.findById;
	const originalHotelFindById = HotelDetails.findById;
	const originalReservationsFind = Reservations.find;
	let capturedProjection = null;

	const resolvedQuery = (value) => ({
		select() {
			return this;
		},
		lean() {
			return this;
		},
		exec: async () => value,
	});

	User.findById = () =>
		resolvedQuery({
			_id: actorId,
			activeUser: true,
			role: 2000,
			hotelIdsOwner: [hotelId],
		});
	HotelDetails.findById = () =>
		resolvedQuery({ _id: hotelId, belongsTo: actorId });
	Reservations.find = () => ({
		select(projection) {
			capturedProjection = projection;
			return this;
		},
		limit(value) {
			assert.equal(value, 2);
			return this;
		},
		lean() {
			return this;
		},
		exec: async () => [localReservation],
	});

	const response = responseStub();
	try {
		await reservationsController.singleReservation(
			{
				auth: { _id: actorId },
				params: {
					reservationNumber,
					hotelId: String(hotelId),
					belongsTo: String(actorId),
				},
			},
			response
		);
	} finally {
		User.findById = originalUserFindById;
		HotelDetails.findById = originalHotelFindById;
		Reservations.find = originalReservationsFind;
	}

	assert.equal(response.statusCode, 200);
	assert.deepEqual(capturedProjection, ADMIN_RESERVATION_LIST_PROJECTION);
	assert.equal(String(response.body._id), String(reservationId));
	assert.equal(response.body.booked_at.toISOString(), bookedAt.toISOString());
	assert.equal(response.body.checkin_date.toISOString(), checkinDate.toISOString());
	assert.equal(response.body.checkout_date.toISOString(), checkoutDate.toISOString());
	assert.equal(response.body.confirmation_number, reservationNumber);
	assert.equal(response.body.customer_details.name, "Safe Guest");
	assert.equal(response.body.customer_details.cardNumber, "************1111");
	assert.equal(response.body.customer_details.cardExpiryDate, undefined);
	assert.equal(response.body.customer_details.cardCVV, undefined);
	assert.equal(response.body.customer_details.cardHolderName, undefined);
	assert.equal(response.body.customer_details.card_number, undefined);
	assert.equal(response.body.customer_details.card_cvv, undefined);
	assert.equal(response.body.customer_details.card_expiry, undefined);
	assert.equal(response.body.customer_details.card_holder, undefined);

	assert.equal(
		response.body.payment_details.transactionId,
		"safe-transaction-reference"
	);
	assert.equal(response.body.payment_details.captured, true);
	assert.equal(response.body.payment_details.authorizationId, undefined);
	assert.equal(response.body.payment_details.paymentToken, undefined);
	assert.equal(response.body.payment_details.token, undefined);
	assert.equal(response.body.payment_details.refresh_token, undefined);
	assert.equal(response.body.payment_details.nested, undefined);
	assert.equal(response.body.paypal_details.captured_total_sar, 850);
	assert.equal(response.body.paypal_details.initial.status, "COMPLETED");
	assert.equal(response.body.paypal_details.vault_id, undefined);
	assert.equal(response.body.paypal_details.captures, undefined);
	assert.equal(response.body.vcc_payment.charged, true);
	assert.equal(response.body.vcc_payment.metadata.card_last4, "4321");
	assert.equal(response.body.vcc_payment.metadata.access_token, undefined);
	assert.equal(response.body.vcc_payment.attempts, undefined);
	assert.equal(response.body.bofa_payment.secure_acceptance.status, "accepted");
	assert.equal(response.body.bofa_payment.vcc.charged, true);
	assert.equal(response.body.bofa_payment.vcc.lock_token, undefined);

	const serializedResponse = JSON.stringify(response.body);
	assert.equal(serializedResponse.includes(encryptedCard), false);
	assert.equal(serializedResponse.includes(encryptedExpiry), false);
	for (const secret of secretValues) {
		assert.equal(serializedResponse.includes(secret), false, secret);
	}
});

test("review reservation middleware marks only successfully verified scope", async () => {
	const reservationId = new mongoose.Types.ObjectId();
	const hotelId = new mongoose.Types.ObjectId();
	const actorId = new mongoose.Types.ObjectId();
	const allowedRequest = {
		params: { reservationId: String(reservationId) },
		profile: {
			_id: actorId,
			activeUser: true,
			role: 1000,
			accessTo: ["JannatBookingWebsite", "AllReservations"],
			hotelIdWork: hotelId,
		},
	};
	let nextCalls = 0;
	const allowedMiddleware = hotelReview.buildRequireHotelReviewReservationScope({
		ReservationModel: { exists: async () => ({ _id: reservationId }) },
		superAdminIds: [],
	});
	await allowedMiddleware(allowedRequest, responseStub(), () => {
		nextCalls += 1;
	});
	assert.equal(nextCalls, 1);
	assert.equal(
		allowedRequest.hotelReviewReservationScopeVerifiedId,
		String(reservationId)
	);

	const deniedRequest = {
		params: { reservationId: String(reservationId) },
		profile: {
			_id: actorId,
			activeUser: true,
			role: 1000,
			accessTo: ["JannatBookingWebsite", "HotelsReservations"],
			hotelsToSupport: [hotelId],
		},
	};
	const deniedResponse = responseStub();
	const deniedMiddleware = hotelReview.buildRequireHotelReviewReservationScope({
		ReservationModel: { exists: async () => null },
		superAdminIds: [],
	});
	await deniedMiddleware(deniedRequest, deniedResponse, () => {
		nextCalls += 1;
	});
	assert.equal(deniedResponse.statusCode, 404);
	assert.equal(deniedRequest.hotelReviewReservationScopeVerifiedId, undefined);
	assert.equal(nextCalls, 1);

	const superAdminRequest = {
		params: { reservationId: String(reservationId) },
		profile: { _id: actorId, activeUser: true },
	};
	const superAdminMiddleware = hotelReview.buildRequireHotelReviewReservationScope({
		ReservationModel: {
			exists: async () => {
				throw new Error("super admin scope must not query reservations");
			},
		},
		superAdminIds: [String(actorId)],
	});
	await superAdminMiddleware(superAdminRequest, responseStub(), () => {
		nextCalls += 1;
	});
	assert.equal(nextCalls, 2);
	assert.equal(
		superAdminRequest.hotelReviewReservationScopeVerifiedId,
		String(reservationId)
	);
});

test("public and unauthorized detail responses branch before card decryption", () => {
	const controllerSource = fs.readFileSync(
		require.resolve("../controllers/reservations"),
		"utf8"
	);
	const start = controllerSource.indexOf(
		"exports.singleReservationById = async"
	);
	const end = controllerSource.indexOf("\nexports.", start + 1);
	const controller = controllerSource.slice(
		start,
		end >= 0 ? end : controllerSource.length
	);
	const publicProjection = controller.indexOf(
		"buildLegacyClientPaymentPayload(reservation)"
	);
	const decrypt = controller.indexOf("safeDecryptCustomerSecret(");

	assert.ok(start >= 0);
	assert.ok(publicProjection >= 0);
	assert.ok(decrypt > publicProjection);
	assert.match(controller, /detailsView && !fullDetailsAllowed/);
	assert.match(
		controller,
		/detailsView[\s\S]*attachAdminReservationRoomDetails[\s\S]*"_id hotelId room_number room_type display_name"/
	);
	assert.match(
		controller,
		/return res\.status\(404\)\.json\(\{ message: "Reservation not found\." \}\);/
	);
});
