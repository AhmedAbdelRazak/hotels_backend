/** @format */

const Reservations = require("../models/reservations");

const PMS_CONFIRMATION_MIN = 1000000000n;
const PMS_CONFIRMATION_RANGE = 9000000000n;
const DEFAULT_RANDOM_ATTEMPTS = 25;
const DEFAULT_FALLBACK_ATTEMPTS = 25;
const MAX_EXTERNAL_CONFIRMATION_VALUES = 100;
const MAX_EXTERNAL_CONFIRMATION_NESTING = 4;

function normalizeConfirmation(value) {
	if (value === null || value === undefined) return "";
	if (!["string", "number", "bigint"].includes(typeof value)) return "";
	return String(value).replace(/\s+/g, " ").trim().toLowerCase();
}

function flattenConfirmationValues(values, output = [], depth = 0) {
	if (
		output.length >= MAX_EXTERNAL_CONFIRMATION_VALUES ||
		depth > MAX_EXTERNAL_CONFIRMATION_NESTING
	) {
		return output;
	}
	if (Array.isArray(values)) {
		for (const value of values) {
			flattenConfirmationValues(value, output, depth + 1);
			if (output.length >= MAX_EXTERNAL_CONFIRMATION_VALUES) break;
		}
		return output;
	}
	if (values instanceof Set) {
		for (const value of values) {
			flattenConfirmationValues(value, output, depth + 1);
			if (output.length >= MAX_EXTERNAL_CONFIRMATION_VALUES) break;
		}
		return output;
	}
	output.push(values);
	return output;
}

function normalizedExternalConfirmationValues(values = []) {
	const normalized = new Set();
	for (const value of flattenConfirmationValues(values)) {
		const candidate = normalizeConfirmation(value);
		if (!candidate) continue;
		normalized.add(candidate);
		const namespaced = candidate.match(/^[a-z0-9._-]+:(.+)$/i);
		if (namespaced?.[1]) normalized.add(namespaced[1]);
	}
	return normalized;
}

function pmsConfirmationError(code, message) {
	const error = new Error(message);
	error.code = code;
	return error;
}

function assertPmsConfirmationDistinctFromExternal(
	pmsConfirmationNumber,
	externalConfirmationValues = []
) {
	const candidate = normalizeConfirmation(pmsConfirmationNumber);
	if (
		candidate &&
		normalizedExternalConfirmationValues(externalConfirmationValues).has(candidate)
	) {
		throw pmsConfirmationError(
			"pms_confirmation_matches_external_ota",
			"The generated PMS confirmation number matches an external OTA identifier."
		);
	}
	return pmsConfirmationNumber;
}

const RESERVATION_EXTERNAL_CONFIRMATION_PATHS = Object.freeze([
	"reservation_id",
	"reservationId",
	"hr_number",
	"hrNumber",
	"confirmation_number2",
	"confirmationNumber2",
	"otaIdentityKey",
	"ota_identity_key",
	"otaCrossTransportIdentityKey",
	"ota_cross_transport_identity_key",
	"customer_details.reservation_id",
	"customer_details.reservationId",
	"customer_details.hr_number",
	"customer_details.hrNumber",
	"customer_details.confirmation_number2",
	"customer_details.confirmationNumber2",
	"customer_details.otaIdentityKey",
	"customer_details.otaCrossTransportIdentityKey",
	"customerDetails.reservation_id",
	"customerDetails.reservationId",
	"customerDetails.hr_number",
	"customerDetails.hrNumber",
	"customerDetails.confirmation_number2",
	"customerDetails.confirmationNumber2",
	"customerDetails.otaIdentityKey",
	"customerDetails.otaCrossTransportIdentityKey",
	"otaPlatformReview.confirmationNumber",
	"otaPlatformReview.confirmation_number",
	"supplierData.suppliedBookingNo",
	"supplierData.supplierBookingNo",
	"supplierData.supplierBookingNumber",
	"supplierData.confirmationNumber",
	"supplierData.otaConfirmationNumber",
	"supplierData.platformConfirmationNumber",
	"supplierData.otaIdentityKey",
	"supplierData.otaCrossTransportIdentityKey",
	"supplierData.otaNormalizedSnapshot.confirmationNumber",
	"supplierData.otaNormalizedSnapshot.reservationId",
	"supplierData.hotelRunner.reservationId",
	"supplierData.hotelRunner.reservation_id",
	"supplierData.hotelRunner.hrNumber",
	"supplierData.hotelRunner.hr_number",
	"supplierData.hotelRunner.providerNumber",
	"supplierData.hotelRunner.hrNumberAliases",
	"supplierData.hotelRunner.providerNumberAliases",
	"supplierData.hotelRunner.confirmationNumber",
	"supplierData.hotelRunner.platformConfirmationNumber",
]);

function valueAtPath(value, path) {
	let cursor = value;
	for (const part of String(path).split(".")) {
		if (!cursor || typeof cursor !== "object") return undefined;
		cursor = cursor[part];
	}
	return cursor;
}

function reservationExternalConfirmationValues(reservation = {}) {
	return RESERVATION_EXTERNAL_CONFIRMATION_PATHS.map((path) =>
		valueAtPath(reservation, path)
	);
}

function plainObject(value) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	if (typeof value.toObject === "function") {
		return value.toObject({ depopulate: true });
	}
	return value;
}

function identityCandidateFromUpdate(existingReservation = {}, update = {}) {
	const existing = plainObject(existingReservation);
	const supplierData = plainObject(existing.supplierData);
	const candidate = {
		...existing,
		customer_details: { ...plainObject(existing.customer_details) },
		otaPlatformReview: { ...plainObject(existing.otaPlatformReview) },
		supplierData: {
			...supplierData,
			otaNormalizedSnapshot: {
				...plainObject(supplierData.otaNormalizedSnapshot),
			},
			hotelRunner: { ...plainObject(supplierData.hotelRunner) },
		},
	};

	for (const [path, value] of Object.entries(update || {})) {
		if (!path.includes(".")) {
			candidate[path] = value;
			continue;
		}
		const parts = path.split(".");
		let cursor = candidate;
		for (let index = 0; index < parts.length - 1; index += 1) {
			const part = parts[index];
			cursor[part] = { ...plainObject(cursor[part]) };
			cursor = cursor[part];
		}
		cursor[parts[parts.length - 1]] = value;
	}
	return candidate;
}

function reservationExternalIdentityFingerprint(reservation = {}) {
	return JSON.stringify(
		Array.from(
			normalizedExternalConfirmationValues(
				reservationExternalConfirmationValues(reservation)
			)
		).sort()
	);
}

function assertReservationPmsConfirmationUpdateSafe(
	existingReservation = {},
	update = {}
) {
	const existing = plainObject(existingReservation);
	const candidate = identityCandidateFromUpdate(existing, update);
	const existingCanonical = normalizeConfirmation(existing.confirmation_number);
	const candidateCanonical = normalizeConfirmation(candidate.confirmation_number);
	if (existingCanonical && candidateCanonical !== existingCanonical) {
		throw pmsConfirmationError(
			"pms_confirmation_canonical_changed",
			"The canonical PMS confirmation number cannot be changed by an OTA identity update."
		);
	}

	for (const [field, value] of [
		["pms_number", candidate.pms_number],
		[
			"supplierData.pmsConfirmationNumber",
			candidate.supplierData?.pmsConfirmationNumber,
		],
	]) {
		const mirror = normalizeConfirmation(value);
		if (mirror && mirror !== candidateCanonical) {
			throw pmsConfirmationError(
				"pms_confirmation_mirror_mismatch",
				`The ${field} PMS confirmation mirror does not match confirmation_number.`
			);
		}
	}

	const existingExternal = normalizedExternalConfirmationValues(
		reservationExternalConfirmationValues(existing)
	);
	const candidateExternal = normalizedExternalConfirmationValues(
		reservationExternalConfirmationValues(candidate)
	);
	const existingHasCollision =
		Boolean(existingCanonical) && existingExternal.has(existingCanonical);
	const candidateHasCollision =
		Boolean(candidateCanonical) && candidateExternal.has(candidateCanonical);

	if (existingHasCollision) {
		if (
			reservationExternalIdentityFingerprint(existing) !==
				reservationExternalIdentityFingerprint(candidate)
		) {
			throw pmsConfirmationError(
				"legacy_pms_ota_identity_locked",
				"A grandfathered PMS/OTA identity collision cannot be changed through automation."
			);
		}
		return candidate;
	}

	if (candidateHasCollision) {
		throw pmsConfirmationError(
			"pms_confirmation_matches_external_ota",
			"The PMS confirmation number matches an external OTA identifier."
		);
	}
	return candidate;
}

function assertReservationPmsConfirmationDistinct(reservation = {}) {
	const canonical = normalizeConfirmation(reservation.confirmation_number);
	for (const [field, value] of [
		["pms_number", reservation.pms_number],
		[
			"supplierData.pmsConfirmationNumber",
			reservation.supplierData?.pmsConfirmationNumber,
		],
	]) {
		const mirror = normalizeConfirmation(value);
		if (mirror && mirror !== canonical) {
			throw pmsConfirmationError(
				"pms_confirmation_mirror_mismatch",
				`The ${field} PMS confirmation mirror does not match confirmation_number.`
			);
		}
	}
	return assertPmsConfirmationDistinctFromExternal(
		reservation.confirmation_number,
		reservationExternalConfirmationValues(reservation)
	);
}

function randomPmsConfirmationNumber() {
	return Math.floor(
		Number(PMS_CONFIRMATION_MIN) +
			Math.random() * Number(PMS_CONFIRMATION_RANGE)
	).toString();
}

function deterministicFallbackConfirmationNumber(seed, offset = 0) {
	const normalizedSeed = BigInt(seed);
	return (
		PMS_CONFIRMATION_MIN +
		((normalizedSeed + BigInt(offset)) % PMS_CONFIRMATION_RANGE)
	).toString();
}

async function candidateIsAvailable(candidate, reserved, ReservationModel) {
	if (reserved.has(normalizeConfirmation(candidate))) return false;
	const exists = await ReservationModel.exists({ confirmation_number: candidate });
	return !exists;
}

async function generateUniquePmsConfirmationNumber(
	maxAttempts = DEFAULT_RANDOM_ATTEMPTS,
	externalConfirmationValues = [],
	options = {}
) {
	const ReservationModel = options.ReservationModel || Reservations;
	const randomAttempts = Math.max(0, Math.floor(Number(maxAttempts) || 0));
	const fallbackAttempts = Math.max(
		1,
		Math.floor(Number(options.fallbackAttempts) || DEFAULT_FALLBACK_ATTEMPTS)
	);
	const reserved = normalizedExternalConfirmationValues(
		externalConfirmationValues
	);

	for (let attempt = 0; attempt < randomAttempts; attempt += 1) {
		const candidate = randomPmsConfirmationNumber();
		// eslint-disable-next-line no-await-in-loop
		if (await candidateIsAvailable(candidate, reserved, ReservationModel)) {
			return assertPmsConfirmationDistinctFromExternal(
				candidate,
				externalConfirmationValues
			);
		}
	}

	const fallbackSeed = BigInt(Date.now());
	for (let offset = 0; offset < fallbackAttempts; offset += 1) {
		const fallback = deterministicFallbackConfirmationNumber(
			fallbackSeed,
			offset
		);
		// eslint-disable-next-line no-await-in-loop
		if (await candidateIsAvailable(fallback, reserved, ReservationModel)) {
			return assertPmsConfirmationDistinctFromExternal(
				fallback,
				externalConfirmationValues
			);
		}
	}

	throw pmsConfirmationError(
		"pms_confirmation_generation_exhausted",
		"Could not generate a unique PMS confirmation number distinct from external identifiers."
	);
}

module.exports = {
	DEFAULT_FALLBACK_ATTEMPTS,
	DEFAULT_RANDOM_ATTEMPTS,
	MAX_EXTERNAL_CONFIRMATION_NESTING,
	MAX_EXTERNAL_CONFIRMATION_VALUES,
	RESERVATION_EXTERNAL_CONFIRMATION_PATHS,
	assertPmsConfirmationDistinctFromExternal,
	assertReservationPmsConfirmationDistinct,
	assertReservationPmsConfirmationUpdateSafe,
	deterministicFallbackConfirmationNumber,
	generateUniquePmsConfirmationNumber,
	normalizeConfirmation,
	normalizedExternalConfirmationValues,
	randomPmsConfirmationNumber,
	reservationExternalConfirmationValues,
	reservationExternalIdentityFingerprint,
};
