/** @format */

const test = require("node:test");
const assert = require("node:assert/strict");
const {
	MAX_NIGHTS_PER_ROOM,
	MAX_ROOMS,
	canonicalPayload,
	dateRange,
	decimalToCents,
	eventKey,
	hashObject,
	normalizeHotelRunnerReservation,
	parseDateOnly,
	stableStringify,
} = require("./hotelrunnerPayload");

const makeRoom = ({
	id = "room-1",
	invCode = "INV-DOUBLE",
	name = "Double Room",
	totalGuests = 2,
	adults = 2,
	prices = ["125.00", "175.01"],
} = {}) => ({
	id,
	state: "confirmed",
	inv_code: invCode,
	rate_code: "BAR",
	rate_plan_code: "ROOM-ONLY",
	name,
	name_presentation: `${name} - Room Only`,
	checkin_date: "2026-08-10",
	checkout_date: "2026-08-12",
	nights: 2,
	total_guest: totalGuests,
	total_adult: adults,
	child_ages: Array.from({ length: Math.max(0, totalGuests - adults) }, () => 7),
	price: String(prices.reduce((sum, price) => sum + Number(price), 0)),
	total: String(prices.reduce((sum, price) => sum + Number(price), 0)),
	room_base_price: "200.00",
	room_sub_total: "300.01",
	non_refundable: false,
	meal_plan: "Room Only",
	comments: [
		{
			body: "Late arrival",
			channel_note: true,
			housekeeping: false,
			guest_visible: true,
		},
	],
	daily_prices: prices.map((price, index) => ({
		date: `2026-08-${10 + index}`,
		price,
		original_price: price,
		discount: "0.00",
		rate_code: "BAR",
	})),
	updated_at: "2026-08-06T10:30:00.000Z",
});

const makePayload = (overrides = {}) => ({
	message_uid: "message-uid-001",
	reservation_id: 987654321,
	hr_number: "R987654321",
	provider_number: "BOOKING-556677",
	pms_number: null,
	channel: "bookingcom",
	channel_display: "Booking.com",
	source_display: "Booking.com",
	state: "confirmed",
	modified: false,
	requires_response: false,
	next_states: ["confirm", "cancel", "unsupported"],
	guest: "Example Guest",
	firstname: "Example",
	lastname: "Guest",
	country: "SA",
	address: {
		city: "Makkah",
		country_code: "SA",
		phone: "+966500000000",
		email: "guest@example.test",
		street: "Example Street",
		postal_code: "24231",
	},
	checkin_date: "2026-08-10",
	checkout_date: "2026-08-12",
	completed_at: "2026-08-06T10:00:00.000Z",
	updated_at: "2026-08-06T10:30:00.000Z",
	total_guests: 2,
	total_rooms: 1,
	sub_total: "300.01",
	extras_total: "0.00",
	adjustments_total: "0.00",
	item_total: "300.01",
	tax_total: "0.00",
	total: "300.01",
	currency: "sar",
	note: "Please prepare the room",
	payment: "Pay at property",
	paid_amount: "300.01",
	payments: [
		{
			id: "payment-1",
			state: "paid",
			amount: "300.01",
			currency: "SAR",
			paid_at: "2026-08-06T10:31:00.000Z",
			payment_method_name: "OTA collect",
			payment_method: "virtual_card",
			response_code: "APPROVED",
		},
	],
	rooms: [makeRoom()],
	...overrides,
});

test("a complete HotelRunner reservation is normalized into bounded exact values", () => {
	const normalized = normalizeHotelRunnerReservation(makePayload());

	assert.deepEqual(normalized.issues, []);
	assert.equal(normalized.hotelRunnerReservationId, "987654321");
	assert.equal(normalized.state, "confirmed");
	assert.equal(normalized.requiresResponse, false);
	assert.deepEqual(normalized.nextStates, ["confirm", "cancel"]);
	assert.equal(normalized.currency, "SAR");
	assert.equal(normalized.totalCents, 30001);
	assert.equal(normalized.paidAmountCents, 30001);
	assert.equal(normalized.rooms.length, 1);
	assert.equal(normalized.rooms[0].invCode, "INV-DOUBLE");
	assert.deepEqual(
		normalized.rooms[0].dailyPrices.map((row) => [row.date, row.priceCents]),
		[
			["2026-08-10", 12500],
			["2026-08-11", 17501],
		]
	);
	assert.deepEqual(normalized.rooms[0].comments, [
		{
			body: "Late arrival",
			channelNote: true,
			housekeeping: false,
			guestVisible: true,
		},
	]);
	assert.equal(normalized.sourceUpdatedAt.toISOString(), "2026-08-06T10:30:00.000Z");
	assert.match(normalized.payloadHash, /^[a-f0-9]{64}$/);
	assert.match(normalized.canonicalHash, /^[a-f0-9]{64}$/);
});

test("multi-room stays preserve each inventory identity and validate every nightly row", () => {
	const rooms = [
		makeRoom(),
		makeRoom({
			id: "room-2",
			invCode: "INV-TRIPLE",
			name: "Triple Room",
			totalGuests: 3,
			adults: 2,
			prices: ["100.00", "99.99"],
		}),
	];
	const normalized = normalizeHotelRunnerReservation(
		makePayload({
			total_guests: 5,
			total_rooms: 2,
			total: "500.00",
			rooms,
		})
	);

	assert.deepEqual(normalized.issues, []);
	assert.equal(normalized.rooms.length, 2);
	assert.deepEqual(
		normalized.rooms.map((room) => [room.roomId, room.invCode, room.children]),
		[
			["room-1", "INV-DOUBLE", 0],
			["room-2", "INV-TRIPLE", 1],
		]
	);
});

test("canonical hashes ignore delivery identity, object order, room order, and nightly row order", () => {
	const firstRoom = makeRoom();
	const secondRoom = makeRoom({
		id: "room-2",
		invCode: "INV-TRIPLE",
		name: "Triple Room",
		prices: ["100.00", "99.99"],
	});
	const first = normalizeHotelRunnerReservation(
		makePayload({
			message_uid: "delivery-a",
			total_rooms: 2,
			total_guests: 4,
			total: "500.00",
			rooms: [firstRoom, secondRoom],
		})
	);
	const second = normalizeHotelRunnerReservation({
		...makePayload({
			message_uid: "delivery-b",
			total_rooms: 2,
			total_guests: 4,
			total: "500.00",
			rooms: [
				{ ...secondRoom, daily_prices: [...secondRoom.daily_prices].reverse() },
				{ ...firstRoom, daily_prices: [...firstRoom.daily_prices].reverse() },
			],
		}),
		ignored_unknown_field: "transport-only metadata",
	});

	assert.notEqual(first.payloadHash, second.payloadHash);
	assert.equal(first.canonicalHash, second.canonicalHash);
	assert.deepEqual(canonicalPayload(first), canonicalPayload(second));

	const changedPrice = normalizeHotelRunnerReservation(
		makePayload({
			message_uid: "delivery-c",
			total_rooms: 2,
			total_guests: 4,
			total: "500.00",
			rooms: [
				firstRoom,
				makeRoom({
					id: "room-2",
					invCode: "INV-TRIPLE",
					name: "Triple Room",
					prices: ["100.01", "99.98"],
				}),
			],
		})
	);
	assert.notEqual(first.canonicalHash, changedPrice.canonicalHash);
});

test("stored and canonical projections exclude raw card and credential-like fields", () => {
	const normalized = normalizeHotelRunnerReservation(
		makePayload({
			credit_card: {
				number: "4111111111111111",
				cvv: "CVV-SECRET-987",
				expiry: "12/30",
			},
			auth_token: "RAW-TOKEN-DO-NOT-STORE",
			payments: [
				{
					id: "payment-safe",
					state: "paid",
					amount: "300.01",
					currency: "SAR",
					payment_method: "virtual_card",
					card_number: "4111111111111111",
					cvv: "CVV-SECRET-987",
					token: "RAW-TOKEN-DO-NOT-STORE",
				},
			],
		})
	);
	const stored = JSON.stringify(normalized.storedPayload);
	const canonical = JSON.stringify(canonicalPayload(normalized));

	for (const secret of [
		"4111111111111111",
		"CVV-SECRET-987",
		"RAW-TOKEN-DO-NOT-STORE",
	]) {
		assert.equal(stored.includes(secret), false, secret);
		assert.equal(canonical.includes(secret), false, secret);
	}
	assert.deepEqual(normalized.storedPayload.payments[0], {
		amountCents: 30001,
		currency: "SAR",
		exchangeCurrency: "",
		exchangedAmountCents: null,
		id: "payment-safe",
		method: "virtual_card",
		methodName: "",
		paidAt: null,
		responseCode: "",
		state: "paid",
	});
});

test("a cancellation-only delivery is valid without guest, price, room, or stay details", () => {
	const normalized = normalizeHotelRunnerReservation({
		message_uid: "cancel-delivery-1",
		reservation_id: "reservation-1",
		hr_number: "R-1",
		state: "cancelled",
		cancel_reason: "Guest requested cancellation",
		updated_at: "2026-08-06T12:00:00.000Z",
	});

	assert.equal(normalized.state, "canceled");
	assert.equal(normalized.stayWasSupplied, false);
	assert.deepEqual(normalized.issues, []);

	const partialStay = normalizeHotelRunnerReservation({
		message_uid: "cancel-delivery-2",
		reservation_id: "reservation-1",
		state: "canceled",
		checkin_date: "2026-08-10",
		updated_at: "2026-08-06T12:01:00.000Z",
	});
	assert.ok(partialStay.issues.includes("invalid_stay_dates"));
});

test("room, night, identifier, and text resource limits fail closed and truncate stored data", () => {
	const tooManyRooms = Array.from({ length: MAX_ROOMS + 1 }, (_, index) =>
		makeRoom({ id: `room-${index}`, invCode: `INV-${index}` })
	);
	const roomOverflow = normalizeHotelRunnerReservation(
		makePayload({ rooms: tooManyRooms, total_rooms: MAX_ROOMS })
	);
	assert.equal(roomOverflow.rooms.length, MAX_ROOMS);
	assert.ok(roomOverflow.issues.includes("room_resource_limit"));

	const tooManyNights = Array.from(
		{ length: MAX_NIGHTS_PER_ROOM + 1 },
		(_, index) => ({ date: `day-${index}`, price: "1.00" })
	);
	const dailyOverflow = normalizeHotelRunnerReservation(
		makePayload({
			rooms: [{ ...makeRoom(), daily_prices: tooManyNights }],
		})
	);
	assert.equal(dailyOverflow.rooms[0].dailyPrices.length, MAX_NIGHTS_PER_ROOM);
	assert.ok(dailyOverflow.issues.includes("daily_price_resource_limit"));

	const boundedText = normalizeHotelRunnerReservation(
		makePayload({
			message_uid: `uid-${"x".repeat(500)}`,
			note: `hello\u0000\n  world ${"z".repeat(5_000)}`,
		})
	);
	assert.match(boundedText.messageUid, /^invalid-[a-f0-9]{32}$/);
	assert.ok(boundedText.issues.includes("invalid_message_uid"));
	assert.equal(boundedText.note.length, 4_000);
	assert.equal(boundedText.note.includes("\u0000"), false);
	assert.equal(boundedText.note.includes("\n"), false);
	assert.match(boundedText.note, /^hello world /);
	assert.deepEqual(dateRange("2026-01-01", "2027-01-03"), []);
});

test("invalid identity, dates, currency, totals, and nightly coverage produce explicit issues", () => {
	const normalized = normalizeHotelRunnerReservation(
		makePayload({
			message_uid: "",
			reservation_id: "",
			state: "surprise",
			updated_at: "not-a-date",
			checkin_date: "2026-02-30",
			checkout_date: "2026-02-28",
			currency: "SARS",
			total: "not-money",
			total_guests: -1,
			total_rooms: 2,
			rooms: [
				{
					...makeRoom(),
					inv_code: "",
					state: "canceled",
					nights: 3,
					daily_prices: [makeRoom().daily_prices[0]],
				},
			],
		})
	);

	for (const issue of [
		"invalid_message_uid",
		"invalid_reservation_id",
		"invalid_source_updated_at",
		"unknown_state",
		"invalid_stay_dates",
		"invalid_total",
		"invalid_currency",
		"invalid_guest_count",
		"missing_room_inv_code",
		"mixed_or_unsupported_room_state",
		"room_stay_conflict",
		"room_nights_conflict",
		"room_daily_prices_conflict",
		"room_count_conflict",
	]) {
		assert.ok(normalized.issues.includes(issue), issue);
	}
	assert.match(normalized.messageUid, /^invalid-[a-f0-9]{32}$/);
});

test("missing, non-numeric, and negative nightly prices fail closed", () => {
	for (const price of [undefined, "not-money", "-0.01"]) {
		const room = makeRoom();
		room.daily_prices[0] = { ...room.daily_prices[0], price };
		const normalized = normalizeHotelRunnerReservation(
			makePayload({ rooms: [room] })
		);
		assert.ok(
			normalized.issues.includes("invalid_room_daily_price"),
			String(price)
		);
	}
});

test("active reservations require consistent positive guest counts", () => {
	const zeroGuests = normalizeHotelRunnerReservation(
		makePayload({
			total_guests: 0,
			rooms: [makeRoom({ totalGuests: 0, adults: 0 })],
		})
	);
	assert.ok(zeroGuests.issues.includes("invalid_guest_count"));
	assert.ok(zeroGuests.issues.includes("invalid_room_guest_count"));

	const inconsistent = normalizeHotelRunnerReservation(
		makePayload({
			total_guests: 3,
			rooms: [makeRoom({ totalGuests: 2, adults: 3 })],
		})
	);
	assert.ok(inconsistent.issues.includes("invalid_room_guest_count"));
	assert.ok(inconsistent.issues.includes("guest_count_conflict"));

	const childAgesOmitted = makeRoom({ totalGuests: 3, adults: 2 });
	delete childAgesOmitted.child_ages;
	const derived = normalizeHotelRunnerReservation(
		makePayload({ total_guests: 3, rooms: [childAgesOmitted] })
	);
	assert.deepEqual(derived.issues, []);
	assert.equal(derived.rooms[0].children, 1);
});

test("active room lifecycle must agree with the reservation lifecycle", () => {
	const room = makeRoom();
	room.state = "reserved";
	const normalized = normalizeHotelRunnerReservation(
		makePayload({ state: "confirmed", rooms: [room] })
	);
	assert.ok(normalized.issues.includes("mixed_or_unsupported_room_state"));
});

test("money, calendar, stable serialization, and event-key helpers are deterministic", () => {
	assert.equal(decimalToCents("1,234.565"), 123457);
	assert.equal(decimalToCents("-0.005"), -1);
	assert.equal(decimalToCents("SAR 10"), null);
	assert.equal(parseDateOnly("2028-02-29"), "2028-02-29");
	assert.equal(parseDateOnly("2027-02-29"), "");
	assert.equal(
		stableStringify({ z: 1, a: { y: 2, x: 3 } }),
		stableStringify({ a: { x: 3, y: 2 }, z: 1 })
	);
	assert.equal(hashObject({ b: 2, a: 1 }), hashObject({ a: 1, b: 2 }));
	assert.equal(eventKey("property-fingerprint", "uid-1").length, 64);
	assert.equal(
		eventKey("property-fingerprint", "uid-1"),
		eventKey("property-fingerprint", "uid-1")
	);
	assert.notEqual(
		eventKey("property-fingerprint", "uid-1"),
		eventKey("property-fingerprint", "uid-2")
	);
});
