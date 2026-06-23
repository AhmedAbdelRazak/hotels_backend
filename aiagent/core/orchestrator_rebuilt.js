const { chat } = require("./openai");
const { ensureAIAllowed } = require("./policy");
const {
	getSupportCaseById,
	updateSupportCaseAppendIfNoRecentAiDuplicate,
} = require("./db");
const { mapRoomToKey, quickDateRange, digitsToEnglish } = require("./nlu");
const { priceRoomForStay, listAvailableRoomsForStay } = require("./selectors");
const {
	createReservationForCase,
	dispatchAiReservationConfirmation,
} = require("./actions");
const {
	normalizeCountryCode,
	countryNameFromCode,
} = require("./countryCodes");

const SUPPORT_EMAIL = "support@jannatbooking.com";
const SUPPORT_USER_ID = "jannat-ai-support";
const AI_TURN_TIMER_MS = 100;
const MAX_TRANSCRIPT_CHARS = 18000;
const MAX_FACT_CHARS = 12000;

const timers = new Map();
const inFlight = new Set();
const queued = new Set();

const AR = {
	completeReservation: "\u0625\u062a\u0645\u0627\u0645 \u0627\u0644\u062d\u062c\u0632",
	somethingWrong: "\u0641\u064a \u062a\u0639\u062f\u064a\u0644",
	noProblem: "\u062a\u0645\u0627\u0645\u060c \u0623\u062e\u0628\u0631\u0646\u064a \u0645\u0627 \u0627\u0644\u062a\u0639\u062f\u064a\u0644 \u0627\u0644\u0645\u0637\u0644\u0648\u0628 \u0639\u0644\u0649 \u0627\u0644\u062d\u062c\u0632 \u0648\u0633\u0623\u0631\u0627\u062c\u0639\u0647 \u0645\u0639\u0643.",
	hello: "\u0627\u0644\u0633\u0644\u0627\u0645 \u0639\u0644\u064a\u0643\u0645",
};

function asId(value = "") {
	return String(value?._id || value || "").trim();
}

function cleanText(value = "", max = 2000) {
	return digitsToEnglish(String(value || ""))
		.replace(/\r\n/g, "\n")
		.replace(/\s+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim()
		.slice(0, max);
}

function clip(value = "", max = 1000) {
	const text = cleanText(value, max + 100);
	if (text.length <= max) return text;
	return `${text.slice(0, Math.max(0, max - 24)).trim()}...`;
}

function isSupportIdentity(message = {}) {
	const by = message.messageBy || {};
	const email = String(by.customerEmail || "").trim().toLowerCase();
	const userId = String(by.userId || "").trim().toLowerCase();
	return (
		email === SUPPORT_EMAIL ||
		userId === SUPPORT_USER_ID ||
		userId === "jannat-system" ||
		userId === "system"
	);
}

function isGuestMessage(message = {}) {
	if (!message || message.isAi || message.isSystem) return false;
	return !isSupportIdentity(message);
}

function isAiMessage(message = {}) {
	return Boolean(message?.isAi || isSupportIdentity(message));
}

function latestGuestTurn(supportCase = {}) {
	const conversation = Array.isArray(supportCase.conversation)
		? supportCase.conversation
		: [];
	for (let index = conversation.length - 1; index >= 0; index -= 1) {
		const message = conversation[index];
		if (!isGuestMessage(message)) continue;
		const hasAiAfter = conversation
			.slice(index + 1)
			.some((row) => isAiMessage(row) || row?.isSystem);
		return { message, index, hasAiAfter };
	}
	return null;
}

function messageFingerprint(message = {}) {
	return [
		String(message._id || ""),
		String(message.clientTag || ""),
		String(message.date || ""),
		cleanText(message.message || "", 300),
		String(message.messageBy?.customerEmail || "").trim().toLowerCase(),
	].join("|");
}

function hasFinalReviewPrompt(supportCase = {}) {
	const conversation = Array.isArray(supportCase.conversation)
		? supportCase.conversation
		: [];
	let finalIndex = -1;
	let latestGuestIndex = -1;
	for (let index = 0; index < conversation.length; index += 1) {
		const message = conversation[index];
		if (isGuestMessage(message)) latestGuestIndex = index;
		if (
			isAiMessage(message) &&
			(message.quickReplies || []).some(
				(reply) => String(reply?.action || "") === "place_reservation"
			)
		) {
			finalIndex = index;
		}
	}
	if (finalIndex < 0 || latestGuestIndex <= finalIndex) return false;
	const correctionAfterFinal = conversation
		.slice(finalIndex + 1, latestGuestIndex + 1)
		.some((message) => {
			if (!isGuestMessage(message)) return false;
			const action = String(message.clientAction || "").trim();
			const text = String(message.message || "").toLowerCase();
			return (
				action === "correct_reservation" ||
				/(wrong|correct|change|edit|modify|fix|تعديل|غلط|صحح|غير|غيّر)/i.test(text)
			);
		});
	return !correctionAfterFinal;
}

function reservationAlreadyCreated(supportCase = {}) {
	return (
		supportCase.aiReservation?.status === "created" ||
		Boolean(supportCase.aiReservation?.confirmationNumber)
	);
}

function isArabicLanguage(value = "") {
	return /arabic|\bar\b|[\u0600-\u06FF]/i.test(String(value || ""));
}

function isArabicText(value = "") {
	return /[\u0600-\u06FF]/.test(String(value || ""));
}

function responseLanguage(supportCase = {}, latestMessage = {}, decision = {}) {
	const explicit = cleanText(decision.language || "", 60);
	if (explicit) return explicit;
	const message = latestMessage.message || "";
	if (isArabicText(message)) return "Arabic";
	return supportCase.preferredLanguage || "English";
}

function languageCode(language = "", supportCase = {}) {
	const text = String(language || supportCase.preferredLanguage || "").toLowerCase();
	if (text.includes("arabic")) return "ar";
	if (text.includes("spanish")) return "es";
	if (text.includes("french")) return "fr";
	if (text.includes("urdu")) return "ur";
	if (text.includes("hindi")) return "hi";
	if (text.includes("indonesian")) return "id";
	if (text.includes("malay")) return "ms";
	return supportCase.preferredLanguageCode || "en";
}

function activeRooms(hotel = {}) {
	return (Array.isArray(hotel.roomCountDetails) ? hotel.roomCountDetails : [])
		.filter((room) => room && room.activeRoom !== false)
		.map((room) => ({
			roomType: String(room.roomType || room._id || "").trim(),
			displayName: String(room.displayName || room.roomType || "").trim(),
			displayNameOther: String(room.displayName_OtherLanguage || "").trim(),
			description: clip(room.description || "", 280),
			descriptionOther: clip(room.description_OtherLanguage || "", 280),
			amenities: Array.isArray(room.amenities)
				? room.amenities.map((item) => cleanText(item, 80)).filter(Boolean).slice(0, 8)
				: [],
			views: Array.isArray(room.views)
				? room.views.map((item) => cleanText(item, 80)).filter(Boolean).slice(0, 6)
				: [],
			extraAmenities: Array.isArray(room.extraAmenities)
				? room.extraAmenities
						.map((item) => cleanText(item, 80))
						.filter(Boolean)
						.slice(0, 8)
				: [],
			roomSize: room.roomSize || "",
			bedsCount: room.bedsCount || "",
			roomForGender: room.roomForGender || "",
			basePrice: room.price?.basePrice || 0,
			count: room.count || 0,
		}));
}

function activePolicies(hotel = {}) {
	const rows = Array.isArray(hotel.hotelPolicyQA) ? hotel.hotelPolicyQA : [];
	const policies = rows
		.filter((row) => row && row.active !== false && cleanText(row.answer || "", 10))
		.map((row) => ({
			key: cleanText(row.key || "", 80),
			category: cleanText(row.category || "", 100),
			question: cleanText(row.question || "", 240),
			answer: clip(row.answer || "", 700),
			mandatory: row.mandatory === true,
		}))
		.slice(0, 12);

	if (!policies.some((row) => /cancel|refund|cancellation/i.test(row.key || row.category || row.question))) {
		policies.unshift({
			key: "cancellation_refund",
			category: "Cancellation and refunds",
			question: "What is the cancellation and refund policy?",
			answer:
				"Cancellation is free with a full refund when requested 14 days or more before check-in. From 4 to 13 days before check-in, cancellation can still be processed; the hotel keeps one night and refunds the remaining amount. Within 3 days or less before check-in, the reservation is non-cancellable and non-refundable under the general policy.",
			mandatory: true,
		});
	}
	return policies;
}

function buildHotelFacts(hotel = {}) {
	const facts = {
		hotel: {
			id: asId(hotel._id),
			name: hotel.hotelName || "",
			nameOther: hotel.hotelName_OtherLanguage || "",
			address: hotel.hotelAddress || "",
			city: hotel.hotelCity || "",
			state: hotel.hotelState || "",
			country: hotel.hotelCountry || "",
			about: clip(hotel.aboutHotel || "", 700),
			aboutArabic: clip(hotel.aboutHotelArabic || "", 700),
			currency: String(hotel.currency || "SAR").toUpperCase(),
			distances: hotel.distances || {},
			location: hotel.location || {},
			parkingLot: hotel.parkingLot,
			hasBusService: hotel.hasBusService === true,
			busDetails: clip(hotel.busDetails || "", 500),
			isNusuk: hotel.isNusuk === true,
			isNusukText: clip(hotel.isNusukText || "", 500),
		},
		rooms: activeRooms(hotel),
		policies: activePolicies(hotel),
	};
	const json = JSON.stringify(facts);
	if (json.length <= MAX_FACT_CHARS) return facts;
	return {
		...facts,
		rooms: facts.rooms.slice(0, 10).map((room) => ({
			...room,
			description: clip(room.description, 160),
			descriptionOther: clip(room.descriptionOther, 160),
			amenities: room.amenities.slice(0, 4),
			extraAmenities: room.extraAmenities.slice(0, 4),
		})),
	};
}

function transcriptForPrompt(supportCase = {}) {
	const conversation = Array.isArray(supportCase.conversation)
		? supportCase.conversation
		: [];
	const rows = conversation.map((message, index) => {
		const role = message.isSystem
			? "system"
			: isGuestMessage(message)
			? "guest"
			: "assistant";
		const action = cleanText(message.clientAction || "", 80);
		const quickActions = Array.isArray(message.quickReplies)
			? message.quickReplies
					.map((reply) => cleanText(reply?.action || reply?.label || "", 80))
					.filter(Boolean)
			: [];
		return {
			index,
			role,
			at: message.date || "",
			name: cleanText(message.messageBy?.customerName || "", 120),
			action,
			quickActions,
			text: clip(message.message || "", 1200),
		};
	});
	let json = JSON.stringify(rows);
	if (json.length <= MAX_TRANSCRIPT_CHARS) return rows;

	const head = rows.slice(0, 6);
	const tail = rows.slice(-50);
	const compacted = [
		...head,
		{
			index: -1,
			role: "system",
			text: "[older middle transcript compressed for prompt size]",
		},
		...tail,
	];
	json = JSON.stringify(compacted);
	if (json.length <= MAX_TRANSCRIPT_CHARS) return compacted;
	return tail.map((row) => ({ ...row, text: clip(row.text, 700) }));
}

function parseJsonObject(raw = "") {
	const text = String(raw || "").trim();
	if (!text) return null;
	try {
		return JSON.parse(text);
	} catch {
		const start = text.indexOf("{");
		const end = text.lastIndexOf("}");
		if (start >= 0 && end > start) {
			try {
				return JSON.parse(text.slice(start, end + 1));
			} catch {
				return null;
			}
		}
		return null;
	}
}

function numberOrNull(value) {
	if (value === null || value === undefined || value === "") return null;
	const normalized = digitsToEnglish(String(value)).replace(/[^\d.-]/g, "");
	const number = Number(normalized);
	return Number.isFinite(number) ? number : null;
}

function normalizeDecision(raw = {}, supportCase = {}) {
	const decision = raw && typeof raw === "object" ? raw : {};
	const booking = decision.booking && typeof decision.booking === "object"
		? { ...decision.booking }
		: {};

	const totalGuests = numberOrNull(booking.totalGuestCount || booking.guests);
	const adults = numberOrNull(booking.adults);
	const children = numberOrNull(booking.children);
	if (!Number.isFinite(adults) && Number.isFinite(totalGuests) && totalGuests > 0) {
		booking.adults = totalGuests;
	}
	if (!Number.isFinite(children) && Number.isFinite(booking.adults)) {
		booking.children = 0;
	}
	booking.rooms = Math.max(1, numberOrNull(booking.rooms) || 1);

	const nationalityCode = normalizeCountryCode(
		booking.nationalityCode ||
			booking.nationalityCountryCode ||
			booking.countryCode ||
			"",
		booking.nationalityName ||
			booking.nationalityText ||
			booking.nationality ||
			""
	);
	if (nationalityCode) {
		booking.nationalityCode = nationalityCode;
		booking.nationalityName = booking.nationalityName || countryNameFromCode(nationalityCode);
	}

	booking.fullName = cleanText(booking.fullName || booking.name || "", 120);
	booking.phone = digitsToEnglish(String(booking.phone || "")).replace(/[^\d+]/g, "");
	booking.email = cleanText(booking.email || "", 180).toLowerCase();
	booking.roomTypeKey = cleanText(booking.roomTypeKey || "", 80);
	booking.roomDisplayName = cleanText(booking.roomDisplayName || "", 160);
	booking.checkinISO = cleanText(booking.checkinISO || booking.checkin || "", 20);
	booking.checkoutISO = cleanText(booking.checkoutISO || booking.checkout || "", 20);
	booking.finalReviewAlreadyShown =
		booking.finalReviewAlreadyShown === true || hasFinalReviewPrompt(supportCase);

	return {
		language: cleanText(decision.language || supportCase.preferredLanguage || "English", 80),
		action: cleanText(decision.action || "answer_fact", 80),
		intent: cleanText(decision.intent || "", 80),
		answerKind: cleanText(decision.answerKind || "", 80),
		reply: cleanText(decision.reply || "", 1400),
		guestAddress: cleanText(decision.guestAddress || "", 80),
		confidence: Number(decision.confidence || 0),
		booking,
		missing: Array.isArray(decision.missing)
			? decision.missing.map((item) => cleanText(item, 60)).filter(Boolean)
			: [],
	};
}

async function analyzeConversation({ supportCase, hotel, latest }) {
	const latestText = cleanText(latest?.message?.message || "", 2000);
	const languageHint = supportCase.preferredLanguage || "English";
	const facts = buildHotelFacts(hotel);
	const transcript = transcriptForPrompt(supportCase);
	const todayISO = new Date().toISOString().slice(0, 10);
	const agentName = supportCase.aiResponderName || "Amira";

	const system = [
		"You are the active planner and concise reply writer for Jannat Booking hotel reception chat.",
		`Visible CSR name: ${agentName}. In Arabic, the CSR voice is female or neutral; never write masculine self-reference such as ana mawgood if the CSR is female.`,
		"Review the entire saved transcript every turn. Do not rely only on the latest line.",
		"Answer the guest's newest direct question first from verified hotel facts, policies, room descriptions, amenities, reservation state, or pricing tools.",
		"Do not ask again for information already supplied anywhere in the transcript.",
		"Do not add many confirmations. Quote price and request any missing mandatory guest details in the same turn. Send only one full final review before reservation creation.",
		"Mandatory reservation details are: full guest name, phone, nationality as ISO-3166 alpha-2 country code, adult count. Children default to 0 when not supplied. Email is optional and must not be a separate required step.",
		"Create a reservation only when the transcript already contains the final review prompt and the newest guest clearly confirms it, or clientAction is place_reservation.",
		"After a reservation exists, answer follow-up hotel or reservation questions without restarting the booking flow.",
		"Room descriptions must be brief, natural, and based only on room settings; 1-2 short lines unless the guest asks for full details.",
		"For unknown safe questions, say professionally that the detail is not currently confirmed, then ask one relevant hotel/reservation follow-up. Do not escalate and do not deflect to links.",
		"For policy wording, sound like hotel reception. Do not say you checked a document, database, record, admin panel, or hotel details.",
		"Use the latest guest language naturally, including dialect or mixed language. If Arabic and the guest gender is clear, use respectful address sparingly, not every message.",
		"Return ONLY valid JSON with this shape:",
		JSON.stringify({
			language: "Arabic|English|Spanish|French|Urdu|Hindi|Indonesian|Malay",
			action:
				"greet|answer_fact|quote_room|ask_booking_missing|ask_guest_details|final_review|create_reservation|correct_details|close|unknown",
			intent: "short intent",
			answerKind:
				"room_options|room_description|amenity|bus|location|distance|policy|payment|reservation_details|smalltalk|unknown|null",
			guestAddress: "optional respectful short address or empty",
			booking: {
				wantsToBook: true,
				roomTypeKey: "doubleRooms|tripleRooms|quadRooms|familyRooms|singleRooms|null",
				roomDisplayName: "",
				checkinISO: "YYYY-MM-DD|null",
				checkoutISO: "YYYY-MM-DD|null",
				rooms: 1,
				fullName: "",
				phone: "",
				email: "",
				nationalityCode: "EG|null",
				nationalityName: "",
				adults: 2,
				children: 0,
				totalGuestCount: 2,
				finalReviewAlreadyShown: false,
			},
			missing: ["room", "dates", "fullName", "phone", "nationality", "adults"],
			reply: "concise direct reply when action is answer_fact/greet/unknown/close",
			confidence: 0.9,
		}),
	].join("\n");

	const user = JSON.stringify(
		{
			todayISO,
			languageHint,
			case: {
				id: asId(supportCase._id),
				preferredLanguage: supportCase.preferredLanguage,
				preferredLanguageCode: supportCase.preferredLanguageCode,
				inquiryAbout: supportCase.inquiryAbout,
				customerName: supportCase.displayName1 || supportCase.clientName || "",
				aiReservation: supportCase.aiReservation || {},
				reservationAlreadyCreated: reservationAlreadyCreated(supportCase),
			},
			latestGuest: {
				text: latestText,
				clientAction: latest?.message?.clientAction || "",
			},
			hotelFacts: facts,
			transcript,
		},
		null,
		2
	);

	try {
		const raw = await chat(
			[
				{ role: "system", content: system },
				{ role: "user", content: user },
			],
			{
				kind: "analysis",
				temperature: 0,
				max_tokens: 850,
				reasoning_effort: "low",
			}
		);
		return normalizeDecision(parseJsonObject(raw), supportCase);
	} catch (error) {
		console.error("[aiagent] rebuilt analysis failed:", error?.message || error);
		return fallbackDecision({ supportCase, latest });
	}
}

function fallbackDecision({ supportCase, latest }) {
	const text = latest?.message?.message || "";
	const dates = quickDateRange(text);
	const roomTypeKey = mapRoomToKey(text) || "";
	return normalizeDecision(
		{
			language: isArabicText(text) ? "Arabic" : supportCase.preferredLanguage || "English",
			action: roomTypeKey || dates.checkinISO ? "quote_room" : "answer_fact",
			answerKind: detectDirectKind(text) || "unknown",
			booking: {
				roomTypeKey,
				checkinISO: dates.checkinISO || "",
				checkoutISO: dates.checkoutISO || "",
				rooms: 1,
				finalReviewAlreadyShown: hasFinalReviewPrompt(supportCase),
			},
			reply: "",
			confidence: 0.2,
		},
		supportCase
	);
}

function detectDirectKind(text = "") {
	const value = String(text || "").toLowerCase();
	if (/(cancel|refund|policy|terms|condition|استرجاع|الغاء|إلغاء|سياس|شروط|استرداد)/i.test(value)) {
		return "policy";
	}
	if (/(bus|shuttle|transport|اتوبيس|باص|حافل|نقل)/i.test(value)) return "bus";
	if (/(location|address|map|لوكيشن|موقع|عنوان|خريطة)/i.test(value)) return "location";
	if (/(distance|far|haram|حرم|يبعد|بعد|المسافة)/i.test(value)) return "distance";
	if (/(reservation|booking|confirmation|حجز|تأكيد|تاكيد).*(details|number|link|تفاصيل|رقم)|(?:details|تفاصيل).*(reservation|booking|حجز)/i.test(value)) {
		return "reservation_details";
	}
	if (/(amenit|facility|wifi|wi-fi|breakfast|parking|مرافق|واي|افطار|فطور|موقف)/i.test(value)) {
		return "amenity";
	}
	if (/(room|غرفة|اوضة|أوضة|جناح).*(description|describe|details|وصف|تفاصيل)|(description|describe|وصف).*(room|غرفة|اوضة|أوضة|جناح)/i.test(value)) return "room_description";
	if (/(room types|what rooms|rooms do you have|انواع الغرف|أنواع الغرف|غرف ايه|غرف إيه)/i.test(value)) {
		return "room_options";
	}
	if (/(payment|pay|invoice|receipt|دفع|فاتورة|ايصال|إيصال)/i.test(value)) {
		return "payment";
	}
	return "";
}

function roomToken(value = "") {
	return String(value || "")
		.toLowerCase()
		.replace(/[^a-z0-9\u0600-\u06FF]+/g, "");
}

function findRoom(hotel = {}, booking = {}) {
	const rooms = Array.isArray(hotel.roomCountDetails) ? hotel.roomCountDetails : [];
	const active = rooms.filter((room) => room && room.activeRoom !== false);
	const key = roomToken(booking.roomTypeKey || "");
	const display = roomToken(booking.roomDisplayName || "");
	return (
		active.find((room) => key && roomToken(room.roomType) === key) ||
		active.find((room) => display && roomToken(room.displayName) === display) ||
		active.find((room) => {
			const tokens = [
				roomToken(room.roomType),
				roomToken(room.displayName),
				roomToken(room.displayName_OtherLanguage),
			].filter(Boolean);
			return tokens.some(
				(token) =>
					(key && (token.includes(key) || key.includes(token))) ||
					(display && (token.includes(display) || display.includes(token)))
			);
		}) ||
		null
	);
}

function validISODate(value = "") {
	return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function hasDates(booking = {}) {
	return validISODate(booking.checkinISO) && validISODate(booking.checkoutISO);
}

function detailsMissing(booking = {}) {
	const missing = [];
	if (!cleanText(booking.fullName || "", 10)) missing.push("fullName");
	if (!cleanText(booking.phone || "", 10).replace(/\D/g, "")) missing.push("phone");
	if (!normalizeCountryCode(booking.nationalityCode || "", booking.nationalityName || "")) {
		missing.push("nationality");
	}
	if (!Number.isFinite(numberOrNull(booking.adults)) || numberOrNull(booking.adults) < 1) {
		missing.push("adults");
	}
	return missing;
}

function roundMoney(value = 0) {
	const number = Number(value || 0);
	if (!Number.isFinite(number)) return "0";
	return number % 1 === 0 ? String(number.toFixed(0)) : String(number.toFixed(2));
}

function nightsText(nights, language = "English") {
	const n = Number(nights || 0);
	if (isArabicLanguage(language)) {
		if (n === 1) return "\u0644\u064a\u0644\u0629 \u0648\u0627\u062d\u062f\u0629";
		if (n === 2) return "\u0644\u064a\u0644\u062a\u064a\u0646";
		return `${n} \u0644\u064a\u0627\u0644\u064a`;
	}
	return n === 1 ? "1 night" : `${n} nights`;
}

function roomName(room = {}, language = "English") {
	if (isArabicLanguage(language) && room.displayName_OtherLanguage) {
		return room.displayName_OtherLanguage;
	}
	return room.displayName || room.roomType || "room";
}

function hotelName(hotel = {}, language = "English") {
	if (isArabicLanguage(language) && hotel.hotelName_OtherLanguage) {
		return hotel.hotelName_OtherLanguage;
	}
	return hotel.hotelName || "the hotel";
}

function quickReplies(language = "English") {
	if (isArabicLanguage(language)) {
		return [
			{ label: AR.completeReservation, value: AR.completeReservation, action: "place_reservation" },
			{ label: AR.somethingWrong, value: AR.somethingWrong, action: "correct_reservation" },
		];
	}
	if (/spanish/i.test(language)) {
		return [
			{ label: "Completar reserva", value: "Completar reserva", action: "place_reservation" },
			{ label: "Hay que corregir algo", value: "Hay que corregir algo", action: "correct_reservation" },
		];
	}
	if (/french/i.test(language)) {
		return [
			{ label: "Finaliser la reservation", value: "Finaliser la reservation", action: "place_reservation" },
			{ label: "Quelque chose a corriger", value: "Quelque chose a corriger", action: "correct_reservation" },
		];
	}
	return [
		{ label: "Complete Reservation", value: "Complete Reservation", action: "place_reservation" },
		{ label: "Something is wrong", value: "Something is wrong", action: "correct_reservation" },
	];
}

function askMissingBookingReply({ booking, hotel, language }) {
	const missing = [];
	if (!booking.roomTypeKey && !booking.roomDisplayName) missing.push("room");
	if (!validISODate(booking.checkinISO) || !validISODate(booking.checkoutISO)) {
		missing.push("dates");
	}
	if (isArabicLanguage(language)) {
		if (missing.includes("room") && missing.includes("dates")) {
			return "أقدر أساعدك بالحجز. أرسل نوع الغرفة المناسب وتاريخ الوصول والمغادرة، وسأراجع السعر والتوفر مباشرة.";
		}
		if (missing.includes("room")) {
			return "تمام، أرسل نوع الغرفة أو عدد الضيوف المناسب، وسأراجع السعر والتوفر على نفس التواريخ.";
		}
		return "تمام، أرسل تاريخ الوصول والمغادرة، وسأراجع السعر والتوفر مباشرة.";
	}
	if (missing.includes("room") && missing.includes("dates")) {
		return `I can help with ${hotelName(hotel, language)}. Please send the room type or guest fit plus check-in and check-out dates, and I will check the price and availability.`;
	}
	if (missing.includes("room")) {
		return "Please send the room type or how many guests will stay, and I will check the best matching room for those dates.";
	}
	return "Please send the check-in and check-out dates, and I will check the price and availability right away.";
}

function askDetailsReply({ booking, quote, room, language }) {
	const missing = detailsMissing(booking);
	const currency = String(quote.currency || "SAR").toUpperCase();
	const total = roundMoney(quote.totals?.totalPriceWithCommission || 0);
	const stay = `${booking.checkinISO} to ${booking.checkoutISO}`;
	const parts = [];
	if (missing.includes("fullName")) parts.push(isArabicLanguage(language) ? "\u0627\u0644\u0627\u0633\u0645 \u0627\u0644\u0643\u0627\u0645\u0644" : "full guest name");
	if (missing.includes("phone")) parts.push(isArabicLanguage(language) ? "\u0631\u0642\u0645 \u0627\u0644\u062c\u0648\u0627\u0644" : "phone number");
	if (missing.includes("nationality")) parts.push(isArabicLanguage(language) ? "\u0627\u0644\u062c\u0646\u0633\u064a\u0629" : "nationality");
	if (missing.includes("adults")) parts.push(isArabicLanguage(language) ? "\u0639\u062f\u062f \u0627\u0644\u0628\u0627\u0644\u063a\u064a\u0646" : "adult count");

	if (isArabicLanguage(language)) {
		return [
			`${roomName(room, language)} \u0645\u062a\u0627\u062d\u0629 \u0645\u0646 ${booking.checkinISO} \u0625\u0644\u0649 ${booking.checkoutISO} \u0644\u0645\u062f\u0629 ${nightsText(quote.nights, language)}.`,
			`\u0627\u0644\u0625\u062c\u0645\u0627\u0644\u064a ${total} ${currency}.`,
			`\u0644\u062a\u062c\u0647\u064a\u0632 \u0645\u0631\u0627\u062c\u0639\u0629 \u0627\u0644\u062d\u062c\u0632\u060c \u0623\u0631\u0633\u0644 ${parts.join("\u060c ")}. \u0625\u0630\u0627 \u064a\u0648\u062c\u062f \u0623\u0637\u0641\u0627\u0644 \u0627\u0630\u0643\u0631 \u0639\u062f\u062f\u0647\u0645\u060c \u0648\u0625\u0644\u0627 \u0633\u0623\u0639\u062a\u0628\u0631\u0647\u0645 0.`,
		].join("\n");
	}
	return [
		`${roomName(room, language)} is available for ${stay} (${nightsText(quote.nights, language)}).`,
		`Total: ${total} ${currency}.`,
		`To prepare the final reservation review, please send ${parts.join(", ")}. If there are children, include their count; otherwise I will keep children as 0.`,
	].join("\n");
}

function finalReviewReply({ booking, quote, room, hotel, language }) {
	const currency = String(quote.currency || hotel.currency || "SAR").toUpperCase();
	const total = roundMoney(quote.totals?.totalPriceWithCommission || 0);
	const nationality = countryNameFromCode(booking.nationalityCode) || booking.nationalityName || booking.nationalityCode;
	if (isArabicLanguage(language)) {
		return [
			"\u0647\u0630\u0647 \u0645\u0631\u0627\u062c\u0639\u0629 \u0627\u0644\u062d\u062c\u0632 \u0642\u0628\u0644 \u0627\u0644\u0625\u062a\u0645\u0627\u0645:",
			`\u0627\u0644\u0641\u0646\u062f\u0642: ${hotelName(hotel, language)}`,
			`\u0627\u0644\u063a\u0631\u0641\u0629: ${roomName(room, language)}`,
			`\u0627\u0644\u0625\u0642\u0627\u0645\u0629: ${booking.checkinISO} \u0625\u0644\u0649 ${booking.checkoutISO} (${nightsText(quote.nights, language)})`,
			`\u0627\u0644\u0636\u064a\u0641: ${booking.fullName}`,
			`\u0627\u0644\u062c\u0648\u0627\u0644: ${booking.phone}`,
			`\u0627\u0644\u062c\u0646\u0633\u064a\u0629: ${nationality}`,
			`\u0627\u0644\u0636\u064a\u0648\u0641: ${booking.adults || 1} \u0628\u0627\u0644\u063a\u060c ${booking.children || 0} \u0623\u0637\u0641\u0627\u0644`,
			`\u0627\u0644\u0625\u062c\u0645\u0627\u0644\u064a: ${total} ${currency}`,
			"\u0625\u0630\u0627 \u0643\u0644 \u0627\u0644\u0628\u064a\u0627\u0646\u0627\u062a \u0635\u062d\u064a\u062d\u0629\u060c \u0627\u0636\u063a\u0637 \u0625\u062a\u0645\u0627\u0645 \u0627\u0644\u062d\u062c\u0632.",
		].join("\n");
	}
	return [
		"Here is the final reservation review:",
		`Hotel: ${hotelName(hotel, language)}`,
		`Room: ${roomName(room, language)}`,
		`Stay: ${booking.checkinISO} to ${booking.checkoutISO} (${nightsText(quote.nights, language)})`,
		`Guest: ${booking.fullName}`,
		`Phone: ${booking.phone}`,
		`Nationality: ${nationality}`,
		`Guests: ${booking.adults || 1} adults, ${booking.children || 0} children`,
		`Total: ${total} ${currency}`,
		"If everything is correct, tap Complete Reservation.",
	].join("\n");
}

function publicReservationLinks(reservation = {}) {
	const publicBase = String(
		process.env.CLIENT_URL ||
			process.env.REACT_APP_MAIN_URL_JANNAT ||
			"https://jannatbooking.com"
	).replace(/\/+$/, "");
	const confirmation = reservation.confirmation_number || "";
	const reservationId = asId(reservation._id);
	return {
		details: `${publicBase}/single-reservation/${confirmation}`,
		payment: `${publicBase}/client-payment/${reservationId}/${confirmation}`,
	};
}

function supportCaseReservationObject(supportCase = {}) {
	return {
		_id: supportCase.aiReservation?.reservationId || "",
		confirmation_number: supportCase.aiReservation?.confirmationNumber || "",
	};
}

function reservationDetailsReply({ supportCase, language }) {
	const reservation = supportCaseReservationObject(supportCase);
	const confirmation = reservation.confirmation_number || "";
	const links = publicReservationLinks(reservation);
	if (!confirmation) {
		return isArabicLanguage(language)
			? "\u0644\u0627 \u064a\u0648\u062c\u062f \u0631\u0642\u0645 \u062a\u0623\u0643\u064a\u062f \u0645\u062d\u0641\u0648\u0638 \u0641\u064a \u0647\u0630\u0647 \u0627\u0644\u0645\u062d\u0627\u062f\u062b\u0629 \u062d\u0627\u0644\u064a\u064b\u0627."
			: "I do not see a saved confirmation number in this chat yet.";
	}
	if (isArabicLanguage(language)) {
		return [
			`\u0631\u0642\u0645 \u0627\u0644\u062a\u0623\u0643\u064a\u062f: ${confirmation}.`,
			`[\u062a\u0641\u0627\u0635\u064a\u0644 \u0627\u0644\u062d\u062c\u0632](${links.details})`,
			`[\u0631\u0627\u0628\u0637 \u0627\u0644\u062f\u0641\u0639](${links.payment})`,
		].join("\n");
	}
	return [
		`Confirmation number: ${confirmation}.`,
		`[Reservation details](${links.details})`,
		`[Payment link](${links.payment})`,
	].join("\n");
}

function createdReply({ reservation, language }) {
	const links = publicReservationLinks(reservation);
	const confirmation = reservation.confirmation_number || "";
	if (isArabicLanguage(language)) {
		return [
			`\u062a\u0645 \u0625\u0646\u0634\u0627\u0621 \u0627\u0644\u062d\u062c\u0632 \u0628\u0646\u062c\u0627\u062d. \u0631\u0642\u0645 \u0627\u0644\u062a\u0623\u0643\u064a\u062f: ${confirmation}.`,
			`[\u062a\u0641\u0627\u0635\u064a\u0644 \u0627\u0644\u062d\u062c\u0632](${links.details})`,
			`[\u0631\u0627\u0628\u0637 \u0627\u0644\u062f\u0641\u0639](${links.payment})`,
			"\u064a\u0645\u0643\u0646\u0643 \u0645\u0631\u0627\u062c\u0639\u0629 \u0627\u0644\u062a\u0641\u0627\u0635\u064a\u0644\u060c \u0648\u0623\u0646\u0627 \u0645\u0639\u0643 \u0644\u0623\u064a \u0633\u0624\u0627\u0644 \u0639\u0646 \u0627\u0644\u0641\u0646\u062f\u0642 \u0623\u0648 \u0627\u0644\u062d\u062c\u0632.",
		].join("\n");
	}
	return [
		`Your reservation has been created successfully. Confirmation number: ${confirmation}.`,
		`[Reservation details](${links.details})`,
		`[Payment link](${links.payment})`,
		"You can review the details there, and I am here for any hotel or reservation question.",
	].join("\n");
}

function policyReply(language = "English") {
	if (isArabicLanguage(language)) {
		return "\u0628\u0646\u0627\u0621\u064b \u0639\u0644\u0649 \u0634\u0631\u0648\u0637 \u0648\u0633\u064a\u0627\u0633\u0627\u062a \u0627\u0644\u0641\u0646\u062f\u0642\u060c \u064a\u0643\u0648\u0646 \u0627\u0644\u0625\u0644\u063a\u0627\u0621 \u0645\u062c\u0627\u0646\u064a\u064b\u0627 \u0645\u0639 \u0627\u0633\u062a\u0631\u062f\u0627\u062f \u0643\u0627\u0645\u0644 \u0639\u0646\u062f\u0645\u0627 \u064a\u062a\u0645 \u0637\u0644\u0628\u0647 \u0642\u0628\u0644 \u0627\u0644\u0648\u0635\u0648\u0644 \u0628\u0640 14 \u064a\u0648\u0645\u064b\u0627 \u0623\u0648 \u0623\u0643\u062b\u0631. \u0645\u0646 4 \u0625\u0644\u0649 13 \u064a\u0648\u0645\u064b\u0627 \u0642\u0628\u0644 \u0627\u0644\u0648\u0635\u0648\u0644\u060c \u064a\u0645\u0643\u0646 \u0645\u0639\u0627\u0644\u062c\u0629 \u0627\u0644\u0625\u0644\u063a\u0627\u0621 \u0648\u064a\u062d\u062a\u0641\u0638 \u0627\u0644\u0641\u0646\u062f\u0642 \u0628\u0642\u064a\u0645\u0629 \u0644\u064a\u0644\u0629 \u0648\u0627\u062d\u062f\u0629 \u0641\u0642\u0637 \u0648\u064a\u062a\u0645 \u0627\u0633\u062a\u0631\u062f\u0627\u062f \u0627\u0644\u0645\u062a\u0628\u0642\u064a. \u062e\u0644\u0627\u0644 3 \u0623\u064a\u0627\u0645 \u0623\u0648 \u0623\u0642\u0644 \u0645\u0646 \u0627\u0644\u0648\u0635\u0648\u0644\u060c \u064a\u0643\u0648\u0646 \u0627\u0644\u062d\u062c\u0632 \u063a\u064a\u0631 \u0642\u0627\u0628\u0644 \u0644\u0644\u0625\u0644\u063a\u0627\u0621 \u0648\u063a\u064a\u0631 \u0642\u0627\u0628\u0644 \u0644\u0644\u0627\u0633\u062a\u0631\u062f\u0627\u062f \u0648\u0641\u0642 \u0627\u0644\u0633\u064a\u0627\u0633\u0629 \u0627\u0644\u0639\u0627\u0645\u0629.";
	}
	return "Based on the hotel's terms and conditions, cancellation is free with a full refund when requested 14 days or more before check-in. From 4 to 13 days before check-in, cancellation can still be processed; the hotel keeps one night only and refunds the remaining amount. Within 3 days or less before check-in, the reservation is non-cancellable and non-refundable under the general policy.";
}

function locationReply({ hotel, language }) {
	const address = cleanText(hotel.hotelAddress || "", 240);
	const coords = Array.isArray(hotel.location?.coordinates)
		? hotel.location.coordinates
		: [];
	const lon = Number(coords[0]);
	const lat = Number(coords[1]);
	const hasCoords = Number.isFinite(lat) && Number.isFinite(lon) && lat !== 0 && lon !== 0;
	const mapLink = hasCoords
		? `https://www.google.com/maps/dir/?api=1&origin=${lat},${lon}&destination=21.4225,39.8262&travelmode=driving`
		: "";
	if (isArabicLanguage(language)) {
		const lines = [address ? `\u0639\u0646\u0648\u0627\u0646 \u0627\u0644\u0641\u0646\u062f\u0642: ${address}.` : "\u0627\u0644\u0639\u0646\u0648\u0627\u0646 \u0627\u0644\u062f\u0642\u064a\u0642 \u063a\u064a\u0631 \u0645\u0624\u0643\u062f \u0644\u062f\u064a \u062d\u0627\u0644\u064a\u064b\u0627."];
		if (mapLink) lines.push(`[\u0627\u0644\u0627\u062a\u062c\u0627\u0647\u0627\u062a \u0639\u0644\u0649 Google Maps](${mapLink})`);
		return lines.join("\n");
	}
	const lines = [address ? `Hotel address: ${address}.` : "The exact hotel address is not confirmed in this chat yet."];
	if (mapLink) lines.push(`[Google Maps directions](${mapLink})`);
	return lines.join("\n");
}

function distanceReply({ hotel, language }) {
	const distances = hotel.distances || {};
	const walking = cleanText(distances.walkingToElHaram || distances.walking || "", 80);
	const driving = cleanText(distances.drivingToElHaram || distances.driving || "", 80);
	if (isArabicLanguage(language)) {
		if (!walking && !driving) return "المسافة الدقيقة من الحرم غير مؤكدة لدي حاليًا. أرسل لي تواريخ الإقامة ونوع الغرفة إذا أردت مراجعة التوفر والسعر.";
		return [
			"\u0627\u0644\u0645\u0633\u0627\u0641\u0629 \u0645\u0646 \u0627\u0644\u062d\u0631\u0645:",
			walking ? `- \u0645\u0634\u064a\u064b\u0627: ${walking}` : "",
			driving ? `- \u0628\u0627\u0644\u0633\u064a\u0627\u0631\u0629: ${driving}` : "",
		]
			.filter(Boolean)
			.join("\n");
	}
	if (!walking && !driving) {
		return "The exact distance from Al Haram is not confirmed in this chat yet. Send your dates and room preference if you would like me to check availability and price.";
	}
	return ["Distance from Al Haram:", walking ? `- Walking: ${walking}` : "", driving ? `- Driving: ${driving}` : ""]
		.filter(Boolean)
		.join("\n");
}

function busReply({ hotel, language }) {
	const details = cleanText(hotel.busDetails || "", 360);
	if (hotel.hasBusService === true) {
		if (isArabicLanguage(language)) {
			return details
				? `\u0646\u0639\u0645\u060c \u064a\u0648\u062c\u062f \u062e\u062f\u0645\u0629 \u062d\u0627\u0641\u0644\u0629 \u0644\u0644\u0641\u0646\u062f\u0642. ${details}`
				: "\u0646\u0639\u0645\u060c \u064a\u0648\u062c\u062f \u062e\u062f\u0645\u0629 \u062d\u0627\u0641\u0644\u0629 \u0644\u0644\u0641\u0646\u062f\u0642\u060c \u0648\u0627\u0644\u062a\u0641\u0627\u0635\u064a\u0644 \u0627\u0644\u062f\u0642\u064a\u0642\u0629 \u0644\u0644\u0645\u062d\u0637\u0629 \u0648\u0627\u0644\u0645\u0648\u0627\u0639\u064a\u062f \u063a\u064a\u0631 \u0645\u0639\u0631\u0648\u0636\u0629 \u0644\u062f\u064a \u062d\u0627\u0644\u064a\u064b\u0627.";
		}
		return details
			? `Yes, the hotel has a bus/shuttle service. ${details}`
			: "Yes, the hotel has a bus/shuttle service. The exact stop and schedule details are not shown in this chat yet.";
	}
	return isArabicLanguage(language)
		? "\u062e\u062f\u0645\u0629 \u0627\u0644\u062d\u0627\u0641\u0644\u0629 \u063a\u064a\u0631 \u0645\u0624\u0643\u062f\u0629 \u0644\u062f\u064a \u0644\u0647\u0630\u0627 \u0627\u0644\u0641\u0646\u062f\u0642 \u062d\u0627\u0644\u064a\u064b\u0627."
		: "A bus/shuttle service is not confirmed for this hotel in the current settings.";
}

function roomOptionsReply({ hotel, language }) {
	const rooms = activeRooms(hotel).slice(0, 8);
	if (!rooms.length) {
		return isArabicLanguage(language)
			? "\u0623\u0646\u0648\u0627\u0639 \u0627\u0644\u063a\u0631\u0641 \u063a\u064a\u0631 \u0645\u0639\u0631\u0648\u0636\u0629 \u0644\u062f\u064a \u062d\u0627\u0644\u064a\u064b\u0627."
			: "The active room types are not shown in this chat yet.";
	}
	if (isArabicLanguage(language)) {
		return [
			`\u0627\u0644\u063a\u0631\u0641 \u0627\u0644\u0645\u062a\u0627\u062d\u0629 \u0641\u064a ${hotelName(hotel, language)}:`,
			...rooms.map((room) => `- ${room.displayNameOther || room.displayName || room.roomType}`),
			"\u0644\u0644\u0633\u0639\u0631 \u0648\u0627\u0644\u062a\u0648\u0641\u0631\u060c \u0623\u0631\u0633\u0644 \u062a\u0627\u0631\u064a\u062e \u0627\u0644\u0648\u0635\u0648\u0644 \u0648\u0627\u0644\u0645\u063a\u0627\u062f\u0631\u0629 \u0648\u0639\u062f\u062f \u0627\u0644\u0636\u064a\u0648\u0641.",
		].join("\n");
	}
	return [
		`Available room types at ${hotelName(hotel, language)}:`,
		...rooms.map((room) => `- ${room.displayName || room.roomType}`),
		"For price and availability, send check-in, check-out, and guest count.",
	].join("\n");
}

function roomDescriptionReply({ hotel, room, language }) {
	const selected = room || (Array.isArray(hotel.roomCountDetails) ? hotel.roomCountDetails[0] : null);
	if (!selected) {
		return isArabicLanguage(language)
			? "\u062a\u0641\u0627\u0635\u064a\u0644 \u0627\u0644\u063a\u0631\u0641\u0629 \u063a\u064a\u0631 \u0645\u0639\u0631\u0648\u0636\u0629 \u0644\u062f\u064a \u062d\u0627\u0644\u064a\u064b\u0627."
			: "The room details are not shown in this chat yet.";
	}
	const description = isArabicLanguage(language)
		? cleanText(selected.description_OtherLanguage || selected.description || "", 260)
		: cleanText(selected.description || selected.description_OtherLanguage || "", 260);
	const amenities = [
		...(Array.isArray(selected.amenities) ? selected.amenities : []),
		...(Array.isArray(selected.extraAmenities) ? selected.extraAmenities : []),
	]
		.map((item) => cleanText(item, 80))
		.filter(Boolean)
		.slice(0, 4);
	if (isArabicLanguage(language)) {
		return [
			`${roomName(selected, language)}: ${description || "\u0627\u0644\u0648\u0635\u0641 \u0627\u0644\u062a\u0641\u0635\u064a\u0644\u064a \u063a\u064a\u0631 \u0645\u0639\u0631\u0648\u0636 \u062d\u0627\u0644\u064a\u064b\u0627."}`,
			amenities.length ? `\u0645\u0646 \u0627\u0644\u0645\u0631\u0627\u0641\u0642: ${amenities.join("\u060c ")}.` : "",
		]
			.filter(Boolean)
			.join("\n");
	}
	return [
		`${roomName(selected, language)}: ${description || "A detailed description is not currently shown."}`,
		amenities.length ? `Amenities shown: ${amenities.join(", ")}.` : "",
	]
		.filter(Boolean)
		.join("\n");
}

function sanitizeReply(reply = "", language = "English") {
	let text = cleanText(reply, 1600);
	if (!text) return text;
	text = text
		.replace(/I (?:just )?(?:checked|looked at|reviewed) (?:the )?(?:hotel )?(?:document|record|admin|database|settings|details)[^.!\n]*[.!]?\s*/gi, "")
		.replace(/Based on (?:the )?(?:hotel )?(?:document|record|admin|database|settings|details)/gi, "Based on the hotel's terms and conditions");
	if (isArabicLanguage(language)) {
		text = text
			.replace(/\u0623\u0646\u0627\s+\u0645\u0648\u062c\u0648\u062f(?!\u0629)/g, "\u0623\u0646\u0627 \u0645\u0648\u062c\u0648\u062f\u0629 \u0645\u0639\u0643")
			.replace(/\u0623\u0646\u0627\s+\u0645\u062a\u0627\u0628\u0639(?!\u0629)/g, "\u0623\u062a\u0627\u0628\u0639 \u0645\u0639\u0643")
			.replace(/\b1\s+\u0644\u064a\u0627\u0644\u064a\b/g, "\u0644\u064a\u0644\u0629 \u0648\u0627\u062d\u062f\u0629");
	}
	return text;
}

async function latestStillUnanswered(caseId, originalFingerprint) {
	const fresh = await getSupportCaseById(caseId);
	if (!fresh) return { ok: false, supportCase: null };
	const latest = latestGuestTurn(fresh);
	if (!latest || latest.hasAiAfter) return { ok: false, supportCase: fresh };
	return {
		ok: messageFingerprint(latest.message) === originalFingerprint,
		supportCase: fresh,
	};
}

async function sendAiMessage(io, supportCase, text, options = {}) {
	const caseId = asId(supportCase._id);
	const language = options.language || supportCase.preferredLanguage || "English";
	const messageText = sanitizeReply(text, language);
	if (!caseId || !messageText) return { sent: false, skipped: true };

	if (options.latestFingerprint) {
		const still = await latestStillUnanswered(caseId, options.latestFingerprint);
		if (!still.ok) {
			if (still.supportCase) schedulePlanTurn(io, caseId, { delayMs: 80 });
			return { sent: false, skipped: true, stale: true };
		}
	}

	const agentName = supportCase.aiResponderName || "Amira";
	const messageData = {
		messageBy: {
			customerName: agentName,
			customerEmail: SUPPORT_EMAIL,
			userId: SUPPORT_USER_ID,
		},
		message: messageText,
		date: new Date(),
		inquiryAbout: "support",
		inquiryDetails: messageText.slice(0, 1200),
		seenByAdmin: false,
		seenByHotel: false,
		seenByCustomer: false,
		isAi: true,
		quickReplies: Array.isArray(options.quickReplies) ? options.quickReplies : [],
	};
	const { updatedCase, skipped } = await updateSupportCaseAppendIfNoRecentAiDuplicate(
		caseId,
		{
			conversation: messageData,
			aiRelated: true,
			aiResponderName: agentName,
		},
		{ duplicateWindowMs: 3 * 60 * 1000 }
	);
	if (!skipped) {
		io?.to(caseId).emit("receiveMessage", { ...messageData, caseId });
	}
	io?.to(caseId).emit("stopTyping", { caseId, name: agentName, isAi: true });
	return { sent: !skipped, skipped, updatedCase };
}

function quoteForBooking({ hotel, room, booking }) {
	if (!room || !hasDates(booking)) {
		return { ok: false, code: "missing" };
	}
	const quote = priceRoomForStay(
		hotel,
		{ roomType: room.roomType },
		booking.checkinISO,
		booking.checkoutISO
	);
	if (!quote?.available) {
		return { ok: false, code: quote?.reason || "unavailable", quote };
	}
	return { ok: true, quote };
}

function unavailableReply({ hotel, booking, room, quote, language }) {
	const alternatives = listAvailableRoomsForStay(
		hotel,
		booking.checkinISO,
		booking.checkoutISO
	)
		.filter((item) => item.available && item.room?.roomType !== room?.roomType)
		.slice(0, 3);
	if (isArabicLanguage(language)) {
		if (alternatives.length) {
			return [
				`\u0644\u0644\u0623\u0633\u0641 ${roomName(room, language)} \u063a\u064a\u0631 \u0645\u062a\u0627\u062d\u0629 \u0623\u0648 \u063a\u064a\u0631 \u0645\u0633\u0639\u0631\u0629 \u0644\u0647\u0630\u0647 \u0627\u0644\u062a\u0648\u0627\u0631\u064a\u062e.`,
				"\u0627\u0644\u0628\u062f\u0627\u0626\u0644 \u0627\u0644\u0645\u062a\u0627\u062d\u0629:",
				...alternatives.map(
					(item) =>
						`- ${roomName(item.room, language)}: ${roundMoney(item.totals?.totalPriceWithCommission || 0)} ${item.currency || hotel.currency || "SAR"}`
				),
			].join("\n");
		}
		return `\u0644\u0644\u0623\u0633\u0641 ${roomName(room, language)} \u063a\u064a\u0631 \u0645\u062a\u0627\u062d\u0629 \u0623\u0648 \u063a\u064a\u0631 \u0645\u0633\u0639\u0631\u0629 \u0644\u0647\u0630\u0647 \u0627\u0644\u062a\u0648\u0627\u0631\u064a\u062e. \u0645\u0645\u0643\u0646 \u062a\u0631\u0633\u0644 \u062a\u0648\u0627\u0631\u064a\u062e \u0623\u062e\u0631\u0649 \u0623\u0648 \u0639\u062f\u062f \u0636\u064a\u0648\u0641 \u0645\u062e\u062a\u0644\u0641 \u0644\u0623\u0631\u0627\u062c\u0639 \u0628\u062f\u064a\u0644\u064b\u0627 \u0645\u0646\u0627\u0633\u0628\u064b\u0627.`;
	}
	if (alternatives.length) {
		return [
			`${roomName(room, language)} is not available or not priced for those dates.`,
			"Available alternatives for the same dates:",
			...alternatives.map(
				(item) =>
					`- ${roomName(item.room, language)}: ${roundMoney(item.totals?.totalPriceWithCommission || 0)} ${item.currency || hotel.currency || "SAR"}`
			),
		].join("\n");
	}
	return `${roomName(room, language)} is not available or not priced for those dates. Send another date range or guest count and I will check a suitable option.`;
}

async function buildTurnResult({ supportCase, hotel, decision, latest }) {
	const language = responseLanguage(supportCase, latest.message, decision);
	const booking = { ...(decision.booking || {}) };
	const directKind = decision.answerKind || detectDirectKind(latest.message.message || "");
	const latestAction = cleanText(latest.message.clientAction || "", 80);
	const room = findRoom(hotel, booking);
	const created = reservationAlreadyCreated(supportCase);

	if (latestAction === "correct_reservation" || decision.action === "correct_details") {
		return { text: isArabicLanguage(language) ? AR.noProblem : "No problem. Tell me what needs to be corrected and I will review it before completing the reservation.", language };
	}

	if (directKind === "policy") return { text: policyReply(language), language };
	if (directKind === "location") return { text: locationReply({ hotel, language }), language };
	if (directKind === "distance") return { text: distanceReply({ hotel, language }), language };
	if (directKind === "bus") return { text: busReply({ hotel, language }), language };
	if (directKind === "reservation_details" || directKind === "payment") {
		if (created) return { text: reservationDetailsReply({ supportCase, language }), language };
	}
	if (directKind === "room_options") return { text: roomOptionsReply({ hotel, language }), language };
	if (directKind === "room_description" || directKind === "amenity") {
		return { text: roomDescriptionReply({ hotel, room, language }), language };
	}

	if (created && decision.reply) {
		return { text: sanitizeReply(decision.reply, language), language };
	}

	const wantsBooking =
		decision.action === "quote_room" ||
		decision.action === "ask_booking_missing" ||
		decision.action === "ask_guest_details" ||
		decision.action === "final_review" ||
		decision.action === "create_reservation" ||
		booking.wantsToBook === true ||
		Boolean(booking.roomTypeKey || booking.roomDisplayName || booking.checkinISO || booking.checkoutISO);

	if (wantsBooking && (!room || !hasDates(booking))) {
		return { text: askMissingBookingReply({ booking, hotel, language }), language };
	}

	if (wantsBooking && room && hasDates(booking)) {
		const quoted = quoteForBooking({ hotel, room, booking });
		if (!quoted.ok) {
			return {
				text: unavailableReply({
					hotel,
					booking,
					room,
					quote: quoted.quote,
					language,
				}),
				language,
			};
		}
		const quote = quoted.quote;
		booking.adults = numberOrNull(booking.adults) || null;
		booking.children = Number.isFinite(numberOrNull(booking.children))
			? numberOrNull(booking.children)
			: 0;
		booking.rooms = Math.max(1, numberOrNull(booking.rooms) || 1);
		booking.nationalityCode = normalizeCountryCode(
			booking.nationalityCode || "",
			booking.nationalityName || booking.nationality || ""
		);
		if (booking.nationalityCode && !booking.nationalityName) {
			booking.nationalityName = countryNameFromCode(booking.nationalityCode);
		}

		const missingDetails = detailsMissing(booking);
		if (missingDetails.length) {
			return {
				text: askDetailsReply({ booking, quote, room, language }),
				language,
			};
		}

		const canCreate =
			(latestAction === "place_reservation" || decision.action === "create_reservation") &&
			booking.finalReviewAlreadyShown === true;
		if (canCreate) {
			const reservation = await createReservationForCase({
				caseId: asId(supportCase._id),
				hotel,
				slots: {
					...booking,
					fullName: booking.fullName,
					name: booking.fullName,
					nationality: booking.nationalityName || booking.nationalityCode,
					nationalityCode: booking.nationalityCode,
					checkinISO: booking.checkinISO,
					checkoutISO: booking.checkoutISO,
				},
				quoteData: {
					nights: quote.nights,
					currency: quote.currency,
					pricingByDay: quote.pricingByDay,
					rows: quote.pricingByDay,
				},
				room,
			});
			dispatchAiReservationConfirmation({
				caseId: asId(supportCase._id),
				reservation,
				guestEmail: booking.email || "",
				includeGuestEmail: Boolean(booking.email),
				includeInternalEmail: true,
				includeOwnerEmail: true,
				includeGuestWhatsApp: true,
				includeAdminWhatsApp: true,
			}).catch((error) =>
				console.error("[aiagent] confirmation dispatch failed:", error?.message || error)
			);
			return { text: createdReply({ reservation, language }), language };
		}

		return {
			text: finalReviewReply({ booking, quote, room, hotel, language }),
			language,
			quickReplies: quickReplies(language),
		};
	}

	if (decision.reply) {
		return { text: sanitizeReply(decision.reply, language), language };
	}

	if (isArabicLanguage(language)) {
		return {
			text: `${AR.hello}\u060c \u0623\u0646\u0627 \u0645\u0639\u0643 \u0645\u0646 \u0627\u0633\u062a\u0642\u0628\u0627\u0644 ${hotelName(hotel, language)}. \u0643\u064a\u0641 \u0623\u0633\u0627\u0639\u062f\u0643 \u0641\u064a \u0627\u0644\u063a\u0631\u0641 \u0623\u0648 \u0627\u0644\u062a\u0648\u0641\u0631\u061f`,
			language,
		};
	}
	return {
		text: `Assalamu alaikum, I am with ${hotelName(hotel, language)} reception. How can I help with rooms, availability, or your reservation?`,
		language,
	};
}

async function planCase(io, caseOrId) {
	const caseId = asId(caseOrId);
	if (!caseId) return;
	if (inFlight.has(caseId)) {
		queued.add(caseId);
		return;
	}
	inFlight.add(caseId);
	try {
		const supportCase = await getSupportCaseById(caseId);
		if (!supportCase) return;
		const latest = latestGuestTurn(supportCase);
		if (!latest || latest.hasAiAfter) return;

		const { allowed, hotel, reason } = await ensureAIAllowed(
			supportCase.hotelId,
			supportCase
		);
		if (!allowed || !hotel) {
			if (String(process.env.AI_AGENT_DEBUG || "").toLowerCase() === "true") {
				console.log("[aiagent] rebuilt skip", { caseId, reason });
			}
			return;
		}

		const agentName = supportCase.aiResponderName || "Amira";
		io?.to(caseId).emit("typing", { caseId, name: agentName, isAi: true });
		const latestFingerprint = messageFingerprint(latest.message);
		const decision = await analyzeConversation({ supportCase, hotel, latest });
		const result = await buildTurnResult({ supportCase, hotel, decision, latest });
		await sendAiMessage(io, supportCase, result.text, {
			language: result.language,
			quickReplies: result.quickReplies,
			latestFingerprint,
		});
	} catch (error) {
		console.error("[aiagent] rebuilt plan error:", error?.message || error);
		try {
			const supportCase = await getSupportCaseById(caseId);
			const latest = latestGuestTurn(supportCase || {});
			if (supportCase && latest && !latest.hasAiAfter) {
				const language = responseLanguage(supportCase, latest.message, {});
				await sendAiMessage(
					io,
					supportCase,
					isArabicLanguage(language)
						? "أعتذر، حدث تأخير بسيط أثناء مراجعة الطلب. أرسل لي آخر تفصيلة تريد تأكيدها وسأتابع معك مباشرة."
						: "I am sorry, there was a brief delay while reviewing the request. Send me the last detail you want to confirm and I will continue directly.",
					{
						language,
						latestFingerprint: messageFingerprint(latest.message),
					}
				);
			}
		} catch (fallbackError) {
			console.error(
				"[aiagent] rebuilt fallback failed:",
				fallbackError?.message || fallbackError
			);
		}
	} finally {
		inFlight.delete(caseId);
		io?.to(caseId).emit("stopTyping", { caseId, isAi: true });
		if (queued.has(caseId)) {
			queued.delete(caseId);
			schedulePlanTurn(io, caseId, { delayMs: 80 });
		}
	}
}

function schedulePlanTurn(io, caseOrId, { delayMs = AI_TURN_TIMER_MS } = {}) {
	const caseId = asId(caseOrId);
	if (!caseId) return;
	if (timers.has(caseId)) clearTimeout(timers.get(caseId));
	const timer = setTimeout(() => {
		timers.delete(caseId);
		planCase(io, caseId).catch((error) =>
			console.error("[aiagent] rebuilt scheduled plan error:", error?.message || error)
		);
	}, Math.max(0, Number(delayMs) || 0));
	if (typeof timer.unref === "function") timer.unref();
	timers.set(caseId, timer);
}

function wireSocket(io) {
	if (!io || io.__jannatAiRebuiltWired) return;
	io.__jannatAiRebuiltWired = true;
	io.on("connection", (socket) => {
		socket.on("joinRoom", ({ caseId } = {}) => {
			if (caseId) schedulePlanTurn(io, caseId, { delayMs: 120 });
		});
		socket.on("sendMessage", (message = {}) => {
			if (message.caseId) schedulePlanTurn(io, message.caseId, { delayMs: 120 });
		});
	});
	console.log("[aiagent] rebuilt socket-driven planner active.");
}

module.exports = { wireSocket, schedulePlanTurn };
