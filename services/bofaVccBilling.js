"use strict";

/**
 * Server-owned billing identities for OTA virtual cards.
 *
 * Bank of America requires billTo data for REST sale requests. Expedia and
 * Agoda use server-owned profiles selected from the persisted reservation.
 * Every other OTA may supply only a postal code; names, email, and country
 * remain server-owned, and street/city/state are deliberately omitted.
 */

const PROVIDER_DEFAULTS = Object.freeze({
	expedia: Object.freeze({
		profileId: "expedia-us-v1",
		label: "Expedia",
		firstName: "Expedia",
		lastName: "VirtualCard",
		companyName: "Expedia Group",
		address1: "1111 Expedia Group Way W",
		locality: "Seattle",
		administrativeArea: "WA",
		postalCode: "98119",
		country: "US",
	}),
	agoda: Object.freeze({
		profileId: "agoda-sg-v2",
		label: "Agoda",
		firstName: "Agoda Company",
		lastName: "Pte Ltd.",
		companyName: "Agoda Company Pte Ltd.",
		address1: "30 Cecil Street",
		locality: "Singapore",
		administrativeArea: "Singapore",
		postalCode: "049712",
		country: "SG",
	}),
});

const PROVIDER_LABELS = Object.freeze({
	expedia: "Expedia",
	agoda: "Agoda",
	booking: "Booking.com",
	other: "Other OTA",
});

const PROFILE_ENV_FIELDS = Object.freeze({
	firstName: "FIRST_NAME",
	lastName: "LAST_NAME",
	companyName: "COMPANY_NAME",
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

const normalizePostalCode = (value) => clean(value, 14).toUpperCase();

const isValidPostalCode = (value) => {
	const postalCode = normalizePostalCode(value);
	return (
		postalCode.length >= 3 &&
		postalCode.length <= 14 &&
		/^[A-Z0-9](?:[A-Z0-9 -]*[A-Z0-9])?$/.test(postalCode)
	);
};

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

const providerLabel = (provider) => PROVIDER_LABELS[provider] || "Other OTA";

const resolveServerBillingProfile = (
	provider,
	{ env = process.env, postalCode: suppliedPostalCode = "" } = {},
) => {
	const defaults = PROVIDER_DEFAULTS[provider];
	if (!defaults) {
		const postalCode = normalizePostalCode(suppliedPostalCode);
		if (!postalCode) {
			return {
				ok: false,
				issue: "BOFA_VCC_POSTAL_CODE_REQUIRED",
				message:
					"Enter the ZIP / postal code provided for this virtual card. No charge was sent.",
				provider,
			};
		}
		if (!isValidPostalCode(postalCode)) {
			return {
				ok: false,
				issue: "BOFA_VCC_POSTAL_CODE_INVALID",
				message:
					"Enter a valid ZIP / postal code using 3 to 14 letters, numbers, spaces, or hyphens. No charge was sent.",
				provider,
			};
		}

		const prefix = `BOFA_VCC_${
			provider === "booking" ? "BOOKING" : "OTHER"
		}_BILLING`;
		const fallbackEmail =
			clean(env?.BOFA_VCC_FALLBACK_EMAIL, 255) ||
			"ahmed.abdelrazak@jannatbooking.com";
		const defaultLabel = providerLabel(provider);
		const firstName =
			clean(env?.[`${prefix}_FIRST_NAME`], 60) ||
			(provider === "booking" ? "Booking.com" : "OTA");
		const lastName =
			clean(env?.[`${prefix}_LAST_NAME`], 60) || "VirtualCard";
		const country = (
			clean(env?.[`${prefix}_COUNTRY`]) ||
			(provider === "booking" ? "NL" : "US")
		).toUpperCase();
		const email = clean(env?.[`${prefix}_EMAIL`], 255) || fallbackEmail;

		if (!/^[A-Z]{2}$/.test(country)) {
			return {
				ok: false,
				issue: "BOFA_VCC_SERVER_BILLING_PROFILE_INVALID",
				message: `The server billing profile for ${defaultLabel} has an invalid country code. No charge was sent.`,
				provider,
			};
		}

		return {
			ok: true,
			provider,
			label: defaultLabel,
			profileId: `${provider === "booking" ? "booking" : "other"}-postal-v1`,
			source: "browser_postal_only",
			billTo: {
				firstName,
				lastName,
				postalCode,
				country,
				email,
			},
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
		clean(env?.BOFA_VCC_FALLBACK_EMAIL, 255) ||
		"ahmed.abdelrazak@jannatbooking.com";
	const phoneNumber = valueFor("phoneNumber", 20);
	const billTo = {
		firstName: valueFor("firstName", 60),
		lastName: valueFor("lastName", 60),
		companyName: valueFor("companyName", 60),
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
	PROVIDER_LABELS,
	isValidPostalCode,
	normalizePostalCode,
	resolveVccProvider,
	providerLabel,
	resolveServerBillingProfile,
};
