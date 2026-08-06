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
