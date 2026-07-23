/** @format */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
	activeRoomCandidates,
	matchOtaRoomWithOpenAi,
	normalizeAiRoomDecision,
	shouldAskAiForRoomMatch,
} = require("./otaAiRoomMatcher");

const hotel = {
	_id: "hotel-zad",
	hotelName: "Zad Ajyad",
	roomCountDetails: [
		{
			_id: "room-five",
			roomType: "familyRooms",
			displayName: "Family Quintuple Room",
			description: "Family room with five beds",
			activeRoom: true,
		},
		{
			_id: "room-six",
			roomType: "familyRooms",
			displayName: "Spacious Six-Bed Room",
			description: "Large family room with six beds",
			activeRoom: true,
		},
		{
			_id: "room-inactive",
			roomType: "doubleRooms",
			displayName: "Old Double Room",
			activeRoom: false,
		},
	],
};

test("AI room candidates contain only active configured PMS rooms", () => {
	assert.deepEqual(
		activeRoomCandidates(hotel).map(({ id, displayName }) => ({ id, displayName })),
		[
			{ id: "room-five", displayName: "Family Quintuple Room" },
			{ id: "room-six", displayName: "Spacious Six-Bed Room" },
		]
	);
});

test("exact and uniquely capacity-backed PMS matches avoid a second AI charge", () => {
	assert.equal(
		shouldAskAiForRoomMatch({ roomDetails: {}, matchType: "exact_display" }),
		false
	);
	assert.equal(
		shouldAskAiForRoomMatch({ roomDetails: {}, matchType: "explicit_capacity" }),
		false
	);
	assert.equal(
		shouldAskAiForRoomMatch({ roomDetails: {}, matchType: "fuzzy_display" }),
		true
	);
	assert.equal(shouldAskAiForRoomMatch({ roomDetails: null }), true);
});

test("AI room decisions must use an allowlisted PMS ID and pass confidence and capacity gates", () => {
	const candidates = activeRoomCandidates(hotel);
	const capacities = { "room-five": 5, "room-six": 6 };
	assert.equal(
		normalizeAiRoomDecision(
			{ selectedRoomId: "room-six", confidence: 0.94, reason: "six beds" },
			candidates,
			{ sourceCapacity: 6, candidateCapacities: capacities }
		).matched,
		true
	);
	assert.equal(
		normalizeAiRoomDecision(
			{ selectedRoomId: "invented-room", confidence: 1, reason: "invented" },
			candidates,
			{ sourceCapacity: 6, candidateCapacities: capacities }
		).matched,
		false
	);
	assert.equal(
		normalizeAiRoomDecision(
			{ selectedRoomId: "room-six", confidence: 0.79, reason: "uncertain" },
			candidates,
			{ sourceCapacity: 6, candidateCapacities: capacities }
		).matched,
		false
	);
	assert.match(
		normalizeAiRoomDecision(
			{ selectedRoomId: "room-five", confidence: 0.99, reason: "wrong size" },
			candidates,
			{ sourceCapacity: 6, candidateCapacities: capacities }
		).reason,
		/capacity 6 conflicts with PMS capacity 5/
	);
});

test("semantic room matching sends the resolved hotel's allowlist using strict structured output", async () => {
	let request;
	const client = {
		chat: {
			completions: {
				create: async (body) => {
					request = body;
					return {
						choices: [
							{
								message: {
									content: JSON.stringify({
										selectedRoomId: "room-six",
										confidence: 0.96,
										reason: "The OTA wording describes the six-bed room.",
									}),
								},
							},
						],
					};
				},
			},
		},
	};
	const result = await matchOtaRoomWithOpenAi({
		hotelDetails: hotel,
		normalized: {
			roomName: "A roomy family accommodation with six separate beds",
			guestName: "This Guest Must Never Be Sent",
			totalGuests: 0,
		},
		deterministicMatch: { roomDetails: null, matchType: "ambiguous" },
		sourceCapacity: 0,
		candidateCapacities: { "room-five": 5, "room-six": 6 },
		client,
	});

	assert.equal(result.matched, true);
	assert.equal(result.selectedRoomId, "room-six");
	assert.equal(request.response_format.type, "json_schema");
	assert.equal(request.response_format.json_schema.strict, true);
	const userPayload = JSON.parse(request.messages[1].content);
	assert.equal(userPayload.hotel.id, "hotel-zad");
	assert.deepEqual(
		userPayload.pmsRooms.map((room) => room.id),
		["room-five", "room-six"]
	);
	assert.deepEqual(
		userPayload.pmsRooms.map((room) => room.configuredCapacity),
		[5, 6]
	);
	assert.equal(request.messages[1].content.includes("This Guest Must Never Be Sent"), false);
});
