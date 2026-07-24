"use strict";

const crypto = require("crypto");
const { providerLabel } = require("./bofaVccBilling");

const clean = (value, max = 255) =>
	String(value == null ? "" : value)
		.trim()
		.replace(/\s+/g, " ")
		.slice(0, max);

const cleanOutboundAscii = (value, max = 100) =>
	clean(value, max * 2)
		.normalize("NFKD")
		.replace(/[^\x20-\x7E]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, max);

const toIsoDate = (value) => {
	if (!value) return "";
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
};

const toPositiveInteger = (value, fallback = 0) => {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
};

const referenceToken = (value, max = 24) =>
	clean(value, 100)
		.toUpperCase()
		.replace(/[^A-Z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, max);

const shortHash = (value) =>
	value
		? crypto.createHash("sha256").update(String(value), "utf8").digest("hex").slice(0, 16)
		: "";

const resolveOtaConfirmationNumber = (reservation = {}) =>
	clean(
		reservation?.customer_details?.confirmation_number2 ||
			reservation?.reservation_id ||
			reservation?.supplierData?.confirmationNumber,
		64,
	);

const buildBankReferenceNumber = (reservation = {}, now = Date.now()) => {
	const orderReference =
		referenceToken(reservation?.confirmation_number, 24) ||
		referenceToken(reservation?._id, 24) ||
		"RESERVATION";
	return `JB-${orderReference}-${Number(now).toString(36).toUpperCase()}`.slice(0, 50);
};

/**
 * Immutable, non-card payment context saved in our reservation audit record.
 * This may contain internal order identifiers, so it must never be returned by
 * public reservation APIs or copied into Bank of America merchant-defined data.
 */
const buildReservationPaymentContext = ({
	reservation = {},
	hotelName = "",
	provider = "other",
	referenceNumber = "",
	amountUsd = 0,
	billingProfileId = "",
	billingSource = "",
}) => {
	const checkInDate = toIsoDate(reservation?.checkin_date);
	const checkOutDate = toIsoDate(reservation?.checkout_date);
	const calculatedNights =
		checkInDate && checkOutDate
			? Math.max(
					0,
					Math.round(
						(new Date(`${checkOutDate}T00:00:00Z`) -
							new Date(`${checkInDate}T00:00:00Z`)) /
							86400000,
					),
			  )
			: 0;
	const otaConfirmationNumber = resolveOtaConfirmationNumber(reservation);
	const resolvedHotelName = clean(
		hotelName || reservation?.supplierData?.otaHotelName || reservation?.hotel_name,
		100,
	);

	return {
		schema_version: 1,
		payment_purpose: "OTA_VIRTUAL_CARD_HOTEL_STAY",
		bank_reference_number: clean(referenceNumber, 50),
		reservation_mongo_id: clean(reservation?._id, 64),
		hotel_reservation_confirmation_number: clean(
			reservation?.confirmation_number,
			64,
		),
		hotel_name: resolvedHotelName,
		ota_confirmation_number: otaConfirmationNumber,
		ota_confirmation_sha256_16: shortHash(otaConfirmationNumber),
		check_in_date: checkInDate,
		check_out_date: checkOutDate,
		stay_nights: toPositiveInteger(
			reservation?.days_of_residence,
			calculatedNights,
		),
		room_count: toPositiveInteger(reservation?.total_rooms, 1),
		ota_name: clean(providerLabel(provider), 40),
		ota_provider: clean(provider, 24).toLowerCase(),
		booking_source: clean(reservation?.booking_source, 60),
		reservation_status: clean(reservation?.reservation_status, 40),
		amount_usd: Number(Number(amountUsd || 0).toFixed(2)),
		currency: "USD",
		billing_profile_id: clean(billingProfileId, 60),
		billing_source: clean(billingSource, 40),
	};
};

/**
 * Bank of America Hosted Payments supports merchant_defined_data1..100, but
 * explicitly prohibits PII in those fields. Only non-personal operational
 * context is emitted here. Raw PMS/OTA confirmation numbers remain in our
 * audit snapshot; the signed reference_number is the supported order lookup.
 */
const buildHostedMerchantDefinedData = (context = {}) => {
	const stay = [context.check_in_date, context.check_out_date]
		.filter(Boolean)
		.join("/");
	const otaHash = clean(context.ota_confirmation_sha256_16, 16);
	const outboundHotelName =
		cleanOutboundAscii(context.hotel_name, 90) || "UNSPECIFIED";
	const reportingFields = {
		merchant_defined_data1: "OTA_VIRTUAL_CARD",
		merchant_defined_data2: cleanOutboundAscii(
			`OTA=${context.ota_name || "Other OTA"}`,
			100,
		),
		merchant_defined_data3: cleanOutboundAscii(
			`HOTEL=${outboundHotelName}`,
			100,
		),
		merchant_defined_data4: cleanOutboundAscii(
			[`STAY=${stay || "UNSPECIFIED"}`, otaHash ? `OTA_REF_SHA256=${otaHash}` : ""]
				.filter(Boolean)
				.join(";"),
			100,
		),
	};
	return {
		...reportingFields,
		// Fields 5-100 are passed to Decision Manager. Repeat the same non-PII
		// operational context so the fraud engine recognizes intentional OTA VCCs.
		merchant_defined_data5: reportingFields.merchant_defined_data1,
		merchant_defined_data6: reportingFields.merchant_defined_data2,
		merchant_defined_data7: reportingFields.merchant_defined_data3,
		merchant_defined_data8: reportingFields.merchant_defined_data4,
	};
};

module.exports = {
	buildBankReferenceNumber,
	buildHostedMerchantDefinedData,
	buildReservationPaymentContext,
	resolveOtaConfirmationNumber,
	shortHash,
	toIsoDate,
};
