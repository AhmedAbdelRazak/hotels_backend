/** @format */

const assert = require("assert/strict");
const mongoose = require("mongoose");
const HotelDetails = require("../../models/hotel_details");

const {
	buildVerificationQuery,
	isPublicHotelEligible,
	syncHotelOpenAiVector,
} = require("../../services/hotelOpenAiVectorSync");
const {
	SCHEMA_VERSION,
	buildHotelKnowledgeDocument,
	normalizeRoomCapacity,
	sha256,
	stableSourcePayload,
} = require("../../services/hotelOpenAiKnowledge");
const {
	documentIsManaged,
	createHotelOpenAiKnowledgeSyncWorker,
	enqueueHotelKnowledgeSync,
	getHotelChangePaths,
	isMetadataOnlyHotelChange,
	normalizeHotelIds,
	retryDelayMs,
} = require("../../services/hotelOpenAiKnowledgeSyncWorker");

const HOTEL_ID = "6a40b6a1a6efe70450536038";
const SOURCE_UPDATED_AT = new Date("2026-07-10T10:00:00.000Z");
const COVERAGE_FROM = "2026-07-10";
const COVERAGE_THROUGH = "2026-07-12";

const queryResult = (value) => ({
	select() {
		return this;
	},
	lean() {
		return Promise.resolve(value);
	},
});

const roomFixture = () => ({
	_id: new mongoose.Types.ObjectId("6a40b6a1a6efe70450536039"),
	roomType: "doubleRooms",
	count: 5,
	displayName: "Double Room",
	displayName_OtherLanguage: "غرفة مزدوجة",
	description:
		"A comfortable room that accommodates up to 2 guests and features 2 comfortable beds.",
	description_OtherLanguage: "غرفة مريحة لشخصين.",
	amenities: ["WiFi"],
	views: ["City View"],
	extraAmenities: [],
	activeRoom: true,
	photos: ["room.jpg"],
	price: { basePrice: 100 },
	pricingRate: [],
});

const hotelFixture = ({ sourceSha256 = "old-source", status = "ready" } = {}) => ({
	_id: new mongoose.Types.ObjectId(HOTEL_ID),
	hotelName: "Test Hotel",
	hotelName_OtherLanguage: "فندق تجريبي",
	hotelCountry: "Saudi Arabia",
	hotelState: "Makkah",
	hotelCity: "Makkah",
	aboutHotel: "A test hotel near Al Haram.",
	aboutHotelArabic: "فندق تجريبي قريب من الحرم.",
	hotelAddress: "Makkah",
	hotelFloors: 2,
	hotelPhotos: ["hotel.jpg"],
	distances: { walkingToElHaram: "10 minutes", drivingToElHaram: "5 minutes" },
	hotelRating: 4,
	parkingLot: false,
	hasBusService: false,
	busDetails: "",
	hasMealsService: false,
	mealsDetails: "",
	isNusuk: false,
	isNusukText: "",
	propertyType: "Hotel",
	currency: "SAR",
	location: { type: "Point", coordinates: [39.8262, 21.4225] },
	activateHotel: true,
	xHotelProActive: true,
	updatedAt: SOURCE_UPDATED_AT,
	hotelPolicyQA: [],
	roomCountDetails: [roomFixture()],
	openaiKnowledge: {
		provider: "openai",
		autoSyncEnabled: true,
		vectorStoreId: "vs_old",
		files: [{ fileId: "file_old" }],
		sourceSha256,
		knowledgeVersion: 2,
		status,
		coverageFrom: COVERAGE_FROM,
		coverageThrough: COVERAGE_THROUGH,
	},
});

const sourceHashFor = (hotel) => {
	const document = buildHotelKnowledgeDocument({
		hotel,
		coverageFrom: COVERAGE_FROM,
		coverageThrough: COVERAGE_THROUGH,
		generatedAt: new Date("2026-07-10T11:00:00.000Z"),
		knowledgeVersion: 3,
		timezone: "Asia/Riyadh",
	});
	return sha256(JSON.stringify(stableSourcePayload(document)));
};

const knowledgeDocumentFor = (rooms, hotelOverrides = {}) => {
	const hotel = {
		...hotelFixture(),
		...hotelOverrides,
		roomCountDetails: rooms,
	};
	return buildHotelKnowledgeDocument({
		hotel,
		coverageFrom: COVERAGE_FROM,
		coverageThrough: COVERAGE_THROUGH,
		generatedAt: new Date("2026-07-10T11:00:00.000Z"),
		knowledgeVersion: 4,
		timezone: "Asia/Riyadh",
	});
};

const fakeHotelModel = ({ hotel, publishResult = undefined } = {}) => {
	const calls = { findOneAndUpdate: [] };
	return {
		calls,
		findById() {
			return queryResult(hotel);
		},
		findOneAndUpdate(filter, update, options) {
			calls.findOneAndUpdate.push({ filter, update, options });
			const value =
				publishResult === undefined
					? { _id: hotel._id, hotelName: hotel.hotelName, openaiKnowledge: update.$set }
					: publishResult;
			return queryResult(value);
		},
	};
};

const fakeOpenAiClient = ({ indexError = null, deleteError = null } = {}) => {
	const calls = { deletedStores: [], deletedFiles: [], searches: [] };
	return {
		calls,
		vectorStores: {
			create: async () => ({ id: "vs_candidate" }),
			delete: async (id) => {
				calls.deletedStores.push(id);
				if (deleteError) throw deleteError;
			},
			search: async (id, payload) => {
				calls.searches.push({ id, payload });
				return { data: [{ id: "result_1" }] };
			},
			files: {
				createAndPoll: async () => {
					if (indexError) throw indexError;
					return { id: "vs_file_candidate", status: "completed" };
				},
			},
		},
		files: {
			create: async () => ({ id: "file_candidate" }),
			delete: async (id) => {
				calls.deletedFiles.push(id);
				if (deleteError) throw deleteError;
			},
		},
	};
};

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

check("metadata-only HotelDetails updates are ignored", () => {
	const change = {
		operationType: "update",
		updateDescription: {
			updatedFields: {
				"openaiKnowledge.status": "ready",
				updatedAt: new Date(),
			},
			removedFields: [],
		},
	};
	assert.equal(isMetadataOnlyHotelChange(change), true);
	assert.deepEqual(getHotelChangePaths(change), ["openaiKnowledge.status", "updatedAt"]);
});

check("HotelDetails post-commit hooks identify exact routes and ignore vector metadata", () => {
	const helpers = HotelDetails.__knowledgeSyncTest;
	const businessPaths = helpers.hotelKnowledgeUpdatePaths({
		$set: {
			"roomCountDetails.0.pricingRate": [],
			updatedAt: new Date(),
		},
	});
	assert.deepEqual(businessPaths.sort(), ["roomCountDetails.0.pricingRate", "updatedAt"]);
	assert.equal(helpers.hotelKnowledgeMetadataOnly(businessPaths), false);
	assert.equal(
		helpers.hotelKnowledgeMetadataOnly([
			"openaiKnowledge.sourceSha256",
			"updatedAt",
		]),
		true
	);
	assert.deepEqual(helpers.exactHotelIdsFromFilter({ _id: HOTEL_ID }), [HOTEL_ID]);
});

check("a mixed room update is never hidden as metadata-only", () => {
	const change = {
		operationType: "update",
		updateDescription: {
			updatedFields: {
				"openaiKnowledge.status": "ready",
				"roomCountDetails.0.pricingRate": [],
			},
		},
	};
	assert.equal(isMetadataOnlyHotelChange(change), false);
});

check("managed gating is explicit and does not enroll unrelated hotels", () => {
	assert.equal(documentIsManaged({ _id: HOTEL_ID }, new Set()), false);
	assert.equal(
		documentIsManaged(
			{ _id: HOTEL_ID, openaiKnowledge: { vectorStoreId: "vs_legacy" } },
			new Set()
		),
		false
	);
	assert.equal(
		documentIsManaged(
			{ _id: HOTEL_ID, openaiKnowledge: { autoSyncEnabled: true } },
			new Set()
		),
		true
	);
	assert.equal(documentIsManaged({ _id: HOTEL_ID }, normalizeHotelIds(HOTEL_ID)), true);
});

check("the public-list eligibility gate matches active hotel requirements", () => {
	const hotel = hotelFixture();
	assert.equal(isPublicHotelEligible(hotel), true);
	hotel.location.coordinates = [0, 0];
	assert.equal(isPublicHotelEligible(hotel), false);
});

check("verification is hotel-neutral", () => {
	const query = buildVerificationQuery({
		hotelId: HOTEL_ID,
		hotel: { name: { en: "Test Hotel" } },
		rooms: [{ displayName: { en: "Double Room" } }],
	});
	assert.match(query, /Test Hotel/);
	assert.match(query, /Double Room/);
	assert.doesNotMatch(query, /Zad Ajyad|six guests/i);
});

check("generated hotel facts contain no Zad-specific surroundings", () => {
	const hotel = hotelFixture();
	const document = buildHotelKnowledgeDocument({
		hotel,
		coverageFrom: COVERAGE_FROM,
		coverageThrough: COVERAGE_THROUGH,
		generatedAt: new Date("2026-07-10T11:00:00.000Z"),
		knowledgeVersion: 3,
	});
	const serialized = JSON.stringify(document);
	assert.doesNotMatch(serialized, /Al Shohada|1,500 meters|Zad Ajyad/i);
});

check("fleet room capacities keep guest capacity and physical beds separate", () => {
	const single = normalizeRoomCapacity({
		roomType: "singleRooms",
		displayName: "Single Room - Private Comfort",
		description: "Perfect for one guest with a cozy bed.",
		bedsCount: 1,
	});
	assert.equal(single.maxGuests, 1);
	assert.equal(single.bedCount, 1);
	assert.equal(single.eligibleForCapacityRecommendation, true);

	const twin = normalizeRoomCapacity({
		roomType: "doubleRooms",
		displayName: "Twin Room",
		description: "Perfect for two guests, featuring two cozy beds.",
		bedsCount: 1,
	});
	assert.equal(twin.maxGuests, 2);
	assert.equal(twin.bedCount, 2);

	const oneDoubleBed = normalizeRoomCapacity({
		roomType: "doubleRooms",
		displayName: "Double Room",
		description: "Comfortable room with one double bed for two guests.",
		bedsCount: 1,
	});
	assert.equal(oneDoubleBed.maxGuests, 2);
	assert.equal(oneDoubleBed.bedCount, 1);

	const sextuple = normalizeRoomCapacity({
		roomType: "familyRooms",
		displayName: "Sextuple Room - Maximum Capacity",
		description: "Offers six beds for a large family.",
		bedsCount: 1,
	});
	assert.equal(sextuple.maxGuests, 6);
	assert.equal(sextuple.bedCount, 6);

	const misleadingDoubleDescription = normalizeRoomCapacity({
		roomType: "doubleRooms",
		displayName: "Double Room - Spacious Double",
		description: "Accommodates up to six guests for large families.",
		bedsCount: 1,
	});
	assert.equal(misleadingDoubleDescription.maxGuests, 2);
	assert.equal(misleadingDoubleDescription.maxGuestsSource, "display_name");

	const misleadingQuadDescription = normalizeRoomCapacity({
		roomType: "quadRooms",
		displayName: "Quad Room 4 Beds",
		description: "Family room featuring 7 cozy beds.",
		bedsCount: 1,
	});
	assert.equal(misleadingQuadDescription.maxGuests, 4);
	assert.equal(misleadingQuadDescription.bedCount, 4);

	const fiveGuestFamily = normalizeRoomCapacity({
		roomType: "familyRooms",
		displayName: "Spacious Family Room for 5 Guests",
		description: "The room features five comfortable beds.",
		bedsCount: 1,
	});
	assert.equal(fiveGuestFamily.maxGuests, 5);
	assert.equal(fiveGuestFamily.bedCount, 5);

	const sixGuestFamily = normalizeRoomCapacity({
		roomType: "familyRooms",
		displayName: "Sextuple Room - Together in Comfort",
		description: "Large room for six guests, ideal for big families.",
		bedsCount: 1,
	});
	assert.equal(sixGuestFamily.maxGuests, 6);
	assert.equal(sixGuestFamily.bedCount, null);

	const suite = normalizeRoomCapacity({
		roomType: "familyRooms",
		displayName: "Two-Bedroom Suite",
		description: "Accommodates up to 6 guests.",
		bedsCount: 1,
	});
	assert.equal(suite.maxGuests, 6);
	assert.equal(suite.bedCount, null);
	assert.equal(suite.eligibleForCapacityRecommendation, true);
});

check("bilingual capacity parsing and ambiguous family rooms fail closed", () => {
	const arabic = normalizeRoomCapacity({
		roomType: "familyRooms",
		displayName: "\u063a\u0631\u0641\u0629 \u0633\u062f\u0627\u0633\u064a\u0629",
		description:
			"\u062a\u062a\u0633\u0639 \u0644\u0633\u062a\u0629 \u0623\u0634\u062e\u0627\u0635 \u0648\u062a\u0636\u0645 \u0633\u062a\u0629 \u0623\u0633\u0631\u0629",
		bedsCount: 1,
	});
	assert.equal(arabic.maxGuests, 6);
	assert.equal(arabic.bedCount, 6);
	const arabicNameOnly = normalizeRoomCapacity({
		roomType: "familyRooms",
		displayName_OtherLanguage: "\u063a\u0631\u0641\u0629 \u062e\u0645\u0627\u0633\u064a\u0629",
		description: "A comfortable family stay.",
		bedsCount: 1,
	});
	assert.equal(arabicNameOnly.maxGuests, 5);
	assert.equal(arabicNameOnly.bedCount, null);

	const ambiguous = normalizeRoomCapacity({
		roomType: "familyRooms",
		displayName: "Family Room - Luxe",
		description: "A serene family retreat with a private bathroom.",
		bedsCount: 1,
	});
	assert.equal(ambiguous.maxGuests, null);
	assert.equal(ambiguous.capacityStatus, "unknown_requires_management_review");
	assert.equal(ambiguous.eligibleForCapacityRecommendation, false);
	assert.match(ambiguous.capacityClarification, /Do not infer/i);
});

check("individual-bed rooms use per-bed pricing and declared sellable bed inventory", () => {
	const sharedRoom = {
		...roomFixture(),
		_id: new mongoose.Types.ObjectId("6a40b6a1a6efe70450536040"),
		roomType: "individualBed",
		count: 2,
		displayName: "Shared Room - Women Only",
		description: "Six-bed shared room for women only.",
		bedsCount: 6,
		roomForGender: "Female",
		price: { basePrice: 15 },
	};
	const document = knowledgeDocumentFor([sharedRoom]);
	const room = document.rooms[0];
	assert.equal(room.pricingUnit, "per_bed_per_night");
	assert.equal(room.maxGuests, 1);
	assert.equal(room.maxGuestsPerUnit, 1);
	assert.equal(room.sharedRoomBedCount, 6);
	assert.equal(room.physicalRoomCount, 2);
	assert.equal(room.totalSellableUnits, 12);
	assert.equal(document.inventorySummary.totalPhysicalRooms, 2);
	assert.equal(document.inventorySummary.totalSellableUnits, 12);

	const unknownSharedInventory = normalizeRoomCapacity({
		roomType: "individualBed",
		displayName: "Shared Room",
		description: "Shared accommodation.",
		bedsCount: 1,
	});
	assert.equal(unknownSharedInventory.sharedRoomBedCount, null);
	assert.equal(unknownSharedInventory.eligibleForCapacityRecommendation, false);
});

check("knowledge inventory supports physical-count allocation across room variants", () => {
	const doubles = { ...roomFixture(), count: 5 };
	const triples = {
		...roomFixture(),
		_id: new mongoose.Types.ObjectId("6a40b6a1a6efe70450536041"),
		roomType: "tripleRooms",
		count: 4,
		displayName: "Triple Room",
		description: "Accommodates up to 3 guests and features 3 beds.",
	};
	const document = knowledgeDocumentFor([doubles, triples]);
	assert.equal(document.rooms[0].totalRooms, 5);
	assert.equal(document.rooms[0].pricingUnit, "per_room_per_night");
	assert.equal(document.inventorySummary.totalPhysicalRooms, 9);
	assert.equal(document.inventorySummary.totalSellableUnits, 9);
	const doubleType = document.inventorySummary.byRoomType.find(
		(entry) => entry.roomType === "doubleRooms"
	);
	assert.equal(doubleType.physicalRoomCount, 5);
	assert.match(document.inventorySummary.allocationRule, /ten double rooms/i);
	assert.match(document.inventorySummary.allocationRule, /only five exist/i);

	const legacyAlias = knowledgeDocumentFor([
		{
			...triples,
			roomType: "twinRooms",
			displayName: "Triple Room - Comfort",
		},
	]);
	assert.equal(legacyAlias.rooms[0].roomType, "tripleRooms");
	assert.equal(legacyAlias.rooms[0].sourcePmsRoomType, "twinRooms");
	assert.equal(legacyAlias.inventorySummary.byRoomType[0].roomType, "tripleRooms");
});

check("blackout-only availability, base fallback and room-only meals are explicit", () => {
	const room = {
		...roomFixture(),
		count: 5,
		amenities: ["WiFi", "Restaurant"],
		pricingRate: [
			{ calendarDate: COVERAGE_FROM, price: 120 },
			{ calendarDate: "2026-07-11", price: 0, color: "black" },
		],
	};
	const document = knowledgeDocumentFor([room], {
		hasMealsService: true,
		mealsDetails: "Breakfast and dinner",
	});
	assert.equal(document.schemaVersion, SCHEMA_VERSION);
	assert.equal(document.availabilityRules.mode, "blackout_only");
	assert.equal(document.availabilityRules.reservationOccupancyConsidered, false);
	assert.equal(document.availabilityRules.reservationHistoryConsidered, false);
	assert.equal(document.availabilityRules.outsideCoverage, "unavailable");
	assert.equal(
		document.availabilityRules.missingCalendarRowWithinCoverage,
		"available_at_exact_room_base_price_unless_explicitly_blocked"
	);
	assert.equal("missingOrAfterCoverage" in document.availabilityRules, false);
	assert.deepEqual(document.rooms[0].blockedDates, ["2026-07-11"]);
	assert.equal(document.rooms[0].monthlyAverageRates[0].estimatedAverageNightlyRate, 110);
	assert.match(document.priceRules.calculation, /effective guest nightly rate/i);
	assert.match(document.priceRules.calculation, /room\.price\.basePrice exactly/i);
	assert.equal(document.hotel.services.mealPlan.available, false);
	assert.equal(document.hotel.services.mealPlan.included, false);
	assert.equal(document.hotel.services.mealPlan.bookingBasis, "room_only");
	assert.equal(document.hotel.services.mealPlan.details, "");
	assert.match(document.hotel.services.mealPlan.instruction, /Never promise breakfast/i);
	assert.doesNotMatch(JSON.stringify(document), /Breakfast and dinner/);
});

check("retry backoff is bounded and increasing", () => {
	assert.equal(retryDelayMs(1, () => 0), 15_000);
	assert.equal(retryDelayMs(2, () => 0), 60_000);
	assert.equal(retryDelayMs(99, () => 0), 60 * 60_000);
});

check("rapid queue requests use one hotel upsert and increment a generation", async () => {
	const calls = [];
	const JobModel = {
		findOneAndUpdate(filter, update, options) {
			calls.push({ filter, update, options });
			return queryResult({ hotelId: HOTEL_ID });
		},
	};
	await enqueueHotelKnowledgeSync({
		hotelId: HOTEL_ID,
		reason: "calendar",
		paths: ["roomCountDetails.0.pricingRate"],
		now: new Date("2026-07-10T00:00:00.000Z"),
		JobModel,
	});
	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0].filter, { hotelId: HOTEL_ID });
	assert.equal(calls[0].update.$inc.generation, 1);
	assert.equal(calls[0].update.$set.status, "pending");
	assert.equal(calls[0].options.upsert, true);
});

check("reconciliation does not erase a persistent failure counter", async () => {
	let captured = null;
	const JobModel = {
		findOneAndUpdate(_filter, update) {
			captured = update;
			return queryResult({ hotelId: HOTEL_ID });
		},
	};
	await enqueueHotelKnowledgeSync({
		hotelId: HOTEL_ID,
		reason: "periodic_reconciliation",
		resetFailures: false,
		JobModel,
	});
	assert.equal(Object.prototype.hasOwnProperty.call(captured.$set, "consecutiveFailures"), false);
	assert.equal(Object.prototype.hasOwnProperty.call(captured.$set, "lastError"), false);
});

check("expired processing leases are reclaimable for sync and cleanup", async () => {
	const captured = {};
	const JobModel = {
		findOneAndUpdate(filter) {
			captured.sync = filter;
			return queryResult(null);
		},
	};
	const CleanupModel = {
		findOneAndUpdate(filter) {
			captured.cleanup = filter;
			return queryResult(null);
		},
	};
	const worker = createHotelOpenAiKnowledgeSyncWorker({
		JobModel,
		CleanupModel,
		openAiClient: fakeOpenAiClient(),
	});
	assert.equal(await worker.runOneCycle(), false);
	assert.ok(captured.sync.status.$in.includes("processing"));
	assert.ok(captured.cleanup.status.$in.includes("processing"));
});

check("dry-run unchanged is strictly read-only", async () => {
	const hotel = hotelFixture();
	hotel.openaiKnowledge.sourceSha256 = sourceHashFor(hotel);
	const HotelModel = fakeHotelModel({ hotel });
	const result = await syncHotelOpenAiVector({
		hotelId: HOTEL_ID,
		coverageFrom: COVERAGE_FROM,
		coverageThrough: COVERAGE_THROUGH,
		dryRun: true,
		HotelModel,
		now: new Date("2026-07-10T11:00:00.000Z"),
	});
	assert.equal(result.status, "unchanged");
	assert.equal(result.fileId, "file_old");
	assert.equal(HotelModel.calls.findOneAndUpdate.length, 0);
});

check("dry-run retirement is strictly read-only", async () => {
	const hotel = hotelFixture();
	hotel.activateHotel = false;
	const HotelModel = fakeHotelModel({ hotel });
	const result = await syncHotelOpenAiVector({
		hotelId: HOTEL_ID,
		coverageThrough: COVERAGE_THROUGH,
		dryRun: true,
		HotelModel,
	});
	assert.equal(result.status, "dry_run");
	assert.equal(result.action, "retire");
	assert.equal(HotelModel.calls.findOneAndUpdate.length, 0);
});

check("indexing failure cleans only the candidate and never publishes", async () => {
	const hotel = hotelFixture();
	const HotelModel = fakeHotelModel({ hotel });
	const client = fakeOpenAiClient({ indexError: new Error("index failed") });
	await assert.rejects(
		syncHotelOpenAiVector({
			hotelId: HOTEL_ID,
			coverageFrom: COVERAGE_FROM,
			coverageThrough: COVERAGE_THROUGH,
			HotelModel,
			client,
			now: new Date("2026-07-10T11:00:00.000Z"),
		}),
		/index failed/
	);
	assert.equal(HotelModel.calls.findOneAndUpdate.length, 0);
	assert.deepEqual(client.calls.deletedStores, ["vs_candidate"]);
	assert.deepEqual(client.calls.deletedFiles, ["file_candidate"]);
	assert.doesNotMatch(client.calls.deletedStores.join(" "), /vs_old/);
});

check("stale CAS refuses publication and cleans the candidate", async () => {
	const hotel = hotelFixture();
	const HotelModel = fakeHotelModel({ hotel, publishResult: null });
	const client = fakeOpenAiClient();
	await assert.rejects(
		syncHotelOpenAiVector({
			hotelId: HOTEL_ID,
			coverageFrom: COVERAGE_FROM,
			coverageThrough: COVERAGE_THROUGH,
			HotelModel,
			client,
			now: new Date("2026-07-10T11:00:00.000Z"),
		}),
		/refusing to publish a stale vector/
	);
	assert.equal(HotelModel.calls.findOneAndUpdate.length, 1);
	assert.deepEqual(client.calls.deletedStores, ["vs_candidate"]);
	assert.deepEqual(client.calls.deletedFiles, ["file_candidate"]);
});

check("failed immediate deletion is handed to durable guarded cleanup", async () => {
	const hotel = hotelFixture();
	const HotelModel = fakeHotelModel({ hotel, publishResult: null });
	const client = fakeOpenAiClient({ deleteError: new Error("delete unavailable") });
	let caught = null;
	try {
		await syncHotelOpenAiVector({
			hotelId: HOTEL_ID,
			coverageFrom: COVERAGE_FROM,
			coverageThrough: COVERAGE_THROUGH,
			HotelModel,
			client,
			now: new Date("2026-07-10T11:00:00.000Z"),
		});
	} catch (error) {
		caught = error;
	}
	assert.ok(caught);
	assert.equal(caught.candidateResources.vectorStoreId, "vs_candidate");
	assert.equal(caught.candidateResources.fileId, "file_candidate");
});

check("an ambiguous Mongo publish never deletes a possibly active candidate", async () => {
	const hotel = hotelFixture();
	let findCount = 0;
	const HotelModel = {
		findById() {
			findCount += 1;
			return queryResult(
				findCount === 1
					? hotel
					: {
							_id: hotel._id,
							openaiKnowledge: { vectorStoreId: "vs_candidate", status: "ready" },
					  }
			);
		},
		findOneAndUpdate() {
			return {
				select() {
					return this;
				},
				lean() {
					return Promise.reject(new Error("Mongo reply was lost"));
				},
			};
		},
	};
	const client = fakeOpenAiClient();
	await assert.rejects(
		syncHotelOpenAiVector({
			hotelId: HOTEL_ID,
			coverageFrom: COVERAGE_FROM,
			coverageThrough: COVERAGE_THROUGH,
			HotelModel,
			client,
			now: new Date("2026-07-10T11:00:00.000Z"),
		}),
		/Mongo reply was lost/
	);
	assert.deepEqual(client.calls.deletedStores, []);
	assert.deepEqual(client.calls.deletedFiles, []);
});

check("an unconfirmable publish defers guarded cleanup instead of deleting immediately", async () => {
	const hotel = hotelFixture();
	let findCount = 0;
	const HotelModel = {
		findById() {
			findCount += 1;
			if (findCount === 1) return queryResult(hotel);
			return {
				select() {
					return this;
				},
				lean() {
					return Promise.reject(new Error("Mongo unavailable"));
				},
			};
		},
		findOneAndUpdate() {
			return {
				select() {
					return this;
				},
				lean() {
					return Promise.reject(new Error("Mongo reply was lost"));
				},
			};
		},
	};
	const client = fakeOpenAiClient();
	let caught = null;
	try {
		await syncHotelOpenAiVector({
			hotelId: HOTEL_ID,
			coverageFrom: COVERAGE_FROM,
			coverageThrough: COVERAGE_THROUGH,
			HotelModel,
			client,
			now: new Date("2026-07-10T11:00:00.000Z"),
		});
	} catch (error) {
		caught = error;
	}
	assert.ok(caught);
	assert.equal(caught.candidateResources.vectorStoreId, "vs_candidate");
	assert.equal(caught.candidateResources.fileId, "file_candidate");
	assert.deepEqual(client.calls.deletedStores, []);
	assert.deepEqual(client.calls.deletedFiles, []);
});

check("post-publish failure cannot delete the newly active vector", async () => {
	const hotel = hotelFixture();
	const HotelModel = fakeHotelModel({ hotel });
	const client = fakeOpenAiClient();
	const result = await syncHotelOpenAiVector({
		hotelId: HOTEL_ID,
		coverageFrom: COVERAGE_FROM,
		coverageThrough: COVERAGE_THROUGH,
		HotelModel,
		client,
		now: new Date("2026-07-10T11:00:00.000Z"),
		onPublished: async () => {
			throw new Error("cache invalidation failed");
		},
		logger: { error() {} },
	});
	assert.equal(result.status, "ready");
	assert.match(result.postPublishError, /cache invalidation failed/);
	assert.deepEqual(client.calls.deletedStores, []);
	assert.deepEqual(client.calls.deletedFiles, []);
	assert.equal(result.previousResources.vectorStoreId, "vs_old");
});

const main = async () => {
	let passed = 0;
	for (const item of checks) {
		await item.fn();
		passed += 1;
		console.log(`PASS ${item.name}`);
	}
	console.log(`\n${passed} hotel OpenAI sync checks passed.`);
};

if (require.main === module) {
	main().catch((error) => {
		console.error("FAIL", error);
		process.exitCode = 1;
	});
}

module.exports = { main };
