/** @format */

process.env.SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "SG.test";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
	createHotelRunnerWorker,
	normalizedFromStoredEvent,
} = require("./hotelrunnerWorker");
const { normalizeHotelRunnerReservation } = require("./hotelrunnerPayload");

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
			EventModel,
			SyncStateModel: { updateOne: () => query({ matchedCount: 1 }) },
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
