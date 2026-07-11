/** @format */

const os = require("os");
const mongoose = require("mongoose");
const OpenAI = require("openai");

const HotelDetails = require("../models/hotel_details");
const HotelOpenAiKnowledgeSyncJob = require("../models/hotel_openai_knowledge_sync_job");
const HotelOpenAiKnowledgeCleanupJob = require("../models/hotel_openai_knowledge_cleanup_job");
const HotelOpenAiKnowledgeSyncCheckpoint = require("../models/hotel_openai_knowledge_sync_checkpoint");
const {
	deleteOpenAiResources,
	isKnowledgeManaged,
	knowledgeResources,
	syncHotelOpenAiVector,
} = require("./hotelOpenAiVectorSync");

const CHECKPOINT_ID = "hotel-openai-knowledge-sync-v1";
const DEFAULT_DEBOUNCE_MS = 8 * 1000;
const DEFAULT_POLL_MS = 1500;
const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const DEFAULT_RECONCILE_MS = 60 * 60 * 1000;
const DEFAULT_CLEANUP_GRACE_MS = 60 * 60 * 1000;
const DEFAULT_MAX_FAILURES = 20;
const MAX_ERROR_LENGTH = 2000;

const boundedInteger = (value, fallback, min, max) => {
	const parsed = Number.parseInt(String(value ?? ""), 10);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(max, Math.max(min, parsed));
};

const cleanText = (value) => String(value || "").trim();

const safeErrorMessage = (error) =>
	cleanText(error?.message || error || "Unknown error").slice(0, MAX_ERROR_LENGTH);

const normalizeHotelIds = (values) =>
	new Set(
		(Array.isArray(values) ? values : cleanText(values).split(","))
			.map((value) => cleanText(value))
			.filter((value) => mongoose.isValidObjectId(value))
	);

const getHotelChangePaths = (change = {}) => {
	const description = change.updateDescription || {};
	const paths = [
		...Object.keys(description.updatedFields || {}),
		...(Array.isArray(description.removedFields) ? description.removedFields : []),
		...(Array.isArray(description.truncatedArrays)
			? description.truncatedArrays.map((item) => item?.field)
			: []),
	];
	return [...new Set(paths.map(cleanText).filter(Boolean))].sort();
};

const isMetadataOnlyHotelChange = (change = {}) => {
	if (change.operationType !== "update") return false;
	const paths = getHotelChangePaths(change);
	if (!paths.length) return false;
	return paths.every(
		(path) =>
			path === "updatedAt" ||
			path === "__v" ||
			path === "openaiKnowledge" ||
			path.startsWith("openaiKnowledge.")
	);
};

const retryDelayMs = (failureCount, random = Math.random) => {
	const steps = [15_000, 60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
	const base = steps[Math.min(Math.max(0, Number(failureCount || 1) - 1), steps.length - 1)];
	const jitter = Math.floor(base * 0.15 * Math.max(0, Math.min(1, random())));
	return base + jitter;
};

const leaseAvailableFilter = (now) => ({
	$or: [
		{ leaseUntil: { $exists: false } },
		{ leaseUntil: null },
		{ leaseUntil: { $lte: now } },
	],
});

const managedHotelQuery = (explicitHotelIds = new Set()) => {
	const choices = [{ "openaiKnowledge.autoSyncEnabled": true }];
	if (explicitHotelIds.size) {
		choices.push({ _id: { $in: [...explicitHotelIds] } });
	}
	return { $or: choices };
};

const documentIsManaged = (document, explicitHotelIds = new Set()) => {
	const hotelId = cleanText(document?._id);
	return (
		explicitHotelIds.has(hotelId) ||
		isKnowledgeManaged(document?.openaiKnowledge || null)
	);
};

const enqueueHotelKnowledgeSync = async ({
	hotelId,
	reason = "hotel_updated",
	paths = [],
	hotelUpdatedAt = null,
	resources = {},
	debounceMs = DEFAULT_DEBOUNCE_MS,
	resetFailures = true,
	now = new Date(),
	JobModel = HotelOpenAiKnowledgeSyncJob,
} = {}) => {
	const id = cleanText(hotelId);
	if (!mongoose.isValidObjectId(id)) return null;
	const runAfter = new Date(now.getTime() + Math.max(0, debounceMs));
	const setFields = {
		status: "pending",
		runAfter,
		lastTrigger: cleanText(reason),
		lastTriggerPaths: [...new Set((paths || []).map(cleanText).filter(Boolean))].slice(
			0,
			100
		),
		lastObservedAt: now,
	};
	if (resetFailures) {
		setFields.lastError = "";
		setFields.consecutiveFailures = 0;
	}
	if (hotelUpdatedAt) setFields.lastObservedHotelUpdatedAt = hotelUpdatedAt;
	if (resources.vectorStoreId) {
		setFields.lastKnownVectorStoreId = cleanText(resources.vectorStoreId);
	}
	if (resources.fileId) setFields.lastKnownFileId = cleanText(resources.fileId);
	const update = {
		$set: setFields,
		$setOnInsert: { hotelId: id },
		$inc: { generation: 1 },
	};
	try {
		return await JobModel.findOneAndUpdate({ hotelId: id }, update, {
			new: true,
			upsert: true,
			setDefaultsOnInsert: true,
		}).lean();
	} catch (error) {
		if (Number(error?.code) !== 11000) throw error;
		return JobModel.findOneAndUpdate({ hotelId: id }, update, { new: true }).lean();
	}
};

const enqueueCleanup = async ({
	hotelId,
	resources = {},
	deleteAfter,
	CleanupModel = HotelOpenAiKnowledgeCleanupJob,
} = {}) => {
	const vectorStoreId = cleanText(resources.vectorStoreId);
	if (!mongoose.isValidObjectId(cleanText(hotelId)) || !vectorStoreId) return null;
	const reset = await CleanupModel.findOneAndUpdate(
		{
			vectorStoreId,
			status: { $in: ["completed", "cancelled", "failed"] },
		},
		{
			$set: {
				hotelId,
				fileId: cleanText(resources.fileId),
				status: "pending",
				deleteAfter,
				attemptCount: 0,
				consecutiveFailures: 0,
				lastError: "",
			},
			$unset: { leaseOwner: 1, leaseUntil: 1, completedAt: 1 },
		},
		{ new: true }
	).lean();
	if (reset) return reset;

	const existing = await CleanupModel.findOne({ vectorStoreId }).lean();
	if (existing) {
		if (!existing.fileId && resources.fileId) {
			return CleanupModel.findOneAndUpdate(
				{ _id: existing._id, $or: [{ fileId: "" }, { fileId: { $exists: false } }] },
				{ $set: { fileId: cleanText(resources.fileId) } },
				{ new: true }
			).lean();
		}
		return existing;
	}

	try {
		return await CleanupModel.findOneAndUpdate(
			{ vectorStoreId },
			{
				$setOnInsert: {
					hotelId,
					vectorStoreId,
					fileId: cleanText(resources.fileId),
					status: "pending",
					deleteAfter,
				},
			},
			{ new: true, upsert: true, setDefaultsOnInsert: true }
		).lean();
	} catch (error) {
		if (Number(error?.code) !== 11000) throw error;
		return CleanupModel.findOne({ vectorStoreId }).lean();
	}
};

const isUnrecoverableResumeError = (error) =>
	new Set([9, 136, 237, 260, 280, 286, 40573]).has(Number(error?.code));

const createHotelOpenAiKnowledgeSyncWorker = ({
	HotelModel = HotelDetails,
	JobModel = HotelOpenAiKnowledgeSyncJob,
	CleanupModel = HotelOpenAiKnowledgeCleanupJob,
	CheckpointModel = HotelOpenAiKnowledgeSyncCheckpoint,
	syncHotel = syncHotelOpenAiVector,
	logger = console,
	managedHotelIds = process.env.HOTEL_OPENAI_KNOWLEDGE_HOTEL_IDS || "",
	coverageThrough = process.env.HOTEL_OPENAI_KNOWLEDGE_HORIZON_END || "",
	debounceMs = boundedInteger(
		process.env.HOTEL_OPENAI_KNOWLEDGE_DEBOUNCE_MS,
		DEFAULT_DEBOUNCE_MS,
		1000,
		60_000
	),
	pollMs = boundedInteger(
		process.env.HOTEL_OPENAI_KNOWLEDGE_POLL_MS,
		DEFAULT_POLL_MS,
		250,
		30_000
	),
	leaseMs = boundedInteger(
		process.env.HOTEL_OPENAI_KNOWLEDGE_LEASE_MS,
		DEFAULT_LEASE_MS,
		30_000,
		30 * 60_000
	),
	reconcileMs = boundedInteger(
		process.env.HOTEL_OPENAI_KNOWLEDGE_RECONCILE_MS,
		DEFAULT_RECONCILE_MS,
		5 * 60_000,
		24 * 60 * 60_000
	),
	cleanupGraceMs = boundedInteger(
		process.env.HOTEL_OPENAI_KNOWLEDGE_CLEANUP_GRACE_MS,
		DEFAULT_CLEANUP_GRACE_MS,
		5 * 60_000,
		7 * 24 * 60 * 60_000
	),
	maxFailures = DEFAULT_MAX_FAILURES,
	openAiClient = null,
	changeStreamEnabled =
		String(process.env.HOTEL_OPENAI_KNOWLEDGE_CHANGE_STREAM_ENABLED || "")
			.trim()
			.toLowerCase() === "true",
	instanceId = `${os.hostname()}:${process.pid}:${Math.random().toString(36).slice(2, 8)}`,
} = {}) => {
	const explicitHotelIds = normalizeHotelIds(managedHotelIds);
	const client =
		openAiClient ||
		new OpenAI({
			apiKey: process.env.OPENAI_API_KEY,
			timeout: boundedInteger(
				process.env.HOTEL_OPENAI_KNOWLEDGE_API_TIMEOUT_MS,
				60_000,
				10_000,
				5 * 60_000
			),
			maxRetries: 2,
		});
	let stopped = true;
	let tickTimer = null;
	let reconcileTimer = null;
	let streamRestartTimer = null;
	let streamRestarting = false;
	let changeStream = null;
	let streamClosingIntentionally = false;
	let streamRestartAttempts = 0;
	let reconcileAfterStreamRestart = false;
	let changeChain = Promise.resolve();
	let changePipelineFailed = false;
	let tickRunning = false;
	let activeCyclePromise = null;

	const saveCheckpoint = async (resumeToken, extra = {}) => {
		const set = { ...extra };
		if (resumeToken !== undefined) set.resumeToken = resumeToken;
		await CheckpointModel.findByIdAndUpdate(
			CHECKPOINT_ID,
			{ $set: set, $setOnInsert: { _id: CHECKPOINT_ID } },
			{ upsert: true, setDefaultsOnInsert: true }
		).lean();
	};

	const clearResumeToken = async () => {
		await CheckpointModel.updateOne(
			{ _id: CHECKPOINT_ID },
			{ $set: { resumeToken: null } },
			{ upsert: true }
		);
	};

	const enqueueDocument = async (document, reason, paths = [], observedAt = new Date()) => {
		if (!documentIsManaged(document, explicitHotelIds)) return null;
		return enqueueHotelKnowledgeSync({
			hotelId: document._id,
			reason,
			paths,
			hotelUpdatedAt: document.updatedAt || null,
			resources: knowledgeResources(document.openaiKnowledge),
			debounceMs,
			now: observedAt,
			JobModel,
		});
	};

	const handleHotelChange = async (change = {}) => {
		const observedAt = new Date();
		const hotelId = cleanText(change.documentKey?._id || change.fullDocument?._id);
		if (!hotelId) {
			await saveCheckpoint(change._id, { lastEventAt: observedAt });
			return { status: "ignored_missing_id" };
		}
		if (isMetadataOnlyHotelChange(change)) {
			await saveCheckpoint(change._id, { lastEventAt: observedAt });
			return { status: "ignored_metadata_only", hotelId };
		}
		const paths = getHotelChangePaths(change);
		let queued = null;
		if (change.operationType === "delete") {
			const existingJob = await JobModel.findOne({ hotelId }).lean();
			if (existingJob || explicitHotelIds.has(hotelId)) {
				queued = await enqueueHotelKnowledgeSync({
					hotelId,
					reason: "hotel_deleted",
					paths,
					resources: {
						vectorStoreId: existingJob?.lastKnownVectorStoreId,
						fileId: existingJob?.lastKnownFileId,
					},
					debounceMs: 0,
					now: observedAt,
					JobModel,
				});
			}
		} else if (change.fullDocument) {
			queued = await enqueueDocument(
				change.fullDocument,
				`change_stream_${change.operationType}`,
				paths,
				observedAt
			);
		}
		await saveCheckpoint(change._id, { lastEventAt: observedAt });
		return { status: queued ? "queued" : "ignored_unmanaged", hotelId };
	};

	const reconcile = async (reason = "periodic_reconciliation") => {
		const now = new Date();
		const hotels = await HotelModel.find(managedHotelQuery(explicitHotelIds))
			.select("_id updatedAt +openaiKnowledge")
			.lean();
		for (const hotel of hotels) {
			await enqueueHotelKnowledgeSync({
				hotelId: hotel._id,
				reason,
				hotelUpdatedAt: hotel.updatedAt || null,
				resources: knowledgeResources(hotel.openaiKnowledge),
				debounceMs: [
					"startup_reconciliation",
					"manual_once_reconciliation",
					"resume_token_recovery",
				].includes(reason)
					? 0
					: debounceMs,
				resetFailures: false,
				now,
				JobModel,
			});
		}
		await saveCheckpoint(undefined, {
			lastReconciledAt: now,
			lastReconciliationReason: reason,
		});
		logger.log(`[hotel-openai-sync] ${reason}: queued ${hotels.length} managed hotel(s).`);
		return hotels.length;
	};

	const claimSyncJob = (now = new Date()) =>
		JobModel.findOneAndUpdate(
			{
				status: { $in: ["pending", "retry", "processing"] },
				runAfter: { $lte: now },
				...leaseAvailableFilter(now),
			},
			{
				$set: {
					status: "processing",
					leaseOwner: instanceId,
					leaseAcquiredAt: now,
					leaseUntil: new Date(now.getTime() + leaseMs),
					lastStartedAt: now,
				},
				$inc: { attemptCount: 1 },
			},
			{ new: true, sort: { runAfter: 1, updatedAt: 1 } }
		).lean();

	const releaseStaleSyncLease = (jobId) =>
		JobModel.updateOne(
			{ _id: jobId, leaseOwner: instanceId },
			{
				$set: { status: "pending" },
				$unset: { leaseOwner: 1, leaseAcquiredAt: 1, leaseUntil: 1 },
			}
		);

	const finishSyncJob = async (job, result) => {
		const now = new Date();
		const updated = await JobModel.updateOne(
			{ _id: job._id, generation: job.generation, leaseOwner: instanceId },
			{
				$set: {
					status: "completed",
					lastCompletedAt: now,
					lastResult: cleanText(result?.status),
					lastSourceSha256: cleanText(result?.sourceSha256),
					lastError: cleanText(result?.postPublishError),
					consecutiveFailures: 0,
					lastKnownVectorStoreId: cleanText(
						result?.vectorStoreId || job.lastKnownVectorStoreId
					),
					lastKnownFileId: cleanText(result?.fileId || job.lastKnownFileId),
				},
				$unset: {
					runAfter: 1,
					leaseOwner: 1,
					leaseAcquiredAt: 1,
					leaseUntil: 1,
				},
			}
		);
		if (!(updated.modifiedCount ?? updated.nModified ?? 0)) {
			await releaseStaleSyncLease(job._id);
			return false;
		}
		return true;
	};

	const failSyncJob = async (job, error) => {
		const now = new Date();
		const current = await JobModel.findById(job._id).select("generation").lean();
		if (!current || Number(current.generation) !== Number(job.generation)) {
			await releaseStaleSyncLease(job._id);
			return;
		}
		const failureCount = Number(job.consecutiveFailures || 0) + 1;
		const terminal = failureCount >= maxFailures;
		const failed = await JobModel.updateOne(
			{ _id: job._id, generation: job.generation, leaseOwner: instanceId },
			{
				$set: {
					status: terminal ? "failed" : "retry",
					runAfter: new Date(now.getTime() + retryDelayMs(failureCount)),
					lastError: safeErrorMessage(error),
					lastResult: "failed",
					consecutiveFailures: failureCount,
				},
				$unset: { leaseOwner: 1, leaseAcquiredAt: 1, leaseUntil: 1 },
			}
		);
		if (!(failed.modifiedCount ?? failed.nModified ?? 0)) {
			await releaseStaleSyncLease(job._id);
		}
	};

	const processSyncJob = async (job) => {
		const heartbeat = setInterval(() => {
			JobModel.updateOne(
				{ _id: job._id, generation: job.generation, leaseOwner: instanceId },
				{ $set: { leaseUntil: new Date(Date.now() + leaseMs) } }
			).catch((error) =>
				logger.error("[hotel-openai-sync] lease heartbeat failed:", safeErrorMessage(error))
			);
		}, Math.max(10_000, Math.floor(leaseMs / 3)));
		if (typeof heartbeat.unref === "function") heartbeat.unref();
		try {
			const hotelId = cleanText(job.hotelId);
			const result = await syncHotel({
				hotelId,
				coverageThrough,
				requireManaged: true,
				explicitlyManaged: explicitHotelIds.has(hotelId),
				autoSyncEnabled: true,
				outputAudit: false,
				client,
				HotelModel,
				logger,
			});
			const jobResources = {
				vectorStoreId: cleanText(job.lastKnownVectorStoreId),
				fileId: cleanText(job.lastKnownFileId),
			};
			const priorResources = result?.previousResources?.vectorStoreId
				? result.previousResources
				: jobResources.vectorStoreId && jobResources.vectorStoreId !== result?.vectorStoreId
				? jobResources
				: null;
			if (
				priorResources?.vectorStoreId &&
				priorResources.vectorStoreId !== result?.vectorStoreId
			) {
				await enqueueCleanup({
					hotelId,
					resources: priorResources,
					deleteAfter: new Date(Date.now() + cleanupGraceMs),
					CleanupModel,
				});
			}
			await finishSyncJob(job, result);
			logger.log(`[hotel-openai-sync] ${hotelId}: ${result.status}.`);
			return result;
		} catch (error) {
			if (error?.candidateResources?.vectorStoreId) {
				try {
					await enqueueCleanup({
						hotelId: job.hotelId,
						resources: error.candidateResources,
						deleteAfter: new Date(Date.now() + cleanupGraceMs),
						CleanupModel,
					});
				} catch (cleanupError) {
					error.message = `${safeErrorMessage(error)}; delayed candidate cleanup could not be scheduled: ${safeErrorMessage(
						cleanupError
					)}`;
				}
			}
			await failSyncJob(job, error);
			logger.error(
				`[hotel-openai-sync] ${cleanText(job.hotelId)} failed safely:`,
				safeErrorMessage(error)
			);
			return null;
		} finally {
			clearInterval(heartbeat);
		}
	};

	const claimCleanupJob = (now = new Date()) =>
		CleanupModel.findOneAndUpdate(
			{
				status: { $in: ["pending", "retry", "processing"] },
				deleteAfter: { $lte: now },
				...leaseAvailableFilter(now),
			},
			{
				$set: {
					status: "processing",
					leaseOwner: instanceId,
					leaseUntil: new Date(now.getTime() + leaseMs),
					lastAttemptAt: now,
				},
				$inc: { attemptCount: 1 },
			},
			{ new: true, sort: { deleteAfter: 1, updatedAt: 1 } }
		).lean();

	const processCleanupJob = async (job) => {
		try {
			const hotel = await HotelModel.findById(job.hotelId)
				.select("_id +openaiKnowledge")
				.lean();
			const current = knowledgeResources(hotel?.openaiKnowledge);
			if (
				hotel &&
				!["retired", "expired"].includes(hotel.openaiKnowledge?.status) &&
				current.vectorStoreId === job.vectorStoreId
			) {
				await CleanupModel.updateOne(
					{ _id: job._id, leaseOwner: instanceId },
					{
						$set: {
							status: "cancelled",
							completedAt: new Date(),
							lastError: "Resource became active again; cleanup cancelled.",
						},
						$unset: { leaseOwner: 1, leaseUntil: 1 },
					}
				);
				return;
			}
			const failures = await deleteOpenAiResources(client, {
				vectorStoreId: job.vectorStoreId,
				fileId: job.fileId,
			});
			if (failures.length) throw new Error(failures.join("; "));
			if (
				hotel &&
				["retired", "expired"].includes(hotel.openaiKnowledge?.status) &&
				current.vectorStoreId === job.vectorStoreId
			) {
				await HotelModel.updateOne(
					{
						_id: hotel._id,
						"openaiKnowledge.status": hotel.openaiKnowledge.status,
						"openaiKnowledge.vectorStoreId": job.vectorStoreId,
					},
					{
						$set: {
							"openaiKnowledge.vectorStoreId": "",
							"openaiKnowledge.vectorStoreName": "",
							"openaiKnowledge.files": [],
						},
					},
					{ timestamps: false }
				);
			}
			await JobModel.updateOne(
				{
					hotelId: job.hotelId,
					lastKnownVectorStoreId: job.vectorStoreId,
				},
				{ $set: { lastKnownVectorStoreId: "", lastKnownFileId: "" } }
			);
			await CleanupModel.updateOne(
				{ _id: job._id, leaseOwner: instanceId },
				{
					$set: {
						status: "completed",
						completedAt: new Date(),
						lastError: "",
						consecutiveFailures: 0,
					},
					$unset: { leaseOwner: 1, leaseUntil: 1 },
				}
			);
		} catch (error) {
			const failureCount = Number(job.consecutiveFailures || 0) + 1;
			await CleanupModel.updateOne(
				{ _id: job._id, leaseOwner: instanceId },
				{
					$set: {
						status: failureCount >= maxFailures ? "failed" : "retry",
						deleteAfter: new Date(Date.now() + retryDelayMs(failureCount)),
						lastError: safeErrorMessage(error),
						consecutiveFailures: failureCount,
					},
					$unset: { leaseOwner: 1, leaseUntil: 1 },
				}
			);
			logger.error("[hotel-openai-sync] resource cleanup failed:", safeErrorMessage(error));
		}
	};

	const runOneCycle = async () => {
		const syncJob = await claimSyncJob();
		if (syncJob) {
			await processSyncJob(syncJob);
			return true;
		}
		const cleanupJob = await claimCleanupJob();
		if (cleanupJob) {
			await processCleanupJob(cleanupJob);
			return true;
		}
		return false;
	};

	const scheduleTick = (waitMs = pollMs) => {
		if (stopped) return;
		clearTimeout(tickTimer);
		tickTimer = setTimeout(async () => {
			if (tickRunning || stopped) return scheduleTick(pollMs);
			tickRunning = true;
			let worked = false;
			try {
				activeCyclePromise = runOneCycle();
				worked = await activeCyclePromise;
			} catch (error) {
				logger.error("[hotel-openai-sync] worker cycle failed:", safeErrorMessage(error));
			} finally {
				activeCyclePromise = null;
				tickRunning = false;
				scheduleTick(worked ? 0 : pollMs);
			}
		}, Math.max(0, waitMs));
		if (typeof tickTimer.unref === "function") tickTimer.unref();
	};

	const scheduleStreamRestart = async (error, { fromChangeHandler = false } = {}) => {
		if (stopped || streamRestarting || streamRestartTimer) return;
		streamRestarting = true;
		changePipelineFailed = true;
		streamClosingIntentionally = true;
		const streamToClose = changeStream;
		changeStream = null;
		if (streamToClose) {
			try {
				await streamToClose.close();
			} catch (_error) {
				// Reconnect below even if closing an already-failed stream throws.
			}
		}
		streamClosingIntentionally = false;
		if (!fromChangeHandler) await changeChain.catch(() => {});
		if (isUnrecoverableResumeError(error)) {
			try {
				await clearResumeToken();
				reconcileAfterStreamRestart = true;
			} catch (recoveryError) {
				logger.error(
					"[hotel-openai-sync] resume recovery failed:",
					safeErrorMessage(recoveryError)
				);
			}
		}
		streamRestartAttempts += 1;
		const waitMs = Math.min(60_000, 1000 * 2 ** Math.min(6, streamRestartAttempts - 1));
		streamRestartTimer = setTimeout(async () => {
			streamRestartTimer = null;
			streamRestarting = false;
			try {
				await openChangeStream();
				if (reconcileAfterStreamRestart) {
					reconcileAfterStreamRestart = false;
					await reconcile("resume_token_recovery");
				}
			} catch (openError) {
				logger.error(
					"[hotel-openai-sync] change stream restart failed:",
					safeErrorMessage(openError)
				);
				await scheduleStreamRestart(openError);
			}
		}, waitMs);
		if (typeof streamRestartTimer.unref === "function") streamRestartTimer.unref();
	};

	const openChangeStream = async () => {
		if (stopped || changeStream) return;
		changePipelineFailed = false;
		const checkpoint = await CheckpointModel.findById(CHECKPOINT_ID).lean();
		const options = { fullDocument: "updateLookup" };
		if (checkpoint?.resumeToken) options.resumeAfter = checkpoint.resumeToken;
		changeStream = HotelModel.watch(
			[
				{
					$match: {
						operationType: { $in: ["insert", "update", "replace", "delete"] },
					},
				},
			],
			options
		);
		changeStream.on("change", (change) => {
			streamRestartAttempts = 0;
			changeChain = changeChain.then(async () => {
				if (changePipelineFailed || stopped) return;
				try {
					await handleHotelChange(change);
				} catch (error) {
					changePipelineFailed = true;
					logger.error(
						"[hotel-openai-sync] change event failed before checkpoint:",
						safeErrorMessage(error)
					);
					await scheduleStreamRestart(error, { fromChangeHandler: true });
				}
			});
		});
		changeStream.on("error", (error) => {
			logger.error("[hotel-openai-sync] change stream error:", safeErrorMessage(error));
			scheduleStreamRestart(error).catch(() => {});
		});
		changeStream.on("close", () => {
			if (!stopped && !streamClosingIntentionally) {
				scheduleStreamRestart(new Error("HotelDetails change stream closed")).catch(
					() => {}
				);
			}
		});
		logger.log("[hotel-openai-sync] HotelDetails change stream is active.");
	};

	const start = async () => {
		if (!stopped) return;
		stopped = false;
		await Promise.all([JobModel.init(), CleanupModel.init(), CheckpointModel.init()]);
		if (changeStreamEnabled) {
			try {
				await openChangeStream();
			} catch (error) {
				if (!isUnrecoverableResumeError(error)) throw error;
				await clearResumeToken();
				await openChangeStream();
			}
		} else {
			logger.log(
				"[hotel-openai-sync] Mongo change stream disabled; using post-commit HotelDetails triggers."
			);
		}
		await reconcile("startup_reconciliation");
		reconcileTimer = setInterval(() => {
			reconcile("periodic_reconciliation").catch((error) =>
				logger.error("[hotel-openai-sync] reconciliation failed:", safeErrorMessage(error))
			);
		}, reconcileMs);
		if (typeof reconcileTimer.unref === "function") reconcileTimer.unref();
		scheduleTick(0);
	};

	const stop = async () => {
		stopped = true;
		clearTimeout(tickTimer);
		clearInterval(reconcileTimer);
		clearTimeout(streamRestartTimer);
		await changeChain.catch(() => {});
		if (activeCyclePromise) await activeCyclePromise.catch(() => {});
		if (changeStream) {
			streamClosingIntentionally = true;
			try {
				await changeStream.close();
			} catch (_error) {
				// Shutdown must remain best-effort.
			}
			changeStream = null;
		}
	};

	const runUntilIdle = async ({ maxCycles = 100 } = {}) => {
		let processed = 0;
		while (processed < maxCycles && (await runOneCycle())) {
			processed += 1;
		}
		return processed;
	};

	return {
		start,
		stop,
		reconcile,
		runOneCycle,
		runUntilIdle,
		handleHotelChange,
		enqueueHotelKnowledgeSync: (args) =>
			enqueueHotelKnowledgeSync({ ...args, debounceMs, JobModel }),
	};
};

module.exports = {
	CHECKPOINT_ID,
	DEFAULT_CLEANUP_GRACE_MS,
	DEFAULT_DEBOUNCE_MS,
	DEFAULT_LEASE_MS,
	DEFAULT_POLL_MS,
	createHotelOpenAiKnowledgeSyncWorker,
	documentIsManaged,
	enqueueCleanup,
	enqueueHotelKnowledgeSync,
	getHotelChangePaths,
	isMetadataOnlyHotelChange,
	managedHotelQuery,
	normalizeHotelIds,
	retryDelayMs,
	safeErrorMessage,
};
