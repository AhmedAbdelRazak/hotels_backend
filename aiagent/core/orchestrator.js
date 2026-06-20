// aiagent/core/orchestrator.js
const {
	getSupportCaseById,
	updateSupportCaseAppend,
	getHotelById,
	getReservationByConfirmation,
	listActivePublicHotels,
	listPreviousGuestSupportChats,
	listRelevantTrainingChats,
} = require("./db");
const { ensureAIAllowed } = require("./policy");

const {
	listAvailableRoomsForStay,
	roomHasAmenity,
	hotelHasAmenity,
	findAmenityMatch,
} = require("./selectors");

const {
	nluStep,
	firstNameOf,
	validateNationalityLLM,
	normalizeNameLLM,
	mapRoomToKey,
	quickDateRange,
	asciiize,
	digitsToEnglish,
	detectAmenityQuestion,
} = require("./nlu");

const { chat } = require("./openai");
const {
	createReservationForCase,
	updateReservationDatesForCase,
	getReservationCancellationPolicyForCase,
} = require("./actions");
const {
	isJannatBookingSupportCase,
} = require("../../services/jannatBookingSupportScope");
const {
	waNotifyImmediateSupportEscalation,
} = require("../../controllers/whatsappsender");

const DEFAULT_AGENT_POOL = ["Hana", "Aisha", "Sara", "Amira", "Yasmin", "Nadia"];
const AI_SUPPORT_EMAIL = "support@jannatbooking.com";
const LEGACY_AI_SUPPORT_EMAIL = "management@xhotelpro.com";

function intFromEnv(name, fallback, { min = 0, max = 60000 } = {}) {
	const parsed = parseInt(process.env[name] || "", 10);
	const value = Number.isFinite(parsed) ? parsed : fallback;
	return Math.min(max, Math.max(min, value));
}

function boolFromEnv(name, fallback = false) {
	const raw = String(process.env[name] || "").trim().toLowerCase();
	if (!raw) return fallback;
	return ["1", "true", "yes", "on"].includes(raw);
}

const HUMAN_THINK_MIN_MS = intFromEnv("AI_HUMAN_THINK_MIN_MS", 900, {
	min: 0,
	max: 5000,
});
const HUMAN_THINK_MAX_MS = Math.max(
	HUMAN_THINK_MIN_MS,
	intFromEnv("AI_HUMAN_THINK_MAX_MS", 1400, { min: 0, max: 5000 })
);
const HUMAN_TYPE_CHAR_MIN_MS = intFromEnv("AI_HUMAN_TYPE_CHAR_MIN_MS", 2, {
	min: 1,
	max: 300,
});
const HUMAN_TYPE_CHAR_MAX_MS = Math.max(
	HUMAN_TYPE_CHAR_MIN_MS,
	intFromEnv("AI_HUMAN_TYPE_CHAR_MAX_MS", 5, { min: 1, max: 300 })
);
const HUMAN_TYPE_CLAMP_MIN_MS = intFromEnv("AI_HUMAN_TYPE_CLAMP_MIN_MS", 1700, {
	min: 250,
	max: 10000,
});
const HUMAN_TYPE_CLAMP_MAX_MS = Math.max(
	HUMAN_TYPE_CLAMP_MIN_MS,
	intFromEnv("AI_HUMAN_TYPE_CLAMP_MAX_MS", 3200, { min: 250, max: 15000 })
);
const HUMAN_BETWEEN_SENDS_MIN_MS = intFromEnv(
	"AI_HUMAN_BETWEEN_SENDS_MIN_MS",
	150,
	{ min: 0, max: 10000 }
);
const HUMAN_BETWEEN_SENDS_MAX_MS = Math.max(
	HUMAN_BETWEEN_SENDS_MIN_MS,
	intFromEnv("AI_HUMAN_BETWEEN_SENDS_MAX_MS", 350, {
		min: 0,
		max: 10000,
	})
);

const HUMAN = {
	greetThinkMs: intFromEnv("AI_HUMAN_GREET_THINK_MS", 1400, {
		min: 0,
		max: 7000,
	}),
	thinkMinMs: HUMAN_THINK_MIN_MS,
	thinkMaxMs: HUMAN_THINK_MAX_MS,
	typeCharMinMs: HUMAN_TYPE_CHAR_MIN_MS,
	typeCharMaxMs: HUMAN_TYPE_CHAR_MAX_MS,
	typeClampMinMs: HUMAN_TYPE_CLAMP_MIN_MS,
	typeClampMaxMs: HUMAN_TYPE_CLAMP_MAX_MS,
	betweenSendsMinMs: HUMAN_BETWEEN_SENDS_MIN_MS,
	betweenSendsMaxMs: HUMAN_BETWEEN_SENDS_MAX_MS,
};
const AI_REPLY_TARGET_MIN_MS = intFromEnv("AI_REPLY_TARGET_MIN_MS", 3200, {
	min: 500,
	max: 15000,
});
const AI_REPLY_TARGET_MAX_MS = Math.max(
	AI_REPLY_TARGET_MIN_MS,
	intFromEnv("AI_REPLY_TARGET_MAX_MS", 4800, {
		min: 500,
		max: 15000,
	})
);
const JANNAT_HANDOFF_DELAY_MIN_MS = intFromEnv(
	"AI_JANNAT_HANDOFF_DELAY_MIN_MS",
	5000,
	{ min: 0, max: 20000 }
);
const JANNAT_HANDOFF_DELAY_MAX_MS = Math.max(
	JANNAT_HANDOFF_DELAY_MIN_MS,
	intFromEnv("AI_JANNAT_HANDOFF_DELAY_MAX_MS", 8000, {
		min: 0,
		max: 20000,
	})
);

const SOFT_PIVOT_MS = 35000;
const QUOTE_SUMMARY_COOLDOWN = 45000;
const PUBLIC_DISCOUNT_PERCENT = 15;
const QUOTE_WRITE_SOFT_TIMEOUT_MS = intFromEnv(
	"AI_QUOTE_WRITE_SOFT_TIMEOUT_MS",
	1800,
	{ min: 500, max: 5000 }
);
const AI_REQUIRE_NATIONALITY = boolFromEnv("AI_REQUIRE_NATIONALITY", true);
const AI_INSTANT_PROGRESS_ENABLED = boolFromEnv(
	"AI_INSTANT_PROGRESS_ENABLED",
	false
);

function randomBetween(a, b) {
	return Math.floor(a + Math.random() * (b - a + 1));
}
function now() {
	return Date.now();
}
function toTitle(s = "") {
	return String(s || "").replace(
		/\w\S*/g,
		(m) => m[0].toUpperCase() + m.slice(1)
	);
}
function uniqueAgentNames(names = []) {
	return [
		...new Set(
			names
				.map((name) => String(name || "").trim().replace(/\s+/g, " "))
				.filter(Boolean)
		),
	];
}
function configuredAgentPool() {
	const configured = uniqueAgentNames(
		[process.env.B2C_AI_RESPONDER_NAMES, process.env.AI_RESPONDER_NAMES]
			.flatMap((value) => String(value || "").split(","))
	);
	return configured.length >= 2 ? configured : DEFAULT_AGENT_POOL;
}
function usDate(iso) {
	if (!iso) return "";
	const d = new Date(iso + "T00:00:00");
	return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(
		d.getDate()
	).padStart(2, "0")}/${d.getFullYear()}`;
}
function stayDateDisplay(st = {}) {
	const raw = st.dateRaw || {};
	const gregorian = {
		checkinISO: st.slots?.checkinISO || null,
		checkoutISO: st.slots?.checkoutISO || null,
		checkin: usDate(st.slots?.checkinISO),
		checkout: usDate(st.slots?.checkoutISO),
	};
	const hijri =
		String(raw.calendar || "").toLowerCase() === "hijri"
			? {
					checkin: raw.checkin || "",
					checkout: raw.checkout || "",
					checkinHijri: raw.checkinHijri || null,
					checkoutHijri: raw.checkoutHijri || null,
			  }
			: null;
	return {
		calendarProvided: raw.calendar || null,
		gregorian,
		hijri,
		shouldShowBoth: Boolean(hijri),
	};
}
const ARABIC_HIJRI_MONTHS = [
	"\u0645\u062d\u0631\u0645",
	"\u0635\u0641\u0631",
	"\u0631\u0628\u064a\u0639 \u0627\u0644\u0623\u0648\u0644",
	"\u0631\u0628\u064a\u0639 \u0627\u0644\u0622\u062e\u0631",
	"\u062c\u0645\u0627\u062f\u0649 \u0627\u0644\u0623\u0648\u0644\u0649",
	"\u062c\u0645\u0627\u062f\u0649 \u0627\u0644\u0622\u062e\u0631\u0629",
	"\u0631\u062c\u0628",
	"\u0634\u0639\u0628\u0627\u0646",
	"\u0631\u0645\u0636\u0627\u0646",
	"\u0634\u0648\u0627\u0644",
	"\u0630\u0648 \u0627\u0644\u0642\u0639\u062f\u0629",
	"\u0630\u0648 \u0627\u0644\u062d\u062c\u0629",
];

function hasArabicScript(value = "") {
	return /[\u0600-\u06FF]/.test(String(value || ""));
}

function arabicDigits(value = "") {
	return String(value ?? "").replace(/\d/g, (digit) =>
		String.fromCharCode(0x0660 + Number(digit))
	);
}

function localizedHotelName(sc = {}, st = {}) {
	const lang = languageOf(sc, st);
	const other = String(st.hotel?.hotelName_OtherLanguage || "").trim();
	if (/arabic/i.test(lang) && other && hasArabicScript(other)) return other;
	return toTitle(st.hotel?.hotelName || sc.displayName2 || "Hotel");
}

function localizedRoomName(sc = {}, st = {}, quote = {}) {
	const lang = languageOf(sc, st);
	const room = quote?.room || {};
	const other = String(room.displayName_OtherLanguage || "").trim();
	if (/arabic/i.test(lang) && other && hasArabicScript(other)) return other;
	return room.displayName || room.roomType || roomTypeLabel(st.slots?.roomTypeKey);
}

function localizedCurrencyLabel(currency = "SAR", lang = "English") {
	const code = cleanCurrency(currency || "SAR");
	if (/arabic/i.test(lang) && code === "SAR") {
		return "\u0631\u064a\u0627\u0644 \u0633\u0639\u0648\u062f\u064a";
	}
	return code;
}

function localizedNumber(value, lang = "English") {
	const raw =
		typeof value === "number" && Number.isFinite(value)
			? Number.isInteger(value)
				? String(value)
				: String(Number(value.toFixed(2)))
			: String(value ?? "");
	return /arabic/i.test(lang) ? arabicDigits(raw) : raw;
}

function localizedMoney(value, currency = "SAR", lang = "English") {
	const amount = localizedNumber(value, lang);
	const label = localizedCurrencyLabel(currency, lang);
	return [amount, label].filter(Boolean).join(" ");
}

function arabicHijriDate(parts = null, fallback = "") {
	const month = Number(parts?.month || 0);
	const day = Number(parts?.day || 0);
	const year = Number(parts?.year || 0);
	if (month >= 1 && month <= 12 && day && year) {
		return `${arabicDigits(day)} ${ARABIC_HIJRI_MONTHS[month - 1]} ${arabicDigits(
			year
		)}\u0647\u0640`;
	}
	return arabicDigits(fallback || "");
}

function localizedGregorianDate(iso = "", lang = "English") {
	if (!iso) return "";
	if (!/arabic/i.test(lang)) return usDate(iso);
	try {
		return new Intl.DateTimeFormat("ar-EG-u-nu-arab", {
			timeZone: "UTC",
			day: "numeric",
			month: "long",
			year: "numeric",
		}).format(new Date(`${iso}T12:00:00Z`));
	} catch {
		return arabicDigits(usDate(iso));
	}
}

function localizedStayDateLines(sc = {}, st = {}) {
	const lang = languageOf(sc, st);
	const display = stayDateDisplay(st);
	const gregorianLine = `${localizedGregorianDate(
		st.slots?.checkinISO,
		lang
	)} \u2013 ${localizedGregorianDate(st.slots?.checkoutISO, lang)}`;
	if (!/arabic/i.test(lang)) {
		if (display.hijri?.checkin && display.hijri?.checkout) {
			return {
				primary: `${display.hijri.checkin} to ${display.hijri.checkout}`,
				secondary: `Gregorian: ${gregorianLine}`,
			};
		}
		return { primary: gregorianLine, secondary: "" };
	}
	if (display.hijri?.checkin || display.hijri?.checkinHijri) {
		return {
			primary: `${arabicHijriDate(
				display.hijri.checkinHijri,
				display.hijri.checkin
			)} \u2013 ${arabicHijriDate(
				display.hijri.checkoutHijri,
				display.hijri.checkout
			)}`,
			secondary: `\u0627\u0644\u0645\u064a\u0644\u0627\u062f\u064a: ${gregorianLine}`,
		};
	}
	return { primary: gregorianLine, secondary: "" };
}
function slugifyHotelName(name = "") {
	return String(name || "")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9\s-]/g, "")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-");
}
function publicHotelUrl(hotelName = "") {
	return `https://jannatbooking.com/single-hotel/${slugifyHotelName(hotelName)}`;
}
function firstNumber(value) {
	const match = String(value || "").match(/\d+/);
	return match ? Number(match[0]) : Number.POSITIVE_INFINITY;
}
function languageOf(sc = {}, st = {}) {
	return st.language || preferredLanguageOf(sc) || "English";
}
function preferredLanguageOf(sc = {}) {
	const conversation = Array.isArray(sc.conversation) ? sc.conversation : [];
	for (let i = conversation.length - 1; i >= 0; i -= 1) {
		const language = String(conversation[i]?.preferredLanguage || "").trim();
		if (language) return language;
	}
	return String(sc.preferredLanguage || "").trim();
}
function preferredLanguageCodeOf(sc = {}) {
	const conversation = Array.isArray(sc.conversation) ? sc.conversation : [];
	for (let i = conversation.length - 1; i >= 0; i -= 1) {
		const languageCode = String(
			conversation[i]?.preferredLanguageCode || ""
		).trim();
		if (languageCode) return languageCode;
	}
	return String(sc.preferredLanguageCode || "").trim();
}
function activeLanguageCodeOf(sc = {}, st = {}) {
	return String(st.languageCode || preferredLanguageCodeOf(sc) || "").trim();
}
function targetLanguageLabel(sc = {}, st = {}) {
	const language = languageOf(sc, st) || "English";
	const languageCode = activeLanguageCodeOf(sc, st);
	return languageCode ? `${language} (${languageCode})` : language;
}

function detectGuestLanguageFromText(text = "") {
	const raw = String(text || "").trim();
	if (!raw || raw.length < 2) return null;

	const arabicLetters = (raw.match(/[\u0600-\u06FF]/g) || []).length;
	if (arabicLetters >= 2) {
		return { language: "Arabic", code: "ar", confidence: arabicLetters >= 8 ? 0.95 : 0.8 };
	}

	const hindiLetters = (raw.match(/[\u0900-\u097F]/g) || []).length;
	if (hindiLetters >= 2) {
		return { language: "Hindi", code: "hi", confidence: hindiLetters >= 8 ? 0.95 : 0.8 };
	}

	const lower = raw
		.toLowerCase()
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, " ");
	const wordSet = new Set((lower.match(/[a-z]+/g) || []).map((w) => w.trim()));
	const scoreWords = (words = []) =>
		words.reduce((score, word) => score + (wordSet.has(word) ? 1 : 0), 0);

	const frenchScore =
		scoreWords([
			"bonjour",
			"salut",
			"merci",
			"chambre",
			"hotel",
			"arrivee",
			"depart",
			"reservation",
			"prix",
			"nuit",
			"nuits",
			"disponible",
			"voudrais",
			"veux",
			"combien",
			"confirmer",
		]) + (/\bs[' ]?il vous plait\b|\bje voudrais\b|\bje veux\b/.test(lower) ? 2 : 0);
	const hasFrenchSignature =
		/\b(bonjour|salut|merci|chambre|arrivee|depart|prix|nuit|nuits|disponible|voudrais|veux|combien|confirmer)\b|\bs[' ]?il vous plait\b|\bje voudrais\b|\bje veux\b/.test(
			lower
		);
	if (frenchScore >= 2 && hasFrenchSignature) {
		return { language: "French", code: "fr", confidence: Math.min(0.95, 0.6 + frenchScore * 0.1) };
	}

	const spanishScore =
		scoreWords([
			"hola",
			"gracias",
			"habitacion",
			"hotel",
			"reserva",
			"precio",
			"fechas",
			"llegada",
			"salida",
			"quiero",
			"quisiera",
			"cuanto",
			"disponible",
			"confirmar",
		]) + (/\bpor favor\b|\bme gustaria\b/.test(lower) ? 2 : 0);
	if (spanishScore >= 2) {
		return { language: "Spanish", code: "es", confidence: Math.min(0.95, 0.6 + spanishScore * 0.1) };
	}

	const indonesianScore =
		scoreWords([
			"halo",
			"terima",
			"kasih",
			"kamar",
			"reservasi",
			"harga",
			"tanggal",
			"tersedia",
			"saya",
			"ingin",
			"berapa",
			"bayar",
			"pembayaran",
			"tolong",
		]) + (/\bsaya ingin\b|\bterima kasih\b/.test(lower) ? 2 : 0);
	const malayScore =
		scoreWords([
			"hai",
			"terima",
			"kasih",
			"bilik",
			"tempahan",
			"harga",
			"tarikh",
			"tersedia",
			"saya",
			"mahu",
			"berapa",
			"bayar",
			"pembayaran",
			"tolong",
			"invois",
		]) + (/\bsaya mahu\b|\bterima kasih\b/.test(lower) ? 2 : 0);
	if (indonesianScore >= 2 || malayScore >= 2) {
		if (malayScore > indonesianScore) {
			return { language: "Malay (Malaysia)", code: "ms", confidence: Math.min(0.95, 0.6 + malayScore * 0.1) };
		}
		return { language: "Indonesian", code: "id", confidence: Math.min(0.95, 0.6 + indonesianScore * 0.1) };
	}

	const englishScore =
		scoreWords([
			"hello",
			"thanks",
			"please",
			"room",
			"hotel",
			"booking",
			"reservation",
			"reserve",
			"price",
			"availability",
			"available",
			"checkin",
			"checkout",
			"confirm",
			"payment",
			"email",
			"phone",
		]) + (/\b(check[ -]?in|check[ -]?out|thank you|how much)\b/.test(lower) ? 2 : 0);
	if (englishScore >= 3) {
		return { language: "English", code: "en", confidence: Math.min(0.95, 0.55 + englishScore * 0.1) };
	}

	return null;
}

function updateActiveLanguageFromText(sc = {}, st = {}, text = "") {
	const detected = detectGuestLanguageFromText(text);
	if (!detected || detected.confidence < 0.75) return;
	const current = String(languageOf(sc, st) || "").toLowerCase();
	const currentCode = String(activeLanguageCodeOf(sc, st) || "").toLowerCase();
	if (
		detected.language === "Arabic" &&
		(/urdu/.test(current) || currentCode === "ur")
	) {
		return;
	}
	if (
		(detected.language === "Indonesian" &&
			(/malay/.test(current) || currentCode === "ms")) ||
		(/malay/i.test(detected.language) &&
			(/indonesian/.test(current) || currentCode === "id"))
	) {
		return;
	}
	if (current !== detected.language.toLowerCase()) {
		logStep(String(sc._id || ""), "language.override", {
			from: languageOf(sc, st),
			to: detected.language,
			code: detected.code,
			confidence: detected.confidence,
		});
	}
	st.language = detected.language;
	st.languageCode = detected.code;
	st.languageOverrideAt = now();
}

function firstNameForAddress(value = "") {
	const cleaned = String(value || "")
		.trim()
		.replace(
			/^(?:mr|mrs|ms|miss|dr|sir|madam|mister|السيد|السيدة|استاذ|أستاذ|استاذة|أستاذة|الاستاذ|الأستاذ|الاستاذة|الأستاذة)\s+/i,
			""
		)
		.replace(
			/^(?:\u0627\u0644\u0633\u064a\u062f\u0629|\u0627\u0644\u0633\u064a\u062f|\u0623\u0633\u062a\u0627\u0630\u0629|\u0627\u0633\u062a\u0627\u0630\u0629|\u0623\u0633\u062a\u0627\u0630|\u0627\u0633\u062a\u0627\u0630|\u0627\u0644\u0623\u0633\u062a\u0627\u0630\u0629|\u0627\u0644\u0627\u0633\u062a\u0627\u0630\u0629|\u0627\u0644\u0623\u0633\u062a\u0627\u0630|\u0627\u0644\u0627\u0633\u062a\u0627\u0630)\s+/i,
			""
		)
		.trim();
	return firstNameOf(cleaned || value || "Guest");
}

const GUEST_FEMALE_NAMES_LATIN = new Set([
	"marwa",
	"aisha",
	"aysha",
	"ayesha",
	"mona",
	"muna",
	"maryam",
	"mariam",
	"zainab",
	"zaynab",
	"fatima",
	"fatimah",
	"sara",
	"sarah",
	"yasmin",
	"yasmine",
	"noura",
	"nora",
	"noora",
	"huda",
	"hoda",
	"hajar",
	"amina",
	"ameena",
	"asma",
	"aya",
	"eman",
	"iman",
	"salma",
	"khadija",
	"khadijah",
	"leila",
	"layla",
	"lina",
	"reem",
	"dina",
	"maha",
	"amal",
	"rawan",
	"manar",
]);
const GUEST_MALE_NAMES_LATIN = new Set([
	"ahmed",
	"mohamed",
	"muhammad",
	"mahmoud",
	"ali",
	"omar",
	"umer",
	"yusuf",
	"youssef",
	"ibrahim",
	"abdullah",
	"abdallah",
	"nasser",
	"naser",
	"khaled",
	"waleed",
	"hassan",
	"hussein",
	"mustafa",
	"mostafa",
	"karim",
	"ehab",
	"shady",
	"gamal",
]);
const GUEST_FEMALE_NAMES_ARABIC = new Set([
	"\u0645\u0631\u0648\u0629",
	"\u0639\u0627\u0626\u0634\u0629",
	"\u0639\u0627\u064a\u0634\u0629",
	"\u0645\u0646\u0649",
	"\u0645\u0631\u064a\u0645",
	"\u0632\u064a\u0646\u0628",
	"\u0641\u0627\u0637\u0645\u0629",
	"\u0633\u0627\u0631\u0629",
	"\u064a\u0627\u0633\u0645\u064a\u0646",
	"\u0646\u0648\u0631\u0629",
	"\u0646\u0648\u0631\u0627",
	"\u0647\u062f\u0649",
	"\u0647\u062f\u0627",
	"\u0647\u0627\u062c\u0631",
	"\u0622\u0645\u0646\u0629",
	"\u0627\u0645\u0646\u0629",
	"\u0623\u0633\u0645\u0627\u0621",
	"\u0627\u0633\u0645\u0627\u0621",
	"\u0622\u064a\u0629",
	"\u0627\u064a\u0629",
	"\u0625\u064a\u0645\u0627\u0646",
	"\u0627\u064a\u0645\u0627\u0646",
	"\u0633\u0644\u0645\u0649",
	"\u062e\u062f\u064a\u062c\u0629",
	"\u0644\u064a\u0644\u0649",
	"\u0644\u064a\u0646\u0627",
	"\u0631\u064a\u0645",
	"\u062f\u064a\u0646\u0627",
	"\u0645\u0647\u0627",
	"\u0623\u0645\u0644",
	"\u0627\u0645\u0644",
	"\u0631\u0648\u0627\u0646",
	"\u0645\u0646\u0627\u0631",
]);
const GUEST_MALE_NAMES_ARABIC = new Set([
	"\u0623\u062d\u0645\u062f",
	"\u0627\u062d\u0645\u062f",
	"\u0645\u062d\u0645\u062f",
	"\u0645\u062d\u0645\u0648\u062f",
	"\u0639\u0644\u064a",
	"\u0639\u0645\u0631",
	"\u064a\u0648\u0633\u0641",
	"\u0625\u0628\u0631\u0627\u0647\u064a\u0645",
	"\u0627\u0628\u0631\u0627\u0647\u064a\u0645",
	"\u0639\u0628\u062f\u0627\u0644\u0644\u0647",
	"\u0639\u0628\u062f\u0627\u0644\u0647",
	"\u0646\u0627\u0635\u0631",
	"\u062e\u0627\u0644\u062f",
	"\u0648\u0644\u064a\u062f",
	"\u062d\u0633\u0646",
	"\u062d\u0633\u064a\u0646",
	"\u0645\u0635\u0637\u0641\u0649",
	"\u0643\u0631\u064a\u0645",
	"\u0625\u064a\u0647\u0627\u0628",
	"\u0627\u064a\u0647\u0627\u0628",
	"\u0634\u0627\u062f\u064a",
	"\u062c\u0645\u0627\u0644",
]);

function compactArabicName(value = "") {
	return String(value || "")
		.replace(/[\u064b-\u065f\u0670]/g, "")
		.replace(/\u0640/g, "")
		.replace(/\s+/g, "")
		.trim();
}

function inferGuestGenderFromName(value = "") {
	const raw = String(value || "").trim();
	if (!raw) return "unknown";
	if (/\b(?:mrs|ms|miss|madam|ma'am|mme|madame|sra|senora|se\u00f1ora)\b/i.test(raw)) {
		return "female";
	}
	if (
		/(?:\u0627\u0644\u0633\u064a\u062f\u0629|\u0623\u0633\u062a\u0627\u0630\u0629|\u0627\u0633\u062a\u0627\u0630\u0629|\u0627\u0644\u0623\u0633\u062a\u0627\u0630\u0629|\u0627\u0644\u0627\u0633\u062a\u0627\u0630\u0629)/.test(
			raw
		)
	) {
		return "female";
	}
	if (/\b(?:mr|sir|mister|monsieur|sr|senor|se\u00f1or)\b/i.test(raw)) {
		return "male";
	}
	if (
		/(?:\u0627\u0644\u0633\u064a\u062f|\u0623\u0633\u062a\u0627\u0630|\u0627\u0633\u062a\u0627\u0630|\u0627\u0644\u0623\u0633\u062a\u0627\u0630|\u0627\u0644\u0627\u0633\u062a\u0627\u0630)/.test(
			raw
		)
	) {
		return "male";
	}
	const firstName = firstNameForAddress(raw);
	const latinName = asciiize(firstName)
		.toLowerCase()
		.replace(/[^a-z]/g, "");
	const arabicName = compactArabicName(firstName);
	if (
		GUEST_FEMALE_NAMES_LATIN.has(latinName) ||
		GUEST_FEMALE_NAMES_ARABIC.has(arabicName)
	) {
		return "female";
	}
	if (
		GUEST_MALE_NAMES_LATIN.has(latinName) ||
		GUEST_MALE_NAMES_ARABIC.has(arabicName)
	) {
		return "male";
	}
	return "unknown";
}

function guestNameSource(sc = {}, st = {}) {
	return String(
		st.slots?.name ||
			st.slots?.fullName ||
			sc.displayName1 ||
			sc.customerName ||
			""
	).trim();
}

function respectfulGuestProfile(sc = {}, st = {}) {
	const sourceName = guestNameSource(sc, st);
	const rawName = String(firstNameForAddress(sourceName)).trim();
	const gender = inferGuestGenderFromName(sourceName || rawName);
	const language = languageOf(sc, st);
	if (/arabic/i.test(language)) {
		if (!rawName || /^guest$/i.test(rawName)) {
			return {
				firstName: "",
				gender,
				address: "\u0636\u064a\u0641\u0646\u0627 \u0627\u0644\u0643\u0631\u064a\u0645",
			};
		}
		if (
			/^(?:\u0623\u0633\u062a\u0627\u0630|\u0627\u0633\u062a\u0627\u0630|\u0623\u0633\u062a\u0627\u0630\u0629|\u0627\u0644\u0623\u0633\u062a\u0627\u0630|\u0627\u0644\u0623\u0633\u062a\u0627\u0630\u0629|\u0627\u0644\u0633\u064a\u062f|\u0627\u0644\u0633\u064a\u062f\u0629)\b/i.test(
				rawName
			)
		) {
			return { firstName: rawName, gender, address: rawName };
		}
		if (gender === "female") {
			return {
				firstName: rawName,
				gender,
				address: `\u0623\u0633\u062a\u0627\u0630\u0629 ${rawName}`,
			};
		}
		if (gender === "male") {
			return {
				firstName: rawName,
				gender,
				address: `\u0623\u0633\u062a\u0627\u0630 ${rawName}`,
			};
		}
		return { firstName: rawName, gender, address: rawName };
	}
	return { firstName: rawName || "", gender, address: rawName || "Guest" };
}

function respectfulGuestName(sc = {}, st = {}) {
	return respectfulGuestProfile(sc, st).address;
}

function logStep(caseId, message, payload = {}) {
	if (String(process.env.AI_AGENT_DEBUG || "").toLowerCase() !== "true") {
		return;
	}
	console.log(`[aiagent] case=${caseId} ${message}`, payload);
}

const idText = (value) => String(value?._id || value?.id || value || "").trim();

function activeHotelContextForCase(sc = {}, hotel = null) {
	return isJannatBookingSupportCase(sc, hotel) ? null : hotel;
}

async function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
}
async function withSoftTimeout(promise, timeoutMs, fallbackValue) {
	let timer = null;
	try {
		return await Promise.race([
			Promise.resolve(promise).catch(() => fallbackValue),
			new Promise((resolve) => {
				timer = setTimeout(() => resolve(fallbackValue), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
async function sleepUnlessInterrupted(st, ms, stepMs = 150) {
	for (let elapsed = 0; elapsed < ms; elapsed += stepMs) {
		if (st?.interrupt) return false;
		await sleep(Math.min(stepMs, ms - elapsed));
	}
	return !st?.interrupt;
}
async function humanPause() {
	await sleep(randomBetween(HUMAN.betweenSendsMinMs, HUMAN.betweenSendsMaxMs));
}

function isAiConversationMessage(message = {}) {
	const email = String(message?.messageBy?.customerEmail || "").toLowerCase();
	return (
		message?.isAi === true ||
		message?.isSystem === true ||
		email === AI_SUPPORT_EMAIL ||
		email === LEGACY_AI_SUPPORT_EMAIL
	);
}

function hasAiAssistantReply(sc = {}) {
	const conversation = Array.isArray(sc.conversation) ? sc.conversation : [];
	return conversation.some(
		(message) => !message?.isSystem && isAiConversationMessage(message)
	);
}

function isGuestConversationMessage(message = {}) {
	return (
		message?.message &&
		!message?.isSystem &&
		!isAiConversationMessage(message)
	);
}

function conversationEntryContextText(message = {}) {
	return [
		message?.message,
		message?.inquiryAbout ? `Inquiry about: ${message.inquiryAbout}` : "",
		message?.inquiryDetails ? `Inquiry details: ${message.inquiryDetails}` : "",
	]
		.filter(Boolean)
		.map((value) => String(value || "").trim())
		.filter(Boolean)
		.join("\n");
}

function conversationText(sc = {}, { guestsOnly = false } = {}) {
	const conversation = Array.isArray(sc.conversation) ? sc.conversation : [];
	return conversation
		.filter((message) =>
			guestsOnly ? isGuestConversationMessage(message) : message?.message
		)
		.map((message) => conversationEntryContextText(message))
		.filter(Boolean)
		.join("\n");
}

function initialInquiryText(sc = {}) {
	const firstMessage = Array.isArray(sc.conversation)
		? sc.conversation[0] || {}
		: {};
	return [
		sc.inquiryAbout || firstMessage.inquiryAbout || "",
		sc.inquiryDetails || firstMessage.inquiryDetails || "",
	]
		.filter(Boolean)
		.map((value) => String(value || "").trim())
		.filter(Boolean)
		.join("\n");
}

function cleanPhoneCandidate(text = "") {
	const digits = digitsToEnglish(text).replace(/\D/g, "");
	return digits.length >= 5 && digits.length <= 18 ? digits : "";
}

function latestEmailFromText(text = "") {
	const matches = String(text || "").match(/[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+/g);
	return matches?.length ? matches[matches.length - 1] : "";
}

function latestPhoneFromText(text = "") {
	const matches = String(text || "").match(/\+?[\d\u0660-\u0669\u06f0-\u06f9][\d\u0660-\u0669\u06f0-\u06f9 \t().-]{4,}/g);
	if (!matches?.length) return "";
	for (let i = matches.length - 1; i >= 0; i -= 1) {
		const phone = cleanPhoneCandidate(matches[i]);
		if (phone) return phone;
	}
	return "";
}

function looksLikeNameCandidate(text = "") {
	const value = String(text || "").trim();
	if (!value || value.length > 80) return false;
	if (latestEmailFromText(value) || cleanPhoneCandidate(value)) return false;
	if (/confirm|confirmation|book|reserve|price|date|room|\u062d\u062c\u0632|\u062a\u0627\u0631\u064a\u062e|\u063a\u0631\u0641/i.test(value)) return false;
	return /[A-Za-z\u0600-\u06FF]{2,}/.test(value);
}

function hydrateKnownSlotsFromConversation(sc = {}, st = {}) {
	const conversation = Array.isArray(sc.conversation) ? sc.conversation : [];
	if (!conversation.length || st.hydratedConversationLength === conversation.length) {
		return;
	}
	const before = JSON.stringify(st.slots || {});
	const allText = conversationText(sc);
	const guestText = conversationText(sc, { guestsOnly: true });
	const dates = quickDateRange(allText);
	if (
		dates.checkinISO &&
		dates.checkoutISO &&
		!needsExplicitPastDateClarification(allText, dates)
	) {
		st.slots.checkinISO = st.slots.checkinISO || dates.checkinISO;
		st.slots.checkoutISO = st.slots.checkoutISO || dates.checkoutISO;
		if (dates.raw) {
			st.dateRaw = { ...st.dateRaw, ...dates.raw };
		}
	}
	const roomKey = mapRoomToKey(guestText) || mapRoomToKey(allText);
	if (roomKey && !st.slots.roomTypeKey) st.slots.roomTypeKey = roomKey;
	const email = latestEmailFromText(guestText);
	if (email && !st.slots.email) st.slots.email = email;
	const phone = latestPhoneFromText(guestText);
	if (phone && !st.slots.phone) st.slots.phone = phone;
	for (const message of conversation) {
		if (!isGuestConversationMessage(message)) continue;
		const contact = String(message?.messageBy?.customerEmail || "");
		const contactEmail = latestEmailFromText(contact);
		const contactPhone = cleanPhoneCandidate(contact);
		if (contactEmail && !st.slots.email) st.slots.email = contactEmail;
		if (contactPhone && !st.slots.phone) st.slots.phone = contactPhone;
	}
	let lastAsk = "";
	for (const message of conversation) {
		const text = String(message?.message || "");
		if (isAiConversationMessage(message)) {
			if (/full name|passport|guest name|name|\u0627\u0644\u0627\u0633\u0645|\u0627\u0633\u0645/i.test(text)) {
				lastAsk = "name";
			} else if (/nationality|\u0627\u0644\u062c\u0646\u0633\u064a\u0629|\u062c\u0646\u0633\u064a/i.test(text)) {
				lastAsk = "nationality";
			} else if (/phone|mobile|whatsapp|\u062c\u0648\u0627\u0644|\u0647\u0627\u062a\u0641|\u0648\u0627\u062a\u0633/i.test(text)) {
				lastAsk = "phone";
			} else if (/email|mail|\u0628\u0631\u064a\u062f|\u0627\u064a\u0645\u064a\u0644/i.test(text)) {
				lastAsk = "email";
			}
			continue;
		}
		if (!isGuestConversationMessage(message)) continue;
		applyReservationGuestCountsFromText(st, text);
		if (lastAsk === "name" && !st.slots.fullName && looksLikeNameCandidate(text)) {
			const candidate = cleanFullNameCandidate(text);
			if (candidate) {
				st.slots.fullName = candidate;
				st.slots.name = candidate;
			}
		} else if (lastAsk === "phone" && !st.slots.phone) {
			const candidate = latestPhoneFromText(text);
			if (candidate) st.slots.phone = candidate;
		} else if (lastAsk === "email" && !st.slots.email) {
			const candidate = latestEmailFromText(text);
			if (candidate) st.slots.email = candidate;
			else if (emailSkipText(text)) {
				st.slots.email = "";
				st.slots.emailSkipped = true;
			}
		} else if (lastAsk === "nationality" && !st.slots.nationality) {
			const value = asciiize(text).trim();
			if (value && value.length <= 40) st.slots.nationality = value;
		}
	}
	st.hydratedConversationLength = conversation.length;
	if (before !== JSON.stringify(st.slots || {})) {
		logStep(String(sc._id || ""), "slots.hydrated", { slots: st.slots });
	}
}

function lastAssistantMessageBeforeLatestGuest(sc = {}) {
	const conversation = Array.isArray(sc.conversation) ? sc.conversation : [];
	let sawLatestGuest = false;
	for (let index = conversation.length - 1; index >= 0; index -= 1) {
		const message = conversation[index];
		if (!sawLatestGuest) {
			if (isGuestConversationMessage(message)) {
				sawLatestGuest = true;
			}
			continue;
		}
		if (isAiConversationMessage(message)) return message;
	}
	return null;
}

function quickReplyActions(message = {}) {
	if (!message || typeof message !== "object") return [];
	return Array.isArray(message.quickReplies)
		? message.quickReplies
				.map((reply) => String(reply?.action || "").trim().toLowerCase())
				.filter(Boolean)
		: [];
}

function recoverBookingStageFromConversation(sc = {}, st = {}) {
	if (!st || isReservationDetailStep(st)) return;
	if (
		sc.aiReservation?.status === "created" ||
		sc.aiReservation?.confirmationNumber ||
		sc.aiReservation?.reservationId
	) {
		st.waitFor = "post_booking_followup";
		st.reviewSent = false;
		return;
	}
	const lastAssistant = lastAssistantMessageBeforeLatestGuest(sc);
	if (!lastAssistant) return;
	const text = String(lastAssistant.message || "");
	const actions = quickReplyActions(lastAssistant);
	if (actions.some((action) => action.startsWith("connect_hotel_"))) {
		st.waitFor = "platform_hotel_choice";
		return;
	}
	const hasConfirmAction =
		actions.includes("confirm") || actions.includes("correction");
	const looksLikeReview =
		/review before we finalize|type confirm to finalize|confirm to finalize|tell me what to change/i.test(
			text
		);
	if (hasConfirmAction || looksLikeReview) {
		st.reviewSent = true;
		st.waitFor = "reviewConfirm";
		return;
	}

	if (
		actions.includes("skip_email") ||
		/required details.*payment link by email|receive the confirmation and payment link by email|choose skip|pulsa omitir|cliquez sur ignorer|\u0623\u0648\s+\u0627\u0636\u063a\u0637\s+\u062a\u062e\u0637\u064a/i.test(
			text
		)
	) {
		st.waitFor = "email_or_skip";
		return;
	}

	const hasProceedAction = actions.includes("proceed");
	const looksLikeProceed =
		/would you like me to continue|shall i continue|continue to the review|continue with the reservation details|proceed to confirm/i.test(
			text
		);
	if ((hasProceedAction || looksLikeProceed) && st.hotel && quoteKeyForSlots(st)) {
		if (!st.quote || st.quote.key !== quoteKeyForSlots(st)) {
			const quote = safePriceRoomForStay(
				st.hotel,
				{ roomType: st.slots.roomTypeKey },
				st.slots.checkinISO,
				st.slots.checkoutISO
			);
			st.quote = { key: quoteKeyForSlots(st), at: now(), data: quote };
		}
		if (st.quote?.data?.available) {
			st.waitFor = "proceed";
		}
	}
}

function isNewReservationFlowActive(st = {}) {
	if (st.waitFor === "post_booking_followup") return false;
	return Boolean(
		st.quote ||
			st.reviewSent ||
			st.slots?.checkinISO ||
			st.slots?.checkoutISO ||
			st.slots?.roomTypeKey ||
			[
				"dates",
				"room",
				"proceed",
				"reviewConfirm",
				"reservation_details",
				"fullname",
				"nationality",
				"phone",
				"email_or_skip",
				"finalize",
			].includes(st.waitFor)
	);
}

function explicitlyExistingReservationIntent(text = "") {
	return /\b(existing|old|already have|my reservation|my booking|change my|update my)\b|\u0639\u0646\u062f\u064a \u062d\u062c\u0632|\u062d\u062c\u0632\u064a|\u062d\u062c\u0632 \u0642\u062f\u064a\u0645|\u062d\u062c\u0632 \u0633\u0627\u0628\u0642|\u062a\u0639\u062f\u064a\u0644 \u062d\u062c\u0632/i.test(
		String(text || "")
	);
}

function isReservationDetailStep(st = {}) {
	return [
		"reviewConfirm",
		"reservation_details",
		"fullname",
		"nationality",
		"phone",
		"email_or_skip",
		"finalize",
	].includes(st.waitFor);
}

function humanHandoffReason(text = "") {
	const normalized = String(text || "").toLowerCase();
	if (looksLikeReservationCancellation(text)) {
		return "reservation_cancellation";
	}
	if (
		/\b(update|change|modify|amend|edit|correct)\b/i.test(normalized) &&
		/\b(reservation|booking|dates|date|name|phone|email|nationality|payment)\b/i.test(
			normalized
		)
	) {
		return "reservation_update";
	}
	return "";
}

function looksLikeReservationCancellation(text = "") {
	const { lower, arabic, latinCompact } = normalizeControlText(text);
	const hasCancel =
		/\b(cancel|cancellation|cancelation|refund|void)\b/i.test(lower) ||
		/(?:cancelar|cancelacion|cancelaci[oó]n|anular|annuler|annulation|remboursement|reembolso)/i.test(
			lower
		) ||
		/(?:\u0627\u0644\u063a\u0627\u0621|\u0625\u0644\u063a\u0627\u0621|\u0627\u0644\u063a\u064a|\u0623\u0644\u063a\u064a|\u0627\u0644\u0644\u063a\u064a|\u0643\u0646\u0633\u0644|\u0627\u0633\u062a\u0631\u062f\u0627\u062f)/i.test(
			arabic
		) ||
		/(?:cancel|cancellation|refund|void|cancelar|anular|annuler|reembolso|remboursement|elgha|ilgha|alghi|kansel|cancelreservation|cancelbooking)/i.test(
			latinCompact
		);
	if (!hasCancel) return false;
	const hasReservationContext =
		/\b(reservation|booking|room|stay|payment|deposit|confirmation|reference|it)\b/i.test(
			lower
		) ||
		/(?:reserva|r[eé]servation|habitacion|chambre|sejour|s[eé]jour)/i.test(
			lower
		) ||
		/(?:\u062d\u062c\u0632|\u0627\u0644\u062d\u062c\u0632|\u062a\u0627\u0643\u064a\u062f|\u062a\u0623\u0643\u064a\u062f|\u063a\u0631\u0641\u0647|\u0627\u0642\u0627\u0645\u0647|\u062f\u0641\u0639)/i.test(
			arabic
		) ||
		Boolean(confirmationFromText(text));
	return hasReservationContext;
}

function publicDiscountPercent() {
	return PUBLIC_DISCOUNT_PERCENT;
}

function wantsDiscountQuestion(text = "") {
	const normalized = String(text || "").toLowerCase();
	return /discount|discounts|promo|promotion|coupon|voucher|offer|offers|deal|deals|special rate|best price|lower price|cheaper|reduce price|make it less|خصم|خصومات|تخفيض|تخفيضات|عرض|عروض|كوبون|برومو|اقل سعر|أقل سعر|ارخص|أرخص|نزل السعر|ينفع خصم|descuento|oferta|promocion|promoción|remise|reduction|réduction|promo|offre/i.test(
		normalized
	);
}

function discountDisplayContext(st = {}) {
	const quote = st.quote?.data;
	const discountPercent = publicDiscountPercent();
	const factor = 1 - discountPercent / 100;
	const perNightValues = Array.isArray(quote?.perNight)
		? quote.perNight.map((value) => Number(value)).filter((value) => value > 0)
		: [];
	const displayedPerNight =
		perNightValues.length === 1
			? perNightValues[0]
			: perNightValues.length
			? Number(
					(
						perNightValues.reduce((sum, value) => sum + value, 0) /
						perNightValues.length
					).toFixed(2)
			  )
			: null;
	const beforeDiscount =
		displayedPerNight && factor > 0
			? Number((displayedPerNight / factor).toFixed(2))
			: null;
	return {
		discountPercent,
		displayedPerNight,
		beforeDiscount,
		currency: quote?.currency || st.hotel?.currency || "SAR",
		hasQuote: Boolean(quote?.available),
	};
}

function looksLikeGreetingOnly(text = "") {
	return /^(hi|hello|hey|hi there|hello there|good morning|good evening|السلام|مرحبا|اهلا|أهلا|hola|bonjour|salut|ہیلو|ہیلو there|नमस्ते)\b/i.test(
		String(text || "").trim()
	);
}

function greetingText(sc = {}, st = {}) {
	const name = firstNameForAddress(
		st.slots?.name || st.slots?.fullName || sc.displayName1 || "Guest"
	);
	const lang = languageOf(sc, st);
	if (/arabic/i.test(lang)) return `أهلاً ${name}، كيف أقدر أساعدك اليوم؟`;
	if (/spanish/i.test(lang)) return `Hola ${name}, ¿cómo puedo ayudarte hoy?`;
	if (/french/i.test(lang)) return `Bonjour ${name}, comment puis-je vous aider aujourd'hui ?`;
	if (/urdu/i.test(lang)) return `${name}، میں آپ کی کیسے مدد کر سکتا ہوں؟`;
	if (/hindi/i.test(lang)) return `नमस्ते ${name}, मैं आपकी कैसे मदद कर सकता हूँ?`;
	return `Hi ${name}, how can I help you today?`;
}

function wantsHotelRecommendation(text = "") {
	const normalized = String(text || "").toLowerCase();
	const asksNearHaram =
		/haram|al haram|el haram|الحرم|المسجد الحرام|kaaba|makkah/i.test(normalized);
	const asksRoom =
		/double|room|hotel|غرفة|غرف|فندق|فنادق|habitación|hotel|chambre|hôtel/i.test(
			normalized
		);
	return asksNearHaram && asksRoom;
}

function wantsPriceButMissingDates(text = "", st = {}) {
	const normalized = String(text || "").toLowerCase();
	const asksPrice =
		/price|prices|rate|rates|cost|how much|سعر|اسعار|أسعار|بكام|precio|prix|قیمت/i.test(
			normalized
		);
	const asksSpanishPrice =
		/precios|cuanto cuesta|cu[aá]nto cuesta|cuesta|costo|tarifa/i.test(
			normalized
		);
	return (
		(asksPrice || asksSpanishPrice) &&
		(!st.slots?.checkinISO || !st.slots?.checkoutISO)
	);
}

function selectedHotelRoomQuestionText(text = "") {
	const normalized = String(text || "").toLowerCase();
	if (!normalized.trim()) return false;
	if (roomCapacityOrTypeInquiryText(text)) return true;
	const mentionsRoom =
		/\b(room|rooms|bed|beds|suite|suites|people|persons|individuals|guests)\b/i.test(
			normalized
		) || /غرف|غرفة|سرير|أسرة|اشخاص|أشخاص|افراد|أفراد/.test(normalized);
	if (!mentionsRoom) return false;
	const hasRoomTypeOrCapacity =
		Boolean(mapRoomToKey(normalized)) ||
		/\b(?:for\s*)?(?:2|two|3|three|4|four|5|five)\b/i.test(normalized);
	if (!hasRoomTypeOrCapacity) return false;
	return (
		/[?]/.test(normalized) ||
		/\b(do you|you guys|u guys|does the hotel|does your hotel|is there|are there|any|available|availability|have|has|looking for|need|want|book|reserve)\b/i.test(
			normalized
		) ||
		/عندكم|فيه|هل|متاح|ابغى|أبغى|عايز|عاوز|احتاج/.test(normalized)
	);
}

function selectedHotelDistanceQuestionText(text = "") {
	const { lower, arabic, latinCompact } = normalizeControlText(text);
	if (!lower.trim()) return false;
	const asksDistance =
		/\b(?:how\s+far|far\s+from|distance|distancia|lejos|cerca|near|close|walking|walk|a\s+pie|caminando|drive|driving|en\s+voiture|a\s+pied|minutes?|mins?|berapa\s+jauh|jarak|dekat|jalan\s+kaki|menit|minit)\b/i.test(
			lower
		) ||
		/(?:\u0643\u0645\s+\u064a\u0628\u0639\u062f|\u064a\u0628\u0639\u062f|\u0628\u0639\u064a\u062f|\u0642\u0631\u064a\u0628|\u0627\u0644\u0645\u0633\u0627\u0641\u0647|\u0645\u0633\u0627\u0641\u0647|\u062f\u0642\u064a\u0642\u0647|\u062f\u0642\u0627\u064a\u0642|\u0645\u0634\u064a|\u0645\u0634\u064a\u0627|\u0633\u064a\u0627\u0631\u0647|\u0628\u0627\u0644\u0633\u064a\u0627\u0631\u0647|\u06a9\u062a\u0646\u0627\s+\u062f\u0648\u0631|\u06a9\u06cc\u062a\u0646\u0627\s+\u062f\u0648\u0631|\u0641\u0627\u0635\u0644\u06c1|\u0645\u0646\u0679)/i.test(
			arabic
		) ||
		/(?:howfar|farfrom|distance|nearharam|closeharam|walking|driving|jarak|berapajauh|kitnadoor|kitnidur)/i.test(
			latinCompact
		);
	if (!asksDistance) return false;
	const mentionsHaramOrHotel =
		/\b(?:haram|al\s*haram|el\s*haram|masjid|kaaba|kabah|kaba|hotel|your\s+hotel|the\s+hotel)\b/i.test(
			lower
		) ||
		/(?:\u0627\u0644\u062d\u0631\u0645|\u0627\u0644\u0645\u0633\u062c\u062f\s+\u0627\u0644\u062d\u0631\u0627\u0645|\u0627\u0644\u0643\u0639\u0628\u0647|\u0627\u0644\u0643\u0639\u0628\u0629|\u0627\u0644\u0641\u0646\u062f\u0642|\u0641\u0646\u062f\u0642)/i.test(
			arabic
		) ||
		/(?:haram|masjidilharam|kaaba|kabah|kaba|hotel|funduq)/i.test(
			latinCompact
		);
	return mentionsHaramOrHotel;
}

function selectedHotelAddressQuestionText(text = "") {
	const { lower, arabic, latinCompact } = normalizeControlText(text);
	if (!lower.trim()) return false;
	const asksLocation =
		/\b(?:where\s+is|where's|located|location|address|area|district|map|ubicacion|ubicaci[oó]n|direccion|direcci[oó]n|adresse|emplacement|alamat|lokasi|peta)\b/i.test(
			lower
		) ||
		/(?:\u0627\u064a\u0646|\u0641\u064a\u0646|\u0648\u064a\u0646|\u0645\u0648\u0642\u0639|\u0645\u0643\u0627\u0646|\u0639\u0646\u0648\u0627\u0646|\u0645\u0646\u0637\u0642\u0647|\u062d\u064a|\u06a9\u06c1\u0627\u06ba|\u06a9\u062f\u06be\u0631|\u067e\u062a\u06c1|\u092a\u0924\u093e|\u0915\u0939\u093e\u0902)/i.test(
			arabic
		) ||
		/(?:whereis|location|address|map|ubicacion|direccion|adresse|alamat|lokasi|kahan|kidhar|pata)/i.test(
			latinCompact
		);
	if (!asksLocation) return false;
	const mentionsHotel =
		/\b(?:hotel|your\s+hotel|the\s+hotel|it|there)\b/i.test(lower) ||
		/(?:\u0627\u0644\u0641\u0646\u062f\u0642|\u0641\u0646\u062f\u0642|\u0647\u0648|\u0647\u0646\u0627\u0643)/i.test(
			arabic
		) ||
		/(?:hotel|funduq)/i.test(latinCompact);
	return mentionsHotel;
}

function selectedHotelBusQuestionText(text = "") {
	const { lower, arabic, latinCompact } = normalizeControlText(text);
	if (!lower.trim()) return false;
	const directBus =
		/\b(?:bus|buses|shuttle|coach|haram\s+bus|bus\s+to\s+haram)\b/i.test(
			lower
		) ||
		/(?:\u0628\u0627\u0635|\u0628\u0627\u0635\u0627\u062a|\u062d\u0627\u0641\u0644\u0647|\u062d\u0627\u0641\u0644\u0627\u062a|\u0627\u062a\u0648\u0628\u064a\u0633|\u0623\u062a\u0648\u0628\u064a\u0633|\u0634\u0627\u062a\u0644|\u0628\u0633|\u0628\u0633\u06cc\u06ba|\u092c\u0938|\u0628\u0627\u0633)/i.test(
			arabic
		) ||
		/(?:bus|buses|shuttle|coach|bas|bis|buskeharam|bustoharam)/i.test(
			latinCompact
		);
	const haramOrStation =
		/\b(?:haram|al\s*haram|el\s*haram|station|agyad|ajyad|shohada|shuhada)\b/i.test(
			lower
		) ||
		/(?:\u0627\u0644\u062d\u0631\u0645|\u0645\u062d\u0637\u0647|\u0627\u0644\u0634\u0647\u062f\u0627\u0621|\u0634\u0647\u062f\u0627\u0621|\u0627\u062c\u064a\u0627\u062f|\u0623\u062c\u064a\u0627\u062f)/i.test(
			arabic
		) ||
		/(?:haram|station|agyad|ajyad|shohada|shuhada)/i.test(latinCompact);
	const transportToHaram =
		/\b(?:transport|transportation|transfer)\b/i.test(lower) ||
		/(?:\u0646\u0642\u0644|\u0645\u0648\u0627\u0635\u0644\u0627\u062a)/i.test(arabic) ||
		/(?:transport|transfer|mowaslat|naql)/i.test(latinCompact);
	return directBus || (transportToHaram && haramOrStation);
}

function selectedHotelFactQuestionText(text = "") {
	return (
		selectedHotelBusQuestionText(text) ||
		selectedHotelDistanceQuestionText(text) ||
		selectedHotelAddressQuestionText(text)
	);
}

function hasOperationalBookingSignal(text = "") {
	const normalized = String(text || "").toLowerCase();
	if (!normalized.trim()) return false;
	return (
		selectedHotelFactQuestionText(normalized) ||
		selectedHotelRoomQuestionText(normalized) ||
		Boolean(mapRoomToKey(normalized)) ||
		Boolean(extractDateRange(normalized)?.checkinISO) ||
		/\b(book|reserve|reservation|availability|available|room|rooms|bed|beds|price|rate|cost|stay|check[\s-]?in|check[\s-]?out|dates?)\b/i.test(
			normalized
		) ||
		/حجز|غرفة|غرف|متاح|سعر|دخول|خروج|موعد|تاريخ/.test(normalized)
	);
}

function wantsPaymentHelp(text = "") {
	const raw = String(text || "");
	if (/\b(pembayaran|bayar|pautan|invois|invoice)\b/i.test(raw)) return true;
	return /payment|pay|card|link|declined|not going through|failed|دفع|بطاقة|رابط|pago|paiement|ادائیگی/i.test(
		String(text || "")
	);
}

function wantsReservationHelp(text = "") {
	const raw = String(text || "");
	if (/\b(reservasi|tempahan|pengesahan)\b/i.test(raw)) return true;
	return /reservation|booking|confirmation|تأكيد|حجز|reserva|réservation|بکنگ|आरक्षण/i.test(
		String(text || "")
	);
}

function hotelContactDetailsQuestionText(text = "") {
	const raw = String(text || "").trim();
	if (!raw) return false;
	const { lower, arabic, latinCompact } = normalizeControlText(raw);
	const asksContact =
		/\b(?:phone|telephone|mobile|number|no\.?|whatsapp|whats\s*app|contact|call|reach)\b/i.test(
			lower
		) ||
		/(?:\u0631\u0642\u0645|\u062c\u0648\u0627\u0644|\u0647\u0627\u062a\u0641|\u062a\u0644\u064a\u0641\u0648\u0646|\u062a\u0644\u064a\u0641\u0648\u0646|\u0648\u0627\u062a\u0633|\u0648\u0627\u062a\u0633\u0627\u0628|\u0627\u062a\u0635\u0644|\u0627\u062a\u0648\u0627\u0635\u0644)/i.test(
			arabic
		);
	if (!asksContact) return false;
	const asksHotelOrStaff =
		/\b(?:hotel|reception|front\s*desk|desk|manager|responsible|staff|support|official)\b/i.test(
			lower
		) ||
		/\b(?:your|you)\s+(?:phone|telephone|mobile|number|no\.?|whatsapp|whats\s*app|contact)\b/i.test(
			lower
		) ||
		/(?:\u0627\u0644\u0641\u0646\u062f\u0642|\u0641\u0646\u062f\u0642|\u0627\u0644\u0627\u0633\u062a\u0642\u0628\u0627\u0644|\u0627\u0633\u062a\u0642\u0628\u0627\u0644|\u0627\u0644\u0645\u0633\u0624\u0648\u0644|\u0627\u0644\u0645\u0633\u0626\u0648\u0644|\u0645\u0633\u0624\u0648\u0644|\u0645\u0633\u0626\u0648\u0644|\u0627\u0644\u0645\u062f\u064a\u0631|\u0627\u0644\u062f\u0639\u0645)/i.test(
			arabic
		) ||
		/(?:hotelphone|hotelwhatsapp|callhotel|contacthotel|managernumber|receptionnumber|responsiblenumber)/i.test(
			latinCompact
		);
	const directHotelContact =
		/\b(?:call|contact|reach|speak\s+to|talk\s+to)\s+(?:the\s+)?hotel\b/i.test(
			lower
		) ||
		/(?:\u0627\u0643\u0644\u0645|\u0627\u0643\u0644\u0645|\u0627\u062a\u0648\u0627\u0635\u0644|\u0627\u062a\u0635\u0644).*?(?:\u0627\u0644\u0641\u0646\u062f\u0642|\u0641\u0646\u062f\u0642)/i.test(
			arabic
		);
	return asksHotelOrStaff || directHotelContact;
}

function genericContactNumberRequestText(text = "") {
	const raw = String(text || "").trim();
	if (!raw) return false;
	const { lower, arabic, latinCompact } = normalizeControlText(raw);
	if (/\b(?:my|mine)\s+(?:phone|telephone|mobile|number|whatsapp|contact)\b/i.test(lower)) {
		return false;
	}
	const asksContact =
		/\b(?:phone|telephone|mobile|number|no\.?|whatsapp|whats\s*app|contact|call)\b/i.test(
			lower
		) ||
		/(?:\u0631\u0642\u0645|\u062c\u0648\u0627\u0644|\u0647\u0627\u062a\u0641|\u062a\u0644\u064a\u0641\u0648\u0646|\u0648\u0627\u062a\u0633|\u0648\u0627\u062a\u0633\u0627\u0628|\u0627\u062a\u0635\u0644)/i.test(
			arabic
		);
	if (!asksContact) return false;
	return (
		/\b(?:give|send|share|need|want|have|provide|please|pls|plz|again|still|just|only)\b/i.test(
			lower
		) ||
		/\b(?:phone|number|whatsapp|contact)\s+(?:please|pls|plz)\b/i.test(lower) ||
		/(?:\u0644\u0648\s*\u0633\u0645\u062d\u062a|\u0627\u0631\u0633\u0644|\u0627\u0628\u0639\u062a|\u0627\u062f\u064a\u0646\u064a|\u0623\u0639\u0637\u064a\u0646\u064a|\u0645\u062d\u062a\u0627\u062c|\u0627\u062d\u062a\u0627\u062c|\u0627\u0628\u063a\u0649|\u0623\u0628\u063a\u0649|\u0628\u0631\u0636\u0647|\u0645\u0631\u0629\s*\u062b\u0627\u0646\u064a\u0629)/i.test(
			arabic
		) ||
		/(?:giveme|sendme|share|numberplease|phoneplease|whatsappplease)/i.test(
			latinCompact
		)
	);
}

function hotelContactRequestLikeText(text = "") {
	return hotelContactDetailsQuestionText(text) || genericContactNumberRequestText(text);
}

function normalizedContactRequestText(text = "") {
	return normalizeControlText(text).lower.replace(/\s+/g, " ").trim();
}

function hotelContactConversationRequestCount(sc = {}) {
	const conversation = Array.isArray(sc.conversation) ? sc.conversation : [];
	return conversation.filter((message) => {
		if (!isGuestConversationMessage(message)) return false;
		return hotelContactRequestLikeText(conversationEntryContextText(message));
	}).length;
}

function hotelContactRequestCount(sc = {}, userText = "") {
	const conversation = Array.isArray(sc.conversation) ? sc.conversation : [];
	const latestText = normalizedContactRequestText(userText);
	let count = 0;
	let latestAlreadyCounted = false;
	const lastGuestIndex = conversation.reduce(
		(lastIndex, message, index) =>
			isGuestConversationMessage(message) ? index : lastIndex,
		-1
	);
	for (let index = 0; index < conversation.length; index += 1) {
		const message = conversation[index];
		if (!isGuestConversationMessage(message)) continue;
		const text = conversationEntryContextText(message);
		if (!hotelContactRequestLikeText(text)) continue;
		count += 1;
		if (
			latestText &&
			normalizedContactRequestText(text) === latestText &&
			index === lastGuestIndex
		) {
			latestAlreadyCounted = true;
		}
	}
	if (hotelContactRequestLikeText(userText) && !latestAlreadyCounted) count += 1;
	return count;
}

function previousHotelContactRequestCount(sc = {}, userText = "") {
	const count = hotelContactRequestCount(sc, userText);
	return Math.max(0, count - (hotelContactRequestLikeText(userText) ? 1 : 0));
}

function hotelContactFollowupQuestionText(sc = {}, userText = "") {
	return (
		genericContactNumberRequestText(userText) &&
		previousHotelContactRequestCount(sc, userText) >= 1
	);
}

function hotelContactInsistenceText(text = "") {
	const { lower, arabic, latinCompact } = normalizeControlText(text);
	return (
		/\b(?:again|still|just|only|insist|must|need\s+the\s+number|give\s+me\s+the\s+number|send\s+the\s+number|phone\s+please|number\s+please)\b/i.test(
			lower
		) ||
		/(?:\u0628\u0631\u0636\u0647|\u0644\u0627\u0632\u0645|\u0645\u0635\u0631|\u0645\u0631\u0629\s*\u062b\u0627\u0646\u064a\u0629|\u0627\u062f\u064a\u0646\u064a\s+\u0627\u0644\u0631\u0642\u0645|\u0627\u0628\u0639\u062a\s+\u0627\u0644\u0631\u0642\u0645|\u0627\u0631\u0633\u0644\s+\u0627\u0644\u0631\u0642\u0645)/i.test(
			arabic
		) ||
		/(?:again|still|justgiveme|numberplease|phoneplease|sendnumber)/i.test(
			latinCompact
		)
	);
}

function contactReplyLanguageKey(sc = {}, st = {}) {
	const target = `${languageOf(sc, st)} ${activeLanguageCodeOf(sc, st)}`.toLowerCase();
	if (/arabic|\bar\b/.test(target)) return "ar";
	if (/spanish|\bes\b/.test(target)) return "es";
	if (/french|\bfr\b/.test(target)) return "fr";
	if (/urdu|\bur\b/.test(target)) return "ur";
	if (/hindi|\bhi\b/.test(target)) return "hi";
	if (/indonesian|\bid\b/.test(target)) return "id";
	if (/malay|malaysia|\bms\b/.test(target)) return "ms";
	return "en";
}

function hotelContactReplyText(sc = {}, st = {}, options = {}) {
	const name = respectfulGuestName(sc, st);
	const phone = String(options.publicPhone || "").trim();
	const requestCount = Number(options.requestCount || 1);
	const firm = requestCount >= 2;
	const key = contactReplyLanguageKey(sc, st);
	const hotelName = st.hotel ? localizedHotelName(sc, st) || toTitle(st.hotel.hotelName) : "";
	const hotelEn = hotelName || "the hotel";
	const templates = {
		en: {
			first: `${name}, this is ${st.agentName}; I work directly with the reception of ${hotelEn}. This live chat is the safest and most credible way to reserve because reception can check live availability and keep every detail clear in one place. Send me what you need and I will handle it with you here.`,
			firm: `${name}, I understand you want the number. I am working directly with the reception of ${hotelEn}, and continuing here is the safest and most credible way to complete the reservation with live availability and clear details. Tell me what you need and I will take care of it step by step.`,
			share: `${name}, the phone/WhatsApp line I can share is ${phone}. For the smoothest reservation, please keep the details here too so reception can track availability and your request without losing context.`,
		},
		ar: {
			first: `${name}\u060c \u0645\u0639\u0643 ${st.agentName}\u060c \u0623\u0639\u0645\u0644 \u0645\u0628\u0627\u0634\u0631\u0629 \u0645\u0639 \u0627\u0633\u062a\u0642\u0628\u0627\u0644 ${hotelEn}. \u0647\u0630\u0647 \u0627\u0644\u062f\u0631\u062f\u0634\u0629 \u0647\u064a \u0627\u0644\u0637\u0631\u064a\u0642\u0629 \u0627\u0644\u0623\u0636\u0645\u0646 \u0648\u0627\u0644\u0623\u0643\u062b\u0631 \u0645\u0635\u062f\u0627\u0642\u064a\u0629 \u0644\u0625\u062a\u0645\u0627\u0645 \u0627\u0644\u062d\u062c\u0632 \u0644\u0623\u0646 \u0627\u0644\u0627\u0633\u062a\u0642\u0628\u0627\u0644 \u064a\u0631\u0627\u062c\u0639 \u0627\u0644\u062a\u0648\u0641\u0631 \u0645\u0628\u0627\u0634\u0631\u0629 \u0648\u064a\u062d\u0641\u0638 \u0643\u0644 \u0627\u0644\u062a\u0641\u0627\u0635\u064a\u0644 \u0641\u064a \u0645\u0643\u0627\u0646 \u0648\u0627\u062d\u062f. \u0627\u0643\u062a\u0628 \u0644\u064a \u0637\u0644\u0628\u0643 \u0648\u0633\u0623\u062a\u0627\u0628\u0639\u0647 \u0645\u0639\u0643 \u0647\u0646\u0627.`,
			firm: `${name}\u060c \u0623\u0641\u0647\u0645 \u0623\u0646\u0643 \u062a\u0631\u064a\u062f \u0627\u0644\u0631\u0642\u0645. \u0623\u0646\u0627 \u0623\u0639\u0645\u0644 \u0645\u0628\u0627\u0634\u0631\u0629 \u0645\u0639 \u0627\u0633\u062a\u0642\u0628\u0627\u0644 ${hotelEn}\u060c \u0648\u0625\u0643\u0645\u0627\u0644 \u0627\u0644\u062d\u062c\u0632 \u0647\u0646\u0627 \u0647\u0648 \u0627\u0644\u0623\u0636\u0645\u0646 \u0648\u0627\u0644\u0623\u0643\u062b\u0631 \u0645\u0635\u062f\u0627\u0642\u064a\u0629 \u0644\u0645\u062a\u0627\u0628\u0639\u0629 \u0627\u0644\u062a\u0648\u0641\u0631 \u0648\u0627\u0644\u062a\u0641\u0627\u0635\u064a\u0644 \u0628\u0648\u0636\u0648\u062d. \u0623\u0631\u0633\u0644 \u0644\u064a \u0627\u0644\u0645\u0637\u0644\u0648\u0628 \u0648\u0633\u0623\u062e\u062f\u0645\u0643 \u062e\u0637\u0648\u0629 \u0628\u062e\u0637\u0648\u0629.`,
			share: `${name}\u060c \u062e\u0637 \u0627\u0644\u0647\u0627\u062a\u0641/\u0648\u0627\u062a\u0633\u0627\u0628 \u0627\u0644\u0645\u062a\u0627\u062d \u0647\u0648 ${phone}. \u0648\u0645\u0639 \u0630\u0644\u0643 \u0623\u0646\u0635\u062d\u0643 \u0623\u0646 \u062a\u0628\u0642\u064a \u062a\u0641\u0627\u0635\u064a\u0644 \u0627\u0644\u062d\u062c\u0632 \u0647\u0646\u0627 \u0623\u064a\u0636\u0627 \u062d\u062a\u0649 \u064a\u0631\u0627\u062c\u0639 \u0627\u0644\u0627\u0633\u062a\u0642\u0628\u0627\u0644 \u0627\u0644\u062a\u0648\u0641\u0631 \u0648\u0637\u0644\u0628\u0643 \u0628\u062f\u0648\u0646 \u0641\u0642\u062f\u0627\u0646 \u0627\u0644\u0633\u064a\u0627\u0642.`,
		},
		es: {
			first: `${name}, soy ${st.agentName} y trabajo directamente con la recepcion de ${hotelEn}. Este chat en vivo es la forma mas segura y creible de reservar, porque recepcion puede revisar disponibilidad en vivo y mantener todos los datos claros en un solo lugar. Escribeme lo que necesitas y lo gestiono contigo aqui.`,
			firm: `${name}, entiendo que quieres el numero. Trabajo directamente con la recepcion de ${hotelEn}, y continuar aqui es la forma mas segura y creible de completar la reserva con disponibilidad en vivo y datos claros. Dime que necesitas y lo llevo paso a paso.`,
			share: `${name}, la linea de telefono/WhatsApp que puedo compartir es ${phone}. Para que la reserva sea mas fluida, mantengamos tambien los detalles aqui para que recepcion pueda seguir la disponibilidad y tu solicitud sin perder contexto.`,
		},
		fr: {
			first: `${name}, je suis ${st.agentName} et je travaille directement avec la reception de ${hotelEn}. Ce chat en direct est le moyen le plus sur et le plus credible pour reserver, car la reception peut verifier la disponibilite en direct et garder les details clairs au meme endroit. Envoyez-moi votre demande et je la traite avec vous ici.`,
			firm: `${name}, je comprends que vous souhaitez le numero. Je travaille directement avec la reception de ${hotelEn}, et continuer ici est le moyen le plus sur et le plus credible de finaliser la reservation avec disponibilite en direct et details clairs. Dites-moi ce dont vous avez besoin et je m'en occupe etape par etape.`,
			share: `${name}, la ligne telephone/WhatsApp que je peux partager est ${phone}. Pour une reservation plus fluide, gardons aussi les details ici afin que la reception suive la disponibilite et votre demande sans perdre le contexte.`,
		},
		ur: {
			first: `${name}، میں ${st.agentName} ہوں اور ${hotelEn} کی ریسیپشن کے ساتھ براہ راست کام کر رہا/رہی ہوں۔ یہ لائیو چیٹ بکنگ کا سب سے محفوظ اور معتبر طریقہ ہے، کیونکہ ریسیپشن دستیابی براہ راست چیک کرتی ہے اور تمام تفصیلات ایک ہی جگہ واضح رہتی ہیں۔ آپ اپنی ضرورت لکھ دیں، میں یہیں مدد کرتا/کرتی ہوں۔`,
			firm: `${name}، میں سمجھتا/سمجھتی ہوں کہ آپ نمبر چاہتے ہیں۔ میں ${hotelEn} کی ریسیپشن کے ساتھ براہ راست کام کر رہا/رہی ہوں، اور یہاں جاری رکھنا بکنگ مکمل کرنے کا سب سے محفوظ اور معتبر طریقہ ہے کیونکہ دستیابی اور تفصیلات براہ راست واضح رہتی ہیں۔ آپ بتائیں کیا چاہیے، میں قدم بہ قدم مدد کرتا/کرتی ہوں۔`,
			share: `${name}، فون/WhatsApp لائن جو میں شیئر کر سکتا/سکتی ہوں یہ ہے: ${phone}. بہتر ریزرویشن کے لیے تفصیلات یہاں بھی رکھیں تاکہ ریسیپشن دستیابی اور درخواست کا مکمل سیاق دیکھ سکے۔`,
		},
		hi: {
			first: `${name}, मैं ${st.agentName} हूं और ${hotelEn} की reception के साथ directly काम कर रहा/रही हूं। यह live chat reservation के लिए सबसे सुरक्षित और credible तरीका है, क्योंकि reception live availability check करती है और सभी details एक जगह साफ रहती हैं। आप अपनी जरूरत लिख दीजिए, मैं यहीं help करता/करती हूं।`,
			firm: `${name}, मैं समझ रहा/रही हूं कि आपको number चाहिए। मैं ${hotelEn} की reception के साथ directly काम कर रहा/रही हूं, और यहां continue करना reservation complete करने का सबसे सुरक्षित और credible तरीका है क्योंकि live availability और details साफ रहती हैं। बताइए आपको क्या चाहिए, मैं step by step handle कर दूंगा/दूंगी।`,
			share: `${name}, जो phone/WhatsApp line मैं share कर सकता/सकती हूं वह है ${phone}. Smooth reservation के लिए details यहां भी रखें ताकि reception availability और आपकी request का context न खोए।`,
		},
		id: {
			first: `${name}, saya ${st.agentName} dan bekerja langsung dengan reception ${hotelEn}. Live chat ini adalah cara paling aman dan paling terpercaya untuk reservasi, karena reception bisa mengecek ketersediaan live dan menjaga semua detail tetap jelas di satu tempat. Tulis kebutuhan Anda, saya bantu di sini.`,
			firm: `${name}, saya mengerti Anda ingin nomor telepon. Saya bekerja langsung dengan reception ${hotelEn}, dan melanjutkan di sini adalah cara paling aman dan terpercaya untuk menyelesaikan reservasi dengan ketersediaan live dan detail yang jelas. Beri tahu saya kebutuhan Anda, saya bantu langkah demi langkah.`,
			share: `${name}, nomor telepon/WhatsApp yang bisa saya bagikan adalah ${phone}. Untuk reservasi yang paling lancar, simpan juga detailnya di sini agar reception bisa melacak ketersediaan dan permintaan Anda tanpa kehilangan konteks.`,
		},
		ms: {
			first: `${name}, saya ${st.agentName} dan bekerja terus dengan reception ${hotelEn}. Live chat ini cara paling selamat dan paling dipercayai untuk tempahan, kerana reception boleh semak availability secara live dan simpan semua butiran dengan jelas di satu tempat. Tulis apa yang anda perlukan, saya bantu di sini.`,
			firm: `${name}, saya faham anda mahu nombor telefon. Saya bekerja terus dengan reception ${hotelEn}, dan meneruskan di sini ialah cara paling selamat dan dipercayai untuk lengkapkan tempahan dengan availability live dan butiran yang jelas. Beritahu saya apa yang diperlukan, saya bantu langkah demi langkah.`,
			share: `${name}, talian telefon/WhatsApp yang boleh saya kongsi ialah ${phone}. Untuk tempahan yang paling lancar, kekalkan juga butiran di sini supaya reception boleh ikut availability dan permintaan anda tanpa hilang konteks.`,
		},
	};
	const chosen = templates[key] || templates.en;
	return firm ? chosen.firm : chosen.first;
}

function vagueHajjInquiryText(text = "") {
	const { lower, arabic, latinCompact } = normalizeControlText(text);
	const mentionsHajj =
		/\b(?:hajj|haj|hadj|pilgrimage)\b/i.test(lower) ||
		/(?:^|[^\u0621-\u064a])(?:[\u0628\u0644\u0643\u0641\u0633\u0648]{0,3}\u0627\u0644\u062d\u062c|[\u0628\u0644\u0643\u0641\u0633\u0648]{0,3}\u062d\u062c)(?:$|[^\u0621-\u064a])/i.test(
			arabic
		) ||
		/(?:hajj|haj|hadj|pilgrimage)/i.test(latinCompact);
	if (!mentionsHajj) return false;
	const onlyHijriMonth =
		/(?:\u0630\u0648\s*\u0627\u0644\u062d\u062c\u0629|dhul\s*hijj|dhu\s*al\s*hijj)/i.test(
			lower
		) &&
		!/\b(?:package|organize|organisation|organization|category|program|permit|visa|support|work|serve|available|offer)\b/i.test(
			lower
		) &&
		!/(?:\u0628\u0627\u0643\u062c|\u0628\u0631\u0646\u0627\u0645\u062c|\u062a\u0646\u0638\u064a\u0645|\u062a\u0635\u0631\u064a\u062d|\u062a\u0623\u0634\u064a\u0631\u0629|\u0641\u0626\u0629|\u0634\u063a\u0627\u0644\u064a\u0646|\u0645\u062a\u0627\u062d)/i.test(
			arabic
		);
	return !onlyHijriMonth;
}

function roomCapacityOrTypeInquiryText(text = "") {
	const raw = String(text || "");
	if (!raw.trim()) return false;
	const { lower, arabic, latinCompact } = normalizeControlText(raw);
	const hasRoomWord =
		/\b(?:room|rooms|bed|beds|suite|suites)\b/i.test(lower) ||
		/(?:\u063a\u0631\u0641\u0629|\u063a\u0631\u0641\u0647|\u063a\u0631\u0641|\u0623\u0648\u0636\u0629|\u0627\u0648\u0636\u0629|\u0633\u0631\u064a\u0631|\u0623\u0633\u0631\u0629|\u0627\u0633\u0631\u0629)/i.test(
			arabic
		) ||
		/(?:ghorfa|ghurfa|oda|room|bed)/i.test(latinCompact);
	const hasCapacityOrType =
		Boolean(mapRoomToKey(raw)) ||
		/\b(?:2|two|3|three|4|four|5|five)\s*(?:people|persons|guests|adults|beds?)\b/i.test(
			lower
		) ||
		/(?:\u0641\u0631\u062f|\u0627\u0641\u0631\u0627\u062f|\u0623\u0641\u0631\u0627\u062f|\u0634\u062e\u0635|\u0627\u0634\u062e\u0627\u0635|\u0623\u0634\u062e\u0627\u0635|\u062a\u0644\u062a|\u062b\u0644\u0627\u062b|\u062b\u0644\u0627\u062b\u0629|\u062b\u0644\u0627\u062b\u0647|\u0627\u0631\u0628\u0639|\u0623\u0631\u0628\u0639|\u0627\u0631\u0628\u0639\u0629|\u0631\u0628\u0627\u0639|\u062e\u0645\u0633|\u062e\u0645\u0627\u0633)/i.test(
			arabic
		);
	const hasBookingIntent =
		/\b(?:need|want|looking|book|reserve|help|available|availability|have|has)\b/i.test(
			lower
		) ||
		/(?:\u0639\u0627\u064a\u0632|\u0639\u0627\u0648\u0632|\u0623\u0628\u063a\u0649|\u0627\u0628\u063a\u0649|\u0623\u0631\u064a\u062f|\u0627\u0631\u064a\u062f|\u0627\u062d\u062a\u0627\u062c|\u0645\u0645\u0643\u0646|\u0633\u0627\u0639\u062f|\u0645\u062a\u0627\u062d|\u0627\u062d\u062c\u0632|\u0623\u062d\u062c\u0632)/i.test(
			arabic
		);
	return hasRoomWord && (hasCapacityOrType || hasBookingIntent);
}

function wantsNewReservationIntent(text = "", lu = {}) {
	if (lu?.intent === "reserve_room") return true;
	const raw = String(text || "");
	if (latestKnownConfirmation({}, lu) || explicitlyExistingReservationIntent(raw)) {
		return false;
	}
	if (/\b(reservasi|tempahan|pesan\s+kamar|tempah\s+bilik)\b/i.test(raw)) {
		return true;
	}
	return (
		/\b(book|reserve|make\s+(?:a\s+)?reservation|new\s+(?:booking|reservation)|book\s+a\s*room|reserve\s+a\s*room|need\s+a\s*room|want\s+a\s*room)\b/i.test(
			raw
		) ||
		/(?:\u0627\u062d\u062c\u0632|\u0623\u062d\u062c\u0632|\u062d\u062c\u0632\s+\u063a\u0631\u0641|\u0627\u0628\u063a\u0649\s+\u063a\u0631\u0641|\u0623\u0628\u063a\u0649\s+\u063a\u0631\u0641|\u0627\u0631\u064a\u062f\s+\u063a\u0631\u0641|\u0623\u0631\u064a\u062f\s+\u063a\u0631\u0641)/i.test(
			raw
		) ||
		/\b(reservar|reservacion|r[e\u00e9]server)\b/i.test(raw)
	);
}

function isoDate(value = "") {
	const date = new Date(String(value || "").trim());
	if (Number.isNaN(date.getTime())) return null;
	return date.toISOString().slice(0, 10);
}

function extractDateRange(text = "") {
	const raw = String(text || "");
	const isoMatches = raw.match(/\b20\d{2}-\d{2}-\d{2}\b/g);
	if (isoMatches && isoMatches.length >= 2) {
		return { checkinISO: isoMatches[0], checkoutISO: isoMatches[1] };
	}
	const monthPattern =
		"(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
	const regex = new RegExp(
		`${monthPattern}\\s+\\d{1,2}(?:,)?\\s+20\\d{2}`,
		"gi"
	);
	const matches = raw.match(regex);
	if (matches && matches.length >= 2) {
		return {
			checkinISO: isoDate(matches[0]),
			checkoutISO: isoDate(matches[1]),
		};
	}
	return { checkinISO: null, checkoutISO: null };
}

function todayISODate() {
	return new Date().toISOString().slice(0, 10);
}

function isPastDateISO(iso = "") {
	return /^\d{4}-\d{2}-\d{2}$/.test(String(iso || "")) && iso < todayISODate();
}

function explicitGregorianYearInDateInput(text = "", dates = {}) {
	const raw = [
		text,
		dates?.raw?.checkin || "",
		dates?.raw?.checkout || "",
		dates?.checkinISO || "",
		dates?.checkoutISO || "",
	]
		.filter(Boolean)
		.join(" ");
	const normalized = digitsToEnglish(raw);
	return /\b20\d{2}\b/.test(normalized);
}

function futureSameMonthDayRange(dates = {}) {
	if (!dates?.checkinISO || !dates?.checkoutISO) return null;
	let checkin = new Date(`${dates.checkinISO}T00:00:00Z`);
	let checkout = new Date(`${dates.checkoutISO}T00:00:00Z`);
	if (Number.isNaN(checkin.getTime()) || Number.isNaN(checkout.getTime())) {
		return null;
	}
	for (let guard = 0; guard < 8 && checkin.toISOString().slice(0, 10) < todayISODate(); guard += 1) {
		checkin.setUTCFullYear(checkin.getUTCFullYear() + 1);
		checkout.setUTCFullYear(checkout.getUTCFullYear() + 1);
	}
	return {
		checkinISO: checkin.toISOString().slice(0, 10),
		checkoutISO: checkout.toISOString().slice(0, 10),
	};
}

function needsExplicitPastDateClarification(text = "", dates = {}) {
	if (!dates?.checkinISO || !dates?.checkoutISO) return false;
	if (dates?.raw?.calendar === "hijri" || dates?.raw?.checkinHijri) return false;
	if (!explicitGregorianYearInDateInput(text, dates)) return false;
	return dates?.reason === "past_explicit_year" || isPastDateISO(dates.checkinISO);
}

function roomTypeLabel(roomTypeKey = "") {
	if (roomTypeKey === "singleRooms") return "single room";
	if (roomTypeKey === "doubleRooms") return "double room";
	if (roomTypeKey === "tripleRooms") return "triple room";
	if (roomTypeKey === "quadRooms") return "quad room";
	if (roomTypeKey === "familyRooms") return "family room";
	return "selected room";
}

function cleanCurrency(value) {
	return String(value || "SAR").toUpperCase();
}

const safeNum = (value, fallback = 0) => {
	const number = parseFloat(value);
	return Number.isFinite(number) ? number : fallback;
};

function safeAddDays(iso, days) {
	const date = new Date(`${iso}T00:00:00Z`);
	if (Number.isNaN(date.getTime())) return null;
	date.setUTCDate(date.getUTCDate() + days);
	return date.toISOString().slice(0, 10);
}

function safeStayDates(checkinISO, checkoutISO, maxNights = 60) {
	if (!checkinISO || !checkoutISO || checkinISO >= checkoutISO) return null;
	const dates = [];
	let current = checkinISO;
	for (let guard = 0; current < checkoutISO && guard < maxNights; guard += 1) {
		dates.push(current);
		current = safeAddDays(current, 1);
		if (!current) return null;
	}
	if (!dates.length || current < checkoutISO) return null;
	return dates;
}

function safeCommissionRate(hotel = {}, room = {}) {
	const hotelCommission =
		hotel.commission !== null && hotel.commission !== undefined && hotel.commission !== ""
			? safeNum(hotel.commission, 10)
			: 10;
	const fallback = hotelCommission >= 0 ? hotelCommission : 10;
	const roomCommission =
		room.roomCommission !== null &&
		room.roomCommission !== undefined &&
		room.roomCommission !== ""
			? safeNum(room.roomCommission, fallback)
			: fallback;
	return roomCommission >= 0 ? roomCommission : fallback;
}

function safePriceRoomForStay(hotel, { roomType }, checkinISO, checkoutISO) {
	const rooms = Array.isArray(hotel?.roomCountDetails)
		? hotel.roomCountDetails
		: [];
	const room = rooms.find((item) => item?.roomType === roomType);
	if (!room) {
		return {
			available: false,
			reason: "room_not_found",
			currency: hotel?.currency || "SAR",
			room: null,
		};
	}
	const dates = safeStayDates(checkinISO, checkoutISO);
	if (!dates) {
		return {
			available: false,
			reason: "bad_dates",
			currency: hotel?.currency || "SAR",
			room,
		};
	}

	const basePrice = safeNum(room?.price?.basePrice, 0);
	const defaultCost = safeNum(room?.defaultCost, 0);
	const commissionRate = safeCommissionRate(hotel, room);
	const rateMap = new Map();
	const pricingRates = Array.isArray(room.pricingRate) ? room.pricingRate : [];
	for (const rate of pricingRates.slice(0, 10000)) {
		if (!rate?.calendarDate) continue;
		rateMap.set(String(rate.calendarDate).slice(0, 10), rate);
	}

	const pricingByDay = [];
	const perNight = [];
	for (const date of dates) {
		const rate = rateMap.get(date);
		const dayPrice = rate ? safeNum(rate.price, basePrice) : basePrice;
		const dayRoot = rate ? safeNum(rate.rootPrice, defaultCost) : defaultCost;
		const dayComm = rate
			? safeNum(rate.commissionRate, commissionRate)
			: commissionRate;
		if (rate && (safeNum(rate.price, 0) === 0 || safeNum(rate.rootPrice, 0) === 0)) {
			return {
				available: false,
				reason: "blocked",
				currency: hotel?.currency || "SAR",
				room,
				nights: dates.length,
			};
		}
		const final = dayPrice + dayRoot * (dayComm / 100);
		pricingByDay.push({
			date,
			price: Number(dayPrice.toFixed(2)),
			rootPrice: Number(dayRoot.toFixed(2)),
			commissionRate: Number(dayComm.toFixed(2)),
			totalPriceWithCommission: Number(final.toFixed(2)),
			totalPriceWithoutCommission: Number(dayPrice.toFixed(2)),
		});
		perNight.push(Number(final.toFixed(2)));
	}

	const totalWithComm = pricingByDay.reduce(
		(total, row) => total + safeNum(row.totalPriceWithCommission, 0),
		0
	);
	const hotelShouldGet = pricingByDay.reduce(
		(total, row) => total + safeNum(row.rootPrice, 0),
		0
	);
	const totalCommission = Number((totalWithComm - hotelShouldGet).toFixed(2));
	return {
		available: true,
		reason: null,
		room,
		nights: dates.length,
		currency: hotel?.currency || "SAR",
		pricingByDay,
		perNight,
		totals: {
			totalPriceWithCommission: Number(totalWithComm.toFixed(2)),
			hotelShouldGet: Number(hotelShouldGet.toFixed(2)),
			totalCommission,
		},
	};
}

function simpleQuoteText({ sc, st, quote }) {
	const name = firstNameForAddress(
		st.slots?.name || st.slots?.fullName || sc.displayName1 || "Guest"
	);
	const lang = languageOf(sc, st);
	const hotelName = localizedHotelName(sc, st);
	const roomName = localizedRoomName(sc, st, quote);
	if (/arabic/i.test(lang)) {
		if (!quote.available) {
			return `\u0623\u0633\u062a\u0627\u0630 ${name}\u060c \u0644\u0627 \u0623\u0631\u0649 \u062a\u0648\u0641\u0631\u0627 \u0628\u0633\u0639\u0631 \u0645\u0624\u0643\u062f \u0644\u0640 ${roomName} \u0641\u064a ${hotelName} \u0644\u0647\u0630\u0647 \u0627\u0644\u062a\u0648\u0627\u0631\u064a\u062e. \u0623\u0642\u062f\u0631 \u0623\u0631\u0627\u062c\u0639 \u062a\u0648\u0627\u0631\u064a\u062e \u0623\u062e\u0631\u0649 \u0623\u0648 \u0646\u0648\u0639 \u063a\u0631\u0641\u0629 \u0622\u062e\u0631.`;
		}
		return `\u0623\u0633\u062a\u0627\u0630 ${name}\u060c ${roomName} \u0641\u064a ${hotelName} \u0628\u0625\u062c\u0645\u0627\u0644\u064a ${localizedMoney(
			quote.totals.totalPriceWithCommission,
			quote.currency,
			"Arabic"
		)} \u0644\u0645\u062f\u0629 ${localizedNumber(
			quote.nights,
			"Arabic"
		)} \u0644\u064a\u0627\u0644\u064a. \u0647\u0644 \u062a\u0631\u063a\u0628 \u0623\u0646 \u0623\u062a\u0627\u0628\u0639 \u0644\u0645\u0631\u0627\u062c\u0639\u0629 \u0627\u0644\u062d\u062c\u0632\u061f`;
	}
	if (!quote.available) {
		return `${name}, I do not see priced availability for ${roomName} at ${hotelName} on those dates. I can check another date range or another room type at ${hotelName}.`;
	}
	return `${name}, ${roomName} at ${hotelName} is ${quote.totals.totalPriceWithCommission} ${cleanCurrency(
		quote.currency
	)} total for ${quote.nights} nights. Would you like me to continue to the review step?`;
}

function crossHotelRequestText(text = "") {
	const { lower, arabic, latinCompact } = normalizeControlText(text);
	return (
		/\b(other|another|different|alternative|nearby|compare|recommend|suggest|best|cheaper)\s+(?:hotel|hotels|property|properties)\b/i.test(
			lower
		) ||
		/\b(?:hotel|hotels|property|properties)\s+(?:nearby|alternative|alternatives|recommendation|recommendations|suggestion|suggestions|comparison)\b/i.test(
			lower
		) ||
		/(?:فنادق\s+(?:اخرى|أخرى|قريبه|قريبة|بديله|بديلة)|فندق\s+(?:اخر|آخر|ثاني|تاني|بديل)|رشح\s+فندق|اقترح\s+فندق|قارن\s+الفنادق)/i.test(
			arabic
		) ||
		/(?:otherhotel|otherhotels|anotherhotel|nearbyhotel|nearbyhotels|alternativehotel|alternativehotels|recommendhotel|suggesthotel|comparehotels|fondo2tany|fonde2tany|fandokakhar|fanadokokhra)/i.test(
			latinCompact
		)
	);
}

function selectedHotelOnlyReply(sc = {}, st = {}, userText = "") {
	const hotelName = toTitle(st.hotel?.hotelName || "this hotel");
	const name = respectfulGuestName(sc, st);
	const lang = languageOf(sc, st);
	if (/arabic/i.test(lang)) {
		return `${name}، أقدر أساعدك هنا بخصوص ${hotelName} فقط. إذا تحب، أراجع لك التوفر أو نوع غرفة أو تواريخ مختلفة في ${hotelName}.`;
	}
	if (/spanish/i.test(lang)) {
		return `${name}, en este chat solo puedo ayudarte con ${hotelName}. Puedo revisar disponibilidad, otro tipo de habitacion o fechas diferentes en ${hotelName}.`;
	}
	if (/french/i.test(lang)) {
		return `${name}, dans ce chat je peux uniquement vous aider pour ${hotelName}. Je peux verifier la disponibilite, un autre type de chambre ou d'autres dates pour ${hotelName}.`;
	}
	if (/urdu/i.test(lang)) {
		return `${name}، اس چیٹ میں میں صرف ${hotelName} کے بارے میں مدد کر سکتا ہوں۔ چاہیں تو میں ${hotelName} میں دستیابی، دوسرے کمرے کی قسم، یا مختلف تاریخیں چیک کر سکتا ہوں۔`;
	}
	if (/hindi/i.test(lang)) {
		return `${name}, इस चैट में मैं सिर्फ ${hotelName} के लिए मदद कर सकता हूं। चाहें तो मैं ${hotelName} में उपलब्धता, दूसरे कमरे का प्रकार, या अलग तारीखें देख सकता हूं।`;
	}
	return `${name}, I can help with ${hotelName} only in this chat. I can check availability, another room type, or different dates at ${hotelName}.`;
}

function selectedHotelSupportBoundaryReply(sc = {}, st = {}) {
	const hotelName = localizedHotelName(sc, st);
	const name = respectfulGuestName(sc, st);
	const lang = languageOf(sc, st);
	if (/arabic/i.test(lang)) {
		return `${name}\u060c \u0623\u0642\u062f\u0631 \u0623\u0633\u0627\u0639\u062f\u0643 \u0647\u0646\u0627 \u0628\u062e\u0635\u0648\u0635 ${hotelName} \u0641\u0642\u0637\u060c \u0648\u0644\u0627 \u0623\u0645\u0644\u0643 \u062a\u0641\u0627\u0635\u064a\u0644\u0627 \u0645\u0624\u0643\u062f\u0629 \u0639\u0646 \u0641\u0646\u0627\u062f\u0642 \u0623\u062e\u0631\u0649 \u0645\u0646 \u0647\u0630\u0647 \u0627\u0644\u062f\u0631\u062f\u0634\u0629. \u0644\u0623\u064a \u0627\u0633\u062a\u0641\u0633\u0627\u0631 \u0639\u0627\u0645 \u0631\u0627\u0633\u0644 ${AI_SUPPORT_EMAIL}\u060c \u0648\u064a\u0633\u0639\u062f\u0646\u064a \u0647\u0646\u0627 \u0623\u0631\u0627\u062c\u0639 \u0644\u0643 ${hotelName} \u0641\u0642\u0637.`;
	}
	if (/spanish/i.test(lang)) {
		return `${name}, en este chat solo puedo ayudarte con ${hotelName}; no tengo detalles verificados sobre otros hoteles desde este soporte. Para una consulta general, escribe a ${AI_SUPPORT_EMAIL}. Aqui puedo revisar ${hotelName} solamente.`;
	}
	if (/french/i.test(lang)) {
		return `${name}, dans ce chat je peux uniquement vous aider pour ${hotelName}; je n'ai pas d'informations verifiees sur d'autres hotels ici. Pour une question generale, ecrivez a ${AI_SUPPORT_EMAIL}. Ici, je peux verifier ${hotelName} uniquement.`;
	}
	return `${name}, I can help with ${hotelName} only in this chat, and I do not have verified details about other hotels from here. For general Jannat Booking questions, please email ${AI_SUPPORT_EMAIL}. I can still check ${hotelName} only in this chat.`;
}

function initialHotelGreetingText(sc = {}, st = {}) {
	const name = respectfulGuestName(sc, st);
	const hotelName = toTitle(st.hotel?.hotelName || sc.displayName2 || "the hotel");
	const agentName = st.agentName || "Sara";
	const lang = languageOf(sc, st);
	if (/arabic/i.test(lang)) {
		return `\u0623\u0647\u0644\u0627\u064b ${name}\u060c \u0645\u0639\u0643 ${agentName} \u0645\u0646 \u0627\u0633\u062a\u0642\u0628\u0627\u0644 \u0648\u062d\u062c\u0648\u0632\u0627\u062a ${hotelName}. \u0643\u064a\u0641 \u0623\u0642\u062f\u0631 \u0623\u0633\u0627\u0639\u062f\u0643 \u0627\u0644\u064a\u0648\u0645\u061f`;
	}
	if (/spanish/i.test(lang)) {
		return `Hola ${name}, soy ${agentName} de recepcion y reservas de ${hotelName}. Como puedo ayudarte hoy?`;
	}
	if (/french/i.test(lang)) {
		return `Bonjour ${name}, je suis ${agentName}, reception et reservations de ${hotelName}. Comment puis-je vous aider aujourd'hui ?`;
	}
	return `Hello ${name}, this is ${agentName} from ${hotelName} reception and reservations. How can I help you today?`;
}

function hotelComplaintText(text = "") {
	const { lower, arabic, latinCompact } = normalizeControlText(text);
	return (
		/\b(complain|complaint|bad experience|terrible|unsafe|dirty|unclean|rude|mistreat|overcharg|fraud|scam|not as described|no one helped|hotel problem|hotel issue|manager|staff issue)\b/i.test(
			lower
		) ||
		/(?:شكوى|اشتك|مشكلة|سيئ|وسخ|غير\s+نظيف|مو\s+نظيف|غير\s+آمن|نصب|احتيال|تعامل\s+سيئ|موظف\s+سيئ|ادارة\s+الفندق|إدارة\s+الفندق)/i.test(
			arabic
		) ||
		/(?:complain|complaint|badexperience|terrible|dirty|unclean|rude|scam|fraud|hotelproblem|hotelissue|shakwa|shakwaya|moshkela|mushkila|wese5|wasikh|naseb)/i.test(
			latinCompact
		)
	);
}

function jannatReservationHotelRedirectIntent(text = "", lu = {}, sc = {}) {
	return (
		looksLikeReservationDateUpdate(text, lu) ||
		wantsPaymentHelp(text) ||
		(explicitlyExistingReservationIntent(text) && wantsReservationHelp(text)) ||
		(Boolean(latestKnownConfirmation(sc, lu)) && wantsReservationHelp(text))
	);
}

function budgetFromText(text = "") {
	const normalized = digitsToEnglish(String(text || "").toLowerCase());
	const matches = [...normalized.matchAll(/(?:budget|around|about|max|maximum|under|up to|less than|below|حدود|ميزانية|ميزانيتي|اقصى|أقصى|تحت)?\s*(\d{2,6})(?:\s*(?:sar|riyal|riyal|ريال))?/gi)]
		.map((match) => Number(match[1]))
		.filter((value) => Number.isFinite(value) && value >= 50);
	if (!matches.length) return null;
	return Math.max(...matches);
}

function sameId(a, b) {
	const left = idText(a);
	const right = idText(b);
	return Boolean(left && right && left === right);
}

function platformOptionLine(option = {}, index = 0, hasDates = false) {
	const number = index + 1;
	const room = option.roomLabel || roomTypeLabel(option.roomTypeKey || "");
	const total =
		hasDates && Number(option.total || 0) > 0
			? ` - ${option.total} ${cleanCurrency(option.currency)} total for ${option.nights || "the stay"} nights`
			: "";
	const distance = [option.walking, option.driving].filter(Boolean).join(", ");
	return `${number}. ${option.hotelName} - ${room}${total}${
		distance ? ` - ${distance}` : ""
	}`;
}

function platformHotelOptionsFallbackText(sc = {}, st = {}, options = [], hasDates = false) {
	const lang = languageOf(sc, st);
	const name = respectfulGuestName(sc, st);
	if (!options.length) {
		if (/arabic/i.test(lang)) {
			return `${name}، لا أرى خيارات مناسبة متاحة الآن حسب التفاصيل الحالية. أرسل تواريخ أو ميزانية مختلفة وسأراجع لك أقرب خيارات مناسبة.`;
		}
		if (/spanish/i.test(lang)) {
			return `${name}, no veo opciones adecuadas disponibles ahora con esos detalles. Enviame otras fechas o presupuesto y reviso las mejores alternativas cercanas.`;
		}
		if (/french/i.test(lang)) {
			return `${name}, je ne vois pas d'options adaptees disponibles avec ces details. Envoyez d'autres dates ou un budget different et je verifierai les meilleures options proches.`;
		}
		return `${name}, I do not see a suitable available option with the current details. Send different dates or budget and I will check the closest good options.`;
	}
	const lines = options
		.slice(0, 4)
		.map((option, index) => platformOptionLine(option, index, hasDates));
	if (/arabic/i.test(lang)) {
		return [
			`${name}\u060c \u0647\u0630\u0647 \u0623\u0641\u0636\u0644 \u0627\u0644\u062e\u064a\u0627\u0631\u0627\u062a \u0627\u0644\u062a\u064a \u0648\u062c\u062f\u062a\u0647\u0627 \u0644\u0643:`,
			...lines,
			"\u062f\u0639\u0645 Jannat Booking \u064a\u0633\u0627\u0639\u062f\u0643 \u0641\u064a \u0627\u0644\u0645\u0642\u0627\u0631\u0646\u0629 \u0648\u0627\u0644\u0623\u0633\u0639\u0627\u0631\u060c \u0644\u0643\u0646 \u062a\u0623\u0643\u064a\u062f \u0627\u0644\u062d\u062c\u0632 \u0627\u0644\u0631\u0633\u0645\u064a \u0648\u0631\u0648\u0627\u0628\u0637 \u0627\u0644\u062a\u0641\u0627\u0635\u064a\u0644/\u0627\u0644\u062f\u0641\u0639 \u062a\u062a\u0645 \u0645\u0646 \u062e\u0644\u0627\u0644 \u0627\u0633\u062a\u0642\u0628\u0627\u0644 \u0648\u062d\u062c\u0648\u0632\u0627\u062a \u0627\u0644\u0641\u0646\u062f\u0642 \u0627\u0644\u0645\u062e\u062a\u0627\u0631.",
			"\u0623\u064a \u0641\u0646\u062f\u0642 \u062a\u062d\u0628 \u0623\u0646 \u0623\u0648\u0635\u0644\u0643 \u0628\u0627\u0633\u062a\u0642\u0628\u0627\u0644\u0647 \u0648\u062d\u062c\u0648\u0632\u0627\u062a\u0647\u061f",
		].join("\n");
	}
	if (/arabic/i.test(lang)) {
		return [
			`${name}، هذه أفضل الخيارات التي وجدتها لك:`,
			...lines,
			"دعم جنة بوكينج يساعدك في المقارنة والأسعار، لكن تأكيد الحجز الرسمي وروابط التفاصيل/الدفع تتم من خلال دعم الفندق المختار.",
			"أي فندق تحب أن أوصلك بدعمه؟",
		].join("\n");
	}
	if (/spanish/i.test(lang)) {
		return [
			`${name}, estas son las mejores opciones que encontre para ti:`,
			...lines,
			"Jannat Booking puede ayudarte a comparar opciones y precios, pero la confirmacion oficial y los enlaces de detalles/pago los completa la recepcion y reservas del hotel elegido.",
			"Con que hotel te gustaria que te conecte?",
		].join("\n");
	}
	if (/french/i.test(lang)) {
		return [
			`${name}, voici les meilleures options que j'ai trouvees pour vous :`,
			...lines,
			"Jannat Booking peut vous aider a comparer les options et les prix, mais la confirmation officielle et les liens details/paiement sont traites par la reception et les reservations de l'hotel choisi.",
			"A quel hotel souhaitez-vous que je vous connecte ?",
		].join("\n");
	}
	return [
		`${name}, these are the best options I found for you:`,
		...lines,
		"Jannat Booking can help compare options and pricing, but the official reservation confirmation and details/payment links are completed by the selected hotel's reception and reservations desk.",
		"Which hotel would you like me to connect you with?",
	].join("\n");
}

function ensurePlatformOptionsVisible(reply = "", sc = {}, st = {}, options = [], hasDates = false) {
	const text = String(reply || "").trim();
	if (!options.length) return text || platformHotelOptionsFallbackText(sc, st, options, hasDates);
	const visibleNames = options.filter((option) =>
		text.toLowerCase().includes(String(option.hotelName || "").toLowerCase())
	);
	if (visibleNames.length >= Math.min(2, options.length)) return text;
	return platformHotelOptionsFallbackText(sc, st, options, hasDates);
}

function transferSystemNoticeText(sc = {}, st = {}, { hotelName = "", agentName = "" } = {}) {
	const lang = languageOf(sc, st);
	if (/arabic/i.test(lang)) {
		return `\u062a\u0645 \u062a\u062d\u0648\u064a\u0644 \u0627\u0644\u0645\u062d\u0627\u062f\u062b\u0629 \u0625\u0644\u0649 \u0627\u0633\u062a\u0642\u0628\u0627\u0644 \u0648\u062d\u062c\u0648\u0632\u0627\u062a ${hotelName}. ${agentName || "\u0645\u0645\u062b\u0644 \u0627\u0644\u0641\u0646\u062f\u0642"} \u064a\u0631\u0627\u062c\u0639 \u0627\u0644\u0637\u0644\u0628 \u0627\u0644\u0622\u0646\u060c \u0648\u0633\u064a\u0639\u0648\u062f \u0644\u0643 \u0628\u0639\u062f \u0644\u062d\u0638\u0627\u062a.`;
	}
	if (/spanish/i.test(lang)) {
		return `La conversacion fue transferida a recepcion y reservas de ${hotelName}. ${agentName || "El representante del hotel"} esta revisando tu solicitud y respondera en unos momentos.`;
	}
	if (/french/i.test(lang)) {
		return `La conversation a ete transferee a la reception et aux reservations de ${hotelName}. ${agentName || "Le representant de l'hotel"} examine votre demande et repondra dans quelques instants.`;
	}
	if (/urdu/i.test(lang)) {
		return `This chat has been transferred to ${hotelName} reception and reservations. ${agentName || "The hotel representative"} is reviewing your request and will reply shortly.`;
	}
	if (/hindi/i.test(lang)) {
		return `This chat has been transferred to ${hotelName} reception and reservations. ${agentName || "The hotel representative"} is reviewing your request and will reply shortly.`;
	}
	return `This chat has been transferred to ${hotelName} reception and reservations. ${agentName || "The hotel representative"} is reviewing your request and will reply shortly.`;
}

function hotelHandoffQuoteIntroText(
	sc = {},
	st = {},
	optionOrHotel = {},
	{ hotelName = "", agentName = "" } = {}
) {
	const lang = languageOf(sc, st);
	const name = respectfulGuestName(sc, st);
	const quote = optionOrHotel?.quote || {};
	const total =
		optionOrHotel?.total || quote?.totals?.totalPriceWithCommission || "";
	const currency = cleanCurrency(optionOrHotel?.currency || quote?.currency || "SAR");
	const nights = optionOrHotel?.nights || quote?.nights || "";
	const room =
		optionOrHotel?.roomLabel ||
		quote?.room?.displayName ||
		quote?.room?.roomType ||
		roomTypeLabel(optionOrHotel?.roomTypeKey || st.slots?.roomTypeKey);
	const pricePart = total
		? `${total} ${currency}${nights ? ` total for ${nights} nights` : ""}`
		: "the selected priced option";
	if (/arabic/i.test(lang)) {
		return `${name}\u060c \u0645\u0639\u0643 ${agentName} \u0645\u0646 \u0627\u0633\u062a\u0642\u0628\u0627\u0644 \u0648\u062d\u062c\u0648\u0632\u0627\u062a ${hotelName}. \u0648\u0635\u0644\u062a\u0646\u064a \u062a\u0641\u0627\u0635\u064a\u0644 \u0627\u0644\u062e\u064a\u0627\u0631 \u0627\u0644\u0645\u062e\u062a\u0627\u0631: ${room} \u0628\u0633\u0639\u0631 ${pricePart}. \u0647\u0644 \u062a\u0631\u063a\u0628 \u0623\u0646 \u0623\u062a\u0627\u0628\u0639 \u0625\u0644\u0649 \u0645\u0631\u0627\u062c\u0639\u0629 \u0627\u0644\u062d\u062c\u0632 \u0627\u0644\u0631\u0633\u0645\u064a\u0629\u061f`;
	}
	if (/spanish/i.test(lang)) {
		return `Hola ${name}, soy ${agentName} de recepcion y reservas de ${hotelName}. Ya tengo la opcion seleccionada: ${room}, ${pricePart}. Quieres continuar a la revision oficial de la reserva?`;
	}
	if (/french/i.test(lang)) {
		return `Bonjour ${name}, je suis ${agentName}, reception et reservations de ${hotelName}. J'ai bien l'option selectionnee: ${room}, ${pricePart}. Souhaitez-vous continuer vers la verification officielle de la reservation ?`;
	}
	return `Hi ${name}, this is ${agentName} from ${hotelName} reception and reservations. I have the selected option ready: ${room}, ${pricePart}. Would you like to continue to the official reservation review?`;
}

function stabilizeHotelHandoffIntro(text = "", sc = {}, st = {}, optionOrHotel = {}, meta = {}) {
	if (!optionOrHotel?.quote?.available) return text;
	const value = String(text || "").trim();
	if (
		/check-?\s*in|check-?\s*out|send.*dates|share.*dates|fechas|entrada|salida|dates?/i.test(
			value
		)
	) {
		return hotelHandoffQuoteIntroText(sc, st, optionOrHotel, meta);
	}
	return value || hotelHandoffQuoteIntroText(sc, st, optionOrHotel, meta);
}

function platformHotelOptionQuickReplies(sc = {}, st = {}) {
	const options = Array.isArray(st.platformHotelOptions)
		? st.platformHotelOptions
		: [];
	const lang = languageOf(sc, st);
	return options.slice(0, 3).map((option, index) => {
		const number = index + 1;
		let label = `Connect to ${option.hotelName}`;
		if (/arabic/i.test(lang)) label = `تواصل مع ${option.hotelName}`;
		if (/spanish/i.test(lang)) label = `Conectar con ${option.hotelName}`;
		if (/french/i.test(lang)) label = `Contacter ${option.hotelName}`;
		if (/urdu/i.test(lang)) label = `${option.hotelName} سے رابطہ`;
		if (/hindi/i.test(lang)) label = `${option.hotelName} से जोड़ें`;
		return {
			label: label.slice(0, 80),
			value: `Connect me to option ${number}: ${option.hotelName}`,
			action: `connect_hotel_${number}`,
		};
	});
}

function parsePlatformHotelChoice(text = "", options = []) {
	if (!options.length) return -1;
	const { lower, latinCompact } = normalizeControlText(text);
	const digit = lower.match(/\b([1-4])\b/);
	if (digit) {
		const index = Number(digit[1]) - 1;
		return options[index] ? index : -1;
	}
	const actionDigit = lower.match(/connect\s+me\s+to\s+option\s+([1-4])/i);
	if (actionDigit) {
		const index = Number(actionDigit[1]) - 1;
		return options[index] ? index : -1;
	}
	if (/^(yes|yes please|please|ok|okay|sure|connect|go ahead|proceed|book it|reserve it)\b/i.test(lower)) {
		return options[0] ? 0 : -1;
	}
	const compact = latinCompact || lower.replace(/[^a-z0-9]/gi, "");
	const byName = options.findIndex((option) => {
		const name = String(option.hotelName || "").toLowerCase();
		const nameCompact = name.replace(/[^a-z0-9]/gi, "");
		return (
			(name && lower.includes(name)) ||
			(nameCompact && compact.includes(nameCompact))
		);
	});
	return byName >= 0 ? byName : -1;
}

function chooseHotelHandoffAgentName(caseId = "", hotelId = "", current = "") {
	const names = [
		process.env.B2C_AI_HOTEL_HANDOFF_NAMES,
		"Sara,Aisha,Amira,Yasmin,Nadia",
	]
		.flatMap((value) => String(value || "").split(","))
		.map((name) => String(name || "").trim())
		.filter(Boolean)
		.filter((name, index, list) => list.indexOf(name) === index)
		.filter((name) => name.toLowerCase() !== String(current || "").toLowerCase());
	if (!names.length) return current || "Sara";
	const seed = `${caseId}|${hotelId}`;
	const index =
		seed.split("").reduce((acc, char) => acc + char.charCodeAt(0), 0) %
		names.length;
	return names[index];
}

function roomMatches(room = {}, roomTypeKey = "doubleRooms") {
	return (
		room &&
		room.activeRoom &&
		room.roomType === roomTypeKey &&
		Number(room.price?.basePrice || 0) > 0
	);
}

function hotelCityText(hotel = {}) {
	return [
		hotel.hotelCity,
		hotel.hotelState,
		hotel.hotelAddress,
		hotel.aboutHotel,
		hotel.aboutHotelArabic,
	]
		.filter(Boolean)
		.join(" ")
		.toLowerCase();
}

function isMakkahHotel(hotel = {}) {
	const text = hotelCityText(hotel);
	return /\b(makkah|mecca|mekkah)\b|\u0645\u0643\u0629|\u0645\u0643\u0647/.test(text);
}

function wantsMakkahNearHaram(text = "") {
	const value = String(text || "").toLowerCase();
	const mentionsMadinah =
		/\b(madinah|medina|madina)\b|\u0627\u0644\u0645\u062f\u064a\u0646\u0629|\u0645\u062f\u064a\u0646\u0629|\u0645\u062f\u064a\u0646\u0647/.test(
			value
		);
	if (mentionsMadinah) return false;
	return /\b(makkah|mecca|mekkah|al\s*haram|haram|kaaba|ka'ba|umrah)\b|\u0645\u0643\u0629|\u0645\u0643\u0647|\u0627\u0644\u062d\u0631\u0645|\u0643\u0639\u0628\u0629|\u0639\u0645\u0631\u0629/.test(
		value
	);
}

function activeHotelRoomSummaries(hotel = {}, roomTypeKey = null) {
	const rooms = Array.isArray(hotel?.roomCountDetails)
		? hotel.roomCountDetails
		: [];
	return rooms
		.filter(
			(room) =>
				room?.activeRoom &&
				(!roomTypeKey || room.roomType === roomTypeKey)
		)
		.map((room) => ({
			roomType: room.roomType,
			displayName: room.displayName || room.roomType,
			displayNameOther: room.displayName_OtherLanguage || "",
			basePrice: room.price?.basePrice || 0,
			currency: hotel?.currency || "SAR",
		}));
}

function cleanHotelFactText(value = "") {
	return String(value || "")
		.replace(/\s+/g, " ")
		.trim();
}

function buildActiveHotelFacts(sc = {}, st = {}) {
	const hotel = st.hotel || null;
	if (!hotel) return null;
	const distances = hotel.distances || {};
	const busDetails = cleanHotelFactText(hotel.busDetails);
	return {
		displayName: localizedHotelName(sc, st),
		hotelName: hotel.hotelName || "",
		hotelNameOtherLanguage: hotel.hotelName_OtherLanguage || "",
		address: cleanHotelFactText(hotel.hotelAddress),
		city: cleanHotelFactText(hotel.hotelCity),
		state: cleanHotelFactText(hotel.hotelState),
		country: cleanHotelFactText(hotel.hotelCountry),
		aboutHotel: cleanHotelFactText(hotel.aboutHotel),
		aboutHotelArabic: cleanHotelFactText(hotel.aboutHotelArabic),
		distances: {
			walkingToElHaram: distances.walkingToElHaram || "",
			drivingToElHaram: distances.drivingToElHaram || "",
		},
		location: hotel.location || null,
		parkingLot: hotel.parkingLot === true,
		hasBusService: hotel.hasBusService === true,
		busDetails,
		activeRooms: activeHotelRoomSummaries(hotel).slice(0, 12),
	};
}

function inlineRoomOptions(options = [], lang = "") {
	const useArabic = /arabic/i.test(lang);
	return options
		.map((option) =>
			String(
				useArabic && hasArabicScript(option?.displayNameOther)
					? option.displayNameOther
					: option?.displayName || option?.roomType || ""
			).trim()
		)
		.filter(Boolean)
		.slice(0, 5)
		.join(" / ");
}

function roomPreferenceSalesText(sc = {}, st = {}) {
	const name = respectfulGuestName(sc, st);
	const hotelName = toTitle(st.hotel?.hotelName || sc.displayName2 || "the hotel");
	const lang = languageOf(sc, st);
	const options = inlineRoomOptions(
		activeHotelRoomSummaries(st.hotel).slice(0, 5),
		lang
	);
	if (/arabic/i.test(lang)) {
		return options
			? `${name}\u060c \u0628\u0627\u0644\u062a\u0623\u0643\u064a\u062f. \u0641\u064a ${hotelName} \u0623\u0642\u062f\u0631 \u0623\u0633\u0627\u0639\u062f\u0643 \u062a\u062e\u062a\u0627\u0631 \u0627\u0644\u063a\u0631\u0641\u0629 \u0627\u0644\u0623\u0646\u0633\u0628. \u0627\u0644\u062e\u064a\u0627\u0631\u0627\u062a \u0627\u0644\u0645\u062a\u0627\u062d\u0629 \u062a\u0634\u0645\u0644: ${options}. \u0623\u064a \u0646\u0648\u0639 \u063a\u0631\u0641\u0629 \u062a\u0641\u0636\u0644 \u0644\u0644\u062d\u062c\u0632\u061f`
			: `${name}\u060c \u0628\u0627\u0644\u062a\u0623\u0643\u064a\u062f. \u0623\u0642\u062f\u0631 \u0623\u0633\u0627\u0639\u062f\u0643 \u062a\u062e\u062a\u0627\u0631 \u0627\u0644\u063a\u0631\u0641\u0629 \u0627\u0644\u0623\u0646\u0633\u0628. \u0645\u0627 \u0646\u0648\u0639 \u0627\u0644\u063a\u0631\u0641\u0629 \u0623\u0648 \u0639\u062f\u062f \u0627\u0644\u0636\u064a\u0648\u0641\u061f`;
	}
	if (/spanish/i.test(lang)) {
		return options
			? `${name}, claro. En ${hotelName} puedo ayudarte a elegir la habitacion adecuada. Tenemos opciones como: ${options}. Que tipo de habitacion quieres reservar?`
			: `${name}, claro. Puedo ayudarte a elegir la habitacion adecuada. Que tipo de habitacion o cuantos huespedes necesitas?`;
	}
	if (/french/i.test(lang)) {
		return options
			? `${name}, bien sur. A ${hotelName}, je peux vous aider a choisir la chambre qui convient. Nous avons notamment : ${options}. Quel type de chambre souhaitez-vous reserver ?`
			: `${name}, bien sur. Je peux vous aider a choisir la chambre qui convient. Quel type de chambre ou combien de personnes faut-il prevoir ?`;
	}
	return options
		? `${name}, of course. At ${hotelName}, I can help you choose the right room. We currently have ${options}; which room type would you like to book?`
		: `${name}, of course. I can help you choose the right room. Which room type or guest count should I prepare for you?`;
}

function roomCapacityLabel(roomTypeKey = "", lang = "English") {
	const isArabic = /arabic/i.test(lang);
	const labels = {
		doubleRooms: isArabic ? "\u0636\u064a\u0641\u064a\u0646" : "2 guests",
		tripleRooms: isArabic ? "\u062b\u0644\u0627\u062b\u0629 \u0636\u064a\u0648\u0641" : "3 guests",
		quadRooms: isArabic ? "\u0623\u0631\u0628\u0639\u0629 \u0636\u064a\u0648\u0641" : "4 guests",
		familyRooms: isArabic ? "\u062e\u0645\u0633\u0629 \u0636\u064a\u0648\u0641" : "5 guests",
	};
	return labels[roomTypeKey] || "";
}

function roomFitSalesIntroText(sc = {}, st = {}, roomTypeKey = "", rooms = []) {
	const name = respectfulGuestName(sc, st);
	const lang = languageOf(sc, st);
	const hotelName = localizedHotelName(sc, st);
	const roomNames = inlineRoomOptions(rooms, lang) || roomTypeLabel(roomTypeKey);
	const capacity = roomCapacityLabel(roomTypeKey, lang);
	if (/arabic/i.test(lang)) {
		const fit = capacity
			? ` \u0648\u0647\u0648 \u062e\u064a\u0627\u0631 \u0645\u0646\u0627\u0633\u0628 \u0644\u0640${capacity}`
			: "";
		return `${name}\u060c \u0628\u0627\u0644\u062a\u0623\u0643\u064a\u062f \u0623\u0642\u062f\u0631 \u0623\u0633\u0627\u0639\u062f\u0643. \u0641\u064a ${hotelName} \u0639\u0646\u062f\u0646\u0627 ${roomNames}${fit}. \u0623\u0631\u0633\u0644 \u0644\u064a \u062a\u0627\u0631\u064a\u062e \u0627\u0644\u0648\u0635\u0648\u0644 \u0648\u0627\u0644\u0645\u063a\u0627\u062f\u0631\u0629 \u0644\u0623\u0631\u0627\u062c\u0639 \u0644\u0643 \u0627\u0644\u062a\u0648\u0641\u0631 \u0648\u0627\u0644\u0633\u0639\u0631 \u0628\u062f\u0642\u0629.`;
	}
	if (/spanish/i.test(lang)) {
		const fit = capacity ? ` y encaja bien para ${capacity}` : "";
		return `${name}, claro que puedo ayudarte. En ${hotelName} tenemos ${roomNames}${fit}. Enviame la fecha de llegada y salida para revisar disponibilidad y precio exactos.`;
	}
	if (/french/i.test(lang)) {
		const fit = capacity ? ` et cela convient pour ${capacity}` : "";
		return `${name}, bien sur, je peux vous aider. A ${hotelName}, nous avons ${roomNames}${fit}. Envoyez-moi les dates d'arrivee et de depart pour verifier la disponibilite et le prix exact.`;
	}
	const fit = capacity ? `, which is a suitable fit for ${capacity}` : "";
	return `${name}, of course. At ${hotelName}, we have ${roomNames}${fit}. Send me the check-in and check-out dates and I will check the exact availability and price for you.`;
}

function shouldAskRoomPreferenceFirst(userText = "", st = {}, lu = {}, decision = {}) {
	if (st.slots?.roomTypeKey) return false;
	if (explicitlyExistingReservationIntent(userText)) return false;
	if (wantsPaymentHelp(userText) || humanHandoffReason(userText)) return false;
	if (st.waitFor === "room") return true;
	if (wantsNewReservationIntent(userText, lu)) return true;
	if (
		decision?.action === "continue_booking" ||
		decision?.action === "ask_dates_for_price"
	) {
		return true;
	}
	return false;
}

async function askRoomPreferenceForReservation(io, sc, st) {
	const sent = await humanSend(io, sc, st, roomPreferenceSalesText(sc, st));
	if (!sent) return false;
	st.waitFor = "room";
	stampAsk(st, "room");
	return true;
}

async function answerSelectedHotelRoomQuestion(
	io,
	sc,
	st,
	userText,
	roomTypeKey = null
) {
	const hotelName = toTitle(st.hotel?.hotelName || "the hotel");
	const matchingRooms = roomTypeKey
		? activeHotelRoomSummaries(st.hotel, roomTypeKey)
		: [];
	const activeRooms = activeHotelRoomSummaries(st.hotel).slice(0, 8);
	if (
		roomTypeKey &&
		matchingRooms.length &&
		st.slots.checkinISO &&
		st.slots.checkoutISO
	) {
		st.slots.roomTypeKey = roomTypeKey;
		await shareKnownStayQuote(io, sc, st);
		return;
	}
	if (roomTypeKey && matchingRooms.length) {
		st.slots.roomTypeKey = roomTypeKey;
		const sent = await humanSend(
			io,
			sc,
			st,
			roomFitSalesIntroText(sc, st, roomTypeKey, matchingRooms)
		);
		if (!sent) return;
		st.waitFor = "dates";
		stampAsk(st, "dates");
		return;
	}
	const instruction = roomTypeKey
		? matchingRooms.length
			? `The guest is asking whether the selected hotel has a room that fits their requested type/capacity. Answer only for "${hotelName}". Lead with the answer, not with a date question. Use a natural hospitality/sales tone: confirm that the matching room exists, mention why the provided matching room name fits the guest's capacity, and sound pleased to help. Mention only the matching room name(s) provided; do not list other hotels, compare hotels, link other hotels, or imply knowledge of other hotels under any circumstance. If dates are missing, add one soft next-step invitation to share dates so availability and price can be checked.`
			: `The guest is asking whether the selected hotel has the requested room type. Answer only for "${hotelName}". Say you do not currently see that room type listed as active for this hotel. Ask one helpful follow-up about another room type at this hotel or different dates at this hotel. Do not mention, recommend, link, compare, or imply knowledge of any other hotel.`
		: `The guest is asking about rooms at the selected hotel. Answer only for "${hotelName}" using the provided active room options, then ask the single most useful next booking question. Never mention, recommend, link, compare, or imply knowledge of any other hotel, even if the guest asks for alternatives.`;
	const reply = await write(io, sc, st, instruction, {
		latestUserMessage: userText,
		selectedHotel: hotelName,
		requestedRoomTypeKey: roomTypeKey,
		matchingRooms: matchingRooms.slice(0, 3),
		activeRoomOptions: matchingRooms.length ? [] : activeRooms,
		slots: st.slots,
	});
	const sent = await humanSend(io, sc, st, reply);
	if (!sent) return;
	if (roomTypeKey) st.slots.roomTypeKey = roomTypeKey;
	st.waitFor = roomTypeKey && matchingRooms.length ? "dates" : "room";
}

function cleanHotelFactValue(value) {
	if (value === null || value === undefined) return "";
	if (typeof value === "number") {
		return Number.isFinite(value) && value > 0 ? String(value) : "";
	}
	const text = cleanHotelFactText(value);
	if (!text || text === "0") return "";
	return text;
}

function formatHotelFactText(value, lang = "English") {
	const text = cleanHotelFactValue(value);
	if (!text) return "";
	if (/arabic/i.test(lang)) return arabicDigits(text);
	if (hasArabicScript(text)) return text;
	return toTitle(text);
}

function formatHotelDistanceValue(value, lang = "English") {
	const text = cleanHotelFactValue(value);
	if (!text) return "";
	const numberMatch = text.match(/^\d+(?:\.\d+)?$/);
	if (numberMatch) {
		const numericAmount = Number(numberMatch[0]);
		const amount = localizedNumber(numericAmount, lang);
		if (/arabic/i.test(lang)) {
			if (numericAmount === 1) return "\u062f\u0642\u064a\u0642\u0629 \u0648\u0627\u062d\u062f\u0629";
			if (numericAmount === 2) return "\u062f\u0642\u064a\u0642\u062a\u064a\u0646";
			if (numericAmount >= 3 && numericAmount <= 10) {
				return `${amount} \u062f\u0642\u0627\u0626\u0642`;
			}
			return `${amount} \u062f\u0642\u064a\u0642\u0629`;
		}
		if (/spanish/i.test(lang)) return `${amount} minutos`;
		if (/french/i.test(lang)) return `${amount} minutes`;
		if (/urdu/i.test(lang)) return `${amount} منٹ`;
		if (/hindi/i.test(lang)) return `${amount} मिनट`;
		if (/indonesian/i.test(lang)) return `${amount} menit`;
		if (/malay|malaysia/i.test(lang)) return `${amount} minit`;
		return `${amount} minutes`;
	}
	return /arabic/i.test(lang) ? arabicDigits(text) : text;
}

function localizedJoin(parts = [], lang = "English") {
	const values = parts.map((part) => String(part || "").trim()).filter(Boolean);
	if (!values.length) return "";
	if (values.length === 1) return values[0];
	const last = values[values.length - 1];
	if (/arabic/i.test(lang)) {
		const head = values.slice(0, -1).join("\u060c ");
		return `${head} \u0648${last}`;
	}
	const head = values.slice(0, -1).join(", ");
	let conjunction = "and";
	if (/spanish/i.test(lang)) conjunction = "y";
	else if (/french/i.test(lang)) conjunction = "et";
	else if (/urdu/i.test(lang)) conjunction = "اور";
	else if (/hindi/i.test(lang)) conjunction = "और";
	else if (/indonesian|malay|malaysia/i.test(lang)) conjunction = "dan";
	return `${head} ${conjunction} ${last}`;
}

function hotelFactAddressLine(hotel = {}, lang = "English") {
	const parts = [
		formatHotelFactText(hotel.hotelAddress, lang),
		formatHotelFactText(hotel.hotelCity, lang),
		formatHotelFactText(hotel.hotelState, lang),
		formatHotelFactText(hotel.hotelCountry, lang),
	].filter(Boolean);
	return parts.join(/arabic/i.test(lang) ? "\u060c " : ", ");
}

function hotelFactNextStepText(sc = {}, st = {}) {
	const lang = languageOf(sc, st);
	const pivot = nextPivot(st);
	if (/arabic/i.test(lang)) {
		if (pivot === "proceed") {
			return "\u0648\u0625\u0630\u0627 \u0627\u0644\u0645\u0648\u0642\u0639 \u0645\u0646\u0627\u0633\u0628 \u0644\u0643\u060c \u0623\u062a\u0627\u0628\u0639 \u0625\u0644\u0649 \u0645\u0631\u0627\u062c\u0639\u0629 \u0627\u0644\u062d\u062c\u0632\u061f";
		}
		if (pivot === "dates") {
			return "\u0625\u0630\u0627 \u0627\u0644\u0645\u0648\u0642\u0639 \u0645\u0646\u0627\u0633\u0628 \u0644\u0643\u060c \u0623\u0631\u0633\u0644 \u0644\u064a \u062a\u0627\u0631\u064a\u062e \u0627\u0644\u0648\u0635\u0648\u0644 \u0648\u0627\u0644\u0645\u063a\u0627\u062f\u0631\u0629 \u0644\u0623\u0631\u0627\u062c\u0639 \u0627\u0644\u062a\u0648\u0641\u0631 \u0648\u0627\u0644\u0633\u0639\u0631 \u0628\u062f\u0642\u0629.";
		}
		if (pivot === "room") {
			return "\u0625\u0630\u0627 \u0627\u0644\u0645\u0648\u0642\u0639 \u0645\u0646\u0627\u0633\u0628 \u0644\u0643\u060c \u0645\u0627 \u0646\u0648\u0639 \u0627\u0644\u063a\u0631\u0641\u0629 \u0623\u0648 \u0639\u062f\u062f \u0627\u0644\u0636\u064a\u0648\u0641 \u0627\u0644\u0630\u064a \u062a\u0641\u0636\u0644\u0647\u061f";
		}
		return "\u0647\u0644 \u0623\u0633\u0627\u0639\u062f\u0643 \u0641\u064a \u0623\u064a \u062a\u0641\u0635\u064a\u0644 \u0622\u062e\u0631 \u0644\u0644\u062d\u062c\u0632\u061f";
	}
	if (/spanish/i.test(lang)) {
		if (pivot === "proceed") return "Si la ubicacion te va bien, continuo a la revision de la reserva?";
		if (pivot === "dates") return "Si la ubicacion te va bien, enviame la fecha de llegada y salida para revisar disponibilidad y precio exactos.";
		if (pivot === "room") return "Si la ubicacion te va bien, que tipo de habitacion o cuantos huespedes necesitas?";
		return "Hay algun otro detalle de la reserva en el que pueda ayudarte?";
	}
	if (/french/i.test(lang)) {
		if (pivot === "proceed") return "Si l'emplacement vous convient, je passe a la revision de la reservation ?";
		if (pivot === "dates") return "Si l'emplacement vous convient, envoyez-moi les dates d'arrivee et de depart pour verifier la disponibilite et le prix exact.";
		if (pivot === "room") return "Si l'emplacement vous convient, quel type de chambre ou combien de personnes faut-il prevoir ?";
		return "Puis-je vous aider avec un autre detail de la reservation ?";
	}
	if (/urdu/i.test(lang)) {
		if (pivot === "proceed") return "اگر مقام آپ کے لیے مناسب ہے تو کیا میں بکنگ ریویو کے مرحلے پر آگے بڑھوں؟";
		if (pivot === "dates") return "اگر مقام مناسب ہے تو arrival اور departure dates بھیج دیں، میں availability اور exact price چیک کر دیتا/دیتی ہوں۔";
		if (pivot === "room") return "اگر مقام مناسب ہے تو آپ کس room type یا کتنے guests کے لیے بکنگ چاہتے ہیں؟";
		return "کیا بکنگ کے بارے میں کسی اور چیز میں مدد کر سکتا/سکتی ہوں؟";
	}
	if (/hindi/i.test(lang)) {
		if (pivot === "proceed") return "अगर location आपके लिए ठीक है, तो क्या मैं reservation review step पर आगे बढ़ूं?";
		if (pivot === "dates") return "अगर location ठीक है, तो check-in और check-out dates भेज दीजिए, मैं exact availability और price check कर दूंगा/दूंगी।";
		if (pivot === "room") return "अगर location ठीक है, तो आप कौन सा room type या कितने guests के लिए booking चाहते हैं?";
		return "क्या reservation में किसी और चीज़ में help करूं?";
	}
	if (/indonesian/i.test(lang)) {
		if (pivot === "proceed") return "Jika lokasinya cocok, saya lanjutkan ke tahap review reservasi?";
		if (pivot === "dates") return "Jika lokasinya cocok, kirim tanggal check-in dan check-out agar saya cek ketersediaan dan harga pastinya.";
		if (pivot === "room") return "Jika lokasinya cocok, tipe kamar atau jumlah tamu berapa yang Anda butuhkan?";
		return "Ada detail reservasi lain yang bisa saya bantu?";
	}
	if (/malay|malaysia/i.test(lang)) {
		if (pivot === "proceed") return "Jika lokasi ini sesuai, saya teruskan ke langkah semakan tempahan?";
		if (pivot === "dates") return "Jika lokasi ini sesuai, hantar tarikh check-in dan check-out supaya saya boleh semak availability dan harga tepat.";
		if (pivot === "room") return "Jika lokasi ini sesuai, jenis bilik atau berapa tetamu yang anda perlukan?";
		return "Ada butiran tempahan lain yang boleh saya bantu?";
	}
	if (pivot === "proceed") return "If the location works for you, shall I continue to the reservation review?";
	if (pivot === "dates") return "If the location works for you, send me the check-in and check-out dates and I will check the exact availability and price.";
	if (pivot === "room") return "If the location works for you, which room type or guest count should I prepare for you?";
	return "Is there anything else I can help with for the reservation?";
}

function hotelBusServiceYesText(lang, name, details, next) {
	const detailText = String(details || "").replace(/[.!?\u061f\u06d4]+$/g, "");
	if (/arabic/i.test(lang)) {
		return detailText
			? `${name}\u060c \u0646\u0639\u0645\u060c \u0644\u062f\u064a\u0646\u0627 \u062e\u062f\u0645\u0629 \u0628\u0627\u0635 \u0644\u0644\u0636\u064a\u0648\u0641. ${detailText}. ${next}`
			: `${name}\u060c \u0646\u0639\u0645\u060c \u0644\u062f\u064a\u0646\u0627 \u062e\u062f\u0645\u0629 \u0628\u0627\u0635 \u0644\u0644\u0636\u064a\u0648\u0641\u060c \u0648\u0633\u0623\u0633\u0627\u0639\u062f\u0643 \u0647\u0646\u0627 \u0628\u0623\u064a \u062a\u0641\u0627\u0635\u064a\u0644 \u062a\u062d\u062a\u0627\u062c\u0647\u0627 \u0644\u0644\u062d\u062c\u0632. ${next}`;
	}
	if (/spanish/i.test(lang)) {
		return detailText
			? `${name}, si, tenemos servicio de bus para los huespedes. ${detailText}. ${next}`
			: `${name}, si, tenemos servicio de bus para los huespedes y puedo ayudarte aqui con los detalles de la reserva. ${next}`;
	}
	if (/french/i.test(lang)) {
		return detailText
			? `${name}, oui, nous avons un service de bus pour les clients. ${detailText}. ${next}`
			: `${name}, oui, nous avons un service de bus pour les clients et je peux vous aider ici avec les details de la reservation. ${next}`;
	}
	if (/urdu/i.test(lang)) {
		return detailText
			? `${name}, ji haan, ham guests ke liye bus service provide karte hain. ${detailText}. ${next}`
			: `${name}, ji haan, ham guests ke liye bus service provide karte hain aur reservation details mein yahin help kar sakte hain. ${next}`;
	}
	if (/hindi/i.test(lang)) {
		return detailText
			? `${name}, ji haan, hum guests ke liye bus service provide karte hain. ${detailText}. ${next}`
			: `${name}, ji haan, hum guests ke liye bus service provide karte hain aur reservation details mein yahin help kar sakte hain. ${next}`;
	}
	if (/indonesian/i.test(lang)) {
		return detailText
			? `${name}, ya, kami menyediakan layanan bus untuk tamu. ${detailText}. ${next}`
			: `${name}, ya, kami menyediakan layanan bus untuk tamu dan saya bisa membantu detail reservasinya di sini. ${next}`;
	}
	if (/malay|malaysia/i.test(lang)) {
		return detailText
			? `${name}, ya, kami menyediakan perkhidmatan bus untuk tetamu. ${detailText}. ${next}`
			: `${name}, ya, kami menyediakan perkhidmatan bus untuk tetamu dan saya boleh bantu butiran tempahan di sini. ${next}`;
	}
	return detailText
		? `${name}, yes, we provide bus service for guests. ${detailText}. ${next}`
		: `${name}, yes, we provide bus service for guests, and I can help with the reservation details here. ${next}`;
}

function hotelBusServiceNoText(lang, name, hotelName, walking, next) {
	if (/arabic/i.test(lang)) {
		const walkingLine = walking
			? ` ${hotelName} \u064a\u0628\u0639\u062f \u0639\u0646 \u0627\u0644\u062d\u0631\u0645 \u062a\u0642\u0631\u064a\u0628\u0627 ${walking} \u0645\u0634\u064a\u0627\u060c`
			: "";
		return `${name}\u060c \u0644\u0627\u060c \u0644\u0627 \u0646\u0648\u0641\u0631 \u062d\u0627\u0644\u064a\u0627 \u062e\u062f\u0645\u0629 \u0628\u0627\u0635 \u062e\u0627\u0635\u0629.${walkingLine} \u0644\u0643\u0646 \u062a\u0648\u062c\u062f \u0628\u0627\u0635\u0627\u062a \u0639\u0627\u0645\u0629 \u0642\u0631\u064a\u0628\u0629 \u0645\u0646 \u0627\u0644\u0641\u0646\u062f\u0642 \u0648\u064a\u0645\u0643\u0646\u0647\u0627 \u0625\u064a\u0635\u0627\u0644 \u0627\u0644\u0636\u064a\u0648\u0641 \u0625\u0644\u0649 \u0627\u0644\u062d\u0631\u0645. ${next}`;
	}
	if (/spanish/i.test(lang)) {
		return `${name}, no, actualmente no ofrecemos un bus privado.${walking ? ` ${hotelName} esta a unos ${walking} caminando de Al Haram,` : ""} pero hay buses publicos cerca del hotel que pueden llevar a los huespedes a Al Haram. ${next}`;
	}
	if (/french/i.test(lang)) {
		return `${name}, non, nous ne proposons pas actuellement de bus prive.${walking ? ` ${hotelName} se trouve a environ ${walking} a pied d'Al Haram,` : ""} mais des bus publics sont disponibles pres de l'hotel et peuvent deposer les clients a Al Haram. ${next}`;
	}
	if (/urdu/i.test(lang)) {
		return `${name}, nahi, ham filhal private bus service provide nahi karte.${walking ? ` ${hotelName} Al Haram se taqriban ${walking} paidal hai,` : ""} lekin public buses hotel ke qareeb available hain aur guests ko Al Haram tak drop kar sakti hain. ${next}`;
	}
	if (/hindi/i.test(lang)) {
		return `${name}, nahi, hum filhal private bus service provide nahi karte.${walking ? ` ${hotelName} Al Haram se lagbhag ${walking} paidal hai,` : ""} lekin public buses hotel ke paas available hain aur guests ko Al Haram tak drop kar sakti hain. ${next}`;
	}
	if (/indonesian/i.test(lang)) {
		return `${name}, tidak, saat ini kami belum menyediakan layanan bus pribadi.${walking ? ` ${hotelName} sekitar ${walking} berjalan kaki dari Al Haram,` : ""} tetapi bus umum tersedia dekat hotel dan dapat mengantar tamu ke Al Haram. ${next}`;
	}
	if (/malay|malaysia/i.test(lang)) {
		return `${name}, tidak, buat masa ini kami belum menyediakan perkhidmatan bus khas.${walking ? ` ${hotelName} kira-kira ${walking} berjalan kaki dari Al Haram,` : ""} tetapi bus awam tersedia berhampiran hotel dan boleh menghantar tetamu ke Al Haram. ${next}`;
	}
	return `${name}, no, we do not currently offer a private bus service.${walking ? ` ${hotelName} is about ${walking} walking from Al Haram,` : ""} but public buses are available close to the hotel and can drop guests at Al Haram. ${next}`;
}

function selectedHotelFactAnswerText(sc = {}, st = {}, userText = "") {
	const hotel = st.hotel || {};
	const lang = languageOf(sc, st);
	const name = respectfulGuestName(sc, st);
	const hotelName = localizedHotelName(sc, st);
	const walking = formatHotelDistanceValue(hotel.distances?.walkingToElHaram, lang);
	const driving = formatHotelDistanceValue(hotel.distances?.drivingToElHaram, lang);
	const address = hotelFactAddressLine(hotel, lang);
	const next = hotelFactNextStepText(sc, st);
	const asksBus = selectedHotelBusQuestionText(userText);
	const asksDistance = selectedHotelDistanceQuestionText(userText);
	const asksAddress = selectedHotelAddressQuestionText(userText);
	const hasBusService = hotel.hasBusService === true;
	const busDetails = cleanHotelFactText(hotel.busDetails);
	if (asksBus) {
		return hasBusService
			? hotelBusServiceYesText(lang, name, busDetails, next)
			: hotelBusServiceNoText(lang, name, hotelName, walking, next);
	}
	if (/arabic/i.test(lang)) {
		if (asksDistance) {
			if (walking || driving) {
				const distance = localizedJoin(
					[
						walking ? `${walking} \u0645\u0634\u064a\u0627` : "",
						driving ? `${driving} \u0628\u0627\u0644\u0633\u064a\u0627\u0631\u0629` : "",
					],
					lang
				);
				return `${name}\u060c ${hotelName} \u064a\u0628\u0639\u062f \u0639\u0646 \u0627\u0644\u062d\u0631\u0645 \u062a\u0642\u0631\u064a\u0628\u0627 ${distance} \u062d\u0633\u0628 \u0627\u0644\u0632\u062d\u0627\u0645. \u0645\u0648\u0642\u0639\u0647 \u0639\u0645\u0644\u064a \u062c\u062f\u0627 \u0644\u0636\u064a\u0648\u0641 \u0627\u0644\u0639\u0645\u0631\u0629. ${next}`;
			}
			return `${name}\u060c \u0644\u0627 \u064a\u0638\u0647\u0631 \u0644\u062f\u064a \u0631\u0642\u0645 \u062f\u0642\u064a\u0642 \u0644\u0644\u0645\u0633\u0627\u0641\u0629 \u0641\u064a \u0628\u064a\u0627\u0646\u0627\u062a ${hotelName} \u062d\u0627\u0644\u064a\u0627. ${next}`;
		}
		if (asksAddress) {
			if (address) {
				const distanceNote = walking || driving ? ` \u0648\u064a\u0628\u0639\u062f \u0639\u0646 \u0627\u0644\u062d\u0631\u0645 \u062a\u0642\u0631\u064a\u0628\u0627 ${localizedJoin([walking ? `${walking} \u0645\u0634\u064a\u0627` : "", driving ? `${driving} \u0628\u0627\u0644\u0633\u064a\u0627\u0631\u0629` : ""], lang)}.` : "";
				return `${name}\u060c \u0639\u0646\u0648\u0627\u0646 ${hotelName}: ${address}.${distanceNote} ${next}`;
			}
			return `${name}\u060c \u0644\u0627 \u064a\u0638\u0647\u0631 \u0644\u062f\u064a \u0639\u0646\u0648\u0627\u0646 \u062f\u0642\u064a\u0642 \u0645\u0643\u062a\u0648\u0628 \u0644\u0640 ${hotelName} \u062d\u0627\u0644\u064a\u0627. ${next}`;
		}
	}
	if (/spanish/i.test(lang)) {
		if (asksDistance && (walking || driving)) return `${name}, ${hotelName} esta a unos ${localizedJoin([walking ? `${walking} caminando` : "", driving ? `${driving} en coche` : ""], lang)} del Haram, segun el trafico. Es una ubicacion muy practica para huespedes de Umrah. ${next}`;
		if (asksAddress && address) return `${name}, la direccion de ${hotelName} es: ${address}.${walking || driving ? ` Esta a unos ${localizedJoin([walking ? `${walking} caminando` : "", driving ? `${driving} en coche` : ""], lang)} del Haram.` : ""} ${next}`;
		return `${name}, no veo ese dato exacto confirmado en los detalles de ${hotelName} ahora mismo. ${next}`;
	}
	if (/french/i.test(lang)) {
		if (asksDistance && (walking || driving)) return `${name}, ${hotelName} se trouve a environ ${localizedJoin([walking ? `${walking} a pied` : "", driving ? `${driving} en voiture` : ""], lang)} du Haram, selon la circulation. C'est un emplacement tres pratique pour les voyageurs Omra. ${next}`;
		if (asksAddress && address) return `${name}, l'adresse de ${hotelName} est : ${address}.${walking || driving ? ` Il se trouve a environ ${localizedJoin([walking ? `${walking} a pied` : "", driving ? `${driving} en voiture` : ""], lang)} du Haram.` : ""} ${next}`;
		return `${name}, je ne vois pas ce detail exact confirme dans les informations de ${hotelName} pour le moment. ${next}`;
	}
	if (/urdu/i.test(lang)) {
		if (asksDistance && (walking || driving)) return `${name}، ${hotelName} حرم سے تقریباً ${localizedJoin([walking ? `${walking} پیدل` : "", driving ? `${driving} گاڑی سے` : ""], lang)} دور ہے، ٹریفک کے حساب سے۔ عمرہ guests کے لیے location بہت practical ہے۔ ${next}`;
		if (asksAddress && address) return `${name}، ${hotelName} کا address: ${address}.${walking || driving ? ` حرم سے تقریباً ${localizedJoin([walking ? `${walking} پیدل` : "", driving ? `${driving} گاڑی سے` : ""], lang)} ہے۔` : ""} ${next}`;
		return `${name}، اس وقت ${hotelName} کی details میں یہ exact معلومات confirmed نظر نہیں آ رہیں۔ ${next}`;
	}
	if (/hindi/i.test(lang)) {
		if (asksDistance && (walking || driving)) return `${name}, ${hotelName} Haram से लगभग ${localizedJoin([walking ? `${walking} पैदल` : "", driving ? `${driving} गाड़ी से` : ""], lang)} दूर है, traffic के अनुसार। Umrah guests के लिए location बहुत practical है। ${next}`;
		if (asksAddress && address) return `${name}, ${hotelName} का address: ${address}.${walking || driving ? ` Haram से लगभग ${localizedJoin([walking ? `${walking} पैदल` : "", driving ? `${driving} गाड़ी से` : ""], lang)} है।` : ""} ${next}`;
		return `${name}, अभी ${hotelName} की details में यह exact जानकारी confirmed नहीं दिख रही है। ${next}`;
	}
	if (/indonesian/i.test(lang)) {
		if (asksDistance && (walking || driving)) return `${name}, ${hotelName} berjarak sekitar ${localizedJoin([walking ? `${walking} berjalan kaki` : "", driving ? `${driving} dengan mobil` : ""], lang)} dari Haram, tergantung lalu lintas. Lokasinya sangat praktis untuk tamu Umrah. ${next}`;
		if (asksAddress && address) return `${name}, alamat ${hotelName}: ${address}.${walking || driving ? ` Jaraknya sekitar ${localizedJoin([walking ? `${walking} berjalan kaki` : "", driving ? `${driving} dengan mobil` : ""], lang)} dari Haram.` : ""} ${next}`;
		return `${name}, saya belum melihat detail pasti itu di data ${hotelName} saat ini. ${next}`;
	}
	if (/malay|malaysia/i.test(lang)) {
		if (asksDistance && (walking || driving)) return `${name}, ${hotelName} kira-kira ${localizedJoin([walking ? `${walking} berjalan kaki` : "", driving ? `${driving} dengan kereta` : ""], lang)} dari Haram, bergantung pada trafik. Lokasinya sangat praktikal untuk tetamu Umrah. ${next}`;
		if (asksAddress && address) return `${name}, alamat ${hotelName}: ${address}.${walking || driving ? ` Jaraknya kira-kira ${localizedJoin([walking ? `${walking} berjalan kaki` : "", driving ? `${driving} dengan kereta` : ""], lang)} dari Haram.` : ""} ${next}`;
		return `${name}, saya belum nampak butiran tepat itu dalam data ${hotelName} sekarang. ${next}`;
	}
	if (asksDistance) {
		if (walking || driving) {
			return `${name}, ${hotelName} is about ${localizedJoin([walking ? `${walking} on foot` : "", driving ? `${driving} by car` : ""], lang)} from Al Haram, depending on traffic. It is a very practical location for Umrah guests. ${next}`;
		}
		return `${name}, I do not see an exact distance confirmed in ${hotelName}'s details right now. ${next}`;
	}
	if (asksAddress) {
		if (address) {
			const distanceNote = walking || driving ? ` It is about ${localizedJoin([walking ? `${walking} on foot` : "", driving ? `${driving} by car` : ""], lang)} from Al Haram.` : "";
			return `${name}, the address for ${hotelName} is: ${address}.${distanceNote} ${next}`;
		}
		return `${name}, I do not see a precise written address in ${hotelName}'s details right now. ${next}`;
	}
	return "";
}

async function answerSelectedHotelFactQuestion(io, sc, st, userText = "") {
	const previousWaitFor = st.waitFor || null;
	const shouldPolishBusDetails =
		selectedHotelBusQuestionText(userText) &&
		st.hotel?.hasBusService === true &&
		Boolean(cleanHotelFactText(st.hotel?.busDetails));
	let reply = "";
	if (shouldPolishBusDetails) {
		reply = await write(
			io,
			sc,
			st,
			"The guest asked about the selected hotel's bus/shuttle service. Answer as the selected hotel's own reception representative, not as a platform or third party. Answer yes directly. Treat busDetails as private owner-written source notes: understand the meaning, remove duplicate yes/no wording, clean the grammar, and translate/adapt it into the guest's active response language. Do not copy the raw field like a database note. Do not use phrases like 'details registered from the hotel', 'the hotel details say', 'owner says', 'schema', or 'record'. Prefer natural first-person reception wording such as 'we provide' in the target language. Do not invent schedules, stations, timing, destinations, or promises beyond busDetails. If busDetails mentions a drop-off point or 24-hour service, state that clearly and warmly. End with one natural booking next step. Do not mention Jannat Booking or any other hotel.",
			{
				latestUserMessage: userText,
				selectedHotelFacts: buildActiveHotelFacts(sc, st),
				rawBusDetails: cleanHotelFactText(st.hotel?.busDetails),
				nextStep: nextPivot(st),
			}
		);
	} else {
		reply = selectedHotelFactAnswerText(sc, st, userText);
	}
	if (!reply) {
		reply = await write(
			io,
			sc,
			st,
			"The guest asked a direct factual question about the selected hotel. Answer directly using selectedHotelFacts only, then add one warm sales sentence and one natural next booking step. Do not ask for dates before answering the fact. Do not mention Jannat Booking or any other hotel.",
			{
				latestUserMessage: userText,
				selectedHotelFacts: buildActiveHotelFacts(sc, st),
				nextStep: nextPivot(st),
			}
		);
	}
	const sent = await humanSend(io, sc, st, reply);
	if (!sent) return false;
	st.waitFor = previousWaitFor || nextPivot(st);
	logStep(String(sc._id), "selected_hotel.fact_reply", {
		latestUserMessage: String(userText || "").slice(0, 160),
		waitFor: st.waitFor,
		hasDistance: Boolean(
			st.hotel?.distances?.walkingToElHaram ||
				st.hotel?.distances?.drivingToElHaram
		),
		hasAddress: Boolean(st.hotel?.hotelAddress),
	});
	return true;
}

async function buildHotelRecommendations({
	text,
	sc,
	st,
	requestedRoomTypeKey = null,
}) {
	if (st.hotel) {
		return selectedHotelSupportBoundaryReply(sc, st);
	}
	const roomTypeKey = /triple|ثلاث|triple/i.test(text)
		? "tripleRooms"
		: /quad|رباع|quad/i.test(text)
		? "quadRooms"
		: "doubleRooms";
	const selectedRoomTypeKey = requestedRoomTypeKey || roomTypeKey;
	const hotels = await listActivePublicHotels();
	const makkahOnly = wantsMakkahNearHaram(text);
	const scopedHotels = makkahOnly ? hotels.filter(isMakkahHotel) : hotels;
	const matches = scopedHotels
		.filter((hotel) =>
			(hotel.roomCountDetails || []).some((room) =>
				roomMatches(room, selectedRoomTypeKey)
			)
		)
		.map((hotel) => {
			const room = (hotel.roomCountDetails || []).find((item) =>
				roomMatches(item, selectedRoomTypeKey)
			);
			return {
				name: toTitle(hotel.hotelName),
				walking: hotel.distances?.walkingToElHaram || "",
				driving: hotel.distances?.drivingToElHaram || "",
				roomLabel: room?.displayName || roomTypeLabel(selectedRoomTypeKey),
				url: publicHotelUrl(hotel.hotelName),
			};
		})
		.sort(
			(a, b) =>
				firstNumber(a.walking) - firstNumber(b.walking) ||
				firstNumber(a.driving) - firstNumber(b.driving)
		)
		.slice(0, 3);

	return write(
		null,
		sc,
		st,
		"Answer the guest's hotel recommendation request using the provided active hotel matches only. If matches exist, include each hotel as a markdown link with the hotel name as the link text, preserve the provided hotel name casing, mention distance briefly when available, and ask for check-in and checkout dates if pricing is needed. If no matches exist, say you do not see matching active options right now and ask for dates or flexibility. Keep it short.",
		{
			requestedRoomType: selectedRoomTypeKey,
			activeHotelMatches: matches,
			locationScope: makkahOnly ? "makkah_near_al_haram" : "all_active_hotels",
			latestUserMessage: text,
		}
	);

	const name = firstNameForAddress(
		st.slots?.name || st.slots?.fullName || sc.displayName1 || "Guest"
	);
	const lang = languageOf(sc, st);
	if (!matches.length) {
		if (/arabic/i.test(lang)) {
			return `${name}، لا أرى غرفاً مزدوجة متاحة في الفنادق القريبة حالياً. أرسل تاريخ الدخول والخروج لأراجع لك خيارات أخرى.`;
		}
		return `${name}, I do not see double-room options near Al Haram right now. Please send check-in and checkout dates and I can check alternatives.`;
	}

	const lines = matches.map(
		(hotel) =>
			`- [${toTitle(hotel.name)}](${hotel.url})${
				hotel.walking ? ` - ${hotel.walking} walking` : ""
			}${hotel.driving ? `, ${hotel.driving} driving` : ""}`
	);
	if (/arabic/i.test(lang)) {
		return `نعم ${name}، هذه خيارات قريبة من الحرم:\n${lines.join(
			"\n"
		)}\nأرسل تاريخ الدخول والخروج لأراجع السعر.`;
	}
	if (/spanish/i.test(lang)) {
		return `Sí ${name}, estas opciones están cerca de Al Haram:\n${lines.join(
			"\n"
		)}\nEnvíame check-in y check-out para revisar precios.`;
	}
	if (/french/i.test(lang)) {
		return `Oui ${name}, voici des options proches d'Al Haram:\n${lines.join(
			"\n"
		)}\nEnvoyez les dates d'arrivée et de départ pour vérifier les prix.`;
	}
	return `Yes ${name}, good double-room options near Al Haram include:\n${lines.join(
		"\n"
	)}\nSend check-in and checkout dates and I can check prices.`;
}

async function buildJannatBookingHotelOptions({
	text,
	sc,
	st,
	requestedRoomTypeKey = null,
}) {
	const selectedRoomTypeKey =
		requestedRoomTypeKey ||
		st.slots.roomTypeKey ||
		mapRoomToKey(text) ||
		"doubleRooms";
	const hasDates = Boolean(st.slots.checkinISO && st.slots.checkoutISO);
	const budget = budgetFromText(
		[
			text,
			initialInquiryText(sc),
			recentConversationLines(sc, st).slice(-3000),
		].join("\n")
	);
	const hotels = await listActivePublicHotels();
	const makkahOnly = wantsMakkahNearHaram(
		[text, initialInquiryText(sc), recentConversationLines(sc, st).slice(-2000)]
			.filter(Boolean)
			.join("\n")
	);
	const scopedHotels = makkahOnly ? hotels.filter(isMakkahHotel) : hotels;
	const options = scopedHotels
		.filter(
			(hotel) =>
				hotel.aiToRespond === true &&
				!isJannatBookingSupportCase({ hotelId: hotel._id }, hotel)
		)
		.map((hotel) => {
			const room = (hotel.roomCountDetails || []).find((item) =>
				roomMatches(item, selectedRoomTypeKey)
			);
			if (!room) return null;
			const quote = hasDates
				? safePriceRoomForStay(
						hotel,
						{ roomType: selectedRoomTypeKey },
						st.slots.checkinISO,
						st.slots.checkoutISO
				  )
				: null;
			if (hasDates && !quote?.available) return null;
			const total = Number(quote?.totals?.totalPriceWithCommission || 0);
			const distanceScore =
				firstNumber(hotel.distances?.walkingToElHaram || "") ||
				firstNumber(hotel.distances?.drivingToElHaram || "") ||
				999;
			const budgetScore =
				budget && total
					? total <= budget
						? Math.max(0, budget - total) / 1000
						: 100 + (total - budget) / 100
					: 0;
			return {
				hotelId: idText(hotel._id),
				hotelName: toTitle(hotel.hotelName),
				roomTypeKey: selectedRoomTypeKey,
				roomLabel: room.displayName || roomTypeLabel(selectedRoomTypeKey),
				walking: hotel.distances?.walkingToElHaram || "",
				driving: hotel.distances?.drivingToElHaram || "",
				url: publicHotelUrl(hotel.hotelName),
				quote,
				total,
				currency: cleanCurrency(quote?.currency || hotel.currency || "SAR"),
				nights: quote?.nights || 0,
				_score: budgetScore + distanceScore,
			};
		})
		.filter(Boolean)
		.sort((a, b) => a._score - b._score || a.total - b.total)
		.slice(0, 4);

	st.platformHotelOptions = options;
	st.slots.roomTypeKey = selectedRoomTypeKey;

	const draftedReply = await write(
		null,
		sc,
		st,
		hasDates
			? "You are Jannat Booking concierge support. Recommend the best available hotel options from activeHotelOptions only, using totals/prices exactly as provided. Mention budget fit if budget is present. Be warm and helpful. Important: say Jannat Booking support can help compare options and pricing, but the official reservation confirmation and payment/details link must be completed by the selected hotel's reception and reservations desk. End by asking which hotel they would like to connect with."
			: "You are Jannat Booking concierge support. Recommend the active hotel options from activeHotelOptions only, focusing on fit and distance if available. Do not invent prices because stay dates are missing. Ask for check-in/check-out dates and approximate budget so you can compare properly. Mention that once they choose a hotel, that hotel's reception and reservations desk will confirm the reservation and links.",
		{
			latestUserMessage: text,
			requestedRoomType: selectedRoomTypeKey,
			checkinISO: st.slots.checkinISO,
			checkoutISO: st.slots.checkoutISO,
			budget,
			locationScope: makkahOnly ? "makkah_near_al_haram" : "all_active_hotels",
			activeHotelOptions: options.map((option) => ({
				hotelName: option.hotelName,
				roomLabel: option.roomLabel,
				walking: option.walking,
				driving: option.driving,
				total: option.total || null,
				currency: option.currency,
				nights: option.nights || null,
				url: option.url,
			})),
		}
	);
	const reply = ensurePlatformOptionsVisible(
		draftedReply,
		sc,
		st,
		options,
		hasDates
	);
	return {
		reply,
		options,
		hasDates,
	};
}

async function answerJannatBookingHotelOptions(
	io,
	sc,
	st,
	userText,
	requestedRoomTypeKey = null
) {
	const result = await buildJannatBookingHotelOptions({
		text: userText,
		sc,
		st,
		requestedRoomTypeKey,
	});
	const sent = await humanSend(io, sc, st, result.reply, {
		quickReplies: result.options.length
			? platformHotelOptionQuickReplies(sc, st)
			: [],
	});
	if (!sent) return false;
	st.waitFor = result.options.length ? "platform_hotel_choice" : "dates";
	return true;
}

async function connectJannatCaseToHotelSupport(
	io,
	sc,
	st,
	optionOrHotel,
	{ reason = "new_reservation", confirmation = "", requestedDates = null } = {}
) {
	const caseId = String(sc._id);
	const targetHotelId = idText(optionOrHotel?.hotelId || optionOrHotel?._id);
	if (!targetHotelId) return false;
	const hotel = optionOrHotel?.roomCountDetails
		? optionOrHotel
		: await getHotelById(targetHotelId);
	if (!hotel) return false;
	const hotelName = toTitle(hotel.hotelName || optionOrHotel.hotelName || "the hotel");
	const conciergeAgentName = st.agentName;
	const conciergeText = await write(
		io,
		sc,
		st,
		reason === "reservation_cancellation"
			? "Speak as Jannat Booking concierge support. Tell the guest you found the right hotel reception and reservations desk and will connect them now for the cancellation review. Reassure them that the selected hotel's team will handle the official reservation action. Keep it one warm sentence."
			: "Speak as Jannat Booking concierge support. Tell the guest you found the right hotel reception and reservations desk and will connect them now. Reassure them that the selected hotel's team will handle the official confirmation and reservation/payment/details links. Keep it one warm sentence.",
		{
			hotelName,
			reason,
			confirmation,
			requestedDates,
			selectedOption: optionOrHotel,
		}
	);
	const conciergeSent = await humanSend(
		io,
		sc,
		st,
		conciergeText ||
			`Great, I will connect you with ${hotelName} reception and reservations now so their team can handle the official confirmation and links.`
	);
	if (!conciergeSent) return false;

	const nextAgentName = chooseHotelHandoffAgentName(
		caseId,
		targetHotelId,
		st.agentName
	);
	st.hotel = hotel;
	st.agentName = nextAgentName;
	st.greeted = true;
	sc.hotelId = hotel._id || targetHotelId;
	sc.supportScope = "hotel";
	sc.aiResponderName = nextAgentName;
	if (optionOrHotel?.roomTypeKey) st.slots.roomTypeKey = optionOrHotel.roomTypeKey;
	if (optionOrHotel?.quote?.available) {
		st.quote = {
			key: quoteKeyForSlots(st),
			at: now(),
			data: optionOrHotel.quote,
		};
	}

	const updatedCase = await updateSupportCaseAppend(caseId, {
		hotelId: hotel._id || targetHotelId,
		supportScope: "hotel",
		displayName2: hotelName,
		targetUserName: hotelName,
		aiResponderName: nextAgentName,
		aiToRespond: true,
		aiRelated: true,
		aiHandoffReason: "",
		aiPausedAt: null,
	});
	if (updatedCase) {
		io.to(caseId).emit("supportCaseUpdated", updatedCase);
		io.emit("supportCaseUpdated", updatedCase);
	}

	const introInstruction =
		reason === "reservation_update"
			? "You are now the selected hotel's reception and reservations representative. Introduce yourself by first name from the hotel reception and reservations desk, acknowledge that Jannat Booking connected the guest for this reservation update, and say you will check the requested change with availability now. Keep it friendly and concise."
			: reason === "reservation_cancellation"
			? "You are now the selected hotel's reception and reservations representative. Introduce yourself by first name from the hotel reception and reservations desk, acknowledge that Jannat Booking connected the guest for a cancellation review, and say you will check the reservation policy now. Keep it friendly and concise."
			: reason === "payment_help"
			? "You are now the selected hotel's reception and reservations representative. Introduce yourself by first name from the hotel reception and reservations desk, acknowledge that Jannat Booking connected the guest for payment/reservation link help, and reassure them you will help with the official hotel link or payment question. Keep it friendly and concise."
			: reason === "reservation_support"
			? "You are now the selected hotel's reception and reservations representative. Introduce yourself by first name from the hotel reception and reservations desk, acknowledge that Jannat Booking connected the guest for their existing reservation, and ask one short question about what they need help with."
			: optionOrHotel?.quote?.available
			? "You are now the selected hotel's reception and reservations representative. Introduce yourself by first name from the hotel reception and reservations desk, acknowledge the selected priced option, and ask one yes/no question: whether to continue to the official reservation review. Do not ask for dates again."
			: "You are now the selected hotel's reception and reservations representative. Introduce yourself by first name from the hotel reception and reservations desk and ask for check-in and checkout dates so you can confirm availability officially.";
	let hotelIntro = await write(io, sc, st, introInstruction, {
		hotelName,
		agentName: nextAgentName,
		selectedOption: optionOrHotel,
		confirmation,
		requestedDates,
	});
	hotelIntro = stabilizeHotelHandoffIntro(hotelIntro, sc, st, optionOrHotel, {
		hotelName,
		agentName: nextAgentName,
	});

	await sendSystemNotice(
		io,
		sc,
		transferSystemNoticeText(sc, st, {
			hotelName,
			agentName: nextAgentName,
			fromAgentName: conciergeAgentName,
		})
	);
	const handoffDelay = randomBetween(
		JANNAT_HANDOFF_DELAY_MIN_MS,
		JANNAT_HANDOFF_DELAY_MAX_MS
	);
	logStep(caseId, "jannat_handoff.delay", {
		ms: handoffDelay,
		hotelName,
		nextAgentName,
	});
	const delayCompleted = await sleepUnlessInterrupted(st, handoffDelay);
	if (!delayCompleted) {
		logStep(caseId, "jannat_handoff.interrupted", { hotelName, nextAgentName });
		return true;
	}

	const introSent = await humanSend(io, sc, st, hotelIntro, {
		quickReplies:
			reason === "new_reservation" && optionOrHotel?.quote?.available
				? proceedQuickReplies(sc, st)
				: [],
	});
	if (!introSent) return true;
	st.waitFor =
		reason === "reservation_update"
			? "reservation_update_clarify"
			: reason === "reservation_cancellation"
			? "reservation_cancellation_reference"
			: reason === "payment_help"
			? "payment_reference"
			: reason === "reservation_support"
			? "reservation_reference"
			: optionOrHotel?.quote?.available
			? "proceed"
			: "dates";
	return true;
}

async function handlePlatformHotelChoice(io, sc, st, userText) {
	const options = Array.isArray(st.platformHotelOptions)
		? st.platformHotelOptions
		: [];
	if (!options.length) {
		if (!st.slots.roomTypeKey) {
			st.slots.roomTypeKey =
				mapRoomToKey(conversationText(sc, { guestsOnly: true })) ||
				mapRoomToKey(userText) ||
				"doubleRooms";
		}
		const rebuilt = await buildJannatBookingHotelOptions({
			text: userText,
			sc,
			st,
			requestedRoomTypeKey: st.slots.roomTypeKey,
		});
		const rebuiltIndex = parsePlatformHotelChoice(
			userText,
			st.platformHotelOptions || []
		);
		if (rebuiltIndex >= 0) {
			return connectJannatCaseToHotelSupport(
				io,
				sc,
				st,
				st.platformHotelOptions[rebuiltIndex],
				{ reason: "new_reservation" }
			);
		}
		const sent = await humanSend(io, sc, st, rebuilt.reply, {
			quickReplies: rebuilt.options.length
				? platformHotelOptionQuickReplies(sc, st)
				: [],
		});
		if (sent) {
			st.waitFor = rebuilt.options.length ? "platform_hotel_choice" : "dates";
		}
		return true;
	}
	const index = parsePlatformHotelChoice(userText, options);
	if (index < 0) {
		const sent = await humanSend(
			io,
			sc,
			st,
			platformHotelOptionsFallbackText(
				sc,
				st,
				options,
				Boolean(st.slots.checkinISO && st.slots.checkoutISO)
			),
			{ quickReplies: platformHotelOptionQuickReplies(sc, st) }
		);
		if (sent) st.waitFor = "platform_hotel_choice";
		return true;
	}
	return connectJannatCaseToHotelSupport(io, sc, st, options[index], {
		reason: "new_reservation",
	});
}

async function redirectJannatReservationToHotelSupport(
	io,
	sc,
	st,
	userText,
	lu = {}
) {
	const confirmation = latestKnownConfirmation(sc, lu);
	if (!confirmation) {
		const reply = await write(
			io,
			sc,
			st,
			"The guest is asking Jannat Booking support about an existing reservation. Jannat Booking must connect them to the reservation hotel's reception and reservations desk before updates, payment links, or reservation actions. Ask for the reservation confirmation number in one reassuring sentence.",
			{ latestUserMessage: userText }
		);
		await humanSend(io, sc, st, reply);
		st.waitFor = "jannat_reservation_reference";
		return true;
	}
	const reservation = await getReservationByConfirmation(confirmation);
	if (!reservation) {
		const reply = await write(
			io,
			sc,
			st,
			"The guest sent a confirmation number but it was not found. Ask them to recheck it and send it again. Keep it short and reassuring.",
			{ confirmation, latestUserMessage: userText }
		);
		await humanSend(io, sc, st, reply);
		st.waitFor = "jannat_reservation_reference";
		return true;
	}
	const hotelId = idText(reservation.hotelId);
	const hotel = hotelId ? await getHotelById(hotelId) : null;
	if (!hotel) {
		await handoffToHuman(io, sc, st, "human_review_needed");
		return true;
	}
	const requestedDates = latestTurnDateRange(userText, lu);
	const cancellationRequested = looksLikeReservationCancellation(userText);
	const reason = cancellationRequested
		? "reservation_cancellation"
		: looksLikeReservationDateUpdate(userText, lu)
		? "reservation_update"
		: wantsPaymentHelp(userText)
		? "payment_help"
		: "reservation_support";
	await connectJannatCaseToHotelSupport(io, sc, st, hotel, {
		reason,
		confirmation,
		requestedDates,
	});
	if (
		looksLikeReservationDateUpdate(userText, lu) &&
		requestedDates.checkinISO &&
		requestedDates.checkoutISO
	) {
		return finishReservationDateUpdate(io, sc, st, {
			confirmation,
			checkinISO: requestedDates.checkinISO,
			checkoutISO: requestedDates.checkoutISO,
		});
	}
	if (cancellationRequested) {
		return handleReservationCancellationRequest(io, sc, st, userText, lu);
	}
	return true;
}

const memo = new Map();

/* per case state incl. queue & preemption */
function ensureState(sc, hotel) {
	const id = String(sc._id);
	let st = memo.get(id);
	const alreadyGreeted = hasAiAssistantReply(sc);
	if (!st) {
		const agentPool = configuredAgentPool();
		const initialFullName = cleanFullNameCandidate(
			sc.displayName1 || sc.customerName || ""
		);
		st = {
			hotel,
			agentName:
				sc.aiResponderName ||
				agentPool[Math.floor(Math.random() * agentPool.length)],
			language: preferredLanguageOf(sc) || "English",
			languageCode: preferredLanguageCodeOf(sc) || "",
			languageOverrideAt: 0,
			greeted: alreadyGreeted,
			greetScheduled: alreadyGreeted,
			guestTypingUntil: 0,
			turnInFlight: false,
			interrupt: false,
			queue: [],
			sendingToken: null,
			waitFor: null, // 'intentConfirm' -> 'dates' -> 'room' -> 'proceed' -> 'reviewConfirm' -> 'fullname' -> 'nationality' -> 'phone' -> 'email_or_skip' -> 'finalize'
			lastBotText: "",
			lastAskAt: {},
			quote: null,
			reviewSent: false,
			quoteSummarizedAt: 0,
			progressSentAt: {},
			hydratedConversationLength: 0,
			dateRaw: { calendar: null, checkin: null, checkout: null },
			smalltalkThread: { topic: null, waitingForGuest: false, lastAt: 0 },
			slots: {
				checkinISO: null,
				checkoutISO: null,
				roomTypeKey: null,
				name: firstNameForAddress(
					initialFullName || sc.displayName1 || sc.customerName || "Guest"
				),
				fullName: initialFullName || null,
				nationality: null,
				phone: null,
				email: null,
				emailSkipped: false,
				adults: 2,
				children: 0,
				adultsProvided: false,
				childrenProvided: false,
				rooms: 1,
			},
		};
		memo.set(id, st);
	} else {
		if (alreadyGreeted) {
			st.greeted = true;
			st.greetScheduled = true;
		}
		if (isJannatBookingSupportCase(sc, hotel)) st.hotel = null;
		else if (hotel) st.hotel = hotel;
		if (sc.aiResponderName) st.agentName = sc.aiResponderName;
		if (!st.languageOverrideAt) {
			st.language = preferredLanguageOf(sc) || st.language || "English";
			st.languageCode = preferredLanguageCodeOf(sc) || st.languageCode || "";
		}
	}
	return st;
}

function emitTyping(io, caseId, st, on = true) {
	io.to(caseId).emit(on ? "typing" : "stopTyping", {
		caseId,
		isAi: true,
		name: st.agentName,
	});
}

/* --------- humanSend with pre‑emption (cancellable) --------- */
async function humanSend(io, sc, st, text, { first = false, quickReplies = [] } = {}) {
	if (!text) return false;
	const caseId = String(sc._id || sc.id || "unknown");
	const expectedTurnUserText = st.activeTurnUserText || "";
	const normalizedQuickReplies = sanitizeQuickReplies(quickReplies);

	const token = Math.random().toString(36).slice(2);
	st.sendingToken = token;
	if (st.interrupt) {
		logStep(caseId, "human.cancelled", { stage: "pre-send", token });
		return false;
	}

	const turnStartedAt =
		Number(st.activeTurnGuestAt || 0) > 0 ? Number(st.activeTurnGuestAt) : now();
	const targetElapsedMs =
		Number(st.activeTurnReplyTargetMs || 0) > 0
			? Number(st.activeTurnReplyTargetMs)
			: randomBetween(AI_REPLY_TARGET_MIN_MS, AI_REPLY_TARGET_MAX_MS);
	const waitMs = Math.max(0, targetElapsedMs - (now() - turnStartedAt));
	logStep(caseId, "human.delay.target", {
		ms: waitMs,
		targetElapsedMs,
		elapsedMs: now() - turnStartedAt,
		first,
		chars: (text || "").length,
	});
	while (st.guestTypingUntil > now()) await sleep(300);
	emitTyping(io, caseId, st, true);
	for (let t = 0; t < waitMs; t += 120) {
		if (st.interrupt || st.sendingToken !== token) {
			emitTyping(io, caseId, st, false);
			logStep(caseId, "human.cancelled", { stage: "target-wait", token });
			return false;
		}
		while (st.guestTypingUntil > now()) await sleep(300);
		await sleep(120);
	}
	emitTyping(io, caseId, st, false);
	if (st.interrupt || st.sendingToken !== token) {
		logStep(caseId, "human.cancelled", { stage: "post-type", token });
		return false;
	}

	if (st.lastBotText && st.lastBotText.trim() === String(text).trim()) {
		logStep(caseId, "dedupe.skip", { reason: "same_as_last" });
		return false;
	}

	try {
		const latestCase = await getSupportCaseById(caseId);
		const policy = latestCase
			? await ensureAIAllowed(latestCase.hotelId, latestCase)
			: { allowed: false, reason: "support case missing" };
		if (!policy.allowed) {
			logStep(caseId, "human.cancelled", {
				stage: "policy-before-save",
				reason: policy.reason,
			});
			return false;
		}
		const latestCustomerText = latestCase ? lastUserText(latestCase) : "";
		if (first && !expectedTurnUserText && latestCustomerText) {
			logStep(caseId, "human.cancelled", {
				stage: "stale-greeting",
				token,
				latestCustomerText,
			});
			return false;
		}
		if (
			expectedTurnUserText &&
			latestCustomerText &&
			latestCustomerText !== expectedTurnUserText
		) {
			logStep(caseId, "human.cancelled", {
				stage: "stale-turn",
				token,
				expectedTurnUserText,
				latestCustomerText,
			});
			return false;
		}
	} catch (error) {
		logStep(caseId, "human.cancelled", {
			stage: "policy-check-failed",
			message: error?.message || error,
		});
		return false;
	}

	const messageData = {
		messageBy: {
			customerName: st.agentName,
			customerEmail: AI_SUPPORT_EMAIL,
			userId: "jannat-ai-support",
		},
		message: text,
		date: new Date(),
		isAi: true,
	};
	if (normalizedQuickReplies.length) {
		messageData.quickReplies = normalizedQuickReplies;
	}
	await updateSupportCaseAppend(caseId, {
		conversation: messageData,
		aiRelated: true,
	});
	io.to(caseId).emit("receiveMessage", { ...messageData, caseId });

	st.lastBotText = text;
	return true;
}

async function sendSystemNotice(io, sc, text) {
	if (!text) return false;
	const caseId = String(sc._id || sc.id || "unknown");
	const messageData = {
		messageBy: {
			customerName: "System",
			customerEmail: AI_SUPPORT_EMAIL,
			userId: "jannat-system",
		},
		message: text,
		date: new Date(),
		isSystem: true,
	};
	await updateSupportCaseAppend(caseId, {
		conversation: messageData,
		aiRelated: true,
	});
	io.to(caseId).emit("receiveMessage", { ...messageData, caseId });
	return true;
}

/* soft‑pivot memory */
function progressText(sc = {}, st = {}, purpose = "checking") {
	const lang = languageOf(sc, st);
	if (/arabic/i.test(lang)) {
		return purpose === "finalizing"
			? "\u062a\u0645\u0627\u0645\u060c \u0623\u0646\u0627 \u0628\u0646\u0634\u0626 \u0627\u0644\u062d\u062c\u0632 \u0627\u0644\u0622\u0646. \u0644\u062d\u0638\u0629 \u0648\u0627\u062d\u062f\u0629 \u0645\u0646 \u0641\u0636\u0644\u0643."
			: "\u062a\u0645\u0627\u0645\u060c \u0623\u0646\u0627 \u0628\u0631\u0627\u062c\u0639 \u0627\u0644\u062a\u0648\u0641\u0631 \u0648\u0627\u0644\u0633\u0639\u0631 \u0627\u0644\u0622\u0646. \u0644\u062d\u0638\u0629 \u0648\u0627\u062d\u062f\u0629 \u0645\u0646 \u0641\u0636\u0644\u0643.";
	}
	if (/spanish/i.test(lang)) {
		return purpose === "finalizing"
			? "Perfecto, estoy creando la reserva ahora. Un momento, por favor."
			: "Perfecto, estoy revisando disponibilidad y precio ahora. Un momento, por favor.";
	}
	if (/french/i.test(lang)) {
		return purpose === "finalizing"
			? "Parfait, je cree la reservation maintenant. Un instant, s'il vous plait."
			: "Parfait, je verifie la disponibilite et le prix maintenant. Un instant, s'il vous plait.";
	}
	return purpose === "finalizing"
		? "Perfect, I am creating the reservation now. One moment please."
		: "Perfect, I am checking availability and price now. One moment please.";
}

async function sendProgressMessage(io, sc, st, purpose = "checking") {
	if (!AI_INSTANT_PROGRESS_ENABLED || !io || !st) return;
	const caseId = String(sc._id || sc.id || "unknown");
	const key = `${purpose}|${st.slots?.roomTypeKey || ""}|${
		st.slots?.checkinISO || ""
	}|${st.slots?.checkoutISO || ""}`;
	if (st.progressSentAt?.[key] && now() - st.progressSentAt[key] < 30000) {
		return;
	}
	st.progressSentAt = st.progressSentAt || {};
	st.progressSentAt[key] = now();
	const text = progressText(sc, st, purpose);
	await humanSend(io, sc, st, text);
}

function askedRecently(st, key, ms = SOFT_PIVOT_MS) {
	const t = now();
	const last = st.lastAskAt[key] || 0;
	if (t - last < ms) return true;
	st.lastAskAt[key] = t;
	return false;
}
function stampAsk(st, key) {
	st.lastAskAt[key] = now();
}

function normalizeControlText(text = "") {
	const raw = digitsToEnglish(String(text || "")).trim();
	const lower = raw.toLowerCase();
	const arabic = lower
		.replace(/[\u064b-\u065f\u0670]/g, "")
		.replace(/[\u0622\u0623\u0625\u0671]/g, "\u0627")
		.replace(/\u0649/g, "\u064a")
		.replace(/\u0629/g, "\u0647")
		.replace(/\s+/g, " ")
		.trim();
	const latinCompact = lower
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, "");
	return { raw, lower, arabic, latinCompact };
}

function correctionText(text = "") {
	const { lower, arabic, latinCompact } = normalizeControlText(text);
	return (
		/\b(something\s+is\s+wrong|wrong|incorrect|not\s+correct|mistake|change|edit|modify|fix|correction|correct\s+it)\b/i.test(
			lower
		) ||
		/(?:\u063a\u0644\u0637|\u062e\u0637\u0627|\u062e\u0637\u0623|\u0645\u0634\s+\u0635\u062d|\u0645\u0634\s+\u0635\u062d\u064a\u062d|\u063a\u064a\u0631\s+\u0635\u062d\u064a\u062d|\u062a\u0639\u062f\u064a\u0644|\u0639\u062f\u0644|\u0627\u0635\u0644\u062d|\u0635\u062d\u062d)/i.test(
			arabic
		) ||
		/(?:somethingwrong|wrong|incorrect|notcorrect|mistake|change|edit|modify|fix|correction)/i.test(
			latinCompact
		)
	);
}

function rejectsFullNameCandidate(value = "") {
	const { lower, arabic, latinCompact } = normalizeControlText(value);
	if (!lower) return true;
	if (/[?؟]/.test(lower)) return true;
	if (
		/\b(?:something|wrong|incorrect|problem|issue|mistake|error|fix|change|edit|modify|cancel|phone|mobile|whatsapp|hotel|reception|manager|support|reservation|booking|confirmation|confirm|price|rate|date|room|nationality|country|email|adult|child|children|guest|person|people|pax|skip|yes|no|thanks?|thank\s+you)\b/i.test(
			lower
		)
	) {
		return true;
	}
	if (
		/(?:\u063a\u0644\u0637|\u062e\u0637\u0627|\u062e\u0637\u0623|\u0645\u0634\u0643\u0644|\u0645\u0634\u0643\u0644\u0647|\u062a\u0639\u062f\u064a\u0644|\u062a\u063a\u064a\u064a\u0631|\u0627\u0644\u0641\u0646\u062f\u0642|\u0641\u0646\u062f\u0642|\u0627\u0644\u0627\u0633\u062a\u0642\u0628\u0627\u0644|\u0627\u0633\u062a\u0642\u0628\u0627\u0644|\u062c\u0648\u0627\u0644|\u0647\u0627\u062a\u0641|\u0648\u0627\u062a\u0633|\u062d\u062c\u0632|\u0633\u0639\u0631|\u062a\u0627\u0631\u064a\u062e|\u063a\u0631\u0641|\u062c\u0646\u0633\u064a|\u0627\u064a\u0645\u064a\u0644)/i.test(
			arabic
		)
	) {
		return true;
	}
	return /(?:somethingwrong|notcorrect|wrong|incorrect|problem|issue|mistake|phone|whatsapp|hotelphone|callhotel|manager|reservation|booking|confirmation|room|date|email|nationality)/i.test(
		latinCompact
	);
}

function hasUsableFullName(value = "") {
	const name = String(value || "").replace(/\s+/g, " ").trim();
	if (!name || name.length < 4 || name.length > 90) return false;
	if (latestEmailFromText(name) || cleanPhoneCandidate(name)) return false;
	if (rejectsFullNameCandidate(name)) return false;
	if (
		/\b(?:guest|unknown|test|na|n\/a|none|null|dont\s+know|don't\s+know|not\s+sure)\b/i.test(
			name
		) ||
		/(?:\u0644\u0627\s+\u0627\u0639\u0631\u0641|\u0644\u0627\s+\u0623\u0639\u0631\u0641|\u0645\u0634\s+\u0639\u0627\u0631\u0641|\u0645\u0634\s+\u0639\u0627\u0631\u0641\u0647|\u0627\u0643\u062a\u0628\u0647\s+\u0628\u0627\u0644\u0627\u0646\u062c\u0644\u064a\u0632)/i.test(
			name
		)
	) {
		return false;
	}
	if (
		/confirm|confirmation|book|reserve|price|date|room|\u062d\u062c\u0632|\u062a\u0627\u0631\u064a\u062e|\u063a\u0631\u0641/i.test(
			name
		)
	) {
		return false;
	}
	const nameTokens = name
		.split(/\s+/)
		.filter((token) => /[A-Za-z\u0590-\u08FF\u0900-\u097F]{2,}/.test(token));
	const letterCount = (name.match(/[A-Za-z\u0590-\u08FF\u0900-\u097F]/g) || [])
		.length;
	return nameTokens.length >= 2 || letterCount >= 8;
}

function cleanFullNameCandidate(value = "") {
	const cleaned = digitsToEnglish(String(value || ""))
		.replace(/[<>]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return hasUsableFullName(cleaned) ? cleaned : "";
}

function stripFieldTail(value = "") {
	return String(value || "")
		.replace(
			/(?:\b(?:phone|mobile|whatsapp|nationality|country|adults?|children|kids?|people|persons?|guests?|pax|email|telefono|tel[eé]fono|nacionalidad|pais|pa[ií]s|adultos?|ninos?|niños?|personas?|huespedes|huéspedes|correo)\b|(?:\u0627\u0644\u062c\u0646\u0633\u064a\u0629|\u062c\u0646\u0633\u064a\u062a\u064a|\u0627\u0644\u0647\u0627\u062a\u0641|\u0627\u0644\u062c\u0648\u0627\u0644|\u0627\u0644\u0628\u0631\u064a\u062f|\u0627\u064a\u0645\u064a\u0644|\u0628\u0627\u0644\u063a|\u0627\u0637\u0641\u0627\u0644|\u0623\u0637\u0641\u0627\u0644|\u0627\u0634\u062e\u0627\u0635|\u0623\u0634\u062e\u0627\u0635|\u0627\u0641\u0631\u0627\u062f|\u0623\u0641\u0631\u0627\u062f|\u0636\u064a\u0648\u0641)).*$/i,
			""
		)
		.replace(/\s+\d{1,2}\s*$/i, "")
		.replace(/^[\s:：,\-–—|]+|[\s:：,\-–—|]+$/g, "")
		.trim();
}

function explicitNameCandidateFromText(text = "") {
	const value = String(text || "");
	const patterns = [
		/(?:^|[\s,;|])(?:full\s*name|guest\s*name|passport\s*name|name)\s*[:：-]?\s*([^\n,;|]+)/i,
		/(?:^|[\s,;|])(?:nombre\s+completo|nombre\s+del\s+huesped|nombre\s+del\s+hu[eé]sped|nombre\s+en\s+pasaporte|nombre)\s*[:：-]?\s*([^\n,;|]+)/i,
		/(?:^|[\s,;،|])(?:\u0648?\u0627\u0633\u0645\u064a|\u0648?\u0627\u0633\u0645\u0649|\u0627\u0644\u0627\u0633\u0645(?:\s+\u0627\u0644\u0643\u0627\u0645\u0644)?|\u0627\u0633\u0645)\s*[:：-]?\s+([^\n,;،|]+)/i,
	];
	for (const pattern of patterns) {
		const match = value.match(pattern);
		const candidate = match ? cleanFullNameCandidate(stripFieldTail(match[1])) : "";
		if (candidate) return candidate;
	}
	return "";
}

function lineNameCandidateFromText(text = "") {
	const lines = String(text || "")
		.split(/[\n\r;|]+/)
		.map((line) => stripFieldTail(line))
		.filter(Boolean);
	for (const line of lines) {
		if (
			/\b(?:phone|mobile|nationality|country|adult|children|child|people|person|guest|pax|email|telefono|tel[eé]fono|nacionalidad|pais|pa[ií]s|adultos?|ninos?|niños?|personas?|huespedes|huéspedes|correo)\b|(?:\u0627\u0644\u062c\u0646\u0633\u064a\u0629|\u062c\u0646\u0633\u064a|\u062c\u0648\u0627\u0644|\u0647\u0627\u062a\u0641|\u0628\u0631\u064a\u062f|\u0627\u064a\u0645\u064a\u0644|\u0628\u0627\u0644\u063a|\u0627\u0637\u0641\u0627\u0644|\u0623\u0637\u0641\u0627\u0644|\u0627\u0634\u062e\u0627\u0635|\u0623\u0634\u062e\u0627\u0635|\u0627\u0641\u0631\u0627\u062f|\u0623\u0641\u0631\u0627\u062f|\u0636\u064a\u0648\u0641)/i.test(
				line
			)
		) {
			continue;
		}
		const candidate = cleanFullNameCandidate(line);
		if (candidate) return candidate;
	}
	return "";
}

const NATIONALITY_HINTS = [
	[/\b(?:egyptian|egypt)\b|\u0645\u0635\u0631\u064a|\u0645\u0635\u0631\u064a\u0629|\u0645\u0635\u0631/i, "Egyptian"],
	[/\b(?:saudi|saudi\s+arabian)\b|\u0633\u0639\u0648\u062f\u064a|\u0633\u0639\u0648\u062f\u064a\u0629/i, "Saudi"],
	[/\b(?:pakistani|pakistan)\b|\u0628\u0627\u0643\u0633\u062a\u0627\u0646\u064a|\u0628\u0627\u0643\u0633\u062a\u0627\u0646\u064a\u0629/i, "Pakistani"],
	[/\b(?:indian|india)\b|\u0647\u0646\u062f\u064a|\u0647\u0646\u062f\u064a\u0629/i, "Indian"],
	[/\b(?:bangladeshi|bangladesh)\b|\u0628\u0646\u063a\u0644\u0627\u062f\u0634/i, "Bangladeshi"],
	[/\b(?:indonesian|indonesia)\b|\u0627\u0646\u062f\u0648\u0646\u064a\u0633\u064a|\u0627\u0646\u062f\u0648\u0646\u064a\u0633\u064a\u0629/i, "Indonesian"],
	[/\b(?:malaysian|malaysia)\b|\u0645\u0627\u0644\u064a\u0632\u064a|\u0645\u0627\u0644\u064a\u0632\u064a\u0629/i, "Malaysian"],
	[/\b(?:moroccan|morocco)\b|\u0645\u063a\u0631\u0628\u064a|\u0645\u063a\u0631\u0628\u064a\u0629/i, "Moroccan"],
	[/\b(?:algerian|algeria)\b|\u062c\u0632\u0627\u0626\u0631\u064a|\u062c\u0632\u0627\u0626\u0631\u064a\u0629/i, "Algerian"],
	[/\b(?:tunisian|tunisia)\b|\u062a\u0648\u0646\u0633\u064a|\u062a\u0648\u0646\u0633\u064a\u0629/i, "Tunisian"],
	[/\b(?:sudanese|sudan)\b|\u0633\u0648\u062f\u0627\u0646\u064a|\u0633\u0648\u062f\u0627\u0646\u064a\u0629/i, "Sudanese"],
	[/\b(?:iraqi|iraq)\b|\u0639\u0631\u0627\u0642\u064a|\u0639\u0631\u0627\u0642\u064a\u0629/i, "Iraqi"],
	[/\b(?:syrian|syria)\b|\u0633\u0648\u0631\u064a|\u0633\u0648\u0631\u064a\u0629/i, "Syrian"],
	[/\b(?:jordanian|jordan)\b|\u0627\u0631\u062f\u0646\u064a|\u0623\u0631\u062f\u0646\u064a|\u0627\u0631\u062f\u0646\u064a\u0629|\u0623\u0631\u062f\u0646\u064a\u0629/i, "Jordanian"],
	[/\b(?:palestinian|palestine)\b|\u0641\u0644\u0633\u0637\u064a\u0646\u064a|\u0641\u0644\u0633\u0637\u064a\u0646\u064a\u0629/i, "Palestinian"],
	[/\b(?:emirati|uae|united\s+arab\s+emirates)\b|\u0627\u0645\u0627\u0631\u0627\u062a\u064a|\u0625\u0645\u0627\u0631\u0627\u062a\u064a/i, "Emirati"],
	[/\b(?:kuwaiti|kuwait)\b|\u0643\u0648\u064a\u062a\u064a|\u0643\u0648\u064a\u062a\u064a\u0629/i, "Kuwaiti"],
	[/\b(?:qatari|qatar)\b|\u0642\u0637\u0631\u064a|\u0642\u0637\u0631\u064a\u0629/i, "Qatari"],
	[/\b(?:bahraini|bahrain)\b|\u0628\u062d\u0631\u064a\u0646\u064a|\u0628\u062d\u0631\u064a\u0646\u064a\u0629/i, "Bahraini"],
	[/\b(?:omani|oman)\b|\u0639\u0645\u0627\u0646\u064a|\u0639\u0645\u0627\u0646\u064a\u0629/i, "Omani"],
	[/\b(?:yemeni|yemen)\b|\u064a\u0645\u0646\u064a|\u064a\u0645\u0646\u064a\u0629/i, "Yemeni"],
	[/\b(?:turkish|turkey)\b|\u062a\u0631\u0643\u064a|\u062a\u0631\u0643\u064a\u0629/i, "Turkish"],
	[/\b(?:nigerian|nigeria)\b|\u0646\u064a\u062c\u064a\u0631\u064a|\u0646\u064a\u062c\u064a\u0631\u064a\u0629/i, "Nigerian"],
];

function nationalityHintFromText(text = "") {
	const value = String(text || "");
	const found = NATIONALITY_HINTS.find(([pattern]) => pattern.test(value));
	return found ? found[1] : "";
}

function explicitNationalityText(text = "") {
	const value = String(text || "");
	const patterns = [
		/(?:^|[\s,;|])(?:nationality|country)\s*[:：-]?\s*([^\n,;|]+)/i,
		/(?:^|[\s,;|])(?:nacionalidad|pais|pa[ií]s)\s*[:：-]?\s*([^\n,;|]+)/i,
		/(?:^|[\s,;،|])(?:\u0627\u0644\u062c\u0646\u0633\u064a\u0629|\u062c\u0646\u0633\u064a\u062a\u064a|\u062c\u0646\u0633\u064a\u062a\u0649|\u0628\u0644\u062f\u064a)\s*[:：-]?\s*([^\n,;،|]+)/i,
	];
	for (const pattern of patterns) {
		const match = value.match(pattern);
		if (match?.[1]) return stripFieldTail(match[1]);
	}
	return "";
}

async function normalizeNationalityFromText(text = "", language = "English") {
	const explicit = explicitNationalityText(text);
	const hint = nationalityHintFromText(explicit || text);
	if (hint) return hint;
	const candidate = explicit || String(text || "").trim();
	if (!candidate || candidate.length > 80) return "";
	const asciiCandidate = asciiize(candidate).trim();
	if (/^[A-Za-z][A-Za-z\s-]{2,40}$/.test(asciiCandidate)) {
		const nat = await validateNationalityLLM(asciiCandidate, language);
		if (nat?.valid && nat.normalized) return nat.normalized;
	}
	const nat = await validateNationalityLLM(candidate, language);
	return nat?.valid && nat.normalized ? nat.normalized : "";
}

function countProvided(value) {
	return value !== null && value !== undefined && value !== "" && Number(value) >= 0;
}

function missingMandatoryReservationFields(st = {}) {
	const slots = st.slots || {};
	const missing = [];
	if (!hasUsableFullName(slots.fullName || slots.name || "")) missing.push("fullName");
	if (AI_REQUIRE_NATIONALITY && !slots.nationality) missing.push("nationality");
	if (!cleanPhoneCandidate(slots.phone || "")) missing.push("phone");
	if (!slots.adultsProvided || !countProvided(slots.adults) || Number(slots.adults) < 1) {
		missing.push("adults");
	}
	return missing;
}

function hasMandatoryReservationDetails(st = {}) {
	return missingMandatoryReservationFields(st).length === 0;
}

function ensureDefaultChildren(st = {}) {
	if (!st?.slots) return false;
	if (st.slots.childrenProvided && countProvided(st.slots.children)) return false;
	st.slots.children = 0;
	st.slots.childrenProvided = true;
	return true;
}

function localizedReservationDetailLabels(sc = {}, st = {}) {
	const lang = languageOf(sc, st);
	let labels = {
		fullName: "Full name:",
		nationality: "Nationality:",
		phone: "Phone:",
		adults: "Guests: adults, and children if any",
	};
	if (/arabic/i.test(lang)) {
		labels = {
			fullName: "\u0627\u0644\u0627\u0633\u0645 \u0627\u0644\u0643\u0627\u0645\u0644:",
			nationality: "\u0627\u0644\u062c\u0646\u0633\u064a\u0629:",
			phone: "\u0631\u0642\u0645 \u0627\u0644\u0647\u0627\u062a\u0641:",
			adults:
				"\u0639\u062f\u062f \u0627\u0644\u0636\u064a\u0648\u0641: \u0627\u0644\u0628\u0627\u0644\u063a\u064a\u0646\u060c \u0648\u0627\u0644\u0623\u0637\u0641\u0627\u0644 \u0625\u0646 \u0648\u062c\u062f\u0648\u0627",
		};
	} else if (/spanish/i.test(lang)) {
		labels = {
			fullName: "Nombre completo:",
			nationality: "Nacionalidad:",
			phone: "Telefono:",
			adults: "Huespedes: adultos, y ninos si hay",
		};
	} else if (/french/i.test(lang)) {
		labels = {
			fullName: "Nom complet:",
			nationality: "Nationalite:",
			phone: "Telephone:",
			adults: "Voyageurs: adultes, et enfants s'il y en a",
		};
	}
	return labels;
}

function localizedMissingLabels(sc = {}, st = {}) {
	const missing = missingMandatoryReservationFields(st);
	const labels = localizedReservationDetailLabels(sc, st);
	return missing.map((key) => labels[key] || key);
}

function reservationDetailPromptRows(sc = {}, st = {}, { retry = false } = {}) {
	const labels = localizedReservationDetailLabels(sc, st);
	const fields = retry
		? missingMandatoryReservationFields(st)
		: [
				"fullName",
				"phone",
				AI_REQUIRE_NATIONALITY ? "nationality" : "",
				"adults",
		  ].filter(Boolean);
	return fields.map((key) => labels[key] || `${key}:`).join("\n");
}

function mandatoryDetailsPrompt(sc = {}, st = {}, { retry = false } = {}) {
	const lang = languageOf(sc, st);
	const rows = reservationDetailPromptRows(sc, st, { retry });
	if (/arabic/i.test(lang)) {
		return retry
			? `\u0644\u0625\u062a\u0645\u0627\u0645 \u0627\u0644\u062d\u062c\u0632\u060c \u0645\u0627 \u0632\u0644\u062a \u0623\u062d\u062a\u0627\u062c:\n${rows}`
			: `\u062a\u0645\u0627\u0645. \u0644\u0625\u062a\u0645\u0627\u0645 \u0627\u0644\u062d\u062c\u0632\u060c \u0645\u0646 \u0641\u0636\u0644\u0643 \u0623\u0631\u0633\u0644:\n${rows}`;
	}
	if (/spanish/i.test(lang)) {
		return retry
			? `Para completar la reserva, todavia necesito:\n${rows}`
			: `Perfecto. Para completar la reserva, enviame:\n${rows}`;
	}
	if (/french/i.test(lang)) {
		return retry
			? `Pour finaliser la reservation, il me manque encore :\n${rows}`
			: `Parfait. Pour finaliser la reservation, envoyez:\n${rows}`;
	}
	if (/urdu/i.test(lang)) {
		return retry
			? `To complete the reservation, I still need:\n${rows}`
			: `Perfect. To complete the reservation, please send:\n${rows}`;
	}
	if (/hindi/i.test(lang)) {
		return retry
			? `To complete the reservation, I still need:\n${rows}`
			: `Perfect. To complete the reservation, please send:\n${rows}`;
	}
	return retry
		? `To complete the reservation, I still need:\n${rows}`
		: `Perfect. To complete the reservation, please send:\n${rows}`;
}

function optionalEmailPrompt(sc = {}, st = {}) {
	const lang = languageOf(sc, st);
	if (/arabic/i.test(lang)) {
		return "\u0634\u0643\u0631\u0627\u060c \u0633\u062c\u0644\u062a \u0627\u0644\u0628\u064a\u0627\u0646\u0627\u062a \u0627\u0644\u0623\u0633\u0627\u0633\u064a\u0629. \u0625\u0630\u0627 \u062a\u0631\u063a\u0628\u060c \u0623\u0631\u0633\u0644 \u0627\u0644\u0628\u0631\u064a\u062f \u0627\u0644\u0625\u0644\u0643\u062a\u0631\u0648\u0646\u064a \u0644\u0625\u0631\u0633\u0627\u0644 \u062a\u0623\u0643\u064a\u062f \u0627\u0644\u062d\u062c\u0632 \u0648\u0631\u0627\u0628\u0637 \u0627\u0644\u062f\u0641\u0639\u060c \u0623\u0648 \u0627\u0636\u063a\u0637 \u062a\u062e\u0637\u064a.";
	}
	if (/spanish/i.test(lang)) {
		return "Gracias, ya tengo los datos obligatorios. Si quieres recibir la confirmacion y el enlace de pago por email, enviame tu correo, o pulsa Omitir.";
	}
	if (/french/i.test(lang)) {
		return "Merci, j'ai bien note les informations obligatoires. Si vous souhaitez recevoir la confirmation et le lien de paiement par email, envoyez votre adresse, ou cliquez sur Ignorer.";
	}
	return "Thank you, I have the required details. If you would like to receive the confirmation and payment link by email, please share your email address, or choose Skip.";
}

function sanitizeQuickReplies(quickReplies = []) {
	if (!Array.isArray(quickReplies)) return [];
	return quickReplies
		.map((reply) => ({
			label: String(reply?.label || "").trim().slice(0, 80),
			value: String(reply?.value || reply?.label || "").trim().slice(0, 240),
			action: String(reply?.action || "").trim().slice(0, 60),
		}))
		.filter((reply) => reply.label && reply.value)
		.slice(0, 4);
}

function confirmationQuickReplies(sc = {}, st = {}) {
	const lang = languageOf(sc, st);
	if (/arabic/i.test(lang)) {
		return [
			{ label: "\u062a\u0623\u0643\u064a\u062f", value: "\u062a\u0623\u0643\u064a\u062f", action: "confirm" },
			{
				label: "\u0647\u0646\u0627\u0643 \u0634\u064a\u0621 \u063a\u064a\u0631 \u0635\u062d\u064a\u062d",
				value: "\u0647\u0646\u0627\u0643 \u0634\u064a\u0621 \u063a\u064a\u0631 \u0635\u062d\u064a\u062d",
				action: "correction",
			},
		];
	}
	if (/spanish/i.test(lang)) {
		return [
			{ label: "Confirmar", value: "Confirmar", action: "confirm" },
			{ label: "Algo esta mal", value: "Algo esta mal", action: "correction" },
		];
	}
	if (/french/i.test(lang)) {
		return [
			{ label: "Confirmer", value: "Confirmer", action: "confirm" },
			{
				label: "Quelque chose ne va pas",
				value: "Quelque chose ne va pas",
				action: "correction",
			},
		];
	}
	if (/urdu/i.test(lang)) {
		return [
			{ label: "\u062a\u0635\u062f\u064a\u0642", value: "\u062a\u0635\u062f\u064a\u0642", action: "confirm" },
			{
				label: "\u06a9\u0686\u06be \u063a\u0644\u0637 \u06c1\u06d2",
				value: "\u06a9\u0686\u06be \u063a\u0644\u0637 \u06c1\u06d2",
				action: "correction",
			},
		];
	}
	if (/hindi/i.test(lang)) {
		return [
			{ label: "\u092a\u0941\u0937\u094d\u091f\u093f", value: "\u092a\u0941\u0937\u094d\u091f\u093f", action: "confirm" },
			{
				label: "\u0915\u0941\u091b \u0917\u0932\u0924 \u0939\u0948",
				value: "\u0915\u0941\u091b \u0917\u0932\u0924 \u0939\u0948",
				action: "correction",
			},
		];
	}
	return [
		{ label: "Confirm", value: "Confirm", action: "confirm" },
		{ label: "Something is wrong", value: "Something is wrong", action: "correction" },
	];
}

function emailQuickReplies(sc = {}, st = {}) {
	const lang = languageOf(sc, st);
	if (/arabic/i.test(lang)) {
		return [{ label: "\u062a\u062e\u0637\u064a", value: "\u062a\u062e\u0637\u064a \u0627\u0644\u0628\u0631\u064a\u062f", action: "skip_email" }];
	}
	if (/spanish/i.test(lang)) return [{ label: "Omitir", value: "Omitir email", action: "skip_email" }];
	if (/french/i.test(lang)) return [{ label: "Ignorer", value: "Ignorer email", action: "skip_email" }];
	if (/urdu/i.test(lang)) return [{ label: "\u0646\u0638\u0631 \u0627\u0646\u062f\u0627\u0632", value: "Skip email", action: "skip_email" }];
	if (/hindi/i.test(lang)) return [{ label: "\u091b\u094b\u0921\u0947\u0902", value: "Skip email", action: "skip_email" }];
	return [{ label: "Skip", value: "Skip email", action: "skip_email" }];
}

function emailSkipText(text = "") {
	const raw = digitsToEnglish(String(text || "")).trim();
	if (!raw || latestEmailFromText(raw)) return false;
	const asciiLower = asciiize(raw).toLowerCase().replace(/\s+/g, " ").trim();
	if (
		/^(?:skip|skip email|no|no email|none|not now|later|no thanks|without email|continue without email|omit|omitir|omitir email|sin email|sin correo|ignorer|ignorer email|sans email|pas d'?email|non|non merci)$/i.test(
			asciiLower
		)
	) {
		return true;
	}
	if (
		/\b(?:skip|no email|without email|continue without email|omit|omitir|sin email|sin correo|ignorer|sans email|pas d'?email)\b/i.test(
			asciiLower
		)
	) {
		return true;
	}
	return /^(?:\u0644\u0627|\u0644\u0627\s+\u0634\u0643\u0631\u0627|\u0644\u0627\u062d\u0642\u0627|\u062a\u062e\u0637\u064a|\u062a\u062e\u0637\u0649|\u062a\u062c\u0627\u0648\u0632)$/i.test(
		raw
	) ||
		/(?:\u062a\u062e\u0637\u064a|\u062a\u062e\u0637\u0649|\u0628\u062f\u0648\u0646\s+(?:\u0628\u0631\u064a\u062f|\u0627\u064a\u0645\u064a\u0644|\u0625\u064a\u0645\u064a\u0644)|\u0644\u0627\s+(?:\u064a\u0648\u062c\u062f\s+)?(?:\u0628\u0631\u064a\u062f|\u0627\u064a\u0645\u064a\u0644|\u0625\u064a\u0645\u064a\u0644)|(?:\u0645\u0627|\u0645\u0634)\s+(?:\u0639\u0646\u062f\u064a|\u0639\u0646\u062f\u0649)\s+(?:\u0628\u0631\u064a\u062f|\u0627\u064a\u0645\u064a\u0644|\u0625\u064a\u0645\u064a\u0644))/i.test(
			raw
		);
}

function proceedQuickReplies(sc = {}, st = {}) {
	const lang = languageOf(sc, st);
	if (/arabic/i.test(lang)) {
		return [
			{ label: "\u0646\u0639\u0645\u060c \u062a\u0627\u0628\u0639", value: "\u0646\u0639\u0645\u060c \u062a\u0627\u0628\u0639", action: "proceed" },
			{ label: "\u0644\u0627 \u0627\u0644\u0622\u0646", value: "\u0644\u0627 \u0627\u0644\u0622\u0646", action: "decline" },
		];
	}
	if (/spanish/i.test(lang)) {
		return [
			{ label: "Si, continuar", value: "Si, continuar", action: "proceed" },
			{ label: "Ahora no", value: "Ahora no", action: "decline" },
		];
	}
	if (/french/i.test(lang)) {
		return [
			{ label: "Oui, continuer", value: "Oui, continuer", action: "proceed" },
			{ label: "Pas maintenant", value: "Pas maintenant", action: "decline" },
		];
	}
	return [
		{ label: "Yes, proceed", value: "Yes, proceed", action: "proceed" },
		{ label: "Not now", value: "Not now", action: "decline" },
	];
}

function parseJsonObject(raw = "", fallback = null) {
	const text = String(raw || "").trim();
	if (!text) return fallback;
	try {
		return JSON.parse(text);
	} catch {
		const match = text.match(/\{[\s\S]*\}/);
		if (!match) return fallback;
		try {
			return JSON.parse(match[0]);
		} catch {
			return fallback;
		}
	}
}

function reservationDetailCount(value, { allowZero = false } = {}) {
	if (value === null || value === undefined || value === "") return null;
	const cleaned = digitsToEnglish(String(value)).replace(/[^\d.-]/g, "");
	if (!cleaned) return null;
	const number = Number(cleaned);
	if (!Number.isFinite(number)) return null;
	const count = Math.round(number);
	const minimum = allowZero ? 0 : 1;
	if (count < minimum || count > 30) return null;
	return count;
}

const ADULT_COUNT_TERMS = [
	"adults?",
	"adultos?",
	"adultes?",
	"\\u0628\\u0627\\u0644\\u063a(?:\\u064a\\u0646|\\u0648\\u0646)?",
	"\\u0643\\u0628\\u0627\\u0631",
	"\\u0631\\u0627\\u0634\\u062f(?:\\u064a\\u0646|\\u0648\\u0646)?",
];

const CHILD_COUNT_TERMS = [
	"children",
	"child",
	"kids?",
	"ni[n\\u00f1]os?",
	"enfants?",
	"[\\u0623\\u0627]\\u0637\\u0641\\u0627\\u0644",
	"\\u0637\\u0641\\u0644(?:\\u064a\\u0646|\\u0627\\u0646)?",
	"[\\u0623\\u0627]\\u0648\\u0644\\u0627\\u062f",
	"\\u0635\\u063a\\u0627\\u0631",
];

const GUEST_COUNT_TERMS = [
	"people",
	"persons?",
	"guests?",
	"pax",
	"travell?ers?",
	"personas?",
	"huespedes",
	"hu\\u00e9spedes",
	"voyageurs?",
	"personnes?",
	"[\\u0623\\u0627]\\u0634\\u062e\\u0627\\u0635",
	"[\\u0623\\u0627]\\u0641\\u0631\\u0627\\u062f",
	"\\u0636\\u064a\\u0648\\u0641",
	"\\u0646\\u0641\\u0631",
	"\\u0632\\u0648\\u0627\\u0631",
];

function countNearTerms(text = "", terms = [], { allowZero = false } = {}) {
	const normalized = digitsToEnglish(String(text || ""))
		.replace(/\s+/g, " ")
		.trim();
	if (!normalized || !terms.length) return null;
	const source = terms.join("|");
	const boundary = "[^A-Za-z0-9\\u0600-\\u06FF]";
	const patterns = [
		new RegExp(`(?:^|${boundary})(?:${source})[\\s:：=\\-]*([0-9]{1,2})(?=$|${boundary})`, "i"),
		new RegExp(`(?:^|${boundary})([0-9]{1,2})\\s*(?:${source})(?=$|${boundary})`, "i"),
	];
	for (const pattern of patterns) {
		const match = normalized.match(pattern);
		const count = reservationDetailCount(match?.[1], { allowZero });
		if (count !== null) return count;
	}
	return null;
}

function noChildrenText(text = "") {
	const raw = digitsToEnglish(String(text || "")).trim();
	if (!raw) return false;
	const asciiLower = asciiize(raw).toLowerCase().replace(/\s+/g, " ").trim();
	if (/\b(?:no|zero|0|without|none)\s+(?:children|child|kids?|ninos?|ni[n\u00f1]os?)\b/i.test(asciiLower)) {
		return true;
	}
	return /(?:\u0628\u062f\u0648\u0646|\u0644\u0627\s+\u064a\u0648\u062c\u062f|\u0645\u0627\s+\u0641\u064a|\u0645\u0641\u064a\u0634|\u0645\u0627\u0641\u064a\u0634)\s+(?:[\u0623\u0627]\u0637\u0641\u0627\u0644|\u0637\u0641\u0644|\u0635\u063a\u0627\u0631)/i.test(
		raw
	);
}

function applyReservationGuestCountsFromText(st = {}, text = "") {
	if (!st?.slots) return false;
	const before = JSON.stringify(st.slots || {});
	const adults = countNearTerms(text, ADULT_COUNT_TERMS, { allowZero: false });
	const children = countNearTerms(text, CHILD_COUNT_TERMS, { allowZero: true });
	const guests = countNearTerms(text, GUEST_COUNT_TERMS, { allowZero: false });
	const hasAdultCount = adults !== null;
	let hasChildrenCount = children !== null;
	if (hasAdultCount) {
		st.slots.adults = adults;
		st.slots.adultsProvided = true;
	}
	if (hasChildrenCount) {
		st.slots.children = children;
		st.slots.childrenProvided = true;
	} else if (noChildrenText(text)) {
		st.slots.children = 0;
		st.slots.childrenProvided = true;
		hasChildrenCount = true;
	}
	if (!hasAdultCount && guests !== null) {
		const knownChildren = hasChildrenCount ? Number(st.slots.children || 0) : 0;
		st.slots.adults =
			hasChildrenCount && guests > knownChildren ? guests - knownChildren : guests;
		st.slots.adultsProvided = true;
		if (!hasChildrenCount) ensureDefaultChildren(st);
	}
	if (hasAdultCount && !hasChildrenCount) ensureDefaultChildren(st);
	return before !== JSON.stringify(st.slots || {});
}

function applyFocusedNumericCountAnswer(st = {}, text = "") {
	if (!st?.slots) return false;
	const missing = missingMandatoryReservationFields(st);
	const field = missing.length === 1 ? missing[0] : "";
	if (!["adults", "children"].includes(field)) return false;
	const normalized = digitsToEnglish(String(text || "")).trim();
	if (!/^\d{1,2}$/.test(normalized)) return false;
	const count = reservationDetailCount(normalized, { allowZero: field === "children" });
	if (count === null) return false;
	st.slots[field] = count;
	st.slots[`${field}Provided`] = true;
	return true;
}

function compactReservationSlotsForInference(st = {}) {
	const slots = st.slots || {};
	return {
		fullName: slots.fullName || slots.name || "",
		nationality: slots.nationality || "",
		phone: slots.phone || "",
		email: slots.email || "",
		emailSkipped: Boolean(slots.emailSkipped),
		adults: slots.adultsProvided ? slots.adults : null,
		adultsProvided: Boolean(slots.adultsProvided),
		children: slots.childrenProvided ? slots.children : null,
		childrenProvided: Boolean(slots.childrenProvided),
	};
}

function applyReservationDetailsInference(st = {}, inferred = {}) {
	if (!st?.slots || !inferred || typeof inferred !== "object") return false;
	const before = JSON.stringify(st.slots || {});
	const fullName = cleanFullNameCandidate(inferred.fullName || inferred.name || "");
	if (fullName) {
		st.slots.fullName = fullName;
		st.slots.name = fullName;
	}
	const phone = cleanPhoneCandidate(inferred.phone || "");
	if (phone) st.slots.phone = phone;
	const email = latestEmailFromText(inferred.email || "");
	if (email) {
		st.slots.email = email;
		st.slots.emailSkipped = false;
	} else if (inferred.emailSkipped === true) {
		st.slots.email = "";
		st.slots.emailSkipped = true;
	}
	const nationality = String(inferred.nationality || "").trim();
	if (AI_REQUIRE_NATIONALITY && nationality && nationality.length <= 60) {
		st.slots.nationality = nationality;
	}
	const adults = reservationDetailCount(inferred.adults, { allowZero: false });
	let inferredAdultsProvided = false;
	if (inferred.adultsProvided === true && adults !== null) {
		st.slots.adults = adults;
		st.slots.adultsProvided = true;
		inferredAdultsProvided = true;
	}
	const children = reservationDetailCount(inferred.children, { allowZero: true });
	if (inferred.childrenProvided === true && children !== null) {
		st.slots.children = children;
		st.slots.childrenProvided = true;
	} else if (inferredAdultsProvided) {
		ensureDefaultChildren(st);
	}
	if (st.slots.fullName && !st.slots.name) st.slots.name = st.slots.fullName;
	return before !== JSON.stringify(st.slots || {});
}

async function inferReservationDetailsFromContext(sc = {}, st = {}, latestText = "", caseId = "") {
	if (!st?.slots) return null;
	const missing = missingMandatoryReservationFields(st);
	const fieldFocus = missing.length === 1 ? missing[0] : st.waitFor || "";
	const sys = [
		"Hotel reservation NLU.",
		"Interpret dialectal Arabic, Arabizi, and informal multilingual guest writing into intended meaning before extraction.",
		"Use latestGuestMessage, lastAssistantMessage, fieldFocus, currentSlots, missingMandatoryFields, and fullConversation.",
		"Do not use a keyword list or exact phrase matching; infer semantic intent from context.",
		"When fieldFocus is present, a short latest reply answers that field unless the conversation clearly contradicts it.",
		"For count fields, absence or zero meaning is value 0 with provided=true.",
		"If latestGuestMessageDigitsNormalized is a number and fieldFocus is a count field, use that number as the provided count.",
		"Children count is optional for the guest. If the guest gives only a total people/person/guest count and no child count, set adults to that count and children to 0 with childrenProvided=true.",
		"For fieldFocus=email_or_skip, if the guest semantically declines or omits optional email, set emailSkipped=true.",
		"Do not infer adults or children from room type alone.",
		"Only fill slots provided by the guest or clearly answered by the latest reply.",
		"Output compact JSON only, with all requested keys present.",
	].join(" ");
	const user = JSON.stringify(
		{
			fieldFocus,
			latestGuestMessage: String(latestText || ""),
			latestGuestMessageDigitsNormalized: digitsToEnglish(String(latestText || "")),
			lastAssistantMessage: lastAssistantText(sc),
			missingMandatoryFields: missing,
			waitFor: st.waitFor || "",
			language: languageOf(sc, st),
			currentSlots: compactReservationSlotsForInference(st),
			fullConversation: recentConversationLines(sc, st),
			returnKeys: [
				"fullName",
				"nationality",
				"phone",
				"email",
				"emailSkipped",
				"adults",
				"adultsProvided",
				"children",
				"childrenProvided",
				"confidence",
			],
		},
		null,
		2
	);
	let raw = "";
	try {
		raw = await chat(
			[
				{ role: "system", content: sys },
				{ role: "user", content: user },
			],
			{ kind: "nlu", temperature: 0, max_tokens: 180, reasoning_effort: "none" }
		);
		const inferred = parseJsonObject(raw, null);
		if (!inferred || typeof inferred !== "object") {
			logStep(caseId || String(sc._id || ""), "reservation_details.context_parse_failed", {
				raw: String(raw || "").slice(0, 500),
				rawLength: String(raw || "").length,
			});
			return null;
		}
		const confidence = Number(inferred.confidence ?? 0.75);
		if (Number.isFinite(confidence) && confidence < 0.45) {
			logStep(caseId || String(sc._id || ""), "reservation_details.context_low_confidence", {
				inferred,
			});
			return inferred;
		}
		if (applyReservationDetailsInference(st, inferred)) {
			logStep(caseId || String(sc._id || ""), "reservation_details.context_inferred", {
				inferred,
				slots: st.slots,
			});
		}
		return inferred;
	} catch (error) {
		logStep(caseId || String(sc._id || ""), "reservation_details.context_inference_failed", {
			message: error?.message || error,
		});
		return null;
	}
}

async function captureReservationDetailsFromText(sc = {}, st = {}, text = "", caseId = "") {
	if (!st?.slots) return;
	const before = JSON.stringify(st.slots || {});
	const fullText = String(text || "");
	const phone = latestPhoneFromText(fullText);
	if (phone) st.slots.phone = phone;
	const email = latestEmailFromText(fullText);
	let emailSkipCaptured = false;
	if (email) {
		st.slots.email = email;
		st.slots.emailSkipped = false;
	} else if (st.waitFor === "email_or_skip" && emailSkipText(fullText)) {
		st.slots.email = "";
		st.slots.emailSkipped = true;
		emailSkipCaptured = true;
	}
	const explicitName = explicitNameCandidateFromText(fullText);
	const lineName = !explicitName ? lineNameCandidateFromText(fullText) : "";
	const wholeName =
		!explicitName && !lineName && st.waitFor === "fullname"
			? cleanFullNameCandidate(fullText)
			: "";
	const name = explicitName || lineName || wholeName;
	if (name) {
		st.slots.fullName = name;
		st.slots.name = name;
	}
	const guestCountCaptured = applyReservationGuestCountsFromText(st, fullText);
	const numericCountCaptured = applyFocusedNumericCountAnswer(st, fullText);
	if (
		!guestCountCaptured &&
		!numericCountCaptured &&
		!emailSkipCaptured &&
		["reservation_details", "fullname", "nationality", "phone", "email_or_skip"].includes(st.waitFor)
	) {
		await inferReservationDetailsFromContext(sc, st, fullText, caseId);
	}
	if (AI_REQUIRE_NATIONALITY && !st.slots.nationality) {
		const nationality = await normalizeNationalityFromText(fullText, languageOf(sc, st));
		if (nationality) st.slots.nationality = nationality;
	}
	if (st.slots.fullName && !st.slots.name) st.slots.name = st.slots.fullName;
	if (before !== JSON.stringify(st.slots || {})) {
		logStep(caseId || String(sc._id || ""), "reservation_details.captured", {
			slots: st.slots,
		});
	}
}

function nextPivot(st) {
	if (st.waitFor === "intentConfirm") return "intentConfirm";
	if (!st.slots.checkinISO || !st.slots.checkoutISO) return "dates";
	if (!st.slots.roomTypeKey) return "room";
	if (!st.reviewSent) return "proceed";
	if (!hasMandatoryReservationDetails(st)) return "reservation_details";
	if (!st.slots.email && !st.slots.emailSkipped) return "email_or_skip";
	return "finalize";
}

function confirmsText(text = "") {
	const raw = String(text || "");
	const { lower, arabic, latinCompact } = normalizeControlText(raw);
	if (
		/\bconfirmation\s*(?:number|no|#|reference)\b/i.test(lower) ||
		/(?:\u0631\u0642\u0645\s+\u0627\u0644\u062a\u0627\u0643\u064a\u062f|\u0631\u0642\u0645\s+\u0627\u0644\u062a\u0623\u0643\u064a\u062f)/i.test(
			arabic
		)
	) {
		return false;
	}
	if (
		/(?:\u062a\u0645\u0627\u0645|\u0646\u0639\u0645|\u0627\u064a\u0648\u0647|\u0623\u064a\u0648\u0647|\u0627\u064a\u0648\u0627|\u0627\u062d\u062c\u0632|\u0627\u0643\u062f|\u0623\u0643\u062f|\u062a\u0627\u0643\u064a\u062f|\u062a\u0623\u0643\u064a\u062f|\u0627\u0644\u062a\u0627\u0643\u064a\u062f|\u0627\u0644\u062a\u0623\u0643\u064a\u062f|\u0645\u0648\u0627\u0641\u0642|\u0635\u062d\u064a\u062d)/i.test(
			arabic
		) ||
		/(?:confirm|confirmed|confirmation|yes|yep|yeah|ok|okay|proceed|goahead|bookit|reserveit|takeed|ta2keed|taakid|takid|t2keed|ta2kid|a2ked|aked|akid|tamam|naam|aywa|aiwa|ewa|oui|confirmer|daccord|si|sí|vale)/i.test(
			latinCompact
		)
	) {
		return true;
	}
	if (
		/(?:\u062a\u0645\u0627\u0645|\u0646\u0639\u0645|\u0627\u064a\u0648\u0647|\u0623\u064a\u0648\u0647|\u0627\u064a\u0648\u0627|\u0627\u062d\u062c\u0632|\u0627\u0643\u062f|\u0623\u0643\u062f|\u062a\u0623\u0643\u064a\u062f)/i.test(raw)
	) {
		return true;
	}
	return /\b(confirm(?:ed)?|yes|yep|yeah|ok|okay|proceed|go ahead|book it|reserve it|تمام|نعم|ايوه|أيوه|ايوا|احجز|اكد|تأكيد|confirmer|oui|d'accord|si|sí|vale)\b/i.test(
		String(text || "")
	);
}

function declinesText(text = "") {
	const raw = String(text || "");
	if (/(?:\u0644\u0627|\u0645\u0634 \u062f\u0644\u0648\u0642\u062a\u064a|\u0644\u0627\u062d\u0642\u0627)/i.test(raw)) {
		return true;
	}
	return /\b(no|nope|not now|later|cancel|لا|مش دلوقتي|لاحقا|non|pas maintenant|no gracias)\b/i.test(
		String(text || "")
	);
}

function patienceText(text = "") {
	return /\b(take your time|no rush|whenever|slow down|wait|one moment|moment|براحتك|براحتك|خد وقتك|خدي وقتك|استنى|انتظر)\b/i.test(
		String(text || "")
	);
}

function botExperienceComplaintText(text = "") {
	return /\b(repeat|repeating|again|too fast|typing so fast|bot|robot|worst|bad cs|bad support|wrong with you|omg|lol)\b|تكرر|بتكرر|بسرعة|سريعة|روبوت|بوت|وحش|سيئ|غلط/i.test(
		String(text || "")
	);
}

function abusiveGuestText(text = "") {
	const { lower, arabic, latinCompact } = normalizeControlText(text);
	return (
		/\b(fuck|fucking|shit|bullshit|bitch|bastard|asshole|idiot|stupid|moron|damn you|go to hell)\b/i.test(
			lower
		) ||
		/(?:كس\s*امك|كسمك|شرموط|شرموطة|عرص|وسخ|حقير|حمار|غبي|زباله|زبالة|يلعن|لعنة)/i.test(
			arabic
		) ||
		/(?:fuck|fucking|bullshit|asshole|bitch|bastard|damnyou|gotohell|kosomak|kosomek|sharmout|sharmota|ghaby|zebala)/i.test(
			latinCompact
		)
	);
}

function looksLikeReservationDateUpdate(text = "", lu = {}) {
	const { lower, arabic, latinCompact } = normalizeControlText(text);
	const quickDates = quickDateRange(text);
	const hasDateWords =
		/\b(date|dates|check\s*in|checkin|check-in|checkout|check\s*out|check-out|arrival|departure|extend|extension|shorten|night|nights|stay)\b/i.test(
			lower
		) ||
		/(?:تاريخ|تواريخ|الدخول|الخروج|الوصول|المغادره|المغادرة|تمديد|مدد|ليله|ليلة|اقامه|إقامة)/i.test(
			arabic
		) ||
		/(?:fecha|fechas|entrada|salida|arrivee|arrivée|depart|départ|sejour|séjour)/i.test(
			lower
		);
	const hasUpdateWords =
		/\b(update|change|modify|amend|edit|move|adjust|switch|correct)\b/i.test(
			lower
		) ||
		/(?:تعديل|عدل|غير|تغيير|غيّر|تصحيح|بدل|نقل)/i.test(arabic) ||
		/(?:update|change|modify|amend|edit|move|adjust|switch|ta3deel|taghyeer|ghayar|adel|badal|cambiar|modifier|changer)/i.test(
			latinCompact
		);
	return Boolean(
		(hasDateWords && hasUpdateWords) ||
			((lu?.dates?.checkinISO || quickDates.checkinISO) && hasUpdateWords)
	);
}

function latestTurnDateRange(text = "", lu = {}) {
	const quickDates = quickDateRange(text);
	return {
		checkinISO: lu?.dates?.checkinISO || quickDates.checkinISO || null,
		checkoutISO: lu?.dates?.checkoutISO || quickDates.checkoutISO || null,
		raw: lu?.dates?.raw || quickDates.raw || null,
	};
}

function deterministicReservationUpdateLu(text = "", sc = {}, lu = {}) {
	const dates = latestTurnDateRange(text, lu);
	const confirmation =
		lu?.confirmation || confirmationFromText(text) || latestKnownConfirmation(sc, lu);
	return {
		...(lu || {}),
		confirmation: confirmation || null,
		dates: {
			...(lu?.dates || {}),
			checkinISO: dates.checkinISO,
			checkoutISO: dates.checkoutISO,
			raw: dates.raw || lu?.dates?.raw || null,
		},
	};
}

function reservationUpdateChoiceQuickReplies(sc = {}, st = {}, options = []) {
	const lang = languageOf(sc, st);
	return options.slice(0, 3).map((_, index) => {
		const number = index + 1;
		let label = `Option ${number}`;
		if (/arabic/i.test(lang)) label = `\u0627\u0644\u062e\u064a\u0627\u0631 ${arabicDigits(number)}`;
		if (/spanish/i.test(lang)) label = `Opcion ${number}`;
		if (/french/i.test(lang)) label = `Option ${number}`;
		return {
			label,
			value: label,
			action: `reservation_update_option_${number}`,
		};
	});
}
function parseReservationUpdateOptionChoice(text = "", options = []) {
	if (!options.length) return -1;
	const { lower, arabic, latinCompact } = normalizeControlText(text);
	const digit = lower.match(/\b([1-3])\b/);
	if (digit) {
		const index = Number(digit[1]) - 1;
		return options[index] ? index : -1;
	}
	if (/\b(first|option one|option 1|one|uno|premier|premiere)\b/i.test(lower)) {
		return options[0] ? 0 : -1;
	}
	if (/\b(second|option two|option 2|two|dos|deux)\b/i.test(lower)) {
		return options[1] ? 1 : -1;
	}
	if (/\b(third|option three|option 3|three|tres|trois)\b/i.test(lower)) {
		return options[2] ? 2 : -1;
	}
	if (/(?:\u0627\u0644\u0627\u0648\u0644|\u0627\u0644\u0623\u0648\u0644|\u0627\u0648\u0644|\u0623\u0648\u0644|\u0648\u0627\u062d\u062f|\u0661|\u06f1)/i.test(arabic)) return options[0] ? 0 : -1;
	if (/(?:\u0627\u0644\u062b\u0627\u0646\u064a|\u062b\u0627\u0646\u064a|\u062a\u0627\u0646\u064a|\u0627\u062a\u0646\u064a\u0646|\u0627\u062b\u0646\u064a\u0646|\u0662|\u06f2)/i.test(arabic)) return options[1] ? 1 : -1;
	if (/(?:\u0627\u0644\u062b\u0627\u0644\u062b|\u062b\u0627\u0644\u062b|\u062a\u0627\u0644\u062a|\u062b\u0644\u0627\u062b\u0647|\u062b\u0644\u0627\u062b\u0629|\u0663|\u06f3)/i.test(arabic)) return options[2] ? 2 : -1;
	if (confirmsText(text) && options.length === 1) return 0;
	if (/(?:optionone|first|one|uno|premier)/i.test(latinCompact)) {
		return options[0] ? 0 : -1;
	}
	if (/(?:optiontwo|second|two|dos|deux)/i.test(latinCompact)) {
		return options[1] ? 1 : -1;
	}
	if (/(?:optionthree|third|three|tres|trois)/i.test(latinCompact)) {
		return options[2] ? 2 : -1;
	}
	return -1;
}

function asksAiIdentity(text = "") {
	return /\b(are you (?:a )?(?:human|bot|robot|ai)|you are (?:a )?(?:bot|robot|ai)|real person)\b|\u0627\u0646\u062a\u064a\s+\u0627\u0646\u0633\u0627\u0646|\u0627\u0646\u062a\s+\u0627\u0646\u0633\u0627\u0646|\u0631\u0648\u0628\u0648\u062a|\u0628\u0648\u062a|\u0630\u0643\u0627\u0621\s+\u0627\u0635\u0637\u0646\u0627\u0639\u064a/i.test(
		String(text || "")
	);
}

function isAutomatedSupportNoticeText(text = "") {
	const value = String(text || "").trim();
	if (!value) return false;
	return /support specialist is reviewing|representative will be with you|support team is reviewing|team is reviewing/i.test(
		value
	) || /\u0641\u0631\u064a\u0642\s+Jannat Booking\s+\u064a\u0631\u0627\u062c\u0639\s+\u0631\u0633\u0627\u0644\u062a\u0643/i.test(
		value
	);
}

function lastGuestMessage(sc = {}) {
	const convo = Array.isArray(sc.conversation) ? sc.conversation : [];
	return [...convo]
		.reverse()
		.find((m) => {
			if (!m?.message || !m?.messageBy || isAiConversationMessage(m)) return false;
			return !isAutomatedSupportNoticeText(m.message);
		});
}

function lastUserText(sc) {
	const lastUser = lastGuestMessage(sc);
	return lastUser?.message || "";
}

function lastAssistantText(sc = {}) {
	const conversation = Array.isArray(sc.conversation) ? sc.conversation : [];
	const lastAssistant = [...conversation]
		.reverse()
		.find((message) => !message?.isSystem && isAiConversationMessage(message));
	return String(lastAssistant?.message || "");
}

function hijriYearOnlyOrClarificationText(text = "") {
	const normalized = digitsToEnglish(String(text || "").toLowerCase());
	const hasExplicitYear = /\b(?:1[34]\d{2}|15\d{2})\b/.test(normalized);
	const confirmsNearestFuture =
		/\b(?:not\s+(?:another\s+)?(?:10|ten)\s+years?|not\s+in\s+(?:10|ten)\s+years?|nearest|closest|coming|upcoming|next\s+(?:one|hijri|islamic)|this\s+year|of\s+course\s+not)\b/i.test(
			normalized
		) ||
		/(?:مش\s+(?:كمان|بعد)?\s*(?:10)?\s*سن(?:ين|وات)?|اكيد\s+مش|أكيد\s+مش|اقرب|أقرب|القريب|القريبه|القريبة|السنه\s+دي|السنة\s+دي|الجاي|القادم)/i.test(
			normalized
		);
	if (!hasExplicitYear && !confirmsNearestFuture) return false;
	return !/\b(?:price|rate|availability|available|room|hotel|book|reserve|payment|confirmation)\b/i.test(
		normalized
	);
}

function assistantAskedForDateOrHijriYear(text = "") {
	return /which\s+(?:ramadan|hijri|islamic)\s+year|which\s+year|ramadan\s+year|hijri\s+year|check\s*-?\s*in|check\s*-?\s*out|dates?|month\s+is\s+required|\u0631\u0645\u0636\u0627\u0646|\u0627\u0644\u0633\u0646\u0629|\u062a\u0627\u0631\u064a\u062e|\u062a\u0648\u0627\u0631\u064a\u062e/i.test(
		String(text || "")
	);
}

function recentConversationLines(sc = {}, st = {}) {
	const conversation = Array.isArray(sc.conversation) ? sc.conversation : [];
	const aiSender = st?.hotel?.hotelName
		? `${toTitle(st.hotel.hotelName)} reception and reservations`
		: "Jannat Booking support";
	return conversation
		.map((message) => {
			const sender = isAiConversationMessage(message)
				? aiSender
				: message?.messageBy?.customerName || "Guest";
			return `${sender}: ${String(message?.message || "").slice(0, 300)}`;
		})
		.join("\n");
}

function latestGuestLanguageStyle(sc = {}, targetLanguage = "") {
	const latest = lastUserText(sc);
	const text = String(latest || "").trim();
	const target = String(targetLanguage || "").toLowerCase();
	if (!text) {
		return {
			latestGuestTextSample: "",
			likelyDifferentFromPreferred: false,
			style: "unknown",
			guidance: "No latest guest message is available.",
		};
	}
	const hasArabicScript = /[\u0600-\u06FF]/.test(text);
	const hasDevanagari = /[\u0900-\u097F]/.test(text);
	const latinLetters = (text.match(/[A-Za-z]/g) || []).length;
	const hasLatinWords = latinLetters >= 3;
	const likelyLatinOnly = hasLatinWords && !hasArabicScript && !hasDevanagari;
	const likelyArabicTarget = /arabic|ar\b/.test(target);
	const likelyHindiTarget = /hindi|hi\b/.test(target);
	const likelyUrduTarget = /urdu|ur\b/.test(target);
	const likelyRomanizedPreferredLanguage =
		(likelyArabicTarget || likelyHindiTarget || likelyUrduTarget) &&
		likelyLatinOnly;
	const likelyDifferentFromPreferred =
		(!likelyArabicTarget && !likelyHindiTarget && !likelyUrduTarget && hasArabicScript);
	const style = hasArabicScript
		? "Arabic-script or Urdu-script"
		: hasDevanagari
		? "Devanagari-script"
		: likelyLatinOnly
		? "Latin-script; may be English, romanized Arabic/Urdu/Hindi, or code-switching"
		: "mixed or unclear";
	return {
		latestGuestTextSample: text.slice(0, 260),
		likelyDifferentFromPreferred,
		style,
		guidance: likelyRomanizedPreferredLanguage
			? "Treat this as possible romanized active-language text, such as Franko Arabic/Arabizi or Urdu/Hindi in Latin characters. Answer in the active response language."
			: likelyDifferentFromPreferred
			? "If the latest guest language is clear, the active response language should already reflect it. Answer in the active response language without asking permission to switch."
			: "Keep the response in the active response language and interpret dialect, transliteration, spelling mistakes, and code-switching from context.",
	};
}

function latestKnownConfirmation(sc = {}, lu = {}) {
	if (lu?.confirmation) return lu.confirmation;
	const conversation = Array.isArray(sc.conversation) ? sc.conversation : [];
	for (let i = conversation.length - 1; i >= 0; i -= 1) {
		const text = conversationEntryContextText(conversation[i]);
		const directMatch = confirmationFromText(text);
		if (directMatch) return directMatch;
		if (
			!/confirmation|confirm|reference|booking\s*(?:no|number|#)|reservation\s*(?:no|number|#)|\u062a\u0623\u0643\u064a\u062f|\u062d\u062c\u0632|\u0645\u0631\u062c\u0639|\u0643\u0648\u0646\u0641\u064a\u0631\u0645\u064a\u0634\u0646/i.test(
				text
			)
		) {
			continue;
		}
		const candidates =
			text.match(/\b(?:[A-Z]{1,6}[A-Z0-9-]{3,20}|\d{5,12})\b/gi) || [];
		const match = candidates.find(
			(candidate) =>
				/\d/.test(candidate) &&
				!/^(?:20\d{2}|1[34]\d{2}|15\d{2})$/.test(candidate)
		);
		if (match) return match.toUpperCase();
	}
	return null;
}

function cleanConfirmationCandidate(candidate = "") {
	const value = digitsToEnglish(String(candidate || ""))
		.trim()
		.replace(/^[^\w]+|[^\w-]+$/g, "")
		.toUpperCase();
	if (!value || !/\d/.test(value)) return null;
	if (/^20\d{2}(?:-\d{2}-\d{2})?$/.test(value)) return null;
	if (/^(?:1[34]\d{2}|15\d{2})$/.test(value)) return null;
	return value;
}

function confirmationFromText(text = "") {
	const raw = String(text || "");
	const loose = raw.match(
		/\b(?:reservation|booking|confirmation|reference)\s*(?:number|no\.?|#|id)?\s*[:#-]?\s*(\d{5,12})\b/i
	);
	if (loose) {
		const candidate = cleanConfirmationCandidate(loose[1]);
		if (candidate) return candidate;
	}
	const patterns = [
		/(?:confirmation|confirm(?:ation)?|reference|booking|reservation|reserva|r[e\u00e9]servation)\s*(?:number|no\.?|#|id|ref|num(?:ero|\u00e9ro)?|n[u\u00fa]mero)?\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{4,21})/gi,
		/(?:\u0631\u0642\u0645\s*(?:\u0627\u0644)?(?:\u062a\u0623\u0643\u064a\u062f|\u062a\u0627\u0643\u064a\u062f|\u062d\u062c\u0632|\u0645\u0631\u062c\u0639)|\u0627\u0644?\u062d\u062c\u0632\s*\u0631\u0642\u0645|\u062a\u0623\u0643\u064a\u062f\s*\u0631\u0642\u0645|\u062a\u0627\u0643\u064a\u062f\s*\u0631\u0642\u0645)\s*[:#-]?\s*([\d\u0660-\u0669\u06f0-\u06f9A-Z-]{5,22})/gi,
	];
	for (const pattern of patterns) {
		let match = null;
		while ((match = pattern.exec(raw))) {
			const candidate = cleanConfirmationCandidate(match[1]);
			if (candidate) return candidate;
		}
	}
	return null;
}

async function handoffToHuman(io, sc, st, reason) {
	const caseId = String(sc._id);
	const lang = languageOf(sc, st);
	const hotelName = st.hotel?.hotelName ? toTitle(st.hotel.hotelName) : "";
	const humanTeam = hotelName
		? `the ${hotelName} reception and reservations team`
		: "the Jannat Booking support team";
	let text =
		reason === "jannat_hotel_complaint"
			? `I am truly sorry this happened. Jannat Booking management will review this immediately, and action will be taken with the hotel team as needed.`
			: reason === "reservation_cancellation"
			? `I understand you want to cancel a reservation. ${humanTeam} will take over from here, because cancellations must be handled by a human specialist.`
			: reason === "abusive_guest"
			? `${humanTeam} will continue this conversation from here.`
			: reason === "reservation_finalize_failed"
			? `I could not finalize this reservation automatically. ${humanTeam} will take over from here and review it right away.`
			: reason === "reservation_finalize"
			? `I have the booking details needed to continue. ${humanTeam} will take over from here to verify the reservation and payment details before final confirmation.`
			: `I understand you want to update an existing reservation. ${humanTeam} will take over from here so the change is reviewed correctly.`;
	if (/spanish/i.test(lang)) {
		text =
			reason === "jannat_hotel_complaint"
				? "Lamento mucho lo ocurrido. La administracion de Jannat Booking revisara esto de inmediato y tomara accion con el hotel si es necesario."
				: reason === "reservation_cancellation"
				? "Entiendo que quieres cancelar una reserva. Un especialista de soporte tomara el chat desde aqui."
				: reason === "abusive_guest"
				? "Un especialista de soporte continuara esta conversacion desde aqui."
				: reason === "reservation_finalize_failed"
				? "No pude finalizar esta reserva automaticamente. Un especialista de soporte tomara el chat para revisarla enseguida."
				: "Entiendo tu solicitud de reserva. Un especialista de soporte tomara el chat para revisarla correctamente.";
	} else if (/french/i.test(lang)) {
		text =
			reason === "jannat_hotel_complaint"
				? "Je suis vraiment desole pour cette situation. La direction de Jannat Booking va l'examiner immediatement et prendre les mesures necessaires avec l'hotel."
				: reason === "reservation_cancellation"
				? "Je comprends que vous voulez annuler une reservation. Un specialiste du support va prendre le relais ici."
				: reason === "abusive_guest"
				? "Un specialiste du support va poursuivre cette conversation ici."
				: reason === "reservation_finalize_failed"
				? "Je n'ai pas pu finaliser cette reservation automatiquement. Un specialiste du support va la verifier tout de suite."
				: "Je comprends votre demande de reservation. Un specialiste du support va prendre le relais pour la verifier correctement.";
	} else if (/arabic/i.test(lang) && reason === "reservation_finalize_failed") {
		text =
			"\u062a\u0639\u0630\u0631 \u0625\u062a\u0645\u0627\u0645 \u0647\u0630\u0627 \u0627\u0644\u062d\u062c\u0632 \u062a\u0644\u0642\u0627\u0626\u064a\u0627. \u0633\u064a\u062a\u0627\u0628\u0639 \u0645\u0639\u0643 \u0623\u062d\u062f \u0645\u062e\u062a\u0635\u064a \u0627\u0644\u062f\u0639\u0645 \u0644\u0645\u0631\u0627\u062c\u0639\u062a\u0647 \u0641\u0648\u0631\u0627.";
	} else if (/arabic/i.test(lang)) {
		text =
			reason === "reservation_cancellation"
				? "فهمت أنك تريد إلغاء حجز. سيتابع معك أحد مختصي الدعم من هنا."
				: "فهمت طلبك. سيتابع معك أحد مختصي الدعم من هنا.";
	}
	try {
		const learnedText = await write(
			io,
			sc,
			st,
			reason === "abusive_guest"
				? "The latest guest message is abusive or extremely rude. Do not argue, lecture, or mirror the language. Calmly state that a human support specialist will continue the conversation. Keep it one short sentence and do not ask another question."
				: reason === "jannat_hotel_complaint"
				? "The guest is making a complaint about a hotel or hotel experience through Jannat Booking support. Show sincere empathy, reassure them that Jannat Booking management has been urgently alerted, and say action will be taken with the hotel team as needed. Keep it professional, warm, and concise. Do not ask another question."
				: "Tell the guest their request will be handled by a human support specialist. Keep it one short sentence, use the active hotel reception and reservations voice when hotel context exists, and do not ask another question.",
			{ handoffReason: reason, fallbackText: text }
		);
		if (learnedText) text = learnedText;
	} catch (error) {
		logStep(caseId, "handoff.write_failed", {
			message: error?.message || error,
			reason,
		});
	}
	const messageData = {
		messageBy: {
			customerName: st.agentName,
			customerEmail: AI_SUPPORT_EMAIL,
			userId: "jannat-ai-support",
		},
		message: text,
		date: new Date(),
		isAi: true,
	};
	const updatedCase = await updateSupportCaseAppend(caseId, {
		conversation: messageData,
		aiRelated: true,
		aiToRespond: false,
		aiPausedAt: new Date(),
		aiHandoffReason: reason,
		escalationStatus: "active",
		escalationReason: reason || "human_review_needed",
		escalationSource: "ai",
		escalatedAt: new Date(),
		escalatedBy: null,
		escalationAddressedAt: null,
		escalationAddressedBy: null,
		escalationAddressedNote: "",
	});
	io.to(caseId).emit("receiveMessage", { ...messageData, caseId });
	io.to(caseId).emit("aiPaused", { caseId, reason });
	if (updatedCase) {
		const escalationPayload = {
			case: updatedCase,
			caseId,
			escalationStatus: "active",
		};
		io.to(caseId).emit("supportCaseUpdated", updatedCase);
		io.emit("supportCaseUpdated", updatedCase);
		io.emit("supportCaseEscalated", escalationPayload);
		io.emit("supportCaseEscalationUpdated", escalationPayload);
	}
	if (reason === "jannat_hotel_complaint") {
		waNotifyImmediateSupportEscalation({
			caseId,
			guestName: sc.displayName1 || st.slots?.name || "Guest",
			hotelName: hotelName || "Jannat Booking support",
			reason,
		}).catch((error) => {
			console.error(
				"[aiagent] support escalation WhatsApp failed:",
				error?.message || error
			);
		});
	}
}

/* small helpers for smalltalk */
function looksLikeWellnessReply(s = "") {
	const t = s.toLowerCase();
	return /(i'?m\s+(good|fine|well|okay)|doing\s+well|al.?hamd|الحمد|كويس|تمام|بخير|great|awesome)/i.test(
		t
	);
}
function looksLikeClosureAck(s = "") {
	const t = s.toLowerCase();
	return /(that'?s\s+good|good|great|nice|تمام|حلو|كويس|جميل)/i.test(t);
}

function compactLearningChat(chat = {}) {
	const includeExamples =
		String(process.env.AI_LEARNING_INCLUDE_EXAMPLE_TURNS || "")
			.trim()
			.toLowerCase() === "true";
	const result = {
		sourceType: chat.sourceType || chat.source || "",
		title: chat.chatTitle || "",
		hotelName: chat.hotelName || "",
		language: chat.language || "",
		keywords: Array.isArray(chat.chatKeywords)
			? chat.chatKeywords.slice(0, 10)
			: [],
		relevanceScore: chat._relevanceScore || 0,
		signalMatches: chat._learningSignalMatches || 0,
		summary: chat.summary || "",
		customerIntent: chat.customerIntent || "",
		supportResolution: chat.supportResolution || "",
		learningNotes: Array.isArray(chat.learningNotes)
			? chat.learningNotes.slice(0, 6)
			: [],
		responseGuidance: Array.isArray(chat.responseGuidance)
			? chat.responseGuidance.slice(0, 6)
			: [],
		decisionRules: Array.isArray(chat.decisionRules)
			? chat.decisionRules.slice(0, 6)
			: [],
		recommendedResponses: Array.isArray(chat.recommendedResponses)
			? chat.recommendedResponses.slice(0, 4)
			: [],
		commonQuestions: Array.isArray(chat.commonQuestions)
			? chat.commonQuestions.slice(0, 6)
			: [],
		tags: Array.isArray(chat.tags) ? chat.tags.slice(0, 8) : [],
		qualityScore: chat.qualityScore || chat.confidenceScore || 0,
	};
	if (includeExamples) {
		result.exampleTurns = Array.isArray(chat.conversation)
			? chat.conversation.slice(0, 4).map((turn) => ({
					role: turn.role || "unknown",
					message: String(turn.message || "").slice(0, 180),
			  }))
			: [];
	}
	return result;
}

function compactPreviousGuestChat(supportCase = {}, st = {}) {
	const conversation = Array.isArray(supportCase.conversation)
		? supportCase.conversation
		: [];
	const hotelName =
		supportCase.hotelId?.hotelName ||
		supportCase.displayName2 ||
		st.hotel?.hotelName ||
		"";
	const firstMessage = conversation[0] || {};
	const recentTurns = conversation
		.filter((message) => message?.message && !message?.isSystem)
		.slice(-8)
		.map((message) => ({
			role: isAiConversationMessage(message) ? "support" : "guest",
			at: message.date || null,
			message: String(message.message || "").slice(0, 260),
		}));
	return {
		hotelName,
		caseStatus: supportCase.caseStatus || "",
		escalationStatus: supportCase.escalationStatus || "none",
		handoffReason: supportCase.aiHandoffReason || "",
		preferredLanguage: supportCase.preferredLanguage || "",
		updatedAt: supportCase.updatedAt || supportCase.createdAt || null,
		inquiryAbout: firstMessage.inquiryAbout || "",
		inquiryDetails: String(firstMessage.inquiryDetails || "").slice(0, 320),
		recentTurns,
	};
}

async function loadPreviousGuestContext(sc, st) {
	const cacheKey = `${String(sc._id || "")}|${(sc.conversation || []).length}`;
	if (
		st.previousGuestContext &&
		st.previousGuestContext.cacheKey === cacheKey &&
		now() - st.previousGuestContext.loadedAt < 60000
	) {
		return st.previousGuestContext.items;
	}
	try {
		const previousCases = await listPreviousGuestSupportChats({
			supportCase: sc,
			limit: 4,
		});
		const items = previousCases.map((supportCase) =>
			compactPreviousGuestChat(supportCase, st)
		);
		st.previousGuestContext = {
			cacheKey,
			loadedAt: now(),
			items,
		};
		return items;
	} catch (error) {
		logStep(String(sc._id), "previous_chats.lookup_failed", {
			message: error?.message || error,
		});
		return [];
	}
}

async function loadLearningContext(sc, st, instruction, context = {}) {
	try {
		const firstConversationTurn = Array.isArray(sc.conversation)
			? sc.conversation[0] || {}
			: {};
		const lookupText = [
			lastUserText(sc),
			recentConversationLines(sc, st).slice(-8000),
			targetLanguageLabel(sc, st),
			sc.inquiryAbout || firstConversationTurn.inquiryAbout || "",
			sc.inquiryDetails || firstConversationTurn.inquiryDetails || "",
			instruction,
			JSON.stringify({
				waitFor: st.waitFor,
				slots: st.slots,
				preferredLanguage: targetLanguageLabel(sc, st),
				context,
			}).slice(0, 2000),
		].join("\n");
		const activeHotelId = st.hotel?._id || null;
		const chats = await listRelevantTrainingChats({
			hotelId: activeHotelId,
			includeGlobal: true,
			language: targetLanguageLabel(sc, st),
			text: lookupText,
			limit: 6,
		});
		return chats.map(compactLearningChat);
	} catch (error) {
		logStep(String(sc._id), "learning.lookup_failed", {
			message: error?.message || error,
		});
		return [];
	}
}

function fallbackWriterText(sc, st, instruction = "", context = {}, respectfulAddress = "Guest") {
	const hotelName = st.hotel?.hotelName ? toTitle(st.hotel.hotelName) : "";
	const supportDesk = hotelName
		? `${hotelName} reception and reservations`
		: "Jannat Booking support";
	const text = String(instruction || "").toLowerCase();
	const lang = languageOf(sc, st);
	const isArabic = /arabic/i.test(lang);
	const isSpanish = /spanish/i.test(lang);
	const isHindi = /hindi/i.test(lang);
	const isFrench = /french/i.test(lang);
	const isUrdu = /urdu/i.test(lang);
	const isIndonesian = /indonesian/i.test(lang);
	const isMalay = /malay|malaysia/i.test(lang);
	if (context.fallbackText) {
		const fallbackText = String(context.fallbackText);
		if (
			!isArabic &&
			!isSpanish &&
			!isHindi &&
			!isFrench &&
			!isUrdu &&
			!isIndonesian &&
			!isMalay
		) {
			return fallbackText;
		}
		if (!/human|handoff|specialist|escalat|handled by/i.test(text)) {
			return fallbackText;
		}
	}
	if (context.quote) return simpleQuoteText({ sc, st, quote: context.quote });
	if (/review before we finalize|type confirm to finalize/.test(text)) {
		const total = context.totals?.totalPriceWithCommission || context.total || "";
		const currency = cleanCurrency(context.currency || st.quote?.data?.currency || "SAR");
		const room = context.room || roomTypeLabel(st.slots?.roomTypeKey);
		const hotel = context.hotel || toTitle(st.hotel?.hotelName || "Hotel");
		const gregorian = context.gregorian || {};
		const hijri = context.dateDisplay?.hijri || {};
		const dateLine =
			hijri?.checkin && hijri?.checkout
				? `${hijri.checkin} to ${hijri.checkout} (Gregorian: ${
						gregorian.checkin || usDate(st.slots?.checkinISO)
				  } to ${gregorian.checkout || usDate(st.slots?.checkoutISO)})`
				: `${gregorian.checkin || usDate(st.slots?.checkinISO)} to ${
						gregorian.checkout || usDate(st.slots?.checkoutISO)
				  }`;
		if (isArabic) {
			const dates = localizedStayDateLines(sc, st);
			const localizedTotal = total ? localizedMoney(total, currency, "Arabic") : "";
			return [
				`${respectfulAddress}\u060c \u0647\u0630\u0647 \u0645\u0631\u0627\u062c\u0639\u0629 \u0633\u0631\u064a\u0639\u0629 \u0642\u0628\u0644 \u0625\u062a\u0645\u0627\u0645 \u0627\u0644\u062d\u062c\u0632:`,
				`\u0627\u0644\u0641\u0646\u062f\u0642: ${context.hotelLocalized || hotel}`,
				`\u0627\u0644\u063a\u0631\u0641\u0629: ${context.roomLocalized || room}`,
				`\u0627\u0644\u062a\u0648\u0627\u0631\u064a\u062e: ${dates.primary || dateLine}`,
				dates.secondary || "",
				localizedTotal ? `\u0627\u0644\u0625\u062c\u0645\u0627\u0644\u064a: ${localizedTotal}` : "",
				`\u0627\u0643\u062a\u0628 "\u062a\u0623\u0643\u064a\u062f" \u0644\u0644\u0625\u062a\u0645\u0627\u0645\u060c \u0623\u0648 \u0623\u062e\u0628\u0631\u0646\u064a \u0628\u0645\u0627 \u062a\u0631\u064a\u062f \u062a\u063a\u064a\u064a\u0631\u0647.`,
			]
				.filter(Boolean)
				.join("\n");
		}
		if (isIndonesian) {
			return [
				"Tinjauan sebelum kami finalkan:",
				`Hotel: ${hotel}`,
				`Kamar: ${room}`,
				`Tanggal: ${dateLine}`,
				total ? `Total: ${total} ${currency}` : "",
				"Ketik konfirmasi untuk finalisasi, atau beritahu saya apa yang perlu diubah.",
			]
				.filter(Boolean)
				.join("\n");
		}
		if (isMalay) {
			return [
				"Semakan sebelum kami muktamadkan:",
				`Hotel: ${hotel}`,
				`Bilik: ${room}`,
				`Tarikh: ${dateLine}`,
				total ? `Jumlah: ${total} ${currency}` : "",
				"Taip pengesahan untuk muktamadkan, atau beritahu saya apa yang perlu diubah.",
			]
				.filter(Boolean)
				.join("\n");
		}
		return [
			"Review before we finalize:",
			`Hotel: ${hotel}`,
			`Room: ${room}`,
			`Dates: ${dateLine}`,
			total ? `Total: ${total} ${currency}` : "",
			"Type confirm to finalize, or tell me what to change.",
		]
			.filter(Boolean)
			.join("\n");
	}
	if (/how about you|doing well/.test(text)) {
		if (isArabic) return `أنا بخير، شكرًا ${respectfulAddress}. وأنت كيف حالك؟`;
		if (isIndonesian) return `Saya baik, terima kasih ${respectfulAddress}. Bagaimana kabar Anda?`;
		if (isMalay) return `Saya baik, terima kasih ${respectfulAddress}. Apa khabar?`;
		return `I'm doing well, thank you ${respectfulAddress}. How about you?`;
	}
	if (/full name|passport/.test(text)) {
		if (isArabic) return `${respectfulAddress}، من فضلك اكتب الاسم الكامل للحجز باللغة الإنجليزية كما في جواز السفر.`;
		if (isIndonesian) return `${respectfulAddress}, mohon tulis nama lengkap untuk reservasi sesuai paspor.`;
		if (isMalay) return `${respectfulAddress}, sila tulis nama penuh untuk tempahan seperti dalam pasport.`;
		return `${respectfulAddress}, please type the full name for the reservation as it appears in the passport.`;
	}
	if (/nationality/.test(text)) {
		if (isArabic) return `${respectfulAddress}، ما جنسية الضيف؟ من فضلك اكتب اسم الدولة/الجنسية باللغة الإنجليزية.`;
		if (isIndonesian) return `${respectfulAddress}, apa kewarganegaraan atau negara tamu?`;
		if (isMalay) return `${respectfulAddress}, apakah kewarganegaraan atau negara tetamu?`;
		return `${respectfulAddress}, what is the guest's nationality or country name?`;
	}
	if (/phone|whatsapp|reachable/.test(text)) {
		if (isArabic) return `${respectfulAddress}، من فضلك أرسل رقم جوال يمكننا التواصل عليه. واتساب مفضل لكنه ليس إلزاميًا.`;
		if (isIndonesian) return `${respectfulAddress}, mohon kirim nomor telepon yang bisa dihubungi. WhatsApp lebih baik, tetapi tidak wajib.`;
		if (isMalay) return `${respectfulAddress}, sila hantarkan nombor telefon yang boleh dihubungi. WhatsApp digalakkan, tetapi tidak wajib.`;
		return `${respectfulAddress}, please share a reachable phone number. WhatsApp is preferred, but not mandatory.`;
	}
	if (/email address|type 'skip'|type skip|email/.test(text)) {
		if (isArabic) return `${respectfulAddress}، من فضلك أرسل البريد الإلكتروني لتفاصيل الحجز، أو اكتب skip إذا تفضل المتابعة بدونه.`;
		if (isIndonesian) return `${respectfulAddress}, mohon kirim alamat email untuk detail reservasi, atau ketik skip jika ingin lanjut tanpa email.`;
		if (isMalay) return `${respectfulAddress}, sila hantarkan alamat email untuk butiran tempahan, atau taip skip jika mahu teruskan tanpa email.`;
		return `${respectfulAddress}, please share an email address for the reservation details, or type skip if you prefer to continue without one.`;
	}
	if (/greet/.test(text)) {
		if (isArabic) return `أهلاً ${respectfulAddress}، معك ${st.agentName} من ${supportDesk}. كيف أقدر أساعدك اليوم؟`;
		if (isSpanish) return `Hola ${respectfulAddress}, soy ${st.agentName} de ${supportDesk}. Como puedo ayudarte hoy?`;
		if (isHindi) return `नमस्ते ${respectfulAddress}, मैं ${supportDesk} से ${st.agentName} हूं। मैं आपकी कैसे मदद कर सकता हूं?`;
		if (isFrench) return `Bonjour ${respectfulAddress}, je suis ${st.agentName} de ${supportDesk}. Comment puis-je vous aider aujourd'hui ?`;
		if (isUrdu) return `السلام علیکم ${respectfulAddress}، میں ${supportDesk} سے ${st.agentName} ہوں۔ میں آپ کی کیسے مدد کر سکتا ہوں؟`;
		if (isIndonesian) return `Halo ${respectfulAddress}, saya ${st.agentName} dari ${supportDesk}. Bagaimana saya bisa membantu hari ini?`;
		if (isMalay) return `Halo ${respectfulAddress}, saya ${st.agentName} dari ${supportDesk}. Bagaimana saya boleh membantu hari ini?`;
		return `Hi ${respectfulAddress}, this is ${st.agentName} from ${supportDesk}. How can I help you today?`;
	}
	if (/date|check-in|check.?in|checkout|check-out/.test(text)) {
		if (isArabic) return `${respectfulAddress}، من فضلك أرسل تاريخ الدخول وتاريخ الخروج لأراجع التوفر.`;
		if (isSpanish) return `${respectfulAddress}, por favor enviame las fechas de check-in y check-out para revisar disponibilidad.`;
		if (isHindi) return `${respectfulAddress}, कृपया चेक-इन और चेक-आउट की तारीखें भेजें ताकि मैं उपलब्धता देख सकूं।`;
		if (isFrench) return `${respectfulAddress}, veuillez envoyer les dates d'arrivee et de depart pour que je verifie la disponibilite.`;
		if (isUrdu) return `${respectfulAddress}، براہ کرم چیک اِن اور چیک آؤٹ کی تاریخیں بھیجیں تاکہ میں دستیابی چیک کر سکوں۔`;
		if (isIndonesian) return `${respectfulAddress}, mohon kirim tanggal check-in dan check-out agar saya bisa cek ketersediaan.`;
		if (isMalay) return `${respectfulAddress}, sila hantarkan tarikh check-in dan check-out supaya saya boleh semak ketersediaan.`;
		return `${respectfulAddress}, please send your check-in and checkout dates and I can check availability.`;
	}
	if (/room type/.test(text)) {
		const examples = Array.isArray(context.roomExamples)
			? context.roomExamples.filter(Boolean).slice(0, 4)
			: [];
		if (isArabic) {
			return examples.length
				? `${respectfulAddress}، أي نوع غرفة يناسبك؟ مثلاً: ${examples.join(" / ")}.`
				: `${respectfulAddress}، ما نوع الغرفة الذي تفضله؟`;
		}
		if (isSpanish) {
			return examples.length
				? `${respectfulAddress}, que tipo de habitacion prefieres? Por ejemplo: ${examples.join(" / ")}.`
				: `${respectfulAddress}, que tipo de habitacion prefieres?`;
		}
		if (isHindi) {
			return examples.length
				? `${respectfulAddress}, आपको कौन सा रूम टाइप चाहिए? उदाहरण: ${examples.join(" / ")}.`
				: `${respectfulAddress}, आपको कौन सा रूम टाइप चाहिए?`;
		}
		if (isFrench) {
			return examples.length
				? `${respectfulAddress}, quel type de chambre preferez-vous ? Par exemple : ${examples.join(" / ")}.`
				: `${respectfulAddress}, quel type de chambre preferez-vous ?`;
		}
		if (isUrdu) {
			return examples.length
				? `${respectfulAddress}، آپ کو کون سا کمرہ چاہیے؟ مثال کے طور پر: ${examples.join(" / ")}.`
				: `${respectfulAddress}، آپ کو کون سا کمرہ چاہیے؟`;
		}
		if (isIndonesian) {
			return examples.length
				? `${respectfulAddress}, jenis kamar mana yang paling sesuai? Contoh: ${examples.join(" / ")}.`
				: `${respectfulAddress}, jenis kamar mana yang Anda inginkan?`;
		}
		if (isMalay) {
			return examples.length
				? `${respectfulAddress}, jenis bilik mana yang paling sesuai? Contoh: ${examples.join(" / ")}.`
				: `${respectfulAddress}, jenis bilik mana yang anda mahukan?`;
		}
		return examples.length
			? `${respectfulAddress}, which room type suits you best? For example: ${examples.join(" / ")}.`
			: `${respectfulAddress}, which room type would you like?`;
	}
	if (/payment/.test(text)) {
		if (isArabic) return `${respectfulAddress}، أقدر أساعدك في مشكلة الدفع. أرسل رقم التأكيد أو رابط الدفع فقط، ولا ترسل أي بيانات بطاقة.`;
		if (isSpanish) return `${respectfulAddress}, puedo ayudarte con el pago. Enviame el numero de confirmacion o el enlace de pago, pero no datos de tarjeta.`;
		if (isHindi) return `${respectfulAddress}, मैं भुगतान की समस्या में मदद कर सकता हूं। कृपया कन्फर्मेशन नंबर या पेमेंट लिंक भेजें, कार्ड की जानकारी नहीं।`;
		if (isFrench) return `${respectfulAddress}, je peux vous aider pour le paiement. Envoyez le numero de confirmation ou le lien de paiement, mais pas de donnees de carte.`;
		if (isUrdu) return `${respectfulAddress}، میں ادائیگی کے مسئلے میں مدد کر سکتا ہوں۔ براہ کرم کنفرمیشن نمبر یا پیمنٹ لنک بھیجیں، کارڈ کی معلومات نہیں۔`;
		if (isIndonesian) return `${respectfulAddress}, saya bisa membantu masalah pembayaran. Mohon kirim nomor konfirmasi atau link pembayaran, tetapi jangan kirim detail kartu.`;
		if (isMalay) return `${respectfulAddress}, saya boleh membantu isu pembayaran. Sila hantar nombor pengesahan atau pautan pembayaran, tetapi jangan hantar butiran kad.`;
		return `${respectfulAddress}, I can help with the payment issue. Please send the confirmation number or payment link, but not card details.`;
	}
	if (/reservation|confirmation/.test(text)) {
		if (isArabic) return `${respectfulAddress}، من فضلك أرسل رقم التأكيد والتغيير المطلوب في الحجز.`;
		if (isSpanish) return `${respectfulAddress}, por favor enviame el numero de confirmacion y que cambio necesitas.`;
		if (isHindi) return `${respectfulAddress}, कृपया कन्फर्मेशन नंबर और बताएं कि आप क्या बदलना चाहते हैं।`;
		if (isFrench) return `${respectfulAddress}, veuillez envoyer le numero de confirmation et le changement souhaite.`;
		if (isUrdu) return `${respectfulAddress}، براہ کرم کنفرمیشن نمبر اور مطلوبہ تبدیلی بھیجیں۔`;
		if (isIndonesian) return `${respectfulAddress}, mohon kirim nomor konfirmasi dan perubahan yang Anda inginkan.`;
		if (isMalay) return `${respectfulAddress}, sila hantarkan nombor pengesahan dan perubahan yang anda mahukan.`;
		return `${respectfulAddress}, please send the confirmation number and what you would like to update.`;
	}
	if (/human|handoff|specialist|escalat/.test(text)) {
		if (isArabic) return `${respectfulAddress}، سيتابع معك أحد مختصي الدعم من هنا.`;
		if (isSpanish) return `${respectfulAddress}, un especialista de soporte continuara contigo desde aqui.`;
		if (isHindi) return `${respectfulAddress}, अब हमारी सपोर्ट टीम का विशेषज्ञ आपकी मदद जारी रखेगा।`;
		if (isFrench) return `${respectfulAddress}, un specialiste du support va poursuivre avec vous ici.`;
		if (isUrdu) return `${respectfulAddress}، اب سپورٹ ٹیم کا ایک ماہر آپ کے ساتھ بات جاری رکھے گا۔`;
		if (isIndonesian) return `${respectfulAddress}, spesialis dukungan akan melanjutkan bantuan dari sini.`;
		if (isMalay) return `${respectfulAddress}, pakar sokongan akan meneruskan bantuan dari sini.`;
		return `${respectfulAddress}, a support specialist will continue with you from here.`;
	}
	if (isArabic) return `${respectfulAddress}، أقدر أساعدك. هل يمكنك إرسال تفاصيل أكثر؟`;
	if (isSpanish) return `${respectfulAddress}, puedo ayudarte con eso. Puedes enviarme un poco mas de detalle?`;
	if (isHindi) return `${respectfulAddress}, मैं इसमें मदद कर सकता हूं। कृपया थोड़ा और विवरण भेजें।`;
	if (isFrench) return `${respectfulAddress}, je peux vous aider. Pouvez-vous envoyer un peu plus de details ?`;
	if (isUrdu) return `${respectfulAddress}، میں مدد کر سکتا ہوں۔ براہ کرم تھوڑی مزید تفصیل بھیجیں۔`;
	if (isIndonesian) return `${respectfulAddress}, saya bisa membantu. Mohon kirim sedikit detail tambahan.`;
	if (isMalay) return `${respectfulAddress}, saya boleh membantu. Sila hantarkan sedikit butiran tambahan.`;
	return `${respectfulAddress}, I can help with that. Could you share a little more detail?`;
}

function languageMismatchLikely(answer = "", targetLanguage = "") {
	const text = String(answer || "").trim();
	const lang = String(targetLanguage || "").toLowerCase();
	if (!text || !lang) return false;
	if (/arabic|urdu/.test(lang)) return !/[\u0600-\u06FF]/.test(text);
	if (/hindi/.test(lang)) return !/[\u0900-\u097F]/.test(text);
	if (/spanish/.test(lang)) {
		const looksEnglish =
			/\b(the|please|could|would|check-in|checkout|reservation|support|payment|confirm)\b/i.test(
				text
			);
		const looksSpanish =
			/\b(hola|por favor|reserva|habitaci[oó]n|fechas|gracias|puedo|necesitas|confirmaci[oó]n|pago|soporte)\b/i.test(
				text
			);
		return looksEnglish && !looksSpanish;
	}
	if (/french/.test(lang)) {
		const looksEnglish =
			/\b(the|please|could|would|check-in|checkout|reservation|support|payment|confirm)\b/i.test(
				text
			);
		const looksFrench =
			/\b(bonjour|merci|reservation|chambre|dates|paiement|veuillez|support|confirmer)\b/i.test(
				text
			);
		return looksEnglish && !looksFrench;
	}
	if (/indonesian/.test(lang)) {
		const looksEnglish =
			/\b(the|please|could|would|check-in|checkout|reservation|support|payment|confirm)\b/i.test(
				text
			);
		const looksIndonesian =
			/\b(halo|terima kasih|kamar|tanggal|reservasi|pembayaran|mohon|bisa|silakan|konfirmasi)\b/i.test(
				text
			);
		return looksEnglish && !looksIndonesian;
	}
	if (/malay|malaysia/.test(lang)) {
		const looksEnglish =
			/\b(the|please|could|would|check-in|checkout|reservation|support|payment|confirm)\b/i.test(
				text
			);
		const looksMalay =
			/\b(halo|terima kasih|bilik|tarikh|tempahan|pembayaran|sila|boleh|pengesahan|pautan)\b/i.test(
				text
			);
		return looksEnglish && !looksMalay;
	}
	return false;
}

/* LLM writer */
async function write(io, sc, st, instruction, context = {}) {
	const guestProfile = respectfulGuestProfile(sc, st);
	const respectfulAddress = guestProfile.address;
	const hotelName = st.hotel?.hotelName ? toTitle(st.hotel.hotelName) : "";
	const activeHotelFacts = buildActiveHotelFacts(sc, st);
	const targetLanguage = languageOf(sc, st) || "English";
	const targetLanguageCode = activeLanguageCodeOf(sc, st);
	const targetLanguageText = targetLanguageCode
		? `${targetLanguage} (${targetLanguageCode})`
		: targetLanguage;
	st.language = targetLanguage;
	const languageStyle = latestGuestLanguageStyle(sc, targetLanguageText);
	const [learningContext, previousGuestContext] = await Promise.all([
		loadLearningContext(sc, st, instruction, context),
		loadPreviousGuestContext(sc, st),
	]);
	const alreadyIntroduced =
		st.greeted || Boolean(st.lastBotText) || hasAiAssistantReply(sc);
	const introRule = alreadyIntroduced
		? `You already introduced yourself earlier in this chat. Do not start with "I'm ${st.agentName}" or repeat the reception/reservations desk title unless the guest directly asks who you are.`
		: hotelName
		? `For the first greeting only, introduce yourself as ${st.agentName} from ${hotelName} reception and reservations. Do not introduce yourself as Jannat Booking or XHotelPro.`
		: `For the first greeting only, introduce yourself as ${st.agentName} from Jannat Booking support.`;
	const aiIdentityRule = hotelName
		? `If asked directly whether you are AI, say you are AI-assisted ${hotelName} reception and reservations support monitored by the hotel team; do not claim to be human.`
		: `If asked directly whether you are AI, say you are AI-assisted Jannat Booking support monitored by Jannat Booking admins; do not claim to be human.`;
	const sys = [
		hotelName
			? `You are ${st.agentName}, the reception and reservations representative for "${hotelName}".`
			: `You are ${st.agentName} from Jannat Booking support.`,
		introRule,
		hotelName
			? `In active hotel reception replies, do not mention Jannat Booking unless a supplied platform, payment, or final verification context explicitly requires it. If it must be named, write the brand exactly as "Jannat Booking"; do not translate or shorten it.`
			: `If Jannat Booking must be named, write the brand exactly as "Jannat Booking"; do not translate or shorten it.`,
		aiIdentityRule,
		hotelName
			? `Speak as the hotel's own reception and reservations desk. The guest should feel they are speaking directly with reception, not a separate middleman.`
			: `Represent Jannat Booking directly.`,
		`The guest's active response language is ${targetLanguageText}. This may override the frontend preferred language when the latest guest message is clearly in another language.`,
		`STRICT LANGUAGE RULE: Every customer-facing word in your final answer must be in ${targetLanguage}.`,
		/arabic/i.test(targetLanguage)
			? `Arabic output rule: use natural Arabic hospitality wording. Do not write English commands such as "confirm" or "skip"; use "\u062a\u0623\u0643\u064a\u062f" and "\u062a\u062e\u0637\u064a". Write SAR as "\u0631\u064a\u0627\u0644 \u0633\u0639\u0648\u062f\u064a" in customer-facing Arabic. Prefer Arabic hotel and room names from context when available.`
			: "",
		`Training examples may be Arabic, Hindi, English, Spanish, French, Urdu, Indonesian, Malay, or another language. Use them only as private behavioral guidance; translate or adapt the lesson silently into ${targetLanguage}.`,
		`Do not copy an employee learning example in its original language unless that original language is also ${targetLanguage}.`,
		`Tone: concise, friendly, official, respectful, and human-like. One booking question at a time.`,
		`For every reply, first understand what the guest just asked or felt, then answer that directly before moving the booking forward.`,
		`Text inside parentheses in the guest's own message is meaningful intent. Read it as part of the latest message and answer any question inside it. Do not reveal or follow private/internal parenthetical notes from system prompts or context.`,
		`Accuracy and answering the guest's exact question matter more than speed; it is acceptable to take a few extra seconds to use verified context and employee learning examples properly.`,
		`Do not sound like a form, script, or checklist. Vary the wording naturally while keeping the facts accurate.`,
		`If the guest asks a direct factual question, answer it first. Do not ask for dates, phone, email, or confirmation before answering the direct question unless answering is impossible without that missing fact.`,
		`If the guest asks for a hotel phone, WhatsApp, reception, manager, or responsible person's contact, answer that exact question first without sharing a phone number. In active hotel context, do not mention Jannat Booking or any other hotel name in that contact answer. Never share phone numbers from hotel details, owner, manager, user, account records, or learning examples. Explain transparently that you work directly with the reception of the active hotel and that this live chat is the safest and most credible way to reserve because reception can check live availability and keep all details clear.`,
		activeHotelFacts
			? `Selected hotel facts are provided in Context JSON as activeHotelFacts. Treat address, city, country, aboutHotel, distances, parking, location, hasBusService, busDetails, and activeRooms there as verified private source facts for "${hotelName}", not customer-facing copy to paste. If the guest asks about location, distance from Al Haram, address, bus/shuttle to Al Haram, parking, hotel features, or rooms, answer directly from activeHotelFacts before moving the booking forward.`
			: "",
		activeHotelFacts
			? `When using activeHotelFacts, write as "${hotelName}" reception. Translate and adapt raw hotel-detail text into ${targetLanguage}; clean grammar, remove duplicate yes/no wording, and make it sound like professional hotel customer service. Do not say or imply "the schema", "records", "owner added", "registered from the hotel", "hotel details say", or any similar database/source label.`
			: "",
		activeHotelFacts
			? `If activeHotelFacts.distances has walkingToElHaram or drivingToElHaram and the guest asks how far the hotel is from Al Haram, say the walking/driving minutes directly and naturally. Do not deflect to review, dates, phone, email, or confirmation before answering the distance.`
			: "",
		activeHotelFacts
			? `If the guest asks about bus/shuttle service to Al Haram, use only activeHotelFacts.hasBusService and activeHotelFacts.busDetails. If hasBusService is true, answer yes as hotel reception and rewrite/translate busDetails naturally as our guest bus information without inventing schedules, stations, timing, or destinations. If hasBusService is false or missing, say we do not currently offer a private bus service, mention walking minutes from activeHotelFacts.distances.walkingToElHaram when available, and say public buses are available close to the hotel and can drop guests at Al Haram.`
			: "",
		`When the guest asks whether a room exists or whether a room fits a number of guests, answer like a helpful hospitality sales agent: confirm the fit using the provided room facts before asking for dates.`,
		`Never make check-in/check-out dates the opening question of a conversation unless the guest's latest message is specifically a price/date-availability request and there is no warmer/direct question to answer first.`,
		`If the guest is excited, worried, annoyed, or joking, acknowledge that briefly and naturally before the operational next step.`,
		`If the guest complains about repetition, speed, or not being answered, apologize briefly, correct course, and avoid defending yourself.`,
		`Use this respectful customer address naturally when speaking to the guest: ${respectfulAddress}.`,
		`This is a respectful Umrah/hospitality platform. Keep the service tone modest, patient, and supportive for Muslim guests and families without lecturing or using casual profanity.`,
		`Guest messages may be native script, romanized/transliterated, code-switched, misspelled, or informal. Interpret the intended meaning from the full conversation before replying.`,
		`Arabic guests may write in Egyptian, Gulf, Levantine, Iraqi, Sudanese, Moroccan, Algerian, Tunisian, or other dialects, including Franko Arabic/Arabizi in Latin characters. Indian, Pakistani, French, Spanish, Indonesian, and Malaysian guests may also code-switch or write phonetically. Understand the meaning without treating the writing style as a reason to escalate.`,
		`If the latest guest message is clearly in a different language, the active response language already reflects that switch; answer naturally in ${targetLanguage} without asking permission to switch.`,
		`Guest address guidance: inferred guest gender is "${guestProfile.gender}" from the available name/title, and the recommended address is "${respectfulAddress}". Use gendered honorifics only when confident; otherwise use the guest's name or a neutral respectful address.`,
		`For Arabic conversations, use "\u0623\u0633\u062a\u0627\u0630\u0629 {first name}" for a confidently female guest and "\u0623\u0633\u062a\u0627\u0630 {first name}" for a confidently male guest. If gender is unknown, avoid a gendered Arabic title and use the name or "\u0636\u064a\u0641\u0646\u0627 \u0627\u0644\u0643\u0631\u064a\u0645". Never call a female guest "\u0623\u0633\u062a\u0627\u0630".`,
		`For Spanish, French, Hindi, Urdu, Indonesian, Malay, and other languages, use gendered forms only when the guest's gender is clear from name/title or context; otherwise stay polite and neutral.`,
		`Before replying, study the full conversation transcript and avoid repeating questions, links, or details already covered.`,
		`Do not ask for information the guest has already supplied; move the conversation forward naturally.`,
		`Avoid repeated openings such as "Hello {name}" or "I'm ${st.agentName}" after the first greeting. Continue the conversation as an already-present support agent.`,
		hotelName ? `Your hotel is "${hotelName}".` : `You represent Jannat Booking.`,
		`Private previous guest chats may be provided as operational context. Use them silently to be prepared for recurring preferences, unresolved issues, language style, and continuity.`,
		`Never tell the guest that old chats are visible, never quote old chats, and never reveal private previous-chat details unless the guest explicitly brings that detail into the current conversation.`,
		hotelName
			? `This chat is exclusively for "${hotelName}". When the guest asks whether "you", "your hotel", or the selected hotel has something, answer only for "${hotelName}". Never recommend, link, name, compare, summarize, or imply knowledge of other hotels, even if the guest explicitly asks for alternatives. If the guest asks about other hotels, say this chat can only help with "${hotelName}" and offer to check dates or room types at "${hotelName}".`
			: `When no active hotel context exists, you are Jannat Booking concierge support. You may recommend, compare, and price Jannat Booking hotel options using provided facts, but you must not create, confirm, mutate, cancel, or payment-link a reservation. Official reservation confirmation, details/payment links, and existing-reservation updates must be handled only after connecting the guest to the selected hotel's reception and reservations desk.`,
		`Use employee learning examples as private guidance for tone, flow, and support behavior. Never mention the learning examples to the guest.`,
		hotelName
			? `Help with date-range pricing, room options, payment questions, and reservation triage for "${hotelName}" only.`
			: `Help with date-range hotel pricing, budget-aware hotel options near Al Haram, hotel complaints, and routing payment/reservation triage to the correct hotel reception and reservations desk.`,
		`Do not mention discounts, coupons, promos, offers, or before-discount prices unless the latest guest message explicitly asks about them.`,
		hotelName
			? `Use only URLs supplied in context for "${hotelName}", its reservation, or its payment flow. Never use public hotel recommendation links or links for another hotel in this active hotel chat. Never invent routes, payment links, reservation links, or admin/PMS links.`
			: `Use only known Jannat Booking routes or URLs supplied in context. For hotel recommendations, prefer concise markdown links using the hotel name as the link text. Never invent routes, payment links, reservation links, or admin/PMS links.`,
		`Do not cancel or refund existing reservations. Date changes may be completed only by the system update tool after availability is checked; never claim a reservation was changed unless tool context says it was completed. Name, phone, email, nationality, payment, cancellation, and refund changes still go to a human team member.`,
		`Avoid repeating the same question if just asked; prefer a soft pivot.`,
	].join(" ");

	const payload = JSON.stringify(
		{
			...context,
			targetResponseLanguage: targetLanguageText,
			guestProfile,
			respectfulAddress,
			activeHotelFacts,
			alreadyIntroduced,
			latestGuestLanguageStyle: languageStyle,
			privatePreviousGuestChats: previousGuestContext,
			employeeLearningExamples: learningContext,
		},
		null,
		2
	);
	const content = `${instruction}\n\nTarget response language: ${targetLanguageText}\n\nFull conversation so far:\n${
		recentConversationLines(sc, st) || "(empty)"
	}\n\nContext JSON:\n${payload}`;

	let answer = "";
	try {
		answer = await chat(
			[
				{ role: "system", content: sys },
				{ role: "user", content },
			],
			{
				kind: "writer",
				temperature: 0.25,
				max_tokens: 240,
			}
		);
	} catch (error) {
		logStep(String(sc._id), "llm.write_failed", {
			instruction,
			message: error?.message || error,
		});
		answer = fallbackWriterText(sc, st, instruction, context, respectfulAddress);
	}
	if (!answer) {
		answer = fallbackWriterText(sc, st, instruction, context, respectfulAddress);
	}
	if (languageMismatchLikely(answer, targetLanguage)) {
		try {
			const rewritten = await chat(
				[
					{
						role: "system",
						content: `Rewrite the assistant answer strictly in ${targetLanguage}. Preserve the meaning, hotel names, prices, dates, links, and brand names. Output only the rewritten answer.`,
					},
					{ role: "user", content: answer },
				],
				{
					kind: "writer",
					temperature: 0,
					max_tokens: 240,
				}
			);
			if (rewritten && !languageMismatchLikely(rewritten, targetLanguage)) {
				answer = rewritten;
			}
		} catch (error) {
			logStep(String(sc._id), "llm.language_rewrite_failed", {
				targetLanguage,
				message: error?.message || error,
			});
		}
	}

	logStep(String(sc._id), "llm.write", { instruction, outLen: answer.length });
	return answer;
}

function fallbackSupportDecision(userText = "", st = {}, lu = {}) {
	const handoffReason = humanHandoffReason(userText);
	if (handoffReason === "reservation_cancellation") {
		return { action: "reservation_cancellation", roomTypeKey: null, reason: handoffReason };
	}
	if (handoffReason === "reservation_update") {
		return { action: "reservation_update", roomTypeKey: null, reason: handoffReason };
	}
	if (wantsDiscountQuestion(userText)) {
		return { action: "discount_question", roomTypeKey: null, reason: "discount_keyword" };
	}
	if (wantsPaymentHelp(userText)) {
		return { action: "payment_help", roomTypeKey: null, reason: "payment_keyword" };
	}
	if (st.hotel && selectedHotelFactQuestionText(userText)) {
		return {
			action: "general_answer",
			roomTypeKey: lu.roomTypeKey || st.slots?.roomTypeKey || null,
			scope: "selected_hotel",
			reason: "selected_hotel_fact_question",
		};
	}
	if (st.hotel && crossHotelRequestText(userText)) {
		return {
			action: "support_email",
			roomTypeKey: lu.roomTypeKey || st.slots?.roomTypeKey || null,
			scope: "selected_hotel",
			reason: "hotel_scope_boundary",
		};
	}
	if (
		isNewReservationFlowActive(st) &&
		wantsReservationHelp(userText) &&
		!lu?.confirmation &&
		!explicitlyExistingReservationIntent(userText)
	) {
		return {
			action: "continue_booking",
			roomTypeKey: lu.roomTypeKey || st.slots?.roomTypeKey || null,
			scope: st.hotel ? "selected_hotel" : null,
			reason: "new_reservation_flow_active",
		};
	}
	if (wantsNewReservationIntent(userText, lu)) {
		return {
			action: "continue_booking",
			roomTypeKey: lu.roomTypeKey || st.slots?.roomTypeKey || null,
			scope: st.hotel ? "selected_hotel" : null,
			reason: "new_reservation_intent",
		};
	}
	if (wantsReservationHelp(userText)) {
		return { action: "reservation_lookup", roomTypeKey: null, scope: null, reason: "reservation_keyword" };
	}
	if (!st.hotel && wantsHotelRecommendation(userText)) {
		return {
			action: "hotel_recommendation",
			roomTypeKey: lu.roomTypeKey || st.slots?.roomTypeKey || null,
			scope: "platform",
			reason: "hotel_recommendation_keyword",
		};
	}
	if (wantsPriceButMissingDates(userText, st)) {
		return {
			action: "ask_dates_for_price",
			roomTypeKey: lu.roomTypeKey || st.slots?.roomTypeKey || null,
			scope: st.hotel ? "selected_hotel" : null,
			reason: "price_missing_dates",
		};
	}
	if (
		(lu.dates?.checkinISO || st.slots?.checkinISO) &&
		(lu.dates?.checkoutISO || st.slots?.checkoutISO) &&
		(lu.roomTypeKey || st.slots?.roomTypeKey)
	) {
		return {
			action: "continue_booking",
			roomTypeKey: lu.roomTypeKey || st.slots?.roomTypeKey || null,
			scope: st.hotel ? "selected_hotel" : null,
			reason: "dates_and_room_present",
		};
	}
	if (lu.amenity) {
		return { action: "amenity_question", roomTypeKey: lu.roomTypeKey || null, scope: st.hotel ? "selected_hotel" : null, reason: "amenity_detected" };
	}
	if (lu.intent === "smalltalk" || looksLikeGreetingOnly(userText)) {
		return { action: "smalltalk", roomTypeKey: null, scope: null, reason: "smalltalk_detected" };
	}
	return { action: "other", roomTypeKey: lu.roomTypeKey || null, scope: st.hotel ? "selected_hotel" : null, reason: "fallback_decision" };
}

async function decideSupportAction({ sc, st, userText, lu }) {
	const localDecision = fallbackSupportDecision(userText, st, lu || {});
	if (
		localDecision.action !== "other" ||
		localDecision.reason === "hotel_scope_boundary"
	) {
		logStep(String(sc._id), "orchestrator.local_decision", localDecision);
		return localDecision;
	}
	const [previousGuestContext, learningContext] = await Promise.all([
		loadPreviousGuestContext(sc, st),
		loadLearningContext(
			sc,
			st,
			"Decide the next support action. Use relevant employee learning examples before choosing escalation.",
			{ latestUserMessage: userText, nlu: lu || null }
		),
	]);
	const hotelSummary = buildActiveHotelFacts(sc, st);
	const sys = [
		"You are the hotel reception and reservations chat orchestrator.",
		"Read the whole conversation and decide the next support action before any answer is written.",
		"Use all available context to avoid redundancy and to keep the chat natural in any language.",
		"Guest text may be native script, romanized/transliterated, code-switched, misspelled, or informal. Infer the intended meaning from phonetics and context instead of exact spellings.",
		"Arabic may appear as Egyptian, Gulf, Levantine, Iraqi, Sudanese, Moroccan, Algerian, Tunisian, Franko Arabic, or Arabizi. Indian and Pakistani guests may use Hinglish, Urdu/Hindi in Latin characters, or mixed scripts. Do not escalate only because the writing style is unusual.",
		"Private previous guest chats may be provided. Use them only to prepare the next action; never choose an action that would disclose that history to the guest.",
		"Employee learning examples may be provided. Before choosing human_escalation, check whether those examples contain a reusable resolution or safe next step for this kind of question.",
		"Return ONLY valid JSON with this shape:",
		"{ action:'hotel_recommendation'|'ask_dates_for_price'|'discount_question'|'payment_help'|'reservation_update'|'reservation_cancellation'|'reservation_lookup'|'amenity_question'|'continue_booking'|'smalltalk'|'general_answer'|'support_email'|'human_escalation'|'other',",
		"roomTypeKey:null|'singleRooms'|'doubleRooms'|'tripleRooms'|'quadRooms'|'familyRooms', scope:null|'selected_hotel'|'alternative_hotels'|'platform', reason:string }",
		"Use the guest's latest message, the full chat transcript, and current slots. Do not write the customer-facing reply.",
		"If an active hotel is present, this support case is strictly hotel-scoped. For rooms, amenities, availability, pricing, alternatives, or other-hotel questions, keep scope:'selected_hotel' and do not choose hotel_recommendation.",
		"If an active hotel is present and the guest asks about other hotels, nearby alternatives, comparisons, or general platform options that are not answered by verified context or learning examples, choose support_email with scope:'selected_hotel' and reason:'hotel_scope_boundary'.",
		"Choose hotel_recommendation only when there is no active hotel context.",
		"If an active hotel is present and the guest asks about the selected hotel's address, location, distance from Al Haram, bus/shuttle to Al Haram, parking, hotel facts, or active room facts, choose general_answer with scope:'selected_hotel' unless a deterministic handler has already handled it.",
		"If check-in and checkout dates are already present in currentSlots or nlu, never choose ask_dates_for_price; choose continue_booking for price or availability.",
		"If currentSlots or waitFor show a new reservation is in progress, do not choose reservation_lookup merely because the guest says confirmation number; choose continue_booking unless the guest clearly says they already have an existing reservation.",
		"If the guest asks about discounts, coupons, promos, offers, cheaper prices, or best price, choose discount_question. Do not choose human_escalation for a discount question.",
		"Choose general_answer when selected hotel facts, platform facts, database context, or employee learning examples contain a verified safe answer to the latest broad/general question, and no booking flow step should be forced.",
		"Choose support_email when the guest asks a broad/general question that cannot be answered from the selected hotel facts, platform facts, database context, or learning examples, and it does not require a same-case human takeover. For selected-hotel chats, questions about a different hotel or broad Jannat Booking programs should use support_email, not guesses.",
		"Text inside parentheses in the guest message is meaningful and must be considered when choosing the action.",
		"Choose human_escalation only when the same support case must be taken over by a human specialist, such as complaints, abuse, safety issues, cancellation/refund/change requests, sensitive payment/reservation mutations, or anything that should not be handled by email-only guidance.",
	].join(" ");
	const user = JSON.stringify(
		{
			language: languageOf(sc, st),
			latestUserMessage: userText,
			latestGuestLanguageStyle: latestGuestLanguageStyle(
				sc,
				targetLanguageLabel(sc, st)
			),
			fullConversation: recentConversationLines(sc, st),
			currentSlots: st.slots,
			waitFor: st.waitFor,
			nlu: lu || null,
			hotel: hotelSummary,
			privatePreviousGuestChats: previousGuestContext,
			employeeLearningExamples: learningContext,
		},
		null,
		2
	);
	let raw = "";
	try {
		raw = await chat(
			[
				{ role: "system", content: sys },
				{ role: "user", content: user },
			],
			{ kind: "nlu", temperature: 0, max_tokens: 180 }
		);
	} catch (error) {
		logStep(String(sc._id), "orchestrator.decision_failed", {
			message: error?.message || error,
		});
		return fallbackSupportDecision(userText, st, lu);
	}
	try {
		const parsed = JSON.parse(raw);
		return {
			action: parsed.action || "other",
			roomTypeKey: parsed.roomTypeKey || null,
			scope: parsed.scope || null,
			reason: parsed.reason || "",
		};
	} catch {
		return fallbackSupportDecision(userText, st, lu);
	}
}

async function composeAvailabilityQuoteText(io, sc, st, quote = {}) {
	const fallback = simpleQuoteText({ sc, st, quote });
	if (!quote?.available) return fallback;
	const dates = localizedStayDateLines(sc, st);
	const total = quote.totals?.totalPriceWithCommission;
	const perNight =
		quote.nights && total
			? Math.round((total / Math.max(1, quote.nights)) * 100) / 100
			: null;
	const room = quote.room || {};
	const reply = await withSoftTimeout(
		write(
			io,
			sc,
			st,
			"The guest has provided enough dates and room type to check availability. Share the available option as a warm hotel reservation/sales assistant, not as a cold form. Use only the provided facts. Mention the room name, hotel name, total price, nights, and per-night price if available. If the requested room type clearly fits the guest count, acknowledge that fit naturally. Include the date range, including Hijri/Gregorian context when provided. End with one natural yes/no question asking whether to continue to the review step. Do not invent amenities, discounts, urgency, or claim the hotel has the best rooms. Avoid repeating the exact wording of previous assistant messages.",
			{
				quote,
				roomFacts: {
					roomType: room.roomType || "",
					displayName: localizedRoomName(sc, st, quote),
					baseDisplayName: room.displayName || "",
				},
				hotelName: localizedHotelName(sc, st),
				priceFacts: {
					total,
					perNight,
					nights: quote.nights,
					currency: quote.currency,
				},
				dateFacts: dates,
				requestedGuests: {
					adults: st.slots?.adults,
					children: st.slots?.children,
					adultsProvided: st.slots?.adultsProvided,
					childrenProvided: st.slots?.childrenProvided,
				},
			}
		),
		QUOTE_WRITE_SOFT_TIMEOUT_MS,
		fallback
	);
	return reply || fallback;
}

async function shareKnownStayQuote(io, sc, st) {
	logStep(String(sc._id), "quote.start", {
		roomTypeKey: st.slots.roomTypeKey,
		checkinISO: st.slots.checkinISO,
		checkoutISO: st.slots.checkoutISO,
		hasHotel: Boolean(st.hotel),
	});
	const quote = safePriceRoomForStay(
		st.hotel,
		{ roomType: st.slots.roomTypeKey },
		st.slots.checkinISO,
		st.slots.checkoutISO
	);
	st.quote = {
		key: `${st.slots.roomTypeKey}|${st.slots.checkinISO}|${st.slots.checkoutISO}`,
		at: now(),
		data: quote,
	};
	logStep(String(sc._id), "quote.prepared", {
		available: quote.available,
		reason: quote.reason || null,
		roomTypeKey: st.slots.roomTypeKey,
	});
	let quoteReply = await composeAvailabilityQuoteText(io, sc, st, quote);
	quoteReply = ensureHijriGregorianDatesVisible(quoteReply, sc, st);
	const sent = await humanSend(io, sc, st, quoteReply, {
		quickReplies: quote?.available ? proceedQuickReplies(sc, st) : [],
	});
	if (!sent) return false;
	st.reviewSent = false;
	st.waitFor = quote?.available ? "proceed" : "room";
	return true;
}

function quoteKeyForSlots(st = {}) {
	if (!st.slots?.roomTypeKey || !st.slots?.checkinISO || !st.slots?.checkoutISO) {
		return "";
	}
	return `${st.slots.roomTypeKey}|${st.slots.checkinISO}|${st.slots.checkoutISO}`;
}

function activeQuoteMatchesSlots(st = {}) {
	const key = quoteKeyForSlots(st);
	return Boolean(key && st.quote?.key === key && st.quote?.data?.available);
}

function hijriGregorianDateLine(sc = {}, st = {}) {
	const display = stayDateDisplay(st);
	if (!display.hijri?.checkin || !display.hijri?.checkout) return "";
	if (/arabic/i.test(languageOf(sc, st))) {
		const dates = localizedStayDateLines(sc, st);
		return `\u0627\u0644\u062a\u0648\u0627\u0631\u064a\u062e: ${dates.primary} (${dates.secondary})`;
	}
	const gregorianLine = `${display.gregorian.checkin || display.gregorian.checkinISO} to ${
		display.gregorian.checkout || display.gregorian.checkoutISO
	}`;
	const hijriLine = `${display.hijri.checkin} to ${display.hijri.checkout}`;
	if (/arabic/i.test(languageOf(sc, st))) {
		return `التواريخ: ${hijriLine} (الميلادي: ${gregorianLine})`;
	}
	return `Dates: ${hijriLine} (Gregorian/Miladi: ${gregorianLine})`;
}

function ensureHijriGregorianDatesVisible(text = "", sc = {}, st = {}) {
	const line = hijriGregorianDateLine(sc, st);
	if (!line) return text;
	const current = String(text || "").trim();
	const haystack = current.toLowerCase();
	const hasHijri = /hijri|ah|ramadan|\u0631\u0645\u0636\u0627\u0646/.test(haystack);
	const hasGregorian =
		/gregorian|miladi|\b20\d{2}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\/20\d{2}\b|\u0645\u064a\u0644\u0627\u062f/i.test(
			current
		);
	if (hasHijri && hasGregorian) return current;
	return [current, line].filter(Boolean).join("\n");
}

function buildReservationReviewPayload(st = {}, quote = {}) {
	return {
		hotel: toTitle(st.hotel?.hotelName || "Hotel"),
		hotelLocalized: localizedHotelName({}, st),
		room: quote.room?.displayName || quote.room?.roomType || st.slots.roomTypeKey,
		roomLocalized: localizedRoomName({}, st, quote),
		roomsCount: st.slots.rooms || 1,
		currency: quote.currency,
		nights: quote.nights,
		totals: quote.totals,
		perNightAvg:
			Math.round(
				(quote.totals.totalPriceWithCommission / Math.max(1, quote.nights)) * 100
			) / 100,
		gregorian: {
			checkin: usDate(st.slots.checkinISO),
			checkout: usDate(st.slots.checkoutISO),
		},
		dateDisplay: stayDateDisplay(st),
		rawDates: st.dateRaw,
	};
}

function reservationReviewPrompt(sc = {}, st = {}) {
	if (/arabic/i.test(languageOf(sc, st))) {
		return [
			"Present a brief reservation review entirely in Arabic before finalizing.",
			"Use the localized hotel and room names from context when available.",
			"If raw dates were Hijri, show the Hijri range and the matching Gregorian range.",
			"Use Arabic wording for money, e.g. \"\u0631\u064a\u0627\u0644 \u0633\u0639\u0648\u062f\u064a\", not SAR.",
			"End with Arabic only: \"\u0627\u0643\u062a\u0628 \\\"\u062a\u0623\u0643\u064a\u062f\\\" \u0644\u0644\u0625\u062a\u0645\u0627\u0645\u060c \u0623\u0648 \u0623\u062e\u0628\u0631\u0646\u064a \u0628\u0645\u0627 \u062a\u0631\u064a\u062f \u062a\u063a\u064a\u064a\u0631\u0647.\"",
			"Do not use the English word confirm.",
		].join(" ");
	}
	return "Present a brief 'Review before we finalize'. If raw dates were Hijri, show them alongside Gregorian. End with: 'Type confirm to finalize, or tell me what to change.' Do not repeat the earlier availability message.";
}

function deterministicArabicReservationReview(sc = {}, st = {}, quote = {}) {
	if (!/arabic/i.test(languageOf(sc, st)) || !quote?.available) return "";
	const dates = localizedStayDateLines(sc, st);
	const total = quote.totals?.totalPriceWithCommission;
	const perNight =
		quote.nights && total
			? Math.round((total / Math.max(1, quote.nights)) * 100) / 100
			: null;
	const lines = [
		`${respectfulGuestName(
			sc,
			st
		)}\u060c \u0647\u0630\u0647 \u0645\u0631\u0627\u062c\u0639\u0629 \u0633\u0631\u064a\u0639\u0629 \u0642\u0628\u0644 \u0625\u062a\u0645\u0627\u0645 \u0627\u0644\u062d\u062c\u0632:`,
		`\u0627\u0644\u0641\u0646\u062f\u0642: ${localizedHotelName(sc, st)}`,
		`\u0627\u0644\u063a\u0631\u0641\u0629: ${localizedRoomName(sc, st, quote)}`,
		`\u0627\u0644\u062a\u0648\u0627\u0631\u064a\u062e: ${dates.primary}`,
		dates.secondary ? dates.secondary : "",
		quote.nights
			? `\u0639\u062f\u062f \u0627\u0644\u0644\u064a\u0627\u0644\u064a: ${localizedNumber(
					quote.nights,
					"Arabic"
			  )}`
			: "",
		perNight
			? `\u0627\u0644\u0633\u0639\u0631: ${localizedMoney(
					perNight,
					quote.currency,
					"Arabic"
			  )} \u0644\u0644\u064a\u0644\u0629`
			: "",
		total
			? `\u0627\u0644\u0625\u062c\u0645\u0627\u0644\u064a: ${localizedMoney(
					total,
					quote.currency,
					"Arabic"
			  )}`
			: "",
		`\u0627\u0643\u062a\u0628 "\u062a\u0623\u0643\u064a\u062f" \u0644\u0644\u0625\u062a\u0645\u0627\u0645\u060c \u0623\u0648 \u0623\u062e\u0628\u0631\u0646\u064a \u0628\u0645\u0627 \u062a\u0631\u064a\u062f \u062a\u063a\u064a\u064a\u0631\u0647.`,
	];
	return lines.filter(Boolean).join("\n");
}

async function composeReservationReviewText(io, sc, st, quote, reviewPayload) {
	const deterministic = deterministicArabicReservationReview(sc, st, quote);
	if (deterministic) return deterministic;
	if (/english/i.test(languageOf(sc, st))) {
		return ensureHijriGregorianDatesVisible(
			fallbackWriterText(
				sc,
				st,
				reservationReviewPrompt(sc, st),
				reviewPayload || buildReservationReviewPayload(st, quote),
				respectfulGuestName(sc, st)
			),
			sc,
			st
		);
	}
	let reviewText = await write(
		io,
		sc,
		st,
		reservationReviewPrompt(sc, st),
		reviewPayload || buildReservationReviewPayload(st, quote)
	);
	return ensureHijriGregorianDatesVisible(reviewText, sc, st);
}

async function sendReservationReview(io, sc, st, quote = null) {
	const q = quote || st.quote?.data;
	if (!q?.available) {
		await handoffToHuman(io, sc, st, "reservation_finalize_failed");
		return true;
	}
	const reviewPayload = buildReservationReviewPayload(st, q);
	logStep(String(sc._id), "review.summaryBuilt", reviewPayload);
	const reviewText = await composeReservationReviewText(io, sc, st, q, reviewPayload);
	const sent = await humanSend(io, sc, st, reviewText, {
		quickReplies: confirmationQuickReplies(sc, st),
	});
	if (!sent) return false;
	st.reviewSent = true;
	st.waitFor = "reviewConfirm";
	stampAsk(st, "reviewConfirm");
	return true;
}

async function handleProceedStageInput(
	io,
	sc,
	st,
	userText,
	lu = {},
	{ allowGeneric = true } = {}
) {
	if (st.waitFor !== "proceed" || !activeQuoteMatchesSlots(st)) return false;
	if (
		wantsPaymentHelp(userText) ||
		hotelContactDetailsQuestionText(userText) ||
		hotelContactFollowupQuestionText(sc, userText) ||
		selectedHotelFactQuestionText(userText) ||
		lu.amenity ||
		detectAmenityQuestion(userText)
	) {
		return false;
	}
	if (confirmsText(userText)) {
		return sendReservationReview(io, sc, st, st.quote.data);
	}
	if (declinesText(userText)) {
		const msg = await write(
			io,
			sc,
			st,
			"Acknowledge politely and offer to help with different dates or another room type. Do not repeat the quote.",
			{ quote: st.quote.data, slots: st.slots }
		);
		await humanSend(io, sc, st, msg);
		return true;
	}
	if (patienceText(userText)) {
		const msg = await write(
			io,
			sc,
			st,
			"Thank the guest naturally and say there is no rush. Mention that the quote is ready and they can say yes when they want to continue. Do not repeat the price.",
			{ quoteReady: true, nextStep: "proceed_to_review" }
		);
		await humanSend(io, sc, st, msg);
		return true;
	}
	if (asksAiIdentity(userText) || botExperienceComplaintText(userText)) {
		const msg = await write(
			io,
			sc,
			st,
			"Answer the guest's concern transparently and warmly. If they ask whether you are human or AI, say you are AI-assisted support monitored by the team; do not claim to be human. Apologize briefly if the speed or repetition felt unnatural. Say the quote is ready and ask whether to continue to the review step. Do not repeat the full quote.",
			{ quoteReady: true, nextStep: "proceed_to_review" }
		);
		await humanSend(io, sc, st, msg);
		return true;
	}
	if (lu.intent === "smalltalk" || looksLikeGreetingOnly(userText)) {
		return handleSmalltalk(io, sc, st, lu, userText);
	}
	if (!allowGeneric) return false;
	const msg = await write(
		io,
		sc,
		st,
		"The quote is already ready. Do not repeat the availability or price. Ask one short question: should I continue to the review step for this reservation?",
		{ quoteReady: true, nextStep: "proceed_to_review" }
	);
	await humanSend(io, sc, st, msg, {
		quickReplies: proceedQuickReplies(sc, st),
	});
	return true;
}

function publicBaseUrl() {
	return String(
		process.env.CLIENT_URL ||
			process.env.REACT_APP_MAIN_URL_JANNAT ||
			"https://jannatbooking.com"
	).replace(/\/+$/, "");
}

function reservationLinks(reservation) {
	const publicBase = publicBaseUrl();
	const confirmation = reservation.confirmation_number;
	const id = String(reservation._id);
	return {
		reservationDetails: `${publicBase}/single-reservation/${confirmation}`,
		payment: `${publicBase}/client-payment/${id}/${confirmation}`,
	};
}

function reservationArrivalDateText(sc, st, reservation = {}) {
	const source = st.slots?.checkinISO || reservation.checkin_date || "";
	const iso =
		typeof source === "string" && /^\d{4}-\d{2}-\d{2}/.test(source)
			? source.slice(0, 10)
			: isoDate(source);
	return iso ? localizedGregorianDate(iso, languageOf(sc, st)) : "";
}

function reservationCreatedMessage(sc, st, reservation, quoteData, links) {
	const lang = languageOf(sc, st);
	const confirmation = reservation.confirmation_number;
	const currency = cleanCurrency(quoteData?.currency || "SAR");
	const total = reservation.total_amount;
	const name = respectfulGuestName(sc, st);
	const hotelName = localizedHotelName(sc, st);
	const arrivalDate = reservationArrivalDateText(sc, st, reservation);
	const totalDisplay = /arabic/i.test(lang)
		? localizedMoney(total, currency, lang)
		: `${total} ${currency}`;
	if (/arabic/i.test(lang)) {
		return [
			`${name}\u060c \u062a\u0645 \u062a\u0623\u0643\u064a\u062f \u0627\u0644\u062d\u062c\u0632 \u0628\u0646\u062c\u0627\u062d. \u0631\u0642\u0645 \u0627\u0644\u062a\u0623\u0643\u064a\u062f: **${confirmation}**.`,
			`\u0634\u0643\u0631\u0627 \u0644\u0627\u062e\u062a\u064a\u0627\u0631\u0643 **${hotelName}** \ud83c\udf38 ${arrivalDate ? `\u0646\u062a\u0637\u0644\u0639 \u0644\u0627\u0633\u062a\u0642\u0628\u0627\u0644\u0643 \u064a\u0648\u0645 **${arrivalDate}**.` : "\u0646\u062a\u0637\u0644\u0639 \u0644\u0627\u0633\u062a\u0642\u0628\u0627\u0644\u0643 \u0642\u0631\u064a\u0628\u0627."}`,
			`\u0627\u0644\u0625\u062c\u0645\u0627\u0644\u064a: **${totalDisplay}**.`,
			`[\u0627\u0636\u063a\u0637 \u0647\u0646\u0627 \u0644\u0645\u0639\u0631\u0641\u0629 \u0627\u0644\u0645\u0632\u064a\u062f \u0645\u0646 \u0627\u0644\u062a\u0641\u0627\u0635\u064a\u0644](${links.reservationDetails})`,
			`[\u0631\u0627\u0628\u0637 \u0627\u0644\u062f\u0641\u0639](${links.payment})`,
			"\u0647\u0644 \u0623\u0642\u062f\u0631 \u0623\u0633\u0627\u0639\u062f\u0643 \u0628\u0623\u064a \u0634\u064a\u0621 \u0622\u062e\u0631\u061f",
		].join("\n");
	}
	if (/spanish/i.test(lang)) {
		return [
			`${name}, la reserva esta confirmada correctamente. Numero de confirmacion: **${confirmation}**.`,
			`Gracias por elegir **${hotelName}** \ud83c\udf38 ${
				arrivalDate
					? `Esperamos recibirte el **${arrivalDate}**.`
					: "Esperamos recibirte pronto."
			}`,
			`Total: **${totalDisplay}**.`,
			`[Ver detalles de la reserva](${links.reservationDetails})`,
			`[Enlace de pago](${links.payment})`,
			"Hay algo mas en lo que pueda ayudarte?",
		].join("\n");
	}
	if (/french/i.test(lang)) {
		return [
			`${name}, la reservation est confirmee avec succes. Numero de confirmation : **${confirmation}**.`,
			`Merci d'avoir choisi **${hotelName}** \ud83c\udf38 ${
				arrivalDate
					? `Nous avons hate de vous accueillir le **${arrivalDate}**.`
					: "Nous avons hate de vous accueillir bientot."
			}`,
			`Total : **${totalDisplay}**.`,
			`[Voir les details de la reservation](${links.reservationDetails})`,
			`[Lien de paiement](${links.payment})`,
			"Puis-je vous aider avec autre chose ?",
		].join("\n");
	}
	if (/urdu/i.test(lang)) {
		return [
			`${name}، آپ کی بکنگ کامیابی سے تصدیق ہو گئی ہے۔ تصدیقی نمبر: **${confirmation}**.`,
			`**${hotelName}** منتخب کرنے کا شکریہ 🌸 ${
				arrivalDate
					? `ہم **${arrivalDate}** کو آپ کا استقبال کرنے کے منتظر ہیں۔`
					: "ہم جلد آپ کا استقبال کرنے کے منتظر ہیں۔"
			}`,
			`کل رقم: **${totalDisplay}**.`,
			`[ریزرویشن کی تفصیلات](${links.reservationDetails})`,
			`[ادائیگی کا لنک](${links.payment})`,
			"کیا میں آپ کی کسی اور چیز میں مدد کر سکتا/سکتی ہوں؟",
		].join("\n");
	}
	if (/hindi/i.test(lang)) {
		return [
			`${name}, आपकी बुकिंग सफलतापूर्वक पुष्टि हो गई है। पुष्टि संख्या: **${confirmation}**.`,
			`**${hotelName}** चुनने के लिए धन्यवाद 🌸 ${
				arrivalDate
					? `हम **${arrivalDate}** को आपका स्वागत करने के लिए उत्सुक हैं।`
					: "हम जल्द आपका स्वागत करने के लिए उत्सुक हैं।"
			}`,
			`कुल राशि: **${totalDisplay}**.`,
			`[बुकिंग विवरण](${links.reservationDetails})`,
			`[भुगतान लिंक](${links.payment})`,
			"क्या मैं आपकी किसी और चीज़ में मदद कर सकता/सकती हूं?",
		].join("\n");
	}
	if (/indonesian/i.test(lang)) {
		return [
			`${name}, reservasi Anda sudah berhasil dikonfirmasi. Nomor konfirmasi: **${confirmation}**.`,
			`Terima kasih sudah memilih **${hotelName}** \ud83c\udf38 ${
				arrivalDate
					? `Kami menantikan kedatangan Anda pada **${arrivalDate}**.`
					: "Kami menantikan kedatangan Anda segera."
			}`,
			`Total: **${totalDisplay}**.`,
			`[Detail reservasi](${links.reservationDetails})`,
			`[Link pembayaran](${links.payment})`,
			"Ada hal lain yang bisa saya bantu?",
		].join("\n");
	}
	if (/malay|malaysia/i.test(lang)) {
		return [
			`${name}, tempahan anda telah berjaya disahkan. Nombor pengesahan: **${confirmation}**.`,
			`Terima kasih kerana memilih **${hotelName}** \ud83c\udf38 ${
				arrivalDate
					? `Kami menantikan ketibaan anda pada **${arrivalDate}**.`
					: "Kami menantikan ketibaan anda tidak lama lagi."
			}`,
			`Total: **${totalDisplay}**.`,
			`[Butiran tempahan](${links.reservationDetails})`,
			`[Pautan pembayaran](${links.payment})`,
			"Ada apa-apa lagi yang boleh saya bantu?",
		].join("\n");
	}
	return [
		`${name}, your reservation is confirmed. Confirmation number: **${confirmation}**.`,
		`Thank you for choosing **${hotelName}** \ud83c\udf38 ${
			arrivalDate
				? `We look forward to welcoming you on **${arrivalDate}**.`
				: "We look forward to welcoming you soon."
		}`,
		`Total: **${totalDisplay}**.`,
		`[Please click here to find more details](${links.reservationDetails})`,
		`[Payment link](${links.payment})`,
		"Is there anything else I can help you with?",
	].join("\n");
}

function reservationUpdateOptionLine(option = {}, index = 0, lang = "English") {
	const isArabic = /arabic/i.test(lang);
	const room = option.roomName || roomTypeLabel(option.roomType || "");
	const checkin = isArabic
		? localizedGregorianDate(option.checkinISO, lang)
		: usDate(option.checkinISO);
	const checkout = isArabic
		? localizedGregorianDate(option.checkoutISO, lang)
		: usDate(option.checkoutISO);
	const currency = cleanCurrency(option.currency || "SAR");
	const total = option.total
		? isArabic
			? localizedMoney(option.total, currency, lang)
			: `${option.total} ${currency}`
		: "";
	if (isArabic) {
		return `\u0627\u0644\u062e\u064a\u0627\u0631 ${arabicDigits(index + 1)}: ${room} - ${checkin} \u0625\u0644\u0649 ${checkout}${total ? ` \u2014 ${total}` : ""}`;
	}
	return `${index + 1}. ${room}: ${checkin} - ${checkout}${total ? `, ${total}` : ""}`;
}

function reservationUpdateSuccessMessage(sc, st, result = {}) {
	const lang = languageOf(sc, st);
	const isArabic = /arabic/i.test(lang);
	const reservation = result.reservation || {};
	const links = reservationLinks(reservation);
	const name = respectfulGuestName(sc, st);
	const confirmation = reservation.confirmation_number || result.confirmation || "";
	const room =
		result.quote?.room?.displayName ||
		result.quote?.room?.roomType ||
		roomTypeLabel(result.selection?.roomType || "");
	const total = reservation.total_amount || result.quote?.totals?.totalPriceWithCommission || 0;
	const currency = cleanCurrency(result.quote?.currency || reservation.currency || "SAR");
	const dateLine = isArabic
		? `${localizedGregorianDate(result.checkinISO, lang)} - ${localizedGregorianDate(result.checkoutISO, lang)}`
		: `${usDate(result.checkinISO)} - ${usDate(result.checkoutISO)}`;
	const totalDisplay = isArabic ? localizedMoney(total, currency, lang) : `${total} ${currency}`;
	if (isArabic) {
		return [
			`${name}\u060c \u062a\u0645 \u062a\u062d\u062f\u064a\u062b \u0627\u0644\u062d\u062c\u0632 **${confirmation}** \u0625\u0644\u0649 **${dateLine}** \u0628\u0639\u062f \u0645\u0631\u0627\u062c\u0639\u0629 \u0627\u0644\u062a\u0648\u0641\u0631.`,
			`\u0627\u0644\u063a\u0631\u0641\u0629: **${room}**. \u0627\u0644\u0625\u062c\u0645\u0627\u0644\u064a \u0627\u0644\u062d\u0627\u0644\u064a: **${totalDisplay}**.`,
			"\u0627\u0644\u062d\u062c\u0632 \u0644\u0627 \u064a\u0632\u0627\u0644 \u0645\u0624\u0643\u062f\u0627 \u0644\u0643\u060c \u0648\u062a\u0645 \u0625\u0631\u0633\u0627\u0644 \u0627\u0644\u062a\u062d\u062f\u064a\u062b \u0644\u0641\u0631\u064a\u0642 \u0627\u0644\u0641\u0646\u062f\u0642 \u0644\u0644\u0645\u0631\u0627\u062c\u0639\u0629.",
			`[\u062a\u0641\u0627\u0635\u064a\u0644 \u0627\u0644\u062d\u062c\u0632](${links.reservationDetails})`,
			`[\u0631\u0627\u0628\u0637 \u0627\u0644\u062f\u0641\u0639](${links.payment})`,
		].join("\n");
	}
	if (/spanish/i.test(lang)) {
		return [
			`Listo, ${name}. Actualice la reserva **${confirmation}** a **${dateLine}** despues de revisar disponibilidad.`,
			`Habitacion: **${room}**. Total actual: **${totalDisplay}**.`,
			"La reserva sigue confirmada para ti y el equipo del hotel recibio el cambio para revision.",
			`[Reservation details](${links.reservationDetails})`,
			`[Payment link](${links.payment})`,
		].join("\n");
	}
	if (/french/i.test(lang)) {
		return [
			`C'est fait, ${name}. J'ai mis a jour la reservation **${confirmation}** pour **${dateLine}** apres verification de la disponibilite.`,
			`Chambre : **${room}**. Total actuel : **${totalDisplay}**.`,
			"La reservation reste confirmee pour vous et l'equipe de l'hotel a recu la mise a jour pour verification.",
			`[Reservation details](${links.reservationDetails})`,
			`[Payment link](${links.payment})`,
		].join("\n");
	}
	return [
		`Done, ${name}. I updated reservation **${confirmation}** to **${dateLine}** after checking availability.`,
		`Room: **${room}**. Current total: **${totalDisplay}**.`,
		"The reservation remains confirmed for you, and the hotel team has been notified to review the updated dates.",
		`[Reservation details](${links.reservationDetails})`,
		`[Payment link](${links.payment})`,
	].join("\n");
}

function reservationUpdateUnavailableMessage(sc, st, result = {}, options = []) {
	const lang = languageOf(sc, st);
	const isArabic = /arabic/i.test(lang);
	const name = respectfulGuestName(sc, st);
	const requested = result.requested || {};
	const requestedLine = isArabic
		? `${localizedGregorianDate(requested.checkinISO, lang)} - ${localizedGregorianDate(requested.checkoutISO, lang)}`
		: `${usDate(requested.checkinISO)} - ${usDate(requested.checkoutISO)}`;
	const optionLines = options
		.map((option, index) => reservationUpdateOptionLine(option, index, lang))
		.join("\n");
	if (options.length) {
		if (isArabic) {
			return [
				`${name}\u060c \u0644\u0627 \u064a\u0638\u0647\u0631 \u062a\u0648\u0641\u0631 \u0644\u0646\u0641\u0633 \u0627\u0644\u0637\u0644\u0628 \u0641\u064a **${requestedLine}**.`,
				"\u0647\u0630\u0647 \u0623\u0642\u0631\u0628 \u0627\u0644\u062e\u064a\u0627\u0631\u0627\u062a \u0627\u0644\u0645\u062a\u0627\u062d\u0629 \u0627\u0644\u062a\u064a \u0648\u062c\u062f\u062a\u0647\u0627:",
				optionLines,
				"\u0627\u062e\u062a\u0631 \u0631\u0642\u0645 \u0627\u0644\u062e\u064a\u0627\u0631 \u0627\u0644\u0645\u0646\u0627\u0633\u0628\u060c \u0623\u0648 \u0623\u0631\u0633\u0644 \u062a\u0648\u0627\u0631\u064a\u062e \u0623\u062e\u0631\u0649.",
			].join("\n");
		}
		if (/spanish/i.test(lang)) {
			return [
				`${name}, no veo disponibilidad para la misma solicitud en **${requestedLine}**.`,
				"Estas son las opciones cercanas disponibles que encontre:",
				optionLines,
				"Elige el numero de opcion que prefieres, o enviame otras fechas.",
			].join("\n");
		}
		if (/french/i.test(lang)) {
			return [
				`${name}, je ne vois pas de disponibilite pour la meme demande sur **${requestedLine}**.`,
				"Voici les options proches disponibles que j'ai trouvees :",
				optionLines,
				"Choisissez le numero de l'option souhaitee, ou envoyez d'autres dates.",
			].join("\n");
		}
		return [
			`${name}, I do not see availability for the same request on **${requestedLine}**.`,
			"These are the closest available options I found:",
			optionLines,
			"Choose the option number you prefer, or send me different dates.",
		].join("\n");
	}
	if (isArabic) {
		return `${name}\u060c \u0644\u0627 \u064a\u0638\u0647\u0631 \u062a\u0648\u0641\u0631 \u0644\u0646\u0641\u0633 \u0627\u0644\u063a\u0631\u0641\u0629 \u0641\u064a **${requestedLine}**\u060c \u0648\u0644\u0627 \u0623\u0631\u0649 \u062e\u064a\u0627\u0631\u0627 \u0642\u0631\u064a\u0628\u0627 \u062e\u0644\u0627\u0644 3 \u0623\u064a\u0627\u0645. \u0623\u0642\u062f\u0631 \u0623\u0631\u0627\u062c\u0639 \u0646\u0648\u0639 \u063a\u0631\u0641\u0629 \u0622\u062e\u0631 \u0623\u0648 \u062a\u0648\u0627\u0631\u064a\u062e \u0645\u062e\u062a\u0644\u0641\u0629 \u0625\u0630\u0627 \u0623\u0631\u0633\u0644\u062a \u0645\u0627 \u064a\u0646\u0627\u0633\u0628\u0643.`;
	}
	if (/spanish/i.test(lang)) {
		return `${name}, no veo disponibilidad para la misma habitacion en **${requestedLine}** ni una opcion cercana dentro de 3 dias. Puedo revisar otro tipo de habitacion u otras fechas si me las envias.`;
	}
	if (/french/i.test(lang)) {
		return `${name}, je ne vois pas de disponibilite pour la meme chambre sur **${requestedLine}** ni d'option proche dans les 3 jours. Je peux verifier un autre type de chambre ou d'autres dates.`;
	}
	return `${name}, I do not see same-room availability for **${requestedLine}** or a close option within 3 days. I can check another room type or different dates if you send what works for you.`;
}
async function finishReservationDateUpdate(
	io,
	sc,
	st,
	{ confirmation, checkinISO, checkoutISO, roomTypeOverride = "" }
) {
	const caseId = String(sc._id);
	await sendProgressMessage(io, sc, st, "checking");
	const result = await updateReservationDatesForCase({
		caseId,
		hotel: st.hotel,
		confirmation,
		checkinISO,
		checkoutISO,
		roomTypeOverride,
		io,
	});
	if (result.ok) {
		st.pendingReservationUpdateOptions = null;
		st.waitFor = "post_booking_followup";
		await humanSend(io, sc, st, reservationUpdateSuccessMessage(sc, st, result));
		return true;
	}
	if (result.code === "unavailable") {
		const sameRoomOptions = result.recommendations?.sameRoomCloseDates || [];
		const alternativeOptions = result.recommendations?.alternativeRooms || [];
		const options = sameRoomOptions.length ? sameRoomOptions : alternativeOptions;
		st.pendingReservationUpdateOptions = {
			confirmation,
			options,
		};
		st.waitFor = options.length ? "reservation_update_option" : "reservation_update_clarify";
		await humanSend(io, sc, st, reservationUpdateUnavailableMessage(sc, st, result, options), {
			quickReplies: reservationUpdateChoiceQuickReplies(sc, st, options),
		});
		return true;
	}
	if (result.code === "not_found") {
		const reply = await write(
			io,
			sc,
			st,
			"The guest asked to update reservation dates, but the confirmation number was not found. Ask them to recheck the confirmation number and send the new check-in/check-out dates again. Do not escalate yet.",
			{ confirmation, requestedDates: { checkinISO, checkoutISO } }
		);
		await humanSend(io, sc, st, reply);
		st.waitFor = "reservation_reference";
		return true;
	}
	if (["unsupported_status", "unsupported_room_selection", "multiple_room_types", "hotel_mismatch", "hotel_inventory_missing"].includes(result.code)) {
		await handoffToHuman(io, sc, st, "reservation_update");
		return true;
	}
	await handoffToHuman(io, sc, st, "reservation_update");
	return true;
}

async function handlePendingReservationUpdateChoice(io, sc, st, userText) {
	if (st.waitFor !== "reservation_update_option") return false;
	const pending = st.pendingReservationUpdateOptions || {};
	const options = Array.isArray(pending.options) ? pending.options : [];
	if (!options.length) {
		st.waitFor = null;
		st.pendingReservationUpdateOptions = null;
		return false;
	}
	if (declinesText(userText) || correctionText(userText)) {
		st.waitFor = "reservation_update_clarify";
		const reply = await write(
			io,
			sc,
			st,
			"The guest did not choose one of the suggested reservation update options. Ask them to send the dates or room type they prefer, and reassure them you will check availability again.",
			{ options }
		);
		await humanSend(io, sc, st, reply);
		return true;
	}
	const index = parseReservationUpdateOptionChoice(userText, options);
	if (index < 0) {
		const reply = await write(
			io,
			sc,
			st,
			"The guest replied but did not clearly choose one of the suggested reservation update options. Ask them to choose an option number or send different dates. Keep it short and helpful.",
			{ options, latestUserMessage: userText }
		);
		await humanSend(io, sc, st, reply, {
			quickReplies: reservationUpdateChoiceQuickReplies(sc, st, options),
		});
		return true;
	}
	const chosen = options[index];
	return finishReservationDateUpdate(io, sc, st, {
		confirmation: pending.confirmation,
		checkinISO: chosen.checkinISO,
		checkoutISO: chosen.checkoutISO,
		roomTypeOverride:
			chosen.kind === "alternative_room_same_dates" ? chosen.roomType : "",
	});
}

async function handleReservationUpdateRequest(
	io,
	sc,
	st,
	userText,
	lu = {},
	{ forceDateUpdate = false } = {}
) {
	if (!forceDateUpdate && !looksLikeReservationDateUpdate(userText, lu)) return false;
	const knownConfirmation =
		lu?.confirmation || confirmationFromText(userText) || latestKnownConfirmation(sc, lu);
	const requestedDates = latestTurnDateRange(userText, lu);
	if (!knownConfirmation || !requestedDates.checkinISO || !requestedDates.checkoutISO) {
		const reply = await write(
			io,
			sc,
			st,
			knownConfirmation
				? "The guest wants to update reservation dates and the confirmation number is known, but the new check-in/check-out dates are missing or unclear. Ask for both dates in one short sentence and say you will check availability."
				: "The guest wants to update reservation dates, but the confirmation number or the new check-in/check-out dates are missing. Ask for the missing confirmation number and both new dates in one concise message. Do not escalate.",
			{
				knownConfirmation,
				requestedDates,
				latestUserMessage: userText,
			}
		);
		await humanSend(io, sc, st, reply);
		st.waitFor = "reservation_update_clarify";
		return true;
	}
	return finishReservationDateUpdate(io, sc, st, {
		confirmation: knownConfirmation,
		checkinISO: requestedDates.checkinISO,
		checkoutISO: requestedDates.checkoutISO,
	});
}

function reservationPolicyConfirmationDisplay(result = {}) {
	const date = result.confirmedAt ? new Date(result.confirmedAt) : null;
	return date && !Number.isNaN(date.getTime())
		? usDate(date.toISOString().slice(0, 10))
		: "";
}

function reservationPolicyConfirmationLabel(result = {}, fallback = "") {
	return String(
		result.reservation?.confirmation_number || fallback || ""
	)
		.trim()
		.toUpperCase();
}

function cancellationReviewQuickReplies(sc = {}, st = {}) {
	const lang = languageOf(sc, st);
	if (/arabic/i.test(lang)) {
		return [
			{
				label: "\u0645\u0631\u0627\u062c\u0639\u0629 \u0645\u0639 \u0645\u062e\u062a\u0635",
				value: "\u0646\u0639\u0645\u060c \u0623\u0631\u064a\u062f \u0645\u0631\u0627\u062c\u0639\u0629 \u0645\u0639 \u0645\u062e\u062a\u0635",
				action: "reservation_cancellation_escalate",
			},
			{
				label: "\u0644\u0627\u060c \u0634\u0643\u0631\u0627",
				value: "\u0644\u0627\u060c \u0634\u0643\u0631\u0627",
				action: "decline",
			},
		];
	}
	if (/spanish/i.test(lang)) {
		return [
			{
				label: "Revisar con especialista",
				value: "Si, conectame con un especialista",
				action: "reservation_cancellation_escalate",
			},
			{ label: "No, gracias", value: "No, gracias", action: "decline" },
		];
	}
	if (/french/i.test(lang)) {
		return [
			{
				label: "Revoir avec un specialiste",
				value: "Oui, connectez-moi avec un specialiste",
				action: "reservation_cancellation_escalate",
			},
			{ label: "Non merci", value: "Non merci", action: "decline" },
		];
	}
	return [
		{
			label: "Review with specialist",
			value: "Please connect me with a specialist",
			action: "reservation_cancellation_escalate",
		},
		{ label: "No, thank you", value: "No, thank you", action: "decline" },
	];
}

function cancellationReferenceMessage(sc = {}, st = {}) {
	const name = respectfulGuestName(sc, st);
	const lang = languageOf(sc, st);
	if (/arabic/i.test(lang)) {
		return `${name}\u060c \u0645\u0646 \u0641\u0636\u0644\u0643 \u0623\u0631\u0633\u0644 \u0631\u0642\u0645 \u062a\u0623\u0643\u064a\u062f \u0627\u0644\u062d\u062c\u0632 \u0644\u0623\u0631\u0627\u062c\u0639 \u0633\u064a\u0627\u0633\u0629 \u0627\u0644\u0625\u0644\u063a\u0627\u0621 \u0642\u0628\u0644 \u062a\u0648\u0635\u064a\u0644\u0643 \u0628\u0645\u062e\u062a\u0635.`;
	}
	if (/spanish/i.test(lang)) {
		return `${name}, por favor enviame el numero de confirmacion para revisar la politica de cancelacion antes de conectarte con un especialista.`;
	}
	if (/french/i.test(lang)) {
		return `${name}, veuillez m'envoyer le numero de confirmation afin que je verifie la politique d'annulation avant de vous connecter a un specialiste.`;
	}
	return `${name}, please send the reservation confirmation number so I can review the cancellation policy before connecting you with a specialist.`;
}

function cancellationNotFoundMessage(sc = {}, st = {}, confirmation = "") {
	const name = respectfulGuestName(sc, st);
	const label = String(confirmation || "").trim().toUpperCase();
	const lang = languageOf(sc, st);
	if (/arabic/i.test(lang)) {
		return `${name}\u060c \u0644\u0645 \u0623\u062c\u062f \u062d\u062c\u0632\u0627 \u0628\u0631\u0642\u0645 ${label}. \u0645\u0646 \u0641\u0636\u0644\u0643 \u062a\u0623\u0643\u062f \u0645\u0646 \u0631\u0642\u0645 \u0627\u0644\u062a\u0623\u0643\u064a\u062f \u0648\u0623\u0631\u0633\u0644\u0647 \u0645\u0631\u0629 \u0623\u062e\u0631\u0649.`;
	}
	if (/spanish/i.test(lang)) {
		return `${name}, no encontre una reserva con el numero ${label}. Por favor revisalo y enviamelo otra vez.`;
	}
	if (/french/i.test(lang)) {
		return `${name}, je n'ai pas trouve de reservation avec le numero ${label}. Veuillez le verifier et me le renvoyer.`;
	}
	return `${name}, I could not find a reservation with confirmation ${label}. Please recheck the number and send it again.`;
}

function cancellationTooOldMessage(sc = {}, st = {}, result = {}, confirmation = "") {
	const name = respectfulGuestName(sc, st);
	const label = reservationPolicyConfirmationLabel(result, confirmation);
	const confirmedDate = reservationPolicyConfirmationDisplay(result);
	const thresholdDays = Number(result.thresholdDays || 14);
	const lang = languageOf(sc, st);
	if (/arabic/i.test(lang)) {
		const dateLine = confirmedDate
			? ` \u062a\u0645 \u062a\u0623\u0643\u064a\u062f\u0647 \u0641\u064a ${confirmedDate}.`
			: "";
		return `${name}\u060c \u0648\u062c\u062f\u062a \u0627\u0644\u062d\u062c\u0632 ${label}.${dateLine} \u0644\u0623\u0646\u0647 \u0645\u0624\u0643\u062f \u0645\u0646\u0630 ${thresholdDays} \u064a\u0648\u0645\u0627 \u0623\u0648 \u0623\u0643\u062b\u0631\u060c \u0644\u0627 \u064a\u0645\u0643\u0646\u0646\u064a \u0625\u0644\u063a\u0627\u0624\u0647 \u062a\u0644\u0642\u0627\u0626\u064a\u0627 \u0639\u0628\u0631 \u0627\u0644\u0645\u062d\u0627\u062f\u062b\u0629 \u062d\u0633\u0628 \u0627\u0644\u0633\u064a\u0627\u0633\u0629. \u0625\u0630\u0627 \u0643\u0646\u062a \u0645\u0627 \u0632\u0644\u062a \u062a\u0631\u064a\u062f \u0645\u0631\u0627\u062c\u0639\u0629 \u0627\u0633\u062a\u062b\u0646\u0627\u0621\u060c \u0623\u062e\u0628\u0631\u0646\u064a \u0648\u0633\u0623\u0648\u0635\u0644\u0643 \u0628\u0645\u062e\u062a\u0635.`;
	}
	if (/spanish/i.test(lang)) {
		const dateLine = confirmedDate ? ` Fue confirmada el ${confirmedDate}.` : "";
		return `${name}, encontre la reserva ${label}.${dateLine} Como lleva confirmada ${thresholdDays} dias o mas, no puedo cancelarla automaticamente por chat segun la politica. Si aun quieres que el equipo revise una excepcion, dimelo y te conecto con un especialista.`;
	}
	if (/french/i.test(lang)) {
		const dateLine = confirmedDate ? ` Elle a ete confirmee le ${confirmedDate}.` : "";
		return `${name}, j'ai trouve la reservation ${label}.${dateLine} Comme elle est confirmee depuis ${thresholdDays} jours ou plus, je ne peux pas l'annuler automatiquement par chat selon la politique. Si vous souhaitez quand meme une revue d'exception, dites-le-moi et je vous connecte a un specialiste.`;
	}
	const dateLine = confirmedDate ? ` It was confirmed on ${confirmedDate}.` : "";
	return `${name}, I found reservation ${label}.${dateLine} Because it has been confirmed for ${thresholdDays} days or more, I cannot cancel it automatically through chat under policy. If you still want the team to review an exception, tell me and I will connect you with a specialist.`;
}

function cancellationAlreadyClosedMessage(sc = {}, st = {}, result = {}, confirmation = "") {
	const name = respectfulGuestName(sc, st);
	const label = reservationPolicyConfirmationLabel(result, confirmation);
	const lang = languageOf(sc, st);
	if (/arabic/i.test(lang)) {
		return `${name}\u060c \u0623\u0631\u0649 \u0623\u0646 \u0627\u0644\u062d\u062c\u0632 ${label} \u0645\u063a\u0644\u0642 \u0623\u0648 \u0645\u0644\u063a\u0649 \u0628\u0627\u0644\u0641\u0639\u0644. \u0625\u0630\u0627 \u0643\u0627\u0646 \u0627\u0644\u0645\u0648\u0636\u0648\u0639 \u064a\u062d\u062a\u0627\u062c \u0645\u0631\u0627\u062c\u0639\u0629 \u062f\u0641\u0639 \u0623\u0648 \u0627\u0633\u062a\u062b\u0646\u0627\u0621\u060c \u0623\u0642\u062f\u0631 \u0623\u0648\u0635\u0644\u0643 \u0628\u0645\u062e\u062a\u0635.`;
	}
	if (/spanish/i.test(lang)) {
		return `${name}, veo que la reserva ${label} ya esta cerrada o cancelada. Si necesitas revision de pago o una excepcion, puedo conectarte con un especialista.`;
	}
	if (/french/i.test(lang)) {
		return `${name}, je vois que la reservation ${label} est deja fermee ou annulee. Si vous avez besoin d'une revue de paiement ou d'une exception, je peux vous connecter a un specialiste.`;
	}
	return `${name}, I can see reservation ${label} is already closed or cancelled. If you need a payment review or an exception, I can connect you with a specialist.`;
}

function cancellationPolicyClarifyMessage(sc = {}, st = {}) {
	const name = respectfulGuestName(sc, st);
	const lang = languageOf(sc, st);
	if (/arabic/i.test(lang)) {
		return `${name}\u060c \u0647\u0644 \u062a\u0631\u064a\u062f \u0623\u0646 \u0623\u0648\u0635\u0644\u0643 \u0628\u0645\u062e\u062a\u0635 \u0644\u0645\u0631\u0627\u062c\u0639\u0629 \u0627\u0644\u0637\u0644\u0628\u061f`;
	}
	if (/spanish/i.test(lang)) {
		return `${name}, quieres que te conecte con un especialista para revisar la solicitud?`;
	}
	if (/french/i.test(lang)) {
		return `${name}, souhaitez-vous que je vous connecte a un specialiste pour revoir cette demande ?`;
	}
	return `${name}, would you like me to connect you with a specialist to review this request?`;
}

function cancellationPolicyCloseMessage(sc = {}, st = {}) {
	const name = respectfulGuestName(sc, st);
	const lang = languageOf(sc, st);
	if (/arabic/i.test(lang)) {
		return `${name}\u060c \u062a\u0645\u0627\u0645. \u0623\u0646\u0627 \u0645\u0648\u062c\u0648\u062f \u0625\u0630\u0627 \u0627\u062d\u062a\u062c\u062a \u0623\u064a \u0645\u0633\u0627\u0639\u062f\u0629 \u0623\u062e\u0631\u0649 \u0628\u062e\u0635\u0648\u0635 \u0627\u0644\u062d\u062c\u0632.`;
	}
	if (/spanish/i.test(lang)) {
		return `${name}, perfecto. Estoy aqui si necesitas cualquier otra ayuda con la reserva.`;
	}
	if (/french/i.test(lang)) {
		return `${name}, tres bien. Je reste disponible si vous avez besoin d'aide pour la reservation.`;
	}
	return `${name}, understood. I am here if you need anything else with the reservation.`;
}

function cancellationInsistenceText(text = "") {
	const { lower, arabic, latinCompact } = normalizeControlText(text);
	return (
		confirmsText(text) ||
		looksLikeReservationCancellation(text) ||
		/\b(still|anyway|insist|exception|review|specialist|human|manager|agent|escalate|connect|please proceed|go ahead|refund|payment review)\b/i.test(
			lower
		) ||
		/(?:\u0644\u0627\u0632\u0645|\u0645\u0635\u0631|\u0628\u0631\u0636\u0647|\u0645\u0627\s*\u0632\u0644\u062a|\u062d\u0648\u0644|\u0648\u0635\u0644|\u0645\u062e\u062a\u0635|\u0627\u0633\u062a\u062b\u0646\u0627\u0621|\u0645\u0631\u0627\u062c\u0639\u0647|\u0627\u0633\u062a\u0631\u062f\u0627\u062f)/i.test(
			arabic
		) ||
		/(?:still|anyway|insist|exception|review|specialist|human|manager|agent|escalate|connect|goahead|refund|reembolso|remboursement|especialista|specialiste|excepcion|exception)/i.test(
			latinCompact
		)
	);
}

function declinesCancellationReviewText(text = "") {
	const { lower, arabic, latinCompact } = normalizeControlText(text);
	const explicitlyKeepReservation =
		/\b(?:do not|don't|dont|no need to|never mind|nevermind|keep|leave)\b.*\bcancel|\bcancel\b.*\b(?:do not|don't|dont|no need|never mind|nevermind)\b/i.test(
			lower
		) ||
		/(?:\u0644\u0627\s+\u062a\u0644\u063a\u064a|\u0644\u0627\s+\u0627\u0644\u063a\u064a|\u062e\u0644\u0627\u0635|\u0645\u0634\s+\u0645\u062d\u062a\u0627\u062c|\u062e\u0644\u064a\s+\u0627\u0644\u062d\u062c\u0632)/i.test(
			arabic
		) ||
		/(?:dontcancel|donotcancel|noneed|nevermind|keepreservation|leaveit)/i.test(
			latinCompact
		);
	if (explicitlyKeepReservation) return true;
	const wantsReview =
		/\b(still|anyway|insist|exception|review|specialist|human|manager|agent|escalate|connect|go ahead|refund|payment)\b/i.test(
			lower
		) ||
		/(?:\u0645\u062e\u062a\u0635|\u0627\u0633\u062a\u062b\u0646\u0627\u0621|\u0645\u0631\u0627\u062c\u0639\u0647|\u0627\u0633\u062a\u0631\u062f\u0627\u062f)/i.test(
			arabic
		);
	return declinesText(text) && !looksLikeReservationCancellation(text) && !wantsReview;
}

async function handleReservationCancellationPolicyAck(io, sc, st, userText) {
	if (st.waitFor !== "reservation_cancellation_policy_ack") return false;
	if (declinesCancellationReviewText(userText)) {
		st.pendingReservationCancellation = null;
		st.waitFor = null;
		await humanSend(io, sc, st, cancellationPolicyCloseMessage(sc, st));
		return true;
	}
	if (cancellationInsistenceText(userText) || wantsPaymentHelp(userText)) {
		st.pendingReservationCancellation = null;
		st.waitFor = null;
		await handoffToHuman(io, sc, st, "reservation_cancellation");
		return true;
	}
	if (looksLikeReservationDateUpdate(userText, {})) return false;
	await humanSend(io, sc, st, cancellationPolicyClarifyMessage(sc, st), {
		quickReplies: cancellationReviewQuickReplies(sc, st),
	});
	return true;
}

async function handleReservationCancellationRequest(
	io,
	sc,
	st,
	userText,
	lu = {},
	{ forceCancellation = false } = {}
) {
	if (
		!forceCancellation &&
		st.waitFor !== "reservation_cancellation_reference" &&
		!looksLikeReservationCancellation(userText)
	) {
		return false;
	}
	if (!st.hotel) {
		await redirectJannatReservationToHotelSupport(io, sc, st, userText, lu);
		return true;
	}
	const confirmation =
		lu?.confirmation || confirmationFromText(userText) || latestKnownConfirmation(sc, lu);
	if (!confirmation) {
		st.waitFor = "reservation_cancellation_reference";
		await humanSend(io, sc, st, cancellationReferenceMessage(sc, st));
		return true;
	}
	const result = await getReservationCancellationPolicyForCase({
		confirmation,
		hotel: st.hotel,
	});
	if (result.code === "missing_confirmation") {
		st.waitFor = "reservation_cancellation_reference";
		await humanSend(io, sc, st, cancellationReferenceMessage(sc, st));
		return true;
	}
	if (result.code === "not_found") {
		st.waitFor = "reservation_cancellation_reference";
		await humanSend(
			io,
			sc,
			st,
			cancellationNotFoundMessage(sc, st, confirmation)
		);
		return true;
	}
	if (result.code === "confirmed_too_old") {
		st.pendingReservationCancellation = {
			confirmation: reservationPolicyConfirmationLabel(result, confirmation),
			policyCode: result.code,
			confirmedAt: result.confirmedAt,
			ageDays: result.ageDays,
		};
		st.waitFor = "reservation_cancellation_policy_ack";
		await humanSend(io, sc, st, cancellationTooOldMessage(sc, st, result, confirmation), {
			quickReplies: cancellationReviewQuickReplies(sc, st),
		});
		return true;
	}
	if (["already_cancelled", "locked_status"].includes(result.code)) {
		st.pendingReservationCancellation = {
			confirmation: reservationPolicyConfirmationLabel(result, confirmation),
			policyCode: result.code,
		};
		st.waitFor = "reservation_cancellation_policy_ack";
		await humanSend(
			io,
			sc,
			st,
			cancellationAlreadyClosedMessage(sc, st, result, confirmation),
			{ quickReplies: cancellationReviewQuickReplies(sc, st) }
		);
		return true;
	}
	st.pendingReservationCancellation = null;
	st.waitFor = null;
	await handoffToHuman(io, sc, st, "reservation_cancellation");
	return true;
}

async function finalizeReservationForGuest(io, sc, st, caseId) {
	if (!st.hotel) {
		if (Array.isArray(st.platformHotelOptions) && st.platformHotelOptions.length) {
			st.waitFor = "platform_hotel_choice";
			await humanSend(
				io,
				sc,
				st,
				"Jannat Booking support can help you choose the best option, and the hotel reception and reservations desk will complete the official reservation and links. Please choose a hotel option so I can connect you.",
				{ quickReplies: platformHotelOptionQuickReplies(sc, st) }
			);
			return true;
		}
		await answerJannatBookingHotelOptions(io, sc, st, lastUserText(sc));
		return true;
	}
	if (st.slots?.adultsProvided) ensureDefaultChildren(st);
	if (!hasMandatoryReservationDetails(st)) {
		st.waitFor = "reservation_details";
		await askForReservationDetail(io, sc, st, st.waitFor);
		return true;
	}
	if (!st.slots.email && !st.slots.emailSkipped) {
		st.waitFor = "email_or_skip";
		await askForReservationDetail(io, sc, st, st.waitFor);
		return true;
	}
	await sendProgressMessage(io, sc, st, "finalizing");
	const quoteForCreate =
		st.quote?.data ||
		safePriceRoomForStay(
			st.hotel,
			{ roomType: st.slots.roomTypeKey },
			st.slots.checkinISO,
			st.slots.checkoutISO
		);
	if (!quoteForCreate?.available) {
		await handoffToHuman(io, sc, st, "reservation_finalize_failed");
		return true;
	}
	const reservation = await createReservationForCase({
		caseId,
		hotel: st.hotel,
		slots: {
			...st.slots,
			name: st.slots.fullName || st.slots.name,
		},
		quoteData: quoteForCreate,
		room: quoteForCreate.room,
	});
	const links = reservationLinks(reservation);
	const finalText = reservationCreatedMessage(
		sc,
		st,
		reservation,
		quoteForCreate,
		links
	);
	await humanSend(io, sc, st, finalText);
	st.waitFor = "post_booking_followup";
	st.reviewSent = false;
	st.quoteSummarizedAt = 0;
	return true;
}

function postBookingCloseText(sc = {}, st = {}) {
	const lang = languageOf(sc, st);
	if (/arabic/i.test(lang)) {
		return "\u0639\u0644\u0649 \u0627\u0644\u0631\u062d\u0628 \u0648\u0627\u0644\u0633\u0639\u0629. \u0623\u062a\u0645\u0646\u0649 \u0644\u0643 \u0625\u0642\u0627\u0645\u0629 \u0645\u0648\u0641\u0642\u0629.";
	}
	if (/spanish/i.test(lang)) {
		return "Con mucho gusto. Te deseo una excelente estancia.";
	}
	if (/french/i.test(lang)) {
		return "Avec plaisir. Je vous souhaite un excellent sejour.";
	}
	return "You are very welcome. I hope you have a wonderful stay.";
}

async function postBookingCloseReply(io, sc, st, userText = "") {
	const instruction = botExperienceComplaintText(userText) ||
		/\b(answer\s+(?:the\s+)?questions?|can't\s+you\s+answer|can'?t\s+you\s+answer)\b/i.test(
			String(userText || "")
		)
		? "The guest is closing the chat and gave feedback that the assistant should answer direct questions. Apologize briefly, acknowledge the feedback sincerely, confirm the reservation is already created, and close warmly. Do not ask another question and do not push payment."
		: "The guest said no/thanks after the final reservation-created message. Close warmly in one short human sentence. Do not ask another question and do not push payment.";
	const reply = await write(io, sc, st, instruction, {
		latestUserMessage: userText,
		slots: st.slots,
	});
	return reply || postBookingCloseText(sc, st);
}

function postBookingClarifyText(sc = {}, st = {}) {
	const lang = languageOf(sc, st);
	if (/arabic/i.test(lang)) {
		return "\u0623\u0643\u064a\u062f\u060c \u0623\u0646\u0627 \u0645\u0639\u0643. \u0645\u0627 \u0627\u0644\u0634\u064a\u0621 \u0627\u0644\u0622\u062e\u0631 \u0627\u0644\u0630\u064a \u062a\u062d\u0628 \u0623\u0633\u0627\u0639\u062f\u0643 \u0641\u064a\u0647\u061f";
	}
	if (/spanish/i.test(lang)) {
		return "Claro, estoy contigo. Que mas puedo hacer por ti?";
	}
	if (/french/i.test(lang)) {
		return "Bien sur, je suis avec vous. Que puis-je faire d'autre pour vous?";
	}
	return "Of course, I am here. What else can I help you with?";
}

function isPostBookingClosure(text = "") {
	const normalized = String(text || "").trim().toLowerCase();
	if (!normalized) return false;
	if (
		/^(no|nope|no thanks|no thank you|nothing|that's all|that is all|all good|thanks|thank you)\b/i.test(
			normalized
		) &&
		!(
			/\b(pay|payment|link|change|update|cancel|refund|another booking|new booking|book another|reserve another)\b/i.test(
				normalized
			) && !botExperienceComplaintText(normalized)
		)
	) {
		return true;
	}
	return /^(no|no thanks|nothing|that's all|that is all|all good|thanks|thank you|\u0634\u0643\u0631\u0627|\u0634\u0643\u0631\u064b\u0627|\u0644\u0627|\u0644\u0627\s+\u0634\u0643\u0631\u0627|\u062e\u0644\u0627\u0635|\u062a\u0645\u0627\u0645\s+\u0634\u0643\u0631\u0627|\u0643\u062f\u0647\s+\u062a\u0645\u0627\u0645|\u0645\u0627\u0641\u064a\u0634|\u0645\u0634\s+\u0645\u062d\u062a\u0627\u062c|\u0628\u0633\s+\u0643\u062f\u0647|merci|non merci|gracias|no gracias)\.?$/i.test(
		normalized
	);
}

function isPostBookingConcreteRequest(text = "") {
	const normalized = String(text || "").trim();
	if (!normalized) return false;
	if (botExperienceComplaintText(normalized)) return false;
	return (
		wantsPaymentHelp(normalized) ||
		wantsReservationHelp(normalized) ||
		selectedHotelFactQuestionText(normalized) ||
		selectedHotelRoomQuestionText(normalized) ||
		Boolean(findAmenityMatch(normalized)) ||
		/\b(can you|could you|please tell|tell me|i need|i want|where|when|how much|how do|what is|what time|is there|do you)\b/i.test(
			normalized
		)
	);
}

function isVaguePositive(text = "") {
	const normalized = String(text || "").trim().toLowerCase();
	return /^(yes|yes please|yeah|yep|sure|ok|okay|\u0627\u064a\u0648\u0647|\u0623\u064a\u0648\u0647|\u0646\u0639\u0645|\u062a\u0645\u0627\u0645|\u0627\u0647|\u0622\u0647|oui|si|s\u00ed)\.?$/i.test(
		normalized
	);
}

function hajjInquiryFallbackText(sc = {}, st = {}) {
	const name = respectfulGuestName(sc, st);
	const lang = languageOf(sc, st);
	if (/arabic/i.test(lang)) {
		return `${name}\u060c \u0623\u0639\u062a\u0630\u0631 \u0644\u0644\u062e\u0644\u0637. \u0628\u062e\u0635\u0648\u0635 \u0627\u0644\u062d\u062c\u060c \u0644\u0627 \u062a\u062a\u0648\u0641\u0631 \u0644\u062f\u064a \u062a\u0641\u0627\u0635\u064a\u0644 \u0645\u0624\u0643\u062f\u0629 \u062d\u0627\u0644\u064a\u0627 \u0639\u0646 \u0627\u0644\u062a\u0646\u0638\u064a\u0645 \u0623\u0648 \u0627\u0644\u0641\u0626\u0627\u062a. \u0645\u0646 \u0641\u0636\u0644\u0643 \u0631\u0627\u0633\u0644 ${AI_SUPPORT_EMAIL} \u0648\u0633\u064a\u0648\u062c\u0647\u0643 \u0627\u0644\u0641\u0631\u064a\u0642 \u0628\u0627\u0644\u062a\u0641\u0627\u0635\u064a\u0644 \u0627\u0644\u0635\u062d\u064a\u062d\u0629.`;
	}
	if (/spanish/i.test(lang)) {
		return `${name}, perdona la confusion. Sobre Hajj, no tengo ahora datos verificados sobre organizacion o categorias. Escribenos a ${AI_SUPPORT_EMAIL} y el equipo te orientara con los detalles correctos.`;
	}
	if (/french/i.test(lang)) {
		return `${name}, desole pour la confusion. Pour le Hajj, je n'ai pas actuellement d'informations verifiees sur l'organisation ou les categories. Ecrivez a ${AI_SUPPORT_EMAIL} et l'equipe vous guidera avec les bons details.`;
	}
	return `${name}, sorry for the confusion. For Hajj, I do not currently have verified details about organization or categories. Please email ${AI_SUPPORT_EMAIL}, and the support team will guide you with the right details.`;
}

async function answerVagueHajjInquiry(io, sc, st, userText = "") {
	const reply = await write(
		io,
		sc,
		st,
		"The guest asked a broad Hajj/Haj-related question, not a payment/reference question. First check the provided hotel facts, platform context, previous guest context, and employee learning examples. If those contexts contain a verified answer to this exact Hajj question, answer it directly and briefly using only that verified context. If they do not contain a verified answer, apologize briefly, say you do not currently have confirmed details about Hajj organization/packages/categories, and direct the guest to support@jannatbooking.com. Do not invent facts. Do not repeat reservation details, quotes, confirmation numbers, or payment links. Do not ask for a payment reference or reservation number.",
		{
			latestUserMessage: userText,
			supportEmail: AI_SUPPORT_EMAIL,
			hotelName: localizedHotelName(sc, st),
			reservationAlreadyCreated:
				sc.aiReservation?.status === "created" ||
				Boolean(sc.aiReservation?.confirmationNumber),
		}
	);
	await humanSend(io, sc, st, reply || hajjInquiryFallbackText(sc, st));
	st.waitFor =
		sc.aiReservation?.status === "created" || sc.aiReservation?.confirmationNumber
			? "post_booking_followup"
			: "clarify";
	return true;
}

function supportEmailFallbackText(sc = {}, st = {}) {
	const name = respectfulGuestName(sc, st);
	const hotelName = st.hotel ? localizedHotelName(sc, st) : "";
	const lang = languageOf(sc, st);
	if (/arabic/i.test(lang)) {
		return hotelName
			? `${name}\u060c \u0644\u0627 \u0623\u0645\u0644\u0643 \u0625\u062c\u0627\u0628\u0629 \u0645\u0624\u0643\u062f\u0629 \u0644\u0647\u0630\u0627 \u0627\u0644\u0627\u0633\u062a\u0641\u0633\u0627\u0631 \u0645\u0646 \u062f\u0631\u062f\u0634\u0629 ${hotelName}. \u0645\u0646 \u0641\u0636\u0644\u0643 \u0631\u0627\u0633\u0644 ${AI_SUPPORT_EMAIL} \u0648\u0633\u064a\u0648\u062c\u0647\u0643 \u0627\u0644\u0641\u0631\u064a\u0642 \u0628\u0627\u0644\u062a\u0641\u0627\u0635\u064a\u0644 \u0627\u0644\u0635\u062d\u064a\u062d\u0629.`
			: `${name}\u060c \u0644\u0627 \u0623\u0645\u0644\u0643 \u0625\u062c\u0627\u0628\u0629 \u0645\u0624\u0643\u062f\u0629 \u0644\u0647\u0630\u0627 \u0627\u0644\u0627\u0633\u062a\u0641\u0633\u0627\u0631 \u062d\u0627\u0644\u064a\u0627. \u0645\u0646 \u0641\u0636\u0644\u0643 \u0631\u0627\u0633\u0644 ${AI_SUPPORT_EMAIL} \u0648\u0633\u064a\u0648\u062c\u0647\u0643 \u0627\u0644\u0641\u0631\u064a\u0642 \u0628\u0627\u0644\u062a\u0641\u0627\u0635\u064a\u0644 \u0627\u0644\u0635\u062d\u064a\u062d\u0629.`;
	}
	if (/spanish/i.test(lang)) {
		return `${name}, no tengo una respuesta verificada para esa consulta en este chat. Por favor escribe a ${AI_SUPPORT_EMAIL} y el equipo te orientara con los detalles correctos.`;
	}
	if (/french/i.test(lang)) {
		return `${name}, je n'ai pas de reponse verifiee pour cette question dans ce chat. Veuillez ecrire a ${AI_SUPPORT_EMAIL}, et l'equipe vous guidera avec les bons details.`;
	}
	return `${name}, I do not have a verified answer for that question in this chat. Please email ${AI_SUPPORT_EMAIL}, and the support team will guide you with the right details.`;
}

function technicalRecoveryText(sc = {}, st = {}) {
	const name = respectfulGuestName(sc, st);
	const lang = languageOf(sc, st);
	if (/arabic/i.test(lang)) {
		return `${name}\u060c \u0622\u0633\u0641 \u062d\u0635\u0644 \u062a\u0623\u062e\u064a\u0631 \u062a\u0642\u0646\u064a \u0628\u0633\u064a\u0637 \u0648\u0623\u0646\u0627 \u0628\u0631\u0627\u062c\u0639 \u0637\u0644\u0628\u0643. \u0645\u0646 \u0641\u0636\u0644\u0643 \u0623\u0631\u0633\u0644 \u0622\u062e\u0631 \u0646\u0642\u0637\u0629 \u0645\u0631\u0629 \u0623\u062e\u0631\u0649 \u0648\u0633\u0623\u0643\u0645\u0644 \u0645\u0639\u0643 \u0641\u0648\u0631\u0627.`;
	}
	if (/spanish/i.test(lang)) {
		return `${name}, perdona, hubo una pequena demora tecnica mientras revisaba tu solicitud. Enviame el ultimo punto otra vez y continuo enseguida.`;
	}
	if (/french/i.test(lang)) {
		return `${name}, desole, il y a eu un petit retard technique pendant la verification. Renvoyez-moi le dernier point et je continue tout de suite.`;
	}
	return `${name}, sorry, I had a small technical delay while checking your request. Please send the last point once more and I will continue right away.`;
}

function broadGeneralSupportQuestionText(text = "", st = {}, lu = {}) {
	const normalized = String(text || "").trim();
	if (!normalized) return false;
	if (looksLikeGreetingOnly(normalized) || lu?.intent === "smalltalk") return false;
	const { lower, arabic, latinCompact } = normalizeControlText(normalized);
	const broadServiceSignal =
		/\b(?:insurance|medical|visa|flight|flights|ticket|tickets|airport|transport|transfer|shuttle|tour|permit|hajj|haj|umrah|organize|organisation|organization|arrange)\b/i.test(
			lower
		) ||
		/(?:تأمين|تامين|فيزا|تأشيرة|تاشيرة|طيران|تذاكر|مطار|نقل|مواصلات|باص|جولة|تصريح|الحج|حج|العمرة|عمرة|تنظيم|ترتيب)/.test(
			arabic
		) ||
		/(?:visapackage|medicalinsurance|travelinsurance|airporttransfer|hajjpackage|umrahpackage)/i.test(
			latinCompact
		);
	const brandBookingOnly =
		/\bjannat\s*booking\b/i.test(lower) &&
		!/\b(?:my|existing|old|current|previous)\s+(?:booking|reservation)\b/i.test(
			lower
		) &&
		!/\b(?:booking|reservation)\s+(?:number|reference|id|status|confirmation|details)\b/i.test(
			lower
		) &&
		!/\b(?:confirmation|cancel|cancellation|refund|update|change|modify|amend)\b/i.test(
			lower
		);
	const reservationHelp = wantsReservationHelp(normalized) && !brandBookingOnly;
	const newReservationIntent =
		wantsNewReservationIntent(normalized, lu) && !broadServiceSignal;
	if (
		newReservationIntent ||
		wantsPriceButMissingDates(normalized, st) ||
		wantsPaymentHelp(normalized) ||
		reservationHelp ||
		wantsDiscountQuestion(normalized) ||
		humanHandoffReason(normalized) ||
		selectedHotelFactQuestionText(normalized) ||
		selectedHotelRoomQuestionText(normalized) ||
		Boolean(findAmenityMatch(normalized))
	) {
		return false;
	}
	const asksQuestion =
		/[?؟]/.test(normalized) ||
		/^(can|could|do|does|did|is|are|will|would|what|how|where|when|who|which|tell me|i want to know)\b/i.test(
			lower
		) ||
		/(?:هل|ممكن|ينفع|تقدر|اقدر|عندكم|بتوفروا|توفروا|فيه|هل\s+يوجد)/.test(
			arabic
		);
	if (!asksQuestion) return false;
	return (
		broadServiceSignal ||
		/\b(?:jannat\s*booking|jannat|platform|company|agency|program|programs|package|packages|visa|insurance|medical|flight|flights|ticket|tickets|airport|transport|transfer|shuttle|tour|permit|hajj|haj|umrah|organize|organisation|organization|arrange)\b/i.test(
			lower
		) ||
		/(?:تأمين|تامين|فيزا|تأشيرة|تاشيرة|طيران|تذاكر|مطار|نقل|مواصلات|باص|جولة|برنامج|برامج|باقة|باقات|تصريح|الحج|حج|العمرة|عمرة|تنظيم|ترتيب)/.test(
			arabic
		) ||
		/(?:jannatbooking|visapackage|medicalinsurance|travelinsurance|airporttransfer|hajjpackage|umrahpackage)/i.test(
			latinCompact
		)
	);
}

function stripGeneralBookingPivot(text = "", fallback = "") {
	const cleaned = String(text || "")
		.replace(
			/\s*(?:what|which|could|can|please|kindly|send|share|provide|tell)\b[^.!?؟\n]*(?:check[\s-]*in|check[\s-]*out|dates?|room\s+type|phone|email\s+address|your\s+email|confirmation\s+number|booking\s+details)[^.!?؟\n]*[.!?؟]?/gi,
			""
		)
		.replace(
			/\s*(?:ما|متى|هل|ممكن|من فضلك|ارسل|أرسل|ابعث|اكتب)[^.!?؟\n]*(?:الوصول|المغادرة|التواريخ|نوع الغرفة|رقم الهاتف|البريد|رقم التأكيد|بيانات الحجز)[^.!?؟\n]*[.!?؟]?/g,
			""
		)
		.replace(/\s{2,}/g, " ")
		.trim();
	return cleaned || String(fallback || "").trim();
}

async function answerGeneralContextQuestion(io, sc, st, userText = "", reason = "") {
	const reply = await write(
		io,
		sc,
		st,
		"The guest asked a broad/general support question. Answer only if the provided selected hotel facts, platform/database context, previous guest context, or employee learning examples contain a verified safe answer to this exact question. If verified context is not present, apologize briefly and direct the guest to support@jannatbooking.com. Do not invent facts. Do not ask for check-in/check-out dates, phone, email, confirmation number, room type, or booking details unless the guest explicitly asked to reserve in the latest message. Do not add a booking pivot after an unsupported general answer.",
		{
			latestUserMessage: userText,
			supportEmail: AI_SUPPORT_EMAIL,
			hotelName: localizedHotelName(sc, st),
			reason,
		}
	);
	const fallback = supportEmailFallbackText(sc, st);
	await humanSend(io, sc, st, stripGeneralBookingPivot(reply || fallback, fallback));
	st.waitFor =
		sc.aiReservation?.status === "created" || sc.aiReservation?.confirmationNumber
			? "post_booking_followup"
			: "clarify";
	logStep(String(sc._id), "general_answer.reply", {
		reason,
		latestUserMessage: String(userText || "").slice(0, 160),
	});
	return true;
}

async function answerHotelContactDetailsInquiry(io, sc, st, userText = "") {
	const requestCount = hotelContactRequestCount(sc, userText);
	const phoneToShare = "";
	const reply = hotelContactReplyText(sc, st, {
		publicPhone: phoneToShare,
		requestCount,
		userText,
	});
	await humanSend(io, sc, st, reply);
	st.waitFor =
		sc.aiReservation?.status === "created" || sc.aiReservation?.confirmationNumber
			? "post_booking_followup"
			: "clarify";
	logStep(String(sc._id), "hotel_contact.reply", {
		sharedPhone: Boolean(phoneToShare),
		sharedPublicPhone: Boolean(phoneToShare),
		requestCount,
		latestUserMessage: String(userText || "").slice(0, 160),
	});
	return true;
}

async function askExplicitPastDateClarification(io, sc, st, userText = "", dates = {}) {
	const suggestedDates = futureSameMonthDayRange(dates);
	const reply = await write(
		io,
		sc,
		st,
		"The guest provided an explicit Gregorian date range that is before today. Do not change the year silently and do not quote availability yet. Answer naturally that the typed dates appear to be in the past, then ask one short clarification whether they meant the same day/month in the next future year. Keep it warm and direct.",
		{
			latestUserMessage: userText,
			todayISO: todayISODate(),
			providedDates: {
				checkinISO: dates?.checkinISO || null,
				checkoutISO: dates?.checkoutISO || null,
				raw: dates?.raw || null,
			},
			suggestedDates,
		}
	);
	await humanSend(io, sc, st, reply);
	st.waitFor = "dates";
	stampAsk(st, "dates");
	logStep(String(sc._id), "dates.past_explicit_clarify", {
		checkinISO: dates?.checkinISO || null,
		checkoutISO: dates?.checkoutISO || null,
		suggestedDates,
	});
	return true;
}

async function answerSupportEmailInquiry(io, sc, st, userText = "", reason = "") {
	await humanSend(io, sc, st, supportEmailFallbackText(sc, st));
	st.waitFor =
		sc.aiReservation?.status === "created" || sc.aiReservation?.confirmationNumber
			? "post_booking_followup"
			: "clarify";
	logStep(String(sc._id), "support_email.reply", {
		reason,
		latestUserMessage: String(userText || "").slice(0, 160),
	});
	return true;
}

async function handlePostBookingFollowup(io, sc, st, userText) {
	if (st.waitFor !== "post_booking_followup") return false;
	if (
		hotelContactDetailsQuestionText(userText) ||
		hotelContactFollowupQuestionText(sc, userText)
	) {
		return answerHotelContactDetailsInquiry(io, sc, st, userText);
	}
	if (st.hotel && selectedHotelFactQuestionText(userText)) {
		return answerSelectedHotelFactQuestion(io, sc, st, userText);
	}
	if (isPostBookingClosure(userText)) {
		const closeReply = await postBookingCloseReply(io, sc, st, userText);
		await humanSend(io, sc, st, closeReply);
		st.waitFor = null;
		return true;
	}
	if (vagueHajjInquiryText(userText)) {
		return answerVagueHajjInquiry(io, sc, st, userText);
	}
	if (botExperienceComplaintText(userText) && !isPostBookingConcreteRequest(userText)) {
		const reply = await write(
			io,
			sc,
			st,
			"The guest gave feedback after the reservation was created. Apologize briefly, acknowledge that direct questions should be answered directly, and close warmly unless they ask for a specific new thing. Do not repeat booking details and do not push payment.",
			{ latestUserMessage: userText, slots: st.slots }
		);
		await humanSend(io, sc, st, reply || postBookingCloseText(sc, st));
		st.waitFor = null;
		return true;
	}
	if (isVaguePositive(userText)) {
		await humanSend(io, sc, st, postBookingClarifyText(sc, st));
		st.waitFor = "post_booking_followup";
		return true;
	}
	if (!isPostBookingConcreteRequest(userText)) {
		const reply = await write(
			io,
			sc,
			st,
			"The guest sent a post-booking note without a clear new request. Reply naturally and briefly, acknowledging the message. Do not repeat reservation details and do not push payment.",
			{ latestUserMessage: userText }
		);
		await humanSend(io, sc, st, reply || postBookingCloseText(sc, st));
		st.waitFor = null;
		return true;
	}
	st.waitFor = null;
	return false;
}

function nextReservationDetailStep(st = {}) {
	if (!hasMandatoryReservationDetails(st)) return "reservation_details";
	ensureDefaultChildren(st);
	if (!st.slots?.email && !st.slots?.emailSkipped) return "email_or_skip";
	return "finalize";
}

async function askForReservationDetail(io, sc, st, step) {
	let prompt = "";
	let quickReplies = [];
	if (step === "reservation_details" || step === "fullname" || step === "nationality" || step === "phone") {
		prompt = mandatoryDetailsPrompt(sc, st, {
			retry: step !== "reservation_details",
		});
	} else if (step === "email_or_skip") {
		prompt = optionalEmailPrompt(sc, st);
		quickReplies = emailQuickReplies(sc, st);
	}
	if (!prompt) return;
	const sent = await humanSend(io, sc, st, prompt, { quickReplies });
	if (!sent) return;
	stampAsk(st, step);
}

async function handleReservationDetailStep(io, sc, st, userText, caseId) {
	if (!isReservationDetailStep(st)) return false;
	await captureReservationDetailsFromText(sc, st, userText, caseId);
	for (let guard = 0; guard < 4; guard += 1) {
		if (st.waitFor === "reviewConfirm") {
			if (correctionText(userText)) {
				st.waitFor = "clarify";
				st.reviewSent = false;
				const ask = /arabic/i.test(languageOf(sc, st))
					? "\u0628\u0643\u0644 \u0633\u0631\u0648\u0631\u060c \u0645\u0627 \u0627\u0644\u0634\u064a\u0621 \u0627\u0644\u0630\u064a \u062a\u0631\u064a\u062f \u062a\u0639\u062f\u064a\u0644\u0647\u061f"
					: "Of course. What would you like me to correct?";
				await humanSend(io, sc, st, ask);
				return true;
			}
			if (!confirmsText(userText)) {
				const ask = /arabic/i.test(languageOf(sc, st))
					? "\u0647\u0644 \u062a\u0624\u0643\u062f \u0627\u0644\u062a\u0641\u0627\u0635\u064a\u0644\u060c \u0623\u0645 \u0647\u0646\u0627\u0643 \u0634\u064a\u0621 \u062a\u0631\u064a\u062f \u062a\u0639\u062f\u064a\u0644\u0647\u061f"
					: "Would you like to confirm these details, or is there something you want me to change?";
				await humanSend(io, sc, st, ask, {
					quickReplies: confirmationQuickReplies(sc, st),
				});
				return true;
			}
			st.waitFor = nextReservationDetailStep(st);
			if (st.waitFor !== "finalize") {
				await askForReservationDetail(io, sc, st, st.waitFor);
				return true;
			}
		}

		if (["reservation_details", "fullname", "nationality", "phone"].includes(st.waitFor)) {
			if (hasMandatoryReservationDetails(st)) {
				st.waitFor = nextReservationDetailStep(st);
				if (st.waitFor !== "finalize") {
					await askForReservationDetail(io, sc, st, st.waitFor);
					return true;
				}
				continue;
			}
			await humanSend(io, sc, st, mandatoryDetailsPrompt(sc, st, { retry: true }));
			stampAsk(st, "reservation_details");
			return true;
		}

		if (st.waitFor === "email_or_skip") {
			if (st.slots.email || st.slots.emailSkipped) {
				st.waitFor = "finalize";
				continue;
			}
			const txt = String(userText).trim();
			const email = latestEmailFromText(txt);
			if (email) {
				st.slots.email = email;
				logStep(caseId, "email.captured", { email: st.slots.email });
				st.waitFor = "finalize";
				continue;
			}
			await humanSend(io, sc, st, optionalEmailPrompt(sc, st), {
				quickReplies: emailQuickReplies(sc, st),
			});
			stampAsk(st, "email_or_skip");
			return true;
		}

		if (st.waitFor === "finalize") {
			try {
				return await finalizeReservationForGuest(io, sc, st, caseId);
			} catch (error) {
				logStep(caseId, "reservation.create_failed", {
					message: error?.message || error,
				});
				await handoffToHuman(io, sc, st, "reservation_finalize_failed");
				return true;
			}
		}
	}
	return false;
}

async function answerDiscountQuestion(io, sc, st, userText = "") {
	const discount = discountDisplayContext(st);
	const fallbackText = discount.displayedPerNight
		? `Sir, our published prices already include a ${discount.discountPercent}% across-the-board discount and are among the best market rates. The displayed nightly rate of ${discount.displayedPerNight} ${cleanCurrency(
				discount.currency
		  )} is already after the discount; before discount it would be about ${
				discount.beforeDiscount
		  } ${cleanCurrency(discount.currency)}. There is no extra manual discount.`
		: `Sir, our published prices already include a ${discount.discountPercent}% across-the-board discount and are among the best market rates. The displayed price is already the discounted price, so there is no extra manual discount. For example, 85 SAR means it was 100 SAR before the discount.`;
	const reply = await write(
		io,
		sc,
		st,
		"The guest asked about discounts or offers. Reply professionally without escalation. Say the published/displayed prices already include a 15% across-the-board discount and are among the best market rates. Do not present a new discounted total. Do not offer an extra manual discount. If useful, explain briefly that a displayed nightly price of 85 SAR means it is already after 15% from 100 SAR. Keep the normal booking flow unchanged and answer only because the guest asked.",
		{
			latestUserMessage: userText,
			discountPolicy: discount,
			fallbackText,
		}
	);
	await humanSend(io, sc, st, reply);
}

/* ------------------- SMALLTALK ------------------- */
async function handleSmalltalk(io, sc, st, lu, userText) {
	const caseId = String(sc._id);
	const pivot = nextPivot(st);
	const subtype = lu.smalltalkType || "chitchat";
	const thread = st.smalltalkThread;
	thread.lastAt = now();
	logStep(caseId, "smalltalk.thread", {
		subtype,
		topic: thread.topic,
		waitingForGuest: thread.waitingForGuest,
	});

	if (subtype === "how_are_you") {
		if (!thread.waitingForGuest || thread.topic !== "howru") {
			const msg = await write(
				io,
				sc,
				st,
				"Say you’re doing well (natural phrasing), then ask “How about you?”. Keep it short; no booking question yet."
			);
			await humanSend(io, sc, st, msg);
			thread.topic = "howru";
			thread.waitingForGuest = true;
			logStep(caseId, "smalltalk.thread.update", {
				topic: thread.topic,
				waitingForGuest: thread.waitingForGuest,
			});
			return true;
		} else {
			const msg = await write(
				io,
				sc,
				st,
				"Reply that you're doing well, friendly and brief; add a soft pivot line without repeating a booking question.",
				{ pivot }
			);
			await humanSend(io, sc, st, msg);
			return true;
		}
	}

	if (
		thread.topic === "howru" &&
		thread.waitingForGuest &&
		(looksLikeWellnessReply(userText) || looksLikeClosureAck(userText))
	) {
		const openHelpPivot =
			pivot === "dates" &&
			!st.slots.roomTypeKey &&
			!hasOperationalBookingSignal(userText);
		const softPivot = askedRecently(st, pivot);
		const instr = openHelpPivot
			? "Acknowledge the guest's personal/casual reply warmly and naturally. If they mention Umrah, add a sincere short well-wish. Then ask an open question like how you can help with their stay today. Do not ask for check-in/check-out dates yet."
			: softPivot
			? "Acknowledge warmly. Add a soft pivot line (no direct repeated question)."
			: "Acknowledge warmly, then ask exactly ONE booking question for the next step (dates if missing, otherwise room type, otherwise proceed).";
		const msg = await write(io, sc, st, instr, { pivot });
		await humanSend(io, sc, st, msg);
		thread.waitingForGuest = false;
		thread.topic = null;
		logStep(caseId, "smalltalk.thread.update", {
			topic: thread.topic,
			waitingForGuest: thread.waitingForGuest,
		});
		return true;
	}

	const softPivot = askedRecently(st, pivot);
	if (softPivot) {
		const msg = await write(
			io,
			sc,
			st,
			"Reply politely to their casual message and add a soft pivot line without repeating a question.",
			{ pivot }
		);
		await humanSend(io, sc, st, msg);
	} else {
		let msg;
		if (pivot === "intentConfirm") {
			msg = await write(
				io,
				sc,
				st,
				"Ask a single yes/no: 'Just to confirm, are you looking to make a new reservation today?'",
				{}
			);
			await humanSend(io, sc, st, msg);
			stampAsk(st, "intentConfirm");
		} else if (pivot === "dates") {
			msg = await write(
				io,
				sc,
				st,
				hasOperationalBookingSignal(userText)
					? "Reply briefly to their casual line, then ask for check-in and check-out in ONE question."
					: "Reply warmly to their casual line, then ask an open question like how you can help with their stay today. Do not ask for check-in/check-out dates yet."
			);
			await humanSend(io, sc, st, msg);
			if (hasOperationalBookingSignal(userText)) stampAsk(st, "dates");
		} else if (pivot === "room") {
			const examples = (st.hotel?.roomCountDetails || [])
				.filter((r) => r.activeRoom)
				.map((r) => r.displayName || r.roomType)
				.slice(0, 4);
			msg = await write(
				io,
				sc,
				st,
				"Reply briefly, then ask which room type they prefer (offer 2–4 examples).",
				{ examples }
			);
			await humanSend(io, sc, st, msg);
			stampAsk(st, "room");
		} else if (pivot === "proceed") {
			msg = await write(
				io,
				sc,
				st,
				"Reply briefly, then ask a single yes/no if they want to proceed with the quoted room."
			);
			await humanSend(io, sc, st, msg);
			stampAsk(st, "proceed");
		} else {
			msg = await write(
				io,
				sc,
				st,
				"Reply briefly and ask them to type 'confirm' to finalize or tell you what to change."
			);
			await humanSend(io, sc, st, msg);
		}
	}
	return true;
}

/* ------------------- TURN PLANNER ------------------- */
async function planTurn(io, sc) {
	const caseId = String(sc._id);
	const policy = await ensureAIAllowed(sc.hotelId, sc);
	if (!policy.allowed) {
		logStep(caseId, "policy.skip", { reason: policy.reason });
		return;
	}
	const policyHotel = policy.hotel || (await getHotelById(sc.hotelId));
	const hotel = activeHotelContextForCase(sc, policyHotel);
	const st = ensureState(sc, hotel);
	if (st.turnInFlight) {
		logStep(caseId, "turn.enqueue", {
			reason: "in_flight",
			queued: st.queue.length + 1,
		});
		st.queue.push(now());
		st.interrupt = true;
		return;
	}
	st.turnInFlight = true;
	st.interrupt = false;
	let planningTyping = false;
	let recoveryUserText = "";

	try {
		logStep(caseId, "context.loaded", {
			hotelId: sc.hotelId,
			hotelName: st.hotel?.hotelName || null,
			language: st.language,
			waitFor: st.waitFor,
			slots: st.slots,
		});

		const latestGuestMessage = lastGuestMessage(sc);
		const userText = latestGuestMessage?.message || "";
		recoveryUserText = userText;
		st.activeTurnUserText = userText || "";
		st.activeTurnGuestAt = latestGuestMessage?.date
			? new Date(latestGuestMessage.date).getTime()
			: now();
		if (!Number.isFinite(st.activeTurnGuestAt)) st.activeTurnGuestAt = now();
		st.activeTurnReplyTargetMs = randomBetween(
			AI_REPLY_TARGET_MIN_MS,
			AI_REPLY_TARGET_MAX_MS
		);
		if (userText || !hasAiAssistantReply(sc)) {
			emitTyping(io, caseId, st, true);
			planningTyping = true;
		}
		updateActiveLanguageFromText(sc, st, userText);
		if (!userText) {
			if (!hasAiAssistantReply(sc) && !st.greeted && !st.greetScheduled) {
				st.greetScheduled = true;
				st.greeted = true;
				const initialInquiry = initialInquiryText(sc);
				if (!st.hotel && hotelComplaintText(initialInquiry)) {
					await handoffToHuman(io, sc, st, "jannat_hotel_complaint");
					return;
				}
				if (
					!st.hotel &&
					jannatReservationHotelRedirectIntent(initialInquiry, {}, sc)
				) {
					await redirectJannatReservationToHotelSupport(
						io,
						sc,
						st,
						initialInquiry,
						{}
					);
					return;
				}
				const initialUpdateLu = deterministicReservationUpdateLu(
					initialInquiry,
					sc,
					{}
				);
				if (
					st.hotel &&
					initialUpdateLu.confirmation &&
					initialUpdateLu.dates?.checkinISO &&
					initialUpdateLu.dates?.checkoutISO &&
					looksLikeReservationDateUpdate(initialInquiry, initialUpdateLu)
				) {
					const handled = await handleReservationUpdateRequest(
						io,
						sc,
						st,
						initialInquiry,
						initialUpdateLu,
						{ forceDateUpdate: true }
					);
					if (handled) return;
				}
				const greeting = st.hotel
					? initialHotelGreetingText(sc, st)
					: await write(
							io,
							sc,
							st,
							initialInquiry
								? "The guest has just opened chat. Use the initial inquiry details only as private context, greet them by first name, introduce yourself as the active assistant, using hotel reception and reservations wording when a hotel is selected, and ask how you can help today. If the context suggests a reservation, gently confirm that they may want to reserve a room. Do not open by asking for check-in/check-out dates."
								: "The guest has just opened chat but has not typed a message yet. Greet them by first name, introduce yourself as the active assistant, using hotel reception and reservations wording when a hotel is selected, and ask how you can help today. Keep it one short line. Do not open by asking for check-in/check-out dates.",
							{ initialInquiry }
					  );
				await humanSend(io, sc, st, greeting, { first: true });
				st.waitFor = "clarify";
				return;
			}
			logStep(caseId, "turn.skip", { reason: "no_customer_message" });
			return;
		}
		if (!st.greeted && !st.greetScheduled) {
			st.greetScheduled = true;
			st.greeted = true;
			if (looksLikeGreetingOnly(userText)) {
				const greeting = st.hotel
					? initialHotelGreetingText(sc, st)
					: await write(
							io,
							sc,
							st,
							"Greet the guest by first name, introduce yourself as the active assistant, using hotel reception and reservations wording when a hotel is selected, and ask how you can help today. Keep it one short line. Do not open by asking for check-in/check-out dates.",
							{ latestUserMessage: userText }
					  );
				await humanSend(io, sc, st, greeting, { first: true });
				st.waitFor = "clarify";
				return;
			}
		}
		if (abusiveGuestText(userText)) {
			await handoffToHuman(io, sc, st, "abusive_guest");
			return;
		}

		hydrateKnownSlotsFromConversation(sc, st);
		recoverBookingStageFromConversation(sc, st);
		const assistantBeforeLatestGuest = lastAssistantMessageBeforeLatestGuest(sc);
		const assistantBeforeLatestGuestActions = quickReplyActions(
			assistantBeforeLatestGuest
		);
		const assistantBeforeLatestGuestHasBookingChoice =
			assistantBeforeLatestGuestActions.includes("confirm") ||
			assistantBeforeLatestGuestActions.includes("correction") ||
			assistantBeforeLatestGuestActions.includes("proceed") ||
			assistantBeforeLatestGuestActions.some((action) =>
				action.startsWith("connect_hotel_")
			);
		if (
			st.slots.roomTypeKey &&
			st.slots.checkinISO &&
			st.slots.checkoutISO &&
			!isReservationDetailStep(st) &&
			st.waitFor !== "proceed" &&
			!assistantBeforeLatestGuestHasBookingChoice &&
			!humanHandoffReason(userText) &&
			!wantsPaymentHelp(userText) &&
			!explicitlyExistingReservationIntent(userText) &&
			(st.waitFor === "dates" ||
				(hijriYearOnlyOrClarificationText(userText) &&
					assistantAskedForDateOrHijriYear(lastAssistantText(sc))) ||
				(confirmsText(userText) &&
					assistantAskedForDateOrHijriYear(lastAssistantText(sc))))
		) {
			logStep(caseId, "dates.completed_from_context", {
				roomTypeKey: st.slots.roomTypeKey,
				checkinISO: st.slots.checkinISO,
				checkoutISO: st.slots.checkoutISO,
				waitFor: st.waitFor,
			});
			if (st.hotel) {
				await shareKnownStayQuote(io, sc, st);
			} else {
				await answerJannatBookingHotelOptions(
					io,
					sc,
					st,
					userText,
					st.slots.roomTypeKey
				);
			}
			return;
		}
		if (!st.hotel && hotelComplaintText(userText)) {
			await handoffToHuman(io, sc, st, "jannat_hotel_complaint");
			return;
		}
		if (!st.hotel && st.waitFor === "platform_hotel_choice") {
			const handled = await handlePlatformHotelChoice(io, sc, st, userText);
			if (handled) return;
		}
		if (
			!st.hotel &&
			st.waitFor === "jannat_reservation_reference" &&
			(latestKnownConfirmation(sc, {}) || wantsReservationHelp(userText))
		) {
			await redirectJannatReservationToHotelSupport(io, sc, st, userText, {});
			return;
		}
		if (st.waitFor === "reservation_cancellation_policy_ack") {
			const handled = await handleReservationCancellationPolicyAck(
				io,
				sc,
				st,
				userText
			);
			if (handled) return;
		}
		if (st.waitFor === "reservation_cancellation_reference") {
			const handled = await handleReservationCancellationRequest(
				io,
				sc,
				st,
				userText,
				{}
			);
			if (handled) return;
		}
		if (st.waitFor === "reservation_update_option") {
			const handled = await handlePendingReservationUpdateChoice(
				io,
				sc,
				st,
				userText
			);
			if (handled) return;
		}
		const directUpdateLu = deterministicReservationUpdateLu(userText, sc, {});
		if (
			st.hotel &&
			directUpdateLu.confirmation &&
			directUpdateLu.dates?.checkinISO &&
			directUpdateLu.dates?.checkoutISO &&
			looksLikeReservationDateUpdate(userText, directUpdateLu)
		) {
			if (needsExplicitPastDateClarification(userText, directUpdateLu.dates)) {
				await askExplicitPastDateClarification(
					io,
					sc,
					st,
					userText,
					directUpdateLu.dates
				);
				return;
			}
			const handled = await handleReservationUpdateRequest(
				io,
				sc,
				st,
				userText,
				directUpdateLu,
				{ forceDateUpdate: true }
			);
			if (handled) return;
		}
		if (st.waitFor === "post_booking_followup") {
			const handled = await handlePostBookingFollowup(io, sc, st, userText);
			if (handled) return;
		}
		if (vagueHajjInquiryText(userText)) {
			await answerVagueHajjInquiry(io, sc, st, userText);
			return;
		}
		if (
			hotelContactDetailsQuestionText(userText) ||
			hotelContactFollowupQuestionText(sc, userText)
		) {
			await answerHotelContactDetailsInquiry(io, sc, st, userText);
			return;
		}
		if (
			st.hotel &&
			selectedHotelFactQuestionText(userText) &&
			!humanHandoffReason(userText) &&
			!wantsPaymentHelp(userText) &&
			!explicitlyExistingReservationIntent(userText)
		) {
			await answerSelectedHotelFactQuestion(io, sc, st, userText);
			return;
		}
		if (isReservationDetailStep(st)) {
			const handled = await handleReservationDetailStep(
				io,
				sc,
				st,
				userText,
				caseId
			);
			if (handled) return;
		}
		const preNluProceedHandled = await handleProceedStageInput(
			io,
			sc,
			st,
			userText,
			{},
			{ allowGeneric: false }
		);
		if (preNluProceedHandled) return;

		const quickTurnDates = quickDateRange(userText);
		if (needsExplicitPastDateClarification(userText, quickTurnDates)) {
			await askExplicitPastDateClarification(io, sc, st, userText, quickTurnDates);
			return;
		}
		if (
			st.hotel &&
			st.slots.roomTypeKey &&
			quickTurnDates.checkinISO &&
			quickTurnDates.checkoutISO &&
			!humanHandoffReason(userText) &&
			!wantsPaymentHelp(userText) &&
			!explicitlyExistingReservationIntent(userText)
		) {
			st.slots.checkinISO = quickTurnDates.checkinISO;
			st.slots.checkoutISO = quickTurnDates.checkoutISO;
			if (quickTurnDates.raw) {
				st.dateRaw = { ...st.dateRaw, ...quickTurnDates.raw };
			}
			logStep(caseId, "quick_dates.direct_quote", {
				roomTypeKey: st.slots.roomTypeKey,
				checkinISO: st.slots.checkinISO,
				checkoutISO: st.slots.checkoutISO,
			});
			await shareKnownStayQuote(io, sc, st);
			return;
		}

		// Legacy greeting branch is skipped after the first real customer turn.
		if (!st.greeted && !st.greetScheduled) {
			st.greetScheduled = true;
			st.waitFor = "intentConfirm";
			const greetOwner = st.hotel?.hotelName
				? `the ${toTitle(st.hotel.hotelName)} reception and reservations desk`
				: "Jannat Booking support";
			const greetText = await write(
				io,
				sc,
				st,
				`Start: "As‑salāmu ʿalaykum, ${st.slots.name}." Introduce as ${st.agentName} from ${greetOwner}. Then ask: "I see you'd like to make a new reservation — is that correct?" (ONE yes/no).`
			);
			await humanSend(io, sc, st, greetText, { first: true });
			st.greeted = true;
			stampAsk(st, "intentConfirm");
			return;
		}

		const decisionLu = await nluStep({
			sc,
			hotel: st.hotel,
			lastUserMessage: userText,
		});
		logStep(caseId, "nlu.decision", decisionLu);
		const bookingFlowWasActiveBeforeNlu =
			isNewReservationFlowActive(st) ||
			Boolean(st.quote) ||
			["dates", "room", "proceed", "clarify", "intentConfirm"].includes(st.waitFor);

		if (
			!st.hotel &&
			jannatReservationHotelRedirectIntent(userText, decisionLu, sc)
		) {
			await redirectJannatReservationToHotelSupport(
				io,
				sc,
				st,
				userText,
				decisionLu
			);
			return;
		}

		if (needsExplicitPastDateClarification(userText, decisionLu?.dates)) {
			await askExplicitPastDateClarification(io, sc, st, userText, decisionLu.dates);
			return;
		}

		if (decisionLu?.dates?.raw) {
			if (decisionLu.dates.raw.checkin)
				st.dateRaw.checkin = decisionLu.dates.raw.checkin;
			if (decisionLu.dates.raw.checkout)
				st.dateRaw.checkout = decisionLu.dates.raw.checkout;
			if (decisionLu.dates.raw.calendar)
				st.dateRaw.calendar = decisionLu.dates.raw.calendar;
			if (decisionLu.dates.raw.checkinHijri)
				st.dateRaw.checkinHijri = decisionLu.dates.raw.checkinHijri;
			if (decisionLu.dates.raw.checkoutHijri)
				st.dateRaw.checkoutHijri = decisionLu.dates.raw.checkoutHijri;
		}
		if (decisionLu.dates?.checkinISO)
			st.slots.checkinISO = decisionLu.dates.checkinISO;
		if (decisionLu.dates?.checkoutISO)
			st.slots.checkoutISO = decisionLu.dates.checkoutISO;
		if (decisionLu.roomTypeKey) st.slots.roomTypeKey = decisionLu.roomTypeKey;

		if (
			looksLikeReservationDateUpdate(userText, decisionLu) ||
			st.waitFor === "reservation_update_clarify"
		) {
			const handled = await handleReservationUpdateRequest(
				io,
				sc,
				st,
				userText,
				decisionLu,
				{ forceDateUpdate: st.waitFor === "reservation_update_clarify" }
			);
			if (handled) return;
		}

		if (
			st.hotel &&
			selectedHotelFactQuestionText(userText) &&
			!humanHandoffReason(userText) &&
			!wantsPaymentHelp(userText) &&
			!explicitlyExistingReservationIntent(userText)
		) {
			await answerSelectedHotelFactQuestion(io, sc, st, userText);
			return;
		}

		if (
			st.hotel &&
			selectedHotelRoomQuestionText(userText) &&
			!humanHandoffReason(userText) &&
			!wantsPaymentHelp(userText) &&
			!explicitlyExistingReservationIntent(userText)
		) {
			const requestedRoomTypeKey =
				decisionLu.roomTypeKey || mapRoomToKey(userText) || st.slots.roomTypeKey || null;
			await answerSelectedHotelRoomQuestion(
				io,
				sc,
				st,
				userText,
				requestedRoomTypeKey
			);
			return;
		}

		if (!humanHandoffReason(userText) && wantsDiscountQuestion(userText)) {
			logStep(caseId, "discount.question", { source: "deterministic" });
			await answerDiscountQuestion(io, sc, st, userText);
			return;
		}

		const proceedHandled = await handleProceedStageInput(
			io,
			sc,
			st,
			userText,
			decisionLu
		);
		if (proceedHandled) return;

		const hasFreshNluDateRange = Boolean(
			decisionLu?.dates?.checkinISO && decisionLu?.dates?.checkoutISO
		);
		const readyToQuoteFromNlu =
			st.slots.checkinISO &&
			st.slots.checkoutISO &&
			st.slots.roomTypeKey &&
			(/\b(book|reserve|price|rate|availability|available|room|stay|double|triple|quad)\b/i.test(
				userText
			) ||
				(bookingFlowWasActiveBeforeNlu && hasFreshNluDateRange && st.hotel)) &&
			!humanHandoffReason(userText) &&
			!wantsPaymentHelp(userText) &&
			!wantsReservationHelp(userText);
		if (readyToQuoteFromNlu) {
			logStep(caseId, "nlu.direct_quote", {
				checkinISO: st.slots.checkinISO,
				checkoutISO: st.slots.checkoutISO,
				roomTypeKey: st.slots.roomTypeKey,
			});
			if (st.hotel) {
				await shareKnownStayQuote(io, sc, st);
			} else {
				await answerJannatBookingHotelOptions(
					io,
					sc,
					st,
					userText,
					st.slots.roomTypeKey
				);
			}
			return;
		}

		if (st.hotel && crossHotelRequestText(userText)) {
			logStep(caseId, "hotel_scope.boundary", { source: "deterministic" });
			await humanSend(io, sc, st, selectedHotelSupportBoundaryReply(sc, st));
			st.waitFor = "clarify";
			return;
		}

		const supportDecision = await decideSupportAction({
			sc,
			st,
			userText,
			lu: decisionLu,
		});
		if (
			supportDecision.action === "reservation_lookup" &&
			isNewReservationFlowActive(st) &&
			!decisionLu?.confirmation &&
			!explicitlyExistingReservationIntent(userText)
		) {
			supportDecision.action = "continue_booking";
			supportDecision.reason = "new_reservation_flow_active";
		}
		logStep(caseId, "orchestrator.decision", supportDecision);

		if (supportDecision.roomTypeKey) {
			st.slots.roomTypeKey = supportDecision.roomTypeKey;
		}

		if (supportDecision.action === "general_answer") {
			if (st.hotel && selectedHotelFactQuestionText(userText)) {
				await answerSelectedHotelFactQuestion(io, sc, st, userText);
				return;
			}
			await answerGeneralContextQuestion(
				io,
				sc,
				st,
				userText,
				supportDecision.reason || "verified_general_answer"
			);
			return;
		}

		if (supportDecision.action === "support_email") {
			await answerSupportEmailInquiry(
				io,
				sc,
				st,
				userText,
				supportDecision.reason || "unsupported_general_question"
			);
			return;
		}

		if (broadGeneralSupportQuestionText(userText, st, decisionLu)) {
			await answerSupportEmailInquiry(
				io,
				sc,
				st,
				userText,
				supportDecision.reason || "unsupported_general_question"
			);
			return;
		}

		if (shouldAskRoomPreferenceFirst(userText, st, decisionLu, supportDecision)) {
			await askRoomPreferenceForReservation(io, sc, st);
			return;
		}

		if (supportDecision.action === "discount_question") {
			logStep(caseId, "discount.question", { source: "decision" });
			await answerDiscountQuestion(io, sc, st, userText);
			return;
		}

		if (supportDecision.action === "reservation_cancellation") {
			if (!st.hotel) {
				await redirectJannatReservationToHotelSupport(
					io,
					sc,
					st,
					userText,
					decisionLu
				);
				return;
			}
			const handled = await handleReservationCancellationRequest(
				io,
				sc,
				st,
				userText,
				decisionLu,
				{ forceCancellation: true }
			);
			if (handled) return;
			await handoffToHuman(io, sc, st, "reservation_cancellation");
			return;
		}

		if (supportDecision.action === "reservation_update") {
			if (!st.hotel) {
				await redirectJannatReservationToHotelSupport(
					io,
					sc,
					st,
					userText,
					decisionLu
				);
				return;
			}
			const handled = await handleReservationUpdateRequest(
				io,
				sc,
				st,
				userText,
				decisionLu
			);
			if (handled) return;
			await handoffToHuman(io, sc, st, "reservation_update");
			return;
		}

		if (supportDecision.action === "human_escalation") {
			await handoffToHuman(
				io,
				sc,
				st,
				supportDecision.reason || "human_review_needed"
			);
			return;
		}

		if (
			supportDecision.action === "ask_dates_for_price" &&
			st.hotel &&
			st.slots.roomTypeKey &&
			(!st.slots.checkinISO || !st.slots.checkoutISO)
		) {
			await answerSelectedHotelRoomQuestion(
				io,
				sc,
				st,
				userText,
				st.slots.roomTypeKey
			);
			return;
		}

		if (supportDecision.action === "hotel_recommendation") {
			const roomTypeKey =
				supportDecision.roomTypeKey ||
				decisionLu.roomTypeKey ||
				st.slots.roomTypeKey ||
				null;
			if (st.hotel) {
				logStep(caseId, "hotel_scope.boundary", {
					source: "decision",
					reason: supportDecision.reason,
					scope: supportDecision.scope,
				});
				if (crossHotelRequestText(userText)) {
					await humanSend(io, sc, st, selectedHotelSupportBoundaryReply(sc, st));
					st.waitFor = "clarify";
					return;
				}
				await answerSelectedHotelRoomQuestion(io, sc, st, userText, roomTypeKey);
				return;
			}
			const recommendationRoomTypeKey = roomTypeKey || "doubleRooms";
			await answerJannatBookingHotelOptions(
				io,
				sc,
				st,
				userText,
				recommendationRoomTypeKey
			);
			return;
		}

		if (
			(supportDecision.action === "ask_dates_for_price" ||
				supportDecision.action === "continue_booking") &&
			st.slots.checkinISO &&
			st.slots.checkoutISO &&
			st.slots.roomTypeKey
		) {
			if (st.hotel) {
				await shareKnownStayQuote(io, sc, st);
			} else {
				await answerJannatBookingHotelOptions(
					io,
					sc,
					st,
					userText,
					st.slots.roomTypeKey
				);
			}
			return;
		}

		if (supportDecision.action === "ask_dates_for_price") {
			const reply = await write(
				io,
				sc,
				st,
				"The guest is asking about price but dates are missing. Ask for check-in and checkout dates in one short question. Do not invent prices.",
				{ latestUserMessage: userText, slots: st.slots }
			);
			await humanSend(io, sc, st, reply);
			st.waitFor = "dates";
			return;
		}

		if (supportDecision.action === "payment_help") {
			if (!st.hotel) {
				await redirectJannatReservationToHotelSupport(
					io,
					sc,
					st,
					userText,
					decisionLu
				);
				return;
			}
			const knownConfirmation = latestKnownConfirmation(sc, decisionLu);
			const reply = await write(
				io,
				sc,
				st,
				"The guest has a payment issue. Answer the latest question directly and keep it short. If a confirmation number or payment link already appears in the conversation, do not ask for it again. Never ask for card details.",
				{ latestUserMessage: userText, knownConfirmation }
			);
			await humanSend(io, sc, st, reply);
			st.waitFor = "payment_reference";
			return;
		}

		if (supportDecision.action === "reservation_lookup") {
			if (!st.hotel) {
				await redirectJannatReservationToHotelSupport(
					io,
					sc,
					st,
					userText,
					decisionLu
				);
				return;
			}
			const knownConfirmation = latestKnownConfirmation(sc, decisionLu);
			const reply = await write(
				io,
				sc,
				st,
				knownConfirmation
					? "The guest is asking about an existing reservation and the confirmation number is already known. Acknowledge the known confirmation number and ask only what they need help with. Do not ask for the confirmation number again."
					: "The guest is asking about an existing reservation. Ask for the confirmation number and one sentence about what they need. Keep it concise.",
				{ latestUserMessage: userText, knownConfirmation }
			);
			await humanSend(io, sc, st, reply);
			st.waitFor = "reservation_reference";
			return;
		}

		if (supportDecision.action === "amenity_question") {
			const amenityKey = decisionLu.amenity || findAmenityMatch(userText);
			if (amenityKey) {
				const chosenRoom = (st.hotel?.roomCountDetails || []).find(
					(room) => room.roomType === st.slots.roomTypeKey
				);
				const amenityFacts = {
					amenityKey,
					chosenRoom: chosenRoom
						? {
								displayName: chosenRoom.displayName || chosenRoom.roomType,
								hasAmenity: roomHasAmenity(chosenRoom, amenityKey),
						  }
						: null,
					hotelHasAmenity: hotelHasAmenity(st.hotel, amenityKey),
					nextStep: nextPivot(st),
				};
				const reply = await write(
					io,
					sc,
					st,
					"Answer the amenity question using the facts only, then include at most one helpful next question if needed.",
					amenityFacts
				);
				await humanSend(io, sc, st, reply);
				return;
			}
		}

		// Interpret latest user turn
		const handoffReason = humanHandoffReason(userText);
		if (handoffReason) {
			if (handoffReason === "reservation_cancellation") {
				if (!st.hotel) {
					await redirectJannatReservationToHotelSupport(
						io,
						sc,
						st,
						userText,
						decisionLu
					);
					return;
				}
				const handled = await handleReservationCancellationRequest(
					io,
					sc,
					st,
					userText,
					decisionLu
				);
				if (handled) return;
			}
			if (handoffReason === "reservation_update") {
				if (!st.hotel) {
					await redirectJannatReservationToHotelSupport(
						io,
						sc,
						st,
						userText,
						decisionLu
					);
					return;
				}
				const handled = await handleReservationUpdateRequest(
					io,
					sc,
					st,
					userText,
					decisionLu
				);
				if (handled) return;
			}
			await handoffToHuman(io, sc, st, handoffReason);
			return;
		}
		if (wantsHotelRecommendation(userText)) {
			if (st.hotel) {
				if (crossHotelRequestText(userText)) {
					logStep(caseId, "hotel_scope.boundary", { source: "keyword" });
					await humanSend(io, sc, st, selectedHotelSupportBoundaryReply(sc, st));
					st.waitFor = "clarify";
					return;
				}
				await answerSelectedHotelRoomQuestion(
					io,
					sc,
					st,
					userText,
					decisionLu.roomTypeKey || st.slots.roomTypeKey || null
				);
				return;
			}
			const roomTypeKey =
				decisionLu.roomTypeKey || mapRoomToKey(userText) || st.slots.roomTypeKey || null;
			await answerJannatBookingHotelOptions(io, sc, st, userText, roomTypeKey);
			return;
		}
		if (wantsPriceButMissingDates(userText, st)) {
			const reply = await write(
				io,
				sc,
				st,
				"The guest is asking about price but the stay dates are missing. Ask for check-in and checkout dates in one short, professional question. Do not invent prices.",
				{ latestUserMessage: userText, slots: st.slots }
			);
			await humanSend(io, sc, st, reply);
			st.waitFor = "dates";
			return;
		}
		if (wantsPaymentHelp(userText)) {
			if (!st.hotel) {
				await redirectJannatReservationToHotelSupport(
					io,
					sc,
					st,
					userText,
					decisionLu
				);
				return;
			}
			const knownConfirmation = latestKnownConfirmation(sc, {});
			const reply = await write(
				io,
				sc,
				st,
				"The guest has a payment issue. Give practical first-step guidance and ask for exactly one useful reference only if it is not already in the conversation. Never ask for card details.",
				{ latestUserMessage: userText, knownConfirmation }
			);
			await humanSend(io, sc, st, reply);
			st.waitFor = "payment_reference";
			return;
		}
		if (
			wantsReservationHelp(userText) &&
			!(
				isNewReservationFlowActive(st) &&
				!latestKnownConfirmation(sc, {}) &&
				!explicitlyExistingReservationIntent(userText)
			)
		) {
			if (!st.hotel) {
				await redirectJannatReservationToHotelSupport(
					io,
					sc,
					st,
					userText,
					decisionLu
				);
				return;
			}
			const knownConfirmation = latestKnownConfirmation(sc, {});
			const reply = await write(
				io,
				sc,
				st,
				"The guest is asking about an existing reservation. Ask for the missing reference or missing change detail only; do not ask again for anything already supplied. Keep it concise and professional.",
				{ latestUserMessage: userText, knownConfirmation }
			);
			await humanSend(io, sc, st, reply);
			st.waitFor = "reservation_reference";
			return;
		}
		const dateRange = extractDateRange(userText);
		if (needsExplicitPastDateClarification(userText, dateRange)) {
			await askExplicitPastDateClarification(io, sc, st, userText, dateRange);
			return;
		}
		if (
			dateRange.checkinISO &&
			dateRange.checkoutISO &&
			st.slots.roomTypeKey
		) {
			st.slots.checkinISO = dateRange.checkinISO;
			st.slots.checkoutISO = dateRange.checkoutISO;
			if (st.hotel) {
				await shareKnownStayQuote(io, sc, st);
			} else {
				await answerJannatBookingHotelOptions(
					io,
					sc,
					st,
					userText,
					st.slots.roomTypeKey
				);
			}
			return;
		}
		const lu = decisionLu;
		logStep(caseId, "nlu.reused", lu);

		// raw dates (for hijri display)
		if (lu?.dates?.raw) {
			if (lu.dates.raw.checkin) st.dateRaw.checkin = lu.dates.raw.checkin;
			if (lu.dates.raw.checkout) st.dateRaw.checkout = lu.dates.raw.checkout;
			if (lu.dates.raw.calendar) st.dateRaw.calendar = lu.dates.raw.calendar;
			if (lu.dates.raw.checkinHijri)
				st.dateRaw.checkinHijri = lu.dates.raw.checkinHijri;
			if (lu.dates.raw.checkoutHijri)
				st.dateRaw.checkoutHijri = lu.dates.raw.checkoutHijri;
		}

		// merge slots
		if (lu.dates?.checkinISO) st.slots.checkinISO = lu.dates.checkinISO;
		if (lu.dates?.checkoutISO) st.slots.checkoutISO = lu.dates.checkoutISO;
		if (lu.roomTypeKey) st.slots.roomTypeKey = lu.roomTypeKey;

		// ===== Amenity interception (e.g., "does it have WiFi?")
		const amenityKey = lu.amenity || findAmenityMatch(userText);
		if (amenityKey) {
			const chosenRoom = (st.hotel?.roomCountDetails || []).find(
				(r) => r.roomType === st.slots.roomTypeKey
			);
			const hasOnRoom = chosenRoom
				? roomHasAmenity(chosenRoom, amenityKey)
				: false;
			const hasOnHotel = !hasOnRoom && hotelHasAmenity(st.hotel, amenityKey);
			const amenityLabel =
				amenityKey === "wifi"
					? "Wi‑Fi"
					: amenityKey === "ac"
					? "air conditioning"
					: amenityKey;

			let line;
			if (chosenRoom) {
				const label =
					chosenRoom.displayName || chosenRoom.roomType || "this room";
				line = hasOnRoom
					? `Yes, the ${label} includes ${amenityLabel}.`
					: hasOnHotel
					? `The ${label} does not list ${amenityLabel}, but it is available at the hotel.`
					: `I don’t see ${amenityLabel} listed for the ${label}. If it’s essential, I can double‑check with the hotel team.`;
			} else {
				line = hasOnHotel
					? `Yes, ${amenityLabel} is available at the hotel.`
					: `I don’t see ${amenityLabel} listed. If it’s essential, I can double‑check with the hotel team.`;
			}

			// Pivot to the next required step after answering
			const pivot = nextPivot(st);
			let ask = "";
			if (pivot === "intentConfirm" && !askedRecently(st, "intentConfirm")) {
				ask = "Would you like to make a new reservation today?";
				stampAsk(st, "intentConfirm");
				st.waitFor = "intentConfirm";
			} else if (pivot === "dates" && !askedRecently(st, "dates")) {
				ask = "Could you share your preferred check‑in and check‑out dates?";
				stampAsk(st, "dates");
				st.waitFor = "dates";
			} else if (pivot === "room" && !askedRecently(st, "room")) {
				const examples = (st.hotel?.roomCountDetails || [])
					.filter((r) => r.activeRoom)
					.map((r) => r.displayName || r.roomType)
					.slice(0, 4);
				ask = examples.length
					? `Which room type suits you best? For example: ${examples.join(
							" / "
					  )}.`
					: `Which room type would you like?`;
				stampAsk(st, "room");
				st.waitFor = "room";
			} else if (pivot === "proceed" && !askedRecently(st, "proceed")) {
				ask = "Would you like me to proceed with this option?";
				stampAsk(st, "proceed");
				st.waitFor = "proceed";
			}

			const reply = await write(
				io,
				sc,
				st,
				"Answer the guest's amenity question using the provided amenity result. Then, only if nextQuestion is present, add that next booking question naturally. Do not invent amenities.",
				{
					amenityLabel,
					amenityAvailableOnRoom: hasOnRoom,
					amenityAvailableOnHotel: hasOnHotel,
					roomLabel: chosenRoom?.displayName || chosenRoom?.roomType || "",
					answerDraft: line,
					nextQuestion: ask,
				}
			);
			await humanSend(io, sc, st, reply);
			return;
		}

		// month missing handling
		if (lu?.dates?.reason === "month_missing") {
			if (!askedRecently(st, "dates")) {
				const askMonth = await write(
					io,
					sc,
					st,
					"Explain kindly that the month is required. Ask once for both dates with month and year."
				);
				await humanSend(io, sc, st, askMonth);
				stampAsk(st, "dates");
			}
			st.waitFor = "dates";
			return;
		}

		// smalltalk
		if (lu.intent === "smalltalk") {
			await handleSmalltalk(io, sc, st, lu, userText);
			return;
		}

		if (shouldAskRoomPreferenceFirst(userText, st, lu, supportDecision)) {
			await askRoomPreferenceForReservation(io, sc, st);
			return;
		}

		// intent confirmation step
		if (st.waitFor === "intentConfirm") {
			if (/\b(yes|yep|yeah|correct|sure|تمام|نعم|ايه|أجل)\b/i.test(userText)) {
				if (!askedRecently(st, "dates")) {
					const ask = await write(
						io,
						sc,
						st,
						"Ask for check‑in and check‑out in one question. Keep it short."
					);
					await humanSend(io, sc, st, ask);
					stampAsk(st, "dates");
				}
				st.waitFor = "dates";
				return;
			} else if (/\b(no|nope|not now|later|cancel|لا)\b/i.test(userText)) {
				const msg = await write(
					io,
					sc,
					st,
					"Acknowledge politely and ask how you can help (new reservation, existing booking, or availability). No long text."
				);
				await humanSend(io, sc, st, msg);
				return;
			} else {
				// If they answered with dates or a room phrase, the normal flow below will catch it.
			}
		}

		// need dates?
		if (!st.slots.checkinISO || !st.slots.checkoutISO) {
			if (!askedRecently(st, "dates")) {
				const ask = await write(
					io,
					sc,
					st,
					"Ask for check‑in and check‑out in one question. Keep it short."
				);
				await humanSend(io, sc, st, ask);
				stampAsk(st, "dates");
			}
			st.waitFor = "dates";
			return;
		}

		// need room?
		if (!st.slots.roomTypeKey) {
			if (!askedRecently(st, "room")) {
				const options = (st.hotel?.roomCountDetails || [])
					.filter((r) => r.activeRoom)
					.map((r) => r.displayName || r.roomType)
					.slice(0, 4);
				const ask = await write(
					io,
					sc,
					st,
					"Ask which room type they prefer (ONE question). Offer 2–4 examples.",
					{ roomExamples: options }
				);
				await humanSend(io, sc, st, ask);
				stampAsk(st, "room");
			}
			st.waitFor = "room";
			return;
		}

		if (!st.hotel) {
			await answerJannatBookingHotelOptions(
				io,
				sc,
				st,
				userText,
				st.slots.roomTypeKey
			);
			return;
		}

		// pricing
		const qKey = `${st.slots.roomTypeKey}|${st.slots.checkinISO}|${st.slots.checkoutISO}`;
		const reuse =
			st.quote && st.quote.key === qKey && now() - st.quote.at < 120000;
		let quote;
		if (!reuse) {
			quote = safePriceRoomForStay(
				st.hotel,
				{ roomType: st.slots.roomTypeKey },
				st.slots.checkinISO,
				st.slots.checkoutISO
			);
			logStep(caseId, "pricing", {
				roomType: st.slots.roomTypeKey,
				available: quote.available,
				reason: quote.reason || null,
				nights: quote.nights || 0,
				total: quote?.totals?.totalPriceWithCommission,
				currency: quote.currency,
			});
			st.quote = { key: qKey, at: now(), data: quote };
		} else {
			quote = st.quote.data;
			logStep(caseId, "pricing.skip", { reason: "cooldown", key: qKey });
		}

		if (!quote.available) {
			const alternatives = listAvailableRoomsForStay(
				st.hotel,
				st.slots.checkinISO,
				st.slots.checkoutISO
			)
				.filter((r) => r.available)
				.map((r) => ({
					roomType: r.room?.roomType,
					displayName: r.room?.displayName || r.room?.roomType,
					total: r?.totals?.totalPriceWithCommission,
					currency: r.currency,
				}))
				.slice(0, 3);

			if (!askedRecently(st, "alt")) {
				const msg = await write(
					io,
					sc,
					st,
					quote.reason === "blocked"
						? "Explain that this room is blocked (zero price rule) for these dates at the selected hotel. Offer up to 3 same-hotel room-type alternatives with totals if provided."
						: "Explain no priced inventory for these dates at the selected hotel; offer up to 3 same-hotel room-type alternatives with totals if provided.",
					{ alternatives, reason: quote.reason || "no_price" }
				);
				await humanSend(io, sc, st, msg);
				await humanPause();
				const askAlt = await write(
					io,
					sc,
					st,
					"Ask ONE question only: change dates or choose a different room type?"
				);
				await humanSend(io, sc, st, askAlt);
				stampAsk(st, "room");
			}
			st.waitFor = "room";
			return;
		}

		// quote summary (cooldown)
		if (now() - st.quoteSummarizedAt > QUOTE_SUMMARY_COOLDOWN) {
			const total = quote.totals.totalPriceWithCommission;
			const nights = quote.nights;
			const perNightAvg = Math.round((total / Math.max(1, nights)) * 100) / 100;
			const display = {
				hotel: toTitle(st.hotel?.hotelName || "Hotel"),
				roomDisplay:
					quote.room?.displayName ||
					quote.room?.roomType ||
					st.slots.roomTypeKey,
				nights,
				currency: quote.currency,
				perNight: perNightAvg,
				total,
				dates: {
					checkin: usDate(st.slots.checkinISO),
					checkout: usDate(st.slots.checkoutISO),
				},
				dateDisplay: stayDateDisplay(st),
			};
			let quoteMsg = await write(
				io,
				sc,
				st,
				"Share a concise availability & price summary (no upsell). If the guest provided Hijri dates, include the Hijri range and matching Gregorian range. Then ask a single yes/no: proceed to confirm?",
				display
			);
			quoteMsg = ensureHijriGregorianDatesVisible(quoteMsg, sc, st);
			const sent = await humanSend(io, sc, st, quoteMsg, {
				quickReplies: proceedQuickReplies(sc, st),
			});
			if (!sent) return;
			st.quoteSummarizedAt = now();
		}
		st.waitFor = "proceed";

		// proceed?
		if (st.waitFor === "proceed") {
			if (confirmsText(userText)) {
				const q = st.quote?.data || quote;
				const reviewPayload = buildReservationReviewPayload(st, q);
				logStep(caseId, "review.summaryBuilt", reviewPayload);
				const reviewText = await composeReservationReviewText(
					io,
					sc,
					st,
					q,
					reviewPayload
				);
				const sent = await humanSend(io, sc, st, reviewText, {
					quickReplies: confirmationQuickReplies(sc, st),
				});
				if (!sent) return;
				st.reviewSent = true;
				st.waitFor = "reviewConfirm";
				return;
			}
			if (declinesText(userText)) {
				const msg = await write(
					io,
					sc,
					st,
					"Acknowledge politely and offer to notify when availability changes, or help with other dates."
				);
				await humanSend(io, sc, st, msg);
				return;
			}
			if (
				/\b(yes|yep|yeah|ok|okay|proceed|go ahead|confirm|تمام|نعم|ايه)\b/i.test(
					userText
				)
			) {
				// Review
				const q = st.quote?.data || quote;
				const reviewPayload = buildReservationReviewPayload(st, q);
				logStep(caseId, "review.summaryBuilt", reviewPayload);
				let reviewText = await composeReservationReviewText(
					io,
					sc,
					st,
					q,
					reviewPayload
				);
				reviewText = ensureHijriGregorianDatesVisible(reviewText, sc, st);
				const sent = await humanSend(io, sc, st, reviewText, {
					quickReplies: confirmationQuickReplies(sc, st),
				});
				if (!sent) return;
				st.reviewSent = true;
				st.waitFor = "reviewConfirm";
				return;
			} else if (/\b(no|nope|not now|later|cancel|لا)\b/i.test(userText)) {
				const msg = await write(
					io,
					sc,
					st,
					"Acknowledge politely and offer to notify when availability changes, or help with other dates."
				);
				await humanSend(io, sc, st, msg);
				return;
			} else {
				if (!askedRecently(st, "proceed")) {
					const poke = await write(
						io,
						sc,
						st,
						"Ask a single yes/no: would you like to proceed to confirm?"
					);
					await humanSend(io, sc, st, poke, {
						quickReplies: proceedQuickReplies(sc, st),
					});
					stampAsk(st, "proceed");
				}
				return;
			}
		}

		// After review: collect mandatory guest details in one prompt, then optional email.
		if (
			[
				"reviewConfirm",
				"reservation_details",
				"fullname",
				"nationality",
				"phone",
				"email_or_skip",
				"finalize",
			].includes(st.waitFor)
		) {
			const handledDetailStep = await handleReservationDetailStep(
				io,
				sc,
				st,
				userText,
				caseId
			);
			if (handledDetailStep) return;
			return;

			if (st.waitFor === "reviewConfirm") {
				if (!confirmsText(userText)) return;
				st.waitFor = "fullname";
				const prompt = await write(
					io,
					sc,
					st,
					"Ask naturally for the guest's full name in English as it should appear on the reservation/passport. Keep it warm and ask only this one question."
				);
				await humanSend(io, sc, st, prompt);
				stampAsk(st, "fullname");
				return;
			}

			if (st.waitFor === "fullname" && !st.slots.fullName) {
				const norm = await normalizeNameLLM(userText, st.language);
				if (norm?.valid && norm.fullNameAscii) {
					st.slots.fullName = asciiize(norm.fullNameAscii).trim();
					st.slots.name = st.slots.fullName;
					logStep(caseId, "fullname.captured", {
						fullName: st.slots.fullName,
					});
					st.waitFor = "nationality";
					const askNat = await write(
						io,
						sc,
						st,
						"Ask naturally for the guest's nationality/country name in English. Keep it warm and ask only this one question."
					);
					await humanSend(io, sc, st, askNat);
					stampAsk(st, "nationality");
					return;
				}
				const askAgain = await write(
					io,
					sc,
					st,
					"Kindly ask for a valid full name in English letters. Keep it polite and brief."
				);
				await humanSend(io, sc, st, askAgain);
				stampAsk(st, "fullname");
				return;
			}

			if (st.waitFor === "nationality" && !st.slots.nationality) {
				const nat = await validateNationalityLLM(userText, st.language);
				if (nat?.valid && nat.normalized) {
					st.slots.nationality = nat.normalized;
					logStep(caseId, "nationality.captured", {
						nationality: st.slots.nationality,
					});
					st.waitFor = "phone";
					const askPhone = await write(
						io,
						sc,
						st,
						"Ask naturally for a reachable phone number. Mention WhatsApp is helpful/preferred, but do not make it sound mandatory. Ask only this one question."
					);
					await humanSend(io, sc, st, askPhone);
					stampAsk(st, "phone");
					return;
				}
				const again = await write(
					io,
					sc,
					st,
					"Politely say the nationality was not recognized and ask again for the nationality/country name in English."
				);
				await humanSend(io, sc, st, again);
				stampAsk(st, "nationality");
				return;
			}

			if (st.waitFor === "phone" && !st.slots.phone) {
				const clean = digitsToEnglish(userText).replace(/\D/g, "");
				if (clean.length >= 5) {
					st.slots.phone = clean;
					logStep(caseId, "phone.captured", { phone: st.slots.phone });
					st.waitFor = "email_or_skip";
					const askEmail = await write(
						io,
						sc,
						st,
						"Ask naturally for an email address for reservation details. Let the guest know they can type skip if they prefer not to share one. Ask only this one question."
					);
					await humanSend(io, sc, st, askEmail);
					stampAsk(st, "email_or_skip");
					return;
				}
				const again = await write(
					io,
					sc,
					st,
					"Kindly ask for a reachable phone number using digits. Keep it polite."
				);
				await humanSend(io, sc, st, again);
				stampAsk(st, "phone");
				return;
			}

			if (st.waitFor === "email_or_skip" && !st.slots.email && !st.slots.emailSkipped) {
				const txt = String(userText).trim();
				const email = latestEmailFromText(txt);
				if (email) {
					st.slots.email = email;
					logStep(caseId, "email.captured", { email: st.slots.email });
				} else {
					await inferReservationDetailsFromContext(sc, st, txt, caseId);
					if (st.slots.emailSkipped) {
						logStep(caseId, "email.skipped", { source: "context" });
					} else if (!st.slots.email) {
						const ask = await write(
							io,
							sc,
							st,
							"If that does not look like an email, ask once more briefly and say they can continue without sharing one if they prefer."
						);
						await humanSend(io, sc, st, ask);
						stampAsk(st, "email_or_skip");
						return;
					}
				}
				st.waitFor = "finalize";
			}

			if (st.waitFor === "finalize") {
				try {
					await finalizeReservationForGuest(io, sc, st, caseId);
					return;
				} catch (error) {
					logStep(caseId, "reservation.create_failed", {
						message: error?.message || error,
					});
					await handoffToHuman(io, sc, st, "reservation_finalize_failed");
					return;
				}
			}
		}

		if (st.waitFor === "reviewConfirm") {
			if (/\bconfirm(ed)?\b/i.test(userText)) {
				st.waitFor = "fullname";
			} else {
				return;
			}
		}

		if (st.waitFor === "fullname" && !st.slots.fullName) {
			const prompt = await write(
				io,
				sc,
				st,
				"Ask naturally for the guest's full name in English as it should appear on the reservation/passport. If it is for someone else, ask for that guest's full name. Keep it warm and ask only this one question."
			);
			await humanSend(io, sc, st, prompt);
			return;
		}
		if (!st.slots.fullName && st.waitFor === "fullname") {
			const norm = await normalizeNameLLM(userText, st.language);
			if (norm?.valid && norm.fullNameAscii) {
				st.slots.fullName = asciiize(norm.fullNameAscii).trim();
				logStep(caseId, "fullname.captured", { fullName: st.slots.fullName });
				st.waitFor = "nationality";
			} else {
				const askAgain = await write(
					io,
					sc,
					st,
					"Kindly ask for a valid FULL name in English (letters only). Keep it polite and brief."
				);
				await humanSend(io, sc, st, askAgain);
				return;
			}
		}

		if (st.waitFor === "nationality" && !st.slots.nationality) {
			const askNat = await write(
				io,
				sc,
				st,
				"Ask naturally for the guest's nationality/country name in English. Keep it warm and ask only this one question."
			);
			await humanSend(io, sc, st, askNat);
			return;
		}
		if (!st.slots.nationality && st.waitFor === "nationality") {
			const nat = await validateNationalityLLM(userText, st.language);
			if (nat?.valid && nat.normalized) {
				st.slots.nationality = nat.normalized;
				logStep(caseId, "nationality.captured", {
					nationality: st.slots.nationality,
				});
				st.waitFor = "phone";
			} else {
				const again = await write(
					io,
					sc,
					st,
					"Politely say that nationality wasn’t recognized and ask again (English name)."
				);
				await humanSend(io, sc, st, again);
				return;
			}
		}

		if (st.waitFor === "phone" && !st.slots.phone) {
			const askPhone = await write(
				io,
				sc,
				st,
				"Ask naturally for a reachable phone number. Mention WhatsApp is helpful/preferred, but do not make it sound mandatory. Ask only this one question."
			);
			await humanSend(io, sc, st, askPhone);
			return;
		}
		if (!st.slots.phone && st.waitFor === "phone") {
			const clean = digitsToEnglish(userText).replace(/\D/g, "");
			if (clean.length >= 5) {
				st.slots.phone = clean;
				logStep(caseId, "phone.captured", { phone: st.slots.phone });
				st.waitFor = "email_or_skip";
			} else {
				const again = await write(
					io,
					sc,
					st,
					"Kindly ask for a reachable phone number (digits only). Keep it polite."
				);
				await humanSend(io, sc, st, again);
				return;
			}
		}

		if (st.waitFor === "email_or_skip" && !st.slots.email && !st.slots.emailSkipped) {
			const txt = String(userText).trim();
			const email = latestEmailFromText(txt);
			if (email) {
				st.slots.email = email;
				logStep(caseId, "email.captured", { email: st.slots.email });
			} else {
				await inferReservationDetailsFromContext(sc, st, txt, caseId);
				if (st.slots.emailSkipped) {
					logStep(caseId, "email.skipped", { source: "context" });
				} else if (!st.slots.email) {
					const ask = await write(
						io,
						sc,
						st,
						"Ask naturally for an email address for reservation details. Let the guest know they can continue without one if they prefer. Ask only this one question."
					);
					await humanSend(io, sc, st, ask);
					stampAsk(st, "email_or_skip");
					return;
				}
			}
			st.waitFor = "finalize";
		}

		// Final reservation commits are guarded by inventory validation and pending-confirmation policy.
		if (st.waitFor === "finalize") {
			try {
				await finalizeReservationForGuest(io, sc, st, caseId);
			} catch (error) {
				logStep(caseId, "reservation.create_failed", {
					message: error?.message || error,
				});
				await handoffToHuman(io, sc, st, "reservation_finalize_failed");
			}
			return;
		}
	} catch (e) {
		logStep(caseId, "error", { message: e?.message || e });
		try {
			const latestCase = await getSupportCaseById(caseId);
			const conversation = Array.isArray(latestCase?.conversation)
				? latestCase.conversation
				: [];
			const latestAiAfterGuest = conversation.some((message) => {
				if (!isAiConversationMessage(message)) return false;
				const messageAt = new Date(message.date || 0).getTime();
				return (
					Number.isFinite(messageAt) &&
					messageAt > Number(st.activeTurnGuestAt || 0)
				);
			});
			if (recoveryUserText && !st.interrupt && !latestAiAfterGuest) {
				await humanSend(
					io,
					latestCase || sc,
					st,
					technicalRecoveryText(latestCase || sc, st)
				);
			}
		} catch (recoveryError) {
			logStep(caseId, "error.recovery_failed", {
				message: recoveryError?.message || recoveryError,
			});
		}
	} finally {
		const st2 = memo.get(caseId);
		if (planningTyping) {
			emitTyping(io, caseId, st2 || st, false);
		}
		if (st2) {
			st2.turnInFlight = false;
			if (st2.queue.length > 0) {
				st2.queue = [];
				logStep(caseId, "turn.consume_queue", {});
				getSupportCaseById(caseId)
					.then((sc2) => sc2 && planTurn(io, sc2))
					.catch(() => {});
			}
		}
	}
}

const scheduledTurns = new Map();

function schedulePlanTurn(io, caseOrId, { delayMs = 75 } = {}) {
	const caseId = idText(caseOrId);
	if (!io || !caseId) return false;
	const existing = scheduledTurns.get(caseId);
	if (existing) clearTimeout(existing);
	const timer = setTimeout(async () => {
		scheduledTurns.delete(caseId);
		try {
			const latestCase = await getSupportCaseById(caseId);
			if (latestCase) await planTurn(io, latestCase);
		} catch (error) {
			console.error("[aiagent] scheduled plan error:", error?.message || error);
		}
	}, Math.max(0, Number(delayMs) || 0));
	if (typeof timer.unref === "function") timer.unref();
	scheduledTurns.set(caseId, timer);
	return true;
}

/* ------------------- socket wiring ------------------- */
function wireSocket(io) {
	io.on("connection", (socket) => {
		socket.on("joinRoom", async ({ caseId }) => {
			try {
				if (!caseId) return;
				socket.join(caseId);
				const sc = await getSupportCaseById(caseId);
				if (!sc) return;

				const policy = await ensureAIAllowed(sc.hotelId, sc);
				if (!policy.allowed) {
					logStep(caseId, "join.policy.skip", { reason: policy.reason });
					return;
				}
				const policyHotel = policy.hotel || (await getHotelById(sc.hotelId));
				const hotel = activeHotelContextForCase(sc, policyHotel);
				const st = ensureState(sc, hotel);
				logStep(caseId, "joined_room", {
					hotelId: sc.hotelId,
					hotelName: st.hotel?.hotelName,
				});

				if (!st.greeted && !st.greetScheduled) {
					schedulePlanTurn(io, caseId, { delayMs: 75 });
				}
			} catch (e) {
				console.error("[aiagent] joinRoom error:", e?.message || e);
			}
		});

		socket.on("typing", ({ caseId }) => {
			const st = memo.get(String(caseId));
			if (st) st.guestTypingUntil = now() + 1500;
		});

		socket.on("sendMessage", async (message) => {
			try {
				const caseId = String(message?.caseId || "");
				if (!caseId) return;
				const st = memo.get(caseId);
				if (st && st.turnInFlight) {
					st.queue.push(now());
					st.interrupt = true;
					logStep(caseId, "turn.enqueue", {
						reason: "in_flight",
						queued: st.queue.length,
					});
					return;
				}
				schedulePlanTurn(io, caseId, { delayMs: 75 });
			} catch (e) {
				console.error("[aiagent] sendMessage plan error:", e?.message || e);
			}
		});
	});

	console.log("[aiagent] socket-driven AI planner active.");
}

module.exports = { wireSocket, schedulePlanTurn };
