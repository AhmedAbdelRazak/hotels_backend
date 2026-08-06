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
				applyUpdate(state, update);
				return { matchedCount: 1 };
			});
		},
		findOneAndUpdate(filter, update) {
			return queryResult(() => {
				writes.push({ operation: "findOneAndUpdate", filter, update });
				if (!state || String(state.hotelId) !== String(filter.hotelId)) return null;
				const now = filter.$or
					?.map((condition) => condition.leaseUntil?.$lte)
					.find(Boolean);
				const leaseAvailable =
					!state.leaseUntil ||
					(now && new Date(state.leaseUntil) <= new Date(now)) ||
					state.leaseOwner === update.$set?.leaseOwner;
				if (!leaseAvailable) return null;
				applyUpdate(state, update);
				return state;
			});
		},
	};
}

function createEventModel() {
	const events = new Map();
	let sequence = 0;
	return {
		events,
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
	};
}

function createMappingModel() {
	const writes = [];
	return {
		writes,
		findOneAndUpdate(filter, update) {
			return queryResult(() => {
				writes.push({ filter, update });
				return { ...filter, ...update.$setOnInsert, ...update.$set };
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
		SyncStateModel.state.nextRoomListSyncAt.getTime() -
			SyncStateModel.state.lastRoomListSyncAt.getTime(),
		24 * 60 * 60 * 1000
	);
	assert.equal(SyncStateModel.state.lastErrorCode, "HOTELRUNNER_API_NETWORK_ERROR");
	assert.equal(SyncStateModel.state.metrics.pullFailures, 1);
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
				return { rooms: [] };
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
	assert.equal(MappingModel.writes[0].update.$set.status, "conflict");
	assert.equal(MappingModel.writes[0].update.$set.localRoomConfigId, null);
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
