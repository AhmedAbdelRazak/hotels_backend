// ai-agent/index.js
const OpenAI = require("openai");
const axios = require("axios");
const mongoose = require("mongoose");
const dayjs = require("dayjs");

const SupportCase = require("../models/supportcase");
const HotelDetails = require("../models/hotel_details");
const Reservation = require("../models/reservations");
const { buildSystemPrompt, pickPersona, normalizeLang } = require("./prompt");
const { fetchGuidanceForAgent } = require("./learning");

/* ---------- ENV ---------- */
const RAW_KEY =
	process.env.OPENAI_API_KEY || process.env.CHATGPT_API_TOKEN || "";
const RAW_MODEL = process.env.AI_MODEL || "gpt-4.1";
const CLIENT_URL_XHOTEL = process.env.SELF_API_BASE || ""; // e.g., http://localhost:3001/api
const PUBLIC_CLIENT_URL =
	process.env.CLIENT_URL ||
	process.env.CLIENT_PUBLIC_URL ||
	(CLIENT_URL_XHOTEL ? CLIENT_URL_XHOTEL.replace(/\/api\/?$/, "") : "");

/* ---------- Timing knobs ---------- */
const AUTO_GREET_DELAY_MS = 5000;
const WAIT_WHILE_TYPING_MS = 2000;
const DEBOUNCE_MS = 1600;
const TYPING_START_AFTER = 1000;
const TYPING_HEARTBEAT_MS = 1500;
const MIN_TYPE_MS = 900,
	PER_CHAR_MS = 55,
	MAX_TYPE_MS = 12000;
const AUTO_CLOSE_AFTER_MS = 5000;
const WAIT_FOLLOWUP_MS = 10000; // 10s follow-up when agent asked to wait

/* ---------- Small utils ---------- */
const lower = (s) => String(s || "").toLowerCase();
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const isValidObjectId = (x) => {
	try {
		return !!new mongoose.Types.ObjectId(x);
	} catch {
		return false;
	}
};
const computeTypeDelay = (t = "") =>
	clamp(MIN_TYPE_MS + String(t).length * PER_CHAR_MS, MIN_TYPE_MS, MAX_TYPE_MS);
const maskKey = (k) => {
	const s = String(k || "");
	return s.length <= 10 ? "***" : `${s.slice(0, 4)}...${s.slice(-4)}`;
};
const looksLikeOpenAIKey = (k) =>
	typeof k === "string" && /^sk-/.test(k.trim());
const sanitizeModelName = (m) => {
	if (!m) return null;
	const noHash = String(m).split("#")[0];
	const token = noHash.trim().split(/\s+/)[0];
	return token || null;
};

/* ---------- Name helpers ---------- */
function firstNameOf(s = "") {
	const parts = String(s).trim().split(/\s+/).filter(Boolean);
	return parts[0] || "";
}
function isFullName(s = "") {
	const parts = String(s).trim().split(/\s+/).filter(Boolean);
	return parts.length >= 2 && parts[0].length >= 2 && parts[1].length >= 2;
}

/* ---------- Intent & signal detection ---------- */
const CONFIRM_PROMPT_MARKERS = [
	"should i proceed",
	"shall i book",
	"do you want me to book",
	"proceed with booking",
	"go ahead and book",
	"confirm the booking",
	"should i cancel",
	"do you want me to cancel",
	"confirm the cancellation",
	"proceed to cancel",
	"cancel the reservation",
	"shall i cancel",
	"confirm these dates",
	"should i apply these dates",
	"apply the changes",
	"do you want me to update",
];
const STRONG_BOOK_INTENT = [
	"book it",
	"you can book",
	"let's book",
	"we can proceed",
	"please book",
	"go ahead and book",
	"reserve it",
	"احجز",
	"تمام احجز",
	"خلاص احجز",
	"احجزي",
	"احجزه",
	"sí reserva",
	"resérvalo",
	"haz la reserva",
	"oui réserve",
	"réserve-le",
	"جی ہاں بک کریں",
	"بک کر دیں",
	"बुक कर दो",
	"आरक्षण कर दो",
];
const SHORT_AFFIRM = [
	"yes",
	"yeah",
	"yep",
	"sure",
	"okay",
	"ok",
	"oky",
	"affirmative",
	"تمام",
	"ايوه",
	"ايوا",
	"نعم",
	"أجل",
	"sí",
	"claro",
	"oui",
	"d'accord",
	"जी हाँ",
	"हाँ",
	"जी",
	"جی ہاں",
	"ہاں",
];
const CANCEL_STRONG_INTENT = [
	"cancel it",
	"cancel the booking",
	"cancel my reservation",
	"go ahead cancel",
	"الغِ الحجز",
	"الغاء الحجز",
	"ألغيه",
	"خلاص الغه",
	"cancélalo",
	"anula la reserva",
	"annule",
	"annuler ma réservation",
];
const CLOSE_INTENT = [
	"no",
	"no thanks",
	"nothing else",
	"that’s all",
	"that's all",
	"all good",
	"i'm good",
	"im good",
	"bye",
	"goodbye",
	"thanks bye",
	"thank you bye",
	"no more help",
	"لا شكراً",
	"شكراً خلاص",
	"مافيش حاجة تانية",
	"خلاص شكراً",
	"تمام شكراً",
	"no gracias",
	"nada más",
	"eso es todo",
	"listo gracias",
	"non merci",
	"rien d'autre",
	"c'est tout",
	"نہیں شکریہ",
	"بس",
	"ابھی نہیں",
	"اور کچھ نہیں",
	"नहीं धन्यवाद",
	"बस",
	"और कुछ नहीं",
];
const WAITING_SIGNALS = [
	"waiting",
	"i'm waiting",
	"im waiting",
	"hold on",
	"one sec",
	"one second",
	"give you time",
	"take your time",
	"no rush",
	"لحظة",
	"ثانية",
	"استنى",
	"مستني",
	"استناني",
	"ثواني",
	"براحتك",
	"خد وقتك",
	"خذي راحتك",
	"espera",
	"un segundo",
	"un momento",
	"tómate tu tiempo",
	"attendez",
	"une seconde",
	"prenez votre temps",
	"ذرا رکیے",
	"ذرا ٹھہریں",
	"ایک منٹ",
	"آرام سے",
	"जरा रुको",
	"एक सेकंड",
	"अपना समय लें",
];
/* Agent asked-to-wait detection (in last assistant msg) */
const WAIT_REQUEST_MARKERS = [
	"let me check",
	"give me a moment",
	"give me a minute",
	"one moment",
	"hold on",
	"i'll check",
	"i will check",
	"i'm checking",
	"i am checking",
	"allow me",
	"bear with me",
	"let me confirm",
	"let me verify",
	"checking now",
	"سأتحقق",
	"لحظة",
	"ثانية واحدة",
	"اتفضل",
	"استأذنك لحظة",
	"un momento",
	"déjame comprobar",
	"je vérifie",
	"un instant",
	"permíteme",
	"ذرا دیکھتا",
	"ذرا دیکھتی",
	"ذرا چیک کرتا",
	"چیک کررہا",
	"چیک کر رہی",
	"जरा देखता",
	"जरा देखती",
	"ज़रा जाँच करता",
	"जाँच कर रहा",
];
/* Guest's ack-of-wait to keep reply one-liner */
const WAIT_ACK_MARKERS = [
	"okay",
	"ok",
	"oky",
	"sure",
	"thank you",
	"thanks",
	"take your time",
	"no rush",
	"of course",
	"great",
	"fine",
	"alright",
	"تمام",
	"ماشي",
	"شكراً",
	"شكرًا",
	"براحتك",
	"اوكي",
	"gracias",
	"claro",
	"vale",
	"ok",
	"merci",
	"d'accord",
	"ok",
	"شکریہ",
	"ٹھیک ہے",
	"آرام سے",
	"धन्यवाद",
	"ठीक है",
	"अपना समय लें",
];

function includesAny(text = "", patterns = []) {
	const t = lower(text);
	return patterns.some((p) => t.includes(lower(p)));
}
function lastAssistantAskedForConfirmation(
	conversation = [],
	personaName = ""
) {
	for (let i = conversation.length - 1; i >= 0; i--) {
		const c = conversation[i];
		const name = lower(c?.messageBy?.customerName || "");
		const email = lower(c?.messageBy?.customerEmail || "");
		const isAssistant =
			email === "management@xhotelpro.com" ||
			name.includes("support") ||
			name.includes("agent") ||
			(personaName && name === lower(personaName));
		if (!c?.message || !isAssistant) continue;
		if (includesAny(c.message, CONFIRM_PROMPT_MARKERS)) return true;
		return false;
	}
	return false;
}
function lastAssistantAskedToCancel(conversation = [], personaName = "") {
	for (let i = conversation.length - 1; i >= 0; i--) {
		const c = conversation[i];
		const name = lower(c?.messageBy?.customerName || "");
		const email = lower(c?.messageBy?.customerEmail || "");
		const isAssistant =
			email === "management@xhotelpro.com" ||
			name.includes("support") ||
			name.includes("agent") ||
			(personaName && name === lower(personaName));
		if (!c?.message || !isAssistant) continue;
		if (
			includesAny(c.message, [
				"should i cancel",
				"do you want me to cancel",
				"confirm the cancellation",
				"shall i cancel",
			])
		) {
			return true;
		}
		return false;
	}
	return false;
}
function lastAssistantAskedToWait(conversation = [], personaName = "") {
	for (let i = conversation.length - 1; i >= 0; i--) {
		const c = conversation[i];
		const name = lower(c?.messageBy?.customerName || "");
		const email = lower(c?.messageBy?.customerEmail || "");
		const isAssistant =
			email === "management@xhotelpro.com" ||
			name.includes("support") ||
			name.includes("agent") ||
			(personaName && name === lower(personaName));
		if (!c?.message || !isAssistant) continue;
		if (includesAny(c.message, WAIT_REQUEST_MARKERS)) return true;
		return false;
	}
	return false;
}
function isAffirmative(text = "") {
	return (
		includesAny(text, SHORT_AFFIRM) || includesAny(text, STRONG_BOOK_INTENT)
	);
}
function isCloseIntent(text = "") {
	return includesAny(text, CLOSE_INTENT);
}
function isWaitingText(text = "") {
	return includesAny(text, WAITING_SIGNALS);
}
function isAckOfWait(text = "") {
	return includesAny(text, WAIT_ACK_MARKERS);
}

function stripRedundantOpeners(text = "", conversation = []) {
	const openerRegex =
		/^(hi|hello|hey|assalamu|assalam|السلام|مرحبا|hola|bonjour)[,!\s]*/i;
	if (conversation.length > 4) return text.replace(openerRegex, "");
	return text;
}

/* ---------- Room synonyms & pricing helpers ---------- */
const ROOM_SYNONYMS = [
	{
		canon: "singleRooms",
		keys: [
			"single",
			"single room",
			"1 bed",
			"فردي",
			"فردية",
			"سنجل",
			"غرفة فردية",
		],
	},
	{
		canon: "doubleRooms",
		keys: [
			"double",
			"double room",
			"2 beds",
			"twin",
			"مزدوج",
			"ثنائي",
			"ثنائية",
			"دبل",
			"دبل روم",
			"توين",
			"غرفة مزدوجة",
		],
	},
	{
		canon: "twinRooms",
		keys: ["twin", "two beds", "توين", "سريرين", "غرفة توين"],
	},
	{
		canon: "tripleRooms",
		keys: ["triple", "3 beds", "ثلاثي", "ثلاثية", "غرفة ثلاثية"],
	},
	{
		canon: "quadRooms",
		keys: ["quad", "4 beds", "رباعي", "رباعية", "غرفة رباعية"],
	},
	{
		canon: "familyRooms",
		keys: ["family", "عائلي", "عائلية", "غرفة عائلية", "family room"],
	},
	{ canon: "suiteRooms", keys: ["suite", "سويت", "جناح", "غرفة سويت"] },
	{ canon: "kingRooms", keys: ["king", "سرير كبير", "كينج"] },
	{ canon: "queenRooms", keys: ["queen", "كوين"] },
];
function canonicalFromText(text) {
	const t = lower(text);
	for (const row of ROOM_SYNONYMS)
		if (row.keys.some((k) => t.includes(lower(k)))) return row.canon;
	if (/rooms$/.test(String(text || ""))) return text;
	return null;
}
function buildRoomMatcher(hotel) {
	const all = hotel?.roomCountDetails || [];
	const byType = new Map(all.map((r) => [lower(r.roomType || ""), r]));
	return function matchRoom(req) {
		const wantType = lower(String(req.roomType || ""));
		const wantName = lower(String(req.displayName || ""));
		if (wantType && wantName) {
			const hit = all.find(
				(r) =>
					lower(r.roomType || "") === wantType &&
					lower(r.displayName || "") === wantName
			);
			if (hit) return hit;
		}
		if (wantType) {
			const exact = byType.get(wantType);
			if (exact) return exact;
		}
		const canon =
			canonicalFromText(req.roomType) ||
			canonicalFromText(req.displayName) ||
			canonicalFromText(req.hint);
		if (canon) {
			const byCanon = all.find((r) =>
				lower(r.roomType || "").includes(lower(canon))
			);
			if (byCanon) return byCanon;
		}
		const tokens = [
			"single",
			"double",
			"twin",
			"triple",
			"quad",
			"family",
			"suite",
			"king",
			"queen",
			"فردي",
			"فردية",
			"ثنائي",
			"ثنائية",
			"دبل",
			"مزدوج",
			"ثلاثي",
			"ثلاثية",
			"رباعي",
			"رباعية",
			"عائلي",
			"عائلية",
			"سويت",
			"جناح",
			"توين",
		];
		for (const r of all) {
			const hay = `${lower(r.roomType || "")} ${lower(r.displayName || "")}`;
			if (tokens.some((k) => wantType.includes(k) || wantName.includes(k))) {
				if (tokens.find((k) => hay.includes(k))) return r;
			}
		}
		return null;
	};
}
function num(x, d = 0) {
	const n = parseFloat(x);
	return Number.isFinite(n) ? n : d;
}
function nightlyArrayFrom(
	pricingRate,
	checkIn,
	checkOut,
	basePrice,
	defaultCost,
	commissionRate
) {
	const s = dayjs(checkIn).startOf("day");
	const e = dayjs(checkOut).subtract(1, "day").startOf("day");
	const arr = [];
	let cur = s;
	while (cur.isBefore(e) || cur.isSame(e, "day")) {
		const date = cur.format("YYYY-MM-DD");
		const row = (pricingRate || []).find((r) => r.calendarDate === date);
		const price = row ? num(row.price, basePrice) : num(basePrice, defaultCost);
		const rootPrice = row
			? num(row.rootPrice, defaultCost)
			: num(defaultCost, defaultCost);
		const comm = row
			? num(row.commissionRate, commissionRate)
			: num(commissionRate, 10);
		arr.push({ date, price, rootPrice, commissionRate: comm });
		cur = cur.add(1, "day");
	}
	return arr;
}
const anyBlocked = (nightly) => nightly.some((d) => num(d.price, 0) === 0);
function withCommission(nightly) {
	return nightly.map((d) => ({
		...d,
		totalPriceWithCommission:
			num(d.price) + num(d.rootPrice) * (num(d.commissionRate) / 100),
		totalPriceWithoutCommission: num(d.price),
	}));
}
function tryWindow(room, start, nights, commissionFallback) {
	const startStr = dayjs(start).format("YYYY-MM-DD");
	const endStr = dayjs(start).add(nights, "day").format("YYYY-MM-DD");
	const comm =
		num(room.roomCommission, commissionFallback) || commissionFallback || 10;
	const nightly0 = nightlyArrayFrom(
		room.pricingRate || [],
		startStr,
		endStr,
		num(room?.price?.basePrice, 0),
		num(room.defaultCost, 0),
		comm
	);
	const blocked = anyBlocked(nightly0);
	const nightly = withCommission(nightly0);
	const totalWith = Number(
		nightly.reduce((a, d) => a + num(d.totalPriceWithCommission), 0).toFixed(2)
	);
	const totalRoot = Number(
		nightly.reduce((a, d) => a + num(d.rootPrice), 0).toFixed(2)
	);
	const commissionAmt = Number((totalWith - totalRoot).toFixed(2));
	return {
		ok: !blocked,
		nightly,
		totals: {
			totalWithCommission: totalWith,
			totalRoot,
			commission: commissionAmt,
		},
	};
}
function nearestAvailableWindow(
	room,
	checkIn,
	nights,
	hotelCommission,
	spanDays = 14
) {
	const start = dayjs(checkIn).startOf("day");
	let forward = null,
		backward = null;
	for (let d = 1; d <= spanDays; d++) {
		const f = start.add(d, "day");
		const w = tryWindow(room, f, nights, hotelCommission);
		if (w.ok) {
			forward = {
				direction: "forward",
				offsetDays: d,
				check_in_date: f.format("YYYY-MM-DD"),
				check_out_date: f.add(nights, "day").format("YYYY-MM-DD"),
				nights,
				...w,
			};
			break;
		}
	}
	for (let d = 1; d <= spanDays; d++) {
		const b = start.subtract(d, "day");
		const w = tryWindow(room, b, nights, hotelCommission);
		if (w.ok) {
			backward = {
				direction: "backward",
				offsetDays: d,
				check_in_date: b.format("YYYY-MM-DD"),
				check_out_date: b.add(nights, "day").format("YYYY-MM-DD"),
				nights,
				...w,
			};
			break;
		}
	}
	if (forward && backward)
		return forward.offsetDays <= backward.offsetDays ? forward : backward;
	return forward || backward || null;
}

/* ---------- Hotel lookup + pricing tool ---------- */
async function lookupHotelAndPrice({
	hotelIdOrName,
	checkIn,
	checkOut,
	rooms = [],
}) {
	let hotel = null;
	if (hotelIdOrName && isValidObjectId(String(hotelIdOrName))) {
		hotel = await HotelDetails.findById(hotelIdOrName).lean();
	}
	if (!hotel && hotelIdOrName) {
		hotel = await HotelDetails.findOne({
			$or: [
				{ hotelName: new RegExp(`^${hotelIdOrName}$`, "i") },
				{ hotelName_OtherLanguage: new RegExp(`^${hotelIdOrName}$`, "i") },
			],
		}).lean();
	}
	if (!hotel) return { ok: false, error: "Hotel not found." };

	const nights = dayjs(checkOut).diff(dayjs(checkIn), "day");
	if (nights <= 0)
		return { ok: false, error: "Invalid dates (nights must be >= 1)." };

	const matchRoom = buildRoomMatcher(hotel);
	const fallbackCommission = num(hotel.commission, 10);
	const out = [];

	for (const req of rooms) {
		const r = matchRoom(req);
		if (!r) {
			out.push({
				ok: false,
				requested: req,
				error: "Requested room type not found for this hotel.",
				suggestedTypes: (hotel.roomCountDetails || []).map((x) => ({
					roomType: x.roomType,
					displayName: x.displayName,
				})),
			});
			continue;
		}
		const comm = num(r.roomCommission, fallbackCommission) || 10;
		const nightly0 = nightlyArrayFrom(
			r.pricingRate || [],
			checkIn,
			checkOut,
			num(r?.price?.basePrice, 0),
			num(r.defaultCost, 0),
			comm
		);
		const blocked = anyBlocked(nightly0);
		const nightly = withCommission(nightly0);
		const count = num(req.count, 1);

		const totalWith = Number(
			(
				nightly.reduce((a, d) => a + num(d.totalPriceWithCommission), 0) * count
			).toFixed(2)
		);
		const totalRoot = Number(
			(nightly.reduce((a, d) => a + num(d.rootPrice), 0) * count).toFixed(2)
		);
		const commissionAmt = Number((totalWith - totalRoot).toFixed(2));
		let alternative = null;
		if (blocked)
			alternative = nearestAvailableWindow(
				r,
				checkIn,
				nights,
				fallbackCommission,
				14
			);

		out.push({
			ok: !blocked,
			hotelId: hotel._id,
			roomType: r.roomType,
			displayName: r.displayName,
			count,
			nights,
			blocked,
			nightly,
			totals: {
				totalWithCommission: totalWith,
				totalRoot,
				commission: commissionAmt,
			},
			alternative,
		});
	}

	return {
		ok: out.some((x) => x.ok),
		hotel: {
			_id: hotel._id,
			hotelName: hotel.hotelName,
			aiToRespond: !!hotel.aiToRespond,
			commission: fallbackCommission,
			city: hotel.hotelCity,
			country: hotel.hotelCountry,
			belongsTo: hotel.belongsTo || null,
		},
		results: out,
	};
}

/* ---------- Reservation create ---------- */
function flattenPickedRoomsForOrderTaker(rooms = []) {
	const flat = [];
	for (const r of rooms) {
		const cnt = num(r.count, 1);
		const nightly = Array.isArray(r.pricingByDay) ? r.pricingByDay : [];
		const normalized = nightly.map((d) => ({
			date: d.date,
			price: num(d.totalPriceWithCommission, num(d.price)),
			rootPrice: num(d.rootPrice),
			commissionRate: num(d.commissionRate),
			totalPriceWithCommission: num(d.totalPriceWithCommission, num(d.price)),
			totalPriceWithoutCommission: num(d.totalPriceWithoutCommission, 0),
		}));
		const totalWith = normalized.reduce(
			(a, d) => a + num(d.totalPriceWithCommission),
			0
		);
		const totalRoot = normalized.reduce((a, d) => a + num(d.rootPrice), 0);
		const nights = normalized.length || 1;
		const avgNight = nights > 0 ? totalWith / nights : 0;
		for (let i = 0; i < cnt; i++) {
			flat.push({
				room_type: r.room_type || r.roomType,
				displayName: r.displayName,
				chosenPrice: Number(avgNight.toFixed(2)).toFixed(2),
				count: 1,
				pricingByDay: normalized,
				totalPriceWithCommission: Number(totalWith.toFixed(2)),
				hotelShouldGet: Number(totalRoot.toFixed(2)),
			});
		}
	}
	return flat;
}
function computeTotalsFromFlat(flat = []) {
	const oneNightCost = flat.reduce((a, room) => {
		const first =
			room.pricingByDay && room.pricingByDay[0]
				? num(room.pricingByDay[0].rootPrice)
				: 0;
		return a + first;
	}, 0);
	const totalAmount = flat.reduce(
		(a, room) => a + num(room.totalPriceWithCommission),
		0
	);
	const totalRoot = flat.reduce((a, room) => a + num(room.hotelShouldGet), 0);
	const commission = totalAmount - totalRoot;
	const finalDeposit = commission + oneNightCost;
	return {
		total_amount: Number(totalAmount.toFixed(2)),
		total_commission: Number(commission.toFixed(2)),
		one_night_cost: Number(oneNightCost.toFixed(2)),
		final_deposit: Number(finalDeposit.toFixed(2)),
	};
}
async function createReservationAndSendLink({
	personaName,
	hotel,
	caseId,
	guest,
	stay,
	pickedRooms,
}) {
	if (!CLIENT_URL_XHOTEL)
		return { ok: false, error: "SELF_API_BASE not configured." };
	if (!hotel?._id) return { ok: false, error: "HotelId missing." };
	if (!isFullName(guest?.name || "")) {
		return {
			ok: false,
			need_full_name: true,
			error: "Full name (first + last) required to create a reservation.",
		};
	}

	const flat = flattenPickedRoomsForOrderTaker(pickedRooms);
	const totals = computeTotalsFromFlat(flat);

	const payload = {
		userId: null,
		hotelId: hotel._id,
		belongsTo: hotel.belongsTo?._id || hotel.belongsTo || "",
		hotel_name: hotel.hotelName || "",
		customerDetails: {
			name: guest.name,
			email: guest.email,
			phone: guest.phone,
			nationality: guest.nationality || "",
			passport: "Not Provided",
			passportExpiry: "2027-01-01",
			postalCode: "00000",
			reservedBy: `${personaName} (aiagent)`,
		},
		total_rooms: flat.length,
		total_guests: num(guest.adults, 1) + num(guest.children, 0),
		adults: num(guest.adults, 1),
		children: num(guest.children, 0),
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

	const url = `${CLIENT_URL_XHOTEL}/new-reservation-client-employee`;
	const resp = await axios
		.post(url, payload, { timeout: 25000 })
		.then((r) => r.data);

	const confirmation =
		resp?.confirmation ||
		resp?.confirmationNumber ||
		resp?.data?.confirmation ||
		resp?.data?.confirmationNumber ||
		resp?.data?.reservation?.confirmation ||
		resp?.reservation?.confirmation ||
		resp?.data?.data?.confirmation ||
		"";

	const publicLink =
		confirmation && PUBLIC_CLIENT_URL
			? `${PUBLIC_CLIENT_URL}/single-reservation/${confirmation}`
			: null;

	const paymentLink =
		resp?.paymentLink ||
		resp?.reservationLink ||
		resp?.data?.paymentLink ||
		resp?.data?.reservationLink ||
		null;

	let emailOk = false,
		emailErr = null;
	if (paymentLink && guest.email) {
		try {
			await axios.post(
				`${CLIENT_URL_XHOTEL}/send-payment-link-email`,
				{ paymentLink, customerEmail: guest.email },
				{ timeout: 15000 }
			);
			emailOk = true;
		} catch (e) {
			emailErr = e?.response?.data?.error || e.message;
		}
	}

	return {
		ok: true,
		reservation: resp,
		confirmation,
		publicLink,
		paymentLink,
		paymentLinkEmailSent: emailOk,
		paymentLinkEmailError: emailErr,
	};
}

/* ---------- NEW: Reservation edit/cancel helpers ---------- */
async function findReservationByConfirmation(confirmation) {
	const conf = String(confirmation || "").trim();
	if (!conf) return { ok: false, error: "Confirmation number is required." };

	const doc = await Reservation.findOne({
		$or: [{ confirmation: conf }, { confirmation_number: conf }],
	})
		.populate("hotelId")
		.lean();

	if (!doc)
		return { ok: false, not_found: true, error: "Reservation not found." };

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
			payment: doc.payment,
			total_amount: doc.total_amount,
			pickedRoomsType: doc.pickedRoomsType || [],
		},
	};
}

async function updateReservationViaApi(reservationId, updates) {
	const url = `${CLIENT_URL_XHOTEL}/reservation-update/${reservationId}`;
	const resp = await axios
		.put(url, { ...updates, sentFrom: "aiagent" }, { timeout: 25000 })
		.then((r) => r.data)
		.catch((e) => {
			const err = e?.response?.data || { message: e.message };
			return { error: err?.message || "Update failed." };
		});
	if (resp?.error) return { ok: false, error: resp.error };
	return { ok: true, data: resp };
}

async function updateReservationFields({
	reservation_id,
	check_in_date,
	check_out_date,
	status,
	note,
	...rest
}) {
	const id = String(reservation_id || "").trim();
	if (!id) return { ok: false, error: "reservation_id is required." };

	// Build updates; allow safe pass-through (pickedRoomsType, totals, etc.) when provided.
	const updates = { ...rest };
	if (check_in_date) updates.checkin_date = check_in_date;
	if (check_out_date) updates.checkout_date = check_out_date;
	if (status) {
		const s = String(status).toLowerCase();
		if (["cancelled", "canceled"].includes(s)) {
			updates.status = "cancelled";
			updates.reservation_status = "cancelled";
			updates.cancelled_by = "aiagent";
			updates.cancelled_at = new Date().toISOString();
		} else {
			updates.status = s;
			updates.reservation_status = s;
		}
	}
	if (note) updates.comment = note;

	if (updates.checkin_date && updates.checkout_date) {
		const inD = dayjs(updates.checkin_date);
		const outD = dayjs(updates.checkout_date);
		const nights = outD.diff(inD, "day");
		if (!inD.isValid() || !outD.isValid() || nights <= 0) {
			return {
				ok: false,
				error: "Invalid dates (checkout must be after check-in).",
			};
		}
		updates.days_of_residence = nights;
	}

	const out = await updateReservationViaApi(id, updates);
	return out.ok ? { ok: true, updated: updates, api: out.data } : out;
}

/* ---------- Tools ---------- */
const TOOLS = [
	{
		type: "function",
		function: {
			name: "lookup_hotel_pricing",
			description:
				"Check availability & compute nightly pricing. Handles synonyms and nearest alternative windows.",
			parameters: {
				type: "object",
				properties: {
					hotelIdOrName: {
						type: "string",
						description:
							"Hotel ObjectId or exact name; defaults to current case hotel.",
					},
					check_in_date: { type: "string", description: "YYYY-MM-DD" },
					check_out_date: { type: "string", description: "YYYY-MM-DD" },
					rooms: {
						type: "array",
						items: {
							type: "object",
							properties: {
								roomType: { type: "string" },
								displayName: { type: "string" },
								count: { type: "integer", minimum: 1, default: 1 },
								hint: { type: "string" },
							},
							required: ["roomType"],
						},
					},
				},
				required: ["check_in_date", "check_out_date", "rooms"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "create_reservation_and_send_payment_link",
			description:
				"Create a reservation and email a secure payment link. Returns confirmation + public link.",
			parameters: {
				type: "object",
				properties: {
					hotelId: { type: "string" },
					caseId: { type: "string" },
					guest: {
						type: "object",
						properties: {
							name: { type: "string" },
							email: { type: "string" },
							phone: { type: "string" },
							nationality: { type: "string" },
							adults: { type: "integer" },
							children: { type: "integer" },
						},
						required: ["name", "email", "phone", "adults", "children"],
					},
					stay: {
						type: "object",
						properties: {
							check_in_date: { type: "string" },
							check_out_date: { type: "string" },
						},
						required: ["check_in_date", "check_out_date"],
					},
					pickedRooms: {
						type: "array",
						items: {
							type: "object",
							properties: {
								room_type: { type: "string" },
								displayName: { type: "string" },
								count: { type: "integer" },
								pricingByDay: {
									type: "array",
									items: {
										type: "object",
										properties: {
											date: { type: "string" },
											price: { type: "number" },
											rootPrice: { type: "number" },
											commissionRate: { type: "number" },
											totalPriceWithCommission: { type: "number" },
											totalPriceWithoutCommission: { type: "number" },
										},
									},
								},
							},
							required: ["room_type", "displayName", "count", "pricingByDay"],
						},
					},
				},
				required: ["guest", "stay", "pickedRooms"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "find_reservation_by_confirmation",
			description:
				"Find a reservation by confirmation number; returns key fields including _id for edits/cancel.",
			parameters: {
				type: "object",
				properties: { confirmation_number: { type: "string" } },
				required: ["confirmation_number"],
			},
		},
	},
	{
		type: "function",
		function: {
			name: "update_reservation_fields",
			description:
				"Update reservation fields by _id (date change, cancel, or safe pass-through like pickedRoomsType/totals when provided).",
			parameters: {
				type: "object",
				properties: {
					reservation_id: { type: "string" },
					check_in_date: { type: "string" },
					check_out_date: { type: "string" },
					status: { type: "string" },
					note: { type: "string" },
				},
				required: ["reservation_id"],
			},
		},
	},
];

/* ---------- Typing UX state ---------- */
const typingTimers = new Map(); // caseId -> { t1, intv, name }
const userTyping = new Map(); // caseId -> { isTyping, lastTypingAt, lastStopAt }
function startTyping(io, caseId, name) {
	const t1 = setTimeout(
		() => io.to(caseId).emit("typing", { caseId, name, isAi: true }),
		TYPING_START_AFTER
	);
	const intv = setInterval(
		() => io.to(caseId).emit("typing", { caseId, name, isAi: true }),
		TYPING_HEARTBEAT_MS
	);
	typingTimers.set(caseId, { t1, intv, name });
}
function stopTyping(io, caseId, name) {
	const t = typingTimers.get(caseId);
	if (t) {
		clearTimeout(t.t1);
		clearInterval(t.intv);
		typingTimers.delete(caseId);
	}
	io.to(caseId).emit("stopTyping", { caseId, name, isAi: true });
}
function setGuestTyping(caseId, isTyping) {
	const prev = userTyping.get(caseId) || {
		isTyping: false,
		lastTypingAt: 0,
		lastStopAt: 0,
	};
	const now = Date.now();
	if (isTyping)
		userTyping.set(caseId, {
			isTyping: true,
			lastTypingAt: now,
			lastStopAt: prev.lastStopAt,
		});
	else
		userTyping.set(caseId, {
			isTyping: false,
			lastTypingAt: prev.lastTypingAt,
			lastStopAt: now,
		});
}
function shouldWaitForGuest(caseId) {
	const st = userTyping.get(caseId);
	if (!st) return false;
	if (st.isTyping) return true;
	return Date.now() - (st.lastStopAt || 0) < WAIT_WHILE_TYPING_MS;
}

/* ---------- Greeting ---------- */
const greetedCases = new Set();
const greeted = (id) => greetedCases.has(String(id));
const markGreeted = (id) => greetedCases.add(String(id));

function greetingFor(lang, hotelName, personaName, guestFirst, inquiryContext) {
	const H = hotelName || "the hotel";
	const G = guestFirst ? ` ${guestFirst}` : "";
	if (inquiryContext?.confirmation) {
		const c = inquiryContext.confirmation;
		if (lang === "ar")
			return `السلام عليكم${G}، أنا ${personaName} من ${H}. فهمت أنك تسأل بخصوص الحجز ${c}. يسعدني المساعدة في التعديل أو الإلغاء أو إضافة غرفة.`;
		if (lang === "es")
			return `¡Assalamu alaikum${G}! Soy ${personaName} de ${H}. Veo que preguntas por la reserva ${c}. Puedo ayudarte a editar, cancelar o añadir una habitación.`;
		if (lang === "fr")
			return `Assalamu alaykoum${G} ! Je suis ${personaName} de ${H}. Je vois que c’est au sujet de la réservation ${c}. Je peux vous aider à modifier, annuler ou ajouter une chambre.`;
		return `Assalamu alaikum${G}! I’m ${personaName} from ${H}. I see this is about reservation ${c}. I can help edit, cancel, or add a room.`;
	}
	if (lang === "ar")
		return `السلام عليكم${G}، أنا ${personaName} من ${H}. يسعدني خدمتك—ما هي تواريخ الإقامة ونوع الغرفة المطلوبة؟`;
	if (lang === "es")
		return `¡Assalamu alaikum${G}! Soy ${personaName} de ${H}. ¿Cuáles son tus fechas y el tipo de habitación que prefieres?`;
	if (lang === "fr")
		return `Assalamu alaykoum${G} ! Je suis ${personaName} de ${H}. Quelles sont vos dates et le type de chambre souhaité ?`;
	return `Assalamu alaikum${G}! I’m ${personaName} from ${H}. How can I help—what are your dates and preferred room type?`;
}

function extractConfirmationFrom(text = "") {
	const s = String(text || "");
	// Prefer long digit sequences (8-14), fallback to alnum (6+)
	const m1 = s.match(/\b\d{8,14}\b/);
	if (m1) return m1[0];
	const m2 = s.match(/\b[A-Z0-9]{6,}\b/i);
	if (m2) return m2[0];
	return null;
}

async function scheduleGreetingByCaseId(io, caseId) {
	try {
		if (greeted(caseId)) return;
		const caseDoc = await SupportCase.findById(caseId)
			.populate("hotelId")
			.lean();
		if (!caseDoc || !caseDoc.hotelId || caseDoc.hotelId.aiToRespond === false)
			return;

		const lang = normalizeLang(caseDoc.preferredLanguageCode || "en");
		const persona = await ensurePersona(caseId, lang);

		const guestName =
			caseDoc.customerName ||
			caseDoc.displayName1 ||
			caseDoc?.conversation?.[0]?.messageBy?.customerName ||
			"";
		const guestFirst = firstNameOf(guestName);

		// Inquiry context (confirmation if present)
		const confirmation = extractConfirmationFrom(caseDoc.inquiryDetails || "");
		const inquiryContext = { confirmation };

		markGreeted(caseId);

		setTimeout(async () => {
			try {
				const fresh = await SupportCase.findById(caseId).lean();
				const hadAgent = (fresh?.conversation || []).some((m) =>
					isAssistantLike(
						m?.messageBy?.customerName,
						m?.messageBy?.customerEmail,
						persona.name
					)
				);
				if (hadAgent) return;

				startTyping(io, caseId, persona.name);
				const text = greetingFor(
					lang,
					caseDoc.hotelId.hotelName,
					persona.name,
					guestFirst,
					inquiryContext
				);
				await new Promise((r) => setTimeout(r, computeTypeDelay(text)));
				await persistAndBroadcast(io, { caseId, text, persona, lang });
			} catch (e) {
				console.error("[AI] auto-greet send error:", e?.message || e);
			}
		}, AUTO_GREET_DELAY_MS);
	} catch (e) {
		console.error("[AI] auto-greet schedule error:", e?.message || e);
	}
}

/* ---------- Persona & history ---------- */
const personaByCase = new Map(); // caseId -> { name, lang }
const replyLock = new Set();
const debounceMap = new Map();

async function ensurePersona(caseId, langCode) {
	const cached = personaByCase.get(caseId);
	if (cached) return cached;
	const lang = normalizeLang(langCode || "en");
	const name = pickPersona(lang);
	const persona = { name, lang };
	personaByCase.set(caseId, persona);
	try {
		await SupportCase.findByIdAndUpdate(
			caseId,
			{ supporterName: name },
			{ new: false }
		);
	} catch (_) {}
	return persona;
}
function isAssistantLike(byName, byEmail, personaName) {
	const name = lower(byName),
		email = lower(byEmail);
	return (
		email === "management@xhotelpro.com" ||
		name.includes("admin") ||
		name.includes("support") ||
		name.includes("agent") ||
		(personaName && name === lower(personaName))
	);
}
function toOpenAIHistory(conversation, personaName) {
	const items = (conversation || []).slice(-18);
	const mapped = [];
	for (const c of items) {
		const text = String(c.message || "").trim();
		if (!text) continue;
		const assistantLike = isAssistantLike(
			c?.messageBy?.customerName,
			c?.messageBy?.customerEmail,
			personaName
		);
		mapped.push({ role: assistantLike ? "assistant" : "user", content: text });
	}
	return mapped;
}

/* ---------- Pre-context (inquiry) ---------- */
function buildInquirySystemHint(caseDoc) {
	const details = String(caseDoc?.inquiryDetails || "");
	const about = String(caseDoc?.inquiryAbout || "");
	const confirmation = extractConfirmationFrom(details);
	let hint = "";
	if (confirmation) {
		hint += `\n- Inquiry references confirmation: ${confirmation}. If editing/cancelling, look this up first and avoid re-asking base info.`;
	}
	if (about) {
		hint += `\n- Case inquiryAbout: ${about}. Use this context in your first turn.`;
	}
	return hint;
}

/* ---------- Tool exec ---------- */
async function execTool(name, args, ctx) {
	if (name === "lookup_hotel_pricing") {
		const hotelIdOrName =
			args.hotelIdOrName ||
			ctx?.hotel?._id?.toString?.() ||
			ctx?.hotel?.hotelName ||
			"";
		const out = await lookupHotelAndPrice({
			hotelIdOrName,
			checkIn: args.check_in_date,
			checkOut: args.check_out_date,
			rooms: args.rooms || [],
		});
		return JSON.stringify(out);
	}
	if (name === "create_reservation_and_send_payment_link") {
		if (!ctx?.confirmedProceed) {
			return JSON.stringify({
				ok: false,
				need_confirmation: true,
				error: "Explicit confirmation to proceed is required.",
			});
		}
		let hotel = ctx?.hotel || null;
		if (!hotel && args.hotelId && isValidObjectId(String(args.hotelId))) {
			hotel = await HotelDetails.findById(args.hotelId).lean();
		}
		const personaName = ctx?.persona?.name || "AI Agent";
		const result = await createReservationAndSendLink({
			personaName,
			hotel,
			caseId: ctx?.caseId,
			guest: args.guest,
			stay: args.stay,
			pickedRooms: args.pickedRooms,
		});
		ctx.__didReservation = !!result?.ok;
		ctx.__reservationResult = result;
		return JSON.stringify(result);
	}
	if (name === "find_reservation_by_confirmation") {
		const result = await findReservationByConfirmation(
			args?.confirmation_number
		);
		return JSON.stringify(result);
	}
	if (name === "update_reservation_fields") {
		const wantCancel =
			String(args?.status || "").toLowerCase() === "cancelled" ||
			String(args?.status || "").toLowerCase() === "canceled";
		if (wantCancel && !ctx?.confirmedCancel) {
			return JSON.stringify({
				ok: false,
				need_cancel_confirmation: true,
				error: "Please confirm cancellation first.",
			});
		}
		const result = await updateReservationFields({
			reservation_id: args?.reservation_id,
			check_in_date: args?.check_in_date,
			check_out_date: args?.check_out_date,
			status: args?.status,
			note: args?.note,
			...args, // safe pass-through for pickedRoomsType / totals when model includes them
		});
		ctx.__didUpdate = !!result?.ok;
		ctx.__updateResult = result;
		return JSON.stringify(result);
	}
	return JSON.stringify({ ok: false, error: "Unknown tool" });
}

async function runWithTools(client, { messages, context, model }) {
	let didReservation = false;
	let reservationPayload = null;
	let didUpdate = false;
	let updatePayload = null;

	// Pass 1 (allow tools)
	let r = await client.chat.completions.create({
		model,
		messages,
		tools: TOOLS,
		tool_choice: "auto",
		temperature: 0.6,
		max_tokens: 500,
	});
	let msg = r.choices?.[0]?.message;
	const toolCalls = msg?.tool_calls || [];
	if (!toolCalls.length) {
		return {
			text: (msg?.content || "").trim(),
			meta: { didReservation: false, didUpdate: false },
		};
	}

	const toolMsgs = [];
	for (const tc of toolCalls) {
		const name = tc.function?.name;
		let args = {};
		try {
			args = JSON.parse(tc.function?.arguments || "{}");
		} catch {}
		if (name === "lookup_hotel_pricing" && !args.hotelIdOrName) {
			args.hotelIdOrName =
				context?.hotel?._id?.toString?.() || context?.hotel?.hotelName;
		}
		const resultStr = await execTool(name, args, context);
		try {
			const parsed = JSON.parse(resultStr);
			if (name === "create_reservation_and_send_payment_link") {
				didReservation = !!parsed?.ok;
				reservationPayload = parsed;
			}
			if (name === "update_reservation_fields") {
				didUpdate = !!parsed?.ok;
				updatePayload = parsed;
			}
		} catch (_) {}
		toolMsgs.push({
			role: "tool",
			tool_call_id: tc.id,
			name,
			content: resultStr,
		});
	}

	// Pass 2 (finalize)
	r = await client.chat.completions.create({
		model,
		messages: [...messages, msg, ...toolMsgs],
		tools: TOOLS,
		tool_choice: "none",
		temperature: 0.6,
		max_tokens: 650,
	});
	msg = r.choices?.[0]?.message;
	return {
		text: (msg?.content || "").trim(),
		meta: {
			didReservation,
			reservation: reservationPayload,
			didUpdate,
			update: updatePayload,
		},
	};
}

/* ---------- Learning & reply ---------- */
function buildLearningSections(training, userTurn, lang) {
	const learn = training?.bullets
		? `\nLearning Signals:\n- Decisions: ${training.bullets.decisions.join(
				" | "
		  )}\n- Recommendations: ${training.bullets.recommendations.join(" | ")}`
		: "";
	let dialectHint = "";
	if (lang === "ar" || /[\u0600-\u06FF]/.test(userTurn || "")) {
		const t = String(userTurn || "").toLowerCase();
		const d = /[اأإآ]زيك|عامل ايه|فينك|دلوقتي|تمام|مافيش|\bبلاش\b|\bقوي\b/.test(
			t
		)
			? "Egyptian"
			: /وش|تبي|مره|عساك|السالفة/.test(t)
			? "Saudi/Gulf"
			: /شو|قديش|لو سمحت/.test(t)
			? "Levant"
			: "MSA";
		dialectHint = `\nWhen replying in Arabic, mirror the user's dialect (${d}).`;
	}
	const behavior = `
- If your last message asked for booking/edit/cancel confirmation and the guest replies briefly (e.g., “yes/sure/ok/تمام/نعم/sí/oui/جی ہاں/हाँ”), treat it as confirmation and proceed. Do not ask again.
- If you asked the guest to wait and they reply “ok/thanks/take your time”, answer with **one short line only**, then continue working.
- Avoid repeating greetings or over‑thanking. Keep replies compact and human.
`;
	return learn + dialectHint + behavior;
}

async function generateReply(
	client,
	{
		caseDoc,
		persona,
		currentMessage,
		model,
		confirmedProceed,
		confirmedCancel,
		systemAppend,
	}
) {
	const lang = persona.lang || "en";

	const system = buildSystemPrompt({
		hotel: caseDoc.hotelId,
		activeLanguage: lang,
		preferredLanguage: currentMessage?.preferredLanguageCode || lang,
		personaName: persona.name,
		inquiryDetails: caseDoc.inquiryDetails,
	});

	const inquiryHint = buildInquirySystemHint(caseDoc);
	const training = await fetchGuidanceForAgent({
		hotelId: caseDoc.hotelId?._id || caseDoc.hotelId,
	});
	const history = toOpenAIHistory(caseDoc.conversation, persona.name);
	const userTurn = String(currentMessage?.message || "").trim();

	const messages = [
		{
			role: "system",
			content:
				system +
				buildLearningSections(training, userTurn, lang) +
				(inquiryHint ? `\n\nInquiry Context:${inquiryHint}` : "") +
				(systemAppend ? `\n\n${systemAppend}` : ""),
		},
		...history,
	];
	if (userTurn) messages.push({ role: "user", content: userTurn });

	const context = {
		hotel: caseDoc.hotelId,
		persona,
		caseId: caseDoc._id?.toString?.(),
		confirmedProceed: !!confirmedProceed,
		confirmedCancel: !!confirmedCancel,
	};
	return await runWithTools(client, { messages, context, model });
}

/* ---------- Short thanks generator ---------- */
function shortThanksLine(lang) {
	if (lang === "ar") return "شكرًا لك—سأعود إليك بتحديث قريبًا.";
	if (lang === "es") return "Gracias—vuelvo enseguida con una actualización.";
	if (lang === "fr") return "Merci—je reviens vite avec une mise à jour.";
	if (lang === "ur")
		return "شکریہ—میں جلد ہی تازہ معلومات کے ساتھ واپس آتا/آتی ہوں۔";
	if (lang === "hi") return "धन्यवाद—मैं जल्द ही अपडेट के साथ लौटता/लौटती हूँ।";
	return "Thank you—I’ll be right back with an update.";
}

/* ---------- Persistence & broadcast (+ follow-up scheduler) ---------- */
const waitFollowupTimers = new Map(); // caseId -> { t, scheduledAt, messageCount }
async function persistAndBroadcast(io, { caseId, text, persona, lang }) {
	if (!text) return;
	// If a wait follow-up is scheduled and we’re sending a non-wait message, cancel it to avoid duplicate ping.
	const hadTimer = waitFollowupTimers.get(caseId);
	if (hadTimer && !includesAny(text, WAIT_REQUEST_MARKERS)) {
		clearTimeout(hadTimer.t);
		waitFollowupTimers.delete(caseId);
	}

	const msg = {
		messageBy: {
			customerName: persona.name,
			customerEmail: "management@xhotelpro.com",
			userId: null,
		},
		message: text,
		date: new Date(),
		seenByAdmin: true,
		seenByHotel: true,
		seenByCustomer: false,
	};
	try {
		await SupportCase.findByIdAndUpdate(
			caseId,
			{ $push: { conversation: msg } },
			{ new: true }
		);
	} catch (e) {
		console.error("[AI] Failed to save AI message:", e?.message || e);
	}

	stopTyping(io, caseId, persona.name);
	io.to(caseId).emit("receiveMessage", {
		...msg,
		caseId,
		preferredLanguage: lang,
		preferredLanguageCode: lang,
	});

	// If the agent just asked the guest to wait, schedule a 10s follow-up.
	if (includesAny(text, WAIT_REQUEST_MARKERS)) {
		try {
			const fresh = await SupportCase.findById(caseId).lean();
			const messageCount = (fresh?.conversation || []).length;
			const t = setTimeout(
				() => autoFollowUpAfterWait(io, caseId),
				WAIT_FOLLOWUP_MS
			);
			waitFollowupTimers.set(caseId, {
				t,
				scheduledAt: Date.now(),
				messageCount,
			});
		} catch (_) {}
	}
}

async function autoFollowUpAfterWait(io, caseId) {
	try {
		waitFollowupTimers.delete(caseId);
		const caseDoc = await SupportCase.findById(caseId)
			.populate("hotelId")
			.lean();
		if (!caseDoc) return;
		const persona = await ensurePersona(
			caseId,
			normalizeLang(caseDoc.preferredLanguageCode || "en")
		);
		// If since scheduling we already posted a non-wait reply, do nothing.
		const last = (caseDoc.conversation || []).slice(-1)[0];
		if (
			last &&
			isAssistantLike(
				last?.messageBy?.customerName,
				last?.messageBy?.customerEmail,
				persona.name
			)
		) {
			if (!includesAny(last?.message || "", WAIT_REQUEST_MARKERS)) return;
		}

		startTyping(io, caseId, persona.name);
		const client = new OpenAI({ apiKey: RAW_KEY });
		const MODEL = sanitizeModelName(RAW_MODEL) || "gpt-4.1";
		const { text } = await generateReply(client, {
			caseDoc,
			persona,
			currentMessage: { message: "", preferredLanguageCode: persona.lang },
			model: MODEL,
			confirmedProceed: false,
			confirmedCancel: false,
			systemAppend:
				"Follow-up after wait: provide the checked results succinctly now. Avoid prefacing; be concise.",
		});
		const finalText = stripRedundantOpeners(text, caseDoc.conversation || []);
		await new Promise((r) => setTimeout(r, computeTypeDelay(finalText)));
		await persistAndBroadcast(io, {
			caseId,
			text: finalText,
			persona,
			lang: persona.lang,
		});
	} catch (e) {
		console.error("[AI] autoFollowUpAfterWait error:", e?.message || e);
	}
}

/* ---------- Close scheduling ---------- */
const closeTimers = new Map();
function scheduleClose(io, caseId, personaName, delay = AUTO_CLOSE_AFTER_MS) {
	const prev = closeTimers.get(caseId);
	if (prev) clearTimeout(prev.t);
	const t = setTimeout(async () => {
		try {
			await SupportCase.findByIdAndUpdate(
				caseId,
				{ caseStatus: "closed" },
				{ new: true }
			);
			io.to(caseId).emit("caseClosed", { caseId, closedBy: personaName });
		} catch (_) {}
		closeTimers.delete(caseId);
	}, delay);
	closeTimers.set(caseId, { t });
}
function cancelClose(caseId) {
	const prev = closeTimers.get(caseId);
	if (prev) {
		clearTimeout(prev.t);
		closeTimers.delete(caseId);
	}
}

async function persistAndCloseIfNoMore(io, caseDoc, persona, lang) {
	const hotelName = caseDoc.hotelId?.hotelName || "our hotel";
	let byeText = "";
	if (lang === "ar")
		byeText = `شكرًا لاختيارك ${hotelName}. يسعدنا خدمتك دومًا. في أمان الله!`;
	else if (lang === "es")
		byeText = `Gracias por elegir ${hotelName}. ¡Estamos a tu disposición!`;
	else if (lang === "fr")
		byeText = `Merci d’avoir choisi ${hotelName}. Nous restons à votre service.`;
	else if (lang === "ur")
		byeText = `آپ نے ${hotelName} کو منتخب کیا، شکریہ۔ ہم ہمیشہ خدمت کے لیے حاضر ہیں۔`;
	else if (lang === "hi")
		byeText = `धन्यवाद, आपने ${hotelName} चुना। हम हमेशा आपकी सेवा में हैं।`;
	else
		byeText = `Thank you for choosing ${hotelName}. We’re always here if you need anything.`;

	await persistAndBroadcast(io, {
		caseId: caseDoc._id?.toString?.(),
		text: byeText,
		persona,
		lang,
	});
	scheduleClose(
		io,
		caseDoc._id?.toString?.(),
		persona.name,
		AUTO_CLOSE_AFTER_MS
	);
}

/* ---------- Core flow ---------- */
async function processCase(io, client, MODEL, caseId) {
	const entry = debounceMap.get(caseId);
	if (!entry) return;
	const payload = entry.payload;
	debounceMap.delete(caseId);

	try {
		const existingPersona = personaByCase.get(caseId);
		if (isFromHumanStaffOrAgent(payload, existingPersona?.name)) return;

		if (shouldWaitForGuest(caseId)) {
			const waitMore = Math.max(WAIT_WHILE_TYPING_MS, 1200);
			const timer = setTimeout(
				() => processCase(io, client, MODEL, caseId),
				waitMore
			);
			debounceMap.set(caseId, { timer, payload });
			return;
		}

		if (replyLock.has(caseId)) {
			const timer = setTimeout(
				() => processCase(io, client, MODEL, caseId),
				400
			);
			debounceMap.set(caseId, { timer, payload });
			return;
		}
		replyLock.add(caseId);

		const caseDoc = await SupportCase.findById(caseId)
			.populate("hotelId")
			.lean();
		if (!caseDoc?.hotelId || caseDoc.hotelId.aiToRespond === false) {
			io.to(caseId).emit("aiPaused", { caseId });
			replyLock.delete(caseId);
			return;
		}

		const lang = normalizeLang(
			payload.preferredLanguageCode || existingPersona?.lang || "en"
		);
		const persona = await ensurePersona(caseId, lang);

		// Quick close path
		if (isCloseIntent(payload?.message || "")) {
			await persistAndCloseIfNoMore(io, caseDoc, persona, lang);
			replyLock.delete(caseId);
			return;
		}

		// If last assistant asked to wait and the guest is just acknowledging, send a one-line thanks and ensure 10s follow-up is scheduled.
		if (
			lastAssistantAskedToWait(caseDoc.conversation || [], persona.name) &&
			isAckOfWait(payload?.message || "")
		) {
			startTyping(io, caseId, persona.name);
			const ack = shortThanksLine(lang);
			await new Promise((r) => setTimeout(r, computeTypeDelay(ack)));
			await persistAndBroadcast(io, { caseId, text: ack, persona, lang });

			// If no follow-up is scheduled yet (e.g., assistant asked to wait earlier but timer lost), schedule it now.
			if (!waitFollowupTimers.get(caseId)) {
				const t = setTimeout(
					() => autoFollowUpAfterWait(io, caseId),
					WAIT_FOLLOWUP_MS
				);
				waitFollowupTimers.set(caseId, {
					t,
					scheduledAt: Date.now(),
					messageCount: (caseDoc.conversation || []).length + 1,
				});
			}
			replyLock.delete(caseId);
			return;
		}

		// Confirmation signals
		const asked = lastAssistantAskedForConfirmation(
			caseDoc.conversation || [],
			persona.name
		);
		const askedToCancel = lastAssistantAskedToCancel(
			caseDoc.conversation || [],
			persona.name
		);
		const confirmedProceed =
			(asked && isAffirmative(payload?.message || "")) ||
			includesAny(payload?.message || "", STRONG_BOOK_INTENT);
		const confirmedCancel =
			(askedToCancel && isAffirmative(payload?.message || "")) ||
			includesAny(payload?.message || "", CANCEL_STRONG_INTENT);

		// Typing on
		startTyping(io, caseId, persona.name);

		// Generate model reply (now with inquiry context baked in)
		const { text: rawText } = await generateReply(client, {
			caseDoc,
			persona,
			currentMessage: payload,
			model: MODEL,
			confirmedProceed,
			confirmedCancel,
		});

		// Human touch + brevity
		let text = rawText || "";
		if (isWaitingText(payload?.message || "")) {
			if (lang === "ar") text = `شكرًا لصبرك — ${text}`;
			else if (lang === "es") text = `Gracias por tu paciencia — ${text}`;
			else if (lang === "fr") text = `Merci pour votre patience — ${text}`;
			else if (lang === "ur") text = `آپ کے صبر کا شکریہ — ${text}`;
			else if (lang === "hi") text = `आपके धैर्य के लिए धन्यवाद — ${text}`;
			else text = `Thanks for your patience — ${text}`;
		}
		text = stripRedundantOpeners(text, caseDoc.conversation || []);

		await new Promise((r) => setTimeout(r, computeTypeDelay(text)));
		await persistAndBroadcast(io, { caseId, text, persona, lang });

		replyLock.delete(caseId);
	} catch (e) {
		console.error("[AI] processCase error:", e?.message || e);
		replyLock.delete(caseId);
	}
}

/* ---------- Socket & watchers ---------- */
function initAIAgent({ app, io }) {
	if (!looksLikeOpenAIKey(RAW_KEY)) {
		console.error(
			"[AI] OPENAI_API_KEY missing/invalid (must start with 'sk-')."
		);
		return;
	}
	const client = new OpenAI({ apiKey: RAW_KEY });
	const MODEL = sanitizeModelName(RAW_MODEL) || "gpt-4.1";

	console.log(
		`[AI] Agent initialized — model=${MODEL}, key=${maskKey(
			RAW_KEY
		)}, api_base=${CLIENT_URL_XHOTEL || "(unset)"}, public=${
			PUBLIC_CLIENT_URL || "(unset)"
		}`
	);

	try {
		if (typeof SupportCase.watch === "function") {
			const stream = SupportCase.watch(
				[{ $match: { operationType: "insert" } }],
				{ fullDocument: "updateLookup" }
			);
			stream.on("change", (ch) => {
				const id = ch?.fullDocument?._id;
				const openedBy = ch?.fullDocument?.openedBy;
				if (id && openedBy === "client") scheduleGreetingByCaseId(io, id);
			});
			stream.on("error", (err) =>
				console.error("[AI] change stream error:", err?.message || err)
			);
			console.log("[AI] Auto-greet watcher active.");
		} else {
			console.log(
				"[AI] Change streams unavailable; relying on socket fallbacks."
			);
		}
	} catch (e) {
		console.log(
			"[AI] Change streams init failed; relying on socket fallbacks.",
			e?.message || e
		);
	}

	io.on("connection", (socket) => {
		socket.on("joinRoom", ({ caseId }) => {
			if (caseId) scheduleGreetingByCaseId(io, caseId);
		});
		socket.on("newChat", (payload) => {
			if (payload?._id && payload?.openedBy === "client")
				scheduleGreetingByCaseId(io, payload._id);
		});

		socket.on("typing", (data = {}) => {
			if (!data?.caseId) return;
			if (data?.name) {
				setGuestTyping(String(data.caseId), true);
				cancelClose(String(data.caseId));
			}
		});
		socket.on("stopTyping", (data = {}) => {
			if (!data?.caseId) return;
			if (data?.name) setGuestTyping(String(data.caseId), false);
		});

		socket.on("sendMessage", (payload) => {
			const caseId = payload?.caseId;
			if (!caseId || !payload?.messageBy) return;

			const existingPersona = personaByCase.get(caseId);
			if (isFromHumanStaffOrAgent(payload, existingPersona?.name)) return;

			cancelClose(caseId);

			const prev = debounceMap.get(caseId);
			if (prev?.timer) clearTimeout(prev.timer);

			const delay = shouldWaitForGuest(caseId)
				? WAIT_WHILE_TYPING_MS
				: DEBOUNCE_MS;
			const timer = setTimeout(
				() => processCase(io, client, MODEL, caseId),
				delay
			);
			debounceMap.set(caseId, { timer, payload });
		});
	});

	console.log(
		"[AI] Ready: short wait-acks, 10s follow-up after 'please wait', inquiryDetails-aware replies, booking + edit/cancel via confirmation, WhatsApp phone ask, offers mention, typing-aware debounce, and 5s close after guest declines more help."
	);
}

/* ---------- Helpers ---------- */
function isFromHumanStaffOrAgent(payload, personaName) {
	const n = lower(payload?.messageBy?.customerName || "");
	const e = lower(payload?.messageBy?.customerEmail || "");
	if (!n && !e) return false;
	if (e === "management@xhotelpro.com") return true;
	if (personaName && n === lower(personaName)) return true;
	if (n.includes("admin") || n.includes("support") || n.includes("agent"))
		return true;
	return false;
}

module.exports = { initAIAgent };
