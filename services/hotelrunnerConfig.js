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

function getHotelRunnerConfig(env = process.env) {
	const token = clean(env.HOTELRUNNER_API_TOKEN);
	const hrId = clean(env.HOTELRUNNER_API_HR_ID);
	const supportedHotelIds = parseSupportedHotelIds(
		env.HOTELRUNNER_SUPPORTED_HOTELIDS
	);
	const errors = [];
	if (!token) errors.push("HOTELRUNNER_API_TOKEN is not configured.");
	if (!hrId) errors.push("HOTELRUNNER_API_HR_ID is not configured.");
	if (supportedHotelIds.length !== 1) {
		errors.push(
			"Exactly one HOTELRUNNER_SUPPORTED_HOTELIDS value is required for this property credential."
		);
	}
	if (
		supportedHotelIds.length === 1 &&
		!mongoose.Types.ObjectId.isValid(supportedHotelIds[0])
	) {
		errors.push("The configured HotelRunner PMS hotel identifier is invalid.");
	}

	return {
		configured: errors.length === 0,
		errors,
		token,
		hrId,
		hrIdFingerprint: hrId ? fingerprint(hrId) : "",
		credentialFingerprint:
			hrId && token ? fingerprint(`${hrId}\u0000${token}`) : "",
		hotelId: supportedHotelIds.length === 1 ? supportedHotelIds[0] : "",
		apiBaseUrl: clean(env.HOTELRUNNER_API_BASE_URL) || API_BASE_URL,
		pullEnabled: parseBoolean(env.HOTELRUNNER_PULL_ENABLED, true),
		// Projection is a separate activation gate. A new property can safely
		// discover rooms and archive deliveries before any existing PMS reservation
		// is created, updated, or cancelled.
		projectionEnabled: parseBoolean(
			env.HOTELRUNNER_PROJECTION_ENABLED,
			false
		),
		// Delivery confirmation is intentionally disabled. HotelRunner pull
		// acknowledgements are only safe after the local projection succeeds and
		// the real PMS number is known; the reconciliation pull does not need them.
		confirmPulledDeliveryEnabled: false,
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
	parseSupportedHotelIds,
};
