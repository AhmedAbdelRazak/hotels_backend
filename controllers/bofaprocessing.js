/** @format */
"use strict";

/**
 * Bank of America Merchant Services / Visa Acceptance Solutions integration:
 * - Secure Acceptance (hosted checkout)
 * - REST Payments (PTS) Virtual Card Capture
 *
 * Drop-in replacement controller with:
 * - Safer env parsing
 * - Correct HTTP Signature handling (configurable styles)
 * - Hard-coded REST endpoint hosts (no base endpoints in .env)
 * - Stronger health probe diagnostics (optional multi-host/multi-style)
 * - Safer logging (no PAN/CVV, redacts secrets)
 */

const crypto = require("crypto");
const https = require("https");
const axios = require("axios");
const util = require("util");

const Reservations = require("../models/reservations");
const HotelDetails = require("../models/hotel_details");
const Rooms = require("../models/rooms");
const User = require("../models/user");
const { getSarConversionMeta } = require("../services/otaReservationMapper");

/* =========================================================
 * Constants
 * ======================================================= */

const DEFAULT_MAX_ATTEMPTS = 2;

const RETRY_WARNING =
	"One VCC attempt failed before. One final retry is still allowed.";
const BLOCK_WARNING =
	"This reservation was prompted once before, please reach out to Ahmed Admin for more details";
const ROOM_CONFIRM_MESSAGE =
	"Are you sure you want to proceed without assigning a room to the reservation?";

const BOFA_DEBUG =
	String(process.env.BOFA_DEBUG || "true")
		.trim()
		.toLowerCase() !== "false";

/**
 * REST endpoints are intentionally hard-coded.
 * Choose which family to use via BOFA_REST_PLATFORM (not a URL).
 *
 * - visaacceptance: Visa Acceptance Solutions (VAS) domains
 * - cybersource: CyberSource domains
 * - bofa: BoA-branded domain (often only for portals; include for diagnostics)
 */
const REST_HOSTS = Object.freeze({
	visaacceptance: {
		live: "api.visaacceptance.com",
		test: "apitest.visaacceptance.com",
	},
	cybersource: {
		live: "api.cybersource.com",
		test: "apitest.cybersource.com",
	},
	bofa: {
		live: "api.merchant-services.bankofamerica.com",
		test: "api-test.merchant-services.bankofamerica.com",
	},
});

const PTS_PAYMENTS_PATH = "/pts/v2/payments";

/**
 * Signature style controls which pseudo-header name you use for request-target
 * and which date header name is signed.
 *
 * - "vas":    headers="host date request-target digest v-c-merchant-id"
 *             canonical uses "date:" + "request-target:"
 * - "vas_vc": headers="host v-c-date request-target digest v-c-merchant-id"
 *             canonical uses "v-c-date:" + "request-target:"
 * - "cs":     headers="host date (request-target) digest v-c-merchant-id"
 *             canonical uses "date:" + "(request-target):"
 */
const SIGNATURE_STYLES = Object.freeze({
	vas: {
		headersList: "host date request-target digest v-c-merchant-id",
		dateHeader: "date",
		requestTargetHeader: "request-target",
	},
	vas_vc: {
		headersList: "host v-c-date request-target digest v-c-merchant-id",
		dateHeader: "v-c-date",
		requestTargetHeader: "request-target",
	},
	vas_vc_paren: {
		headersList: "host v-c-date (request-target) digest v-c-merchant-id",
		dateHeader: "v-c-date",
		requestTargetHeader: "(request-target)",
	},
	cs: {
		headersList: "host date (request-target) digest v-c-merchant-id",
		dateHeader: "date",
		requestTargetHeader: "(request-target)",
	},
});

/**
 * Provider cardholder defaults (used for billing info / metadata)
 */
const PROVIDER_CARDS = {
	expedia: {
		cardholder: "Expedia Virtual Card",
		firstName: "Expedia",
		lastName: "VirtualCard",
	},
	agoda: {
		cardholder: "Agoda Virtual Card",
		firstName: "Agoda",
		lastName: "VirtualCard",
	},
	booking: {
		cardholder: "Booking.com Virtual Card",
		firstName: "Booking.com",
		lastName: "VirtualCard",
	},
	other: {
		cardholder: "Virtual Card",
		firstName: "Virtual",
		lastName: "Card",
	},
};

/* =========================================================
 * Logging helpers
 * ======================================================= */

const maskValue = (value = "", showHead = 6, showTail = 4) => {
	const raw = String(value || "");
	if (!raw) return "";
	if (raw.length <= showHead + showTail) return raw;
	return `${raw.slice(0, showHead)}...${raw.slice(-showTail)}`;
};

const safeLogObject = (value, maxDepth = 4) => {
	if (maxDepth <= 0) return "[depth-limited]";
	if (value == null) return value;
	if (Array.isArray(value)) {
		return value.slice(0, 20).map((item) => safeLogObject(item, maxDepth - 1));
	}
	if (typeof value !== "object") {
		if (typeof value === "string") return value.slice(0, 1200);
		return value;
	}
	const out = {};
	Object.entries(value)
		.slice(0, 120)
		.forEach(([k, v]) => {
			const exemptSignatureDiagnostic =
				/^signatureStyle$/i.test(k) ||
				/^signatureHeaders$/i.test(k) ||
				/^signatureMeta$/i.test(k) ||
				/^x-bofa-signature-headers$/i.test(k);
			if (
				!exemptSignatureDiagnostic &&
				/(card_number|number|securityCode|security_code|cvv|card_cvn|secret|shared|token|signature|authorization|password|api_key)/i.test(
					k,
				)
			) {
				out[k] = "[redacted]";
				return;
			}
			out[k] = safeLogObject(v, maxDepth - 1);
		});
	return out;
};

const toLogArg = (value) => {
	if (value == null) return value;
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return value;
	if (value instanceof Error) {
		return value.stack || value.message || String(value);
	}
	try {
		return util.inspect(value, {
			depth: 10,
			colors: false,
			compact: false,
			breakLength: 120,
			maxArrayLength: 100,
			maxStringLength: 5000,
		});
	} catch (_err) {
		return String(value);
	}
};

const bofaLog = (...args) => {
	if (!BOFA_DEBUG) return;
	console.log("[BOFA VCC]", ...args.map(toLogArg));
};

const bofaWarn = (...args) => {
	if (!BOFA_DEBUG) return;
	console.warn("[BOFA VCC][WARN]", ...args.map(toLogArg));
};

/* =========================================================
 * Small utilities
 * ======================================================= */

const toNum2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const toCCY = (n) => Number(n || 0).toFixed(2);

const csv = (v) =>
	String(v || "")
		.split(",")
		.map((x) => x.trim())
		.filter(Boolean);

const truncate = (v, max = 255) => String(v || "").slice(0, max);

const digits = (v) => String(v || "").replace(/\D/g, "");

const cleanEnvValue = (value, collapseWhitespace = false) => {
	let out = String(value || "").trim();
	if (
		(out.startsWith('"') && out.endsWith('"')) ||
		(out.startsWith("'") && out.endsWith("'"))
	) {
		out = out.slice(1, -1).trim();
	}
	if (collapseWhitespace) {
		out = out.replace(/\s+/g, "");
	}
	return out;
};

const statusNorm = (v) =>
	String(v || "")
		.trim()
		.toLowerCase()
		.replace(/\s+/g, "_");

const isCancelledOrNoShow = (status) => {
	const n = statusNorm(status);
	return n.includes("cancel") || /no[_-]?show/.test(n);
};

const maxAttempts = () => {
	const p = Number(process.env.BOFA_VCC_MAX_ATTEMPTS || DEFAULT_MAX_ATTEMPTS);
	return Number.isFinite(p) && p > 0 ? Math.floor(p) : DEFAULT_MAX_ATTEMPTS;
};

const resolveProvider = (bookingSource) => {
	const normalized = String(bookingSource || "").toLowerCase();
	if (normalized.includes("expedia")) return "expedia";
	if (normalized.includes("agoda")) return "agoda";
	if (normalized.includes("booking")) return "booking";
	return "other";
};

const resolveProviderCard = (provider) =>
	PROVIDER_CARDS[provider] || PROVIDER_CARDS.other;

const splitCardholderName = (fullName, fallback) => {
	const raw = String(fullName || "")
		.trim()
		.replace(/\s+/g, " ");
	const defaults = fallback || PROVIDER_CARDS.other;

	const normalizedRaw = raw.toLowerCase();
	const normalizedDefault = String(defaults.cardholder || "")
		.trim()
		.toLowerCase();

	if (!raw) {
		return {
			full: defaults.cardholder,
			firstName: defaults.firstName,
			lastName: defaults.lastName,
		};
	}
	if (normalizedRaw && normalizedRaw === normalizedDefault) {
		return {
			full: defaults.cardholder,
			firstName: defaults.firstName,
			lastName: defaults.lastName,
		};
	}
	const parts = raw.split(" ");
	if (parts.length === 1) {
		return { full: raw, firstName: parts[0], lastName: defaults.lastName };
	}
	return {
		full: raw,
		firstName: parts.slice(0, -1).join(" "),
		lastName: parts[parts.length - 1],
	};
};

const inferCardTypeCode = (cardNumber) => {
	if (/^4/.test(cardNumber)) return "001"; // Visa
	if (/^5[1-5]/.test(cardNumber) || /^2(2[2-9]|[3-6]\d|7[01])/.test(cardNumber))
		return "002"; // MasterCard
	if (/^3[47]/.test(cardNumber)) return "003"; // AmEx
	if (/^6(?:011|5)/.test(cardNumber)) return "004"; // Discover
	return "";
};

const normalizeExpiry = ({ expiry, expMonth, expYear }) => {
	let m = String(expMonth || "").trim();
	let y = String(expYear || "").trim();
	const e = String(expiry || "").trim();

	if ((!m || !y) && e) {
		const mt = e.match(/^(\d{1,2})\s*[/-]\s*(\d{2,4})$/);
		if (mt) {
			m = mt[1];
			y = mt[2];
		}
	}

	if (!m || !y) throw new Error("Card expiry is required.");
	const mn = Number(m);
	let yn = Number(y);

	if (!Number.isFinite(mn) || mn < 1 || mn > 12)
		throw new Error("Invalid expiry month.");
	if (!Number.isFinite(yn)) throw new Error("Invalid expiry year.");

	if (y.length === 2) yn += 2000;
	if (yn < 2000 || yn > 2099) throw new Error("Invalid expiry year.");

	return {
		month: String(mn).padStart(2, "0"),
		year: String(yn),
		display: `${String(mn).padStart(2, "0")}/${String(yn)}`,
	};
};

/* =========================================================
 * Reservation payment state helpers
 * ======================================================= */

const defaultBofaPayment = () => ({
	secure_acceptance: {
		last_signed_at: null,
		last_reference_number: "",
		last_transaction_uuid: "",
		last_callback_at: null,
		last_callback_source: "",
		last_response_signature_valid: null,
		last_request_id: "",
		last_transaction_id: "",
		last_reason_code: "",
		last_decision: "",
		last_response_payload: {},
		callbacks: [],
	},
	vcc: {
		source: "",
		charged: false,
		processing: false,
		charge_count: 0,
		attempts_count: 0,
		failed_attempts_count: 0,
		blocked_after_failure: false,
		total_captured_usd: 0,
		total_captured_sar: 0,
		last_attempt_at: null,
		last_success_at: null,
		last_failure_at: null,
		last_failure_message: "",
		last_failure_code: "",
		last_failure_http_status: null,
		last_request_id: "",
		last_transaction_id: "",
		last_reconciliation_id: "",
		last_processor_response_code: "",
		last_processor_response_details: "",
		warning_message: "",
		last_capture: {},
		metadata: {},
		attempts: [],
	},
});

const normalizeBofaPayment = (value) => {
	const base = defaultBofaPayment();
	const v = value && typeof value === "object" ? value : {};
	const sa =
		v.secure_acceptance && typeof v.secure_acceptance === "object"
			? v.secure_acceptance
			: {};
	const vv = v.vcc && typeof v.vcc === "object" ? v.vcc : {};
	return {
		secure_acceptance: {
			...base.secure_acceptance,
			...sa,
			callbacks: Array.isArray(sa.callbacks) ? sa.callbacks : [],
		},
		vcc: {
			...base.vcc,
			...vv,
			attempts: Array.isArray(vv.attempts) ? vv.attempts : [],
			last_capture:
				vv.last_capture && typeof vv.last_capture === "object"
					? vv.last_capture
					: {},
			metadata:
				vv.metadata && typeof vv.metadata === "object" ? vv.metadata : {},
		},
	};
};

const vccStatusPayload = (reservation, provider = "") => {
	const v = normalizeBofaPayment(reservation?.bofa_payment).vcc;
	const failed = Number(v.failed_attempts_count || 0);
	const max = maxAttempts();
	const charged = !!v.charged;
	const attemptedBefore = !charged && failed >= max;
	const retryAllowed = !charged && failed > 0 && failed < max;

	return {
		alreadyCharged: charged,
		processing: !!v.processing,
		attemptedBefore,
		retryAllowed,
		failedAttemptsCount: failed,
		maxAttempts: max,
		lastFailureCode: v.last_failure_code || "",
		lastFailureMessage: v.last_failure_message || "",
		lastAttemptAt: v.last_attempt_at || null,
		lastSuccessAt: v.last_success_at || null,
		lastFailureAt: v.last_failure_at || null,
		lastTransactionId: v.last_transaction_id || "",
		lastRequestId: v.last_request_id || "",
		warningMessage:
			v.warning_message ||
			(attemptedBefore ? BLOCK_WARNING : retryAllowed ? RETRY_WARNING : ""),
		provider: provider || v.source || "",
	};
};

/* =========================================================
 * Secure Acceptance signature helpers
 * ======================================================= */

const hmacBase64 = (secret, data) =>
	crypto.createHmac("sha256", secret).update(data, "utf8").digest("base64");

const buildSaDataToSign = (payload, names) =>
	names.map((n) => `${n}=${payload[n] ?? ""}`).join(",");

const verifySaSignature = (payload, secret) => {
	const names = csv(payload?.signed_field_names);
	const provided = String(payload?.signature || "");
	if (!names.length || !provided)
		return { ok: false, names, reason: "Missing signature fields." };

	const expected = hmacBase64(secret, buildSaDataToSign(payload, names));
	const a = Buffer.from(expected, "utf8");
	const b = Buffer.from(provided, "utf8");
	const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
	return { ok, names, reason: ok ? "" : "Signature mismatch." };
};

/* =========================================================
 * AuthZ
 * ======================================================= */

const requireStaff = async (req) => {
	const userId = String(req?.auth?._id || "").trim();
	if (!userId) {
		const e = new Error("Authentication required.");
		e.statusCode = 401;
		throw e;
	}
	const user = await User.findById(userId).select("role").lean();
	if (!user || Number(user.role) !== 1000) {
		const e = new Error("Access denied.");
		e.statusCode = 403;
		throw e;
	}
	return user;
};

/* =========================================================
 * Secure Acceptance callback helpers
 * ======================================================= */

const parseReservationFromSaPayload = async (payload) => {
	const md1 = String(payload?.merchant_defined_data1 || "").trim();
	if (/^[a-fA-F0-9]{24}$/.test(md1)) {
		const byId = await Reservations.findById(md1);
		if (byId) return byId;
	}
	const refs = [payload?.reference_number, payload?.req_reference_number]
		.map((x) =>
			String(x || "")
				.trim()
				.toLowerCase(),
		)
		.filter(Boolean);
	if (!refs.length) return null;
	return Reservations.findOne({ confirmation_number: { $in: refs } });
};

/* =========================================================
 * REST (PTS Payments) helpers
 * ======================================================= */

const httpsAgent = new https.Agent({
	keepAlive: true,
	maxSockets: 50,
});

const http = axios.create({
	httpsAgent,
	timeout: Number(process.env.BOFA_REST_TIMEOUT_MS || 25000),
	validateStatus: () => true,
});

const sha256Base64 = (data) =>
	crypto.createHash("sha256").update(data, "utf8").digest("base64");

const buildDigest = (bodyString) => `SHA-256=${sha256Base64(bodyString)}`;

/**
 * Resolve REST platform/environment without taking URLs from .env
 */
const resolveRestPlatform = () => {
	const raw = cleanEnvValue(process.env.BOFA_REST_PLATFORM || "visaacceptance")
		.toLowerCase()
		.trim();
	if (raw === "cybersource" || raw === "cs") return "cybersource";
	if (raw === "bofa" || raw === "bankofamerica") return "bofa";
	return "visaacceptance";
};

const resolveRestEnv = () => {
	const raw = cleanEnvValue(process.env.BOFA_REST_ENV || "").toLowerCase();
	if (raw === "live" || raw === "prod" || raw === "production") return "live";
	if (raw === "test" || raw === "sandbox" || raw === "stage") return "test";
	// default heuristic: production => live, everything else => test
	const nodeEnv = cleanEnvValue(process.env.NODE_ENV || "").toLowerCase();
	return nodeEnv === "production" ? "live" : "test";
};

const resolveSignatureStyle = (platform) => {
	const raw = cleanEnvValue(process.env.BOFA_REST_SIGNATURE_STYLE || "")
		.toLowerCase()
		.trim();
	if (raw && SIGNATURE_STYLES[raw]) return raw;
	// Sensible defaults:
	// - CyberSource frequently documents (request-target) style.
	// - Visa Acceptance latest auth examples commonly use v-c-date + request-target.
	if (platform === "cybersource") return "cs";
	return "vas_vc";
};

const getRestRuntimeConfig = () => {
	const platform = resolveRestPlatform();
	const env = resolveRestEnv();
	const host = REST_HOSTS?.[platform]?.[env] || REST_HOSTS.visaacceptance[env];

	const merchantId = cleanEnvValue(process.env.BOFA_REST_MERCHANT_ID, true);
	const keyId = cleanEnvValue(process.env.BOFA_REST_KEY_ID, true);
	const secretB64 = cleanEnvValue(
		process.env.BOFA_REST_SHARED_SECRET_B64,
		true,
	);

	const signatureStyle = resolveSignatureStyle(platform);

	const nodeEnv = cleanEnvValue(process.env.NODE_ENV || "").toLowerCase();

	return {
		platform,
		env,
		host,
		merchantId,
		keyId,
		secretB64,
		signatureStyle,
		nodeEnv,
	};
};

const evaluateRestRuntimeConfig = (cfg) => {
	const warnings = [];
	const errors = [];

	if (!cfg.host) errors.push("REST host could not be resolved.");
	if (!cfg.merchantId) errors.push("BOFA_REST_MERCHANT_ID is missing.");
	if (!cfg.keyId) errors.push("BOFA_REST_KEY_ID is missing.");
	if (!cfg.secretB64) errors.push("BOFA_REST_SHARED_SECRET_B64 is missing.");

	if (cfg.merchantId && /^\d+$/.test(cfg.merchantId)) {
		warnings.push(
			"BOFA_REST_MERCHANT_ID is numeric-only. Verify you are using the REST transacting merchant id (often starts with mcn_), not only the MID.",
		);
	}
	if (
		cfg.merchantId &&
		!/^mcn_/i.test(cfg.merchantId) &&
		cfg.platform === "visaacceptance"
	) {
		warnings.push(
			"BOFA_REST_MERCHANT_ID does not start with 'mcn_'. That can be fine, but double-check you're using the REST transacting merchant id.",
		);
	}
	if (cfg.env === "live" && cfg.nodeEnv && cfg.nodeEnv !== "production") {
		warnings.push(
			"REST env=live but NODE_ENV is not production. Ensure you are intentionally using LIVE credentials.",
		);
	}
	if (cfg.env === "test" && cfg.nodeEnv === "production") {
		warnings.push(
			"REST env=test but NODE_ENV=production. Ensure you did not accidentally deploy test credentials to production.",
		);
	}
	if (!SIGNATURE_STYLES[cfg.signatureStyle]) {
		errors.push(
			`Invalid BOFA_REST_SIGNATURE_STYLE '${
				cfg.signatureStyle
			}'. Valid: ${Object.keys(SIGNATURE_STYLES).join(", ")}.`,
		);
	}

	return { warnings, errors };
};

const decodeSharedSecret = (secretB64) => {
	const raw = cleanEnvValue(secretB64, true);
	if (!raw) {
		const e = new Error("Invalid BOFA_REST_SHARED_SECRET_B64 (empty).");
		e.issue = "BOFA_REST_SECRET_INVALID";
		e.statusCode = 500;
		throw e;
	}
	const normalized = raw.replace(/-/g, "+").replace(/_/g, "/");
	if (/[^A-Za-z0-9+/=]/.test(normalized)) {
		const e = new Error(
			"Invalid BOFA_REST_SHARED_SECRET_B64 (contains non-base64 characters).",
		);
		e.issue = "BOFA_REST_SECRET_INVALID";
		e.statusCode = 500;
		throw e;
	}
	const padded = normalized.padEnd(
		normalized.length + ((4 - (normalized.length % 4 || 4)) % 4),
		"=",
	);
	const buf = Buffer.from(padded, "base64");
	if (!buf || buf.length === 0) {
		const e = new Error(
			"Invalid BOFA_REST_SHARED_SECRET_B64 (base64 decode failed).",
		);
		e.issue = "BOFA_REST_SECRET_INVALID";
		e.statusCode = 500;
		throw e;
	}
	const roundtrip = buf.toString("base64").replace(/=+$/g, "");
	const sourceNoPad = padded.replace(/=+$/g, "");
	if (roundtrip !== sourceNoPad) {
		const e = new Error(
			"Invalid BOFA_REST_SHARED_SECRET_B64 (roundtrip validation failed).",
		);
		e.issue = "BOFA_REST_SECRET_INVALID";
		e.statusCode = 500;
		throw e;
	}
	return buf;
};

const buildHttpSignatureHeaders = (
	{ host, merchantId, keyId, secretB64, signatureStyle },
	{ method, path, bodyString },
) => {
	const style = SIGNATURE_STYLES[signatureStyle] || SIGNATURE_STYLES.vas_vc;

	// RFC1123 UTC string
	const rfc1123 = new Date().toUTCString();

	const digest = buildDigest(bodyString || "");

	// Compute request-target value (path only; include query if present)
	const requestTargetValue = `${String(method || "GET").toLowerCase()} ${path}`;

	// Build canonical string in the exact order indicated by headersList
	// Note: request-target / (request-target) are pseudo headers (not transmitted), but included in signature.
	const canonicalLines = [];
	const add = (name, value) => canonicalLines.push(`${name}: ${value}`);

	// Style determines which date header name is signed and which pseudo-header name is used.
	add("host", host);

	if (style.dateHeader === "date") add("date", rfc1123);
	if (style.dateHeader === "v-c-date") add("v-c-date", rfc1123);

	if (style.requestTargetHeader === "request-target")
		add("request-target", requestTargetValue);
	if (style.requestTargetHeader === "(request-target)")
		add("(request-target)", requestTargetValue);

	add("digest", digest);
	add("v-c-merchant-id", merchantId);

	const canonical = canonicalLines.join("\n");

	const secret = decodeSharedSecret(secretB64);
	const signature = crypto
		.createHmac("sha256", secret)
		.update(canonical, "utf8")
		.digest("base64");

	// Build outbound headers
	const includeBothDateHeaders =
		String(process.env.BOFA_REST_INCLUDE_BOTH_DATE_HEADERS || "")
			.trim()
			.toLowerCase() === "true";
	const headers = {
		Accept: "application/json",
		"Content-Type": "application/json",
		Host: host, // Node will normalize
		Digest: digest,
		"v-c-merchant-id": merchantId,
		Signature: `keyid="${keyId}", algorithm="HmacSHA256", headers="${style.headersList}", signature="${signature}"`,
	};
	if (style.dateHeader === "date") {
		headers.Date = rfc1123;
		if (includeBothDateHeaders) headers["v-c-date"] = rfc1123;
	} else {
		headers["v-c-date"] = rfc1123;
		if (includeBothDateHeaders) headers.Date = rfc1123;
	}

	const maskedMerchant = maskValue(merchantId, 3, 2);
	const canonicalSafe = canonical.replace(
		new RegExp(merchantId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
		maskedMerchant,
	);
	return {
		headers,
		meta: {
			signatureStyle,
			signatureHeaders: style.headersList,
			dateHeader: style.dateHeader,
			requestTargetHeader: style.requestTargetHeader,
			digest,
			canonicalSha256: sha256Base64(canonical),
			canonicalPreview: canonicalSafe,
			includeBothDateHeaders,
		},
	};
};

const classifyProbeResult = ({ httpStatus, bodyText }) => {
	if (httpStatus === 401)
		return {
			code: "AUTHENTICATION_FAILED",
			readyForCharge: false,
			message:
				"Authentication failed (401). Usually wrong keyId/shared secret, incorrect signature canonical string, or merchant binding mismatch.",
		};
	if (httpStatus === 403)
		return {
			code: "AUTHORIZATION_FAILED",
			readyForCharge: false,
			message:
				"Authorization failed (403). Merchant may lack REST Payments permission/provisioning.",
		};
	if (httpStatus === 404)
		return {
			code: "RESOURCE_NOT_FOUND",
			readyForCharge: false,
			message:
				"Resource not found (404). Common causes: wrong environment host (live vs test), wrong REST transacting merchant id (v-c-merchant-id), wrong platform host family, or REST Payments (PTS) not provisioned on this merchant profile.",
		};
	if (httpStatus === 400)
		return {
			code: "ENDPOINT_REACHABLE_INVALID_PAYLOAD",
			readyForCharge: true,
			message:
				"Endpoint reachable and signature accepted (400). Probe payload intentionally invalid; this is a good sign.",
		};
	if (httpStatus >= 200 && httpStatus < 300)
		return {
			code: "ENDPOINT_REACHABLE",
			readyForCharge: true,
			message: "Endpoint reachable and accepted probe payload.",
		};
	if (httpStatus >= 500)
		return {
			code: "GATEWAY_SERVER_ERROR",
			readyForCharge: false,
			message: "Gateway server error (5xx). Retry later or contact support.",
		};
	return {
		code: "UNEXPECTED_STATUS",
		readyForCharge: false,
		message: `Unexpected status from probe: ${
			httpStatus || "unknown"
		} (${truncate(bodyText || "", 120)})`,
	};
};

const restPostJson = async ({ host, path, bodyObj, cfg, requestId }) => {
	const body = JSON.stringify(bodyObj ?? {});
	const signed = buildHttpSignatureHeaders(cfg, {
		method: "POST",
		path,
		bodyString: body,
	});
	const headers = signed.headers;
	if (requestId) headers["x-request-id"] = requestId;

	const startedAt = Date.now();
	const res = await http.request({
		method: "POST",
		url: `https://${host}${path}`,
		headers,
		// IMPORTANT: send raw string so Digest and signature always match the bytes
		data: body,
		transformRequest: [(d) => d],
		maxBodyLength: 1024 * 1024, // 1MB
	});

	const durationMs = Date.now() - startedAt;
	const rawData = res?.data;

	const responseText =
		typeof rawData === "string" ? rawData.slice(0, 2000) : "";
	const responseJson =
		rawData && typeof rawData === "object" ? safeLogObject(rawData, 10) : {};

	const httpStatus = res?.status || 0;
	const httpStatusText = String(res?.statusText || "");

	const correlationId = String(
		res?.headers?.["v-c-correlation-id"] ||
			res?.headers?.["x-correlation-id"] ||
			res?.headers?.["X-Correlation-ID"] ||
			"",
	);

	return {
		httpStatus,
		httpStatusText,
		correlationId,
		durationMs,
		responseText,
		responseJson,
		data: rawData,
		headers: res?.headers || {},
		signatureMeta: signed.meta,
	};
};

const runRestHealthProbe = async (
	cfg,
	{ hostOverride, signatureStyleOverride } = {},
) => {
	const host = hostOverride || cfg.host;
	const signatureStyle = signatureStyleOverride || cfg.signatureStyle;

	const path = PTS_PAYMENTS_PATH;

	// Intentionally incomplete payload to avoid creating an authorization/capture.
	// A reachable + authenticated endpoint should respond 400 (validation error).
	const bodyObj = {
		clientReferenceInformation: {
			code: `health-probe-${Date.now()}`,
		},
		merchantInformation: {
			transactionLocalDateTime: new Date().toISOString(),
		},
		orderInformation: {
			amountDetails: {
				totalAmount: "1.00",
				currency: "USD",
			},
		},
	};

	const requestId = `bofa-health:${Date.now()}:${crypto
		.randomUUID()
		.slice(0, 8)}`;

	const probeCfg = { ...cfg, host, signatureStyle };

	bofaLog("health probe request prepared", {
		requestId,
		url: `https://${host}${path}`,
		platform: probeCfg.platform,
		env: probeCfg.env,
		signatureStyle: probeCfg.signatureStyle,
		signatureHeaders:
			SIGNATURE_STYLES[probeCfg.signatureStyle]?.headersList || "",
		samplePayload: safeLogObject(bodyObj, 6),
	});

	const resp = await restPostJson({
		host,
		path,
		bodyObj,
		cfg: probeCfg,
		requestId,
	});

	const httpStatus = resp.httpStatus;
	const classification = classifyProbeResult({
		httpStatus,
		bodyText: resp.responseText,
	});
	if (httpStatus === 401 && resp?.responseJson?.response) {
		classification.message = `${
			classification.message
		} Provider response: ${truncate(
			JSON.stringify(resp.responseJson.response),
			600,
		)}`;
	}

	return {
		requestId,
		host,
		path,
		url: `https://${host}${path}`,
		signatureStyle: probeCfg.signatureStyle,
		httpStatus: resp.httpStatus,
		httpStatusText: resp.httpStatusText,
		correlationId: resp.correlationId,
		durationMs: resp.durationMs,
		classification,
		signatureMeta: resp.signatureMeta || {},
		responseText: resp.responseText,
		responseJson: resp.responseJson,
	};
};

const roomNumbersFromReservation = async (reservation) => {
	const set = new Set();
	const add = (v) => {
		const s = String(v || "").trim();
		if (s) set.add(s);
	};

	(Array.isArray(reservation?.roomDetails)
		? reservation.roomDetails
		: []
	).forEach((room) =>
		add(room?.room_number || room?.roomNumber || room?.number),
	);
	(Array.isArray(reservation?.bedNumber) ? reservation.bedNumber : []).forEach(
		add,
	);

	const ids = (Array.isArray(reservation?.roomId) ? reservation.roomId : [])
		.map((x) => (typeof x === "object" ? x?._id : x))
		.filter(Boolean)
		.map((x) => String(x));

	if (ids.length) {
		const rooms = await Rooms.find({ _id: { $in: ids } })
			.select("room_number")
			.lean();
		(rooms || []).forEach((r) => add(r?.room_number));
	}

	return Array.from(set);
};

/* =========================================================
 * Controllers
 * ======================================================= */

exports.createGuestCheckoutSession = async (req, res) => {
	try {
		const {
			reservationId,
			hotelId = "",
			amount,
			currency = "USD",
			transactionType = "sale",
			locale = process.env.BOFA_SA_LOCALE || "en-us",
			referenceNumber = "",
			billTo = {},
		} = req.body || {};

		if (!reservationId)
			return res.status(400).json({
				success: false,
				issue: "BOFA_SA_RESERVATION_ID_REQUIRED",
				message: "reservationId is required.",
			});
		if (!(Number(amount) > 0))
			return res.status(400).json({
				success: false,
				issue: "BOFA_SA_INVALID_AMOUNT",
				message: "Valid amount is required.",
			});
		if (
			!["sale", "authorization"].includes(String(transactionType).toLowerCase())
		)
			return res.status(400).json({
				success: false,
				issue: "BOFA_SA_INVALID_TRANSACTION_TYPE",
				message: "transactionType must be sale or authorization.",
			});

		const profileId = cleanEnvValue(process.env.BOFA_SA_PROFILE_ID);
		const accessKey = cleanEnvValue(process.env.BOFA_SA_ACCESS_KEY);
		const secretKey = cleanEnvValue(process.env.BOFA_SA_SECRET_KEY);
		const endpoint = cleanEnvValue(process.env.BOFA_SA_ENDPOINT);

		if (!profileId || !accessKey || !secretKey || !endpoint)
			return res.status(500).json({
				success: false,
				issue: "BOFA_SA_CONFIG_MISSING",
				message: "Secure Acceptance credentials are missing.",
			});

		const fields = {
			access_key: accessKey,
			profile_id: profileId,
			transaction_uuid: crypto.randomUUID(),
			signed_date_time: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
			signed_field_names: "",
			unsigned_field_names: "card_type,card_number,card_expiry_date,card_cvn",
			reference_number: truncate(
				referenceNumber || `RES-${reservationId}-${Date.now()}`,
				50,
			),
			amount: toCCY(amount),
			currency: truncate(String(currency || "USD").toUpperCase(), 3),
			locale: truncate(String(locale || "en-us").toLowerCase(), 10),
			payment_method: "card",
			transaction_type: String(transactionType).toLowerCase(),
			merchant_defined_data1: truncate(String(reservationId), 100),
			merchant_defined_data2: truncate(String(hotelId || "N/A"), 100),
			merchant_defined_data3: "RESERVATION",
		};

		if (process.env.BOFA_SA_MERCHANT_POST_URL)
			fields.override_backoffice_post_url = truncate(
				process.env.BOFA_SA_MERCHANT_POST_URL,
				255,
			);
		if (process.env.BOFA_SA_CUSTOMER_RESPONSE_URL)
			fields.override_custom_receipt_page = truncate(
				process.env.BOFA_SA_CUSTOMER_RESPONSE_URL,
				255,
			);
		if (process.env.BOFA_SA_CANCEL_RESPONSE_URL)
			fields.override_custom_cancel_page = truncate(
				process.env.BOFA_SA_CANCEL_RESPONSE_URL,
				255,
			);

		// bill_to fields (optional)
		if (billTo.firstName)
			fields.bill_to_forename = truncate(billTo.firstName, 60);
		if (billTo.lastName) fields.bill_to_surname = truncate(billTo.lastName, 60);
		if (billTo.email) fields.bill_to_email = truncate(billTo.email, 255);
		if (billTo.phone || billTo.phoneNumber)
			fields.bill_to_phone = truncate(billTo.phone || billTo.phoneNumber, 20);
		if (billTo.address1 || billTo.addressLine1)
			fields.bill_to_address_line1 = truncate(
				billTo.address1 || billTo.addressLine1,
				60,
			);
		if (billTo.city || billTo.locality)
			fields.bill_to_address_city = truncate(
				billTo.city || billTo.locality,
				50,
			);
		if (billTo.state || billTo.administrativeArea)
			fields.bill_to_address_state = truncate(
				billTo.state || billTo.administrativeArea,
				20,
			);
		if (billTo.postalCode || billTo.postal_code)
			fields.bill_to_address_postal_code = truncate(
				billTo.postalCode || billTo.postal_code,
				14,
			);
		if (billTo.country || billTo.countryCode)
			fields.bill_to_address_country = truncate(
				String(billTo.country || billTo.countryCode).toUpperCase(),
				2,
			);

		// Sign all fields except signature itself, plus signed_field_names
		const signed = Object.keys(fields)
			.filter((k) => k !== "signature" && k !== "signed_field_names")
			.concat(["signed_field_names"]);

		fields.signed_field_names = signed.join(",");
		fields.signature = hmacBase64(secretKey, buildSaDataToSign(fields, signed));

		const reservation = await Reservations.findById(reservationId);
		if (reservation) {
			const b = normalizeBofaPayment(reservation?.bofa_payment);
			b.secure_acceptance.last_signed_at = new Date();
			b.secure_acceptance.last_reference_number = fields.reference_number;
			b.secure_acceptance.last_transaction_uuid = fields.transaction_uuid;
			reservation.bofa_payment = b;
			await reservation.save();
		}

		return res
			.status(200)
			.json({ success: true, endpointUrl: endpoint, method: "POST", fields });
	} catch (error) {
		console.error("createGuestCheckoutSession error:", error);
		return res.status(500).json({
			success: false,
			issue: "BOFA_SA_SESSION_FAILED",
			message: error?.message || "Failed to create Secure Acceptance session.",
		});
	}
};

exports.verifyCheckoutResponseSignature = async (req, res) => {
	try {
		const secret = cleanEnvValue(process.env.BOFA_SA_SECRET_KEY);
		if (!secret)
			return res.status(500).json({
				success: false,
				issue: "BOFA_SA_CONFIG_MISSING",
				message: "BOFA_SA_SECRET_KEY is missing.",
			});

		const v = verifySaSignature(req.body || {}, secret);
		const p = req.body || {};

		return res.status(v.ok ? 200 : 400).json({
			success: v.ok,
			signatureValid: v.ok,
			reason: v.reason || "",
			decision: String(p?.decision || ""),
			reasonCode: String(p?.reason_code || ""),
			requestId: String(p?.req_request_id || p?.request_id || ""),
			transactionId: String(p?.transaction_id || ""),
			referenceNumber: String(
				p?.req_reference_number || p?.reference_number || "",
			),
		});
	} catch (error) {
		return res.status(500).json({
			success: false,
			issue: "BOFA_SA_VERIFY_FAILED",
			message: error?.message || "Failed to verify response signature.",
		});
	}
};

const handleSaCallback = async (req, res, source) => {
	try {
		const payload = req.body || {};
		const secret = cleanEnvValue(process.env.BOFA_SA_SECRET_KEY);
		const v = secret
			? verifySaSignature(payload, secret)
			: { ok: false, reason: "Missing secret.", names: [] };

		const reservation = await parseReservationFromSaPayload(payload);

		if (reservation) {
			const names = v.names || csv(payload?.signed_field_names);

			const signedSubset = {};
			names.forEach((n) => {
				if (/(card_number|card_cvn|security_code|cvn)/i.test(n)) return;
				signedSubset[n] = payload?.[n] ?? "";
			});
			signedSubset.signature = payload?.signature || "";

			const b = normalizeBofaPayment(reservation?.bofa_payment);
			const sa = b.secure_acceptance;
			const now = new Date();
			const decision = String(payload?.decision || "").toUpperCase();
			const reasonCode = String(payload?.reason_code || "");

			const callback = {
				at: now,
				source,
				signature_valid: !!v.ok,
				signature_reason: v.reason || "",
				decision,
				reason_code: reasonCode,
				request_id: String(
					payload?.req_request_id || payload?.request_id || "",
				),
				transaction_id: String(payload?.transaction_id || ""),
				reference_number: String(
					payload?.req_reference_number || payload?.reference_number || "",
				),
				reconciliation_id: String(payload?.reconciliation_id || ""),
				payload: signedSubset,
			};

			sa.last_callback_at = now;
			sa.last_callback_source = source;
			sa.last_response_signature_valid = !!v.ok;
			sa.last_reason_code = reasonCode;
			sa.last_decision = decision;
			sa.last_request_id = callback.request_id;
			sa.last_transaction_id = callback.transaction_id;
			sa.last_response_payload = signedSubset;
			sa.callbacks.push(callback);

			reservation.bofa_payment = b;

			if (v.ok && decision === "ACCEPT" && reasonCode === "100") {
				reservation.payment_details = {
					...(reservation.payment_details || {}),
					bofaSaAccepted: true,
					bofaSaAcceptedAt: now,
					bofaSaTransactionId: callback.transaction_id,
				};
			}

			await reservation.save();
		}

		return res
			.status(200)
			.json({ success: true, received: true, source, signatureValid: !!v.ok });
	} catch (error) {
		console.error(`handleSaCallback(${source}) error:`, error);
		// return 200 to avoid endless retries from gateway, but indicate failure in body
		return res.status(200).json({ success: false, received: true, source });
	}
};

exports.handleCustomerResponsePagePost = async (req, res) =>
	handleSaCallback(req, res, "customer_response");

exports.handleMerchantPostNotification = async (req, res) =>
	handleSaCallback(req, res, "merchant_post");

/**
 * GET /api/bofa/health?probe=true&all=false
 *
 * - probe=true: run a safe probe against configured host
 * - all=true: additionally probe other host families + signature styles to help diagnose 404s
 */
exports.getBofaVccHealth = async (req, res) => {
	try {
		await requireStaff(req);

		const cfg = getRestRuntimeConfig();
		const checks = evaluateRestRuntimeConfig(cfg);

		const probeRequested =
			String(req.query?.probe ?? "true").toLowerCase() !== "false";
		const probeAll = String(req.query?.all ?? "false").toLowerCase() === "true";

		const health = {
			success: true,
			timestamp: new Date().toISOString(),
			config: {
				platform: cfg.platform,
				env: cfg.env,
				host: cfg.host,
				nodeEnv: cfg.nodeEnv || "",
				merchantId: maskValue(cfg.merchantId, 3, 2),
				keyId: maskValue(cfg.keyId, 8, 4),
				secretConfigured: !!cfg.secretB64,
				signatureStyle: cfg.signatureStyle,
			},
			checks,
			probeRequested,
			readyForCharge: false,
			recommendations: [
				"BOFA_REST_MERCHANT_ID must be the REST transacting merchant id from key management (often starts with mcn_).",
				"Make sure REST env (BOFA_REST_ENV) matches where the key was generated (test vs live).",
				"If you consistently get 404 on /pts/v2/payments, your merchant may not have REST Payments (PTS) provisioned.",
				"If you get 401/403, check signature style (BOFA_REST_SIGNATURE_STYLE) and key/shared secret pairing.",
			],
		};

		if (!probeRequested) {
			health.readyForCharge = checks.errors.length === 0;
			return res.status(200).json(health);
		}

		if (checks.errors.length > 0) {
			health.probe = {
				skipped: true,
				reason: "Missing required REST configuration values.",
			};
			health.readyForCharge = false;
			return res.status(200).json(health);
		}

		try {
			const probe = await runRestHealthProbe(cfg);
			health.probe = probe;
			health.readyForCharge =
				checks.errors.length === 0 && !!probe?.classification?.readyForCharge;

			// If asked, try other hosts & signature styles to help you diagnose "404 everywhere"
			if (probeAll) {
				const candidates = [];

				// Try all host families with both envs (live/test), but keep total attempts bounded
				const hostFamilies = ["visaacceptance", "cybersource", "bofa"];
				const envs = ["live", "test"];
				const styles = Object.keys(SIGNATURE_STYLES);

				hostFamilies.forEach((platform) => {
					envs.forEach((env) => {
						const host = REST_HOSTS?.[platform]?.[env];
						if (!host) return;
						styles.forEach((style) => {
							candidates.push({ platform, env, host, style });
						});
					});
				});

				// Execute up to 10 probes max to avoid hammering provider
				const results = [];
				for (const c of candidates.slice(0, 10)) {
					try {
						const r = await runRestHealthProbe(
							{ ...cfg, platform: c.platform, env: c.env, host: c.host },
							{ hostOverride: c.host, signatureStyleOverride: c.style },
						);
						results.push(r);
						// If any looks good (400/2xx), keep it in results but don't spam more
						if (r?.classification?.readyForCharge) break;
					} catch (e) {
						results.push({
							host: c.host,
							signatureStyle: c.style,
							error: { message: e?.message || "Probe failed." },
						});
					}
				}

				health.diagnostics = {
					probesRun: results.length,
					probes: results,
				};
			}

			bofaLog("health probe result", safeLogObject(health, 10));
			return res.status(200).json(health);
		} catch (probeError) {
			health.probe = {
				skipped: false,
				error: {
					message: probeError?.message || "Probe failed.",
					issue: probeError?.issue || "BOFA_HEALTH_PROBE_FAILED",
				},
			};
			health.readyForCharge = false;
			bofaWarn("health probe failed", {
				message: probeError?.message || "",
				issue: probeError?.issue || "",
			});
			return res.status(200).json(health);
		}
	} catch (error) {
		return res.status(error?.statusCode || 500).json({
			success: false,
			issue: "BOFA_VCC_HEALTH_FAILED",
			message: error?.message || "Failed to run BoA VCC health check.",
		});
	}
};

exports.getReservationBofaVccStatus = async (req, res) => {
	try {
		await requireStaff(req);

		const reservationId = String(req.params?.reservationId || "").trim();
		bofaLog("status requested", {
			reservationId,
			userId: req?.auth?._id || "",
		});

		if (!reservationId)
			return res
				.status(400)
				.json({ success: false, message: "reservationId is required." });

		const reservation = await Reservations.findById(reservationId).lean();
		if (!reservation)
			return res
				.status(404)
				.json({ success: false, message: "Reservation not found." });

		const provider = resolveProvider(reservation?.booking_source);

		return res.status(200).json({
			success: true,
			...vccStatusPayload(reservation, provider),
			state: normalizeBofaPayment(reservation?.bofa_payment).vcc,
		});
	} catch (error) {
		bofaWarn("status lookup failed", {
			statusCode: error?.statusCode || null,
			message: error?.message || "",
		});
		return res.status(error?.statusCode || 500).json({
			success: false,
			issue: "BOFA_VCC_STATUS_FAILED",
			message: error?.message || "Failed to fetch BoA VCC status.",
		});
	}
};

exports.captureReservationVccSale = async (req, res) => {
	let reservationId = "";
	let lockAcquired = false;
	let providerAttemptSubmitted = false;

	try {
		await requireStaff(req);

		reservationId = String(req.body?.reservationId || "").trim();
		bofaLog("capture request received", {
			reservationId,
			userId: req?.auth?._id || "",
			hasCardObject: !!req.body?.card,
			hasBillingAddress: !!req.body?.billingAddress,
			proceedWithoutRoom: !!req.body?.proceedWithoutRoom,
			rawAmount: req.body?.usdAmount || req.body?.amount || null,
		});

		if (!reservationId)
			return res.status(400).json({
				success: false,
				issue: "BOFA_VCC_RESERVATION_ID_REQUIRED",
				message: "reservationId is required.",
			});

		const amountUsd = toNum2(req.body?.usdAmount || req.body?.amount);
		if (!(amountUsd > 0))
			return res.status(400).json({
				success: false,
				issue: "BOFA_VCC_INVALID_AMOUNT",
				message: "Please provide a valid amount in USD.",
			});
		const amountConversion = getSarConversionMeta(amountUsd, "USD");
		const amountSar = toNum2(amountConversion.totalAmountSar);

		// Normalize card input
		const rawCard = req.body?.card || {};
		const cardNumber = digits(rawCard.number || req.body?.cardNumber);
		const cardCVV = digits(rawCard.cvv || req.body?.cardCVV);
		const expiry = normalizeExpiry({
			expiry: rawCard.expiry || req.body?.cardExpiry,
			expMonth: rawCard.expMonth || req.body?.cardExpMonth,
			expYear: rawCard.expYear || req.body?.cardExpYear,
		});
		const cardTypeCode = String(
			rawCard.type || req.body?.cardType || inferCardTypeCode(cardNumber) || "",
		).trim();

		bofaLog("card payload normalized", {
			reservationId,
			amountUsd,
			amountSar,
			cardLast4: cardNumber ? cardNumber.slice(-4) : "",
			cardLength: cardNumber.length,
			cvvLength: cardCVV.length,
			expiry: expiry?.display || "",
			cardTypeCode,
		});

		if (!cardNumber || cardNumber.length < 12 || cardNumber.length > 19)
			return res.status(400).json({
				success: false,
				issue: "BOFA_VCC_INVALID_CARD_NUMBER",
				message: "Card number is invalid.",
			});
		if (!cardCVV || cardCVV.length < 3 || cardCVV.length > 4)
			return res.status(400).json({
				success: false,
				issue: "BOFA_VCC_INVALID_CVV",
				message: "CVV is invalid.",
			});
		if (!cardTypeCode)
			return res.status(400).json({
				success: false,
				issue: "BOFA_VCC_CARD_TYPE_REQUIRED",
				message: "Card type could not be inferred (or provided).",
			});

		const snapshot = await Reservations.findById(reservationId).lean();
		if (!snapshot)
			return res.status(404).json({
				success: false,
				issue: "BOFA_VCC_RESERVATION_NOT_FOUND",
				message: "Reservation not found.",
			});
		const sourceVccMetadata =
			snapshot?.vcc_payment?.metadata &&
			typeof snapshot.vcc_payment.metadata === "object"
				? snapshot.vcc_payment.metadata
				: {};

		const provider = resolveProvider(snapshot?.booking_source);
		const status = vccStatusPayload(snapshot, provider);

		bofaLog("reservation + status resolved", {
			reservationId,
			confirmationNumber: snapshot?.confirmation_number || "",
			bookingSource: snapshot?.booking_source || "",
			reservationStatus: snapshot?.reservation_status || "",
			provider,
			statusSnapshot: safeLogObject(status),
		});

		if (status.alreadyCharged)
			return res.status(409).json({
				success: false,
				issue: "BOFA_VCC_ALREADY_CHARGED",
				message: "This reservation was already charged via VCC.",
				alreadyCharged: true,
				bofaStatus: status,
			});

		if (status.attemptedBefore)
			return res.status(409).json({
				success: false,
				issue: "BOFA_VCC_ATTEMPTS_EXHAUSTED",
				message: status.warningMessage || BLOCK_WARNING,
				attemptedBefore: true,
				bofaStatus: status,
			});

		const rooms = await roomNumbersFromReservation(snapshot);
		const proceedWithoutRoom = !!req.body?.proceedWithoutRoom;

		bofaLog("room validation", {
			reservationId,
			rooms,
			roomCount: rooms.length,
			proceedWithoutRoom,
			reservationCancelledOrNoShow: isCancelledOrNoShow(
				snapshot?.reservation_status,
			),
		});

		if (
			!isCancelledOrNoShow(snapshot?.reservation_status) &&
			rooms.length === 0 &&
			!proceedWithoutRoom
		) {
			return res.status(409).json({
				success: false,
				issue: "BOFA_VCC_ROOM_CONFIRM_REQUIRED",
				message:
					"Room assignment is missing for this reservation. Confirm you want to proceed without a room assignment.",
				confirmationMessage: ROOM_CONFIRM_MESSAGE,
				bofaStatus: status,
			});
		}

		// Acquire processing lock (best-effort)
		const lock = await Reservations.findOneAndUpdate(
			{ _id: reservationId, "bofa_payment.vcc.processing": { $ne: true } },
			{
				$set: {
					"bofa_payment.vcc.processing": true,
					"bofa_payment.vcc.last_attempt_at": new Date(),
					"bofa_payment.vcc.source": provider,
				},
			},
			{ new: true },
		);

		if (!lock)
			return res.status(409).json({
				success: false,
				issue: "BOFA_VCC_ALREADY_PROCESSING",
				message:
					"A BoA VCC charge is already in progress for this reservation.",
			});

		lockAcquired = true;

		bofaLog("processing lock acquired", {
			reservationId,
			lockSource: lock?.bofa_payment?.vcc?.source || provider,
			lockAttemptAt: lock?.bofa_payment?.vcc?.last_attempt_at || null,
		});

		const reservation = await Reservations.findById(reservationId);
		if (!reservation)
			return res.status(404).json({
				success: false,
				issue: "BOFA_VCC_RESERVATION_NOT_FOUND",
				message: "Reservation not found.",
			});

		const hotel = reservation?.hotelId
			? await HotelDetails.findById(reservation.hotelId)
					.select("hotelName")
					.lean()
			: null;

		// REST config
		const cfg = getRestRuntimeConfig();
		const checks = evaluateRestRuntimeConfig(cfg);

		bofaLog("rest config resolved", {
			reservationId,
			host: cfg.host,
			platform: cfg.platform,
			env: cfg.env,
			signatureStyle: cfg.signatureStyle,
			merchantId: maskValue(cfg.merchantId, 3, 2),
			keyId: maskValue(cfg.keyId, 8, 4),
			secretConfigured: !!cfg.secretB64,
			checkWarnings: checks.warnings,
			checkErrors: checks.errors,
		});

		if (checks.errors.length > 0) {
			const configError = new Error(checks.errors.join(" "));
			configError.statusCode = 500;
			configError.issue = "BOFA_REST_CONFIG_MISSING";
			throw configError;
		}

		// Build request payload
		const requestId = `bofa-vcc:${reservationId}:${Date.now()}:${crypto
			.randomUUID()
			.slice(0, 8)}`;

		const refCode = truncate(
			`VCC-${snapshot?.confirmation_number || reservationId}-${Date.now()}`,
			50,
		);

		const billing = req.body?.billingAddress || {};
		const providerCard = resolveProviderCard(provider);
		const cardholder = splitCardholderName(
			req.body?.cardholderName ||
				billing.cardholderName ||
				providerCard.cardholder,
			providerCard,
		);

		const postalCode = truncate(
			String(
				billing.postalCode ||
					billing.postal_code ||
					req.body?.postalCode ||
					"98119",
			).toUpperCase(),
			14,
		);

		const normalizedPostal = postalCode.replace(/[^A-Z0-9]/g, "");
		const isIrishZip = normalizedPostal === "D02XF99";

		const expediaDefaultAddress = isIrishZip
			? {
					address1: "25 St Stephen's Green",
					locality: "Dublin 2",
					administrativeArea: "Dublin",
					postalCode: "D02 XF99",
					country: "IE",
			  }
			: {
					address1: "1111 Expedia Group Way W",
					locality: "Seattle",
					administrativeArea: "WA",
					postalCode: "98119",
					country: "US",
			  };

		const defaultAddress =
			provider === "expedia"
				? expediaDefaultAddress
				: {
						address1: String(process.env.BOFA_VCC_DEFAULT_ADDRESS1 || ""),
						locality: String(process.env.BOFA_VCC_DEFAULT_LOCALITY || ""),
						administrativeArea: String(
							process.env.BOFA_VCC_DEFAULT_ADMIN_AREA || "",
						),
						postalCode: String(
							process.env.BOFA_VCC_DEFAULT_POSTAL_CODE || postalCode || "98119",
						),
						country: String(process.env.BOFA_VCC_DEFAULT_COUNTRY || "US"),
				  };

		const billTo = {
			firstName: truncate(String(cardholder.firstName), 60),
			lastName: truncate(String(cardholder.lastName), 60),
			address1: truncate(
				String(
					billing.address1 || billing.addressLine1 || defaultAddress.address1,
				),
				60,
			),
			locality: truncate(
				String(
					billing.locality ||
						billing.city ||
						billing.adminArea2 ||
						defaultAddress.locality,
				),
				50,
			),
			administrativeArea: truncate(
				String(
					billing.administrativeArea ||
						billing.state ||
						billing.adminArea1 ||
						defaultAddress.administrativeArea,
				),
				20,
			),
			postalCode: truncate(
				String(
					postalCode ||
						billing.postalCode ||
						billing.postal_code ||
						defaultAddress.postalCode ||
						"98119",
				).toUpperCase(),
				14,
			),
			country: truncate(
				String(
					billing.country ||
						billing.countryCode ||
						defaultAddress.country ||
						"US",
				).toUpperCase(),
				2,
			),
			email: truncate(
				String(
					billing.email ||
						process.env.BOFA_VCC_FALLBACK_EMAIL ||
						"support@jannatbooking.com",
				),
				255,
			),
			phoneNumber: truncate(
				String(
					billing.phoneNumber || process.env.BOFA_VCC_FALLBACK_PHONE || "",
				),
				20,
			),
		};

		const bodyObj = {
			processingInformation: { capture: true },
			clientReferenceInformation: { code: refCode },
			orderInformation: {
				amountDetails: { totalAmount: toCCY(amountUsd), currency: "USD" },
				billTo,
			},
			paymentInformation: {
				card: {
					number: cardNumber,
					expirationMonth: expiry.month,
					expirationYear: expiry.year,
					securityCode: cardCVV,
					type: cardTypeCode,
				},
			},
		};

		bofaLog("rest request prepared", {
			reservationId,
			requestId,
			url: `https://${cfg.host}${PTS_PAYMENTS_PATH}`,
			refCode,
			amountUsd: toCCY(amountUsd),
			amountSar: toCCY(amountSar),
			cardLast4: cardNumber.slice(-4),
			expiry: expiry.display,
			cardTypeCode,
			billTo: safeLogObject(billTo),
			signatureStyle: cfg.signatureStyle,
			signatureHeaders: SIGNATURE_STYLES[cfg.signatureStyle]?.headersList || "",
		});

		// Call provider
		providerAttemptSubmitted = true;
		const providerResp = await restPostJson({
			host: cfg.host,
			path: PTS_PAYMENTS_PATH,
			bodyObj,
			cfg,
			requestId,
		});

		const httpStatus = providerResp.httpStatus;
		const httpStatusText = providerResp.httpStatusText;
		const correlationId = providerResp.correlationId;

		const data =
			providerResp.data && typeof providerResp.data === "object"
				? providerResp.data
				: {};

		const responseText = providerResp.responseText;

		const txnStatus = String(data?.status || "").toUpperCase();
		const declined = [
			"DECLINED",
			"FAILED",
			"REJECTED",
			"INVALID_REQUEST",
			"ERROR",
		].includes(txnStatus);

		const approved = httpStatus >= 200 && httpStatus < 300 && !declined;

		bofaLog("rest response received", {
			reservationId,
			requestId,
			httpStatus,
			httpStatusText,
			correlationId,
			txnStatus,
			approved,
			declined,
			signatureMeta: safeLogObject(providerResp?.signatureMeta || {}, 8),
			responseJson: safeLogObject(data, 10),
			responseText,
		});

		const b = normalizeBofaPayment(reservation?.bofa_payment);
		const v = b.vcc;
		const now = new Date();

		const attemptsBefore = Number(v.attempts_count || 0);
		const failedAttemptsBefore = Number(v.failed_attempts_count || 0);

		const cardLast4 = cardNumber.slice(-4);

		const processorCode = String(
			data?.processorInformation?.responseCode ||
				data?.processorInformation?.approvalCode ||
				"",
		);

		const processorDetails = truncate(
			String(data?.processorInformation?.responseDetails || ""),
			255,
		);

		const gatewayReason = String(
			data?.errorInformation?.reason || data?.reason || "",
		);

		const gatewayMessage = truncate(
			String(
				data?.errorInformation?.message ||
					data?.message ||
					data?.details?.[0]?.message ||
					"",
			),
			600,
		);

		const capture = {
			id: String(data?.id || ""),
			status: txnStatus,
			submitTimeUtc: String(data?.submitTimeUtc || ""),
			reconciliationId: String(data?.reconciliationId || ""),
			clientReferenceCode: String(data?.clientReferenceInformation?.code || ""),
			httpStatus,
			httpStatusText,
			correlationId,
			processorResponseCode: processorCode,
			processorResponseDetails: processorDetails,
			gatewayReason,
			gatewayMessage,
		};

		// Common vcc state updates
		v.processing = false;
		v.source = provider;
		v.last_request_id = requestId;
		v.last_attempt_at = now;

		// metadata for audit/debug (no PAN)
		v.metadata = {
			...sourceVccMetadata,
			provider,
			bookingSource: snapshot?.booking_source || "",
			guestName:
				snapshot?.customer_details?.fullName ||
				snapshot?.customer_details?.name ||
				"",
			confirmationNumber: snapshot?.confirmation_number || "",
			confirmationNumber2:
				req.body?.confirmationNumber2 ||
				snapshot?.customer_details?.confirmation_number2 ||
				"",
			checkinDate: snapshot?.checkin_date
				? new Date(snapshot.checkin_date).toISOString().slice(0, 10)
				: "",
			checkoutDate: snapshot?.checkout_date
				? new Date(snapshot.checkout_date).toISOString().slice(0, 10)
				: "",
			hotelName: hotel?.hotelName || "",
			reservationStatus: statusNorm(snapshot?.reservation_status),
			guestHousedInRoom: rooms.join(", "),
			cancellationContext: isCancelledOrNoShow(snapshot?.reservation_status)
				? "cancelled_or_no_show_with_valid_non_refundable_vcc"
				: "active_or_completed_stay",
			cardholderName: cardholder.full,
			postalCode: billTo.postalCode,
			countryCode: billTo.country,
			chargeAmountUsd: amountUsd,
			chargeAmountSar: amountSar,
			chargeCurrency: "USD",
			chargeExchangeRateToSar: amountConversion.exchangeRateToSar,
			chargeExchangeRateSource: amountConversion.exchangeRateSource,
			chargeAmountConvertedAt: amountConversion.convertedAt,
			restHost: cfg.host,
			restPlatform: cfg.platform,
			restEnv: cfg.env,
			restSignatureStyle: cfg.signatureStyle,
		};

		// Determine configuration-level "404 resource not found" errors (do not count attempt)
		const isConfigNotFoundError =
			httpStatus === 404 &&
			/resource not found/i.test(String(responseText || "")) &&
			!txnStatus &&
			!processorCode;

		if (approved) {
			// Count attempt + mark charged
			v.attempts_count = attemptsBefore + 1;
			v.charged = true;
			v.blocked_after_failure = false;
			v.warning_message = "";
			v.charge_count = Number(v.charge_count || 0) + 1;
			v.total_captured_usd = toNum2(
				Number(v.total_captured_usd || 0) + amountUsd,
			);
			v.total_captured_sar = toNum2(
				Number(v.total_captured_sar || 0) + amountSar,
			);

			v.last_success_at = now;
			v.last_failure_at = null;
			v.last_failure_message = "";
			v.last_failure_code = "";
			v.last_failure_http_status = null;
			v.last_failure_payload = null;

			v.last_transaction_id = capture.id;
			v.last_reconciliation_id = capture.reconciliationId;

			v.last_processor_response_code = processorCode;
			v.last_processor_response_details = processorDetails;

			v.last_capture = {
				...capture,
				amount_usd: amountUsd,
				amount_sar: amountSar,
				card_last4: cardLast4,
				card_expiry: expiry.display,
				cardholder_name: cardholder.full,
				postal_code: billTo.postalCode,
				country_code: billTo.country,
			};

			v.attempts.push({
				at: now,
				success: true,
				provider,
				message: `BoA VCC charge completed (status: ${
					txnStatus || "APPROVED"
				}).`,
				transaction_id: capture.id,
				reconciliation_id: capture.reconciliationId,
				request_id: requestId,
				amount_usd: amountUsd,
				amount_sar: amountSar,
				card_last4: cardLast4,
				card_expiry: expiry.display,
				processor_response_code: processorCode,
				processor_response_details: processorDetails,
				http_status: httpStatus,
				http_status_text: httpStatusText,
				status: txnStatus,
				order_reference: refCode,
				cardholder_name: cardholder.full,
				postal_code: billTo.postalCode,
				country_code: billTo.country,
				gateway_reason: gatewayReason,
				gateway_message: gatewayMessage,
			});

			reservation.bofa_payment = b;
			reservation.payment_details = {
				...(reservation.payment_details || {}),
				bofaVccCharged: true,
				bofaVccChargeAt: now,
				bofaVccTransactionId: capture.id,
				bofaVccReconciliationId: capture.reconciliationId,
				lastBofaVccFailureAt: null,
				lastBofaVccFailureMessage: "",
				lastChargeAt: now,
				lastChargeVia: "VCC_BOFA_REST",
				triggeredAmountUSD: amountUsd,
				triggeredAmountSAR: amountSar,
			};

			await reservation.save();
			lockAcquired = false;

			bofaLog("capture approved and saved", {
				reservationId,
				requestId,
				transactionId: capture.id,
				reconciliationId: capture.reconciliationId,
				httpStatus,
				txnStatus,
				amountUsd,
				amountSar,
				cardLast4,
			});

			return res.status(200).json({
				success: true,
				message: "VCC payment completed via Bank of America REST API.",
				transaction: capture,
				bofaStatus: vccStatusPayload(reservation, provider),
				reservation,
			});
		}

		// Failure path
		const fallbackFailureMessage =
			httpStatus === 404
				? `REST endpoint returned HTTP 404 (${
						httpStatusText || "Not Found"
				  }). Check REST env/host family, REST merchant id, and REST Payments provisioning.`
				: "Bank of America declined this VCC charge.";

		const failureMessage = String(
			data?.errorInformation?.message ||
				data?.message ||
				data?.details?.[0]?.message ||
				(responseText ? truncate(responseText, 400) : "") ||
				fallbackFailureMessage,
		);

		const failureCode = String(
			data?.errorInformation?.reason ||
				data?.reason ||
				(isConfigNotFoundError
					? "BOFA_REST_CONFIGURATION_NOT_FOUND"
					: "BOFA_VCC_DECLINED"),
		);

		// Count attempts unless it looks like a pure configuration-level 404
		v.attempts_count = isConfigNotFoundError
			? attemptsBefore
			: attemptsBefore + 1;
		v.failed_attempts_count = isConfigNotFoundError
			? failedAttemptsBefore
			: failedAttemptsBefore + 1;

		v.charged = false;
		v.last_failure_at = now;
		v.last_failure_message = failureMessage;
		v.last_failure_code = failureCode;
		v.last_failure_http_status = httpStatus;
		v.last_transaction_id = capture.id;
		v.last_reconciliation_id = capture.reconciliationId;
		v.last_processor_response_code = processorCode;
		v.last_processor_response_details = processorDetails;

		v.last_failure_payload = safeLogObject({
			httpStatus,
			httpStatusText,
			txnStatus,
			gatewayReason,
			gatewayMessage,
			errorInformation: data?.errorInformation || null,
			details: data?.details || null,
			responseText,
		});

		v.blocked_after_failure = v.failed_attempts_count >= maxAttempts();
		v.warning_message = isConfigNotFoundError
			? ""
			: v.blocked_after_failure
			? BLOCK_WARNING
			: RETRY_WARNING;

		v.last_capture = {
			...capture,
			amount_usd: amountUsd,
			amount_sar: amountSar,
			card_last4: cardLast4,
			card_expiry: expiry.display,
			cardholder_name: cardholder.full,
			postal_code: billTo.postalCode,
			country_code: billTo.country,
			configuration_error: isConfigNotFoundError,
		};

		v.attempts.push({
			at: now,
			success: false,
			provider,
			message: failureMessage,
			error_code: failureCode,
			request_id: requestId,
			amount_usd: amountUsd,
			amount_sar: amountSar,
			card_last4: cardLast4,
			card_expiry: expiry.display,
			processor_response_code: processorCode,
			processor_response_details: processorDetails,
			http_status: httpStatus,
			http_status_text: httpStatusText,
			status: txnStatus,
			order_reference: refCode,
			cardholder_name: cardholder.full,
			postal_code: billTo.postalCode,
			country_code: billTo.country,
			gateway_reason: gatewayReason,
			gateway_message: gatewayMessage,
			configuration_error: isConfigNotFoundError,
		});

		reservation.bofa_payment = b;
		reservation.payment_details = {
			...(reservation.payment_details || {}),
			bofaVccCharged: false,
			lastBofaVccFailureAt: now,
			lastBofaVccFailureMessage: failureMessage,
		};

		await reservation.save();
		lockAcquired = false;

		if (isConfigNotFoundError) {
			bofaWarn(
				"configuration-level BoA error detected; attempt counters were not incremented",
				{
					reservationId,
					requestId,
					httpStatus,
					httpStatusText,
					failureCode,
					failureMessage,
				},
			);
			return res.status(502).json({
				success: false,
				issue: "BOFA_REST_CONFIGURATION_ERROR",
				message: failureMessage,
				error: { reason: failureCode, httpStatus },
				transaction: capture,
				bofaStatus: vccStatusPayload(reservation, provider),
				reservation,
			});
		}

		bofaWarn("capture declined and saved", {
			reservationId,
			requestId,
			httpStatus,
			httpStatusText,
			txnStatus,
			failureCode,
			failureMessage,
			amountUsd,
			amountSar,
			transactionId: capture.id || "",
			reconciliationId: capture.reconciliationId || "",
		});

		return res.status(402).json({
			success: false,
			issue: "BOFA_VCC_CAPTURE_DECLINED",
			message: failureMessage,
			error: { reason: failureCode, httpStatus },
			transaction: capture,
			bofaStatus: vccStatusPayload(reservation, provider),
			reservation,
		});
	} catch (error) {
		console.error("captureReservationVccSale error:", {
			statusCode: error?.statusCode || null,
			issue: error?.issue || null,
			message: error?.message || "",
			stack: error?.stack || "",
			isAxiosError: !!error?.isAxiosError,
			axiosStatus: error?.response?.status || null,
			axiosData: safeLogObject(error?.response?.data || null),
		});

		// Release lock if we acquired it
		if (reservationId && lockAcquired) {
			try {
				const reservation = await Reservations.findById(reservationId);
				if (reservation) {
					const b = normalizeBofaPayment(reservation?.bofa_payment);
					const v = b.vcc;
					const now = new Date();

					v.processing = false;
					v.last_attempt_at = now;
					v.last_failure_at = now;
					v.last_failure_code = String(
						error?.issue || "BOFA_VCC_CAPTURE_FAILED",
					);
					v.last_failure_message = String(
						error?.message || "Bank of America could not process this VCC.",
					);

					if (providerAttemptSubmitted) {
						v.attempts_count = Number(v.attempts_count || 0) + 1;
						v.failed_attempts_count = Number(v.failed_attempts_count || 0) + 1;
						v.blocked_after_failure = v.failed_attempts_count >= maxAttempts();
						v.warning_message = v.blocked_after_failure
							? BLOCK_WARNING
							: RETRY_WARNING;
						v.attempts.push({
							at: now,
							success: false,
							provider: v.source || "other",
							message: v.last_failure_message,
							error_code: v.last_failure_code,
						});
					}

					reservation.bofa_payment = b;
					reservation.payment_details = {
						...(reservation.payment_details || {}),
						bofaVccCharged: false,
						lastBofaVccFailureAt: now,
						lastBofaVccFailureMessage: v.last_failure_message,
					};

					await reservation.save();
				}
			} catch (persistErr) {
				console.error("captureReservationVccSale persist error:", persistErr);
			}
		}

		return res.status(error?.statusCode || 500).json({
			success: false,
			issue: error?.issue || "BOFA_VCC_CAPTURE_FAILED",
			message:
				error?.message ||
				"Bank of America could not process this virtual card charge.",
		});
	}
};
