/** @format */

process.env.SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "SG.test";

const test = require("node:test");
const assert = require("node:assert/strict");
const Reservations = require("../models/reservations");
const HotelDetails = require("../models/hotel_details");
const InboundEmail = require("../models/inbound_email");
const {
	getDeterministicExtractionSkipReason,
	isWeakOtaConfirmationValue,
} = require("./otaEmailOrchestrator");
const {
	buildExistingReservationUpdateSet,
	buildLegacyRedactedTripConflictLookup,
	buildOtaCrossTransportIdentityKey,
	buildOtaConfirmationLookup,
	buildOtaIdentityKey,
	buildReservationDocument,
	buildUnmappedOtaReviewReservationDocument,
	canCreateUnmappedOtaReviewReservation,
	detectConfirmationMatchFields,
	detectPaymentCollectionModel,
	detectProvider,
	detectStatusToApply,
	explicitRoomCapacity,
	extractNormalizedReservation,
	fetchWithHardTimeout,
	findConfidentFuzzyHotelMatch,
	findReservationByOtaConfirmation,
	generateDateRange,
	getManualOtaHotelAssignmentReason,
	isAuthoritativeSourceUpgrade,
	isStaleOtaLifecycleEvent,
	isOtaInboundTotalOutlier,
	isPlausibleOtaGuestName,
	isPlausibleOtaRoomName,
	otaSourceAuthority,
	parseDate,
	parseMoney,
	redactSensitive,
	requiredNewReservationMissing,
	reconcileOtaReservation,
	resolvedIncomingHotelConflictsWithExisting,
	resolveBookingSource,
	resolveHotel,
	resolvePaymentMapping,
	resolveRoomMatch,
	resolveRoomMatchWithAi,
	roomCapacityFromLabels,
	selectConsistentOtaIdentityCandidate,
	terminalLifecycleStayDatesConflict,
	trustedProviderFromSenderAddress,
	validateReservationOtaIdentityConsistency,
	wouldReopenTerminalOtaReservation,
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

test("explicit class wins while semantic family wording cannot auto-map to a quad", () => {
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

	const tripleWithFourGuests = extractNormalizedReservation(
		hotelRunnerEmail({
			roomName: "Comfort Triple Room - 3 beds - AJYAD Hotel- 15 Mins from Haram",
			guestCount: 4,
		})
	);
	const tripleWithFourGuestsMatch = resolveRoomMatch(
		{ roomCountDetails: HOTEL_ROOMS },
		tripleWithFourGuests.roomName,
		{
			totalGuests: tripleWithFourGuests.totalGuests,
			normalized: tripleWithFourGuests,
		}
	);
	assert.equal(tripleWithFourGuests.totalGuests, 4);
	assert.equal(tripleWithFourGuestsMatch.sourceCapacity, 3);
	assert.equal(tripleWithFourGuestsMatch.roomDetails.roomType, "tripleRooms");

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
	assert.equal(familyMatch.roomDetails, null);
	assert.equal(familyMatch.sourceCapacity, 4);
	assert.notEqual(familyMatch.matchType, "explicit_capacity");
});

test("named room capacity outranks rate-plan occupancy in observed OTA titles", () => {
	const cases = [
		["Triple Bed Room With Air Conditioning - Non-Refundable - 1 Occupancy", 3],
		["Triple Bed Room With Air Conditioning - Non-Refundable - 2 Occupancy", 3],
		["Comfort Double - Non-Smoking - Non-Refundable - 1 Occupancy", 2],
		["Family - 6 Persons - Non-Refundable - 5 Occupancy", 6],
		[
			"Deluxe Family Room 2 - Non-Refundable - 1 Occupancy | غرفة عائلة لاربع أفراد",
			4,
		],
	];
	for (const [roomName, capacity] of cases) {
		assert.equal(explicitRoomCapacity(roomName), capacity, roomName);
	}
	const conflictingClassMatch = resolveRoomMatch(
		{ roomCountDetails: HOTEL_ROOMS },
		"Double Room or Triple Room"
	);
	assert.equal(conflictingClassMatch.roomDetails, null);
	assert.equal(conflictingClassMatch.matchType, "conflicting_room_class");
	assert.equal(conflictingClassMatch.aiFallbackAllowed, false);
	const conflictingPersonMatch = resolveRoomMatch(
		{ roomCountDetails: HOTEL_ROOMS },
		"Family Room for 2 persons | غرفة 3 افراد, 2 beds"
	);
	assert.equal(conflictingPersonMatch.roomDetails, null);
	assert.equal(conflictingPersonMatch.matchType, "conflicting_person_capacity");
	assert.equal(conflictingPersonMatch.aiFallbackAllowed, false);
});

test("room class, person capacity, and bed composition use structured precedence", () => {
	const cases = [
		["Triple Room with 1 double bed and 1 single bed", 3],
		["Quadruple Room with 2 double beds", 4],
		["Family Room with 2 double beds for 4 persons", 4],
		["Twin Room for single use", 2],
		["Room with 3 single beds", 3],
		["Deluxe Triple Room with double bed", 3],
		["Double Occupancy Triple Room", 3],
		["Single Use Double Room", 2],
		["Double Bed Triple Room", 3],
		["1 Double Bed Triple Room", 3],
		["Twin Bed Triple Room", 3],
		["Single Guest Room", 1],
		["غرفة ثلاثية سرير مزدوج وسرير فردي", 3],
		["غرفة ثلاثية بسرير مزدوج وسرير فردي", 3],
		["غرفة ثلاثية وسرير مزدوج وسرير فردي", 3],
		["غرفة ثلاثية بالسرير مزدوج والسرير فردي", 3],
		["ثلاثية بسرير مزدوج", 3],
		["ثلاثية سرير مزدوج", 3],
		["غرفة 5 أفراد سريرين مزدوجين", 5],
		["1 double bed and 1 single bed", 3],
		["Family Room for 5 guests", 5],
	];
	for (const [roomName, capacity] of cases) {
		assert.equal(explicitRoomCapacity(roomName), capacity, roomName);
	}
	const ambiguousBedLayout = resolveRoomMatch(
		{ roomCountDetails: HOTEL_ROOMS },
		"1 king bed alternatively 2 twin beds"
	);
	assert.equal(ambiguousBedLayout.roomDetails, null);
	assert.notEqual(ambiguousBedLayout.matchType, "explicit_capacity");
	assert.notEqual(ambiguousBedLayout.aiFallbackAllowed, false);
	const soloTravelerRate = resolveRoomMatch(
		{ roomCountDetails: HOTEL_ROOMS },
		"Deluxe Room for Solo Traveler"
	);
	assert.equal(soloTravelerRate.roomDetails, null);
	assert.notEqual(soloTravelerRate.matchType, "explicit_capacity");
	assert.notEqual(soloTravelerRate.aiFallbackAllowed, false);
});

test("repeated bed evidence is deduplicated and unrelated bare numbers are ignored", () => {
	const cases = [
		["5 Beds Room (Comfort 5 Beds Room)", 5],
		["5 Beds Room | Comfort 5 Beds Room", 5],
		["1 double bed and 1 single bed (1 double bed and 1 single bed)", 3],
		["2 beds (1 double bed)", 2],
		["Deluxe Family Room 2", 0],
		["Room 2", 0],
		["Two Bedroom Suite", 0],
		["Room 4, rate 300, check-in 2026-08-10", 0],
		["Double Room or Triple Room", 0],
		["Double Room or Triple Room for 2 persons", 0],
		["Double Room or Triple Room with 1 double bed", 0],
		["1 king bed or 2 twin beds", 0],
		["1 king bed alternatively 2 twin beds", 0],
		["1 king bed | 2 twin beds", 0],
		["1 king bed; 2 twin beds", 0],
		["1 king bed, 2 twin beds", 0],
		["1 king bed\n2 twin beds", 0],
		["1 queen bed / 2 single beds", 0],
		["1 double bed and 1 sofa bed", 0],
		["1 double bed and 1 extra bed", 0],
		["1 bunk bed and 1 single bed", 0],
		["Bedroom 1: 1 double bed; Bedroom 2: 1 double bed", 0],
		["1 bed and 1 bed", 0],
		["غرفة بسرير فردي وسرير مزدوج", 0],
		["Family Room for 2 persons | غرفة 3 افراد", 0],
		["Family Room for 2 persons | غرفة 3 افراد, 2 beds", 0],
		["Room for 2 adults and 1 child", 0],
		["Family Room for 2 adults and 2 children", 0],
		["Stay for two nights", 0],
		["Deluxe Room for Solo Traveler", 0],
		["Deluxe Room for Single Traveler", 0],
		["Room for 2 nights", 0],
		["Accommodation for three nights", 0],
		["Room for 15 minutes", 0],
		["غرفة لثلاث ليال", 0],
		["لست بحاجة إلى سرير إضافي", 0],
		["الثلاثاء", 0],
		["الأربعاء", 0],
		["حجز لثلاث غرف", 0],
		["Double Room or Triple", 0],
		["Triple Room or Double", 0],
		["Triple Room / Double", 0],
		["Bed in Triple Room", 0],
		["Individual Bed in Triple Room", 0],
		["Shared Bed in Triple Room", 0],
		["Dorm Bed in Triple Room", 0],
		["سرير في غرفة ثلاثية", 0],
		["سرير فردي في غرفة ثلاثية", 0],
	];
	for (const [roomName, capacity] of cases) {
		assert.equal(explicitRoomCapacity(roomName), capacity, roomName);
	}
});

test("Arabic spelling, joined digits, and conservative transliterations map deterministically", () => {
	const cases = [
		["خطوات للحرم الشريف - باص خاص - غرفة ثلاثى", 3],
		["الغرفة الثلاثية", 3],
		["غرفة الثلاثية", 3],
		["غرفة ثلاثيه", 3],
		["ثلاثيه", 3],
		["غرفة ثُلاثية", 3],
		["غرفةثلاثية", 3],
		["الغرفةالثلاثية", 3],
		["غرفة لثلاث أفراد خاصة", 3],
		["غرفة خماسى خاصة", 5],
		["غرفة5 افراد خاصة", 5],
		["وفر وقت وجهد غرفة 2 فرد", 2],
		["Tholasy Room", 3],
		["Thulathi private room", 3],
		["Khomasy Room", 5],
	];
	for (const [roomName, capacity] of cases) {
		assert.equal(explicitRoomCapacity(roomName), capacity, roomName);
	}
});

test("Arabic dual room tokens map with normalized hamza and article forms", () => {
	const hotel = {
		roomCountDetails: [
			{
				_id: "double-room",
				roomType: "doubleRooms",
				displayName: "Double Room",
				activeRoom: true,
			},
		],
	};
	for (const roomName of [
		"ثنائي",
		"الثنائي",
		"ثنائية",
		"الثنائية",
		"غرفة ثنائي",
		"الغرفة الثنائية",
		"غرفةثنائية",
		"الغرفةالثنائية",
	]) {
		assert.equal(explicitRoomCapacity(roomName), 2, roomName);
		const match = resolveRoomMatch(hotel, roomName);
		assert.equal(match.roomDetails?._id, "double-room", roomName);
		assert.equal(match.matchType, "explicit_capacity", roomName);
		assert.equal(match.aiFallbackAllowed, false, roomName);
	}
});

test("PMS display class and canonical room type outrank incidental one-bed descriptions", () => {
	assert.equal(
		roomCapacityFromLabels({
			roomType: "tripleRooms",
			displayName: "Spacious Triple Room with City View",
			description: "Includes one large bed and one sofa.",
			bedsCount: 1,
		}),
		3
	);
	assert.equal(
		roomCapacityFromLabels({
			roomType: "tripleRooms",
			displayName: "Premium Accommodation",
			description: "Includes one large bed.",
			bedsCount: 1,
		}),
		3
	);
	assert.equal(
		roomCapacityFromLabels({
			roomType: "doubleRooms",
			displayName: "Triple Room",
			activeRoom: true,
		}),
		2
	);
	assert.equal(
		roomCapacityFromLabels({
			roomType: "tripleRooms",
			displayName: "Double Room",
			activeRoom: true,
		}),
		3
	);
	const contradictoryLabels = resolveRoomMatch(
		{
			roomCountDetails: [
				{
					_id: "canonical-double",
					roomType: "doubleRooms",
					displayName: "Triple Room",
					activeRoom: true,
				},
				{
					_id: "canonical-triple",
					roomType: "tripleRooms",
					displayName: "Double Room",
					activeRoom: true,
				},
			],
		},
		"Triple Room"
	);
	assert.equal(contradictoryLabels.roomDetails?._id, "canonical-triple");
	assert.equal(contradictoryLabels.aiFallbackAllowed, false);
});

test("named room classes map only to their exact canonical PMS class", () => {
	const rooms = [
		{
			_id: "canonical-single",
			roomType: "singleRooms",
			displayName: "Shared Bed",
			activeRoom: true,
		},
		{
			_id: "canonical-double",
			roomType: "doubleRooms",
			displayName: "Twin Room",
			activeRoom: true,
		},
		{
			_id: "canonical-twin",
			roomType: "twinRooms",
			displayName: "Double Room",
			activeRoom: true,
		},
		{
			_id: "canonical-triple",
			roomType: "tripleRooms",
			displayName: "Double Room",
			activeRoom: true,
		},
		{
			_id: "family-displayed-triple",
			roomType: "familyRooms",
			displayName: "Triple Room",
			activeRoom: true,
		},
		{
			_id: "shared-displayed-single",
			roomType: "individualBed",
			displayName: "Single Room",
			activeRoom: true,
		},
	];
	for (const [sourceName, expectedId] of [
		["Single Room", "canonical-single"],
		["Double Room", "canonical-double"],
		["Twin Room", "canonical-twin"],
		["Triple Room", "canonical-triple"],
	]) {
		const match = resolveRoomMatch({ roomCountDetails: rooms }, sourceName);
		assert.equal(match.roomDetails?._id, expectedId, sourceName);
		assert.equal(match.matchType, "explicit_capacity", sourceName);
		assert.equal(match.aiFallbackAllowed, false, sourceName);
	}

	const withoutCanonicalTriple = resolveRoomMatch(
		{
			roomCountDetails: rooms.filter(
				(room) => room._id !== "canonical-triple"
			),
		},
		"Triple Room"
	);
	assert.equal(withoutCanonicalTriple.roomDetails, null);
	assert.equal(withoutCanonicalTriple.matchType, "explicit_capacity_unavailable");
	assert.equal(withoutCanonicalTriple.aiFallbackAllowed, false);
});

test("semantic king, queen, suite, studio, and family names are not reduced to bed capacity", () => {
	const hotel = {
		roomCountDetails: [
			{
				_id: "double-only",
				roomType: "doubleRooms",
				displayName: "Double Room",
				activeRoom: true,
			},
			{
				_id: "quad-only",
				roomType: "quadRooms",
				displayName: "Quad Room",
				activeRoom: true,
			},
		],
	};
	for (const sourceName of [
		"King Room with 1 king bed",
		"Queen Room with 1 queen bed",
		"Junior Suite with 1 king bed",
		"Studio with 1 queen bed",
		"Family Room with 4 beds",
	]) {
		const match = resolveRoomMatch(hotel, sourceName);
		assert.equal(match.roomDetails, null, sourceName);
		assert.notEqual(match.matchType, "explicit_capacity", sourceName);
	}
});

test("canonical semantic PMS types outrank contradictory exact display labels", () => {
	for (const [roomName, configuredRoomType, expectedRoomType] of [
		["Family Room", "quadRooms", "familyRooms"],
		["King Room", "doubleRooms", "kingRooms"],
		["Queen Room", "doubleRooms", "queenRooms"],
		["Standard Room", "doubleRooms", "standardRooms"],
		["Studio Room", "doubleRooms", "studioRooms"],
		["Junior Suite", "doubleRooms", "suite"],
		["Master Suite", "doubleRooms", "masterSuite"],
		["Bed in Shared Room", "tripleRooms", "individualBed"],
	]) {
		const match = resolveRoomMatch(
			{
				roomCountDetails: [
					{
						_id: "contradictory-room",
						roomType: configuredRoomType,
						displayName: roomName,
						activeRoom: true,
					},
				],
			},
			roomName
		);
		assert.equal(match.roomDetails, null, roomName);
		assert.equal(match.mappedRoomType, expectedRoomType, roomName);
		assert.equal(match.aiFallbackAllowed, false, roomName);
		assert.ok(
			["semantic_room_type_unavailable", "explicit_semantic_unavailable"].includes(
				match.matchType
			),
			roomName
		);
	}
});

test("every protected semantic category maps when its active canonical PMS type exists", () => {
	for (const [roomName, roomType] of [
		["Family Room", "familyRooms"],
		["King Room", "kingRooms"],
		["Queen Room", "queenRooms"],
		["Standard Room", "standardRooms"],
		["Studio Room", "studioRooms"],
		["Junior Suite", "suite"],
		["Master Suite", "masterSuite"],
		["Bed in Shared Room", "individualBed"],
	]) {
		const match = resolveRoomMatch(
			{
				roomCountDetails: [
					{
						_id: `canonical-${roomType}`,
						roomType,
						displayName: roomName,
						activeRoom: true,
					},
				],
			},
			roomName
		);
		assert.equal(match.roomDetails?._id, `canonical-${roomType}`, roomName);
		assert.equal(match.mappedRoomType, roomType, roomName);
	}
});

test("king and queen semantics outrank the generic Standard modifier", () => {
	const hotel = {
		roomCountDetails: [
			{
				_id: "standard",
				roomType: "standardRooms",
				displayName: "Standard Room",
				activeRoom: true,
			},
			{
				_id: "standard-king",
				roomType: "kingRooms",
				displayName: "Standard King Room",
				activeRoom: true,
			},
			{
				_id: "standard-queen",
				roomType: "queenRooms",
				displayName: "Standard Queen Room",
				activeRoom: true,
			},
		],
	};

	const king = resolveRoomMatch(hotel, "Standard King Room");
	assert.equal(king.mappedRoomType, "kingRooms");
	assert.equal(king.roomDetails?._id, "standard-king");
	const queen = resolveRoomMatch(hotel, "Standard Queen Room");
	assert.equal(queen.mappedRoomType, "queenRooms");
	assert.equal(queen.roomDetails?._id, "standard-queen");
});

test("unavailable semantic PMS categories remain unmapped without room AI", async () => {
	const hotel = {
		_id: "semantic-missing-hotel",
		roomCountDetails: [
			{
				_id: "double-only",
				roomType: "doubleRooms",
				displayName: "Double Room",
				activeRoom: true,
			},
			{
				_id: "quad-only",
				roomType: "quadRooms",
				displayName: "Quad Room",
				activeRoom: true,
			},
		],
	};
	for (const [roomName, mappedRoomType] of [
		["Family Room for 4 persons", "familyRooms"],
		["King Room with 1 king bed", "kingRooms"],
		["Standard Room", "standardRooms"],
	]) {
		const match = await resolveRoomMatchWithAi(hotel, {
			roomName,
			roomCount: 1,
			totalGuests: 0,
		});
		assert.equal(match.roomDetails, null, roomName);
		assert.equal(match.matchType, "semantic_room_type_unavailable", roomName);
		assert.equal(match.mappedRoomType, mappedRoomType, roomName);
		assert.equal(match.aiFallbackAllowed, false, roomName);
		assert.deepEqual(match.capacityCandidateIds, [], roomName);
		assert.equal(match.aiRoomMatch?.usedAI, false, roomName);
		assert.equal(
			match.aiRoomMatch?.skipReason,
			"deterministic_room_signal_has_no_pms_candidate",
			roomName
		);
		assert.match(match.warnings?.[0] || "", /remains unmapped for review/i);
	}
});

test("bed-in-room wording maps to individual-bed inventory, never the containing room class", () => {
	const rooms = [
		{
			_id: "individual-bed",
			roomType: "individualBed",
			displayName: "Bed in Shared Room",
			activeRoom: true,
		},
		{
			_id: "triple-room",
			roomType: "tripleRooms",
			displayName: "Triple Room",
			activeRoom: true,
		},
	];
	for (const sourceName of [
		"Bed in Triple Room",
		"Individual Bed in Triple Room",
		"Shared Bed in Triple Room",
		"Dorm Bed in Triple Room",
		"سرير في غرفة ثلاثية",
		"سرير فردي في غرفة ثلاثية",
	]) {
		const match = resolveRoomMatch({ roomCountDetails: rooms }, sourceName);
		assert.equal(match.roomDetails?._id, "individual-bed", sourceName);
		assert.equal(match.matchType, "explicit_room_semantic", sourceName);
		assert.equal(match.aiFallbackAllowed, false, sourceName);
	}

	const withoutIndividualBed = resolveRoomMatch(
		{ roomCountDetails: [rooms[1]] },
		"Bed in Triple Room"
	);
	assert.equal(withoutIndividualBed.roomDetails, null);
	assert.equal(
		withoutIndividualBed.matchType,
		"explicit_semantic_unavailable"
	);
	assert.equal(withoutIndividualBed.aiFallbackAllowed, false);
});

test("explicit triple maps without AI only when a triple-capacity PMS room exists", () => {
	const sourceRoomName = "Triple Room - 1 Occupancy";
	const withTriple = resolveRoomMatch(
		{
			roomCountDetails: [
				{
					_id: "triple-room",
					roomType: "tripleRooms",
					displayName: "Premium Accommodation",
					description: "Includes one large bed.",
					activeRoom: true,
				},
			],
		},
		sourceRoomName
	);
	assert.equal(withTriple.roomDetails?._id, "triple-room");
	assert.equal(withTriple.matchType, "explicit_capacity");
	assert.equal(withTriple.aiFallbackAllowed, false);

	const withoutTriple = resolveRoomMatch(
		{
			roomCountDetails: [
				{
					_id: "family-three",
					roomType: "familyRooms",
					displayName: "Family Room for 3 guests",
					activeRoom: true,
				},
			],
		},
		sourceRoomName
	);
	assert.equal(withoutTriple.roomDetails, null);
	assert.equal(withoutTriple.matchType, "explicit_capacity_unavailable");
	assert.equal(withoutTriple.sourceCapacity, 3);
	assert.equal(withoutTriple.capacityCandidateCount, 0);
	assert.equal(withoutTriple.aiFallbackAllowed, false);
	for (const arabicVariant of ["الغرفة الثلاثية", "غرفة ثُلاثية", "غرفةثلاثية"]) {
		const variantMatch = resolveRoomMatch(
			{
				roomCountDetails: [
					{
						_id: "double-room",
						roomType: "doubleRooms",
						displayName: "Double Room",
						activeRoom: true,
					},
				],
			},
			arabicVariant
		);
		assert.equal(variantMatch.roomDetails, null, arabicVariant);
		assert.equal(
			variantMatch.matchType,
			"explicit_capacity_unavailable",
			arabicVariant
		);
		assert.equal(variantMatch.aiFallbackAllowed, false, arabicVariant);
	}

	const review = buildUnmappedOtaReviewReservationDocument({
		provider: "hotelrunner",
		providerLabel: "HotelRunner",
		bookingSource: "Trip.com",
		confirmationNumber: "test-triple-unmapped",
		reservationId: "test-triple-unmapped",
		roomName: sourceRoomName,
		roomCount: 1,
		checkinDate: "2026-08-10",
		checkoutDate: "2026-08-11",
		totalAmountSar: 100,
		totalGuests: 3,
	});
	assert.equal(review.pickedRoomsType[0].displayName, sourceRoomName);
	assert.equal(review.pickedRoomsType[0].room_type, "tripleRooms");
	const arabicSourceRoomName = "غرفة ثلاثية بسرير مزدوج وسرير فردي";
	const arabicReview = buildUnmappedOtaReviewReservationDocument({
		provider: "hotelrunner",
		providerLabel: "HotelRunner",
		confirmationNumber: "test-arabic-triple-unmapped",
		reservationId: "test-arabic-triple-unmapped",
		roomName: arabicSourceRoomName,
		roomCount: 1,
		checkinDate: "2026-08-10",
		checkoutDate: "2026-08-11",
		totalAmountSar: 100,
		totalGuests: 3,
	});
	assert.equal(
		arabicReview.pickedRoomsType[0].displayName,
		arabicSourceRoomName
	);
	assert.equal(arabicReview.pickedRoomsType[0].room_type, "tripleRooms");
	const bedOnlyReview = buildUnmappedOtaReviewReservationDocument({
		provider: "hotelrunner",
		providerLabel: "HotelRunner",
		confirmationNumber: "test-arabic-bed-layout-unmapped",
		reservationId: "test-arabic-bed-layout-unmapped",
		roomName: "غرفة بسرير فردي وسرير مزدوج",
		roomCount: 1,
		checkinDate: "2026-08-10",
		checkoutDate: "2026-08-11",
		totalAmountSar: 100,
	});
	assert.equal(bedOnlyReview.pickedRoomsType[0].room_type, "");
});

test("HotelRunner Trip.com relays preserve transport identity and persist the actual booking source", () => {
	const normalized = extractNormalizedReservation({
		from: '"HotelRunner" <noreply@hotelrunner.com>',
		to: "ota@example.com",
		subject: "Zad Ajyad - New Reservation #RTESTTRIP",
		text: [
			"TRIP.COM XY",
			"Source HotelRunner",
			"Confirmation Number 123456789",
			"Hotel Name Zad Ajyad",
			"Room Type Triple Room",
			"Check-in Date Aug 10, 2026",
			"Check-out Date Aug 11, 2026",
			"Guest Count 3",
			"This booking was made through Trip.com, a Ctrip Group brand",
			"Guest proxy: synthetic@guest.trip.com",
		].join("\n"),
	});

	assert.equal(normalized.provider, "hotelrunner");
	assert.equal(normalized.bookingSource, "Trip.com");
	assert.equal(normalized.sourcePresence.bookingSource, true);
	assert.equal(normalized.hotelRunnerTripRelayEvidence, true);
	assert.equal(normalized.hotelRunnerTripRelayIdentityValidated, true);
	assert.equal(
		buildOtaCrossTransportIdentityKey(normalized, normalized.confirmationNumber),
		"trip:123456789"
	);

	const document = buildUnmappedOtaReviewReservationDocument({
		...normalized,
		guestName: "Synthetic Guest",
		totalAmountSar: 100,
	});
	assert.equal(document.booking_source, "Trip.com");
	assert.equal(document.customer_details.booking_source, "Trip.com");
	assert.equal(document.supplierData.otaProvider, "hotelrunner");

	const payment = resolvePaymentMapping(
		{
			provider: "hotelrunner",
			providerLabel: "HotelRunner",
			bookingSource: "Trip.com",
			paymentCollectionModel: "ota_collect",
		},
		100,
		75,
		15
	);
	assert.equal(
		payment.paidAmountBreakdown.payment_comments,
		"Trip.com collected by platform"
	);
});

test("HotelRunner Trip.com relays select one full numeric OTA identity and reject conflicts", () => {
	const baseLines = [
		"TRIP.COM V2",
		"Source HotelRunner",
		"Hotel Name Zad Ajyad",
		"Room Type Comfort Double Room - Room Only-Prepay",
		"Check-in Date Aug 26, 2026",
		"Check-out Date Sep 1, 2026",
		"Guest Count 2",
		"Order Total USD 92.46",
		"This booking was made through Trip.com, a Ctrip Group brand",
	];
	const normalized = extractNormalizedReservation({
		from: '"HotelRunner" <noreply@hotelrunner.com>',
		subject: "Zad Ajyad - New Reservation",
		text: [
			"Confirmation Number HR12345",
			"Booking ID 1651516732730092",
			...baseLines,
		].join("\n"),
	});
	assert.equal(normalized.confirmationNumber, "1651516732730092");
	assert.equal(normalized.hotelRunnerTripRelayIdentityValidated, true);
	assert.equal(
		buildOtaCrossTransportIdentityKey(normalized),
		"trip:1651516732730092"
	);

	const conflicting = extractNormalizedReservation({
		from: '"HotelRunner" <noreply@hotelrunner.com>',
		subject: "Zad Ajyad - New Reservation",
		text: [
			"Confirmation Number 1651516732730092",
			"Booking ID 1167731616604825",
			...baseLines,
		].join("\n"),
	});
	assert.equal(conflicting.confirmationNumber, "");
	assert.equal(conflicting.requiresManualReview, true);
	assert.equal(conflicting.blocksUnmappedReservationCreation, true);
	assert.equal(conflicting.hotelRunnerTripRelayIdentityValidated, false);
	assert.equal(buildOtaCrossTransportIdentityKey(conflicting), "");
});

test("a 16-digit Trip.com confirmation remains an OTA identity and never becomes VCC evidence", () => {
	const otaConfirmation = "1651516732730092";
	const normalized = extractNormalizedReservation({
		from: '"HotelRunner" <noreply@hotelrunner.com>',
		to: "ota@example.com",
		subject: "Zad Ajyad - New Reservation #RTESTTRIP16",
		text: [
			"TRIP.COM V2",
			`Confirmation Number ${otaConfirmation}`,
			"Hotel Name Zad Ajyad",
			"Room Type Comfort Double Room - Room Only-Prepay",
			"Check-in Date Aug 26, 2026",
			"Check-out Date Sep 1, 2026",
			"Guest Count 2",
			"Order Total USD 92.46",
			"This booking was made through Trip.com, a Ctrip Group brand",
		].join("\n"),
	});

	assert.equal(normalized.provider, "hotelrunner");
	assert.equal(normalized.bookingSource, "Trip.com");
	assert.equal(normalized.confirmationNumber, otaConfirmation);
	assert.equal(normalized.reservationId, otaConfirmation);
	assert.equal(normalized.vcc.cardLast4, "");
	assert.equal(normalized.sourcePresence.vccCardLast4, false);
	assert.equal(normalized.paymentCollectionModel, "ota_collect");

	const replayedFromRedactedAudit = extractNormalizedReservation({
		from: '"HotelRunner" <noreply@hotelrunner.com>',
		subject: "Zad Ajyad - New Reservation #RTESTTRIP16",
		text: [
			"TRIP.COM V2",
			"Confirmation Number [CARD-0092]",
			"Hotel Name Zad Ajyad",
			"Room Type Comfort Double Room - Room Only-Prepay",
			"Check-in Date Aug 26, 2026",
			"Check-out Date Sep 1, 2026",
			"Guest Count 2",
			"Order Total USD 92.46",
			"This booking was made through Trip.com, a Ctrip Group brand",
		].join("\n"),
	});
	assert.equal(replayedFromRedactedAudit.vcc.cardLast4, "");
	assert.equal(replayedFromRedactedAudit.sourcePresence.vccCardLast4, false);
	assert.notEqual(replayedFromRedactedAudit.paymentCollectionModel, "virtual_card");
	assert.notEqual(replayedFromRedactedAudit.confirmationNumber, "card-0092");
});

test("privacy redaction preserves labeled OTA identities but still removes card PANs", () => {
	const redacted = redactSensitive(
		[
			"Confirmation Number 1651516732730092",
			"Booking no. # 1167731616604825 #",
			"Card number: 4111111111111111",
			"Unlabeled payment token 5555555555554444",
			"CVV: 123",
		].join("\n")
	);
	assert.match(redacted, /Confirmation Number 1651516732730092/);
	assert.match(redacted, /Booking no\. # 1167731616604825/);
	assert.doesNotMatch(redacted, /4111111111111111/);
	assert.doesNotMatch(redacted, /5555555555554444/);
	assert.match(redacted, /\[CARD-1111\]/);
	assert.match(redacted, /\[CARD-4444\]/);
	assert.match(redacted, /validation code: \[REDACTED\]/);
	assert.equal(isWeakOtaConfirmationValue("card-0674"), true);
	assert.equal(isWeakOtaConfirmationValue("[CARD-0674]"), true);
	assert.equal(isWeakOtaConfirmationValue("1651516732730092"), false);
});

test("direct Trip.com templates extract authoritative identity, stay, pricing, and prepaid facts", () => {
	const nightlySourceRows = [
		["Aug 26", "16.06", "15.17"],
		["Aug 27", "16.06", "15.17"],
		["Aug 28", "16.06", "15.17"],
		["Aug 29", "16.06", "15.17"],
		["Aug 30", "16.83", "15.89"],
		["Aug 31", "16.83", "15.89"],
	].flatMap(([date, client, payout]) => [
		`${date} (1 room(s))`,
		`Original room rate (incl. taxes and fees)20.00*1Discounts: Diamond member 10% off-2.00*1`,
		`Final room rate (incl. taxes and fees)${client}*1`,
		"VAT+0.00*1",
		"Additional fees: CoinPlus - point distribution-0.00*1",
		`Your payout${payout}*1`,
	]);
	const normalized = extractNormalizedReservation({
		from: 'Trip.com <ebooking@trip.com>',
		to: "ota@example.com",
		subject: "Booking no. # 1651516732730092 #",
		text: [
			"Booking no. # 1651516732730092 #",
			"Zad Ajyad Hotel",
			"Guest Name:",
			"Synthetic Guest",
			"Staying period: Aug 26, 2026 - Sep 1, 2026 | 6 nights",
			"Room Type: Comfort Double Room - Room Only | 1 room(s)",
			"Guests (estimated): 2 adults, 0 children",
			"Payment information",
			"Net rate｜Prepaid｜monthly settlement",
			"Room rate 1 room(s) × 6 night(s)This rate is for 2 adults",
			"Final room rate (incl. taxes and fees) USD 97.90",
			"Your payout USD 92.46",
			"This is a prepaid reservation. The guest has already paid for the room.",
			"Room ratePrice details",
			...nightlySourceRows,
			"Additional InformationTypeDetailsRewards",
		].join("\n"),
	});

	assert.equal(normalized.provider, "trip");
	assert.equal(normalized.bookingSource, "Trip.com");
	assert.equal(normalized.directTripTemplateMatched, true);
	assert.equal(normalized.confirmationNumber, "1651516732730092");
	assert.equal(normalized.hotelName, "Zad Ajyad Hotel");
	assert.equal(normalized.roomName, "Comfort Double Room - Room Only");
	assert.equal(normalized.checkinDate, "2026-08-26");
	assert.equal(normalized.checkoutDate, "2026-09-01");
	assert.equal(normalized.adults, 2);
	assert.equal(normalized.children, 0);
	assert.equal(normalized.totalGuests, 2);
	assert.equal(normalized.roomCount, 1);
	assert.equal(normalized.sourceAmount, 97.9);
	assert.equal(normalized.sourceCurrency, "USD");
	assert.equal(normalized.totalAmountSar, 367.13);
	assert.equal(normalized.totalPayoutSar, 346.72);
	assert.deepEqual(
		normalized.nightlyPricingSar.map((row) => row.clientAmountSar),
		[60.23, 60.23, 60.23, 60.22, 63.11, 63.11]
	);
	assert.deepEqual(
		normalized.nightlyPricingSar.map((row) => row.payoutAmountSar),
		[56.89, 56.89, 56.89, 56.89, 59.58, 59.58]
	);
	assert.equal(normalized.paymentCollectionModel, "ota_collect");
	assert.equal(normalized.vcc.cardLast4, "");
	assert.match(
		getDeterministicExtractionSkipReason(normalized),
		/every creation-critical field is source-backed/i
	);
	assert.equal(
		buildOtaCrossTransportIdentityKey(normalized, normalized.confirmationNumber),
		"trip:1651516732730092"
	);

	const built = buildReservationDocument(normalized, {
		_id: "hotel-zad",
		belongsTo: "owner-zad",
		roomCountDetails: [
			{
				_id: "double-room",
				roomType: "doubleRooms",
				displayName: "Comfort Double Room - Room Only",
				activeRoom: true,
				price: { basePrice: 75 },
			},
		],
	});
	assert.equal(built.ok, true);
	assert.deepEqual(
		built.document.pickedRoomsType[0].pricingByDay.map((row) => row.clientPrice),
		[60.23, 60.23, 60.23, 60.22, 63.11, 63.11]
	);
	assert.deepEqual(
		built.document.pickedRoomsType[0].pricingByDay.map(
			(row) => row.netAfterExpenses
		),
		[56.89, 56.89, 56.89, 56.89, 59.58, 59.58]
	);
	assert.equal(built.document.total_amount, 367.13);
	assert.equal(built.document.sub_total, 450);
	assert.equal(built.document.adminPricing.netAfterExpensesTotal, 346.72);
	assert.equal(built.document.adminPricing.otaExpenseTotal, 20.41);
	assert.equal(built.document.adminPricing.platformMarginTotal, -103.28);
	assert.equal(built.document.payment, "paid online");
	assert.equal(built.document.financeStatus, "paid online");
});

test("one-night direct Trip.com pricing keeps exact guest total, payout, and root price", () => {
	const normalized = extractNormalizedReservation({
		from: "Trip.com <ebooking@trip.com>",
		subject: "Booking no. # 1167731616604825 #",
		text: [
			"Booking no. # 1167731616604825 #",
			"Zad Ajyad Hotel",
			"Guest Name:",
			"Synthetic Guest",
			"Staying period: Aug 5, 2026 - Aug 6, 2026 | 1 night",
			"Room Type: Comfort Double Room - Room Only | 1 room(s)",
			"Guests (estimated): 2 adults, 0 children",
			"Payment information",
			"Net rate｜Prepaid｜monthly settlement",
			"Room rate 1 room(s) × 1 night(s)This rate is for 2 adults",
			"Original room rate (incl. taxes and fees)20.00Discounts: Gold diamond member 10% off-1.00",
			"Final room rate (incl. taxes and fees)USD16.06",
			"Your payoutUSD15.17",
			"Room ratePrice details",
			"Aug 5 (1 room(s))",
			"Original room rate (incl. taxes and fees)20.00*1Discounts: Gold diamond member",
			"10% off-1.00*1",
			"Final room rate (incl. taxes and fees)16.06*1",
			"VAT+0.00*1",
			"Additional fees: CoinPlus - point distribution-0.00*1",
			"Your payout15.17*1",
			"Additional InformationTypeDetailsRewards",
			"This is a prepaid reservation. The guest has already paid for the room.",
		].join("\n"),
	});

	assert.equal(normalized.confirmationNumber, "1167731616604825");
	assert.equal(normalized.totalAmountSar, 60.22);
	assert.equal(normalized.totalPayoutSar, 56.89);
	assert.deepEqual(normalized.nightlyPricingSar, [
		{ date: "2026-08-05", clientAmountSar: 60.22, payoutAmountSar: 56.89 },
	]);
	const built = buildReservationDocument(normalized, {
		_id: "hotel-zad",
		belongsTo: "owner-zad",
		roomCountDetails: [
			{
				_id: "double-room",
				roomType: "doubleRooms",
				displayName: "Comfort Double Room - Room Only",
				activeRoom: true,
				price: { basePrice: 75 },
			},
		],
	});
	assert.equal(built.ok, true);
	assert.equal(built.document.total_amount, 60.22);
	assert.equal(built.document.sub_total, 75);
	assert.equal(built.document.adminPricing.netAfterExpensesTotal, 56.89);
	assert.equal(built.document.adminPricing.otaExpenseTotal, 3.33);
	assert.equal(built.document.adminPricing.platformMarginTotal, -18.11);
});

test("conflicting explicit Trip.com identities fail closed without selecting either booking", () => {
	const normalized = extractNormalizedReservation({
		from: "Trip.com <ebooking@trip.com>",
		subject: "Booking no. # 1111111111111111 #",
		text: [
			"Booking no. # 2222222222222222 #",
			"Zad Ajyad Hotel",
			"Guest Name:",
			"Synthetic Guest",
			"Staying period: Aug 5, 2026 - Aug 6, 2026 | 1 night",
			"Room Type: Comfort Double Room - Room Only | 1 room(s)",
			"Guests (estimated): 2 adults, 0 children",
			"Payment information",
			"Net rate | Prepaid | monthly settlement",
			"Final room rate (incl. taxes and fees) USD 16.06",
			"Your payout USD 15.17",
		].join("\n"),
	});

	assert.equal(normalized.directTripTemplateMatched, true);
	assert.equal(normalized.confirmationNumber, "");
	assert.equal(normalized.reservationId, "");
	assert.equal(normalized.sourcePresence.confirmationNumber, false);
	assert.equal(normalized.requiresManualReview, true);
	assert.match(normalized.manualReviewReasons.join(" "), /conflicting explicit/i);
	assert.ok(
		requiredNewReservationMissing(normalized).includes(
			"source-backed confirmation number"
		)
	);
	assert.equal(buildOtaCrossTransportIdentityKey(normalized), "");
	assert.equal(getDeterministicExtractionSkipReason(normalized), "");
});

test("conflicting Trip.com guest and payout currencies disable automatic pricing", () => {
	const normalized = extractNormalizedReservation({
		from: "Trip.com <ebooking@trip.com>",
		subject: "Booking no. # 1167731616604825 #",
		text: [
			"Booking no. # 1167731616604825 #",
			"Zad Ajyad Hotel",
			"Guest Name:",
			"Synthetic Guest",
			"Staying period: Aug 5, 2026 - Aug 6, 2026 | 1 night",
			"Room Type: Comfort Double Room - Room Only | 1 room(s)",
			"Guests (estimated): 2 adults, 0 children",
			"Payment information",
			"Net rate | Prepaid | monthly settlement",
			"Final room rate (incl. taxes and fees) EUR 16.06",
			"Your payout USD 15.17",
			"Room ratePrice details",
		].join("\n"),
	});

	assert.equal(normalized.confirmationNumber, "1167731616604825");
	assert.equal(normalized.requiresManualReview, true);
	assert.match(normalized.manualReviewReasons.join(" "), /currencies conflict/i);
	assert.equal(normalized.amount, 0);
	assert.equal(normalized.totalAmountSar, 0);
	assert.equal(normalized.totalPayoutSar, 0);
	assert.equal(normalized.sourcePresence.amount, false);
	assert.equal(canCreateUnmappedOtaReviewReservation(normalized, true), false);
	assert.equal(getDeterministicExtractionSkipReason(normalized), "");
});

test("conflicting Trip.com room counts cannot create or mutate a reservation", () => {
	const normalized = extractNormalizedReservation({
		from: "Trip.com <ebooking@trip.com>",
		subject: "Booking no. # 1167731616604825 #",
		text: [
			"Booking no. # 1167731616604825 #",
			"Zad Ajyad Hotel",
			"Guest Name:",
			"Synthetic Guest",
			"Staying period: Aug 5, 2026 - Aug 6, 2026 | 1 night",
			"Room Type: Comfort Double Room - Room Only | 1 room(s)",
			"Guests (estimated): 2 adults, 0 children",
			"Payment information",
			"Net rate | Prepaid | monthly settlement",
			"Room rate 2 room(s) x 1 night(s)",
			"Final room rate (incl. taxes and fees) USD 16.06",
			"Your payout USD 15.17",
			"Room ratePrice details",
		].join("\n"),
	});

	assert.equal(normalized.requiresManualReview, true);
	assert.match(normalized.manualReviewReasons.join(" "), /conflicting room counts/i);
	assert.equal(normalized.blocksUnmappedReservationCreation, true);
	assert.equal(canCreateUnmappedOtaReviewReservation(normalized, true), false);
	assert.equal(getDeterministicExtractionSkipReason(normalized), "");
});

test("Trip.com declared nights must reconcile with the stay date range", () => {
	const normalized = extractNormalizedReservation({
		from: "Trip.com <ebooking@trip.com>",
		subject: "Booking no. # 1167731616604825 #",
		text: [
			"Booking no. # 1167731616604825 #",
			"Zad Ajyad Hotel",
			"Guest Name:",
			"Synthetic Guest",
			"Staying period: Aug 5, 2026 - Aug 6, 2026 | 6 nights",
			"Room Type: Comfort Double Room - Room Only | 1 room(s)",
			"Guests (estimated): 2 adults, 0 children",
			"Payment information",
			"Net rate | Prepaid | monthly settlement",
			"Room rate 1 room(s) x 6 night(s)",
			"Final room rate (incl. taxes and fees) USD 16.06",
			"Your payout USD 15.17",
			"Room ratePrice details",
		].join("\n"),
	});

	assert.equal(normalized.requiresManualReview, true);
	assert.match(normalized.manualReviewReasons.join(" "), /night counts/i);
	assert.equal(normalized.blocksUnmappedReservationCreation, true);
	assert.equal(canCreateUnmappedOtaReviewReservation(normalized, true), false);
	assert.equal(getDeterministicExtractionSkipReason(normalized), "");
});

test("Trip cross-transport identity is unavailable without strong deterministic evidence", () => {
	for (const normalized of [
		{
			provider: "hotelrunner",
			bookingSource: "Trip.com",
			confirmationNumber: "1651516732730092",
			sourcePresence: { confirmationNumber: true, bookingSource: true },
			source: { from: "HotelRunner <noreply@hotelrunner.com>" },
		},
		{
			provider: "trip",
			bookingSource: "Trip.com",
			confirmationNumber: "1651516732730092",
			sourcePresence: { confirmationNumber: true, bookingSource: true },
			source: { from: "Trip.com <ebooking@trip.com>" },
			directTripTemplateMatched: false,
		},
		{
			provider: "hotelrunner",
			bookingSource: "Trip.com",
			confirmationNumber: "1651516732730092",
			sourcePresence: { confirmationNumber: false, bookingSource: true },
			source: { from: "HotelRunner <noreply@hotelrunner.com>" },
			hotelRunnerTripRelayEvidence: true,
		},
	]) {
		assert.equal(buildOtaCrossTransportIdentityKey(normalized), "");
	}
});

test("source-backed direct Trip.com lifecycle emails use the verified bridge", () => {
	const normalized = extractNormalizedReservation({
		from: "Trip.com <ebooking@trip.com>",
		subject: "Booking no. # 1167731616604825 # - Cancellation",
		text: [
			"Booking no. # 1167731616604825 #",
			"The reservation has been cancelled.",
		].join("\n"),
	});

	assert.equal(normalized.provider, "trip");
	assert.equal(normalized.confirmationNumber, "1167731616604825");
	assert.equal(normalized.eventType, "cancelled");
	assert.equal(normalized.intent, "reservation_status");
	assert.equal(normalized.directTripTemplateMatched, false);
	assert.equal(normalized.directTripLifecycleTemplateMatched, true);
	assert.equal(
		buildOtaCrossTransportIdentityKey(normalized),
		"trip:1167731616604825"
	);
});

test("deterministic extraction AI remains available when critical facts are incomplete", () => {
	assert.equal(
		getDeterministicExtractionSkipReason({
			provider: "trip",
			intent: "new_reservation",
			confirmationNumber: "1651516732730092",
			sourcePresence: { confirmationNumber: true },
			source: { from: "Trip.com <ebooking@trip.com>" },
		}),
		""
	);
});

test("legacy redacted Trip collision checks require exact suffix, hotel, and stay", () => {
	const normalized = {
		provider: "trip",
		bookingSource: "Trip.com",
		confirmationNumber: "1167731616600674",
		checkinDate: "2026-08-03",
		checkoutDate: "2026-08-04",
		directTripTemplateMatched: true,
		sourcePresence: { confirmationNumber: true, bookingSource: true },
		source: { from: "Trip.com <ebooking@trip.com>" },
	};
	assert.deepEqual(
		buildLegacyRedactedTripConflictLookup(normalized, "hotel-zad"),
		{
			otaIdentityKey: "hotelrunner:card-0674",
			hotelId: "hotel-zad",
			checkin_date: "2026-08-03",
			checkout_date: "2026-08-04",
		}
	);
	assert.equal(
		buildLegacyRedactedTripConflictLookup(
			{ ...normalized, directTripTemplateMatched: false },
			"hotel-zad"
		),
		null
	);
});

test("explicit VCC context can use a separate unlabeled card number without reusing the OTA confirmation", () => {
	const otaConfirmation = "1651516732730092";
	const normalized = extractNormalizedReservation({
		from: '"HotelRunner" <noreply@hotelrunner.com>',
		to: "ota@example.com",
		subject: "Zad Ajyad - New Reservation #RTESTTRIPVCC",
		text: [
			"TRIP.COM V2",
			`Confirmation Number ${otaConfirmation}`,
			"Virtual Card",
			"4111111111111111",
			"Hotel Name Zad Ajyad",
			"Room Type Comfort Double Room",
			"Check-in Date Aug 26, 2026",
			"Check-out Date Sep 1, 2026",
			"Guest Count 2",
			"Order Total USD 92.46",
			"This booking was made through Trip.com, a Ctrip Group brand",
		].join("\n"),
	});

	assert.equal(normalized.confirmationNumber, otaConfirmation);
	assert.equal(normalized.vcc.cardLast4, "1111");
	assert.equal(normalized.paymentCollectionModel, "virtual_card");
});

test("VCC wording cannot turn tracking-URL numbers into card metadata", () => {
	const normalized = extractNormalizedReservation({
		from: "no-reply@agoda.com",
		subject: "Agoda Booking ID 682028095 - CONFIRMED",
		text: [
			"Booking ID 682028095",
			"Virtual Card payment",
			"https://tracking.example/click?token=5555555555554444&utm_source=agoda",
			"Hotel Name Zad Ajyad",
			"Room Type Double Room",
			"Check-in Date Aug 10, 2026",
			"Check-out Date Aug 11, 2026",
			"Guest Count 2",
		].join("\n"),
	});
	assert.equal(normalized.paymentCollectionModel, "virtual_card");
	assert.equal(normalized.vcc.cardLast4, "");
	assert.equal(normalized.sourcePresence.vccCardLast4, false);

	const localRedactedCard = extractNormalizedReservation({
		from: "no-reply@agoda.com",
		subject: "Agoda Booking ID 682028096 - CONFIRMED",
		text: [
			"Booking ID 682028096",
			"Virtual Card number [CARD-1111]",
			"Hotel Name Zad Ajyad",
			"Room Type Double Room",
			"Check-in Date Aug 10, 2026",
			"Check-out Date Aug 11, 2026",
			"Guest Count 2",
		].join("\n"),
	});
	assert.equal(localRedactedCard.vcc.cardLast4, "1111");
});

test("unstructured Trip.com mentions do not override a HotelRunner booking source", () => {
	const normalized = extractNormalizedReservation({
		from: '"HotelRunner" <noreply@hotelrunner.com>',
		subject: "Reservation message",
		text: "Guest note: please compare the public Trip.com price before replying.",
	});
	assert.equal(normalized.provider, "hotelrunner");
	assert.equal(normalized.bookingSource, "HotelRunner");
});

test("booking-source conflicts fail closed while direct OTA senders remain authoritative", () => {
	assert.equal(
		resolveBookingSource({
			provider: "hotelrunner",
			providerLabel: "HotelRunner",
			from: "HotelRunner <noreply@hotelrunner.com>",
			explicitSource: "HotelRunner",
			text: [
				"TRIP.COM V2",
				"This booking was made through Trip.com, a Ctrip Group brand",
			].join("\n"),
		}),
		"Trip.com"
	);
	assert.equal(
		resolveBookingSource({
			provider: "hotelrunner",
			providerLabel: "HotelRunner",
			from: "HotelRunner <noreply@hotelrunner.com>",
			explicitSource: "HotelRunner",
			text: "TRIP.COM XY\nAGODA",
		}),
		"HotelRunner"
	);
	assert.equal(
		resolveBookingSource({
			provider: "trip",
			providerLabel: "Trip.com",
			from: "Trip.com <reservations@trip.com>",
			text: "Footer partner: Agoda",
		}),
		"Trip.com"
	);
});

test("HotelRunner commercial source requires zero-or-one-provider consensus", async () => {
	const baseEmail = {
		from: '"HotelRunner" <noreply@hotelrunner.com>',
		subject: "New Reservation notification",
		receivedAt: "2026-08-04T11:00:00.000Z",
		senderAuthentication: {
			authenticatedAligned: true,
			trustedProvider: "hotelrunner",
		},
	};
	const commonReservationLines = [
		"Confirmation Number 44556677",
		"Hotel Name Example Hotel",
		"Room Type Double Room",
		"Check-in Date Aug 10, 2026",
		"Check-out Date Aug 11, 2026",
		"Guest Name Example Guest",
		"Order Total SAR 100",
	];

	const transportOnly = extractNormalizedReservation({
		...baseEmail,
		text: commonReservationLines.join("\n"),
	});
	assert.equal(transportOnly.bookingSource, "HotelRunner");
	assert.equal(transportOnly.hotelRunnerBookingSourceConflict, false);
	assert.deepEqual(transportOnly.hotelRunnerCommercialSourceProviders, []);

	const oneCommercialSource = extractNormalizedReservation({
		...baseEmail,
		text: ["EXPEDIA", ...commonReservationLines].join("\n"),
	});
	assert.equal(oneCommercialSource.bookingSource, "Expedia");
	assert.equal(oneCommercialSource.hotelRunnerBookingSourceConflict, false);
	assert.deepEqual(
		oneCommercialSource.hotelRunnerCommercialSourceProviders,
		["expedia"]
	);

	for (const conflictText of [
		["EXPEDIA", "AGODA", ...commonReservationLines],
		["Source: Expedia", "AGODA", ...commonReservationLines],
	]) {
		const conflicting = extractNormalizedReservation({
			...baseEmail,
			text: conflictText.join("\n"),
		});
		assert.equal(conflicting.bookingSource, "HotelRunner");
		assert.equal(conflicting.hotelRunnerBookingSourceConflict, true);
		assert.equal(conflicting.requiresManualReview, true);
		assert.equal(conflicting.blocksUnmappedReservationCreation, true);
		assert.equal(conflicting.sourcePresence.bookingSource, false);
		assert.match(
			conflicting.manualReviewReasons.join(" "),
			/conflicting commercial booking-source evidence/i
		);
	}

	const originalReservationFind = Reservations.find;
	Reservations.find = () => {
		throw new Error("reservation lookup must not run for source conflict");
	};
	try {
		const conflicting = extractNormalizedReservation({
			...baseEmail,
			text: ["EXPEDIA", "AGODA", ...commonReservationLines].join("\n"),
		});
		const result = await reconcileOtaReservation(conflicting);
		assert.equal(result.status, "needs_review");
		assert.equal(result.actionTaken, "skipped");
		assert.equal(result.skipReason, "ota_parser_requires_manual_review");
	} finally {
		Reservations.find = originalReservationFind;
	}
});

test("an authenticated direct OTA sender remains authoritative over footer noise", () => {
	const normalized = extractNormalizedReservation({
		from: "Booking.com <noreply@booking.com>",
		subject: "Reservation 44556678 confirmed",
		text: [
			"Reservation ID: 44556678",
			"Booking.com",
			"AGODA",
			"Footer supplied by a distribution partner",
		].join("\n"),
		senderAuthentication: {
			authenticatedAligned: true,
			trustedProvider: "booking",
		},
	});

	assert.equal(normalized.provider, "booking");
	assert.equal(normalized.bookingSource, "Booking.com");
	assert.equal(normalized.hotelRunnerBookingSourceConflict, false);
});

test("an unambiguous direct OTA sender outranks unrelated body/footer mentions", () => {
	assert.equal(
		detectProvider({
			from: "Trip.com <ebooking@trip.com>",
			text: "HotelRunner relay footer",
		}),
		"trip"
	);
	assert.equal(
		detectProvider({
			from: "Agoda <noreply@agoda.com>",
			text: "Expedia comparison footer",
		}),
		"agoda"
	);
});

test("spoofed OTA display names cannot mutate reservation lifecycle state", async () => {
	for (const [index, from] of [
		"Booking.com <attacker@example.com>",
		"booking@booking.com <attacker@example.com>",
		'"booking@booking.com" <attacker@example.com>',
	].entries()) {
		const normalized = extractNormalizedReservation({
			from,
			subject: "Booking cancellation",
			messageId: `spoofed-booking-lifecycle-${index}`,
			text: [
				"Booking.com",
				"Reservation ID: 12345678",
				"The reservation has been cancelled.",
			].join("\n"),
		});

		assert.equal(normalized.provider, "booking");
		assert.equal(normalized.sourceSenderTrusted, false);
		const result = await reconcileOtaReservation(normalized);
		assert.equal(result.status, "needs_review");
		assert.equal(result.actionTaken, "skipped");
		assert.equal(result.skipReason, "untrusted_ota_sender_no_mutation");
	}
});

test("sender trust uses only one syntactically valid actual mailbox", () => {
	assert.equal(
		trustedProviderFromSenderAddress("Booking.com <noreply@booking.com>"),
		"booking"
	);
	assert.equal(
		trustedProviderFromSenderAddress("noreply@subdomain.booking.com"),
		"booking"
	);
	assert.equal(
		trustedProviderFromSenderAddress(
			"booking@booking.com <attacker@example.com>"
		),
		""
	);
	assert.equal(
		trustedProviderFromSenderAddress(
			'"booking@booking.com" <attacker@example.com>'
		),
		""
	);
	assert.equal(
		trustedProviderFromSenderAddress(
			"Booking <one@booking.com> <two@booking.com>"
		),
		""
	);
	assert.equal(
		trustedProviderFromSenderAddress(
			"Booking <noreply@booking.com>, attacker@example.com"
		),
		""
	);
});

test("generic lifecycle confirmation parsing never truncates a punctuation-variant ID", () => {
	const normalized = extractNormalizedReservation({
		from: "Booking.com <noreply@booking.com>",
		subject: "Reservation 12345678 cancelled",
		text: "This reservation has been cancelled.",
	});

	assert.equal(normalized.confirmationNumber, "12345678");
	assert.equal(normalized.reservationId, "12345678");
	assert.equal(normalized.eventType, "cancelled");
});

test("a junk lifecycle subject cannot hide a later valid booking identity", () => {
	const normalized = extractNormalizedReservation({
		from: "Booking.com <noreply@booking.com>",
		subject: "Reservation cancelled",
		text: [
			"Booking ID: 87654321",
			"This reservation has been cancelled.",
		].join("\n"),
	});

	assert.equal(normalized.confirmationNumber, "87654321");
	assert.equal(normalized.reservationId, "87654321");
	assert.equal(normalized.eventType, "cancelled");
});

test("generic lifecycle events reject conflicting primary IDs and accept exact repeats", () => {
	for (const lifecycle of [
		{
			subject: "Reservation cancelled",
			body: "The reservation has been cancelled.",
			eventType: "cancelled",
			intent: "reservation_status",
		},
		{
			subject: "Reservation modified",
			body: "The reservation has been modified.",
			eventType: "modified",
			intent: "reservation_update",
		},
	]) {
		const conflicting = extractNormalizedReservation({
			from: "Booking.com <noreply@booking.com>",
			subject: lifecycle.subject,
			text: [
				"Reservation ID: 12345678",
				"Booking ID: 87654321",
				lifecycle.body,
			].join("\n"),
		});
		assert.equal(conflicting.eventType, lifecycle.eventType);
		assert.equal(conflicting.intent, lifecycle.intent);
		assert.equal(conflicting.confirmationNumber, "");
		assert.equal(conflicting.reservationId, "");
		assert.equal(conflicting.sourcePresence.confirmationNumber, false);
		assert.equal(conflicting.requiresManualReview, true);
		assert.equal(conflicting.blocksUnmappedReservationCreation, true);
		assert.match(conflicting.manualReviewReasons.join(" "), /conflicting explicit/i);

		const repeated = extractNormalizedReservation({
			from: "Booking.com <noreply@booking.com>",
			subject: lifecycle.subject,
			text: [
				"Reservation ID: 12345678",
				"Booking ID: 12345678",
				lifecycle.body,
			].join("\n"),
		});
		assert.equal(repeated.eventType, lifecycle.eventType);
		assert.equal(repeated.intent, lifecycle.intent);
		assert.equal(repeated.confirmationNumber, "12345678");
		assert.equal(repeated.reservationId, "12345678");
		assert.equal(repeated.sourcePresence.confirmationNumber, true);
		assert.equal(repeated.requiresManualReview, false);
		assert.equal(repeated.blocksUnmappedReservationCreation, false);
	}
});

test("lifecycle consistency helpers fail closed only for their exact scope", () => {
	assert.equal(
		resolvedIncomingHotelConflictsWithExisting(
			{ hotelId: "hotel-a" },
			{ _id: "hotel-b" }
		),
		true
	);
	assert.equal(
		resolvedIncomingHotelConflictsWithExisting(
			{ hotelId: "hotel-a" },
			{ _id: "hotel-a" }
		),
		false
	);

	const existingStay = {
		checkin_date: "2026-08-10",
		checkout_date: "2026-08-12",
	};
	const sourceBackedStay = {
		checkinDate: "2026-08-10",
		checkoutDate: "2026-08-13",
		sourcePresence: { checkinDate: true, checkoutDate: true },
	};
	assert.equal(
		terminalLifecycleStayDatesConflict(
			sourceBackedStay,
			existingStay,
			"cancelled"
		),
		true
	);
	assert.equal(
		terminalLifecycleStayDatesConflict(
			sourceBackedStay,
			existingStay,
			"no_show"
		),
		true
	);
	assert.equal(
		terminalLifecycleStayDatesConflict(
			sourceBackedStay,
			existingStay,
			"modified"
		),
		false,
		"ordinary modifications may legitimately change stay dates"
	);
	assert.equal(
		terminalLifecycleStayDatesConflict(
			{
				...sourceBackedStay,
				checkoutDate: "2026-08-12",
			},
			existingStay,
			"cancelled"
		),
		false
	);

	for (const terminalStatus of ["cancelled", "no_show", "checked_out"]) {
		for (const incomingStatus of [
			"confirmed",
			"inhouse",
			"cancelled",
			"no_show",
			"checked_out",
		].filter((status) => status !== terminalStatus)) {
			assert.equal(
				wouldReopenTerminalOtaReservation(
					{ state: terminalStatus },
					incomingStatus
				),
				true,
				`${terminalStatus} -> ${incomingStatus}`
			);
		}
		assert.equal(
			wouldReopenTerminalOtaReservation(
				{ state: terminalStatus, reservation_status: terminalStatus },
				terminalStatus
			),
			false,
			`${terminalStatus} -> same terminal status`
		);
	}
	assert.equal(
		wouldReopenTerminalOtaReservation(
			{ state: "confirmed" },
			"checked_out"
		),
		false
	);
});

test("source-backed hotel conflicts block cancellation and update mutations", async () => {
	const originalReservationFind = Reservations.find;
	const originalReservationUpdateOne = Reservations.updateOne;
	const originalHotelFind = HotelDetails.find;
	let mutationCalls = 0;
	const existing = {
		_id: "existing-reservation",
		hotelId: "hotel-a",
		confirmation_number: "9000000001",
		otaIdentityKey: "booking:12345678",
		reservation_id: "12345678",
		customer_details: { confirmation_number2: "12345678" },
		supplierData: {
			otaProvider: "booking",
			suppliedBookingNo: "12345678",
			otaConfirmationNumber: "12345678",
			platformConfirmationNumber: "12345678",
			otaLastSourceReceivedAt: "2026-08-04T10:00:00.000Z",
		},
		otaPlatformReview: {
			provider: "booking",
			confirmationNumber: "12345678",
		},
		state: "confirmed",
		reservation_status: "confirmed",
	};
	Reservations.find = () => ({
		limit() {
			return this;
		},
		async exec() {
			return [existing];
		},
	});
	Reservations.updateOne = async () => {
		mutationCalls += 1;
		throw new Error("unexpected reservation mutation");
	};
	HotelDetails.find = () => ({
		select() {
			return this;
		},
		async lean() {
			return [
				{ _id: "hotel-a", hotelName: "Existing Hotel" },
				{ _id: "hotel-b", hotelName: "Incoming Hotel" },
			];
		},
	});

	try {
		for (const lifecycle of [
			{
				intent: "reservation_status",
				eventType: "cancelled",
				statusToApply: "cancelled",
			},
			{
				intent: "reservation_update",
				eventType: "modified",
				statusToApply: "",
			},
		]) {
			const result = await reconcileOtaReservation({
				provider: "booking",
				providerLabel: "Booking.com",
				confirmationNumber: "12345678",
				hotelName: "Incoming Hotel",
				sourcePresence: { confirmationNumber: true, hotelName: true },
				source: {
					from: "expedia-sync",
					receivedAt: "2026-08-04T11:00:00.000Z",
				},
				...lifecycle,
			});
			assert.equal(result.status, "needs_review");
			assert.equal(result.actionTaken, "skipped");
			assert.equal(
				result.skipReason,
				"ota_incoming_hotel_conflicts_with_existing_reservation"
			);
		}
	} finally {
		Reservations.find = originalReservationFind;
		Reservations.updateOne = originalReservationUpdateOne;
		HotelDetails.find = originalHotelFind;
	}
	assert.equal(mutationCalls, 0);
});

test("terminal lifecycle date conflicts and reopen attempts perform no mutation", async () => {
	const originalReservationFind = Reservations.find;
	const originalReservationUpdateOne = Reservations.updateOne;
	let mutationCalls = 0;
	let existing = {
		_id: "existing-reservation",
		hotelId: "hotel-a",
		confirmation_number: "9000000001",
		otaIdentityKey: "booking:12345678",
		reservation_id: "12345678",
		customer_details: { confirmation_number2: "12345678" },
		supplierData: {
			otaProvider: "booking",
			suppliedBookingNo: "12345678",
			otaConfirmationNumber: "12345678",
			platformConfirmationNumber: "12345678",
			otaLastSourceReceivedAt: "2026-08-04T10:00:00.000Z",
		},
		otaPlatformReview: {
			provider: "booking",
			confirmationNumber: "12345678",
		},
		state: "confirmed",
		reservation_status: "confirmed",
		checkin_date: "2026-08-10",
		checkout_date: "2026-08-12",
	};
	Reservations.find = () => ({
		limit() {
			return this;
		},
		async exec() {
			return [existing];
		},
	});
	Reservations.updateOne = async () => {
		mutationCalls += 1;
		throw new Error("unexpected reservation mutation");
	};

	try {
		for (const statusToApply of ["cancelled", "no_show"]) {
			const result = await reconcileOtaReservation({
				provider: "booking",
				providerLabel: "Booking.com",
				confirmationNumber: "12345678",
				intent: "reservation_status",
				eventType: statusToApply,
				statusToApply,
				checkinDate: "2026-08-11",
				checkoutDate: "2026-08-12",
				sourcePresence: {
					confirmationNumber: true,
					checkinDate: true,
					checkoutDate: true,
				},
				source: {
					from: "expedia-sync",
					receivedAt: "2026-08-04T11:00:00.000Z",
				},
			});
			assert.equal(result.status, "needs_review");
			assert.equal(result.actionTaken, "skipped");
			assert.equal(
				result.skipReason,
				"terminal_ota_lifecycle_stay_dates_conflict"
			);
		}

		existing = {
			...existing,
			state: "cancelled",
			reservation_status: "cancelled",
		};
		const reopen = await reconcileOtaReservation({
			provider: "booking",
			providerLabel: "Booking.com",
			confirmationNumber: "12345678",
			intent: "reservation_status",
			eventType: "status",
			statusToApply: "confirmed",
			sourcePresence: { confirmationNumber: true },
			source: {
				from: "expedia-sync",
				receivedAt: "2026-08-04T11:00:00.000Z",
			},
		});
		assert.equal(reopen.status, "needs_review");
		assert.equal(reopen.actionTaken, "skipped");
		assert.equal(
			reopen.skipReason,
			"terminal_ota_reservation_transition_blocked"
		);
	} finally {
		Reservations.find = originalReservationFind;
		Reservations.updateOne = originalReservationUpdateOne;
	}
	assert.equal(mutationCalls, 0);
});

test("all existing OTA lifecycle mutations require a fresh trusted ordering timestamp", async () => {
	const originalReservationFind = Reservations.find;
	const originalReservationUpdateOne = Reservations.updateOne;
	let mutationCalls = 0;
	let existing = {
		_id: "existing-ordering-reservation",
		hotelId: "hotel-a",
		confirmation_number: "9000000002",
		otaIdentityKey: "booking:87654321",
		reservation_id: "87654321",
		customer_details: { confirmation_number2: "87654321" },
		supplierData: {
			otaProvider: "booking",
			suppliedBookingNo: "87654321",
			otaConfirmationNumber: "87654321",
			platformConfirmationNumber: "87654321",
			otaLastSourceReceivedAt: "2026-08-04T11:00:00.000Z",
		},
		otaPlatformReview: {
			provider: "booking",
			confirmationNumber: "87654321",
		},
		state: "confirmed",
		reservation_status: "confirmed",
	};
	Reservations.find = () => ({
		limit() {
			return this;
		},
		async exec() {
			return [existing];
		},
	});
	Reservations.updateOne = async () => {
		mutationCalls += 1;
		throw new Error("unexpected reservation mutation");
	};

	try {
		for (const lifecycle of [
			{ intent: "reservation_update", eventType: "modified" },
			{
				intent: "reservation_status",
				eventType: "cancelled",
				statusToApply: "cancelled",
			},
		]) {
			for (const [receivedAt, timestampMethod, expectedReason] of [
				["2026-08-04T10:00:00.000Z", "", "stale_ota_lifecycle_event"],
				["2026-08-04T11:00:00.000Z", "", "stale_ota_lifecycle_event"],
				[null, "", "ota_lifecycle_timestamp_missing"],
				[
					"2026-08-04T12:00:00.000Z",
					"sendgrid_webhook_received_at",
					"ota_lifecycle_timestamp_missing",
				],
			]) {
				const source = { from: "expedia-sync" };
				if (receivedAt) source.receivedAt = receivedAt;
				if (timestampMethod) source.timestampMethod = timestampMethod;
				const result = await reconcileOtaReservation({
					provider: "booking",
					providerLabel: "Booking.com",
					confirmationNumber: "87654321",
					sourcePresence: { confirmationNumber: true },
					source,
					...lifecycle,
				});
				assert.equal(result.status, "needs_review");
				assert.equal(result.actionTaken, "skipped");
				assert.equal(result.skipReason, expectedReason);
			}
		}

		existing = {
			...existing,
			supplierData: {
				...existing.supplierData,
				otaLastSourceReceivedAt: undefined,
			},
			updatedAt: new Date("2026-08-04T11:00:00.000Z"),
			createdAt: new Date("2026-08-01T00:00:00.000Z"),
		};
		const legacyResult = await reconcileOtaReservation({
			provider: "booking",
			providerLabel: "Booking.com",
			confirmationNumber: "87654321",
			intent: "reservation_update",
			eventType: "modified",
			sourcePresence: { confirmationNumber: true },
			source: {
				from: "expedia-sync",
				receivedAt: "2026-08-04T10:00:00.000Z",
			},
		});
		assert.equal(legacyResult.skipReason, "stale_ota_lifecycle_event");
	} finally {
		Reservations.find = originalReservationFind;
		Reservations.updateOne = originalReservationUpdateOne;
	}
	assert.equal(mutationCalls, 0);
});

test("terminal and in-house lifecycle policy blocks regressions without mutation", async () => {
	const originalReservationFind = Reservations.find;
	const originalReservationUpdateOne = Reservations.updateOne;
	let mutationCalls = 0;
	let existing;
	const makeExisting = (status) => ({
		_id: `existing-${status}`,
		hotelId: "hotel-a",
		confirmation_number: "9000000003",
		otaIdentityKey: "booking:11223344",
		reservation_id: "11223344",
		customer_details: { confirmation_number2: "11223344" },
		supplierData: {
			otaProvider: "booking",
			suppliedBookingNo: "11223344",
			otaConfirmationNumber: "11223344",
			platformConfirmationNumber: "11223344",
			otaLastSourceReceivedAt: "2026-08-04T10:00:00.000Z",
		},
		otaPlatformReview: {
			provider: "booking",
			confirmationNumber: "11223344",
		},
		state: status,
		reservation_status: status,
	});
	Reservations.find = () => ({
		limit() {
			return this;
		},
		async exec() {
			return [existing];
		},
	});
	Reservations.updateOne = async () => {
		mutationCalls += 1;
		return { matchedCount: 1 };
	};
	const reconcile = (input) =>
		reconcileOtaReservation({
			provider: "booking",
			providerLabel: "Booking.com",
			confirmationNumber: "11223344",
			sourcePresence: { confirmationNumber: true },
			source: {
				from: "expedia-sync",
				receivedAt: "2026-08-04T11:00:00.000Z",
			},
			...input,
		});

	try {
		for (const terminalStatus of ["cancelled", "no_show", "checked_out"]) {
			existing = makeExisting(terminalStatus);
			const modification = await reconcile({
				intent: "reservation_update",
				eventType: "modified",
			});
			assert.equal(
				modification.skipReason,
				"terminal_ota_reservation_update_blocked",
				terminalStatus
			);
		}

		for (const [terminalStatus, incomingStatus] of [
			["cancelled", "no_show"],
			["no_show", "checked_out"],
			["checked_out", "cancelled"],
		]) {
			existing = makeExisting(terminalStatus);
			const transition = await reconcile({
				intent: "reservation_status",
				eventType: "status",
				statusToApply: incomingStatus,
			});
			assert.equal(
				transition.skipReason,
				"terminal_ota_reservation_transition_blocked"
			);
		}

		existing = makeExisting("inhouse");
		const modification = await reconcile({
			intent: "reservation_update",
			eventType: "modified",
		});
		assert.equal(
			modification.skipReason,
			"inhouse_ota_reservation_update_blocked"
		);
		for (const incomingStatus of ["confirmed", "cancelled", "no_show"]) {
			const transition = await reconcile({
				intent: "reservation_status",
				eventType: "status",
				statusToApply: incomingStatus,
			});
			assert.equal(
				transition.skipReason,
				"inhouse_ota_status_regression_blocked",
				incomingStatus
			);
		}

		const checkedOut = await reconcile({
			intent: "reservation_status",
			eventType: "status",
			statusToApply: "checked_out",
		});
		assert.equal(checkedOut.status, "status_updated");
		assert.equal(mutationCalls, 1);
	} finally {
		Reservations.find = originalReservationFind;
		Reservations.updateOne = originalReservationUpdateOne;
	}
});

test("in-house and terminal authoritative refreshes fail closed before room matching", async () => {
	const originalReservationFind = Reservations.find;
	const originalReservationUpdateOne = Reservations.updateOne;
	const originalHotelFind = HotelDetails.find;
	const originalHotelFindById = HotelDetails.findById;
	let mutationCalls = 0;
	let existing = {
		_id: "existing-inhouse-refresh",
		hotelId: "hotel-a",
		confirmation_number: "9000000004",
		otaIdentityKey: "expedia:55667788",
		reservation_id: "55667788",
		customer_details: { confirmation_number2: "55667788" },
		supplierData: {
			otaProvider: "expedia",
			suppliedBookingNo: "55667788",
			otaConfirmationNumber: "55667788",
			platformConfirmationNumber: "55667788",
			otaLastSourceReceivedAt: "2026-08-04T10:00:00.000Z",
			otaSourceAuthority: 1,
		},
		otaPlatformReview: {
			status: "pending",
			provider: "expedia",
			confirmationNumber: "55667788",
		},
		state: "inhouse",
		reservation_status: "inhouse",
	};
	Reservations.find = () => ({
		limit() {
			return this;
		},
		async exec() {
			return [existing];
		},
	});
	Reservations.updateOne = async () => {
		mutationCalls += 1;
		throw new Error("unexpected reservation mutation");
	};
	HotelDetails.find = () => {
		throw new Error("room/hotel resolution should not run");
	};
	HotelDetails.findById = () => {
		throw new Error("room/hotel resolution should not run");
	};

	try {
		for (const [protectedStatus, expectedReason] of [
			["inhouse", "inhouse_ota_reservation_refresh_blocked"],
			["cancelled", "terminal_ota_reservation_refresh_blocked"],
			["no_show", "terminal_ota_reservation_refresh_blocked"],
			["checked_out", "terminal_ota_reservation_refresh_blocked"],
		]) {
			existing = {
				...existing,
				state: protectedStatus,
				reservation_status: protectedStatus,
			};
			const result = await reconcileOtaReservation({
				provider: "expedia",
				providerLabel: "Expedia",
				bookingSource: "Expedia",
				confirmationNumber: "55667788",
				intent: "new_reservation",
				eventType: "new",
				guestName: "Example Guest",
				hotelName: "Example Hotel",
				roomName: "Double Room",
				checkinDate: "2026-08-10",
				checkoutDate: "2026-08-11",
				amount: 100,
				totalAmountSar: 100,
				sourcePresence: { confirmationNumber: true, amount: true },
				source: {
					from: "expedia-sync",
					receivedAt: "2026-08-04T11:00:00.000Z",
				},
			});
			assert.equal(result.status, "needs_review", protectedStatus);
			assert.equal(result.actionTaken, "skipped", protectedStatus);
			assert.equal(result.skipReason, expectedReason, protectedStatus);
		}
	} finally {
		Reservations.find = originalReservationFind;
		Reservations.updateOne = originalReservationUpdateOne;
		HotelDetails.find = originalHotelFind;
		HotelDetails.findById = originalHotelFindById;
	}
	assert.equal(mutationCalls, 0);
});

test("fresh ordinary modifications stage without hotel lookup or room AI", async () => {
	const originalReservationFind = Reservations.find;
	const originalReservationUpdateOne = Reservations.updateOne;
	const originalHotelFind = HotelDetails.find;
	const originalHotelFindById = HotelDetails.findById;
	let updateSet = null;
	const existing = {
		_id: "existing-stage-only",
		hotelId: "hotel-a",
		confirmation_number: "9000000005",
		otaIdentityKey: "booking:99887766",
		reservation_id: "99887766",
		customer_details: { confirmation_number2: "99887766" },
		supplierData: {
			otaProvider: "booking",
			suppliedBookingNo: "99887766",
			otaConfirmationNumber: "99887766",
			platformConfirmationNumber: "99887766",
			otaLastSourceReceivedAt: "2026-08-04T10:00:00.000Z",
		},
		otaPlatformReview: {
			provider: "booking",
			confirmationNumber: "99887766",
		},
		state: "confirmed",
		reservation_status: "confirmed",
	};
	Reservations.find = () => ({
		limit() {
			return this;
		},
		async exec() {
			return [existing];
		},
	});
	Reservations.updateOne = async (_filter, update) => {
		updateSet = update.$set;
		return { matchedCount: 1 };
	};
	HotelDetails.find = () => {
		throw new Error("hotel lookup should not run for a stage-only update");
	};
	HotelDetails.findById = () => {
		throw new Error("hotel lookup should not run for a stage-only update");
	};

	try {
		const result = await reconcileOtaReservation({
			provider: "booking",
			providerLabel: "Booking.com",
			confirmationNumber: "99887766",
			intent: "reservation_update",
			eventType: "modified",
			roomName: "A room name that would otherwise need matching",
			sourcePresence: { confirmationNumber: true, roomName: true },
			source: {
				from: "expedia-sync",
				receivedAt: "2026-08-04T11:00:00.000Z",
			},
		});
		assert.equal(result.status, "updated");
		assert.equal(updateSet.state, "OTA Platform Review");
		assert.equal(updateSet.reservation_status, "OTA Platform Review");
		assert.equal(
			updateSet["supplierData.otaLastSourceReceivedAt"].toISOString(),
			"2026-08-04T11:00:00.000Z"
		);
	} finally {
		Reservations.find = originalReservationFind;
		Reservations.updateOne = originalReservationUpdateOne;
		HotelDetails.find = originalHotelFind;
		HotelDetails.findById = originalHotelFindById;
	}
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

test("forwarded Expedia Partner Central bookings retain exact identity, stay, occupancy, and USD pricing", () => {
	const normalized = extractNormalizedReservation({
		from: '"Mohammed Hamouda" <xhotelpro@gmail.com>',
		to: "ota@inbound.jannatbooking.com",
		subject: "Booking Zad Al Magd 2496563741",
		text: [
			"Al-Magd Hotel",
			"Jul 2, 2026—Jul 4, 2026 (2 nights)",
			"Room Type Comfort Triple Room, City View Arrival information Estimated arrival time Not provided",
			"Reservation #2496563741",
			"Status Booked",
			"Itinerary number 72076106852131",
			"Reservation made Jun 29, 2026",
			"Guest count 2 adults,",
			"1 child( age 14 years old )",
			"Expedia Collects Payment",
			"Total guest payment 42.44",
			"Your total payout 32.36",
			"Amount to charge Expedia Group USD Nightly",
		].join("\n"),
	});

	assert.equal(normalized.provider, "expedia");
	assert.equal(normalized.intent, "new_reservation");
	assert.equal(normalized.eventType, "new");
	assert.equal(normalized.confirmationNumber, "2496563741");
	assert.equal(normalized.checkinDate, "2026-07-02");
	assert.equal(normalized.checkoutDate, "2026-07-04");
	assert.equal(normalized.bookedAt, "2026-06-29");
	assert.equal(normalized.roomName, "Comfort Triple Room, City View");
	assert.equal(normalized.adults, 2);
	assert.equal(normalized.children, 1);
	assert.equal(normalized.totalGuests, 3);
	assert.equal(normalized.sourceAmount, 42.44);
	assert.equal(normalized.sourceCurrency, "USD");
	assert.equal(normalized.totalAmountSar, 159.15);
	assert.equal(normalized.currency, "USD");
	assert.equal(normalized.paymentCollectionModel, "ota_collect");
	assert.equal(normalized.paidOnline, true);
	assert.equal(normalized.sourcePresence.confirmationNumber, true);
	assert.equal(normalized.sourcePresence.checkinDate, true);
	assert.equal(normalized.sourcePresence.checkoutDate, true);
	assert.equal(normalized.sourcePresence.bookedAt, true);
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

const hotelRunnerAgodaVccEmail = {
	from: '"HotelRunner" <noreply@hotelrunner.com>',
	to: "ota@example.com",
	subject: "Zad AJYAD Hotel - New Reservation #RTEST",
	text: [
		"AGODA (RETAIL)",
		"Confirmation Number 9990002223 Guest Name Test Guest Country Saudi",
		"Arabia Order Total \uFDFC 44 Booked Date Tuesday, July 21, 2026 23:56 Note Payment:",
		"Merchance booking (Agoda Collect) Card Effective Date:2026-07-22 Card Current Balance:44.00 Card Future Balance:44.00 Card Currency Code:SAR Card Is VCC:true",
		"Hotel Name Zad Ajyad",
		"Room Type Double Room - Comfort & Relaxation",
		"Check-in Date Jul 23, 2026",
		"Check-out Date Jul 24, 2026",
		"Guest Count 2",
		"Adult Count:2",
		"Children Count:0",
		"Status Reservation",
	].join("\n"),
};

test("HotelRunner Agoda total stops at the first money token", () => {
	assert.deepEqual(
		parseMoney("\uFDFC 44 Booked Date Tuesday, July 21, 2026 23:56"),
		{ amount: 44, currency: "SAR" }
	);
	assert.deepEqual(parseMoney("SAR 1560.00"), {
		amount: 1560,
		currency: "SAR",
	});
	assert.equal(
		parseMoney("44 Booked Date Tuesday, July 21, 2026 23:56").amount,
		44
	);
});

test("exchange-rate requests have a hard queue-safe timeout", async () => {
	const startedAt = Date.now();
	await assert.rejects(
		fetchWithHardTimeout("https://example.invalid/rate", {
			timeoutMs: 20,
			fetchImpl: async () => new Promise(() => {}),
		}),
		(error) => error?.code === "OTA_EXCHANGE_RATE_TIMEOUT"
	);
	assert.ok(Date.now() - startedAt < 500);
});

test("HotelRunner Agoda VCC pricing uses the order total and current card balance", () => {
	const normalized = extractNormalizedReservation(hotelRunnerAgodaVccEmail);

	assert.equal(normalized.provider, "agoda");
	assert.equal(normalized.confirmationNumber, "9990002223");
	assert.equal(normalized.guestName, "Test Guest");
	assert.equal(normalized.nationality, "Saudi Arabia");
	assert.equal(normalized.amount, 44);
	assert.equal(normalized.currency, "SAR");
	assert.equal(normalized.totalAmountSar, 44);
	assert.equal(normalized.paymentCollectionModel, "virtual_card");
	assert.equal(normalized.vcc.amountToCharge, 44);
	assert.equal(normalized.vcc.amountToChargeCurrency, "SAR");
	assert.equal(normalized.vcc.amountToChargeSar, 44);
	assert.equal(normalized.vcc.activationDate, "2026-07-22");
	assert.equal(normalized.totalPayoutSar, 44);
	assert.equal(normalized.netAfterExpensesTotal, 44);
	assert.equal(normalized.paymentSummary.totalPayoutAmount, 44);

	const built = buildReservationDocument(normalized, {
		_id: "test-hotel-id",
		belongsTo: "test-owner-id",
		roomCountDetails: [
			{
				roomType: "doubleRooms",
				displayName: "Double Room - Comfort & Relaxation",
				activeRoom: true,
				price: { basePrice: 75 },
			},
		],
	});

	assert.equal(built.ok, true);
	assert.equal(built.document.total_amount, 44);
	assert.equal(built.document.sub_total, 75);
	assert.equal(built.document.adminPricing.clientTotal, 44);
	assert.equal(built.document.adminPricing.rootTotal, 75);
	assert.equal(built.document.adminPricing.netAfterExpensesTotal, 44);
	assert.equal(built.document.adminPricing.otaExpenseTotal, 0);
	assert.equal(built.document.adminPricing.platformMarginTotal, -31);
	assert.equal(built.document.adminPricing.defaultDeductionApplied, false);
	assert.equal(built.document.payment, "credit/ debit");
	assert.equal(built.document.financeStatus, "not paid");
	assert.equal(built.document.paid_amount, 0);
});

test("OTA inbound totals above the safety limit require review", () => {
	const normalized = extractNormalizedReservation(hotelRunnerAgodaVccEmail);
	assert.equal(
		isOtaInboundTotalOutlier({ ...normalized, totalAmountSar: 1000001 }),
		true
	);
	assert.equal(
		isOtaInboundTotalOutlier({
			...normalized,
			totalAmountSar: 1000001,
			source: {},
			inboundEmailId: "",
		}),
		false
	);
});

test("reservation schema declares a unique Trip cross-transport identity bridge", () => {
	const index = Reservations.schema
		.indexes()
		.find(
			([, options]) =>
				options?.name === "uniq_ota_cross_transport_identity_key"
		);

	assert.ok(index);
	assert.deepEqual(index[0], { otaCrossTransportIdentityKey: 1 });
	assert.equal(index[1].unique, true);
	assert.deepEqual(index[1].partialFilterExpression, {
		otaCrossTransportIdentityKey: { $type: "string", $gt: "" },
	});
});

test("reservation schema persists the canonical OTA financial summary", () => {
	const reservation = new Reservations({
		confirmation_number: "schema-ota-financial-summary",
		ota_financial_summary: {
			provider: "trip",
			clientTotal: 367.13,
			netAfterExpenses: 346.72,
		},
	}).toObject();

	assert.deepEqual(reservation.ota_financial_summary, {
		provider: "trip",
		clientTotal: 367.13,
		netAfterExpenses: 346.72,
	});
});

test("PMS capacity is derived from room descriptions when bedsCount contains a misleading default", () => {
	assert.equal(
		roomCapacityFromLabels({
			roomType: "familyRooms",
			displayName: "Deluxe Family Accommodation",
			description:
				"Accommodates up to 5 guests and features 5 comfortable beds.",
			bedsCount: 1,
		}),
		5
	);
	assert.equal(
		roomCapacityFromLabels({
			roomType: "suite",
			displayName: "City Suite",
			description: "A suite with 4 beds and a private bathroom.",
			bedsCount: 1,
		}),
		4
	);
});

test("OTA identities are provider-namespaced and never query PMS confirmation numbers", () => {
	assert.equal(buildOtaIdentityKey("agoda", "682028095"), "agoda:682028095");
	assert.equal(buildOtaIdentityKey("booking", "682028095"), "booking:682028095");
	assert.equal(buildOtaIdentityKey("unknown", "682028095"), "");

	const query = buildOtaConfirmationLookup("682028095", "agoda");
	assert.equal(JSON.stringify(query).includes("confirmation_number"), true);
	assert.equal(JSON.stringify(query).includes('"confirmation_number"'), false);
	assert.equal(JSON.stringify(query).includes("agoda:682028095"), true);

	const legacyAgoda = {
		otaIdentityKey: "682028095",
		confirmation_number: "9796481455",
		reservation_id: "682028095",
		supplierData: { otaProvider: "agoda", otaConfirmationNumber: "682028095" },
	};
	assert.ok(
		detectConfirmationMatchFields(legacyAgoda, "682028095", "agoda").includes(
			"supplierData.otaConfirmationNumber"
		)
	);
	assert.deepEqual(
		detectConfirmationMatchFields(legacyAgoda, "682028095", "booking"),
		[],
		"a different provider cannot claim the same confirmation number",
	);
	const relayedTrip = {
		...legacyAgoda,
		otaIdentityKey: "hotelrunner:682028095",
		booking_source: "Trip.com",
		customer_details: {
			confirmation_number2: "682028095",
			booking_source: "Trip.com",
		},
		supplierData: {
			...legacyAgoda.supplierData,
			otaProvider: "hotelrunner",
			supplierName: "Trip.com",
		},
	};
	assert.deepEqual(
		detectConfirmationMatchFields(relayedTrip, "682028095", "trip"),
		[],
		"display-source labels cannot bypass the canonical provider namespace"
	);
});

test("OTA identity lookup projections never contain parent-child path collisions", async () => {
	const originalFind = Reservations.find;
	let selectedProjection = "";
	Reservations.find = () => ({
		limit() {
			return this;
		},
		select(projection) {
			selectedProjection = projection;
			return this;
		},
		async exec() {
			return [];
		},
	});

	try {
		assert.equal(
			await findReservationByOtaConfirmation(
				"1651516732730092",
				"hotelrunner",
				"_id customer_details supplierData otaPlatformReview"
			),
			null
		);
	} finally {
		Reservations.find = originalFind;
	}

	const selectedPaths = selectedProjection.split(/\s+/).filter(Boolean);
	assert.ok(selectedPaths.includes("customer_details"));
	assert.ok(selectedPaths.includes("supplierData"));
	assert.ok(selectedPaths.includes("otaPlatformReview"));
	assert.ok(selectedPaths.includes("booking_source"));
	assert.equal(
		selectedPaths.some((path) =>
			selectedPaths.some(
				(parentPath) =>
					parentPath !== path && path.startsWith(`${parentPath}.`)
			)
		),
		false
	);
});

test("OTA identity selection rejects contradictory aliases, providers, and bridge suffixes", () => {
	const confirmationNumber = "1651516732730092";
	const crossTransportIdentityKey = `trip:${confirmationNumber}`;
	const verifiedBridge = {
		_id: "bridge-reservation",
		otaIdentityKey: `hotelrunner:${confirmationNumber}`,
		otaCrossTransportIdentityKey: crossTransportIdentityKey,
		reservation_id: confirmationNumber,
		booking_source: "Trip.com",
		customer_details: {
			confirmation_number2: confirmationNumber,
			booking_source: "Trip.com",
		},
		supplierData: {
			otaProvider: "hotelrunner",
			suppliedBookingNo: confirmationNumber,
			otaConfirmationNumber: confirmationNumber,
			platformConfirmationNumber: confirmationNumber,
		},
		otaPlatformReview: {
			provider: "hotelrunner",
			confirmationNumber,
		},
	};

	assert.deepEqual(
		validateReservationOtaIdentityConsistency(
			verifiedBridge,
			confirmationNumber,
			"trip",
			crossTransportIdentityKey,
			{ matchedByCrossTransport: true }
		),
		{ valid: true, reason: "" }
	);

	const contradictoryAlias = {
		...verifiedBridge,
		supplierData: {
			...verifiedBridge.supplierData,
			platformConfirmationNumber: "1167731616604825",
		},
	};
	assert.equal(
		validateReservationOtaIdentityConsistency(
			contradictoryAlias,
			confirmationNumber,
			"trip",
			crossTransportIdentityKey,
			{ matchedByCrossTransport: true }
		).reason,
		"ota_confirmation_alias_conflict"
	);

	const contradictoryProvider = {
		...verifiedBridge,
		otaPlatformReview: {
			...verifiedBridge.otaPlatformReview,
			provider: "booking",
		},
	};
	assert.equal(
		validateReservationOtaIdentityConsistency(
			contradictoryProvider,
			confirmationNumber,
			"trip",
			crossTransportIdentityKey,
			{ matchedByCrossTransport: true }
		).reason,
		"canonical_ota_provider_conflict"
	);

	const contradictoryCanonicalSuffix = {
		...verifiedBridge,
		otaIdentityKey: "hotelrunner:1167731616604825",
	};
	assert.equal(
		validateReservationOtaIdentityConsistency(
			contradictoryCanonicalSuffix,
			confirmationNumber,
			"trip",
			crossTransportIdentityKey,
			{ matchedByCrossTransport: true }
		).reason,
		"canonical_ota_identity_confirmation_conflict"
	);
});

test("OTA identity selection fails closed on duplicate or split primary/bridge records", () => {
	const confirmationNumber = "1651516732730092";
	const crossTransportIdentityKey = `trip:${confirmationNumber}`;
	const directTrip = {
		_id: "direct-trip-record",
		otaIdentityKey: `trip:${confirmationNumber}`,
		reservation_id: confirmationNumber,
		supplierData: {
			otaProvider: "trip",
			otaConfirmationNumber: confirmationNumber,
		},
		otaPlatformReview: {
			provider: "trip",
			confirmationNumber,
		},
	};
	const hotelRunnerBridge = {
		_id: "hotelrunner-bridge-record",
		otaIdentityKey: `hotelrunner:${confirmationNumber}`,
		otaCrossTransportIdentityKey: crossTransportIdentityKey,
		reservation_id: confirmationNumber,
		customer_details: { confirmation_number2: confirmationNumber },
		supplierData: {
			otaProvider: "hotelrunner",
			otaConfirmationNumber: confirmationNumber,
		},
		otaPlatformReview: {
			provider: "hotelrunner",
			confirmationNumber,
		},
	};

	assert.throws(
		() =>
			selectConsistentOtaIdentityCandidate(
				[directTrip, hotelRunnerBridge],
				confirmationNumber,
				"trip",
				crossTransportIdentityKey
			),
		(error) =>
			error?.code === "OTA_RESERVATION_IDENTITY_CONFLICT" &&
			error?.reason === "multiple_ota_identity_candidates"
	);

	const duplicateTrip = { ...directTrip, _id: "second-direct-trip-record" };
	assert.throws(
		() =>
			selectConsistentOtaIdentityCandidate(
				[directTrip, duplicateTrip],
				confirmationNumber,
				"trip"
			),
		(error) =>
			error?.code === "OTA_RESERVATION_IDENTITY_CONFLICT" &&
		error?.reason === "multiple_ota_identity_candidates"
	);

	const hotelRunnerWithoutBridge = {
		...hotelRunnerBridge,
		otaCrossTransportIdentityKey: "",
	};
	assert.throws(
		() =>
			selectConsistentOtaIdentityCandidate(
				[hotelRunnerWithoutBridge],
				confirmationNumber,
				"trip",
				crossTransportIdentityKey
			),
		(error) =>
			error?.code === "OTA_RESERVATION_IDENTITY_CONFLICT" &&
			error?.reason === "canonical_ota_identity_provider_conflict"
	);

	assert.throws(
		() =>
			selectConsistentOtaIdentityCandidate(
				[directTrip],
				confirmationNumber,
				"hotelrunner",
				crossTransportIdentityKey
			),
		(error) =>
			error?.code === "OTA_RESERVATION_IDENTITY_CONFLICT" &&
			error?.reason === "canonical_ota_identity_provider_conflict"
	);
});

test("contradictory legacy provider labels cannot select a reservation for mutation", () => {
	const contradictoryLegacy = {
		_id: "contradictory-legacy-provider",
		reservation_id: "12345678",
		booking_source: "Booking.com",
		customer_details: {
			confirmation_number2: "12345678",
			booking_source: "Expedia",
		},
		supplierData: {
			supplierName: "HotelRunner",
			suppliedBookingNo: "12345678",
		},
	};

	const validation = validateReservationOtaIdentityConsistency(
		contradictoryLegacy,
		"12345678",
		"booking"
	);
	assert.deepEqual(validation, {
		valid: false,
		reason: "contradictory_legacy_ota_provider_evidence",
	});
	assert.throws(
		() =>
			selectConsistentOtaIdentityCandidate(
				[contradictoryLegacy],
				"12345678",
				"booking"
			),
		(error) =>
			error?.code === "OTA_RESERVATION_IDENTITY_CONFLICT" &&
			error?.reason === "contradictory_legacy_ota_provider_evidence"
	);
});

test("ambiguous numeric OTA dates fail closed", () => {
	assert.equal(parseDate("08/09/2026"), null);
	assert.equal(parseDate("09/08/2026"), null);
	assert.equal(parseDate("08-09-2026"), null);
	assert.equal(parseDate("09-08-2026"), null);
	assert.equal(parseDate("08.09.2026"), null);
	assert.equal(parseDate("09 08 2026"), null);
	assert.equal(parseDate("08–09–2026"), null);
	assert.equal(parseDate("09—08—2026"), null);
	assert.equal(parseDate("08/09/2026 UTC"), null);
	assert.equal(parseDate("08/09/2026 arbitrary suffix"), null);
	assert.equal(parseDate("08/09/26"), null);
	assert.equal(parseDate("08-09-26"), null);
	assert.equal(parseDate("13/08/26"), null);
	assert.equal(parseDate("08-13-26"), null);
	assert.equal(parseDate("07/23/2026"), "2026-07-23");
	assert.equal(parseDate("23/07/2026"), "2026-07-23");
	assert.equal(parseDate("08-13-2026"), "2026-08-13");
	assert.equal(parseDate("13-08-2026"), "2026-08-13");
	assert.equal(parseDate("13.08.2026 UTC"), "2026-08-13");
	assert.equal(parseDate("13 08 2026"), "2026-08-13");
	assert.equal(parseDate("08/08/2026"), "2026-08-08");
	assert.equal(parseDate("08-08-2026"), "2026-08-08");
	assert.equal(parseDate("2026-08-13"), "2026-08-13");
	assert.equal(parseDate("2026-08-13T23:59:59Z"), "2026-08-13");
	assert.equal(parseDate("Aug 13, 2026"), "2026-08-13");
	assert.deepEqual(generateDateRange("2026-01-01", "3026-01-01"), []);
});

test("occupancy, tax, and nightly rates cannot masquerade as a guest total", () => {
	const normalized = extractNormalizedReservation({
		from: "Booking.com <no-reply@booking.com>",
		subject: "New reservation 12345678",
		text: [
			"Reservation ID: 12345678",
			"Guest name: Safe Guest",
			"Hotel name: Zad Ajyad",
			"Room type: Double Room",
			"Check-in date: 2026-08-01",
			"Check-out date: 2026-08-03",
			"Total guests: 2",
			"Nightly rate: SAR 100",
			"Tax: SAR 30",
		].join("\n"),
	});

	assert.equal(normalized.amount, 0);
	assert.equal(normalized.totalAmountSar, 0);
	assert.equal(normalized.sourcePresence.amount, false);
	assert.ok(
		requiredNewReservationMissing(normalized).includes(
			"positive source-backed guest total",
		),
	);
});

test("flattened Agoda vouchers keep bounded guest, room, occupancy, and gross pricing fields", () => {
	const normalized = extractNormalizedReservation({
		from: '"agoda.com" <no-reply@agoda.com>',
		subject: "Agoda Booking ID 681911771 - CONFIRMED",
		text: [
			"Booking ID 681911771 Reservation Information",
			"PREPAID Booking confirmation",
			"Zyd Agyad",
			"(Property ID 90720772) City : Mecca",
			"Customer First Name Waqas Customer Last Name Khan Country of Residence Saudi",
			"Arabia Check-in July 23, 2026 Check-out July 24, 2026 Other Guests",
			"Room Type No. of Rooms Occupancy Children\u2019s age No. of Extra Bed Family - 6",
			"Persons 1 2 Adults, 3 Children 4,7,8 0",
			"From - To Rates July 23, 2026 SAR 50.48 Reference sell rate (incl. taxes & fees) SAR 70.00 Compensation Commission SAR -10.50",
			"Net rate (incl. taxes & fees) SAR 50.48",
			"Customer Info - Name: Waqas Khan, Phone: 966 581481515",
			"http://img.agoda.net/images/email/logo/logo-header-agoda@2x.png",
		].join("\n"),
	});

	assert.equal(normalized.guestName, "Waqas Khan");
	assert.equal(normalized.nationality, "Saudi Arabia");
	assert.equal(normalized.guestEmail, "");
	assert.equal(normalized.roomName, "Family - 6 Persons");
	assert.equal(normalized.roomCount, 1);
	assert.equal(normalized.adults, 2);
	assert.equal(normalized.children, 3);
	assert.equal(normalized.totalGuests, 5);
	assert.equal(normalized.totalAmountSar, 70);
	assert.equal(normalized.totalPayoutSar, 50.48);
});

test("the production Agoda six-person template keeps exact identity, room, and pricing facts", () => {
	const normalized = extractNormalizedReservation({
		from: '"agoda.com" <no-reply@agoda.com>',
		subject:
			"Agoda Booking ID 682028095 - CONFIRMED Hotel Country: Saudi Arabia Check-in July 23, 2026 / Language_English",
		text: [
			"Booking ID 682028095 Reservation Information",
			"PREPAID Booking confirmation",
			"Zyd Agyad",
			"Customer First Name KHALIL Customer Last Name BADAT Country of Residence Saudi",
			"Arabia Check-in July 23, 2026 Check-out July 24, 2026 Other Guests [RmNo.1]",
			"Room Type No. of Rooms Occupancy No. of Extra Bed Family - 6 Persons 1 6 Adults 0",
			"From - To Rates July 23, 2026 SAR 67.08 Reference sell rate (incl. taxes & fees) SAR 93.00 Compensation Commission SAR -13.95 Tax on Commission SAR -2.09",
			"Net rate (incl. taxes & fees) SAR 67.08",
			"http://img.agoda.net/images/email/logo/logo-header-agoda@2x.png",
			"Customer Notes Customer Info - Name: KHALIL BADAT, Phone: 966 505343351",
		].join("\n"),
	});

	assert.equal(normalized.guestName, "KHALIL BADAT");
	assert.equal(normalized.guestEmail, "");
	assert.equal(normalized.nationality, "Saudi Arabia");
	assert.equal(normalized.roomName, "Family - 6 Persons");
	assert.equal(normalized.totalGuests, 6);
	assert.equal(normalized.totalAmountSar, 93);
	assert.equal(normalized.totalPayoutSar, 67.08);

	const built = buildReservationDocument(normalized, {
		_id: "zad",
		belongsTo: "owner",
		roomCountDetails: [
			{
				_id: "five",
				roomType: "familyRooms",
				displayName: "Family Quintuple Room",
				activeRoom: true,
				pricingRate: [{ calendarDate: "2026-07-23", rootPrice: 75 }],
			},
			{
				_id: "six",
				roomType: "familyRooms",
				displayName: "Spacious Six-Bed Room",
				activeRoom: true,
				pricingRate: [
					{ calendarDate: "2026-07-23", rootPrice: 0.00001, price: 75 },
				],
			},
		],
	});
	assert.equal(built.ok, true);
	assert.equal(built.document.pickedRoomsType[0].displayName, "Spacious Six-Bed Room");
	assert.equal(built.document.pickedRoomsType[0].hotelRoomConfigId, "six");
	assert.equal(built.document.total_amount, 93);
	assert.equal(built.document.adminPricing.netAfterExpensesTotal, 67.08);
	assert.equal(built.document.sub_total, 75);
});

test("multi-room or multi-rate Agoda payloads require manual review", () => {
	const multiRoom = extractNormalizedReservation({
		from: "no-reply@agoda.com",
		subject: "Agoda Booking ID 682028096 - CONFIRMED",
		text: [
			"Booking ID 682028096 Reservation Information",
			"Customer First Name Safe Customer Last Name Guest Country of Residence Saudi Arabia Check-in July 23, 2026 Check-out July 24, 2026",
			"Other Guests [RmNo.1] Safe Guest [RmNo.2] Other Guest",
			"Room Type No. of Rooms Occupancy No. of Extra Bed Family - 6 Persons 2 6 Adults 0",
			"Reference sell rate (incl. taxes & fees) SAR 210.00",
		].join("\n"),
	});
	assert.equal(multiRoom.requiresManualReview, true);
	assert.ok(multiRoom.manualReviewReasons.some((reason) => /multiple rooms/i.test(reason)));

	const multiRate = extractNormalizedReservation({
		from: "no-reply@agoda.com",
		subject: "Agoda Booking ID 682028097 - CONFIRMED",
		text: [
			"Booking ID 682028097 Reservation Information",
			"Customer First Name Safe Customer Last Name Guest Country of Residence Saudi Arabia Check-in July 23, 2026 Check-out July 25, 2026",
			"Room Type No. of Rooms Occupancy No. of Extra Bed Double Room 1 2 Adults 0",
			"Reference sell rate (incl. taxes & fees) SAR 100.00",
			"Reference sell rate (incl. taxes & fees) SAR 110.00",
			"Total amount SAR 210.00",
		].join("\n"),
	});
	assert.equal(multiRate.totalAmountSar, 210);
	assert.equal(multiRate.requiresManualReview, true);
	assert.ok(multiRate.manualReviewReasons.some((reason) => /multiple reference/i.test(reason)));

	const mirroredSingleRate = extractNormalizedReservation({
		from: "no-reply@agoda.com",
		subject: "Agoda Booking ID 682028098 - CONFIRMED",
		text: [
			"Booking ID 682028098 Reservation Information Booking confirmation Zyd Agyad",
			"Customer First Name Safe Customer Last Name Guest Country of Residence Saudi Arabia Check-in July 23, 2026 Check-out July 24, 2026",
			"Room Type No. of Rooms Occupancy No. of Extra Bed Double Room 1 2 Adults 0",
			"Reference sell rate (incl. taxes & fees) SAR 70.00",
			"Reference sell rate (incl. taxes & fees) SAR 70.00",
		].join("\n"),
	});
	assert.equal(mirroredSingleRate.totalAmountSar, 70);
	assert.equal(mirroredSingleRate.requiresManualReview, false);
});

test("explicit six-person inventory selects the six-bed config, never the quintuple", () => {
	const rooms = [
		{
			_id: "family-five",
			roomType: "familyRooms",
			displayName: "Family Quintuple Room",
			activeRoom: true,
		},
		{
			_id: "family-six",
			roomType: "familyRooms",
			displayName: "Spacious Six-Bed Room",
			activeRoom: true,
		},
	];
	const match = resolveRoomMatch(
		{ roomCountDetails: rooms },
		"PRIVATE FAMILY ROOM FOR 6 -AJYAD-10 MINS TO HARAM"
	);

	assert.equal(match.roomDetails?._id, "family-six");
	assert.equal(match.matchType, "explicit_capacity");
});

test("Arabic numeric room capacities are normalized before matching", () => {
	assert.equal(
		explicitRoomCapacity(
			"\u063a\u0631\u0641\u0629 \u0666 \u0623\u0641\u0631\u0627\u062f"
		),
		6
	);
	assert.equal(
		explicitRoomCapacity(
			"\u063a\u0631\u0641\u0629 5 \u0627\u0634\u062e\u0627\u0635"
		),
		5
	);
});

test("repeated HotelRunner room blocks require manual review", () => {
	const roomBlock = [
		"Room Type",
		"Double Room",
		"Check-in Date",
		"Jul 23, 2026",
		"Check-out Date",
		"Jul 24, 2026",
		"Guest Count",
		"2",
		"Total SAR 100",
	].join("\n");
	const normalized = extractNormalizedReservation({
		from: '"HotelRunner" <noreply@hotelrunner.com>',
		subject: "Zad Ajyad - New Reservation #681911771",
		text: [
			"Booking Source Agoda",
			"Confirmation Number 681911771",
			"Hotel Name Zad Ajyad",
			roomBlock,
			roomBlock,
			"Go to reservation",
		].join("\n"),
	});

	assert.equal(normalized.requiresManualReview, true);
	assert.match(normalized.manualReviewReasons[0], /2 room blocks/i);

	const mirroredMimeParts = extractNormalizedReservation({
		from: '"HotelRunner" <noreply@hotelrunner.com>',
		subject: "Zad Ajyad - New Reservation #681911772",
		text: roomBlock,
		html: roomBlock
			.split("\n")
			.map((line) => `<div>${line}</div>`)
			.join(""),
	});
	assert.equal(mirroredMimeParts.requiresManualReview, false);

	const verifiedMirroredText = extractNormalizedReservation({
		from: '"HotelRunner" <noreply@hotelrunner.com>',
		subject: "Zad AJYAD Hotel - New Reservation #R523378333",
		text: [
			"EXPEDIA (EXPEDIA)",
			"Confirmation Number 2517494424 Guest Name Test Guest Country ~Not available Order Total $ 280.08 Booked Date Friday, July 24, 2026 12:40 Note Payment Method:HotelCollect",
			roomBlock.replace("Total SAR 100", "Total $ 280.08"),
			roomBlock.replace("Total SAR 100", "Total $ 280.08"),
			"Go to reservation",
		].join("\n"),
	});
	assert.equal(verifiedMirroredText.confirmationNumber, "2517494424");
	assert.equal(verifiedMirroredText.sourcePresence.confirmationNumber, true);
	assert.equal(verifiedMirroredText.requiresManualReview, false);
	assert.equal(verifiedMirroredText.paymentCollectionModel, "hotel_collect");

	const verifiedRiyalMirroredText = extractNormalizedReservation({
		from: '"HotelRunner" <noreply@hotelrunner.com>',
		subject: "Zad AJYAD Hotel - New Reservation #R013869207",
		text: [
			"AGODA (PRIVATE SALE + INTERNATIONAL RATE)",
			"Confirmation Number 675894003 Guest Name Test Guest Country Iraq Order Total ﷼ 252.48 Booked Date Sunday, July 05, 2026 17:40",
			roomBlock.replace("Total SAR 100", "Total ﷼ 252.48"),
			roomBlock.replace("Total SAR 100", "Total ﷼ 252.48"),
			"Go to reservation",
		].join("\n"),
	});
	assert.equal(verifiedRiyalMirroredText.totalAmountSar, 252.48);
	assert.equal(verifiedRiyalMirroredText.sourcePresence.amount, true);
	assert.equal(verifiedRiyalMirroredText.requiresManualReview, false);
});

test("ambiguous broad room categories and occupancy-only guesses fail closed", () => {
	const rooms = [
		{
			_id: "family-a",
			roomType: "familyRooms",
			displayName: "Family Annex",
			activeRoom: true,
		},
		{
			_id: "family-b",
			roomType: "familyRooms",
			displayName: "Family Economy",
			activeRoom: true,
		},
	];
	const broad = resolveRoomMatch(
		{ roomCountDetails: rooms },
		"Family Room",
		{ totalGuests: 5 }
	);
	const nonsense = resolveRoomMatch(
		{ roomCountDetails: HOTEL_ROOMS },
		"Children's age",
		{ totalGuests: 5 }
	);

	assert.equal(broad.roomDetails, null);
	assert.equal(nonsense.roomDetails, null);
});

test("heterogeneous HotelRunner room blocks require review instead of partial creation", () => {
	const normalized = extractNormalizedReservation({
		from: "noreply@hotelrunner.com",
		subject: "New Reservation #R637859217",
		text: [
			"Confirmation Number 682005847 Guest Name Test Guest Country Saudi Arabia Order Total SAR 217.80",
			"Hotel Name Zad Ajyad",
			"Room Type Comfort Family Room - 5 beds",
			"Check-in Date Jul 23, 2026 Check-out Date Jul 24, 2026 Guest Count 5 Daily Average Rate SAR 108.90 Total SAR 108.90",
			"Room Type Comfort Family Room - 4 beds",
			"Check-in Date Jul 23, 2026 Check-out Date Jul 24, 2026 Guest Count 4 Daily Average Rate SAR 108.90 Total SAR 108.90",
			"Go to reservation",
		].join("\n"),
	});

	assert.equal(normalized.requiresManualReview, true);
	assert.match(normalized.manualReviewReasons[0], /2 room blocks/i);
});

test("alphabetic template fragments cannot become OTA confirmation identities", () => {
	for (const value of [
		"RESERVATION CANCELATION",
		"Reservation\nExtra Info",
		"Confirmation number\nreceive",
	]) {
		const normalized = extractNormalizedReservation({
			from: "noreply@hotelrunner.com",
			subject: "Reservation cancellation",
			text: value,
		});
		assert.equal(normalized.confirmationNumber, "");
	}
});

test("source-backed alphabetic Airbnb confirmation codes remain valid identities", () => {
	const normalized = extractNormalizedReservation({
		from: "automated@airbnb.com",
		subject: "Reservation confirmed - Mubashar Kalyar arrives Jul 25",
		text: [
			"Confirmation code",
			"HMHBHJDJJM",
			"https://www.airbnb.com/hosting/reservations/details/HMHBHJDJJM",
			"PRIVATE FAMILY ROOM FOR 6 -AJYAD-10 MINS TO HARAM",
			"Room",
			"Check-in",
			"Jul 25, 2026",
			"Checkout",
			"Jul 26, 2026",
			"Guests",
			"6 adults",
			"Total (SAR)",
			"SAR 102.46",
			"You earn",
			"SAR 73.36",
		].join("\n"),
	});

	assert.equal(normalized.provider, "airbnb");
	assert.equal(normalized.confirmationNumber, "hmhbhjdjjm");
	assert.equal(normalized.sourcePresence.confirmationNumber, true);
});

test("Airbnb two-column stay dates and guest totals remain source-backed", () => {
	const normalized = extractNormalizedReservation({
		from: "automated@airbnb.com",
		receivedAt: "2026-07-25T11:26:06Z",
		subject: "Reservation confirmed - Muhammad Alhassan arrives Jul 25",
		text: [
			"Muhammad Alhassan",
			"Identity verified",
			"PRIVATE ROOM-3BEDS - AJYAD HOTEL-15 MINS TO HARAM",
			"Room",
			"Check-in Checkout",
			"Sat, Jul 25 Mon, Jul 27",
			"2:00 PM 10:00 AM",
			"Guests",
			"1 adult",
			"Confirmation code",
			"HM9N2QZQWJ",
			"Total (SAR) SAR 145.70",
		].join("\n"),
	});

	assert.equal(normalized.checkinDate, "2026-07-25");
	assert.equal(normalized.checkoutDate, "2026-07-27");
	assert.equal(normalized.totalGuests, 1);
	assert.equal(normalized.sourcePresence.checkinDate, true);
	assert.equal(normalized.sourcePresence.checkoutDate, true);
	assert.equal(normalized.sourcePresence.totalGuests, true);
	assert.equal(normalized.totalAmountSar, 145.7);
	assert.equal(normalized.sourcePresence.amount, true);
	assert.equal(
		requiredNewReservationMissing(normalized).some((item) =>
			/source-backed check-in|source-backed check-out|guest total/i.test(item)
		),
		false
	);
});

test("Arabic HotelRunner Airbnb messages expose deterministic reservation fields", () => {
	const normalized = extractNormalizedReservation({
		from: '"HotelRunner" <noreply@hotelrunner.com>',
		subject: "Zad AJYAD Hotel - حجز جديد #R833757345",
		text: [
			"حجز جديد",
			"AIRBNB",
			"رقم التأكيد HM9N2QZQWJ اسم الضيف Muhammad Alhassan الدولة ~غير متاح إجمالي الطلب ﷼ 104.33 تاريخ الحجز سبت، يوليو 25، 2026 14:25",
			"غرفة ثلاثية فندق زاد أجياد 2 · Private Room-3beds - Ajyad Hotel-15 mins to Haram",
			"نوع الغرفة غرفة لثلاث أفراد خاصة - أجياد - أتوبيس مجانى تاريخ تسجيل الوصول يوليو 25، 2026 تاريخ تسجيل المغادرة يوليو 27، 2026 عدد الضيوف 1 المعدل اليومي المتوسط ﷼ 52.17 الإجمالي ﷼ 104.33 آخر تحديث - الحالة حجز",
			"اذهب إلى الحجز",
		].join("\n"),
	});

	assert.equal(normalized.provider, "airbnb");
	assert.equal(normalized.intent, "new_reservation");
	assert.equal(normalized.confirmationNumber, "hm9n2qzqwj");
	assert.equal(normalized.guestName, "Muhammad Alhassan");
	assert.match(normalized.roomName, /3beds/i);
	assert.equal(normalized.checkinDate, "2026-07-25");
	assert.equal(normalized.checkoutDate, "2026-07-27");
	assert.equal(normalized.totalGuests, 1);
	assert.equal(normalized.roomCount, 1);
	assert.equal(normalized.totalAmountSar, 104.33);
	for (const field of [
		"confirmationNumber",
		"guestName",
		"roomName",
		"checkinDate",
		"checkoutDate",
		"amount",
	]) {
		assert.equal(normalized.sourcePresence[field], true, field);
	}
});

test("HotelRunner Expedia Arabic totals, occupancy, and six-person inventory stay source-backed", () => {
	const normalized = extractNormalizedReservation({
		from: '"HotelRunner" <noreply@hotelrunner.com>',
		subject: "Zad AJYAD Hotel - حجز جديد #R073513681",
		text: [
			"حجز جديد",
			"EXPEDIA (EXPEDIA AFFILIATE NETWORK)",
			"رقم التأكيد 2518431193 اسم الضيف MUHAMMAD ASIF MANZOOR الدولة الولايات المتحدة إجمالي الطلب $ 215.4 تاريخ الحجز سبت، يوليو 25، 2026 18:31 ملاحظة Smoking Type:UNSPECIFIED Payment Method:ExpediaCollect EVC Charge Status:READY TO CHARGE ON CHECK IN DATE",
			"Comfort Room, Non Smoking, Mountain View - Package - Non-Refundable - Linked",
			"نوع الغرفة غرفة عائلية -6 أفراد- أجياد- أتوبيس مجانى تاريخ تسجيل الوصول أغسطس 06، 2026 تاريخ تسجيل المغادرة أغسطس 18، 2026 عدد الضيوف 6 (4 أطفال , 2 بالغين) أعمار الأطفال 1, 7, 9, 11 المعدل اليومي المتوسط $ 17.95 الإجمالي $ 215.4 آخر تحديث - الحالة حجز",
		].join("\n"),
	});

	assert.equal(normalized.provider, "expedia");
	assert.equal(normalized.confirmationNumber, "2518431193");
	assert.equal(normalized.checkinDate, "2026-08-06");
	assert.equal(normalized.checkoutDate, "2026-08-18");
	assert.equal(normalized.amount, 215.4);
	assert.equal(normalized.currency, "USD");
	assert.equal(normalized.sourceAmount, 215.4);
	assert.equal(normalized.sourceCurrency, "USD");
	assert.equal(normalized.totalAmountSar, 807.75);
	assert.equal(normalized.sourcePresence.amount, true);
	assert.equal(normalized.adults, 2);
	assert.equal(normalized.children, 4);
	assert.equal(normalized.totalGuests, 6);
	assert.equal(normalized.sourcePresence.adults, true);
	assert.equal(normalized.sourcePresence.children, true);
	assert.match(normalized.roomName, /Comfort Room/i);
	assert.match(normalized.roomName, /6 أفراد/u);
	assert.equal(explicitRoomCapacity(normalized.roomName), 6);
	assert.deepEqual(requiredNewReservationMissing(normalized), []);

	const match = resolveRoomMatch(
		{
			roomCountDetails: [
				{
					_id: "family-five",
					roomType: "familyRooms",
					displayName: "Family Quintuple Room",
					activeRoom: true,
				},
				{
					_id: "family-six",
					roomType: "familyRooms",
					displayName: "Spacious Six-Bed Room",
					activeRoom: true,
				},
			],
		},
		normalized.roomName,
		{ totalGuests: normalized.totalGuests, normalized }
	);
	assert.equal(match.roomDetails?._id, "family-six");
	assert.equal(match.matchType, "explicit_capacity");
});

test("HotelRunner Arabic ISO currencies convert into SAR-only canonical reservation pricing", () => {
	const normalized = extractNormalizedReservation({
		from: '"HotelRunner" <noreply@hotelrunner.com>',
		subject: "Zad AJYAD Hotel - \u062d\u062c\u0632 \u062c\u062f\u064a\u062f #R073513682",
		text: [
			"\u062d\u062c\u0632 \u062c\u062f\u064a\u062f",
			"EXPEDIA",
			"\u0631\u0642\u0645 \u0627\u0644\u062a\u0623\u0643\u064a\u062f 2518431194 \u0627\u0633\u0645 \u0627\u0644\u0636\u064a\u0641 Currency Test Guest \u0627\u0644\u062f\u0648\u0644\u0629 UAE \u0625\u062c\u0645\u0627\u0644\u064a \u0627\u0644\u0637\u0644\u0628 AED 100.00 \u062a\u0627\u0631\u064a\u062e \u0627\u0644\u062d\u062c\u0632 July 25, 2026",
			"Comfort Double Room",
			"\u0646\u0648\u0639 \u0627\u0644\u063a\u0631\u0641\u0629 \u063a\u0631\u0641\u0629 \u0645\u0632\u062f\u0648\u062c\u0629 -2 \u0623\u0641\u0631\u0627\u062f \u062a\u0627\u0631\u064a\u062e \u062a\u0633\u062c\u064a\u0644 \u0627\u0644\u0648\u0635\u0648\u0644 August 06, 2026 \u062a\u0627\u0631\u064a\u062e \u062a\u0633\u062c\u064a\u0644 \u0627\u0644\u0645\u063a\u0627\u062f\u0631\u0629 August 07, 2026 \u0639\u062f\u062f \u0627\u0644\u0636\u064a\u0648\u0641 2 \u0627\u0644\u0625\u062c\u0645\u0627\u0644\u064a AED 100.00 \u0622\u062e\u0631 \u062a\u062d\u062f\u064a\u062b",
		].join("\n"),
	});

	assert.equal(normalized.provider, "expedia");
	assert.equal(normalized.confirmationNumber, "2518431194");
	assert.equal(normalized.amount, 100);
	assert.equal(normalized.currency, "AED");
	assert.equal(normalized.sourceCurrency, "AED");
	assert.equal(normalized.totalAmountSar, 102.1);
	assert.deepEqual(requiredNewReservationMissing(normalized), []);

	const room = {
		_id: "double-room",
		roomType: "doubleRooms",
		displayName: "Double Room",
		activeRoom: true,
		price: { basePrice: 75 },
	};
	const hotel = {
		_id: "hotel-zad",
		belongsTo: "owner-zad",
		roomCountDetails: [room],
	};
	const roomMatch = resolveRoomMatch(hotel, normalized.roomName, {
		totalGuests: normalized.totalGuests,
		normalized,
	});
	const built = buildReservationDocument(normalized, hotel, { roomMatch });

	assert.equal(built.ok, true);
	assert.equal(built.document.currency, "SAR");
	assert.equal(built.document.total_amount, 102.1);
	assert.equal(built.document.ota_financial_summary.currency, "SAR");
	assert.equal(built.document.supplierData.otaSourceCurrency, "AED");
	assert.equal(built.document.supplierData.otaSourceAmount, 100);
	assert.equal(built.document.supplierData.otaAmountSar, 102.1);
});

test("Arabic HotelRunner multi-room messages retain all occupancy evidence for review", () => {
	const normalized = extractNormalizedReservation({
		from: '"HotelRunner" <noreply@hotelrunner.com>',
		subject: "Zad AJYAD Hotel - حجز جديد #R833757346",
		text: [
			"حجز جديد",
			"AGODA",
			"رقم التأكيد 2035742642 اسم الضيف Abdullah Ayoub الدولة Saudi Arabia إجمالي الطلب ﷼ 288.12 تاريخ الحجز سبت، يوليو 25، 2026 14:28",
			"5 Beds Room (Comfort 5 Beds Room )",
			"نوع الغرفة غرفة عائلية خاصة لخمسة أفراد - أجياد تاريخ تسجيل الوصول يوليو 28، 2026 تاريخ تسجيل المغادرة يوليو 31، 2026 عدد الضيوف 3 المعدل اليومي المتوسط ﷼ 48.02 الإجمالي ﷼ 144.06",
			"5 Beds Room (Comfort 5 Beds Room )",
			"نوع الغرفة غرفة عائلية خاصة لخمسة أفراد - أجياد تاريخ تسجيل الوصول يوليو 28، 2026 تاريخ تسجيل المغادرة يوليو 31، 2026 عدد الضيوف 2 المعدل اليومي المتوسط ﷼ 48.02 الإجمالي ﷼ 144.06",
			"اذهب إلى الحجز",
		].join("\n"),
	});

	assert.equal(normalized.provider, "agoda");
	assert.equal(normalized.confirmationNumber, "2035742642");
	assert.equal(normalized.roomCount, 2);
	assert.equal(normalized.totalGuests, 5);
	assert.equal(normalized.checkinDate, "2026-07-28");
	assert.equal(normalized.checkoutDate, "2026-07-31");
	assert.equal(normalized.totalAmountSar, 288.12);
	assert.equal(normalized.requiresManualReview, true);
	assert.match(normalized.manualReviewReasons[0], /2 room blocks/i);
});

test("confirmation nouns and bare active text cannot mutate reservation status", () => {
	for (const text of [
		"Reservation ID: 12345678. Confirmation details are available.",
		"Reservation ID: 12345678. Your active promotions are listed below.",
	]) {
		assert.equal(
			detectStatusToApply({ subject: "Reservation status", text }),
			"",
			text,
		);
	}
	for (const input of [
		{ subject: "Reservation status: confirmed", text: "ID 12345678" },
		{ subject: "Reservation status", text: "Status: confirmed" },
		{ subject: "Reservation status", text: "The reservation has been confirmed." },
	]) {
		assert.equal(detectStatusToApply(input), "confirmed", input.text);
	}
});

test("policy and instructional text cannot become no-show or stay status", () => {
	for (const input of [
		{
			subject: "Question about no-show policy - Booking 12345678",
			text: "Reservation ID: 12345678",
		},
		{
			subject: "Reservation status",
			text: "Once the guest has checked out, you can leave a review.",
		},
		{
			subject: "Reservation status",
			text: "Online check-in completed by the guest? Read the instructions.",
		},
	]) {
		assert.equal(detectStatusToApply(input), "", input.text);
	}
	for (const input of [
		{ subject: "Reservation status: no-show", text: "ID 12345678" },
		{ subject: "Reservation status", text: "Status: checked out" },
		{ subject: "Guest checked in", text: "Reservation ID: 12345678" },
	]) {
		assert.notEqual(detectStatusToApply(input), "", input.subject);
	}
});

test("AI-only critical facts do not satisfy automatic-create requirements", () => {
	const missing = requiredNewReservationMissing({
		inboundEmailId: "audit-id",
		confirmationNumber: "681911771",
		guestName: "Suggested Guest",
		hotelName: "Suggested Hotel",
		roomName: "Suggested Room",
		checkinDate: "2026-07-23",
		checkoutDate: "2026-07-24",
		amount: 70,
		totalAmountSar: 70,
		sourcePresence: {
			confirmationNumber: true,
			guestName: false,
			hotelName: false,
			roomName: false,
			checkinDate: false,
			checkoutDate: false,
			amount: false,
		},
	});

	assert.ok(missing.includes("source-backed guest name"));
	assert.ok(missing.includes("source-backed room type/name"));
	assert.ok(missing.includes("positive source-backed guest total"));
});

test("critical-field gate is provider-independent for every supported OTA source", () => {
	for (const provider of ["hotelrunner", "agoda", "expedia", "airbnb"]) {
		const normalized = {
			inboundEmailId: `audit-${provider}`,
			provider,
			confirmationNumber: `${provider}-123456`,
			guestName: "Khalil Badat",
			hotelName: "Zad Ajyad",
			roomName: "Spacious Six-Bed Room",
			checkinDate: "2026-07-23",
			checkoutDate: "2026-07-24",
			amount: 93,
			totalAmountSar: 93,
			sourcePresence: {
				confirmationNumber: true,
				guestName: true,
				hotelName: true,
				roomName: true,
				checkinDate: true,
				checkoutDate: true,
				amount: true,
			},
		};
		assert.deepEqual(requiredNewReservationMissing(normalized), [], provider);
		for (const field of [
			"confirmationNumber",
			"guestName",
			"hotelName",
			"roomName",
			"checkinDate",
			"checkoutDate",
			"amount",
		]) {
			const unsafe = {
				...normalized,
				sourcePresence: { ...normalized.sourcePresence, [field]: false },
			};
			assert.notDeepEqual(requiredNewReservationMissing(unsafe), [], `${provider}:${field}`);
		}
	}
});

test("template labels, assets, and adjacent metadata cannot become guest or room facts", () => {
	for (const value of [
		"KHALIL Customer Last Name BADAT Country of Residence Saudi",
		"Country of Residence Saudi Arabia",
		"logo-header-agoda@2x.png",
		"https://example.com/voucher",
	]) {
		assert.equal(isPlausibleOtaGuestName(value), false, value);
	}
	for (const value of [
		"Children's Age 4",
		"Guest Name Khalil Badat",
		"Check-in Date 2026-07-23",
		"logo-header-agoda@2x.png",
	]) {
		assert.equal(isPlausibleOtaRoomName(value), false, value);
	}
	assert.equal(isPlausibleOtaGuestName("KHALIL BADAT"), true);
	assert.equal(isPlausibleOtaGuestName("خالد محمد"), true);
	assert.equal(isPlausibleOtaRoomName("Family - 6 Persons"), true);
	assert.equal(isPlausibleOtaRoomName("غرفة سداسية"), true);
});

test("room-name matching does not require occupancy and never guesses an ambiguous category", () => {
	const hotel = {
		roomCountDetails: [
			{ roomType: "familyRooms", displayName: "Family Quintuple Room", activeRoom: true },
			{ roomType: "familyRooms", displayName: "Spacious Six-Bed Room", activeRoom: true },
		],
	};
	const close = resolveRoomMatch(hotel, "Spacious Six Bed Room", {
		totalGuests: 0,
	});
	assert.equal(close.roomDetails?.displayName, "Spacious Six-Bed Room");
	const ambiguous = resolveRoomMatch(hotel, "Family Room", { totalGuests: 0 });
	assert.equal(ambiguous.roomDetails, null);
	assert.equal(ambiguous.matchType, "ambiguous");
});

test("a resolved hotel stores the selected configured PMS room while retaining OTA wording only as provenance", () => {
	const normalized = {
		provider: "agoda",
		providerLabel: "Agoda",
		bookingSource: "Agoda",
		confirmationNumber: "ROOM-AI-1001",
		reservationId: "ROOM-AI-1001",
		guestName: "Safe Guest",
		hotelName: "Zad Ajyad",
		roomName: "A roomy family accommodation with six separate beds",
		checkinDate: "2026-08-01",
		checkoutDate: "2026-08-02",
		amount: 93,
		totalAmountSar: 93,
		currency: "SAR",
		eventType: "confirmed",
	};
	const selectedRoom = {
		_id: "room-six",
		roomType: "familyRooms",
		displayName: "Spacious Six-Bed Room",
		activeRoom: true,
		price: { basePrice: 75 },
	};
	const built = buildReservationDocument(
		normalized,
		{
			_id: "hotel-zad",
			belongsTo: "owner-zad",
			roomCountDetails: [selectedRoom],
		},
		{
			roomMatch: {
				roomDetails: selectedRoom,
				score: 0.96,
				matchType: "ai_pms_room_match",
				aiRoomMatch: {
					model: "test-model",
					reason: "Best semantic PMS match",
				},
			},
		}
	);

	assert.equal(built.ok, true);
	assert.equal(built.document.hotelId, "hotel-zad");
	assert.equal(built.document.pickedRoomsType[0].displayName, "Spacious Six-Bed Room");
	assert.equal(built.document.pickedRoomsType[0].hotelRoomConfigId, "room-six");
	assert.equal(
		built.document.pickedRoomsType[0].sourceRoomName,
		"A roomy family accommodation with six separate beds"
	);
	assert.equal(built.document.supplierData.otaRoomMatchedByModel, "test-model");
});

test("the as-is OTA room fallback is unassigned and financially blocked pending hotel mapping", () => {
	const normalized = {
		provider: "agoda",
		providerLabel: "Agoda",
		bookingSource: "Agoda",
		confirmationNumber: "NO-HOTEL-1001",
		reservationId: "NO-HOTEL-1001",
		guestName: "Safe Guest",
		roomName: "Original OTA Room Wording",
		checkinDate: "2026-08-01",
		checkoutDate: "2026-08-02",
		amount: 93,
		totalAmountSar: 93,
		currency: "SAR",
		eventType: "confirmed",
		inboundEmailId: "audit-no-hotel",
		sourcePresence: {
			confirmationNumber: true,
			guestName: true,
			hotelName: false,
			roomName: true,
			checkinDate: true,
			checkoutDate: true,
			amount: true,
		},
	};
	const document = buildUnmappedOtaReviewReservationDocument(normalized);

	assert.equal(canCreateUnmappedOtaReviewReservation(normalized, true), true);
	assert.equal(
		canCreateUnmappedOtaReviewReservation(
			{
				...normalized,
				sourcePresence: { ...normalized.sourcePresence, guestName: false },
			},
			true
		),
		false
	);
	assert.equal(canCreateUnmappedOtaReviewReservation(normalized, false), false);
	assert.equal(
		canCreateUnmappedOtaReviewReservation(
			{
				...normalized,
				requiresManualReview: true,
				manualReviewReasons: ["The email contains 2 room blocks."],
			},
			true
		),
		true
	);
	assert.equal(document.hotelId, undefined);
	assert.equal(document.belongsTo, undefined);
	assert.equal(document.pickedRoomsType[0].displayName, "Original OTA Room Wording");
	assert.equal(document.pickedRoomsType[0].hotelRoomConfigId, undefined);
	assert.equal(document.pickedRoomsType[0].pricingByDay[0].rootPrice, 0);
	assert.equal(document.otaPlatformReview.hotelAssignmentRequired, true);
	assert.equal(document.adminPricing.hotelAssignmentRequired, true);
});

test("a complete generic email with an unknown provider still cannot mutate reservations", async () => {
	const result = await reconcileOtaReservation({
		inboundEmailId: "audit-generic-unknown",
		provider: "unknown",
		providerLabel: "unknown",
		intent: "new_reservation",
		eventType: "new",
		confirmationNumber: "GEN-123456",
		guestName: "Khalil Badat",
		hotelName: "Zad Ajyad",
		roomName: "Spacious Six-Bed Room",
		checkinDate: "2026-07-23",
		checkoutDate: "2026-07-24",
		amount: 93,
		currency: "SAR",
		totalAmountSar: 93,
		sourcePresence: {
			confirmationNumber: true,
			guestName: true,
			hotelName: true,
			roomName: true,
			checkinDate: true,
			checkoutDate: true,
			amount: true,
		},
		source: {
			from: "reservations@example.com",
			subject: "New reservation GEN-123456",
			messageId: "generic-unknown@example.com",
		},
	});
	assert.equal(result.status, "needs_review");
	assert.equal(result.skipReason, "unknown_ota_provider_no_mutation");
	assert.equal(result.reservationId, undefined);
});

test("ordinary OTA modifications are staged without overwriting canonical guest or stay", () => {
	const set = buildExistingReservationUpdateSet({
		normalized: {
			inboundEmailId: "audit-update",
			intent: "reservation_update",
			eventType: "modified",
			provider: "agoda",
			providerLabel: "Agoda",
			confirmationNumber: "680785631",
			guestName: "Guest of Wrong Name",
			checkinDate: "2026-08-01",
			checkoutDate: "2026-08-03",
			amount: 999,
			totalAmountSar: 999,
			sourceAmount: 999,
			sourceCurrency: "SAR",
			paymentSummary: {
				totalGuestPaymentAmount: 999,
				totalPayoutAmount: 700,
			},
			sourcePresence: {
				confirmationNumber: true,
				guestName: true,
				checkinDate: true,
				checkoutDate: true,
				amount: true,
			},
		},
		existing: {
			customer_details: { name: "Correct Guest" },
			checkin_date: "2026-07-23",
			checkout_date: "2026-07-24",
		},
	});

	assert.equal(set["customer_details.name"], undefined);
	assert.equal(set.checkin_date, undefined);
	assert.equal(set.checkout_date, undefined);
	assert.equal(set["supplierData.otaAmountSar"], undefined);
	assert.equal(set["supplierData.otaSourceAmount"], undefined);
	assert.equal(set["supplierData.otaPaymentSummary"], undefined);
	assert.equal(
		set["otaPlatformReview.proposedInbound"].guest.name,
		"Guest of Wrong Name"
	);
	assert.equal(
		set["otaPlatformReview.proposedInbound"].pricing.guestTotalSar,
		999
	);
});

test("source-backed HotelRunner relays upgrade only display source fields to Trip.com", () => {
	const warnings = [];
	const set = buildExistingReservationUpdateSet({
		normalized: {
			provider: "hotelrunner",
			providerLabel: "HotelRunner",
			bookingSource: "Trip.com",
			confirmationNumber: "1651516732730092",
			reservationId: "1651516732730092",
			sourcePresence: {
				confirmationNumber: true,
				bookingSource: true,
			},
		},
		existing: {
			booking_source: "HotelRunner",
			customer_details: { booking_source: "HotelRunner" },
			otaIdentityKey: "hotelrunner:1651516732730092",
			supplierData: { otaProvider: "hotelrunner" },
			otaPlatformReview: { provider: "hotelrunner" },
		},
		warnings,
	});

	assert.equal(set.booking_source, "Trip.com");
	assert.equal(set["customer_details.booking_source"], "Trip.com");
	assert.equal(set["supplierData.supplierName"], "Trip.com");
	assert.equal(set["adminPricing.providerLabel"], "Trip.com");
	assert.equal(set["ota_financial_summary.providerLabel"], "Trip.com");
	assert.equal(set["otaPlatformReview.providerLabel"], "Trip.com");
	assert.equal(set.otaIdentityKey, undefined);
	assert.equal(set["supplierData.otaProvider"], undefined);
	assert.equal(set["otaPlatformReview.provider"], undefined);
	assert.match(warnings.join(" "), /HotelRunner remains the transport provider/i);
});

test("a verified Trip bridge matches across providers and preserves canonical transport identity", () => {
	const confirmationNumber = "1651516732730092";
	const normalized = {
		provider: "trip",
		providerLabel: "Trip.com",
		bookingSource: "Trip.com",
		confirmationNumber,
		reservationId: confirmationNumber,
		intent: "new_reservation",
		eventType: "new",
		directTripTemplateMatched: true,
		preserveCanonicalTransportIdentity: true,
		authoritativeExistingRefresh: true,
		sourcePresence: {
			confirmationNumber: true,
			bookingSource: true,
		},
		source: { from: "Trip.com <ebooking@trip.com>" },
	};
	const crossTransportIdentityKey = buildOtaCrossTransportIdentityKey(
		normalized,
		confirmationNumber
	);
	const existing = {
		otaIdentityKey: `hotelrunner:${confirmationNumber}`,
		otaCrossTransportIdentityKey: crossTransportIdentityKey,
		reservation_id: confirmationNumber,
		booking_source: "HotelRunner",
		customer_details: {
			confirmation_number2: confirmationNumber,
			booking_source: "HotelRunner",
		},
		supplierData: {
			otaProvider: "hotelrunner",
			suppliedBookingNo: confirmationNumber,
			otaConfirmationNumber: confirmationNumber,
			platformConfirmationNumber: confirmationNumber,
		},
		adminPricing: { provider: "hotelrunner" },
		ota_financial_summary: { provider: "hotelrunner" },
		otaPlatformReview: {
			provider: "hotelrunner",
			confirmationNumber,
		},
	};

	const fields = detectConfirmationMatchFields(
		existing,
		confirmationNumber,
		"trip",
		crossTransportIdentityKey
	);
	assert.ok(fields.includes("otaCrossTransportIdentityKey"));
	assert.ok(fields.includes("reservation_id"));

	const set = buildExistingReservationUpdateSet({
		normalized,
		existing,
		document: {
			reservation_id: confirmationNumber,
			booking_source: "Trip.com",
			customer_details: { booking_source: "Trip.com" },
			supplierData: {
				supplierName: "Trip.com",
				otaProvider: "trip",
				otaConfirmationNumber: confirmationNumber,
			},
			adminPricing: { provider: "trip", providerLabel: "Trip.com" },
			ota_financial_summary: {
				provider: "trip",
				providerLabel: "Trip.com",
			},
			adminPricingVisibility: {},
		},
	});

	assert.equal(set.otaIdentityKey, undefined);
	assert.equal(set.otaCrossTransportIdentityKey, crossTransportIdentityKey);
	assert.equal(set["supplierData.otaProvider"], undefined);
	assert.equal(set["supplierData.otaLastObservedTransportProvider"], "trip");
	assert.equal(set.adminPricing.provider, "hotelrunner");
	assert.equal(set.ota_financial_summary.provider, "hotelrunner");
	assert.equal(set["otaPlatformReview.provider"], undefined);
	assert.equal(set.booking_source, "Trip.com");
	assert.equal(set["customer_details.booking_source"], "Trip.com");
	assert.equal(set["otaPlatformReview.providerLabel"], "Trip.com");
});

test("booking-source upgrades fail closed without source-backed Trip.com evidence", () => {
	for (const normalized of [
		{
			provider: "hotelrunner",
			providerLabel: "HotelRunner",
			bookingSource: "Trip.com",
			sourcePresence: { bookingSource: false },
		},
		{
			provider: "hotelrunner",
			providerLabel: "HotelRunner",
			bookingSource: "HotelRunner",
			sourcePresence: { bookingSource: true },
		},
	]) {
		const set = buildExistingReservationUpdateSet({
			normalized,
			existing: {
				booking_source: "HotelRunner",
				customer_details: { booking_source: "HotelRunner" },
			},
		});
		assert.equal(set.booking_source, undefined);
		assert.equal(set["customer_details.booking_source"], undefined);
		assert.equal(set["adminPricing.providerLabel"], undefined);
	}
});

test("status-only OTA updates keep the applied status and close terminal review state", () => {
	const existing = {
		reservation_status: "OTA Platform Review",
		state: "OTA Platform Review",
		otaPlatformReview: { status: "pending" },
	};
	const confirmed = buildExistingReservationUpdateSet({
		existing,
		statusToApply: "confirmed",
		normalized: {
			intent: "reservation_status",
			eventType: "status",
			statusToApply: "confirmed",
			confirmationNumber: "12345678",
		},
	});
	assert.equal(confirmed.reservation_status, "confirmed");
	assert.equal(confirmed.state, "confirmed");
	assert.equal(confirmed["otaPlatformReview.status"], undefined);

	const cancelled = buildExistingReservationUpdateSet({
		existing,
		statusToApply: "cancelled",
		normalized: {
			intent: "reservation_status",
			eventType: "cancelled",
			statusToApply: "cancelled",
			confirmationNumber: "12345678",
			providerLabel: "Agoda",
		},
	});
	assert.equal(cancelled.reservation_status, "cancelled");
	assert.equal(cancelled.state, "cancelled");
	assert.equal(cancelled.pendingConfirmation.status, "cancelled");
	assert.equal(cancelled.pendingConfirmation.source, "ota_email_status");
	assert.equal(cancelled.pendingConfirmation.confirmedAt, null);
	assert.match(cancelled.pendingConfirmation.rejectionReason, /Agoda cancellation/i);
	assert.equal(cancelled.agentDecisionSnapshot.status, "cancelled");
	assert.equal(cancelled.agentDecisionSnapshot.source, "ota_email_status");
	assert.equal(cancelled["otaPlatformReview.status"], "closed");
	assert.equal(cancelled["otaPlatformReview.closedReason"], "ota_status_cancelled");

	const cancelledAfterManualConfirmation = buildExistingReservationUpdateSet({
		existing: {
			reservation_status: "confirmed",
			state: "confirmed",
			pendingConfirmation: { status: "confirmed" },
			adminChangeLog: [
				{ field: "reservation_status", from: "pending", to: "confirmed" },
			],
		},
		statusToApply: "cancelled",
		normalized: {
			intent: "reservation_status",
			eventType: "cancelled",
			statusToApply: "cancelled",
			confirmationNumber: "12345678",
			providerLabel: "Agoda",
		},
	});
	assert.equal(cancelledAfterManualConfirmation.reservation_status, "cancelled");
	assert.equal(cancelledAfterManualConfirmation.state, "cancelled");
	assert.equal(
		cancelledAfterManualConfirmation.pendingConfirmation.status,
		"cancelled"
	);
});

test("HotelRunner Arabic cancellation and modification subjects are deterministic", () => {
	const commonText = [
		"EXPEDIA (EXPEDIA)",
		"رقم التأكيد 2518668243 اسم الضيف Saim Abbas الدولة ~غير متاح إجمالي الطلب $ 47.16",
		"نوع الغرفة غرفة عائلية -6 أفراد- أجياد- أتوبيس مجانى تاريخ تسجيل الوصول يوليو 26، 2026 تاريخ تسجيل المغادرة يوليو 28، 2026 عدد الضيوف 6",
	].join("\n");
	const cancellation = extractNormalizedReservation({
		from: '"HotelRunner" <noreply@hotelrunner.com>',
		subject: "Zad AJYAD Hotel - إلغاء الحجز #R819575565",
		text: `إلغاء الحجز\n${commonText}`,
		receivedAt: "2026-07-25T22:58:49.464Z",
	});
	assert.equal(cancellation.eventType, "cancelled");
	assert.equal(cancellation.intent, "reservation_status");
	assert.equal(cancellation.statusToApply, "cancelled");
	assert.equal(cancellation.confirmationNumber, "2518668243");
	assert.equal(
		new Date(cancellation.source.receivedAt).toISOString(),
		"2026-07-25T22:58:49.464Z"
	);

	const modification = extractNormalizedReservation({
		from: '"HotelRunner" <noreply@hotelrunner.com>',
		subject: "Zad AJYAD Hotel - تم تحديث الحجز #R043407511",
		text: `تم تحديث الحجز\n${commonText.replace("2518668243", "HMEYWR4MQP")}`,
	});
	assert.equal(modification.eventType, "modified");
	assert.equal(modification.intent, "reservation_update");
	assert.equal(modification.statusToApply, "");

	assert.equal(
		detectStatusToApply({ subject: "طلب إلغاء الحجز وتنازل عن الرسوم" }),
		""
	);
});

test("older OTA lifecycle emails cannot overwrite a newer applied OTA event", () => {
	assert.equal(
		isStaleOtaLifecycleEvent(
			{ source: { receivedAt: "2026-07-25T10:00:00.000Z" } },
			{ supplierData: { otaLastSourceReceivedAt: "2026-07-25T11:00:00.000Z" } }
		),
		true
	);
	assert.equal(
		isStaleOtaLifecycleEvent(
			{ source: { receivedAt: "2026-07-25T12:00:00.000Z" } },
			{ supplierData: { otaLastSourceReceivedAt: "2026-07-25T11:00:00.000Z" } }
		),
		false
	);
	assert.equal(
		isStaleOtaLifecycleEvent(
			{ source: { receivedAt: "2026-07-25T11:00:00.000Z" } },
			{ supplierData: { otaLastSourceReceivedAt: "2026-07-25T11:00:00.000Z" } }
		),
		true,
		"equal lifecycle watermarks fail closed unless the delivery is deduplicated earlier"
	);
	const existing = {
		supplierData: {
			otaLastSourceReceivedAt: "2026-07-25T11:00:00.000Z",
		},
	};
	const regressiveSet = buildExistingReservationUpdateSet({
		normalized: {
			intent: "reservation_update",
			eventType: "modified",
			source: { receivedAt: "2026-07-25T10:00:00.000Z" },
		},
		existing,
	});
	assert.equal(
		regressiveSet["supplierData.otaLastSourceReceivedAt"],
		undefined
	);
	const freshSet = buildExistingReservationUpdateSet({
		normalized: {
			intent: "reservation_update",
			eventType: "modified",
			source: { receivedAt: "2026-07-25T12:00:00.000Z" },
		},
		existing,
	});
	assert.equal(
		freshSet["supplierData.otaLastSourceReceivedAt"].toISOString(),
		"2026-07-25T12:00:00.000Z"
	);
});

test("authoritative refresh requires a built document and never copies placeholders", () => {
	const normalized = {
		inboundEmailId: "audit-refresh",
		intent: "new_reservation",
		eventType: "created",
		provider: "agoda",
		providerLabel: "Agoda",
		confirmationNumber: "681911771",
		guestName: "Waqas Khan",
		checkinDate: "2026-07-23",
		checkoutDate: "2026-07-24",
		authoritativeExistingRefresh: true,
		sourcePresence: {
			confirmationNumber: true,
			guestName: true,
			guestEmail: false,
			guestPhone: false,
			checkinDate: true,
			checkoutDate: true,
		},
	};
	const existing = {
		customer_details: { name: "Lower Authority Guest" },
		checkin_date: "2026-07-25",
		checkout_date: "2026-07-26",
	};
	const withoutDocument = buildExistingReservationUpdateSet({
		normalized,
		existing,
	});
	assert.equal(withoutDocument["customer_details.name"], undefined);
	assert.equal(withoutDocument.checkin_date, undefined);

	const withDocument = buildExistingReservationUpdateSet({
		normalized,
		existing,
		document: {
			customer_details: {
				name: "Waqas Khan",
				email: "no-email@jannatbooking.com",
				phone: "0000",
				passport: "Not Provided",
			},
			checkin_date: "2026-07-23",
			checkout_date: "2026-07-24",
			adminPricing: { clientTotal: 70 },
			ota_financial_summary: { clientTotal: 70 },
			adminPricingVisibility: { rootOnlyForHotelManagement: true },
			supplierData: { otaAmountSar: 70 },
		},
	});
	assert.equal(withDocument["customer_details.name"], "Waqas Khan");
	assert.equal(withDocument.checkin_date, "2026-07-23");
	assert.equal(withDocument["customer_details.email"], undefined);
	assert.equal(withDocument["customer_details.phone"], undefined);
	assert.equal(withDocument["customer_details.passport"], undefined);
	assert.equal(withDocument["supplierData.otaAmountSar"], 70);
});

test("source authority distinguishes direct OTA confirmations from HotelRunner copies", () => {
	assert.equal(
		otaSourceAuthority({
			provider: "agoda",
			source: { from: '"agoda.com" <no-reply@agoda.com>' },
		}),
		3
	);
	assert.equal(
		otaSourceAuthority({
			provider: "agoda",
			source: { from: '"HotelRunner" <noreply@hotelrunner.com>' },
		}),
		1
	);
	assert.equal(isAuthoritativeSourceUpgrade(2, 1), false);
	assert.equal(isAuthoritativeSourceUpgrade(3, 1), true);
	assert.equal(isAuthoritativeSourceUpgrade(3, 3), false);
	assert.equal(isAuthoritativeSourceUpgrade(4, 3), true);
});

test("fuzzy hotel matching requires a unique high-margin candidate", () => {
	const hotels = [
		{ _id: "zad", hotelName: "Zad Ajyad" },
		{ _id: "farway", hotelName: "Farway Hotel" },
	];
	assert.equal(
		findConfidentFuzzyHotelMatch(hotels, ["Zad Agyad"])?._id,
		"zad"
	);
	assert.equal(
		findConfidentFuzzyHotelMatch(
			[
				{ _id: "royal-hotel", hotelName: "Royal Ajyad Hotel" },
				{ _id: "royal-suites", hotelName: "Royal Ajyad Suites" },
			],
			["Royal Ajyad"]
		),
		null
	);
	assert.equal(findConfidentFuzzyHotelMatch(hotels, ["Unknown Palace"]), null);
});

test("generic Ajyad location wording never hard-maps another hotel to Zad", async () => {
	const configuredZadId = "6a40b6a1a6efe70450536038";
	const originalFind = HotelDetails.find;
	const originalFindById = HotelDetails.findById;
	let configuredZadLoads = 0;
	const hotels = [
		{ _id: "makarem", hotelName: "Makarem Ajyad Makkah Hotel" },
		{ _id: "elaf", hotelName: "Elaf Agyad Hotel" },
		{ _id: "royal", hotelName: "Royal Ajyad Hotel" },
		{ _id: "safwah", hotelName: "Safwah Ajyad Hotel" },
		{ _id: "other", hotelName: "Ajyad Guest Hotel" },
	];
	const queryFor = (value) => ({
		select() {
			return this;
		},
		async lean() {
			return value;
		},
	});
	HotelDetails.find = () => queryFor(hotels);
	HotelDetails.findById = (hotelId) => {
		if (String(hotelId) === configuredZadId) configuredZadLoads += 1;
		return queryFor(
			String(hotelId) === configuredZadId
				? { _id: configuredZadId, hotelName: "Zad Ajyad" }
				: null
		);
	};

	try {
		for (const hotelName of [
			"Makarem Ajayd Makkah Hotel",
			"Elaf Agyad Hotel",
			"Hotel in Ajyad",
		]) {
			const resolved = await resolveHotel({
				hotelName,
				sourcePresence: { hotelName: true },
				source: { subject: hotelName },
			});
			assert.notEqual(resolved?._id, configuredZadId, hotelName);
		}

		const zad = await resolveHotel({
			hotelName: "Zad Ajyad",
			sourcePresence: { hotelName: true },
			source: { subject: "Zad Ajyad - new reservation" },
		});
		assert.equal(zad?._id, configuredZadId);
		assert.equal(configuredZadLoads, 1);
	} finally {
		HotelDetails.find = originalFind;
		HotelDetails.findById = originalFindById;
	}
});

test("legacy sync hotel scope never blocks a confidently resolved active inbound hotel", () => {
	const previous = process.env.OTA_INBOUND_EMAIL_HOTEL_IDS;
	process.env.OTA_INBOUND_EMAIL_HOTEL_IDS = "allowed-hotel,zad-allowed";
	try {
		assert.equal(
			getManualOtaHotelAssignmentReason(
				{ hotelName: "Allowed Hotel" },
				{
					_id: "allowed-hotel",
					activateHotel: true,
					xHotelProActive: true,
				}
			),
			""
		);
		assert.equal(
			getManualOtaHotelAssignmentReason(
				{ hotelName: "Outside Hotel" },
				{
					_id: "outside-hotel",
					activateHotel: true,
					xHotelProActive: true,
				}
			),
			""
		);
		assert.equal(
			getManualOtaHotelAssignmentReason(
				{ hotelName: "Inactive Hotel" },
				{
					_id: "inactive-hotel",
					activateHotel: false,
					xHotelProActive: true,
				}
			),
			"resolved_hotel_inactive"
		);
	} finally {
		if (previous === undefined) {
			delete process.env.OTA_INBOUND_EMAIL_HOTEL_IDS;
		} else {
			process.env.OTA_INBOUND_EMAIL_HOTEL_IDS = previous;
		}
	}
});

test("inbound audit schema has an atomic partial unique delivery key", () => {
	const index = InboundEmail.schema
		.indexes()
		.find(([, options]) => options?.name === "uniq_inbound_email_dedupe_key");
	assert.ok(index);
	assert.deepEqual(index[0], { dedupeKey: 1 });
	assert.equal(index[1].unique, true);
});
