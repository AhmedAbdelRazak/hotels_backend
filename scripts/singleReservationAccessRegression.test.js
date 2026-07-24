/** @format */

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const mongoose = require("mongoose");

process.env.SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "SG.test";
process.env.AI_AGENT_TEST_EXPORTS = "true";

const reservationAccess = require("../controllers/reservations").__test;
const hotelReview = require("../controllers/hoteldetails").__test;

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
