/** @format */

const test = require("node:test");
const assert = require("node:assert/strict");
const {
	CREDENTIAL_FAILURE_HOLD_MS,
	HISTORY_INITIAL_LOOKBACK_DAYS,
	HISTORY_OVERLAP_DAYS,
	HISTORY_PAGE_OVERLAP,
	MAX_HISTORY_PAGES_PER_CYCLE,
	NON_RETRYABLE_FAILURE_DELAY_MS,
	createHotelRunnerPullSync,
	requeueResolvedStaleMappingEvents,
	renewPullLease,
	saveRoomList,
} = require("./hotelrunnerPullSync");

const HOTEL_ID = "64b000000000000000000001";
const addDays = (date, days) =>
	new Date(date.getTime() + days * 24 * 60 * 60 * 1000);

function queryResult(getValue) {
	return {
		select() {
			return this;
		},
		lean() {
			return this;
		},
		exec() {
			return Promise.resolve().then(getValue);
		},
		then(resolve, reject) {
			return Promise.resolve().then(getValue).then(resolve, reject);
		},
	};
}

function getDotted(target, path) {
	return String(path)
		.split(".")
		.reduce((current, part) => current?.[part], target);
}

function setDotted(target, path, value) {
	const parts = String(path).split(".");
	let cursor = target;
	for (const part of parts.slice(0, -1)) {
		if (!cursor[part] || typeof cursor[part] !== "object") cursor[part] = {};
		cursor = cursor[part];
	}
	cursor[parts.at(-1)] = value;
}

function deleteDotted(target, path) {
	const parts = String(path).split(".");
	let cursor = target;
	for (const part of parts.slice(0, -1)) {
		if (!cursor?.[part]) return;
		cursor = cursor[part];
	}
	delete cursor[parts.at(-1)];
}

function applyUpdate(target, update = {}) {
	for (const [path, value] of Object.entries(update.$setOnInsert || {})) {
		if (getDotted(target, path) === undefined) setDotted(target, path, value);
	}
	for (const [path, value] of Object.entries(update.$set || {})) {
		setDotted(target, path, value);
	}
	for (const [path, value] of Object.entries(update.$inc || {})) {
		setDotted(target, path, Number(getDotted(target, path) || 0) + Number(value || 0));
	}
	for (const path of Object.keys(update.$unset || {})) deleteDotted(target, path);
}

function createSyncStateModel(initialState = null) {
	let state = initialState ? { ...initialState } : null;
	const writes = [];
	let sequence = 0;
	return {
		writes,
		get state() {
			return state;
		},
		findOne(filter) {
			return queryResult(() =>
				state && String(state.hotelId) === String(filter.hotelId) ? state : null
			);
		},
		updateOne(filter, update, options = {}) {
			return queryResult(() => {
				writes.push({ operation: "updateOne", filter, update, options });
				if (!state && options.upsert) {
					state = { _id: `sync-state-${++sequence}` };
				}
				if (!state) return { matchedCount: 0 };
				if (filter._id && String(filter._id) !== String(state._id)) {
					return { matchedCount: 0 };
				}
				if (filter.leaseOwner && filter.leaseOwner !== state.leaseOwner) {
					return { matchedCount: 0 };
				}
				if (
					filter.projectionLeaseOwner &&
					filter.projectionLeaseOwner !== state.projectionLeaseOwner
				) {
					return { matchedCount: 0 };
				}
				applyUpdate(state, update);
				return { matchedCount: 1 };
			});
		},
		findOneAndUpdate(filter, update) {
			return queryResult(() => {
				writes.push({ operation: "findOneAndUpdate", filter, update });
				if (!state || String(state.hotelId) !== String(filter.hotelId)) return null;
				const projectionLease = Boolean(
					update.$set?.projectionLeaseOwner
				);
				const leaseUntilField = projectionLease
					? "projectionLeaseUntil"
					: "leaseUntil";
				const leaseOwnerField = projectionLease
					? "projectionLeaseOwner"
					: "leaseOwner";
				const now = filter.$or
					?.map((condition) => condition[leaseUntilField]?.$lte)
					.find(Boolean);
				const leaseAvailable =
					!state[leaseUntilField] ||
					(now && new Date(state[leaseUntilField]) <= new Date(now)) ||
					state[leaseOwnerField] === update.$set?.[leaseOwnerField];
				if (!leaseAvailable) return null;
				applyUpdate(state, update);
				return state;
			});
		},
	};
}

function createEventModel() {
	const events = new Map();
	const updateManyWrites = [];
	let sequence = 0;
	return {
		events,
		updateManyWrites,
		findOneAndUpdate(filter, update) {
			return queryResult(() => {
				let event = events.get(filter.eventKey);
				if (!event) {
					event = {
						_id: `event-${++sequence}`,
						deliveryCount: 0,
						...update.$setOnInsert,
					};
					events.set(filter.eventKey, event);
				}
				applyUpdate(event, update);
				return event;
			});
		},
		updateOne(filter, update) {
			return queryResult(() => {
				const event = [...events.values()].find(
					(candidate) => String(candidate._id) === String(filter._id)
				);
				if (event) applyUpdate(event, update);
				return { matchedCount: event ? 1 : 0 };
			});
		},
		updateMany(filter, update) {
			return queryResult(() => {
				updateManyWrites.push({ filter, update });
				return { matchedCount: 0, modifiedCount: 0 };
			});
		},
	};
}

function mappingMatches(document, filter = {}) {
	if (
		filter.hotelId !== undefined &&
		String(document.hotelId) !== String(filter.hotelId)
	) {
		return false;
	}
	if (filter.invCode !== undefined && document.invCode !== filter.invCode) {
		return false;
	}
	if (typeof filter.status === "string" && document.status !== filter.status) {
		return false;
	}
	if (
		filter.roomListSyncGeneration?.$ne !== undefined &&
		document.roomListSyncGeneration === filter.roomListSyncGeneration.$ne
	) {
		return false;
	}
	return true;
}

function createMappingModel(initialMappings = []) {
	const writes = [];
	const bulkWrites = [];
	const documents = initialMappings.map((mapping) => ({ ...mapping }));
	return {
		writes,
		bulkWrites,
		documents,
		find(filter) {
			return queryResult(() =>
				documents.filter((document) => mappingMatches(document, filter))
			);
		},
		updateMany(filter, update) {
			return queryResult(() => {
				bulkWrites.push({ filter, update });
				let matchedCount = 0;
				for (const document of documents) {
					if (!mappingMatches(document, filter)) continue;
					applyUpdate(document, update);
					matchedCount += 1;
				}
				return { matchedCount };
			});
		},
		findOneAndUpdate(filter, update, options = {}) {
			return queryResult(() => {
				writes.push({ filter, update });
				let document = documents.find((candidate) =>
					mappingMatches(candidate, filter)
				);
				if (!document && options.upsert) {
					document = { ...filter };
					documents.push(document);
				}
				if (!document) return null;
				applyUpdate(document, update);
				return document;
			});
		},
	};
}

function syntheticConfig(overrides = {}) {
	return {
		configured: true,
		hotelId: HOTEL_ID,
		hrIdFingerprint: "synthetic-hr-fingerprint",
		credentialFingerprint: "credential-fingerprint-a",
		callbackMaxReservations: 100,
		pullEnabled: true,
		pullIntervalMinutes: 30,
		roomListSyncEnabled: true,
		roomListIntervalHours: 24,
		...overrides,
	};
}

function cancellationRows(page, count = 50) {
	return Array.from({ length: count }, (_, index) => ({
		message_uid: `page-${page}-message-${index}`,
		reservation_id: `page-${page}-reservation-${index}`,
		state: "canceled",
		updated_at: "2026-08-06T00:00:00.000Z",
	}));
}

function testDependencies({ SyncStateModel, createClient, MappingModel, EventModel } = {}) {
	const hotel = {
		_id: HOTEL_ID,
		belongsTo: "64b000000000000000000002",
		activateHotel: true,
		xHotelProActive: true,
		currency: "SAR",
		roomCountDetails: [],
	};
	return {
		SyncStateModel,
		MappingModel: MappingModel || createMappingModel(),
		EventModel: EventModel || createEventModel(),
		createClient,
		skipIndexInitialization: true,
		random: () => 0.5,
		HotelModel: {
			findOne: () => queryResult(() => hotel),
		},
	};
}

test("history cursor persists after three pages, resumes next page, then advances with overlap", async () => {
	const SyncStateModel = createSyncStateModel();
	const EventModel = createEventModel();
	const MappingModel = createMappingModel();
	const clientCycles = [];
	const createClient = () => {
		const calls = [];
		clientCycles.push(calls);
		return {
			async getRooms() {
				calls.push({ operation: "rooms" });
				return {
					rooms: [
						{
							inv_code: "INV-DOUBLE",
							rate_code: "BAR",
							name: "Double Room",
						},
					],
				};
			},
			async retrieveReservations(options) {
				calls.push({ operation: "reservations", options });
				return {
					reservations: cancellationRows(options.page),
					pages: 5,
				};
			},
		};
	};
	const config = syntheticConfig();
	const dependencies = testDependencies({
		SyncStateModel,
		EventModel,
		MappingModel,
		createClient,
	});
	const sync = createHotelRunnerPullSync({
		config,
		instanceId: "pull-worker-1",
		dependencies,
	});
	const firstNow = new Date(Date.now() + 60 * 60_000);
	const first = await sync.runIfDue(firstNow);

	assert.equal(MAX_HISTORY_PAGES_PER_CYCLE, 3);
	assert.equal(first.status, "completed");
	assert.equal(first.backlog, true);
	assert.equal(first.processed, 150);
	assert.deepEqual(
		clientCycles[0]
			.filter((call) => call.operation === "reservations")
			.map((call) => call.options.page),
		[1, 2, 3]
	);
	assert.equal(HISTORY_PAGE_OVERLAP, 1);
	assert.equal(SyncStateModel.state.historyCursorPage, 3);
	assert.equal(
		SyncStateModel.state.historyCursorFrom.toISOString(),
		addDays(firstNow, -HISTORY_INITIAL_LOOKBACK_DAYS).toISOString()
	);
	assert.equal(HISTORY_INITIAL_LOOKBACK_DAYS, 29);
	assert.equal(
		SyncStateModel.state.historyCycleStartedAt.toISOString(),
		firstNow.toISOString()
	);
	const firstFromDate = clientCycles[0]
		.find((call) => call.operation === "reservations")
		.options.fromLastUpdateDate;
	assert.equal(
		firstFromDate,
		addDays(firstNow, -HISTORY_INITIAL_LOOKBACK_DAYS).toISOString().slice(0, 10)
	);

	const secondNow = new Date(SyncStateModel.state.nextPullAt.getTime() + 1);
	const second = await sync.runIfDue(secondNow);
	assert.equal(second.status, "completed");
	assert.equal(second.backlog, false);
	assert.equal(second.processed, 150);
	assert.deepEqual(
		clientCycles[1]
			.filter((call) => call.operation === "reservations")
			.map((call) => call.options.page),
		[3, 4, 5]
	);
	assert.equal(
		clientCycles[1]
			.filter((call) => call.operation === "reservations")
			.every((call) => call.options.fromLastUpdateDate === firstFromDate),
		true
	);
	assert.equal(SyncStateModel.state.historyCursorPage, 1);
	assert.equal(SyncStateModel.state.historyCycleStartedAt, null);
	assert.equal(HISTORY_OVERLAP_DAYS, 2);
	assert.equal(
		SyncStateModel.state.historyCursorFrom.toISOString(),
		addDays(firstNow, -HISTORY_OVERLAP_DAYS).toISOString()
	);
	assert.equal(
		clientCycles.flatMap((cycle) =>
			cycle.filter((call) => call.operation === "reservations")
		).length,
		6
	);
	assert.equal(clientCycles[1].some((call) => call.operation === "rooms"), false);
	assert.equal(SyncStateModel.state.metrics.pulls, 2);
	assert.equal(SyncStateModel.state.metrics.eventsReceived, 300);
	assert.equal(EventModel.events.size, 250);
	assert.ok(
		SyncStateModel.writes.filter(
			(write) => write.update?.$set?.leaseUntil && write.filter?.leaseOwner
		).length >= 6,
		"long pull work should renew the lease around network and persistence stages"
	);
});

test("explicit room-list discovery makes exactly one vendor call and never retrieves reservations", async () => {
	const SyncStateModel = createSyncStateModel();
	const MappingModel = createMappingModel();
	let roomCalls = 0;
	let reservationCalls = 0;
	const sync = createHotelRunnerPullSync({
		config: syntheticConfig({ pullEnabled: false }),
		instanceId: "room-list-only-bootstrap",
		dependencies: testDependencies({
			SyncStateModel,
			MappingModel,
			createClient: () => ({
				async getRooms() {
					roomCalls += 1;
					return {
						rooms: [
							{
								inv_code: "INV-BOOTSTRAP",
								rate_code: "BAR",
								name: "Bootstrap Room",
								sales_currency: "SAR",
							},
						],
					};
				},
				async retrieveReservations() {
					reservationCalls += 1;
					throw new Error("room-list-only discovery must not retrieve reservations");
				},
			}),
		}),
	});
	const now = new Date(Date.now() + 60 * 60_000);
	const result = await sync.runRoomListOnly(now);
	assert.deepEqual(result, {
		status: "completed",
		roomMappingsSeen: 1,
		apiCalls: 1,
	});
	assert.equal(roomCalls, 1);
	assert.equal(reservationCalls, 0);
	assert.equal(MappingModel.writes.length, 1);
	assert.equal(SyncStateModel.state.historyCursorFrom == null, true);
	assert.equal(Number(SyncStateModel.state.historyCursorPage || 1), 1);
	assert.equal(SyncStateModel.state.metrics.roomListPulls, 1);
	assert.ok(SyncStateModel.state.lastRoomListStartedAt instanceof Date);
	assert.ok(SyncStateModel.state.lastRoomListCompletedAt instanceof Date);
	assert.equal(
		SyncStateModel.state.activeRoomListSyncGeneration,
		MappingModel.documents[0].roomListSyncGeneration
	);
	assert.ok(SyncStateModel.state.activeRoomListPublishedAt instanceof Date);
	assert.equal(SyncStateModel.state.projectionLeaseOwner, undefined);

	const held = await sync.runRoomListOnly(
		new Date(SyncStateModel.state.lastRoomListCompletedAt.getTime() + 60_000)
	);
	assert.deepEqual(held, { status: "not_due", apiCalls: 0 });
	assert.equal(roomCalls, 1);
	assert.equal(reservationCalls, 0);
});

test("a successful room-list refresh is persisted even when reservation history fails", async () => {
	const SyncStateModel = createSyncStateModel();
	const MappingModel = createMappingModel();
	const failure = new Error("synthetic reservation pull failure");
	failure.code = "HOTELRUNNER_API_NETWORK_ERROR";
	failure.retryable = true;
	const createClient = () => ({
		async getRooms() {
			return {
				rooms: [
					{ inv_code: "INV-TRIPLE", rate_code: "BAR", name: "Triple Room" },
				],
			};
		},
		async retrieveReservations() {
			throw failure;
		},
	});
	const dependencies = testDependencies({
		SyncStateModel,
		MappingModel,
		createClient,
	});
	const sync = createHotelRunnerPullSync({
		config: syntheticConfig(),
		instanceId: "pull-worker-room-success",
		dependencies,
	});

	await assert.rejects(
		sync.runIfDue(new Date(Date.now() + 60 * 60_000)),
		(error) => error === failure
	);
	assert.equal(MappingModel.writes.length, 1);
	assert.equal(SyncStateModel.state.status, "retry");
	assert.ok(SyncStateModel.state.lastRoomListSyncAt instanceof Date);
	assert.ok(SyncStateModel.state.nextRoomListSyncAt instanceof Date);
	assert.equal(
		SyncStateModel.state.activeRoomListSyncGeneration,
		MappingModel.documents[0].roomListSyncGeneration
	);
	assert.ok(SyncStateModel.state.activeRoomListPublishedAt instanceof Date);
	assert.equal(
		SyncStateModel.state.nextRoomListSyncAt.getTime() -
			SyncStateModel.state.lastRoomListSyncAt.getTime(),
		24 * 60 * 60 * 1000
	);
	assert.equal(SyncStateModel.state.lastErrorCode, "HOTELRUNNER_API_NETWORK_ERROR");
	assert.equal(SyncStateModel.state.metrics.pullFailures, 1);
});

test("history pull does not spend a room-list call when room-list sync is disabled", async () => {
	const SyncStateModel = createSyncStateModel();
	let roomCalls = 0;
	let historyCalls = 0;
	const sync = createHotelRunnerPullSync({
		config: syntheticConfig({ roomListSyncEnabled: false }),
		instanceId: "pull-worker-history-only",
		dependencies: testDependencies({
			SyncStateModel,
			createClient: () => ({
				async getRooms() {
					roomCalls += 1;
					throw new Error("disabled room-list sync must not call getRooms");
				},
				async retrieveReservations() {
					historyCalls += 1;
					return { reservations: [], pages: 0 };
				},
			}),
		}),
	});
	const result = await sync.runIfDue(new Date(Date.now() + 60 * 60_000));
	assert.equal(result.status, "completed");
	assert.equal(roomCalls, 0);
	assert.equal(historyCalls, 1);
	assert.equal(SyncStateModel.state.activeRoomListSyncGeneration, undefined);
});

test("room-list discovery waits while the property projection lease is held", async () => {
	const now = new Date(Date.now() + 60 * 60_000);
	const SyncStateModel = createSyncStateModel({
		_id: "sync-state-held-projection",
		hotelId: HOTEL_ID,
		status: "idle",
		nextPullAt: new Date(now.getTime() - 1),
		nextRoomListSyncAt: new Date(now.getTime() - 1),
		projectionLeaseOwner: "reservation-projector",
		projectionLeaseUntil: new Date(now.getTime() + 5 * 60_000),
	});
	let apiCalls = 0;
	const sync = createHotelRunnerPullSync({
		config: syntheticConfig({ pullEnabled: false }),
		instanceId: "room-list-lock-contender",
		dependencies: testDependencies({
			SyncStateModel,
			createClient: () => {
				apiCalls += 1;
				return {};
			},
		}),
	});
	assert.deepEqual(await sync.runRoomListOnly(now), {
		status: "projection_leased_elsewhere",
		apiCalls: 0,
	});
	assert.equal(apiCalls, 0);
	assert.equal(SyncStateModel.state.leaseOwner, undefined);
	assert.equal(SyncStateModel.state.projectionLeaseOwner, "reservation-projector");
});

test("room-list discovery holds the property projection lease through publication", async () => {
	const now = new Date();
	const SyncStateModel = createSyncStateModel();
	let contenderLease = undefined;
	const sync = createHotelRunnerPullSync({
		config: syntheticConfig({ pullEnabled: false }),
		instanceId: "room-list-lock-owner",
		dependencies: testDependencies({
			SyncStateModel,
			createClient: () => ({
				async getRooms() {
					assert.equal(
						SyncStateModel.state.projectionLeaseOwner,
						"room-list-lock-owner:room-list"
					);
					contenderLease = await SyncStateModel.findOneAndUpdate(
						{
							hotelId: HOTEL_ID,
							$or: [
								{ projectionLeaseUntil: { $exists: false } },
								{ projectionLeaseUntil: null },
								{ projectionLeaseUntil: { $lte: now } },
								{ projectionLeaseOwner: "reservation-projector" },
							],
						},
						{
							$set: {
								projectionLeaseOwner: "reservation-projector",
								projectionLeaseAcquiredAt: now,
								projectionLeaseUntil: new Date(now.getTime() + 60_000),
							},
						}
					).exec();
					return {
						rooms: [{ inv_code: "INV-LOCKED", rate_code: "BAR", name: "Room" }],
					};
				},
			}),
		}),
	});
	assert.equal((await sync.runRoomListOnly(now)).status, "completed");
	assert.equal(contenderLease, null);
	assert.ok(SyncStateModel.state.activeRoomListSyncGeneration);
	assert.equal(SyncStateModel.state.projectionLeaseOwner, undefined);
});

test("credential failure holds one fingerprint for 24 hours without repeated API calls", async () => {
	const SyncStateModel = createSyncStateModel();
	let createClientCalls = 0;
	let apiCalls = 0;
	const permanent = new Error("synthetic invalid HotelRunner request");
	permanent.code = "HOTELRUNNER_PULL_OPTIONS_INVALID";
	permanent.retryable = false;
	permanent.credentialFault = true;
	const createClient = () => {
		createClientCalls += 1;
		return {
			async getRooms() {
				apiCalls += 1;
				throw permanent;
			},
			async retrieveReservations() {
				apiCalls += 1;
				return { reservations: [] };
			},
		};
	};
	const config = syntheticConfig({
		credentialFingerprint: "credential-fingerprint-disabled",
	});
	const dependencies = testDependencies({ SyncStateModel, createClient });
	const sync = createHotelRunnerPullSync({
		config,
		instanceId: "pull-worker-disabled",
		dependencies,
	});
	const now = new Date(Date.now() + 60 * 60_000);

	await assert.rejects(sync.runIfDue(now), (error) => error === permanent);
	assert.equal(SyncStateModel.state.status, "disabled");
	assert.equal(
		SyncStateModel.state.disabledConfigFingerprint,
		"credential-fingerprint-disabled"
	);
	assert.equal(createClientCalls, 1);
	assert.equal(apiCalls, 1);

	assert.equal(
		SyncStateModel.state.nextPullAt.getTime() - now.getTime(),
		CREDENTIAL_FAILURE_HOLD_MS
	);
	const held = await sync.runIfDue(new Date(now.getTime() + 60 * 60 * 1000));
	assert.deepEqual(held, { status: "disabled_credential_hold" });
	assert.equal(createClientCalls, 1);
	assert.equal(apiCalls, 1);

	await assert.rejects(
		sync.runIfDue(new Date(SyncStateModel.state.nextPullAt.getTime() + 1)),
		(error) => error === permanent
	);
	assert.equal(createClientCalls, 2);
	assert.equal(apiCalls, 2);
});

test("a changed credential fingerprint immediately re-enables the disabled pull state", async () => {
	const SyncStateModel = createSyncStateModel();
	let createClientCalls = 0;
	let apiCalls = 0;
	const permanent = new Error("synthetic invalid old credential");
	permanent.code = "HOTELRUNNER_API_HTTP_ERROR";
	permanent.retryable = false;
	permanent.credentialFault = true;
	const createClient = () => {
		createClientCalls += 1;
		const thisClient = createClientCalls;
		return {
			async getRooms() {
				apiCalls += 1;
				if (thisClient === 1) throw permanent;
				return {
					rooms: [
						{ inv_code: "INV-ROTATED", rate_code: "BAR", name: "Room" },
					],
				};
			},
			async retrieveReservations() {
				apiCalls += 1;
				return { reservations: [], pages: 0 };
			},
		};
	};
	const dependencies = testDependencies({ SyncStateModel, createClient });
	const oldSync = createHotelRunnerPullSync({
		config: syntheticConfig({ credentialFingerprint: "old-fingerprint" }),
		instanceId: "pull-worker-old-credential",
		dependencies,
	});
	const now = new Date(Date.now() + 60 * 60_000);
	await assert.rejects(oldSync.runIfDue(now), (error) => error === permanent);
	assert.equal(SyncStateModel.state.status, "disabled");
	assert.equal(createClientCalls, 1);
	assert.equal(apiCalls, 1);

	const changedSync = createHotelRunnerPullSync({
		config: syntheticConfig({ credentialFingerprint: "new-fingerprint" }),
		instanceId: "pull-worker-new-credential",
		dependencies,
	});
	const resumed = await changedSync.runIfDue(new Date(now.getTime() + 60_000));
	assert.equal(resumed.status, "completed");
	assert.equal(createClientCalls, 2);
	assert.equal(apiCalls, 3);
	assert.equal(SyncStateModel.state.status, "idle");
	assert.equal(SyncStateModel.state.disabledConfigFingerprint, undefined);
});

test("room-list-only discovery bypasses a future due date after credential rotation", async () => {
	const now = new Date(Date.now() + 60 * 60_000);
	const SyncStateModel = createSyncStateModel({
		_id: "sync-state-rotated-room-list",
		hotelId: HOTEL_ID,
		status: "disabled",
		disabledConfigFingerprint: "old-credential-fingerprint",
		nextPullAt: new Date(now.getTime() + 24 * 60 * 60_000),
		nextRoomListSyncAt: new Date(now.getTime() + 24 * 60 * 60_000),
	});
	let roomCalls = 0;
	const sync = createHotelRunnerPullSync({
		config: syntheticConfig({
			pullEnabled: false,
			credentialFingerprint: "rotated-credential-fingerprint",
		}),
		instanceId: "room-list-rotated-credential",
		dependencies: testDependencies({
			SyncStateModel,
			createClient: () => ({
				async getRooms() {
					roomCalls += 1;
					return {
						rooms: [
							{ inv_code: "INV-ROTATED", rate_code: "BAR", name: "Room" },
						],
					};
				},
			}),
		}),
	});
	const result = await sync.runRoomListOnly(now);
	assert.equal(result.status, "completed");
	assert.equal(roomCalls, 1);
	assert.equal(SyncStateModel.state.status, "idle");
	assert.equal(SyncStateModel.state.disabledConfigFingerprint, undefined);
});

test("non-credential permanent errors back off without disabling valid credentials", async () => {
	const SyncStateModel = createSyncStateModel();
	const failure = new Error("synthetic oversized response");
	failure.code = "HOTELRUNNER_RESPONSE_TOO_LARGE";
	failure.retryable = false;
	let apiCalls = 0;
	const sync = createHotelRunnerPullSync({
		config: syntheticConfig(),
		instanceId: "pull-worker-non-credential",
		dependencies: testDependencies({
			SyncStateModel,
			createClient: () => ({
				async getRooms() {
					apiCalls += 1;
					throw failure;
				},
			}),
		}),
	});
	const now = new Date(Date.now() + 60 * 60_000);
	await assert.rejects(sync.runIfDue(now), (error) => error === failure);
	assert.equal(SyncStateModel.state.status, "retry");
	assert.equal(SyncStateModel.state.disabledConfigFingerprint, undefined);
	assert.equal(
		SyncStateModel.state.nextPullAt.getTime() - now.getTime(),
		NON_RETRYABLE_FAILURE_DELAY_MS
	);
	const notDue = await sync.runIfDue(new Date(now.getTime() + 60_000));
	assert.deepEqual(notDue, { status: "not_due" });
	assert.equal(apiCalls, 1);
});

test("master fallback inventory is forced to conflict and unmapped", async () => {
	const MappingModel = createMappingModel();
	const count = await saveRoomList(
		HOTEL_ID,
		[
			{
				inv_code: "MASTER",
				rate_code: "MASTER-RATE",
				name: "Unmatched room fallback",
				is_master: true,
			},
		],
		{ MappingModel }
	);
	assert.equal(count, 1);
	assert.equal(MappingModel.writes[0].update.$set.isMaster, true);
	assert.ok(MappingModel.writes[0].update.$set.roomListVerifiedAt instanceof Date);
	assert.equal(
		typeof MappingModel.writes[0].update.$set.roomListSyncGeneration,
		"string"
	);
	assert.ok(MappingModel.writes[0].update.$set.roomListSyncGeneration.length > 20);
	assert.equal(MappingModel.writes[0].update.$set.status, "conflict");
	assert.equal(MappingModel.writes[0].update.$set.localRoomConfigId, null);
});

test("a complete room-list generation preserves current active mappings and retires omissions", async () => {
	const verifiedAt = new Date("2026-08-06T12:00:00.000Z");
	const MappingModel = createMappingModel([
		{
			hotelId: HOTEL_ID,
			invCode: "INV-CURRENT",
			status: "active",
			localRoomConfigId: "64b000000000000000000010",
			isMaster: false,
			variantConflict: false,
			roomListSyncGeneration: "old-generation",
			roomListVerifiedAt: new Date("2026-08-05T12:00:00.000Z"),
			rateCodes: ["OLD"],
			__v: 10,
		},
		{
			hotelId: HOTEL_ID,
			invCode: "INV-REMOVED",
			status: "active",
			localRoomConfigId: "64b000000000000000000011",
			isMaster: false,
			variantConflict: false,
			roomListSyncGeneration: "old-generation",
			roomListVerifiedAt: new Date("2026-08-05T12:00:00.000Z"),
			__v: 20,
		},
	]);

	assert.equal(
		await saveRoomList(
			HOTEL_ID,
			[
				{
					inv_code: "INV-CURRENT",
					rate_code: "BAR",
					name: "Current Room",
					room_capacity: 3,
					adult_capacity: 2,
					sales_currency: "SAR",
				},
			],
			{
				MappingModel,
				verifiedAt,
				syncGeneration: "generation-2",
			}
		),
		1
	);

	const current = MappingModel.documents.find(
		(mapping) => mapping.invCode === "INV-CURRENT"
	);
	assert.equal(current.status, "active");
	assert.equal(current.localRoomConfigId, "64b000000000000000000010");
	assert.equal(current.roomListSyncGeneration, "generation-2");
	assert.equal(current.roomListVerifiedAt.toISOString(), verifiedAt.toISOString());
	assert.equal(current.roomListVerificationState, "verified");
	assert.deepEqual(current.rateCodes, ["BAR"]);
	assert.equal(current.roomListRetiredAt, undefined);
	assert.equal(current.__v, 12);

	const removed = MappingModel.documents.find(
		(mapping) => mapping.invCode === "INV-REMOVED"
	);
	assert.equal(removed.status, "disabled");
	assert.equal(removed.localRoomConfigId, null);
	assert.equal(removed.roomListVerifiedAt, null);
	assert.equal(removed.roomListVerificationState, "retired");
	assert.equal(removed.roomListRetiredAt.toISOString(), verifiedAt.toISOString());
	assert.equal(removed.__v, 22);
});

test("inconsistent variants for one inventory code are conflicted and cannot retain a local mapping", async () => {
	const MappingModel = createMappingModel([
		{
			hotelId: HOTEL_ID,
			invCode: "INV-AMBIGUOUS",
			status: "active",
			localRoomConfigId: "64b000000000000000000012",
			isMaster: false,
			variantConflict: false,
			roomListVerifiedAt: new Date("2026-08-05T12:00:00.000Z"),
		},
	]);

	await saveRoomList(
		HOTEL_ID,
		[
			{
				inv_code: "INV-AMBIGUOUS",
				rate_code: "BAR",
				name: "Double Room",
				room_capacity: 2,
				sales_currency: "SAR",
			},
			{
				inv_code: "INV-AMBIGUOUS",
				rate_code: "FLEX",
				name: "Triple Room",
				room_capacity: 3,
				sales_currency: "USD",
			},
		],
		{ MappingModel, syncGeneration: "conflict-generation" }
	);

	const mapping = MappingModel.documents[0];
	assert.equal(mapping.status, "conflict");
	assert.equal(mapping.localRoomConfigId, null);
	assert.equal(mapping.roomListVerifiedAt, null);
	assert.equal(mapping.roomListVerificationState, "conflict");
	assert.equal(mapping.variantConflict, true);
	assert.deepEqual(mapping.variantConflictFields, [
		"room_capacity",
		"sales_currency",
	]);
	assert.deepEqual(mapping.rateCodes, ["BAR", "FLEX"]);
});

test("consistent rate variants share one verified inventory mapping", async () => {
	const MappingModel = createMappingModel();
	await saveRoomList(
		HOTEL_ID,
		[
			{
				inv_code: "INV-RATES",
				rate_code: "FLEX",
				name: "Double Room - Flexible",
				room_capacity: 2,
				adult_capacity: 2,
				sales_currency: "SAR",
			},
			{
				inv_code: "INV-RATES",
				rate_code: "BAR",
				name: "Double Room - Best Available",
				room_capacity: 2,
				adult_capacity: 2,
				sales_currency: "sar",
			},
		],
		{ MappingModel, syncGeneration: "consistent-generation" }
	);

	const mapping = MappingModel.documents[0];
	assert.equal(mapping.status, "pending");
	assert.equal(mapping.variantConflict, false);
	assert.deepEqual(mapping.variantConflictFields, []);
	assert.deepEqual(mapping.rateCodes, ["BAR", "FLEX"]);
	assert.equal(mapping.roomListSyncGeneration, "consistent-generation");
	assert.ok(mapping.roomListVerifiedAt instanceof Date);
});

test("an invalid room-list row is rejected before existing mappings are invalidated", async () => {
	const MappingModel = createMappingModel([
		{
			hotelId: HOTEL_ID,
			invCode: "INV-SAFE",
			status: "active",
			localRoomConfigId: "64b000000000000000000013",
			roomListVerifiedAt: new Date("2026-08-05T12:00:00.000Z"),
		},
	]);

	await assert.rejects(
		saveRoomList(HOTEL_ID, [{ inv_code: "", name: "Missing code" }], {
			MappingModel,
		}),
		(error) => error?.code === "HOTELRUNNER_ROOM_LIST_INVALID"
	);
	assert.equal(MappingModel.bulkWrites.length, 0);
	assert.equal(MappingModel.writes.length, 0);
	assert.equal(MappingModel.documents[0].status, "active");
	assert.ok(MappingModel.documents[0].roomListVerifiedAt instanceof Date);
});

test("an anomalous empty room list is rejected before existing mappings are invalidated", async () => {
	const MappingModel = createMappingModel([
		{
			hotelId: HOTEL_ID,
			invCode: "INV-SAFE",
			status: "active",
			localRoomConfigId: "64b000000000000000000013",
			roomListVerifiedAt: new Date("2026-08-05T12:00:00.000Z"),
		},
	]);
	await assert.rejects(
		saveRoomList(HOTEL_ID, [], { MappingModel }),
		(error) => error?.code === "HOTELRUNNER_ROOM_LIST_INVALID"
	);
	assert.equal(MappingModel.bulkWrites.length, 0);
	assert.equal(MappingModel.documents[0].status, "active");
	assert.ok(MappingModel.documents[0].roomListVerifiedAt instanceof Date);
});

test("a mid-save failure preserves operator intent and never publishes the partial generation", async () => {
	const now = new Date(Date.now() + 60 * 60_000);
	const oldGeneration = "published-generation-before-failure";
	const SyncStateModel = createSyncStateModel({
		_id: "sync-state-partial-room-save",
		hotelId: HOTEL_ID,
		status: "idle",
		nextPullAt: new Date(now.getTime() - 1),
		nextRoomListSyncAt: new Date(now.getTime() - 1),
		activeRoomListSyncGeneration: oldGeneration,
	});
	const MappingModel = createMappingModel([
		{
			hotelId: HOTEL_ID,
			invCode: "INV-FIRST",
			status: "active",
			localRoomConfigId: "64b000000000000000000021",
			isMaster: false,
			variantConflict: false,
			roomListSyncGeneration: oldGeneration,
			roomListVerificationState: "verified",
			roomListVerifiedAt: new Date(now.getTime() - 60_000),
			__v: 4,
		},
		{
			hotelId: HOTEL_ID,
			invCode: "INV-SECOND",
			status: "active",
			localRoomConfigId: "64b000000000000000000022",
			isMaster: false,
			variantConflict: false,
			roomListSyncGeneration: oldGeneration,
			roomListVerificationState: "verified",
			roomListVerifiedAt: new Date(now.getTime() - 60_000),
			__v: 8,
		},
	]);
	const originalFindOneAndUpdate = MappingModel.findOneAndUpdate.bind(MappingModel);
	let mappingSaveCount = 0;
	const failure = new Error("synthetic second mapping write failure");
	MappingModel.findOneAndUpdate = (...args) => {
		mappingSaveCount += 1;
		if (mappingSaveCount === 2) {
			return queryResult(() => {
				throw failure;
			});
		}
		return originalFindOneAndUpdate(...args);
	};
	const sync = createHotelRunnerPullSync({
		config: syntheticConfig({ pullEnabled: false }),
		instanceId: "room-list-partial-save",
		dependencies: testDependencies({
			SyncStateModel,
			MappingModel,
			createClient: () => ({
				async getRooms() {
					return {
						rooms: [
							{ inv_code: "INV-FIRST", rate_code: "BAR", name: "First" },
							{ inv_code: "INV-SECOND", rate_code: "BAR", name: "Second" },
						],
					};
				},
			}),
		}),
	});
	await assert.rejects(sync.runRoomListOnly(now), (error) => error === failure);
	assert.equal(SyncStateModel.state.activeRoomListSyncGeneration, oldGeneration);
	assert.equal(SyncStateModel.state.roomListRequeuePendingGeneration, undefined);
	const first = MappingModel.documents.find((row) => row.invCode === "INV-FIRST");
	const second = MappingModel.documents.find((row) => row.invCode === "INV-SECOND");
	assert.equal(first.status, "active");
	assert.equal(first.localRoomConfigId, "64b000000000000000000021");
	assert.notEqual(first.roomListSyncGeneration, oldGeneration);
	assert.equal(first.roomListVerificationState, "verified");
	assert.equal(first.__v, 6);
	assert.equal(second.status, "active");
	assert.equal(second.localRoomConfigId, "64b000000000000000000022");
	assert.equal(second.roomListSyncGeneration, oldGeneration);
	assert.equal(second.roomListVerificationState, "refreshing");
	assert.equal(second.roomListVerifiedAt, null);
	assert.equal(second.__v, 9);
	assert.equal(SyncStateModel.state.projectionLeaseOwner, undefined);
});

test("a completed mapping save remains unpublished when the final state CAS fails", async () => {
	const now = new Date(Date.now() + 60 * 60_000);
	const oldGeneration = "published-before-final-cas-loss";
	const SyncStateModel = createSyncStateModel({
		_id: "sync-state-final-cas-loss",
		hotelId: HOTEL_ID,
		status: "idle",
		nextPullAt: new Date(now.getTime() - 1),
		nextRoomListSyncAt: new Date(now.getTime() - 1),
		activeRoomListSyncGeneration: oldGeneration,
	});
	const originalUpdateOne = SyncStateModel.updateOne.bind(SyncStateModel);
	SyncStateModel.updateOne = (filter, update, options) => {
		if (update?.$set?.activeRoomListSyncGeneration) {
			return queryResult(() => ({ matchedCount: 0 }));
		}
		return originalUpdateOne(filter, update, options);
	};
	const MappingModel = createMappingModel([
		{
			hotelId: HOTEL_ID,
			invCode: "INV-A",
			status: "active",
			localRoomConfigId: "64b000000000000000000041",
			isMaster: false,
			variantConflict: false,
			roomListSyncGeneration: oldGeneration,
			roomListVerificationState: "verified",
			roomListVerifiedAt: new Date(now.getTime() - 60_000),
		},
	]);
	const sync = createHotelRunnerPullSync({
		config: syntheticConfig({ pullEnabled: false }),
		instanceId: "room-list-final-cas-loss",
		dependencies: testDependencies({
			SyncStateModel,
			MappingModel,
			createClient: () => ({
				async getRooms() {
					return {
						rooms: [{ inv_code: "INV-A", rate_code: "BAR", name: "Room A" }],
					};
				},
			}),
		}),
	});
	await assert.rejects(
		sync.runRoomListOnly(now),
		(error) => error?.code === "HOTELRUNNER_PULL_LEASE_LOST"
	);
	assert.equal(SyncStateModel.state.activeRoomListSyncGeneration, oldGeneration);
	assert.equal(SyncStateModel.state.roomListRequeuePendingGeneration, undefined);
	assert.notEqual(
		MappingModel.documents[0].roomListSyncGeneration,
		oldGeneration
	);
	assert.equal(SyncStateModel.state.projectionLeaseOwner, undefined);
});

test("published room-list requeue is selective and excludes genuinely unmapped events", async () => {
	const generation = "published-selective-generation";
	const events = [
		{
			_id: "event-stale-resolved",
			status: "needs_mapping",
			result: {
				code: "hotelrunner_room_mapping_stale",
				staleInvCodes: ["INV-A"],
				missingInvCodes: ["INV-A"],
			},
		},
		{
			_id: "event-still-unmapped",
			status: "needs_mapping",
			result: {
				code: "hotelrunner_room_mapping_stale",
				staleInvCodes: ["INV-A"],
				missingInvCodes: ["INV-A", "INV-B"],
			},
		},
		{
			_id: "event-genuine-mapping",
			status: "needs_mapping",
			result: {
				code: "hotelrunner_room_mapping_required",
				staleInvCodes: [],
				missingInvCodes: ["INV-A"],
			},
		},
	];
	const SyncStateModel = {
		findOne: () => queryResult(() => ({
			activeRoomListSyncGeneration: generation,
		})),
	};
	let activeMappingFilter = null;
	const MappingModel = {
		find: (filter) => {
			activeMappingFilter = filter;
			return queryResult(() => [{ invCode: "INV-A" }]);
		},
	};
	const EventModel = {
		updateMany(filter, update) {
			return queryResult(() => {
				const allowed = new Set(
					filter.$expr.$and[1].$setIsSubset[1]
				);
				let modifiedCount = 0;
				for (const event of events) {
					const stale = event.result?.staleInvCodes || [];
					const missing = event.result?.missingInvCodes || [];
					if (
						event.status === "needs_mapping" &&
						event.result?.code === filter["result.code"] &&
						stale.length > 0 &&
						stale.every((code) => allowed.has(code)) &&
						missing.every((code) => allowed.has(code))
					) {
						applyUpdate(event, update);
						modifiedCount += 1;
					}
				}
				return { matchedCount: modifiedCount, modifiedCount };
			});
		},
	};
	assert.equal(
		await requeueResolvedStaleMappingEvents(HOTEL_ID, generation, {
			SyncStateModel,
			MappingModel,
			EventModel,
		}),
		1
	);
	assert.equal(events[0].status, "pending");
	assert.equal(events[1].status, "needs_mapping");
	assert.equal(events[2].status, "needs_mapping");
	assert.equal(activeMappingFilter.roomListSyncGeneration, generation);
	assert.equal(activeMappingFilter.roomListVerificationState, "verified");
	assert.deepEqual(activeMappingFilter.roomListVerifiedAt, { $type: "date" });
	assert.deepEqual(activeMappingFilter.variantConflict, { $ne: true });
	assert.deepEqual(activeMappingFilter.isMaster, { $ne: true });
});

test("a failed post-publication requeue recovers locally without another vendor call", async () => {
	const now = new Date(Date.now() + 60 * 60_000);
	const oldGeneration = "old-published-generation";
	const SyncStateModel = createSyncStateModel({
		_id: "sync-state-requeue-recovery",
		hotelId: HOTEL_ID,
		status: "idle",
		nextPullAt: new Date(now.getTime() - 1),
		nextRoomListSyncAt: new Date(now.getTime() - 1),
		activeRoomListSyncGeneration: oldGeneration,
	});
	const MappingModel = createMappingModel([
		{
			hotelId: HOTEL_ID,
			invCode: "INV-A",
			status: "active",
			localRoomConfigId: "64b000000000000000000031",
			isMaster: false,
			variantConflict: false,
			roomListSyncGeneration: oldGeneration,
			roomListVerificationState: "verified",
			roomListVerifiedAt: new Date(now.getTime() - 60_000),
		},
	]);
	let requeueAttempts = 0;
	const requeueFailure = new Error("synthetic event requeue write failure");
	const EventModel = {
		updateMany() {
			return queryResult(() => {
				requeueAttempts += 1;
				if (requeueAttempts === 1) throw requeueFailure;
				return { matchedCount: 0, modifiedCount: 0 };
			});
		},
	};
	let roomCalls = 0;
	const sync = createHotelRunnerPullSync({
		config: syntheticConfig({ pullEnabled: false }),
		instanceId: "room-list-requeue-recovery",
		dependencies: testDependencies({
			SyncStateModel,
			MappingModel,
			EventModel,
			createClient: () => ({
				async getRooms() {
					roomCalls += 1;
					return {
						rooms: [{ inv_code: "INV-A", rate_code: "BAR", name: "Room A" }],
					};
				},
			}),
		}),
	});
	await assert.rejects(sync.runRoomListOnly(now), (error) => error === requeueFailure);
	const publishedGeneration = SyncStateModel.state.activeRoomListSyncGeneration;
	assert.notEqual(publishedGeneration, oldGeneration);
	assert.equal(
		SyncStateModel.state.roomListRequeuePendingGeneration,
		publishedGeneration
	);
	assert.equal(roomCalls, 1);

	const recovery = await sync.runRoomListOnly(new Date(now.getTime() + 60_000));
	assert.deepEqual(recovery, { status: "not_due", apiCalls: 0 });
	assert.equal(requeueAttempts, 2);
	assert.equal(roomCalls, 1);
	assert.equal(SyncStateModel.state.roomListRequeuePendingGeneration, undefined);
});

test("lease renewal fails closed after ownership is lost", async () => {
	const SyncStateModel = createSyncStateModel({
		_id: "lease-1",
		hotelId: HOTEL_ID,
		leaseOwner: "another-worker",
	});
	await assert.rejects(
		renewPullLease("lease-1", "expected-worker", new Date(), { SyncStateModel }),
		(error) => error?.code === "HOTELRUNNER_PULL_LEASE_LOST"
	);
});
