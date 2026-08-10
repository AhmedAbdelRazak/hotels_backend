/** @format */

process.env.SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "SG.test";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
	LATE_EVIDENCE_RECOVERY_INTERVAL_MS,
	TARGETED_LOOKUP_MARKER_PATH,
	buildProjectionEligibilityFilter,
	createHotelRunnerWorker,
	normalizedFromStoredEvent,
} = require("./hotelrunnerWorker");
const { normalizeHotelRunnerReservation } = require("./hotelrunnerPayload");
const { persistHotelRunnerDelivery } = require("./hotelrunnerEventService");

test("cancellation stay-presence evidence survives the durable event round trip", () => {
	const normalized = normalizeHotelRunnerReservation({
		message_uid: "durable-cancellation-stay-evidence",
		reservation_id: "hr-reservation-101",
		hr_number: "R-101",
		provider_number: "BOOKING-101",
		channel: "bookingcom",
		state: "canceled",
		checkin_date: "2026-08-11",
		checkout_date: "2026-08-13",
		updated_at: "2026-08-06T12:00:00.000Z",
	});
	assert.equal(normalized.stayWasSupplied, true);
	assert.equal(normalized.storedPayload.stayWasSupplied, true);

	const replayed = normalizedFromStoredEvent({
		messageUid: normalized.messageUid,
		hotelRunnerReservationId: normalized.hotelRunnerReservationId,
		sourceUpdatedAt: normalized.sourceUpdatedAt,
		payloadHash: normalized.payloadHash,
		canonicalHash: normalized.canonicalHash,
		payload: normalized.storedPayload,
	});
	assert.equal(replayed.stayWasSupplied, true);
	assert.equal(replayed.checkinDate, "2026-08-11");
	assert.equal(replayed.checkoutDate, "2026-08-13");
});

test("worker claims oldest source events first so lifecycle updates follow creation", async () => {
	let captured = null;
	const EventModel = {
		findOneAndUpdate(filter, update, options) {
			captured = { filter, update, options };
			return {
				select() {
					return this;
				},
				exec: async () => null,
			};
		},
	};
	const worker = createHotelRunnerWorker({
		config: {
			configured: true,
			hotelId: "64b000000000000000000001",
			pullEnabled: false,
		},
		instanceId: "synthetic-worker",
		dependencies: {
			EventModel,
			SyncStateModel: {},
			createPullSync: () => ({ runIfDue: async () => ({ status: "disabled" }) }),
		},
	});

	assert.equal(await worker.claimEvent(new Date("2026-08-06T00:00:00.000Z")), null);
	assert.deepEqual(captured.options.sort, { sourceUpdatedAt: 1, createdAt: 1 });
	assert.equal(captured.filter.hotelId, "64b000000000000000000001");
	assert.deepEqual(captured.filter.status.$in, ["pending", "retry", "processing"]);
});

test("projection claims exclude every event archived before the activation cutoff", async () => {
	let captured = null;
	const EventModel = {
		findOneAndUpdate(filter, update, options) {
			captured = { filter, update, options };
			return {
				select() {
					return this;
				},
				exec: async () => null,
			};
		},
	};
	const cutoff = new Date("2026-08-06T20:00:00.000Z");
	const worker = createHotelRunnerWorker({
		config: {
			configured: true,
			hotelId: "64b000000000000000000001",
			projectionNotBefore: cutoff,
			pullEnabled: false,
		},
		dependencies: {
			EventModel,
			SyncStateModel: {},
			createPullSync: () => ({ runIfDue: async () => ({ status: "disabled" }) }),
		},
	});

	await worker.claimEvent();
	const eligibility = captured.filter.$and[0];
	const push = eligibility.$or.find((branch) => branch.source === "push");
	assert.equal(push.receivedAt.$gte, cutoff);
	assert.equal(push.sourceUpdatedAt.$gte, cutoff);
});

test("an idle worker probes without churning the projection lease", async () => {
	let projectionStateWrites = 0;
	let projectionLeaseClaims = 0;
	const EventModel = {
		exists(filter) {
			assert.equal(filter.hotelId, "64b000000000000000000001");
			return { exec: async () => null };
		},
	};
	const SyncStateModel = {
		updateOne() {
			projectionStateWrites += 1;
			return { exec: async () => ({ matchedCount: 1 }) };
		},
		findOneAndUpdate() {
			projectionLeaseClaims += 1;
			return { exec: async () => ({ _id: "unexpected-lease" }) };
		},
	};
	const worker = createHotelRunnerWorker({
		config: {
			configured: true,
			hotelId: "64b000000000000000000001",
			projectionEnabled: true,
			pullEnabled: false,
		},
		dependencies: {
			otaFallbackCoordinator: null,
			EventModel,
			SyncStateModel,
			createPullSync: () => ({ runIfDue: async () => ({ status: "disabled" }) }),
		},
	});

	assert.equal(await worker.runOnce(), false);
	assert.equal(projectionStateWrites, 0);
	assert.equal(projectionLeaseClaims, 0);
});

test("a due late-evidence interval with no candidates does not churn the property lease", async () => {
	let candidateProbes = 0;
	let scans = 0;
	let projectionLeaseClaims = 0;
	const worker = createHotelRunnerWorker({
		config: {
			configured: true,
			hotelId: "64b000000000000000000001",
			projectionEnabled: true,
			pullEnabled: false,
		},
		dependencies: {
			otaFallbackCoordinator: null,
			EventModel: {
				exists() {
					return { exec: async () => null };
				},
			},
			SyncStateModel: {
				findOneAndUpdate() {
					projectionLeaseClaims += 1;
					return { exec: async () => ({ _id: "unexpected-lease" }) };
				},
			},
			lateEvidenceRecovery: {
				async hasCandidates() {
					candidateProbes += 1;
					return false;
				},
				async scanOnce() {
					scans += 1;
					return { requeued: false };
				},
			},
			createPullSync: () => ({
				runIfDue: async () => ({ status: "disabled" }),
			}),
		},
	});
	const dueAt = Date.now() + LATE_EVIDENCE_RECOVERY_INTERVAL_MS;

	assert.equal(await worker.runOnce(dueAt), false);
	assert.equal(await worker.runOnce(dueAt + 1), false);
	assert.equal(candidateProbes, 1);
	assert.equal(scans, 0);
	assert.equal(projectionLeaseClaims, 0);
});

test("a database property lease serializes projection across duplicate workers", async () => {
	const state = { hotelId: "64b000000000000000000001" };
	const query = (value) => ({ exec: async () => value });
	const SyncStateModel = {
		updateOne(filter, update) {
			if (
				!filter.projectionLeaseOwner ||
				filter.projectionLeaseOwner === state.projectionLeaseOwner
			) {
				Object.assign(state, update.$set || {});
				for (const key of Object.keys(update.$unset || {})) delete state[key];
			}
			return query({ matchedCount: 1 });
		},
		findOneAndUpdate(filter, update) {
			const now = update.$set.projectionLeaseAcquiredAt;
			const ownerMatches = state.projectionLeaseOwner === filter.$or[3].projectionLeaseOwner;
			const expired =
				!state.projectionLeaseUntil ||
				new Date(state.projectionLeaseUntil).getTime() <= now.getTime();
			if (!expired && !ownerMatches) return query(null);
			Object.assign(state, update.$set);
			return query({ ...state });
		},
	};
	const dependencies = {
		otaFallbackCoordinator: null,
		EventModel: {},
		SyncStateModel,
		createPullSync: () => ({ runIfDue: async () => ({ status: "disabled" }) }),
	};
	const config = {
		configured: true,
		hotelId: state.hotelId,
		projectionEnabled: true,
		pullEnabled: false,
	};
	const first = createHotelRunnerWorker({
		config,
		instanceId: "projection-worker-a",
		dependencies,
	});
	const second = createHotelRunnerWorker({
		config,
		instanceId: "projection-worker-b",
		dependencies,
	});
	const now = new Date("2026-08-06T20:00:00.000Z");

	assert.ok(await first.claimProjectionLease(now));
	assert.equal(await second.claimProjectionLease(now), null);
	await first.releaseProjectionLease(new Date(now.getTime() + 1));
	assert.ok(await second.claimProjectionLease(new Date(now.getTime() + 2)));
});

test("projection lease renewal fails closed after ownership is lost", async () => {
	let ownsLease = true;
	const worker = createHotelRunnerWorker({
		config: {
			configured: true,
			hotelId: "64b000000000000000000001",
			projectionEnabled: true,
			pullEnabled: false,
		},
		instanceId: "projection-heartbeat-worker",
		dependencies: {
			otaFallbackCoordinator: null,
			EventModel: {},
			SyncStateModel: {
				updateOne(filter, update) {
					assert.equal(
						filter.projectionLeaseOwner,
						"projection-heartbeat-worker"
					);
					assert.ok(update.$set.projectionLeaseUntil instanceof Date);
					return {
						exec: async () => ({ matchedCount: ownsLease ? 1 : 0 }),
					};
				},
			},
			createPullSync: () => ({ runIfDue: async () => ({ status: "disabled" }) }),
		},
	});

	assert.equal(await worker.renewProjectionLease(), true);
	ownsLease = false;
	await assert.rejects(
		worker.renewProjectionLease(),
		(error) => error?.code === "HOTELRUNNER_PROJECTION_LEASE_LOST"
	);
});

test("event projection assertion is an owned-processing CAS and fails closed", async () => {
	let capturedFilter = null;
	let capturedUpdate = null;
	const worker = createHotelRunnerWorker({
		config: {
			configured: true,
			hotelId: "64b000000000000000000001",
			projectionEnabled: true,
			pullEnabled: false,
		},
		instanceId: "event-cas-worker",
		dependencies: {
			otaFallbackCoordinator: null,
			EventModel: {
				updateOne(filter, update) {
					capturedFilter = filter;
					capturedUpdate = update;
					return { exec: async () => ({ matchedCount: 0 }) };
				},
			},
			SyncStateModel: {},
			createPullSync: () => ({ runIfDue: async () => ({ status: "disabled" }) }),
		},
	});

	await assert.rejects(
		worker.assertEventProjectable({
			_id: "event-cas-lost",
			hotelId: "64b000000000000000000001",
			payloadHash: "original-payload-hash",
		}),
		(error) => error?.code === "HOTELRUNNER_EVENT_LEASE_LOST"
	);
	assert.deepEqual(capturedFilter, {
		_id: "event-cas-lost",
		hotelId: "64b000000000000000000001",
		status: "processing",
		leaseOwner: "event-cas-worker",
		payloadHash: "original-payload-hash",
		integrityReason: { $in: ["", null] },
	});
	assert.ok(capturedUpdate.$set.leaseUntil instanceof Date);
});

test("finish and retry surface event lease loss and never count a false completion", async () => {
	let metricWrites = 0;
	const worker = createHotelRunnerWorker({
		config: {
			configured: true,
			hotelId: "64b000000000000000000001",
			projectionEnabled: true,
			pullEnabled: false,
		},
		instanceId: "lost-event-lease-worker",
		dependencies: {
			otaFallbackCoordinator: null,
			EventModel: {
				updateOne: () => ({ exec: async () => ({ matchedCount: 0 }) }),
			},
			SyncStateModel: {
				updateOne: () => {
					metricWrites += 1;
					return { exec: async () => ({ matchedCount: 1 }) };
				},
			},
			createPullSync: () => ({ runIfDue: async () => ({ status: "disabled" }) }),
		},
	});
	const event = {
		_id: "lost-event-lease",
		hotelId: "64b000000000000000000001",
		payloadHash: "owned-payload-hash",
		attempts: 1,
	};

	await assert.rejects(
		worker.finishEvent(event, { status: "created" }),
		(error) => error?.code === "HOTELRUNNER_EVENT_LEASE_LOST"
	);
	assert.equal(metricWrites, 0);
	await assert.rejects(
		worker.retryEvent(event, new Error("synthetic projection error")),
		(error) => error?.code === "HOTELRUNNER_EVENT_LEASE_LOST"
	);
	assert.equal(metricWrites, 0);
});

test("a callback conflict in the pre-project window preserves the active first payload", async () => {
	const hotelId = "64b000000000000000000001";
	const instanceId = "pre-project-first-payload-worker";
	const config = {
		configured: true,
		hotelId,
		hrIdFingerprint: "pre-project-property-fingerprint",
		callbackMaxReservations: 100,
		projectionEnabled: true,
		pullEnabled: false,
	};
	const originalPayload = {
		message_uid: "pre-project-conflict-uid",
		reservation_id: "pre-project-reservation",
		hr_number: "R-PRE-PROJECT",
		provider_number: "BOOKING-PRE-PROJECT",
		channel: "bookingcom",
		state: "confirmed",
		guest: "First Payload Guest",
		checkin_date: "2026-08-10",
		checkout_date: "2026-08-11",
		updated_at: "2026-08-06T12:00:00.000Z",
		total_guests: 1,
		total_rooms: 1,
		total: "100",
		currency: "SAR",
		rooms: [
			{
				id: "pre-project-room",
				state: "confirmed",
				inv_code: "INV-PRE-PROJECT",
				checkin_date: "2026-08-10",
				checkout_date: "2026-08-11",
				nights: 1,
				total_guest: 1,
				total_adult: 1,
				price: "100",
				total: "100",
				daily_prices: [{ date: "2026-08-10", price: "100" }],
			},
		],
	};
	let event = null;
	let eventSequence = 0;
	const query = (resolve) => ({
		select() {
			return this;
		},
		exec: async () => (typeof resolve === "function" ? resolve() : resolve),
	});
	const matchesOwnedEvent = (filter) =>
		event &&
		String(filter._id) === String(event._id) &&
		String(filter.hotelId) === String(event.hotelId) &&
		filter.status === event.status &&
		filter.leaseOwner === event.leaseOwner &&
		filter.payloadHash === event.payloadHash &&
		filter.integrityReason.$in.includes(event.integrityReason ?? null) &&
		(!filter.integrityConflict ||
			(filter.integrityConflict.$ne === true
				? event.integrityConflict !== true
				: event.integrityConflict === filter.integrityConflict));
	const EventModel = {
		exists: () => query(() => (event?.status === "pending" ? { _id: event._id } : null)),
		findOneAndUpdate(filter, update) {
			return query(() => {
				if (Array.isArray(update)) {
					if (!event || event.payloadHash !== filter.payloadHash) return null;
					const conflict =
						update[0].$set.integrityConflicts.$slice[0].$concatArrays[1][0].$literal;
					const activeProcessing =
						event.status === "processing" &&
						Boolean(String(event.leaseOwner || "").trim()) &&
						event.leaseUntil instanceof Date &&
						event.leaseUntil.getTime() > conflict.receivedAt.getTime();
					const alreadyProcessed = [
						"completed",
						"ignored",
						"attention",
					].includes(event.status);
					event.integrityConflict = true;
					event.integrityConflictCount =
						Number(event.integrityConflictCount || 0) + 1;
					event.integrityConflicts = [
						...(event.integrityConflicts || []),
						conflict,
					].slice(-5);
					if (alreadyProcessed) {
						event.status = "attention";
					} else if (!activeProcessing) {
						event.status = "quarantined";
						event.integrityReason = "message_uid_payload_conflict";
						event.processedAt = conflict.receivedAt;
					}
					if (!activeProcessing) {
						event.leaseOwner = "";
						event.leaseAcquiredAt = null;
						event.leaseUntil = null;
					}
					return event;
				}
				if (filter.eventKey) {
					if (!event) {
						event = {
							_id: `pre-project-event-${++eventSequence}`,
							deliveryCount: 0,
							...(update.$setOnInsert || {}),
							toObject() {
								return { ...this };
							},
						};
					}
					Object.assign(event, update.$set || {});
					event.deliveryCount += Number(update.$inc?.deliveryCount || 0);
					return event;
				}
				if (filter.status?.$in && event?.status === "pending") {
					Object.assign(event, update.$set || {});
					event.attempts = Number(event.attempts || 0) + 1;
					return event;
				}
				return null;
			});
		},
		updateOne(filter, update) {
			return query(() => {
				if (!matchesOwnedEvent(filter)) return { matchedCount: 0 };
				Object.assign(event, update.$set || {});
				for (const key of Object.keys(update.$unset || {})) delete event[key];
				return { matchedCount: 1 };
			});
		},
	};
	const eventPersistenceDependencies = {
		EventModel,
		markHotelRunnerFallbackApiObserved: async () => ({
			eligible: true,
			ordered: false,
			decision: "no_active_job",
		}),
	};
	await persistHotelRunnerDelivery(
		{
			config,
			hotel: { _id: hotelId },
			rawReservation: originalPayload,
			receivedAt: new Date("2026-08-06T12:00:01.000Z"),
		},
		eventPersistenceDependencies
	);
	let callbackConflict = null;
	let projected = 0;
	const SyncStateModel = {
		updateOne: () => query({ matchedCount: 1 }),
		findOneAndUpdate: () => query({ _id: "pre-project-sync-state" }),
	};
	const worker = createHotelRunnerWorker({
		config,
		instanceId,
		dependencies: {
			otaFallbackCoordinator: null,
			EventModel,
			SyncStateModel,
			HotelModel: {
				findOne: () => ({
					select() {
						return this;
					},
					lean() {
						return this;
					},
					exec: async () => {
						assert.equal(event.status, "processing");
						callbackConflict = await persistHotelRunnerDelivery(
							{
								config,
								hotel: { _id: hotelId },
								rawReservation: {
									...originalPayload,
									note: "different callback payload while processing",
								},
								receivedAt: new Date("2026-08-06T12:00:02.000Z"),
							},
							eventPersistenceDependencies
						);
						assert.equal(event.leaseOwner, instanceId);
						return { _id: hotelId, belongsTo: "64b000000000000000000002" };
					},
				}),
			},
			projectReservation: async ({ normalized }) => {
				projected += 1;
				assert.equal(normalized.guestName, "First Payload Guest");
				return {
					status: "created",
					mirrorId: "hotelrunner-mirror",
					reservationMongoId: "local-reservation",
				};
			},
			createPullSync: () => ({ runIfDue: async () => ({ status: "disabled" }) }),
		},
	});

	assert.equal(await worker.runOnce(), true);
	assert.equal(projected, 1);
	assert.equal(callbackConflict.firstPayloadWins, true);
	assert.equal(callbackConflict.activeProcessing, true);
	assert.equal(event.status, "attention");
	assert.equal(event.integrityConflict, true);
	assert.equal(event.integrityConflictCount, 1);
	assert.equal(event.integrityConflicts.length, 1);
	assert.equal(event.mirrorId, "hotelrunner-mirror");
	assert.equal(event.reservationMongoId, "local-reservation");
	assert.equal(event.result.status, "created");
	assert.equal(event.result.integrityConflict, true);
});

test("an applied overbooking create or modification remains durably visible as attention", async () => {
	let eventUpdate = null;
	const query = (value) => ({ exec: async () => value });
	const worker = createHotelRunnerWorker({
		config: {
			configured: true,
			hotelId: "64b000000000000000000001",
			pullEnabled: false,
		},
		instanceId: "inventory-attention-worker",
		dependencies: {
			EventModel: {
				updateOne(filter, update) {
					eventUpdate = { filter, update };
					return query({ matchedCount: 1 });
				},
			},
			SyncStateModel: {
				updateOne: () => query({ matchedCount: 1 }),
			},
			createPullSync: () => ({ runIfDue: async () => ({ status: "disabled" }) }),
		},
	});

	await worker.finishEvent(
		{
			_id: "event-with-inventory-warning",
			hotelId: "64b000000000000000000001",
		},
		{
			status: "updated",
			inventoryIssueCount: 1,
			inventorySummary: [{ roomType: "Double", shortage: 1 }],
		}
	);
	assert.equal(eventUpdate.update.$set.status, "attention");
	assert.equal(eventUpdate.update.$set.result.inventoryIssueCount, 1);
	assert.deepEqual(eventUpdate.update.$set.result.inventorySummary, [
		{ roomType: "Double", shortage: 1 },
	]);

	await worker.finishEvent(
		{
			_id: "created-event-with-inventory-warning",
			hotelId: "64b000000000000000000001",
		},
		{
			status: "created",
			inventoryIssueCount: 1,
			inventorySummary: [{ roomType: "Triple", shortage: 1 }],
		}
	);
	assert.equal(eventUpdate.update.$set.status, "attention");

	await worker.finishEvent(
		{
			_id: "event-with-stale-commercial-evidence",
			hotelId: "64b000000000000000000001",
		},
		{
			status: "updated",
			commercialProtected: true,
			commercialEvidenceStale: true,
			attentionCode: "hotelrunner_commercial_evidence_stale",
		}
	);
	assert.equal(eventUpdate.update.$set.status, "attention");
	assert.equal(
		eventUpdate.update.$set.result.attentionCode,
		"hotelrunner_commercial_evidence_stale"
	);
	assert.equal(eventUpdate.update.$set.result.commercialEvidenceStale, true);
	assert.equal(
		eventUpdate.update.$set.errorCode,
		"hotelrunner_commercial_evidence_stale"
	);
});

test("every ordinary and recovery claim is scoped to the configured property", async () => {
	const capturedFilters = [];
	const EventModel = {
		findOneAndUpdate(filter) {
			capturedFilters.push(filter);
			return {
				select() {
					return this;
				},
				exec: async () => null,
			};
		},
	};
	const hotelId = "64b000000000000000000001";
	const worker = createHotelRunnerWorker({
		config: { configured: true, hotelId, pullEnabled: false },
		instanceId: "property-scoped-worker",
		dependencies: {
			otaFallbackCoordinator: null,
			EventModel,
			SyncStateModel: {},
			createPullSync: () => ({ runIfDue: async () => ({ status: "disabled" }) }),
		},
	});

	await worker.claimEvent();
	await worker.claimExpiredExhaustedEvent();
	await worker.failAbandonedFinalRecovery();
	assert.equal(capturedFilters.length, 3);
	for (const filter of capturedFilters) assert.equal(filter.hotelId, hotelId);
});

test("projection gate leaves the durable queue untouched during bootstrap", async () => {
	let eventQueries = 0;
	let pullCalls = 0;
	const worker = createHotelRunnerWorker({
		config: {
			configured: true,
			hotelId: "64b000000000000000000001",
			projectionEnabled: false,
			pullEnabled: true,
		},
		dependencies: {
			EventModel: {
				findOneAndUpdate() {
					eventQueries += 1;
					throw new Error("projection-disabled worker must not claim events");
				},
			},
			SyncStateModel: {},
			createPullSync: () => ({
				runIfDue: async () => {
					pullCalls += 1;
					return { status: "completed" };
				},
			}),
		},
	});
	assert.equal(await worker.runOnce(), false);
	assert.equal(eventQueries, 0);
	assert.equal(await worker.runCycle(30_000), false);
	assert.equal(eventQueries, 0);
	assert.equal(pullCalls, 1, "bootstrap must still discover rooms and archive pulls");
});

test("invalid worker configuration fails before any queue or lease access", async () => {
	let databaseCalls = 0;
	const worker = createHotelRunnerWorker({
		config: {
			configured: false,
			hotelId: "64b000000000000000000001",
			projectionEnabled: true,
			pullEnabled: false,
		},
		dependencies: {
			EventModel: {
				exists() {
					databaseCalls += 1;
					return { exec: async () => ({ _id: "must-not-read" }) };
				},
			},
			SyncStateModel: {
				updateOne() {
					databaseCalls += 1;
					return { exec: async () => ({ matchedCount: 1 }) };
				},
			},
			createPullSync: () => ({ runIfDue: async () => ({ status: "disabled" }) }),
		},
	});

	await assert.rejects(
		worker.runOnce(),
		(error) => error?.code === "HOTELRUNNER_CONFIG_INVALID"
	);
	assert.equal(databaseCalls, 0);
});

test("scheduled room-list refresh is independent from reservation-history pull", async () => {
	let roomListChecks = 0;
	let pullChecks = 0;
	const worker = createHotelRunnerWorker({
		config: {
			configured: true,
			hotelId: "64b000000000000000000001",
			projectionEnabled: false,
			pullEnabled: false,
			roomListSyncEnabled: true,
		},
		dependencies: {
			EventModel: {},
			SyncStateModel: {},
			createPullSync: () => ({
				runRoomListOnly: async () => {
					roomListChecks += 1;
					return { status: "not_due", apiCalls: 0 };
				},
				runIfDue: async () => {
					pullChecks += 1;
					return { status: "disabled" };
				},
			}),
		},
	});

	assert.equal(await worker.runCycle(30_000), false);
	assert.equal(roomListChecks, 1);
	assert.equal(pullChecks, 1);
});

test("late authoritative evidence recovery runs when due and then at a bounded interval", async () => {
	let scans = 0;
	let candidateProbes = 0;
	let lastScanAt = null;
	const EventModel = {
		exists() {
			return { exec: async () => null };
		},
		findOneAndUpdate() {
			return {
				select() {
					return this;
				},
				exec: async () => null,
			};
		},
	};
	const SyncStateModel = {
		updateOne() {
			return { exec: async () => ({ matchedCount: 1 }) };
		},
		findOneAndUpdate() {
			return { exec: async () => ({ _id: "late-evidence-state" }) };
		},
	};
	const worker = createHotelRunnerWorker({
		config: {
			configured: true,
			hotelId: "64b000000000000000000001",
			projectionEnabled: true,
			pullEnabled: false,
		},
		dependencies: {
			otaFallbackCoordinator: null,
			EventModel,
			SyncStateModel,
			lateEvidenceRecovery: {
				async hasCandidates() {
					candidateProbes += 1;
					return true;
				},
				async scanOnce({ now }) {
					scans += 1;
					lastScanAt = now;
					return { requeued: false };
				},
			},
			createPullSync: () => ({
				runIfDue: async () => ({ status: "disabled" }),
			}),
		},
	});

	const firstAt = Date.now() + LATE_EVIDENCE_RECOVERY_INTERVAL_MS;
	assert.equal(await worker.runCycle(firstAt), false);
	assert.equal(scans, 1);
	assert.equal(candidateProbes, 1);
	assert.equal(lastScanAt.toISOString(), new Date(firstAt).toISOString());
	assert.equal(
		await worker.runCycle(firstAt + LATE_EVIDENCE_RECOVERY_INTERVAL_MS - 1),
		false
	);
	assert.equal(scans, 1);
	assert.equal(candidateProbes, 1);
	assert.equal(
		await worker.runCycle(firstAt + LATE_EVIDENCE_RECOVERY_INTERVAL_MS),
		false
	);
	assert.equal(scans, 2);
	assert.equal(candidateProbes, 2);
});

test("only the property-lease owner scans late evidence and its recovered event preempts fallback", async () => {
	const hotelId = "64b000000000000000000001";
	const state = { hotelId };
	let event = null;
	let ownerScans = 0;
	let nonOwnerScans = 0;
	let projections = 0;
	let fallbackRuns = 0;
	const query = (value) => ({
		select() {
			return this;
		},
		exec: async () => value,
	});
	const SyncStateModel = {
		updateOne(filter, update) {
			if (
				filter.projectionLeaseOwner &&
				state.projectionLeaseOwner !== filter.projectionLeaseOwner
			) {
				return query({ matchedCount: 0 });
			}
			Object.assign(state, update.$set || {});
			for (const key of Object.keys(update.$unset || {})) delete state[key];
			return query({ matchedCount: 1 });
		},
		findOneAndUpdate(filter, update) {
			const now = update.$set.projectionLeaseAcquiredAt;
			const ownerMatches =
				state.projectionLeaseOwner === filter.$or[3].projectionLeaseOwner;
			const expired =
				!state.projectionLeaseUntil ||
				new Date(state.projectionLeaseUntil).getTime() <= now.getTime();
			if (!expired && !ownerMatches) return query(null);
			Object.assign(state, update.$set);
			return query({ ...state });
		},
	};
	const EventModel = {
		exists() {
			return query(event?.status === "pending" ? { _id: event._id } : null);
		},
		findOneAndUpdate(filter, update) {
			if (!event || !filter.status?.$in?.includes(event.status)) {
				return query(null);
			}
			Object.assign(event, update.$set || {});
			event.attempts = Number(event.attempts || 0) + 1;
			return query(event);
		},
		updateOne(_filter, update) {
			if (event) {
				Object.assign(event, update.$set || {});
				for (const key of Object.keys(update.$unset || {})) delete event[key];
			}
			return query({ matchedCount: 1 });
		},
	};
	const otaFallbackCoordinator = {
		ensureIndexes: async () => true,
		hasDueWork: async () => true,
		recoverOrphanedArchivedEmails: async () => ({ scanned: 0 }),
		async runOnce() {
			fallbackRuns += 1;
			return { _id: "fallback-must-not-run" };
		},
	};
	const recoveredEvent = () => {
		const payload = { issues: [], rooms: [] };
		return {
			_id: "late-evidence-event",
			hotelId,
			status: "pending",
			attempts: 0,
			messageUid: "late-evidence-message",
			hotelRunnerReservationId: "late-evidence-hotelrunner-id",
			payloadHash: "a".repeat(64),
			canonicalHash: "b".repeat(64),
			sourceUpdatedAt: new Date("2026-08-10T16:00:00.000Z"),
			integrityReason: "",
			payload,
			toObject() {
				return { ...this, payload };
			},
		};
	};
	const dependencies = {
		EventModel,
		SyncStateModel,
		otaFallbackCoordinator,
		HotelModel: {
			findOne: () => ({
				select() {
					return this;
				},
				lean() {
					return this;
				},
				exec: async () => ({
					_id: hotelId,
					belongsTo: "64b000000000000000000002",
				}),
			}),
		},
		projectReservation: async () => {
			projections += 1;
			return { status: "created" };
		},
		createPullSync: () => ({
			runIfDue: async () => ({ status: "disabled" }),
		}),
	};
	const owner = createHotelRunnerWorker({
		config: {
			configured: true,
			hotelId,
			projectionEnabled: true,
			pullEnabled: false,
		},
		instanceId: "late-evidence-owner",
		dependencies: {
			...dependencies,
			lateEvidenceRecovery: {
				async scanOnce() {
					ownerScans += 1;
					event = recoveredEvent();
					return { requeued: true };
				},
			},
		},
	});
	const nonOwner = createHotelRunnerWorker({
		config: {
			configured: true,
			hotelId,
			projectionEnabled: true,
			pullEnabled: false,
		},
		instanceId: "late-evidence-non-owner",
		dependencies: {
			...dependencies,
			lateEvidenceRecovery: {
				async scanOnce() {
					nonOwnerScans += 1;
					return { requeued: false };
				},
			},
		},
	});

	const dueAt = Date.now() + LATE_EVIDENCE_RECOVERY_INTERVAL_MS;
	assert.ok(await owner.claimProjectionLease(new Date(dueAt)));
	assert.equal(await nonOwner.runOnce(dueAt), false);
	assert.equal(nonOwnerScans, 0);
	await owner.releaseProjectionLease();

	assert.equal(await owner.runOnce(dueAt + 1), true);
	assert.equal(ownerScans, 1);
	assert.equal(projections, 1);
	assert.equal(fallbackRuns, 0);
});

test("a shared-identity quarantine is terminal and does not burn retry attempts", async () => {
	const normalized = normalizeHotelRunnerReservation({
		message_uid: "worker-shared-identity-quarantine",
		reservation_id: "hr-online-1",
		hr_number: "R-ONLINE-1",
		channel: "online",
		state: "confirmed",
		guest: "Synthetic Guest",
		checkin_date: "2026-08-10",
		checkout_date: "2026-08-11",
		updated_at: "2026-08-06T12:00:00.000Z",
		total_guests: 1,
		total_rooms: 1,
		total: "100",
		currency: "SAR",
		rooms: [
			{
				id: "room-1",
				state: "confirmed",
				inv_code: "INV-1",
				checkin_date: "2026-08-10",
				checkout_date: "2026-08-11",
				nights: 1,
				total_guest: 1,
				total_adult: 1,
				price: "100",
				total: "100",
				daily_prices: [{ date: "2026-08-10", price: "100" }],
			},
		],
	});
	assert.deepEqual(normalized.issues, []);
	const event = {
		_id: "event-shared-identity-quarantine",
		hotelId: "64b000000000000000000001",
		attempts: 1,
		leaseOwner: "shared-identity-worker",
		messageUid: normalized.messageUid,
		hotelRunnerReservationId: normalized.hotelRunnerReservationId,
		sourceUpdatedAt: normalized.sourceUpdatedAt,
		payloadHash: normalized.payloadHash,
		canonicalHash: normalized.canonicalHash,
		payload: normalized.storedPayload,
		toObject() {
			return { ...this };
		},
	};
	let eventFinishUpdate = null;
	const query = (value) => ({
		select() {
			return this;
		},
		exec: async () => value,
	});
	const EventModel = {
		findOneAndUpdate(filter) {
			return query(filter.status?.$in ? event : null);
		},
		updateOne(filter, update) {
			eventFinishUpdate = { filter, update };
			return query({ matchedCount: 1 });
		},
	};
	const worker = createHotelRunnerWorker({
		config: {
			configured: true,
			hotelId: event.hotelId,
			projectionEnabled: true,
			pullEnabled: false,
		},
		instanceId: event.leaseOwner,
		dependencies: {
			otaFallbackCoordinator: null,
			EventModel,
			SyncStateModel: {
				updateOne: () => query({ matchedCount: 1 }),
				findOneAndUpdate: () => query({ _id: "sync-state-1" }),
			},
			HotelModel: {
				findOne: () => ({
					select() {
						return this;
					},
					lean() {
						return this;
					},
					exec: async () => ({
						_id: event.hotelId,
						belongsTo: "64b000000000000000000002",
					}),
				}),
			},
			projectReservation: async () => ({
				status: "quarantined",
				code: "hotelrunner_shared_identity_required",
				mirrorId: "mirror-unsafe-identity",
			}),
			createPullSync: () => ({ runIfDue: async () => ({ status: "disabled" }) }),
		},
	});

	assert.equal(await worker.runOnce(), true);
	assert.equal(eventFinishUpdate.update.$set.status, "quarantined");
	assert.equal(
		eventFinishUpdate.update.$set.errorCode,
		"hotelrunner_shared_identity_required"
	);
	assert.equal(eventFinishUpdate.update.$set.processedAt instanceof Date, true);
	assert.equal(eventFinishUpdate.update.$set.nextAttemptAt, undefined);
});

test("an expired eighth claim gets one idempotent recovery and cannot remain stuck", async () => {
	const event = {
		_id: "event-final-attempt-crash",
		status: "processing",
		attempts: 8,
		leaseOwner: "crashed-worker",
		leaseUntil: new Date("2026-08-06T10:00:00.000Z"),
		finalRecoveryAttempted: false,
	};
	const query = (value) => ({
		select() {
			return this;
		},
		exec: async () => value,
	});
	const EventModel = {
		findOneAndUpdate(filter, update) {
			const expired =
				event.status === "processing" &&
				event.attempts >= 8 &&
				new Date(event.leaseUntil).getTime() <=
					new Date(filter.leaseUntil.$lte).getTime();
			const finalRecoveryFilter = filter.finalRecoveryAttempted;
			const matchesRecoveryClaim =
				expired &&
				finalRecoveryFilter?.$ne === true &&
				event.finalRecoveryAttempted !== true;
			const matchesAbandonedRecovery =
				expired &&
				finalRecoveryFilter === true &&
				event.finalRecoveryAttempted === true;
			if (!matchesRecoveryClaim && !matchesAbandonedRecovery) return query(null);
			Object.assign(event, update.$set || {});
			for (const key of Object.keys(update.$unset || {})) delete event[key];
			return query({ ...event });
		},
	};
	const worker = createHotelRunnerWorker({
		config: {
			configured: true,
			hotelId: "64b000000000000000000001",
			pullEnabled: false,
		},
		instanceId: "recovery-worker",
		dependencies: {
			EventModel,
			SyncStateModel: {},
			createPullSync: () => ({ runIfDue: async () => ({ status: "disabled" }) }),
		},
	});

	const recovered = await worker.claimExpiredExhaustedEvent(
		new Date("2026-08-06T10:01:00.000Z")
	);
	assert.equal(recovered.finalRecoveryAttempted, true);
	assert.equal(recovered.leaseOwner, "recovery-worker");
	assert.equal(recovered.attempts, 8, "recovery must not create an unbounded attempt loop");

	// Simulate a second process death. Once the recovery lease expires, the next
	// worker atomically makes the event visible as a failure instead of leaving it
	// in processing forever.
	event.leaseUntil = new Date("2026-08-06T10:03:00.000Z");
	const failed = await worker.failAbandonedFinalRecovery(
		new Date("2026-08-06T10:04:00.000Z")
	);
	assert.equal(failed.status, "failed");
	assert.equal(failed.errorCode, "HOTELRUNNER_FINAL_RECOVERY_LEASE_EXPIRED");
	assert.equal(Object.hasOwn(failed, "leaseOwner"), false);
});

test("only cutoff-eligible pushes and fully bound targeted lookup events can project", () => {
	const cutoff = new Date("2026-08-09T12:00:00.000Z");
	const filter = buildProjectionEligibilityFilter(cutoff);
	assert.equal(filter.$or.length, 2);

	const push = filter.$or.find((branch) => branch.source === "push");
	assert.deepEqual(push, {
		source: "push",
		receivedAt: { $gte: cutoff },
		sourceUpdatedAt: { $gte: cutoff },
	});

	const pull = filter.$or.find((branch) => branch.source?.$in);
	assert.deepEqual(pull.source, { $in: ["pull", "push"] });
	assert.equal(pull[`${TARGETED_LOOKUP_MARKER_PATH}.version`], 1);
	assert.equal(
		pull[`${TARGETED_LOOKUP_MARKER_PATH}.origin`],
		"targeted_identity_lookup"
	);
	assert.equal(
		pull[`${TARGETED_LOOKUP_MARKER_PATH}.projectable`],
		true
	);
	assert.deepEqual(
		pull[`${TARGETED_LOOKUP_MARKER_PATH}.jobId`],
		{ $exists: true, $type: "string", $ne: "" }
	);
	assert.deepEqual(
		pull[`${TARGETED_LOOKUP_MARKER_PATH}.provider`].$in,
		["agoda", "airbnb", "booking", "expedia", "hotels", "trip"]
	);
	assert.deepEqual(
		pull[`${TARGETED_LOOKUP_MARKER_PATH}.confirmationNumber`],
		{ $exists: true, $type: "string", $ne: "" }
	);
	assert.equal(
		pull[`${TARGETED_LOOKUP_MARKER_PATH}.archiveFingerprint`].$regex.source,
		"^[a-f0-9]{64}$"
	);
	assert.deepEqual(
		pull[`${TARGETED_LOOKUP_MARKER_PATH}.markedAt`],
		{ $type: "date" }
	);
	assert.ok(
		Object.keys(pull).length > 2,
		"targeted source plus projectable:true alone must never admit an event"
	);
});

function createFallbackWorkerHarness({
	event = null,
	eventAfterLease = null,
	fallbackDue = true,
	leaseAvailable = true,
	recoveryMakesDue = false,
} = {}) {
	const hotelId = "64b000000000000000000001";
	const instanceId = "fallback-property-worker";
	const order = [];
	const state = { hotelId };
	let due = fallbackDue;
	let fallbackRuns = 0;
	let recoveryRuns = 0;
	let ensureIndexRuns = 0;
	const query = (resolve) => ({
		select() {
			return this;
		},
		exec: async () => (typeof resolve === "function" ? resolve() : resolve),
	});
	const EventModel = {
		exists() {
			return query(() =>
				event && ["pending", "retry", "processing"].includes(event.status)
					? { _id: event._id }
					: null
			);
		},
		findOneAndUpdate(filter, update) {
			return query(() => {
				if (filter.status?.$in && event?.status === "pending") {
					Object.assign(event, update.$set || {});
					event.attempts = Number(event.attempts || 0) + 1;
					order.push("event-claimed");
					return event;
				}
				return null;
			});
		},
		updateOne(_filter, update) {
			return query(() => {
				if (event) {
					Object.assign(event, update.$set || {});
					for (const key of Object.keys(update.$unset || {})) delete event[key];
				}
				return { matchedCount: 1 };
			});
		},
	};
	const SyncStateModel = {
		updateOne(filter, update) {
			return query(() => {
				if (
					filter.projectionLeaseOwner &&
					state.projectionLeaseOwner !== filter.projectionLeaseOwner
				) {
					return { matchedCount: 0 };
				}
				Object.assign(state, update.$set || {});
				for (const key of Object.keys(update.$unset || {})) delete state[key];
				if (update.$unset?.projectionLeaseOwner) order.push("lease-released");
				return { matchedCount: 1 };
			});
		},
		findOneAndUpdate(_filter, update) {
			return query(() => {
				if (!leaseAvailable) return null;
				Object.assign(state, update.$set || {});
				order.push("lease-claimed");
				if (!event && eventAfterLease) event = eventAfterLease;
				return { ...state };
			});
		},
	};
	const otaFallbackCoordinator = {
		async ensureIndexes() {
			ensureIndexRuns += 1;
			return true;
		},
		async hasDueWork() {
			return due;
		},
		async recoverOrphanedArchivedEmails() {
			assert.equal(state.projectionLeaseOwner, instanceId);
			recoveryRuns += 1;
			order.push("fallback-recovery");
			if (recoveryMakesDue) due = true;
			return { scanned: 1, enqueued: recoveryMakesDue ? 1 : 0 };
		},
		async runOnce() {
			assert.equal(state.projectionLeaseOwner, instanceId);
			fallbackRuns += 1;
			order.push("fallback-run");
			due = false;
			return { _id: `fallback-${fallbackRuns}` };
		},
	};
	const worker = createHotelRunnerWorker({
		config: {
			configured: true,
			hotelId,
			hrIdFingerprint: "a".repeat(64),
			projectionEnabled: true,
			projectionNotBefore: new Date("2026-08-09T00:00:00.000Z"),
			pullEnabled: false,
			otaEmailFallbackGraceMs: 180_000,
			otaEmailFallbackLeaseMs: 300_000,
			otaEmailFallbackProofTtlMs: 120_000,
			otaEmailFallbackMaxAttempts: 12,
		},
		instanceId,
		dependencies: {
			EventModel,
			SyncStateModel,
			otaFallbackCoordinator,
			HotelModel: {
				findOne: () => ({
					select() {
						return this;
					},
					lean() {
						return this;
					},
					exec: async () => ({
						_id: hotelId,
						belongsTo: "64b000000000000000000002",
					}),
				}),
			},
			projectReservation: async () => {
				order.push("event-projected");
				return { status: "created" };
			},
			createPullSync: () => ({
				runIfDue: async () => ({ status: "disabled" }),
			}),
		},
	});
	return {
		worker,
		order,
		state,
		counts: () => ({ fallbackRuns, recoveryRuns, ensureIndexRuns }),
	};
}

test("an eligible HotelRunner event always projects before a due email fallback", async () => {
	const payload = {
		issues: [],
		rooms: [],
	};
	const event = {
		_id: "target-event",
		hotelId: "64b000000000000000000001",
		status: "pending",
		attempts: 0,
		messageUid: "target-event-message",
		hotelRunnerReservationId: "target-hotelrunner-reservation",
		payloadHash: "b".repeat(64),
		canonicalHash: "c".repeat(64),
		sourceUpdatedAt: new Date("2026-08-09T12:00:00.000Z"),
		payload,
		toObject() {
			return { ...this, payload };
		},
	};
	const harness = createFallbackWorkerHarness({ event, fallbackDue: true });
	assert.equal(await harness.worker.runOnce(), true);
	assert.deepEqual(harness.order, [
		"lease-claimed",
		"event-claimed",
		"event-projected",
		"fallback-recovery",
		"lease-released",
	]);
	assert.equal(harness.counts().fallbackRuns, 0);
	assert.equal(harness.counts().recoveryRuns, 1);
});

test("an event archived after the readiness probe still preempts fallback under lease", async () => {
	const payload = { issues: [], rooms: [] };
	const eventAfterLease = {
		_id: "racing-target-event",
		hotelId: "64b000000000000000000001",
		status: "pending",
		attempts: 0,
		messageUid: "racing-target-message",
		hotelRunnerReservationId: "racing-target-hotelrunner-reservation",
		payloadHash: "e".repeat(64),
		canonicalHash: "f".repeat(64),
		sourceUpdatedAt: new Date("2026-08-09T12:01:00.000Z"),
		payload,
		toObject() {
			return { ...this, payload };
		},
	};
	const harness = createFallbackWorkerHarness({
		eventAfterLease,
		fallbackDue: true,
	});
	assert.equal(await harness.worker.runOnce(), true);
	assert.deepEqual(harness.order, [
		"lease-claimed",
		"event-claimed",
		"event-projected",
		"fallback-recovery",
		"lease-released",
	]);
	assert.equal(harness.counts().fallbackRuns, 0);
});

test("due orphan recovery cannot be starved by an existing fallback backlog", async () => {
	const harness = createFallbackWorkerHarness({ fallbackDue: true });
	assert.equal(await harness.worker.runOnce(), true);
	assert.equal(harness.counts().fallbackRuns, 1);
	assert.equal(harness.counts().recoveryRuns, 1);
	assert.equal(harness.counts().ensureIndexRuns, 1);
	assert.deepEqual(harness.order, [
		"lease-claimed",
		"fallback-recovery",
		"fallback-run",
		"lease-released",
	]);
});

test("worker construction passes every bounded fallback limit to the coordinator", () => {
	let captured = null;
	const otaFallbackDependencies = { sentinel: true };
	createHotelRunnerWorker({
		config: {
			configured: true,
			hotelId: "64b000000000000000000001",
			hrIdFingerprint: "d".repeat(64),
			projectionEnabled: true,
			pullEnabled: false,
			otaEmailFallbackGraceMs: 181_000,
			otaEmailFallbackLeaseMs: 301_000,
			otaEmailFallbackProofTtlMs: 121_000,
			otaEmailFallbackMaxAttempts: 11,
		},
		instanceId: "fallback-limit-worker",
		dependencies: {
			otaFallbackDependencies,
			createOtaFallbackCoordinator(options) {
				captured = options;
				return {
					ensureIndexes: async () => true,
					hasDueWork: async () => false,
					recoverOrphanedArchivedEmails: async () => ({ scanned: 0 }),
					runOnce: async () => null,
				};
			},
			createPullSync: () => ({
				runIfDue: async () => ({ status: "disabled" }),
			}),
		},
	});
	assert.equal(captured.instanceId, "fallback-limit-worker");
	assert.equal(captured.graceMs, 181_000);
	assert.equal(captured.leaseMs, 301_000);
	assert.equal(captured.negativeProofTtlMs, 121_000);
	assert.equal(captured.maxAttempts, 11);
	assert.equal(captured.dependencies, otaFallbackDependencies);
});

test("orphan recovery and its recovered fallback both stay inside the property lease", async () => {
	const harness = createFallbackWorkerHarness({
		fallbackDue: false,
		recoveryMakesDue: true,
	});
	assert.equal(await harness.worker.runOnce(), true);
	assert.deepEqual(harness.order, [
		"lease-claimed",
		"fallback-recovery",
		"fallback-run",
		"lease-released",
	]);
	assert.deepEqual(harness.counts(), {
		fallbackRuns: 1,
		recoveryRuns: 1,
		ensureIndexRuns: 1,
	});
});

test("a worker that cannot own the property lease cannot run email fallback", async () => {
	const harness = createFallbackWorkerHarness({
		fallbackDue: true,
		leaseAvailable: false,
	});
	assert.equal(await harness.worker.runOnce(), false);
	assert.equal(harness.counts().fallbackRuns, 0);
	assert.equal(harness.counts().recoveryRuns, 0);
	assert.deepEqual(harness.order, []);
});
