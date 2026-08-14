/** @format */

"use strict";

const hasOwn = (value, key) =>
	Boolean(value) && Object.prototype.hasOwnProperty.call(value, key);

const asPlainObject = (value) => {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	if (typeof value.toObject === "function") {
		return value.toObject({ depopulate: true });
	}
	return value;
};

const identityText = (value) =>
	String(value ?? "")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();

const comparableIdentityValue = (value) => {
	if (typeof value === "boolean") return value ? "boolean:true" : "boolean:false";
	if (Array.isArray(value)) {
		return `array:${[
			...new Set(value.flat(Infinity).map(identityText).filter(Boolean)),
		]
			.sort()
			.join("\u0000")}`;
	}
	return identityText(value);
};

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

const firstValueAtPaths = (value, paths = []) => {
	for (const path of paths) {
		const candidate = valueAtPath(value, path);
		if (candidate !== undefined) return candidate;
	}
	return undefined;
};

const ROOT_PATH_SPECS = [
	["reservation_id", ["reservation_id"]],
	["reservationId", ["reservationId", "reservation_id"]],
	["hr_number", ["hr_number"]],
	["hrNumber", ["hrNumber", "hr_number"]],
	["confirmation_number", ["confirmation_number"]],
	["confirmationNumber", ["confirmationNumber", "confirmation_number"]],
	["confirmation_number2", ["confirmation_number2", "customer_details.confirmation_number2"]],
	["confirmationNumber2", ["confirmationNumber2", "customer_details.confirmationNumber2", "customer_details.confirmation_number2"]],
	["pms_number", ["pms_number"]],
	["pmsNumber", ["pmsNumber", "pms_number"]],
	["otaIdentityKey", ["otaIdentityKey"]],
	["ota_identity_key", ["ota_identity_key", "otaIdentityKey"]],
	["otaCrossTransportIdentityKey", ["otaCrossTransportIdentityKey"]],
	["ota_cross_transport_identity_key", ["ota_cross_transport_identity_key", "otaCrossTransportIdentityKey"]],
	["booking_source", ["booking_source"]],
	["bookingSource", ["bookingSource", "booking_source"]],
];

const CUSTOMER_FIELDS = [
	["reservation_id", ["customer_details.reservation_id", "reservation_id"]],
	["reservationId", ["customer_details.reservationId", "customer_details.reservation_id", "reservation_id"]],
	["hr_number", ["customer_details.hr_number", "hr_number"]],
	["hrNumber", ["customer_details.hrNumber", "customer_details.hr_number", "hr_number"]],
	["confirmation_number", ["customer_details.confirmation_number", "confirmation_number"]],
	["confirmationNumber", ["customer_details.confirmationNumber", "customer_details.confirmation_number", "confirmation_number"]],
	["confirmation_number2", ["customer_details.confirmation_number2"]],
	["confirmationNumber2", ["customer_details.confirmationNumber2", "customer_details.confirmation_number2"]],
	["pms_number", ["customer_details.pms_number", "pms_number"]],
	["pmsNumber", ["customer_details.pmsNumber", "customer_details.pms_number", "pms_number"]],
	["otaIdentityKey", ["customer_details.otaIdentityKey", "otaIdentityKey"]],
	["otaCrossTransportIdentityKey", ["customer_details.otaCrossTransportIdentityKey", "otaCrossTransportIdentityKey"]],
	["booking_source", ["customer_details.booking_source", "booking_source"]],
	["bookingSource", ["customer_details.bookingSource", "customer_details.booking_source", "booking_source"]],
	["otaProvider", ["customer_details.otaProvider"]],
	["provider", ["customer_details.provider"]],
];

const SUPPLIER_FIELDS = [
	["supplierName", ["supplierData.supplierName"]],
	["suppliedBookingNo", ["supplierData.suppliedBookingNo"]],
	["supplierBookingNo", ["supplierData.supplierBookingNo", "supplierData.suppliedBookingNo"]],
	["supplierBookingNumber", ["supplierData.supplierBookingNumber", "supplierData.suppliedBookingNo"]],
	["confirmationNumber", ["supplierData.confirmationNumber"]],
	["otaConfirmationNumber", ["supplierData.otaConfirmationNumber"]],
	["platformConfirmationNumber", ["supplierData.platformConfirmationNumber"]],
	["pmsConfirmationNumber", ["supplierData.pmsConfirmationNumber", "confirmation_number"]],
	["otaProvider", ["supplierData.otaProvider"]],
	["provider", ["supplierData.provider", "supplierData.otaProvider"]],
	["otaIdentityKey", ["supplierData.otaIdentityKey", "otaIdentityKey"]],
	["otaCrossTransportIdentityKey", ["supplierData.otaCrossTransportIdentityKey", "otaCrossTransportIdentityKey"]],
	["otaInboundEmailId", ["supplierData.otaInboundEmailId"]],
	["otaAutomationPipeline", ["supplierData.otaAutomationPipeline"]],
	["otaCreatedFromEmail", ["supplierData.otaCreatedFromEmail"]],
	["otaCreatedFromSync", ["supplierData.otaCreatedFromSync"]],
];

const REVIEW_FIELDS = [
	["provider", ["otaPlatformReview.provider"]],
	["providerLabel", ["otaPlatformReview.providerLabel"]],
	["confirmationNumber", ["otaPlatformReview.confirmationNumber"]],
	["confirmation_number", ["otaPlatformReview.confirmation_number", "otaPlatformReview.confirmationNumber"]],
	["inboundEmailId", ["otaPlatformReview.inboundEmailId"]],
	["source", ["otaPlatformReview.source"]],
];

const HOTELRUNNER_FIELDS = [
	["reservationId", ["supplierData.hotelRunner.reservationId", "reservation_id"]],
	["reservation_id", ["supplierData.hotelRunner.reservation_id", "supplierData.hotelRunner.reservationId", "reservation_id"]],
	["hrNumber", ["supplierData.hotelRunner.hrNumber", "hr_number"]],
	["hr_number", ["supplierData.hotelRunner.hr_number", "supplierData.hotelRunner.hrNumber", "hr_number"]],
	["providerNumber", ["supplierData.hotelRunner.providerNumber"]],
	["hrNumberAliases", ["supplierData.hotelRunner.hrNumberAliases"]],
	["providerNumberAliases", ["supplierData.hotelRunner.providerNumberAliases"]],
	["confirmationNumber", ["supplierData.hotelRunner.confirmationNumber"]],
	["platformConfirmationNumber", ["supplierData.hotelRunner.platformConfirmationNumber"]],
	["provider", ["supplierData.hotelRunner.provider", "supplierData.otaProvider"]],
	["channel", ["supplierData.hotelRunner.channel"]],
	["channelCode", ["supplierData.hotelRunner.channelCode"]],
	["transport", ["supplierData.hotelRunner.transport"]],
];

const NORMALIZED_SNAPSHOT_FIELDS = [
	["provider", ["supplierData.otaNormalizedSnapshot.provider", "supplierData.otaProvider"]],
	["confirmationNumber", ["supplierData.otaNormalizedSnapshot.confirmationNumber"]],
	["reservationId", ["supplierData.otaNormalizedSnapshot.reservationId"]],
];

const pathSpecs = [
	...ROOT_PATH_SPECS.map(([path, existingPaths]) => ({ path, existingPaths })),
	...CUSTOMER_FIELDS.flatMap(([field, existingPaths]) =>
		["customer_details", "customerDetails"].map((container) => ({
			path: `${container}.${field}`,
			existingPaths,
		}))
	),
	...SUPPLIER_FIELDS.map(([field, existingPaths]) => ({
		path: `supplierData.${field}`,
		existingPaths,
	})),
	...REVIEW_FIELDS.map(([field, existingPaths]) => ({
		path: `otaPlatformReview.${field}`,
		existingPaths,
	})),
	...HOTELRUNNER_FIELDS.map(([field, existingPaths]) => ({
		path: `supplierData.hotelRunner.${field}`,
		existingPaths,
	})),
	...NORMALIZED_SNAPSHOT_FIELDS.map(([field, existingPaths]) => ({
		path: `supplierData.otaNormalizedSnapshot.${field}`,
		existingPaths,
	})),
];

const exactProtectedPaths = Object.freeze([
	"reservation_id",
	"reservationId",
	"hr_number",
	"hrNumber",
	"confirmation_number",
	"confirmationNumber",
	"confirmation_number2",
	"confirmationNumber2",
	"pms_number",
	"pmsNumber",
	"otaIdentityKey",
	"ota_identity_key",
	"otaCrossTransportIdentityKey",
	"ota_cross_transport_identity_key",
	"booking_source",
	"bookingSource",
	...CUSTOMER_FIELDS.flatMap(([field]) => [
		`customer_details.${field}`,
		`customerDetails.${field}`,
	]),
	...SUPPLIER_FIELDS.map(([field]) => `supplierData.${field}`),
	...REVIEW_FIELDS.map(([field]) => `otaPlatformReview.${field}`),
	...HOTELRUNNER_FIELDS.map(([field]) => `supplierData.hotelRunner.${field}`),
	...NORMALIZED_SNAPSHOT_FIELDS.map(
		([field]) => `supplierData.otaNormalizedSnapshot.${field}`
	),
]);

const EXTERNAL_IDENTITY_PATHS = Object.freeze([
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
	"supplierData.suppliedBookingNo",
	"supplierData.supplierBookingNo",
	"supplierData.supplierBookingNumber",
	"supplierData.confirmationNumber",
	"supplierData.otaConfirmationNumber",
	"supplierData.platformConfirmationNumber",
	"supplierData.otaIdentityKey",
	"supplierData.otaCrossTransportIdentityKey",
	"otaPlatformReview.confirmationNumber",
	"otaPlatformReview.confirmation_number",
	"supplierData.hotelRunner.reservationId",
	"supplierData.hotelRunner.reservation_id",
	"supplierData.hotelRunner.hrNumber",
	"supplierData.hotelRunner.hr_number",
	"supplierData.hotelRunner.providerNumber",
	"supplierData.hotelRunner.hrNumberAliases",
	"supplierData.hotelRunner.providerNumberAliases",
	"supplierData.hotelRunner.confirmationNumber",
	"supplierData.hotelRunner.platformConfirmationNumber",
	"supplierData.otaNormalizedSnapshot.confirmationNumber",
	"supplierData.otaNormalizedSnapshot.reservationId",
]);

const INTERNAL_IDENTITY_PATHS = Object.freeze([
	"confirmation_number",
	"confirmationNumber",
	"pms_number",
	"pmsNumber",
	"customer_details.confirmation_number",
	"customer_details.confirmationNumber",
	"customer_details.pms_number",
	"customer_details.pmsNumber",
	"supplierData.pmsConfirmationNumber",
]);

const providerFromValue = (value) => {
	const text = identityText(value);
	if (!text) return "";
	const compact = text.replace(/[\s._-]+/g, "");
	return (
		{
			agoda: "agoda",
			agodacom: "agoda",
			booking: "booking",
			bookingcom: "booking",
			expedia: "expedia",
			expediacom: "expedia",
			airbnb: "airbnb",
			trip: "trip",
			tripcom: "trip",
			tripcomv2: "trip",
			ctrip: "trip",
			hotel: "hotels",
			hotels: "hotels",
			hotelcom: "hotels",
			hotelscom: "hotels",
			trivago: "trivago",
			hotelrunner: "hotelrunner",
		}[compact] || ""
	);
};

const meaningfulAtAnyPath = (value, paths) =>
	paths.some((path) => Boolean(identityText(valueAtPath(value, path))));

const isEstablishedOtaReservation = (reservation = {}) => {
	const existing = asPlainObject(reservation);
	if (
		meaningfulAtAnyPath(existing, [
			"otaIdentityKey",
			"ota_identity_key",
			"otaCrossTransportIdentityKey",
			"ota_cross_transport_identity_key",
		])
	) {
		return true;
	}

	const sourceBacked =
		valueAtPath(existing, "supplierData.otaCreatedFromEmail") === true ||
		valueAtPath(existing, "supplierData.otaCreatedFromSync") === true ||
		/^(?:ota[-_ ]|hotelrunner[-_ ])/.test(
			identityText(valueAtPath(existing, "supplierData.otaAutomationPipeline"))
		) ||
		/^(?:ota[-_ ]|hotelrunner[-_ ])/.test(
			identityText(valueAtPath(existing, "otaPlatformReview.source"))
		) ||
		/^ota[_-]/.test(identityText(valueAtPath(existing, "adminPricing.mode")));

	const providerPaths = [
		"booking_source",
		"bookingSource",
		"customer_details.booking_source",
		"customer_details.bookingSource",
		"customerDetails.booking_source",
		"customerDetails.bookingSource",
		"supplierData.otaProvider",
		"supplierData.supplierName",
		"supplierData.provider",
		"otaPlatformReview.provider",
		"otaPlatformReview.providerLabel",
		"supplierData.hotelRunner.provider",
		"supplierData.hotelRunner.channel",
		"supplierData.otaNormalizedSnapshot.provider",
	];
	const recognizedProvider = providerPaths.some((path) =>
		Boolean(providerFromValue(valueAtPath(existing, path)))
	);
	return (
		(sourceBacked || recognizedProvider) &&
		meaningfulAtAnyPath(existing, EXTERNAL_IDENTITY_PATHS)
	);
};

const identityProtectionError = (field) => ({
	allowed: false,
	status: 409,
	field,
	code: "ota_reservation_identity_locked",
	error:
		"Established OTA and PMS identity fields cannot be changed through this reservation update path.",
});

const identityCollisionError = () => ({
	allowed: false,
	status: 409,
	field: "pms_ota_identity_roles",
	code: "ota_pms_identity_collision",
	error: "PMS and OTA confirmation identities must remain distinct.",
});

const updateOccurrences = (update, path) => {
	const occurrences = [];
	if (hasOwn(update, path)) {
		occurrences.push({ container: update, field: path, path });
	}
	const parts = path.split(".");
	if (parts.length === 1) return occurrences;
	let cursor = update;
	for (let index = 0; index < parts.length - 1; index += 1) {
		if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) break;
		if (!hasOwn(cursor, parts[index])) return occurrences;
		cursor = cursor[parts[index]];
	}
	const field = parts[parts.length - 1];
	if (
		cursor &&
		typeof cursor === "object" &&
		!Array.isArray(cursor) &&
		hasOwn(cursor, field)
	) {
		occurrences.push({ container: cursor, field, path });
	}
	return occurrences;
};

const cleanEmptyIdentityContainers = (update) => {
	if (
		update.supplierData &&
		typeof update.supplierData === "object" &&
		!Array.isArray(update.supplierData)
	) {
		for (const nested of ["hotelRunner", "otaNormalizedSnapshot"]) {
			if (
				hasOwn(update.supplierData, nested) &&
				update.supplierData[nested] &&
				typeof update.supplierData[nested] === "object" &&
				!Array.isArray(update.supplierData[nested]) &&
				Object.keys(update.supplierData[nested]).length === 0
			) {
				delete update.supplierData[nested];
			}
		}
	}
	for (const container of ["customer_details", "customerDetails", "supplierData", "otaPlatformReview"]) {
		if (
			hasOwn(update, container) &&
			update[container] &&
			typeof update[container] === "object" &&
			!Array.isArray(update[container]) &&
			Object.keys(update[container]).length === 0
		) {
			delete update[container];
		}
	}
};

const normalizedIdentityAtoms = (value) => {
	if (Array.isArray(value)) return value.flatMap(normalizedIdentityAtoms);
	const normalized = identityText(value);
	return normalized ? [normalized] : [];
};

const protectedIdentityValues = (reservation, paths, { external = false } = {}) => {
	const values = new Set();
	for (const path of paths) {
		for (const normalized of normalizedIdentityAtoms(valueAtPath(reservation, path))) {
			values.add(normalized);
			if (external) {
				const namespaced = normalized.match(/^[a-z0-9._-]+:(.+)$/i);
				if (namespaced?.[1]) values.add(identityText(namespaced[1]));
			}
		}
	}
	return values;
};

const newPmsOtaCollision = (existing, candidate) => {
	const collisions = (value) => {
		const internal = protectedIdentityValues(value, INTERNAL_IDENTITY_PATHS);
		const external = protectedIdentityValues(value, EXTERNAL_IDENTITY_PATHS, {
			external: true,
		});
		return new Set([...internal].filter((item) => external.has(item)));
	};
	const before = collisions(existing);
	return [...collisions(candidate)].some((item) => !before.has(item));
};

const hasAnyPmsOtaCollision = (value) => {
	const internal = protectedIdentityValues(value, INTERNAL_IDENTITY_PATHS);
	const external = protectedIdentityValues(value, EXTERNAL_IDENTITY_PATHS, {
		external: true,
	});
	return [...internal].some((item) => external.has(item));
};

const validateEstablishedOtaReservationIdentityCandidate = (
	existingReservation = {},
	candidateReservation = {}
) => {
	const existing = asPlainObject(existingReservation);
	const candidate = asPlainObject(candidateReservation);
	const existingEstablished = isEstablishedOtaReservation(existing);
	const candidateEstablished = isEstablishedOtaReservation(candidate);
	if (!existingEstablished && candidateEstablished) {
		return identityProtectionError("ota_identity_conversion");
	}
	if (!existingEstablished) return { allowed: true, establishedOta: false };
	for (const path of exactProtectedPaths) {
		if (
			comparableIdentityValue(valueAtPath(candidate, path)) !==
			comparableIdentityValue(valueAtPath(existing, path))
		) {
			return identityProtectionError(path);
		}
	}
	if (newPmsOtaCollision(existing, candidate)) {
		return identityProtectionError("pms_ota_identity_roles");
	}
	return { allowed: true, establishedOta: true };
};

const mergeCandidate = (existing, update, replacementContainers = []) => {
	const candidate = { ...existing };
	for (const [key, value] of Object.entries(update)) {
		if (key.includes(".")) {
			const parts = key.split(".");
			let cursor = candidate;
			for (let index = 0; index < parts.length - 1; index += 1) {
				const segment = parts[index];
				cursor[segment] = { ...asPlainObject(cursor[segment]) };
				cursor = cursor[segment];
			}
			cursor[parts[parts.length - 1]] = value;
			continue;
		}
		if (
			value &&
			typeof value === "object" &&
			!Array.isArray(value) &&
			!replacementContainers.includes(key)
		) {
			candidate[key] = { ...asPlainObject(existing[key]), ...value };
		} else {
			candidate[key] = value;
		}
	}
	return candidate;
};

/**
 * Source-authoritative reconcilers may legitimately add another OTA alias.
 * Unlike the generic editor policy, this assertion does not freeze aliases; it
 * only proves that a materialized update cannot make a PMS identity an OTA
 * identity. Existing legacy collisions are grandfathered, but no new collision
 * may be introduced. The update is interpreted with Mongo-style dotted paths.
 */
const validateOtaReservationIdentityMaterialization = (
	existingReservation = {},
	materializedUpdate = {},
	{ replacementContainers = [] } = {}
) => {
	const existing = asPlainObject(existingReservation);
	const candidate = mergeCandidate(
		existing,
		asPlainObject(materializedUpdate),
		replacementContainers
	);
	if (
		!isEstablishedOtaReservation(existing) &&
		!isEstablishedOtaReservation(candidate)
	) {
		return { allowed: true, establishedOta: false };
	}
	if (
		!isEstablishedOtaReservation(existing) &&
		isEstablishedOtaReservation(candidate) &&
		hasAnyPmsOtaCollision(candidate)
	) {
		return identityCollisionError();
	}
	if (newPmsOtaCollision(existing, candidate)) return identityCollisionError();
	return { allowed: true, establishedOta: true };
};

const assertOtaReservationIdentityMaterialization = (
	existingReservation = {},
	materializedUpdate = {},
	options = {}
) => {
	const result = validateOtaReservationIdentityMaterialization(
		existingReservation,
		materializedUpdate,
		options
	);
	if (result.allowed) return result;
	const error = new Error(result.error);
	error.code = result.code;
	error.statusCode = result.status;
	error.field = result.field;
	throw error;
};

const protectEstablishedOtaReservationIdentityUpdate = (
	update = {},
	existingReservation = {},
	{ replacementContainers = [] } = {}
) => {
	if (!update || typeof update !== "object" || Array.isArray(update)) {
		return identityProtectionError("update");
	}
	const existing = asPlainObject(existingReservation);
	const rawCandidate = mergeCandidate(existing, update, replacementContainers);
	const existingEstablished = isEstablishedOtaReservation(existing);
	const candidateEstablished = isEstablishedOtaReservation(rawCandidate);
	if (!existingEstablished && candidateEstablished) {
		return identityProtectionError("ota_identity_conversion");
	}
	if (!existingEstablished) {
		return { allowed: true, establishedOta: false, strippedFields: [] };
	}
	const explicitlyEmptyReplacementContainers = replacementContainers.filter(
		(container) =>
			hasOwn(update, container) &&
			update[container] &&
			typeof update[container] === "object" &&
			!Array.isArray(update[container]) &&
			Object.keys(update[container]).length === 0
	);

	for (const container of ["customer_details", "customerDetails", "supplierData", "otaPlatformReview"]) {
		if (
			hasOwn(update, container) &&
			(update[container] === null ||
				typeof update[container] !== "object" ||
				Array.isArray(update[container]))
		) {
			return identityProtectionError(container);
		}
	}
	if (
		update.supplierData &&
		hasOwn(update.supplierData, "hotelRunner") &&
		(update.supplierData.hotelRunner === null ||
			typeof update.supplierData.hotelRunner !== "object" ||
			Array.isArray(update.supplierData.hotelRunner))
	) {
		return identityProtectionError("supplierData.hotelRunner");
	}
	if (
		update.supplierData &&
		hasOwn(update.supplierData, "otaNormalizedSnapshot") &&
		(update.supplierData.otaNormalizedSnapshot === null ||
			typeof update.supplierData.otaNormalizedSnapshot !== "object" ||
			Array.isArray(update.supplierData.otaNormalizedSnapshot))
	) {
		return identityProtectionError("supplierData.otaNormalizedSnapshot");
	}

	const strippedFields = new Set();
	for (const spec of pathSpecs) {
		const expected = firstValueAtPaths(existing, spec.existingPaths);
		for (const occurrence of updateOccurrences(update, spec.path)) {
			if (
				comparableIdentityValue(occurrence.container[occurrence.field]) !==
				comparableIdentityValue(expected)
			) {
				return identityProtectionError(occurrence.path);
			}
			delete occurrence.container[occurrence.field];
			strippedFields.add(occurrence.path);
		}
	}
	cleanEmptyIdentityContainers(update);
	if (explicitlyEmptyReplacementContainers.length) {
		return identityProtectionError(explicitlyEmptyReplacementContainers[0]);
	}

	const candidate = mergeCandidate(existing, update, replacementContainers);
	const invariant = validateEstablishedOtaReservationIdentityCandidate(
		existing,
		candidate
	);
	if (!invariant.allowed) return invariant;
	return {
		allowed: true,
		establishedOta: true,
		strippedFields: [...strippedFields].sort(),
	};
};

const cloneIdentityUpdateForValidation = (value, depth = 0) => {
	if (depth > 8) return value;
	if (Array.isArray(value)) {
		return value.map((item) => cloneIdentityUpdateForValidation(item, depth + 1));
	}
	if (!value || typeof value !== "object" || value instanceof Date) return value;
	if (value._bsontype || Buffer.isBuffer(value)) return value;
	return Object.fromEntries(
		Object.entries(asPlainObject(value)).map(([key, item]) => [
			key,
			cloneIdentityUpdateForValidation(item, depth + 1),
		])
	);
};

const validateEstablishedOtaReservationIdentityUpdate = (
	update = {},
	existingReservation = {},
	options = {}
) =>
	protectEstablishedOtaReservationIdentityUpdate(
		cloneIdentityUpdateForValidation(update),
		existingReservation,
		options
	);

module.exports = {
	assertOtaReservationIdentityMaterialization,
	isEstablishedOtaReservation,
	protectEstablishedOtaReservationIdentityUpdate,
	validateEstablishedOtaReservationIdentityCandidate,
	validateEstablishedOtaReservationIdentityUpdate,
	validateOtaReservationIdentityMaterialization,
};
