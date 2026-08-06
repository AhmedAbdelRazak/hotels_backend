/** @format */

const crypto = require("crypto");
const express = require("express");
const mongoose = require("mongoose");
const multer = require("multer");
const HotelRunnerEvent = require("../models/hotelrunner_event");
const HotelRunnerReservation = require("../models/hotelrunner_reservation");
const HotelRunnerRoomMapping = require("../models/hotelrunner_room_mapping");
const HotelRunnerSyncState = require("../models/hotelrunner_sync_state");
const {
	getHotelRunnerConfig,
} = require("../services/hotelrunnerConfig");
const {
	loadConfiguredHotel,
	persistHotelRunnerBatch,
	safeErrorMessage,
} = require("../services/hotelrunnerEventService");
const {
	assignedHotelIds,
	isConfiguredSuperAdmin,
} = require("../services/adminReservationCycleScope");

const MAX_PARSER_BYTES = 2 * 1024 * 1024;
const ObjectId = mongoose.Types.ObjectId;

const urlencodedParser = express.urlencoded({
	extended: false,
	limit: MAX_PARSER_BYTES,
	parameterLimit: 5,
});

const multipartParser = multer({
	storage: multer.memoryStorage(),
	limits: {
		fieldSize: MAX_PARSER_BYTES,
		fields: 2,
		files: 0,
		parts: 3,
	},
}).none();

const digest = (value = "") =>
	crypto.createHash("sha256").update(String(value), "utf8").digest();

function timingSafeTextEqual(left, right) {
	const leftDigest = digest(left);
	const rightDigest = digest(right);
	return crypto.timingSafeEqual(leftDigest, rightDigest);
}

function oneQueryValue(value) {
	return typeof value === "string" && value.length > 0 ? value : "";
}

function callbackCredentialsMatch(query = {}, config = {}) {
	if (!config.configured) return false;
	const token = oneQueryValue(query.token);
	const hrId = oneQueryValue(query.hr_id);
	return Boolean(
		token &&
			hrId &&
			timingSafeTextEqual(token, config.token) &&
			timingSafeTextEqual(hrId, config.hrId)
	);
}

exports.hotelRunnerCallbackHealth = (_req, res) => {
	return res.status(200).json({ ok: true });
};

exports.requireHotelRunnerCallbackAuth = (req, res, next) => {
	if (req.hotelRunnerPreflightAuthenticated === true && req.hotelRunnerConfig) {
		return next();
	}
	const config = getHotelRunnerConfig();
	if (!config.configured) {
		res.set("Retry-After", "300");
		return res.status(503).json({ error: "Integration is temporarily unavailable." });
	}
	if (!callbackCredentialsMatch(req.query || {}, config)) {
		return res.status(401).json({ error: "Unauthorized" });
	}
	req.hotelRunnerConfig = config;
	return next();
};

exports.hotelRunnerCallbackPreflight = (req, res, next) => {
	if (req.method !== "POST") return next();
	return exports.requireHotelRunnerCallbackAuth(req, res, () => {
		const contentType = String(req.get("content-type") || "").toLowerCase();
		if (
			!contentType.startsWith("application/x-www-form-urlencoded") &&
			!contentType.startsWith("multipart/form-data")
		) {
			return res.status(415).json({
				error: "Only form-encoded HotelRunner callbacks are supported.",
			});
		}
		const declaredLength = Number(req.get("content-length") || 0);
		if (
			Number.isFinite(declaredLength) &&
			declaredLength > req.hotelRunnerConfig.callbackBodyLimitBytes
		) {
			return res.status(413).json({ error: "Callback payload is too large." });
		}
		req.hotelRunnerPreflightAuthenticated = true;
		return next();
	});
};

function parserFailure(res, error) {
	const isLimit =
		error?.type === "entity.too.large" ||
		String(error?.code || "").startsWith("LIMIT_");
	return res.status(isLimit ? 413 : 400).json({
		error: isLimit ? "Callback payload is too large." : "Invalid callback form payload.",
	});
}

exports.parseHotelRunnerCallbackForm = (req, res, next) => {
	const config = req.hotelRunnerConfig || getHotelRunnerConfig();
	const declaredLength = Number(req.get("content-length") || 0);
	if (
		Number.isFinite(declaredLength) &&
		declaredLength > Number(config.callbackBodyLimitBytes || MAX_PARSER_BYTES)
	) {
		return res.status(413).json({ error: "Callback payload is too large." });
	}

	const contentType = String(req.get("content-type") || "").toLowerCase();
	const done = (error) => {
		if (error) return parserFailure(res, error);
		const data = req.body?.data;
		if (typeof data !== "string") {
			return res.status(400).json({ error: "Callback data field is required." });
		}
		if (Buffer.byteLength(data, "utf8") > config.callbackBodyLimitBytes) {
			return res.status(413).json({ error: "Callback payload is too large." });
		}
		return next();
	};

	if (contentType.startsWith("application/x-www-form-urlencoded")) {
		return urlencodedParser(req, res, done);
	}
	if (contentType.startsWith("multipart/form-data")) {
		return multipartParser(req, res, done);
	}
	return res.status(415).json({
		error: "Only form-encoded HotelRunner callbacks are supported.",
	});
};

function parseCallbackEnvelope(data, maxReservations) {
	let envelope;
	try {
		envelope = JSON.parse(data);
	} catch {
		const error = new Error("Callback data is not valid JSON.");
		error.code = "HOTELRUNNER_INVALID_JSON";
		throw error;
	}
	if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
		const error = new Error("Callback envelope must be an object.");
		error.code = "HOTELRUNNER_INVALID_ENVELOPE";
		throw error;
	}
	if (
		!Array.isArray(envelope.reservations) ||
		envelope.reservations.length < 1 ||
		envelope.reservations.length > maxReservations
	) {
		const error = new Error("Callback reservations array is invalid.");
		error.code = "HOTELRUNNER_INVALID_RESERVATIONS";
		throw error;
	}
	return envelope;
}

function createHandleHotelRunnerCallback({
	loadHotel = loadConfiguredHotel,
	persistBatch = persistHotelRunnerBatch,
	now = () => new Date(),
} = {}) {
	return async (req, res) => {
		try {
			const config = req.hotelRunnerConfig || getHotelRunnerConfig();
			const envelope = parseCallbackEnvelope(
				req.body.data,
				config.callbackMaxReservations
			);
			const hotel = await loadHotel(config);
			await persistBatch({
				config,
				hotel,
				reservations: envelope.reservations,
				source: "push",
				receivedAt: now(),
			});
			return res.status(200).json({ status: "ok" });
		} catch (error) {
			if (
				[
					"HOTELRUNNER_INVALID_JSON",
					"HOTELRUNNER_INVALID_ENVELOPE",
					"HOTELRUNNER_INVALID_RESERVATIONS",
					"HOTELRUNNER_BATCH_LIMIT",
				].includes(error?.code)
			) {
				return res.status(422).json({ error: "Invalid HotelRunner callback payload." });
			}
			console.error("[hotelrunner] callback persistence failed", {
				code: String(error?.code || "HOTELRUNNER_CALLBACK_FAILED").slice(0, 80),
				message: safeErrorMessage(error),
			});
			res.set("Retry-After", "60");
			return res.status(503).json({ error: "Callback could not be stored." });
		}
	};
}

exports.handleHotelRunnerCallback = createHandleHotelRunnerCallback();

async function configuredAdminContext(req) {
	const config = getHotelRunnerConfig();
	const hotel = await loadConfiguredHotel(config);
	const actor = req?.profile || {};
	const allowed =
		isConfiguredSuperAdmin(actor) ||
		String(actor._id || "") === String(hotel.belongsTo || "") ||
		assignedHotelIds(actor).includes(String(hotel._id));
	if (!allowed) {
		const error = new Error("The configured HotelRunner property is outside this account scope.");
		error.statusCode = 403;
		throw error;
	}
	return { config, hotel };
}

exports.hotelRunnerAdminStatus = async (req, res) => {
	try {
		const { config, hotel } = await configuredAdminContext(req);
		const [eventCounts, projectionCounts, latestEvent, latestProcessed, syncState] =
			await Promise.all([
				HotelRunnerEvent.aggregate([
					{ $match: { hotelId: hotel._id } },
					{ $group: { _id: "$status", count: { $sum: 1 } } },
				]),
				HotelRunnerReservation.aggregate([
					{ $match: { hotelId: hotel._id } },
					{ $group: { _id: "$projectionStatus", count: { $sum: 1 } } },
				]),
				HotelRunnerEvent.findOne({ hotelId: hotel._id })
					.sort({ receivedAt: -1 })
					.select("receivedAt status source")
					.lean(),
				HotelRunnerEvent.findOne({
					hotelId: hotel._id,
					processedAt: { $ne: null },
				})
					.sort({ processedAt: -1 })
					.select("processedAt status source")
					.lean(),
				HotelRunnerSyncState.findOne({ hotelId: hotel._id }).lean(),
			]);
		return res.json({
			configuration: {
				tokenConfigured: Boolean(config.token),
				hrIdConfigured: Boolean(config.hrId),
				supportedPropertyCount: 1,
				pullEnabled: config.pullEnabled,
				projectionEnabled: config.projectionEnabled,
				confirmPulledDeliveryEnabled: config.confirmPulledDeliveryEnabled,
			},
			hotel: { _id: hotel._id, hotelName: hotel.hotelName || "" },
			queue: Object.fromEntries(eventCounts.map((row) => [row._id, row.count])),
			projections: Object.fromEntries(
				projectionCounts.map((row) => [row._id, row.count])
			),
			latestCallback: latestEvent || null,
			latestProcessed: latestProcessed || null,
			worker: syncState
				? {
						status: syncState.status,
						lastPullStartedAt: syncState.lastPullStartedAt,
						lastPullCompletedAt: syncState.lastPullCompletedAt,
						lastPullSucceededAt: syncState.lastPullSucceededAt,
						nextPullAt: syncState.nextPullAt,
						lastRoomListSyncAt: syncState.lastRoomListSyncAt,
						metrics: syncState.metrics || {},
				  }
				: null,
		});
	} catch (error) {
		if (error?.statusCode === 403) {
			return res.status(403).json({ error: "HotelRunner property access denied." });
		}
		return res.status(503).json({ error: "HotelRunner status is unavailable." });
	}
};

exports.listHotelRunnerRoomMappings = async (req, res) => {
	try {
		const { hotel } = await configuredAdminContext(req);
		const mappings = await HotelRunnerRoomMapping.find({ hotelId: hotel._id })
			.sort({ invCode: 1 })
			.lean();
		const roomOptions = (hotel.roomCountDetails || [])
			.filter((room) => room?.activeRoom !== false && room?._id)
			.map((room) => ({
				_id: room._id,
				roomType: room.roomType || "",
				displayName: room.displayName || room.roomType || "",
				count: Number(room.count || 0),
			}));
		return res.json({
			hotel: { _id: hotel._id, hotelName: hotel.hotelName || "" },
			mappings: mappings.map((mapping) => ({
				_id: mapping._id,
				invCode: mapping.invCode,
				rateCodes: mapping.rateCodes || [],
				ratePlanCodes: mapping.ratePlanCodes || [],
				externalName: mapping.externalName || "",
				externalNamePresentation: mapping.externalNamePresentation || "",
				isMaster: mapping.isMaster === true,
				roomListVerified: Boolean(mapping.roomListVerifiedAt),
				roomListVerifiedAt: mapping.roomListVerifiedAt || null,
				localRoomTypeId: mapping.localRoomConfigId || null,
				status: mapping.status,
				version: Number(mapping.__v || 0),
				lastSeenAt: mapping.lastSeenAt,
			})),
			roomOptions,
		});
	} catch (error) {
		if (error?.statusCode === 403) {
			return res.status(403).json({ error: "HotelRunner property access denied." });
		}
		return res.status(503).json({ error: "HotelRunner room mappings are unavailable." });
	}
};

exports.updateHotelRunnerRoomMapping = async (req, res) => {
	try {
		const { hotel } = await configuredAdminContext(req);
		const mappingId = String(req.params.mappingId || "").trim();
		const localRoomTypeId = String(req.body?.localRoomTypeId || "").trim();
		const enabled = req.body?.enabled === true;
		const expectedVersion = Number(req.body?.expectedVersion);
		if (
			!ObjectId.isValid(mappingId) ||
			!Number.isInteger(expectedVersion) ||
			expectedVersion < 0 ||
			(enabled && !ObjectId.isValid(localRoomTypeId))
		) {
			return res.status(400).json({ error: "Invalid room mapping update." });
		}
		const localRoom = enabled
			? (hotel.roomCountDetails || []).find(
					(room) =>
						String(room?._id || "") === localRoomTypeId &&
						room?.activeRoom !== false
			  )
			: null;
		if (enabled && !localRoom) {
			return res.status(400).json({
				error: "The selected PMS room category is not active for this hotel.",
			});
		}
		if (enabled) {
			const mapping = await HotelRunnerRoomMapping.findOne({
				_id: mappingId,
				hotelId: hotel._id,
			})
				.select("isMaster roomListVerifiedAt")
				.lean();
			if (!mapping) {
				return res.status(404).json({ error: "HotelRunner room mapping was not found." });
			}
			if (mapping.isMaster === true) {
				return res.status(422).json({
					error: "HotelRunner master fallback inventory cannot be mapped to a PMS room category.",
				});
			}
			if (!mapping.roomListVerifiedAt) {
				return res.status(422).json({
					error: "This inventory code must be verified by a HotelRunner room-list sync before it can be mapped.",
				});
			}
		}
		const updated = await HotelRunnerRoomMapping.findOneAndUpdate(
			{
				_id: mappingId,
				hotelId: hotel._id,
				__v: expectedVersion,
				...(enabled
					? {
							isMaster: { $ne: true },
							roomListVerifiedAt: { $type: "date" },
					  }
					: {}),
			},
			{
				$set: {
					localRoomConfigId: enabled ? localRoom._id : null,
					status: enabled ? "active" : "disabled",
					updatedBy: req.auth?._id || null,
					discoveredFrom: "manual",
				},
				$inc: { __v: 1 },
			},
			{ new: true }
		).lean();
		if (!updated) {
			return res.status(409).json({
				error: "This mapping changed. Refresh it before saving again.",
			});
		}
		if (enabled) {
			await HotelRunnerEvent.updateMany(
				{ hotelId: hotel._id, status: "needs_mapping" },
				{
					$set: {
						status: "pending",
						attempts: 0,
						nextAttemptAt: new Date(),
						errorMessage: "",
					},
					$unset: { leaseOwner: 1, leaseAcquiredAt: 1, leaseUntil: 1 },
				}
			).exec();
		}
		return res.json({
			mapping: {
				_id: updated._id,
				localRoomTypeId: updated.localRoomConfigId || null,
				status: updated.status,
				version: Number(updated.__v || 0),
			},
		});
	} catch (error) {
		if (error?.statusCode === 403) {
			return res.status(403).json({ error: "HotelRunner property access denied." });
		}
		return res.status(503).json({ error: "Room mapping could not be updated." });
	}
};

module.exports.callbackCredentialsMatch = callbackCredentialsMatch;
module.exports.createHandleHotelRunnerCallback = createHandleHotelRunnerCallback;
module.exports.parseCallbackEnvelope = parseCallbackEnvelope;
module.exports.timingSafeTextEqual = timingSafeTextEqual;
