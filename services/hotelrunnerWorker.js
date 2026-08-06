/** @format */

const crypto = require("crypto");
const os = require("os");
const HotelRunnerEvent = require("../models/hotelrunner_event");
const HotelRunnerSyncState = require("../models/hotelrunner_sync_state");
const {
	getHotelRunnerConfig,
} = require("./hotelrunnerConfig");
const {
	loadConfiguredHotel,
	safeErrorMessage,
} = require("./hotelrunnerEventService");
const {
	projectHotelRunnerReservation,
} = require("./hotelrunnerReservationAdapter");
const {
	createHotelRunnerPullSync,
} = require("./hotelrunnerPullSync");

const EVENT_LEASE_MS = 2 * 60 * 1000;
const EVENT_POLL_MS = 1_000;
const MAX_EVENT_ATTEMPTS = 8;

const wait = (milliseconds) =>
	new Promise((resolve) => {
		const timer = setTimeout(resolve, milliseconds);
		timer.unref?.();
	});

const createInstanceId = () =>
	`${os.hostname()}:${process.pid}:${crypto.randomBytes(6).toString("hex")}`;

function retryDelayMs(attempts) {
	const exponent = Math.min(8, Math.max(0, Number(attempts || 1) - 1));
	return Math.min(30 * 60 * 1000, 5_000 * 2 ** exponent);
}

function normalizedFromStoredEvent(event) {
	const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
	return {
		...payload,
		messageUid: event.messageUid,
		hotelRunnerReservationId: event.hotelRunnerReservationId,
		sourceUpdatedAt: new Date(event.sourceUpdatedAt),
		bookedAt: payload.bookedAt ? new Date(payload.bookedAt) : null,
		payloadHash: event.payloadHash,
		canonicalHash: event.canonicalHash,
		rooms: (payload.rooms || []).map((room) => ({
			...room,
			updatedAt: room?.updatedAt ? new Date(room.updatedAt) : null,
		})),
	};
}

function createHotelRunnerWorker({
	config = getHotelRunnerConfig(),
	instanceId = createInstanceId(),
	dependencies = {},
} = {}) {
	const EventModel = dependencies.EventModel || HotelRunnerEvent;
	const SyncStateModel = dependencies.SyncStateModel || HotelRunnerSyncState;
	const project = dependencies.projectReservation || projectHotelRunnerReservation;
	const pullSync = (dependencies.createPullSync || createHotelRunnerPullSync)({
		config,
		instanceId,
		dependencies: { ...dependencies, SyncStateModel },
	});
	let stopped = true;
	let loopPromise = null;
	let lastPullCheckAt = 0;

	async function claimEvent(now = new Date()) {
		return EventModel.findOneAndUpdate(
			{
				hotelId: config.hotelId,
				status: { $in: ["pending", "retry", "processing"] },
				attempts: { $lt: MAX_EVENT_ATTEMPTS },
				nextAttemptAt: { $lte: now },
				$or: [
					{ leaseUntil: { $exists: false } },
					{ leaseUntil: null },
					{ leaseUntil: { $lte: now } },
				],
			},
			{
				$set: {
					status: "processing",
					leaseOwner: instanceId,
					leaseAcquiredAt: now,
					leaseUntil: new Date(now.getTime() + EVENT_LEASE_MS),
				},
				$inc: { attempts: 1 },
			},
			// Apply a reservation's earliest known delivery first so a queued create
			// can establish the local record before its modification/cancellation.
			// Source watermarks still reject stale late arrivals after newer facts win.
			{ new: true, sort: { sourceUpdatedAt: 1, createdAt: 1 } }
		)
			.select("+payload")
			.exec();
	}

	async function failAbandonedFinalRecovery(now = new Date()) {
		return EventModel.findOneAndUpdate(
			{
				hotelId: config.hotelId,
				status: "processing",
				attempts: { $gte: MAX_EVENT_ATTEMPTS },
				finalRecoveryAttempted: true,
				leaseUntil: { $lte: now },
			},
			{
				$set: {
					status: "failed",
					processedAt: now,
					errorCode: "HOTELRUNNER_FINAL_RECOVERY_LEASE_EXPIRED",
					errorMessage:
						"The final idempotent recovery attempt ended without releasing its lease.",
				},
				$unset: { leaseOwner: 1, leaseAcquiredAt: 1, leaseUntil: 1 },
			},
			{ new: true, sort: { sourceUpdatedAt: 1, createdAt: 1 } }
		).exec();
	}

	async function claimExpiredExhaustedEvent(now = new Date()) {
		return EventModel.findOneAndUpdate(
			{
				hotelId: config.hotelId,
				status: "processing",
				attempts: { $gte: MAX_EVENT_ATTEMPTS },
				finalRecoveryAttempted: { $ne: true },
				leaseUntil: { $lte: now },
			},
			{
				$set: {
					status: "processing",
					finalRecoveryAttempted: true,
					finalRecoveryClaimedAt: now,
					leaseOwner: instanceId,
					leaseAcquiredAt: now,
					leaseUntil: new Date(now.getTime() + EVENT_LEASE_MS),
					errorCode: "",
					errorMessage: "",
				},
			},
			// Projection is idempotent, so one no-counter recovery pass can finish an
			// event whose process died after taking its last ordinary attempt.
			{ new: true, sort: { sourceUpdatedAt: 1, createdAt: 1 } }
		)
			.select("+payload")
			.exec();
	}

	async function finishEvent(event, result) {
		const statusMap = {
			created: "completed",
			updated: "completed",
			cancelled: "completed",
			ignored: "ignored",
			needs_mapping: "needs_mapping",
			quarantined: "quarantined",
		};
		const status = statusMap[result.status] || "completed";
		await EventModel.updateOne(
			{ _id: event._id, leaseOwner: instanceId },
			{
				$set: {
					status,
					processedAt: new Date(),
					mirrorId: result.mirrorId || null,
					reservationMongoId: result.reservationMongoId || null,
					result: {
						status: result.status,
						code: result.code || "",
						changedPaths: result.changedPaths || [],
						missingInvCodes: result.missingInvCodes || [],
						commercialProtected: result.commercialProtected === true,
						inventoryIssueCount: Number(result.inventoryIssueCount || 0),
					},
					errorCode: result.code || "",
					errorMessage: "",
				},
				$unset: { leaseOwner: 1, leaseAcquiredAt: 1, leaseUntil: 1 },
			}
		).exec();
		await SyncStateModel.updateOne(
			{ hotelId: event.hotelId },
			{ $inc: { "metrics.eventsProcessed": 1 } },
			{ upsert: true }
		).exec();
		return status;
	}

	async function retryEvent(event, error) {
		const exhausted = Number(event.attempts || 0) >= MAX_EVENT_ATTEMPTS;
		await EventModel.updateOne(
			{ _id: event._id, leaseOwner: instanceId },
			{
				$set: {
					status: exhausted ? "failed" : "retry",
					nextAttemptAt: new Date(
						Date.now() +
							Math.max(
								retryDelayMs(event.attempts),
								Number(error?.retryAfterMs || 0)
							)
					),
					errorCode: String(
						error?.code || "HOTELRUNNER_EVENT_PROCESSING_FAILED"
					).slice(0, 100),
					errorMessage: safeErrorMessage(error),
					processedAt: exhausted ? new Date() : null,
				},
				$unset: { leaseOwner: 1, leaseAcquiredAt: 1, leaseUntil: 1 },
			}
		).exec();
	}

	async function runOnce() {
		if (config.projectionEnabled === false) return false;
		const abandonedRecovery = await failAbandonedFinalRecovery();
		if (abandonedRecovery) return true;
		const event =
			(await claimExpiredExhaustedEvent()) || (await claimEvent());
		if (!event) return false;
		try {
			if (!config.configured || String(event.hotelId) !== String(config.hotelId)) {
				const error = new Error("HotelRunner event property configuration does not match.");
				error.code = "HOTELRUNNER_EVENT_PROPERTY_MISMATCH";
				throw error;
			}
			const hotel = await loadConfiguredHotel(config, dependencies);
			const normalized = normalizedFromStoredEvent(event.toObject());
			if (Array.isArray(normalized.issues) && normalized.issues.length) {
				await finishEvent(event, {
					status: "quarantined",
					code: normalized.issues.join(",").slice(0, 100),
				});
				return true;
			}
			const result = await project({ normalized, event, hotel, config }, dependencies);
			if (result.status === "retry") {
				const error = new Error("HotelRunner reservation changed concurrently.");
				error.code = result.code || "HOTELRUNNER_RESERVATION_CAS_CONFLICT";
				throw error;
			}
			await finishEvent(event, result);
			return true;
		} catch (error) {
			await retryEvent(event, error);
			return true;
		}
	}

	async function runUntilIdle({ maxCycles = 1_000 } = {}) {
		let processed = 0;
		while (processed < maxCycles && (await runOnce())) processed += 1;
		return processed;
	}

	async function runCycle(nowMs = Date.now()) {
		let didWork = false;
		try {
			didWork = await runOnce();
		} catch (error) {
			console.error("[hotelrunner-worker] event loop error", {
				code: String(error?.code || "HOTELRUNNER_WORKER_ERROR").slice(0, 100),
				message: safeErrorMessage(error),
			});
		}
		if (nowMs - lastPullCheckAt >= 30_000) {
			lastPullCheckAt = nowMs;
			try {
				await pullSync.runIfDue();
			} catch (error) {
				console.error("[hotelrunner-worker] pull held", {
					code: String(error?.code || "HOTELRUNNER_PULL_FAILED").slice(0, 100),
					message: safeErrorMessage(error),
				});
			}
		}
		return didWork;
	}

	async function loop() {
		while (!stopped) {
			const didWork = await runCycle();
			if (!didWork) await wait(EVENT_POLL_MS);
		}
	}

	async function start() {
		if (!stopped) return;
		if (!config.configured) {
			throw new Error("HotelRunner worker configuration is incomplete.");
		}
		stopped = false;
		loopPromise = loop();
	}

	async function stop() {
		stopped = true;
		await loopPromise;
		loopPromise = null;
	}

	return {
		claimEvent,
		claimExpiredExhaustedEvent,
		failAbandonedFinalRecovery,
		instanceId,
		runPullIfDue: pullSync.runIfDue,
		runCycle,
		runOnce,
		runUntilIdle,
		start,
		stop,
	};
}

module.exports = {
	EVENT_LEASE_MS,
	EVENT_POLL_MS,
	MAX_EVENT_ATTEMPTS,
	createHotelRunnerWorker,
	normalizedFromStoredEvent,
	retryDelayMs,
};
