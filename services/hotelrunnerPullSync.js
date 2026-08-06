/** @format */

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
	{ SyncStateModel = HotelRunnerSyncState } = {}
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
				lastPullStartedAt: now,
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

async function saveRoomList(
	hotelId,
	rows,
	{
		MappingModel = HotelRunnerRoomMapping,
		progressHeartbeat = null,
	} = {}
) {
	if (!Array.isArray(rows) || rows.length > 5_000) {
		const error = new Error("HotelRunner room list is invalid or too large.");
		error.code = "HOTELRUNNER_ROOM_LIST_INVALID";
		throw error;
	}
	const grouped = new Map();
	for (const raw of rows) {
		const room = normalizeRoomListRow(raw);
		if (!room.invCode) continue;
		if (!grouped.has(room.invCode)) grouped.set(room.invCode, []);
		grouped.get(room.invCode).push(room);
	}
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
		);
		const roomListVerifiedAt = new Date();
		await MappingModel.findOneAndUpdate(
			{ hotelId, invCode },
			{
				$setOnInsert: {
					hotelId,
					invCode,
					status: "pending",
					discoveredFrom: "room_list",
				},
				$set: {
					externalName: names[0] || "",
					externalNamePresentation: names.join(" / ").slice(0, 4_000),
					isMaster,
					roomListVerifiedAt,
					...(isMaster
						? { status: "conflict", localRoomConfigId: null }
						: {}),
					lastSeenAt: new Date(),
					notes: JSON.stringify({
						availabilityUpdate: variants.some((row) => row.availabilityUpdate),
						restrictionsUpdate: variants.some((row) => row.restrictionsUpdate),
						priceUpdate: variants.some((row) => row.priceUpdate),
						roomCapacity: variants[0]?.roomCapacity ?? null,
						adultCapacity: variants[0]?.adultCapacity ?? null,
						salesCurrency: variants[0]?.salesCurrency || "",
					}).slice(0, 4_000),
				},
				$addToSet: { rateCodes: { $each: rateCodes } },
			},
			{ upsert: true, new: true, setDefaultsOnInsert: true }
		).exec();
		mappingIndex += 1;
	}
	if (typeof progressHeartbeat === "function") await progressHeartbeat();
	return grouped.size;
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

	async function runIfDue(now = new Date()) {
		if (!config.pullEnabled) return { status: "disabled" };
		const hotel = await loadConfiguredHotel(config, dependencies);
		const current = await SyncStateModel.findOne({ hotelId: hotel._id })
			.select("+disabledConfigFingerprint")
			.lean();
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
		const progressHeartbeat = () =>
			renewPullLease(lease._id, instanceId, new Date(), { SyncStateModel });
		const cycleDependencies = { ...dependencies, progressHeartbeat };
		let roomMappingsSeen = 0;
		let roomListRefreshed = false;
		let roomListCompletedAt = null;
		try {
			await progressHeartbeat();
			const client = (dependencies.createClient || createHotelRunnerClient)({
				config,
				hotelId: hotel._id,
				fetchImpl: dependencies.fetchImpl,
				quotaDependencies: dependencies.quotaDependencies,
			});
			if (
				!lease.nextRoomListSyncAt ||
				new Date(lease.nextRoomListSyncAt) <= now
			) {
				await progressHeartbeat();
				const roomEnvelope = await client.getRooms();
				await progressHeartbeat();
				roomMappingsSeen = await saveRoomList(
					hotel._id,
					roomEnvelope?.rooms,
					cycleDependencies
				);
				roomListRefreshed = true;
				roomListCompletedAt = new Date();
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
			await SyncStateModel.updateOne(
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
								nextRoomListSyncAt: new Date(
									roomListCompletedAt.getTime() +
										config.roomListIntervalHours * 60 * 60 * 1000
								),
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
			throw error;
		}
	}

	return { runIfDue };
}

module.exports = {
	CREDENTIAL_FAILURE_HOLD_MS,
	HISTORY_INITIAL_LOOKBACK_DAYS,
	HISTORY_OVERLAP_DAYS,
	HISTORY_PAGE_OVERLAP,
	MAX_HISTORY_PAGES_PER_CYCLE,
	NON_RETRYABLE_FAILURE_DELAY_MS,
	PULL_LEASE_MS,
	claimSyncLease,
	createHotelRunnerPullSync,
	ensureSyncState,
	ingestPullEnvelope,
	nextJitteredDate,
	normalizeRoomListRow,
	pullHistory,
	renewPullLease,
	saveRoomList,
};
