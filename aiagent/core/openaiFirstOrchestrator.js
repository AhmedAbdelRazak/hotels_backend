// aiagent/core/openaiFirstOrchestrator.js
// OpenAI-first B2C chat engine. The legacy rule-heavy engine remains in
// orchestrator.js and can be restored with AI_AGENT_ENGINE=legacy.
const {
	getSupportCaseById,
	updateSupportCaseAppendIfNoRecentAiDuplicate,
	getHotelByIdForAiContext,
	getHotelByIdWithPricingDates,
	getReservationByConfirmation,
} = require("./db");
const { ensureAIAllowed } = require("./policy");
const { chat } = require("./openai");
const { priceRoomForStay } = require("./selectors");
const {
	createReservationForCase,
	dispatchAiReservationConfirmation,
} = require("./actions");
const {
	activeHotelPolicyQA,
	DEFAULT_CANCELLATION_REFUND_ANSWER,
} = require("../../services/hotelPolicyQa");
const {
	shouldCountReservationForInventory,
} = require("../../services/reservationStatus");
const Reservations = require("../../models/reservations");

const SUPPORT_EMAIL = "support@jannatbooking.com";
const AI_USER_ID = "jannat-ai-support";

const DEFAULT_AGENT_POOL = [
	"Aisha",
	"Fatima",
	"Khadija",
	"Maryam",
	"Hafsa",
	"Zainab",
	"Ruqayya",
	"Asma",
	"Sumayya",
	"Safiya",
	"Huda",
	"Noor",
	"Iman",
	"Aya",
	"Sara",
	"Hana",
	"Nadia",
	"Amira",
	"Yasmin",
	"Layla",
	"Salma",
	"Lina",
	"Mona",
	"Samira",
	"Rania",
];

function intFromEnv(name, fallback, { min = 0, max = 60000 } = {}) {
	const parsed = parseInt(process.env[name] || "", 10);
	const value = Number.isFinite(parsed) ? parsed : fallback;
	return Math.min(max, Math.max(min, value));
}

const QUIET_MS = intFromEnv("AI_OPENAI_FIRST_QUIET_MS", 2000, {
	min: 500,
	max: 5000,
});
const GUEST_TYPING_HOLD_MS = intFromEnv("AI_OPENAI_FIRST_TYPING_HOLD_MS", 2000, {
	min: 500,
	max: 5000,
});
const TARGET_REPLY_MIN_MS = intFromEnv("AI_OPENAI_FIRST_TARGET_MIN_MS", 3800, {
	min: 1500,
	max: 10000,
});
const TARGET_REPLY_MAX_MS = Math.max(
	TARGET_REPLY_MIN_MS,
	intFromEnv("AI_OPENAI_FIRST_TARGET_MAX_MS", 6200, {
		min: 1500,
		max: 10000,
	})
);
const MAX_TOTAL_WAIT_MS = intFromEnv("AI_OPENAI_FIRST_MAX_TOTAL_MS", 10000, {
	min: 4000,
	max: 15000,
});
const COMPOSE_DEADLINE_MS = intFromEnv("AI_OPENAI_FIRST_COMPOSE_TIMEOUT_MS", 8500, {
	min: 2500,
	max: 12000,
});
const MAX_CONVERSATION_TURNS = intFromEnv("AI_OPENAI_FIRST_CONTEXT_TURNS", 60, {
	min: 12,
	max: 120,
});
const OPENAI_FIRST_WRITER_KIND =
	String(process.env.AI_OPENAI_FIRST_WRITER_KIND || "nlu").trim() || "nlu";
const CONFIRMATION_DISPATCH_DELAY_MS = intFromEnv(
	"AI_OPENAI_FIRST_CONFIRMATION_DISPATCH_DELAY_MS",
	1000,
	{ min: 0, max: 30000 }
);
const RESERVATION_INVENTORY_SELECT = [
	"_id",
	"checkin_date",
	"checkout_date",
	"reservation_status",
	"state",
	"pendingConfirmation.status",
	"pendingConfirmation.inventoryBlocks",
	"agentDecisionSnapshot.status",
	"pickedRoomsType.room_type",
	"pickedRoomsType.roomType",
	"pickedRoomsType.displayName",
	"pickedRoomsType.display_name",
	"pickedRoomsType.count",
	"pickedRoomsPricing.room_type",
	"pickedRoomsPricing.roomType",
	"pickedRoomsPricing.displayName",
	"pickedRoomsPricing.display_name",
	"pickedRoomsPricing.count",
].join(" ");

const scheduledTurns = new Map();
const activeTurns = new Map();
const guestActivity = new Map();

function now() {
	return Date.now();
}

function openAiFirstMemoryDebugEnabled() {
	return (
		String(process.env.AI_OPENAI_FIRST_MEMORY_DEBUG || "")
			.trim()
			.toLowerCase() === "true"
	);
}

function memoryTrace(label, caseId = "", extra = {}) {
	if (!openAiFirstMemoryDebugEnabled()) return;
	const usage = process.memoryUsage();
	console.log("[aiagent:openai-first:mem]", {
		label,
		caseId: idText(caseId),
		rssMB: Math.round(usage.rss / 1024 / 1024),
		heapUsedMB: Math.round(usage.heapUsed / 1024 / 1024),
		heapTotalMB: Math.round(usage.heapTotal / 1024 / 1024),
		externalMB: Math.round(usage.external / 1024 / 1024),
		arrayBuffersMB: Math.round((usage.arrayBuffers || 0) / 1024 / 1024),
		...extra,
	});
}

function sleep(ms = 0) {
	return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms || 0)));
}

function withTimeout(promise, timeoutMs, label = "operation") {
	let timer = null;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => {
			reject(new Error(`${label} timed out after ${timeoutMs}ms`));
		}, Math.max(1, Number(timeoutMs) || 1));
	});
	return Promise.race([promise, timeout]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

function randomBetween(min, max) {
	if (max <= min) return min;
	return min + Math.floor(Math.random() * (max - min + 1));
}

function idText(value) {
	if (!value) return "";
	if (typeof value === "object" && value._id) return String(value._id);
	return String(value);
}

function cleanText(value = "", max = 2000) {
	return String(value || "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, max);
}

function clipList(list = [], max = 16) {
	return Array.isArray(list) ? list.filter(Boolean).slice(0, max) : [];
}

function normalizeEmail(value = "") {
	return String(value || "").trim().toLowerCase();
}

function isSupportIdentity(entry = {}) {
	const by = entry.messageBy || {};
	const email = normalizeEmail(by.customerEmail);
	const userId = String(by.userId || "").trim();
	return (
		entry.isAi === true ||
		userId === AI_USER_ID ||
		email === SUPPORT_EMAIL ||
		email === "management@xhotelpro.com"
	);
}

function isGuestEntry(entry = {}) {
	return Boolean(entry && !entry.isSystem && !isSupportIdentity(entry));
}

function latestGuestMessage(sc = {}) {
	const conversation = Array.isArray(sc.conversation) ? sc.conversation : [];
	for (let i = conversation.length - 1; i >= 0; i -= 1) {
		if (isGuestEntry(conversation[i])) return conversation[i];
	}
	return null;
}

function lastAiMessage(sc = {}) {
	const conversation = Array.isArray(sc.conversation) ? sc.conversation : [];
	for (let i = conversation.length - 1; i >= 0; i -= 1) {
		if (isSupportIdentity(conversation[i]) && !conversation[i].isSystem) {
			return conversation[i];
		}
	}
	return null;
}

function hasAiMessage(sc = {}) {
	return Boolean(lastAiMessage(sc));
}

function entryTime(entry = {}) {
	const value = new Date(entry.date || 0).getTime();
	return Number.isFinite(value) ? value : 0;
}

function hasAiAfter(sc = {}, sinceMs = 0) {
	const conversation = Array.isArray(sc.conversation) ? sc.conversation : [];
	return conversation.some(
		(entry) => isSupportIdentity(entry) && !entry.isSystem && entryTime(entry) > sinceMs
	);
}

function latestGuestNeedsAiReply(sc = {}) {
	const latest = latestGuestMessage(sc);
	if (!latest) return false;
	const latestAt = entryTime(latest);
	return !hasAiAfter(sc, latestAt);
}

function lastGuestAction(sc = {}) {
	return String(latestGuestMessage(sc)?.clientAction || "").trim();
}

function configuredAgentPool() {
	const configured = [
		process.env.B2C_AI_RESPONDER_NAMES,
		process.env.AI_RESPONDER_NAMES,
	]
		.flatMap((value) => String(value || "").split(","))
		.map((name) => cleanText(name, 60))
		.filter(Boolean);
	const unique = [...new Set(configured)];
	return unique.length >= 2 ? unique : DEFAULT_AGENT_POOL;
}

function stableIndex(seed = "", length = 1) {
	let hash = 0;
	for (const char of String(seed || "")) {
		hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
	}
	return hash % Math.max(1, length);
}

function agentNameForCase(sc = {}) {
	const existing = cleanText(sc.aiResponderName, 80);
	if (existing) return existing;
	const pool = configuredAgentPool();
	return pool[stableIndex(idText(sc), pool.length)] || "Aisha";
}

function emitTyping(io, caseId, agentName, on = true) {
	if (!io || !caseId) return;
	io.to(caseId).emit(on ? "typing" : "stopTyping", {
		caseId,
		isAi: true,
		name: agentName || "Aisha",
	});
}

function emitCaseUpdate(io, caseId, updatedCase, aiEntry = null) {
	if (!io || !updatedCase) return;
	if (aiEntry) io.to(caseId).emit("receiveMessage", { ...aiEntry, caseId });
	io.to(caseId).emit("supportCaseUpdated", updatedCase);
	io.emit("supportCaseUpdated", updatedCase);
}

function languageFromText(text = "", fallback = "English") {
	const raw = String(text || "");
	if (/[\u0600-\u06FF]/.test(raw)) return "Arabic";
	if (/[¿¡ñáéíóúü]/i.test(raw)) return "Spanish";
	if (/[àâçéèêëîïôûùüÿœ]/i.test(raw)) return "French";
	if (/[\u0900-\u097F]/.test(raw)) return "Hindi";
	if (/[\u0600-\u06FF]/.test(raw) && /\b(hai|aap|ji)\b/i.test(raw)) return "Urdu";
	return fallback;
}

function clearLanguageFromText(text = "") {
	const raw = String(text || "").trim();
	if (!raw) return "";
	if (/[\u0600-\u06FF]/.test(raw)) return "Arabic";
	if (/[\u0900-\u097F]/.test(raw)) return "Hindi";
	if (
		/[Â¿Â¡Ã±Ã¡Ã©Ã­Ã³ÃºÃ¼]/i.test(raw) ||
		/\b(hola|gracias|reserva|habitaci[oó]n)\b/i.test(raw)
	) {
		return "Spanish";
	}
	if (
		/[Ã Ã¢Ã§Ã©Ã¨ÃªÃ«Ã®Ã¯Ã´Ã»Ã¹Ã¼Ã¿Å“]/i.test(raw) ||
		/\b(bonjour|merci|reservation|chambre)\b/i.test(raw)
	) {
		return "French";
	}
	const letters = raw.match(/[a-z]/gi) || [];
	if (
		letters.length >= 4 &&
		/\b(hi|hello|please|thanks|thank|room|rooms|price|book|booking|reservation|date|check|available|bus|nusuk|yes|no)\b/i.test(
			raw
		)
	) {
		return "English";
	}
	return "";
}

function preferredLanguageOf(sc = {}) {
	const latest = latestGuestMessage(sc) || {};
	return (
		cleanText(sc.preferredLanguage, 40) ||
		cleanText(sc.preferredLanguageCode, 20) ||
		cleanText(latest.preferredLanguage, 40) ||
		cleanText(latest.preferredLanguageCode, 20)
	);
}

function languageSignals(sc = {}) {
	const conversation = Array.isArray(sc.conversation) ? sc.conversation : [];
	const latest = latestGuestMessage(sc);
	const latestGuestLanguage = clearLanguageFromText(latest?.message || "");
	const recentGuestLanguages = conversation
		.filter(isGuestEntry)
		.slice(-8)
		.map((entry) => clearLanguageFromText(entry.message || ""))
		.filter(Boolean);
	const preferredLanguage = preferredLanguageOf(sc);
	const recentLanguage = recentGuestLanguages[recentGuestLanguages.length - 1] || "";
	return {
		preferredLanguage,
		latestGuestLanguage,
		recentGuestLanguages: [...new Set(recentGuestLanguages)].slice(-4),
		replyLanguageHint:
			latestGuestLanguage || preferredLanguage || recentLanguage || "English",
		rule:
			"Reply in the latest clear guest language. If the latest message is too short or language-neutral, keep the preferred/current conversation language.",
	};
}

function languageOf(sc = {}, plan = {}) {
	const signals = languageSignals(sc);
	return (
		signals.latestGuestLanguage ||
		cleanText(plan.language, 40) ||
		signals.preferredLanguage ||
		signals.replyLanguageHint ||
		languageFromText(latestGuestMessage(sc)?.message || "", "English")
	);
}

function localizedQuickReplies(kind = "continue", language = "English") {
	const lang = String(language || "").toLowerCase();
	if (kind === "skip_email") {
		if (lang.includes("arabic")) {
			return [
				{
					label: "\u062a\u062e\u0637\u064a",
					value: "\u062a\u062e\u0637\u064a \u0627\u0644\u0628\u0631\u064a\u062f",
					action: "skip_email",
				},
			];
		}
		if (lang.includes("spanish")) {
			return [{ label: "Omitir", value: "Omitir email", action: "skip_email" }];
		}
		if (lang.includes("french")) {
			return [{ label: "Ignorer", value: "Ignorer email", action: "skip_email" }];
		}
		return [{ label: "Skip", value: "Skip email", action: "skip_email" }];
	}
	if (kind === "confirm_reservation") {
		if (lang.includes("arabic")) {
			return [
				{
					label: "\u062a\u0623\u0643\u064a\u062f \u0627\u0644\u062d\u062c\u0632",
					value: "\u062a\u0623\u0643\u064a\u062f \u0627\u0644\u062d\u062c\u0632",
					action: "confirm_reservation",
				},
				{
					label: "\u0647\u0646\u0627\u0643 \u062a\u0639\u062f\u064a\u0644",
					value: "\u0647\u0646\u0627\u0643 \u062a\u0639\u062f\u064a\u0644",
					action: "correction",
				},
			];
		}
		if (lang.includes("spanish")) {
			return [
				{ label: "Confirmar reserva", value: "Confirmar reserva", action: "confirm_reservation" },
				{ label: "Corregir algo", value: "Corregir algo", action: "correction" },
			];
		}
		if (lang.includes("french")) {
			return [
				{ label: "Confirmer", value: "Confirmer la reservation", action: "confirm_reservation" },
				{ label: "Corriger", value: "Corriger un detail", action: "correction" },
			];
		}
		return [
			{ label: "Confirm booking", value: "Confirm booking", action: "confirm_reservation" },
			{ label: "Correct details", value: "Correct details", action: "correction" },
		];
	}
	if (kind === "continue_booking") {
		if (lang.includes("arabic")) {
			return [
				{
					label: "\u0623\u0631\u064a\u062f \u0627\u0644\u062d\u062c\u0632",
					value: "\u0623\u0631\u064a\u062f \u0627\u0644\u062d\u062c\u0632",
					action: "continue_booking",
				},
			];
		}
		if (lang.includes("spanish")) {
			return [{ label: "Reservar", value: "Quiero reservar", action: "continue_booking" }];
		}
		if (lang.includes("french")) {
			return [{ label: "Reserver", value: "Je veux reserver", action: "continue_booking" }];
		}
		return [{ label: "Book this", value: "I want to book this", action: "continue_booking" }];
	}
	return [];
}

function sanitizeQuickReplies(quickReplies = []) {
	return (Array.isArray(quickReplies) ? quickReplies : [])
		.map((reply) => ({
			label: cleanText(reply?.label, 80),
			value: cleanText(reply?.value || reply?.label, 240),
			action: cleanText(reply?.action, 60),
		}))
		.filter((reply) => reply.label && reply.value)
		.slice(0, 4);
}

function makeAiEntry(sc = {}, text = "", { quickReplies = [], language = "" } = {}) {
	const agentName = agentNameForCase(sc);
	const latest = latestGuestMessage(sc) || {};
	return {
		messageBy: {
			customerName: agentName,
			customerEmail: SUPPORT_EMAIL,
			userId: AI_USER_ID,
		},
		message: cleanText(text, 4000),
		date: new Date(),
		inquiryAbout: latest.inquiryAbout || "Customer Support",
		inquiryDetails: latest.inquiryDetails || "",
		seenByAdmin: false,
		seenByHotel: false,
		seenByCustomer: false,
		isAi: true,
		isSystem: false,
		clientTag: "aiagent_openai_first",
		preferredLanguage: language || latest.preferredLanguage || "",
		preferredLanguageCode: latest.preferredLanguageCode || "",
		quickReplies: sanitizeQuickReplies(quickReplies),
	};
}

async function appendAiMessage(io, sc, text, options = {}) {
	const caseId = idText(sc);
	if (!caseId || !text) return null;
	const latestGuest = latestGuestMessage(sc);
	const latestGuestAt = latestGuest ? entryTime(latestGuest) : 0;
	const language = options.language || languageOf(sc, options.plan || {});
	const aiEntry = makeAiEntry(sc, text, {
		quickReplies: options.quickReplies || [],
		language,
	});
	const { updatedCase, skipped } =
		await updateSupportCaseAppendIfNoRecentAiDuplicate(
			caseId,
			{
				aiRelated: true,
				aiResponderName: aiEntry.messageBy.customerName,
				conversation: aiEntry,
			},
			{
				requireOpenClientAi: true,
				requireLatestGuestText: options.requireLatestGuestText || "",
				requireNoAiAfter: latestGuestAt ? new Date(latestGuestAt) : null,
				duplicateAfter: options.turnStartedAt || null,
				duplicateWindowMs: 60 * 1000,
			}
		);
	if (!updatedCase || skipped) return null;
	emitCaseUpdate(io, caseId, updatedCase, aiEntry);
	return updatedCase;
}

function compactRoom(room = {}) {
	return {
		id: idText(room._id),
		roomType: cleanText(room.roomType, 120),
		displayName: cleanText(room.displayName, 180),
		displayNameOtherLanguage: cleanText(room.displayName_OtherLanguage, 180),
		description: cleanText(room.description, 520),
		descriptionOtherLanguage: cleanText(room.description_OtherLanguage, 520),
		activeRoom: room.activeRoom === true,
		count: Number(room.count || 0),
		basePrice: Number(room?.price?.basePrice || 0),
		defaultCost: Number(room.defaultCost || 0),
		commissionRate: Number(room.roomCommission || 0),
		bedsCount: Number(room.bedsCount || 0),
		roomSize: cleanText(room.roomSize, 80),
		amenities: clipList(room.amenities, 18).map((v) => cleanText(v, 80)),
		views: clipList(room.views, 10).map((v) => cleanText(v, 80)),
		extraAmenities: clipList(room.extraAmenities, 12).map((v) => cleanText(v, 80)),
	};
}

function buildHotelContext(hotel = null) {
	if (!hotel) return null;
	const activeRooms = (hotel.roomCountDetails || [])
		.filter((room) => room && room.activeRoom === true)
		.map(compactRoom)
		.slice(0, 18);
	return {
		identity: {
			id: idText(hotel._id),
			hotelName: cleanText(hotel.hotelName, 180),
			hotelNameOtherLanguage: cleanText(hotel.hotelName_OtherLanguage, 180),
			city: cleanText(hotel.hotelCity, 100),
			state: cleanText(hotel.hotelState, 100),
			country: cleanText(hotel.hotelCountry, 100),
			address: cleanText(hotel.hotelAddress, 500),
			currency: hotel.currency || "SAR",
		},
		publicPresentation: {
			aboutHotel: cleanText(hotel.aboutHotel, 1200),
			aboutHotelArabic: cleanText(hotel.aboutHotelArabic, 1200),
			distances: hotel.distances || {},
			location: hotel.location || {},
			parkingLot: hotel.parkingLot,
		},
		roomInventorySummary: {
			activeRoomTypeCount: activeRooms.length,
			activeRoomTypes: activeRooms.map((room) => ({
				id: room.id,
				roomType: room.roomType,
				displayName: room.displayName,
				displayNameOtherLanguage: room.displayNameOtherLanguage,
				count: room.count,
				basePrice: room.basePrice,
				defaultCost: room.defaultCost,
				commissionRate: room.commissionRate,
			})),
			activeRooms,
		},
		transportationAndPilgrimage: {
			nusuk: {
				available: hotel.isNusuk,
				comments: cleanText(hotel.isNusukText, 900),
			},
			busService: {
				available: hotel.hasBusService,
				comments: cleanText(hotel.busDetails, 900),
			},
			meals: {
				available: hotel.hasMealsService,
				comments: cleanText(hotel.mealsDetails, 900),
			},
		},
		policiesAndRules: {
			hotelPolicyQA: activeHotelPolicyQA(hotel.hotelPolicyQA || []),
			defaultCancellationPolicy: DEFAULT_CANCELLATION_REFUND_ANSWER,
		},
	};
}

function latestGuestText(sc = {}, max = 1600) {
	return cleanText(latestGuestMessage(sc)?.message || "", max);
}

function titleText(value = "") {
	return cleanText(value, 180).replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

function replyIsArabic(sc = {}, language = "") {
	const lang = String(language || languageOf(sc, {})).toLowerCase();
	return lang.includes("arabic") || /\bar\b/.test(lang) || /[\u0600-\u06ff]/.test(latestGuestText(sc));
}

function hotelDisplayName(hotel = {}, arabic = false) {
	if (arabic) {
		return (
			cleanText(hotel.hotelName_OtherLanguage, 160) ||
			titleText(hotel.hotelName) ||
			"\u0627\u0644\u0641\u0646\u062f\u0642"
		);
	}
	return (
		titleText(hotel.hotelName) ||
		cleanText(hotel.hotelName_OtherLanguage, 160) ||
		"the hotel"
	);
}

function naturalJoin(items = [], { arabic = false } = {}) {
	const list = items.map((item) => cleanText(item, 160)).filter(Boolean);
	if (list.length <= 1) return list[0] || "";
	if (list.length === 2) return list.join(arabic ? " \u0648 " : " and ");
	const last = list[list.length - 1];
	const head = list.slice(0, -1).join(arabic ? "\u060c " : ", ");
	return `${head}${arabic ? "\u060c \u0648 " : ", and "}${last}`;
}

function activeHotelRooms(hotel = {}) {
	return (hotel.roomCountDetails || [])
		.filter((room) => room && room.activeRoom === true)
		.map((room) => ({
			roomType: cleanText(room.roomType, 120),
			displayName: cleanText(room.displayName, 180),
			displayNameOtherLanguage: cleanText(room.displayName_OtherLanguage, 180),
			count: Math.max(0, Number(room.count || 0) || 0),
		}));
}

function roomDisplayName(room = {}, arabic = false) {
	if (arabic) {
		return room.displayNameOtherLanguage || room.displayName || room.roomType;
	}
	return room.displayName || room.displayNameOtherLanguage || room.roomType;
}

function textHas(text = "", pattern) {
	return pattern.test(String(text || "").toLowerCase());
}

function directBookingNote(hotel = {}, arabic = false) {
	const name = `${hotel.hotelName || ""} ${hotel.hotelName_OtherLanguage || ""}`.toLowerCase();
	if (!name.includes("ajyad") && !/[\u0623\u0627]\u062c\u064a\u0627\u062f/.test(name)) return "";
	const walking = cleanText(hotel.distances?.walkingToElHaram, 60);
	if (arabic) {
		return walking
			? ` ${hotelDisplayName(hotel, true)} \u0645\u0645\u064a\u0632 \u0641\u064a \u0623\u062c\u064a\u0627\u062f\u060c \u0648\u0627\u0644\u062d\u0631\u0645 \u0639\u0644\u0649 \u0628\u0639\u062f \u0646\u062d\u0648 ${walking} \u0645\u0634\u064a\u0627\u064b.`
			: ` ${hotelDisplayName(hotel, true)} \u0645\u0645\u064a\u0632 \u0641\u064a \u0623\u062c\u064a\u0627\u062f \u0648\u0645\u0646\u0627\u0633\u0628 \u0644\u0644\u062d\u062c\u0632 \u0627\u0644\u0645\u0628\u0627\u0634\u0631.`;
	}
	return walking
		? ` ${hotelDisplayName(hotel)} is a strong direct-booking choice in Ajyad, about ${walking} walking to Al Haram.`
		: ` ${hotelDisplayName(hotel)} is a strong direct-booking choice in Ajyad.`;
}

function fastHotelFactReply(sc = {}, hotel = {}, agentName = "Aisha") {
	if (!hotel) return null;
	const text = latestGuestText(sc);
	if (!text) return null;
	const language = languageOf(sc, {});
	const arabic = replyIsArabic(sc, language);
	const hotelName = hotelDisplayName(hotel, arabic);
	const priceLike = textHas(
		text,
		/\b(price|prices|cost|rate|rates|total|discount|cheap|expensive|book|booking|reserve|reservation|check[- ]?in|check[- ]?out|date|dates)\b|\u0628\u0643\u0627\u0645|\u0633\u0639\u0631|\u0627\u0633\u0639\u0627\u0631|\u0623\u0633\u0639\u0627\u0631|\u062d\u062c\u0632|\u0627\u062d\u062c\u0632|\u062a\u0627\u0631\u064a\u062e|\u062f\u062e\u0648\u0644|\u062e\u0631\u0648\u062c/
	);
	const roomLike = textHas(
		text,
		/\b(room|rooms|suite|suites|bed|beds|type|types)\b|\u063a\u0631\u0641|\u063a\u0631\u0641\u0629|\u0623\u0646\u0648\u0627\u0639|\u0627\u0646\u0648\u0627\u0639|\u0646\u0648\u0639/
	);
	if (roomLike && !priceLike) {
		const rooms = activeHotelRooms(hotel);
		if (!rooms.length) return null;
		const roomNames = rooms.map((room) => roomDisplayName(room, arabic));
		if (arabic) {
			return {
				text: `\u0644\u062f\u064a\u0646\u0627 \u0641\u064a ${hotelName}: ${naturalJoin(roomNames, {
					arabic,
				})}.${directBookingNote(hotel, true)} \u0623\u0631\u0633\u0644 \u062a\u0627\u0631\u064a\u062e \u0627\u0644\u062f\u062e\u0648\u0644 \u0648\u0627\u0644\u062e\u0631\u0648\u062c \u0648\u0633\u0623\u0631\u0627\u062c\u0639 \u0644\u0643 \u0627\u0644\u0633\u0639\u0631 \u0648\u0627\u0644\u062a\u0648\u0641\u0631 \u0628\u062f\u0642\u0629.`,
				language,
				quickReplies: [],
			};
		}
		return {
			text: `At ${hotelName}, we have ${naturalJoin(roomNames)}.${directBookingNote(
				hotel,
				false
			)} Send your check-in and check-out dates and I will check exact availability and price.`,
			language,
			quickReplies: [],
		};
	}

	const busLike = textHas(
		text,
		/\b(bus|shuttle|transport|transfer)\b|\u0628\u0627\u0635|\u062d\u0627\u0641\u0644|\u0646\u0642\u0644|\u0645\u0648\u0627\u0635\u0644\u0627\u062a/
	);
	if (busLike) {
		const available = hotel.hasBusService === true;
		const details = cleanText(hotel.busDetails, 320);
		return {
			text: arabic
				? available
					? `${hotelName} \u064a\u0648\u0641\u0631 \u062e\u062f\u0645\u0629 \u0628\u0627\u0635 \u0644\u0644\u0636\u064a\u0648\u0641. ${details || "\u0633\u0646\u0633\u0627\u0639\u062f\u0643 \u0628\u0627\u0644\u062a\u0641\u0627\u0635\u064a\u0644 \u0639\u0646\u062f \u062a\u0623\u0643\u064a\u062f \u0627\u0644\u062d\u062c\u0632."}`
					: `${hotelName} \u0644\u0627 \u064a\u0638\u0647\u0631 \u0644\u062f\u064a\u0647 \u0628\u0627\u0635 \u0645\u0624\u0643\u062f \u062d\u0627\u0644\u064a\u0627\u064b\u060c \u0644\u0643\u0646 \u0633\u0646\u0633\u0627\u0639\u062f\u0643 \u0628\u0623\u0641\u0636\u0644 \u0637\u0631\u064a\u0642\u0629 \u0644\u0644\u0648\u0635\u0648\u0644.`
				: available
				? `${hotelName} provides a shuttle/bus service for guests. ${details || "We can share the exact details while arranging your stay."}`
				: `${hotelName} does not currently show a confirmed shuttle service, but we can help you with the best transport option.`,
			language,
			quickReplies: [],
		};
	}

	const nusukLike = textHas(text, /\b(nusuk|permit|permits)\b|\u0646\u0633\u0643|\u062a\u0635\u0631\u064a\u062d/);
	if (nusukLike) {
		const available = hotel.isNusuk === true;
		const details = cleanText(hotel.isNusukText, 320);
		return {
			text: arabic
				? available
					? `${hotelName}: \u0646\u0633\u0643 \u0645\u062a\u0627\u062d. ${details || "\u0646\u0633\u0627\u0639\u062f\u0643 \u0628\u0627\u0644\u062a\u0641\u0627\u0635\u064a\u0644 \u0628\u0639\u062f \u062a\u0623\u0643\u064a\u062f \u0627\u0644\u062d\u062c\u0632."}`
					: `${hotelName}: \u0644\u0627 \u064a\u0638\u0647\u0631 \u0623\u0646 \u0646\u0633\u0643 \u0645\u062a\u0627\u062d \u062d\u0627\u0644\u064a\u0627\u064b.`
				: available
				? `${hotelName}: Nusuk is available. ${details || "We can help with the details after confirming the reservation."}`
				: `${hotelName}: Nusuk is not currently shown as available.`,
			language,
			quickReplies: [],
		};
	}

	const mealLike = textHas(
		text,
		/\b(meal|meals|breakfast|food|restaurant)\b|\u0648\u062c\u0628|\u0641\u0637\u0648\u0631|\u0627\u0643\u0644|\u0623\u0643\u0644|\u0645\u0637\u0639\u0645/
	);
	if (mealLike) {
		const available = hotel.hasMealsService === true;
		const details = cleanText(hotel.mealsDetails, 320);
		return {
			text: arabic
				? available
					? `${hotelName} \u064a\u0648\u0641\u0631 \u062e\u062f\u0645\u0629 \u0648\u062c\u0628\u0627\u062a. ${details}`
					: `${hotelName} \u0644\u0627 \u064a\u0638\u0647\u0631 \u0644\u062f\u064a\u0647 \u0648\u062c\u0628\u0627\u062a \u0623\u0648 \u0625\u0641\u0637\u0627\u0631 \u0645\u0624\u0643\u062f \u062d\u0627\u0644\u064a\u0627\u064b.`
				: available
				? `${hotelName} provides meals. ${details}`
				: `${hotelName} does not currently show confirmed meals or breakfast service.`,
			language,
			quickReplies: [],
		};
	}

	const parkingLike = textHas(text, /\b(parking|park|car)\b|\u0645\u0648\u0642\u0641|\u0645\u0648\u0627\u0642\u0641|\u0633\u064a\u0627\u0631/);
	if (parkingLike) {
		const available = hotel.parkingLot === true;
		return {
			text: arabic
				? available
					? `${hotelName} \u064a\u0648\u0641\u0631 \u0645\u0648\u0642\u0641 \u0633\u064a\u0627\u0631\u0627\u062a.`
					: `${hotelName} \u0644\u0627 \u064a\u0638\u0647\u0631 \u0644\u062f\u064a\u0647 \u0645\u0648\u0642\u0641 \u0633\u064a\u0627\u0631\u0627\u062a \u0645\u0624\u0643\u062f \u062d\u0627\u0644\u064a\u0627\u064b.`
				: available
				? `${hotelName} has parking available.`
				: `${hotelName} does not currently show confirmed parking.`,
			language,
			quickReplies: [],
		};
	}

	const distanceLike = textHas(
		text,
		/\b(distance|far|near|walk|walking|drive|driving|minutes|haram)\b|\u0627\u0644\u062d\u0631\u0645|\u0642\u0631\u064a\u0628|\u0628\u0639\u064a\u062f|\u0645\u0634\u064a|\u062f\u0642\u0627\u0626\u0642|\u0628\u0627\u0644\u0633\u064a\u0627\u0631\u0629|\u0627\u0644\u0645\u0633\u0627\u0641\u0629/
	);
	if (distanceLike) {
		const walking = cleanText(hotel.distances?.walkingToElHaram, 60);
		const driving = cleanText(hotel.distances?.drivingToElHaram, 60);
		if (walking || driving) {
			return {
				text: arabic
					? `${hotelName} \u064a\u0628\u0639\u062f \u062d\u0648\u0627\u0644\u064a ${walking || "\u063a\u064a\u0631 \u0645\u062d\u062f\u062f"} \u0645\u0634\u064a\u0627\u064b \u0648${driving || "\u063a\u064a\u0631 \u0645\u062d\u062f\u062f"} \u0628\u0627\u0644\u0633\u064a\u0627\u0631\u0629 \u0639\u0646 \u0627\u0644\u062d\u0631\u0645.`
					: `${hotelName} is about ${walking || "not specified"} walking and ${driving || "not specified"} driving from Al Haram.`,
				language,
				quickReplies: [],
			};
		}
	}

	const addressLike = textHas(text, /\b(address|location|where|map)\b|\u0639\u0646\u0648\u0627\u0646|\u0645\u0648\u0642\u0639|\u0648\u064a\u0646|\u0641\u064a\u0646|\u062e\u0631\u064a\u0637/);
	if (addressLike && hotel.hotelAddress) {
		return {
			text: arabic
				? `${hotelName} \u0639\u0646\u0648\u0627\u0646\u0647: ${cleanText(hotel.hotelAddress, 320)}.`
				: `${hotelName} address is: ${cleanText(hotel.hotelAddress, 320)}.`,
			language,
			quickReplies: [],
		};
	}

	return null;
}

function fallbackReply(sc = {}, hotel = {}, agentName = "Aisha", error = null) {
	const fastReply = fastHotelFactReply(sc, hotel, agentName);
	if (fastReply) return fastReply;
	const language = languageOf(sc, {});
	const arabic = replyIsArabic(sc, language);
	const hotelName = hotelDisplayName(hotel, arabic);
	const text = latestGuestText(sc);
	const asksPrice = textHas(
		text,
		/\b(price|prices|cost|rate|rates|available|availability|book|booking|reserve|reservation)\b|\u0628\u0643\u0627\u0645|\u0633\u0639\u0631|\u0623\u0633\u0639\u0627\u0631|\u0627\u0633\u0639\u0627\u0631|\u0645\u062a\u0627\u062d|\u062a\u0648\u0641\u0631|\u062d\u062c\u0632/
	);
	const errorHint = cleanText(error?.message || error, 160);
	if (arabic) {
		return {
			text: asksPrice
				? `\u0623\u0646\u0627 \u0645\u0639\u0643. \u0644\u0623\u0631\u0627\u062c\u0639 \u0627\u0644\u0633\u0639\u0631 \u0648\u0627\u0644\u062a\u0648\u0641\u0631 \u0628\u062f\u0642\u0629 \u0641\u064a ${hotelName}\u060c \u0623\u0631\u0633\u0644 \u0644\u064a \u062a\u0627\u0631\u064a\u062e \u0627\u0644\u062f\u062e\u0648\u0644 \u0648\u0627\u0644\u062e\u0631\u0648\u062c \u0648\u0646\u0648\u0639 \u0627\u0644\u063a\u0631\u0641\u0629.`
				: `\u0623\u0646\u0627 \u0645\u0639\u0643 \u0645\u0646 \u0627\u0633\u062a\u0642\u0628\u0627\u0644 \u0648\u062d\u062c\u0648\u0632\u0627\u062a ${hotelName}. \u0623\u0642\u062f\u0631 \u0623\u0633\u0627\u0639\u062f\u0643 \u0628\u0627\u0644\u063a\u0631\u0641\u060c \u0627\u0644\u0623\u0633\u0639\u0627\u0631\u060c \u0627\u0644\u062a\u0648\u0641\u0631\u060c \u0627\u0644\u0628\u0627\u0635\u060c \u0646\u0633\u0643\u060c \u0648\u0627\u0644\u062d\u062c\u0632. \u0645\u0627 \u0627\u0644\u062a\u0641\u0635\u064a\u0644 \u0627\u0644\u0630\u064a \u062a\u0631\u064a\u062f\u0647\u061f`,
			language,
			quickReplies: [],
		};
	}
	return {
		text: asksPrice
			? `I am with you. To check exact price and availability at ${hotelName}, please send the check-in date, checkout date, and room type.`
			: `I am with you from ${hotelName} reception and reservations. I can help with rooms, prices, availability, shuttle, Nusuk, and booking. What would you like to check?`,
		language,
		quickReplies: [],
		_errorHint: errorHint,
	};
}

function compactReservationDetails(reservation = null, sc = {}, confirmationHint = "") {
	const ai = sc.aiReservation || {};
	const aiReservation = {
		status: cleanText(ai.status, 40),
		confirmationNumber: cleanText(ai.confirmationNumber, 80),
		reservationId: idText(ai.reservationId),
		createdAt: ai.createdAt || null,
		lastError: cleanText(ai.lastError, 180),
	};
	return {
		hasKnownReservation: Boolean(reservation),
		confirmationHint: cleanText(confirmationHint || ai.confirmationNumber, 80),
		aiReservation,
		currentReservation: reservation
			? {
					id: idText(reservation._id),
					confirmationNumber: cleanText(reservation.confirmation_number, 80),
					status: cleanText(reservation.reservation_status || reservation.state, 100),
					checkinDate: reservation.checkin_date || "",
					checkoutDate: reservation.checkout_date || "",
					totalAmount: reservation.total_amount,
					payment: cleanText(reservation.payment, 80),
					customer: {
						name: cleanText(reservation.customer_details?.name, 180),
						phone: cleanText(reservation.customer_details?.phone, 80),
						email: cleanText(reservation.customer_details?.email, 180),
						nationality: cleanText(reservation.customer_details?.nationality, 100),
					},
					rooms: Array.isArray(reservation.pickedRoomsType)
						? reservation.pickedRoomsType.slice(0, 4).map((room) => ({
								roomType: cleanText(room.room_type || room.roomType, 120),
								displayName: cleanText(room.displayName || room.display_name, 180),
								count: Number(room.count || 1),
						  }))
						: [],
			  }
			: null,
	};
}

function latestReservationConfirmationHint(sc = {}) {
	const conversation = Array.isArray(sc.conversation) ? sc.conversation : [];
	for (let i = conversation.length - 1; i >= 0; i -= 1) {
		const entry = conversation[i];
		if (!isGuestEntry(entry)) continue;
		const message = String(entry.message || "");
		const labeled = message.match(
			/(?:confirmation|booking|reservation|ref(?:erence)?|\u0631\u0642\u0645\s*\u0627\u0644\u062d\u062c\u0632|\u062a\u0623\u0643\u064a\u062f|\u062d\u062c\u0632)\s*(?:number|no\.?|#|:)?\s*([a-z0-9-]{5,30})/i
		);
		if (labeled) return labeled[1];
		const longNumeric = message.match(/\b\d{8,14}\b/);
		if (longNumeric) return longNumeric[0];
		break;
	}
	return "";
}

async function buildConversationContext(sc = {}) {
	const conversation = Array.isArray(sc.conversation) ? sc.conversation : [];
	return conversation
		.filter((entry) => entry && !entry.isSystem)
		.slice(-MAX_CONVERSATION_TURNS)
		.map((entry) => {
			const by = entry.messageBy || {};
			const speaker = isGuestEntry(entry)
				? cleanText(by.customerName || sc.clientName || "Guest", 80)
				: cleanText(by.customerName || agentNameForCase(sc), 80);
			return {
				role: isGuestEntry(entry) ? "guest" : "agent",
				speaker,
				action: cleanText(entry.clientAction, 60),
				at: entry.date || null,
				message: cleanText(entry.message, 1200),
			};
		});
}

async function contextBundle(sc = {}, hotel = null) {
	const confirmation = cleanText(
		sc.aiReservation?.confirmationNumber || latestReservationConfirmationHint(sc),
		80
	);
	const reservation = confirmation
		? await getReservationByConfirmation(confirmation).catch(() => null)
		: null;
	return {
		reservationDetails: compactReservationDetails(reservation, sc, confirmation),
		hotelDetails: buildHotelContext(hotel),
		conversation: await buildConversationContext(sc),
		requestMetadata: {
			todayISO: new Date().toISOString().slice(0, 10),
			languageSignals: languageSignals(sc),
			supportCase: {
				id: idText(sc._id),
				clientName: cleanText(sc.clientName || sc.displayName1, 120),
				clientContactType: cleanText(sc.clientContactType, 40),
				clientContact: cleanText(sc.clientContact, 120),
				sourceUrl: cleanText(sc.sourceUrl, 400),
			},
		},
	};
}

function stripCodeFence(text = "") {
	return String(text || "")
		.replace(/^```(?:json)?/i, "")
		.replace(/```$/i, "")
		.trim();
}

function parseJsonObject(text = "") {
	const raw = stripCodeFence(text);
	try {
		return JSON.parse(raw);
	} catch {
		const match = raw.match(/\{[\s\S]*\}/);
		if (!match) return null;
		try {
			return JSON.parse(match[0]);
		} catch {
			return null;
		}
	}
}

function normalizePlan(plan = {}, fallbackReply = "") {
	const allowedActions = new Set([
		"answer_only",
		"ask_dates",
		"quote_with_pricing",
		"ask_booking_details",
		"ask_optional_email",
		"send_review",
		"create_reservation_after_button",
		"escalate",
	]);
	const nextAction = allowedActions.has(plan.nextAction)
		? plan.nextAction
		: plan.needsPricing
		? "quote_with_pricing"
		: "answer_only";
	const details = plan.guestDetails || {};
	return {
		language: cleanText(plan.language, 40) || "English",
		languageCode: cleanText(plan.languageCode, 12),
		latestTopic: cleanText(plan.latestTopic, 120),
		needsPricing: plan.needsPricing === true,
		checkinISO: cleanText(plan.checkinISO, 20),
		checkoutISO: cleanText(plan.checkoutISO, 20),
		roomTypeHint: cleanText(plan.roomTypeHint, 160),
		selectedRoomType: cleanText(plan.selectedRoomType, 160),
		wantsToBook: plan.wantsToBook === true,
		needsHumanEscalation: plan.needsHumanEscalation === true,
		escalationReason: cleanText(plan.escalationReason, 240),
		nextAction,
		replyIfNoPricing: cleanText(plan.replyIfNoPricing || fallbackReply, 2400),
		askForDatesReply: cleanText(plan.askForDatesReply, 1400),
		askForMissingDetailsReply: cleanText(plan.askForMissingDetailsReply, 1800),
		guestDetails: {
			fullName: cleanText(details.fullName || details.name, 160),
			phone: cleanText(details.phone, 80),
			nationality: cleanText(details.nationality, 100),
			email: cleanText(details.email, 180),
			emailSkipped: details.emailSkipped === true,
			adults: numberOrNull(details.adults),
			children: numberOrNull(details.children),
			totalGuests: numberOrNull(details.totalGuests || details.guests),
			rooms: numberOrNull(details.rooms),
		},
	};
}

async function callPlanOpenAI(bundle, agentName) {
	const hotelName =
		bundle.hotelDetails?.identity?.hotelNameOtherLanguage ||
		bundle.hotelDetails?.identity?.hotelName ||
		"Jannat Booking";
	const userPrompt = JSON.stringify(bundle);
	const raw = await chat(
		[
			{
				role: "system",
				content: [
					"You are the OpenAI-first brain for a live hotel reception and reservation chat.",
					"Read the structured payload in this order: reservationDetails first, hotelDetails second, conversation third, then return strict JSON only.",
					"Use requestMetadata.languageSignals: reply in the latest clear guest language; if the latest message is short or language-neutral, keep the preferred/current conversation language.",
					"Be a professional CSR and a warm sales representative.",
					"If the latest guest asks about an existing reservation, updating a reservation, cancellation, payment, or confirmation status, prioritize reservationDetails before hotelDetails.",
					"If reservationDetails.hasKnownReservation is false and the guest is asking about an existing booking, ask for the confirmation/booking/reference number naturally.",
					"If the latest guest asks about the hotel, rooms, Nusuk, bus, meals, distance, policies, or casual hotel questions, use hotelDetails and answer directly.",
					"Always answer the latest concrete question first. Do not pivot to phone, email, dates, or confirmation before answering, unless the answer truly requires that missing fact.",
					"Never invent hotel facts, prices, availability, walking/driving minutes, Nusuk, bus service, meals, cancellation, or reservation details. Use only provided context.",
					"If a price/availability answer is needed, set needsPricing=true. If dates are missing, set nextAction='ask_dates' and write askForDatesReply.",
					"If pricing is needed and dates are present, set nextAction='quote_with_pricing' and leave the final price wording to the second pricing call.",
					"Do not create, confirm, or claim a reservation is created. Only set nextAction='create_reservation_after_button' when the latest guest action is the explicit confirm button.",
					"Email is optional. Ask for it only after required reservation details are captured; make it easy to skip.",
					"Required reservation details before review: check-in, check-out, selected room, full legal guest name, phone/WhatsApp, nationality, adults, children, rooms.",
					"If the guest says total guests but not children, infer adults=total guests and children=0 only when no child/kid wording appears.",
					"For Zad Ajyad, naturally highlight that Ajyad is special, walkable to Al Haram when supported by context, and direct booking often avoids third-party fees/commissions; do not exaggerate.",
					"If the guest asks for a discount or says expensive, position direct booking value professionally without promising an unapproved discount.",
					"Return JSON shape: {language, languageCode, latestTopic, needsPricing, checkinISO, checkoutISO, roomTypeHint, selectedRoomType, wantsToBook, needsHumanEscalation, escalationReason, nextAction, replyIfNoPricing, askForDatesReply, askForMissingDetailsReply, guestDetails:{fullName,phone,nationality,email,emailSkipped,adults,children,totalGuests,rooms}}.",
					`Agent name is ${agentName}. Hotel display name is ${hotelName}.`,
				].join("\n"),
			},
			{ role: "user", content: userPrompt },
		],
		{ kind: "nlu", temperature: 0.1, max_tokens: 700, reasoning_effort: "low" }
	);
	const parsed = parseJsonObject(raw);
	return normalizePlan(parsed || {}, parsed ? "" : raw);
}

function numberOrNull(value) {
	if (value === null || value === undefined || value === "") return null;
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
}

function numberValue(value, fallback = 0) {
	const n = Number(value);
	return Number.isFinite(n) ? n : fallback;
}

function hasValue(value) {
	return value !== null && value !== undefined && value !== "";
}

function validISODate(value = "") {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return false;
	const date = new Date(`${value}T00:00:00Z`);
	return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validStayDates(checkinISO = "", checkoutISO = "") {
	return validISODate(checkinISO) && validISODate(checkoutISO) && checkinISO < checkoutISO;
}

function stayDateKeys(checkinISO = "", checkoutISO = "") {
	if (!validStayDates(checkinISO, checkoutISO)) return [];
	const dates = [];
	const cursor = new Date(`${checkinISO}T00:00:00Z`);
	const end = new Date(`${checkoutISO}T00:00:00Z`);
	while (cursor < end && dates.length < 90) {
		dates.push(cursor.toISOString().slice(0, 10));
		cursor.setUTCDate(cursor.getUTCDate() + 1);
	}
	return dates;
}

function roomQuoteShape(room = {}) {
	return {
		_id: room._id,
		roomType: room.roomType,
		displayName: room.displayName,
		displayName_OtherLanguage: room.displayName_OtherLanguage,
		count: room.count,
	};
}

function commissionRateForRoom(hotel = {}, room = {}) {
	const hotelCommission = hasValue(hotel?.commission)
		? numberValue(hotel.commission, 10)
		: 10;
	const fallback = hotelCommission >= 0 ? hotelCommission : 10;
	const roomCommission = hasValue(room?.roomCommission)
		? numberValue(room.roomCommission, fallback)
		: fallback;
	return roomCommission >= 0 ? roomCommission : fallback;
}

function pricingRateMapForDates(room = {}, dates = []) {
	const targetDates = new Set(dates.map(dateOnlyText).filter(Boolean));
	const rateMap = new Map();
	if (!targetDates.size) return rateMap;
	const pricingRates = Array.isArray(room.pricingRate) ? room.pricingRate : [];
	for (const rate of pricingRates) {
		const date = dateOnlyText(rate?.calendarDate);
		if (!date || !targetDates.has(date) || rateMap.has(date)) continue;
		rateMap.set(date, rate);
		if (rateMap.size >= targetDates.size) break;
	}
	return rateMap;
}

function priceCompactRoomForStay(hotel = {}, room = {}, dates = []) {
	if (!room) {
		return {
			available: false,
			reason: "room_not_found",
			currency: hotel?.currency || "SAR",
			room: null,
			nights: 0,
			totals: null,
		};
	}
	const nights = dates.length;
	const currency = hotel?.currency || "SAR";
	if (!nights) {
		return {
			available: false,
			reason: "bad_dates",
			currency,
			room: roomQuoteShape(room),
			nights: 0,
			totals: null,
		};
	}

	const basePrice = numberValue(room?.price?.basePrice, 0);
	const defaultCost = numberValue(room?.defaultCost, 0);
	const defaultCommission = commissionRateForRoom(hotel, room);
	const rateMap = pricingRateMapForDates(room, dates);
	let totalWithCommission = 0;
	let hotelShouldGet = 0;

	for (const date of dates) {
		const rate = rateMap.get(date);
		const dayPrice = rate ? numberValue(rate.price, basePrice) : basePrice;
		const dayRoot = rate ? numberValue(rate.rootPrice, defaultCost) : defaultCost;
		const dayCommission = rate
			? numberValue(rate.commissionRate, defaultCommission)
			: defaultCommission;

		if (rate && (numberValue(rate.price, 0) === 0 || numberValue(rate.rootPrice, 0) === 0)) {
			return {
				available: false,
				reason: "blocked",
				currency,
				room: roomQuoteShape(room),
				nights,
				totals: null,
			};
		}

		totalWithCommission += dayPrice + dayRoot * (dayCommission / 100);
		hotelShouldGet += dayRoot;
	}

	const total = Number(totalWithCommission.toFixed(2));
	const hotelTotal = Number(hotelShouldGet.toFixed(2));
	return {
		available: true,
		reason: null,
		currency,
		room: roomQuoteShape(room),
		nights,
		totals: {
			totalPriceWithCommission: total,
			hotelShouldGet: hotelTotal,
			totalCommission: Number((total - hotelTotal).toFixed(2)),
		},
	};
}

function listCompactRoomsForStay(hotel = {}, checkinISO = "", checkoutISO = "") {
	const dates = stayDateKeys(checkinISO, checkoutISO);
	const rooms = (hotel?.roomCountDetails || []).filter((room) => room?.activeRoom === true);
	return rooms.map((room) => priceCompactRoomForStay(hotel, room, dates));
}

function dateOnlyText(value = "") {
	if (!value) return "";
	if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) {
		return value.slice(0, 10);
	}
	const date = new Date(value);
	return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : "";
}

function roomToken(value = "") {
	return String(value || "")
		.toLowerCase()
		.replace(/[^a-z0-9\u0600-\u06ff]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function matchRoom(hotel = {}, hint = "", selectedRoomType = "") {
	const rooms = (hotel.roomCountDetails || []).filter((room) => room?.activeRoom === true);
	if (!rooms.length) return null;
	const exactRoomType = cleanText(selectedRoomType || hint, 180);
	if (exactRoomType) {
		const exact = rooms.find(
			(room) =>
				String(room.roomType || "") === exactRoomType ||
				String(room._id || "") === exactRoomType ||
				String(room.displayName || "") === exactRoomType
		);
		if (exact) return exact;
	}
	const token = roomToken(`${hint} ${selectedRoomType}`);
	if (token) {
		const byName = rooms.find((room) => {
			const combined = roomToken(
				[
					room.roomType,
					room.displayName,
					room.displayName_OtherLanguage,
					room.description,
					room.description_OtherLanguage,
				].join(" ")
			);
			return (
				combined.includes(token) ||
				token.includes(combined) ||
				token
					.split(" ")
					.filter((part) => part.length > 2)
					.some((part) => combined.includes(part))
			);
		});
		if (byName) return byName;
	}
	return rooms[0] || null;
}

function roomSelectionKey(room = {}) {
	return roomToken(room.roomType || room.room_type || room.displayName || room.display_name);
}

function roomSelectionDisplayKey(room = {}) {
	return roomToken(room.displayName || room.display_name || room.roomType || room.room_type);
}

function reservationRoomSelections(reservation = {}) {
	const picked = Array.isArray(reservation.pickedRoomsType)
		? reservation.pickedRoomsType
		: Array.isArray(reservation.pickedRoomsPricing)
		? reservation.pickedRoomsPricing
		: [];
	return picked
		.map((room) => ({
			roomType: cleanText(room.room_type || room.roomType, 140),
			displayName: cleanText(room.displayName || room.display_name, 180),
			count: Math.max(1, Number(room.count || 1) || 1),
		}))
		.filter((room) => room.roomType || room.displayName);
}

function selectionMatchesRoom(selection = {}, room = {}) {
	const targetType = roomSelectionKey(room);
	const targetDisplay = roomSelectionDisplayKey(room);
	const selectedType = roomSelectionKey(selection);
	const selectedDisplay = roomSelectionDisplayKey(selection);
	if (targetType && selectedType && targetType === selectedType) return true;
	if (targetDisplay && selectedDisplay && targetDisplay === selectedDisplay) return true;
	return false;
}

async function inventoryByRoomForStay(hotel = {}, plan = {}, { caseId = "" } = {}) {
	const dates = stayDateKeys(plan.checkinISO, plan.checkoutISO);
	const hotelId = idText(hotel?._id);
	if (!hotelId || !dates.length) return new Map();
	const startDate = new Date(`${dates[0]}T00:00:00.000Z`);
	const endDate = new Date(`${dates[dates.length - 1]}T23:59:59.999Z`);
	memoryTrace("inventory:before_query", caseId, { hotelId, dates: dates.length });
	const reservations = await Reservations.find({
		hotelId,
		checkin_date: { $lt: endDate },
		checkout_date: { $gt: startDate },
	})
		.select(RESERVATION_INVENTORY_SELECT)
		.limit(1000)
		.maxTimeMS(2500)
		.lean()
		.exec()
		.catch(() => []);
	memoryTrace("inventory:after_query", caseId, {
		reservations: Array.isArray(reservations) ? reservations.length : 0,
	});

	const requested = Math.max(1, Number(plan?.guestDetails?.rooms || 1) || 1);
	const availabilityByRoom = new Map();
	const activeRooms = (hotel.roomCountDetails || []).filter((room) => room?.activeRoom === true);
	memoryTrace("inventory:before_rows", caseId, {
		activeRooms: activeRooms.length,
		requested,
	});

	activeRooms.forEach((room) => {
		const dayRows = dates.map((date) => {
			let reserved = 0;
			for (const reservation of reservations) {
				if (!shouldCountReservationForInventory(reservation)) continue;
				const checkin = dateOnlyText(reservation.checkin_date);
				const checkout = dateOnlyText(reservation.checkout_date);
				if (!checkin || !checkout || !(checkin <= date && date < checkout)) continue;
				for (const selection of reservationRoomSelections(reservation)) {
					if (selectionMatchesRoom(selection, room)) reserved += selection.count;
				}
			}
			const capacity = Math.max(0, Number(room.count || 0) || 0);
			const availableBefore = capacity - reserved;
			return {
				date,
				capacity,
				reserved,
				requested,
				availableBefore: Math.max(0, availableBefore),
				availableBeforeRaw: availableBefore,
				availableAfterRaw: availableBefore - requested,
			};
		});
		const minAvailableBeforeRaw = dayRows.length
			? Math.min(...dayRows.map((day) => day.availableBeforeRaw))
			: 0;
		const firstBlocked = dayRows.find((day) => day.requested > day.availableBeforeRaw);
		availabilityByRoom.set(idText(room._id) || room.roomType || room.displayName, {
			ok: !firstBlocked,
			reason: firstBlocked ? "inventory_unavailable" : "",
			message: firstBlocked
				? `${room.displayName || room.roomType || "Selected room"} has ${Math.max(
						0,
						firstBlocked.availableBeforeRaw
				  )} available room(s) on ${firstBlocked.date}, but ${requested} were requested.`
				: "",
			requested,
			minAvailableBefore: Math.max(0, minAvailableBeforeRaw),
			minAvailableBeforeRaw,
			days: dayRows,
		});
	});

	memoryTrace("inventory:after_rows", caseId, {
		rooms: availabilityByRoom.size,
	});
	return availabilityByRoom;
}

function availabilityForRoom(availabilityByRoom = new Map(), room = {}) {
	return (
		availabilityByRoom.get(idText(room?._id)) ||
		availabilityByRoom.get(room?.roomType || "") ||
		availabilityByRoom.get(room?.displayName || "") ||
		null
	);
}

async function pricingSummaryForStay(hotel = {}, plan = {}, { caseId = "" } = {}) {
	if (!validStayDates(plan.checkinISO, plan.checkoutISO)) {
		return { ok: false, reason: "bad_dates", rooms: [] };
	}
	memoryTrace("pricing:start", caseId);
	const quotes = listCompactRoomsForStay(hotel, plan.checkinISO, plan.checkoutISO);
	memoryTrace("pricing:after_quotes", caseId, {
		quotes: Array.isArray(quotes) ? quotes.length : 0,
	});
	const selectedRoom = matchRoom(hotel, plan.roomTypeHint, plan.selectedRoomType);
	memoryTrace("pricing:after_match_room", caseId, {
		selectedRoom: cleanText(selectedRoom?.roomType || selectedRoom?.displayName, 120),
	});
	const selectedQuote = selectedRoom
		? quotes.find((quote) => summaryRoomMatchesQuote(selectedRoom, quote)) || null
		: null;
	memoryTrace("pricing:after_selected_quote", caseId, {
		selectedAvailable: selectedQuote?.available,
	});
	const inventoryByRoom = await inventoryByRoomForStay(hotel, plan, { caseId });
	memoryTrace("pricing:after_inventory", caseId, {
		inventoryRooms: inventoryByRoom.size,
	});
	const rooms = quotes
		.map((quote) => {
			const inventory = availabilityForRoom(inventoryByRoom, quote.room);
			const available = quote.available === true && (!inventory || inventory.ok);
			return {
				available,
				reason: quote.reason || inventory?.reason || "",
				inventoryMessage: inventory?.message || "",
				roomType: cleanText(quote.room?.roomType, 120),
				roomId: idText(quote.room?._id),
				displayName: cleanText(quote.room?.displayName, 180),
				displayNameOtherLanguage: cleanText(
					quote.room?.displayName_OtherLanguage,
					180
				),
				count: Number(quote.room?.count || 0),
				minAvailableBefore: inventory?.minAvailableBefore,
				requestedRooms: inventory?.requested,
				nights: quote.nights || 0,
				currency: quote.currency || hotel.currency || "SAR",
				total: available ? quote.totals?.totalPriceWithCommission || null : null,
				hotelShouldGet: available ? quote.totals?.hotelShouldGet || null : null,
				totalCommission: available ? quote.totals?.totalCommission || null : null,
			};
		})
		.sort((a, b) => {
			if (a.available !== b.available) return a.available ? -1 : 1;
			return Number(a.total || 999999) - Number(b.total || 999999);
		});
	const selectedInventory = availabilityForRoom(inventoryByRoom, selectedQuote?.room);
	const selectedAvailable =
		selectedQuote?.available === true && (!selectedInventory || selectedInventory.ok);
	return {
		ok: true,
		checkinISO: plan.checkinISO,
		checkoutISO: plan.checkoutISO,
		selectedRoomType: cleanText(selectedRoom?.roomType, 120),
		selectedQuote: selectedQuote
			? {
					available: selectedAvailable,
					reason: selectedQuote.reason || selectedInventory?.reason || "",
					inventoryMessage: selectedInventory?.message || "",
					roomType: cleanText(selectedQuote.room?.roomType, 120),
					displayName: cleanText(selectedQuote.room?.displayName, 180),
					displayNameOtherLanguage: cleanText(
						selectedQuote.room?.displayName_OtherLanguage,
						180
					),
					minAvailableBefore: selectedInventory?.minAvailableBefore,
					requestedRooms: selectedInventory?.requested,
					nights: selectedQuote.nights || 0,
					currency: selectedQuote.currency || hotel.currency || "SAR",
					total: selectedAvailable
						? selectedQuote.totals?.totalPriceWithCommission || null
						: null,
					hotelShouldGet: selectedAvailable
						? selectedQuote.totals?.hotelShouldGet || null
						: null,
					totalCommission: selectedAvailable
						? selectedQuote.totals?.totalCommission || null
						: null,
			  }
			: null,
		rooms: rooms.slice(0, 8),
	};
}

async function callPricingWriterOpenAI({ bundle, plan, pricing, missing, agentName }) {
	const raw = await chat(
		[
			{
				role: "system",
				content: [
					"You are replying as a live hotel reception and reservation CSR.",
					"Use requestMetadata.languageSignals: reply in the latest clear guest language; if the latest message is short or language-neutral, keep the preferred/current conversation language.",
					"Answer in one to three friendly sentences unless a compact price list is needed.",
					"Use only the pricingSummary values. Never invent prices, taxes, discounts, or availability.",
					"If selectedQuote is available, state the selected room, dates/nights, currency, and exact total.",
					"If multiple rooms are shown and no room is selected, present the best options briefly.",
					"If the guest wants to book and required details are missing, ask for the missing details in one natural sentence after the price.",
					"If the hotel is Zad Ajyad, make the Ajyad/direct-booking value feel special and honest without exaggerating.",
					"Do not say a reservation is created unless reservation context says it already exists.",
					`Agent name is ${agentName}.`,
				].join("\n"),
			},
			{
				role: "user",
				content: JSON.stringify({
					reservationDetails: bundle.reservationDetails,
					hotelDetails: bundle.hotelDetails,
					conversation: bundle.conversation,
					requestMetadata: bundle.requestMetadata,
					plan,
					pricingSummary: pricing,
					missingRequiredDetails: missing,
				}),
			},
		],
		{
			kind: OPENAI_FIRST_WRITER_KIND,
			temperature: 0.35,
			max_tokens: 420,
			reasoning_effort: "low",
		}
	);
	return cleanText(raw, 2400);
}

async function callReviewWriterOpenAI({ bundle, plan, pricing, slots, agentName }) {
	const raw = await chat(
		[
			{
				role: "system",
				content: [
					"You are preparing the final reservation review before the guest presses the Confirm booking button.",
					"Use requestMetadata.languageSignals: reply in the latest clear guest language; if the latest message is short or language-neutral, keep the preferred/current conversation language.",
					"Be concise and warm.",
					"List only verified details: hotel, room, check-in, check-out, nights, guest name, phone, nationality, adults, children, rooms, email if provided, and total.",
					"Make it explicit that the guest should press the Confirm booking button only if everything is correct.",
					"Do not say the reservation is created yet.",
					`Agent name is ${agentName}.`,
				].join("\n"),
			},
			{
				role: "user",
				content: JSON.stringify({
					reservationDetails: bundle.reservationDetails,
					hotelDetails: bundle.hotelDetails,
					conversation: bundle.conversation,
					requestMetadata: bundle.requestMetadata,
					plan,
					pricingSummary: pricing,
					normalizedReservationDetails: slots,
				}),
			},
		],
		{
			kind: OPENAI_FIRST_WRITER_KIND,
			temperature: 0.25,
			max_tokens: 420,
			reasoning_effort: "low",
		}
	);
	return cleanText(raw, 2400);
}

async function callReservationCreatedWriterOpenAI({
	bundle,
	plan,
	reservation,
	quote,
	links,
	agentName,
}) {
	const raw = await chat(
		[
			{
				role: "system",
				content: [
					"You are a hotel reception and reservation CSR sending the final booking-created message.",
					"Use requestMetadata.languageSignals: reply in the latest clear guest language; if the latest message is short or language-neutral, keep the preferred/current conversation language.",
					"Keep it professional, happy, and concise.",
					"State the exact confirmation number, dates, total, and links if present.",
					"Say the hotel team will review/confirm internally without making it sound alarming.",
					`Agent name is ${agentName}.`,
				].join("\n"),
			},
			{
				role: "user",
				content: JSON.stringify({
					reservationDetails: bundle.reservationDetails,
					hotelDetails: bundle.hotelDetails,
					conversation: bundle.conversation,
					requestMetadata: bundle.requestMetadata,
					plan,
					reservation: {
						id: idText(reservation?._id),
						confirmationNumber: reservation?.confirmation_number || "",
						checkinDate: reservation?.checkin_date || "",
						checkoutDate: reservation?.checkout_date || "",
						totalAmount: reservation?.total_amount || quote?.totals?.totalPriceWithCommission,
					},
					quote,
					links,
				}),
			},
		],
		{
			kind: OPENAI_FIRST_WRITER_KIND,
			temperature: 0.3,
			max_tokens: 420,
			reasoning_effort: "low",
		}
	);
	return cleanText(raw, 2400);
}

function emailSkippedInConversation(sc = {}) {
	const conversation = Array.isArray(sc.conversation) ? sc.conversation : [];
	return conversation.some((entry) => entry?.clientAction === "skip_email");
}

function emailAskedInConversation(sc = {}) {
	const conversation = Array.isArray(sc.conversation) ? sc.conversation : [];
	return conversation.some((entry) =>
		(entry.quickReplies || []).some((reply) => reply?.action === "skip_email")
	);
}

function normalizeSlots(plan = {}) {
	const details = plan.guestDetails || {};
	const totalGuests = numberOrNull(details.totalGuests);
	let adults = numberOrNull(details.adults);
	let children = numberOrNull(details.children);
	if (adults === null && totalGuests !== null) adults = Math.max(1, totalGuests);
	if (children === null && totalGuests !== null) children = 0;
	return {
		checkinISO: cleanText(plan.checkinISO, 20),
		checkoutISO: cleanText(plan.checkoutISO, 20),
		roomTypeKey: cleanText(plan.selectedRoomType || plan.roomTypeHint, 160),
		fullName: cleanText(details.fullName, 160),
		name: cleanText(details.fullName, 160),
		phone: cleanText(details.phone, 80),
		nationality: cleanText(details.nationality, 100),
		email: cleanText(details.email, 180),
		emailSkipped: details.emailSkipped === true,
		adults,
		children,
		rooms: Math.max(1, numberOrNull(details.rooms) || 1),
	};
}

function missingMandatoryDetails(slots = {}) {
	const missing = [];
	if (!validStayDates(slots.checkinISO, slots.checkoutISO)) missing.push("check-in and check-out dates");
	if (!slots.roomTypeKey) missing.push("room type");
	if (!slots.fullName) missing.push("full legal guest name");
	if (!slots.phone) missing.push("phone/WhatsApp number");
	if (!slots.nationality) missing.push("nationality");
	if (slots.adults === null || slots.adults === undefined) missing.push("adult count");
	if (slots.children === null || slots.children === undefined) missing.push("children count");
	if (!slots.rooms) missing.push("number of rooms");
	return missing;
}

function publicBaseUrl() {
	return String(
		process.env.CLIENT_URL ||
			process.env.REACT_APP_MAIN_URL_JANNAT ||
			"https://jannatbooking.com"
	).replace(/\/+$/, "");
}

function reservationLinks(reservation) {
	const base = publicBaseUrl();
	const confirmation = cleanText(reservation?.confirmation_number, 80);
	const id = idText(reservation?._id);
	return {
		reservationDetails: confirmation ? `${base}/single-reservation/${confirmation}` : "",
		payment: id && confirmation ? `${base}/client-payment/${id}/${confirmation}` : "",
	};
}

function summaryRoomMatchesQuote(summary = {}, quote = {}) {
	const room = quote?.room || {};
	return (
		(idText(summary.roomId) && idText(summary.roomId) === idText(room._id)) ||
		(summary.roomType &&
			roomSelectionKey(summary) &&
			roomSelectionKey(summary) === roomSelectionKey(room)) ||
		(summary.displayName &&
			roomSelectionDisplayKey(summary) &&
			roomSelectionDisplayKey(summary) === roomSelectionDisplayKey(room))
	);
}

function quoteForCreate(hotel = {}, plan = {}, pricing = null) {
	const room = matchRoom(hotel, plan.roomTypeHint, plan.selectedRoomType);
	if (!room || !validStayDates(plan.checkinISO, plan.checkoutISO)) return null;
	const quote = priceRoomForStay(
		hotel,
		{ roomType: room.roomType },
		plan.checkinISO,
		plan.checkoutISO
	);
	if (quote?.available && pricing?.selectedQuote) {
		const selectedMatches =
			summaryRoomMatchesQuote(pricing.selectedQuote, quote) ||
			!pricing.selectedQuote.roomType;
		if (selectedMatches && pricing.selectedQuote.available !== true) return null;
	}
	if (quote?.available && Array.isArray(pricing?.rooms)) {
		const summary = pricing.rooms.find((candidate) =>
			summaryRoomMatchesQuote(candidate, quote)
		);
		if (summary && summary.available !== true) return null;
	}
	return quote?.available ? quote : null;
}

async function callReservationCreateIssueWriterOpenAI({
	bundle,
	plan,
	pricing,
	error,
	agentName,
}) {
	const raw = await chat(
		[
			{
				role: "system",
				content: [
					"You are a hotel reception and reservation CSR.",
					"Use requestMetadata.languageSignals: reply in the latest clear guest language; if the latest message is short or language-neutral, keep the preferred/current conversation language.",
					"Keep it concise and reassuring.",
					"The reservation could not be created because availability or reservation validation failed.",
					"Do not say the reservation was created. Ask for another date range or another room type.",
					"Use only the provided pricingSummary and error message; never invent availability.",
					`Agent name is ${agentName}.`,
				].join("\n"),
			},
			{
				role: "user",
				content: JSON.stringify({
					reservationDetails: bundle.reservationDetails,
					hotelDetails: bundle.hotelDetails,
					conversation: bundle.conversation,
					requestMetadata: bundle.requestMetadata,
					plan,
					pricingSummary: pricing,
					errorMessage: cleanText(error?.message || error, 500),
				}),
			},
		],
		{
			kind: OPENAI_FIRST_WRITER_KIND,
			temperature: 0.25,
			max_tokens: 260,
			reasoning_effort: "low",
		}
	);
	return cleanText(raw, 1600);
}

async function composeReply(sc, hotel, agentName) {
	memoryTrace("compose:start", sc?._id);
	const fastReply = fastHotelFactReply(sc, hotel, agentName);
	if (fastReply) {
		memoryTrace("compose:fast_fact", sc?._id, {
			textLength: fastReply.text.length,
		});
		return { ...fastReply, fast: true };
	}
	const bundle = await contextBundle(sc, hotel);
	memoryTrace("compose:after_context", sc?._id, {
		conversationTurns: Array.isArray(bundle.conversation)
			? bundle.conversation.length
			: 0,
	});
	const plan = await callPlanOpenAI(bundle, agentName);
	memoryTrace("compose:after_plan", sc?._id, {
		nextAction: plan.nextAction,
		needsPricing: plan.needsPricing,
		hasDates: validStayDates(plan.checkinISO, plan.checkoutISO),
	});
	const language = languageOf(sc, plan);
	const latestAction = lastGuestAction(sc);
	const slots = normalizeSlots(plan);
	let pricingHotel = hotel;
	if (
		validStayDates(plan.checkinISO, plan.checkoutISO) &&
		(plan.needsPricing ||
			plan.wantsToBook ||
			["quote_with_pricing", "send_review", "create_reservation_after_button"].includes(
				plan.nextAction
			) ||
			["continue_booking", "confirm_reservation"].includes(latestAction))
	) {
		memoryTrace("compose:before_pricing_hotel", sc?._id, {
			dates: stayDateKeys(plan.checkinISO, plan.checkoutISO).length,
		});
		pricingHotel =
			(await getHotelByIdWithPricingDates(
				idText(hotel?._id || sc.hotelId),
				stayDateKeys(plan.checkinISO, plan.checkoutISO)
			).catch(() => null)) || hotel;
		memoryTrace("compose:after_pricing_hotel", sc?._id, {
			rooms: Array.isArray(pricingHotel?.roomCountDetails)
				? pricingHotel.roomCountDetails.length
				: 0,
			pricingRows: Array.isArray(pricingHotel?.roomCountDetails)
				? pricingHotel.roomCountDetails.reduce(
						(sum, room) =>
							sum + (Array.isArray(room?.pricingRate) ? room.pricingRate.length : 0),
						0
				  )
				: 0,
		});
	}
	const pricing =
		plan.needsPricing || validStayDates(plan.checkinISO, plan.checkoutISO)
			? await pricingSummaryForStay(pricingHotel, plan, { caseId: idText(sc) })
			: null;
	if (pricing) {
		memoryTrace("compose:after_pricing_summary", sc?._id, {
			rooms: Array.isArray(pricing.rooms) ? pricing.rooms.length : 0,
			selectedAvailable: pricing.selectedQuote?.available,
		});
	}

	if (latestAction === "correction") {
		return {
			text:
				plan.replyIfNoPricing ||
				"Of course. Please tell me which detail you would like me to correct.",
			language,
			quickReplies: [],
		};
	}

	if (latestAction === "confirm_reservation" || plan.nextAction === "create_reservation_after_button") {
		if (latestAction !== "confirm_reservation") {
			const reviewText = await callReviewWriterOpenAI({
				bundle,
				plan,
				pricing,
				slots,
				agentName,
			});
			return {
				text: reviewText,
				language,
				quickReplies: localizedQuickReplies("confirm_reservation", language),
			};
		}
		const missing = missingMandatoryDetails(slots);
		const quote = quoteForCreate(pricingHotel, plan, pricing);
		if (!quote && !missing.length) {
			const text = await callReservationCreateIssueWriterOpenAI({
				bundle,
				plan,
				pricing,
				error: new Error(
					pricing?.selectedQuote?.inventoryMessage ||
						pricing?.selectedQuote?.reason ||
						"Selected room is not available for the full stay."
				),
				agentName,
			}).catch(() => {
				return (
					plan.replyIfNoPricing ||
					"The selected room is not available for the full stay. Please send another date range or another room type and I will check it right away."
				);
			});
			return { text, language, quickReplies: [] };
		}
		if (missing.length || !quote) {
			const text =
				plan.askForMissingDetailsReply ||
				plan.replyIfNoPricing ||
				`Please share the missing details before I create the reservation: ${missing.join(", ")}.`;
			return { text, language, quickReplies: [] };
		}
		let reservation = null;
		try {
			reservation = await createReservationForCase({
				caseId: idText(sc),
				hotel: pricingHotel,
				slots: {
					...slots,
					roomTypeKey: quote.room?.roomType || slots.roomTypeKey,
					name: slots.fullName,
				},
				quoteData: quote,
				room: quote.room,
			});
		} catch (error) {
			const text = await callReservationCreateIssueWriterOpenAI({
				bundle,
				plan,
				pricing,
				error,
				agentName,
			}).catch(() => {
				return (
					plan.replyIfNoPricing ||
					"The selected option is no longer available for the full stay. Please send another date range or another room type and I will check it right away."
				);
			});
			return { text, language, quickReplies: [] };
		}
		const links = reservationLinks(reservation);
		const text = await callReservationCreatedWriterOpenAI({
			bundle,
			plan,
			reservation,
			quote,
			links,
			agentName,
		});
		const timer = setTimeout(() => {
			dispatchAiReservationConfirmation({
				caseId: idText(sc),
				reservation,
				mode: "initial",
				includeGuestEmail: Boolean(slots.email),
				includeInternalEmail: true,
				includeOwnerEmail: true,
				includeGuestWhatsApp: false,
				includeAdminWhatsApp: true,
				guestEmail: slots.email || "",
			}).catch((error) => {
				console.error("[aiagent:openai-first] confirmation dispatch failed:", {
					caseId: idText(sc),
					confirmation: reservation?.confirmation_number,
					error: error?.message || error,
				});
			});
		}, CONFIRMATION_DISPATCH_DELAY_MS);
		if (typeof timer.unref === "function") timer.unref();
		return { text, language, quickReplies: [] };
	}

	if (plan.nextAction === "ask_dates" || (plan.needsPricing && !validStayDates(plan.checkinISO, plan.checkoutISO))) {
		return {
			text:
				plan.askForDatesReply ||
				plan.replyIfNoPricing ||
				"Please send the check-in and check-out dates so I can check the exact price.",
			language,
			quickReplies: [],
		};
	}

	if (plan.needsPricing && validStayDates(plan.checkinISO, plan.checkoutISO)) {
		const missing =
			plan.wantsToBook || latestAction === "continue_booking"
				? missingMandatoryDetails(slots).filter(
						(item) =>
							![
								"check-in and check-out dates",
								"room type",
								"number of rooms",
							].includes(item)
				  )
				: [];
		memoryTrace("compose:before_pricing_writer", sc?._id, {
			missing: missing.length,
		});
		const text = await callPricingWriterOpenAI({
			bundle,
			plan,
			pricing,
			missing,
			agentName,
		});
		memoryTrace("compose:after_pricing_writer", sc?._id, {
			textLength: text.length,
		});
		const anyAvailable = Boolean(
			pricing?.selectedQuote?.available || pricing?.rooms?.some((room) => room.available)
		);
		return {
			text,
			language,
			quickReplies: anyAvailable
				? localizedQuickReplies("continue_booking", language)
				: [],
		};
	}

	if (latestAction === "continue_booking" || plan.nextAction === "ask_booking_details") {
		const missing = missingMandatoryDetails(slots).filter(
			(item) => item !== "number of rooms"
		);
		if (missing.length) {
			return {
				text:
					plan.askForMissingDetailsReply ||
					plan.replyIfNoPricing ||
					`Please send these details so I can prepare the reservation: ${missing.join(", ")}.`,
				language,
				quickReplies: [],
			};
		}
	}

	if (plan.nextAction === "ask_optional_email") {
		if (!slots.email && !emailSkippedInConversation(sc)) {
			return {
				text:
					plan.replyIfNoPricing ||
					"If you would like, you can share an email for the reservation links, or skip it.",
				language,
				quickReplies: localizedQuickReplies("skip_email", language),
			};
		}
	}

	if (
		(plan.nextAction === "send_review" || latestAction === "skip_email") &&
		validStayDates(slots.checkinISO, slots.checkoutISO)
	) {
		const missing = missingMandatoryDetails(slots);
		if (missing.length) {
			return {
				text:
					plan.askForMissingDetailsReply ||
					plan.replyIfNoPricing ||
					`Please send these details so I can prepare the review: ${missing.join(", ")}.`,
				language,
				quickReplies: [],
			};
		}
		if (!slots.email && !emailSkippedInConversation(sc) && !emailAskedInConversation(sc)) {
			return {
				text:
					plan.replyIfNoPricing ||
					"Email is optional. You can share it for the reservation links, or choose Skip.",
				language,
				quickReplies: localizedQuickReplies("skip_email", language),
			};
		}
		const reviewText = await callReviewWriterOpenAI({
			bundle,
			plan,
			pricing,
			slots,
			agentName,
		});
		return {
			text: reviewText,
			language,
			quickReplies: localizedQuickReplies("confirm_reservation", language),
		};
	}

	if (plan.needsHumanEscalation && plan.replyIfNoPricing) {
		return { text: plan.replyIfNoPricing, language, quickReplies: [] };
	}

	return {
		text:
			plan.replyIfNoPricing ||
			"I am with you. Please tell me a little more so I can help correctly.",
		language,
		quickReplies: [],
	};
}

async function draftGreeting(sc, hotel, agentName) {
	const hotelName =
		cleanText(hotel?.hotelName_OtherLanguage, 120) ||
		cleanText(hotel?.hotelName, 120) ||
		"Jannat Booking";
	const lang = String(
		sc.preferredLanguage || sc.preferredLanguageCode || languageOf(sc, {})
	).toLowerCase();
	if (lang.includes("arabic") || /\bar\b/.test(lang)) {
		return `\u0627\u0644\u0633\u0644\u0627\u0645 \u0639\u0644\u064a\u0643\u0645\u060c \u0645\u0639\u0643 ${agentName} \u0645\u0646 \u0627\u0633\u062a\u0642\u0628\u0627\u0644 \u0648\u062d\u062c\u0648\u0632\u0627\u062a ${hotelName}. \u0643\u064a\u0641 \u0623\u0642\u062f\u0631 \u0623\u0633\u0627\u0639\u062f\u0643 \u0627\u0644\u064a\u0648\u0645\u061f`;
	}
	if (lang.includes("spanish") || /\bes\b/.test(lang)) {
		return `Assalamu alaikum, soy ${agentName} de recepcion y reservas de ${hotelName}. Como puedo ayudarte hoy?`;
	}
	if (lang.includes("french") || /\bfr\b/.test(lang)) {
		return `Assalamu alaikum, je suis ${agentName} de la reception et reservations de ${hotelName}. Comment puis-je vous aider aujourd'hui?`;
	}
	return `Assalamu alaikum, this is ${agentName} from ${hotelName} reception and reservations. How may I help you today?`;
}

async function runTurn(io, caseId) {
	if (!io || !caseId) return false;
	if (activeTurns.has(caseId)) {
		activeTurns.set(caseId, { queued: true });
		return true;
	}
	activeTurns.set(caseId, { queued: false });
	let typingOn = false;
	let agentName = "Aisha";
	let currentHotel = null;
	let turnStartedAt = new Date();
	try {
		memoryTrace("turn:start", caseId);
		const sc = await getSupportCaseById(caseId);
		memoryTrace("turn:after_case", caseId, {
			conversationTurns: Array.isArray(sc?.conversation) ? sc.conversation.length : 0,
		});
		if (!sc) return false;
		const policy = await ensureAIAllowed(sc.hotelId, sc, {
			includePricingRate: false,
		});
		memoryTrace("turn:after_policy", caseId, {
			allowed: policy.allowed,
			hasHotel: Boolean(policy.hotel),
			rooms: Array.isArray(policy.hotel?.roomCountDetails)
				? policy.hotel.roomCountDetails.length
				: 0,
		});
		if (!policy.allowed) return false;
		const hotel =
			policy.hotel || (sc.hotelId ? await getHotelByIdForAiContext(sc.hotelId) : null);
		currentHotel = hotel;
		agentName = agentNameForCase(sc);
		const latestGuest = latestGuestMessage(sc);
		const needsGreeting = !hasAiMessage(sc) && !latestGuest;
		if (!needsGreeting && !latestGuestNeedsAiReply(sc)) return false;

		if (latestGuest) {
			const latestAt = entryTime(latestGuest);
			const activityAt = Math.max(latestAt, Number(guestActivity.get(caseId) || 0));
			const quietRemaining = activityAt + QUIET_MS - now();
			if (quietRemaining > 25) {
				scheduleOpenAiFirstTurn(io, caseId, { delayMs: quietRemaining + 25 });
				return true;
			}
		}

		turnStartedAt = new Date();
		const startedMs = now();
		const latestGuestText = cleanText(latestGuest?.message, 1200);
		const latestGuestRawText = String(latestGuest?.message || "").trim();
		let targetReplyMs = needsGreeting
			? randomBetween(1200, 2200)
			: randomBetween(TARGET_REPLY_MIN_MS, TARGET_REPLY_MAX_MS);
		emitTyping(io, caseId, agentName, true);
		typingOn = true;

		const response = needsGreeting
			? {
					text: await draftGreeting(sc, hotel, agentName),
					language: languageOf(sc, {}),
					quickReplies: [],
			  }
			: await withTimeout(
					composeReply(sc, hotel, agentName),
					COMPOSE_DEADLINE_MS,
					"OpenAI-first reply composition"
			  );
		if (response.fast === true) {
			targetReplyMs = Math.min(targetReplyMs, randomBetween(900, 1800));
		}
		memoryTrace("turn:after_response", caseId, {
			textLength: response.text?.length || 0,
			quickReplies: Array.isArray(response.quickReplies)
				? response.quickReplies.length
				: 0,
		});

		const elapsed = now() - startedMs;
		if (elapsed < targetReplyMs && elapsed < MAX_TOTAL_WAIT_MS) {
			await sleep(Math.min(targetReplyMs - elapsed, MAX_TOTAL_WAIT_MS - elapsed));
		}

		const fresh = await getSupportCaseById(caseId);
		if (!fresh) return false;
		if (!needsGreeting) {
			const freshLatest = latestGuestMessage(fresh);
			const freshText = cleanText(freshLatest?.message, 1200);
			if (freshText !== latestGuestText || hasAiAfter(fresh, entryTime(latestGuest))) {
				scheduleOpenAiFirstTurn(io, caseId, { delayMs: QUIET_MS });
				return true;
			}
		} else if (hasAiMessage(fresh)) {
			return false;
		}

		emitTyping(io, caseId, agentName, false);
		typingOn = false;
		await appendAiMessage(io, fresh, response.text, {
			language: response.language,
			quickReplies: response.quickReplies || [],
			requireLatestGuestText: needsGreeting ? "" : latestGuestRawText,
			turnStartedAt,
		});
		memoryTrace("turn:after_append", caseId);
		return true;
	} catch (error) {
		console.error("[aiagent:openai-first] turn failed:", {
			caseId,
			error: error?.message || error,
		});
		try {
			const fresh = await getSupportCaseById(caseId);
			if (fresh && latestGuestNeedsAiReply(fresh)) {
				const policy = await ensureAIAllowed(fresh.hotelId, fresh, {
					includePricingRate: false,
				}).catch(() => ({ allowed: false, hotel: null }));
				if (policy.allowed) {
					const hotel =
						policy.hotel ||
						currentHotel ||
						(fresh.hotelId ? await getHotelByIdForAiContext(fresh.hotelId) : null);
					const latestGuest = latestGuestMessage(fresh);
					const latestGuestRawText = String(latestGuest?.message || "").trim();
					const response = fallbackReply(fresh, hotel, agentName, error);
					if (typingOn) {
						emitTyping(io, caseId, agentName, false);
						typingOn = false;
					}
					await appendAiMessage(io, fresh, response.text, {
						language: response.language,
						quickReplies: response.quickReplies || [],
						requireLatestGuestText: latestGuestRawText,
						turnStartedAt,
					});
					memoryTrace("turn:after_fallback_append", caseId, {
						textLength: response.text?.length || 0,
					});
					return true;
				}
			}
		} catch (fallbackError) {
			console.error("[aiagent:openai-first] fallback append failed:", {
				caseId,
				error: fallbackError?.message || fallbackError,
			});
		}
		return false;
	} finally {
		if (typingOn) emitTyping(io, caseId, agentName, false);
		const state = activeTurns.get(caseId);
		activeTurns.delete(caseId);
		if (state?.queued) scheduleOpenAiFirstTurn(io, caseId, { delayMs: QUIET_MS });
	}
}

function markOpenAiFirstGuestActivity(caseId, { typingHoldMs = 0 } = {}) {
	const id = idText(caseId);
	if (!id) return;
	guestActivity.set(id, now() + Math.max(0, Number(typingHoldMs) || 0));
}

function scheduleOpenAiFirstTurn(io, caseOrId, { delayMs = 75 } = {}) {
	const caseId = idText(caseOrId);
	if (!io || !caseId) return false;
	const existing = scheduledTurns.get(caseId);
	if (existing) clearTimeout(existing);
	const timer = setTimeout(() => {
		scheduledTurns.delete(caseId);
		runTurn(io, caseId).catch((error) => {
			console.error("[aiagent:openai-first] scheduled turn error:", error?.message || error);
		});
	}, Math.max(0, Number(delayMs) || 0));
	if (typeof timer.unref === "function") timer.unref();
	scheduledTurns.set(caseId, timer);
	return true;
}

function wireOpenAiFirstSocket(io) {
	io.on("connection", (socket) => {
		socket.on("joinRoom", async ({ caseId }) => {
			try {
				const id = idText(caseId);
				if (!id) return;
				socket.join(id);
				const sc = await getSupportCaseById(id);
				if (!sc) return;
				const policy = await ensureAIAllowed(sc.hotelId, sc, {
					includePricingRate: false,
				});
				if (!policy.allowed) return;
				if (!hasAiMessage(sc) || latestGuestNeedsAiReply(sc)) {
					scheduleOpenAiFirstTurn(io, id, { delayMs: 75 });
				}
			} catch (error) {
				console.error("[aiagent:openai-first] joinRoom error:", error?.message || error);
			}
		});

		socket.on("typing", ({ caseId }) => {
			markOpenAiFirstGuestActivity(caseId, { typingHoldMs: GUEST_TYPING_HOLD_MS });
		});

		socket.on("sendMessage", (message = {}) => {
			const caseId = idText(message.caseId);
			if (!caseId) return;
			markOpenAiFirstGuestActivity(caseId);
			scheduleOpenAiFirstTurn(io, caseId, { delayMs: 75 });
		});
	});
	console.log("[aiagent] OpenAI-first socket planner active.");
}

module.exports = {
	scheduleOpenAiFirstTurn,
	wireOpenAiFirstSocket,
	markOpenAiFirstGuestActivity,
	DEFAULT_AGENT_POOL,
};
