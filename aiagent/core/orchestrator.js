// aiagent/core/orchestrator.js
const {
	getSupportCaseById,
	updateSupportCaseAppend,
	getHotelById,
	listActivePublicHotels,
} = require("./db");
const { ensureAIAllowed } = require("./policy");

const {
	listAvailableRoomsForStay,
	priceRoomForStay,
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

const AGENT_POOL = ["Hana", "Aisha", "Sara", "Amira", "Yasmin", "Nadia"];
const AI_SUPPORT_EMAIL = "support@jannatbooking.com";
const LEGACY_AI_SUPPORT_EMAIL = "management@xhotelpro.com";

const HUMAN = {
	greetThinkMs: 5000,
	thinkMinMs: 2000,
	thinkMaxMs: 2600,
	typeCharMinMs: 48,
	typeCharMaxMs: 60,
	typeClampMinMs: 2200,
	typeClampMaxMs: 7000,
	betweenSendsMinMs: 1700,
	betweenSendsMaxMs: 2200,
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
function usDate(iso) {
	if (!iso) return "";
	const d = new Date(iso + "T00:00:00");
	return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(
		d.getDate()
	).padStart(2, "0")}/${d.getFullYear()}`;
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
	return st.language || sc.preferredLanguage || "English";
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
	if (roomTypeKey === "doubleRooms") return "double room";
	if (roomTypeKey === "tripleRooms") return "triple room";
	if (roomTypeKey === "quadRooms") return "quad room";
	return "selected room";
}

function cleanCurrency(value) {
	return String(value || "SAR").toUpperCase();
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
	)} total for ${quote.nights} nights. A Jannat Booking team member can continue the reservation if you like.`;
}

function roomMatches(room = {}, roomTypeKey = "doubleRooms") {
	return (
		room &&
		room.activeRoom &&
		room.roomType === roomTypeKey &&
		Number(room.price?.basePrice || 0) > 0
	);
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
				roomLabel: room?.displayName || "Double room",
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
		st = {
			hotel,
			agentName:
				sc.aiResponderName ||
				AGENT_POOL[Math.floor(Math.random() * AGENT_POOL.length)],
			language: sc.preferredLanguage || "English",
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
		const handoffText = await write(
			io,
			sc,
			st,
			"Tell the guest their request is being escalated to a Jannat Booking team member for personal review. Use the handoff reason only as internal context, keep it one short sentence, and do not ask another question.",
			{ handoffReason: reason }
		);
		if (handoffText) text = handoffText;
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

function recentConversationLines(sc = {}) {
	const conversation = Array.isArray(sc.conversation) ? sc.conversation : [];
	return conversation
		.map((message) => {
			const sender = isAiConversationMessage(message)
				? "Jannat Booking support"
				: message?.messageBy?.customerName || "Guest";
			return `${sender}: ${String(message?.message || "").slice(0, 300)}`;
		})
		.join("\n");
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
	let text =
		reason === "reservation_cancellation"
			? "I understand you want to cancel a reservation. A Jannat Booking team member will take over from here, because cancellations must be handled by a human specialist."
			: reason === "reservation_finalize"
			? "I have the booking details needed to continue. A Jannat Booking team member will take over from here to verify the reservation and payment details before final confirmation."
			: "I understand you want to update an existing reservation. A Jannat Booking team member will take over from here so the change is reviewed correctly.";
	if (/spanish/i.test(lang)) {
		text =
			reason === "reservation_cancellation"
				? "Entiendo que quieres cancelar una reserva. Una persona del equipo de Jannat Booking tomara el chat desde aqui."
				: "Entiendo tu solicitud de reserva. Una persona del equipo de Jannat Booking tomara el chat para revisarla correctamente.";
	} else if (/french/i.test(lang)) {
		text =
			reason === "reservation_cancellation"
				? "Je comprends que vous voulez annuler une reservation. Un membre de Jannat Booking va prendre le relais ici."
				: "Je comprends votre demande de reservation. Un membre de Jannat Booking va prendre le relais pour la verifier correctement.";
	} else if (/arabic/i.test(lang)) {
		text =
			reason === "reservation_cancellation"
				? "فهمت أنك تريد إلغاء حجز. سيتابع معك أحد مختصي Jannat Booking من هنا."
				: "فهمت طلبك. سيتابع معك أحد مختصي Jannat Booking من هنا.";
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

/* LLM writer */
async function write(io, sc, st, instruction, context = {}) {
	const respectfulAddress = respectfulGuestName(sc, st);
	const sys = [
		`You are ${st.agentName} from Jannat Booking support.`,
		`Always write the brand exactly as "Jannat Booking"; do not translate or shorten it.`,
		`You are AI-assisted support monitored by Jannat Booking admins; do not claim to be a human if asked.`,
		`Write in ${st.language}.`,
		`Tone: concise, friendly, official, respectful, and human-like. One booking question at a time.`,
		`Use this respectful customer address naturally when speaking to the guest: ${respectfulAddress}.`,
		`For Arabic conversations, address the guest professionally as "\u0623\u0633\u062a\u0627\u0630 {first name}" when the name is known, such as "\u0623\u0633\u062a\u0627\u0630 \u0646\u0627\u0635\u0631"; keep it warm, not stiff.`,
		`Before replying, study the full conversation transcript and avoid repeating questions, links, or details already covered.`,
		`Do not ask for information the guest has already supplied; move the conversation forward naturally.`,
		st.hotel?.hotelName
			? `Your hotel is "${toTitle(st.hotel.hotelName)}".`
			: `You represent Jannat Booking.`,
		`Help with date-range hotel pricing, hotel options near Al Haram, payment questions, and reservation triage.`,
		`Do not cancel, refund, or mutate existing reservations; send those requests to a human team member.`,
		`Avoid repeating the same question if just asked; prefer a soft pivot.`,
	].join(" ");

	const payload = JSON.stringify({ ...context, respectfulAddress }, null, 2);
	const content = `${instruction}\n\nFull conversation so far:\n${
		recentConversationLines(sc) || "(empty)"
	}\n\nContext JSON:\n${payload}`;

	const answer = await chat(
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

	logStep(String(sc._id), "llm.write", { instruction, outLen: answer.length });
	return answer;
}

async function decideSupportAction({ sc, st, userText, lu }) {
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
		"You are the Jannat Booking chat orchestrator.",
		"Read the whole conversation and decide the next support action before any answer is written.",
		"Use all available context to avoid redundancy and to keep the chat natural in any language.",
		"Return ONLY valid JSON with this shape:",
		"{ action:'hotel_recommendation'|'ask_dates_for_price'|'payment_help'|'reservation_update'|'reservation_cancellation'|'reservation_lookup'|'amenity_question'|'continue_booking'|'smalltalk'|'human_escalation'|'other',",
		"roomTypeKey:null|'singleRooms'|'doubleRooms'|'tripleRooms'|'quadRooms'|'familyRooms', reason:string }",
		"Use the guest's latest message, the full chat transcript, and current slots. Do not write the customer-facing reply.",
		"If check-in and checkout dates are already present in currentSlots or nlu, never choose ask_dates_for_price; choose continue_booking for price or availability.",
		"Choose human_escalation when the request is outside Jannat Booking support scope, needs facts/tools not available in context, or should be reviewed by a person before answering.",
	].join(" ");
	const user = JSON.stringify(
		{
			language: languageOf(sc, st),
			latestUserMessage: userText,
			fullConversation: recentConversationLines(sc),
			currentSlots: st.slots,
			waitFor: st.waitFor,
			nlu: lu || null,
			hotel: hotelSummary,
		},
		null,
		2
	);
	const raw = await chat(
		[
			{ role: "system", content: sys },
			{ role: "user", content: user },
		],
		{ kind: "nlu", temperature: 0, max_tokens: 180 }
	);
	try {
		const parsed = JSON.parse(raw);
		return {
			action: parsed.action || "other",
			roomTypeKey: parsed.roomTypeKey || null,
			reason: parsed.reason || "",
		};
	} catch {
		return { action: "other", roomTypeKey: null, reason: "decision_parse_failed" };
	}
}

async function shareKnownStayQuote(io, sc, st) {
	const quote = priceRoomForStay(
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
	const quoteReply = await write(
		io,
		sc,
		st,
		"Share the availability and price result from the quote context. If unavailable, offer another date range or room type. If available, ask one concise follow-up about whether to continue.",
		{ quote }
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
		if (!userText) {
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
					"Greet the guest by first name and ask how you can help today. Keep it one short line.",
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
			const greetText = await write(
				io,
				sc,
				st,
				`Start: "As‑salāmu ʿalaykum, ${st.slots.name}." Introduce as ${
					st.agentName
				} from ${toTitle(
					st.hotel?.hotelName || "Jannat Booking"
				)}. Then ask: "I see you'd like to make a new reservation — is that correct?" (ONE yes/no).`
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
		}
		if (decisionLu.dates?.checkinISO)
			st.slots.checkinISO = decisionLu.dates.checkinISO;
		if (decisionLu.dates?.checkoutISO)
			st.slots.checkoutISO = decisionLu.dates.checkoutISO;
		if (decisionLu.roomTypeKey) st.slots.roomTypeKey = decisionLu.roomTypeKey;

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

		if (supportDecision.action === "hotel_recommendation") {
			const roomTypeKey =
				supportDecision.roomTypeKey ||
				decisionLu.roomTypeKey ||
				st.slots.roomTypeKey ||
				"doubleRooms";
			const reply = await buildHotelRecommendations({
				text: userText,
				sc,
				st,
				requestedRoomTypeKey: roomTypeKey,
			});
			st.slots.roomTypeKey = roomTypeKey;
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
		if (wantsPriceButMissingDates(userText, st)) {
			const name = st.slots?.name || firstNameOf(sc.displayName1 || "Guest");
			const lang = languageOf(sc, st);
			const reply = /arabic/i.test(lang)
				? `${name}، أرسل تاريخ الدخول والخروج وسأراجع لك السعر.`
				: /spanish/i.test(lang)
				? `${name}, enviame las fechas de check-in y check-out y reviso el precio.`
				: /french/i.test(lang)
				? `${name}, envoyez les dates d'arrivée et de départ et je vérifierai le prix.`
				: `${name}, please send check-in and checkout dates and I can check the price.`;
			await humanSend(io, sc, st, reply);
			st.waitFor = "dates";
			return;
		}
		if (wantsPaymentHelp(userText)) {
			const name = st.slots?.name || firstNameOf(sc.displayName1 || "Guest");
			const lang = languageOf(sc, st);
			const reply = /arabic/i.test(lang)
				? `آسف على مشكلة الدفع يا ${name}. أرسل رقم تأكيد الحجز أو رابط الدفع، وسنراجعها معك.`
				: `Sorry about the payment issue, ${name}. Please send the confirmation number or payment link so we can review it.`;
			await humanSend(io, sc, st, reply);
			st.waitFor = "payment_reference";
			return;
		}
		if (wantsReservationHelp(userText)) {
			const name = st.slots?.name || firstNameOf(sc.displayName1 || "Guest");
			const lang = languageOf(sc, st);
			const reply = /arabic/i.test(lang)
				? `${name}، أرسل رقم تأكيد الحجز وما الذي تريد تعديله وسنراجع الطلب معك.`
				: /spanish/i.test(lang)
				? `${name}, enviame el numero de confirmacion y que quieres actualizar. Lo revisamos contigo.`
				: /french/i.test(lang)
				? `${name}, envoyez le numero de confirmation et ce que vous voulez modifier. Nous allons verifier avec vous.`
				: `${name}, please send the confirmation number and what you want to update. We will review it with you.`;
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

			await humanSend(io, sc, st, ask ? `${line} ${ask}` : line);
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
			quote = priceRoomForStay(
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
			};
			const quoteMsg = await write(
				io,
				sc,
				st,
				"Share a concise availability & price summary (no upsell). Then ask a single yes/no: proceed to confirm?",
				display
			);
			await humanSend(io, sc, st, quoteMsg);
			st.quoteSummarizedAt = now();
		}
		st.waitFor = "proceed";

		// proceed?
		if (st.waitFor === "proceed") {
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

		// Final reservation commits stay with a human Jannat Booking team member.
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
