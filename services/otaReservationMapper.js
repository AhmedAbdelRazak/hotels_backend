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

dayjs.extend(customParseFormat);

const USD_TO_SAR = Number(
	process.env.OTA_USD_TO_SAR_RATE || process.env.USD_TO_SAR_RATE || 3.75
);

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
	airbnb: "Airbnb",
	hotelrunner: "HotelRunner",
	trip: "Trip.com",
	ota: "OTA Email",
};

function normalizeWhitespace(value) {
	return String(value || "")
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

function round2(value) {
	const parsed = Number(value || 0);
	return Number.isFinite(parsed) ? Number(parsed.toFixed(2)) : 0;
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
	let cleaned = raw
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

function parseMoney(value) {
	const source = normalizeWhitespace(value);
	if (!source) return { amount: 0, currency: "" };
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

function findFirstPattern(text, patterns) {
	for (const pattern of patterns) {
		const match = String(text || "").match(pattern);
		if (match && match[1]) return normalizeWhitespace(match[1]);
	}
	return "";
}

function cleanConfirmationCandidate(value) {
	const candidate = normalizeWhitespace(value);
	if (!candidate) return "";
	const match = candidate.match(/\b([A-Z0-9][A-Z0-9-]{4,})\b/i);
	return normalizeWhitespace(match?.[1] || candidate);
}

function findDateValue(text, labels, patterns = []) {
	const direct = parseDate(findField(text, labels));
	if (direct) return direct;
	return parseDate(findFirstPattern(text, patterns));
}

function findStandaloneHotelName(text) {
	const blocked = /(notice|reservation|confirmation|cancellation|cancelled|booking|guest|email|room|payment|billing|check[-\s]?in|check[-\s]?out|daily base|rate code|taxes|charges|amount|card|activation|expiration|validation|virtual card|logo|province|country|date|subject|from|to)/i;
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
		return line;
	}
	return "";
}

function detectProvider({ from = "", to = "", subject = "", text = "" } = {}) {
	const haystack = `${from} ${to} ${subject} ${text}`.toLowerCase();
	if (
		haystack.includes("expedia") ||
		haystack.includes("expediapartnercentral")
	) {
		return "expedia";
	}
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

function detectEventType({ subject = "", text = "" } = {}) {
	const haystack = `${subject} ${text}`.toLowerCase();
	const subjectOnly = String(subject || "").toLowerCase();
	if (/(cancelled|canceled|cancellation|cancelation)/i.test(haystack)) {
		return "cancelled";
	}
	if (/(modified|modification|changed|updated|amended|amendment)/i.test(haystack)) {
		return "modified";
	}
	if (/(no[- ]?show)/i.test(haystack)) return "no_show";
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

function detectStatusToApply({ subject = "", text = "" } = {}) {
	const haystack = `${subject} ${text}`.toLowerCase();
	if (/(cancelled|canceled|cancellation|cancelation)/i.test(haystack)) {
		return "cancelled";
	}
	if (/(no[- ]?show)/i.test(haystack)) return "no_show";
	if (/(checked\s*out|checkedout|early\s*checked\s*out)/i.test(haystack)) {
		return "checked_out";
	}
	if (/(in[\s-]?house|checked\s*in|check[\s-]?in\s+completed)/i.test(haystack)) {
		return "inhouse";
	}
	if (/(confirmed|confirmation|active)/i.test(haystack)) return "confirmed";
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
	const hasVirtualCard =
		/(virtual\s+card|\bvcc\b|card\s+number|validation\s+code|hotel\s+charges?\s+(?:the\s+)?virtual\s+card|charges?\s+(?:a\s+)?virtual\s+card)/i.test(
			haystack
		) || !!vcc.cardLast4;
	if (hasVirtualCard) return "virtual_card";
	if (
		/(hotel\s+collect|hotel\s+collects|pay\s+at\s+(?:the\s+)?property|pay\s+at\s+(?:the\s+)?hotel|pay\s+on\s+arrival|guest\s+pays|traveler\s+pays|collect\s+from\s+guest)/i.test(
			haystack
		)
	) {
		return "hotel_collect";
	}
	if (
		/(expedia\s+collect|agoda\s+collect|booking\.com\s+collect|ota\s+collect|ota\s+collects|collected\s+by|platform\s+collect|prepaid|paid\s+online)/i.test(
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

	const reservationId = cleanConfirmationCandidate(firstNonEmpty(
		findField(text, [
			"Reservation ID",
			"Reservation number",
			"Reservation No",
			"Confirmation number",
			"Confirmation #",
			"Confirmation code",
			"Booking ID",
			"Booking number",
			"Itinerary number",
		]),
		findFirstPattern(text, [
			/\bReservation\s*(?:ID|No\.?|Number|#)\s*[:#-]?\s*([A-Z0-9-]{5,})/i,
			/\bConfirmation\s*(?:Number|Code|#)?\s*[:#-]?\s*([A-Z0-9-]{5,})/i,
			/\bBooking\s*(?:ID|Number|#)\s*[:#-]?\s*([A-Z0-9-]{5,})/i,
		])
	));

	const hotelName = firstNonEmpty(
		findField(text, [
			"Property name",
			"Hotel name",
			"Property",
			"Accommodation",
			"Listing",
		]),
		findStandaloneHotelName(text)
	);
	const roomName = findField(text, [
		"Room type name",
		"Room name",
		"Room type code/name",
		"Room type/name",
		"Room type",
		"Room",
		"Unit type",
	]);
	const checkinDate = findDateValue(
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
	const checkoutDate = findDateValue(
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
	const bookedAt =
		parseDate(findField(text, ["Booked on", "Booking date", "Booked", "Created"])) ||
		dayjs().format("YYYY-MM-DD");

	const amountText = firstNonEmpty(
		findField(text, [
			"Booking amount",
			"Total booking amount",
			"Total amount",
			"Amount to charge",
			"Amount",
			"Total",
		]),
		findFirstPattern(text, [
			new RegExp(
				`\\b((?:${MONEY_CURRENCY_CODES.join("|")})\\s*[0-9][0-9,.]*)`,
				"i"
			),
			/(\$\s*[0-9][0-9,.]*)/,
		])
	);
	const parsedMoney = parseMoney(amountText);
	const amountCurrency =
		parsedMoney.currency ||
		(/\$\s*\d/.test(amountText) ? "USD" : process.env.OTA_DEFAULT_CURRENCY || "SAR");
	const conversion = getSarConversionMeta(parsedMoney.amount, amountCurrency);
	const adults = countNumber(
		findField(text, ["Adults", "Adult guests", "Adult"])
	);
	const children = countNumber(
		findField(text, [
			"Children",
			"Child guests",
			"Kids/Ages",
			"Kids Ages",
			"Kids",
			"Child",
		])
	);
	const totalGuests =
		countNumber(findField(text, ["Total guests", "Guest count", "Guests"])) ||
		adults + children ||
		1;
	const roomCount =
		countNumber(findField(text, ["Room count", "Number of rooms", "Rooms"])) || 1;
	const guestEmail = firstNonEmpty(
		findField(text, ["Guest email", "Email", "Guest e-mail"]),
		findFirstPattern(text, [/\b([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})\b/i])
	);
	const guestName = firstNonEmpty(
		findField(text, [
			"Guest name",
			"Primary guest",
			"Lead guest",
			"Customer name",
			"Guest",
		]),
		findFirstPattern(text, [/(?:^|\n)\s*Name\s*[:#-]\s*([^\n]{1,180})/i])
	);
	const nationality = findField(text, [
		"Nationality",
		"Guest nationality",
		"Country",
		"Guest country",
		"Residence country",
	]);
	const guestPhone = findField(text, [
		"Guest phone",
		"Phone",
		"Telephone",
		"Mobile",
	]);

	const paymentInstructionField = findField(text, [
		"Payment instructions",
		"Payment model",
		"Payment type",
		"Payment",
	]);
	const paymentText = `${paymentInstructionField} ${text}`.toLowerCase();

	const activationDate = parseDate(
		findField(text, ["Activation date", "Card activation date"])
	);
	const expirationDate = parseDate(
		findField(text, ["Expiration date", "Expiry date", "Card expiration date"])
	);
	const amountToCharge = parseMoney(
		findField(text, ["Amount to charge", "Charge amount", "VCC amount"])
	);
	const cardLast4 = extractCardLast4(text);
	const amountToChargeCurrency = amountToCharge.currency || amountCurrency;
	const amountToChargeSar = amountToCharge.amount
		? toSarAmount(amountToCharge.amount, amountToChargeCurrency)
		: 0;
	const paymentCollectionModel = detectPaymentCollectionModel(paymentText, {
		cardLast4,
	});
	const paidOnline = paymentCollectionModel === "ota_collect";

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
	if (!hotelName) warnings.push("Missing hotel/property name.");
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
		hotelName,
		roomName,
		checkinDate,
		checkoutDate,
		bookedAt,
		amount: parsedMoney.amount,
		currency: amountCurrency,
		totalAmountSar: conversion.totalAmountSar,
		exchangeRateToSar: conversion.exchangeRateToSar,
		exchangeRateSource: conversion.exchangeRateSource,
		amountConvertedAt: conversion.convertedAt,
		adults,
		children,
		totalGuests,
		roomCount,
		guestName,
		guestEmail,
		guestPhone,
		nationality,
		paidOnline,
		paymentCollectionModel,
		paymentInstructions: safeSnippet(
			paymentInstructionField || paymentCollectionModel,
			500
		),
		vcc: {
			cardLast4,
			amountToCharge: amountToCharge.amount,
			amountToChargeCurrency,
			amountToChargeSar,
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

function mapRoomType(roomNameRaw) {
	if (!roomNameRaw) return null;
	const s = normalizeComparable(roomNameRaw);
	const hasKeyword = (keyword) =>
		s.split(" ").some(
			(word) =>
				word === keyword ||
				word.includes(keyword) ||
				(word.length >= 4 && keyword.includes(word)) ||
				bigramSimilarity(word, keyword) >= 0.6
		);
	if (hasKeyword("master") && hasKeyword("suite")) return "masterSuite";
	if (hasKeyword("quadruple") || hasKeyword("quad")) return "quadRooms";
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
		const labelVariants = comparableVariants(label);
		const roomVariants = comparableVariants(roomName);
		let score = 0;
		for (const left of roomVariants) {
			for (const right of labelVariants) {
				score = Math.max(score, tokenSimilarity(left, right));
			}
		}
		return Math.max(best, score);
	}, 0);
	const typeMatches = !!mappedRoomType && room.roomType === mappedRoomType;
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

function resolveRoomMatch(hotelDetails, roomName, options = {}) {
	const rooms = (hotelDetails?.roomCountDetails || []).filter(
		(room) => room && room.roomType
	);
	const mappedRoomType = mapRoomType(roomName);
	if (!rooms.length || !normalizeWhitespace(roomName)) {
		return {
			roomDetails: null,
			score: 0,
			warnings: ["Room type/name is missing or this hotel has no room details."],
		};
	}

	const candidates = rooms
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
	if (best.matchType === "room_type" && best.displayScore < 0.35) {
		warnings.push(
			`Room "${roomName}" was matched by room type to "${best.room.displayName || best.room.roomType}".`
		);
	}
	if (
		second &&
		best.room.roomType === second.room.roomType &&
		Math.abs(best.score - second.score) <= 0.03
	) {
		warnings.push(
			`Multiple ${best.room.roomType} room displays were close matches; selected "${best.room.displayName || best.room.roomType}".`
		);
	}

	return {
		roomDetails: best.room,
		score: best.score,
		displayScore: best.displayScore,
		matchType: best.matchType,
		threshold: 0.75,
		mappedRoomType,
		warnings,
	};
}

function resolveRoomDetails(hotelDetails, roomName) {
	return resolveRoomMatch(hotelDetails, roomName).roomDetails;
}

function resolveRootPriceForDate(roomDetails, ymd) {
	const pricingRate = (roomDetails.pricingRate || []).find(
		(rate) => dayjs(rate.calendarDate).format("YYYY-MM-DD") === ymd
	);
	if (pricingRate) return n(pricingRate.rootPrice || pricingRate.price);
	if (roomDetails.defaultCost) return n(roomDetails.defaultCost);
	if (roomDetails.price?.basePrice) return n(roomDetails.price.basePrice);
	return 0;
}

function buildPickedRoomsType({ roomDetails, normalized }) {
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
	let slotIndex = 0;
	let sumRootPriceAllRooms = 0;
	let sumTotalPriceAllRooms = 0;

	const pickedRoomsType = Array.from({ length: roomCount }, () => {
		const pricingByDay = dateRange.map((ymd) => {
			const finalPrice = round2(slotPrices[slotIndex] || 0);
			slotIndex += 1;
			const configuredRootPrice = round2(resolveRootPriceForDate(roomDetails, ymd));
			const rootPrice = configuredRootPrice > 0 ? configuredRootPrice : finalPrice;
			const commissionAmount = Math.max(0, round2(finalPrice - rootPrice));
			const commissionRate =
				rootPrice > 0 && commissionAmount > 0
					? round2((commissionAmount / rootPrice) * 100)
					: 0;

			sumRootPriceAllRooms = round2(sumRootPriceAllRooms + rootPrice);
			sumTotalPriceAllRooms = round2(sumTotalPriceAllRooms + finalPrice);

			return {
				date: ymd,
				price: finalPrice,
				rootPrice,
				commissionRate,
				totalPriceWithCommission: finalPrice,
				totalPriceWithoutCommission: rootPrice,
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
			chosenPrice: round2(roomTotal / daysOfResidence),
			count: 1,
			pricingByDay,
			totalPriceWithCommission: roomTotal,
			hotelShouldGet: roomRoot,
		};
	});

	const subTotalSar = round2(
		Math.min(sumRootPriceAllRooms, sumTotalPriceAllRooms || totalAmountSar)
	);
	const commissionAmountSar = Math.max(
		0,
		round2(sumTotalPriceAllRooms - subTotalSar)
	);

	return {
		ok: true,
		pickedRoomsType,
		roomCount,
		daysOfResidence,
		sumRootPriceAllRooms: round2(sumRootPriceAllRooms),
		subTotalSar,
		sumTotalPriceAllRooms: round2(sumTotalPriceAllRooms),
		commissionAmountSar,
	};
}

function buildReservationDocument(normalized, hotelDetails) {
	if (!hotelDetails) return { ok: false, error: "Hotel could not be resolved." };
	const roomMatch = resolveRoomMatch(hotelDetails, normalized.roomName);
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

	const pricing = buildPickedRoomsType({ roomDetails, normalized });
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

	return {
		ok: true,
		warnings: normalized.warnings || [],
		document: {
			reservation_id: normalized.reservationId,
			confirmation_number: normalized.confirmationNumber,
			booking_source: providerLabel,
			customer_details: {
				name: normalized.guestName || "",
				phone: normalized.guestPhone || "0000",
				email: normalized.guestEmail || "no-email@jannatbooking.com",
				passport: "Not Provided",
				passportExpiry: "1/1/2027",
				nationality: normalized.nationality || "",
				postalCode: "00000",
				confirmation_number2: normalized.confirmationNumber,
			},
			state: isCancelled ? "cancelled" : "confirmed",
			reservation_status: isCancelled ? "cancelled" : "confirmed",
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
			comment: "",
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
			hotelId: hotelDetails._id,
			belongsTo: hotelDetails.belongsTo,
			supplierData: {
				supplierName: providerLabel,
				suppliedBookingNo: normalized.reservationId,
				otaConfirmationNumber: normalized.confirmationNumber,
				platformConfirmationNumber: normalized.confirmationNumber,
				otaAutomationPipeline: "ota-email-orchestrator",
				otaProvider: normalized.provider,
				otaHotelName: normalized.hotelName || "",
				otaRoomName: normalized.roomName || "",
				otaMatchedRoomName: roomDetails.displayName || "",
				otaRoomMatchScore: roomMatch.score || 0,
				otaRoomMatchType: roomMatch.matchType || "",
				otaCurrency: normalized.currency || "",
				otaAmount: normalized.amount || 0,
				otaAmountSar: totalAmountSar,
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

function buildAuditEntry(normalized, action, warnings = []) {
	return {
		at: new Date(),
		source: "ota-email",
		action,
		provider: normalized.provider,
		eventType: normalized.eventType,
		reservationId: normalized.reservationId,
		messageId: normalized.source?.messageId || "",
		subject: normalized.source?.subject || "",
		warnings,
	};
}

async function resolveHotel(normalized, existingReservation = null) {
	if (existingReservation?.hotelId) {
		return HotelDetails.findById(existingReservation.hotelId)
			.select("_id hotelName hotelName_OtherLanguage belongsTo roomCountDetails currency")
			.lean();
	}

	const directHotelId = normalized.hotelId;
	if (directHotelId) {
		const direct = await HotelDetails.findById(directHotelId)
			.select("_id hotelName hotelName_OtherLanguage belongsTo roomCountDetails currency")
			.lean();
		if (direct) return direct;
	}

	const wanted = normalizeComparable(normalized.hotelName);
	const hotelNameCandidates = Array.from(
		new Set(
			[
				normalized.hotelName,
				...(Array.isArray(normalized.hotelNameAliases)
					? normalized.hotelNameAliases
					: []),
			]
				.map((item) => normalizeWhitespace(item))
				.filter(Boolean)
		)
	);
	if (!wanted || !hotelNameCandidates.length) return null;

	const selectFields =
		"_id hotelName hotelName_OtherLanguage belongsTo roomCountDetails currency";
	const scoreHotels = (hotels = []) => {
		let best = null;
		let bestScore = 0;
		for (const hotel of hotels) {
			const names = [hotel.hotelName, hotel.hotelName_OtherLanguage].filter(Boolean);
			for (const name of names) {
				const score = hotelNameCandidates.reduce(
					(max, candidateName) =>
						Math.max(max, Math.round(hotelNameSimilarity(candidateName, name) * 100)),
					0
				);
				if (score > bestScore) {
					best = hotel;
					bestScore = score;
				}
			}
		}
		return { best, bestScore };
	};

	const allowedIds = getOtaInboundAllowedHotelIds();
	if (allowedIds.length) {
		const allowedHotels = await HotelDetails.find({ _id: { $in: allowedIds } })
			.select(selectFields)
			.lean();
		const allowedMatch = scoreHotels(allowedHotels);
		if (allowedMatch.bestScore >= 72) return allowedMatch.best;
	}

	const hotels = await HotelDetails.find({})
		.select(selectFields)
		.lean();
	const { best, bestScore } = scoreHotels(hotels);

	return bestScore >= 72 ? best : null;
}

function applyVccSafeFields(target, normalized) {
	const vcc = normalized.vcc || {};
	if (vcc.cardLast4) {
		target["vcc_payment.source"] = normalized.provider;
		target["vcc_payment.metadata.card_last4"] = vcc.cardLast4;
	}
	if (vcc.amountToCharge) {
		target["vcc_payment.metadata.amount_to_charge"] = vcc.amountToCharge;
	}
	if (vcc.amountToChargeCurrency) {
		target["vcc_payment.metadata.amount_to_charge_currency"] =
			vcc.amountToChargeCurrency;
	}
	if (vcc.amountToChargeSar) {
		target["vcc_payment.metadata.amount_to_charge_sar"] =
			vcc.amountToChargeSar;
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
	if (
		!vcc.cardLast4 &&
		!vcc.amountToCharge &&
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
	if (vcc.amountToCharge) {
		document.vcc_payment.metadata.amount_to_charge = vcc.amountToCharge;
	}
	if (vcc.amountToChargeCurrency) {
		document.vcc_payment.metadata.amount_to_charge_currency =
			vcc.amountToChargeCurrency;
	}
	if (vcc.amountToChargeSar) {
		document.vcc_payment.metadata.amount_to_charge_sar =
			vcc.amountToChargeSar;
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

function requiredNewReservationMissing(normalized = {}) {
	const missing = [];
	if (!normalized.confirmationNumber) missing.push("confirmation number");
	if (!normalized.guestName) missing.push("guest name");
	if (!normalized.checkinDate) missing.push("check-in date");
	if (!normalized.checkoutDate) missing.push("check-out date");
	if (!normalized.hotelName) missing.push("hotel name");
	return missing;
}

async function applyLiveSarConversion(normalized = {}) {
	const next = {
		...normalized,
		warnings: [...(normalized.warnings || [])],
		errors: [...(normalized.errors || [])],
	};
	const amount = Number(next.amount || 0);
	if (!amount) return next;

	const conversion = await getSarConversionMetaAsync(amount, next.currency || "SAR");
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

	const vcc = { ...(next.vcc || {}) };
	if (Number(vcc.amountToCharge || 0) && vcc.amountToChargeCurrency) {
		const vccConversion = await getSarConversionMetaAsync(
			vcc.amountToCharge,
			vcc.amountToChargeCurrency
		);
		vcc.amountToChargeSar = vccConversion.totalAmountSar;
		vcc.amountToChargeExchangeRateToSar = vccConversion.exchangeRateToSar;
		vcc.amountToChargeExchangeRateSource = vccConversion.exchangeRateSource;
		next.vcc = vcc;
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

function buildHotelNotAllowedResult(normalized, hotelId, warnings, errors) {
	const allowedIds = getOtaInboundAllowedHotelIds();
	return {
		status: "needs_review",
		actionTaken: "skipped",
		skipReason: "hotel_not_allowed_for_ota_inbound",
		automationComment:
			"Resolved hotel is not included in OTA_INBOUND_EMAIL_HOTEL_IDS; email was saved for audit only and no reservation was connected.",
		warnings,
		errors: [
			...errors,
			`Resolved hotel is not included in OTA_INBOUND_EMAIL_HOTEL_IDS; no reservation was created or updated.`,
		],
		hotelId: null,
		reservationId: null,
		pmsConfirmationNumber: "",
		matchedReservationBy: [],
		disallowedHotelId: normalizeId(hotelId),
		allowedHotelIds: allowedIds,
		hotelName: normalized.hotelName || "",
	};
}

function confirmationLookupValues(value) {
	const raw = normalizeWhitespace(value);
	const normalized = normalizeConfirmation(value);
	return Array.from(new Set([raw, normalized, raw.toUpperCase()].filter(Boolean)));
}

function buildOtaConfirmationLookup(confirmationNumber) {
	const values = confirmationLookupValues(confirmationNumber);
	if (!values.length) return null;
	const allValues = Array.from(
		new Set(
			values
				.flatMap((item) => [item, item.toLowerCase(), item.toUpperCase()])
				.filter(Boolean)
		)
	);
	return {
		$or: [
			{ confirmation_number: { $in: allValues } },
			{ reservation_id: { $in: allValues } },
			{ "customer_details.confirmation_number2": { $in: allValues } },
			{ "supplierData.suppliedBookingNo": { $in: allValues } },
			{ "supplierData.otaConfirmationNumber": { $in: allValues } },
			{ "supplierData.platformConfirmationNumber": { $in: allValues } },
		],
	};
}

async function findReservationByOtaConfirmation(confirmationNumber, projection = "") {
	const query = buildOtaConfirmationLookup(confirmationNumber);
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

function detectConfirmationMatchFields(reservation, confirmationNumber) {
	if (!reservation || !confirmationNumber) return [];
	const fields = [
		["confirmation_number", reservation.confirmation_number],
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

async function reconcileOtaReservation(inputNormalized) {
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
		logReconcile("needs_review.missing_currency_rate", {
			confirmationNumber,
			currency: normalized.currency || "",
		});
		return {
			status: "needs_review",
			warnings,
			errors,
		};
	}

	const existing = await findReservationByOtaConfirmation(confirmationNumber);
	const matchedReservationBy = existing
		? detectConfirmationMatchFields(existing, confirmationNumber)
		: [];
	logReconcile("existing.checked", {
		platformConfirmationNumber: confirmationNumber,
		found: !!existing,
		reservationId: existing?._id ? String(existing._id) : "",
		pmsConfirmationNumber: existing?.confirmation_number || "",
		hotelId: existing?.hotelId ? String(existing.hotelId) : "",
		matchedReservationBy,
	});

	if (existing?.hotelId && !isHotelAllowedForOtaInbound(existing.hotelId)) {
		logReconcile("skipped.hotel_not_allowed_existing", {
			confirmationNumber,
			disallowedHotelId: normalizeId(existing.hotelId),
			allowedHotelIds: getOtaInboundAllowedHotelIds(),
		});
		return buildHotelNotAllowedResult(
			normalized,
			existing.hotelId,
			warnings,
			errors
		);
	}

	if (isStatusIntent) {
		if (!existing) {
			logReconcile("status.needs_review.no_exact_match", {
				confirmationNumber,
				statusToApply,
			});
			return {
				status: "needs_review",
				warnings,
				errors: [
					...errors,
					"Status email did not match an existing reservation by confirmation number.",
				],
			};
		}
		if (!statusToApply) {
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
		logReconcile("status.update.start", {
			confirmationNumber,
			reservationId: String(existing._id),
			statusToApply,
		});
		const set = {
			reservation_status: statusToApply,
			"customer_details.confirmation_number2": confirmationNumber,
			"supplierData.suppliedBookingNo": confirmationNumber,
			"supplierData.otaConfirmationNumber": confirmationNumber,
			"supplierData.platformConfirmationNumber": confirmationNumber,
			"supplierData.otaLastInboundEmailId": normalized.inboundEmailId || "",
			"supplierData.otaLastEmailAt": new Date(),
			"supplierData.otaLastEventType": normalized.eventType,
		};
		if (["cancelled", "no_show"].includes(statusToApply)) {
			set.cancel_reason = `${normalized.providerLabel || "OTA"} status email`;
		}
		applyVccSafeFields(set, normalized);
		await Reservations.updateOne(
			{ _id: existing._id },
			{
				$set: set,
				$push: {
					reservationAuditLog: buildAuditEntry(
						normalized,
						`${statusToApply}-from-email`,
						warnings
					),
				},
			}
		);
		logReconcile("status.update.done", {
			confirmationNumber,
			reservationId: String(existing._id),
			statusToApply,
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

	if (isUpdateIntent && !existing) {
		logReconcile("update.needs_review.no_exact_match", {
			confirmationNumber,
		});
		return {
			status: "needs_review",
			warnings,
			errors: [
				...errors,
				"Update email did not match an existing reservation by confirmation number.",
			],
		};
	}

	if (!isUpdateIntent && existing) {
		logReconcile("duplicate_reservation", {
			confirmationNumber,
			reservationId: String(existing._id),
		});
		return {
			status: "duplicate_reservation",
			warnings,
			errors: [
				...errors,
				"Existing reservation matched by confirmation number; no new reservation was created.",
			],
			reservationId: existing._id,
			hotelId: existing.hotelId,
			pmsConfirmationNumber: existing.confirmation_number,
			matchedReservationBy,
		};
	}

	const missing = requiredNewReservationMissing(normalized);
	if (!isUpdateIntent && missing.length) {
		logReconcile("needs_review.missing_required_fields", {
			confirmationNumber,
			missing,
		});
		return {
			status: "needs_review",
			warnings,
			errors: [
				...errors,
				`Missing required reservation field(s): ${missing.join(", ")}.`,
			],
		};
	}

	const hotelDetails = await resolveHotel(normalized, existing);
	if (!hotelDetails) {
		logReconcile("needs_mapping.hotel", {
			confirmationNumber,
			hotelName: normalized.hotelName || "",
		});
		return {
			status: "needs_mapping",
			warnings,
			errors: [...errors, "Could not resolve hotel from inbound email."],
		};
	}
	if (!isHotelAllowedForOtaInbound(hotelDetails._id)) {
		logReconcile("skipped.hotel_not_allowed", {
			confirmationNumber,
			disallowedHotelId: normalizeId(hotelDetails._id),
			hotelName: hotelDetails.hotelName || normalized.hotelName || "",
			allowedHotelIds: getOtaInboundAllowedHotelIds(),
		});
		return buildHotelNotAllowedResult(
			normalized,
			hotelDetails._id,
			warnings,
			errors
		);
	}

	const built = buildReservationDocument(normalized, hotelDetails);
	if (!built.ok) {
		logReconcile("needs_mapping.room_or_pricing", {
			confirmationNumber,
			hotelId: String(hotelDetails._id),
			roomName: normalized.roomName || "",
			error: built.error,
		});
		return {
			status: "needs_mapping",
			warnings,
			errors: [...errors, built.error],
			hotelId: hotelDetails._id,
		};
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
		return {
			status: "needs_mapping",
			warnings,
			errors: [...errors, error.message || "Could not calculate reservation pricing."],
			hotelId: hotelDetails._id,
		};
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
		const set = compactUpdate(document);
		applyVccSafeFields(set, normalized);
		await Reservations.updateOne(
			{ _id: existing._id },
			{
				$set: set,
				$push: {
					reservationAuditLog: buildAuditEntry(
						normalized,
						"updated-from-email",
						warnings
					),
				},
			}
		);
		logReconcile("update.done", {
			confirmationNumber,
			reservationId: String(existing._id),
			hotelId: String(hotelDetails._id),
		});
		return {
			status: "updated",
			warnings,
			errors,
			reservationId: existing._id,
			hotelId: hotelDetails._id,
			pmsConfirmationNumber: existing.confirmation_number,
			matchedReservationBy,
		};
	}

	const existingBeforeCreate = await findReservationByOtaConfirmation(
		confirmationNumber,
		"_id hotelId confirmation_number reservation_id customer_details supplierData"
	);
	if (existingBeforeCreate) {
		const lateMatchedBy = detectConfirmationMatchFields(
			existingBeforeCreate,
			confirmationNumber
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
		buildAuditEntry(normalized, "created-from-email", warnings),
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
		otaCreatedFromEmail: true,
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
			created = await Reservations.create(document);
			break;
		} catch (error) {
			if (error?.code === 11000) {
				logReconcile("create.duplicate_key", {
					platformConfirmationNumber: confirmationNumber,
					pmsConfirmationNumber: document.confirmation_number,
				});
				const duplicate = await findReservationByOtaConfirmation(
					confirmationNumber,
					"_id hotelId confirmation_number"
				);
				if (duplicate) {
					const duplicateMatchedBy = detectConfirmationMatchFields(
						duplicate,
						confirmationNumber
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
		matchedReservationBy: [],
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
	normalizeConfirmation,
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
	resolveRoomDetails,
	requiredNewReservationMissing,
	normalizeStatusToApply,
	calculateDaysOfResidence,
	generateDateRange,
	findReservationByOtaConfirmation,
	detectConfirmationMatchFields,
	generateUniquePmsConfirmationNumber,
	getOtaInboundAllowedHotelIds,
	isHotelAllowedForOtaInbound,
};
