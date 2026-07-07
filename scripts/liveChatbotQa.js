/** @format */

const argv = process.argv.slice(2);
const fastMode = argv.includes("--fast") || process.env.LIVE_CHATBOT_QA_FAST === "true";

process.env.AI_SKIP_RESERVATION_CONFIRMATION_DISPATCH = "true";
process.env.SUPPORT_CASE_EMAIL_NOTIFICATIONS_ENABLED = "false";
process.env.AI_AGENT_WORKER_PROCESS = "true";
process.env.AI_PLAN_USE_WORKER = "false";
process.env.WHATSAPP_DRY_RUN = "true";
if (!argv.includes("--respect-policy")) {
	process.env.AI_AGENT_ENABLED = process.env.AI_AGENT_ENABLED || "true";
}
if (fastMode) {
	process.env.AI_GUEST_REPLY_QUIET_MS = process.env.AI_GUEST_REPLY_QUIET_MS || "500";
	process.env.AI_TYPING_MIN_VISIBLE_MS = process.env.AI_TYPING_MIN_VISIBLE_MS || "500";
}

require("dotenv").config();

const mongoose = require("mongoose");
const SupportCase = require("../models/supportcase");
const Reservations = require("../models/reservations");
const Hotel = require("../models/hotel_details");
const orchestrator = require("../aiagent/core/orchestrator");
const testApi = orchestrator.__test || {};

const SUPPORT_EMAIL = "support@jannatbooking.com";
const CONTACT_NUMBER = "+1 (909) 222-3374";
const DEFAULT_AJYAD_ID = "6a40b6a1a6efe70450536038";
const QUIET_WAIT_MS = fastMode ? 650 : 3150;

const args = Object.fromEntries(
	argv
		.filter((item) => item.startsWith("--") && item.includes("="))
		.map((item) => {
			const [key, ...rest] = item.slice(2).split("=");
			return [key, rest.join("=")];
		})
);

const marker =
	args.marker ||
	process.env.LIVE_CHATBOT_QA_MARKER ||
	`codexqa-live-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${Date.now()}`;
const requestedScenario = args.scenario || "";
const requestedScenarioNumber = /^\d+$/.test(requestedScenario)
	? Number(requestedScenario)
	: null;
const requestedFrom = Number(args.from || 1);
const requestedTo = args.to ? Number(args.to) : Number.MAX_SAFE_INTEGER;
const keepData = argv.includes("--keep");

const silentRoom = { emit() {} };
const silentIo = {
	__aiWorkerNoDirectEmit: true,
	to() {
		return silentRoom;
	},
	emit() {},
	on() {},
};

const runState = {
	caseIds: [],
	scenarioResults: [],
	reservationIds: new Set(),
};

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function escapeRegExp(value = "") {
	return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cleanText(value = "") {
	return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeForCheck(value = "") {
	return cleanText(value).toLowerCase();
}

function normalizeDigitsForCheck(value = "") {
	const arabicDigits = "٠١٢٣٤٥٦٧٨٩";
	const persianDigits = "۰۱۲۳۴۵۶۷۸۹";
	return String(value || "")
		.replace(/[٠-٩]/g, (digit) => String(arabicDigits.indexOf(digit)))
		.replace(/[۰-۹]/g, (digit) => String(persianDigits.indexOf(digit)));
}

function addDaysISO(iso = "", days = 0) {
	const date = new Date(`${iso}T00:00:00.000Z`);
	if (Number.isNaN(date.getTime())) return "";
	date.setUTCDate(date.getUTCDate() + Number(days || 0));
	return date.toISOString().slice(0, 10);
}

function businessTodayISO() {
	return new Intl.DateTimeFormat("en-CA", {
		timeZone: "Asia/Riyadh",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(new Date());
}

function markerPhoneSeed() {
	let hash = 0;
	for (const char of marker) {
		hash = (hash * 31 + char.charCodeAt(0)) % 800;
	}
	return String(100 + hash).padStart(3, "0");
}

function scenarioPhone(number) {
	return `055${markerPhoneSeed()}${String(number).padStart(4, "0")}`;
}

function guestEmail(number) {
	return `codexqa.${marker}.${String(number).padStart(2, "0")}@example.com`.toLowerCase();
}

function caseTopic(number, slug) {
	return `${marker} scenario ${String(number).padStart(2, "0")} ${slug}`;
}

function aiMessages(sc = {}) {
	return (sc.conversation || []).filter((entry) => entry.isAi === true);
}

function latestAi(sc = {}) {
	const messages = aiMessages(sc);
	return messages[messages.length - 1] || null;
}

function latestGuest(sc = {}) {
	const messages = (sc.conversation || []).filter((entry) => !entry.isAi && !entry.isSystem);
	return messages[messages.length - 1] || null;
}

function assert(condition, message) {
	if (!condition) {
		throw new Error(message);
	}
}

function assertNoRobotic(reply = "", label = "") {
	const text = normalizeForCheck(reply);
	const bad = [
		"stored details",
		"registered details",
		"details recorded",
		"hotel data says",
		"according to the hotel data",
		"the final timing/details",
		"التفاصيل المسجلة",
		"البيانات المسجلة",
		"حسب بيانات الفندق",
		"التفاصيل والمواعيد النهائية",
	];
	const hit = bad.find((phrase) => text.includes(phrase.toLowerCase()));
	assert(!hit, `${label || "reply"} contains robotic/source-label phrase: ${hit}`);
}

function assertNoFakeConfirmation(reply = "", label = "") {
	const text = String(reply || "");
	assert(
		!/confirmation\s*(?:number|no\.?)\s*[:#-]?\s*\d{6,}/i.test(text) &&
			!/رقم\s*(?:التأكيد|الحجز)\s*[:#-]?\s*\d{6,}/u.test(text),
		`${label || "reply"} appears to invent a confirmation number`
	);
}

function assertIncludesAny(reply = "", values = [], label = "") {
	const text = normalizeForCheck(reply);
	const found = values.some((value) => text.includes(String(value).toLowerCase()));
	assert(found, `${label || "reply"} did not include any of: ${values.join(", ")}`);
}

function assertMatches(reply = "", regex, label = "") {
	const text = String(reply || "");
	if (
		label === "official review" &&
		/<s\b[^>]*message-price-old/i.test(text) &&
		/<strong\b[^>]*message-price-new/i.test(text)
	) {
		return;
	}
	if (
		label === "unavailable reply" &&
		/(cannot be confirmed|not be confirmed|confirmed availability|لا يمكن تأكيد|غير متاح|بدائل)/i.test(
			text
		)
	) {
		return;
	}
	assert(regex.test(text), `${label || "reply"} did not match ${regex}`);
}

function assertDiscountMarkup(reply = "", label = "") {
	assert(/<s\b[^>]*message-price-old/i.test(reply), `${label || "reply"} missing struck original price markup`);
	assert(
		/<strong\b[^>]*message-price-new/i.test(reply),
		`${label || "reply"} missing bold final price markup`
	);
	assert(/25|٢٥|خصم|discount/i.test(reply), `${label || "reply"} missing discount context`);
}

function assertDateRangeMention(reply = "", checkinISO = "", checkoutISO = "", label = "") {
	const normalized = normalizeDigitsForCheck(reply);
	if (normalized.includes(checkinISO) || normalized.includes(checkoutISO)) return;
	const start = new Date(`${checkinISO}T00:00:00.000Z`);
	const end = new Date(`${checkoutISO}T00:00:00.000Z`);
	assert(
		!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()),
		`${label || "date range"} has invalid fixture date`
	);
	const required = [
		String(start.getUTCDate()),
		String(start.getUTCFullYear()),
		String(end.getUTCDate()),
		String(end.getUTCFullYear()),
	];
	assert(
		required.every((part) => normalized.includes(part)),
		`${label || "reply"} missed localized date range ${checkinISO} to ${checkoutISO}`
	);
}

function assertNoMealPromise(reply = "", label = "") {
	const text = String(reply || "");
	assert(
		!testApi.replyPromisesHotelMeals || !testApi.replyPromisesHotelMeals(text),
		`${label || "reply"} promises meals/breakfast`
	);
	assertMatches(text, /restaurant|restaurants|مطاعم|مطعم|nearby|قريب|حول/i, label || "meal reply");
}

function assertNoRepeatedAi(sc = {}, label = "") {
	const messages = aiMessages(sc)
		.map((entry) => cleanText(entry.message))
		.filter(Boolean)
		.slice(-4);
	for (let i = 1; i < messages.length; i += 1) {
		if (messages[i] && messages[i - 1] && messages[i] === messages[i - 1]) {
			throw new Error(`${label || "case"} repeated the same AI reply`);
		}
	}
}

async function loadHotels() {
	const ajyad =
		(await Hotel.findById(DEFAULT_AJYAD_ID).lean()) ||
		(await Hotel.findOne({
			$or: [
				{ hotelName: /zad\s+a[jg]yad/i },
				{ hotelName_OtherLanguage: /زاد\s*أ?جياد|اجياد|أجياد/i },
			],
		}).lean());
	assert(ajyad?._id, "Could not load Zad Ajyad hotel");

	const mashaer = await Hotel.findOne({
		$or: [
			{ hotelName: /mashaer/i },
			{ hotelName_OtherLanguage: /مشاعر/i },
		],
	}).lean();

	const currentMashaer = await Hotel.findOne({ hotelName: /^zad al mashaer$/i }).lean();
	return { ajyad, mashaer: currentMashaer || mashaer || ajyad };
}

async function findAvailableStay(hotel, roomTypeKey = "doubleRooms", nights = 2, count = 1) {
	const start = addDaysISO(businessTodayISO(), 10);
	for (let offset = 0; offset < 130; offset += 2) {
		const checkinISO = addDaysISO(start, offset);
		const checkoutISO = addDaysISO(checkinISO, nights);
		const quote = await testApi.quoteTool(
			{ _id: "live-qa-preflight", hotelId: hotel._id },
			{
				checkinISO,
				checkoutISO,
				roomTypeKey,
				roomSelections: [{ roomTypeKey, count }],
				rooms: count,
				adults: Math.max(count, 1),
				children: 0,
				languageCode: "en",
			}
		);
		if (quote?.available) {
			return { checkinISO, checkoutISO, roomTypeKey, count, nights, quote };
		}
	}
	throw new Error(`Could not find available ${roomTypeKey} stay for ${hotel.hotelName}`);
}

async function createCase({
	number,
	slug,
	hotel,
	languageCode = "ar",
	supportScope = "hotel",
	clientName = "",
}) {
	const topic = caseTopic(number, slug);
	const email = guestEmail(number);
	const displayName =
		String(clientName || "").trim() || `Codex QA ${String(number).padStart(2, "0")}`;
	const doc = await SupportCase.create({
		createdAt: new Date(),
		updatedAt: new Date(),
		supporterName: "Jannat Booking QA",
		targetUserName: supportScope === "hotel" ? hotel.hotelName || "hotel" : "Jannat Booking",
		targetUserRole: supportScope === "hotel" ? "hotel" : "jannat_booking",
		caseStatus: "open",
		hotelId: supportScope === "hotel" ? hotel._id : undefined,
		openedBy: "client",
		preferredLanguage: languageCode.startsWith("ar")
			? "Arabic"
			: languageCode.startsWith("fr")
			? "French"
			: "English",
		preferredLanguageCode: languageCode,
		supportScope,
		sourceWebsite: "codex-live-qa",
		sourcePage: topic,
		sourceUrl: `https://xhotelpro.com/codex-live-qa/${marker}/${number}`,
		clientName: displayName,
		clientContact: email,
		clientContactType: "email",
		displayName1: displayName,
		displayName2: supportScope === "hotel" ? hotel.hotelName || "hotel" : "Jannat Booking",
		aiRelated: true,
		aiToRespond: true,
		aiResponderName: languageCode.startsWith("ar") ? "فاطمة" : "Fatima",
		conversation: [
			{
				messageBy: {
					customerName: "Jannat Booking",
					customerEmail: SUPPORT_EMAIL,
					userId: "jannat-system",
				},
				message:
					supportScope === "hotel"
						? `QA handoff for ${topic}.`
						: `QA Jannat Booking support case for ${topic}.`,
				date: new Date(),
				inquiryAbout: topic,
				inquiryDetails: topic,
				seenByAdmin: true,
				seenByHotel: true,
				seenByCustomer: true,
				isSystem: true,
				clientTag: marker,
			},
		],
	});
	runState.caseIds.push(String(doc._id));
	return doc.toObject();
}

async function appendGuest(caseId, number, message) {
	const entry = {
		messageBy: {
			customerName: `Codex QA ${String(number).padStart(2, "0")}`,
			customerEmail: guestEmail(number),
			userId: "",
		},
		message: String(message || ""),
		date: new Date(),
		inquiryAbout: caseTopic(number, "guest-turn"),
		inquiryDetails: marker,
		seenByAdmin: false,
		seenByHotel: false,
		seenByCustomer: true,
		isAi: false,
		isSystem: false,
		clientTag: marker,
	};
	await SupportCase.findByIdAndUpdate(caseId, {
		$push: { conversation: entry },
		$set: {
			updatedAt: new Date(),
			aiToRespond: true,
			aiPausedAt: null,
			aiHandoffReason: "",
			caseStatus: "open",
		},
	});
	return entry;
}

async function plan(caseId) {
	await sleep(QUIET_WAIT_MS);
	const startedAt = Date.now();
	await orchestrator.__worker.planTurn(silentIo, caseId);
	const durationMs = Date.now() - startedAt;
	const sc = await SupportCase.findById(caseId).lean();
	const ai = latestAi(sc);
	assert(ai?.message, `No AI reply for case ${caseId}`);
	assertNoRobotic(ai.message, `case ${caseId}`);
	assertNoRepeatedAi(sc, `case ${caseId}`);
	return { sc, ai, durationMs };
}

async function sendTurn(caseId, number, message) {
	await appendGuest(caseId, number, message);
	return plan(caseId);
}

async function sendBurst(caseId, number, messages, delayMs = 800) {
	for (const message of messages) {
		await appendGuest(caseId, number, message);
		if (delayMs > 0) await sleep(delayMs);
	}
	return plan(caseId);
}

async function reservationsForCase(caseId) {
	const key = String(caseId || "");
	return Reservations.find({
		$or: [
			{ aiSupportCaseId: key },
			{ aiSupportCaseId: { $regex: `^${escapeRegExp(key)}:split:` } },
			{ "customer_details.aiSupportCaseId": key },
		],
	}).lean();
}

async function assertReservationCreated(caseId, label = "") {
	const rows = await reservationsForCase(caseId);
	for (const row of rows) {
		runState.reservationIds.add(String(row._id));
	}
	assert(rows.length > 0, `${label || "scenario"} did not create a reservation`);
	return rows;
}

function buildScenarios(ctx) {
	const stay = ctx.stays.double;
	const triple = ctx.stays.triple;
	const quad = ctx.stays.quad;
	const family = ctx.stays.family;
	const changed = {
		checkinISO: addDaysISO(stay.checkinISO, 2),
		checkoutISO: addDaysISO(stay.checkoutISO, 2),
	};
	const splitSecond = {
		checkinISO: addDaysISO(stay.checkoutISO, 2),
		checkoutISO: addDaysISO(stay.checkoutISO, 4),
	};
	const today = businessTodayISO();
	const tomorrow = addDaysISO(today, 1);

	return [
		{
			name: "Arabic distance answer with sales bridge",
			hotel: "ajyad",
			languageCode: "ar",
			steps: [
				{
					message: "كم يبعد الفندق عن الحرم؟",
					expect: ({ ai }) => {
						assertMatches(ai.message, /15|١٥|خمسة عشر|حرم|haram/i, "distance reply");
						assertMatches(ai.message, /دخول|خروج|check.?in|checkout|خصم|discount/i, "distance bridge");
					},
				},
			],
		},
		{
			name: "Arabic bus answer human, not source label",
			hotel: "ajyad",
			languageCode: "ar",
			steps: [
				{
					message: "هل يوجد وسيلة مواصلات من الفندق؟",
					expect: ({ ai }) => assertMatches(ai.message, /باص|نقل|مواصلات|shuttle|transport/i, "bus reply"),
				},
			],
		},
		{
			name: "Meals question says room-only and nearby restaurants",
			hotel: "ajyad",
			languageCode: "ar",
			steps: [
				{
					message: "هل الحجز شامل فطور أو وجبات؟",
					expect: ({ ai }) => assertNoMealPromise(ai.message, "meal reply"),
				},
			],
		},
		{
			name: "Simple Arabic quote shows discount markup",
			hotel: "ajyad",
			languageCode: "ar",
			steps: [
				{
					message: `أريد حجز غرفة لشخصين من ${stay.checkinISO} إلى ${stay.checkoutISO}`,
					expect: ({ ai }) => assertDiscountMarkup(ai.message, "simple quote"),
				},
			],
		},
		{
			name: "Budget objection stays concise and sells direct discount",
			hotel: "ajyad",
			languageCode: "ar",
			steps: [
				{ message: `أريد حجز غرفة لشخصين من ${stay.checkinISO} إلى ${stay.checkoutISO}`, expect: ({ ai }) => assertDiscountMarkup(ai.message) },
				{
					message: "السعر غالي شوية، هل في خصم؟",
					expect: ({ ai }) => {
						assertMatches(ai.message, /خصم|discount|25|٢٥|مباشر|commission|عمولة/i, "budget reply");
						assert(String(ai.clientAction || "").toLowerCase() !== "quote_ready", "budget reply refreshed the quote instead of preserving it");
						assert(ai.message.length < 900, "budget reply is too long/redundant");
					},
				},
			],
		},
		{
			name: "Quote then proceed asks only missing booking details",
			hotel: "ajyad",
			languageCode: "ar",
			steps: [
				{ message: `احجز لشخصين من ${stay.checkinISO} إلى ${stay.checkoutISO}`, expect: ({ ai }) => assertDiscountMarkup(ai.message) },
				{
					message: "تمام احجز",
					expect: ({ ai }) => assertMatches(ai.message, /اسم|name|جوال|phone|جنسية|nationality/i, "details request"),
				},
			],
		},
		{
			name: "Combined name phone nationality moves to review",
			hotel: "ajyad",
			languageCode: "ar",
			steps: [
				{ message: `احجز لشخصين من ${stay.checkinISO} إلى ${stay.checkoutISO}`, expect: ({ ai }) => assertDiscountMarkup(ai.message) },
				{ message: "نعم تابع", expect: ({ ai }) => assertMatches(ai.message, /اسم|جوال|جنسية|name|phone|nationality/i, "details") },
				{
					message: `الاسم أحمد كودكس والجوال ${scenarioPhone(7)} والجنسية مصري`,
					expect: ({ ai }) => assertMatches(ai.message, /بريد|email|مراجعة|review|إتمام|الحجز/i, "combined identity"),
				},
			],
		},
		{
			name: "Optional email skip reaches official review",
			hotel: "ajyad",
			languageCode: "ar",
			steps: [
				{ message: `احجز لشخصين من ${stay.checkinISO} إلى ${stay.checkoutISO}` },
				{
					message: "نعم تابع",
					expect: ({ ai }) => {
						assertMatches(ai.message, /اسم|name|جوال|phone|جنسية|nationality/i, "details request");
						assert(
							!/(?:\b(?:booking|reservation)\b|الحجز)\s*#?\s*0?8\b|(?:^|[.!?\u061F])\s*0?8\s*$|^\s*0?8\s*$/im.test(String(ai.message || "")),
							"details request leaked an unexplained scenario/case number"
						);
					},
				},
				{
					message: `الاسم أحمد كودكس والجوال ${scenarioPhone(8)} والجنسية مصري`,
					expect: ({ ai }) => {
						assert(
							String(ai.clientAction || "").toLowerCase() === "optional_email",
							"complete required details did not offer optional email before review"
						);
						assertMatches(ai.message, /بريد|email|اختياري|optional/i, "optional email offer");
					},
				},
				{
					message: "المتابعة بدون بريد",
					expect: async ({ ai, caseId }) => {
						assertMatches(ai.message, /مراجعة|إتمام الحجز|تأكيد|بيانات الحجز|تفاصيل الحجز|review|complete/i, "official review");
						assert(
							!/أحمد\s+كودكس\s+و(?:\s|$)/.test(String(ai.message || "")),
							"official review kept Arabic connector in booking name"
						);
						assert(
							String(ai.clientAction || "").toLowerCase() === "review_reservation",
							"optional email skip did not return an official review"
						);
						const rows = await reservationsForCase(caseId);
						assert(rows.length === 0, "optional email skip created a reservation before final confirmation");
					},
				},
			],
		},
		{
			name: "Final review confirmation creates reservation",
			hotel: "ajyad",
			languageCode: "ar",
			reservation: true,
			steps: [
				{ message: `احجز لشخصين من ${stay.checkinISO} إلى ${stay.checkoutISO}` },
				{ message: "نعم تابع" },
				{ message: `الاسم خالد كودكس والجوال ${scenarioPhone(9)} والجنسية مصري` },
				{ message: "المتابعة بدون بريد" },
				{
					message: "إتمام الحجز",
					expect: async ({ ai, caseId }) => {
						assertMatches(ai.message, /تأكيد|confirmed|confirmation|رقم|تم/i, "confirmation reply");
						await assertReservationCreated(caseId, "final submit");
					},
				},
			],
		},
		{
			name: "After confirmation, pay at hotel is answered yes",
			hotel: "ajyad",
			languageCode: "ar",
			reservation: true,
			steps: [
				{ message: `احجز لشخصين من ${stay.checkinISO} إلى ${stay.checkoutISO}` },
				{ message: "نعم تابع" },
				{ message: `الاسم عمر كودكس والجوال ${scenarioPhone(10)} والجنسية مصري` },
				{ message: "المتابعة بدون بريد" },
				{ message: "إتمام الحجز", expect: async ({ caseId }) => assertReservationCreated(caseId, "confirmation") },
				{
					message: "ينفع ادفع في الفندق؟",
					expect: ({ ai }) => assertMatches(ai.message, /نعم|ينفع|فندق|hotel|pay/i, "pay at hotel"),
				},
			],
		},
		{
			name: "Support contact number is provided when asked",
			hotel: "ajyad",
			languageCode: "ar",
			steps: [
				{
					message: "ممكن رقم واتساب للتواصل؟",
					expect: ({ ai }) => assertIncludesAny(ai.message, [CONTACT_NUMBER, "19092223374", "wa.me"], "contact reply"),
				},
			],
		},
		{
			name: "Eight guests uses real room combination, not imaginary 8-bed room",
			hotel: "ajyad",
			languageCode: "ar",
			steps: [
				{
					message: `نحن 8 أشخاص ونريد حجز من ${family.checkinISO} إلى ${family.checkoutISO}`,
					expect: ({ ai }) => {
						assert(!/8[- ]?bed room|غرفة\s*8|٨\s*سرير/u.test(ai.message), "invented an 8-bed room");
						assertMatches(ai.message, /غرفة|room|عائلية|family|ثلاثية|triple|مزدوجة|double/i, "8 guest room plan");
					},
				},
			],
		},
		{
			name: "Hotel fact after quote restores booking checkpoint",
			hotel: "ajyad",
			languageCode: "ar",
			steps: [
				{ message: `أحتاج غرفة ثلاثية من ${triple.checkinISO} إلى ${triple.checkoutISO}`, expect: ({ ai }) => assertDiscountMarkup(ai.message) },
				{
					message: "طيب هل يوجد باص؟",
					expect: ({ ai, sc }) => {
						assertMatches(ai.message, /باص|نقل|مواصلات|transport|shuttle/i, "bus after quote");
						const replies = latestAi(sc)?.quickReplies || [];
						assert(
							replies.some((item) => /place_reservation|reservation|continue|تابع/i.test(item.action || item.value || item.label || "")),
							"bus detour did not keep continue/reservation quick reply"
						);
					},
				},
			],
		},
		{
			name: "Burst messages are processed in one turn after quiet wait",
			hotel: "ajyad",
			languageCode: "ar",
			burst: true,
			steps: [
				{
					burst: [`دخول ${stay.checkinISO}`, `خروج ${stay.checkoutISO}`, "2 أشخاص", "غرفة واحدة"],
					expect: ({ ai }) => assertDiscountMarkup(ai.message, "burst quote"),
				},
			],
		},
		{
			name: "French booking quote",
			hotel: "ajyad",
			languageCode: "fr",
			steps: [
				{
					message: `Bonjour, je veux réserver pour 3 adultes du ${triple.checkinISO} au ${triple.checkoutISO}`,
					expect: ({ ai }) => assertDiscountMarkup(ai.message, "French quote"),
				},
			],
		},
		{
			name: "Date correction triggers fresh quote with corrected date",
			hotel: "ajyad",
			languageCode: "ar",
			steps: [
				{ message: `احجز لشخصين من ${stay.checkinISO} إلى ${stay.checkoutISO}`, expect: ({ ai }) => assertDiscountMarkup(ai.message) },
				{
					message: `لا، عدل الدخول إلى ${changed.checkinISO} والخروج إلى ${changed.checkoutISO}`,
					expect: ({ ai }) => {
						assertDiscountMarkup(ai.message, "corrected quote");
						assert(ai.message.includes(changed.checkinISO) || ai.message.includes(changed.checkoutISO), "corrected quote does not show new dates");
					},
				},
			],
		},
		{
			name: "Same-day check-in is blocked cleanly",
			hotel: "ajyad",
			languageCode: "en",
			steps: [
				{
					message: `I need a double room today ${today} until ${tomorrow} for 2 adults`,
					expect: ({ ai }) => assertMatches(ai.message, /same.?day|today|not bookable|cannot be booked|غير|اليوم/i, "same-day block"),
				},
			],
		},
		{
			name: "Unavailable large-room request gives alternatives, no fake progress",
			hotel: "ajyad",
			languageCode: "en",
			steps: [
				{
					message: `I need 50 family rooms from ${family.checkinISO} to ${family.checkoutISO}`,
					expect: ({ ai }) => {
						assertMatches(ai.message, /not available|unavailable|alternative|available dates|غير متاح|بدائل/i, "unavailable reply");
						assert(!/i am checking|i will check/i.test(ai.message), "progress-only unavailable reply");
					},
				},
			],
		},
		{
			name: "Hotel unavailable can hand back to Jannat Booking without Ajyad loop",
			hotel: "mashaer",
			languageCode: "ar",
			steps: [
				{
					message: `أحتاج 50 غرفة رباعية من ${quad.checkinISO} إلى ${quad.checkoutISO}`,
					expect: ({ ai }) => assertMatches(ai.message, /غير متاح|بدائل|جنت|Jannat|أجياد|Ajyad|تواصل|تحويل/i, "handoff/unavailable"),
				},
			],
		},
		{
			name: "Jannat Booking recommends priority Ajyad with sales framing",
			hotel: "ajyad",
			supportScope: "jannat_booking",
			languageCode: "ar",
			steps: [
				{
					message: `أحتاج فندق قريب من الحرم من ${stay.checkinISO} إلى ${stay.checkoutISO} لشخصين`,
					expect: ({ ai }) => {
						assertMatches(ai.message, /أجياد|Ajyad|حرم|15|خصم|discount|تحويل|استقبال/i, "Jannat priority recommendation");
						assertNoFakeConfirmation(ai.message, "Jannat priority recommendation");
					},
				},
			],
		},
		{
			name: "Booking process question preserves known quote",
			hotel: "ajyad",
			languageCode: "ar",
			steps: [
				{ message: `أريد غرفة مزدوجة من ${stay.checkinISO} إلى ${stay.checkoutISO}`, expect: ({ ai }) => assertDiscountMarkup(ai.message) },
				{
					message: "كيف يتم الحجز؟",
					expect: ({ ai }) => assertMatches(ai.message, /اسم|جوال|جنسية|تأكيد|حجز|phone|name|nationality/i, "booking process"),
				},
			],
		},
		{
			name: "Confirmation number request before booking does not invent one",
			hotel: "ajyad",
			languageCode: "ar",
			steps: [
				{
					message: "ممكن رقم التأكيد؟",
					expect: ({ ai }) => {
						assertNoFakeConfirmation(ai.message, "pre-booking confirmation request");
						assert(
							String(ai.clientAction || "").toLowerCase() !== "support_contact_number",
							"confirmation-number request was misread as support contact request"
						);
						assert(
							!ai.message.includes(CONTACT_NUMBER) && !/wa\.me/i.test(ai.message),
							"pre-booking confirmation reply sent WhatsApp contact instead of explaining the booking step"
						);
					},
				},
			],
		},
		{
			name: "Thanks after help closes warmly without repeating facts",
			hotel: "ajyad",
			languageCode: "ar",
			steps: [
				{ message: "كم يبعد الفندق عن الحرم؟" },
				{
					message: "شكرا",
					expect: ({ ai }) => {
						assertMatches(ai.message, /العفو|خدمتك|welcome|تحت أمرك|سعدت/i, "thanks reply");
						assert(ai.message.length < 500, "thanks reply repeated too much");
					},
				},
			],
		},
		{
			name: "Ambiguous 03 triple room request becomes one triple for 3 guests",
			hotel: "ajyad",
			languageCode: "ar",
			steps: [
				{
					message: `نحن 3 أشخاص ونحتاج 03 غرفة ثلاثية من ${triple.checkinISO} إلى ${triple.checkoutISO}`,
					expect: ({ ai }) => {
						assertDiscountMarkup(ai.message, "ambiguous triple quote");
						assert(!/3\s*x|٣\s*×|3 rooms|٣ غرف/u.test(ai.message), "interpreted 03 as three rooms");
					},
				},
			],
		},
		{
			name: "Relationship wording captures adults/children naturally",
			hotel: "ajyad",
			languageCode: "ar",
			steps: [
				{
					message: `أنا وزوجتي وطفل ونريد غرفة من ${triple.checkinISO} إلى ${triple.checkoutISO}`,
					expect: ({ ai }) => assertMatches(ai.message, /طفل|أطفال|بالغ|بالغين|غرفة|سعر|خصم|children|adult/i, "relationship guest reply"),
				},
			],
		},
		{
			name: "Required-details confusion is explained simply",
			hotel: "ajyad",
			languageCode: "ar",
			steps: [
				{ message: `احجز غرفة رباعية من ${quad.checkinISO} إلى ${quad.checkoutISO} لأربعة أشخاص`, expect: ({ ai }) => assertDiscountMarkup(ai.message) },
				{ message: "نعم احجز" },
				{
					message: "مو فاهم",
					expect: ({ ai }) => {
						assertMatches(ai.message, /اسم|جوال|جنسية|بيانات|booking|phone|name|nationality/i, "details clarification");
						assert(ai.message.length < 700, "details clarification too long");
					},
				},
			],
		},
		{
			name: "Shaimaa-style full flow stays human, creates booking, answers pay and contact",
			hotel: "ajyad",
			languageCode: "ar",
			clientName: "Shaimaa Elsherif",
			reservation: true,
			steps: [
				{ message: "كم يبعد الفندق عن الحرم", expect: ({ ai }) => assertMatches(ai.message, /15|١٥|حرم/i, "Shaimaa distance") },
				{ message: "هل يوجد وسيلة مواصلات من الفندق", expect: ({ ai }) => assertMatches(ai.message, /باص|نقل|مواصلات/i, "Shaimaa bus") },
				{ message: `احجز لي غرفة لشخصين من ${stay.checkinISO} إلى ${stay.checkoutISO}`, expect: ({ ai }) => assertDiscountMarkup(ai.message, "Shaimaa quote") },
				{ message: "تمام احجز" },
				{ message: `الاسم أحمد كودكس والجوال ${scenarioPhone(28)} والجنسية مصري` },
				{
					message: "المتابعة بدون بريد",
					expect: ({ ai }) => {
						assertMatches(ai.message, /شيماء|Shaimaa|أستاذة/i, "review addressed the chat guest");
						assertMatches(ai.message, /أحمد\s+كودكس|Ahmed\s+Codex/i, "review kept reservation guest name");
						assert(!/يا\s+أستاذ\s+أحمد|ضيفنا العزيز\s+أحمد/i.test(ai.message), "review addressed reservation holder instead of chat guest");
					},
				},
				{ message: "إتمام الحجز", expect: async ({ caseId }) => assertReservationCreated(caseId, "Shaimaa final submit") },
				{
					message: "ينفع ادفع في الفندق؟",
					expect: ({ ai }) => assertMatches(ai.message, /نعم|ينفع|فندق|hotel|pay/i, "Shaimaa payment"),
				},
				{
					message: "ممكن رقم واتساب وصور الغرف؟",
					expect: ({ ai }) => {
						assertIncludesAny(ai.message, [CONTACT_NUMBER, "19092223374", "wa.me"], "Shaimaa contact");
						assertMatches(ai.message, /صور|جوجل|google|واتساب|whatsapp/i, "Shaimaa photos");
					},
				},
			],
		},
		{
			name: "Initial chat name remains address source when booking holder differs",
			hotel: "ajyad",
			languageCode: "ar",
			clientName: "Shaimaa Elsherif",
			steps: [
				{ message: `احجز غرفة لشخصين من ${stay.checkinISO} إلى ${stay.checkoutISO}`, expect: ({ ai }) => assertDiscountMarkup(ai.message, "address source quote") },
				{ message: "تمام احجز" },
				{ message: `الاسم خالد كودكس والجوال ${scenarioPhone(28)} والجنسية مصري` },
				{
					message: "المتابعة بدون بريد",
					expect: ({ ai }) => {
						assertMatches(ai.message, /شيماء|Shaimaa|أستاذة/i, "review addressed initial chat guest");
						assertMatches(ai.message, /خالد\s+كودكس|Khaled\s+Codex/i, "review kept booking holder");
						assert(!/يا\s+أستاذ\s+خالد|ضيفنا العزيز\s+خالد/i.test(ai.message), "review addressed booking holder instead of chat guest");
					},
				},
			],
		},
		{
			name: "Two separate reservations in one chat stay separated",
			hotel: "ajyad",
			languageCode: "ar",
			reservation: true,
			steps: [
				{
					message: `\u0623\u0631\u064a\u062f \u062d\u062c\u0632\u064a\u0646 \u0645\u0646\u0641\u0635\u0644\u064a\u0646 \u0641\u064a \u0646\u0641\u0633 \u0627\u0644\u0641\u0646\u062f\u0642: \u063a\u0631\u0641\u0629 \u0644\u0634\u062e\u0635\u064a\u0646 \u0645\u0646 ${stay.checkinISO} \u0625\u0644\u0649 ${stay.checkoutISO}\u060c \u0648\u063a\u0631\u0641\u0629 \u0644\u0634\u062e\u0635\u064a\u0646 \u0645\u0646 ${splitSecond.checkinISO} \u0625\u0644\u0649 ${splitSecond.checkoutISO}`,
					expect: ({ ai }) => {
						assert(
							String(ai.clientAction || "").toLowerCase() === "split_stay_quote_ready",
							"split stay did not produce a split quote"
						);
						assertDateRangeMention(ai.message, stay.checkinISO, stay.checkoutISO, "split quote first period");
						assertDateRangeMention(ai.message, splitSecond.checkinISO, splitSecond.checkoutISO, "split quote second period");
						assertMatches(ai.message, /separate|period|reservation|\u0645\u0646\u0641\u0635\u0644|\u0641\u062a\u0631\u0629|\u062d\u062c\u0632/i, "split quote separation language");
						assertDiscountMarkup(ai.message, "split quote");
					},
				},
				{ message: "\u0646\u0639\u0645 \u062a\u0627\u0628\u0639" },
				{ message: `\u0627\u0644\u0627\u0633\u0645 \u0633\u0644\u0645\u0649 \u0643\u0648\u062f\u0643\u0633 \u0648\u0627\u0644\u062c\u0648\u0627\u0644 ${scenarioPhone(29)} \u0648\u0627\u0644\u062c\u0646\u0633\u064a\u0629 \u0645\u0635\u0631\u064a` },
				{
					message: "\u0627\u0644\u0645\u062a\u0627\u0628\u0639\u0629 \u0628\u062f\u0648\u0646 \u0628\u0631\u064a\u062f",
					expect: ({ ai }) => {
						assertMatches(ai.message, /separate|period|reservation|\u0645\u0646\u0641\u0635\u0644|\u0641\u062a\u0631\u0629|\u062d\u062c\u0632/i, "split review separation language");
						assertMatches(ai.message, /\u0633\u0644\u0645\u0649\s+\u0643\u0648\u062f\u0643\u0633|Salma\s+Codex/i, "split review guest name");
						assertDiscountMarkup(ai.message, "split review");
					},
				},
				{
					message: "\u0625\u062a\u0645\u0627\u0645 \u0627\u0644\u062d\u062c\u0632",
					expect: async ({ ai, caseId }) => {
						assertMatches(ai.message, /confirmation|\u0631\u0642\u0645|\u062a\u0623\u0643\u064a\u062f|separate|\u0645\u0646\u0641\u0635\u0644/i, "split final confirmation");
						const rows = await reservationsForCase(caseId);
						for (const row of rows) runState.reservationIds.add(String(row._id));
						assert(rows.length >= 2, `split stay created ${rows.length} reservation(s), expected at least 2`);
						const rowISO = (value) => {
							const date = new Date(value);
							return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
						};
						const datePairs = new Set(
							rows.map((row) => `${rowISO(row.checkin_date)}:${rowISO(row.checkout_date)}`)
						);
						assert(datePairs.size >= 2, "split stay reservations were not kept as separate date periods");
					},
				},
			],
		},
	];
}

async function runScenario(definition, number, ctx) {
	const hotel = ctx.hotels[definition.hotel || "ajyad"] || ctx.hotels.ajyad;
	const sc = await createCase({
		number,
		slug: definition.name,
				hotel,
				languageCode: definition.languageCode || "ar",
				supportScope: definition.supportScope || "hotel",
				clientName: definition.clientName || "",
			});
	let current = sc;
	const turnDurations = [];
	const totalScenarioCount = Number(ctx.totalScenarios || 0) || 28;
	console.log(`SCENARIO ${number}/${totalScenarioCount} START ${definition.name} case=${sc._id}`);

	for (const [index, step] of definition.steps.entries()) {
		const result = step.burst
			? await sendBurst(String(sc._id), number, step.burst)
			: await sendTurn(String(sc._id), number, step.message);
		current = result.sc;
		turnDurations.push(result.durationMs);
		if (typeof step.expect === "function") {
			await step.expect({
				...result,
				caseId: String(sc._id),
				hotel,
				ctx,
				stepIndex: index,
				definition,
			});
		}
		assertNoRepeatedAi(current, definition.name);
	}

	if (definition.reservation) {
		await assertReservationCreated(String(sc._id), definition.name);
	}

	const totalMs = turnDurations.reduce((sum, value) => sum + value, 0);
	const avgMs = Math.round(totalMs / Math.max(1, turnDurations.length));
	runState.scenarioResults.push({
		number,
		name: definition.name,
		caseId: String(sc._id),
		turns: turnDurations.length,
		avgMs,
		totalMs,
	});
	console.log(`SCENARIO ${number}/${totalScenarioCount} PASS ${definition.name} turns=${turnDurations.length} avgMs=${avgMs}`);
}

async function cleanup() {
	const markerRegex = new RegExp(escapeRegExp(marker), "i");
	const caseIds = [...new Set(runState.caseIds)];
	const trackedReservationIds = [...runState.reservationIds];
	const splitCaseRegex = caseIds.length
		? new RegExp(`^(?:${caseIds.map(escapeRegExp).join("|")}):split:`)
		: null;
	const reservationQuery = {
		$or: [
			trackedReservationIds.length
				? { _id: { $in: trackedReservationIds } }
				: { _id: { $in: [] } },
			caseIds.length ? { aiSupportCaseId: { $in: caseIds } } : { _id: { $in: [] } },
			splitCaseRegex ? { aiSupportCaseId: splitCaseRegex } : { _id: { $in: [] } },
			{ "customer_details.email": markerRegex },
			caseIds.length
				? { "customer_details.aiSupportCaseId": { $in: caseIds } }
				: { _id: { $in: [] } },
			splitCaseRegex ? { "customer_details.aiSupportCaseId": splitCaseRegex } : { _id: { $in: [] } },
			{ comment: markerRegex },
			{ booking_comment: markerRegex },
			{ aiReservationFingerprint: markerRegex },
		],
	};
	const reservations = await Reservations.find(reservationQuery).select("_id confirmation_number aiSupportCaseId").lean();
	const reservationIds = reservations.map((row) => row._id);
	if (reservationIds.length) {
		await Reservations.deleteMany({ _id: { $in: reservationIds } });
	}
	if (caseIds.length) {
		await SupportCase.deleteMany({ _id: { $in: caseIds } });
	}
	const remainingCases = await SupportCase.countDocuments({
		$or: [{ _id: { $in: caseIds } }, { sourcePage: markerRegex }, { "conversation.clientTag": marker }],
	});
	const remainingReservations = await Reservations.countDocuments(reservationQuery);
	console.log(
		`CLEANUP marker=${marker} casesDeleted=${caseIds.length} reservationsDeleted=${reservationIds.length} remainingCases=${remainingCases} remainingReservations=${remainingReservations}`
	);
	return { casesDeleted: caseIds.length, reservationsDeleted: reservationIds.length, remainingCases, remainingReservations };
}

async function main() {
	const database = process.env.DATABASE || process.env.MONGO_URI || process.env.MONGODB_URI;
	if (!database) throw new Error("Missing DATABASE/MONGO connection string");
	if (!orchestrator.__worker?.planTurn) throw new Error("Missing orchestrator worker export");
	if (!testApi.quoteTool) throw new Error("Missing quoteTool test export");

	mongoose.set("strictQuery", false);
	await mongoose.connect(database, {
		useNewUrlParser: true,
		useUnifiedTopology: true,
	});

	const hotels = await loadHotels();
	const stays = {
		double: await findAvailableStay(hotels.ajyad, "doubleRooms", 2, 1),
		triple: await findAvailableStay(hotels.ajyad, "tripleRooms", 2, 1),
		quad: await findAvailableStay(hotels.ajyad, "quadRooms", 2, 1),
		family: await findAvailableStay(hotels.ajyad, "familyRooms", 2, 1),
	};
	const ctx = { hotels, stays, marker };
	const scenarios = buildScenarios(ctx);
	ctx.totalScenarios = scenarios.length;
	const selected = scenarios
		.map((definition, index) => ({ definition, number: index + 1 }))
		.filter(({ definition, number }) => {
			if (requestedScenario) {
				const needle = requestedScenario.toLowerCase();
				if (Number.isFinite(requestedScenarioNumber)) return number === requestedScenarioNumber;
				return definition.name.toLowerCase().includes(needle);
			}
			return number >= requestedFrom && number <= requestedTo;
		});

	assert(selected.length > 0, "No scenarios selected");

	console.log(
		`LIVE_QA_START marker=${marker} selected=${selected.length} range=${requestedFrom}-${requestedTo} fast=${fastMode} dispatchSkipped=true`
	);
	console.log(
		`LIVE_QA_STAYS double=${stays.double.checkinISO}->${stays.double.checkoutISO} triple=${stays.triple.checkinISO}->${stays.triple.checkoutISO} quad=${stays.quad.checkinISO}->${stays.quad.checkoutISO} family=${stays.family.checkinISO}->${stays.family.checkoutISO}`
	);

	for (const { definition, number } of selected) {
		await runScenario(definition, number, ctx);
	}

	const avgScenarioMs = Math.round(
		runState.scenarioResults.reduce((sum, item) => sum + item.totalMs, 0) /
			Math.max(1, runState.scenarioResults.length)
	);
	console.log(
		`LIVE_QA_PASS marker=${marker} scenarios=${runState.scenarioResults.length} avgScenarioMs=${avgScenarioMs}`
	);
	console.log(JSON.stringify({ marker, results: runState.scenarioResults }, null, 2));
}

main()
	.catch((error) => {
		console.error(`LIVE_QA_FAIL marker=${marker}`, error?.stack || error);
		process.exitCode = 1;
	})
	.finally(async () => {
		try {
			if (!keepData) await cleanup();
			else console.log(`CLEANUP_SKIPPED marker=${marker}`);
		} catch (error) {
			console.error(`LIVE_QA_CLEANUP_FAIL marker=${marker}`, error?.stack || error);
			process.exitCode = 1;
		}
		try {
			await mongoose.disconnect();
		} catch {
			// Let process exit release the connection.
		}
	});
