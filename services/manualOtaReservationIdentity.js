/** @format */

const Reservations = require("../models/reservations");
const {
  assertReservationPmsConfirmationDistinct,
  generateUniquePmsConfirmationNumber,
} = require("./pmsConfirmationAllocator");
const {
  buildLegacyOtaIdentityKey,
  findLegacyOtaImportReservation,
  prepareLegacyOtaImportCreateDocument,
} = require("./legacyOtaImportIdentity");

const MANUAL_OTA_SOURCE_PROVIDERS = Object.freeze({
  agoda: "agoda",
  "agoda.com": "agoda",
  "agoda com": "agoda",
  agodacom: "agoda",
  expedia: "expedia",
  "expedia.com": "expedia",
  "expedia com": "expedia",
  expediacom: "expedia",
  airbnb: "airbnb",
  "airbnb.com": "airbnb",
  "airbnb com": "airbnb",
  airbnbcom: "airbnb",
  booking: "booking",
  "booking.com": "booking",
  "booking com": "booking",
  bookingcom: "booking",
  trip: "trip",
  "trip.com": "trip",
  "trip com": "trip",
  tripcom: "trip",
  "trip.com v2": "trip",
  "trip com v2": "trip",
  "trip.comv2": "trip",
  tripcomv2: "trip",
  ctrip: "trip",
  trivago: "trivago",
  hotel: "hotels",
  hotels: "hotels",
  "hotel.com": "hotels",
  "hotels.com": "hotels",
  "hotel com": "hotels",
  "hotels com": "hotels",
  hotelcom: "hotels",
  hotelscom: "hotels",
});

const MANUAL_OTA_PROVIDER_BOOKING_SOURCES = Object.freeze({
  agoda: Object.freeze(["agoda", "agoda.com", "agoda com", "agodacom"]),
  expedia: Object.freeze(["expedia", "expedia.com", "expedia com", "expediacom"]),
  airbnb: Object.freeze(["airbnb", "airbnb.com", "airbnb com", "airbnbcom"]),
  booking: Object.freeze(["booking", "booking.com", "booking com", "bookingcom"]),
  trip: Object.freeze(["trip", "trip.com", "trip com", "tripcom", "trip.com v2", "trip com v2", "trip.comv2", "tripcomv2", "ctrip"]),
  trivago: Object.freeze(["trivago"]),
  hotels: Object.freeze(["hotel", "hotels", "hotel.com", "hotels.com", "hotel com", "hotels com", "hotelcom", "hotelscom"]),
});

const SERVER_OWNED_ROOT_IDENTITY_FIELDS = Object.freeze([
  "confirmation_number",
  "confirmationNumber",
  "confirmation_number2",
  "confirmationNumber2",
  "pms_number",
  "pmsNumber",
  "reservation_id",
  "reservationId",
  "hr_number",
  "hrNumber",
  "otaIdentityKey",
  "ota_identity_key",
  "otaCrossTransportIdentityKey",
  "ota_cross_transport_identity_key",
]);

const SERVER_OWNED_CUSTOMER_IDENTITY_FIELDS = Object.freeze([
  "confirmation_number",
  "confirmationNumber",
  "confirmationNumber2",
  "reservation_id",
  "reservationId",
  "hr_number",
  "hrNumber",
  "pms_number",
  "pmsNumber",
  "otaIdentityKey",
  "otaCrossTransportIdentityKey",
]);

const SERVER_OWNED_SUPPLIER_IDENTITY_FIELDS = Object.freeze([
  "supplierName",
  "suppliedBookingNo",
  "supplierBookingNo",
  "supplierBookingNumber",
  "confirmationNumber",
  "otaProvider",
  "otaConfirmationNumber",
  "platformConfirmationNumber",
  "pmsConfirmationNumber",
  "otaIdentityKey",
  "otaCrossTransportIdentityKey",
]);

const SERVER_OWNED_NESTED_IDENTITY_PATHS = Object.freeze([
  [
    "supplierData.otaNormalizedSnapshot.confirmationNumber",
    ["supplierData", "otaNormalizedSnapshot", "confirmationNumber"],
  ],
  [
    "supplierData.otaNormalizedSnapshot.reservationId",
    ["supplierData", "otaNormalizedSnapshot", "reservationId"],
  ],
  [
    "supplierData.hotelRunner.reservationId",
    ["supplierData", "hotelRunner", "reservationId"],
  ],
  [
    "supplierData.hotelRunner.reservation_id",
    ["supplierData", "hotelRunner", "reservation_id"],
  ],
  [
    "supplierData.hotelRunner.hrNumber",
    ["supplierData", "hotelRunner", "hrNumber"],
  ],
  [
    "supplierData.hotelRunner.hr_number",
    ["supplierData", "hotelRunner", "hr_number"],
  ],
  [
    "supplierData.hotelRunner.providerNumber",
    ["supplierData", "hotelRunner", "providerNumber"],
  ],
  [
    "supplierData.hotelRunner.hrNumberAliases",
    ["supplierData", "hotelRunner", "hrNumberAliases"],
  ],
  [
    "supplierData.hotelRunner.providerNumberAliases",
    ["supplierData", "hotelRunner", "providerNumberAliases"],
  ],
  [
    "supplierData.hotelRunner.confirmationNumber",
    ["supplierData", "hotelRunner", "confirmationNumber"],
  ],
  [
    "supplierData.hotelRunner.platformConfirmationNumber",
    ["supplierData", "hotelRunner", "platformConfirmationNumber"],
  ],
]);

function normalizeText(value) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizedManualOtaBookingSource(value) {
  return normalizeText(value).toLowerCase();
}

function manualOtaProviderForBookingSource(value) {
  return (
    MANUAL_OTA_SOURCE_PROVIDERS[normalizedManualOtaBookingSource(value)] || ""
  );
}

function identityRequestError(code, message, fields = []) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 400;
  error.fields = fields;
  return error;
}

function meaningfulIdentityValue(value) {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.some(meaningfulIdentityValue);
  if (typeof value === "object") return Object.keys(value).length > 0;
  return Boolean(normalizeText(value));
}

function valueAtPath(document, path) {
  return path.reduce((value, field) => value?.[field], document);
}

function resolveManualOtaCreateIdentity(document = {}) {
  const bookingSource = normalizedManualOtaBookingSource(
    document.booking_source
  );
  const provider = manualOtaProviderForBookingSource(bookingSource);
  if (!provider) return null;

  const externalConfirmationNumber = normalizeText(
    document.customer_details?.confirmation_number2
  );
  if (!externalConfirmationNumber) {
    throw identityRequestError(
      "manual_ota_external_confirmation_required",
      "The OTA confirmation number is required in customer_details.confirmation_number2."
    );
  }

  const serverOwnedInputs = [
    ...SERVER_OWNED_ROOT_IDENTITY_FIELDS.map((field) => [
      field,
      document[field],
    ]),
    ...SERVER_OWNED_CUSTOMER_IDENTITY_FIELDS.map((field) => [
      `customer_details.${field}`,
      document.customer_details?.[field],
    ]),
    ...[
      "confirmation_number2",
      ...SERVER_OWNED_CUSTOMER_IDENTITY_FIELDS,
    ].map((field) => [
      `customerDetails.${field}`,
      document.customerDetails?.[field],
    ]),
    ...SERVER_OWNED_SUPPLIER_IDENTITY_FIELDS.map((field) => [
      `supplierData.${field}`,
      document.supplierData?.[field],
    ]),
    [
      "otaPlatformReview.confirmationNumber",
      document.otaPlatformReview?.confirmationNumber,
    ],
    [
      "otaPlatformReview.confirmation_number",
      document.otaPlatformReview?.confirmation_number,
    ],
    ["otaPlatformReview.provider", document.otaPlatformReview?.provider],
    ...SERVER_OWNED_NESTED_IDENTITY_PATHS.map(([field, path]) => [
      field,
      valueAtPath(document, path),
    ]),
  ].filter(([, value]) => meaningfulIdentityValue(value));
  if (serverOwnedInputs.length) {
    throw identityRequestError(
      "manual_ota_identity_ambiguous",
      "OTA reservations may provide only customer_details.confirmation_number2; PMS and canonical identity fields are server-owned.",
      serverOwnedInputs.map(([field]) => field)
    );
  }

  return {
    bookingSource,
    provider,
    externalConfirmationNumber,
    otaIdentityKey: buildLegacyOtaIdentityKey(
      provider,
      externalConfirmationNumber
    ),
  };
}

function sanitizedManualOtaCreateDocument(document = {}) {
  const sanitized = {
    ...document,
    customer_details: { ...(document.customer_details || {}) },
    customerDetails: { ...(document.customerDetails || {}) },
    supplierData: { ...(document.supplierData || {}) },
  };
  for (const field of SERVER_OWNED_ROOT_IDENTITY_FIELDS) {
    delete sanitized[field];
  }
  for (const field of SERVER_OWNED_CUSTOMER_IDENTITY_FIELDS) {
    delete sanitized.customer_details[field];
    delete sanitized.customerDetails[field];
  }
  delete sanitized.customerDetails.confirmation_number2;
  for (const field of SERVER_OWNED_SUPPLIER_IDENTITY_FIELDS) {
    delete sanitized.supplierData[field];
  }
  if (!Object.keys(sanitized.supplierData).length)
    delete sanitized.supplierData;
  if (!Object.keys(sanitized.customerDetails).length)
    delete sanitized.customerDetails;
  return sanitized;
}

async function prepareManualOtaCreateDocument({
  document = {},
  generateConfirmation = generateUniquePmsConfirmationNumber,
}) {
  const identity = resolveManualOtaCreateIdentity(document);
  if (!identity) return { document, identity: null };
  const prepared = await prepareLegacyOtaImportCreateDocument({
    document: sanitizedManualOtaCreateDocument(document),
    provider: identity.provider,
    externalConfirmationNumber: identity.externalConfirmationNumber,
    generateConfirmation,
  });
  assertReservationPmsConfirmationDistinct(prepared);
  return { document: prepared, identity };
}

async function limitedFind(ReservationModel, filter) {
  return ReservationModel.find(filter).limit(2).exec();
}

async function findManualOtaCreateConflict({
  document = {},
  identity,
  ReservationModel = Reservations,
}) {
  if (!identity) return null;
  const scoped = await findLegacyOtaImportReservation(
    {
      provider: identity.provider,
      externalConfirmationNumber: identity.externalConfirmationNumber,
      hotelId: document.hotelId,
      bookingSources: MANUAL_OTA_PROVIDER_BOOKING_SOURCES[
        identity.provider
      ] || [identity.bookingSource],
    },
    ReservationModel
  );
  if (scoped) return scoped;

  const exactIdentityMatches = await limitedFind(ReservationModel, {
    otaIdentityKey: identity.otaIdentityKey,
  });
  if (exactIdentityMatches.length > 1) {
    const error = new Error(
      "Manual OTA creation stopped because the provider identity is ambiguous."
    );
    error.code = "manual_ota_identity_ambiguous";
    error.statusCode = 409;
    throw error;
  }
  return exactIdentityMatches[0] || null;
}

module.exports = {
  MANUAL_OTA_PROVIDER_BOOKING_SOURCES,
  MANUAL_OTA_SOURCE_PROVIDERS,
  findManualOtaCreateConflict,
  manualOtaProviderForBookingSource,
  prepareManualOtaCreateDocument,
  resolveManualOtaCreateIdentity,
  sanitizedManualOtaCreateDocument,
};
