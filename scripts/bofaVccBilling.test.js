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

test("server billing profiles are complete for supported OTA providers", () => {
	for (const provider of ["expedia", "agoda", "booking"]) {
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
	assert.deepEqual(
		{
			postalCode: resolveServerBillingProfile("booking", { env: {} }).billTo
				.postalCode,
			country: resolveServerBillingProfile("booking", { env: {} }).billTo.country,
		},
		{ postalCode: "1011 DL", country: "NL" },
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
});

test("unsupported booking sources fail closed before gateway submission", () => {
	const profile = resolveServerBillingProfile("other", { env: {} });
	assert.equal(profile.ok, false);
	assert.equal(profile.issue, "BOFA_VCC_UNSUPPORTED_OTA");
	assert.match(profile.message, /Expedia, Agoda, and Booking\.com/i);
});

test("the charge controller cannot consume browser billing overrides", () => {
	const controllerSource = fs.readFileSync(
		path.join(__dirname, "..", "controllers", "bofaprocessing.js"),
		"utf8",
	);
	assert.doesNotMatch(
		controllerSource,
		/req\.body\?\.(?:billingAddress|postalCode|cardholderName|confirmationNumber2)/,
	);
	assert.doesNotMatch(controllerSource, /card_expiry\s*:/);
	assert.ok(
		controllerSource.indexOf("if (!billingProfile.ok)") <
			controllerSource.indexOf("Atomically reserve this reservation"),
		"billing profile validation must occur before the payment lock and gateway path",
	);
});
