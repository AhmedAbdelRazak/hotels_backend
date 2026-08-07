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
const MIN_ROOM_LIST_VERIFICATION_AGE_HOURS = 48;
const ROOM_LIST_VERIFICATION_INTERVAL_MULTIPLIER = 3;
const ROOM_LIST_FUTURE_SKEW_MS = 5 * 60 * 1000;
const ObjectId = mongoose.Types.ObjectId;
const callbackEnvelopeDiagnostics = new WeakMap();
const CALLBACK_STRUCTURAL_KEYS = new Set([
	"reservations",
	"reservation",
	"data",
	"count",
	"current_page",
	"pages",
	"reservation_id",
	"hr_number",
	"provider_number",
	"message_uid",
]);

const roomListVerificationWindow = (config = {}, now = new Date()) => {
	const reference = new Date(now);
	const referenceMs = Number.isFinite(reference.getTime())
		? reference.getTime()
		: Date.now();
	const maxAgeMs =
		Math.max(
			MIN_ROOM_LIST_VERIFICATION_AGE_HOURS,
			Number(config.roomListIntervalHours || 24) *
				ROOM_LIST_VERIFICATION_INTERVAL_MULTIPLIER
		) *
		60 *
		60 *
		1000;
	return {
		referenceMs,
		earliest: new Date(referenceMs - maxAgeMs),
		latest: new Date(referenceMs + ROOM_LIST_FUTURE_SKEW_MS),
	};
};

const hasCurrentRoomListProof = (
	mapping,
	window,
	activeRoomListSyncGeneration = ""
) => {
	const verifiedAtMs = mapping?.roomListVerifiedAt
		? new Date(mapping.roomListVerifiedAt).getTime()
		: Number.NaN;
	return Boolean(
		activeRoomListSyncGeneration &&
		mapping?.roomListSyncGeneration &&
		mapping.roomListSyncGeneration === activeRoomListSyncGeneration &&
		mapping?.roomListVerificationState === "verified" &&
		mapping?.variantConflict !== true &&
		Number.isFinite(verifiedAtMs) &&
		verifiedAtMs >= window.earliest.getTime() &&
		verifiedAtMs <= window.latest.getTime()
	);
};

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
	if (!config.callbackConfigured) return false;
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
	if (!config.callbackConfigured) {
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

const callbackPayloadError = (code, message, diagnostics = {}) => {
	const error = new Error(message);
	error.code = code;
	error.callbackDiagnostics = diagnostics;
	return error;
};

const callbackValueType = (value) =>
	Array.isArray(value) ? "array" : value === null ? "null" : typeof value;

const recognizedCallbackKeys = (value) =>
	value && typeof value === "object" && !Array.isArray(value)
		? Object.keys(value)
				.filter((key) => CALLBACK_STRUCTURAL_KEYS.has(key))
				.sort()
		: [];

const callbackContentTypeFamily = (req) => {
	const contentType = String(req?.get?.("content-type") || "").toLowerCase();
	if (contentType.startsWith("application/x-www-form-urlencoded")) {
		return "urlencoded";
	}
	if (contentType.startsWith("multipart/form-data")) return "multipart";
	return "other";
};

function decodeCallbackJson(data) {
	let value = data;
	let jsonLayers = 0;
	let percentDecoded = false;
	while (typeof value === "string" && jsonLayers < 3) {
		const text = value.trim().replace(/^\uFEFF/, "");
		try {
			value = JSON.parse(text);
			jsonLayers += 1;
			continue;
		} catch {
			// Some form clients encode the JSON value a second time. Express/multer
			// already decode the normal form layer; accept exactly one additional
			// percent-encoded JSON layer without relaxing authentication or limits.
			if (
				!percentDecoded &&
				/^(?:%EF%BB%BF)?%(?:7B|5B|22)/i.test(text)
			) {
				try {
					value = decodeURIComponent(text.replace(/\+/g, "%20"));
					percentDecoded = true;
					continue;
				} catch {
					// Fall through to the stable, non-sensitive rejection below.
				}
			}
			throw callbackPayloadError(
				"HOTELRUNNER_INVALID_JSON",
				"Callback data is not valid JSON.",
				{
					bytes: Buffer.byteLength(String(data || ""), "utf8"),
					jsonLayers,
					percentDecoded,
				}
			);
		}
	}
	return { value, jsonLayers, percentDecoded };
}

const looksLikeReservation = (value) =>
	Boolean(
		value &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			Object.prototype.hasOwnProperty.call(value, "message_uid") &&
			(Object.prototype.hasOwnProperty.call(value, "reservation_id") ||
				Object.prototype.hasOwnProperty.call(value, "hr_number"))
	);

function parseCallbackEnvelope(data, maxReservations) {
	const decoded = decodeCallbackJson(data);
	let envelope = decoded.value;
	const originalValue = envelope;
	let representation = "documented_envelope";
	let nestedJsonLayers = 0;
	let nestedPercentDecoded = false;

	// The documented REST shape is { reservations: [...] }. Keep compatibility
	// with production senders that serialize that form value twice, send the
	// reservations member as JSON, or omit only the outer collection wrapper.
	if (
		envelope &&
		typeof envelope === "object" &&
		!Array.isArray(envelope) &&
		typeof envelope.reservations === "string"
	) {
		const nestedDecoded = decodeCallbackJson(envelope.reservations);
		const nested = nestedDecoded.value;
		nestedJsonLayers = nestedDecoded.jsonLayers;
		nestedPercentDecoded = nestedDecoded.percentDecoded;
		representation = "encoded_reservations_member";
		envelope = {
			...envelope,
			reservations: Array.isArray(nested)
				? nested
				: nested && Array.isArray(nested.reservations)
					? nested.reservations
					: nested,
		};
	}
	if (Array.isArray(envelope) && envelope.every(looksLikeReservation)) {
		representation = "top_level_reservations_array";
		envelope = { reservations: envelope };
	} else if (looksLikeReservation(envelope)) {
		representation = "top_level_reservation";
		envelope = { reservations: [envelope] };
	} else if (
		envelope &&
		typeof envelope === "object" &&
		!Array.isArray(envelope) &&
		looksLikeReservation(envelope.reservation)
	) {
		representation = "singular_reservation_member";
		envelope = { ...envelope, reservations: [envelope.reservation] };
	}

	if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
		throw callbackPayloadError(
			"HOTELRUNNER_INVALID_ENVELOPE",
			"Callback envelope must be an object.",
			{
				decodedType: callbackValueType(envelope),
				jsonLayers: decoded.jsonLayers,
				percentDecoded: decoded.percentDecoded,
			}
		);
	}
	if (
		!Array.isArray(envelope.reservations) ||
		envelope.reservations.length < 1 ||
		envelope.reservations.length > maxReservations
	) {
		throw callbackPayloadError(
			"HOTELRUNNER_INVALID_RESERVATIONS",
			"Callback reservations array is invalid.",
			{
				recognizedTopLevelKeys: recognizedCallbackKeys(envelope),
				topLevelKeyCount: Object.keys(envelope).length,
				reservationsType: callbackValueType(envelope.reservations),
				reservationCount: Array.isArray(envelope.reservations)
					? envelope.reservations.length
					: null,
				jsonLayers: decoded.jsonLayers,
				percentDecoded: decoded.percentDecoded,
			}
		);
	}
	callbackEnvelopeDiagnostics.set(envelope, {
		representation,
		decodedType: callbackValueType(originalValue),
		recognizedTopLevelKeys: recognizedCallbackKeys(originalValue),
		reservationCount: envelope.reservations.length,
		jsonLayers: decoded.jsonLayers,
		percentDecoded: decoded.percentDecoded,
		nestedJsonLayers,
		nestedPercentDecoded,
	});
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
			const hotel = await loadHotel(config, { readiness: "callback" });
			await persistBatch({
				config,
				hotel,
				reservations: envelope.reservations,
				source: "push",
				receivedAt: now(),
			});
			console.info("[hotelrunner] callback envelope durably accepted", {
				contentType: callbackContentTypeFamily(req),
				bytes: Buffer.byteLength(String(req.body.data || ""), "utf8"),
				...(callbackEnvelopeDiagnostics.get(envelope) || {}),
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
				console.warn("[hotelrunner] callback payload rejected", {
					code: String(error.code).slice(0, 80),
					diagnostics: {
						contentType: callbackContentTypeFamily(req),
						bytes: Buffer.byteLength(String(req?.body?.data || ""), "utf8"),
						...(error.callbackDiagnostics || {}),
					},
				});
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
		const projectionCutoff =
			config.projectionNotBefore instanceof Date &&
			Number.isFinite(config.projectionNotBefore.getTime())
				? config.projectionNotBefore
				: null;
		const eligibleProjectionFacts = {
			source: "push",
			...(projectionCutoff
				? {
					receivedAt: { $gte: projectionCutoff },
					sourceUpdatedAt: { $gte: projectionCutoff },
				  }
				: {}),
		};
		const eligibleEventMatch = {
			hotelId: hotel._id,
			...eligibleProjectionFacts,
		};
		const noneligibleEventMatch = {
			hotelId: hotel._id,
			$nor: [eligibleProjectionFacts],
		};
		const [
			eventCounts,
			projectionCounts,
			latestEvent,
			latestProcessed,
			syncState,
			preActivationEventCount,
		] =
			await Promise.all([
				HotelRunnerEvent.aggregate([
					{ $match: eligibleEventMatch },
					{ $group: { _id: "$status", count: { $sum: 1 } } },
				]),
				HotelRunnerReservation.aggregate([
					{ $match: { hotelId: hotel._id } },
					{ $group: { _id: "$projectionStatus", count: { $sum: 1 } } },
				]),
				HotelRunnerEvent.findOne({ hotelId: hotel._id })
					.sort({ receivedAt: -1 })
					.select(
						"receivedAt status source integrityConflict integrityConflictCount"
					)
					.lean(),
				HotelRunnerEvent.findOne({
					hotelId: hotel._id,
					processedAt: { $ne: null },
				})
					.sort({ processedAt: -1 })
					.select(
						"processedAt status source integrityConflict integrityConflictCount"
					)
					.lean(),
				HotelRunnerSyncState.findOne({ hotelId: hotel._id }).lean(),
				HotelRunnerEvent.countDocuments(noneligibleEventMatch),
			]);
		return res.json({
			configuration: {
				tokenConfigured: Boolean(config.token),
				hrIdConfigured: Boolean(config.hrId),
				supportedPropertyCount: 1,
				pullEnabled: config.pullEnabled,
				roomListSyncEnabled: config.roomListSyncEnabled,
				projectionEnabled: config.projectionEnabled,
				projectionNotBefore: config.projectionNotBeforeIso || null,
				confirmPulledDeliveryEnabled: config.confirmPulledDeliveryEnabled,
				requireOtaReview: config.requireOtaReview,
			},
			hotel: { _id: hotel._id, hotelName: hotel.hotelName || "" },
			queue: Object.fromEntries(eventCounts.map((row) => [row._id, row.count])),
			archive: {
				preActivationEventCount: Number(preActivationEventCount || 0),
			},
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
		const { config, hotel } = await configuredAdminContext(req);
		const verificationWindow = roomListVerificationWindow(config);
		const [mappings, syncState] = await Promise.all([
			HotelRunnerRoomMapping.find({ hotelId: hotel._id })
				.sort({ invCode: 1 })
				.lean(),
			HotelRunnerSyncState.findOne({ hotelId: hotel._id })
				.select("activeRoomListSyncGeneration")
				.lean(),
		]);
		const activeRoomListSyncGeneration = String(
			syncState?.activeRoomListSyncGeneration || ""
		).trim();
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
				roomListVerified: hasCurrentRoomListProof(
					mapping,
					verificationWindow,
					activeRoomListSyncGeneration
				),
				roomListVerifiedAt: mapping.roomListVerifiedAt || null,
				roomListVerificationState:
					mapping.roomListVerificationState || "unverified",
				variantConflict: mapping.variantConflict === true,
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
		const { config, hotel } = await configuredAdminContext(req);
		if (!isConfiguredSuperAdmin(req?.profile || {})) {
			return res.status(403).json({
				error: "HotelRunner room mapping changes require the configured super administrator.",
			});
		}
		if (config.projectionEnabled === true) {
			return res.status(409).json({
				error:
					"Pause HotelRunner projection before changing room mappings.",
				code: "hotelrunner_mapping_projection_active",
			});
		}
		const verificationWindow = roomListVerificationWindow(config);
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
		let verifiedMapping = null;
		let activeRoomListSyncGeneration = "";
		if (enabled) {
			const [mappingProof, syncState] = await Promise.all([
				HotelRunnerRoomMapping.findOne({
					_id: mappingId,
					hotelId: hotel._id,
				})
					.select(
						"isMaster variantConflict roomListVerifiedAt roomListSyncGeneration roomListVerificationState"
					)
					.lean(),
				HotelRunnerSyncState.findOne({ hotelId: hotel._id })
					.select("activeRoomListSyncGeneration")
					.lean(),
			]);
			verifiedMapping = mappingProof;
			activeRoomListSyncGeneration = String(
				syncState?.activeRoomListSyncGeneration || ""
			).trim();
			if (!verifiedMapping) {
				return res.status(404).json({ error: "HotelRunner room mapping was not found." });
			}
			if (verifiedMapping.isMaster === true) {
				return res.status(422).json({
					error: "HotelRunner master fallback inventory cannot be mapped to a PMS room category.",
				});
			}
			if (
				!hasCurrentRoomListProof(
					verifiedMapping,
					verificationWindow,
					activeRoomListSyncGeneration
				)
			) {
				return res.status(422).json({
					error: "This inventory code needs a fresh, conflict-free HotelRunner room-list sync verification before it can be mapped.",
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
							variantConflict: { $ne: true },
							roomListVerificationState: "verified",
							roomListSyncGeneration:
								activeRoomListSyncGeneration,
							roomListVerifiedAt: {
								$gte: verificationWindow.earliest,
								$lte: verificationWindow.latest,
							},
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
module.exports.hasCurrentRoomListProof = hasCurrentRoomListProof;
module.exports.parseCallbackEnvelope = parseCallbackEnvelope;
module.exports.roomListVerificationWindow = roomListVerificationWindow;
module.exports.timingSafeTextEqual = timingSafeTextEqual;
