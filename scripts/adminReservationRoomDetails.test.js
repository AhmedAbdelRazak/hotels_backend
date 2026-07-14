const assert = require("node:assert/strict");
const test = require("node:test");

const {
	attachAdminReservationRoomDetails,
	collectReservationRoomIds,
} = require("../services/adminReservationRoomDetails");

const HOTEL_A = "64a000000000000000000001";
const HOTEL_B = "64b000000000000000000000002";
const ROOM_101 = "65a000000000000000000101";
const ROOM_305 = "65a000000000000000000305";
const ROOM_ORPHAN = "65a000000000000000000999";
const ROOM_OTHER_HOTEL = "65b000000000000000000401";

test("does not query rooms when the page has no physical assignments", async () => {
	let calls = 0;
	const input = [
		{
			_id: "reservation-1",
			hotelId: { _id: HOTEL_A },
			roomId: [],
			pickedRoomsType: [{ displayName: "303", count: 3 }],
			bedNumber: ["7"],
		},
	];

	const result = await attachAdminReservationRoomDetails(input, async () => {
		calls += 1;
		return [];
	});

	assert.equal(calls, 0);
	assert.deepEqual(result[0].roomDetails, []);
	assert.equal(input[0].roomDetails, undefined);
});

test("loads one batch and preserves unique multi-room assignment order", async () => {
	let calls = 0;
	let requestedIds = [];
	const reservations = [
		{
			_id: "reservation-1",
			hotelId: { _id: HOTEL_A },
			roomId: [ROOM_305, ROOM_101, ROOM_305],
		},
		{
			_id: "reservation-2",
			hotelId: HOTEL_A,
			roomId: [{ _id: ROOM_101 }],
		},
	];

	const result = await attachAdminReservationRoomDetails(
		reservations,
		async (roomIds) => {
			calls += 1;
			requestedIds = roomIds;
			// Deliberately return a different order than the assignments.
			return [
				{
					_id: ROOM_101,
					hotelId: HOTEL_A,
					room_number: "101",
					room_type: "doubleRooms",
					display_name: "Double Room",
					cleanRoom: false,
				},
				{
					_id: ROOM_305,
					hotelId: HOTEL_A,
					room_number: "305",
					room_type: "quadRooms",
					display_name: "Quadruple Room",
					pricing: { nightly: 900 },
				},
			];
		},
	);

	assert.equal(calls, 1);
	assert.deepEqual(requestedIds, [ROOM_305, ROOM_101]);
	assert.deepEqual(
		result[0].roomDetails.map((room) => room.room_number),
		["305", "101"],
	);
	assert.deepEqual(result[1].roomDetails.map((room) => room.room_number), [
		"101",
	]);
	assert.deepEqual(Object.keys(result[0].roomDetails[0]).sort(), [
		"_id",
		"display_name",
		"room_number",
		"room_type",
	]);
});

test("normalizes scalar and legacy object references without accepting invalid IDs", () => {
	assert.deepEqual(
		collectReservationRoomIds([
			{ roomId: ROOM_101.toUpperCase() },
			{ roomId: [{ id: ROOM_305 }, { room_id: ROOM_101 }] },
			{ roomId: [{ roomId: ROOM_ORPHAN }, "not-an-object-id", null] },
		]),
		[ROOM_101, ROOM_305, ROOM_ORPHAN],
	);
});

test("omits orphaned and cross-hotel rooms while keeping valid assignments", async () => {
	const result = await attachAdminReservationRoomDetails(
		[
			{
				_id: "reservation-1",
				hotelId: HOTEL_A,
				roomId: [ROOM_ORPHAN, ROOM_OTHER_HOTEL, ROOM_101],
			},
		],
		async () => [
			{
				_id: ROOM_OTHER_HOTEL,
				hotelId: HOTEL_B,
				room_number: "401",
				room_type: "suite",
				display_name: "Suite",
			},
			{
				_id: ROOM_101,
				hotelId: HOTEL_A,
				roomNumber: " 101 ",
				roomType: "doubleRooms",
				displayName: " Double Room ",
			},
		],
	);

	assert.deepEqual(result[0].roomDetails, [
		{
			_id: ROOM_101,
			room_number: "101",
			room_type: "doubleRooms",
			display_name: "Double Room",
		},
	]);
});

test("does not infer physical rooms from pricing, counts, or bed assignments", async () => {
	const result = await attachAdminReservationRoomDetails(
		[
			{
				hotelId: HOTEL_A,
				pickedRoomsType: [{ room_type: "quadRooms", displayName: "303", count: 4 }],
				total_rooms: 4,
				bedNumber: ["7"],
			},
		],
		async () => {
			throw new Error("room lookup must not run");
		},
	);

	assert.deepEqual(result[0].roomDetails, []);
});
