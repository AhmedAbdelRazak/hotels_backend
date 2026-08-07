/** @format */

const crypto = require("crypto");
const HotelRunnerEvent = require("../models/hotelrunner_event");
const HotelRunnerRoomMapping = require("../models/hotelrunner_room_mapping");
const HotelRunnerSyncState = require("../models/hotelrunner_sync_state");
const {
	loadConfiguredHotel,
	persistHotelRunnerBatch,
	safeErrorMessage,
} = require("./hotelrunnerEventService");
const {
	createHotelRunnerClient,
} = require("./hotelrunnerClient");
const {
	cleanIdentifier,
	cleanText,
} = require("./hotelrunnerPayload");

const PULL_LEASE_MS = 10 * 60 * 1000;
const MAX_HISTORY_PAGES_PER_CYCLE = 3;
const HISTORY_INITIAL_LOOKBACK_DAYS = 29;
const HISTORY_OVERLAP_DAYS = 2;
const HISTORY_PAGE_OVERLAP = 1;
const CREDENTIAL_FAILURE_HOLD_MS = 24 * 60 * 60 * 1000;
const NON_RETRYABLE_FAILURE_DELAY_MS = 6 * 60 * 60 * 1000;
const ROOM_LIST_PROJECTION_LEASE_MS = PULL_LEASE_MS;

const addDays = (date, days) => new Date(date.getTime() + days * 86_400_000);
const dateOnly = (date) => date.toISOString().slice(0, 10);

function nextJitteredDate(minutes, now = new Date(), random = Math.random) {
	const jitter = (random() * 0.2 - 0.1) * minutes;
	return new Date(now.getTime() + Math.max(5, minutes + jitter) * 60_000);
}

async function ensureSyncState(hotelId, { SyncStateModel = HotelRunnerSyncState } = {}) {
	await SyncStateModel.updateOne(
		{ hotelId },
		{
			$setOnInsert: {
				hotelId,
				status: "idle",
				nextPullAt: new Date(),
				nextRoomListSyncAt: new Date(),
			},
		},
		{ upsert: true, setDefaultsOnInsert: true }
	).exec();
}

async function claimSyncLease(
	hotelId,
	instanceId,
	now = new Date(),
	{ SyncStateModel = HotelRunnerSyncState, operation = "pull" } = {}
) {
	await ensureSyncState(hotelId, { SyncStateModel });
	return SyncStateModel.findOneAndUpdate(
		{
			hotelId,
			$or: [
				{ leaseUntil: { $exists: false } },
				{ leaseUntil: null },
				{ leaseUntil: { $lte: now } },
				{ leaseOwner: instanceId },
			],
		},
		{
			$set: {
				status: "pulling",
				leaseOwner: instanceId,
				leaseUntil: new Date(now.getTime() + PULL_LEASE_MS),
				...(operation === "room_list"
					? { lastRoomListStartedAt: now }
					: { lastPullStartedAt: now }),
			},
		},
		{ new: true }
	).lean();
}

async function renewPullLease(
	leaseId,
	instanceId,
	now = new Date(),
	{ SyncStateModel = HotelRunnerSyncState } = {}
) {
	const result = await SyncStateModel.updateOne(
		{ _id: leaseId, leaseOwner: instanceId },
		{ $set: { leaseUntil: new Date(now.getTime() + PULL_LEASE_MS) } }
	).exec();
	const matched = Number(result?.matchedCount ?? result?.n ?? 0);
	if (!matched) {
		const error = new Error("HotelRunner pull lease was lost before the cycle completed.");
		error.code = "HOTELRUNNER_PULL_LEASE_LOST";
		error.retryable = true;
		throw error;
	}
	return true;
}

function normalizeRoomListRow(row = {}) {
	if (!row || typeof row !== "object" || Array.isArray(row)) row = {};
	return {
		invCode: cleanIdentifier(row.inv_code),
		rateCode: cleanIdentifier(row.rate_code),
		name: cleanText(row.name),
		description: cleanText(row.description),
		isMaster: row.is_master === true,
		roomCapacity: Number.isFinite(Number(row.room_capacity))
			? Number(row.room_capacity)
			: null,
		adultCapacity: Number.isFinite(Number(row.adult_capacity))
			? Number(row.adult_capacity)
			: null,
		availabilityUpdate: row.availability_update === true,
		restrictionsUpdate: row.restrictions_update === true,
		priceUpdate: row.price_update === true,
		salesCurrency: cleanIdentifier(row.sales_currency).toUpperCase(),
		sellOnline: row.sell_online === true,
	};
}

async function claimRoomListProjectionLease(
	hotelId,
	owner,
	now = new Date(),
	{ SyncStateModel = HotelRunnerSyncState } = {}
) {
	await ensureSyncState(hotelId, { SyncStateModel });
	return SyncStateModel.findOneAndUpdate(
		{
			hotelId,
			$or: [
				{ projectionLeaseUntil: { $exists: false } },
				{ projectionLeaseUntil: null },
				{ projectionLeaseUntil: { $lte: now } },
				{ projectionLeaseOwner: owner },
			],
		},
		{
			$set: {
				projectionLeaseOwner: owner,
				projectionLeaseAcquiredAt: now,
				projectionLeaseUntil: new Date(
					now.getTime() + ROOM_LIST_PROJECTION_LEASE_MS
				),
			},
		},
		{ new: true }
	).lean();
}

async function renewRoomListProjectionLease(
	hotelId,
	owner,
	now = new Date(),
	{ SyncStateModel = HotelRunnerSyncState } = {}
) {
	const result = await SyncStateModel.updateOne(
		{ hotelId, projectionLeaseOwner: owner },
		{
			$set: {
				projectionLeaseUntil: new Date(
					now.getTime() + ROOM_LIST_PROJECTION_LEASE_MS
				),
			},
		}
	).exec();
	const matched = Number(result?.matchedCount ?? result?.n ?? 0);
	if (!matched) {
		const error = new Error(
			"HotelRunner room-list projection lease was lost before publication."
		);
		error.code = "HOTELRUNNER_PROJECTION_LEASE_LOST";
		error.retryable = true;
		throw error;
	}
	return true;
}

async function releaseRoomListProjectionLease(
	hotelId,
	owner,
	now = new Date(),
	{ SyncStateModel = HotelRunnerSyncState } = {}
) {
	return SyncStateModel.updateOne(
		{ hotelId, projectionLeaseOwner: owner },
		{
			$set: { projectionLeaseUntil: now },
			$unset: {
				projectionLeaseOwner: 1,
				projectionLeaseAcquiredAt: 1,
			},
		}
	).exec();
}

function distinctRoomVariantValues(variants, key, normalize = (value) => value) {
	return Array.from(
		new Set(
			variants
				.map((variant) => variant[key])
				.filter(
					(value) => value !== null && value !== undefined && value !== ""
				)
				.map(normalize)
		)
	);
}

function inconsistentRoomVariantFields(variants = []) {
	const inconsistent = [];
	const checks = [
		["master_flag", "isMaster", (value) => String(value)],
		["room_capacity", "roomCapacity", (value) => String(value)],
		["adult_capacity", "adultCapacity", (value) => String(value)],
		[
			"sales_currency",
			"salesCurrency",
			(value) => cleanIdentifier(value).toUpperCase(),
		],
	];
	for (const [label, key, normalize] of checks) {
		if (distinctRoomVariantValues(variants, key, normalize).length > 1) {
			inconsistent.push(label);
		}
	}
	return inconsistent;
}

function createRoomListSyncGeneration(verifiedAt = new Date()) {
	return `${verifiedAt.toISOString()}-${crypto.randomBytes(12).toString("hex")}`;
}

async function saveRoomList(
	hotelId,
	rows,
	{
		MappingModel = HotelRunnerRoomMapping,
		progressHeartbeat = null,
		verifiedAt = new Date(),
		syncGeneration = "",
	} = {}
) {
	if (!Array.isArray(rows) || rows.length < 1 || rows.length > 5_000) {
		const error = new Error("HotelRunner room list is invalid or too large.");
		error.code = "HOTELRUNNER_ROOM_LIST_INVALID";
		throw error;
	}
	const verificationTime = new Date(verifiedAt);
	if (!Number.isFinite(verificationTime.getTime())) {
		const error = new Error("HotelRunner room-list verification time is invalid.");
		error.code = "HOTELRUNNER_ROOM_LIST_INVALID";
		throw error;
	}
	const generation =
		cleanIdentifier(syncGeneration) ||
		createRoomListSyncGeneration(verificationTime);
	const grouped = new Map();
	for (const raw of rows) {
		const room = normalizeRoomListRow(raw);
		if (!room.invCode) {
			const error = new Error(
				"HotelRunner room list contains a row without an inventory code."
			);
			error.code = "HOTELRUNNER_ROOM_LIST_INVALID";
			throw error;
		}
		if (!grouped.has(room.invCode)) grouped.set(room.invCode, []);
		grouped.get(room.invCode).push(room);
	}
	const existingMappings = await MappingModel.find({ hotelId })
		.select(
			"invCode status localRoomConfigId isMaster variantConflict roomListVerifiedAt"
		)
		.lean()
		.exec();
	const existingByInvCode = new Map(
		(existingMappings || []).map((mapping) => [mapping.invCode, { ...mapping }])
	);

	// Invalidate proof before staging a new generation, but preserve the operator's
	// mapping intent. Omitted/conflicting inventory is disabled only after a full
	// room list has been saved. The property-level sync state publishes the staged
	// generation later, in the caller's successful final state write.
	await MappingModel.updateMany(
		{ hotelId },
		{
			$set: {
				roomListVerifiedAt: null,
				roomListVerificationState: "refreshing",
			},
			$inc: { __v: 1 },
		}
	).exec();

	let mappingIndex = 0;
	for (const [invCode, variants] of grouped) {
		if (
			typeof progressHeartbeat === "function" &&
			mappingIndex > 0 &&
			mappingIndex % 25 === 0
		) {
			await progressHeartbeat();
		}
		const names = Array.from(new Set(variants.map((row) => row.name).filter(Boolean)));
		const isMaster = variants.some((row) => row.isMaster);
		const rateCodes = Array.from(
			new Set(variants.map((row) => row.rateCode).filter(Boolean))
		).sort();
		const variantConflictFields = inconsistentRoomVariantFields(variants);
		const variantConflict = variantConflictFields.length > 0;
		const previous = existingByInvCode.get(invCode) || null;
		const mayRestoreActive =
			previous?.status === "active" &&
			Boolean(previous.localRoomConfigId) &&
			previous.isMaster !== true &&
			previous.variantConflict !== true;
		let desiredStatus = "pending";
		if (isMaster || variantConflict) desiredStatus = "conflict";
		else if (mayRestoreActive) desiredStatus = "active";
		else if (previous?.status === "disabled") desiredStatus = "disabled";
		await MappingModel.findOneAndUpdate(
			{ hotelId, invCode },
			{
				$setOnInsert: {
					hotelId,
					invCode,
					discoveredFrom: "room_list",
				},
				$set: {
					externalName: names[0] || "",
					externalNamePresentation: names.join(" / ").slice(0, 4_000),
					isMaster,
					roomListVerifiedAt: variantConflict ? null : verificationTime,
					roomListSyncGeneration: generation,
					roomListLastSeenAt: verificationTime,
					roomListVerificationState:
						isMaster || variantConflict ? "conflict" : "verified",
					variantConflict,
					variantConflictFields,
					status: desiredStatus,
					...(isMaster || variantConflict
						? { localRoomConfigId: null }
						: {}),
					rateCodes,
					lastSeenAt: verificationTime,
					notes: JSON.stringify({
						availabilityUpdate: variants.some((row) => row.availabilityUpdate),
						restrictionsUpdate: variants.some((row) => row.restrictionsUpdate),
						priceUpdate: variants.some((row) => row.priceUpdate),
						roomCapacity: variants[0]?.roomCapacity ?? null,
						adultCapacity: variants[0]?.adultCapacity ?? null,
						salesCurrency: variants[0]?.salesCurrency || "",
						variantConflictFields,
					}).slice(0, 4_000),
				},
				$inc: { __v: 1 },
				$unset: { roomListRetiredAt: 1 },
			},
			{ upsert: true, new: true, setDefaultsOnInsert: true }
		).exec();
		mappingIndex += 1;
	}
	await MappingModel.updateMany(
		{
			hotelId,
			roomListSyncGeneration: { $ne: generation },
		},
		{
			$set: {
				status: "disabled",
				localRoomConfigId: null,
				roomListVerifiedAt: null,
				roomListVerificationState: "retired",
				roomListRetiredAt: verificationTime,
			},
			$inc: { __v: 1 },
		}
	).exec();
	if (typeof progressHeartbeat === "function") await progressHeartbeat();
	return grouped.size;
}

async function requeueResolvedStaleMappingEvents(
	hotelId,
	activeGeneration,
	{
		MappingModel = HotelRunnerRoomMapping,
		SyncStateModel = HotelRunnerSyncState,
		EventModel = HotelRunnerEvent,
	} = {}
) {
	const generation = cleanIdentifier(activeGeneration);
	if (!generation || !EventModel) return 0;
	const state = await SyncStateModel.findOne({ hotelId })
		.select("activeRoomListSyncGeneration")
		.lean()
		.exec();
	if (cleanIdentifier(state?.activeRoomListSyncGeneration) !== generation) {
		return 0;
	}
	const activeMappings = await MappingModel.find({
		hotelId,
		roomListSyncGeneration: generation,
		roomListVerificationState: "verified",
		roomListVerifiedAt: { $type: "date" },
		variantConflict: { $ne: true },
		isMaster: { $ne: true },
		status: "active",
		localRoomConfigId: { $ne: null },
	})
		.select("invCode")
		.lean()
		.exec();
	const activeInvCodes = Array.from(
		new Set((activeMappings || []).map((mapping) => cleanIdentifier(mapping.invCode)).filter(Boolean))
	);
	if (!activeInvCodes.length) return 0;
	const safeArrayExpression = (path) => ({
		$cond: [{ $isArray: path }, path, []],
	});
	const staleCodes = safeArrayExpression("$result.staleInvCodes");
	const missingCodes = safeArrayExpression("$result.missingInvCodes");
	const update = await EventModel.updateMany(
		{
			hotelId,
			status: "needs_mapping",
			"result.code": "hotelrunner_room_mapping_stale",
			$expr: {
				$and: [
					{ $gt: [{ $size: staleCodes }, 0] },
					{ $setIsSubset: [staleCodes, activeInvCodes] },
					{ $setIsSubset: [missingCodes, activeInvCodes] },
				],
			},
		},
		{
			$set: {
				status: "pending",
				attempts: 0,
				nextAttemptAt: new Date(),
				errorCode: "",
				errorMessage: "",
			},
			$unset: { leaseOwner: 1, leaseAcquiredAt: 1, leaseUntil: 1 },
		}
	).exec();
	return Number(update?.modifiedCount ?? update?.nModified ?? 0);
}

async function completePublishedRoomListRequeue(
	hotelId,
	activeGeneration,
	dependencies = {}
) {
	const generation = cleanIdentifier(activeGeneration);
	if (!generation) return 0;
	const SyncStateModel = dependencies.SyncStateModel || HotelRunnerSyncState;
	const requeued = await requeueResolvedStaleMappingEvents(
		hotelId,
		generation,
		{ ...dependencies, SyncStateModel }
	);
	await SyncStateModel.updateOne(
		{
			hotelId,
			activeRoomListSyncGeneration: generation,
			roomListRequeuePendingGeneration: generation,
		},
		{ $unset: { roomListRequeuePendingGeneration: 1 } }
	).exec();
	return requeued;
}

async function ingestPullEnvelope(envelope, context, dependencies) {
	const reservations = Array.isArray(envelope?.reservations)
		? envelope.reservations
		: null;
	if (!reservations) {
		const error = new Error("HotelRunner pull response has no reservations array.");
		error.code = "HOTELRUNNER_PULL_RESPONSE_INVALID";
		throw error;
	}
	if (!reservations.length) return [];
	return persistHotelRunnerBatch(
		{
			...context,
			reservations,
			source: "pull",
			receivedAt: new Date(),
		},
		dependencies
	);
}

async function pullHistory(
	{ client, config, hotel, syncState = {}, now = new Date() },
	dependencies
) {
	const parsedCursor = syncState.historyCursorFrom
		? new Date(syncState.historyCursorFrom)
		: null;
	const cursorFrom =
		parsedCursor && Number.isFinite(parsedCursor.getTime())
			? parsedCursor
			: addDays(now, -HISTORY_INITIAL_LOOKBACK_DAYS);
	const parsedCycleStart = syncState.historyCycleStartedAt
		? new Date(syncState.historyCycleStartedAt)
		: null;
	const cycleStartedAt =
		parsedCycleStart && Number.isFinite(parsedCycleStart.getTime())
			? parsedCycleStart
			: now;
	let page = Math.max(1, Number(syncState.historyCursorPage || 1));
	let processed = 0;
	for (let requestIndex = 0; requestIndex < MAX_HISTORY_PAGES_PER_CYCLE; requestIndex += 1) {
		if (typeof dependencies.progressHeartbeat === "function") {
			await dependencies.progressHeartbeat();
		}
		const envelope = await client.retrieveReservations({
			undelivered: false,
			page,
			perPage: 50,
			fromLastUpdateDate: dateOnly(cursorFrom),
		});
		const results = await ingestPullEnvelope(
			envelope,
			{ config, hotel },
			dependencies
		);
		processed += results.length;
		const reservations = Array.isArray(envelope?.reservations)
			? envelope.reservations
			: [];
		const pages = Number(envelope?.pages || 0);
		const completedWindow =
			!reservations.length ||
			(Number.isFinite(pages) && pages > 0 && page >= pages) ||
			(!(Number.isFinite(pages) && pages > 0) && reservations.length < 50);
		if (completedWindow) {
			return {
				processed,
				historyCursorFrom: addDays(cycleStartedAt, -HISTORY_OVERLAP_DAYS),
				historyCursorPage: 1,
				historyCycleStartedAt: null,
				backlog: false,
			};
		}
		page += 1;
	}
	return {
		processed,
		historyCursorFrom: cursorFrom,
		// Re-read the last completed page on the next cycle. HotelRunner does not
		// expose a snapshot token, so this bounded overlap reduces mutation-driven
		// pagination gaps while event idempotency absorbs the duplicate delivery.
		historyCursorPage: Math.max(1, page - HISTORY_PAGE_OVERLAP),
		historyCycleStartedAt: cycleStartedAt,
		backlog: true,
	};
}

function createHotelRunnerPullSync({ config, instanceId, dependencies = {} } = {}) {
	const SyncStateModel = dependencies.SyncStateModel || HotelRunnerSyncState;
	const random = dependencies.random || Math.random;

	async function runRoomListOnly(now = new Date()) {
		const hotel = await loadConfiguredHotel(config, dependencies);
		const current = await SyncStateModel.findOne({ hotelId: hotel._id })
			.select("+disabledConfigFingerprint")
			.lean();
		if (current?.roomListRequeuePendingGeneration) {
			await completePublishedRoomListRequeue(
				hotel._id,
				current.roomListRequeuePendingGeneration,
				{ ...dependencies, SyncStateModel }
			);
		}
		const sameCredentialHold =
			current?.status === "disabled" &&
			current.disabledConfigFingerprint === config.credentialFingerprint;
		if (
			sameCredentialHold &&
			current?.nextPullAt &&
			new Date(current.nextPullAt) > now
		) {
			return { status: "disabled_credential_hold", apiCalls: 0 };
		}
		const recoveringWithChangedCredentials =
			current?.status === "disabled" &&
			current.disabledConfigFingerprint !== config.credentialFingerprint;
		if (
			!recoveringWithChangedCredentials &&
			current?.nextRoomListSyncAt &&
			new Date(current.nextRoomListSyncAt) > now
		) {
			return { status: "not_due", apiCalls: 0 };
		}
		const lease = await claimSyncLease(hotel._id, instanceId, now, {
			SyncStateModel,
			operation: "room_list",
		});
		if (!lease) return { status: "leased_elsewhere", apiCalls: 0 };
		const roomProjectionOwner = `${instanceId}:room-list`;
		let roomProjectionLease = null;
		const progressHeartbeat = async () => {
			await renewPullLease(lease._id, instanceId, new Date(), { SyncStateModel });
			await renewRoomListProjectionLease(
				hotel._id,
				roomProjectionOwner,
				new Date(),
				{ SyncStateModel }
			);
		};
		try {
			roomProjectionLease = await claimRoomListProjectionLease(
				hotel._id,
				roomProjectionOwner,
				now,
				{ SyncStateModel }
			);
			if (!roomProjectionLease) {
				await SyncStateModel.updateOne(
					{ _id: lease._id, leaseOwner: instanceId },
					{
						$set: { status: "idle" },
						$unset: { leaseOwner: 1, leaseUntil: 1 },
					}
				).exec();
				return { status: "projection_leased_elsewhere", apiCalls: 0 };
			}
			await progressHeartbeat();
			const client = (dependencies.createClient || createHotelRunnerClient)({
				config,
				hotelId: hotel._id,
				fetchImpl: dependencies.fetchImpl,
				quotaDependencies: dependencies.quotaDependencies,
			});
			const roomEnvelope = await client.getRooms();
			await progressHeartbeat();
			const roomListVerifiedAt = new Date();
			const roomListSyncGeneration = createRoomListSyncGeneration(
				roomListVerifiedAt
			);
			const roomMappingsSeen = await saveRoomList(
				hotel._id,
				roomEnvelope?.rooms,
				{
					...dependencies,
					progressHeartbeat,
					verifiedAt: roomListVerifiedAt,
					syncGeneration: roomListSyncGeneration,
				}
			);
			const completedAt = new Date();
			const completionWrite = await SyncStateModel.updateOne(
				{ _id: lease._id, leaseOwner: instanceId },
				{
					$set: {
						status: "idle",
						lastRoomListSyncAt: completedAt,
						lastRoomListCompletedAt: completedAt,
						activeRoomListSyncGeneration: roomListSyncGeneration,
						activeRoomListPublishedAt: completedAt,
						roomListRequeuePendingGeneration: roomListSyncGeneration,
						nextRoomListSyncAt: new Date(
							completedAt.getTime() +
								config.roomListIntervalHours * 60 * 60 * 1000
						),
						lastErrorCode: "",
						lastErrorMessage: "",
					},
					$inc: { "metrics.roomListPulls": 1 },
					$unset: {
						leaseOwner: 1,
						leaseUntil: 1,
						disabledConfigFingerprint: 1,
					},
				}
			).exec();
			const completionMatched = Number(
				completionWrite?.matchedCount ?? completionWrite?.n ?? 0
			);
			if (!completionMatched) {
				const error = new Error(
					"HotelRunner room-list lease was lost before completion state was saved."
				);
				error.code = "HOTELRUNNER_PULL_LEASE_LOST";
				error.retryable = true;
				throw error;
			}
			await completePublishedRoomListRequeue(
				hotel._id,
				roomListSyncGeneration,
				{ ...dependencies, SyncStateModel }
			);
			return { status: "completed", roomMappingsSeen, apiCalls: 1 };
		} catch (error) {
			const credentialFailure = error?.credentialFault === true;
			const retryDelay = credentialFailure
				? CREDENTIAL_FAILURE_HOLD_MS
				: error?.retryable === false
					? Math.max(
						NON_RETRYABLE_FAILURE_DELAY_MS,
						Number(error?.retryAfterMs || 0)
					  )
					: Math.max(5 * 60 * 1000, Number(error?.retryAfterMs || 0));
			const failureAt = new Date(Math.max(Date.now(), now.getTime()));
			await SyncStateModel.updateOne(
				{ _id: lease._id, leaseOwner: instanceId },
				{
					$set: {
						status: credentialFailure ? "disabled" : "retry",
						nextPullAt: new Date(failureAt.getTime() + retryDelay),
						nextRoomListSyncAt: new Date(failureAt.getTime() + retryDelay),
						...(credentialFailure
							? { disabledConfigFingerprint: config.credentialFingerprint }
							: {}),
						lastErrorCode: cleanIdentifier(
							error?.code || "HOTELRUNNER_ROOM_LIST_FAILED"
						),
						lastErrorMessage: safeErrorMessage(error),
					},
					$inc: { "metrics.pullFailures": 1 },
					$unset: {
						leaseOwner: 1,
						leaseUntil: 1,
						...(credentialFailure ? {} : { disabledConfigFingerprint: 1 }),
					},
				}
			).exec();
			throw error;
		} finally {
			if (roomProjectionLease) {
				await releaseRoomListProjectionLease(
					hotel._id,
					roomProjectionOwner,
					new Date(),
					{ SyncStateModel }
				);
			}
		}
	}

	async function runIfDue(now = new Date()) {
		if (!config.pullEnabled) return { status: "disabled" };
		const hotel = await loadConfiguredHotel(config, dependencies);
		const current = await SyncStateModel.findOne({ hotelId: hotel._id })
			.select("+disabledConfigFingerprint")
			.lean();
		if (current?.roomListRequeuePendingGeneration) {
			await completePublishedRoomListRequeue(
				hotel._id,
				current.roomListRequeuePendingGeneration,
				{ ...dependencies, SyncStateModel }
			);
		}
		const sameCredentialHold =
			current?.status === "disabled" &&
			current.disabledConfigFingerprint === config.credentialFingerprint;
		if (
			sameCredentialHold &&
			current?.nextPullAt &&
			new Date(current.nextPullAt) > now
		) {
			return { status: "disabled_credential_hold" };
		}
		const recoveringWithChangedCredentials =
			current?.status === "disabled" &&
			current.disabledConfigFingerprint !== config.credentialFingerprint;
		if (
			!recoveringWithChangedCredentials &&
			current?.nextPullAt &&
			new Date(current.nextPullAt) > now
		) {
			return { status: "not_due" };
		}
		const lease = await claimSyncLease(
			hotel._id,
			instanceId,
			now,
			{ SyncStateModel }
		);
		if (!lease) return { status: "leased_elsewhere" };
		const roomProjectionOwner = `${instanceId}:room-list`;
		let roomProjectionLease = null;
		const progressHeartbeat = async () => {
			await renewPullLease(lease._id, instanceId, new Date(), { SyncStateModel });
			if (roomProjectionLease) {
				await renewRoomListProjectionLease(
					hotel._id,
					roomProjectionOwner,
					new Date(),
					{ SyncStateModel }
				);
			}
		};
		const cycleDependencies = { ...dependencies, progressHeartbeat };
		let roomMappingsSeen = 0;
		let roomListRefreshed = false;
		let roomListCompletedAt = null;
		let roomListSyncGeneration = "";
		try {
			await progressHeartbeat();
			const client = (dependencies.createClient || createHotelRunnerClient)({
				config,
				hotelId: hotel._id,
				fetchImpl: dependencies.fetchImpl,
				quotaDependencies: dependencies.quotaDependencies,
			});
			if (
				config.roomListSyncEnabled === true &&
				(!lease.nextRoomListSyncAt ||
					new Date(lease.nextRoomListSyncAt) <= now)
			) {
				roomProjectionLease = await claimRoomListProjectionLease(
					hotel._id,
					roomProjectionOwner,
					now,
					{ SyncStateModel }
				);
				if (roomProjectionLease) {
					await progressHeartbeat();
					const roomEnvelope = await client.getRooms();
					await progressHeartbeat();
					const roomListVerifiedAt = new Date();
					roomListSyncGeneration = createRoomListSyncGeneration(
						roomListVerifiedAt
					);
					roomMappingsSeen = await saveRoomList(
						hotel._id,
						roomEnvelope?.rooms,
						{
							...cycleDependencies,
							verifiedAt: roomListVerifiedAt,
							syncGeneration: roomListSyncGeneration,
						}
					);
					roomListRefreshed = true;
					roomListCompletedAt = new Date();
				}
			}
			const pullResult = await pullHistory(
				{ client, config, hotel, syncState: lease, now },
				cycleDependencies
			);
			await progressHeartbeat();
			const completedAt = new Date();
			const completionWrite = await SyncStateModel.updateOne(
				{ _id: lease._id, leaseOwner: instanceId },
				{
					$set: {
						status: "idle",
						lastPullCompletedAt: completedAt,
						lastPullSucceededAt: completedAt,
						historyCursorFrom: pullResult.historyCursorFrom,
						historyCursorPage: pullResult.historyCursorPage,
						historyCycleStartedAt: pullResult.historyCycleStartedAt,
						nextPullAt: nextJitteredDate(
							config.pullIntervalMinutes,
							completedAt,
							random
						),
						lastRoomListSyncAt: roomListRefreshed
							? completedAt
							: lease.lastRoomListSyncAt,
						...(roomListRefreshed
							? {
								lastRoomListCompletedAt: completedAt,
								activeRoomListSyncGeneration:
									roomListSyncGeneration,
								activeRoomListPublishedAt: completedAt,
								roomListRequeuePendingGeneration:
									roomListSyncGeneration,
							  }
							: {}),
						nextRoomListSyncAt: roomListRefreshed
							? new Date(
									completedAt.getTime() +
										config.roomListIntervalHours * 60 * 60 * 1000
							  )
							: lease.nextRoomListSyncAt,
						lastErrorCode: "",
						lastErrorMessage: "",
					},
					$inc: {
						"metrics.pulls": 1,
						"metrics.eventsReceived": pullResult.processed,
					},
					$unset: {
						leaseOwner: 1,
						leaseUntil: 1,
						disabledConfigFingerprint: 1,
					},
				}
			).exec();
			const completionMatched = Number(
				completionWrite?.matchedCount ?? completionWrite?.n ?? 0
			);
			if (!completionMatched) {
				const leaseError = new Error(
					"HotelRunner pull lease was lost before completion state was saved."
				);
				leaseError.code = "HOTELRUNNER_PULL_LEASE_LOST";
				leaseError.retryable = true;
				throw leaseError;
			}
			if (roomListRefreshed) {
				await completePublishedRoomListRequeue(
					hotel._id,
					roomListSyncGeneration,
					{ ...dependencies, SyncStateModel }
				);
			}
			return {
				status: "completed",
				processed: pullResult.processed,
				confirmed: 0,
				backlog: pullResult.backlog,
				roomMappingsSeen,
			};
		} catch (error) {
			const credentialFailure = error?.credentialFault === true;
			const retryDelay = credentialFailure
				? CREDENTIAL_FAILURE_HOLD_MS
				: error?.retryable === false
					? Math.max(
						NON_RETRYABLE_FAILURE_DELAY_MS,
						Number(error?.retryAfterMs || 0)
					  )
					: Math.max(5 * 60 * 1000, Number(error?.retryAfterMs || 0));
			const failureAt = new Date(Math.max(Date.now(), now.getTime()));
			const failureWrite = await SyncStateModel.updateOne(
				{ _id: lease._id, leaseOwner: instanceId },
				{
					$set: {
						status: credentialFailure ? "disabled" : "retry",
						lastPullCompletedAt: failureAt,
						nextPullAt: new Date(failureAt.getTime() + retryDelay),
						...(credentialFailure
							? { disabledConfigFingerprint: config.credentialFingerprint }
							: {}),
						...(roomListRefreshed
							? {
								lastRoomListSyncAt: roomListCompletedAt,
								lastRoomListCompletedAt: roomListCompletedAt,
								nextRoomListSyncAt: new Date(
									roomListCompletedAt.getTime() +
										config.roomListIntervalHours * 60 * 60 * 1000
								),
								activeRoomListSyncGeneration:
									roomListSyncGeneration,
								activeRoomListPublishedAt: roomListCompletedAt,
								roomListRequeuePendingGeneration:
									roomListSyncGeneration,
							  }
							: {}),
						lastErrorCode: cleanIdentifier(
							error?.code || "HOTELRUNNER_PULL_FAILED"
						),
						lastErrorMessage: safeErrorMessage(error),
					},
					$inc: { "metrics.pullFailures": 1 },
					$unset: {
						leaseOwner: 1,
						leaseUntil: 1,
						...(credentialFailure ? {} : { disabledConfigFingerprint: 1 }),
					},
				}
			).exec();
			const failureMatched = Number(
				failureWrite?.matchedCount ?? failureWrite?.n ?? 0
			);
			if (roomListRefreshed && failureMatched) {
				await completePublishedRoomListRequeue(
					hotel._id,
					roomListSyncGeneration,
					{ ...dependencies, SyncStateModel }
				);
			}
			throw error;
		} finally {
			if (roomProjectionLease) {
				await releaseRoomListProjectionLease(
					hotel._id,
					roomProjectionOwner,
					new Date(),
					{ SyncStateModel }
				);
			}
		}
	}

	return { runIfDue, runRoomListOnly };
}

module.exports = {
	CREDENTIAL_FAILURE_HOLD_MS,
	HISTORY_INITIAL_LOOKBACK_DAYS,
	HISTORY_OVERLAP_DAYS,
	HISTORY_PAGE_OVERLAP,
	MAX_HISTORY_PAGES_PER_CYCLE,
	NON_RETRYABLE_FAILURE_DELAY_MS,
	PULL_LEASE_MS,
	ROOM_LIST_PROJECTION_LEASE_MS,
	claimRoomListProjectionLease,
	claimSyncLease,
	completePublishedRoomListRequeue,
	createHotelRunnerPullSync,
	ensureSyncState,
	ingestPullEnvelope,
	nextJitteredDate,
	normalizeRoomListRow,
	pullHistory,
	releaseRoomListProjectionLease,
	requeueResolvedStaleMappingEvents,
	renewPullLease,
	renewRoomListProjectionLease,
	saveRoomList,
};
