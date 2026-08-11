/** @format */

"use strict";

const crypto = require("crypto");
const { roundedMoneyProduct } = require("./otaMoney");

const CONTRACT_VERSION = 2;
const SUPPORTED_CONTRACT_VERSIONS = new Set([1, CONTRACT_VERSION]);
const MAX_MONEY = 1_000_000_000_000;
const DEFAULT_BOOKING_BASIS = "reservation_total";

const AUTHENTICATED_SOURCE_TYPES = Object.freeze([
	"authenticated_ota_email",
	"authenticated_ota_audit",
	"authenticated_provider_api",
	"authenticated_provider_portal",
]);
const AUTHENTICATED_SOURCE_TYPE_SET = new Set(AUTHENTICATED_SOURCE_TYPES);
const HOTEL_BASE_SOURCE_TYPES = new Set([
	"pms_calendar",
	"pms_root_pricing",
	"property_pricing",
]);
const CONVERSION_SOURCE_TYPES = new Set([
	"provider_explicit_exchange",
	"hotelrunner_payment_exchange",
	"authenticated_exchange_audit",
	"trusted_exchange_evidence",
]);
const HOTELRUNNER_UNRESOLVED_SOURCE_TYPES = new Set([
	"hotelrunner_api",
	"hotelrunner_email_relay",
	"hotelrunner_webhook",
]);
const REPORTED_AMOUNT_ROLES = new Set([
	"unknown",
	"guest_gross",
	"hotel_payout",
]);

const PROVIDER_ALIASES = new Map([
	["agoda", "agoda"],
	["agodacom", "agoda"],
	["expedia", "expedia"],
	["expediacom", "expedia"],
	["booking", "booking"],
	["bookingcom", "booking"],
	["trip", "trip"],
	["tripcom", "trip"],
	["ctrip", "trip"],
	["ctripcom", "trip"],
	["airbnb", "airbnb"],
	["airbnbcom", "airbnb"],
	["hotels", "hotels"],
	["hotelscom", "hotels"],
	["hotelrunner", "hotelrunner"],
	["hotelrunnercom", "hotelrunner"],
]);

const TOP_LEVEL_KEYS = [
	"bookingBasis",
	"contractVersion",
	"currencyConversion",
	"deductionComponents",
	"evidenceHash",
	"hotelRunnerReportedAmount",
	"nightlyEvidence",
	"propertyCurrency",
	"provenance",
	"provider",
	"reconciliation",
	"roles",
	"sourceCurrency",
	"sourceType",
	"verificationState",
];
const ROLE_KEYS = [
	"bookingBasis",
	"evidenceType",
	"propertyAmount",
	"propertyCurrency",
	"sourceAmount",
	"sourceCurrency",
	"sourceRef",
	"verified",
];
const ROLE_NAMES = [
	"guestGross",
	"hotelBase",
	"hotelPayout",
	"deductionAggregate",
	"explicitOtaCommission",
];
const PROVENANCE_KEYS = [
	"provider",
	"sourceHash",
	"sourceId",
	"sourceTimestamp",
	"sourceType",
];
const NIGHTLY_EVIDENCE_KEYS = [
	"deductionAggregate",
	"guestGross",
	"hotelPayout",
	"stayDate",
];
const DEDUCTION_COMPONENT_KEYS = ["amount", "componentType", "direction"];
const DEDUCTION_DIRECTIONS = new Set(["credit", "deduction"]);

class OtaCommercialEvidenceError extends Error {
	constructor(message, code = "OTA_COMMERCIAL_EVIDENCE_INVALID") {
		super(message);
		this.name = "OtaCommercialEvidenceError";
		this.code = code;
	}
}

function fail(message, code) {
	throw new OtaCommercialEvidenceError(message, code);
}

const clean = (value = "") => String(value == null ? "" : value).trim();
const hasOwn = (value, key) =>
	Object.prototype.hasOwnProperty.call(value || {}, key);
const round2 = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;

function isNormalizedMoney(value) {
	return (
		typeof value === "number" &&
		Number.isFinite(value) &&
		value >= 0 &&
		value <= MAX_MONEY &&
		Math.abs(value - round2(value)) < 1e-9
	);
}

function normalizeProvider(value) {
	const raw = clean(value).toLowerCase();
	const compact = raw.replace(/[^a-z0-9]+/g, "");
	if (PROVIDER_ALIASES.has(compact)) return PROVIDER_ALIASES.get(compact);
	// Unknown/future providers must arrive as a machine channel key. Do not
	// turn a fuzzy display label into provider identity.
	if (/^[a-z0-9][a-z0-9_-]{0,63}$/.test(raw)) return raw;
	return "";
}

function normalizeMarker(value, field, code = "INVALID_MARKER") {
	const marker = clean(value).toLowerCase();
	if (!/^[a-z0-9][a-z0-9._:-]{0,95}$/.test(marker)) {
		fail(`${field} must be a bounded machine marker.`, code);
	}
	return marker;
}

function normalizeBasis(value, fallback = DEFAULT_BOOKING_BASIS) {
	return normalizeMarker(value || fallback, "bookingBasis", "INVALID_BOOKING_BASIS");
}

function normalizeCurrency(value, field = "currency") {
	const currency = clean(value).toUpperCase();
	if (!/^[A-Z]{3}$/.test(currency)) {
		fail(`${field} must be an ISO-style three-letter currency.`, "INVALID_CURRENCY");
	}
	return currency;
}

function normalizeMoney(value, field) {
	if (value === null || value === undefined || value === "" || typeof value === "boolean") {
		fail(`${field} must be an explicit finite non-negative amount.`, "INVALID_AMOUNT");
	}
	const numeric = Number(value);
	if (!Number.isFinite(numeric) || numeric < 0 || numeric > MAX_MONEY) {
		fail(`${field} must be an explicit finite non-negative amount.`, "INVALID_AMOUNT");
	}
	return round2(numeric);
}

function sameMoney(left, right) {
	return typeof left === "number" &&
		typeof right === "number" &&
		Number.isFinite(left) &&
		Number.isFinite(right) &&
		Math.abs(round2(left) - round2(right)) < 0.005;
}

function normalizeTimestamp(value, field = "sourceTimestamp") {
	const parsed = value instanceof Date ? value : new Date(value);
	if (!Number.isFinite(parsed.getTime())) {
		fail(`${field} must be a valid immutable timestamp.`, "INVALID_SOURCE_TIMESTAMP");
	}
	return parsed.toISOString();
}

function normalizeStayDate(value) {
	const stayDate = clean(value);
	if (!/^\d{4}-\d{2}-\d{2}$/.test(stayDate)) {
		fail("stayDate must be an ISO calendar date.", "INVALID_STAY_DATE");
	}
	const parsed = new Date(`${stayDate}T00:00:00.000Z`);
	if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== stayDate) {
		fail("stayDate must be a real ISO calendar date.", "INVALID_STAY_DATE");
	}
	return stayDate;
}

function normalizeSourceHash(value) {
	const hash = clean(value).toLowerCase();
	if (!/^[a-f0-9]{64}$/.test(hash)) {
		fail("sourceHash must be a SHA-256 hex digest.", "INVALID_SOURCE_HASH");
	}
	return hash;
}

function normalizeSourceId(value) {
	const sourceId = clean(value);
	// Deliberately excludes addresses, subjects, and free text. Mongo IDs,
	// event keys, message UIDs, and other opaque machine IDs remain supported.
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(sourceId)) {
		fail("sourceId must be a bounded opaque machine identifier.", "INVALID_SOURCE_ID");
	}
	return sourceId;
}

function normalizeSourceType(value, allowedTypes = null) {
	const sourceType = normalizeMarker(value, "sourceType", "INVALID_SOURCE_TYPE");
	if (allowedTypes && !allowedTypes.has(sourceType)) {
		fail("sourceType is not trusted for this evidence path.", "UNTRUSTED_SOURCE_TYPE");
	}
	return sourceType;
}

function normalizeProvenance(
	value,
	{ expectedProvider = "", allowedSourceTypes = null } = {}
) {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		fail("Immutable source provenance is required.", "SOURCE_PROVENANCE_REQUIRED");
	}
	const provider = normalizeProvider(value.provider || expectedProvider);
	if (!provider) fail("Source provider is invalid.", "INVALID_PROVIDER");
	if (expectedProvider && provider !== normalizeProvider(expectedProvider)) {
		fail("Source provider does not match the commercial provider.", "PROVIDER_MISMATCH");
	}
	return {
		provider,
		sourceType: normalizeSourceType(value.sourceType, allowedSourceTypes),
		sourceHash: normalizeSourceHash(value.sourceHash),
		sourceTimestamp: normalizeTimestamp(value.sourceTimestamp),
		sourceId: normalizeSourceId(value.sourceId),
	};
}

function unavailableRole() {
	return {
		verified: false,
		sourceAmount: null,
		sourceCurrency: null,
		propertyAmount: null,
		propertyCurrency: null,
		bookingBasis: null,
		evidenceType: "unavailable",
		sourceRef: null,
	};
}

function roleWasSupplied(value = {}) {
	return ["amount", "sourceAmount", "propertyAmount", "currency", "sourceCurrency"].some(
		(key) => hasOwn(value, key) && value[key] !== null && value[key] !== undefined && value[key] !== ""
	);
}

function normalizeConversion(value, { sourceCurrency, propertyCurrency, provider }) {
	if (value === null || value === undefined) return null;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		fail("Currency conversion evidence is malformed.", "UNSAFE_CONVERSION");
	}
	if (value.trusted !== true || value.verified !== true) {
		fail("Currency conversion must be explicitly trusted and verified.", "UNSAFE_CONVERSION");
	}
	const from = normalizeCurrency(value.sourceCurrency, "conversion.sourceCurrency");
	const to = normalizeCurrency(value.propertyCurrency, "conversion.propertyCurrency");
	if (from !== sourceCurrency || to !== propertyCurrency) {
		fail("Currency conversion does not match the evidence currencies.", "CURRENCY_MISMATCH");
	}
	const rate = Number(value.rate);
	if (!Number.isFinite(rate) || rate <= 0 || rate > 1_000_000) {
		fail("Currency conversion rate is unsafe.", "UNSAFE_CONVERSION");
	}
	if (sourceCurrency === propertyCurrency && Math.abs(rate - 1) > 0.000001) {
		fail("Same-currency conversion must use rate 1.", "UNSAFE_CONVERSION");
	}
	const provenance = normalizeProvenance(value.provenance, {
		allowedSourceTypes: CONVERSION_SOURCE_TYPES,
	});
	if (
		provenance.sourceType === "provider_explicit_exchange" &&
		provenance.provider !== provider
	) {
		fail("Provider exchange evidence has a provider mismatch.", "PROVIDER_MISMATCH");
	}
	if (
		provenance.sourceType === "hotelrunner_payment_exchange" &&
		provenance.provider !== "hotelrunner"
	) {
		fail("HotelRunner exchange evidence has a provider mismatch.", "PROVIDER_MISMATCH");
	}
	return {
		verified: true,
		sourceCurrency,
		propertyCurrency,
		rate: Number(rate.toFixed(10)),
		sourceRef: "conversion",
		provenance,
	};
}

function convertedPropertyAmount(sourceAmount, conversion) {
	if (!conversion) return null;
	const converted = roundedMoneyProduct(sourceAmount, conversion.rate);
	if (converted === null || converted < 0 || converted > MAX_MONEY) {
		fail("Converted property amount is unsafe.", "UNSAFE_CONVERSION");
	}
	return converted;
}

function normalizeAuthenticatedRole(
	value,
	{
		field,
		sourceCurrency,
		propertyCurrency,
		bookingBasis,
		conversion,
		evidenceType = "authenticated_source",
		sourceRef = "primary",
		requireExplicit = false,
	} = {}
) {
	if (value === null || value === undefined) return unavailableRole();
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		fail(`${field} evidence must be an object.`, "INVALID_ROLE_EVIDENCE");
	}
	if (value.verified !== true) {
		if (roleWasSupplied(value)) {
			fail(`${field} cannot carry an unverified amount.`, "UNVERIFIED_AMOUNT");
		}
		return unavailableRole();
	}
	if (requireExplicit && value.explicit !== true) {
		fail(
			`${field} must be explicitly supplied by the authenticated source.`,
			"EXPLICIT_COMMISSION_REQUIRED"
		);
	}
	const amount = normalizeMoney(value.amount ?? value.sourceAmount, `${field}.amount`);
	const currency = normalizeCurrency(
		value.currency || value.sourceCurrency || sourceCurrency,
		`${field}.currency`
	);
	if (currency !== sourceCurrency) {
		fail(`${field} currency conflicts with sourceCurrency.`, "CURRENCY_MISMATCH");
	}
	const basis = normalizeBasis(value.bookingBasis || bookingBasis);
	let propertyAmount = null;
	if (sourceCurrency === propertyCurrency) {
		propertyAmount = amount;
	} else if (conversion) {
		propertyAmount = convertedPropertyAmount(amount, conversion);
	}
	if (hasOwn(value, "propertyAmount") && value.propertyAmount !== null) {
		if (propertyAmount === null) {
			fail(
				`${field} cannot provide a property amount without trusted conversion evidence.`,
				"UNSAFE_CONVERSION"
			);
		}
		const claimed = normalizeMoney(value.propertyAmount, `${field}.propertyAmount`);
		if (!sameMoney(claimed, propertyAmount)) {
			fail(`${field} property amount does not reconcile to the trusted rate.`, "UNSAFE_CONVERSION");
		}
	}
	return {
		verified: true,
		sourceAmount: amount,
		sourceCurrency,
		propertyAmount,
		propertyCurrency: propertyAmount === null ? null : propertyCurrency,
		bookingBasis: basis,
		evidenceType,
		sourceRef,
	};
}

function normalizeHotelBaseRole(value, { propertyCurrency, bookingBasis }) {
	if (value === null || value === undefined) {
		return { role: unavailableRole(), provenance: null };
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		fail("hotelBase evidence must be an object.", "INVALID_ROLE_EVIDENCE");
	}
	if (value.verified !== true) {
		if (roleWasSupplied(value)) {
			fail("hotelBase cannot carry an unverified amount.", "UNVERIFIED_AMOUNT");
		}
		return { role: unavailableRole(), provenance: null };
	}
	const currency = normalizeCurrency(
		value.currency || value.sourceCurrency || propertyCurrency,
		"hotelBase.currency"
	);
	if (currency !== propertyCurrency) {
		fail("hotelBase must use propertyCurrency.", "CURRENCY_MISMATCH");
	}
	const amount = normalizeMoney(value.amount ?? value.sourceAmount, "hotelBase.amount");
	const provenance = normalizeProvenance(value.provenance, {
		allowedSourceTypes: HOTEL_BASE_SOURCE_TYPES,
	});
	return {
		role: {
			verified: true,
			sourceAmount: amount,
			sourceCurrency: propertyCurrency,
			propertyAmount: amount,
			propertyCurrency,
			bookingBasis: normalizeBasis(value.bookingBasis || bookingBasis),
			evidenceType: "pms_source",
			sourceRef: "hotelBase",
		},
		provenance,
	};
}

function deriveDeduction(guestGross, hotelPayout, propertyCurrency) {
	if (!guestGross.verified || !hotelPayout.verified) {
		return unavailableRole();
	}
	if (guestGross.sourceCurrency !== hotelPayout.sourceCurrency) {
		fail("Guest gross and hotel payout currencies conflict.", "CURRENCY_MISMATCH");
	}
	if (guestGross.bookingBasis !== hotelPayout.bookingBasis) {
		return unavailableRole();
	}
	if (hotelPayout.sourceAmount > guestGross.sourceAmount + 0.004) {
		fail("Hotel payout exceeds guest gross on the same booking basis.", "PAYOUT_EXCEEDS_GROSS");
	}
	const sourceAmount = round2(guestGross.sourceAmount - hotelPayout.sourceAmount);
	const hasPropertyAmounts =
		guestGross.propertyAmount !== null && hotelPayout.propertyAmount !== null;
	const propertyAmount = hasPropertyAmounts
		? round2(guestGross.propertyAmount - hotelPayout.propertyAmount)
		: null;
	if (propertyAmount !== null && propertyAmount < -0.004) {
		fail("Converted payout exceeds converted guest gross.", "PAYOUT_EXCEEDS_GROSS");
	}
	return {
		verified: true,
		sourceAmount,
		sourceCurrency: guestGross.sourceCurrency,
		propertyAmount: propertyAmount === null ? null : Math.max(0, propertyAmount),
		propertyCurrency: propertyAmount === null ? null : propertyCurrency,
		bookingBasis: guestGross.bookingBasis,
		evidenceType: "derived_verified_gross_minus_payout",
		sourceRef: "guestGross+hotelPayout",
	};
}

function normalizeNightlyEvidence(
	value,
	{ sourceCurrency, propertyCurrency, conversion } = {}
) {
	if (value === null || value === undefined) return [];
	if (!Array.isArray(value) || value.length > 400) {
		fail("nightlyEvidence must be a bounded array.", "INVALID_NIGHTLY_EVIDENCE");
	}
	const seenDates = new Set();
	const normalized = value.map((entry, index) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			fail(`nightlyEvidence[${index}] is malformed.`, "INVALID_NIGHTLY_EVIDENCE");
		}
		const stayDate = normalizeStayDate(entry.stayDate || entry.date);
		if (seenDates.has(stayDate)) {
			fail(`nightlyEvidence contains duplicate date ${stayDate}.`, "DUPLICATE_STAY_DATE");
		}
		seenDates.add(stayDate);
		const nightBasis = `night:${stayDate}`;
		const guestGross = normalizeAuthenticatedRole(entry.guestGross, {
			field: `nightlyEvidence[${index}].guestGross`,
			sourceCurrency,
			propertyCurrency,
			bookingBasis: nightBasis,
			conversion,
			evidenceType: "explicit_nightly_source",
		});
		const hotelPayout = normalizeAuthenticatedRole(
			entry.hotelPayout || entry.otaNet,
			{
				field: `nightlyEvidence[${index}].hotelPayout`,
				sourceCurrency,
				propertyCurrency,
				bookingBasis: nightBasis,
				conversion,
				evidenceType: "explicit_nightly_source",
			}
		);
		for (const [name, role] of Object.entries({ guestGross, hotelPayout })) {
			if (role.verified && role.bookingBasis !== nightBasis) {
				fail(
					`nightlyEvidence[${index}].${name} has a non-night booking basis.`,
					"BOOKING_BASIS_MISMATCH"
				);
			}
		}
		if (!guestGross.verified && !hotelPayout.verified) {
			fail(
				`nightlyEvidence[${index}] has no verified gross or payout.`,
				"EMPTY_NIGHTLY_EVIDENCE"
			);
		}
		return {
			stayDate,
			guestGross,
			hotelPayout,
			deductionAggregate: deriveDeduction(
				guestGross,
				hotelPayout,
				propertyCurrency
			),
		};
	});
	return normalized.sort((left, right) => left.stayDate.localeCompare(right.stayDate));
}

function normalizeDeductionComponents(
	value,
	{ sourceCurrency, propertyCurrency, bookingBasis, conversion } = {}
) {
	if (value === null || value === undefined) return [];
	if (!Array.isArray(value) || value.length > 100) {
		fail(
			"deductionComponents must be a bounded array.",
			"INVALID_DEDUCTION_COMPONENTS"
		);
	}
	const normalized = value.map((entry, index) => {
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			fail(
				`deductionComponents[${index}] is malformed.`,
				"INVALID_DEDUCTION_COMPONENT"
			);
		}
		const componentType = normalizeMarker(
			entry.componentType || entry.type,
			`deductionComponents[${index}].componentType`,
			"INVALID_DEDUCTION_COMPONENT"
		);
		const direction = clean(entry.direction || "deduction").toLowerCase();
		if (!DEDUCTION_DIRECTIONS.has(direction)) {
			fail(
				`deductionComponents[${index}].direction is invalid.`,
				"INVALID_DEDUCTION_COMPONENT"
			);
		}
		const amount = normalizeAuthenticatedRole(entry, {
			field: `deductionComponents[${index}].amount`,
			sourceCurrency,
			propertyCurrency,
			bookingBasis,
			conversion,
			evidenceType: "explicit_deduction_component",
		});
		if (!amount.verified) {
			fail(
				`deductionComponents[${index}] must contain a verified amount.`,
				"INVALID_DEDUCTION_COMPONENT"
			);
		}
		return { componentType, direction, amount };
	});
	return normalized.sort((left, right) => {
		const leftKey = `${left.componentType}\u0000${left.direction}\u0000${stableStringify(left)}`;
		const rightKey = `${right.componentType}\u0000${right.direction}\u0000${stableStringify(right)}`;
		return leftKey.localeCompare(rightKey);
	});
}

function normalizeHotelRunnerReportedAmount(
	value,
	{ bookingBasis, roles, provenance, sourceRef = "hotelRunner" } = {}
) {
	if (value === null || value === undefined) return null;
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		fail("HotelRunner reported amount is malformed.", "INVALID_HOTELRUNNER_AMOUNT");
	}
	const amount = normalizeMoney(value.amount, "hotelRunnerReportedAmount.amount");
	const currency = normalizeCurrency(value.currency, "hotelRunnerReportedAmount.currency");
	const basis = normalizeBasis(value.bookingBasis || bookingBasis);
	const role = clean(value.role || "unknown").toLowerCase();
	if (!REPORTED_AMOUNT_ROLES.has(role)) {
		fail("HotelRunner reported amount role is invalid.", "INVALID_HOTELRUNNER_ROLE");
	}
	if (role !== "unknown") {
		if (value.explicitRoleAssignment !== true) {
			fail(
				"HotelRunner reported amount remains unknown without explicit role assignment.",
				"HOTELRUNNER_ROLE_NOT_EXPLICIT"
			);
		}
		const target = role === "guest_gross" ? roles.guestGross : roles.hotelPayout;
		if (!target.verified || target.bookingBasis !== basis) {
			fail("HotelRunner role assignment lacks matching verified evidence.", "HOTELRUNNER_ROLE_MISMATCH");
		}
		const sourceMatch =
			target.sourceCurrency === currency && sameMoney(target.sourceAmount, amount);
		const propertyMatch =
			target.propertyCurrency === currency &&
			target.propertyAmount !== null &&
			sameMoney(target.propertyAmount, amount);
		if (!sourceMatch && !propertyMatch) {
			fail("HotelRunner role assignment amount does not match the verified role.", "HOTELRUNNER_ROLE_MISMATCH");
		}
	}
	if (!provenance) {
		fail("HotelRunner amount provenance is required.", "SOURCE_PROVENANCE_REQUIRED");
	}
	return {
		amount,
		currency,
		bookingBasis: basis,
		role,
		roleVerified: role !== "unknown",
		sourceRef,
	};
}

function stableValue(value) {
	if (Array.isArray(value)) return value.map(stableValue);
	if (value && typeof value === "object") {
		return Object.keys(value)
			.sort()
			.reduce((result, key) => {
				result[key] = stableValue(value[key]);
				return result;
			}, {});
	}
	return value;
}

function stableStringify(value) {
	return JSON.stringify(stableValue(value));
}

function hashOtaCommercialEvidence(evidence = {}) {
	const hashInput = { ...(evidence || {}) };
	delete hashInput.evidenceHash;
	return crypto
		.createHash("sha256")
		.update(stableStringify(hashInput), "utf8")
		.digest("hex");
}

function deepFreeze(value) {
	if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
	Object.freeze(value);
	Object.values(value).forEach(deepFreeze);
	return value;
}

function sameKeys(value, keys) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length &&
		actual.every((key, index) => key === expected[index]);
}

function validateProvenance(value, path, errors) {
	if (!sameKeys(value, PROVENANCE_KEYS)) {
		errors.push(`${path}_shape`);
		return;
	}
	const provider = normalizeProvider(value.provider);
	if (!provider || provider !== value.provider) errors.push(`${path}_provider`);
	if (!/^[a-z0-9][a-z0-9._:-]{0,95}$/.test(value.sourceType || "")) {
		errors.push(`${path}_source_type`);
	}
	if (!/^[a-f0-9]{64}$/.test(value.sourceHash || "")) errors.push(`${path}_hash`);
	const timestamp = new Date(value.sourceTimestamp);
	if (
		!Number.isFinite(timestamp.getTime()) ||
		timestamp.toISOString() !== value.sourceTimestamp
	) {
		errors.push(`${path}_timestamp`);
	}
	if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value.sourceId || "")) {
		errors.push(`${path}_source_id`);
	}
}

function validateRole(role, name, errors) {
	if (!sameKeys(role, ROLE_KEYS)) {
		errors.push(`${name}_shape`);
		return;
	}
	if (role.verified !== true && role.verified !== false) {
		errors.push(`${name}_verified`);
		return;
	}
	if (!role.verified) {
		if (
			role.sourceAmount !== null ||
			role.sourceCurrency !== null ||
			role.propertyAmount !== null ||
			role.propertyCurrency !== null ||
			role.bookingBasis !== null ||
			role.evidenceType !== "unavailable" ||
			role.sourceRef !== null
		) {
			errors.push(`${name}_unverified_value`);
		}
		return;
	}
	if (!isNormalizedMoney(role.sourceAmount)) {
		errors.push(`${name}_source_amount`);
	}
	if (!/^[A-Z]{3}$/.test(role.sourceCurrency || "")) {
		errors.push(`${name}_source_currency`);
	}
	if (!/^[a-z0-9][a-z0-9._:-]{0,95}$/.test(role.bookingBasis || "")) {
		errors.push(`${name}_basis`);
	}
	if (role.propertyAmount === null) {
		if (role.propertyCurrency !== null) errors.push(`${name}_property_currency`);
	} else if (
		!isNormalizedMoney(role.propertyAmount) ||
		!/^[A-Z]{3}$/.test(role.propertyCurrency || "")
	) {
		errors.push(`${name}_property_amount`);
	}
	if (!/^[a-z0-9][a-z0-9._:+-]{0,95}$/.test(role.evidenceType || "")) {
		errors.push(`${name}_evidence_type`);
	}
	if (!/^[A-Za-z0-9][A-Za-z0-9+._:-]{0,95}$/.test(role.sourceRef || "")) {
		errors.push(`${name}_source_ref`);
	}
}

function validateRoleProjection(
	role,
	name,
	{ propertyCurrency, conversion, contractVersion = CONTRACT_VERSION } = {},
	errors
) {
	if (!role?.verified) return;
	let expectedPropertyAmount = null;
	if (role.sourceCurrency === propertyCurrency) {
		expectedPropertyAmount = role.sourceAmount;
	} else if (
		conversion?.verified === true &&
		conversion.sourceCurrency === role.sourceCurrency &&
		conversion.propertyCurrency === propertyCurrency &&
		Number.isFinite(conversion.rate) &&
		conversion.rate > 0
	) {
		expectedPropertyAmount =
			contractVersion === 1
				? round2(role.sourceAmount * conversion.rate)
				: roundedMoneyProduct(role.sourceAmount, conversion.rate);
	}
	if (expectedPropertyAmount === null) {
		if (role.propertyAmount !== null || role.propertyCurrency !== null) {
			errors.push(`${name}_unsafe_property_projection`);
		}
		return;
	}
	if (
		role.propertyCurrency !== propertyCurrency ||
		!sameMoney(role.propertyAmount, expectedPropertyAmount)
	) {
		errors.push(`${name}_property_projection`);
	}
}

function validateDerivedDeduction(
	gross,
	payout,
	deduction,
	propertyCurrency,
	path,
	errors
) {
	const bothVerified = gross?.verified === true && payout?.verified === true;
	const sameCurrency = bothVerified && gross.sourceCurrency === payout.sourceCurrency;
	const sameBasis = bothVerified && gross.bookingBasis === payout.bookingBasis;
	const shouldDerive = bothVerified && sameCurrency && sameBasis;
	if (bothVerified && !sameCurrency) errors.push(`${path}_currency_mismatch`);
	if (!shouldDerive) {
		if (deduction?.verified) errors.push(`${path}_without_comparable_roles`);
		return false;
	}
	if (payout.sourceAmount > gross.sourceAmount + 0.004) {
		errors.push(`${path}_payout_exceeds_gross`);
	}
	const expectedSource = round2(gross.sourceAmount - payout.sourceAmount);
	const hasPropertyAmounts =
		gross.propertyAmount !== null && payout.propertyAmount !== null;
	const expectedProperty = hasPropertyAmounts
		? round2(gross.propertyAmount - payout.propertyAmount)
		: null;
	if (
		!deduction?.verified ||
		deduction.evidenceType !== "derived_verified_gross_minus_payout" ||
		deduction.sourceRef !== "guestGross+hotelPayout" ||
		!sameMoney(deduction.sourceAmount, expectedSource) ||
		deduction.sourceCurrency !== gross.sourceCurrency ||
		deduction.bookingBasis !== gross.bookingBasis ||
		(expectedProperty === null
			? deduction.propertyAmount !== null || deduction.propertyCurrency !== null
			: !sameMoney(deduction.propertyAmount, expectedProperty) ||
			  deduction.propertyCurrency !== propertyCurrency)
	) {
		errors.push(`${path}_invalid`);
	}
	return true;
}

function validateNightlyEvidence(value, evidence, errors) {
	if (!Array.isArray(value) || value.length > 400) {
		errors.push("nightly_evidence_shape");
		return;
	}
	const seenDates = new Set();
	let previousDate = "";
	value.forEach((entry, index) => {
		const path = `nightly_${index}`;
		if (!sameKeys(entry, NIGHTLY_EVIDENCE_KEYS)) {
			errors.push(`${path}_shape`);
			return;
		}
		let validDate = true;
		try {
			normalizeStayDate(entry.stayDate);
		} catch (_error) {
			validDate = false;
			errors.push(`${path}_date`);
		}
		if (seenDates.has(entry.stayDate)) errors.push(`${path}_duplicate_date`);
		if (entry.stayDate < previousDate) errors.push("nightly_evidence_order");
		seenDates.add(entry.stayDate);
		previousDate = entry.stayDate;
		for (const name of ["guestGross", "hotelPayout", "deductionAggregate"]) {
			validateRole(entry[name], `${path}_${name}`, errors);
		}
		const nightBasis = validDate ? `night:${entry.stayDate}` : null;
		for (const name of ["guestGross", "hotelPayout"]) {
			const role = entry[name];
			if (role?.verified) {
				if (role.sourceCurrency !== evidence.sourceCurrency) {
					errors.push(`${path}_${name}_source_currency`);
				}
				if (role.bookingBasis !== nightBasis) {
					errors.push(`${path}_${name}_basis`);
				}
				if (
					role.evidenceType !== "explicit_nightly_source" ||
					role.sourceRef !== "primary"
				) {
					errors.push(`${path}_${name}_source`);
				}
				validateRoleProjection(
					role,
					`${path}_${name}`,
					{
						propertyCurrency: evidence.propertyCurrency,
						conversion: evidence.currencyConversion,
						contractVersion: evidence.contractVersion,
					},
					errors
				);
			}
		}
		if (!entry.guestGross?.verified && !entry.hotelPayout?.verified) {
			errors.push(`${path}_empty`);
		}
		validateDerivedDeduction(
			entry.guestGross,
			entry.hotelPayout,
			entry.deductionAggregate,
			evidence.propertyCurrency,
			`${path}_deduction`,
			errors
		);
	});
}

function validateDeductionComponents(value, evidence, errors) {
	if (!Array.isArray(value) || value.length > 100) {
		errors.push("deduction_components_shape");
		return;
	}
	let previous = "";
	value.forEach((entry, index) => {
		const path = `deduction_component_${index}`;
		if (!sameKeys(entry, DEDUCTION_COMPONENT_KEYS)) {
			errors.push(`${path}_shape`);
			return;
		}
		if (!/^[a-z0-9][a-z0-9._:-]{0,95}$/.test(entry.componentType || "")) {
			errors.push(`${path}_type`);
		}
		if (!DEDUCTION_DIRECTIONS.has(entry.direction)) {
			errors.push(`${path}_direction`);
		}
		validateRole(entry.amount, `${path}_amount`, errors);
		if (
			!entry.amount?.verified ||
			entry.amount.sourceCurrency !== evidence.sourceCurrency ||
			entry.amount.evidenceType !== "explicit_deduction_component" ||
			entry.amount.sourceRef !== "primary"
		) {
			errors.push(`${path}_source`);
		}
		validateRoleProjection(
			entry.amount,
			`${path}_amount`,
			{
				propertyCurrency: evidence.propertyCurrency,
				conversion: evidence.currencyConversion,
				contractVersion: evidence.contractVersion,
			},
			errors
		);
		const canonical = `${entry.componentType}\u0000${entry.direction}\u0000${stableStringify(entry)}`;
		if (canonical < previous) errors.push("deduction_components_order");
		previous = canonical;
	});
}

function constantTimeHashEqual(left, right) {
	if (!/^[a-f0-9]{64}$/.test(left || "") || !/^[a-f0-9]{64}$/.test(right || "")) {
		return false;
	}
	return crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function validateOtaCommercialEvidence(evidence = {}) {
	const errors = [];
	if (!sameKeys(evidence, TOP_LEVEL_KEYS)) {
		return { ok: false, errors: ["contract_shape"] };
	}
	if (!SUPPORTED_CONTRACT_VERSIONS.has(evidence.contractVersion)) {
		errors.push("contract_version");
	}
	const provider = normalizeProvider(evidence.provider);
	if (!provider || provider !== evidence.provider) errors.push("provider");
	if (!/^[a-z0-9][a-z0-9._:-]{0,95}$/.test(evidence.sourceType || "")) {
		errors.push("source_type");
	}
	const isHotelRunnerOnly = HOTELRUNNER_UNRESOLVED_SOURCE_TYPES.has(
		evidence.sourceType
	);
	const isAuthenticatedProviderSource = AUTHENTICATED_SOURCE_TYPE_SET.has(
		evidence.sourceType
	);
	if (!isHotelRunnerOnly && !isAuthenticatedProviderSource) {
		errors.push("untrusted_source_type");
	}
	if (!/^[A-Z]{3}$/.test(evidence.sourceCurrency || "")) errors.push("source_currency");
	if (!/^[A-Z]{3}$/.test(evidence.propertyCurrency || "")) errors.push("property_currency");
	if (!/^[a-z0-9][a-z0-9._:-]{0,95}$/.test(evidence.bookingBasis || "")) {
		errors.push("booking_basis");
	}
	if (!sameKeys(evidence.roles, ROLE_NAMES)) {
		errors.push("roles_shape");
	} else {
		ROLE_NAMES.forEach((name) => validateRole(evidence.roles[name], name, errors));
	}
	if (
		!evidence.provenance ||
		!sameKeys(evidence.provenance, ["conversion", "hotelBase", "hotelRunner", "primary"])
	) {
		errors.push("provenance_shape");
	} else {
		validateProvenance(evidence.provenance.primary, "primary_provenance", errors);
		for (const key of ["conversion", "hotelBase", "hotelRunner"]) {
			if (evidence.provenance[key] !== null) {
				validateProvenance(evidence.provenance[key], `${key}_provenance`, errors);
			}
		}
		if (evidence.provenance.primary?.provider !== evidence.provider) {
			errors.push("primary_provider_mismatch");
		}
		if (evidence.provenance.primary?.sourceType !== evidence.sourceType) {
			errors.push("primary_source_type_mismatch");
		}
		if (
			evidence.provenance.hotelBase !== null &&
			!HOTEL_BASE_SOURCE_TYPES.has(evidence.provenance.hotelBase.sourceType)
		) {
			errors.push("hotel_base_provenance_source_type");
		}
		if (
			evidence.provenance.hotelRunner !== null &&
			(!HOTELRUNNER_UNRESOLVED_SOURCE_TYPES.has(
				evidence.provenance.hotelRunner.sourceType
			) ||
				evidence.provenance.hotelRunner.provider !== evidence.provider)
		) {
			errors.push("hotelrunner_provenance_source");
		}
		if (
			evidence.provenance.conversion !== null &&
			!CONVERSION_SOURCE_TYPES.has(evidence.provenance.conversion.sourceType)
		) {
			errors.push("conversion_provenance_source_type");
		}
	}

	const gross = evidence.roles?.guestGross;
	const hotelBase = evidence.roles?.hotelBase;
	const payout = evidence.roles?.hotelPayout;
	const deduction = evidence.roles?.deductionAggregate;
	const commission = evidence.roles?.explicitOtaCommission;
	for (const [name, role] of Object.entries({ gross, payout })) {
		if (role?.verified) {
			if (role.sourceCurrency !== evidence.sourceCurrency) {
				errors.push(`${name}_currency_mismatch`);
			}
			if (role.evidenceType !== "authenticated_source" || role.sourceRef !== "primary") {
				errors.push(`${name}_source`);
			}
			validateRoleProjection(
				role,
				name,
				{
					propertyCurrency: evidence.propertyCurrency,
					conversion: evidence.currencyConversion,
					contractVersion: evidence.contractVersion,
				},
				errors
			);
		}
	}
	if (hotelBase?.verified) {
		if (
			hotelBase.sourceCurrency !== evidence.propertyCurrency ||
			hotelBase.evidenceType !== "pms_source" ||
			hotelBase.sourceRef !== "hotelBase" ||
			!evidence.provenance?.hotelBase
		) {
			errors.push("hotel_base_source");
		}
		validateRoleProjection(
			hotelBase,
			"hotel_base",
			{
				propertyCurrency: evidence.propertyCurrency,
				conversion: null,
				contractVersion: evidence.contractVersion,
			},
			errors
		);
	} else if (evidence.provenance?.hotelBase !== null) {
		errors.push("hotel_base_provenance_without_role");
	}
	if (commission?.verified) {
		if (commission.sourceCurrency !== evidence.sourceCurrency) {
			errors.push("commission_currency_mismatch");
		}
		if (
			commission.evidenceType !== "explicit_authenticated_source" ||
			commission.sourceRef !== "primary"
		) {
			errors.push("commission_not_explicit");
		}
		validateRoleProjection(
			commission,
			"commission",
			{
				propertyCurrency: evidence.propertyCurrency,
				conversion: evidence.currencyConversion,
				contractVersion: evidence.contractVersion,
			},
			errors
		);
	}
	const bothCommercial = gross?.verified === true && payout?.verified === true;
	const sameCurrency = bothCommercial
		? gross.sourceCurrency === payout.sourceCurrency
		: null;
	const sameBasis = bothCommercial
		? gross.bookingBasis === payout.bookingBasis
		: null;
	const shouldDerive = bothCommercial && sameCurrency && sameBasis;
	if (!sameKeys(evidence.reconciliation, [
		"deductionDerived",
		"grossAndPayoutSameBasis",
		"grossAndPayoutSameCurrency",
	])) {
		errors.push("reconciliation_shape");
	} else {
		if (evidence.reconciliation.grossAndPayoutSameCurrency !== sameCurrency) {
			errors.push("reconciliation_currency");
		}
		if (evidence.reconciliation.grossAndPayoutSameBasis !== sameBasis) {
			errors.push("reconciliation_basis");
		}
		if (evidence.reconciliation.deductionDerived !== shouldDerive) {
			errors.push("reconciliation_deduction");
		}
	}
	validateDerivedDeduction(
		gross,
		payout,
		deduction,
		evidence.propertyCurrency,
		"deduction",
		errors
	);
	validateNightlyEvidence(evidence.nightlyEvidence, evidence, errors);
	validateDeductionComponents(evidence.deductionComponents, evidence, errors);
	if (
		commission?.verified &&
		deduction?.verified &&
		commission.sourceCurrency === deduction.sourceCurrency &&
		commission.bookingBasis === deduction.bookingBasis &&
		commission.sourceAmount > deduction.sourceAmount + 0.004
	) {
		errors.push("commission_exceeds_deduction");
	}

	const verifiedRoleCount = ROLE_NAMES.filter(
		(name) => name !== "deductionAggregate" && evidence.roles?.[name]?.verified
	).length;
	const expectedState = shouldDerive
		? "verified"
		: verifiedRoleCount > 0 ||
		  (Array.isArray(evidence.nightlyEvidence) && evidence.nightlyEvidence.length > 0) ||
		  (Array.isArray(evidence.deductionComponents) &&
				evidence.deductionComponents.length > 0)
			? "partial"
			: "unresolved";
	if (evidence.verificationState !== expectedState) errors.push("verification_state");

	const reported = evidence.hotelRunnerReportedAmount;
	if (reported !== null) {
		if (!sameKeys(reported, [
			"amount",
			"bookingBasis",
			"currency",
			"role",
			"roleVerified",
			"sourceRef",
		])) {
			errors.push("hotelrunner_amount_shape");
		} else {
			if (!isNormalizedMoney(reported.amount)) {
				errors.push("hotelrunner_amount");
			}
			if (!/^[A-Z]{3}$/.test(reported.currency || "")) {
				errors.push("hotelrunner_currency");
			}
			if (!REPORTED_AMOUNT_ROLES.has(reported.role)) errors.push("hotelrunner_role");
			if (!/^[a-z0-9][a-z0-9._:-]{0,95}$/.test(reported.bookingBasis || "")) {
				errors.push("hotelrunner_booking_basis");
			}
			if (reported.roleVerified !== (reported.role !== "unknown")) {
				errors.push("hotelrunner_role_verified");
			}
			const source = evidence.provenance?.[reported.sourceRef];
			const expectedSourceRef = isHotelRunnerOnly ? "primary" : "hotelRunner";
			if (
				!source ||
				reported.sourceRef !== expectedSourceRef ||
				!HOTELRUNNER_UNRESOLVED_SOURCE_TYPES.has(source.sourceType) ||
				source.provider !== evidence.provider
			) {
				errors.push("hotelrunner_provenance");
			}
			if (isHotelRunnerOnly && reported.role !== "unknown") {
				errors.push("hotelrunner_unresolved_role_assignment");
			}
			if (reported.role !== "unknown") {
				const target = reported.role === "guest_gross" ? gross : payout;
				const sourceMatch =
					target?.verified &&
					target.bookingBasis === reported.bookingBasis &&
					target.sourceCurrency === reported.currency &&
					sameMoney(target.sourceAmount, reported.amount);
				const propertyMatch =
					target?.verified &&
					target.bookingBasis === reported.bookingBasis &&
					target.propertyCurrency === reported.currency &&
					target.propertyAmount !== null &&
					sameMoney(target.propertyAmount, reported.amount);
				if (!sourceMatch && !propertyMatch) errors.push("hotelrunner_role_mismatch");
			}
		}
	}
	if (isHotelRunnerOnly) {
		if (reported === null) errors.push("hotelrunner_amount_required");
		if (
			ROLE_NAMES.some((name) => evidence.roles?.[name]?.verified) ||
			!Array.isArray(evidence.nightlyEvidence) ||
			evidence.nightlyEvidence.length !== 0 ||
			!Array.isArray(evidence.deductionComponents) ||
			evidence.deductionComponents.length !== 0 ||
			evidence.currencyConversion !== null ||
			evidence.provenance?.hotelBase !== null ||
			evidence.provenance?.hotelRunner !== null ||
			evidence.provenance?.conversion !== null
		) {
			errors.push("hotelrunner_unresolved_contract");
		}
		if (reported && reported.currency !== evidence.sourceCurrency) {
			errors.push("hotelrunner_source_currency");
		}
	} else if (
		(reported === null) !== (evidence.provenance?.hotelRunner === null)
	) {
		errors.push("hotelrunner_provenance_pair");
	}

	const conversion = evidence.currencyConversion;
	if (conversion !== null) {
		if (!sameKeys(conversion, [
			"propertyCurrency",
			"rate",
			"sourceCurrency",
			"sourceRef",
			"verified",
		])) {
			errors.push("conversion_shape");
		} else if (
			conversion.verified !== true ||
			conversion.sourceCurrency !== evidence.sourceCurrency ||
			conversion.propertyCurrency !== evidence.propertyCurrency ||
			!Number.isFinite(conversion.rate) ||
			conversion.rate <= 0 ||
			conversion.rate > 1_000_000 ||
			conversion.rate !== Number(conversion.rate.toFixed(10)) ||
			(evidence.sourceCurrency === evidence.propertyCurrency &&
				Math.abs(conversion.rate - 1) > 0.000001) ||
			conversion.sourceRef !== "conversion" ||
			!evidence.provenance?.conversion
		) {
			errors.push("conversion_invalid");
		}
		const conversionSource = evidence.provenance?.conversion;
		if (
			conversionSource?.sourceType === "provider_explicit_exchange" &&
			conversionSource.provider !== evidence.provider
		) {
			errors.push("conversion_provider_mismatch");
		}
		if (
			conversionSource?.sourceType === "hotelrunner_payment_exchange" &&
			conversionSource.provider !== "hotelrunner"
		) {
			errors.push("conversion_hotelrunner_provider_mismatch");
		}
	} else if (evidence.provenance?.conversion !== null) {
		errors.push("conversion_provenance_without_conversion");
	}

	const expectedHash = hashOtaCommercialEvidence(evidence);
	if (!constantTimeHashEqual(evidence.evidenceHash, expectedHash)) {
		errors.push("evidence_hash");
	}
	return { ok: errors.length === 0, errors };
}

function finalizeEvidence(value) {
	const evidence = {
		...value,
		evidenceHash: "",
	};
	evidence.evidenceHash = hashOtaCommercialEvidence(evidence);
	const validation = validateOtaCommercialEvidence(evidence);
	if (!validation.ok) {
		fail(
			`Built commercial evidence failed validation: ${validation.errors.join(",")}.`,
			"CONTRACT_VALIDATION_FAILED"
		);
	}
	return deepFreeze(evidence);
}

function buildHotelRunnerUnresolvedCommercialEvidence(input = {}) {
	const provider = normalizeProvider(input.provider);
	if (!provider) fail("HotelRunner channel provider is invalid.", "INVALID_PROVIDER");
	const sourceType = normalizeSourceType(
		input.sourceType || "hotelrunner_api",
		HOTELRUNNER_UNRESOLVED_SOURCE_TYPES
	);
	const sourceCurrency = normalizeCurrency(
		input.reportedCurrency || input.sourceCurrency,
		"reportedCurrency"
	);
	const propertyCurrency = normalizeCurrency(input.propertyCurrency, "propertyCurrency");
	const bookingBasis = normalizeBasis(input.bookingBasis);
	const primary = normalizeProvenance(
		{
			provider,
			sourceType,
			sourceHash: input.sourceHash,
			sourceTimestamp: input.sourceTimestamp,
			sourceId: input.sourceId,
		},
		{
			expectedProvider: provider,
			allowedSourceTypes: HOTELRUNNER_UNRESOLVED_SOURCE_TYPES,
		}
	);
	const roles = Object.fromEntries(ROLE_NAMES.map((name) => [name, unavailableRole()]));
	const hotelRunnerReportedAmount = normalizeHotelRunnerReportedAmount(
		{
			amount: input.reportedAmount,
			currency: sourceCurrency,
			bookingBasis,
			role: "unknown",
		},
		{ bookingBasis, roles, provenance: primary, sourceRef: "primary" }
	);
	return finalizeEvidence({
		contractVersion: CONTRACT_VERSION,
		provider,
		sourceType,
		sourceCurrency,
		propertyCurrency,
		bookingBasis,
		verificationState: "unresolved",
		roles,
		nightlyEvidence: [],
		deductionComponents: [],
		hotelRunnerReportedAmount,
		reconciliation: {
			grossAndPayoutSameCurrency: null,
			grossAndPayoutSameBasis: null,
			deductionDerived: false,
		},
		currencyConversion: null,
		provenance: {
			primary,
			hotelBase: null,
			hotelRunner: null,
			conversion: null,
		},
	});
}

function buildAuthenticatedProviderCommercialEvidence(input = {}) {
	const provider = normalizeProvider(input.provider);
	if (!provider) fail("Commercial provider is invalid.", "INVALID_PROVIDER");
	const authenticated =
		input.sourceAuthenticated ??
		input.sourceSenderAuthenticated ??
		input.authenticated;
	const trusted = input.sourceTrusted ?? input.sourceSenderTrusted ?? input.trusted;
	if (authenticated !== true || trusted !== true) {
		fail("Commercial source is not authenticated and trusted.", "SOURCE_NOT_AUTHENTICATED");
	}
	const authenticatedProvider = normalizeProvider(
		input.authenticatedProvider || input.trustedTransportProvider
	);
	if (!authenticatedProvider || authenticatedProvider !== provider) {
		fail("Authenticated source provider does not match the commercial provider.", "PROVIDER_MISMATCH");
	}
	const sourceCurrency = normalizeCurrency(input.sourceCurrency, "sourceCurrency");
	const propertyCurrency = normalizeCurrency(input.propertyCurrency, "propertyCurrency");
	const bookingBasis = normalizeBasis(input.bookingBasis);
	const sourceType = normalizeSourceType(
		input.sourceType || "authenticated_ota_email",
		AUTHENTICATED_SOURCE_TYPE_SET
	);
	const primary = normalizeProvenance(
		{
			provider,
			sourceType,
			sourceHash: input.sourceHash,
			sourceTimestamp: input.sourceTimestamp,
			sourceId: input.sourceId,
		},
		{ expectedProvider: provider, allowedSourceTypes: AUTHENTICATED_SOURCE_TYPE_SET }
	);
	const normalizedConversion = normalizeConversion(input.currencyConversion, {
		sourceCurrency,
		propertyCurrency,
		provider,
	});
	const conversion = normalizedConversion
		? {
				verified: normalizedConversion.verified,
				sourceCurrency: normalizedConversion.sourceCurrency,
				propertyCurrency: normalizedConversion.propertyCurrency,
				rate: normalizedConversion.rate,
				sourceRef: normalizedConversion.sourceRef,
		  }
		: null;
	const conversionProvenance = normalizedConversion?.provenance || null;
	const guestGross = normalizeAuthenticatedRole(input.guestGross, {
		field: "guestGross",
		sourceCurrency,
		propertyCurrency,
		bookingBasis,
		conversion,
	});
	const hotelPayout = normalizeAuthenticatedRole(
		input.hotelPayout || input.otaNet,
		{
			field: "hotelPayout",
			sourceCurrency,
			propertyCurrency,
			bookingBasis,
			conversion,
		}
	);
	const explicitOtaCommission = normalizeAuthenticatedRole(
		input.explicitOtaCommission,
		{
			field: "explicitOtaCommission",
			sourceCurrency,
			propertyCurrency,
			bookingBasis,
			conversion,
			evidenceType: "explicit_authenticated_source",
			requireExplicit: true,
		}
	);
	const hotelBaseResult = normalizeHotelBaseRole(input.hotelBase, {
		propertyCurrency,
		bookingBasis,
	});
	const deductionAggregate = deriveDeduction(
		guestGross,
		hotelPayout,
		propertyCurrency
	);
	if (
		explicitOtaCommission.verified &&
		deductionAggregate.verified &&
		explicitOtaCommission.sourceCurrency === deductionAggregate.sourceCurrency &&
		explicitOtaCommission.bookingBasis === deductionAggregate.bookingBasis &&
		explicitOtaCommission.sourceAmount > deductionAggregate.sourceAmount + 0.004
	) {
		fail(
			"Explicit OTA commission exceeds the comparable aggregate deduction.",
			"COMMISSION_EXCEEDS_DEDUCTION"
		);
	}
	const roles = {
		guestGross,
		hotelBase: hotelBaseResult.role,
		hotelPayout,
		deductionAggregate,
		explicitOtaCommission,
	};
	const nightlyEvidence = normalizeNightlyEvidence(input.nightlyEvidence, {
		sourceCurrency,
		propertyCurrency,
		conversion,
	});
	const deductionComponents = normalizeDeductionComponents(
		input.deductionComponents,
		{
			sourceCurrency,
			propertyCurrency,
			bookingBasis,
			conversion,
		}
	);

	let hotelRunnerProvenance = null;
	let hotelRunnerReportedAmount = null;
	if (input.hotelRunnerReportedAmount !== null && input.hotelRunnerReportedAmount !== undefined) {
			hotelRunnerProvenance = normalizeProvenance(
		input.hotelRunnerReportedAmount.provenance,
		{
			expectedProvider: provider,
				allowedSourceTypes: HOTELRUNNER_UNRESOLVED_SOURCE_TYPES,
		}
		);
		hotelRunnerReportedAmount = normalizeHotelRunnerReportedAmount(
		input.hotelRunnerReportedAmount,
		{
			bookingBasis,
			roles,
			provenance: hotelRunnerProvenance,
			sourceRef: "hotelRunner",
		}
		);
	}
	const bothCommercial = guestGross.verified && hotelPayout.verified;
	const sameCurrency = bothCommercial
		? guestGross.sourceCurrency === hotelPayout.sourceCurrency
		: null;
	const sameBasis = bothCommercial
		? guestGross.bookingBasis === hotelPayout.bookingBasis
		: null;
	const hasPartialEvidence =
		[guestGross, hotelBaseResult.role, hotelPayout, explicitOtaCommission].some(
			(role) => role.verified
		) ||
		nightlyEvidence.length > 0 ||
		deductionComponents.length > 0;
	const verificationState = deductionAggregate.verified
		? "verified"
		: hasPartialEvidence
			? "partial"
			: "unresolved";
	return finalizeEvidence({
		contractVersion: CONTRACT_VERSION,
		provider,
		sourceType,
		sourceCurrency,
		propertyCurrency,
		bookingBasis,
		verificationState,
		roles,
		nightlyEvidence,
		deductionComponents,
		hotelRunnerReportedAmount,
		reconciliation: {
			grossAndPayoutSameCurrency: sameCurrency,
			grossAndPayoutSameBasis: sameBasis,
			deductionDerived: deductionAggregate.verified,
		},
		currencyConversion: conversion,
		provenance: {
			primary,
			hotelBase: hotelBaseResult.provenance,
			hotelRunner: hotelRunnerProvenance,
			conversion: conversionProvenance,
		},
	});
}

function withHotelBaseCommercialEvidence(evidence = {}, hotelBase = null) {
	const validation = validateOtaCommercialEvidence(evidence);
	if (!validation.ok) {
		fail(
			`Existing commercial evidence is invalid: ${validation.errors.join(",")}.`,
			"INVALID_EXISTING_EVIDENCE"
		);
	}
	if (!hotelBase) return evidence;
	if (!AUTHENTICATED_SOURCE_TYPE_SET.has(evidence.sourceType)) {
		// A HotelRunner-only unresolved report cannot inherit a PMS role because
		// that would make the unresolved source appear commercially authoritative.
		return evidence;
	}

	const roleInput = (role, { explicit = false } = {}) =>
		role?.verified === true
			? {
					verified: true,
					...(explicit ? { explicit: true } : {}),
					amount: role.sourceAmount,
					currency: role.sourceCurrency,
					bookingBasis: role.bookingBasis,
			  }
			: undefined;
	const primary = evidence.provenance.primary;
	const currencyConversion = evidence.currencyConversion
		? {
				trusted: true,
				verified: true,
				sourceCurrency: evidence.currencyConversion.sourceCurrency,
				propertyCurrency: evidence.currencyConversion.propertyCurrency,
				rate: evidence.currencyConversion.rate,
				provenance: evidence.provenance.conversion,
			  }
		: undefined;
	const hotelRunnerReportedAmount = evidence.hotelRunnerReportedAmount
		? {
				amount: evidence.hotelRunnerReportedAmount.amount,
				currency: evidence.hotelRunnerReportedAmount.currency,
				bookingBasis: evidence.hotelRunnerReportedAmount.bookingBasis,
				role: evidence.hotelRunnerReportedAmount.role,
				explicitRoleAssignment:
					evidence.hotelRunnerReportedAmount.roleVerified === true,
				provenance: evidence.provenance.hotelRunner,
			  }
		: undefined;

	return buildAuthenticatedProviderCommercialEvidence({
		provider: evidence.provider,
		authenticatedProvider: evidence.provider,
		sourceAuthenticated: true,
		sourceTrusted: true,
		sourceType: evidence.sourceType,
		sourceCurrency: evidence.sourceCurrency,
		propertyCurrency: evidence.propertyCurrency,
		bookingBasis: evidence.bookingBasis,
		sourceHash: primary.sourceHash,
		sourceTimestamp: primary.sourceTimestamp,
		sourceId: primary.sourceId,
		guestGross: roleInput(evidence.roles.guestGross),
		hotelPayout: roleInput(evidence.roles.hotelPayout),
		explicitOtaCommission: roleInput(
			evidence.roles.explicitOtaCommission,
			{ explicit: true }
		),
		hotelBase,
		nightlyEvidence: evidence.nightlyEvidence.map((night) => ({
			stayDate: night.stayDate,
			guestGross: roleInput(night.guestGross),
			hotelPayout: roleInput(night.hotelPayout),
		})),
		deductionComponents: evidence.deductionComponents.map((component) => ({
			verified: true,
			componentType: component.componentType,
			direction: component.direction,
			amount: component.amount.sourceAmount,
			currency: component.amount.sourceCurrency,
			bookingBasis: component.amount.bookingBasis,
		})),
		currencyConversion,
		hotelRunnerReportedAmount,
	});
}

module.exports = {
	AUTHENTICATED_SOURCE_TYPES,
	CONTRACT_VERSION,
	OtaCommercialEvidenceError,
	buildAuthenticatedProviderCommercialEvidence,
	buildHotelRunnerUnresolvedCommercialEvidence,
	hashOtaCommercialEvidence,
	normalizeProvider,
	validateOtaCommercialEvidence,
	withHotelBaseCommercialEvidence,
};
