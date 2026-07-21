/** @format */

process.env.SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "SG.test";

const test = require("node:test");
const assert = require("node:assert/strict");
const Reservations = require("../models/reservations");
const {
	detectPaymentCollectionModel,
	extractNormalizedReservation,
	resolvePaymentMapping,
	resolveRoomMatch,
} = require("./otaReservationMapper");

const HOTEL_ROOMS = [
	{ roomType: "doubleRooms", displayName: "Double Room", activeRoom: true },
	{ roomType: "tripleRooms", displayName: "Triple Room", activeRoom: true },
	{ roomType: "quadRooms", displayName: "Quadruple Room", activeRoom: true },
	{ roomType: "familyRooms", displayName: "Family Quintuple Room", activeRoom: true },
];

const hotelRunnerEmail = ({ roomName, guestCount }) => ({
	from: '"HotelRunner" <noreply@hotelrunner.com>',
	to: "ota@example.com",
	subject: "Zad AJYAD Hotel - New Reservation #R123456789",
	text: [
		"Booking Source Agoda",
		"Confirmation Number 680785631",
		"Hotel Name Zad Ajyad",
		"Room Type",
		roomName,
		"Check-in Date",
		"Jul 23, 2026",
		"Check-out Date",
		"Jul 24, 2026",
		"Guest Count",
		String(guestCount),
		`Adult Count:${guestCount}`,
		"Children Count:0",
		"Channel:Maximum Gain",
	].join("\n"),
});

test("HotelRunner guest occupancy is not treated as a room count", () => {
	const normalized = extractNormalizedReservation(
		hotelRunnerEmail({
			roomName: "Comfort Triple Room - 3 beds - AJYAD Hotel- 15 Mins from Haram",
			guestCount: 2,
		})
	);

	assert.equal(normalized.provider, "agoda");
	assert.equal(normalized.totalGuests, 2);
	assert.equal(normalized.roomCount, 1);
});

test("explicit bed capacity wins over unrelated numbers and broad family wording", () => {
	const triple = extractNormalizedReservation(
		hotelRunnerEmail({
			roomName: "Comfort Triple Room - 3 beds - AJYAD Hotel- 15 Mins from Haram",
			guestCount: 2,
		})
	);
	const tripleMatch = resolveRoomMatch(
		{ roomCountDetails: HOTEL_ROOMS },
		triple.roomName,
		{ totalGuests: triple.totalGuests, normalized: triple }
	);
	assert.equal(tripleMatch.roomDetails.roomType, "tripleRooms");

	const familyFourBed = extractNormalizedReservation(
		hotelRunnerEmail({
			roomName: "Comfort Family Room - 4 beds - AJYAD Hotel- 15 Mins from Haram",
			guestCount: 4,
		})
	);
	const familyMatch = resolveRoomMatch(
		{ roomCountDetails: HOTEL_ROOMS },
		familyFourBed.roomName,
		{ totalGuests: familyFourBed.totalGuests, normalized: familyFourBed }
	);
	assert.equal(familyMatch.roomDetails.roomType, "quadRooms");
});

test("explicit Agoda room-count labels remain supported", () => {
	const normalized = extractNormalizedReservation({
		from: "no-reply@agoda.com",
		subject: "Agoda Booking ID 2034360128 - CONFIRMED",
		text: [
			"Booking ID",
			"2034360128",
			"Room Type",
			"Deluxe Room",
			"No. of rooms",
			"2",
			"Occupancy",
			"2 adults",
		].join("\n"),
	});

	assert.equal(normalized.roomCount, 2);
});

test("ExpediaCollect with EVC is treated as a virtual card pending capture", () => {
	const normalized = extractNormalizedReservation({
		from: '"Reservations" <notifications@example.com>',
		to: "ota@inbound.jannatbooking.com",
		subject: "Expedia reservation",
		text: [
			"Expedia (Expedia Affiliate Network)",
			"Confirmation Number 9990001112",
			"Guest Name Test Guest",
			"Order Total $ 154.26",
			"Note Payment Method:ExpediaCollect EVC Charge Status:READY TO CHARGE ON CHECK IN DATE",
			"Room Type Comfort Family Room - 4 beds - AJYAD Hotel- 15 Mins from Haram",
			"Check-in Date Aug 06, 2026",
			"Check-out Date Aug 16, 2026",
			"Guest Count 4 (2 children, 2 adults)",
			"Status Reservation",
		].join("\n"),
	});

	assert.equal(normalized.provider, "expedia");
	assert.equal(normalized.paymentCollectionModel, "virtual_card");
	assert.equal(normalized.paidOnline, false);
	assert.equal(normalized.sourcePresence.paymentCollectionModel, true);

	const payment = resolvePaymentMapping(normalized, 578.47, 520.62, 57.85);
	assert.equal(payment.payment, "credit/ debit");
	assert.equal(payment.financeStatus, "not paid");
	assert.equal(payment.paidAmount, 0);
});

test("compact ExpediaCollect remains OTA collect without virtual-card evidence", () => {
	assert.equal(
		detectPaymentCollectionModel("Payment Method:ExpediaCollect"),
		"ota_collect"
	);
	assert.equal(
		detectPaymentCollectionModel("Payment Method:Expedia Collect"),
		"ota_collect"
	);
	assert.equal(
		detectPaymentCollectionModel(
			"Payment Method:ExpediaCollect EVC Charge Status:READY"
		),
		"virtual_card"
	);
	assert.equal(detectPaymentCollectionModel("Reference code EVC"), "unknown");
});

test("reservation schema declares an atomic partial unique OTA identity index", () => {
	const index = Reservations.schema
		.indexes()
		.find(([, options]) => options?.name === "uniq_ota_identity_key");

	assert.ok(index);
	assert.deepEqual(index[0], { otaIdentityKey: 1 });
	assert.equal(index[1].unique, true);
	assert.deepEqual(index[1].partialFilterExpression, {
		otaIdentityKey: { $type: "string", $gt: "" },
	});
});
