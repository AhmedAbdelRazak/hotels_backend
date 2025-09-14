/* ai-agent/index.js — v3.5
 * Key updates from v3.4:
 *  - Broader confirmation detection (assistant asks + user affirmatives) to avoid redundant re-asking.
 *  - New booking now proceeds immediately on "yes/proceed/go ahead/confirm/finalize" etc. (multi-language).
 *  - Booking readiness: infer adults from room type; children=0; rooms=1 — nationality remains required.
 *  - Endpoint call always fires post-affirmation; success reply includes confirmation number + link.
 *  - Keeps: 5–7s warm-up; greeting + case-aware second message; robust inquiry parsing; cancel/update flows; re-pricing.
 */

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
const SELF_API_BASE = process.env.SELF_API_BASE || "";
const PUBLIC_CLIENT_URL =
	process.env.CLIENT_URL ||
	process.env.CLIENT_PUBLIC_URL ||
	"https://jannatbooking.com";

/* ---------- Timings ---------- */
const GREETING_WARMUP_MIN_MS = 5000;
const GREETING_WARMUP_MAX_MS = 7000;

const WAIT_WHILE_TYPING_MS = 1500;
const DEBOUNCE_MS = 1100;
const TYPING_START_AFTER = 600;
const TYPING_HEARTBEAT_MS = 1200;
const MIN_TYPE_MS = 780,
	PER_CHAR_MS = 34,
	MAX_TYPE_MS = 9000;
const AUTO_CLOSE_AFTER_MS = 5000;
const WAIT_FOLLOWUP_MS = 9000;
const INACTIVITY_CLOSE_MS = 5 * 60 * 1000;

/* ---------- Utils ---------- */
const lower = (s) => String(s || "").toLowerCase();
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const isValidObjectId = (x) => mongoose.Types.ObjectId.isValid(String(x));
const computeTypeDelay = (t = "") =>
	clamp(MIN_TYPE_MS + String(t).length * PER_CHAR_MS, MIN_TYPE_MS, MAX_TYPE_MS);
const looksLikeOpenAIKey = (k) =>
	typeof k === "string" && /^sk-/.test(k.trim());
const sanitizeModelName = (m) =>
	m ? String(m).split("#")[0].trim().split(/\s+/)[0] : null;
const randInt = (min, max) => Math.floor(min + Math.random() * (max - min + 1));

const onlyDigits = (s = "") => String(s || "").replace(/\D+/g, "");
const isLikelyPhone = (s = "") => onlyDigits(s).length >= 7;
const redactPhone = (s = "") => {
	const d = onlyDigits(s);
	return d.length >= 3 ? `•••${d.slice(-3)}` : "•••";
};
const safeConfirmValue = (v) =>
	typeof v === "string" && /^[A-Z0-9\-]{6,}$/.test(v.trim());
const niceMoney = (n) =>
	Number.isFinite(+n) ? Number(n).toFixed(2) : String(n);

/* Affirmations & intents */
const SHORT_AFFIRM = [
	"yes",
	"yeah",
	"yep",
	"yup",
	"sure",
	"okay",
	"ok",
	"okey",
	"oki",
	"تمام",
	"نعم",
	"طيب",
	"أكيد",
	"sí",
	"claro",
	"de acuerdo",
	"vale",
	"oui",
	"d'accord",
	"okey",
	"okey doc", // french friends sometimes :)
	"जी",
	"हाँ",
	"ठीक है",
	"ہاں",
	"جی",
];
const STRONG_BOOK_INTENT = [
	"book it",
	"please book",
	"go ahead and book",
	"reserve it",
	"reserve now",
	"book now",
	"proceed",
	"proceed please",
	"yes proceed",
	"go ahead",
	"go ahead please",
	"confirm it",
	"confirm booking",
	"confirm my booking",
	"finalize",
	"finalise",
	"do it",
	"make it",
	"احجز",
	"خلاص احجز",
	"نعم احجز",
	"أكمل الحجز",
	"تابع",
	"نفّذ",
	"sí reserva",
	"resérvalo",
	"proceder",
	"confírmalo",
	"oui réserve",
	"procède",
	"confirme-le",
];
const STRONG_GOODBYE = [
	"bye",
	"goodbye",
	"bye bye",
	"see you",
	"مع السلامة",
	"adiós",
	"au revoir",
	"الوداع",
];

const WAIT_ACK_MARKERS = [
	"okay",
	"ok",
	"thanks",
	"thank you",
	"take your time",
	"براحتك",
	"gracias",
	"merci",
	"ठीक है",
	"شكرًا",
];
const WAIT_REQUEST_MARKERS = [
	"let me check",
	"give me a moment",
	"allow me",
	"checking now",
	"سأتحقق",
	"un momento",
	"je vérifie",
	"ذرا رُكیں",
	"एक क्षण",
];
const WAITING_SIGNALS = [
	"waiting",
	"hold on",
	"one sec",
	"لحظة",
	"espera",
	"un segundo",
	"une seconde",
	"ذرا",
	"एक सेकंड",
];

const CANCEL_WORDS = [
	"cancel",
	"cancellation",
	"إلغاء",
	"الغاء",
	"cancelar",
	"annuler",
	"取消",
	"annulla",
];
const CHANGE_WORDS = [
	"change",
	"edit",
	"update",
	"modify",
	"تغيير",
	"تعديل",
	"cambiar",
	"modifier",
	"aggiorna",
];
const DATE_WORDS = [
	"date",
	"dates",
	"checkin",
	"check-in",
	"checkout",
	"check-out",
	"تاريخ",
	"fechas",
	"dates",
];

/* ---------- Extractors ---------- */
function extractConfirmationFrom(text = "") {
	const s = String(text || "");
	const m1 = s.match(/\b\d{8,14}\b/);
	if (m1) return m1[0];
	const m2 = s.match(/\b[A-Z0-9\-]{6,}\b/i);
	return m2 ? m2[0] : null;
}
function extractPreferredLangCodeFromInquiryDetails(details = "") {
	const s = String(details || "");
	const m = s.match(
		/Preferred\s+Language:\s*([^\(\]\n]+)\s*\((en|ar|es|fr|ur|hi)\)/i
	);
	if (m) return normalizeLang(m[2] || m[1]);
	const m2 = s.match(/\((en|ar|es|fr|ur|hi)\)/i);
	if (m2) return normalizeLang(m2[1]);
	if (/arabic/i.test(s)) return "ar";
	if (/spanish|espa[ñn]ol/i.test(s)) return "es";
	if (/french|fran[cç]ais/i.test(s)) return "fr";
	if (/urdu/i.test(s)) return "ur";
	if (/hindi/i.test(s)) return "hi";
	return null;
}

/** Robust inquiry & confirmation extraction from case + conversation[0] + all items */
function extractInquiryDataFromCase(caseDoc = {}) {
	const convo = Array.isArray(caseDoc.conversation) ? caseDoc.conversation : [];
	const topAbout = String(caseDoc.inquiryAbout || "").trim();
	const firstAbout = String(convo[0]?.inquiryAbout || "").trim();
	const about = topAbout || firstAbout || "";

	const candidates = [];
	if (caseDoc.inquiryDetails) candidates.push(String(caseDoc.inquiryDetails));
	if (convo[0]?.inquiryDetails)
		candidates.push(String(convo[0].inquiryDetails));
	for (const m of convo)
		if (m?.inquiryDetails) candidates.push(String(m.inquiryDetails));
	let confirmation = null;
	for (const s of candidates) {
		const c = extractConfirmationFrom(s);
		if (c) {
			confirmation = c;
			break;
		}
	}
	return { about, confirmation };
}
function extractConfirmationFromCase(caseDoc = {}) {
	return extractInquiryDataFromCase(caseDoc).confirmation || null;
}

/* ---------- Misc helpers ---------- */
function firstNameOf(s = "") {
	const parts = String(s || "")
		.trim()
		.split(/\s+/)
		.filter(Boolean);
	return parts[0] || "";
}
function isFullName(s = "") {
	const parts = String(s || "")
		.trim()
		.split(/\s+/)
		.filter(Boolean);
	return parts.length >= 2 && parts[0].length >= 2 && parts[1].length >= 2;
}
const lowerIncludesAny = (t = "", arr = []) => {
	const s = lower(t);
	return arr.some((p) => s.includes(lower(p)));
};

/** Broader affirmative understanding for booking */
function isAffirmative(text = "") {
	const s = lower(text || "");
	if (!s) return false;
	if (SHORT_AFFIRM.some((w) => s === w || s.startsWith(w))) return true;
	if (lowerIncludesAny(s, STRONG_BOOK_INTENT)) return true;
	if (
		lowerIncludesAny(s, [
			"confirm",
			"confirm it",
			"confirm my booking",
			"finalize",
			"finalise",
			"go ahead",
			"proceed",
			"do it",
		])
	)
		return true;
	return false;
}

function formatDateRange(ci, co) {
	const i = dayjs(ci),
		o = dayjs(co);
	if (!i.isValid() || !o.isValid()) return `${ci} → ${co}`;
	const sameMonth = i.month() === o.month() && i.year() === o.year();
	const iStr = i.format("MMM D");
	const oStr = sameMonth ? o.format("D, YYYY") : o.format("MMM D, YYYY");
	return `${iStr}–${oStr}`;
}

/* ---------- Human/AI classifier ---------- */
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

/* ---------- Hotel permission ---------- */
const hotelAllowsAI = (hotelDoc) => !!hotelDoc && hotelDoc.aiToRespond === true;

/* ---------- Room/pricing helpers ---------- */
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
			"دبل",
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
		keys: ["family", "family room", "عائلي", "عائلية", "غرفة عائلية"],
	},
	{ canon: "suiteRooms", keys: ["suite", "سويت", "جناح", "سويت روم"] },
	{ canon: "kingRooms", keys: ["king", "سرير كبير", "كينج"] },
	{ canon: "queenRooms", keys: ["queen", "كوين"] },
];

function canonicalFromText(text) {
	const t = lower(text);
	for (const row of ROOM_SYNONYMS)
		if (row.keys.some((k) => t.includes(lower(k)))) return row.canon;
	return null;
}
function buildRoomMatcher(hotel) {
	const all = hotel?.roomCountDetails || [];
	const byType = new Map(all.map((r) => [lower(r.roomType || ""), r]));
	return function matchRoom(req) {
		const wantType = lower(
			String(req.roomType || req.room_type || req.hint || "")
		);
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
		// fuzzy
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
			"فرد",
			"ثنائي",
			"دبل",
			"مزدوج",
			"ثلاث",
			"رباع",
			"عائ",
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

const num = (x, d = 0) => {
	const n = parseFloat(x);
	return Number.isFinite(n) ? n : d;
};

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
const withCommission = (nightly) =>
	nightly.map((d) => ({
		...d,
		totalPriceWithCommission:
			num(d.price) + num(d.rootPrice) * (num(d.commissionRate) / 100),
		totalPriceWithoutCommission: num(d.price),
	}));

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
	span = 14
) {
	const start = dayjs(checkIn).startOf("day");
	let fwd = null,
		back = null;
	for (let d = 1; d <= span; d++) {
		const f = start.add(d, "day");
		const w = tryWindow(room, f, nights, hotelCommission);
		if (w.ok) {
			fwd = {
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
	for (let d = 1; d <= span; d++) {
		const b = start.subtract(d, "day");
		const w = tryWindow(room, b, nights, hotelCommission);
		if (w.ok) {
			back = {
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
	if (fwd && back) return fwd.offsetDays <= back.offsetDays ? fwd : back;
	return fwd || back || null;
}

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

async function findLatestReservationForGuest({
	hotelId,
	phone,
	check_in_date,
	check_out_date,
}) {
	const phoneRegex = new RegExp(onlyDigits(phone));
	const doc = await Reservation.findOne({
		hotelId: hotelId,
		$or: [
			{ "customerDetails.phone": { $regex: phoneRegex } },
			{ "customer_details.phone": { $regex: phoneRegex } },
		],
		checkin_date: check_in_date,
		checkout_date: check_out_date,
	})
		.sort({ createdAt: -1 })
		.lean();
	return doc || null;
}

/* ---------- Create reservation (endpoint + DB fallback) ---------- */
async function createReservationViaEndpointOrLocal({
	personaName,
	hotel,
	caseId,
	guest,
	stay,
	pickedRooms,
}) {
	const flat = flattenPickedRoomsForOrderTaker(pickedRooms);
	const totals = computeTotalsFromFlat(flat);

	let confirmation = "";
	let payloadResponse = null;

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

			const url = `${SELF_API_BASE}/new-reservation-client-employee`;
			const resp = await axios
				.post(url, payload, { timeout: 25000 })
				.then((r) => r.data);
			payloadResponse = resp;

			confirmation =
				resp?.confirmation ||
				resp?.confirmationNumber ||
				resp?.data?.confirmation ||
				resp?.data?.confirmationNumber ||
				resp?.data?.reservation?.confirmation ||
				resp?.reservation?.confirmation ||
				resp?.data?.data?.confirmation ||
				"";

			if (!confirmation) {
				const doc = await findLatestReservationForGuest({
					hotelId: hotel._id,
					phone: guest.phone,
					check_in_date: stay.check_in_date,
					check_out_date: stay.check_out_date,
				});
				confirmation = doc?.confirmation || doc?.confirmation_number || "";
			}

			return {
				ok: !!confirmation,
				confirmation,
				publicLink: confirmation
					? `${PUBLIC_CLIENT_URL}/single-reservation/${confirmation}`
					: null,
				paymentLink:
					resp?.paymentLink ||
					resp?.reservationLink ||
					resp?.data?.paymentLink ||
					resp?.data?.reservationLink ||
					null,
				payloadResponse: resp,
			};
		} catch (_) {
			// fall back to local create
		}
	}

	try {
		// local create with generated confirmation
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

		const doc = await Reservation.create({
			hotelId: hotel._id,
			hotel_name: hotel.hotelName || "",
			confirmation: conf,
			status: "confirmed",
			reservation_status: "confirmed",
			customer_details: {
				name: guest.name,
				email: guest.email || "",
				phone: guest.phone,
				nationality: guest.nationality || "",
			},
			adults: num(guest.adults, 1),
			children: num(guest.children, 0),
			total_guests: num(guest.adults, 1) + num(guest.children, 0),
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
			payloadResponse: doc,
		};
	} catch (e) {
		return { ok: false, error: e?.message || "Local create failed." };
	}
}

/* ---------- Reservation lookups & updates ---------- */
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
			total_amount: doc.total_amount,
			pickedRoomsType: doc.pickedRoomsType || [],
		},
	};
}

async function cancelReservationByIdOrConfirmation(idOrConf) {
	let _id = null;
	if (isValidObjectId(idOrConf)) {
		_id = String(idOrConf);
	} else {
		const found = await findReservationByConfirmation(idOrConf);
		if (!found?.ok)
			return { ok: false, error: found?.error || "Reservation not found." };
		_id = String(found.reservation._id);
	}
	const updates = {
		status: "cancelled",
		reservation_status: "cancelled",
		cancelled_by: "aiagent",
		cancelled_at: new Date(),
	};
	const doc = await Reservation.findByIdAndUpdate(_id, updates, {
		new: true,
	}).lean();
	if (!doc) return { ok: false, error: "Reservation not found." };
	return { ok: true, reservation: doc };
}

async function applyReservationUpdate({
	reservation_id,
	confirmation_number,
	changes,
}) {
	let _id = null;
	if (reservation_id && isValidObjectId(reservation_id)) {
		_id = String(reservation_id);
	} else if (
		confirmation_number ||
		(reservation_id && !isValidObjectId(reservation_id))
	) {
		const conf = confirmation_number || reservation_id;
		const found = await findReservationByConfirmation(conf);
		if (!found?.ok)
			return { ok: false, error: found?.error || "Reservation not found." };
		_id = String(found.reservation._id);
	} else {
		return {
			ok: false,
			error: "reservation_id or confirmation_number is required.",
		};
	}

	const payload = { ...changes };
	if (payload.check_in_date) payload.checkin_date = payload.check_in_date;
	if (payload.check_out_date) payload.checkout_date = payload.check_out_date;
	delete payload.check_in_date;
	delete payload.check_out_date;

	if (payload.checkin_date && payload.checkout_date) {
		const inD = dayjs(payload.checkin_date),
			outD = dayjs(payload.checkout_date);
		const nights = outD.diff(inD, "day");
		if (!inD.isValid() || !outD.isValid() || nights <= 0) {
			return {
				ok: false,
				error: "Invalid dates (checkout must be after check‑in).",
			};
		}
		payload.days_of_residence = nights;
	}

	const updated = await Reservation.findByIdAndUpdate(_id, payload, {
		new: true,
	}).lean();
	if (!updated) return { ok: false, error: "Reservation not found." };
	return { ok: true, reservation: updated };
}

/* ---------- Repricing for changes ---------- */
async function repriceReservation({
	reservation,
	hotel,
	newStay,
	newRoomTypeCanon,
}) {
	const matchRoom = buildRoomMatcher(hotel);
	const check_in_date = newStay?.check_in_date || reservation.checkin_date;
	const check_out_date = newStay?.check_out_date || reservation.checkout_date;
	const nights = dayjs(check_out_date).diff(dayjs(check_in_date), "day");
	if (nights <= 0) return { ok: false, error: "Invalid dates for repricing." };

	const fallbackCommission = num(hotel.commission, 10);
	const originalRooms = reservation.pickedRoomsType || [];
	if (!originalRooms.length)
		return { ok: false, error: "No room lines found to reprice." };

	const nextRooms = [];

	for (let idx = 0; idx < originalRooms.length; idx++) {
		const line = originalRooms[idx];
		const req = {
			roomType: newRoomTypeCanon || line.room_type || line.roomType,
			displayName: line.displayName || "",
			count: num(line.count, 1),
			hint: newRoomTypeCanon || line.room_type || "",
		};
		const matched = matchRoom(req);
		if (!matched) {
			return {
				ok: false,
				error: `Requested room type not available for repricing (line ${
					idx + 1
				}).`,
			};
		}

		const comm =
			num(matched.roomCommission, fallbackCommission) ||
			fallbackCommission ||
			10;
		const nightly0 = nightlyArrayFrom(
			matched.pricingRate || [],
			check_in_date,
			check_out_date,
			num(matched?.price?.basePrice, 0),
			num(matched.defaultCost, 0),
			comm
		);
		const blocked = anyBlocked(nightly0);
		if (blocked) {
			const alt = nearestAvailableWindow(
				matched,
				check_in_date,
				nights,
				fallbackCommission,
				14
			);
			return {
				ok: false,
				blocked: true,
				alternative: alt,
				message: "Selected dates are not available for this room type.",
			};
		}
		const nightly = withCommission(nightly0);
		const totalWith = Number(
			(
				nightly.reduce((a, d) => a + num(d.totalPriceWithCommission), 0) *
				req.count
			).toFixed(2)
		);
		const totalRoot = Number(
			(nightly.reduce((a, d) => a + num(d.rootPrice), 0) * req.count).toFixed(2)
		);

		nextRooms.push({
			room_type: matched.roomType,
			displayName: matched.displayName,
			count: req.count,
			pricingByDay: nightly,
			totalPriceWithCommission: totalWith,
			hotelShouldGet: totalRoot,
		});
	}

	const totals = computeTotalsFromFlat(nextRooms);
	return {
		ok: true,
		next: {
			checkin_date: check_in_date,
			checkout_date: check_out_date,
			days_of_residence: nights,
			pickedRoomsType: nextRooms,
			total_amount: totals.total_amount,
			commission: totals.total_commission,
		},
	};
}

/* ---------- Conversation parsers (dates/people/etc.) ---------- */
const MONTHS = [
	"january",
	"february",
	"march",
	"april",
	"may",
	"june",
	"july",
	"august",
	"september",
	"october",
	"november",
	"december",
];

function parseDateTokens(
	text = "",
	fallbackStartISO = null,
	fallbackEndISO = null
) {
	const t = lower(text).replace(/[,]/g, " ").replace(/\s+/g, " ").trim();
	const iso = t.match(
		/(\d{4}-\d{2}-\d{2})\s*(?:to|-|–|—)\s*(\d{4}-\d{2}-\d{2})/
	);
	if (iso) return { check_in_date: iso[1], check_out_date: iso[2] };

	const monthMatches = MONTHS.map((m, i) => ({ m, i: i + 1 })).filter(({ m }) =>
		t.includes(m)
	);
	if (monthMatches.length) {
		const m = monthMatches[0].i;
		const dayNums = (t.match(/\b(\d{1,2})(?:st|nd|rd|th)?\b/g) || []).map((x) =>
			parseInt(x.replace(/\D/g, ""), 10)
		);
		if (dayNums.length >= 1) {
			const yTokens = t.match(/\b(20\d{2})\b/g);
			const y =
				yTokens && yTokens[0]
					? parseInt(yTokens[0], 10)
					: new Date().getFullYear();
			const ci = dayjs(
				`${y}-${String(m).padStart(2, "0")}-${String(dayNums[0]).padStart(
					2,
					"0"
				)}`
			);
			const coDay = dayNums[1] || dayNums[0] + 1;
			let co = dayjs(
				`${y}-${String(m).padStart(2, "0")}-${String(coDay).padStart(2, "0")}`
			);
			if (!co.isAfter(ci, "day")) co = co.add(1, "day");
			return {
				check_in_date: ci.format("YYYY-MM-DD"),
				check_out_date: co.format("YYYY-MM-DD"),
			};
		}
	}

	const pureDays = t.match(
		/\b(\d{1,2})(?:st|nd|rd|th)?\b\s*(?:to|-|–|—)\s*(\d{1,2})(?:st|nd|rd|th)?\b/
	);
	if (pureDays && (fallbackStartISO || fallbackEndISO)) {
		const base = dayjs(fallbackStartISO || fallbackEndISO);
		const y = base.isValid() ? base.year() : new Date().getFullYear();
		const m = base.isValid() ? base.month() + 1 : new Date().getMonth() + 1;
		const d1 = parseInt(pureDays[1], 10);
		const d2 = parseInt(pureDays[2], 10);
		const ci = dayjs(
			`${y}-${String(m).padStart(2, "0")}-${String(d1).padStart(2, "0")}`
		);
		let co = dayjs(
			`${y}-${String(m).padStart(2, "0")}-${String(d2).padStart(2, "0")}`
		);
		if (!co.isAfter(ci, "day")) co = co.add(1, "day");
		return {
			check_in_date: ci.format("YYYY-MM-DD"),
			check_out_date: co.format("YYYY-MM-DD"),
		};
	}

	const singleIso = t.match(/\b(\d{4}-\d{2}-\d{2})\b/);
	if (singleIso) {
		const ci = dayjs(singleIso[1]);
		const nights = parseInt(
			(t.match(/\b(\d+)\s*nights?\b/) || [])[1] || "1",
			10
		);
		const co = ci.add(Math.max(1, nights), "day");
		return {
			check_in_date: ci.format("YYYY-MM-DD"),
			check_out_date: co.format("YYYY-MM-DD"),
		};
	}
	return null;
}

function parseAdultsChildren(text = "") {
	const t = String(text || "");
	const out = {};
	const mA =
		t.match(/adult[s]?\s*[:\-]?\s*(\d+)/i) || t.match(/(\d+)\s*adult[s]?/i);
	if (mA) out.adults = Number(mA[1]);
	const mC =
		t.match(/child(?:ren)?\s*[:\-]?\s*(\d+)/i) ||
		t.match(/(\d+)\s*child(?:ren)?/i) ||
		t.match(/(\d+)\s*kid[s]?/i);
	if (mC) out.children = Number(mC[1]);
	if (
		/\b(no|without|none|zero|0)\s+(children|child|kids)\b/i.test(t) ||
		/\b(children|kids)\s*[:\-]?\s*(none|no|zero|0)\b/i.test(t)
	) {
		out.children = 0;
	}
	return out;
}
function parseRoomsCount(text = "") {
	const t = String(text || "");
	const m =
		t.match(/(\d+)\s*room[s]?\b/i) ||
		t.match(/(\d+)\s*rm\b/i) ||
		t.match(/(\d+)\s*habitaci(?:o|ó)n(?:es)?\b/iu) ||
		t.match(/(\d+)\s*chambre[s]?\b/i);
	return m ? Number(m[1]) : null;
}
function parsePhone(text = "") {
	const t = String(text || "");
	const m =
		t.match(
			/(?:phone|number|call|whatsapp|contact)[:\s\-]*([+()\d\s\-]{7,})/i
		) || t.match(/\b(\+?\d[\d\s\-()]{6,})\b/);
	if (!m) return null;
	const digits = onlyDigits(m[1]);
	return digits.length >= 7 ? m[1].trim() : null;
}
function parseEmail(text = "") {
	const m = String(text || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
	return m ? m[0] : null;
}
function parseName(text = "") {
	const t = String(text || "");
	const m = t.match(
		/(my\s+name\s+is|name\s*[:\-])\s*([a-z][a-z.'\-\s]{2,60})/i
	);
	if (m) return m[2].trim().replace(/\s+/g, " ");
	return null;
}
function parseNationality(text = "") {
	const t = String(text || "").trim();
	const m = t.match(
		/nationality\s*(?:is|:)?\s*([A-Za-z\u0600-\u06FF\s]{2,40})/i
	);
	if (m) return m[1].trim();
	if (
		/^[A-Za-z\u0600-\u06FF]{3,40}$/.test(t) &&
		!/\s/.test(t) &&
		t.length <= 20
	)
		return t;
	return null;
}
function parseRoomPreference(text = "") {
	const t = lower(text);
	if (/(triple|ثلاث)/.test(t)) return "tripleRooms";
	if (/(twin|توين)/.test(t)) return "twinRooms";
	if (/(double|دبل|مزدوج)/.test(t)) return "doubleRooms";
	if (/(single|سنجل|فرد)/.test(t)) return "singleRooms";
	if (/(suite|سويت|جناح)/.test(t)) return "suiteRooms";
	if (/(family|عائلي)/.test(t)) return "familyRooms";
	if (/(king|كينج)/.test(t)) return "kingRooms";
	if (/(queen|كوين)/.test(t)) return "queenRooms";
	return null;
}

/* ---------- Language & identity ---------- */
function knownIdentityFromCase(caseDoc) {
	const convo = Array.isArray(caseDoc?.conversation)
		? caseDoc.conversation
		: [];
	const guestFirstMsg =
		convo.find(
			(m) =>
				!isAssistantLike(
					m?.messageBy?.customerName,
					m?.messageBy?.customerEmail
				)
		) || {};
	const by = guestFirstMsg.messageBy || {};
	let name =
		caseDoc.customerName ||
		caseDoc.displayName1 ||
		caseDoc.displayName2 ||
		by.customerName ||
		"";
	let email = "",
		phone = "";
	const formField = by.customerEmail || "";
	if (formField && isLikelyPhone(formField)) phone = formField;
	else if (formField) email = formField;
	if (!email && caseDoc.customerEmail && !isLikelyPhone(caseDoc.customerEmail))
		email = caseDoc.customerEmail;
	if (!phone && caseDoc.customerEmail && isLikelyPhone(caseDoc.customerEmail))
		phone = caseDoc.customerEmail;
	return { name, email, phone };
}

function buildLearningSections(training) {
	const learn = training?.bullets
		? `\nLearning Signals:\n- Decisions: ${training.bullets.decisions.join(
				" | "
		  )}\n- Recommendations: ${training.bullets.recommendations.join(" | ")}`
		: "";
	const behavior = `
- Use a 5–7s warm‑up to preload context before the first reply; then send two messages (greeting + case‑aware follow‑up).
- For reservation with confirmation in inquiryDetails: summarize reservation immediately; ask “How can I help with this reservation?”.
- For reserve_room: ask for dates + preferred room type immediately.
- Ask only for missing info; accept details one by one (do NOT force single-line).
- If you ask to confirm a cancel/booking/update and the guest says “yes/ok/تمام/sí/oui/proceed/go ahead/confirm” ⇒ proceed (**single confirmation**).
- Prefer “pay at hotel”. After create/update/cancel: confirm + link; then “Anything else I can help you with?”`;
	return learn + behavior;
}
function buildInquirySystemHint(caseDoc) {
	const { about, confirmation } = extractInquiryDataFromCase(caseDoc);
	let hint = "";
	if (confirmation)
		hint += `\n- Inquiry references confirmation: ${confirmation}. Look it up immediately and include a short summary (room • dates • total • status).`;
	if (about)
		hint += `\n- Case inquiryAbout: ${about}. Tailor the first turn to this.`;
	return hint;
}

/* ---------- State ---------- */
const typingTimers = new Map();
const userTyping = new Map();
const greetedCases = new Set();
const personaByCase = new Map();
const replyLock = new Set();
const debounceMap = new Map();
const waitFollowupTimers = new Map();
const idleTimers = new Map();
const closeTimers = new Map();

const caseState = new Map();
// { lang, personaName,
//   collected: { name,email,phone,nationality,adults,children,roomsCount,roomTypeHint },
//   intendedStay, lastPricing, booked, lastConfirmation, publicLink, paymentLink,
//   askedMissingAt, lastMissingKey, missingAskCount, intentProceed, pendingAction, reservationCache }

function getState(caseId) {
	const s = caseState.get(caseId) || {
		collected: {},
		booked: false,
		intentProceed: false,
		pendingAction: null,
		missingAskCount: 0,
	};
	caseState.set(caseId, s);
	return s;
}

/* ---------- Typing UX ---------- */
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
	userTyping.set(caseId, {
		isTyping: !!isTyping,
		lastTypingAt: isTyping ? now : prev.lastTypingAt,
		lastStopAt: isTyping ? prev.lastStopAt : now,
	});
}
function shouldWaitForGuest(caseId) {
	const st = userTyping.get(caseId);
	if (!st) return false;
	if (st.isTyping) return true;
	return Date.now() - (st.lastStopAt || 0) < WAIT_WHILE_TYPING_MS;
}
const greeted = (id) => greetedCases.has(String(id));
const markGreeted = (id) => greetedCases.add(String(id));

/* ---------- Persona ---------- */
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

/* ---------- Tools (unchanged surface) ---------- */
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
					hotelIdOrName: { type: "string" },
					check_in_date: { type: "string" },
					check_out_date: { type: "string" },
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
				"Create a reservation. Returns confirmation + public link + optional payment link.",
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
						required: ["name", "phone", "adults", "children"],
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
			description: "Find a reservation by confirmation number.",
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
				"Update reservation fields by _id or confirmation number (date change, cancel).",
			parameters: {
				type: "object",
				properties: {
					reservation_id: { type: "string" },
					confirmation_number: { type: "string" },
					check_in_date: { type: "string" },
					check_out_date: { type: "string" },
					status: { type: "string" },
					note: { type: "string" },
				},
			},
		},
	},
];

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
		const st = getState(ctx.caseId);
		st.lastPricing = out;
		st.intendedStay = {
			check_in_date: args.check_in_date,
			check_out_date: args.check_out_date,
		};
		st.intendedRooms = args.rooms || [];
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
		if (!hotel && args.hotelId && isValidObjectId(String(args.hotelId)))
			hotel = await HotelDetails.findById(args.hotelId).lean();
		const personaName = ctx?.persona?.name || "Agent";
		const result = await createReservationViaEndpointOrLocal({
			personaName,
			hotel,
			caseId: ctx?.caseId,
			guest: args.guest,
			stay: args.stay,
			pickedRooms: args.pickedRooms,
		});
		ctx.__didReservation = !!result?.ok;
		ctx.__reservationResult = result;
		const st = getState(ctx.caseId);
		if (result?.ok) {
			st.booked = true;
			st.lastConfirmation = result.confirmation || "";
			st.publicLink = result.publicLink || null;
			st.paymentLink = result.paymentLink || null;
		}
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
		const result = await applyReservationUpdate({
			reservation_id: args?.reservation_id,
			confirmation_number: args?.confirmation_number,
			changes: {
				check_in_date: args?.check_in_date,
				check_out_date: args?.check_out_date,
				status: args?.status,
				note: args?.note,
			},
		});
		ctx.__didUpdate = !!result?.ok;
		ctx.__updateResult = result;
		return JSON.stringify(result);
	}
	return JSON.stringify({ ok: false, error: "Unknown tool" });
}

async function runWithTools(client, { messages, context, model }) {
	let didReservation = false,
		reservationPayload = null,
		didUpdate = false,
		updatePayload = null;

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
	if (!toolCalls.length) return { text: (msg?.content || "").trim(), meta: {} };

	const toolMsgs = [];
	for (const tc of toolCalls) {
		const name = tc.function?.name;
		let args = {};
		try {
			args = JSON.parse(tc.function?.arguments || "{}");
		} catch {}
		if (name === "lookup_hotel_pricing" && !args.hotelIdOrName)
			args.hotelIdOrName =
				context?.hotel?._id?.toString?.() || context?.hotel?.hotelName;
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
		} catch {}
		toolMsgs.push({
			role: "tool",
			tool_call_id: tc.id,
			name,
			content: resultStr,
		});
	}
	r = await client.chat.completions.create({
		model,
		messages: [...messages, msg, ...toolMsgs],
		tools: TOOLS,
		tool_choice: "none",
		temperature: 0.6,
		max_tokens: 600,
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

/* ---------- Greeting & addressing lines ---------- */
function identityDeflectionLine(lang) {
	if (lang === "ar")
		return "أنا بخدمتك لحجز غرفتك وترتيب كل التفاصيل. دعنا نُنجز طلبك كما تريده 🙂";
	if (lang === "es")
		return "Estoy aquí para gestionar tu reserva y detalles. Vamos a dejarlo perfecto 🙂";
	if (lang === "fr")
		return "Je gère votre réservation et les détails. Finalisons cela comme vous voulez 🙂";
	if (lang === "ur")
		return "میں آپ کی بکنگ اور تفصیلات سنبھال رہا/رہی ہوں۔ آئیں آپ کی مرضی کے مطابق مکمل کریں 🙂";
	if (lang === "hi")
		return "मैं आपकी बुकिंग और विवरण सँभाल रहा/रही हूँ—चलें इसे आपकी पसंद के मुताबिक़ पूरा करें 🙂";
	return "I’m here to handle your booking details—let’s get this done exactly how you want 🙂";
}
function shortThanksLine(lang) {
	if (lang === "ar") return "شكرًا لك—سأعود إليك بتحديث قريبًا.";
	if (lang === "es") return "Gracias—vuelvo enseguida con una actualización.";
	if (lang === "fr") return "Merci—je reviens vite avec une mise à jour.";
	if (lang === "ur")
		return "شکریہ—میں جلد ہی تازہ معلومات کے ساتھ واپس آتا/آتی ہوں۔";
	if (lang === "hi") return "धन्यवाद—मैं जल्द ही अपडेट के साथ लौटता/लौटती हूँ।";
	return "Thank you—I’ll be right back with an update.";
}
function greetingLineFriendly({ lang, hotelName, personaName, guestFirst }) {
	const H = hotelName || "our hotel";
	const G = guestFirst ? ` ${guestFirst}` : "";
	if (lang === "ar") return `السلام عليكم${G}! أنا ${personaName} من ${H}.`;
	if (lang === "es")
		return `¡Assalamu alaikum${G}! Soy ${personaName} de ${H}.`;
	if (lang === "fr")
		return `Assalamu alaykoum${G} ! Je suis ${personaName} de ${H}.`;
	if (lang === "ur") return `السلام علیکم${G}! میں ${personaName}، ${H} سے۔`;
	if (lang === "hi") return `अस्सलामु अलैकुम${G}! मैं ${personaName}, ${H} से।`;
	return `Assalamu alaikum${G}! I’m ${personaName} from ${H}.`;
}
function addressingLineForReservation({ lang, reservation }) {
	const rt =
		(reservation.pickedRoomsType &&
			reservation.pickedRoomsType[0] &&
			(reservation.pickedRoomsType[0].displayName ||
				reservation.pickedRoomsType[0].room_type)) ||
		"Room";
	const dates = formatDateRange(
		reservation.checkin_date,
		reservation.checkout_date
	);
	const total = niceMoney(reservation.total_amount);
	const conf = reservation.confirmation;
	const status = reservation.status || "confirmed";

	if (lang === "ar")
		return `اطلعت على حجزك رقم ${conf}: ${rt} • ${dates} • الإجمالي ${total} SAR • الحالة ${status}. كيف يمكنني مساعدتك في هذا الحجز؟`;
	if (lang === "es")
		return `He cargado tu reserva ${conf}: ${rt} • ${dates} • total ${total} SAR • estado ${status}. ¿Cómo te ayudo con esta reserva?`;
	if (lang === "fr")
		return `J’ai chargé votre réservation ${conf} : ${rt} • ${dates} • total ${total} SAR • statut ${status}. Comment puis‑je vous aider sur cette réservation ?`;
	if (lang === "ur")
		return `میں نے آپ کا ریزرویشن ${conf} کھول لیا ہے: ${rt} • ${dates} • کل ${total} SAR • اسٹیٹس ${status}۔ اس ریزرویشن میں کیسے مدد کروں؟`;
	if (lang === "hi")
		return `मैंने आपकी बुकिंग ${conf} खोल ली है: ${rt} • ${dates} • कुल ${total} SAR • स्थिति ${status}। इस आरक्षण में मैं कैसे मदद करूँ?`;
	return `I’ve loaded your reservation ${conf}: ${rt} • ${dates} • total ${total} SAR • status ${status}. How can I help with this reservation?`;
}
function addressingLineForMissingReservation({ lang, confirmation }) {
	if (lang === "ar")
		return `أرى رقم تأكيد في تذكرتك (${confirmation}) لكني لم أعثر عليه الآن. هل تتكرم بتأكيد رقم الحجز أو مشاركته مرة أخرى؟`;
	if (lang === "es")
		return `Veo un número de confirmación en tu ticket (${confirmation}), pero ahora no aparece. ¿Podrías confirmarlo o compartirlo de nuevo?`;
	if (lang === "fr")
		return `Je vois un numéro de confirmation dans votre ticket (${confirmation}), mais je ne le retrouve pas. Pouvez‑vous le confirmer ou le renvoyer ?`;
	if (lang === "ur")
		return `ٹکٹ میں کنفرمیشن نمبر (${confirmation}) نظر آ رہا ہے مگر یہ نہیں مل رہا۔ براہِ کرم نمبر تصدیق کر کے دوبارہ شیئر کریں۔`;
	if (lang === "hi")
		return `टिकट में कन्फर्मेशन नंबर (${confirmation}) दिख रहा है, पर अभी नहीं मिल रहा। कृपया नंबर की पुष्टि कर के फिर से साझा करें।`;
	return `I see a confirmation number in your ticket (${confirmation}), but I can’t locate it right now. Could you please confirm it or share it again?`;
}
function addressingLineForNewBooking({ lang }) {
	if (lang === "ar")
		return "فهمت أنك تريد إجراء حجز—ما نوع الغرفة تفضّله (دبل/توين/ثلاثية)؟ وما هي تواريخ الوصول والمغادرة؟";
	if (lang === "es")
		return "Entiendo que deseas reservar—¿qué tipo de habitación prefieres (Doble/Twin/Triple) y cuáles son tus fechas de entrada y salida?";
	if (lang === "fr")
		return "Je comprends que vous souhaitez réserver—quel type de chambre préférez‑vous (Double/Twin/Triple) et quelles sont vos dates d’arrivée et de départ ?";
	if (lang === "ur")
		return "آپ نئی بکنگ چاہتے ہیں—کمرے کی کون سی قسم پسند کریں گے (ڈبل/ٹوئن/ٹرپل)؟ اور چیک‑ان/چیک‑آؤٹ کی تاریخیں کیا ہوں گی؟";
	if (lang === "hi")
		return "आप नई बुकिंग करना चाहते हैं—कौन‑सा कमरे का प्रकार चाहेंगे (डबल/ट्विन/ट्रिपल), और चेक‑इन/चेक‑आउट तिथियाँ क्या होंगी?";
	return "I see you’d like to make a reservation—what room type do you prefer (Double/Twin/Triple), and what are your check‑in & check‑out dates?";
}

/* ---------- Greeting scheduler (unchanged logic, with fresh re-extract) ---------- */
async function scheduleGreetingByCaseId(io, caseId) {
	try {
		if (greeted(caseId)) return;
		const caseDoc0 = await SupportCase.findById(caseId)
			.populate("hotelId")
			.lean();
		if (!caseDoc0 || !hotelAllowsAI(caseDoc0.hotelId)) return;

		const langHint =
			extractPreferredLangCodeFromInquiryDetails(
				String(caseDoc0.inquiryDetails || "")
			) ||
			extractPreferredLangCodeFromInquiryDetails(
				String(caseDoc0.conversation?.[0]?.inquiryDetails || "")
			);
		const langCode = normalizeLang(
			langHint || caseDoc0.preferredLanguageCode || "en"
		);
		const persona = await ensurePersona(caseId, langCode);

		const guestName =
			caseDoc0.customerName ||
			caseDoc0.displayName1 ||
			caseDoc0?.conversation?.[0]?.messageBy?.customerName ||
			"";
		const guestFirst = firstNameOf(guestName);

		let { about: about0, confirmation: confirmation0 } =
			extractInquiryDataFromCase(caseDoc0);

		markGreeted(caseId);

		(async () => {
			const warmupMs = randInt(GREETING_WARMUP_MIN_MS, GREETING_WARMUP_MAX_MS);
			const t0 = Date.now();

			let reservationCache = null;
			if (about0 === "reservation" && confirmation0) {
				const found = await findReservationByConfirmation(confirmation0);
				if (found?.ok) {
					reservationCache = found.reservation;
					const st = getState(caseId);
					st.reservationCache = found.reservation;
					st.lastConfirmation = found.reservation.confirmation;
				}
			}

			const elapsed = Date.now() - t0;
			if (elapsed < warmupMs)
				await new Promise((r) => setTimeout(r, warmupMs - elapsed));

			const fresh = await SupportCase.findById(caseId)
				.populate("hotelId")
				.lean();
			if (!fresh || fresh.caseStatus === "closed") return;
			if (!hotelAllowsAI(fresh.hotelId)) return;

			const hadAgent = (fresh?.conversation || []).some((m) =>
				isAssistantLike(
					m?.messageBy?.customerName,
					m?.messageBy?.customerEmail,
					persona.name
				)
			);
			if (hadAgent) return;

			const hotelName = fresh.hotelId?.hotelName || "our hotel";
			const lang = persona.lang;

			const { about: aboutFresh, confirmation: confFresh } =
				extractInquiryDataFromCase(fresh);
			let confirmation = confirmation0 || confFresh || null;

			if (!reservationCache && aboutFresh === "reservation" && confirmation) {
				const found2 = await findReservationByConfirmation(confirmation);
				if (found2?.ok) {
					reservationCache = found2.reservation;
					const st = getState(caseId);
					st.reservationCache = found2.reservation;
					st.lastConfirmation = found2.reservation.confirmation;
				}
			}

			const greeting = greetingLineFriendly({
				lang,
				hotelName,
				personaName: persona.name,
				guestFirst,
			});
			startTyping(io, caseId, persona.name);
			await new Promise((r) => setTimeout(r, computeTypeDelay(greeting)));
			await persistAndBroadcast(io, { caseId, text: greeting, persona, lang });

			let followUp = "";
			if (aboutFresh === "reservation") {
				if (confirmation && reservationCache) {
					followUp = addressingLineForReservation({
						lang,
						reservation: reservationCache,
					});
				} else if (confirmation && !reservationCache) {
					followUp = addressingLineForMissingReservation({
						lang,
						confirmation,
					});
				} else {
					if (lang === "ar")
						followUp =
							"هل تتكرم بمشاركة رقم تأكيد الحجز لنتمكن من مساعدتك (إلغاء/تغيير التواريخ/إضافة غرفة)؟";
					else if (lang === "es")
						followUp =
							"¿Podrías compartir el número de confirmación para ayudarte (cancelar/cambiar fechas/agregar una habitación)?";
					else if (lang === "fr")
						followUp =
							"Pouvez‑vous partager le numéro de confirmation pour que je vous aide (annuler/modifier les dates/ajouter une chambre) ?";
					else if (lang === "ur")
						followUp =
							"براہِ کرم کنفرمیشن نمبر شیئر کریں تاکہ (منسوخی/تاریخوں میں تبدیلی/کمرہ شامل) میں مدد کر سکوں۔";
					else if (lang === "hi")
						followUp =
							"कृपया कन्फर्मेशन नंबर साझा करें ताकि (रद्द/तिथियाँ बदलना/कमरा जोड़ना) में मदद कर सकूँ।";
					else
						followUp =
							"Please share your confirmation number so I can help (cancel/change dates/add a room).";
				}
			} else if (
				aboutFresh === "reserve_room" ||
				aboutFresh === "reserve_bed"
			) {
				followUp = addressingLineForNewBooking({ lang });
			} else {
				if (lang === "ar") followUp = "كيف يمكنني مساعدتك بخصوص الحجز؟";
				else if (lang === "es")
					followUp = "¿En qué puedo ayudarte con tu reserva?";
				else if (lang === "fr")
					followUp = "Comment puis‑je vous aider pour votre réservation ?";
				else if (lang === "ur")
					followUp = "آپ کی بکنگ کے سلسلے میں میں کیسے مدد کر سکتا/سکتی ہوں؟";
				else if (lang === "hi")
					followUp = "आपकी बुकिंग के संबंध में मैं कैसे मदद करूँ?";
				else followUp = "How can I help with your booking today?";
			}

			startTyping(io, caseId, persona.name);
			await new Promise((r) => setTimeout(r, computeTypeDelay(followUp)));
			await persistAndBroadcast(io, { caseId, text: followUp, persona, lang });
		})().catch((e) =>
			console.error("[AI] warm-up greeting error:", e?.message || e)
		);
	} catch (e) {
		console.error("[AI] auto-greet schedule error:", e?.message || e);
	}
}

/* ---------- Persist & emit, wait follow-ups, idle close ---------- */
async function persistAndBroadcast(io, { caseId, text, persona, lang }) {
	if (!text) return;

	const hadTimer = waitFollowupTimers.get(caseId);
	if (hadTimer && !lowerIncludesAny(text, WAIT_REQUEST_MARKERS)) {
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
		seenByCustomer: true,
	};

	try {
		await SupportCase.findByIdAndUpdate(
			caseId,
			{ $set: { aiRelated: true }, $push: { conversation: msg } },
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

	armIdleClose(io, caseId, persona.name);

	if (lowerIncludesAny(msg.message, WAIT_REQUEST_MARKERS)) {
		const t = setTimeout(
			() => autoFollowUpAfterWait(io, caseId),
			WAIT_FOLLOWUP_MS
		);
		waitFollowupTimers.set(caseId, { t, scheduledAt: Date.now() });
	}
}

function armIdleClose(io, caseId, personaName) {
	const prev = idleTimers.get(caseId);
	if (prev) clearTimeout(prev.t);
	const t = setTimeout(async () => {
		try {
			const doc = await SupportCase.findById(caseId).lean();
			if (!doc || doc.caseStatus === "closed") return;
			await SupportCase.findByIdAndUpdate(
				caseId,
				{ caseStatus: "closed" },
				{ new: true }
			);
			io.to(caseId).emit("caseClosed", {
				caseId,
				closedBy: personaName || "system",
			});
		} catch (_) {}
		idleTimers.delete(caseId);
	}, INACTIVITY_CLOSE_MS);
	idleTimers.set(caseId, { t, at: Date.now() });
}
function scheduleClose(io, caseId, personaName, delay = AUTO_CLOSE_AFTER_MS) {
	const t = setTimeout(async () => {
		try {
			await SupportCase.findByIdAndUpdate(
				caseId,
				{ caseStatus: "closed" },
				{ new: true }
			);
			io.to(caseId).emit("caseClosed", { caseId, closedBy: personaName });
		} catch (_) {}
	}, delay);
	return t;
}
function cancelClose(caseId) {
	const prev = closeTimers.get(caseId);
	if (prev) {
		clearTimeout(prev);
		closeTimers.delete(caseId);
	}
}
async function autoFollowUpAfterWait(io, caseId) {
	try {
		waitFollowupTimers.delete(caseId);
		const caseDoc = await SupportCase.findById(caseId)
			.populate("hotelId")
			.lean();
		if (!caseDoc || !hotelAllowsAI(caseDoc.hotelId)) return;

		const langHint =
			extractPreferredLangCodeFromInquiryDetails(
				String(caseDoc.inquiryDetails || "")
			) ||
			extractPreferredLangCodeFromInquiryDetails(
				String(caseDoc.conversation?.[0]?.inquiryDetails || "")
			);
		const persona = await ensurePersona(
			caseId,
			normalizeLang(langHint || caseDoc.preferredLanguageCode || "en")
		);
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
				"Follow-up after wait: provide checked results succinctly. Avoid prefacing.",
		});
		await new Promise((r) => setTimeout(r, computeTypeDelay(text)));
		await persistAndBroadcast(io, {
			caseId,
			text,
			persona,
			lang: persona.lang,
		});
	} catch (e) {
		console.error("[AI] autoFollowUpAfterWait error:", e?.message || e);
	}
}

/* ---------- Reservation cache ---------- */
async function cacheReservationByConfirmation(caseId, confFrom) {
	const st = getState(caseId);
	const conf = extractConfirmationFrom(confFrom || "");
	if (!conf) return null;
	const res = await findReservationByConfirmation(conf);
	if (res?.ok) {
		st.reservationCache = res.reservation;
		if (safeConfirmValue(res.reservation.confirmation))
			st.lastConfirmation = res.reservation.confirmation;
		caseState.set(caseId, st);
	}
	return res?.ok ? res.reservation : null;
}

/* ---------- Booking readiness ---------- */
function inferAdultsFromRoomTokens(roomTypeText = "") {
	const s = lower(roomTypeText);
	if (!s) return 2;
	if (s.includes("triple") || s.includes("ثلاث")) return 3;
	if (
		s.includes("quad") ||
		s.includes("رباع") ||
		s.includes("family") ||
		s.includes("عائ")
	)
		return 4;
	if (
		s.includes("double") ||
		s.includes("twin") ||
		s.includes("دبل") ||
		s.includes("مزدوج") ||
		s.includes("توين")
	)
		return 2;
	return 2;
}

function askForMissingFieldsText(lang, missing = [], compact = false) {
	const labels = {
		name: {
			en: "Full name (first + last)",
			ar: "الاسم الكامل",
			es: "Nombre completo",
			fr: "Nom complet",
			ur: "پورا نام",
			hi: "पूरा नाम",
		},
		email: {
			en: "Email (optional)",
			ar: "البريد الإلكتروني (اختياري)",
			es: "Correo (opcional)",
			fr: "Email (facultatif)",
			ur: "ای میل (اختیاری)",
			hi: "ईमेल (वैकल्पिक)",
		},
		phone: {
			en: "Phone number (WhatsApp preferred)",
			ar: "رقم الهاتف (الأفضل واتساب)",
			es: "Teléfono (WhatsApp preferido)",
			fr: "Téléphone (WhatsApp préféré)",
			ur: "فون نمبر (واٹس ایپ بہتر)",
			hi: "फोन नंबर (व्हाट्सऐप बेहतर)",
		},
		nationality: {
			en: "Nationality",
			ar: "الجنسية",
			es: "Nacionalidad",
			fr: "Nationalité",
			ur: "قومیت",
			hi: "राष्ट्रीयता",
		},
		checkIn: {
			en: "Check‑in date (YYYY‑MM‑DD)",
			ar: "تاريخ الوصول (YYYY‑MM‑DD)",
			es: "Fecha de entrada (YYYY‑MM‑DD)",
			fr: "Date d’arrivée (YYYY‑MM‑DD)",
			ur: "چیک‑ان تاریخ (YYYY‑MM‑DD)",
			hi: "चेक‑इन तिथि (YYYY‑MM‑DD)",
		},
		checkOut: {
			en: "Check‑out date (YYYY‑MM‑DD)",
			ar: "تاريخ المغادرة (YYYY‑MM‑DD)",
			es: "Fecha de salida (YYYY‑MM‑DD)",
			fr: "Date de départ (YYYY‑MM‑DD)",
			ur: "چیک‑آؤٹ تاریخ (YYYY‑MM‑DD)",
			hi: "चेक‑आउट तिथि (YYYY‑MM‑DD)",
		},
		roomType: {
			en: "Room type (e.g., Double/Twin/Triple)",
			ar: "نوع الغرفة (مثلاً دبل/توين/ثلاثية)",
			es: "Tipo de habitación (Doble/Twin/Triple)",
			fr: "Type de chambre (Double/Twin/Triple)",
			ur: "روم ٹائپ (ڈبل/ٹوئن/ٹرپل)",
			hi: "कमरे का प्रकार (डबल/ट्विन/ट्रिपल)",
		},
	};
	const code = ["ar", "es", "fr", "ur", "hi"].includes(lang) ? lang : "en";
	const items = missing.map((k) => labels[k]?.[code] || k);

	const compactLine =
		code === "ar"
			? `أحتاج فقط: ${items.join("، ")}. يمكنك إرسالها واحدة تلو الأخرى.`
			: code === "es"
			? `Solo me falta: ${items.join(", ")}. Puedes enviarlos uno por uno.`
			: code === "fr"
			? `Il me manque juste : ${items.join(
					", "
			  )}. Vous pouvez les donner un par un.`
			: code === "ur"
			? `مجھے صرف یہ درکار ہے: ${items.join("، ")}۔ آپ ایک ایک کر کے بھیج دیں۔`
			: code === "hi"
			? `बस ये चाहिए: ${items.join(", ")}. आप इन्हें एक‑एक करके भेज दें.`
			: `I just need: ${items.join(", ")}. You can share them one by one.`;

	if (compact) return compactLine;

	const bullet =
		code === "ar"
			? `لتأكيد الحجز نحتاج فقط:\n- ${items.join(
					"\n- "
			  )}\nيمكنك مشاركتها واحدة تلو الأخرى.`
			: code === "es"
			? `Para finalizar la reserva solo necesito:\n- ${items.join(
					"\n- "
			  )}\nPuedes enviarlos uno por uno.`
			: code === "fr"
			? `Pour finaliser la réservation, j’ai juste besoin de :\n- ${items.join(
					"\n- "
			  )}\nVous pouvez les donner un par un.`
			: code === "ur"
			? `حجز مکمل کرنے کے لیے مجھے یہ درکار ہے:\n- ${items.join(
					"\n- "
			  )}\nآپ انہیں ایک ایک کر کے ارسال کر دیں۔`
			: code === "hi"
			? `आरक्षण पूरा करने के लिए मुझे ये चाहिए:\n- ${items.join(
					"\n- "
			  )}\nआप इन्हें एक‑एक करके भेज सकते हैं।`
			: `To finalize your reservation I just need:\n- ${items.join(
					"\n- "
			  )}\nYou can share them one by one—I’ll fill them in as we go.`;
	return bullet;
}

function pickBookedRoomFromPricing(state) {
	const p = state.lastPricing;
	if (!p || !Array.isArray(p.results)) return null;
	return (
		p.results.find(
			(r) => r && r.ok && Array.isArray(r.nightly) && r.nightly.length > 0
		) || null
	);
}

function evaluateBookingReadiness(caseDoc, state) {
	const hotel = caseDoc.hotelId;
	const collected = state.collected || {};
	const ident = knownIdentityFromCase(caseDoc);

	const name = collected.name || ident.name || "";
	const email = collected.email || ident.email || "";
	const phone = collected.phone || ident.phone || "";

	// infer room type text for adults default
	const chosen = pickBookedRoomFromPricing(state);
	const roomTypeText =
		chosen?.roomType || chosen?.displayName || collected.roomTypeHint || "";

	const adultsVal =
		collected.adults != null
			? collected.adults
			: inferAdultsFromRoomTokens(roomTypeText);
	const childrenVal = collected.children != null ? collected.children : 0;
	const roomsCountVal = collected.roomsCount != null ? collected.roomsCount : 1;

	const nationality = collected.nationality || "";
	const stay = state.intendedStay || null;

	const missing = [];
	if (!isFullName(name)) missing.push("name");
	if (!isLikelyPhone(phone)) missing.push("phone");
	if (!nationality) missing.push("nationality");
	if (!stay?.check_in_date) missing.push("checkIn");
	if (!stay?.check_out_date) missing.push("checkOut");
	if (!chosen && !collected.roomTypeHint) missing.push("roomType");

	const ready = missing.length === 0;
	return {
		ready,
		missing,
		guest: {
			name,
			email,
			phone,
			nationality,
			adults: adultsVal,
			children: childrenVal,
		},
		roomsCount: roomsCountVal,
		stay,
		chosen,
		hotel,
	};
}

/* ---------- OpenAI reply generation ---------- */
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
		knownIdentity: knownIdentityFromCase(caseDoc),
	});

	const training = await fetchGuidanceForAgent({
		hotelId: caseDoc.hotelId?._id || caseDoc.hotelId,
	});
	const history = toOpenAIHistory(caseDoc.conversation, persona.name);
	const inquiryHint = buildInquirySystemHint(caseDoc);
	const userTurn = String(currentMessage?.message || "").trim();

	const messages = [
		{
			role: "system",
			content:
				system +
				buildLearningSections(training) +
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
	const MODEL = sanitizeModelName(RAW_MODEL) || "gpt-4.1";
	return await runWithTools(client, {
		messages,
		context,
		model: model || MODEL,
	});
}

/* ---------- Conversation heuristics ---------- */
function stripRedundantOpeners(text = "", conversation = []) {
	const openerRegex =
		/^(hi|hello|hey|assalamu|assalam|السلام|مرحبا|hola|bonjour)[,!\s]*/i;
	if (conversation.length > 4) return text.replace(openerRegex, "");
	return text;
}
function assistantAskedToCancelHeuristic(msg) {
	const t = lower(msg || "");
	if (!t.includes("cancel")) return false;
	const signals = [
		"confirm",
		"proceed",
		"process",
		"shall",
		"should",
		"go ahead",
		"do you want",
		"would you like",
	];
	const hasSignal = signals.some((s) => t.includes(s));
	return hasSignal || t.includes("?");
}

/** Much broader detection for “assistant asked to confirm booking” */
function lastAssistantAskedForConfirmation(
	conversation = [],
	personaName = ""
) {
	const PHRASES = [
		// English
		"would you like me to confirm",
		"may i confirm",
		"should i proceed",
		"shall i proceed",
		"shall i book",
		"do you want me to book",
		"do you want me to confirm",
		"proceed with booking",
		"go ahead and book",
		"go ahead and reserve",
		"confirm this reservation",
		"confirm the booking",
		"finalize this booking",
		"shall i finalize",
		"ready to confirm",
		"ready to finalize",
		"shall i go ahead",
		// Arabic
		"هل تريد أن أؤكد",
		"هل ترغب أن أؤكد",
		"هل تريد تأكيد",
		"أؤكد الحجز",
		"أقوم بتأكيد",
		"هل أمضي قدماً",
		"أكمل الحجز",
		"أتم الحجز",
		// Spanish
		"¿deseas que confirme",
		"¿puedo confirmar",
		"¿confirmo",
		"¿procedo a reservar",
		"¿quieres que lo reserve",
		// French
		"souhaitez-vous que je confirme",
		"puis-je confirmer",
		"dois-je procéder",
		"je finalise la réservation",
		"confirmer la réservation",
	];

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
		const t = lower(c.message);
		if (PHRASES.some((p) => t.includes(lower(p)))) return true;
		if (/confirm\W+your\W+(booking|reservation)/i.test(t)) return true;
		if (/shall\W+i\W+(confirm|proceed|finalize)/i.test(t)) return true;
		if (/¿.*(confirm|reserva|proced).*\?/i.test(t)) return true;
		if (/(confirme|procède|finalise).*\?/i.test(t)) return true;
		if (/(أؤكد|أكمل|أتم).*\?/u.test(t)) return true;
		return false;
	}
	return false;
}
function lastAssistantAskedAnythingElse(conversation = [], personaName = "") {
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
			lowerIncludesAny(c.message, [
				"anything else",
				"need anything else",
				"help with anything else",
			])
		)
			return true;
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
		if (lowerIncludesAny(c.message, WAIT_REQUEST_MARKERS)) return true;
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
		if (assistantAskedToCancelHeuristic(c.message)) return true;
		return false;
	}
	return false;
}

/* ---------- Core processing flow ---------- */
async function processCase(io, client, MODEL, caseId) {
	const entry = debounceMap.get(caseId);
	if (!entry) return;
	const payload = entry.payload;
	debounceMap.delete(caseId);

	try {
		const existingPersona = personaByCase.get(caseId);
		if (isFromHumanStaffOrAgent(payload, existingPersona?.name)) return;

		if (payload?.caseId)
			armIdleClose(io, payload.caseId, existingPersona?.name || "system");

		if (shouldWaitForGuest(caseId)) {
			const waitMore = Math.max(WAIT_WHILE_TYPING_MS, 1100);
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
				350
			);
			debounceMap.set(caseId, { timer, payload });
			return;
		}
		replyLock.add(caseId);

		const caseDoc = await SupportCase.findById(caseId)
			.populate("hotelId")
			.lean();
		if (!caseDoc?.hotelId || !hotelAllowsAI(caseDoc.hotelId)) {
			replyLock.delete(caseId);
			return;
		}

		const langHint =
			extractPreferredLangCodeFromInquiryDetails(
				String(caseDoc.inquiryDetails || "")
			) ||
			extractPreferredLangCodeFromInquiryDetails(
				String(caseDoc.conversation?.[0]?.inquiryDetails || "")
			);
		const persona = await ensurePersona(
			caseId,
			normalizeLang(
				payload.preferredLanguageCode ||
					langHint ||
					existingPersona?.lang ||
					"en"
			)
		);
		const st = getState(caseId);
		st.lang = persona.lang;
		st.personaName = persona.name;

		const { about: inquiryAbout, confirmation: confFromTicket } =
			extractInquiryDataFromCase(caseDoc);

		const foundConfInMsg = extractConfirmationFrom(payload?.message || "");
		const freshConf = foundConfInMsg || confFromTicket || null;
		if (freshConf) await cacheReservationByConfirmation(caseId, freshConf);

		// Rebuild extracted info from the whole conversation (to avoid repeating asks)
		const rebuilt = rebuildStateFromConversation(caseDoc);
		if (rebuilt?.collected)
			st.collected = { ...(st.collected || {}), ...rebuilt.collected };
		if (rebuilt?.intendedStay) st.intendedStay = rebuilt.intendedStay;

		// QUICK etiquette
		if (
			lowerIncludesAny(payload?.message || "", WAIT_ACK_MARKERS) &&
			lastAssistantAskedToWait(caseDoc.conversation || [], persona.name)
		) {
			startTyping(io, caseId, persona.name);
			const ack = shortThanksLine(persona.lang);
			await new Promise((r) => setTimeout(r, computeTypeDelay(ack)));
			await persistAndBroadcast(io, {
				caseId,
				text: ack,
				persona,
				lang: persona.lang,
			});
			if (!waitFollowupTimers.get(caseId)) {
				const t = setTimeout(
					() => autoFollowUpAfterWait(io, caseId),
					WAIT_FOLLOWUP_MS
				);
				waitFollowupTimers.set(caseId, { t, scheduledAt: Date.now() });
			}
			replyLock.delete(caseId);
			return;
		}

		// Identity deflection
		if (
			lowerIncludesAny(payload?.message || "", [
				"are you ai",
				"are you a bot",
				"is this ai",
			])
		) {
			startTyping(io, caseId, persona.name);
			const line = identityDeflectionLine(persona.lang);
			await new Promise((r) => setTimeout(r, computeTypeDelay(line)));
			await persistAndBroadcast(io, {
				caseId,
				text: line,
				persona,
				lang: persona.lang,
			});
			replyLock.delete(caseId);
			return;
		}

		// Reactive: “Did you see my confirmation?”
		if (
			lowerIncludesAny(payload?.message || "", [
				"did you see my confirmation",
				"do you see my confirmation",
				"confirmation number",
				"رقم التأكيد",
				"número de confirmación",
				"numéro de confirmation",
			])
		) {
			const conf = freshConf || extractConfirmationFromCase(caseDoc);
			if (inquiryAbout === "reservation" && conf) {
				const resDoc =
					st.reservationCache ||
					(await cacheReservationByConfirmation(caseId, conf));
				startTyping(io, caseId, persona.name);
				let msg = "";
				if (resDoc && resDoc.confirmation) {
					msg = addressingLineForReservation({
						lang: persona.lang,
						reservation: resDoc,
					});
				} else {
					msg = addressingLineForMissingReservation({
						lang: persona.lang,
						confirmation: conf,
					});
				}
				await new Promise((r) => setTimeout(r, computeTypeDelay(msg)));
				await persistAndBroadcast(io, {
					caseId,
					text: msg,
					persona,
					lang: persona.lang,
				});
				replyLock.delete(caseId);
				return;
			}
		}

		/* ---------- Deterministic reservation flows (cancel/change) ---------- */

		// CANCEL — if last assistant asked to cancel and user said "yes"
		if (
			lastAssistantAskedToCancel(caseDoc.conversation || [], persona.name) &&
			isAffirmative(payload?.message || "")
		) {
			const confToken = st.lastConfirmation || freshConf;
			const resDoc =
				st.reservationCache ||
				(confToken
					? await cacheReservationByConfirmation(caseId, confToken)
					: null);
			if (resDoc?._id || confToken) {
				startTyping(io, caseId, persona.name);
				const doing =
					persona.lang === "ar"
						? "سألغي الحجز الآن. لحظة من فضلك."
						: persona.lang === "es"
						? "Procedo a cancelar la reserva. Un momento, por favor."
						: persona.lang === "fr"
						? "J’annule la réservation maintenant. Un instant, s’il vous plaît."
						: persona.lang === "ur"
						? "میں ریزرویشن منسوخ کر رہا/رہی ہوں—ایک لمحہ۔"
						: persona.lang === "hi"
						? "मैं आरक्षण रद्द करता/करती हूँ—एक क्षण।"
						: "I’ll cancel the reservation now. One moment, please.";
				await new Promise((r) => setTimeout(r, computeTypeDelay(doing)));
				await persistAndBroadcast(io, {
					caseId,
					text: doing,
					persona,
					lang: persona.lang,
				});

				const upd = await cancelReservationByIdOrConfirmation(
					resDoc?._id || confToken
				);
				const conf = resDoc?.confirmation || confToken || "";
				const done = upd?.ok
					? persona.lang === "ar"
						? `تم إلغاء الحجز ${conf}. رابط التفاصيل: ${PUBLIC_CLIENT_URL}/single-reservation/${conf}\nهل أستطيع مساعدتك بشيء آخر؟`
						: persona.lang === "es"
						? `Reserva ${conf} cancelada. Detalles: ${PUBLIC_CLIENT_URL}/single-reservation/${conf}\n¿Puedo ayudarte con algo más?`
						: persona.lang === "fr"
						? `Réservation ${conf} annulée. Détails : ${PUBLIC_CLIENT_URL}/single-reservation/${conf}\nPuis‑je vous aider avec autre chose ?`
						: persona.lang === "ur"
						? `ریزرویشن ${conf} منسوخ ہوگیا۔ تفصیل: ${PUBLIC_CLIENT_URL}/single-reservation/${conf}\nکیا مزید کسی چیز میں مدد کر سکتا/سکتی ہوں؟`
						: persona.lang === "hi"
						? `आरक्षण ${conf} रद्द कर दिया गया। विवरण: ${PUBLIC_CLIENT_URL}/single-reservation/${conf}\nक्या और किसी चीज़ में मदद करूँ?`
						: `Reservation ${conf} has been cancelled. Details: ${PUBLIC_CLIENT_URL}/single-reservation/${conf}\nIs there anything else I can help you with?`
					: persona.lang === "ar"
					? `عذرًا، تعذّر إلغاء الحجز الآن: ${upd?.error || "خطأ غير معروف"}.`
					: persona.lang === "es"
					? `No pude cancelar ahora: ${upd?.error || "error desconocido"}.`
					: persona.lang === "fr"
					? `Impossible d’annuler : ${upd?.error || "erreur inconnue"}.`
					: persona.lang === "ur"
					? `منسوخی ممکن نہیں: ${upd?.error || "نامعلوم خرابی"}.`
					: persona.lang === "hi"
					? `रद्दीकरण संभव नहीं: ${upd?.error || "अज्ञात त्रुटि"}.`
					: `Sorry—couldn’t cancel right now: ${
							upd?.error || "Unknown error"
					  }.`;
				startTyping(io, caseId, persona.name);
				await new Promise((r) => setTimeout(r, computeTypeDelay(done)));
				await persistAndBroadcast(io, {
					caseId,
					text: done,
					persona,
					lang: persona.lang,
				});
				replyLock.delete(caseId);
				return;
			}
		}

		// CHANGE DATES — detect intent and reprice
		const hasChangeDatesIntent =
			lowerIncludesAny(payload?.message || "", CHANGE_WORDS) &&
			lowerIncludesAny(payload?.message || "", DATE_WORDS);
		const baseStart = st.reservationCache?.checkin_date || null;
		const baseEnd = st.reservationCache?.checkout_date || null;
		const proposedDates = parseDateTokens(
			payload?.message || "",
			baseStart,
			baseEnd
		);
		if (
			(hasChangeDatesIntent || proposedDates) &&
			(st.reservationCache || freshConf)
		) {
			const resDoc =
				st.reservationCache ||
				(freshConf
					? await cacheReservationByConfirmation(caseId, freshConf)
					: null);
			if (
				resDoc &&
				proposedDates?.check_in_date &&
				proposedDates?.check_out_date
			) {
				const hotel = await HotelDetails.findById(resDoc.hotelId).lean();
				const repr = await repriceReservation({
					reservation: resDoc,
					hotel,
					newStay: proposedDates,
					newRoomTypeCanon: null,
				});
				if (repr.ok) {
					startTyping(io, caseId, persona.name);
					const preview =
						persona.lang === "ar"
							? `سأحدّث التواريخ إلى ${repr.next.checkin_date} → ${repr.next.checkout_date}.\nالإجمالي الجديد: ${repr.next.total_amount} SAR.\nأؤكد التعديل؟`
							: persona.lang === "es"
							? `Actualizaré las fechas a ${repr.next.checkin_date} → ${repr.next.checkout_date}.\nNuevo total: ${repr.next.total_amount} SAR.\n¿Confirmo el cambio?`
							: persona.lang === "fr"
							? `Je mets à jour aux dates ${repr.next.checkin_date} → ${repr.next.checkout_date}.\nNouveau total : ${repr.next.total_amount} SAR.\nConfirmez‑vous ?`
							: persona.lang === "ur"
							? `میں تاریخیں ${repr.next.checkin_date} → ${repr.next.checkout_date} کر دوں؟\nنیا ٹوٹل: ${repr.next.total_amount} SAR.\nکیا کنفرم کروں؟`
							: persona.lang === "hi"
							? `तिथियाँ ${repr.next.checkin_date} → ${repr.next.checkout_date} कर दूँ?\nनया कुल: ${repr.next.total_amount} SAR.\nक्या पुष्टि कर दूँ?`
							: `I’ll update the dates to ${repr.next.checkin_date} → ${repr.next.checkout_date}.\nNew total: ${repr.next.total_amount} SAR.\nShall I confirm the change?`;
					await new Promise((r) => setTimeout(r, computeTypeDelay(preview)));
					await persistAndBroadcast(io, {
						caseId,
						text: preview,
						persona,
						lang: persona.lang,
					});

					st.pendingAction = {
						kind: "applyDateChange",
						repr,
						reservationId: resDoc._id,
						confirmation: resDoc.confirmation,
					};
					replyLock.delete(caseId);
					return;
				} else if (repr.blocked && repr.alternative) {
					startTyping(io, caseId, persona.name);
					const alt = repr.alternative;
					const altMsg =
						persona.lang === "ar"
							? `هذه التواريخ غير متاحة لنوع الغرفة. أقرب خيار: ${alt.check_in_date} → ${alt.check_out_date} بإجمالي ${alt.totals.totalWithCommission} SAR. هل تود التحويل لهذا الخيار؟`
							: persona.lang === "es"
							? `Esas fechas no están disponibles. Opción más cercana: ${alt.check_in_date} → ${alt.check_out_date} por ${alt.totals.totalWithCommission} SAR. ¿Quieres usarla?`
							: persona.lang === "fr"
							? `Ces dates ne sont pas disponibles. Option la plus proche : ${alt.check_in_date} → ${alt.check_out_date} pour ${alt.totals.totalWithCommission} SAR. Souhaitez‑vous l’utiliser ?`
							: persona.lang === "ur"
							? `یہ تاریخیں دستیاب نہیں۔ قریب ترین ونڈو: ${alt.check_in_date} → ${alt.check_out_date} بمع ${alt.totals.totalWithCommission} SAR۔ کیا اسے منتخب کروں؟`
							: persona.lang === "hi"
							? `ये तिथियाँ उपलब्ध नहीं हैं। निकटतम विकल्प: ${alt.check_in_date} → ${alt.check_out_date}, कुल ${alt.totals.totalWithCommission} SAR. क्या इसे चुनूँ?`
							: `Those dates aren’t available. Nearest option: ${alt.check_in_date} → ${alt.check_out_date}, total ${alt.totals.totalWithCommission} SAR. Use this instead?`;
					await new Promise((r) => setTimeout(r, computeTypeDelay(altMsg)));
					await persistAndBroadcast(io, {
						caseId,
						text: altMsg,
						persona,
						lang: persona.lang,
					});

					st.pendingAction = {
						kind: "applyAltWindow",
						alt,
						reservationId: resDoc._id,
						confirmation: resDoc.confirmation,
					};
					replyLock.delete(caseId);
					return;
				} else {
					startTyping(io, caseId, persona.name);
					const fail =
						persona.lang === "ar"
							? "تعذّر تسعير هذه التغييرات الآن. هل تودّ تغيير نوع الغرفة أو التواريخ؟"
							: persona.lang === "es"
							? "No pude recalcular ahora. ¿Deseas cambiar el tipo de habitación o las fechas?"
							: persona.lang === "fr"
							? "Impossible de recalculer maintenant. Voulez‑vous changer le type de chambre ou les dates ?"
							: persona.lang === "ur"
							? "اس وقت دوبارہ قیمت نہیں نکال سکا/سکی۔ کیا کمرا ٹائپ یا تاریخیں بدلنا چاہیں گے؟"
							: persona.lang === "hi"
							? "अभी फिर से मूल्य नहीं निकाल सका/सकी। क्या कमरा टाइप या तिथियाँ बदलना चाहते हैं?"
							: "I couldn’t recalculate right now—would you like to change the room type or dates?";
					await new Promise((r) => setTimeout(r, computeTypeDelay(fail)));
					await persistAndBroadcast(io, {
						caseId,
						text: fail,
						persona,
						lang: persona.lang,
					});
					replyLock.delete(caseId);
					return;
				}
			}
		}

		// APPLY pending changes after "yes"
		if (st.pendingAction && isAffirmative(payload?.message || "")) {
			if (
				st.pendingAction.kind === "applyDateChange" &&
				st.pendingAction.repr
			) {
				const { repr, reservationId, confirmation } = st.pendingAction;
				st.pendingAction = null;

				const updates = {
					checkin_date: repr.next.checkin_date,
					checkout_date: repr.next.checkout_date,
					days_of_residence: repr.next.days_of_residence,
					pickedRoomsType: repr.next.pickedRoomsType,
					total_amount: repr.next.total_amount,
					commission: repr.next.commission,
				};
				const out = await applyReservationUpdate({
					reservation_id: reservationId,
					changes: updates,
				});

				startTyping(io, caseId, persona.name);
				const done = out.ok
					? persona.lang === "ar"
						? `تم تحديث التواريخ. رابط التفاصيل: ${PUBLIC_CLIENT_URL}/single-reservation/${confirmation}\nهل أساعدك بشيء آخر؟`
						: persona.lang === "es"
						? `Fechas actualizadas. Detalles: ${PUBLIC_CLIENT_URL}/single-reservation/${confirmation}\n¿Algo más?`
						: persona.lang === "fr"
						? `Dates mises à jour. Détails : ${PUBLIC_CLIENT_URL}/single-reservation/${confirmation}\nPuis‑je aider encore ?`
						: persona.lang === "ur"
						? `تاریخیں اپڈیٹ ہو گئیں۔ تفصیل: ${PUBLIC_CLIENT_URL}/single-reservation/${confirmation}\nکیا مزید مدد درکار ہے؟`
						: persona.lang === "hi"
						? `तिथियाँ अपडेट हो गईं। विवरण: ${PUBLIC_CLIENT_URL}/single-reservation/${confirmation}\nऔर कुछ?`
						: `Dates updated. Details: ${PUBLIC_CLIENT_URL}/single-reservation/${confirmation}\nIs there anything else I can help you with?`
					: persona.lang === "ar"
					? `تعذّر تحديث التواريخ: ${out.error || "خطأ غير معروف"}.`
					: persona.lang === "es"
					? `No pude actualizar fechas: ${out.error || "error desconocido"}.`
					: persona.lang === "fr"
					? `Impossible de mettre à jour les dates : ${
							out.error || "erreur inconnue"
					  }.`
					: persona.lang === "ur"
					? `تاریخیں اپڈیٹ نہ ہو سکیں: ${out.error || "نامعلوم خرابی"}.`
					: persona.lang === "hi"
					? `तिथियाँ अपडेट नहीं हो सकीं: ${out.error || "अज्ञात त्रुटि"}.`
					: `Sorry—couldn’t update the dates: ${out.error || "Unknown error"}.`;
				await new Promise((r) => setTimeout(r, computeTypeDelay(done)));
				await persistAndBroadcast(io, {
					caseId,
					text: done,
					persona,
					lang: persona.lang,
				});
				replyLock.delete(caseId);
				return;
			}
			if (st.pendingAction.kind === "applyAltWindow" && st.pendingAction.alt) {
				const { alt, reservationId, confirmation } = st.pendingAction;
				st.pendingAction = null;

				const hotelId =
					(st.reservationCache && st.reservationCache.hotelId) || null;
				const hotel = hotelId
					? await HotelDetails.findById(hotelId).lean()
					: null;
				const resDoc = st.reservationCache;
				if (hotel && resDoc) {
					const repr2 = await repriceReservation({
						reservation: resDoc,
						hotel,
						newStay: {
							check_in_date: alt.check_in_date,
							check_out_date: alt.check_out_date,
						},
						newRoomTypeCanon: null,
					});
					if (repr2.ok) {
						const updates = {
							checkin_date: repr2.next.checkin_date,
							checkout_date: repr2.next.checkout_date,
							days_of_residence: repr2.next.days_of_residence,
							pickedRoomsType: repr2.next.pickedRoomsType,
							total_amount: repr2.next.total_amount,
							commission: repr2.next.commission,
						};
						const out = await applyReservationUpdate({
							reservation_id: reservationId,
							changes: updates,
						});

						startTyping(io, caseId, persona.name);
						const msg = out.ok
							? `Updated to ${repr2.next.checkin_date} → ${repr2.next.checkout_date}. Details: ${PUBLIC_CLIENT_URL}/single-reservation/${confirmation}\nIs there anything else I can help you with?`
							: `Sorry—couldn’t apply the alternative window: ${
									out.error || "Unknown error"
							  }.`;
						await new Promise((r) => setTimeout(r, computeTypeDelay(msg)));
						await persistAndBroadcast(io, {
							caseId,
							text: msg,
							persona,
							lang: persona.lang,
						});
						replyLock.delete(caseId);
						return;
					}
				}
			}
		}

		// Close etiquette after “anything else”
		if (lowerIncludesAny(payload?.message || "", STRONG_GOODBYE)) {
			const askedMore = lastAssistantAskedAnythingElse(
				caseDoc.conversation || [],
				persona.name
			);
			if (askedMore && !st.pendingAction) {
				const hotelName = caseDoc.hotelId?.hotelName || "our hotel";
				startTyping(io, caseId, persona.name);
				const bye =
					persona.lang === "ar"
						? `شكرًا لاختيارك ${hotelName}. نسعد بخدمتك دائمًا.`
						: persona.lang === "es"
						? `Gracias por elegir ${hotelName}. ¡Siempre a tu servicio!`
						: persona.lang === "fr"
						? `Merci d’avoir choisi ${hotelName}. Nous restons à votre service.`
						: persona.lang === "ur"
						? `آپ نے ${hotelName} کا انتخاب کیا، شکریہ۔ ہم حاضر ہیں۔`
						: persona.lang === "hi"
						? `धन्यवाद, आपने ${hotelName} चुना। हम हमेशा आपकी सेवा में हैं।`
						: `Thank you for choosing ${hotelName}. We’re always here if you need anything.`;
				await new Promise((r) => setTimeout(r, computeTypeDelay(bye)));
				await persistAndBroadcast(io, {
					caseId,
					text: bye,
					persona,
					lang: persona.lang,
				});
				const t = scheduleClose(io, caseId, persona.name, AUTO_CLOSE_AFTER_MS);
				closeTimers.set(caseId, t);
				replyLock.delete(caseId);
				return;
			}
		}

		/* ---------- NEW BOOKING: lock “proceed” after a single affirmative ---------- */
		const askedConfirm = lastAssistantAskedForConfirmation(
			caseDoc.conversation || [],
			persona.name
		);
		st.intentProceed =
			st.intentProceed ||
			(askedConfirm && isAffirmative(payload?.message || "")) ||
			lowerIncludesAny(payload?.message || "", STRONG_BOOK_INTENT);

		const plan = evaluateBookingReadiness(caseDoc, st);

		// Ask for only truly-missing fields (nationality required, others inferred)
		if (st.intentProceed && !plan.ready) {
			const key = JSON.stringify([...plan.missing].sort());
			const now = Date.now();
			const cooldownMs = 60000;
			const canAskAgain =
				!st.lastMissingKey ||
				st.lastMissingKey !== key ||
				now - (st.askedMissingAt || 0) > cooldownMs;

			startTyping(io, caseId, persona.name);
			const ask = canAskAgain
				? askForMissingFieldsText(persona.lang, plan.missing)
				: askForMissingFieldsText(persona.lang, plan.missing, true);
			await new Promise((r) => setTimeout(r, computeTypeDelay(ask)));
			await persistAndBroadcast(io, {
				caseId,
				text: ask,
				persona,
				lang: persona.lang,
			});

			st.askedMissingAt = now;
			st.lastMissingKey = key;
			st.missingAskCount = (st.missingAskCount || 0) + 1;

			replyLock.delete(caseId);
			return;
		}

		// Create reservation (confirmation + public link in success)
		if (
			st.intentProceed &&
			plan.ready &&
			!st.booked &&
			(plan.chosen || st.collected.roomTypeHint) &&
			plan.stay
		) {
			startTyping(io, caseId, persona.name);
			const processingLine =
				persona.lang === "ar"
					? "تم—سأُكمل الحجز الآن. لحظة من فضلك."
					: persona.lang === "es"
					? "Perfecto—voy a finalizar tu reserva ahora. Un momento, por favor."
					: persona.lang === "fr"
					? "Parfait—je finalise votre réservation maintenant. Un instant, s’il vous plaît."
					: persona.lang === "ur"
					? "ٹھیک ہے—میں ابھی آپ کی بکنگ مکمل کرتا/کرتی ہوں۔ ذرا سا وقت دیں۔"
					: persona.lang === "hi"
					? "ठीक है—मैं अभी आपकी बुकिंग पूरी करता/करती हूँ। एक क्षण।"
					: "Great—I’ll finalize your reservation now. One moment, please.";
			await new Promise((r) => setTimeout(r, computeTypeDelay(processingLine)));
			await persistAndBroadcast(io, {
				caseId,
				text: processingLine,
				persona,
				lang: persona.lang,
			});

			let chosen = plan.chosen;
			if (!chosen && st.lastPricing?.results?.length)
				chosen = st.lastPricing.results.find((r) => r.ok) || null;

			const pickedRooms = [
				{
					room_type:
						(chosen && chosen.roomType) ||
						st.collected.roomTypeHint ||
						"doubleRooms",
					displayName: (chosen && chosen.displayName) || "Room",
					count: plan.roomsCount || (chosen && chosen.count) || 1,
					pricingByDay:
						(chosen && chosen.nightly) ||
						st.lastPricing?.results?.[0]?.nightly ||
						[],
				},
			];

			const result = await createReservationViaEndpointOrLocal({
				personaName: persona.name,
				hotel: plan.hotel,
				caseId,
				guest: plan.guest,
				stay: plan.stay,
				pickedRooms,
			});

			st.booked = !!result?.ok;
			st.lastConfirmation = safeConfirmValue(result?.confirmation)
				? result.confirmation
				: st.lastConfirmation || "";
			st.publicLink = result?.publicLink || st.publicLink || null;
			st.paymentLink = result?.paymentLink || st.paymentLink || null;

			startTyping(io, caseId, persona.name);
			let confirmText = "";
			if (result?.ok) {
				const lines = [];
				if (persona.lang === "ar") {
					lines.push("تم تأكيد الحجز ✅");
					if (st.lastConfirmation)
						lines.push(`رقم التأكيد: ${st.lastConfirmation}`);
					if (st.publicLink) lines.push(`رابط الحجز: ${st.publicLink}`);
					lines.push("هل أستطيع مساعدتك في شيء آخر؟");
					confirmText = lines.join("\n");
				} else if (persona.lang === "es") {
					lines.push("¡Reserva confirmada! ✅");
					if (st.lastConfirmation)
						lines.push(`Número de confirmación: ${st.lastConfirmation}`);
					if (st.publicLink) lines.push(`Tu reserva: ${st.publicLink}`);
					lines.push("¿Puedo ayudarte con algo más?");
					confirmText = lines.join("\n");
				} else if (persona.lang === "fr") {
					lines.push("Réservation confirmée ✅");
					if (st.lastConfirmation)
						lines.push(`Numéro de confirmation : ${st.lastConfirmation}`);
					if (st.publicLink) lines.push(`Votre réservation : ${st.publicLink}`);
					lines.push("Puis‑je vous aider avec autre chose ?");
					confirmText = lines.join("\n");
				} else if (persona.lang === "ur") {
					lines.push("بکنگ کنفرم ہو گئی ✅");
					if (st.lastConfirmation)
						lines.push(`کنفرمیشن نمبر: ${st.lastConfirmation}`);
					if (st.publicLink) lines.push(`آپ کی بکنگ: ${st.publicLink}`);
					lines.push("کیا کسی اور چیز میں مدد کر سکتا/سکتی ہوں؟");
					confirmText = lines.join("\n");
				} else if (persona.lang === "hi") {
					lines.push("आरक्षण की पुष्टि हो गई ✅");
					if (st.lastConfirmation)
						lines.push(`कन्फर्मेशन नंबर: ${st.lastConfirmation}`);
					if (st.publicLink) lines.push(`आपका आरक्षण: ${st.publicLink}`);
					lines.push("क्या और किसी चीज़ में मदद करूँ?");
					confirmText = lines.join("\n");
				} else {
					lines.push("Reservation confirmed! ✅");
					if (st.lastConfirmation)
						lines.push(`Confirmation number: ${st.lastConfirmation}`);
					if (st.publicLink) lines.push(`Your reservation: ${st.publicLink}`);
					lines.push("Is there anything else I can help you with?");
					confirmText = lines.join("\n");
				}
			} else {
				const err =
					result?.error || "Something went wrong finalizing the booking.";
				confirmText =
					persona.lang === "ar"
						? `عذرًا—حدث خطأ أثناء إكمال الحجز: ${err}`
						: persona.lang === "es"
						? `Perdona—hubo un problema al finalizar la reserva: ${err}`
						: persona.lang === "fr"
						? `Désolé—un problème est survenu : ${err}`
						: persona.lang === "ur"
						? `معذرت—بکنگ مکمل کرتے وقت مسئلہ پیش آیا: ${err}`
						: persona.lang === "hi"
						? `क्षमा करें—बुकिंग पूरी करते समय समस्या आई: ${err}`
						: `Sorry—there was an issue finalizing your booking: ${err}`;
			}
			await new Promise((r) => setTimeout(r, computeTypeDelay(confirmText)));
			await persistAndBroadcast(io, {
				caseId,
				text: confirmText,
				persona,
				lang: persona.lang,
			});
			replyLock.delete(caseId);
			return;
		}

		/* ---------- Fallback to model with guardrails ---------- */
		startTyping(io, caseId, persona.name);

		let extraPolicy = "";
		if (inquiryAbout === "reserve_room" || inquiryAbout === "reserve_bed") {
			extraPolicy +=
				"This is a new reservation. Start by asking for dates and preferred room type; do not suggest cancel/edit unless guest asks.";
		}
		if (st.reservationCache?.confirmation) {
			extraPolicy +=
				(extraPolicy ? "\n" : "") +
				`We already have reservation ${st.reservationCache.confirmation}. If guest asks to cancel/change/add, use it directly. Do not ask for new-booking fields.`;
		}
		extraPolicy +=
			"\nNever claim a cancellation or booking is complete unless the tool call returned ok==true.";

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
			lowerIncludesAny(payload?.message || "", STRONG_BOOK_INTENT);
		const confirmedCancel =
			(askedToCancel && isAffirmative(payload?.message || "")) ||
			lowerIncludesAny(payload?.message || "", [
				"cancel it",
				"cancel the booking",
			]);

		const { text: rawText } = await generateReply(client, {
			caseDoc,
			persona,
			currentMessage: payload,
			model: MODEL,
			confirmedProceed,
			confirmedCancel,
			systemAppend: extraPolicy,
		});
		let text = rawText || "";
		if (!text) {
			text =
				persona.lang === "ar"
					? "هل تفضل حجزًا جديدًا أم لديك حجز تريد تعديله؟"
					: persona.lang === "es"
					? "¿Prefieres una nueva reserva o modificar una existente?"
					: persona.lang === "fr"
					? "Souhaitez‑vous une nouvelle réservation ou modifier une existante ?"
					: persona.lang === "ur"
					? "نئی بکنگ کریں یا موجودہ میں ترمیم؟"
					: persona.lang === "hi"
					? "नई बुकिंग करें या मौजूदा में बदलाव?"
					: "Would you like a new booking or to edit an existing one?";
		}
		if (lowerIncludesAny(payload?.message || "", WAITING_SIGNALS)) {
			if (persona.lang === "ar") text = `شكرًا لصبرك — ${text}`;
			else if (persona.lang === "es")
				text = `Gracias por tu paciencia — ${text}`;
			else if (persona.lang === "fr")
				text = `Merci pour votre patience — ${text}`;
			else if (persona.lang === "ur") text = `آپ کے صبر کا شکریہ — ${text}`;
			else if (persona.lang === "hi")
				text = `आपके धैर्य के लिए धन्यवाद — ${text}`;
			else text = `Thanks for your patience — ${text}`;
		}
		text = stripRedundantOpeners(text, caseDoc.conversation || []);

		await new Promise((r) => setTimeout(r, computeTypeDelay(text)));
		await persistAndBroadcast(io, {
			caseId,
			text,
			persona,
			lang: persona.lang,
		});
		replyLock.delete(caseId);
	} catch (e) {
		console.error("[AI] processCase error:", e?.message || e);
		replyLock.delete(caseId);
	}
}

/* ---------- Sockets / init ---------- */
function initAIAgent({ app, io }) {
	if (!looksLikeOpenAIKey(RAW_KEY)) {
		console.error(
			"[AI] OPENAI_API_KEY missing/invalid (must start with 'sk-')."
		);
		return;
	}
	const client = new OpenAI({ apiKey: RAW_KEY });
	const MODEL = sanitizeModelName(RAW_MODEL) || "gpt-4.1";

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
				armIdleClose(
					io,
					String(data.caseId),
					personaByCase.get(String(data.caseId))?.name || "system"
				);
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
			armIdleClose(io, caseId, existingPersona?.name || "system");

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
		"[AI] Ready (v3.5): warm‑up greeting, case‑aware second line, robust inquiry parsing, single‑confirm booking/cancel/update, re‑pricing, and confirmation+link on success."
	);
}

/* ---------- Rebuilders & misc ---------- */
function rebuildStateFromConversation(caseDoc) {
	const convo = Array.isArray(caseDoc?.conversation)
		? caseDoc.conversation
		: [];
	const acc = {
		collected: {
			name: knownIdentityFromCase(caseDoc).name || "",
			email: knownIdentityFromCase(caseDoc).email || "",
			phone: knownIdentityFromCase(caseDoc).phone || "",
			nationality: "",
			adults: undefined,
			children: undefined,
			roomsCount: undefined,
			roomTypeHint: undefined,
		},
		intendedStay: undefined,
	};
	for (const msg of convo) {
		if (
			isAssistantLike(
				msg?.messageBy?.customerName,
				msg?.messageBy?.customerEmail
			)
		)
			continue;
		const text = String(msg?.message || "");
		const dates = parseDateTokens(text);
		if (dates?.check_in_date && dates?.check_out_date) {
			acc.intendedStay = {
				check_in_date: dates.check_in_date,
				check_out_date: dates.check_out_date,
			};
		}
		const ac = parseAdultsChildren(text);
		if (ac.adults != null) acc.collected.adults = ac.adults;
		if (ac.children != null) acc.collected.children = ac.children;
		const rc = parseRoomsCount(text);
		if (rc != null) acc.collected.roomsCount = rc;
		const rh = parseRoomPreference(text);
		if (rh) acc.collected.roomTypeHint = rh;
		const ph = parsePhone(text);
		if (ph && isLikelyPhone(ph)) acc.collected.phone = ph;
		const em = parseEmail(text);
		if (em) acc.collected.email = em;
		const nm = parseName(text);
		if (nm) acc.collected.name = nm;
		const nat = parseNationality(text);
		if (nat) acc.collected.nationality = nat;
	}
	return acc;
}

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

async function lookupHotelAndPrice({
	hotelIdOrName,
	checkIn,
	checkOut,
	rooms,
}) {
	let hotel = null;
	if (hotelIdOrName && isValidObjectId(String(hotelIdOrName)))
		hotel = await HotelDetails.findById(hotelIdOrName).lean();
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

	for (const req of rooms || []) {
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

module.exports = { initAIAgent };
