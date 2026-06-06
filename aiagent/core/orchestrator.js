// aiagent/core/orchestrator.js
const {
	getSupportCaseById,
	updateSupportCaseAppend,
	getHotelById,
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
	asciiize,
	digitsToEnglish,
	detectAmenityQuestion,
} = require("./nlu");

const { chat } = require("./openai");
const { createReservationForCase } = require("./actions");

const DEFAULT_AGENT_POOL = ["Hana", "Aisha", "Sara", "Amira", "Yasmin", "Nadia"];
const AI_SUPPORT_EMAIL = "support@jannatbooking.com";
const LEGACY_AI_SUPPORT_EMAIL = "management@xhotelpro.com";

function intFromEnv(name, fallback, { min = 0, max = 60000 } = {}) {
	const parsed = parseInt(process.env[name] || "", 10);
	const value = Number.isFinite(parsed) ? parsed : fallback;
	return Math.min(max, Math.max(min, value));
}

const HUMAN_THINK_MIN_MS = intFromEnv("AI_HUMAN_THINK_MIN_MS", 300, {
	min: 0,
	max: 5000,
});
const HUMAN_THINK_MAX_MS = Math.max(
	HUMAN_THINK_MIN_MS,
	intFromEnv("AI_HUMAN_THINK_MAX_MS", 650, { min: 0, max: 5000 })
);
const HUMAN_TYPE_CHAR_MIN_MS = intFromEnv("AI_HUMAN_TYPE_CHAR_MIN_MS", 48, {
	min: 1,
	max: 300,
});
const HUMAN_TYPE_CHAR_MAX_MS = Math.max(
	HUMAN_TYPE_CHAR_MIN_MS,
	intFromEnv("AI_HUMAN_TYPE_CHAR_MAX_MS", 60, { min: 1, max: 300 })
);
const HUMAN_TYPE_CLAMP_MIN_MS = intFromEnv("AI_HUMAN_TYPE_CLAMP_MIN_MS", 2200, {
	min: 250,
	max: 10000,
});
const HUMAN_TYPE_CLAMP_MAX_MS = Math.max(
	HUMAN_TYPE_CLAMP_MIN_MS,
	intFromEnv("AI_HUMAN_TYPE_CLAMP_MAX_MS", 7000, { min: 250, max: 15000 })
);
const HUMAN_BETWEEN_SENDS_MIN_MS = intFromEnv(
	"AI_HUMAN_BETWEEN_SENDS_MIN_MS",
	1700,
	{ min: 0, max: 10000 }
);
const HUMAN_BETWEEN_SENDS_MAX_MS = Math.max(
	HUMAN_BETWEEN_SENDS_MIN_MS,
	intFromEnv("AI_HUMAN_BETWEEN_SENDS_MAX_MS", 2200, {
		min: 0,
		max: 10000,
	})
);

const HUMAN = {
	greetThinkMs: intFromEnv("AI_HUMAN_GREET_THINK_MS", 1200, {
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

const SOFT_PIVOT_MS = 35000;
const QUOTE_SUMMARY_COOLDOWN = 45000;

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
	if (frenchScore >= 2) {
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

function respectfulGuestName(sc = {}, st = {}) {
	const rawName = String(
		st.slots?.name || firstNameOf(sc.displayName1 || sc.customerName || "")
	).trim();
	const language = languageOf(sc, st);
	if (/arabic/i.test(language)) {
		if (!rawName || /^guest$/i.test(rawName)) {
			return "\u0636\u064a\u0641\u0646\u0627 \u0627\u0644\u0643\u0631\u064a\u0645";
		}
		if (
			/^(?:\u0623\u0633\u062a\u0627\u0630|\u0627\u0633\u062a\u0627\u0630|\u0623\u0633\u062a\u0627\u0630\u0629|\u0627\u0644\u0623\u0633\u062a\u0627\u0630|\u0627\u0644\u0623\u0633\u062a\u0627\u0630\u0629|\u0627\u0644\u0633\u064a\u062f|\u0627\u0644\u0633\u064a\u062f\u0629)\b/i.test(
				rawName
			)
		) {
			return rawName;
		}
		return `\u0623\u0633\u062a\u0627\u0630 ${rawName}`;
	}
	return rawName || "Guest";
}

function logStep(caseId, message, payload = {}) {
	console.log(`[aiagent] case=${caseId} ${message}`, payload);
}
async function sleep(ms) {
	return new Promise((r) => setTimeout(r, ms));
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

function humanHandoffReason(text = "") {
	const normalized = String(text || "").toLowerCase();
	if (
		/\b(cancel|cancellation|refund|void)\b/i.test(normalized) &&
		/\b(reservation|booking|room|stay|payment|deposit|it)\b/i.test(normalized)
	) {
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

function looksLikeGreetingOnly(text = "") {
	return /^(hi|hello|hey|hi there|hello there|good morning|good evening|السلام|مرحبا|اهلا|أهلا|hola|bonjour|salut|ہیلو|ہیلو there|नमस्ते)\b/i.test(
		String(text || "").trim()
	);
}

function greetingText(sc = {}, st = {}) {
	const name = st.slots?.name || firstNameOf(sc.displayName1 || "Guest");
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

function wantsPaymentHelp(text = "") {
	return /payment|pay|card|link|declined|not going through|failed|دفع|بطاقة|رابط|pago|paiement|ادائیگی/i.test(
		String(text || "")
	);
}

function wantsReservationHelp(text = "") {
	return /reservation|booking|confirmation|تأكيد|حجز|reserva|réservation|بکنگ|आरक्षण/i.test(
		String(text || "")
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
	const name = st.slots?.name || firstNameOf(sc.displayName1 || "Guest");
	const hotelName = toTitle(st.hotel?.hotelName || "the hotel");
	const roomName = roomTypeLabel(st.slots?.roomTypeKey || quote.room?.roomType);
	if (!quote.available) {
		return `${name}, I do not see priced availability for ${roomName} at ${hotelName} on those dates. I can check another hotel or date range.`;
	}
	return `${name}, ${roomName} at ${hotelName} is ${quote.totals.totalPriceWithCommission} ${cleanCurrency(
		quote.currency
	)} total for ${quote.nights} nights. Our support team can continue the reservation if you like.`;
}

function roomMatches(room = {}, roomTypeKey = "doubleRooms") {
	return (
		room &&
		room.activeRoom &&
		room.roomType === roomTypeKey &&
		Number(room.price?.basePrice || 0) > 0
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
			basePrice: room.price?.basePrice || 0,
			currency: hotel?.currency || "SAR",
		}));
}

function decisionWantsAlternativeHotels(decision = {}) {
	const scope = String(decision?.scope || "").toLowerCase();
	return ["alternative_hotels", "platform", "cross_hotel"].includes(scope);
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
	const instruction = roomTypeKey
		? matchingRooms.length
			? `The guest is asking whether the selected hotel has the requested room type. Answer only for "${hotelName}". Say that this hotel has matching active room options, mention up to two provided matching room names if helpful, and ask for check-in and checkout dates if they are missing. Do not mention or link other hotels unless the guest explicitly asks for alternatives.`
			: `The guest is asking whether the selected hotel has the requested room type. Answer only for "${hotelName}". Say you do not currently see that room type listed as active for this hotel. Ask one helpful follow-up about another room type at this hotel or whether they want nearby alternatives. Do not list other hotels yet.`
		: `The guest is asking about rooms at the selected hotel. Answer only for "${hotelName}" using the provided active room options, then ask the single most useful next booking question. Do not mention or link other hotels unless the guest explicitly asks for alternatives.`;
	const reply = await write(io, sc, st, instruction, {
		latestUserMessage: userText,
		selectedHotel: hotelName,
		requestedRoomTypeKey: roomTypeKey,
		matchingRooms: matchingRooms.slice(0, 3),
		activeRoomOptions: activeRooms,
		slots: st.slots,
	});
	if (roomTypeKey) st.slots.roomTypeKey = roomTypeKey;
	await humanSend(io, sc, st, reply);
	st.waitFor = roomTypeKey && matchingRooms.length ? "dates" : "room";
}

async function buildHotelRecommendations({
	text,
	sc,
	st,
	requestedRoomTypeKey = null,
}) {
	const roomTypeKey = /triple|ثلاث|triple/i.test(text)
		? "tripleRooms"
		: /quad|رباع|quad/i.test(text)
		? "quadRooms"
		: "doubleRooms";
	const selectedRoomTypeKey = requestedRoomTypeKey || roomTypeKey;
	const hotels = await listActivePublicHotels();
	const matches = hotels
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
			latestUserMessage: text,
		}
	);

	const name = st.slots?.name || firstNameOf(sc.displayName1 || "Guest");
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

const memo = new Map();

/* per case state incl. queue & preemption */
function ensureState(sc, hotel) {
	const id = String(sc._id);
	let st = memo.get(id);
	if (!st) {
		const agentPool = configuredAgentPool();
		st = {
			hotel,
			agentName:
				sc.aiResponderName ||
				agentPool[Math.floor(Math.random() * agentPool.length)],
			language: preferredLanguageOf(sc) || "English",
			languageCode: preferredLanguageCodeOf(sc) || "",
			languageOverrideAt: 0,
			greeted: false,
			greetScheduled: false,
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
			dateRaw: { calendar: null, checkin: null, checkout: null },
			smalltalkThread: { topic: null, waitingForGuest: false, lastAt: 0 },
			slots: {
				checkinISO: null,
				checkoutISO: null,
				roomTypeKey: null,
				name: firstNameOf(sc.displayName1 || sc.customerName || "Guest"),
				fullName: null,
				nationality: null,
				phone: null,
				email: null,
				rooms: 1,
			},
		};
		memo.set(id, st);
	} else {
		if (hotel) st.hotel = hotel;
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
async function humanSend(io, sc, st, text, { first = false } = {}) {
	if (!text) return;
	const caseId = String(sc._id || sc.id || "unknown");

	const token = Math.random().toString(36).slice(2);
	st.sendingToken = token;
	if (st.interrupt) {
		logStep(caseId, "human.cancelled", { stage: "pre-send", token });
		return;
	}

	const think = first
		? HUMAN.greetThinkMs
		: randomBetween(HUMAN.thinkMinMs, HUMAN.thinkMaxMs);
	logStep(caseId, "human.delay.think", { ms: think, first });
	for (let t = 0; t < think; t += 150) {
		if (st.interrupt || st.sendingToken !== token) {
			logStep(caseId, "human.cancelled", { stage: "think", token });
			return;
		}
		while (st.guestTypingUntil > now()) await sleep(300);
		await sleep(150);
	}

	const charMs = randomBetween(HUMAN.typeCharMinMs, HUMAN.typeCharMaxMs);
	let typeMs = Math.min(
		HUMAN.typeClampMaxMs,
		Math.max(HUMAN.typeClampMinMs, (text || "").length * charMs)
	);
	logStep(caseId, "human.delay.type", {
		chars: (text || "").length,
		charMs,
		typeMs,
	});
	while (st.guestTypingUntil > now()) await sleep(300);
	emitTyping(io, caseId, st, true);
	for (let t = 0; t < typeMs; t += 120) {
		if (st.interrupt || st.sendingToken !== token) {
			emitTyping(io, caseId, st, false);
			logStep(caseId, "human.cancelled", { stage: "typing", token });
			return;
		}
		await sleep(120);
	}
	emitTyping(io, caseId, st, false);
	if (st.interrupt || st.sendingToken !== token) {
		logStep(caseId, "human.cancelled", { stage: "post-type", token });
		return;
	}

	if (st.lastBotText && st.lastBotText.trim() === String(text).trim()) {
		logStep(caseId, "dedupe.skip", { reason: "same_as_last" });
		return;
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
			return;
		}
	} catch (error) {
		logStep(caseId, "human.cancelled", {
			stage: "policy-check-failed",
			message: error?.message || error,
		});
		return;
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
	await updateSupportCaseAppend(caseId, {
		conversation: messageData,
		aiRelated: true,
	});
	io.to(caseId).emit("receiveMessage", { ...messageData, caseId });

	st.lastBotText = text;
}

/* soft‑pivot memory */
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

function nextPivot(st) {
	if (st.waitFor === "intentConfirm") return "intentConfirm";
	if (!st.slots.checkinISO || !st.slots.checkoutISO) return "dates";
	if (!st.slots.roomTypeKey) return "room";
	if (!st.reviewSent) return "proceed";
	if (!st.slots.fullName) return "fullname";
	if (!st.slots.nationality) return "nationality";
	if (!st.slots.phone) return "phone";
	if (!st.slots.email) return "email_or_skip";
	return "finalize";
}

function confirmsText(text = "") {
	const raw = String(text || "");
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

function lastUserText(sc) {
	const convo = Array.isArray(sc.conversation) ? sc.conversation : [];
	const lastUser = [...convo]
		.reverse()
		.find((m) => {
			if (!m?.message || !m?.messageBy || isAiConversationMessage(m)) return false;
			const text = String(m.message || "");
			return !/support specialist is reviewing|representative will be with you/i.test(
				text
			);
		});
	return lastUser?.message || "";
}

function recentConversationLines(sc = {}, st = {}) {
	const conversation = Array.isArray(sc.conversation) ? sc.conversation : [];
	const aiSender = st?.hotel?.hotelName
		? `${toTitle(st.hotel.hotelName)} support`
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
		const text = String(conversation[i]?.message || "");
		const match = text.match(/\b[A-Z]{1,6}[A-Z0-9-]{3,20}\b/i);
		if (match) return match[0].toUpperCase();
	}
	return null;
}

async function handoffToHuman(io, sc, st, reason) {
	const caseId = String(sc._id);
	const lang = languageOf(sc, st);
	const hotelName = st.hotel?.hotelName ? toTitle(st.hotel.hotelName) : "";
	const humanTeam = hotelName
		? `the ${hotelName} support team`
		: "the Jannat Booking support team";
	let text =
		reason === "reservation_cancellation"
			? `I understand you want to cancel a reservation. ${humanTeam} will take over from here, because cancellations must be handled by a human specialist.`
			: reason === "reservation_finalize_failed"
			? `I could not finalize this reservation automatically. ${humanTeam} will take over from here and review it right away.`
			: reason === "reservation_finalize"
			? `I have the booking details needed to continue. ${humanTeam} will take over from here to verify the reservation and payment details before final confirmation.`
			: `I understand you want to update an existing reservation. ${humanTeam} will take over from here so the change is reviewed correctly.`;
	if (/spanish/i.test(lang)) {
		text =
			reason === "reservation_cancellation"
				? "Entiendo que quieres cancelar una reserva. Un especialista de soporte tomara el chat desde aqui."
				: reason === "reservation_finalize_failed"
				? "No pude finalizar esta reserva automaticamente. Un especialista de soporte tomara el chat para revisarla enseguida."
				: "Entiendo tu solicitud de reserva. Un especialista de soporte tomara el chat para revisarla correctamente.";
	} else if (/french/i.test(lang)) {
		text =
			reason === "reservation_cancellation"
				? "Je comprends que vous voulez annuler une reservation. Un specialiste du support va prendre le relais ici."
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
			"Tell the guest their request will be handled by a human support specialist. Keep it one short sentence, use the active hotel support voice when hotel context exists, and do not ask another question.",
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
	const turns = Array.isArray(chat.conversation)
		? chat.conversation.slice(0, 8).map((turn) => ({
				role: turn.role || "unknown",
				speakerName: turn.speakerName || "",
				message: String(turn.message || "").slice(0, 260),
		  }))
		: [];
	return {
		title: chat.chatTitle || "",
		language: chat.language || "",
		keywords: Array.isArray(chat.chatKeywords)
			? chat.chatKeywords.slice(0, 10)
			: [],
		summary: chat.summary || "",
		customerIntent: chat.customerIntent || "",
		supportResolution: chat.supportResolution || "",
		learningNotes: Array.isArray(chat.learningNotes)
			? chat.learningNotes.slice(0, 6)
			: [],
		responseGuidance: Array.isArray(chat.responseGuidance)
			? chat.responseGuidance.slice(0, 6)
			: [],
		exampleTurns: turns,
	};
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
		const chats = await listRelevantTrainingChats({
			hotelId: sc.hotelId || st.hotel?._id || null,
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
	const supportDesk = hotelName ? `${hotelName} support` : "Jannat Booking support";
	const text = String(instruction || "").toLowerCase();
	const lang = languageOf(sc, st);
	const isArabic = /arabic/i.test(lang);
	const isSpanish = /spanish/i.test(lang);
	const isHindi = /hindi/i.test(lang);
	const isFrench = /french/i.test(lang);
	const isUrdu = /urdu/i.test(lang);
	if (context.fallbackText) {
		const fallbackText = String(context.fallbackText);
		if (!isArabic && !isSpanish && !isHindi && !isFrench && !isUrdu) {
			return fallbackText;
		}
		if (!/human|handoff|specialist|escalat|handled by/i.test(text)) {
			return fallbackText;
		}
	}
	if (context.quote) return simpleQuoteText({ sc, st, quote: context.quote });
	if (/greet/.test(text)) {
		if (isArabic) return `أهلاً ${respectfulAddress}، معك ${st.agentName} من ${supportDesk}. كيف أقدر أساعدك اليوم؟`;
		if (isSpanish) return `Hola ${respectfulAddress}, soy ${st.agentName} de ${supportDesk}. Como puedo ayudarte hoy?`;
		if (isHindi) return `नमस्ते ${respectfulAddress}, मैं ${supportDesk} से ${st.agentName} हूं। मैं आपकी कैसे मदद कर सकता हूं?`;
		if (isFrench) return `Bonjour ${respectfulAddress}, je suis ${st.agentName} de ${supportDesk}. Comment puis-je vous aider aujourd'hui ?`;
		if (isUrdu) return `السلام علیکم ${respectfulAddress}، میں ${supportDesk} سے ${st.agentName} ہوں۔ میں آپ کی کیسے مدد کر سکتا ہوں؟`;
		return `Hi ${respectfulAddress}, this is ${st.agentName} from ${supportDesk}. How can I help you today?`;
	}
	if (/date|check-in|check.?in|checkout|check-out/.test(text)) {
		if (isArabic) return `${respectfulAddress}، من فضلك أرسل تاريخ الدخول وتاريخ الخروج لأراجع التوفر.`;
		if (isSpanish) return `${respectfulAddress}, por favor enviame las fechas de check-in y check-out para revisar disponibilidad.`;
		if (isHindi) return `${respectfulAddress}, कृपया चेक-इन और चेक-आउट की तारीखें भेजें ताकि मैं उपलब्धता देख सकूं।`;
		if (isFrench) return `${respectfulAddress}, veuillez envoyer les dates d'arrivee et de depart pour que je verifie la disponibilite.`;
		if (isUrdu) return `${respectfulAddress}، براہ کرم چیک اِن اور چیک آؤٹ کی تاریخیں بھیجیں تاکہ میں دستیابی چیک کر سکوں۔`;
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
		return `${respectfulAddress}, I can help with the payment issue. Please send the confirmation number or payment link, but not card details.`;
	}
	if (/reservation|confirmation/.test(text)) {
		if (isArabic) return `${respectfulAddress}، من فضلك أرسل رقم التأكيد والتغيير المطلوب في الحجز.`;
		if (isSpanish) return `${respectfulAddress}, por favor enviame el numero de confirmacion y que cambio necesitas.`;
		if (isHindi) return `${respectfulAddress}, कृपया कन्फर्मेशन नंबर और बताएं कि आप क्या बदलना चाहते हैं।`;
		if (isFrench) return `${respectfulAddress}, veuillez envoyer le numero de confirmation et le changement souhaite.`;
		if (isUrdu) return `${respectfulAddress}، براہ کرم کنفرمیشن نمبر اور مطلوبہ تبدیلی بھیجیں۔`;
		return `${respectfulAddress}, please send the confirmation number and what you would like to update.`;
	}
	if (/human|handoff|specialist|escalat/.test(text)) {
		if (isArabic) return `${respectfulAddress}، سيتابع معك أحد مختصي الدعم من هنا.`;
		if (isSpanish) return `${respectfulAddress}, un especialista de soporte continuara contigo desde aqui.`;
		if (isHindi) return `${respectfulAddress}, अब हमारी सपोर्ट टीम का विशेषज्ञ आपकी मदद जारी रखेगा।`;
		if (isFrench) return `${respectfulAddress}, un specialiste du support va poursuivre avec vous ici.`;
		if (isUrdu) return `${respectfulAddress}، اب سپورٹ ٹیم کا ایک ماہر آپ کے ساتھ بات جاری رکھے گا۔`;
		return `${respectfulAddress}, a support specialist will continue with you from here.`;
	}
	if (isArabic) return `${respectfulAddress}، أقدر أساعدك. هل يمكنك إرسال تفاصيل أكثر؟`;
	if (isSpanish) return `${respectfulAddress}, puedo ayudarte con eso. Puedes enviarme un poco mas de detalle?`;
	if (isHindi) return `${respectfulAddress}, मैं इसमें मदद कर सकता हूं। कृपया थोड़ा और विवरण भेजें।`;
	if (isFrench) return `${respectfulAddress}, je peux vous aider. Pouvez-vous envoyer un peu plus de details ?`;
	if (isUrdu) return `${respectfulAddress}، میں مدد کر سکتا ہوں۔ براہ کرم تھوڑی مزید تفصیل بھیجیں۔`;
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
	return false;
}

/* LLM writer */
async function write(io, sc, st, instruction, context = {}) {
	const respectfulAddress = respectfulGuestName(sc, st);
	const hotelName = st.hotel?.hotelName ? toTitle(st.hotel.hotelName) : "";
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
	const introRule = hotelName
		? `For greetings and introductions, introduce yourself as ${st.agentName} from the ${hotelName} support and reservation desk. Do not introduce yourself as Jannat Booking or XHotelPro.`
		: `For greetings and introductions, introduce yourself as ${st.agentName} from Jannat Booking support.`;
	const aiIdentityRule = hotelName
		? `If asked directly whether you are AI, say you are AI-assisted ${hotelName} support monitored by the support team; do not claim to be human.`
		: `If asked directly whether you are AI, say you are AI-assisted Jannat Booking support monitored by Jannat Booking admins; do not claim to be human.`;
	const sys = [
		hotelName
			? `You are ${st.agentName}, the support and reservation assistant for "${hotelName}".`
			: `You are ${st.agentName} from Jannat Booking support.`,
		introRule,
		`If Jannat Booking must be named, write the brand exactly as "Jannat Booking"; do not translate or shorten it.`,
		aiIdentityRule,
		hotelName
			? `Speak as the hotel's own support desk. Do not present Jannat Booking as a separate middleman; use Jannat Booking only when the brand, platform, payment, or final verification must be named.`
			: `Represent Jannat Booking directly.`,
		`The guest's active response language is ${targetLanguageText}. This may override the frontend preferred language when the latest guest message is clearly in another language.`,
		`STRICT LANGUAGE RULE: Every customer-facing word in your final answer must be in ${targetLanguage}.`,
		`Training examples may be Arabic, Hindi, English, Spanish, French, Urdu, or another language. Use them only as private behavioral guidance; translate or adapt the lesson silently into ${targetLanguage}.`,
		`Do not copy an employee learning example in its original language unless that original language is also ${targetLanguage}.`,
		`Tone: concise, friendly, official, respectful, and human-like. One booking question at a time.`,
		`Use this respectful customer address naturally when speaking to the guest: ${respectfulAddress}.`,
		`Guest messages may be native script, romanized/transliterated, code-switched, misspelled, or informal. Interpret the intended meaning from the full conversation before replying.`,
		`Arabic guests may write in Egyptian, Gulf, Levantine, Iraqi, Sudanese, Moroccan, Algerian, Tunisian, or other dialects, including Franko Arabic/Arabizi in Latin characters. Indian, Pakistani, French, and Spanish guests may also code-switch or write phonetically. Understand the meaning without treating the writing style as a reason to escalate.`,
		`If the latest guest message is clearly in a different language, the active response language already reflects that switch; answer naturally in ${targetLanguage} without asking permission to switch.`,
		`For Arabic conversations, address the guest professionally as "\u0623\u0633\u062a\u0627\u0630 {first name}" when the name is known, such as "\u0623\u0633\u062a\u0627\u0630 \u0646\u0627\u0635\u0631"; keep it warm, not stiff.`,
		`Before replying, study the full conversation transcript and avoid repeating questions, links, or details already covered.`,
		`Do not ask for information the guest has already supplied; move the conversation forward naturally.`,
		hotelName ? `Your hotel is "${hotelName}".` : `You represent Jannat Booking.`,
		`Private previous guest chats may be provided as operational context. Use them silently to be prepared for recurring preferences, unresolved issues, language style, and continuity.`,
		`Never tell the guest that old chats are visible, never quote old chats, and never reveal private previous-chat details unless the guest explicitly brings that detail into the current conversation.`,
		hotelName
			? `When the guest asks whether "you", "your hotel", or the selected hotel has something, answer only for "${hotelName}". Do not recommend or link other hotels unless the guest explicitly asks for alternatives.`
			: `When no active hotel context exists, you may recommend Jannat Booking hotel options using provided facts.`,
		`Use employee learning examples as private guidance for tone, flow, and support behavior. Never mention the learning examples to the guest.`,
		`Help with date-range hotel pricing, hotel options near Al Haram, payment questions, and reservation triage.`,
		`Use only known Jannat Booking routes or URLs supplied in context. For hotel recommendations, prefer concise markdown links using the hotel name as the link text. Never invent routes, payment links, reservation links, or admin/PMS links.`,
		`Do not cancel, refund, or mutate existing reservations; send those requests to a human team member.`,
		`Avoid repeating the same question if just asked; prefer a soft pivot.`,
	].join(" ");

	const payload = JSON.stringify(
		{
			...context,
			targetResponseLanguage: targetLanguageText,
			respectfulAddress,
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
	if (wantsPaymentHelp(userText)) {
		return { action: "payment_help", roomTypeKey: null, reason: "payment_keyword" };
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
	const [previousGuestContext, learningContext] = await Promise.all([
		loadPreviousGuestContext(sc, st),
		loadLearningContext(
			sc,
			st,
			"Decide the next support action. Use relevant employee learning examples before choosing escalation.",
			{ latestUserMessage: userText, nlu: lu || null }
		),
	]);
	const hotelSummary = st.hotel
		? {
				hotelName: st.hotel.hotelName,
				activeRooms: (st.hotel.roomCountDetails || [])
					.filter((room) => room.activeRoom)
					.map((room) => ({
						roomType: room.roomType,
						displayName: room.displayName || room.roomType,
						basePrice: room.price?.basePrice || 0,
					}))
					.slice(0, 12),
		  }
		: null;
	const sys = [
		"You are the hotel support chat orchestrator.",
		"Read the whole conversation and decide the next support action before any answer is written.",
		"Use all available context to avoid redundancy and to keep the chat natural in any language.",
		"Guest text may be native script, romanized/transliterated, code-switched, misspelled, or informal. Infer the intended meaning from phonetics and context instead of exact spellings.",
		"Arabic may appear as Egyptian, Gulf, Levantine, Iraqi, Sudanese, Moroccan, Algerian, Tunisian, Franko Arabic, or Arabizi. Indian and Pakistani guests may use Hinglish, Urdu/Hindi in Latin characters, or mixed scripts. Do not escalate only because the writing style is unusual.",
		"Private previous guest chats may be provided. Use them only to prepare the next action; never choose an action that would disclose that history to the guest.",
		"Employee learning examples may be provided. Before choosing human_escalation, check whether those examples contain a reusable resolution or safe next step for this kind of question.",
		"Return ONLY valid JSON with this shape:",
		"{ action:'hotel_recommendation'|'ask_dates_for_price'|'payment_help'|'reservation_update'|'reservation_cancellation'|'reservation_lookup'|'amenity_question'|'continue_booking'|'smalltalk'|'human_escalation'|'other',",
		"roomTypeKey:null|'singleRooms'|'doubleRooms'|'tripleRooms'|'quadRooms'|'familyRooms', scope:null|'selected_hotel'|'alternative_hotels'|'platform', reason:string }",
		"Use the guest's latest message, the full chat transcript, and current slots. Do not write the customer-facing reply.",
		"If an active hotel is present and the guest asks whether you/this hotel has rooms, room types, amenities, availability, or pricing, keep scope:'selected_hotel' and do not choose hotel_recommendation.",
		"Choose hotel_recommendation only when the guest asks for other hotels, nearby alternatives, general platform options, or there is no active hotel context.",
		"If check-in and checkout dates are already present in currentSlots or nlu, never choose ask_dates_for_price; choose continue_booking for price or availability.",
		"Choose human_escalation only when the request is outside hotel/platform support scope, needs facts/tools not available in context or learning examples, asks to cancel/refund/mutate an existing reservation, or should be reviewed by a person before answering.",
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
	const quoteReply = await write(
		io,
		sc,
		st,
		"Share the availability and price result from the quote context. If the guest provided Hijri dates, mention the Hijri range and the matching Gregorian range. If unavailable, offer another date range or room type. If available, ask one concise follow-up about whether to continue.",
		{ quote, dates: stayDateDisplay(st) }
	);
	await humanSend(io, sc, st, quoteReply);
	st.waitFor = "proceed";
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
		const softPivot = askedRecently(st, pivot);
		const instr = softPivot
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
				"Reply briefly to their casual line, then ask for check‑in and check‑out in ONE question."
			);
			await humanSend(io, sc, st, msg);
			stampAsk(st, "dates");
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
	const hotel = policy.hotel || (await getHotelById(sc.hotelId));
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

	try {
		logStep(caseId, "context.loaded", {
			hotelId: sc.hotelId,
			hotelName: st.hotel?.hotelName || null,
			language: st.language,
			waitFor: st.waitFor,
			slots: st.slots,
		});

		const userText = lastUserText(sc);
		updateActiveLanguageFromText(sc, st, userText);
		if (!userText) {
			if (!hasAiAssistantReply(sc) && !st.greeted && !st.greetScheduled) {
				st.greetScheduled = true;
				st.greeted = true;
				const initialInquiry = [sc.inquiryAbout, sc.inquiryDetails]
					.filter(Boolean)
					.join("\n")
					.trim();
				const greeting = await write(
					io,
					sc,
					st,
					initialInquiry
						? "The guest has just opened chat. Use the initial inquiry details as context, greet them by first name, introduce yourself as the active hotel support and reservation assistant when hotel context exists, then ask one helpful next question. Keep it short."
						: "The guest has just opened chat but has not typed a message yet. Greet them by first name, introduce yourself as the active hotel support and reservation assistant when hotel context exists, and ask how you can help today. Keep it one short line.",
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
				const greeting = await write(
					io,
					sc,
					st,
					"Greet the guest by first name, introduce yourself as the active hotel support and reservation assistant when hotel context exists, and ask how you can help today. Keep it one short line.",
					{ latestUserMessage: userText }
				);
				await humanSend(io, sc, st, greeting, { first: true });
				st.waitFor = "clarify";
				return;
			}
		}

		// Legacy greeting branch is skipped after the first real customer turn.
		if (!st.greeted && !st.greetScheduled) {
			st.greetScheduled = true;
			st.waitFor = "intentConfirm";
			const greetOwner = st.hotel?.hotelName
				? `the ${toTitle(st.hotel.hotelName)} support desk`
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

		const readyToQuoteFromNlu =
			st.slots.checkinISO &&
			st.slots.checkoutISO &&
			st.slots.roomTypeKey &&
			/\b(book|reserve|price|rate|availability|available|room|stay|double|triple|quad)\b/i.test(
				userText
			) &&
			!humanHandoffReason(userText) &&
			!wantsPaymentHelp(userText) &&
			!wantsReservationHelp(userText);
		if (readyToQuoteFromNlu) {
			logStep(caseId, "nlu.direct_quote", {
				checkinISO: st.slots.checkinISO,
				checkoutISO: st.slots.checkoutISO,
				roomTypeKey: st.slots.roomTypeKey,
			});
			await shareKnownStayQuote(io, sc, st);
			return;
		}

		const supportDecision = await decideSupportAction({
			sc,
			st,
			userText,
			lu: decisionLu,
		});
		logStep(caseId, "orchestrator.decision", supportDecision);

		if (supportDecision.roomTypeKey) {
			st.slots.roomTypeKey = supportDecision.roomTypeKey;
		}

		if (supportDecision.action === "reservation_cancellation") {
			await handoffToHuman(io, sc, st, "reservation_cancellation");
			return;
		}

		if (supportDecision.action === "reservation_update") {
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
			if (st.hotel && !decisionWantsAlternativeHotels(supportDecision)) {
				await answerSelectedHotelRoomQuestion(
					io,
					sc,
					st,
					userText,
					roomTypeKey
				);
				return;
			}
			const recommendationRoomTypeKey = roomTypeKey || "doubleRooms";
			const reply = await buildHotelRecommendations({
				text: userText,
				sc,
				st,
				requestedRoomTypeKey: recommendationRoomTypeKey,
			});
			st.slots.roomTypeKey = recommendationRoomTypeKey;
			await humanSend(io, sc, st, reply);
			st.waitFor = "dates";
			return;
		}

		if (
			(supportDecision.action === "ask_dates_for_price" ||
				supportDecision.action === "continue_booking") &&
			st.slots.checkinISO &&
			st.slots.checkoutISO &&
			st.slots.roomTypeKey
		) {
			await shareKnownStayQuote(io, sc, st);
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
			const reply = await write(
				io,
				sc,
				st,
				"The guest is asking about an existing reservation. Ask for the confirmation number and one sentence about what they need. Keep it concise.",
				{ latestUserMessage: userText }
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
			await handoffToHuman(io, sc, st, handoffReason);
			return;
		}
		if (wantsHotelRecommendation(userText)) {
			if (st.hotel) {
				await answerSelectedHotelRoomQuestion(
					io,
					sc,
					st,
					userText,
					decisionLu.roomTypeKey || st.slots.roomTypeKey || null
				);
				return;
			}
			const reply = await buildHotelRecommendations({ text: userText, sc, st });
			st.slots.roomTypeKey = /triple|ثلاث|triple/i.test(userText)
				? "tripleRooms"
				: /quad|رباع|quad/i.test(userText)
				? "quadRooms"
				: "doubleRooms";
			await humanSend(io, sc, st, reply);
			st.waitFor = "dates";
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
		if (wantsReservationHelp(userText)) {
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
		if (
			dateRange.checkinISO &&
			dateRange.checkoutISO &&
			st.slots.roomTypeKey
		) {
			st.slots.checkinISO = dateRange.checkinISO;
			st.slots.checkoutISO = dateRange.checkoutISO;
			await shareKnownStayQuote(io, sc, st);
			return;
		}
		const lu = await nluStep({
			sc,
			hotel: st.hotel,
			lastUserMessage: userText,
		});
		logStep(caseId, "nlu", lu);

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
						? "Explain that this room is blocked (zero price rule) for these dates. Offer up to 3 alternatives with totals."
						: "Explain no priced inventory for these dates; offer up to 3 alternatives with totals.",
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
			const quoteMsg = await write(
				io,
				sc,
				st,
				"Share a concise availability & price summary (no upsell). If the guest provided Hijri dates, include the Hijri range and matching Gregorian range. Then ask a single yes/no: proceed to confirm?",
				display
			);
			await humanSend(io, sc, st, quoteMsg);
			st.quoteSummarizedAt = now();
		}
		st.waitFor = "proceed";

		// proceed?
		if (st.waitFor === "proceed") {
			if (confirmsText(userText)) {
				const q = st.quote?.data || quote;
				const reviewPayload = {
					hotel: toTitle(st.hotel?.hotelName || "Hotel"),
					room: q.room?.displayName || q.room?.roomType || st.slots.roomTypeKey,
					roomsCount: st.slots.rooms || 1,
					currency: q.currency,
					nights: q.nights,
					totals: q.totals,
					perNightAvg:
						Math.round(
							(q.totals.totalPriceWithCommission / Math.max(1, q.nights)) * 100
						) / 100,
					gregorian: {
						checkin: usDate(st.slots.checkinISO),
						checkout: usDate(st.slots.checkoutISO),
					},
					dateDisplay: stayDateDisplay(st),
					rawDates: st.dateRaw,
				};
				logStep(caseId, "review.summaryBuilt", reviewPayload);
				const reviewText = await write(
					io,
					sc,
					st,
					"Present a brief 'Review before we finalize'. If raw dates were Hijri, show them alongside Gregorian. End with: 'Type confirm to finalize, or tell me what to change.'",
					reviewPayload
				);
				await humanSend(io, sc, st, reviewText);
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
				const reviewPayload = {
					hotel: toTitle(st.hotel?.hotelName || "Hotel"),
					room: q.room?.displayName || q.room?.roomType || st.slots.roomTypeKey,
					roomsCount: st.slots.rooms || 1,
					currency: q.currency,
					nights: q.nights,
					totals: q.totals,
					perNightAvg:
						Math.round(
							(q.totals.totalPriceWithCommission / Math.max(1, q.nights)) * 100
						) / 100,
					gregorian: {
						checkin: usDate(st.slots.checkinISO),
						checkout: usDate(st.slots.checkoutISO),
					},
					dateDisplay: stayDateDisplay(st),
					rawDates: st.dateRaw,
				};
				logStep(caseId, "review.summaryBuilt", reviewPayload);
				const reviewText = await write(
					io,
					sc,
					st,
					"Present a brief 'Review before we finalize'. If raw dates were Hijri, show them alongside Gregorian. End with: 'Type “confirm” to finalize, or tell me what to change.'",
					reviewPayload
				);
				await humanSend(io, sc, st, reviewText);
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
					await humanSend(io, sc, st, poke);
					stampAsk(st, "proceed");
				}
				return;
			}
		}

		// After review: collect details (full name → nationality → phone → email)
		if (
			[
				"reviewConfirm",
				"fullname",
				"nationality",
				"phone",
				"email_or_skip",
				"finalize",
			].includes(st.waitFor)
		) {
			if (st.waitFor === "reviewConfirm") {
				if (!confirmsText(userText)) return;
				st.waitFor = "fullname";
				const prompt = await write(
					io,
					sc,
					st,
					"Ask ONE question: 'Is the reservation under your full name as in passport? Please type the full name in English.'"
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
						"Ask ONE question: 'What is the guest's nationality?' Ask for the country/nationality name in English."
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
						"Ask ONE question for a reachable phone number. WhatsApp is preferred, but do not make it mandatory."
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
						"Ask ONE question for an email address. If they prefer not to share it, tell them they can type skip."
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

			if (st.waitFor === "email_or_skip" && !st.slots.email) {
				const txt = String(userText).trim();
				if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(txt)) {
					st.slots.email = txt;
					logStep(caseId, "email.captured", { email: st.slots.email });
				} else if (
					/\b(no|skip|don'?t have|later|none|لا|تخطي|مش موجود)\b/i.test(txt)
				) {
					st.slots.email = "";
					logStep(caseId, "email.skipped", {});
				} else {
					const ask = await write(
						io,
						sc,
						st,
						"If that does not look like an email, ask once more briefly and say they can type 'skip' if they prefer."
					);
					await humanSend(io, sc, st, ask);
					stampAsk(st, "email_or_skip");
					return;
				}
				st.waitFor = "finalize";
			}

			if (st.waitFor === "finalize") {
				try {
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
						return;
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
					const publicBase = String(
						process.env.CLIENT_URL ||
							process.env.REACT_APP_MAIN_URL_JANNAT ||
							"https://jannatbooking.com"
					).replace(/\/+$/, "");
					const links = {
						reservationDetails: `${publicBase}/single-reservations/${reservation.confirmation_number}`,
						payment: `${publicBase}/client-payment/${reservation._id}/${reservation.confirmation_number}`,
					};
					const finalText = await write(
						io,
						sc,
						st,
						"Tell the guest the reservation has been created and is pending hotel confirmation internally, while keeping the message guest-friendly. Include the confirmation number, total, reservation details link, and payment link exactly from context. Keep it concise.",
						{
							reservation: {
								id: String(reservation._id),
								confirmation: reservation.confirmation_number,
								total: reservation.total_amount,
								currency: quoteForCreate.currency || "SAR",
								hotel: st.hotel?.hotelName || "",
								room:
									quoteForCreate.room?.displayName ||
									quoteForCreate.room?.roomType ||
									st.slots.roomTypeKey,
								dates: stayDateDisplay(st),
								links,
							},
						}
					);
					await humanSend(io, sc, st, finalText);
					st.waitFor = null;
					st.reviewSent = false;
					st.quoteSummarizedAt = 0;
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
				"Ask ONE question: 'Is the reservation under your full name (as in passport)? If yes, please type your full name in English. If for someone else, share their full name in English.'"
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
				"Ask ONE question: 'What is the guest's nationality?' (English name)."
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
				"Ask ONE question for a phone number (WhatsApp preferred, but not mandatory)."
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

		if (st.waitFor === "email_or_skip" && !st.slots.email) {
			const askEmail = await write(
				io,
				sc,
				st,
				"Ask ONE question for an email address (do NOT say optional). If they resist, accept continuing without email."
			);
			await humanSend(io, sc, st, askEmail);
			return;
		}
		if (!st.slots.email && st.waitFor === "email_or_skip") {
			const txt = String(userText).trim();
			if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(txt)) {
				st.slots.email = txt;
				logStep(caseId, "email.captured", { email: st.slots.email });
			} else if (/\b(no|skip|don'?t have|later)\b/i.test(txt)) {
				st.slots.email = null;
			} else {
				const ask = await write(
					io,
					sc,
					st,
					"If that doesn't look like an email, ask once more briefly; accept 'skip' if they prefer."
				);
				await humanSend(io, sc, st, ask);
				return;
			}
			st.waitFor = "finalize";
		}

		// Final reservation commits stay with a human support team member.
		if (st.waitFor === "finalize") {
			await handoffToHuman(io, sc, st, "reservation_finalize");
			return;
		}
	} catch (e) {
		logStep(caseId, "error", { message: e?.message || e });
	} finally {
		const st2 = memo.get(caseId);
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
				const hotel = policy.hotel || (await getHotelById(sc.hotelId));
				const st = ensureState(sc, hotel);
				logStep(caseId, "joined_room", {
					hotelId: sc.hotelId,
					hotelName: st.hotel?.hotelName,
				});

				if (!st.greeted && !st.greetScheduled) planTurn(io, sc);
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
				const sc = await getSupportCaseById(caseId);
				if (!sc) return;
				await planTurn(io, sc);
			} catch (e) {
				console.error("[aiagent] sendMessage plan error:", e?.message || e);
			}
		});
	});

	console.log("[aiagent] socket-driven AI planner active.");
}

module.exports = { wireSocket };
