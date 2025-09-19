// aiagent/core/nlu.js
const { chat } = require("./openai");

/* ---------------- helpers ---------------- */
function firstNameOf(name = "") {
	const s = String(name || "").trim();
	if (!s) return "Guest";
	return s.split(/\s+/)[0];
}

const ROOM_SYNONYMS = [
	{
		key: "doubleRooms",
		terms: [
			"double",
			"standard",
			"king",
			"queen",
			"twin",
			"غرفة مزدوجة",
			"ثنائية",
		],
	},
	{ key: "tripleRooms", terms: ["triple", "3 bed", "three beds", "ثلاثية"] },
	{ key: "quadRooms", terms: ["quad", "4 bed", "four beds", "رباعية"] },
	{ key: "familyRooms", terms: ["family", "quintuple", "5 bed", "خماسية"] },
];

function mapRoomToKey(text = "") {
	const low = text.toLowerCase();
	for (const r of ROOM_SYNONYMS) {
		if (r.terms.some((t) => low.includes(t.toLowerCase()))) return r.key;
	}
	return null;
}

function asciiize(s = "") {
	return String(s)
		.normalize("NFD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^\x20-\x7E]/g, "");
}
function digitsToEnglish(s = "") {
	const map = {
		"٠": "0",
		"١": "1",
		"٢": "2",
		"٣": "3",
		"٤": "4",
		"٥": "5",
		"٦": "6",
		"٧": "7",
		"٨": "8",
		"٩": "9",
	};
	return String(s).replace(/[٠-٩]/g, (ch) => map[ch] || ch);
}

function isPastISO(iso) {
	if (!iso) return false;
	const d = new Date(iso);
	const today = new Date();
	today.setHours(0, 0, 0, 0);
	return d < today;
}
function bumpDatesToFuture({ checkinISO, checkoutISO }) {
	if (!checkinISO) return { checkinISO, checkoutISO };
	let ci = new Date(checkinISO);
	let co = checkoutISO ? new Date(checkoutISO) : null;
	const today = new Date();
	today.setHours(0, 0, 0, 0);

	// keep the same month/day; bump year until not in the past
	while (ci < today) {
		ci.setFullYear(ci.getFullYear() + 1);
		if (co) co.setFullYear(co.getFullYear() + 1);
	}
	if (co && co <= ci) {
		const nights = Math.max(
			1,
			Math.round(
				(new Date(checkoutISO) - new Date(checkinISO)) / (24 * 3600 * 1000)
			)
		);
		co = new Date(ci.getTime() + nights * 24 * 3600 * 1000);
	}
	const toISO = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);
	return { checkinISO: toISO(ci), checkoutISO: toISO(co) };
}

/* ---------------- quick smalltalk (multi‑lingual) ---------------- */
function quickSmalltalkType(text = "") {
	const t = text.trim().toLowerCase();
	if (/^(hi|hello|hey|السلام|مرحبا|اهلا|أهلاً)\b/.test(t)) return "greet";
	if (
		/(how\s*(are|r)\s*(you|u))(?:\s*today)?|كيف حالك|اخبارك|عامل ايه|كيفك/.test(
			t
		)
	)
		return "how_are_you";
	if (/(are\s*you\s*there|you still there|لسه|فينك|موجود)/.test(t))
		return "are_you_there";
	if (/\b(thanks|thank you|شكرا|شكرًا)\b/.test(t)) return "thanks";
	if (/\b(bye|goodbye|see you|مع السلامة|وداعا)\b/.test(t)) return "farewell";
	if (/^(wow|lol|لول|واو)\b/.test(t)) return "wow";
	if (/^(nice|cool|great|تمام|حلو|كويس|جميل)\b/.test(t)) return "chitchat";
	return null;
}

/* ---------------- amenity detection (multi‑lingual) ---------------- */
function detectAmenityQuestion(text = "") {
	const t = String(text).toLowerCase();
	const amenity =
		/\b(wi[\-\s]?fi|wifi|wireless|انترنت|إنترنت|واي\s?فاي)\b/.test(t)
			? "wifi"
			: /\b(parking|garage|موقف|مواقف)\b/.test(t)
			? "parking"
			: /\b(breakfast|افطار|فطور)\b/.test(t)
			? "breakfast"
			: /\b(air\s*conditioning|a\.?c\.?|ac|تكييف)\b/.test(t)
			? "ac"
			: null;

	// Is it a question / request?
	const isQuestion =
		/\?|^do(es)?\b|^is\b|^are\b|available|include|have|فيه|هل/i.test(text);
	return amenity && isQuestion ? amenity : null;
}

/* ---------------- LLM classification fallback ---------------- */
async function detectIntentLLM({
	text,
	preferredLanguage = "English",
	inquiryAbout,
}) {
	const sys = [
		"Classify hotel chat messages.",
		"Return ONLY JSON:",
		"{ intent:'reserve_room'|'reservation_lookup'|'smalltalk'|'confirm_check'|'other',",
		"  smalltalkType:null|'greet'|'how_are_you'|'thanks'|'are_you_there'|'farewell'|'wow'|'chitchat',",
		"  dates:{ checkin:string|null, checkout:string|null, calendar:'gregorian'|'hijri'|null }|null,",
		"  roomText:string|null, confirmation:string|null }",
	].join(" ");

	const user = [
		`Language hint: ${preferredLanguage}`,
		inquiryAbout ? `Ticket inquiryAbout: ${inquiryAbout}` : "",
		`Message: """${text}"""`,
	].join("\n");

	const raw = await chat(
		[
			{ role: "system", content: sys },
			{ role: "user", content: user },
		],
		{ kind: "nlu", temperature: 0, max_tokens: 220 }
	);

	try {
		return JSON.parse(raw);
	} catch {
		return {
			intent: "other",
			smalltalkType: null,
			dates: null,
			roomText: null,
			confirmation: null,
		};
	}
}

/* ---------------- LLM date normalization ---------------- */
async function normalizeDatesLLM({
	checkin,
	checkout,
	preferredLanguage = "English",
}) {
	if (!checkin && !checkout)
		return { checkinISO: null, checkoutISO: null, reason: null };

	const today = new Date().toISOString().slice(0, 10);
	const sys = [
		"Convert input dates to Gregorian ISO (YYYY-MM-DD). Input may be Hijri or Gregorian, any language.",
		"IMPORTANT: If the month is missing for either date, DO NOT infer—return null and set reason:'month_missing'.",
		"If year is missing but month exists, prefer the nearest FUTURE year.",
		"Ensure check-in < check-out; else leave null.",
		"Return ONLY JSON: { checkinISO:string|null, checkoutISO:string|null, reason:null|'month_missing' }",
	].join(" ");

	const user = [
		`Language: ${preferredLanguage}`,
		`todayISO: ${today}`,
		`checkin_raw: ${checkin || ""}`,
		`checkout_raw: ${checkout || ""}`,
	].join("\n");

	const raw = await chat(
		[
			{ role: "system", content: sys },
			{ role: "user", content: user },
		],
		{ kind: "nlu", temperature: 0, max_tokens: 160 }
	);

	let data = null;
	try {
		data = JSON.parse(raw);
	} catch {
		data = null;
	}
	if (!data) return { checkinISO: null, checkoutISO: null, reason: null };

	if (!data.reason && isPastISO(data.checkinISO))
		data = { ...data, ...bumpDatesToFuture(data) };
	return data;
}

/* ---------------- nationality + name helpers ---------------- */
async function validateNationalityLLM(text, language = "English") {
	const raw = await chat(
		[
			{
				role: "system",
				content:
					"Validate nationalities/demonyms in ANY language. Return ONLY JSON: { valid:boolean, normalized:string|null, country:string|null }. 'normalized' MUST be English (Latin).",
			},
			{
				role: "user",
				content: `Language hint: ${language}\nNationality text: """${text}"""\nReturn ONLY JSON.`,
			},
		],
		{ kind: "nlu", temperature: 0, max_tokens: 80 }
	);
	try {
		return JSON.parse(raw);
	} catch {
		return { valid: false, normalized: null, country: null };
	}
}

async function normalizeNameLLM(text, language = "English") {
	const raw = await chat(
		[
			{
				role: "system",
				content:
					"Normalize a person's FULL NAME. If text is in Arabic/other script, transliterate to ASCII Latin. Reject gibberish. Return ONLY JSON: { valid:boolean, fullNameAscii:string|null, first:string|null, last:string|null }.",
			},
			{
				role: "user",
				content: `Language hint: ${language}\nName text: """${text}"""\nReturn ONLY JSON.`,
			},
		],
		{ kind: "nlu", temperature: 0, max_tokens: 80 }
	);
	try {
		return JSON.parse(raw);
	} catch {
		return { valid: false, fullNameAscii: null, first: null, last: null };
	}
}

/* ---------------- main NLU step ---------------- */
async function nluStep({ sc, hotel, lastUserMessage }) {
	const preferredLanguage = sc?.preferredLanguage || "English";
	const inquiryAbout = sc?.inquiryAbout || null;
	const text = String(lastUserMessage || "");

	// smalltalk fast‑path
	const hint = quickSmalltalkType(text);
	if (hint) {
		return {
			intent: "smalltalk",
			smalltalkType: hint,
			roomTypeKey: null,
			dates: {
				checkinISO: null,
				checkoutISO: null,
				checkinPast: false,
				checkoutPast: false,
				raw: { checkin: null, checkout: null, calendar: null },
			},
			confirmation: null,
			firstName: firstNameOf(sc?.displayName1 || sc?.customerName || "Guest"),
			amenity: detectAmenityQuestion(text), // allow amenity while in smalltalk
		};
	}

	const lu = await detectIntentLLM({ text, preferredLanguage, inquiryAbout });
	const roomKey = lu?.roomText ? mapRoomToKey(lu.roomText) : null;

	const iso = await normalizeDatesLLM({
		checkin: lu?.dates?.checkin || null,
		checkout: lu?.dates?.checkout || null,
		preferredLanguage,
	});

	const dates = {
		checkinISO: iso?.checkinISO || null,
		checkoutISO: iso?.checkoutISO || null,
		reason: iso?.reason || null,
		checkinPast: false,
		checkoutPast: false,
		raw: {
			checkin: lu?.dates?.checkin || null,
			checkout: lu?.dates?.checkout || null,
			calendar: lu?.dates?.calendar || null,
		},
	};

	return {
		intent: lu.intent || "other",
		smalltalkType: lu.smalltalkType || null,
		roomTypeKey: roomKey,
		dates,
		confirmation: lu.confirmation || null,
		firstName: firstNameOf(sc?.displayName1 || sc?.customerName || "Guest"),
		amenity: detectAmenityQuestion(text),
	};
}

module.exports = {
	firstNameOf,
	nluStep,
	mapRoomToKey,
	validateNationalityLLM,
	normalizeNameLLM,
	asciiize,
	digitsToEnglish,
	detectAmenityQuestion,
};
