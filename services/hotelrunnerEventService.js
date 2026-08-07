/** @format */

const HotelDetails = require("../models/hotel_details");
const HotelRunnerEvent = require("../models/hotelrunner_event");
const HotelRunnerReservation = require("../models/hotelrunner_reservation");
const HotelRunnerRoomMapping = require("../models/hotelrunner_room_mapping");
const HotelRunnerApiBudget = require("../models/hotelrunner_api_budget");
const HotelRunnerSyncState = require("../models/hotelrunner_sync_state");
const {
	eventKey,
	normalizeHotelRunnerReservation,
	stableClone,
} = require("./hotelrunnerPayload");

const HOTEL_SELECT =
	"_id hotelName belongsTo activateHotel xHotelProActive currency roomCountDetails";
const CONFLICT_ATTENTION_STATUSES = ["completed", "ignored", "attention"];

let hotelRunnerIndexesPromise = null;

const HOTELRUNNER_INDEX_MODEL_KEYS = Object.freeze([
	"EventModel",
	"MirrorModel",
	"MappingModel",
	"BudgetModel",
	"SyncStateModel",
]);

function ensureHotelRunnerIndexes(models = {}, options = {}) {
	const hasModelOverrides = HOTELRUNNER_INDEX_MODEL_KEYS.some((key) =>
		Object.prototype.hasOwnProperty.call(models || {}, key)
	);
	const useCachedPromise =
		options.useCachedPromise === undefined
			? !hasModelOverrides
			: options.useCachedPromise === true;
	if (useCachedPromise && hotelRunnerIndexesPromise) {
		return hotelRunnerIndexesPromise;
	}
	const modelList = [
		models.EventModel || HotelRunnerEvent,
		models.MirrorModel || HotelRunnerReservation,
		models.MappingModel || HotelRunnerRoomMapping,
		models.BudgetModel || HotelRunnerApiBudget,
		models.SyncStateModel || HotelRunnerSyncState,
	];
	const createPromise = Promise.all(
		modelList.map((model) => model.createIndexes())
	);
	if (!useCachedPromise) return createPromise;

	hotelRunnerIndexesPromise = createPromise.catch((error) => {
		hotelRunnerIndexesPromise = null;
		throw error;
	});
	return hotelRunnerIndexesPromise;
}

const resetHotelRunnerIndexesPromiseForTests = () => {
	hotelRunnerIndexesPromise = null;
};

function safeErrorMessage(error, fallback = "HotelRunner operation failed.") {
	const text = String(error?.message || fallback)
		.replace(/[\r\n\t]+/g, " ")
		.replace(
			/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi,
			"$1[REDACTED]@"
		)
		.replace(
			/(token|hr_id|authorization|cookie)\s*[=:]\s*[^\s,&]+/gi,
			"$1=[REDACTED]"
		)
		.trim();
	return text.slice(0, 500) || fallback;
}

async function loadConfiguredHotel(
	config,
	{ HotelModel = HotelDetails, readiness = "worker" } = {},
) {
	const configurationReady =
		readiness === "callback"
			? config?.callbackConfigured === true
			: config?.configured === true;
	if (!configurationReady || !config.hotelId) {
		const error = new Error("HotelRunner integration is not configured.");
		error.code = "HOTELRUNNER_CONFIG_INVALID";
		throw error;
	}
	const hotel = await HotelModel.findOne({
		_id: config.hotelId,
		activateHotel: true,
		xHotelProActive: { $ne: false },
	})
		.select(HOTEL_SELECT)
		.lean()
		.exec();
	if (!hotel || !hotel.belongsTo) {
		const error = new Error(
			"The HotelRunner property is not bound to an active PMS hotel and owner."
		);
		error.code = "HOTELRUNNER_PROPERTY_NOT_READY";
		throw error;
	}
	return hotel;
}

function eventInsertDocument({ config, hotel, rawReservation, source, receivedAt }) {
	const normalized = normalizeHotelRunnerReservation(rawReservation, { receivedAt });
	const processable = normalized.issues.length === 0;
	return {
		normalized,
		document: {
			hotelId: hotel._id,
			eventKey: eventKey(config.hrIdFingerprint, normalized.messageUid),
			messageUid: normalized.messageUid,
			payloadHash: normalized.payloadHash,
			canonicalHash: normalized.canonicalHash,
			source: source === "pull" ? "pull" : "push",
			hotelRunnerReservationId:
				normalized.hotelRunnerReservationId || `invalid-${normalized.payloadHash.slice(0, 24)}`,
			hrNumber: normalized.hrNumber,
			providerNumber: normalized.providerNumber,
			channel: normalized.channel,
			state: normalized.state,
			modified: normalized.modified,
			sourceUpdatedAt: normalized.sourceUpdatedAt || receivedAt,
			payload: stableClone(normalized.storedPayload || {}),
			status: processable ? "pending" : "quarantined",
			integrityReason: processable ? "" : normalized.issues.join(","),
			nextAttemptAt: receivedAt,
			receivedAt,
		},
	};
}

async function persistHotelRunnerDelivery(
	{
		config,
		hotel,
		rawReservation,
		source = "push",
		receivedAt = new Date(),
	} = {},
	{ EventModel = HotelRunnerEvent } = {}
) {
	const prepared = eventInsertDocument({
		config,
		hotel,
		rawReservation,
		source,
		receivedAt,
	});
	const event = await EventModel.findOneAndUpdate(
		{ eventKey: prepared.document.eventKey },
		{
			$setOnInsert: prepared.document,
			$set: { lastReceivedAt: receivedAt },
			$inc: { deliveryCount: 1 },
		},
		{ upsert: true, new: true, setDefaultsOnInsert: true }
	).exec();

	if (event.payloadHash !== prepared.document.payloadHash) {
		const conflictRecord = {
			payloadHash: prepared.document.payloadHash,
			canonicalHash: prepared.document.canonicalHash,
			receivedAt,
			payload: prepared.document.payload,
		};
		// A different payload for one message UID is handled in one server-side
		// state transition. Only a processing event with a named, unexpired lease
		// may keep projecting the first payload. Every unclaimed, retryable, mapping-
		// blocked, ownerless, or expired event is quarantined. Already processed work
		// becomes attention without losing its result or PMS link.
		const activeProcessing = {
			$and: [
				{ $eq: ["$status", "processing"] },
				{
					$ne: [
						{ $trim: { input: { $ifNull: ["$leaseOwner", ""] } } },
						"",
					],
				},
				{ $eq: [{ $type: "$leaseUntil" }, "date"] },
				{ $gt: ["$leaseUntil", { $literal: receivedAt }] },
			],
		};
		const alreadyProcessed = {
			$in: ["$status", CONFLICT_ATTENTION_STATUSES],
		};
		const quarantineConflict = {
			$not: [{ $or: [activeProcessing, alreadyProcessed] }],
		};
		const conflictEvent = await EventModel.findOneAndUpdate(
			{ _id: event._id, payloadHash: event.payloadHash },
			[
				{
					$set: {
						integrityConflict: true,
						integrityConflictCount: {
							$add: [{ $ifNull: ["$integrityConflictCount", 0] }, 1],
						},
						integrityConflicts: {
							$slice: [
								{
									$concatArrays: [
										{ $ifNull: ["$integrityConflicts", []] },
										[{ $literal: conflictRecord }],
									],
								},
								-5,
							],
						},
						status: {
							$cond: [
								activeProcessing,
								"processing",
								{
									$cond: [alreadyProcessed, "attention", "quarantined"],
								},
							],
						},
						integrityReason: {
							$cond: [
								quarantineConflict,
								"message_uid_payload_conflict",
								{ $ifNull: ["$integrityReason", ""] },
							],
						},
						processedAt: {
							$cond: [
								quarantineConflict,
								{ $literal: receivedAt },
								"$processedAt",
							],
						},
						leaseOwner: {
							$cond: [activeProcessing, "$leaseOwner", ""],
						},
						leaseAcquiredAt: {
							$cond: [activeProcessing, "$leaseAcquiredAt", null],
						},
						leaseUntil: {
							$cond: [activeProcessing, "$leaseUntil", null],
						},
					},
				},
			],
			{ new: true }
		).exec();
		if (!conflictEvent) {
			const error = new Error(
				"HotelRunner event changed while recording a payload integrity conflict."
			);
			error.code = "HOTELRUNNER_EVENT_CONFLICT_CAS_LOST";
			error.retryable = true;
			throw error;
		}
		const firstPayloadWins = conflictEvent.status === "processing";
		return {
			eventId: event._id,
			status: conflictEvent.status,
			duplicate: false,
			integrityConflict: true,
			firstPayloadWins,
			activeProcessing: conflictEvent.status === "processing",
			integrityConflictCount: Number(
				conflictEvent.integrityConflictCount || 0
			),
		};
	}

	let revived = false;
	if (event.status === "failed") {
		const revival = await EventModel.updateOne(
			{
				_id: event._id,
				status: "failed",
				payloadHash: prepared.document.payloadHash,
				integrityReason: { $in: ["", null] },
				"integrityConflicts.0": { $exists: false },
			},
			{
				$set: {
					status: "pending",
					attempts: 0,
					nextAttemptAt: receivedAt,
					processedAt: null,
					finalRecoveryAttempted: false,
					finalRecoveryClaimedAt: null,
					errorCode: "",
					errorMessage: "",
					result: {},
				},
				$unset: { leaseOwner: 1, leaseAcquiredAt: 1, leaseUntil: 1 },
			}
		).exec();
		revived =
			Number(revival?.modifiedCount ?? revival?.nModified ?? revival?.n ?? 0) > 0;
	}

	return {
		eventId: event._id,
		status: revived ? "pending" : event.status,
		duplicate: Number(event.deliveryCount || 0) > 1,
		integrityConflict: false,
		revived,
	};
}

async function persistHotelRunnerBatch(
	{
		config,
		hotel,
		reservations,
		source = "push",
		receivedAt = new Date(),
	} = {},
	dependencies = {}
) {
	const progressHeartbeat =
		typeof dependencies.progressHeartbeat === "function"
			? dependencies.progressHeartbeat
			: null;
	if (progressHeartbeat) await progressHeartbeat();
	if (dependencies.skipIndexInitialization !== true) {
		await ensureHotelRunnerIndexes(dependencies);
		if (progressHeartbeat) await progressHeartbeat();
	}
	if (!Array.isArray(reservations)) {
		const error = new Error("HotelRunner reservations must be an array.");
		error.code = "HOTELRUNNER_INVALID_ENVELOPE";
		throw error;
	}
	if (reservations.length < 1 || reservations.length > config.callbackMaxReservations) {
		const error = new Error("HotelRunner callback batch size is outside the allowed range.");
		error.code = "HOTELRUNNER_BATCH_LIMIT";
		throw error;
	}
	const results = [];
	for (let index = 0; index < reservations.length; index += 1) {
		if (progressHeartbeat && index > 0 && index % 25 === 0) {
			await progressHeartbeat();
		}
		const rawReservation = reservations[index];
		results.push(
			await persistHotelRunnerDelivery(
				{ config, hotel, rawReservation, source, receivedAt },
				dependencies
			)
		);
	}
	if (progressHeartbeat) await progressHeartbeat();
	return results;
}

module.exports = {
	HOTEL_SELECT,
	eventInsertDocument,
	ensureHotelRunnerIndexes,
	loadConfiguredHotel,
	persistHotelRunnerBatch,
	persistHotelRunnerDelivery,
	resetHotelRunnerIndexesPromiseForTests,
	safeErrorMessage,
};
