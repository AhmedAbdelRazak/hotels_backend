const assert = require("node:assert/strict");
const test = require("node:test");
const {
	reservationRoomNumbers,
	reservationRoomTypes,
} = require("./reservationRoomSummary");

test("room summary prefers assigned room details and removes duplicates", () => {
	const reservation = {
		roomId: [
			{
				_id: "65a000000000000000000101",
				room_number: "101",
				room_type: "doubleRooms",
				display_name: "City View",
			},
		],
		roomDetails: [
			{
				_id: "65a000000000000000000101",
				room_number: "101",
				room_type: "doubleRooms",
				display_name: "City View",
			},
			{ room_number: "305", room_type: "suite" },
		],
	};

	assert.deepEqual(reservationRoomNumbers(reservation), ["101", "305"]);
	assert.deepEqual(reservationRoomTypes(reservation), [
		"City View",
		"suite",
	]);
});

test("room summary falls back to reserved types without exposing raw room ids", () => {
	const reservation = {
		roomId: ["65a000000000000000000101"],
		pickedRoomsType: [
			{ room_type: "tripleRooms", displayName: "Family Triple" },
			{ roomType: "tripleRooms", displayName: "Family Triple" },
		],
	};

	assert.deepEqual(reservationRoomNumbers(reservation), []);
	assert.deepEqual(reservationRoomTypes(reservation), [
		"Family Triple",
	]);
});

test("room summary supports legacy room number fields", () => {
	const reservation = {
		room_numbers: ["202", "203", "202"],
		pickedRoomsType: [{ roomNumber: "204", roomType: "quadRooms" }],
	};

	assert.deepEqual(reservationRoomNumbers(reservation), ["202", "203", "204"]);
	assert.deepEqual(reservationRoomTypes(reservation), ["quadRooms"]);
});

test("booked room type takes precedence over a physical room display name", () => {
	const reservation = {
		pickedRoomsType: [
			{ room_type: "familyRooms", displayName: "Family Quintuple Room" },
		],
		roomDetails: [
			{
				room_number: "501",
				room_type: "familyRooms",
				display_name: "Spacious Six-Bed Room",
			},
		],
	};

	assert.deepEqual(reservationRoomTypes(reservation), [
		"Family Quintuple Room",
	]);
	assert.deepEqual(reservationRoomNumbers(reservation), ["501"]);
});
