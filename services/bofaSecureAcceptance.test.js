"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
	buildHostedCheckoutFields,
	classifyReply,
	parseReply,
	resignHostedCheckoutFields,
	resumableHostedCheckoutFields,
	resolveConfig,
	signFields,
	verifySignature,
} = require("./bofaSecureAcceptance");

const config = {
	profileId: "11111111-2222-4333-8444-555555555555",
	accessKey: "access-key-1234567890",
	secretKey: "unit-test-secret-value-1234567890",
};

test("builds an embedded HPP sale without any card data", () => {
	const runtime = resolveConfig({
		NODE_ENV: "production",
		BOFA_SA_ENV: "live",
		BOFA_SA_PROFILE_ID: config.profileId,
		BOFA_SA_ACCESS_KEY: config.accessKey,
		BOFA_SA_SECRET_KEY: config.secretKey,
		BOFA_SA_APP_ORIGIN: "https://xhotelpro.com",
	});
	assert.equal(
		runtime.endpointUrl,
		"https://secureacceptance.merchant-services.bankofamerica.com/embedded/pay",
	);
	assert.equal(runtime.sessionTtlMs, 14 * 60 * 1000);
	const fields = buildHostedCheckoutFields({
		config: { ...runtime, ...config },
		referenceNumber: "JB-RESERVATION-1",
		transactionUuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
		amountUsd: 125.5,
		billTo: { firstName: "Agoda", lastName: "VirtualCard", country: "SG" },
		merchantDefinedData: {
			merchant_defined_data1: "OTA_VIRTUAL_CARD",
			merchant_defined_data2: "OTA=Agoda",
		},
	});
	assert.equal(fields.transaction_type, "sale");
	assert.equal(fields.currency, "USD");
	assert.equal(fields.amount, "125.50");
	assert.equal(fields.payment_method, "card");
	assert.equal(fields.card_number, undefined);
	assert.equal(fields.card_cvn, undefined);
	assert.equal(fields.card_expiry_date, undefined);
	assert.equal(fields.unsigned_field_names, undefined);
	assert.ok(fields.signed_field_names.includes("amount"));
	assert.ok(fields.signed_field_names.includes("bill_to_forename"));
	assert.equal(fields.merchant_defined_data1, "OTA_VIRTUAL_CARD");
	assert.ok(fields.signed_field_names.includes("merchant_defined_data1"));
	assert.equal(verifySignature(fields, config.secretKey).ok, true);

	const tampered = { ...fields, amount: "1.00" };
	assert.equal(verifySignature(tampered, config.secretKey).ok, false);
});

test("accepts only a signed full approval and rejects partial approval as charged", () => {
	const response = signFields(
		{
			decision: "ACCEPT",
			reason_code: "100",
			req_reference_number: "JB-RESERVATION-1",
			req_transaction_uuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
			req_amount: "125.50",
			req_currency: "USD",
			req_transaction_type: "sale",
			transaction_id: "transaction-1",
		},
		config.secretKey,
	);
	const verification = verifySignature(response, config.secretKey);
	assert.equal(verification.ok, true);
	const reply = parseReply(response, verification.names);
	assert.equal(reply.validRequiredFields, true);
	assert.deepEqual(classifyReply(reply), {
		status: "accepted",
		final: true,
		charged: true,
	});

	const partialResponse = signFields(
		{ ...response, reason_code: "110", signature: undefined },
		config.secretKey,
	);
	const partial = parseReply(
		partialResponse,
		verifySignature(partialResponse, config.secretKey).names,
	);
	assert.equal(classifyReply(partial).charged, false);
	assert.equal(classifyReply(partial).status, "review");
});

test("resumes the same hosted transaction without storing or adding card data", () => {
	const original = buildHostedCheckoutFields({
		config,
		referenceNumber: "JB-RESUME-1",
		transactionUuid: "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff",
		amountUsd: 10,
		billTo: { postalCode: "92376", country: "US" },
		merchantDefinedData: { merchant_defined_data1: "OTA_VIRTUAL_CARD" },
	});
	const stored = resumableHostedCheckoutFields({
		...original,
		card_number: "4111111111111111",
		card_cvn: "123",
	});
	assert.equal(stored.signature, undefined);
	assert.equal(stored.signed_field_names, undefined);
	assert.equal(stored.card_number, undefined);
	assert.equal(stored.card_cvn, undefined);

	const resumed = resignHostedCheckoutFields(
		stored,
		config.secretKey,
		new Date("2026-07-24T01:30:00.000Z"),
	);
	assert.equal(resumed.reference_number, original.reference_number);
	assert.equal(resumed.transaction_uuid, original.transaction_uuid);
	assert.equal(resumed.amount, "10.00");
	assert.equal(resumed.bill_to_address_postal_code, "92376");
	assert.equal(resumed.signed_date_time, "2026-07-24T01:30:00Z");
	assert.equal(verifySignature(resumed, config.secretKey).ok, true);
});
