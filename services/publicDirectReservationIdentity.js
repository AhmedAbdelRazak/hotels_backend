/** @format */

"use strict";

const CANONICAL_CONFIRMATION_MODES = Object.freeze({
	ALLOW: "allow",
	REJECT: "reject",
	STRIP: "strip",
});

// Public/direct reservation routes must never manufacture an OTA reservation.
// These are exact normalized labels, deliberately not substring/regex matches.
const EXACT_OTA_SOURCE_LABELS = Object.freeze([
	"ota",
	"agoda",
	"agoda.com",
	"agoda com",
	"agodacom",
	"booking",
	"booking.com",
	"booking com",
	"bookingcom",
	"expedia",
	"expedia.com",
	"expedia com",
	"expediacom",
	"airbnb",
	"trip",
	"trip.com",
	"trip com",
	"tripcom",
	"trip.com v2",
	"trip com v2",
	"tripcomv2",
	"ctrip",
	"hotel",
	"hotels",
	"hotel.com",
	"hotel com",
	"hotelcom",
	"hotels.com",
	"hotels com",
	"hotelscom",
	"trivago",
	"hotelrunner",
	"hotel runner",
]);
const EXACT_OTA_SOURCE_LABEL_SET = new Set(EXACT_OTA_SOURCE_LABELS);

const ROOT_IDENTITY_PATHS = Object.freeze([
	"confirmation_number",
	"confirmationNumber",
	"confirmation_number2",
	"confirmationNumber2",
	"reservation_id",
	"reservationId",
	"hr_number",
	"hrNumber",
	"pms_number",
	"pmsNumber",
	"pmsConfirmationNumber",
	"supplierBookingNo",
	"supplierBookingNumber",
	"suppliedBookingNo",
	"otaConfirmationNumber",
	"platformConfirmationNumber",
	"otaIdentityKey",
	"ota_identity_key",
	"otaCrossTransportIdentityKey",
	"ota_cross_transport_identity_key",
	"otaProvider",
	"provider",
	"supplierName",
	"otaInboundEmailId",
	"otaAutomationPipeline",
	"otaCreatedFromEmail",
	"otaCreatedFromSync",
]);

const CUSTOMER_IDENTITY_FIELDS = Object.freeze([
	"confirmation_number",
	"confirmationNumber",
	"confirmation_number2",
	"confirmationNumber2",
	"reservation_id",
	"reservationId",
	"hr_number",
	"hrNumber",
	"pms_number",
	"pmsNumber",
	"pmsConfirmationNumber",
	"supplierBookingNo",
	"supplierBookingNumber",
	"suppliedBookingNo",
	"otaConfirmationNumber",
	"platformConfirmationNumber",
	"otaIdentityKey",
	"ota_identity_key",
	"otaCrossTransportIdentityKey",
	"ota_cross_transport_identity_key",
	"otaProvider",
	"provider",
	"supplierName",
	"otaInboundEmailId",
	"otaAutomationPipeline",
	"otaCreatedFromEmail",
	"otaCreatedFromSync",
	"supplierData",
	"supplier_data",
	"otaPlatformReview",
	"ota_platform_review",
	"hotelRunner",
	"hotelrunner",
	"otaNormalizedSnapshot",
	"ota_normalized_snapshot",
]);

const CONTAINER_IDENTITY_PATHS = Object.freeze([
	"supplierData",
	"supplier_data",
	"otaPlatformReview",
	"ota_platform_review",
	"hotelRunner",
	"hotelrunner",
	"otaNormalizedSnapshot",
	"ota_normalized_snapshot",
]);

const normalizeExactLabel = (value) =>
	String(value ?? "")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();

const hasOwn = (value, key) =>
	Boolean(value) && Object.prototype.hasOwnProperty.call(value, key);

const valueAtPath = (value, path) => {
	let cursor = value;
	for (const segment of String(path).split(".")) {
		if (!cursor || typeof cursor !== "object" || !hasOwn(cursor, segment)) {
			return undefined;
		}
		cursor = cursor[segment];
	}
	return cursor;
};

const meaningfulIdentityValue = (value, depth = 0) => {
	if (value === null || value === undefined) return false;
	if (depth > 5) return true;
	if (Array.isArray(value)) {
		return value.some((entry) => meaningfulIdentityValue(entry, depth + 1));
	}
	if (typeof value === "object") {
		return Object.values(value).some((entry) =>
			meaningfulIdentityValue(entry, depth + 1)
		);
	}
	if (typeof value === "string") return Boolean(value.trim());
	return true;
};

const publicDirectIdentityError = (code, message, fields = []) => {
	const error = new Error(message);
	error.code = code;
	error.statusCode = 400;
	error.fields = fields;
	return error;
};

const exactOtaSourceOccurrences = (payload = {}) => {
	const sourcePaths = [
		"booking_source",
		"bookingSource",
		"customerDetails.booking_source",
		"customerDetails.bookingSource",
		"customer_details.booking_source",
		"customer_details.bookingSource",
	];
	return sourcePaths.filter((path) =>
		EXACT_OTA_SOURCE_LABEL_SET.has(
			normalizeExactLabel(valueAtPath(payload, path))
		)
	);
};

const forbiddenIdentityOccurrences = (
	payload = {},
	canonicalConfirmation = CANONICAL_CONFIRMATION_MODES.REJECT
) => {
	const paths = [
		...ROOT_IDENTITY_PATHS.filter(
			(path) =>
				canonicalConfirmation === CANONICAL_CONFIRMATION_MODES.REJECT ||
				!["confirmation_number", "confirmationNumber"].includes(path)
		),
		...CUSTOMER_IDENTITY_FIELDS.flatMap((field) => [
			`customerDetails.${field}`,
			`customer_details.${field}`,
		]),
		...CONTAINER_IDENTITY_PATHS,
	];
	return paths.filter((path) => meaningfulIdentityValue(valueAtPath(payload, path)));
};

/**
 * Validate a payload entering a public/direct booking flow.
 *
 * `strip` is reserved for the PayPal completion request, whose UI legitimately
 * echoes the confirmation allocated by the pending shell. The echoed value is
 * discarded; the server-side pending document remains authoritative.
 * `allow` is reserved for a server-signed JWT or a server-built persistence
 * document that already owns its canonical confirmation.
 */
function preparePublicDirectReservationPayload(
	payload = {},
	{ canonicalConfirmation = CANONICAL_CONFIRMATION_MODES.REJECT } = {}
) {
	if (!Object.values(CANONICAL_CONFIRMATION_MODES).includes(canonicalConfirmation)) {
		throw new TypeError("Unsupported public direct canonical confirmation mode.");
	}
	const candidate =
		payload && typeof payload === "object" && !Array.isArray(payload)
			? payload
			: {};
	const otaSources = exactOtaSourceOccurrences(candidate);
	if (otaSources.length) {
		throw publicDirectIdentityError(
			"public_direct_ota_source_forbidden",
			"Public direct reservations cannot use an OTA booking source.",
			otaSources
		);
	}
	const identityFields = forbiddenIdentityOccurrences(
		candidate,
		canonicalConfirmation
	);
	if (identityFields.length) {
		throw publicDirectIdentityError(
			"public_direct_identity_forbidden",
			"OTA and PMS identity aliases are server-owned on public direct reservations.",
			identityFields
		);
	}
	if (canonicalConfirmation !== CANONICAL_CONFIRMATION_MODES.STRIP) {
		return candidate;
	}
	const sanitized = { ...candidate };
	delete sanitized.confirmation_number;
	delete sanitized.confirmationNumber;
	return sanitized;
}

const isPublicDirectReservationIdentityError = (error) =>
	Boolean(
		error &&
			["public_direct_ota_source_forbidden", "public_direct_identity_forbidden"].includes(
				error.code
			)
	);

module.exports = {
	CANONICAL_CONFIRMATION_MODES,
	EXACT_OTA_SOURCE_LABELS,
	exactOtaSourceOccurrences,
	forbiddenIdentityOccurrences,
	isPublicDirectReservationIdentityError,
	meaningfulIdentityValue,
	normalizeExactLabel,
	preparePublicDirectReservationPayload,
};
