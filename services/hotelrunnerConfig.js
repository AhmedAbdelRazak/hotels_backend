/** @format */

const crypto = require("crypto");
const mongoose = require("mongoose");

const API_BASE_URL = "https://app.hotelrunner.com/api/v2/apps";

const clean = (value = "") => String(value == null ? "" : value).trim();

const parseBoolean = (value, fallback = false) => {
	const text = clean(value).toLowerCase();
	if (!text) return fallback;
	if (["1", "true", "yes", "on"].includes(text)) return true;
	if (["0", "false", "no", "off"].includes(text)) return false;
	return fallback;
};

const parseBooleanSetting = (env, key, fallback, errors) => {
	if (!Object.prototype.hasOwnProperty.call(env, key)) return fallback;
	const text = clean(env[key]).toLowerCase();
	if (["1", "true", "yes", "on"].includes(text)) return true;
	if (["0", "false", "no", "off"].includes(text)) return false;
	errors.push(
		`${key} must be an explicit boolean (true/false, yes/no, on/off, or 1/0).`
	);
	return false;
};

const boundedInteger = (value, fallback, min, max) => {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(max, Math.max(min, parsed));
};

const fingerprint = (value = "") =>
	crypto.createHash("sha256").update(clean(value), "utf8").digest("hex");

const parseSupportedHotelIds = (value = "") =>
	Array.from(
		new Set(
			clean(value)
				.split(",")
				.map((entry) => entry.trim())
				.filter(Boolean)
		)
	);

const parseIsoTimestamp = (value = "") => {
	const text = clean(value);
	const match = text.match(
		/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|([+-])(\d{2}):(\d{2}))$/
	);
	if (!match) return null;
	const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = [
		match[1],
		match[2],
		match[3],
		match[4],
		match[5],
		match[6],
		match[8],
		match[9],
	].map(Number);
	if (
		year < 1 ||
		month < 1 ||
		month > 12 ||
		day < 1 ||
		day > new Date(Date.UTC(year, month, 0)).getUTCDate() ||
		hour > 23 ||
		minute > 59 ||
		second > 59 ||
		(match[7] && (offsetHour > 23 || offsetMinute > 59))
	) {
		return null;
	}
	const parsed = new Date(text);
	return Number.isFinite(parsed.getTime()) ? parsed : null;
};

function getHotelRunnerConfig(env = process.env) {
	const token = clean(env.HOTELRUNNER_API_TOKEN);
	const hrId = clean(env.HOTELRUNNER_API_HR_ID);
	const supportedHotelIds = parseSupportedHotelIds(
		env.HOTELRUNNER_SUPPORTED_HOTELIDS
	);
	const callbackErrors = [];
	if (!token) callbackErrors.push("HOTELRUNNER_API_TOKEN is not configured.");
	if (!hrId) callbackErrors.push("HOTELRUNNER_API_HR_ID is not configured.");
	if (supportedHotelIds.length !== 1) {
		callbackErrors.push(
			"Exactly one HOTELRUNNER_SUPPORTED_HOTELIDS value is required for this property credential."
		);
	}
	if (
		supportedHotelIds.length === 1 &&
		!mongoose.Types.ObjectId.isValid(supportedHotelIds[0])
	) {
		callbackErrors.push("The configured HotelRunner PMS hotel identifier is invalid.");
	}
	const errors = [...callbackErrors];
	const pullEnabled = parseBooleanSetting(
		env,
		"HOTELRUNNER_PULL_ENABLED",
		false,
		errors
	);
	const roomListSyncEnabled = parseBooleanSetting(
		env,
		"HOTELRUNNER_ROOM_LIST_SYNC_ENABLED",
		false,
		errors
	);
	const projectionEnabled = parseBooleanSetting(
		env,
		"HOTELRUNNER_PROJECTION_ENABLED",
		false,
		errors
	);
	const confirmDeliveryEnabled = parseBooleanSetting(
		env,
		"HOTELRUNNER_CONFIRM_DELIVERY_ENABLED",
		false,
		errors
	);
	const requireOtaReview = parseBooleanSetting(
		env,
		"HOTELRUNNER_REQUIRE_OTA_REVIEW",
		false,
		errors
	);
	const projectionNotBefore = parseIsoTimestamp(
		env.HOTELRUNNER_PROJECTION_NOT_BEFORE
	);
	if (projectionEnabled && !projectionNotBefore) {
		errors.push(
			"HOTELRUNNER_PROJECTION_NOT_BEFORE must be a timezone-qualified ISO timestamp when HotelRunner projection is enabled."
		);
	}
	if (projectionEnabled && pullEnabled) {
		errors.push(
			"HOTELRUNNER_PULL_ENABLED and HOTELRUNNER_PROJECTION_ENABLED cannot both be true during the push-only activation phase."
		);
	}

	return {
		// Callback availability depends only on the credential/property boundary.
		// Worker-only safety errors must stop the worker without making HotelRunner
		// retry a callback that this process can still authenticate and archive.
		callbackConfigured: callbackErrors.length === 0,
		configured: errors.length === 0,
		errors,
		token,
		hrId,
		hrIdFingerprint: hrId ? fingerprint(hrId) : "",
		credentialFingerprint:
			hrId && token ? fingerprint(`${hrId}\u0000${token}`) : "",
		hotelId: supportedHotelIds.length === 1 ? supportedHotelIds[0] : "",
		apiBaseUrl: clean(env.HOTELRUNNER_API_BASE_URL) || API_BASE_URL,
		// Historical reconciliation is opt-in. The explicit room-list command can
		// still discover mappings while this background reservation pull is off.
		pullEnabled,
		roomListSyncEnabled,
		// Projection is a separate activation gate. A new property can safely
		// discover rooms and archive deliveries before any existing PMS reservation
		// is created, updated, or cancelled.
		projectionEnabled,
		projectionNotBefore,
		projectionNotBeforeIso: projectionNotBefore
			? projectionNotBefore.toISOString()
			: "",
		// Keep the existing property name for status/API compatibility. The client
		// enforces this gate again at the actual PUT boundary.
		confirmDeliveryEnabled,
		confirmPulledDeliveryEnabled: confirmDeliveryEnabled,
		// Keep the canonical PMS lifecycle unchanged. This only selects whether
		// a new confirmed HotelRunner reservation enters the existing OTA review
		// workflow before it is released to the hotel.
		requireOtaReview,
		pullIntervalMinutes: boundedInteger(
			env.HOTELRUNNER_PULL_INTERVAL_MINUTES,
			30,
			15,
			360
		),
		roomListIntervalHours: boundedInteger(
			env.HOTELRUNNER_ROOM_LIST_INTERVAL_HOURS,
			24,
			6,
			168
		),
		requestTimeoutMs: boundedInteger(
			env.HOTELRUNNER_REQUEST_TIMEOUT_MS,
			12_000,
			3_000,
			30_000
		),
		callbackBodyLimitBytes: boundedInteger(
			env.HOTELRUNNER_CALLBACK_BODY_LIMIT_BYTES,
			1024 * 1024,
			64 * 1024,
			2 * 1024 * 1024
		),
		callbackMaxReservations: boundedInteger(
			env.HOTELRUNNER_CALLBACK_MAX_RESERVATIONS,
			100,
			1,
			250
		),
		// Authenticated direct-OTA reservation emails for this property are
		// archived first and held behind HotelRunner's callback/API path. These
		// values are deliberately bounded so a malformed environment value cannot
		// remove the grace period or create an effectively permanent lease/proof.
		otaEmailFallbackGraceMs: boundedInteger(
			env.HOTELRUNNER_OTA_EMAIL_FALLBACK_GRACE_MS,
			180_000,
			30_000,
			900_000
		),
		otaEmailFallbackLeaseMs: boundedInteger(
			env.HOTELRUNNER_OTA_EMAIL_FALLBACK_LEASE_MS,
			300_000,
			30_000,
			900_000
		),
		otaEmailFallbackProofTtlMs: boundedInteger(
			env.HOTELRUNNER_OTA_EMAIL_FALLBACK_PROOF_TTL_MS,
			120_000,
			30_000,
			600_000
		),
		otaEmailFallbackMaxAttempts: boundedInteger(
			env.HOTELRUNNER_OTA_EMAIL_FALLBACK_MAX_ATTEMPTS,
			12,
			3,
			30
		),
		quota: {
			propertyDaily: boundedInteger(
				env.HOTELRUNNER_PROPERTY_DAILY_BUDGET,
				225,
				1,
				240
			),
			propertyMinute: boundedInteger(
				env.HOTELRUNNER_PROPERTY_MINUTE_BUDGET,
				4,
				1,
				5
			),
			applicationMinute: boundedInteger(
				env.HOTELRUNNER_APPLICATION_MINUTE_BUDGET,
				60,
				1,
				75
			),
		},
	};
}

module.exports = {
	API_BASE_URL,
	boundedInteger,
	fingerprint,
	getHotelRunnerConfig,
	parseBoolean,
	parseBooleanSetting,
	parseIsoTimestamp,
	parseSupportedHotelIds,
};
