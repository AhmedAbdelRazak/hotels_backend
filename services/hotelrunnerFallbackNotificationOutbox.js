/** @format */

"use strict";

const crypto = require("crypto");
const os = require("os");

const HotelRunnerFallbackNotificationOutbox = require("../models/hotelrunner_fallback_notification_outbox");
const HotelRunnerOtaFallbackJob = require("../models/hotelrunner_ota_fallback_job");
const InboundEmail = require("../models/inbound_email");
const Reservations = require("../models/reservations");
const {
	notifyAirbnbOtaInboundWhatsapp,
	isRelevantAirbnbOtaEvent,
} = require("./airbnbOtaWhatsappNotifier");
const {
	emitHotelNotificationRefresh,
	emitPlatformNotificationRefresh,
} = require("./notificationEvents");
const {
	OTA_PLATFORM_REVIEW_PENDING,
} = require("./otaReservationVisibility");

const TERMINAL_FALLBACK_STATUSES = new Set([
	"completed_api",
	"completed_email_fallback",
]);
const TERMINAL_WHATSAPP_STATES = new Set([
	"not_required",
	"completed",
	"failed",
	"unknown",
]);
const REFRESH_RECONCILIATION_STATUSES = new Set([
	"created",
	"duplicate_reservation",
	"updated",
	"cancelled",
	"status_updated",
]);
const DEFAULT_POLL_MS = 5_000;
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_BATCH_SIZE = 10;
const MAX_ERROR_LENGTH = 500;
let outboxIndexesPromise = null;

const clean = (value = "") => String(value?._id || value || "").trim();
const lower = (value = "") => clean(value).toLowerCase();
const randomToken = () => crypto.randomBytes(16).toString("hex");
const sha256 = (value) =>
	crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
const mutationMatched = (result) =>
	Number(result?.matchedCount ?? result?.n ?? 0) === 1;
const errorText = (error) =>
	clean(error?.message || error || "Notification delivery failed.")
		.replace(/[\r\n\t]+/g, " ")
		.replace(
			/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi,
			"$1[REDACTED]@"
		)
		.replace(
			/(token|authorization|cookie|password)\s*[=:]\s*[^\s,&]+/gi,
			"$1=[REDACTED]"
		)
		.slice(0, MAX_ERROR_LENGTH);
const objectIdOrNull = (value) =>
	/^[a-f0-9]{24}$/i.test(clean(value)) ? value : null;

function terminalJobFilter(jobId) {
	return {
		_id: jobId,
		status: { $in: [...TERMINAL_FALLBACK_STATUSES] },
		inboundAuditFinalizationStatus: "completed",
		inboundAuditFinalizedAt: { $ne: null },
		reservationMongoId: { $ne: null },
	};
}

async function findTerminalJob(jobId, { JobModel = HotelRunnerOtaFallbackJob } = {}) {
	return JobModel.findOne(terminalJobFilter(jobId))
		.select("+result")
		.lean()
		.exec();
}

function outboxDocumentFromTerminalJob(job, now = new Date()) {
	if (
		!job ||
		!TERMINAL_FALLBACK_STATUSES.has(lower(job.status)) ||
		lower(job.inboundAuditFinalizationStatus) !== "completed" ||
		!job.inboundAuditFinalizedAt ||
		!clean(job.reservationMongoId)
	) {
		const error = new Error(
			"Notification intent requires a fully finalized HotelRunner-first terminal job."
		);
		error.code = "HOTELRUNNER_FALLBACK_NOTIFICATION_JOB_NOT_TERMINAL";
		throw error;
	}
	return {
		jobId: job._id,
		dedupeKey: `hotelrunner-first-terminal:${lower(job._id)}`,
		terminalStatus: lower(job.status),
		hotelId: job.hotelId,
		inboundEmailId: job.inboundEmailId,
		inboundEmailHash: lower(job.inboundEmailHash),
		reservationMongoId: job.reservationMongoId,
		provider: lower(job.provider),
		confirmationNumber: lower(job.confirmationNumber),
		reconciliationStatus: lower(job.result?.status),
		otaPlatformReviewStatus: lower(job.result?.otaPlatformReviewStatus),
		ownerId: objectIdOrNull(job.result?.ownerId),
		status: "pending",
		nextAttemptAt: now,
		refresh: { status: "pending", completedAt: null },
		whatsapp: { status: "pending" },
	};
}

function outboxMatchesTerminalJob(outbox, job) {
	return Boolean(
		outbox &&
		clean(outbox.jobId) === clean(job._id) &&
		lower(outbox.terminalStatus) === lower(job.status) &&
		clean(outbox.hotelId) === clean(job.hotelId) &&
		clean(outbox.inboundEmailId) === clean(job.inboundEmailId) &&
		lower(outbox.inboundEmailHash) === lower(job.inboundEmailHash) &&
		clean(outbox.reservationMongoId) === clean(job.reservationMongoId) &&
		lower(outbox.provider) === lower(job.provider) &&
		lower(outbox.confirmationNumber) === lower(job.confirmationNumber)
	);
}

async function upsertOutboxDocument(
	document,
	{ OutboxModel = HotelRunnerFallbackNotificationOutbox } = {}
) {
	try {
		return await OutboxModel.findOneAndUpdate(
			{ jobId: document.jobId },
			{ $setOnInsert: document },
			{ new: true, upsert: true, setDefaultsOnInsert: true }
		)
			.lean()
			.exec();
	} catch (error) {
		if (Number(error?.code) !== 11000) throw error;
		return OutboxModel.findOne({ jobId: document.jobId }).lean().exec();
	}
}

async function ensureOutboxIndexes({
	OutboxModel = HotelRunnerFallbackNotificationOutbox,
} = {}) {
	if (!outboxIndexesPromise) {
		outboxIndexesPromise = Promise.resolve()
			.then(() => OutboxModel.createIndexes())
			.catch((error) => {
				outboxIndexesPromise = null;
				throw error;
			});
	}
	return outboxIndexesPromise;
}

async function markTerminalJobOutboxEnqueued(
	job,
	outbox,
	{ JobModel = HotelRunnerOtaFallbackJob, now = () => new Date() } = {}
) {
	const markedAt = now();
	const update = await JobModel.updateOne(
		{
			...terminalJobFilter(job._id),
			notificationOutboxStatus: { $in: ["", "pending", "enqueued"] },
		},
		{
			$set: {
				notificationOutboxStatus: "enqueued",
				notificationOutboxId: outbox._id,
				notificationOutboxEnqueuedAt: markedAt,
			},
		}
	).exec();
	if (mutationMatched(update)) return true;

	const existing = await JobModel.findOne({
		...terminalJobFilter(job._id),
		notificationOutboxStatus: "enqueued",
		notificationOutboxId: outbox._id,
	})
		.select("_id")
		.lean()
		.exec();
	if (existing) return true;

	const error = new Error("Terminal fallback job outbox marker CAS was lost.");
	error.code = "HOTELRUNNER_FALLBACK_NOTIFICATION_MARKER_CAS_LOST";
	throw error;
}

async function enqueueHotelRunnerFallbackTerminalNotification(
	{ job, jobId } = {},
	dependencies = {}
) {
	const loadTerminalJob =
		dependencies.loadTerminalJob ||
		((id) => findTerminalJob(id, dependencies));
	const persisted = await loadTerminalJob(jobId || job?._id);
	if (!persisted) {
		const error = new Error(
			"The HotelRunner-first job is not durably terminal; notification was not enqueued."
		);
		error.code = "HOTELRUNNER_FALLBACK_NOTIFICATION_JOB_NOT_TERMINAL";
		throw error;
	}
	const now = (dependencies.now || (() => new Date()))();
	const document = outboxDocumentFromTerminalJob(persisted, now);
	const upsert =
		dependencies.upsertOutbox ||
		((value) => upsertOutboxDocument(value, dependencies));
	if (!dependencies.upsertOutbox) await ensureOutboxIndexes(dependencies);
	const outbox = await upsert(document);
	if (!outbox?._id) {
		const error = new Error("Notification outbox upsert returned no durable record.");
		error.code = "HOTELRUNNER_FALLBACK_NOTIFICATION_UPSERT_FAILED";
		throw error;
	}
	if (!outboxMatchesTerminalJob(outbox, persisted)) {
		const error = new Error(
			"Existing notification outbox does not match the exact terminal fallback identity."
		);
		error.code = "HOTELRUNNER_FALLBACK_NOTIFICATION_IDENTITY_CONFLICT";
		throw error;
	}
	const markEnqueued =
		dependencies.markTerminalJobEnqueued ||
		((context) =>
			markTerminalJobOutboxEnqueued(context.job, context.outbox, dependencies));
	await markEnqueued({ job: persisted, outbox });
	return outbox;
}

function createMongooseOutboxStore({ OutboxModel = HotelRunnerFallbackNotificationOutbox } = {}) {
	const ownedFilter = (outbox, now) => ({
		_id: outbox._id,
		status: "processing",
		leaseOwner: outbox.leaseOwner,
		leaseToken: outbox.leaseToken,
		leaseUntil: { $gt: now },
	});
	return {
		async ensureIndexes() {
			await OutboxModel.createIndexes();
			return true;
		},
		async claim({ instanceId, leaseToken, now, leaseUntil }) {
			return OutboxModel.findOneAndUpdate(
				{
					status: { $in: ["pending", "retry", "processing"] },
					nextAttemptAt: { $lte: now },
					$or: [
						{ leaseUntil: null },
						{ leaseUntil: { $exists: false } },
						{ leaseUntil: { $lte: now } },
					],
				},
				{
					$set: {
						status: "processing",
						leaseOwner: instanceId,
						leaseToken,
						leaseAcquiredAt: now,
						leaseUntil,
					},
					$inc: { attemptCount: 1 },
				},
				{ new: true, sort: { nextAttemptAt: 1, createdAt: 1 } }
			)
				.lean()
				.exec();
		},
		async renewOwned(outbox, now, leaseUntil) {
			return OutboxModel.findOneAndUpdate(
				ownedFilter(outbox, now),
				{ $set: { leaseUntil } },
				{ new: true }
			)
				.lean()
				.exec();
		},
		async updateOwned(outbox, update, now) {
			return OutboxModel.findOneAndUpdate(
				ownedFilter(outbox, now),
				update,
				{ new: true }
			)
				.lean()
				.exec();
		},
	};
}

async function defaultLoadArchivedInbound(outbox) {
	return InboundEmail.findOne({
		_id: outbox.inboundEmailId,
		emailHash: outbox.inboundEmailHash,
		hotelId: outbox.hotelId,
		reservationMongoId: outbox.reservationMongoId,
		provider: outbox.provider,
		confirmationNumber: outbox.confirmationNumber,
		"hotelRunnerFirstFallback.jobId": clean(outbox.jobId),
		"hotelRunnerFirstFallback.status": outbox.terminalStatus,
	})
		.lean()
		.exec();
}

async function defaultLoadReservation(outbox) {
	return Reservations.findOne({
		_id: outbox.reservationMongoId,
		hotelId: outbox.hotelId,
	})
		.select("_id hotelId otaPlatformReview.status")
		.lean()
		.exec();
}

function notificationRequest(io) {
	return {
		app: {
			get(name) {
				return name === "io" ? io : null;
			},
		},
	};
}

async function defaultEmitRefresh({ io, outbox, inbound, reservation }) {
	if (!io) throw new Error("Socket.IO is unavailable for fallback notification delivery.");
	const emittedAt = new Date().toISOString();
	io.emit("inboundEmailUpdated", {
		_id: clean(inbound._id),
		processingStatus: lower(inbound.processingStatus),
		provider: lower(inbound.provider),
		intent: lower(inbound.intent),
		confirmationNumber: lower(inbound.confirmationNumber),
		pmsConfirmationNumber: clean(inbound.pmsConfirmationNumber),
		hotelId: clean(inbound.hotelId),
		reservationMongoId: clean(inbound.reservationMongoId),
		forwardingStatus: lower(inbound.forwarding?.status),
		forwardReason: lower(inbound.forwardDecision?.reason),
		airbnbWhatsappNotificationStatus: lower(
			inbound.airbnbWhatsappNotification?.status
		),
		updatedAt: emittedAt,
	});

	if (!REFRESH_RECONCILIATION_STATUSES.has(lower(outbox.reconciliationStatus))) {
		return { emitted: true, reservationRefresh: "not_required" };
	}
	const req = notificationRequest(io);
	const reviewStatus =
		lower(outbox.otaPlatformReviewStatus) ||
		lower(reservation?.otaPlatformReview?.status);
	if (reviewStatus === OTA_PLATFORM_REVIEW_PENDING) {
		emitPlatformNotificationRefresh(req, {
			type: "ota_reservation_pending",
			reservationId: outbox.reservationMongoId,
			hotelId: outbox.hotelId,
			ownerId: outbox.ownerId,
		});
		return { emitted: true, reservationRefresh: "platform" };
	}
	await emitHotelNotificationRefresh(req, outbox.hotelId, {
		type: "reservation_update",
		reservationId: outbox.reservationMongoId,
		ownerId: outbox.ownerId,
	});
	return { emitted: true, reservationRefresh: "hotel" };
}

function archivedAirbnbContext(inbound) {
	return {
		inboundRecord: inbound,
		email: {
			from: inbound.from || "",
			to: inbound.to || "",
			subject: inbound.subject || "",
			text: inbound.bodyText || "",
			html: inbound.bodyHtml || "",
		},
		normalized: inbound.normalizedReservation || {},
		reconciliation: inbound.reconciliation || {},
	};
}

async function defaultClaimAirbnbAttempt({ outbox, attemptKey, claimedAt }) {
	const filter = {
		_id: outbox.inboundEmailId,
		emailHash: outbox.inboundEmailHash,
		reservationMongoId: outbox.reservationMongoId,
		"hotelRunnerFirstFallback.jobId": clean(outbox.jobId),
		"hotelRunnerFirstFallback.status": outbox.terminalStatus,
		$and: [
			{
				$or: [
					{ "airbnbWhatsappNotification.attemptKey": "" },
					{ "airbnbWhatsappNotification.attemptKey": null },
					{ "airbnbWhatsappNotification.attemptKey": { $exists: false } },
				],
			},
			{
				$or: [
					{ "airbnbWhatsappNotification.status": "not_required" },
					{ "airbnbWhatsappNotification.status": "" },
					{ "airbnbWhatsappNotification.status": { $exists: false } },
				],
			},
		],
	};
	const claimed = await InboundEmail.findOneAndUpdate(
		filter,
		{
			$set: {
				"airbnbWhatsappNotification.status": "outbox_claimed",
				"airbnbWhatsappNotification.attemptKey": attemptKey,
				"airbnbWhatsappNotification.outboxId": outbox._id,
				"airbnbWhatsappNotification.claimedAt": claimedAt,
				"airbnbWhatsappNotification.attemptedAt": claimedAt,
			},
		},
		{ new: true }
	)
		.lean()
		.exec();
	if (claimed) return { claimed: true, record: claimed };
	const existing = await InboundEmail.findById(outbox.inboundEmailId).lean().exec();
	return { claimed: false, record: existing || null };
}

async function defaultPersistAirbnbAttemptAudit({ outbox, attemptKey, audit }) {
	return InboundEmail.findOneAndUpdate(
		{
			_id: outbox.inboundEmailId,
			"airbnbWhatsappNotification.attemptKey": attemptKey,
			"airbnbWhatsappNotification.outboxId": outbox._id,
		},
		{
			$set: {
				"airbnbWhatsappNotification.status": audit.status,
				"airbnbWhatsappNotification.message": audit.message || "",
				"airbnbWhatsappNotification.recipients": audit.recipients || [],
				"airbnbWhatsappNotification.deliveries": audit.deliveries || [],
				"airbnbWhatsappNotification.attemptedAt": audit.attemptedAt,
				"airbnbWhatsappNotification.completedAt": audit.completedAt,
			},
		},
		{ new: true }
	)
		.lean()
		.exec();
}

function priorAirbnbAttemptState(record, attemptKey) {
	const audit = record?.airbnbWhatsappNotification || {};
	if (lower(audit.attemptKey) === lower(attemptKey)) {
		if (lower(audit.status) === "outbox_claimed") return "unknown";
		return "completed";
	}
	if (lower(audit.status) && lower(audit.status) !== "not_required") {
		return "completed";
	}
	return "unknown";
}

function createHotelRunnerFallbackNotificationOutbox({
	instanceId = `${os.hostname()}:${process.pid}:${randomToken().slice(0, 12)}`,
	leaseMs = DEFAULT_LEASE_MS,
	pollMs = DEFAULT_POLL_MS,
	batchSize = DEFAULT_BATCH_SIZE,
	dependencies = {},
} = {}) {
	const clock = dependencies.clock || (() => new Date());
	const token = dependencies.randomToken || randomToken;
	const store = dependencies.store || createMongooseOutboxStore(dependencies);
	const loadArchivedInbound =
		dependencies.loadArchivedInbound || defaultLoadArchivedInbound;
	const loadReservation = dependencies.loadReservation || defaultLoadReservation;
	const getIo = dependencies.getIo || (() => null);
	const emitRefresh = dependencies.emitRefresh || defaultEmitRefresh;
	const claimAirbnbAttempt =
		dependencies.claimAirbnbAttempt || defaultClaimAirbnbAttempt;
	const persistAirbnbAttemptAudit =
		dependencies.persistAirbnbAttemptAudit || defaultPersistAirbnbAttemptAudit;
	const sendAirbnbNotification =
		dependencies.sendAirbnbNotification || notifyAirbnbOtaInboundWhatsapp;
	const relevantAirbnbEvent =
		dependencies.isRelevantAirbnbEvent || isRelevantAirbnbOtaEvent;
	const logger = dependencies.logger || console;
	const effectiveLeaseMs = Math.max(30_000, Number(leaseMs) || DEFAULT_LEASE_MS);
	const effectivePollMs = Math.max(1_000, Number(pollMs) || DEFAULT_POLL_MS);
	const effectiveBatchSize = Math.max(1, Math.min(100, Number(batchSize) || 10));
	let timer = null;
	let running = false;
	let indexesReady = false;

	const replace = (target, source) => {
		for (const key of Object.keys(target)) delete target[key];
		Object.assign(target, source);
		return target;
	};
	const now = () => {
		const value = clock();
		const parsed = value instanceof Date ? new Date(value) : new Date(value);
		if (!Number.isFinite(parsed.getTime())) throw new Error("Outbox clock is invalid.");
		return parsed;
	};
	const leaseLost = () => {
		const error = new Error("Fallback notification outbox lease was lost.");
		error.code = "HOTELRUNNER_FALLBACK_NOTIFICATION_LEASE_LOST";
		return error;
	};
	async function updateOwned(outbox, update) {
		const updated = await store.updateOwned(outbox, update, now());
		if (!updated) throw leaseLost();
		return replace(outbox, updated);
	}
	async function renewOwned(outbox) {
		const checkedAt = now();
		const renewed = await store.renewOwned(
			outbox,
			checkedAt,
			new Date(checkedAt.getTime() + effectiveLeaseMs)
		);
		if (!renewed) throw leaseLost();
		return replace(outbox, renewed);
	}
	async function markRetry(outbox, error) {
		const retryAt = now();
		const delayMs = Math.min(
			5 * 60_000,
			Math.max(5_000, 5_000 * 2 ** Math.min(6, Number(outbox.attemptCount || 1) - 1))
		);
		return updateOwned(outbox, {
			$set: {
				status: "retry",
				nextAttemptAt: new Date(retryAt.getTime() + delayMs),
				lastErrorCode:
					clean(error?.code) || "HOTELRUNNER_FALLBACK_NOTIFICATION_RETRY",
				lastErrorMessage: errorText(error),
			},
			$unset: {
				leaseOwner: 1,
				leaseToken: 1,
				leaseAcquiredAt: 1,
				leaseUntil: 1,
			},
		});
	}
	async function markCompleted(outbox) {
		const completedAt = now();
		return updateOwned(outbox, {
			$set: {
				status: "completed",
				completedAt,
				lastErrorCode: "",
				lastErrorMessage: "",
			},
			$unset: {
				leaseOwner: 1,
				leaseToken: 1,
				leaseAcquiredAt: 1,
				leaseUntil: 1,
			},
		});
	}

	async function deliverWhatsapp(outbox, inbound) {
		const context = archivedAirbnbContext(inbound);
		if (!relevantAirbnbEvent(context)) {
			await updateOwned(outbox, {
				$set: {
					"whatsapp.status": "not_required",
					"whatsapp.completedAt": now(),
					"whatsapp.resultStatus": "not_required",
				},
			});
			return;
		}

		await renewOwned(outbox);
		const attemptKey = sha256(
			`hotelrunner-fallback-airbnb:${lower(outbox.jobId)}:${lower(
				outbox.inboundEmailHash
			)}`
		);
		const claimedAt = now();
		const claim = await claimAirbnbAttempt({ outbox, attemptKey, claimedAt });
		if (!claim?.claimed) {
			const priorState = priorAirbnbAttemptState(claim?.record, attemptKey);
			await updateOwned(outbox, {
				$set: {
					"whatsapp.status": priorState,
					"whatsapp.attemptKey": attemptKey,
					"whatsapp.completedAt": now(),
					"whatsapp.resultStatus": lower(
						claim?.record?.airbnbWhatsappNotification?.status
					),
				},
			});
			return;
		}

		await updateOwned(outbox, {
			$set: {
				"whatsapp.status": "claimed",
				"whatsapp.attemptKey": attemptKey,
				"whatsapp.claimedAt": claimedAt,
			},
		});
		let result = null;
		try {
			result = await sendAirbnbNotification(
				archivedAirbnbContext(claim.record || inbound),
				{
					persistAudit: ({ audit }) =>
						persistAirbnbAttemptAudit({ outbox, attemptKey, audit }),
				}
			);
		} catch (error) {
			const failedAt = now();
			await persistAirbnbAttemptAudit({
				outbox,
				attemptKey,
				audit: {
					status: "failed",
					message: "",
					recipients: [],
					deliveries: [],
					attemptedAt: claimedAt,
					completedAt: failedAt,
				},
			}).catch(() => null);
			await updateOwned(outbox, {
				$set: {
					"whatsapp.status": "failed",
					"whatsapp.completedAt": failedAt,
					"whatsapp.resultStatus": "failed",
					lastErrorCode:
						clean(error?.code) || "AIRBNB_WHATSAPP_NOTIFICATION_FAILED",
					lastErrorMessage: errorText(error),
				},
			});
			return;
		}
		// Keep provider submission failures separate from the durable outbox CAS.
		// If the process loses its lease here, the archived attempt key prevents a
		// new owner from submitting to Twilio again.
		await updateOwned(outbox, {
			$set: {
				"whatsapp.status": "completed",
				"whatsapp.completedAt": now(),
				"whatsapp.resultStatus": lower(result?.status),
			},
		});
	}

	async function processClaimed(outbox) {
		const inbound = await loadArchivedInbound(outbox);
		const reservation = await loadReservation(outbox);
		if (!inbound || !reservation) {
			const error = new Error(
				"Terminal notification evidence no longer matches the archived email and reservation."
			);
			error.code = "HOTELRUNNER_FALLBACK_NOTIFICATION_EVIDENCE_MISMATCH";
			return markRetry(outbox, error);
		}

		let refreshError = null;
		if (lower(outbox.refresh?.status) !== "completed") {
			try {
				await emitRefresh({ io: getIo(), outbox, inbound, reservation });
				await updateOwned(outbox, {
					$set: {
						"refresh.status": "completed",
						"refresh.completedAt": now(),
					},
				});
			} catch (error) {
				refreshError = error;
			}
		}

		if (!TERMINAL_WHATSAPP_STATES.has(lower(outbox.whatsapp?.status))) {
			await deliverWhatsapp(outbox, inbound);
		}
		if (refreshError) return markRetry(outbox, refreshError);
		if (
			lower(outbox.refresh?.status) === "completed" &&
			TERMINAL_WHATSAPP_STATES.has(lower(outbox.whatsapp?.status))
		) {
			return markCompleted(outbox);
		}
		return markRetry(outbox, new Error("Notification steps did not reach terminal state."));
	}

	async function processNext() {
		const claimedAt = now();
		const outbox = await store.claim({
			instanceId,
			leaseToken: token(),
			now: claimedAt,
			leaseUntil: new Date(claimedAt.getTime() + effectiveLeaseMs),
		});
		if (!outbox) return null;
		try {
			return await processClaimed(outbox);
		} catch (error) {
			try {
				return await markRetry(outbox, error);
			} catch (leaseError) {
				logger.error?.("[hotelrunner-fallback-notification] delivery failed", {
					outboxId: clean(outbox._id),
					error: errorText(error),
					leaseError: errorText(leaseError),
				});
				return null;
			}
		}
	}

	async function recoverPendingTerminalJobs(limit = effectiveBatchSize) {
		if (dependencies.recoverPendingTerminalJobs) {
			return dependencies.recoverPendingTerminalJobs(limit);
		}
		const jobs = await HotelRunnerOtaFallbackJob.find({
			status: { $in: [...TERMINAL_FALLBACK_STATUSES] },
			inboundAuditFinalizationStatus: "completed",
			inboundAuditFinalizedAt: { $ne: null },
			notificationOutboxStatus: "pending",
		})
			.select("_id")
			.sort({ completedAt: 1, _id: 1 })
			.limit(limit)
			.lean()
			.exec();
		let enqueued = 0;
		for (const job of jobs) {
			try {
				await enqueueHotelRunnerFallbackTerminalNotification(
					{ jobId: job._id },
					dependencies
				);
				enqueued += 1;
			} catch (error) {
				logger.error?.("[hotelrunner-fallback-notification] enqueue recovery failed", {
					jobId: clean(job._id),
					error: errorText(error),
				});
			}
		}
		return enqueued;
	}

	async function runOnce() {
		await recoverPendingTerminalJobs(effectiveBatchSize);
		let processed = 0;
		while (processed < effectiveBatchSize) {
			const result = await processNext();
			if (!result) break;
			processed += 1;
		}
		return { processed };
	}

	async function tick() {
		if (running) return;
		running = true;
		try {
			if (!indexesReady) {
				await store.ensureIndexes?.();
				indexesReady = true;
			}
			await runOnce();
		} catch (error) {
			logger.error?.("[hotelrunner-fallback-notification] poll failed", {
				error: errorText(error),
			});
		} finally {
			running = false;
		}
	}

	async function start() {
		await tick();
		if (!timer) {
			timer = setInterval(tick, effectivePollMs);
			timer.unref?.();
		}
		return true;
	}
	function stop() {
		if (timer) clearInterval(timer);
		timer = null;
	}

	return {
		processClaimed,
		processNext,
		recoverPendingTerminalJobs,
		runOnce,
		start,
		stop,
	};
}

let singleton = null;
function startHotelRunnerFallbackNotificationOutbox(options = {}) {
	if (singleton) return singleton;
	singleton = createHotelRunnerFallbackNotificationOutbox(options);
	void singleton.start().catch((error) => {
		console.error("[hotelrunner-fallback-notification] startup failed", {
			error: errorText(error),
		});
	});
	return singleton;
}

module.exports = {
	DEFAULT_BATCH_SIZE,
	DEFAULT_LEASE_MS,
	DEFAULT_POLL_MS,
	REFRESH_RECONCILIATION_STATUSES,
	TERMINAL_FALLBACK_STATUSES,
	TERMINAL_WHATSAPP_STATES,
	archivedAirbnbContext,
	createHotelRunnerFallbackNotificationOutbox,
	createMongooseOutboxStore,
	defaultClaimAirbnbAttempt,
	defaultEmitRefresh,
	enqueueHotelRunnerFallbackTerminalNotification,
	ensureOutboxIndexes,
	findTerminalJob,
	outboxDocumentFromTerminalJob,
	outboxMatchesTerminalJob,
	startHotelRunnerFallbackNotificationOutbox,
};
