/** @format */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
	ensureHotelRunnerIndexes,
	eventInsertDocument,
	loadConfiguredHotel,
	persistHotelRunnerBatch,
	persistHotelRunnerDelivery,
	resetHotelRunnerIndexesPromiseForTests,
	safeErrorMessage,
} = require("./hotelrunnerEventService");

test("explicit HotelRunner index bootstrap creates indexes only for integration models", async () => {
	const created = [];
	const unexpectedInit = [];
	const integrationModel = (name) => ({
		init: async () => {
			unexpectedInit.push(name);
		},
		createIndexes: async () => {
			created.push(name);
		},
	});
	let reservationInitCalls = 0;
	let reservationCreateIndexCalls = 0;

	await ensureHotelRunnerIndexes({
		EventModel: integrationModel("event"),
		MirrorModel: integrationModel("mirror"),
		MappingModel: integrationModel("mapping"),
		BudgetModel: integrationModel("budget"),
		SyncStateModel: integrationModel("sync-state"),
		// Deliberately supplied as a trap. The integration bootstrap has no
		// ReservationModel slot and must never initialize the packed collection.
		ReservationModel: {
			init: async () => {
				reservationInitCalls += 1;
			},
			createIndexes: async () => {
				reservationCreateIndexCalls += 1;
			},
		},
	});

	assert.deepEqual(created.sort(), [
		"budget",
		"event",
		"mapping",
		"mirror",
		"sync-state",
	]);
	assert.deepEqual(unexpectedInit, []);
	assert.equal(reservationInitCalls, 0);
	assert.equal(reservationCreateIndexCalls, 0);
});

test("failed explicit HotelRunner index bootstrap clears its cached promise for retry", async () => {
	resetHotelRunnerIndexesPromiseForTests();
	const attempts = new Map();
	const integrationModel = (name, failFirst = false) => ({
		createIndexes: async () => {
			const attempt = (attempts.get(name) || 0) + 1;
			attempts.set(name, attempt);
			if (failFirst && attempt === 1) throw new Error("index creation failed");
		},
	});
	const models = {
		EventModel: integrationModel("event", true),
		MirrorModel: integrationModel("mirror"),
		MappingModel: integrationModel("mapping"),
		BudgetModel: integrationModel("budget"),
		SyncStateModel: integrationModel("sync-state"),
	};

	try {
		await assert.rejects(
			ensureHotelRunnerIndexes(models, { useCachedPromise: true }),
			/index creation failed/
		);
		await ensureHotelRunnerIndexes(models, { useCachedPromise: true });
		assert.equal(attempts.get("event"), 2);
		assert.equal(attempts.get("mirror"), 2);
		assert.equal(attempts.get("mapping"), 2);
		assert.equal(attempts.get("budget"), 2);
		assert.equal(attempts.get("sync-state"), 2);
	} finally {
		resetHotelRunnerIndexesPromiseForTests();
	}
});

test("callback hotel loading remains available when only worker configuration is invalid", async () => {
	const hotel = {
		_id: "64b000000000000000000001",
		belongsTo: "64b000000000000000000002",
	};
	const HotelModel = {
		findOne: () => ({
			select() {
				return this;
			},
			lean() {
				return this;
			},
			exec: async () => hotel,
		}),
	};
	const config = {
		configured: false,
		callbackConfigured: true,
		hotelId: hotel._id,
	};

	assert.equal(
		await loadConfiguredHotel(config, { HotelModel, readiness: "callback" }),
		hotel,
	);
	await assert.rejects(
		loadConfiguredHotel(config, { HotelModel }),
		(error) => error?.code === "HOTELRUNNER_CONFIG_INVALID",
	);
});

const rawReservation = (overrides = {}) => ({
	message_uid: "durable-event-uid-1",
	reservation_id: "hr-reservation-1",
	hr_number: "R-1",
	provider_number: "BOOKING-1",
	channel: "bookingcom",
	channel_display: "Booking.com",
	state: "confirmed",
	modified: false,
	guest: "Durable Guest",
	checkin_date: "2026-08-10",
	checkout_date: "2026-08-12",
	updated_at: "2026-08-06T10:00:00.000Z",
	total_guests: 2,
	total_rooms: 1,
	total: "200.00",
	sub_total: "200.00",
	currency: "SAR",
	rooms: [
		{
			id: "room-delivery-1",
			state: "confirmed",
			inv_code: "INV-DOUBLE",
			rate_code: "BAR",
			rate_plan_code: "ROOM_ONLY",
			name: "Double Room",
			checkin_date: "2026-08-10",
			checkout_date: "2026-08-12",
			nights: 2,
			total_guest: 2,
			total_adult: 2,
			child_ages: [],
			price: "200.00",
			total: "200.00",
			daily_prices: [
				{ date: "2026-08-10", price: "100.00" },
				{ date: "2026-08-11", price: "100.00" },
			],
		},
	],
	...overrides,
});

test("future source timestamps are quarantined before push or pull projection", () => {
	const receivedAt = new Date("2026-08-06T10:00:00.000Z");
	for (const source of ["push", "pull"]) {
		const prepared = eventInsertDocument({
			config: { hrIdFingerprint: "synthetic-property-fingerprint" },
			hotel: { _id: "64b000000000000000000001" },
			rawReservation: rawReservation({
				message_uid: `future-${source}`,
				updated_at: "2026-08-07T10:00:00.000Z",
			}),
			source,
			receivedAt,
		});
		assert.equal(prepared.document.source, source);
		assert.equal(prepared.document.status, "quarantined");
		assert.equal(
			prepared.document.integrityReason,
			"source_updated_at_too_far_in_future"
		);
		assert.equal(prepared.document.sourceUpdatedAt, receivedAt);
		assert.equal(prepared.normalized.sourceUpdatedAt, null);
	}
});

function createEventModel() {
	const byKey = new Map();
	let sequence = 0;
	return {
		byKey,
		findOneAndUpdate(filter, update) {
			return {
				exec: async () => {
					if (Array.isArray(update)) {
						const event = Array.from(byKey.values()).find(
							(candidate) => String(candidate._id) === String(filter._id)
						);
						if (!event || event.payloadHash !== filter.payloadHash) return null;
						const setStage = update[0].$set;
						const conflict =
							setStage.integrityConflicts.$slice[0].$concatArrays[1][0].$literal;
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
					let event = byKey.get(filter.eventKey);
					if (!event) {
						event = {
							_id: `event-${++sequence}`,
							deliveryCount: 0,
							...(update.$setOnInsert || {}),
						};
						byKey.set(filter.eventKey, event);
					}
					Object.assign(event, update.$set || {});
					for (const [key, value] of Object.entries(update.$inc || {})) {
						event[key] = Number(event[key] || 0) + Number(value || 0);
					}
					return event;
				},
			};
		},
		updateOne(filter, update) {
			return {
				exec: async () => {
					const event = Array.from(byKey.values()).find(
						(candidate) => String(candidate._id) === String(filter._id)
					);
					if (!event) return { matchedCount: 0 };
					if (filter.status && event.status !== filter.status) {
						return { matchedCount: 0, modifiedCount: 0 };
					}
					if (filter.payloadHash && event.payloadHash !== filter.payloadHash) {
						return { matchedCount: 0, modifiedCount: 0 };
					}
					if (
						filter.integrityReason?.$in &&
						!filter.integrityReason.$in.includes(event.integrityReason ?? null)
					) {
						return { matchedCount: 0, modifiedCount: 0 };
					}
					if (
						filter["integrityConflicts.0"]?.$exists === false &&
						Array.isArray(event.integrityConflicts) &&
						event.integrityConflicts.length > 0
					) {
						return { matchedCount: 0, modifiedCount: 0 };
					}
					Object.assign(event, update.$set || {});
					for (const key of Object.keys(update.$unset || {})) delete event[key];
					for (const [key, instruction] of Object.entries(update.$push || {})) {
						if (!Array.isArray(event[key])) event[key] = [];
						const values = instruction?.$each || [instruction];
						event[key].push(...values);
						if (Number.isInteger(instruction?.$slice) && instruction.$slice < 0) {
							event[key] = event[key].slice(instruction.$slice);
						}
					}
					return { matchedCount: 1, modifiedCount: 1 };
				},
			};
		},
	};
}

const eventDependencies = (EventModel, overrides = {}) => ({
	EventModel,
	markHotelRunnerFallbackApiObserved: async () => ({
		eligible: true,
		ordered: false,
		decision: "no_active_job",
	}),
	...overrides,
});

test("stored and logged errors redact credentials and connection URI userinfo", () => {
	const message = safeErrorMessage(
		new Error(
			"mongodb://database-user:database-password@db.internal/pms token=api-secret hr_id=property-secret"
		)
	);
	assert.equal(message.includes("database-user"), false);
	assert.equal(message.includes("database-password"), false);
	assert.equal(message.includes("api-secret"), false);
	assert.equal(message.includes("property-secret"), false);
	assert.match(message, /\[REDACTED\]/);
});

test("push ingress decision is durable before event insert and a marker failure is retryable", async () => {
	const EventModel = createEventModel();
	const observations = [];
	const context = {
		config: {
			hrIdFingerprint: "synthetic-property-fingerprint",
			callbackMaxReservations: 100,
		},
		hotel: { _id: "64b000000000000000000001" },
		rawReservation: rawReservation(),
		source: "push",
		receivedAt: new Date("2026-08-06T10:01:00.000Z"),
	};
	const markerError = new Error("synthetic ingress marker outage");
	markerError.code = "HOTELRUNNER_FALLBACK_API_ORDER_UNCERTAIN";
	markerError.retryable = true;
	await assert.rejects(
		persistHotelRunnerDelivery(
			context,
			eventDependencies(EventModel, {
				markHotelRunnerFallbackApiObserved: async (observation) => {
					observations.push(observation);
					throw markerError;
				},
			})
		),
		(error) => error === markerError && error.retryable === true
	);
	assert.equal(EventModel.byKey.size, 0);
	assert.equal(observations.length, 1);
	assert.equal(observations[0].provider, "bookingcom");
	assert.equal(observations[0].confirmationNumber, "BOOKING-1");
	assert.match(observations[0].observationKey, /^[a-f0-9]{64}$/);

	await persistHotelRunnerDelivery(
		context,
		eventDependencies(EventModel, {
			markHotelRunnerFallbackApiObserved: async (observation) => {
				observations.push(observation);
				return { eligible: true, ordered: true, decision: "api_observed" };
			},
		})
	);
	assert.equal(EventModel.byKey.size, 1);
	assert.equal(observations.length, 2);
});

test("same delivery UID is idempotent and a changed payload is quarantined", async () => {
	const EventModel = createEventModel();
	const context = {
		config: {
			hrIdFingerprint: "synthetic-property-fingerprint",
			callbackMaxReservations: 100,
		},
		hotel: { _id: "64b000000000000000000001" },
		rawReservation: rawReservation(),
		source: "push",
	};
	const first = await persistHotelRunnerDelivery(
		{ ...context, receivedAt: new Date("2026-08-06T10:01:00.000Z") },
		eventDependencies(EventModel)
	);
	const duplicate = await persistHotelRunnerDelivery(
		{ ...context, receivedAt: new Date("2026-08-06T10:02:00.000Z") },
		eventDependencies(EventModel)
	);
	assert.equal(first.duplicate, false);
	assert.equal(duplicate.duplicate, true);
	assert.equal(EventModel.byKey.size, 1);
	assert.equal(Array.from(EventModel.byKey.values())[0].deliveryCount, 2);

	const conflict = await persistHotelRunnerDelivery(
		{
			...context,
			rawReservation: rawReservation({ note: "different payload, same UID" }),
			receivedAt: new Date("2026-08-06T10:03:00.000Z"),
		},
		eventDependencies(EventModel)
	);
	const stored = Array.from(EventModel.byKey.values())[0];
	assert.equal(conflict.integrityConflict, true);
	assert.equal(conflict.firstPayloadWins, false);
	assert.equal(stored.status, "quarantined");
	assert.equal(stored.integrityReason, "message_uid_payload_conflict");
	assert.equal(stored.integrityConflict, true);
	assert.equal(stored.integrityConflictCount, 1);
	assert.equal(stored.integrityConflicts.length, 1);

	const originalAfterConflict = await persistHotelRunnerDelivery(
		{ ...context, receivedAt: new Date("2026-08-06T10:04:00.000Z") },
		eventDependencies(EventModel)
	);
	assert.equal(originalAfterConflict.status, "quarantined");
	assert.equal(originalAfterConflict.revived, false);
	assert.equal(stored.status, "quarantined");
	assert.equal(EventModel.byKey.size, 1);
});

test("a conflicting delivery cannot revoke an actively processing event lease", async () => {
	const EventModel = createEventModel();
	const context = {
		config: {
			hrIdFingerprint: "synthetic-property-fingerprint",
			callbackMaxReservations: 100,
		},
		hotel: { _id: "64b000000000000000000001" },
		rawReservation: rawReservation(),
		source: "push",
	};
	await persistHotelRunnerDelivery(
		{ ...context, receivedAt: new Date("2026-08-06T10:01:00.000Z") },
		eventDependencies(EventModel)
	);
	const stored = Array.from(EventModel.byKey.values())[0];
	Object.assign(stored, {
		status: "processing",
		leaseOwner: "active-projection-worker",
		leaseAcquiredAt: new Date("2026-08-06T10:01:30.000Z"),
		leaseUntil: new Date("2026-08-06T10:06:30.000Z"),
	});

	const conflict = await persistHotelRunnerDelivery(
		{
			...context,
			rawReservation: rawReservation({ note: "racing conflicting payload" }),
			receivedAt: new Date("2026-08-06T10:02:00.000Z"),
		},
		eventDependencies(EventModel)
	);

	assert.equal(conflict.integrityConflict, true);
	assert.equal(conflict.firstPayloadWins, true);
	assert.equal(conflict.activeProcessing, true);
	assert.equal(stored.status, "processing");
	assert.equal(stored.integrityReason, "");
	assert.equal(stored.leaseOwner, "active-projection-worker");
	assert.equal(
		stored.leaseUntil.toISOString(),
		"2026-08-06T10:06:30.000Z"
	);
	assert.equal(stored.integrityConflict, true);
	assert.equal(stored.integrityConflictCount, 1);
	assert.equal(stored.integrityConflicts.length, 1);
});

test("needs-mapping and non-owned processing conflicts are quarantined", async (t) => {
	const cases = [
		{
			name: "needs mapping",
			state: { status: "needs_mapping" },
		},
		{
			name: "expired processing lease",
			state: {
				status: "processing",
				leaseOwner: "expired-worker",
				leaseAcquiredAt: new Date("2026-08-06T09:55:00.000Z"),
				leaseUntil: new Date("2026-08-06T10:00:00.000Z"),
			},
		},
		{
			name: "ownerless processing lease",
			state: {
				status: "processing",
				leaseOwner: "   ",
				leaseAcquiredAt: new Date("2026-08-06T10:00:00.000Z"),
				leaseUntil: new Date("2026-08-06T10:10:00.000Z"),
			},
		},
	];
	for (const scenario of cases) {
		await t.test(scenario.name, async () => {
			const EventModel = createEventModel();
			const context = {
				config: {
					hrIdFingerprint: "synthetic-property-fingerprint",
					callbackMaxReservations: 100,
				},
				hotel: { _id: "64b000000000000000000001" },
				rawReservation: rawReservation(),
				source: "push",
			};
			await persistHotelRunnerDelivery(
				{ ...context, receivedAt: new Date("2026-08-06T09:59:00.000Z") },
				eventDependencies(EventModel)
			);
			const stored = Array.from(EventModel.byKey.values())[0];
			Object.assign(stored, scenario.state);

			const conflict = await persistHotelRunnerDelivery(
				{
					...context,
					rawReservation: rawReservation({ note: scenario.name }),
					receivedAt: new Date("2026-08-06T10:01:00.000Z"),
				},
				eventDependencies(EventModel)
			);

			assert.equal(conflict.status, "quarantined");
			assert.equal(conflict.firstPayloadWins, false);
			assert.equal(stored.integrityReason, "message_uid_payload_conflict");
			assert.equal(stored.integrityConflict, true);
			assert.equal(stored.integrityConflictCount, 1);
			assert.equal(stored.leaseOwner, "");
			assert.equal(stored.leaseUntil, null);
		});
	}
});

test("a conflict arriving after projection raises attention without losing its result", async () => {
	const EventModel = createEventModel();
	const context = {
		config: {
			hrIdFingerprint: "synthetic-property-fingerprint",
			callbackMaxReservations: 100,
		},
		hotel: { _id: "64b000000000000000000001" },
		rawReservation: rawReservation(),
		source: "push",
	};
	await persistHotelRunnerDelivery(
		{ ...context, receivedAt: new Date("2026-08-06T10:01:00.000Z") },
		eventDependencies(EventModel)
	);
	const stored = Array.from(EventModel.byKey.values())[0];
	const preservedResult = { status: "created", changedPaths: ["status"] };
	Object.assign(stored, {
		status: "completed",
		processedAt: new Date("2026-08-06T10:02:00.000Z"),
		mirrorId: "mirror-completed",
		reservationMongoId: "reservation-completed",
		result: preservedResult,
	});

	const conflict = await persistHotelRunnerDelivery(
		{
			...context,
			rawReservation: rawReservation({ note: "late conflicting payload" }),
			receivedAt: new Date("2026-08-06T10:03:00.000Z"),
		},
		eventDependencies(EventModel)
	);

	assert.equal(conflict.status, "attention");
	assert.equal(conflict.firstPayloadWins, false);
	assert.equal(stored.status, "attention");
	assert.equal(stored.integrityConflict, true);
	assert.equal(stored.integrityConflictCount, 1);
	assert.equal(stored.mirrorId, "mirror-completed");
	assert.equal(stored.reservationMongoId, "reservation-completed");
	assert.equal(stored.result, preservedResult);
	assert.equal(stored.processedAt.toISOString(), "2026-08-06T10:02:00.000Z");
});

test("exact redelivery revives a failed event but never creates another row", async () => {
	const EventModel = createEventModel();
	const context = {
		config: {
			hrIdFingerprint: "synthetic-property-fingerprint",
			callbackMaxReservations: 100,
		},
		hotel: { _id: "64b000000000000000000001" },
		rawReservation: rawReservation(),
		source: "push",
	};
	await persistHotelRunnerDelivery(
		{ ...context, receivedAt: new Date("2026-08-06T10:01:00.000Z") },
		eventDependencies(EventModel)
	);
	const stored = Array.from(EventModel.byKey.values())[0];
	Object.assign(stored, {
		status: "failed",
		attempts: 8,
		processedAt: new Date("2026-08-06T10:02:00.000Z"),
		finalRecoveryAttempted: true,
		finalRecoveryClaimedAt: new Date("2026-08-06T10:02:00.000Z"),
		leaseOwner: "expired-worker",
		leaseUntil: new Date("2026-08-06T10:03:00.000Z"),
		errorCode: "SYNTHETIC_TRANSIENT_FAILURE",
		errorMessage: "synthetic transient failure",
	});

	const redelivery = await persistHotelRunnerDelivery(
		{ ...context, receivedAt: new Date("2026-08-06T10:04:00.000Z") },
		eventDependencies(EventModel)
	);
	assert.equal(redelivery.duplicate, true);
	assert.equal(redelivery.revived, true);
	assert.equal(redelivery.status, "pending");
	assert.equal(EventModel.byKey.size, 1);
	assert.equal(stored.status, "pending");
	assert.equal(stored.attempts, 0);
	assert.equal(stored.processedAt, null);
	assert.equal(stored.finalRecoveryAttempted, false);
	assert.equal(stored.errorCode, "");
	assert.equal(Object.hasOwn(stored, "leaseOwner"), false);
});

test("a partially stored callback batch is safe to retry without duplicate events", async () => {
	const EventModel = createEventModel();
	const originalFindOneAndUpdate = EventModel.findOneAndUpdate.bind(EventModel);
	let failSecondDeliveryOnce = true;
	EventModel.findOneAndUpdate = (filter, update) => {
		if (
			failSecondDeliveryOnce &&
			update?.$setOnInsert?.messageUid === "durable-event-uid-2"
		) {
			return {
				exec: async () => {
					failSecondDeliveryOnce = false;
					throw new Error("synthetic mid-batch storage interruption");
				},
			};
		}
		return originalFindOneAndUpdate(filter, update);
	};
	const batch = {
		config: {
			hrIdFingerprint: "synthetic-property-fingerprint",
			callbackMaxReservations: 100,
		},
		hotel: { _id: "64b000000000000000000001" },
		reservations: [
			rawReservation(),
			rawReservation({
				message_uid: "durable-event-uid-2",
				reservation_id: "hr-reservation-2",
				hr_number: "R-2",
				provider_number: "BOOKING-2",
			}),
		],
		source: "push",
		receivedAt: new Date("2026-08-06T10:04:00.000Z"),
	};
	await assert.rejects(
		persistHotelRunnerBatch(batch, eventDependencies(EventModel, {
			EventModel,
			skipIndexInitialization: true,
		})),
		/synthetic mid-batch storage interruption/
	);
	assert.equal(EventModel.byKey.size, 1);

	const retryResults = await persistHotelRunnerBatch(batch, eventDependencies(EventModel, {
		EventModel,
		skipIndexInitialization: true,
	}));
	assert.equal(retryResults.length, 2);
	assert.equal(retryResults[0].duplicate, true);
	assert.equal(retryResults[1].duplicate, false);
	assert.equal(EventModel.byKey.size, 2);
	const deliveryCounts = Array.from(EventModel.byKey.values())
		.map((event) => event.deliveryCount)
		.sort((left, right) => left - right);
	assert.deepEqual(deliveryCounts, [1, 2]);
});
