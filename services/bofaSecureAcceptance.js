"use strict";

const crypto = require("crypto");

const HPP_ENDPOINTS = Object.freeze({
	test: "https://testsecureacceptance.merchant-services.bankofamerica.com/embedded/pay",
	live: "https://secureacceptance.merchant-services.bankofamerica.com/embedded/pay",
});

const clean = (value, max = 255) =>
	String(value == null ? "" : value)
		.trim()
		.slice(0, max);

const money = (value) => Number(value || 0).toFixed(2);

const csv = (value) =>
	String(value || "")
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);

const resolveEnvironment = (env = process.env) => {
	const configured = clean(env.BOFA_SA_ENV).toLowerCase();
	if (["live", "prod", "production"].includes(configured)) return "live";
	if (["test", "sandbox", "stage", "staging"].includes(configured)) return "test";
	return clean(env.NODE_ENV).toLowerCase() === "production" ? "live" : "test";
};

const resolveConfig = (env = process.env) => {
	const environment = resolveEnvironment(env);
	// Secure Acceptance reason code 104 documents duplicate detection for the
	// same access key + transaction UUID within 15 minutes. Keep every resumable
	// form inside that provider window and never extend it when the form resumes.
	const sessionTtlCandidate = Number(env.BOFA_SA_SESSION_TTL_MS || 14 * 60 * 1000);
	const sessionTtlMs = Number.isFinite(sessionTtlCandidate)
		? Math.min(Math.max(sessionTtlCandidate, 5 * 60 * 1000), 14 * 60 * 1000)
		: 14 * 60 * 1000;
	const appOrigin = clean(
		env.BOFA_SA_APP_ORIGIN ||
			(environment === "live" ? "https://xhotelpro.com" : "http://localhost:3000"),
		255,
	).replace(/\/$/, "");

	return {
		environment,
		endpointUrl: HPP_ENDPOINTS[environment],
		profileId: clean(env.BOFA_SA_PROFILE_ID, 64),
		accessKey: clean(env.BOFA_SA_ACCESS_KEY, 128),
		secretKey: clean(env.BOFA_SA_SECRET_KEY, 512),
		appOrigin,
		sessionTtlMs,
	};
};

const validateConfig = (config) => {
	const errors = [];
	const warnings = [];
	if (!config.profileId) errors.push("BOFA_SA_PROFILE_ID is missing.");
	if (!config.accessKey) errors.push("BOFA_SA_ACCESS_KEY is missing.");
	if (!config.secretKey) errors.push("BOFA_SA_SECRET_KEY is missing.");
	if (
		config.profileId &&
		!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
			config.profileId,
		)
	) {
		errors.push("BOFA_SA_PROFILE_ID must be the UUID shown in the Secure Acceptance profile.");
	}
	if (config.accessKey && config.accessKey.length < 16) {
		errors.push("BOFA_SA_ACCESS_KEY is not structurally valid.");
	}
	if (config.secretKey && config.secretKey.length < 16) {
		errors.push("BOFA_SA_SECRET_KEY is not structurally valid.");
	}
	try {
		const parsed = new URL(config.appOrigin);
		if (parsed.protocol !== "https:" && config.environment === "live") {
			errors.push("BOFA_SA_APP_ORIGIN must use HTTPS in production.");
		}
	} catch (_error) {
		errors.push("BOFA_SA_APP_ORIGIN is invalid.");
	}
	if (config.environment === "test") {
		warnings.push("Secure Acceptance is configured for the test environment.");
	}
	return { ok: errors.length === 0, errors, warnings };
};

const hmacBase64 = (secret, data) =>
	crypto.createHmac("sha256", secret).update(data, "utf8").digest("base64");

const dataToSign = (payload, names) =>
	names.map((name) => `${name}=${payload[name] ?? ""}`).join(",");

const signFields = (inputFields, secretKey) => {
	const fields = { ...inputFields };
	const signedNames = Object.keys(fields)
		.filter((name) => name !== "signature" && name !== "signed_field_names")
		.concat("signed_field_names");
	fields.signed_field_names = signedNames.join(",");
	fields.signature = hmacBase64(secretKey, dataToSign(fields, signedNames));
	return fields;
};

const resumableHostedCheckoutFields = (fields = {}) => {
	const allowed = /^(?:access_key|profile_id|transaction_uuid|signed_date_time|reference_number|transaction_type|amount|currency|locale|payment_method|bill_to_(?:forename|surname|company_name|email|phone|address_line1|address_city|address_state|address_postal_code|address_country)|merchant_defined_data[1-8])$/;
	return Object.fromEntries(
		Object.entries(fields)
			.filter(([name]) => allowed.test(name))
			.map(([name, value]) => [name, clean(value, 1000)]),
	);
};

const resignHostedCheckoutFields = (fields, secretKey, now = new Date()) => {
	const resumable = resumableHostedCheckoutFields(fields);
	resumable.signed_date_time = now.toISOString().replace(/\.\d{3}Z$/, "Z");
	return signFields(resumable, secretKey);
};

const verifySignature = (payload, secretKey) => {
	const names = csv(payload?.signed_field_names);
	const provided = clean(payload?.signature, 256);
	if (!secretKey || !names.length || !provided) {
		return { ok: false, names, reason: "Missing signed response fields." };
	}
	if (new Set(names).size !== names.length) {
		return { ok: false, names, reason: "Duplicate signed response fields." };
	}
	const expected = hmacBase64(secretKey, dataToSign(payload, names));
	const expectedBuffer = Buffer.from(expected, "utf8");
	const providedBuffer = Buffer.from(provided, "utf8");
	const ok =
		expectedBuffer.length === providedBuffer.length &&
		crypto.timingSafeEqual(expectedBuffer, providedBuffer);
	return { ok, names, reason: ok ? "" : "Response signature mismatch." };
};

const addIfPresent = (target, name, value, max) => {
	const normalized = clean(value, max);
	if (normalized) target[name] = normalized;
};

const buildHostedCheckoutFields = ({
	config,
	referenceNumber,
	transactionUuid,
	amountUsd,
	billTo = {},
	merchantDefinedData = {},
}) => {
	const fields = {
		access_key: config.accessKey,
		profile_id: config.profileId,
		transaction_uuid: transactionUuid,
		signed_date_time: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
		signed_field_names: "",
		reference_number: clean(referenceNumber, 50),
		transaction_type: "sale",
		amount: money(amountUsd),
		currency: "USD",
		locale: "en-us",
		payment_method: "card",
	};

	addIfPresent(fields, "bill_to_forename", billTo.firstName, 60);
	addIfPresent(fields, "bill_to_surname", billTo.lastName, 60);
	addIfPresent(fields, "bill_to_company_name", billTo.companyName, 60);
	addIfPresent(fields, "bill_to_email", billTo.email, 255);
	addIfPresent(fields, "bill_to_phone", billTo.phoneNumber, 20);
	addIfPresent(fields, "bill_to_address_line1", billTo.address1, 60);
	addIfPresent(fields, "bill_to_address_city", billTo.locality, 50);
	addIfPresent(
		fields,
		"bill_to_address_state",
		billTo.administrativeArea,
		20,
	);
	addIfPresent(fields, "bill_to_address_postal_code", billTo.postalCode, 14);
	addIfPresent(
		fields,
		"bill_to_address_country",
		clean(billTo.country, 2).toUpperCase(),
		2,
	);
	for (let index = 1; index <= 8; index += 1) {
		addIfPresent(
			fields,
			`merchant_defined_data${index}`,
			merchantDefinedData?.[`merchant_defined_data${index}`],
			100,
		);
	}

	return signFields(fields, config.secretKey);
};

const chooseReplyField = (payload, names, candidates) => {
	for (const name of candidates) {
		if (Object.prototype.hasOwnProperty.call(payload || {}, name)) {
			return { name, value: clean(payload[name], 1000), signed: names.includes(name) };
		}
	}
	return { name: "", value: "", signed: false };
};

const parseReply = (payload, signedNames = csv(payload?.signed_field_names)) => {
	const pick = (...names) => chooseReplyField(payload, signedNames, names);
	const decision = pick("decision");
	const reasonCode = pick("reason_code");
	const referenceNumber = pick("req_reference_number", "reference_number");
	const transactionUuid = pick("req_transaction_uuid", "transaction_uuid");
	const amount = pick("req_amount", "amount");
	const currency = pick("req_currency", "currency");
	const transactionType = pick("req_transaction_type", "transaction_type");
	const transactionId = pick("transaction_id", "request_id", "req_request_id");
	const reconciliationId = pick("reconciliation_id");
	const cardNumber = pick("req_card_number", "card_number");
	const authAmount = pick("auth_amount");
	const message = pick("message");

	const required = [
		decision,
		reasonCode,
		referenceNumber,
		transactionUuid,
		amount,
		currency,
		transactionType,
	];
	const missingSigned = required
		.filter((field) => !field.name || !field.signed)
		.map((field) => field.name || "missing");
	const numericAmount = Number(amount.value);
	const numericAuthAmount = authAmount.value ? Number(authAmount.value) : null;
	const digits = cardNumber.value.replace(/\D/g, "");

	return {
		validRequiredFields: missingSigned.length === 0,
		missingSigned,
		decision: decision.value.toUpperCase(),
		reasonCode: reasonCode.value,
		referenceNumber: referenceNumber.value,
		transactionUuid: transactionUuid.value,
		amountUsd: Number.isFinite(numericAmount) ? numericAmount : null,
		authAmountUsd: Number.isFinite(numericAuthAmount) ? numericAuthAmount : null,
		currency: currency.value.toUpperCase(),
		transactionType: transactionType.value.toLowerCase(),
		transactionId: transactionId.value,
		reconciliationId: reconciliationId.value,
		cardLast4: digits.length >= 4 ? digits.slice(-4) : "",
		message: message.value,
	};
};

const classifyReply = (reply) => {
	if (reply.decision === "ACCEPT" && reply.reasonCode === "100") {
		return { status: "accepted", final: true, charged: true };
	}
	if (reply.decision === "CANCEL") {
		return { status: "canceled", final: true, charged: false };
	}
	if (reply.decision === "DECLINE") {
		return { status: "declined", final: true, charged: false };
	}
	if (reply.decision === "REVIEW" || reply.decision === "ACCEPT") {
		return { status: "review", final: false, charged: false };
	}
	if (reply.decision === "ERROR") {
		return { status: "error", final: false, charged: false };
	}
	return { status: "unknown", final: false, charged: false };
};

const safeReplyAudit = (reply) => ({
	decision: reply.decision,
	reason_code: reply.reasonCode,
	reference_number: reply.referenceNumber,
	transaction_uuid: reply.transactionUuid,
	transaction_id: reply.transactionId,
	reconciliation_id: reply.reconciliationId,
	amount_usd: reply.amountUsd,
	auth_amount_usd: reply.authAmountUsd,
	currency: reply.currency,
	transaction_type: reply.transactionType,
	card_last4: reply.cardLast4,
	message: clean(reply.message, 600),
});

const declineDisplayMessage = (reply = {}) => {
	const reasonCode = clean(reply.reasonCode, 20);
	const processorMessage = clean(reply.message, 300);
	if (reasonCode === "203") {
		return "The card issuer hard-declined this OTA virtual card for this merchant (code 203: Invalid merchant). No charge was recorded. Confirm with Agoda or Expedia that the card is enabled for this hotel's Bank of America merchant account before using the remaining retry, or use a different virtual card.";
	}
	return processorMessage || "Bank of America declined this card.";
};

module.exports = {
	HPP_ENDPOINTS,
	buildHostedCheckoutFields,
	classifyReply,
	declineDisplayMessage,
	dataToSign,
	hmacBase64,
	parseReply,
	resignHostedCheckoutFields,
	resumableHostedCheckoutFields,
	resolveConfig,
	safeReplyAudit,
	signFields,
	validateConfig,
	verifySignature,
};
