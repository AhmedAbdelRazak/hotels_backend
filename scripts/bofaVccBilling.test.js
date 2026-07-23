"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
	resolveVccProvider,
	resolveServerBillingProfile,
} = require("../services/bofaVccBilling");

test("OTA provider resolution does not mistake Jannat Booking for Booking.com", () => {
	assert.equal(resolveVccProvider("Expedia Collect"), "expedia");
	assert.equal(resolveVccProvider("Agoda"), "agoda");
	assert.equal(resolveVccProvider("Booking.com"), "booking");
	assert.equal(resolveVccProvider("Online Jannat Booking"), "other");
});

test("Expedia and Agoda use complete server-owned billing profiles", () => {
	for (const provider of ["expedia", "agoda"]) {
		const profile = resolveServerBillingProfile(provider, { env: {} });
		assert.equal(profile.ok, true);
		assert.equal(profile.provider, provider);
		assert.match(profile.billTo.country, /^[A-Z]{2}$/);
		assert.ok(profile.billTo.address1);
		assert.ok(profile.billTo.locality);
		assert.ok(profile.billTo.administrativeArea);
		assert.ok(profile.billTo.postalCode);
		assert.ok(profile.billTo.email);
	}
	assert.deepEqual(
		{
			postalCode: resolveServerBillingProfile("expedia", { env: {} }).billTo
				.postalCode,
			country: resolveServerBillingProfile("expedia", { env: {} }).billTo.country,
		},
		{ postalCode: "98119", country: "US" },
	);
	assert.deepEqual(
		{
			postalCode: resolveServerBillingProfile("agoda", { env: {} }).billTo
				.postalCode,
			country: resolveServerBillingProfile("agoda", { env: {} }).billTo.country,
		},
		{ postalCode: "049712", country: "SG" },
	);
});

test("server environment can override an issuer-specific profile", () => {
	const profile = resolveServerBillingProfile("agoda", {
		env: {
			BOFA_VCC_AGODA_BILLING_POSTAL_CODE: "99999",
			BOFA_VCC_AGODA_BILLING_COUNTRY: "US",
			BOFA_VCC_AGODA_BILLING_EMAIL: "payments@example.com",
		},
	});
	assert.equal(profile.ok, true);
	assert.equal(profile.source, "environment_override");
	assert.equal(profile.billTo.postalCode, "99999");
	assert.equal(profile.billTo.country, "US");
	assert.equal(profile.billTo.email, "payments@example.com");

	const ignoredBrowserOverride = resolveServerBillingProfile("agoda", {
		env: {},
		postalCode: "00000",
	});
	assert.equal(ignoredBrowserOverride.billTo.postalCode, "049712");
});

test("non-Expedia/Agoda providers require a validated postal code only", () => {
	const missing = resolveServerBillingProfile("other", { env: {} });
	assert.equal(missing.ok, false);
	assert.equal(missing.issue, "BOFA_VCC_POSTAL_CODE_REQUIRED");

	const invalid = resolveServerBillingProfile("other", {
		env: {},
		postalCode: "<script>",
	});
	assert.equal(invalid.ok, false);
	assert.equal(invalid.issue, "BOFA_VCC_POSTAL_CODE_INVALID");

	const profile = resolveServerBillingProfile("other", {
		env: { BOFA_VCC_OTHER_BILLING_ADDRESS1: "Must be ignored" },
		postalCode: " 92923-1234 ",
	});
	assert.equal(profile.ok, true);
	assert.equal(profile.source, "browser_postal_only");
	assert.equal(profile.billTo.postalCode, "92923-1234");
	assert.equal(profile.billTo.country, "US");
	assert.equal(profile.billTo.address1, undefined);
	assert.equal(profile.billTo.locality, undefined);
	assert.equal(profile.billTo.administrativeArea, undefined);

	const booking = resolveServerBillingProfile("booking", {
		env: {},
		postalCode: "1011 dl",
	});
	assert.equal(booking.ok, true);
	assert.equal(booking.billTo.postalCode, "1011 DL");
	assert.equal(booking.billTo.country, "NL");
	assert.equal(booking.billTo.address1, undefined);
});

test("the generic server profile rejects an invalid configured country", () => {
	const profile = resolveServerBillingProfile("other", {
		env: { BOFA_VCC_OTHER_BILLING_COUNTRY: "USA" },
		postalCode: "92923",
	});
	assert.equal(profile.ok, false);
	assert.equal(profile.issue, "BOFA_VCC_SERVER_BILLING_PROFILE_INVALID");
});

test("the charge controller cannot consume browser billing overrides", () => {
	const controllerSource = fs.readFileSync(
		path.join(__dirname, "..", "controllers", "bofaprocessing.js"),
		"utf8",
	);
	const captureControllerSource = controllerSource.slice(
		controllerSource.indexOf("exports.captureReservationVccSale"),
	);
	assert.doesNotMatch(
		controllerSource,
		/req\.body\?\.(?:billingAddress|postalCode|cardholderName|confirmationNumber2)/,
	);
	assert.match(controllerSource, /req\.body\?\.billingPostalCode/);
	assert.doesNotMatch(captureControllerSource, /card_expiry\s*:/);
	assert.doesNotMatch(captureControllerSource, /postal_code\s*:/);
	assert.ok(
		controllerSource.indexOf("if (!billingProfile.ok)") <
			controllerSource.indexOf("Atomically reserve this reservation"),
		"billing profile validation must occur before the payment lock and gateway path",
	);
});
