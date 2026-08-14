/** @format */

process.env.SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "SG.test";
process.env.HOTELRUNNER_INTEGRATION_ENABLED =
	process.env.HOTELRUNNER_INTEGRATION_ENABLED || "true";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const Reservations = require("../models/reservations");
const HotelDetails = require("../models/hotel_details");
const InboundEmail = require("../models/inbound_email");
const {
	getDeterministicExtractionSkipReason,
	isWeakOtaConfirmationValue,
	orchestrateInboundReservationEmail,
} = require("./otaEmailOrchestrator");
const {
	MAX_HOTELRUNNER_ARABIC_ACTION_LABEL_OCCURRENCES,
	MAX_OTA_INBOUND_RAW_REPRESENTATION_BYTES,
	MAX_HOTELRUNNER_ARABIC_ACTION_REPRESENTATION_BYTES,
	MAX_OTA_INBOUND_ROOM_COUNT,
	MAX_OTA_INBOUND_ROOM_NIGHT_SLOTS,
	buildExistingReservationUpdateSet,
	applyExistingReservationEmailUpdate,
	buildHotelRunnerEmailCommercialEvidence,
	buildDirectHotelRunnerCommercialPricing,
	buildLegacyRedactedTripConflictLookup,
	buildOtaCrossTransportIdentityKey,
	buildOtaConfirmationLookup,
	buildOtaIdentityKey,
	buildNormalizedOtaCommercialEvidence,
	buildReservationDocument,
	buildUnmappedOtaReviewReservationDocument,
	applyExactResolvedHotelToUnmappedReview,
	authoritativeExistingRefreshGuard,
	authoritativeExistingRefreshProtectedStateGuard,
	canCreateUnmappedOtaReviewReservation,
	canUseDirectAfterRelaySourceSkew,
	assertPmsConfirmationDistinctFromExternal,
	assertReservationPmsConfirmationDistinct,
	detectConfirmationMatchFields,
	directAfterRelayInventoryConflict,
	directAfterRelayUnmappedReviewGuard,
	directHotelRunnerEmailCommercialGuard,
	directHotelRunnerCommercialEnrichmentSet,
	detectPaymentCollectionModel,
	detectProvider,
	detectStatusToApply,
	decimalMoneyCents,
	explicitRoomCapacity,
	extractNormalizedReservation,
	fetchWithHardTimeout,
	applyLiveSarConversion,
	findConfidentFuzzyHotelMatch,
	findReservationByOtaConfirmation,
	generateUniquePmsConfirmationNumber,
	generateDateRange,
	getManualOtaHotelAssignmentReason,
	hasAmbiguousMultiRoomEvidence,
	hasCaptureOrSettlementActivity,
	isAuthoritativeSourceUpgrade,
	lowerAuthorityOtaLifecycleMustYieldToHotelRunnerApi,
	isStaleOtaLifecycleEvent,
	isOtaInboundTotalOutlier,
	isPlausibleOtaGuestName,
	isPlausibleOtaRoomName,
	otaSourceAuthority,
	otaInboundAllocationSafety,
	parseDate,
	parseMoney,
	multipliedMoneyCents,
	redactSensitive,
	reconcileDirectHotelRunnerOwnedEmail,
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
	verifiedHotelRunnerEmailCommercialEvidence,
	wouldReopenTerminalOtaReservation,
} = require("./otaReservationMapper");
const { matchOtaRoomWithOpenAi } = require("./otaAiRoomMatcher");
const {
	validateOtaReleaseHotelBasePrice,
} = require("./otaReviewPricingInvariants");
const {
	buildAuthenticatedProviderCommercialEvidence,
	buildHotelRunnerUnresolvedCommercialEvidence,
	validateOtaCommercialEvidence,
} = require("./otaCommercialEvidence");
const {
	buildConfirmedEmptyProof,
	createArchiveFingerprint,
	hashStable,
} = require("./hotelrunnerFirstOtaFallback");
const {
	buildCreationAuthorization,
} = require("./hotelrunnerFallbackIngressGate");

async function assertTrustedOtaParserResourceGuard(emails = [], provider = "") {
	const guarded = emails.map(extractNormalizedReservation);
	for (const normalized of guarded) {
		assert.equal(normalized.provider, provider);
		assert.equal(normalized.otaInboundParserResourceLimitExceeded, true);
		assert.equal(normalized.requiresManualReview, true);
		assert.equal(normalized.blocksUnmappedReservationCreation, true);
		assert.equal(canCreateUnmappedOtaReviewReservation(normalized, true), false);
		assert.match(
			normalized.manualReviewReasons.join(" "),
			/bounded parser input budget/i
		);
		let rateLookupCalls = 0;
		const conversion = await applyLiveSarConversion(normalized, {
			rateLookup: async () => {
				rateLookupCalls += 1;
				throw new Error("resource guard must stop before live FX");
			},
		});
		assert.equal(rateLookupCalls, 0);
		assert.equal(conversion.otaInboundParserResourceLimitExceeded, true);
	}
	for (const email of emails) {
		const orchestrated = await orchestrateInboundReservationEmail(email);
		assert.equal(orchestrated.normalized.otaInboundParserResourceLimitExceeded, true);
		assert.equal(orchestrated.decision.usedAI, false);
		assert.equal(orchestrated.decision.skipped, true);
		assert.equal(
			orchestrated.decision.skipReason,
			"ota_inbound_parser_resource_limit"
		);
		assert.ok(orchestrated.emailText.length < 1000);
	}

	const originals = {
		reservationFind: Reservations.find,
		reservationFindOne: Reservations.findOne,
		reservationFindOneAndUpdate: Reservations.findOneAndUpdate,
		reservationCreate: Reservations.create,
		reservationUpdateOne: Reservations.updateOne,
		hotelFind: HotelDetails.find,
		hotelFindOne: HotelDetails.findOne,
	};
	let externalCalls = 0;
	const fail = () => {
		externalCalls += 1;
		throw new Error("parser resource guard must stop before lookup or write");
	};
	Reservations.find = fail;
	Reservations.findOne = fail;
	Reservations.findOneAndUpdate = fail;
	Reservations.create = fail;
	Reservations.updateOne = fail;
	HotelDetails.find = fail;
	HotelDetails.findOne = fail;
	try {
		for (const normalized of guarded) {
			for (const lifecycle of [
				{ intent: "new_reservation", eventType: "new", statusToApply: "" },
				{
					intent: "reservation_update",
					eventType: "modified",
					statusToApply: "",
				},
				{
					intent: "reservation_status",
					eventType: "cancelled",
					statusToApply: "cancelled",
				},
			]) {
				const result = await reconcileOtaReservation({
					...normalized,
					...lifecycle,
				});
				assert.equal(result.status, "needs_review");
				assert.equal(result.actionTaken, "skipped");
				assert.equal(result.skipReason, "ota_parser_requires_manual_review");
			}
		}
	} finally {
		Reservations.find = originals.reservationFind;
		Reservations.findOne = originals.reservationFindOne;
		Reservations.findOneAndUpdate = originals.reservationFindOneAndUpdate;
		Reservations.create = originals.reservationCreate;
		Reservations.updateOne = originals.reservationUpdateOne;
		HotelDetails.find = originals.hotelFind;
		HotelDetails.findOne = originals.hotelFindOne;
	}
	assert.equal(externalCalls, 0);
}

const immutableFixtureTextHash = (...parts) =>
	createHash("sha256")
		.update(parts.map((part) => String(part ?? "")).join("\n"), "utf8")
		.digest("hex");

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

test("every protected semantic category maps without AI when exactly one active compatible PMS type exists", () => {
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
						displayName: `Configured ${roomType} Annex`,
						activeRoom: true,
					},
				],
			},
			roomName
		);
		assert.equal(match.roomDetails?._id, `canonical-${roomType}`, roomName);
		assert.equal(match.mappedRoomType, roomType, roomName);
		assert.equal(match.matchType, "explicit_room_semantic", roomName);
		assert.equal(match.aiFallbackAllowed, false, roomName);
	}
});

test("incidental use, occupancy, and rate words never become canonical room evidence", () => {
	const hotel = {
		roomCountDetails: [
			{ _id: "single", roomType: "singleRooms", displayName: "Single Room", activeRoom: true },
			{ _id: "double", roomType: "doubleRooms", displayName: "Double Room", activeRoom: true },
			{ _id: "twin", roomType: "twinRooms", displayName: "Twin Room", activeRoom: true },
			{ _id: "standard", roomType: "standardRooms", displayName: "Standard Room", activeRoom: true },
		],
	};
	for (const roomName of [
		"Deluxe Room - Single Use",
		"Room for single use",
		"Room for double use",
		"Room - Double Occupancy",
		"Room - Twin Occupancy",
		"Room Only - Standard Rate",
	]) {
		const match = resolveRoomMatch(hotel, roomName);
		assert.equal(match.mappedRoomType, null, roomName);
		assert.equal(match.roomDetails, null, roomName);
	}
});

test("substring-like prose stays unmapped while an exact configured PMS display label still wins", () => {
	for (const [roomName, roomType] of [
		["Non-Smoking Room", "kingRooms"],
		["Smoking Room", "suite"],
		["No Smoking Room", "queenRooms"],
		["Parking View Room", "kingRooms"],
		["Ensuite Room", "suite"],
		["Room suited for business travelers", "suite"],
		["Kingdom Room", "kingRooms"],
		["Queenly Room", "queenRooms"],
		["Individual Bathroom Room", "individualBed"],
		["Shared Bathroom Room", "individualBed"],
	]) {
		const unrelated = resolveRoomMatch(
			{
				roomCountDetails: [
					{
						_id: "generic-semantic",
						roomType,
						displayName: `Configured ${roomType}`,
						activeRoom: true,
					},
				],
			},
			roomName
		);
		assert.equal(unrelated.mappedRoomType, null, roomName);
		assert.equal(unrelated.roomDetails, null, roomName);

		const exact = resolveRoomMatch(
			{
				roomCountDetails: [
					{
						_id: "exact-configured-label",
						roomType,
						displayName: roomName,
						activeRoom: true,
					},
				],
			},
			roomName
		);
		assert.equal(exact.roomDetails?._id, "exact-configured-label", roomName);
		assert.equal(exact.matchType, "exact_display", roomName);
	}
});

test("multiple compatible semantic PMS rooms remain eligible for AI while zero candidates fail closed", () => {
	const multiple = resolveRoomMatch(
		{
			roomCountDetails: [
				{ _id: "family-a", roomType: "familyRooms", displayName: "Family Annex A", activeRoom: true },
				{ _id: "family-b", roomType: "familyRooms", displayName: "Family Annex B", activeRoom: true },
			],
		},
		"Family Deluxe"
	);
	assert.equal(multiple.roomDetails, null);
	assert.notEqual(multiple.aiFallbackAllowed, false);

	const none = resolveRoomMatch(
		{
			roomCountDetails: [
				{ _id: "double", roomType: "doubleRooms", displayName: "Double Room", activeRoom: true },
			],
		},
		"Family Deluxe"
	);
	assert.equal(none.roomDetails, null);
	assert.equal(none.matchType, "semantic_room_type_unavailable");
	assert.equal(none.aiFallbackAllowed, false);
});

test("a unique exact compound PMS display label outranks soft semantic token order", () => {
	for (const [sourceName, rooms] of [
		[
			"Family Suite",
			[
				{ _id: "family", roomType: "familyRooms", displayName: "Family Room", activeRoom: true },
				{ _id: "family-suite", roomType: "suite", displayName: "Family Suite", activeRoom: true },
			],
		],
		[
			"Studio Suite",
			[
				{ _id: "studio", roomType: "studioRooms", displayName: "Studio Room", activeRoom: true },
				{ _id: "studio-suite", roomType: "suite", displayName: "Studio Suite", activeRoom: true },
			],
		],
	]) {
		const match = resolveRoomMatch({ roomCountDetails: rooms }, sourceName);
		assert.equal(match.roomDetails?._id, rooms[1]._id, sourceName);
		assert.equal(match.roomDetails?.roomType, "suite", sourceName);
		assert.equal(match.mappedRoomType, "suite", sourceName);
		assert.equal(match.matchType, "exact_display", sourceName);
		assert.equal(match.aiFallbackAllowed, false, sourceName);
	}
});

test("duplicate exact compound displays remain unmapped without arbitrary semantic or AI selection", () => {
	const match = resolveRoomMatch(
		{
			roomCountDetails: [
				{ _id: "family-duplicate", roomType: "familyRooms", displayName: "Family Suite", activeRoom: true },
				{ _id: "suite-duplicate", roomType: "suite", displayName: "Family Suite", activeRoom: true },
			],
		},
		"Family Suite"
	);
	assert.equal(match.roomDetails, null);
	assert.equal(match.matchType, "ambiguous_exact_display");
	assert.equal(match.aiFallbackAllowed, false);
	assert.deepEqual(match.capacityCandidateIds, [
		"family-duplicate",
		"suite-duplicate",
	]);
});

test("compound semantic labels without one exact PMS display stay unmapped without AI", async () => {
	for (const sourceName of ["Family Suite", "Studio Suite"]) {
		const hotel = {
			roomCountDetails: [
				{ _id: "family", roomType: "familyRooms", displayName: "Family Annex", activeRoom: true },
				{ _id: "studio", roomType: "studioRooms", displayName: "Studio Annex", activeRoom: true },
				{ _id: "suite", roomType: "suite", displayName: "Executive Suite", activeRoom: true },
			],
		};
		const match = await resolveRoomMatchWithAi(hotel, {
			roomName: sourceName,
			roomCount: 1,
		});
		assert.equal(match.roomDetails, null, sourceName);
		assert.equal(
			match.matchType,
			"compound_semantic_exact_unavailable",
			sourceName
		);
		assert.equal(match.aiFallbackAllowed, false, sourceName);
		assert.equal(match.aiRoomMatch?.usedAI, false, sourceName);
	}
});

test("an exact display can never override an incompatible explicit room class or capacity", () => {
	const withCompatibleTriple = resolveRoomMatch(
		{
			roomCountDetails: [
				{ _id: "mislabelled-suite", roomType: "suite", displayName: "Triple Room", activeRoom: true },
				{ _id: "canonical-triple", roomType: "tripleRooms", displayName: "Three Guest Accommodation", activeRoom: true },
			],
		},
		"Triple Room"
	);
	assert.equal(withCompatibleTriple.roomDetails?._id, "canonical-triple");
	assert.equal(withCompatibleTriple.matchType, "explicit_capacity");
	assert.equal(withCompatibleTriple.aiFallbackAllowed, false);

	const withoutCompatibleTriple = resolveRoomMatch(
		{
			roomCountDetails: [
				{ _id: "mislabelled-suite", roomType: "suite", displayName: "Triple Room", activeRoom: true },
			],
		},
		"Triple Room"
	);
	assert.equal(withoutCompatibleTriple.roomDetails, null);
	assert.equal(withoutCompatibleTriple.matchType, "explicit_capacity_unavailable");
	assert.equal(withoutCompatibleTriple.aiFallbackAllowed, false);
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

test("bare room-number suffixes do not become five-person family evidence or constrain AI", async () => {
	const hotel = {
		_id: "listing-suffix-hotel",
		hotelName: "Listing Suffix Hotel",
		roomCountDetails: [
			{
				_id: "deluxe-double",
				roomType: "doubleRooms",
				displayName: "Deluxe Double Accommodation",
				description: "Configured for two guests",
				activeRoom: true,
			},
			{
				_id: "family-five",
				roomType: "familyRooms",
				displayName: "Family Quintuple Accommodation",
				description: "Configured with five beds",
				activeRoom: true,
			},
			{
				_id: "standard-room",
				roomType: "standardRooms",
				displayName: "Standard Accommodation",
				activeRoom: true,
			},
		],
	};
	const candidateCapacities = {
		"deluxe-double": 2,
		"family-five": 5,
		"standard-room": 2,
	};
	for (const roomName of ["Deluxe Room 5", "Room Five"]) {
		const deterministicMatch = resolveRoomMatch(hotel, roomName);
		assert.equal(explicitRoomCapacity(roomName), 0, roomName);
		assert.equal(deterministicMatch.roomDetails, null, roomName);
		assert.equal(deterministicMatch.mappedRoomType, null, roomName);
		assert.equal(deterministicMatch.sourceCapacity, 0, roomName);
		assert.equal(deterministicMatch.matchType, "no_deterministic_match", roomName);
		assert.deepEqual(
			deterministicMatch.capacityCandidateIds,
			["deluxe-double", "family-five", "standard-room"],
			roomName
		);

		let request = null;
		const aiResult = await matchOtaRoomWithOpenAi({
			hotelDetails: hotel,
			normalized: { roomName, roomCount: 1, totalGuests: 0 },
			deterministicMatch,
			sourceCapacity: explicitRoomCapacity(roomName),
			candidateCapacities,
			client: {
				chat: {
					completions: {
						create: async (body) => {
							request = body;
							return {
								choices: [{
									message: {
										content: JSON.stringify({
											selectedRoomId: null,
											confidence: 0,
											runnerUpRoomId: null,
											runnerUpConfidence: 0,
											basis: "no_plausible_match",
											reason: "Listing suffix is not room capacity.",
										}),
									},
								}],
							};
						},
					},
				},
			},
		});
		assert.equal(aiResult.usedAI, true, roomName);
		assert.equal(aiResult.matched, false, roomName);
		const payload = JSON.parse(request.messages[1].content);
		assert.equal(payload.deterministicHint.mappedRoomType, "", roomName);
		assert.equal(payload.otaRoom.explicitCapacity, 0, roomName);
		assert.deepEqual(
			payload.pmsRooms.map((room) => room.id),
			["deluxe-double", "family-five", "standard-room"],
			roomName
		);
	}

	for (const roomName of [
		"Quintuple Room",
		"Room for 5 guests",
		"Room with 5 beds",
	]) {
		const explicitMatch = resolveRoomMatch(hotel, roomName);
		assert.equal(explicitRoomCapacity(roomName), 5, roomName);
		assert.equal(explicitMatch.mappedRoomType, "familyRooms", roomName);
		assert.equal(explicitMatch.roomDetails?._id, "family-five", roomName);
		assert.equal(explicitMatch.matchType, "explicit_capacity", roomName);
		assert.equal(explicitMatch.aiFallbackAllowed, false, roomName);
	}
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

test("native Arabic room semantics are contextual, deterministic, and never delegated to AI", async () => {
	const semanticCases = [
		["غرفة عائلية", "familyRooms"],
		["غرفة عائلي", "familyRooms"],
		["غرفة عائلة", "familyRooms"],
		["غرفة عايلية", "familyRooms"],
		["غرفة عايلي", "familyRooms"],
		["غرفة عايلة", "familyRooms"],
		["جناح", "suite"],
		["جناح رئيسي", "masterSuite"],
		["غرفة توأم", "twinRooms"],
		["غرفة قياسية", "standardRooms"],
		["غرفة كينغ", "kingRooms"],
		["غرفة كوين", "queenRooms"],
	];
	for (const [roomName, roomType] of semanticCases) {
		const uniqueHotel = {
			roomCountDetails: [
				{
					_id: `unique-${roomType}`,
					roomType,
					displayName: `Configured ${roomType}`,
					activeRoom: true,
				},
				{
					_id: "unrelated-double",
					roomType: "doubleRooms",
					displayName: "Double Room",
					activeRoom: true,
				},
			],
		};
		const unique = await resolveRoomMatchWithAi(uniqueHotel, {
			roomName,
			roomCount: 1,
		});
		assert.equal(unique.roomDetails?._id, `unique-${roomType}`, roomName);
		assert.equal(unique.mappedRoomType, roomType, roomName);
		assert.equal(unique.matchType, "explicit_room_semantic", roomName);
		assert.equal(unique.aiFallbackAllowed, false, roomName);
		assert.equal(unique.aiRoomMatch?.usedAI, false, roomName);

		const unavailable = await resolveRoomMatchWithAi(
			{ roomCountDetails: [uniqueHotel.roomCountDetails[1]] },
			{ roomName, roomCount: 1 }
		);
		assert.equal(unavailable.roomDetails, null, roomName);
		assert.equal(unavailable.matchType, "semantic_room_type_unavailable", roomName);
		assert.equal(unavailable.aiFallbackAllowed, false, roomName);
		assert.equal(unavailable.aiRoomMatch?.usedAI, false, roomName);

		const duplicateRooms = [
			{
				_id: `${roomType}-a`,
				roomType,
				displayName: `Configured ${roomType} East`,
				activeRoom: true,
			},
			{
				_id: `${roomType}-b`,
				roomType,
				displayName: `Configured ${roomType} West`,
				activeRoom: true,
			},
		];
		const duplicate = resolveRoomMatch(
			{ roomCountDetails: duplicateRooms },
			roomName
		);
		assert.equal(duplicate.roomDetails, null, roomName);
		assert.equal(duplicate.matchType, "ambiguous", roomName);
		assert.equal(duplicate.aiFallbackAllowed, false, roomName);
		let aiCalls = 0;
		const aiResult = await matchOtaRoomWithOpenAi({
			hotelDetails: { roomCountDetails: duplicateRooms },
			normalized: { roomName, roomCount: 1 },
			deterministicMatch: duplicate,
			sourceCapacity: explicitRoomCapacity(roomName),
			candidateCapacities: Object.fromEntries(
				duplicateRooms.map((room) => [room._id, roomCapacityFromLabels(room)])
			),
			client: {
				chat: {
					completions: {
						create: async () => {
							aiCalls += 1;
							throw new Error("native Arabic deterministic rules must not call AI");
						},
					},
				},
			},
		});
		assert.equal(aiResult.usedAI, false, roomName);
		assert.equal(aiCalls, 0, roomName);
	}

	for (const incidental of [
		"سرير كينغ",
		"سرير كوين",
		"سريران توأم",
		"السعر القياسي",
		"عائلة الضيف وصلت",
	]) {
		const match = resolveRoomMatch(
			{
				roomCountDetails: [
					{ _id: "king", roomType: "kingRooms", displayName: "King Room", activeRoom: true },
					{ _id: "queen", roomType: "queenRooms", displayName: "Queen Room", activeRoom: true },
					{ _id: "family", roomType: "familyRooms", displayName: "Family Room", activeRoom: true },
				],
			},
			incidental
		);
		assert.equal(match.mappedRoomType, null, incidental);
		assert.equal(match.roomDetails, null, incidental);
	}

	for (const bedLayout of [
		"سرير كينغ في غرفة مزدوجة",
		"غرفة مزدوجة مع سرير كوين",
	]) {
		const match = resolveRoomMatch(
			{
				roomCountDetails: [
					{ _id: "double", roomType: "doubleRooms", displayName: "Double Room", activeRoom: true },
					{ _id: "king", roomType: "kingRooms", displayName: "King Room", activeRoom: true },
					{ _id: "queen", roomType: "queenRooms", displayName: "Queen Room", activeRoom: true },
				],
			},
			bedLayout
		);
		assert.equal(match.roomDetails?._id, "double", bedLayout);
		assert.equal(match.mappedRoomType, "doubleRooms", bedLayout);
	}

	const conflicting = resolveRoomMatch(
		{
			roomCountDetails: [
				{ _id: "king", roomType: "kingRooms", displayName: "King Room", activeRoom: true },
				{ _id: "queen", roomType: "queenRooms", displayName: "Queen Room", activeRoom: true },
			],
		},
		"غرفة كينغ و غرفة كوين"
	);
	assert.equal(conflicting.roomDetails, null);
	assert.equal(conflicting.matchType, "conflicting_room_semantic");
	assert.equal(conflicting.aiFallbackAllowed, false);
});

test("bounded Arabic transliterations cover room classes exactly and fail closed without AI", async () => {
	const classCases = [
		["Fardy Room", "singleRooms", 1],
		["Fardi Room", "singleRooms", 1],
		["Thonaey Room", "doubleRooms", 2],
		["Thonaei Room", "doubleRooms", 2],
		["Thunaey Room", "doubleRooms", 2],
		["Robaey Room", "quadRooms", 4],
		["Robaei Room", "quadRooms", 4],
		["Sodasy Room", "familyRooms", 6],
		["Sudasy Room", "familyRooms", 6],
		["Sobaey Room", "familyRooms", 7],
		["Thomany Room", "familyRooms", 8],
	];
	const configuredRoom = (roomType, capacity, id, suffix = "") => ({
		_id: id,
		roomType,
		displayName:
			roomType === "familyRooms"
				? `Family Room for ${capacity} guests ${suffix}`.trim()
				: `${roomType} ${suffix}`.trim(),
		activeRoom: true,
	});

	for (const [roomName, roomType, capacity] of classCases) {
		const uniqueRoom = configuredRoom(
			roomType,
			capacity,
			`unique-${roomName}`
		);
		const unique = await resolveRoomMatchWithAi(
			{ roomCountDetails: [uniqueRoom] },
			{ roomName, roomCount: 1 }
		);
		assert.equal(unique.roomDetails?._id, uniqueRoom._id, roomName);
		assert.equal(unique.mappedRoomType, roomType, roomName);
		assert.equal(unique.sourceCapacity, capacity, roomName);
		assert.equal(unique.matchType, "explicit_capacity", roomName);
		assert.equal(unique.aiFallbackAllowed, false, roomName);
		assert.equal(unique.aiRoomMatch?.usedAI, false, roomName);

		const unavailable = await resolveRoomMatchWithAi(
			{
				roomCountDetails: [
					{ _id: "unrelated-suite", roomType: "suite", displayName: "Suite", activeRoom: true },
				],
			},
			{ roomName, roomCount: 1 }
		);
		assert.equal(unavailable.roomDetails, null, roomName);
		assert.equal(unavailable.matchType, "explicit_capacity_unavailable", roomName);
		assert.equal(unavailable.aiFallbackAllowed, false, roomName);
		assert.equal(unavailable.aiRoomMatch?.usedAI, false, roomName);

		const duplicateRooms = [
			configuredRoom(roomType, capacity, `${roomName}-a`, "East"),
			configuredRoom(roomType, capacity, `${roomName}-b`, "West"),
		];
		const duplicate = resolveRoomMatch(
			{ roomCountDetails: duplicateRooms },
			roomName
		);
		assert.equal(duplicate.roomDetails, null, roomName);
		assert.equal(duplicate.matchType, "ambiguous", roomName);
		assert.equal(duplicate.aiFallbackAllowed, false, roomName);
		let aiCalls = 0;
		const aiResult = await matchOtaRoomWithOpenAi({
			hotelDetails: { roomCountDetails: duplicateRooms },
			normalized: { roomName, roomCount: 1 },
			deterministicMatch: duplicate,
			sourceCapacity: capacity,
			candidateCapacities: Object.fromEntries(
				duplicateRooms.map((room) => [room._id, roomCapacityFromLabels(room)])
			),
			client: {
				chat: {
					completions: {
						create: async () => {
							aiCalls += 1;
							throw new Error("explicit transliteration must not call AI");
						},
					},
				},
			},
		});
		assert.equal(aiResult.usedAI, false, roomName);
		assert.equal(aiCalls, 0, roomName);
	}

	for (const roomName of ["Aely", "Aely Room"]) {
		const family = {
			_id: "aely-family",
			roomType: "familyRooms",
			displayName: "Family Room",
			activeRoom: true,
		};
		const unique = await resolveRoomMatchWithAi(
			{ roomCountDetails: [family] },
			{ roomName, roomCount: 1 }
		);
		assert.equal(unique.roomDetails?._id, family._id, roomName);
		assert.equal(unique.mappedRoomType, "familyRooms", roomName);
		assert.equal(unique.aiFallbackAllowed, false, roomName);
		assert.equal(unique.aiRoomMatch?.usedAI, false, roomName);

		const unavailable = await resolveRoomMatchWithAi(
			{
				roomCountDetails: [
					{ _id: "double", roomType: "doubleRooms", displayName: "Double Room", activeRoom: true },
				],
			},
			{ roomName, roomCount: 1 }
		);
		assert.equal(unavailable.roomDetails, null, roomName);
		assert.equal(unavailable.matchType, "semantic_room_type_unavailable", roomName);
		assert.equal(unavailable.aiFallbackAllowed, false, roomName);

		const duplicate = await resolveRoomMatchWithAi(
			{
				roomCountDetails: [
					{ _id: "family-a", roomType: "familyRooms", displayName: "Family East", activeRoom: true },
					{ _id: "family-b", roomType: "familyRooms", displayName: "Family West", activeRoom: true },
				],
			},
			{ roomName, roomCount: 1 }
		);
		assert.equal(duplicate.roomDetails, null, roomName);
		assert.equal(duplicate.matchType, "ambiguous", roomName);
		assert.equal(duplicate.aiFallbackAllowed, false, roomName);
		assert.equal(duplicate.aiRoomMatch?.usedAI, false, roomName);
	}

	for (const incidental of [
		"Fardyana Room",
		"Thonaeyan Room",
		"Robaeya Room",
		"Sodasyah Room",
		"Sobaeyan Room",
		"Thomanyah Room",
		"Aelyana Room",
		"Fardy rate",
		"promotion Thonaey",
		"Aely rate",
	]) {
		const match = resolveRoomMatch(
			{
				roomCountDetails: [
					{ _id: "alpha", roomType: "singleRooms", displayName: "Alpha Accommodation", activeRoom: true },
					{ _id: "beta", roomType: "doubleRooms", displayName: "Beta Accommodation", activeRoom: true },
					{ _id: "gamma", roomType: "familyRooms", displayName: "Gamma Accommodation", activeRoom: true },
				],
			},
			incidental
		);
		assert.equal(match.mappedRoomType, null, incidental);
		assert.equal(match.sourceCapacity, 0, incidental);
		assert.equal(match.roomDetails, null, incidental);
	}
});

test("duplicate explicit room classes choose only a strong deterministic label and never invoke AI", async () => {
	const hotel = {
		roomCountDetails: [
			{ _id: "triple-basic", roomType: "tripleRooms", displayName: "Triple Room", activeRoom: true },
			{ _id: "triple-deluxe", roomType: "tripleRooms", displayName: "Deluxe Triple Room", activeRoom: true },
		],
	};
	const exact = await resolveRoomMatchWithAi(hotel, {
		roomName: "Deluxe Triple Room",
		roomCount: 1,
	});
	assert.equal(exact.roomDetails?._id, "triple-deluxe");
	assert.equal(exact.aiFallbackAllowed, false);
	assert.equal(exact.aiRoomMatch?.usedAI, false);

	for (const roomName of ["Triple", "Tholasy", "غرفة ثلاثية"]) {
		const ambiguousHotel = {
			roomCountDetails: hotel.roomCountDetails.map((room, index) => ({
				...room,
				displayName: `Three Guest Accommodation ${index + 1}`,
			})),
		};
		const deterministic = resolveRoomMatch(ambiguousHotel, roomName);
		assert.equal(deterministic.roomDetails, null, roomName);
		assert.equal(deterministic.matchType, "ambiguous", roomName);
		assert.equal(deterministic.aiFallbackAllowed, false, roomName);
		let aiCalls = 0;
		const aiResult = await matchOtaRoomWithOpenAi({
			hotelDetails: ambiguousHotel,
			normalized: { roomName, roomCount: 1 },
			deterministicMatch: deterministic,
			sourceCapacity: 3,
			candidateCapacities: {
				"triple-basic": 3,
				"triple-deluxe": 3,
			},
			client: {
				chat: {
					completions: {
						create: async () => {
							aiCalls += 1;
							throw new Error("explicit class ambiguity must not call AI");
						},
					},
				},
			},
		});
		assert.equal(aiResult.usedAI, false, roomName);
		assert.equal(aiCalls, 0, roomName);
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

const wrappedDirectTripRoomEmail = ({
	confirmationNumber = "1567953940758068",
	guestGross = "16.83",
	hotelPayout = "15.89",
	newReservation = false,
	guestName = "Synthetic Guest",
} = {}) => ({
	from: "Trip.com <ebooking@trip.com>",
	to: "ota@example.com",
	subject: `${newReservation ? "New " : ""}Booking no. # ${confirmationNumber} #`,
	messageId: `trip-${confirmationNumber}@mail.trip.com`,
	sourceReceivedAt: "2026-08-09T05:47:21.899Z",
	senderAuthentication: {
		authenticatedAligned: true,
		trustedProvider: "trip",
		method: "dkim",
	},
	text: [
		`Booking no. # ${confirmationNumber} #`,
		"Zad Ajyad Hotel",
		"Guest Name:",
		guestName,
		"Staying period: Aug 10, 2026 - Aug 11, 2026 | 1 night",
		"Room Type:Comfort Quadruple Room - Zad Ajyad Hotel - Bus to Haram",
		"Flexible-before the day of arrival-Room Only-Prepay | 1 room(s)AllotmentBed",
		"Room Type: Comfort Quadruple Room - Zad Ajyad Hotel - Bus to Haram Flexible-before the day of arrival-Room Only-Prepay | 1 room(s) Allotment",
		"Guests (estimated): 4 adults, 0 children",
		"Payment information",
		"Net rate | Prepaid | monthly settlement",
		"Room rate 1 room(s) x 1 night(s)",
		`Final room rate (incl. taxes and fees) USD ${guestGross}`,
		`Your payout USD ${hotelPayout}`,
		"This is a prepaid reservation. The guest has already paid for the room.",
		"Room ratePrice details",
	].join("\n"),
});

test("production-shaped wrapped Trip room labels remain one source-backed room", () => {
	const normalized = extractNormalizedReservation(wrappedDirectTripRoomEmail());

	assert.equal(normalized.confirmationNumber, "1567953940758068");
	assert.equal(normalized.directTripTemplateMatched, true);
	assert.deepEqual(normalized.genericRepeatedFactConflictFields, []);
	assert.equal(normalized.genericRepeatedFactConflict, false);
	assert.equal(normalized.requiresManualReview, false);
	assert.equal(normalized.sourcePresence.roomName, true);
	assert.equal(
		normalized.roomName,
		"Comfort Quadruple Room - Zad Ajyad Hotel - Bus to Haram Flexible-before the day of arrival-Room Only-Prepay"
	);
	assert.equal(normalized.sourceAmount, 16.83);
	assert.equal(normalized.sourceCurrency, "USD");
	assert.equal(normalized.paymentSummary.sourceTotalPayoutAmount, 15.89);
});

test("direct Trip surname/given guest names display in given-name order only for the dedicated template", () => {
	for (const [sourceName, expectedName] of [
		["FAMILY/GIVEN", "Given FAMILY"],
		["Family/Given Middle", "Given Middle Family"],
		["FAMILY/GIVEN-MIDDLE", "Given-Middle FAMILY"],
		["ABDALLA/SALAH", "Salah ABDALLA"],
		["Sadiyah/Maulina Ummatus", "Maulina Ummatus Sadiyah"],
		["Magdy/Hesham", "Hesham Magdy"],
	]) {
		const email = wrappedDirectTripRoomEmail({ guestName: sourceName });
		const normalized = extractNormalizedReservation({
			...email,
			html: email.text
				.split("\n")
				.map((line) => `<div>${line}</div>`)
				.join(""),
		});

		assert.equal(normalized.directTripTemplateMatched, true, sourceName);
		assert.deepEqual(normalized.directTripMimeConflictFields, [], sourceName);
		assert.equal(normalized.guestName, expectedName, sourceName);
		assert.equal(normalized.sourcePresence.guestName, true, sourceName);
	}

	for (const unchangedName of [
		"Single Guest",
		"/Given",
		"Family/",
		"Family/Given/Extra",
		"123/456",
	]) {
		const normalized = extractNormalizedReservation(
			wrappedDirectTripRoomEmail({ guestName: unchangedName })
		);
		assert.equal(normalized.guestName, unchangedName, unchangedName);
	}

	const normalized = extractNormalizedReservation(
		wrappedDirectTripRoomEmail({ guestName: "FAMILY/GIVEN" })
	);
	const built = buildReservationDocument(normalized, {
		_id: "trip-name-hotel",
		belongsTo: "trip-name-owner",
		roomCountDetails: [
			{
				_id: "trip-name-room",
				roomType: "quadRooms",
				displayName: normalized.roomName,
				activeRoom: true,
				price: { basePrice: 75 },
			},
		],
	});
	assert.equal(built.ok, true, JSON.stringify(built));
	assert.equal(built.document.customer_details.name, "Given FAMILY");

	const nonTemplateEmail = wrappedDirectTripRoomEmail({
		guestName: "Family/Given",
	});
	nonTemplateEmail.text = nonTemplateEmail.text.replace(
		/Your payout[^\n]+\n/,
		""
	);
	const nonTemplate = extractNormalizedReservation(nonTemplateEmail);
	assert.equal(nonTemplate.directTripTemplateMatched, false);
	assert.equal(nonTemplate.guestName, "Family/Given");
});

const productionTripTwoRoomEmail = ({
	htmlAug12Payout = "15.17",
} = {}) => {
	const lines = (aug12Payout) => [
		"Booking no. # 1648123456789012 #",
		"Zad Ajyad Hotel",
		"Guest Name:",
		"Synthetic Trip Multi Room Guest",
		"Room Type:Comfort Triple Bed Room - Zad Ajyad - Bus to Haram Non-Refundable-Room",
		"Only-Prepay | 2 room(s)AllotmentBed type:3 Single bedStaying period:Aug 12, 2026 - Aug 15, 2026 | 3 nights",
		"Room Type: Comfort Triple Bed Room - Zad Ajyad - Bus to Haram Non-Refundable-Room Only-Prepay | 2 room(s) Allotment",
		"Staying period: Aug 12, 2026 - Aug 15, 2026 | 3 nights",
		"Guests (estimated): 6 adults, 0 children",
		"Payment information",
		"Net rate | Prepaid | monthly settlement",
		"Room rate 2 room(s) × 3 night(s)This rate is for 6 adults",
		"Final room rate (incl. taxes and fees) USD 99.42",
		"Your payout USD 93.90",
		"This is a prepaid reservation. The guest has already paid for the room.",
		"Room ratePrice details",
		"Aug 12 (2 room(s))",
		"Final room rate (incl. taxes and fees)16.06*2",
		`Your payout${aug12Payout}*2`,
		"Aug 13 (2 room(s))",
		"Final room rate (incl. taxes and fees)16.06*2",
		"Your payout15.17*2",
		"Aug 14 (2 room(s))",
		"Final room rate (incl. taxes and fees)17.59*2",
		"Your payout16.61*2",
		"Additional InformationTypeDetailsRewards",
	];
	const textLines = lines("15.17");
	const htmlLines = lines(htmlAug12Payout);
	return {
		from: "Trip.com <ebooking@trip.com>",
		to: "ota@example.com",
		subject: "New Booking no. # 1648123456789012 #",
		messageId: "trip-1648123456789012@mail.trip.com",
		sourceReceivedAt: "2026-08-13T19:00:00.000Z",
		senderAuthentication: {
			authenticatedAligned: true,
			trustedProvider: "trip",
			method: "dkim",
		},
		text: textLines.join("\n"),
		html: htmlLines.map((line) => `<div>${line}</div>`).join(""),
	};
};

test("production Trip mirrored two-room rows retain source nightly weights and materialize count-one rooms", async () => {
	const parsed = extractNormalizedReservation(productionTripTwoRoomEmail());
	assert.equal(parsed.directTripTemplateMatched, true);
	assert.equal(parsed.directTripNightlyPricingConflict, false);
	assert.deepEqual(parsed.genericRepeatedFactConflictFields, []);
	assert.equal(parsed.requiresManualReview, false);
	assert.equal(parsed.blocksUnmappedReservationCreation, false);
	assert.equal(parsed.roomCount, 2);
	assert.equal(parsed.totalGuests, 6);
	assert.equal(parsed.sourceAmount, 99.42);
	assert.equal(parsed.paymentSummary.sourceTotalPayoutAmount, 93.9);
	assert.deepEqual(
		parsed.nightlyPricingSource.map((row) => row.clientAmount),
		[32.12, 32.12, 35.18]
	);
	assert.deepEqual(
		parsed.nightlyPricingSource.map((row) => row.payoutAmount),
		[30.34, 30.34, 33.22]
	);

	const converted = await applyLiveSarConversion(parsed, {
		apiKey: "trip-two-room-test-credential",
		cache: new Map(),
		now: () => Date.parse("2026-08-13T20:00:00.000Z"),
		fetchImpl: async () => ({
			ok: true,
			async json() {
				return {
					result: "success",
					base_code: "USD",
					target_code: "SAR",
					conversion_rate: 3.75,
					time_last_update_unix:
						Date.parse("2026-08-13T18:00:00.000Z") / 1000,
				};
			},
		}),
	});
	assert.equal(converted.totalAmountSar, 372.83);
	assert.equal(converted.totalPayoutSar, 352.13);
	assert.equal(
		Number((converted.totalAmountSar - converted.totalPayoutSar).toFixed(2)),
		20.7
	);
	assert.equal(converted.exchangeRateToSar, 3.75);
	assert.deepEqual(
		converted.nightlyPricingSar.map((row) => row.clientAmountSar),
		[120.45, 120.45, 131.93]
	);
	assert.deepEqual(
		converted.nightlyPricingSar.map((row) => row.payoutAmountSar),
		[113.78, 113.78, 124.57]
	);

	const room = {
		_id: "synthetic-trip-triple-room",
		roomType: "tripleRooms",
		displayName:
			"Comfort Triple Bed Room - Zad Ajyad - Bus to Haram Non-Refundable-Room Only-Prepay",
		activeRoom: true,
		pricingRate: generateDateRange(
			converted.checkinDate,
			converted.checkoutDate
		).map((calendarDate) => ({ calendarDate, rootPrice: 50 })),
	};
	const built = buildReservationDocument(
		converted,
		{
			_id: "synthetic-zad-hotel",
			belongsTo: "synthetic-owner",
			currency: "SAR",
			roomCountDetails: [room],
		},
		{
			roomMatch: {
				roomDetails: room,
				score: 1,
				matchType: "exact_display",
			},
		}
	);
	assert.equal(built.ok, true, JSON.stringify(built));
	assert.equal(built.document.total_rooms, 2);
	assert.equal(built.document.pickedRoomsPricing.length, 2);
	assert.deepEqual(
		built.document.pickedRoomsPricing.map((entry) => entry.count),
		[1, 1]
	);
	assert.deepEqual(
		built.document.pickedRoomsPricing.map((entry) =>
			entry.pricingByDay.map((day) => day.clientPrice)
		),
		[
			[60.23, 60.23, 65.97],
			[60.22, 60.22, 65.96],
		]
	);
	assert.deepEqual(
		built.document.pickedRoomsPricing.map((entry) =>
			entry.pricingByDay.map((day) => day.netAfterExpenses)
		),
		[
			[56.89, 56.89, 62.29],
			[56.89, 56.89, 62.28],
		]
	);
	const mappedDays = built.document.pickedRoomsPricing.flatMap(
		(entry) => entry.pricingByDay
	);
	assert.equal(
		Number(mappedDays.reduce((sum, day) => sum + day.clientPrice, 0).toFixed(2)),
		372.83
	);
	assert.equal(
		Number(
			mappedDays.reduce((sum, day) => sum + day.netAfterExpenses, 0).toFixed(2)
		),
		352.13
	);

	const review = buildUnmappedOtaReviewReservationDocument(converted);
	assert.equal(review.total_rooms, 2);
	assert.deepEqual(review.pickedRoomsPricing.map((entry) => entry.count), [1, 1]);
	assert.deepEqual(
		review.pickedRoomsPricing.map((entry) =>
			entry.pricingByDay.map((day) => day.clientPrice)
		),
		[
			[60.23, 60.23, 65.97],
			[60.22, 60.22, 65.96],
		]
	);
	assert.ok(
		review.pickedRoomsPricing
			.flatMap((entry) => entry.pricingByDay)
			.every(
				(day) =>
					day.rootPrice === 0 &&
					day.totalPriceWithoutCommission === 0 &&
					day.platformMargin === null
			)
	);
});

test("trusted direct Trip parser input budgets stop text and HTML before FX, AI, lookup, or writes", async () => {
	const normal = wrappedDirectTripRoomEmail();
	assert.equal(
		extractNormalizedReservation(normal).otaInboundParserResourceLimitExceeded,
		false
	);
	const oversized = [
		{
			...normal,
			text: `${normal.text}\n${"x".repeat(
				MAX_OTA_INBOUND_RAW_REPRESENTATION_BYTES
			)}`,
		},
		{
			...normal,
			html: `<div>${normal.text}</div>${"x".repeat(
				MAX_OTA_INBOUND_RAW_REPRESENTATION_BYTES
			)}`,
		},
	];
	await assertTrustedOtaParserResourceGuard(oversized, "trip");
});

test("conflicting Trip nightly rows across MIME mirrors fail closed", () => {
	const normalized = extractNormalizedReservation(
		productionTripTwoRoomEmail({ htmlAug12Payout: "15.18" })
	);
	assert.equal(normalized.directTripTemplateMatched, true);
	assert.equal(normalized.directTripNightlyPricingConflict, true);
	assert.deepEqual(normalized.nightlyPricingSource, []);
	assert.equal(normalized.requiresManualReview, true);
	assert.equal(normalized.blocksUnmappedReservationCreation, true);
	assert.match(normalized.manualReviewReasons.join(" "), /nightly room-rate rows conflict/i);
	assert.equal(canCreateUnmappedOtaReviewReservation(normalized, true), false);
});

test("conflicting Trip aggregate, stay, and occupancy facts across MIME mirrors fail closed", () => {
	for (const [field, mutateHtml] of [
		[
			"guestGross",
			(html) => html.replace("USD 99.42", "USD 100.42"),
		],
		[
			"checkinDate",
			(html) =>
				html
					.replaceAll("Aug 12, 2026 - Aug 15, 2026", "Aug 13, 2026 - Aug 16, 2026"),
		],
		[
			"occupancy",
			(html) => html.replace("6 adults, 0 children", "5 adults, 0 children"),
		],
	]) {
		const email = productionTripTwoRoomEmail();
		const normalized = extractNormalizedReservation({
			...email,
			html: mutateHtml(email.html),
		});
		assert.equal(normalized.requiresManualReview, true, field);
		assert.equal(normalized.blocksUnmappedReservationCreation, true, field);
		assert.ok(normalized.directTripMimeConflictFields.includes(field), field);
		assert.match(
			normalized.manualReviewReasons.join(" "),
			/text and HTML representations/i,
			field
		);
		assert.equal(canCreateUnmappedOtaReviewReservation(normalized, true), false);
	}
});

test("direct Trip.com templates retain authenticated source pricing without materializing untrusted FX", () => {
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
		messageId: "trip-1651516732730092@mail.trip.com",
		sourceReceivedAt: "2026-08-01T10:00:00.000Z",
		senderAuthentication: {
			authenticatedAligned: true,
			trustedProvider: "trip",
			method: "dkim",
		},
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
	assert.equal(normalized.trustedTransportProvider, "trip");
	assert.equal(normalized.sourceSenderAuthenticated, true);
	assert.match(normalized.source.textHash, /^[a-f0-9]{64}$/);
	assert.equal(normalized.totalAmountSar, null);
	assert.equal(normalized.totalPayoutSar, null);
	assert.deepEqual(normalized.nightlyPricingSar, []);
	assert.deepEqual(
		normalized.nightlyPricingSource.map((row) => row.clientAmount),
		[16.06, 16.06, 16.06, 16.06, 16.83, 16.83]
	);
	assert.deepEqual(
		normalized.nightlyPricingSource.map((row) => row.payoutAmount),
		[15.17, 15.17, 15.17, 15.17, 15.89, 15.89]
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
		[null, null, null, null, null, null]
	);
	assert.deepEqual(
		built.document.pickedRoomsType[0].pricingByDay.map(
			(row) => row.netAfterExpenses
		),
		[null, null, null, null, null, null]
	);
	assert.equal(built.document.total_amount, null);
	assert.equal(built.document.sub_total, 450);
	assert.equal(built.document.adminPricing.clientTotal, null);
	assert.equal(built.document.adminPricing.netAfterExpensesTotal, null);
	assert.equal(built.document.adminPricing.otaExpenseTotal, null);
	assert.equal(built.document.adminPricing.platformMarginTotal, null);
	assert.equal(
		built.document.supplierData.otaCommercialEvidence.roles.guestGross
			.sourceAmount,
		97.9
	);
	assert.equal(
		built.document.supplierData.otaCommercialEvidence.roles.guestGross
			.propertyAmount,
		null
	);
	assert.equal(
		built.document.supplierData.otaCommercialEvidence.roles.hotelPayout
			.sourceAmount,
		92.46
	);
	assert.equal(
		built.document.supplierData.otaCommercialEvidence.roles.hotelPayout
			.propertyAmount,
		null
	);
	assert.equal(built.document.payment, "ota collect - amount unavailable");
	assert.equal(built.document.financeStatus, "commercial review required");
});

test("one-night direct Trip.com pricing keeps source evidence and root price while untrusted FX stays unknown", () => {
	const normalized = extractNormalizedReservation({
		from: "Trip.com <ebooking@trip.com>",
		subject: "Booking no. # 1167731616604825 #",
		messageId: "trip-1167731616604825@mail.trip.com",
		sourceReceivedAt: "2026-08-01T10:05:00.000Z",
		senderAuthentication: {
			authenticatedAligned: true,
			trustedProvider: "trip",
			method: "dkim",
		},
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
	assert.equal(normalized.totalAmountSar, null);
	assert.equal(normalized.totalPayoutSar, null);
	assert.deepEqual(normalized.nightlyPricingSar, []);
	assert.deepEqual(normalized.nightlyPricingSource, [
		{
			date: "2026-08-05",
			clientAmount: 16.06,
			payoutAmount: 15.17,
			currency: "USD",
		},
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
	assert.equal(built.document.total_amount, null);
	assert.equal(built.document.sub_total, 75);
	assert.equal(built.document.adminPricing.clientTotal, null);
	assert.equal(built.document.adminPricing.netAfterExpensesTotal, null);
	assert.equal(built.document.adminPricing.otaExpenseTotal, null);
	assert.equal(built.document.adminPricing.platformMarginTotal, null);
	assert.equal(
		built.document.supplierData.otaCommercialEvidence.roles.guestGross
			.sourceAmount,
		16.06
	);
	assert.equal(
		built.document.supplierData.otaCommercialEvidence.roles.guestGross
			.propertyAmount,
		null
	);
	assert.equal(
		built.document.supplierData.otaCommercialEvidence.roles.hotelPayout
			.sourceAmount,
		15.17
	);
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
	assert.equal(normalized.totalPayoutSar, null);
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

test("heterogeneous direct Trip.com room blocks can never create a first-room-only reservation", () => {
	const normalized = extractNormalizedReservation({
		from: "Trip.com <ebooking@trip.com>",
		subject: "Booking no. # 1167731616604826 #",
		text: [
			"Booking no. # 1167731616604826 #",
			"Zad Ajyad Hotel",
			"Guest Name:",
			"Synthetic Multi Room Guest",
			"Staying period: Aug 5, 2026 - Aug 6, 2026 | 1 night",
			"Room Type: Comfort Double Room - Room Only | 1 room(s)",
			"Room Type: Triple Room - Room Only | 1 room(s)",
			"Guests (estimated): 5 adults, 0 children",
			"Payment information",
			"Net rate | Prepaid | monthly settlement",
			"Room rate 1 room(s) x 1 night(s)",
			"Final room rate (incl. taxes and fees) USD 40.00",
			"Your payout USD 36.00",
			"Room ratePrice details",
		].join("\n"),
	});

	assert.equal(normalized.requiresManualReview, true);
	assert.equal(normalized.ambiguousMultiRoomEvidence, true);
	assert.equal(normalized.blocksUnmappedReservationCreation, true);
	assert.match(normalized.manualReviewReasons.join(" "), /multiple distinct room blocks/i);
	assert.equal(canCreateUnmappedOtaReviewReservation(normalized, true), false);
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

test("incidental OTA names in authenticated HotelRunner guest prose never change identity or booking source", () => {
	for (const otaName of [
		"Agoda",
		"Booking.com",
		"Expedia",
		"Trip.com",
		"Airbnb",
		"Hotels.com",
	]) {
		const normalized = extractNormalizedReservation({
			from: '"HotelRunner" <noreply@hotelrunner.com>',
			subject: "Example Hotel - New Reservation",
			text: [
				"Confirmation Number 44556671",
				"Hotel Name Example Hotel",
				"Room Type Double Room",
				"Check-in Date Aug 10, 2026",
				"Check-out Date Aug 11, 2026",
				"Guest Name Example Guest",
				"Order Total SAR 100",
				`Guest note: please compare the public ${otaName} price before replying.`,
			].join("\n"),
			senderAuthentication: {
				authenticatedAligned: true,
				trustedProvider: "hotelrunner",
			},
		});

		assert.equal(normalized.provider, "hotelrunner", otaName);
		assert.equal(normalized.bookingSource, "HotelRunner", otaName);
		assert.deepEqual(normalized.hotelRunnerCommercialSourceProviders, [], otaName);
		assert.equal(normalized.hotelRunnerBookingSourceConflict, false, otaName);
		assert.equal(normalized.requiresManualReview, false, otaName);
	}
});

test("standalone OTA names inside bounded HotelRunner note blocks are never commercial-source evidence", () => {
	for (const [noteLabel, otaName] of [
		["Guest note", "Agoda"],
		["Notes", "Booking.com"],
		["Comment", "Expedia"],
		["Special request", "Trip.com"],
		["Guest request", "Airbnb"],
		["Remarks", "Hotels.com"],
	]) {
		const normalized = extractNormalizedReservation({
			from: '"HotelRunner" <noreply@hotelrunner.com>',
			subject: "Example Hotel - New Reservation",
			text: [
				"Confirmation Number 4455667101",
				"Hotel Name Example Hotel",
				"Room Type Double Room",
				"Check-in Date Aug 10, 2026",
				"Check-out Date Aug 11, 2026",
				"Guest Name Example Guest",
				"Order Total SAR 100",
				`${noteLabel}:`,
				otaName,
				"Please compare the public rate before replying.",
			].join("\n"),
			senderAuthentication: {
				authenticatedAligned: true,
				trustedProvider: "hotelrunner",
			},
		});

		assert.equal(normalized.provider, "hotelrunner", `${noteLabel}: ${otaName}`);
		assert.equal(
			normalized.bookingSource,
			"HotelRunner",
			`${noteLabel}: ${otaName}`
		);
		assert.deepEqual(
			normalized.hotelRunnerCommercialSourceProviders,
			[],
			`${noteLabel}: ${otaName}`
		);
		assert.equal(
			normalized.hotelRunnerBookingSourceConflict,
			false,
			`${noteLabel}: ${otaName}`
		);
		assert.equal(normalized.requiresManualReview, false, `${noteLabel}: ${otaName}`);
	}

	const genuineHeadingBeforeNote = extractNormalizedReservation({
		from: '"HotelRunner" <noreply@hotelrunner.com>',
		subject: "Example Hotel - New Reservation",
		text: [
			"AGODA (RETAIL)",
			"Confirmation Number 4455667102",
			"Hotel Name Example Hotel",
			"Room Type Double Room",
			"Check-in Date Aug 10, 2026",
			"Check-out Date Aug 11, 2026",
			"Guest Name Example Guest",
			"Order Total SAR 100",
			"Guest note:",
			"Booking.com",
		].join("\n"),
	});
	assert.equal(genuineHeadingBeforeNote.provider, "agoda");
	assert.equal(genuineHeadingBeforeNote.bookingSource, "Agoda");
	assert.deepEqual(genuineHeadingBeforeNote.hotelRunnerCommercialSourceProviders, [
		"agoda",
	]);

	const genuinePaymentAfterNote = extractNormalizedReservation({
		from: '"HotelRunner" <noreply@hotelrunner.com>',
		subject: "Example Hotel - New Reservation",
		text: [
			"Confirmation Number 4455667103",
			"Hotel Name Example Hotel",
			"Room Type Double Room",
			"Check-in Date Aug 10, 2026",
			"Check-out Date Aug 11, 2026",
			"Guest Name Example Guest",
			"Order Total SAR 100",
			"Special request:",
			"Trip.com",
			"",
			"Payment Method: Expedia Collect",
		].join("\n"),
	});
	assert.equal(genuinePaymentAfterNote.provider, "expedia");
	assert.equal(genuinePaymentAfterNote.bookingSource, "Expedia");
	assert.deepEqual(genuinePaymentAfterNote.hotelRunnerCommercialSourceProviders, [
		"expedia",
	]);

	const paymentSignatureInsideNote = extractNormalizedReservation({
		from: '"HotelRunner" <noreply@hotelrunner.com>',
		subject: "Example Hotel - New Reservation",
		text: [
			"Confirmation Number 4455667106",
			"Hotel Name Example Hotel",
			"Room Type Double Room",
			"Check-in Date Aug 10, 2026",
			"Check-out Date Aug 11, 2026",
			"Guest Name Example Guest",
			"Order Total SAR 100",
			"Guest note:",
			"Payment Method: Expedia Collect",
			"This is only a guest-entered comment.",
		].join("\n"),
	});
	assert.equal(paymentSignatureInsideNote.provider, "hotelrunner");
	assert.equal(paymentSignatureInsideNote.bookingSource, "HotelRunner");
	assert.deepEqual(paymentSignatureInsideNote.hotelRunnerCommercialSourceProviders, []);

	for (const noteSourceLine of ["Booking Source: Agoda", "Source: Agoda"]) {
		const explicitLookingNote = extractNormalizedReservation({
			from: '"HotelRunner" <noreply@hotelrunner.com>',
			subject: "Example Hotel - New Reservation",
			text: [
				"Confirmation Number 4455667104",
				"Hotel Name Example Hotel",
				"Room Type Double Room",
				"Check-in Date Aug 10, 2026",
				"Check-out Date Aug 11, 2026",
				"Guest Name Example Guest",
				"Order Total SAR 100",
				"Guest note:",
				noteSourceLine,
				"Please compare this channel rate.",
			].join("\n"),
		});
		assert.equal(explicitLookingNote.provider, "hotelrunner", noteSourceLine);
		assert.equal(explicitLookingNote.bookingSource, "HotelRunner", noteSourceLine);
		assert.deepEqual(
			explicitLookingNote.hotelRunnerCommercialSourceProviders,
			[],
			noteSourceLine
		);
	}

	const genuineExplicitOutsideNote = extractNormalizedReservation({
		from: '"HotelRunner" <noreply@hotelrunner.com>',
		subject: "Example Hotel - New Reservation",
		text: [
			"Booking Source: Expedia",
			"Confirmation Number 4455667105",
			"Hotel Name Example Hotel",
			"Room Type Double Room",
			"Check-in Date Aug 10, 2026",
			"Check-out Date Aug 11, 2026",
			"Guest Name Example Guest",
			"Order Total SAR 100",
			"Special request:",
			"Source: Agoda",
		].join("\n"),
	});
	assert.equal(genuineExplicitOutsideNote.provider, "expedia");
	assert.equal(genuineExplicitOutsideNote.bookingSource, "Expedia");
	assert.deepEqual(genuineExplicitOutsideNote.hotelRunnerCommercialSourceProviders, [
		"expedia",
	]);
});

test("unique strong HotelRunner template signatures select each genuine commercial source", () => {
	for (const sample of [
		{ heading: "AGODA (RETAIL)", provider: "agoda", source: "Agoda" },
		{ heading: "BOOKING.COM", provider: "booking", source: "Booking.com" },
		{
			heading: "EXPEDIA (EXPEDIA AFFILIATE NETWORK)",
			provider: "expedia",
			source: "Expedia",
		},
		{ heading: "TRIP.COM V2", provider: "hotelrunner", commercial: "trip", source: "Trip.com" },
		{ heading: "AIRBNB", provider: "airbnb", source: "Airbnb" },
		{ heading: "HOTELS.COM", provider: "hotels", source: "Hotels.com" },
	]) {
		const normalized = extractNormalizedReservation({
			from: '"HotelRunner" <noreply@hotelrunner.com>',
			subject: "Example Hotel - New Reservation",
			text: [
				sample.heading,
				"Confirmation Number 4455667201",
				"Hotel Name Example Hotel",
				"Room Type Double Room",
				"Check-in Date Aug 10, 2026",
				"Check-out Date Aug 11, 2026",
				"Guest Name Example Guest",
				"Order Total SAR 100",
			].join("\n"),
			senderAuthentication: {
				authenticatedAligned: true,
				trustedProvider: "hotelrunner",
			},
		});

		assert.equal(normalized.provider, sample.provider, sample.heading);
		assert.equal(normalized.bookingSource, sample.source, sample.heading);
		assert.deepEqual(
			normalized.hotelRunnerCommercialSourceProviders,
			[sample.commercial || sample.provider],
			sample.heading
		);
		assert.equal(normalized.hotelRunnerBookingSourceConflict, false, sample.heading);
		assert.equal(normalized.sourcePresence.bookingSource, true, sample.heading);
	}

	const explicitField = extractNormalizedReservation({
		from: '"HotelRunner" <noreply@hotelrunner.com>',
		subject: "Example Hotel - New Reservation",
		text: [
			"Booking Source: Expedia",
			"Confirmation Number 44556673",
			"Hotel Name Example Hotel",
			"Room Type Double Room",
			"Check-in Date Aug 10, 2026",
			"Check-out Date Aug 11, 2026",
			"Guest Name Example Guest",
			"Order Total SAR 100",
		].join("\n"),
		senderAuthentication: {
			authenticatedAligned: true,
			trustedProvider: "hotelrunner",
		},
	});
	assert.equal(explicitField.provider, "expedia");
	assert.equal(explicitField.bookingSource, "Expedia");
	assert.deepEqual(explicitField.hotelRunnerCommercialSourceProviders, ["expedia"]);

	const explicitTripField = extractNormalizedReservation({
		from: '"HotelRunner" <noreply@hotelrunner.com>',
		subject: "Example Hotel - New Reservation",
		text: [
			"Booking Source: Trip.com",
			"Confirmation Number 1651516732",
			"Hotel Name Example Hotel",
			"Room Type Double Room",
			"Check-in Date Aug 10, 2026",
			"Check-out Date Aug 11, 2026",
			"Guest Name Example Guest",
			"Order Total SAR 100",
		].join("\n"),
		senderAuthentication: {
			authenticatedAligned: true,
			trustedProvider: "hotelrunner",
		},
	});
	assert.equal(explicitTripField.provider, "hotelrunner");
	assert.equal(explicitTripField.bookingSource, "Trip.com");
	assert.equal(explicitTripField.hotelRunnerTripRelayEvidence, true);
	assert.equal(explicitTripField.hotelRunnerTripRelayIdentityValidated, true);
	assert.equal(buildOtaCrossTransportIdentityKey(explicitTripField), "trip:1651516732");
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
		assert.equal(result.status, "hotelrunner_relay_audit_only");
		assert.equal(result.actionTaken, "skipped");
		assert.equal(result.skipReason, "hotelrunner_relay_audit_only");
	} finally {
		Reservations.find = originalReservationFind;
	}
});

test("mapper entry point keeps every authenticated HotelRunner transport audit-only before FX or database work", async () => {
	const reservationMethods = [
		"find",
		"findOne",
		"findById",
		"create",
		"updateOne",
		"findOneAndUpdate",
		"bulkWrite",
		"exists",
	];
	const hotelMethods = ["find", "findOne", "findById"];
	const originalReservationMethods = Object.fromEntries(
		reservationMethods.map((method) => [method, Reservations[method]])
	);
	const originalHotelMethods = Object.fromEntries(
		hotelMethods.map((method) => [method, HotelDetails[method]])
	);
	let databaseCalls = 0;
	let exchangeCalls = 0;
	const unexpectedDatabaseCall = () => {
		databaseCalls += 1;
		throw new Error("HotelRunner relay guard must stop before database work");
	};
	for (const method of reservationMethods) {
		Reservations[method] = unexpectedDatabaseCall;
	}
	for (const method of hotelMethods) HotelDetails[method] = unexpectedDatabaseCall;

	const base = {
		inboundEmailId: "hotelrunner-relay-audit-boundary",
		provider: "agoda",
		providerLabel: "Agoda",
		bookingSource: "Agoda",
		confirmationNumber: "relay-boundary-123456",
		reservationId: "relay-boundary-123456",
		amount: 100,
		sourceAmount: 100,
		sourceCurrency: "USD",
		currency: "USD",
		roomCount: MAX_OTA_INBOUND_ROOM_COUNT + 1,
		sourceSenderTrusted: true,
		sourceSenderAuthenticated: true,
		trustedTransportProvider: "hotelrunner",
		senderAuthentication: {
			authenticatedAligned: true,
			trustedProvider: "hotelrunner",
		},
		source: {
			from: "HotelRunner <noreply@hotelrunner.com>",
			subject: "Agoda reservation relayed by HotelRunner",
			messageId: "relay-boundary@hotelrunner.com",
		},
		warnings: ["preserved relay warning"],
		errors: [],
	};
	const sarConversionOptions = {
		apiKey: "must-not-be-used",
		fetchImpl: async () => {
			exchangeCalls += 1;
			throw new Error("HotelRunner relay guard must stop before exchange lookup");
		},
	};

	try {
		for (const [name, lifecycle] of [
			["new", { intent: "new_reservation", eventType: "new" }],
			["not reservation", { intent: "not_reservation", eventType: "unknown" }],
			[
				"cancelled",
				{
					intent: "reservation_status",
					eventType: "cancelled",
					statusToApply: "cancelled",
				},
			],
			[
				"status",
				{
					intent: "reservation_status",
					eventType: "status",
					statusToApply: "confirmed",
				},
			],
		]) {
			const result = await reconcileOtaReservation(
				{ ...base, ...lifecycle },
				{ sarConversionOptions }
			);
			assert.equal(result.status, "hotelrunner_relay_audit_only", name);
			assert.equal(result.actionTaken, "skipped", name);
			assert.equal(result.skipReason, "hotelrunner_relay_audit_only", name);
			assert.equal(result.reservationId, null, name);
			assert.equal(result.hotelId, null, name);
			assert.deepEqual(result.warnings, ["preserved relay warning"], name);
		}

		const scriptRelay = { ...base, intent: "new_reservation", eventType: "new" };
		delete scriptRelay.inboundEmailId;
		delete scriptRelay.source;
		const scriptResult = await reconcileOtaReservation(scriptRelay, {
			sarConversionOptions,
		});
		assert.equal(
			scriptResult.status,
			"hotelrunner_relay_audit_only",
			"manual/script callers cannot bypass the transport boundary by omitting email shape",
		);

		const directNonReservation = await reconcileOtaReservation({
			...base,
			provider: "agoda",
			trustedTransportProvider: "agoda",
			senderAuthentication: {
				authenticatedAligned: true,
				trustedProvider: "agoda",
			},
			intent: "not_reservation",
			eventType: "unknown",
			skipReason: "direct_non_reservation",
		});
		assert.equal(directNonReservation.status, "not_reservation");
		assert.equal(directNonReservation.skipReason, "direct_non_reservation");
	} finally {
		for (const [method, original] of Object.entries(
			originalReservationMethods
		)) {
			Reservations[method] = original;
		}
		for (const [method, original] of Object.entries(originalHotelMethods)) {
			HotelDetails[method] = original;
		}
	}

	assert.equal(exchangeCalls, 0);
	assert.equal(databaseCalls, 0);
});

test("HotelRunner non-Trip authoritative confirmation conflicts fail closed independent of order", async () => {
	const buildConflict = (confirmationNumbers) =>
		extractNormalizedReservation({
			from: '"HotelRunner" <noreply@hotelrunner.com>',
			subject: "Example Hotel - New Reservation",
			text: [
				"AGODA (RETAIL)",
				...confirmationNumbers.map(
					(value) => `Confirmation Number: ${value}`
				),
				"Hotel Name Example Hotel",
				"Room Type Double Room",
				"Check-in Date Aug 10, 2026",
				"Check-out Date Aug 11, 2026",
				"Guest Name Example Guest",
				"Order Total SAR 100",
			].join("\n"),
			senderAuthentication: {
				authenticatedAligned: true,
				trustedProvider: "hotelrunner",
			},
		});

	for (const values of [
		["2038704202", "2038703612"],
		["2038703612", "2038704202"],
	]) {
		const conflicting = buildConflict(values);
		assert.equal(conflicting.provider, "agoda");
		assert.equal(conflicting.confirmationNumber, "");
		assert.equal(conflicting.reservationId, "");
		assert.equal(conflicting.sourcePresence.confirmationNumber, false);
		assert.equal(conflicting.hotelRunnerNonTripIdentityConflict, true);
		assert.equal(conflicting.requiresManualReview, true);
		assert.equal(conflicting.blocksUnmappedReservationCreation, true);
		assert.match(
			conflicting.manualReviewReasons.join(" "),
			/multiple distinct values under authoritative confirmation labels/i
		);
	}

	const originals = Object.fromEntries(
		["find", "findOne", "create", "updateOne", "findOneAndUpdate", "bulkWrite"].map(
			(method) => [method, Reservations[method]]
		)
	);
	let databaseCallCount = 0;
	for (const method of Object.keys(originals)) {
		Reservations[method] = () => {
			databaseCallCount += 1;
			throw new Error(`database ${method} must not run for identity conflict`);
		};
	}
	try {
		const result = await reconcileOtaReservation(
			buildConflict(["2038704202", "2038703612"])
		);
		assert.equal(result.status, "hotelrunner_relay_audit_only");
		assert.equal(result.actionTaken, "skipped");
		assert.equal(result.skipReason, "hotelrunner_relay_audit_only");
		assert.equal(databaseCallCount, 0);
	} finally {
		for (const [method, original] of Object.entries(originals)) {
			Reservations[method] = original;
		}
	}
});

test("HotelRunner confirmation repeats and legitimate provider booking IDs remain valid", () => {
	const commonLines = [
		"Hotel Name Example Hotel",
		"Room Type Double Room",
		"Check-in Date Aug 10, 2026",
		"Check-out Date Aug 11, 2026",
		"Guest Name Example Guest",
		"Order Total SAR 100",
	];
	const repeated = extractNormalizedReservation({
		from: '"HotelRunner" <noreply@hotelrunner.com>',
		subject: "Example Hotel - New Reservation",
		text: [
			"AGODA (RETAIL)",
			"Confirmation Code: 2038704202",
			"Confirmation Code: 2038704202",
			...commonLines,
		].join("\n"),
	});
	assert.equal(repeated.confirmationNumber, "2038704202");
	assert.equal(repeated.hotelRunnerNonTripIdentityConflict, false);
	assert.equal(repeated.requiresManualReview, false);

	const wrapperAndProviderId = extractNormalizedReservation({
		from: '"HotelRunner" <noreply@hotelrunner.com>',
		subject: "Example Hotel - New Reservation",
		text: [
			"AGODA (RETAIL)",
			"Confirmation Number: HR12345",
			"Agoda Booking ID 2038703612",
			...commonLines,
		].join("\n"),
	});
	assert.equal(wrapperAndProviderId.confirmationNumber, "2038703612");
	assert.equal(wrapperAndProviderId.hotelRunnerNonTripIdentityConflict, false);
	assert.equal(wrapperAndProviderId.requiresManualReview, false);

	const providerIdOnly = extractNormalizedReservation({
		from: '"HotelRunner" <noreply@hotelrunner.com>',
		subject: "Example Hotel - New Reservation",
		text: ["BOOKING.COM", "Booking ID: 9988776655", ...commonLines].join(
			"\n"
		),
	});
	assert.equal(providerIdOnly.confirmationNumber, "9988776655");
	assert.equal(providerIdOnly.hotelRunnerNonTripIdentityConflict, false);
	assert.equal(providerIdOnly.requiresManualReview, false);
});

test("HotelRunner provider-specific Booking IDs are canonical only when uniquely consistent", async () => {
	const commonLines = [
		"Hotel Name Example Hotel",
		"Room Type Double Room",
		"Check-in Date Aug 10, 2026",
		"Check-out Date Aug 11, 2026",
		"Guest Name Example Guest",
		"Order Total SAR 100",
	];
	const build = ({
		heading = "AGODA (RETAIL)",
		providerIdLines = [],
		subject = "Example Hotel - New Reservation",
		html = "",
	} = {}) =>
		extractNormalizedReservation({
			from: '"HotelRunner" <noreply@hotelrunner.com>',
			subject,
			text: [
				heading,
				"Confirmation Number: HR12345",
				...providerIdLines,
				...commonLines,
			].join("\n"),
			html,
			senderAuthentication: {
				authenticatedAligned: true,
				trustedProvider: "hotelrunner",
			},
		});

	const agodaCanonical = build({
		providerIdLines: ["Agoda Booking ID 2038703612"],
	});
	assert.equal(agodaCanonical.confirmationNumber, "2038703612");
	assert.equal(agodaCanonical.hotelRunnerNonTripIdentityConflict, false);
	assert.equal(agodaCanonical.hotelRunnerProviderSpecificBookingIdConflict, false);

	const bookingCanonical = build({
		heading: "BOOKING.COM",
		providerIdLines: ["Booking.com Booking ID: 9988776655"],
	});
	assert.equal(bookingCanonical.provider, "booking");
	assert.equal(bookingCanonical.bookingSource, "Booking.com");
	assert.equal(bookingCanonical.confirmationNumber, "9988776655");
	assert.equal(bookingCanonical.hotelRunnerNonTripIdentityConflict, false);

	for (const providerSpecificOnly of [
		{
			line: "Agoda Booking ID 2038703612",
			bookingSource: "Agoda",
			confirmationNumber: "2038703612",
		},
		{
			line: "Booking.com Booking ID 9988776655",
			bookingSource: "Booking.com",
			confirmationNumber: "9988776655",
		},
		{
			line: "Expedia Booking ID 8877665544",
			bookingSource: "Expedia",
			confirmationNumber: "8877665544",
		},
		{
			line: "Trip.com Booking ID 7766554433",
			bookingSource: "Trip.com",
			confirmationNumber: "7766554433",
		},
		{
			line: "Airbnb Booking ID HMABCDE12",
			bookingSource: "Airbnb",
			confirmationNumber: "hmabcde12",
		},
		{
			line: "Hotels.com Booking ID 6655443322",
			bookingSource: "Hotels.com",
			confirmationNumber: "6655443322",
		},
	]) {
		const normalized = build({
			heading: "",
			providerIdLines: [providerSpecificOnly.line],
		});
		assert.equal(normalized.bookingSource, providerSpecificOnly.bookingSource);
		assert.equal(
			normalized.confirmationNumber,
			providerSpecificOnly.confirmationNumber
		);
		assert.equal(normalized.hotelRunnerBookingSourceConflict, false);
		assert.equal(normalized.hotelRunnerNonTripIdentityConflict, false);
		assert.equal(normalized.requiresManualReview, false);
	}

	const conflictingProviderSpecificSources = build({
		heading: "",
		providerIdLines: [
			"Agoda Booking ID 2038703612",
			"Expedia Booking ID 8877665544",
		],
	});
	assert.equal(conflictingProviderSpecificSources.bookingSource, "HotelRunner");
	assert.equal(
		conflictingProviderSpecificSources.hotelRunnerBookingSourceConflict,
		true
	);
	assert.equal(conflictingProviderSpecificSources.requiresManualReview, true);

	const equalDuplicatesAndMimeMirror = build({
		providerIdLines: [
			"Agoda Booking ID 2038703612",
			"Agoda Booking ID: 2038703612",
		],
		html: [
			"<p>AGODA (RETAIL)</p>",
			"<p>Confirmation Number: HR12345</p>",
			"<p>Agoda Booking ID 2038703612</p>",
		].join(""),
	});
	assert.equal(equalDuplicatesAndMimeMirror.confirmationNumber, "2038703612");
	assert.equal(equalDuplicatesAndMimeMirror.hotelRunnerNonTripIdentityConflict, false);
	assert.equal(
		equalDuplicatesAndMimeMirror.hotelRunnerProviderSpecificBookingIdConflict,
		false
	);

	const crossRepresentationConflict = build({
		providerIdLines: ["Agoda Booking ID 2038703612"],
		html: [
			"<p>AGODA (RETAIL)</p>",
			"<p>Confirmation Number: HR12345</p>",
			"<p>Agoda Booking ID 9999999999</p>",
		].join(""),
	});
	assert.equal(crossRepresentationConflict.confirmationNumber, "");
	assert.equal(
		crossRepresentationConflict.hotelRunnerProviderSpecificBookingIdConflict,
		true
	);
	assert.equal(crossRepresentationConflict.requiresManualReview, true);

	const providerIdInsideGuestNote = build({
		providerIdLines: [
			"Guest Notes:",
			"Agoda Booking ID 9999999999",
			"Please use the original OTA reference above.",
		],
	});
	assert.equal(providerIdInsideGuestNote.confirmationNumber, "hr12345");
	assert.equal(
		providerIdInsideGuestNote.hotelRunnerProviderSpecificBookingIdConflict,
		false
	);
	assert.equal(providerIdInsideGuestNote.requiresManualReview, false);

	const providerIdOnlyInsideGuestNote = build({
		heading: "",
		providerIdLines: [
			"Guest Notes:",
			"Agoda Booking ID 9999999999",
			"Please use the original OTA reference above.",
		],
	});
	assert.equal(providerIdOnlyInsideGuestNote.bookingSource, "HotelRunner");
	assert.equal(providerIdOnlyInsideGuestNote.confirmationNumber, "hr12345");
	assert.equal(providerIdOnlyInsideGuestNote.hotelRunnerBookingSourceConflict, false);
	assert.equal(providerIdOnlyInsideGuestNote.requiresManualReview, false);

	const providerIdAfterBoundedGuestNote = build({
		heading: "",
		providerIdLines: [
			"Guest Notes:",
			"Please prepare a quiet room.",
			"",
			"Agoda Booking ID 2038703612",
		],
	});
	assert.equal(providerIdAfterBoundedGuestNote.bookingSource, "Agoda");
	assert.equal(providerIdAfterBoundedGuestNote.confirmationNumber, "2038703612");
	assert.equal(providerIdAfterBoundedGuestNote.hotelRunnerBookingSourceConflict, false);
	assert.equal(providerIdAfterBoundedGuestNote.requiresManualReview, false);

	const providerIdAfterEmptyNoteAndBlank = build({
		heading: "",
		providerIdLines: [
			"Guest Notes:",
			"",
			"Agoda Booking ID 9999999999",
		],
	});
	assert.equal(providerIdAfterEmptyNoteAndBlank.bookingSource, "HotelRunner");
	assert.equal(providerIdAfterEmptyNoteAndBlank.confirmationNumber, "hr12345");
	assert.equal(providerIdAfterEmptyNoteAndBlank.hotelRunnerBookingSourceConflict, false);
	assert.equal(providerIdAfterEmptyNoteAndBlank.requiresManualReview, false);

	const confirmationInsideGuestNote = build({
		providerIdLines: [
			"Guest Notes:",
			"Confirmation Number: 9999999999",
			"Please keep the original confirmation above.",
		],
	});
	assert.equal(confirmationInsideGuestNote.confirmationNumber, "hr12345");
	assert.equal(confirmationInsideGuestNote.hotelRunnerNonTripIdentityConflict, false);
	assert.equal(confirmationInsideGuestNote.requiresManualReview, false);

	const genericEqualMimeMirror = extractNormalizedReservation({
		from: '"HotelRunner" <noreply@hotelrunner.com>',
		subject: "Example Hotel - New Reservation",
		text: [
			"AGODA (RETAIL)",
			"Confirmation Number: 2038703612",
			...commonLines,
		].join("\n"),
		html: [
			"<p>AGODA (RETAIL)</p>",
			"<p>Confirmation Number: 2038703612</p>",
		].join(""),
	});
	assert.equal(genericEqualMimeMirror.confirmationNumber, "2038703612");
	assert.equal(genericEqualMimeMirror.hotelRunnerNonTripIdentityConflict, false);

	const genericCrossMimeConflict = extractNormalizedReservation({
		from: '"HotelRunner" <noreply@hotelrunner.com>',
		subject: "Example Hotel - New Reservation",
		text: [
			"AGODA (RETAIL)",
			"Confirmation Number: 2038703612",
			...commonLines,
		].join("\n"),
		html: [
			"<p>AGODA (RETAIL)</p>",
			"<p>Confirmation Number: 2038704202</p>",
		].join(""),
	});
	assert.equal(genericCrossMimeConflict.confirmationNumber, "");
	assert.equal(genericCrossMimeConflict.hotelRunnerNonTripIdentityConflict, true);
	assert.equal(genericCrossMimeConflict.requiresManualReview, true);

	const wrapperOnly = build();
	assert.equal(wrapperOnly.confirmationNumber, "hr12345");
	assert.equal(wrapperOnly.hotelRunnerNonTripIdentityConflict, false);

	const conflicting = build({
		providerIdLines: [
			"Agoda Booking ID 9999999999",
			"Agoda Booking ID 2038703612",
		],
	});
	assert.equal(conflicting.confirmationNumber, "");
	assert.equal(conflicting.reservationId, "");
	assert.equal(conflicting.sourcePresence.confirmationNumber, false);
	assert.equal(conflicting.hotelRunnerProviderSpecificBookingIdConflict, true);
	assert.equal(conflicting.hotelRunnerNonTripIdentityConflict, true);
	assert.equal(conflicting.requiresManualReview, true);
	assert.equal(conflicting.blocksUnmappedReservationCreation, true);
	assert.match(
		conflicting.manualReviewReasons.join(" "),
		/provider-specific Booking ID label/i
	);

	const originals = Object.fromEntries(
		["find", "findOne", "create", "updateOne", "findOneAndUpdate", "bulkWrite"].map(
			(method) => [method, Reservations[method]]
		)
	);
	let databaseCallCount = 0;
	for (const method of Object.keys(originals)) {
		Reservations[method] = () => {
			databaseCallCount += 1;
			throw new Error(`database ${method} must not run for booking-ID conflict`);
		};
	}
	try {
		const cancellationConflict = build({
			subject: "Example Hotel - Reservation Cancelled",
			providerIdLines: [
				"Agoda Booking ID 9999999999",
				"Agoda Booking ID 2038703612",
			],
		});
		assert.equal(cancellationConflict.eventType, "cancelled");
		const result = await reconcileOtaReservation(cancellationConflict);
		assert.equal(result.status, "hotelrunner_relay_audit_only");
		assert.equal(result.actionTaken, "skipped");
		assert.equal(result.skipReason, "hotelrunner_relay_audit_only");
		assert.equal(databaseCallCount, 0);
	} finally {
		for (const [method, original] of Object.entries(originals)) {
			Reservations[method] = original;
		}
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

const CANCELLATION_OVERRIDE_OTA_NUMBER = "4455667788";

const makeCancellationOverrideExisting = (status, overrides = {}) => ({
	_id: `cancellation-override-${status}`,
	__v: 7,
	updatedAt: new Date("2026-08-04T12:00:00.000Z"),
	hotelId: "hotel-a",
	confirmation_number: "9000000004",
	otaIdentityKey: `booking:${CANCELLATION_OVERRIDE_OTA_NUMBER}`,
	reservation_id: CANCELLATION_OVERRIDE_OTA_NUMBER,
	booking_source: "Booking.com",
	...overrides,
	customer_details: {
		confirmation_number2: CANCELLATION_OVERRIDE_OTA_NUMBER,
		booking_source: "Booking.com",
		...(overrides.customer_details || {}),
	},
	supplierData: {
		otaProvider: "booking",
		supplierName: "Booking.com",
		suppliedBookingNo: CANCELLATION_OVERRIDE_OTA_NUMBER,
		otaConfirmationNumber: CANCELLATION_OVERRIDE_OTA_NUMBER,
		platformConfirmationNumber: CANCELLATION_OVERRIDE_OTA_NUMBER,
		otaLastSourceReceivedAt: "2026-08-04T10:00:00.000Z",
		...(overrides.supplierData || {}),
	},
	otaPlatformReview: {
		provider: "booking",
		confirmationNumber: CANCELLATION_OVERRIDE_OTA_NUMBER,
		...(overrides.otaPlatformReview || {}),
	},
	state: status,
	reservation_status: status,
});

const makeTrustedInboundCancellation = (overrides = {}) => {
	const normalized = {
		inboundEmailId: "inbound-cancellation-override",
		provider: "booking",
		providerLabel: "Booking.com",
		confirmationNumber: CANCELLATION_OVERRIDE_OTA_NUMBER,
		reservationId: CANCELLATION_OVERRIDE_OTA_NUMBER,
		intent: "reservation_status",
		eventType: "cancelled",
		statusToApply: "cancelled",
		sourceSenderTrusted: true,
		sourceSenderAuthenticated: true,
		sourcePresence: { confirmationNumber: true, reservationId: true },
		source: {
			from: "Booking.com <noreply@booking.com>",
			subject: "Reservation cancelled",
			messageId: "cancellation-override-message",
			receivedAt: "2026-08-04T11:00:00.000Z",
			timestampMethod: "rfc2822_date_header",
		},
		...overrides,
	};
	normalized.sourcePresence = {
		confirmationNumber: true,
		reservationId: true,
		...(overrides.sourcePresence || {}),
	};
	normalized.source = {
		from: "Booking.com <noreply@booking.com>",
		subject: "Reservation cancelled",
		messageId: "cancellation-override-message",
		receivedAt: "2026-08-04T11:00:00.000Z",
		timestampMethod: "rfc2822_date_header",
		...(overrides.source || {}),
	};
	return normalized;
};

test("authenticated source-backed email cancellations override every PMS lifecycle status without commercial mutation", async () => {
	const originalReservationFind = Reservations.find;
	const originalReservationUpdateOne = Reservations.updateOne;
	let existing;
	const writes = [];
	Reservations.find = () => ({
		limit() {
			return this;
		},
		async exec() {
			return [existing];
		},
	});
	Reservations.updateOne = async (filter, update) => {
		writes.push({ filter, update });
		return { matchedCount: 1 };
	};

	try {
		for (const currentStatus of [
			"confirmed",
			"inhouse",
			"no_show",
			"checked_out",
			"OTA Platform Review",
			"custom_manual_hold",
		]) {
			existing = makeCancellationOverrideExisting(currentStatus, {
				total_amount: 321,
				total_amount_per_night: 321,
				room_prices: [{ date: "2026-08-10", price: 321 }],
				payment: "cash",
				payment_status: "paid",
				paid_amount: 321,
				financial_status: "closed",
				adminPricing: { guestTotal: 321, netAfterExpensesTotal: 280 },
				ota_financial_summary: { guestTotal: 321, payoutTotal: 280 },
			});
			const result = await reconcileOtaReservation(
				makeTrustedInboundCancellation({
					amount: 999,
					currency: "SAR",
					totalAmountSar: 999,
					paymentCollectionModel: "hotel_collect",
					sourcePresence: {
						confirmationNumber: true,
						reservationId: true,
						amount: true,
						paymentCollectionModel: true,
					},
				})
			);
			assert.equal(result.status, "cancelled", currentStatus);
			const { filter, update } = writes.at(-1);
			assert.equal(filter._id, existing._id, currentStatus);
			assert.equal(filter.__v, 7, currentStatus);
			assert.equal(filter.updatedAt, existing.updatedAt, currentStatus);
			assert.equal(update.$inc.__v, 1, currentStatus);
			assert.equal(update.$set.state, "cancelled", currentStatus);
			assert.equal(update.$set.reservation_status, "cancelled", currentStatus);
			assert.equal(
				update.$set["supplierData.otaLastSourceReceivedAt"].toISOString(),
				"2026-08-04T11:00:00.000Z",
				currentStatus
			);
			for (const protectedPath of [
				"total_amount",
				"total_amount_per_night",
				"room_prices",
				"payment",
				"payment_status",
				"paid_amount",
				"financial_status",
				"adminPricing",
				"ota_financial_summary",
				"supplierData.otaAmount",
				"supplierData.otaAmountSar",
				"supplierData.otaPaymentCollectionModel",
			]) {
				assert.equal(
					Object.prototype.hasOwnProperty.call(update.$set, protectedPath),
					false,
					`${currentStatus}: ${protectedPath}`
				);
			}
		}
	} finally {
		Reservations.find = originalReservationFind;
		Reservations.updateOne = originalReservationUpdateOne;
	}
	assert.equal(writes.length, 6);
});

test("trusted cancellations bypass only room/pricing parser ambiguity and still make a status-only write", async () => {
	const originalReservationFind = Reservations.find;
	const originalReservationUpdateOne = Reservations.updateOne;
	const existing = makeCancellationOverrideExisting("checked_out", {
		total_rooms: 2,
		roomId: ["double-room", "triple-room"],
		pickedRoomsType: [{ roomType: "doubleRooms" }, { roomType: "tripleRooms" }],
		total_amount: 420,
		room_prices: [{ date: "2026-08-10", price: 420 }],
		payment: "cash",
		financeStatus: "finance hold",
	});
	let captured = null;
	Reservations.find = () => ({
		limit() {
			return this;
		},
		async exec() {
			return [existing];
		},
	});
	Reservations.updateOne = async (filter, update) => {
		captured = { filter, update };
		return { matchedCount: 1 };
	};

	try {
		const result = await reconcileOtaReservation(
			makeTrustedInboundCancellation({
				requiresManualReview: true,
				ambiguousMultiRoomEvidence: true,
				blocksUnmappedReservationCreation: true,
				manualReviewReasons: [
					"HotelRunner email contains 2 room blocks in one message representation; automatic partial-room creation is disabled.",
				],
				roomName: "Double Room",
				roomCount: 1,
				totalGuests: 2,
				amount: 999,
				totalAmountSar: 999,
				paymentCollectionModel: "ota_collect",
				sourcePresence: {
					confirmationNumber: true,
					reservationId: true,
					roomName: true,
					roomCount: true,
					totalGuests: true,
					amount: true,
					paymentCollectionModel: true,
				},
			})
		);
		assert.equal(result.status, "cancelled");
		assert.ok(captured);
		assert.equal(captured.update.$set.state, "cancelled");
		assert.equal(captured.update.$set.reservation_status, "cancelled");
		for (const protectedPath of [
			"total_rooms",
			"roomId",
			"pickedRoomsType",
			"total_amount",
			"room_prices",
			"payment",
			"financeStatus",
			"supplierData.otaRoomName",
			"supplierData.otaRoomCount",
			"supplierData.otaAmount",
			"supplierData.otaAmountSar",
			"supplierData.otaPaymentCollectionModel",
		]) {
			assert.equal(
				Object.prototype.hasOwnProperty.call(captured.update.$set, protectedPath),
				false,
				protectedPath
			);
		}
	} finally {
		Reservations.find = originalReservationFind;
		Reservations.updateOne = originalReservationUpdateOne;
	}
});

test("cancellation parser bypass remains closed for provider and confirmation identity conflicts", async () => {
	const originalReservationFind = Reservations.find;
	const originalReservationUpdateOne = Reservations.updateOne;
	let lookupCalls = 0;
	let mutationCalls = 0;
	Reservations.find = () => {
		lookupCalls += 1;
		throw new Error("identity-conflicted cancellation must not query reservations");
	};
	Reservations.updateOne = async () => {
		mutationCalls += 1;
		throw new Error("identity-conflicted cancellation must not mutate");
	};

	try {
		for (const manualReviewReasons of [
			[
				"HotelRunner relay contains conflicting commercial booking-source evidence (Expedia, Agoda); automatic reservation lookup and mutation are disabled.",
			],
			[
				"OTA email contains conflicting explicit confirmation, booking, or reservation numbers; automatic identity selection and mutation are disabled.",
			],
		]) {
			const result = await reconcileOtaReservation(
				makeTrustedInboundCancellation({
					requiresManualReview: true,
					manualReviewReasons,
				})
			);
			assert.equal(result.status, "needs_review");
			assert.equal(result.actionTaken, "skipped");
			assert.equal(result.skipReason, "ota_parser_requires_manual_review");
		}
	} finally {
		Reservations.find = originalReservationFind;
		Reservations.updateOne = originalReservationUpdateOne;
	}
	assert.equal(lookupCalls, 0);
	assert.equal(mutationCalls, 0);
});

test("HotelRunner lifecycle transport cannot replace the existing OTA commercial source", () => {
	const existing = makeCancellationOverrideExisting("inhouse", {
		booking_source: "airbnb",
		customer_details: {
			booking_source: "airbnb",
		},
		supplierData: {
			otaProvider: "airbnb",
			supplierName: "Airbnb",
		},
		otaPlatformReview: {
			provider: "airbnb",
			providerLabel: "Airbnb",
		},
	});
	const set = buildExistingReservationUpdateSet({
		normalized: makeTrustedInboundCancellation({
			provider: "airbnb",
			providerLabel: "Airbnb",
			bookingSource: "HotelRunner",
		}),
		existing,
		statusToApply: "cancelled",
	});

	assert.equal(set.booking_source, undefined);
	assert.equal(set["customer_details.booking_source"], undefined);
	assert.equal(set["supplierData.supplierName"], "Airbnb");
	assert.equal(set["otaPlatformReview.providerLabel"], undefined);
	assert.match(set.cancel_reason, /^Airbnb /);
});

test("OTA lifecycle and ordinary updates preserve unrelated supplier metadata", () => {
	for (const normalized of [
		{
			provider: "agoda",
			providerLabel: "Agoda",
			bookingSource: "Agoda",
			intent: "reservation_status",
			eventType: "cancelled",
			statusToApply: "cancelled",
			confirmationNumber: "SUPPLIER-CANCEL-1",
			sourcePresence: { bookingSource: true },
		},
		{
			provider: "agoda",
			providerLabel: "Agoda",
			bookingSource: "Agoda",
			intent: "reservation_update",
			eventType: "modified",
			confirmationNumber: "SUPPLIER-UPDATE-1",
			sourcePresence: { bookingSource: true },
		},
	]) {
		const set = buildExistingReservationUpdateSet({
			normalized,
			existing: {
				booking_source: "Agoda",
				customer_details: { booking_source: "Agoda" },
				supplierData: {
					otaProvider: "agoda",
					supplierName: "Bedbank Contract 17",
				},
				otaPlatformReview: { provider: "agoda" },
			},
			statusToApply: normalized.statusToApply || "",
		});
		assert.equal(
			set["supplierData.supplierName"],
			undefined,
			normalized.intent
		);
	}
});

test("supplier-name updates still fill blanks and normalize the same recognized OTA", () => {
	const normalized = {
		provider: "agoda",
		providerLabel: "Agoda",
		bookingSource: "Agoda",
		intent: "reservation_update",
		eventType: "modified",
		sourcePresence: { bookingSource: true },
	};
	for (const [supplierName, expected] of [
		["", "Agoda"],
		["AGODA partner account", "Agoda"],
		["Bedbank Contract 17", undefined],
	]) {
		const set = buildExistingReservationUpdateSet({
			normalized,
			existing: { supplierData: { supplierName } },
		});
		assert.equal(set["supplierData.supplierName"], expected, supplierName || "blank");
	}
});

test("cancellation ordering uses only the OTA watermark while keeping stale, equal, missing, and delivery-only timestamps blocked", async () => {
	const originalReservationFind = Reservations.find;
	const originalReservationUpdateOne = Reservations.updateOne;
	let mutationCalls = 0;
	const existing = makeCancellationOverrideExisting("inhouse");
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
		for (const [source, expectedReason] of [
			[
				{ receivedAt: "2026-08-04T09:59:59.000Z" },
				"stale_ota_lifecycle_event",
			],
			[
				{ receivedAt: "2026-08-04T10:00:00.000Z" },
				"stale_ota_lifecycle_event",
			],
			[{ receivedAt: undefined }, "ota_lifecycle_timestamp_missing"],
			[
				{
					receivedAt: "2026-08-04T11:00:00.000Z",
					timestampMethod: "sendgrid_webhook_received_at",
				},
				"ota_lifecycle_timestamp_missing",
			],
		]) {
			const result = await reconcileOtaReservation(
				makeTrustedInboundCancellation({ source })
			);
			assert.equal(result.status, "needs_review");
			assert.equal(result.actionTaken, "skipped");
			assert.equal(result.skipReason, expectedReason);
		}
	} finally {
		Reservations.find = originalReservationFind;
		Reservations.updateOne = originalReservationUpdateOne;
	}
	assert.equal(mutationCalls, 0);
});

test("a fresh OTA cancellation survives a newer manual updatedAt and retains the CAS snapshot", async () => {
	const originalReservationFind = Reservations.find;
	const originalReservationUpdateOne = Reservations.updateOne;
	const existing = makeCancellationOverrideExisting("checked_out", {
		updatedAt: new Date("2026-08-04T12:00:00.000Z"),
		supplierData: {
			otaLastSourceReceivedAt: "2026-08-04T10:00:00.000Z",
		},
	});
	let captured = null;
	Reservations.find = () => ({
		limit() {
			return this;
		},
		async exec() {
			return [existing];
		},
	});
	Reservations.updateOne = async (filter, update) => {
		captured = { filter, update };
		return { matchedCount: 1 };
	};

	try {
		const result = await reconcileOtaReservation(
			makeTrustedInboundCancellation({
				source: { receivedAt: "2026-08-04T11:00:00.000Z" },
			})
		);
		assert.equal(result.status, "cancelled");
		assert.equal(captured.filter.updatedAt, existing.updatedAt);
		assert.equal(captured.filter.__v, 7);
		assert.equal(
			captured.update.$set["supplierData.otaLastSourceReceivedAt"].toISOString(),
			"2026-08-04T11:00:00.000Z"
		);
	} finally {
		Reservations.find = originalReservationFind;
		Reservations.updateOne = originalReservationUpdateOne;
	}
});

test("forged, untrusted, and non-source-backed cancellation emails never reach reservation lookup", async () => {
	const originalReservationFind = Reservations.find;
	const originalReservationUpdateOne = Reservations.updateOne;
	let lookupCalls = 0;
	let mutationCalls = 0;
	Reservations.find = () => {
		lookupCalls += 1;
		throw new Error("unexpected reservation lookup");
	};
	Reservations.updateOne = async () => {
		mutationCalls += 1;
		throw new Error("unexpected reservation mutation");
	};

	try {
		const unauthenticated = await reconcileOtaReservation(
			makeTrustedInboundCancellation({ sourceSenderAuthenticated: false })
		);
		assert.equal(
			unauthenticated.skipReason,
			"unauthenticated_ota_sender_no_mutation"
		);

		const untrusted = await reconcileOtaReservation(
			makeTrustedInboundCancellation({ sourceSenderTrusted: false })
		);
		assert.equal(untrusted.skipReason, "untrusted_ota_sender_no_mutation");

		const notSourceBacked = await reconcileOtaReservation(
			makeTrustedInboundCancellation({
				sourcePresence: { confirmationNumber: false, reservationId: false },
			})
		);
		assert.equal(notSourceBacked.skipReason, "confirmation_not_source_backed");
	} finally {
		Reservations.find = originalReservationFind;
		Reservations.updateOne = originalReservationUpdateOne;
	}
	assert.equal(lookupCalls, 0);
	assert.equal(mutationCalls, 0);
});

test("the cancellation override preserves stay, hotel, and concurrent-write guards", async () => {
	const originalReservationFind = Reservations.find;
	const originalReservationUpdateOne = Reservations.updateOne;
	const originalHotelFind = HotelDetails.find;
	let existing;
	let mutationCalls = 0;
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
		return { matchedCount: 0 };
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
		existing = makeCancellationOverrideExisting("no_show", {
			checkin_date: "2026-08-10",
			checkout_date: "2026-08-12",
		});
		const stayConflict = await reconcileOtaReservation(
			makeTrustedInboundCancellation({
				checkinDate: "2026-08-11",
				checkoutDate: "2026-08-12",
				sourcePresence: {
					confirmationNumber: true,
					reservationId: true,
					checkinDate: true,
					checkoutDate: true,
				},
			})
		);
		assert.equal(
			stayConflict.skipReason,
			"terminal_ota_lifecycle_stay_dates_conflict"
		);

		existing = makeCancellationOverrideExisting("checked_out");
		const hotelConflict = await reconcileOtaReservation(
			makeTrustedInboundCancellation({
				hotelName: "Incoming Hotel",
				sourcePresence: {
					confirmationNumber: true,
					reservationId: true,
					hotelName: true,
				},
			})
		);
		assert.equal(
			hotelConflict.skipReason,
			"ota_incoming_hotel_conflicts_with_existing_reservation"
		);
		assert.equal(mutationCalls, 0);

		existing = makeCancellationOverrideExisting("inhouse");
		await assert.rejects(
			reconcileOtaReservation(makeTrustedInboundCancellation()),
			(error) => error?.code === "OTA_RESERVATION_CONCURRENT_CHANGE"
		);
		assert.equal(mutationCalls, 1);
	} finally {
		Reservations.find = originalReservationFind;
		Reservations.updateOne = originalReservationUpdateOne;
		HotelDetails.find = originalHotelFind;
	}
});

test("non-cancellation transitions and non-email sync cancellations retain the prior lifecycle blocks", async () => {
	const originalReservationFind = Reservations.find;
	const originalReservationUpdateOne = Reservations.updateOne;
	let existing;
	let mutationCalls = 0;
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
		existing = makeCancellationOverrideExisting("cancelled", {
			updatedAt: new Date("2026-08-04T10:00:00.000Z"),
		});
		const reopen = await reconcileOtaReservation(
			makeTrustedInboundCancellation({
				eventType: "status",
				statusToApply: "confirmed",
			})
		);
		assert.equal(
			reopen.skipReason,
			"terminal_ota_reservation_transition_blocked"
		);

		existing = makeCancellationOverrideExisting("inhouse", {
			updatedAt: new Date("2026-08-04T10:00:00.000Z"),
		});
		const noShow = await reconcileOtaReservation(
			makeTrustedInboundCancellation({
				eventType: "no_show",
				statusToApply: "no_show",
			})
		);
		assert.equal(noShow.skipReason, "inhouse_ota_status_regression_blocked");

		const nondeterministicCancellation = await reconcileOtaReservation(
			makeTrustedInboundCancellation({ eventType: "status" })
		);
		assert.equal(
			nondeterministicCancellation.skipReason,
			"inhouse_ota_status_regression_blocked"
		);

		existing = makeCancellationOverrideExisting("checked_out", {
			updatedAt: new Date("2026-08-04T10:00:00.000Z"),
		});
		const syncCancellation = await reconcileOtaReservation(
			makeTrustedInboundCancellation({
				inboundEmailId: "ota-sync:cancellation",
				source: { from: "expedia-sync" },
			})
		);
		assert.equal(
			syncCancellation.skipReason,
			"terminal_ota_reservation_transition_blocked"
		);
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

test("forwarded Expedia Partner Central bookings retain exact identity, stay, occupancy, and USD source pricing", () => {
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
	assert.equal(normalized.totalAmountSar, null);
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

test("HotelRunner Agoda VCC pricing retains reported amounts without assigning canonical commercial roles", () => {
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
	assert.equal(built.document.total_amount, null);
	assert.equal(built.document.sub_total, 75);
	assert.equal(built.document.adminPricing.clientTotal, null);
	assert.equal(built.document.adminPricing.rootTotal, 75);
	assert.equal(built.document.adminPricing.netAfterExpensesTotal, null);
	assert.equal(built.document.adminPricing.otaExpenseTotal, null);
	assert.equal(built.document.adminPricing.platformMarginTotal, null);
	assert.equal(built.document.adminPricing.defaultDeductionApplied, false);
	assert.equal(built.document.supplierData.otaSourceCurrency, "SAR");
	assert.equal(built.document.supplierData.otaSourceAmount, 44);
	assert.equal(built.document.supplierData.otaAmountSar, null);
	assert.equal(built.document.supplierData.otaCommercialEvidence, undefined);
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

test("PMS confirmation generation excludes every current OTA identity before querying uniqueness", async () => {
	const originalRandom = Math.random;
	const originalExists = Reservations.exists;
	const queriedCandidates = [];
	const randomForConfirmation = (value) =>
		(Number(value) - 1000000000 + 0.25) / 9000000000;
	const randomValues = [
		randomForConfirmation("2041108213"),
		randomForConfirmation("2207032113"),
	];

	Math.random = () => randomValues.shift();
	Reservations.exists = async ({ confirmation_number: candidate }) => {
		queriedCandidates.push(String(candidate));
		return false;
	};

	try {
		const generated = await generateUniquePmsConfirmationNumber(2, [
			"2041108213",
			"agoda:2041108213",
		]);
		assert.equal(generated, "2207032113");
		assert.deepEqual(
			queriedCandidates,
			["2207032113"],
			"an OTA-equal random candidate must be rejected before any database lookup"
		);
	} finally {
		Math.random = originalRandom;
		Reservations.exists = originalExists;
	}
});

test("PMS timestamp fallback skips an OTA equality and final reservation shape fails closed", async () => {
	const originalNow = Date.now;
	const originalExists = Reservations.exists;
	let existsCalls = 0;
	Date.now = () => 172041108213;
	Reservations.exists = async () => {
		existsCalls += 1;
		return false;
	};

	try {
		assert.equal(
			await generateUniquePmsConfirmationNumber(0, ["agoda:2041108213"]),
			"2041108214"
		);
		assert.equal(
			existsCalls,
			1,
			"an OTA-equal fallback must be skipped before querying the next candidate"
		);
	} finally {
		Date.now = originalNow;
		Reservations.exists = originalExists;
	}

	const productionShape = {
		confirmation_number: "2207032113",
		pms_number: "",
		reservation_id: "2041108213",
		otaIdentityKey: "agoda:2041108213",
		customer_details: { confirmation_number2: "2041108213" },
		supplierData: {
			pmsConfirmationNumber: "2207032113",
			otaConfirmationNumber: "2041108213",
			platformConfirmationNumber: "2041108213",
			otaNormalizedSnapshot: {
				confirmationNumber: "2041108213",
				reservationId: "2041108213",
			},
		},
	};
	assert.equal(assertReservationPmsConfirmationDistinct(productionShape), "2207032113");
	assert.throws(
		() =>
			assertReservationPmsConfirmationDistinct({
				...productionShape,
				confirmation_number: "2041108213",
				supplierData: {
					...productionShape.supplierData,
					pmsConfirmationNumber: "2041108213",
				},
			}),
		(error) => error?.code === "pms_confirmation_matches_external_ota"
	);
	assert.throws(
		() =>
			assertPmsConfirmationDistinctFromExternal("2041108213", [
				"agoda:2041108213",
			]),
		(error) => error?.code === "pms_confirmation_matches_external_ota"
	);
	for (const mismatched of [
		{ ...productionShape, pms_number: "9999999999" },
		{
			...productionShape,
			supplierData: {
				...productionShape.supplierData,
				pmsConfirmationNumber: "9999999999",
			},
		},
	]) {
		assert.throws(
			() => assertReservationPmsConfirmationDistinct(mismatched),
			(error) => error?.code === "pms_confirmation_mirror_mismatch"
		);
	}
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

test("OTA allocation resource ceilings accept normal and exact-boundary workloads only", () => {
	assert.deepEqual(
		otaInboundAllocationSafety({
			roomCount: 2,
			checkinDate: "2026-08-10",
			checkoutDate: "2026-08-12",
			sourcePresence: { roomCount: true },
		}),
		{ ok: true, roomCount: 2, stayNights: 2, roomNightSlots: 4 }
	);
	assert.equal(
		otaInboundAllocationSafety({
			roomCount: MAX_OTA_INBOUND_ROOM_COUNT,
			checkinDate: "2026-08-10",
			checkoutDate: "2026-08-11",
			sourcePresence: { roomCount: true },
		}).ok,
		true
	);
	const exactRoomNights = otaInboundAllocationSafety({
		roomCount: 100,
		checkinDate: "2026-01-01",
		checkoutDate: "2026-07-20",
		sourcePresence: { roomCount: true },
	});
	assert.equal(exactRoomNights.ok, true);
	assert.equal(
		exactRoomNights.roomNightSlots,
		MAX_OTA_INBOUND_ROOM_NIGHT_SLOTS
	);
	assert.equal(
		otaInboundAllocationSafety({
			roomCount: MAX_OTA_INBOUND_ROOM_COUNT + 1,
			checkinDate: "2026-08-10",
			checkoutDate: "2026-08-11",
			sourcePresence: { roomCount: true },
		}).reason,
		"room_count_resource_limit"
	);
	assert.equal(
		otaInboundAllocationSafety({
			roomCount: 100,
			checkinDate: "2026-01-01",
			checkoutDate: "2026-07-21",
			sourcePresence: { roomCount: true },
		}).reason,
		"room_night_resource_limit"
	);
	assert.equal(
		otaInboundAllocationSafety({
			roomCount: 0,
			checkinDate: "2026-08-10",
			checkoutDate: "2026-08-11",
			sourcePresence: { roomCount: true },
		}).reason,
		"invalid_room_count"
	);
});

test("oversized new OTA allocations stop before live conversion, lookup, AI, creation, or mutation", async () => {
	const originalReservationFind = Reservations.find;
	const originalReservationCreate = Reservations.create;
	const originalReservationUpdateOne = Reservations.updateOne;
	const originalHotelFind = HotelDetails.find;
	let reservationLookups = 0;
	let hotelLookups = 0;
	let writes = 0;
	Reservations.find = () => {
		reservationLookups += 1;
		throw new Error("oversized allocation must not query reservations");
	};
	Reservations.create = async () => {
		writes += 1;
		throw new Error("oversized allocation must not create a reservation");
	};
	Reservations.updateOne = async () => {
		writes += 1;
		throw new Error("oversized allocation must not mutate a reservation");
	};
	HotelDetails.find = () => {
		hotelLookups += 1;
		throw new Error("oversized allocation must not query hotels");
	};

	const normalized = {
		inboundEmailId: "allocation-limit-audit",
		provider: "agoda",
		providerLabel: "Agoda",
		bookingSource: "Agoda",
		confirmationNumber: "ALLOCATION-251",
		reservationId: "ALLOCATION-251",
		intent: "new_reservation",
		eventType: "new",
		guestName: "Resource Guard Guest",
		hotelName: "Zad Ajyad",
		roomName: "Double Room",
		checkinDate: "2026-08-10",
		checkoutDate: "2026-08-11",
		amount: 100,
		totalAmountSar: 100,
		currency: "ZZZ",
		roomCount: MAX_OTA_INBOUND_ROOM_COUNT + 1,
		totalGuests: 2,
		sourceSenderTrusted: true,
		sourceSenderAuthenticated: true,
		sourcePresence: {
			confirmationNumber: true,
			guestName: true,
			hotelName: true,
			roomName: true,
			checkinDate: true,
			checkoutDate: true,
			amount: true,
			roomCount: true,
		},
		source: {
			from: "Agoda <no-reply@agoda.com>",
			messageId: "allocation-limit-audit@example.com",
			receivedAt: "2026-08-05T12:00:00.000Z",
		},
	};

	try {
		const result = await reconcileOtaReservation(normalized);
		assert.equal(result.status, "needs_review");
		assert.equal(result.actionTaken, "skipped");
		assert.equal(result.skipReason, "ota_inbound_allocation_resource_limit");
		assert.equal(result.reservationId, null);
		assert.equal(
			result.errors.some((error) => /missing sar exchange rate/i.test(error)),
			false,
			"the preflight must return before applyLiveSarConversion"
		);
		assert.equal(reservationLookups, 0);
		assert.equal(hotelLookups, 0);
		assert.equal(writes, 0);

		const roomMatch = await resolveRoomMatchWithAi(
			{ roomCountDetails: HOTEL_ROOMS },
			normalized
		);
		assert.equal(roomMatch.roomDetails, null);
		assert.equal(roomMatch.matchType, "allocation_resource_limit");
		assert.equal(roomMatch.aiFallbackAllowed, false);
		assert.equal(roomMatch.aiRoomMatch.usedAI, false);
		assert.throws(
			() => buildUnmappedOtaReviewReservationDocument(normalized),
			(error) => error?.code === "OTA_INBOUND_ALLOCATION_RESOURCE_LIMIT"
		);
	} finally {
		Reservations.find = originalReservationFind;
		Reservations.create = originalReservationCreate;
		Reservations.updateOne = originalReservationUpdateOne;
		HotelDetails.find = originalHotelFind;
	}
});

test("orchestrator rejects a deterministic oversized allocation before live exchange lookup or extraction AI", async () => {
	const originalToken = process.env.CHATGPT_API_TOKEN;
	process.env.CHATGPT_API_TOKEN = "must-not-be-used-for-resource-preflight";
	const email = {
		from: '"HotelRunner" <noreply@hotelrunner.com>',
		subject: "Zad AJYAD Hotel - New Reservation #R123456789",
		text: [
			"Booking Source Agoda",
			"Confirmation Number 680785631",
			"Guest Name Resource Guard Guest",
			"Hotel Name Zad Ajyad",
			"Room Type",
			"Double Room",
			"Number of rooms",
			String(MAX_OTA_INBOUND_ROOM_COUNT + 1),
			"Check-in Date",
			"Aug 10, 2026",
			"Check-out Date",
			"Aug 11, 2026",
			"Guest Count",
			"2",
			"Total amount",
			"EUR 100",
		].join("\n"),
		senderAuthentication: {
			authenticatedAligned: true,
			trustedProvider: "hotelrunner",
			method: "dkim",
		},
	};

	try {
		const result = await orchestrateInboundReservationEmail(email);
		assert.equal(result.normalized.intent, "new_reservation");
		assert.equal(
			result.normalized.roomCount,
			MAX_OTA_INBOUND_ROOM_COUNT + 1
		);
		assert.equal(result.decision.usedAI, false);
		assert.equal(result.decision.skipped, true);
		assert.equal(
			result.decision.skipReason,
			"ota_inbound_allocation_resource_limit"
		);
		assert.match(
			result.decision.reason,
			/live exchange-rate lookup.*AI were skipped/i
		);
	} finally {
		if (originalToken === undefined) delete process.env.CHATGPT_API_TOKEN;
		else process.env.CHATGPT_API_TOKEN = originalToken;
	}
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

const authenticatedAgodaCommercialVoucher = ({
	bookingId,
	checkin,
	checkout,
	roomName,
	adults,
	nightly,
	gross,
	net,
	commission,
	growthProgram,
	taxOnCommission,
	authenticated = true,
}) => {
	const deductions = [
		commission === null ? "" : `Commission SAR -${commission}`,
		`Agoda Growth Program SAR -${growthProgram}`,
		`Tax on Commission SAR -${taxOnCommission}`,
		"Targeted promotions",
	]
		.filter(Boolean)
		.join(" ");
	return {
		from: '"agoda.com" <no-reply@agoda.com>',
		to: "reservations@example.com",
		subject: `Agoda Booking ID ${bookingId} - CONFIRMED Hotel Country: Saudi Arabia Check-in ${checkin} / Language_English`,
		messageId: `agoda-${bookingId}@mail.agoda.com`,
		sourceReceivedAt: "2026-08-07T10:00:00.000Z",
		senderAuthentication: authenticated
			? {
					authenticatedAligned: true,
					trustedProvider: "agoda",
					method: "dkim",
			  }
			: {},
		text: [
			`Booking ID ${bookingId} Reservation Information`,
			"PREPAID Booking confirmation",
			"Zad Ajyad",
			`Customer First Name SAFE Customer Last Name GUEST Country of Residence Saudi Arabia Check-in ${checkin} Check-out ${checkout} Other Guests [RmNo.1]`,
			`Room Type No. of Rooms Occupancy No. of Extra Bed ${roomName} 1 ${adults} Adults 0`,
			`From - To Rates ${nightly
				.map(([date, amount]) => `${date} SAR ${amount}`)
				.join(" ")} Reference sell rate (incl. taxes & fees) SAR ${gross} Compensation ${deductions}`,
			`Net rate (incl. taxes & fees) SAR ${net}`,
		].join("\n"),
	};
};

test("authenticated production Agoda vouchers preserve gross, net, named deductions, and exact nightly allocation", () => {
	const cases = [
		{
			bookingId: "687715051",
			checkin: "August 9, 2026",
			checkout: "August 11, 2026",
			roomName: "Quadruple Room",
			adults: 4,
			nightly: [
				["August 9, 2026", "53.37"],
				["August 10, 2026", "53.37"],
			],
			gross: "172.48",
			net: "106.74",
			commission: "25.88",
			growthProgram: "17.24",
			taxOnCommission: "6.46",
			expectedDates: ["2026-08-09", "2026-08-11"],
			expectedNightlyGross: [86.24, 86.24],
			expectedNightlyNet: [53.37, 53.37],
			expectedExpense: 65.74,
			expectedCommission: 25.88,
			expectedComponents: [25.88, 17.24, 6.46],
			expectedUnclassified: 16.16,
		},
		{
			bookingId: "687702587",
			checkin: "August 8, 2026",
			checkout: "August 9, 2026",
			roomName: "Triple Room",
			adults: 3,
			nightly: [["August 8, 2026", "49.50"]],
			gross: "80.00",
			net: "49.50",
			commission: "12.00",
			growthProgram: "8.00",
			taxOnCommission: "3.00",
			expectedDates: ["2026-08-08", "2026-08-09"],
			expectedNightlyGross: [80],
			expectedNightlyNet: [49.5],
			expectedExpense: 30.5,
			expectedCommission: 12,
			expectedComponents: [12, 8, 3],
			expectedUnclassified: 7.5,
		},
	];

	for (const fixture of cases) {
		const normalized = {
			...extractNormalizedReservation(
				authenticatedAgodaCommercialVoucher(fixture)
			),
			inboundEmailId: `audit-${fixture.bookingId}`,
		};
		assert.equal(normalized.confirmationNumber, fixture.bookingId);
		assert.deepEqual(
			[normalized.checkinDate, normalized.checkoutDate],
			fixture.expectedDates
		);
		assert.equal(normalized.requiresManualReview, false);
		assert.equal(normalized.totalAmountSar, Number(fixture.gross));
		assert.equal(normalized.totalPayoutSar, Number(fixture.net));
		assert.equal(normalized.otaCommissionSar, fixture.expectedCommission);
		assert.deepEqual(
			normalized.otaDeductionComponents.map((component) => component.amountSar),
			fixture.expectedComponents
		);
		assert.deepEqual(
			normalized.nightlyPricingSar.map((row) => row.clientAmountSar),
			fixture.expectedNightlyGross
		);
		assert.deepEqual(
			normalized.nightlyPricingSar.map((row) => row.payoutAmountSar),
			fixture.expectedNightlyNet
		);

		const evidence = buildHotelRunnerEmailCommercialEvidence(normalized, {
			appliedAt: new Date("2026-08-08T00:00:00.000Z"),
		});
		assert.equal(evidence.version, 2);
		assert.equal(evidence.otaExpenseTotalSar, fixture.expectedExpense);
		assert.equal(evidence.otaCommissionSar, fixture.expectedCommission);
		assert.equal(
			evidence.unclassifiedDeductionSar,
			fixture.expectedUnclassified
		);
		assert.deepEqual(evidence.unpricedDeductionLabels, ["Targeted promotions"]);
		assert.equal(evidence.inboundEmailId, `audit-${fixture.bookingId}`);
		assert.match(evidence.sourceTextHash, /^[a-f0-9]{64}$/);
	}
});

test("unequal Agoda nightly values use cent-exact weighted allocation instead of equal division", () => {
	const normalized = {
		...extractNormalizedReservation(
			authenticatedAgodaCommercialVoucher({
				bookingId: "687700001",
				checkin: "August 20, 2026",
				checkout: "August 22, 2026",
				roomName: "Double Room",
				adults: 2,
				nightly: [
					["August 20, 2026", "33.33"],
					["August 21, 2026", "66.67"],
				],
				gross: "123.45",
				net: "100.00",
				commission: "12.00",
				growthProgram: "5.00",
				taxOnCommission: "1.00",
			})
		),
		inboundEmailId: "audit-unequal-nightly",
	};
	assert.deepEqual(
		normalized.nightlyPricingSar.map((row) => row.clientAmountSar),
		[41.15, 82.3]
	);
	const evidence = buildHotelRunnerEmailCommercialEvidence(normalized);
	const pricing = buildDirectHotelRunnerCommercialPricing(
		{
			pickedRoomsPricing: [
				{
					count: 1,
					pricingByDay: [
						{
							date: "2026-08-20",
							clientPrice: 33.33,
							rootPrice: 30,
							hotelRunnerSourcePrice: 33.33,
						},
						{
							date: "2026-08-21",
							clientPrice: 66.67,
							rootPrice: 50,
							hotelRunnerSourcePrice: 66.67,
						},
					],
				},
			],
		},
		normalized,
		evidence,
		{ reportedTotalRole: "payout" }
	);
	assert.deepEqual(
		pricing.rooms[0].pricingByDay.map((day) => ({
			client: day.clientPrice,
			net: day.netAfterExpenses,
			expense: day.otaExpenseAmount,
			margin: day.platformMargin,
		})),
		[
			{ client: 41.15, net: 33.33, expense: 7.82, margin: 3.33 },
			{ client: 82.3, net: 66.67, expense: 15.63, margin: 16.67 },
		]
	);
	assert.deepEqual(
		{
			client: pricing.clientTotal,
			root: pricing.rootTotal,
			net: pricing.netAfterExpensesTotal,
			expense: pricing.otaExpenseTotal,
			margin: pricing.platformMarginTotal,
		},
		{ client: 123.45, root: 80, net: 100, expense: 23.45, margin: 20 }
	);
});

test("HotelRunner commercial materialization repairs a one-cent converted nightly shortfall", () => {
	const dates = Array.from(
		{ length: 7 },
		(_item, index) => `2026-08-${String(10 + index).padStart(2, "0")}`
	);
	const malformedClientRows = [60.23, 60.23, 60.23, 60.22, 60.22, 60.22, 60.22];
	const exactPayoutRows = [56.89, 56.89, 56.89, 56.89, 56.89, 56.88, 56.88];
	const pricing = buildDirectHotelRunnerCommercialPricing(
		{
			pickedRoomsPricing: [
				{
					count: 1,
					pricingByDay: dates.map((date) => ({
						date,
						clientPrice: 15.17,
						rootPrice: 75,
						hotelRunnerSourcePrice: 15.17,
					})),
				},
			],
		},
		{
			nightlyPricingSar: dates.map((date, index) => ({
				date,
				clientAmountSar: malformedClientRows[index],
				payoutAmountSar: exactPayoutRows[index],
			})),
		},
		{ grossTotalSar: 421.58, payoutTotalSar: 398.21 },
		{ reportedTotalRole: "payout" }
	);

	assert.ok(pricing);
	const rows = pricing.rooms[0].pricingByDay;
	const cents = (value) =>
		Math.round((Number(value) + Number.EPSILON) * 100);
	assert.equal(
		rows.reduce((sum, day) => sum + cents(day.clientPrice), 0),
		42158
	);
	assert.equal(
		rows.reduce((sum, day) => sum + cents(day.netAfterExpenses), 0),
		39821
	);
	assert.equal(cents(pricing.rooms[0].totalPriceWithCommission), 42158);
	assert.equal(cents(pricing.clientTotal), 42158);
	assert.ok(
		rows.every(
			(day) => cents(day.clientPrice) >= cents(day.netAfterExpenses)
		)
	);
});

test("commercial cents use deterministic decimal half-away rounding and exact multiplication", () => {
	assert.equal(decimalMoneyCents(1.005), 101);
	assert.equal(decimalMoneyCents(10.075), 1008);
	assert.equal(decimalMoneyCents(421.575), 42158);
	assert.equal(decimalMoneyCents(-1.005), -101);
	assert.equal(decimalMoneyCents("1.005e1"), 1005);
	assert.equal(decimalMoneyCents("90071992547409.91"), Number.MAX_SAFE_INTEGER);
	assert.equal(decimalMoneyCents("90071992547409.92"), null);
	assert.equal(decimalMoneyCents("not-money"), null);
	assert.equal(multipliedMoneyCents(112.42, 3.75), 42158);
	assert.equal(multipliedMoneyCents("1.1242e2", "3.75e0"), 42158);
	assert.equal(multipliedMoneyCents(-1.005, 1), -101);
});

test("Agoda commercial parsing keeps missing commission nullable and genuine stay conflicts closed", () => {
	const withoutCommission = authenticatedAgodaCommercialVoucher({
		bookingId: "687702587",
		checkin: "August 8, 2026",
		checkout: "August 9, 2026",
		roomName: "Triple Room",
		adults: 3,
		nightly: [["August 8, 2026", "49.50"]],
		gross: "80.00",
		net: "49.50",
		commission: null,
		growthProgram: "8.00",
		taxOnCommission: "3.00",
	});
	const normalized = {
		...extractNormalizedReservation(withoutCommission),
		inboundEmailId: "audit-no-explicit-commission",
	};
	assert.equal(normalized.requiresManualReview, false);
	assert.equal(normalized.otaCommissionSar, null);
	assert.equal(normalized.sourcePresence.otaCommission, false);
	assert.deepEqual(
		normalized.otaDeductionComponents.map((component) => component.type),
		["growth_program", "tax_on_commission"]
	);
	const evidence = buildHotelRunnerEmailCommercialEvidence(normalized);
	assert.equal(evidence.otaCommissionSar, null);
	assert.equal(evidence.unclassifiedDeductionSar, 19.5);

	const unauthenticated = extractNormalizedReservation({
		...withoutCommission,
		text: withoutCommission.text.replace(
			"Compensation Agoda Growth Program",
			"Compensation Commission SAR -12.00 Agoda Growth Program"
		),
		senderAuthentication: {},
	});
	assert.equal(unauthenticated.otaCommissionSar, null);
	assert.deepEqual(unauthenticated.otaDeductionComponents, []);
	assert.equal(buildHotelRunnerEmailCommercialEvidence(unauthenticated), null);

	const conflict = extractNormalizedReservation({
		...withoutCommission,
		text: `${withoutCommission.text}\nCheck-in date: August 8, 2026\nCheck-in date: August 10, 2026`,
	});
	assert.equal(conflict.requiresManualReview, true);
	assert.ok(
		conflict.manualReviewReasons.some((reason) => /conflicting repeated explicit check-in/i.test(reason))
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
		messageId: "agoda-682028095@mail.agoda.com",
		sourceReceivedAt: "2026-07-22T18:00:00.000Z",
		senderAuthentication: {
			authenticatedAligned: true,
			trustedProvider: "agoda",
			method: "dkim",
		},
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
	assert.equal(built.document.pickedRoomsType[0].pricingByDay[0].rootPrice, 75);
	assert.equal(built.document.commission, 0);
});

const productionAgodaQuantityEmail = ({
	bookingId,
	guestFirstName,
	guestLastName,
	checkin,
	checkout,
	roomName,
	roomCount,
	adults,
	nightlyRows,
	gross,
	payout,
	specialRequests,
	phone = "",
	commission = "26.46",
	growthProgram = "17.64",
	taxOnCommission = "6.62",
}) => {
	const text = [
		`Booking ID ${bookingId}`,
		"Reservation Information",
		"PREPAID",
		"Booking confirmation",
		"Zyd Agyad",
		"(Property ID 90720772)",
		"City : Mecca",
		`Customer First Name ${guestFirstName}`,
		`Customer Last Name ${guestLastName}`,
		"Country of Residence Saudi Arabia",
		`Check-in ${checkin}`,
		`Check-out ${checkout}`,
		"Other Guests [RmNo.1] Guest A [RmNo.1] Guest B",
		`Room Type No. of Rooms Occupancy No. of Extra Bed ${roomName} ${roomCount} ${adults} Adults 0`,
		"Rate Plan name: Non-Refundable ()",
		"Special Requests ( All special requests are subject to availability upon arrival. )",
		specialRequests,
		"Cancellation Policy",
		"Room Extra Bed Other From - To Rates",
		...nightlyRows,
		`Reference sell rate (incl. taxes & fees) SAR ${gross}`,
		`Commission SAR -${commission}`,
		`Agoda Growth Program SAR -${growthProgram}`,
		`Tax on Commission SAR -${taxOnCommission}`,
		`Net rate (incl. taxes & fees) SAR ${payout}`,
		`Customer Info - Name: ${guestFirstName} ${guestLastName}, Phone:${phone ? ` ${phone}` : ""}`,
		"Attention Hotel Staff",
		"Agoda Hotline (Saudi Arabia) : (966) 11 510 8739",
	].join("\n");
	return {
		from: 'agoda.com <no-reply@agoda.com>',
		subject: `Agoda Booking ID ${bookingId} - CONFIRMED Hotel Country: Saudi Arabia Check-in ${checkin} / Language_English`,
		messageId: `agoda-${bookingId}@mail.agoda.com`,
		sourceReceivedAt: "2026-08-13T20:00:00.000Z",
		senderAuthentication: {
			authenticatedAligned: true,
			trustedProvider: "agoda",
			method: "dkim",
		},
		text,
		html: text
			.split("\n")
			.map((line) => `<div>${line}</div>`)
			.join(""),
	};
};

const productionAgodaQuantityFixtures = [
	{
		bookingId: "689554695",
		guestFirstName: "SYNTHETIC FIVE BED GUEST",
		guestLastName: "TEST ONLY",
		checkin: "August 14, 2026",
		checkout: "August 15, 2026",
		roomName: "5 Beds Room (Comfort 5 Beds Room )",
		roomCount: 2,
		adults: 7,
		nightlyRows: ["August 14, 2026 SAR 109.16"],
		gross: "176.40",
		payout: "109.16",
		specialRequests: "LargeBed, AdjoiningRoom, ArrivalTime:22 00",
		phone: "",
		expectedCheckin: "2026-08-14",
		expectedCheckout: "2026-08-15",
		expectedNightGross: [88.2],
		expectedNightPayout: [54.58],
	},
	{
		bookingId: "689553735",
		guestFirstName: "SYNTHETIC DOUBLE ROOM GUEST",
		guestLastName: "TEST ONLY",
		checkin: "August 20, 2026",
		checkout: "August 22, 2026",
		roomName: "Comfort Double - Non-Smoking (Comfort Double Room-)",
		roomCount: 2,
		adults: 4,
		nightlyRows: [
			"August 20, 2026 SAR 89.10",
			"August 21, 2026 SAR 89.10",
		],
		gross: "288.00",
		payout: "178.20",
		specialRequests:
			"NonSmoke, TwinBeds, AdjoiningRoom, ArrivalTime:21 00 - 22 00, AdditionalNotes:Car parking.",
		phone: "966 500000123",
		expectedCheckin: "2026-08-20",
		expectedCheckout: "2026-08-22",
		expectedNightGross: [72, 72],
		expectedNightPayout: [44.55, 44.55],
	},
];

test("direct Agoda MIME consensus accepts an exact sell rate split across a plain-text line wrap", () => {
	const email = productionAgodaQuantityEmail({
		bookingId: "6900000123",
		guestFirstName: "SYNTHETIC",
		guestLastName: "SINGLE ROOM GUEST",
		checkin: "August 18, 2026",
		checkout: "August 19, 2026",
		roomName: "Comfort Double - Non-Smoking (Comfort Double Room-)",
		roomCount: 1,
		adults: 1,
		nightlyRows: ["August 18, 2026 SAR 37.60"],
		gross: "60.76",
		payout: "37.60",
		specialRequests: "NonSmoke",
		commission: "9.11",
		growthProgram: "6.08",
		taxOnCommission: "2.28",
	});
	// Agoda's real text/plain part may fold this label while the HTML part keeps
	// it on one line. Both representations still assert the exact same money.
	email.text = email.text.replace(
		"Reference sell rate (incl. taxes & fees)",
		"Reference sell rate (incl. taxes\n& fees)"
	);
	const normalized = {
		...extractNormalizedReservation(email),
		inboundEmailId: "audit-agoda-wrapped-money-label",
	};

	assert.equal(normalized.requiresManualReview, false);
	assert.deepEqual(normalized.agodaMimeConflictFields, []);
	assert.equal(normalized.totalAmountSar, 60.76);
	assert.equal(normalized.totalPayoutSar, 37.6);
	assert.equal(normalized.otaCommissionSar, 9.11);
	assert.deepEqual(
		normalized.otaDeductionComponents.map((component) => component.amountSar),
		[9.11, 6.08, 2.28]
	);

	const built = buildReservationDocument(normalized, {
		_id: "zad",
		belongsTo: "owner",
		currency: "SAR",
		roomCountDetails: [
			{
				_id: "double",
				roomType: "doubleRooms",
				displayName: "Double Room - Comfort & Relaxation",
				activeRoom: true,
				pricingRate: [{ calendarDate: "2026-08-18", rootPrice: 75 }],
			},
		],
	});
	assert.equal(built.ok, true);
	assert.equal(built.document.total_amount, 60.76);
	assert.equal(built.document.adminPricing.netAfterExpensesTotal, 37.6);
	assert.equal(built.document.adminPricing.otaExpenseTotal, 23.16);
	assert.equal(built.document.pickedRoomsPricing[0].count, 1);
	assert.deepEqual(
		built.document.pickedRoomsPricing[0].pricingByDay.map((day) => ({
			client: day.clientPrice,
			payout: day.netAfterExpenses,
			expense: day.otaExpenseAmount,
		})),
		[{ client: 60.76, payout: 37.6, expense: 23.16 }]
	);
});

test("production Agoda wrapped plain-text labels agree with unwrapped HTML and preserve two-room cents", () => {
	const fixture = {
		bookingId: "6900000467",
		guestFirstName: "SYNTHETIC WRAPPED",
		guestLastName: "GUEST",
		checkin: "August 14, 2026",
		checkout: "August 15, 2026",
		roomName: "Comfort Double - Non-Smoking (Comfort Double Room-)",
		roomCount: 2,
		adults: 4,
		nightlyRows: ["August 14, 2026 SAR 75.20"],
		gross: "121.52",
		payout: "75.20",
		specialRequests: "TwinBeds",
		phone: "",
		commission: "18.22",
		growthProgram: "12.16",
		taxOnCommission: "4.56",
	};
	const email = productionAgodaQuantityEmail(fixture);
	const unwrappedGuestStayBlock = [
		"Customer First Name SYNTHETIC WRAPPED",
		"Customer Last Name GUEST",
		"Country of Residence Saudi Arabia",
		"Check-in August 14, 2026",
		"Check-out August 15, 2026",
		"Other Guests [RmNo.1] Guest A [RmNo.1] Guest B",
	].join("\n");
	const wrappedGuestStayBlock = [
		"Customer First Name SYNTHETIC WRAPPED Customer Last Name GUEST Country of",
		"Residence Saudi Arabia Check-in August 14, 2026 Check-out August 15, 2026 Other",
		"Guests [RmNo.1] Guest A [RmNo.1] Guest B",
	].join("\n");
	const wrappedText = email.text.replace(
		unwrappedGuestStayBlock,
		wrappedGuestStayBlock
	);
	assert.notEqual(wrappedText, email.text);
	assert.match(wrappedText, /Country of\nResidence Saudi Arabia/);
	assert.match(wrappedText, /Other\nGuests \[RmNo\.1\]/);

	const normalized = extractNormalizedReservation({
		...email,
		text: wrappedText,
	});
	assert.deepEqual(normalized.agodaMimeConflictFields, []);
	assert.deepEqual(normalized.genericRepeatedFactConflictFields, []);
	assert.equal(normalized.requiresManualReview, false);
	assert.equal(normalized.blocksUnmappedReservationCreation, false);
	assert.equal(normalized.confirmationNumber, "6900000467");
	assert.equal(normalized.guestName, "SYNTHETIC WRAPPED GUEST");
	assert.equal(normalized.nationality, "Saudi Arabia");
	assert.equal(normalized.checkinDate, "2026-08-14");
	assert.equal(normalized.checkoutDate, "2026-08-15");
	assert.equal(
		normalized.roomName,
		"Comfort Double - Non-Smoking (Comfort Double Room-)"
	);
	assert.equal(normalized.roomCount, 2);
	assert.equal(normalized.adults, 4);
	assert.equal(normalized.totalGuests, 4);
	assert.equal(normalized.totalAmountSar, 121.52);
	assert.equal(normalized.totalPayoutSar, 75.2);
	assert.equal(normalized.otaCommissionSar, 18.22);

	const room = {
		_id: "double-wrapped-label",
		roomType: "doubleRooms",
		displayName: fixture.roomName,
		activeRoom: true,
		pricingRate: [{ calendarDate: "2026-08-14", rootPrice: 75 }],
	};
	const built = buildReservationDocument(
		normalized,
		{
			_id: "6a40b6a1a6efe70450536038",
			belongsTo: "68b74714fb50e159d48c714d",
			currency: "SAR",
			roomCountDetails: [room],
		},
		{
			roomMatch: {
				roomDetails: room,
				score: 1,
				matchType: "exact_display",
			},
		}
	);
	assert.equal(built.ok, true, JSON.stringify(built));
	assert.equal(built.document.total_rooms, 2);
	assert.deepEqual(
		built.document.pickedRoomsPricing.map((entry) => entry.count),
		[1, 1]
	);
	const roomNights = built.document.pickedRoomsPricing.flatMap(
		(entry) => entry.pricingByDay
	);
	assert.deepEqual(
		roomNights.map((day) => ({
			client: day.clientPrice,
			payout: day.netAfterExpenses,
			expense: day.otaExpenseAmount,
		})),
		[
			{ client: 60.76, payout: 37.6, expense: 23.16 },
			{ client: 60.76, payout: 37.6, expense: 23.16 },
		]
	);
	assert.equal(
		roomNights.reduce((sum, day) => sum + decimalMoneyCents(day.clientPrice), 0),
		decimalMoneyCents(121.52)
	);
	assert.equal(
		roomNights.reduce(
			(sum, day) => sum + decimalMoneyCents(day.netAfterExpenses),
			0
		),
		decimalMoneyCents(75.2)
	);
	assert.equal(
		roomNights.reduce(
			(sum, day) => sum + decimalMoneyCents(day.otaExpenseAmount),
			0
		),
		decimalMoneyCents(46.32)
	);

	const bodyOnlyLifecycleText = wrappedText
		.replace("Booking ID 6900000467", "Booking\nID\n6900000467")
		.replace("Customer First Name", "Customer\tFirst\tName")
		.replace("Customer Last Name", "Customer\tLast\tName");
	for (const expected of [
		{
			subject: "Agoda reservation CANCELLED",
			eventType: "cancelled",
			intent: "reservation_status",
			statusToApply: "cancelled",
		},
		{
			subject: "Agoda reservation MODIFIED",
			eventType: "modified",
			intent: "reservation_update",
			statusToApply: "",
		},
	]) {
		const lifecycle = extractNormalizedReservation({
			...email,
			subject: expected.subject,
			text: bodyOnlyLifecycleText,
			html: "",
		});
		assert.equal(lifecycle.eventType, expected.eventType);
		assert.equal(lifecycle.intent, expected.intent);
		assert.equal(lifecycle.statusToApply, expected.statusToApply);
		assert.equal(lifecycle.confirmationNumber, "6900000467");
		assert.deepEqual(lifecycle.agodaMimeConflictFields, []);
		assert.equal(lifecycle.requiresManualReview, false);
	}
});

test("trusted direct Agoda parser input budgets stop text and HTML before FX, AI, lookup, or writes", async () => {
	const normal = productionAgodaQuantityEmail(productionAgodaQuantityFixtures[0]);
	assert.equal(
		extractNormalizedReservation(normal).otaInboundParserResourceLimitExceeded,
		false
	);
	const oversized = [
		{
			...normal,
			text: `${normal.text}\n${"x".repeat(
				MAX_OTA_INBOUND_RAW_REPRESENTATION_BYTES
			)}`,
		},
		{
			...normal,
			html: `<div>${normal.text}</div>${"x".repeat(
				MAX_OTA_INBOUND_RAW_REPRESENTATION_BYTES
			)}`,
		},
	];
	await assertTrustedOtaParserResourceGuard(oversized, "agoda");
});

test("production Agoda homogeneous room quantities materialize as separate count-one rows without doubled totals", () => {
	for (const fixture of productionAgodaQuantityFixtures) {
		const normalized = extractNormalizedReservation(
			productionAgodaQuantityEmail(fixture)
		);
		assert.equal(normalized.confirmationNumber, fixture.bookingId);
		assert.equal(normalized.agodaPropertyId, "90720772");
		assert.equal(normalized.sourcePresence.agodaPropertyId, true);
		assert.equal(normalized.agodaHomogeneousRoomQuantity, true);
		assert.equal(normalized.ambiguousMultiRoomEvidence, false);
		assert.equal(normalized.requiresManualReview, false);
		assert.equal(normalized.blocksUnmappedReservationCreation, false);
		assert.equal(normalized.roomCount, 2);
		assert.equal(normalized.adults, fixture.adults);
		assert.equal(normalized.totalGuests, fixture.adults);
		assert.equal(normalized.checkinDate, fixture.expectedCheckin);
		assert.equal(normalized.checkoutDate, fixture.expectedCheckout);
		assert.equal(normalized.guestNotes, fixture.specialRequests);
		assert.equal(normalized.guestPhone, fixture.phone);
		assert.equal(normalized.sourcePresence.guestPhone, !!fixture.phone);
		assert.equal(normalized.totalAmountSar, Number(fixture.gross));
		assert.equal(normalized.totalPayoutSar, Number(fixture.payout));

		const room = {
			_id: `room-${fixture.bookingId}`,
			roomType: "familyRooms",
			displayName: fixture.roomName,
			activeRoom: true,
			pricingRate: generateDateRange(
				fixture.expectedCheckin,
				fixture.expectedCheckout
			).map((calendarDate) => ({ calendarDate, rootPrice: 75 })),
		};
		const built = buildReservationDocument(
			normalized,
			{
				_id: "6a40b6a1a6efe70450536038",
				belongsTo: "68b74714fb50e159d48c714d",
				currency: "SAR",
				roomCountDetails: [room],
			},
			{
				roomMatch: {
					roomDetails: room,
					score: 1,
					matchType: "exact_display",
				},
			}
		);
		assert.equal(built.ok, true, JSON.stringify(built));
		const document = built.document;
		assert.equal(document.total_rooms, 2);
		assert.equal(document.pickedRoomsType.length, 2);
		assert.equal(document.pickedRoomsPricing.length, 2);
		assert.deepEqual(document.pickedRoomsPricing.map((entry) => entry.count), [1, 1]);
		for (const entry of document.pickedRoomsPricing) {
			assert.deepEqual(
				entry.pricingByDay.map((day) => day.date),
				generateDateRange(fixture.expectedCheckin, fixture.expectedCheckout)
			);
			assert.deepEqual(
				entry.pricingByDay.map((day) => day.clientPrice),
				fixture.expectedNightGross
			);
			assert.deepEqual(
				entry.pricingByDay.map((day) => day.netAfterExpenses),
				fixture.expectedNightPayout
			);
		}
		const allDays = document.pickedRoomsPricing.flatMap(
			(entry) => entry.pricingByDay
		);
		assert.equal(
			Number(allDays.reduce((sum, day) => sum + day.clientPrice, 0).toFixed(2)),
			Number(fixture.gross)
		);
		assert.equal(
			Number(
				allDays.reduce((sum, day) => sum + day.netAfterExpenses, 0).toFixed(2)
			),
			Number(fixture.payout)
		);
		assert.equal(document.total_amount, Number(fixture.gross));
		assert.equal(document.supplierData.otaPropertyId, "90720772");
		assert.equal(document.supplierData.agodaPropertyId, "90720772");

		const review = buildUnmappedOtaReviewReservationDocument(normalized);
		assert.equal(review.total_rooms, 2);
		assert.deepEqual(review.pickedRoomsPricing.map((entry) => entry.count), [1, 1]);
		assert.ok(
			review.pickedRoomsPricing
				.flatMap((entry) => entry.pricingByDay)
				.every(
					(day) =>
						day.rootPrice === 0 &&
						day.totalPriceWithoutCommission === 0 &&
						day.platformMargin === null
				)
		);
		assert.equal(review.supplierData.otaPropertyId, "90720772");
		const release = validateOtaReleaseHotelBasePrice({
			...review,
			hotelId: "6a40b6a1a6efe70450536038",
		});
		assert.equal(release.ready, false);
		assert.equal(release.code, "ota_pricing_review_required");
	}
});

test("Agoda quantity safety stays authenticated and fails closed for distinct rows, property conflicts, and metadata phones", async () => {
	const fixture = productionAgodaQuantityFixtures[0];
	const unauthenticated = extractNormalizedReservation({
		...productionAgodaQuantityEmail(fixture),
		senderAuthentication: {},
	});
	assert.equal(unauthenticated.agodaHomogeneousRoomQuantity, true);
	assert.equal(unauthenticated.sourceSenderAuthenticated, false);
	const unauthenticatedResult = await reconcileOtaReservation(unauthenticated);
	assert.equal(unauthenticatedResult.status, "needs_review");
	assert.equal(
		unauthenticatedResult.skipReason,
		"unauthenticated_ota_sender_no_mutation"
	);

	const distinctRows = extractNormalizedReservation({
		...productionAgodaQuantityEmail(fixture),
		text: productionAgodaQuantityEmail(fixture).text.replace(
			`${fixture.roomName} 2 7 Adults 0`,
			"Double Room 1 2 Adults 0 Triple Room 1 3 Adults 0"
		),
		html: "",
	});
	assert.equal(distinctRows.ambiguousMultiRoomEvidence, true);
	assert.equal(distinctRows.blocksUnmappedReservationCreation, true);
	assert.equal(canCreateUnmappedOtaReviewReservation(distinctRows, true), false);

	const conflictingProperty = extractNormalizedReservation({
		...productionAgodaQuantityEmail(fixture),
		text: `${productionAgodaQuantityEmail(fixture).text}\n(Property ID 99999999)`,
		html: "",
	});
	assert.equal(conflictingProperty.requiresManualReview, true);
	assert.equal(conflictingProperty.blocksUnmappedReservationCreation, true);
	assert.equal(conflictingProperty.agodaPropertyId, "");

	assert.equal(
		extractNormalizedReservation(productionAgodaQuantityEmail(fixture)).guestPhone,
		""
	);
	assert.equal(
		extractNormalizedReservation(productionAgodaQuantityEmail(fixture)).guestNotes,
		"LargeBed, AdjoiningRoom, ArrivalTime:22 00"
	);
	const boilerplateOnly = extractNormalizedReservation({
		...productionAgodaQuantityEmail(fixture),
		text: productionAgodaQuantityEmail(fixture).text.replace(
			fixture.specialRequests,
			""
		),
		html: "",
	});
	assert.equal(boilerplateOnly.guestNotes, "");
	assert.equal(boilerplateOnly.guestPhone, "");
});

test("Agoda critical commercial, guest, stay, and nightly facts require MIME consensus", () => {
	const fixture = productionAgodaQuantityFixtures[1];
	for (const [field, mutateHtml] of [
		[
			"referenceSellRate",
			(html) => html.replace("SAR 288.00", "SAR 288.01"),
		],
		[
			"netRate",
			(html) => html.replace("SAR 178.20", "SAR 178.21"),
		],
		[
			"guestName",
			(html) =>
				html.replaceAll(
					"SYNTHETIC DOUBLE ROOM GUEST",
					"SYNTHETIC CONFLICTING GUEST"
				),
		],
		[
			"nationality",
			(html) =>
				html.replace("Country of Residence Saudi Arabia", "Country of Residence Egypt"),
		],
		[
			"checkinDate",
			(html) => html.replaceAll("August 20, 2026", "August 19, 2026"),
		],
		[
			"checkoutDate",
			(html) => html.replace("August 22, 2026", "August 23, 2026"),
		],
		[
			"nightlyPricing",
			(html) =>
				html
					.replace("August 20, 2026 SAR 89.10", "August 20, 2026 SAR 89.11")
					.replace("August 21, 2026 SAR 89.10", "August 21, 2026 SAR 89.09"),
		],
	]) {
		const email = productionAgodaQuantityEmail(fixture);
		const normalized = extractNormalizedReservation({
			...email,
			html: mutateHtml(email.html),
		});
		assert.equal(normalized.requiresManualReview, true, field);
		assert.equal(normalized.blocksUnmappedReservationCreation, true, field);
		assert.ok(normalized.agodaMimeConflictFields.includes(field), field);
		assert.equal(canCreateUnmappedOtaReviewReservation(normalized, true), false);
	}
	const deductionEmail = productionAgodaQuantityEmail(fixture);
	const deductionConflict = extractNormalizedReservation({
		...deductionEmail,
		html: deductionEmail.html.replace("SAR -26.46", "SAR -26.47"),
	});
	assert.equal(deductionConflict.otaDeductionConflict, true);
	assert.equal(deductionConflict.requiresManualReview, true);
	assert.equal(deductionConflict.blocksUnmappedReservationCreation, true);
	assert.match(
		deductionConflict.manualReviewReasons.join(" "),
		/conflicting deduction amounts/i
	);
	const malformedGrossEmail = productionAgodaQuantityEmail(fixture);
	const malformedGross = extractNormalizedReservation({
		...malformedGrossEmail,
		html: malformedGrossEmail.html.replace("SAR 288.00", "amount unavailable"),
	});
	assert.equal(malformedGross.requiresManualReview, true);
	assert.equal(malformedGross.blocksUnmappedReservationCreation, true);
	assert.ok(
		malformedGross.agodaMimeConflictFields.includes("referenceSellRate")
	);
});

test("Agoda bounded room-table parsing fails closed instead of accepting a truncated first row", () => {
	const fixture = productionAgodaQuantityFixtures[0];
	const email = productionAgodaQuantityEmail(fixture);
	const oversizedGap = ` ${"bounded-filler ".repeat(150)} `;
	const text = email.text.replace("Rate Plan name", `${oversizedGap}Rate Plan name`);
	const normalized = extractNormalizedReservation({
		...email,
		text,
		html: "",
	});
	assert.equal(normalized.ambiguousMultiRoomEvidence, true);
	assert.equal(normalized.requiresManualReview, true);
	assert.equal(normalized.blocksUnmappedReservationCreation, true);
	assert.equal(canCreateUnmappedOtaReviewReservation(normalized, true), false);
});

test("nightly gross and payout distributions are applied only as one coherent pair", () => {
	const fixture = productionAgodaQuantityFixtures[1];
	const normalized = extractNormalizedReservation(
		productionAgodaQuantityEmail(fixture)
	);
	const incoherentNightly = {
		...normalized,
		nightlyPricingSar: [
			{
				date: "2026-08-20",
				clientAmountSar: 100,
				payoutAmountSar: 100.02,
			},
			{
				date: "2026-08-21",
				clientAmountSar: 188,
				payoutAmountSar: 78.18,
			},
		],
	};
	const room = {
		_id: "synthetic-coherent-pair-room",
		roomType: "doubleRooms",
		displayName: fixture.roomName,
		activeRoom: true,
		pricingRate: generateDateRange(
			fixture.expectedCheckin,
			fixture.expectedCheckout
		).map((calendarDate) => ({ calendarDate, rootPrice: 50 })),
	};
	const built = buildReservationDocument(
		incoherentNightly,
		{
			_id: "synthetic-coherent-pair-hotel",
			belongsTo: "synthetic-owner",
			currency: "SAR",
			roomCountDetails: [room],
		},
		{
			roomMatch: { roomDetails: room, score: 1, matchType: "exact_display" },
		}
	);
	assert.equal(built.ok, true, JSON.stringify(built));
	for (const day of built.document.pickedRoomsPricing.flatMap(
		(roomEntry) => roomEntry.pricingByDay
	)) {
		assert.equal(day.clientPrice, 72);
		assert.equal(day.netAfterExpenses, 44.55);
		assert.equal(day.otaExpenseAmount, 27.45);
	}
	assert.equal(built.document.adminPricing.otaExpenseTotal, 109.8);
	assert.equal(
		Number(
			built.document.pickedRoomsPricing
				.flatMap((roomEntry) => roomEntry.pricingByDay)
				.reduce((sum, day) => sum + day.otaExpenseAmount, 0)
				.toFixed(2)
		),
		109.8
	);

	const review = buildUnmappedOtaReviewReservationDocument(incoherentNightly);
	for (const day of review.pickedRoomsPricing.flatMap(
		(roomEntry) => roomEntry.pricingByDay
	)) {
		assert.equal(day.clientPrice, 72);
		assert.equal(day.netAfterExpenses, 44.55);
		assert.equal(day.otaExpenseAmount, 27.45);
	}
});

test("distinct-room or multi-rate Agoda payloads require manual review", () => {
	const multiRoom = extractNormalizedReservation({
		from: "no-reply@agoda.com",
		subject: "Agoda Booking ID 682028096 - CONFIRMED",
		text: [
			"Booking ID 682028096 Reservation Information",
			"Customer First Name Safe Customer Last Name Guest Country of Residence Saudi Arabia Check-in July 23, 2026 Check-out July 24, 2026",
			"Other Guests [RmNo.1] Safe Guest [RmNo.2] Other Guest",
			"Room Type No. of Rooms Occupancy No. of Extra Bed Double Room 1 2 Adults 0 Triple Room 1 3 Adults 0",
			"Reference sell rate (incl. taxes & fees) SAR 210.00",
		].join("\n"),
	});
	assert.equal(multiRoom.requiresManualReview, true);
	assert.equal(multiRoom.ambiguousMultiRoomEvidence, true);
	assert.equal(multiRoom.blocksUnmappedReservationCreation, true);
	assert.equal(canCreateUnmappedOtaReviewReservation(multiRoom, true), false);
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

test("genuine repeated and heterogeneous HotelRunner room blocks fail closed while mirrored MIME stays singular", () => {
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
	assert.equal(normalized.ambiguousMultiRoomEvidence, true);
	assert.equal(normalized.blocksUnmappedReservationCreation, true);
	assert.equal(canCreateUnmappedOtaReviewReservation(normalized, true), false);
	assert.match(normalized.manualReviewReasons[0], /2 room blocks/i);

	const genuineIdenticalRooms = extractNormalizedReservation({
		from: '"HotelRunner" <noreply@hotelrunner.com>',
		subject: "Zad Ajyad - New Reservation #681911773",
		text: [
			"Booking Source Agoda",
			"Confirmation Number 681911773",
			"Hotel Name Zad Ajyad",
			"Order Total SAR 200",
			roomBlock,
			roomBlock,
			"Go to reservation",
		].join("\n"),
	});
	assert.equal(genuineIdenticalRooms.requiresManualReview, true);
	assert.equal(genuineIdenticalRooms.ambiguousMultiRoomEvidence, true);
	assert.equal(genuineIdenticalRooms.blocksUnmappedReservationCreation, true);
	assert.equal(
		canCreateUnmappedOtaReviewReservation(genuineIdenticalRooms, true),
		false
	);

	const heterogeneousRooms = extractNormalizedReservation({
		from: '"HotelRunner" <noreply@hotelrunner.com>',
		subject: "Zad Ajyad - New Reservation #681911774",
		text: [
			"Booking Source Agoda",
			"Confirmation Number 681911774",
			"Hotel Name Zad Ajyad",
			"Order Total SAR 220",
			roomBlock,
			roomBlock
				.replace("Double Room", "Triple Room")
				.replace("Guest Count\n2", "Guest Count\n3")
				.replace("Total SAR 100", "Total SAR 120"),
			"Go to reservation",
		].join("\n"),
	});
	assert.equal(heterogeneousRooms.requiresManualReview, true);
	assert.equal(heterogeneousRooms.ambiguousMultiRoomEvidence, true);
	assert.equal(heterogeneousRooms.blocksUnmappedReservationCreation, true);
	assert.equal(canCreateUnmappedOtaReviewReservation(heterogeneousRooms, true), false);

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
	assert.equal(mirroredMimeParts.ambiguousMultiRoomEvidence, false);
	assert.equal(mirroredMimeParts.blocksUnmappedReservationCreation, false);

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
		receivedAt: "2026-08-07T15:53:15Z",
		senderAuthentication: {
			authenticatedAligned: true,
			trustedProvider: "airbnb",
			method: "dkim",
		},
		subject: "Reservation confirmed - Test Guest arrives Aug 9",
		text: [
			"Send a message to confirm check-in details",
			"Test Guest",
			"Identity verified",
			"PRIVATE ROOM-3BEDS - AJYAD HOTEL-15 MINS TO HARAM",
			"Room",
			"Check-in Checkout",
			"Sun, Aug 9 Fri, Aug 14",
			"2:00 PM 10:00 AM",
			"Guests",
			"1 adult",
			"Confirmation code",
			"HMZDMHQQRE",
			"Total (SAR) SAR 145.70",
			"Check-in",
			"Sun, Aug 9",
			"Checkout",
			"Fri, Aug 14",
		].join("\n"),
	});

	assert.equal(normalized.checkinDate, "2026-08-09");
	assert.equal(normalized.checkoutDate, "2026-08-14");
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
	assert.equal(normalized.requiresManualReview, false);
	assert.equal(
		normalized.manualReviewReasons.some((reason) =>
			/conflicting repeated explicit check-in/i.test(reason)
		),
		false
	);
});

const authenticatedAirbnbCommercialEmail = ({
	confirmationNumber = "HMSAFEMONEY1",
	guestTotal = "100.00",
	payout = "80.00",
	payoutCurrency = "SAR",
	includePayout = true,
} = {}) => ({
	from: "Airbnb <automated@airbnb.com>",
	to: "reservations@example.com",
	subject: "Reservation confirmed - Commercial Evidence Guest arrives Aug 20",
	messageId: `airbnb-${confirmationNumber}@mail.airbnb.com`,
	sourceReceivedAt: "2026-08-08T10:00:00.000Z",
	senderAuthentication: {
		authenticatedAligned: true,
		trustedProvider: "airbnb",
		method: "dkim",
	},
	text: [
		"Commercial Evidence Guest",
		"Identity verified",
		"DOUBLE ROOM - AJYAD HOTEL - FREE BUS",
		"Room",
		"Check-in Checkout",
		"Thu, Aug 20 Fri, Aug 21",
		"Guests",
		"2 adults",
		"Confirmation code",
		confirmationNumber,
		"Total (SAR)",
		`SAR ${guestTotal}`,
		"Host service fee (10%)",
		`-SAR 10.00`,
		...(includePayout ? ["You earn", `${payoutCurrency} ${payout}`] : []),
	].join("\n"),
});

test("authenticated Agoda gross without payout keeps the payout role unavailable instead of synthesizing zero", () => {
	const voucher = authenticatedAgodaCommercialVoucher({
		bookingId: "687799901",
		checkin: "August 20, 2026",
		checkout: "August 21, 2026",
		roomName: "Double Room",
		adults: 2,
		nightly: [],
		gross: "100.00",
		net: "80.00",
		commission: "10.00",
		growthProgram: "5.00",
		taxOnCommission: "1.00",
	});
	const normalized = {
		...extractNormalizedReservation({
			...voucher,
			text: voucher.text
				.split("\n")
				.filter((line) => !/^Net rate \(incl\. taxes & fees\)/i.test(line))
				.join("\n"),
		}),
		inboundEmailId: "audit-agoda-gross-without-payout",
	};

	assert.equal(normalized.totalAmountSar, 100);
	assert.equal(normalized.totalPayoutSar, null);
	assert.equal(normalized.netAfterExpensesTotal, null);
	assert.equal(normalized.sourcePayoutAmount, null);
	assert.equal(normalized.sourcePayoutCurrency, "");
	assert.equal(normalized.paymentSummary.sourceTotalPayoutAmount, null);
	assert.equal(normalized.paymentSummary.totalPayoutAmount, null);

	const evidence = buildNormalizedOtaCommercialEvidence(normalized, {
		propertyCurrency: "SAR",
	});
	assert.equal(validateOtaCommercialEvidence(evidence).ok, true);
	assert.equal(evidence.verificationState, "partial");
	assert.equal(evidence.roles.guestGross.verified, true);
	assert.equal(evidence.roles.guestGross.propertyAmount, 100);
	assert.equal(evidence.roles.hotelPayout.verified, false);
	assert.equal(evidence.roles.hotelPayout.sourceAmount, null);
	assert.equal(evidence.roles.hotelPayout.propertyAmount, null);
	assert.equal(evidence.roles.deductionAggregate.verified, false);
	assert.equal(evidence.roles.deductionAggregate.sourceAmount, null);
});

test("authenticated Airbnb gross without payout keeps the payout role unavailable instead of synthesizing zero", () => {
	const normalized = {
		...extractNormalizedReservation(
			authenticatedAirbnbCommercialEmail({
				confirmationNumber: "HMSAFEMONEY2",
				includePayout: false,
			})
		),
		inboundEmailId: "audit-airbnb-gross-without-payout",
	};

	assert.equal(normalized.totalAmountSar, 100);
	assert.equal(normalized.totalPayoutSar, null);
	assert.equal(normalized.netAfterExpensesTotal, null);
	assert.equal(normalized.sourcePayoutAmount, null);
	assert.equal(normalized.sourcePayoutCurrency, "");
	assert.equal(normalized.paymentSummary.sourceTotalPayoutAmount, null);
	assert.equal(normalized.paymentSummary.totalPayoutAmount, null);

	const evidence = buildNormalizedOtaCommercialEvidence(normalized, {
		propertyCurrency: "SAR",
	});
	assert.equal(validateOtaCommercialEvidence(evidence).ok, true);
	assert.equal(evidence.verificationState, "partial");
	assert.equal(evidence.roles.guestGross.verified, true);
	assert.equal(evidence.roles.guestGross.propertyAmount, 100);
	assert.equal(evidence.roles.hotelPayout.verified, false);
	assert.equal(evidence.roles.hotelPayout.sourceAmount, null);
	assert.equal(evidence.roles.hotelPayout.propertyAmount, null);
	assert.equal(evidence.roles.deductionAggregate.verified, false);
	assert.equal(evidence.roles.deductionAggregate.sourceAmount, null);
});

test("authenticated Agoda and Airbnb explicit zero payouts remain verified zero roles", () => {
	const agodaVoucher = authenticatedAgodaCommercialVoucher({
		bookingId: "687799902",
		checkin: "August 20, 2026",
		checkout: "August 21, 2026",
		roomName: "Double Room",
		adults: 2,
		nightly: [],
		gross: "100.00",
		net: "0.00",
		commission: "10.00",
		growthProgram: "5.00",
		taxOnCommission: "1.00",
	});
	const cases = [
		{
			provider: "agoda",
			email: agodaVoucher,
		},
		{
			provider: "airbnb",
			email: authenticatedAirbnbCommercialEmail({
				confirmationNumber: "HMSAFEMONEY0",
				payout: "0.00",
			}),
		},
	];

	for (const fixture of cases) {
		const normalized = {
			...extractNormalizedReservation(fixture.email),
			inboundEmailId: `audit-${fixture.provider}-explicit-zero-payout`,
		};
		assert.equal(normalized.sourcePayoutAmount, 0, fixture.provider);
		assert.equal(normalized.sourcePayoutCurrency, "SAR", fixture.provider);
		assert.equal(normalized.totalPayoutSar, 0, fixture.provider);
		assert.equal(normalized.netAfterExpensesTotal, 0, fixture.provider);
		assert.equal(
			normalized.paymentSummary.sourceTotalPayoutAmount,
			0,
			fixture.provider
		);
		assert.equal(
			normalized.paymentSummary.totalPayoutAmount,
			0,
			fixture.provider
		);

		const evidence = buildNormalizedOtaCommercialEvidence(normalized, {
			propertyCurrency: "SAR",
		});
		assert.equal(validateOtaCommercialEvidence(evidence).ok, true, fixture.provider);
		assert.equal(evidence.verificationState, "verified", fixture.provider);
		assert.equal(evidence.roles.hotelPayout.verified, true, fixture.provider);
		assert.equal(evidence.roles.hotelPayout.sourceAmount, 0, fixture.provider);
		assert.equal(evidence.roles.hotelPayout.propertyAmount, 0, fixture.provider);
		assert.equal(
			evidence.roles.deductionAggregate.verified,
			true,
			fixture.provider
		);
		assert.equal(
			evidence.roles.deductionAggregate.sourceAmount,
			100,
			fixture.provider
		);
	}
});

test("authenticated Agoda and Airbnb currency-mismatched payouts remain raw evidence and cannot create payout or deduction roles", () => {
	const agodaVoucher = authenticatedAgodaCommercialVoucher({
		bookingId: "687799903",
		checkin: "August 20, 2026",
		checkout: "August 21, 2026",
		roomName: "Double Room",
		adults: 2,
		nightly: [],
		gross: "100.00",
		net: "80.00",
		commission: "10.00",
		growthProgram: "5.00",
		taxOnCommission: "1.00",
	});
	const cases = [
		{
			provider: "agoda",
			email: {
				...agodaVoucher,
				text: agodaVoucher.text.replace(
					"Net rate (incl. taxes & fees) SAR 80.00",
					"Net rate (incl. taxes & fees) USD 80.00"
				),
			},
		},
		{
			provider: "airbnb",
			email: authenticatedAirbnbCommercialEmail({
				confirmationNumber: "HMSAFEMONEY3",
				payoutCurrency: "USD",
			}),
		},
	];

	for (const fixture of cases) {
		const normalized = {
			...extractNormalizedReservation(fixture.email),
			inboundEmailId: `audit-${fixture.provider}-currency-mismatch`,
		};
		assert.equal(normalized.sourceCurrency, "SAR", fixture.provider);
		assert.equal(normalized.sourceAmount, 100, fixture.provider);
		assert.equal(normalized.sourcePayoutAmount, 80, fixture.provider);
		assert.equal(normalized.sourcePayoutCurrency, "USD", fixture.provider);
		assert.equal(normalized.totalPayoutSar, null, fixture.provider);
		assert.equal(normalized.netAfterExpensesTotal, null, fixture.provider);
		assert.equal(
			normalized.paymentSummary.sourceTotalPayoutAmount,
			80,
			fixture.provider
		);
		assert.equal(
			normalized.paymentSummary.sourceTotalPayoutCurrency,
			"USD",
			fixture.provider
		);
		assert.equal(normalized.paymentSummary.totalPayoutAmount, null, fixture.provider);
		assert.match(
			normalized.warnings.join(" "),
			/guest-total and payout currencies conflict.*source evidence only.*no cross-currency deduction/i,
			fixture.provider
		);

		const evidence = buildNormalizedOtaCommercialEvidence(normalized, {
			propertyCurrency: "SAR",
		});
		assert.equal(validateOtaCommercialEvidence(evidence).ok, true, fixture.provider);
		assert.equal(evidence.verificationState, "partial", fixture.provider);
		assert.equal(evidence.roles.guestGross.verified, true, fixture.provider);
		assert.equal(evidence.roles.guestGross.sourceAmount, 100, fixture.provider);
		assert.equal(evidence.roles.hotelPayout.verified, false, fixture.provider);
		assert.equal(evidence.roles.hotelPayout.sourceAmount, null, fixture.provider);
		assert.equal(
			evidence.roles.deductionAggregate.verified,
			false,
			fixture.provider
		);
		assert.equal(
			evidence.roles.deductionAggregate.sourceAmount,
			null,
			fixture.provider
		);
	}
});

test("authenticated standalone AJYAD HOTEL Airbnb bookings map to Zad Ajyad with explicit OTA commission and PMS root pricing", () => {
	const hotel = {
		_id: "6a40b6a1a6efe70450536038",
		belongsTo: "zad-owner",
		roomCountDetails: [
			{
				_id: "triple-config",
				roomType: "tripleRooms",
				displayName: "Triple Room - Premium Comfort",
				activeRoom: true,
				pricingRate: ["09", "10", "11", "12", "13"].map((day) => ({
					calendarDate: `2026-08-${day}`,
					rootPrice: 75,
					price: 75,
				})),
			},
			{
				_id: "six-bed-config",
				roomType: "familyRooms",
				displayName: "Spacious Six-Bed Room",
				activeRoom: true,
				pricingRate: ["06", "07"].map((day) => ({
					calendarDate: `2026-08-${day}`,
					rootPrice: 0.00001,
					price: 75,
				})),
			},
		],
	};
	const cases = [
		{
			confirmationNumber: "HMZDMHQQRE",
			guestName: "Safwan",
			listingTitle: "COMFORT TRIPLE ROOM - AJYAD HOTEL - FREE BUS",
			stayLine: "Sun, Aug 9 Fri, Aug 14",
			occupancy: "1 adult",
			guestTotal: 370.01,
			payout: 271.88,
			otaCommission: 49.87,
			expectedRoomId: "triple-config",
			expectedRootTotal: 375,
		},
		{
			confirmationNumber: "HMPB4A4EW5",
			guestName: "Imran Qaisar",
			listingTitle: "COMFY FAMILY 6 BEDS ROOM - AJYAD HOTEL - FREE BUS",
			stayLine: "Thu, Aug 6 Sat, Aug 8",
			occupancy: "2 adults, 4 children",
			guestTotal: 170.78,
			payout: 125.48,
			otaCommission: 23.02,
			expectedRoomId: "six-bed-config",
			expectedRootTotal: 0,
		},
	];

	for (const fixture of cases) {
		const normalized = extractNormalizedReservation({
			from: "automated@airbnb.com",
			receivedAt: "2026-08-07T15:53:15Z",
			senderAuthentication: {
				authenticatedAligned: true,
				trustedProvider: "airbnb",
				method: "dkim",
			},
			subject: `Reservation confirmed - ${fixture.guestName}`,
			text: [
				fixture.guestName,
				"Identity verified",
				fixture.listingTitle,
				"Room",
				"Check-in Checkout",
				fixture.stayLine,
				"Guests",
				fixture.occupancy,
				"Confirmation code",
				fixture.confirmationNumber,
				`TOTAL (SAR) SR ${fixture.guestTotal}`,
				`Host service fee (15.5%) -SR ${fixture.otaCommission}`,
				`YOU EARN SR ${fixture.payout}`,
			].join("\n"),
		});

		assert.equal(normalized.hotelId, hotel._id);
		assert.equal(normalized.hotelIdMatchedBy, "standalone ajyad hotel segment");
		assert.equal(normalized.otaCommissionSar, fixture.otaCommission);
		assert.equal(normalized.otaCommissionSource, "airbnb_host_service_fee");
		assert.equal(normalized.sourcePresence.otaCommission, true);
		const built = buildReservationDocument(normalized, hotel);
		assert.equal(built.ok, true);
		assert.equal(
			String(built.document.pickedRoomsType[0].hotelRoomConfigId),
			fixture.expectedRoomId
		);
		assert.equal(built.document.sub_total, fixture.expectedRootTotal);
		assert.equal(built.document.adminPricing.rootTotal, fixture.expectedRootTotal);
		assert.equal(
			built.document.ota_financial_summary.hotelVisibleAmount,
			fixture.expectedRootTotal
		);
		assert.equal(built.document.commission, 0);
		assert.equal(built.document.commission_ota, fixture.otaCommission);
		assert.equal(built.document.adminPricing.commissionAmount, 0);
		assert.equal(built.document.ota_financial_summary.commissionAmount, 0);
		assert.equal(built.document.financial_cycle.commissionValue, 0);
		assert.equal(built.document.financial_cycle.commissionAmount, 0);
		assert.equal(
			built.document.financial_cycle.hotelPayoutDue,
			fixture.expectedRootTotal
		);
		assert.equal(
			built.document.supplierData.otaCommissionSource,
			"airbnb_host_service_fee"
		);
		assert.equal(built.document.supplierData.otaCommissionSourceBacked, true);
		for (const day of built.document.pickedRoomsType[0].pricingByDay) {
			assert.equal(day.commissionRate, 0);
			if (fixture.expectedRootTotal === 0) assert.equal(day.rootPrice, 0);
		}
	}
});

test("Airbnb OTA commission remains unset when Host service fee evidence is conflicting or unauthenticated", () => {
	const base = {
		from: "automated@airbnb.com",
		receivedAt: "2026-08-07T15:53:15Z",
		subject: "Reservation confirmed - Safe Guest",
		text: [
			"SAFE ROOM - AJYAD HOTEL - FREE BUS",
			"Check-in Checkout",
			"Sun, Aug 9 Mon, Aug 10",
			"Guests 1 adult",
			"Confirmation code HMSAFEFEE1",
			"TOTAL (SAR) SR 100.00",
			"Host service fee (15.5%) -SR 15.50",
			"YOU EARN SR 80.00",
		].join("\n"),
	};
	const unauthenticated = extractNormalizedReservation(base);
	assert.equal(unauthenticated.otaCommissionSar, null);
	assert.equal(unauthenticated.sourcePresence.otaCommission, false);

	const conflicting = extractNormalizedReservation({
		...base,
		senderAuthentication: {
			authenticatedAligned: true,
			trustedProvider: "airbnb",
			method: "dkim",
		},
		text: `${base.text}\nHost service fee (15.5%) -SR 16.50`,
	});
	assert.equal(conflicting.otaCommissionSar, null);
	assert.equal(conflicting.sourcePresence.otaCommission, false);
	assert.ok(conflicting.warnings.some((warning) => /conflicting Host service fee/i.test(warning)));
});

test("Airbnb genuinely conflicting repeated check-in dates still require review", () => {
	const normalized = extractNormalizedReservation({
		from: "automated@airbnb.com",
		receivedAt: "2026-08-07T15:53:15Z",
		senderAuthentication: {
			authenticatedAligned: true,
			trustedProvider: "airbnb",
			method: "dkim",
		},
		subject: "Reservation confirmed - Test Guest arrives Aug 9",
		text: [
			"Check-in Checkout",
			"Sun, Aug 9 Fri, Aug 14",
			"Check-in",
			"Sun, Aug 9",
			"Check-in",
			"Mon, Aug 10",
			"Checkout",
			"Fri, Aug 14",
			"Guests",
			"1 adult",
			"Confirmation code",
			"HMTESTCONFLICT",
			"Total (SAR) SAR 145.70",
		].join("\n"),
	});

	assert.equal(normalized.requiresManualReview, true);
	assert.equal(
		normalized.manualReviewReasons.some((reason) =>
			/conflicting repeated explicit check-in/i.test(reason)
		),
		true
	);
});

const compactHotelRunnerArabicActionEmail = ({
	htmlGross = "552",
	htmlIncompleteWithMarker = false,
	omitHtml = false,
} = {}) => {
	const compact = [
		"يتطلب إجراء",
		"اسم الفندق Zad AJYAD Hotel رقم التأكيد R411331378 القناة Direct Plus - Google",
		"اسم النزيل Synthetic Relay Guest الدولة مصر تاريخ تسجيل الوصول نوفمبر 06، 2026",
		"تاريخ تسجيل المغادرة نوفمبر 12، 2026 متوسط السعر اليومي ﷼ 92 الإجمالي الكلي ﷼ 552 المبلغ المستحق ﷼ 552",
		"نوع الغرفة غرفة عائلية -6 أفراد- أجياد- أتوبيس مجانى خطة الوجبة غرفة فقط عدد النزلاء 5 إجمالي الغرفة ﷼ 552 سياسة الإلغاء If cancelled before 48 hours no-payment.",
	].join("\n");
	const expanded = htmlIncompleteWithMarker
		? ["يتطلب إجراء", "اسم الفندق", "Zad AJYAD Hotel", "رقم التأكيد"]
		: [
		"اسم الفندق",
		"Zad AJYAD Hotel",
		"رقم التأكيد",
		"R411331378",
		"القناة",
		"Direct Plus - Google",
		"اسم النزيل",
		"Synthetic Relay Guest",
		"الدولة",
		"مصر",
		"تاريخ تسجيل الوصول",
		"نوفمبر 06، 2026",
		"تاريخ تسجيل المغادرة",
		"نوفمبر 12، 2026",
		"متوسط السعر اليومي",
		"﷼ 92",
		"الإجمالي الكلي",
		`﷼ ${htmlGross}`,
		"المبلغ المستحق",
		"﷼ 552",
		"نوع الغرفة",
		"غرفة عائلية -6 أفراد- أجياد- أتوبيس مجانى",
		"خطة الوجبة",
		"غرفة فقط",
		"عدد النزلاء",
		"5",
		"إجمالي الغرفة",
		"﷼ 552",
		"سياسة الإلغاء",
			"If cancelled before 48 hours no-payment.",
		  ];
	return {
		from: '"HotelRunner" <noreply@hotelrunner.com>',
		to: "ota@example.com",
		subject: "Zad AJYAD Hotel - حجز جديد #R411331378",
		messageId: "hotelrunner-r411331378@mail.hotelrunner.com",
		sourceReceivedAt: "2026-08-13T20:00:00.000Z",
		senderAuthentication: {
			authenticatedAligned: true,
			trustedProvider: "hotelrunner",
			method: "dkim",
		},
		text: compact,
		html: omitHtml
			? ""
			: expanded.map((line) => `<div>${line}</div>`).join(""),
	};
};

test("compact Arabic HotelRunner action-required facts are deterministic across compact and expanded mirrors", () => {
	const normalized = extractNormalizedReservation(
		compactHotelRunnerArabicActionEmail()
	);
	assert.equal(normalized.provider, "hotelrunner");
	assert.equal(normalized.hotelRunnerArabicActionRequiredTemplateMatched, true);
	assert.equal(normalized.hotelRunnerArabicActionRequiredConflict, false);
	assert.equal(normalized.hotelRunnerArabicActionResourceLimitExceeded, false);
	assert.equal(normalized.confirmationNumber, "r411331378");
	assert.equal(normalized.bookingSource, "Direct Plus - Google");
	assert.equal(normalized.sourcePresence.bookingSource, true);
	assert.equal(normalized.hotelName, "Zad AJYAD Hotel");
	assert.equal(normalized.guestName, "Synthetic Relay Guest");
	assert.equal(normalized.nationality, "مصر");
	assert.equal(normalized.checkinDate, "2026-11-06");
	assert.equal(normalized.checkoutDate, "2026-11-12");
	assert.equal(
		normalized.roomName,
		"غرفة عائلية -6 أفراد- أجياد- أتوبيس مجانى"
	);
	assert.equal(normalized.roomCount, 1);
	assert.equal(normalized.totalGuests, 5);
	assert.equal(normalized.totalAmountSar, 552);
	assert.equal(normalized.requiresManualReview, false);
	assert.equal(normalized.blocksUnmappedReservationCreation, false);
	for (const field of [
		"confirmationNumber",
		"hotelName",
		"guestName",
		"roomName",
		"checkinDate",
		"checkoutDate",
		"amount",
		"totalGuests",
		"roomCount",
	]) {
		assert.equal(normalized.sourcePresence[field], true, field);
	}
	assert.deepEqual(requiredNewReservationMissing(normalized), []);

	const absentMirror = extractNormalizedReservation(
		compactHotelRunnerArabicActionEmail({ omitHtml: true })
	);
	assert.equal(absentMirror.hotelRunnerArabicActionRequiredConflict, false);
	assert.equal(absentMirror.hotelRunnerArabicActionResourceLimitExceeded, false);
	assert.equal(absentMirror.bookingSource, "Direct Plus - Google");
});

test("Arabic HotelRunner action parser budgets fail closed before lookup, creation, or mutation", async () => {
	const normal = compactHotelRunnerArabicActionEmail({ omitHtml: true });
	const oversized = {
		...normal,
		text: `${normal.text}\n${"x".repeat(
			MAX_OTA_INBOUND_RAW_REPRESENTATION_BYTES
		)}`,
	};
	const labelFlood = {
		...normal,
		text: `${normal.text}\n${Array.from(
			{ length: MAX_HOTELRUNNER_ARABIC_ACTION_LABEL_OCCURRENCES + 1 },
			() => "اسم الفندق"
		).join(" ")}`,
	};
	const oversizedHtml = {
		...normal,
		html: `<div>${normal.text}</div>${"x".repeat(
			MAX_OTA_INBOUND_RAW_REPRESENTATION_BYTES
		)}`,
	};
	const guarded = [oversized, labelFlood, oversizedHtml].map(
		extractNormalizedReservation
	);
	for (const normalized of guarded) {
		assert.equal(normalized.hotelRunnerArabicActionResourceLimitExceeded, true);
		assert.equal(normalized.requiresManualReview, true);
		assert.equal(normalized.blocksUnmappedReservationCreation, true);
		assert.equal(canCreateUnmappedOtaReviewReservation(normalized, true), false);
		assert.match(
			normalized.manualReviewReasons.join(" "),
			/bounded parser(?: input| analysis)? budget/i
		);
	}

	const orchestrated = await orchestrateInboundReservationEmail(oversized);
	assert.equal(
		orchestrated.normalized.hotelRunnerArabicActionResourceLimitExceeded,
		true
	);
	assert.equal(orchestrated.decision.usedAI, false);
	assert.equal(orchestrated.decision.skipped, true);
	assert.equal(
		orchestrated.decision.skipReason,
		"ota_inbound_parser_resource_limit"
	);
	assert.ok(orchestrated.emailText.length < 1000);
	const orchestratedHtml = await orchestrateInboundReservationEmail(oversizedHtml);
	assert.equal(
		orchestratedHtml.normalized.hotelRunnerArabicActionResourceLimitExceeded,
		true
	);
	assert.equal(
		orchestratedHtml.decision.skipReason,
		"ota_inbound_parser_resource_limit"
	);
	assert.ok(orchestratedHtml.emailText.length < 1000);

	const originals = {
		reservationFind: Reservations.find,
		reservationFindOne: Reservations.findOne,
		reservationCreate: Reservations.create,
		reservationUpdateOne: Reservations.updateOne,
		hotelFind: HotelDetails.find,
		hotelFindOne: HotelDetails.findOne,
	};
	let externalCalls = 0;
	const fail = () => {
		externalCalls += 1;
		throw new Error("Arabic parser resource guard must stop before lookup or write");
	};
	Reservations.find = fail;
	Reservations.findOne = fail;
	Reservations.create = fail;
	Reservations.updateOne = fail;
	HotelDetails.find = fail;
	HotelDetails.findOne = fail;
	try {
		for (const normalized of guarded) {
			for (const lifecycle of [
				{ intent: "new_reservation", eventType: "new", statusToApply: "" },
				{
					intent: "reservation_status",
					eventType: "cancelled",
					statusToApply: "cancelled",
				},
			]) {
				const result = await reconcileOtaReservation({
					...normalized,
					...lifecycle,
				});
				assert.equal(result.status, "hotelrunner_relay_audit_only");
				assert.equal(result.actionTaken, "skipped");
				assert.equal(result.skipReason, "hotelrunner_relay_audit_only");
			}
		}
	} finally {
		Reservations.find = originals.reservationFind;
		Reservations.findOne = originals.reservationFindOne;
		Reservations.create = originals.reservationCreate;
		Reservations.updateOne = originals.reservationUpdateOne;
		HotelDetails.find = originals.hotelFind;
		HotelDetails.findOne = originals.hotelFindOne;
	}
	assert.equal(externalCalls, 0);
});

test("conflicting compact Arabic HotelRunner commercial mirrors fail closed", () => {
	const normalized = extractNormalizedReservation(
		compactHotelRunnerArabicActionEmail({ htmlGross: "553" })
	);
	assert.equal(normalized.hotelRunnerArabicActionRequiredTemplateMatched, true);
	assert.equal(normalized.hotelRunnerArabicActionRequiredConflict, true);
	assert.equal(normalized.requiresManualReview, true);
	assert.equal(normalized.blocksUnmappedReservationCreation, true);
	assert.match(normalized.manualReviewReasons.join(" "), /Arabic action-required/i);
	assert.equal(canCreateUnmappedOtaReviewReservation(normalized, true), false);

	const incompleteMarkerMirror = extractNormalizedReservation(
		compactHotelRunnerArabicActionEmail({ htmlIncompleteWithMarker: true })
	);
	assert.equal(incompleteMarkerMirror.hotelRunnerArabicActionRequiredConflict, true);
	assert.equal(incompleteMarkerMirror.requiresManualReview, true);
	assert.equal(incompleteMarkerMirror.blocksUnmappedReservationCreation, true);
});

test("full-label Arabic HotelRunner mirrors require consensus even without the action marker", () => {
	const matchingEmail = compactHotelRunnerArabicActionEmail();
	const withoutMarker = {
		...matchingEmail,
		text: matchingEmail.text.replace("يتطلب إجراء", ""),
	};
	const matching = extractNormalizedReservation(withoutMarker);
	assert.equal(matching.hotelRunnerArabicActionRequiredTemplateMatched, true);
	assert.equal(matching.hotelRunnerArabicActionRequiredConflict, false);
	assert.equal(matching.requiresManualReview, false);

	const conflicting = extractNormalizedReservation({
		...withoutMarker,
		html: withoutMarker.html.replace("﷼ 552", "﷼ 553"),
	});
	assert.equal(conflicting.hotelRunnerArabicActionRequiredTemplateMatched, true);
	assert.equal(conflicting.hotelRunnerArabicActionRequiredConflict, true);
	assert.equal(conflicting.requiresManualReview, true);
	assert.equal(conflicting.blocksUnmappedReservationCreation, true);
});

test("compact Arabic HotelRunner action-required mutation remains sender-auth gated", async () => {
	const unauthenticated = extractNormalizedReservation({
		...compactHotelRunnerArabicActionEmail(),
		senderAuthentication: {},
	});
	assert.equal(unauthenticated.bookingSource, "Direct Plus - Google");
	assert.equal(unauthenticated.sourceSenderAuthenticated, false);
	const result = await reconcileOtaReservation(unauthenticated);
	assert.equal(result.status, "needs_review");
	assert.equal(result.skipReason, "unauthenticated_ota_sender_no_mutation");
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
	assert.equal(normalized.totalAmountSar, null);
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

test("HotelRunner Arabic ISO currencies retain foreign source evidence without materializing untrusted FX", () => {
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
	assert.equal(normalized.totalAmountSar, null);
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
	assert.equal(built.document.total_amount, null);
	assert.equal(built.document.ota_financial_summary.currency, "SAR");
	assert.equal(built.document.ota_financial_summary.clientTotal, null);
	assert.equal(built.document.ota_financial_summary.netAfterExpenses, null);
	assert.equal(built.document.supplierData.otaSourceCurrency, "AED");
	assert.equal(built.document.supplierData.otaSourceAmount, 100);
	assert.equal(built.document.supplierData.otaAmountSar, null);
	assert.equal(built.document.supplierData.otaCommercialEvidence, undefined);
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
		false
	);
	assert.equal(
		hasAmbiguousMultiRoomEvidence({
			requiresManualReview: true,
			manualReviewReasons: ["The email contains 2 room blocks."],
		}),
		true
	);
	assert.throws(
		() =>
			buildUnmappedOtaReviewReservationDocument({
				...normalized,
				ambiguousMultiRoomEvidence: true,
			}),
		(error) => error?.code === "OTA_INBOUND_AMBIGUOUS_MULTI_ROOM"
	);
	assert.equal(document.hotelId, undefined);
	assert.equal(document.belongsTo, undefined);
	assert.equal(document.pickedRoomsType[0].displayName, "Original OTA Room Wording");
	assert.equal(document.pickedRoomsType[0].hotelRoomConfigId, undefined);
	assert.equal(document.pickedRoomsType[0].pricingByDay[0].rootPrice, 0);
	assert.equal(document.otaPlatformReview.hotelAssignmentRequired, true);
	assert.equal(document.adminPricing.hotelAssignmentRequired, true);
});

test("an exact active source-backed hotel stays selected when the OTA room must remain unmapped", () => {
	const normalized = {
		provider: "agoda",
		providerLabel: "Agoda",
		bookingSource: "Agoda",
		confirmationNumber: "2038703612",
		reservationId: "2038703612",
		guestName: "Protected Guest",
		hotelName: "Zad Ajyad",
		roomName: "Deluxe Family Room 2 - 4 Occupancy",
		checkinDate: "2026-09-06",
		checkoutDate: "2026-09-13",
		amount: 369.93,
		totalAmountSar: 369.93,
		currency: "SAR",
		eventType: "new",
		inboundEmailId: "audit-exact-hotel-unmapped-room",
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
	const document = buildUnmappedOtaReviewReservationDocument(normalized);
	const assignedAt = new Date("2026-08-05T12:30:00.000Z");
	const assigned = applyExactResolvedHotelToUnmappedReview(
		document,
		{
			_id: "6a40b6a1a6efe70450536038",
			belongsTo: "68b74714fb50e159d48c714d",
			hotelName: "Zad Ajyad",
			activateHotel: true,
			xHotelProActive: true,
		},
		normalized,
		{ at: assignedAt }
	);

	assert.equal(assigned, true);
	assert.equal(String(document.hotelId), "6a40b6a1a6efe70450536038");
	assert.equal(String(document.belongsTo), "68b74714fb50e159d48c714d");
	assert.deepEqual(document.roomId, []);
	assert.equal(document.sub_total, 0);
	assert.equal(document.commission, 0);
	assert.equal(document.pickedRoomsType[0].hotelRoomConfigId, undefined);
	assert.equal(document.pickedRoomsType[0].pricingByDay[0].rootPrice, 0);
	assert.equal(document.otaPlatformReview.status, "pending");
	assert.equal(document.otaPlatformReview.hotelAssignmentRequired, false);
	assert.equal(document.otaPlatformReview.hotelAssignmentStatus, "assigned");
	assert.equal(document.otaPlatformReview.roomMappingStatus, "unreviewed");
	assert.equal(document.adminPricing.hotelAssignmentRequired, false);
	assert.equal(document.adminPricing.pricingReviewRequired, true);
	assert.equal(document.adminPricing.rootTotal, 0);
	assert.equal(document.supplierData.otaHotelMappingRequired, false);
	assert.equal(document.supplierData.otaHotelRoomConfigId, null);

	const fuzzyDocument = buildUnmappedOtaReviewReservationDocument({
		...normalized,
		hotelName: "Zed Place near Ajyad",
	});
	assert.equal(
		applyExactResolvedHotelToUnmappedReview(
			fuzzyDocument,
			{
				_id: "6a40b6a1a6efe70450536038",
				belongsTo: "68b74714fb50e159d48c714d",
				hotelName: "Zad Ajyad",
				activateHotel: true,
				xHotelProActive: true,
			},
			{ ...normalized, hotelName: "Zed Place near Ajyad" }
		),
		false,
		"a merely fuzzy hotel resolution cannot auto-assign the reservation"
	);
	assert.equal(fuzzyDocument.hotelId, undefined);
});

test("new inbound reservations keep an exact hotel selected while incompatible semantic rooms stay in protected review", async () => {
	const originalReservationFind = Reservations.find;
	const originalReservationExists = Reservations.exists;
	const originalReservationCreate = Reservations.create;
	const originalHotelFind = HotelDetails.find;
	const originalRandom = Math.random;
	let createdDocument = null;
	let createCalls = 0;
	const hotel = {
		_id: "6a40b6a1a6efe70450536038",
		belongsTo: "68b74714fb50e159d48c714d",
		hotelName: "Zad Ajyad",
		activateHotel: true,
		xHotelProActive: true,
		roomCountDetails: [
			{
				_id: "room-quad-four",
				roomType: "quadRooms",
				displayName: "Quadruple Room",
				activeRoom: true,
				price: { basePrice: 75 },
			},
			{
				_id: "room-family-five",
				roomType: "familyRooms",
				displayName: "Family Room for Five",
				activeRoom: true,
				price: { basePrice: 75 },
			},
			{
				_id: "room-family-six",
				roomType: "familyRooms",
				displayName: "Family Room for Six",
				activeRoom: true,
				price: { basePrice: 75 },
			},
		],
	};
	Reservations.find = () => ({
		limit() {
			return this;
		},
		select() {
			return this;
		},
		async exec() {
			return [];
		},
	});
	Reservations.exists = async () => false;
	Reservations.create = async (document) => {
		createCalls += 1;
		if (createCalls === 1) {
			const error = new Error("simulated PMS confirmation collision");
			error.code = 11000;
			throw error;
		}
		createdDocument = document;
		return { ...document, _id: "created-exact-hotel-review" };
	};
	HotelDetails.find = () => ({
		select() {
			return this;
		},
		async lean() {
			return [hotel];
		},
	});

	try {
		const randomForConfirmation = (value) =>
			(Number(value) - 1000000000 + 0.25) / 9000000000;
		const generatedCandidates = [
			"2038704202",
			"2207032113",
			"2038704202",
			"2307032113",
		];
		Math.random = () =>
			randomForConfirmation(generatedCandidates.shift());
		const directNormalized = {
			inboundEmailId: "audit-family-four-no-family-config",
			provider: "agoda",
			providerLabel: "Agoda",
			bookingSource: "Agoda",
			confirmationNumber: "2038704202",
			reservationId: "2038704202",
			intent: "new_reservation",
			eventType: "new",
			guestName: "Protected Guest",
			hotelName: "Zad Ajyad",
			roomName: "Deluxe Family Room 2 - 4 Occupancy",
			checkinDate: "2026-09-08",
			checkoutDate: "2026-09-13",
			amount: 266.83,
			currency: "SAR",
			totalAmountSar: 266.83,
			roomCount: 1,
			totalGuests: 4,
			adults: 4,
			children: 0,
			sourceSenderTrusted: true,
			sourceSenderAuthenticated: true,
			sourcePresence: {
				confirmationNumber: true,
				reservationId: true,
				guestName: true,
				hotelName: true,
				roomName: true,
				checkinDate: true,
				checkoutDate: true,
				amount: true,
				roomCount: true,
				totalGuests: true,
				adults: true,
				children: true,
			},
			source: {
				from: "HotelRunner <noreply@hotelrunner.com>",
				messageId: "family-four-no-family-config",
				receivedAt: "2026-08-05T09:31:55.000Z",
			},
		};
		const result = await reconcileOtaReservation(directNormalized);
		assert.equal(result.status, "created");
		assert.equal(createCalls, 2);
		assert.equal(result.actionTaken, "created_unmapped_ota_review");
		assert.equal(String(result.hotelId), hotel._id);
		assert.equal(String(createdDocument.hotelId), hotel._id);
		assert.equal(String(createdDocument.belongsTo), hotel.belongsTo);
		assert.equal(createdDocument.confirmation_number, "2307032113");
		assert.notEqual(
			createdDocument.confirmation_number,
			directNormalized.confirmationNumber
		);
		assert.equal(
			createdDocument.supplierData.pmsConfirmationNumber,
			createdDocument.confirmation_number
		);
		assert.deepEqual(createdDocument.roomId, []);
		assert.equal(createdDocument.sub_total, 0);
		assert.equal(createdDocument.otaPlatformReview.status, "pending");
		assert.equal(
			createdDocument.otaPlatformReview.hotelAssignmentRequired,
			false
		);
		assert.equal(createdDocument.adminPricing.rootTotal, 0);
		assert.equal(createdDocument.adminPricing.pricingReviewRequired, true);
		assert.equal(createdDocument.financial_cycle.hotelPayoutDue, 0);
		assert.equal(createdDocument.supplierData.otaSourceAuthority, 1);
		assert.equal(createdDocument.supplierData.otaRoomCount, 1);
		assert.equal(createdDocument.supplierData.otaRoomCountSourceBacked, true);
		assert.equal(createdDocument.supplierData.otaTotalGuests, 4);
		assert.equal(createdDocument.supplierData.otaTotalGuestsSourceBacked, true);
		assert.equal(createdDocument.supplierData.otaStayDatesSourceBacked, true);
		assert.equal(
			createdDocument.pickedRoomsType[0].hotelRoomConfigId,
			undefined
		);
	} finally {
		Reservations.find = originalReservationFind;
		Reservations.exists = originalReservationExists;
		Reservations.create = originalReservationCreate;
		HotelDetails.find = originalHotelFind;
		Math.random = originalRandom;
	}
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
		null
	);
	assert.equal(
		set["otaPlatformReview.proposedInbound"].pricing.sourceAmount,
		999
	);
	assert.equal(
		set["otaPlatformReview.proposedInbound"].pricing.sourceCurrency,
		"SAR"
	);
	assert.equal(
		set["otaPlatformReview.proposedInbound"].pricing.totalPayoutSar,
		null
	);
});

test("a staged OTA modification preserves canonical commercial evidence and retains the incoming hash for review", () => {
	const canonicalEvidence = buildAuthenticatedProviderCommercialEvidence({
		provider: "trip",
		authenticatedProvider: "trip",
		sourceAuthenticated: true,
		sourceTrusted: true,
		sourceType: "authenticated_ota_email",
		sourceCurrency: "SAR",
		propertyCurrency: "SAR",
		bookingBasis: "reservation_total",
		sourceHash: "a".repeat(64),
		sourceTimestamp: "2026-08-09T10:00:00.000Z",
		sourceId: "trip-accepted-commercial",
		guestGross: { verified: true, amount: 60.22 },
		hotelPayout: { verified: true, amount: 56.89 },
	});
	const incomingEvidence = buildAuthenticatedProviderCommercialEvidence({
		provider: "trip",
		authenticatedProvider: "trip",
		sourceAuthenticated: true,
		sourceTrusted: true,
		sourceType: "authenticated_ota_email",
		sourceCurrency: "SAR",
		propertyCurrency: "SAR",
		bookingBasis: "reservation_total",
		sourceHash: "b".repeat(64),
		sourceTimestamp: "2026-08-10T10:00:00.000Z",
		sourceId: "trip-cancellation-request",
		guestGross: { verified: true, amount: 56.89 },
	});
	const set = buildExistingReservationUpdateSet({
		normalized: {
			inboundEmailId: "trip-cancellation-request",
			intent: "reservation_update",
			eventType: "modified",
			provider: "trip",
			providerLabel: "Trip.com",
			confirmationNumber: "1539366680929675",
			amount: 56.89,
			totalAmountSar: 56.89,
			sourceAmount: 56.89,
			sourceCurrency: "SAR",
			otaCommercialEvidence: incomingEvidence,
			sourcePresence: {
				confirmationNumber: true,
				amount: true,
			},
		},
		existing: {
			otaIdentityKey: "trip:1539366680929675",
			supplierData: { otaCommercialEvidence: canonicalEvidence },
		},
	});

	assert.equal(set["supplierData.otaCommercialEvidence"], undefined);
	assert.equal(
		set["otaPlatformReview.proposedInbound"].pricing.commercialEvidenceHash,
		incomingEvidence.evidenceHash
	);
	assert.equal(canonicalEvidence.roles.guestGross.propertyAmount, 60.22);
});

test("an authoritative rebuilt OTA refresh persists only its document evidence generation", () => {
	const normalizedEvidence = buildAuthenticatedProviderCommercialEvidence({
		provider: "agoda",
		authenticatedProvider: "agoda",
		sourceAuthenticated: true,
		sourceTrusted: true,
		sourceType: "authenticated_ota_email",
		sourceCurrency: "SAR",
		propertyCurrency: "SAR",
		bookingBasis: "reservation_total",
		sourceHash: "d".repeat(64),
		sourceTimestamp: "2026-08-11T09:59:00.000Z",
		sourceId: "agoda-prebuild-generation",
		guestGross: { verified: true, amount: 100 },
		hotelPayout: { verified: true, amount: 79 },
	});
	const documentEvidence = buildAuthenticatedProviderCommercialEvidence({
		provider: "agoda",
		authenticatedProvider: "agoda",
		sourceAuthenticated: true,
		sourceTrusted: true,
		sourceType: "authenticated_ota_email",
		sourceCurrency: "SAR",
		propertyCurrency: "SAR",
		bookingBasis: "reservation_total",
		sourceHash: "c".repeat(64),
		sourceTimestamp: "2026-08-11T10:00:00.000Z",
		sourceId: "agoda-authoritative-refresh",
		guestGross: { verified: true, amount: 100 },
		hotelPayout: { verified: true, amount: 80 },
	});
	const set = buildExistingReservationUpdateSet({
		normalized: {
			provider: "agoda",
			intent: "reservation_update",
			eventType: "modified",
			authoritativeExistingRefresh: true,
			otaCommercialEvidence: normalizedEvidence,
			amount: 100,
			totalAmountSar: 100,
			sourcePresence: { amount: true },
		},
		existing: {},
		document: {
			total_amount: 100,
			supplierData: { otaCommercialEvidence: documentEvidence },
		},
	});

	assert.deepEqual(
		set["supplierData.otaCommercialEvidence"],
		documentEvidence
	);
	assert.notEqual(
		set["supplierData.otaCommercialEvidence"].evidenceHash,
		normalizedEvidence.evidenceHash
	);
	assert.equal(set["otaPlatformReview.proposedInbound"], null);
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
			supplierData: {
				otaProvider: "hotelrunner",
				supplierName: "HotelRunner",
			},
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

test("authenticated direct refresh upgrades both HotelRunner commercial-source displays", () => {
	const normalized = {
		provider: "agoda",
		providerLabel: "Agoda",
		bookingSource: "Agoda",
		authoritativeExistingRefresh: true,
		sourceSenderTrusted: true,
		sourceSenderAuthenticated: true,
		sourcePresence: { bookingSource: true },
		source: { from: "Agoda <no-reply@agoda.com>" },
	};
	const set = buildExistingReservationUpdateSet({
		normalized,
		existing: {
			booking_source: "HotelRunner",
			customer_details: { booking_source: "HotelRunner" },
			supplierData: { supplierName: "HotelRunner" },
		},
		document: {
			booking_source: "Agoda",
			customer_details: { booking_source: "Agoda" },
			supplierData: { supplierName: "Agoda" },
		},
	});

	assert.equal(set.booking_source, "Agoda");
	assert.equal(set["customer_details.booking_source"], "Agoda");
	assert.equal(set["supplierData.supplierName"], "Agoda");
});

test("authoritative rebuilt documents cannot overwrite unrelated supplier metadata", () => {
	const set = buildExistingReservationUpdateSet({
		normalized: {
			provider: "agoda",
			providerLabel: "Agoda",
			bookingSource: "Agoda",
			authoritativeExistingRefresh: true,
			sourceSenderTrusted: true,
			sourceSenderAuthenticated: true,
			sourcePresence: { bookingSource: true },
			source: { from: "Agoda <no-reply@agoda.com>" },
		},
		existing: {
			booking_source: "Agoda",
			customer_details: { booking_source: "Agoda" },
			supplierData: { supplierName: "Bedbank Contract 17" },
		},
		document: {
			booking_source: "Agoda",
			customer_details: { booking_source: "Agoda" },
			supplierData: { supplierName: "Agoda" },
		},
	});

	assert.equal(set["supplierData.supplierName"], undefined);
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
		booking_source: "Direct",
		customer_details: {
			name: "Lower Authority Guest",
			booking_source: "Direct",
		},
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
			booking_source: "Agoda",
			customer_details: {
				booking_source: "Agoda",
				name: "Waqas Khan",
				email: "no-email@jannatbooking.com",
				phone: "0000",
				passport: "Not Provided",
			},
			checkin_date: "2026-07-23",
			checkout_date: "2026-07-24",
			total_amount: null,
			commission_ota: null,
			adminPricing: { clientTotal: null, netAfterExpensesTotal: null },
			ota_financial_summary: {
				clientTotal: null,
				netAfterExpenses: null,
			},
			adminPricingVisibility: { rootOnlyForHotelManagement: true },
			supplierData: {
				otaAmountSar: null,
				otaTotalPayoutSar: null,
				otaExpenseTotalSar: null,
				otaPlatformMarginSar: null,
				otaCommissionSar: null,
			},
		},
	});
	assert.equal(withDocument["customer_details.name"], "Waqas Khan");
	assert.equal(withDocument.checkin_date, "2026-07-23");
	assert.equal(withDocument["customer_details.email"], undefined);
	assert.equal(withDocument["customer_details.phone"], undefined);
	assert.equal(withDocument["customer_details.passport"], undefined);
	assert.equal(withDocument.total_amount, null);
	assert.equal(withDocument.commission_ota, null);
	assert.equal(withDocument["supplierData.otaAmountSar"], null);
	assert.equal(withDocument["supplierData.otaTotalPayoutSar"], null);
	assert.equal(withDocument["supplierData.otaExpenseTotalSar"], null);
	assert.equal(withDocument["supplierData.otaPlatformMarginSar"], null);
	assert.equal(withDocument["supplierData.otaCommissionSar"], null);
	assert.equal(withDocument.booking_source, undefined);
	assert.equal(withDocument["customer_details.booking_source"], undefined);
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

test("lower-authority relay lifecycle events cannot overwrite a direct HotelRunner API projection", async () => {
	const originalReservationFind = Reservations.find;
	const originalReservationUpdateOne = Reservations.updateOne;
	let mutationCalls = 0;
	const existing = makeCancellationOverrideExisting("confirmed", {
		supplierData: {
			otaAutomationPipeline: "hotelrunner-background-worker",
			otaProvider: "booking",
			otaSourceAuthority: 4,
			otaLastSourceReceivedAt: "2026-08-06T12:00:00.000Z",
			hotelRunner: {
				transport: "hotelrunner_api",
				reservationId: "hr-direct-authority-1",
			},
		},
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
		throw new Error("lower-authority relay must not mutate the reservation");
	};

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
			const normalized = makeTrustedInboundCancellation({
				...lifecycle,
				source: {
					from: '"HotelRunner" <noreply@hotelrunner.com>',
					subject: "HotelRunner relayed lifecycle update",
					receivedAt: "2026-08-06T12:05:00.000Z",
					timestampMethod: "rfc2822_date_header",
				},
			});
			assert.equal(
				lowerAuthorityOtaLifecycleMustYieldToHotelRunnerApi(
					normalized,
					existing
				),
				true
			);
			assert.deepEqual(
				buildExistingReservationUpdateSet({ normalized, existing }),
				{}
			);
			const result = await reconcileOtaReservation(normalized);
			assert.equal(result.status, "ignored");
			assert.equal(result.actionTaken, "skipped");
			assert.equal(
				result.skipReason,
				"lower_authority_ota_lifecycle_after_hotelrunner_api"
			);
		}
	} finally {
		Reservations.find = originalReservationFind;
		Reservations.updateOne = originalReservationUpdateOne;
	}
	assert.equal(mutationCalls, 0);
});

test("email-only mode restores trusted OTA lifecycle authority without erasing HotelRunner provenance", () => {
	const previous = process.env.HOTELRUNNER_INTEGRATION_ENABLED;
	process.env.HOTELRUNNER_INTEGRATION_ENABLED = "false";
	try {
		const existing = makeCancellationOverrideExisting("confirmed", {
			supplierData: {
				otaAutomationPipeline: "hotelrunner-background-worker",
				otaProvider: "booking",
				otaSourceAuthority: 4,
				otaLastSourceReceivedAt: "2026-08-06T12:00:00.000Z",
				hotelRunner: {
					transport: "hotelrunner_api",
					reservationId: "hr-historical-provenance-1",
				},
			},
		});
		const normalized = makeTrustedInboundCancellation({
			source: {
				from: '"Booking.com" <noreply@booking.com>',
				subject: "Reservation cancelled",
				receivedAt: "2026-08-06T12:05:00.000Z",
				timestampMethod: "rfc2822_date_header",
			},
		});
		assert.equal(
			lowerAuthorityOtaLifecycleMustYieldToHotelRunnerApi(
				normalized,
				existing
			),
			false
		);
		const update = buildExistingReservationUpdateSet({
			normalized,
			existing,
			statusToApply: "cancelled",
		});
		assert.equal(update.state, "cancelled");
		assert.equal(update.reservation_status, "cancelled");
		assert.equal(update["supplierData.hotelRunner.transport"], undefined);
		assert.equal(update["supplierData.hotelRunner.reservationId"], undefined);
		assert.equal(
			existing.supplierData.hotelRunner.reservationId,
			"hr-historical-provenance-1"
		);
	} finally {
		if (previous === undefined) {
			delete process.env.HOTELRUNNER_INTEGRATION_ENABLED;
		} else {
			process.env.HOTELRUNNER_INTEGRATION_ENABLED = previous;
		}
	}
});

test("email-only mode applies a trusted cancellation to a historical HotelRunner row exactly once", async () => {
	const previous = process.env.HOTELRUNNER_INTEGRATION_ENABLED;
	const originalReservationFind = Reservations.find;
	const originalReservationUpdateOne = Reservations.updateOne;
	const existing = makeCancellationOverrideExisting("confirmed", {
		supplierData: {
			otaAutomationPipeline: "hotelrunner-background-worker",
			otaProvider: "booking",
			otaSourceAuthority: 4,
			otaLastSourceReceivedAt: "2026-08-06T12:00:00.000Z",
			hotelRunner: {
				transport: "hotelrunner_api",
				reservationId: "hr-historical-cas-1",
			},
		},
	});
	const writes = [];
	process.env.HOTELRUNNER_INTEGRATION_ENABLED = "false";
	Reservations.find = () => ({
		limit() {
			return this;
		},
		async exec() {
			return [existing];
		},
	});
	Reservations.updateOne = async (filter, update) => {
		writes.push({ filter, update });
		return { matchedCount: 1 };
	};

	try {
		const result = await reconcileOtaReservation(
			makeTrustedInboundCancellation({
				source: {
					from: '"Booking.com" <noreply@booking.com>',
					subject: "Reservation cancelled",
					receivedAt: "2026-08-06T12:05:00.000Z",
					timestampMethod: "rfc2822_date_header",
				},
			})
		);
		assert.equal(result.status, "cancelled");
		assert.equal(writes.length, 1);
		assert.equal(writes[0].update.$set.state, "cancelled");
		assert.equal(writes[0].update.$set.reservation_status, "cancelled");
		assert.equal(
			writes[0].update.$set["supplierData.hotelRunner.transport"],
			undefined
		);
		assert.equal(
			writes[0].update.$set["supplierData.hotelRunner.reservationId"],
			undefined
		);
		assert.equal(
			existing.supplierData.hotelRunner.reservationId,
			"hr-historical-cas-1"
		);
	} finally {
		Reservations.find = originalReservationFind;
		Reservations.updateOne = originalReservationUpdateOne;
		if (previous === undefined) {
			delete process.env.HOTELRUNNER_INTEGRATION_ENABLED;
		} else {
			process.env.HOTELRUNNER_INTEGRATION_ENABLED = previous;
		}
	}
});

test("email-only mode stages trusted modifications for historical HotelRunner rows", () => {
	const previous = process.env.HOTELRUNNER_INTEGRATION_ENABLED;
	process.env.HOTELRUNNER_INTEGRATION_ENABLED = "false";
	try {
		const existing = makeCancellationOverrideExisting("confirmed", {
			customer_details: { name: "Canonical Guest" },
			checkin_date: "2026-09-01",
			checkout_date: "2026-09-02",
			total_amount: 300,
			supplierData: {
				otaLastSourceReceivedAt: "2026-08-06T12:00:00.000Z",
				hotelRunner: {
					transport: "hotelrunner_api",
					reservationId: "hr-historical-modification-1",
				},
			},
		});
		const normalized = makeTrustedInboundCancellation({
			intent: "reservation_update",
			eventType: "modified",
			statusToApply: "",
			guestName: "Proposed Guest",
			checkinDate: "2026-09-03",
			checkoutDate: "2026-09-05",
			amount: 900,
			totalAmountSar: 900,
			sourcePresence: {
				guestName: true,
				checkinDate: true,
				checkoutDate: true,
				amount: true,
			},
			source: {
				receivedAt: "2026-08-06T12:05:00.000Z",
				timestampMethod: "rfc2822_date_header",
			},
		});
		const update = buildExistingReservationUpdateSet({ normalized, existing });
		assert.equal(update["customer_details.name"], undefined);
		assert.equal(update.checkin_date, undefined);
		assert.equal(update.checkout_date, undefined);
		assert.equal(update.total_amount, undefined);
		assert.equal(
			update["otaPlatformReview.proposedInbound"].guest.name,
			"Proposed Guest"
		);
		assert.equal(
			update["supplierData.hotelRunner.reservationId"],
			undefined
		);
	} finally {
		if (previous === undefined) {
			delete process.env.HOTELRUNNER_INTEGRATION_ENABLED;
		} else {
			process.env.HOTELRUNNER_INTEGRATION_ENABLED = previous;
		}
	}
});

test("HotelRunner-managed properties retain OTA email fallback until a reservation has direct API ownership", async () => {
	const originalToken = process.env.HOTELRUNNER_API_TOKEN;
	const originalHrId = process.env.HOTELRUNNER_API_HR_ID;
	const originalSupported = process.env.HOTELRUNNER_SUPPORTED_HOTELIDS;
	const originalProjection = process.env.HOTELRUNNER_PROJECTION_ENABLED;
	const originalReservationFind = Reservations.find;
	const originalReservationExists = Reservations.exists;
	const originalReservationUpdateOne = Reservations.updateOne;
	const originalReservationCreate = Reservations.create;
	const originalHotelFind = HotelDetails.find;
	const originalHotelFindById = HotelDetails.findById;
	const managedHotelId = "64b0000000000000000000a1";
	const ordinaryHotelId = "64b0000000000000000000b1";
	let createdDocument = null;
	let existing = makeCancellationOverrideExisting("confirmed", {
		hotelId: managedHotelId,
	});
	let writes = 0;
	let createAttempts = 0;

	process.env.HOTELRUNNER_API_TOKEN = "synthetic-hotelrunner-token";
	process.env.HOTELRUNNER_API_HR_ID = "synthetic-hotelrunner-property";
	process.env.HOTELRUNNER_SUPPORTED_HOTELIDS = ` ${managedHotelId} `;
	process.env.HOTELRUNNER_PROJECTION_ENABLED = "true";
	Reservations.find = () => ({
		limit() {
			return this;
		},
		select() {
			return this;
		},
		maxTimeMS() {
			return this;
		},
		lean() {
			return this;
		},
		async exec() {
			return existing ? [existing] : [];
		},
	});
	Reservations.updateOne = async () => {
		writes += 1;
		return { matchedCount: 1 };
	};
	Reservations.exists = async () => false;
	Reservations.create = async (document) => {
		writes += 1;
		createAttempts += 1;
		if (createAttempts === 1) {
			const error = new Error("simulated mapped PMS confirmation collision");
			error.code = 11000;
			throw error;
		}
		createdDocument = document;
		return { ...document, _id: "managed-email-fallback-reservation" };
	};
	HotelDetails.findById = () => {
		throw new Error("an existing lifecycle update should not need hotel lookup");
	};
	HotelDetails.find = () => ({
		select() {
			return this;
		},
		async lean() {
			return [
				{
					_id: managedHotelId,
					hotelName: "Zad Ajyad",
					belongsTo: "64b0000000000000000000c1",
					activateHotel: true,
					xHotelProActive: true,
					currency: "SAR",
					roomCountDetails: HOTEL_ROOMS,
				},
			];
		},
	});

	try {
		const managedLifecycle = await reconcileOtaReservation(
			makeTrustedInboundCancellation()
		);
		assert.equal(managedLifecycle.status, "cancelled");
		assert.equal(managedLifecycle.hotelId, managedHotelId);
		assert.equal(writes, 1);

		existing = makeCancellationOverrideExisting("confirmed", {
			hotelId: managedHotelId,
			supplierData: {
				otaAutomationPipeline: "hotelrunner-background-worker",
				otaProvider: "booking",
				otaSourceAuthority: 4,
				otaLastSourceReceivedAt: "2026-08-06T12:00:00.000Z",
				hotelRunner: {
					transport: "hotelrunner_api",
					reservationId: "hr-direct-managed-1",
				},
			},
		});
		const directProjectedLifecycle = await reconcileOtaReservation(
			makeTrustedInboundCancellation({
				inboundEmailId: "managed-direct-projected-cancellation",
				source: {
					messageId: "managed-direct-projected-cancellation-message",
					receivedAt: "2026-08-06T12:05:00.000Z",
				},
			})
		);
		assert.equal(directProjectedLifecycle.status, "ignored");
		assert.equal(directProjectedLifecycle.actionTaken, "skipped");
		assert.equal(
			directProjectedLifecycle.skipReason,
			"lower_authority_ota_lifecycle_after_hotelrunner_api"
		);
		assert.equal(writes, 1);

		existing = null;
		HotelDetails.findById = () => ({
			select() {
				return this;
			},
			lean() {
				return this;
			},
			async exec() {
				return {
					_id: managedHotelId,
					hotelName: "Zad Ajyad",
					roomCountDetails: HOTEL_ROOMS,
				};
			},
		});
		const mappedExternalConfirmation = "2041108213";
		const originalRandom = Math.random;
		const randomForConfirmation = (value) =>
			(Number(value) - 1000000000 + 0.25) / 9000000000;
		const generatedCandidates = [
			mappedExternalConfirmation,
			"2207032113",
			mappedExternalConfirmation,
			"2307032113",
		];
		Math.random = () =>
			randomForConfirmation(generatedCandidates.shift());
		let managedCreation;
		try {
			managedCreation = await reconcileOtaReservation({
			inboundEmailId: "managed-hotel-new-email",
			provider: "booking",
			providerLabel: "Booking.com",
			bookingSource: "Booking.com",
			confirmationNumber: mappedExternalConfirmation,
			reservationId: mappedExternalConfirmation,
			intent: "new_reservation",
			eventType: "new",
			guestName: "Managed Hotel Guest",
			hotelName: "Zad Ajyad",
			roomName: "Double Room",
			checkinDate: "2026-08-10",
			checkoutDate: "2026-08-11",
			amount: 100,
			totalAmountSar: 100,
			sourceAmount: 100,
			sourceCurrency: "SAR",
			totalPayoutSar: 80,
			netAfterExpensesTotal: 80,
			currency: "SAR",
			exchangeRateToSar: 1,
			sourceExchangeRateToSar: 1,
			paymentCollectionModel: "ota_collect",
			paymentInstructions: "Booking.com collected by platform",
			paymentSummary: {
				sourceCurrency: "SAR",
				sourceTotalGuestPaymentAmount: 100,
				sourceTotalPayoutAmount: 80,
				totalGuestPaymentAmount: 100,
				totalPayoutAmount: 80,
				currency: "SAR",
				exchangeRateToSar: 1,
			},
			roomCount: 1,
			totalGuests: 2,
			adults: 2,
			children: 0,
			sourceSenderTrusted: true,
			sourceSenderAuthenticated: true,
			trustedTransportProvider: "booking",
			sourcePresence: {
				confirmationNumber: true,
				guestName: true,
				hotelName: true,
				roomName: true,
				checkinDate: true,
				checkoutDate: true,
				amount: true,
				roomCount: true,
				totalGuests: true,
				paymentCollectionModel: true,
				paymentInstructions: true,
			},
			source: {
				from: "Booking.com <noreply@booking.com>",
				subject: "New reservation for Zad Ajyad",
				messageId: "managed-hotel-new-email-message",
				receivedAt: "2026-08-06T13:00:00.000Z",
				timestampMethod: "rfc2822_date_header",
				textHash: immutableFixtureTextHash(
					"Booking.com authenticated commercial email",
					"managed-hotel-new-email-message",
					mappedExternalConfirmation,
					100,
					80
				),
			},
			});
		} finally {
			Math.random = originalRandom;
		}
		assert.equal(managedCreation.status, "created");
		assert.equal(managedCreation.hotelId, managedHotelId);
		assert.equal(String(createdDocument.hotelId), managedHotelId);
		assert.equal(createAttempts, 2);
		assert.equal(createdDocument.confirmation_number, "2307032113");
		assert.notEqual(
			createdDocument.confirmation_number,
			mappedExternalConfirmation
		);
		assert.equal(createdDocument.total_amount, 100);
		assert.equal(createdDocument.total_rooms, 1);
		assert.equal(createdDocument.pickedRoomsType[0].room_type, "doubleRooms");
		assert.equal(createdDocument.supplierData.otaSourceAuthority, 3);
		const commercialEvidence =
			createdDocument.supplierData.otaCommercialEvidence;
		assert.equal(validateOtaCommercialEvidence(commercialEvidence).ok, true);
		assert.equal(commercialEvidence.provider, "booking");
		assert.equal(
			commercialEvidence.roles.guestGross.propertyAmount,
			100
		);
		assert.equal(
			commercialEvidence.roles.hotelPayout.propertyAmount,
			80
		);
		assert.equal(writes, 3);

		existing = makeCancellationOverrideExisting("confirmed", {
			hotelId: ordinaryHotelId,
		});
		HotelDetails.findById = () => {
			throw new Error("ordinary lifecycle update should not need hotel lookup");
		};
		const ordinaryLifecycle = await reconcileOtaReservation(
			makeTrustedInboundCancellation({
				inboundEmailId: "ordinary-hotel-cancellation",
				source: {
					from: "Booking.com <noreply@booking.com>",
					subject: "Reservation cancelled",
					messageId: "ordinary-hotel-cancellation-message",
					receivedAt: "2026-08-04T11:00:01.000Z",
					timestampMethod: "rfc2822_date_header",
				},
			})
		);
		assert.equal(ordinaryLifecycle.status, "cancelled");
		assert.equal(writes, 4);
	} finally {
		if (originalToken === undefined) {
			delete process.env.HOTELRUNNER_API_TOKEN;
		} else {
			process.env.HOTELRUNNER_API_TOKEN = originalToken;
		}
		if (originalHrId === undefined) {
			delete process.env.HOTELRUNNER_API_HR_ID;
		} else {
			process.env.HOTELRUNNER_API_HR_ID = originalHrId;
		}
		if (originalSupported === undefined) {
			delete process.env.HOTELRUNNER_SUPPORTED_HOTELIDS;
		} else {
			process.env.HOTELRUNNER_SUPPORTED_HOTELIDS = originalSupported;
		}
		if (originalProjection === undefined) {
			delete process.env.HOTELRUNNER_PROJECTION_ENABLED;
		} else {
			process.env.HOTELRUNNER_PROJECTION_ENABLED = originalProjection;
		}
		Reservations.find = originalReservationFind;
		Reservations.exists = originalReservationExists;
		Reservations.updateOne = originalReservationUpdateOne;
		Reservations.create = originalReservationCreate;
		HotelDetails.find = originalHotelFind;
		HotelDetails.findById = originalHotelFindById;
	}
});

const HOTELRUNNER_COMMERCIAL_CONFIRMATION = "managed-commercial-1001";
const HOTELRUNNER_COMMERCIAL_HOTEL_ID = "64b0000000000000000000d1";
const HOTELRUNNER_COMMERCIAL_OWNER_ID = "64b0000000000000000000e1";
const HOTELRUNNER_COMMERCIAL_ROOM_ID = "64b0000000000000000000f1";

const makeVerifiedHotelRunnerCommercialEmail = (overrides = {}) => {
	const provider = String(overrides.provider || "booking").toLowerCase();
	const isAgoda = provider === "agoda";
	const basePaymentSummary = {
		sourceCurrency: "SAR",
		sourceTotalGuestPaymentAmount: 100,
		sourceTotalPayoutAmount: 80,
		totalGuestPaymentAmount: 100,
		totalPayoutAmount: 80,
		currency: "SAR",
		exchangeRateToSar: 1,
	};
	const baseSourcePresence = {
		confirmationNumber: true,
		guestName: true,
		hotelName: true,
		roomName: true,
		checkinDate: true,
		checkoutDate: true,
		amount: true,
		roomCount: true,
		totalGuests: true,
		paymentCollectionModel: true,
		paymentInstructions: true,
	};
	const baseSource = {
		from: isAgoda
			? "Agoda <no-reply@agoda.com>"
			: "Booking.com <noreply@booking.com>",
		subject: isAgoda
			? "Agoda authenticated commercial confirmation for Zad Ajyad"
			: "New reservation for Zad Ajyad",
		messageId: isAgoda
			? "direct-owned-commercial-message@agoda.com"
			: "direct-owned-commercial-message",
		receivedAt: "2026-08-06T15:00:00.000Z",
		timestampMethod: "rfc2822_date_header",
	};
	const normalized = {
		inboundEmailId: "direct-owned-commercial-email",
		provider,
		providerLabel: isAgoda ? "Agoda" : "Booking.com",
		bookingSource: isAgoda ? "Agoda" : "Booking.com",
		confirmationNumber: HOTELRUNNER_COMMERCIAL_CONFIRMATION,
		reservationId: HOTELRUNNER_COMMERCIAL_CONFIRMATION,
		intent: "new_reservation",
		eventType: "new",
		guestName: "Commercial Evidence Guest",
		hotelName: "Zad Ajyad",
		roomName: "Double Room",
		checkinDate: "2026-09-10",
		checkoutDate: "2026-09-12",
		amount: 100,
		totalAmountSar: 100,
		sourceAmount: 100,
		sourceCurrency: "SAR",
		totalPayoutSar: 80,
		netAfterExpensesTotal: 80,
		currency: "SAR",
		exchangeRateToSar: 1,
		sourceExchangeRateToSar: 1,
		paidOnline: true,
		paymentCollectionModel: "ota_collect",
		paymentInstructions: isAgoda
			? "Agoda collected by platform"
			: "Booking.com collected by platform",
		paymentSummary: basePaymentSummary,
		roomCount: 1,
		totalGuests: 2,
		adults: 2,
		children: 0,
		sourceSenderTrusted: true,
		sourceSenderAuthenticated: true,
		trustedTransportProvider: provider,
		sourcePresence: baseSourcePresence,
		source: baseSource,
		...overrides,
	};
	normalized.sourcePresence = {
		...baseSourcePresence,
		...(overrides.sourcePresence || {}),
	};
	normalized.source = {
		...baseSource,
		...(overrides.source || {}),
	};
	normalized.paymentSummary = {
		...basePaymentSummary,
		...(overrides.paymentSummary || {}),
	};
	if (!Object.prototype.hasOwnProperty.call(overrides.source || {}, "textHash")) {
		normalized.source.textHash = immutableFixtureTextHash(
			normalized.source.from,
			normalized.source.subject,
			normalized.source.messageId,
			normalized.confirmationNumber,
			normalized.checkinDate,
			normalized.checkoutDate,
			normalized.sourceCurrency,
			normalized.sourceAmount,
			normalized.paymentSummary.sourceTotalPayoutAmount
		);
	}
	return normalized;
};

const makeDirectHotelRunnerCommercialReservation = (overrides = {}) => ({
	_id: "direct-owned-commercial-reservation",
	__v: 4,
	updatedAt: new Date("2026-08-06T14:00:00.000Z"),
	hotelId: HOTELRUNNER_COMMERCIAL_HOTEL_ID,
	belongsTo: HOTELRUNNER_COMMERCIAL_OWNER_ID,
	confirmation_number: "9000000901",
	reservation_id: HOTELRUNNER_COMMERCIAL_CONFIRMATION,
	otaIdentityKey: `booking:${HOTELRUNNER_COMMERCIAL_CONFIRMATION}`,
	booking_source: "Booking.com",
	customer_details: {
		confirmation_number2: HOTELRUNNER_COMMERCIAL_CONFIRMATION,
		booking_source: "Booking.com",
		name: "HotelRunner Guest",
	},
	state: "confirmed",
	reservation_status: "confirmed",
	checkin_date: "2026-09-10",
	checkout_date: "2026-09-12",
	total_rooms: 1,
	total_amount: 100,
	sub_total: 70,
	currency: "SAR",
	paid_amount: 0,
	commission: 0,
	commission_ota: null,
	financeStatus: "not paid",
	payment: "",
	payment_details: { captured: false, onsite_paid_amount: 0 },
	bofa_payment: {
		secure_acceptance: {
			status: "not_started",
			last_signed_at: null,
			last_reference_number: "",
			last_transaction_uuid: "",
			amount_usd: 0,
			currency: "USD",
			transaction_type: "sale",
			expires_at: null,
			created_by: "",
			last_callback_at: null,
			last_callback_source: "",
			last_response_signature_valid: null,
			last_request_id: "",
			last_transaction_id: "",
			last_reason_code: "",
			last_decision: "",
			last_response_payload: {},
			request_context: {},
			outbound_metadata: {},
			callbacks: [],
		},
	},
	pickedRoomsType: [
		{
			room_type: "doubleRooms",
			displayName: "Double Room",
			sourceRoomName: "Double Room",
			hotelRoomConfigId: HOTELRUNNER_COMMERCIAL_ROOM_ID,
			localRoomConfigId: HOTELRUNNER_COMMERCIAL_ROOM_ID,
			count: 1,
			pricingByDay: ["2026-09-10", "2026-09-11"].map((date) => ({
				date,
				price: 50,
				clientPrice: 50,
				mainPrice: 50,
				rootPrice: 35,
				totalPriceWithCommission: 50,
				hotelRunnerSourcePrice: 50,
			})),
		},
	],
	pickedRoomsPricing: [
		{
			room_type: "doubleRooms",
			displayName: "Double Room",
			sourceRoomName: "Double Room",
			hotelRoomConfigId: HOTELRUNNER_COMMERCIAL_ROOM_ID,
			localRoomConfigId: HOTELRUNNER_COMMERCIAL_ROOM_ID,
			count: 1,
			pricingByDay: ["2026-09-10", "2026-09-11"].map((date) => ({
				date,
				price: 50,
				clientPrice: 50,
				mainPrice: 50,
				rootPrice: 35,
				totalPriceWithCommission: 50,
				hotelRunnerSourcePrice: 50,
			})),
		},
	],
	adminChangeLog: [],
	adminPricing: {
		mode: "hotelrunner_api",
		source: "hotelrunner_api",
		clientTotal: 100,
		rootTotal: 70,
		netAfterExpensesTotal: null,
		otaExpenseTotal: null,
		commercialVerified: false,
	},
	ota_financial_summary: {
		source: "hotelrunner_api",
		clientTotal: 100,
		hotelVisibleAmount: 70,
		netAfterExpenses: null,
		otaExpenseTotal: null,
		commercialVerified: false,
	},
	supplierData: {
		supplierName: "Booking.com",
		suppliedBookingNo: HOTELRUNNER_COMMERCIAL_CONFIRMATION,
		otaConfirmationNumber: HOTELRUNNER_COMMERCIAL_CONFIRMATION,
		platformConfirmationNumber: HOTELRUNNER_COMMERCIAL_CONFIRMATION,
		otaAutomationPipeline: "hotelrunner-background-worker",
		otaProvider: "booking",
		otaSourceAuthority: 4,
		otaLastSourceReceivedAt: "2026-08-06T14:00:00.000Z",
		hotelRunner: {
			transport: "hotelrunner_api",
			reservationId: "hotelrunner-commercial-id",
			reportedPaymentMethod: "",
		},
	},
	...overrides,
});

const hotelRunnerCommercialHotel = () => ({
	_id: HOTELRUNNER_COMMERCIAL_HOTEL_ID,
	belongsTo: HOTELRUNNER_COMMERCIAL_OWNER_ID,
	hotelName: "Zad Ajyad",
	activateHotel: true,
	xHotelProActive: true,
	currency: "SAR",
	roomCountDetails: HOTEL_ROOMS.map((room, index) => ({
		...room,
		_id:
			index === 0
				? HOTELRUNNER_COMMERCIAL_ROOM_ID
				: `64b0000000000000000000f${index + 1}`,
	})),
});

const makeHotelRunnerFirstFallbackBoundary = (normalized, checkedAt) => {
	const identity = {
		hotelId: HOTELRUNNER_COMMERCIAL_HOTEL_ID,
		provider: normalized.provider,
		confirmationNumber: normalized.confirmationNumber,
		identityKey: `${normalized.provider}:${normalized.confirmationNumber}`,
	};
	const resolvedHotelProof = {
		version: 1,
		hotelId: HOTELRUNNER_COMMERCIAL_HOTEL_ID,
		belongsTo: HOTELRUNNER_COMMERCIAL_OWNER_ID,
		currency: "SAR",
		activateHotel: true,
		xHotelProActive: true,
	};
	const archive = createArchiveFingerprint({
		identity,
		audit: {
			_id: normalized.inboundEmailId,
			emailHash: "a".repeat(64),
			normalizedReservation: normalized,
			hotelRunnerFirstFallback: { resolvedHotelProof },
		},
	});
	const job = {
		_id: "64b0000000000000000009b1",
		...identity,
		inboundEmailHash: archive.inboundEmailHash,
		normalizedReservationHash: archive.normalizedReservationHash,
		inboundEmailId: normalized.inboundEmailId,
		hrIdFingerprint: "b".repeat(64),
		archiveFingerprint: archive.archiveFingerprint,
		resolvedHotelProofHash: hashStable(resolvedHotelProof),
		lookupConfirmationNumber: archive.lookupConfirmationNumber,
		lookupConfirmationHash: archive.lookupConfirmationHash,
		leaseOwner: "mapper-provenance-test-worker",
		leaseToken: "mapper-provenance-test-lease",
		leaseUntil: new Date(checkedAt.getTime() + 5 * 60_000),
	};
	const confirmedEmptyProof = buildConfirmedEmptyProof({
		job,
		lookup: { responseHash: "c".repeat(64) },
		now: checkedAt,
		proofTtlMs: 60_000,
		proofId: "mapper-adversarial-confirmed-empty",
	});
	job.negativeLookupProof = confirmedEmptyProof;
	return {
		mode: "confirmed_empty_email_fallback",
		identity,
		job,
		archiveFingerprint: archive.archiveFingerprint,
		confirmedEmptyProof,
	};
};

const hotelRunnerFirstFallbackTestIngressGate = {
	async authorizeEmailCreation({ boundary }) {
		return buildCreationAuthorization({
			boundary,
			token: "9".repeat(64),
			authorizedAt: new Date(
				new Date(boundary.confirmedEmptyProof.checkedAt).getTime() + 1_000
			),
			leaseUntil: boundary.jobLeaseUntil,
		});
	},
	async commitEmailCreation({ reservationId }) {
		return { committed: true, reservationId };
	},
	async releaseEmailCreation() {
		return { released: true, committed: false };
	},
};

test("mapped and unmapped email creates lose when a callback wins the final authorization pause", async (t) => {
	let caseIndex = 0;
	for (const fixture of [
		{ name: "mapped", roomName: "Double Room", expectsInventoryRead: true },
		{
			name: "unmapped",
			roomName: "Opaque Provider Room Final Gate",
			expectsInventoryRead: false,
		},
	]) {
		caseIndex += 1;
		await t.test(fixture.name, async () => {
			const originalAiToken = process.env.CHATGPT_API_TOKEN;
			const originalReservationFind = Reservations.find;
			const originalReservationExists = Reservations.exists;
			const originalReservationCreate = Reservations.create;
			const originalReservationUpdateOne = Reservations.updateOne;
			const originalHotelFind = HotelDetails.find;
			const originalHotelFindById = HotelDetails.findById;
			delete process.env.CHATGPT_API_TOKEN;
			const confirmationNumber = `fallback-final-gate-${fixture.name}`;
			const normalized = makeVerifiedHotelRunnerCommercialEmail({
				confirmationNumber,
				reservationId: confirmationNumber,
				inboundEmailId: `64b0000000000000000008f${caseIndex}`,
				roomName: fixture.roomName,
				source: { messageId: `${confirmationNumber}@booking.com` },
			});
			const checkedAt = new Date("2026-08-09T18:03:00.000Z");
			const boundary = makeHotelRunnerFirstFallbackBoundary(
				normalized,
				checkedAt
			);
			const hotel = hotelRunnerCommercialHotel();
			let createCalls = 0;
			let mutationCalls = 0;
			let inventoryReadCompleted = false;
			let authorizeCalls = 0;
			let commitCalls = 0;
			let releaseCalls = 0;
			let callbackWon = false;
			let signalAuthorization;
			let resumeAuthorization;
			const authorizationReached = new Promise((resolve) => {
				signalAuthorization = resolve;
			});
			const authorizationResume = new Promise((resolve) => {
				resumeAuthorization = resolve;
			});
			const ingressGate = {
				async authorizeEmailCreation() {
					authorizeCalls += 1;
					assert.equal(
						inventoryReadCompleted,
						fixture.expectsInventoryRead,
						"mapped inventory work must finish before the final decision CAS"
					);
					signalAuthorization();
					await authorizationResume;
					if (callbackWon) {
						const error = new Error(
							"HotelRunner callback won before email authorization."
						);
						error.code = "HOTELRUNNER_FALLBACK_API_OBSERVED_BEFORE_EMAIL";
						error.retryable = true;
						throw error;
					}
					throw new Error("test did not order the callback");
				},
				async commitEmailCreation() {
					commitCalls += 1;
				},
				async releaseEmailCreation() {
					releaseCalls += 1;
				},
			};

			Reservations.find = (query = {}) => ({
				limit() {
					return this;
				},
				select() {
					return this;
				},
				maxTimeMS() {
					return this;
				},
				lean() {
					return this;
				},
				async exec() {
					if (query.checkin_date && query.checkout_date) {
						inventoryReadCompleted = true;
					}
					return [];
				},
			});
			Reservations.exists = async () => false;
			Reservations.create = async () => {
				createCalls += 1;
				throw new Error("email insert must not start after API wins");
			};
			Reservations.updateOne = async () => {
				mutationCalls += 1;
				throw new Error("email mutation must not start after API wins");
			};
			HotelDetails.find = () => ({
				select() {
					return this;
				},
				async lean() {
					return [hotel];
				},
			});
			HotelDetails.findById = () => ({
				select() {
					return this;
				},
				lean() {
					return this;
				},
				async exec() {
					return hotel;
				},
			});

			try {
				const reconciliation = reconcileOtaReservation(normalized, {
					hotelRunnerFirstFallbackBoundary: boundary,
					hotelRunnerFirstFallbackIngressGate: ingressGate,
					hotelRunnerFirstFallbackNow: new Date(
						checkedAt.getTime() + 1_000
					),
				});
				await authorizationReached;
				// This is the adversarial linearization: local inspection and all
				// mapper validation have completed, but the durable email CAS has not.
				callbackWon = true;
				resumeAuthorization();
				await assert.rejects(
					reconciliation,
					(error) =>
						error?.code ===
						"HOTELRUNNER_FALLBACK_API_OBSERVED_BEFORE_EMAIL" &&
						error.retryable === true
				);
				assert.equal(authorizeCalls, 1);
				assert.equal(createCalls, 0);
				assert.equal(mutationCalls, 0);
				assert.equal(commitCalls, 0);
				assert.equal(releaseCalls, 0);
			} finally {
				resumeAuthorization?.();
				if (originalAiToken === undefined) {
					delete process.env.CHATGPT_API_TOKEN;
				} else {
					process.env.CHATGPT_API_TOKEN = originalAiToken;
				}
				Reservations.find = originalReservationFind;
				Reservations.exists = originalReservationExists;
				Reservations.create = originalReservationCreate;
				Reservations.updateOne = originalReservationUpdateOne;
				HotelDetails.find = originalHotelFind;
				HotelDetails.findById = originalHotelFindById;
			}
		});
	}
});

test("confirmed-empty fallback mapper refuses a wrong-hotel candidate before every write", async () => {
	const originalReservationFind = Reservations.find;
	const originalReservationCreate = Reservations.create;
	const originalReservationUpdateOne = Reservations.updateOne;
	const originalHotelFind = HotelDetails.find;
	const normalized = makeVerifiedHotelRunnerCommercialEmail({
		inboundEmailId: "64b0000000000000000009a1",
	});
	const checkedAt = new Date("2026-08-09T18:00:00.000Z");
	const boundary = makeHotelRunnerFirstFallbackBoundary(normalized, checkedAt);
	const wrongHotelCandidate = makeDirectHotelRunnerCommercialReservation({
		_id: "wrong-hotel-fallback-candidate",
		hotelId: "64b0000000000000000000d2",
		belongsTo: "64b0000000000000000000e2",
	});
	let writeCalls = 0;
	let hotelLookupCalls = 0;
	Reservations.find = () => ({
		limit() {
			return this;
		},
		select() {
			return this;
		},
		async exec() {
			return [wrongHotelCandidate];
		},
	});
	Reservations.create = async () => {
		writeCalls += 1;
		throw new Error("wrong fallback candidate must not be created over");
	};
	Reservations.updateOne = async () => {
		writeCalls += 1;
		throw new Error("wrong fallback candidate must not be mutated");
	};
	HotelDetails.find = () => {
		hotelLookupCalls += 1;
		throw new Error("candidate conflict must stop before hotel resolution");
	};

	try {
		const result = await reconcileOtaReservation(normalized, {
			hotelRunnerFirstFallbackBoundary: boundary,
			hotelRunnerFirstFallbackNow: new Date(checkedAt.getTime() + 1_000),
		});
		assert.equal(result.status, "needs_review");
		assert.equal(
			result.skipReason,
			"hotelrunner_first_fallback_candidate_identity_conflict"
		);
		assert.equal(result.reservationId, null);
		assert.equal(writeCalls, 0);
		assert.equal(hotelLookupCalls, 0);
	} finally {
		Reservations.find = originalReservationFind;
		Reservations.create = originalReservationCreate;
		Reservations.updateOne = originalReservationUpdateOne;
		HotelDetails.find = originalHotelFind;
	}
});

test("confirmed-empty fallback mapper never adopts an exact foreign row without its full creation marker", async (t) => {
	for (const [name, supplierData] of [
		["marker absent", undefined],
		[
			"partial marker",
			{
				hotelRunnerFirstFallbackCreation: {
					version: 1,
					archiveFingerprint: "d".repeat(64),
				},
			},
		],
	]) {
		await t.test(name, async () => {
			const originalReservationFind = Reservations.find;
			const originalReservationCreate = Reservations.create;
			const originalReservationUpdateOne = Reservations.updateOne;
			const originalHotelFind = HotelDetails.find;
			const normalized = makeVerifiedHotelRunnerCommercialEmail({
				inboundEmailId: "64b0000000000000000009a2",
			});
			const checkedAt = new Date("2026-08-09T18:02:00.000Z");
			const boundary = makeHotelRunnerFirstFallbackBoundary(
				normalized,
				checkedAt
			);
			const base = makeDirectHotelRunnerCommercialReservation();
			const foreign = {
				...base,
				supplierData: supplierData || {
					...base.supplierData,
					otaAutomationPipeline: "ota-email-inbound",
					otaSourceAuthority: 3,
					hotelRunner: undefined,
				},
			};
			let writeCalls = 0;
			Reservations.find = () => ({
				limit() {
					return this;
				},
				select() {
					return this;
				},
				async exec() {
					return [foreign];
				},
			});
			Reservations.create = async () => {
				writeCalls += 1;
				throw new Error("foreign identity row must never be replaced");
			};
			Reservations.updateOne = async () => {
				writeCalls += 1;
				throw new Error("foreign identity row must never be mutated");
			};
			HotelDetails.find = () => {
				throw new Error("foreign candidate must stop before hotel lookup");
			};
			try {
				const result = await reconcileOtaReservation(normalized, {
					hotelRunnerFirstFallbackBoundary: boundary,
					hotelRunnerFirstFallbackNow: new Date(checkedAt.getTime() + 1_000),
				});
				assert.equal(result.status, "needs_review");
				assert.equal(
					result.skipReason,
					"hotelrunner_first_fallback_candidate_identity_conflict"
				);
				assert.equal(result.reservationId, null);
				assert.equal(writeCalls, 0);
			} finally {
				Reservations.find = originalReservationFind;
				Reservations.create = originalReservationCreate;
				Reservations.updateOne = originalReservationUpdateOne;
				HotelDetails.find = originalHotelFind;
			}
		});
	}
});

test("fallback mapper rejects normalized archive and durable proof tampering before every lookup or write", async (t) => {
	for (const [name, mutate] of [
		[
			"normalized reservation hash",
			({ normalized }) => {
				normalized.amount = 101;
			},
		],
		[
			"proof id",
			({ boundary }) => {
				boundary.confirmedEmptyProof.proofId = "caller-freshened-proof";
			},
		],
		[
			"proof response hash",
			({ boundary }) => {
				boundary.confirmedEmptyProof.responseHash = "f".repeat(64);
			},
		],
		[
			"proof expiry",
			({ boundary }) => {
				boundary.confirmedEmptyProof.expiresAt = new Date(
					new Date(boundary.confirmedEmptyProof.expiresAt).getTime() + 60_000
				);
			},
		],
		[
			"authorized ingress missing durable authorization",
			({ boundary }) => {
				boundary.job.ingressDecision = {
					status: "email_authorized",
				};
			},
		],
		[
			"authorized ingress tampered token",
			({ boundary }) => {
				boundary.job.ingressDecision = {
					status: "email_authorized",
					emailAuthorization: {
						version: 1,
						status: "email_authorized",
						token: "0".repeat(64),
						bindingHash: "1".repeat(64),
					},
				};
			},
		],
		[
			"committed ingress missing reservation id",
			({ boundary }) => {
				boundary.job.ingressDecision = {
					status: "email_committed",
					emailAuthorization: {
						version: 1,
						status: "email_authorized",
						token: "0".repeat(64),
						bindingHash: "1".repeat(64),
					},
				};
			},
		],
	]) {
		await t.test(name, async () => {
			const originalReservationFind = Reservations.find;
			const originalReservationCreate = Reservations.create;
			const originalReservationUpdateOne = Reservations.updateOne;
			const originalHotelFind = HotelDetails.find;
			const normalized = makeVerifiedHotelRunnerCommercialEmail({
				inboundEmailId: "64b0000000000000000009a5",
			});
			const checkedAt = new Date("2026-08-09T18:03:00.000Z");
			const boundary = structuredClone(
				makeHotelRunnerFirstFallbackBoundary(normalized, checkedAt)
			);
			boundary.confirmedEmptyProof = structuredClone(
				boundary.confirmedEmptyProof
			);
			mutate({ normalized, boundary });
			let externalCalls = 0;
			const fail = () => {
				externalCalls += 1;
				throw new Error("tampered fallback boundary must stop before I/O");
			};
			Reservations.find = fail;
			Reservations.create = fail;
			Reservations.updateOne = fail;
			HotelDetails.find = fail;
			try {
				const result = await reconcileOtaReservation(normalized, {
					hotelRunnerFirstFallbackBoundary: boundary,
					hotelRunnerFirstFallbackNow: new Date(
						checkedAt.getTime() +
							(name.includes("ingress") ? 61_000 : 1_000)
					),
				});
				assert.equal(result.status, "needs_review");
				assert.equal(
					result.skipReason,
					"hotelrunner_first_fallback_boundary_invalid"
				);
				assert.equal(result.reservationId, null);
				assert.equal(externalCalls, 0);
			} finally {
				Reservations.find = originalReservationFind;
				Reservations.create = originalReservationCreate;
				Reservations.updateOne = originalReservationUpdateOne;
				HotelDetails.find = originalHotelFind;
			}
		});
	}
});

test("confirmed-empty fallback mapped and unmapped creation replays adopt only their full immutable marker", async (t) => {
	for (const fixture of [
		{
			name: "mapped room",
			confirmationNumber: "fallback-marker-mapped-1001",
			inboundEmailId: "64b0000000000000000009a3",
			roomName: "Double Room",
			expectedUnmapped: false,
		},
		{
			name: "unmapped room review",
			confirmationNumber: "fallback-marker-unmapped-1001",
			inboundEmailId: "64b0000000000000000009a4",
			roomName: "Opaque Provider Room Alpha",
			expectedUnmapped: true,
		},
	]) {
		await t.test(fixture.name, async () => {
			const originalAiToken = process.env.CHATGPT_API_TOKEN;
			const originalReservationFind = Reservations.find;
			const originalReservationExists = Reservations.exists;
			const originalReservationCreate = Reservations.create;
			const originalReservationUpdateOne = Reservations.updateOne;
			const originalHotelFind = HotelDetails.find;
			const originalHotelFindById = HotelDetails.findById;
			delete process.env.CHATGPT_API_TOKEN;
			const normalized = makeVerifiedHotelRunnerCommercialEmail({
				confirmationNumber: fixture.confirmationNumber,
				reservationId: fixture.confirmationNumber,
				inboundEmailId: fixture.inboundEmailId,
				roomName: fixture.roomName,
				source: {
					messageId: `${fixture.confirmationNumber}@booking.com`,
				},
			});
			const checkedAt = new Date("2026-08-09T18:04:00.000Z");
			const boundary = makeHotelRunnerFirstFallbackBoundary(
				normalized,
				checkedAt
			);
			const hotel = hotelRunnerCommercialHotel();
			let persisted = null;
			let createCalls = 0;
			let mutationCalls = 0;
			Reservations.find = () => ({
				limit() {
					return this;
				},
				select() {
					return this;
				},
				maxTimeMS() {
					return this;
				},
				lean() {
					return this;
				},
				async exec() {
					return persisted ? [persisted] : [];
				},
			});
			Reservations.exists = async () => false;
			Reservations.create = async (document) => {
				createCalls += 1;
				persisted = {
					...document,
					_id: `created-${fixture.confirmationNumber}`,
				};
				return persisted;
			};
			Reservations.updateOne = async () => {
				mutationCalls += 1;
				throw new Error("fallback replay must never mutate its prior create");
			};
			HotelDetails.find = () => ({
				select() {
					return this;
				},
				async lean() {
					return [hotel];
				},
			});
			HotelDetails.findById = () => ({
				select() {
					return this;
				},
				lean() {
					return this;
				},
				async exec() {
					return hotel;
				},
			});

			try {
				const first = await reconcileOtaReservation(normalized, {
					hotelRunnerFirstFallbackBoundary: boundary,
					hotelRunnerFirstFallbackIngressGate:
						hotelRunnerFirstFallbackTestIngressGate,
					hotelRunnerFirstFallbackNow: new Date(
						checkedAt.getTime() + 1_000
					),
				});
				assert.equal(first.status, "created", JSON.stringify(first));
				assert.equal(createCalls, 1);
				assert.ok(persisted);
				assert.equal(
					Boolean(persisted?.supplierData?.otaHotelRoomConfigId),
					!fixture.expectedUnmapped
				);
				if (!fixture.expectedUnmapped) {
					assert.equal(
						String(
							persisted.pickedRoomsType?.[0]?.hotelRoomConfigId || ""
						),
						HOTELRUNNER_COMMERCIAL_ROOM_ID
					);
				}
				const marker =
					persisted.supplierData.hotelRunnerFirstFallbackCreation;
				assert.equal(marker.version, 1);
				assert.equal(marker.fallbackJobId, boundary.job._id);
				assert.equal(marker.inboundEmailId, fixture.inboundEmailId);
				assert.equal(
					marker.normalizedReservationHash,
					boundary.job.normalizedReservationHash
				);
				assert.equal(
					marker.archiveFingerprint,
					boundary.archiveFingerprint
				);
				assert.equal(
					marker.confirmedEmptyProof.proofId,
					boundary.confirmedEmptyProof.proofId
				);
				boundary.job.ingressDecision = {
					status: "email_authorized",
					emailAuthorization: structuredClone(
						marker.creationAuthorization
					),
					emailAuthorizationLeaseUntil: new Date(
						marker.creationAuthorization.leaseUntil
					),
				};

				const replay = await reconcileOtaReservation(normalized, {
					hotelRunnerFirstFallbackBoundary: boundary,
					hotelRunnerFirstFallbackIngressGate:
						hotelRunnerFirstFallbackTestIngressGate,
					hotelRunnerFirstFallbackNow: new Date(
						checkedAt.getTime() + 61_000
					),
				});
				assert.equal(replay.status, "duplicate_reservation");
				assert.equal(
					replay.skipReason,
					"hotelrunner_first_fallback_creation_replay_adopted"
				);
				assert.equal(replay.reservationId, persisted._id);
				assert.equal(createCalls, 1);
				assert.equal(mutationCalls, 0);

				persisted.supplierData.hotelRunnerFirstFallbackCreation = {
					...persisted.supplierData.hotelRunnerFirstFallbackCreation,
					normalizedReservationHash: "e".repeat(64),
				};
				const tamperedReplay = await reconcileOtaReservation(normalized, {
					hotelRunnerFirstFallbackBoundary: boundary,
					hotelRunnerFirstFallbackIngressGate:
						hotelRunnerFirstFallbackTestIngressGate,
					hotelRunnerFirstFallbackNow: new Date(
						checkedAt.getTime() + 62_000
					),
				});
				assert.equal(tamperedReplay.status, "needs_review");
				assert.equal(
					tamperedReplay.skipReason,
					"hotelrunner_first_fallback_candidate_identity_conflict"
				);
				assert.equal(tamperedReplay.reservationId, null);
				assert.equal(createCalls, 1);
				assert.equal(mutationCalls, 0);
			} finally {
				if (originalAiToken === undefined) {
					delete process.env.CHATGPT_API_TOKEN;
				} else {
					process.env.CHATGPT_API_TOKEN = originalAiToken;
				}
				Reservations.find = originalReservationFind;
				Reservations.exists = originalReservationExists;
				Reservations.create = originalReservationCreate;
				Reservations.updateOne = originalReservationUpdateOne;
				HotelDetails.find = originalHotelFind;
				HotelDetails.findById = originalHotelFindById;
			}
		});
	}
});

test("mapped and unmapped fallback E11000 recovery adopts only the exact authorization marker", async (t) => {
	let caseIndex = 0;
	for (const allocation of [
		{ name: "mapped", roomName: "Double Room" },
		{ name: "unmapped", roomName: "Opaque Provider Room Alpha" },
	]) {
		for (const markerCase of ["exact", "missing", "tampered"]) {
			caseIndex += 1;
			await t.test(`${allocation.name} ${markerCase}`, async () => {
				const originalAiToken = process.env.CHATGPT_API_TOKEN;
				const originalReservationFind = Reservations.find;
				const originalReservationExists = Reservations.exists;
				const originalReservationCreate = Reservations.create;
				const originalReservationUpdateOne = Reservations.updateOne;
				const originalHotelFind = HotelDetails.find;
				const originalHotelFindById = HotelDetails.findById;
				delete process.env.CHATGPT_API_TOKEN;
				const confirmationNumber = `fallback-e11000-${allocation.name}-${markerCase}`;
				const normalized = makeVerifiedHotelRunnerCommercialEmail({
					confirmationNumber,
					reservationId: confirmationNumber,
					inboundEmailId: `64b0000000000000000009b${caseIndex}`,
					roomName: allocation.roomName,
					source: { messageId: `${confirmationNumber}@booking.com` },
				});
				const checkedAt = new Date("2026-08-09T18:06:00.000Z");
				const boundary = makeHotelRunnerFirstFallbackBoundary(
					normalized,
					checkedAt
				);
				const hotel = hotelRunnerCommercialHotel();
				let racedReservation = null;
				let createCalls = 0;
				let updateCalls = 0;
				let commitCalls = 0;
				let releaseCalls = 0;
				const ingressGate = {
					...hotelRunnerFirstFallbackTestIngressGate,
					async commitEmailCreation({ reservationId }) {
						commitCalls += 1;
						return { committed: true, reservationId };
					},
					async releaseEmailCreation() {
						releaseCalls += 1;
						return markerCase === "exact"
							? {
									committed: true,
									reservationId: racedReservation?._id,
							  }
							: { released: true, committed: false };
					},
				};
				Reservations.find = () => ({
					limit() {
						return this;
					},
					select() {
						return this;
					},
					maxTimeMS() {
						return this;
					},
					lean() {
						return this;
					},
					async exec() {
						return racedReservation ? [racedReservation] : [];
					},
				});
				Reservations.exists = async () => false;
				Reservations.create = async (document) => {
					createCalls += 1;
					const supplierData = { ...(document.supplierData || {}) };
					if (markerCase === "missing") {
						delete supplierData.hotelRunnerFirstFallbackCreation;
					} else if (markerCase === "tampered") {
						supplierData.hotelRunnerFirstFallbackCreation = {
							...supplierData.hotelRunnerFirstFallbackCreation,
							normalizedReservationHash: "4".repeat(64),
						};
					}
					racedReservation = {
						...document,
						_id: `e11000-${allocation.name}-${markerCase}`,
						supplierData,
					};
					const error = new Error("simulated fallback identity race");
					error.code = 11000;
					throw error;
				};
				Reservations.updateOne = async () => {
					updateCalls += 1;
					throw new Error("E11000 recovery must never mutate a candidate");
				};
				HotelDetails.find = () => ({
					select() {
						return this;
					},
					async lean() {
						return [hotel];
					},
				});
				HotelDetails.findById = () => ({
					select() {
						return this;
					},
					lean() {
						return this;
					},
					async exec() {
						return hotel;
					},
				});

				try {
					const result = await reconcileOtaReservation(normalized, {
						hotelRunnerFirstFallbackBoundary: boundary,
						hotelRunnerFirstFallbackIngressGate: ingressGate,
						hotelRunnerFirstFallbackNow: new Date(
							checkedAt.getTime() + 1_000
						),
					});
					assert.equal(createCalls, 1);
					assert.equal(releaseCalls, 1);
					assert.equal(updateCalls, 0);
					if (markerCase === "exact") {
						assert.equal(result.status, "duplicate_reservation");
						assert.equal(
							result.skipReason,
							"hotelrunner_first_fallback_creation_replay_adopted"
						);
						assert.equal(result.reservationId, racedReservation._id);
						assert.equal(commitCalls, 1);
					} else {
						assert.equal(result.status, "needs_review");
						assert.equal(
							result.skipReason,
							"hotelrunner_first_fallback_candidate_identity_conflict"
						);
						assert.equal(result.reservationId, null);
						assert.equal(commitCalls, 0);
					}
				} finally {
					if (originalAiToken === undefined) {
						delete process.env.CHATGPT_API_TOKEN;
					} else {
						process.env.CHATGPT_API_TOKEN = originalAiToken;
					}
					Reservations.find = originalReservationFind;
					Reservations.exists = originalReservationExists;
					Reservations.create = originalReservationCreate;
					Reservations.updateOne = originalReservationUpdateOne;
					HotelDetails.find = originalHotelFind;
					HotelDetails.findById = originalHotelFindById;
				}
			});
		}
	}
});

test("a different future Trip booking derives commercial SAR values through the same shared path", async () => {
	const confirmationNumber = "9988776655443322";
	const sourceRoomName =
		"Comfort Quadruple Room - Zad Ajyad Hotel - Bus to Haram Flexible-before the day of arrival-Room Only-Prepay";
	const parsed = extractNormalizedReservation(
		wrappedDirectTripRoomEmail({
			confirmationNumber,
			guestGross: "21.40",
			hotelPayout: "18.20",
			newReservation: true,
		})
	);
	const fetchedAt = "2026-08-09T06:00:00.000Z";
	const sourceTimestamp = "2026-08-09T00:00:00.000Z";
	const normalized = {
		...(await applyLiveSarConversion(parsed, {
			apiKey: "future-booking-test-credential",
			cache: new Map(),
			now: () => Date.parse(fetchedAt),
			fetchImpl: async () => ({
				ok: true,
				async json() {
					return {
						result: "success",
						base_code: "USD",
						target_code: "SAR",
						conversion_rate: 3.8,
						time_last_update_unix: Date.parse(sourceTimestamp) / 1000,
					};
				},
			}),
		})),
		inboundEmailId: "future-trip-commercial-audit",
	};
	const evidence = buildHotelRunnerEmailCommercialEvidence(normalized, {
		appliedAt: new Date("2026-08-09T06:01:00.000Z"),
	});

	assert.equal(normalized.confirmationNumber, confirmationNumber);
	assert.equal(normalized.sourceAmount, 21.4);
	assert.equal(normalized.paymentSummary.sourceTotalPayoutAmount, 18.2);
	assert.equal(normalized.totalAmountSar, 81.32);
	assert.equal(normalized.totalPayoutSar, 69.16);
	assert.equal(normalized.currency, "SAR");
	assert.equal(normalized.propertyCurrency, "SAR");
	assert.equal(normalized.paymentSummary.currency, "SAR");
	assert.equal(normalized.propertyConversionVerified, true);
	assert.equal(normalized.currencyConversionEvidence.provenance.provider, "exchange_rate_api");
	assert.ok(evidence);
	assert.equal(evidence.otaIdentityKey, `trip:${confirmationNumber}`);
	assert.equal(evidence.grossTotalSar, 81.32);
	assert.equal(evidence.payoutTotalSar, 69.16);
	assert.equal(evidence.otaExpenseTotalSar, 12.16);
	assert.equal(evidence.otaCommissionSar, null);

	const sourceRooms = [
		{
			room_type: "quadRooms",
			displayName: "Quadruple Room",
			sourceRoomName,
			hotelRoomConfigId: HOTELRUNNER_COMMERCIAL_ROOM_ID,
			localRoomConfigId: HOTELRUNNER_COMMERCIAL_ROOM_ID,
			count: 1,
			pricingByDay: [
				{
					date: "2026-08-10",
					price: null,
					clientPrice: null,
					mainPrice: null,
					rootPrice: 75,
					totalPriceWithCommission: null,
					hotelRunnerSourcePrice: 18.2,
				},
			],
		},
	];
	const base = makeDirectHotelRunnerCommercialReservation();
	const existing = makeDirectHotelRunnerCommercialReservation({
		_id: "future-trip-hotelrunner-reservation",
		confirmation_number: "future-trip-pms-confirmation",
		reservation_id: confirmationNumber,
		otaIdentityKey: `hotelrunner:${confirmationNumber}`,
		otaCrossTransportIdentityKey: `trip:${confirmationNumber}`,
		booking_source: "Trip.com",
		customer_details: {
			...base.customer_details,
			confirmation_number2: confirmationNumber,
			booking_source: "Trip.com",
		},
		checkin_date: "2026-08-10",
		checkout_date: "2026-08-11",
		total_amount: 69.16,
		sub_total: 75,
		pickedRoomsType: structuredClone(sourceRooms),
		pickedRoomsPricing: structuredClone(sourceRooms),
		adminPricing: {
			...base.adminPricing,
			clientTotal: 69.16,
			rootTotal: 75,
		},
		ota_financial_summary: {
			...base.ota_financial_summary,
			clientTotal: 69.16,
			hotelVisibleAmount: 75,
		},
		supplierData: {
			...base.supplierData,
			supplierName: "Trip.com",
			suppliedBookingNo: confirmationNumber,
			otaConfirmationNumber: confirmationNumber,
			platformConfirmationNumber: confirmationNumber,
			otaProvider: "trip",
			hotelRunner: {
				...base.supplierData.hotelRunner,
				reservationId: "future-trip-hotelrunner-id",
			},
		},
	});
	const guard = directHotelRunnerEmailCommercialGuard({
		normalized,
		existing,
		hotelDetails: hotelRunnerCommercialHotel(),
		matchedReservationBy: ["otaCrossTransportIdentityKey"],
		evidence,
	});
	assert.equal(guard.ok, true, guard.reason);
	assert.equal(guard.reportedTotalRole, "payout");
	const set = directHotelRunnerCommercialEnrichmentSet(normalized, evidence, {
		reportedTotalRole: guard.reportedTotalRole,
		existing,
		commercialPricing: guard.commercialPricing,
	});
	assert.equal(set.total_amount, 81.32);
	assert.equal(set.currency, "SAR");
	assert.equal(set.commission_ota, null);
	assert.equal(set["adminPricing.netAfterExpensesTotal"], 69.16);
	assert.equal(set["adminPricing.otaExpenseTotal"], 12.16);
	assert.equal(set.pickedRoomsPricing[0].pricingByDay[0].clientPrice, 81.32);
	assert.equal(set.pickedRoomsPricing[0].pricingByDay[0].netAfterExpenses, 69.16);
	assert.equal(set.pickedRoomsPricing[0].pricingByDay[0].rootPrice, 75);
	assert.equal(set.pickedRoomsPricing[0].pricingByDay[0].hotelRunnerSourcePrice, 18.2);
});

test("future foreign-currency money stays unknown SAR when trusted conversion evidence is unavailable", async () => {
	const priorUsdRate = process.env.OTA_USD_TO_SAR_RATE;
	const priorConfiguredRates = process.env.OTA_CURRENCY_RATES_TO_SAR;
	delete process.env.OTA_USD_TO_SAR_RATE;
	delete process.env.OTA_CURRENCY_RATES_TO_SAR;
	try {
		const parsed = extractNormalizedReservation(
			wrappedDirectTripRoomEmail({
				confirmationNumber: "8877665544332211",
				guestGross: "27.35",
				hotelPayout: "19.45",
				newReservation: true,
			})
		);
		const normalized = await applyLiveSarConversion(parsed, {
			rateLookup: async () => null,
		});

		assert.equal(normalized.sourceAmount, 27.35);
		assert.equal(normalized.sourceCurrency, "USD");
		assert.equal(normalized.sourcePayoutAmount, 19.45);
		assert.equal(normalized.sourcePayoutCurrency, "USD");
		assert.equal(normalized.propertyCurrency, "SAR");
		assert.equal(normalized.currency, "SAR");
		assert.equal(normalized.paymentSummary.currency, "SAR");
		assert.equal(normalized.propertyConversionVerified, false);
		assert.equal(normalized.exchangeRateToSar, null);
		assert.equal(normalized.totalAmountSar, null);
		assert.equal(normalized.amount, null);
		assert.equal(normalized.totalPayoutSar, null);
		assert.equal(normalized.paymentSummary.totalGuestPaymentAmount, null);
		assert.equal(normalized.paymentSummary.totalPayoutAmount, null);
		assert.equal(normalized.currencyConversionEvidence, undefined);
		assert.ok(
			normalized.errors.includes("Missing SAR exchange rate for USD.")
		);
	} finally {
		if (priorUsdRate === undefined) delete process.env.OTA_USD_TO_SAR_RATE;
		else process.env.OTA_USD_TO_SAR_RATE = priorUsdRate;
		if (priorConfiguredRates === undefined) {
			delete process.env.OTA_CURRENCY_RATES_TO_SAR;
		} else {
			process.env.OTA_CURRENCY_RATES_TO_SAR = priorConfiguredRates;
		}
	}
});

test("a new authenticated provider contract adds verified PMS hotel-base provenance without dropping provider roles", () => {
	const normalized = makeVerifiedHotelRunnerCommercialEmail({
		provider: "agoda",
		otaCommissionSar: 10,
		otaCommissionSourceAmount: 10,
		otaCommissionCurrency: "SAR",
		otaCommissionSource: "agoda_commission",
		otaDeductionConflict: false,
		otaDeductionComponents: [
			{
				type: "commission",
				label: "Commission",
				amountSar: 10,
				sourceAmount: 10,
				currency: "SAR",
				source: "authenticated_agoda_email",
			},
			{
				type: "growth_program",
				label: "Agoda Growth Program",
				amountSar: 5,
				sourceAmount: 5,
				currency: "SAR",
				source: "authenticated_agoda_email",
			},
		],
		sourcePresence: { otaCommission: true },
	});
	const hotel = hotelRunnerCommercialHotel();
	hotel.roomCountDetails[0].pricingRate = ["2026-09-10", "2026-09-11"].map(
		(calendarDate) => ({ calendarDate, rootPrice: 35, price: 40 })
	);

	const built = buildReservationDocument(normalized, hotel);
	assert.equal(built.ok, true);
	const evidence = built.document.supplierData.otaCommercialEvidence;
	assert.equal(validateOtaCommercialEvidence(evidence).ok, true);
	assert.equal(evidence.provider, "agoda");
	assert.equal(evidence.verificationState, "verified");
	assert.deepEqual(
		Object.fromEntries(
			Object.entries(evidence.roles).map(([role, value]) => [
				role,
				{
					verified: value.verified,
					sourceAmount: value.sourceAmount,
					propertyAmount: value.propertyAmount,
				},
			])
		),
		{
			guestGross: { verified: true, sourceAmount: 100, propertyAmount: 100 },
			hotelBase: { verified: true, sourceAmount: 70, propertyAmount: 70 },
			hotelPayout: { verified: true, sourceAmount: 80, propertyAmount: 80 },
			deductionAggregate: {
				verified: true,
				sourceAmount: 20,
				propertyAmount: 20,
			},
			explicitOtaCommission: {
				verified: true,
				sourceAmount: 10,
				propertyAmount: 10,
			},
		}
	);
	assert.equal(evidence.roles.hotelBase.evidenceType, "pms_source");
	assert.equal(evidence.roles.hotelBase.sourceRef, "hotelBase");
	assert.equal(evidence.provenance.primary.provider, "agoda");
	assert.equal(evidence.provenance.primary.sourceType, "authenticated_ota_email");
	assert.equal(evidence.provenance.hotelBase.provider, "jannat_pms");
	assert.equal(evidence.provenance.hotelBase.sourceType, "pms_root_pricing");
	assert.match(evidence.provenance.hotelBase.sourceHash, /^[a-f0-9]{64}$/);
	assert.equal(
		evidence.provenance.hotelBase.sourceId,
		`pms-root-${HOTELRUNNER_COMMERCIAL_HOTEL_ID}-${HOTELRUNNER_COMMERCIAL_ROOM_ID}`
	);
	assert.deepEqual(
		evidence.deductionComponents.map((component) => ({
			type: component.componentType,
			amount: component.amount.sourceAmount,
		})),
		[
			{ type: "commission", amount: 10 },
			{ type: "growth_program", amount: 5 },
		]
	);
});

test("source-only foreign OTA-collect creation keeps unknown payment and settlement amounts null", () => {
	const normalized = makeVerifiedHotelRunnerCommercialEmail({
		provider: "agoda",
		amount: null,
		totalAmountSar: null,
		sourceAmount: 100,
		sourceCurrency: "USD",
		totalPayoutSar: null,
		netAfterExpensesTotal: null,
		currency: "USD",
		propertyCurrency: "SAR",
		propertyConversionVerified: false,
		exchangeRateToSar: 0,
		sourceExchangeRateToSar: 0,
		paymentCollectionModel: "ota_collect",
		paymentSummary: {
			sourceCurrency: "USD",
			sourceTotalGuestPaymentAmount: 100,
			sourceTotalPayoutAmount: null,
			totalGuestPaymentAmount: null,
			totalPayoutAmount: null,
			currency: null,
			propertyCurrency: "SAR",
			propertyConversionVerified: false,
			exchangeRateToSar: null,
		},
	});
	const hotel = hotelRunnerCommercialHotel();
	hotel.roomCountDetails[0].pricingRate = ["2026-09-10", "2026-09-11"].map(
		(calendarDate) => ({ calendarDate, rootPrice: 35, price: 40 })
	);
	const mapped = buildReservationDocument(normalized, hotel);
	assert.equal(mapped.ok, true);
	const documents = [
		["mapped", mapped.document],
		["unmapped", buildUnmappedOtaReviewReservationDocument(normalized)],
	];

	for (const [shape, document] of documents) {
		assert.equal(document.total_amount, null, shape);
		assert.equal(document.payment, "ota collect - amount unavailable", shape);
		assert.equal(document.financeStatus, "commercial review required", shape);
		assert.equal(document.paid_amount, null, shape);
		assert.equal(
			document.paid_amount_breakdown.paid_online_other_platforms,
			null,
			shape
		);
		assert.equal(
			document.financial_cycle.collectionModel,
			"provider_collected_unresolved",
			shape
		);
		assert.equal(document.financial_cycle.status, "review_required", shape);
		assert.equal(document.financial_cycle.pmsCollectedAmount, null, shape);
		assert.equal(
			document.financial_cycle.hotelPayoutDue,
			shape === "mapped" ? null : 0,
			`${shape}: an unassigned review has a known zero hotel obligation`
		);
		const evidence = document.supplierData.otaCommercialEvidence;
		assert.equal(validateOtaCommercialEvidence(evidence).ok, true, shape);
		assert.equal(evidence.roles.guestGross.sourceAmount, 100, shape);
		assert.equal(evidence.roles.guestGross.sourceCurrency, "USD", shape);
		assert.equal(evidence.roles.guestGross.propertyAmount, null, shape);
	}
});

test("trusted Expedia USD conversion materializes cent-exact SAR roles in the common contract", async () => {
	const sourceTimestamp = "2026-08-09T00:00:00.000Z";
	const fetchedAt = "2026-08-09T06:00:00.000Z";
	const normalized = makeVerifiedHotelRunnerCommercialEmail({
		provider: "expedia",
		providerLabel: "Expedia",
		bookingSource: "Expedia",
		commercialSourceType: "authenticated_provider_portal",
		amount: null,
		totalAmountSar: null,
		sourceAmount: 146.46,
		sourceCurrency: "USD",
		totalPayoutSar: null,
		netAfterExpensesTotal: null,
		currency: "USD",
		propertyCurrency: "SAR",
		propertyConversionVerified: false,
		exchangeRateToSar: 0,
		sourceExchangeRateToSar: 0,
		paymentSummary: {
			sourceCurrency: "USD",
			sourceTotalGuestPaymentAmount: 146.46,
			sourceTotalPayoutAmount: 112.92,
			totalGuestPaymentAmount: null,
			totalPayoutAmount: null,
			currency: null,
			propertyCurrency: "SAR",
			propertyConversionVerified: false,
			exchangeRateToSar: null,
		},
		source: {
			from: "expedia-sync",
			subject: "Authenticated Expedia portal commercial detail",
			messageId: "expedia-portal-commercial-2530158461",
		},
	});
	const converted = await applyLiveSarConversion(normalized, {
		apiKey: "test-credential-never-persist",
		cache: new Map(),
		now: () => Date.parse(fetchedAt),
		fetchImpl: async () => ({
			ok: true,
			async json() {
				return {
					result: "success",
					base_code: "USD",
					target_code: "SAR",
					conversion_rate: 3.75,
					time_last_update_unix: Date.parse(sourceTimestamp) / 1000,
				};
			},
		}),
	});

	assert.equal(converted.sourceAmount, 146.46);
	assert.equal(converted.sourceCurrency, "USD");
	assert.equal(converted.propertyCurrency, "SAR");
	assert.equal(converted.propertyConversionVerified, true);
	assert.equal(converted.totalAmountSar, 549.23);
	assert.equal(converted.amount, 549.23);
	assert.equal(converted.currency, "SAR");
	assert.equal(converted.sourcePayoutAmount, 112.92);
	assert.equal(converted.totalPayoutSar, 423.45);
	assert.equal(converted.paymentSummary.totalGuestPaymentAmount, 549.23);
	assert.equal(converted.paymentSummary.totalPayoutAmount, 423.45);
	assert.equal(converted.paymentSummary.currency, "SAR");
	assert.equal(converted.amountConvertedAt, fetchedAt);

	const evidence = buildNormalizedOtaCommercialEvidence(converted, {
		propertyCurrency: "SAR",
	});
	assert.equal(validateOtaCommercialEvidence(evidence).ok, true);
	assert.equal(evidence.provider, "expedia");
	assert.equal(evidence.sourceCurrency, "USD");
	assert.equal(evidence.propertyCurrency, "SAR");
	assert.equal(evidence.roles.guestGross.sourceAmount, 146.46);
	assert.equal(evidence.roles.guestGross.propertyAmount, 549.23);
	assert.equal(evidence.roles.hotelPayout.sourceAmount, 112.92);
	assert.equal(evidence.roles.hotelPayout.propertyAmount, 423.45);
	assert.equal(evidence.roles.deductionAggregate.sourceAmount, 33.54);
	assert.equal(evidence.roles.deductionAggregate.propertyAmount, 125.78);
	assert.equal(evidence.roles.explicitOtaCommission.verified, false);
	assert.equal(evidence.currencyConversion.rate, 3.75);
	assert.equal(evidence.provenance.conversion.sourceTimestamp, sourceTimestamp);
	assert.equal(evidence.provenance.conversion.sourceHash, converted.currencyConversionEvidence.provenance.sourceHash);
});

const applyDottedCommercialSet = (reservation, set = {}) => {
	const next = structuredClone(reservation);
	for (const [path, value] of Object.entries(set)) {
		const segments = path.split(".");
		let target = next;
		for (const segment of segments.slice(0, -1)) {
			target[segment] = target[segment] || {};
			target = target[segment];
		}
		target[segments.at(-1)] = value;
	}
	return next;
};

test("stored exchange-rate materialization requires the exact immutable trusted evidence tuple", async () => {
	const confirmationNumber = "9988776655443300";
	const sourceTimestamp = "2026-08-09T00:00:00.000Z";
	const fetchedAt = "2026-08-09T06:00:00.000Z";
	const foreign = makeVerifiedHotelRunnerCommercialEmail({
		provider: "trip",
		providerLabel: "Trip.com",
		bookingSource: "Trip.com",
		confirmationNumber,
		reservationId: confirmationNumber,
		amount: null,
		totalAmountSar: null,
		sourceAmount: 21.4,
		sourceCurrency: "USD",
		totalPayoutSar: null,
		netAfterExpensesTotal: null,
		currency: "USD",
		propertyCurrency: "SAR",
		propertyConversionVerified: false,
		exchangeRateToSar: null,
		sourceExchangeRateToSar: null,
		trustedTransportProvider: "trip",
		paymentSummary: {
			sourceCurrency: "USD",
			sourceTotalGuestPaymentAmount: 21.4,
			sourceTotalPayoutAmount: 18.2,
			sourceTotalPayoutCurrency: "USD",
			totalGuestPaymentAmount: null,
			totalPayoutAmount: null,
			currency: null,
			exchangeRateToSar: null,
		},
		source: {
			from: "Trip.com <noreply@trip.com>",
			subject: "Authenticated Trip.com commercial confirmation",
			messageId: "stored-fx-commercial-trip",
			receivedAt: "2026-08-09T05:59:00.000Z",
		},
	});
	const live = await applyLiveSarConversion(foreign, {
		apiKey: "stored-fx-test-credential",
		cache: new Map(),
		now: () => Date.parse(fetchedAt),
		fetchImpl: async () => ({
			ok: true,
			async json() {
				return {
					result: "success",
					base_code: "USD",
					target_code: "SAR",
					conversion_rate: 3.8,
					time_last_update_unix: Date.parse(sourceTimestamp) / 1000,
				};
			},
		}),
	});
	let unexpectedLookupCalls = 0;
	const stored = await applyLiveSarConversion(live, {
		rateLookup: async () => {
			unexpectedLookupCalls += 1;
			throw new Error("valid stored evidence must not perform another live lookup");
		},
	});
	assert.equal(unexpectedLookupCalls, 0);
	assert.equal(live.exchangeRateSource, "exchange_rate_api");
	assert.equal(stored.exchangeRateSource, "exchange_rate_api_stored");
	assert.deepEqual(
		stored.paymentSummary.currencyConversionEvidence,
		stored.currencyConversionEvidence
	);
	const suppliedEvidenceTamperCases = [
		["rate", (value) => (value.rate = 3.81)],
		["hash", (value) => (value.provenance.sourceHash = "0".repeat(64))],
		["source id", (value) => (value.provenance.sourceId += "-altered")],
		[
			"timestamp",
			(value) => (value.provenance.sourceTimestamp = "2026-08-08T00:00:00.000Z"),
		],
		["source currency", (value) => (value.sourceCurrency = "EUR")],
		["property currency", (value) => (value.propertyCurrency = "AED")],
	];
	for (const [label, tamper] of suppliedEvidenceTamperCases) {
		const changed = structuredClone(live);
		tamper(changed.currencyConversionEvidence);
		const rejected = await applyLiveSarConversion(changed, {
			rateLookup: async () => null,
		});
		assert.equal(rejected.propertyConversionVerified, false, label);
		assert.equal(rejected.totalAmountSar, null, label);
		assert.equal(rejected.totalPayoutSar, null, label);
		assert.equal(rejected.currencyConversionEvidence, undefined, label);
		assert.equal(
			rejected.paymentSummary.currencyConversionEvidence,
			undefined,
			label
		);
	}
	const missingSuppliedEvidence = structuredClone(live);
	delete missingSuppliedEvidence.currencyConversionEvidence;
	const rejectedMissingEvidence = await applyLiveSarConversion(
		missingSuppliedEvidence,
		{ rateLookup: async () => null }
	);
	assert.equal(rejectedMissingEvidence.propertyConversionVerified, false);
	assert.equal(rejectedMissingEvidence.totalAmountSar, null);
	assert.equal(rejectedMissingEvidence.currencyConversionEvidence, undefined);

	const evidence = buildHotelRunnerEmailCommercialEvidence(stored, {
		appliedAt: new Date("2026-08-09T06:01:00.000Z"),
	});
	assert.ok(evidence);
	assert.equal(evidence.grossTotalSar, 81.32);
	assert.equal(evidence.payoutTotalSar, 69.16);
	const base = makeDirectHotelRunnerCommercialReservation();
	const existing = makeDirectHotelRunnerCommercialReservation({
		reservation_id: confirmationNumber,
		otaIdentityKey: `trip:${confirmationNumber}`,
		booking_source: "Trip.com",
		total_amount: 69.16,
		adminPricing: { ...base.adminPricing, clientTotal: 69.16 },
		ota_financial_summary: {
			...base.ota_financial_summary,
			clientTotal: 69.16,
		},
		customer_details: {
			...base.customer_details,
			confirmation_number2: confirmationNumber,
			booking_source: "Trip.com",
		},
		supplierData: {
			...base.supplierData,
			supplierName: "Trip.com",
			suppliedBookingNo: confirmationNumber,
			otaConfirmationNumber: confirmationNumber,
			platformConfirmationNumber: confirmationNumber,
			otaProvider: "trip",
		},
	});
	const set = directHotelRunnerCommercialEnrichmentSet(stored, evidence, {
		reportedTotalRole: "payout",
		existing,
	});
	assert.ok(set);
	const contractWithoutExactStoredEvidence = structuredClone(stored);
	contractWithoutExactStoredEvidence.otaCommercialEvidence =
		set["supplierData.otaCommercialEvidence"];
	delete contractWithoutExactStoredEvidence.currencyConversionEvidence;
	delete contractWithoutExactStoredEvidence.paymentSummary
		.currencyConversionEvidence;
	assert.equal(
		buildHotelRunnerEmailCommercialEvidence(
			contractWithoutExactStoredEvidence
		),
		null,
		"a valid general commercial contract cannot bypass missing exact stored-rate evidence"
	);
	const materialized = applyDottedCommercialSet(existing, set);
	const verify = (reservation) =>
		verifiedHotelRunnerEmailCommercialEvidence(reservation, {
			provider: "trip",
			grossTotalSar: 81.32,
			currency: "SAR",
		});
	assert.ok(verify(materialized));

	const paymentSummaries = (reservation) => [
		reservation.ota_financial_summary.paymentSummary,
		reservation.supplierData.otaPaymentSummary,
	];
	const tamperCases = [
		["rate", (value) => (value.rate = 3.81)],
		["hash", (value) => (value.provenance.sourceHash = "0".repeat(64))],
		["source id", (value) => (value.provenance.sourceId += "-altered")],
		[
			"timestamp",
			(value) => (value.provenance.sourceTimestamp = "2026-08-08T00:00:00.000Z"),
		],
		["source currency", (value) => (value.sourceCurrency = "EUR")],
		["property currency", (value) => (value.propertyCurrency = "AED")],
	];
	for (const [label, tamper] of tamperCases) {
		const changed = structuredClone(materialized);
		for (const summary of paymentSummaries(changed)) {
			tamper(summary.currencyConversionEvidence);
		}
		assert.equal(verify(changed), null, label);
	}
	const missing = structuredClone(materialized);
	for (const summary of paymentSummaries(missing)) {
		delete summary.currencyConversionEvidence;
		assert.equal(summary.exchangeRateSource, "exchange_rate_api_stored");
	}
	assert.equal(
		verify(missing),
		null,
		"the stored source marker alone is not conversion evidence"
	);
	for (const unchangedSource of [
		"exchange_rate_api",
		"exchange_rate_api_cached",
	]) {
		const legacyMaterialized = structuredClone(materialized);
		for (const summary of paymentSummaries(legacyMaterialized)) {
			summary.exchangeRateSource = unchangedSource;
			delete summary.currencyConversionEvidence;
		}
		assert.ok(verify(legacyMaterialized), unchangedSource);
	}
});

test("dormant BofA Secure Acceptance defaults are not payment activity", () => {
	const dormant = makeDirectHotelRunnerCommercialReservation();
	assert.equal(hasCaptureOrSettlementActivity(dormant), false);
	for (const mutate of [
		(reservation) => {
			reservation.bofa_payment.secure_acceptance.status = "pending";
		},
		(reservation) => {
			reservation.bofa_payment.secure_acceptance.last_request_id = "request-1";
		},
		(reservation) => {
			reservation.bofa_payment.secure_acceptance.callbacks.push({ event: "callback" });
		},
		(reservation) => {
			reservation.bofa_payment.secure_acceptance.amount_usd = 1;
		},
		(reservation) => {
			reservation.bofa_payment.secure_acceptance.amount_usd = "invalid";
		},
		(reservation) => {
			reservation.bofa_payment.secure_acceptance.callbacks = {};
		},
		(reservation) => {
			reservation.bofa_payment.secure_acceptance.last_response_signature_valid =
				false;
		},
	]) {
		const active = structuredClone(dormant);
		mutate(active);
		assert.equal(hasCaptureOrSettlementActivity(active), true);
	}
});

test("HotelRunner commercial enrichment promotes only exact verified OTA-collect payment evidence", () => {
	const normalized = makeVerifiedHotelRunnerCommercialEmail();
	const existing = makeDirectHotelRunnerCommercialReservation();
	const evidence = buildHotelRunnerEmailCommercialEvidence(normalized, {
		appliedAt: new Date("2026-08-06T15:01:00.000Z"),
	});
	assert.ok(evidence);
	const commercialPricing = buildDirectHotelRunnerCommercialPricing(
		existing,
		normalized,
		evidence
	);
	assert.ok(commercialPricing);
	const paymentPaths = [
		"payment",
		"financeStatus",
		"paid_amount",
		"paid_amount_breakdown",
		"financial_cycle",
		"supplierData.otaPaymentCollectionModel",
	];
	const collectSet = directHotelRunnerCommercialEnrichmentSet(
		normalized,
		evidence,
		{
			existing,
			commercialPricing,
			materializeVerifiedOtaCollectPayment: true,
		}
	);
	assert.equal(collectSet.payment, "paid online");
	assert.equal(collectSet.financeStatus, "paid online");
	assert.equal(collectSet.paid_amount, 100);
	assert.equal(
		collectSet.paid_amount_breakdown.paid_online_other_platforms,
		100
	);
	assert.equal(collectSet.financial_cycle.pmsCollectedAmount, 100);
	assert.equal(collectSet.financial_cycle.hotelPayoutDue, 70);
	assert.equal(
		collectSet["supplierData.otaPaymentCollectionModel"],
		"ota_collect"
	);

	const unchangedCases = [
		{
			label: "unknown collection model",
			normalized: { ...normalized, paymentCollectionModel: "unknown" },
		},
		{
			label: "hotel collect",
			normalized: { ...normalized, paymentCollectionModel: "hotel_collect" },
		},
		{
			label: "virtual card",
			normalized: { ...normalized, paymentCollectionModel: "virtual_card" },
		},
		{
			label: "collection model absent from source",
			normalized: {
				...normalized,
				sourcePresence: {
					...normalized.sourcePresence,
					paymentCollectionModel: false,
				},
			},
		},
		{
			label: "paid-online fact absent",
			normalized: { ...normalized, paidOnline: false },
		},
		{
			label: "source not authenticated",
			normalized: { ...normalized, sourceSenderAuthenticated: false },
		},
		{
			label: "commercial total mismatch",
			normalized,
			commercialPricing: { ...commercialPricing, clientTotal: 99.99 },
		},
		{
			label: "commercial evidence hash mismatch",
			normalized,
			evidence: { ...evidence, evidenceHash: "f".repeat(64) },
		},
		{
			label: "commercial evidence not verified",
			normalized,
			evidence: { ...evidence, verified: false },
		},
		{
			label: "terminal reservation",
			normalized,
			existing: {
				...existing,
				state: "cancelled",
				reservation_status: "cancelled",
			},
		},
	];
	for (const candidate of unchangedCases) {
		const set = directHotelRunnerCommercialEnrichmentSet(
			candidate.normalized,
			candidate.evidence || evidence,
			{
				existing: candidate.existing || existing,
				commercialPricing:
					candidate.commercialPricing || commercialPricing,
				materializeVerifiedOtaCollectPayment: true,
			}
		);
		assert.ok(set, candidate.label);
		assert.equal(set["adminPricing.clientTotal"], 100, candidate.label);
		for (const path of paymentPaths) {
			assert.equal(
				Object.prototype.hasOwnProperty.call(set, path),
				false,
				`${candidate.label}: ${path}`
			);
		}
	}
});

test("a direct-owned reservation accepts verified gross, net, daily, and OTA-collect payment enrichment", async () => {
	const originalReservationFind = Reservations.find;
	const originalReservationUpdateOne = Reservations.updateOne;
	const originalHotelFind = HotelDetails.find;
	const existing = makeDirectHotelRunnerCommercialReservation();
	let writtenFilter = null;
	let writtenUpdate = null;
	Reservations.find = () => ({
		limit() {
			return this;
		},
		async exec() {
			return [existing];
		},
	});
	Reservations.updateOne = async (filter, update) => {
		writtenFilter = filter;
		writtenUpdate = update;
		return { matchedCount: 1 };
	};
	HotelDetails.find = () => ({
		select() {
			return this;
		},
		async lean() {
			return [hotelRunnerCommercialHotel()];
		},
	});

	try {
		const normalized = makeVerifiedHotelRunnerCommercialEmail();
		const result = await reconcileOtaReservation(normalized);
		assert.equal(result.status, "updated");
		assert.equal(result.actionTaken, "commercial_enrichment");
		assert.equal(writtenFilter._id, existing._id);
		assert.equal(writtenFilter.__v, 4);
		assert.equal(writtenFilter.hotelId, existing.hotelId);
		assert.equal(writtenFilter.belongsTo, existing.belongsTo);
		assert.equal(writtenFilter.state, "confirmed");
		assert.equal(writtenFilter.total_amount, 100);
		assert.equal(writtenFilter.payment, "");
		assert.equal(writtenFilter.financeStatus, "not paid");
		assert.equal(writtenFilter.paid_amount, 0);
		assert.deepEqual(writtenFilter.payment_details, {
			captured: false,
			onsite_paid_amount: 0,
		});
		assert.equal(writtenFilter.paid_amount_breakdown, null);
		assert.equal(writtenFilter.financial_cycle, null);
		assert.equal(
			writtenFilter["supplierData.otaPaymentCollectionModel"],
			null
		);
		assert.equal(
			writtenFilter["supplierData.hotelRunner.transport"],
			"hotelrunner_api"
		);
		assert.equal(
			writtenFilter["supplierData.hotelRunner.reservationId"],
			"hotelrunner-commercial-id"
		);
		assert.equal(
			writtenFilter[
				"supplierData.hotelRunnerEmailCommercialEvidence.evidenceHash"
			].$ne.length,
			64
		);
		assert.equal(writtenUpdate.$inc.__v, 1);
		assert.equal(writtenUpdate.$set.commission, 0);
		assert.equal(writtenUpdate.$set.payment, "paid online");
		assert.equal(writtenUpdate.$set.financeStatus, "paid online");
		assert.equal(writtenUpdate.$set.paid_amount, 100);
		assert.equal(
			writtenUpdate.$set.paid_amount_breakdown
				.paid_online_other_platforms,
			100
		);
		assert.equal(
			writtenUpdate.$set.financial_cycle.collectionModel,
			"pms_collected"
		);
		assert.equal(writtenUpdate.$set.financial_cycle.pmsCollectedAmount, 100);
		assert.equal(writtenUpdate.$set.financial_cycle.hotelPayoutDue, 70);
		assert.equal(
			writtenUpdate.$set["supplierData.otaPaymentCollectionModel"],
			"ota_collect"
		);
		assert.equal(
			writtenUpdate.$set.commission_ota,
			null,
			"gross minus payout is not an OTA commission estimate"
		);
		assert.equal(writtenUpdate.$set["adminPricing.netAfterExpensesTotal"], 80);
		assert.equal(writtenUpdate.$set["adminPricing.otaExpenseTotal"], 20);
		assert.deepEqual(
			writtenUpdate.$set.pickedRoomsPricing[0].pricingByDay.map((day) => ({
				client: day.clientPrice,
				root: day.rootPrice,
				net: day.netAfterExpenses,
				expense: day.otaExpenseAmount,
				margin: day.platformMargin,
			})),
			[
				{ client: 50, root: 35, net: 40, expense: 10, margin: 5 },
				{ client: 50, root: 35, net: 40, expense: 10, margin: 5 },
			]
		);
		assert.equal(
			writtenUpdate.$set["ota_financial_summary.netAfterOtaExpenses"],
			80
		);
		assert.equal(
			writtenUpdate.$set[
				"supplierData.hotelRunnerEmailCommercialEvidence"
			].verified,
			true
		);
		assert.equal(
			writtenUpdate.$push.reservationAuditLog.action,
			"hotelrunner-commercial-enriched-from-verified-email"
		);
		assert.equal(writtenFilter.commission, 0);
		assert.equal(writtenFilter.commission_ota, null);
		for (const forbiddenPath of [
			"state",
			"reservation_status",
			"customer_details",
			"checkin_date",
			"checkout_date",
			"total_rooms",
			"sub_total",
			"payment_details",
			"supplierData.hotelRunner",
			"supplierData.otaSourceAuthority",
		]) {
			assert.equal(
				Object.prototype.hasOwnProperty.call(writtenUpdate.$set, forbiddenPath),
				false,
				forbiddenPath
			);
		}
		const materialized = applyDottedCommercialSet(existing, writtenUpdate.$set);
		assert.ok(
			verifiedHotelRunnerEmailCommercialEvidence(
				materialized,
				{ provider: "booking", grossTotalSar: 100, currency: "SAR" }
			)
		);
		assert.equal(
			verifiedHotelRunnerEmailCommercialEvidence(
				{
					...materialized,
					supplierData: {
						...materialized.supplierData,
						hotelRunnerEmailCommercialEvidence: {
							...materialized.supplierData
								.hotelRunnerEmailCommercialEvidence,
							evidenceHash: "f".repeat(64),
						},
					},
				},
				{ provider: "booking", grossTotalSar: 100, currency: "SAR" }
			),
			null,
			"a well-shaped but non-recomputed hash must not establish preservation authority"
		);
		assert.equal(
			verifiedHotelRunnerEmailCommercialEvidence(
				{
					...materialized,
					adminPricing: {
						...materialized.adminPricing,
						netAfterExpensesTotal: 1,
					},
				},
				{ provider: "booking", grossTotalSar: 100, currency: "SAR" }
			),
			null,
			"the marker cannot preserve pricing when its materialized fields drift"
		);
		const generalUpdaterSet = buildExistingReservationUpdateSet({
				normalized,
				existing,
				document: {
					state: "cancelled",
					total_amount: 1,
					customer_details: { name: "must-not-apply" },
				},
			});
		assert.deepEqual(
			Object.keys(generalUpdaterSet),
			[],
			"the lower-authority general updater must not replace canonical evidence or mutate reservation and finance fields"
		);
	} finally {
		Reservations.find = originalReservationFind;
		Reservations.updateOne = originalReservationUpdateOne;
		HotelDetails.find = originalHotelFind;
	}
});

test("OTA commission storage is nullable and remains separate from legacy commission", () => {
	assert.equal(Reservations.schema.path("commission").options.default, 0);
	assert.equal(Reservations.schema.path("commission_ota").instance, "Number");
	assert.equal(Reservations.schema.path("commission_ota").options.default, null);
	const reservation = new Reservations({ confirmation_number: "commission-fields" });
	assert.equal(reservation.commission, 0);
	assert.equal(reservation.commission_ota, null);
});

test("a pristine HotelRunner OTA review may receive verified commercial evidence", () => {
	const normalized = makeVerifiedHotelRunnerCommercialEmail();
	const existing = makeDirectHotelRunnerCommercialReservation({
		state: "OTA Platform Review",
		reservation_status: "OTA Platform Review",
		adminPricingVisibility: {
			rootOnlyForHotelManagement: true,
			source: "hotelrunner_api",
			appliedAt: new Date("2026-08-06T14:00:00.000Z"),
			appliedBy: null,
		},
		otaPlatformReview: {
			status: "pending",
			source: "hotelrunner_api",
			inboundEmailId: "",
			provider: "booking",
			providerLabel: "Booking.com",
			confirmationNumber: HOTELRUNNER_COMMERCIAL_CONFIRMATION,
			createdAt: new Date("2026-08-06T14:00:00.000Z"),
			releasedAt: null,
			releasedBy: null,
			priceAtRelease: 0,
			hotelRunnerManaged: true,
			hotelRunnerLinkedAt: new Date("2026-08-06T14:00:00.000Z"),
			lastHotelRunnerUpdatedAt: new Date("2026-08-06T14:00:00.000Z"),
			hotelAssignmentRequired: false,
			hotelAssignmentStatus: "assigned",
			assignedHotelId: HOTELRUNNER_COMMERCIAL_HOTEL_ID,
			assignedHotelName: "Zad Ajyad",
			assignedAt: new Date("2026-08-06T14:00:00.000Z"),
			roomMappingStatus: "mapped",
			roomMappingHotelId: HOTELRUNNER_COMMERCIAL_HOTEL_ID,
			lastUpdatedAt: new Date("2026-08-06T14:00:00.000Z"),
		},
	});
	const evidence = buildHotelRunnerEmailCommercialEvidence(normalized, {
		appliedAt: new Date("2026-08-06T15:00:01.000Z"),
	});
	const base = {
		normalized,
		existing,
		hotelDetails: hotelRunnerCommercialHotel(),
		matchedReservationBy: ["otaIdentityKey"],
		evidence,
	};
	assert.equal(directHotelRunnerEmailCommercialGuard(base).ok, true);
	assert.equal(
		directHotelRunnerEmailCommercialGuard({
			...base,
			existing: {
				...existing,
				state: "Pending Confirmation",
				reservation_status: "Pending Confirmation",
				otaPlatformReview: {
					...existing.otaPlatformReview,
					status: "released",
					releasedAt: new Date("2026-08-06T14:30:00.000Z"),
					releasedBy: { _id: "64b000000000000000000099" },
				},
			},
		}).reason,
		"protected_state",
		"a released review must remain protected"
	);
	assert.equal(
		directHotelRunnerEmailCommercialGuard({
			...base,
			existing: {
				...existing,
				createdByUserId: "64b000000000000000000099",
			},
		}).reason,
		"protected_state",
		"a manually created reservation must remain protected"
	);
});

test("same v2 evidence exactly rematerializes a one-cent nightly drift only while the HotelRunner review is pristine", async () => {
	const originalReservationUpdateOne = Reservations.updateOne;
	const originalReservationFindById = Reservations.findById;
	const dates = Array.from(
		{ length: 7 },
		(_value, index) => `2026-08-${String(10 + index).padStart(2, "0")}`
	);
	const malformedGrossRows = [
		60.23,
		60.23,
		60.23,
		60.22,
		60.22,
		60.22,
		60.22,
	];
	const exactPayoutRows = [
		56.89,
		56.89,
		56.89,
		56.89,
		56.89,
		56.88,
		56.88,
	];
	const foreignSource = makeVerifiedHotelRunnerCommercialEmail({
		checkinDate: dates[0],
		checkoutDate: "2026-08-17",
		amount: null,
		totalAmountSar: null,
		sourceAmount: 112.42,
		sourceCurrency: "USD",
		totalPayoutSar: null,
		netAfterExpensesTotal: null,
		currency: "USD",
		nightlyPricingSar: dates.map((date, index) => ({
			date,
			clientAmountSar: malformedGrossRows[index],
			payoutAmountSar: exactPayoutRows[index],
		})),
		paymentSummary: {
			sourceCurrency: "USD",
			sourceTotalGuestPaymentAmount: 112.42,
			sourceTotalPayoutAmount: 106.19,
			sourceTotalPayoutCurrency: "USD",
			totalGuestPaymentAmount: null,
			totalPayoutAmount: null,
			currency: null,
			exchangeRateToSar: null,
		},
	});
	const converted = await applyLiveSarConversion(foreignSource, {
		apiKey: "exact-cent-regression-credential",
		cache: new Map(),
		now: () => Date.parse("2026-08-10T17:22:00.000Z"),
		fetchImpl: async () => ({
			ok: true,
			async json() {
				return {
					result: "success",
					base_code: "USD",
					target_code: "SAR",
					conversion_rate: 3.75,
					time_last_update_unix:
						Date.parse("2026-08-10T17:20:00.000Z") / 1000,
				};
			},
		}),
	});
	const normalized = {
		...converted,
		amount: 421.58,
		totalAmountSar: 421.58,
		totalPayoutSar: 398.21,
		netAfterExpensesTotal: 398.21,
		paymentSummary: {
			...converted.paymentSummary,
			totalGuestPaymentAmount: 421.58,
			totalPayoutAmount: 398.21,
		},
	};
	const base = makeDirectHotelRunnerCommercialReservation();
	const sourceRooms = [
		{
			...base.pickedRoomsPricing[0],
			immutableRoomMetadata: { hotelRunnerRatePlan: "opaque-and-preserved" },
			pricingByDay: dates.map((date) => ({
				date,
				price: 60.23,
				clientPrice: 60.23,
				mainPrice: 60.23,
				rootPrice: 75,
				totalPriceWithCommission: 60.23,
				hotelRunnerSourcePrice: 60.23,
				immutableHotelRunnerDayFact: "opaque-and-preserved",
			})),
		},
	];
	const existing = makeDirectHotelRunnerCommercialReservation({
		state: "OTA Platform Review",
		reservation_status: "OTA Platform Review",
		checkin_date: dates[0],
		checkout_date: "2026-08-17",
		total_amount: 421.58,
		sub_total: 525,
		pickedRoomsType: structuredClone(sourceRooms),
		pickedRoomsPricing: structuredClone(sourceRooms),
		adminPricing: {
			...base.adminPricing,
			clientTotal: 421.58,
			rootTotal: 525,
		},
		ota_financial_summary: {
			...base.ota_financial_summary,
			clientTotal: 421.58,
			hotelVisibleAmount: 525,
		},
		adminPricingVisibility: {
			rootOnlyForHotelManagement: true,
			source: "hotelrunner_api",
			appliedAt: new Date("2026-08-10T17:20:00.000Z"),
			appliedBy: null,
		},
		otaPlatformReview: {
			status: "pending",
			source: "hotelrunner_api",
			inboundEmailId: "",
			provider: "booking",
			providerLabel: "Booking.com",
			confirmationNumber: HOTELRUNNER_COMMERCIAL_CONFIRMATION,
			createdAt: new Date("2026-08-10T17:20:00.000Z"),
			releasedAt: null,
			releasedBy: null,
			priceAtRelease: 0,
			hotelRunnerManaged: true,
			hotelRunnerLinkedAt: new Date("2026-08-10T17:20:00.000Z"),
			lastHotelRunnerUpdatedAt: new Date("2026-08-10T17:20:00.000Z"),
			hotelAssignmentRequired: false,
			hotelAssignmentStatus: "assigned",
			assignedHotelId: HOTELRUNNER_COMMERCIAL_HOTEL_ID,
			assignedHotelName: "Zad Ajyad",
			assignedAt: new Date("2026-08-10T17:20:00.000Z"),
			roomMappingStatus: "mapped",
			roomMappingHotelId: HOTELRUNNER_COMMERCIAL_HOTEL_ID,
			lastUpdatedAt: new Date("2026-08-10T17:20:00.000Z"),
		},
	});
	const evidence = buildHotelRunnerEmailCommercialEvidence(normalized, {
		appliedAt: new Date("2026-08-10T17:23:01.000Z"),
	});
	assert.ok(evidence);
	const exactSet = directHotelRunnerCommercialEnrichmentSet(
		normalized,
		evidence,
		{ existing, materializeVerifiedOtaCollectPayment: true }
	);
	assert.ok(exactSet);
	const exactMaterialized = applyDottedCommercialSet(existing, exactSet);
	assert.equal(exactMaterialized.payment, "paid online");
	assert.equal(exactMaterialized.paid_amount, 421.58);
	assert.ok(
		verifiedHotelRunnerEmailCommercialEvidence(exactMaterialized, {
			provider: "booking",
			grossTotalSar: 421.58,
			currency: "SAR",
		})
	);

	const drifted = structuredClone(exactMaterialized);
	for (const roomsKey of ["pickedRoomsType", "pickedRoomsPricing"]) {
		const room = drifted[roomsKey][0];
		room.totalPriceWithCommission = 421.57;
		room.chosenPrice = 60.22;
		room.pricingByDay.forEach((day, index) => {
			const client = malformedGrossRows[index];
			const payout = exactPayoutRows[index];
			Object.assign(day, {
				price: client,
				clientPrice: client,
				mainPrice: client,
				totalPriceWithCommission: client,
				netAfterExpenses: payout,
				netAfterOtaExpenses: payout,
				otaExpenseAmount: Number((client - payout).toFixed(2)),
			});
		});
	}
	assert.equal(
		verifiedHotelRunnerEmailCommercialEvidence(drifted, {
			provider: "booking",
			grossTotalSar: 421.58,
			currency: "SAR",
		}),
		null,
		"a 421.57 nightly gross cannot satisfy the v2 marker for 421.58"
	);

	const guardInput = {
		normalized,
		existing: drifted,
		hotelDetails: hotelRunnerCommercialHotel(),
		matchedReservationBy: ["otaIdentityKey"],
		evidence,
	};
	assert.equal(directHotelRunnerEmailCommercialGuard(guardInput).ok, true);
	const paymentStateDrift = structuredClone(drifted);
	paymentStateDrift.payment = "finance hold";
	assert.equal(
		directHotelRunnerEmailCommercialGuard({
			...guardInput,
			existing: paymentStateDrift,
		}).reason,
		"protected_state"
	);
	const withAdditionalGrossDrift = (reservation, additionalDrift) => {
		const changed = structuredClone(reservation);
		changed.pickedRoomsType = structuredClone(reservation.pickedRoomsType);
		changed.pickedRoomsPricing = structuredClone(reservation.pickedRoomsPricing);
		for (const roomsKey of ["pickedRoomsType", "pickedRoomsPricing"]) {
			const room = changed[roomsKey][0];
			const day = room.pricingByDay[0];
			const client = Number((day.clientPrice - additionalDrift).toFixed(2));
			Object.assign(day, {
				price: client,
				clientPrice: client,
				mainPrice: client,
				totalPriceWithCommission: client,
				otaExpenseAmount: Number(
					(client - day.netAfterExpenses).toFixed(2)
				),
			});
			room.totalPriceWithCommission = Number(
				(room.totalPriceWithCommission - additionalDrift).toFixed(2)
			);
		}
		return changed;
	};
	const boundedDriftGuard = directHotelRunnerEmailCommercialGuard({
		...guardInput,
		existing: withAdditionalGrossDrift(drifted, 0.49),
	});
	assert.equal(
		boundedDriftGuard.ok,
		true,
		`the named 0.50 SAR daily-only drift bound remains eligible: ${JSON.stringify(
			boundedDriftGuard
		)}`
	);
	assert.equal(
		directHotelRunnerEmailCommercialGuard({
			...guardInput,
			existing: withAdditionalGrossDrift(drifted, 0.5),
		}).reason,
		"protected_state",
		"a 0.51 SAR drift remains fail-closed"
	);
	const nonDailyDrift = structuredClone(drifted);
	nonDailyDrift.supplierData.otaCommercialEvidence = {
		...nonDailyDrift.supplierData.otaCommercialEvidence,
		manualNonDailyFact: "must-not-overwrite",
	};
	assert.equal(
		directHotelRunnerEmailCommercialGuard({
			...guardInput,
			existing: nonDailyDrift,
		}).reason,
		"non_daily_commercial_drift"
	);
	const releasedAt = new Date("2026-08-10T17:30:00.000Z");
	assert.equal(
		directHotelRunnerEmailCommercialGuard({
			...guardInput,
			existing: {
				...drifted,
				state: "Pending Confirmation",
				reservation_status: "Pending Confirmation",
				otaPlatformReview: {
					...drifted.otaPlatformReview,
					status: "released",
					releasedAt,
					releasedBy: { role: "admin", name: "Admin" },
				},
				pendingConfirmation: {
					status: "pending",
					source: "ota_platform_release",
					releasedToHotelAt: releasedAt,
				},
			},
		}).reason,
		"protected_state"
	);
	for (const protectedStatus of ["cancelled", "inhouse", "checked_out"]) {
		assert.equal(
			directHotelRunnerEmailCommercialGuard({
				...guardInput,
				existing: {
					...drifted,
					state: protectedStatus,
					reservation_status: protectedStatus,
				},
			}).reason,
			"protected_state",
			protectedStatus
		);
	}

	let writtenFilter = null;
	let writtenUpdate = null;
	Reservations.updateOne = async (filter, update) => {
		writtenFilter = filter;
		writtenUpdate = update;
		return { matchedCount: 1 };
	};
	try {
		const result = await reconcileDirectHotelRunnerOwnedEmail({
			...guardInput,
			warnings: [],
			errors: [],
		});
		assert.equal(result.status, "updated", JSON.stringify(result));
		assert.equal(result.actionTaken, "commercial_enrichment");
		assert.equal(
			writtenFilter[
				"supplierData.hotelRunnerEmailCommercialEvidence.evidenceHash"
			],
			evidence.evidenceHash,
			"same-evidence repair uses equality CAS instead of the new-evidence $ne CAS"
		);
		const dailyLeafPath =
			/^pickedRooms(?:Type|Pricing)\.\d+\.(?:chosenPrice|totalPriceWithCommission|pricingByDay\.\d+\.(?:price|clientPrice|mainPrice|totalPriceWithCommission|netAfterExpenses|netAfterOtaExpenses|otaExpenseAmount|platformMargin|commercialVerification))$/;
		const writtenPaths = Object.keys(writtenUpdate.$set);
		assert.ok(
			writtenPaths.length > 0 &&
				writtenPaths.every((path) => dailyLeafPath.test(path)),
			"same-evidence repair writes only allowlisted dotted daily/room commercial leaves"
		);
		assert.equal(writtenPaths.includes("pickedRoomsPricing"), false);
		assert.equal(writtenPaths.includes("pickedRoomsType"), false);
		const repaired = applyDottedCommercialSet(drifted, writtenUpdate.$set);
		const repairedDays = repaired.pickedRoomsPricing[0].pricingByDay;
		assert.equal(
			repairedDays.reduce(
				(sum, day) => sum + decimalMoneyCents(day.clientPrice),
				0
			),
			42158
		);
		assert.equal(
			repairedDays.reduce(
				(sum, day) => sum + decimalMoneyCents(day.netAfterExpenses),
				0
			),
			39821
		);
		assert.equal(
			repairedDays.reduce(
				(sum, day) => sum + decimalMoneyCents(day.otaExpenseAmount),
				0
			),
			2337
		);
		assert.deepEqual(
			repaired.pickedRoomsPricing[0].immutableRoomMetadata,
			{ hotelRunnerRatePlan: "opaque-and-preserved" }
		);
		assert.ok(
			repairedDays.every(
				(day) =>
					day.immutableHotelRunnerDayFact === "opaque-and-preserved"
			)
		);
		assert.ok(
			verifiedHotelRunnerEmailCommercialEvidence(repaired, {
				provider: "booking",
				grossTotalSar: 421.58,
				currency: "SAR",
			})
		);

		let loserFilter = null;
		let loserUpdate = null;
		Reservations.updateOne = async (filter, update) => {
			loserFilter = filter;
			loserUpdate = update;
			return { matchedCount: 0 };
		};
		Reservations.findById = () => ({
			lean() {
				return this;
			},
			async exec() {
				return repaired;
			},
		});
		const casLoser = await reconcileDirectHotelRunnerOwnedEmail({
			...guardInput,
			warnings: [],
			errors: [],
		});
		assert.equal(casLoser.status, "duplicate_reservation");
		assert.equal(
			casLoser.skipReason,
			"hotelrunner_email_commercial_evidence_already_applied"
		);
		assert.equal(
			loserFilter[
				"supplierData.hotelRunnerEmailCommercialEvidence.evidenceHash"
			],
			evidence.evidenceHash
		);
		assert.ok(
			Object.keys(loserUpdate.$set).every((path) => dailyLeafPath.test(path))
		);
	} finally {
		Reservations.updateOne = originalReservationUpdateOne;
		Reservations.findById = originalReservationFindById;
	}
});

test("authenticated provider evidence reconciles an equal HotelRunner total without provider-specific semantics", async () => {
	const originalReservationFind = Reservations.find;
	const originalReservationUpdateOne = Reservations.updateOne;
	const originalHotelFind = HotelDetails.find;
	const normalized = makeVerifiedHotelRunnerCommercialEmail({
		provider: "agoda",
		providerLabel: "Agoda",
		bookingSource: "Agoda",
		commissionOta: 999,
	});
	const payoutRooms = makeDirectHotelRunnerCommercialReservation().pickedRoomsPricing.map(
		(room) => ({
			...room,
			pricingByDay: room.pricingByDay.map((day) => ({
				...day,
				price: 40,
				clientPrice: 40,
				mainPrice: 40,
				totalPriceWithCommission: 40,
				hotelRunnerSourcePrice: 40,
			})),
		})
	);
	const existing = makeDirectHotelRunnerCommercialReservation({
		otaIdentityKey: `agoda:${HOTELRUNNER_COMMERCIAL_CONFIRMATION}`,
		booking_source: "Agoda",
		total_amount: 80,
		adminPricing: {
			...makeDirectHotelRunnerCommercialReservation().adminPricing,
			clientTotal: 80,
		},
		ota_financial_summary: {
			...makeDirectHotelRunnerCommercialReservation().ota_financial_summary,
			clientTotal: 80,
		},
		pickedRoomsType: structuredClone(payoutRooms),
		pickedRoomsPricing: structuredClone(payoutRooms),
		supplierData: {
			...makeDirectHotelRunnerCommercialReservation().supplierData,
			supplierName: "Agoda",
			otaProvider: "agoda",
			hotelRunner: {
				...makeDirectHotelRunnerCommercialReservation().supplierData.hotelRunner,
				pricing: { total: 80, currency: "SAR", immutableMarker: true },
			},
		},
	});
	let writtenUpdate = null;
	Reservations.find = () => ({
		limit() {
			return this;
		},
		async exec() {
			return [existing];
		},
	});
	Reservations.updateOne = async (_filter, update) => {
		writtenUpdate = update;
		return { matchedCount: 1 };
	};
	HotelDetails.find = () => ({
		select() {
			return this;
		},
		async lean() {
			return [hotelRunnerCommercialHotel()];
		},
	});

	try {
		const result = await reconcileOtaReservation(normalized);
		assert.equal(result.status, "updated");
		assert.equal(result.actionTaken, "commercial_enrichment");
		assert.equal(writtenUpdate.$set.total_amount, 100);
		assert.equal(writtenUpdate.$set["adminPricing.clientTotal"], 100);
		assert.equal(writtenUpdate.$set["ota_financial_summary.clientTotal"], 100);
		assert.equal(writtenUpdate.$set.commission, 0);
		assert.equal(
			writtenUpdate.$set.commission_ota,
			null,
			"an untrusted input field and gross-minus-payout must not invent OTA commission"
		);
		assert.equal(
			Object.keys(writtenUpdate.$set).some((path) =>
				path.startsWith("supplierData.hotelRunner.pricing")
			),
			false,
			"the raw HotelRunner pricing snapshot must remain untouched"
		);

		const bookingExisting = {
			...existing,
			otaIdentityKey: `booking:${HOTELRUNNER_COMMERCIAL_CONFIRMATION}`,
			booking_source: "Booking.com",
			supplierData: {
				...existing.supplierData,
				supplierName: "Booking.com",
				otaProvider: "booking",
			},
		};
		const bookingNormalized = makeVerifiedHotelRunnerCommercialEmail();
		const bookingEvidence = buildHotelRunnerEmailCommercialEvidence(
			bookingNormalized,
			{ appliedAt: new Date("2026-08-06T15:00:01.000Z") }
		);
		const bookingGuard = directHotelRunnerEmailCommercialGuard({
			normalized: bookingNormalized,
			existing: bookingExisting,
			hotelDetails: hotelRunnerCommercialHotel(),
			matchedReservationBy: ["otaIdentityKey"],
			evidence: bookingEvidence,
		});
		assert.equal(bookingGuard.ok, true);
		assert.equal(
			bookingGuard.reportedTotalRole,
			"payout",
			"the role is reconciled by exact verified amount equality, not by OTA brand"
		);
	} finally {
		Reservations.find = originalReservationFind;
		Reservations.updateOne = originalReservationUpdateOne;
		HotelDetails.find = originalHotelFind;
	}
});

test("production-shaped Agoda 687715051 enriches the same HotelRunner reservation with explicit commission and reconciled daily pricing", async () => {
	const originalReservationFind = Reservations.find;
	const originalReservationUpdateOne = Reservations.updateOne;
	const originalReservationCreate = Reservations.create;
	const originalHotelFind = HotelDetails.find;
	const quadRoomId = "64b0000000000000000000f3";
	const sourceRooms = [
		{
			room_type: "quadRooms",
			displayName: "Quadruple Room – Comfort & Privacy",
			sourceRoomName:
				"Deluxe Family Room 2 - Non-Refundable - 2 Occupancy - NR",
			hotelRoomConfigId: quadRoomId,
			localRoomConfigId: quadRoomId,
			count: 1,
			pricingByDay: ["2026-08-09", "2026-08-10"].map((date) => ({
				date,
				price: 53.37,
				clientPrice: 53.37,
				mainPrice: 53.37,
				rootPrice: 75,
				totalPriceWithCommission: 53.37,
				hotelRunnerSourcePrice: 53.37,
			})),
		},
	];
	const base = makeDirectHotelRunnerCommercialReservation();
	const existing = makeDirectHotelRunnerCommercialReservation({
		_id: "6a77a0ebde7b4b5990aba1ac",
		__v: 0,
		confirmation_number: "4097979349",
		reservation_id: "687715051",
		otaIdentityKey: "agoda:687715051",
		booking_source: "Agoda",
		customer_details: {
			...base.customer_details,
			confirmation_number2: "687715051",
			booking_source: "Agoda",
		},
		checkin_date: "2026-08-09",
		checkout_date: "2026-08-11",
		total_amount: 106.74,
		sub_total: 150,
		payment: "not provided",
		paid_amount_breakdown: {
			paid_online_via_link: 0,
			paid_at_hotel_cash: 0,
			paid_at_hotel_card: 0,
			paid_to_hotel: 0,
			paid_online_jannatbooking: 0,
			paid_online_other_platforms: 0,
			paid_online_via_instapay: 0,
			paid_no_show: 0,
			payment_comments: "",
		},
		financial_cycle: {
			collectionModel: "pending",
			status: "open",
			commissionType: "amount",
			commissionValue: 0,
			commissionAmount: 0,
			commissionAssigned: false,
			pmsCollectedAmount: 0,
			hotelCollectedAmount: 0,
			hotelPayoutDue: 0,
			commissionDueToPms: 0,
			lastUpdatedAt: null,
		},
		pickedRoomsType: structuredClone(sourceRooms),
		pickedRoomsPricing: structuredClone(sourceRooms),
		adminPricing: {
			...base.adminPricing,
			clientTotal: 106.74,
			rootTotal: 150,
			platformMarginTotal: -43.26,
		},
		ota_financial_summary: {
			...base.ota_financial_summary,
			clientTotal: 106.74,
			hotelVisibleAmount: 150,
		},
		supplierData: {
			...base.supplierData,
			supplierName: "Agoda",
			suppliedBookingNo: "687715051",
			otaConfirmationNumber: "687715051",
			platformConfirmationNumber: "687715051",
			otaProvider: "agoda",
			hotelRunner: {
				...base.supplierData.hotelRunner,
				reservationId: "40369350",
				reportedPaymentMethod: "not provided",
				pricing: { total: 106.74, currency: "SAR" },
			},
		},
	});
	const normalized = {
		...extractNormalizedReservation(
			authenticatedAgodaCommercialVoucher({
				bookingId: "687715051",
				checkin: "August 9, 2026",
				checkout: "August 11, 2026",
				roomName: "Deluxe Family Room 2",
				adults: 4,
				nightly: [
					["August 9, 2026", "53.37"],
					["August 10, 2026", "53.37"],
				],
				gross: "172.48",
				net: "106.74",
				commission: "25.88",
				growthProgram: "17.24",
				taxOnCommission: "6.46",
			})
		),
		inboundEmailId: "6a77a0e3bf632980ba061c1f",
	};
	let writtenFilter = null;
	let writtenUpdate = null;
	let creates = 0;
	Reservations.find = () => ({
		limit() {
			return this;
		},
		async exec() {
			return [existing];
		},
	});
	Reservations.updateOne = async (filter, update) => {
		writtenFilter = filter;
		writtenUpdate = update;
		return { matchedCount: 1 };
	};
	Reservations.create = async () => {
		creates += 1;
		throw new Error("commercial enrichment must not create another reservation");
	};
	HotelDetails.find = () => ({
		select() {
			return this;
		},
		async lean() {
			return [hotelRunnerCommercialHotel()];
		},
	});

	try {
		const result = await reconcileOtaReservation(normalized);
		assert.equal(result.status, "updated");
		assert.equal(result.actionTaken, "commercial_enrichment");
		assert.equal(String(result.reservationId), existing._id);
		assert.equal(creates, 0);
		assert.equal(writtenFilter._id, existing._id);
		assert.equal(writtenFilter.__v, 0);
		assert.equal(writtenFilter.total_amount, 106.74);
		assert.equal(writtenFilter.payment, "not provided");
		assert.equal(writtenFilter.financeStatus, "not paid");
		assert.equal(writtenFilter.paid_amount, 0);
		assert.deepEqual(
			writtenFilter.paid_amount_breakdown,
			existing.paid_amount_breakdown
		);
		assert.deepEqual(writtenFilter.financial_cycle, existing.financial_cycle);
		assert.deepEqual(writtenFilter.pickedRoomsPricing, sourceRooms);
		assert.equal(writtenUpdate.$set.total_amount, 172.48);
		assert.equal(writtenUpdate.$set.payment, "paid online");
		assert.equal(writtenUpdate.$set.financeStatus, "paid online");
		assert.equal(writtenUpdate.$set.paid_amount, 172.48);
		assert.equal(
			writtenUpdate.$set.paid_amount_breakdown
				.paid_online_other_platforms,
			172.48
		);
		assert.equal(writtenUpdate.$set.financial_cycle.pmsCollectedAmount, 172.48);
		assert.equal(writtenUpdate.$set.financial_cycle.hotelPayoutDue, 150);
		assert.equal(
			writtenUpdate.$set["supplierData.otaPaymentCollectionModel"],
			"ota_collect"
		);
		assert.equal(writtenUpdate.$set.commission, 0);
		assert.equal(writtenUpdate.$set.commission_ota, 25.88);
		assert.equal(writtenUpdate.$set["adminPricing.clientTotal"], 172.48);
		assert.equal(writtenUpdate.$set["adminPricing.netAfterExpensesTotal"], 106.74);
		assert.equal(writtenUpdate.$set["adminPricing.otaExpenseTotal"], 65.74);
		assert.equal(writtenUpdate.$set["adminPricing.platformMarginTotal"], -43.26);
		assert.equal(writtenUpdate.$set["ota_financial_summary.otaCommissionAmount"], 25.88);
		assert.equal(writtenUpdate.$set["ota_financial_summary.unclassifiedOtaDeduction"], 16.16);
		assert.deepEqual(
			writtenUpdate.$set["ota_financial_summary.otaDeductionBreakdown"].map(
				(component) => [component.type, component.amountSar]
			),
			[
				["commission", 25.88],
				["growth_program", 17.24],
				["tax_on_commission", 6.46],
			]
		);
		assert.deepEqual(
			writtenUpdate.$set.pickedRoomsPricing[0].pricingByDay.map((day) => ({
				date: day.date,
				client: day.clientPrice,
				root: day.rootPrice,
				net: day.netAfterExpenses,
				expense: day.otaExpenseAmount,
				margin: day.platformMargin,
				source: day.hotelRunnerSourcePrice,
			})),
			[
				{
					date: "2026-08-09",
					client: 86.24,
					root: 75,
					net: 53.37,
					expense: 32.87,
					margin: -21.63,
					source: 53.37,
				},
				{
					date: "2026-08-10",
					client: 86.24,
					root: 75,
					net: 53.37,
					expense: 32.87,
					margin: -21.63,
					source: 53.37,
				},
			]
		);
		assert.deepEqual(
			writtenUpdate.$set.pickedRoomsType,
			writtenUpdate.$set.pickedRoomsPricing
		);
		for (const protectedPath of [
			"sub_total",
			"state",
			"reservation_status",
			"checkin_date",
			"checkout_date",
			"customer_details",
			"roomId",
			"payment_details",
			"supplierData.hotelRunner",
		]) {
			assert.equal(
				Object.prototype.hasOwnProperty.call(writtenUpdate.$set, protectedPath),
				false,
				protectedPath
			);
		}
		const materialized = applyDottedCommercialSet(existing, writtenUpdate.$set);
		assert.ok(
			verifiedHotelRunnerEmailCommercialEvidence(materialized, {
				provider: "agoda",
				grossTotalSar: 172.48,
				currency: "SAR",
			})
		);
	} finally {
		Reservations.find = originalReservationFind;
		Reservations.updateOne = originalReservationUpdateOne;
		Reservations.create = originalReservationCreate;
		HotelDetails.find = originalHotelFind;
	}
});

test("an Agoda two-room allocation review enriches only the already direct-owned commercial bundle", async () => {
	const originalReservationFind = Reservations.find;
	const originalReservationUpdateOne = Reservations.updateOne;
	const originalReservationCreate = Reservations.create;
	const originalHotelFind = HotelDetails.find;
	const confirmationNumber = "2039008308";
	const allocationReason =
		"Agoda email contains multiple rooms; automatic partial-room creation is disabled and the booking requires room review.";
	const stayDates = ["2026-11-04", "2026-11-05", "2026-11-06"];
	const normalized = makeVerifiedHotelRunnerCommercialEmail({
		provider: "agoda",
		providerLabel: "Agoda",
		bookingSource: "Agoda",
		confirmationNumber,
		reservationId: confirmationNumber,
		roomName: "Standard Quadruple Room",
		checkinDate: "2026-11-04",
		checkoutDate: "2026-11-07",
		amount: 588,
		totalAmountSar: 588,
		sourceAmount: 588,
		sourceCurrency: "SAR",
		totalPayoutSar: 363.78,
		netAfterExpensesTotal: 363.78,
		otaCommissionSar: 88.2,
		otaCommissionSourceAmount: 88.2,
		otaCommissionCurrency: "SAR",
		otaCommissionSource: "agoda_commission",
		otaDeductionConflict: false,
		otaDeductionComponents: [
			{
				type: "commission",
				label: "Commission",
				amountSar: 88.2,
				sourceAmount: 88.2,
				currency: "SAR",
				source: "authenticated_agoda_email",
			},
			{
				type: "growth_program",
				label: "Agoda Growth Program",
				amountSar: 58.8,
				sourceAmount: 58.8,
				currency: "SAR",
				source: "authenticated_agoda_email",
			},
			{
				type: "tax_on_commission",
				label: "Tax on Commission",
				amountSar: 22.05,
				sourceAmount: 22.05,
				currency: "SAR",
				source: "authenticated_agoda_email",
			},
		],
		paymentSummary: {
			sourceCurrency: "SAR",
			sourceTotalGuestPaymentAmount: 588,
			sourceTotalPayoutAmount: 363.78,
			sourceTotalPayoutCurrency: "SAR",
			totalGuestPaymentAmount: 588,
			totalPayoutAmount: 363.78,
			currency: "SAR",
			exchangeRateToSar: 1,
			exchangeRateSource: "identity",
		},
		roomCount: 2,
		totalGuests: 8,
		adults: 8,
		children: 0,
		requiresManualReview: true,
		ambiguousMultiRoomEvidence: true,
		blocksUnmappedReservationCreation: true,
		manualReviewReasons: [allocationReason],
		sourcePresence: { otaCommission: true },
		source: {
			from: "Agoda <no-reply@agoda.com>",
			subject: "Authenticated Agoda two-room commercial confirmation",
			messageId: "agoda-two-room-commercial-fixture",
			receivedAt: "2026-08-09T15:28:53.000Z",
		},
	});
	const sourceRooms = [0, 1].map((roomIndex) => ({
		room_type: "quadRooms",
		displayName: "Standard Quadruple Room",
		sourceRoomName: "Standard Quadruple Room - Non-Refundable - Room Only",
		hotelRoomConfigId: HOTELRUNNER_COMMERCIAL_ROOM_ID,
		localRoomConfigId: HOTELRUNNER_COMMERCIAL_ROOM_ID,
		providerRoomIndex: roomIndex,
		count: 1,
		pricingByDay: stayDates.map((date) => ({
			date,
			price: 60.63,
			clientPrice: 60.63,
			mainPrice: 60.63,
			rootPrice: 89,
			totalPriceWithCommission: 60.63,
			hotelRunnerSourcePrice: 60.63,
		})),
	}));
	const base = makeDirectHotelRunnerCommercialReservation();
	const existing = makeDirectHotelRunnerCommercialReservation({
		_id: "sanitized-two-room-direct-hotelrunner",
		__v: 0,
		confirmation_number: "sanitized-pms-8308",
		reservation_id: confirmationNumber,
		otaIdentityKey: `agoda:${confirmationNumber}`,
		booking_source: "Agoda",
		customer_details: {
			...base.customer_details,
			confirmation_number2: confirmationNumber,
			booking_source: "Agoda",
		},
		state: "OTA Platform Review",
		reservation_status: "OTA Platform Review",
		checkin_date: "2026-11-04",
		checkout_date: "2026-11-07",
		total_rooms: 2,
		total_amount: 363.78,
		sub_total: 534,
		pickedRoomsType: structuredClone(sourceRooms),
		pickedRoomsPricing: structuredClone(sourceRooms),
		adminPricing: {
			...base.adminPricing,
			clientTotal: 363.78,
			rootTotal: 534,
		},
		ota_financial_summary: {
			...base.ota_financial_summary,
			clientTotal: 363.78,
			hotelVisibleAmount: 534,
		},
		adminPricingVisibility: {
			rootOnlyForHotelManagement: true,
			source: "hotelrunner_api",
			appliedAt: new Date("2026-08-09T15:29:46.000Z"),
			appliedBy: null,
		},
		otaPlatformReview: {
			status: "pending",
			source: "hotelrunner_api",
			inboundEmailId: "",
			provider: "agoda",
			providerLabel: "Agoda",
			confirmationNumber,
			createdAt: new Date("2026-08-09T15:29:46.000Z"),
			releasedAt: null,
			releasedBy: null,
			priceAtRelease: 0,
			hotelRunnerManaged: true,
			hotelRunnerLinkedAt: new Date("2026-08-09T15:29:46.000Z"),
			lastHotelRunnerUpdatedAt: new Date("2026-08-09T15:29:46.000Z"),
			hotelAssignmentRequired: false,
			hotelAssignmentStatus: "assigned",
			assignedHotelId: HOTELRUNNER_COMMERCIAL_HOTEL_ID,
			assignedHotelName: "Zad Ajyad",
			assignedAt: new Date("2026-08-09T15:29:46.000Z"),
			roomMappingStatus: "mapped",
			roomMappingHotelId: HOTELRUNNER_COMMERCIAL_HOTEL_ID,
			lastUpdatedAt: new Date("2026-08-09T15:29:46.000Z"),
		},
		supplierData: {
			...base.supplierData,
			supplierName: "Agoda",
			suppliedBookingNo: confirmationNumber,
			otaConfirmationNumber: confirmationNumber,
			platformConfirmationNumber: confirmationNumber,
			otaProvider: "agoda",
		},
	});
	const hotel = hotelRunnerCommercialHotel();
	hotel.roomCountDetails = [
		{
			...hotel.roomCountDetails[0],
			_id: HOTELRUNNER_COMMERCIAL_ROOM_ID,
			roomType: "quadRooms",
			displayName: "Standard Quadruple Room",
			activeRoom: true,
		},
	];
	const evidence = buildHotelRunnerEmailCommercialEvidence(normalized, {
		appliedAt: new Date("2026-08-09T15:30:00.000Z"),
	});
	assert.ok(evidence);
	assert.deepEqual(
		[evidence.grossTotalSar, evidence.payoutTotalSar, evidence.otaExpenseTotalSar],
		[588, 363.78, 224.22]
	);
	const guardArgs = {
		normalized,
		existing,
		hotelDetails: hotel,
		matchedReservationBy: ["otaIdentityKey"],
		evidence,
	};
	const guard = directHotelRunnerEmailCommercialGuard(guardArgs);
	assert.equal(guard.ok, true, guard.reason);
	assert.equal(guard.reportedTotalRole, "payout");

	let writtenFilter = null;
	let writtenUpdate = null;
	Reservations.find = () => ({
		limit() {
			return this;
		},
		async exec() {
			return [existing];
		},
	});
	Reservations.updateOne = async (filter, update) => {
		writtenFilter = filter;
		writtenUpdate = update;
		return { matchedCount: 1 };
	};
	Reservations.create = async () => {
		throw new Error("the allocation-review path must never create a reservation");
	};
	HotelDetails.find = () => ({
		select() {
			return this;
		},
		async lean() {
			return [hotel];
		},
	});

	try {
		const result = await reconcileOtaReservation(normalized);
		assert.equal(result.status, "updated");
		assert.equal(result.actionTaken, "commercial_enrichment");
		assert.equal(result.reservationId, existing._id);
		assert.equal(writtenFilter._id, existing._id);
		assert.equal(writtenFilter.__v, 0);
		assert.equal(writtenUpdate.$set.total_amount, 588);
		assert.equal(writtenUpdate.$set.payment, "paid online");
		assert.equal(writtenUpdate.$set.financeStatus, "paid online");
		assert.equal(writtenUpdate.$set.paid_amount, 588);
		assert.equal(
			writtenUpdate.$set.paid_amount_breakdown
				.paid_online_other_platforms,
			588
		);
		assert.equal(writtenUpdate.$set.financial_cycle.pmsCollectedAmount, 588);
		assert.equal(writtenUpdate.$set.financial_cycle.hotelPayoutDue, 534);
		assert.equal(
			writtenUpdate.$set["supplierData.otaPaymentCollectionModel"],
			"ota_collect"
		);
		assert.equal(writtenUpdate.$set.commission_ota, 88.2);
		assert.equal(writtenUpdate.$set["adminPricing.clientTotal"], 588);
		assert.equal(
			writtenUpdate.$set["adminPricing.netAfterExpensesTotal"],
			363.78
		);
		assert.equal(writtenUpdate.$set["adminPricing.otaExpenseTotal"], 224.22);
		assert.equal(writtenUpdate.$set["adminPricing.platformMarginTotal"], -170.22);
		assert.equal(
			writtenUpdate.$set["ota_financial_summary.unclassifiedOtaDeduction"],
			55.17
		);
		const daily = writtenUpdate.$set.pickedRoomsPricing.flatMap((room) =>
			room.pricingByDay.map((day) => ({
				client: day.clientPrice,
				root: day.rootPrice,
				net: day.netAfterExpenses,
				expense: day.otaExpenseAmount,
				margin: day.platformMargin,
			}))
		);
		assert.equal(daily.length, 6);
		assert.ok(
			daily.every(
				(day) =>
					day.client === 98 &&
					day.root === 89 &&
					day.net === 60.63 &&
					day.expense === 37.37 &&
					day.margin === -28.37
			)
		);
		assert.ok(
			writtenUpdate.$set.pickedRoomsPricing.every(
				(room) =>
					room.hotelRoomConfigId === HOTELRUNNER_COMMERCIAL_ROOM_ID &&
					room.localRoomConfigId === HOTELRUNNER_COMMERCIAL_ROOM_ID
			)
		);
		for (const protectedPath of [
			"state",
			"reservation_status",
			"hotelId",
			"belongsTo",
			"checkin_date",
			"checkout_date",
			"total_rooms",
			"sub_total",
			"roomId",
			"payment_details",
			"supplierData.hotelRunner",
		]) {
			assert.equal(
				Object.prototype.hasOwnProperty.call(writtenUpdate.$set, protectedPath),
				false,
				protectedPath
			);
		}

		const clone = (value) => structuredClone(value);
		const nearMisses = [
			{
				label: "another manual reason",
				normalized: {
					...clone(normalized),
					manualReviewReasons: [allocationReason, "Another reason"],
				},
				reason: "source_authority",
			},
			{
				label: "room-count mismatch",
				normalized: { ...clone(normalized), roomCount: 1 },
				reason: "room_count",
			},
			{
				label: "heterogeneous mapped rooms",
				existing: (() => {
					const changed = clone(existing);
					changed.pickedRoomsType[1].hotelRoomConfigId = "different-room";
					changed.pickedRoomsType[1].localRoomConfigId = "different-room";
					changed.pickedRoomsPricing = clone(changed.pickedRoomsType);
					return changed;
				})(),
				reason: "room_identity",
			},
			{
				label: "HotelRunner amount matches neither gross nor payout",
				existing: {
					...clone(existing),
					total_amount: 400,
					adminPricing: { ...clone(existing.adminPricing), clientTotal: 400 },
					ota_financial_summary: {
						...clone(existing.ota_financial_summary),
						clientTotal: 400,
					},
				},
				reason: "hotelrunner_amount",
			},
			{
				label: "root drift",
				existing: {
					...clone(existing),
					sub_total: 535,
					adminPricing: { ...clone(existing.adminPricing), rootTotal: 535 },
					ota_financial_summary: {
						...clone(existing.ota_financial_summary),
						hotelVisibleAmount: 535,
					},
				},
				reason: "daily_pricing",
			},
			{
				label: "assigned physical room",
				existing: { ...clone(existing), roomId: ["assigned-room"] },
				reason: "protected_state",
			},
		];
		for (const nearMiss of nearMisses) {
			const candidateNormalized = nearMiss.normalized || normalized;
			const candidateEvidence = buildHotelRunnerEmailCommercialEvidence(
				candidateNormalized,
				{ appliedAt: new Date("2026-08-09T15:30:00.000Z") }
			);
			const candidateGuard = directHotelRunnerEmailCommercialGuard({
				...guardArgs,
				normalized: candidateNormalized,
				existing: nearMiss.existing || existing,
				evidence: candidateEvidence || evidence,
			});
			assert.equal(candidateGuard.ok, false, nearMiss.label);
			assert.equal(candidateGuard.reason, nearMiss.reason, nearMiss.label);
		}

		let lookupCalls = 0;
		let creationCalls = 0;
		Reservations.find = () => ({
			limit() {
				return this;
			},
			async exec() {
				lookupCalls += 1;
				return [];
			},
		});
		Reservations.create = async () => {
			creationCalls += 1;
			throw new Error("multi-room email creation must remain blocked");
		};
		writtenUpdate = null;
		const noDirectWinner = await reconcileOtaReservation(clone(normalized));
		assert.equal(noDirectWinner.status, "needs_review");
		assert.equal(noDirectWinner.skipReason, "ota_parser_requires_manual_review");
		assert.equal(lookupCalls, 1);
		assert.equal(creationCalls, 0);
		assert.equal(writtenUpdate, null);

		Reservations.find = () => {
			throw new Error("any other manual-review reason must stop before lookup");
		};
		const otherManualReason = await reconcileOtaReservation({
			...clone(normalized),
			manualReviewReasons: [allocationReason, "Another reason"],
		});
		assert.equal(otherManualReason.status, "needs_review");
		assert.equal(otherManualReason.skipReason, "ota_parser_requires_manual_review");
	} finally {
		Reservations.find = originalReservationFind;
		Reservations.updateOne = originalReservationUpdateOne;
		Reservations.create = originalReservationCreate;
		HotelDetails.find = originalHotelFind;
	}
});

test("a HotelRunner row that appears at the pre-create recheck is enriched in place instead of returned as a bare duplicate", async () => {
	const originalReservationFind = Reservations.find;
	const originalReservationUpdateOne = Reservations.updateOne;
	const originalReservationCreate = Reservations.create;
	const originalHotelFind = HotelDetails.find;
	const bookingId = "687700002";
	const base = makeDirectHotelRunnerCommercialReservation();
	const payoutRooms = base.pickedRoomsPricing.map((room) => ({
		...room,
		pricingByDay: room.pricingByDay.map((day) => ({
			...day,
			price: 40,
			clientPrice: 40,
			mainPrice: 40,
			totalPriceWithCommission: 40,
			hotelRunnerSourcePrice: 40,
		})),
	}));
	const appearedHotelRunnerReservation = makeDirectHotelRunnerCommercialReservation({
		reservation_id: bookingId,
		otaIdentityKey: `agoda:${bookingId}`,
		booking_source: "Agoda",
		customer_details: {
			...base.customer_details,
			confirmation_number2: bookingId,
			booking_source: "Agoda",
		},
		total_amount: 80,
		pickedRoomsType: structuredClone(payoutRooms),
		pickedRoomsPricing: structuredClone(payoutRooms),
		adminPricing: { ...base.adminPricing, clientTotal: 80 },
		ota_financial_summary: {
			...base.ota_financial_summary,
			clientTotal: 80,
		},
		supplierData: {
			...base.supplierData,
			supplierName: "Agoda",
			suppliedBookingNo: bookingId,
			otaConfirmationNumber: bookingId,
			platformConfirmationNumber: bookingId,
			otaProvider: "agoda",
		},
	});
	const normalized = {
		...extractNormalizedReservation(
			authenticatedAgodaCommercialVoucher({
				bookingId,
				checkin: "September 10, 2026",
				checkout: "September 12, 2026",
				roomName: "Double Room",
				adults: 2,
				nightly: [
					["September 10, 2026", "40.00"],
					["September 11, 2026", "40.00"],
				],
				gross: "100.00",
				net: "80.00",
				commission: "15.00",
				growthProgram: "3.00",
				taxOnCommission: "2.00",
			})
		),
		inboundEmailId: "audit-pre-create-race",
	};
	let lookupCount = 0;
	let creates = 0;
	let writtenUpdate = null;
	Reservations.find = () => ({
		limit() {
			return this;
		},
		async exec() {
			lookupCount += 1;
			return lookupCount === 1 ? [] : [appearedHotelRunnerReservation];
		},
	});
	Reservations.updateOne = async (_filter, update) => {
		writtenUpdate = update;
		return { matchedCount: 1 };
	};
	Reservations.create = async () => {
		creates += 1;
		throw new Error("the raced HotelRunner reservation must not be recreated");
	};
	const hotel = hotelRunnerCommercialHotel();
	hotel.roomCountDetails = hotel.roomCountDetails.map((room, index) =>
		index === 0
			? {
					...room,
					pricingRate: ["2026-09-10", "2026-09-11"].map(
						(calendarDate) => ({ calendarDate, rootPrice: 35 })
					),
			  }
			: room
	);
	HotelDetails.find = () => ({
		select() {
			return this;
		},
		async lean() {
			return [hotel];
		},
	});

	try {
		const result = await reconcileOtaReservation(normalized);
		assert.equal(result.status, "updated");
		assert.equal(result.actionTaken, "commercial_enrichment");
		assert.equal(result.reservationId, appearedHotelRunnerReservation._id);
		assert.equal(lookupCount, 2);
		assert.equal(creates, 0);
		assert.equal(writtenUpdate.$set.total_amount, 100);
		assert.equal(writtenUpdate.$set.commission_ota, 15);
		assert.equal(
			writtenUpdate.$set["supplierData.hotelRunnerEmailCommercialEvidence"].inboundEmailId,
			"audit-pre-create-race"
		);
	} finally {
		Reservations.find = originalReservationFind;
		Reservations.updateOne = originalReservationUpdateOne;
		Reservations.create = originalReservationCreate;
		HotelDetails.find = originalHotelFind;
	}
});

test("an E11000 email-create race reloads and commercially reconciles the direct HotelRunner winner", async () => {
	const originalReservationFind = Reservations.find;
	const originalReservationExists = Reservations.exists;
	const originalReservationUpdateOne = Reservations.updateOne;
	const originalReservationCreate = Reservations.create;
	const originalHotelFind = HotelDetails.find;
	const originalAiToken = process.env.CHATGPT_API_TOKEN;
	delete process.env.CHATGPT_API_TOKEN;
	const confirmationNumber = "race-commercial-11000";
	const sourceRoomName = "Opaque Provider Room Alpha";
	const normalized = makeVerifiedHotelRunnerCommercialEmail({
		confirmationNumber,
		reservationId: confirmationNumber,
		roomName: sourceRoomName,
		inboundEmailId: "audit-e11000-commercial-race",
		source: {
			messageId: "e11000-commercial-race",
			receivedAt: "2026-08-09T16:00:00.000Z",
		},
	});
	const base = makeDirectHotelRunnerCommercialReservation();
	const winnerRooms = base.pickedRoomsPricing.map((room) => ({
		...room,
		sourceRoomName,
		pricingByDay: room.pricingByDay.map((day) => ({
			...day,
			price: 40,
			clientPrice: 40,
			mainPrice: 40,
			totalPriceWithCommission: 40,
			hotelRunnerSourcePrice: 40,
		})),
	}));
	const winner = makeDirectHotelRunnerCommercialReservation({
		_id: "hotelrunner-e11000-winner",
		__v: 2,
		confirmation_number: "pms-e11000-winner",
		reservation_id: confirmationNumber,
		otaIdentityKey: `booking:${confirmationNumber}`,
		total_amount: 80,
		pickedRoomsType: structuredClone(winnerRooms),
		pickedRoomsPricing: structuredClone(winnerRooms),
		adminPricing: { ...base.adminPricing, clientTotal: 80 },
		ota_financial_summary: {
			...base.ota_financial_summary,
			clientTotal: 80,
		},
		customer_details: {
			...base.customer_details,
			confirmation_number2: confirmationNumber,
		},
		supplierData: {
			...base.supplierData,
			suppliedBookingNo: confirmationNumber,
			otaConfirmationNumber: confirmationNumber,
			platformConfirmationNumber: confirmationNumber,
		},
	});
	let findCalls = 0;
	let createCalls = 0;
	let writtenUpdate = null;
	Reservations.find = () => ({
		limit() {
			return this;
		},
		select() {
			return this;
		},
		async exec() {
			findCalls += 1;
			return findCalls < 3 ? [] : [winner];
		},
	});
	Reservations.exists = async () => false;
	Reservations.create = async () => {
		createCalls += 1;
		const error = new Error("simulated OTA identity race");
		error.code = 11000;
		throw error;
	};
	Reservations.updateOne = async (_filter, update) => {
		writtenUpdate = update;
		return { matchedCount: 1 };
	};
	HotelDetails.find = () => ({
		select() {
			return this;
		},
		async lean() {
			return [hotelRunnerCommercialHotel()];
		},
	});

	try {
		const result = await reconcileOtaReservation(normalized);
		assert.equal(result.status, "updated", JSON.stringify(result));
		assert.equal(result.actionTaken, "commercial_enrichment");
		assert.equal(result.reservationId, winner._id);
		assert.equal(findCalls, 3);
		assert.equal(createCalls, 1);
		assert.equal(writtenUpdate.$set.total_amount, 100);
		assert.equal(writtenUpdate.$set["adminPricing.netAfterExpensesTotal"], 80);
		assert.equal(
			writtenUpdate.$set["supplierData.hotelRunnerEmailCommercialEvidence"]
				.inboundEmailId,
			"audit-e11000-commercial-race"
		);
	} finally {
		Reservations.find = originalReservationFind;
		Reservations.exists = originalReservationExists;
		Reservations.updateOne = originalReservationUpdateOne;
		Reservations.create = originalReservationCreate;
		HotelDetails.find = originalHotelFind;
		if (originalAiToken === undefined) delete process.env.CHATGPT_API_TOKEN;
		else process.env.CHATGPT_API_TOKEN = originalAiToken;
	}
});

test("a mapped email-create E11000 race also reconciles the reloaded direct HotelRunner winner", async () => {
	const originalReservationFind = Reservations.find;
	const originalReservationExists = Reservations.exists;
	const originalReservationUpdateOne = Reservations.updateOne;
	const originalReservationCreate = Reservations.create;
	const originalHotelFind = HotelDetails.find;
	const originalHotelFindById = HotelDetails.findById;
	const confirmationNumber = "mapped-race-commercial-11000";
	const normalized = makeVerifiedHotelRunnerCommercialEmail({
		confirmationNumber,
		reservationId: confirmationNumber,
		inboundEmailId: "audit-mapped-e11000-commercial-race",
		source: {
			messageId: "mapped-e11000-commercial-race",
			receivedAt: "2026-08-09T16:01:00.000Z",
		},
	});
	const base = makeDirectHotelRunnerCommercialReservation();
	const payoutRooms = base.pickedRoomsPricing.map((room) => ({
		...room,
		pricingByDay: room.pricingByDay.map((day) => ({
			...day,
			price: 40,
			clientPrice: 40,
			mainPrice: 40,
			totalPriceWithCommission: 40,
			hotelRunnerSourcePrice: 40,
		})),
	}));
	const winner = makeDirectHotelRunnerCommercialReservation({
		_id: "mapped-hotelrunner-e11000-winner",
		__v: 3,
		confirmation_number: "mapped-pms-e11000-winner",
		reservation_id: confirmationNumber,
		otaIdentityKey: `booking:${confirmationNumber}`,
		total_amount: 80,
		pickedRoomsType: structuredClone(payoutRooms),
		pickedRoomsPricing: structuredClone(payoutRooms),
		adminPricing: { ...base.adminPricing, clientTotal: 80 },
		ota_financial_summary: {
			...base.ota_financial_summary,
			clientTotal: 80,
		},
		customer_details: {
			...base.customer_details,
			confirmation_number2: confirmationNumber,
		},
		supplierData: {
			...base.supplierData,
			suppliedBookingNo: confirmationNumber,
			otaConfirmationNumber: confirmationNumber,
			platformConfirmationNumber: confirmationNumber,
		},
	});
	const hotel = hotelRunnerCommercialHotel();
	hotel.roomCountDetails[0] = {
		...hotel.roomCountDetails[0],
		price: { basePrice: 35 },
		pricingRate: ["2026-09-10", "2026-09-11"].map((calendarDate) => ({
			calendarDate,
			rootPrice: 35,
			price: 50,
		})),
	};
	let findCalls = 0;
	let createCalls = 0;
	let writtenUpdate = null;
	Reservations.find = () => ({
		limit() {
			return this;
		},
		select() {
			return this;
		},
		maxTimeMS() {
			return this;
		},
		lean() {
			return this;
		},
		async exec() {
			findCalls += 1;
			return findCalls === 4 ? [winner] : [];
		},
	});
	Reservations.exists = async () => false;
	Reservations.create = async () => {
		createCalls += 1;
		const error = new Error("simulated mapped OTA identity race");
		error.code = 11000;
		throw error;
	};
	Reservations.updateOne = async (_filter, update) => {
		writtenUpdate = update;
		return { matchedCount: 1 };
	};
	HotelDetails.find = () => ({
		select() {
			return this;
		},
		async lean() {
			return [hotel];
		},
	});
	HotelDetails.findById = () => ({
		select() {
			return this;
		},
		lean() {
			return this;
		},
		async exec() {
			return hotel;
		},
	});

	try {
		const result = await reconcileOtaReservation(normalized);
		assert.equal(result.status, "updated", JSON.stringify(result));
		assert.equal(result.actionTaken, "commercial_enrichment");
		assert.equal(result.reservationId, winner._id);
		assert.equal(findCalls, 4);
		assert.equal(createCalls, 1);
		assert.equal(writtenUpdate.$set.total_amount, 100);
		assert.equal(writtenUpdate.$set["adminPricing.netAfterExpensesTotal"], 80);
	} finally {
		Reservations.find = originalReservationFind;
		Reservations.exists = originalReservationExists;
		Reservations.updateOne = originalReservationUpdateOne;
		Reservations.create = originalReservationCreate;
		HotelDetails.find = originalHotelFind;
		HotelDetails.findById = originalHotelFindById;
	}
});

test("direct-owned commercial enrichment requires one unique HotelRunner amount role and protects local state", () => {
	const normalized = makeVerifiedHotelRunnerCommercialEmail();
	const existing = makeDirectHotelRunnerCommercialReservation();
	const evidence = buildHotelRunnerEmailCommercialEvidence(normalized, {
		appliedAt: new Date("2026-08-06T15:00:01.000Z"),
	});
	assert.ok(evidence);
	const base = {
		normalized,
		existing,
		hotelDetails: hotelRunnerCommercialHotel(),
		matchedReservationBy: ["otaIdentityKey"],
		evidence,
	};
	assert.equal(directHotelRunnerEmailCommercialGuard(base).ok, true);
	const unresolvedApiEvidence = buildHotelRunnerUnresolvedCommercialEvidence({
		provider: "booking",
		sourceType: "hotelrunner_webhook",
		reportedAmount: 80,
		reportedCurrency: "SAR",
		propertyCurrency: "SAR",
		sourceHash: "a".repeat(64),
		sourceTimestamp: "2026-08-06T14:00:00.000Z",
		sourceId: "hotelrunner-unresolved-placeholder",
	});
	const unresolvedRooms = existing.pickedRoomsPricing.map((room) => ({
		...room,
		pricingByDay: room.pricingByDay.map((day) => ({
			...day,
			price: null,
			clientPrice: null,
			mainPrice: null,
			totalPriceWithCommission: null,
			hotelRunnerSourcePrice: 40,
		})),
	}));
	const unresolvedExisting = makeDirectHotelRunnerCommercialReservation({
		total_amount: null,
		pickedRoomsType: unresolvedRooms,
		pickedRoomsPricing: structuredClone(unresolvedRooms),
		adminPricing: {
			...existing.adminPricing,
			clientTotal: null,
			sourceAmount: 80,
			sourceCurrency: "SAR",
			propertyCurrency: "SAR",
			hotelRunnerAmountRole: "unknown",
			payoutFallbackReason: "hotelrunner_payout_not_provided",
		},
		ota_financial_summary: {
			...existing.ota_financial_summary,
			clientTotal: null,
			sourceAmount: 80,
			sourceCurrency: "SAR",
			propertyCurrency: "SAR",
			hotelRunnerAmountRole: "unknown",
			payoutFallbackReason: "hotelrunner_payout_not_provided",
		},
		supplierData: {
			...existing.supplierData,
			otaCommercialEvidence: unresolvedApiEvidence,
			hotelRunner: {
				...existing.supplierData.hotelRunner,
				pricing: { currency: "SAR", grandTotal: 80 },
			},
		},
	});
	const unresolvedGuard = directHotelRunnerEmailCommercialGuard({
		...base,
		existing: unresolvedExisting,
	});
	assert.equal(unresolvedGuard.ok, true, JSON.stringify(unresolvedGuard));
	assert.equal(unresolvedGuard.hotelRunnerReportedTotal, 80);
	assert.equal(unresolvedGuard.reportedTotalRole, "payout");
	for (const [label, mutate] of [
		[
			"cross-surface API amount mismatch",
			(candidate) => {
				candidate.supplierData.hotelRunner.pricing.grandTotal = 80.03;
			},
		],
		[
			"tampered unresolved evidence hash",
			(candidate) => {
				candidate.supplierData.otaCommercialEvidence.hotelRunnerReportedAmount.amount =
					80.01;
			},
		],
		[
			"missing redundant API summary amount",
			(candidate) => {
				delete candidate.ota_financial_summary.sourceAmount;
			},
		],
	]) {
		const candidate = structuredClone(unresolvedExisting);
		mutate(candidate);
		assert.equal(
			directHotelRunnerEmailCommercialGuard({
				...base,
				existing: candidate,
			}).reason,
			"hotelrunner_amount",
			label
		);
	}
	const roleToleranceExisting = makeDirectHotelRunnerCommercialReservation({
		total_amount: 99.5,
		adminPricing: { ...existing.adminPricing, clientTotal: 99.5 },
		ota_financial_summary: {
			...existing.ota_financial_summary,
			clientTotal: 99.5,
		},
	});
	const roleToleranceGuard = directHotelRunnerEmailCommercialGuard({
		...base,
		existing: roleToleranceExisting,
	});
	assert.equal(roleToleranceGuard.ok, true);
	assert.equal(roleToleranceGuard.reportedTotalRole, "gross");
	const ambiguousNormalized = makeVerifiedHotelRunnerCommercialEmail({
		totalPayoutSar: 99.75,
		netAfterExpensesTotal: 99.75,
		paymentSummary: {
			sourceTotalPayoutAmount: 99.75,
			totalPayoutAmount: 99.75,
		},
	});
	const ambiguousEvidence = buildHotelRunnerEmailCommercialEvidence(
		ambiguousNormalized,
		{ appliedAt: new Date("2026-08-06T15:00:01.000Z") }
	);
	const ambiguousExisting = makeDirectHotelRunnerCommercialReservation({
		total_amount: 99.8,
		adminPricing: { ...existing.adminPricing, clientTotal: 99.8 },
		ota_financial_summary: {
			...existing.ota_financial_summary,
			clientTotal: 99.8,
		},
	});
	assert.equal(
		directHotelRunnerEmailCommercialGuard({
			...base,
			normalized: ambiguousNormalized,
			evidence: ambiguousEvidence,
			existing: ambiguousExisting,
		}).reason,
		"hotelrunner_amount_ambiguous"
	);
	const unmatchedHotelRunnerTotal = directHotelRunnerEmailCommercialGuard({
			...base,
			existing: makeDirectHotelRunnerCommercialReservation({
				total_amount: 101,
				adminPricing: {
					...existing.adminPricing,
					clientTotal: 101,
				},
				ota_financial_summary: {
					...existing.ota_financial_summary,
					clientTotal: 101,
				},
			}),
		});
	assert.equal(unmatchedHotelRunnerTotal.reason, "hotelrunner_amount");
	assert.equal(
		directHotelRunnerEmailCommercialGuard({
			...base,
			existing: makeDirectHotelRunnerCommercialReservation({
				adminChangeLog: [{ field: "sub_total", by: { name: "Admin" } }],
			}),
		}).reason,
		"protected_state"
	);
	assert.equal(
		directHotelRunnerEmailCommercialGuard({
			...base,
			normalized: makeVerifiedHotelRunnerCommercialEmail({
				checkinDate: "2026-09-11",
			}),
		}).reason,
		"stay"
	);
	assert.equal(
		directHotelRunnerEmailCommercialGuard({
			...base,
			existing: makeDirectHotelRunnerCommercialReservation({
				supplierData: {
					...existing.supplierData,
					otaProvider: "agoda",
				},
			}),
		}).reason,
		"identity"
	);
	assert.equal(
		directHotelRunnerEmailCommercialGuard({
			...base,
			normalized: makeVerifiedHotelRunnerCommercialEmail({
				roomName: "Wrong Room",
			}),
		}).reason,
		"room_identity"
	);
	assert.equal(
		directHotelRunnerEmailCommercialGuard({
			...base,
			hotelDetails: {
				...hotelRunnerCommercialHotel(),
				roomCountDetails: [
					...hotelRunnerCommercialHotel().roomCountDetails,
					{
						_id: HOTELRUNNER_COMMERCIAL_ROOM_ID,
						roomType: "doubleRooms",
						displayName: "Double Room",
						activeRoom: true,
					},
				],
			},
		}).reason,
		"room_identity",
		"the projected PMS room id must select exactly one active configuration"
	);
	const missingHotelRunnerSummaryTotal = directHotelRunnerEmailCommercialGuard({
			...base,
			existing: makeDirectHotelRunnerCommercialReservation({
				ota_financial_summary: {
					...existing.ota_financial_summary,
					clientTotal: 0,
				},
			}),
		});
	assert.equal(missingHotelRunnerSummaryTotal.reason, "hotelrunner_amount");
	assert.equal(
		directHotelRunnerEmailCommercialGuard({
			...base,
			existing: makeDirectHotelRunnerCommercialReservation({
				state: "cancelled",
				reservation_status: "cancelled",
			}),
		}).reason,
		"protected_state",
		"a late original email must not attach pre-cancellation payout to a terminal stay"
	);
	assert.equal(
		directHotelRunnerEmailCommercialGuard({
			...base,
			existing: makeDirectHotelRunnerCommercialReservation({
				roomId: ["64b0000000000000000000aa"],
			}),
		}).reason,
		"protected_state",
		"a physically assigned stay is protected even before an in-house status update"
	);
	for (const paymentDrift of [
		{ payment: "cash" },
		{ financeStatus: "finance hold" },
	]) {
		assert.equal(
			directHotelRunnerEmailCommercialGuard({
				...base,
				existing: makeDirectHotelRunnerCommercialReservation(paymentDrift),
			}).reason,
			"protected_state",
			"local top-level payment and finance drift must block enrichment"
		);
	}
	assert.equal(
		buildHotelRunnerEmailCommercialEvidence(
			makeVerifiedHotelRunnerCommercialEmail({
				otaPayoutFallbackReason: "estimated_default_deduction",
				paymentSummary: {
					sourceTotalPayoutAmount: null,
				},
			})
		),
		null,
		"fallback or estimated payout evidence must never be stamped"
	);
	const foreignCurrency = makeVerifiedHotelRunnerCommercialEmail({
		amount: 100,
		totalAmountSar: 375,
		sourceAmount: 100,
		sourceCurrency: "USD",
		currency: "USD",
		totalPayoutSar: 300,
		netAfterExpensesTotal: 300,
		exchangeRateToSar: 3.75,
		sourceExchangeRateToSar: 3.75,
		sourceExchangeRateSource: "fallback_default",
		exchangeRateSource: "fallback_default",
		paymentSummary: {
			sourceCurrency: "USD",
			sourceTotalGuestPaymentAmount: 100,
			sourceTotalPayoutAmount: 80,
			totalGuestPaymentAmount: 375,
			totalPayoutAmount: 300,
			currency: "SAR",
			exchangeRateToSar: 3.75,
			exchangeRateSource: "fallback_default",
		},
	});
	assert.equal(
		buildHotelRunnerEmailCommercialEvidence(foreignCurrency),
		null,
		"default FX estimates must never become verified payout evidence"
	);
	assert.equal(
		buildHotelRunnerEmailCommercialEvidence({
			...foreignCurrency,
			sourceExchangeRateSource: "exchange_rate_api",
			exchangeRateSource: "exchange_rate_api",
			currencyConversionEvidence: {
				trusted: true,
				verified: true,
				sourceCurrency: "USD",
				propertyCurrency: "SAR",
				rate: 3.75,
				provenance: {
					provider: "jannat_fx",
					sourceType: "trusted_exchange_evidence",
					sourceHash: immutableFixtureTextHash(
						"authenticated FX audit",
						"USD",
						"SAR",
						3.75,
						"2026-08-06T14:59:00.000Z"
					),
					sourceTimestamp: "2026-08-06T14:59:00.000Z",
					sourceId: "fx-audit-usd-sar-20260806",
				},
			},
			paymentSummary: {
				...foreignCurrency.paymentSummary,
				exchangeRateSource: "exchange_rate_api",
			},
		}),
		null,
		"a source string and structurally plausible but non-canonical FX object must not establish trusted conversion evidence"
	);
});

test("production-shaped Agoda API placeholder enriches in place once and never creates a duplicate", async () => {
	const originalReservationFind = Reservations.find;
	const originalReservationUpdateOne = Reservations.updateOne;
	const originalReservationCreate = Reservations.create;
	const originalHotelFind = HotelDetails.find;
	const confirmationNumber = "2040450395";
	const base = makeDirectHotelRunnerCommercialReservation();
	const unresolvedApiEvidence = buildHotelRunnerUnresolvedCommercialEvidence({
		provider: "agoda",
		sourceType: "hotelrunner_webhook",
		reportedAmount: 53.97,
		reportedCurrency: "SAR",
		propertyCurrency: "SAR",
		sourceHash: "b".repeat(64),
		sourceTimestamp: "2026-08-11T17:58:22.000Z",
		sourceId: "hotelrunner-event-2040450395",
	});
	const sourceRoomName =
		"Deluxe Family Room 2 - Non-Refundable - 2 Occupancy - NR";
	const roomRow = {
		...base.pickedRoomsPricing[0],
		sourceRoomName,
		pricingByDay: [
			{
				date: "2026-08-14",
				price: null,
				clientPrice: null,
				mainPrice: null,
				rootPrice: 75,
				totalPriceWithCommission: null,
				totalPriceWithoutCommission: 75,
				netAfterExpenses: null,
				netAfterOtaExpenses: null,
				otaExpenseAmount: null,
				platformMargin: null,
				hotelRunnerSourcePrice: 53.97,
			},
		],
	};
	let current = makeDirectHotelRunnerCommercialReservation({
		_id: "agoda-api-placeholder-2040450395",
		reservation_id: confirmationNumber,
		otaIdentityKey: `agoda:${confirmationNumber}`,
		booking_source: "Agoda",
		customer_details: {
			...base.customer_details,
			confirmation_number2: confirmationNumber,
			booking_source: "Agoda",
		},
		state: "OTA Platform Review",
		reservation_status: "OTA Platform Review",
		checkin_date: "2026-08-14",
		checkout_date: "2026-08-15",
		total_amount: null,
		sub_total: 75,
		pickedRoomsType: [roomRow],
		pickedRoomsPricing: [structuredClone(roomRow)],
		adminPricing: {
			...base.adminPricing,
			clientTotal: null,
			rootTotal: 75,
			sourceAmount: 53.97,
			sourceCurrency: "SAR",
			propertyCurrency: "SAR",
			hotelRunnerAmountRole: "unknown",
			payoutFallbackReason: "hotelrunner_payout_not_provided",
		},
		adminPricingVisibility: {
			rootOnlyForHotelManagement: true,
			source: "hotelrunner_api",
			appliedAt: new Date("2026-08-11T17:58:27.000Z"),
			appliedBy: null,
		},
		ota_financial_summary: {
			...base.ota_financial_summary,
			show: false,
			clientTotal: null,
			hotelVisibleAmount: 75,
			sourceAmount: 53.97,
			sourceCurrency: "SAR",
			propertyCurrency: "SAR",
			hotelRunnerAmountRole: "unknown",
			payoutFallbackReason: "hotelrunner_payout_not_provided",
		},
		otaPlatformReview: {
			status: "pending",
			source: "hotelrunner_api",
			inboundEmailId: "",
			provider: "agoda",
			providerLabel: "Agoda",
			confirmationNumber,
			createdAt: new Date("2026-08-11T17:58:27.000Z"),
			releasedAt: null,
			releasedBy: null,
			priceAtRelease: null,
			hotelRunnerManaged: true,
			hotelRunnerLinkedAt: new Date("2026-08-11T17:58:27.000Z"),
			lastHotelRunnerUpdatedAt: new Date("2026-08-11T17:58:27.000Z"),
			hotelAssignmentRequired: false,
			hotelAssignmentStatus: "assigned",
			assignedHotelId: HOTELRUNNER_COMMERCIAL_HOTEL_ID,
			assignedHotelName: "Zad Ajyad",
			assignedAt: new Date("2026-08-11T17:58:27.000Z"),
			roomMappingStatus: "mapped",
			roomMappingHotelId: HOTELRUNNER_COMMERCIAL_HOTEL_ID,
			lastUpdatedAt: new Date("2026-08-11T17:58:27.000Z"),
		},
		supplierData: {
			...base.supplierData,
			supplierName: "Agoda",
			suppliedBookingNo: confirmationNumber,
			otaConfirmationNumber: confirmationNumber,
			platformConfirmationNumber: confirmationNumber,
			otaProvider: "agoda",
			otaCommercialEvidence: unresolvedApiEvidence,
			hotelRunner: {
				...base.supplierData.hotelRunner,
				pricing: { currency: "SAR", grandTotal: 53.97 },
			},
		},
	});
	const normalized = makeVerifiedHotelRunnerCommercialEmail({
		inboundEmailId: "agoda-direct-2040450395",
		provider: "agoda",
		providerLabel: "Agoda",
		bookingSource: "Agoda",
		confirmationNumber,
		reservationId: confirmationNumber,
		roomName: "Deluxe Family Room 2",
		checkinDate: "2026-08-14",
		checkoutDate: "2026-08-15",
		amount: 87.22,
		totalAmountSar: 87.22,
		sourceAmount: 87.22,
		totalPayoutSar: 53.97,
		netAfterExpensesTotal: 53.97,
		paymentSummary: {
			sourceCurrency: "SAR",
			sourceTotalGuestPaymentAmount: 87.22,
			sourceTotalPayoutAmount: 53.97,
			totalGuestPaymentAmount: 87.22,
			totalPayoutAmount: 53.97,
			currency: "SAR",
			exchangeRateToSar: 1,
		},
		source: {
			receivedAt: "2026-08-11T17:57:03.000Z",
			messageId: "agoda-direct-2040450395@agoda.com",
		},
	});
	const hotel = hotelRunnerCommercialHotel();
	hotel.roomCountDetails[0] = {
		...hotel.roomCountDetails[0],
		defaultCost: 75,
		pricingRate: [{ calendarDate: "2026-08-14", rootPrice: 75 }],
	};
	const staleLegacySurfaces = structuredClone(current);
	staleLegacySurfaces.total_amount = 87.22;
	staleLegacySurfaces.adminPricing.clientTotal = 87.22;
	staleLegacySurfaces.ota_financial_summary.clientTotal = 87.22;
	staleLegacySurfaces.supplierData.hotelRunner.pricing.grandTotal = 54.48;
	const directEvidence = buildHotelRunnerEmailCommercialEvidence(normalized, {
		appliedAt: new Date("2026-08-11T18:00:03.000Z"),
	});
	assert.ok(directEvidence);
	assert.equal(
		directHotelRunnerEmailCommercialGuard({
			normalized,
			existing: staleLegacySurfaces,
			hotelDetails: hotel,
			matchedReservationBy: ["otaIdentityKey"],
			evidence: directEvidence,
		}).reason,
		"hotelrunner_amount",
		"stale 87.22 client surfaces must never outrank a mismatched HotelRunner API tuple"
	);
	let writes = 0;
	let createCalls = 0;
	let writtenUpdate = null;
	Reservations.find = () => ({
		limit() {
			return this;
		},
		async exec() {
			return [current];
		},
	});
	Reservations.updateOne = async (_filter, update) => {
		writes += 1;
		writtenUpdate = update;
		current = applyDottedCommercialSet(current, update.$set);
		current.__v += 1;
		return { matchedCount: 1 };
	};
	Reservations.create = async () => {
		createCalls += 1;
		assert.fail("the direct email must never create beside an API reservation");
	};
	HotelDetails.find = () => ({
		select() {
			return this;
		},
		async lean() {
			return [hotel];
		},
	});

	try {
		const first = await reconcileOtaReservation(normalized);
		assert.equal(first.status, "updated", JSON.stringify(first));
		assert.equal(first.actionTaken, "commercial_enrichment");
		assert.equal(first.reservationId, current._id);
		assert.equal(createCalls, 0);
		assert.equal(writes, 1);
		assert.equal(writtenUpdate.$set.total_amount, 87.22);
		assert.equal(writtenUpdate.$set["adminPricing.clientTotal"], 87.22);
		assert.equal(
			writtenUpdate.$set["adminPricing.netAfterExpensesTotal"],
			53.97
		);
		assert.equal(writtenUpdate.$set["adminPricing.otaExpenseTotal"], 33.25);
		assert.equal(current.supplierData.otaSourceAuthority, 4);
		assert.equal(
			current.supplierData.hotelRunner.pricing.grandTotal,
			53.97,
			"commercial enrichment must preserve the raw HotelRunner API amount"
		);
		for (const protectedPath of [
			"reservation_id",
			"otaIdentityKey",
			"hotelId",
			"supplierData.hotelRunner.reservationId",
		]) {
			assert.equal(
				Object.prototype.hasOwnProperty.call(writtenUpdate.$set, protectedPath),
				false,
				`${protectedPath} must remain API-owned`
			);
		}

		const second = await reconcileOtaReservation(normalized);
		assert.equal(second.status, "duplicate_reservation", JSON.stringify(second));
		assert.equal(second.actionTaken, "skipped");
		assert.equal(
			second.skipReason,
			"hotelrunner_email_commercial_evidence_already_applied"
		);
		assert.equal(createCalls, 0);
		assert.equal(writes, 1, "an identical retry must not write twice");
	} finally {
		Reservations.find = originalReservationFind;
		Reservations.updateOne = originalReservationUpdateOne;
		Reservations.create = originalReservationCreate;
		HotelDetails.find = originalHotelFind;
	}
});

test("direct-owned stay mismatch and protected state block writes while partial evidence attaches provenance only", async () => {
	const originalReservationFind = Reservations.find;
	const originalReservationUpdateOne = Reservations.updateOne;
	const originalHotelFind = HotelDetails.find;
	let existing = makeDirectHotelRunnerCommercialReservation();
	let writes = 0;
	let writtenUpdate = null;
	Reservations.find = () => ({
		limit() {
			return this;
		},
		async exec() {
			return [existing];
		},
	});
	Reservations.updateOne = async (_filter, update) => {
		writes += 1;
		writtenUpdate = update;
		return { matchedCount: 1 };
	};
	HotelDetails.find = () => ({
		select() {
			return this;
		},
		async lean() {
			return [hotelRunnerCommercialHotel()];
		},
	});

	try {
		const stayMismatch = await reconcileOtaReservation(
			makeVerifiedHotelRunnerCommercialEmail({
				checkinDate: "2026-09-11",
			})
		);
		assert.equal(stayMismatch.status, "needs_review");
		assert.equal(
			stayMismatch.skipReason,
			"hotelrunner_email_commercial_enrichment_guard_failed"
		);
		assert.match(stayMismatch.errors.join(" "), /stay/);
		assert.equal(writes, 0);

		existing = makeDirectHotelRunnerCommercialReservation({
			adminChangeLog: [{ field: "sub_total", by: { name: "Admin" } }],
		});
		const protectedResult = await reconcileOtaReservation(
			makeVerifiedHotelRunnerCommercialEmail()
		);
		assert.equal(protectedResult.status, "needs_review");
		assert.match(protectedResult.errors.join(" "), /protected_state/);
		assert.equal(writes, 0);

		existing = makeDirectHotelRunnerCommercialReservation();
		const incomplete = await reconcileOtaReservation(
			makeVerifiedHotelRunnerCommercialEmail({
				totalPayoutSar: null,
				netAfterExpensesTotal: null,
				paymentSummary: {
					sourceTotalPayoutAmount: null,
					totalPayoutAmount: null,
				},
			})
		);
		assert.equal(incomplete.status, "updated");
		assert.equal(incomplete.actionTaken, "commercial_evidence_attached");
		assert.equal(writes, 1);
		assert.deepEqual(
			Object.keys(writtenUpdate.$set),
			["supplierData.otaCommercialEvidence"]
		);
		const partialEvidence =
			writtenUpdate.$set["supplierData.otaCommercialEvidence"];
		assert.equal(validateOtaCommercialEvidence(partialEvidence).ok, true);
		assert.equal(partialEvidence.verificationState, "partial");
		assert.equal(partialEvidence.roles.guestGross.propertyAmount, 100);
		assert.equal(partialEvidence.roles.hotelPayout.verified, false);
		assert.equal(partialEvidence.roles.hotelPayout.propertyAmount, null);
	} finally {
		Reservations.find = originalReservationFind;
		Reservations.updateOne = originalReservationUpdateOne;
		HotelDetails.find = originalHotelFind;
	}
});

test("concurrent duplicate commercial emails produce one enrichment write", async () => {
	const originalReservationFind = Reservations.find;
	const originalReservationFindById = Reservations.findById;
	const originalReservationUpdateOne = Reservations.updateOne;
	const originalHotelFind = HotelDetails.find;
	const existing = makeDirectHotelRunnerCommercialReservation();
	let latest = existing;
	let updateCalls = 0;
	Reservations.find = () => ({
		limit() {
			return this;
		},
		async exec() {
			return [existing];
		},
	});
	Reservations.updateOne = async (_filter, update) => {
		updateCalls += 1;
		if (updateCalls === 1) {
			latest = applyDottedCommercialSet(existing, update.$set);
			latest.__v = existing.__v + 1;
			return { matchedCount: 1 };
		}
		return { matchedCount: 0 };
	};
	Reservations.findById = () => ({
		lean() {
			return this;
		},
		async exec() {
			return latest;
		},
	});
	HotelDetails.find = () => ({
		select() {
			return this;
		},
		async lean() {
			return [hotelRunnerCommercialHotel()];
		},
	});

	try {
		const [first, second] = await Promise.all([
			reconcileOtaReservation(makeVerifiedHotelRunnerCommercialEmail()),
			reconcileOtaReservation(makeVerifiedHotelRunnerCommercialEmail()),
		]);
		assert.deepEqual(
			[first.status, second.status],
			["updated", "duplicate_reservation"]
		);
		assert.equal(second.actionTaken, "skipped");
		assert.equal(
			second.skipReason,
			"hotelrunner_email_commercial_evidence_already_applied"
		);
		assert.equal(updateCalls, 2);
	} finally {
		Reservations.find = originalReservationFind;
		Reservations.findById = originalReservationFindById;
		Reservations.updateOne = originalReservationUpdateOne;
		HotelDetails.find = originalHotelFind;
	}
});

test("HotelRunner OTA-collect enrichment loses its snapshot CAS to concurrent finance or release changes", async () => {
	const originalReservationFindById = Reservations.findById;
	const originalReservationUpdateOne = Reservations.updateOne;
	const normalized = makeVerifiedHotelRunnerCommercialEmail({
		provider: "agoda",
		providerLabel: "Agoda",
		bookingSource: "Agoda",
	});
	const base = makeDirectHotelRunnerCommercialReservation();
	const existing = makeDirectHotelRunnerCommercialReservation({
		otaIdentityKey: `agoda:${HOTELRUNNER_COMMERCIAL_CONFIRMATION}`,
		booking_source: "Agoda",
		customer_details: {
			...base.customer_details,
			booking_source: "Agoda",
		},
		supplierData: {
			...base.supplierData,
			supplierName: "Agoda",
			otaProvider: "agoda",
		},
	});
	const evidence = buildHotelRunnerEmailCommercialEvidence(normalized, {
		appliedAt: new Date("2026-08-06T15:01:00.000Z"),
	});
	assert.ok(evidence);
	const scenarios = [
		{
			label: "finance",
			latest: { ...existing, financeStatus: "finance hold" },
			assertSnapshot(filter) {
				assert.equal(filter.financeStatus, "not paid");
				assert.notEqual(filter.financeStatus, this.latest.financeStatus);
			},
		},
		{
			label: "release",
			latest: {
				...existing,
				state: "Pending Confirmation",
				reservation_status: "Pending Confirmation",
			},
			assertSnapshot(filter) {
				assert.equal(filter.state, "confirmed");
				assert.notEqual(filter.state, this.latest.state);
			},
		},
	];
	try {
		for (const scenario of scenarios) {
			let updateCalls = 0;
			Reservations.updateOne = async (filter, update) => {
				updateCalls += 1;
				scenario.assertSnapshot(filter);
				assert.equal(update.$set.payment, "paid online");
				assert.equal(update.$set.paid_amount, 100);
				return { matchedCount: 0 };
			};
			Reservations.findById = () => ({
				lean() {
					return this;
				},
				async exec() {
					return scenario.latest;
				},
			});
			const result = await reconcileDirectHotelRunnerOwnedEmail({
				normalized,
				existing,
				hotelDetails: hotelRunnerCommercialHotel(),
				matchedReservationBy: ["otaIdentityKey"],
				warnings: [],
				errors: [],
			});
			assert.equal(result.status, "needs_review", scenario.label);
			assert.equal(
				result.skipReason,
				"hotelrunner_email_commercial_enrichment_concurrent_change",
				scenario.label
			);
			assert.equal(updateCalls, 1, scenario.label);
		}
	} finally {
		Reservations.findById = originalReservationFindById;
		Reservations.updateOne = originalReservationUpdateOne;
	}
});

test("a bounded authenticated direct-after-relay skew is eligible only with exact source-backed stay and identity evidence", () => {
	const existing = {
		checkin_date: "2026-08-26",
		checkout_date: "2026-08-28",
		supplierData: {
			otaSourceAuthority: 1,
			otaLastEventType: "new",
			otaLastSourceReceivedAt: "2026-08-05T10:52:57.000Z",
		},
	};
	const normalized = {
		inboundEmailId: "direct-agoda-audit",
		provider: "agoda",
		intent: "new_reservation",
		eventType: "new",
		confirmationNumber: "2038722839",
		hotelName: "Zad Ajyad",
		roomName: "Six-Bed Family Room",
		checkinDate: "2026-08-26",
		checkoutDate: "2026-08-28",
		amount: 182.28,
		sourceSenderTrusted: true,
		sourceSenderAuthenticated: true,
		trustedTransportProvider: "agoda",
		sourcePresence: {
			confirmationNumber: true,
			hotelName: true,
			roomName: true,
			checkinDate: true,
			checkoutDate: true,
			amount: true,
		},
		source: {
			from: "Agoda <no-reply@agoda.com>",
			messageId: "direct-agoda-message",
			receivedAt: "2026-08-05T10:45:44.000Z",
			textHash: immutableFixtureTextHash(
				"Agoda authenticated direct-after-relay confirmation",
				"direct-agoda-message",
				"2038722839",
				182.28
			),
		},
	};
	const eligible = (input = normalized, stored = existing, matched = ["a", "b"]) =>
		canUseDirectAfterRelaySourceSkew({
			normalized: input,
			existing: stored,
			orderingConflict: "stale_or_equal_timestamp",
			incomingAuthority: 3,
			existingAuthority: 1,
			matchedReservationBy: matched,
		});

	assert.equal(eligible(), true);
	assert.equal(
		eligible({
			...normalized,
			source: {
				...normalized.source,
				receivedAt: "2026-08-05T10:37:56.999Z",
			},
		}),
		false,
		"more than 15 minutes of source skew remains stale"
	);
	assert.equal(
		eligible({ ...normalized, sourceSenderAuthenticated: false }),
		false
	);
	assert.equal(
		eligible({ ...normalized, eventType: "modified" }),
		false
	);
	assert.equal(
		eligible({ ...normalized, checkinDate: "2026-08-27" }),
		false
	);
	assert.equal(eligible(normalized, existing, ["only-one-field"]), false);
	assert.equal(
		canUseDirectAfterRelaySourceSkew({
			normalized,
			existing,
			orderingConflict: "missing_incoming_timestamp",
			incomingAuthority: 3,
			existingAuthority: 1,
			matchedReservationBy: ["a", "b"],
		}),
		false
	);
});

test("direct-after-relay pricing refresh requires the exact existing hotel and ordered PMS room configuration", () => {
	const existing = {
		hotelId: "hotel-zad",
		total_rooms: 1,
		pickedRoomsType: [{ hotelRoomConfigId: "room-family-six" }],
	};
	const exact = {
		hotelId: "hotel-zad",
		total_rooms: 1,
		pickedRoomsType: [{ hotelRoomConfigId: "room-family-six" }],
	};
	assert.equal(directAfterRelayInventoryConflict(existing, exact), false);
	assert.equal(
		directAfterRelayInventoryConflict(existing, {
			...exact,
			hotelId: "hotel-other",
		}),
		true
	);
	assert.equal(
		directAfterRelayInventoryConflict(existing, {
			...exact,
			pickedRoomsType: [{ hotelRoomConfigId: "room-quad" }],
		}),
		true
	);
	assert.equal(
		directAfterRelayInventoryConflict(existing, {
			...exact,
			pickedRoomsType: [{ displayName: "Unmapped room" }],
		}),
		true
	);
});

test("an authenticated direct confirmation refreshes the complete pending pricing bundle across a bounded relay delay", async () => {
	const originalReservationFind = Reservations.find;
	const originalReservationUpdateOne = Reservations.updateOne;
	const originalHotelFind = HotelDetails.find;
	const confirmationNumber = "2038722839";
	const existingRoom = {
		hotelRoomConfigId: "room-family-six",
		room_type: "familyRooms",
		displayName: "Family Room for Six",
		sourceRoomName: "Family Room for Six",
		otaRoomMatchType: "explicit_room_semantic",
		otaRoomMatchScore: 0.98,
		chosenPrice: 56.39,
		count: 1,
		pricingByDay: ["2026-08-26", "2026-08-27"].map((date) => ({
			date,
			price: 56.39,
			clientPrice: 56.39,
			mainPrice: 56.39,
			rootPrice: 51,
			commissionRate: 0,
			totalPriceWithCommission: 56.39,
			totalPriceWithoutCommission: 51,
			netAfterExpenses: 45.11,
			netAfterOtaExpenses: 45.11,
			otaExpenseAmount: 11.28,
			platformMargin: -5.89,
		})),
		totalPriceWithCommission: 112.78,
		hotelShouldGet: 102,
	};
	let existing = {
		_id: "existing-relayed-agoda",
		__v: 2,
		updatedAt: new Date("2026-08-05T11:55:00.000Z"),
		hotelId: "hotel-zad",
		belongsTo: "owner-zad",
		confirmation_number: "8982408795",
		otaIdentityKey: `agoda:${confirmationNumber}`,
		reservation_id: confirmationNumber,
		booking_source: "Agoda",
		customer_details: {
			confirmation_number2: confirmationNumber,
			booking_source: "Agoda",
			name: "Source Guest",
		},
		checkin_date: "2026-08-26",
		checkout_date: "2026-08-28",
		total_rooms: 1,
		total_guests: 6,
		adults: 6,
		children: 0,
		sub_total: 102,
		commission: 0,
		total_amount: 112.78,
		financeStatus: "paid online",
		payment: "paid online",
		paid_amount: 112.78,
		payment_details: { captured: false, onsite_paid_amount: 0 },
		paid_amount_breakdown: {
			paid_online_via_link: 0,
			paid_at_hotel_cash: 0,
			paid_at_hotel_card: 0,
			paid_to_hotel: 0,
			paid_online_jannatbooking: 0,
			paid_online_other_platforms: 112.78,
			paid_online_via_instapay: 0,
			paid_no_show: 0,
			payment_comments: "Agoda collected by platform",
		},
		pickedRoomsType: [JSON.parse(JSON.stringify(existingRoom))],
		pickedRoomsPricing: [JSON.parse(JSON.stringify(existingRoom))],
		adminPricing: {
			mode: "ota_platform_sync",
			clientTotal: 112.78,
			rootTotal: 102,
			netAfterExpensesTotal: 90.22,
			otaExpenseTotal: 22.56,
			platformMarginTotal: -11.78,
			commissionAmount: 0,
			defaultDeductionRate: 0.2,
			defaultDeductionApplied: true,
			source: "ota_email_create",
			provider: "agoda",
			providerLabel: "Agoda",
		},
		adminPricingVisibility: {
			rootOnlyForHotelManagement: true,
			source: "ota_email_create",
			appliedAt: new Date("2026-08-05T10:53:00.000Z"),
			appliedBy: null,
		},
		financial_cycle: {
			collectionModel: "pms_collected",
			status: "open",
			commissionType: "amount",
			commissionValue: 0,
			commissionAmount: 0,
			commissionAssigned: false,
			commissionAssignedAt: null,
			commissionAssignedBy: null,
			pmsCollectedAmount: 112.78,
			hotelCollectedAmount: 0,
			hotelPayoutDue: 102,
			commissionDueToPms: 0,
		},
		supplierData: {
			otaProvider: "agoda",
			supplierName: "Agoda",
			suppliedBookingNo: confirmationNumber,
			otaConfirmationNumber: confirmationNumber,
			platformConfirmationNumber: confirmationNumber,
			otaSourceAuthority: 1,
			otaPaymentCollectionModel: "ota_collect",
			otaLastEventType: "new",
			otaLastSourceReceivedAt: "2026-08-05T10:52:57.000Z",
		},
		otaPlatformReview: {
			status: "pending",
			provider: "agoda",
			confirmationNumber,
		},
		state: "OTA Platform Review",
		reservation_status: "OTA Platform Review",
	};
	const hotel = {
		_id: "hotel-zad",
		belongsTo: "owner-zad",
		hotelName: "Zad Ajyad",
		activateHotel: true,
		xHotelProActive: true,
		roomCountDetails: [
			{
				_id: "room-family-six",
				roomType: "familyRooms",
				displayName: "Family Room for Six",
				activeRoom: true,
				price: { basePrice: 51 },
			},
		],
	};
	let capturedUpdate = null;
	Reservations.find = () => ({
		limit() {
			return this;
		},
		select() {
			return this;
		},
		async exec() {
			return [existing];
		},
	});
	Reservations.updateOne = async (filter, update) => {
		capturedUpdate = { filter, update };
		return { matchedCount: 1 };
	};
	HotelDetails.find = () => ({
		select() {
			return this;
		},
		async lean() {
			return [hotel];
		},
	});

	try {
		const normalizedDirectPricing = {
			inboundEmailId: "direct-agoda-pricing-audit",
			provider: "agoda",
			providerLabel: "Agoda",
			bookingSource: "Agoda",
			confirmationNumber,
			reservationId: confirmationNumber,
			intent: "new_reservation",
			eventType: "new",
			guestName: "Source Guest",
			hotelName: "Zad Ajyad",
			roomName: "Family Room for Six",
			checkinDate: "2026-08-26",
			checkoutDate: "2026-08-28",
			amount: 182.28,
			totalAmountSar: 182.28,
			currency: "SAR",
			sourceAmount: 182.28,
			sourceCurrency: "SAR",
			sourceExchangeRateToSar: 1,
			sourceExchangeRateSource: "identity",
			exchangeRateToSar: 1,
			exchangeRateSource: "identity",
			totalPayoutSar: 112.78,
			netAfterExpensesTotal: 112.78,
			paymentCollectionModel: "ota_collect",
			paymentInstructions:
				"Agoda prepaid reservation; net rate is provided by Agoda.",
			paymentSummary: {
				sourceCurrency: "SAR",
				sourceTotalGuestPaymentAmount: 182.28,
				sourceTotalPayoutAmount: 112.78,
				totalGuestPaymentAmount: 182.28,
				totalPayoutAmount: 112.78,
				currency: "SAR",
				exchangeRateToSar: 1,
				exchangeRateSource: "identity",
			},
			roomCount: 1,
			totalGuests: 6,
			adults: 6,
			children: 0,
			sourceSenderTrusted: true,
			sourceSenderAuthenticated: true,
			trustedTransportProvider: "agoda",
			sourcePresence: {
				confirmationNumber: true,
				reservationId: true,
				bookingSource: true,
				guestName: true,
				hotelName: true,
				roomName: true,
				checkinDate: true,
				checkoutDate: true,
				amount: true,
				paymentCollectionModel: true,
				paymentInstructions: true,
				roomCount: true,
				totalGuests: true,
				adults: true,
				children: true,
			},
			source: {
				from: "Agoda <no-reply@agoda.com>",
				messageId: "direct-agoda-pricing-message",
				receivedAt: "2026-08-05T10:45:44.000Z",
				timestampMethod: "rfc2822_date_header",
				textHash: immutableFixtureTextHash(
					"Agoda authenticated direct commercial confirmation",
					"direct-agoda-pricing-message",
					confirmationNumber,
					182.28,
					112.78
				),
			},
		};
		const result = await reconcileOtaReservation(normalizedDirectPricing);
		assert.equal(result.status, "updated");
		assert.equal(result.reservationId, existing._id);
		assert.ok(capturedUpdate);
		assert.equal(capturedUpdate.filter._id, existing._id);
		assert.equal(capturedUpdate.filter.__v, existing.__v);
		assert.equal(capturedUpdate.update.$set.total_amount, 182.28);
		assert.equal(capturedUpdate.update.$set.paid_amount, 182.28);
		assert.equal(capturedUpdate.update.$set.adminPricing.clientTotal, 182.28);
		assert.equal(
			capturedUpdate.update.$set.adminPricing.netAfterExpensesTotal,
			112.78
		);
		assert.equal(
			capturedUpdate.update.$set.ota_financial_summary.clientTotal,
			182.28
		);
		assert.equal(
			capturedUpdate.update.$set.ota_financial_summary.netAfterExpenses,
			112.78
		);
		assert.equal(
			capturedUpdate.update.$set["supplierData.otaSourceAuthority"],
			3
		);
		assert.equal(
			capturedUpdate.update.$set["supplierData.otaLastSourceReceivedAt"],
			undefined,
			"the later relay watermark must not move backward"
		);
		assert.match(
			result.warnings.join(" "),
			/direct OTA confirmation preceded.*HotelRunner relay/i
		);

		const clone = (value) => JSON.parse(JSON.stringify(value));
		const resolvedExisting = clone(existing);
		const unresolvedExisting = clone(resolvedExisting);
		unresolvedExisting.total_amount = null;
		unresolvedExisting.payment = "ota collect - amount unavailable";
		unresolvedExisting.financeStatus = "commercial review required";
		unresolvedExisting.paid_amount = null;
		unresolvedExisting.payment_details = {
			captured: false,
			onsite_paid_amount: 0,
		};
		unresolvedExisting.paid_amount_breakdown = {
			paid_online_via_link: 0,
			paid_at_hotel_cash: 0,
			paid_at_hotel_card: 0,
			paid_to_hotel: 0,
			paid_online_jannatbooking: 0,
			paid_online_other_platforms: null,
			paid_online_via_instapay: 0,
			paid_no_show: 0,
			payment_comments:
				"Agoda collection model reported; property-currency amount unavailable",
		};
		unresolvedExisting.financial_cycle = {
			collectionModel: "provider_collected_unresolved",
			status: "review_required",
			commissionType: "amount",
			commissionValue: 0,
			commissionAmount: 0,
			commissionAssigned: false,
			pmsCollectedAmount: null,
			hotelCollectedAmount: 0,
			hotelPayoutDue: null,
			commissionDueToPms: 0,
			lastUpdatedAt: "2026-08-05T10:53:00.000Z",
		};
		unresolvedExisting.adminPricing.clientTotal = null;
		unresolvedExisting.adminPricing.netAfterExpensesTotal = null;
		unresolvedExisting.adminPricing.otaExpenseTotal = null;
		unresolvedExisting.adminPricing.platformMarginTotal = null;
		unresolvedExisting.adminPricing.commercialResolution = "unresolved";
		unresolvedExisting.supplierData.otaPaymentCollectionModel = "ota_collect";

		existing = clone(unresolvedExisting);
		capturedUpdate = null;
		const unresolvedResult = await reconcileOtaReservation(
			clone(normalizedDirectPricing)
		);
		assert.equal(unresolvedResult.status, "updated");
		assert.ok(capturedUpdate, "exact unresolved baseline must reach one CAS update");
		assert.equal(capturedUpdate.update.$set.total_amount, 182.28);
		assert.equal(capturedUpdate.update.$set.paid_amount, 182.28);

		const unresolvedTamperCases = [
			["captured", (reservation) => {
				reservation.payment_details.captured = true;
			}],
			["processor reference", (reservation) => {
				reservation.payment_details.processor_reference = "capture-1";
			}],
			["unknown false payment marker", (reservation) => {
				reservation.payment_details.manual_override = false;
			}],
			["hotel transfer", (reservation) => {
				reservation.moneyTransferredToHotel = true;
			}],
			["payment label", (reservation) => {
				reservation.payment = "paid online";
			}],
			["finance label", (reservation) => {
				reservation.financeStatus = "finance hold";
			}],
			["payment comment", (reservation) => {
				reservation.paid_amount_breakdown.payment_comments =
					"Agoda amount unavailable";
			}],
			["other-platform null changed to zero", (reservation) => {
				reservation.paid_amount_breakdown.paid_online_other_platforms = 0;
			}],
			["cycle status", (reservation) => {
				reservation.financial_cycle.status = "open";
			}],
			["cycle model", (reservation) => {
				reservation.financial_cycle.collectionModel = "pending";
			}],
			["cycle note", (reservation) => {
				reservation.financial_cycle.notes = "Finance reviewed";
			}],
			["cycle assignment", (reservation) => {
				reservation.financial_cycle.commissionAssigned = true;
			}],
			["conflicting declared collection model", (reservation) => {
				reservation.paymentCollectionModel = "hotel_collect";
			}],
			["conflicting provider", (reservation) => {
				reservation.otaPlatformReview.provider = "booking";
			}],
			["null root", (reservation) => {
				reservation.sub_total = null;
			}],
			["null commission", (reservation) => {
				reservation.commission = null;
			}],
		];
		for (const [label, mutate] of unresolvedTamperCases) {
			existing = clone(unresolvedExisting);
			mutate(existing);
			capturedUpdate = null;
			const guarded = await reconcileOtaReservation(
				clone(normalizedDirectPricing)
			);
			assert.equal(guarded.status, "needs_review", label);
			assert.equal(capturedUpdate, null, label);
		}

		const safeExisting = clone(resolvedExisting);
		const failClosedCases = [
			{
				label: "employee cash payment",
				mutateExisting: (reservation) => {
					reservation.payment = "cash";
				},
			},
			{
				label: "employee finance hold",
				mutateExisting: (reservation) => {
					reservation.financeStatus = "finance hold";
				},
			},
			{
				label: "capture reference",
				mutateExisting: (reservation) => {
					reservation.payment_details.finalCaptureTransactionId = "capture-1";
				},
			},
			{
				label: "employee financial-cycle note",
				mutateExisting: (reservation) => {
					reservation.financial_cycle.notes = "Finance reviewed";
				},
			},
			{
				label: "false-valued client override marker",
				mutateExisting: (reservation) => {
					reservation.adminPricing.clientTotalOverrideActive = false;
				},
			},
			{
				label: "visibility actor",
				mutateExisting: (reservation) => {
					reservation.adminPricingVisibility.appliedBy = "employee-1";
				},
			},
			{
				label: "manual room review",
				mutateExisting: (reservation) => {
					reservation.otaPlatformReview.roomMappingStatus = "mapped";
					reservation.otaPlatformReview.roomMappingHotelId = reservation.hotelId;
				},
			},
			{
				label: "manual nested room mapping",
				mutateExisting: (reservation) => {
					reservation.pickedRoomsType[0].otaRoomMatchType = "manual";
				},
			},
			{
				label: "employee supplier assignment",
				mutateExisting: (reservation) => {
					reservation.supplierData.otaAssignedHotelBy = { role: "employee" };
				},
			},
			{
				label: "non-pending operational state",
				mutateExisting: (reservation) => {
					reservation.state = "custom_manual_hold";
					reservation.reservation_status = "custom_manual_hold";
				},
			},
			{
				label: "missing source-backed room count",
				mutateIncoming: (incoming) => {
					incoming.sourcePresence.roomCount = false;
				},
			},
			{
				label: "room-count mismatch",
				mutateIncoming: (incoming) => {
					incoming.roomCount = 2;
				},
			},
			{
				label: "missing payout evidence",
				mutateIncoming: (incoming) => {
					incoming.totalPayoutSar = null;
					incoming.netAfterExpensesTotal = null;
					incoming.paymentSummary.totalPayoutAmount = null;
					incoming.paymentSummary.sourceTotalPayoutAmount = null;
				},
			},
			{
				label: "fallback-derived payout",
				mutateIncoming: (incoming) => {
					incoming.otaPayoutFallbackReason = "default_20_percent_deduction";
					incoming.paymentSummary.sourceTotalPayoutAmount = null;
				},
			},
			{
				label: "fuzzy-only hotel spelling",
				mutateIncoming: (incoming) => {
					incoming.hotelName = "Zad Ajyadd";
				},
			},
		];
		for (const negative of failClosedCases) {
			existing = clone(safeExisting);
			const incoming = clone(normalizedDirectPricing);
			negative.mutateExisting?.(existing);
			negative.mutateIncoming?.(incoming);
			capturedUpdate = null;
			const guardedResult = await reconcileOtaReservation(incoming);
			assert.equal(guardedResult.status, "needs_review", negative.label);
			assert.equal(capturedUpdate, null, negative.label);
		}
	} finally {
		Reservations.find = originalReservationFind;
		Reservations.updateOne = originalReservationUpdateOne;
		HotelDetails.find = originalHotelFind;
	}
});

const ZAD_UNMAPPED_HOTEL = {
	_id: "6a40b6a1a6efe70450536038",
	belongsTo: "68b74714fb50e159d48c714d",
	hotelName: "Zad Ajyad",
	activateHotel: true,
	xHotelProActive: true,
	roomCountDetails: [
		{
			_id: "family-five",
			roomType: "familyRooms",
			displayName: "Family Room for Five",
			activeRoom: true,
			price: { basePrice: 75 },
		},
		{
			_id: "family-six",
			roomType: "familyRooms",
			displayName: "Family Room for Six",
			activeRoom: true,
			price: { basePrice: 75 },
		},
	],
};

const directUnmappedCase = ({
	confirmationNumber,
	pmsConfirmationNumber,
	checkinDate,
	checkoutDate,
	guestTotal,
	payoutTotal,
	relaySourceAt,
	directSourceAt,
}) => {
	const dates = generateDateRange(checkinDate, checkoutDate);
	const relayTotal = payoutTotal;
	const relayPayout = Number((relayTotal * 0.8).toFixed(2));
	const relayClientPerDay = Number((relayTotal / dates.length).toFixed(2));
	const relayNetPerDay = Number((relayPayout / dates.length).toFixed(2));
	const roomName =
		"Deluxe Family Room 2 - Non-Refundable - 4 Occupancy | غرفة عائلة لاربع أفراد";
	const room = {
		room_type: "familyRooms",
		displayName: roomName,
		count: 1,
		chosenPrice: relayClientPerDay,
		hotelShouldGet: 0,
		pricingByDay: dates.map((date) => ({
			date,
			price: relayClientPerDay,
			clientPrice: relayClientPerDay,
			mainPrice: relayClientPerDay,
			rootPrice: 0,
			commissionRate: 0,
			totalPriceWithCommission: relayClientPerDay,
			totalPriceWithoutCommission: 0,
			netAfterExpenses: relayNetPerDay,
			netAfterOtaExpenses: relayNetPerDay,
			otaExpenseAmount: Number(
				(relayClientPerDay - relayNetPerDay).toFixed(2)
			),
			platformMargin: 0,
			platformMarginRate: 0,
		})),
	};
	const existing = {
		_id: `existing-${confirmationNumber}`,
		__v: 0,
		updatedAt: new Date("2026-08-05T12:30:00.000Z"),
		hotelId: ZAD_UNMAPPED_HOTEL._id,
		belongsTo: ZAD_UNMAPPED_HOTEL.belongsTo,
		confirmation_number: pmsConfirmationNumber,
		otaIdentityKey: `agoda:${confirmationNumber}`,
		reservation_id: confirmationNumber,
		booking_source: "Agoda",
		customer_details: {
			confirmation_number2: confirmationNumber,
			booking_source: "Agoda",
			name: "Source Guest",
		},
		checkin_date: checkinDate,
		checkout_date: checkoutDate,
		total_rooms: 1,
		total_guests: 4,
		adults: 4,
		children: 0,
		roomId: [],
		pickedRoomsType: [room],
		pickedRoomsPricing: [JSON.parse(JSON.stringify(room))],
		sub_total: 0,
		commission: 0,
		total_amount: relayTotal,
		financeStatus: "paid online",
		payment: "paid online",
		paid_amount: relayTotal,
		paid_amount_breakdown: {
			paid_online_other_platforms: relayTotal,
			paid_online_via_link: 0,
			paid_at_hotel_cash: 0,
			paid_at_hotel_card: 0,
			paid_to_hotel: 0,
			paid_online_jannatbooking: 0,
			paid_online_via_instapay: 0,
			paid_no_show: 0,
		},
		payment_details: { captured: false, onsite_paid_amount: 0 },
		vcc_payment: {
			charged: false,
			processing: false,
			charge_count: 0,
			attempts_count: 0,
			failed_attempts_count: 0,
			total_captured_usd: 0,
			total_captured_sar: 0,
			attempts: [],
			last_capture: {},
		},
		moneyTransferredToHotel: false,
		commissionPaid: false,
		financial_cycle: {
			collectionModel: "pms_collected",
			status: "open",
			commissionType: "amount",
			commissionValue: 0,
			commissionAmount: 0,
			commissionAssigned: false,
			pmsCollectedAmount: relayTotal,
			hotelCollectedAmount: 0,
			hotelPayoutDue: 0,
			commissionDueToPms: 0,
		},
		adminPricing: {
			mode: "ota_assignment_pending_pricing",
			clientTotal: relayTotal,
			rootTotal: 0,
			netAfterExpensesTotal: relayPayout,
			otaExpenseTotal: Number((relayTotal - relayPayout).toFixed(2)),
			platformMarginTotal: 0,
			commissionAmount: 0,
			pricingReviewRequired: true,
			hotelAssignmentRequired: false,
			assignedHotelId: ZAD_UNMAPPED_HOTEL._id,
		},
		ota_financial_summary: {
			clientTotal: relayTotal,
			hotelVisibleAmount: 0,
			netAfterExpenses: relayPayout,
			netAfterOtaExpenses: relayPayout,
			otaExpenseTotal: Number((relayTotal - relayPayout).toFixed(2)),
			platformProfit: 0,
			commissionAmount: 0,
		},
		supplierData: {
			otaProvider: "agoda",
			supplierName: "Agoda",
			suppliedBookingNo: confirmationNumber,
			otaConfirmationNumber: confirmationNumber,
			platformConfirmationNumber: confirmationNumber,
			pmsConfirmationNumber,
			otaSourceAuthority: 1,
			otaPaymentCollectionModel: "ota_collect",
			otaLastEventType: "new",
			otaLastSourceReceivedAt: relaySourceAt,
			otaHotelMappingRequired: false,
			otaAssignedHotelId: ZAD_UNMAPPED_HOTEL._id,
			otaHotelNameSourceBacked: true,
			otaHotelRoomConfigId: null,
			otaMatchedRoomName: "",
			otaRoomMatchScore: 0,
			otaRoomMatchType: "",
			otaRoomName: roomName,
			otaRoomNameSourceBacked: true,
			otaRoomCount: 1,
			otaRoomCountSourceBacked: true,
			otaTotalGuests: 4,
			otaTotalGuestsSourceBacked: true,
			otaAdults: 4,
			otaChildren: 0,
			otaCheckinDate: checkinDate,
			otaCheckoutDate: checkoutDate,
			otaStayDatesSourceBacked: true,
		},
		otaPlatformReview: {
			status: "pending",
			provider: "agoda",
			providerLabel: "Agoda",
			confirmationNumber,
			releasedAt: null,
			releasedBy: null,
			priceAtRelease: 0,
			hotelAssignmentRequired: false,
			hotelAssignmentStatus: "assigned",
			assignedHotelId: ZAD_UNMAPPED_HOTEL._id,
			roomMappingStatus: "unreviewed",
			roomMappingHotelId: "",
			otaRoomName: roomName,
		},
		state: "OTA Platform Review",
		reservation_status: "OTA Platform Review",
		availabilitySnapshot: { captured: false, rooms: [] },
	};
	const paymentInstructions =
		"Agoda prepaid reservation; net rate is provided by Agoda.";
	const normalized = {
		inboundEmailId: `direct-${confirmationNumber}`,
		provider: "agoda",
		providerLabel: "Agoda",
		bookingSource: "Agoda",
		confirmationNumber,
		reservationId: confirmationNumber,
		intent: "new_reservation",
		eventType: "new",
		guestName: "Source Guest",
		hotelName: "Zyd Agyad",
		roomName: "Deluxe Family Room 2",
		checkinDate,
		checkoutDate,
		amount: guestTotal,
		totalAmountSar: guestTotal,
		currency: "SAR",
		sourceAmount: guestTotal,
		sourceCurrency: "SAR",
		sourceExchangeRateToSar: 1,
		sourceExchangeRateSource: "identity",
		exchangeRateToSar: 1,
		exchangeRateSource: "identity",
		totalPayoutSar: payoutTotal,
		netAfterExpensesTotal: payoutTotal,
		paymentCollectionModel: "ota_collect",
		paymentInstructions,
		paymentSummary: {
			sourceCurrency: "SAR",
			sourceTotalGuestPaymentAmount: guestTotal,
			sourceTotalPayoutAmount: payoutTotal,
			totalGuestPaymentAmount: guestTotal,
			totalPayoutAmount: payoutTotal,
			currency: "SAR",
			exchangeRateToSar: 1,
			exchangeRateSource: "identity",
		},
		roomCount: 1,
		totalGuests: 4,
		adults: 4,
		children: 0,
		sourceSenderTrusted: true,
		sourceSenderAuthenticated: true,
		trustedTransportProvider: "agoda",
		sourcePresence: {
			confirmationNumber: true,
			reservationId: true,
			bookingSource: true,
			guestName: true,
			hotelName: true,
			roomName: true,
			checkinDate: true,
			checkoutDate: true,
			amount: true,
			paymentCollectionModel: true,
			paymentInstructions: true,
			roomCount: true,
			totalGuests: true,
			adults: true,
			children: false,
		},
		source: {
			from: "Agoda <no-reply@agoda.com>",
			messageId: `direct-${confirmationNumber}@agoda.com`,
			receivedAt: directSourceAt,
			timestampMethod: "rfc2822_date_header",
			textHash: immutableFixtureTextHash(
				"Agoda authenticated direct commercial confirmation",
				confirmationNumber,
				directSourceAt,
				guestTotal,
				payoutTotal
			),
		},
	};
	return { existing, normalized };
};

const PRODUCTION_UNMAPPED_DIRECT_CASES = [
	{
		confirmationNumber: "2038703612",
		pmsConfirmationNumber: "1206346061",
		checkinDate: "2026-09-06",
		checkoutDate: "2026-09-13",
		guestTotal: 597.8,
		payoutTotal: 369.93,
		relaySourceAt: "2026-08-05T09:29:50.000Z",
		directSourceAt: "2026-08-05T09:28:23.000Z",
	},
	{
		confirmationNumber: "2038704202",
		pmsConfirmationNumber: "8668645575",
		checkinDate: "2026-09-08",
		checkoutDate: "2026-09-13",
		guestTotal: 431.2,
		payoutTotal: 266.83,
		relaySourceAt: "2026-08-05T09:31:55.000Z",
		directSourceAt: "2026-08-05T09:30:48.000Z",
	},
];

test("an OTA refresh cannot attach a provider alias equal to the PMS confirmation", async () => {
	const fixture = directUnmappedCase(PRODUCTION_UNMAPPED_DIRECT_CASES[0]);
	fixture.existing.reservation_id = "";
	fixture.normalized.reservationId = fixture.existing.confirmation_number;
	let updateCalls = 0;
	const originalUpdateOne = Reservations.updateOne;
	Reservations.updateOne = async () => {
		updateCalls += 1;
		throw new Error("unexpected reservation mutation");
	};
	try {
		await assert.rejects(
			() =>
				applyExistingReservationEmailUpdate({
					normalized: fixture.normalized,
					existing: fixture.existing,
					statusToApply: "confirmed",
					warnings: [],
				}),
			(error) => error?.code === "ota_pms_identity_collision"
		);
		assert.equal(updateCalls, 0);
	} finally {
		Reservations.updateOne = originalUpdateOne;
	}
});

test("authoritative relay refresh protects employee, finance, payment, room, and supplier state for mapped and unmapped reviews", () => {
	const clone = (value) => JSON.parse(JSON.stringify(value));
	const unmappedFixture = directUnmappedCase(PRODUCTION_UNMAPPED_DIRECT_CASES[0]);
	const unmapped = clone(unmappedFixture.existing);
	const mapped = clone(unmappedFixture.existing);
	for (const room of mapped.pickedRoomsType) {
		room.hotelRoomConfigId = "family-six";
		room.otaMatchedRoomName = room.displayName;
		room.otaRoomMatchType = "explicit_room_semantic";
		room.otaRoomMatchScore = 0.98;
	}
	mapped.pickedRoomsPricing = clone(mapped.pickedRoomsType);
	mapped.supplierData.otaHotelRoomConfigId = "family-six";
	mapped.supplierData.otaMatchedRoomName = mapped.pickedRoomsType[0].displayName;
	mapped.supplierData.otaRoomMatchType = "explicit_room_semantic";
	mapped.supplierData.otaRoomMatchScore = 0.98;
	mapped.adminPricing.mode = "ota_platform_sync";
	delete mapped.adminPricing.hotelAssignmentRequired;
	delete mapped.adminPricing.pricingReviewRequired;
	delete mapped.adminPricing.assignedHotelId;
	delete mapped.adminPricing.assignedHotelName;
	delete mapped.otaPlatformReview.roomMappingStatus;
	delete mapped.otaPlatformReview.roomMappingHotelId;

	assert.deepEqual(authoritativeExistingRefreshProtectedStateGuard(unmapped), {
		ok: true,
	});
	assert.deepEqual(authoritativeExistingRefreshProtectedStateGuard(mapped), {
		ok: true,
	});

	const protectedMutations = [
		["employee cash payment", (reservation) => {
			reservation.payment = "cash";
		}, "payment_state"],
		["employee finance hold", (reservation) => {
			reservation.financeStatus = "finance hold";
		}, "payment_state"],
		["payment processor reference", (reservation) => {
			reservation.payment_details.processor_reference = "processor-1";
		}, "capture_or_settlement"],
		["BofA VCC charge", (reservation) => {
			reservation.bofa_payment = { vcc: { charged: true } };
		}, "capture_or_settlement"],
		["employee payment bucket", (reservation) => {
			reservation.paid_amount_breakdown.employee_bucket = 1;
		}, "payment_breakdown"],
		["employee payment comment", (reservation) => {
			reservation.paid_amount_breakdown.payment_comments =
				"Employee changed this payment";
		}, "payment_breakdown"],
		["financial-cycle note", (reservation) => {
			reservation.financial_cycle.notes = "Finance reviewed";
		}, "financial_cycle"],
		["financial-cycle updater", (reservation) => {
			reservation.financial_cycle.lastUpdatedBy = "employee-1";
			reservation.financial_cycle.lastUpdatedAt = "2026-08-05T13:00:00.000Z";
		}, "financial_cycle"],
		["commission assignment", (reservation) => {
			reservation.financial_cycle.commissionAssigned = true;
			reservation.financial_cycle.commissionAssignedAt =
				"2026-08-05T13:00:00.000Z";
			reservation.financial_cycle.commissionAssignedBy = "employee-1";
		}, "capture_or_settlement"],
		["finance rejection", (reservation) => {
			reservation.totalReviewStatus = "rejected";
			reservation.financeRejectionComment = "Incorrect payout";
		}, "employee_or_finance_state"],
		["admin change log", (reservation) => {
			reservation.adminChangeLog = [{ actor: "employee-1" }];
		}, "employee_or_finance_state"],
		["false-valued client-total override marker", (reservation) => {
			reservation.adminPricing.clientTotalOverrideActive = false;
		}, "admin_pricing"],
		["client-total override reason", (reservation) => {
			reservation.adminPricing.clientTotalOverrideReason = "Employee override";
		}, "admin_pricing"],
		["visibility actor", (reservation) => {
			reservation.adminPricingVisibility = {
				rootOnlyForHotelManagement: true,
				source: "ota_email_create",
				appliedAt: "2026-08-05T13:00:00.000Z",
				appliedBy: "employee-1",
			};
		}, "admin_pricing_visibility"],
		["review pricing timestamp", (reservation) => {
			reservation.otaPlatformReview.lastPricingUpdatedAt =
				"2026-08-05T13:00:00.000Z";
		}, "review_state"],
		["review invalidation", (reservation) => {
			reservation.otaPlatformReview.pricingInvalidatedAt =
				"2026-08-05T13:00:00.000Z";
			reservation.otaPlatformReview.pricingInvalidationReason = "employee";
		}, "review_state"],
		["manual room review status", (reservation) => {
			reservation.otaPlatformReview.roomMappingStatus = "mapped";
		}, "review_state"],
		["room review hotel marker", (reservation) => {
			reservation.otaPlatformReview.roomMappingHotelId = reservation.hotelId;
		}, "review_state"],
		["employee review assignment", (reservation) => {
			reservation.otaPlatformReview.assignedBy = { role: "employee" };
			reservation.otaPlatformReview.assignedAt = "2026-08-05T13:00:00.000Z";
		}, "review_state"],
		["review and supplier audit mismatch", (reservation) => {
			reservation.otaPlatformReview.inboundEmailId = "review-audit";
			reservation.supplierData.otaLastInboundEmailId = "supplier-audit";
		}, "review_state"],
		["employee supplier assignment", (reservation) => {
			reservation.supplierData.otaAssignedHotelBy = { role: "employee" };
			reservation.supplierData.otaAssignedHotelAt =
				"2026-08-05T13:00:00.000Z";
		}, "supplier_state"],
		["manual nested room mapping", (reservation) => {
			for (const rooms of [
				reservation.pickedRoomsType,
				reservation.pickedRoomsPricing,
			]) {
				rooms[0].otaRoomMatchType = "manual";
			}
		}, "room_state"],
		["nested room root drift", (reservation) => {
			for (const rooms of [
				reservation.pickedRoomsType,
				reservation.pickedRoomsPricing,
			]) {
				rooms[0].adminPricing = { rootTotal: 1 };
			}
		}, "room_state"],
		["room-array drift", (reservation) => {
			reservation.pickedRoomsPricing[0].room_type = "quadRooms";
		}, "room_state"],
		["supplier room drift", (reservation) => {
			reservation.supplierData.otaMatchedRoomName = "Employee room";
		}, "supplier_state"],
		["processor transaction", (reservation) => {
			reservation.vcc_payment.last_transaction_id = "transaction-1";
		}, "capture_or_settlement"],
		["hotel transfer", (reservation) => {
			reservation.moneyTransferredToHotel = true;
		}, "capture_or_settlement"],
		["commission record", (reservation) => {
			reservation.commissionData = { assigned: true, status: "pending" };
		}, "capture_or_settlement"],
	];

	for (const [shape, safeReservation] of [
		["unmapped", unmapped],
		["mapped", mapped],
	]) {
		for (const [label, mutate, reason] of protectedMutations) {
			const reservation = clone(safeReservation);
			mutate(reservation);
			assert.deepEqual(
				authoritativeExistingRefreshProtectedStateGuard(reservation),
				{ ok: false, reason },
				`${shape}: ${label}`
			);
		}
	}
});

test("authoritative refresh recognizes only exact OTA-collect, hotel-collect, and virtual-card payment baselines", () => {
	const clone = (value) => JSON.parse(JSON.stringify(value));
	const otaCollect = clone(
		directUnmappedCase(PRODUCTION_UNMAPPED_DIRECT_CASES[0]).existing
	);
	assert.deepEqual(authoritativeExistingRefreshProtectedStateGuard(otaCollect), {
		ok: true,
	});

	const pendingBaseline = (model) => {
		const reservation = clone(otaCollect);
		reservation.supplierData.otaPaymentCollectionModel = model;
		reservation.payment =
			model === "virtual_card" ? "credit/ debit" : "not paid";
		reservation.financeStatus = "not paid";
		reservation.paid_amount = 0;
		reservation.paid_amount_breakdown = {
			paid_online_via_link: 0,
			paid_at_hotel_cash: 0,
			paid_at_hotel_card: 0,
			paid_to_hotel: 0,
			paid_online_jannatbooking: 0,
			paid_online_other_platforms: 0,
			paid_online_via_instapay: 0,
			paid_no_show: 0,
			payment_comments:
				model === "virtual_card"
					? "Agoda virtual card pending capture"
					: "Agoda hotel collect / pay at property",
		};
		reservation.financial_cycle = {
			...reservation.financial_cycle,
			collectionModel: "pending",
			pmsCollectedAmount: 0,
			hotelCollectedAmount: 0,
			hotelPayoutDue: 0,
			commissionDueToPms: 0,
		};
		return reservation;
	};
	const hotelCollect = pendingBaseline("hotel_collect");
	const virtualCard = pendingBaseline("virtual_card");
	for (const [label, reservation] of [
		["hotel collect", hotelCollect],
		["virtual card", virtualCard],
	]) {
		assert.deepEqual(
			authoritativeExistingRefreshProtectedStateGuard(reservation),
			{ ok: true },
			label
		);
		const paidOnlineDrift = clone(reservation);
		paidOnlineDrift.financeStatus = "paid online";
		assert.deepEqual(
			authoritativeExistingRefreshProtectedStateGuard(paidOnlineDrift),
			{ ok: false, reason: "payment_state" },
			`${label}: paid-online finance drift`
		);
	}
	const conflictingModel = clone(hotelCollect);
	conflictingModel.supplierData.otaPaymentCollectionModel = "ota_collect";
	assert.deepEqual(
		authoritativeExistingRefreshProtectedStateGuard(conflictingModel),
		{ ok: false, reason: "payment_state" }
	);
});

test("authoritative refresh hotel guard accepts only exact active ownership or a verified Airbnb direct ID", () => {
	const fixture = directUnmappedCase(PRODUCTION_UNMAPPED_DIRECT_CASES[0]);
	fixture.normalized.authoritativeExistingRefresh = true;
	const matchedReservationBy = [
		"otaIdentityKey",
		"reservation_id",
		"supplierData.otaConfirmationNumber",
	];
	const evaluate = (normalized, hotelDetails = ZAD_UNMAPPED_HOTEL) =>
		authoritativeExistingRefreshGuard({
			normalized,
			existing: fixture.existing,
			hotelDetails,
			matchedReservationBy,
		});

	assert.deepEqual(evaluate(fixture.normalized), { ok: true, roomCount: 1 });
	for (const hotelName of [
		"Zadd Ajyad",
		"Zad Ajya",
		"Zad Ajyadd",
		"Zad Ajyad Annex",
		"Zad Ajyd",
	]) {
		assert.deepEqual(
			evaluate({ ...fixture.normalized, hotelName }),
			{ ok: false, reason: "hotel" },
			hotelName
		);
	}
	assert.deepEqual(
		evaluate(fixture.normalized, {
			...ZAD_UNMAPPED_HOTEL,
			activateHotel: false,
		}),
		{ ok: false, reason: "hotel" }
	);
	assert.deepEqual(
		evaluate(fixture.normalized, {
			...ZAD_UNMAPPED_HOTEL,
			belongsTo: "another-owner",
		}),
		{ ok: false, reason: "hotel" }
	);

	const airbnb = {
		...fixture.normalized,
		provider: "airbnb",
		providerLabel: "Airbnb",
		bookingSource: "Airbnb",
		trustedTransportProvider: "airbnb",
		hotelName: "Source listing title that is not a PMS hotel label",
		hotelId: ZAD_UNMAPPED_HOTEL._id,
		hotelIdMatchStrength: "exact",
		hotelIdMatchedBy: "airbnb_listing_id",
		hotelIdMatchedValue: "listing-123",
		airbnbListingId: "listing-123",
		sourcePresence: {
			...fixture.normalized.sourcePresence,
			airbnbListingId: true,
		},
		source: {
			...fixture.normalized.source,
			from: "Airbnb <automated@airbnb.com>",
			textHash: immutableFixtureTextHash(
				"Airbnb authenticated direct commercial confirmation",
				fixture.normalized.confirmationNumber,
				fixture.normalized.source.receivedAt,
				fixture.normalized.sourceAmount,
				fixture.normalized.paymentSummary.sourceTotalPayoutAmount
			),
		},
	};
	assert.deepEqual(evaluate(airbnb), { ok: true, roomCount: 1 });
	assert.deepEqual(
		evaluate({ ...airbnb, hotelIdMatchStrength: "fuzzy" }),
		{ ok: false, reason: "hotel" }
	);
});

test("production-shaped 3612 and 4202 direct confirmations refresh only the protected unmapped commercial bundle", async () => {
	const originalReservationFind = Reservations.find;
	const originalReservationUpdateOne = Reservations.updateOne;
	const originalHotelFind = HotelDetails.find;
	let existing = null;
	let capturedUpdate = null;
	Reservations.find = () => ({
		limit() {
			return this;
		},
		select() {
			return this;
		},
		async exec() {
			return [existing];
		},
	});
	Reservations.updateOne = async (filter, update) => {
		capturedUpdate = { filter, update };
		return { matchedCount: 1 };
	};
	HotelDetails.find = () => ({
		select() {
			return this;
		},
		async lean() {
			return [ZAD_UNMAPPED_HOTEL];
		},
	});

	try {
		for (const productionCase of PRODUCTION_UNMAPPED_DIRECT_CASES) {
			const fixture = directUnmappedCase(productionCase);
			const employeeComment = `Employee operations note ${productionCase.confirmationNumber}`;
			const employeeBookingComment = `Employee booking note ${productionCase.confirmationNumber}`;
			const otaGuestNote = `OTA guest note ${productionCase.confirmationNumber}`;
			fixture.existing.comment = employeeComment;
			fixture.existing.booking_comment = employeeBookingComment;
			fixture.normalized.guestNotes = otaGuestNote;
			fixture.normalized.sourcePresence.guestNotes = true;
			existing = fixture.existing;
			capturedUpdate = null;
			const result = await reconcileOtaReservation(fixture.normalized);
			assert.equal(result.status, "updated", productionCase.confirmationNumber);
			assert.ok(capturedUpdate, productionCase.confirmationNumber);
			const { filter, update } = capturedUpdate;
			const set = update.$set;
			const updatedPaths = Object.keys(set);
			for (const parentPath of updatedPaths.filter(
				(path) => !path.includes(".") && set[path] && typeof set[path] === "object"
			)) {
				assert.equal(
					updatedPaths.some((path) => path.startsWith(`${parentPath}.`)),
					false,
					`MongoDB update cannot contain both ${parentPath} and a child path`
				);
			}
			assert.equal(filter._id, existing._id);
			assert.equal(filter.__v, existing.__v);
			assert.equal(filter.updatedAt, existing.updatedAt);
			assert.equal(update.$inc.__v, 1);
			assert.equal(set.hotelId, ZAD_UNMAPPED_HOTEL._id);
			assert.equal(set.belongsTo, ZAD_UNMAPPED_HOTEL.belongsTo);
			assert.equal(set.roomId, undefined);
			assert.equal(set.total_amount, productionCase.guestTotal);
			assert.equal(set.paid_amount, productionCase.guestTotal);
			assert.equal(
				set.paid_amount_breakdown.paid_online_other_platforms,
				productionCase.guestTotal
			);
			assert.equal(set.adminPricing.clientTotal, productionCase.guestTotal);
			assert.equal(
				set.adminPricing.netAfterExpensesTotal,
				productionCase.payoutTotal
			);
			assert.equal(
				set.adminPricing.otaExpenseTotal,
				Number(
					(productionCase.guestTotal - productionCase.payoutTotal).toFixed(2)
				)
			);
			assert.equal(set.adminPricing.defaultDeductionApplied, false);
			assert.equal(set.adminPricing.rootTotal, 0);
			assert.equal(set.adminPricing.platformMarginTotal, 0);
			assert.equal(set.adminPricing.commissionAmount, 0);
			assert.equal(set.adminPricing.pricingReviewRequired, true);
			assert.equal(set.ota_financial_summary.clientTotal, productionCase.guestTotal);
			assert.equal(
				set.ota_financial_summary.netAfterExpenses,
				productionCase.payoutTotal
			);
			assert.equal(set.ota_financial_summary.hotelVisibleAmount, 0);
			assert.equal(set.ota_financial_summary.platformProfit, 0);
			assert.equal(set.ota_financial_summary.commissionAmount, 0);
			assert.equal(set.financial_cycle.pmsCollectedAmount, productionCase.guestTotal);
			assert.equal(set.financial_cycle.hotelPayoutDue, 0);
			assert.equal(set.financial_cycle.commissionAmount, 0);
			assert.equal(set.financial_cycle.commissionDueToPms, 0);
			assert.deepEqual(set.payment_details, {
				captured: false,
				onsite_paid_amount: 0,
			});
			assert.equal(set.pickedRoomsType.length, 1);
			assert.deepEqual(set.pickedRoomsType, set.pickedRoomsPricing);
			assert.equal(set.pickedRoomsType[0].room_type, "familyRooms");
			assert.equal(set.pickedRoomsType[0].displayName, "Deluxe Family Room 2");
			assert.equal(set.pickedRoomsType[0].hotelRoomConfigId, undefined);
			const days = set.pickedRoomsType[0].pricingByDay;
			assert.equal(days.length, generateDateRange(
				productionCase.checkinDate,
				productionCase.checkoutDate
			).length);
			assert.equal(
				Number(days.reduce((sum, day) => sum + day.clientPrice, 0).toFixed(2)),
				productionCase.guestTotal
			);
			assert.equal(
				Number(days.reduce((sum, day) => sum + day.netAfterOtaExpenses, 0).toFixed(2)),
				productionCase.payoutTotal
			);
			for (const day of days) {
				assert.equal(day.rootPrice, 0);
				assert.equal(day.totalPriceWithoutCommission, 0);
				assert.equal(day.commissionRate, 0);
				assert.equal(day.platformMargin, null);
			}
			assert.equal(set["supplierData.otaSourceAuthority"], 3);
			assert.equal(
				set["supplierData.otaTotalPayoutSar"],
				productionCase.payoutTotal
			);
			assert.equal(
				set["supplierData.otaPaymentInstructions"],
				"Agoda prepaid reservation; net rate is provided by Agoda."
			);
			assert.equal(
				set["supplierData.otaLastSourceReceivedAt"],
				undefined,
				"the newer relay source watermark remains monotonic"
			);
			assert.equal(set["otaPlatformReview.status"], "pending");
			assert.equal(set["otaPlatformReview.roomMappingStatus"], undefined);
			assert.equal(set.availabilitySnapshot, undefined);
			assert.equal(
				set.comment,
				undefined,
				"authoritative OTA refresh preserves the employee operations note"
			);
			assert.equal(
				set.booking_comment,
				undefined,
				"authoritative OTA refresh preserves the employee booking note"
			);
			assert.equal(set["supplierData.otaGuestNotes"], otaGuestNote);
			assert.match(
				result.warnings.join(" "),
				/unmapped review.*root, margin, and commission.*zero/i
			);
		}
	} finally {
		Reservations.find = originalReservationFind;
		Reservations.updateOne = originalReservationUpdateOne;
		HotelDetails.find = originalHotelFind;
	}
});

test("authoritative OTA guest notes fill only blank employee-note fields", () => {
	const otaGuestNote = "Quiet room requested by the OTA guest";
	for (const blankPath of ["comment", "booking_comment"]) {
		const fixture = directUnmappedCase(PRODUCTION_UNMAPPED_DIRECT_CASES[0]);
		fixture.normalized.authoritativeExistingRefresh = true;
		fixture.normalized.guestNotes = otaGuestNote;
		fixture.normalized.sourcePresence.guestNotes = true;
		fixture.existing.comment = "Employee operations note";
		fixture.existing.booking_comment = "Employee booking note";
		fixture.existing[blankPath] = "";
		const document = buildUnmappedOtaReviewReservationDocument(fixture.normalized);
		assert.equal(
			applyExactResolvedHotelToUnmappedReview(
				document,
				ZAD_UNMAPPED_HOTEL,
				fixture.normalized
			),
			true
		);
		const set = buildExistingReservationUpdateSet({
			document,
			existing: fixture.existing,
			normalized: fixture.normalized,
			warnings: [],
		});
		const protectedPath = blankPath === "comment" ? "booking_comment" : "comment";
		assert.equal(set[blankPath], otaGuestNote, blankPath);
		assert.equal(set[protectedPath], undefined, protectedPath);
		assert.equal(set["supplierData.otaGuestNotes"], otaGuestNote, blankPath);
	}
});

test("unmapped direct-after-relay guard fails closed for every protected drift class", () => {
	const fixture = directUnmappedCase(PRODUCTION_UNMAPPED_DIRECT_CASES[0]);
	fixture.normalized.authoritativeExistingRefresh = true;
	const matchedReservationBy = [
		"otaIdentityKey",
		"reservation_id",
		"supplierData.otaConfirmationNumber",
	];
	const evaluate = ({ normalized, existing, hotel, matched, document } = {}) =>
		directAfterRelayUnmappedReviewGuard({
			normalized: normalized || fixture.normalized,
			existing: existing || fixture.existing,
			hotelDetails: hotel || ZAD_UNMAPPED_HOTEL,
			matchedReservationBy: matched || matchedReservationBy,
			document,
		});
	assert.equal(evaluate().ok, true);

	const clone = (value) => JSON.parse(JSON.stringify(value));
	const cases = [
		{
			label: "relay provenance",
			args: {
				existing: {
					...fixture.existing,
					supplierData: {
						...fixture.existing.supplierData,
						otaSourceAuthority: 2,
					},
				},
			},
			reason: "relay_provenance",
		},
		{
			label: "identity",
			args: { matched: ["reservation_id"] },
			reason: "identity",
		},
		{
			label: "stay",
			args: {
				normalized: { ...fixture.normalized, checkinDate: "2026-09-07" },
			},
			reason: "stay",
		},
		{
			label: "inactive hotel",
			args: { hotel: { ...ZAD_UNMAPPED_HOTEL, activateHotel: false } },
			reason: "hotel",
		},
		{
			label: "hotel owner",
			args: {
				existing: { ...fixture.existing, belongsTo: "another-owner" },
			},
			reason: "hotel",
		},
		{
			label: "room semantic",
			args: {
				normalized: {
					...fixture.normalized,
					roomName: "Quadruple Room for 4 Guests",
				},
			},
			reason: "room_semantic_or_capacity",
		},
		{
			label: "room capacity",
			args: {
				normalized: { ...fixture.normalized, totalGuests: 5, adults: 5 },
			},
			reason: "room_semantic_or_capacity",
		},
		{
			label: "room count",
			args: {
				normalized: {
					...fixture.normalized,
					roomCount: 2,
					totalGuests: 8,
				},
			},
			reason: "room_count",
		},
		{
			label: "existing room config",
			args: {
				existing: {
					...fixture.existing,
					pickedRoomsType: [{
						...fixture.existing.pickedRoomsType[0],
						hotelRoomConfigId: "family-four",
					}],
				},
			},
			reason: "room_configuration",
		},
		{
			label: "room provenance",
			args: {
				existing: {
					...fixture.existing,
					supplierData: {
						...fixture.existing.supplierData,
						otaTotalGuests: 5,
					},
				},
			},
			reason: "room_provenance",
		},
		{
			label: "root",
			args: {
				existing: {
					...fixture.existing,
					adminPricing: { ...fixture.existing.adminPricing, rootTotal: 1 },
				},
			},
			reason: "root_or_margin",
		},
		{
			label: "released review",
			args: {
				existing: {
					...fixture.existing,
					otaPlatformReview: {
						...fixture.existing.otaPlatformReview,
						releasedAt: "2026-08-05T13:00:00.000Z",
					},
				},
			},
			reason: "review_state",
		},
		{
			label: "capture",
			args: {
				existing: {
					...fixture.existing,
					vcc_payment: { ...fixture.existing.vcc_payment, charged: true },
				},
			},
			reason: "capture_or_settlement",
		},
		{
			label: "settlement",
			args: {
				existing: { ...fixture.existing, moneyTransferredToHotel: true },
			},
			reason: "capture_or_settlement",
		},
		{
			label: "commission settlement data",
			args: {
				existing: {
					...fixture.existing,
					commissionData: { settledBy: "finance" },
				},
			},
			reason: "capture_or_settlement",
		},
		{
			label: "commercial payout",
			args: {
				normalized: {
					...fixture.normalized,
					totalPayoutSar: null,
					netAfterExpensesTotal: null,
					paymentSummary: {
						...fixture.normalized.paymentSummary,
						sourceTotalPayoutAmount: null,
						totalPayoutAmount: null,
					},
				},
			},
			reason: "commercial_evidence",
		},
	];
	for (const negative of cases) {
		const result = evaluate(negative.args);
		assert.equal(result.ok, false, negative.label);
		assert.equal(result.reason, negative.reason, negative.label);
	}

	const rebuilt = buildUnmappedOtaReviewReservationDocument(fixture.normalized);
	assert.equal(
		applyExactResolvedHotelToUnmappedReview(
			rebuilt,
			ZAD_UNMAPPED_HOTEL,
			fixture.normalized
		),
		true
	);
	const configuredDocument = clone(rebuilt);
	configuredDocument.pickedRoomsType[0].hotelRoomConfigId = "invented-room";
	const rebuiltResult = evaluate({ document: configuredDocument });
	assert.equal(rebuiltResult.ok, false);
	assert.equal(rebuiltResult.reason, "rebuilt_document");
});

test("a protected unmapped drift never reaches reservation mutation", async () => {
	const originalReservationFind = Reservations.find;
	const originalReservationUpdateOne = Reservations.updateOne;
	const originalHotelFind = HotelDetails.find;
	const fixture = directUnmappedCase(PRODUCTION_UNMAPPED_DIRECT_CASES[1]);
	fixture.existing.adminPricing.rootTotal = 1;
	let mutationCalls = 0;
	Reservations.find = () => ({
		limit() {
			return this;
		},
		select() {
			return this;
		},
		async exec() {
			return [fixture.existing];
		},
	});
	Reservations.updateOne = async () => {
		mutationCalls += 1;
		throw new Error("unexpected mutation");
	};
	HotelDetails.find = () => ({
		select() {
			return this;
		},
		async lean() {
			return [ZAD_UNMAPPED_HOTEL];
		},
	});
	try {
		const result = await reconcileOtaReservation(fixture.normalized);
		assert.equal(result.status, "needs_review");
		assert.equal(
			result.skipReason,
			"authoritative_relay_refresh_unmapped_guard_failed"
		);
		assert.match(result.errors.join(" "), /root_or_margin/);
		assert.equal(mutationCalls, 0);
	} finally {
		Reservations.find = originalReservationFind;
		Reservations.updateOne = originalReservationUpdateOne;
		HotelDetails.find = originalHotelFind;
	}
});

test("unmapped authoritative refresh never overwrites employee payment or finance-status drift", async () => {
	const originalReservationFind = Reservations.find;
	const originalReservationUpdateOne = Reservations.updateOne;
	const originalHotelFind = HotelDetails.find;
	const fixture = directUnmappedCase(PRODUCTION_UNMAPPED_DIRECT_CASES[1]);
	const clone = (value) => JSON.parse(JSON.stringify(value));
	let existing = null;
	let mutationCalls = 0;
	Reservations.find = () => ({
		limit() {
			return this;
		},
		select() {
			return this;
		},
		async exec() {
			return [existing];
		},
	});
	Reservations.updateOne = async () => {
		mutationCalls += 1;
		throw new Error("unexpected mutation");
	};
	HotelDetails.find = () => ({
		select() {
			return this;
		},
		async lean() {
			return [ZAD_UNMAPPED_HOTEL];
		},
	});
	try {
		for (const [label, mutate] of [
			["cash payment", (reservation) => {
				reservation.payment = "cash";
			}],
			["finance hold", (reservation) => {
				reservation.financeStatus = "finance hold";
			}],
		]) {
			existing = clone(fixture.existing);
			mutate(existing);
			const result = await reconcileOtaReservation(clone(fixture.normalized));
			assert.equal(result.status, "needs_review", label);
			assert.equal(
				result.skipReason,
				"authoritative_existing_refresh_guard_failed",
				label
			);
		}
		assert.equal(mutationCalls, 0);
	} finally {
		Reservations.find = originalReservationFind;
		Reservations.updateOne = originalReservationUpdateOne;
		HotelDetails.find = originalHotelFind;
	}
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

test("source-backed hotel identity outranks incidental PMS hotel mentions and missing source identity stays missing", async () => {
	const originalFind = HotelDetails.find;
	const originalFindById = HotelDetails.findById;
	const hotels = [
		{ _id: "alpha", hotelName: "Alpha Hotel" },
		{ _id: "beta", hotelName: "Beta Hotel" },
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
	HotelDetails.findById = (hotelId) =>
		queryFor(hotels.find((hotel) => hotel._id === String(hotelId)) || null);

	try {
		const unresolved = await resolveHotel({
			hotelName: "Completely Unknown Property",
			sourcePresence: { hotelName: true },
			source: {
				subject: "Completely Unknown Property - new reservation",
				safeSnippet: "For support, contact the Beta Hotel reservations team.",
			},
		});
		assert.equal(unresolved, null);

		const unresolvedDirectId = await resolveHotel({
			hotelId: "missing-source-hotel-id",
			hotelName: "Completely Unknown Property",
			sourcePresence: { hotelName: true },
			source: { safeSnippet: "Beta Hotel support desk" },
		});
		assert.equal(unresolvedDirectId, null);

		const exact = await resolveHotel({
			hotelName: "Beta Hotel",
			sourcePresence: { hotelName: true },
			source: { safeSnippet: "Alpha Hotel support desk" },
		});
		assert.equal(exact?._id, "beta");

		const exactAlias = await resolveHotel({
			hotelName: "Beta property official listing",
			hotelNameAliases: ["Beta Hotel"],
			sourcePresence: { hotelName: true },
			source: { safeSnippet: "Alpha Hotel support desk" },
		});
		assert.equal(exactAlias?._id, "beta");

		const withoutSourceHotel = {
			hotelName: "",
			sourcePresence: { hotelName: false },
			source: { safeSnippet: "Reservation delivered for Beta Hotel" },
		};
		const mentioned = await resolveHotel(withoutSourceHotel);
		assert.equal(mentioned?._id, "beta");
		assert.equal(withoutSourceHotel.sourcePresence.hotelName, false);
		assert.ok(
			requiredNewReservationMissing({
				...withoutSourceHotel,
				inboundEmailId: "missing-hotel-source-proof",
				provider: "agoda",
				confirmationNumber: "2038704202",
				guestName: "Example Guest",
				roomName: "Double Room",
				checkinDate: "2026-09-01",
				checkoutDate: "2026-09-02",
				amount: 100,
				totalAmountSar: 100,
				sourcePresence: {
					confirmationNumber: true,
					guestName: true,
					hotelName: false,
					roomName: true,
					checkinDate: true,
					checkoutDate: true,
					amount: true,
				},
			}).includes("source-backed hotel/property")
		);
	} finally {
		HotelDetails.find = originalFind;
		HotelDetails.findById = originalFindById;
	}
});

test("an unresolved source-backed OTA hotel cannot create or mutate through an incidental exact PMS mention", async () => {
	const originalReservationFind = Reservations.find;
	const originalReservationWrites = Object.fromEntries(
		["create", "updateOne", "findOneAndUpdate", "bulkWrite"].map((method) => [
			method,
			Reservations[method],
		])
	);
	const originalHotelFind = HotelDetails.find;
	let mutationCalls = 0;
	let lookupCalls = 0;

	Reservations.find = () => ({
		limit() {
			return this;
		},
		select() {
			return this;
		},
		async exec() {
			lookupCalls += 1;
			return [];
		},
	});
	for (const method of Object.keys(originalReservationWrites)) {
		Reservations[method] = async () => {
			mutationCalls += 1;
			throw new Error(`unexpected reservation ${method}`);
		};
	}
	HotelDetails.find = () => ({
		select() {
			return this;
		},
		async lean() {
			return [
				{ _id: "alpha", hotelName: "Alpha Hotel" },
				{ _id: "beta", hotelName: "Beta Hotel" },
			];
		},
	});

	try {
		const result = await reconcileOtaReservation({
			inboundEmailId: "source-hotel-incidental-pms-mention",
			provider: "agoda",
			providerLabel: "Agoda",
			bookingSource: "Agoda",
			confirmationNumber: "2038704202",
			reservationId: "2038704202",
			intent: "new_reservation",
			eventType: "new",
			guestName: "Protected Guest",
			hotelName: "Completely Unknown Property",
			roomName: "Double Room",
			checkinDate: "2026-09-08",
			checkoutDate: "2026-09-09",
			amount: 100,
			currency: "SAR",
			totalAmountSar: 100,
			roomCount: 1,
			totalGuests: 2,
			adults: 2,
			children: 0,
			sourceSenderTrusted: true,
			sourceSenderAuthenticated: true,
			sourcePresence: {
				confirmationNumber: true,
				reservationId: true,
				guestName: true,
				hotelName: true,
				roomName: true,
				checkinDate: true,
				checkoutDate: true,
				amount: true,
				roomCount: true,
				totalGuests: true,
				adults: true,
				children: true,
			},
			source: {
				from: "noreply@agoda.com",
				subject: "Completely Unknown Property - new reservation",
				safeSnippet:
					"For support, contact the Beta Hotel reservations team.",
			},
		});

		assert.equal(result.status, "needs_review");
		assert.equal(result.actionTaken, "skipped");
		assert.equal(result.skipReason, "source_backed_hotel_unresolved_no_mutation");
		assert.equal(lookupCalls, 1);
		assert.equal(mutationCalls, 0);
	} finally {
		Reservations.find = originalReservationFind;
		for (const [method, original] of Object.entries(originalReservationWrites)) {
			Reservations[method] = original;
		}
		HotelDetails.find = originalHotelFind;
	}
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

const DIRECT_BOOKING_REPEATED_FACT_DEFAULTS = Object.freeze({
	guestName: "John Doe",
	hotelName: "Hotel Alpha",
	roomName: "Triple Room",
	checkinDate: "August 10, 2026",
	checkoutDate: "August 12, 2026",
	amount: "SAR 500",
	roomCount: "1",
	adults: "2",
	children: "0",
	totalGuests: "2",
});

const DIRECT_BOOKING_REPEATED_FACT_LABELS = Object.freeze({
	guestName: "Guest name",
	hotelName: "Hotel name",
	roomName: "Room type",
	checkinDate: "Check-in",
	checkoutDate: "Check-out",
	amount: "Total amount",
	roomCount: "Number of rooms",
	adults: "Adults",
	children: "Children",
	totalGuests: "Total guests",
});

const makeDirectBookingRepeatedFactEmail = ({
	confirmationNumber = "44556688",
	subject = `New reservation ${confirmationNumber}`,
	facts = {},
	repeatedLines = [],
	htmlMirror = false,
} = {}) => {
	const mergedFacts = {
		...DIRECT_BOOKING_REPEATED_FACT_DEFAULTS,
		...facts,
	};
	const lines = [
		`Confirmation number: ${confirmationNumber}`,
		...Object.entries(DIRECT_BOOKING_REPEATED_FACT_LABELS).map(
			([field, label]) => `${label}: ${mergedFacts[field]}`
		),
		...repeatedLines,
	];
	return {
		from: '"Booking.com" <noreply@booking.com>',
		to: "ota@example.com",
		subject,
		text: lines.join("\n"),
		html: htmlMirror
			? lines.map((line) => `<p>${line}</p>`).join("")
			: "",
		receivedAt: "2026-08-04T11:00:00.000Z",
		sourceReceivedAt: "2026-08-04T11:00:00.000Z",
		sourceTimestampMethod: "rfc2822_date_header",
		senderAuthentication: {
			authenticatedAligned: true,
			trustedProvider: "booking",
			method: "dkim",
		},
	};
};

const DIRECT_BOOKING_DISTINCT_REPEATED_FACT_CASES = [
	["hotelName", "Hotel Alpha", "Hotel Beta"],
	["roomName", "Triple Room", "Double Room"],
	["checkinDate", "August 10, 2026", "August 11, 2026"],
	["checkoutDate", "August 12, 2026", "August 13, 2026"],
	["amount", "SAR 500", "SAR 700"],
	["roomCount", "1", "2"],
	["guestName", "John Doe", "Jane Roe"],
	["adults", "2", "3"],
	["children", "0", "1"],
	["totalGuests", "2", "3"],
];

test("authenticated direct Booking repeated commercial, stay, guest, and count facts fail closed in either order", () => {
	for (const [field, first, second] of DIRECT_BOOKING_DISTINCT_REPEATED_FACT_CASES) {
		const label = DIRECT_BOOKING_REPEATED_FACT_LABELS[field];
		for (const [leading, repeated] of [
			[first, second],
			[second, first],
		]) {
			const normalized = extractNormalizedReservation(
				makeDirectBookingRepeatedFactEmail({
					facts: { [field]: leading },
					repeatedLines: [`${label}: ${repeated}`],
				})
			);
			assert.deepEqual(
				normalized.genericRepeatedFactConflictFields,
				[field],
				`${field}: ${leading} then ${repeated}`
			);
			assert.equal(normalized.genericRepeatedFactConflict, true, field);
			assert.equal(normalized.requiresManualReview, true, field);
			assert.equal(normalized.blocksUnmappedReservationCreation, true, field);
			assert.equal(normalized.sourcePresence[field], false, field);
			assert.ok(
				normalized.manualReviewReasons.some((reason) =>
					reason.startsWith(
						"Authenticated direct OTA email contains conflicting repeated explicit"
					)
				),
				field
			);
			assert.match(
				getDeterministicExtractionSkipReason(normalized),
				/extraction AI cannot choose/i,
				field
			);
		}
	}

	const currencyConflict = extractNormalizedReservation(
		makeDirectBookingRepeatedFactEmail({
			repeatedLines: ["Total amount: USD 500"],
		})
	);
	assert.deepEqual(currencyConflict.genericRepeatedFactConflictFields, ["amount"]);
});

test("canonical-equivalent direct Booking repeats and text/HTML MIME mirrors remain deterministic", () => {
	const equivalentCases = [
		{
			field: "hotelName",
			facts: { hotelName: "Zyd Agyad" },
			repeated: "Hotel name: Zad Ajyad",
		},
		{ field: "roomName", repeated: "Room type: Tholasy Rooms" },
		{ field: "checkinDate", repeated: "Check-in date: 2026-08-10" },
		{ field: "checkoutDate", repeated: "Departure: 12 Aug 2026" },
		{ field: "amount", repeated: "Guest total: SR 500.00" },
		{ field: "roomCount", repeated: "Rooms booked: 1 room" },
		{ field: "guestName", repeated: "Customer name: JOHN DOE" },
		{ field: "adults", repeated: "Adult count: 2 adults" },
		{ field: "children", repeated: "Child count: none" },
		{ field: "totalGuests", repeated: "Guest count: 2 guests" },
	];
	for (const { field, facts = {}, repeated } of equivalentCases) {
		const normalized = extractNormalizedReservation(
			makeDirectBookingRepeatedFactEmail({ facts, repeatedLines: [repeated] })
		);
		assert.deepEqual(normalized.genericRepeatedFactConflictFields, [], field);
		assert.equal(normalized.genericRepeatedFactConflict, false, field);
		assert.equal(normalized.requiresManualReview, false, field);
	}

	const mirrored = extractNormalizedReservation(
		makeDirectBookingRepeatedFactEmail({ htmlMirror: true })
	);
	assert.deepEqual(mirrored.genericRepeatedFactConflictFields, []);
	assert.equal(mirrored.requiresManualReview, false);
});

test("adjacent OTA time, age, identity, and pricing subfields are not duplicate primary facts", () => {
	const normalized = extractNormalizedReservation(
		makeDirectBookingRepeatedFactEmail({
			repeatedLines: [
				"Hotel name local language: Hotel Alpha Arabic",
				"Room type code: TRI",
				"Check-in time: 15:00",
				"Check-out time: 11:00",
				"Arrival: Flight SV 108 at 19:00",
				"Departure: Jeddah Airport transfer",
				"Total amount before tax: SAR 450",
				"Guest name pronunciation: Jon Doe",
				"Adults ages: 30, 28",
				"Children ages: 4, 7",
				"Total guests names: John Doe, Jane Doe",
			],
		})
	);
	assert.deepEqual(normalized.genericRepeatedFactConflictFields, []);
	assert.equal(normalized.requiresManualReview, false);

	const explicitInvalidDateConflict = extractNormalizedReservation(
		makeDirectBookingRepeatedFactEmail({
			repeatedLines: ["Check-in: date unavailable"],
		})
	);
	assert.deepEqual(explicitInvalidDateConflict.genericRepeatedFactConflictFields, [
		"checkinDate",
	]);
	assert.equal(explicitInvalidDateConflict.requiresManualReview, true);
});

test("generic repeated-fact guard is bounded to authenticated direct OTA transport", () => {
	const directUnauthenticated = makeDirectBookingRepeatedFactEmail({
		repeatedLines: ["Hotel name: Hotel Beta"],
	});
	delete directUnauthenticated.senderAuthentication;
	const unauthenticated = extractNormalizedReservation(directUnauthenticated);
	assert.deepEqual(unauthenticated.genericRepeatedFactConflictFields, []);
	assert.equal(unauthenticated.genericRepeatedFactConflict, false);

	const hotelRunner = extractNormalizedReservation({
		...makeDirectBookingRepeatedFactEmail({
			repeatedLines: ["Hotel name: Hotel Beta"],
		}),
		from: '"HotelRunner" <noreply@hotelrunner.com>',
		senderAuthentication: {
			authenticatedAligned: true,
			trustedProvider: "hotelrunner",
			method: "dkim",
		},
	});
	assert.deepEqual(hotelRunner.genericRepeatedFactConflictFields, []);
	assert.equal(hotelRunner.genericRepeatedFactConflict, false);
});

test("repeated-fact parser guard skips extraction AI, reservation lookup, creation, and mutation", async () => {
	const email = makeDirectBookingRepeatedFactEmail({
		repeatedLines: ["Hotel name: Hotel Beta"],
	});
	const orchestrated = await orchestrateInboundReservationEmail(email);
	assert.equal(orchestrated.normalized.requiresManualReview, true);
	assert.equal(orchestrated.decision.usedAI, false);
	assert.equal(orchestrated.decision.skipped, true);
	assert.match(orchestrated.decision.skipReason, /repeated explicit OTA facts conflict/i);

	const originalReservationFind = Reservations.find;
	const originalReservationCreate = Reservations.create;
	const originalReservationUpdateOne = Reservations.updateOne;
	const originalHotelFind = HotelDetails.find;
	let externalCalls = 0;
	const fail = () => {
		externalCalls += 1;
		throw new Error("repeated-fact guard must stop before external lookup or write");
	};
	Reservations.find = fail;
	Reservations.create = fail;
	Reservations.updateOne = fail;
	HotelDetails.find = fail;
	try {
		for (const [intent, eventType] of [
			["new_reservation", "new"],
			["reservation_update", "modified"],
		]) {
			const result = await reconcileOtaReservation({
				...orchestrated.normalized,
				intent,
				eventType,
			});
			assert.equal(result.status, "needs_review", intent);
			assert.equal(result.actionTaken, "skipped", intent);
			assert.equal(result.skipReason, "ota_parser_requires_manual_review", intent);
		}
	} finally {
		Reservations.find = originalReservationFind;
		Reservations.create = originalReservationCreate;
		Reservations.updateOne = originalReservationUpdateOne;
		HotelDetails.find = originalHotelFind;
	}
	assert.equal(externalCalls, 0);
});

test("direct cancellation keeps hotel, stay-date, and guest-name repeated conflicts as hard stops", async () => {
	const originalReservationFind = Reservations.find;
	const originalReservationUpdateOne = Reservations.updateOne;
	let lookupCalls = 0;
	let mutationCalls = 0;
	Reservations.find = () => {
		lookupCalls += 1;
		throw new Error("identity or stay-conflicted cancellation must not query");
	};
	Reservations.updateOne = async () => {
		mutationCalls += 1;
		throw new Error("identity or stay-conflicted cancellation must not mutate");
	};
	try {
		for (const [field, first, second] of [
			["hotelName", "Hotel Alpha", "Hotel Beta"],
			["checkinDate", "August 10, 2026", "August 11, 2026"],
			["checkoutDate", "August 12, 2026", "August 13, 2026"],
			["guestName", "John Doe", "Jane Roe"],
		]) {
			const label = DIRECT_BOOKING_REPEATED_FACT_LABELS[field];
			const normalized = extractNormalizedReservation(
				makeDirectBookingRepeatedFactEmail({
					confirmationNumber: CANCELLATION_OVERRIDE_OTA_NUMBER,
					subject: `Reservation cancelled ${CANCELLATION_OVERRIDE_OTA_NUMBER}`,
					facts: { [field]: first },
					repeatedLines: [`${label}: ${second}`],
				})
			);
			assert.deepEqual(normalized.genericRepeatedFactConflictFields, [field]);
			const result = await reconcileOtaReservation(normalized);
			assert.equal(result.status, "needs_review", field);
			assert.equal(result.skipReason, "ota_parser_requires_manual_review", field);
		}
	} finally {
		Reservations.find = originalReservationFind;
		Reservations.updateOne = originalReservationUpdateOne;
	}
	assert.equal(lookupCalls, 0);
	assert.equal(mutationCalls, 0);
});

test("direct cancellation may bypass only room and amount repeated conflicts for a status-only write", async () => {
	const originalReservationFind = Reservations.find;
	const originalReservationUpdateOne = Reservations.updateOne;
	const originalHotelFind = HotelDetails.find;
	const existing = makeCancellationOverrideExisting("checked_out", {
		hotelId: "hotel-a",
		checkin_date: "2026-08-10",
		checkout_date: "2026-08-12",
		total_amount: 500,
		roomId: ["triple-a"],
		pickedRoomsType: [{ roomType: "tripleRooms" }],
	});
	let captured = null;
	Reservations.find = () => ({
		limit() {
			return this;
		},
		async exec() {
			return [existing];
		},
	});
	Reservations.updateOne = async (filter, update) => {
		captured = { filter, update };
		return { matchedCount: 1 };
	};
	HotelDetails.find = () => ({
		select() {
			return this;
		},
		async lean() {
			return [
				{
					_id: "hotel-a",
					hotelName: "Hotel Alpha",
					activateHotel: true,
					xHotelProActive: true,
				},
			];
		},
	});
	try {
		const normalized = extractNormalizedReservation(
			makeDirectBookingRepeatedFactEmail({
				confirmationNumber: CANCELLATION_OVERRIDE_OTA_NUMBER,
				subject: `Reservation cancelled ${CANCELLATION_OVERRIDE_OTA_NUMBER}`,
				repeatedLines: [
					"Room type: Double Room",
					"Total amount: SAR 700",
				],
			})
		);
		assert.deepEqual(normalized.genericRepeatedFactConflictFields, [
			"roomName",
			"amount",
		]);
		assert.equal(normalized.sourcePresence.roomName, false);
		assert.equal(normalized.sourcePresence.amount, false);
		const result = await reconcileOtaReservation(normalized);
		assert.equal(result.status, "cancelled");
		assert.ok(captured);
		assert.equal(captured.update.$set.state, "cancelled");
		assert.equal(captured.update.$set.reservation_status, "cancelled");
		for (const protectedPath of [
			"hotelId",
			"roomId",
			"pickedRoomsType",
			"total_amount",
			"room_prices",
			"supplierData.otaRoomName",
			"supplierData.otaAmount",
			"supplierData.otaAmountSar",
		]) {
			assert.equal(
				Object.prototype.hasOwnProperty.call(captured.update.$set, protectedPath),
				false,
				protectedPath
			);
		}
	} finally {
		Reservations.find = originalReservationFind;
		Reservations.updateOne = originalReservationUpdateOne;
		HotelDetails.find = originalHotelFind;
	}
});
