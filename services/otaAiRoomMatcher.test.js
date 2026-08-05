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

const aiDecision = ({
	selectedRoomId,
	confidence,
	runnerUpRoomId = null,
	runnerUpConfidence = 0,
	basis = "semantic_name",
	reason = "semantic room match",
}) => ({
	selectedRoomId,
	confidence,
	runnerUpRoomId,
	runnerUpConfidence,
	basis,
	reason,
});

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
	assert.equal(
		shouldAskAiForRoomMatch({
			roomDetails: null,
			matchType: "explicit_capacity_unavailable",
			sourceCapacity: 3,
			aiFallbackAllowed: false,
		}),
		false
	);
});

test("a hard room capacity with no PMS candidate never invokes OpenAI", async () => {
	let calls = 0;
	const client = {
		chat: {
			completions: {
				create: async () => {
					calls += 1;
					throw new Error("must not be called");
				},
			},
		},
	};
	const result = await matchOtaRoomWithOpenAi({
		hotelDetails: hotel,
		normalized: { roomName: "Triple Room" },
		deterministicMatch: {
			roomDetails: null,
			matchType: "explicit_capacity_unavailable",
			sourceCapacity: 3,
			aiFallbackAllowed: false,
		},
		sourceCapacity: 3,
		candidateCapacities: { "room-five": 5, "room-six": 6 },
		client,
	});

	assert.equal(calls, 0);
	assert.equal(result.usedAI, false);
	assert.equal(result.matched, false);
	assert.equal(
		result.skipReason,
		"deterministic_room_signal_has_no_pms_candidate"
	);
});

test("AI room decisions must use an allowlisted PMS ID and pass confidence, ambiguity, and capacity gates", () => {
	const candidates = activeRoomCandidates(hotel);
	const capacities = { "room-five": 5, "room-six": 6 };
	assert.equal(
		normalizeAiRoomDecision(
			aiDecision({
				selectedRoomId: "room-six",
				confidence: 0.94,
				runnerUpRoomId: "room-five",
				runnerUpConfidence: 0.5,
				basis: "explicit_capacity",
				reason: "six beds",
			}),
			candidates,
			{ sourceCapacity: 6, candidateCapacities: capacities }
		).matched,
		true
	);
	assert.equal(
		normalizeAiRoomDecision(
			aiDecision({ selectedRoomId: "invented-room", confidence: 1 }),
			candidates,
			{ sourceCapacity: 6, candidateCapacities: capacities }
		).matched,
		false
	);
	assert.equal(
		normalizeAiRoomDecision(
			aiDecision({ selectedRoomId: "room-six", confidence: 0.59 }),
			candidates,
			{ sourceCapacity: 6, candidateCapacities: capacities }
		).matched,
		false
	);
	assert.match(
		normalizeAiRoomDecision(
			aiDecision({ selectedRoomId: "room-five", confidence: 0.99 }),
			candidates,
			{ sourceCapacity: 6, candidateCapacities: capacities }
		).reason,
		/capacity 6 conflicts with PMS capacity 5/
	);
	assert.equal(
		normalizeAiRoomDecision(
			aiDecision({
				selectedRoomId: "room-five",
				confidence: 0.88,
				runnerUpRoomId: "room-six",
				runnerUpConfidence: 0.84,
				basis: "room_category",
			}),
			candidates,
			{ minimumCapacity: 4, candidateCapacities: capacities }
		).rejectionCode,
		"ambiguous_margin"
	);
	assert.equal(
		normalizeAiRoomDecision(
			aiDecision({ selectedRoomId: "room-five", confidence: 0.92 }),
			candidates,
			{ minimumCapacity: 6, candidateCapacities: capacities }
		).rejectionCode,
		"occupancy_exceeds_pms_capacity"
	);
	assert.equal(
		normalizeAiRoomDecision(
			aiDecision({
				selectedRoomId: "room-six",
				confidence: 0.95,
				runnerUpRoomId: "room-five",
				runnerUpConfidence: 0.4,
				basis: "occupancy_only",
			}),
			candidates,
			{ candidateCapacities: capacities }
		).rejectionCode,
		"non_match_basis"
	);
	assert.equal(
		normalizeAiRoomDecision(
			aiDecision({
				selectedRoomId: "room-six",
				confidence: 0.95,
				runnerUpRoomId: "room-five",
				runnerUpConfidence: 0.4,
			}),
			candidates,
			{ minimumCapacity: 4, candidateCapacities: {} }
		).rejectionCode,
		"pms_capacity_unknown"
	);
	assert.equal(
		normalizeAiRoomDecision(
			aiDecision({ selectedRoomId: "room-six", confidence: 0.95 }),
			candidates,
			{ candidateCapacities: capacities }
		).rejectionCode,
		"missing_runner_up"
	);
	assert.equal(
		normalizeAiRoomDecision(
			aiDecision({
				selectedRoomId: "room-six",
				confidence: 0.95,
				runnerUpRoomId: "room-five",
				runnerUpConfidence: 0.4,
			}),
			candidates,
			{
				candidateCapacities: capacities,
				requiredRoomType: "suite",
			}
		).rejectionCode,
		"semantic_room_type_conflict"
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
									...aiDecision({
										selectedRoomId: "room-six",
										confidence: 0.96,
										runnerUpRoomId: "room-five",
										runnerUpConfidence: 0.55,
										basis: "semantic_name",
										reason: "The OTA wording describes the six-bed room.",
									}),
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
	assert.deepEqual(
		request.response_format.json_schema.schema.properties.selectedRoomId.enum,
		["room-five", "room-six", null]
	);
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
	assert.equal("bedsCount" in userPayload.pmsRooms[0], false);
	assert.match(request.messages[0].content, /Room 2.*not two beds/i);
	assert.equal(request.messages[1].content.includes("This Guest Must Never Be Sent"), false);
});

test("explicit capacity limits AI to capacity-compatible PMS candidates", async () => {
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
									content: JSON.stringify(
										aiDecision({
											selectedRoomId: "triple-deluxe",
											confidence: 0.91,
											runnerUpRoomId: "triple-city",
											runnerUpConfidence: 0.7,
											basis: "explicit_capacity",
										})
									),
								},
							},
						],
					};
				},
			},
		},
	};
	const capacityHotel = {
		_id: "capacity-hotel",
		roomCountDetails: [
			{ _id: "double", roomType: "doubleRooms", activeRoom: true },
			{ _id: "triple-deluxe", roomType: "tripleRooms", activeRoom: true },
			{ _id: "triple-city", roomType: "tripleRooms", activeRoom: true },
			{
				_id: "family-three",
				roomType: "familyRooms",
				displayName: "Family Room for 3 guests",
				activeRoom: true,
			},
		],
	};
	const result = await matchOtaRoomWithOpenAi({
		hotelDetails: capacityHotel,
		normalized: { roomName: "Tholasy premium room" },
		deterministicMatch: {
			roomDetails: null,
			matchType: "ambiguous",
			capacityCandidateIds: ["triple-deluxe", "triple-city"],
		},
		sourceCapacity: 3,
		candidateCapacities: {
			double: 2,
			"triple-deluxe": 3,
			"triple-city": 3,
			"family-three": 3,
		},
		client,
	});

	assert.equal(result.matched, true);
	assert.deepEqual(
		request.response_format.json_schema.schema.properties.selectedRoomId.enum,
		["triple-deluxe", "triple-city", null]
	);
	assert.deepEqual(
		JSON.parse(request.messages[1].content).pmsRooms.map((room) => room.id),
		["triple-deluxe", "triple-city"]
	);
});

test("transient OpenAI failures are retried once without widening the PMS allowlist", async () => {
	let attempts = 0;
	const client = {
		chat: {
			completions: {
				create: async () => {
					attempts += 1;
					if (attempts === 1) {
						const error = new Error("temporary upstream error");
						error.status = 503;
						throw error;
					}
					return {
						choices: [
							{
								message: {
									content: JSON.stringify(
										aiDecision({
											selectedRoomId: "room-five",
											confidence: 0.9,
											runnerUpRoomId: "room-six",
											runnerUpConfidence: 0.6,
											basis: "room_category",
										})
									),
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
		normalized: { roomName: "Deluxe Family Room 2", totalGuests: 4 },
		deterministicMatch: { roomDetails: null, matchType: "ambiguous" },
		minimumCapacity: 4,
		candidateCapacities: { "room-five": 5, "room-six": 6 },
		client,
	});

	assert.equal(attempts, 2);
	assert.equal(result.matched, true);
	assert.equal(result.selectedRoomId, "room-five");
});
