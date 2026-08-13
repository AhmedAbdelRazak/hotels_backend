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
const {
	hasActiveHotelRunnerLifecycleAuthority,
	hasDirectHotelRunnerProjection,
	normalizeMarker,
} = require("./hotelrunnerOtaEmailBoundary");
const {
	buildAuthenticatedProviderCommercialEvidence,
	validateOtaCommercialEvidence,
	withHotelBaseCommercialEvidence,
} = require("./otaCommercialEvidence");
const {
	decimalMoneyCents,
	multipliedMoneyCents,
	roundedMoneyProduct,
} = require("./otaMoney");
const {
	hashStable: canonicalHotelRunnerFallbackHash,
} = require("./hotelrunnerFirstOtaFallbackCanonical");
const {
	applyHotelRunnerFirstFallbackCreationMarker,
	reservationHasExactHotelRunnerFirstFallbackCreationMarker,
} = require("./hotelrunnerFirstOtaFallbackProvenance");
const {
	authorizeHotelRunnerFirstFallbackEmailCreation,
	commitHotelRunnerFirstFallbackEmailCreation,
	releaseHotelRunnerFirstFallbackEmailCreation,
	validateHotelRunnerFallbackCreationAuthorization,
} = require("./hotelrunnerFallbackIngressGate");

dayjs.extend(customParseFormat);

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
// Resource-safety ceilings only. They do not represent hotel inventory or an
// overbooking policy; they bound object/array allocation from one inbound email.
const MAX_OTA_INBOUND_ROOM_COUNT = 250;
const MAX_OTA_INBOUND_ROOM_NIGHT_SLOTS = 20000;

const MONEY_CURRENCY_CODES = Array.from(
	new Set(
		`AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BRL BSD BTN BWP BYN BZD CAD CDF CHF CLP CNY COP CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD HKD HNL HRK HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD MMK MNT MOP MRU MUR MVR MWK MXN MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD UYU UZS VES VND VUV WST XAF XCD XOF XPF YER ZAR ZMW ZWG`.split(
			/\s+/
		)
	)
);
const EXCHANGE_RATE_CACHE_TTL_MS = Number(
	process.env.OTA_EXCHANGE_RATE_CACHE_TTL_MS || 6 * 60 * 60 * 1000
);
const MAX_LIVE_EXCHANGE_RATE_SOURCE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_LIVE_EXCHANGE_RATE_FUTURE_SKEW_MS = 5 * 60 * 1000;
const exchangeRateCache = new Map();
const TRUSTED_EXCHANGE_RATE_PROVIDER = "exchange_rate_api";
const TRUSTED_EXCHANGE_RATE_SOURCE_TYPE = "trusted_exchange_evidence";
const AGODA_MULTI_ROOM_ALLOCATION_REVIEW_REASON =
	"Agoda email contains multiple rooms; automatic partial-room creation is disabled and the booking requires room review.";

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

function containsConfiguredZadAjyadAlias(value = "") {
	const normalized = normalizeAjyadComparable(value);
	const hasZad =
		/\b(?:zad|zyd)\b/i.test(normalized) || normalized.includes("زاد");
	const hasAjyad =
		/\b(?:ajyad|agyad)\b/i.test(normalized) || normalized.includes("اجياد");
	return hasZad && hasAjyad;
}

function containsStandaloneAjyadHotelSegment(value = "") {
	return String(value || "")
		.split(/\s*(?:[-–—·|]|::)\s*/u)
		.map((segment) => normalizeAjyadComparable(segment))
		.some((segment) => /^(?:ajyad|agyad)(?: hotel)?$/i.test(segment));
}

function normalizedReservationContainsConfiguredZadAjyadAlias(normalized = {}) {
	const sourceBackedHotelValues = hasSourceField(normalized, "hotelName")
		? [
				normalized.hotelName,
				...(Array.isArray(normalized.hotelNameAliases)
					? normalized.hotelNameAliases
					: []),
		  ].filter(Boolean)
		: [];
	// Once the OTA supplied a hotel identity, only that identity and aliases
	// derived from it may select the configured hotel. A different PMS hotel
	// name in a subject/footer/support sentence is not an override.
	const candidates = sourceBackedHotelValues.length
		? sourceBackedHotelValues
		: [normalized.source?.subject];
	return candidates
		.filter(Boolean)
		.some((value) => containsConfiguredZadAjyadAlias(value));
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
		"Zad Ajyad Hotel",
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

function multiplyMoney2(left, right) {
	const product = roundedMoneyProduct(left, right);
	return product === null
		? round2(Number(left || 0) * Number(right || 0))
		: product;
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

function allocateWeightedAmountAcrossSlots(totalAmount, rawWeights = []) {
	const targetCents = Math.round(Number(totalAmount || 0) * 100);
	const weights = (Array.isArray(rawWeights) ? rawWeights : []).map((value) =>
		Number(value)
	);
	const weightTotal = weights.reduce((sum, value) => sum + value, 0);
	if (
		targetCents < 0 ||
		!weights.length ||
		weights.some((value) => !Number.isFinite(value) || value < 0) ||
		!Number.isFinite(weightTotal) ||
		weightTotal <= 0
	) {
		return [];
	}

	const exactCents = weights.map(
		(weight) => (targetCents * weight) / weightTotal
	);
	const allocatedCents = exactCents.map((value) => Math.floor(value + 1e-9));
	let remainder = targetCents - allocatedCents.reduce((sum, value) => sum + value, 0);
	const order = exactCents
		.map((value, index) => ({
			index,
			remainder: value - Math.floor(value + 1e-9),
		}))
		.sort((left, right) =>
			right.remainder !== left.remainder
				? right.remainder - left.remainder
				: left.index - right.index
		);
	for (let index = 0; remainder > 0; index += 1) {
		allocatedCents[order[index % order.length].index] += 1;
		remainder -= 1;
	}
	return allocatedCents.map((value) => value / 100);
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

function hashHotelRunnerFallbackValue(value) {
	try {
		return canonicalHotelRunnerFallbackHash(value);
	} catch (_error) {
		return "";
	}
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
	out = out.replace(/\b(?:\d[ -]*?){15,19}\b/g, (match, offset, source) => {
		const clean = String(match).replace(/\D/g, "");
		const prefix = String(source || "").slice(Math.max(0, offset - 100), offset);
		const isLabeledReservationIdentity =
			/(?:confirmation|reservation|booking|reference|ref|voucher|itinerary|trip)\s*(?:number|no\.?|id|code|#)?\s*[:#-]?\s*$/i.test(
				prefix
			);
		if (clean.length >= 15 && isLabeledReservationIdentity) return match;
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

function moneyCurrencyPattern() {
	return [
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
}

function moneyValuePattern() {
	return `(?:(?:${moneyCurrencyPattern()})\\s*)?${moneyNumberPattern()}`;
}

function parseMoneyCandidates(value) {
	const source = normalizeWhitespace(value);
	if (!source) return [];

	const currencyPattern = moneyCurrencyPattern();
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
	return { code, rate: null, source: "missing" };
}

async function fetchWithHardTimeout(
	url,
	{ fetchImpl = fetch, timeoutMs = 8000, responseReader = null } = {}
) {
	const boundedTimeoutMs = Math.max(1, Number(timeoutMs || 8000));
	const controller =
		typeof AbortController === "function" ? new AbortController() : null;
	let timeoutHandle;
	const timeoutPromise = new Promise((resolve, reject) => {
		timeoutHandle = setTimeout(() => {
			if (controller) controller.abort();
			const error = new Error(
				`Exchange-rate request exceeded ${boundedTimeoutMs}ms.`
			);
			error.code = "OTA_EXCHANGE_RATE_TIMEOUT";
			reject(error);
		}, boundedTimeoutMs);
	});
	try {
		const requestPromise = (async () => {
			const response = await fetchImpl(url, {
				timeout: boundedTimeoutMs,
				...(controller ? { signal: controller.signal } : {}),
			});
			return typeof responseReader === "function"
				? responseReader(response)
				: response;
		})();
		return await Promise.race([
			requestPromise,
			timeoutPromise,
		]);
	} finally {
		clearTimeout(timeoutHandle);
	}
}

function normalizedExchangeRateTimestamp(value, fallback) {
	const parsed = value instanceof Date ? value : new Date(value);
	if (Number.isFinite(parsed.getTime())) return parsed.toISOString();
	const fallbackDate = fallback instanceof Date ? fallback : new Date(fallback);
	return Number.isFinite(fallbackDate.getTime())
		? fallbackDate.toISOString()
		: new Date().toISOString();
}

function validatedLiveExchangeRateTimestamp(value, fetchedAtMs) {
	const parsed = value instanceof Date ? value : new Date(value);
	const timestampMs = parsed.getTime();
	if (
		!Number.isFinite(timestampMs) ||
		!Number.isFinite(fetchedAtMs) ||
		timestampMs > fetchedAtMs + MAX_LIVE_EXCHANGE_RATE_FUTURE_SKEW_MS ||
		fetchedAtMs - timestampMs > MAX_LIVE_EXCHANGE_RATE_SOURCE_AGE_MS
	) {
		return "";
	}
	return parsed.toISOString();
}

function trustedExchangeRateEvidence({
	sourceCurrency,
	propertyCurrency = "SAR",
	rate,
	sourceTimestamp,
} = {}) {
	const from = String(sourceCurrency || "")
		.trim()
		.toUpperCase();
	const to = String(propertyCurrency || "")
		.trim()
		.toUpperCase();
	const normalizedRate = Number(Number(rate).toFixed(10));
	const sourceDate =
		sourceTimestamp instanceof Date
			? sourceTimestamp
			: new Date(sourceTimestamp);
	if (
		!(/^[A-Z]{3}$/.test(from) && /^[A-Z]{3}$/.test(to)) ||
		!Number.isFinite(normalizedRate) ||
		normalizedRate <= 0 ||
		normalizedRate > 1_000_000 ||
		!Number.isFinite(sourceDate.getTime())
	) {
		return null;
	}
	const timestamp = sourceDate.toISOString();
	const sanitizedSourceTuple = {
		provider: TRUSTED_EXCHANGE_RATE_PROVIDER,
		sourceType: TRUSTED_EXCHANGE_RATE_SOURCE_TYPE,
		sourceCurrency: from,
		propertyCurrency: to,
		rate: normalizedRate,
		sourceTimestamp: timestamp,
	};
	const sourceHash = crypto
		.createHash("sha256")
		.update(JSON.stringify(sanitizedSourceTuple), "utf8")
		.digest("hex");
	return {
		trusted: true,
		verified: true,
		sourceCurrency: from,
		propertyCurrency: to,
		rate: normalizedRate,
		provenance: {
			provider: TRUSTED_EXCHANGE_RATE_PROVIDER,
			sourceType: TRUSTED_EXCHANGE_RATE_SOURCE_TYPE,
			sourceHash,
			sourceTimestamp: timestamp,
			sourceId: `exchange-rate-api-${from.toLowerCase()}-${to.toLowerCase()}-${sourceHash.slice(
				0,
				24
			)}`,
		},
	};
}

function validatedTrustedExchangeRateEvidence(
	value,
	{ sourceCurrency = "", propertyCurrency = "SAR", rate = null } = {}
) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	if (value.trusted !== true || value.verified !== true) return null;
	const expected = trustedExchangeRateEvidence({
		sourceCurrency: value.sourceCurrency,
		propertyCurrency: value.propertyCurrency,
		rate: value.rate,
		sourceTimestamp: value.provenance?.sourceTimestamp,
	});
	if (!expected) return null;
	if (
		(sourceCurrency &&
			expected.sourceCurrency !==
				String(sourceCurrency).trim().toUpperCase()) ||
		(propertyCurrency &&
			expected.propertyCurrency !==
				String(propertyCurrency).trim().toUpperCase()) ||
		(rate !== null &&
			rate !== undefined &&
			Math.abs(expected.rate - Number(rate)) > 0.0000000001) ||
		value.provenance?.provider !== expected.provenance.provider ||
		value.provenance?.sourceType !== expected.provenance.sourceType ||
		value.provenance?.sourceHash !== expected.provenance.sourceHash ||
		value.provenance?.sourceId !== expected.provenance.sourceId
	) {
		return null;
	}
	return expected;
}

function cloneLiveExchangeRate(value = {}, source = value.source) {
	return {
		...value,
		source,
		currencyConversionEvidence: value.currencyConversionEvidence
			? {
					...value.currencyConversionEvidence,
					provenance: {
						...value.currencyConversionEvidence.provenance,
					},
			  }
			: null,
	};
}

function boundedExchangeRateErrorCode(error) {
	const marker = String(
		error?.code || error?.name || "exchange_rate_request_failed"
	)
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "_")
		.slice(0, 80);
	return marker || "exchange_rate_request_failed";
}

async function fetchLiveSarExchangeRate(
	currency,
	{
		apiKey = process.env.EXCHANGE_RATE,
		fetchImpl = fetch,
		now = Date.now,
		cache = exchangeRateCache,
		timeoutMs = 8000,
	} = {}
) {
	const code =
		String(currency || "SAR")
			.trim()
			.toUpperCase() || "SAR";
	if (!code || code === "SAR") {
		return { code: "SAR", rate: 1, source: "identity" };
	}
	const credential = String(apiKey || "").trim();
	if (!credential) return null;
	const nowValue = typeof now === "function" ? now() : now;
	const nowDate = nowValue instanceof Date ? nowValue : new Date(nowValue);
	const nowMs = Number.isFinite(nowDate.getTime())
		? nowDate.getTime()
		: Date.now();

	const cached = cache?.get?.(code);
	const cachedAtMs = new Date(cached?.fetchedAt || 0).getTime();
	const cachedEvidence = validatedTrustedExchangeRateEvidence(
		cached?.currencyConversionEvidence,
		{
			sourceCurrency: code,
			propertyCurrency: "SAR",
			rate: cached?.rate,
		}
	);
	if (
		cached &&
		Number.isFinite(cachedAtMs) &&
		nowMs - cachedAtMs >= 0 &&
		nowMs - cachedAtMs < EXCHANGE_RATE_CACHE_TTL_MS &&
		cachedEvidence &&
		validatedLiveExchangeRateTimestamp(
			cachedEvidence.provenance.sourceTimestamp,
			nowMs
		)
	) {
		return cloneLiveExchangeRate({
			code,
			rate: cachedEvidence.rate,
			source: "exchange_rate_api_cached",
			fetchedAt: cached.fetchedAt,
			sourceTimestamp: cachedEvidence.provenance.sourceTimestamp,
			currencyConversionEvidence: cachedEvidence,
		});
	}

	try {
		const responsePayload = await fetchWithHardTimeout(
			`https://v6.exchangerate-api.com/v6/${credential}/pair/${encodeURIComponent(
				code
			)}/SAR/`,
			{
				fetchImpl,
				timeoutMs,
				responseReader: async (response) => ({
					response,
					data:
						response?.ok === false ? null : await response.json(),
				}),
			}
		);
		const { response, data } = responsePayload;
		if (response?.ok === false) return null;
		const rate = Number(data?.conversion_rate);
		const responseSourceCurrency = String(data?.base_code || "")
			.trim()
			.toUpperCase();
		const responsePropertyCurrency = String(data?.target_code || "")
			.trim()
			.toUpperCase();
		const fetchedAt = new Date(nowMs).toISOString();
		const serviceTimestamp = Number(data?.time_last_update_unix);
		const sourceTimestamp =
			Number.isFinite(serviceTimestamp) && serviceTimestamp > 0
				? validatedLiveExchangeRateTimestamp(
						new Date(serviceTimestamp * 1000),
						nowMs
				  )
				: "";
		const evidence = trustedExchangeRateEvidence({
			sourceCurrency: code,
			propertyCurrency: "SAR",
			rate,
			sourceTimestamp,
		});
		if (
			data?.result === "success" &&
			responseSourceCurrency === code &&
			responsePropertyCurrency === "SAR" &&
			evidence
		) {
			const live = {
				code,
				rate: evidence.rate,
				source: "exchange_rate_api",
				fetchedAt,
				sourceTimestamp,
				currencyConversionEvidence: evidence,
			};
			cache?.set?.(code, cloneLiveExchangeRate(live));
			return cloneLiveExchangeRate(live);
		}
		console.warn("[ota-reconcile] currency.live_rate.unavailable", {
			currency: code,
			reason:
				data?.result !== "success"
					? "response_not_success"
					: responseSourceCurrency !== code ||
					  responsePropertyCurrency !== "SAR"
					? "pair_mismatch"
					: "invalid_rate_or_provenance",
		});
		return null;
	} catch (error) {
		console.warn("[ota-reconcile] currency.live_rate.error", {
			currency: code,
			errorCode: boundedExchangeRateErrorCode(error),
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
			exchangeRateToSar: exchange.rate ?? null,
			exchangeRateSource: exchange.source,
			totalAmountSar: exchange.rate ? 0 : null,
			convertedAt: new Date().toISOString(),
		};
	}
	return {
		sourceAmount: numericAmount,
		sourceCurrency: exchange.code,
		exchangeRateToSar: exchange.rate ?? null,
		exchangeRateSource: exchange.source,
		totalAmountSar: exchange.rate
			? multiplyMoney2(numericAmount, exchange.rate)
			: null,
		convertedAt: new Date().toISOString(),
	};
}

function getUsdToSarExchangeRate() {
	const exchange = getSarExchangeRate("USD");
	const rate = Number(exchange.rate);
	return {
		code: "USD",
		rate: Number.isFinite(rate) && rate > 0 ? rate : null,
		source: Number.isFinite(rate) && rate > 0 ? exchange.source : "missing",
	};
}

function sarToUsdAmount(amountSar) {
	if (amountSar === null || amountSar === undefined || amountSar === "") {
		return null;
	}
	const numericSar = Number(amountSar);
	if (!Number.isFinite(numericSar) || numericSar < 0) return null;
	const usdExchange = getUsdToSarExchangeRate();
	return usdExchange.rate ? round2(numericSar / usdExchange.rate) : null;
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

async function getSarConversionMetaAsync(
	amount,
	currency,
	{ rateLookup = fetchLiveSarExchangeRate, ...rateLookupOptions } = {}
) {
	const numericAmount = Number(amount || 0);
	const code =
		String(currency || "SAR")
			.trim()
			.toUpperCase() || "SAR";
	let liveExchange = null;
	try {
		liveExchange = await rateLookup(code, rateLookupOptions);
	} catch (error) {
		console.warn("[ota-reconcile] currency.live_rate.lookup_error", {
			currency: code,
			errorCode: boundedExchangeRateErrorCode(error),
		});
	}
	const trustedEvidence = validatedTrustedExchangeRateEvidence(
		liveExchange?.currencyConversionEvidence,
		{
			sourceCurrency: code,
			propertyCurrency: "SAR",
			rate: liveExchange?.rate,
		}
	);
	const trustedLiveExchange = trustedEvidence
		? {
				...liveExchange,
				code,
				rate: trustedEvidence.rate,
				currencyConversionEvidence: trustedEvidence,
		  }
		: code === "SAR" && Number(liveExchange?.rate) === 1
		? { code: "SAR", rate: 1, source: "identity" }
		: null;
	const exchange = trustedLiveExchange || getSarExchangeRate(code);
	const convertedAt =
		trustedLiveExchange?.fetchedAt || new Date().toISOString();
	if (!numericAmount) {
		return {
			sourceAmount: 0,
			sourceCurrency: exchange.code,
			exchangeRateToSar: exchange.rate ?? null,
			exchangeRateSource: exchange.source,
			totalAmountSar: exchange.rate ? 0 : null,
			convertedAt,
			currencyConversionEvidence: trustedEvidence,
		};
	}
	return {
		sourceAmount: numericAmount,
		sourceCurrency: exchange.code,
		exchangeRateToSar: exchange.rate ?? null,
		exchangeRateSource: exchange.source,
		totalAmountSar: exchange.rate
			? multiplyMoney2(numericAmount, exchange.rate)
			: null,
		convertedAt,
		currencyConversionEvidence: trustedEvidence,
	};
}

async function getVccAmountConversionMetaAsync(amount, currency) {
	return withUsdConversionMeta(
		await getSarConversionMetaAsync(amount, currency)
	);
}

function toSarAmount(amount, currency) {
	return getSarConversionMeta(amount, currency).totalAmountSar;
}

function parseDate(value) {
	const arabicMonths = [
		[/يناير/gi, "January"],
		[/فبراير/gi, "February"],
		[/مارس/gi, "March"],
		[/أبريل|ابريل/gi, "April"],
		[/مايو/gi, "May"],
		[/يونيو/gi, "June"],
		[/يوليو/gi, "July"],
		[/أغسطس|اغسطس/gi, "August"],
		[/سبتمبر/gi, "September"],
		[/أكتوبر|اكتوبر/gi, "October"],
		[/نوفمبر/gi, "November"],
		[/ديسمبر/gi, "December"],
	];
	const s = arabicMonths.reduce(
		(result, [pattern, month]) => result.replace(pattern, month),
		normalizeWhitespace(value).replace(/،/g, ",")
	);
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

	// Numeric-looking dates must never reach permissive parsing. Accept a
	// year-first value only when its calendar date is strict ISO, while allowing
	// an otherwise valid ISO timestamp or a bounded timezone suffix.
	const strictIso = s.match(
		/^(\d{4}-\d{2}-\d{2})(?:(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)|(?:\s+(?:UTC|GMT)))?$/i
	);
	if (strictIso) {
		const parsed = dayjs(strictIso[1], "YYYY-MM-DD", true);
		return parsed.isValid() ? parsed.format("YYYY-MM-DD") : null;
	}

	const cleaned = s
		.replace(/\b(mon|tue|wed|thu|fri|sat|sun)(day)?\b,?\s*/gi, "")
		.replace(/(\d+)(st|nd|rd|th)\b/gi, "$1")
		.replace(/\s+at\s+.*$/i, "")
		.replace(/\s+\d{1,2}:\d{2}.*$/i, "")
		.trim();

	// Numeric day/month dates occur in both US and international order across
	// providers. Every separator form therefore receives the same fail-closed
	// treatment. Two-digit years have no safe generic century/order inference.
	const numericDayMonthDate = cleaned.match(
		/^(\d{1,2})\s*(?:[.\/\-\u2013\u2014]|\s)\s*(\d{1,2})\s*(?:[.\/\-\u2013\u2014]|\s)\s*(\d{2}|\d{4})(?:\s+(?:UTC|GMT|Z|[+-]\d{2}:?\d{2}))?$/i
	);
	if (numericDayMonthDate) {
		const first = Number(numericDayMonthDate[1]);
		const second = Number(numericDayMonthDate[2]);
		const yearText = numericDayMonthDate[3];
		if (yearText.length !== 4) return null;
		if (first <= 12 && second <= 12 && first !== second) return null;
		if (first > 12 && second > 12) return null;

		const month = first > 12 ? second : first;
		const day = first > 12 ? first : second;
		const canonical = `${yearText}-${String(month).padStart(2, "0")}-${String(
			day
		).padStart(2, "0")}`;
		const parsed = dayjs(canonical, "YYYY-MM-DD", true);
		return parsed.isValid() ? parsed.format("YYYY-MM-DD") : null;
	}
	if (
		/^\d{1,4}\s*(?:[.\/\-\u2013\u2014]|\s)\s*\d{1,2}\s*(?:[.\/\-\u2013\u2014]|\s)\s*\d{2,4}/.test(
			cleaned
		)
	) {
		return null;
	}

	const formats = [
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
	if (!start.isValid() || !end.isValid()) return [];
	const stayNights = end.startOf("day").diff(start.startOf("day"), "day");
	if (stayNights <= 0 || stayNights > 366) return [];
	return Array.from({ length: stayNights }, (_, offset) =>
		start.add(offset, "day").format("YYYY-MM-DD")
	);
}

function otaInboundAllocationSafety(normalized = {}) {
	const sourceClaimsRoomCount = hasSourceField(normalized, "roomCount");
	const rawRoomCount = normalized.roomCount;
	const roomCount =
		(rawRoomCount === undefined ||
			rawRoomCount === null ||
			rawRoomCount === "" ||
			(Number(rawRoomCount) === 0 && !sourceClaimsRoomCount))
			? 1
			: Number(rawRoomCount);
	const start = dayjs(normalized.checkinDate).startOf("day");
	const end = dayjs(normalized.checkoutDate).startOf("day");
	const stayNights =
		start.isValid() && end.isValid() ? end.diff(start, "day") : 0;
	if (!Number.isSafeInteger(roomCount) || roomCount <= 0) {
		return {
			ok: false,
			reason: "invalid_room_count",
			roomCount,
			stayNights,
			roomNightSlots: 0,
		};
	}
	const roomNightSlots = stayNights > 0 ? roomCount * stayNights : roomCount;
	if (roomCount > MAX_OTA_INBOUND_ROOM_COUNT) {
		return {
			ok: false,
			reason: "room_count_resource_limit",
			roomCount,
			stayNights,
			roomNightSlots,
		};
	}
	if (
		!Number.isSafeInteger(roomNightSlots) ||
		roomNightSlots > MAX_OTA_INBOUND_ROOM_NIGHT_SLOTS
	) {
		return {
			ok: false,
			reason: "room_night_resource_limit",
			roomCount,
			stayNights,
			roomNightSlots,
		};
	}
	return { ok: true, roomCount, stayNights, roomNightSlots };
}

function otaInboundAllocationLimitReview(
	normalized = {},
	allocationSafety = otaInboundAllocationSafety(normalized)
) {
	return {
		status: "needs_review",
		actionTaken: "skipped",
		skipReason: "ota_inbound_allocation_resource_limit",
		automationComment:
			"The inbound room count or room-night allocation exceeds the per-email resource-safety ceiling; this is not an inventory or overbooking decision, and the resource guard stopped processing before any additional live exchange-rate lookup or external reservation lookup and before room-mapping AI, reservation creation, or mutation.",
		warnings: [...(normalized.warnings || [])],
		errors: [
			...(normalized.errors || []),
			`Inbound allocation rejected by resource-safety guard: ${allocationSafety.reason}.`,
		],
		reservationId: null,
		hotelId: null,
		pmsConfirmationNumber: "",
		matchedReservationBy: [],
	};
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
		if (!labelComparable) continue;
		const idx = lines.findIndex((line) => {
			const lineComparable = normalizeComparable(line);
			return (
				lineComparable === labelComparable ||
				lineComparable.startsWith(`${labelComparable} `)
			);
		});
		if (idx >= 0) {
			// Do not slice the raw line by the literal label length. Comparable
			// matching intentionally ignores punctuation (for example, "Reservation
			// #" versus "Reservation"), so a literal slice can remove the first
			// character of the actual value. Capture the remainder from the raw line
			// using the same punctuation-tolerant token boundary instead.
			const flexibleLabelPattern = labelComparable
				.split(" ")
				.filter(Boolean)
				.map(escapeRegExp)
				.join("[^A-Za-z0-9]+");
			const sameLineMatch = lines[idx].match(
				new RegExp(
					`^\\s*${flexibleLabelPattern}(?=$|[^A-Za-z0-9])(?:\\s*[:#-]?\\s*)?(.*)$`,
					"i"
				)
			);
			const sameLine = normalizeWhitespace(sameLineMatch?.[1] || "").replace(
				/^[:#-]\s*/,
				""
			);
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
	if (/^card\s+\d{4}$/.test(normalized)) return true;
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

function findCleanConfirmationField(text, labels = []) {
	for (const label of labels) {
		const candidate = cleanConfirmationCandidate(findField(text, [label]));
		if (candidate) return candidate;
	}
	return "";
}

const GENERIC_OTA_EXPLICIT_FACT_LABELS = Object.freeze({
	hotelName: ["Hotel name", "Property name"],
	roomName: [
		"Room type name",
		"Room name",
		"Room type code/name",
		"Room type/name",
		"Room type",
		"Unit type",
	],
	checkinDate: [
		"Check-in date",
		"Check in date",
		"Checkin date",
		"Check-in",
		"Check in",
		"Checkin",
		"Arrival date",
		"Arrival",
	],
	checkoutDate: [
		"Check-out date",
		"Check out date",
		"Checkout date",
		"Check-out",
		"Check out",
		"Checkout",
		"Departure date",
		"Departure",
	],
	amount: [
		"Total booking amount",
		"Booking amount",
		"Total guest payment",
		"Reservation total",
		"Total amount",
		"Grand total",
		"Guest total",
		"Order total",
	],
	roomCount: [
		"Room count",
		"Number of rooms",
		"No. of rooms",
		"No of rooms",
		"Rooms booked",
	],
	guestName: ["Guest name", "Customer name"],
	adults: ["Adult guests", "Adults", "Adult count"],
	children: ["Child guests", "Children", "Children count", "Child count"],
	totalGuests: ["Total guests", "Guest count"],
});

const GENERIC_OTA_EXPLICIT_FACT_REASON_LABELS = Object.freeze({
	hotelName: "hotel/property",
	roomName: "room type/name",
	checkinDate: "check-in date",
	checkoutDate: "check-out date",
	amount: "guest total/currency",
	roomCount: "room count",
	guestName: "guest name",
	adults: "adult count",
	children: "child count",
	totalGuests: "total guest count",
});

const GENERIC_OTA_ALL_EXPLICIT_FACT_LABELS = Array.from(
	new Set(Object.values(GENERIC_OTA_EXPLICIT_FACT_LABELS).flat())
);

function stripExplicitFactMarkdown(value = "") {
	return normalizeWhitespace(value)
		.replace(/^[>*_`|\s]+/, "")
		.replace(/[*_`]+$/g, "")
		.replace(/^[:#-]\s*/, "")
		.trim();
}

function explicitFactLabelMatch(line = "", label = "") {
	const cleanedLine = stripExplicitFactMarkdown(line);
	const labelComparable = normalizeComparable(label);
	if (!cleanedLine || !labelComparable) return null;
	const flexibleLabelPattern = labelComparable
		.split(" ")
		.filter(Boolean)
		.map(escapeRegExp)
		.join("[^A-Za-z0-9]+");
	return cleanedLine.match(
		new RegExp(
			`^\\s*${flexibleLabelPattern}(?=$|[^A-Za-z0-9])(?:\\s*([:#])\\s*(.*)|\\s+-\\s+(.*)|\\s+(.*)|\\s*)$`,
			"i"
		)
	);
}

function lineStartsWithExplicitFactLabel(line = "") {
	const lineComparable = normalizeComparable(stripExplicitFactMarkdown(line));
	return GENERIC_OTA_ALL_EXPLICIT_FACT_LABELS.some((label) => {
		if (explicitFactLabelMatch(line, label)) return true;
		const labelComparable = normalizeComparable(label);
		return !!(
			lineComparable &&
			labelComparable &&
			(lineComparable === labelComparable ||
				lineComparable.startsWith(`${labelComparable} `))
		);
	});
}

const GENERIC_OTA_INLINE_SUBFIELD_PREFIXES = Object.freeze({
	hotelName:
		/^(?:address|code|contact|coordinates?|description|email|id|identifier|local\s+language|location|map|phone|rating|stars?|translation|url|website)\b/i,
	roomName:
		/^(?:amenities|code|description|id|identifier|occupancy|price|rate|rates|translation)\b/i,
	checkinDate: /^(?:instructions?|policy|time|timezone|window)\b/i,
	checkoutDate: /^(?:instructions?|policy|time|timezone|window)\b/i,
	amount:
		/^(?:after|before|commission|excluding|fees?|net|payout|tax|taxes)\b/i,
	roomCount: /^(?:breakdown|details?|ids?|inventory|limit|policy)\b/i,
	guestName:
		/^(?:address|code|comments?|country|email|id|identifier|mobile|nationality|notes?|phone|pronunciation|requests?|telephone)\b/i,
	adults: /^(?:ages?|breakdown|details?|names?|policy)\b/i,
	children: /^(?:ages?|breakdown|details?|names?|policy)\b/i,
	totalGuests: /^(?:breakdown|details?|names?|policy)\b/i,
});

const GENERIC_OTA_BARE_TRAVEL_VALUE_PATTERN =
	/\b(?:airport|airline|flight|terminal|transfer|transport|pickup|pick-up|dropoff|drop-off|shuttle|train|bus|ferry|taxi|chauffeur|station)\b/i;

function extractExplicitFactLabelValues(text = "", labels = [], field = "") {
	const lines = normalizedLines(text);
	const orderedLabels = [...labels].sort(
		(left, right) => normalizeComparable(right).length - normalizeComparable(left).length
	);
	const values = [];
	for (let index = 0; index < lines.length; index += 1) {
		for (const label of orderedLabels) {
			const match = explicitFactLabelMatch(lines[index], label);
			if (!match) continue;
			const inlineUnseparated = match[4] !== undefined;
			let value = stripExplicitFactMarkdown(
				match[2] ?? match[3] ?? match[4] ?? ""
			);
			if (
				inlineUnseparated &&
				value &&
				lineStartsWithExplicitFactLabel(value)
			) {
				// Two-column email headers such as "Check-in Checkout" contain
				// another field label here, not an inline value for the first field.
				break;
			}
			if (
				inlineUnseparated &&
				value &&
				GENERIC_OTA_INLINE_SUBFIELD_PREFIXES[field]?.test(value)
			) {
				break;
			}
			const followingLine = stripExplicitFactMarkdown(lines[index + 1] || "");
			if (
				field === "roomName" &&
				value &&
				followingLine &&
				!lineStartsWithExplicitFactLabel(followingLine) &&
				/\|\s*\d+\s+room\(s\)/i.test(followingLine)
			) {
				// Trip.com can wrap one structured `Room Type` value immediately
				// before its `| N room(s)` table columns, then repeat the same value
				// unwrapped. Rejoin only that source-shaped continuation so the
				// generic repeated-fact guard compares the actual room identity.
				value = `${value} ${followingLine}`;
			}
			if (
				!value &&
				lines[index + 1] &&
				!lineStartsWithExplicitFactLabel(lines[index + 1])
			) {
				value = stripExplicitFactMarkdown(lines[index + 1]);
			}
			const bareTravelLabel = normalizeComparable(label);
			if (
				value &&
				((field === "checkinDate" && bareTravelLabel === "arrival") ||
					(field === "checkoutDate" && bareTravelLabel === "departure")) &&
				(!parseDate(value) || GENERIC_OTA_BARE_TRAVEL_VALUE_PATTERN.test(value))
			) {
				// Bare Arrival/Departure labels are also common transfer/flight fields.
				// They are stay-date evidence only when their value is actually a date.
				break;
			}
			if (value) values.push(value);
			break;
		}
	}
	return values;
}

function hasDistinctExplicitMoneyValues(values = []) {
	const parsedValues = values.map((value) => parseMoney(value));
	const hasInvalidValue = parsedValues.some(
		(value) => !Number.isFinite(value.amount) || value.amount <= 0
	);
	if (hasInvalidValue) {
		const distinctRawValues = new Set(
			values.map((value) => normalizeIntlComparable(cleanFieldValue(value)))
		);
		if (distinctRawValues.size > 1) return true;
	}
	const validValues = parsedValues.filter(
		(value) => Number.isFinite(value.amount) && value.amount > 0
	);
	const amounts = new Set(validValues.map((value) => round2(value.amount)));
	const explicitCurrencies = new Set(
		validValues.map((value) => value.currency).filter(Boolean)
	);
	return amounts.size > 1 || explicitCurrencies.size > 1;
}

function normalizeExplicitHotelFactValue(value = "") {
	const cleaned = cleanFieldValue(value);
	const key = normalizeComparable(cleaned);
	const explicitAliasGroupIndex = EXPLICIT_HOTEL_ALIAS_INDEX.findIndex((group) =>
		group.keys.has(key)
	);
	return explicitAliasGroupIndex >= 0
		? `explicit-hotel-alias:${explicitAliasGroupIndex}`
		: normalizeIntlComparable(cleaned);
}

function normalizeExplicitRoomFactValue(value = "") {
	const roomIdentity = cleanFieldValue(value).replace(
		/\s*\|\s*\d+\s+room\(s\)[\s\S]*$/i,
		""
	);
	return normalizeRoomSignalText(roomIdentity)
		.split(" ")
		.filter(Boolean)
		.map((token) => {
			const roomClass = roomClassToken(token);
			if (roomClass) {
				return `class-${roomClass.roomType}-${roomClass.capacity}`;
			}
			if (["room", "rooms"].includes(token)) return "room";
			return token;
		})
		.join(" ");
}

function normalizeExplicitFactValue(field = "", value = "") {
	if (["checkinDate", "checkoutDate"].includes(field)) {
		const source = normalizeWhitespace(value);
		const dateCandidates = [
			source.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0],
			source.match(
				/\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?[,]?\s+\d{4}\b/i
			)?.[0],
			source.match(
				/\b\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{4}\b/i
			)?.[0],
			source,
		].filter(Boolean);
		for (const candidate of dateCandidates) {
			const parsed = parseDate(candidate);
			if (parsed) return parsed;
		}
		return "";
	}
	if (["roomCount", "adults", "children", "totalGuests"].includes(field)) {
		const normalizedValue = normalizeWhitespace(value);
		if (
			field === "children" &&
			/^(?:no|none|zero|n\/?a|not applicable)(?:\s+children?)?$/i.test(
				normalizedValue
			)
		) {
			return "0";
		}
		const numericMatch = normalizedValue.match(/-?\d+(?:\.\d+)?/);
		if (!numericMatch) return "";
		const parsed = Number(numericMatch[0]);
		return Number.isSafeInteger(parsed) && parsed >= 0 ? String(parsed) : "";
	}
	if (field === "hotelName") return normalizeExplicitHotelFactValue(value);
	if (field === "roomName") return normalizeExplicitRoomFactValue(value);
	return normalizeIntlComparable(cleanFieldValue(value));
}

function detectGenericOtaRepeatedFactConflicts(text = "") {
	const conflicts = [];
	for (const [field, labels] of Object.entries(GENERIC_OTA_EXPLICIT_FACT_LABELS)) {
		const rawValues = extractExplicitFactLabelValues(text, labels, field);
		if (rawValues.length < 2) continue;
		const normalizedValues = rawValues.map((value) =>
			normalizeExplicitFactValue(field, value)
		);
		const hasInvalidDistinctValue =
			field !== "amount" &&
			normalizedValues.some((value) => value === "") &&
			new Set(
				rawValues.map((value) =>
					normalizeIntlComparable(cleanFieldValue(value))
				)
			).size > 1;
		const conflicting =
			field === "amount"
				? hasDistinctExplicitMoneyValues(rawValues)
				: hasInvalidDistinctValue ||
				  new Set(normalizedValues.filter((value) => value !== "")).size > 1;
		if (conflicting) conflicts.push(field);
	}
	return conflicts;
}

function genericRepeatedFactConflictReason(field = "") {
	const label = GENERIC_OTA_EXPLICIT_FACT_REASON_LABELS[field] || field;
	return `Authenticated direct OTA email contains conflicting repeated explicit ${label} values; automatic commercial and stay-fact mutation is disabled.`;
}

function extractHotelRunnerArabicRoomBlocks(text = "") {
	const blocks = [];
	const source = String(text || "").replace(/\r/g, "");
	const markers = Array.from(source.matchAll(/نوع\s+الغرفة/gu));
	const locate = (value, pattern, offset = 0) => {
		const match = String(value || "").slice(offset).match(pattern);
		return match
			? { index: offset + match.index, length: match[0].length }
			: null;
	};
	for (let index = 0; index < markers.length; index += 1) {
		const marker = markers[index];
		const start = Number(marker.index || 0);
		const end =
			index + 1 < markers.length
				? Number(markers[index + 1].index || source.length)
				: source.length;
		const before = source.slice(0, start).trimEnd();
		const heading = cleanFieldValue(
			before.slice(before.lastIndexOf("\n") + 1)
		);
		const segment = source.slice(start + marker[0].length, end);
		const checkinLabel = locate(segment, /تاريخ\s+تسجيل\s+الوصول/u);
		const checkoutLabel = checkinLabel
			? locate(
					segment,
					/تاريخ\s+تسجيل\s+المغادرة/u,
					checkinLabel.index + checkinLabel.length
			  )
			: null;
		const guestsLabel = checkoutLabel
			? locate(
					segment,
					/عدد\s+الضيوف/u,
					checkoutLabel.index + checkoutLabel.length
			  )
			: null;
		if (!checkinLabel || !checkoutLabel || !guestsLabel) continue;
		const roomType = cleanFieldValue(segment.slice(0, checkinLabel.index));
		const checkinDate = parseDate(
			segment.slice(
				checkinLabel.index + checkinLabel.length,
				checkoutLabel.index
			)
		);
		const checkoutDate = parseDate(
			segment.slice(
				checkoutLabel.index + checkoutLabel.length,
				guestsLabel.index
			)
		);
		const afterGuests = normalizeUnicodeDigits(
			segment.slice(guestsLabel.index + guestsLabel.length)
		);
		const guestMatch = afterGuests.match(/^\s*(\d{1,2})\b/u);
		const totalGuests = Number(guestMatch?.[1] || 0);
		const tail = guestMatch
			? afterGuests.slice(Number(guestMatch.index || 0) + guestMatch[0].length)
			: "";
		const adultsMatch = tail.match(
			/(\d{1,2})\s*(?:بالغين|بالغان|بالغون|بالغ)(?=$|[\s,.)،])/u
		);
		const childrenMatch = tail.match(
			/(\d{1,2})\s*(?:أطفال|اطفال|طفل)(?=$|[\s,.)،])/u
		);
		const hasOccupancyBreakdown = !!(adultsMatch || childrenMatch);
		const adults = hasOccupancyBreakdown
			? Number(adultsMatch?.[1] || 0)
			: totalGuests;
		const children = hasOccupancyBreakdown
			? Number(childrenMatch?.[1] || 0)
			: 0;
		const total = parseMoney(
			firstNonEmpty(
				findFirstPattern(tail, [
					/الإجمالي\s*[:#-]?\s*((?:SAR|SR|USD|US\$|[$€£﷼])?\s*[0-9][0-9,.]*)/i,
				]),
				findFirstPattern(tail, [
					new RegExp(
						`\\u0627\\u0644\\u0625\\u062c\\u0645\\u0627\\u0644\\u064a\\s*[:#-]?\\s*(${moneyValuePattern()})`,
						"iu"
					),
				])
			)
		);
		if (!heading || !roomType || !checkinDate || !checkoutDate || !totalGuests) {
			continue;
		}
		blocks.push({
			heading,
			roomType,
			roomName: heading,
			checkinDate,
			checkoutDate,
			totalGuests,
			adults,
			children,
			hasOccupancyBreakdown,
			totalAmount: total.amount || 0,
		});
	}

	const seen = new Set();
	const uniqueBlocks = blocks.filter((block) => {
		const key = [
			block.heading,
			block.roomType,
			block.checkinDate,
			block.checkoutDate,
			block.totalGuests,
			block.totalAmount,
		]
			.map(normalizeIntlComparable)
			.join("|");
		if (!key || seen.has(key)) return false;
		seen.add(key);
		return true;
	});
	// Do not collapse two genuinely booked identical rooms.  The only safe
	// duplicate is a mirrored representation whose aggregate order total equals
	// one block (rather than the sum of all repeated blocks).
	if (blocks.length > 1 && uniqueBlocks.length === 1) {
		const orderTotal = parseMoney(
			firstNonEmpty(
				findFirstPattern(source, [
					/Ø¥Ø¬Ù…Ø§Ù„ÙŠ\s*Ø§Ù„Ø·Ù„Ø¨\s*[:#-]?\s*((?:SAR|SR|USD|US\$|[$â‚¬Â£ï·¼])?\s*[0-9][0-9,.]*)/i,
				]),
				findFirstPattern(source, [
					new RegExp(
						`\\u0625\\u062c\\u0645\\u0627\\u0644\\u064a\\s*\\u0627\\u0644\\u0637\\u0644\\u0628\\s*[:#-]?\\s*(${moneyValuePattern()})`,
						"iu"
					),
				])
			)
		).amount;
		const repeatedBlockTotal = Number(uniqueBlocks[0].totalAmount || 0);
		if (
			orderTotal > 0 &&
			repeatedBlockTotal > 0 &&
			Math.abs(orderTotal - repeatedBlockTotal) <= 0.01
		) {
			return uniqueBlocks;
		}
	}
	return blocks;
}

function extractHotelRunnerArabicFields(text = "") {
	const source = String(text || "");
	const confirmationNumber = findFirstPattern(source, [
		/رقم\s*التأكيد\s*[:#-]?\s*([A-Z0-9-]{5,24})\b/i,
	]);
	const guestName = cleanFieldValue(
		findFirstPattern(source, [
			/اسم\s*الضيف\s*[:#-]?\s*([\s\S]{2,160}?)\s+الدولة(?=\s|[:#-]|$)/i,
		])
	);
	const nationality = cleanFieldValue(
		findFirstPattern(source, [
			/الدولة\s*[:#-]?\s*([\s\S]{1,100}?)\s+إجمالي\s*الطلب(?=\s|[:#-]|$)/i,
		])
	);
	const orderTotalText = firstNonEmpty(
		findFirstPattern(source, [
			/إجمالي\s*الطلب\s*[:#-]?\s*((?:SAR|SR|USD|US\$|[$€£﷼])?\s*[0-9][0-9,.]*)/i,
		]),
		findFirstPattern(source, [
			new RegExp(
				`\\u0625\\u062c\\u0645\\u0627\\u0644\\u064a\\s*\\u0627\\u0644\\u0637\\u0644\\u0628\\s*[:#-]?\\s*(${moneyValuePattern()})`,
				"iu"
			),
		])
	);
	const bookedAtText = findFirstPattern(source, [
		/تاريخ\s*الحجز\s*[:#-]?\s*[^\n]*?((?:يناير|فبراير|مارس|أبريل|ابريل|مايو|يونيو|يوليو|أغسطس|اغسطس|سبتمبر|أكتوبر|اكتوبر|نوفمبر|ديسمبر)\s+\d{1,2}[،,]?\s+\d{4})/i,
	]);
	const roomBlocks = extractHotelRunnerArabicRoomBlocks(source);
	const firstRoom = roomBlocks[0] || {};
	const roomName = [firstRoom.heading, firstRoom.roomType]
		.filter(Boolean)
		.filter(
			(value, index, values) =>
				values.findIndex(
					(candidate) =>
						normalizeIntlComparable(candidate) === normalizeIntlComparable(value)
				) === index
		)
		.join(" | ");
	const sameStay = roomBlocks.every(
		(block) =>
			block.checkinDate === firstRoom.checkinDate &&
			block.checkoutDate === firstRoom.checkoutDate
	);
	return {
		confirmationNumber: normalizeWhitespace(confirmationNumber),
		guestName,
		nationality,
		orderTotalText,
		amount: parseMoney(orderTotalText).amount || 0,
		bookedAt: parseDate(bookedAtText),
		roomName,
		checkinDate: sameStay ? firstRoom.checkinDate || null : null,
		checkoutDate: sameStay ? firstRoom.checkoutDate || null : null,
		roomCount: roomBlocks.length || 0,
		totalGuests: roomBlocks.reduce(
			(sum, block) => sum + Number(block.totalGuests || 0),
			0
		),
		adults: roomBlocks.reduce(
			(sum, block) => sum + Number(block.adults || 0),
			0
		),
		children: roomBlocks.reduce(
			(sum, block) => sum + Number(block.children || 0),
			0
		),
		hasOccupancyBreakdown: roomBlocks.some(
			(block) => block.hasOccupancyBreakdown
		),
		roomBlocks,
	};
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
	if (inline) return { ...inlineMoney, matched: true };
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
		if (parseMoneyCandidates(line).length) {
			return { ...sameLine, matched: true };
		}
		for (
			let nextIndex = index + 1;
			nextIndex < Math.min(lines.length, index + 5);
			nextIndex += 1
		) {
			const parsed = parseMoney(lines[nextIndex]);
			if (parseMoneyCandidates(lines[nextIndex]).length) {
				return { ...parsed, matched: true };
			}
		}
	}
	return { amount: 0, currency: "", matched: false };
}

function distinctAgodaReferenceSellRates(text = "") {
	const rates = [];
	const pattern =
		/Reference\s+sell\s+rate\s*\(incl\.\s*taxes\s*&\s*fees\)\s*[:#-]?\s*((?:(?:SAR|SR|USD|US\$|\$|﷼)\s*)?[+-]?[0-9][0-9,.]*)/gi;
	for (const match of String(text || "").matchAll(pattern)) {
		const parsed = parseMoney(match[1] || "");
		if (!parsed.amount) continue;
		rates.push(`${round2(parsed.amount)}:${parsed.currency || "SAR"}`);
	}
	return Array.from(new Set(rates));
}

function extractAgodaDeductionByLabel(text = "", label = "") {
	const source = String(text || "");
	const escapedLabel = escapeRegExp(label).replace(/\\ /g, "\\s+");
	const pattern = new RegExp(
		`${escapedLabel}\\s*[:#-]?\\s*(${moneyValuePattern()})`,
		"gi"
	);
	const matches = [];
	for (const match of source.matchAll(pattern)) {
		if (
			label === "Commission" &&
			/Tax\s+on\s*$/i.test(source.slice(Math.max(0, match.index - 24), match.index))
		) {
			continue;
		}
		const parsed = parseMoney(match[1] || "");
		if (!Number.isFinite(parsed.amount) || parsed.amount >= 0 || !parsed.currency) {
			continue;
		}
		matches.push({ amount: round2(Math.abs(parsed.amount)), currency: parsed.currency });
	}
	const distinct = Array.from(
		new Map(
			matches.map((item) => [`${item.currency}:${item.amount}`, item])
		).values()
	);
	return {
		matched: distinct.length === 1,
		conflict: distinct.length > 1,
		amount: distinct.length === 1 ? distinct[0].amount : 0,
		currency: distinct.length === 1 ? distinct[0].currency : "",
	};
}

function extractAgodaNightlyNetRates(text = "") {
	const section = String(text || "").match(
		/From\s*-\s*To\s+Rates\s+([\s\S]*?)Reference\s+sell\s+rate\s*\(incl\.\s*taxes\s*&\s*fees\)/i
	)?.[1];
	if (!section) return [];
	const datePattern =
		"(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\s+\\d{1,2}(?:st|nd|rd|th)?[,]?\\s+\\d{4}";
	const rowPattern = new RegExp(
		`(${datePattern})\\s+(${moneyValuePattern()})`,
		"gi"
	);
	const rows = [];
	for (const match of section.matchAll(rowPattern)) {
		const date = parseDate(match[1] || "");
		const money = parseMoney(match[2] || "");
		if (!date || money.amount <= 0 || !money.currency) return [];
		rows.push({ date, payoutAmount: round2(money.amount), currency: money.currency });
	}
	if (!rows.length || new Set(rows.map((row) => row.date)).size !== rows.length) {
		return [];
	}
	return rows;
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
	const hasReferenceSellRate = Number(referenceSellRate.amount || 0) > 0;
	const hasNetRate =
		netRate.matched === true &&
		Number.isFinite(Number(netRate.amount)) &&
		Number(netRate.amount) >= 0;
	const amountCurrency =
		referenceSellRate.currency || (hasNetRate ? netRate.currency : "") || "";
	const payoutCurrency = netRate.currency || "";
	const grossAndPayoutCurrencyConflict = Boolean(
		hasReferenceSellRate &&
			hasNetRate &&
			amountCurrency &&
			payoutCurrency &&
			amountCurrency !== payoutCurrency
	);
	const amountConversion = getSarConversionMeta(referenceSellRate.amount, amountCurrency);
	const commission = extractAgodaDeductionByLabel(text, "Commission");
	const growthProgram = extractAgodaDeductionByLabel(text, "Agoda Growth Program");
	const taxOnCommission = extractAgodaDeductionByLabel(text, "Tax on Commission");
	const targetedPromotion = extractAgodaDeductionByLabel(text, "Targeted promotions");
	const deductionConflict = [
		commission,
		growthProgram,
		taxOnCommission,
		targetedPromotion,
	].some((item) => item.conflict === true);
	const deductionCurrencyConflict = [
		commission,
		growthProgram,
		taxOnCommission,
		targetedPromotion,
	]
		.filter((item) => item.matched)
		.some((item) => item.currency !== amountCurrency);
	const nightlyPricingSource = extractAgodaNightlyNetRates(text);
	const exactNightlyPayout = Boolean(
		nightlyPricingSource.length &&
		!nightlyPricingSource.some((row) => row.currency !== payoutCurrency) &&
		Math.abs(
			round2(
				nightlyPricingSource.reduce(
					(sum, row) => sum + Number(row.payoutAmount || 0),
					0
				)
			) - Number(netRate.amount || 0)
		) <= 0.01
	);
	const nightlyClientAmounts = exactNightlyPayout
		? allocateWeightedAmountAcrossSlots(
				referenceSellRate.amount,
				nightlyPricingSource.map((row) => row.payoutAmount)
		  )
		: [];
	const nightlyPricingSar =
		exactNightlyPayout && nightlyClientAmounts.length === nightlyPricingSource.length
			? nightlyPricingSource.map((row, index) => ({
					date: row.date,
					clientAmountSar: nightlyClientAmounts[index],
					payoutAmountSar: row.payoutAmount,
					clientAllocationSource: "gross_proportional_to_source_net",
			  }))
			: [];
	const firstName = firstNonEmpty(
		extractAgodaValueBetweenLabels(text, "Customer First Name", [
			"Customer Last Name",
		]),
		findField(text, ["Customer First Name"])
	);
	const textReferenceSellRateOccurrences = distinctAgodaReferenceSellRates(
		email.text || ""
	).length;
	const htmlReferenceSellRateOccurrences = distinctAgodaReferenceSellRates(
		htmlToText(email.html || "")
	).length;
	const referenceSellRateOccurrences =
		textReferenceSellRateOccurrences || htmlReferenceSellRateOccurrences
			? Math.max(
					textReferenceSellRateOccurrences,
					htmlReferenceSellRateOccurrences
			  )
			: distinctAgodaReferenceSellRates(text).length;
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
		amount: hasReferenceSellRate ? referenceSellRate.amount : 0,
		currency: amountCurrency,
		totalAmountSar:
			hasReferenceSellRate && amountCurrency === "SAR"
				? round2(referenceSellRate.amount)
				: null,
		sourceAmount: hasReferenceSellRate ? referenceSellRate.amount : null,
		sourceCurrency: amountCurrency,
		sourcePayoutAmount: hasNetRate ? netRate.amount : null,
		sourcePayoutCurrency: hasNetRate ? payoutCurrency : "",
		exchangeRateToSar: amountConversion.exchangeRateToSar || 0,
		exchangeRateSource: amountConversion.exchangeRateSource || "",
		amountConvertedAt: amountConversion.convertedAt || "",
		totalPayoutSar:
			hasNetRate && payoutCurrency === "SAR" ? round2(netRate.amount) : null,
		netAfterExpensesTotal:
			hasNetRate && payoutCurrency === "SAR" ? round2(netRate.amount) : null,
		grossAndPayoutCurrencyConflict,
		otaCommissionSar:
			commission.matched && !deductionCurrencyConflict
				? commission.currency === "SAR"
					? round2(commission.amount)
					: null
				: null,
		otaCommissionSourceAmount:
			commission.matched && !deductionCurrencyConflict
				? round2(commission.amount)
				: null,
		otaCommissionCurrency:
			commission.matched && !deductionCurrencyConflict
				? commission.currency
				: "",
		otaCommissionSource:
			commission.matched && !deductionCurrencyConflict
				? "agoda_commission"
				: "",
		otaCommissionConflict: commission.conflict === true,
		otaDeductionConflict: deductionConflict || deductionCurrencyConflict,
		otaDeductionComponents:
			!deductionConflict && !deductionCurrencyConflict
				? [
						["commission", "Commission", commission],
						["growth_program", "Agoda Growth Program", growthProgram],
						["tax_on_commission", "Tax on Commission", taxOnCommission],
						["targeted_promotion", "Targeted promotions", targetedPromotion],
				  ]
						.filter(([, , item]) => item.matched)
						.map(([type, label, item]) => ({
							type,
							label,
							amountSar:
								item.currency === "SAR" ? round2(item.amount) : null,
							sourceAmount: round2(item.amount),
							currency: item.currency,
							source: "authenticated_agoda_email",
						}))
				: [],
		targetedPromotionsLabelPresent: /\bTargeted\s+promotions\b/i.test(text),
		nightlyPricingSource,
		nightlyPricingSar,
		paymentSummary:
			hasReferenceSellRate || hasNetRate
				? {
						sourceCurrency: amountCurrency,
						sourceTotalGuestPaymentAmount: hasReferenceSellRate
							? referenceSellRate.amount
							: null,
						sourceTotalPayoutAmount: hasNetRate ? netRate.amount : null,
						sourceTotalPayoutCurrency: hasNetRate ? payoutCurrency : "",
						totalGuestPaymentAmount:
							hasReferenceSellRate && amountCurrency === "SAR"
								? round2(referenceSellRate.amount)
								: null,
						totalPayoutAmount:
							hasNetRate && payoutCurrency === "SAR"
								? round2(netRate.amount)
								: null,
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
			otaCommission:
				commission.matched &&
				!commission.conflict &&
				!deductionCurrencyConflict,
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

function extractAirbnbPairedStayLabels(text = "") {
	const lines = normalizedLines(text);
	const headingIndex = lines.findIndex((line) =>
		/^check[ -]?in\s+check[ -]?out$/i.test(line)
	);
	if (headingIndex < 0) return { checkinRaw: "", checkoutRaw: "" };
	const monthDayPattern =
		/(?:(?:mon|tue|wed|thu|fri|sat|sun)(?:day)?[,]?\s+)?([a-z]{3,9}\s+\d{1,2})(?!\d)/gi;
	for (
		let index = headingIndex + 1;
		index < Math.min(lines.length, headingIndex + 4);
		index += 1
	) {
		const matches = Array.from(lines[index].matchAll(monthDayPattern)).map(
			(match) => normalizeWhitespace(match[1])
		);
		if (matches.length >= 2) {
			return { checkinRaw: matches[0], checkoutRaw: matches[1] };
		}
	}
	return { checkinRaw: "", checkoutRaw: "" };
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
	const pairedStayLabels = extractAirbnbPairedStayLabels(text);
	const checkinRaw = firstNonEmpty(
		findNextLineAfterExactLabel(text, "Check-in", 5),
		pairedStayLabels.checkinRaw
	);
	const checkoutRaw = firstNonEmpty(
		findNextLineAfterExactLabel(text, "Checkout", 5),
		pairedStayLabels.checkoutRaw
	);
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
	if (parseMoneyCandidates(labelValue).length) {
		return { ...parsed, matched: true };
	}
	const patternLabel = escapeRegExp(label).replace(/\\ /g, "\\s+");
	const match = String(text || "").match(
		new RegExp(
			`${patternLabel}[ \\t]*(?:\\n[ \\t]*|[ \\t]+)((?:SR|SAR|USD|US\\$|\\$)\\s*[0-9][0-9,.]*)`,
			"i"
		)
	);
	return match
		? { ...parseMoney(match[1] || ""), matched: true }
		: { amount: 0, currency: "", matched: false };
}

function extractAirbnbHostServiceFee(text = "") {
	const matches = Array.from(
		String(text || "").matchAll(
			/Host\s+service\s+fee(?:\s*\([^)]{0,40}\))?\s*(?:[:#]?\s*)-?\s*((?:SR|SAR|USD|US\$|\$)\s*[0-9][0-9,.]*)/gi
		)
	)
		.map((match) => parseMoney(match[1] || ""))
		.filter(
			(value) =>
				Number.isFinite(Number(value.amount)) && Number(value.amount) >= 0
		);
	const unique = Array.from(
		new Map(
			matches.map((value) => [
				`${String(value.currency || "SAR").toUpperCase()}:${round2(
					value.amount
				).toFixed(2)}`,
				value,
			])
		).values()
	);
	if (unique.length !== 1) {
		return {
			amount: 0,
			currency: "",
			matched: false,
			conflict: unique.length > 1,
		};
	}
	return {
		amount: round2(unique[0].amount),
		currency: unique[0].currency || "SAR",
		matched: true,
		conflict: false,
	};
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

	const ajyadCandidates = [
		context.listingTitle,
		...(Array.isArray(context.hostLabels) ? context.hostLabels : []),
	].filter(Boolean);
	const ajyadMatchedValue = ajyadCandidates.find((value) =>
		containsConfiguredZadAjyadAlias(value)
	);
	if (ajyadMatchedValue) {
		return {
			hotelId: configuredAjyadHotelId(),
			matchedBy: "zad ajyad alias",
			matchedValue: ajyadMatchedValue,
			matchStrength: "exact_alias",
		};
	}
	const standaloneAjyadMatchedValue = ajyadCandidates.find((value) =>
		containsStandaloneAjyadHotelSegment(value)
	);
	if (standaloneAjyadMatchedValue) {
		return {
			hotelId: configuredAjyadHotelId(),
			matchedBy: "standalone ajyad hotel segment",
			matchedValue: standaloneAjyadMatchedValue,
			matchStrength: "exact_alias",
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
	const hostServiceFee = extractAirbnbHostServiceFee(text);
	const hasGuestTotal = Number(guestTotal.amount || 0) > 0;
	const hasPayout =
		payout.matched === true &&
		Number.isFinite(Number(payout.amount)) &&
		Number(payout.amount) >= 0;
	const guestTotalCurrency =
		guestTotal.currency || (hasPayout ? payout.currency : "") || "";
	const payoutCurrency = payout.currency || "";
	const grossAndPayoutCurrencyConflict = Boolean(
		hasGuestTotal &&
			hasPayout &&
			guestTotalCurrency &&
			payoutCurrency &&
			guestTotalCurrency !== payoutCurrency
	);
	const guestTotalConversion = getSarConversionMeta(
		guestTotal.amount,
		guestTotalCurrency
	);
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
		amount: hasGuestTotal ? guestTotal.amount : 0,
		currency: guestTotalCurrency,
		totalAmountSar:
			hasGuestTotal && guestTotalCurrency === "SAR"
				? round2(guestTotal.amount)
				: null,
		sourceAmount: hasGuestTotal ? guestTotal.amount : null,
		sourceCurrency: guestTotalCurrency,
		sourcePayoutAmount: hasPayout ? payout.amount : null,
		sourcePayoutCurrency: hasPayout ? payoutCurrency : "",
		exchangeRateToSar: guestTotalConversion.exchangeRateToSar,
		exchangeRateSource: guestTotalConversion.exchangeRateSource,
		amountConvertedAt: guestTotalConversion.convertedAt,
		totalPayoutSar:
			hasPayout && payoutCurrency === "SAR" ? round2(payout.amount) : null,
		netAfterExpensesTotal:
			hasPayout && payoutCurrency === "SAR" ? round2(payout.amount) : null,
		grossAndPayoutCurrencyConflict,
		otaCommissionSar:
			hostServiceFee.matched && !hostServiceFee.conflict
				? (hostServiceFee.currency || guestTotalCurrency) === "SAR"
					? round2(hostServiceFee.amount)
					: null
				: null,
		otaCommissionSourceAmount:
			hostServiceFee.matched && !hostServiceFee.conflict
				? round2(hostServiceFee.amount)
				: null,
		otaCommissionCurrency:
			hostServiceFee.matched && !hostServiceFee.conflict
				? hostServiceFee.currency || guestTotalCurrency || "SAR"
				: "",
		otaCommissionSource:
			hostServiceFee.matched && !hostServiceFee.conflict
				? "airbnb_host_service_fee"
				: "",
		otaCommissionConflict: hostServiceFee.conflict === true,
		paymentSummary:
			hasGuestTotal || hasPayout
				? {
						sourceCurrency: guestTotalCurrency,
						sourceTotalGuestPaymentAmount: hasGuestTotal
							? guestTotal.amount
							: null,
						sourceTotalPayoutAmount: hasPayout ? payout.amount : null,
						sourceTotalPayoutCurrency: hasPayout ? payoutCurrency : "",
						totalGuestPaymentAmount:
							hasGuestTotal && guestTotalCurrency === "SAR"
								? round2(guestTotal.amount)
								: null,
						totalPayoutAmount:
							hasPayout && payoutCurrency === "SAR"
								? round2(payout.amount)
								: null,
						currency: "SAR",
						exchangeRateToSar: guestTotalConversion.exchangeRateToSar,
						exchangeRateSource: guestTotalConversion.exchangeRateSource,
						amountConvertedAt: guestTotalConversion.convertedAt,
				  }
				: {},
		paymentCollectionModel: hasGuestTotal ? "ota_collect" : "unknown",
		paymentInstructions: hasGuestTotal
			? "Airbnb collected guest payment; host payout is provided by Airbnb."
			: "",
		sourcePresence: {
			otaCommission:
				hostServiceFee.matched === true && hostServiceFee.conflict !== true,
		},
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
	const totalAmountSar = round2(
		normalized.totalAmountSar || normalized.amount || 0
	);
	return (
		isOtaInboundEmail(normalized) &&
		Number.isFinite(totalAmountSar) &&
		totalAmountSar > MAX_OTA_INBOUND_RESERVATION_TOTAL_SAR
	);
}

function hasExplicitOtaPayoutSar(normalized = {}) {
	const paymentSummary = normalized.paymentSummary || {};
	return [
		normalized.totalPayoutSar,
		normalized.netAfterExpensesTotal,
		paymentSummary.totalPayoutAmount,
	].some((value) => Number(value || 0) > 0);
}

function providerCommercialSourceAligned(normalized = {}) {
	const provider = normalizeOtaIdentityProvider(normalized.provider);
	const transport = normalizeOtaIdentityProvider(
		normalized.trustedTransportProvider
	);
	return Boolean(
		provider &&
		provider !== "hotelrunner" &&
		transport === provider &&
		normalized.sourceSenderTrusted === true &&
		normalized.sourceSenderAuthenticated === true &&
		(normalized.requiresManualReview !== true ||
			agodaMultiRoomAllocationReviewAllowsCommercialOnly(normalized))
	);
}

function agodaMultiRoomAllocationReviewAllowsCommercialOnly(normalized = {}) {
	const reasons = Array.isArray(normalized.manualReviewReasons)
		? normalized.manualReviewReasons
				.map((reason) => String(reason || "").trim())
				.filter(Boolean)
		: [];
	return Boolean(
		normalized.requiresManualReview === true &&
		normalized.ambiguousMultiRoomEvidence === true &&
		normalized.blocksUnmappedReservationCreation === true &&
		normalizeOtaIdentityProvider(normalized.provider) === "agoda" &&
		reasons.length === 1 &&
		reasons[0] === AGODA_MULTI_ROOM_ALLOCATION_REVIEW_REASON
	);
}

function verifiedPropertyGuestGrossSar(normalized = {}) {
	const propertyCurrency = String(normalized.propertyCurrency || "SAR")
		.trim()
		.toUpperCase();
	const evidence = buildNormalizedOtaCommercialEvidence(normalized, {
		propertyCurrency,
	});
	const role = evidence?.roles?.guestGross;
	const value = Number(role?.propertyAmount);
	return role?.verified === true &&
		role.propertyCurrency === propertyCurrency &&
		Number.isFinite(value) &&
		value > 0
		? round2(value)
		: null;
}

function verifiedPropertyPayoutSar(normalized = {}) {
	const propertyCurrency = String(normalized.propertyCurrency || "SAR")
		.trim()
		.toUpperCase();
	const evidence = buildNormalizedOtaCommercialEvidence(normalized, {
		propertyCurrency,
	});
	const role = evidence?.roles?.hotelPayout;
	const value = Number(role?.propertyAmount);
	return role?.verified === true &&
		role.propertyCurrency === propertyCurrency &&
		Number.isFinite(value) &&
		value >= 0
		? round2(value)
		: null;
}

function validatedOtaCommercialEvidence(value, { provider = "" } = {}) {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const validation = validateOtaCommercialEvidence(value);
	if (!validation.ok) return null;
	const expectedProvider = provider
		? normalizeOtaIdentityProvider(provider)
		: value.provider;
	return expectedProvider && value.provider === expectedProvider ? value : null;
}

function storedExchangeRateEvidenceMatchesCommercialContract(
	normalized = {},
	commercialEvidence = {}
) {
	const paymentSummary = normalized.paymentSummary || {};
	const rateSource = normalizeMarker(
		normalized.exchangeRateSource || paymentSummary.exchangeRateSource || ""
	);
	if (rateSource !== "exchange_rate_api_stored") return true;
	const conversion = commercialEvidence.currencyConversion;
	const conversionProvenance = commercialEvidence.provenance?.conversion;
	if (!conversion || !conversionProvenance) return false;
	const exact = validatedTrustedExchangeRateEvidence(
		normalized.currencyConversionEvidence ||
			paymentSummary.currencyConversionEvidence,
		{
			sourceCurrency: commercialEvidence.sourceCurrency,
			propertyCurrency: commercialEvidence.propertyCurrency,
			rate: conversion.rate,
		}
	);
	return Boolean(
		exact &&
		conversion.sourceCurrency === exact.sourceCurrency &&
		conversion.propertyCurrency === exact.propertyCurrency &&
		Math.abs(Number(conversion.rate) - exact.rate) <= 0.0000000001 &&
		conversionProvenance.provider === exact.provenance.provider &&
		conversionProvenance.sourceType === exact.provenance.sourceType &&
		conversionProvenance.sourceHash === exact.provenance.sourceHash &&
		conversionProvenance.sourceTimestamp ===
			exact.provenance.sourceTimestamp &&
		conversionProvenance.sourceId === exact.provenance.sourceId
	);
}

function buildNormalizedOtaCommercialEvidence(
	normalized = {},
	{ propertyCurrency = "SAR", hotelBase = null } = {}
) {
	const supplied = validatedOtaCommercialEvidence(
		normalized.otaCommercialEvidence,
		{ provider: normalized.provider }
	);
	if (supplied) {
		if (
			!storedExchangeRateEvidenceMatchesCommercialContract(
				normalized,
				supplied
			)
		) {
			return null;
		}
		if (!hotelBase) return supplied;
		try {
			return withHotelBaseCommercialEvidence(supplied, hotelBase);
		} catch (_error) {
			return null;
		}
	}
	if (!providerCommercialSourceAligned(normalized)) return null;
	const provider = normalizeOtaIdentityProvider(normalized.provider);
	const sourceHash = normalizeMarker(normalized?.source?.textHash || "");
	const sourceTimestamp = otaSourceReceivedAt(normalized);
	const sourceIdCandidates = [
		normalized.inboundEmailId,
		normalized?.source?.messageId,
	]
		.map((value) => normalizeId(value || ""))
		.filter((value) => /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value));
	// RFC message IDs commonly contain an address-shaped `@` value. The common
	// contract intentionally excludes addresses/PII, so use the immutable body
	// hash as an opaque source identifier when no safe audit/document ID exists.
	const sourceId =
		sourceIdCandidates[0] ||
		(/^[a-f0-9]{64}$/.test(sourceHash)
			? `ota-source-${sourceHash.slice(0, 24)}`
			: "");
	const paymentSummary = safeOtaPaymentSummary(normalized.paymentSummary);
	const normalizedPropertyCurrency = String(propertyCurrency || "SAR")
		.trim()
		.toUpperCase();
	const sourceCurrency = String(
		normalized.sourceCurrency ||
			paymentSummary.sourceCurrency ||
			normalized.currency ||
			(hotelBase ? normalizedPropertyCurrency : "")
	)
		.trim()
		.toUpperCase();
	const conversionRate =
		normalized.exchangeRateToSar ?? paymentSummary.exchangeRateToSar ?? null;
	const currencyConversionEvidence =
		sourceCurrency && sourceCurrency !== normalizedPropertyCurrency
			? validatedTrustedExchangeRateEvidence(
					normalized.currencyConversionEvidence ||
						paymentSummary.currencyConversionEvidence,
					{
						sourceCurrency,
						propertyCurrency: normalizedPropertyCurrency,
						rate: conversionRate,
					}
			  )
			: null;
	const rawSourceGross =
		normalized.sourceAmount ??
		paymentSummary.sourceTotalGuestPaymentAmount ??
		null;
	const rawSourcePayout =
		paymentSummary.sourceTotalPayoutAmount ??
		normalized.sourcePayoutAmount ??
		null;
	const sourcePayoutCurrency = String(
		normalized.sourcePayoutCurrency ||
			paymentSummary.sourceTotalPayoutCurrency ||
			sourceCurrency
	)
		.trim()
		.toUpperCase();
	const sourceGross = Number(rawSourceGross);
	const sourcePayout = Number(rawSourcePayout);
	const hasSourceGross =
		rawSourceGross !== null &&
		rawSourceGross !== "" &&
		Number.isFinite(sourceGross) &&
		sourceGross > 0;
	const hasSourcePayout =
		rawSourcePayout !== null &&
		rawSourcePayout !== "" &&
		Number.isFinite(sourcePayout) &&
		sourcePayout >= 0 &&
		sourcePayoutCurrency === sourceCurrency;
	if (
		!provider ||
		!/^[a-f0-9]{64}$/.test(sourceHash) ||
		!sourceTimestamp ||
		!sourceId ||
		!/^[A-Z]{3}$/.test(sourceCurrency) ||
		!/^[A-Z]{3}$/.test(normalizedPropertyCurrency)
	) {
		return null;
	}
	const commissionCurrency = String(
		normalized.otaCommissionCurrency || ""
	)
		.trim()
		.toUpperCase();
	const explicitCommission = verifiedExplicitOtaCommissionSourceAmount(normalized);
	const nightlyEvidence = (Array.isArray(normalized.nightlyPricingSource)
		? normalized.nightlyPricingSource
		: []
	)
		.map((row) => ({
			stayDate: row?.date,
			...(Number(row?.clientAmount || 0) > 0
				? {
					guestGross: {
						verified: true,
						amount: Number(row.clientAmount),
					},
				  }
				: {}),
			...(Number(row?.payoutAmount || 0) > 0
				? {
					hotelPayout: {
						verified: true,
						amount: Number(row.payoutAmount),
					},
				  }
				: {}),
		}))
		.filter(
			(row) => row.stayDate && (row.guestGross || row.hotelPayout)
		);
	const deductionComponents = (Array.isArray(normalized.otaDeductionComponents)
		? normalized.otaDeductionComponents
		: []
	)
		.filter(
			(component) =>
				Number(component?.sourceAmount ?? component?.amountSar ?? 0) > 0 &&
				String(component?.currency || "").trim().toUpperCase() ===
					sourceCurrency
		)
		.map((component) => ({
			verified: true,
			componentType: component.type,
			direction: "deduction",
			amount: Number(component.sourceAmount ?? component.amountSar),
		}));
	if (
		!hasSourceGross &&
		!hasSourcePayout &&
		explicitCommission === null &&
		!nightlyEvidence.length &&
		!deductionComponents.length &&
		!hotelBase
	) {
		return null;
	}
	try {
		return buildAuthenticatedProviderCommercialEvidence({
			provider,
			authenticatedProvider: normalizeOtaIdentityProvider(
				normalized.trustedTransportProvider
			),
			sourceAuthenticated: true,
			sourceTrusted: true,
			sourceType:
				normalized.commercialSourceType || "authenticated_ota_email",
			sourceCurrency,
			propertyCurrency: normalizedPropertyCurrency,
			bookingBasis: "reservation_total",
			sourceHash,
			sourceTimestamp,
			sourceId,
			...(hasSourceGross
				? { guestGross: { verified: true, amount: sourceGross } }
				: {}),
			...(hasSourcePayout
				? { hotelPayout: { verified: true, amount: sourcePayout } }
				: {}),
			...(explicitCommission !== null &&
			commissionCurrency === sourceCurrency
				? {
					explicitOtaCommission: {
						verified: true,
						explicit: true,
						amount: explicitCommission,
					},
				  }
				: {}),
			...(hotelBase ? { hotelBase } : {}),
			...(nightlyEvidence.length ? { nightlyEvidence } : {}),
			...(deductionComponents.length ? { deductionComponents } : {}),
			...(currencyConversionEvidence
				? { currencyConversion: currencyConversionEvidence }
				: {}),
		});
	} catch (_error) {
		return null;
	}
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

function extractExpediaPartnerCentralFields(text = "", provider = "") {
	if (provider !== "expedia") return {};
	const source = String(text || "");
	const reservationMatch = source.match(
		/\bReservation\s*#\s*(\d{8,18})\b/i
	);
	// HotelRunner may label its channel as Expedia and may contain very large
	// mirrored HTML. Only run this template-specific parser when both Expedia
	// Partner Central signatures are present.
	if (!reservationMatch || !/\bItinerary\s+number\b/i.test(source)) return {};
	const confirmationNumber = reservationMatch[1];
	const datePattern = dateTextPattern();
	const stayMatch = source.match(
		new RegExp(
			`\\b(${datePattern})\\s*(?:\\u2014|\\u2013|-)\\s*(${datePattern})\\s*\\(\\s*\\d+\\s+nights?\\s*\\)`,
			"i"
		)
	);
	const bookedAt = parseDate(
		findFirstPattern(source, [
			/\bReservation\s+made\s+([A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4})\b/i,
		])
	);
	const adultsMatch = source.match(/\bGuest\s+count\s+(\d+)\s+adults?\b/i);
	const childrenMatch = source.match(
		/\bGuest\s+count\s+\d+\s+adults?[\s,]*(\d+)\s+child(?:ren)?\b/i
	);
	const adults = Number(adultsMatch?.[1] || 0);
	const children = Number(childrenMatch?.[1] || 0);
	const currencyPattern = MONEY_CURRENCY_CODES.join("|");
	const currency = normalizeMoneyCurrency(
		findFirstPattern(source, [
			new RegExp(
				`\\bAmount\\s+to\\s+charge\\s+Expedia\\s+Group\\s+(${currencyPattern})\\b`,
				"i"
			),
		])
	);
	const totalGuestPaymentAmount = findFirstPattern(source, [
		new RegExp(
			`\\bTotal\\s+guest\\s+payment\\s+(${moneyNumberPattern()})(?=\\s|$)`,
			"i"
		),
	]);
	return {
		confirmationNumber,
		checkinDate: parseDate(stayMatch?.[1] || ""),
		checkoutDate: parseDate(stayMatch?.[2] || ""),
		bookedAt,
		adults,
		children,
		hasChildren: !!childrenMatch,
		totalGuests: adults + children,
		totalGuestPaymentText:
			currency && totalGuestPaymentAmount
				? `${currency} ${totalGuestPaymentAmount}`
				: "",
	};
}

function extractDirectTripConfirmationNumbers(value = "") {
	const source = String(value || "");
	return Array.from(
		new Set(
			Array.from(
				source.matchAll(
					/\b(?:Booking|Reservation|Confirmation)\s*(?:no\.?|number|id|code|#)\s*[:#-]?\s*(\d{12,18})\b/gi
				)
			)
				.map((match) => cleanConfirmationCandidate(match[1] || ""))
				.filter(Boolean)
		)
	);
}

function extractDirectTripNightlySourceRows(
	text = "",
	{
		dateRange = [],
		roomCount = 1,
		currency = "",
		totalGuestAmount = 0,
		totalPayoutAmount = 0,
	} = {}
) {
	if (!dateRange.length || roomCount !== 1 || !currency) return [];
	const source = String(text || "").replace(/\r/g, "");
	const detailsMarker = source.search(/\bRoom\s+rate\s*Price\s+details\b/i);
	if (detailsMarker < 0) return [];
	const details = source
		.slice(detailsMarker)
		.split(/\bAdditional\s+Information\s*Type\s*Details\s*Rewards\b/i)[0];
	const rowPattern =
		/(?:^|\n)\s*([A-Za-z]{3,9}\s+\d{1,2})\s*\(\s*(\d+)\s+room\(s\)\s*\)([\s\S]*?)(?=(?:\n\s*[A-Za-z]{3,9}\s+\d{1,2}\s*\(\s*\d+\s+room\(s\)\s*\))|$)/gi;
	const rows = Array.from(details.matchAll(rowPattern)).map((match) => {
		const block = match[3] || "";
		const clientAmount = parseMoney(
			findFirstPattern(block, [
				/\bFinal\s+room\s+rate\s*\(incl\.\s*taxes\s+and\s+fees\)\s*(?:[A-Z]{3}|US\$|\$)?\s*([0-9][0-9,.]*)(?:\s*\*\s*1)?/i,
			])
		).amount;
		const payoutAmount = parseMoney(
			findFirstPattern(block, [
				/\bYour\s+payout\s*(?:[A-Z]{3}|US\$|\$)?\s*([0-9][0-9,.]*)(?:\s*\*\s*1)?/i,
			])
		).amount;
		return {
			label: normalizeWhitespace(match[1]).toLowerCase(),
			roomCount: Number(match[2] || 0),
			clientAmount,
			payoutAmount,
		};
	});
	if (rows.length !== dateRange.length) return [];
	const valid = rows.every((row, index) => {
		const expectedLabel = dayjs(dateRange[index]).format("MMM D").toLowerCase();
		return (
			row.label === expectedLabel &&
			row.roomCount === 1 &&
			row.clientAmount > 0 &&
			row.payoutAmount > 0 &&
			row.payoutAmount <= row.clientAmount + 0.01
		);
	});
	if (!valid) return [];
	const clientSum = round2(
		rows.reduce((sum, row) => sum + row.clientAmount, 0)
	);
	const payoutSum = round2(
		rows.reduce((sum, row) => sum + row.payoutAmount, 0)
	);
	if (
		Math.abs(clientSum - Number(totalGuestAmount || 0)) > 0.01 ||
		Math.abs(payoutSum - Number(totalPayoutAmount || 0)) > 0.01
	) {
		return [];
	}
	return rows.map((row, index) => ({
		date: dateRange[index],
		clientAmount: row.clientAmount,
		payoutAmount: row.payoutAmount,
		currency,
	}));
}

function convertDirectTripNightlyPricing(
	sourceRows = [],
	{
		totalGuestAmountSar = 0,
		totalPayoutAmountSar = 0,
		exchangeRateToSar = 0,
	} = {}
) {
	if (!sourceRows.length) return [];
	const clientAmountsSar = allocateConvertedSourceAmounts(
		sourceRows.map((row) => row.clientAmount),
		totalGuestAmountSar,
		exchangeRateToSar
	);
	const payoutAmountsSar = allocateConvertedSourceAmounts(
		sourceRows.map((row) => row.payoutAmount),
		totalPayoutAmountSar,
		exchangeRateToSar
	);
	if (
		clientAmountsSar.length !== sourceRows.length ||
		payoutAmountsSar.length !== sourceRows.length
	) {
		return [];
	}
	return sourceRows.map((row, index) => ({
		date: row.date,
		clientAmountSar: clientAmountsSar[index],
		payoutAmountSar: payoutAmountsSar[index],
	}));
}

function extractDirectTripFields(email = {}, text = "", provider = "") {
	const source = `${email.subject || ""}\n${text || ""}`;
	const directTripSender = knownBookingSourceProvider(email.from || "") === "trip";
	const templateMatched =
		provider === "trip" &&
		directTripSender &&
		/\b(?:Booking|Reservation)\s+no\.?\s*#?\s*\d{12,18}\b/i.test(source) &&
		/\bStaying\s+period\s*:/i.test(source) &&
		/\bFinal\s+room\s+rate\s*\(incl\.\s*taxes\s+and\s+fees\)/i.test(
			source
		) &&
		/\bYour\s+payout(?=\s|[A-Z]{3}|US\$|\$|[0-9])/i.test(source);
	if (!templateMatched) return {};

	const confirmationNumbers = extractDirectTripConfirmationNumbers(source);
	const confirmationNumberConflict = confirmationNumbers.length > 1;
	const confirmationNumber =
		confirmationNumbers.length === 1 ? confirmationNumbers[0] : "";
	const datePattern = dateTextPattern();
	const stayMatch = source.match(
		new RegExp(
			`\\bStaying\\s+period\\s*:\\s*(${datePattern})\\s*(?:\\u2014|\\u2013|-)\\s*(${datePattern})\\s*\\|\\s*(\\d+)\\s+nights?`,
			"i"
		)
	);
	const roomMatches = Array.from(
		String(text || "").matchAll(
			/\bRoom\s+Type\s*:\s*([\s\S]{2,360}?)\s*\|\s*(\d+)\s+room\(s\)/gi
		)
	).map((match) => ({
		roomName: cleanFieldValue(match[1] || ""),
		roomCount: Number(match[2] || 0),
	}));
	const uniqueRoomBlocks = Array.from(
		new Map(
			roomMatches
				.filter((room) => room.roomName && room.roomCount > 0)
				.map((room) => [
					`${normalizeComparable(room.roomName)}:${room.roomCount}`,
					room,
				])
		).values()
	);
	const firstRoom = uniqueRoomBlocks[0] || {};
	const roomRateMatches = Array.from(
		source.matchAll(
			/\bRoom\s+rate\s+(\d+)\s+room\(s\)\s*[x\u00d7]\s*(\d+)\s+night\(s\)/gi
		)
	);
	const declaredRoomCounts = [
		...uniqueRoomBlocks.map((room) => Number(room.roomCount || 0)),
		...roomRateMatches.map((match) => Number(match[1] || 0)),
	].filter((count) => count > 0);
	const uniqueDeclaredRoomCounts = [...new Set(declaredRoomCounts)];
	const roomCountConflict = uniqueDeclaredRoomCounts.length > 1;
	const roomCount = roomCountConflict
		? 0
		: uniqueDeclaredRoomCounts[0] || firstRoom.roomCount || 0;
	const checkinDate = parseDate(stayMatch?.[1] || "");
	const checkoutDate = parseDate(stayMatch?.[2] || "");
	const stayNights = Number(stayMatch?.[3] || 0);
	const calendarNights = calculateDaysOfResidence(checkinDate, checkoutDate);
	const declaredRoomRateNights = roomRateMatches
		.map((match) => Number(match[2] || 0))
		.filter((nights) => nights > 0);
	const uniqueDeclaredRoomRateNights = [...new Set(declaredRoomRateNights)];
	const stayNightConflict = !!(
		(stayNights > 0 && calendarNights > 0 && stayNights !== calendarNights) ||
		uniqueDeclaredRoomRateNights.length > 1 ||
		uniqueDeclaredRoomRateNights.some(
			(nights) =>
				(calendarNights > 0 && nights !== calendarNights) ||
				(stayNights > 0 && nights !== stayNights)
		)
	);
	const occupancy = source.match(
		/\bGuests\s*\(estimated\)\s*:\s*(\d+)\s+adults?(?:\s*[,|+]\s*(\d+)\s+child(?:ren)?)?/i
	);
	const adults = Number(occupancy?.[1] || 0);
	const children = Number(occupancy?.[2] || 0);

	const paymentBlock =
		source.match(
			/\bPayment\s+information\b([\s\S]{1,1800}?)(?=\bRoom\s+rate\s*Price\s+details\b)/i
		)?.[1] || source;
	const finalRateText = findFirstPattern(paymentBlock, [
		/\bFinal\s+room\s+rate\s*\(incl\.\s*taxes\s+and\s+fees\)\s*((?:(?:[A-Z]{3}|US\$|\$)\s*)?[0-9][0-9,.]*)/i,
	]);
	const payoutText = findFirstPattern(paymentBlock, [
		/\bYour\s+payout\s*((?:(?:[A-Z]{3}|US\$|\$)\s*)?[0-9][0-9,.]*)/i,
	]);
	const finalRate = parseMoney(finalRateText);
	const payout = parseMoney(payoutText);
	const finalRateCurrency = normalizeMoneyCurrency(finalRate.currency || "");
	const payoutCurrency = normalizeMoneyCurrency(payout.currency || "");
	const pricingCurrencyConflict = !!(
		finalRateCurrency &&
		payoutCurrency &&
		finalRateCurrency !== payoutCurrency
	);
	const currency = pricingCurrencyConflict
		? ""
		: payoutCurrency || finalRateCurrency || "";
	const pricingIsConsistent =
		!pricingCurrencyConflict &&
		finalRate.amount > 0 &&
		payout.amount > 0 &&
		!!currency &&
		payout.amount <= finalRate.amount + 0.01;
	const guestConversion = pricingIsConsistent
		? getSarConversionMeta(finalRate.amount, currency)
		: {};
	const payoutConversion = pricingIsConsistent
		? getSarConversionMeta(payout.amount, currency)
		: {};
	const guestTotalSar =
		guestConversion.totalAmountSar === null ||
		guestConversion.totalAmountSar === undefined
			? null
			: Number(guestConversion.totalAmountSar);
	const payoutTotalSar =
		payoutConversion.totalAmountSar === null ||
		payoutConversion.totalAmountSar === undefined
			? null
			: Number(payoutConversion.totalAmountSar);
	const exchangeRateToSar =
		guestConversion.exchangeRateToSar === null ||
		guestConversion.exchangeRateToSar === undefined
			? null
			: Number(guestConversion.exchangeRateToSar);
	const nightlyPricingSource = pricingIsConsistent
		? extractDirectTripNightlySourceRows(text, {
				dateRange: generateDateRange(checkinDate, checkoutDate),
				roomCount,
				currency,
				totalGuestAmount: finalRate.amount,
				totalPayoutAmount: payout.amount,
		  })
		: [];
	const nightlyPricingSar = convertDirectTripNightlyPricing(
		nightlyPricingSource,
		{
			totalGuestAmountSar: guestTotalSar ?? 0,
			totalPayoutAmountSar: payoutTotalSar ?? 0,
			exchangeRateToSar: exchangeRateToSar ?? 0,
		}
	);
	const prepaid =
		/\bNet\s+rate\s*[|\uff5c]\s*Prepaid\b/i.test(source) ||
		/\bThis\s+is\s+a\s+prepaid\s+reservation\b[\s\S]{0,160}?\bguest\s+has\s+already\s+paid\b/i.test(
			source
		);
	const hotelName = cleanFieldValue(
		findFirstPattern(text, [
			/(?:^|\n)\s*([^\n]{2,120}\bHotel)\s*\n\s*Guest\s+Name\s*:/i,
		])
	);
	const guestName = cleanFieldValue(
		findNextLineAfterExactLabel(text, "Guest Name", 3)
	);

	return {
		templateMatched: true,
		confirmationNumber,
		confirmationNumberConflict,
		pricingCurrencyConflict,
		hotelName,
		guestName,
		roomName: firstRoom.roomName || "",
		roomCount,
		roomCountConflict,
		checkinDate,
		checkoutDate,
		stayNights,
		stayNightConflict,
		adults,
		children,
		totalGuests: adults + children,
		amountText: pricingIsConsistent ? `${currency} ${finalRate.amount}` : "",
		amount: pricingIsConsistent ? finalRate.amount : 0,
		currency: pricingIsConsistent ? currency : "",
		totalAmountSar: guestTotalSar,
		sourceAmount: pricingIsConsistent ? finalRate.amount : 0,
		sourceCurrency: pricingIsConsistent ? currency : "",
		exchangeRateToSar,
		exchangeRateSource: guestConversion.exchangeRateSource || "",
		amountConvertedAt: guestConversion.convertedAt || "",
		totalPayoutSar: payoutTotalSar,
		netAfterExpensesTotal: payoutTotalSar,
		paymentSummary: pricingIsConsistent
			? {
					sourceCurrency: currency,
					sourceTotalGuestPaymentAmount: finalRate.amount,
					sourceTotalPayoutAmount: payout.amount,
					totalGuestPaymentAmount: guestTotalSar,
					totalPayoutAmount: payoutTotalSar,
					currency: "SAR",
					exchangeRateToSar,
					exchangeRateSource: guestConversion.exchangeRateSource || "",
					amountConvertedAt: guestConversion.convertedAt || "",
			  }
			: {},
		paymentCollectionModel: prepaid ? "ota_collect" : "unknown",
		paymentInstructions: prepaid
			? "Trip.com prepaid reservation; the guest has already paid the platform."
			: "",
		pricingIsConsistent,
		nightlyPricingSource,
		nightlyPricingSar,
		multipleRoomBlocks: uniqueRoomBlocks.length > 1,
	};
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

const TRUSTED_OTA_SENDER_DOMAINS = Object.freeze({
	expedia: ["expedia.com", "expediagroup.com", "expediapartnercentral.com"],
	hotels: ["hotels.com"],
	booking: ["booking.com"],
	agoda: ["agoda.com"],
	airbnb: ["airbnb.com"],
	hotelrunner: ["hotelrunner.com"],
	trip: ["trip.com"],
});

function parseSingleSenderMailbox(value = "") {
	const source = normalizeWhitespace(value);
	if (!source) return "";
	let candidate = source;
	if (/[<>]/.test(source)) {
		// A display name can itself contain an address-like string. Only the sole
		// RFC-style angle-bracket mailbox is authoritative; malformed or multiple
		// mailbox forms fail closed.
		const angleMatch = source.match(/^([^<>]*)<([^<>]*)>\s*$/);
		if (!angleMatch) return "";
		const displayName = normalizeWhitespace(angleMatch[1] || "");
		if (/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+/i.test(displayName)) {
			return "";
		}
		candidate = normalizeWhitespace(angleMatch[2]);
	}

	const mailboxMatch = candidate.match(
		/^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@([A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+)$/i
	);
	return mailboxMatch ? candidate.toLowerCase() : "";
}

function trustedProviderFromDomain(value = "") {
	const domain = normalizeWhitespace(value).toLowerCase().replace(/^@/, "");
	if (!domain || !/^[a-z0-9.-]+$/.test(domain)) return "";
	for (const [provider, trustedDomains] of Object.entries(
		TRUSTED_OTA_SENDER_DOMAINS
	)) {
		if (
			trustedDomains.some(
				(trustedDomain) =>
					domain === trustedDomain || domain.endsWith(`.${trustedDomain}`)
			)
		) {
			return provider;
		}
	}
	return "";
}

function trustedProviderFromSenderAddress(value = "") {
	const mailbox = parseSingleSenderMailbox(value);
	if (!mailbox) return "";
	const domain = mailbox.slice(mailbox.lastIndexOf("@") + 1);
	return trustedProviderFromDomain(domain);
}

function senderDomainsAreAligned(fromDomain = "", authenticationDomain = "") {
	const from = normalizeWhitespace(fromDomain).toLowerCase().replace(/^@/, "");
	const authenticated = normalizeWhitespace(authenticationDomain)
		.toLowerCase()
		.replace(/^@/, "");
	return !!(
		from &&
		authenticated &&
		(from === authenticated ||
			from.endsWith(`.${authenticated}`) ||
			authenticated.endsWith(`.${from}`))
	);
}

function parseSendGridEnvelopeMailbox(value) {
	let envelope = value;
	if (typeof envelope === "string") {
		try {
			envelope = JSON.parse(envelope);
		} catch (_error) {
			return "";
		}
	}
	if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
		return "";
	}
	return parseSingleSenderMailbox(envelope.from || "");
}

function parseSendGridDkimResults(value = "") {
	if (typeof value !== "string" || value.length > 5000) return [];
	const results = [];
	const pattern = /@?([a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?)\s*:\s*(pass|fail|none|neutral|policy|temperror|permerror)\b/gi;
	for (const match of value.matchAll(pattern)) {
		const domain = String(match[1] || "").toLowerCase();
		const result = String(match[2] || "").toLowerCase();
		if (domain && result) results.push({ domain, result });
	}
	return results;
}

function evaluateTrustedSenderAuthentication({
	from = "",
	spf = "",
	dkim = "",
	envelope = null,
} = {}) {
	const fromMailbox = parseSingleSenderMailbox(from);
	const fromDomain = fromMailbox.slice(fromMailbox.lastIndexOf("@") + 1);
	const trustedProvider = trustedProviderFromDomain(fromDomain);
	if (!fromMailbox) {
		return {
			evaluated: true,
			authenticatedAligned: false,
			trustedProvider: "",
			fromDomain: "",
			method: "",
			reason: "invalid_sender_mailbox",
		};
	}
	if (!trustedProvider) {
		return {
			evaluated: true,
			authenticatedAligned: false,
			trustedProvider: "",
			fromDomain,
			method: "",
			reason: "untrusted_sender_domain",
		};
	}

	const envelopeMailbox = parseSendGridEnvelopeMailbox(envelope);
	const envelopeFromDomain = envelopeMailbox.slice(
		envelopeMailbox.lastIndexOf("@") + 1
	);
	const spfResult =
		typeof spf === "string" ? normalizeWhitespace(spf).toLowerCase() : "";
	const spfAlignedPass = !!(
		spfResult === "pass" &&
		envelopeMailbox &&
		senderDomainsAreAligned(fromDomain, envelopeFromDomain)
	);
	const dkimResults = parseSendGridDkimResults(dkim);
	const alignedDkimPassDomains = Array.from(
		new Set(
			dkimResults
				.filter(
					(result) =>
						result.result === "pass" &&
						senderDomainsAreAligned(fromDomain, result.domain)
				)
				.map((result) => result.domain)
		)
	);
	const dkimAlignedPass = alignedDkimPassDomains.length > 0;
	const methods = [
		...(spfAlignedPass ? ["spf"] : []),
		...(dkimAlignedPass ? ["dkim"] : []),
	];
	const authenticatedAligned = methods.length > 0;
	const hasAuthenticationEvidence = !!(spfResult || dkimResults.length);
	const hasUnalignedPass = !!(
		spfResult === "pass" ||
		dkimResults.some((result) => result.result === "pass")
	);

	return {
		evaluated: true,
		authenticatedAligned,
		trustedProvider,
		fromDomain,
		envelopeFromDomain,
		spfResult,
		spfAlignedPass,
		dkimAlignedPass,
		alignedDkimPassDomains,
		method: methods.join("+"),
		reason: authenticatedAligned
			? "authenticated_aligned_sender"
			: !hasAuthenticationEvidence
			? "missing_sender_authentication"
			: hasUnalignedPass
			? "sender_authentication_not_aligned"
			: "sender_authentication_failed",
	};
}

function detectProvider({ from = "", to = "", subject = "", text = "" } = {}) {
	// A direct, unambiguous OTA sender is stronger evidence than footer/body
	// mentions of other platforms. HotelRunner is a relay: only an explicit,
	// line-anchored source field or one unique template signature may select a
	// commercial provider namespace. Incidental guest notes and footer prose are
	// never provider evidence. Trip.com intentionally remains in HotelRunner's
	// transport namespace and uses its separately verified cross-transport key.
	const directSenderProvider = trustedProviderFromSenderAddress(from);
	if (directSenderProvider && directSenderProvider !== "hotelrunner") {
		return directSenderProvider;
	}
	if (directSenderProvider === "hotelrunner") {
		const explicitSource = extractExplicitHotelRunnerBookingSourceField(text);
		const commercialProviders = Array.from(
			new Set([
				...embeddedBookingSourceProviders(`${subject || ""}\n${text || ""}`),
				...knownBookingSourceProviders(explicitSource).filter(
					(provider) => provider !== "hotelrunner"
				),
			])
		);
		if (commercialProviders.length === 1 && commercialProviders[0] !== "trip") {
			return commercialProviders[0];
		}
		return "hotelrunner";
	}
	const haystack = `${to} ${subject} ${text}`.toLowerCase();
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

const BOOKING_SOURCE_EVIDENCE_PATTERNS = [
	[
		"expedia",
		/(?:^|\n)\s*expedia(?:\s*\([^\n)]{0,100}\))?\s*(?:\n|$)|(?:^|\n)[ \t]*expedia[ \t]+booking[ \t]*(?:id|number|no\.?|code|#)[ \t]*(?:[:#-][ \t]*)?[a-z0-9][a-z0-9-]{4,23}\b|\bexpedia\s+collects?\s+payment\b|\bpayment\s+method\s*:\s*expedia\s*collect\b/i,
	],
	[
		"hotels",
		/(?:^|\n)\s*hotels\.com(?:\s*\([^\n)]{0,100}\))?\s*(?:\n|$)|(?:^|\n)[ \t]*hotels\.com[ \t]+booking[ \t]*(?:id|number|no\.?|code|#)[ \t]*(?:[:#-][ \t]*)?[a-z0-9][a-z0-9-]{4,23}\b/i,
	],
	[
		"booking",
		/(?:^|\n)\s*booking\.com(?:\s*\([^\n)]{0,100}\))?\s*(?:\n|$)|(?:^|\n)[ \t]*booking\.com[ \t]+booking[ \t]*(?:id|number|no\.?|code|#)[ \t]*(?:[:#-][ \t]*)?[a-z0-9][a-z0-9-]{4,23}\b/i,
	],
	[
		"agoda",
		/(?:^|\n)\s*agoda(?:\s*\([^\n)]{0,100}\))?\s*(?:\n|$)|(?:^|\n)[ \t]*agoda[ \t]+booking[ \t]*(?:id|number|no\.?|code|#)[ \t]*(?:[:#-][ \t]*)?[a-z0-9][a-z0-9-]{4,23}\b|\bpayment\s*:\s*(?:merchant|merchance)\s+booking\s*\(\s*agoda\s+collect\s*\)/i,
	],
	[
		"airbnb",
		/(?:^|\n)\s*airbnb(?:\s*\([^\n)]{0,100}\))?\s*(?:\n|$)|(?:^|\n)[ \t]*airbnb[ \t]+booking[ \t]*(?:id|number|no\.?|code|#)[ \t]*(?:[:#-][ \t]*)?[a-z0-9][a-z0-9-]{4,23}\b|\bairbnb\s+(?:confirmation|reservation)\s+code\b/i,
	],
	[
		"trip",
		/(?:^|\n)\s*trip\.com(?:\s+(?:v\d+|[a-z]{2}))?\s*(?:\n|$)|(?:^|\n)[ \t]*trip\.com[ \t]+booking[ \t]*(?:id|number|no\.?|code|#)[ \t]*(?:[:#-][ \t]*)?[a-z0-9][a-z0-9-]{4,23}\b|\bthis\s+booking\s+was\s+made\s+through\s+trip\.com\b|@guest\.trip\.com\b|\bctrip\s+group\s+brand\b/i,
	],
];

const HOTELRUNNER_BOOKING_SOURCE_NOTE_LABEL_PATTERN =
	/^\s*(?:(?:guest|customer|booking|reservation)\s+(?:notes?|comments?|remarks?|messages?|requests?)|(?:guest\s+)?special\s+requests?|notes?|comments?|remarks?)\s*(?:[:#-]|$)/i;
const HOTELRUNNER_BOOKING_SOURCE_NOTE_STOP_LABEL_PATTERN =
	/^\s*(?:booking\s+source|reservation\s+source|source|supplier|travel\s+agency|agency|hotel(?:\s+name)?|property(?:\s+name)?|accommodation|guest\s+name|customer\s+(?:first|last)\s+name|confirmation\s*(?:number|no\.?|code|id|#)|booking\s*(?:id|number|no\.?|code|#)|reservation\s*(?:id|number|no\.?|code|#)|room(?:\s+(?:type|name|count))?|check[-\s]?in(?:\s+date)?|check[-\s]?out(?:\s+date)?|arrival(?:\s+date)?|departure(?:\s+date)?|order\s+total|grand\s+total|total\s+(?:amount|price|rate)|net\s+(?:amount|rate|payout)|amount|price|rate|currency|payment(?:\s+(?:method|type|status|instructions?))?|payout|adults?|children|infants?|guests?|occupancy|status|meal(?:\s+plan)?|board)\s*(?:[:#-]|$)/i;
const HOTELRUNNER_EXPLICIT_BOOKING_SOURCE_LINE_PATTERN =
	/^\s*(?:booking\s+source|reservation\s+source|source|supplier|travel\s+agency|agency)\s*(?:[:#-]|is\b|$)/i;
const HOTELRUNNER_EXPLICIT_IDENTITY_LINE_PATTERN =
	/^\s*(?:(?:agoda|booking\.com|expedia|trip\.com|airbnb|hotels\.com)\s+)?(?:confirmation|booking|reservation)\s*(?:number|no\.?|code|id|#)\s*(?:[:#-]\s*(?:[a-z0-9][a-z0-9-]{4,23}\b)?|[a-z0-9][a-z0-9-]{4,23}\b|$)/i;
const HOTELRUNNER_COMMERCIAL_PAYMENT_SIGNATURE_LINE_PATTERN =
	/^\s*(?:payment\s+method\s*:\s*expedia\s*collect|payment\s*:\s*(?:merchant|merchance)\s+booking\s*\(\s*agoda\s+collect\s*\)|expedia\s+collects?\s+payment)\b/i;

function stripHotelRunnerGuestNoteBlocksForBookingSourceEvidence(value = "") {
	const lines = String(value || "").replace(/\r/g, "").split("\n");
	let insideNoteBlock = false;
	let noteHasContent = false;
	let noteSeparatedByBlankLine = false;
	return lines
		.map((line) => {
			if (HOTELRUNNER_BOOKING_SOURCE_NOTE_LABEL_PATTERN.test(line)) {
				insideNoteBlock = true;
				noteHasContent = false;
				noteSeparatedByBlankLine = false;
				return "";
			}
			if (insideNoteBlock && !normalizeWhitespace(line)) {
				if (noteHasContent) noteSeparatedByBlankLine = true;
				return "";
			}
			const isExplicitSourceLine =
				HOTELRUNNER_EXPLICIT_BOOKING_SOURCE_LINE_PATTERN.test(line);
			const isExplicitIdentityLine =
				HOTELRUNNER_EXPLICIT_IDENTITY_LINE_PATTERN.test(line);
			const isCommercialPaymentLine =
				HOTELRUNNER_COMMERCIAL_PAYMENT_SIGNATURE_LINE_PATTERN.test(line);
			if (
				insideNoteBlock &&
				(HOTELRUNNER_BOOKING_SOURCE_NOTE_STOP_LABEL_PATTERN.test(line) ||
					isExplicitSourceLine ||
					isExplicitIdentityLine ||
					isCommercialPaymentLine)
			) {
				// A source-looking first line is still the value of the note/request,
				// not template metadata. A later source field is accepted only after
				// an actual blank-line boundary. Identity-looking note content follows
				// the same rule so it cannot replace the OTA confirmation namespace.
				// Commercial payment-looking prose inside the note is isolated too.
				if (
					(isExplicitSourceLine ||
						isExplicitIdentityLine ||
						isCommercialPaymentLine) &&
					!noteSeparatedByBlankLine
				) {
					noteHasContent = true;
					return "";
				}
				insideNoteBlock = false;
				return line;
			}
			if (insideNoteBlock) {
				noteHasContent = true;
				return "";
			}
			return line;
		})
		.join("\n");
}

function knownBookingSourceProviders(value = "") {
	const source = normalizeWhitespace(value);
	if (!source) return [];
	const providers = new Set();
	if (/\bexpedia(?:\s+group)?\b|expediapartnercentral/i.test(source)) {
		providers.add("expedia");
	}
	if (/\bhotels\.com\b/i.test(source)) providers.add("hotels");
	if (/\bbooking\.com\b/i.test(source)) providers.add("booking");
	if (/\bagoda\b/i.test(source)) providers.add("agoda");
	if (/\bairbnb\b/i.test(source)) providers.add("airbnb");
	if (/\btrip\.com\b|\bctrip\b/i.test(source)) providers.add("trip");
	if (/\bhotel\s*runner\b/i.test(source)) providers.add("hotelrunner");
	return [...providers];
}

function knownBookingSourceProvider(value = "") {
	const providers = knownBookingSourceProviders(value);
	return providers.length === 1 ? providers[0] : "";
}

function extractExplicitHotelRunnerBookingSourceField(value = "") {
	const lines = normalizedLines(
		stripHotelRunnerGuestNoteBlocksForBookingSourceEvidence(value)
	);
	const fieldPattern =
		/^\s*(?:booking\s+source|reservation\s+source|source|supplier|travel\s+agency|agency)\s*(?:[:#-]|is\b)?\s*(.*)$/i;
	for (let index = 0; index < lines.length; index += 1) {
		const match = lines[index].match(fieldPattern);
		if (!match) continue;
		const sameLine = normalizeWhitespace(match[1] || "");
		if (knownBookingSourceProviders(sameLine).length) return sameLine;
		if (!sameLine) {
			const nextLine = normalizeWhitespace(lines[index + 1] || "");
			if (knownBookingSourceProviders(nextLine).length) return nextLine;
		}
	}
	return "";
}

function embeddedBookingSourceProviders(value = "") {
	const source = stripHotelRunnerGuestNoteBlocksForBookingSourceEvidence(value);
	if (!source) return [];
	const providers = Array.from(
		new Set(
			BOOKING_SOURCE_EVIDENCE_PATTERNS.filter(([, pattern]) =>
				pattern.test(source)
			).map(([provider]) => provider)
		)
	);
	return providers;
}

function embeddedBookingSourceProvider(value = "") {
	const providers = embeddedBookingSourceProviders(value);
	return providers.length === 1 ? providers[0] : "";
}

function resolveBookingSource({
	provider = "",
	providerLabel = "",
	from = "",
	subject = "",
	text = "",
	explicitSource = "",
} = {}) {
	// A direct OTA sender is authoritative. HotelRunner is a relay, so its
	// envelope must not hide a source explicitly embedded in the reservation.
	const envelopeProvider = detectProvider({ from });
	if (envelopeProvider && !["unknown", "hotelrunner"].includes(envelopeProvider)) {
		return PROVIDER_LABELS[envelopeProvider] || envelopeProvider;
	}

	const explicitProviders = knownBookingSourceProviders(explicitSource);
	const explicitProvider =
		explicitProviders.length === 1 ? explicitProviders[0] : "";
	const embeddedProviders = embeddedBookingSourceProviders(
		`${subject || ""}\n${text || ""}`
	);
	if (envelopeProvider === "hotelrunner") {
		const commercialProviders = Array.from(
			new Set([
				...embeddedProviders,
				...explicitProviders.filter(
					(sourceProvider) => sourceProvider !== "hotelrunner"
				),
			])
		);
		if (commercialProviders.length === 1) {
			return (
				PROVIDER_LABELS[commercialProviders[0]] || commercialProviders[0]
			);
		}
		return PROVIDER_LABELS.hotelrunner;
	}
	if (explicitProvider && explicitProvider !== "hotelrunner") {
		return PROVIDER_LABELS[explicitProvider] || explicitProvider;
	}
	const embeddedProvider =
		embeddedProviders.length === 1 ? embeddedProviders[0] : "";
	// HotelRunner is a transport relay. A sole, strong OTA signature embedded
	// in the booking is the actual commercial source even when a generic Source
	// field repeats HotelRunner. Conflicting embedded OTAs return no provider
	// from embeddedBookingSourceProvider and therefore fail closed here.
	if (
		explicitProvider === "hotelrunner" &&
		embeddedProvider &&
		embeddedProvider !== "hotelrunner"
	) {
		return PROVIDER_LABELS[embeddedProvider] || embeddedProvider;
	}
	if (explicitProvider) return PROVIDER_LABELS[explicitProvider] || explicitProvider;
	if (normalizeWhitespace(explicitSource)) {
		return normalizeWhitespace(explicitSource).slice(0, 80);
	}

	if (embeddedProvider) return PROVIDER_LABELS[embeddedProvider] || embeddedProvider;

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

function hasArabicCancellationSignal(value = "") {
	const source = String(value || "");
	const requestOrPolicy =
		/(?:\u0637\u0644\u0628|\u0633\u064a\u0627\u0633\u0629|\u0631\u0633\u0648\u0645|\u0627\u0633\u062a\u0641\u0633\u0627\u0631)\s+(?:\u0627\u0644)?(?:\u0625\u0644\u063a\u0627\u0621|\u0627\u0644\u063a\u0627\u0621)/i.test(
			source
		);
	if (requestOrPolicy) return false;
	return /(?:^|[\n\r\-:\s])(?:\u062a\u0645\s+)?(?:\u0625\u0644\u063a\u0627\u0621|\u0627\u0644\u063a\u0627\u0621)\s+(?:\u0627\u0644)?\u062d\u062c\u0632(?:\s|#|$)|(?:\u0627\u0644)?\u062d\u062c\u0632\s+(?:\u0645\u0644\u063a\u064a|\u0645\u0644\u063a\u0649|\u0623\u0644\u063a\u064a)/i.test(
		source
	);
}

function allocateConvertedSourceAmounts(
	sourceAmounts = [],
	targetTotalSar = 0,
	exchangeRateToSar = 0
) {
	const amounts = sourceAmounts.map((value) => Number(value || 0));
	const rate = Number(exchangeRateToSar || 0);
	const targetCents = Math.round(Number(targetTotalSar || 0) * 100);
	if (
		!amounts.length ||
		amounts.some((value) => !Number.isFinite(value) || value < 0) ||
		!Number.isFinite(rate) ||
		rate <= 0 ||
		targetCents < 0
	) {
		return [];
	}

	const exactCents = amounts.map((value) => value * rate * 100);
	const allocatedCents = exactCents.map((value) => Math.floor(value + 1e-9));
	let remaining = targetCents - allocatedCents.reduce((sum, value) => sum + value, 0);
	const descendingRemainders = exactCents
		.map((value, index) => ({
			index,
			remainder: Number(
				(value - Math.floor(value + 1e-9)).toFixed(6)
			),
		}))
		.sort((left, right) =>
			right.remainder !== left.remainder
				? right.remainder - left.remainder
				: left.index - right.index
		);
	const ascendingRemainders = [...descendingRemainders].reverse();
	const maxAdjustment = amounts.length * 2;
	if (Math.abs(remaining) > maxAdjustment) return [];
	let cursor = 0;
	while (remaining !== 0) {
		const order = remaining > 0 ? descendingRemainders : ascendingRemainders;
		const selected = order[cursor % order.length];
		if (remaining > 0) {
			allocatedCents[selected.index] += 1;
			remaining -= 1;
		} else if (allocatedCents[selected.index] > 0) {
			allocatedCents[selected.index] -= 1;
			remaining += 1;
		}
		cursor += 1;
		if (cursor > maxAdjustment * 2) return [];
	}
	return allocatedCents.map((value) => value / 100);
}

function hasArabicModificationSignal(value = "") {
	const source = String(value || "");
	return /(?:^|[\n\r\-:\s])(?:\u062a\u0645\s+)?(?:\u062a\u062d\u062f\u064a\u062b|\u062a\u0639\u062f\u064a\u0644|\u062a\u063a\u064a\u064a\u0631)\s+(?:\u0627\u0644)?\u062d\u062c\u0632(?:\s|#|$)/i.test(
		source
	);
}

function hasStrongNewReservationSignal(value = "") {
	const subjectOnly = String(value || "").toLowerCase();
	if (
		/(cancelled|canceled|cancellation|cancelation|no[-\s]?show)/i.test(
			subjectOnly
		) ||
		hasArabicCancellationSignal(subjectOnly)
	) {
		return false;
	}
	if (
		/(modified|modification|changed|updated|amended|amendment)/i.test(
			subjectOnly
		) ||
		hasArabicModificationSignal(subjectOnly)
	) {
		return false;
	}
	return /(new booking(?:\s+confirmed)?|new reservation|reservation confirmation|reservation confirmed|booking confirmation|confirmed reservation|booking confirmed|confirmed booking|booking\s+id\s+[a-z0-9-]{5,}\s+-\s+confirmed|حجز\s+جديد)/i.test(
		subjectOnly
	);
}

function hasActionableCancellationSignal(subject = "", text = "") {
	const subjectOnly = String(subject || "").toLowerCase();
	const body = String(text || "").toLowerCase();
	if (hasArabicCancellationSignal(subjectOnly)) return true;
	if (
		/(?:^|\n)\s*(?:\u062a\u0645\s+)?(?:\u0625\u0644\u063a\u0627\u0621|\u0627\u0644\u063a\u0627\u0621)\s+(?:\u0627\u0644)?\u062d\u062c\u0632(?:\s|#|$)/i.test(
			body
		)
	) {
		return true;
	}
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
	if (
		/(modified|modification|changed|updated|amended|amendment)/i.test(
			haystack
		) ||
		hasArabicModificationSignal(subjectOnly)
	) {
		return "modified";
	}
	if (/(?:^|\n)\s*status\s+booked\b/i.test(String(text || ""))) {
		return "new";
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
		/(reservation|booking|confirmation|check[\s-]?in|check[\s-]?out|arrival|departure|guest|hotel|property|room|status|حجز|رقم\s*التأكيد|تاريخ\s*تسجيل\s*الوصول|تاريخ\s*تسجيل\s*المغادرة)/i.test(
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

function extractCardLast4(
	text,
	{ allowUnlabeledCardNumber = false, excludedNumbers = [] } = {}
) {
	const source = String(text || "");
	const excluded = new Set(
		(excludedNumbers || [])
			.map((value) => String(value || "").replace(/\D/g, ""))
			.filter(Boolean)
	);
	if (allowUnlabeledCardNumber) {
		for (const redactedCard of source.matchAll(/\[CARD-(\d{4})\]/gi)) {
			const start = Number(redactedCard.index || 0);
			const localContext = source.slice(
				Math.max(0, start - 100),
				start + redactedCard[0].length + 100
			);
			const locallyCardLabeled =
				/(?:virtual\s+card|\bvcc\b|card\s+(?:number|no\.?|details?|information)|validation\s+code|security\s+code|cvv|cvc)/i.test(
					localContext
				);
			const locallyUrlLike =
				/https?:\/\/|www\.|[?&][a-z0-9_.-]+\s*=/i.test(localContext);
			if (locallyCardLabeled && !locallyUrlLike) return redactedCard[1];
		}
	}
	const nearCard = findFirstPattern(text, [
		/\b(?:card number|card no\.?|pan)\s*[:#-]?\s*((?:\d[\s-]*){13,19})\b/i,
	]);
	const clean = String(nearCard || "").replace(/\D/g, "");
	if (clean.length >= 4 && !excluded.has(clean)) return clean.slice(-4);

	// A 15-19 digit OTA confirmation can look exactly like a card PAN. Only
	// consider an unlabeled long number when the same message has explicit card
	// context, and never reuse the already-extracted reservation identity.
	if (!allowUnlabeledCardNumber) return "";
	for (const match of source.matchAll(/\b(?:\d[ -]*?){15,19}\b/g)) {
		const digits = String(match[0] || "").replace(/\D/g, "");
		const start = Number(match.index || 0);
		const localContext = source.slice(
			Math.max(0, start - 100),
			start + match[0].length + 100
		);
		const locallyUrlLike =
			/https?:\/\/|www\.|[?&][a-z0-9_.-]+\s*=/i.test(localContext);
		if (
			digits.length >= 15 &&
			!excluded.has(digits) &&
			!locallyUrlLike &&
			isLuhnValidCardNumber(digits)
		) {
			return digits.slice(-4);
		}
	}
	return "";
}

function isLuhnValidCardNumber(value = "") {
	const digits = String(value || "").replace(/\D/g, "");
	if (!/^\d{13,19}$/.test(digits) || /^(\d)\1+$/.test(digits)) return false;
	let sum = 0;
	let doubleDigit = false;
	for (let index = digits.length - 1; index >= 0; index -= 1) {
		let digit = Number(digits[index]);
		if (doubleDigit) {
			digit *= 2;
			if (digit > 9) digit -= 9;
		}
		sum += digit;
		doubleDigit = !doubleDigit;
	}
	return sum % 10 === 0;
}

function detectPaymentCollectionModel(paymentText = "", vcc = {}) {
	const haystack = String(paymentText || "").toLowerCase();
	const hasExpediaVirtualCard =
		/\bevc\b/i.test(haystack) &&
		/(\bexpedia\s*collects?\b|\bevc\s+charge\s+status\b)/i.test(haystack);
	const hasVirtualCard =
		/(virtual\s+card|\bvcc\b|card\s+number|validation\s+code|hotel\s+charges?\s+(?:the\s+)?virtual\s+card|charges?\s+(?:a\s+)?virtual\s+card)/i.test(
			haystack
		) ||
		hasExpediaVirtualCard ||
		!!vcc.cardLast4;
	if (hasVirtualCard) return "virtual_card";
	if (
		/(hotel\s*collect|hotel\s+collects|pay\s+at\s+(?:the\s+)?property|pay\s+at\s+(?:the\s+)?hotel|pay\s+on\s+arrival|guest\s+pays|traveler\s+pays|collect\s+from\s+guest)/i.test(
			haystack
		)
	) {
		return "hotel_collect";
	}
	if (
		/(\bexpedia\s*collects?\b|agoda\s+collect|booking\.com\s+collect|ota\s+collect|ota\s+collects|collected\s+by|platform\s+collect|prepaid|paid\s+online)/i.test(
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
		"sourceTotalPayoutCurrency",
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
	const safe = allowedFields.reduce((out, field) => {
		const value = summary[field];
		if (value === undefined || value === null || value === "") return out;
		if (typeof value === "number") out[field] = round2(value);
		else out[field] = value;
		return out;
	}, {});
	const sourceCurrency = String(safe.sourceCurrency || "")
		.trim()
		.toUpperCase();
	const propertyCurrency = String(
		safe.currency || summary.propertyCurrency || "SAR"
	)
		.trim()
		.toUpperCase();
	const trustedConversion = validatedTrustedExchangeRateEvidence(
		summary.currencyConversionEvidence,
		{
			sourceCurrency,
			propertyCurrency,
			rate: safe.exchangeRateToSar,
		}
	);
	if (trustedConversion) {
		safe.currencyConversionEvidence = trustedConversion;
	}
	return safe;
}

function resolvePaymentMapping(
	normalized = {},
	totalAmountSar = null,
	subTotalSar,
	commissionAmountSar = 0
) {
	const providerLabel =
		normalized.bookingSource || normalized.providerLabel || "OTA";
	const collectionModel = normalized.paymentCollectionModel || "unknown";
	const parsedTotal = Number(totalAmountSar);
	const totalKnown = Boolean(
		totalAmountSar !== undefined &&
			totalAmountSar !== null &&
			String(totalAmountSar).trim() !== "" &&
			Number.isFinite(parsedTotal) &&
			parsedTotal >= 0
	);
	const total = totalKnown ? round2(parsedTotal) : null;
	const parsedSubTotal = Number(subTotalSar);
	const subTotal =
		subTotalSar !== undefined &&
		subTotalSar !== null &&
		String(subTotalSar).trim() !== "" &&
		Number.isFinite(parsedSubTotal)
			? round2(parsedSubTotal)
			: total;
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
		if (!totalKnown) {
			return {
				payment: "ota collect - amount unavailable",
				financeStatus: "commercial review required",
				paidAmount: null,
				paidAmountBreakdown: {
					...emptyPaymentBreakdown(
						`${providerLabel} collection model reported; property-currency amount unavailable`
					),
					paid_online_other_platforms: null,
				},
				financialCycle: {
					collectionModel: "provider_collected_unresolved",
					status: "review_required",
					commissionType: "amount",
					commissionValue: commission,
					commissionAmount: commission,
					commissionAssigned: false,
					pmsCollectedAmount: null,
					hotelCollectedAmount: 0,
					hotelPayoutDue: null,
					commissionDueToPms: 0,
					lastUpdatedAt: new Date(),
				},
			};
		}
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
	const uniqueBlocks = Array.from(new Set(blocks));
	if (blocks.length > 1 && uniqueBlocks.length === 1) {
		const orderTotal = parseMoney(
			findFirstPattern(text, [
				/\bOrder\s+Total\s*[:#-]?\s*((?:[A-Z]{3}|US\$|\$|\uFDFC)?\s*[0-9][0-9,.]*)/i,
			])
		).amount;
		const repeatedBlockTotal = Number(uniqueBlocks[0].split("|").at(-1) || 0);
		if (
			orderTotal > 0 &&
			repeatedBlockTotal > 0 &&
			Math.abs(orderTotal - repeatedBlockTotal) <= 0.01
		) {
			return uniqueBlocks;
		}
	}
	return blocks;
}

function extractExplicitPrimaryConfirmationNumbers(text = "") {
	const source = String(text || "");
	const patterns = [
		/\bConfirmation\s*(?:Number|No\.?|Code|ID|#)\s*[:#-]?\s*([A-Z0-9-]{5,24})\b/gi,
		/\bBooking\s*(?:ID|Number|No\.?|Code|#)\s*[:#-]?\s*([A-Z0-9-]{5,24})\b/gi,
		/\bReservation\s*(?:ID|Number|No\.?|Code|#)\s*[:#-]?\s*([A-Z0-9-]{5,24})\b/gi,
	];
	const seen = new Set();
	return patterns
		.flatMap((pattern) =>
			Array.from(source.matchAll(pattern)).map((match) => match[1] || "")
		)
		.map(cleanConfirmationCandidate)
		.filter((candidate) => {
			const normalized = normalizeConfirmation(candidate);
			if (!normalized || seen.has(normalized)) return false;
			seen.add(normalized);
			return true;
		});
}

function extractHotelRunnerAuthoritativeConfirmationNumbers(text = "") {
	const seen = new Set();
	return Array.from(
		String(text || "").matchAll(
			/\bConfirmation\s*(?:Number|No\.?|Code|ID|#)\s*[:#-]?\s*([A-Z0-9-]{5,24})\b/gi
		)
	)
		.map((match) => cleanConfirmationCandidate(match[1] || ""))
		.filter((candidate) => {
			const normalized = normalizeConfirmation(candidate);
			if (!normalized || seen.has(normalized)) return false;
			seen.add(normalized);
			return true;
		});
}

function analyzeHotelRunnerProviderSpecificBookingIds(
	text = "",
	commercialProvider = ""
) {
	const providerAliases = {
		agoda: "agoda",
		"booking.com": "booking",
		expedia: "expedia",
		"trip.com": "trip",
		airbnb: "airbnb",
		"hotels.com": "hotels",
	};
	const valuesByProvider = new Map();
	const pattern =
		/(?:^|\n)[ \t]*(Agoda|Booking\.com|Expedia|Trip\.com|Airbnb|Hotels\.com)[ \t]+Booking[ \t]*(?:ID|Number|No\.?|Code|#)[ \t]*(?:[:#-][ \t]*)?([A-Z0-9][A-Z0-9-]{4,23})\b/gim;
	for (const match of String(text || "").replace(/\r/g, "").matchAll(pattern)) {
		const provider = providerAliases[String(match[1] || "").toLowerCase()] || "";
		const candidate = cleanConfirmationCandidate(match[2] || "");
		if (!provider || !candidate) continue;
		if (!valuesByProvider.has(provider)) valuesByProvider.set(provider, new Map());
		valuesByProvider
			.get(provider)
			.set(normalizeConfirmation(candidate), candidate);
	}

	const selectedProvider = normalizeComparable(commercialProvider).replace(
		/\s+/g,
		""
	);
	const selectedValues = Array.from(
		valuesByProvider.get(selectedProvider)?.values() || []
	);
	return {
		provider: selectedProvider,
		values: selectedValues,
		confirmationNumber: selectedValues.length === 1 ? selectedValues[0] : "",
		conflict: selectedValues.length > 1,
	};
}

function extractHotelRunnerConfirmationNumbers(text = "") {
	return extractExplicitPrimaryConfirmationNumbers(text);
}

function extractHotelRunnerConfirmationNumber(text = "") {
	return extractHotelRunnerConfirmationNumbers(text)[0] || "";
}

function extractNormalizedReservation(email) {
	const rawInboundText = `${email.subject || ""}\n${email.text || ""}\n${htmlToText(
		email.html || ""
	)}`;
	const text = normalizeWhitespace(rawInboundText);
	const provider = detectProvider({
		from: email.from,
		to: email.to,
		subject: email.subject,
		text,
	});
	const trustedTransportProvider = trustedProviderFromSenderAddress(
		email.from || ""
	);
	const senderAuthentication =
		email.senderAuthentication && typeof email.senderAuthentication === "object"
			? { ...email.senderAuthentication }
			: {};
	const sourceSenderAuthenticated = !!(
		trustedTransportProvider &&
		senderAuthentication.authenticatedAligned === true &&
		senderAuthentication.trustedProvider === trustedTransportProvider
	);
	const genericRepeatedFactConflictFields =
		sourceSenderAuthenticated && trustedTransportProvider !== "hotelrunner"
			? detectGenericOtaRepeatedFactConflicts(rawInboundText)
			: [];
	const genericRepeatedFactConflictSet = new Set(
		genericRepeatedFactConflictFields
	);
	const genericRepeatedFactConflict =
		genericRepeatedFactConflictFields.length > 0;
	const airbnbFields = extractAirbnbFields(email, text, provider);
	const verifiedAirbnbCommissionEvidence = !!(
		provider === "airbnb" &&
		trustedTransportProvider === "airbnb" &&
		sourceSenderAuthenticated === true &&
		airbnbFields.sourcePresence?.otaCommission === true &&
		airbnbFields.otaCommissionSource === "airbnb_host_service_fee"
	);
	const agodaFields = extractAgodaFields(email, text, provider);
	const verifiedAgodaDeductionEvidence = !!(
		provider === "agoda" &&
		trustedTransportProvider === "agoda" &&
		sourceSenderAuthenticated === true &&
		agodaFields.otaDeductionConflict !== true
	);
	const verifiedAgodaCommissionEvidence = !!(
		verifiedAgodaDeductionEvidence &&
		agodaFields.sourcePresence?.otaCommission === true &&
		agodaFields.otaCommissionSource === "agoda_commission"
	);
	const verifiedOtaCommissionEvidence =
		verifiedAirbnbCommissionEvidence || verifiedAgodaCommissionEvidence;
	const expediaPartnerCentralFields = extractExpediaPartnerCentralFields(
		text,
		provider
	);
	const directTripFields = extractDirectTripFields(email, rawInboundText, provider);
	const directTripExplicitConfirmationNumbers =
		extractDirectTripConfirmationNumbers(rawInboundText);
	const genericExplicitConfirmationNumbers =
		extractExplicitPrimaryConfirmationNumbers(rawInboundText);
	const isDirectTripSender =
		provider === "trip" &&
		trustedTransportProvider === "trip";
	const directTripIdentityConflict = !!(
		isDirectTripSender && directTripExplicitConfirmationNumbers.length > 1
	);
	const tableStayDates = extractTableStayDates(text);
	const tableOccupancy = extractTableOccupancy(text);
	const isHotelRunnerSender = /@(?:[a-z0-9.-]+\.)?hotelrunner\.com\b/i.test(
		String(email.from || "")
	);
	const rawHotelRunnerText = isHotelRunnerSender
		? String(email.text || "") || htmlToText(email.html || "")
		: "";
	// Identity evidence deliberately unions both MIME representations, while
	// room/Arabic fact parsing retains its existing preferred-representation
	// behavior. Equal MIME mirrors dedupe; distinct identities fail closed.
	const hotelRunnerIdentityEvidenceText = isHotelRunnerSender
		? stripHotelRunnerGuestNoteBlocksForBookingSourceEvidence(rawInboundText)
		: "";
	const hotelRunnerArabicFields = isHotelRunnerSender
		? extractHotelRunnerArabicFields(rawHotelRunnerText)
		: {};
	const hotelRunnerIdentityArabicFields = isHotelRunnerSender
		? extractHotelRunnerArabicFields(hotelRunnerIdentityEvidenceText)
		: {};
	const hotelRunnerConfirmationNumbers = isHotelRunnerSender
		? Array.from(
				new Set(
					[
						...extractHotelRunnerConfirmationNumbers(
							hotelRunnerIdentityEvidenceText
						),
						hotelRunnerIdentityArabicFields.confirmationNumber || "",
					]
						.map(cleanConfirmationCandidate)
						.filter(Boolean)
				)
		  )
		: [];
	const hotelRunnerAuthoritativeConfirmationNumbers = isHotelRunnerSender
		? extractHotelRunnerAuthoritativeConfirmationNumbers(
				hotelRunnerIdentityEvidenceText
		  )
		: [];
	const hotelRunnerConfirmationNumber = hotelRunnerConfirmationNumbers[0] || "";
	const hotelRunnerRoomBlocks = isHotelRunnerSender
		? [
				extractHotelRunnerRoomBlocks(email.text || ""),
				extractHotelRunnerRoomBlocks(htmlToText(email.html || "")),
				hotelRunnerArabicFields.roomBlocks || [],
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
	const sourceField = isHotelRunnerSender
		? extractExplicitHotelRunnerBookingSourceField(rawInboundText)
		: findField(text, [
				"Booking source",
				"Reservation source",
				"Source",
				"Supplier",
				"Travel agency",
				"Agency",
		  ]);
	const embeddedBookingProviders = embeddedBookingSourceProviders(rawInboundText);
	const explicitBookingProviders = knownBookingSourceProviders(sourceField);
	const hotelRunnerCommercialSourceProviders = Array.from(
		new Set([
			...embeddedBookingProviders,
			...explicitBookingProviders.filter(
				(sourceProvider) => sourceProvider !== "hotelrunner"
			),
		])
	);
	const hotelRunnerBookingSourceConflict = !!(
		isHotelRunnerSender &&
		hotelRunnerCommercialSourceProviders.length > 1
	);
	const bookingSource = resolveBookingSource({
		provider,
		providerLabel,
		from: email.from,
		subject: email.subject,
		text,
		explicitSource: sourceField,
	});
	const bookingSourceIsSourceBacked = !!(
		!hotelRunnerBookingSourceConflict &&
		(normalizeWhitespace(sourceField) ||
			trustedProviderFromSenderAddress(email.from) ||
			embeddedBookingProviders.length === 1)
	);
	const hotelRunnerTripRelayEvidence = !!(
		isHotelRunnerSender &&
		hotelRunnerCommercialSourceProviders.length === 1 &&
		hotelRunnerCommercialSourceProviders[0] === "trip" &&
		knownBookingSourceProvider(bookingSource) === "trip"
	);
	const hotelRunnerProviderSpecificBookingIdentity = isHotelRunnerSender
		? analyzeHotelRunnerProviderSpecificBookingIds(
				hotelRunnerIdentityEvidenceText,
				hotelRunnerCommercialSourceProviders.length === 1
					? hotelRunnerCommercialSourceProviders[0]
					: provider
		  )
		: { provider: "", values: [], confirmationNumber: "", conflict: false };
	const hotelRunnerProviderSpecificBookingIdConflict = !!(
		isHotelRunnerSender &&
		hotelRunnerProviderSpecificBookingIdentity.conflict
	);
	const hotelRunnerTripConfirmationNumbers = hotelRunnerTripRelayEvidence
		? (hotelRunnerProviderSpecificBookingIdentity.provider === "trip" &&
		  hotelRunnerProviderSpecificBookingIdentity.values.length
				? hotelRunnerProviderSpecificBookingIdentity.values
				: hotelRunnerConfirmationNumbers
		  ).filter((value) => /^\d{9,18}$/.test(value))
		: [];
	const hotelRunnerTripIdentityConflict = !!(
		hotelRunnerTripRelayEvidence &&
		hotelRunnerTripConfirmationNumbers.length !== 1
	);
	const hotelRunnerNonTripIdentityConflict = !!(
		isHotelRunnerSender &&
		!hotelRunnerTripRelayEvidence &&
		(hotelRunnerAuthoritativeConfirmationNumbers.length > 1 ||
			hotelRunnerProviderSpecificBookingIdConflict)
	);
	const validatedHotelRunnerConfirmationNumber = hotelRunnerTripRelayEvidence
		? hotelRunnerTripConfirmationNumbers[0] || ""
		: hotelRunnerProviderSpecificBookingIdentity.confirmationNumber ||
		  hotelRunnerConfirmationNumber;
	// HotelRunner is a transport relay and may legitimately carry both its own
	// reference and the OTA's booking identity. Its verified Trip relay path has
	// a dedicated ambiguity check above. Direct OTA messages, however, must not
	// select one of two conflicting primary identity labels.
	const genericExplicitIdentityConflict = !!(
		!isHotelRunnerSender && genericExplicitConfirmationNumbers.length > 1
	);
	const otaIdentityConflict =
		directTripIdentityConflict ||
		hotelRunnerTripIdentityConflict ||
		hotelRunnerNonTripIdentityConflict ||
		genericExplicitIdentityConflict;

	const explicitProviderConfirmation = isHotelRunnerSender
		? firstNonEmpty(
				hotelRunnerProviderSpecificBookingIdentity.confirmationNumber,
				hotelRunnerIdentityArabicFields.confirmationNumber,
				validatedHotelRunnerConfirmationNumber
		  )
		: firstNonEmpty(
				airbnbFields.confirmationNumber,
				agodaFields.confirmationNumber,
				expediaPartnerCentralFields.confirmationNumber,
				directTripFields.confirmationNumber,
				isDirectTripSender && directTripExplicitConfirmationNumbers.length === 1
					? directTripExplicitConfirmationNumbers[0]
					: ""
		  );
	const identityExtractionText = isHotelRunnerSender
		? hotelRunnerIdentityEvidenceText
		: text;
	const genericConfirmationField = findCleanConfirmationField(identityExtractionText, [
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
	]);
	const genericConfirmationPattern = cleanConfirmationCandidate(
		findFirstPattern(identityExtractionText, [
				/\bReservation\s*(?:ID|No\.?|Number|#)\s*[:#-]?\s*([A-Z0-9-]{5,})/i,
				/\bConfirmation\s*(?:Number|Code|#)?\s*[:#-]?\s*([A-Z0-9-]{5,})/i,
				/\bBooking\s*(?:ID|Number|#)\s*[:#-]?\s*([A-Z0-9-]{5,})/i,
				/\b(?:Reference|Ref)\s*(?:ID|No\.?|Number|Code|#)?\s*[:#-]?\s*([A-Z0-9-]{5,})/i,
				/\bVoucher\s*(?:ID|No\.?|Number|Code|#)?\s*[:#-]?\s*([A-Z0-9-]{5,})/i,
				/\bItinerary\s*(?:ID|No\.?|Number|Code|#)?\s*[:#-]?\s*([A-Z0-9-]{5,})/i,
				/\bTrip\s*(?:ID|No\.?|Number|Code|#)?\s*[:#-]?\s*([A-Z0-9-]{5,})/i,
		])
	);
	const reservationCandidate = otaIdentityConflict
		? ""
		: firstNonEmpty(
				explicitProviderConfirmation,
				genericConfirmationField,
				genericConfirmationPattern
		  );
	// Airbnb confirmation codes may be alphabetic. Only permit that format when
	// it came from Airbnb's explicit reservation URL/label or HotelRunner's
	// explicit Arabic confirmation label; generic alphabetic fragments remain blocked.
	const reservationId = otaIdentityConflict
		? ""
		: provider === "airbnb" && explicitProviderConfirmation
			? normalizeWhitespace(explicitProviderConfirmation)
			: cleanConfirmationCandidate(reservationCandidate);
	const directTripLifecycleTemplateMatched = !!(
		isDirectTripSender &&
		["cancelled", "no_show", "modified", "status"].includes(eventType) &&
		directTripExplicitConfirmationNumbers.length === 1 &&
		reservationId &&
		directTripExplicitConfirmationNumbers[0] ===
			normalizeConfirmation(reservationId) &&
		/^\d{12,18}$/.test(normalizeConfirmation(reservationId))
	);

	const explicitHotelName = firstNonEmpty(
		explicitHotelAliasFromText(email.subject || ""),
		explicitHotelAliasFromText(text)
	);
	const hotelName = firstNonEmpty(
		airbnbFields.hotelName,
		agodaFields.hotelName,
		directTripFields.hotelName,
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
		directTripFields.roomName,
		hotelRunnerArabicFields.roomName,
		/^<?https?:\/\//i.test(genericRoomName) ? "" : genericRoomName
	), [
		"Arrival\\s+information",
		"Check[-\\s]?in(?:\\s+date)?",
		"Check[-\\s]?out(?:\\s+date)?",
		"Guest\\s+count",
		"Daily\\s+average\\s+rate",
		"Total",
		"تاريخ\\s*تسجيل\\s*الوصول",
		"تاريخ\\s*تسجيل\\s*المغادرة",
		"عدد\\s*الضيوف",
	]);
	const checkinDate = airbnbFields.checkinDate || agodaFields.checkinDate || expediaPartnerCentralFields.checkinDate || directTripFields.checkinDate || hotelRunnerArabicFields.checkinDate || tableStayDates.checkinDate || findDateValue(
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
	const checkoutDate = airbnbFields.checkoutDate || agodaFields.checkoutDate || expediaPartnerCentralFields.checkoutDate || directTripFields.checkoutDate || hotelRunnerArabicFields.checkoutDate || tableStayDates.checkoutDate || findDateValue(
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
	const bookedAt =
		hotelRunnerArabicFields.bookedAt ||
		expediaPartnerCentralFields.bookedAt ||
		parseDate(bookedAtField) ||
		email.receivedAt ||
		email.date ||
		new Date();

	const amountText = firstNonEmpty(
		directTripFields.amountText,
		hotelRunnerArabicFields.orderTotalText,
		expediaPartnerCentralFields.totalGuestPaymentText,
		findField(text, [
			"Total booking amount",
			"Booking amount",
			"Total guest payment",
			"Reservation total",
			"Total amount",
			"Grand total",
			"Guest total",
			"Order total",
			"Amount paid",
		])
	);
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
		expediaPartnerCentralFields.adults ||
		directTripFields.adults ||
		(hotelRunnerArabicFields.hasOccupancyBreakdown
			? hotelRunnerArabicFields.adults
			: hotelRunnerArabicFields.totalGuests) ||
		tableOccupancy.adults ||
		countNumber(adultsField);
	const children =
		airbnbFields.children ||
		agodaFields.children ||
		expediaPartnerCentralFields.children ||
		directTripFields.children ||
		(hotelRunnerArabicFields.hasOccupancyBreakdown
			? hotelRunnerArabicFields.children
			: 0) ||
		tableOccupancy.children ||
		countNumber(childrenField);
	const totalGuests =
		airbnbFields.totalGuests ||
		agodaFields.totalGuests ||
		expediaPartnerCentralFields.totalGuests ||
		directTripFields.totalGuests ||
		hotelRunnerArabicFields.totalGuests ||
		countNumber(totalGuestsField) ||
		tableOccupancy.totalGuests ||
		adults + children ||
		1;
	const roomCount =
		airbnbFields.roomCount ||
		agodaFields.roomCount ||
		directTripFields.roomCount ||
		hotelRunnerArabicFields.roomCount ||
		countNumber(roomCountField) ||
		1;
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
		directTripFields.guestName,
		hotelRunnerArabicFields.guestName,
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
		hotelRunnerArabicFields.nationality,
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
		"إجمالي\\s*الطلب",
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
		directTripFields.paymentInstructions,
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
		provider === "airbnb" && !hasExplicitCardContext
			? ""
			: extractCardLast4(text, {
					allowUnlabeledCardNumber: hasExplicitCardContext,
					excludedNumbers: [reservationId],
			  });
	const vccAmountDetails = resolveVccAmountDetails(
		amountToChargeField,
		amountCurrency
	);
	const verifiedHotelRunnerTripPrepay =
		provider === "hotelrunner" &&
		hotelRunnerTripRelayEvidence &&
		knownBookingSourceProvider(bookingSource) === "trip" &&
		/\bpre[-\s]?pay\b/i.test(text);
	const paymentCollectionModel =
		directTripFields.paymentCollectionModel &&
		directTripFields.paymentCollectionModel !== "unknown"
			? directTripFields.paymentCollectionModel
			: airbnbFields.paymentCollectionModel &&
		airbnbFields.paymentCollectionModel !== "unknown"
			? airbnbFields.paymentCollectionModel
			: agodaFields.paymentCollectionModel &&
			  agodaFields.paymentCollectionModel !== "unknown"
			? agodaFields.paymentCollectionModel
			: verifiedHotelRunnerTripPrepay
			? "ota_collect"
			: detectPaymentCollectionModel(paymentText, {
					cardLast4,
			  });
	const paidOnline = paymentCollectionModel === "ota_collect";
	const vccPayoutSar =
		paymentCollectionModel === "virtual_card"
			? round2(vccAmountDetails.amountToChargeSar || 0)
			: 0;
	const providerTotalPayoutSar = [
		directTripFields.totalPayoutSar,
		agodaFields.totalPayoutSar,
		airbnbFields.totalPayoutSar,
		vccPayoutSar > 0 ? vccPayoutSar : null,
	]
		.map((value) => (value === null || value === undefined ? null : Number(value)))
		.find((value) => value !== null && Number.isFinite(value) && value >= 0) ?? null;
	const providerPaymentSummaryRaw = Object.keys(
		directTripFields.paymentSummary || {}
	).length
		? directTripFields.paymentSummary
		: Object.keys(agodaFields.paymentSummary || {}).length
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
	if (provider !== "unknown" && !trustedTransportProvider) {
		warnings.push(
			"OTA provider was inferred without a trusted sender mailbox domain; automatic reservation mutation is disabled."
		);
	}
	if (provider !== "unknown" && trustedTransportProvider && !sourceSenderAuthenticated) {
		warnings.push(
			"OTA sender authentication is missing, failed, or not aligned with the trusted From domain; automatic reservation mutation is disabled."
		);
	}
	if (directTripIdentityConflict) {
		warnings.push(
			"Trip.com template contains conflicting explicit booking/reservation numbers; no identity was selected."
		);
	}
	if (genericExplicitIdentityConflict && !directTripIdentityConflict) {
		warnings.push(
			"OTA email contains conflicting explicit confirmation, booking, or reservation numbers; no identity was selected."
		);
	}
	if (hotelRunnerTripIdentityConflict) {
		warnings.push(
			"HotelRunner Trip.com relay does not contain exactly one unambiguous numeric OTA booking identity; no identity was selected."
		);
	}
	if (hotelRunnerNonTripIdentityConflict) {
		warnings.push(
			"HotelRunner relay contains conflicting authoritative confirmation labels or repeated provider-specific Booking ID values; no identity was selected."
		);
	}
	if (directTripFields.pricingCurrencyConflict) {
		warnings.push(
			"Trip.com guest-total and payout currencies conflict; no automatic pricing was accepted."
		);
	}
	if (
		agodaFields.grossAndPayoutCurrencyConflict ||
		airbnbFields.grossAndPayoutCurrencyConflict
	) {
		warnings.push(
			`${providerLabel} guest-total and payout currencies conflict; the amounts were retained as source evidence only and no cross-currency deduction was derived.`
		);
	}
	if (directTripFields.roomCountConflict) {
		warnings.push(
			"Trip.com template contains conflicting room counts; no automatic room quantity was accepted."
		);
	}
	if (directTripFields.stayNightConflict) {
		warnings.push(
			"Trip.com declared night counts conflict with the check-in/check-out date range."
		);
	}
	if (airbnbFields.otaCommissionConflict === true) {
		warnings.push(
			"Airbnb email contains conflicting Host service fee amounts; OTA commission was left unverified."
		);
	}
	if (
		agodaFields.otaCommissionConflict === true ||
		agodaFields.otaDeductionConflict === true
	) {
		warnings.push(
			"Agoda email contains conflicting commission or deduction evidence; explicit OTA commission was left unverified."
		);
	}
	for (const field of genericRepeatedFactConflictFields) {
		warnings.push(genericRepeatedFactConflictReason(field));
	}
	if (!reservationId) warnings.push("Missing reservation/confirmation id.");
	if (!checkinDate || !checkoutDate) warnings.push("Missing or invalid stay dates.");
	if (!hotelName && !hotelId) warnings.push("Missing hotel/property name.");
	if (!roomName) warnings.push("Missing room type/name.");
	const ambiguousMultiRoomEvidence = !!(
		hotelRunnerRoomBlocks.length > 1 ||
		directTripFields.multipleRoomBlocks === true ||
		agodaFields.multiRoomEvidence === true
	);

	return {
		provider,
		providerLabel,
		trustedTransportProvider,
		sourceSenderTrusted: !!trustedTransportProvider,
		sourceSenderAuthenticated,
		senderAuthentication,
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
		propertyCurrency: "SAR",
		propertyConversionVerified:
			String(conversion.sourceCurrency || amountCurrency)
				.trim()
				.toUpperCase() === "SAR" &&
			normalizeMarker(conversion.exchangeRateSource || "identity") ===
				"identity" &&
			Math.abs(Number(conversion.exchangeRateToSar || 1) - 1) <= 0.000001,
		sourceAmount:
			hasExplicitAggregateMoney
				? parsedMoney.amount
				: directTripFields.sourceAmount ||
				  agodaFields.sourceAmount ||
				  airbnbFields.sourceAmount ||
				  0,
		sourceCurrency:
			hasExplicitAggregateMoney
				? amountCurrency
				: directTripFields.sourceCurrency ||
				  agodaFields.sourceCurrency ||
				  airbnbFields.sourceCurrency ||
				  "",
		sourcePayoutAmount:
			directTripFields.sourcePayoutAmount ??
			agodaFields.sourcePayoutAmount ??
			airbnbFields.sourcePayoutAmount ??
			null,
		sourcePayoutCurrency:
			directTripFields.sourcePayoutCurrency ||
			agodaFields.sourcePayoutCurrency ||
			airbnbFields.sourcePayoutCurrency ||
			"",
		exchangeRateToSar: conversion.exchangeRateToSar,
		exchangeRateSource: conversion.exchangeRateSource,
		amountConvertedAt: conversion.convertedAt,
		totalPayoutSar: providerTotalPayoutSar,
		netAfterExpensesTotal: providerTotalPayoutSar,
		otaCommissionSar: verifiedAirbnbCommissionEvidence
			? airbnbFields.otaCommissionSar
			: verifiedAgodaCommissionEvidence
				? agodaFields.otaCommissionSar
				: null,
		otaCommissionSourceAmount: verifiedAirbnbCommissionEvidence
			? airbnbFields.otaCommissionSourceAmount
			: verifiedAgodaCommissionEvidence
				? agodaFields.otaCommissionSourceAmount
				: null,
		otaCommissionCurrency: verifiedAirbnbCommissionEvidence
			? airbnbFields.otaCommissionCurrency || "SAR"
			: verifiedAgodaCommissionEvidence
				? agodaFields.otaCommissionCurrency || "SAR"
				: "",
		otaCommissionSource: verifiedAirbnbCommissionEvidence
			? airbnbFields.otaCommissionSource
			: verifiedAgodaCommissionEvidence
				? agodaFields.otaCommissionSource
				: "",
		otaDeductionComponents: verifiedAgodaDeductionEvidence
			? agodaFields.otaDeductionComponents || []
			: [],
		targetedPromotionsLabelPresent:
			verifiedAgodaDeductionEvidence &&
			agodaFields.targetedPromotionsLabelPresent === true,
		nightlyPricingSource:
			directTripFields.nightlyPricingSource ||
			agodaFields.nightlyPricingSource ||
			[],
		nightlyPricingSar:
			directTripFields.nightlyPricingSar || agodaFields.nightlyPricingSar || [],
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
			genericRepeatedFactConflict ||
			ambiguousMultiRoomEvidence ||
			hotelRunnerBookingSourceConflict ||
			otaIdentityConflict ||
			directTripFields.pricingCurrencyConflict === true ||
			directTripFields.roomCountConflict === true ||
			directTripFields.stayNightConflict === true ||
			Number(agodaFields.referenceSellRateOccurrences || 0) > 1,
		ambiguousMultiRoomEvidence,
		manualReviewReasons:
			[
				...genericRepeatedFactConflictFields.map(
					genericRepeatedFactConflictReason
				),
				...(hotelRunnerRoomBlocks.length > 1
					? [
						`HotelRunner email contains ${hotelRunnerRoomBlocks.length} room blocks in one message representation; automatic partial-room creation is disabled.`,
						  ]
						: []),
				...(hotelRunnerBookingSourceConflict
					? [
							`HotelRunner relay contains conflicting commercial booking-source evidence (${hotelRunnerCommercialSourceProviders
								.map((sourceProvider) =>
									PROVIDER_LABELS[sourceProvider] || sourceProvider
								)
								.join(", ")}); automatic reservation lookup and mutation are disabled.`,
					  ]
					: []),
				...(directTripFields.multipleRoomBlocks === true
					? [
							"Trip.com email contains multiple distinct room blocks; automatic partial-room creation is disabled and the booking requires room review.",
					  ]
					: []),
				...(directTripIdentityConflict
					? [
							"Trip.com email contains conflicting explicit booking/reservation numbers; automatic identity selection is disabled.",
					  ]
					: []),
				...(hotelRunnerTripIdentityConflict
					? [
							"HotelRunner Trip.com relay lacks one unambiguous numeric OTA booking identity; automatic lookup and creation are disabled.",
					  ]
					: []),
				...(hotelRunnerNonTripIdentityConflict
					? [
							"HotelRunner relay contains multiple distinct values under authoritative confirmation labels or the same provider-specific Booking ID label; automatic identity selection, lookup, and mutation are disabled.",
					  ]
					: []),
				...(genericExplicitIdentityConflict && !directTripIdentityConflict
					? [
							"OTA email contains conflicting explicit confirmation, booking, or reservation numbers; automatic identity selection and mutation are disabled.",
					  ]
					: []),
				...(directTripFields.pricingCurrencyConflict === true
					? [
							"Trip.com guest-total and payout currencies conflict; automatic pricing and reservation mutation are disabled.",
					  ]
					: []),
				...(directTripFields.roomCountConflict === true
					? [
							"Trip.com email contains conflicting room counts; automatic inventory and pricing mutation are disabled.",
					  ]
					: []),
				...(directTripFields.stayNightConflict === true
					? [
							"Trip.com declared night counts do not reconcile with the stay dates; automatic reservation mutation is disabled.",
					  ]
					: []),
				...(Number(agodaFields.referenceSellRateOccurrences || 0) > 1
					? [
							"Agoda email contains multiple reference sell-rate rows; automatic aggregation is disabled and the booking requires pricing review.",
					  ]
					: []),
				...(agodaFields.multiRoomEvidence === true
					? [AGODA_MULTI_ROOM_ALLOCATION_REVIEW_REASON]
					: []),
			],
		sourcePresence: {
			reservationId: !!reservationId,
			confirmationNumber: !!reservationId,
			bookingSource: bookingSourceIsSourceBacked,
			hotelName:
				!genericRepeatedFactConflictSet.has("hotelName") &&
				(!!hotelName || !!hotelId),
			airbnbListingId: !!airbnbFields.airbnbListingId,
			airbnbListingTitle: !!airbnbFields.airbnbListingTitle,
			roomName:
				!genericRepeatedFactConflictSet.has("roomName") && !!roomName,
			checkinDate:
				!genericRepeatedFactConflictSet.has("checkinDate") &&
				(!!checkinDate ||
					!!tableStayDates.checkinDate ||
					!!hotelRunnerArabicFields.checkinDate),
			checkoutDate:
				!genericRepeatedFactConflictSet.has("checkoutDate") &&
				(!!checkoutDate ||
					!!tableStayDates.checkoutDate ||
					!!hotelRunnerArabicFields.checkoutDate),
			bookedAt:
				!!parseDate(bookedAtField) ||
				!!hotelRunnerArabicFields.bookedAt ||
				!!expediaPartnerCentralFields.bookedAt,
			amount:
				!genericRepeatedFactConflictSet.has("amount") &&
				(!!amountText || !!airbnbFields.amount || !!agodaFields.amount) &&
				Number(parsedMoney.amount || 0) > 0,
			otaCommission: verifiedOtaCommissionEvidence,
			adults:
				!genericRepeatedFactConflictSet.has("adults") &&
				(!!adultsField ||
					!!agodaFields.sourcePresence?.adults ||
					airbnbFields.adults > 0 ||
					expediaPartnerCentralFields.adults > 0 ||
					directTripFields.adults > 0 ||
					hotelRunnerArabicFields.totalGuests > 0 ||
					tableOccupancy.adults > 0),
			children:
				!genericRepeatedFactConflictSet.has("children") &&
				(!!childrenField ||
					!!agodaFields.sourcePresence?.children ||
					airbnbFields.children > 0 ||
					expediaPartnerCentralFields.hasChildren === true ||
					(directTripFields.templateMatched === true &&
						directTripFields.totalGuests > 0) ||
					hotelRunnerArabicFields.hasOccupancyBreakdown === true ||
					tableOccupancy.children > 0),
			totalGuests:
				!genericRepeatedFactConflictSet.has("totalGuests") &&
				(!!totalGuestsField ||
					!!agodaFields.sourcePresence?.totalGuests ||
					airbnbFields.totalGuests > 0 ||
					expediaPartnerCentralFields.totalGuests > 0 ||
					directTripFields.totalGuests > 0 ||
					hotelRunnerArabicFields.totalGuests > 0 ||
					tableOccupancy.totalGuests > 0),
			roomCount:
				!genericRepeatedFactConflictSet.has("roomCount") &&
				(!!roomCountField ||
					!!agodaFields.sourcePresence?.roomCount ||
					directTripFields.roomCount > 0 ||
					hotelRunnerArabicFields.roomCount > 0),
			guestName:
				!genericRepeatedFactConflictSet.has("guestName") && !!guestName,
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
			receivedAt:
				email.sourceReceivedAt || email.receivedAt || email.date || null,
			deliveryReceivedAt: email.deliveryReceivedAt || null,
			messageDate: email.date || null,
			timestampMethod: email.sourceTimestampMethod || "",
			textHash: hashText(text),
			safeSnippet: safeSnippet(text),
			senderAuthentication,
		},
		directTripTemplateMatched: directTripFields.templateMatched === true,
		directTripLifecycleTemplateMatched,
		hotelRunnerTripRelayEvidence,
		hotelRunnerBookingSourceConflict,
		hotelRunnerCommercialSourceProviders,
		hotelRunnerNonTripIdentityConflict,
		hotelRunnerProviderSpecificBookingIdConflict,
		hotelRunnerTripRelayIdentityValidated: !!(
			hotelRunnerTripRelayEvidence &&
			!hotelRunnerTripIdentityConflict &&
			hotelRunnerTripConfirmationNumbers.length === 1
		),
		genericRepeatedFactConflict,
		genericRepeatedFactConflictFields,
		blocksUnmappedReservationCreation: !!(
			genericRepeatedFactConflict ||
			ambiguousMultiRoomEvidence ||
			hotelRunnerBookingSourceConflict ||
			otaIdentityConflict ||
			directTripFields.pricingCurrencyConflict ||
			directTripFields.roomCountConflict ||
			directTripFields.stayNightConflict
		),
		warnings,
		errors,
	};
}

function normalizeRoomSignalText(value = "") {
	return normalizeWhitespace(value)
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0640\u064B-\u065F\u0670\u06D6-\u06ED]/g, "")
		.replace(/[أإآٱ]/g, "ا")
		.replace(/ى/g, "ي")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

const ROOM_NUMBER_WORD_CAPACITIES = {
	one: 1,
	two: 2,
	three: 3,
	four: 4,
	five: 5,
	six: 6,
	seven: 7,
	eight: 8,
};

const ENGLISH_ROOM_CLASS_TOKENS = Object.freeze({
	single: { roomType: "singleRooms", capacity: 1 },
	solo: { roomType: "singleRooms", capacity: 1 },
	double: { roomType: "doubleRooms", capacity: 2 },
	twin: { roomType: "twinRooms", capacity: 2 },
	triple: { roomType: "tripleRooms", capacity: 3 },
	tholasy: { roomType: "tripleRooms", capacity: 3 },
	tholasi: { roomType: "tripleRooms", capacity: 3 },
	tholathy: { roomType: "tripleRooms", capacity: 3 },
	tholathi: { roomType: "tripleRooms", capacity: 3 },
	thalathy: { roomType: "tripleRooms", capacity: 3 },
	thalasi: { roomType: "tripleRooms", capacity: 3 },
	thalathi: { roomType: "tripleRooms", capacity: 3 },
	thulathi: { roomType: "tripleRooms", capacity: 3 },
	thulathy: { roomType: "tripleRooms", capacity: 3 },
	thoulathy: { roomType: "tripleRooms", capacity: 3 },
	thoulathi: { roomType: "tripleRooms", capacity: 3 },
	solasy: { roomType: "tripleRooms", capacity: 3 },
	sulasi: { roomType: "tripleRooms", capacity: 3 },
	fardy: { roomType: "singleRooms", capacity: 1 },
	fardi: { roomType: "singleRooms", capacity: 1 },
	thonaey: { roomType: "doubleRooms", capacity: 2 },
	thonaei: { roomType: "doubleRooms", capacity: 2 },
	thunaey: { roomType: "doubleRooms", capacity: 2 },
	quad: { roomType: "quadRooms", capacity: 4 },
	quadruple: { roomType: "quadRooms", capacity: 4 },
	robaey: { roomType: "quadRooms", capacity: 4 },
	robaei: { roomType: "quadRooms", capacity: 4 },
	quint: { roomType: "familyRooms", capacity: 5 },
	quintuple: { roomType: "familyRooms", capacity: 5 },
	khomasy: { roomType: "familyRooms", capacity: 5 },
	khomasi: { roomType: "familyRooms", capacity: 5 },
	khamasy: { roomType: "familyRooms", capacity: 5 },
	khamasi: { roomType: "familyRooms", capacity: 5 },
	sextuple: { roomType: "familyRooms", capacity: 6 },
	sodasy: { roomType: "familyRooms", capacity: 6 },
	sudasy: { roomType: "familyRooms", capacity: 6 },
	septuple: { roomType: "familyRooms", capacity: 7 },
	sobaey: { roomType: "familyRooms", capacity: 7 },
	octuple: { roomType: "familyRooms", capacity: 8 },
	thomany: { roomType: "familyRooms", capacity: 8 },
});

const ARABIC_ROOM_CLASS_TOKEN_DEFINITIONS = Object.freeze({
	فردي: { roomType: "singleRooms", capacity: 1 },
	فردية: { roomType: "singleRooms", capacity: 1 },
	ثنائي: { roomType: "doubleRooms", capacity: 2 },
	ثنائية: { roomType: "doubleRooms", capacity: 2 },
	زوجي: { roomType: "doubleRooms", capacity: 2 },
	زوجية: { roomType: "doubleRooms", capacity: 2 },
	مزدوج: { roomType: "doubleRooms", capacity: 2 },
	مزدوجة: { roomType: "doubleRooms", capacity: 2 },
	ثلاثي: { roomType: "tripleRooms", capacity: 3 },
	ثلاثية: { roomType: "tripleRooms", capacity: 3 },
	رباعي: { roomType: "quadRooms", capacity: 4 },
	رباعية: { roomType: "quadRooms", capacity: 4 },
	خماسي: { roomType: "familyRooms", capacity: 5 },
	خماسية: { roomType: "familyRooms", capacity: 5 },
	سداسي: { roomType: "familyRooms", capacity: 6 },
	سداسية: { roomType: "familyRooms", capacity: 6 },
	سباعي: { roomType: "familyRooms", capacity: 7 },
	سباعية: { roomType: "familyRooms", capacity: 7 },
	ثماني: { roomType: "familyRooms", capacity: 8 },
	ثمانية: { roomType: "familyRooms", capacity: 8 },
});

const ARABIC_ROOM_CLASS_TOKENS = Object.freeze(
	Object.fromEntries(
		Object.entries(ARABIC_ROOM_CLASS_TOKEN_DEFINITIONS).map(
			([token, evidence]) => [normalizeRoomSignalText(token), evidence]
		)
	)
);

const ARABIC_ROOM_WORDS = new Set(["غرفة", "غرفه", "الغرفة", "الغرفه"]);

function roomClassToken(token = "") {
	let arabicToken = token;
	if (arabicToken.startsWith("ال")) arabicToken = arabicToken.slice(2);
	if (arabicToken.endsWith("ه")) {
		const feminineCandidate = `${arabicToken.slice(0, -1)}ة`;
		if (ARABIC_ROOM_CLASS_TOKENS[feminineCandidate]) {
			arabicToken = feminineCandidate;
		}
	}
	return (
		ENGLISH_ROOM_CLASS_TOKENS[token] ||
		ARABIC_ROOM_CLASS_TOKENS[arabicToken] ||
		null
	);
}

function isArabicBedNounToken(token = "") {
	return /^(?:و?ب?(?:ال)?)?(?:سرير(?:ين|ان|ات)?|اسر(?:ة|ه|تين|تان|ات)?)$/u.test(
		token
	);
}

function isIncidentalEnglishClassToken(words = [], index = -1) {
	const next = words[index + 1] || "";
	const afterNext = words[index + 2] || "";
	const previous = words[index - 1] || "";
	if (
		["occupancy", "use", "rate", "rates", "offer", "promotion", "code", "plan"].includes(next) ||
		["rate", "rates", "offer", "promotion", "code", "plan"].includes(previous)
	) {
		return true;
	}
	if (
		["guest", "guests", "person", "persons", "traveler", "travelers", "traveller", "travellers"].includes(
			next
		) &&
		!["room", "rooms"].includes(afterNext)
	) {
		return true;
	}
	return ["bed", "beds"].includes(next) &&
		!["room", "rooms"].includes(afterNext);
}

function isIndividualBedAccommodation(value = "") {
	const source = normalizeRoomSignalText(value);
	if (!source) return false;
	return (
		/\b(?:(?:individual|shared|dorm|dormitory)\s+)?bed\s+in\s+(?:an?\s+)?(?:[a-z]+\s+){0,3}rooms?\b/i.test(
			source
		) ||
		/(?:سرير|السرير)(?:\s+(?:فردي|مشترك))?\s+في\s+(?:ال)?(?:غرفة|غرفه)/u.test(
			source
		)
	);
}

function roomClassEvidence(value = "") {
	const rawValue = String(value || "");
	if (isIndividualBedAccommodation(value)) {
		return { matches: [], roomTypes: [], capacities: [] };
	}
	const source = normalizeRoomSignalText(value).replace(
		/(الغرفة|الغرفه|غرفة|غرفه)(?=(?:ال)?(?:فردي(?:ة|ه)?|ثنايي(?:ة|ه)?|زوجي(?:ة|ه)?|مزدوج(?:ة|ه)?|ثلاثي(?:ة|ه)?|رباعي(?:ة|ه)?|خماسي(?:ة|ه)?|سداسي(?:ة|ه)?|سباعي(?:ة|ه)?|ثماني(?:ة|ه)?))/gu,
		"$1 "
	);
	if (!source) return { matches: [], roomTypes: [], capacities: [] };
	const words = source.split(" ").filter(Boolean);
	const tokenHits = words
		.map((token, index) => ({ token, index, evidence: roomClassToken(token) }))
		.filter(({ evidence, index, token }) => {
			if (!evidence) return false;
			if (ENGLISH_ROOM_CLASS_TOKENS[token]) {
				return !isIncidentalEnglishClassToken(words, index);
			}
			const precedingStart = Math.max(0, index - 3);
			const nearbyArabicRoomIndex = words
				.slice(precedingStart, index)
				.map((word) => ARABIC_ROOM_WORDS.has(word))
				.lastIndexOf(true);
			if (nearbyArabicRoomIndex >= 0) {
				const absoluteRoomIndex = precedingStart + nearbyArabicRoomIndex;
				const betweenRoomAndClass = words.slice(absoluteRoomIndex + 1, index);
				if (!betweenRoomAndClass.some(isArabicBedNounToken)) return true;
			}
			return !isArabicBedNounToken(words[index - 1] || "");
		});

	const selected = [];
	for (let roomIndex = 0; roomIndex < words.length; roomIndex += 1) {
		if (["room", "rooms"].includes(words[roomIndex])) {
			const nearby = tokenHits.filter(
				(hit) => hit.index < roomIndex && hit.index >= roomIndex - 3
			);
			if (nearby.length) selected.push(nearby[nearby.length - 1]);
		}
		if (ARABIC_ROOM_WORDS.has(words[roomIndex])) {
			const nearby = tokenHits.filter(
				(hit) => hit.index > roomIndex && hit.index <= roomIndex + 3
			);
			if (nearby.length) selected.push(nearby[0]);
		}
	}

	// An explicit alternative remains a conflict even when only one side is
	// adjacent to the word "room" (for example, "Double Room or Triple").
	for (let index = 0; index < tokenHits.length - 1; index += 1) {
		const left = tokenHits[index];
		const right = tokenHits[index + 1];
		const between = words.slice(left.index + 1, right.index);
		if (
			left.evidence.roomType !== right.evidence.roomType &&
			between.some((token) => ["or", "او"].includes(token))
		) {
			selected.push(left, right);
		}
	}
	if (
		/[\/／|]/u.test(rawValue) &&
		new Set(tokenHits.map((hit) => hit.evidence.roomType)).size > 1
	) {
		selected.push(...tokenHits);
	}

	const chosen = selected.length ? selected : tokenHits;
	const matches = Array.from(
		new Map(
			chosen.map(({ evidence }) => [
				`${evidence.roomType}:${evidence.capacity}`,
				evidence,
			])
		).values()
	);
	return {
		matches,
		roomTypes: [...new Set(matches.map((match) => match.roomType))],
		capacities: [...new Set(matches.map((match) => match.capacity))],
	};
}

const CANONICAL_ROOM_TYPE_CAPACITIES = {
	singleRooms: 1,
	doubleRooms: 2,
	twinRooms: 2,
	tripleRooms: 3,
	quadRooms: 4,
};

const SEMANTIC_ROOM_TYPES_REQUIRING_NAME_EVIDENCE = new Set([
	"familyRooms",
	"individualBed",
	"kingRooms",
	"masterSuite",
	"queenRooms",
	"standardRooms",
	"studioRooms",
	"suite",
	"twinRooms",
]);

function explicitRoomClassCapacities(value = "") {
	return roomClassEvidence(value).capacities;
}

function explicitRoomClassCapacity(value = "") {
	const capacities = explicitRoomClassCapacities(value);
	return capacities.length === 1 ? capacities[0] : 0;
}

function explicitPersonCapacityEvidence(value = "") {
	const rawValue = String(value || "");
	const source = normalizeRoomSignalText(value);
	if (!source) return { capacities: [], conflicting: false };
	const capacities = [];
	const hasAdultChildComposition =
		/\badults?\b/i.test(source) &&
		/\b(?:children|child|kids?)\b/i.test(source);
	const numericPattern = /\b([1-9]\d?)\s*(?:persons?|people|guests?|افراد|اشخاص|فرد)(?=$|\s)/giu;
	let match;
	while ((match = numericPattern.exec(source))) {
		capacities.push(Number(match[1]));
	}
	const terminalRoomForNumber = source.match(
		/\b(?:room|accommodation)\s+for\s+([1-9]\d?)$/iu
	);
	if (terminalRoomForNumber) capacities.push(Number(terminalRoomForNumber[1]));
	const delimitedRoomForNumber = rawValue.match(
		/\b(?:room|accommodation)\s+for\s+([1-9]\d?)(?=\s*(?:[-–—|()]|$))/i
	);
	if (delimitedRoomForNumber) {
		capacities.push(Number(delimitedRoomForNumber[1]));
	}

	const englishWordPattern = /\bfor\s+(one|two|three|four|five|six|seven|eight)\s+(?:persons?|people|guests?)\b|\b(one|two|three|four|five|six|seven|eight)\s+(?:persons?|people|guests?)\b/gi;
	while ((match = englishWordPattern.exec(source))) {
		const word = String(match[1] || match[2]).toLowerCase();
		capacities.push(ROOM_NUMBER_WORD_CAPACITIES[word] || 0);
	}
	const terminalRoomForWord = source.match(
		/\b(?:room|accommodation)\s+for\s+(one|two|three|four|five|six|seven|eight)$/i
	);
	if (terminalRoomForWord) {
		capacities.push(
			ROOM_NUMBER_WORD_CAPACITIES[terminalRoomForWord[1].toLowerCase()] || 0
		);
	}
	const delimitedRoomForWord = rawValue.match(
		/\b(?:room|accommodation)\s+for\s+(one|two|three|four|five|six|seven|eight)(?=\s*(?:[-–—|()]|$))/i
	);
	if (delimitedRoomForWord) {
		capacities.push(
			ROOM_NUMBER_WORD_CAPACITIES[delimitedRoomForWord[1].toLowerCase()] || 0
		);
	}

	const arabicWordCapacities = [
		[1, /(?:شخص واحد|فرد واحد)/u],
		[2, /(?:شخصين|فردين|اثنين افراد|اثنان افراد)/u],
		[3, /ثلاثة?\s*(?:افراد|اشخاص)/u],
		[4, /اربعة?\s*(?:افراد|اشخاص)/u],
		[5, /خمسة?\s*(?:افراد|اشخاص)/u],
		[6, /ستة?\s*(?:افراد|اشخاص)/u],
		[7, /سبعة?\s*(?:افراد|اشخاص)/u],
		[8, /ثمانية?\s*(?:افراد|اشخاص)/u],
	];
	for (const [capacity, pattern] of arabicWordCapacities) {
		if (pattern.test(source)) capacities.push(capacity);
	}
	const unique = [...new Set(capacities.filter((capacity) => capacity > 0))];
	return {
		capacities: unique,
		conflicting: hasAdultChildComposition || unique.length > 1,
	};
}

function explicitBedCapacity(value = "") {
	const rawValue = String(value || "");
	const source = normalizeRoomSignalText(value);
	if (!source) return 0;
	if (
		/\b(?:sofa\s+beds?|sofabeds?|bunk\s+beds?|extra\s+beds?|rollaway\s+beds?|futons?|cribs?|cots?|murphy\s+beds?|couch\s+beds?)\b/i.test(
			source
		)
	) {
		return 0;
	}
	if ((rawValue.match(/\bbedrooms?\s*(?:no\.?\s*)?\d+\b/gi) || []).length > 1) {
		return 0;
	}
	const genericCounts = [];
	const typedCapacityEvidence = new Map();
	const typedEvidenceOccurrences = [];
	const addTypedCapacity = (count, bedType) => {
		const normalizedBedType = String(bedType || "").toLowerCase();
		const capacity =
			count *
			(["double", "queen", "king"].includes(normalizedBedType) ? 2 : 1);
		// Mirrored OTA titles often repeat the same bed phrase in parentheses or
		// after a language separator. Count each typed fact once, while still
		// adding distinct composition facts such as one double plus one single.
		const evidenceKey = `${count}:${normalizedBedType}`;
		typedEvidenceOccurrences.push(evidenceKey);
		typedCapacityEvidence.set(evidenceKey, capacity);
	};
	const numericBeds = /([1-9]\d?)\s*(?:(single|double|queen|king|twin)\s+)?beds?\b/gi;
	let match;
	while ((match = numericBeds.exec(source))) {
		const count = Number(match[1]);
		const bedType = String(match[2] || "").toLowerCase();
		if (bedType) {
			addTypedCapacity(count, bedType);
		} else {
			genericCounts.push(count);
		}
	}

	const wordBeds = /\b(one|two|three|four|five|six|seven|eight)\s+(?:(single|double|queen|king|twin)\s+)?beds?\b/gi;
	while ((match = wordBeds.exec(source))) {
		const count = ROOM_NUMBER_WORD_CAPACITIES[match[1].toLowerCase()] || 0;
		const bedType = String(match[2] || "").toLowerCase();
		if (bedType) {
			addTypedCapacity(count, bedType);
		} else {
			genericCounts.push(count);
		}
	}

	const arabicBeds = source.match(/([1-9]\d?)\s*(?:اسرة|سرير)(?=$|\s)/u);
	if (arabicBeds) genericCounts.push(Number(arabicBeds[1]));

	const repeatedGenericCountsAreAmbiguous =
		genericCounts.length > 1 &&
		(/\b(?:or|either|alternatively|instead|and|plus)\b/i.test(source) ||
			/(?:^|\s)(?:او|و)(?:$|\s)/u.test(source) ||
			/[+&\/／;,\r\n]/u.test(rawValue));
	if (repeatedGenericCountsAreAmbiguous) return 0;
	const uniqueGenericCounts = [...new Set(genericCounts)];
	const typedCapacities = [...typedCapacityEvidence.values()];
	if (typedCapacities.length) {
		const hasAlternativeConnector =
			/\b(?:or|either|alternatively|instead)\b/i.test(source) ||
			/(?:^|\s)او(?:$|\s)/u.test(source) ||
			/[\/／|;,\r\n]/u.test(rawValue);
		const hasAdditiveConnector =
			/\b(?:and|plus)\b/i.test(source) ||
			/(?:^|\s)و(?:$|\s)/u.test(source) ||
			/[+&]/u.test(rawValue);
		if (
			(typedCapacities.length > 1 &&
				(hasAlternativeConnector || !hasAdditiveConnector)) ||
			(typedCapacities.length === 1 &&
				typedEvidenceOccurrences.length > 1 &&
				hasAdditiveConnector)
		) {
			return 0;
		}
		const typedTotal = typedCapacities.reduce(
			(sum, capacity) => sum + capacity,
			0
		);
		if (typedTotal <= 0 || typedTotal > 20) return 0;
		if (!uniqueGenericCounts.length) return typedTotal;
		return uniqueGenericCounts.length === 1 &&
			uniqueGenericCounts[0] === typedTotal
			? typedTotal
			: 0;
	}

	return uniqueGenericCounts.length === 1 ? uniqueGenericCounts[0] : 0;
}

const normalizedArabicSemanticTokenSet = (tokens = []) =>
	new Set(tokens.map(normalizeRoomSignalText).filter(Boolean));

const ARABIC_FAMILY_SEMANTIC_TOKENS = normalizedArabicSemanticTokenSet([
	"عائلية",
	"عائلي",
	"عائلة",
	"عايلية",
	"عايلي",
	"عايلة",
]);
const ARABIC_TWIN_SEMANTIC_TOKENS = normalizedArabicSemanticTokenSet([
	"توأم",
	"توام",
]);
const ARABIC_STANDARD_SEMANTIC_TOKENS = normalizedArabicSemanticTokenSet([
	"قياسية",
	"قياسي",
]);
const ARABIC_KING_SEMANTIC_TOKENS = normalizedArabicSemanticTokenSet(["كينغ"]);
const ARABIC_QUEEN_SEMANTIC_TOKENS = normalizedArabicSemanticTokenSet(["كوين"]);

function bareArabicSemanticToken(token = "") {
	return token.startsWith("ال") ? token.slice(2) : token;
}

function arabicRoomSemanticTypes(roomNameRaw = "") {
	const s = normalizeRoomSignalText(roomNameRaw);
	if (!s || !/[\u0600-\u06FF]/u.test(String(roomNameRaw || ""))) return [];
	const words = s.split(" ").filter(Boolean);
	const roomIndexes = words
		.map((word, index) => (ARABIC_ROOM_WORDS.has(word) ? index : -1))
		.filter((index) => index >= 0);
	const hasContextualRoomToken = (tokens) =>
		words.some((word, index) => {
			if (!tokens.has(bareArabicSemanticToken(word))) return false;
			if (
				isArabicBedNounToken(words[index - 1] || "") ||
				isArabicBedNounToken(words[index - 2] || "")
			) {
				return false;
			}
			return roomIndexes.some((roomIndex) => {
				if (Math.abs(roomIndex - index) > 3) return false;
				const between = words.slice(
					Math.min(roomIndex, index) + 1,
					Math.max(roomIndex, index)
				);
				return !between.some(isArabicBedNounToken);
			});
		});
	const roomTypes = [];
	if (
		/(?:سرير|اسر(?:ة|ه|ة))\s+(?:فردي\s+)?(?:مشترك|مشتركة)|سرير\s+في\s+(?:ال)?(?:غرفة|غرفه)\s+(?:مشترك|مشتركة)/u.test(
			s
		)
	) {
		roomTypes.push("individualBed");
	}
	const hasSuiteNoun = words.some(
		(word) => bareArabicSemanticToken(word) === "جناح"
	);
	if (hasSuiteNoun) {
		const masterSuite =
			/(?:^|\s)(?:ال)?جناح\s+(?:ال)?(?:رئيسي|رييسي)(?=$|\s)/u.test(s) ||
			/(?:^|\s)(?:رئيسي|رييسي)\s+(?:ال)?جناح(?=$|\s)/u.test(s) ||
			/(?:^|\s)(?:ال)?جناح\s+(?:ب)?(?:ثلاث|3)\s+(?:غرف|غرفة|غرفه)(?=$|\s)/u.test(
				s
			);
		roomTypes.push(masterSuite ? "masterSuite" : "suite");
	}
	if (words.some((word) => bareArabicSemanticToken(word) === "استوديو")) {
		roomTypes.push("studioRooms");
	}
	if (hasContextualRoomToken(ARABIC_FAMILY_SEMANTIC_TOKENS)) {
		roomTypes.push("familyRooms");
	}
	if (hasContextualRoomToken(ARABIC_TWIN_SEMANTIC_TOKENS)) {
		roomTypes.push("twinRooms");
	}
	if (hasContextualRoomToken(ARABIC_STANDARD_SEMANTIC_TOKENS)) {
		roomTypes.push("standardRooms");
	}
	if (hasContextualRoomToken(ARABIC_KING_SEMANTIC_TOKENS)) {
		roomTypes.push("kingRooms");
	}
	if (hasContextualRoomToken(ARABIC_QUEEN_SEMANTIC_TOKENS)) {
		roomTypes.push("queenRooms");
	}
	return Array.from(new Set(roomTypes));
}

function mapTransliteratedSemanticRoomType(roomNameRaw = "") {
	const words = normalizeRoomSignalText(roomNameRaw).split(" ").filter(Boolean);
	const aelyIndex = words.indexOf("aely");
	if (aelyIndex < 0 || isIncidentalEnglishClassToken(words, aelyIndex)) {
		return null;
	}
	return "familyRooms";
}

function mapArabicRoomType(roomNameRaw) {
	const s = normalizeRoomSignalText(roomNameRaw);
	if (!s) return null;
	const semanticTypes = arabicRoomSemanticTypes(roomNameRaw);
	if (semanticTypes.length > 1) return null;
	if (semanticTypes.length === 1) return semanticTypes[0];
	const withoutBedDescriptions = s
		.replace(
			/(?:^|\s)(?:و?ب?(?:ال)?)?(?:سرير(?:ين|ان|ات)?|اسر(?:ة|ه|تين|تان|ات)?)\s+(?:فردي(?:ة|ين)?|مزدوج(?:ة|ين|تين)?|ثنايي(?:ة|ين)?|دبل)(?=$|\s)/gu,
			" "
		)
		.replace(/\s+/g, " ")
		.trim();
	if (/(?:^|\s)دبل(?=$|\s)/u.test(withoutBedDescriptions)) return "doubleRooms";
	return null;
}

function mapRoomType(roomNameRaw) {
	if (!roomNameRaw) return null;
	if (isIndividualBedAccommodation(roomNameRaw)) return "individualBed";
	const classEvidence = roomClassEvidence(roomNameRaw);
	if (
		classEvidence.roomTypes.length > 1 ||
		classEvidence.capacities.length > 1
	) {
		return null;
	}
	if (classEvidence.matches.length === 1) {
		return classEvidence.matches[0].roomType;
	}
	const normalizedSignal = normalizeRoomSignalText(roomNameRaw);
	const semanticWords = normalizedSignal.split(" ").filter(Boolean);
	const safeKeywordVariants = {
		family: ["family", "families"],
		studio: ["studio", "studios"],
		suite: ["suite", "suites"],
		standard: ["standard", "standards"],
		king: ["king", "kings"],
		queen: ["queen", "queens"],
		shared: ["shared"],
		individual: ["individual"],
	};
	const hasKeyword = (keyword) => {
		const variants = safeKeywordVariants[keyword] || [keyword];
		return semanticWords.some((word, index) => {
			if (!variants.includes(word)) return false;
			const next = semanticWords[index + 1] || "";
			const afterNext = semanticWords[index + 2] || "";
			const previous = semanticWords[index - 1] || "";
			// Rate-plan and occupancy prose describes how a room is sold, not its
			// canonical PMS room class (for example, "standard rate" or "suite use").
			if (
				["king", "queen"].includes(keyword) &&
				["bed", "beds"].includes(next) &&
				!["room", "rooms"].includes(afterNext)
			) {
				return false;
			}
			return (
				!["occupancy", "use", "rate", "rates"].includes(next) &&
				!["rate", "rates"].includes(previous)
			);
		});
	};
	const explicitIndividualBedKeyword =
		/\b(?:individual|shared)\s+beds?\b|\bbeds?\s+(?:for\s+)?(?:individual|shared)\b/i.test(
			normalizedSignal
		);
	const arabicMapped = mapArabicRoomType(roomNameRaw);
	const transliteratedSemanticMapped = mapTransliteratedSemanticRoomType(
		roomNameRaw
	);
	if (hasKeyword("master") && hasKeyword("suite")) return "masterSuite";
	if (arabicMapped) return arabicMapped;
	if (hasKeyword("family")) return "familyRooms";
	if (transliteratedSemanticMapped) return transliteratedSemanticMapped;
	if (hasKeyword("studio")) return "studioRooms";
	if (hasKeyword("suite")) return "suite";
	if (hasKeyword("king")) return "kingRooms";
	if (hasKeyword("queen")) return "queenRooms";
	if (hasKeyword("standard")) return "standardRooms";
	if (explicitIndividualBedKeyword) return "individualBed";
	if (explicitPersonCapacityEvidence(roomNameRaw).conflicting) return null;
	const explicitCapacity = explicitRoomCapacity(roomNameRaw);
	if (explicitCapacity === 1) return "singleRooms";
	if (explicitCapacity === 2 && hasKeyword("twin")) return "twinRooms";
	if (explicitCapacity === 2) return "doubleRooms";
	if (explicitCapacity === 3) return "tripleRooms";
	if (explicitCapacity === 4) return "quadRooms";
	if (explicitCapacity >= 5) return "familyRooms";
	// Structured class evidence above is the only authority for single, double,
	// twin, triple, quad, and quintuple classes. Re-checking loose tokens here
	// would turn incidental phrases such as "double occupancy" into room types.
	return null;
}

function compoundSemanticRoomTypes(roomNameRaw) {
	const semanticWords = normalizeRoomSignalText(roomNameRaw)
		.split(" ")
		.filter(Boolean);
	const hasKeyword = (keyword) =>
		semanticWords.some((word, index) => {
			if (word !== keyword && word !== `${keyword}s`) return false;
			const next = semanticWords[index + 1] || "";
			const afterNext = semanticWords[index + 2] || "";
			const previous = semanticWords[index - 1] || "";
			if (
				["king", "queen"].includes(keyword) &&
				["bed", "beds"].includes(next) &&
				!["room", "rooms"].includes(afterNext)
			) {
				return false;
			}
			return (
				!["occupancy", "use", "rate", "rates"].includes(next) &&
				!["rate", "rates"].includes(previous)
			);
		});
	const masterSuite = hasKeyword("master") && hasKeyword("suite");
	const types = [];
	if (hasKeyword("family")) types.push("familyRooms");
	if (hasKeyword("studio")) types.push("studioRooms");
	if (masterSuite) types.push("masterSuite");
	else if (hasKeyword("suite")) types.push("suite");
	if (hasKeyword("king")) types.push("kingRooms");
	if (hasKeyword("queen")) types.push("queenRooms");
	if (hasKeyword("standard")) types.push("standardRooms");
	return Array.from(new Set(types));
}

function explicitRoomCapacity(value = "") {
	return explicitRoomCapacityEvidence(value).capacity;
}

function explicitRoomCapacityEvidence(value = "") {
	if (!normalizeRoomSignalText(value)) {
		return { capacity: 0, kind: "none", conflicting: false };
	}
	const classEvidence = roomClassEvidence(value);
	if (
		classEvidence.roomTypes.length > 1 ||
		classEvidence.capacities.length > 1
	) {
		return {
			capacity: 0,
			kind: "room_class",
			conflicting: true,
			classEvidence,
		};
	}
	if (classEvidence.matches.length === 1) {
		return {
			capacity: classEvidence.matches[0].capacity,
			kind: "room_class",
			conflicting: false,
			classEvidence,
		};
	}
	const personEvidence = explicitPersonCapacityEvidence(value);
	if (personEvidence.conflicting) {
		return {
			capacity: 0,
			kind: "person_capacity",
			conflicting: true,
			personEvidence,
		};
	}
	if (personEvidence.capacities.length === 1) {
		return {
			capacity: personEvidence.capacities[0],
			kind: "person_capacity",
			conflicting: false,
			personEvidence,
		};
	}

	const bedCapacity = explicitBedCapacity(value);
	return {
		capacity: bedCapacity,
		kind: bedCapacity ? "bed_capacity" : "none",
		conflicting: false,
	};
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
	// Fixed PMS room types are configuration authority. Display text can be
	// translated, stale, or accidentally copied from another room.
	const canonicalRoomTypeCapacity =
		CANONICAL_ROOM_TYPE_CAPACITIES[String(room.roomType || "")];
	if (canonicalRoomTypeCapacity) return canonicalRoomTypeCapacity;

	const displayClassCapacities = [room.displayName, room.displayName_OtherLanguage]
		.map(explicitRoomClassCapacity)
		.filter((capacity) => capacity > 0);
	const uniqueDisplayClassCapacities = [...new Set(displayClassCapacities)];
	if (uniqueDisplayClassCapacities.length === 1) {
		return uniqueDisplayClassCapacities[0];
	}
	if (uniqueDisplayClassCapacities.length > 1) return 0;

	const displayCapacities = [room.displayName, room.displayName_OtherLanguage]
		.map(explicitRoomCapacity)
		.filter((capacity) => capacity > 0);
	const uniqueDisplayCapacities = [...new Set(displayCapacities)];
	if (uniqueDisplayCapacities.length === 1) return uniqueDisplayCapacities[0];
	if (uniqueDisplayCapacities.length > 1) return 0;

	const descriptions = [room.description, room.description_OtherLanguage]
		.filter(Boolean)
		.join(" ");
	const descriptionCapacity = explicitRoomCapacity(descriptions);
	if (descriptionCapacity) return descriptionCapacity;
	const label = normalizeComparable(descriptions);
	const describedNumericCapacity = Number(
		label.match(
			/\b(?:accommodat(?:es|ing)?(?: up to)?|capacity(?: of)?|up to) ([1-9]\d?) (?:guests?|people|persons?)\b/
		)?.[1] ||
			label.match(/\b(?:features?|with) ([1-9]\d?)(?: comfortable)? beds?\b/)?.[1] ||
			0
	);
	if (describedNumericCapacity) return describedNumericCapacity;
	const configuredBedsCount = Number(room.bedsCount || 0);
	if (configuredBedsCount > 1) return configuredBedsCount;
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
	const individualBedSignal = isIndividualBedAccommodation(roomName);
	const nativeArabicSemanticTypes = individualBedSignal
		? ["individualBed"]
		: arabicRoomSemanticTypes(roomName);
	const transliteratedSemanticRoomType =
		mapTransliteratedSemanticRoomType(roomName);
	const mappedRoomType = mapRoomType(roomName);
	const capacityEvidence = explicitRoomCapacityEvidence(roomName);
	const sourceCapacity = capacityEvidence.capacity;
	const sourceClassEvidence = roomClassEvidence(roomName);
	const sourceClassCapacities = sourceClassEvidence.capacities;
	const sourceClassCapacity =
		sourceClassCapacities.length === 1 ? sourceClassCapacities[0] : 0;
	const sourceClassType =
		sourceClassEvidence.roomTypes.length === 1
			? sourceClassEvidence.roomTypes[0]
			: "";
	const sourcePersonEvidence = explicitPersonCapacityEvidence(roomName);
	const sourcePersonCapacities = sourcePersonEvidence.capacities;
	const deterministicNoAiRoomRule = !!(
		sourceCapacity > 0 ||
		nativeArabicSemanticTypes.length ||
		transliteratedSemanticRoomType
	);
	if (!rooms.length || !normalizeWhitespace(roomName)) {
		return {
			roomDetails: null,
			score: 0,
			matchType: "missing_room_context",
			aiFallbackAllowed: false,
			warnings: ["Room type/name is missing or this hotel has no room details."],
		};
	}
	if (
		sourceClassEvidence.roomTypes.length > 1 ||
		sourceClassCapacities.length > 1
	) {
		return {
			roomDetails: null,
			score: 0,
			matchType: "conflicting_room_class",
			mappedRoomType: null,
			sourceCapacity: 0,
			sourceClassCapacity: 0,
			sourceClassCapacities,
			capacityCandidateCount: 0,
			capacityCandidateIds: [],
			aiFallbackAllowed: false,
			warnings: [
				`Room "${roomName}" contains conflicting explicit room classes; it must remain unmapped as received for manual review.`,
			],
		};
	}
	if (nativeArabicSemanticTypes.length > 1) {
		return {
			roomDetails: null,
			score: 0,
			matchType: "conflicting_room_semantic",
			mappedRoomType: null,
			sourceCapacity,
			sourceClassCapacity,
			capacityCandidateCount: 0,
			capacityCandidateIds: [],
			aiFallbackAllowed: false,
			warnings: [
				`Room "${roomName}" contains conflicting native room semantics; it must remain unmapped as received for manual review.`,
			],
		};
	}
	if (!sourceClassCapacity && sourcePersonEvidence.conflicting) {
		return {
			roomDetails: null,
			score: 0,
			matchType: "conflicting_person_capacity",
			mappedRoomType: null,
			sourceCapacity: 0,
			sourceClassCapacity: 0,
			sourcePersonCapacities,
			capacityCandidateCount: 0,
			capacityCandidateIds: [],
			aiFallbackAllowed: false,
			warnings: [
				`Room "${roomName}" contains conflicting explicit person capacities; it must remain unmapped as received for manual review.`,
			],
		};
	}

	const individualBedRooms = individualBedSignal
		? rooms.filter((room) => room.roomType === "individualBed")
		: [];
	if (individualBedSignal && !individualBedRooms.length) {
		return {
			roomDetails: null,
			score: 0,
			matchType: "explicit_semantic_unavailable",
			mappedRoomType: "individualBed",
			sourceCapacity: 0,
			capacityCandidateCount: 0,
			capacityCandidateIds: [],
			aiFallbackAllowed: false,
			warnings: [
				`Room "${roomName}" explicitly sells an individual bed, but this hotel has no active individual-bed PMS room; it must remain unmapped as received.`,
			],
		};
	}
	if (individualBedSignal && individualBedRooms.length === 1) {
		return {
			roomDetails: individualBedRooms[0],
			score: 0.98,
			displayScore: scoreRoomCandidate(
				individualBedRooms[0],
				roomName,
				"individualBed"
			).displayScore,
			matchType: "explicit_room_semantic",
			mappedRoomType: "individualBed",
			sourceCapacity: 0,
			capacityCandidateCount: 1,
			capacityCandidateIds: [String(individualBedRooms[0]?._id || "")].filter(
				Boolean
			),
			aiFallbackAllowed: false,
			warnings: [],
		};
	}

	// Compound semantic labels such as "Family Suite" or "Studio Suite" can
	// contain more than one broad room word. An exact configured PMS display
	// label is stronger than the arbitrary order of those soft semantic tokens,
	// but it must never override an explicit class/capacity (for example, an
	// incorrectly labelled suite cannot satisfy an explicit Triple Room).
	const sourceSemanticRoomTypes = compoundSemanticRoomTypes(roomName);
	const exactDisplayRooms = sourceSemanticRoomTypes.length > 1
		? rooms.filter((room) =>
		[room.displayName, room.displayName_OtherLanguage]
			.filter(Boolean)
			.some(
				(label) =>
					normalizeComparable(label) === normalizeComparable(roomName)
			)
		  )
		: [];
	const compatibleExactDisplayRooms = exactDisplayRooms.filter((room) => {
		if (individualBedSignal && room.roomType !== "individualBed") return false;
		if (sourceClassType && room.roomType !== sourceClassType) return false;
		if (
			sourceCapacity &&
			roomCapacityFromLabels(room) !== sourceCapacity
		) {
			return false;
		}
		return true;
	});
	if (compatibleExactDisplayRooms.length === 1) {
		const exactRoom = compatibleExactDisplayRooms[0];
		return {
			roomDetails: exactRoom,
			score: 1,
			displayScore: 1,
			matchType: "exact_display",
			threshold: 0.75,
			mappedRoomType: exactRoom.roomType || mappedRoomType,
			sourceCapacity,
			sourceClassCapacity,
			sourceClassType,
			capacityCandidateCount: 1,
			capacityCandidateIds: [String(exactRoom?._id || "")].filter(Boolean),
			aiFallbackAllowed: false,
			warnings: [],
		};
	}
	if (compatibleExactDisplayRooms.length > 1) {
		return {
			roomDetails: null,
			score: 1,
			displayScore: 1,
			matchType: "ambiguous_exact_display",
			threshold: 0.75,
			mappedRoomType,
			sourceCapacity,
			sourceClassCapacity,
			sourceClassType,
			capacityCandidateCount: compatibleExactDisplayRooms.length,
			capacityCandidateIds: compatibleExactDisplayRooms
				.map((room) => String(room?._id || "").trim())
				.filter(Boolean),
			aiFallbackAllowed: false,
			warnings: [
				`Multiple active PMS rooms have the exact display label "${roomName}"; automatic room selection is disabled.`,
			],
		};
	}
	if (sourceSemanticRoomTypes.length > 1) {
		return {
			roomDetails: null,
			score: 0,
			displayScore: 0,
			matchType: "compound_semantic_exact_unavailable",
			threshold: 0.75,
			mappedRoomType: null,
			sourceCapacity,
			sourceClassCapacity,
			sourceClassType,
			capacityCandidateCount: 0,
			capacityCandidateIds: [],
			aiFallbackAllowed: false,
			warnings: [
				`Room "${roomName}" contains multiple semantic room classes but has no unique exact PMS display match; it remains unmapped for review.`,
			],
		};
	}

	const capacityMatchedRooms = individualBedSignal
		? individualBedRooms
		: sourceCapacity
		? rooms.filter((room) => {
				if (roomCapacityFromLabels(room) !== sourceCapacity) return false;
				return !sourceClassType || room.roomType === sourceClassType;
		  })
		: rooms;
	const requiresSemanticRoomTypeMatch =
		capacityEvidence.kind !== "room_class" &&
		SEMANTIC_ROOM_TYPES_REQUIRING_NAME_EVIDENCE.has(mappedRoomType);
	const compatibleRooms = requiresSemanticRoomTypeMatch
		? capacityMatchedRooms.filter((room) => room.roomType === mappedRoomType)
		: capacityMatchedRooms;
	const capacityCandidateIds = compatibleRooms
		.map((room) => String(room?._id || "").trim())
		.filter(Boolean);
	if (sourceCapacity && !capacityMatchedRooms.length) {
		return {
			roomDetails: null,
			score: 0,
			matchType: "explicit_capacity_unavailable",
			mappedRoomType,
			sourceCapacity,
			sourceClassCapacity,
			sourceClassType,
			capacityCandidateCount: 0,
			capacityCandidateIds,
			aiFallbackAllowed: false,
			warnings: [
				`Room "${roomName}" explicitly requires capacity ${sourceCapacity}, but no active PMS room has a compatible configured class and capacity; the OTA room must remain unmapped as received.`,
			],
		};
	}
	if (requiresSemanticRoomTypeMatch && !compatibleRooms.length) {
		return {
			roomDetails: null,
			score: 0,
			matchType: "semantic_room_type_unavailable",
			mappedRoomType,
			sourceCapacity,
			sourceClassCapacity,
			sourceClassType,
			capacityCandidateCount: 0,
			capacityCandidateIds: [],
			aiFallbackAllowed: false,
			warnings: [
				`Room "${roomName}" requires PMS semantic type "${mappedRoomType}", but this hotel has no active compatible room; the OTA wording remains unmapped for review.`,
			],
		};
	}

	if (
		requiresSemanticRoomTypeMatch &&
		!sourceCapacity &&
		compatibleRooms.length === 1
	) {
		return {
			roomDetails: compatibleRooms[0],
			score: 0.98,
			displayScore: scoreRoomCandidate(
				compatibleRooms[0],
				roomName,
				mappedRoomType
			).displayScore,
			matchType: "explicit_room_semantic",
			threshold: 0.75,
			mappedRoomType,
			sourceCapacity,
			sourceClassCapacity,
			sourceClassType,
			capacityCandidateCount: 1,
			capacityCandidateIds,
			aiFallbackAllowed: false,
			warnings: [],
		};
	}

	if (sourceCapacity && compatibleRooms.length === 1) {
		return {
			roomDetails: compatibleRooms[0],
			score: 0.98,
			displayScore: scoreRoomCandidate(
				compatibleRooms[0],
				roomName,
				mappedRoomType
			).displayScore,
			matchType: "explicit_capacity",
			threshold: 0.75,
			mappedRoomType,
			sourceCapacity,
			sourceClassCapacity,
			sourceClassType,
			capacityCandidateCount: 1,
			capacityCandidateIds,
			aiFallbackAllowed: false,
			warnings: [],
		};
	}

	const candidates = compatibleRooms
		.map((room, index) => ({
			room,
			index,
			...scoreRoomCandidate(room, roomName, mappedRoomType),
		}))
		.filter(
			(candidate) =>
				candidate.score >= 0.75 &&
				(candidate.matchType === "exact_display" ||
					mappedRoomType ||
					!SEMANTIC_OTA_ROOM_TYPES.has(
						candidate.room.roomType
					))
		)
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
		if (semanticFallback) {
			return {
				...semanticFallback,
				sourceCapacity,
				sourceClassCapacity,
				capacityCandidateCount: compatibleRooms.length,
				capacityCandidateIds,
			};
		}
		return {
			roomDetails: null,
			score: 0,
			matchType: "no_deterministic_match",
			mappedRoomType,
			sourceCapacity,
			sourceClassCapacity,
			capacityCandidateCount: compatibleRooms.length,
			capacityCandidateIds,
			aiFallbackAllowed: deterministicNoAiRoomRule ? false : undefined,
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
			sourceClassCapacity,
			capacityCandidateCount: compatibleRooms.length,
			capacityCandidateIds,
			aiFallbackAllowed: deterministicNoAiRoomRule ? false : undefined,
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
			sourceClassCapacity,
			capacityCandidateCount: compatibleRooms.length,
			capacityCandidateIds,
			aiFallbackAllowed: deterministicNoAiRoomRule ? false : undefined,
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
		sourceClassCapacity,
		capacityCandidateCount: compatibleRooms.length,
		capacityCandidateIds,
		aiFallbackAllowed: deterministicNoAiRoomRule ? false : undefined,
		warnings,
	};
}

function resolveRoomDetails(hotelDetails, roomName) {
	return resolveRoomMatch(hotelDetails, roomName).roomDetails;
}

async function resolveRoomMatchWithAi(hotelDetails, normalized = {}) {
	const allocationSafety = otaInboundAllocationSafety(normalized);
	if (!allocationSafety.ok) {
		return {
			roomDetails: null,
			score: 0,
			matchType: "allocation_resource_limit",
			aiFallbackAllowed: false,
			capacityCandidateCount: 0,
			capacityCandidateIds: [],
			aiRoomMatch: {
				usedAI: false,
				skipReason: allocationSafety.reason,
			},
			warnings: [
				"Inbound room allocation exceeds the per-email resource-safety limit; no room matching or AI call was attempted.",
			],
		};
	}
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
		minimumCapacity:
			Number(normalized.roomCount || 1) === 1
				? Number(normalized.totalGuests || 0)
				: 0,
		candidateCapacities,
	});
	if (!aiMatch.usedAI) {
		if (["exact_display", "explicit_capacity"].includes(deterministicMatch.matchType)) {
			return {
				...deterministicMatch,
				aiRoomMatch: aiMatch,
			};
		}
		if (deterministicMatch.aiFallbackAllowed === false) {
			return {
				...deterministicMatch,
				aiRoomMatch: aiMatch,
			};
		}
		if (
			aiMatch.skipReason ===
			"required_semantic_room_type_has_no_pms_candidate"
		) {
			return {
				...deterministicMatch,
				roomDetails: null,
				matchType: "semantic_room_type_unavailable",
				capacityCandidateCount: 0,
				capacityCandidateIds: [],
				aiFallbackAllowed: false,
				aiRoomMatch: aiMatch,
				warnings: [
					`Room "${normalized.roomName || "unknown"}" requires PMS semantic type "${deterministicMatch.mappedRoomType || "unknown"}", but this hotel has no active compatible room; the OTA wording remains unmapped for review.`,
				],
			};
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

function resolveRootPriceForDate(roomDetails, ymd, options = {}) {
	const pricingRate = (roomDetails.pricingRate || []).find(
		(rate) => dayjs(rate.calendarDate).format("YYYY-MM-DD") === ymd
	);
	if (pricingRate) {
		const rawCalendarRoot = pricingRate.rootPrice;
		if (
			rawCalendarRoot !== undefined &&
			rawCalendarRoot !== null &&
			String(rawCalendarRoot).trim() !== ""
		) {
			const calendarRoot = Number(rawCalendarRoot);
			if (Number.isFinite(calendarRoot) && calendarRoot >= 0) {
				if (calendarRoot >= MIN_REAL_CALENDAR_ROOT_PRICE) return calendarRoot;
				if (options.preserveExplicitZero === true) return 0;
			}
		}
		const calendarPrice = n(pricingRate.price);
		if (calendarPrice > 0) return calendarPrice;
	}
	if (roomDetails.defaultCost) return n(roomDetails.defaultCost);
	if (roomDetails.price?.basePrice) return n(roomDetails.price.basePrice);
	return null;
}

function verifiedExplicitOtaCommissionSourceAmount(normalized = {}) {
	const provider = normalizeComparable(normalized.provider || "");
	const transport = normalizeComparable(normalized.trustedTransportProvider || "");
	const supportedSource =
		(provider === "airbnb" &&
			transport === "airbnb" &&
			normalized.otaCommissionSource === "airbnb_host_service_fee") ||
		(provider === "agoda" &&
			transport === "agoda" &&
			normalized.otaCommissionSource === "agoda_commission" &&
			normalized.otaDeductionConflict !== true);
	if (
		!supportedSource ||
		normalized.sourceSenderAuthenticated !== true ||
		!hasSourceField(normalized, "otaCommission")
	) {
		return null;
	}
	const commissionCurrency = String(normalized.otaCommissionCurrency || "")
		.trim()
		.toUpperCase();
	const rawValue =
		normalized.otaCommissionSourceAmount ??
		(commissionCurrency === "SAR" ? normalized.otaCommissionSar : null);
	if (rawValue === null || rawValue === undefined || rawValue === "") return null;
	const value = Number(rawValue);
	return Number.isFinite(value) && value >= 0 ? round2(value) : null;
}

function buildPickedRoomsType({ roomDetails, normalized, roomMatch = {} }) {
	const allocationSafety = otaInboundAllocationSafety(normalized);
	if (!allocationSafety.ok) {
		return {
			ok: false,
			code: "OTA_INBOUND_ALLOCATION_RESOURCE_LIMIT",
			error:
				"Inbound room allocation exceeds the per-email resource-safety limit; no pricing rows were allocated.",
		};
	}
	const dateRange = generateDateRange(normalized.checkinDate, normalized.checkoutDate);
	const daysOfResidence = dateRange.length;
	if (daysOfResidence <= 0) {
		return {
			ok: false,
			error: "Stay dates do not produce a positive number of nights.",
		};
	}

	const roomCount = Math.max(1, Math.floor(Number(normalized.roomCount || 1)));
	const propertyCurrency = String(normalized.propertyCurrency || "SAR")
		.trim()
		.toUpperCase();
	const otaCommercialEvidence = buildNormalizedOtaCommercialEvidence(
		normalized,
		{ propertyCurrency }
	);
	const normalizedForPricing = {
		...normalized,
		propertyCurrency,
		...(otaCommercialEvidence ? { otaCommercialEvidence } : {}),
	};
	const totalAmountSar = verifiedPropertyGuestGrossSar(normalizedForPricing);
	const totalPayoutSar = verifiedPropertyPayoutSar(normalizedForPricing);
	const hasVerifiedGuestGross = totalAmountSar !== null;
	const hasVerifiedPayout = totalPayoutSar !== null;
	if (
		hasVerifiedGuestGross &&
		hasVerifiedPayout &&
		totalPayoutSar > totalAmountSar + 0.02
	) {
		return {
			ok: false,
			code: "OTA_COMMERCIAL_PAYOUT_EXCEEDS_GROSS",
			error:
				"Verified OTA payout exceeds verified guest gross on the same property-currency basis.",
		};
	}
	const hasComparableGrossAndPayout =
		hasVerifiedGuestGross && hasVerifiedPayout;
	const nightlyPricingSar = Array.isArray(normalized.nightlyPricingSar)
		? normalized.nightlyPricingSar
		: [];
	const preserveExplicitCalendarZero =
		normalizeComparable(normalized.provider || "") === "airbnb" &&
		normalizeComparable(normalized.trustedTransportProvider || "") ===
			"airbnb" &&
		normalized.sourceSenderAuthenticated === true;
	const usesSourceNightlyGross =
		roomCount === 1 &&
		nightlyPricingSar.length === dateRange.length &&
		nightlyPricingSar.every(
			(row, index) =>
				row?.date === dateRange[index] &&
				Number(row.clientAmountSar || 0) > 0
		) &&
		hasVerifiedGuestGross &&
		Math.abs(
			round2(
				nightlyPricingSar.reduce(
					(sum, row) => sum + Number(row.clientAmountSar || 0),
					0
				)
			) - totalAmountSar
		) <= 0.01;
	const usesSourceNightlyPayout =
		roomCount === 1 &&
		nightlyPricingSar.length === dateRange.length &&
		nightlyPricingSar.every(
			(row, index) =>
				row?.date === dateRange[index] &&
				Number(row.payoutAmountSar || 0) > 0 &&
				(!hasVerifiedGuestGross ||
					Number(row.payoutAmountSar) <=
						Number(row.clientAmountSar || Number.POSITIVE_INFINITY) + 0.01)
		) &&
		hasVerifiedPayout &&
		Math.abs(
			round2(
				nightlyPricingSar.reduce(
					(sum, row) => sum + Number(row.payoutAmountSar || 0),
					0
				)
			) - totalPayoutSar
		) <= 0.01;
	const slotPrices = usesSourceNightlyGross
		? nightlyPricingSar.map((row) => round2(row.clientAmountSar))
		: hasVerifiedGuestGross
			? allocateAmountAcrossSlots(
					totalAmountSar,
					daysOfResidence * roomCount
			  )
			: Array(daysOfResidence * roomCount).fill(null);
	const netAfterExpensesSlots = hasVerifiedPayout
		? allocateAmountAcrossSlots(
				totalPayoutSar,
				daysOfResidence * roomCount
		  )
		: Array(daysOfResidence * roomCount).fill(null);
	if (usesSourceNightlyPayout) {
		nightlyPricingSar.forEach((row, index) => {
			netAfterExpensesSlots[index] = round2(row.payoutAmountSar);
		});
	}
	let slotIndex = 0;
	let sumRootPriceAllRooms = 0;
	let sumTotalPriceAllRooms = 0;
	let sumNetAfterExpensesAllRooms = 0;
	let sumOtaExpenseAllRooms = 0;
	let sumPlatformMarginAllRooms = 0;
	let allRootPricesKnown = true;

	const pickedRoomsType = Array.from({ length: roomCount }, () => {
		const pricingByDay = dateRange.map((ymd) => {
			const currentSlot = slotIndex;
			const finalPrice = hasVerifiedGuestGross
				? round2(slotPrices[currentSlot])
				: null;
			const netAfterExpenses = hasVerifiedPayout
				? round2(netAfterExpensesSlots[currentSlot])
				: null;
			slotIndex += 1;
			const resolvedRootPrice = resolveRootPriceForDate(roomDetails, ymd, {
				preserveExplicitZero: preserveExplicitCalendarZero,
			});
			const rootPrice =
				resolvedRootPrice === null ? null : round2(resolvedRootPrice);
			if (rootPrice === null) allRootPricesKnown = false;
			const commissionRate = 0;
			const otaExpenseAmount = hasComparableGrossAndPayout
				? Math.max(0, round2(finalPrice - netAfterExpenses))
				: null;
			const platformMargin =
				netAfterExpenses !== null && rootPrice !== null
					? round2(netAfterExpenses - rootPrice)
					: null;

			if (rootPrice !== null) {
				sumRootPriceAllRooms = round2(sumRootPriceAllRooms + rootPrice);
			}
			if (finalPrice !== null) {
				sumTotalPriceAllRooms = round2(sumTotalPriceAllRooms + finalPrice);
			}
			if (netAfterExpenses !== null) {
				sumNetAfterExpensesAllRooms = round2(
					sumNetAfterExpensesAllRooms + netAfterExpenses
				);
			}
			if (otaExpenseAmount !== null) {
				sumOtaExpenseAllRooms = round2(
					sumOtaExpenseAllRooms + otaExpenseAmount
				);
			}
			if (platformMargin !== null) {
				sumPlatformMarginAllRooms = round2(
					sumPlatformMarginAllRooms + platformMargin
				);
			}

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
		const roomTotal = hasVerifiedGuestGross
			? round2(
					pricingByDay.reduce(
						(total, day) => total + Number(day.totalPriceWithCommission),
						0
					)
			  )
			: null;
		const roomRootKnown = pricingByDay.every(
			(day) => day.rootPrice !== null
		);
		const roomRoot = roomRootKnown
			? round2(
					pricingByDay.reduce(
						(total, day) => total + Number(day.rootPrice),
						0
					)
			  )
			: null;

		return {
			room_type: roomDetails.roomType,
			displayName: roomDetails.displayName,
			hotelRoomConfigId: roomDetails._id || null,
			sourceRoomName: normalized.roomName || "",
			otaRoomMatchType: roomMatch.matchType || "",
			otaRoomMatchScore: Number(roomMatch.score || 0),
			chosenPrice:
				roomTotal === null ? null : round2(roomTotal / daysOfResidence),
			count: 1,
			pricingByDay,
			totalPriceWithCommission: roomTotal,
			hotelShouldGet: roomRoot,
		};
	});

	const subTotalSar = allRootPricesKnown
		? round2(sumRootPriceAllRooms)
		: null;
	const commissionAmountSar = 0;
	const platformMarginTotal =
		hasVerifiedPayout && allRootPricesKnown
			? round2(sumPlatformMarginAllRooms)
			: null;

	return {
		ok: true,
		pickedRoomsType,
		roomCount,
		daysOfResidence,
		sumRootPriceAllRooms: subTotalSar,
		subTotalSar,
		sumTotalPriceAllRooms: hasVerifiedGuestGross
			? round2(sumTotalPriceAllRooms)
			: null,
		netAfterExpensesTotal: hasVerifiedPayout
			? round2(sumNetAfterExpensesAllRooms)
			: null,
		otaExpenseTotal: hasComparableGrossAndPayout
			? round2(sumOtaExpenseAllRooms)
			: null,
		platformMarginTotal,
		commissionAmountSar,
		adminPricingTotals: {
			mode: "ota_platform_sync",
			clientTotal: hasVerifiedGuestGross
				? round2(sumTotalPriceAllRooms)
				: null,
			rootTotal: subTotalSar,
			netAfterExpensesTotal: hasVerifiedPayout
				? round2(sumNetAfterExpensesAllRooms)
				: null,
			otaExpenseTotal: hasComparableGrossAndPayout
				? round2(sumOtaExpenseAllRooms)
				: null,
			platformMarginTotal,
			commissionAmount: commissionAmountSar,
			defaultDeductionRate: null,
			defaultDeductionApplied: false,
			commercialResolution:
				hasComparableGrossAndPayout
					? "verified"
					: hasVerifiedGuestGross || hasVerifiedPayout
						? "partial"
						: "unresolved",
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

	const propertyCurrency = String(hotelDetails.currency || "SAR")
		.trim()
		.toUpperCase();
	const initialOtaCommercialEvidence = buildNormalizedOtaCommercialEvidence(
		normalized,
		{ propertyCurrency }
	);
	const normalizedForPricing = {
		...normalized,
		propertyCurrency,
		...(initialOtaCommercialEvidence
			? { otaCommercialEvidence: initialOtaCommercialEvidence }
			: {}),
	};
	const pricing = buildPickedRoomsType({
		roomDetails,
		normalized: normalizedForPricing,
		roomMatch,
	});
	if (!pricing.ok) return pricing;
	const evidenceBuiltAt = new Date();
	const hotelBase =
		pricing.subTotalSar === null
			? null
			: {
					verified: true,
					amount: pricing.subTotalSar,
					provenance: {
						provider: "jannat_pms",
						sourceType: "pms_root_pricing",
						sourceHash: hashText(
							JSON.stringify(
								pricing.pickedRoomsType.map((room) =>
									(room.pricingByDay || []).map((day) => [
										day.date,
										day.rootPrice,
									])
								)
							)
						),
						sourceTimestamp: evidenceBuiltAt,
						sourceId: `pms-root-${normalizeId(
							hotelDetails._id
						)}-${normalizeId(roomDetails._id || "room")}`,
					},
			  };
	const otaCommercialEvidence =
		buildNormalizedOtaCommercialEvidence(normalizedForPricing, {
			propertyCurrency,
			hotelBase,
		}) || initialOtaCommercialEvidence;

	const isCancelled = normalized.eventType === "cancelled";
	const totalAmountSar = pricing.sumTotalPriceAllRooms;
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
	const adminPricingTotals = pricing.adminPricingTotals || {
		mode: "ota_platform_sync",
		clientTotal: totalAmountSar,
		rootTotal: pricing.subTotalSar,
		netAfterExpensesTotal: null,
		otaExpenseTotal: null,
		platformMarginTotal: null,
		commissionAmount: pricing.commissionAmountSar,
		defaultDeductionRate: null,
		defaultDeductionApplied: false,
		commercialResolution: "unresolved",
	};
	const otaCommissionSar =
		otaCommercialEvidence?.roles?.explicitOtaCommission?.propertyAmount ??
		null;
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
			currency: propertyCurrency,
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
			commission_ota: otaCommissionSar,
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
				currency: propertyCurrency,
				clientTotal: adminPricingTotals.clientTotal,
				hotelVisibleAmount: adminPricingTotals.rootTotal,
				netAfterExpenses: adminPricingTotals.netAfterExpensesTotal,
				netAfterOtaExpenses: adminPricingTotals.netAfterExpensesTotal,
				otaExpenseTotal: adminPricingTotals.otaExpenseTotal,
				platformProfit: adminPricingTotals.platformMarginTotal,
				commissionAmount: pricing.commissionAmountSar,
				otaCommissionAmount: otaCommissionSar,
				otaDeductionBreakdown: normalized.otaDeductionComponents || [],
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
				...(otaCommercialEvidence ? { otaCommercialEvidence } : {}),
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
				otaAmount: sourceAmount || null,
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
				otaCommissionSar,
				otaCommissionSource: normalized.otaCommissionSource || "",
				otaCommissionSourceBacked: otaCommissionSar !== null,
				otaDeductionComponents: normalized.otaDeductionComponents || [],
				targetedPromotionsLabelPresent:
					normalized.targetedPromotionsLabelPresent === true,
				otaPlatformMarginSar: adminPricingTotals.platformMarginTotal,
				otaExchangeRateToSar: normalized.exchangeRateToSar || 0,
				otaExchangeRateSource: normalized.exchangeRateSource || "",
				otaAmountConvertedAt: normalized.amountConvertedAt || "",
				otaPaymentCollectionModel: normalized.paymentCollectionModel || "",
				otaPaymentInstructions: normalized.paymentInstructions || "",
				otaLastInboundEmailId: normalized.inboundEmailId || "",
				otaLastEmailAt: new Date(),
				otaLastSourceReceivedAt: otaSourceReceivedAt(normalized),
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
		"commission_ota",
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

function isSourceBackedHotelRunnerUpgrade(
	existingSource = "",
	incomingSource = "",
	normalized = {}
) {
	if (!hasSourceField(normalized, "bookingSource")) return false;
	const transportProvider = normalizeComparable(normalized.provider || "").replace(
		/\s+/g,
		""
	);
	if (
		transportProvider !== "hotelrunner" &&
		normalized.preserveCanonicalTransportIdentity !== true
	) {
		return false;
	}
	const existingProvider = knownBookingSourceProvider(existingSource);
	const incomingProvider = knownBookingSourceProvider(incomingSource);
	return (
		existingProvider === "hotelrunner" &&
		!!incomingProvider &&
		incomingProvider !== "hotelrunner"
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

function lowerAuthorityOtaLifecycleMustYieldToHotelRunnerApi(
	normalized = {},
	existing = {}
) {
	const lifecycleMutation = Boolean(
		normalized.intent === "reservation_update" ||
		normalized.intent === "reservation_status" ||
		normalized.eventType === "modified" ||
		["cancelled", "no_show", "status"].includes(normalized.eventType)
	);
	if (!lifecycleMutation) return false;
	// Source authority is role-specific. An authenticated provider portal may be
	// stronger commercial evidence, but it must never outrank HotelRunner for
	// lifecycle once the reservation is owned by a direct HotelRunner projection.
	return hasActiveHotelRunnerLifecycleAuthority(existing);
}

const MAX_DIRECT_AFTER_RELAY_SOURCE_SKEW_MS = 15 * 60 * 1000;

function exactSourceBackedStayMatchesExisting(normalized = {}, existing = {}) {
	if (
		!hasSourceField(normalized, "checkinDate") ||
		!hasSourceField(normalized, "checkoutDate")
	) {
		return false;
	}
	const incomingCheckin = normalizedStayDate(normalized.checkinDate);
	const incomingCheckout = normalizedStayDate(normalized.checkoutDate);
	const existingCheckin = normalizedStayDate(existing.checkin_date);
	const existingCheckout = normalizedStayDate(existing.checkout_date);
	return !!(
		incomingCheckin &&
		incomingCheckout &&
		existingCheckin &&
		existingCheckout &&
		incomingCheckin === existingCheckin &&
		incomingCheckout === existingCheckout
	);
}

function canUseDirectAfterRelaySourceSkew({
	normalized = {},
	existing = {},
	orderingConflict = "",
	incomingAuthority = 0,
	existingAuthority = 0,
	matchedReservationBy = [],
} = {}) {
	if (orderingConflict !== "stale_or_equal_timestamp") return false;
	if (!isAuthoritativeSourceUpgrade(incomingAuthority, existingAuthority)) {
		return false;
	}
	if (
		Number(existingAuthority || 0) !== 1 ||
		!isOtaInboundEmail(normalized) ||
		normalized.sourceSenderTrusted !== true ||
		normalized.sourceSenderAuthenticated !== true ||
		normalized.requiresManualReview === true ||
		normalizeComparable(normalized.intent || "") !== "new reservation" ||
		normalizeComparable(normalized.eventType || "") !== "new" ||
		!hasSourceField(normalized, "confirmationNumber") ||
		!hasSourceField(normalized, "hotelName") ||
		!hasSourceField(normalized, "roomName") ||
		!hasSourceField(normalized, "amount") ||
		!exactSourceBackedStayMatchesExisting(normalized, existing) ||
		!Array.isArray(matchedReservationBy) ||
		matchedReservationBy.length < 2
	) {
		return false;
	}
	const existingEventType = normalizeComparable(
		existing?.supplierData?.otaLastEventType || ""
	);
	if (existingEventType && existingEventType !== "new") return false;
	const incomingAt = otaSourceReceivedAt(normalized);
	const relayAt = validOtaEventDate(
		existing?.supplierData?.otaLastSourceReceivedAt
	);
	if (!incomingAt || !relayAt) return false;
	const skewMs = relayAt.getTime() - incomingAt.getTime();
	return skewMs >= 0 && skewMs <= MAX_DIRECT_AFTER_RELAY_SOURCE_SKEW_MS;
}

function otaRoomConfigIds(value = {}) {
	const rooms = Array.isArray(value?.pickedRoomsType)
		? value.pickedRoomsType
		: [];
	return rooms.map((room) => normalizeId(room?.hotelRoomConfigId)).filter(Boolean);
}

function otaRoomIdentitySignatures(value = {}) {
	const rooms = Array.isArray(value?.pickedRoomsType)
		? value.pickedRoomsType
		: [];
	return rooms.map((room) => ({
		roomConfigId: normalizeId(room?.hotelRoomConfigId),
		roomType: normalizeWhitespace(room?.room_type || room?.roomType || ""),
		count: Number(room?.count ?? 1),
	}));
}

function directAfterRelayInventoryConflict(existing = {}, document = {}) {
	if (
		normalizeId(existing?.hotelId) !== normalizeId(document?.hotelId) ||
		normalizeId(existing?.belongsTo) !== normalizeId(document?.belongsTo) ||
		Number(existing?.total_rooms || 0) !== Number(document?.total_rooms || 0)
	) {
		return true;
	}
	const existingRoomIds = otaRoomConfigIds(existing);
	const incomingRoomIds = otaRoomConfigIds(document);
	const existingSignatures = otaRoomIdentitySignatures(existing);
	const incomingSignatures = otaRoomIdentitySignatures(document);
	return !(
		existingRoomIds.length > 0 &&
		existingRoomIds.length === incomingRoomIds.length &&
		existingRoomIds.every((roomId, index) => roomId === incomingRoomIds[index]) &&
		existingSignatures.length === incomingSignatures.length &&
		existingSignatures.every((signature, index) => {
			const incoming = incomingSignatures[index];
			return !!(
				incoming &&
				signature.roomConfigId === incoming.roomConfigId &&
				signature.roomType === incoming.roomType &&
				signature.count === incoming.count
			);
		})
	);
}

function hasAnyOtaRoomConfiguration(value = {}) {
	const roomIds = Array.isArray(value?.roomId) ? value.roomId : [];
	if (roomIds.some((roomId) => normalizeId(roomId))) return true;
	if (normalizeId(value?.supplierData?.otaHotelRoomConfigId)) return true;
	if (normalizeId(value?.otaPlatformReview?.roomMappingHotelId)) return true;
	return [value?.pickedRoomsType, value?.pickedRoomsPricing]
		.filter(Array.isArray)
		.some((rooms) =>
			rooms.some(
				(room) =>
					normalizeId(room?.hotelRoomConfigId) || normalizeId(room?.roomId)
			)
		);
}

function unmappedReviewRoomArrays(value = {}) {
	const typeRooms = Array.isArray(value?.pickedRoomsType)
		? value.pickedRoomsType
		: [];
	const pricingRooms = Array.isArray(value?.pickedRoomsPricing)
		? value.pickedRoomsPricing
		: [];
	return { typeRooms, pricingRooms };
}

function roomBlockCount(rooms = []) {
	return rooms.reduce((total, room) => {
		const count = Number(room?.count ?? 1);
		return total + (Number.isInteger(count) && count > 0 ? count : 0);
	}, 0);
}

function exactSourceRoomCapacity(normalized = {}, roomCount = 0) {
	const roomEvidence = explicitRoomCapacityEvidence(normalized.roomName || "");
	if (roomEvidence.conflicting) return 0;
	if (roomEvidence.capacity > 0) return roomEvidence.capacity;
	if (!hasSourceField(normalized, "totalGuests")) return 0;
	const totalGuests = Number(normalized.totalGuests || 0);
	if (
		!Number.isInteger(totalGuests) ||
		totalGuests <= 0 ||
		!Number.isInteger(roomCount) ||
		roomCount <= 0 ||
		totalGuests % roomCount !== 0
	) {
		return 0;
	}
	return totalGuests / roomCount;
}

function existingUnmappedRoomSignatures(existing = {}) {
	const { typeRooms, pricingRooms } = unmappedReviewRoomArrays(existing);
	const roomCount = Number(existing.total_rooms || 0);
	const totalGuests = Number(existing.total_guests || 0);
	if (
		!Number.isInteger(roomCount) ||
		roomCount <= 0 ||
		roomBlockCount(typeRooms) !== roomCount ||
		roomBlockCount(pricingRooms) !== roomCount ||
		typeRooms.length !== pricingRooms.length ||
		!Number.isInteger(totalGuests) ||
		totalGuests <= 0 ||
		totalGuests % roomCount !== 0
	) {
		return [];
	}
	const fallbackCapacity = totalGuests / roomCount;
	const signatureFor = (room) => {
		const displayName = normalizeWhitespace(
			room?.sourceRoomName || room?.displayName || ""
		);
		const evidence = explicitRoomCapacityEvidence(displayName);
		const mappedType = mapRoomType(displayName);
		const storedType = normalizeWhitespace(room?.room_type || "");
		if (
			!displayName ||
			evidence.conflicting ||
			!mappedType ||
			!storedType ||
			mappedType !== storedType
		) {
			return null;
		}
		return {
			capacity: evidence.capacity || fallbackCapacity,
			roomType: mappedType,
		};
	};
	const typeSignatures = typeRooms.map(signatureFor);
	const pricingSignatures = pricingRooms.map(signatureFor);
	if ([...typeSignatures, ...pricingSignatures].some((value) => !value)) {
		return [];
	}
	if (
		typeSignatures.some(
			(signature, index) =>
				signature.roomType !== pricingSignatures[index].roomType ||
				signature.capacity !== pricingSignatures[index].capacity
		)
	) {
		return [];
	}
	return typeSignatures;
}

function unmappedRootMarginCommissionFieldsAreZero(value = {}) {
	const scalarValues = [
		value.sub_total,
		value.commission,
		value?.adminPricing?.rootTotal,
		value?.adminPricing?.platformMarginTotal,
		value?.adminPricing?.commissionAmount,
		value?.ota_financial_summary?.hotelVisibleAmount,
		value?.ota_financial_summary?.platformProfit,
		value?.ota_financial_summary?.commissionAmount,
		value?.supplierData?.otaPlatformMarginSar,
		value?.financial_cycle?.hotelPayoutDue,
		value?.financial_cycle?.commissionValue,
		value?.financial_cycle?.commissionAmount,
		value?.financial_cycle?.commissionDueToPms,
	];
	if (scalarValues.some((amount) => Math.abs(Number(amount || 0)) > 0.0001)) {
		return false;
	}
	const { typeRooms, pricingRooms } = unmappedReviewRoomArrays(value);
	return [...typeRooms, ...pricingRooms].every((room) => {
		const roomValues = [
			room?.hotelShouldGet,
			room?.subTotal,
			room?.platformMargin,
			room?.adminPricing?.rootTotal,
			room?.adminPricing?.platformMarginTotal,
			room?.adminPricing?.commissionAmount,
		];
		if (roomValues.some((amount) => Math.abs(Number(amount || 0)) > 0.0001)) {
			return false;
		}
		return (room?.pricingByDay || []).every((day) =>
			[
				day?.rootPrice,
				day?.totalPriceWithoutCommission,
				day?.commissionRate,
				day?.platformMargin,
				day?.platformMarginRate,
			].every((amount) => Math.abs(Number(amount || 0)) <= 0.0001)
		);
	});
}

function paymentProcessorHasActivity(processor = {}) {
	if (!processor || typeof processor !== "object") return false;
	if (
		processor.charged === true ||
		processor.processing === true ||
		processor.captured === true ||
		processor.outcome_unknown === true
	) {
		return true;
	}
	if (
		[
			processor.charge_count,
			processor.attempts_count,
			processor.failed_attempts_count,
			processor.total_captured_usd,
			processor.total_captured_sar,
		].some((value) => Math.abs(Number(value || 0)) > 0.0001)
	) {
		return true;
	}
	if (Array.isArray(processor.attempts) && processor.attempts.length > 0) {
		return true;
	}
	if (processor.last_capture && Object.keys(processor.last_capture).length > 0) {
		return true;
	}
	return [
		processor.last_attempt_at,
		processor.last_success_at,
		processor.last_failure_at,
		processor.last_transaction_id,
		processor.last_merchant_transaction_id,
		processor.last_reconciliation_id,
	].some((value) => value !== undefined && value !== null && value !== "");
}

function hasMeaningfulProtectedValue(value) {
	if (value === undefined || value === null || value === "" || value === false) {
		return false;
	}
	if (typeof value === "number") {
		return Number.isFinite(value) && Math.abs(value) > 0.0001;
	}
	if (typeof value === "string") return normalizeWhitespace(value) !== "";
	if (value instanceof Date) return !Number.isNaN(value.getTime());
	if (Array.isArray(value)) return value.some(hasMeaningfulProtectedValue);
	if (typeof value === "object") {
		if (typeof value.toHexString === "function") {
			return normalizeWhitespace(value.toHexString()) !== "";
		}
		return Object.values(value).some(hasMeaningfulProtectedValue);
	}
	return value === true;
}

function protectedCanonicalComparable(value) {
	if (value === undefined) return "__undefined__";
	if (value === null) return null;
	if (value instanceof Date) return value.toISOString();
	if (Array.isArray(value)) return value.map(protectedCanonicalComparable);
	if (typeof value === "object") {
		if (typeof value.toHexString === "function") return value.toHexString();
		return Object.keys(value)
			.sort()
			.reduce((out, key) => {
				out[key] = protectedCanonicalComparable(value[key]);
				return out;
			}, {});
	}
	return value;
}

function protectedValuesEqual(left, right) {
	return (
		JSON.stringify(protectedCanonicalComparable(left)) ===
		JSON.stringify(protectedCanonicalComparable(right))
	);
}

function isMachineGeneratedOtaPaymentComment(value = "") {
	const comment = normalizeWhitespace(value);
	if (!comment) return true;
	const match = comment.match(
		/^(.+?)\s+(collected by platform|virtual card pending capture|hotel collect\s*\/\s*pay at property|payment not captured)$/i
	);
	if (!match) return false;
	const providerPrefix = normalizeWhitespace(match[1]);
	return !!(
		knownBookingSourceProvider(providerPrefix) ||
		["ota", "ota email"].includes(normalizeComparable(providerPrefix))
	);
}

function paymentDetailsHaveProtectedActivity(paymentDetails = {}) {
	if (!paymentDetails || typeof paymentDetails !== "object") return false;
	if (paymentDetails.captured === true) return true;
	if (Math.abs(Number(paymentDetails.onsite_paid_amount || 0)) > 0.0001) {
		return true;
	}
	return Object.entries(paymentDetails).some(([key, value]) => {
		if (["captured", "onsite_paid_amount"].includes(key)) return false;
		return hasMeaningfulProtectedValue(value);
	});
}

function objectHasTransactionOrSettlementEvidence(value, path = "") {
	if (!value || typeof value !== "object") return false;
	for (const [key, child] of Object.entries(value)) {
		const childPath = path ? `${path}.${key}` : key;
		if (!hasMeaningfulProtectedValue(child)) continue;
		const normalizedKey = normalizeComparable(key);
		if (
			/(capture|captured|charg(?:e|ed)|transaction|settle|payout|transfer|attempt|callback|processing|outcome|success|reconciliation|reference)/i.test(
				normalizedKey
			)
		) {
			return true;
		}
		if (
			child &&
			typeof child === "object" &&
			objectHasTransactionOrSettlementEvidence(child, childPath)
		) {
			return true;
		}
	}
	return false;
}

function paidAmountBreakdownHasProtectedState(existing = {}) {
	const breakdown = existing.paid_amount_breakdown;
	if (!breakdown || typeof breakdown !== "object") return false;
	const knownPaymentBuckets = new Set([
		"paid_online_via_link",
		"paid_at_hotel_cash",
		"paid_at_hotel_card",
		"paid_to_hotel",
		"paid_online_jannatbooking",
		"paid_online_other_platforms",
		"paid_online_via_instapay",
		"paid_no_show",
	]);
	for (const [key, value] of Object.entries(breakdown)) {
		if (key === "payment_comments") {
			if (!isMachineGeneratedOtaPaymentComment(value)) return true;
			continue;
		}
		if (key === "paid_online_other_platforms") {
			if (
				!Number.isFinite(Number(value)) ||
				Math.abs(Number(value || 0) - Number(existing.paid_amount || 0)) > 0.02
			) {
				return true;
			}
			continue;
		}
		if (!knownPaymentBuckets.has(key)) {
			if (hasMeaningfulProtectedValue(value)) return true;
			continue;
		}
		if (
			!Number.isFinite(Number(value)) ||
			Math.abs(Number(value || 0)) > 0.0001
		) {
			return true;
		}
	}
	return false;
}

function normalizeStoredPaymentCollectionModel(value) {
	const model = normalizeComparable(value || "");
	if (!model || model === "unknown") return "";
	if (model === "ota collect") return "ota_collect";
	if (model === "hotel collect") return "hotel_collect";
	if (model === "virtual card") return "virtual_card";
	return "invalid";
}

function machinePaymentCommentCollectionModel(value) {
	const comment = normalizeWhitespace(value || "");
	if (!comment) return "";
	if (/\scollected by platform$/i.test(comment)) return "ota_collect";
	if (/\svirtual card pending capture$/i.test(comment)) return "virtual_card";
	if (/\shotel collect\s*\/\s*pay at property$/i.test(comment)) {
		return "hotel_collect";
	}
	if (/\spayment not captured$/i.test(comment)) return "unknown";
	return "invalid";
}

function recognizedStoredPaymentBaseline(existing = {}) {
	const declaredModels = [
		existing.paymentCollectionModel,
		existing?.supplierData?.otaPaymentCollectionModel,
	]
		.map(normalizeStoredPaymentCollectionModel)
		.filter(Boolean);
	if (declaredModels.includes("invalid")) return null;
	const uniqueDeclaredModels = Array.from(new Set(declaredModels));
	if (uniqueDeclaredModels.length > 1) return null;
	const declaredModel = uniqueDeclaredModels[0] || "";
	const breakdown = existing.paid_amount_breakdown;
	const cycle = existing.financial_cycle;
	if (
		!breakdown ||
		typeof breakdown !== "object" ||
		!cycle ||
		typeof cycle !== "object"
	) {
		return null;
	}
	const commentModel = machinePaymentCommentCollectionModel(
		breakdown.payment_comments
	);
	if (commentModel === "invalid") return null;
	const cycleModel = normalizeComparable(cycle.collectionModel || "");
	let model = declaredModel;
	if (!model && ["ota_collect", "hotel_collect", "virtual_card"].includes(commentModel)) {
		model = commentModel;
	}
	if (!model && cycleModel === "pms collected") model = "ota_collect";
	if (!model) return null;
	if (
		commentModel &&
		commentModel !== model
	) {
		return null;
	}
	const expectedCycleModel = model === "ota_collect" ? "pms collected" : "pending";
	if (cycleModel !== expectedCycleModel) return null;

	const total = Number(existing.total_amount);
	const paid = Number(existing.paid_amount);
	const paidOtherPlatforms = Number(
		breakdown.paid_online_other_platforms
	);
	const pmsCollected = Number(cycle.pmsCollectedAmount);
	const hotelCollected = Number(cycle.hotelCollectedAmount);
	const hotelPayoutDue = Number(cycle.hotelPayoutDue);
	const commissionDueToPms = Number(cycle.commissionDueToPms);
	if (
		![
			total,
			paid,
			paidOtherPlatforms,
			pmsCollected,
			hotelCollected,
			hotelPayoutDue,
			commissionDueToPms,
		].every(Number.isFinite) ||
		total <= 0
	) {
		return null;
	}
	const nonPlatformBucketsAreZero = [
		"paid_online_via_link",
		"paid_at_hotel_cash",
		"paid_at_hotel_card",
		"paid_to_hotel",
		"paid_online_jannatbooking",
		"paid_online_via_instapay",
		"paid_no_show",
	].every(
		(key) =>
			Number.isFinite(Number(breakdown[key] || 0)) &&
			Math.abs(Number(breakdown[key] || 0)) <= 0.0001
	);
	if (!nonPlatformBucketsAreZero) return null;

	if (model === "ota_collect") {
		if (
			Math.abs(paid - total) > 0.02 ||
			Math.abs(paidOtherPlatforms - total) > 0.02 ||
			Math.abs(pmsCollected - total) > 0.02 ||
			Math.abs(hotelCollected) > 0.0001 ||
			Math.abs(
				hotelPayoutDue - Number(existing.sub_total || 0)
			) > 0.02 ||
			Math.abs(commissionDueToPms) > 0.0001
		) {
			return null;
		}
	} else if (
		Math.abs(paid) > 0.0001 ||
		Math.abs(paidOtherPlatforms) > 0.0001 ||
		Math.abs(pmsCollected) > 0.0001 ||
		Math.abs(hotelCollected) > 0.0001 ||
		Math.abs(hotelPayoutDue) > 0.0001 ||
		Math.abs(commissionDueToPms) > 0.0001
	) {
		return null;
	}

	return {
		model,
		payment: model === "ota_collect"
			? "paid online"
			: model === "virtual_card"
				? "credit debit"
				: "not paid",
		financeStatus: model === "ota_collect" ? "paid online" : "not paid",
	};
}

function topLevelPaymentStateHasProtectedDrift(existing = {}) {
	const baseline = recognizedStoredPaymentBaseline(existing);
	if (!baseline) return true;
	return !!(
		normalizeComparable(existing.payment || "") !== baseline.payment ||
		normalizeComparable(existing.financeStatus || "") !==
			baseline.financeStatus
	);
}

function financialCycleHasProtectedState(existing = {}) {
	const cycle = existing.financial_cycle;
	if (!cycle || typeof cycle !== "object") return false;
	const allowedKeys = new Set([
		"collectionModel",
		"status",
		"commissionType",
		"commissionValue",
		"commissionAmount",
		"commissionAssigned",
		"commissionAssignedAt",
		"commissionAssignedBy",
		"pmsCollectedAmount",
		"hotelCollectedAmount",
		"hotelPayoutDue",
		"commissionDueToPms",
		"closedAt",
		"closedBy",
		"notes",
		"lastUpdatedAt",
		"lastUpdatedBy",
	]);
	if (
		Object.entries(cycle).some(
			([key, value]) =>
				!allowedKeys.has(key) && hasMeaningfulProtectedValue(value)
		)
	) {
		return true;
	}
	const collectionModel = normalizeComparable(cycle.collectionModel || "");
	if (collectionModel && !["pending", "pms collected"].includes(collectionModel)) {
		return true;
	}
	const status = normalizeComparable(cycle.status || "");
	if (status && status !== "open") return true;
	const commissionType = normalizeComparable(cycle.commissionType || "");
	if (commissionType && commissionType !== "amount") return true;
	if (
		cycle.commissionAssigned === true ||
		hasMeaningfulProtectedValue(cycle.commissionAssignedAt) ||
		hasMeaningfulProtectedValue(cycle.commissionAssignedBy) ||
		hasMeaningfulProtectedValue(cycle.closedAt) ||
		hasMeaningfulProtectedValue(cycle.closedBy) ||
		hasMeaningfulProtectedValue(cycle.notes) ||
		hasMeaningfulProtectedValue(cycle.lastUpdatedBy)
	) {
		return true;
	}
	const paymentBaseline = recognizedStoredPaymentBaseline(existing);
	const expectedAmounts = [
		["commissionValue", Number(existing.commission || 0)],
		["commissionAmount", Number(existing.commission || 0)],
		["pmsCollectedAmount", Number(existing.paid_amount || 0)],
		["hotelCollectedAmount", 0],
		[
			"hotelPayoutDue",
			paymentBaseline?.model === "ota_collect"
				? Number(existing.sub_total || 0)
				: 0,
		],
		["commissionDueToPms", 0],
	];
	return expectedAmounts.some(([key, expected]) => {
		if (!Object.prototype.hasOwnProperty.call(cycle, key)) return false;
		const actual = Number(cycle[key]);
		return !Number.isFinite(actual) || Math.abs(actual - expected) > 0.02;
	});
}

function adminPricingHasProtectedState(existing = {}) {
	const pricing = existing.adminPricing;
	if (!pricing || typeof pricing !== "object") return false;
	if (Object.keys(pricing).some((key) => key.startsWith("clientTotalOverride"))) {
		return true;
	}
	const allowedKeys = new Set([
		"mode",
		"clientTotal",
		"rootTotal",
		"netAfterExpensesTotal",
		"otaExpenseTotal",
		"platformMarginTotal",
		"commissionAmount",
		"defaultDeductionRate",
		"defaultDeductionApplied",
		"commercialResolution",
		"source",
		"provider",
		"providerLabel",
		"sourceCurrency",
		"sourceAmount",
		"sourceExchangeRateToSar",
		"sourceExchangeRateSource",
		"exchangeRateToSar",
		"exchangeRateSource",
		"amountConvertedAt",
		"payoutFallbackReason",
		"sourceClientTotalSar",
		"sourceClientTotalSource",
		"sourceClientTotalLockedAt",
		"hotelAssignmentRequired",
		"pricingReviewRequired",
		"assignedHotelId",
		"assignedHotelName",
	]);
	if (
		Object.entries(pricing).some(
			([key, value]) =>
				!allowedKeys.has(key) && hasMeaningfulProtectedValue(value)
		)
	) {
		return true;
	}
	const mode = normalizeComparable(pricing.mode || "");
	if (
		mode &&
		![
			"ota platform sync",
			"ota platform unmapped",
			"ota assignment pending pricing",
		].includes(mode)
	) {
		return true;
	}
	const assignmentKeys = [
		"hotelAssignmentRequired",
		"pricingReviewRequired",
		"assignedHotelId",
		"assignedHotelName",
	];
	if (mode === "ota assignment pending pricing") {
		return !!(
			pricing.hotelAssignmentRequired !== false ||
			pricing.pricingReviewRequired !== true ||
			normalizeId(pricing.assignedHotelId) !== normalizeId(existing.hotelId)
		);
	}
	return assignmentKeys.some((key) =>
		Object.prototype.hasOwnProperty.call(pricing, key)
	);
}

function adminPricingVisibilityHasProtectedState(existing = {}) {
	const visibility = existing.adminPricingVisibility;
	if (!visibility || typeof visibility !== "object") return false;
	const allowedKeys = new Set([
		"rootOnlyForHotelManagement",
		"source",
		"appliedAt",
		"appliedBy",
	]);
	if (
		Object.entries(visibility).some(
			([key, value]) =>
				!allowedKeys.has(key) && hasMeaningfulProtectedValue(value)
		)
	) {
		return true;
	}
	if (hasMeaningfulProtectedValue(visibility.appliedBy)) return true;
	const source = normalizeComparable(visibility.source || "");
	return !!(
		source &&
		!["ota email create", "ota sync create", "ota email update"].includes(source)
	);
}

function isOtaExactHotelResolverActor(value = {}) {
	return !!(
		value &&
		typeof value === "object" &&
		normalizeComparable(value.role || "") === "system" &&
		normalizeComparable(value.name || "") ===
			"ota inbound exact hotel resolver"
	);
}

function otaReviewHasProtectedState(existing = {}) {
	const review = existing.otaPlatformReview || {};
	if (
		[
			review.releasedAt,
			review.releasedBy,
			review.closedAt,
			review.closedBy,
			review.lastPricingUpdatedAt,
			review.pricingInvalidatedAt,
			review.pricingInvalidationReason,
		].some(hasMeaningfulProtectedValue)
	) {
		return true;
	}
	const roomMappingStatus = normalizeComparable(review.roomMappingStatus || "");
	if (roomMappingStatus && roomMappingStatus !== "unreviewed") {
		return true;
	}
	if (hasMeaningfulProtectedValue(review.roomMappingHotelId)) {
		return true;
	}
	if (
		hasMeaningfulProtectedValue(review.assignedHotelId) &&
		normalizeId(review.assignedHotelId) !== normalizeId(existing.hotelId)
	) {
		return true;
	}
	if (
		hasMeaningfulProtectedValue(review.assignedHotelName) &&
		(normalizeId(review.assignedHotelId) !== normalizeId(existing.hotelId) ||
			normalizeComparable(review.hotelAssignmentStatus || "") !== "assigned")
	) {
		return true;
	}
	if (
		hasMeaningfulProtectedValue(review.assignedBy) &&
		!isOtaExactHotelResolverActor(review.assignedBy)
	) {
		return true;
	}
	if (
		hasMeaningfulProtectedValue(review.assignedAt) &&
		!isOtaExactHotelResolverActor(review.assignedBy)
	) {
		return true;
	}
	const reviewInboundId = normalizeId(review.inboundEmailId);
	const supplierInboundId = normalizeId(
		existing?.supplierData?.otaLastInboundEmailId
	);
	return !!(
		reviewInboundId &&
		supplierInboundId &&
		reviewInboundId !== supplierInboundId
	);
}

function roomArraysHaveProtectedState(existing = {}) {
	const roomArrays = [existing.pickedRoomsType, existing.pickedRoomsPricing]
		.filter(Array.isArray);
	for (const rooms of roomArrays) {
		for (const room of rooms) {
			if (!room || typeof room !== "object") return true;
			const roomConfigId = normalizeId(room.hotelRoomConfigId);
			if (
				Number(room.otaRoomMatchScore || 0) !== 0 &&
				!roomConfigId
			) {
				return true;
			}
			if (
				hasMeaningfulProtectedValue(room.roomId) &&
				normalizeId(room.roomId) !== roomConfigId
			) {
				return true;
			}
			const matchedRoomName = normalizeComparable(room.otaMatchedRoomName || "");
			if (
				matchedRoomName &&
				matchedRoomName !== normalizeComparable(room.displayName || "") &&
				matchedRoomName !==
					normalizeComparable(existing?.supplierData?.otaMatchedRoomName || "")
			) {
				return true;
			}
			if (
				[room.otaRoomMatchType, room.otaRoomMatchReason, room.otaRoomMatchedByModel]
					.some((value) => /manual|employee|admin/i.test(String(value || "")))
			) {
				return true;
			}
			if (room.adminPricing && typeof room.adminPricing === "object") {
				const allowedRoomPricingKeys = new Set([
					"rootTotal",
					"platformMarginTotal",
					"commissionAmount",
				]);
				if (
					Object.entries(room.adminPricing).some(
						([key, value]) =>
							!allowedRoomPricingKeys.has(key) &&
							hasMeaningfulProtectedValue(value)
					)
				) {
					return true;
				}
				if (
					Object.prototype.hasOwnProperty.call(room.adminPricing, "rootTotal") &&
					Math.abs(
						Number(room.adminPricing.rootTotal || 0) -
							Number(room.hotelShouldGet ?? room.subTotal ?? 0)
					) > 0.02
				) {
					return true;
				}
			}
		}
	}
	if (
		Array.isArray(existing.pickedRoomsType) &&
		Array.isArray(existing.pickedRoomsPricing) &&
		!protectedValuesEqual(
			existing.pickedRoomsType,
			existing.pickedRoomsPricing
		)
	) {
		return true;
	}
	return false;
}

function supplierDataHasProtectedState(existing = {}) {
	const supplier = existing.supplierData || {};
	const assignedHotelId = normalizeId(supplier.otaAssignedHotelId);
	if (
		assignedHotelId &&
		(assignedHotelId !== normalizeId(existing.hotelId) ||
			supplier.otaHotelMappingRequired !== false)
	) {
		return true;
	}
	if (
		hasMeaningfulProtectedValue(supplier.otaAssignedHotelName) &&
		(!assignedHotelId || assignedHotelId !== normalizeId(existing.hotelId))
	) {
		return true;
	}
	if (
		hasMeaningfulProtectedValue(supplier.otaAssignedHotelBy) &&
		!isOtaExactHotelResolverActor(supplier.otaAssignedHotelBy)
	) {
		return true;
	}
	if (
		hasMeaningfulProtectedValue(supplier.otaAssignedHotelAt) &&
		!isOtaExactHotelResolverActor(supplier.otaAssignedHotelBy)
	) {
		return true;
	}
	if ([
		supplier.otaRoomMatchType,
		supplier.otaRoomMatchReason,
		supplier.otaRoomMatchedByModel,
	].some((value) => /manual|employee|admin/i.test(String(value || "")))) {
		return true;
	}
	const rooms = Array.isArray(existing.pickedRoomsType)
		? existing.pickedRoomsType
		: [];
	const configuredRoomIds = rooms
		.map((room) => normalizeId(room?.hotelRoomConfigId))
		.filter(Boolean);
	const supplierRoomId = normalizeId(supplier.otaHotelRoomConfigId);
	if (supplierRoomId && !configuredRoomIds.includes(supplierRoomId)) return true;
	if (Number(supplier.otaRoomMatchScore || 0) !== 0 && !supplierRoomId) {
		return true;
	}
	const supplierMatchedName = normalizeComparable(
		supplier.otaMatchedRoomName || ""
	);
	if (
		supplierMatchedName &&
		!rooms.some(
			(room) =>
				supplierMatchedName === normalizeComparable(room?.displayName || "") ||
				supplierMatchedName === normalizeComparable(room?.otaMatchedRoomName || "")
		)
	) {
		return true;
	}
	const supplierMatchType = normalizeComparable(supplier.otaRoomMatchType || "");
	if (
		supplierMatchType &&
		!rooms.some(
			(room) =>
				supplierMatchType === normalizeComparable(room?.otaRoomMatchType || "")
		)
	) {
		return true;
	}
	return false;
}

function authoritativeExistingRefreshProtectedStateGuard(existing = {}) {
	const reject = (reason) => ({ ok: false, reason });
	if (
		paymentDetailsHaveProtectedActivity(existing.payment_details) ||
		hasCaptureOrSettlementActivity(existing)
	) {
		return reject("capture_or_settlement");
	}
	if (paidAmountBreakdownHasProtectedState(existing)) {
		return reject("payment_breakdown");
	}
	if (topLevelPaymentStateHasProtectedDrift(existing)) {
		return reject("payment_state");
	}
	if (financialCycleHasProtectedState(existing)) {
		return reject("financial_cycle");
	}
	if (adminPricingHasProtectedState(existing)) {
		return reject("admin_pricing");
	}
	if (adminPricingVisibilityHasProtectedState(existing)) {
		return reject("admin_pricing_visibility");
	}
	if (otaReviewHasProtectedState(existing)) return reject("review_state");
	if (roomArraysHaveProtectedState(existing)) return reject("room_state");
	if (supplierDataHasProtectedState(existing)) return reject("supplier_state");
	if (
		(Array.isArray(existing.adminChangeLog) && existing.adminChangeLog.length) ||
		hasMeaningfulProtectedValue(existing.financeRejectionComment) ||
		hasMeaningfulProtectedValue(existing.totalReviewStatus)
	) {
		return reject("employee_or_finance_state");
	}
	return { ok: true };
}

function secureAcceptanceHasActivity(secureAcceptance = {}) {
	if (!secureAcceptance || typeof secureAcceptance !== "object") return false;
	const allowedKeys = new Set([
		"status",
		"last_signed_at",
		"last_reference_number",
		"last_transaction_uuid",
		"amount_usd",
		"currency",
		"transaction_type",
		"expires_at",
		"created_by",
		"last_callback_at",
		"last_callback_source",
		"last_response_signature_valid",
		"last_request_id",
		"last_transaction_id",
		"last_reason_code",
		"last_decision",
		"last_response_payload",
		"request_context",
		"outbound_metadata",
		"callbacks",
	]);
	if (
		Object.entries(secureAcceptance).some(
			([key, value]) =>
				!allowedKeys.has(key) && hasMeaningfulProtectedValue(value)
		)
	) {
		return true;
	}
	const status = normalizeComparable(secureAcceptance.status || "");
	if (status && status !== "not started") return true;
	if (Object.prototype.hasOwnProperty.call(secureAcceptance, "amount_usd")) {
		const amountUsd = Number(secureAcceptance.amount_usd);
		if (!Number.isFinite(amountUsd) || Math.abs(amountUsd) > 0.0001) {
			return true;
		}
	}
	const currency = normalizeComparable(secureAcceptance.currency || "");
	if (currency && currency !== "usd") return true;
	const transactionType = normalizeComparable(
		secureAcceptance.transaction_type || ""
	);
	if (transactionType && transactionType !== "sale") return true;
	if (Object.prototype.hasOwnProperty.call(secureAcceptance, "callbacks")) {
		if (!Array.isArray(secureAcceptance.callbacks)) return true;
		if (secureAcceptance.callbacks.length > 0) return true;
	}
	if (secureAcceptance.last_response_signature_valid != null) return true;
	return [
		secureAcceptance.last_signed_at,
		secureAcceptance.last_reference_number,
		secureAcceptance.last_transaction_uuid,
		secureAcceptance.expires_at,
		secureAcceptance.created_by,
		secureAcceptance.last_callback_at,
		secureAcceptance.last_callback_source,
		secureAcceptance.last_request_id,
		secureAcceptance.last_transaction_id,
		secureAcceptance.last_reason_code,
		secureAcceptance.last_decision,
		secureAcceptance.last_response_payload,
		secureAcceptance.request_context,
		secureAcceptance.outbound_metadata,
	].some(hasMeaningfulProtectedValue);
}

function hasCaptureOrSettlementActivity(existing = {}) {
	const commissionStatus = normalizeComparable(existing.commissionStatus || "");
	if (
		paymentDetailsHaveProtectedActivity(existing.payment_details) ||
		existing.moneyTransferredToHotel === true ||
		existing.commissionPaid === true ||
		existing.moneyTransferredAt ||
		existing.commissionPaidAt ||
		existing?.financial_cycle?.closedAt ||
		existing?.financial_cycle?.commissionAssigned === true ||
		(commissionStatus &&
			!["no commission due", "not paid", "pending", "unpaid"].includes(
				commissionStatus
			)) ||
		(existing.commissionData &&
			typeof existing.commissionData === "object" &&
			Object.keys(existing.commissionData).length > 0)
	) {
		return true;
	}
	const cycleStatus = normalizeComparable(existing?.financial_cycle?.status || "");
	if (cycleStatus && !["open", "pending"].includes(cycleStatus)) return true;
	if (
		[
			existing?.paid_amount_breakdown?.paid_online_via_link,
			existing?.paid_amount_breakdown?.paid_at_hotel_cash,
			existing?.paid_amount_breakdown?.paid_at_hotel_card,
			existing?.paid_amount_breakdown?.paid_to_hotel,
			existing?.paid_amount_breakdown?.paid_online_jannatbooking,
			existing?.paid_amount_breakdown?.paid_online_via_instapay,
			existing?.paid_amount_breakdown?.paid_no_show,
			existing?.financial_cycle?.hotelCollectedAmount,
			existing?.financial_cycle?.commissionDueToPms,
		].some((value) => Math.abs(Number(value || 0)) > 0.0001)
	) {
		return true;
	}
	const bofaPayment =
		existing.bofa_payment && typeof existing.bofa_payment === "object"
			? existing.bofa_payment
			: {};
	const {
		secure_acceptance: secureAcceptance = {},
		...bofaWithoutSecureAcceptance
	} = bofaPayment;
	if (
		paymentProcessorHasActivity(existing.vcc_payment) ||
		paymentProcessorHasActivity(existing.braintree_payment) ||
		paymentProcessorHasActivity(bofaPayment.vcc) ||
		objectHasTransactionOrSettlementEvidence(existing.vcc_payment) ||
		objectHasTransactionOrSettlementEvidence(existing.braintree_payment) ||
		objectHasTransactionOrSettlementEvidence(bofaWithoutSecureAcceptance)
	) {
		return true;
	}
	if (secureAcceptanceHasActivity(secureAcceptance)) return true;
	return !!(
		existing.paypal_details &&
		typeof existing.paypal_details === "object" &&
		Object.keys(existing.paypal_details).length > 0
	);
}

function hasCompleteDirectCommercialEvidence(normalized = {}) {
	const propertyCurrency = String(normalized.propertyCurrency || "SAR")
		.trim()
		.toUpperCase();
	const evidence = buildNormalizedOtaCommercialEvidence(normalized, {
		propertyCurrency,
	});
	const gross = evidence?.roles?.guestGross;
	const payout = evidence?.roles?.hotelPayout;
	return Boolean(
		evidence?.verificationState === "verified" &&
		gross?.verified === true &&
		payout?.verified === true &&
		gross.propertyCurrency === propertyCurrency &&
		payout.propertyCurrency === propertyCurrency &&
		Number.isFinite(Number(gross.propertyAmount)) &&
		Number(gross.propertyAmount) > 0 &&
		Number.isFinite(Number(payout.propertyAmount)) &&
		Number(payout.propertyAmount) >= 0 &&
		evidence.reconciliation?.grossAndPayoutSameCurrency === true &&
		evidence.reconciliation?.grossAndPayoutSameBasis === true &&
		evidence.reconciliation?.deductionDerived === true
	);
}

function hotelRunnerEmailCommercialEvidenceHash(evidence = {}) {
	const sourceReceivedAt = validOtaEventDate(evidence.sourceReceivedAt);
	const version = Number(evidence.version || 1);
	if (version >= 2) {
		const components = (Array.isArray(evidence.deductionComponents)
			? evidence.deductionComponents
			: []
		)
			.map((component) => ({
				type: normalizeMarker(component?.type || ""),
				label: normalizeWhitespace(component?.label || ""),
				amountSar: round2(component?.amountSar),
				currency: String(component?.currency || "").trim().toUpperCase(),
				source: normalizeMarker(component?.source || ""),
			}))
			.sort((left, right) =>
				`${left.type}:${left.label}`.localeCompare(`${right.type}:${right.label}`)
			);
		return hashText(
			JSON.stringify([
				2,
				"authenticated_ota_email",
				normalizeOtaIdentityProvider(evidence.provider),
				normalizeWhitespace(evidence.otaIdentityKey || "").toLowerCase(),
				round2(evidence.grossTotalSar),
				round2(evidence.payoutTotalSar),
				round2(evidence.otaExpenseTotalSar),
				evidence.otaCommissionSar === null ||
				evidence.otaCommissionSar === undefined
					? null
					: round2(evidence.otaCommissionSar),
				round2(evidence.unclassifiedDeductionSar),
				components,
				(Array.isArray(evidence.unpricedDeductionLabels)
					? evidence.unpricedDeductionLabels
					: []
				)
					.map((value) => normalizeWhitespace(value))
					.filter(Boolean)
					.sort(),
				String(evidence.currency || "").trim().toUpperCase(),
				normalizeId(evidence.inboundEmailId || ""),
				normalizeMarker(evidence.sourceTextHash || ""),
				sourceReceivedAt ? sourceReceivedAt.toISOString() : "",
			])
		);
	}
	return hashText(
		JSON.stringify([
			1,
			"authenticated_ota_email",
			normalizeOtaIdentityProvider(evidence.provider),
			normalizeWhitespace(evidence.otaIdentityKey || "").toLowerCase(),
			round2(evidence.grossTotalSar),
			round2(evidence.payoutTotalSar),
			round2(evidence.otaExpenseTotalSar),
			String(evidence.currency || "").trim().toUpperCase(),
			sourceReceivedAt ? sourceReceivedAt.toISOString() : "",
		])
	);
}

function constantTimeEvidenceHashMatches(actual = "", expected = "") {
	const left = String(actual || "").trim().toLowerCase();
	const right = String(expected || "").trim().toLowerCase();
	if (!/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) {
		return false;
	}
	return crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

function buildHotelRunnerEmailCommercialEvidence(
	normalized = {},
	{ appliedAt = new Date() } = {}
) {
	const provider = normalizeOtaIdentityProvider(normalized.provider);
	const confirmationNumber = normalizeConfirmation(
		normalized.confirmationNumber || normalized.reservationId
	);
	const otaIdentityKey = buildOtaIdentityKey(provider, confirmationNumber);
	const sourceReceivedAt = otaSourceReceivedAt(normalized);
	const requiredSourceFacts = [
		"confirmationNumber",
		"hotelName",
		"roomName",
		"checkinDate",
		"checkoutDate",
		"roomCount",
		"amount",
	];
	if (
		!isOtaInboundEmail(normalized) ||
		normalized.sourceSenderTrusted !== true ||
		normalized.sourceSenderAuthenticated !== true ||
		normalizeOtaIdentityProvider(normalized.trustedTransportProvider) !==
			provider ||
		(normalized.requiresManualReview === true &&
			!agodaMultiRoomAllocationReviewAllowsCommercialOnly(normalized)) ||
		!provider ||
		!otaIdentityKey ||
		!sourceReceivedAt ||
		requiredSourceFacts.some((field) => !hasSourceField(normalized, field)) ||
		!hasCompleteDirectCommercialEvidence(normalized)
	) {
		return null;
	}
	const otaCommercialEvidence = buildNormalizedOtaCommercialEvidence(normalized, {
		propertyCurrency: "SAR",
	});
	if (!otaCommercialEvidence) return null;
	const grossTotalSar = round2(
		otaCommercialEvidence.roles.guestGross.propertyAmount
	);
	const payoutTotalSar = round2(
		otaCommercialEvidence.roles.hotelPayout.propertyAmount
	);
	const otaExpenseTotalSar = round2(
		otaCommercialEvidence.roles.deductionAggregate.propertyAmount
	);
	const otaCommissionSar =
		otaCommercialEvidence.roles.explicitOtaCommission.propertyAmount;
	let deductionComponents = (Array.isArray(normalized.otaDeductionComponents)
		? normalized.otaDeductionComponents
		: []
	)
		.map((component) => ({
			type: normalizeMarker(component?.type || ""),
			label: normalizeWhitespace(component?.label || ""),
			amountSar: round2(component?.amountSar),
			currency: String(component?.currency || "").trim().toUpperCase(),
			source: normalizeMarker(component?.source || ""),
		}))
		.filter(
			(component) =>
				component.type &&
				component.label &&
				component.amountSar > 0 &&
				component.currency === "SAR" &&
				component.source === "authenticated_agoda_email"
		);
	if (otaCommissionSar !== null && !deductionComponents.length) {
		deductionComponents = [
			{
				type: "commission",
				label:
					normalized.otaCommissionSource === "airbnb_host_service_fee"
						? "Host service fee"
						: "Commission",
				amountSar: otaCommissionSar,
				currency: "SAR",
				source: "authenticated ota email",
			},
		];
	}
	const namedDeductionTotalSar = round2(
		deductionComponents.reduce(
			(sum, component) => sum + Number(component.amountSar || 0),
			0
		)
	);
	if (namedDeductionTotalSar > otaExpenseTotalSar + 0.02) {
		return null;
	}
	const unclassifiedDeductionSar = Math.max(
		0,
		round2(otaExpenseTotalSar - namedDeductionTotalSar)
	);
	const evidence = {
		version: 2,
		verified: true,
		source: "authenticated_ota_email",
		provider,
		otaIdentityKey,
		grossTotalSar,
		payoutTotalSar,
		otaExpenseTotalSar,
		otaCommissionSar,
		deductionComponents,
		unclassifiedDeductionSar,
		unpricedDeductionLabels:
			normalized.targetedPromotionsLabelPresent === true &&
			!deductionComponents.some(
				(component) => component.type === "targeted_promotion"
			)
				? ["Targeted promotions"]
				: [],
		currency: "SAR",
		inboundEmailId: normalizeId(normalized.inboundEmailId || ""),
		sourceTextHash: normalizeMarker(normalized?.source?.textHash || ""),
		sourceReceivedAt: sourceReceivedAt.toISOString(),
		appliedAt,
	};
	return {
		...evidence,
		evidenceHash: hotelRunnerEmailCommercialEvidenceHash(evidence),
	};
}

function commercialEvidenceAmountMatches(actual, expected) {
	const numeric = Number(actual);
	return Number.isFinite(numeric) && Math.abs(round2(numeric) - expected) <= 0.02;
}

function commercialEvidenceExactCentsMatch(actual, expected) {
	const actualCents = decimalMoneyCents(actual);
	const expectedCents = decimalMoneyCents(expected);
	return (
		actualCents !== null &&
		expectedCents !== null &&
		actualCents === expectedCents
	);
}

function commercialEvidencePaymentSummaryMatches(
	summary = {},
	marker = {},
	{ exactPropertyCents = false } = {}
) {
	if (!summary || typeof summary !== "object" || Array.isArray(summary)) return false;
	const safe = safeOtaPaymentSummary(summary);
	const propertyAmountMatches = exactPropertyCents
		? commercialEvidenceExactCentsMatch
		: commercialEvidenceAmountMatches;
	const sourceCurrency = String(safe.sourceCurrency || "").trim().toUpperCase();
	const propertyCurrency = String(safe.currency || "").trim().toUpperCase();
	const sourceGross = Number(safe.sourceTotalGuestPaymentAmount);
	const sourcePayout = Number(safe.sourceTotalPayoutAmount);
	const rate = Number(safe.exchangeRateToSar);
	const rateSource = normalizeMarker(safe.exchangeRateSource || "");
	const storedConversionEvidence =
		rateSource === "exchange_rate_api_stored"
			? validatedTrustedExchangeRateEvidence(
					safe.currencyConversionEvidence,
					{
						sourceCurrency,
						propertyCurrency,
						rate,
					}
			  )
			: null;
	const legacyConversionTrusted =
		sourceCurrency === "SAR"
			? Math.abs(rate - 1) <= 0.000001 &&
				(rateSource !== "exchange_rate_api_stored" ||
					Boolean(storedConversionEvidence))
			: ["exchange_rate_api", "exchange_rate_api_cached"].includes(
					rateSource
			  ) || Boolean(storedConversionEvidence);
	const convertedGrossCents = multipliedMoneyCents(sourceGross, rate);
	const convertedPayoutCents = multipliedMoneyCents(sourcePayout, rate);
	const markerGrossCents = decimalMoneyCents(marker.grossTotalSar);
	const markerPayoutCents = decimalMoneyCents(marker.payoutTotalSar);
	const convertedGrossMatches = exactPropertyCents
		? convertedGrossCents !== null &&
			markerGrossCents !== null &&
			convertedGrossCents === markerGrossCents
		: commercialEvidenceAmountMatches(
				round2(sourceGross * rate),
				marker.grossTotalSar
		  );
	const convertedPayoutMatches = exactPropertyCents
		? convertedPayoutCents !== null &&
			markerPayoutCents !== null &&
			convertedPayoutCents === markerPayoutCents
		: commercialEvidenceAmountMatches(
				round2(sourcePayout * rate),
				marker.payoutTotalSar
		  );
	return !!(
		propertyAmountMatches(
			safe.totalGuestPaymentAmount,
			round2(marker.grossTotalSar)
		) &&
		propertyAmountMatches(
			safe.totalPayoutAmount,
			round2(marker.payoutTotalSar)
		) &&
		propertyCurrency === "SAR" &&
		Number.isFinite(sourceGross) &&
		sourceGross > 0 &&
		Number.isFinite(sourcePayout) &&
		sourcePayout >= 0 &&
		Number.isFinite(rate) &&
		rate > 0 &&
		legacyConversionTrusted &&
		convertedGrossMatches &&
		convertedPayoutMatches
	);
}

function nullableCommercialAmountMatches(actual, expected) {
	if (expected === null || expected === undefined) {
		return actual === null || actual === undefined;
	}
	return commercialEvidenceAmountMatches(actual, round2(expected));
}

function commercialDailyPricingTotals(reservation = {}) {
	const rooms = Array.isArray(reservation.pickedRoomsPricing)
		? reservation.pickedRoomsPricing
		: [];
	if (!rooms.length) return null;
	const exactCents = { client: 0, root: 0, payout: 0, expense: 0, margin: 0 };
	let commercialRowsExact = true;
	for (const room of rooms) {
		const count = Math.max(1, Number(room?.count || 1));
		if (
			!Number.isSafeInteger(count) ||
			!Array.isArray(room?.pricingByDay) ||
			!room.pricingByDay.length
		) {
			return null;
		}
		for (const day of room.pricingByDay) {
			const client = Number(day?.clientPrice);
			const root = Number(day?.rootPrice);
			const payout = Number(day?.netAfterExpenses);
			const expense = Number(day?.otaExpenseAmount);
			const margin = Number(day?.platformMargin);
			const clientCents = decimalMoneyCents(day?.clientPrice);
			const rootCents = decimalMoneyCents(day?.rootPrice);
			const payoutCents = decimalMoneyCents(day?.netAfterExpenses);
			const expenseCents = decimalMoneyCents(day?.otaExpenseAmount);
			const marginCents = decimalMoneyCents(day?.platformMargin);
			if (
				![client, root, payout, expense, margin].every(Number.isFinite) ||
				![clientCents, rootCents, payoutCents, expenseCents, marginCents].every(
					Number.isSafeInteger
				) ||
				client < 0 ||
				root < 0 ||
				payout < 0 ||
				Math.abs(round2(client - payout) - round2(expense)) > 0.02 ||
				Math.abs(round2(payout - root) - round2(margin)) > 0.02
			) {
				return null;
			}
			exactCents.client += clientCents * count;
			exactCents.root += rootCents * count;
			exactCents.payout += payoutCents * count;
			exactCents.expense += expenseCents * count;
			exactCents.margin += marginCents * count;
			commercialRowsExact = Boolean(
				commercialRowsExact &&
					clientCents - payoutCents === expenseCents &&
					payoutCents - rootCents === marginCents
			);
			if (!Object.values(exactCents).every(Number.isSafeInteger)) return null;
		}
	}
	return {
		client: exactCents.client / 100,
		root: exactCents.root / 100,
		payout: exactCents.payout / 100,
		expense: exactCents.expense / 100,
		margin: exactCents.margin / 100,
		commercialRowsExact,
	};
}

const HOTELRUNNER_SAME_EVIDENCE_DAILY_MAX_DRIFT_CENTS = 50;
const HOTELRUNNER_AMOUNT_ROLE_MATCH_MAX_DRIFT_CENTS = 50;
const HOTELRUNNER_UNRESOLVED_COMMERCIAL_SOURCE_TYPES = new Set([
	"hotelrunner_api",
	"hotelrunner_email_relay",
	"hotelrunner_webhook",
]);

function commercialEvidenceWithinCents(actual, expected, maxDriftCents) {
	const actualCents = decimalMoneyCents(actual);
	const expectedCents = decimalMoneyCents(expected);
	return !!(
		actualCents !== null &&
		expectedCents !== null &&
		Number.isSafeInteger(maxDriftCents) &&
		maxDriftCents >= 0 &&
		Math.abs(actualCents - expectedCents) <= maxDriftCents
	);
}

function hotelRunnerEmailCommercialMaterializationState(
	reservation = {},
	marker = {}
) {
	const pricing = reservation.adminPricing || {};
	const summary = reservation.ota_financial_summary || {};
	const supplier = reservation.supplierData || {};
	const gross = round2(marker.grossTotalSar);
	const payout = round2(marker.payoutTotalSar);
	const expense = round2(marker.otaExpenseTotalSar);
	const version = Number(marker.version || 1);
	const markerAmountMatches =
		version >= 2
			? commercialEvidenceExactCentsMatch
			: commercialEvidenceAmountMatches;
	const explicitCommission =
		marker.otaCommissionSar === null || marker.otaCommissionSar === undefined
			? null
			: round2(marker.otaCommissionSar);
	const daily = version >= 2 ? commercialDailyPricingTotals(reservation) : null;
	const dailyCommercialMaterialized =
		version < 2 ||
		Boolean(
			daily &&
				daily.commercialRowsExact === true &&
				commercialEvidenceExactCentsMatch(daily.client, gross) &&
				commercialEvidenceExactCentsMatch(daily.payout, payout) &&
				commercialEvidenceExactCentsMatch(daily.expense, expense)
		);
	const dailyCommercialWithinRematerializationBound = Boolean(
		daily &&
			daily.commercialRowsExact === true &&
			commercialEvidenceWithinCents(
				daily.client,
				gross,
				HOTELRUNNER_SAME_EVIDENCE_DAILY_MAX_DRIFT_CENTS
			) &&
			commercialEvidenceWithinCents(
				daily.payout,
				payout,
				HOTELRUNNER_SAME_EVIDENCE_DAILY_MAX_DRIFT_CENTS
			) &&
			commercialEvidenceWithinCents(
				daily.expense,
				expense,
				HOTELRUNNER_SAME_EVIDENCE_DAILY_MAX_DRIFT_CENTS
			)
	);
	const commissionMaterialized =
		version < 2 ||
		Boolean(
			nullableCommercialAmountMatches(
				reservation.commission_ota,
				explicitCommission
			) &&
				nullableCommercialAmountMatches(
					supplier.otaCommissionSar,
					explicitCommission
				) &&
				normalizeMarker(supplier.otaCommissionSource || "") ===
					(explicitCommission === null
						? ""
						: normalizeMarker(
								marker.provider === "agoda"
									? "agoda_commission"
									: supplier.otaCommissionSource
						  )) &&
				supplier.otaCommissionSourceBacked === (explicitCommission !== null)
		);
	const dailyAuxiliaryMaterialized =
		version < 2 ||
		Boolean(
			daily &&
				daily.commercialRowsExact === true &&
				commercialEvidenceExactCentsMatch(daily.root, pricing.rootTotal) &&
				commercialEvidenceExactCentsMatch(
					daily.margin,
					pricing.platformMarginTotal
				) &&
				commissionMaterialized
		);
	const dailyAuxiliaryWithinRematerializationBound = Boolean(
		daily &&
			daily.commercialRowsExact === true &&
			commercialEvidenceExactCentsMatch(daily.root, pricing.rootTotal) &&
			commercialEvidenceWithinCents(
				daily.margin,
				pricing.platformMarginTotal,
				HOTELRUNNER_SAME_EVIDENCE_DAILY_MAX_DRIFT_CENTS
			) &&
			commissionMaterialized
	);
	const commonMaterialized = !!(
		(version < 2 || markerAmountMatches(reservation.total_amount, gross)) &&
		markerAmountMatches(pricing.clientTotal, gross) &&
		markerAmountMatches(summary.clientTotal, gross) &&
		markerAmountMatches(pricing.netAfterExpensesTotal, payout) &&
		markerAmountMatches(pricing.otaExpenseTotal, expense) &&
		pricing.defaultDeductionApplied === false &&
		pricing.commercialVerified === true &&
		!normalizeWhitespace(pricing.payoutFallbackReason || "") &&
		summary.show === true &&
		markerAmountMatches(summary.netAfterExpenses, payout) &&
		markerAmountMatches(summary.netAfterOtaExpenses, payout) &&
		markerAmountMatches(summary.otaExpenseTotal, expense) &&
		summary.commercialVerified === true &&
		!normalizeWhitespace(summary.payoutFallbackReason || "") &&
		markerAmountMatches(supplier.otaTotalPayoutSar, payout) &&
		markerAmountMatches(supplier.otaExpenseTotalSar, expense) &&
		!normalizeWhitespace(supplier.otaPayoutFallbackReason || "") &&
		commercialEvidencePaymentSummaryMatches(summary.paymentSummary, marker, {
			exactPropertyCents: version >= 2,
		}) &&
		commercialEvidencePaymentSummaryMatches(supplier.otaPaymentSummary, marker, {
			exactPropertyCents: version >= 2,
		})
	);
	return {
		fullyMaterialized:
			commonMaterialized &&
			dailyCommercialMaterialized &&
			dailyAuxiliaryMaterialized,
		onlyDailyCommercialDrift: Boolean(
			version === 2 &&
				commonMaterialized &&
				daily &&
				dailyCommercialWithinRematerializationBound &&
				dailyAuxiliaryWithinRematerializationBound &&
				!(dailyCommercialMaterialized && dailyAuxiliaryMaterialized)
		),
	};
}

function hotelRunnerEmailCommercialEvidenceIsMaterialized(
	reservation = {},
	marker = {}
) {
	return hotelRunnerEmailCommercialMaterializationState(reservation, marker)
		.fullyMaterialized;
}

function validatedHotelRunnerEmailCommercialEvidenceMarker(
	reservation = {},
	{ provider = "", grossTotalSar, currency = "" } = {}
) {
	const marker = reservation?.supplierData?.hotelRunnerEmailCommercialEvidence;
	if (!marker || typeof marker !== "object" || Array.isArray(marker)) return null;
	const markerProvider = normalizeOtaIdentityProvider(marker.provider);
	const requestedProvider = provider
		? normalizeOtaIdentityProvider(provider)
		: markerProvider;
	const markerIdentity = normalizeWhitespace(marker.otaIdentityKey || "").toLowerCase();
	const reservationIdentities = new Set(
		[
			reservation.otaIdentityKey,
			reservation.otaCrossTransportIdentityKey,
		]
			.map((value) => normalizeWhitespace(value || "").toLowerCase())
			.filter(Boolean)
	);
	const markerGross = round2(marker.grossTotalSar);
	const markerPayout = round2(marker.payoutTotalSar);
	const markerExpense = round2(marker.otaExpenseTotalSar);
	const markerVersion = Number(marker.version || 0);
	const markerCommission =
		marker.otaCommissionSar === null || marker.otaCommissionSar === undefined
			? null
			: Number(marker.otaCommissionSar);
	const markerComponents = Array.isArray(marker.deductionComponents)
		? marker.deductionComponents
		: [];
	const markerComponentsValid = markerComponents.every(
		(component) =>
			normalizeMarker(component?.type || "") &&
			normalizeWhitespace(component?.label || "") &&
			Number.isFinite(Number(component?.amountSar)) &&
			Number(component.amountSar) > 0 &&
			String(component?.currency || "").trim().toUpperCase() === "SAR" &&
			normalizeMarker(component?.source || "").startsWith("authenticated_")
	);
	const markerNamedDeductionTotal = round2(
		markerComponents.reduce(
			(sum, component) => sum + Number(component?.amountSar || 0),
			0
		)
	);
	const markerUnclassified = Number(marker.unclassifiedDeductionSar);
	const markerCommissionComponent = markerComponents.find(
		(component) => normalizeMarker(component?.type || "") === "commission"
	);
	const versionTwoEvidenceValid =
		markerVersion !== 2 ||
		Boolean(
			markerComponentsValid &&
				(markerCommission === null ||
					(Number.isFinite(markerCommission) && markerCommission >= 0)) &&
				Number.isFinite(markerUnclassified) &&
				markerUnclassified >= 0 &&
				Math.abs(
					round2(markerNamedDeductionTotal + markerUnclassified) -
						markerExpense
				) <= 0.02 &&
				(markerCommission === null
					? !markerCommissionComponent
					: markerCommissionComponent &&
					  Math.abs(
							round2(markerCommissionComponent.amountSar) -
								round2(markerCommission)
						) <= 0.02)
		);
	const markerCurrency = String(marker.currency || "").trim().toUpperCase();
	const requestedCurrency = String(currency || markerCurrency)
		.trim()
		.toUpperCase();
	const requestedGross =
		grossTotalSar === undefined || grossTotalSar === null
			? markerGross
			: round2(grossTotalSar);
	if (
		![1, 2].includes(markerVersion) ||
		!versionTwoEvidenceValid ||
		marker.verified !== true ||
		marker.source !== "authenticated_ota_email" ||
		!markerProvider ||
		!requestedProvider ||
		markerProvider !== requestedProvider ||
		!markerIdentity ||
		!markerIdentity.startsWith(`${markerProvider}:`) ||
		!reservationIdentities.has(markerIdentity) ||
		markerCurrency !== "SAR" ||
		requestedCurrency !== markerCurrency ||
		markerGross <= 0 ||
		markerPayout <= 0 ||
		markerPayout > markerGross + 0.02 ||
		markerExpense < 0 ||
		Math.abs(round2(markerGross - markerPayout) - markerExpense) > 0.02 ||
		requestedGross <= 0 ||
		Math.abs(markerGross - requestedGross) > 0.02 ||
		!validOtaEventDate(marker.sourceReceivedAt) ||
		!validOtaEventDate(marker.appliedAt) ||
		!constantTimeEvidenceHashMatches(
			marker.evidenceHash,
			hotelRunnerEmailCommercialEvidenceHash(marker)
		)
	) {
		return null;
	}
	return { ...marker };
}

function verifiedHotelRunnerEmailCommercialEvidence(
	reservation = {},
	options = {}
) {
	const marker = validatedHotelRunnerEmailCommercialEvidenceMarker(
		reservation,
		options
	);
	return marker &&
		hotelRunnerEmailCommercialEvidenceIsMaterialized(reservation, marker)
		? marker
		: null;
}

function directHotelRunnerAuthoritativeReportedTotal(existing = {}) {
	const pricing = existing.adminPricing || {};
	const summary = existing.ota_financial_summary || {};
	const supplier = existing.supplierData || {};
	const rawStoredEvidence = supplier.otaCommercialEvidence;
	const hasStoredHotelRunnerApiEvidence = Boolean(
		rawStoredEvidence &&
			typeof rawStoredEvidence === "object" &&
			!Array.isArray(rawStoredEvidence) &&
			HOTELRUNNER_UNRESOLVED_COMMERCIAL_SOURCE_TYPES.has(
				String(rawStoredEvidence.sourceType || "").trim().toLowerCase()
			)
	);
	const pricingMode = normalizeComparable(pricing.mode || "");
	const pricingSource = normalizeComparable(pricing.source || "");
	const summarySource = normalizeComparable(summary.source || "");
	if (
		pricingMode !== "hotelrunner api" ||
		pricingSource !== "hotelrunner api" ||
		(summarySource && summarySource !== "hotelrunner api") ||
		String(existing.currency || "").trim().toUpperCase() !== "SAR"
	) {
		return 0;
	}
	const provider = normalizeOtaIdentityProvider(
		supplier.otaProvider || supplier.supplierName || existing.booking_source
	);
	const storedApiEvidence = validatedOtaCommercialEvidence(
		supplier.otaCommercialEvidence,
		{ provider }
	);
	const reported = storedApiEvidence?.hotelRunnerReportedAmount;
	const apiCandidates = [
		Number(reported?.amount),
		Number(supplier.hotelRunner?.pricing?.grandTotal),
		Number(pricing.sourceAmount),
		Number(summary.sourceAmount),
	];
	if (
		storedApiEvidence?.verificationState === "unresolved" &&
		reported?.role === "unknown" &&
		reported?.roleVerified === false &&
		String(reported?.currency || "").trim().toUpperCase() === "SAR" &&
		String(supplier.hotelRunner?.pricing?.currency || "")
			.trim()
			.toUpperCase() === "SAR" &&
		apiCandidates.every((value) => Number.isFinite(value) && value > 0)
	) {
		const apiTotal = round2(apiCandidates[0]);
		if (
			apiCandidates.every(
				(value) => Math.abs(round2(value) - apiTotal) <= 0.02
			)
		) {
			return apiTotal;
		}
	}
	// A current HotelRunner evidence contract is the API authority boundary. If
	// any part of its redundant amount tuple is missing, stale, or tampered, do
	// not reinterpret older client-facing totals as HotelRunner's amount.
	if (hasStoredHotelRunnerApiEvidence) return 0;
	// Compatibility for older HotelRunner-owned rows that predate the immutable
	// unresolved API evidence contract but already materialized one consistent
	// client amount across all three commercial surfaces.
	const candidates = [
		Number(existing.total_amount),
		Number(pricing.clientTotal),
		Number(summary.clientTotal),
	];
	if (!candidates.every((value) => Number.isFinite(value) && value > 0)) {
		return 0;
	}
	const gross = round2(candidates[0]);
	return candidates.every((value) => Math.abs(round2(value) - gross) <= 0.02)
		? gross
		: 0;
}

function directHotelRunnerEmailIdentityMatches(
	normalized = {},
	existing = {},
	matchedReservationBy = []
) {
	const provider = normalizeOtaIdentityProvider(normalized.provider);
	const existingProvider = normalizeOtaIdentityProvider(
		existing?.supplierData?.otaProvider ||
			existing?.supplierData?.supplierName ||
			existing.booking_source
	);
	const confirmationNumber = normalizeConfirmation(
		normalized.confirmationNumber || normalized.reservationId
	);
	const expectedIdentity = buildOtaIdentityKey(provider, confirmationNumber);
	const existingIdentities = new Set(
		[existing.otaIdentityKey, existing.otaCrossTransportIdentityKey]
			.map((value) => normalizeWhitespace(value || "").toLowerCase())
			.filter(Boolean)
	);
	return Boolean(
		provider &&
		existingProvider === provider &&
		hasSourceField(normalized, "confirmationNumber") &&
		expectedIdentity &&
		existingIdentities.has(expectedIdentity.toLowerCase()) &&
		Array.isArray(matchedReservationBy) &&
		matchedReservationBy.some((field) =>
			["otaIdentityKey", "otaCrossTransportIdentityKey"].includes(field)
		)
	);
}

function directHotelRunnerEmailHotelMatches(
	normalized = {},
	existing = {},
	hotelDetails = null
) {
	const existingOwnerId = normalizeId(existing.belongsTo);
	const hotelOwnerId = normalizeId(hotelDetails?.belongsTo);
	if (
		!hotelDetails?._id ||
		hotelDetails.activateHotel !== true ||
		hotelDetails.xHotelProActive === false ||
		normalizeId(existing.hotelId) !== normalizeId(hotelDetails._id) ||
		!existingOwnerId ||
		!hotelOwnerId ||
		existingOwnerId !== hotelOwnerId
	) {
		return false;
	}
	const exactHotel = findExactHotelNameMatch(
		[hotelDetails],
		expandHotelNameCandidates([
			normalized.hotelName,
			...(Array.isArray(normalized.hotelNameAliases)
				? normalized.hotelNameAliases
				: []),
		])
	);
	return Boolean(
		normalizeId(exactHotel?._id) === normalizeId(hotelDetails._id) ||
			hasVerifiedSourceBackedDirectHotelId(normalized, hotelDetails)
	);
}

function directEmailRoomLabelMatchesProjectedSource(
	incomingRoomName = "",
	projectedSourceRoomName = ""
) {
	const incoming = normalizeComparable(incomingRoomName || "");
	const projected = normalizeComparable(projectedSourceRoomName || "");
	if (!incoming || !projected) return false;
	if (incoming === projected) return true;
	const sourceParts = String(projectedSourceRoomName || "")
		.split(/\s+[-–—]\s+/)
		.map((value) => normalizeComparable(value || ""))
		.filter(Boolean);
	if (sourceParts.length < 2 || sourceParts[0] !== incoming) return false;
	return sourceParts.slice(1).every((part) =>
		/^(?:non refundable|refundable|room only|nr|\d+ occupancy|breakfast included|with breakfast|breakfast|pay at (?:hotel|property)|pay now)$/i.test(
			part
		)
	);
}

function directHotelRunnerEmailRoomMatches(
	normalized = {},
	existing = {},
	hotelDetails = null
) {
	if (!hasSourceField(normalized, "roomName")) return false;
	const sourceRoomName = normalizeComparable(normalized.roomName || "");
	const existingRooms = Array.isArray(existing.pickedRoomsType)
		? existing.pickedRoomsType
		: [];
	const pricingRooms = Array.isArray(existing.pickedRoomsPricing)
		? existing.pickedRoomsPricing
		: [];
	const expectedRoomCount = Number(existing.total_rooms || 0);
	if (
		!sourceRoomName ||
		!Number.isInteger(expectedRoomCount) ||
		expectedRoomCount <= 0 ||
		roomBlockCount(existingRooms) !== expectedRoomCount ||
		roomBlockCount(pricingRooms) !== expectedRoomCount ||
		!protectedValuesEqual(existingRooms, pricingRooms)
	) {
		return false;
	}
	const roomConfigIds = new Set(
		existingRooms
			.map((room) => normalizeId(room?.hotelRoomConfigId || room?.localRoomConfigId))
			.filter(Boolean)
	);
	// One source-backed room name cannot prove a heterogeneous room allocation.
	if (roomConfigIds.size !== 1) return false;
	const [roomConfigId] = roomConfigIds;
	const configuredRooms = Array.isArray(hotelDetails?.roomCountDetails)
		? hotelDetails.roomCountDetails
		: [];
	const configuredRoomById = configuredRooms.filter(
		(room) =>
			room?.activeRoom !== false &&
			normalizeId(room?._id) === roomConfigId
	);
	const exactProjectedSourceRoomMatch = existingRooms.every((room) =>
		[room?.sourceRoomName, room?.otaMatchedRoomName]
			.filter(Boolean)
			.some((value) =>
				directEmailRoomLabelMatchesProjectedSource(
					normalized.roomName,
					value
				)
			)
	);
	if (configuredRoomById.length === 1 && exactProjectedSourceRoomMatch) {
		return true;
	}
	const exactConfiguredMatches = configuredRooms.filter(
		(room) =>
			room?.activeRoom !== false &&
			[room?.displayName, room?.displayName_OtherLanguage]
				.map((value) => normalizeComparable(value || ""))
				.filter(Boolean)
				.includes(sourceRoomName)
	);
	return !!(
		exactConfiguredMatches.length === 1 &&
		normalizeId(exactConfiguredMatches[0]?._id) === roomConfigId
	);
}

function directHotelRunnerOwnsExactMultiRoomAllocation(
	existing = {},
	hotelDetails = null
) {
	const existingRooms = Array.isArray(existing.pickedRoomsType)
		? existing.pickedRoomsType
		: [];
	const pricingRooms = Array.isArray(existing.pickedRoomsPricing)
		? existing.pickedRoomsPricing
		: [];
	const expectedRoomCount = Number(existing.total_rooms || 0);
	if (
		!Number.isInteger(expectedRoomCount) ||
		expectedRoomCount <= 1 ||
		roomBlockCount(existingRooms) !== expectedRoomCount ||
		roomBlockCount(pricingRooms) !== expectedRoomCount ||
		!protectedValuesEqual(existingRooms, pricingRooms)
	) {
		return false;
	}
	const configuredRoomIds = new Set(
		(Array.isArray(hotelDetails?.roomCountDetails)
			? hotelDetails.roomCountDetails
			: []
		)
			.filter((room) => room?.activeRoom !== false && normalizeId(room?._id))
			.map((room) => normalizeId(room._id))
	);
	return existingRooms.every((room) => {
		const roomId = normalizeId(
			room?.hotelRoomConfigId || room?.localRoomConfigId
		);
		return Boolean(roomId && configuredRoomIds.has(roomId));
	});
}

function directHotelRunnerTopLevelPaymentStateProtected(existing = {}) {
	const financeStatus = normalizeComparable(existing.financeStatus || "");
	const payment = normalizeComparable(existing.payment || "");
	const reportedPayment = normalizeComparable(
		existing?.supplierData?.hotelRunner?.reportedPaymentMethod || ""
	);
	return financeStatus !== "not paid" || payment !== reportedPayment;
}

function isPristineHotelRunnerOtaReview(existing = {}) {
	if (!hasDirectHotelRunnerProjection(existing)) return false;
	const states = [existing.state, existing.reservation_status].map((value) =>
		normalizeComparable(value || "")
	);
	if (!states.every((value) => value === "ota platform review")) return false;
	const review = existing.otaPlatformReview;
	const visibility = existing.adminPricingVisibility;
	if (
		!review ||
		typeof review !== "object" ||
		Array.isArray(review) ||
		!visibility ||
		typeof visibility !== "object" ||
		Array.isArray(visibility)
	) {
		return false;
	}
	const allowedReviewKeys = new Set([
		"status",
		"source",
		"inboundEmailId",
		"provider",
		"providerLabel",
		"confirmationNumber",
		"createdAt",
		"releasedAt",
		"releasedBy",
		"priceAtRelease",
		"hotelRunnerManaged",
		"hotelRunnerLinkedAt",
		"lastHotelRunnerUpdatedAt",
		"hotelAssignmentRequired",
		"hotelAssignmentStatus",
		"assignedHotelId",
		"assignedHotelName",
		"assignedAt",
		"roomMappingStatus",
		"roomMappingHotelId",
		"lastUpdatedAt",
	]);
	const allowedVisibilityKeys = new Set([
		"rootOnlyForHotelManagement",
		"source",
		"appliedAt",
		"appliedBy",
	]);
	if (
		Object.entries(review).some(
			([key, value]) =>
				!allowedReviewKeys.has(key) && hasMeaningfulProtectedValue(value)
		) ||
		Object.entries(visibility).some(
			([key, value]) =>
				!allowedVisibilityKeys.has(key) && hasMeaningfulProtectedValue(value)
		)
	) {
		return false;
	}
	const hotelId = normalizeId(existing.hotelId);
	const reviewProvider = normalizeOtaIdentityProvider(review.provider);
	const supplierProvider = normalizeOtaIdentityProvider(
		existing?.supplierData?.otaProvider
	);
	const reviewConfirmation = normalizeConfirmation(review.confirmationNumber);
	const supplierConfirmation = normalizeConfirmation(
		existing?.supplierData?.otaConfirmationNumber ||
			existing?.supplierData?.platformConfirmationNumber ||
			existing?.supplierData?.suppliedBookingNo
	);
	return !!(
		hotelId &&
		reviewProvider &&
		reviewProvider === supplierProvider &&
		reviewConfirmation &&
		reviewConfirmation === supplierConfirmation &&
		normalizeComparable(review.status || "") === "pending" &&
		normalizeMarker(review.source) === "hotelrunner_api" &&
		review.hotelRunnerManaged === true &&
		review.hotelAssignmentRequired === false &&
		normalizeComparable(review.hotelAssignmentStatus || "") === "assigned" &&
		normalizeId(review.assignedHotelId) === hotelId &&
		normalizeComparable(review.roomMappingStatus || "") === "mapped" &&
		normalizeId(review.roomMappingHotelId) === hotelId &&
		!hasMeaningfulProtectedValue(review.inboundEmailId) &&
		!hasMeaningfulProtectedValue(review.releasedAt) &&
		!hasMeaningfulProtectedValue(review.releasedBy) &&
		!hasMeaningfulProtectedValue(review.priceAtRelease) &&
		visibility.rootOnlyForHotelManagement === true &&
		normalizeMarker(visibility.source) === "hotelrunner_api" &&
		!hasMeaningfulProtectedValue(visibility.appliedBy)
	);
}

function directHotelRunnerCommercialOperationalStateProtected(existing = {}) {
	if (isPristineHotelRunnerOtaReview(existing)) return false;
	if (
		hasTerminalOtaReservationStatus(existing) ||
		hasInhouseOtaReservationStatus(existing)
	) {
		return true;
	}
	const states = [existing.state, existing.reservation_status]
		.map((value) => normalizeComparable(value || ""))
		.filter(Boolean);
	if (
		states.length !== 2 ||
		states[0] !== states[1] ||
		!["confirmed", "pending confirmation"].includes(states[0])
	) {
		return true;
	}
	const pending = existing.pendingConfirmation;
	if (!pending || typeof pending !== "object") return false;
	const pendingStatus = normalizeComparable(pending.status || "");
	if (
		(pendingStatus && !["pending", "confirmed"].includes(pendingStatus)) ||
		pending.inventoryBlocks === false ||
		hasMeaningfulProtectedValue(pending.rejectionReason) ||
		hasMeaningfulProtectedValue(pending.rejectedAt) ||
		hasMeaningfulProtectedValue(pending.cancelledAt) ||
		hasMeaningfulProtectedValue(pending.noShowAt) ||
		hasMeaningfulProtectedValue(pending.lastUpdatedBy)
	) {
		return true;
	}
	return Object.entries(pending).some(
		([key, value]) =>
			/(reject|cancel|no.?show|checked.?in|checked.?out)/i.test(key) &&
			hasMeaningfulProtectedValue(value)
	);
}

function sameEvidenceHotelRunnerDailyCommercialRematerialization(
	existing = {},
	evidence = {}
) {
	const pending = existing.pendingConfirmation;
	if (
		Number(evidence.version) !== 2 ||
		evidence.verified !== true ||
		evidence.source !== "authenticated_ota_email" ||
		!constantTimeEvidenceHashMatches(
			evidence.evidenceHash,
			hotelRunnerEmailCommercialEvidenceHash(evidence)
		) ||
		!isPristineHotelRunnerOtaReview(existing) ||
		hasTerminalOtaReservationStatus(existing) ||
		hasInhouseOtaReservationStatus(existing) ||
		(normalizeMarker(pending?.source || "") === "ota_platform_release") ||
		hasMeaningfulProtectedValue(pending?.releasedToHotelAt)
	) {
		return null;
	}
	const marker = validatedHotelRunnerEmailCommercialEvidenceMarker(existing, {
		provider: evidence.provider,
		grossTotalSar: evidence.grossTotalSar,
		currency: evidence.currency,
	});
	if (
		Number(marker?.version) !== 2 ||
		!constantTimeEvidenceHashMatches(
			marker?.evidenceHash,
			evidence.evidenceHash
		) ||
		!hotelRunnerEmailCommercialMaterializationState(existing, marker)
			.onlyDailyCommercialDrift
	) {
		return null;
	}
	return marker;
}

function directHotelRunnerCommercialEnrichmentProtectedState(
	existing = {},
	{ trustedExistingEvidence = null } = {}
) {
	const pricing = existing.adminPricing || {};
	const summary = existing.ota_financial_summary || {};
	const visibility = existing.adminPricingVisibility || {};
	const pristineHotelRunnerReview = isPristineHotelRunnerOtaReview(existing);
	const trustedOtaCollectPaymentBaseline = Boolean(
		trustedExistingEvidence &&
			recognizedStoredPaymentBaseline(existing)?.model === "ota_collect" &&
			!topLevelPaymentStateHasProtectedDrift(existing)
	);
	const verifiedExistingEvidence = verifiedHotelRunnerEmailCommercialEvidence(
		existing,
		{
			provider: existing?.supplierData?.otaProvider,
			grossTotalSar: existing.total_amount,
			currency: existing.currency,
		}
	);
	const rootCandidates = [
		Number(existing.sub_total),
		Number(pricing.rootTotal),
		Number(summary.hotelVisibleAmount),
	].filter(Number.isFinite);
	const rootPricingDrift =
		rootCandidates.length < 2 ||
		rootCandidates.some(
			(value) => Math.abs(value - rootCandidates[0]) > 0.02
		);
	const unverifiedCommercialFields = Boolean(
		!(verifiedExistingEvidence || trustedExistingEvidence) &&
			(pricing.commercialVerified === true ||
				summary.commercialVerified === true ||
				hasMeaningfulProtectedValue(pricing.netAfterExpensesTotal) ||
				hasMeaningfulProtectedValue(pricing.otaExpenseTotal) ||
				hasMeaningfulProtectedValue(summary.netAfterExpenses) ||
				hasMeaningfulProtectedValue(summary.netAfterOtaExpenses) ||
				hasMeaningfulProtectedValue(summary.otaExpenseTotal))
	);
	if (
		directHotelRunnerCommercialOperationalStateProtected(existing) ||
		(Array.isArray(existing.roomId) &&
			existing.roomId.some((roomId) => normalizeId(roomId))) ||
		(Array.isArray(existing.bedNumber) &&
			existing.bedNumber.some(hasMeaningfulProtectedValue)) ||
		hasCaptureOrSettlementActivity(existing) ||
		(Math.abs(Number(existing.paid_amount || 0)) > 0.0001 &&
			!trustedOtaCollectPaymentBaseline) ||
		(directHotelRunnerTopLevelPaymentStateProtected(existing) &&
			!trustedOtaCollectPaymentBaseline) ||
		paidAmountBreakdownHasProtectedState(existing) ||
		financialCycleHasProtectedState(existing) ||
		(adminPricingVisibilityHasProtectedState(existing) &&
			!pristineHotelRunnerReview) ||
		(otaReviewHasProtectedState(existing) && !pristineHotelRunnerReview) ||
		roomArraysHaveProtectedState(existing) ||
		supplierDataHasProtectedState(existing) ||
		rootPricingDrift ||
		unverifiedCommercialFields ||
		Math.abs(Number(existing.commission || 0)) > 0.0001 ||
		(Array.isArray(existing.adminChangeLog) && existing.adminChangeLog.length) ||
		hasMeaningfulProtectedValue(existing.createdByUserId) ||
		hasMeaningfulProtectedValue(existing.orderTakeId) ||
		hasMeaningfulProtectedValue(existing.financeRejectionComment) ||
		hasMeaningfulProtectedValue(existing.totalReviewStatus) ||
		hasMeaningfulProtectedValue(visibility.appliedBy) ||
		Object.keys(pricing).some((key) => /override|manual/i.test(key))
	) {
		return true;
	}
	return false;
}

function directHotelRunnerEmailCommercialGuard({
	normalized = {},
	existing = {},
	hotelDetails = null,
	matchedReservationBy = [],
	evidence = null,
} = {}) {
	const reject = (reason) => ({ ok: false, reason });
	if (
		!hasDirectHotelRunnerProjection(existing) ||
		!isOtaInboundEmail(normalized) ||
		normalized.sourceSenderTrusted !== true ||
		normalized.sourceSenderAuthenticated !== true ||
		(normalized.requiresManualReview === true &&
			!agodaMultiRoomAllocationReviewAllowsCommercialOnly(normalized)) ||
		normalizeComparable(normalized.intent || "") !== "new reservation" ||
		normalizeComparable(normalized.eventType || "") !== "new"
	) {
		return reject("source_authority");
	}
	if (!evidence) return reject("commercial_evidence");
	if (
		!directHotelRunnerEmailIdentityMatches(
			normalized,
			existing,
			matchedReservationBy
		)
	) {
		return reject("identity");
	}
	if (!exactSourceBackedStayMatchesExisting(normalized, existing)) {
		return reject("stay");
	}
	const incomingRoomCount = Number(normalized.roomCount || 0);
	if (
		!hasSourceField(normalized, "roomCount") ||
		!Number.isInteger(incomingRoomCount) ||
		incomingRoomCount <= 0 ||
		incomingRoomCount !== Number(existing.total_rooms || 0)
	) {
		return reject("room_count");
	}
	const roomIdentityMatches = agodaMultiRoomAllocationReviewAllowsCommercialOnly(
		normalized
	)
		? directHotelRunnerOwnsExactMultiRoomAllocation(existing, hotelDetails)
		: directHotelRunnerEmailRoomMatches(normalized, existing, hotelDetails);
	if (!roomIdentityMatches) {
		return reject("room_identity");
	}
	if (!directHotelRunnerEmailHotelMatches(normalized, existing, hotelDetails)) {
		return reject("hotel");
	}
	const hotelRunnerReportedTotal =
		directHotelRunnerAuthoritativeReportedTotal(existing);
	const evidenceGross = Number(evidence.grossTotalSar || 0);
	const evidencePayout = Number(evidence.payoutTotalSar || 0);
	const reportedTotalMatchesGross = Boolean(
		hotelRunnerReportedTotal > 0 &&
			commercialEvidenceWithinCents(
				hotelRunnerReportedTotal,
				evidenceGross,
				HOTELRUNNER_AMOUNT_ROLE_MATCH_MAX_DRIFT_CENTS
			)
	);
	const reportedTotalMatchesPayout = Boolean(
		hotelRunnerReportedTotal > 0 &&
			commercialEvidenceWithinCents(
				hotelRunnerReportedTotal,
				evidencePayout,
				HOTELRUNNER_AMOUNT_ROLE_MATCH_MAX_DRIFT_CENTS
			)
	);
	if (reportedTotalMatchesGross && reportedTotalMatchesPayout) {
		return reject("hotelrunner_amount_ambiguous");
	}
	if (!reportedTotalMatchesGross && !reportedTotalMatchesPayout) {
		return reject("hotelrunner_amount");
	}
	const reportedTotalRole = reportedTotalMatchesGross ? "gross" : "payout";
	const sameEvidenceRematerialization =
		sameEvidenceHotelRunnerDailyCommercialRematerialization(existing, evidence);
	if (
		directHotelRunnerCommercialEnrichmentProtectedState(existing, {
			trustedExistingEvidence: sameEvidenceRematerialization,
		})
	) {
		return reject("protected_state");
	}
	const commercialPricing = buildDirectHotelRunnerCommercialPricing(
		existing,
		normalized,
		evidence,
		{ reportedTotalRole }
	);
	if (
		!commercialPricing ||
		![
			Number(existing.sub_total),
			Number(existing.adminPricing?.rootTotal),
			Number(existing.ota_financial_summary?.hotelVisibleAmount),
		].every(
			(value) =>
				Number.isFinite(value) &&
				Math.abs(round2(value) - commercialPricing.rootTotal) <= 0.02
		)
	) {
		return reject("daily_pricing");
	}
	let sameEvidenceRematerializationSet = null;
	if (sameEvidenceRematerialization) {
		const generatedSet = directHotelRunnerCommercialEnrichmentSet(
			normalized,
			sameEvidenceRematerialization,
			{
				reportedTotalRole,
				existing,
				commercialPricing,
			}
		);
		sameEvidenceRematerializationSet =
			directHotelRunnerSameEvidenceDailyCommercialSet(existing, generatedSet);
		if (!sameEvidenceRematerializationSet) {
			return reject("non_daily_commercial_drift");
		}
	}
	return {
		ok: true,
		evidence,
		sameEvidenceRematerialization,
		sameEvidenceRematerializationSet,
		hotelRunnerReportedTotal,
		reportedTotalRole,
		commercialPricing,
	};
}

function hasDirectCommercialEvidenceAttempt(normalized = {}) {
	return Boolean(
		hasSourceField(normalized, "amount") &&
		Number(normalized.totalAmountSar || normalized.amount || 0) > 0 &&
		hasExplicitOtaPayoutSar(normalized)
	);
}

function buildDirectHotelRunnerCommercialPricing(
	existing = {},
	normalized = {},
	evidence = {},
	{ reportedTotalRole = "gross" } = {}
) {
	const sourceRooms = Array.isArray(existing.pickedRoomsPricing) &&
		existing.pickedRoomsPricing.length
		? existing.pickedRoomsPricing
		: Array.isArray(existing.pickedRoomsType)
			? existing.pickedRoomsType
			: [];
	if (!sourceRooms.length) return null;
	const slots = [];
	for (const [roomIndex, room] of sourceRooms.entries()) {
		if (
			Number(room?.count || 1) !== 1 ||
			!Array.isArray(room?.pricingByDay) ||
			!room.pricingByDay.length
		) {
			return null;
		}
		for (const [dayIndex, day] of room.pricingByDay.entries()) {
			const date = parseDate(day?.date);
			const currentSource = Number(
				day?.hotelRunnerSourcePrice ?? day?.clientPrice ?? day?.price
			);
			const root = Number(day?.rootPrice);
			if (
				!date ||
				!Number.isFinite(currentSource) ||
				currentSource <= 0 ||
				!Number.isFinite(root) ||
				root < 0
			) {
				return null;
			}
			slots.push({ roomIndex, dayIndex, date, currentSource, root });
		}
	}
	const gross = round2(evidence.grossTotalSar);
	const payout = round2(evidence.payoutTotalSar);
	if (gross <= 0 || payout <= 0 || payout > gross + 0.02) return null;
	const nightly = Array.isArray(normalized.nightlyPricingSar)
		? normalized.nightlyPricingSar
		: [];
	const nightlyByDate = new Map(
		nightly.map((row) => [parseDate(row?.date), row]).filter(([date]) => date)
	);
	const exactNightly =
		nightly.length === slots.length &&
		nightlyByDate.size === slots.length &&
		slots.every((slot) => nightlyByDate.has(slot.date));
	const sourcePayoutSlots = exactNightly
		? slots.map((slot) => Number(nightlyByDate.get(slot.date)?.payoutAmountSar))
		: [];
	const sourceClientSlots = exactNightly
		? slots.map((slot) => Number(nightlyByDate.get(slot.date)?.clientAmountSar))
		: [];
	const currentSlots = slots.map((slot) => slot.currentSource);
	const sumsTo = (values, target) => {
		if (
			values.length !== slots.length ||
			!values.every((value) => Number.isFinite(value) && value > 0)
		) {
			return false;
		}
		const cents = values.map(decimalMoneyCents);
		const targetCents = decimalMoneyCents(target);
		if (
			!cents.every(Number.isSafeInteger) ||
			!Number.isSafeInteger(targetCents)
		) {
			return false;
		}
		const totalCents = cents.reduce((sum, value) => sum + value, 0);
		return Number.isSafeInteger(totalCents) && totalCents === targetCents;
	};
	let payoutSlots = sumsTo(sourcePayoutSlots, payout)
		? sourcePayoutSlots.map(round2)
		: reportedTotalRole === "payout" && sumsTo(currentSlots, payout)
			? currentSlots.map(round2)
			: allocateWeightedAmountAcrossSlots(payout, currentSlots);
	let clientSlots = sumsTo(sourceClientSlots, gross)
		? sourceClientSlots.map(round2)
		: reportedTotalRole === "gross" && sumsTo(currentSlots, gross)
			? currentSlots.map(round2)
			: allocateWeightedAmountAcrossSlots(
					gross,
					payoutSlots.length === slots.length ? payoutSlots : currentSlots
			  );
	if (!sumsTo(payoutSlots, payout) || !sumsTo(clientSlots, gross)) return null;
	if (
		payoutSlots.some(
			(value, index) => Number(value) > Number(clientSlots[index]) + 0.02
		)
	) {
		return null;
	}

	const rooms = sourceRooms.map((room) => ({
		...room,
		pricingByDay: room.pricingByDay.map((day) => ({ ...day })),
	}));
	for (const [index, slot] of slots.entries()) {
		const day = rooms[slot.roomIndex].pricingByDay[slot.dayIndex];
		const client = round2(clientSlots[index]);
		const net = round2(payoutSlots[index]);
		const expense = round2(client - net);
		const margin = round2(net - slot.root);
		Object.assign(day, {
			price: client,
			clientPrice: client,
			mainPrice: client,
			totalPriceWithCommission: client,
			netAfterExpenses: net,
			netAfterOtaExpenses: net,
			otaExpenseAmount: expense,
			platformMargin: margin,
			commercialVerification: "authenticated_ota_email_verified",
			hotelRunnerSourcePrice: round2(slot.currentSource),
		});
	}
	for (const room of rooms) {
		room.totalPriceWithCommission = round2(
			room.pricingByDay.reduce(
				(sum, day) => sum + Number(day.clientPrice || 0),
				0
			)
		);
		room.hotelShouldGet = round2(
			room.pricingByDay.reduce(
				(sum, day) => sum + Number(day.rootPrice || 0),
				0
			)
		);
		room.chosenPrice = round2(
			room.totalPriceWithCommission / room.pricingByDay.length
		);
	}
	const rootTotal = round2(slots.reduce((sum, slot) => sum + slot.root, 0));
	return {
		rooms,
		clientTotal: gross,
		rootTotal,
		netAfterExpensesTotal: payout,
		otaExpenseTotal: round2(gross - payout),
		platformMarginTotal: round2(payout - rootTotal),
	};
}

// HotelRunner's own payment fields remain informational. Promote a provider-
// collected amount only when the same authenticated OTA email that proved the
// commercial bundle also supplied an exact, normalized OTA-collect fact.
function verifiedHotelRunnerOtaCollectPaymentSet(
	normalized = {},
	evidence = {},
	{ existing = {}, pricing = {} } = {}
) {
	if (
		normalized.sourceSenderTrusted !== true ||
		normalized.sourceSenderAuthenticated !== true ||
		!hasSourceField(normalized, "paymentCollectionModel") ||
		normalized.paymentCollectionModel !== "ota_collect" ||
		normalized.paidOnline !== true ||
		Number(evidence.version) !== 2 ||
		evidence.verified !== true ||
		evidence.source !== "authenticated_ota_email" ||
		directHotelRunnerCommercialEnrichmentProtectedState(existing)
	) {
		return {};
	}
	const rebuiltEvidence = buildHotelRunnerEmailCommercialEvidence(normalized, {
		appliedAt: evidence.appliedAt,
	});
	if (
		!rebuiltEvidence ||
		!constantTimeEvidenceHashMatches(
			evidence.evidenceHash,
			hotelRunnerEmailCommercialEvidenceHash(evidence)
		) ||
		!constantTimeEvidenceHashMatches(
			evidence.evidenceHash,
			rebuiltEvidence.evidenceHash
		)
	) {
		return {};
	}
	const evidenceGrossCents = decimalMoneyCents(evidence.grossTotalSar);
	const pricingGrossCents = decimalMoneyCents(pricing.clientTotal);
	const rootTotal = Number(pricing.rootTotal);
	if (
		evidenceGrossCents <= 0 ||
		evidenceGrossCents !== pricingGrossCents ||
		!Number.isFinite(rootTotal) ||
		rootTotal < 0
	) {
		return {};
	}
	const paymentMapping = resolvePaymentMapping(
		normalized,
		evidence.grossTotalSar,
		rootTotal,
		0
	);
	if (
		paymentMapping.payment !== "paid online" ||
		paymentMapping.financeStatus !== "paid online" ||
		decimalMoneyCents(paymentMapping.paidAmount) !== evidenceGrossCents ||
		decimalMoneyCents(
			paymentMapping.paidAmountBreakdown?.paid_online_other_platforms
		) !== evidenceGrossCents
	) {
		return {};
	}
	return {
		payment: paymentMapping.payment,
		financeStatus: paymentMapping.financeStatus,
		paid_amount: paymentMapping.paidAmount,
		paid_amount_breakdown: paymentMapping.paidAmountBreakdown,
		financial_cycle: paymentMapping.financialCycle,
		"supplierData.otaPaymentCollectionModel": "ota_collect",
	};
}

function directHotelRunnerCommercialEnrichmentSet(
	normalized = {},
	evidence = {},
	{
		reportedTotalRole = "gross",
		existing = {},
		commercialPricing = null,
		materializeVerifiedOtaCollectPayment = false,
	} = {}
) {
	const paymentSummary = safeOtaPaymentSummary(normalized.paymentSummary);
	const pricing =
		commercialPricing ||
		buildDirectHotelRunnerCommercialPricing(existing, normalized, evidence, {
			reportedTotalRole,
		});
	if (!pricing) return null;
	const otaCommercialEvidence = buildNormalizedOtaCommercialEvidence(
		{
			...normalized,
			propertyCurrency: "SAR",
		},
		{ propertyCurrency: "SAR" }
	);
	const explicitCommission =
		otaCommercialEvidence?.roles?.explicitOtaCommission?.propertyAmount ??
		(evidence.otaCommissionSar === null || evidence.otaCommissionSar === undefined
			? null
			: round2(evidence.otaCommissionSar));
	const otaCollectPaymentSet = materializeVerifiedOtaCollectPayment
		? verifiedHotelRunnerOtaCollectPaymentSet(normalized, evidence, {
				existing,
				pricing,
			})
		: {};
	const set = {
		// Keep xHotelPro/platform commission separate from the OTA's fee. The OTA
		// amount is written only from the complete, authenticated evidence above.
		commission: 0,
		commission_ota: explicitCommission,
		currency: "SAR",
		total_amount: evidence.grossTotalSar,
		pickedRoomsType: pricing.rooms,
		pickedRoomsPricing: pricing.rooms,
		"adminPricing.clientTotal": evidence.grossTotalSar,
		"adminPricing.netAfterExpensesTotal": evidence.payoutTotalSar,
		"adminPricing.otaExpenseTotal": evidence.otaExpenseTotalSar,
		"adminPricing.platformMarginTotal": pricing.platformMarginTotal,
		"adminPricing.commissionAmount": 0,
		"adminPricing.defaultDeductionApplied": false,
		"adminPricing.payoutFallbackReason": "",
		"adminPricing.commercialVerified": true,
		"ota_financial_summary.show": true,
		"ota_financial_summary.clientTotal": evidence.grossTotalSar,
		"ota_financial_summary.netAfterExpenses": evidence.payoutTotalSar,
		"ota_financial_summary.netAfterOtaExpenses": evidence.payoutTotalSar,
		"ota_financial_summary.otaExpenseTotal": evidence.otaExpenseTotalSar,
		"ota_financial_summary.platformProfit": pricing.platformMarginTotal,
		"ota_financial_summary.commissionAmount": 0,
		"ota_financial_summary.otaCommissionAmount": explicitCommission,
		"ota_financial_summary.otaDeductionBreakdown":
			evidence.deductionComponents || [],
		"ota_financial_summary.unclassifiedOtaDeduction":
			evidence.unclassifiedDeductionSar,
		"ota_financial_summary.commercialVerified": true,
		"ota_financial_summary.paymentSummary": paymentSummary,
		"ota_financial_summary.payoutFallbackReason": "",
		"supplierData.otaPaymentSummary": paymentSummary,
		"supplierData.otaTotalPayoutSar": evidence.payoutTotalSar,
		"supplierData.otaExpenseTotalSar": evidence.otaExpenseTotalSar,
		"supplierData.otaCommissionSar": explicitCommission,
		"supplierData.otaCommissionSource":
			explicitCommission === null ? "" : normalized.otaCommissionSource || "",
		"supplierData.otaCommissionSourceBacked": explicitCommission !== null,
		"supplierData.otaPlatformMarginSar": pricing.platformMarginTotal,
		"supplierData.otaPayoutFallbackReason": "",
		"supplierData.hotelRunnerEmailCommercialEvidence": evidence,
		...(otaCommercialEvidence
			? { "supplierData.otaCommercialEvidence": otaCommercialEvidence }
			: {}),
		...otaCollectPaymentSet,
	};
	return set;
}

const HOTELRUNNER_DAILY_COMMERCIAL_LEAF_KEYS = Object.freeze([
	"price",
	"clientPrice",
	"mainPrice",
	"totalPriceWithCommission",
	"netAfterExpenses",
	"netAfterOtaExpenses",
	"otaExpenseAmount",
	"platformMargin",
	"commercialVerification",
]);
const HOTELRUNNER_ROOM_COMMERCIAL_LEAF_KEYS = Object.freeze([
	"chosenPrice",
	"totalPriceWithCommission",
]);

function dottedDocumentValue(document = {}, path = "") {
	return String(path)
		.split(".")
		.reduce((value, segment) => value?.[segment], document);
}

function withoutObjectKeys(value = {}, excludedKeys = []) {
	const excluded = new Set(excludedKeys);
	return Object.fromEntries(
		Object.entries(value).filter(([key]) => !excluded.has(key))
	);
}

function exactHotelRunnerCommercialRoomLeafSet(
	existingRooms = [],
	generatedRooms = [],
	pathPrefix = ""
) {
	if (
		!Array.isArray(existingRooms) ||
		!Array.isArray(generatedRooms) ||
		existingRooms.length !== generatedRooms.length
	) {
		return null;
	}
	const set = {};
	for (let roomIndex = 0; roomIndex < existingRooms.length; roomIndex += 1) {
		const existingRoom = existingRooms[roomIndex];
		const generatedRoom = generatedRooms[roomIndex];
		if (
			!existingRoom ||
			typeof existingRoom !== "object" ||
			Array.isArray(existingRoom) ||
			!generatedRoom ||
			typeof generatedRoom !== "object" ||
			Array.isArray(generatedRoom) ||
			!protectedValuesEqual(
				withoutObjectKeys(existingRoom, [
					"pricingByDay",
					...HOTELRUNNER_ROOM_COMMERCIAL_LEAF_KEYS,
				]),
				withoutObjectKeys(generatedRoom, [
					"pricingByDay",
					...HOTELRUNNER_ROOM_COMMERCIAL_LEAF_KEYS,
				])
			) ||
			!Array.isArray(existingRoom.pricingByDay) ||
			!Array.isArray(generatedRoom.pricingByDay) ||
			existingRoom.pricingByDay.length !== generatedRoom.pricingByDay.length
		) {
			return null;
		}
		for (const key of HOTELRUNNER_ROOM_COMMERCIAL_LEAF_KEYS) {
			if (!Object.prototype.hasOwnProperty.call(generatedRoom, key)) {
				return null;
			}
			if (!protectedValuesEqual(existingRoom[key], generatedRoom[key])) {
				set[`${pathPrefix}.${roomIndex}.${key}`] = generatedRoom[key];
			}
		}
		for (
			let dayIndex = 0;
			dayIndex < existingRoom.pricingByDay.length;
			dayIndex += 1
		) {
			const existingDay = existingRoom.pricingByDay[dayIndex];
			const generatedDay = generatedRoom.pricingByDay[dayIndex];
			if (
				!existingDay ||
				typeof existingDay !== "object" ||
				Array.isArray(existingDay) ||
				!generatedDay ||
				typeof generatedDay !== "object" ||
				Array.isArray(generatedDay) ||
				!protectedValuesEqual(
					withoutObjectKeys(
						existingDay,
						HOTELRUNNER_DAILY_COMMERCIAL_LEAF_KEYS
					),
					withoutObjectKeys(
						generatedDay,
						HOTELRUNNER_DAILY_COMMERCIAL_LEAF_KEYS
					)
				)
			) {
				return null;
			}
			for (const key of HOTELRUNNER_DAILY_COMMERCIAL_LEAF_KEYS) {
				if (!Object.prototype.hasOwnProperty.call(generatedDay, key)) {
					return null;
				}
				if (!protectedValuesEqual(existingDay[key], generatedDay[key])) {
					set[
						`${pathPrefix}.${roomIndex}.pricingByDay.${dayIndex}.${key}`
					] = generatedDay[key];
				}
			}
		}
	}
	return set;
}

function directHotelRunnerSameEvidenceDailyCommercialSet(
	existing = {},
	generatedSet = {}
) {
	if (!generatedSet || typeof generatedSet !== "object") return null;
	for (const [path, generatedValue] of Object.entries(generatedSet)) {
		if (["pickedRoomsType", "pickedRoomsPricing"].includes(path)) continue;
		if (
			!protectedValuesEqual(
				dottedDocumentValue(existing, path),
				generatedValue
			)
		) {
			return null;
		}
	}
	const pickedRoomsTypeSet = exactHotelRunnerCommercialRoomLeafSet(
		existing.pickedRoomsType,
		generatedSet.pickedRoomsType,
		"pickedRoomsType"
	);
	const pickedRoomsPricingSet = exactHotelRunnerCommercialRoomLeafSet(
		existing.pickedRoomsPricing,
		generatedSet.pickedRoomsPricing,
		"pickedRoomsPricing"
	);
	if (!pickedRoomsTypeSet || !pickedRoomsPricingSet) return null;
	const set = { ...pickedRoomsTypeSet, ...pickedRoomsPricingSet };
	return Object.keys(set).length ? set : null;
}

function applyHotelRunnerEmailCommercialEvidenceToDocument(
	document = {},
	normalized = {},
	evidence = {}
) {
	const paymentSummary = safeOtaPaymentSummary(normalized.paymentSummary);
	const propertyCurrency = "SAR";
	const otaCommercialEvidence = buildNormalizedOtaCommercialEvidence(
		{ ...normalized, propertyCurrency },
		{ propertyCurrency }
	);
	const explicitCommission =
		otaCommercialEvidence?.roles?.explicitOtaCommission?.propertyAmount ??
		(evidence.otaCommissionSar === null || evidence.otaCommissionSar === undefined
			? null
			: round2(evidence.otaCommissionSar));
	document.commission = 0;
	document.commission_ota = explicitCommission;
	document.currency = "SAR";
	document.total_amount = evidence.grossTotalSar;
	document.adminPricing = {
		...(document.adminPricing || {}),
		clientTotal: evidence.grossTotalSar,
		netAfterExpensesTotal: evidence.payoutTotalSar,
		otaExpenseTotal: evidence.otaExpenseTotalSar,
		commissionAmount: 0,
		defaultDeductionApplied: false,
		payoutFallbackReason: "",
		commercialVerified: true,
	};
	document.ota_financial_summary = {
		...(document.ota_financial_summary || {}),
		show: true,
		clientTotal: evidence.grossTotalSar,
		netAfterExpenses: evidence.payoutTotalSar,
		netAfterOtaExpenses: evidence.payoutTotalSar,
		otaExpenseTotal: evidence.otaExpenseTotalSar,
		commissionAmount: 0,
		otaCommissionAmount: explicitCommission,
		otaDeductionBreakdown: evidence.deductionComponents || [],
		unclassifiedOtaDeduction: evidence.unclassifiedDeductionSar,
		commercialVerified: true,
		paymentSummary,
		payoutFallbackReason: "",
	};
	document.supplierData = {
		...(document.supplierData || {}),
		...(otaCommercialEvidence ? { otaCommercialEvidence } : {}),
		otaPaymentSummary: paymentSummary,
		otaTotalPayoutSar: evidence.payoutTotalSar,
		otaExpenseTotalSar: evidence.otaExpenseTotalSar,
		otaCommissionSar: explicitCommission,
		otaCommissionSource:
			explicitCommission === null ? "" : normalized.otaCommissionSource || "",
		otaCommissionSourceBacked: explicitCommission !== null,
		otaPayoutFallbackReason: "",
		hotelRunnerEmailCommercialEvidence: evidence,
	};
}

function directHotelRunnerCommercialSnapshotFilter(existing = {}) {
	const filter = {
		...buildReservationSnapshotFilter(existing, { includeHotel: true }),
		belongsTo: existing.belongsTo,
		state: existing.state,
		reservation_status: existing.reservation_status,
		total_rooms: existing.total_rooms,
		total_amount: existing.total_amount,
		sub_total: existing.sub_total,
		currency: existing.currency,
		commission: existing.commission,
		payment: existing.payment,
		financeStatus: existing.financeStatus,
		paid_amount: existing.paid_amount,
		payment_details: existing.payment_details ?? null,
		paid_amount_breakdown: existing.paid_amount_breakdown ?? null,
		financial_cycle: existing.financial_cycle ?? null,
		pickedRoomsType: existing.pickedRoomsType,
		pickedRoomsPricing: existing.pickedRoomsPricing,
		"adminPricing.mode": existing.adminPricing?.mode,
		"adminPricing.source": existing.adminPricing?.source,
		"adminPricing.clientTotal": existing.adminPricing?.clientTotal,
		"adminPricing.rootTotal": existing.adminPricing?.rootTotal,
		"adminPricing.netAfterExpensesTotal":
			existing.adminPricing?.netAfterExpensesTotal,
		"adminPricing.otaExpenseTotal": existing.adminPricing?.otaExpenseTotal,
		"adminPricing.platformMarginTotal":
			existing.adminPricing?.platformMarginTotal,
		"ota_financial_summary.source": existing.ota_financial_summary?.source,
		"ota_financial_summary.clientTotal":
			existing.ota_financial_summary?.clientTotal,
		"ota_financial_summary.netAfterExpenses":
			existing.ota_financial_summary?.netAfterExpenses,
		"ota_financial_summary.otaExpenseTotal":
			existing.ota_financial_summary?.otaExpenseTotal,
		"supplierData.hotelRunner.transport":
			existing.supplierData?.hotelRunner?.transport,
		"supplierData.hotelRunner.reservationId":
			existing.supplierData?.hotelRunner?.reservationId,
		"supplierData.otaAutomationPipeline":
			existing.supplierData?.otaAutomationPipeline,
		"supplierData.otaSourceAuthority":
			existing.supplierData?.otaSourceAuthority,
		"supplierData.otaPaymentCollectionModel":
			existing.supplierData?.otaPaymentCollectionModel ?? null,
	};
	// MongoDB's equality-to-null matches both the new explicit null and legacy
	// documents where this newly introduced field does not exist yet.
	filter.commission_ota = existing.commission_ota ?? null;
	return filter;
}

async function loadReservationForCommercialEvidence(reservationId) {
	let query = Reservations.findById(reservationId);
	if (query && typeof query.lean === "function") query = query.lean();
	if (query && typeof query.exec === "function") return query.exec();
	return query;
}

async function reconcileDirectHotelRunnerOwnedEmail({
	normalized = {},
	existing = {},
	hotelDetails = null,
	matchedReservationBy = [],
	warnings = [],
	errors = [],
} = {}) {
	if (!hasDirectHotelRunnerProjection(existing) || !isOtaInboundEmail(normalized)) {
		return null;
	}
	const isNewReservation =
		normalizeComparable(normalized.intent || "") === "new reservation" &&
		normalizeComparable(normalized.eventType || "") === "new";
	if (!isNewReservation) {
		if (!hasActiveHotelRunnerLifecycleAuthority(existing)) return null;
		return {
			status: "ignored",
			actionTaken: "skipped",
			skipReason: "lower_authority_ota_event_after_hotelrunner_api",
			automationComment:
				"The OTA email was retained for audit but cannot mutate a reservation already owned by the direct HotelRunner API.",
			warnings,
			errors,
			reservationId: existing._id,
			hotelId: existing.hotelId,
			pmsConfirmationNumber: existing.confirmation_number,
			matchedReservationBy,
		};
	}
	const propertyCurrency = String(existing.currency || "SAR").trim().toUpperCase();
	const otaCommercialEvidence = buildNormalizedOtaCommercialEvidence(
		{ ...normalized, propertyCurrency },
		{ propertyCurrency }
	);
	const evidence = buildHotelRunnerEmailCommercialEvidence(normalized);
	if (!evidence) {
		const evidenceOnlyIdentitySafe = Boolean(
			otaCommercialEvidence &&
			directHotelRunnerEmailIdentityMatches(
				normalized,
				existing,
				matchedReservationBy
			) &&
			exactSourceBackedStayMatchesExisting(normalized, existing) &&
			Number.isInteger(Number(normalized.roomCount)) &&
			Number(normalized.roomCount) === Number(existing.total_rooms) &&
			directHotelRunnerEmailRoomMatches(normalized, existing, hotelDetails) &&
			directHotelRunnerEmailHotelMatches(normalized, existing, hotelDetails)
		);
		if (evidenceOnlyIdentitySafe) {
			const updateResult = await Reservations.updateOne(
				{
					...directHotelRunnerCommercialSnapshotFilter(existing),
					"supplierData.otaCommercialEvidence.evidenceHash": {
						$ne: otaCommercialEvidence.evidenceHash,
					},
				},
				addReservationVersionBump({
					$set: {
						"supplierData.otaCommercialEvidence": otaCommercialEvidence,
					},
					$push: {
						reservationAuditLog: buildAuditEntry(
							normalized,
							"hotelrunner-commercial-evidence-attached-no-financial-mutation",
							warnings
						),
					},
				})
			);
			const matchedCount = Number(
				updateResult?.matchedCount ?? updateResult?.n ?? 0
			);
			if (matchedCount) {
				return {
					status: "updated",
					actionTaken: "commercial_evidence_attached",
					warnings,
					errors,
					reservationId: existing._id,
					hotelId: existing.hotelId,
					pmsConfirmationNumber: existing.confirmation_number,
					matchedReservationBy,
					updatedFields: ["supplierData.otaCommercialEvidence"],
				};
			}
			const latest = await loadReservationForCommercialEvidence(existing._id);
			const latestEvidence = validatedOtaCommercialEvidence(
				latest?.supplierData?.otaCommercialEvidence,
				{ provider: normalized.provider }
			);
			if (latestEvidence?.evidenceHash === otaCommercialEvidence.evidenceHash) {
				return {
					status: "duplicate_reservation",
					actionTaken: "skipped",
					skipReason: "ota_commercial_evidence_already_attached",
					warnings,
					errors,
					reservationId: existing._id,
					hotelId: existing.hotelId,
					pmsConfirmationNumber: existing.confirmation_number,
					matchedReservationBy,
				};
			}
			return {
				status: "needs_review",
				actionTaken: "skipped",
				skipReason: "ota_commercial_evidence_concurrent_change",
				automationComment:
					"The reservation changed while source commercial evidence was being attached; no retrying overwrite was attempted.",
				warnings,
				errors: [
					...errors,
					"Concurrent reservation change blocked commercial evidence attachment.",
				],
				reservationId: existing._id,
				hotelId: existing.hotelId,
				pmsConfirmationNumber: existing.confirmation_number,
				matchedReservationBy,
			};
		}
		const incompleteEvidence = hasDirectCommercialEvidenceAttempt(normalized);
		return {
			status: incompleteEvidence ? "needs_review" : "duplicate_reservation",
			actionTaken: "skipped",
			skipReason: incompleteEvidence
				? "hotelrunner_email_commercial_evidence_incomplete"
				: "hotelrunner_direct_reservation_already_exists",
			automationComment: incompleteEvidence
				? "The OTA email contained partial payout evidence but did not satisfy every verified-commercial gate; no reservation fields were changed."
				: "The OTA email matched a direct HotelRunner reservation and was retained for audit; no reservation fields were changed.",
			warnings,
			errors,
			reservationId: existing._id,
			hotelId: existing.hotelId,
			pmsConfirmationNumber: existing.confirmation_number,
			matchedReservationBy,
		};
	}
	const alreadyApplied = verifiedHotelRunnerEmailCommercialEvidence(existing, {
		provider: evidence.provider,
		grossTotalSar: evidence.grossTotalSar,
		currency: evidence.currency,
	});
	if (alreadyApplied?.evidenceHash === evidence.evidenceHash) {
		return {
			status: "duplicate_reservation",
			actionTaken: "skipped",
			skipReason: "hotelrunner_email_commercial_evidence_already_applied",
			warnings,
			errors,
			reservationId: existing._id,
			hotelId: existing.hotelId,
			pmsConfirmationNumber: existing.confirmation_number,
			matchedReservationBy,
		};
	}
	const guard = directHotelRunnerEmailCommercialGuard({
		normalized,
		existing,
		hotelDetails,
		matchedReservationBy,
		evidence,
	});
	if (!guard.ok) {
		return {
			status: "needs_review",
			actionTaken: "skipped",
			skipReason: "hotelrunner_email_commercial_enrichment_guard_failed",
			automationComment:
				"Verified OTA commercial evidence did not satisfy every direct-HotelRunner ownership invariant; no reservation fields were changed.",
			warnings,
			errors: [...errors, `Commercial enrichment gate failed: ${guard.reason}.`],
			reservationId: existing._id,
			hotelId: existing.hotelId,
			pmsConfirmationNumber: existing.confirmation_number,
			matchedReservationBy,
		};
	}
	const set = guard.sameEvidenceRematerialization
		? guard.sameEvidenceRematerializationSet
		: directHotelRunnerCommercialEnrichmentSet(
				normalized,
				evidence,
				{
					reportedTotalRole: guard.reportedTotalRole,
					existing,
					commercialPricing: guard.commercialPricing,
					materializeVerifiedOtaCollectPayment: true,
				}
		  );
	if (!set) {
		return {
			status: "needs_review",
			actionTaken: "skipped",
			skipReason: "hotelrunner_email_commercial_enrichment_guard_failed",
			automationComment:
				"Verified OTA commercial evidence could not be reconciled to the existing daily pricing rows; no reservation fields were changed.",
			warnings,
			errors: [...errors, "Commercial enrichment gate failed: daily_pricing."],
			reservationId: existing._id,
			hotelId: existing.hotelId,
			pmsConfirmationNumber: existing.confirmation_number,
			matchedReservationBy,
		};
	}
	const updateResult = await Reservations.updateOne(
		{
			...directHotelRunnerCommercialSnapshotFilter(existing),
			"supplierData.hotelRunnerEmailCommercialEvidence.evidenceHash":
				guard.sameEvidenceRematerialization
					? evidence.evidenceHash
					: { $ne: evidence.evidenceHash },
		},
		addReservationVersionBump({
			$set: set,
			$push: {
				reservationAuditLog: buildAuditEntry(
					normalized,
					"hotelrunner-commercial-enriched-from-verified-email",
					warnings
				),
			},
		})
	);
	const matchedCount = Number(updateResult?.matchedCount ?? updateResult?.n ?? 0);
	if (!matchedCount) {
		const latest = await loadReservationForCommercialEvidence(existing._id);
		const latestEvidence = verifiedHotelRunnerEmailCommercialEvidence(latest, {
			provider: evidence.provider,
			grossTotalSar: evidence.grossTotalSar,
			currency: evidence.currency,
		});
		if (latestEvidence?.evidenceHash === evidence.evidenceHash) {
			return {
				status: "duplicate_reservation",
				actionTaken: "skipped",
				skipReason: "hotelrunner_email_commercial_evidence_already_applied",
				warnings,
				errors,
				reservationId: existing._id,
				hotelId: existing.hotelId,
				pmsConfirmationNumber: existing.confirmation_number,
				matchedReservationBy,
			};
		}
		return {
			status: "needs_review",
			actionTaken: "skipped",
			skipReason: "hotelrunner_email_commercial_enrichment_concurrent_change",
			automationComment:
				"The reservation changed while verified OTA commercial evidence was being applied; no retrying overwrite was attempted.",
			warnings,
			errors: [...errors, "Concurrent reservation change blocked commercial enrichment."],
			reservationId: existing._id,
			hotelId: existing.hotelId,
			pmsConfirmationNumber: existing.confirmation_number,
			matchedReservationBy,
		};
	}
	return {
		status: "updated",
		actionTaken: "commercial_enrichment",
		warnings,
		errors,
		reservationId: existing._id,
		hotelId: existing.hotelId,
		pmsConfirmationNumber: existing.confirmation_number,
		matchedReservationBy,
		updatedFields: Object.keys(set),
	};
}

function hasVerifiedSourceBackedDirectHotelId(normalized = {}, hotelDetails = {}) {
	const strength = normalizeComparable(normalized.hotelIdMatchStrength || "");
	return !!(
		normalizeComparable(normalized.provider || "") === "airbnb" &&
		hasSourceField(normalized, "hotelName") &&
		normalizeId(normalized.hotelId) &&
		normalizeId(normalized.hotelId) === normalizeId(hotelDetails?._id) &&
		["exact", "exact alias"].includes(strength) &&
		normalizeWhitespace(normalized.hotelIdMatchedBy || "") &&
		normalizeWhitespace(normalized.hotelIdMatchedValue || "") &&
		(hasSourceField(normalized, "airbnbListingId") ||
			hasSourceField(normalized, "airbnbListingTitle") ||
			containsConfiguredZadAjyadAlias(normalized.hotelIdMatchedValue))
	);
}

function authoritativeExistingRefreshGuard({
	normalized = {},
	existing = {},
	hotelDetails = null,
	matchedReservationBy = [],
} = {}) {
	const reject = (reason) => ({ ok: false, reason });
	if (
		normalized.authoritativeExistingRefresh !== true ||
		normalized.sourceSenderTrusted !== true ||
		normalized.sourceSenderAuthenticated !== true ||
		otaSourceAuthority(normalized) < 3 ||
		normalized.requiresManualReview === true
	) {
		return reject("source_authority");
	}
	if (
		Number(existing?.supplierData?.otaSourceAuthority || 0) !== 1 ||
		normalizeComparable(existing?.supplierData?.otaLastEventType || "") !==
			"new" ||
		normalizeComparable(normalized.intent || "") !== "new reservation" ||
		normalizeComparable(normalized.eventType || "") !== "new" ||
		!validOtaEventDate(existing?.supplierData?.otaLastSourceReceivedAt) ||
		!otaSourceReceivedAt(normalized)
	) {
		return reject("relay_provenance");
	}
	if (!Array.isArray(matchedReservationBy) || matchedReservationBy.length < 2) {
		return reject("identity");
	}
	if (!exactSourceBackedStayMatchesExisting(normalized, existing)) {
		return reject("stay");
	}
	const review = existing.otaPlatformReview || {};
	if (
		normalizeComparable(review.status || "") !== "pending" ||
		normalizeComparable(existing.state || "") !==
			normalizeComparable(OTA_PLATFORM_REVIEW_RESERVATION_STATUS) ||
		normalizeComparable(existing.reservation_status || "") !==
			normalizeComparable(OTA_PLATFORM_REVIEW_RESERVATION_STATUS)
	) {
		return reject("operational_state");
	}
	if (!hasSourceField(normalized, "roomCount")) return reject("room_count");
	const incomingRoomCount = Number(normalized.roomCount || 0);
	if (
		!Number.isInteger(incomingRoomCount) ||
		incomingRoomCount <= 0 ||
		incomingRoomCount !== Number(existing.total_rooms || 0)
	) {
		return reject("room_count");
	}
	if (!hasCompleteDirectCommercialEvidence(normalized)) {
		return reject("commercial_evidence");
	}
	const exactHotel = findExactHotelNameMatch(
		hotelDetails ? [hotelDetails] : [],
		expandHotelNameCandidates([
			normalized.hotelName,
			...(Array.isArray(normalized.hotelNameAliases)
				? normalized.hotelNameAliases
				: []),
		])
	);
	const verifiedDirectHotelId = hasVerifiedSourceBackedDirectHotelId(
		normalized,
		hotelDetails
	);
	if (
		!hotelDetails?._id ||
		!hotelDetails?.belongsTo ||
		hotelDetails.activateHotel !== true ||
		hotelDetails.xHotelProActive === false ||
		normalizeId(existing.hotelId) !== normalizeId(hotelDetails._id) ||
		normalizeId(existing.belongsTo) !== normalizeId(hotelDetails.belongsTo) ||
		(normalizeId(exactHotel?._id) !== normalizeId(hotelDetails._id) &&
			!verifiedDirectHotelId)
	) {
		return reject("hotel");
	}
	const protectedState = authoritativeExistingRefreshProtectedStateGuard(existing);
	if (!protectedState.ok) return protectedState;
	return { ok: true, roomCount: incomingRoomCount };
}

function mappedRoomRootPricingMatches(existing = {}, document = {}) {
	const existingRooms = Array.isArray(existing.pickedRoomsType)
		? existing.pickedRoomsType
		: [];
	const rebuiltRooms = Array.isArray(document.pickedRoomsType)
		? document.pickedRoomsType
		: [];
	if (!existingRooms.length || existingRooms.length !== rebuiltRooms.length) {
		return false;
	}
	return existingRooms.every((room, roomIndex) => {
		const rebuilt = rebuiltRooms[roomIndex];
		if (
			!rebuilt ||
			Math.abs(
				Number(room?.hotelShouldGet || 0) -
					Number(rebuilt?.hotelShouldGet || 0)
			) > 0.02
		) {
			return false;
		}
		const existingDays = Array.isArray(room?.pricingByDay)
			? room.pricingByDay
			: [];
		const rebuiltDays = Array.isArray(rebuilt?.pricingByDay)
			? rebuilt.pricingByDay
			: [];
		if (!existingDays.length || existingDays.length !== rebuiltDays.length) {
			return false;
		}
		return existingDays.every((day, dayIndex) => {
			const rebuiltDay = rebuiltDays[dayIndex];
			if (!rebuiltDay || String(day?.date || "") !== String(rebuiltDay.date || "")) {
				return false;
			}
			return [
				"rootPrice",
				"totalPriceWithoutCommission",
				"commissionRate",
			].every(
				(field) =>
					Math.abs(
						Number(day?.[field] || 0) - Number(rebuiltDay?.[field] || 0)
					) <= 0.02
			);
		});
	});
}

function authoritativeMappedRefreshDocumentGuard({
	normalized = {},
	existing = {},
	document = {},
} = {}) {
	const reject = (reason) => ({ ok: false, reason });
	if (directAfterRelayInventoryConflict(existing, document)) {
		return reject("inventory_identity");
	}
	if (
		!Array.isArray(document.pickedRoomsPricing) ||
		!protectedValuesEqual(
			document.pickedRoomsType,
			document.pickedRoomsPricing
		)
	) {
		return reject("rebuilt_room_arrays");
	}
	if (!mappedRoomRootPricingMatches(existing, document)) {
		return reject("root_or_commission_pricing");
	}
	if (
		Math.abs(Number(document.sub_total || 0) - Number(existing.sub_total || 0)) >
			0.02 ||
		Math.abs(Number(document.commission || 0) - Number(existing.commission || 0)) >
			0.02 ||
		Math.abs(
			Number(document?.adminPricing?.rootTotal || 0) -
				Number(existing?.adminPricing?.rootTotal ?? existing.sub_total ?? 0)
		) > 0.02 ||
		Math.abs(
			Number(document?.adminPricing?.commissionAmount || 0) -
				Number(existing?.adminPricing?.commissionAmount ?? existing.commission ?? 0)
		) > 0.02
	) {
		return reject("root_or_commission_totals");
	}
	const commercialEvidence = buildNormalizedOtaCommercialEvidence(normalized, {
		propertyCurrency: String(document.currency || "SAR").trim().toUpperCase(),
	});
	const expectedGuestTotal =
		commercialEvidence?.roles?.guestGross?.propertyAmount;
	const expectedPayout =
		commercialEvidence?.roles?.hotelPayout?.propertyAmount;
	if (
		expectedGuestTotal === null ||
		expectedGuestTotal === undefined ||
		expectedPayout === null ||
		expectedPayout === undefined ||
		document?.adminPricing?.defaultDeductionApplied !== false ||
		normalizeWhitespace(document?.adminPricing?.payoutFallbackReason || "") ||
		normalizeWhitespace(document?.ota_financial_summary?.payoutFallbackReason || "") ||
		normalizeWhitespace(document?.supplierData?.otaPayoutFallbackReason || "") ||
		Math.abs(Number(document.total_amount || 0) - expectedGuestTotal) > 0.02 ||
		Math.abs(Number(document?.adminPricing?.clientTotal || 0) - expectedGuestTotal) >
			0.02 ||
		Math.abs(
			Number(document?.adminPricing?.netAfterExpensesTotal || 0) -
				expectedPayout
		) > 0.02 ||
		Math.abs(
			Number(document?.ota_financial_summary?.netAfterExpenses || 0) -
				expectedPayout
		) > 0.02
	) {
		return reject("commercial_rebuild");
	}
	if (
		paymentDetailsHaveProtectedActivity(document.payment_details) ||
		hasCaptureOrSettlementActivity(document)
	) {
		return reject("rebuilt_capture_or_settlement");
	}
	if (paidAmountBreakdownHasProtectedState(document)) {
		return reject("rebuilt_payment_breakdown");
	}
	if (topLevelPaymentStateHasProtectedDrift(document)) {
		return reject("rebuilt_payment_state");
	}
	if (financialCycleHasProtectedState(document)) {
		return reject("rebuilt_financial_cycle");
	}
	if (adminPricingHasProtectedState(document)) {
		return reject("rebuilt_admin_pricing");
	}
	if (adminPricingVisibilityHasProtectedState(document)) {
		return reject("rebuilt_admin_pricing_visibility");
	}
	return { ok: true };
}

function directAfterRelayUnmappedReviewGuard({
	normalized = {},
	existing = {},
	hotelDetails = null,
	matchedReservationBy = [],
	document = null,
} = {}) {
	const reject = (reason) => ({ ok: false, reason });
	if (hasAnyOtaRoomConfiguration(existing)) return reject("room_configuration");
	const commonGuard = authoritativeExistingRefreshGuard({
		existing,
		hotelDetails,
		matchedReservationBy,
		normalized,
	});
	if (!commonGuard.ok) return commonGuard;
	const review = existing.otaPlatformReview || {};
	if (
		normalizeComparable(existing.state || "") !==
			normalizeComparable(OTA_PLATFORM_REVIEW_RESERVATION_STATUS) ||
		normalizeComparable(existing.reservation_status || "") !==
			normalizeComparable(OTA_PLATFORM_REVIEW_RESERVATION_STATUS) ||
		normalizeComparable(review.status || "") !== "pending" ||
		review.releasedAt ||
		review.releasedBy ||
		review.closedAt ||
		Math.abs(Number(review.priceAtRelease || 0)) > 0.0001 ||
		review.hotelAssignmentRequired !== false ||
		normalizeComparable(review.hotelAssignmentStatus || "") !== "assigned" ||
		normalizeComparable(review.roomMappingStatus || "") !== "unreviewed" ||
		normalizeId(review.assignedHotelId) !== normalizeId(existing.hotelId) ||
		normalizeId(existing?.adminPricing?.assignedHotelId) !==
			normalizeId(existing.hotelId) ||
		normalizeId(existing?.supplierData?.otaAssignedHotelId) !==
			normalizeId(existing.hotelId) ||
		existing?.adminPricing?.pricingReviewRequired !== true ||
		existing?.adminPricing?.hotelAssignmentRequired !== false ||
		existing?.supplierData?.otaHotelMappingRequired !== false
	) {
		return reject("review_state");
	}
	if (!unmappedRootMarginCommissionFieldsAreZero(existing)) {
		return reject("root_or_margin");
	}
	const incomingRoomCount = Number(normalized.roomCount || 0);
	const existingRoomCount = Number(existing.total_rooms || 0);
	if (
		!Number.isInteger(incomingRoomCount) ||
		incomingRoomCount <= 0 ||
		incomingRoomCount !== existingRoomCount
	) {
		return reject("room_count");
	}
	if (
		Number(existing?.supplierData?.otaRoomCount || 0) !== existingRoomCount ||
		Number(existing?.supplierData?.otaTotalGuests || 0) !==
			Number(existing.total_guests || 0) ||
		existing?.supplierData?.otaHotelNameSourceBacked !== true ||
		existing?.supplierData?.otaRoomNameSourceBacked !== true ||
		existing?.supplierData?.otaRoomCountSourceBacked !== true ||
		existing?.supplierData?.otaTotalGuestsSourceBacked !== true ||
		existing?.supplierData?.otaStayDatesSourceBacked !== true ||
		normalizeWhitespace(existing?.supplierData?.otaRoomName || "") !==
			normalizeWhitespace(existing?.otaPlatformReview?.otaRoomName || "")
	) {
		return reject("room_provenance");
	}
	const incomingRoomType = mapRoomType(normalized.roomName || "");
	const incomingCapacity = exactSourceRoomCapacity(
		normalized,
		incomingRoomCount
	);
	const existingSignatures = existingUnmappedRoomSignatures(existing);
	if (
		!incomingRoomType ||
		!incomingCapacity ||
		existingSignatures.length === 0 ||
		existingSignatures.some(
			(signature) =>
				signature.roomType !== incomingRoomType ||
				signature.capacity !== incomingCapacity
		)
	) {
		return reject("room_semantic_or_capacity");
	}
	if (document) {
		const documentSignatures = existingUnmappedRoomSignatures(document);
		if (
			hasAnyOtaRoomConfiguration(document) ||
			!unmappedRootMarginCommissionFieldsAreZero(document) ||
			normalizeId(document.hotelId) !== normalizeId(existing.hotelId) ||
			normalizeId(document.belongsTo) !== normalizeId(existing.belongsTo) ||
			Number(document.total_rooms || 0) !== existingRoomCount ||
			documentSignatures.length === 0 ||
			documentSignatures.some(
				(signature) =>
					signature.roomType !== incomingRoomType ||
					signature.capacity !== incomingCapacity
			)
		) {
			return reject("rebuilt_document");
		}
	}
	return {
		capacity: incomingCapacity,
		ok: true,
		roomCount: incomingRoomCount,
		roomType: incomingRoomType,
	};
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
	const propertyCurrency = String(existing.currency || "SAR")
		.trim()
		.toUpperCase();
	const otaCommercialEvidence = buildNormalizedOtaCommercialEvidence(
		normalized,
		{ propertyCurrency }
	);
	if (otaCommercialEvidence) {
		set["supplierData.otaCommercialEvidence"] = otaCommercialEvidence;
	}
	if (
		(isOtaInboundEmail(normalized) &&
			hasActiveHotelRunnerLifecycleAuthority(existing)) ||
		lowerAuthorityOtaLifecycleMustYieldToHotelRunnerApi(normalized, existing)
	) {
		return set;
	}
	const confirmationNumber = normalizeConfirmation(
		normalized.confirmationNumber || normalized.reservationId
	);
	const incomingStatus = resolveExistingUpdateStatus(statusToApply, normalized);
	const incomingAmount = hasIncomingAmount(normalized);
	const statusOnlyUpdate =
		normalized.intent === "reservation_status" ||
		["cancelled", "no_show", "status"].includes(normalized.eventType);
	const bookingSourceProvider = knownBookingSourceProvider(
		normalized.bookingSource
	);
	const lifecycleCommercialProviderLabel =
		statusOnlyUpdate &&
		bookingSourceProvider === "hotelrunner" &&
		normalized.provider &&
		!["unknown", "hotelrunner"].includes(normalized.provider) &&
		PROVIDER_LABELS[normalized.provider]
			? PROVIDER_LABELS[normalized.provider]
			: "";
	// HotelRunner can carry a source-backed lifecycle event for another OTA.
	// It remains transport evidence and must not replace the commercial source.
	const providerLabel =
		lifecycleCommercialProviderLabel ||
		normalized.bookingSource ||
		(normalized.providerLabel && normalized.providerLabel !== "unknown"
			? normalized.providerLabel
			: "");
	const appliesAuthoritativeRefresh =
		normalized.authoritativeExistingRefresh === true && !!document;
	const preserveCanonicalTransportIdentity =
		normalized.preserveCanonicalTransportIdentity === true;
	const normalizedGuestComment = cleanOtaGuestNote(
		normalized.comment || normalized.guestNotes || ""
	);

	if (document) {
		const docSet = compactUpdate(document);
		if (appliesAuthoritativeRefresh) {
			Object.keys(docSet)
				.filter((path) => path.startsWith("customer_details."))
				.forEach((path) => delete docSet[path]);
			// A rebuilt document always carries the incoming source label. Preserve
			// an existing non-HotelRunner commercial source unless the guarded
			// source-upgrade logic below explicitly authorizes the change.
			delete docSet.booking_source;
			delete docSet["supplierData.supplierName"];
			// Employee-authored reservation notes are not authoritative OTA facts.
			// Let the source-backed guest note flow below populate only blank fields;
			// never copy either comment path wholesale from a rebuilt document.
			delete docSet.comment;
			delete docSet.booking_comment;
			// Ordering metadata is applied below with a monotonic comparison against
			// the stored OTA watermark. A rebuilt direct-confirmation document must
			// never copy its earlier source time over a later HotelRunner relay.
			delete docSet["supplierData.otaLastSourceReceivedAt"];
			if (!hasSourceField(normalized, "bookedAt")) delete docSet.booked_at;
			if (!hasSourceField(normalized, "adults")) delete docSet.adults;
			if (!hasSourceField(normalized, "children")) delete docSet.children;
			if (!hasSourceField(normalized, "totalGuests")) {
				delete docSet.total_guests;
			}
			if (preserveCanonicalTransportIdentity) {
				delete docSet["supplierData.otaProvider"];
			}
			Object.assign(set, docSet);
			// compactUpdate intentionally omits nulls for ordinary updates. A guarded
			// authoritative rebuild is different: null is the deliberate fail-closed
			// result for an unproven commercial role, and an older guessed value must
			// not survive merely because the new document cannot prove it.
			for (const [path, value] of [
				["total_amount", document.total_amount],
				["commission_ota", document.commission_ota],
				["supplierData.otaAmountSar", document.supplierData?.otaAmountSar],
				[
					"supplierData.otaTotalPayoutSar",
					document.supplierData?.otaTotalPayoutSar,
				],
				[
					"supplierData.otaExpenseTotalSar",
					document.supplierData?.otaExpenseTotalSar,
				],
				[
					"supplierData.otaPlatformMarginSar",
					document.supplierData?.otaPlatformMarginSar,
				],
				[
					"supplierData.otaCommissionSar",
					document.supplierData?.otaCommissionSar,
				],
			]) {
				set[path] = value ?? null;
			}
			set.adminPricing = preserveCanonicalTransportIdentity
				? {
						...(document.adminPricing || {}),
						provider:
							existing?.adminPricing?.provider || document.adminPricing?.provider,
				  }
				: document.adminPricing;
			set.ota_financial_summary = preserveCanonicalTransportIdentity
				? {
						...(document.ota_financial_summary || {}),
						provider:
							existing?.ota_financial_summary?.provider ||
							document.ota_financial_summary?.provider,
				  }
				: document.ota_financial_summary;
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
	let supplierNameSourceUpgrade = false;
	if (hasSourceField(normalized, "bookingSource") || hasKnownProvider(normalized)) {
		const incomingCommercialProvider = knownBookingSourceProvider(providerLabel);
		const authoritativeDirectSourceUpgrade = (existingSource) =>
			appliesAuthoritativeRefresh &&
			normalized.sourceSenderTrusted === true &&
			normalized.sourceSenderAuthenticated === true &&
			otaSourceAuthority(normalized) >= 3 &&
			incomingCommercialProvider &&
			incomingCommercialProvider !== "hotelrunner" &&
			incomingCommercialProvider ===
				String(normalized.provider || "").trim().toLowerCase() &&
			knownBookingSourceProvider(existingSource) === "hotelrunner";
		const topLevelSourceUpgrade =
			isSourceBackedHotelRunnerUpgrade(
				existing?.booking_source,
				providerLabel,
				normalized
			) || authoritativeDirectSourceUpgrade(existing?.booking_source);
		const customerSourceUpgrade =
			isSourceBackedHotelRunnerUpgrade(
				existing?.customer_details?.booking_source,
				providerLabel,
				normalized
			) ||
			authoritativeDirectSourceUpgrade(
				existing?.customer_details?.booking_source
			);
		supplierNameSourceUpgrade =
			isSourceBackedHotelRunnerUpgrade(
				existing?.supplierData?.supplierName,
				providerLabel,
				normalized
			) ||
			authoritativeDirectSourceUpgrade(
				existing?.supplierData?.supplierName
			);
		if (!String(existing?.booking_source || "").trim() || topLevelSourceUpgrade) {
			setIfOtaValue(set, "booking_source", providerLabel);
		}
		if (
			!String(existing?.customer_details?.booking_source || "").trim() ||
			customerSourceUpgrade
		) {
			setIfOtaValue(set, "customer_details.booking_source", providerLabel);
		}
		if (topLevelSourceUpgrade || customerSourceUpgrade) {
			if (set.adminPricing && typeof set.adminPricing === "object") {
				set.adminPricing.providerLabel = providerLabel;
			} else {
				setIfOtaValue(set, "adminPricing.providerLabel", providerLabel);
			}
			if (
				set.ota_financial_summary &&
				typeof set.ota_financial_summary === "object"
			) {
				set.ota_financial_summary.providerLabel = providerLabel;
			} else {
				setIfOtaValue(
					set,
					"ota_financial_summary.providerLabel",
					providerLabel
				);
			}
			setIfOtaValue(set, "otaPlatformReview.providerLabel", providerLabel);
			addExistingUpdatePreservedWarning(
				warnings,
				`HotelRunner remains the transport provider; the source-backed booking platform was upgraded to ${providerLabel}.`
			);
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
						guestTotalSar:
							otaCommercialEvidence?.roles?.guestGross?.propertyAmount ??
							null,
						sourceAmount:
							otaCommercialEvidence?.roles?.guestGross?.sourceAmount ??
							(Number(normalized.sourceAmount || normalized.amount) || null),
						sourceCurrency:
							otaCommercialEvidence?.sourceCurrency ||
							normalized.sourceCurrency ||
							normalized.currency ||
							"",
						totalPayoutSar:
							otaCommercialEvidence?.roles?.hotelPayout?.propertyAmount ??
							null,
						exchangeRateToSar:
							otaCommercialEvidence?.currencyConversion?.rate ?? null,
						exchangeRateSource: normalized.exchangeRateSource || "",
						commercialEvidenceHash:
							otaCommercialEvidence?.evidenceHash || "",
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
		const statusUpdatedAt = new Date();
		set.reservation_status = incomingStatus;
		if (statusOnlyUpdate) set.state = incomingStatus;
		if (statusOnlyUpdate) {
			const existingPending =
				existing?.pendingConfirmation &&
				typeof existing.pendingConfirmation === "object"
					? existing.pendingConfirmation
					: {};
			const providerName = normalized.providerLabel || providerLabel || "OTA";
			const pendingConfirmation = {
				...existingPending,
				status: incomingStatus,
				lastUpdatedAt: statusUpdatedAt,
				lastUpdatedBy: {
					name: "OTA inbound automation",
					role: "system",
				},
				source: "ota_email_status",
			};
			if (["cancelled", "no_show"].includes(incomingStatus)) {
				pendingConfirmation.rejectionReason = `${providerName} ${
					incomingStatus === "cancelled" ? "cancellation" : "no-show"
				} email received.`;
				pendingConfirmation.confirmationReason = "";
				pendingConfirmation.confirmedAt = null;
				pendingConfirmation.rejectedAt = null;
				pendingConfirmation.cancelledAt =
					incomingStatus === "cancelled" ? statusUpdatedAt : null;
				pendingConfirmation.noShowAt =
					incomingStatus === "no_show" ? statusUpdatedAt : null;
			} else if (incomingStatus === "confirmed") {
				pendingConfirmation.rejectionReason = "";
				pendingConfirmation.confirmationReason = `${providerName} status email`;
				pendingConfirmation.confirmedAt = statusUpdatedAt;
				pendingConfirmation.rejectedAt = null;
				pendingConfirmation.cancelledAt = null;
				pendingConfirmation.noShowAt = null;
			}
			set.pendingConfirmation = pendingConfirmation;
			set.agentDecisionSnapshot = {
				...(existing?.agentDecisionSnapshot || {}),
				status: incomingStatus,
				reason: `${providerName} status email`,
				decidedAt: statusUpdatedAt,
				decidedBy: {
					name: "OTA inbound automation",
					role: "system",
				},
				source: "ota_email_status",
			};
		}
		if (["cancelled", "no_show"].includes(incomingStatus)) {
			set.cancel_reason = `${normalized.providerLabel || "OTA"} status email`;
		}
		if (["cancelled", "no_show", "inhouse", "checked_out"].includes(incomingStatus)) {
			set["otaPlatformReview.status"] = "closed";
			set["otaPlatformReview.closedAt"] = statusUpdatedAt;
			set["otaPlatformReview.closedReason"] = `ota_status_${incomingStatus}`;
			set["otaPlatformReview.lastUpdatedAt"] = statusUpdatedAt;
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
		const incomingCrossTransportIdentityKey =
			buildOtaCrossTransportIdentityKey(normalized, confirmationNumber);
		const existingCrossTransportIdentityKey = normalizeWhitespace(
			existing?.otaCrossTransportIdentityKey || ""
		).toLowerCase();
		if (
			incomingCrossTransportIdentityKey &&
			(!existingCrossTransportIdentityKey ||
				existingCrossTransportIdentityKey ===
					incomingCrossTransportIdentityKey)
		) {
			set.otaCrossTransportIdentityKey = incomingCrossTransportIdentityKey;
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
		const existingSupplierName = normalizeWhitespace(
			existing?.supplierData?.supplierName || ""
		);
		const existingSupplierProvider = knownBookingSourceProvider(
			existingSupplierName
		);
		const incomingSupplierProvider = knownBookingSourceProvider(providerLabel);
		const sameRecognizedSupplierProvider = !!(
			existingSupplierProvider &&
			incomingSupplierProvider &&
			existingSupplierProvider === incomingSupplierProvider
		);
		if (
			!existingSupplierName ||
			sameRecognizedSupplierProvider ||
			supplierNameSourceUpgrade
		) {
			setIfOtaValue(set, "supplierData.supplierName", providerLabel);
		}
	}
	if (
		hasKnownProvider(normalized) &&
		!preserveCanonicalTransportIdentity &&
		!normalizeWhitespace(existing?.supplierData?.otaProvider || "")
	) {
		setIfOtaValue(set, "supplierData.otaProvider", normalized.provider);
	}
	if (hasKnownProvider(normalized) && preserveCanonicalTransportIdentity) {
		setIfOtaValue(
			set,
			"supplierData.otaLastObservedTransportProvider",
			normalized.provider
		);
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
			otaCommercialEvidence?.sourceCurrency ||
			normalized.sourceCurrency ||
			safePaymentSummary.sourceCurrency ||
			normalized.currency ||
			"";
		const sourceAmount = Number(
			otaCommercialEvidence?.roles?.guestGross?.sourceAmount ||
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
		setIfOtaValue(set, "supplierData.otaCurrency", sourceCurrency);
		if (sourceAmount > 0) {
			set["supplierData.otaAmount"] = round2(sourceAmount);
		}
		const propertyGross =
			otaCommercialEvidence?.roles?.guestGross?.propertyAmount;
		if (
			propertyGross !== null &&
			propertyGross !== undefined &&
			Number.isFinite(Number(propertyGross))
		) {
			set["supplierData.otaAmountSar"] = round2(propertyGross);
		}
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
		const propertyPayout =
			otaCommercialEvidence?.roles?.hotelPayout?.propertyAmount;
		const propertyDeduction =
			otaCommercialEvidence?.roles?.deductionAggregate?.propertyAmount;
		if (
			propertyPayout !== null &&
			propertyPayout !== undefined &&
			Number.isFinite(Number(propertyPayout))
		) {
			set["supplierData.otaTotalPayoutSar"] = round2(propertyPayout);
		}
		if (
			propertyDeduction !== null &&
			propertyDeduction !== undefined &&
			Number.isFinite(Number(propertyDeduction))
		) {
			set["supplierData.otaExpenseTotalSar"] = round2(propertyDeduction);
		}
		if (Number(otaCommercialEvidence?.currencyConversion?.rate || 0) > 0) {
			set["supplierData.otaExchangeRateToSar"] = Number(
				otaCommercialEvidence.currencyConversion.rate
			);
			setIfOtaValue(
				set,
				"supplierData.otaExchangeRateSource",
				otaCommercialEvidence?.provenance?.conversion?.sourceType || ""
			);
			setIfOtaValue(
				set,
				"supplierData.otaAmountConvertedAt",
				otaCommercialEvidence?.provenance?.conversion?.sourceTimestamp || ""
			);
		}
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
	const sourceReceivedAt = otaSourceReceivedAt(normalized);
	const existingSourceReceivedAt = isAuthoritativeInboundEmailCancellation(
		normalized,
		incomingStatus
	)
		? otaExistingCancellationBaselineAt(existing)
		: otaExistingLifecycleBaselineAt(existing);
	if (
		sourceReceivedAt &&
		(!existingSourceReceivedAt ||
			sourceReceivedAt.getTime() > existingSourceReceivedAt.getTime())
	) {
		set["supplierData.otaLastSourceReceivedAt"] = sourceReceivedAt;
	}
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
		if (
			!preserveCanonicalTransportIdentity &&
			!normalizeWhitespace(existing?.otaPlatformReview?.provider || "")
		) {
			setIfOtaValue(set, "otaPlatformReview.provider", normalized.provider);
		}
		setIfOtaValue(
			set,
			"otaPlatformReview.providerLabel",
			providerLabel
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
		const visibilityAppliedAt = new Date();
		if (
			set.adminPricingVisibility &&
			typeof set.adminPricingVisibility === "object"
		) {
			set.adminPricingVisibility = {
				...set.adminPricingVisibility,
				rootOnlyForHotelManagement: true,
				source: "ota_email_update",
				appliedAt: visibilityAppliedAt,
				appliedBy: null,
			};
		} else {
			set["adminPricingVisibility.rootOnlyForHotelManagement"] = true;
			set["adminPricingVisibility.source"] = "ota_email_update";
			set["adminPricingVisibility.appliedAt"] = visibilityAppliedAt;
			set["adminPricingVisibility.appliedBy"] = null;
		}
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

function hasNonemptySourceBackedHotelCandidate(normalized = {}) {
	const sourceBacked =
		hasSourceField(normalized, "hotelName") ||
		hasSourceField(normalized, "hotelId");
	return !!(
		sourceBacked &&
		normalizeWhitespace(normalized.hotelName || normalized.hotelId || "")
	);
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
	const hasSourceBackedCandidate =
		hasNonemptySourceBackedHotelCandidate(normalized);
	if (existingReservation?.hotelId && !hasSourceBackedCandidate) {
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
		if (hasSourceBackedCandidate) return null;
		const hotels = await allHotelsForExactOrKeyword();
		const exactMentioned = findHotelMentionedInSourceText(hotels, normalized);
		if (exactMentioned) return exactMentioned;
		if (normalizedReservationContainsConfiguredZadAjyadAlias(normalized)) {
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
	if (normalizedReservationContainsConfiguredZadAjyadAlias(normalized)) {
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
	if (hasSourceBackedCandidate) return null;
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

function resolvedIncomingHotelConflictsWithExisting(
	existingReservation = {},
	resolvedIncomingHotel = null
) {
	const existingHotelId = normalizeId(existingReservation?.hotelId);
	const incomingHotelId = normalizeId(resolvedIncomingHotel?._id);
	return !!(
		existingHotelId &&
		incomingHotelId &&
		existingHotelId !== incomingHotelId
	);
}

function wouldReopenTerminalOtaReservation(
	existingReservation = {},
	incomingStatus = ""
) {
	const terminalStatuses = new Set(["cancelled", "no_show", "checked_out"]);
	const storedTerminalStatuses = Array.from(new Set([
		existingReservation?.state,
		existingReservation?.reservation_status,
	]
		.map(normalizeStatusToApply)
		.filter((status) => terminalStatuses.has(status))));
	if (!storedTerminalStatuses.length) return false;
	const nextStatus = normalizeStatusToApply(incomingStatus);
	return !(
		storedTerminalStatuses.length === 1 &&
		nextStatus === storedTerminalStatuses[0]
	);
}

function hasTerminalOtaReservationStatus(existingReservation = {}) {
	return [
		existingReservation?.state,
		existingReservation?.reservation_status,
	]
		.map(normalizeStatusToApply)
		.some((status) => ["cancelled", "no_show", "checked_out"].includes(status));
}

function hasInhouseOtaReservationStatus(existingReservation = {}) {
	return [
		existingReservation?.state,
		existingReservation?.reservation_status,
	]
		.map(normalizeStatusToApply)
		.includes("inhouse");
}

function wouldRegressInhouseOtaReservation(
	existingReservation = {},
	incomingStatus = ""
) {
	if (!hasInhouseOtaReservationStatus(existingReservation)) return false;
	return !["inhouse", "checked_out"].includes(
		normalizeStatusToApply(incomingStatus)
	);
}

function normalizedStayDate(value) {
	if (value instanceof Date && !Number.isNaN(value.getTime())) {
		return value.toISOString().slice(0, 10);
	}
	return parseDate(value);
}

function terminalLifecycleStayDatesConflict(
	normalized = {},
	existingReservation = {},
	incomingStatus = ""
) {
	if (!["cancelled", "no_show"].includes(normalizeStatusToApply(incomingStatus))) {
		return false;
	}
	if (
		!hasSourceField(normalized, "checkinDate") ||
		!hasSourceField(normalized, "checkoutDate")
	) {
		return false;
	}
	const incomingCheckin = normalizedStayDate(normalized.checkinDate);
	const incomingCheckout = normalizedStayDate(normalized.checkoutDate);
	const existingCheckin = normalizedStayDate(existingReservation?.checkin_date);
	const existingCheckout = normalizedStayDate(existingReservation?.checkout_date);
	return !(
		incomingCheckin &&
		incomingCheckout &&
		existingCheckin &&
		existingCheckout &&
		incomingCheckin === existingCheckin &&
		incomingCheckout === existingCheckout
	);
}

function validOtaEventDate(value) {
	if (!value) return null;
	const parsed = value instanceof Date ? value : new Date(value);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function otaSourceReceivedAt(normalized = {}) {
	return validOtaEventDate(normalized?.source?.receivedAt);
}

function otaExistingLifecycleBaselineAt(existing = {}) {
	return (
		validOtaEventDate(existing?.supplierData?.otaLastSourceReceivedAt) ||
		validOtaEventDate(existing?.updatedAt) ||
		validOtaEventDate(existing?.createdAt)
	);
}

function otaExistingCancellationBaselineAt(existing = {}) {
	// Manual PMS writes advance updatedAt, but only an applied OTA event may advance
	// cancellation ordering. The reservation CAS still protects concurrent writes.
	return validOtaEventDate(existing?.supplierData?.otaLastSourceReceivedAt);
}

function cancellationManualReviewAllowsStatusOnly(normalized = {}) {
	if (normalized.requiresManualReview !== true) return true;
	const reasons = Array.isArray(normalized.manualReviewReasons)
		? normalized.manualReviewReasons.map((reason) => String(reason || "").trim())
		: [];
	if (!reasons.length || reasons.some((reason) => !reason)) return false;
	const nonIdentityStatusIrrelevantReasons = [
		/^Authenticated direct OTA email contains conflicting repeated explicit (?:room type\/name|guest total\/currency|room count|adult count|child count|total guest count) values; automatic commercial and stay-fact mutation is disabled\.$/i,
		/^HotelRunner email contains \d+ room blocks in one message representation; automatic partial-room creation is disabled\.$/i,
		/^Trip\.com email contains multiple distinct room blocks; automatic partial-room creation is disabled and the booking requires room review\.$/i,
		/^Agoda email contains multiple rooms; automatic partial-room creation is disabled and the booking requires room review\.$/i,
		/^Agoda email contains multiple reference sell-rate rows; automatic aggregation is disabled and the booking requires pricing review\.$/i,
		/^Trip\.com guest-total and payout currencies conflict; automatic pricing and reservation mutation are disabled\.$/i,
		/^Trip\.com email contains conflicting room counts; automatic inventory and pricing mutation are disabled\.$/i,
		/^Trip\.com declared night counts do not reconcile with the stay dates; automatic reservation mutation is disabled\.$/i,
	];
	return reasons.every((reason) =>
		nonIdentityStatusIrrelevantReasons.some((pattern) => pattern.test(reason))
	);
}

function isAuthoritativeInboundEmailCancellation(
	normalized = {},
	statusToApply = ""
) {
	return !!(
		isOtaInboundEmail(normalized) &&
		normalized.sourceSenderTrusted === true &&
		normalized.sourceSenderAuthenticated === true &&
		cancellationManualReviewAllowsStatusOnly(normalized) &&
		hasKnownProvider(normalized) &&
		normalizeComparable(normalized.intent || "") === "reservation status" &&
		normalizeComparable(normalized.eventType || "") === "cancelled" &&
		normalizeStatusToApply(
			statusToApply || normalized.statusToApply || normalized.eventType
		) === "cancelled" &&
		hasSourceField(normalized, "confirmationNumber")
	);
}

function otaCancellationOrderingConflict(normalized = {}, existing = {}) {
	if (
		normalizeComparable(normalized?.source?.timestampMethod || "") ===
		"sendgrid webhook received at"
	) {
		return "delivery_timestamp_only";
	}
	const incomingAt = otaSourceReceivedAt(normalized);
	if (!incomingAt) return "missing_incoming_timestamp";
	const lastAppliedOtaAt = otaExistingCancellationBaselineAt(existing);
	if (
		lastAppliedOtaAt &&
		incomingAt.getTime() <= lastAppliedOtaAt.getTime()
	) {
		return "stale_or_equal_timestamp";
	}
	return "";
}

function otaLifecycleOrderingConflict(normalized = {}, existing = {}) {
	if (
		normalizeComparable(normalized?.source?.timestampMethod || "") ===
		"sendgrid webhook received at"
	) {
		return "delivery_timestamp_only";
	}
	const incomingAt = otaSourceReceivedAt(normalized);
	if (!incomingAt) return "missing_incoming_timestamp";
	const lastAppliedAt = otaExistingLifecycleBaselineAt(existing);
	if (
		lastAppliedAt &&
		incomingAt.getTime() <= lastAppliedAt.getTime()
	) {
		return "stale_or_equal_timestamp";
	}
	return "";
}

function isStaleOtaLifecycleEvent(normalized = {}, existing = {}) {
	return (
		otaLifecycleOrderingConflict(normalized, existing) ===
		"stale_or_equal_timestamp"
	);
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

async function applyLiveSarConversion(normalized = {}, conversionOptions = {}) {
	const next = {
		...normalized,
		warnings: [...(normalized.warnings || [])],
		errors: [...(normalized.errors || [])],
	};
	const initialPaymentSummary = { ...(next.paymentSummary || {}) };
	const rawSourceAmount =
		next.sourceAmount ??
		initialPaymentSummary.sourceTotalGuestPaymentAmount ??
		next.amount ??
		null;
	const amount = Number(rawSourceAmount);
	const sourceCurrency = normalizeMoneyCurrency(
		next.sourceCurrency ||
			initialPaymentSummary.sourceCurrency ||
			(next.propertyConversionVerified === true ? "" : next.currency) ||
			""
	);
	const summarySourceCurrency = normalizeMoneyCurrency(
		initialPaymentSummary.sourceCurrency || sourceCurrency
	);
	const sourceCurrencyConflict = Boolean(
		sourceCurrency &&
			summarySourceCurrency &&
			sourceCurrency !== summarySourceCurrency
	);
	if (
		Number.isFinite(amount) &&
		amount > 0 &&
		sourceCurrency &&
		!sourceCurrencyConflict
	) {
		const suppliedEvidence = validatedTrustedExchangeRateEvidence(
			next.currencyConversionEvidence,
			{
				sourceCurrency,
				propertyCurrency: "SAR",
			}
		);
		const conversion = suppliedEvidence
			? {
					sourceAmount: amount,
					sourceCurrency,
					exchangeRateToSar: suppliedEvidence.rate,
					exchangeRateSource: "exchange_rate_api_stored",
					totalAmountSar: multiplyMoney2(amount, suppliedEvidence.rate),
					convertedAt: normalizedExchangeRateTimestamp(
						next.amountConvertedAt,
						suppliedEvidence.provenance.sourceTimestamp
					),
					currencyConversionEvidence: suppliedEvidence,
			  }
			: await getSarConversionMetaAsync(
					amount,
					sourceCurrency,
					conversionOptions
			  );
		const trustedEvidence = validatedTrustedExchangeRateEvidence(
			conversion.currencyConversionEvidence,
			{
				sourceCurrency,
				propertyCurrency: "SAR",
				rate: conversion.exchangeRateToSar,
			}
		);
		const propertyConversionVerified = Boolean(
			(conversion.sourceCurrency === "SAR" &&
				conversion.exchangeRateSource === "identity" &&
				Math.abs(Number(conversion.exchangeRateToSar) - 1) <= 0.000001) ||
				trustedEvidence
		);
		next.sourceAmount = amount;
		next.sourceCurrency = sourceCurrency;
		next.propertyCurrency = "SAR";
		next.propertyConversionVerified = propertyConversionVerified;
		next.totalAmountSar = propertyConversionVerified
			? conversion.totalAmountSar
			: null;
		next.amount = propertyConversionVerified ? conversion.totalAmountSar : null;
		// `currency` is the operational/property-money currency. The original
		// provider currency remains explicit in `sourceCurrency`; an unavailable
		// trusted conversion therefore means unknown SAR money, never USD money in
		// an operational field and never a synthetic numeric zero.
		next.currency = "SAR";
		next.exchangeRateToSar = conversion.exchangeRateToSar;
		next.exchangeRateSource = conversion.exchangeRateSource;
		next.sourceExchangeRateToSar = conversion.exchangeRateToSar;
		next.sourceExchangeRateSource = conversion.exchangeRateSource;
		next.amountConvertedAt = propertyConversionVerified
			? conversion.convertedAt
			: "";
		if (trustedEvidence) next.currencyConversionEvidence = trustedEvidence;
		else delete next.currencyConversionEvidence;

		if (conversion.sourceCurrency !== "SAR" && !propertyConversionVerified) {
			const warning = `Trusted live SAR exchange evidence is unavailable for ${conversion.sourceCurrency}; source-currency amounts were retained without materializing property money.`;
			if (!next.warnings.includes(warning)) next.warnings.push(warning);
		}
		if (
			conversion.sourceCurrency !== "SAR" &&
			conversion.exchangeRateSource === "missing"
		) {
			const error = `Missing SAR exchange rate for ${conversion.sourceCurrency}.`;
			if (!next.errors.includes(error)) next.errors.push(error);
		}

		const paymentSummary = { ...initialPaymentSummary };
		const rawSourcePayoutAmount = paymentSummary.sourceTotalPayoutAmount;
		const sourcePayoutAmount = Number(rawSourcePayoutAmount);
		const hasSourcePayout = Boolean(
			rawSourcePayoutAmount !== null &&
				rawSourcePayoutAmount !== undefined &&
				rawSourcePayoutAmount !== "" &&
				Number.isFinite(sourcePayoutAmount) &&
				sourcePayoutAmount >= 0
		);
		const sourcePayoutCurrency = normalizeMoneyCurrency(
			paymentSummary.sourceTotalPayoutCurrency ||
				next.sourcePayoutCurrency ||
				summarySourceCurrency ||
				sourceCurrency
		);
		const payoutCanMaterialize = Boolean(
			hasSourcePayout &&
				propertyConversionVerified &&
				sourcePayoutCurrency === sourceCurrency
		);
		const payoutAmountSar = payoutCanMaterialize
			? multiplyMoney2(
					sourcePayoutAmount,
					Number(conversion.exchangeRateToSar)
			  )
			: null;
		next.sourcePayoutAmount = hasSourcePayout ? sourcePayoutAmount : null;
		next.sourcePayoutCurrency = hasSourcePayout ? sourcePayoutCurrency : "";
		next.totalPayoutSar = payoutAmountSar;
		next.netAfterExpensesTotal = payoutAmountSar;
		next.paymentSummary = {
			...paymentSummary,
			sourceCurrency,
			sourceTotalGuestPaymentAmount:
				paymentSummary.sourceTotalGuestPaymentAmount ?? amount,
			sourceTotalPayoutAmount: hasSourcePayout ? sourcePayoutAmount : null,
			sourceTotalPayoutCurrency: hasSourcePayout ? sourcePayoutCurrency : "",
			totalGuestPaymentAmount: propertyConversionVerified
				? conversion.totalAmountSar
				: null,
			totalPayoutAmount: payoutAmountSar,
			currency: "SAR",
			propertyCurrency: "SAR",
			propertyConversionVerified,
			exchangeRateToSar: conversion.exchangeRateToSar,
			exchangeRateSource: conversion.exchangeRateSource,
			amountConvertedAt: propertyConversionVerified
				? conversion.convertedAt
				: "",
			...(trustedEvidence
				? { currencyConversionEvidence: trustedEvidence }
				: {}),
		};
		if (!trustedEvidence) {
			delete next.paymentSummary.currencyConversionEvidence;
		}
		if (
			propertyConversionVerified &&
			Array.isArray(next.nightlyPricingSource)
		) {
			const convertedNightlyPricing = convertDirectTripNightlyPricing(
				next.nightlyPricingSource,
				{
					totalGuestAmountSar: next.totalAmountSar,
					totalPayoutAmountSar: next.totalPayoutSar,
					exchangeRateToSar: conversion.exchangeRateToSar,
				}
			);
			if (convertedNightlyPricing.length) {
				next.nightlyPricingSar = convertedNightlyPricing;
			}
		}
	} else if (sourceCurrencyConflict) {
		next.propertyCurrency = "SAR";
		next.propertyConversionVerified = false;
		next.amount = null;
		next.currency = "SAR";
		next.totalAmountSar = null;
		next.totalPayoutSar = null;
		next.netAfterExpensesTotal = null;
		delete next.currencyConversionEvidence;
		const warning =
			"Source gross and payment-summary currencies conflict; SAR conversion was not materialized.";
		if (!next.warnings.includes(warning)) next.warnings.push(warning);
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
		vcc.amountToChargeUsdExchangeRateToSar = vccConversion.usdExchangeRateToSar;
		vcc.amountToChargeUsdExchangeRateSource =
			vccConversion.usdExchangeRateSource;
		vcc.amountToChargeConvertedAt = vccConversion.convertedAt;
		next.vcc = vcc;

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
	const stayDates = generateDateRange(
		document.checkin_date,
		document.checkout_date
	);
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
		document.pickedRoomsPricing =
			document.pickedRoomsPricing || document.pickedRoomsType;
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

function getManualOtaHotelAssignmentReason(normalized = {}, hotelDetails = {}) {
	if (!hotelDetails?._id) return "";
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

function isVerifiedTripCrossTransportReservation(normalized = {}) {
	const provider = normalizeOtaIdentityProvider(normalized.provider);
	if (!["trip", "hotelrunner"].includes(provider)) return false;
	if (!hasSourceField(normalized, "confirmationNumber")) return false;
	if (!hasSourceField(normalized, "bookingSource")) return false;
	if (knownBookingSourceProvider(normalized.bookingSource) !== "trip") return false;

	const from = normalizeWhitespace(normalized.source?.from || "");
	if (provider === "trip") {
		return (
			(normalized.directTripTemplateMatched === true ||
				normalized.directTripLifecycleTemplateMatched === true) &&
			/@(?:[a-z0-9-]+\.)*trip\.com(?:[>\s]|$)/i.test(from)
		);
	}
	return (
		normalized.hotelRunnerTripRelayEvidence === true &&
		normalized.hotelRunnerTripRelayIdentityValidated === true &&
		/@(?:[a-z0-9-]+\.)*hotelrunner\.com(?:[>\s]|$)/i.test(from)
	);
}

function buildOtaCrossTransportIdentityKey(
	normalized = {},
	confirmationNumber = ""
) {
	const normalizedConfirmation = normalizeConfirmation(
		confirmationNumber || normalized.confirmationNumber || normalized.reservationId
	);
	if (!normalizedConfirmation || !isVerifiedTripCrossTransportReservation(normalized)) {
		return "";
	}
	return `trip:${normalizedConfirmation}`;
}

function reservationMatchesOtaCrossTransportIdentity(
	reservation = {},
	crossTransportIdentityKey = ""
) {
	const expected = normalizeWhitespace(crossTransportIdentityKey).toLowerCase();
	return (
		!!expected &&
		normalizeWhitespace(
			reservation?.otaCrossTransportIdentityKey || ""
		).toLowerCase() === expected
	);
}

function reservationConfirmationAliases(reservation = {}) {
	return [
		reservation?.reservation_id,
		reservation?.customer_details?.confirmation_number2,
		reservation?.supplierData?.suppliedBookingNo,
		reservation?.supplierData?.otaConfirmationNumber,
		reservation?.supplierData?.platformConfirmationNumber,
		reservation?.otaPlatformReview?.confirmationNumber,
	].filter((value) => normalizeWhitespace(value));
}

function parseStoredOtaIdentityKey(value = "") {
	const raw = normalizeWhitespace(value).toLowerCase();
	if (!raw) return null;
	const separatorIndex = raw.indexOf(":");
	if (separatorIndex < 0) {
		return {
			raw,
			provider: "",
			confirmationNumber: normalizeConfirmation(raw),
			legacy: true,
			malformed: false,
		};
	}
	const providerValue = raw.slice(0, separatorIndex);
	const confirmationValue = raw.slice(separatorIndex + 1);
	const parsedProvider =
		normalizeOtaIdentityProvider(providerValue) ||
		knownBookingSourceProvider(providerValue);
	const parsedConfirmation = normalizeConfirmation(confirmationValue);
	return {
		raw,
		provider: parsedProvider,
		confirmationNumber: parsedConfirmation,
		legacy: false,
		malformed: !parsedProvider || !parsedConfirmation,
	};
}

function normalizeStoredCanonicalProvider(value = "") {
	return (
		normalizeOtaIdentityProvider(value) || knownBookingSourceProvider(value) || ""
	);
}

function invalidOtaIdentityConsistency(reason) {
	return { valid: false, reason };
}

function validateReservationOtaIdentityConsistency(
	reservation = {},
	confirmationNumber = "",
	provider = "",
	crossTransportIdentityKey = "",
	{ matchedByCrossTransport = false } = {}
) {
	const expectedConfirmation = normalizeConfirmation(confirmationNumber);
	const expectedProvider = normalizeOtaIdentityProvider(provider);
	const expectedCrossTransportKey = normalizeWhitespace(
		crossTransportIdentityKey
	).toLowerCase();
	if (!reservation || !expectedConfirmation || !expectedProvider) {
		return invalidOtaIdentityConsistency("missing_expected_ota_identity");
	}

	const identityKey = parseStoredOtaIdentityKey(reservation.otaIdentityKey);
	if (identityKey?.malformed) {
		return invalidOtaIdentityConsistency("malformed_canonical_ota_identity_key");
	}
	if (
		identityKey?.confirmationNumber &&
		!valuesMatchConfirmation(
			identityKey.confirmationNumber,
			expectedConfirmation
		)
	) {
		return invalidOtaIdentityConsistency(
			"canonical_ota_identity_confirmation_conflict"
		);
	}

	const storedCrossTransportKey = normalizeWhitespace(
		reservation.otaCrossTransportIdentityKey || ""
	).toLowerCase();
	const parsedStoredCrossTransportKey = parseStoredOtaIdentityKey(
		storedCrossTransportKey
	);
	if (
		parsedStoredCrossTransportKey &&
		(parsedStoredCrossTransportKey.malformed ||
			parsedStoredCrossTransportKey.provider !== "trip")
	) {
		return invalidOtaIdentityConsistency(
			"malformed_cross_transport_identity_key"
		);
	}
	if (
		parsedStoredCrossTransportKey?.confirmationNumber &&
		!valuesMatchConfirmation(
			parsedStoredCrossTransportKey.confirmationNumber,
			expectedConfirmation
		)
	) {
		return invalidOtaIdentityConsistency(
			"cross_transport_confirmation_conflict"
		);
	}
	if (
		expectedCrossTransportKey &&
		storedCrossTransportKey &&
		storedCrossTransportKey !== expectedCrossTransportKey
	) {
		return invalidOtaIdentityConsistency("cross_transport_identity_conflict");
	}
	if (
		matchedByCrossTransport &&
		(!expectedCrossTransportKey ||
			storedCrossTransportKey !== expectedCrossTransportKey)
	) {
		return invalidOtaIdentityConsistency("cross_transport_match_not_verified");
	}
	if (
		storedCrossTransportKey &&
		!expectedCrossTransportKey &&
		!["trip", "hotelrunner"].includes(expectedProvider)
	) {
		return invalidOtaIdentityConsistency(
			"unexpected_cross_transport_identity_namespace"
		);
	}

	const rawCanonicalProviderValues = [
		reservation?.supplierData?.otaProvider,
		reservation?.otaPlatformReview?.provider,
	].filter((value) => normalizeWhitespace(value));
	const canonicalProviderValues = rawCanonicalProviderValues.map(
		normalizeStoredCanonicalProvider
	);
	if (
		canonicalProviderValues.some((value) => !value) ||
		new Set(canonicalProviderValues).size > 1
	) {
		return invalidOtaIdentityConsistency("canonical_ota_provider_conflict");
	}

	if (matchedByCrossTransport) {
		const transportProvider =
			identityKey?.provider || canonicalProviderValues[0] || "";
		if (
			transportProvider &&
			!["trip", "hotelrunner"].includes(transportProvider)
		) {
			return invalidOtaIdentityConsistency(
				"cross_transport_provider_namespace_conflict"
			);
		}
		if (
			identityKey?.provider &&
			canonicalProviderValues.some((value) => value !== identityKey.provider)
		) {
			return invalidOtaIdentityConsistency(
				"canonical_ota_provider_identity_key_conflict"
			);
		}
	} else {
		if (identityKey?.provider && identityKey.provider !== expectedProvider) {
			return invalidOtaIdentityConsistency(
				"canonical_ota_identity_provider_conflict"
			);
		}
		if (
			canonicalProviderValues.some((value) => value !== expectedProvider)
		) {
			return invalidOtaIdentityConsistency("canonical_ota_provider_conflict");
		}
		if (!identityKey?.provider && !canonicalProviderValues.length) {
			const legacyProviderValues = [
				reservation?.supplierData?.supplierName,
				reservation?.booking_source,
				reservation?.customer_details?.booking_source,
			]
				.map(normalizeStoredCanonicalProvider)
				.filter(Boolean);
			const distinctLegacyProviders = new Set(legacyProviderValues);
			if (distinctLegacyProviders.size > 1) {
				return invalidOtaIdentityConsistency(
					"contradictory_legacy_ota_provider_evidence"
				);
			}
			if (
				distinctLegacyProviders.size !== 1 ||
				!distinctLegacyProviders.has(expectedProvider)
			) {
				return invalidOtaIdentityConsistency(
					"legacy_ota_provider_not_verified"
				);
			}
		}
	}

	const confirmationAliases = reservationConfirmationAliases(reservation);
	if (
		confirmationAliases.some(
			(value) => !valuesMatchConfirmation(value, expectedConfirmation)
		)
	) {
		return invalidOtaIdentityConsistency("ota_confirmation_alias_conflict");
	}
	if (matchedByCrossTransport && confirmationAliases.length === 0) {
		return invalidOtaIdentityConsistency(
			"cross_transport_confirmation_alias_missing"
		);
	}
	if (
		!matchedByCrossTransport &&
		!identityKey?.confirmationNumber &&
		confirmationAliases.length === 0
	) {
		return invalidOtaIdentityConsistency("ota_confirmation_evidence_missing");
	}

	return { valid: true, reason: "" };
}

function isSafeOtaCrossTransportMatch(
	reservation = {},
	confirmationNumber = "",
	crossTransportIdentityKey = "",
	provider = "trip"
) {
	if (
		!reservationMatchesOtaCrossTransportIdentity(
			reservation,
			crossTransportIdentityKey
		)
	) {
		return false;
	}
	return validateReservationOtaIdentityConsistency(
		reservation,
		confirmationNumber,
		provider,
		crossTransportIdentityKey,
		{ matchedByCrossTransport: true }
	).valid;
}

function buildLegacyRedactedTripConflictLookup(
	normalized = {},
	hotelId = null
) {
	const confirmationNumber = normalizeConfirmation(
		normalized.confirmationNumber || normalized.reservationId
	);
	if (
		!hotelId ||
		!buildOtaCrossTransportIdentityKey(normalized, confirmationNumber) ||
		!/^\d{12,18}$/.test(confirmationNumber) ||
		!parseDate(normalized.checkinDate) ||
		!parseDate(normalized.checkoutDate)
	) {
		return null;
	}
	return {
		otaIdentityKey: `hotelrunner:card-${confirmationNumber.slice(-4)}`,
		hotelId,
		checkin_date: parseDate(normalized.checkinDate),
		checkout_date: parseDate(normalized.checkoutDate),
	};
}

async function findLegacyRedactedTripIdentityConflict(
	normalized = {},
	hotelId = null
) {
	const query = buildLegacyRedactedTripConflictLookup(normalized, hotelId);
	if (!query) return null;
	return Reservations.findOne(query)
		.select(
			"_id hotelId confirmation_number otaIdentityKey reservation_id checkin_date checkout_date"
		)
		.exec();
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
	const normalizedProvider = normalizeOtaIdentityProvider(provider);
	const expected = new Set(
		otaProviderLookupValues(provider).map((value) => normalizeComparable(value))
	);
	if (!expected.size) return false;
	const canonicalProviderValues = [
		reservation?.supplierData?.otaProvider,
		reservation?.otaPlatformReview?.provider,
	].filter(Boolean);
	const candidateValues = canonicalProviderValues.length
		? canonicalProviderValues
		: [
		reservation?.supplierData?.supplierName,
		reservation?.booking_source,
		reservation?.customer_details?.booking_source,
		  ];
	const normalizedCandidates = candidateValues
		.filter(Boolean)
		.map((value) => normalizeComparable(value));
	if (canonicalProviderValues.length) {
		return (
			normalizedCandidates.length > 0 &&
			normalizedCandidates.every((value) => expected.has(value))
		);
	}
	const recognizedLegacyProviders = new Set(
		candidateValues.map(normalizeStoredCanonicalProvider).filter(Boolean)
	);
	if (recognizedLegacyProviders.size > 0) {
		return (
			recognizedLegacyProviders.size === 1 &&
			recognizedLegacyProviders.has(normalizedProvider)
		);
	}
	return normalizedCandidates.some((value) => expected.has(value));
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
							{
								$and: [
									{
										$or: [
											{
												"supplierData.otaProvider": {
													$exists: false,
												},
											},
											{ "supplierData.otaProvider": null },
											{ "supplierData.otaProvider": "" },
										],
									},
									{
										$or: [
											{
												"otaPlatformReview.provider": {
													$exists: false,
												},
											},
											{ "otaPlatformReview.provider": null },
											{ "otaPlatformReview.provider": "" },
										],
									},
									{
										$or: [
											{
												"supplierData.supplierName": {
													$in: providerValues,
												},
											},
											{ booking_source: { $in: providerValues } },
											{
												"customer_details.booking_source": {
													$in: providerValues,
												},
											},
										],
									},
								],
							},
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
							{
								"otaPlatformReview.confirmationNumber": {
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

const OTA_IDENTITY_CONSISTENCY_PROJECTION = [
	"_id",
	"hotelId",
	"confirmation_number",
	"otaIdentityKey",
	"otaCrossTransportIdentityKey",
	"reservation_id",
	"booking_source",
	"customer_details.confirmation_number2",
	"customer_details.booking_source",
	"supplierData.otaProvider",
	"supplierData.supplierName",
	"supplierData.suppliedBookingNo",
	"supplierData.otaConfirmationNumber",
	"supplierData.platformConfirmationNumber",
	"otaPlatformReview.provider",
	"otaPlatformReview.confirmationNumber",
].join(" ");

function withOtaIdentityConsistencyProjection(projection = "") {
	const requestedPaths = String(projection || "")
		.trim()
		.split(/\s+/)
		.filter(Boolean);
	const consistencyPaths = OTA_IDENTITY_CONSISTENCY_PROJECTION.split(/\s+/).filter(
		Boolean
	);
	const uniquePaths = Array.from(new Set([...requestedPaths, ...consistencyPaths]));

	// MongoDB rejects an inclusive projection containing both an object and one
	// of its children (for example, `supplierData` together with
	// `supplierData.otaProvider`). A selected parent already contains every
	// consistency field below it, so omit only those redundant child paths.
	return uniquePaths
		.filter(
			(path) =>
				!uniquePaths.some(
					(parentPath) =>
						parentPath !== path && path.startsWith(`${parentPath}.`)
				)
		)
		.join(" ");
}

function otaIdentityConflictError(reason, reservations = []) {
	const error = new Error(
		`Conflicting OTA reservation identity detected (${reason}); no reservation may be selected or mutated.`
	);
	error.code = "OTA_RESERVATION_IDENTITY_CONFLICT";
	error.reason = reason;
	error.reservationIds = reservations
		.map((reservation) => normalizeId(reservation?._id))
		.filter(Boolean);
	return error;
}

function selectConsistentOtaIdentityCandidate(
	reservations = [],
	confirmationNumber = "",
	provider = "",
	crossTransportIdentityKey = ""
) {
	const candidates = Array.isArray(reservations) ? reservations.filter(Boolean) : [];
	if (candidates.length === 0) return null;
	if (candidates.length > 1) {
		throw otaIdentityConflictError("multiple_ota_identity_candidates", candidates);
	}
	const candidate = candidates[0];
	const matchedByCrossTransport = !!(
		normalizeWhitespace(crossTransportIdentityKey) &&
		reservationMatchesOtaCrossTransportIdentity(
			candidate,
			crossTransportIdentityKey
		)
	);
	const consistency = validateReservationOtaIdentityConsistency(
		candidate,
		confirmationNumber,
		provider,
		crossTransportIdentityKey,
		{ matchedByCrossTransport }
	);
	if (!consistency.valid) {
		throw otaIdentityConflictError(consistency.reason, candidates);
	}
	return candidate;
}

async function findReservationByOtaConfirmation(
	confirmationNumber,
	provider,
	projection = "",
	crossTransportIdentityKey = ""
) {
	const query = buildOtaConfirmationLookup(confirmationNumber, provider);
	if (!query) return null;
	const normalizedCrossTransportIdentityKey = normalizeWhitespace(
		crossTransportIdentityKey
	).toLowerCase();
	const normalizedProvider = normalizeOtaIdentityProvider(provider);
	const normalizedConfirmationNumber = normalizeConfirmation(confirmationNumber);
	const oppositeTransportIdentityKey =
		normalizedCrossTransportIdentityKey && normalizedProvider === "trip"
			? `hotelrunner:${normalizedConfirmationNumber}`
			: normalizedCrossTransportIdentityKey && normalizedProvider === "hotelrunner"
			? `trip:${normalizedConfirmationNumber}`
			: "";
	const combinedQuery = normalizedCrossTransportIdentityKey
		? {
				$or: [
					query,
					{
						otaCrossTransportIdentityKey:
							normalizedCrossTransportIdentityKey,
					},
					...(oppositeTransportIdentityKey
						? [{ otaIdentityKey: oppositeTransportIdentityKey }]
						: []),
				],
		  }
		: query;
	let finder = Reservations.find(combinedQuery).limit(3);
	if (projection) {
		finder = finder.select(withOtaIdentityConsistencyProjection(projection));
	}
	const candidates = await finder.exec();
	return selectConsistentOtaIdentityCandidate(
		candidates,
		confirmationNumber,
		provider,
		normalizedCrossTransportIdentityKey
	);
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

function detectConfirmationMatchFields(
	reservation,
	confirmationNumber,
	provider,
	crossTransportIdentityKey = ""
) {
	const crossTransportMatch = isSafeOtaCrossTransportMatch(
		reservation,
		confirmationNumber,
		crossTransportIdentityKey,
		provider
	);
	if (
		!reservation ||
		!confirmationNumber ||
		!normalizeOtaIdentityProvider(provider) ||
		(!reservationMatchesOtaProvider(reservation, provider) &&
			!crossTransportMatch)
	) {
		return [];
	}
	const otaIdentityKey = buildOtaIdentityKey(provider, confirmationNumber);
	const fields = [
		[
			"otaCrossTransportIdentityKey",
			crossTransportMatch ? confirmationNumber : "",
		],
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

function hasAmbiguousMultiRoomEvidence(normalized = {}) {
	if (
		normalized.ambiguousMultiRoomEvidence === true ||
		normalized.multipleRoomBlocks === true ||
		normalized.multiRoomEvidence === true
	) {
		return true;
	}
	return (Array.isArray(normalized.manualReviewReasons)
		? normalized.manualReviewReasons
		: []
	).some((reason) =>
		/(?:multiple\s+(?:distinct\s+)?rooms?|\b\d+\s+room\s+blocks?\b|partial-room)/i.test(
			String(reason || "")
		)
	);
}

function canCreateUnmappedOtaReviewReservation(
	normalized = {},
	allowCreate = false
) {
	if (!allowCreate) return false;
	if (normalized.blocksUnmappedReservationCreation === true) return false;
	if (hasAmbiguousMultiRoomEvidence(normalized)) return false;
	if (!otaInboundAllocationSafety(normalized).ok) return false;
	return requiredNewReservationMissing(normalized).every(
		(item) =>
			item === "source-backed hotel/property" ||
			item === "single unambiguous room block"
	);
}

function applyExactResolvedHotelToUnmappedReview(
	document = {},
	hotelDetails = null,
	normalized = {},
	{ at = new Date() } = {}
) {
	const exactSourceHotel = findExactHotelNameMatch(
		hotelDetails ? [hotelDetails] : [],
		expandHotelNameCandidates([
			normalized.hotelName,
			...(Array.isArray(normalized.hotelNameAliases)
				? normalized.hotelNameAliases
				: []),
		])
	);
	if (
		!hotelDetails?._id ||
		!hotelDetails?.belongsTo ||
		!hasSourceField(normalized, "hotelName") ||
		normalizeId(exactSourceHotel?._id) !== normalizeId(hotelDetails._id) ||
		hotelDetails.activateHotel !== true ||
		hotelDetails.xHotelProActive === false
	) {
		return false;
	}
	const hotelId = normalizeId(hotelDetails._id);
	const hotelName = normalizeWhitespace(
		hotelDetails.hotelName || hotelDetails.hotelName_OtherLanguage || ""
	);
	const clientTotal = round2(
		document?.adminPricing?.clientTotal || document.total_amount || 0
	);
	document.hotelId = hotelDetails._id;
	document.belongsTo = hotelDetails.belongsTo;
	document.roomId = [];
	document.sub_total = 0;
	document.commission = 0;
	document.otaPlatformReview = {
		...(document.otaPlatformReview || {}),
		hotelAssignmentRequired: false,
		hotelAssignmentStatus: "assigned",
		assignedHotelId: hotelId,
		assignedHotelName: hotelName,
		assignedAt: at,
		assignedBy: {
			name: "OTA inbound exact hotel resolver",
			role: "system",
		},
		roomMappingStatus: "unreviewed",
		roomMappingHotelId: "",
		lastUpdatedAt: at,
	};
	document.adminPricing = {
		...(document.adminPricing || {}),
		mode: "ota_assignment_pending_pricing",
		clientTotal,
		rootTotal: 0,
		platformMarginTotal: 0,
		commissionAmount: 0,
		sourceClientTotalSar: clientTotal,
		sourceClientTotalSource: "ota_source_guest_total",
		pricingReviewRequired: true,
		hotelAssignmentRequired: false,
		assignedHotelId: hotelId,
		assignedHotelName: hotelName,
	};
	document.ota_financial_summary = {
		...(document.ota_financial_summary || {}),
		hotelVisibleAmount: 0,
		platformProfit: 0,
		commissionAmount: 0,
	};
	document.supplierData = {
		...(document.supplierData || {}),
		otaHotelMappingRequired: false,
		otaAssignedHotelId: hotelId,
		otaAssignedHotelName: hotelName,
		otaAssignedHotelAt: at,
		otaAssignedHotelBy: {
			name: "OTA inbound exact hotel resolver",
			role: "system",
		},
		otaMatchedRoomName: "",
		otaHotelRoomConfigId: null,
		otaRoomMatchScore: 0,
		otaRoomMatchType: "",
	};
	return true;
}

function validatedHotelRunnerFirstFallbackBoundary(
	normalized = {},
	boundary = null,
	now = new Date()
) {
	if (
		!boundary ||
		boundary.mode !== "confirmed_empty_email_fallback" ||
		!boundary.identity ||
		!boundary.job ||
		!boundary.confirmedEmptyProof ||
		typeof boundary.confirmedEmptyProof !== "object" ||
		Array.isArray(boundary.confirmedEmptyProof) ||
		!boundary.job.negativeLookupProof ||
		typeof boundary.job.negativeLookupProof !== "object" ||
		Array.isArray(boundary.job.negativeLookupProof)
	) {
		return null;
	}
	const identity = boundary.identity;
	const job = boundary.job;
	const proof = boundary.confirmedEmptyProof;
	const hotelId = normalizeId(identity.hotelId);
	const provider = normalizeOtaIdentityProvider(identity.provider);
	const confirmationNumber = normalizeConfirmation(identity.confirmationNumber);
	const archiveFingerprint = normalizeWhitespace(
		boundary.archiveFingerprint || job.archiveFingerprint
	).toLowerCase();
	const resolvedHotelProofHash = normalizeWhitespace(
		job.resolvedHotelProofHash
	).toLowerCase();
	const hrIdFingerprint = normalizeWhitespace(job.hrIdFingerprint).toLowerCase();
	const fallbackJobId = normalizeId(job._id);
	const jobLeaseOwner = normalizeWhitespace(job.leaseOwner);
	const jobLeaseToken = normalizeWhitespace(job.leaseToken).toLowerCase();
	const jobLeaseUntil = new Date(job.leaseUntil || "");
	const inboundEmailId = normalizeId(job.inboundEmailId);
	const inboundEmailHash = normalizeWhitespace(job.inboundEmailHash).toLowerCase();
	const normalizedReservationHash = normalizeWhitespace(
		job.normalizedReservationHash
	).toLowerCase();
	const lookupConfirmationNumber = normalizeWhitespace(
		job.lookupConfirmationNumber
	);
	const lookupConfirmationHash = normalizeWhitespace(
		job.lookupConfirmationHash
	).toLowerCase();
	const checkedAt = new Date(proof.checkedAt || "");
	const expiresAt = new Date(proof.expiresAt || "");
	const referenceTime = now instanceof Date ? now : new Date(now || "");
	const validHash = (value) => /^[a-f0-9]{64}$/.test(String(value || ""));
	if (
		!hotelId ||
		!provider ||
		!confirmationNumber ||
		!fallbackJobId ||
		!jobLeaseOwner ||
		!jobLeaseToken ||
		!Number.isFinite(jobLeaseUntil.getTime()) ||
		jobLeaseUntil.getTime() <= referenceTime.getTime() ||
		!inboundEmailId ||
		!validHash(archiveFingerprint) ||
		!validHash(inboundEmailHash) ||
		!validHash(normalizedReservationHash) ||
		!validHash(resolvedHotelProofHash) ||
		!validHash(hrIdFingerprint) ||
		!lookupConfirmationNumber ||
		!validHash(lookupConfirmationHash) ||
		hashText(lookupConfirmationNumber) !== lookupConfirmationHash ||
		!Number.isFinite(referenceTime.getTime()) ||
		!Number.isFinite(checkedAt.getTime()) ||
		!Number.isFinite(expiresAt.getTime()) ||
		checkedAt.getTime() > referenceTime.getTime() ||
		checkedAt.getTime() >= expiresAt.getTime()
	) {
		return null;
	}
	const identityKey = `${provider}:${confirmationNumber}`;
	const expectedArchiveFingerprint = hashHotelRunnerFallbackValue({
		hotelId,
		provider,
		confirmationNumber,
		lookupConfirmationNumber,
		lookupConfirmationHash,
		inboundEmailId,
		inboundEmailHash,
		normalizedReservationHash,
		resolvedHotelProofHash,
	});
	if (
		normalizeId(job.hotelId) !== hotelId ||
		normalizeOtaIdentityProvider(job.provider) !== provider ||
		normalizeConfirmation(job.confirmationNumber) !== confirmationNumber ||
		normalizeConfirmation(lookupConfirmationNumber) !== confirmationNumber ||
		normalizeWhitespace(identity.identityKey).toLowerCase() !== identityKey ||
		normalizeWhitespace(job.identityKey).toLowerCase() !== identityKey ||
		normalizeWhitespace(job.archiveFingerprint).toLowerCase() !==
			archiveFingerprint ||
		expectedArchiveFingerprint !== archiveFingerprint ||
		hashHotelRunnerFallbackValue(normalized) !== normalizedReservationHash ||
		hashHotelRunnerFallbackValue(job.negativeLookupProof) !==
			hashHotelRunnerFallbackValue(proof) ||
		normalizeId(proof.hotelId) !== hotelId ||
		normalizeOtaIdentityProvider(proof.provider) !== provider ||
		normalizeConfirmation(proof.confirmationNumber) !== confirmationNumber ||
		normalizeWhitespace(proof.status).toLowerCase() !== "confirmed_empty" ||
		!normalizeWhitespace(proof.proofId) ||
		Number(proof.resultCount) !== 0 ||
		normalizeWhitespace(proof.hrIdFingerprint).toLowerCase() !==
			hrIdFingerprint ||
		normalizeWhitespace(proof.archiveFingerprint).toLowerCase() !==
			archiveFingerprint ||
		normalizeWhitespace(proof.resolvedHotelProofHash).toLowerCase() !==
			resolvedHotelProofHash ||
		normalizeWhitespace(proof.lookupConfirmationHash).toLowerCase() !==
			lookupConfirmationHash ||
		!validHash(normalizeWhitespace(proof.responseHash).toLowerCase()) ||
		normalizeOtaIdentityProvider(normalized.provider) !== provider ||
		normalizeConfirmation(
			normalized.confirmationNumber || normalized.reservationId
		) !== confirmationNumber ||
		normalizeId(normalized.inboundEmailId) !== inboundEmailId ||
		normalizeComparable(normalized.intent || "") !== "new reservation" ||
		normalizeComparable(normalized.eventType || "") !== "new" ||
		normalized.sourceSenderTrusted !== true ||
		normalized.sourceSenderAuthenticated !== true
	) {
		return null;
	}
	const validated = {
		mode: boundary.mode,
		hotelId,
		provider,
		confirmationNumber,
		identityKey,
		fallbackJobId,
		jobLeaseOwner,
		jobLeaseToken,
		jobLeaseUntil,
		archiveFingerprint,
		inboundEmailHash,
		normalizedReservationHash,
		resolvedHotelProofHash,
		hrIdFingerprint,
		lookupConfirmationNumber,
		lookupConfirmationHash,
		inboundEmailId,
		confirmedEmptyProof: proof,
		proofExpired: expiresAt.getTime() <= referenceTime.getTime(),
	};
	const ingressStatus =
		normalizeWhitespace(job?.ingressDecision?.status).toLowerCase() || "open";
	const durableCreationAuthorization =
		job?.ingressDecision?.emailAuthorization || null;
	const durableAuthorizationValid = Boolean(
		durableCreationAuthorization &&
		validateHotelRunnerFallbackCreationAuthorization(
			durableCreationAuthorization,
			validated
		)
	);
	const committedReservationId = normalizeId(
		job?.ingressDecision?.emailReservationId
	);
	if (
		!["open", "email_authorized", "email_committed"].includes(
			ingressStatus
		) ||
		(ingressStatus === "open" && durableCreationAuthorization) ||
		(["email_authorized", "email_committed"].includes(ingressStatus) &&
			!durableAuthorizationValid) ||
		(ingressStatus === "email_committed" && !committedReservationId)
	) {
		return null;
	}
	validated.ingressStatus = ingressStatus;
	if (durableAuthorizationValid) {
		validated.creationAuthorization = durableCreationAuthorization;
	}
	if (ingressStatus === "email_committed") {
		validated.committedReservationId = committedReservationId;
	}
	return validated;
}

function currentResolvedHotelProofHash(hotel = {}) {
	const hotelId = normalizeId(hotel._id);
	const belongsTo = normalizeId(hotel.belongsTo);
	const currency = normalizeWhitespace(hotel.currency || "SAR").toUpperCase();
	if (
		!hotelId ||
		!belongsTo ||
		!/^[A-Z]{3}$/.test(currency) ||
		hotel.activateHotel !== true ||
		hotel.xHotelProActive !== true
	) {
		return "";
	}
	return hashHotelRunnerFallbackValue({
		activateHotel: true,
		belongsTo,
		currency,
		hotelId,
		version: 1,
		xHotelProActive: true,
	});
}

function hotelRunnerFirstFallbackCreationGate(options = {}) {
	const injected = options.hotelRunnerFirstFallbackIngressGate || {};
	const authorize =
		injected.authorizeHotelRunnerFirstFallbackEmailCreation ||
		injected.authorizeEmailCreation ||
		authorizeHotelRunnerFirstFallbackEmailCreation;
	const commit =
		injected.commitHotelRunnerFirstFallbackEmailCreation ||
		injected.commitEmailCreation ||
		commitHotelRunnerFirstFallbackEmailCreation;
	const release =
		injected.releaseHotelRunnerFirstFallbackEmailCreation ||
		injected.releaseEmailCreation ||
		releaseHotelRunnerFirstFallbackEmailCreation;
	return { authorize, commit, release };
}

async function authorizeAndStampHotelRunnerFirstFallbackCreation(
	document,
	boundary
) {
	const authorization = await boundary.creationGate.authorize({ boundary });
	boundary.creationAuthorization = authorization;
	if (
		!validateHotelRunnerFallbackCreationAuthorization(
			authorization,
			boundary
		) ||
		!applyHotelRunnerFirstFallbackCreationMarker(document, boundary)
	) {
		const error = new Error(
			"HotelRunner-first fallback creation authorization could not be stamped exactly."
		);
		error.code = "HOTELRUNNER_FALLBACK_CREATION_AUTHORIZATION_INVALID";
		throw error;
	}
	return authorization;
}

async function commitHotelRunnerFirstFallbackCreation(
	created,
	boundary,
	authorization
) {
	if (!created?._id || !authorization) {
		const error = new Error(
			"HotelRunner-first fallback create returned no committable reservation."
		);
		error.code = "HOTELRUNNER_FALLBACK_CREATION_RESULT_INVALID";
		throw error;
	}
	return boundary.creationGate.commit({
		boundary,
		authorization,
		reservationId: created._id,
	});
}

async function releaseHotelRunnerFirstFallbackCreation(
	boundary,
	authorization
) {
	if (!authorization) return null;
	return boundary.creationGate.release({ boundary, authorization });
}

async function hotelRunnerFirstFallbackExistingNoMutationResult(
	existing,
	boundary,
	warnings = [],
	errors = []
) {
	const identity = validateReservationOtaIdentityConsistency(
		existing,
		boundary.confirmationNumber,
		boundary.provider,
		boundary.provider === "trip" ? boundary.identityKey : ""
	);
	const exactIdentity = Boolean(
		existing &&
		identity.valid &&
		normalizeId(existing.hotelId) === boundary.hotelId
	);
	const exactCreatedFallbackReplay = Boolean(
		exactIdentity &&
		!hasDirectHotelRunnerProjection(existing) &&
		(!boundary.committedReservationId ||
			normalizeId(existing._id) === boundary.committedReservationId) &&
		reservationHasExactHotelRunnerFirstFallbackCreationMarker(
			existing,
			boundary
		)
	);
	if (exactCreatedFallbackReplay) {
		await commitHotelRunnerFirstFallbackCreation(
			existing,
			boundary,
			boundary.creationAuthorization
		);
		return {
			status: "duplicate_reservation",
			actionTaken: "skipped",
			skipReason: "hotelrunner_first_fallback_creation_replay_adopted",
			automationComment:
				"The exact immutable HotelRunner-first fallback creation marker was found after a retry; the previously-created reservation was adopted without mutation.",
			warnings,
			errors,
			reservationId: existing._id,
			hotelId: existing.hotelId,
			pmsConfirmationNumber: existing.confirmation_number || "",
			matchedReservationBy: detectConfirmationMatchFields(
				existing,
				boundary.confirmationNumber,
				boundary.provider,
				boundary.provider === "trip" ? boundary.identityKey : ""
			),
		};
	}
	return {
		status: "needs_review",
		actionTaken: "skipped",
		skipReason: exactIdentity && hasDirectHotelRunnerProjection(existing)
			? "hotelrunner_api_arrived_after_confirmed_empty_proof"
			: "hotelrunner_first_fallback_candidate_identity_conflict",
		automationComment:
			"A reservation candidate appeared after the confirmed-empty proof and could not be selected for email fallback without mutation risk.",
		warnings,
		errors: [
			...errors,
			"HotelRunner-first fallback candidate changed after negative proof; no reservation fields were changed.",
		],
		reservationId: null,
		hotelId: null,
		pmsConfirmationNumber: "",
		matchedReservationBy: [],
	};
}

async function createUnmappedOtaReviewReservation({
	normalized = {},
	confirmationNumber = "",
	warnings = [],
	errors = [],
	allowCreate = false,
	resolvedHotel = null,
	hotelRunnerFirstFallbackBoundary = null,
} = {}) {
	const crossTransportIdentityKey = buildOtaCrossTransportIdentityKey(
		normalized,
		confirmationNumber
	);
	const nonHotelMissing = requiredNewReservationMissing(normalized).filter(
		(item) => item !== "source-backed hotel/property"
	);
	if (!canCreateUnmappedOtaReviewReservation(normalized, allowCreate)) {
		// Weak facts stay in the inbound audit. A source-backed booking may be
		// saved as an isolated platform-review record when only hotel/room
		// assignment is uncertain; it cannot enter normal operations until release.
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
		"",
		crossTransportIdentityKey
	);
	if (existingBeforeCreate) {
		if (hotelRunnerFirstFallbackBoundary) {
			return hotelRunnerFirstFallbackExistingNoMutationResult(
				existingBeforeCreate,
				hotelRunnerFirstFallbackBoundary,
				warnings,
				errors
			);
		}
		const lateMatchedBy = detectConfirmationMatchFields(
			existingBeforeCreate,
			confirmationNumber,
			normalized.provider,
			crossTransportIdentityKey
		);
		if (
			hasDirectHotelRunnerProjection(existingBeforeCreate) &&
			isOtaInboundEmail(normalized)
		) {
			const directOwnedResult = await reconcileDirectHotelRunnerOwnedEmail({
				normalized,
				existing: existingBeforeCreate,
				hotelDetails: resolvedHotel,
				matchedReservationBy: lateMatchedBy,
				warnings,
				errors,
			});
			if (directOwnedResult) return directOwnedResult;
		}
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
			matchedReservationBy: lateMatchedBy,
		};
	}

	const document = buildUnmappedOtaReviewReservationDocument({
		...normalized,
		confirmationNumber,
	});
	const exactHotelAssigned = applyExactResolvedHotelToUnmappedReview(
		document,
		resolvedHotel,
		normalized
	);
	if (
		hotelRunnerFirstFallbackBoundary &&
		(!exactHotelAssigned ||
			normalizeId(document.hotelId) !==
				hotelRunnerFirstFallbackBoundary.hotelId)
	) {
		return {
			status: "needs_review",
			actionTaken: "skipped",
			skipReason: "hotelrunner_first_fallback_hotel_identity_conflict",
			warnings,
			errors: [
				...errors,
				"Confirmed-empty fallback could not preserve the exact queued hotel identity.",
			],
			reservationId: null,
			hotelId: null,
			pmsConfirmationNumber: "",
			matchedReservationBy: [],
		};
	}
	const pendingReviewWarning = exactHotelAssigned
		? "The source-backed OTA booking was saved in platform review with its exact hotel selected; an administrator must confirm room mapping and pricing before release."
		: "The source-backed OTA booking was saved as-is in platform review; an administrator must confirm hotel, room mapping, and pricing before release.";
	if (!warnings.includes(pendingReviewWarning)) warnings.push(pendingReviewWarning);
	if (exactHotelAssigned) {
		const hotelWarning =
			"The source-backed hotel was selected exactly; room mapping and hotel pricing remain blocked for administrator review.";
		if (!warnings.includes(hotelWarning)) warnings.push(hotelWarning);
	}
	document.otaIdentityKey = buildOtaIdentityKey(
		normalized.provider,
		confirmationNumber
	);
	if (crossTransportIdentityKey) {
		document.otaCrossTransportIdentityKey = crossTransportIdentityKey;
	}
	const commercialEvidence = buildHotelRunnerEmailCommercialEvidence(normalized);
	if (commercialEvidence) {
		applyHotelRunnerEmailCommercialEvidenceToDocument(
			document,
			normalized,
			commercialEvidence
		);
	}
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
		let creationAuthorization = null;
		try {
			logReconcile("create_unmapped.start", {
				platformConfirmationNumber: confirmationNumber,
				pmsConfirmationNumber: document.confirmation_number,
				provider: normalized.provider || "",
				hotelName: normalized.hotelName || "",
			});
			if (hotelRunnerFirstFallbackBoundary) {
				creationAuthorization =
					await authorizeAndStampHotelRunnerFirstFallbackCreation(
						document,
						hotelRunnerFirstFallbackBoundary
					);
			}
			created = await Reservations.create(document);
			if (hotelRunnerFirstFallbackBoundary) {
				await commitHotelRunnerFirstFallbackCreation(
					created,
					hotelRunnerFirstFallbackBoundary,
					creationAuthorization
				);
			}
			break;
		} catch (error) {
			let releaseResult = null;
			if (hotelRunnerFirstFallbackBoundary && creationAuthorization) {
				try {
					releaseResult = await releaseHotelRunnerFirstFallbackCreation(
						hotelRunnerFirstFallbackBoundary,
						creationAuthorization
					);
				} catch (releaseError) {
					error.releaseError = releaseError;
					throw error;
				}
			}
			if (releaseResult?.committed === true) {
				const committedDuplicate =
					await findReservationByOtaConfirmation(
						confirmationNumber,
						normalized.provider,
						"",
						crossTransportIdentityKey
					);
				if (committedDuplicate) {
					return hotelRunnerFirstFallbackExistingNoMutationResult(
						committedDuplicate,
						hotelRunnerFirstFallbackBoundary,
						warnings,
						errors
					);
				}
			}
			if (error?.code === 11000) {
				const duplicate = await findReservationByOtaConfirmation(
					confirmationNumber,
					normalized.provider,
					"",
					crossTransportIdentityKey
				);
				if (duplicate) {
					if (hotelRunnerFirstFallbackBoundary) {
						return hotelRunnerFirstFallbackExistingNoMutationResult(
							duplicate,
							hotelRunnerFirstFallbackBoundary,
							warnings,
							errors
						);
					}
					const duplicateMatchedBy = detectConfirmationMatchFields(
						duplicate,
						confirmationNumber,
						normalized.provider,
						crossTransportIdentityKey
					);
					if (
						hasDirectHotelRunnerProjection(duplicate) &&
						isOtaInboundEmail(normalized)
					) {
						const directOwnedResult =
							await reconcileDirectHotelRunnerOwnedEmail({
								normalized,
								existing: duplicate,
								hotelDetails: resolvedHotel,
								matchedReservationBy: duplicateMatchedBy,
								warnings,
								errors,
							});
						if (directOwnedResult) return directOwnedResult;
					}
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
						matchedReservationBy: duplicateMatchedBy,
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
		hotelId: created.hotelId ? String(created.hotelId) : "",
	});
	return {
		status: "created",
		actionTaken: "created_unmapped_ota_review",
		skipReason: "",
		automationComment: exactHotelAssigned
			? "The source-backed OTA reservation and exact PMS hotel were preserved in platform review; confirm its room mapping and pricing before release."
			: "The source-backed OTA reservation was preserved in platform review; confirm its hotel, room mapping, and pricing before release.",
		warnings,
		errors,
		reservationId: created._id,
		hotelId: created.hotelId || null,
		pmsConfirmationNumber: created.confirmation_number,
		otaPlatformReviewStatus: created?.otaPlatformReview?.status || "",
		matchedReservationBy: [],
	};
}

async function reconcileOtaReservationUnqueued(inputNormalized, options = {}) {
	const fallbackBoundarySupplied = Boolean(
		options?.hotelRunnerFirstFallbackBoundary
	);
	const hotelRunnerFirstFallbackBoundary = fallbackBoundarySupplied
		? validatedHotelRunnerFirstFallbackBoundary(
				inputNormalized || {},
				options.hotelRunnerFirstFallbackBoundary,
				options.hotelRunnerFirstFallbackNow || new Date()
		  )
		: null;
	if (fallbackBoundarySupplied && !hotelRunnerFirstFallbackBoundary) {
		return {
			status: "needs_review",
			actionTaken: "skipped",
			skipReason: "hotelrunner_first_fallback_boundary_invalid",
			automationComment:
				"The confirmed-empty HotelRunner authorization did not match the archived OTA identity; no reservation lookup, creation, or mutation was attempted.",
			warnings: [...(inputNormalized?.warnings || [])],
			errors: [
				...(inputNormalized?.errors || []),
				"HotelRunner-first fallback authorization failed closed.",
			],
			reservationId: null,
			hotelId: null,
			pmsConfirmationNumber: "",
			matchedReservationBy: [],
		};
	}
	if (hotelRunnerFirstFallbackBoundary) {
		hotelRunnerFirstFallbackBoundary.creationGate =
			hotelRunnerFirstFallbackCreationGate(options);
	}
	if (
		hotelRunnerFirstFallbackBoundary &&
		(hotelRunnerFirstFallbackBoundary.proofExpired === true ||
			hotelRunnerFirstFallbackBoundary.ingressStatus === "email_committed")
	) {
		let replayCandidate = null;
		try {
			replayCandidate = await findReservationByOtaConfirmation(
				hotelRunnerFirstFallbackBoundary.confirmationNumber,
				hotelRunnerFirstFallbackBoundary.provider,
				"",
				hotelRunnerFirstFallbackBoundary.provider === "trip"
					? hotelRunnerFirstFallbackBoundary.identityKey
					: ""
			);
		} catch (_error) {
			return {
				status: "needs_review",
				actionTaken: "skipped",
				skipReason:
					"hotelrunner_first_fallback_expired_replay_candidate_conflict",
				automationComment:
					"The expired HotelRunner proof may only adopt one exact prior fallback creation marker; ambiguous reservation evidence was left unchanged.",
				warnings: [...(inputNormalized?.warnings || [])],
				errors: [
					...(inputNormalized?.errors || []),
					"Expired-proof replay found conflicting reservation identity evidence; no write was attempted.",
				],
				reservationId: null,
				hotelId: null,
				pmsConfirmationNumber: "",
				matchedReservationBy: [],
			};
		}
		if (replayCandidate) {
			return hotelRunnerFirstFallbackExistingNoMutationResult(
				replayCandidate,
				hotelRunnerFirstFallbackBoundary,
				[...(inputNormalized?.warnings || [])],
				[...(inputNormalized?.errors || [])]
			);
		}
		return {
			status: "needs_review",
			actionTaken: "skipped",
			skipReason: "hotelrunner_first_fallback_expired_replay_not_found",
			automationComment:
				"The HotelRunner proof expired and no exact immutable prior fallback creation marker was found; no reservation was created or changed.",
			warnings: [...(inputNormalized?.warnings || [])],
			errors: [
				...(inputNormalized?.errors || []),
				"Expired HotelRunner proof cannot authorize a new email reservation creation.",
			],
			reservationId: null,
			hotelId: null,
			pmsConfirmationNumber: "",
			matchedReservationBy: [],
		};
	}
	const normalized = await applyLiveSarConversion(inputNormalized || {});
	const warnings = [...(normalized.warnings || [])];
	const errors = [...(normalized.errors || [])];
	const unresolvedSourceBackedHotelResult = (
		existingReservation = null,
		matchedReservationBy = []
	) => ({
		status: "needs_review",
		actionTaken: "skipped",
		skipReason: "source_backed_hotel_unresolved_no_mutation",
		automationComment:
			"The source-backed OTA hotel could not be resolved to one unique PMS hotel; no reservation creation or mutation was attempted.",
		warnings,
		errors: [
			...errors,
			"Source-backed OTA hotel identity could not be resolved safely.",
		],
		reservationId: existingReservation?._id || null,
		hotelId: existingReservation?.hotelId || null,
		pmsConfirmationNumber: existingReservation?.confirmation_number || "",
		matchedReservationBy,
	});

	const confirmationNumber = normalizeConfirmation(normalized.confirmationNumber);
	const crossTransportIdentityKey = buildOtaCrossTransportIdentityKey(
		normalized,
		confirmationNumber
	);
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
	if (
		isOtaInboundEmail(normalized) &&
		normalized.sourceSenderTrusted === false
	) {
		logReconcile("needs_review.untrusted_sender", {
			provider: normalized.provider || "unknown",
			confirmationNumber,
			sourceFrom: normalized.source?.from || "",
		});
		return {
			status: "needs_review",
			actionTaken: "skipped",
			skipReason: "untrusted_ota_sender_no_mutation",
			automationComment:
				"The apparent OTA provider was not authenticated by a trusted sender mailbox domain; no reservation lookup, creation, or mutation was attempted.",
			warnings,
			errors: [
				...errors,
				"OTA sender mailbox domain is not trusted for automatic mutation.",
			],
		};
	}
	if (
		isOtaInboundEmail(normalized) &&
		hasKnownProvider(normalized) &&
		normalized.sourceSenderAuthenticated !== true
	) {
		logReconcile("needs_review.unauthenticated_sender", {
			provider: normalized.provider || "unknown",
			confirmationNumber,
			sourceFrom: normalized.source?.from || "",
			authenticationReason:
				normalized.senderAuthentication?.reason ||
				normalized.source?.senderAuthentication?.reason ||
				"missing_sender_authentication",
		});
		return {
			status: "needs_review",
			actionTaken: "skipped",
			skipReason: "unauthenticated_ota_sender_no_mutation",
			automationComment:
				"The OTA sender domain did not have verified, aligned SPF or DKIM evidence from the inbound mail provider; no reservation lookup, creation, or mutation was attempted.",
			warnings,
			errors: [
				...errors,
				"OTA sender authentication is missing, failed, or not aligned with the From domain.",
			],
		};
	}
	const cancellationMayBypassParserReview = !!(
		normalized.requiresManualReview === true &&
		cancellationManualReviewAllowsStatusOnly(normalized) &&
		normalizeComparable(intent) === "reservation status" &&
		normalizeComparable(normalized.eventType || "") === "cancelled" &&
		statusToApply === "cancelled"
	);
	const manualReasons = Array.isArray(normalized.manualReviewReasons)
		? normalized.manualReviewReasons
		: [];
	let hotelRunnerFirstFallbackResolvedHotel = null;
	if (hotelRunnerFirstFallbackBoundary) {
		const existingAtBoundary = await findReservationByOtaConfirmation(
			hotelRunnerFirstFallbackBoundary.confirmationNumber,
			hotelRunnerFirstFallbackBoundary.provider,
			"",
			hotelRunnerFirstFallbackBoundary.provider === "trip"
				? hotelRunnerFirstFallbackBoundary.identityKey
				: ""
		);
		if (existingAtBoundary) {
			return hotelRunnerFirstFallbackExistingNoMutationResult(
				existingAtBoundary,
				hotelRunnerFirstFallbackBoundary,
				warnings,
				errors
			);
		}
		hotelRunnerFirstFallbackResolvedHotel = await resolveHotel(normalized, null);
		if (
			!hotelRunnerFirstFallbackResolvedHotel ||
			normalizeId(hotelRunnerFirstFallbackResolvedHotel._id) !==
				hotelRunnerFirstFallbackBoundary.hotelId ||
			hotelRunnerFirstFallbackResolvedHotel.activateHotel !== true ||
			hotelRunnerFirstFallbackResolvedHotel.xHotelProActive !== true ||
			!normalizeId(hotelRunnerFirstFallbackResolvedHotel.belongsTo) ||
			currentResolvedHotelProofHash(hotelRunnerFirstFallbackResolvedHotel) !==
				hotelRunnerFirstFallbackBoundary.resolvedHotelProofHash
		) {
			return {
				status: "needs_review",
				actionTaken: "skipped",
				skipReason: "hotelrunner_first_fallback_hotel_identity_conflict",
				automationComment:
					"The archived OTA hotel no longer resolves to the exact configured HotelRunner property; no reservation was created or changed.",
				warnings,
				errors: [
					...errors,
					"Confirmed-empty fallback hotel identity failed closed.",
				],
				reservationId: null,
				hotelId: null,
				pmsConfirmationNumber: "",
				matchedReservationBy: [],
			};
		}
	}
	if (
		agodaMultiRoomAllocationReviewAllowsCommercialOnly(normalized) &&
		intent === "new_reservation" &&
		confirmationNumber &&
		hasSourceField(normalized, "confirmationNumber")
	) {
		// The allocation warning still blocks all email creation and room mutation.
		// It may only enrich an already-created, direct-HotelRunner-owned winner,
		// which is then subjected to the ordinary identity, hotel, stay, mapped-room,
		// amount, root, protected-state, and CAS gates below.
		const directOwnedExisting = await findReservationByOtaConfirmation(
			confirmationNumber,
			normalized.provider,
			"",
			crossTransportIdentityKey
		);
		if (
			directOwnedExisting &&
			hasDirectHotelRunnerProjection(directOwnedExisting)
		) {
			const directOwnedMatchedBy = detectConfirmationMatchFields(
				directOwnedExisting,
				confirmationNumber,
				normalized.provider,
				crossTransportIdentityKey
			);
			const directOwnedHotel = hasNonemptySourceBackedHotelCandidate(normalized)
				? await resolveHotel(normalized, null)
				: null;
			const directOwnedResult = await reconcileDirectHotelRunnerOwnedEmail({
				normalized,
				existing: directOwnedExisting,
				hotelDetails: directOwnedHotel,
				matchedReservationBy: directOwnedMatchedBy,
				warnings: [...warnings, ...manualReasons],
				errors,
			});
			if (directOwnedResult) {
				logReconcile("hotelrunner_owned_email.allocation_review_boundary", {
					confirmationNumber,
					reservationId: String(directOwnedExisting._id || ""),
					status: directOwnedResult.status,
					skipReason: directOwnedResult.skipReason || "",
					actionTaken: directOwnedResult.actionTaken || "",
				});
				return directOwnedResult;
			}
		}
	}
	if (
		normalized.requiresManualReview === true &&
		!cancellationMayBypassParserReview
	) {
		logReconcile("needs_review.explicit_parser_guard", {
			confirmationNumber,
			reasons: manualReasons,
		});
		if (
			intent === "new_reservation" &&
			confirmationNumber &&
			hasKnownProvider(normalized) &&
			hasSourceField(normalized, "confirmationNumber") &&
			canCreateUnmappedOtaReviewReservation(normalized, true)
		) {
			const manuallyResolvedSourceHotel = hotelRunnerFirstFallbackResolvedHotel ||
				(hasNonemptySourceBackedHotelCandidate(normalized)
					? await resolveHotel(normalized, null)
					: null);
			if (
				hasNonemptySourceBackedHotelCandidate(normalized) &&
				!manuallyResolvedSourceHotel
			) {
				return unresolvedSourceBackedHotelResult();
			}
			return createUnmappedOtaReviewReservation({
				normalized,
				confirmationNumber,
				warnings: [...warnings, ...manualReasons],
				errors,
				allowCreate: true,
				resolvedHotel: manuallyResolvedSourceHotel,
				hotelRunnerFirstFallbackBoundary,
			});
		}
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

	if (intent === "new_reservation") {
		const allocationSafety = otaInboundAllocationSafety(normalized);
		if (!allocationSafety.ok) {
			logReconcile("needs_review.allocation_resource_limit", {
				confirmationNumber,
				reason: allocationSafety.reason,
				roomCount: allocationSafety.roomCount,
				stayNights: allocationSafety.stayNights,
				roomNightSlots: allocationSafety.roomNightSlots,
			});
			return otaInboundAllocationLimitReview(normalized, allocationSafety);
		}
	}
	const existing = await findReservationByOtaConfirmation(
		confirmationNumber,
		normalized.provider,
		"",
		crossTransportIdentityKey
	);
	if (hotelRunnerFirstFallbackBoundary && existing) {
		return hotelRunnerFirstFallbackExistingNoMutationResult(
			existing,
			hotelRunnerFirstFallbackBoundary,
			warnings,
			errors
		);
	}
	if (
		existing &&
		crossTransportIdentityKey &&
		normalizeWhitespace(existing.otaCrossTransportIdentityKey || "") &&
		!reservationMatchesOtaCrossTransportIdentity(
			existing,
			crossTransportIdentityKey
		)
	) {
		return {
			status: "needs_review",
			actionTaken: "skipped",
			skipReason: "ota_cross_transport_identity_conflict",
			automationComment:
				"The verified Trip.com bridge conflicts with the reservation's existing cross-transport identity; no fields were changed.",
			warnings,
			errors: [
				...errors,
				"Conflicting OTA cross-transport identity key detected.",
			],
			reservationId: existing._id,
			hotelId: existing.hotelId,
			pmsConfirmationNumber: existing.confirmation_number,
		};
	}
	const matchedByCrossTransportIdentity = isSafeOtaCrossTransportMatch(
		existing,
		confirmationNumber,
		crossTransportIdentityKey,
		normalized.provider
	);
	if (matchedByCrossTransportIdentity) {
		normalized.preserveCanonicalTransportIdentity = true;
	}
	const matchedReservationBy = existing
		? detectConfirmationMatchFields(
				existing,
				confirmationNumber,
				normalized.provider,
				crossTransportIdentityKey
		  )
		: [];
	const authoritativeInboundEmailCancellation = !!(
		existing &&
		isAuthoritativeInboundEmailCancellation(normalized, statusToApply)
	);
	logReconcile("existing.checked", {
		platformConfirmationNumber: confirmationNumber,
		found: !!existing,
		reservationId: existing?._id ? String(existing._id) : "",
		pmsConfirmationNumber: existing?.confirmation_number || "",
		hotelId: existing?.hotelId ? String(existing.hotelId) : "",
		matchedReservationBy,
	});
	if (
		existing &&
		(isStatusIntent || isUpdateIntent) &&
		lowerAuthorityOtaLifecycleMustYieldToHotelRunnerApi(normalized, existing)
	) {
		logReconcile("lifecycle.ignored.lower_authority_after_hotelrunner_api", {
			confirmationNumber,
			intent,
			eventType: normalized.eventType || "",
			incomingAuthority: otaSourceAuthority(normalized),
			existingAuthority: Number(
				existing.supplierData?.otaSourceAuthority || 0
			),
		});
		return {
			status: "ignored",
			actionTaken: "skipped",
			skipReason: "lower_authority_ota_lifecycle_after_hotelrunner_api",
			automationComment:
				"A lower-authority OTA email lifecycle event cannot overwrite the direct HotelRunner API projection; no reservation fields were changed.",
			warnings,
			errors,
			reservationId: existing._id,
			hotelId: existing.hotelId,
			pmsConfirmationNumber: existing.confirmation_number,
			matchedReservationBy,
		};
	}

	const mutationOrderingConflict =
		existing && (isStatusIntent || isUpdateIntent)
			? authoritativeInboundEmailCancellation
				? otaCancellationOrderingConflict(normalized, existing)
				: otaLifecycleOrderingConflict(normalized, existing)
			: "";
	if (mutationOrderingConflict) {
		const missingTimestamp =
			mutationOrderingConflict !== "stale_or_equal_timestamp";
		logReconcile(
			missingTimestamp
				? "lifecycle.needs_review.missing_timestamp"
				: "lifecycle.needs_review.stale_event",
			{
				confirmationNumber,
				statusToApply,
				intent,
				incomingReceivedAt: normalized?.source?.receivedAt || null,
				lastAppliedReceivedAt:
					authoritativeInboundEmailCancellation
						? otaExistingCancellationBaselineAt(existing) || null
						: otaExistingLifecycleBaselineAt(existing) || null,
			}
		);
		return {
			status: "needs_review",
			actionTaken: "skipped",
			skipReason: missingTimestamp
				? "ota_lifecycle_timestamp_missing"
				: "stale_ota_lifecycle_event",
			automationComment: missingTimestamp
				? "The OTA lifecycle email has no trusted source timestamp, so it cannot be safely ordered against prior reservation events."
				: "An older or equal-time OTA lifecycle email was not allowed to overwrite a newer reservation event.",
			warnings,
			errors: [
				...errors,
				missingTimestamp
					? "This OTA lifecycle email has no trusted ordering timestamp."
					: "This OTA lifecycle email is older than or equal to the latest OTA event already applied to the reservation.",
			],
			reservationId: existing._id,
			hotelId: existing.hotelId,
			pmsConfirmationNumber: existing.confirmation_number,
			matchedReservationBy,
		};
	}

	if (existing && isUpdateIntent && hasTerminalOtaReservationStatus(existing)) {
		logReconcile("update.needs_review.terminal_reservation", {
			confirmationNumber,
			existingState: existing.state || "",
			existingReservationStatus: existing.reservation_status || "",
		});
		return {
			status: "needs_review",
			actionTaken: "skipped",
			skipReason: "terminal_ota_reservation_update_blocked",
			automationComment:
				"An ordinary OTA modification cannot move a terminal reservation back into platform review; no fields were changed.",
			warnings,
			errors: [
				...errors,
				"OTA modifications to cancelled, no-show, or checked-out reservations require manual review.",
			],
			reservationId: existing._id,
			hotelId: existing.hotelId,
			pmsConfirmationNumber: existing.confirmation_number,
			matchedReservationBy,
		};
	}

	if (existing && isUpdateIntent && hasInhouseOtaReservationStatus(existing)) {
		logReconcile("update.needs_review.inhouse_reservation", {
			confirmationNumber,
			existingState: existing.state || "",
			existingReservationStatus: existing.reservation_status || "",
		});
		return {
			status: "needs_review",
			actionTaken: "skipped",
			skipReason: "inhouse_ota_reservation_update_blocked",
			automationComment:
				"An ordinary OTA modification cannot move an in-house reservation back into platform review; no fields were changed.",
			warnings,
			errors: [
				...errors,
				"OTA modifications to an in-house reservation require manual review.",
			],
			reservationId: existing._id,
			hotelId: existing.hotelId,
			pmsConfirmationNumber: existing.confirmation_number,
			matchedReservationBy,
		};
	}

	if (existing && isStatusIntent && !statusToApply) {
		logReconcile("status.needs_review.unknown_status", {
			confirmationNumber,
		});
		return {
			status: "needs_review",
			actionTaken: "skipped",
			skipReason: "unknown_ota_status_no_mutation",
			warnings,
			errors: [...errors, "Could not safely determine which status to apply."],
			reservationId: existing._id,
			hotelId: existing.hotelId,
			pmsConfirmationNumber: existing.confirmation_number,
			matchedReservationBy,
		};
	}

	if (
		existing &&
		isStatusIntent &&
		!authoritativeInboundEmailCancellation &&
		wouldReopenTerminalOtaReservation(existing, statusToApply)
	) {
		logReconcile("status.needs_review.terminal_transition", {
			confirmationNumber,
			statusToApply,
			existingState: existing.state || "",
			existingReservationStatus: existing.reservation_status || "",
		});
		return {
			status: "needs_review",
			actionTaken: "skipped",
			skipReason: "terminal_ota_reservation_transition_blocked",
			automationComment:
				"A terminal reservation cannot transition to a different OTA status without an explicit manual policy; no fields were changed.",
			warnings,
			errors: [
				...errors,
				"Incoming OTA status conflicts with the reservation's terminal status and requires manual review.",
			],
			reservationId: existing._id,
			hotelId: existing.hotelId,
			pmsConfirmationNumber: existing.confirmation_number,
			matchedReservationBy,
		};
	}

	if (
		existing &&
		isStatusIntent &&
		!authoritativeInboundEmailCancellation &&
		wouldRegressInhouseOtaReservation(existing, statusToApply)
	) {
		logReconcile("status.needs_review.inhouse_regression", {
			confirmationNumber,
			statusToApply,
			existingState: existing.state || "",
			existingReservationStatus: existing.reservation_status || "",
		});
		return {
			status: "needs_review",
			actionTaken: "skipped",
			skipReason: "inhouse_ota_status_regression_blocked",
			automationComment:
				"An in-house reservation may only remain in-house or advance to checked-out automatically; no fields were changed.",
			warnings,
			errors: [
				...errors,
				"Incoming OTA status is not an allowed in-house lifecycle transition.",
			],
			reservationId: existing._id,
			hotelId: existing.hotelId,
			pmsConfirmationNumber: existing.confirmation_number,
			matchedReservationBy,
		};
	}

	if (
		existing &&
		isStatusIntent &&
		terminalLifecycleStayDatesConflict(normalized, existing, statusToApply)
	) {
		logReconcile("status.needs_review.stay_conflict", {
			confirmationNumber,
			statusToApply,
			incomingCheckin: normalized.checkinDate || "",
			incomingCheckout: normalized.checkoutDate || "",
			existingCheckin: existing.checkin_date || "",
			existingCheckout: existing.checkout_date || "",
		});
		return {
			status: "needs_review",
			actionTaken: "skipped",
			skipReason: "terminal_ota_lifecycle_stay_dates_conflict",
			automationComment:
				"The source-backed cancellation or no-show stay dates do not exactly match the existing reservation; no fields were changed.",
			warnings,
			errors: [
				...errors,
				"Terminal OTA lifecycle stay dates conflict with the existing reservation.",
			],
			reservationId: existing._id,
			hotelId: existing.hotelId,
			pmsConfirmationNumber: existing.confirmation_number,
			matchedReservationBy,
		};
	}

	let independentlyResolvedIncomingHotel =
		hotelRunnerFirstFallbackResolvedHotel;
	if (
		!independentlyResolvedIncomingHotel &&
		hasNonemptySourceBackedHotelCandidate(normalized) &&
		(isOtaInboundEmail(normalized) || existing)
	) {
		independentlyResolvedIncomingHotel = await resolveHotel(normalized, null);
		if (!independentlyResolvedIncomingHotel) {
			logReconcile("needs_review.source_backed_hotel_unresolved", {
				confirmationNumber,
				hotelName: normalized.hotelName || "",
				hotelId: normalized.hotelId || "",
				reservationId: existing?._id ? String(existing._id) : "",
			});
			return unresolvedSourceBackedHotelResult(existing, matchedReservationBy);
		}
	}
	if (existing && independentlyResolvedIncomingHotel) {
		if (
			resolvedIncomingHotelConflictsWithExisting(
				existing,
				independentlyResolvedIncomingHotel
			)
		) {
			logReconcile("needs_review.existing_hotel_conflict", {
				confirmationNumber,
				reservationId: String(existing._id),
				existingHotelId: normalizeId(existing.hotelId),
				incomingHotelId: normalizeId(independentlyResolvedIncomingHotel._id),
			});
			return {
				status: "needs_review",
				actionTaken: "skipped",
				skipReason: "ota_incoming_hotel_conflicts_with_existing_reservation",
				automationComment:
					"The source-backed incoming hotel resolves to a different PMS hotel than the matched reservation; no fields were changed.",
				warnings,
				errors: [
					...errors,
					"Incoming OTA hotel identity conflicts with the existing reservation hotel.",
				],
				reservationId: existing._id,
				hotelId: existing.hotelId,
				pmsConfirmationNumber: existing.confirmation_number,
				matchedReservationBy,
			};
		}
	}
	if (
		existing &&
		hasDirectHotelRunnerProjection(existing) &&
		isOtaInboundEmail(normalized)
	) {
		const directOwnedResult = await reconcileDirectHotelRunnerOwnedEmail({
			normalized,
			existing,
			hotelDetails: independentlyResolvedIncomingHotel,
			matchedReservationBy,
			warnings,
			errors,
		});
		if (directOwnedResult) {
			logReconcile("hotelrunner_owned_email.boundary", {
				confirmationNumber,
				reservationId: String(existing._id || ""),
				status: directOwnedResult.status,
				skipReason: directOwnedResult.skipReason || "",
				actionTaken: directOwnedResult.actionTaken || "",
			});
			return directOwnedResult;
		}
	}

	if (existing && intent === "new_reservation" && !isStatusIntent && !isUpdateIntent) {
		const incomingAuthority = otaSourceAuthority(normalized);
		const existingAuthority = Number(
			existing?.supplierData?.otaSourceAuthority || 0
		);
		const reviewStatusPending =
			normalizeComparable(existing?.otaPlatformReview?.status || "") ===
			"pending";
		const existingPendingReview = !!(
			reviewStatusPending &&
			normalizeComparable(existing?.state || "") ===
				normalizeComparable(OTA_PLATFORM_REVIEW_RESERVATION_STATUS) &&
			normalizeComparable(existing?.reservation_status || "") ===
				normalizeComparable(OTA_PLATFORM_REVIEW_RESERVATION_STATUS)
		);
		const authorityUpgrade = isAuthoritativeSourceUpgrade(
			incomingAuthority,
			existingAuthority,
		);
		const requiredRefreshFacts = requiredNewReservationMissing(normalized);
		if (
			reviewStatusPending &&
			!existingPendingReview &&
			authorityUpgrade &&
			requiredRefreshFacts.length === 0
		) {
			const protectsInhouse = hasInhouseOtaReservationStatus(existing);
			const protectsTerminal = hasTerminalOtaReservationStatus(existing);
			const protectedSkipReason = protectsInhouse
				? "inhouse_ota_reservation_refresh_blocked"
				: protectsTerminal
				? "terminal_ota_reservation_refresh_blocked"
				: "authoritative_refresh_operational_state_protected";
			logReconcile("authoritative_refresh.needs_review.operational_state", {
				confirmationNumber,
				existingState: existing.state || "",
				existingReservationStatus: existing.reservation_status || "",
			});
			return {
				status: "needs_review",
				actionTaken: "skipped",
				skipReason: protectedSkipReason,
				automationComment:
					protectsInhouse
						? "A higher-authority confirmation cannot move an in-house reservation back into platform review; no fields were changed."
						: protectsTerminal
						? "A higher-authority confirmation cannot refresh a terminal reservation automatically; no fields were changed."
						: "The review marker is stale because both PMS operational statuses are not OTA Platform Review; no fields were changed.",
				warnings,
				errors: [
					...errors,
					protectsInhouse
						? "Higher-authority refresh of an in-house reservation requires manual review."
						: protectsTerminal
						? "Higher-authority refresh of a cancelled, no-show, or checked-out reservation requires manual review."
						: "A pending OTA review cannot override a custom or manually advanced PMS operational status.",
				],
				reservationId: existing._id,
				hotelId: existing.hotelId,
				pmsConfirmationNumber: existing.confirmation_number,
				matchedReservationBy,
			};
		}
		const canAuthoritativelyRefresh =
			existingPendingReview &&
			authorityUpgrade &&
			requiredRefreshFacts.length === 0;
		if (canAuthoritativelyRefresh) {
			const refreshOrderingConflict = otaLifecycleOrderingConflict(
				normalized,
				existing
			);
			const acceptedDirectAfterRelaySkew = canUseDirectAfterRelaySourceSkew({
				normalized,
				existing,
				orderingConflict: refreshOrderingConflict,
				incomingAuthority,
				existingAuthority,
				matchedReservationBy,
			});
			if (refreshOrderingConflict && !acceptedDirectAfterRelaySkew) {
				const missingTimestamp =
					refreshOrderingConflict !== "stale_or_equal_timestamp";
				logReconcile(
					missingTimestamp
						? "authoritative_refresh.needs_review.missing_timestamp"
						: "authoritative_refresh.needs_review.stale_event",
					{
						confirmationNumber,
						incomingReceivedAt: normalized?.source?.receivedAt || null,
						lastAppliedReceivedAt:
							otaExistingLifecycleBaselineAt(existing) || null,
					}
				);
				return {
					status: "needs_review",
					actionTaken: "skipped",
					skipReason: missingTimestamp
						? "ota_lifecycle_timestamp_missing"
						: "stale_ota_lifecycle_event",
					automationComment: missingTimestamp
						? "The higher-authority OTA confirmation has no trusted source timestamp, so it cannot safely refresh the existing reservation."
						: "An older or equal-time higher-authority OTA confirmation was not allowed to refresh the existing reservation.",
					warnings,
					errors: [
						...errors,
						missingTimestamp
							? "The higher-authority OTA confirmation has no trusted ordering timestamp."
							: "The higher-authority OTA confirmation is older than or equal to the latest OTA event already applied.",
					],
					reservationId: existing._id,
					hotelId: existing.hotelId,
					pmsConfirmationNumber: existing.confirmation_number,
					matchedReservationBy,
				};
			}
			if (hasTerminalOtaReservationStatus(existing)) {
				logReconcile("authoritative_refresh.needs_review.terminal_reservation", {
					confirmationNumber,
					existingState: existing.state || "",
					existingReservationStatus: existing.reservation_status || "",
				});
				return {
					status: "needs_review",
					actionTaken: "skipped",
					skipReason: "terminal_ota_reservation_refresh_blocked",
					automationComment:
						"A higher-authority confirmation cannot refresh a terminal reservation automatically; no fields were changed.",
					warnings,
					errors: [
						...errors,
						"Higher-authority refresh of a cancelled, no-show, or checked-out reservation requires manual review.",
					],
					reservationId: existing._id,
					hotelId: existing.hotelId,
					pmsConfirmationNumber: existing.confirmation_number,
					matchedReservationBy,
				};
			}
			if (hasInhouseOtaReservationStatus(existing)) {
				logReconcile("authoritative_refresh.needs_review.inhouse_reservation", {
					confirmationNumber,
					existingState: existing.state || "",
					existingReservationStatus: existing.reservation_status || "",
				});
				return {
					status: "needs_review",
					actionTaken: "skipped",
					skipReason: "inhouse_ota_reservation_refresh_blocked",
					automationComment:
						"A higher-authority confirmation cannot move an in-house reservation back into platform review; no fields were changed.",
					warnings,
					errors: [
						...errors,
						"Higher-authority refresh of an in-house reservation requires manual review.",
					],
					reservationId: existing._id,
					hotelId: existing.hotelId,
					pmsConfirmationNumber: existing.confirmation_number,
					matchedReservationBy,
				};
			}
			normalized.authoritativeExistingRefresh = true;
			normalized.otaSourceAuthority = incomingAuthority;
			if (acceptedDirectAfterRelaySkew) {
				normalized.authoritativeRelayClockSkewAccepted = true;
				warnings.push(
					"The authenticated direct OTA confirmation preceded its lower-authority HotelRunner relay by less than 15 minutes; exact hotel, stay, and PMS room identity must still agree before pricing can be refreshed."
				);
			}
			warnings.push(
				"A higher-authority direct OTA confirmation replaced lower-authority pending email facts before hotel release."
			);
			logReconcile("existing_new_booking.authoritative_refresh", {
				confirmationNumber,
				reservationId: String(existing._id),
				existingAuthority,
				incomingAuthority,
				acceptedDirectAfterRelaySkew,
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

	if (isUpdateIntent && existing) {
		logReconcile("update.stage.start", {
			confirmationNumber,
			reservationId: String(existing._id),
			hotelId: existing.hotelId ? String(existing.hotelId) : "",
		});
		const set = await applyExistingReservationEmailUpdate({
			normalized,
			existing,
			statusToApply,
			warnings,
			action: "staged-existing-update-from-email",
		});
		logReconcile("update.stage.done", {
			confirmationNumber,
			reservationId: String(existing._id),
			updatedFields: Object.keys(set),
		});
		return {
			status: "updated",
			warnings,
			errors,
			reservationId: existing._id,
			hotelId: existing.hotelId,
			pmsConfirmationNumber: existing.confirmation_number,
			otaPlatformReviewStatus:
				set?.["otaPlatformReview.status"] ||
				existing?.otaPlatformReview?.status ||
				"",
			matchedReservationBy,
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
			resolvedHotel: hotelRunnerFirstFallbackResolvedHotel,
			hotelRunnerFirstFallbackBoundary,
		});
	}

	const hotelDetails =
		hotelRunnerFirstFallbackResolvedHotel ||
		independentlyResolvedIncomingHotel ||
		(await resolveHotel(
			normalized,
			normalized.authoritativeExistingRefresh ? null : existing
		));
	if (!hotelDetails) {
		logReconcile("needs_mapping.hotel", {
			confirmationNumber,
			hotelName: normalized.hotelName || "",
		});
		if (existing && normalized.authoritativeExistingRefresh === true) {
			return {
				status: "needs_review",
				actionTaken: "skipped",
				skipReason: "authoritative_relay_refresh_hotel_unresolved",
				automationComment:
					"The earlier direct OTA confirmation could not resolve the same PMS hotel as its later relay; no reservation fields were changed.",
				warnings,
				errors: [...errors, "Direct-after-relay hotel verification failed."],
				reservationId: existing._id,
				hotelId: existing.hotelId,
				pmsConfirmationNumber: existing.confirmation_number,
				matchedReservationBy,
			};
		}
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
			resolvedHotel: hotelRunnerFirstFallbackResolvedHotel,
			hotelRunnerFirstFallbackBoundary,
		});
	}
	if (existing && normalized.authoritativeExistingRefresh === true) {
		const refreshGuard = authoritativeExistingRefreshGuard({
			existing,
			hotelDetails,
			matchedReservationBy,
			normalized,
		});
		if (!refreshGuard.ok) {
			logReconcile("authoritative_refresh.needs_review.protected_preflight", {
				confirmationNumber,
				reason: refreshGuard.reason,
				reservationId: String(existing._id),
			});
			return {
				status: "needs_review",
				actionTaken: "skipped",
				skipReason: "authoritative_existing_refresh_guard_failed",
				automationComment:
					"The higher-authority confirmation did not satisfy every protected existing-reservation invariant; no fields were changed.",
				warnings,
				errors: [
					...errors,
					`Protected authoritative refresh gate failed: ${refreshGuard.reason}.`,
				],
				reservationId: existing._id,
				hotelId: existing.hotelId,
				pmsConfirmationNumber: existing.confirmation_number,
				matchedReservationBy,
			};
		}
	}
	if (
		matchedByCrossTransportIdentity &&
		existing?.hotelId &&
		normalizeId(existing.hotelId) !== normalizeId(hotelDetails._id)
	) {
		return {
			status: "needs_review",
			actionTaken: "skipped",
			skipReason: "ota_cross_transport_hotel_conflict",
			automationComment:
				"The direct Trip.com and relayed reservation identities agree, but their resolved hotels conflict; no fields were changed.",
			warnings,
			errors: [
				...errors,
				"Cross-transport OTA match resolved to a different hotel.",
			],
			reservationId: existing._id,
			hotelId: existing.hotelId,
			pmsConfirmationNumber: existing.confirmation_number,
			matchedReservationBy,
		};
	}
	if (!existing && crossTransportIdentityKey) {
		const legacyRedactedIdentityConflict =
			await findLegacyRedactedTripIdentityConflict(
				normalized,
				hotelDetails._id
			);
		if (legacyRedactedIdentityConflict) {
			return {
				status: "needs_review",
				actionTaken: "skipped",
				skipReason: "legacy_redacted_trip_identity_conflict",
				automationComment:
					"A legacy HotelRunner record has the same Trip confirmation suffix, hotel, and stay dates but its full OTA identity was historically redacted; no duplicate was created and no identity was guessed.",
				warnings,
				errors: [
					...errors,
					"Possible legacy redacted Trip.com identity requires manual verification.",
				],
				reservationId: legacyRedactedIdentityConflict._id,
				hotelId: legacyRedactedIdentityConflict.hotelId,
				pmsConfirmationNumber:
					legacyRedactedIdentityConflict.confirmation_number,
				matchedReservationBy: [
					"legacyRedactedTripSuffix",
					"hotelId",
					"stayDates",
				],
			};
		}
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
			allowCreate: true,
			resolvedHotel: hotelDetails,
			hotelRunnerFirstFallbackBoundary,
		});
	}

	// A direct OTA confirmation can legitimately arrive after its HotelRunner
	// relay while carrying an earlier source timestamp. When the relay was saved
	// as an exact-hotel, deliberately unmapped review, do not invoke room AI or
	// invent a PMS configuration. Refresh only after every identity, hotel, room
	// semantic/capacity, finance, and unreleased-review invariant is exact.
	if (
		existing &&
		normalized.authoritativeExistingRefresh === true &&
		!hasAnyOtaRoomConfiguration(existing)
	) {
		const guard = directAfterRelayUnmappedReviewGuard({
			existing,
			hotelDetails,
			matchedReservationBy,
			normalized,
		});
		if (!guard.ok) {
			logReconcile("authoritative_refresh.needs_review.unmapped_guard", {
				confirmationNumber,
				reason: guard.reason,
				reservationId: String(existing._id),
			});
			return {
				status: "needs_review",
				actionTaken: "skipped",
				skipReason: "authoritative_relay_refresh_unmapped_guard_failed",
				automationComment:
					"The direct OTA commercial confirmation could not satisfy every protected unmapped-review invariant; no reservation fields were changed.",
				warnings,
				errors: [
					...errors,
					`Protected direct-after-relay unmapped-review gate failed: ${guard.reason}.`,
				],
				reservationId: existing._id,
				hotelId: existing.hotelId,
				pmsConfirmationNumber: existing.confirmation_number,
				matchedReservationBy,
			};
		}
		const document = buildUnmappedOtaReviewReservationDocument(normalized);
		const exactHotelAssigned = applyExactResolvedHotelToUnmappedReview(
			document,
			hotelDetails,
			normalized
		);
		const rebuiltGuard = exactHotelAssigned
			? directAfterRelayUnmappedReviewGuard({
					document,
					existing,
					hotelDetails,
					matchedReservationBy,
					normalized,
			  })
			: { ok: false, reason: "rebuilt_hotel" };
		if (!rebuiltGuard.ok) {
			logReconcile("authoritative_refresh.needs_review.unmapped_rebuild", {
				confirmationNumber,
				reason: rebuiltGuard.reason,
				reservationId: String(existing._id),
			});
			return {
				status: "needs_review",
				actionTaken: "skipped",
				skipReason: "authoritative_relay_refresh_unmapped_rebuild_failed",
				automationComment:
					"The authoritative OTA facts did not rebuild the exact protected unmapped-review shape; no reservation fields were changed.",
				warnings,
				errors: [
					...errors,
					`Protected direct-after-relay unmapped document failed: ${rebuiltGuard.reason}.`,
				],
				reservationId: existing._id,
				hotelId: existing.hotelId,
				pmsConfirmationNumber: existing.confirmation_number,
				matchedReservationBy,
			};
		}
		normalized.authoritativeUnmappedReviewRefresh = true;
		const refreshWarning =
			"Authenticated direct OTA guest, payout, expense, payment, source, and nightly facts refreshed the exact-hotel unmapped review; PMS room/configuration and all root, margin, and commission values remain unassigned at zero.";
		if (!warnings.includes(refreshWarning)) warnings.push(refreshWarning);
		const set = await applyExistingReservationEmailUpdate({
			action: "authoritative-unmapped-commercial-refresh-from-email",
			document,
			existing,
			normalized,
			statusToApply,
			warnings,
		});
		logReconcile("authoritative_refresh.unmapped_review.updated", {
			confirmationNumber,
			hotelId: normalizeId(existing.hotelId),
			reservationId: String(existing._id),
			roomCapacity: rebuiltGuard.capacity,
			roomCount: rebuiltGuard.roomCount,
			roomType: rebuiltGuard.roomType,
			updatedFields: Object.keys(set),
		});
		return {
			status: "updated",
			warnings,
			errors,
			reservationId: existing._id,
			hotelId: existing.hotelId,
			pmsConfirmationNumber: existing.confirmation_number,
			otaPlatformReviewStatus:
				set?.["otaPlatformReview.status"] ||
				existing?.otaPlatformReview?.status ||
				"",
			matchedReservationBy,
		};
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
		if (existing && normalized.authoritativeRelayClockSkewAccepted === true) {
			return {
				status: "needs_review",
				actionTaken: "skipped",
				skipReason: "authoritative_relay_refresh_room_or_pricing_unresolved",
				automationComment:
					"The earlier direct OTA confirmation could not reproduce the relayed reservation's PMS room and pricing safely; no reservation fields were changed.",
				warnings,
				errors: [...errors, built.error],
				reservationId: existing._id,
				hotelId: existing.hotelId,
				pmsConfirmationNumber: existing.confirmation_number,
				matchedReservationBy,
			};
		}
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
				`${built.error} Saved as an isolated OTA platform review pending room and pricing confirmation.`,
			],
			errors,
			allowCreate: true,
			resolvedHotel: hotelDetails,
			hotelRunnerFirstFallbackBoundary,
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
		if (existing && normalized.authoritativeRelayClockSkewAccepted === true) {
			return {
				status: "needs_review",
				actionTaken: "skipped",
				skipReason: "authoritative_relay_refresh_pricing_unresolved",
				automationComment:
					"The earlier direct OTA confirmation could not reproduce safe pricing for its later relay; no reservation fields were changed.",
				warnings,
				errors: [
					...errors,
					error.message || "Could not calculate reservation pricing.",
				],
				reservationId: existing._id,
				hotelId: existing.hotelId,
				pmsConfirmationNumber: existing.confirmation_number,
				matchedReservationBy,
			};
		}
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
				`${error.message || "Could not calculate reservation pricing."} Saved as an isolated OTA platform review pending pricing confirmation.`,
			],
			errors,
			allowCreate: true,
			resolvedHotel: hotelDetails,
			hotelRunnerFirstFallbackBoundary,
		});
	}
	if (existing && normalized.authoritativeExistingRefresh === true) {
		const rebuiltGuard = authoritativeMappedRefreshDocumentGuard({
			document,
			existing,
			normalized,
		});
		if (!rebuiltGuard.ok) {
		logReconcile("authoritative_refresh.needs_review.rebuilt_conflict", {
			confirmationNumber,
			reason: rebuiltGuard.reason,
			reservationId: String(existing._id),
			existingHotelId: normalizeId(existing.hotelId),
			incomingHotelId: normalizeId(document.hotelId),
			existingRoomIds: otaRoomConfigIds(existing),
			incomingRoomIds: otaRoomConfigIds(document),
		});
		return {
			status: "needs_review",
			actionTaken: "skipped",
			skipReason: "authoritative_existing_refresh_rebuild_guard_failed",
			automationComment:
				"The rebuilt authoritative reservation did not preserve the exact PMS hotel, room, root, commission, and protected commercial shape; no fields were changed.",
			warnings,
			errors: [
				...errors,
				`Protected authoritative rebuilt-document gate failed: ${rebuiltGuard.reason}.`,
			],
			reservationId: existing._id,
			hotelId: existing.hotelId,
			pmsConfirmationNumber: existing.confirmation_number,
			matchedReservationBy,
		};
		}
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
		"",
		crossTransportIdentityKey
	);
	if (existingBeforeCreate) {
		if (hotelRunnerFirstFallbackBoundary) {
			return hotelRunnerFirstFallbackExistingNoMutationResult(
				existingBeforeCreate,
				hotelRunnerFirstFallbackBoundary,
				warnings,
				errors
			);
		}
		const lateMatchedBy = detectConfirmationMatchFields(
			existingBeforeCreate,
			confirmationNumber,
			normalized.provider,
			crossTransportIdentityKey
		);
		logReconcile("duplicate_reservation.pre_create_recheck", {
			confirmationNumber,
			reservationId: String(existingBeforeCreate._id),
			matchedReservationBy: lateMatchedBy,
		});
		if (
			hasDirectHotelRunnerProjection(existingBeforeCreate) &&
			isOtaInboundEmail(normalized)
		) {
			const directOwnedResult = await reconcileDirectHotelRunnerOwnedEmail({
				normalized,
				existing: existingBeforeCreate,
				hotelDetails,
				matchedReservationBy: lateMatchedBy,
				warnings,
				errors,
			});
			if (directOwnedResult) return directOwnedResult;
		}
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
	if (crossTransportIdentityKey) {
		document.otaCrossTransportIdentityKey = crossTransportIdentityKey;
	}
	const commercialEvidence = buildHotelRunnerEmailCommercialEvidence(normalized);
	if (commercialEvidence) {
		applyHotelRunnerEmailCommercialEvidenceToDocument(
			document,
			normalized,
			commercialEvidence
		);
	}
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
	if (
		hotelRunnerFirstFallbackBoundary &&
		normalizeId(document.hotelId) !==
			hotelRunnerFirstFallbackBoundary.hotelId
	) {
		return {
			status: "needs_review",
			actionTaken: "skipped",
			skipReason: "hotelrunner_first_fallback_hotel_identity_conflict",
			warnings,
			errors: [
				...errors,
				"Confirmed-empty fallback document did not preserve the exact queued hotel.",
			],
			reservationId: null,
			hotelId: null,
			pmsConfirmationNumber: "",
			matchedReservationBy: [],
		};
	}
	let created;
	for (let createAttempt = 0; createAttempt < 2; createAttempt += 1) {
		let creationAuthorization = null;
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
					: "ota_email_create",
				hotelRunnerFirstFallbackBoundary
					? {
							beforeInsert: async ({ reservationData }) => {
								creationAuthorization =
									await authorizeAndStampHotelRunnerFirstFallbackCreation(
										reservationData,
										hotelRunnerFirstFallbackBoundary
									);
							},
						  }
					: {}
			);
			if (hotelRunnerFirstFallbackBoundary) {
				await commitHotelRunnerFirstFallbackCreation(
					created,
					hotelRunnerFirstFallbackBoundary,
					creationAuthorization
				);
			}
			break;
		} catch (error) {
			let releaseResult = null;
			if (hotelRunnerFirstFallbackBoundary && creationAuthorization) {
				try {
					releaseResult = await releaseHotelRunnerFirstFallbackCreation(
						hotelRunnerFirstFallbackBoundary,
						creationAuthorization
					);
				} catch (releaseError) {
					error.releaseError = releaseError;
					throw error;
				}
			}
			if (releaseResult?.committed === true) {
				const committedDuplicate =
					await findReservationByOtaConfirmation(
						confirmationNumber,
						normalized.provider,
						"",
						crossTransportIdentityKey
					);
				if (committedDuplicate) {
					return hotelRunnerFirstFallbackExistingNoMutationResult(
						committedDuplicate,
						hotelRunnerFirstFallbackBoundary,
						warnings,
						errors
					);
				}
			}
			if (error?.code === 11000) {
				logReconcile("create.duplicate_key", {
					platformConfirmationNumber: confirmationNumber,
					pmsConfirmationNumber: document.confirmation_number,
				});
				const duplicate = await findReservationByOtaConfirmation(
					confirmationNumber,
					normalized.provider,
					"",
					crossTransportIdentityKey
				);
				if (duplicate) {
					if (hotelRunnerFirstFallbackBoundary) {
						return hotelRunnerFirstFallbackExistingNoMutationResult(
							duplicate,
							hotelRunnerFirstFallbackBoundary,
							warnings,
							errors
						);
					}
					const duplicateMatchedBy = detectConfirmationMatchFields(
						duplicate,
						confirmationNumber,
						normalized.provider,
						crossTransportIdentityKey
					);
					if (
						hasDirectHotelRunnerProjection(duplicate) &&
						isOtaInboundEmail(normalized)
					) {
						const directOwnedResult =
							await reconcileDirectHotelRunnerOwnedEmail({
								normalized,
								existing: duplicate,
								hotelDetails,
								matchedReservationBy: duplicateMatchedBy,
								warnings,
								errors,
							});
						if (directOwnedResult) return directOwnedResult;
					}
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

async function reconcileOtaReservation(inputNormalized, options = {}) {
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
	if (input.intent === "new_reservation") {
		const allocationSafety = otaInboundAllocationSafety(input);
		if (!allocationSafety.ok) {
			return otaInboundAllocationLimitReview(input, allocationSafety);
		}
	}
	const confirmationNumber = normalizeConfirmation(
		input.confirmationNumber || input.reservationId
	);
	try {
		return await enqueueOtaReservationWork(
			() => reconcileOtaReservationUnqueued(input, options),
			{
				confirmationNumber,
				provider: input.provider || "unknown",
				source: input.source?.from || "ota",
			}
		);
	} catch (error) {
		if (error?.code !== "OTA_RESERVATION_IDENTITY_CONFLICT") throw error;
		logReconcile("needs_review.ota_identity_conflict", {
			confirmationNumber,
			provider: input.provider || "unknown",
			reason: error.reason || "ota_identity_conflict",
			reservationIds: error.reservationIds || [],
		});
		return {
			status: "needs_review",
			actionTaken: "skipped",
			skipReason: "ota_reservation_identity_conflict_no_mutation",
			automationComment:
				"Multiple or internally contradictory OTA reservation identities were detected; no reservation was selected, created, or changed.",
			warnings: [...(input.warnings || [])],
			errors: [
				...(input.errors || []),
				"Conflicting OTA reservation identity evidence requires manual review.",
			],
			reservationId: null,
			hotelId: null,
			pmsConfirmationNumber: "",
			matchedReservationBy: [],
		};
	}
}

function buildUnmappedOtaReviewReservationDocument(normalized = {}) {
	const allocationSafety = otaInboundAllocationSafety(normalized);
	if (!allocationSafety.ok) {
		const error = new RangeError(
			"Inbound room allocation exceeds the per-email resource-safety limit."
		);
		error.code = "OTA_INBOUND_ALLOCATION_RESOURCE_LIMIT";
		error.reason = allocationSafety.reason;
		throw error;
	}
	if (hasAmbiguousMultiRoomEvidence(normalized)) {
		const error = new RangeError(
			"Ambiguous or multi-block OTA room payload cannot be materialized as one partial reservation."
		);
		error.code = "OTA_INBOUND_AMBIGUOUS_MULTI_ROOM";
		throw error;
	}
	const propertyCurrency = String(normalized.propertyCurrency || "SAR")
		.trim()
		.toUpperCase();
	const otaCommercialEvidence = buildNormalizedOtaCommercialEvidence(
		normalized,
		{ propertyCurrency }
	);
	const normalizedForPricing = {
		...normalized,
		propertyCurrency,
		...(otaCommercialEvidence ? { otaCommercialEvidence } : {}),
	};
	const totalAmountSar = verifiedPropertyGuestGrossSar(normalizedForPricing);
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
	const otaCommissionSar =
		otaCommercialEvidence?.roles?.explicitOtaCommission?.propertyAmount ??
		null;
	const netAfterExpensesTotal = verifiedPropertyPayoutSar(normalizedForPricing);
	if (
		totalAmountSar !== null &&
		netAfterExpensesTotal !== null &&
		netAfterExpensesTotal > totalAmountSar + 0.02
	) {
		const error = new RangeError(
			"Verified OTA payout exceeds verified guest gross."
		);
		error.code = "OTA_COMMERCIAL_PAYOUT_EXCEEDS_GROSS";
		throw error;
	}
	const otaExpenseTotal =
		totalAmountSar !== null && netAfterExpensesTotal !== null
			? Math.max(0, round2(totalAmountSar - netAfterExpensesTotal))
			: null;
	const roomCount = Math.max(1, Math.floor(Number(normalized.roomCount || 1)));
	const dateRange = generateDateRange(
		normalized.checkinDate,
		normalized.checkoutDate
	);
	const daysOfResidence =
		dateRange.length ||
		calculateDaysOfResidence(normalized.checkinDate, normalized.checkoutDate);
	const slots = Math.max(1, dateRange.length * roomCount);
	const clientSlots =
		totalAmountSar === null
			? Array(slots).fill(null)
			: allocateAmountAcrossSlots(totalAmountSar, slots);
	const netSlots =
		netAfterExpensesTotal === null
			? Array(slots).fill(null)
			: allocateAmountAcrossSlots(netAfterExpensesTotal, slots);
	let slotIndex = 0;
	const roomDisplayName =
		normalizeWhitespace(normalized.roomName || "") || "Unmapped OTA room";
	const mappedRoomType = mapRoomType(roomDisplayName) || "";
	const pickedRoomsType = Array.from({ length: roomCount }, () => {
		const pricingByDay = dateRange.map((ymd) => {
			const currentSlot = slotIndex;
			slotIndex += 1;
			const clientPrice =
				totalAmountSar === null ? null : round2(clientSlots[currentSlot]);
			const netAfterExpenses =
				netAfterExpensesTotal === null
					? null
					: round2(netSlots[currentSlot]);
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
				otaExpenseAmount:
					clientPrice !== null && netAfterExpenses !== null
						? Math.max(0, round2(clientPrice - netAfterExpenses))
						: null,
				platformMargin: null,
				platformMarginRate: null,
			};
		});
		return {
			room_type: mappedRoomType,
			displayName: roomDisplayName,
			chosenPrice:
				totalAmountSar !== null && daysOfResidence > 0
					? round2(totalAmountSar / Math.max(1, daysOfResidence * roomCount))
					: null,
			count: 1,
			pricingByDay,
			totalPriceWithCommission:
				totalAmountSar === null
					? null
					: round2(
							pricingByDay.reduce(
								(sum, day) =>
									sum + Number(day.totalPriceWithCommission),
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
	// An unmapped review has no approved PMS room/root price. OTA collection is
	// recorded for the guest side, but no amount can become payable to the hotel
	// until a room/configuration and its root pricing are explicitly approved.
	paymentMapping.financialCycle = {
		...(paymentMapping.financialCycle || {}),
		commissionValue: 0,
		commissionAmount: 0,
		hotelPayoutDue: 0,
		commissionDueToPms: 0,
	};
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
		currency: propertyCurrency,
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
		commission_ota: otaCommissionSar,
		financial_cycle: paymentMapping.financialCycle,
		pickedRoomsType,
		pickedRoomsPricing: pickedRoomsType,
		adminPricing: {
			mode: "ota_platform_unmapped",
			clientTotal: totalAmountSar,
			rootTotal: 0,
			netAfterExpensesTotal,
			otaExpenseTotal,
			platformMarginTotal: null,
			commissionAmount: 0,
			defaultDeductionRate: null,
			defaultDeductionApplied: false,
			commercialResolution:
				totalAmountSar !== null && netAfterExpensesTotal !== null
					? "verified"
					: totalAmountSar !== null || netAfterExpensesTotal !== null
						? "partial"
						: "unresolved",
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
			currency: propertyCurrency,
			clientTotal: totalAmountSar,
			hotelVisibleAmount: 0,
			netAfterExpenses: netAfterExpensesTotal,
			netAfterOtaExpenses: netAfterExpensesTotal,
			otaExpenseTotal,
			platformProfit: null,
			commissionAmount: 0,
			otaCommissionAmount: otaCommissionSar,
			otaDeductionBreakdown: normalized.otaDeductionComponents || [],
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
			...(otaCommercialEvidence ? { otaCommercialEvidence } : {}),
			suppliedBookingNo: normalized.confirmationNumber,
			otaConfirmationNumber: normalized.confirmationNumber,
			platformConfirmationNumber: normalized.confirmationNumber,
			otaAutomationPipeline: automationPipeline,
			otaProvider: normalized.provider,
			otaSourceAuthority: otaSourceAuthority(normalized),
			otaHotelName: normalized.hotelName || "",
			otaHotelNameSourceBacked: hasSourceField(normalized, "hotelName"),
			otaHotelMappingRequired: true,
			otaRoomName: normalized.roomName || "",
			otaRoomNameSourceBacked: hasSourceField(normalized, "roomName"),
			otaRoomCount: roomCount,
			otaRoomCountSourceBacked: hasSourceField(normalized, "roomCount"),
			otaTotalGuests: Number(normalized.totalGuests || 0),
			otaTotalGuestsSourceBacked: hasSourceField(normalized, "totalGuests"),
			otaAdults: Number(normalized.adults || 0),
			otaChildren: Number(normalized.children || 0),
			otaCheckinDate: normalized.checkinDate || "",
			otaCheckoutDate: normalized.checkoutDate || "",
			otaStayDatesSourceBacked:
				hasSourceField(normalized, "checkinDate") &&
				hasSourceField(normalized, "checkoutDate"),
			otaGuestNotes: guestComment,
			otaNationality: normalized.nationality || "",
			otaCurrency: normalized.currency || "",
			otaAmount: sourceAmount || null,
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
			otaCommissionSar,
			otaCommissionSource: normalized.otaCommissionSource || "",
			otaCommissionSourceBacked: otaCommissionSar !== null,
			otaDeductionComponents: normalized.otaDeductionComponents || [],
			targetedPromotionsLabelPresent:
				normalized.targetedPromotionsLabelPresent === true,
			otaPlatformMarginSar: null,
			otaExchangeRateToSar: normalized.exchangeRateToSar || 0,
			otaExchangeRateSource: normalized.exchangeRateSource || "",
			otaAmountConvertedAt: normalized.amountConvertedAt || "",
			otaPaymentCollectionModel: normalized.paymentCollectionModel || "",
			otaPaymentInstructions: normalized.paymentInstructions || "",
			otaLastInboundEmailId: normalized.inboundEmailId || "",
			otaLastEmailAt: now,
			otaLastSourceReceivedAt: otaSourceReceivedAt(normalized),
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
	MAX_OTA_INBOUND_ROOM_COUNT,
	MAX_OTA_INBOUND_ROOM_NIGHT_SLOTS,
	normalizeRow,
	pick,
	n,
	countNumber,
	parseDate,
	parseMoney,
	toSarAmount,
	getSarExchangeRate,
	fetchWithHardTimeout,
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
	buildOtaCrossTransportIdentityKey,
	buildLegacyRedactedTripConflictLookup,
	buildOtaConfirmationLookup,
	validateReservationOtaIdentityConsistency,
	selectConsistentOtaIdentityCandidate,
	detectConfirmationMatchFields,
	detectProvider,
	parseSingleSenderMailbox,
	trustedProviderFromSenderAddress,
	evaluateTrustedSenderAuthentication,
	detectEventType,
	detectStatusToApply,
	detectReservationIntent,
	detectPaymentCollectionModel,
	resolveBookingSource,
	extractNormalizedReservation,
	reconcileOtaReservation,
	reconcileDirectHotelRunnerOwnedEmail,
	buildReservationDocument,
	resolvePaymentMapping,
	resolveHotel,
	resolveRoomMatch,
	resolveRoomMatchWithAi,
	resolveRoomDetails,
	requiredNewReservationMissing,
	canCreateUnmappedOtaReviewReservation,
	agodaMultiRoomAllocationReviewAllowsCommercialOnly,
	hasAmbiguousMultiRoomEvidence,
	buildUnmappedOtaReviewReservationDocument,
	applyExactResolvedHotelToUnmappedReview,
	buildExistingReservationUpdateSet,
	explicitRoomCapacity,
	roomCapacityFromLabels,
	findConfidentFuzzyHotelMatch,
	isAuthoritativeSourceUpgrade,
	buildHotelRunnerEmailCommercialEvidence,
	hotelRunnerEmailCommercialEvidenceHash,
	decimalMoneyCents,
	multipliedMoneyCents,
	verifiedHotelRunnerEmailCommercialEvidence,
	directHotelRunnerEmailCommercialGuard,
	directEmailRoomLabelMatchesProjectedSource,
	buildDirectHotelRunnerCommercialPricing,
	directHotelRunnerCommercialEnrichmentSet,
	lowerAuthorityOtaLifecycleMustYieldToHotelRunnerApi,
	canUseDirectAfterRelaySourceSkew,
	directAfterRelayInventoryConflict,
	directAfterRelayUnmappedReviewGuard,
	authoritativeExistingRefreshGuard,
	authoritativeExistingRefreshProtectedStateGuard,
	authoritativeMappedRefreshDocumentGuard,
	hasAnyOtaRoomConfiguration,
	hasCaptureOrSettlementActivity,
	unmappedRootMarginCommissionFieldsAreZero,
	isStaleOtaLifecycleEvent,
	cancellationManualReviewAllowsStatusOnly,
	resolvedIncomingHotelConflictsWithExisting,
	terminalLifecycleStayDatesConflict,
	wouldReopenTerminalOtaReservation,
	otaSourceAuthority,
	normalizeStatusToApply,
	calculateDaysOfResidence,
	generateDateRange,
	otaInboundAllocationSafety,
	findReservationByOtaConfirmation,
	detectConfirmationMatchFields,
	generateUniquePmsConfirmationNumber,
	getOtaInboundAllowedHotelIds,
	isHotelAllowedForOtaInbound,
	getManualOtaHotelAssignmentReason,
	isOtaInboundTotalOutlier,
	isPlausibleOtaGuestName,
	isPlausibleOtaRoomName,
	getSarConversionMeta,
};
