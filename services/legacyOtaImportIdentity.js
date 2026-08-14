/** @format */

const Reservations = require("../models/reservations");
const {
	assertReservationPmsConfirmationDistinct,
	generateUniquePmsConfirmationNumber,
} = require("./pmsConfirmationAllocator");

const PROVIDERS = Object.freeze({
	agoda: Object.freeze({ key: "agoda", supplierName: "Agoda" }),
	expedia: Object.freeze({ key: "expedia", supplierName: "Expedia" }),
	airbnb: Object.freeze({ key: "airbnb", supplierName: "Airbnb" }),
	booking: Object.freeze({ key: "booking", supplierName: "Booking.com" }),
	trip: Object.freeze({ key: "trip", supplierName: "Trip.com" }),
	trivago: Object.freeze({ key: "trivago", supplierName: "Trivago" }),
	hotels: Object.freeze({ key: "hotels", supplierName: "Hotels.com" }),
});

const PROVIDER_ALIASES = Object.freeze({
	agoda: "agoda",
	expedia: "expedia",
	airbnb: "airbnb",
	booking: "booking",
	"booking.com": "booking",
	bookingcom: "booking",
	trip: "trip",
	"trip.com": "trip",
	tripcom: "trip",
	"trip.comv2": "trip",
	tripcomv2: "trip",
	ctrip: "trip",
	trivago: "trivago",
	hotel: "hotels",
	hotels: "hotels",
	"hotel.com": "hotels",
	"hotels.com": "hotels",
	hotelcom: "hotels",
	hotelscom: "hotels",
});

const IDENTITY_ROOT_FIELDS = Object.freeze([
	"confirmation_number",
	"pms_number",
	"reservation_id",
	"hr_number",
	"otaIdentityKey",
	"otaCrossTransportIdentityKey",
]);

const IDENTITY_CUSTOMER_FIELDS = Object.freeze([
	"confirmation_number",
	"confirmationNumber",
	"confirmation_number2",
	"confirmationNumber2",
]);

const IDENTITY_SUPPLIER_FIELDS = Object.freeze([
	"suppliedBookingNo",
	"otaConfirmationNumber",
	"platformConfirmationNumber",
	"pmsConfirmationNumber",
	"otaProvider",
]);

function normalizeText(value) {
	return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeProvider(provider) {
	const raw = normalizeText(provider).toLowerCase().replace(/\s+/g, "");
	const key = PROVIDER_ALIASES[raw] || "";
	if (!key || !PROVIDERS[key]) {
		const error = new Error(`Unsupported legacy OTA import provider: ${provider}`);
		error.code = "legacy_ota_import_provider_invalid";
		throw error;
	}
	return PROVIDERS[key];
}

function normalizeExternalConfirmationNumber(value) {
	const normalized = normalizeText(value);
	if (!normalized) {
		const error = new Error(
			"A non-empty external OTA confirmation number is required."
		);
		error.code = "legacy_ota_import_external_confirmation_missing";
		throw error;
	}
	return normalized;
}

function buildLegacyOtaIdentityKey(provider, externalConfirmationNumber) {
	const { key } = normalizeProvider(provider);
	return `${key}:${normalizeExternalConfirmationNumber(
		externalConfirmationNumber
	).toLowerCase()}`;
}

function confirmationLookupValues(value) {
	const raw = normalizeExternalConfirmationNumber(value);
	return Array.from(new Set([raw, raw.toLowerCase(), raw.toUpperCase()]));
}

function normalizedBookingSources(bookingSources) {
	const values = Array.isArray(bookingSources)
		? bookingSources
		: [bookingSources];
	const normalized = Array.from(
		new Set(values.map((value) => normalizeText(value).toLowerCase()).filter(Boolean))
	);
	if (!normalized.length) {
		const error = new Error(
			"At least one booking source is required for a legacy OTA import lookup."
		);
		error.code = "legacy_ota_import_booking_source_missing";
		throw error;
	}
	return normalized;
}

function exactCaseInsensitiveRegex(value) {
	const escaped = normalizeText(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return new RegExp(`^${escaped}$`, "i");
}

function buildLegacyOtaImportLookup({
	provider,
	externalConfirmationNumber,
	hotelId,
	bookingSources,
	legacyState = "",
}) {
	if (!hotelId) {
		const error = new Error(
			"A hotel is required for a legacy OTA import identity lookup."
		);
		error.code = "legacy_ota_import_hotel_missing";
		throw error;
	}

	const { key } = normalizeProvider(provider);
	const lookupValues = confirmationLookupValues(externalConfirmationNumber);
	const otaIdentityKey = buildLegacyOtaIdentityKey(
		key,
		externalConfirmationNumber
	);
	const externalAliasLookup = {
		$or: [
			{ reservation_id: { $in: lookupValues } },
			{ "customer_details.confirmation_number2": { $in: lookupValues } },
			{ "supplierData.suppliedBookingNo": { $in: lookupValues } },
			{ "supplierData.otaConfirmationNumber": { $in: lookupValues } },
			{ "supplierData.platformConfirmationNumber": { $in: lookupValues } },
		],
	};
	const providerMarkers = [
		{ "supplierData.otaProvider": key },
		{
			"supplierData.supplierName": exactCaseInsensitiveRegex(
				PROVIDERS[key].supplierName
			),
		},
		{ "otaPlatformReview.provider": key },
	];
	if (legacyState) {
		providerMarkers.push({ state: exactCaseInsensitiveRegex(legacyState) });
	}
	const providerScopedExternalAliasLookup = legacyState
		? { $and: [{ $or: providerMarkers }, externalAliasLookup] }
		: externalAliasLookup;
	const legacyConfirmationMatch = {
		confirmation_number: { $in: lookupValues },
	};
	if (legacyState) {
		legacyConfirmationMatch.state = exactCaseInsensitiveRegex(legacyState);
	}
	const legacyConfirmationLookup = {
		$and: [
			legacyConfirmationMatch,
			{
				$or: [
					{ otaIdentityKey: { $exists: false } },
					{ otaIdentityKey: "" },
					{ otaIdentityKey: null },
				],
			},
		],
	};

	return {
		hotelId,
		booking_source: { $in: normalizedBookingSources(bookingSources) },
		$or: [
			{ otaIdentityKey },
			providerScopedExternalAliasLookup,
			legacyConfirmationLookup,
		],
	};
}

async function findLegacyOtaImportReservation(
	options,
	ReservationModel = Reservations
) {
	const matches = await ReservationModel.find(
		buildLegacyOtaImportLookup(options)
	)
		.limit(2)
		.exec();
	if (matches.length > 1) {
		const error = new Error(
			"Legacy OTA import stopped because more than one existing reservation matches the provider identity."
		);
		error.code = "legacy_ota_import_identity_ambiguous";
		throw error;
	}
	const match = matches[0] || null;
	if (!match) return null;

	const expectedProvider = normalizeProvider(options.provider).key;
	const expectedExternal = normalizeExternalConfirmationNumber(
		options.externalConfirmationNumber
	).toLowerCase();
	const expectedIdentityKey = buildLegacyOtaIdentityKey(
		expectedProvider,
		expectedExternal
	);
	const storedIdentityKey = normalizeText(match.otaIdentityKey).toLowerCase();
	const storedProvider = normalizeText(
		match.supplierData?.otaProvider
	).toLowerCase();
	const storedAliases = [
		match.reservation_id,
		match.customer_details?.confirmation_number2,
		match.supplierData?.suppliedBookingNo,
		match.supplierData?.otaConfirmationNumber,
		match.supplierData?.platformConfirmationNumber,
	]
		.map((value) => normalizeText(value).toLowerCase())
		.filter(Boolean);
	const hasIdentityConflict =
		(storedIdentityKey && storedIdentityKey !== expectedIdentityKey) ||
		(storedProvider && storedProvider !== expectedProvider) ||
		storedAliases.some((value) => value !== expectedExternal);
	if (hasIdentityConflict) {
		const error = new Error(
			"Legacy OTA import stopped because the matched reservation has conflicting provider identity fields."
		);
		error.code = "legacy_ota_import_identity_conflict";
		throw error;
	}
	return match;
}

function buildLegacyOtaImportCreateDocument({
	document = {},
	provider,
	externalConfirmationNumber,
	pmsConfirmationNumber,
}) {
	const { key, supplierName } = normalizeProvider(provider);
	const external = normalizeExternalConfirmationNumber(
		externalConfirmationNumber
	);
	const otaIdentityKey = buildLegacyOtaIdentityKey(key, external);
	const pms = normalizeText(pmsConfirmationNumber);
	if (!pms) {
		const error = new Error(
			"A non-empty PMS confirmation number is required for a legacy OTA import."
		);
		error.code = "legacy_ota_import_pms_confirmation_missing";
		throw error;
	}
	const prepared = {
		...document,
		confirmation_number: pms,
		pms_number: pms,
		reservation_id: external,
		otaIdentityKey,
		customer_details: {
			...(document.customer_details || {}),
			confirmation_number2: external,
		},
		supplierData: {
			...(document.supplierData || {}),
			supplierName,
			suppliedBookingNo: external,
			otaProvider: key,
			otaConfirmationNumber: external,
			platformConfirmationNumber: external,
			pmsConfirmationNumber: pms,
		},
	};
	assertReservationPmsConfirmationDistinct(prepared);
	return prepared;
}

async function prepareLegacyOtaImportCreateDocument({
	document = {},
	provider,
	externalConfirmationNumber,
	generateConfirmation = generateUniquePmsConfirmationNumber,
}) {
	const otaIdentityKey = buildLegacyOtaIdentityKey(
		provider,
		externalConfirmationNumber
	);
	const pmsConfirmationNumber = await generateConfirmation(25, [
		externalConfirmationNumber,
		otaIdentityKey,
	]);
	return buildLegacyOtaImportCreateDocument({
		document,
		provider,
		externalConfirmationNumber,
		pmsConfirmationNumber,
	});
}

function stripLegacyOtaImportIdentityFields(document = {}) {
	const update = { ...document };
	for (const field of IDENTITY_ROOT_FIELDS) delete update[field];

	if (update.customer_details && typeof update.customer_details === "object") {
		update.customer_details = { ...update.customer_details };
		for (const field of IDENTITY_CUSTOMER_FIELDS) {
			delete update.customer_details[field];
		}
	}
	if (update.supplierData && typeof update.supplierData === "object") {
		update.supplierData = { ...update.supplierData };
		for (const field of IDENTITY_SUPPLIER_FIELDS) {
			delete update.supplierData[field];
		}
		if (!Object.keys(update.supplierData).length) delete update.supplierData;
	}
	return update;
}

function plainObject(value) {
	if (!value || typeof value !== "object") return {};
	if (typeof value.toObject === "function") return value.toObject();
	return { ...value };
}

function buildLegacyOtaImportUpdateDocument(
	existingReservation = {},
	incomingDocument = {}
) {
	const update = stripLegacyOtaImportIdentityFields(incomingDocument);
	if (update.customer_details && typeof update.customer_details === "object") {
		update.customer_details = {
			...plainObject(existingReservation.customer_details),
			...update.customer_details,
		};
	}
	if (update.supplierData && typeof update.supplierData === "object") {
		update.supplierData = {
			...plainObject(existingReservation.supplierData),
			...update.supplierData,
		};
	}
	return update;
}

function isPmsConfirmationDuplicate(error) {
	if (error?.code !== 11000) return false;
	const keyPattern = error.keyPattern || {};
	if (Object.keys(keyPattern).length) {
		return (
			Object.keys(keyPattern).length === 1 &&
			Object.prototype.hasOwnProperty.call(keyPattern, "confirmation_number")
		);
	}
	return /(?:confirmation_number_1|confirmation_number)\s+dup key/i.test(
		String(error.message || "")
	);
}

function duplicateConflictError(error) {
	const conflict = new Error(
		"Legacy OTA import stopped because a unique identity conflict could not be resolved safely."
	);
	conflict.code = "legacy_ota_import_duplicate_conflict";
	conflict.cause = error;
	return conflict;
}

async function createLegacyOtaImportReservation({
	document,
	provider,
	externalConfirmationNumber,
	createReservation,
	findExisting,
	generateConfirmation = generateUniquePmsConfirmationNumber,
	maxPmsCollisionRetries = 2,
}) {
	if (typeof createReservation !== "function") {
		throw new TypeError("createReservation must be a function.");
	}
	if (typeof findExisting !== "function") {
		throw new TypeError("findExisting must be a function.");
	}

	for (
		let attempt = 0;
		attempt <= Math.max(0, Number(maxPmsCollisionRetries) || 0);
		attempt += 1
	) {
		// Allocate a fresh PMS identifier for every retry. The allocator reserves all
		// provider aliases, while the invariant below fails closed before any write.
		// eslint-disable-next-line no-await-in-loop
		const prepared = await prepareLegacyOtaImportCreateDocument({
			document,
			provider,
			externalConfirmationNumber,
			generateConfirmation,
		});
		try {
			const insertOptions = {
				beforeInsert: ({ reservationData = prepared } = {}) =>
					assertReservationPmsConfirmationDistinct(reservationData),
			};
			// eslint-disable-next-line no-await-in-loop
			const reservation = await createReservation(prepared, insertOptions);
			return { created: true, reservation, document: prepared };
		} catch (error) {
			if (error?.code !== 11000) throw error;
			// If another request created this exact hotel/provider/source reservation,
			// return that record. A collision outside that scope remains a hard error.
			// eslint-disable-next-line no-await-in-loop
			const racedExisting = await findExisting();
			if (racedExisting) {
				return {
					created: false,
					reservation: racedExisting,
					document: null,
					reason: "external_identity_race",
				};
			}
			if (
				isPmsConfirmationDuplicate(error) &&
				attempt < Math.max(0, Number(maxPmsCollisionRetries) || 0)
			) {
				continue;
			}
			throw duplicateConflictError(error);
		}
	}

	throw duplicateConflictError(
		new Error("PMS confirmation collision retries were exhausted.")
	);
}

module.exports = {
	buildLegacyOtaIdentityKey,
	buildLegacyOtaImportCreateDocument,
	buildLegacyOtaImportLookup,
	buildLegacyOtaImportUpdateDocument,
	createLegacyOtaImportReservation,
	findLegacyOtaImportReservation,
	isPmsConfirmationDuplicate,
	normalizeProvider,
	prepareLegacyOtaImportCreateDocument,
	stripLegacyOtaImportIdentityFields,
};
