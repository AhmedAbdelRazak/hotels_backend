/** @format */

const crypto = require("crypto");
const fetch = require("node-fetch");
const dayjs = require("dayjs");
const customParseFormat = require("dayjs/plugin/customParseFormat");
const Reservations = require("../models/reservations");
const HotelDetails = require("../models/hotel_details");
const {
	normalizeReservationCreationPricing,
} = require("./reservationPricing");
const {
	OTA_PLATFORM_REVIEW_RESERVATION_STATUS,
	buildOtaReviewSnapshot,
} = require("./otaReservationVisibility");
const {
	createReservationWithAvailabilitySnapshot,
} = require("../controllers/reservations");
const {
	enqueueOtaReservationWork,
} = require("./otaReservationQueue");
const {
	addReservationVersionBump,
	buildReservationSnapshotFilter,
} = require("./otaReviewConcurrency");
const { matchOtaRoomWithOpenAi } = require("./otaAiRoomMatcher");

dayjs.extend(customParseFormat);

const USD_TO_SAR = Number(
	process.env.OTA_USD_TO_SAR_RATE || process.env.USD_TO_SAR_RATE || 3.75
);
const DEFAULT_OTA_REVIEW_DEDUCTION_RATE = clampDeductionRate(
	process.env.OTA_REVIEW_DEFAULT_DEDUCTION_RATE,
	0.1
);
const DEFAULT_OTA_INBOUND_EMAIL_DEDUCTION_RATE = clampDeductionRate(
	process.env.OTA_INBOUND_EMAIL_DEFAULT_DEDUCTION_RATE ||
		process.env.OTA_EMAIL_DEFAULT_DEDUCTION_RATE,
	0.2
);
const MIN_REAL_CALENDAR_ROOT_PRICE = Number(
	process.env.OTA_MIN_REAL_CALENDAR_ROOT_PRICE || 0.01
);
const configuredInboundTotalLimit = Number(
	process.env.OTA_MAX_INBOUND_RESERVATION_TOTAL_SAR || 1000000
);
const MAX_OTA_INBOUND_RESERVATION_TOTAL_SAR =
	Number.isFinite(configuredInboundTotalLimit) && configuredInboundTotalLimit > 0
		? configuredInboundTotalLimit
		: 1000000;

const DEFAULT_SAR_EXCHANGE_RATES = {
	SAR: 1,
	USD: USD_TO_SAR,
	AED: 1.021,
	QAR: 1.03,
	BHD: 9.95,
	OMR: 9.74,
	KWD: 12.2,
	EUR: 4.1,
	GBP: 4.75,
	CHF: 4.2,
	CAD: 2.75,
	AUD: 2.45,
	JOD: 5.29,
	EGP: 0.078,
	MAD: 0.38,
	TRY: 0.12,
	INR: 0.045,
	PKR: 0.013,
	PHP: 0.067,
	IDR: 0.00023,
	MYR: 0.8,
	SGD: 2.8,
	CNY: 0.52,
	JPY: 0.025,
	THB: 0.1,
};

const MONEY_CURRENCY_CODES = Object.keys(DEFAULT_SAR_EXCHANGE_RATES);
const STABLE_DEFAULT_RATE_CURRENCIES = new Set(["USD", "AED", "QAR", "BHD", "OMR"]);
const EXCHANGE_RATE_CACHE_TTL_MS = Number(
	process.env.OTA_EXCHANGE_RATE_CACHE_TTL_MS || 6 * 60 * 60 * 1000
);
const exchangeRateCache = new Map();

const PROVIDER_LABELS = {
	expedia: "Expedia",
	booking: "Booking.com",
	agoda: "Agoda",
	hotels: "Hotels.com",
	airbnb: "Airbnb",
	hotelrunner: "HotelRunner",
	trip: "Trip.com",
	ota: "OTA Email",
};

function normalizeUnicodeDigits(value) {
	return String(value || "")
		.replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
		.replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0));
}

const DEFAULT_AJYAD_HOTEL_ID = "6a40b6a1a6efe70450536038";
const OTA_AJYAD_DEFAULT_HOTEL_ID = String(
	process.env.OTA_AJYAD_DEFAULT_HOTEL_ID ||
		process.env.OTA_AJYAD_HOTEL_ID ||
		DEFAULT_AJYAD_HOTEL_ID
).trim();

function normalizeWhitespace(value) {
	return normalizeUnicodeDigits(value)
		.replace(/^\uFEFF/, "")
		.replace(/[\u200B-\u200D\u2060]/g, "")
		.replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "")
		.replace(/\u00A0/g, " ")
		.replace(/[ \t]+/g, " ")
		.replace(/\r/g, "")
		.trim();
}

function normalizeComparable(value) {
	return normalizeWhitespace(value)
		.toLowerCase()
		.replace(/&/g, "and")
		.replace(/[^a-z0-9]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function normalizeIntlComparable(value) {
	return normalizeWhitespace(value)
		.toLowerCase()
		.normalize("NFKC")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function normalizeAjyadComparable(value = "") {
	return normalizeIntlComparable(value)
		.replace(/[أإآٱ]/g, "ا")
		.replace(/ى/g, "ي")
		.replace(/\s+/g, " ")
		.trim();
}

function containsAjyadKeyword(value = "") {
	const normalized = normalizeAjyadComparable(value);
	if (/\bagyad\b/i.test(normalized)) return true;
	return /\bajyad\b/i.test(normalized) || normalized.includes("اجياد");
}

function normalizedReservationContainsAjyad(normalized = {}) {
	return [
		normalized.hotelName,
		...(Array.isArray(normalized.hotelNameAliases)
			? normalized.hotelNameAliases
			: []),
		normalized.roomName,
		normalized.airbnbListingTitle,
		normalized.source?.subject,
		normalized.source?.safeSnippet,
	]
		.filter(Boolean)
		.some((value) => containsAjyadKeyword(value));
}

function configuredAjyadHotelId() {
	return /^[a-f0-9]{24}$/i.test(OTA_AJYAD_DEFAULT_HOTEL_ID)
		? OTA_AJYAD_DEFAULT_HOTEL_ID
		: DEFAULT_AJYAD_HOTEL_ID;
}

function articleStrippedComparable(value) {
	return normalizeComparable(value)
		.split(" ")
		.map((word) => word.replace(/^(al|el)(?=[a-z])/, ""))
		.join(" ")
		.replace(/\s+/g, " ")
		.trim();
}

function comparableVariants(value) {
	const base = normalizeComparable(value);
	const stripped = articleStrippedComparable(value);
	const alNormalized = base.replace(/\bel\b/g, "al");
	const elNormalized = base.replace(/\bal\b/g, "el");
	return Array.from(
		new Set(
			[
				base,
				stripped,
				alNormalized,
				elNormalized,
				base.replace(/\bel(?=[a-z])/g, "al"),
				base.replace(/\bal(?=[a-z])/g, "el"),
			].filter(Boolean)
		)
	);
}

const EXPLICIT_HOTEL_ALIAS_GROUPS = [
	[
		"Zyd Agyad",
		"Zyd Ajyad",
		"Zad Agyad",
		"Zad Ajyad",
		"ZAD AJYAD",
	],
	[
		"AlSukareya HOTEL",
		"Al Sukareya Hotel",
		"AlSukareya",
		"Al Sukareya",
		"ZAD AL SAD",
		"Zad Al Sad",
	],
	[
		"Al-Magd Hotel",
		"Al Magd Hotel",
		"Al Majd Hotel",
		"Zad Al Majd",
		"ZAD AL MAJD",
	],
	[
		"Al-Qemma Hotel",
		"Al Qemma Hotel",
		"Al Qimma Hotel",
		"Al-Qimma Hotel",
		"Zad Al Qimma",
		"ZAD AL QIMMA",
	],
	[
		"Taj Al Zahabiya Hotel",
		"Taj Alzahabiya Hotel",
		"Taaj Al Zahabiya Hotel",
		"Taaj Alzahabiya",
		"Taj Al Zahabiya",
	],
	[
		"Zad Al-Mashaer Hotel",
		"Zad Al Mashaer Hotel",
		"Zad Al Mashaer",
		"ZAD AL MASHAER",
	],
	[
		"Zad Al Safa Hotel",
		"Zad Al Safa",
		"ZAD AL SAFA",
	],
];

const EXPLICIT_HOTEL_ALIAS_INDEX = EXPLICIT_HOTEL_ALIAS_GROUPS.map((group) => ({
	labels: group,
	keys: new Set(
		group.flatMap((label) => comparableVariants(label).map(normalizeComparable))
	),
}));

function explicitHotelNameAliases(value = "") {
	const key = normalizeComparable(value);
	if (!key) return [];
	const match = EXPLICIT_HOTEL_ALIAS_INDEX.find((group) => group.keys.has(key));
	return match ? match.labels.filter((label) => normalizeComparable(label) !== key) : [];
}

function expandHotelNameCandidates(candidates = []) {
	return Array.from(
		new Set(
			(Array.isArray(candidates) ? candidates : [candidates])
				.flatMap((candidate) => [
					candidate,
					...explicitHotelNameAliases(candidate),
				])
				.map((item) => normalizeWhitespace(item))
				.filter(Boolean)
		)
	);
}

function explicitHotelAliasFromText(value = "") {
	const source = normalizeIntlComparable(value);
	if (!source) return "";
	for (const group of EXPLICIT_HOTEL_ALIAS_GROUPS) {
		const sortedLabels = [...group].sort((left, right) => right.length - left.length);
		for (const label of sortedLabels) {
			const key = normalizeIntlComparable(label);
			if (key && key.length >= 5 && source.includes(key)) {
				return normalizeWhitespace(label);
			}
		}
	}
	return "";
}

const HOTEL_NAME_STOPWORDS = new Set([
	"hotel",
	"hotels",
	"makkah",
	"mecca",
	"saudi",
	"arabia",
	"ksa",
	"branch",
	"property",
	"inn",
	"suites",
	"suite",
	"apartment",
	"apartments",
]);

const HOTEL_LIGHT_TOKENS = new Set(["al", "el", "the"]);

function normalizeHotelPhoneticToken(token = "") {
	let s = normalizeComparable(token)
		.replace(/2/g, "q")
		.replace(/3/g, "")
		.replace(/5/g, "kh")
		.replace(/6/g, "t")
		.replace(/7/g, "h")
		.replace(/8/g, "gh")
		.replace(/9/g, "s");
	s = s.replace(/^el(?=$|[a-z])/, "al");
	s = s.replace(/[qkgj]/g, "j");
	s = s.replace(/(.)\1+/g, "$1");
	return s;
}

function hotelTokenForms(token = "") {
	const comparable = normalizeComparable(token);
	const phonetic = normalizeHotelPhoneticToken(comparable);
	const vowelLight = phonetic.replace(/[aeiou]/g, "");
	return Array.from(new Set([comparable, phonetic, vowelLight].filter(Boolean)));
}

function hotelNameTokens(value = "") {
	return normalizeComparable(value)
		.split(" ")
		.map((token) => token.trim())
		.filter((token) => token && !HOTEL_NAME_STOPWORDS.has(token));
}

function hotelTokenWeight(token = "") {
	return HOTEL_LIGHT_TOKENS.has(token) || token.length <= 2 ? 0.35 : 1;
}

function hotelTokenSimilarity(left = "", right = "") {
	if (!left || !right) return 0;
	if (left === right) return 1;
	const leftForms = hotelTokenForms(left);
	const rightForms = hotelTokenForms(right);
	for (const leftForm of leftForms) {
		for (const rightForm of rightForms) {
			if (leftForm === rightForm) return 1;
			if (
				leftForm.length >= 3 &&
				rightForm.length >= 3 &&
				(leftForm.includes(rightForm) || rightForm.includes(leftForm))
			) {
				return 0.9;
			}
		}
	}
	return Math.max(tokenSimilarity(left, right), bigramSimilarity(left, right));
}

function tokenContainmentScore(shorterTokens = [], longerTokens = []) {
	if (!shorterTokens.length || !longerTokens.length) return 0;
	let weightedScore = 0;
	let totalWeight = 0;
	shorterTokens.forEach((token) => {
		const weight = hotelTokenWeight(token);
		const best = longerTokens.reduce(
			(score, candidate) => Math.max(score, hotelTokenSimilarity(token, candidate)),
			0
		);
		weightedScore += best * weight;
		totalWeight += weight;
	});
	return totalWeight ? weightedScore / totalWeight : 0;
}

function hotelNameSimilarity(left = "", right = "") {
	const leftVariants = comparableVariants(left);
	const rightVariants = comparableVariants(right);
	let best = 0;
	for (const leftVariant of leftVariants) {
		for (const rightVariant of rightVariants) {
			best = Math.max(best, tokenSimilarity(leftVariant, rightVariant));
			const leftTokens = hotelNameTokens(leftVariant);
			const rightTokens = hotelNameTokens(rightVariant);
			const shorter =
				leftTokens.length <= rightTokens.length ? leftTokens : rightTokens;
			const longer = leftTokens.length <= rightTokens.length ? rightTokens : leftTokens;
			best = Math.max(best, tokenContainmentScore(shorter, longer));
			const leftPhonetic = leftTokens.map(normalizeHotelPhoneticToken).join("");
			const rightPhonetic = rightTokens.map(normalizeHotelPhoneticToken).join("");
			if (leftPhonetic && rightPhonetic) {
				if (leftPhonetic === rightPhonetic) best = Math.max(best, 1);
				else if (
					leftPhonetic.length >= 4 &&
					rightPhonetic.length >= 4 &&
					(leftPhonetic.includes(rightPhonetic) ||
						rightPhonetic.includes(leftPhonetic))
				) {
					best = Math.max(best, 0.9);
				} else {
					best = Math.max(best, bigramSimilarity(leftPhonetic, rightPhonetic));
				}
			}
		}
	}
	return round2(best);
}

function bigramSimilarity(left = "", right = "") {
	const a = normalizeComparable(left).replace(/\s+/g, "");
	const b = normalizeComparable(right).replace(/\s+/g, "");
	if (!a || !b) return 0;
	if (a === b) return 1;
	if (a.length < 2 || b.length < 2) return a[0] === b[0] ? 0.5 : 0;
	const toBigrams = (value) => {
		const grams = [];
		for (let index = 0; index < value.length - 1; index += 1) {
			grams.push(value.slice(index, index + 2));
		}
		return grams;
	};
	const leftGrams = toBigrams(a);
	const rightGrams = toBigrams(b);
	const used = new Set();
	let intersection = 0;
	leftGrams.forEach((gram) => {
		const matchIndex = rightGrams.findIndex(
			(candidate, index) => candidate === gram && !used.has(index)
		);
		if (matchIndex >= 0) {
			used.add(matchIndex);
			intersection += 1;
		}
	});
	return (2 * intersection) / (leftGrams.length + rightGrams.length);
}

function fuzzyTokenScore(left = "", right = "") {
	const leftWords = normalizeComparable(left).split(" ").filter(Boolean);
	const rightWords = normalizeComparable(right).split(" ").filter(Boolean);
	if (!leftWords.length || !rightWords.length) return 0;
	const score = leftWords.reduce((total, word) => {
		const best = rightWords.reduce((max, candidate) => {
			if (word === candidate) return 1;
			if (word.includes(candidate) || candidate.includes(word)) return Math.max(max, 0.88);
			return Math.max(max, bigramSimilarity(word, candidate));
		}, 0);
		return total + best;
	}, 0);
	return score / Math.max(leftWords.length, rightWords.length, 1);
}

function tokenSimilarity(left = "", right = "") {
	const a = normalizeComparable(left);
	const b = normalizeComparable(right);
	if (!a || !b) return 0;
	if (a === b) return 1;
	if (a.includes(b) || b.includes(a)) return 0.86;
	const aWords = new Set(a.split(" ").filter(Boolean));
	const bWords = new Set(b.split(" ").filter(Boolean));
	const intersection = [...aWords].filter((word) => bWords.has(word)).length;
	const tokenScore = intersection / Math.max(aWords.size, bWords.size, 1);
	const aCompact = a.replace(/\s+/g, "");
	const bCompact = b.replace(/\s+/g, "");
	const minLength = Math.min(aCompact.length, bCompact.length);
	let samePrefix = 0;
	for (let index = 0; index < minLength; index += 1) {
		if (aCompact[index] !== bCompact[index]) break;
		samePrefix += 1;
	}
	const prefixScore = samePrefix / Math.max(aCompact.length, bCompact.length, 1);
	return Math.max(tokenScore, fuzzyTokenScore(a, b), prefixScore, bigramSimilarity(a, b));
}

function roomTypeLabel(roomType = "") {
	return normalizeWhitespace(
		String(roomType || "")
			.replace(/([a-z])([A-Z])/g, "$1 $2")
			.replace(/\brooms\b/i, "rooms")
	);
}

function roomComparableVariants(value = "") {
	const variants = new Set(comparableVariants(value));
	Array.from(variants).forEach((variant) => {
		if (/\bquadruple\b/.test(variant)) {
			variants.add(variant.replace(/\bquadruple\b/g, "quad"));
		}
		if (/\bquad\b/.test(variant)) {
			variants.add(variant.replace(/\bquad\b/g, "quadruple"));
		}
	});
	return Array.from(variants).filter(Boolean);
}

function roomTypeKey(value = "") {
	return normalizeComparable(roomTypeLabel(value)).replace(/\s+/g, "");
}

function roomTypeMatches(roomType = "", mappedRoomType = "") {
	if (!roomType || !mappedRoomType) return false;
	const left = roomTypeKey(roomType);
	const right = roomTypeKey(mappedRoomType);
	return left === right;
}

function round2(value) {
	const parsed = Number(value || 0);
	return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : 0;
}

function clampDeductionRate(value, fallback = 0) {
	const parsed = Number(value);
	const rate = Number.isFinite(parsed) ? parsed : Number(fallback || 0);
	return Math.min(0.9, Math.max(0, rate));
}

function allocateAmountAcrossSlots(totalAmount, slots) {
	const count = Math.max(1, Number(slots || 1));
	const cents = Math.round(Number(totalAmount || 0) * 100);
	const base = Math.floor(cents / count);
	const remainder = cents - base * count;
	return Array.from({ length: count }, (_item, index) =>
		(base + (index < remainder ? 1 : 0)) / 100
	);
}

function sanitizeKey(key) {
	return normalizeWhitespace(key)
		.replace(/[._-]+/g, " ")
		.replace(/\s+/g, " ")
		.toLowerCase();
}

function normalizeRow(obj = {}) {
	const out = {};
	Object.keys(obj || {}).forEach((rawKey) => {
		out[sanitizeKey(rawKey)] = normalizeWhitespace(obj[rawKey]);
	});
	return out;
}

function decodeHtmlEntities(value) {
	return String(value || "")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'")
		.replace(/&#(\d+);/g, (_m, code) => {
			const n = Number(code);
			return Number.isFinite(n) ? String.fromCharCode(n) : "";
		});
}

function htmlToText(html = "") {
	return decodeHtmlEntities(html)
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<\/?(br|p|div|tr|table|thead|tbody|li|ul|ol|h\d)\b[^>]*>/gi, "\n")
		.replace(/<\/?(td|th)\b[^>]*>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/[ \t]+/g, " ")
		.trim();
}

function hashText(value) {
	const s = String(value || "");
	if (!s) return "";
	return crypto.createHash("sha256").update(s).digest("hex");
}

function redactSensitive(value) {
	let out = String(value || "");
	out = out.replace(
		/\b(?:card number|card no\.?|pan)\s*[:#-]?\s*((?:\d[\s-]*){13,19})\b/gi,
		(_m, digits) => {
			const clean = String(digits).replace(/\D/g, "");
			return `card number: [CARD-${clean.slice(-4)}] `;
		}
	);
	out = out.replace(
		/\b(?:cvv|cvc|validation code|security code)\s*[:#-]?\s*\d{3,4}\b/gi,
		"validation code: [REDACTED]"
	);
	out = out.replace(/\b(?:\d[ -]*?){15,19}\b/g, (match) => {
		const clean = String(match).replace(/\D/g, "");
		return clean.length >= 15 ? `[CARD-${clean.slice(-4)}] ` : match;
	});
	return out;
}

function safeSnippet(value, max = 500) {
	return redactSensitive(normalizeWhitespace(value)).slice(0, max);
}

function n(value) {
	if (value === null || value === undefined) return 0;
	const parsed = parseFloat(String(value).replace(/[^\d.-]/g, ""));
	return Number.isFinite(parsed) ? parsed : 0;
}

function countNumber(value) {
	const match = normalizeWhitespace(value).match(/-?\d+(?:\.\d+)?/);
	if (!match) return 0;
	const parsed = Number(match[0]);
	return Number.isFinite(parsed) ? parsed : 0;
}

function parseMoneyNumber(value) {
	const raw = normalizeWhitespace(value);
	if (!raw) return 0;
	const numericToken = raw.match(/-?\d+(?:[,.]\d+)*/)?.[0] || "";
	let cleaned = numericToken
		.replace(/[^\d,.-]/g, "")
		.replace(/(?!^)-/g, "")
		.trim();
	if (!cleaned) return 0;

	const commaIndex = cleaned.lastIndexOf(",");
	const dotIndex = cleaned.lastIndexOf(".");
	if (commaIndex >= 0 && dotIndex >= 0) {
		if (commaIndex > dotIndex) {
			cleaned = cleaned.replace(/\./g, "").replace(",", ".");
		} else {
			cleaned = cleaned.replace(/,/g, "");
		}
	} else if (commaIndex >= 0) {
		const groups = cleaned.split(",");
		const last = groups[groups.length - 1] || "";
		if (last.length > 0 && last.length <= 2) {
			cleaned = groups.slice(0, -1).join("").replace(/,/g, "") + "." + last;
		} else {
			cleaned = cleaned.replace(/,/g, "");
		}
	} else if ((cleaned.match(/\./g) || []).length > 1) {
		const groups = cleaned.split(".");
		const last = groups[groups.length - 1] || "";
		if (last.length > 0 && last.length <= 2) {
			cleaned = groups.slice(0, -1).join("") + "." + last;
		} else {
			cleaned = cleaned.replace(/\./g, "");
		}
	}

	const parsed = Number(cleaned);
	return Number.isFinite(parsed) ? parsed : 0;
}

function firstNonEmpty(...values) {
	for (const value of values) {
		const s = normalizeWhitespace(value);
		if (s) return s;
	}
	return "";
}

function pick(row, candidates) {
	for (const candidate of candidates) {
		const key = sanitizeKey(candidate);
		if (row[key] !== undefined && row[key] !== null) {
			const value = normalizeWhitespace(row[key]);
			if (value) return value;
		}
	}
	return "";
}

function normalizeMoneyCurrency(value) {
	const token = normalizeWhitespace(value).toUpperCase();
	if (!token) return "";
	if (token.includes("$") || token === "US$") return "USD";
	if (token.includes("\uFDFC")) return "SAR";
	if (token.includes("\u20ac")) return "EUR";
	if (token.includes("\u00a3")) return "GBP";
	if (/^(SR|SAUDI\s+RIYAL|RIYAL)$/.test(token)) return "SAR";
	const matchedCode = MONEY_CURRENCY_CODES.find((code) => code === token);
	return matchedCode || "";
}

function moneyNumberPattern() {
	return String.raw`-?(?:\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:[,.]\d{1,2})?)`;
}

function parseMoneyCandidates(value) {
	const source = normalizeWhitespace(value);
	if (!source) return [];

	const currencyPattern = [
		...MONEY_CURRENCY_CODES,
		"US\\$",
		"\\$",
		"SR",
		"SAUDI\\s+RIYAL",
		"RIYAL",
		"\uFDFC",
		"\u20ac",
		"\u00a3",
	].join("|");
	const numberPattern = moneyNumberPattern();
	const candidates = [];
	const seen = new Set();
	const pushCandidate = (rawAmount, rawCurrency, index) => {
		const currency = normalizeMoneyCurrency(rawCurrency);
		const amount = parseMoneyNumber(rawAmount);
		if (!currency || !Number.isFinite(amount)) return;
		const key = `${index}:${currency}:${amount}`;
		if (seen.has(key)) return;
		seen.add(key);
		candidates.push({ amount, currency, index });
	};

	const prefixed = new RegExp(
		`(^|[^A-Z0-9])(${currencyPattern})\\s*(${numberPattern})`,
		"gi"
	);
	let match;
	while ((match = prefixed.exec(source))) {
		pushCandidate(match[3], match[2], match.index + match[1].length);
	}

	const suffixed = new RegExp(
		`(${numberPattern})\\s*(${currencyPattern})(?=$|[^A-Z0-9])`,
		"gi"
	);
	while ((match = suffixed.exec(source))) {
		pushCandidate(match[1], match[2], match.index);
	}

	return candidates.sort((a, b) => a.index - b.index);
}

function parseMoney(value) {
	const source = normalizeWhitespace(value);
	if (!source) return { amount: 0, currency: "" };
	const candidates = parseMoneyCandidates(source);
	if (candidates.length) {
		return {
			amount: candidates[0].amount,
			currency: candidates[0].currency,
		};
	}
	let currency = "";
	const upper = source.toUpperCase();
	const matchedCode = MONEY_CURRENCY_CODES.find((code) =>
		new RegExp(`(^|[^A-Z])${code}([^A-Z]|$)`).test(upper)
	);
	if (matchedCode) currency = matchedCode;
	else if (/\b(SR|SAR|SAUDI\s+RIYAL|RIYAL)\b/i.test(source) || /ر\.?س/.test(source)) {
		currency = "SAR";
	} else if (upper.includes("US$") || upper.includes("USD") || source.includes("$")) {
		currency = "USD";
	} else if (source.includes("\u20ac")) {
		currency = "EUR";
	} else if (source.includes("\u00a3")) {
		currency = "GBP";
	}
	return { amount: parseMoneyNumber(source), currency };
}

function firstMoneyCandidateByCurrency(candidates = [], currency) {
	const code = String(currency || "").toUpperCase();
	return (Array.isArray(candidates) ? candidates : []).find(
		(candidate) => candidate.currency === code
	);
}

function resolveVccAmountDetails(amountToChargeField, fallbackCurrency) {
	const source = normalizeWhitespace(amountToChargeField);
	const candidates = parseMoneyCandidates(source);
	const parsedAmount = candidates.length
		? { amount: candidates[0].amount, currency: candidates[0].currency }
		: parseMoney(source);
	const amount = Number(parsedAmount.amount || 0);
	const currency = parsedAmount.currency || fallbackCurrency || "";
	const conversion = getVccAmountConversionMeta(amount, currency || "SAR");
	const usdCandidate = firstMoneyCandidateByCurrency(candidates, "USD");
	const sarCandidate = firstMoneyCandidateByCurrency(candidates, "SAR");
	const amountToChargeSar = sarCandidate
		? round2(sarCandidate.amount)
		: conversion.totalAmountSar;
	const amountToChargeUsd = usdCandidate
		? round2(usdCandidate.amount)
		: conversion.amountUsd;

	return {
		amountToCharge: Number.isFinite(amount) ? amount : 0,
		amountToChargeCurrency: currency,
		amountToChargeSar,
		amountToChargeUsd,
		amountToChargeSarSource: sarCandidate
			? "email"
			: conversion.exchangeRateSource,
		amountToChargeUsdSource: usdCandidate
			? "email"
			: conversion.sourceCurrency === "USD"
			? "source_currency"
			: "converted_from_sar",
		amountToChargeExchangeRateToSar: conversion.exchangeRateToSar,
		amountToChargeExchangeRateSource: conversion.exchangeRateSource,
		amountToChargeUsdExchangeRateToSar: conversion.usdExchangeRateToSar,
		amountToChargeUsdExchangeRateSource: conversion.usdExchangeRateSource,
		amountToChargeConvertedAt: conversion.convertedAt,
		amountToChargeHasUsdInEmail: !!usdCandidate,
		amountToChargeHasSarInEmail: !!sarCandidate,
	};
}

function parseConfiguredSarRates() {
	const parsed = {};
	const raw = process.env.OTA_CURRENCY_RATES_TO_SAR || "";
	if (raw) {
		try {
			const json = JSON.parse(raw);
			Object.entries(json || {}).forEach(([currency, rate]) => {
				const code = String(currency || "").trim().toUpperCase();
				const numericRate = Number(rate);
				if (code && Number.isFinite(numericRate) && numericRate > 0) {
					parsed[code] = numericRate;
				}
			});
		} catch (error) {
			console.warn("[ota-reconcile] currency.rate_config.invalid", {
				error: error.message,
			});
		}
	}

	MONEY_CURRENCY_CODES.forEach((code) => {
		const numericRate = Number(process.env[`OTA_${code}_TO_SAR_RATE`]);
		if (Number.isFinite(numericRate) && numericRate > 0) {
			parsed[code] = numericRate;
		}
	});
	return parsed;
}

function getSarExchangeRate(currency) {
	const code = String(currency || "SAR").trim().toUpperCase() || "SAR";
	if (code === "SAR") return { code: "SAR", rate: 1, source: "identity" };
	const configured = parseConfiguredSarRates();
	if (configured[code]) {
		return { code, rate: configured[code], source: "configured" };
	}
	if (DEFAULT_SAR_EXCHANGE_RATES[code]) {
		return { code, rate: DEFAULT_SAR_EXCHANGE_RATES[code], source: "fallback_default" };
	}
	return { code, rate: 0, source: "missing" };
}

async function fetchLiveSarExchangeRate(currency) {
	const code = String(currency || "SAR").trim().toUpperCase() || "SAR";
	if (!code || code === "SAR") {
		return { code: "SAR", rate: 1, source: "identity" };
	}
	const apiKey = String(process.env.EXCHANGE_RATE || "").trim();
	if (!apiKey) return null;

	const cached = exchangeRateCache.get(code);
	if (cached && Date.now() - cached.fetchedAt < EXCHANGE_RATE_CACHE_TTL_MS) {
		return { code, rate: cached.rate, source: "exchange_rate_api_cached" };
	}

	try {
		const response = await fetch(
			`https://v6.exchangerate-api.com/v6/${apiKey}/pair/${encodeURIComponent(
				code
			)}/SAR/`,
			{ timeout: 8000 }
		);
		const data = await response.json();
		const rate = Number(data?.conversion_rate);
		if (data?.result === "success" && Number.isFinite(rate) && rate > 0) {
			exchangeRateCache.set(code, { rate, fetchedAt: Date.now() });
			return { code, rate, source: "exchange_rate_api" };
		}
		console.warn("[ota-reconcile] currency.live_rate.unavailable", {
			currency: code,
			result: data?.result || "",
			errorType: data?.["error-type"] || "",
		});
		return null;
	} catch (error) {
		console.warn("[ota-reconcile] currency.live_rate.error", {
			currency: code,
			error: error.message,
		});
		return null;
	}
}

function getSarConversionMeta(amount, currency) {
	const numericAmount = Number(amount || 0);
	const exchange = getSarExchangeRate(currency || "SAR");
	if (!numericAmount) {
		return {
			sourceAmount: 0,
			sourceCurrency: exchange.code,
			exchangeRateToSar: exchange.rate || 0,
			exchangeRateSource: exchange.source,
			totalAmountSar: 0,
			convertedAt: new Date().toISOString(),
		};
	}
	return {
		sourceAmount: numericAmount,
		sourceCurrency: exchange.code,
		exchangeRateToSar: exchange.rate || 0,
		exchangeRateSource: exchange.source,
		totalAmountSar: exchange.rate ? round2(numericAmount * exchange.rate) : 0,
		convertedAt: new Date().toISOString(),
	};
}

function getUsdToSarExchangeRate() {
	const exchange = getSarExchangeRate("USD");
	const fallbackRate = Number.isFinite(USD_TO_SAR) && USD_TO_SAR > 0 ? USD_TO_SAR : 3.75;
	const rate = Number(exchange.rate || fallbackRate);
	return {
		code: "USD",
		rate: Number.isFinite(rate) && rate > 0 ? rate : fallbackRate,
		source: exchange.rate ? exchange.source : "fallback_default",
	};
}

function sarToUsdAmount(amountSar) {
	const numericSar = Number(amountSar || 0);
	if (!Number.isFinite(numericSar) || numericSar < 0) return 0;
	const usdExchange = getUsdToSarExchangeRate();
	return usdExchange.rate ? round2(numericSar / usdExchange.rate) : 0;
}

function withUsdConversionMeta(conversion = {}) {
	const usdExchange = getUsdToSarExchangeRate();
	const sourceAmount = Number(conversion.sourceAmount || 0);
	const amountUsd =
		conversion.sourceCurrency === "USD"
			? round2(sourceAmount)
			: sarToUsdAmount(conversion.totalAmountSar);
	return {
		...conversion,
		amountUsd,
		usdExchangeRateToSar: usdExchange.rate,
		usdExchangeRateSource: usdExchange.source,
	};
}

function getVccAmountConversionMeta(amount, currency) {
	return withUsdConversionMeta(getSarConversionMeta(amount, currency));
}

async function getSarConversionMetaAsync(amount, currency) {
	const numericAmount = Number(amount || 0);
	const code = String(currency || "SAR").trim().toUpperCase() || "SAR";
	const liveExchange = await fetchLiveSarExchangeRate(code);
	const exchange = liveExchange || getSarExchangeRate(code);
	if (!numericAmount) {
		return {
			sourceAmount: 0,
			sourceCurrency: exchange.code,
			exchangeRateToSar: exchange.rate || 0,
			exchangeRateSource: exchange.source,
			totalAmountSar: 0,
			convertedAt: new Date().toISOString(),
		};
	}
	return {
		sourceAmount: numericAmount,
		sourceCurrency: exchange.code,
		exchangeRateToSar: exchange.rate || 0,
		exchangeRateSource: exchange.source,
		totalAmountSar: exchange.rate ? round2(numericAmount * exchange.rate) : 0,
		convertedAt: new Date().toISOString(),
	};
}

async function getVccAmountConversionMetaAsync(amount, currency) {
	return withUsdConversionMeta(await getSarConversionMetaAsync(amount, currency));
}

function toSarAmount(amount, currency) {
	return getSarConversionMeta(amount, currency).totalAmountSar;
}

function parseDate(value) {
	const s = normalizeWhitespace(value);
	if (!s) return null;
	if (/^\d+(\.\d+)?$/.test(s)) {
		const excelEpochStart = new Date(1900, 0, 1);
		const parsedDate = new Date(
			excelEpochStart.getTime() + (Number(s) - 2) * 86400000
		);
		return dayjs(parsedDate).isValid()
			? dayjs(parsedDate).format("YYYY-MM-DD")
			: null;
	}

	const cleaned = s
		.replace(/\b(mon|tue|wed|thu|fri|sat|sun)(day)?\b,?\s*/gi, "")
		.replace(/(\d+)(st|nd|rd|th)\b/gi, "$1")
		.replace(/\s+at\s+.*$/i, "")
		.replace(/\s+\d{1,2}:\d{2}.*$/i, "")
		.trim();

	// A value such as 08/09/2026 can mean either 8 September or August 9.
	// Provider templates are not consistent enough to choose safely, so only
	// accept slash dates when the ordering is unambiguous (or both parts match).
	const numericSlashDate = cleaned.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
	if (numericSlashDate) {
		const first = Number(numericSlashDate[1]);
		const second = Number(numericSlashDate[2]);
		if (first <= 12 && second <= 12 && first !== second) return null;
	}

	const formats = [
		"YYYY-MM-DD",
		"MM/DD/YYYY",
		"DD/MM/YYYY",
		"M/D/YYYY",
		"D/M/YYYY",
		"MMM D, YYYY",
		"MMMM D, YYYY",
		"D MMM YYYY",
		"D MMMM YYYY",
		"MMM D YYYY",
		"MMMM D YYYY",
	];

	for (const format of formats) {
		const parsed = dayjs(cleaned, format, true);
		if (parsed.isValid()) return parsed.format("YYYY-MM-DD");
	}

	const fallback = dayjs(cleaned);
	return fallback.isValid() ? fallback.format("YYYY-MM-DD") : null;
}

function parseCardExpirationDate(value) {
	const s = normalizeWhitespace(value);
	if (!s) return null;
	const cleaned = s.replace(/\s+/g, " ").trim();
	const numericExpiry = cleaned.match(/^(\d{1,2})\s*[/-]\s*(\d{2}|\d{4})$/);
	if (numericExpiry) {
		const month = Number(numericExpiry[1]);
		const yearRaw = Number(numericExpiry[2]);
		const year = yearRaw < 100 ? 2000 + yearRaw : yearRaw;
		if (month >= 1 && month <= 12 && year >= 2000 && year <= 2099) {
			return `${year}-${String(month).padStart(2, "0")}`;
		}
	}
	const formats = ["MMM YYYY", "MMMM YYYY", "MM/YYYY", "M/YYYY", "MM/YY", "M/YY"];
	for (const format of formats) {
		const parsed = dayjs(cleaned, format, true);
		if (parsed.isValid()) return parsed.format("YYYY-MM");
	}
	const monthYear = cleaned.match(/\b([A-Za-z]{3,9})\s+(\d{4})\b/);
	if (monthYear) {
		const longParsed = dayjs(`${monthYear[1]} ${monthYear[2]}`, "MMMM YYYY", true);
		if (longParsed.isValid()) return longParsed.format("YYYY-MM");
		const shortParsed = dayjs(`${monthYear[1]} ${monthYear[2]}`, "MMM YYYY", true);
		if (shortParsed.isValid()) return shortParsed.format("YYYY-MM");
	}
	return parseDate(value);
}

function calculateDaysOfResidence(checkIn, checkOut) {
	const inDate = new Date(new Date(checkIn).setHours(0, 0, 0, 0));
	const outDate = new Date(new Date(checkOut).setHours(0, 0, 0, 0));
	if (isNaN(inDate.getTime()) || isNaN(outDate.getTime())) return 0;
	return (outDate.getTime() - inDate.getTime()) / (1000 * 3600 * 24);
}

function generateDateRange(startDate, endDate) {
	const start = dayjs(startDate);
	const end = dayjs(endDate);
	const dates = [];
	let current = start;
	while (current.isBefore(end, "day")) {
		dates.push(current.format("YYYY-MM-DD"));
		current = current.add(1, "day");
	}
	return dates;
}

function escapeRegExp(value) {
	return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function findField(text, labels) {
	const source = String(text || "").replace(/\r/g, "");
	const lines = source
		.split("\n")
		.map((line) => normalizeWhitespace(line))
		.filter(Boolean);

	for (const label of labels) {
		const labelPattern = escapeRegExp(label).replace(/\\ /g, "\\s+");
		const inline = new RegExp(
			`(?:^|\\n|\\b)${labelPattern}(?=$|\\s|[:#\\-])\\s*(?:[:#\\-]|is)?\\s*([^\\n]{1,180})`,
			"i"
		);
		const match = source.match(inline);
		if (match && normalizeWhitespace(match[1])) {
			return normalizeWhitespace(match[1]).replace(/^[:#-]\s*/, "");
		}

		const labelComparable = normalizeComparable(label);
		const idx = lines.findIndex((line) => {
			const lineComparable = normalizeComparable(line);
			return (
				lineComparable === labelComparable ||
				lineComparable.startsWith(`${labelComparable} `)
			);
		});
		if (idx >= 0) {
			const sameLine = lines[idx].slice(label.length).replace(/^[:#-]\s*/, "");
			if (normalizeWhitespace(sameLine)) return normalizeWhitespace(sameLine);
			if (lines[idx + 1]) return lines[idx + 1];
		}
	}

	return "";
}

function extractHotelRunnerInlineGuestFields(text = "") {
	const match = String(text || "").match(
		/\bGuest\s+Name\s*[:#-]?\s*([\s\S]{1,160}?)\s+Country\s*[:#-]?\s*([\s\S]{1,100}?)\s+Order\s+Total\b/i
	);
	if (!match) return { guestName: "", nationality: "" };
	return {
		guestName: cleanFieldValue(match[1]),
		nationality: cleanFieldValue(match[2]),
	};
}

function findFirstPattern(text, patterns) {
	for (const pattern of patterns) {
		const match = String(text || "").match(pattern);
		if (match && match[1]) return normalizeWhitespace(match[1]);
	}
	return "";
}

function findFirstMoneyPatternOutsideVccLines(text, patterns) {
	const lines = String(text || "").split(/\r?\n/);
	for (const line of lines) {
		if (/\b(amount\s+to\s+charge|charge\s+amount|vcc\s+amount)\b/i.test(line)) {
			continue;
		}
		for (const pattern of patterns) {
			const match = String(line || "").match(pattern);
			if (match && match[1]) return normalizeWhitespace(match[1]);
		}
	}
	return "";
}

const GENERIC_CONFIRMATION_VALUES = new Set([
	"booking",
	"confirmation",
	"confirmed",
	"details",
	"hotel",
	"id",
	"information",
	"number",
	"prepaid",
	"property",
	"reservation",
	"status",
]);

function isWeakConfirmationCandidate(value = "") {
	const normalized = normalizeComparable(value);
	if (!normalized) return true;
	// All supported OTA booking identifiers contain at least one digit. This
	// blocks flattened labels such as "cancelation", "extra", and "receive"
	// from ever becoming a reservation identity.
	if (!/\d/.test(normalized)) return true;
	if (GENERIC_CONFIRMATION_VALUES.has(normalized)) return true;
	if (/\d{5,}/.test(normalized)) return false;
	const tokens = normalized.split(" ").filter(Boolean);
	return tokens.some((token) => GENERIC_CONFIRMATION_VALUES.has(token));
}

function cleanConfirmationCandidate(value) {
	const candidate = normalizeWhitespace(value);
	if (!candidate) return "";
	const matches = candidate.match(/\b([A-Z0-9][A-Z0-9-]{4,})\b/gi) || [];
	for (const match of matches) {
		const cleanedMatch = normalizeWhitespace(match);
		if (!isWeakConfirmationCandidate(cleanedMatch)) return cleanedMatch;
	}
	const cleaned = normalizeWhitespace(candidate);
	return isWeakConfirmationCandidate(cleaned) ? "" : cleaned;
}

function findDateValue(text, labels, patterns = []) {
	const direct = parseDate(findField(text, labels));
	if (direct) return direct;
	return parseDate(findFirstPattern(text, patterns));
}

function normalizedLines(text = "") {
	return String(text || "")
		.replace(/\r/g, "")
		.split("\n")
		.map((line) => normalizeWhitespace(line))
		.filter(Boolean);
}

function findNextLineAfterExactLabel(text = "", labels = [], lookahead = 5) {
	const lines = normalizedLines(text);
	const wantedLabels = (Array.isArray(labels) ? labels : [labels]).map(
		normalizeIntlComparable
	);
	for (let index = 0; index < lines.length; index += 1) {
		if (!wantedLabels.includes(normalizeIntlComparable(lines[index]))) continue;
		for (
			let nextIndex = index + 1;
			nextIndex < Math.min(lines.length, index + 1 + lookahead);
			nextIndex += 1
		) {
			const candidate = cleanOtaDisplayValue(lines[nextIndex]).replace(
				/^<https?:\/\/[^>]+>$/i,
				""
			);
			if (candidate) return candidate;
		}
	}
	return "";
}

function stripOtaMarkdownValue(value = "") {
	return normalizeWhitespace(value)
		.replace(/[*|]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function cleanAgodaValue(value = "") {
	return cleanFieldValue(stripOtaMarkdownValue(value));
}

function extractAgodaValueBetweenLabels(
	text = "",
	startLabel = "",
	endLabels = []
) {
	const start = escapeRegExp(startLabel).replace(/\\ /g, "\\s+");
	const ends = (Array.isArray(endLabels) ? endLabels : [endLabels])
		.filter(Boolean)
		.map((label) => escapeRegExp(label).replace(/\\ /g, "\\s+"));
	if (!start || !ends.length) return "";
	const match = String(text || "").match(
		new RegExp(
			`\\b${start}\\b\\s*[:#-]?\\s*([\\s\\S]{1,120}?)\\s+(?=${ends.join(
				"|"
			)})\\b`,
			"i"
		)
	);
	return cleanAgodaValue(match?.[1] || "");
}

function extractCompactAgodaRoomDetails(text = "") {
	const header =
		/\bRoom\s+Type\s+No\.?\s+of\s+Rooms\s+Occupancy(?:\s+Children(?:'|’)?s\s+age)?\s+No\.?\s+of\s+Extra\s+Bed\s+/i;
	const headerMatch = header.exec(String(text || ""));
	if (!headerMatch) return {};
	const rowStart = headerMatch.index + headerMatch[0].length;
	const tail = String(text || "").slice(rowStart, rowStart + 420);
	const row = tail.match(
		/^([\s\S]{2,180}?)\s+(\d+)\s+(\d+)\s+Adults?(?:\s*,?\s*(\d+)\s+(?:Children|Child|Kids?))?(?:\s+[\d,\s-]+)?\s+\d+\b/i
	);
	if (!row) return {};
	const adults = Number(row[3] || 0);
	const children = Number(row[4] || 0);
	return {
		roomName: cleanAgodaValue(row[1]),
		roomCount: Math.max(1, Number(row[2] || 1)),
		adults,
		children,
		totalGuests: adults + children,
	};
}

function parseAgodaOccupancy(value = "") {
	const source = stripOtaMarkdownValue(value);
	const adults = Number(source.match(/\b(\d+)\s+adults?\b/i)?.[1] || 0);
	const children = Number(
		source.match(/\b(\d+)\s+(?:children|child|kids?)\b/i)?.[1] || 0
	);
	return {
		adults: Number.isFinite(adults) ? adults : 0,
		children: Number.isFinite(children) ? children : 0,
		totalGuests:
			(Number.isFinite(adults) ? adults : 0) +
			(Number.isFinite(children) ? children : 0),
	};
}

function parseAgodaRoomLine(value = "") {
	const source = stripOtaMarkdownValue(value);
	if (!source || !/\badults?\b/i.test(source)) return {};
	const match = source.match(
		/^(.+?)\s+(\d+)\s+(\d+)\s+adults?(?:\s+(\d+)\s+(?:children|child|kids?))?(?:\s+\d+)?$/i
	);
	if (!match) return {};
	const adults = Number(match[3] || 0);
	const children = Number(match[4] || 0);
	return {
		roomName: cleanAgodaValue(match[1]),
		roomCount: Math.max(1, Number(match[2] || 1)),
		adults: Number.isFinite(adults) ? adults : 0,
		children: Number.isFinite(children) ? children : 0,
		totalGuests:
			(Number.isFinite(adults) ? adults : 0) +
			(Number.isFinite(children) ? children : 0),
	};
}

function isAgodaRoomHeaderLine(value = "") {
	return /(room\s+type|no\.?\s+of\s+rooms|occupancy|children(?:'|’)?s\s+age|extra\s+bed)/i.test(value);
}

function extractAgodaRoomDetails(text = "") {
	const compact = extractCompactAgodaRoomDetails(text);
	if (compact.roomName) return compact;
	const lines = normalizedLines(text).map(stripOtaMarkdownValue).filter(Boolean);
	const headerIndex = lines.findIndex(
		(line) =>
			/room\s+type/i.test(line) &&
			/no\.?\s+of\s+rooms/i.test(line) &&
			/occupancy/i.test(line)
	);
	if (headerIndex >= 0) {
		for (
			let index = headerIndex + 1;
			index < Math.min(lines.length, headerIndex + 8);
			index += 1
		) {
			if (isAgodaRoomHeaderLine(lines[index])) continue;
			const parsed = parseAgodaRoomLine(lines[index]);
			if (parsed.roomName) return parsed;
		}
	}

	const roomTypeIndex = lines.findIndex(
		(line) => normalizeComparable(line) === "room type"
	);
	if (roomTypeIndex < 0) return {};
	let roomName = "";
	let roomCount = 0;
	let occupancy = {};
	let expectsRoomCount = false;
	for (
		let index = roomTypeIndex + 1;
		index < Math.min(lines.length, roomTypeIndex + 12);
		index += 1
	) {
		const line = lines[index];
		if (!line) continue;
		if (/^(?:no\.?\s+of\s+rooms|number\s+of\s+rooms|room\s+count)$/i.test(line)) {
			expectsRoomCount = true;
			continue;
		}
		if (isAgodaRoomHeaderLine(line)) continue;
		if (/^(benefits|cancellation policy|room only|rate plan)/i.test(line)) break;
		if (!roomName && !/^\d+$/.test(line) && !/\badults?\b/i.test(line)) {
			roomName = cleanAgodaValue(line);
			continue;
		}
		if (!roomCount && expectsRoomCount && /^\d+$/.test(line)) {
			roomCount = Number(line);
			expectsRoomCount = false;
			continue;
		}
		if (!occupancy.adults && /\badults?\b/i.test(line)) {
			occupancy = parseAgodaOccupancy(line);
		}
	}
	return {
		roomName,
		roomCount: roomCount || 0,
		adults: occupancy.adults || 0,
		children: occupancy.children || 0,
		totalGuests: occupancy.totalGuests || 0,
	};
}

function extractAgodaMoneyByLabel(text = "", label = "") {
	const escapedLabel = escapeRegExp(label).replace(/\\ /g, "\\s+");
	const inline = String(text || "").match(
		new RegExp(
			`${escapedLabel}\\s*[:#-]?\\s*((?:(?:${MONEY_CURRENCY_CODES.join(
				"|"
			)}|US\\$|\\$|﷼)\\s*)?[+-]?[0-9][0-9,.]*)`,
			"i"
		)
	);
	const inlineMoney = parseMoney(inline?.[1] || "");
	if (inlineMoney.amount) return inlineMoney;
	const labelComparable = normalizeComparable(label);
	const lines = normalizedLines(text).map(stripOtaMarkdownValue).filter(Boolean);
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		const lineComparable = normalizeComparable(line);
		if (
			lineComparable !== labelComparable &&
			!lineComparable.startsWith(`${labelComparable} `)
		) {
			continue;
		}
		const sameLine = parseMoney(line);
		if (sameLine.amount) return sameLine;
		for (
			let nextIndex = index + 1;
			nextIndex < Math.min(lines.length, index + 5);
			nextIndex += 1
		) {
			const parsed = parseMoney(lines[nextIndex]);
			if (parsed.amount) return parsed;
		}
	}
	return { amount: 0, currency: "" };
}

function nextAgodaValue(lines = [], startIndex = -1, skipPattern = null) {
	if (startIndex < 0) return "";
	for (
		let index = startIndex + 1;
		index < Math.min(lines.length, startIndex + 8);
		index += 1
	) {
		const candidate = cleanAgodaValue(lines[index]);
		if (!candidate) continue;
		if (skipPattern && skipPattern.test(candidate)) continue;
		return candidate;
	}
	return "";
}

function extractAgodaHotelName(text = "") {
	const lines = normalizedLines(text).map(stripOtaMarkdownValue).filter(Boolean);
	const bookingConfirmationIndex = lines.findIndex(
		(line) => normalizeComparable(line) === "booking confirmation"
	);
	const fromBlock = nextAgodaValue(
		lines,
		bookingConfirmationIndex,
		/^(prepaid|reservation information|\(?property id\b|city\b|marsha code\b)/i
	);
	if (fromBlock) return fromBlock;
	return cleanAgodaValue(
		findFirstPattern(text, [
			/\bBooking confirmation\s*\n\s*\*?([^\n*(]{2,120})\*?/i,
		])
	);
}

function extractAgodaFields(email = {}, text = "", provider = "") {
	const source = `${email.subject || ""}\n${text || ""}`;
	if (provider !== "agoda" && !/\bagoda\b/i.test(source)) return {};

	const confirmationNumber = cleanConfirmationCandidate(
		firstNonEmpty(
			findFirstPattern(source, [
				/\bAgoda\s+Booking\s+ID\s+([A-Z0-9-]{5,})\b/i,
				/\bBooking\s+ID\s*\n\s*([A-Z0-9-]{5,})\b/i,
			]),
			findNextLineAfterExactLabel(text, "Booking ID", 4)
		)
	);
	const room = extractAgodaRoomDetails(text);
	const hotelName = extractAgodaHotelName(text);
	const referenceSellRate = extractAgodaMoneyByLabel(
		text,
		"Reference sell rate (incl. taxes & fees)"
	);
	const netRate = extractAgodaMoneyByLabel(text, "Net rate (incl. taxes & fees)");
	const amountCurrency = referenceSellRate.currency || "SAR";
	const payoutCurrency = netRate.currency || amountCurrency;
	const amountConversion = getSarConversionMeta(referenceSellRate.amount, amountCurrency);
	const payoutConversion = getSarConversionMeta(netRate.amount, payoutCurrency);
	const firstName = firstNonEmpty(
		extractAgodaValueBetweenLabels(text, "Customer First Name", [
			"Customer Last Name",
		]),
		findField(text, ["Customer First Name"])
	);
	const textReferenceSellRateOccurrences = (
		String(email.text || "").match(
			/Reference sell rate \(incl\. taxes & fees\)/gi
		) || []
	).length;
	const htmlReferenceSellRateOccurrences = (
		htmlToText(email.html || "").match(
			/Reference sell rate \(incl\. taxes & fees\)/gi
		) || []
	).length;
	const referenceSellRateOccurrences =
		textReferenceSellRateOccurrences || htmlReferenceSellRateOccurrences
			? Math.max(
					textReferenceSellRateOccurrences,
					htmlReferenceSellRateOccurrences
			  )
			: (
					String(text || "").match(
						/Reference sell rate \(incl\. taxes & fees\)/gi
					) || []
			  ).length;
	const agodaRoomReferences = Array.from(
		new Set(
			Array.from(String(text || "").matchAll(/\[?Rm\s*No\.?\s*(\d+)\]?/gi))
				.map((match) => Number(match[1] || 0))
				.filter((value) => value > 0)
		)
	);
	const multiRoomEvidence =
		Number(room.roomCount || 0) > 1 || agodaRoomReferences.length > 1;
	const lastName = firstNonEmpty(
		extractAgodaValueBetweenLabels(text, "Customer Last Name", [
			"Country of Residence",
			"Check-in",
		]),
		findField(text, ["Customer Last Name"])
	);
	const customerInfoName = findFirstPattern(text, [
		/Customer\s+Info\s*-\s*Name\s*:\s*([^,\n]{2,120})/i,
	]);
	const guestName = cleanAgodaValue(
		firstNonEmpty([firstName, lastName].filter(Boolean).join(" "), customerInfoName)
	);
	const guestPhone = cleanAgodaValue(
		findFirstPattern(text, [
			/Customer\s+Info\s*-\s*Name\s*:[^,\n]+,\s*Phone\s*:\s*([+\d\s().-]{6,})/i,
		])
	);
	const nationality = cleanAgodaValue(
		firstNonEmpty(
			extractAgodaValueBetweenLabels(text, "Country of Residence", [
				"Check-in",
			]),
			findField(text, ["Country of Residence"]),
			findField(text, ["Country"])
		)
	);
	const aliases = Array.from(
		new Set(
			[hotelName, ...explicitHotelNameAliases(hotelName)]
				.map((item) => normalizeWhitespace(item))
				.filter(Boolean)
		)
	);
	const paymentCollectionModel =
		/\b(prepaid|booked and payable by\s+agoda)\b/i.test(source)
			? "ota_collect"
			: "unknown";

	return {
		confirmationNumber,
		reservationId: confirmationNumber,
		hotelName,
		hotelNameAliases: aliases,
		roomName: room.roomName || "",
		roomCount: room.roomCount || 0,
		adults: room.adults || 0,
		children: room.children || 0,
		totalGuests: room.totalGuests || 0,
		guestName,
		guestPhone,
		nationality,
		amount: referenceSellRate.amount || 0,
		currency: amountCurrency,
		totalAmountSar: amountConversion.totalAmountSar || 0,
		sourceAmount: referenceSellRate.amount || 0,
		sourceCurrency: amountCurrency,
		exchangeRateToSar: amountConversion.exchangeRateToSar || 0,
		exchangeRateSource: amountConversion.exchangeRateSource || "",
		amountConvertedAt: amountConversion.convertedAt || "",
		totalPayoutSar: payoutConversion.totalAmountSar || 0,
		netAfterExpensesTotal: payoutConversion.totalAmountSar || 0,
		paymentSummary:
			referenceSellRate.amount || netRate.amount
				? {
						sourceCurrency: amountCurrency,
						sourceTotalGuestPaymentAmount: referenceSellRate.amount || 0,
						sourceTotalPayoutAmount: netRate.amount || 0,
						totalGuestPaymentAmount: amountConversion.totalAmountSar || 0,
						totalPayoutAmount: payoutConversion.totalAmountSar || 0,
						currency: "SAR",
						exchangeRateToSar: amountConversion.exchangeRateToSar || 0,
						exchangeRateSource: amountConversion.exchangeRateSource || "",
						amountConvertedAt: amountConversion.convertedAt || "",
				  }
				: {},
		paymentCollectionModel,
		paymentInstructions:
			paymentCollectionModel === "ota_collect"
				? "Agoda prepaid reservation; net rate is provided by Agoda."
				: "",
		referenceSellRateOccurrences,
		multiRoomEvidence,
		sourcePresence: {
			confirmationNumber: !!confirmationNumber,
			reservationId: !!confirmationNumber,
			hotelName: !!hotelName,
			roomName: !!room.roomName,
			roomCount: !!room.roomCount,
			adults: !!room.adults,
			children: room.children > 0,
			totalGuests: !!room.totalGuests,
			guestName: !!guestName,
			guestPhone: !!guestPhone,
			nationality: !!nationality,
			amount: referenceSellRate.amount > 0,
			paymentCollectionModel: paymentCollectionModel !== "unknown",
			paymentInstructions: !!paymentCollectionModel && paymentCollectionModel !== "unknown",
		},
	};
}

function extractAirbnbConfirmationNumber(text = "") {
	const fromUrl = findFirstPattern(text, [
		/airbnb\.com\/hosting\/reservations\/details\/([A-Z0-9]{6,24})\b/i,
	]);
	const fromLabel = findNextLineAfterExactLabel(text, "Confirmation code", 4);
	const candidate = firstNonEmpty(fromUrl, fromLabel);
	return /^[A-Z0-9]{6,24}$/i.test(candidate)
		? normalizeWhitespace(candidate).toUpperCase()
		: "";
}

function extractAirbnbGuestName(email = {}, text = "") {
	const source = `${email.subject || ""}\n${text || ""}`;
	const fromSubject = findFirstPattern(source, [
		/\bReservation confirmed\s*-\s*([^\n-]{2,120}?)\s+arrives\s+/i,
		/\bNew booking confirmed!?\s*([^\n.]{2,120}?)\s+arrives\s+/i,
	]);
	if (fromSubject) return cleanOtaDisplayValue(fromSubject);

	const lines = normalizedLines(text);
	for (let index = 0; index < lines.length; index += 1) {
		if (/identity verified/i.test(lines[index + 1] || "")) {
			const candidate = cleanOtaDisplayValue(lines[index]);
			if (candidate && !/airbnb|reservation|message|booking/i.test(candidate)) {
				return candidate;
			}
		}
	}
	return "";
}

function extractAirbnbHostLabels(text = "") {
	const labels = [];
	const source = String(text || "");
	const greeting = source.match(
		/(?:^|\n)\s*(?:Salaam|Hello|Hi|Dear)\s+([^,\n]{2,80}),/i
	);
	const hostName = cleanOtaDisplayValue(greeting?.[1] || "");
	if (hostName) {
		labels.push(hostName);
		labels.push(`Salaam ${hostName}`);
	}
	return Array.from(new Set(labels.filter(Boolean)));
}

function extractAirbnbGuestMessage(text = "") {
	const source = String(text || "");
	const match = source.match(
		/(?:^|\n)\s*(?:Salaam|Hello|Hi|Dear)\s+[^,\n]{2,80},\s*\n([\s\S]{1,500}?)(?:\n\s*Send\s+[^\n]*\s+a\s+Message|\n\s*\[image:|\n\s*<https:\/\/www\.airbnb\.com\/hosting\/thread)/i
	);
	return cleanOtaGuestNote(match?.[1] || "");
}

function extractAirbnbListingTitle(text = "") {
	const imageTitle = findFirstPattern(text, [
		/\[image:\s*([^\]]{3,180})\]\s*\n\s*<https:\/\/www\.airbnb\.com\/rooms/i,
	]);
	if (imageTitle) return cleanOtaDisplayValue(imageTitle);

	const lines = normalizedLines(text);
	for (let index = 1; index < lines.length; index += 1) {
		if (normalizeIntlComparable(lines[index]) !== "room") continue;
		for (let previous = index - 1; previous >= Math.max(0, index - 4); previous -= 1) {
			const candidate = cleanOtaDisplayValue(lines[previous]);
			if (
				candidate &&
				!/^<https?:\/\//i.test(candidate) &&
				!/airbnb|message|identity verified/i.test(candidate)
			) {
				return candidate;
			}
		}
	}
	return "";
}

function extractAirbnbListingId(text = "") {
	return findFirstPattern(text, [
		/airbnb\.com\/rooms\/(\d{6,24})\b/i,
		/airbnb\.com\/hosting\/listings\/(\d{6,24})\b/i,
	]);
}

function parseAirbnbMonthDay(value = "", year) {
	const cleaned = normalizeWhitespace(value)
		.replace(/\b(mon|tue|wed|thu|fri|sat|sun)(day)?\b,?\s*/gi, "")
		.replace(/\s+\d{1,2}:\d{2}.*$/i, "")
		.trim();
	if (!cleaned || !year) return null;
	for (const format of ["MMM D YYYY", "MMMM D YYYY"]) {
		const parsed = dayjs(`${cleaned} ${year}`, format, true);
		if (parsed.isValid()) return parsed;
	}
	return null;
}

function airbnbReferenceDate(email = {}, text = "") {
	const forwardedDate = findFirstPattern(text, [
		/(?:^|\n)\s*Date:\s*([^\n]{5,160})/i,
	]);
	const parsed = parseDate(
		firstNonEmpty(email.date, email.receivedAt, forwardedDate)
	);
	return parsed && dayjs(parsed).isValid() ? dayjs(parsed) : dayjs();
}

function extractAirbnbStayDates(email = {}, text = "") {
	const checkinRaw = findNextLineAfterExactLabel(text, "Check-in", 5);
	const checkoutRaw = findNextLineAfterExactLabel(text, "Checkout", 5);
	const reference = airbnbReferenceDate(email, text);
	let checkin = /\b\d{4}\b/.test(checkinRaw) ? parseDate(checkinRaw) : null;
	let checkout = /\b\d{4}\b/.test(checkoutRaw) ? parseDate(checkoutRaw) : null;

	if (!checkin || !checkout) {
		const year = reference.year();
		let checkinDay = parseAirbnbMonthDay(checkinRaw, year);
		let checkoutDay = parseAirbnbMonthDay(checkoutRaw, year);
		if (checkinDay && reference.isValid() && checkinDay.isBefore(reference.subtract(2, "day"), "day")) {
			checkinDay = checkinDay.add(1, "year");
		}
		if (checkinDay && checkoutDay && !checkoutDay.isAfter(checkinDay, "day")) {
			// Only roll over a year for an actual Dec/Jan-style boundary. Equal
			// month/day values are ambiguous template output, not a 365-day stay.
			if (checkoutDay.month() < checkinDay.month()) {
				checkoutDay = checkoutDay.add(1, "year");
			} else {
				checkoutDay = null;
			}
		}
		checkin = checkinDay?.isValid() ? checkinDay.format("YYYY-MM-DD") : checkin;
		checkout = checkoutDay?.isValid() ? checkoutDay.format("YYYY-MM-DD") : checkout;
	}

	return { checkinDate: checkin || null, checkoutDate: checkout || null };
}

function extractAirbnbOccupancy(text = "") {
	const guestsLine = findNextLineAfterExactLabel(text, "Guests", 4);
	const adultMatch = guestsLine.match(/\b(\d+)\s+adults?\b/i);
	const childMatch = guestsLine.match(/\b(\d+)\s+children?\b/i);
	const infantMatch = guestsLine.match(/\b(\d+)\s+infants?\b/i);
	const adults = adultMatch ? Number(adultMatch[1]) : 0;
	const children = childMatch ? Number(childMatch[1]) : 0;
	const infants = infantMatch ? Number(infantMatch[1]) : 0;
	const totalGuests = adults + children + infants || countNumber(guestsLine);
	return { adults, children, totalGuests };
}

function extractAirbnbMoneyAfterLabel(text = "", label = "") {
	const labelValue = findNextLineAfterExactLabel(text, label, 4);
	const parsed = parseMoney(labelValue);
	if (parsed.amount) return parsed;
	const patternLabel = escapeRegExp(label).replace(/\\ /g, "\\s+");
	const match = String(text || "").match(
		new RegExp(`${patternLabel}\\s*\\n\\s*((?:SR|SAR|USD|US\\$|\\$)\\s*[0-9][0-9,.]*)`, "i")
	);
	return parseMoney(match?.[1] || "");
}

function normalizeMappingKey(value = "") {
	return normalizeIntlComparable(value);
}

function parseAirbnbHotelMapEntries() {
	const raw = String(
		process.env.OTA_AIRBNB_EMAIL_HOTEL_MAP ||
			process.env.OTA_AIRBNB_HOTEL_MAP ||
			""
	).trim();
	if (!raw) return [];

	if (/^\s*[\[{]/.test(raw)) {
		try {
			const parsed = JSON.parse(raw);
			const entries = Array.isArray(parsed)
				? parsed
				: Object.entries(parsed || {}).map(([source, target]) => ({
						source,
						target,
				  }));
			return entries
				.map((entry) => ({
					source: normalizeWhitespace(entry.source || entry.key || entry.host || entry.listing || entry.title || ""),
					target: normalizeWhitespace(entry.target || entry.hotelId || entry.hotelName || ""),
					type: normalizeWhitespace(entry.type || ""),
				}))
				.filter((entry) => entry.source && entry.target);
		} catch (_error) {
			return [];
		}
	}

	return raw
		.split(/\r?\n|;/)
		.map((part) => part.trim())
		.filter(Boolean)
		.map((part) => {
			const [left, ...rightParts] = part.split("=");
			const target = normalizeWhitespace(rightParts.join("="));
			const sourceRaw = normalizeWhitespace(left);
			const typed = sourceRaw.match(/^(host|listing|title|to|from)\s*:\s*(.+)$/i);
			return {
				type: normalizeWhitespace(typed?.[1] || ""),
				source: normalizeWhitespace(typed?.[2] || sourceRaw),
				target,
			};
		})
		.filter((entry) => entry.source && entry.target);
}

function mappingTargetToHotel(target = "") {
	const value = normalizeWhitespace(target);
	if (/^[a-f0-9]{24}$/i.test(value)) return { hotelId: value };
	return { hotelName: value };
}

function resolveConfiguredAirbnbHotelMapping(context = {}) {
	const entries = parseAirbnbHotelMapEntries();
	const candidates = [
		context.listingId ? { type: "listing", value: context.listingId } : null,
		context.listingTitle ? { type: "title", value: context.listingTitle } : null,
	].filter(Boolean);
	const allowedTypes = new Set([
		"",
		"listing",
		"listing id",
		"airbnb listing",
		"title",
		"listing title",
		"room",
		"room title",
	]);

	const matchesEntryType = (entryType, candidateType) => {
		if (
			entryType &&
			(entryType.includes("listing") || entryType === "airbnb listing")
		) {
			return candidateType === "listing";
		}
		if (entryType && (entryType.includes("title") || entryType.includes("room"))) {
			return candidateType === "title";
		}
		return true;
	};

	const resolveEntryMatch = (matchStrength) => {
		for (const entry of entries) {
			const entryType = normalizeMappingKey(entry.type);
			if (!allowedTypes.has(entryType)) continue;
			const entrySource = normalizeMappingKey(entry.source);
			if (!entrySource) continue;
			const match = candidates.find((candidate) => {
				if (!matchesEntryType(entryType, candidate.type)) return false;
				const candidateValue = normalizeMappingKey(candidate.value);
				if (!candidateValue) return false;
				if (matchStrength === "exact") return candidateValue === entrySource;
				return candidateValue.includes(entrySource);
			});
			if (!match) continue;
			return {
				...mappingTargetToHotel(entry.target),
				matchedBy: entry.type || match.type,
				matchedValue: match.value,
				matchStrength,
			};
		}
		return {};
	};

	if (entries.length) {
		const exactMatch = resolveEntryMatch("exact");
		if (exactMatch.hotelId || exactMatch.hotelName) return exactMatch;
	}

	const ajyadMatchedValue = [
		context.listingTitle,
		...(Array.isArray(context.hostLabels) ? context.hostLabels : []),
	]
		.filter(Boolean)
		.find((value) => containsAjyadKeyword(value));
	if (ajyadMatchedValue) {
		return {
			hotelId: configuredAjyadHotelId(),
			matchedBy: "ajyad keyword",
			matchedValue: ajyadMatchedValue,
			matchStrength: "keyword",
		};
	}

	if (!entries.length) return {};

	const fuzzyMatch = resolveEntryMatch("fuzzy");
	if (fuzzyMatch.hotelId || fuzzyMatch.hotelName) return fuzzyMatch;
	return {};
}

function extractAirbnbFields(email = {}, text = "", provider = "") {
	if (provider !== "airbnb" && !/airbnb/i.test(`${email.from || ""} ${email.subject || ""} ${text}`)) {
		return {};
	}

	const confirmationNumber = extractAirbnbConfirmationNumber(text);
	const guestName = extractAirbnbGuestName(email, text);
	const guestNotes = extractAirbnbGuestMessage(text);
	const hostLabels = extractAirbnbHostLabels(text);
	const listingTitle = extractAirbnbListingTitle(text);
	const listingId = extractAirbnbListingId(text);
	const stayDates = extractAirbnbStayDates(email, text);
	const occupancy = extractAirbnbOccupancy(text);
	const guestTotal = extractAirbnbMoneyAfterLabel(text, "Total (SAR)");
	const payout = extractAirbnbMoneyAfterLabel(text, "You earn");
	const guestTotalCurrency = guestTotal.currency || "SAR";
	const payoutCurrency = payout.currency || guestTotalCurrency || "SAR";
	const guestTotalConversion = getSarConversionMeta(
		guestTotal.amount,
		guestTotalCurrency
	);
	const payoutConversion = getSarConversionMeta(payout.amount, payoutCurrency);
	const hotelMapping = resolveConfiguredAirbnbHotelMapping({
		hostLabels,
		listingId,
		listingTitle,
		to: email.to || "",
		from: email.from || "",
	});

	return {
		confirmationNumber,
		guestName,
		guestNotes,
		hostLabels,
		listingTitle,
		listingId,
		airbnbListingId: listingId,
		airbnbListingTitle: listingTitle,
		roomName: listingTitle,
		...stayDates,
		...occupancy,
		amount: guestTotal.amount || 0,
		currency: guestTotalCurrency,
		totalAmountSar: guestTotalConversion.totalAmountSar,
		exchangeRateToSar: guestTotalConversion.exchangeRateToSar,
		exchangeRateSource: guestTotalConversion.exchangeRateSource,
		amountConvertedAt: guestTotalConversion.convertedAt,
		totalPayoutSar: payoutConversion.totalAmountSar,
		netAfterExpensesTotal: payoutConversion.totalAmountSar,
		paymentSummary:
			guestTotal.amount || payout.amount
				? {
						sourceCurrency: guestTotalCurrency,
						sourceTotalGuestPaymentAmount: guestTotal.amount || 0,
						sourceTotalPayoutAmount: payout.amount || 0,
						totalGuestPaymentAmount: guestTotalConversion.totalAmountSar,
						totalPayoutAmount: payoutConversion.totalAmountSar,
						currency: "SAR",
						exchangeRateToSar: guestTotalConversion.exchangeRateToSar,
						exchangeRateSource: guestTotalConversion.exchangeRateSource,
						amountConvertedAt: guestTotalConversion.convertedAt,
				  }
				: {},
		paymentCollectionModel: guestTotal.amount ? "ota_collect" : "unknown",
		paymentInstructions: guestTotal.amount
			? "Airbnb collected guest payment; host payout is provided by Airbnb."
			: "",
		hotelId: hotelMapping.hotelId || "",
		hotelName: hotelMapping.hotelName || "",
		hotelNameAliases: hostLabels,
		hotelIdMatchStrength: hotelMapping.matchStrength || "",
		hotelIdMatchedBy: hotelMapping.matchedBy || "",
		hotelIdMatchedValue: hotelMapping.matchedValue || "",
		airbnbMapping: hotelMapping,
	};
}

function isOtaHotelBoilerplateLine(value = "") {
	return /(tax invoice|official tax|enumerated|identified bookings|expedia partner central|lodging partner services|unless properly|total transaction amounts|supersede any other tax invoices|for suppliers in us only|do not reply|privacy policy)/i.test(
		String(value || "")
	);
}

function defaultOtaReviewNetTotal(
	clientTotal = 0,
	deductionRate = DEFAULT_OTA_REVIEW_DEDUCTION_RATE
) {
	const total = round2(clientTotal);
	if (total <= 0) return 0;
	return round2(total - defaultOtaReviewDeductionAmount(total, deductionRate));
}

function defaultOtaReviewDeductionAmount(
	clientTotal = 0,
	deductionRate = DEFAULT_OTA_REVIEW_DEDUCTION_RATE
) {
	const total = round2(clientTotal);
	if (total <= 0) return 0;
	return round2(total * clampDeductionRate(deductionRate));
}

function isExpediaSyncSource(normalized = {}) {
	return normalizeComparable(normalized.source?.from || "") === "expedia sync";
}

function isOtaInboundEmail(normalized = {}) {
	const inboundEmailId = normalizeWhitespace(normalized.inboundEmailId || "");
	if (isExpediaSyncSource(normalized) || inboundEmailId.startsWith("ota-sync:")) {
		return false;
	}
	if (inboundEmailId) return true;
	const source = normalized.source || {};
	return Boolean(
		source.messageId ||
			source.textHash ||
			source.safeSnippet ||
			(source.subject && source.from)
	);
}

function isOtaInboundTotalOutlier(normalized = {}) {
	const totalAmountSar = Number(normalized.totalAmountSar || 0);
	return (
		isOtaInboundEmail(normalized) &&
		Number.isFinite(totalAmountSar) &&
		totalAmountSar > MAX_OTA_INBOUND_RESERVATION_TOTAL_SAR
	);
}

function otaProviderKey(normalized = {}) {
	return normalizeComparable(
		normalized.provider ||
			normalized.providerLabel ||
			normalized.bookingSource ||
			""
	);
}

function isExpediaProvider(normalized = {}) {
	return otaProviderKey(normalized).includes("expedia");
}

function resolveOtaReviewDeductionRate(normalized = {}) {
	if (isOtaInboundEmail(normalized) && !isExpediaProvider(normalized)) {
		return DEFAULT_OTA_INBOUND_EMAIL_DEDUCTION_RATE;
	}
	return DEFAULT_OTA_REVIEW_DEDUCTION_RATE;
}

function hasExplicitOtaPayoutSar(normalized = {}) {
	const paymentSummary = normalized.paymentSummary || {};
	return [
		normalized.totalPayoutSar,
		normalized.netAfterExpensesTotal,
		paymentSummary.totalPayoutAmount,
	].some((value) => Number(value || 0) > 0);
}

function isOtaCollectPayment(normalized = {}) {
	const collectionModel = normalizeComparable(
		normalized.paymentCollectionModel || normalized.paymentInstructions || ""
	);
	return (
		normalized.paidOnline === true ||
		collectionModel.includes("ota collect") ||
		collectionModel.includes("expedia collect") ||
		collectionModel.includes("paid online") ||
		collectionModel.includes("prepaid")
	);
}

function shouldUseExpediaInboundClientTotalFallback(normalized = {}) {
	return (
		isOtaInboundEmail(normalized) &&
		isExpediaProvider(normalized) &&
		isOtaCollectPayment(normalized) &&
		!hasExplicitOtaPayoutSar(normalized) &&
		Number(normalized.totalAmountSar || normalized.amount || 0) > 0
	);
}

function cleanHotelNameCandidate(value = "") {
	const candidate = cleanOtaDisplayValue(value);
	if (!candidate || isOtaHotelBoilerplateLine(candidate)) return "";
	return candidate;
}

function findStandaloneHotelName(text) {
	const blocked = /(notice|reservation|confirmation|cancellation|cancelled|booking|guest|email|room|payment|billing|check[-\s]?in|check[-\s]?out|daily base|rate code|taxes|charges|amount|card|activation|expiration|validation|virtual card|logo|province|country|date|subject|from|to|tax invoice|official tax|enumerated|supplier|supersede|identified bookings)/i;
	const lines = String(text || "")
		.replace(/\r/g, "")
		.split("\n")
		.map((line) => normalizeWhitespace(line))
		.filter(Boolean);

	for (const line of lines) {
		if (!/\b(hotel|resort|suite|suites|inn|apartment|apartments|motel|property)\b/i.test(line)) {
			continue;
		}
		if (blocked.test(line)) continue;
		if (line.length < 4 || line.length > 90) continue;
		const candidate = cleanHotelNameCandidate(line);
		if (!candidate || candidate.length > 90) continue;
		return candidate;
	}
	return "";
}

function cleanEmailValue(value = "") {
	const match = String(value || "").match(
		/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i
	);
	return normalizeWhitespace(match?.[0] || value).replace(/^\*+\s*/, "");
}

function cleanOtaDisplayValue(value = "") {
	const cleaned = normalizeWhitespace(value)
		.replace(/^\*+\s*/, "")
		.replace(/\s+\*+$/g, "")
		.replace(/\[image:[^\]]+\]/gi, " ")
		.replace(/\b(?:image|logo)\b/gi, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!cleaned) return "";
	if (
		/(hotel\s+conf\b|tax invoice|official tax|pre[-\s]?paid|notice|vendor|enumerated|lodging partner services|partner central|do not reply)/i.test(
			cleaned
		)
	) {
		return "";
	}
	return cleaned;
}

function findHotelNameField(text = "") {
	const labeled = cleanFieldValue(findField(text, [
		"Property name",
		"Hotel name",
		"Accommodation",
		"Listing",
	]));
	if (labeled) return labeled;

	const source = String(text || "").replace(/\r/g, "");
	const inline = source.match(/(?:^|\n)\s*Property\s*[:#-]\s*([^\n]{1,140})/i);
	const inlineCandidate = cleanFieldValue(inline?.[1] || "");
	if (inlineCandidate) return inlineCandidate;

	const lines = source
		.split("\n")
		.map((line) => normalizeWhitespace(line))
		.filter(Boolean);
	const propertyIndex = lines.findIndex(
		(line) => normalizeComparable(line) === "property"
	);
	if (propertyIndex >= 0) {
		return cleanFieldValue(lines[propertyIndex + 1] || "");
	}
	return "";
}

function cleanExpediaHeaderHotelName(value = "") {
	const candidate = cleanHotelNameCandidate(
		String(value || "")
			.replace(/\[image:[^\]]+\]/gi, " ")
			.replace(/\b(?:expedia|lodging|partner|services|ean|logo)\b/gi, " ")
	);
	if (
		!candidate ||
		candidate.length > 90 ||
		!/\b(hotel|resort|suite|suites|inn|apartment|apartments|motel|property)\b/i.test(
			candidate
		)
	) {
		return "";
	}
	return candidate;
}

function extractProviderLogoHotelName(text = "", provider = "") {
	const providerPattern =
		provider === "booking"
			? "booking\\.com"
			: provider === "agoda"
			? "agoda"
			: provider === "hotels"
			? "hotels\\.com"
			: "expedia";
	const lines = String(text || "")
		.replace(/\r/g, "")
		.split("\n")
		.map((line) => normalizeWhitespace(line))
		.filter(Boolean);

	if (provider === "expedia") {
		for (let index = 0; index < lines.length; index += 1) {
			const combined = `${lines[index]} ${lines[index + 1] || ""}`;
			const match = combined.match(
				/\[image:\s*(?:EAN|Expedia)\s+logo\]\s+(.+?)(?:\s+\[image:\s*Expedia\s+Lodging(?:\s+Partner\s+Services)?\]?|\s+Expedia\s+Lodging(?:\s+Partner\s+Services)?|$)/i
			);
			const candidate = cleanExpediaHeaderHotelName(match?.[1] || "");
			if (candidate) return candidate;
		}
	}

	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (!new RegExp(providerPattern, "i").test(line) || !/logo|image/i.test(line)) {
			continue;
		}
		const combined = `${line} ${lines[index + 1] || ""}`;
		const match = combined.match(
			new RegExp(
				`${providerPattern}\\s+logo\\]?\\s+(.+?)(?:\\s+\\[?(?:image:\\s*)?(?:expedia\\s+lodging\\s+partner\\s+services|lodging\\s+partner\\s+services|booking\\.com|agoda|hotels\\.com)|$)`,
				"i"
			)
		);
		const candidate = cleanHotelNameCandidate(match?.[1] || "");
		if (candidate && candidate.length <= 90) return candidate;
	}

	const expediaFallback = String(text || "").match(
		/(?:New Reservation|New Booking|Cancellation|Modified Reservation)[\s\S]{0,220}?Expedia\s+Logo\]?\s+(.+?)(?:\s+\[?(?:image:\s*)?Expedia\s+Lodging\s+Partner\s+Services|\n[A-Za-z ,]+,\s*[A-Z]{3})/i
	);
	const candidate = cleanHotelNameCandidate(expediaFallback?.[1] || "");
	return candidate && candidate.length <= 90 ? candidate : "";
}

function extractProviderGuestName(text = "") {
	const source = String(text || "");
	const matches = [
		source.match(
			/\bGuest\s*:\s*\*?\s*(?:\n\s*\*?\s*)?([^\n]{1,140}?)(?=\s+Booked\s+on:|\s+\d{1,2}\s+\d{6,}|\n|$)/i
		),
		source.match(
			/(?:^|\n)\s*(?:Guest name|Primary guest|Lead guest)\s*[:#-]\s*([^\n]{1,140})/i
		),
		source.match(
			/(?:^|\n)\s*(?:Customer name|Name)\s*[:#-]\s*([^\n]{1,140})/i
		),
	];
	for (const match of matches) {
		const candidate = cleanOtaDisplayValue(match?.[1] || "");
		if (
			candidate &&
			!/pre[-\s]?paid|email|phone|room|reservation|booking|payment/i.test(candidate)
		) {
			return candidate;
		}
	}
	return "";
}

function monthDatePattern() {
	return dateTextPattern();
}

function dateTextPattern() {
	const month = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*";
	return `(?:${month}\\s+\\d{1,2},?\\s+\\d{4}|\\d{1,2}\\s+${month}\\s+\\d{4}|\\d{1,2}[/-]\\d{1,2}[/-]\\d{2,4})`;
}

function extractTableStayDates(text = "") {
	const datePattern = dateTextPattern();
	const source = String(text || "");
	const tableMatch = source.match(
		new RegExp(
			`Check[-\\s]?In\\s+Check[-\\s]?Out[\\s\\S]{0,260}?(${datePattern})\\s+(${datePattern})`,
			"i"
		)
	);
	if (tableMatch) {
		return {
			checkinDate: parseDate(tableMatch[1]),
			checkoutDate: parseDate(tableMatch[2]),
		};
	}
	const inlineMatch = source.match(
		new RegExp(
			`(?:Check[-\\s]?In|Arrival)[^\\n]{0,80}?(${datePattern})[\\s\\S]{0,160}?(?:Check[-\\s]?Out|Departure)[^\\n]{0,80}?(${datePattern})`,
			"i"
		)
	);
	return {
		checkinDate: parseDate(inlineMatch?.[1] || ""),
		checkoutDate: parseDate(inlineMatch?.[2] || ""),
	};
}

function extractTableOccupancy(text = "") {
	const lines = String(text || "")
		.replace(/\r/g, "")
		.split("\n")
		.map((line) => normalizeWhitespace(line))
		.filter(Boolean);
	const datePattern = monthDatePattern();
	const datePair = new RegExp(`^${datePattern}\\s+${datePattern}\\s+(.+)$`, "i");

	for (let index = 0; index < lines.length; index += 1) {
		if (
			!/Check[-\s]?In/i.test(lines[index]) ||
			!/Check[-\s]?Out/i.test(lines[index]) ||
			!/Adults/i.test(lines[index])
		) {
			continue;
		}
		const match = lines[index + 1]?.match(datePair);
		if (!match) continue;
		const numbers = normalizeWhitespace(match[1])
			.match(/\b\d+\b/g)
			?.map(Number)
			.filter((item) => Number.isFinite(item)) || [];
		const adults = numbers[0] || 0;
		const children = numbers[1] || 0;
		return {
			adults,
			children,
			totalGuests: adults + children,
		};
	}
	return { adults: 0, children: 0, totalGuests: 0 };
}

function cleanFieldValue(value = "") {
	return cleanOtaDisplayValue(value).replace(/^\*+\s*/, "");
}

const OTA_GUEST_NOTE_LABELS = [
	"Guest notes",
	"Guest note",
	"Guest comments",
	"Guest comment",
	"Guest requests",
	"Guest request",
	"Guest message",
	"Message from guest",
	"Special requests",
	"Special request",
	"Customer notes",
	"Customer note",
	"Booking note",
	"Reservation note",
	"Remarks",
	"Remark",
	"Comments",
	"Comment",
	"Notes",
	"Note",
];

const OTA_GUEST_NOTE_DIRECT_LABELS = OTA_GUEST_NOTE_LABELS.filter(
	(label) => !/^(?:comments?|notes?|remarks?)$/i.test(label)
);

const OTA_GUEST_NOTE_STOP_LABEL_PATTERN =
	/^(?:reservation|confirmation|booking|itinerary|hotel|property|room|check[-\s]?in|check[-\s]?out|arrival|departure|booked|status|customer info|customer information|guest info|guest information|customer first name|customer last name|country of residence|guest name|guest email|guest phone|phone|email|nationality|country|adults?|children|guests?|payment|pricing|rate|tax|taxes|total|amount|currency|card|virtual card|expiration|activation|cancellation|policy|source|supplier|attention hotel staff|booked and payable by|agoda hotline)\b/i;

function isOtaGuestNoteMetadataLine(value = "") {
	const normalized = normalizeComparable(value);
	if (!normalized) return false;
	if (/^(customer|guest) (info|information)\b/.test(normalized)) return true;
	if (
		/^(customer|guest) (first name|last name|name|phone|email|country of residence|residence country|nationality)\b/.test(
			normalized
		)
	) {
		return true;
	}
	if (/^(name|phone|email|nationality|country of residence|residence country)\b/.test(normalized)) {
		return true;
	}
	return false;
}

function cleanOtaGuestNote(value = "") {
	const cleaned = cleanOtaDisplayValue(redactSensitive(value))
		.replace(
			/^(?:guest|customer)?\s*(?:notes?|comments?|requests?|message|remarks?|booking note|reservation note|special requests?)\s*(?:[:#-]|is)?\s*/i,
			""
		)
		.replace(/\s+/g, " ")
		.trim();
	if (!cleaned) return "";
	if (/^(?:n\/?a|na|none|null|nil|-+|not provided|not applicable)$/i.test(cleaned)) {
		return "";
	}
	if (/^(?:no\s+)?(?:special\s+)?(?:requests?|comments?|notes?)$/i.test(cleaned)) {
		return "";
	}
	if (isOtaGuestNoteMetadataLine(cleaned)) return "";
	if (isOtaHotelBoilerplateLine(cleaned)) return "";
	if (
		/(?:privacy policy|do not reply|terms of use|payment details|total guest payment|amount to charge|card number|validation code|cvv|cvc)/i.test(
			cleaned
		)
	) {
		return "";
	}
	if (OTA_GUEST_NOTE_STOP_LABEL_PATTERN.test(cleaned)) return "";
	return safeSnippet(cleaned, 700);
}

function findGuestNoteField(text = "") {
	const direct = cleanOtaGuestNote(findField(text, OTA_GUEST_NOTE_DIRECT_LABELS));
	if (direct) return direct;

	const source = String(text || "").replace(/\r/g, "");
	const labelPattern = OTA_GUEST_NOTE_LABELS.map((label) =>
		escapeRegExp(label).replace(/\\ /g, "\\s+")
	).join("|");
	const blockMatch = source.match(
		new RegExp(
			`(?:^|\\n)\\s*(?:${labelPattern})\\s*(?:[:#\\-]|is)?\\s*([\\s\\S]{1,700})`,
			"i"
		)
	);
	if (!blockMatch) return "";

	const collected = [];
	for (const rawLine of blockMatch[1].split(/\n/)) {
		const line = normalizeWhitespace(rawLine);
		if (!line) {
			if (collected.length) break;
			continue;
		}
		if (OTA_GUEST_NOTE_STOP_LABEL_PATTERN.test(line)) break;
		const noteLine = cleanOtaGuestNote(line);
		if (noteLine) collected.push(noteLine);
		if (collected.join(" ").length >= 650) break;
	}

	return cleanOtaGuestNote(collected.join(" "));
}

function detectProvider({ from = "", to = "", subject = "", text = "" } = {}) {
	const haystack = `${from} ${to} ${subject} ${text}`.toLowerCase();
	if (haystack.includes("expedia") || haystack.includes("expediapartnercentral")) {
		return "expedia";
	}
	if (haystack.includes("hotels.com")) return "hotels";
	if (
		/(^|[^a-z0-9])booking\.com([^a-z0-9]|$)/i.test(haystack) ||
		/@(?:[\w.-]+\.)?booking\.com\b/i.test(haystack)
	) {
		return "booking";
	}
	if (haystack.includes("agoda")) return "agoda";
	if (haystack.includes("airbnb")) return "airbnb";
	if (haystack.includes("hotelrunner")) return "hotelrunner";
	if (haystack.includes("trip.com") || haystack.includes("@trip")) return "trip";
	return "unknown";
}

function cleanBookingSourceCandidate(value = "") {
	const cleaned = normalizeWhitespace(value)
		.replace(/^(\[external\]\s*)?((re|fw|fwd)\s*:\s*)+/i, "")
		.replace(/<[^>]+>/g, " ")
		.replace(/["'()[\]{}]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!cleaned) return "";
	const candidate = cleaned
		.split(/\s+(?:-|–|—|\||:)\s+|(?:-|–|—|\||:)/)[0]
		.replace(/\b(group|travel|partner|central|reservations?|bookings?|notification|mail|noreply|no[-\s]?reply)\b/gi, " ")
		.replace(/[^a-z0-9. ]/gi, " ")
		.replace(/\s+/g, " ")
		.trim();
	if (!candidate || candidate.length < 2) return "";
	if (
		/^(reservation|booking|confirmation|status|update|modified|cancellation|cancelled|heads?\s*up|hotel|guest)$/i.test(
			candidate
		)
	) {
		return "";
	}
	return candidate.slice(0, 40);
}

function resolveBookingSource({ provider = "", providerLabel = "", from = "", subject = "" } = {}) {
	if (provider && provider !== "unknown") {
		return PROVIDER_LABELS[provider] || providerLabel || provider;
	}
	const subjectCandidate = cleanBookingSourceCandidate(subject);
	if (subjectCandidate) return subjectCandidate;

	const fromText = normalizeWhitespace(from);
	const displayName = fromText.match(/^([^<@]+)\s*</)?.[1] || "";
	const displayCandidate = cleanBookingSourceCandidate(displayName);
	if (displayCandidate) return displayCandidate;

	const domain = fromText.match(/@([a-z0-9.-]+)/i)?.[1] || "";
	const domainRoot = domain
		.split(".")
		.filter((part) => !["com", "net", "org", "co", "sa", "mail"].includes(part))
		.shift();
	return cleanBookingSourceCandidate(domainRoot) || "OTA Email";
}

function hasStrongNewReservationSignal(value = "") {
	const subjectOnly = String(value || "").toLowerCase();
	if (/(cancelled|canceled|cancellation|cancelation|no[-\s]?show)/i.test(subjectOnly)) {
		return false;
	}
	if (/(modified|modification|changed|updated|amended|amendment)/i.test(subjectOnly)) {
		return false;
	}
	return /(new booking(?:\s+confirmed)?|new reservation|reservation confirmation|reservation confirmed|booking confirmation|confirmed reservation|booking confirmed|confirmed booking|booking\s+id\s+[a-z0-9-]{5,}\s+-\s+confirmed)/i.test(
		subjectOnly
	);
}

function hasActionableCancellationSignal(subject = "", text = "") {
	const subjectOnly = String(subject || "").toLowerCase();
	const body = String(text || "").toLowerCase();
	const isRequestOrPolicy =
		/\b(waiver|request|inquiry|question|message|refund|policy|fee)\b/i.test(
			subjectOnly
		);
	if (
		!isRequestOrPolicy &&
		/(?:\b(?:reservation|booking)\b[^\n]{0,50}\b(?:cancelled|canceled|cancellation|cancelation)\b)|(?:^|[-:])\s*(?:cancelled|canceled|cancellation|cancelation)\b/i.test(
			subjectOnly
		)
	) {
		return true;
	}
	if (isRequestOrPolicy) return false;
	if (
		/(?:reservation|booking)[^\n.]{0,90}(?:has been|was|is|status\s*[:#-]?)\s*(?:cancelled|canceled)|(?:cancelled|canceled)[^\n.]{0,40}(?:reservation|booking)|guest\s+(?:has\s+)?(?:cancelled|canceled)\s+(?:the|this|their)\s+(?:reservation|booking)/i.test(
			body
		)
	) {
		return true;
	}
	return false;
}

function detectEventType({ subject = "", text = "" } = {}) {
	const haystack = `${subject} ${text}`.toLowerCase();
	const subjectOnly = String(subject || "").toLowerCase();
	if (hasStrongNewReservationSignal(subjectOnly)) {
		return "new";
	}
	if (hasActionableCancellationSignal(subject, text)) return "cancelled";
	if (hasActionableNoShowSignal(subject, text)) return "no_show";
	if (/(modified|modification|changed|updated|amended|amendment)/i.test(haystack)) {
		return "modified";
	}
	if (
		/(reservation\s+status|booking\s+status|\bstatus\b)/i.test(subjectOnly) ||
		/(reservation\s+status|booking\s+status)/i.test(text)
	) {
		return "status";
	}
	if (/(new booking|new reservation|reservation confirmation|confirmed)/i.test(haystack)) {
		return "new";
	}
	return "unknown";
}

function hasActionableConfirmedStatusSignal(subject = "", text = "") {
	const subjectOnly = String(subject || "").trim().toLowerCase();
	const haystack = `${subject || ""}\n${text || ""}`.toLowerCase();
	if (/\b(question|policy|fee|request|inquiry|instructions?|how\s+to)\b/i.test(subjectOnly)) {
		return false;
	}
	if (hasStrongNewReservationSignal(subjectOnly)) return true;
	return (
		/^(?:(?:reservation|booking)\s+)?(?:status\s*[:#-]\s*)?(?:confirmed|active)\b/i.test(
			subjectOnly,
		) ||
		/\b(?:reservation|booking)\s+status\s*[:#-]\s*(?:confirmed|active)\b/i.test(
			haystack,
		) ||
		/(?:^|\n)\s*status\s*[:#-]\s*(?:confirmed|active)\b/i.test(haystack) ||
		/(?:^|\n)\s*(?:the\s+)?(?:reservation|booking)\b[^\n.]{0,80}\b(?:has\s+been|was|is|remains)\s+(?:confirmed|active)\b/i.test(
			haystack,
		) ||
		/\b(?:confirmed|active)\s+(?:reservation|booking)\b/i.test(
			subjectOnly,
		)
	);
}

function hasActionableNoShowSignal(subject = "", text = "") {
	const subjectOnly = String(subject || "").trim().toLowerCase();
	const haystack = `${subject || ""}\n${text || ""}`.toLowerCase();
	if (/\b(question|policy|fee|request|inquiry|waiver|instructions?|how\s+to)\b/i.test(subjectOnly)) {
		return false;
	}
	return (
		/^(?:(?:reservation|booking|guest)\s+)?(?:status\s*[:#-]\s*)?no[-\s]?show\b/i.test(
			subjectOnly,
		) ||
		/\b(?:reservation|booking)\s+status\s*[:#-]\s*no[-\s]?show\b/i.test(
			haystack,
		) ||
		/(?:^|\n)\s*status\s*[:#-]\s*no[-\s]?show\b/i.test(haystack) ||
		/(?:^|\n)\s*(?:the\s+)?(?:guest|reservation|booking)\s+(?:was\s+|is\s+|was\s+marked\s+)?(?:a\s+)?no[-\s]?show\b/i.test(
			haystack,
		) ||
		/(?:^|\n)\s*(?:the\s+)?guest\s+did\s+not\s+(?:arrive|show\s+up)\b/i.test(
			haystack,
		)
	);
}

function hasActionableOperationalStatusSignal(status, subject = "", text = "") {
	const subjectOnly = String(subject || "").trim().toLowerCase();
	const haystack = `${subject || ""}\n${text || ""}`.toLowerCase();
	if (/\b(question|policy|request|inquiry|instructions?|how\s+to)\b/i.test(subjectOnly)) {
		return false;
	}
	if (status === "checked_out") {
		return (
			/^(?:(?:reservation|booking|guest)\s+)?(?:status\s*[:#-]\s*)?checked\s*out\b/i.test(
				subjectOnly,
			) ||
			/\b(?:reservation|booking)\s+status\s*[:#-]\s*checked\s*out\b/i.test(
				haystack,
			) ||
			/(?:^|\n)\s*status\s*[:#-]\s*checked\s*out\b/i.test(haystack) ||
			/(?:^|\n)\s*(?:the\s+)?(?:guest|reservation|booking)\s+(?:has\s+been\s+|was\s+|is\s+)?checked\s*out\s*(?:[.!]|$)/i.test(
				haystack,
			)
		);
	}
	if (status === "inhouse") {
		return (
			/^(?:(?:reservation|booking|guest)\s+)?(?:status\s*[:#-]\s*)?(?:in[\s-]?house|checked\s*in|check[\s-]?in\s+completed)\b/i.test(
				subjectOnly,
			) ||
			/\b(?:reservation|booking)\s+status\s*[:#-]\s*(?:in[\s-]?house|checked\s*in)\b/i.test(
				haystack,
			) ||
			/(?:^|\n)\s*status\s*[:#-]\s*(?:in[\s-]?house|checked\s*in)\b/i.test(
				haystack,
			) ||
			/(?:^|\n)\s*(?:the\s+)?(?:guest|reservation|booking)\s+(?:has\s+been\s+|was\s+|is\s+)?checked\s*in\s*(?:[.!]|$)/i.test(
				haystack,
			)
		);
	}
	return false;
}

function detectStatusToApply({ subject = "", text = "" } = {}) {
	const subjectOnly = String(subject || "").toLowerCase();
	if (hasStrongNewReservationSignal(subjectOnly)) return "confirmed";
	if (hasActionableCancellationSignal(subject, text)) return "cancelled";
	if (hasActionableNoShowSignal(subject, text)) return "no_show";
	if (hasActionableOperationalStatusSignal("checked_out", subject, text)) {
		return "checked_out";
	}
	if (hasActionableOperationalStatusSignal("inhouse", subject, text)) {
		return "inhouse";
	}
	if (hasActionableConfirmedStatusSignal(subject, text)) return "confirmed";
	return "";
}

function detectReservationIntent({
	subject = "",
	text = "",
	eventType = "",
	reservationId = "",
	checkinDate = "",
	checkoutDate = "",
	hotelName = "",
} = {}) {
	const haystack = `${subject} ${text}`.toLowerCase();
	const hasReservationSignal =
		/(reservation|booking|confirmation|check[\s-]?in|check[\s-]?out|arrival|departure|guest|hotel|property|room|status)/i.test(
			haystack
		);
	if (!hasReservationSignal && !reservationId) return "not_reservation";
	if (["cancelled", "no_show", "status"].includes(eventType)) {
		return "reservation_status";
	}
	if (eventType === "modified") return "reservation_update";
	if (eventType === "new") return "new_reservation";
	if (reservationId && checkinDate && checkoutDate && hotelName) {
		return "new_reservation";
	}
	return "unknown";
}

function extractCardLast4(text) {
	const redactedCard = String(text || "").match(/\[CARD-(\d{4})\]/i);
	if (redactedCard) return redactedCard[1];
	const nearCard = findFirstPattern(text, [
		/\b(?:card number|card no\.?|pan)\s*[:#-]?\s*((?:\d[\s-]*){13,19})\b/i,
	]);
	const clean = String(nearCard || "").replace(/\D/g, "");
	if (clean.length >= 4) return clean.slice(-4);

	const generic = String(text || "").match(/\b(?:\d[ -]*?){15,19}\b/);
	if (!generic) return "";
	const digits = generic[0].replace(/\D/g, "");
	return digits.length >= 15 ? digits.slice(-4) : "";
}

function detectPaymentCollectionModel(paymentText = "", vcc = {}) {
	const haystack = String(paymentText || "").toLowerCase();
	const hasExpediaVirtualCard =
		/\bevc\b/i.test(haystack) &&
		/(\bexpedia\s*collect\b|\bevc\s+charge\s+status\b)/i.test(haystack);
	const hasVirtualCard =
		/(virtual\s+card|\bvcc\b|card\s+number|validation\s+code|hotel\s+charges?\s+(?:the\s+)?virtual\s+card|charges?\s+(?:a\s+)?virtual\s+card)/i.test(
			haystack
		) ||
		hasExpediaVirtualCard ||
		!!vcc.cardLast4;
	if (hasVirtualCard) return "virtual_card";
	if (
		/(hotel\s+collect|hotel\s+collects|pay\s+at\s+(?:the\s+)?property|pay\s+at\s+(?:the\s+)?hotel|pay\s+on\s+arrival|guest\s+pays|traveler\s+pays|collect\s+from\s+guest)/i.test(
			haystack
		)
	) {
		return "hotel_collect";
	}
	if (
		/(\bexpedia\s*collect\b|agoda\s+collect|booking\.com\s+collect|ota\s+collect|ota\s+collects|collected\s+by|platform\s+collect|prepaid|paid\s+online)/i.test(
			haystack
		)
	) {
		return "ota_collect";
	}
	return "unknown";
}

function emptyPaymentBreakdown(comment = "") {
	return {
		paid_online_via_link: 0,
		paid_at_hotel_cash: 0,
		paid_at_hotel_card: 0,
		paid_to_hotel: 0,
		paid_online_jannatbooking: 0,
		paid_online_other_platforms: 0,
		paid_online_via_instapay: 0,
		paid_no_show: 0,
		payment_comments: comment,
	};
}

function safeOtaPaymentSummary(summary = {}) {
	if (!summary || typeof summary !== "object") return {};
	const allowedFields = [
		"sourceCurrency",
		"sourceNightlyRateAmount",
		"sourceTaxesAmount",
		"sourceTotalGuestPaymentAmount",
		"sourceExpediaCompensationAmount",
		"sourceAcceleratorAmount",
		"sourceTotalPayoutAmount",
		"nightlyRateAmount",
		"taxesAmount",
		"totalGuestPaymentAmount",
		"expediaCompensationAmount",
		"acceleratorAmount",
		"totalPayoutAmount",
		"currency",
		"exchangeRateToSar",
		"exchangeRateSource",
		"amountConvertedAt",
	];
	return allowedFields.reduce((out, field) => {
		const value = summary[field];
		if (value === undefined || value === null || value === "") return out;
		if (typeof value === "number") out[field] = round2(value);
		else out[field] = value;
		return out;
	}, {});
}

function resolvePaymentMapping(normalized = {}, totalAmountSar = 0, subTotalSar = 0, commissionAmountSar = 0) {
	const providerLabel = normalized.providerLabel || "OTA";
	const collectionModel = normalized.paymentCollectionModel || "unknown";
	const total = round2(totalAmountSar);
	const subTotal = round2(subTotalSar || total);
	const commission = round2(commissionAmountSar);

	if (collectionModel === "virtual_card") {
		return {
			payment: "credit/ debit",
			financeStatus: "not paid",
			paidAmount: 0,
			paidAmountBreakdown: emptyPaymentBreakdown(
				`${providerLabel} virtual card pending capture`
			),
			financialCycle: {
				collectionModel: "pending",
				status: "open",
				commissionType: "amount",
				commissionValue: commission,
				commissionAmount: commission,
				commissionAssigned: false,
				pmsCollectedAmount: 0,
				hotelCollectedAmount: 0,
				hotelPayoutDue: 0,
				commissionDueToPms: 0,
				lastUpdatedAt: new Date(),
			},
		};
	}

	if (collectionModel === "ota_collect") {
		return {
			payment: "paid online",
			financeStatus: "paid online",
			paidAmount: total,
			paidAmountBreakdown: {
				...emptyPaymentBreakdown(`${providerLabel} collected by platform`),
				paid_online_other_platforms: total,
			},
			financialCycle: {
				collectionModel: "pms_collected",
				status: "open",
				commissionType: "amount",
				commissionValue: commission,
				commissionAmount: commission,
				commissionAssigned: false,
				pmsCollectedAmount: total,
				hotelCollectedAmount: 0,
				hotelPayoutDue: Math.max(subTotal, 0),
				commissionDueToPms: 0,
				lastUpdatedAt: new Date(),
			},
		};
	}

	return {
		payment: "not paid",
		financeStatus: "not paid",
		paidAmount: 0,
		paidAmountBreakdown: emptyPaymentBreakdown(
			collectionModel === "hotel_collect"
				? `${providerLabel} hotel collect / pay at property`
				: `${providerLabel} payment not captured`
		),
		financialCycle: {
			collectionModel: "pending",
			status: "open",
			commissionType: "amount",
			commissionValue: commission,
			commissionAmount: commission,
			commissionAssigned: false,
			pmsCollectedAmount: 0,
			hotelCollectedAmount: 0,
			hotelPayoutDue: 0,
			commissionDueToPms: 0,
			lastUpdatedAt: new Date(),
		},
	};
}

function normalizeConfirmation(value) {
	return normalizeWhitespace(value).toLowerCase();
}

function trimFlattenedFieldTail(value = "", stopLabels = []) {
	let cleaned = cleanFieldValue(value);
	for (const label of stopLabels) {
		const pattern = new RegExp(`\\s+${label}[\\s:?#-].*$`, "i");
		cleaned = cleaned.replace(pattern, "").trim();
	}
	return cleaned;
}

function extractHotelRunnerRoomBlocks(text = "") {
	const blocks = [];
	const pattern =
		/\bRoom\s+Type\s+([\s\S]{2,220}?)\s+Check-in\s+Date\s+([\s\S]{2,60}?)\s+Check-out\s+Date\s+([\s\S]{2,60}?)(?=\s+Guest\s+Count\b)([\s\S]{0,420}?)(?=\bRoom\s+Type\b|\bGo\s+to\s+reservation\b|\bThis\s+e-mail\b|$)/gi;
	for (const match of String(text || "").matchAll(pattern)) {
		const room = normalizeComparable(cleanFieldValue(match[1] || ""));
		const checkin = parseDate(match[2] || "") || normalizeComparable(match[2] || "");
		const checkout = parseDate(match[3] || "") || normalizeComparable(match[3] || "");
		const total = parseMoney(
			findFirstPattern(match[4] || "", [
				/\bTotal\s*[:#-]?\s*((?:[A-Z]{3}|US\$|\$|﷼)?\s*[0-9][0-9,.]*)/i,
			])
		).amount;
		if (room) blocks.push(`${room}|${checkin}|${checkout}|${total || 0}`);
	}
	return blocks;
}

function extractNormalizedReservation(email) {
	const text = normalizeWhitespace(
		`${email.subject || ""}\n${email.text || ""}\n${htmlToText(email.html || "")}`
	);
	const provider = detectProvider({
		from: email.from,
		to: email.to,
		subject: email.subject,
		text,
	});
	const airbnbFields = extractAirbnbFields(email, text, provider);
	const agodaFields = extractAgodaFields(email, text, provider);
	const tableStayDates = extractTableStayDates(text);
	const tableOccupancy = extractTableOccupancy(text);
	const isHotelRunnerSender = /@(?:[a-z0-9.-]+\.)?hotelrunner\.com\b/i.test(
		String(email.from || "")
	);
	const hotelRunnerRoomBlocks = isHotelRunnerSender
		? [
				extractHotelRunnerRoomBlocks(email.text || ""),
				extractHotelRunnerRoomBlocks(htmlToText(email.html || "")),
		  ].reduce(
				(longest, blocks) =>
					blocks.length > longest.length ? blocks : longest,
				[]
		  )
		: [];
	const providerLabel = PROVIDER_LABELS[provider] || provider;
	const eventType = detectEventType({ subject: email.subject, text });
	const rawStatusToApply = detectStatusToApply({ subject: email.subject, text });
	const statusToApply = ["cancelled", "no_show", "status"].includes(eventType)
		? rawStatusToApply
		: "";
	const warnings = [];
	const errors = [];
	const sourceField = findField(text, [
		"Booking source",
		"Reservation source",
		"Source",
		"Supplier",
		"Travel agency",
		"Agency",
	]);
	const bookingSource =
		sourceField ||
		resolveBookingSource({
			provider,
			providerLabel,
			from: email.from,
			subject: email.subject,
		});

	const reservationId = cleanConfirmationCandidate(
		firstNonEmpty(
			airbnbFields.confirmationNumber,
			agodaFields.confirmationNumber,
			findField(text, [
				"Reservation ID",
				"Reservation number",
				"Reservation No",
				"Reservation #",
				"Reservation code",
				"Confirmation number",
				"Confirmation #",
				"Confirmation code",
				"Booking ID",
				"Booking number",
				"Booking No",
				"Booking #",
				"Booking code",
				"Reference ID",
				"Reference number",
				"Reference No",
				"Reference #",
				"Reference code",
				"Ref ID",
				"Ref number",
				"Ref No",
				"Ref #",
				"Ref code",
				"Voucher number",
				"Voucher #",
				"Itinerary number",
				"Itinerary #",
				"Trip number",
				"Trip #",
			]),
			findFirstPattern(text, [
				/\bReservation\s*(?:ID|No\.?|Number|#)\s*[:#-]?\s*([A-Z0-9-]{5,})/i,
				/\bConfirmation\s*(?:Number|Code|#)?\s*[:#-]?\s*([A-Z0-9-]{5,})/i,
				/\bBooking\s*(?:ID|Number|#)\s*[:#-]?\s*([A-Z0-9-]{5,})/i,
				/\b(?:Reference|Ref)\s*(?:ID|No\.?|Number|Code|#)?\s*[:#-]?\s*([A-Z0-9-]{5,})/i,
				/\bVoucher\s*(?:ID|No\.?|Number|Code|#)?\s*[:#-]?\s*([A-Z0-9-]{5,})/i,
				/\bItinerary\s*(?:ID|No\.?|Number|Code|#)?\s*[:#-]?\s*([A-Z0-9-]{5,})/i,
				/\bTrip\s*(?:ID|No\.?|Number|Code|#)?\s*[:#-]?\s*([A-Z0-9-]{5,})/i,
			])
		)
	);

	const explicitHotelName = firstNonEmpty(
		explicitHotelAliasFromText(email.subject || ""),
		explicitHotelAliasFromText(text)
	);
	const hotelName = firstNonEmpty(
		airbnbFields.hotelName,
		agodaFields.hotelName,
		provider === "airbnb" ? explicitHotelName : "",
		provider === "airbnb" ? "" : extractProviderLogoHotelName(text, provider),
		provider === "airbnb" ? "" : findHotelNameField(text),
		provider === "airbnb" ? "" : explicitHotelName,
		provider === "airbnb" ? "" : findStandaloneHotelName(text)
	);
	const hotelId = airbnbFields.hotelId || agodaFields.hotelId || "";
	const genericRoomName = cleanFieldValue(findField(text, [
		"Room type name",
		"Room name",
		"Room type code/name",
		"Room type/name",
		"Room type",
		"Room",
		"Unit type",
	]));
	const roomName = trimFlattenedFieldTail(firstNonEmpty(
		airbnbFields.roomName,
		agodaFields.roomName,
		/^<?https?:\/\//i.test(genericRoomName) ? "" : genericRoomName
	), [
		"Check[-\\s]?in(?:\\s+date)?",
		"Check[-\\s]?out(?:\\s+date)?",
		"Guest\\s+count",
		"Daily\\s+average\\s+rate",
		"Total",
	]);
	const checkinDate = airbnbFields.checkinDate || agodaFields.checkinDate || tableStayDates.checkinDate || findDateValue(
		text,
		[
			"Check-in date",
			"Check in date",
			"Checkin date",
			"Check-in",
			"Check in",
			"Checkin",
			"Arrival",
			"Arrival date",
		],
		[
			/\bCheck[-\s]?In\s*[:#-]?\s*([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})/i,
			/\bCheckin(?:\s+date)?\s*[:#-]?\s*([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})/i,
			/\bArrival(?:\s+date)?\s*[:#-]?\s*([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})/i,
			/\bCheck[-\s]?In\s*[:#-]?\s*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/i,
		]
	);
	const checkoutDate = airbnbFields.checkoutDate || agodaFields.checkoutDate || tableStayDates.checkoutDate || findDateValue(
		text,
		[
			"Check-out date",
			"Check out date",
			"Checkout date",
			"Check-out",
			"Check out",
			"Checkout",
			"Departure",
			"Departure date",
		],
		[
			/\bCheck[-\s]?Out\s*[:#-]?\s*([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})/i,
			/\bCheckout(?:\s+date)?\s*[:#-]?\s*([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})/i,
			/\bDeparture(?:\s+date)?\s*[:#-]?\s*([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})/i,
			/\bCheck[-\s]?Out\s*[:#-]?\s*(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})/i,
		]
	);
	const bookedAtField = findField(text, [
		"Booked on",
		"Booking date",
		"Booked",
		"Created",
	]);
	const bookedAt = parseDate(bookedAtField) || dayjs().format("YYYY-MM-DD");

	const amountText = findField(text, [
		"Total booking amount",
		"Booking amount",
		"Total guest payment",
		"Reservation total",
		"Total amount",
		"Grand total",
		"Guest total",
		"Order total",
		"Amount paid",
	]);
	const explicitAggregateMoney = parseMoney(amountText);
	const hasExplicitAggregateMoney = explicitAggregateMoney.amount > 0;
	const parsedMoney = hasExplicitAggregateMoney
		? explicitAggregateMoney
		: agodaFields.amount
		? { amount: agodaFields.amount, currency: agodaFields.currency || "SAR" }
		: airbnbFields.amount
		? { amount: airbnbFields.amount, currency: airbnbFields.currency || "SAR" }
		: parseMoney(amountText);
	const amountCurrency =
		parsedMoney.currency ||
		(/\$\s*\d/.test(amountText) ? "USD" : process.env.OTA_DEFAULT_CURRENCY || "SAR");
	const conversion = hasExplicitAggregateMoney
		? getSarConversionMeta(parsedMoney.amount, amountCurrency)
		: agodaFields.amount
		? {
				totalAmountSar: agodaFields.totalAmountSar || 0,
				exchangeRateToSar: agodaFields.exchangeRateToSar || 0,
				exchangeRateSource: agodaFields.exchangeRateSource || "",
				convertedAt: agodaFields.amountConvertedAt || new Date().toISOString(),
		  }
		: airbnbFields.amount
		? {
				totalAmountSar: airbnbFields.totalAmountSar || 0,
				exchangeRateToSar: airbnbFields.exchangeRateToSar || 0,
				exchangeRateSource: airbnbFields.exchangeRateSource || "",
				convertedAt: airbnbFields.amountConvertedAt || new Date().toISOString(),
		  }
		: getSarConversionMeta(parsedMoney.amount, amountCurrency);
	const adultsField = findField(text, ["Adults", "Adult guests", "Adult"]);
	const childrenField = findField(text, [
		"Children",
		"Child guests",
		"Kids/Ages",
		"Kids Ages",
		"Kids",
		"Child",
	]);
	const totalGuestsField = findField(text, [
		"Total guests",
		"Guest count",
		"Guests",
	]);
	const roomCountField = findField(text, [
		"Room count",
		"Number of rooms",
		"No. of rooms",
		"No of rooms",
		"Rooms booked",
	]);
	const adults =
		airbnbFields.adults ||
		agodaFields.adults ||
		tableOccupancy.adults ||
		countNumber(adultsField);
	const children =
		airbnbFields.children ||
		agodaFields.children ||
		tableOccupancy.children ||
		countNumber(childrenField);
	const totalGuests =
		airbnbFields.totalGuests ||
		agodaFields.totalGuests ||
		countNumber(totalGuestsField) ||
		tableOccupancy.totalGuests ||
		adults + children ||
		1;
	const roomCount = airbnbFields.roomCount || agodaFields.roomCount || countNumber(roomCountField) || 1;
	const guestEmailField = findField(text, [
		"Guest email",
		"Email",
		"Guest e-mail",
	]);
	const guestEmailPattern = findFirstPattern(text, [
		/\b([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\b/i,
	]);
	const detectedGuestEmail = cleanEmailValue(firstNonEmpty(
		guestEmailField,
		guestEmailPattern
	));
	const detectedEmailIsAsset = /\.(?:png|jpe?g|gif|webp|svg|ico)$/i.test(
		detectedGuestEmail
	);
	const guestEmail =
		detectedEmailIsAsset
			? ""
			: provider === "airbnb" && /@(?:[\w.-]+\.)?airbnb\.com$/i.test(detectedGuestEmail)
			? ""
			: /^(?:no[-_.]?reply|noreply|do[-_.]?not[-_.]?reply)@/i.test(
					detectedGuestEmail
			  ) ||
			  /@(agoda|booking|expedia|hotels|hotelrunner|trip)\./i.test(
					detectedGuestEmail
			  )
			? ""
			: detectedGuestEmail;
	const guestNameField = findField(text, [
		"Guest name",
		"Primary guest",
		"Lead guest",
		"Customer name",
	]);
	const guestNamePattern = findFirstPattern(text, [
		/(?:^|\n)\s*Name\s*[:#-]\s*([^\n]{1,180})/i,
	]);
	const hotelRunnerInlineGuest = extractHotelRunnerInlineGuestFields(text);
	const guestName = trimFlattenedFieldTail(firstNonEmpty(
		airbnbFields.guestName,
		agodaFields.guestName,
		hotelRunnerInlineGuest.guestName,
		extractProviderGuestName(text),
		guestNameField,
		guestNamePattern
	), [
		"Country(?:\\s+of\\s+Residence)?",
		"Order\\s+Total",
		"Check[-\\s]?in",
		"Check[-\\s]?out",
		"Room\\s+Type",
		"Booked\\s+Date",
	]);
	const nationality = trimFlattenedFieldTail(firstNonEmpty(
		hotelRunnerInlineGuest.nationality,
		agodaFields.nationality,
		findField(text, [
			"Nationality",
			"Guest nationality",
			"Country",
			"Guest country",
			"Residence country",
		])
	), [
		"Order\\s+Total",
		"Check[-\\s]?in",
		"Check[-\\s]?out",
		"Room\\s+Type",
		"Booked\\s+Date",
	]);
	const guestNotes = firstNonEmpty(airbnbFields.guestNotes, findGuestNoteField(text));
	const guestPhone = firstNonEmpty(
		agodaFields.guestPhone,
		findField(text, [
			"Guest phone",
			"Phone",
			"Telephone",
			"Mobile",
		])
	);

	const paymentInstructionField = firstNonEmpty(
		airbnbFields.paymentInstructions,
		agodaFields.paymentInstructions,
		findField(text, [
			"Payment instructions",
			"Payment model",
			"Payment type",
			"Payment",
		])
	);
	const paymentText = `${paymentInstructionField} ${text}`.toLowerCase();
	const hasExplicitCardContext =
		/\b(virtual\s+card|\bvcc\b|card\s+number|validation\s+code|security\s+code|cvv|cvc|amount\s+to\s+charge|charge\s+amount)\b/i.test(
			text
		);

	const activationDateField = findField(text, [
		"Activation date",
		"Card activation date",
		"Card Effective Date",
	]);
	const expirationDateField = findField(text, [
		"Expiration date",
		"Expiry date",
		"Card expiration date",
	]);
	const explicitAmountToChargeField = findField(text, [
		"Amount to charge",
		"Charge amount",
		"VCC amount",
	]);
	const currentCardBalanceField = findField(text, ["Card Current Balance"]);
	const futureCardBalanceField = findField(text, ["Card Future Balance"]);
	const cardBalanceFields = [
		explicitAmountToChargeField,
		currentCardBalanceField,
		futureCardBalanceField,
	].filter(Boolean);
	const amountToChargeField =
		cardBalanceFields.find((value) => parseMoney(value).amount > 0) ||
		cardBalanceFields[0] ||
		"";
	const activationDate =
		provider === "airbnb" && !hasExplicitCardContext
			? null
			: parseDate(
					activationDateField.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0] ||
						activationDateField
			  );
	const expirationDate =
		provider === "airbnb" && !hasExplicitCardContext
			? null
			: parseCardExpirationDate(expirationDateField);
	const cardLast4 =
		provider === "airbnb" && !hasExplicitCardContext ? "" : extractCardLast4(text);
	const vccAmountDetails = resolveVccAmountDetails(
		amountToChargeField,
		amountCurrency
	);
	const paymentCollectionModel =
		airbnbFields.paymentCollectionModel &&
		airbnbFields.paymentCollectionModel !== "unknown"
			? airbnbFields.paymentCollectionModel
			: agodaFields.paymentCollectionModel &&
			  agodaFields.paymentCollectionModel !== "unknown"
			? agodaFields.paymentCollectionModel
			: detectPaymentCollectionModel(paymentText, {
					cardLast4,
			  });
	const paidOnline = paymentCollectionModel === "ota_collect";
	const vccPayoutSar =
		paymentCollectionModel === "virtual_card"
			? round2(vccAmountDetails.amountToChargeSar || 0)
			: 0;
	const providerTotalPayoutSar = round2(
		agodaFields.totalPayoutSar || airbnbFields.totalPayoutSar || vccPayoutSar || 0
	);
	const providerPaymentSummaryRaw = Object.keys(agodaFields.paymentSummary || {}).length
		? agodaFields.paymentSummary
		: airbnbFields.paymentSummary || {};
	const providerPaymentSummary = hasExplicitAggregateMoney
		? {
				...providerPaymentSummaryRaw,
				sourceCurrency: amountCurrency,
				sourceTotalGuestPaymentAmount: parsedMoney.amount || 0,
				totalGuestPaymentAmount: conversion.totalAmountSar || 0,
				currency: "SAR",
				exchangeRateToSar: conversion.exchangeRateToSar || 0,
				exchangeRateSource: conversion.exchangeRateSource || "",
				amountConvertedAt: conversion.convertedAt || "",
		  }
		: providerPaymentSummaryRaw;
	const basePaymentSummary = Object.keys(providerPaymentSummary).length
		? providerPaymentSummary
		: vccPayoutSar > 0
		? {
				sourceCurrency: vccAmountDetails.amountToChargeCurrency || amountCurrency,
				sourceTotalGuestPaymentAmount: parsedMoney.amount || 0,
				sourceTotalPayoutAmount: vccAmountDetails.amountToCharge || 0,
				totalGuestPaymentAmount: conversion.totalAmountSar || 0,
				totalPayoutAmount: vccPayoutSar,
				currency: "SAR",
				exchangeRateToSar: conversion.exchangeRateToSar || 0,
				exchangeRateSource: conversion.exchangeRateSource || "",
				amountConvertedAt: conversion.convertedAt || "",
		  }
		: {};
	const paymentSummary =
		paymentCollectionModel === "virtual_card"
			? {
					...basePaymentSummary,
					sourceTotalPayoutAmount:
						vccAmountDetails.amountToCharge ||
						basePaymentSummary.sourceTotalPayoutAmount ||
						0,
					totalPayoutAmount:
						vccPayoutSar || basePaymentSummary.totalPayoutAmount || 0,
					virtualCardCurrentBalance:
						parseMoney(currentCardBalanceField).amount || 0,
					virtualCardFutureBalance:
						parseMoney(futureCardBalanceField).amount || 0,
			  }
			: basePaymentSummary;

	const intent = detectReservationIntent({
		subject: email.subject,
		text,
		eventType,
		reservationId,
		checkinDate,
		checkoutDate,
		hotelName,
	});

	if (provider === "unknown") warnings.push("Could not detect OTA provider.");
	if (!reservationId) warnings.push("Missing reservation/confirmation id.");
	if (!checkinDate || !checkoutDate) warnings.push("Missing or invalid stay dates.");
	if (!hotelName && !hotelId) warnings.push("Missing hotel/property name.");
	if (!roomName) warnings.push("Missing room type/name.");

	return {
		provider,
		providerLabel,
		bookingSource,
		intent,
		eventType,
		statusToApply,
		reservationId: normalizeConfirmation(reservationId),
		confirmationNumber: normalizeConfirmation(reservationId),
		hotelId,
		hotelIdMatchStrength: airbnbFields.hotelIdMatchStrength || "",
		hotelIdMatchedBy: airbnbFields.hotelIdMatchedBy || "",
		hotelIdMatchedValue: airbnbFields.hotelIdMatchedValue || "",
		hotelName,
		hotelNameAliases: Array.from(
			new Set([
				...(airbnbFields.hotelNameAliases || []),
				...(agodaFields.hotelNameAliases || []),
			].filter(Boolean))
		),
		airbnbListingId: airbnbFields.airbnbListingId || "",
		airbnbListingTitle: airbnbFields.airbnbListingTitle || "",
		airbnbMapping: airbnbFields.airbnbMapping || {},
		roomName,
		checkinDate,
		checkoutDate,
		bookedAt,
		amount: parsedMoney.amount,
		currency: amountCurrency,
		totalAmountSar: conversion.totalAmountSar,
		sourceAmount:
			hasExplicitAggregateMoney
				? parsedMoney.amount
				: agodaFields.sourceAmount || airbnbFields.sourceAmount || 0,
		sourceCurrency:
			hasExplicitAggregateMoney
				? amountCurrency
				: agodaFields.sourceCurrency || airbnbFields.sourceCurrency || "",
		exchangeRateToSar: conversion.exchangeRateToSar,
		exchangeRateSource: conversion.exchangeRateSource,
		amountConvertedAt: conversion.convertedAt,
		totalPayoutSar: providerTotalPayoutSar,
		netAfterExpensesTotal: round2(
			agodaFields.netAfterExpensesTotal ||
				airbnbFields.netAfterExpensesTotal ||
				vccPayoutSar ||
				0
		),
		paymentSummary,
		adults,
		children,
		totalGuests,
		roomCount,
		guestName,
		guestEmail,
		guestPhone,
		nationality,
		comment: guestNotes,
		guestNotes,
		paidOnline,
		paymentCollectionModel,
		paymentInstructions: safeSnippet(
			paymentInstructionField || paymentCollectionModel,
			500
		),
		requiresManualReview:
			hotelRunnerRoomBlocks.length > 1 ||
			Number(agodaFields.referenceSellRateOccurrences || 0) > 1 ||
			agodaFields.multiRoomEvidence === true,
		manualReviewReasons:
			[
				...(hotelRunnerRoomBlocks.length > 1
					? [
						`HotelRunner email contains ${hotelRunnerRoomBlocks.length} room blocks in one message representation; automatic partial-room creation is disabled.`,
					  ]
					: []),
				...(Number(agodaFields.referenceSellRateOccurrences || 0) > 1
					? [
							"Agoda email contains multiple reference sell-rate rows; automatic aggregation is disabled and the booking requires pricing review.",
					  ]
					: []),
				...(agodaFields.multiRoomEvidence === true
					? [
							"Agoda email contains multiple rooms; automatic partial-room creation is disabled and the booking requires room review.",
					  ]
					: []),
			],
		sourcePresence: {
			reservationId: !!reservationId,
			confirmationNumber: !!reservationId,
			bookingSource: !!sourceField,
			hotelName: !!hotelName || !!hotelId,
			airbnbListingId: !!airbnbFields.airbnbListingId,
			airbnbListingTitle: !!airbnbFields.airbnbListingTitle,
			roomName: !!roomName,
			checkinDate: !!checkinDate || !!tableStayDates.checkinDate,
			checkoutDate: !!checkoutDate || !!tableStayDates.checkoutDate,
			bookedAt: !!parseDate(bookedAtField),
			amount:
				(!!amountText || !!airbnbFields.amount || !!agodaFields.amount) &&
				Number(parsedMoney.amount || 0) > 0,
			adults: !!adultsField || !!agodaFields.sourcePresence?.adults || tableOccupancy.adults > 0,
			children:
				!!childrenField ||
				!!agodaFields.sourcePresence?.children ||
				tableOccupancy.children > 0,
			totalGuests:
				!!totalGuestsField ||
				!!agodaFields.sourcePresence?.totalGuests ||
				tableOccupancy.totalGuests > 0,
			roomCount: !!roomCountField || !!agodaFields.sourcePresence?.roomCount,
			guestName: !!guestName,
			guestEmail: !!guestEmail,
			guestPhone: !!guestPhone,
			nationality: !!nationality,
			comment: !!guestNotes,
			guestNotes: !!guestNotes,
			paymentInstructions: !!paymentInstructionField || !!agodaFields.paymentInstructions,
			paymentCollectionModel: paymentCollectionModel !== "unknown",
			vccCardLast4: !!cardLast4,
			vccAmountToCharge: !!amountToChargeField && /\d/.test(amountToChargeField),
			vccAmountToChargeUsd:
				!!amountToChargeField &&
				/\d/.test(amountToChargeField) &&
				hasOtaValue(vccAmountDetails.amountToChargeUsd, { allowZero: true }),
			vccAmountToChargeSar:
				!!amountToChargeField &&
				/\d/.test(amountToChargeField) &&
				hasOtaValue(vccAmountDetails.amountToChargeSar, { allowZero: true }),
			vccActivationDate: !!activationDate,
			vccExpirationDate: !!expirationDate,
		},
		vcc: {
			cardLast4,
			...vccAmountDetails,
			activationDate,
			expirationDate,
		},
		source: {
			from: email.from || "",
			to: email.to || "",
			subject: email.subject || "",
			messageId: email.messageId || "",
			textHash: hashText(text),
			safeSnippet: safeSnippet(text),
		},
		warnings,
		errors,
	};
}

function mapArabicRoomType(roomNameRaw) {
	const s = normalizeIntlComparable(roomNameRaw);
	if (!s) return null;
	if (!/[\u0600-\u06FF]/.test(String(roomNameRaw || ""))) return null;
	if (/(مشترك|مشتركة|سرير|اسرة مشتركة|أسرّة مشتركة)/.test(s)) {
		return "individualBed";
	}
	if (/(جناح بثلاث|ثلاث غرف|3 غرف)/.test(s)) return "masterSuite";
	if (/(جناح بغرفتين|غرفتين|2 غرف)/.test(s)) return "suite";
	if (/(استوديو|studio)/.test(s)) return "studioRooms";
	if (/(فردية|فردي|شخص واحد|\b1\b)/.test(s)) return "singleRooms";
	if (/(ثنائية|ثنائي|زوجية|زوجي|دبل|شخصين|فردين|\b2\b)/.test(s)) {
		return "doubleRooms";
	}
	if (/(ثلاثية|ثلاثي|ثلاث|3 افراد|\b3\b)/.test(s)) return "tripleRooms";
	if (/(رباعية|رباعي|اربع|أربع|4 افراد|\b4\b)/.test(s)) return "quadRooms";
	if (/(خماسية|خماسي|خمسة|5 افراد|\b5\b)/.test(s)) return "familyRooms";
	if (/(سداسية|سداسي|ستة|6 افراد|\b6\b|سباعية|سباعي|سبعة|7 افراد|\b7\b|عائلية|عائلي)/.test(
		s
	)) {
		return "familyRooms";
	}
	return null;
}

function mapRoomType(roomNameRaw) {
	if (!roomNameRaw) return null;
	const arabicMapped = mapArabicRoomType(roomNameRaw);
	if (arabicMapped) return arabicMapped;
	const s = normalizeComparable(roomNameRaw);
	const hasKeyword = (keyword) =>
		s.split(" ").some(
			(word) =>
				word === keyword ||
				(!/^\d+$/.test(keyword) &&
					(word.includes(keyword) ||
						(word.length >= 4 && keyword.includes(word)) ||
						bigramSimilarity(word, keyword) >= 0.6))
		);
	const explicitBedCapacity = Number(
		s.match(/\b([1-9])\s+(?:beds?|persons?|guests?)\b/i)?.[1] || 0
	);
	if (hasKeyword("master") && hasKeyword("suite")) return "masterSuite";
	if (explicitBedCapacity === 1) return "singleRooms";
	if (explicitBedCapacity === 2) return "doubleRooms";
	if (explicitBedCapacity === 3) return "tripleRooms";
	if (explicitBedCapacity === 4) return "quadRooms";
	if (explicitBedCapacity >= 5) return "familyRooms";
	if (hasKeyword("quadruple") || hasKeyword("quad")) return "quadRooms";
	if (hasKeyword("quintuple") || hasKeyword("five") || hasKeyword("5")) return "familyRooms";
	if (hasKeyword("triple")) return "tripleRooms";
	if (hasKeyword("twin")) return "twinRooms";
	if (hasKeyword("double")) return "doubleRooms";
	if (hasKeyword("single")) return "singleRooms";
	if (hasKeyword("king")) return "kingRooms";
	if (hasKeyword("queen")) return "queenRooms";
	if (hasKeyword("family")) return "familyRooms";
	if (hasKeyword("studio")) return "studioRooms";
	if (hasKeyword("suite")) return "suite";
	if (hasKeyword("standard")) return "standardRooms";
	if (hasKeyword("shared") || hasKeyword("individual")) return "individualBed";
	return null;
}

function explicitRoomCapacity(value = "") {
	const s = normalizeIntlComparable(value);
	if (!s) return 0;
	const numeric = s.match(
		/(?:^|\s)([1-9]\d?)\s*(?:beds?|persons?|people|guests?|occupancy|افراد|أفراد|اشخاص|أشخاص|اسرة|أسرة)(?=$|\s)/i
	);
	if (numeric) return Number(numeric[1]);
	const capacityPatterns = [
		[1, /\b(single|one[ -]?bed)\b|فردي|فردية|شخص واحد/i],
		[2, /\b(double|twin|two[ -]?bed)\b|ثنائي|ثنائية|شخصين|فردين/i],
		[3, /\b(triple|three[ -]?bed)\b|ثلاثي|ثلاثية|ثلاثة افراد/i],
		[4, /\b(quad(?:ruple)?|four[ -]?bed)\b|رباعي|رباعية|اربعة افراد|أربعة أفراد/i],
		[5, /\b(quint(?:uple)?|five[ -]?bed)\b|خماسي|خماسية|خمسة افراد|خمسة أفراد/i],
		[6, /\b(sextuple|six[ -]?bed)\b|سداسي|سداسية|ستة افراد|ستة أفراد/i],
		[7, /\b(septuple|seven[ -]?bed)\b|سباعي|سباعية|سبعة افراد|سبعة أفراد/i],
	];
	return capacityPatterns.find(([, pattern]) => pattern.test(s))?.[0] || 0;
}

function scoreRoomCandidate(room = {}, roomName = "", mappedRoomType = null) {
	const activePenalty = room.activeRoom === false ? 0.08 : 0;
	const labels = [
		room.displayName,
		room.displayName_OtherLanguage,
		roomTypeLabel(room.roomType),
		room.roomType,
	]
		.filter(Boolean)
		.map(String);

	const displayScore = labels.reduce((best, label) => {
		const labelVariants = roomComparableVariants(label);
		const roomVariants = roomComparableVariants(roomName);
		let score = 0;
		for (const left of roomVariants) {
			for (const right of labelVariants) {
				score = Math.max(score, tokenSimilarity(left, right));
			}
		}
		return Math.max(best, score);
	}, 0);
	const typeMatches = !!mappedRoomType && roomTypeMatches(room.roomType, mappedRoomType);
	const typeScore = typeMatches ? 0.76 : 0;
	const boostedTypeScore = typeMatches
		? Math.min(0.96, 0.76 + Math.min(displayScore, 0.7) * 0.22)
		: 0;
	const exactDisplay = labels.some(
		(label) => normalizeComparable(label) === normalizeComparable(roomName)
	);
	const score = Math.max(
		exactDisplay ? 1 : 0,
		displayScore,
		typeScore,
		boostedTypeScore
	);

	return {
		score: Math.max(0, round2(score - activePenalty)),
		displayScore: round2(displayScore),
		typeMatches,
		matchType: exactDisplay
			? "exact_display"
			: displayScore >= 0.75
			? "fuzzy_display"
			: typeMatches && displayScore >= 0.35
			? "room_type_display_fuzzy"
			: typeMatches
			? "room_type"
			: "fuzzy",
	};
}

function roomCapacityFromLabels(room = {}) {
	const rawLabel =
		[
			room.displayName,
			room.displayName_OtherLanguage,
			roomTypeLabel(room.roomType),
			room.roomType,
		]
			.filter(Boolean)
			.join(" ");
	const explicitCapacity = explicitRoomCapacity(rawLabel);
	if (explicitCapacity) return explicitCapacity;
	const label = normalizeComparable(rawLabel);
	if (/\b(single|individual)\b/.test(label)) return 1;
	if (/\b(double|twin|king|queen)\b/.test(label)) return 2;
	if (/\btriple\b/.test(label)) return 3;
	if (/\bquad(?:ruple)?\b/.test(label)) return 4;
	if (/\bquint(?:uple)?\b|\bfive\b|\b5\b/.test(label)) return 5;
	return 0;
}

function resolveRoomByOccupancy(rooms = [], totalGuests = 0) {
	const guests = Number(totalGuests || 0);
	if (!Number.isFinite(guests) || guests <= 0) return null;
	const candidates = rooms
		.map((room, index) => ({
			room,
			index,
			capacity: roomCapacityFromLabels(room),
		}))
		.filter((candidate) => candidate.capacity >= guests)
		.sort((left, right) => {
			if (left.capacity !== right.capacity) return left.capacity - right.capacity;
			if (left.room.activeRoom !== false && right.room.activeRoom === false) {
				return -1;
			}
			if (left.room.activeRoom === false && right.room.activeRoom !== false) {
				return 1;
			}
			return left.index - right.index;
		});
	return candidates[0] || null;
}

const SEMANTIC_OTA_ROOM_TYPES = new Set([
	"singleRooms",
	"doubleRooms",
	"twinRooms",
	"tripleRooms",
	"quadRooms",
	"familyRooms",
	"kingRooms",
	"queenRooms",
	"studioRooms",
	"suite",
	"masterSuite",
	"standardRooms",
	"individualBed",
]);

function buildSemanticOtaRoomFallback(normalized = {}, mappedRoomType = "") {
	if (normalized.source?.from !== "expedia-sync") return null;
	if (!mappedRoomType || !SEMANTIC_OTA_ROOM_TYPES.has(mappedRoomType)) return null;
	const roomName = normalizeWhitespace(normalized.roomName || "");
	if (!roomName) return null;
	return {
		roomDetails: {
			roomType: mappedRoomType,
			displayName: roomName,
			displayName_OtherLanguage: "",
			activeRoom: true,
			price: {},
			pricingRate: [],
		},
		score: 0.74,
		displayScore: 0,
		matchType: "semantic_ota_room_type_fallback",
		threshold: 0.75,
		mappedRoomType,
		warnings: [
			`Room "${roomName}" was saved as OTA semantic room type "${mappedRoomType}" because this hotel has no confident PMS room mapping; review before release.`,
		],
	};
}

function resolveRoomMatch(hotelDetails, roomName, options = {}) {
	const rooms = (hotelDetails?.roomCountDetails || []).filter(
		(room) => room && room.roomType && room.activeRoom !== false
	);
	const mappedRoomType = mapRoomType(roomName);
	const sourceCapacity = explicitRoomCapacity(roomName);
	if (!rooms.length || !normalizeWhitespace(roomName)) {
		return {
			roomDetails: null,
			score: 0,
			warnings: ["Room type/name is missing or this hotel has no room details."],
		};
	}

	const capacityMatchedRooms = sourceCapacity
		? rooms.filter((room) => roomCapacityFromLabels(room) === sourceCapacity)
		: rooms;
	if (sourceCapacity && !capacityMatchedRooms.length) {
		return {
			roomDetails: null,
			score: 0,
			mappedRoomType,
			sourceCapacity,
			warnings: [
				`Room "${roomName}" requires capacity ${sourceCapacity}, but no active PMS room has that configured capacity.`,
			],
		};
	}

	if (sourceCapacity && capacityMatchedRooms.length === 1) {
		return {
			roomDetails: capacityMatchedRooms[0],
			score: 0.98,
			displayScore: scoreRoomCandidate(
				capacityMatchedRooms[0],
				roomName,
				mappedRoomType
			).displayScore,
			matchType: "explicit_capacity",
			threshold: 0.75,
			mappedRoomType,
			sourceCapacity,
			warnings: [],
		};
	}

	const candidates = capacityMatchedRooms
		.map((room, index) => ({
			room,
			index,
			...scoreRoomCandidate(room, roomName, mappedRoomType),
		}))
		.filter((candidate) => candidate.score >= 0.75)
		.sort((left, right) => {
			if (right.score !== left.score) return right.score - left.score;
			if (right.displayScore !== left.displayScore) {
				return right.displayScore - left.displayScore;
			}
			if (left.room.activeRoom !== false && right.room.activeRoom === false) {
				return -1;
			}
			if (left.room.activeRoom === false && right.room.activeRoom !== false) {
				return 1;
			}
			return left.index - right.index;
		});

	if (!candidates.length) {
		const semanticFallback = buildSemanticOtaRoomFallback(
			options.normalized,
			mappedRoomType
		);
		if (semanticFallback) return semanticFallback;
		return {
			roomDetails: null,
			score: 0,
			warnings: [
				`No hotel room matched "${roomName}" at the required 75% confidence.`,
			],
		};
	}

	const [best, second] = candidates;
	const warnings = [];
	if (
		second &&
		Math.abs(best.score - second.score) <= 0.05
	) {
		return {
			roomDetails: null,
			score: best.score,
			displayScore: best.displayScore,
			matchType: "ambiguous",
			threshold: 0.75,
			mappedRoomType,
			sourceCapacity,
			warnings: [
				`Multiple active PMS rooms are equally plausible for "${roomName}"; manual room mapping is required.`,
			],
		};
	}
	if (
		best.matchType === "room_type" ||
		(best.matchType !== "exact_display" && best.displayScore < 0.62)
	) {
		return {
			roomDetails: null,
			score: best.score,
			displayScore: best.displayScore,
			matchType: "insufficient_display_evidence",
			threshold: 0.75,
			mappedRoomType,
			sourceCapacity,
			warnings: [
				`Room "${roomName}" only matched a broad PMS room category; manual room mapping is required.`,
			],
		};
	}

	return {
		roomDetails: best.room,
		score: best.score,
		displayScore: best.displayScore,
		matchType: best.matchType,
		threshold: 0.75,
		mappedRoomType,
		sourceCapacity,
		warnings,
	};
}

function resolveRoomDetails(hotelDetails, roomName) {
	return resolveRoomMatch(hotelDetails, roomName).roomDetails;
}

async function resolveRoomMatchWithAi(hotelDetails, normalized = {}) {
	const deterministicMatch = resolveRoomMatch(
		hotelDetails,
		normalized.roomName,
		{
			totalGuests: normalized.totalGuests,
			normalized,
		}
	);
	const rooms = Array.isArray(hotelDetails?.roomCountDetails)
		? hotelDetails.roomCountDetails
		: [];
	const candidateCapacities = Object.fromEntries(
		rooms
			.filter((room) => room?._id)
			.map((room) => [String(room._id), roomCapacityFromLabels(room)])
	);
	const aiMatch = await matchOtaRoomWithOpenAi({
		hotelDetails,
		normalized,
		deterministicMatch,
		sourceCapacity: explicitRoomCapacity(normalized.roomName),
		candidateCapacities,
	});
	if (!aiMatch.usedAI) {
		if (["exact_display", "explicit_capacity"].includes(deterministicMatch.matchType)) {
			return deterministicMatch;
		}
		return {
			...deterministicMatch,
			roomDetails: null,
			matchType: "ai_room_match_unavailable",
			aiRoomMatch: aiMatch,
			warnings: [
				"OpenAI room matching was unavailable, so no non-exact PMS room was selected.",
			],
		};
	}
	if (!aiMatch.matched) {
		return {
			...deterministicMatch,
			roomDetails: null,
			matchType: "ai_no_confident_match",
			aiRoomMatch: aiMatch,
			warnings: [
				`OpenAI could not confidently map OTA room "${normalized.roomName || "unknown"}" to one configured PMS room for the resolved hotel.`,
			],
		};
	}
	const roomDetails = rooms.find(
		(room) => String(room?._id || "") === aiMatch.selectedRoomId
	);
	if (!roomDetails) {
		return {
			...deterministicMatch,
			roomDetails: null,
			matchType: "ai_invalid_room_selection",
			aiRoomMatch: aiMatch,
			warnings: ["OpenAI returned a PMS room that is no longer configured."],
		};
	}
	return {
		roomDetails,
		score: aiMatch.confidence,
		displayScore: deterministicMatch.displayScore || 0,
		matchType: "ai_pms_room_match",
		threshold: aiMatch.threshold,
		mappedRoomType: mapRoomType(normalized.roomName),
		sourceCapacity: explicitRoomCapacity(normalized.roomName),
		aiRoomMatch: aiMatch,
		warnings: [],
	};
}

function resolveRootPriceForDate(roomDetails, ymd) {
	const pricingRate = (roomDetails.pricingRate || []).find(
		(rate) => dayjs(rate.calendarDate).format("YYYY-MM-DD") === ymd
	);
	if (pricingRate) {
		const calendarRoot = n(pricingRate.rootPrice);
		if (calendarRoot >= MIN_REAL_CALENDAR_ROOT_PRICE) return calendarRoot;
		const calendarPrice = n(pricingRate.price);
		if (calendarPrice > 0) return calendarPrice;
	}
	if (roomDetails.defaultCost) return n(roomDetails.defaultCost);
	if (roomDetails.price?.basePrice) return n(roomDetails.price.basePrice);
	return 0;
}

function buildPickedRoomsType({ roomDetails, normalized, roomMatch = {} }) {
	const dateRange = generateDateRange(normalized.checkinDate, normalized.checkoutDate);
	const daysOfResidence = dateRange.length;
	if (daysOfResidence <= 0) {
		return {
			ok: false,
			error: "Stay dates do not produce a positive number of nights.",
		};
	}

	const roomCount = Math.max(1, Math.floor(Number(normalized.roomCount || 1)));
	const totalAmountSar = round2(normalized.totalAmountSar || 0);
	const slotPrices = allocateAmountAcrossSlots(
		totalAmountSar,
		daysOfResidence * roomCount
	);
	const paymentSummary = normalized.paymentSummary || {};
	const totalPayoutSar = round2(
		normalized.totalPayoutSar ||
			normalized.netAfterExpensesTotal ||
			paymentSummary.totalPayoutAmount ||
			0
	);
	const hasExplicitPayoutTotal = totalPayoutSar > 0;
	const defaultDeductionRate = resolveOtaReviewDeductionRate(normalized);
	const fallbackNetTotalSar = defaultOtaReviewNetTotal(
		totalAmountSar,
		defaultDeductionRate
	);
	const effectiveNetAfterExpensesTotal = hasExplicitPayoutTotal
		? round2(Math.min(totalPayoutSar, totalAmountSar || totalPayoutSar))
		: fallbackNetTotalSar;
	const netAfterExpensesSlots = allocateAmountAcrossSlots(
		effectiveNetAfterExpensesTotal > 0
			? effectiveNetAfterExpensesTotal
			: totalAmountSar,
		daysOfResidence * roomCount
	);
	const fallbackRootSlots = allocateAmountAcrossSlots(
		fallbackNetTotalSar || totalAmountSar,
		daysOfResidence * roomCount
	);
	let slotIndex = 0;
	let sumRootPriceAllRooms = 0;
	let sumTotalPriceAllRooms = 0;
	let sumNetAfterExpensesAllRooms = 0;
	let sumOtaExpenseAllRooms = 0;
	let sumPlatformMarginAllRooms = 0;

	const pickedRoomsType = Array.from({ length: roomCount }, () => {
		const pricingByDay = dateRange.map((ymd) => {
			const currentSlot = slotIndex;
			const finalPrice = round2(slotPrices[currentSlot] || 0);
			const netAfterExpenses = round2(
				netAfterExpensesSlots[currentSlot] || finalPrice
			);
			slotIndex += 1;
			const configuredRootPrice = round2(resolveRootPriceForDate(roomDetails, ymd));
			const fallbackRootPrice = round2(
				fallbackRootSlots[currentSlot] || netAfterExpenses || finalPrice
			);
			const rootPrice =
				configuredRootPrice > 0 ? configuredRootPrice : fallbackRootPrice;
			const commissionRate =
				rootPrice > 0 ? round2(defaultDeductionRate * 100) : 0;
			const otaExpenseAmount = Math.max(0, round2(finalPrice - netAfterExpenses));
			const platformMargin = round2(netAfterExpenses - rootPrice);

			sumRootPriceAllRooms = round2(sumRootPriceAllRooms + rootPrice);
			sumTotalPriceAllRooms = round2(sumTotalPriceAllRooms + finalPrice);
			sumNetAfterExpensesAllRooms = round2(
				sumNetAfterExpensesAllRooms + netAfterExpenses
			);
			sumOtaExpenseAllRooms = round2(sumOtaExpenseAllRooms + otaExpenseAmount);
			sumPlatformMarginAllRooms = round2(
				sumPlatformMarginAllRooms + platformMargin
			);

			return {
				date: ymd,
				price: finalPrice,
				clientPrice: finalPrice,
				mainPrice: finalPrice,
				rootPrice,
				commissionRate,
				totalPriceWithCommission: finalPrice,
				totalPriceWithoutCommission: rootPrice,
				netAfterExpenses,
				netAfterOtaExpenses: netAfterExpenses,
				otaExpenseAmount,
				platformMargin,
			};
		});
		const roomTotal = round2(
			pricingByDay.reduce(
				(total, day) => total + Number(day.totalPriceWithCommission || 0),
				0
			)
		);
		const roomRoot = round2(
			pricingByDay.reduce(
				(total, day) => total + Number(day.rootPrice || 0),
				0
			)
		);

		return {
			room_type: roomDetails.roomType,
			displayName: roomDetails.displayName,
			hotelRoomConfigId: roomDetails._id || null,
			sourceRoomName: normalized.roomName || "",
			otaRoomMatchType: roomMatch.matchType || "",
			otaRoomMatchScore: Number(roomMatch.score || 0),
			chosenPrice: round2(roomTotal / daysOfResidence),
			count: 1,
			pricingByDay,
			totalPriceWithCommission: roomTotal,
			hotelShouldGet: roomRoot,
		};
	});

	const subTotalSar = round2(sumRootPriceAllRooms);
	const commissionAmountSar = defaultOtaReviewDeductionAmount(
		subTotalSar,
		defaultDeductionRate
	);

	return {
		ok: true,
		pickedRoomsType,
		roomCount,
		daysOfResidence,
		sumRootPriceAllRooms: round2(sumRootPriceAllRooms),
		subTotalSar,
		sumTotalPriceAllRooms: round2(sumTotalPriceAllRooms),
		netAfterExpensesTotal: round2(sumNetAfterExpensesAllRooms),
		otaExpenseTotal: round2(sumOtaExpenseAllRooms),
		platformMarginTotal: round2(sumPlatformMarginAllRooms),
		commissionAmountSar,
		adminPricingTotals: {
			mode: "ota_platform_sync",
			clientTotal: round2(sumTotalPriceAllRooms),
			rootTotal: subTotalSar,
			netAfterExpensesTotal: round2(sumNetAfterExpensesAllRooms),
			otaExpenseTotal: round2(sumOtaExpenseAllRooms),
			platformMarginTotal: round2(sumPlatformMarginAllRooms),
			commissionAmount: commissionAmountSar,
			defaultDeductionRate,
			defaultDeductionApplied: !hasExplicitPayoutTotal,
		},
	};
}

function buildReservationDocument(normalized, hotelDetails, options = {}) {
	if (!hotelDetails) return { ok: false, error: "Hotel could not be resolved." };
	const roomMatch =
		options.roomMatch ||
		resolveRoomMatch(hotelDetails, normalized.roomName, {
			totalGuests: normalized.totalGuests,
			normalized,
		});
	const roomDetails = roomMatch.roomDetails;
	if (!roomDetails) {
		return {
			ok: false,
			error:
				roomMatch.warnings?.[0] ||
				`Room could not be resolved for "${normalized.roomName || "unknown"}".`,
		};
	}
	if (Array.isArray(roomMatch.warnings) && roomMatch.warnings.length) {
		normalized.warnings = Array.from(
			new Set([...(normalized.warnings || []), ...roomMatch.warnings])
		);
	}

	const pricing = buildPickedRoomsType({ roomDetails, normalized, roomMatch });
	if (!pricing.ok) return pricing;

	const isCancelled = normalized.eventType === "cancelled";
	const totalAmountSar = Number(normalized.totalAmountSar || 0);
	const providerLabel =
		normalized.bookingSource ||
		(normalized.providerLabel && normalized.providerLabel !== "unknown"
			? normalized.providerLabel
			: "OTA Email");
	const paymentMapping = resolvePaymentMapping(
		normalized,
		totalAmountSar,
		pricing.subTotalSar,
		pricing.commissionAmountSar
	);
	const requiresPlatformReview = !isCancelled;
	const automationSource =
		normalized.source?.from === "expedia-sync" ? "ota_sync_create" : "ota_email_create";
	const automationPipeline =
		normalized.source?.from === "expedia-sync"
			? "ota-reservation-sync-orchestrator"
			: "ota-email-orchestrator";
	const safePaymentSummary = safeOtaPaymentSummary(normalized.paymentSummary);
	const sourceCurrency =
		normalized.sourceCurrency ||
		safePaymentSummary.sourceCurrency ||
		normalized.currency ||
		"";
	const sourceAmount = Number(
		normalized.sourceAmount ||
			safePaymentSummary.sourceTotalGuestPaymentAmount ||
			normalized.amount ||
			0
	);
	const sourceExchangeRateToSar = Number(
		normalized.sourceExchangeRateToSar ||
			safePaymentSummary.exchangeRateToSar ||
			(String(sourceCurrency || "").toUpperCase() === "SAR"
				? normalized.exchangeRateToSar || 1
				: 0)
	);
	const sourceExchangeRateSource =
		normalized.sourceExchangeRateSource ||
		safePaymentSummary.exchangeRateSource ||
		normalized.exchangeRateSource ||
		"";
	const defaultDeductionRate = resolveOtaReviewDeductionRate(normalized);
	const fallbackNetAfterExpensesTotal = defaultOtaReviewNetTotal(
		totalAmountSar,
		defaultDeductionRate
	);
	const adminPricingTotals = pricing.adminPricingTotals || {
		mode: "ota_platform_sync",
		clientTotal: totalAmountSar,
		rootTotal: pricing.subTotalSar,
		netAfterExpensesTotal: fallbackNetAfterExpensesTotal,
		otaExpenseTotal: round2(totalAmountSar - fallbackNetAfterExpensesTotal),
		platformMarginTotal: Math.max(
			0,
			round2(fallbackNetAfterExpensesTotal - pricing.subTotalSar)
		),
		commissionAmount: pricing.commissionAmountSar,
		defaultDeductionRate,
		defaultDeductionApplied: true,
	};
	const guestComment = cleanOtaGuestNote(
		normalized.comment || normalized.guestNotes || ""
	);

	return {
		ok: true,
		warnings: normalized.warnings || [],
		document: {
			reservation_id: normalized.reservationId,
			confirmation_number: normalized.confirmationNumber,
			booking_source: providerLabel,
			customer_details: {
				booking_source: providerLabel,
				name: normalized.guestName || "",
				phone: normalized.guestPhone || "0000",
				email: normalized.guestEmail || "no-email@jannatbooking.com",
				passport: "Not Provided",
				passportExpiry: "1/1/2027",
				nationality: normalized.nationality || "",
				postalCode: "00000",
				confirmation_number2: normalized.confirmationNumber,
			},
			state: isCancelled
				? "cancelled"
				: requiresPlatformReview
				? OTA_PLATFORM_REVIEW_RESERVATION_STATUS
				: "confirmed",
			reservation_status: isCancelled
				? "cancelled"
				: requiresPlatformReview
				? OTA_PLATFORM_REVIEW_RESERVATION_STATUS
				: "confirmed",
			total_guests: Number(normalized.totalGuests || 1),
			adults: Number(normalized.adults || 0),
			children: Number(normalized.children || 0),
			cancel_reason: isCancelled ? `${normalized.providerLabel} email` : "",
			booked_at: normalized.bookedAt || new Date(),
			sub_total: pricing.subTotalSar,
			total_rooms: pricing.roomCount,
			total_amount: totalAmountSar,
			currency: "SAR",
			checkin_date: normalized.checkinDate,
			checkout_date: normalized.checkoutDate,
			days_of_residence: pricing.daysOfResidence,
			comment: guestComment,
			booking_comment: guestComment,
			financeStatus: paymentMapping.financeStatus,
			payment: paymentMapping.payment,
			payment_details: {
				captured: false,
				onsite_paid_amount: 0,
			},
			paid_amount: paymentMapping.paidAmount,
			paid_amount_breakdown: paymentMapping.paidAmountBreakdown,
			commission: pricing.commissionAmountSar,
			financial_cycle: paymentMapping.financialCycle,
			pickedRoomsType: pricing.pickedRoomsType,
			pickedRoomsPricing: pricing.pickedRoomsType,
			adminPricing: {
				...adminPricingTotals,
				source: automationSource,
				provider: normalized.provider,
				providerLabel,
				sourceCurrency,
				sourceAmount: round2(sourceAmount),
				sourceExchangeRateToSar,
				sourceExchangeRateSource,
				exchangeRateToSar:
					sourceExchangeRateToSar || normalized.exchangeRateToSar || 0,
				exchangeRateSource:
					sourceExchangeRateSource || normalized.exchangeRateSource || "",
				amountConvertedAt: normalized.amountConvertedAt || "",
				payoutFallbackReason: normalized.otaPayoutFallbackReason || "",
			},
			adminPricingVisibility: requiresPlatformReview
				? {
						rootOnlyForHotelManagement: true,
						source: automationSource,
						appliedAt: new Date(),
						appliedBy: null,
				  }
				: undefined,
			ota_financial_summary: {
				show: true,
				source: automationSource,
				provider: normalized.provider,
				providerLabel,
				currency: "SAR",
				clientTotal: adminPricingTotals.clientTotal,
				hotelVisibleAmount: adminPricingTotals.rootTotal,
				netAfterExpenses: adminPricingTotals.netAfterExpensesTotal,
				netAfterOtaExpenses: adminPricingTotals.netAfterExpensesTotal,
				otaExpenseTotal: adminPricingTotals.otaExpenseTotal,
				platformProfit: adminPricingTotals.platformMarginTotal,
				commissionAmount: pricing.commissionAmountSar,
				sourceCurrency,
				sourceAmount: round2(sourceAmount),
				sourceExchangeRateToSar,
				sourceExchangeRateSource,
				paymentSummary: safePaymentSummary,
				payoutFallbackReason: normalized.otaPayoutFallbackReason || "",
			},
			otaPlatformReview: requiresPlatformReview
				? buildOtaReviewSnapshot({
						source: automationSource,
						inboundEmailId: normalized.inboundEmailId,
						provider: normalized.provider,
						providerLabel,
						confirmationNumber: normalized.confirmationNumber,
				  })
				: undefined,
			hotelId: hotelDetails._id,
			belongsTo: hotelDetails.belongsTo,
			supplierData: {
				supplierName: providerLabel,
				suppliedBookingNo: normalized.reservationId,
				otaConfirmationNumber: normalized.confirmationNumber,
				platformConfirmationNumber: normalized.confirmationNumber,
				otaAutomationPipeline: automationPipeline,
				otaProvider: normalized.provider,
				otaSourceAuthority: otaSourceAuthority(normalized),
				otaHotelName: normalized.hotelName || "",
				otaRoomName: normalized.roomName || "",
				otaGuestNotes: guestComment,
				otaNationality: normalized.nationality || "",
				otaMatchedRoomName: roomDetails.displayName || "",
				otaHotelRoomConfigId: roomDetails._id || null,
				otaSourceRoomName: normalized.roomName || "",
				otaRoomMatchScore: roomMatch.score || 0,
				otaRoomMatchType: roomMatch.matchType || "",
				otaRoomMatchReason: roomMatch.aiRoomMatch?.reason || "",
				otaRoomMatchedByModel: roomMatch.aiRoomMatch?.model || "",
				otaCurrency: normalized.currency || "",
				otaAmount: normalized.amount || 0,
				otaAmountSar: totalAmountSar,
				otaSourceCurrency: sourceCurrency,
				otaSourceAmount: round2(sourceAmount),
				otaSourceAmountHint: normalized.sourceAmountHint || normalized.amountHint || "",
				otaSourceExchangeRateToSar: sourceExchangeRateToSar,
				otaSourceExchangeRateSource: sourceExchangeRateSource,
				otaPaymentSummary: safePaymentSummary,
				otaPayoutFallbackReason: normalized.otaPayoutFallbackReason || "",
				otaTotalPayoutSar: adminPricingTotals.netAfterExpensesTotal,
				otaExpenseTotalSar: adminPricingTotals.otaExpenseTotal,
				otaPlatformMarginSar: adminPricingTotals.platformMarginTotal,
				otaExchangeRateToSar: normalized.exchangeRateToSar || 0,
				otaExchangeRateSource: normalized.exchangeRateSource || "",
				otaAmountConvertedAt: normalized.amountConvertedAt || "",
				otaPaymentCollectionModel: normalized.paymentCollectionModel || "",
				otaPaymentInstructions: normalized.paymentInstructions || "",
				otaLastInboundEmailId: normalized.inboundEmailId || "",
				otaLastEmailAt: new Date(),
				otaLastEventType: normalized.eventType,
			},
		},
	};
}

function compactUpdate(document) {
	const set = {};
	const simpleFields = [
		"reservation_id",
		"booking_source",
		"state",
		"reservation_status",
		"total_guests",
		"adults",
		"children",
		"cancel_reason",
		"booked_at",
		"sub_total",
		"total_rooms",
		"total_amount",
		"currency",
		"checkin_date",
		"checkout_date",
		"days_of_residence",
		"comment",
		"booking_comment",
		"financeStatus",
		"payment",
		"payment_details",
		"paid_amount",
		"paid_amount_breakdown",
		"commission",
		"financial_cycle",
		"pickedRoomsType",
		"pickedRoomsPricing",
		"hotelId",
		"belongsTo",
	];

	simpleFields.forEach((field) => {
		const value = document[field];
		if (value !== undefined && value !== null && value !== "") set[field] = value;
	});

	Object.entries(document.customer_details || {}).forEach(([key, value]) => {
		if (value !== undefined && value !== null && value !== "") {
			set[`customer_details.${key}`] = value;
		}
	});
	Object.entries(document.supplierData || {}).forEach(([key, value]) => {
		if (value !== undefined && value !== null && value !== "") {
			set[`supplierData.${key}`] = value;
		}
	});

	return set;
}

function hasOtaValue(value, options = {}) {
	if (value === undefined || value === null) return false;
	if (typeof value === "string") return normalizeWhitespace(value) !== "";
	if (typeof value === "number") {
		return Number.isFinite(value) && (options.allowZero || value !== 0);
	}
	return true;
}

function setIfOtaValue(target, path, value, options = {}) {
	if (hasOtaValue(value, options)) target[path] = value;
}

function setIfMissingOrSameConfirmation(target, path, existingValue, confirmationNumber) {
	if (!confirmationNumber) return;
	if (
		!normalizeWhitespace(existingValue) ||
		valuesMatchConfirmation(existingValue, confirmationNumber)
	) {
		target[path] = confirmationNumber;
	}
}

function addExistingUpdatePreservedWarning(warnings = [], message = "") {
	if (message && Array.isArray(warnings) && !warnings.includes(message)) {
		warnings.push(message);
	}
}

function sourcePresence(normalized = {}) {
	return normalized.sourcePresence && typeof normalized.sourcePresence === "object"
		? normalized.sourcePresence
		: {};
}

function hasSourceField(normalized = {}, field) {
	return sourcePresence(normalized)[field] === true;
}

function hasKnownProvider(normalized = {}) {
	const provider = normalizeComparable(normalized.provider || "").replace(/\s+/g, "");
	return (
		provider !== "" &&
		provider !== "unknown" &&
		provider !== "ota" &&
		Object.prototype.hasOwnProperty.call(PROVIDER_LABELS, provider)
	);
}

function otaSourceAuthority(normalized = {}) {
	const rawFrom = normalizeWhitespace(normalized.source?.from || "").toLowerCase();
	const comparableFrom = normalizeComparable(rawFrom);
	const provider = normalizeComparable(normalized.provider || "");
	if (comparableFrom === "expedia sync") return 4;
	const isSenderDomain = (domain) => {
		const domainPattern = escapeRegExp(domain).replace(/\\\./g, "\\.");
		return new RegExp(
			`@(?:[a-z0-9-]+\\.)*${domainPattern}(?:[>\\s]|$)`,
			"i"
		).test(rawFrom);
	};
	if (isSenderDomain("hotelrunner.com")) return 1;
	const directProviderDomains = {
		agoda: ["agoda.com"],
		airbnb: ["airbnb.com"],
		expedia: ["expedia.com", "expediagroup.com"],
		booking: ["booking.com"],
		hotels: ["hotels.com"],
		trip: ["trip.com"],
	};
	if (
		(directProviderDomains[provider] || []).some((domain) =>
			isSenderDomain(domain)
		)
	) {
		return 3;
	}
	return hasKnownProvider(normalized) ? 2 : 0;
}

function isAuthoritativeSourceUpgrade(incomingAuthority, existingAuthority) {
	const incoming = Number(incomingAuthority || 0);
	const existing = Number(existingAuthority || 0);
	return incoming >= 3 && incoming > existing;
}

function hasIncomingAmount(normalized = {}) {
	const hasAmountValue =
		Number(normalized.amount || 0) > 0 ||
		Number(normalized.totalAmountSar || 0) > 0;
	const presence = sourcePresence(normalized);
	if (Object.prototype.hasOwnProperty.call(presence, "amount")) {
		return presence.amount === true && hasAmountValue;
	}
	return hasAmountValue;
}

function hasIncomingVccAmount(normalized = {}) {
	const vcc = normalized.vcc || {};
	const amount = Number(vcc.amountToCharge);
	if (hasSourceField(normalized, "vccAmountToCharge")) {
		return Number.isFinite(amount) && amount >= 0;
	}
	return Number.isFinite(amount) && amount > 0;
}

function resolveExistingUpdateStatus(statusToApply, normalized = {}) {
	const normalizedStatus = normalizeStatusToApply(
		statusToApply || normalized.statusToApply || normalized.eventType
	);
	if (normalizedStatus) return normalizedStatus;
	if (normalized.eventType === "cancelled") return "cancelled";
	return "";
}

function buildExistingReservationUpdateSet({
	normalized = {},
	existing = {},
	document = null,
	statusToApply = "",
	warnings = [],
} = {}) {
	const set = {};
	const confirmationNumber = normalizeConfirmation(
		normalized.confirmationNumber || normalized.reservationId
	);
	const providerLabel =
		normalized.bookingSource ||
		(normalized.providerLabel && normalized.providerLabel !== "unknown"
			? normalized.providerLabel
			: "");
	const incomingStatus = resolveExistingUpdateStatus(statusToApply, normalized);
	const incomingAmount = hasIncomingAmount(normalized);
	const statusOnlyUpdate =
		normalized.intent === "reservation_status" ||
		["cancelled", "no_show", "status"].includes(normalized.eventType);
	const appliesAuthoritativeRefresh =
		normalized.authoritativeExistingRefresh === true && !!document;
	const normalizedGuestComment = cleanOtaGuestNote(
		normalized.comment || normalized.guestNotes || ""
	);

	if (document) {
		const docSet = compactUpdate(document);
		if (appliesAuthoritativeRefresh) {
			Object.keys(docSet)
				.filter((path) => path.startsWith("customer_details."))
				.forEach((path) => delete docSet[path]);
			if (!hasSourceField(normalized, "bookedAt")) delete docSet.booked_at;
			if (!hasSourceField(normalized, "adults")) delete docSet.adults;
			if (!hasSourceField(normalized, "children")) delete docSet.children;
			if (!hasSourceField(normalized, "totalGuests")) {
				delete docSet.total_guests;
			}
			Object.assign(set, docSet);
			set.adminPricing = document.adminPricing;
			set.ota_financial_summary = document.ota_financial_summary;
			set.adminPricingVisibility = document.adminPricingVisibility;
			set["otaPlatformReview.proposedInbound"] = null;
			set["supplierData.otaSourceAuthority"] = otaSourceAuthority(normalized);
			addExistingUpdatePreservedWarning(
				warnings,
				"Pending reservation facts and pricing were refreshed from a higher-authority direct OTA confirmation."
			);
		} else if (incomingAmount) {
			addExistingUpdatePreservedWarning(
				warnings,
				"Existing reservation pricing and finance fields were preserved; incoming OTA pricing was staged for review only."
			);
		}

		if (appliesAuthoritativeRefresh && hasSourceField(normalized, "roomName")) {
			setIfOtaValue(
				set,
				"supplierData.otaMatchedRoomName",
				document.supplierData?.otaMatchedRoomName
			);
			setIfOtaValue(
				set,
				"supplierData.otaRoomMatchScore",
				document.supplierData?.otaRoomMatchScore
			);
			setIfOtaValue(
				set,
				"supplierData.otaRoomMatchType",
				document.supplierData?.otaRoomMatchType
			);
		}
		if (
			!appliesAuthoritativeRefresh &&
			(docSet.hotelId || docSet.belongsTo)
		) {
			addExistingUpdatePreservedWarning(
				warnings,
				"Existing reservation hotel assignment was preserved; OTA hotel resolution was kept for audit only."
			);
		}
	}

	if (!normalizeWhitespace(existing?.reservation_id || "")) {
		setIfOtaValue(set, "reservation_id", normalized.reservationId || confirmationNumber);
	}
	if (hasSourceField(normalized, "bookingSource") || hasKnownProvider(normalized)) {
		if (!String(existing?.booking_source || "").trim()) {
			setIfOtaValue(set, "booking_source", providerLabel);
		}
		if (!String(existing?.customer_details?.booking_source || "").trim()) {
			setIfOtaValue(set, "customer_details.booking_source", providerLabel);
		}
	}
	if (!statusOnlyUpdate && appliesAuthoritativeRefresh) {
		if (hasSourceField(normalized, "guestName")) {
			setIfOtaValue(set, "customer_details.name", normalized.guestName);
		}
		if (hasSourceField(normalized, "guestEmail")) {
			setIfOtaValue(set, "customer_details.email", normalized.guestEmail);
		}
		if (hasSourceField(normalized, "guestPhone")) {
			setIfOtaValue(set, "customer_details.phone", normalized.guestPhone);
		}
		if (hasSourceField(normalized, "nationality")) {
			setIfOtaValue(
				set,
				"customer_details.nationality",
				normalized.nationality
			);
		}
		if (normalizedGuestComment) {
			if (!normalizeWhitespace(existing?.comment || "")) {
				setIfOtaValue(set, "comment", normalizedGuestComment);
			}
			if (!normalizeWhitespace(existing?.booking_comment || "")) {
				setIfOtaValue(set, "booking_comment", normalizedGuestComment);
			}
			setIfOtaValue(set, "supplierData.otaGuestNotes", normalizedGuestComment);
		}
		setIfOtaValue(set, "supplierData.otaNationality", normalized.nationality);
		setIfOtaValue(set, "checkin_date", normalized.checkinDate);
		setIfOtaValue(set, "checkout_date", normalized.checkoutDate);
		if (hasSourceField(normalized, "bookedAt")) {
			setIfOtaValue(set, "booked_at", normalized.bookedAt);
		}
	} else if (!statusOnlyUpdate) {
		set["otaPlatformReview.proposedInbound"] = {
			guest: {
				name: hasSourceField(normalized, "guestName")
					? normalized.guestName || ""
					: "",
				email: hasSourceField(normalized, "guestEmail")
					? normalized.guestEmail || ""
					: "",
				phone: hasSourceField(normalized, "guestPhone")
					? normalized.guestPhone || ""
					: "",
				nationality: hasSourceField(normalized, "nationality")
					? normalized.nationality || ""
					: "",
			},
			stay: {
				checkinDate: hasSourceField(normalized, "checkinDate")
					? normalized.checkinDate || ""
					: "",
				checkoutDate: hasSourceField(normalized, "checkoutDate")
					? normalized.checkoutDate || ""
					: "",
				adults: hasSourceField(normalized, "adults")
					? Number(normalized.adults || 0)
					: null,
				children: hasSourceField(normalized, "children")
					? Number(normalized.children || 0)
					: null,
				totalGuests: hasSourceField(normalized, "totalGuests")
					? Number(normalized.totalGuests || 0)
					: null,
			},
			room: {
				sourceName: hasSourceField(normalized, "roomName")
					? normalized.roomName || ""
					: "",
				roomCount: hasSourceField(normalized, "roomCount")
					? Number(normalized.roomCount || 0)
					: null,
			},
			pricing: incomingAmount
				? {
						guestTotalSar: Number(normalized.totalAmountSar || 0),
						sourceAmount: Number(
							normalized.sourceAmount || normalized.amount || 0
						),
						sourceCurrency:
							normalized.sourceCurrency || normalized.currency || "",
						totalPayoutSar: Number(
							normalized.totalPayoutSar ||
								normalized.netAfterExpensesTotal ||
								0
						),
						exchangeRateToSar: Number(normalized.exchangeRateToSar || 0),
						exchangeRateSource: normalized.exchangeRateSource || "",
						paymentCollectionModel:
							normalized.paymentCollectionModel || "",
						paymentSummary: safeOtaPaymentSummary(normalized.paymentSummary),
				  }
				: null,
			inboundEmailId: normalized.inboundEmailId || "",
			provider: normalized.provider || "",
			receivedAt: new Date(),
		};
		addExistingUpdatePreservedWarning(
			warnings,
			"Incoming OTA changes were staged for review; canonical guest, stay, room, and pricing fields were not overwritten automatically."
		);
	}

	const checkinForDays = normalized.checkinDate || existing.checkin_date;
	const checkoutForDays = normalized.checkoutDate || existing.checkout_date;
	const daysOfResidence = calculateDaysOfResidence(checkinForDays, checkoutForDays);
	if (
		!statusOnlyUpdate &&
		appliesAuthoritativeRefresh &&
		daysOfResidence > 0 &&
		(hasSourceField(normalized, "checkinDate") ||
			hasSourceField(normalized, "checkoutDate"))
	) {
		set.days_of_residence = daysOfResidence;
	}

	if (
		!statusOnlyUpdate &&
		appliesAuthoritativeRefresh &&
		hasSourceField(normalized, "adults") &&
		Number(normalized.adults || 0) > 0
	) {
		set.adults = Number(normalized.adults);
	}
	if (
		!statusOnlyUpdate &&
		appliesAuthoritativeRefresh &&
		hasSourceField(normalized, "children") &&
		Number(normalized.children || 0) >= 0
	) {
		set.children = Number(normalized.children);
	}
	if (
		!statusOnlyUpdate &&
		appliesAuthoritativeRefresh &&
		hasSourceField(normalized, "totalGuests") &&
		Number(normalized.totalGuests || 0) > 0
	) {
		set.total_guests = Number(normalized.totalGuests);
	}
	if (
		appliesAuthoritativeRefresh &&
		hasSourceField(normalized, "roomCount") &&
		Number(normalized.roomCount || 0) > 0
	) {
		set["supplierData.otaRoomCount"] = Number(normalized.roomCount);
	}

	if (incomingAmount && !appliesAuthoritativeRefresh) {
		addExistingUpdatePreservedWarning(
			warnings,
			"Existing reservation total, room pricing, commission, payment, and financial cycle were not overwritten by OTA automation."
		);
	}

	if (incomingStatus) {
		set.reservation_status = incomingStatus;
		if (statusOnlyUpdate) set.state = incomingStatus;
		if (["cancelled", "no_show"].includes(incomingStatus)) {
			set.cancel_reason = `${normalized.providerLabel || "OTA"} status email`;
		}
		if (["cancelled", "no_show", "inhouse", "checked_out"].includes(incomingStatus)) {
			set["otaPlatformReview.status"] = "closed";
			set["otaPlatformReview.closedAt"] = new Date();
			set["otaPlatformReview.closedReason"] = `ota_status_${incomingStatus}`;
			set["otaPlatformReview.lastUpdatedAt"] = new Date();
		}
	}

	if (confirmationNumber) {
		const incomingOtaIdentityKey = buildOtaIdentityKey(
			normalized.provider,
			confirmationNumber
		);
		const existingOtaIdentityKey = normalizeWhitespace(existing?.otaIdentityKey || "");
		if (
			incomingOtaIdentityKey &&
			(!existingOtaIdentityKey || !existingOtaIdentityKey.includes(":"))
		) {
			set.otaIdentityKey = incomingOtaIdentityKey;
		}
		setIfMissingOrSameConfirmation(
			set,
			"customer_details.confirmation_number2",
			existing?.customer_details?.confirmation_number2,
			confirmationNumber
		);
		setIfMissingOrSameConfirmation(
			set,
			"supplierData.suppliedBookingNo",
			existing?.supplierData?.suppliedBookingNo,
			confirmationNumber
		);
		setIfMissingOrSameConfirmation(
			set,
			"supplierData.otaConfirmationNumber",
			existing?.supplierData?.otaConfirmationNumber,
			confirmationNumber
		);
		setIfMissingOrSameConfirmation(
			set,
			"supplierData.platformConfirmationNumber",
			existing?.supplierData?.platformConfirmationNumber,
			confirmationNumber
		);
	}
	if (hasSourceField(normalized, "bookingSource") || hasKnownProvider(normalized)) {
		setIfOtaValue(set, "supplierData.supplierName", providerLabel);
	}
	if (hasKnownProvider(normalized)) {
		setIfOtaValue(set, "supplierData.otaProvider", normalized.provider);
	}
	if (appliesAuthoritativeRefresh && hasSourceField(normalized, "hotelName")) {
		setIfOtaValue(set, "supplierData.otaHotelName", normalized.hotelName);
	}
	if (appliesAuthoritativeRefresh && hasSourceField(normalized, "roomName")) {
		setIfOtaValue(set, "supplierData.otaRoomName", normalized.roomName);
	}
	if (appliesAuthoritativeRefresh && hasSourceField(normalized, "checkinDate")) {
		setIfOtaValue(set, "supplierData.otaCheckinDate", normalized.checkinDate);
	}
	if (appliesAuthoritativeRefresh && hasSourceField(normalized, "checkoutDate")) {
		setIfOtaValue(set, "supplierData.otaCheckoutDate", normalized.checkoutDate);
	}
	if (
		appliesAuthoritativeRefresh &&
		hasSourceField(normalized, "adults") &&
		Number(normalized.adults || 0) > 0
	) {
		set["supplierData.otaAdults"] = Number(normalized.adults);
	}
	if (
		appliesAuthoritativeRefresh &&
		hasSourceField(normalized, "children") &&
		Number(normalized.children || 0) >= 0
	) {
		set["supplierData.otaChildren"] = Number(normalized.children);
	}
	if (
		appliesAuthoritativeRefresh &&
		hasSourceField(normalized, "totalGuests") &&
		Number(normalized.totalGuests || 0) > 0
	) {
		set["supplierData.otaTotalGuests"] = Number(normalized.totalGuests);
	}
	if (incomingAmount && appliesAuthoritativeRefresh) {
		const safePaymentSummary = safeOtaPaymentSummary(normalized.paymentSummary);
		const sourceCurrency =
			normalized.sourceCurrency ||
			safePaymentSummary.sourceCurrency ||
			normalized.currency ||
			"";
		const sourceAmount = Number(
			normalized.sourceAmount ||
				safePaymentSummary.sourceTotalGuestPaymentAmount ||
				normalized.amount ||
				0
		);
		const sourceExchangeRateToSar = Number(
			normalized.sourceExchangeRateToSar ||
				safePaymentSummary.exchangeRateToSar ||
				(String(sourceCurrency || "").toUpperCase() === "SAR"
					? normalized.exchangeRateToSar || 1
					: 0)
		);
		const sourceExchangeRateSource =
			normalized.sourceExchangeRateSource ||
			safePaymentSummary.exchangeRateSource ||
			normalized.exchangeRateSource ||
			"";
		setIfOtaValue(set, "supplierData.otaCurrency", normalized.currency);
		set["supplierData.otaAmount"] = Number(normalized.amount);
		set["supplierData.otaAmountSar"] = Number(normalized.totalAmountSar);
		setIfOtaValue(set, "supplierData.otaSourceCurrency", sourceCurrency);
		if (sourceAmount > 0) {
			set["supplierData.otaSourceAmount"] = round2(sourceAmount);
		}
		setIfOtaValue(
			set,
			"supplierData.otaSourceAmountHint",
			normalized.sourceAmountHint || normalized.amountHint || ""
		);
		if (sourceExchangeRateToSar > 0) {
			set["supplierData.otaSourceExchangeRateToSar"] = sourceExchangeRateToSar;
		}
		setIfOtaValue(
			set,
			"supplierData.otaSourceExchangeRateSource",
			sourceExchangeRateSource
		);
		if (Object.keys(safePaymentSummary).length) {
			set["supplierData.otaPaymentSummary"] = safePaymentSummary;
		}
		if (Number(safePaymentSummary.totalPayoutAmount || 0) > 0) {
			set["supplierData.otaTotalPayoutSar"] = Number(
				safePaymentSummary.totalPayoutAmount
			);
			set["supplierData.otaExpenseTotalSar"] = Math.max(
				0,
				round2(
					Number(normalized.totalAmountSar || normalized.amount || 0) -
						Number(safePaymentSummary.totalPayoutAmount || 0)
				)
			);
		}
		if (Number(normalized.exchangeRateToSar || 0) > 0) {
			set["supplierData.otaExchangeRateToSar"] = Number(
				normalized.exchangeRateToSar
			);
		}
		setIfOtaValue(
			set,
			"supplierData.otaExchangeRateSource",
			normalized.exchangeRateSource
		);
		setIfOtaValue(
			set,
			"supplierData.otaAmountConvertedAt",
			normalized.amountConvertedAt
		);
	}
	if (
		appliesAuthoritativeRefresh &&
		hasSourceField(normalized, "paymentCollectionModel") &&
		normalized.paymentCollectionModel !== "unknown"
	) {
		setIfOtaValue(
			set,
			"supplierData.otaPaymentCollectionModel",
			normalized.paymentCollectionModel
		);
	}
	if (
		appliesAuthoritativeRefresh &&
		hasSourceField(normalized, "paymentInstructions")
	) {
		setIfOtaValue(
			set,
			"supplierData.otaPaymentInstructions",
			normalized.paymentInstructions
		);
	}
	setIfOtaValue(
		set,
		"supplierData.otaLastInboundEmailId",
		normalized.inboundEmailId
	);
	set["supplierData.otaLastEmailAt"] = new Date();
	if (normalized.eventType && normalized.eventType !== "unknown") {
		setIfOtaValue(set, "supplierData.otaLastEventType", normalized.eventType);
	}

	const routesThroughPlatformReview = !statusOnlyUpdate;
	if (routesThroughPlatformReview) {
		set.state = OTA_PLATFORM_REVIEW_RESERVATION_STATUS;
		set.reservation_status = OTA_PLATFORM_REVIEW_RESERVATION_STATUS;
		set["otaPlatformReview.status"] = "pending";
		set["otaPlatformReview.source"] = "ota_email_update";
		setIfOtaValue(
			set,
			"otaPlatformReview.inboundEmailId",
			normalized.inboundEmailId
		);
		setIfOtaValue(set, "otaPlatformReview.provider", normalized.provider);
		setIfOtaValue(
			set,
			"otaPlatformReview.providerLabel",
			normalized.providerLabel || providerLabel
		);
		setIfOtaValue(
			set,
			"otaPlatformReview.confirmationNumber",
			confirmationNumber
		);
		set["otaPlatformReview.lastUpdatedAt"] = new Date();
		if (!existing?.otaPlatformReview?.createdAt) {
			set["otaPlatformReview.createdAt"] = new Date();
		}
		set["adminPricingVisibility.rootOnlyForHotelManagement"] = true;
		set["adminPricingVisibility.source"] = "ota_email_update";
		set["adminPricingVisibility.appliedAt"] = new Date();
		set["adminPricingVisibility.appliedBy"] = null;
	}

	if (appliesAuthoritativeRefresh) applyVccSafeFields(set, normalized);
	return set;
}

async function applyExistingReservationEmailUpdate({
	normalized,
	existing,
	statusToApply = "",
	warnings = [],
	action = "updated-from-email",
	document = null,
} = {}) {
	const set = buildExistingReservationUpdateSet({
		normalized,
		existing,
		document,
		statusToApply,
		warnings,
	});
	const updateResult = await Reservations.updateOne(
		buildReservationSnapshotFilter(existing),
		addReservationVersionBump({
			$set: set,
			$push: {
				reservationAuditLog: buildAuditEntry(normalized, action, warnings),
			},
		}),
	);
	const matchedCount = Number(
		updateResult?.matchedCount ?? updateResult?.n ?? 0,
	);
	if (!matchedCount) {
		const error = new Error(
			"The reservation changed while the OTA email was being processed. No inbound update was applied; review the latest reservation state.",
		);
		error.code = "OTA_RESERVATION_CONCURRENT_CHANGE";
		throw error;
	}
	return set;
}

function buildAuditEntry(normalized, action, warnings = []) {
	return {
		at: new Date(),
		source: normalized.source?.from || "ota-email",
		action,
		provider: normalized.provider,
		eventType: normalized.eventType,
		reservationId: normalized.reservationId,
		messageId: normalized.source?.messageId || "",
		subject: normalized.source?.subject || "",
		warnings,
	};
}

function findHotelMentionedInSourceText(hotels = [], normalized = {}) {
	const sourceText = normalizeIntlComparable(
		[
			normalized.source?.subject || "",
			normalized.source?.safeSnippet || "",
			normalized.hotelName || "",
		].join(" ")
	);
	if (!sourceText) return null;

	let best = null;
	let bestScore = 0;
	let ties = 0;
	for (const hotel of hotels || []) {
		const labels = expandHotelNameCandidates([
			hotel.hotelName,
			hotel.hotelName_OtherLanguage,
		]);
		let hotelScore = 0;
		for (const label of labels) {
			const key = normalizeIntlComparable(label);
			if (key && key.length >= 5 && sourceText.includes(key)) {
				hotelScore = Math.max(hotelScore, key.length);
			}
		}
		if (hotelScore > bestScore) {
			best = hotel;
			bestScore = hotelScore;
			ties = 1;
		} else if (hotelScore > 0 && hotelScore === bestScore) {
			ties += 1;
		}
	}

	return bestScore > 0 && ties === 1 ? best : null;
}

const OTA_HOTEL_RESOLUTION_SELECT =
	"_id hotelName hotelName_OtherLanguage belongsTo roomCountDetails currency activateHotel xHotelProActive";

function findExactHotelNameMatch(hotels = [], hotelNameCandidates = []) {
	const candidateKeys = new Set(
		hotelNameCandidates.map((candidate) => normalizeIntlComparable(candidate)).filter(Boolean)
	);
	if (!candidateKeys.size) return null;

	let matched = null;
	let ties = 0;
	for (const hotel of hotels || []) {
		const labels = expandHotelNameCandidates([
			hotel.hotelName,
			hotel.hotelName_OtherLanguage,
		]);
		const hasExactMatch = labels.some((label) =>
			candidateKeys.has(normalizeIntlComparable(label))
		);
		if (!hasExactMatch) continue;
		matched = hotel;
		ties += 1;
	}
	return matched && ties === 1 ? matched : null;
}

function findConfidentFuzzyHotelMatch(
	hotels = [],
	hotelNameCandidates = [],
	{ minimumScore = 84, minimumMargin = 10 } = {}
) {
	const ranked = (hotels || [])
		.map((hotel, index) => {
			const score = [hotel.hotelName, hotel.hotelName_OtherLanguage]
				.filter(Boolean)
				.reduce(
					(best, name) =>
						Math.max(
							best,
							...(hotelNameCandidates || []).map((candidateName) =>
								Math.round(hotelNameSimilarity(candidateName, name) * 100)
							)
						),
					0
				);
			return { hotel, index, score };
		})
		.sort((left, right) => right.score - left.score || left.index - right.index);
	const best = ranked[0];
	const runnerUp = ranked[1];
	if (!best || best.score < minimumScore) return null;
	if (runnerUp && best.score - runnerUp.score < minimumMargin) return null;
	return best.hotel;
}

async function loadConfiguredAjyadHotel() {
	return HotelDetails.findById(configuredAjyadHotelId())
		.select(OTA_HOTEL_RESOLUTION_SELECT)
		.lean();
}

async function resolveHotel(normalized, existingReservation = null) {
	if (existingReservation?.hotelId) {
		return HotelDetails.findById(existingReservation.hotelId)
			.select(OTA_HOTEL_RESOLUTION_SELECT)
			.lean();
	}

	const directHotelId = normalized.hotelId;
	if (directHotelId) {
		const direct = await HotelDetails.findById(directHotelId)
			.select(OTA_HOTEL_RESOLUTION_SELECT)
			.lean();
		if (direct) return direct;
	}

	const wanted = normalizeComparable(normalized.hotelName);
	const hotelNameCandidates = expandHotelNameCandidates([
		normalized.hotelName,
		...(Array.isArray(normalized.hotelNameAliases)
			? normalized.hotelNameAliases
			: []),
	]);
	const loadCandidateHotels = async () => {
		return HotelDetails.find({}).select(OTA_HOTEL_RESOLUTION_SELECT).lean();
	};

	const allHotelsForExactOrKeyword = async () =>
		HotelDetails.find({}).select(OTA_HOTEL_RESOLUTION_SELECT).lean();

	if (!wanted || !hotelNameCandidates.length) {
		const hotels = await allHotelsForExactOrKeyword();
		const exactMentioned = findHotelMentionedInSourceText(hotels, normalized);
		if (exactMentioned) return exactMentioned;
		if (normalizedReservationContainsAjyad(normalized)) {
			const ajyadHotel = await loadConfiguredAjyadHotel();
			if (ajyadHotel) return ajyadHotel;
		}
		const candidateHotels = await loadCandidateHotels();
		return findHotelMentionedInSourceText(candidateHotels, normalized);
	}

	const hotelsForExactOrKeyword = await allHotelsForExactOrKeyword();
	const exactHotel = findExactHotelNameMatch(
		hotelsForExactOrKeyword,
		hotelNameCandidates
	);
	if (exactHotel) return exactHotel;
	if (normalizedReservationContainsAjyad(normalized)) {
		const ajyadHotel = await loadConfiguredAjyadHotel();
		if (ajyadHotel) return ajyadHotel;
	}

	const hotels = await HotelDetails.find({})
		.select(OTA_HOTEL_RESOLUTION_SELECT)
		.lean();
	const confidentFuzzyHotel = findConfidentFuzzyHotelMatch(
		hotels,
		hotelNameCandidates
	);
	if (confidentFuzzyHotel) return confidentFuzzyHotel;
	return findHotelMentionedInSourceText(hotels, normalized);
}

function applyVccSafeFields(target, normalized) {
	const vcc = normalized.vcc || {};
	const hasAmountToCharge = hasIncomingVccAmount(normalized);
	const hasAnyVccDetail =
		!!vcc.cardLast4 ||
		hasAmountToCharge ||
		!!vcc.activationDate ||
		!!vcc.expirationDate;
	if (hasAnyVccDetail) {
		target["vcc_payment.source"] = normalized.provider;
	}
	if (vcc.cardLast4) {
		target["vcc_payment.metadata.card_last4"] = vcc.cardLast4;
	}
	if (hasAmountToCharge) {
		target["vcc_payment.metadata.amount_to_charge"] = Number(
			vcc.amountToCharge || 0
		);
		if (vcc.amountToChargeCurrency) {
			target["vcc_payment.metadata.amount_to_charge_currency"] =
				vcc.amountToChargeCurrency;
		}
		if (hasOtaValue(vcc.amountToChargeSar, { allowZero: true })) {
			target["vcc_payment.metadata.amount_to_charge_sar"] =
				Number(vcc.amountToChargeSar || 0);
		}
		if (hasOtaValue(vcc.amountToChargeUsd, { allowZero: true })) {
			target["vcc_payment.metadata.amount_to_charge_usd"] =
				Number(vcc.amountToChargeUsd || 0);
		}
		if (Number(vcc.amountToChargeExchangeRateToSar || 0) > 0) {
			target["vcc_payment.metadata.amount_to_charge_exchange_rate_to_sar"] =
				Number(vcc.amountToChargeExchangeRateToSar);
		}
		if (vcc.amountToChargeExchangeRateSource) {
			target["vcc_payment.metadata.amount_to_charge_exchange_rate_source"] =
				vcc.amountToChargeExchangeRateSource;
		}
		if (Number(vcc.amountToChargeUsdExchangeRateToSar || 0) > 0) {
			target["vcc_payment.metadata.amount_to_charge_usd_exchange_rate_to_sar"] =
				Number(vcc.amountToChargeUsdExchangeRateToSar);
		}
		if (vcc.amountToChargeUsdExchangeRateSource) {
			target["vcc_payment.metadata.amount_to_charge_usd_exchange_rate_source"] =
				vcc.amountToChargeUsdExchangeRateSource;
		}
		if (vcc.amountToChargeConvertedAt) {
			target["vcc_payment.metadata.amount_to_charge_converted_at"] =
				vcc.amountToChargeConvertedAt;
		}
		if (vcc.amountToChargeSarSource) {
			target["vcc_payment.metadata.amount_to_charge_sar_source"] =
				vcc.amountToChargeSarSource;
		}
		if (vcc.amountToChargeUsdSource) {
			target["vcc_payment.metadata.amount_to_charge_usd_source"] =
				vcc.amountToChargeUsdSource;
		}
	}
	if (vcc.activationDate) {
		target["vcc_payment.metadata.activation_date"] = vcc.activationDate;
	}
	if (vcc.expirationDate) {
		target["vcc_payment.metadata.expiration_date"] = vcc.expirationDate;
	}
}

function applyVccSafeFieldsToDocument(document, normalized) {
	const vcc = normalized.vcc || {};
	const hasAmountToCharge = hasIncomingVccAmount(normalized);
	if (
		!vcc.cardLast4 &&
		!hasAmountToCharge &&
		!vcc.activationDate &&
		!vcc.expirationDate
	) {
		return;
	}
	document.vcc_payment = document.vcc_payment || {};
	document.vcc_payment.source = normalized.provider;
	document.vcc_payment.metadata = {
		...(document.vcc_payment.metadata || {}),
	};
	if (vcc.cardLast4) document.vcc_payment.metadata.card_last4 = vcc.cardLast4;
	if (hasAmountToCharge) {
		document.vcc_payment.metadata.amount_to_charge = Number(
			vcc.amountToCharge || 0
		);
		if (vcc.amountToChargeCurrency) {
			document.vcc_payment.metadata.amount_to_charge_currency =
				vcc.amountToChargeCurrency;
		}
		if (hasOtaValue(vcc.amountToChargeSar, { allowZero: true })) {
			document.vcc_payment.metadata.amount_to_charge_sar =
				Number(vcc.amountToChargeSar || 0);
		}
		if (hasOtaValue(vcc.amountToChargeUsd, { allowZero: true })) {
			document.vcc_payment.metadata.amount_to_charge_usd =
				Number(vcc.amountToChargeUsd || 0);
		}
		if (Number(vcc.amountToChargeExchangeRateToSar || 0) > 0) {
			document.vcc_payment.metadata.amount_to_charge_exchange_rate_to_sar =
				Number(vcc.amountToChargeExchangeRateToSar);
		}
		if (vcc.amountToChargeExchangeRateSource) {
			document.vcc_payment.metadata.amount_to_charge_exchange_rate_source =
				vcc.amountToChargeExchangeRateSource;
		}
		if (Number(vcc.amountToChargeUsdExchangeRateToSar || 0) > 0) {
			document.vcc_payment.metadata.amount_to_charge_usd_exchange_rate_to_sar =
				Number(vcc.amountToChargeUsdExchangeRateToSar);
		}
		if (vcc.amountToChargeUsdExchangeRateSource) {
			document.vcc_payment.metadata.amount_to_charge_usd_exchange_rate_source =
				vcc.amountToChargeUsdExchangeRateSource;
		}
		if (vcc.amountToChargeConvertedAt) {
			document.vcc_payment.metadata.amount_to_charge_converted_at =
				vcc.amountToChargeConvertedAt;
		}
		if (vcc.amountToChargeSarSource) {
			document.vcc_payment.metadata.amount_to_charge_sar_source =
				vcc.amountToChargeSarSource;
		}
		if (vcc.amountToChargeUsdSource) {
			document.vcc_payment.metadata.amount_to_charge_usd_source =
				vcc.amountToChargeUsdSource;
		}
	}
	if (vcc.activationDate) {
		document.vcc_payment.metadata.activation_date = vcc.activationDate;
	}
	if (vcc.expirationDate) {
		document.vcc_payment.metadata.expiration_date = vcc.expirationDate;
	}
}

function normalizeStatusToApply(value) {
	const s = normalizeComparable(value);
	if (!s) return "";
	if (s.includes("cancel")) return "cancelled";
	if (s.includes("no show") || s.includes("noshow")) return "no_show";
	if (s.includes("checked out") || s.includes("checkout")) return "checked_out";
	if (s.includes("inhouse") || s.includes("in house") || s.includes("checked in")) {
		return "inhouse";
	}
	if (s.includes("confirm") || s.includes("active")) return "confirmed";
	return "";
}

const OTA_GUEST_NAME_METADATA_PATTERN =
	/\b(?:customer\s+(?:first|last)\s+name|country\s+of\s+residence|residence\s+country|guest\s+(?:e-?mail|phone)|children(?:'s)?\s+age|kids?\s+ages?|room\s+type|check[-\s]?in|check[-\s]?out|arrival\s+date|departure\s+date|booking\s+(?:id|number|details)|reservation\s+(?:id|number|details))\b/i;
const OTA_ROOM_NAME_METADATA_PATTERN =
	/\b(?:customer\s+(?:first|last)\s+name|country\s+of\s+residence|residence\s+country|guest\s+(?:name|e-?mail|phone)|children(?:'s)?\s+age|kids?\s+ages?|check[-\s]?in|check[-\s]?out|arrival\s+date|departure\s+date|booking\s+(?:id|number)|reservation\s+(?:id|number))\b/i;

function unicodeLetterCount(value = "") {
	return (String(value || "").match(/\p{L}/gu) || []).length;
}

function isPlausibleOtaGuestName(value = "") {
	const candidate = normalizeWhitespace(value);
	const comparable = normalizeComparable(candidate);
	if (!candidate || candidate.length > 140 || unicodeLetterCount(candidate) < 2) {
		return false;
	}
	if (/^(?:n\/?a|none|unknown|not provided|guest|customer|name)$/i.test(candidate)) {
		return false;
	}
	if (
		OTA_GUEST_NAME_METADATA_PATTERN.test(candidate) ||
		/^(?:https?:\/\/|www\.)/i.test(candidate) ||
		/@|\.(?:png|jpe?g|gif|webp|svg|ico|pdf)\b/i.test(candidate) ||
		/\b(?:logo|header|footer|invoice|voucher)\b/i.test(comparable)
	) {
		return false;
	}
	return true;
}

function isPlausibleOtaRoomName(value = "") {
	const candidate = normalizeWhitespace(value);
	if (
		!candidate ||
		candidate.length > 180 ||
		unicodeLetterCount(candidate) < 1
	) {
		return false;
	}
	if (/^(?:n\/?a|none|unknown|not provided|room|room type)$/i.test(candidate)) {
		return false;
	}
	if (
		OTA_ROOM_NAME_METADATA_PATTERN.test(candidate) ||
		/^(?:https?:\/\/|www\.)/i.test(candidate) ||
		/@|\.(?:png|jpe?g|gif|webp|svg|ico|pdf)\b/i.test(candidate)
	) {
		return false;
	}
	return true;
}

function requiredNewReservationMissing(normalized = {}) {
	const missing = [];
	const deterministicInbound = isOtaInboundEmail(normalized);
	const requiredValue = (field, value) =>
		!!value && (!deterministicInbound || hasSourceField(normalized, field));
	if (!requiredValue("confirmationNumber", normalized.confirmationNumber)) {
		missing.push("source-backed confirmation number");
	}
	if (
		!requiredValue("guestName", normalized.guestName) ||
		!isPlausibleOtaGuestName(normalized.guestName)
	) {
		missing.push("source-backed guest name");
	}
	if (!requiredValue("hotelName", normalized.hotelName || normalized.hotelId)) {
		missing.push("source-backed hotel/property");
	}
	if (
		!requiredValue("roomName", normalized.roomName) ||
		!isPlausibleOtaRoomName(normalized.roomName)
	) {
		missing.push("source-backed room type/name");
	}
	if (!requiredValue("checkinDate", normalized.checkinDate)) {
		missing.push("source-backed check-in date");
	}
	if (!requiredValue("checkoutDate", normalized.checkoutDate)) {
		missing.push("source-backed check-out date");
	}
	if (!hasIncomingAmount(normalized)) {
		missing.push("positive source-backed guest total");
	}
	const stayNights = calculateDaysOfResidence(
		normalized.checkinDate,
		normalized.checkoutDate
	);
	if (
		normalized.checkinDate &&
		normalized.checkoutDate &&
		(stayNights <= 0 || stayNights > 366)
	) {
		missing.push("plausible stay-date range");
	}
	if (normalized.requiresManualReview === true) {
		missing.push("single unambiguous room block");
	}
	return missing;
}

async function applyLiveSarConversion(normalized = {}) {
	const next = {
		...normalized,
		warnings: [...(normalized.warnings || [])],
		errors: [...(normalized.errors || [])],
	};
	const amount = Number(next.amount || 0);
	if (amount) {
		const conversion = await getSarConversionMetaAsync(
			amount,
			next.currency || "SAR"
		);
		next.totalAmountSar = conversion.totalAmountSar;
		next.exchangeRateToSar = conversion.exchangeRateToSar;
		next.exchangeRateSource = conversion.exchangeRateSource;
		next.amountConvertedAt = conversion.convertedAt;

		if (
			conversion.sourceCurrency !== "SAR" &&
			conversion.exchangeRateSource === "fallback_default" &&
			!STABLE_DEFAULT_RATE_CURRENCIES.has(conversion.sourceCurrency)
		) {
			const warning = `Using fallback SAR exchange rate for ${conversion.sourceCurrency}; configure OTA_${conversion.sourceCurrency}_TO_SAR_RATE or EXCHANGE_RATE for exact production accounting.`;
			if (!next.warnings.includes(warning)) next.warnings.push(warning);
		}
		if (
			conversion.sourceCurrency !== "SAR" &&
			conversion.exchangeRateSource === "missing"
		) {
			const error = `Missing SAR exchange rate for ${conversion.sourceCurrency}.`;
			if (!next.errors.includes(error)) next.errors.push(error);
		}
	}

	const vcc = { ...(next.vcc || {}) };
	if (hasIncomingVccAmount(next) && vcc.amountToChargeCurrency) {
		const vccConversion = await getVccAmountConversionMetaAsync(
			vcc.amountToCharge,
			vcc.amountToChargeCurrency
		);
		if (!vcc.amountToChargeHasSarInEmail) {
			vcc.amountToChargeSar = vccConversion.totalAmountSar;
			vcc.amountToChargeSarSource = vccConversion.exchangeRateSource;
		}
		if (!vcc.amountToChargeHasUsdInEmail) {
			vcc.amountToChargeUsd = vccConversion.amountUsd;
			vcc.amountToChargeUsdSource =
				vccConversion.sourceCurrency === "USD"
					? "source_currency"
					: "converted_from_sar";
		}
		vcc.amountToChargeExchangeRateToSar = vccConversion.exchangeRateToSar;
		vcc.amountToChargeExchangeRateSource = vccConversion.exchangeRateSource;
		vcc.amountToChargeUsdExchangeRateToSar =
			vccConversion.usdExchangeRateToSar;
		vcc.amountToChargeUsdExchangeRateSource =
			vccConversion.usdExchangeRateSource;
		vcc.amountToChargeConvertedAt = vccConversion.convertedAt;
		next.vcc = vcc;

		if (
			vccConversion.sourceCurrency !== "SAR" &&
			vccConversion.exchangeRateSource === "fallback_default" &&
			!STABLE_DEFAULT_RATE_CURRENCIES.has(vccConversion.sourceCurrency)
		) {
			const warning = `Using fallback SAR exchange rate for VCC amount ${vccConversion.sourceCurrency}; configure OTA_${vccConversion.sourceCurrency}_TO_SAR_RATE or EXCHANGE_RATE for exact production accounting.`;
			if (!next.warnings.includes(warning)) next.warnings.push(warning);
		}
		if (
			vccConversion.sourceCurrency !== "SAR" &&
			vccConversion.exchangeRateSource === "missing"
		) {
			const error = `Missing SAR exchange rate for VCC amount ${vccConversion.sourceCurrency}.`;
			if (!next.errors.includes(error)) next.errors.push(error);
		}
	}

	return next;
}

function pushPricingWarnings(warnings, pricingWarnings = []) {
	(Array.isArray(pricingWarnings) ? pricingWarnings : []).forEach((warning) => {
		const message =
			typeof warning === "string" ? warning : warning?.message || "";
		if (message) warnings.push(message);
	});
}

function documentHasSourcePricing(document = {}) {
	const rooms = Array.isArray(document.pickedRoomsType)
		? document.pickedRoomsType
		: [];
	const stayDates = generateDateRange(document.checkin_date, document.checkout_date);
	return (
		stayDates.length > 0 &&
		rooms.length > 0 &&
		rooms.every((room) => {
			const rows = Array.isArray(room.pricingByDay) ? room.pricingByDay : [];
			return rows.length === stayDates.length;
		})
	);
}

async function normalizeBuiltReservationDocument(document, warnings) {
	if (documentHasSourcePricing(document)) {
		document.pickedRoomsPricing = document.pickedRoomsPricing || document.pickedRoomsType;
		return document;
	}
	const pricingResult = await normalizeReservationCreationPricing(document, {
		allowBlockedCalendar: true,
	});
	pushPricingWarnings(warnings, pricingResult.warnings);
	const reservation = pricingResult.reservation || document;
	const totalAmount = Number(reservation.total_amount || 0);
	const subTotal = Number(reservation.sub_total || 0);
	reservation.commission = Math.max(0, totalAmount - subTotal).toFixed(2);
	return reservation;
}

function logReconcile(stage, payload = {}) {
	console.log(`[ota-reconcile] ${stage}`, {
		at: new Date().toISOString(),
		...payload,
	});
}

function normalizeId(value) {
	if (!value) return "";
	if (typeof value === "object") {
		if (typeof value.toHexString === "function") {
			return value.toHexString().trim().toLowerCase();
		}
		if (value._id && value._id !== value) return normalizeId(value._id);
		if (typeof value.toString === "function") {
			return value.toString().trim().toLowerCase();
		}
	}
	return String(value).trim().toLowerCase();
}

function getOtaInboundAllowedHotelIds() {
	return Array.from(
		new Set(
			String(process.env.OTA_INBOUND_EMAIL_HOTEL_IDS || "")
				.split(",")
				.map((item) => item.trim().toLowerCase())
				.filter(Boolean)
		)
	);
}

function isHotelAllowedForOtaInbound(hotelId) {
	const allowedIds = getOtaInboundAllowedHotelIds();
	if (!allowedIds.length) return true;
	return allowedIds.includes(normalizeId(hotelId));
}

function isHotelActiveForOtaInbound(hotelDetails = {}) {
	return hotelDetails?.activateHotel === true && hotelDetails?.xHotelProActive !== false;
}

function isAjyadKeywordHotelResolution(normalized = {}, hotelDetails = {}) {
	return (
		normalizeId(hotelDetails?._id) === normalizeId(configuredAjyadHotelId()) &&
		normalizedReservationContainsAjyad(normalized)
	);
}

function getManualOtaHotelAssignmentReason(normalized = {}, hotelDetails = {}) {
	if (!hotelDetails?._id || isAjyadKeywordHotelResolution(normalized, hotelDetails)) {
		return "";
	}
	if (!isHotelActiveForOtaInbound(hotelDetails)) {
		return "resolved_hotel_inactive";
	}
	return "";
}

function withResolvedHotelManualAssignmentWarning(
	warnings = [],
	hotelDetails = {},
	reason = ""
) {
	const reasonLabel =
		reason === "resolved_hotel_inactive"
			? "inactive"
			: "unclear for automatic hotel assignment";
	const message = `Resolved hotel "${
		hotelDetails?.hotelName || normalizeId(hotelDetails?._id) || "unknown"
	}" is ${reasonLabel}; saved to OTA review without a hotel assignment.`;
	return warnings.includes(message) ? warnings : [...warnings, message];
}

function confirmationLookupValues(value) {
	const raw = normalizeWhitespace(value);
	const normalized = normalizeConfirmation(value);
	return Array.from(new Set([raw, normalized, raw.toUpperCase()].filter(Boolean)));
}

function normalizeOtaIdentityProvider(provider = "") {
	const normalized = normalizeComparable(provider).replace(/\s+/g, "");
	return Object.prototype.hasOwnProperty.call(PROVIDER_LABELS, normalized) &&
		normalized !== "ota"
		? normalized
		: "";
}

function buildOtaIdentityKey(provider, confirmationNumber) {
	const normalizedProvider = normalizeOtaIdentityProvider(provider);
	const normalizedConfirmation = normalizeConfirmation(confirmationNumber);
	if (!normalizedProvider || !normalizedConfirmation) return "";
	return `${normalizedProvider}:${normalizedConfirmation}`;
}

function otaProviderLookupValues(provider = "") {
	const normalizedProvider = normalizeOtaIdentityProvider(provider);
	if (!normalizedProvider) return [];
	const providerLabel = PROVIDER_LABELS[normalizedProvider] || normalizedProvider;
	return Array.from(
		new Set(
			[
				normalizedProvider,
				providerLabel,
				String(providerLabel).toLowerCase(),
				String(providerLabel).toUpperCase(),
			].filter(Boolean)
		)
	);
}

function reservationMatchesOtaProvider(reservation = {}, provider = "") {
	const expected = new Set(
		otaProviderLookupValues(provider).map((value) => normalizeComparable(value))
	);
	if (!expected.size) return false;
	return [
		reservation?.supplierData?.otaProvider,
		reservation?.otaPlatformReview?.provider,
		reservation?.supplierData?.supplierName,
		reservation?.booking_source,
		reservation?.customer_details?.booking_source,
	]
		.filter(Boolean)
		.some((value) => expected.has(normalizeComparable(value)));
}

function buildOtaConfirmationLookup(confirmationNumber, provider) {
	const values = confirmationLookupValues(confirmationNumber);
	const providerValues = otaProviderLookupValues(provider);
	const otaIdentityKey = buildOtaIdentityKey(provider, confirmationNumber);
	if (!values.length || !providerValues.length || !otaIdentityKey) return null;
	const allValues = Array.from(
		new Set(
			values
				.flatMap((item) => [item, item.toLowerCase(), item.toUpperCase()])
				.filter(Boolean)
		)
	);
	return {
		$or: [
			{ otaIdentityKey },
			{
				$and: [
					{
						$or: [
							{ "supplierData.otaProvider": { $in: providerValues } },
							{ "otaPlatformReview.provider": { $in: providerValues } },
							{ "supplierData.supplierName": { $in: providerValues } },
							{ booking_source: { $in: providerValues } },
							{ "customer_details.booking_source": { $in: providerValues } },
						],
					},
					{
						$or: [
							{ otaIdentityKey: { $in: allValues } },
							{ reservation_id: { $in: allValues } },
							{
								"customer_details.confirmation_number2": {
									$in: allValues,
								},
							},
							{ "supplierData.suppliedBookingNo": { $in: allValues } },
							{
								"supplierData.otaConfirmationNumber": {
									$in: allValues,
								},
							},
							{
								"supplierData.platformConfirmationNumber": {
									$in: allValues,
								},
							},
						],
					},
				],
			},
		],
	};
}

async function findReservationByOtaConfirmation(
	confirmationNumber,
	provider,
	projection = ""
) {
	const query = buildOtaConfirmationLookup(confirmationNumber, provider);
	if (!query) return null;
	let finder = Reservations.findOne(query);
	if (projection) finder = finder.select(projection);
	return finder.exec();
}

function valuesMatchConfirmation(storedValue, incomingConfirmation) {
	const storedValues = confirmationLookupValues(storedValue).map((item) =>
		item.toLowerCase()
	);
	const incomingValues = confirmationLookupValues(incomingConfirmation).map((item) =>
		item.toLowerCase()
	);
	return storedValues.some((value) => incomingValues.includes(value));
}

function detectConfirmationMatchFields(reservation, confirmationNumber, provider) {
	if (
		!reservation ||
		!confirmationNumber ||
		!normalizeOtaIdentityProvider(provider) ||
		!reservationMatchesOtaProvider(reservation, provider)
	) {
		return [];
	}
	const otaIdentityKey = buildOtaIdentityKey(provider, confirmationNumber);
	const fields = [
		[
			"otaIdentityKey",
			String(reservation.otaIdentityKey || "").includes(":")
				? String(reservation.otaIdentityKey).toLowerCase() === otaIdentityKey
					? confirmationNumber
					: ""
				: reservation.otaIdentityKey,
		],
		["reservation_id", reservation.reservation_id],
		[
			"customer_details.confirmation_number2",
			reservation.customer_details?.confirmation_number2,
		],
		["supplierData.suppliedBookingNo", reservation.supplierData?.suppliedBookingNo],
		[
			"supplierData.otaConfirmationNumber",
			reservation.supplierData?.otaConfirmationNumber,
		],
		[
			"supplierData.platformConfirmationNumber",
			reservation.supplierData?.platformConfirmationNumber,
		],
	];
	return fields
		.filter(([, value]) => valuesMatchConfirmation(value, confirmationNumber))
		.map(([field]) => field);
}

function generateRandomConfirmationNumber() {
	return Math.floor(1000000000 + Math.random() * 9000000000).toString();
}

async function generateUniquePmsConfirmationNumber(maxAttempts = 25) {
	for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
		const candidate = generateRandomConfirmationNumber();
		// eslint-disable-next-line no-await-in-loop
		const exists = await Reservations.exists({ confirmation_number: candidate });
		if (!exists) return candidate;
	}

	const fallback = `${Date.now()}`.slice(-10).padStart(10, "1");
	const exists = await Reservations.exists({ confirmation_number: fallback });
	if (!exists) return fallback;
	throw new Error("Could not generate a unique PMS confirmation number.");
}

function canCreateUnmappedOtaReviewReservation(
	normalized = {},
	allowCreate = false
) {
	if (!allowCreate || normalized.requiresManualReview === true) return false;
	return requiredNewReservationMissing(normalized).every(
		(item) => item === "source-backed hotel/property"
	);
}

async function createUnmappedOtaReviewReservation({
	normalized = {},
	confirmationNumber = "",
	warnings = [],
	errors = [],
	allowCreate = false,
} = {}) {
	const nonHotelMissing = requiredNewReservationMissing(normalized).filter(
		(item) => item !== "source-backed hotel/property"
	);
	if (!canCreateUnmappedOtaReviewReservation(normalized, allowCreate)) {
		// Weak or ambiguous facts stay in the inbound audit. The only permitted
		// as-is reservation is a complete booking whose hotel cannot be mapped.
		const reviewText = [...errors, ...warnings, ...nonHotelMissing].join(" ");
		const needsMapping = /\b(hotel|property|room|mapping|assignment)\b/i.test(
			reviewText
		);
		return {
			status: needsMapping ? "needs_mapping" : "needs_review",
			actionTaken: "skipped",
			skipReason: needsMapping
				? "ota_mapping_required_no_reservation_created"
				: "ota_manual_review_no_reservation_created",
			automationComment:
				"No reservation was created from incomplete or ambiguous OTA data; the inbound audit remains available for manual review.",
			warnings,
			errors,
			reservationId: null,
			hotelId: null,
			pmsConfirmationNumber: "",
			matchedReservationBy: [],
		};
	}

	const existingBeforeCreate = await findReservationByOtaConfirmation(
		confirmationNumber,
		normalized.provider,
		"_id hotelId confirmation_number otaIdentityKey reservation_id customer_details supplierData"
	);
	if (existingBeforeCreate) {
		return {
			status: "duplicate_reservation",
			warnings,
			errors: [
				...errors,
				"Existing reservation matched before as-is OTA review creation; no duplicate was created.",
			],
			reservationId: existingBeforeCreate._id,
			hotelId: existingBeforeCreate.hotelId,
			pmsConfirmationNumber: existingBeforeCreate.confirmation_number,
			matchedReservationBy: detectConfirmationMatchFields(
				existingBeforeCreate,
				confirmationNumber,
				normalized.provider
			),
		};
	}

	const missingHotelWarning =
		"Hotel was not confidently resolved from the OTA email; the OTA room name was saved as-is in platform review pending hotel assignment.";
	if (!warnings.includes(missingHotelWarning)) warnings.push(missingHotelWarning);
	const document = buildUnmappedOtaReviewReservationDocument({
		...normalized,
		confirmationNumber,
	});
	document.otaIdentityKey = buildOtaIdentityKey(
		normalized.provider,
		confirmationNumber
	);
	document.reservationAuditLog = [
		buildAuditEntry(normalized, "created-unmapped-from-email", warnings),
	];
	applyVccSafeFieldsToDocument(document, normalized);
	document.confirmation_number = await generateUniquePmsConfirmationNumber();
	document.customer_details = {
		...(document.customer_details || {}),
		confirmation_number2: confirmationNumber,
	};
	document.supplierData = {
		...(document.supplierData || {}),
		suppliedBookingNo: confirmationNumber,
		otaConfirmationNumber: confirmationNumber,
		platformConfirmationNumber: confirmationNumber,
		pmsConfirmationNumber: document.confirmation_number,
		otaCreatedFromEmail: normalized.source?.from !== "expedia-sync",
		otaCreatedFromSync: normalized.source?.from === "expedia-sync",
		otaInboundEmailId: normalized.inboundEmailId || "",
		otaCreatedAt: new Date(),
	};

	let created;
	for (let createAttempt = 0; createAttempt < 2; createAttempt += 1) {
		try {
			logReconcile("create_unmapped.start", {
				platformConfirmationNumber: confirmationNumber,
				pmsConfirmationNumber: document.confirmation_number,
				provider: normalized.provider || "",
				hotelName: normalized.hotelName || "",
			});
			created = await Reservations.create(document);
			break;
		} catch (error) {
			if (error?.code === 11000) {
				const duplicate = await findReservationByOtaConfirmation(
					confirmationNumber,
					normalized.provider,
					"_id hotelId confirmation_number otaIdentityKey reservation_id customer_details supplierData"
				);
				if (duplicate) {
					return {
						status: "duplicate_reservation",
						warnings,
						errors: [
							...errors,
							"Existing reservation matched during as-is duplicate-key recovery; no duplicate was created.",
						],
						reservationId: duplicate._id,
						hotelId: duplicate.hotelId,
						pmsConfirmationNumber: duplicate.confirmation_number,
						matchedReservationBy: detectConfirmationMatchFields(
							duplicate,
							confirmationNumber,
							normalized.provider
						),
					};
				}
				if (createAttempt === 0) {
					document.confirmation_number =
						await generateUniquePmsConfirmationNumber();
					document.supplierData.pmsConfirmationNumber =
						document.confirmation_number;
					continue;
				}
			}
			throw error;
		}
	}

	logReconcile("create_unmapped.done", {
		platformConfirmationNumber: confirmationNumber,
		pmsConfirmationNumber: created.confirmation_number,
		reservationId: String(created._id),
	});
	return {
		status: "created",
		actionTaken: "created_unmapped_ota_review",
		skipReason: "",
		automationComment:
			"OTA reservation was saved with its OTA room name as-is because no hotel could be confidently mapped; assign a hotel and PMS room before release.",
		warnings,
		errors,
		reservationId: created._id,
		hotelId: null,
		pmsConfirmationNumber: created.confirmation_number,
		otaPlatformReviewStatus: created?.otaPlatformReview?.status || "",
		matchedReservationBy: [],
	};
}

async function reconcileOtaReservationUnqueued(inputNormalized) {
	const normalized = await applyLiveSarConversion(inputNormalized || {});
	const warnings = [...(normalized.warnings || [])];
	const errors = [...(normalized.errors || [])];

	const confirmationNumber = normalizeConfirmation(normalized.confirmationNumber);
	const intent = normalized.intent || "unknown";
	const statusToApply = normalizeStatusToApply(
		normalized.statusToApply || normalized.eventType
	);
	const isStatusIntent =
		intent === "reservation_status" ||
		["cancelled", "no_show", "status"].includes(normalized.eventType);
	const isUpdateIntent =
		intent === "reservation_update" || normalized.eventType === "modified";

	logReconcile("start", {
		provider: normalized.provider,
		intent,
		eventType: normalized.eventType,
		statusToApply,
		confirmationNumber,
		sourceAmount: normalized.amount || 0,
		sourceCurrency: normalized.currency || "",
		totalAmountSar: normalized.totalAmountSar || 0,
		exchangeRateToSar: normalized.exchangeRateToSar || 0,
		exchangeRateSource: normalized.exchangeRateSource || "",
		paymentCollectionModel: normalized.paymentCollectionModel || "",
	});

	if (intent === "not_reservation") {
		logReconcile("not_reservation", { confirmationNumber });
		return { status: "not_reservation", warnings, errors };
	}
	if (intent === "unknown") {
		logReconcile("needs_review.unknown_intent", { confirmationNumber });
		return {
			status: "needs_review",
			actionTaken: "skipped",
			skipReason: "unknown_ota_intent_no_mutation",
			automationComment:
				"The email intent was not deterministically established; no reservation fields were changed.",
			warnings,
			errors: [...errors, "Could not safely determine the OTA reservation intent."],
		};
	}
	if (normalized.requiresManualReview === true) {
		const manualReasons = Array.isArray(normalized.manualReviewReasons)
			? normalized.manualReviewReasons
			: [];
		logReconcile("needs_review.explicit_parser_guard", {
			confirmationNumber,
			reasons: manualReasons,
		});
		return {
			status: "needs_review",
			actionTaken: "skipped",
			skipReason: "ota_parser_requires_manual_review",
			automationComment:
				manualReasons[0] || "The OTA payload is not safe for automatic mutation.",
			warnings: [...warnings, ...manualReasons],
			errors,
		};
	}
	if (
		isOtaInboundEmail(normalized) &&
		confirmationNumber &&
		!hasSourceField(normalized, "confirmationNumber")
	) {
		logReconcile("needs_review.ai_only_confirmation", {
			intent,
			eventType: normalized.eventType,
		});
		return {
			status: "needs_review",
			actionTaken: "skipped",
			skipReason: "confirmation_not_source_backed",
			automationComment:
				"The confirmation number was not deterministically extracted from the email; no reservation lookup or mutation was attempted.",
			warnings,
			errors: [
				...errors,
				"Reservation confirmation number is not source-backed.",
			],
		};
	}

	if (!confirmationNumber) {
		logReconcile("needs_review.missing_confirmation", {
			intent,
			eventType: normalized.eventType,
		});
		return {
			status: "needs_review",
			warnings,
			errors: [...errors, "A reservation email must include a confirmation number."],
		};
	}

	if (errors.some((error) => /missing sar exchange rate/i.test(error))) {
		const currencyWarning =
			"Missing SAR exchange rate; saved to OTA review with source amount metadata for manual pricing.";
		if (!warnings.includes(currencyWarning)) warnings.push(currencyWarning);
		logReconcile("continue.missing_currency_rate", {
			confirmationNumber,
			currency: normalized.currency || "",
		});
	}

	if (!hasKnownProvider(normalized)) {
		logReconcile("needs_review.unknown_provider", { confirmationNumber });
		return {
			status: "needs_review",
			actionTaken: "skipped",
			skipReason: "unknown_ota_provider_no_mutation",
			automationComment:
				"The OTA provider was not deterministically established; no reservation lookup or mutation was attempted.",
			warnings,
			errors: [
				...errors,
				"Could not safely determine the OTA provider identity namespace.",
			],
		};
	}

	const existing = await findReservationByOtaConfirmation(
		confirmationNumber,
		normalized.provider
	);
	const matchedReservationBy = existing
		? detectConfirmationMatchFields(
				existing,
				confirmationNumber,
				normalized.provider
		  )
		: [];
	logReconcile("existing.checked", {
		platformConfirmationNumber: confirmationNumber,
		found: !!existing,
		reservationId: existing?._id ? String(existing._id) : "",
		pmsConfirmationNumber: existing?.confirmation_number || "",
		hotelId: existing?.hotelId ? String(existing.hotelId) : "",
		matchedReservationBy,
	});

	if (existing && intent === "new_reservation" && !isStatusIntent && !isUpdateIntent) {
		const incomingAuthority = otaSourceAuthority(normalized);
		const existingAuthority = Number(
			existing?.supplierData?.otaSourceAuthority || 0
		);
		const existingPendingReview =
			existing?.otaPlatformReview?.status === "pending" ||
			[
				existing?.state,
				existing?.reservation_status,
			].some(
				(value) =>
					normalizeComparable(value) ===
					normalizeComparable(OTA_PLATFORM_REVIEW_RESERVATION_STATUS)
			);
		const authorityUpgrade = isAuthoritativeSourceUpgrade(
			incomingAuthority,
			existingAuthority,
		);
		const canAuthoritativelyRefresh =
			existingPendingReview &&
			authorityUpgrade &&
			requiredNewReservationMissing(normalized).length === 0;
		if (canAuthoritativelyRefresh) {
			normalized.authoritativeExistingRefresh = true;
			normalized.otaSourceAuthority = incomingAuthority;
			warnings.push(
				"A higher-authority direct OTA confirmation replaced lower-authority pending email facts before hotel release."
			);
			logReconcile("existing_new_booking.authoritative_refresh", {
				confirmationNumber,
				reservationId: String(existing._id),
				existingAuthority,
				incomingAuthority,
			});
		} else {
			logReconcile("duplicate_reservation.existing_new_booking", {
			confirmationNumber,
			reservationId: String(existing._id),
			pmsConfirmationNumber: existing.confirmation_number || "",
			hotelId: existing.hotelId ? String(existing.hotelId) : "",
			matchedReservationBy,
			});
			return {
				status: "duplicate_reservation",
				actionTaken: "skipped",
				skipReason: "duplicate_existing_reservation_no_update",
				automationComment:
					"New OTA reservation email matched an existing reservation by confirmation number; no reservation fields were changed.",
				warnings,
				errors,
				reservationId: existing._id,
				hotelId: existing.hotelId,
				pmsConfirmationNumber: existing.confirmation_number,
				matchedReservationBy,
			};
		}
	}

	if (!isStatusIntent && isOtaInboundTotalOutlier(normalized)) {
		const pricingError = `OTA inbound total ${round2(
			normalized.totalAmountSar
		)} SAR exceeds the ${MAX_OTA_INBOUND_RESERVATION_TOTAL_SAR} SAR safety limit; manual review is required.`;
		logReconcile("needs_review.total_outlier", {
			confirmationNumber,
			provider: normalized.provider || "unknown",
			totalAmountSar: round2(normalized.totalAmountSar),
			limitSar: MAX_OTA_INBOUND_RESERVATION_TOTAL_SAR,
		});
		return {
			status: "needs_review",
			actionTaken: "skipped",
			skipReason: "ota_inbound_total_outlier",
			automationComment: pricingError,
			warnings,
			errors: [...errors, pricingError],
			reservationId: existing?._id || null,
			hotelId: existing?.hotelId || null,
			pmsConfirmationNumber: existing?.confirmation_number || "",
			matchedReservationBy,
		};
	}

	const missingForCreate = requiredNewReservationMissing(normalized);
	const hasCompleteCreatePayload =
		!missingForCreate.length &&
		confirmationNumber &&
		(hasKnownProvider(normalized) || !!normalizeWhitespace(normalized.bookingSource));

	if (isStatusIntent) {
		if (!existing) {
			logReconcile("status.needs_review.no_exact_match", {
				confirmationNumber,
				statusToApply,
			});
			return {
				status: "needs_review",
				actionTaken: "skipped",
				skipReason: "status_email_no_exact_reservation_match",
				automationComment:
					"Status emails may only change an existing reservation with an exact confirmation match.",
				warnings,
				errors: [
					...errors,
					"Status email did not match an existing reservation by confirmation number.",
				],
			};
		}
		if (existing && !statusToApply) {
			logReconcile("status.needs_review.unknown_status", {
				confirmationNumber,
			});
			return {
				status: "needs_review",
				warnings,
				errors: [...errors, "Could not safely determine which status to apply."],
				reservationId: existing._id,
				hotelId: existing.hotelId,
				pmsConfirmationNumber: existing.confirmation_number,
				matchedReservationBy,
			};
		}
		if (existing) {
			logReconcile("status.update.start", {
				confirmationNumber,
				reservationId: String(existing._id),
				statusToApply,
			});
			const set = await applyExistingReservationEmailUpdate({
				normalized,
				existing,
				statusToApply,
				warnings,
				action: `${statusToApply}-from-email`,
			});
			logReconcile("status.update.done", {
				confirmationNumber,
				reservationId: String(existing._id),
				statusToApply,
				updatedFields: Object.keys(set),
			});
			return {
				status: statusToApply === "cancelled" ? "cancelled" : "status_updated",
				warnings,
				errors,
				reservationId: existing._id,
				hotelId: existing.hotelId,
				pmsConfirmationNumber: existing.confirmation_number,
				matchedReservationBy,
			};
		}
	}

	if (isUpdateIntent && !existing) {
		logReconcile("update.needs_review.no_exact_match", {
			confirmationNumber,
		});
		return {
			status: "needs_review",
			actionTaken: "skipped",
			skipReason: "update_email_no_exact_reservation_match",
			automationComment:
				"Update emails may only stage changes against an existing exact confirmation match.",
			warnings,
			errors: [
				...errors,
				"Update email did not match an existing reservation by confirmation number.",
			],
		};
	}

	const missing = missingForCreate;
	if (!existing && !isUpdateIntent && missing.length) {
		const hotelOnlyMissing =
			missing.length === 1 &&
			missing[0] === "source-backed hotel/property";
		logReconcile("create_unmapped.missing_non_identity_fields", {
			confirmationNumber,
			missing,
		});
		return createUnmappedOtaReviewReservation({
			normalized,
			confirmationNumber,
			warnings: [
				...warnings,
				`Missing reservation field(s): ${missing.join(", ")}. ${
					hotelOnlyMissing
						? "Saved as an unassigned OTA platform review pending hotel mapping."
						: "Held in the inbound audit; no reservation was created."
				}`,
			],
			errors,
			allowCreate: hotelOnlyMissing,
		});
	}

	if (
		!existing &&
		hasCompleteCreatePayload &&
		shouldUseExpediaInboundClientTotalFallback(normalized)
	) {
		const fallbackNetTotal = round2(
			normalized.totalAmountSar || normalized.amount || 0
		);
		const fallbackWarning =
			"Expedia inbound email did not include a captured payout; using the client total as net-after-OTA because Partner Central payout lookup was unavailable.";
		if (!warnings.includes(fallbackWarning)) warnings.push(fallbackWarning);
		normalized.warnings = Array.from(
			new Set([...(normalized.warnings || []), fallbackWarning])
		);
		normalized.totalPayoutSar = fallbackNetTotal;
		normalized.netAfterExpensesTotal = fallbackNetTotal;
		normalized.otaPayoutFallbackReason =
			"expedia_inbound_email_partner_central_unavailable";
		logReconcile("pricing.expedia_inbound_client_total_fallback", {
			confirmationNumber,
			provider: normalized.provider || "",
			paymentCollectionModel: normalized.paymentCollectionModel || "",
			totalAmountSar: fallbackNetTotal,
			sourceFrom: normalized.source?.from || "",
			inboundEmailId: normalized.inboundEmailId || "",
		});
	}

	const hotelDetails = await resolveHotel(
		normalized,
		normalized.authoritativeExistingRefresh ? null : existing
	);
	if (!hotelDetails) {
		logReconcile("needs_mapping.hotel", {
			confirmationNumber,
			hotelName: normalized.hotelName || "",
		});
		if (existing) {
			const partialWarnings = [
				...warnings,
				"Could not resolve hotel from inbound email; updated existing reservation with available non-room fields only.",
			];
			const set = await applyExistingReservationEmailUpdate({
				normalized,
				existing,
				statusToApply,
				warnings: partialWarnings,
				action: "updated-existing-partial-from-email",
			});
			logReconcile("update.partial.done", {
				confirmationNumber,
				reservationId: String(existing._id),
				reason: "hotel_not_resolved",
				updatedFields: Object.keys(set),
			});
			return {
				status: "updated",
				warnings: partialWarnings,
				errors,
				reservationId: existing._id,
				hotelId: existing.hotelId,
				pmsConfirmationNumber: existing.confirmation_number,
				matchedReservationBy,
			};
		}
		return createUnmappedOtaReviewReservation({
			normalized,
			confirmationNumber,
			warnings,
			errors,
			allowCreate: true,
		});
	}
	const manualHotelAssignmentReason = getManualOtaHotelAssignmentReason(
		normalized,
		hotelDetails
	);
	if (manualHotelAssignmentReason && existing) {
		logReconcile("existing.resolved_hotel_manual_assignment.continue", {
			confirmationNumber,
			reason: manualHotelAssignmentReason,
			resolvedHotelId: normalizeId(hotelDetails._id),
			hotelName: hotelDetails.hotelName || normalized.hotelName || "",
		});
	}
	if (manualHotelAssignmentReason && !existing) {
		const manualWarnings = withResolvedHotelManualAssignmentWarning(
			warnings,
			hotelDetails,
			manualHotelAssignmentReason
		);
		logReconcile("create_unmapped.resolved_hotel_manual_assignment", {
			confirmationNumber,
			reason: manualHotelAssignmentReason,
			resolvedHotelId: normalizeId(hotelDetails._id),
			hotelName: hotelDetails.hotelName || normalized.hotelName || "",
			activateHotel: hotelDetails.activateHotel,
			xHotelProActive: hotelDetails.xHotelProActive,
		});
		return createUnmappedOtaReviewReservation({
			normalized,
			confirmationNumber,
			warnings: manualWarnings,
			errors,
		});
	}

	const resolvedRoomMatch = await resolveRoomMatchWithAi(
		hotelDetails,
		normalized
	);
	const built = buildReservationDocument(normalized, hotelDetails, {
		roomMatch: resolvedRoomMatch,
	});
	if (!built.ok) {
		logReconcile("needs_mapping.room_or_pricing", {
			confirmationNumber,
			hotelId: String(hotelDetails._id),
			roomName: normalized.roomName || "",
			error: built.error,
		});
		if (existing) {
			const partialWarnings = [
				...warnings,
				`${built.error} Existing reservation was updated with available non-room fields only.`,
			];
			const set = await applyExistingReservationEmailUpdate({
				normalized,
				existing,
				statusToApply,
				warnings: partialWarnings,
				action: "updated-existing-partial-from-email",
			});
			logReconcile("update.partial.done", {
				confirmationNumber,
				reservationId: String(existing._id),
				hotelId: String(hotelDetails._id),
				reason: "room_or_pricing_not_resolved",
				updatedFields: Object.keys(set),
			});
			return {
				status: "updated",
				warnings: partialWarnings,
				errors,
				reservationId: existing._id,
				hotelId: hotelDetails._id,
				pmsConfirmationNumber: existing.confirmation_number,
				otaPlatformReviewStatus:
					set?.["otaPlatformReview.status"] ||
					existing?.otaPlatformReview?.status ||
					"",
				matchedReservationBy,
			};
		}
		return createUnmappedOtaReviewReservation({
			normalized,
			confirmationNumber,
			warnings: [
				...warnings,
				`${built.error} Held in the inbound audit; no reservation was created from an unresolved room or price.`,
			],
			errors,
		});
	}
	(built.warnings || []).forEach((warning) => {
		if (warning && !warnings.includes(warning)) warnings.push(warning);
	});

	let document;
	try {
		document = await normalizeBuiltReservationDocument(built.document, warnings);
	} catch (error) {
		logReconcile("needs_mapping.pricing_error", {
			confirmationNumber,
			hotelId: String(hotelDetails._id),
			error: error.message,
		});
		if (existing) {
			const partialWarnings = [
				...warnings,
				`${error.message || "Could not calculate reservation pricing."} Existing reservation was updated with available non-pricing fields only.`,
			];
			const set = await applyExistingReservationEmailUpdate({
				normalized,
				existing,
				statusToApply,
				warnings: partialWarnings,
				action: "updated-existing-partial-from-email",
			});
			logReconcile("update.partial.done", {
				confirmationNumber,
				reservationId: String(existing._id),
				hotelId: String(hotelDetails._id),
				reason: "pricing_error",
				updatedFields: Object.keys(set),
			});
			return {
				status: "updated",
				warnings: partialWarnings,
				errors,
				reservationId: existing._id,
				hotelId: hotelDetails._id,
				pmsConfirmationNumber: existing.confirmation_number,
				otaPlatformReviewStatus:
					set?.["otaPlatformReview.status"] ||
					existing?.otaPlatformReview?.status ||
					"",
				matchedReservationBy,
			};
		}
		return createUnmappedOtaReviewReservation({
			normalized,
			confirmationNumber,
			warnings: [
				...warnings,
				`${error.message || "Could not calculate reservation pricing."} Held in the inbound audit; no reservation was created from unresolved pricing.`,
			],
			errors,
		});
	}
	if (existing) {
		logReconcile("update.start", {
			confirmationNumber,
			reservationId: String(existing._id),
			hotelId: String(hotelDetails._id),
			totalAmount: document.total_amount,
			payment: document.payment,
			financeStatus: document.financeStatus,
		});
		const set = await applyExistingReservationEmailUpdate({
			normalized,
			existing,
			statusToApply,
			warnings,
			action: "updated-from-email",
			document,
		});
		logReconcile("update.done", {
			confirmationNumber,
			reservationId: String(existing._id),
			hotelId: String(hotelDetails._id),
			updatedFields: Object.keys(set),
		});
		return {
			status: "updated",
			warnings,
			errors,
			reservationId: existing._id,
			hotelId: hotelDetails._id,
			pmsConfirmationNumber: existing.confirmation_number,
			otaPlatformReviewStatus:
				set?.["otaPlatformReview.status"] ||
				existing?.otaPlatformReview?.status ||
				"",
			matchedReservationBy,
		};
	}

	const existingBeforeCreate = await findReservationByOtaConfirmation(
		confirmationNumber,
		normalized.provider,
		"_id hotelId confirmation_number otaIdentityKey reservation_id customer_details supplierData"
	);
	if (existingBeforeCreate) {
		const lateMatchedBy = detectConfirmationMatchFields(
			existingBeforeCreate,
			confirmationNumber,
			normalized.provider
		);
		logReconcile("duplicate_reservation.pre_create_recheck", {
			confirmationNumber,
			reservationId: String(existingBeforeCreate._id),
			matchedReservationBy: lateMatchedBy,
		});
		return {
			status: "duplicate_reservation",
			warnings,
			errors: [
				...errors,
				"Existing reservation matched during pre-create duplicate check; no new reservation was created.",
			],
			reservationId: existingBeforeCreate._id,
			hotelId: existingBeforeCreate.hotelId,
			pmsConfirmationNumber: existingBeforeCreate.confirmation_number,
			matchedReservationBy: lateMatchedBy,
		};
	}

	document.reservationAuditLog = [
		buildAuditEntry(
			normalized,
			normalized.source?.from === "expedia-sync"
				? "created-from-expedia-sync"
				: "created-from-email",
			warnings
		),
	];
	// The queue prevents local overlap; this key also protects across processes.
	document.otaIdentityKey = buildOtaIdentityKey(
		normalized.provider,
		confirmationNumber
	);
	applyVccSafeFieldsToDocument(document, normalized);
	document.confirmation_number = await generateUniquePmsConfirmationNumber();
	document.customer_details = {
		...(document.customer_details || {}),
		confirmation_number2: confirmationNumber,
	};
	document.supplierData = {
		...(document.supplierData || {}),
		suppliedBookingNo: confirmationNumber,
		otaConfirmationNumber: confirmationNumber,
		platformConfirmationNumber: confirmationNumber,
		pmsConfirmationNumber: document.confirmation_number,
		otaCreatedFromEmail: normalized.source?.from !== "expedia-sync",
		otaCreatedFromSync: normalized.source?.from === "expedia-sync",
		otaInboundEmailId: normalized.inboundEmailId || "",
		otaCreatedAt: new Date(),
	};
	let created;
	for (let createAttempt = 0; createAttempt < 2; createAttempt += 1) {
		try {
			logReconcile("create.start", {
				platformConfirmationNumber: confirmationNumber,
				pmsConfirmationNumber: document.confirmation_number,
				hotelId: String(hotelDetails._id),
				totalAmount: document.total_amount,
				totalRooms: document.total_rooms,
				payment: document.payment,
				financeStatus: document.financeStatus,
				sourceCurrency: normalized.currency || "",
				exchangeRateToSar: normalized.exchangeRateToSar || 0,
			});
			created = await createReservationWithAvailabilitySnapshot(
				document,
				normalized.source?.from === "expedia-sync"
					? "ota_sync_create"
					: "ota_email_create"
			);
			break;
		} catch (error) {
			if (error?.code === 11000) {
				logReconcile("create.duplicate_key", {
					platformConfirmationNumber: confirmationNumber,
					pmsConfirmationNumber: document.confirmation_number,
				});
				const duplicate = await findReservationByOtaConfirmation(
					confirmationNumber,
					normalized.provider,
					"_id hotelId confirmation_number otaIdentityKey"
				);
				if (duplicate) {
					const duplicateMatchedBy = detectConfirmationMatchFields(
						duplicate,
						confirmationNumber,
						normalized.provider
					);
					return {
						status: "duplicate_reservation",
						warnings,
						errors: [
							...errors,
							"Existing reservation matched during duplicate-key recovery; no new reservation was created.",
						],
						reservationId: duplicate?._id || null,
						hotelId: duplicate?.hotelId || hotelDetails._id,
						pmsConfirmationNumber: duplicate?.confirmation_number || "",
						matchedReservationBy: duplicateMatchedBy,
					};
				}
				if (createAttempt === 0) {
					document.confirmation_number = await generateUniquePmsConfirmationNumber();
					document.supplierData.pmsConfirmationNumber = document.confirmation_number;
					continue;
				}
			}
			throw error;
		}
	}
	logReconcile("create.done", {
		platformConfirmationNumber: confirmationNumber,
		pmsConfirmationNumber: created.confirmation_number,
		reservationId: String(created._id),
		hotelId: String(hotelDetails._id),
	});
	return {
		status: "created",
		warnings,
		errors,
		reservationId: created._id,
		hotelId: hotelDetails._id,
		pmsConfirmationNumber: created.confirmation_number,
		otaPlatformReviewStatus: created?.otaPlatformReview?.status || "",
		matchedReservationBy: [],
	};
}

async function reconcileOtaReservation(inputNormalized) {
	const input = inputNormalized || {};
	if (input.intent === "not_reservation") {
		return {
			status: "not_reservation",
			warnings: [...(input.warnings || [])],
			errors: [...(input.errors || [])],
			actionTaken: "skipped",
			skipReason: input.skipReason || "not_reservation",
		};
	}
	const confirmationNumber = normalizeConfirmation(
		input.confirmationNumber || input.reservationId
	);
	return enqueueOtaReservationWork(
		() => reconcileOtaReservationUnqueued(input),
		{
			confirmationNumber,
			provider: input.provider || "unknown",
			source: input.source?.from || "ota",
		}
	);
}

function buildUnmappedOtaReviewReservationDocument(normalized = {}) {
	const totalAmountSar = round2(
		normalized.totalAmountSar || normalized.amount || 0
	);
	const providerLabel =
		normalized.bookingSource ||
		(normalized.providerLabel && normalized.providerLabel !== "unknown"
			? normalized.providerLabel
			: "OTA Email");
	const paymentSummary = safeOtaPaymentSummary(normalized.paymentSummary);
	const sourceCurrency =
		normalized.sourceCurrency ||
		paymentSummary.sourceCurrency ||
		normalized.currency ||
		"";
	const sourceAmount = Number(
		normalized.sourceAmount ||
			paymentSummary.sourceTotalGuestPaymentAmount ||
			normalized.amount ||
			0
	);
	const sourceExchangeRateToSar = Number(
		normalized.sourceExchangeRateToSar ||
			paymentSummary.exchangeRateToSar ||
			(String(sourceCurrency || "").toUpperCase() === "SAR"
				? normalized.exchangeRateToSar || 1
				: 0)
	);
	const sourceExchangeRateSource =
		normalized.sourceExchangeRateSource ||
		paymentSummary.exchangeRateSource ||
		normalized.exchangeRateSource ||
		"";
	const defaultDeductionRate = resolveOtaReviewDeductionRate(normalized);
	const explicitNetAfterExpenses = round2(
		normalized.totalPayoutSar ||
			normalized.netAfterExpensesTotal ||
			paymentSummary.totalPayoutAmount ||
			0
	);
	const netAfterExpensesTotal =
		explicitNetAfterExpenses > 0
			? round2(Math.min(explicitNetAfterExpenses, totalAmountSar || explicitNetAfterExpenses))
			: defaultOtaReviewNetTotal(totalAmountSar, defaultDeductionRate);
	const otaExpenseTotal = Math.max(0, round2(totalAmountSar - netAfterExpensesTotal));
	const roomCount = Math.max(1, Math.floor(Number(normalized.roomCount || 1)));
	const dateRange = generateDateRange(
		normalized.checkinDate,
		normalized.checkoutDate
	);
	const daysOfResidence =
		dateRange.length ||
		calculateDaysOfResidence(normalized.checkinDate, normalized.checkoutDate);
	const slots = Math.max(1, dateRange.length * roomCount);
	const clientSlots = allocateAmountAcrossSlots(totalAmountSar, slots);
	const netSlots = allocateAmountAcrossSlots(
		netAfterExpensesTotal || totalAmountSar,
		slots
	);
	let slotIndex = 0;
	const roomDisplayName =
		normalizeWhitespace(normalized.roomName || "") || "Unmapped OTA room";
	const mappedRoomType = mapRoomType(roomDisplayName) || "";
	const pickedRoomsType = Array.from({ length: roomCount }, () => {
		const pricingByDay = dateRange.map((ymd) => {
			const currentSlot = slotIndex;
			slotIndex += 1;
			const clientPrice = round2(clientSlots[currentSlot] || 0);
			const netAfterExpenses = round2(netSlots[currentSlot] || clientPrice);
			return {
				date: ymd,
				price: clientPrice,
				clientPrice,
				mainPrice: clientPrice,
				rootPrice: 0,
				commissionRate: 0,
				totalPriceWithCommission: clientPrice,
				totalPriceWithoutCommission: 0,
				netAfterExpenses,
				netAfterOtaExpenses: netAfterExpenses,
				otaExpenseAmount: Math.max(0, round2(clientPrice - netAfterExpenses)),
				platformMargin: 0,
				platformMarginRate: 0,
			};
		});
		return {
			room_type: mappedRoomType,
			displayName: roomDisplayName,
			chosenPrice:
				daysOfResidence > 0
					? round2(totalAmountSar / Math.max(1, daysOfResidence * roomCount))
					: totalAmountSar,
			count: 1,
			pricingByDay,
			totalPriceWithCommission: round2(
				pricingByDay.reduce(
					(sum, day) => sum + Number(day.totalPriceWithCommission || 0),
					0
				)
			),
			hotelShouldGet: 0,
		};
	});
	const paymentMapping = resolvePaymentMapping(
		normalized,
		totalAmountSar,
		0,
		0
	);
	const guestComment = cleanOtaGuestNote(
		normalized.comment || normalized.guestNotes || ""
	);
	const now = new Date();
	const automationSource =
		normalized.source?.from === "expedia-sync" ? "ota_sync_create" : "ota_email_create";
	const automationPipeline =
		normalized.source?.from === "expedia-sync"
			? "ota-reservation-sync-orchestrator"
			: "ota-email-orchestrator";

	return {
		reservation_id: normalized.reservationId,
		booking_source: providerLabel,
		customer_details: {
			booking_source: providerLabel,
			name: normalized.guestName || "",
			phone: normalized.guestPhone || "0000",
			email: normalized.guestEmail || "no-email@jannatbooking.com",
			passport: "Not Provided",
			passportExpiry: "1/1/2027",
			nationality: normalized.nationality || "",
			postalCode: "00000",
			confirmation_number2: normalized.confirmationNumber,
		},
		state: OTA_PLATFORM_REVIEW_RESERVATION_STATUS,
		reservation_status: OTA_PLATFORM_REVIEW_RESERVATION_STATUS,
		total_guests: Number(normalized.totalGuests || 1),
		adults: Number(normalized.adults || 0),
		children: Number(normalized.children || 0),
		cancel_reason: "",
		booked_at: normalized.bookedAt || now,
		sub_total: 0,
		total_rooms: roomCount,
		total_amount: totalAmountSar,
		currency: "SAR",
		checkin_date: normalized.checkinDate,
		checkout_date: normalized.checkoutDate,
		days_of_residence: daysOfResidence,
		comment: guestComment,
		booking_comment: guestComment,
		financeStatus: paymentMapping.financeStatus,
		payment: paymentMapping.payment,
		payment_details: {
			captured: false,
			onsite_paid_amount: 0,
		},
		paid_amount: paymentMapping.paidAmount,
		paid_amount_breakdown: paymentMapping.paidAmountBreakdown,
		commission: 0,
		financial_cycle: paymentMapping.financialCycle,
		pickedRoomsType,
		pickedRoomsPricing: pickedRoomsType,
		adminPricing: {
			mode: "ota_platform_unmapped",
			clientTotal: totalAmountSar,
			rootTotal: 0,
			netAfterExpensesTotal,
			otaExpenseTotal,
			platformMarginTotal: 0,
			commissionAmount: 0,
			defaultDeductionRate,
			defaultDeductionApplied: explicitNetAfterExpenses <= 0,
			source: automationSource,
			provider: normalized.provider,
			providerLabel,
			sourceCurrency,
			sourceAmount: round2(sourceAmount),
			sourceExchangeRateToSar,
			sourceExchangeRateSource,
			exchangeRateToSar:
				sourceExchangeRateToSar || normalized.exchangeRateToSar || 0,
			exchangeRateSource:
				sourceExchangeRateSource || normalized.exchangeRateSource || "",
			amountConvertedAt: normalized.amountConvertedAt || "",
			payoutFallbackReason: normalized.otaPayoutFallbackReason || "",
			hotelAssignmentRequired: true,
		},
		adminPricingVisibility: {
			rootOnlyForHotelManagement: true,
			source: automationSource,
			appliedAt: now,
			appliedBy: null,
		},
		ota_financial_summary: {
			show: true,
			source: automationSource,
			provider: normalized.provider,
			providerLabel,
			currency: "SAR",
			clientTotal: totalAmountSar,
			hotelVisibleAmount: 0,
			netAfterExpenses: netAfterExpensesTotal,
			netAfterOtaExpenses: netAfterExpensesTotal,
			otaExpenseTotal,
			platformProfit: 0,
			commissionAmount: 0,
			sourceCurrency,
			sourceAmount: round2(sourceAmount),
			sourceExchangeRateToSar,
			sourceExchangeRateSource,
			paymentSummary,
			payoutFallbackReason: normalized.otaPayoutFallbackReason || "",
		},
		otaPlatformReview: {
			...buildOtaReviewSnapshot({
				source: automationSource,
				inboundEmailId: normalized.inboundEmailId,
				provider: normalized.provider,
				providerLabel,
				confirmationNumber: normalized.confirmationNumber,
			}),
			hotelAssignmentRequired: true,
			hotelAssignmentStatus: "missing",
			originalHotelName: normalized.hotelName || "",
			otaRoomName: normalized.roomName || "",
			lastUpdatedAt: now,
		},
		supplierData: {
			supplierName: providerLabel,
			suppliedBookingNo: normalized.confirmationNumber,
			otaConfirmationNumber: normalized.confirmationNumber,
			platformConfirmationNumber: normalized.confirmationNumber,
			otaAutomationPipeline: automationPipeline,
			otaProvider: normalized.provider,
			otaHotelName: normalized.hotelName || "",
			otaHotelMappingRequired: true,
			otaRoomName: normalized.roomName || "",
			otaGuestNotes: guestComment,
			otaNationality: normalized.nationality || "",
			otaCurrency: normalized.currency || "",
			otaAmount: normalized.amount || 0,
			otaAmountSar: totalAmountSar,
			otaSourceCurrency: sourceCurrency,
			otaSourceAmount: round2(sourceAmount),
			otaSourceAmountHint: normalized.sourceAmountHint || normalized.amountHint || "",
			otaSourceExchangeRateToSar: sourceExchangeRateToSar,
			otaSourceExchangeRateSource: sourceExchangeRateSource,
			otaPaymentSummary: paymentSummary,
			otaPayoutFallbackReason: normalized.otaPayoutFallbackReason || "",
			otaTotalPayoutSar: netAfterExpensesTotal,
			otaExpenseTotalSar: otaExpenseTotal,
			otaPlatformMarginSar: 0,
			otaExchangeRateToSar: normalized.exchangeRateToSar || 0,
			otaExchangeRateSource: normalized.exchangeRateSource || "",
			otaAmountConvertedAt: normalized.amountConvertedAt || "",
			otaPaymentCollectionModel: normalized.paymentCollectionModel || "",
			otaPaymentInstructions: normalized.paymentInstructions || "",
			otaLastInboundEmailId: normalized.inboundEmailId || "",
			otaLastEmailAt: now,
			otaLastEventType: normalized.eventType,
			otaAirbnbListingId: normalized.airbnbListingId || "",
			otaAirbnbListingTitle: normalized.airbnbListingTitle || "",
			otaNormalizedSnapshot: {
				provider: normalized.provider || "",
				confirmationNumber: normalized.confirmationNumber || "",
				hotelName: normalized.hotelName || "",
				roomName: normalized.roomName || "",
				checkinDate: normalized.checkinDate || "",
				checkoutDate: normalized.checkoutDate || "",
				totalAmountSar,
				totalGuests: normalized.totalGuests || 0,
				adults: normalized.adults || 0,
				children: normalized.children || 0,
				airbnbListingId: normalized.airbnbListingId || "",
				airbnbListingTitle: normalized.airbnbListingTitle || "",
			},
		},
	};
}

module.exports = {
	PROVIDER_LABELS,
	normalizeRow,
	pick,
	n,
	countNumber,
	parseDate,
	parseMoney,
	toSarAmount,
	getSarExchangeRate,
	getSarConversionMeta,
	getSarConversionMetaAsync,
	applyLiveSarConversion,
	htmlToText,
	redactSensitive,
	safeSnippet,
	hashText,
	normalizeWhitespace,
	normalizeComparable,
	explicitHotelNameAliases,
	expandHotelNameCandidates,
	normalizeConfirmation,
	buildOtaIdentityKey,
	buildOtaConfirmationLookup,
	detectConfirmationMatchFields,
	detectProvider,
	detectEventType,
	detectStatusToApply,
	detectReservationIntent,
	detectPaymentCollectionModel,
	resolveBookingSource,
	extractNormalizedReservation,
	reconcileOtaReservation,
	buildReservationDocument,
	resolvePaymentMapping,
	resolveHotel,
	resolveRoomMatch,
	resolveRoomMatchWithAi,
	resolveRoomDetails,
	requiredNewReservationMissing,
	canCreateUnmappedOtaReviewReservation,
	buildUnmappedOtaReviewReservationDocument,
	buildExistingReservationUpdateSet,
	explicitRoomCapacity,
	findConfidentFuzzyHotelMatch,
	isAuthoritativeSourceUpgrade,
	otaSourceAuthority,
	normalizeStatusToApply,
	calculateDaysOfResidence,
	generateDateRange,
	findReservationByOtaConfirmation,
	detectConfirmationMatchFields,
	generateUniquePmsConfirmationNumber,
	getOtaInboundAllowedHotelIds,
	isHotelAllowedForOtaInbound,
	isOtaInboundTotalOutlier,
	isPlausibleOtaGuestName,
	isPlausibleOtaRoomName,
	getSarConversionMeta,
};
