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
const {
	createHotelRunnerLateEvidenceRecovery,
} = require("./hotelrunnerLateEvidenceRecovery");
const {
	TARGETED_LOOKUP_EVENT_MARKER_PATH: TARGETED_LOOKUP_MARKER_PATH,
	buildHotelRunnerProjectionEligibilityFilter: buildProjectionEligibilityFilter,
	createHotelRunnerFirstOtaFallbackCoordinator,
} = require("./hotelrunnerFirstOtaFallback");

const EVENT_LEASE_MS = 5 * 60 * 1000;
const PROJECTION_LEASE_MS = 5 * 60 * 1000;
const PROJECTION_LEASE_HEARTBEAT_MS = 60 * 1000;
const EVENT_POLL_MS = 1_000;
const MAX_EVENT_ATTEMPTS = 8;
const FALLBACK_RECOVERY_INTERVAL_MS = 30_000;
const LATE_EVIDENCE_RECOVERY_INTERVAL_MS = 30_000;

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

function mutationMatched(result) {
	return Number(result?.matchedCount ?? result?.n ?? 0) === 1;
}

function eventLeaseLostError(action) {
	const error = new Error(
		`HotelRunner event lease was lost before ${action} could be committed.`
	);
	error.code = "HOTELRUNNER_EVENT_LEASE_LOST";
	error.retryable = true;
	return error;
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
	let lastFallbackRecoveryAt = 0;
	let lastLateEvidenceRecoveryAt = Date.now();
	let projectionStateEnsured = false;
	let fallbackIndexesPromise = null;
	const fallbackCoordinator =
		config.configured === true && config.projectionEnabled === true
			? Object.prototype.hasOwnProperty.call(
					dependencies,
					"otaFallbackCoordinator"
			  )
				? dependencies.otaFallbackCoordinator
				: (
						dependencies.createOtaFallbackCoordinator ||
						createHotelRunnerFirstOtaFallbackCoordinator
				  )({
						config,
						instanceId,
						graceMs: config.otaEmailFallbackGraceMs,
						leaseMs: config.otaEmailFallbackLeaseMs,
						negativeProofTtlMs: config.otaEmailFallbackProofTtlMs,
						maxAttempts: config.otaEmailFallbackMaxAttempts,
						dependencies: dependencies.otaFallbackDependencies,
				  })
			: null;

	const lateEvidenceRecovery =
		config.configured === true && config.projectionEnabled === true
			? Object.prototype.hasOwnProperty.call(
					dependencies,
					"lateEvidenceRecovery"
			  )
				? dependencies.lateEvidenceRecovery
				: (
						dependencies.createLateEvidenceRecovery ||
						createHotelRunnerLateEvidenceRecovery
				  )({
						config,
						normalizeEvent: normalizedFromStoredEvent,
						dependencies,
				  })
			: null;

	const projectionCutoffFilter = () => ({
		$and: [buildProjectionEligibilityFilter(config.projectionNotBefore)],
	});

	async function ensureFallbackIndexes() {
		if (!fallbackCoordinator) return false;
		if (!fallbackIndexesPromise) {
			fallbackIndexesPromise = Promise.resolve()
				.then(() => fallbackCoordinator.ensureIndexes())
				.catch((error) => {
					fallbackIndexesPromise = null;
					throw error;
				});
		}
		await fallbackIndexesPromise;
		return true;
	}

	async function recoverFallbackOrphansIfDue(nowMs = Date.now()) {
		if (!fallbackCoordinator) return null;
		if (!isFallbackRecoveryDue(nowMs)) {
			return null;
		}
		lastFallbackRecoveryAt = nowMs;
		await ensureFallbackIndexes();
		return fallbackCoordinator.recoverOrphanedArchivedEmails();
	}

	function isFallbackRecoveryDue(nowMs = Date.now()) {
		return Boolean(
			fallbackCoordinator &&
				nowMs - lastFallbackRecoveryAt >= FALLBACK_RECOVERY_INTERVAL_MS
		);
	}

	function isLateEvidenceRecoveryDue(nowMs = Date.now()) {
		return Boolean(
			lateEvidenceRecovery &&
				nowMs - lastLateEvidenceRecoveryAt >=
					LATE_EVIDENCE_RECOVERY_INTERVAL_MS
		);
	}

	async function recoverLateEvidenceIfDue(nowMs = Date.now()) {
		if (!isLateEvidenceRecoveryDue(nowMs)) return null;
		lastLateEvidenceRecoveryAt = nowMs;
		return lateEvidenceRecovery.scanOnce({ now: new Date(nowMs) });
	}

	async function hasLateEvidenceCandidates() {
		if (!lateEvidenceRecovery) return false;
		return Boolean(await lateEvidenceRecovery.hasCandidates());
	}

	async function hasFallbackWork() {
		if (!fallbackCoordinator) return false;
		await ensureFallbackIndexes();
		return Boolean(await fallbackCoordinator.hasDueWork());
	}

	async function hasProjectionWork(now = new Date()) {
		// Production Mongoose models provide exists(). Lightweight unit fakes that
		// exercise claim/recovery behavior may intentionally omit it.
		if (typeof EventModel.exists !== "function") return true;
		const query = EventModel.exists({
			hotelId: config.hotelId,
			...projectionCutoffFilter(),
			status: { $in: ["pending", "retry", "processing"] },
			nextAttemptAt: { $lte: now },
		});
		return Boolean(
			query && typeof query.exec === "function" ? await query.exec() : await query
		);
	}

	async function ensureProjectionState() {
		if (projectionStateEnsured) return;
		await SyncStateModel.updateOne(
			{ hotelId: config.hotelId },
			{ $setOnInsert: { hotelId: config.hotelId } },
			{ upsert: true }
		).exec();
		projectionStateEnsured = true;
	}

	async function claimProjectionLease(now = new Date()) {
		await ensureProjectionState();
		return SyncStateModel.findOneAndUpdate(
			{
				hotelId: config.hotelId,
				$or: [
					{ projectionLeaseUntil: { $exists: false } },
					{ projectionLeaseUntil: null },
					{ projectionLeaseUntil: { $lte: now } },
					{ projectionLeaseOwner: instanceId },
				],
			},
			{
				$set: {
					projectionLeaseOwner: instanceId,
					projectionLeaseAcquiredAt: now,
					projectionLeaseUntil: new Date(
						now.getTime() + PROJECTION_LEASE_MS
					),
				},
			},
			{ new: true }
		).exec();
	}

	async function releaseProjectionLease(now = new Date()) {
		return SyncStateModel.updateOne(
			{ hotelId: config.hotelId, projectionLeaseOwner: instanceId },
			{
				$set: { projectionLeaseUntil: now },
				$unset: {
					projectionLeaseOwner: 1,
					projectionLeaseAcquiredAt: 1,
				},
			}
		).exec();
	}

	async function renewProjectionLease(now = new Date()) {
		const result = await SyncStateModel.updateOne(
			{ hotelId: config.hotelId, projectionLeaseOwner: instanceId },
			{
				$set: {
					projectionLeaseUntil: new Date(
						now.getTime() + PROJECTION_LEASE_MS
					),
				},
			}
		).exec();
		const matched = Number(result?.matchedCount ?? result?.n ?? 0);
		if (!matched) {
			const error = new Error(
				"HotelRunner projection lease was lost before processing completed."
			);
			error.code = "HOTELRUNNER_PROJECTION_LEASE_LOST";
			error.retryable = true;
			throw error;
		}
		return true;
	}

	function startProjectionLeaseHeartbeat() {
		let stopped = false;
		let firstError = null;
		let pending = Promise.resolve();
		const pulse = () => {
			if (stopped) return pending;
			pending = pending
				.then(() => renewProjectionLease())
				.catch((error) => {
					if (!firstError) firstError = error;
				});
			return pending;
		};
		const timer = setInterval(() => {
			void pulse();
		}, PROJECTION_LEASE_HEARTBEAT_MS);
		timer.unref?.();
		return {
			async assertOwned() {
				await pulse();
				if (firstError) throw firstError;
			},
			async stop({ throwOnError = true } = {}) {
				if (!stopped) {
					stopped = true;
					clearInterval(timer);
				}
				await pending;
				if (throwOnError && firstError) throw firstError;
			},
		};
	}

	async function claimEvent(now = new Date()) {
		return EventModel.findOneAndUpdate(
			{
				hotelId: config.hotelId,
				...projectionCutoffFilter(),
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
				...projectionCutoffFilter(),
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
				...projectionCutoffFilter(),
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

	const ownedProcessingFilter = (event) => ({
		_id: event._id,
		hotelId: config.hotelId,
		status: "processing",
		leaseOwner: instanceId,
		payloadHash: event.payloadHash,
		integrityReason: { $in: ["", null] },
	});

	async function assertEventProjectable(event, now = new Date()) {
		const assertion = await EventModel.updateOne(
			ownedProcessingFilter(event),
			{
				$set: {
					leaseUntil: new Date(now.getTime() + EVENT_LEASE_MS),
				},
			}
		).exec();
		if (!mutationMatched(assertion)) {
			throw eventLeaseLostError("projection");
		}
		return true;
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
		const requiresAttention = Boolean(
			(["created", "updated"].includes(result.status) &&
				Number(result.inventoryIssueCount || 0) > 0) ||
				result.commercialEvidenceStale === true
		);
		const status = requiresAttention
			? "attention"
			: statusMap[result.status] || "completed";
		const resultSnapshot = {
			status: result.status,
			code: result.code || "",
			changedPaths: result.changedPaths || [],
			missingInvCodes: result.missingInvCodes || [],
			staleInvCodes: result.staleInvCodes || [],
			commercialProtected: result.commercialProtected === true,
			commercialEvidenceStale: result.commercialEvidenceStale === true,
			attentionCode: String(result.attentionCode || "").slice(0, 100),
			inventoryIssueCount: Number(result.inventoryIssueCount || 0),
			inventorySummary: result.inventorySummary || null,
		};
		const completionUpdate = (completionStatus, integrityConflict) => ({
			$set: {
				status: completionStatus,
				processedAt: new Date(),
				mirrorId: result.mirrorId || null,
				reservationMongoId: result.reservationMongoId || null,
				result: {
					...resultSnapshot,
					integrityConflict,
				},
				errorCode: String(
					result.attentionCode || result.code || ""
				).slice(0, 100),
				errorMessage: "",
			},
			$unset: { leaseOwner: 1, leaseAcquiredAt: 1, leaseUntil: 1 },
		});
		let committedStatus = status;
		let completion = await EventModel.updateOne(
			{
				...ownedProcessingFilter(event),
				integrityConflict: { $ne: true },
			},
			completionUpdate(status, false)
		).exec();
		if (!mutationMatched(completion)) {
			committedStatus = "attention";
			completion = await EventModel.updateOne(
				{
					...ownedProcessingFilter(event),
					integrityConflict: true,
				},
				completionUpdate(committedStatus, true)
			).exec();
		}
		if (!mutationMatched(completion)) {
			throw eventLeaseLostError("completion");
		}
		await SyncStateModel.updateOne(
			{ hotelId: event.hotelId },
			{ $inc: { "metrics.eventsProcessed": 1 } },
			{ upsert: true }
		).exec();
		return committedStatus;
	}

	async function retryEvent(event, error) {
		const exhausted = Number(event.attempts || 0) >= MAX_EVENT_ATTEMPTS;
		const retry = await EventModel.updateOne(
			ownedProcessingFilter(event),
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
		if (!mutationMatched(retry)) {
			throw eventLeaseLostError("retry");
		}
	}

	async function runOnce(nowMs = Date.now()) {
		if (!config.configured) {
			const error = new Error("HotelRunner worker configuration is incomplete.");
			error.code = "HOTELRUNNER_CONFIG_INVALID";
			throw error;
		}
		if (config.projectionEnabled === false) return false;
		const eventWorkAvailable = await hasProjectionWork();
		const fallbackWorkAvailable =
			!eventWorkAvailable && fallbackCoordinator
				? await hasFallbackWork()
				: false;
		const fallbackRecoveryDue = isFallbackRecoveryDue();
		const lateEvidenceRecoveryDue = isLateEvidenceRecoveryDue(nowMs);
		const otherWorkAvailable = Boolean(
			eventWorkAvailable || fallbackWorkAvailable || fallbackRecoveryDue
		);
		let lateEvidenceWorkAvailable = false;
		if (lateEvidenceRecoveryDue && !otherWorkAvailable) {
			try {
				lateEvidenceWorkAvailable = await hasLateEvidenceCandidates();
			} catch (_error) {
				// A failed readiness probe acquires the ordinary property lease so the
				// owned scan can retry safely and emit only its bounded machine code.
				lateEvidenceWorkAvailable = true;
			}
			if (!lateEvidenceWorkAvailable) {
				lastLateEvidenceRecoveryAt = nowMs;
				return false;
			}
		}
		if (
			!otherWorkAvailable &&
			!lateEvidenceWorkAvailable
		) {
			return false;
		}
		const projectionLease = await claimProjectionLease();
		if (!projectionLease) return false;
		const heartbeat = startProjectionLeaseHeartbeat();
		let event = null;
		try {
			await heartbeat.assertOwned();
			if (lateEvidenceRecoveryDue) {
				try {
					await recoverLateEvidenceIfDue(nowMs);
				} catch (error) {
					console.error("[hotelrunner-worker] late evidence recovery held", {
						code: String(
							error?.code ||
								"HOTELRUNNER_LATE_EVIDENCE_RECOVERY_FAILED"
						).slice(0, 100),
					});
				}
				await heartbeat.assertOwned();
			}
			const abandonedRecovery = await failAbandonedFinalRecovery();
			if (abandonedRecovery) return true;
			event =
				(await claimExpiredExhaustedEvent()) || (await claimEvent());
			if (!event && (await hasProjectionWork())) {
				// A callback can be archived between the out-of-lease readiness probe
				// and this property lease. Recheck while serialized and never let an
				// email fallback pass an eligible HotelRunner event.
				event =
					(await claimExpiredExhaustedEvent()) || (await claimEvent());
				if (!event) return false;
			}
			if (!event && fallbackRecoveryDue) {
				await heartbeat.assertOwned();
				await recoverFallbackOrphansIfDue();
				await heartbeat.assertOwned();
				if (await hasProjectionWork()) {
					event =
						(await claimExpiredExhaustedEvent()) || (await claimEvent());
					if (!event) return false;
				}
			}
			if (!event) {
				if (!fallbackCoordinator || !(await hasFallbackWork())) return false;
				await heartbeat.assertOwned();
				// This is the last worker-level event check before the coordinator's
				// own pre-commit queue checks. It closes the recovery/claim gap while
				// the property projection lease is still held.
				if (await hasProjectionWork()) {
					event =
						(await claimExpiredExhaustedEvent()) || (await claimEvent());
					if (!event) return false;
				}
				if (!event) {
					const fallbackResult = await fallbackCoordinator.runOnce();
					await heartbeat.assertOwned();
					return Boolean(fallbackResult);
				}
			}
			if (String(event.hotelId) !== String(config.hotelId)) {
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
			await heartbeat.assertOwned();
			await assertEventProjectable(event);
			const result = await project({ normalized, event, hotel, config }, dependencies);
			await heartbeat.assertOwned();
			if (result.status === "retry") {
				const error = new Error("HotelRunner reservation changed concurrently.");
				error.code = result.code || "HOTELRUNNER_RESERVATION_CAS_CONFLICT";
				throw error;
			}
			await finishEvent(event, result);
			if (fallbackRecoveryDue) {
				try {
					await heartbeat.assertOwned();
					await recoverFallbackOrphansIfDue();
				} catch (recoveryError) {
					console.error("[hotelrunner-worker] fallback recovery held", {
						code: String(
							recoveryError?.code || "HOTELRUNNER_FALLBACK_RECOVERY_FAILED"
						).slice(0, 100),
						message: safeErrorMessage(recoveryError),
					});
				}
			}
			return true;
		} catch (error) {
			if (!event) throw error;
			await retryEvent(event, error);
			if (fallbackRecoveryDue) {
				try {
					await heartbeat.assertOwned();
					await recoverFallbackOrphansIfDue();
				} catch (recoveryError) {
					console.error("[hotelrunner-worker] fallback recovery held", {
						code: String(
							recoveryError?.code || "HOTELRUNNER_FALLBACK_RECOVERY_FAILED"
						).slice(0, 100),
						message: safeErrorMessage(recoveryError),
					});
				}
			}
			return true;
		} finally {
			await heartbeat.stop({ throwOnError: false });
			await releaseProjectionLease();
		}
	}

	async function runUntilIdle({ maxCycles = 1_000 } = {}) {
		await ensureFallbackIndexes();
		let processed = 0;
		while (processed < maxCycles && (await runOnce())) processed += 1;
		return processed;
	}

	async function runCycle(nowMs = Date.now()) {
		let didWork = false;
		try {
			didWork = await runOnce(nowMs);
		} catch (error) {
			console.error("[hotelrunner-worker] event loop error", {
				code: String(error?.code || "HOTELRUNNER_WORKER_ERROR").slice(0, 100),
				message: safeErrorMessage(error),
			});
		}
		if (nowMs - lastPullCheckAt >= 30_000) {
			lastPullCheckAt = nowMs;
			if (config.roomListSyncEnabled === true) {
				try {
					await pullSync.runRoomListOnly();
				} catch (error) {
					console.error("[hotelrunner-worker] room list held", {
						code: String(
							error?.code || "HOTELRUNNER_ROOM_LIST_FAILED"
						).slice(0, 100),
						message: safeErrorMessage(error),
					});
				}
			}
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
		await ensureFallbackIndexes();
		stopped = false;
		loopPromise = loop();
	}

	async function stop() {
		stopped = true;
		await loopPromise;
		loopPromise = null;
	}

	return {
		assertEventProjectable,
		claimEvent,
		claimExpiredExhaustedEvent,
		claimProjectionLease,
		failAbandonedFinalRecovery,
		finishEvent,
		hasProjectionWork,
		instanceId,
		runPullIfDue: pullSync.runIfDue,
		runRoomListOnly: pullSync.runRoomListOnly,
		runCycle,
		runOnce,
		runUntilIdle,
		releaseProjectionLease,
		retryEvent,
		renewProjectionLease,
		start,
		stop,
	};
}

module.exports = {
	EVENT_LEASE_MS,
	FALLBACK_RECOVERY_INTERVAL_MS,
	LATE_EVIDENCE_RECOVERY_INTERVAL_MS,
	PROJECTION_LEASE_HEARTBEAT_MS,
	EVENT_POLL_MS,
	MAX_EVENT_ATTEMPTS,
	PROJECTION_LEASE_MS,
	TARGETED_LOOKUP_MARKER_PATH,
	buildProjectionEligibilityFilter,
	createHotelRunnerWorker,
	normalizedFromStoredEvent,
	retryDelayMs,
};
