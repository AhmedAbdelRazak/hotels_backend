/** @format */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
	createHotelRunnerFallbackNotificationOutbox,
	defaultEmitRefresh,
	enqueueHotelRunnerFallbackTerminalNotification,
} = require("./hotelrunnerFallbackNotificationOutbox");

const JOB_ID = "6a789cf2f77fb5bdaf73b0b3";
const EMAIL_ID = "6a789cb5f77fb5bdaf73b0b1";
const HOTEL_ID = "6a40b6a1a6efe70450536038";
const RESERVATION_ID = "6a789cea66c058f4ab621ebf";
const OUTBOX_ID = "6a789cf2f77fb5bdaf73b0c4";
const EMAIL_HASH = "a".repeat(64);

const clone = (value) => {
	if (value == null || typeof value !== "object") return value;
	if (value instanceof Date) return new Date(value);
	if (Array.isArray(value)) return value.map(clone);
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [key, clone(item)])
	);
};

const pathParts = (path) => String(path).split(".");
function setPath(target, path, value) {
	const parts = pathParts(path);
	let cursor = target;
	for (const part of parts.slice(0, -1)) {
		if (!cursor[part] || typeof cursor[part] !== "object") cursor[part] = {};
		cursor = cursor[part];
	}
	cursor[parts.at(-1)] = clone(value);
}
function unsetPath(target, path) {
	const parts = pathParts(path);
	let cursor = target;
	for (const part of parts.slice(0, -1)) {
		if (!cursor?.[part]) return;
		cursor = cursor[part];
	}
	delete cursor[parts.at(-1)];
}
function applyUpdate(target, update = {}) {
	for (const [path, value] of Object.entries(update.$set || {})) {
		setPath(target, path, value);
	}
	for (const [path, value] of Object.entries(update.$inc || {})) {
		setPath(target, path, Number(pathValue(target, path) || 0) + Number(value || 0));
	}
	for (const path of Object.keys(update.$unset || {})) unsetPath(target, path);
	return target;
}
function pathValue(target, path) {
	return pathParts(path).reduce((value, part) => value?.[part], target);
}

function mutableClock(initial = "2026-08-09T18:00:00.000Z") {
	let current = new Date(initial);
	return {
		now: () => new Date(current),
		advance(ms) {
			current = new Date(current.getTime() + ms);
		},
	};
}

function terminalJob(overrides = {}) {
	return {
		_id: JOB_ID,
		status: "completed_api",
		hotelId: HOTEL_ID,
		inboundEmailId: EMAIL_ID,
		inboundEmailHash: EMAIL_HASH,
		reservationMongoId: RESERVATION_ID,
		provider: "agoda",
		confirmationNumber: "2039878308",
		inboundAuditFinalizationStatus: "completed",
		inboundAuditFinalizedAt: new Date("2026-08-09T18:00:00.000Z"),
		result: {
			status: "updated",
			otaPlatformReviewStatus: "pending",
		},
		...overrides,
	};
}

function outboxRecord(overrides = {}) {
	return {
		_id: OUTBOX_ID,
		jobId: JOB_ID,
		terminalStatus: "completed_api",
		hotelId: HOTEL_ID,
		inboundEmailId: EMAIL_ID,
		inboundEmailHash: EMAIL_HASH,
		reservationMongoId: RESERVATION_ID,
		provider: "agoda",
		confirmationNumber: "2039878308",
		reconciliationStatus: "updated",
		otaPlatformReviewStatus: "pending",
		status: "pending",
		nextAttemptAt: new Date("2026-08-09T18:00:00.000Z"),
		attemptCount: 0,
		refresh: { status: "pending", completedAt: null },
		whatsapp: { status: "pending" },
		...overrides,
	};
}

function inboundRecord(overrides = {}) {
	return {
		_id: EMAIL_ID,
		emailHash: EMAIL_HASH,
		hotelId: HOTEL_ID,
		reservationMongoId: RESERVATION_ID,
		provider: "agoda",
		intent: "new_reservation",
		eventType: "new",
		confirmationNumber: "2039878308",
		processingStatus: "updated",
		hotelRunnerFirstFallback: {
			jobId: JOB_ID,
			status: "completed_api",
		},
		normalizedReservation: {
			provider: "agoda",
			intent: "new_reservation",
			eventType: "new",
			confirmationNumber: "2039878308",
		},
		reconciliation: {
			status: "updated",
			reservationId: RESERVATION_ID,
		},
		airbnbWhatsappNotification: { status: "not_required", attemptKey: "" },
		...overrides,
	};
}

function createMemoryStore(initial, clock, options = {}) {
	const state = clone(initial);
	let completionFailureRemaining = Number(options.completionFailureCount || 0);
	const owned = (candidate, snapshot, now) =>
		candidate.status === "processing" &&
		candidate.leaseOwner === snapshot.leaseOwner &&
		candidate.leaseToken === snapshot.leaseToken &&
		candidate.leaseUntil instanceof Date &&
		candidate.leaseUntil.getTime() > now.getTime();
	return {
		state,
		async ensureIndexes() {
			return true;
		},
		async claim({ instanceId, leaseToken, now, leaseUntil }) {
			if (
				!["pending", "retry", "processing"].includes(state.status) ||
				state.nextAttemptAt.getTime() > now.getTime() ||
				(state.leaseUntil && state.leaseUntil.getTime() > now.getTime())
			) {
				return null;
			}
			state.status = "processing";
			state.leaseOwner = instanceId;
			state.leaseToken = leaseToken;
			state.leaseAcquiredAt = new Date(now);
			state.leaseUntil = new Date(leaseUntil);
			state.attemptCount += 1;
			return clone(state);
		},
		async renewOwned(snapshot, now, leaseUntil) {
			if (!owned(state, snapshot, now)) return null;
			state.leaseUntil = new Date(leaseUntil);
			return clone(state);
		},
		async updateOwned(snapshot, update, now) {
			if (!owned(state, snapshot, now)) return null;
			if (
				completionFailureRemaining > 0 &&
				update.$set?.["whatsapp.status"] === "completed"
			) {
				completionFailureRemaining -= 1;
				const error = new Error("simulated crash after provider submission");
				error.code = "SIMULATED_POST_SUBMISSION_CRASH";
				throw error;
			}
			applyUpdate(state, update);
			return clone(state);
		},
	};
}

test("API-win notification enqueue survives a crash after durable outbox insert and remains unique", async () => {
	const job = terminalJob();
	const records = new Map();
	let markerAttempts = 0;
	const dependencies = {
		loadTerminalJob: async () => clone(job),
		upsertOutbox: async (document) => {
			if (!records.has(String(document.jobId))) {
				records.set(String(document.jobId), { _id: OUTBOX_ID, ...clone(document) });
			}
			return clone(records.get(String(document.jobId)));
		},
		markTerminalJobEnqueued: async () => {
			markerAttempts += 1;
			if (markerAttempts === 1) throw new Error("simulated marker crash");
			return true;
		},
	};

	await assert.rejects(
		enqueueHotelRunnerFallbackTerminalNotification({ job }, dependencies),
		/simulated marker crash/
	);
	const recovered = await enqueueHotelRunnerFallbackTerminalNotification(
		{ job },
		dependencies
	);

	assert.equal(records.size, 1);
	assert.equal(String(recovered.jobId), JOB_ID);
	assert.equal(recovered.terminalStatus, "completed_api");
	assert.equal(markerAttempts, 2);
});

test("API-win outbox emits the terminal refresh once and completes without WhatsApp", async () => {
	const clock = mutableClock();
	const store = createMemoryStore(outboxRecord(), clock);
	let refreshCount = 0;
	let whatsappCount = 0;
	const dependencies = {
			clock: clock.now,
			store,
			recoverPendingTerminalJobs: async () => 0,
			loadArchivedInbound: async () => inboundRecord(),
			loadReservation: async () => ({
				_id: RESERVATION_ID,
				hotelId: HOTEL_ID,
				otaPlatformReview: { status: "pending" },
			}),
			emitRefresh: async () => {
				refreshCount += 1;
			},
			isRelevantAirbnbEvent: () => false,
			sendAirbnbNotification: async () => {
				whatsappCount += 1;
			},
	};
	const processorA = createHotelRunnerFallbackNotificationOutbox({
		instanceId: "pm2-a",
		dependencies: { ...dependencies, randomToken: () => "1".repeat(32) },
	});
	const processorB = createHotelRunnerFallbackNotificationOutbox({
		instanceId: "pm2-b",
		dependencies: { ...dependencies, randomToken: () => "3".repeat(32) },
	});

	await Promise.all([processorA.processNext(), processorB.processNext()]);
	await processorA.processNext();

	assert.equal(store.state.status, "completed");
	assert.equal(store.state.refresh.status, "completed");
	assert.equal(store.state.whatsapp.status, "not_required");
	assert.equal(refreshCount, 1);
	assert.equal(whatsappCount, 0);
});

test("email-fallback Airbnb submission is not repeated after a crash before outbox completion", async () => {
	const clock = mutableClock();
	const store = createMemoryStore(
		outboxRecord({
			terminalStatus: "completed_email_fallback",
			provider: "airbnb",
			confirmationNumber: "1234567890",
			reconciliationStatus: "created",
		}),
		clock,
		{ completionFailureCount: 1 }
	);
	const archived = inboundRecord({
		provider: "airbnb",
		confirmationNumber: "1234567890",
		processingStatus: "created",
		hotelRunnerFirstFallback: {
			jobId: JOB_ID,
			status: "completed_email_fallback",
		},
		normalizedReservation: {
			provider: "airbnb",
			intent: "new_reservation",
			eventType: "new",
			confirmationNumber: "1234567890",
		},
		reconciliation: {
			status: "created",
			reservationId: RESERVATION_ID,
		},
	});
	let refreshCount = 0;
	let submissionCount = 0;
	const processor = createHotelRunnerFallbackNotificationOutbox({
		instanceId: "pm2-a",
		dependencies: {
			clock: clock.now,
			store,
			randomToken: () => "2".repeat(32),
			recoverPendingTerminalJobs: async () => 0,
			loadArchivedInbound: async () => clone(archived),
			loadReservation: async () => ({
				_id: RESERVATION_ID,
				hotelId: HOTEL_ID,
				otaPlatformReview: { status: "pending" },
			}),
			emitRefresh: async () => {
				refreshCount += 1;
			},
			isRelevantAirbnbEvent: () => true,
			claimAirbnbAttempt: async ({ attemptKey, claimedAt }) => {
				const audit = archived.airbnbWhatsappNotification;
				if (audit.attemptKey) return { claimed: false, record: clone(archived) };
				Object.assign(audit, {
					status: "outbox_claimed",
					attemptKey,
					outboxId: OUTBOX_ID,
					claimedAt,
					attemptedAt: claimedAt,
				});
				return { claimed: true, record: clone(archived) };
			},
			persistAirbnbAttemptAudit: async ({ audit }) => {
				Object.assign(archived.airbnbWhatsappNotification, clone(audit));
				return clone(archived);
			},
			sendAirbnbNotification: async (_context, dependencies) => {
				submissionCount += 1;
				const attemptedAt = clock.now();
				const audit = {
					status: "submitted",
					message: "New reservation | Ref 1234567890",
					recipients: ["+19092223374"],
					deliveries: [{ to: "+19092223374", status: "submitted" }],
					attemptedAt,
					completedAt: clock.now(),
				};
				await dependencies.persistAudit({ audit });
				return { attempted: true, ...audit };
			},
		},
	});

	await processor.processNext();
	assert.equal(store.state.status, "retry");
	assert.equal(submissionCount, 1);
	assert.equal(archived.airbnbWhatsappNotification.status, "submitted");

	clock.advance(5_001);
	await processor.processNext();
	await processor.processNext();

	assert.equal(store.state.status, "completed");
	assert.equal(store.state.whatsapp.status, "completed");
	assert.equal(submissionCount, 1);
	assert.equal(refreshCount, 1);
});

test("email-create acknowledgement replay still emits the pending-platform refresh", async () => {
	const clock = mutableClock();
	const store = createMemoryStore(
		outboxRecord({
			terminalStatus: "completed_email_fallback",
			reconciliationStatus: "duplicate_reservation",
		}),
		clock
	);
	const events = [];
	const io = {
		emit(name, payload) {
			events.push({ room: "global", name, payload });
		},
		to(room) {
			return {
				emit(name, payload) {
					events.push({ room, name, payload });
				},
			};
		},
	};
	const processor = createHotelRunnerFallbackNotificationOutbox({
		instanceId: "pm2-replay",
		dependencies: {
			clock: clock.now,
			store,
			randomToken: () => "4".repeat(32),
			recoverPendingTerminalJobs: async () => 0,
			getIo: () => io,
			loadArchivedInbound: async () =>
				inboundRecord({
					processingStatus: "duplicate_reservation",
					hotelRunnerFirstFallback: {
						jobId: JOB_ID,
						status: "completed_email_fallback",
					},
					reconciliation: {
						status: "duplicate_reservation",
						reservationId: RESERVATION_ID,
					},
				}),
			loadReservation: async () => ({
				_id: RESERVATION_ID,
				hotelId: HOTEL_ID,
				otaPlatformReview: { status: "pending" },
			}),
			isRelevantAirbnbEvent: () => false,
		},
	});

	await processor.processNext();
	assert.equal(store.state.status, "completed");
	assert.equal(store.state.refresh.status, "completed");
	assert.equal(
		events.filter(
			(event) =>
				event.room === "platform-notifications" &&
				event.name === "hotelNotificationsUpdated" &&
				event.payload.type === "ota_reservation_pending"
		).length,
		1
	);
});

test("default refresh preserves pending-review platform-only semantics", async () => {
	const events = [];
	const room = {
		emit(name, payload) {
			events.push({ name, payload });
		},
	};
	const io = {
		emit(name, payload) {
			events.push({ room: "global", name, payload });
		},
		to(name) {
			return {
				emit(eventName, payload) {
					events.push({ room: name, name: eventName, payload });
				},
			};
		},
	};
	await defaultEmitRefresh({
		io,
		outbox: outboxRecord(),
		inbound: inboundRecord(),
		reservation: { otaPlatformReview: { status: "pending" } },
	});

	assert.equal(
		events.filter((event) => event.name === "inboundEmailUpdated").length,
		1
	);
	assert.equal(
		events.filter(
			(event) =>
				event.room === "platform-notifications" &&
				event.name === "hotelNotificationsUpdated" &&
				event.payload.type === "ota_reservation_pending"
		).length,
		1
	);
	assert.equal(
		events.filter((event) =>
			String(event.room || "").startsWith("hotel-notifications:")
		).length,
		0
	);
});
