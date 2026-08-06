/** @format */

"use strict";

const mongoose = require("mongoose");
const { decryptWithSecret } = require("../controllers/utils");

const PROCESSOR_FIELDS = Object.freeze([
	"payment_details",
	"paypal_details",
	"vcc_payment",
	"braintree_payment",
	"bofa_payment",
]);

const CUSTOMER_SAFE_KEYS = new Set([
	"booking_source",
	"carColor",
	"carLicensePlate",
	"carModel",
	"carYear",
	"confirmation_number2",
	"copyNumber",
	"email",
	"hasCar",
	"name",
	"nationality",
	"passport",
	"passportExpiry",
	"phone",
	"postalCode",
]);

// Processor objects are mixed-schema blobs. Expose only explicit display and
// status values so a new gateway spelling cannot accidentally reveal secrets.
const PROCESSOR_SAFE_KEYS = new Set([
	"amount",
	"amountsar",
	"amountusd",
	"bofasaaccepted",
	"bofavcccharged",
	"bofavccchargedat",
	"bofavcctransactionid",
	"captured",
	"capturedat",
	"capturedtotalsar",
	"capturedtotalusd",
	"captureid",
	"capturestatus",
	"cardlast4",
	"chargecount",
	"charged",
	"commissionpaid",
	"currency",
	"decision",
	"evidence",
	"finalcapturetransactionid",
	"gateway",
	"grossamountusd",
	"invoiceid",
	"lastattemptat",
	"lastchargeat",
	"lastchargevia",
	"lastresponsesignaturevalid",
	"lastsuccessat",
	"lasttransactionid",
	"limitusd",
	"onsitepaidamount",
	"pendingtotalsar",
	"pendingtotalusd",
	"processing",
	"provider",
	"reasoncode",
	"referencenumber",
	"source",
	"state",
	"status",
	"totalcapturedsar",
	"totalcapturedusd",
	"transactionat",
	"transactionid",
	"vcccaptureid",
	"vcccharged",
	"verified",
]);

const PROCESSOR_SAFE_CONTAINERS = new Set([
	"bounds",
	"externalvirtualterminal",
	"initial",
	"lastcapture",
	"metadata",
	"secureacceptance",
	"vcc",
]);

const toPlainObject = (value = {}) =>
	value && typeof value.toObject === "function" ? value.toObject() : value || {};

const normalizedKey = (value = "") =>
	String(value || "")
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "");

const isSensitiveKey = (key) => {
	const normalized = normalizedKey(key);
	return Boolean(
		/(?:token|secret|credential|password|passphrase|authorization|signature|nonce|cookie|vault|lock)/.test(
			normalized
		) ||
			/(?:^pan$|cvv|cvc|securitycode|cardnumber|cardexpiry|cardexpiration|cardholder)/.test(
				normalized
			) ||
			/(?:rawrequest|rawresponse|lastresponsepayload|requestheaders|responseheaders)/.test(
				normalized
			)
	);
};

const stripSensitiveKeys = (value) => {
	if (Array.isArray(value)) return value.map(stripSensitiveKeys);
	if (!value || typeof value !== "object") return value;
	if (value instanceof Date || value instanceof mongoose.Types.ObjectId) return value;
	const plain = toPlainObject(value);
	const prototype = Object.getPrototypeOf(plain);
	if (prototype !== Object.prototype && prototype !== null) return plain;
	return Object.fromEntries(
		Object.entries(plain)
			.filter(([key]) => !isSensitiveKey(key))
			.map(([key, nestedValue]) => [key, stripSensitiveKeys(nestedValue)])
	);
};

const processorSummary = (value) => {
	const plain = toPlainObject(value);
	if (!plain || typeof plain !== "object" || Array.isArray(plain)) return {};
	const result = {};
	for (const [key, nestedValue] of Object.entries(plain)) {
		const normalized = normalizedKey(key);
		if (PROCESSOR_SAFE_KEYS.has(normalized)) {
			if (
				nestedValue === null ||
				["string", "number", "boolean"].includes(typeof nestedValue)
			) {
				result[key] = nestedValue;
			}
			continue;
		}
		if (PROCESSOR_SAFE_CONTAINERS.has(normalized)) {
			result[key] = processorSummary(nestedValue);
		}
	}
	return result;
};

const maskedEncryptedCardNumber = (encryptedValue) => {
	if (typeof encryptedValue !== "string" || !encryptedValue.includes(":")) {
		return "";
	}
	try {
		const decrypted = decryptWithSecret(encryptedValue);
		if (!decrypted || decrypted.length < 4) return "";
		return `${"*".repeat(decrypted.length - 4)}${decrypted.slice(-4)}`;
	} catch {
		return "";
	}
};

function buildSafeLegacyLocalReservationPayload(reservation = {}) {
	const plainReservation = toPlainObject(reservation);
	const ordinaryReservation = { ...plainReservation };
	delete ordinaryReservation.customer_details;
	for (const field of PROCESSOR_FIELDS) delete ordinaryReservation[field];
	const safeReservation = stripSensitiveKeys(ordinaryReservation);
	const rawCustomerDetails = toPlainObject(plainReservation.customer_details);
	const customerDetails = Object.fromEntries(
		Object.entries(rawCustomerDetails || {}).filter(([key]) =>
			CUSTOMER_SAFE_KEYS.has(key)
		)
	);
	const maskedCardNumber = maskedEncryptedCardNumber(
		rawCustomerDetails.cardNumber
	);
	if (maskedCardNumber) customerDetails.cardNumber = maskedCardNumber;
	safeReservation.customer_details = customerDetails;

	for (const field of PROCESSOR_FIELDS) {
		if (!Object.prototype.hasOwnProperty.call(plainReservation, field)) continue;
		safeReservation[field] = processorSummary(plainReservation[field]);
	}
	return safeReservation;
}

module.exports = { buildSafeLegacyLocalReservationPayload };
