/** @format */

const {
	getHotelRunnerConfig,
	parseSupportedHotelIds,
} = require("./hotelrunnerConfig");

const normalizeHotelId = (value) =>
	String(value?._id || value || "")
		.trim()
		.toLowerCase();

function hotelRunnerManagedHotelIds(env = process.env) {
	return new Set(
		parseSupportedHotelIds(env.HOTELRUNNER_SUPPORTED_HOTELIDS)
			.map(normalizeHotelId)
			.filter(Boolean)
	);
}

function hotelRunnerOtaEmailBoundaryEnabled(env = process.env) {
	// The same fail-closed projection switch makes authority change atomically:
	// room discovery/bootstrap can run while email ingestion remains unchanged,
	// then one activation turns on both local projection and email suppression.
	// Suppression also requires a runnable one-property credential binding. A
	// malformed or future multi-property configuration must never create a gap
	// where email is disabled but no HotelRunner worker can own the reservation.
	const config = getHotelRunnerConfig(env);
	return config.configured && config.projectionEnabled;
}

function isHotelRunnerManagedHotelId(hotelId, env = process.env) {
	const normalized = normalizeHotelId(hotelId);
	return Boolean(
		normalized &&
		hotelRunnerOtaEmailBoundaryEnabled(env) &&
		hotelRunnerManagedHotelIds(env).has(normalized)
	);
}

function hotelRunnerManagedEmailSkipResult({
	hotelId,
	reservation = null,
	warnings = [],
	errors = [],
	matchedReservationBy = [],
} = {}) {
	return {
		status: "ignored",
		actionTaken: "skipped",
		skipReason: "hotelrunner_managed_hotel_ota_email_disabled",
		automationComment:
			"This hotel is managed by the direct HotelRunner integration. The OTA email remains archived for audit only and cannot create or change a PMS reservation.",
		warnings: [...warnings],
		errors: [...errors],
		reservationId: reservation?._id || null,
		hotelId: reservation?.hotelId || hotelId || null,
		pmsConfirmationNumber: reservation?.confirmation_number || "",
		matchedReservationBy: [...matchedReservationBy],
	};
}

module.exports = {
	hotelRunnerManagedEmailSkipResult,
	hotelRunnerManagedHotelIds,
	hotelRunnerOtaEmailBoundaryEnabled,
	isHotelRunnerManagedHotelId,
	normalizeHotelId,
};
