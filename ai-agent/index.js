/* ai-agent/index.js — v6.0 (≤ 2000 LOC)
 * OQAT flow (Room → Dates → Quote → Name→ Phone→ Nationality → Final Confirm → Book)
 * LLM micro-calls for intent/affirm/fields; identity one-liners; strict pricing rules.
 * Works across languages; stores canonical English values.
 */

"use strict";

const OpenAI = require("openai");
const axios = require("axios");
const mongoose = require("mongoose");
const dayjs = require("dayjs");

const SupportCase = require("../models/supportcase");
const HotelDetails = require("../models/hotel_details");
const Reservation = require("../models/reservations");

/* ---------- ENV ---------- */
const RAW_KEY =
	process.env.OPENAI_API_KEY || process.env.CHATGPT_API_TOKEN || "";
const RAW_MODEL = (process.env.AI_MODEL || "gpt-4o-mini").trim();
const SELF_API_BASE = process.env.SELF_API_BASE || "";
const PUBLIC_CLIENT_URL =
	process.env.CLIENT_URL ||
	process.env.CLIENT_PUBLIC_URL ||
	"https://jannatbooking.com";

/* ---------- Persona ---------- */
const PERSONAS = {
	en: ["Yusuf", "Mona", "Amal", "Omar", "Sara"],
	ar: ["يوسف", "منى", "أمل", "عمر", "سارة"],
	es: ["Yusef", "Mona", "Amal"],
	fr: ["Youssef", "Mona", "Amal"],
	ur: ["یوسف", "سارہ"],
	hi: ["यूसुफ", "सारा"],
};
const pickPersona = (lang) => {
	const arr = PERSONAS[lang] || PERSONAS.en;
	return arr[Math.floor(Math.random() * arr.length)];
};

/* ---------- UX timings ---------- */
const TYPING_START_AFTER = 500;
const TYPING_HEARTBEAT_MS = 1200;
const MIN_TYPE_MS = 650,
	PER_CHAR_MS = 24,
	MAX_TYPE_MS = 8200;
const WAIT_WHILE_TYPING_MS = 1300;
const DEBOUNCE_MS = 1100;

const computeTypeDelay = (t = "") =>
	Math.max(
		MIN_TYPE_MS,
		Math.min(MAX_TYPE_MS, MIN_TYPE_MS + String(t).length * PER_CHAR_MS)
	);

/* ---------- State ---------- */
const caseState = new Map();
/*
  st = {
    lang, personaName, greeted, hotelId, hotelDoc,
    flow: "NEW"|"EXIST"|null,
    step: "ROOM"|"DATES"|"QUOTE"|"DETAILS_NAME"|"DETAILS_PHONE"|"DETAILS_NAT"|"FINAL_CONFIRM"|null,
    slots: { room_canon, ci, co, nightly, total, name, phone, nationality_en, confirmation },
    waitingConfirm: false,  // used at QUOTE and FINAL_CONFIRM
    lastPromptKey: null, lastPromptAt: 0,
    lastLinkSentFor: null
  }
*/
const typingTimers = new Map();
const idleTimers = new Map();
const userTyping = new Map();
const debounceMap = new Map();
const greetedCases = new Set();

/* ---------- Utils ---------- */
const lower = (s) => String(s || "").toLowerCase();
const looksLikeOpenAIKey = (k) =>
	typeof k === "string" && /^sk-/.test(k.trim());
const isValidObjectId = (x) => mongoose.Types.ObjectId.isValid(String(x));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const onlyDigits = (s = "") => String(s || "").replace(/\D+/g, "");
const isLikelyPhone = (s = "") => onlyDigits(s).length >= 7;
const isFullName = (s = "") =>
	String(s).trim().split(/\s+/).filter(Boolean).length >= 2;
const extractConfirmation = (s = "") => {
	const m1 = String(s || "").match(/\b[A-Z0-9\-]{6,}\b/);
	if (m1) return m1[0];
	const m2 = String(s || "").match(/\b\d{8,14}\b/);
	return m2 ? m2[0] : null;
};

/* typing orchestration */
function setGuestTyping(caseId, isTyping) {
	const prev = userTyping.get(caseId) || { isTyping: false, lastStopAt: 0 };
	const now = Date.now();
	userTyping.set(caseId, {
		isTyping,
		lastStopAt: isTyping ? prev.lastStopAt : now,
	});
}
function shouldWaitForGuest(caseId) {
	const st = userTyping.get(caseId);
	if (!st) return false;
	if (st.isTyping) return true;
	return Date.now() - (st.lastStopAt || 0) < WAIT_WHILE_TYPING_MS;
}

/* send */
function startTyping(io, caseId, name) {
	const t1 = setTimeout(
		() => io.to(caseId).emit("typing", { caseId, name, isAi: true }),
		TYPING_START_AFTER
	);
	const intv = setInterval(
		() => io.to(caseId).emit("typing", { caseId, name, isAi: true }),
		TYPING_HEARTBEAT_MS
	);
	typingTimers.set(caseId, { t1, intv });
}
function stopTyping(io, caseId) {
	const t = typingTimers.get(caseId);
	if (t) {
		clearTimeout(t.t1);
		clearInterval(t.intv);
		typingTimers.delete(caseId);
	}
	io.to(caseId).emit("stopTyping", { caseId, isAi: true });
}
async function send(io, { caseId, text, personaName, lang }) {
	if (!text) return;
	startTyping(io, caseId, personaName);
	await delay(computeTypeDelay(text));
	const msg = {
		messageBy: {
			customerName: personaName,
			customerEmail: "management@xhotelpro.com",
			userId: null,
		},
		message: text,
		date: new Date(),
		seenByAdmin: true,
		seenByHotel: true,
		seenByCustomer: true,
	};
	try {
		await SupportCase.findByIdAndUpdate(caseId, {
			$set: { aiRelated: true },
			$push: { conversation: msg },
		});
	} catch {}
	stopTyping(io, caseId);
	io.to(caseId).emit("receiveMessage", {
		...msg,
		caseId,
		preferredLanguage: lang,
		preferredLanguageCode: lang,
	});
	armIdleClose(io, caseId, personaName);
}
function armIdleClose(io, caseId, personaName) {
	const prev = idleTimers.get(caseId);
	if (prev) clearTimeout(prev.t);
	const t = setTimeout(async () => {
		try {
			const doc = await SupportCase.findById(caseId).lean();
			if (!doc || doc.caseStatus === "closed") return;
			await SupportCase.findByIdAndUpdate(caseId, { caseStatus: "closed" });
			io.to(caseId).emit("caseClosed", {
				caseId,
				closedBy: personaName || "system",
			});
		} catch {}
		idleTimers.delete(caseId);
	}, 5 * 60 * 1000);
	idleTimers.set(caseId, { t, at: Date.now() });
}

/* ---------- OpenAI ---------- */
if (!looksLikeOpenAIKey(RAW_KEY))
	console.error("[AI] OPENAI_API_KEY missing/invalid.");
const client = new OpenAI({ apiKey: RAW_KEY });
const MODEL = RAW_MODEL;
async function llmJSON({ system, user, temperature = 0.0, max_tokens = 500 }) {
	try {
		const r = await client.chat.completions.create({
			model: MODEL,
			temperature,
			max_tokens,
			response_format: { type: "json_object" },
			messages: [
				{ role: "system", content: system },
				{ role: "user", content: user },
			],
		});
		const c = r.choices?.[0]?.message?.content?.trim();
		return c ? JSON.parse(c) : null;
	} catch {
		return null;
	}
}

/* ---------- NLU ---------- */
const nlu = {
	async classify(text, roomTypes = []) {
		const system = `
Extract hotel chat intents/entities in JSON:
{
 "language": "en|ar|es|fr|ur|hi|...",
 "intents": {
   "new_booking": bool,
   "existing_booking": bool,
   "change_dates": bool,
   "cancel_reservation": bool,
   "ask_room_info": bool,
   "ask_identity_work_for_hotel": bool,
   "ask_identity_reception": bool,
   "ask_identity_in_saudi": bool,
   "ask_human_agent": bool,
   "ask_link_or_pdf": bool
 },
 "signals": {"is_affirmative": bool, "is_negative": bool},
 "entities": {
   "room_type_freeform": string|null,
   "room_type_canonical": ${JSON.stringify(roomTypes)}[i]|null,
   "dates": {"check_in_date": "YYYY-MM-DD"|null, "check_out_date": "YYYY-MM-DD"|null},
   "confirmation_number": string|null,
   "phone": string|null,
   "nationality_input": string|null,
   "name": string|null
 }
}
Rules:
- Be strict for is_affirmative (clear authorization only).
- Map room type to provided canonical list if possible.
- Extract dates from any language; if ambiguous, leave null.
- ask_room_info true when they ask features/amenities/price for a room type.
`;
		return (
			(await llmJSON({
				system,
				user: JSON.stringify({ text }),
				temperature: 0,
			})) || null
		);
	},
	async validateNationality(input) {
		const system = `
Validate a nationality/demonym. JSON:
{"valid": bool, "canonical_en": string|null, "country_en": string|null}
Reject gibberish. Be conservative.
`;
		return (
			(await llmJSON({
				system,
				user: JSON.stringify({ input: String(input || "").trim() }),
			})) || { valid: false }
		);
	},
	async answerRoomInfo({ hotel, question, roomTypes }) {
		const system = `
You are a hotel assistant. Use ONLY this JSON document to answer about rooms.
Return JSON: {"answer": "short helpful text", "used_room_type": string|null}
Document (hotelDetails): ${JSON.stringify({
			hotelName: hotel?.hotelName,
			city: hotel?.hotelCity,
			country: hotel?.hotelCountry,
			roomCountDetails: (hotel?.roomCountDetails || []).map((r) => ({
				roomType: r.roomType,
				displayName: r.displayName,
				description: r.description,
				description_OtherLanguage: r.description_OtherLanguage,
				amenities: r.amenities,
				extraAmenities: r.extraAmenities,
				views: r.views,
				basePrice: r?.price?.basePrice ?? r?.defaultCost ?? null,
			})),
		})}
Guidelines:
- If the question mentions a specific room type, use its data.
- If price asked without dates, mention basePrice as starting point (no totals).
- Keep it concise (≤ 3 sentences).
`;
		const out = await llmJSON({
			system,
			user: JSON.stringify({ question, roomTypes }),
		});
		return out?.answer || null;
	},
};

/* ---------- Language lines ---------- */
const L = {
	greet: (lang, hotel, persona, first) => {
		const G = first ? ` ${first}` : "";
		if (lang === "ar")
			return `السلام عليكم${G}! أنا ${persona} من ${hotel}. هل تريد حجزًا جديدًا أم المساعدة في حجز قائم؟`;
		if (lang === "es")
			return `¡Assalamu alaikum${G}! Soy ${persona} de ${hotel}. ¿Reserva nueva o ayuda con una existente?`;
		if (lang === "fr")
			return `Assalamu alaykoum${G} ! Je suis ${persona} de ${hotel}. Nouvelle réservation ou aide sur une existante ?`;
		if (lang === "ur")
			return `السلام علیکم${G}! میں ${persona}، ${hotel} سے۔ نئی بکنگ یا موجودہ میں مدد؟`;
		if (lang === "hi")
			return `अस्सलामु अलैकुम${G}! मैं ${persona}, ${hotel} से। नई बुकिंग या मौजूदा में मदद?`;
		return `Assalamu alaikum${G}! I’m ${persona} from ${hotel}. New booking or help with an existing one?`;
	},
	askNewOrExisting: (lang) => {
		if (lang === "ar") return "هل نبدأ بحجز جديد أم ترغب بتعديل/إلغاء حجز؟";
		if (lang === "es")
			return "¿Empezamos una reserva nueva o deseas modificar/cancelar?";
		if (lang === "fr")
			return "Souhaitez‑vous une nouvelle réservation ou modifier/annuler ?";
		if (lang === "ur") return "نئی بکنگ شروع کریں یا موجودہ میں تبدیلی/منسوخی؟";
		if (lang === "hi") return "नई बुकिंग शुरू करें या मौजूदा में बदलाव/रद्द?";
		return "Shall we start a new booking, or would you like to change/cancel one?";
	},
	askRoom: (lang, opts = []) => {
		const o = opts.length ? ` (${opts.join(" / ")})` : "";
		if (lang === "ar") return `ما نوع الغرفة المفضل لديك؟${o}`;
		if (lang === "es") return `¿Qué tipo de habitación prefieres?${o}`;
		if (lang === "fr") return `Quel type de chambre préférez‑vous ?${o}`;
		if (lang === "ur") return `آپ کون سا کمرہ پسند کریں گے؟${o}`;
		if (lang === "hi") return `आप कौन‑सा कमरे का प्रकार चाहेंगे?${o}`;
		return `Which room type would you like?${o}`;
	},
	askDates: (lang) => {
		if (lang === "ar")
			return "ما هي تواريخ الوصول والمغادرة؟ (مثال: 2025‑09‑16 → 2025‑09‑19)";
		if (lang === "es")
			return "¿Fechas de entrada y salida? (p.ej., 2025‑09‑16 → 2025‑09‑19)";
		if (lang === "fr")
			return "Quelles sont vos dates d’arrivée et de départ ? (ex. 2025‑09‑16 → 2025‑09‑19)";
		if (lang === "ur")
			return "چیک‑ان اور چیک‑آؤٹ کی تاریخیں؟ (مثال: 2025‑09‑16 → 2025‑09‑19)";
		if (lang === "hi")
			return "चेक‑इन और चेक‑आउट तिथियाँ? (जैसे 2025‑09‑16 → 2025‑09‑19)";
		return "What are your check‑in & check‑out dates? (e.g., 2025‑09‑16 → 2025‑09‑19)";
	},
	badDates: (lang) => {
		if (lang === "ar")
			return "التواريخ غير صالحة (الوصول يجب أن يكون مستقبليًا والمغادرة بعده). شاركني مثل: 2025‑09‑16 → 2025‑09‑19";
		if (lang === "es")
			return "Fechas inválidas (entrada futura y salida posterior). Formato: 2025‑09‑16 → 2025‑09‑19";
		if (lang === "fr")
			return "Dates invalides (arrivée future, départ après). Format : 2025‑09‑16 → 2025‑09‑19";
		if (lang === "ur")
			return "تاریخیں درست نہیں (چیک‑ان مستقبل میں اور چیک‑آؤٹ بعد میں). فارمیٹ: 2025‑09‑16 → 2025‑09‑19";
		if (lang === "hi")
			return "तिथियाँ मान्य नहीं (चेक‑इन भविष्य में, चेक‑आउट बाद में). फ़ॉर्मैट: 2025‑09‑16 → 2025‑09‑19";
		return "Dates look invalid (check‑in must be future; check‑out after). Please share like 2025‑09‑16 → 2025‑09‑19";
	},
	quote: (lang, room, ci, co, total) => {
		const dates = `${ci} → ${co}`;
		if (lang === "ar")
			return `السعر الكلي لغرفة ${room} للفترة ${dates} هو ${total} SAR. هل يناسبك لنكمل التفاصيل؟`;
		if (lang === "es")
			return `El total para ${room} del ${dates} es ${total} SAR. ¿Te parece bien para continuar con los datos?`;
		if (lang === "fr")
			return `Le total pour ${room} du ${dates} est de ${total} SAR. Cela vous convient pour finaliser les détails ?`;
		if (lang === "ur")
			return `${room} کے لیے ${dates} کا کُل ${total} SAR بنتا ہے۔ کیا یہ ٹھیک ہے تاکہ تفصیلات مکمل کروں؟`;
		if (lang === "hi")
			return `${room} के लिए ${dates} का कुल ${total} SAR है। क्या यह ठीक है ताकि आगे विवरण भर दूँ?`;
		return `The total for ${room} from ${dates} is ${total} SAR. Shall I proceed to finalize details?`;
	},
	askNameConfirm: (lang, name) => {
		if (lang === "ar") return `هل ترغب أن أسجّل الحجز بالاسم: “${name}”؟`;
		if (lang === "es")
			return `¿Deseas que la reserva vaya a nombre de “${name}”?`;
		if (lang === "fr")
			return `Souhaitez‑vous que la réservation soit au nom de « ${name} » ?`;
		if (lang === "ur") return `کیا ریزرویشن اسی نام “${name}” پر ہو؟`;
		if (lang === "hi") return `क्या आरक्षण “${name}” के नाम से कर दूँ?`;
		return `Shall I put the reservation under “${name}”?`;
	},
	askFullName: (lang) => {
		if (lang === "ar")
			return "برجاء مشاركة الاسم الكامل (الاسم الأول + العائلة).";
		if (lang === "es")
			return "Por favor comparte tu nombre completo (nombre y apellido).";
		if (lang === "fr")
			return "Merci d’indiquer votre nom complet (prénom + nom).";
		if (lang === "ur") return "براہ کرم پورا نام (نام + خاندانی نام) بتائیں۔";
		if (lang === "hi")
			return "कृपया अपना पूरा नाम (पहला नाम + उपनाम) साझा करें।";
		return "Please share your full name (first + last).";
	},
	askPhone: (lang) => {
		if (lang === "ar") return "هل تود مشاركة رقم هاتف/واتساب؟ (اختياري)";
		if (lang === "es")
			return "¿Quieres compartir tu teléfono/WhatsApp? (opcional)";
		if (lang === "fr")
			return "Souhaitez‑vous partager votre téléphone/WhatsApp ? (optionnel)";
		if (lang === "ur") return "کیا فون/واٹس ایپ نمبر شیئر کریں گے؟ (اختیاری)";
		if (lang === "hi")
			return "क्या आप फ़ोन/व्हाट्सऐप नंबर साझा करना चाहेंगे? (वैकल्पिक)";
		return "Would you like to share a phone/WhatsApp number? (optional)";
	},
	askNationality: (lang) => {
		if (lang === "ar") return "ما هي جنسيتك؟ (مثال: سعودي، مصري، باكستاني)";
		if (lang === "es")
			return "¿Cuál es tu nacionalidad? (ej.: Saudí, Egipcia, Pakistaní)";
		if (lang === "fr")
			return "Quelle est votre nationalité ? (ex. Saoudien, Égyptien, Pakistanais)";
		if (lang === "ur")
			return "آپ کی قومیت کیا ہے؟ (مثلاً سعودی، مصری، پاکستانی)";
		if (lang === "hi")
			return "आपकी राष्ट्रीयता क्या है? (जैसे Saudi, Egyptian, Pakistani)";
		return "What is your nationality? (e.g., Saudi, Egyptian, Pakistani)";
	},
	nationalityBad: (lang) => {
		if (lang === "ar")
			return "يبدو أن الجنسية غير صحيحة. شارك جنسية صالحة (مثلاً: سعودي، مصري، باكستاني).";
		if (lang === "es")
			return "Esa nacionalidad no parece válida. Comparte una válida (p.ej., Saudí, Egipcia, Pakistaní).";
		if (lang === "fr")
			return "Cette nationalité ne semble pas valide. Indiquez une nationalité valide (ex. Saoudien, Égyptien, Pakistanais).";
		if (lang === "ur")
			return "قومیت درست معلوم نہیں ہوتی۔ براہِ کرم درست قومیت بتائیں (مثلاً: سعودی، مصری، پاکستانی).";
		if (lang === "hi")
			return "वह राष्ट्रीयता मान्य नहीं लगती। कृपया मान्य राष्ट्रीयता बताएं (जैसे Saudi, Egyptian, Pakistani).";
		return "That doesn’t look like a valid nationality. Please share a valid one (e.g., Saudi, Egyptian, Pakistani).";
	},
	finalSummary: (lang, s, hotel) => {
		const dates = `${s.ci} → ${s.co}`;
		const phone = s.phone
			? s.phone
			: lang === "ar"
			? "غير مذكور"
			: lang === "es"
			? "no indicado"
			: lang === "fr"
			? "non indiqué"
			: lang === "ur"
			? "مہیا نہیں"
			: lang === "hi"
			? "उपलब्ध नहीं"
			: "not provided";
		if (lang === "ar")
			return `الملخص النهائي:\n- الفندق: ${hotel}\n- الغرفة: ${
				s.room_canon
			}\n- التواريخ: ${dates}\n- الإجمالي: ${s.total} SAR\n- الاسم: ${
				s.name
			}\n- الهاتف: ${phone}\n- الجنسية: ${
				s.nationality_en || "—"
			}\nأؤكد الحجز الآن؟`;
		if (lang === "es")
			return `Resumen final:\n- Hotel: ${hotel}\n- Habitación: ${
				s.room_canon
			}\n- Fechas: ${dates}\n- Total: ${s.total} SAR\n- Nombre: ${
				s.name
			}\n- Teléfono: ${phone}\n- Nacionalidad: ${
				s.nationality_en || "—"
			}\n¿Confirmo la reserva ahora?`;
		if (lang === "fr")
			return `Récapitulatif final :\n- Hôtel : ${hotel}\n- Chambre : ${
				s.room_canon
			}\n- Dates : ${dates}\n- Total : ${s.total} SAR\n- Nom : ${
				s.name
			}\n- Téléphone : ${phone}\n- Nationalité : ${
				s.nationality_en || "—"
			}\nPuis‑je confirmer maintenant ?`;
		if (lang === "ur")
			return `حتمی خلاصہ:\n- ہوٹل: ${hotel}\n- کمرہ: ${
				s.room_canon
			}\n- تاریخیں: ${dates}\n- کُل: ${s.total} SAR\n- نام: ${
				s.name
			}\n- فون: ${phone}\n- قومیت: ${
				s.nationality_en || "—"
			}\nکیا میں اب کنفرم کروں؟`;
		if (lang === "hi")
			return `अंतिम सारांश:\n- होटल: ${hotel}\n- कमरा: ${
				s.room_canon
			}\n- तिथियाँ: ${dates}\n- कुल: ${s.total} SAR\n- नाम: ${
				s.name
			}\n- फ़ोन: ${phone}\n- राष्ट्रीयता: ${
				s.nationality_en || "—"
			}\nक्या मैं अब पुष्टि कर दूँ?`;
		return `Final summary:\n- Hotel: ${hotel}\n- Room: ${
			s.room_canon
		}\n- Dates: ${dates}\n- Total: ${s.total} SAR\n- Name: ${
			s.name
		}\n- Phone: ${phone}\n- Nationality: ${
			s.nationality_en || "—"
		}\nShall I confirm the booking now?`;
	},
	booked: (lang, conf) => {
		if (lang === "ar")
			return `تم تأكيد الحجز ✅\nرقم التأكيد: ${conf}\nسأرسل الرابط التالي.`;
		if (lang === "es")
			return `¡Reserva confirmada! ✅\nN.º de confirmación: ${conf}\nEnvío el enlace a continuación.`;
		if (lang === "fr")
			return `Réservation confirmée ✅\nN° de confirmation : ${conf}\nJ’envoie le lien juste après.`;
		if (lang === "ur")
			return `بکنگ کنفرم ✅\nکنفرمیشن نمبر: ${conf}\nلنک ابھی بھیجتا/بھیجتی ہوں۔`;
		if (lang === "hi")
			return `आरक्षण कन्फ़र्म ✅\nकन्फ़र्मेशन नंबर: ${conf}\nअभी लिंक भेजता/भेजती हूँ।`;
		return `Reservation confirmed! ✅\nConfirmation: ${conf}\nI’ll send the link next.`;
	},
	updated: (lang) => {
		if (lang === "ar") return `تم التحديث. سأرسل رابط التأكيد التالي.`;
		if (lang === "es") return `Actualizado. Envío el enlace a continuación.`;
		if (lang === "fr")
			return `Mise à jour effectuée. J’envoie le lien juste après.`;
		if (lang === "ur") return `اپڈیٹ مکمل۔ لنک ابھی ارسال کروں گا/گی۔`;
		if (lang === "hi") return `अपडेट पूरा। अगला पुष्टि लिंक भेजता/भेजती हूँ।`;
		return `Updated. I’ll send your confirmation link next.`;
	},
	link: (lang, link) => {
		if (lang === "ar") return `🔗 رابط التأكيد (يتضمن PDF): ${link}`;
		if (lang === "es")
			return `🔗 Enlace de confirmación (PDF incluido): ${link}`;
		if (lang === "fr") return `🔗 Lien de confirmation (PDF inclus) : ${link}`;
		if (lang === "ur") return `🔗 کنفرمیشن لنک (PDF کے ساتھ): ${link}`;
		if (lang === "hi") return `🔗 पुष्टि लिंक (PDF सहित): ${link}`;
		return `🔗 Confirmation link (includes PDF): ${link}`;
	},
	cannotPrice: (lang) => {
		if (lang === "ar")
			return "لا يمكن التسعير لهذه التواريخ/النوع. هل تفضّل نوعًا أو تواريخ أخرى؟";
		if (lang === "es")
			return "No puedo calcular para esas fechas/tipo. ¿Quieres otro tipo o fechas?";
		if (lang === "fr")
			return "Je ne peux pas tarifer pour ces dates/type. Souhaitez-vous un autre type ou d’autres dates ?";
		if (lang === "ur")
			return "ان تاریخوں/قسم کی قیمت نہیں نکل رہی۔ کوئی دوسرا آپشن یا تاریخیں؟";
		if (lang === "hi")
			return "उन तिथियों/टाइप का मूल्य नहीं निकाल पा रहा/रही। दूसरा टाइप या तिथियाँ?";
		return "I can’t price those dates/type. Would you like another room type or dates?";
	},
	// Identity — exact lines requested
	id_workHotel: () => "Yes, I am a customer support in the hotel.",
	id_reception: () =>
		"I'm not a receptionist, but I'm in a different department in the hotel.",
	id_inSaudi: () => "Yes I am sir, how can I help you now",
	askHuman: (lang) => {
		if (lang === "ar")
			return "أستطيع مساعدتك هنا أو تحويلك لزميل. هل تود المتابعة هنا؟";
		if (lang === "es")
			return "Puedo ayudarte aquí o pasarte con un compañero. ¿Seguimos aquí?";
		if (lang === "fr")
			return "Je peux vous aider ici ou vous passer un collègue. Souhaitez‑vous continuer ici ?";
		if (lang === "ur")
			return "میں یہاں مدد کر سکتا/سکتی ہوں یا ساتھی کو شامل کر دوں۔ کیا یہیں جاری رکھیں؟";
		if (lang === "hi")
			return "मैं यहीं मदद कर सकता/सकती हूँ या किसी साथी को जोड़ दूँ। क्या यहीं जारी रखें?";
		return "I can help you here or loop in a teammate. Would you like to continue here?";
	},
};

/* ---------- Pricing ---------- */
const canonicalFromText = (t = "") => {
	const s = lower(t);
	if (/triple|ثلاث|tripl/.test(s)) return "tripleRooms";
	if (/twin|توين/.test(s)) return "twinRooms";
	if (/double|دبل|مزدوج/.test(s)) return "doubleRooms";
	if (/quad|رباع/.test(s)) return "quadRooms";
	if (/family|عائ/.test(s)) return "familyRooms";
	if (/suite|سويت|جناح/.test(s)) return "suiteRooms";
	if (/king|كينج/.test(s)) return "kingRooms";
	if (/queen|كوين/.test(s)) return "queenRooms";
	return null;
};
function roomMap(hotel) {
	const arr = hotel?.roomCountDetails || [];
	const byType = new Map(arr.map((r) => [String(r.roomType || "").trim(), r]));
	return { arr, byType };
}
function nightlyArray(room, ci, co) {
	const s = dayjs(ci).startOf("day");
	const e = dayjs(co).subtract(1, "day").startOf("day");
	const rate = room?.pricingRate || [];
	const base = Number(room?.price?.basePrice ?? room?.defaultCost ?? 0);
	const addCommission = room?.commisionIncluded ? false : true; // schema uses "commisionIncluded"
	const commRate = Number(room?.roomCommission || 10);
	const rows = [];
	let cur = s;
	while (cur.isBefore(e) || cur.isSame(e, "day")) {
		const d = cur.format("YYYY-MM-DD");
		const row = rate.find((r) => r.calendarDate === d);
		let price = row ? Number(row.price || 0) : base; // missing → base
		const root = row
			? Number(row.rootPrice || 0)
			: Number(room?.defaultCost ?? base);
		if ((!row && base <= 0) || price === 0) {
			rows.push({ date: d, blocked: true, price: 0, root: root || 0 });
		} else {
			let total = price;
			if (addCommission)
				total = Number((price + (root || 0) * (commRate / 100)).toFixed(2));
			rows.push({
				date: d,
				blocked: false,
				price: total,
				base: price,
				root: root || 0,
			});
		}
		cur = cur.add(1, "day");
	}
	return rows;
}
const anyBlocked = (arr) => arr.some((x) => x.blocked);
const totalOf = (arr) =>
	Number(arr.reduce((a, d) => a + Number(d.price || 0), 0).toFixed(2));
function nearestAvailableWindow(room, ci, nights, span = 14) {
	const start = dayjs(ci).startOf("day");
	let best = null;
	for (let dir of [1, -1]) {
		for (let d = 1; d <= span; d++) {
			const s = start.add(dir * d, "day");
			const e = s.add(nights, "day");
			const n = nightlyArray(room, s, e);
			if (!anyBlocked(n)) {
				const tot = totalOf(n);
				const cand = {
					check_in_date: s.format("YYYY-MM-DD"),
					check_out_date: e.format("YYYY-MM-DD"),
					total: tot,
				};
				if (!best || Math.abs(d) < best.d) best = { d: Math.abs(d), ...cand };
				break;
			}
		}
	}
	return best;
}

/* ---------- Reservation ops ---------- */
async function findReservationByConfirmation(confirmation) {
	const conf = String(confirmation || "").trim();
	if (!conf) return { ok: false, error: "Confirmation required." };
	const doc = await Reservation.findOne({
		$or: [{ confirmation: conf }, { confirmation_number: conf }],
	})
		.populate("hotelId")
		.lean();
	if (!doc) return { ok: false, not_found: true, error: "Not found" };
	return {
		ok: true,
		reservation: {
			_id: doc._id,
			confirmation: doc.confirmation || doc.confirmation_number || conf,
			status: doc.status || doc.reservation_status || "",
			checkin_date: doc.checkin_date,
			checkout_date: doc.checkout_date,
			hotelId: doc.hotelId?._id || doc.hotelId,
			hotel_name: doc.hotelId?.hotelName || doc.hotel_name || "",
			customer_details: doc.customer_details || doc.customerDetails || {},
			total_amount: doc.total_amount,
			pickedRoomsType: doc.pickedRoomsType || [],
		},
	};
}
async function applyReservationUpdate({
	reservation_id,
	confirmation_number,
	changes,
}) {
	let _id = null;
	if (reservation_id && isValidObjectId(reservation_id))
		_id = String(reservation_id);
	else if (confirmation_number) {
		const found = await findReservationByConfirmation(confirmation_number);
		if (!found?.ok)
			return { ok: false, error: found?.error || "Reservation not found." };
		_id = String(found.reservation._id);
	} else
		return {
			ok: false,
			error: "reservation_id or confirmation_number required.",
		};

	const payload = { ...changes };
	if (payload.check_in_date) payload.checkin_date = payload.check_in_date;
	if (payload.check_out_date) payload.checkout_date = payload.check_out_date;
	delete payload.check_in_date;
	delete payload.check_out_date;

	if (payload.checkin_date && payload.checkout_date) {
		const ci = dayjs(payload.checkin_date),
			co = dayjs(payload.checkout_date);
		if (!ci.isValid() || !co.isValid() || !co.isAfter(ci, "day"))
			return { ok: false, error: "Invalid dates." };
	}
	const updated = await Reservation.findByIdAndUpdate(_id, payload, {
		new: true,
	}).lean();
	if (!updated) return { ok: false, error: "Reservation not found." };
	return { ok: true, reservation: updated };
}
async function cancelReservationByIdOrConfirmation(idOrConf) {
	let _id = null;
	if (isValidObjectId(idOrConf)) _id = String(idOrConf);
	else {
		const found = await findReservationByConfirmation(idOrConf);
		if (!found?.ok)
			return { ok: false, error: found?.error || "Reservation not found." };
		_id = String(found.reservation._id);
	}
	const doc = await Reservation.findByIdAndUpdate(
		_id,
		{
			status: "cancelled",
			reservation_status: "cancelled",
			cancelled_by: "aiagent",
			cancelled_at: new Date(),
		},
		{ new: true }
	).lean();
	if (!doc) return { ok: false, error: "Reservation not found." };
	return { ok: true, reservation: doc };
}

/* ---------- Booking create ---------- */
function flattenPickedRooms(pickedRooms) {
	return pickedRooms.map((r) => ({
		room_type: r.room_type,
		displayName: r.displayName || r.room_type,
		count: r.count || 1,
		pricingByDay: r.nightly.map((d) => ({
			date: d.date,
			price: Number(d.base || d.price || 0),
			rootPrice: Number(d.root || 0),
			commissionRate: 0,
			totalPriceWithCommission: Number(d.price || 0),
			totalPriceWithoutCommission: Number(d.base || 0),
		})),
		totalPriceWithCommission: totalOf(r.nightly),
		hotelShouldGet: r.nightly.reduce((a, d) => a + Number(d.root || 0), 0),
	}));
}
function computeTotals(flat = []) {
	const total_amount = Number(
		flat
			.reduce((a, r) => a + Number(r.totalPriceWithCommission || 0), 0)
			.toFixed(2)
	);
	const totalRoot = Number(
		flat.reduce((a, r) => a + Number(r.hotelShouldGet || 0), 0).toFixed(2)
	);
	const commission = Number((total_amount - totalRoot).toFixed(2));
	const oneNightCost = Number(
		flat
			.reduce((a, r) => a + (r.pricingByDay?.[0]?.rootPrice || 0), 0)
			.toFixed(2)
	);
	const final_deposit = Number((commission + oneNightCost).toFixed(2));
	return {
		total_amount,
		total_commission: commission,
		one_night_cost: oneNightCost,
		final_deposit,
	};
}
async function createReservation({
	personaName,
	hotel,
	caseId,
	guest,
	stay,
	pickedRooms,
}) {
	const flat = flattenPickedRooms(pickedRooms);
	const totals = computeTotals(flat);
	if (!(totals.total_amount > 0))
		return { ok: false, error: "Pricing total is zero or invalid." };

	if (SELF_API_BASE) {
		try {
			const payload = {
				userId: null,
				hotelId: hotel._id,
				belongsTo: hotel.belongsTo?._id || hotel.belongsTo || "",
				hotel_name: hotel.hotelName || "",
				customerDetails: {
					name: guest.name,
					email: guest.email || "",
					phone: guest.phone || "",
					nationality: guest.nationality || "",
					passport: "Not Provided",
					passportExpiry: "2027-01-01",
					postalCode: "00000",
					reservedBy: `${personaName} (aiagent)`,
				},
				total_rooms: flat.length,
				total_guests: (guest.adults || 2) + (guest.children || 0),
				adults: guest.adults || 2,
				children: guest.children || 0,
				checkin_date: stay.check_in_date,
				checkout_date: stay.check_out_date,
				days_of_residence: dayjs(stay.check_out_date).diff(
					dayjs(stay.check_in_date),
					"day"
				),
				booking_source: "jannat employee",
				pickedRoomsType: flat,
				total_amount: totals.total_amount,
				payment: "Not Paid",
				paid_amount: 0,
				commission: totals.total_commission,
				commissionPaid: false,
				paymentDetails: {
					cardNumber: "",
					cardExpiryDate: "",
					cardCVV: "",
					cardHolderName: "",
				},
				sentFrom: "employee",
				advancePayment: {
					paymentPercentage: "",
					finalAdvancePayment: totals.final_deposit.toFixed(2),
				},
			};
			const resp = await axios
				.post(`${SELF_API_BASE}/new-reservation-client-employee`, payload, {
					timeout: 25000,
				})
				.then((r) => r.data);
			const conf =
				resp?.confirmation ||
				resp?.confirmationNumber ||
				resp?.data?.confirmation ||
				resp?.data?.confirmationNumber ||
				resp?.data?.reservation?.confirmation ||
				resp?.reservation?.confirmation ||
				resp?.data?.data?.confirmation ||
				"";
			if (conf) {
				return {
					ok: true,
					confirmation: conf,
					publicLink: `${PUBLIC_CLIENT_URL}/single-reservation/${conf}`,
					paymentLink: resp?.paymentLink || resp?.data?.paymentLink || null,
					payloadResponse: resp,
				};
			}
		} catch {}
	}

	try {
		let conf = "";
		for (let i = 0; i < 6; i++) {
			const tmp = String(Math.floor(1000000000 + Math.random() * 9000000000));
			// eslint-disable-next-line no-await-in-loop
			const exists = await Reservation.exists({
				$or: [{ confirmation: tmp }, { confirmation_number: tmp }],
			});
			if (!exists) {
				conf = tmp;
				break;
			}
		}
		if (!conf) throw new Error("Could not generate confirmation number.");
		await Reservation.create({
			hotelId: hotel._id,
			hotel_name: hotel.hotelName || "",
			confirmation: conf,
			status: "confirmed",
			reservation_status: "confirmed",
			customer_details: {
				name: guest.name,
				email: guest.email || "",
				phone: guest.phone || "",
				nationality: guest.nationality || "",
			},
			adults: guest.adults || 2,
			children: guest.children || 0,
			total_guests: (guest.adults || 2) + (guest.children || 0),
			checkin_date: stay.check_in_date,
			checkout_date: stay.check_out_date,
			days_of_residence: dayjs(stay.check_out_date).diff(
				dayjs(stay.check_in_date),
				"day"
			),
			pickedRoomsType: flat,
			total_amount: totals.total_amount,
			commission: totals.total_commission,
			payment: "Not Paid",
			paid_amount: 0,
			createdBy: `${personaName} (aiagent)`,
			sentFrom: "aiagent",
		});
		return {
			ok: true,
			confirmation: conf,
			publicLink: `${PUBLIC_CLIENT_URL}/single-reservation/${conf}`,
			paymentLink: null,
			payloadResponse: {},
		};
	} catch (e) {
		return { ok: false, error: e?.message || "Local create failed." };
	}
}

/* ---------- Stay validation ---------- */
function validateStay(stay) {
	if (!stay?.check_in_date || !stay?.check_out_date) return { ok: false };
	const ci = dayjs(stay.check_in_date).startOf("day");
	const co = dayjs(stay.check_out_date).startOf("day");
	if (!ci.isValid() || !co.isValid()) return { ok: false };
	if (!co.isAfter(ci, "day")) return { ok: false };
	const today = dayjs().startOf("day");
	if (ci.isBefore(today)) return { ok: false };
	return { ok: true };
}

/* ---------- Identity helpers ---------- */
function isAssistantLike(m) {
	const n = lower(m?.messageBy?.customerName || "");
	const e = lower(m?.messageBy?.customerEmail || "");
	return (
		e === "management@xhotelpro.com" ||
		n.includes("support") ||
		n.includes("agent")
	);
}
function knownIdentity(caseDoc) {
	const convo = Array.isArray(caseDoc?.conversation)
		? caseDoc.conversation
		: [];
	const firstUser = convo.find((m) => !isAssistantLike(m)) || {};
	const by = firstUser.messageBy || {};
	const name =
		caseDoc.customerName || caseDoc.displayName1 || by.customerName || "";
	const email =
		!by.customerEmail || isLikelyPhone(by.customerEmail)
			? ""
			: by.customerEmail || "";
	const phone = isLikelyPhone(by.customerEmail) ? by.customerEmail : "";
	return { name, email, phone };
}
function ensureState(caseId) {
	const s = caseState.get(caseId) || {
		lang: "en",
		personaName: pickPersona("en"),
		greeted: false,
		hotelId: null,
		hotelDoc: null,
		flow: null,
		step: null,
		slots: {
			room_canon: "",
			ci: "",
			co: "",
			nightly: [],
			total: 0,
			name: "",
			phone: "",
			nationality_en: "",
			confirmation: "",
		},
		waitingConfirm: false,
		lastPromptKey: null,
		lastPromptAt: 0,
		lastLinkSentFor: null,
	};
	caseState.set(caseId, s);
	return s;
}

/* ---------- Greeting ---------- */
async function greetIfNeeded(io, caseDoc, st) {
	if (st.greeted) return;
	st.greeted = true;
	const hotel = caseDoc.hotelId?.hotelName || "our hotel";
	const first = (knownIdentity(caseDoc).name || "").split(/\s+/)[0] || "";
	await send(io, {
		caseId: caseDoc._id,
		text: L.greet(st.lang, hotel, st.personaName, first),
		personaName: st.personaName,
		lang: st.lang,
	});
}

/* ---------- Confirmation link sender ---------- */
async function sendPublicLinkOnce(io, { caseId, st, confirmation }) {
	if (!confirmation) return;
	if (st.lastLinkSentFor === confirmation) return;
	const link = `${PUBLIC_CLIENT_URL}/single-reservation/${confirmation}`;
	await send(io, {
		caseId,
		text: L.link(st.lang, link),
		personaName: st.personaName,
		lang: st.lang,
	});
	st.lastLinkSentFor = confirmation;
}

/* ---------- Prompt de-dup ---------- */
function shouldAsk(st, key, cooldownMs = 60000) {
	const now = Date.now();
	if (st.lastPromptKey === key && now - st.lastPromptAt < cooldownMs)
		return false;
	st.lastPromptKey = key;
	st.lastPromptAt = now;
	return true;
}

/* ---------- NEW booking runner (Room → Dates → Quote → Details → Final) ---------- */
async function runNew(io, caseDoc, st, nluOut) {
	const hotel = st.hotelDoc;
	const { arr } = roomMap(hotel);
	const roomList = arr.map((r) => r.roomType);

	/* absorb entities in correct order */
	const e = nluOut?.entities || {};

	if (!st.slots.room_canon) {
		const canon =
			e.room_type_canonical || canonicalFromText(e.room_type_freeform || "");
		if (canon && arr.find((r) => r.roomType === canon))
			st.slots.room_canon = canon;
	}

	// room info questions answered from hotel schema (no step change)
	if (nluOut?.intents?.ask_room_info) {
		const ans = await nlu.answerRoomInfo({
			hotel,
			question: String(caseDoc?.conversation?.slice(-1)?.[0]?.message || ""),
			roomTypes: roomList,
		});
		if (ans)
			await send(io, {
				caseId: caseDoc._id,
				text: ans,
				personaName: st.personaName,
				lang: st.lang,
			});
	}

	if (!st.slots.room_canon) {
		if (shouldAsk(st, "askRoom"))
			await send(io, {
				caseId: caseDoc._id,
				text: L.askRoom(st.lang, roomList),
				personaName: st.personaName,
				lang: st.lang,
			});
		st.step = "ROOM";
		return;
	}

	if (!(st.slots.ci && st.slots.co)) {
		const d = e.dates || {};
		if (d.check_in_date && d.check_out_date) {
			const v = validateStay({
				check_in_date: d.check_in_date,
				check_out_date: d.check_out_date,
			});
			if (v.ok) {
				st.slots.ci = d.check_in_date;
				st.slots.co = d.check_out_date;
			}
		}
		if (!(st.slots.ci && st.slots.co)) {
			if (shouldAsk(st, "askDates"))
				await send(io, {
					caseId: caseDoc._id,
					text: L.askDates(st.lang),
					personaName: st.personaName,
					lang: st.lang,
				});
			st.step = "DATES";
			return;
		}
	}

	if (
		!st.waitingConfirm &&
		st.step !== "DETAILS_NAME" &&
		st.step !== "DETAILS_PHONE" &&
		st.step !== "DETAILS_NAT" &&
		st.step !== "FINAL_CONFIRM"
	) {
		// price the selection → quote
		const room = arr.find((r) => r.roomType === st.slots.room_canon);
		const nights = dayjs(st.slots.co).diff(dayjs(st.slots.ci), "day");
		const nightly = nightlyArray(room, st.slots.ci, st.slots.co);
		if (anyBlocked(nightly)) {
			const alt = nearestAvailableWindow(room, st.slots.ci, nights);
			if (alt) {
				st.waitingConfirm = true;
				st.step = "QUOTE";
				const msg = ((lang) => {
					if (lang === "ar")
						return `هذه التواريخ غير متاحة. أقرب خيار: ${alt.check_in_date} → ${alt.check_out_date} (الإجمالي ${alt.total} SAR). هل تريد استخدامه؟`;
					if (lang === "es")
						return `Esas fechas no están disponibles. Opción más cercana: ${alt.check_in_date} → ${alt.check_out_date} (total ${alt.total} SAR). ¿Usamos esa?`;
					if (lang === "fr")
						return `Ces dates ne sont pas disponibles. Option la plus proche : ${alt.check_in_date} → ${alt.check_out_date} (total ${alt.total} SAR). L’utiliser ?`;
					if (lang === "ur")
						return `یہ تاریخیں دستیاب نہیں۔ قریب ترین آپشن: ${alt.check_in_date} → ${alt.check_out_date} (کل ${alt.total} SAR). کیا اسے اختیار کریں؟`;
					if (lang === "hi")
						return `ये तिथियाँ उपलब्ध नहीं हैं। निकटतम विकल्प: ${alt.check_in_date} → ${alt.check_out_date} (कुल ${alt.total} SAR). अपनाएँ?`;
					return `Those dates aren’t available. Nearest option: ${alt.check_in_date} → ${alt.check_out_date} (total ${alt.total} SAR). Use this?`;
				})(st.lang);
				st.slots.nightly = [];
				st.slots.total = 0;
				st.slots.alt = alt;
				await send(io, {
					caseId: caseDoc._id,
					text: msg,
					personaName: st.personaName,
					lang: st.lang,
				});
				return;
			}
			await send(io, {
				caseId: caseDoc._id,
				text: L.cannotPrice(st.lang),
				personaName: st.personaName,
				lang: st.lang,
			});
			st.step = "DATES";
			return;
		}
		const total = totalOf(nightly);
		if (!(total > 0)) {
			await send(io, {
				caseId: caseDoc._id,
				text: L.cannotPrice(st.lang),
				personaName: st.personaName,
				lang: st.lang,
			});
			st.step = "DATES";
			return;
		}
		st.slots.nightly = nightly;
		st.slots.total = total;
		st.waitingConfirm = true;
		st.step = "QUOTE";
		await send(io, {
			caseId: caseDoc._id,
			text: L.quote(st.lang, room.roomType, st.slots.ci, st.slots.co, total),
			personaName: st.personaName,
			lang: st.lang,
		});
		return;
	}

	// handle quote confirm/deny
	if (st.step === "QUOTE" && st.waitingConfirm) {
		if (nluOut?.signals?.is_affirmative) {
			// proceed to details → ask name confirm using case name
			const displayName = knownIdentity(caseDoc).name || "";
			const proposeName = isFullName(displayName)
				? displayName
				: displayName
				? displayName + " Guest"
				: "Guest";
			st.slots.name = "";
			st.waitingConfirm = false;
			st.step = "DETAILS_NAME";
			await send(io, {
				caseId: caseDoc._id,
				text: L.askNameConfirm(st.lang, proposeName),
				personaName: st.personaName,
				lang: st.lang,
			});
			st.slots._proposedName = proposeName;
			return;
		}
		if (nluOut?.signals?.is_negative) {
			// re-ask dates to adjust
			st.waitingConfirm = false;
			st.step = "DATES";
			await send(io, {
				caseId: caseDoc._id,
				text: L.askDates(st.lang),
				personaName: st.personaName,
				lang: st.lang,
			});
			return;
		}
		// if unclear, just re-prompt gently once more
		if (shouldAsk(st, "quoteNudge", 20000))
			await send(io, {
				caseId: caseDoc._id,
				text: L.quote(
					st.lang,
					st.slots.room_canon,
					st.slots.ci,
					st.slots.co,
					st.slots.total
				),
				personaName: st.personaName,
				lang: st.lang,
			});
		return;
	}

	// NAME
	if (st.step === "DETAILS_NAME") {
		if (!st.slots.name) {
			const nameEnt = e.name;
			if (nluOut?.signals?.is_affirmative && st.slots._proposedName)
				st.slots.name = st.slots._proposedName;
			else if (isFullName(nameEnt || "")) st.slots.name = nameEnt.trim();
			else if (isFullName(knownIdentity(caseDoc).name || ""))
				st.slots.name = knownIdentity(caseDoc).name.trim();
			if (!st.slots.name) {
				if (shouldAsk(st, "askFullName"))
					await send(io, {
						caseId: caseDoc._id,
						text: L.askFullName(st.lang),
						personaName: st.personaName,
						lang: st.lang,
					});
				return;
			}
		}
		st.step = "DETAILS_PHONE";
		await send(io, {
			caseId: caseDoc._id,
			text: L.askPhone(st.lang),
			personaName: st.personaName,
			lang: st.lang,
		});
		return;
	}

	// PHONE (optional)
	if (st.step === "DETAILS_PHONE") {
		const phone = e.phone || "";
		if (phone && isLikelyPhone(phone)) st.slots.phone = phone.trim();
		st.step = "DETAILS_NAT";
		await send(io, {
			caseId: caseDoc._id,
			text: L.askNationality(st.lang),
			personaName: st.personaName,
			lang: st.lang,
		});
		return;
	}

	// NATIONALITY (validated; if blank, we still can proceed)
	if (st.step === "DETAILS_NAT") {
		const natIn = e.nationality_input || "";
		if (natIn) {
			const v = await nlu.validateNationality(natIn);
			if (v?.valid && v?.canonical_en) st.slots.nationality_en = v.canonical_en;
			else {
				if (shouldAsk(st, "natBad"))
					await send(io, {
						caseId: caseDoc._id,
						text: L.nationalityBad(st.lang),
						personaName: st.personaName,
						lang: st.lang,
					});
				return;
			}
		}
		// Show final summary and ask for confirm to book
		st.step = "FINAL_CONFIRM";
		st.waitingConfirm = true;
		await send(io, {
			caseId: caseDoc._id,
			text: L.finalSummary(st.lang, st.slots, hotel.hotelName || "our hotel"),
			personaName: st.personaName,
			lang: st.lang,
		});
		return;
	}

	// FINAL CONFIRM
	if (st.step === "FINAL_CONFIRM" && st.waitingConfirm) {
		if (nluOut?.signals?.is_affirmative) {
			const { arr } = roomMap(hotel);
			const room =
				arr.find((r) => r.roomType === st.slots.room_canon) || arr[0];
			const pickedRooms = [
				{
					room_type: room.roomType,
					displayName: room.displayName || room.roomType,
					count: 1,
					nightly: st.slots.nightly,
				},
			];
			const guest = {
				name: st.slots.name || "Guest",
				email: knownIdentity(caseDoc).email || "",
				phone: st.slots.phone || "",
				nationality: st.slots.nationality_en || "",
				adults:
					room.roomType === "tripleRooms"
						? 3
						: room.roomType === "quadRooms"
						? 4
						: 2,
				children: 0,
			};
			const stay = { check_in_date: st.slots.ci, check_out_date: st.slots.co };
			const res = await createReservation({
				personaName: st.personaName,
				hotel,
				caseId: caseDoc._id,
				guest,
				stay,
				pickedRooms,
			});
			if (res.ok) {
				st.waitingConfirm = false;
				st.step = null;
				await send(io, {
					caseId: caseDoc._id,
					text: L.booked(st.lang, res.confirmation),
					personaName: st.personaName,
					lang: st.lang,
				});
				await sendPublicLinkOnce(io, {
					caseId: caseDoc._id,
					st,
					confirmation: res.confirmation,
				});
			} else {
				await send(io, {
					caseId: caseDoc._id,
					text: L.cannotPrice(st.lang),
					personaName: st.personaName,
					lang: st.lang,
				});
			}
			return;
		}
		if (nluOut?.signals?.is_negative) {
			// Go back to details (ask which field to change → start with dates)
			st.waitingConfirm = false;
			st.step = "DATES";
			await send(io, {
				caseId: caseDoc._id,
				text: L.askDates(st.lang),
				personaName: st.personaName,
				lang: st.lang,
			});
			return;
		}
		if (shouldAsk(st, "finalNudge", 20000))
			await send(io, {
				caseId: caseDoc._id,
				text: L.finalSummary(st.lang, st.slots, hotel.hotelName || "our hotel"),
				personaName: st.personaName,
				lang: st.lang,
			});
		return;
	}
}

/* ---------- EXISTING booking runner (change/cancel) ---------- */
async function runExisting(io, caseDoc, st, nluOut) {
	const e = nluOut?.entities || {};
	const conf =
		e.confirmation_number ||
		st.slots.confirmation ||
		extractConfirmation(
			String(caseDoc?.conversation?.slice(-1)?.[0]?.message || "")
		) ||
		null;
	if (!conf) {
		await send(io, {
			caseId: caseDoc._id,
			text: ((lang) => {
				if (lang === "ar") return "من فضلك شاركني رقم تأكيد الحجز.";
				if (lang === "es")
					return "Por favor comparte el número de confirmación.";
				if (lang === "fr")
					return "Merci de partager le numéro de confirmation.";
				if (lang === "ur") return "براہ کرم کنفرمیشن نمبر شیئر کریں۔";
				if (lang === "hi") return "कृपया कन्फर्मेशन नंबर साझा करें।";
				return "Please share your confirmation number.";
			})(st.lang),
			personaName: st.personaName,
			lang: st.lang,
		});
		return;
	}
	st.slots.confirmation = conf;
	const found = await findReservationByConfirmation(conf);
	if (!found?.ok) {
		await send(io, {
			caseId: caseDoc._id,
			text: ((lang) => {
				if (lang === "ar")
					return "لم أجد هذا الرقم. شارك رقم التأكيد مرة أخرى.";
				if (lang === "es")
					return "No encuentro ese número. Compártelo de nuevo, por favor.";
				if (lang === "fr")
					return "Je ne trouve pas ce numéro. Merci de le renvoyer.";
				if (lang === "ur")
					return "یہ نمبر نہیں ملا۔ براہِ کرم دوبارہ شیئر کریں۔";
				if (lang === "hi") return "यह नंबर नहीं मिला। कृपया फिर से साझा करें।";
				return "I couldn’t locate that confirmation. Please share it again.";
			})(st.lang),
			personaName: st.personaName,
			lang: st.lang,
		});
		return;
	}
	const res = found.reservation;

	if (nluOut?.intents?.cancel_reservation) {
		st.waitingConfirm = true;
		st.step = "EXIST_CANCEL";
		await send(io, {
			caseId: caseDoc._id,
			text: `Cancel reservation ${res.confirmation}?`,
			personaName: st.personaName,
			lang: st.lang,
		});
		if (nluOut?.signals?.is_affirmative) {
			const out = await cancelReservationByIdOrConfirmation(res._id);
			if (out.ok) {
				await send(io, {
					caseId: caseDoc._id,
					text: `Reservation ${res.confirmation} cancelled.`,
					personaName: st.personaName,
					lang: st.lang,
				});
				await sendPublicLinkOnce(io, {
					caseId: caseDoc._id,
					st,
					confirmation: res.confirmation,
				});
			} else {
				await send(io, {
					caseId: caseDoc._id,
					text: `Couldn’t cancel: ${out.error || "Unknown error"}`,
					personaName: st.personaName,
					lang: st.lang,
				});
			}
			st.waitingConfirm = false;
			st.step = null;
		}
		return;
	}

	if (nluOut?.intents?.change_dates) {
		const d = e.dates || {};
		if (!(d.check_in_date && d.check_out_date)) {
			await send(io, {
				caseId: caseDoc._id,
				text: ((lang) => {
					if (lang === "ar")
						return "ما التواريخ الجديدة؟ (YYYY‑MM‑DD → YYYY‑MM‑DD)";
					if (lang === "es")
						return "¿Cuáles son las nuevas fechas? (YYYY‑MM‑DD → YYYY‑MM‑DD)";
					if (lang === "fr")
						return "Quelles sont les nouvelles dates ? (YYYY‑MM‑DD → YYYY‑MM‑DD)";
					if (lang === "ur") return "نئی تاریخیں؟ (YYYY‑MM‑DD → YYYY‑MM‑DD)";
					if (lang === "hi") return "नई तिथियाँ? (YYYY‑MM‑DD → YYYY‑MM‑DD)";
					return "What are the new dates? (YYYY‑MM‑DD → YYYY‑MM‑DD)";
				})(st.lang),
				personaName: st.personaName,
				lang: st.lang,
			});
			return;
		}
		const v = validateStay({
			check_in_date: d.check_in_date,
			check_out_date: d.check_out_date,
		});
		if (!v.ok) {
			await send(io, {
				caseId: caseDoc._id,
				text: L.badDates(st.lang),
				personaName: st.personaName,
				lang: st.lang,
			});
			return;
		}

		// price against same room line
		const hotel = await HotelDetails.findById(res.hotelId).lean();
		const firstLine = (res.pickedRoomsType || [])[0];
		const canon =
			firstLine?.room_type ||
			canonicalFromText(firstLine?.displayName || "") ||
			"doubleRooms";
		const { arr } = roomMap(hotel);
		const room = arr.find((r) => r.roomType === canon) || arr[0];
		const nights = dayjs(d.check_out_date).diff(dayjs(d.check_in_date), "day");
		const nightly = nightlyArray(room, d.check_in_date, d.check_out_date);
		if (anyBlocked(nightly)) {
			const alt = nearestAvailableWindow(room, d.check_in_date, nights);
			if (alt) {
				st.waitingConfirm = true;
				st.step = "EXIST_CHANGE_ALT";
				st.slots.alt = alt;
				await send(io, {
					caseId: caseDoc._id,
					text: ((lang) => {
						if (lang === "ar")
							return `هذه التواريخ غير متاحة. أقرب خيار: ${alt.check_in_date} → ${alt.check_out_date} (الإجمالي ${alt.total} SAR). هل تريد استخدامه؟`;
						if (lang === "es")
							return `Esas fechas no están disponibles. Opción más cercana: ${alt.check_in_date} → ${alt.check_out_date} (total ${alt.total} SAR). ¿La usamos?`;
						if (lang === "fr")
							return `Ces dates ne sont pas disponibles. Option proche : ${alt.check_in_date} → ${alt.check_out_date} (total ${alt.total} SAR). L’utiliser ?`;
						if (lang === "ur")
							return `یہ تاریخیں دستیاب نہیں۔ قریب ترین آپشن: ${alt.check_in_date} → ${alt.check_out_date} (کل ${alt.total} SAR). منتخب کریں؟`;
						if (lang === "hi")
							return `ये तिथियाँ उपलब्ध नहीं हैं। निकटतम विकल्प: ${alt.check_in_date} → ${alt.check_out_date} (कुल ${alt.total} SAR). अपनाएँ?`;
						return `Those dates aren’t available. Nearest option: ${alt.check_in_date} → ${alt.check_out_date} (total ${alt.total} SAR). Use this?`;
					})(st.lang),
					personaName: st.personaName,
					lang: st.lang,
				});
				if (nluOut?.signals?.is_affirmative) {
					const out = await applyReservationUpdate({
						reservation_id: res._id,
						changes: {
							check_in_date: alt.check_in_date,
							check_out_date: alt.check_out_date,
						},
					});
					if (out.ok) {
						await send(io, {
							caseId: caseDoc._id,
							text: L.updated(st.lang),
							personaName: st.personaName,
							lang: st.lang,
						});
						await sendPublicLinkOnce(io, {
							caseId: caseDoc._id,
							st,
							confirmation: res.confirmation,
						});
					} else {
						await send(io, {
							caseId: caseDoc._id,
							text: `Couldn't update: ${out.error || "Unknown error"}`,
							personaName: st.personaName,
							lang: st.lang,
						});
					}
					st.waitingConfirm = false;
					st.step = null;
				}
				return;
			}
			await send(io, {
				caseId: caseDoc._id,
				text: L.cannotPrice(st.lang),
				personaName: st.personaName,
				lang: st.lang,
			});
			return;
		}
		const total = totalOf(nightly);
		if (!(total > 0)) {
			await send(io, {
				caseId: caseDoc._id,
				text: L.cannotPrice(st.lang),
				personaName: st.personaName,
				lang: st.lang,
			});
			return;
		}
		// ask to confirm change
		st.waitingConfirm = true;
		st.step = "EXIST_CHANGE";
		st.slots.ci = d.check_in_date;
		st.slots.co = d.check_out_date;
		await send(io, {
			caseId: caseDoc._id,
			text: ((lang) => {
				const dates = `${st.slots.ci} → ${st.slots.co}`;
				if (lang === "ar")
					return `سأحدث حجز ${res.confirmation} إلى ${dates}. أؤكد التعديل؟`;
				if (lang === "es")
					return `Actualizaré la reserva ${res.confirmation} a ${dates}. ¿Confirmo el cambio?`;
				if (lang === "fr")
					return `Je mets à jour la réservation ${res.confirmation} en ${dates}. Confirmez‑vous ?`;
				if (lang === "ur")
					return `ریزرویشن ${res.confirmation} کو ${dates} میں اپڈیٹ کروں؟ کنفرم؟`;
				if (lang === "hi")
					return `आरक्षण ${res.confirmation} को ${dates} में अपडेट कर दूँ? पुष्टि करूँ?`;
				return `I will update reservation ${res.confirmation} to ${dates}. Shall I confirm the change?`;
			})(st.lang),
			personaName: st.personaName,
			lang: st.lang,
		});

		if (nluOut?.signals?.is_affirmative) {
			const out = await applyReservationUpdate({
				reservation_id: res._id,
				changes: { check_in_date: st.slots.ci, check_out_date: st.slots.co },
			});
			if (out.ok) {
				await send(io, {
					caseId: caseDoc._id,
					text: L.updated(st.lang),
					personaName: st.personaName,
					lang: st.lang,
				});
				await sendPublicLinkOnce(io, {
					caseId: caseDoc._id,
					st,
					confirmation: res.confirmation,
				});
			} else {
				await send(io, {
					caseId: caseDoc._id,
					text: `Couldn't update: ${out.error || "Unknown error"}`,
					personaName: st.personaName,
					lang: st.lang,
				});
			}
			st.waitingConfirm = false;
			st.step = null;
		}
		return;
	}

	// If they said "existing" without action, offer prompt
	await send(io, {
		caseId: caseDoc._id,
		text: ((lang) => {
			if (lang === "ar") return "هل تريد إلغاء الحجز أو تغيير التواريخ؟";
			if (lang === "es")
				return "¿Deseas cancelar la reserva o cambiar las fechas?";
			if (lang === "fr")
				return "Souhaitez‑vous annuler la réservation ou changer les dates ?";
			if (lang === "ur")
				return "کیا آپ ریزرویشن منسوخ کرنا چاہتے ہیں یا تاریخیں بدلنا؟";
			if (lang === "hi")
				return "क्या आप आरक्षण रद्द करना चाहते हैं या तिथियाँ बदलना?";
			return "Would you like to cancel the reservation or change the dates?";
		})(st.lang),
		personaName: st.personaName,
		lang: st.lang,
	});
}

/* ---------- Identity & link intents ---------- */
async function handleMetaIntents(io, caseDoc, st, nluOut) {
	if (nluOut?.intents?.ask_identity_work_for_hotel) {
		await send(io, {
			caseId: caseDoc._id,
			text: L.id_workHotel(),
			personaName: st.personaName,
			lang: st.lang,
		});
		return true;
	}
	if (nluOut?.intents?.ask_identity_reception) {
		await send(io, {
			caseId: caseDoc._id,
			text: L.id_reception(),
			personaName: st.personaName,
			lang: st.lang,
		});
		return true;
	}
	if (nluOut?.intents?.ask_identity_in_saudi) {
		await send(io, {
			caseId: caseDoc._id,
			text: L.id_inSaudi(),
			personaName: st.personaName,
			lang: st.lang,
		});
		return true;
	}
	if (nluOut?.intents?.ask_human_agent) {
		await send(io, {
			caseId: caseDoc._id,
			text: L.askHuman(st.lang),
			personaName: st.personaName,
			lang: st.lang,
		});
		return true;
	}
	if (nluOut?.intents?.ask_link_or_pdf) {
		const conf =
			st.slots.confirmation ||
			extractConfirmation(
				String(caseDoc?.conversation?.slice(-1)?.[0]?.message || "")
			) ||
			extractConfirmation(caseDoc?.inquiryDetails || "");
		if (conf)
			await sendPublicLinkOnce(io, {
				caseId: caseDoc._id,
				st,
				confirmation: conf,
			});
		else
			await send(io, {
				caseId: caseDoc._id,
				text: ((lang) => {
					if (lang === "ar") return "شارك رقم التأكيد لأرسل الرابط.";
					if (lang === "es")
						return "Comparte el número de confirmación para enviarte el enlace.";
					if (lang === "fr")
						return "Partagez le numéro de confirmation pour que j’envoie le lien.";
					if (lang === "ur")
						return "لنک بھیجنے کے لیے کنفرمیشن نمبر شیئر کریں۔";
					if (lang === "hi")
						return "लिंक भेजने के लिए कृपया कन्फर्मेशन नंबर साझा करें।";
					return "Please share your confirmation number and I’ll send the link.";
				})(st.lang),
				personaName: st.personaName,
				lang: st.lang,
			});
		return true;
	}
	return false;
}

/* ---------- Main processor ---------- */
async function processPayload(io, payload) {
	const caseId = payload?.caseId;
	if (!caseId) return;
	if (shouldWaitForGuest(caseId)) {
		const prev = debounceMap.get(caseId);
		const timer = setTimeout(
			() => processPayload(io, prev.payload),
			WAIT_WHILE_TYPING_MS
		);
		debounceMap.set(caseId, { payload, timer });
		return;
	}

	const caseDoc = await SupportCase.findById(caseId).populate("hotelId").lean();
	if (!caseDoc?.hotelId || caseDoc?.hotelId?.aiToRespond !== true) return;

	const st = ensureState(caseId);
	if (!st.hotelDoc) {
		st.hotelDoc = caseDoc.hotelId;
		st.hotelId = caseDoc.hotelId?._id || caseDoc.hotelId;
	}
	if (!st.personaName) st.personaName = pickPersona(st.lang);

	// Language seed from inquiryDetails (Preferred Language: … (xx))
	if (!st.greeted) {
		const hint = (String(caseDoc.inquiryDetails || "").match(
			/\((en|ar|es|fr|ur|hi)\)/i
		) || [])[1];
		if (hint) st.lang = hint.toLowerCase();
	}
	await greetIfNeeded(io, caseDoc, st);

	/* Aggregate burst messages (debounce) */
	const prev = debounceMap.get(caseId);
	if (prev?.timer) clearTimeout(prev.timer);
	const timer = setTimeout(async () => {
		try {
			const doc = await SupportCase.findById(caseId).lean();
			const lastMsgs = (doc?.conversation || [])
				.slice(-5)
				.filter((m) => !isAssistantLike(m))
				.map((m) => String(m.message || "").trim())
				.filter(Boolean);
			const text = lastMsgs.length
				? lastMsgs.join("\n")
				: String(payload?.message || "").trim();
			const roomTypes = (st.hotelDoc?.roomCountDetails || []).map(
				(r) => r.roomType
			);
			const n = await nlu.classify(text, roomTypes);

			// adapt language if detected (but keep earlier language if confident)
			if (n?.language && st.lang === "en") st.lang = n.language.toLowerCase();

			// meta/intros
			if (await handleMetaIntents(io, caseDoc, st, n)) return;

			// decide flow
			if (!st.flow) {
				if (n?.intents?.new_booking) st.flow = "NEW";
				else if (n?.intents?.existing_booking) st.flow = "EXIST";
				else {
					const about = String(caseDoc.inquiryAbout || "").toLowerCase();
					st.flow = about.includes("reserve")
						? "NEW"
						: about.includes("reservation")
						? "EXIST"
						: "NEW";
				}
			}

			if (st.flow === "NEW") {
				await runNew(io, caseDoc, st, n);
				return;
			}
			if (st.flow === "EXIST") {
				await runExisting(io, caseDoc, st, n);
				return;
			}
		} catch (e) {
			console.error("[AI] process burst error:", e?.message || e);
		}
	}, DEBOUNCE_MS);
	debounceMap.set(caseId, { payload, timer });
}

/* ---------- Sockets & watcher ---------- */
function initAIAgent({ app, io }) {
	if (!looksLikeOpenAIKey(RAW_KEY)) {
		console.error(
			"[AI] OPENAI_API_KEY missing/invalid (must start with 'sk-')."
		);
		return;
	}

	try {
		if (typeof SupportCase.watch === "function") {
			const stream = SupportCase.watch(
				[{ $match: { operationType: "insert" } }],
				{ fullDocument: "updateLookup" }
			);
			stream.on("change", async (ch) => {
				const id = ch?.fullDocument?._id;
				if (!id) return;
				const doc = ch.fullDocument;
				if (doc?.openedBy !== "client") return;
				const hdoc = await SupportCase.findById(id).populate("hotelId").lean();
				if (!hdoc?.hotelId?.aiToRespond) return;
				const st = ensureState(String(id));
				const hint = (String(hdoc.inquiryDetails || "").match(
					/\((en|ar|es|fr|ur|hi)\)/i
				) || [])[1];
				st.lang = (hint || "en").toLowerCase();
				st.personaName = pickPersona(st.lang);
				await greetIfNeeded(io, hdoc, st);
			});
			stream.on("error", (err) =>
				console.error("[AI] change stream error:", err?.message || err)
			);
			console.log("[AI] Auto-greet watcher active.");
		}
	} catch (e) {
		console.log(
			"[AI] Change streams init failed; relying on socket fallbacks.",
			e?.message || e
		);
	}

	io.on("connection", (socket) => {
		socket.on("joinRoom", async ({ caseId }) => {
			if (!caseId) return;
			const caseDoc = await SupportCase.findById(caseId)
				.populate("hotelId")
				.lean();
			if (!caseDoc?.hotelId?.aiToRespond) return;
			const st = ensureState(caseId);
			st.personaName = st.personaName || pickPersona(st.lang);
			await greetIfNeeded(io, caseDoc, st);
		});

		socket.on("typing", (data = {}) => {
			if (!data?.caseId) return;
			setGuestTyping(String(data.caseId), true);
		});
		socket.on("stopTyping", (data = {}) => {
			if (!data?.caseId) return;
			setGuestTyping(String(data.caseId), false);
		});

		socket.on("sendMessage", async (payload) => {
			try {
				await processPayload(io, payload);
			} catch (e) {
				console.error("[AI] processPayload error:", e?.message || e);
			}
		});
	});

	console.log(
		"[AI] Ready (v6.0): OQAT (room→dates→quote→details→final confirm), LLM NLU, safe pricing, identity one‑liners, multilingual."
	);
}

module.exports = { initAIAgent };
