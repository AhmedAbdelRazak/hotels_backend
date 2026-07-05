const { chat } = require("../core/openai");
const { mapRoomToKey, quickDateRange, digitsToEnglish } = require("../core/nlu");

const MAX_CONTEXT_MESSAGES = 18;

const cleanString = (value = "", max = 1000) =>
	String(value || "")
		.replace(/\u0000/g, "")
		.trim()
		.slice(0, max);

const normalizeId = (value) =>
	String(value?._id || value?.id || value || "")
		.trim()
		.toLowerCase();

const ROOM_TYPE_KEYS = new Set([
	"singleRooms",
	"doubleRooms",
	"tripleRooms",
	"quadRooms",
	"familyRooms",
	"suite",
]);

const ROOM_TYPE_ALIASES = {
	single: "singleRooms",
	singleroom: "singleRooms",
	singlerooms: "singleRooms",
	double: "doubleRooms",
	doubleroom: "doubleRooms",
	doublerooms: "doubleRooms",
	twin: "doubleRooms",
	twinroom: "doubleRooms",
	twinrooms: "doubleRooms",
	standard: "doubleRooms",
	standardroom: "doubleRooms",
	triple: "tripleRooms",
	tripleroom: "tripleRooms",
	triplerooms: "tripleRooms",
	quad: "quadRooms",
	quadroom: "quadRooms",
	quadrooms: "quadRooms",
	quadruple: "quadRooms",
	quadrupleroom: "quadRooms",
	quadruplerooms: "quadRooms",
	family: "familyRooms",
	familyroom: "familyRooms",
	familyrooms: "familyRooms",
	quintuple: "familyRooms",
	quintupleroom: "familyRooms",
	quintuplerooms: "familyRooms",
	suite: "suite",
	suiteroom: "suite",
	suites: "suite",
};

function canonicalRoomTypeKey(value = "") {
	const raw = cleanString(value, 120);
	if (!raw) return "";
	if (ROOM_TYPE_KEYS.has(raw)) return raw;
	const compact = raw.toLowerCase().replace(/[\s_-]+/g, "");
	if (ROOM_TYPE_ALIASES[compact]) return ROOM_TYPE_ALIASES[compact];
	return mapRoomToKey(raw) || "";
}

function parseJsonObject(text = "") {
	const cleaned = String(text || "").trim();
	if (!cleaned) return {};
	try {
		return JSON.parse(cleaned);
	} catch {
		const start = cleaned.indexOf("{");
		const end = cleaned.lastIndexOf("}");
		if (start >= 0 && end > start) {
			try {
				return JSON.parse(cleaned.slice(start, end + 1));
			} catch {
				return {};
			}
		}
	}
	return {};
}

function languageCodeFromCase(supportCase = {}) {
	const code = cleanString(supportCase.preferredLanguageCode, 20).toLowerCase();
	if (code) return code;
	const name = cleanString(supportCase.preferredLanguage, 80).toLowerCase();
	if (name.includes("arabic")) return "ar";
	if (name.includes("urdu")) return "ur";
	if (name.includes("hindi")) return "hi";
	if (name.includes("spanish")) return "es";
	if (name.includes("french")) return "fr";
	if (name.includes("indonesian")) return "id";
	if (name.includes("malay")) return "ms";
	return "en";
}

function isGuestEntry(entry = {}) {
	if (!entry || entry.isAi || entry.isSystem) return false;
	const email = String(entry.messageBy?.customerEmail || "").trim().toLowerCase();
	const userId = String(entry.messageBy?.userId || "").trim().toLowerCase();
	return (
		email !== "support@jannatbooking.com" &&
		email !== "management@xhotelpro.com" &&
		userId !== "jannat-ai-support" &&
		userId !== "jannat-system" &&
		userId !== "system"
	);
}

function compactConversation(supportCase = {}) {
	const conversation = Array.isArray(supportCase.conversation)
		? supportCase.conversation
		: [];
	return conversation.slice(-MAX_CONTEXT_MESSAGES).map((entry) => ({
		role: isGuestEntry(entry) ? "guest" : entry?.isSystem ? "system" : "support",
		name: cleanString(entry?.messageBy?.customerName, 80),
		message: cleanString(entry?.message, 1200),
		action: cleanString(entry?.clientAction, 80),
	}));
}

function latestGuestText(supportCase = {}) {
	const conversation = Array.isArray(supportCase.conversation)
		? supportCase.conversation
		: [];
	for (let index = conversation.length - 1; index >= 0; index -= 1) {
		if (isGuestEntry(conversation[index])) {
			return cleanString(conversation[index].message, 2000);
		}
	}
	return "";
}

function allGuestText(supportCase = {}) {
	return (Array.isArray(supportCase.conversation) ? supportCase.conversation : [])
		.filter(isGuestEntry)
		.map((entry) => cleanString(entry.message, 1200))
		.filter(Boolean)
		.join("\n");
}

function isGreetingOnly(text = "") {
	const normalized = cleanString(text, 180).toLowerCase();
	if (!normalized) return true;
	return /^(hi|hello|hey|salam|salaam|assalamu alaikum|assalamualaikum|good (morning|evening|afternoon)|السلام عليكم|مساء الخير|صباح الخير|اهلا|أهلا|مرحبا)[\s!.،]*$/i.test(
		normalized
	);
}

function hasHotelRoutingSignal(text = "") {
	const normalized = cleanString(digitsToEnglish(text), 3000).toLowerCase();
	return /(?:book|booking|reserve|reservation|room|hotel|night|price|rate|availability|available|check[ -]?in|checkout|location|haram|makkah|madinah|double|triple|quad|family|suite|5 bed|خمس|غرف|غرفة|حجز|فندق|ليلة|سعر|متاح|توفر|دخول|خروج|الحرم|مكة|المدينة|مزدوج|ثلاث|رباع|عائل|جناح)/i.test(
		normalized
	);
}

function intOrNull(value) {
	const number = Number(value);
	return Number.isFinite(number) && number >= 0 ? number : null;
}

function guestCountFacts(text = "") {
	const normalized = cleanString(digitsToEnglish(text), 2000).toLowerCase();
	let adults = null;
	let children = null;
	const adultsMatch =
		normalized.match(/(\d{1,2})\s*(?:adult|adults|بالغ|كبار|راشد)/i) ||
		normalized.match(/(?:adult|adults|بالغ|كبار|راشد)\D{0,10}(\d{1,2})/i);
	const childrenMatch =
		normalized.match(/(\d{1,2})\s*(?:child|children|kid|kids|طفل|اطفال|أطفال|ولد|ابن|بنت)/i) ||
		normalized.match(/(?:child|children|kid|kids|طفل|اطفال|أطفال|ولد|ابن|بنت)\D{0,10}(\d{1,2})/i);
	if (adultsMatch) adults = intOrNull(adultsMatch[1]);
	if (childrenMatch) children = intOrNull(childrenMatch[1]);
	if (adults === null && children === null) {
		const totalMatch =
			normalized.match(/(\d{1,2})\s*(?:people|persons|guests|pax|نفر|اشخاص|أشخاص|افراد|أفراد|ضيوف)/i) ||
			normalized.match(/(?:we are|for|عددنا|احنا|نحن)\D{0,12}(\d{1,2})/i);
		const totalGuests = totalMatch ? intOrNull(totalMatch[1]) : null;
		if (totalGuests !== null && totalGuests > 0) adults = totalGuests;
	}
	return {
		...(adults !== null ? { adults } : {}),
		...(children !== null ? { children } : {}),
	};
}

function normalizeRoomSelections(value = []) {
	return (Array.isArray(value) ? value : [])
		.map((selection) => ({
			roomTypeKey: canonicalRoomTypeKey(
				selection?.roomTypeKey || selection?.roomType || selection?.type
			),
			count: Math.max(1, Number(selection?.count || 1) || 1),
		}))
		.filter((selection) => selection.roomTypeKey)
		.slice(0, 6);
}

function inferredRoomSelectionFromGuests(facts = {}) {
	const adults = Number(facts.adults || 0);
	const children = Number(facts.children || 0);
	const total = adults + children;
	if (!total) return [];
	if (total === 1) return [{ roomTypeKey: "singleRooms", count: 1 }];
	if (total === 2) return [{ roomTypeKey: "doubleRooms", count: 1 }];
	if (total === 3) return [{ roomTypeKey: "tripleRooms", count: 1 }];
	if (total === 4) return [{ roomTypeKey: "quadRooms", count: 1 }];
	return [{ roomTypeKey: "familyRooms", count: Math.ceil(total / 5) }];
}

function roomCapacity(roomTypeKey = "") {
	return {
		singleRooms: 1,
		doubleRooms: 2,
		tripleRooms: 3,
		quadRooms: 4,
		familyRooms: 5,
		suite: 6,
	}[roomTypeKey] || 0;
}

function normalizeFacts(rawFacts = {}, supportCase = {}) {
	const text = allGuestText(supportCase);
	const latestText = latestGuestText(supportCase);
	const quickDates = quickDateRange(text);
	const latestRoomType = mapRoomToKey(latestText) || mapRoomToKey(text);
	const parsedGuestCounts = guestCountFacts(text);
	const facts = {
		...rawFacts,
		...parsedGuestCounts,
	};
	const explicitRoomType = canonicalRoomTypeKey(
		facts.roomTypeKey || facts.roomType || facts.roomText
	);
	if (explicitRoomType) facts.roomTypeKey = explicitRoomType;
	else if (facts.roomTypeKey) delete facts.roomTypeKey;
	if (quickDates?.checkinISO && quickDates?.checkoutISO) {
		facts.checkinISO = facts.checkinISO || quickDates.checkinISO;
		facts.checkoutISO = facts.checkoutISO || quickDates.checkoutISO;
		facts.dateCalendar = facts.dateCalendar || quickDates.raw?.calendar || "gregorian";
	}
	if (latestRoomType && !facts.roomTypeKey) facts.roomTypeKey = latestRoomType;
	facts.adults = intOrNull(facts.adults);
	facts.children = intOrNull(facts.children);
	if (facts.children === null) delete facts.children;
	if (facts.adults === null) delete facts.adults;
	let roomSelections = normalizeRoomSelections(facts.roomSelections);
	if (!roomSelections.length && facts.roomTypeKey) {
		const totalGuests = Number(facts.adults || 0) + Number(facts.children || 0);
		const capacity = roomCapacity(facts.roomTypeKey);
		roomSelections = [
			{
				roomTypeKey: cleanString(facts.roomTypeKey, 40),
				count: Math.max(
					1,
					capacity && totalGuests
						? Math.ceil(totalGuests / capacity)
						: Number(facts.rooms || 1) || 1
				),
			},
		];
	}
	if (!roomSelections.length) {
		roomSelections = inferredRoomSelectionFromGuests(facts);
	}
	if (roomSelections.length) {
		facts.roomSelections = roomSelections;
		facts.roomTypeKey = roomSelections.length === 1 ? roomSelections[0].roomTypeKey : facts.roomTypeKey || "";
		facts.rooms = roomSelections.reduce((total, selection) => total + selection.count, 0);
	}
	return Object.fromEntries(
		Object.entries(facts).filter(([, value]) => {
			if (value === null || value === undefined || value === "") return false;
			if (Array.isArray(value)) return value.length > 0;
			return true;
		})
	);
}

function fallbackPlan({ supportCase, candidateHotels = [] } = {}) {
	const text = latestGuestText(supportCase);
	const languageCode = languageCodeFromCase(supportCase);
	const hasSignal = hasHotelRoutingSignal(allGuestText(supportCase));
	const facts = normalizeFacts({}, supportCase);
	const priority = candidateHotels[0] || {};
	if (!hasSignal && isGreetingOnly(text)) {
		return {
			action: "platform_reply",
			targetHotelId: "",
			facts,
			reply: /^ar\b/i.test(languageCode)
				? "أهلًا وسهلًا بك في دعم جنات بوكينج. أخبرني بما تحتاجه، وسأوصلك بالفريق المناسب بكل سرور."
				: "Welcome to Jannat Booking support. Tell me what you need, and I will connect you with the right hotel team.",
			reason: "greeting_without_request",
		};
	}
	return {
		action: "transfer_to_hotel",
		targetHotelId: normalizeId(priority._id),
		facts,
		reply: "",
		reason: hasSignal ? "hotel_or_booking_request" : "platform_support_default_transfer",
	};
}

async function planJannatTurn({ supportCase, candidateHotels = [] } = {}) {
	const fallback = fallbackPlan({ supportCase, candidateHotels });
	if (!process.env.OPENAI_API_KEY) return fallback;

	const languageCode = languageCodeFromCase(supportCase);
	const messages = [
		{
			role: "system",
			content: [
				"Return valid json only.",
				"You are the Jannat Booking platform-support brain, not a hotel receptionist.",
				"Your job is to understand the guest, keep reusable booking facts, and decide whether to transfer the same chat to a hotel reception.",
				"The orchestrator will execute your plan. Do not invent hotel IDs. Choose targetHotelId only from candidateHotels.",
				"Prefer candidateHotels[0] unless the guest clearly asked for a different named candidate or the facts show the priority candidate is unsuitable.",
				"Most booking, availability, pricing, room, hotel-location, distance, and hotel-service requests should become action=transfer_to_hotel once enough reusable stay facts are captured.",
				"If the guest is asking to book, check price, or check availability but has not provided check-in/check-out dates and either room type or guest count, use action=platform_reply and ask only for the missing practical detail before transfer.",
				"When check-in/check-out plus room type or guest count are known, use action=transfer_to_hotel so the orchestrator can show the recommended/required room pricing before the guest is connected to reception.",
				"If the guest only greeted Jannat support and gave no request yet, action=platform_reply and ask one warm open question.",
				"Preserve facts the guest already gave: checkinISO, checkoutISO, adults, children, roomTypeKey, roomSelections, budget, guestName, phone, nationality, questionSummary.",
				"For five guests, familyRooms is usually the best roomTypeKey; for ten guests, prefer two familyRooms if no specific room was requested.",
				"Use languageCode for reply language.",
				'JSON shape: {"action":"transfer_to_hotel|platform_reply","targetHotelId":"","facts":{},"reply":"","reason":""}',
			].join("\n"),
		},
		{
			role: "user",
			content: JSON.stringify(
				{
					languageCode,
					caseInfo: {
						id: normalizeId(supportCase?._id),
						displayName1: supportCase?.displayName1 || "",
						clientName: supportCase?.clientName || "",
						clientContact: supportCase?.clientContact || "",
						sourcePage: supportCase?.sourcePage || "",
					},
					candidateHotels: candidateHotels.map((hotel, index) => ({
						index,
						_id: normalizeId(hotel._id),
						hotelName: hotel.hotelName || "",
						hotelName_OtherLanguage: hotel.hotelName_OtherLanguage || "",
						city: hotel.hotelCity || hotel.city || "",
						distances: hotel.distances || {},
					})),
					conversation: compactConversation(supportCase),
				},
				null,
				2
			),
		},
	];

	try {
		const raw = await chat(messages, {
			kind: "nlu",
			temperature: 0.1,
			max_tokens: 550,
			response_format: { type: "json_object" },
		});
		const parsed = parseJsonObject(raw);
		const action = ["transfer_to_hotel", "platform_reply"].includes(parsed.action)
			? parsed.action
			: fallback.action;
		const candidateIds = new Set(candidateHotels.map((hotel) => normalizeId(hotel._id)));
		const targetHotelId = candidateIds.has(normalizeId(parsed.targetHotelId))
			? normalizeId(parsed.targetHotelId)
			: fallback.targetHotelId;
		return {
			action,
			targetHotelId: action === "transfer_to_hotel" ? targetHotelId : "",
			facts: normalizeFacts(parsed.facts || {}, supportCase),
			reply: cleanString(parsed.reply || fallback.reply, 1200),
			reason: cleanString(parsed.reason || fallback.reason, 200),
		};
	} catch (error) {
		console.warn("[jannatSupport] brain fallback:", error?.message || error);
		return fallback;
	}
}

module.exports = {
	planJannatTurn,
	__test: {
		fallbackPlan,
		normalizeFacts,
		hasHotelRoutingSignal,
		isGreetingOnly,
	},
};
