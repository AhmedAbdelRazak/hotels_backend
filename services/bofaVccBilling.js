"use strict";

/**
 * Server-owned billing identities for OTA virtual cards.
 *
 * Bank of America requires billTo fields for REST sale requests. The browser
 * must never choose or override them: the provider comes from the persisted
 * reservation and this module supplies the corresponding server profile.
 * Every field can be overridden in the server environment if an OTA/issuer
 * provides a different billing identity for this merchant account.
 */

const PROVIDER_DEFAULTS = Object.freeze({
	expedia: Object.freeze({
		profileId: "expedia-us-v1",
		label: "Expedia",
		firstName: "Expedia",
		lastName: "VirtualCard",
		address1: "1111 Expedia Group Way W",
		locality: "Seattle",
		administrativeArea: "WA",
		postalCode: "98119",
		country: "US",
	}),
	agoda: Object.freeze({
		profileId: "agoda-sg-v1",
		label: "Agoda",
		firstName: "Agoda",
		lastName: "VirtualCard",
		address1: "30 Cecil Street",
		locality: "Singapore",
		administrativeArea: "Singapore",
		postalCode: "049712",
		country: "SG",
	}),
	booking: Object.freeze({
		profileId: "booking-nl-v1",
		label: "Booking.com",
		firstName: "Booking.com",
		lastName: "VirtualCard",
		address1: "Oosterdokskade 163",
		locality: "Amsterdam",
		administrativeArea: "NH",
		postalCode: "1011 DL",
		country: "NL",
	}),
});

const PROFILE_ENV_FIELDS = Object.freeze({
	firstName: "FIRST_NAME",
	lastName: "LAST_NAME",
	address1: "ADDRESS1",
	locality: "LOCALITY",
	administrativeArea: "ADMIN_AREA",
	postalCode: "POSTAL_CODE",
	country: "COUNTRY",
	email: "EMAIL",
	phoneNumber: "PHONE",
});

const clean = (value, max = 255) =>
	String(value == null ? "" : value)
		.trim()
		.replace(/\s+/g, " ")
		.slice(0, max);

const resolveVccProvider = (bookingSource) => {
	const source = clean(bookingSource).toLowerCase();
	if (source.includes("expedia")) return "expedia";
	if (source.includes("agoda")) return "agoda";
	if (
		source.includes("booking.com") ||
		source === "booking"
	)
		return "booking";
	return "other";
};

const providerLabel = (provider) =>
	PROVIDER_DEFAULTS[provider]?.label || "Unsupported OTA";

const resolveServerBillingProfile = (
	provider,
	{ env = process.env } = {},
) => {
	const defaults = PROVIDER_DEFAULTS[provider];
	if (!defaults) {
		return {
			ok: false,
			issue: "BOFA_VCC_UNSUPPORTED_OTA",
			message:
				"Bank of America virtual-card processing is available only for Expedia, Agoda, and Booking.com reservations.",
			provider,
		};
	}

	const prefix = `BOFA_VCC_${provider.toUpperCase()}_BILLING`;
	let environmentOverride = false;
	const valueFor = (field, max) => {
		const envKey = `${prefix}_${PROFILE_ENV_FIELDS[field]}`;
		const override = clean(env?.[envKey], max);
		if (override) environmentOverride = true;
		return override || clean(defaults[field], max);
	};

	const fallbackEmail =
		clean(env?.BOFA_VCC_FALLBACK_EMAIL, 255) || "support@jannatbooking.com";
	const phoneNumber = valueFor("phoneNumber", 20);
	const billTo = {
		firstName: valueFor("firstName", 60),
		lastName: valueFor("lastName", 60),
		address1: valueFor("address1", 60),
		locality: valueFor("locality", 50),
		administrativeArea: valueFor("administrativeArea", 20),
		postalCode: valueFor("postalCode", 14).toUpperCase(),
		country: valueFor("country", 2).toUpperCase(),
		email: valueFor("email", 255) || fallbackEmail,
		...(phoneNumber ? { phoneNumber } : {}),
	};

	const required = [
		["cardholder first name", billTo.firstName],
		["cardholder last name", billTo.lastName],
		["address line 1", billTo.address1],
		["city/locality", billTo.locality],
		["state/administrative area", billTo.administrativeArea],
		["postal code", billTo.postalCode],
		["two-letter country code", billTo.country],
		["email", billTo.email],
	];
	const missing = required
		.filter(([, value]) => !clean(value))
		.map(([label]) => label);

	if (missing.length > 0 || !/^[A-Z]{2}$/.test(billTo.country)) {
		return {
			ok: false,
			issue: "BOFA_VCC_SERVER_BILLING_PROFILE_INVALID",
			message:
				missing.length > 0
					? `The server billing profile for ${defaults.label} is incomplete: ${missing.join(
							", ",
					  )}. No charge was sent.`
					: `The server billing profile for ${defaults.label} has an invalid country code. No charge was sent.`,
			provider,
		};
	}

	return {
		ok: true,
		provider,
		label: defaults.label,
		profileId: defaults.profileId,
		source: environmentOverride ? "environment_override" : "built_in",
		billTo,
	};
};

module.exports = {
	PROVIDER_DEFAULTS,
	resolveVccProvider,
	providerLabel,
	resolveServerBillingProfile,
};
