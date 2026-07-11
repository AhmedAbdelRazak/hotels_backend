/** @format */

const crypto = require("crypto");

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
mongoose.set("strictQuery", false);
const SupportCase = require("../models/supportcase");
const Reservations = require("../models/reservations");
const Hotel = require("../models/hotel_details");
const orchestrator = require("../aiagent/core/orchestrator");
const testApi = orchestrator.__test || {};

const SUPPORT_EMAIL = "support@jannatbooking.com";
const CONTACT_NUMBER = "+1 (909) 222-3374";
const DEFAULT_AJYAD_ID = "6a40b6a1a6efe70450536038";
const QUIET_WAIT_MS = fastMode ? 650 : 3150;
const QA_SOURCE_WEBSITE = "codex-live-qa";
const QA_MARKER_PREFIX = /^codex(?:qa)?[-_.:]/i;
const QA_MARKER_ALLOWED = /^[a-z0-9._:-]+$/i;
const QA_MARKER_UUID_V4_SUFFIX =
	/(?:^|[-_.:])[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const args = Object.fromEntries(
	argv
		.filter((item) => item.startsWith("--") && item.includes("="))
		.map((item) => {
			const [key, ...rest] = item.slice(2).split("=");
			return [key, rest.join("=")];
		})
);

function assertSafeRunMarker(value = "") {
	const candidate = String(value || "").trim();
	if (
		candidate.length < 48 ||
		candidate.length > 96 ||
		!QA_MARKER_PREFIX.test(candidate) ||
		!QA_MARKER_ALLOWED.test(candidate) ||
		!QA_MARKER_UUID_V4_SUFFIX.test(candidate)
	) {
		throw new Error(
			"Unsafe live-QA marker. Use a 48-96 character codex/codexqa marker ending in a random UUID v4."
		);
	}
	return candidate;
}

const marker = assertSafeRunMarker(
	args.marker ||
		process.env.LIVE_CHATBOT_QA_MARKER ||
		`codexqa-live-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${crypto.randomUUID()}`
);
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
	caseOwnership: new Map(),
	scenarioResults: [],
	reservationOwnership: new Map(),
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

const SEMANTIC_STOPWORDS = new Set(
	[
		"the",
		"and",
		"for",
		"with",
		"your",
		"you",
		"our",
		"this",
		"that",
		"from",
		"have",
		"has",
		"are",
		"was",
		"were",
		"will",
		"would",
		"can",
		"could",
		"please",
		"here",
		"there",
		"pour",
		"avec",
		"votre",
		"vous",
		"nous",
		"cette",
		"cela",
		"peut",
		"etre",
		"من",
		"في",
		"على",
		"الى",
		"هذا",
		"هذه",
		"ذلك",
		"تلك",
		"لك",
		"مع",
		"يمكن",
		"يرجى",
		"تم",
	].map((token) => normalizeSemanticToken(token))
);

const REQUIRED_FACT_LABEL_TOKENS = new Set(
	[
		"sar",
		"usd",
		"riyal",
		"reservation",
		"booking",
		"confirmation",
		"reference",
		"number",
		"payment",
		"details",
		"receipt",
		"link",
		"حجز",
		"الحجز",
		"تاكيد",
		"التاكيد",
		"رقم",
		"مرجع",
		"الدفع",
		"دفع",
		"رابط",
		"التفاصيل",
		"ريال",
	].map((token) => normalizeSemanticToken(token))
);

const REQUIRED_STRUCTURED_TRANSITIONS = new Set([
	"quote_ready->review_reservation",
	"split_stay_quote_ready->review_reservation",
	"review_reservation->reservation_confirmed",
	"reservation_lookup_not_found->reservation_lookup_found",
]);

function normalizeSemanticToken(value = "") {
	return String(value || "")
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[\u0300-\u036f\u064b-\u065f\u0670]/g, "")
		.replace(/[\u0622\u0623\u0625]/g, "\u0627")
		.replace(/\u0649/g, "\u064a")
		.replace(/\u0629/g, "\u0647")
		.trim();
}

function exactReplyText(value = "") {
	return normalizeSemanticToken(
		String(value || "")
			.replace(/<[^>]+>/g, " ")
			.replace(/&(?:nbsp|amp|lt|gt|quot|#39);/gi, " ")
			.replace(/[^\p{L}\p{N}]+/gu, " ")
			.replace(/\s+/g, " ")
	);
}

function semanticReplyTokens(value = "") {
	const withoutFacts = String(value || "")
		.replace(/https?:\/\/\S+/gi, " ")
		.replace(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/[\p{N}\u0660-\u0669\u06f0-\u06f9]+(?:[.,:/-][\p{N}\u0660-\u0669\u06f0-\u06f9]+)*/gu, " ");
	const words = withoutFacts.match(/\p{L}[\p{L}\p{M}]*/gu) || [];
	return [
		...new Set(
			words
				.map((word) => normalizeSemanticToken(word))
				.filter(
					(word) =>
						word.length > 2 &&
						!SEMANTIC_STOPWORDS.has(word) &&
						!REQUIRED_FACT_LABEL_TOKENS.has(word)
				)
		),
	];
}

function requiredFactSignature(value = "") {
	const text = String(value || "");
	const facts = [
		...(text.match(/https?:\/\/\S+/gi) || []).map((item) =>
			item.replace(/[),.;!?]+$/g, "").toLowerCase()
		),
		...(text.match(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi) || []).map((item) =>
			item.toLowerCase()
		),
		...(text.match(/[\p{N}\u0660-\u0669\u06f0-\u06f9]+(?:[.,:/-][\p{N}\u0660-\u0669\u06f0-\u06f9]+)*/gu) || []),
	];
	return [...new Set(facts)].sort().join("|");
}

function semanticReplyComparison(left = "", right = "") {
	const leftTokens = new Set(semanticReplyTokens(left));
	const rightTokens = new Set(semanticReplyTokens(right));
	let intersection = 0;
	for (const token of leftTokens) {
		if (rightTokens.has(token)) intersection += 1;
	}
	const union = leftTokens.size + rightTokens.size - intersection;
	const smaller = Math.min(leftTokens.size, rightTokens.size);
	return {
		leftSize: leftTokens.size,
		rightSize: rightTokens.size,
		intersection,
		jaccard: union ? intersection / union : 0,
		containment: smaller ? intersection / smaller : 0,
	};
}

function entryAction(entry = {}) {
	return String(entry?.clientAction || "").trim().toLowerCase();
}

function repliesSubstantiallyRepeat(previous = {}, current = {}) {
	const previousText = cleanText(previous?.message);
	const currentText = cleanText(current?.message);
	if (!previousText || !currentText) return { repeated: false };
	if (exactReplyText(previousText) === exactReplyText(currentText)) {
		return { repeated: true, reason: "exact", comparison: semanticReplyComparison(previousText, currentText) };
	}

	const comparison = semanticReplyComparison(previousText, currentText);
	const sameMeaningfulTokenSet =
		comparison.leftSize >= 2 &&
		comparison.leftSize === comparison.rightSize &&
		comparison.intersection === comparison.leftSize;
	const enoughMeaningfulOverlap =
		sameMeaningfulTokenSet ||
		(comparison.intersection >= 3 && comparison.jaccard >= 0.7) ||
		(comparison.intersection >= 5 && comparison.jaccard >= 0.65);
	if (!enoughMeaningfulOverlap) {
		return { repeated: false, comparison };
	}

	const previousAction = entryAction(previous);
	const currentAction = entryAction(current);
	const previousFacts = requiredFactSignature(previousText);
	const currentFacts = requiredFactSignature(currentText);
	if (
		REQUIRED_STRUCTURED_TRANSITIONS.has(`${previousAction}->${currentAction}`) &&
		previousFacts &&
		currentFacts
	) {
		return {
			repeated: false,
			reason: "required_structured_transition",
			comparison,
		};
	}
	return { repeated: true, reason: "semantic", comparison };
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

function isoDay(iso = "") {
	return Number(String(iso || "").slice(8, 10)) || 0;
}

function isoMonth(iso = "") {
	return Number(String(iso || "").slice(5, 7)) || 0;
}

function slashDayMonth(iso = "") {
	const day = isoDay(iso);
	const month = isoMonth(iso);
	return day && month ? `${day}/${month}` : iso;
}

function levantMonthName(iso = "") {
	const names = [
		"\u0643\u0627\u0646\u0648\u0646 \u0627\u0644\u062b\u0627\u0646\u064a",
		"\u0634\u0628\u0627\u0637",
		"\u0622\u0630\u0627\u0631",
		"\u0646\u064a\u0633\u0627\u0646",
		"\u0623\u064a\u0627\u0631",
		"\u062d\u0632\u064a\u0631\u0627\u0646",
		"\u062a\u0645\u0648\u0632",
		"\u0622\u0628",
		"\u0623\u064a\u0644\u0648\u0644",
		"\u062a\u0634\u0631\u064a\u0646 \u0627\u0644\u0623\u0648\u0644",
		"\u062a\u0634\u0631\u064a\u0646 \u0627\u0644\u062b\u0627\u0646\u064a",
		"\u0643\u0627\u0646\u0648\u0646 \u0627\u0644\u0623\u0648\u0644",
	];
	return names[isoMonth(iso) - 1] || names[6];
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
	// Jannat-support replies are intentionally both isAi=true and isSystem=true.
	// The initial handoff entry isSystem=true but isAi=false, so isAi is the
	// authoritative customer-facing assistant signal for this harness.
	return (sc.conversation || []).filter((entry) => entry.isAi === true);
}

function latestAi(sc = {}) {
	const messages = aiMessages(sc);
	return messages[messages.length - 1] || null;
}

function conversationEntryIdentity(entry = {}) {
	const id = String(entry?._id || "").trim();
	if (id) return `id:${id}`;
	return [
		"fallback",
		String(entry?.date || entry?.createdAt || ""),
		String(entry?.clientTag || ""),
		String(entry?.clientAction || ""),
		cleanText(entry?.message),
	].join("|");
}

function aiEntryIdentitySet(sc = {}) {
	return new Set(aiMessages(sc).map(conversationEntryIdentity));
}

function newAiEntriesSince(sc = {}, beforeIdentities = new Set()) {
	const baseline =
		beforeIdentities instanceof Set ? beforeIdentities : new Set(beforeIdentities || []);
	return aiMessages(sc).filter(
		(entry) => !baseline.has(conversationEntryIdentity(entry))
	);
}

function lastConversationIndex(sc = {}, predicate = () => false) {
	const conversation = Array.isArray(sc.conversation) ? sc.conversation : [];
	for (let index = conversation.length - 1; index >= 0; index -= 1) {
		if (predicate(conversation[index])) return index;
	}
	return -1;
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

function assertNoProtocolLeak(reply = "", label = "") {
	const text = String(reply || "").trim();
	assert(
		!/^\s*\{/.test(text) &&
			!/"(?:action|reply|facts|memory|orchestrator)"\s*:/i.test(text) &&
			!/\{\s*"action"\s*:\s*"reply"/i.test(text),
		`${label || "reply"} leaked internal JSON/protocol text`
	);
}

function assertNoPrematureIdentityRequest(reply = "", label = "") {
	const text = String(reply || "");
	assert(
		!/(?:\bfull\s*name\b|\bname\b|\bphone\b|\bmobile\b|\bnationality\b|\u0627\u0644\u0627\u0633\u0645|\u0627\u0633\u0645\u0643|\u0627\u0633\u0645|\u062c\u0648\u0627\u0644|\u0647\u0627\u062a\u0641|\u062c\u0646\u0633\u064a\u0629)/iu.test(text),
		`${label || "reply"} asked for identity details before an exact quote`
	);
}

function assertNoGuestCountQuestion(reply = "", label = "") {
	const text = String(reply || "");
	assert(
		!/(?:\bhow\s+many\s+(?:guests|adults|children)\b|\bguest\s*count\b|\u0643\u0645\s+\u0639\u062f\u062f\s+\u0627\u0644\u0636\u064a\u0648\u0641|\u0643\u0645\s+\u0628\u0627\u0644\u063a|\u0643\u0645\s+\u0637\u0641\u0644|\u0639\u062f\u062f\s+\u0627\u0644\u0636\u064a\u0648\u0641\s*[:\u061f?])/iu.test(text),
		`${label || "reply"} asked for guest count before pricing`
	);
}

function assertNoFakeConfirmation(reply = "", label = "") {
	const text = String(reply || "");
	assert(
		!/confirmation\s*(?:number|no\.?)\s*[:#-]?\s*\d{6,}/i.test(text) &&
			!/رقم\s*(?:التأكيد|الحجز)\s*[:#-]?\s*\d{6,}/u.test(text),
		`${label || "reply"} appears to invent a confirmation number`
	);
}

function assertPayAtHotelAccepted(reply = "", latestQuestion = "", label = "") {
	assert(
		!testApi.replyContradictsPayAtHotelPolicy ||
			!testApi.replyContradictsPayAtHotelPolicy(reply),
		`${label || "payment reply"} contradicted pay-at-hotel policy`
	);
	assert(
		!testApi.paymentAtHotelReplyNeedsCorrection ||
			!testApi.paymentAtHotelReplyNeedsCorrection(
				{ action: "reply", reply },
				{ message: latestQuestion || "هل يمكن الدفع عند الوصول" }
			),
		`${label || "payment reply"} still needs pay-at-hotel correction`
	);
	assertMatches(reply, /نعم|يمكن|ينفع|تقدر|فندق|وصول|استقبال|hotel|arrival|reception|pay/i, label || "payment reply");
}

function assertConfirmedBusReply(reply = "", label = "") {
	assertMatches(reply, /باص|اتوبيس|أتوبيس|نقل|مواصلات|bus|shuttle|transport/i, label || "bus reply");
	assertMatches(reply, /الشهداء|شهداء|Martyrs|Shuhada/i, label || "bus stop");
	assert(!/لا\s+أستطيع\s+تأكيد|لا\s+اقدر\s+اؤكد|لا\s+أقدر\s+أؤكد|cannot\s+confirm|can't\s+confirm/i.test(reply), `${label || "bus reply"} deferred a confirmed bus fact`);
}

function assertNusukAvailable(reply = "", label = "") {
	assertMatches(reply, /نسك|nusuk/i, label || "Nusuk reply");
	assertMatches(reply, /متاح|available|yes|نعم|ضمن|حجز/i, label || "Nusuk availability");
	assert(!/لا\s+أستطيع\s+تأكيد|cannot\s+confirm|can't\s+confirm/i.test(reply), `${label || "Nusuk reply"} deferred a confirmed Nusuk fact`);
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
		.filter((entry) => cleanText(entry.message))
		.slice(-6);
	for (let i = 1; i < messages.length; i += 1) {
		const result = repliesSubstantiallyRepeat(messages[i - 1], messages[i]);
		if (result.repeated) {
			const score = result.comparison?.jaccard;
			const scoreLabel = Number.isFinite(score) ? ` (jaccard=${score.toFixed(2)})` : "";
			throw new Error(
				`${label || "case"} repeated a substantially similar AI reply [${result.reason || "semantic"}]${scoreLabel}`
			);
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

async function findAvailableComparisonStay(hotel, nights = 2) {
	const start = addDaysISO(businessTodayISO(), 10);
	for (let offset = 0; offset < 130; offset += 2) {
		const checkinISO = addDaysISO(start, offset);
		const checkoutISO = addDaysISO(checkinISO, nights);
		const baseCase = { _id: "live-qa-preflight", hotelId: hotel._id };
		const doubleQuote = await testApi.quoteTool(baseCase, {
			checkinISO,
			checkoutISO,
			roomTypeKey: "doubleRooms",
			roomSelections: [{ roomTypeKey: "doubleRooms", count: 2 }],
			rooms: 2,
			adults: 4,
			children: 0,
			languageCode: "en",
		});
		if (!doubleQuote?.available) continue;
		const quadQuote = await testApi.quoteTool(baseCase, {
			checkinISO,
			checkoutISO,
			roomTypeKey: "quadRooms",
			roomSelections: [{ roomTypeKey: "quadRooms", count: 1 }],
			rooms: 1,
			adults: 4,
			children: 0,
			languageCode: "en",
		});
		if (quadQuote?.available) {
			return { checkinISO, checkoutISO, nights, doubleQuote, quadQuote };
		}
	}
	throw new Error(`Could not find available double-vs-quad comparison stay for ${hotel.hotelName}`);
}

async function findAvailablePhysicalOverflowStay(hotel, nights = 2) {
	const start = addDaysISO(businessTodayISO(), 10);
	const configuredDoubleUnits = (Array.isArray(hotel?.roomCountDetails)
		? hotel.roomCountDetails
		: []
	)
		.filter(
			(room) =>
				testApi.roomIsSellable?.(room) !== false &&
				String(testApi.canonicalRoomTypeKey?.(room) || room?.roomType || "") === "doubleRooms"
		)
		.reduce((total, room) => total + Math.max(0, Number(room.count || 0) || 0), 0);
	assert(configuredDoubleUnits > 0 && configuredDoubleUnits < 10, "Ajyad must expose fewer than 10 physical double rooms for overflow QA");
	for (let offset = 0; offset < 130; offset += 2) {
		const checkinISO = addDaysISO(start, offset);
		const checkoutISO = addDaysISO(checkinISO, nights);
		const result = await testApi.quoteTool(
			{ _id: "live-qa-preflight", hotelId: hotel._id },
			{
				checkinISO,
				checkoutISO,
				roomTypeKey: "doubleRooms",
				roomSelections: [{ roomTypeKey: "doubleRooms", count: 10 }],
				rooms: 10,
				adults: 20,
				children: 0,
				languageCode: "en",
			}
		);
		const quote = result?.quote || {};
		const lines = Array.isArray(quote.roomLines) ? quote.roomLines : [];
		const totalRooms = lines.reduce(
			(total, line) => total + Math.max(0, Number(line?.count || 0) || 0),
			0
		);
		const quotedDoubleUnits = lines
			.filter((line) => line.roomTypeKey === "doubleRooms")
			.reduce((total, line) => total + Number(line.count || 0), 0);
		if (
			result?.available &&
			quote.roomPlanAdjusted === true &&
			quote.roomPlanRequiresGuestConfirmation === true &&
			totalRooms === 10 &&
			quotedDoubleUnits === configuredDoubleUnits &&
			lines.length >= 2
		) {
			return {
				checkinISO,
				checkoutISO,
				nights,
				result,
				expectedLines: lines,
				configuredDoubleUnits,
			};
		}
	}
	throw new Error(`Could not find a 10-double physical-overflow stay for ${hotel.hotelName}`);
}

async function findAvailableSplitStay(hotel, roomTypeKey = "doubleRooms", nights = 2, count = 1) {
	const first = await findAvailableStay(hotel, roomTypeKey, nights, count);
	const start = addDaysISO(first.checkoutISO, 2);
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
			return {
				first,
				second: { checkinISO, checkoutISO, roomTypeKey, count, nights, quote },
			};
		}
	}
	throw new Error(`Could not find two available ${roomTypeKey} split stays for ${hotel.hotelName}`);
}

function trackedCaseOwnership(caseId = "") {
	const key = String(caseId || "");
	const ownership = runState.caseOwnership.get(key);
	assert(ownership, `Refusing QA operation for untracked support case ${key || "(missing)"}`);
	assert(
		ownership.marker === marker,
		`Refusing QA operation for support case ${key}: marker ownership changed`
	);
	return ownership;
}

function supportCaseOwnershipFilter(ownership = {}) {
	return {
		_id: ownership.caseId,
		sourceWebsite: ownership.sourceWebsite,
		sourcePage: ownership.sourcePage,
		sourceUrl: ownership.sourceUrl,
		clientContact: ownership.clientContact,
		conversation: {
			$elemMatch: {
				isSystem: true,
				clientTag: marker,
				"messageBy.customerEmail": SUPPORT_EMAIL,
			},
		},
	};
}

function assertOwnedSupportCaseDocument(document = {}, ownership = {}) {
	const id = String(document?._id || "");
	assert(id && id === ownership.caseId, `Support case ownership mismatch for ${ownership.caseId}`);
	assert(
		ownership.marker === marker &&
			document.sourceWebsite === ownership.sourceWebsite &&
			document.sourcePage === ownership.sourcePage &&
			document.sourceUrl === ownership.sourceUrl &&
			String(document.clientContact || "").toLowerCase() === ownership.clientContact,
		`Refusing cleanup for support case ${ownership.caseId}: exact QA ownership was not proven`
	);
	const hasExactMarkerEntry = (document.conversation || []).some(
		(entry) =>
			entry.isSystem === true &&
			entry.clientTag === marker &&
			String(entry?.messageBy?.customerEmail || "").toLowerCase() === SUPPORT_EMAIL
	);
	assert(
		hasExactMarkerEntry,
		`Refusing cleanup for support case ${ownership.caseId}: exact marker entry is missing`
	);
	return true;
}

async function loadOwnedSupportCase(caseId = "") {
	const ownership = trackedCaseOwnership(caseId);
	const document = await SupportCase.findById(ownership.caseId).lean();
	assert(
		document,
		`Refusing QA ownership proof for support case ${ownership.caseId}: document is missing`
	);
	assertOwnedSupportCaseDocument(document, ownership);
	return { document, ownership };
}

function reservationCaseRelationship(document = {}, caseId = "") {
	const key = String(caseId || "");
	const direct = String(document.aiSupportCaseId || "");
	const customer = String(document?.customer_details?.aiSupportCaseId || "");
	return {
		direct,
		customer,
		matches:
			direct === key ||
			direct.startsWith(`${key}:split:`) ||
			customer === key,
	};
}

function assertOwnedReservationDocument(document = {}, ownership = {}) {
	const id = String(document?._id || "");
	assert(id && id === ownership.reservationId, `Reservation ownership mismatch for ${ownership.reservationId}`);
	const caseOwnership = trackedCaseOwnership(ownership.caseId);
	assert(
		caseOwnership.marker === marker && ownership.marker === marker,
		`Refusing cleanup for reservation ${id}: exact run marker was not proven`
	);
	const relationship = reservationCaseRelationship(document, ownership.caseId);
	assert(
		relationship.matches &&
			relationship.direct === ownership.aiSupportCaseId &&
			relationship.customer === ownership.customerSupportCaseId,
		`Refusing cleanup for reservation ${id}: support-case relationship changed`
	);
	assert(
		String(document.booking_source || "").trim().toLowerCase() === "ai chat" &&
			String(document?.createdBy?.role || "").trim().toLowerCase() === "aiagent" &&
			String(document?.createdBy?.email || "").trim().toLowerCase() === SUPPORT_EMAIL,
		`Refusing cleanup for reservation ${id}: AI QA creator ownership was not proven`
	);
	return true;
}

function registerReservationOwnership(document = {}, caseId = "") {
	const relationship = reservationCaseRelationship(document, caseId);
	const ownership = {
		reservationId: String(document?._id || ""),
		caseId: String(caseId || ""),
		marker,
		aiSupportCaseId: relationship.direct,
		customerSupportCaseId: relationship.customer,
	};
	assertOwnedReservationDocument(document, ownership);
	const prior = runState.reservationOwnership.get(ownership.reservationId);
	if (prior) {
		assert(
			prior.caseId === ownership.caseId &&
				prior.aiSupportCaseId === ownership.aiSupportCaseId &&
				prior.customerSupportCaseId === ownership.customerSupportCaseId,
			`Refusing to re-track reservation ${ownership.reservationId}: ownership changed`
		);
		return prior;
	}
	runState.reservationOwnership.set(ownership.reservationId, ownership);
	return ownership;
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
	const sourceUrl = `https://xhotelpro.com/codex-live-qa/${marker}/${number}`;
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
		sourceWebsite: QA_SOURCE_WEBSITE,
		sourcePage: topic,
		sourceUrl,
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
	const document = doc.toObject();
	const ownership = {
		caseId: String(doc._id),
		marker,
		number,
		sourceWebsite: QA_SOURCE_WEBSITE,
		sourcePage: topic,
		sourceUrl,
		clientContact: email,
	};
	assertOwnedSupportCaseDocument(document, ownership);
	runState.caseOwnership.set(ownership.caseId, ownership);
	return document;
}

async function appendGuest(caseId, number, message) {
	const { ownership } = await loadOwnedSupportCase(caseId);
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
	const updated = await SupportCase.findOneAndUpdate(
		supportCaseOwnershipFilter(ownership),
		{
			$push: { conversation: entry },
			$set: {
				updatedAt: new Date(),
				aiToRespond: true,
				aiPausedAt: null,
				aiHandoffReason: "",
				caseStatus: "open",
			},
		},
		{ new: true }
	).select("_id");
	assert(
		updated?._id,
		`Refusing to append guest turn for ${caseId}: exact QA ownership changed`
	);
	return entry;
}

async function captureAiBaseline(caseId) {
	const { document } = await loadOwnedSupportCase(caseId);
	return aiEntryIdentitySet(document);
}

async function plan(caseId, beforeAiIdentities) {
	assert(
		beforeAiIdentities instanceof Set,
		`Missing pre-turn AI baseline for case ${caseId}`
	);
	await sleep(QUIET_WAIT_MS);
	const startedAt = Date.now();
	await orchestrator.__worker.planTurn(silentIo, caseId);
	const durationMs = Date.now() - startedAt;
	const sc = await SupportCase.findById(caseId).lean();
	assert(sc, `Support case ${caseId} disappeared during planning`);
	const newAiEntries = newAiEntriesSince(sc, beforeAiIdentities);
	if (!newAiEntries.length) {
		const diagnostic = await SupportCase.findById(caseId)
			.select("+aiStateSnapshot")
			.lean();
		const known = diagnostic?.aiStateSnapshot?.known || {};
		const reviewedQuote = testApi.reviewedQuoteForSubmit
			? testApi.reviewedQuoteForSubmit(known)
			: {};
		console.error(
			"LIVE_QA_NO_REPLY_STATE",
			JSON.stringify({
				caseId,
				conversationTail: (diagnostic?.conversation || []).slice(-6).map((entry) => ({
					isAi: Boolean(entry?.isAi),
					isSystem: Boolean(entry?.isSystem),
					clientAction: String(entry?.clientAction || ""),
					ownedMarker: String(entry?.clientTag || "") === marker,
				})),
				known: {
					hasQuote: Boolean(known?.quote?.available),
					roomSelections: (known?.roomSelections || []).map((selection) => ({
						roomId: String(selection?.roomId || ""),
						roomTypeKey: String(selection?.roomTypeKey || ""),
						count: Number(selection?.count || 0) || 0,
					})),
					officialReviewVersion:
						Number(known?.officialReviewSnapshot?.version || 0) || 0,
					reviewedQuoteUsable: testApi.reviewedQuoteSnapshotUsable
						? testApi.reviewedQuoteSnapshotUsable(reviewedQuote)
						: false,
				},
			}, null, 2)
		);
	}
	assert(
		newAiEntries.length > 0,
		`No new AI conversation entry was created for the latest guest turn in case ${caseId}`
	);
	const ai = latestAi(sc);
	assert(ai?.message, `No AI reply for case ${caseId}`);
	assert(
		newAiEntries.some(
			(entry) => conversationEntryIdentity(entry) === conversationEntryIdentity(ai)
		),
		`Latest AI reply for case ${caseId} is stale and predates the latest guest turn`
	);
	const aiIdentity = conversationEntryIdentity(ai);
	const latestGuestEntry = latestGuest(sc);
	const latestGuestIdentity = conversationEntryIdentity(latestGuestEntry);
	const aiIndex = lastConversationIndex(
		sc,
		(entry) => conversationEntryIdentity(entry) === aiIdentity
	);
	const guestIndex = lastConversationIndex(
		sc,
		(entry) => conversationEntryIdentity(entry) === latestGuestIdentity
	);
	assert(
		latestGuestEntry && guestIndex >= 0 && aiIndex > guestIndex,
		`Latest AI reply for case ${caseId} was not appended after the latest guest turn`
	);
	assertNoProtocolLeak(ai.message, `case ${caseId}`);
	assertNoRobotic(ai.message, `case ${caseId}`);
	assertNoRepeatedAi(sc, `case ${caseId}`);
	return { sc, ai, durationMs, newAiEntryCount: newAiEntries.length };
}

async function sendTurn(caseId, number, message) {
	const beforeAiIdentities = await captureAiBaseline(caseId);
	await appendGuest(caseId, number, message);
	return plan(caseId, beforeAiIdentities);
}

async function sendBurst(caseId, number, messages, delayMs = 800) {
	// A burst models several messages typed during one quiet-window turn. The
	// release invariant is one fresh assistant answer after the final message,
	// not one answer per message inside the intentional burst.
	const beforeAiIdentities = await captureAiBaseline(caseId);
	for (const message of messages) {
		await appendGuest(caseId, number, message);
		if (delayMs > 0) await sleep(delayMs);
	}
	return plan(caseId, beforeAiIdentities);
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

async function trackReservationsForCase(caseId) {
	await loadOwnedSupportCase(caseId);
	const rows = await reservationsForCase(caseId);
	if (rows.length > 20) {
		throw new Error(
			`Refusing reservation ownership discovery for ${caseId}: matched ${rows.length} rows`
		);
	}
	for (const row of rows) {
		registerReservationOwnership(row, caseId);
	}
	return rows;
}

function reservationOwnershipFilter(ownership = {}) {
	const filter = {
		_id: ownership.reservationId,
		booking_source: "ai chat",
		"createdBy.role": "aiagent",
		"createdBy.email": SUPPORT_EMAIL,
	};
	if (ownership.aiSupportCaseId) {
		filter.aiSupportCaseId = ownership.aiSupportCaseId;
	}
	if (ownership.customerSupportCaseId) {
		filter["customer_details.aiSupportCaseId"] = ownership.customerSupportCaseId;
	}
	return filter;
}

async function deleteTrackedReservation(ownership = {}) {
	await loadOwnedSupportCase(ownership.caseId);
	const document = await Reservations.findById(ownership.reservationId).lean();
	if (!document) return 0;
	assertOwnedReservationDocument(document, ownership);
	const deleted = await Reservations.deleteOne(reservationOwnershipFilter(ownership));
	assert(
		Number(deleted.deletedCount || 0) === 1,
		`Refusing ambiguous cleanup result for reservation ${ownership.reservationId}`
	);
	return 1;
}

async function cleanupReservationsForCase(caseId) {
	await trackReservationsForCase(caseId);
	let deleted = 0;
	for (const ownership of runState.reservationOwnership.values()) {
		if (ownership.caseId !== String(caseId || "")) continue;
		deleted += await deleteTrackedReservation(ownership);
	}
	return deleted;
}

async function assertReservationCreated(caseId, label = "") {
	const rows = await trackReservationsForCase(caseId);
	assert(rows.length > 0, `${label || "scenario"} did not create a reservation`);
	return rows;
}

function buildScenarios(ctx) {
	const stay = ctx.stays.double;
	const triple = ctx.stays.triple;
	const quad = ctx.stays.quad;
	const family = ctx.stays.family;
	const comparison = ctx.stays.comparison;
	const physicalOverflow = ctx.stays.physicalOverflow;
	const splitFirst = ctx.stays.split?.first || stay;
	const splitSecond = ctx.stays.split?.second || {
		checkinISO: addDaysISO(stay.checkoutISO, 2),
		checkoutISO: addDaysISO(stay.checkoutISO, 4),
	};
	const changed = {
		checkinISO: addDaysISO(stay.checkinISO, 2),
		checkoutISO: addDaysISO(stay.checkoutISO, 2),
	};
	const ahmedComparisonStay = {
		checkinISO: comparison.checkinISO,
		checkoutISO: comparison.checkoutISO,
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
						assertDateRangeMention(ai.message, changed.checkinISO, changed.checkoutISO, "corrected quote dates");
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
						assertMatches(ai.message, /شيماء|Shaimaa|[أا]ستاذة/i, "review addressed the chat guest");
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
						assertMatches(ai.message, /شيماء|Shaimaa|[أا]ستاذة/i, "review addressed initial chat guest");
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
			clientName: "Salma Codex",
			reservation: true,
			steps: [
				{
					message: `\u0623\u0631\u064a\u062f \u062d\u062c\u0632\u064a\u0646 \u0645\u0646\u0641\u0635\u0644\u064a\u0646 \u0641\u064a \u0646\u0641\u0633 \u0627\u0644\u0641\u0646\u062f\u0642: \u063a\u0631\u0641\u0629 \u0644\u0634\u062e\u0635\u064a\u0646 \u0645\u0646 ${splitFirst.checkinISO} \u0625\u0644\u0649 ${splitFirst.checkoutISO}\u060c \u0648\u063a\u0631\u0641\u0629 \u0644\u0634\u062e\u0635\u064a\u0646 \u0645\u0646 ${splitSecond.checkinISO} \u0625\u0644\u0649 ${splitSecond.checkoutISO}`,
					expect: ({ ai }) => {
						assert(
							String(ai.clientAction || "").toLowerCase() === "split_stay_quote_ready",
							"split stay did not produce a split quote"
						);
						assertDateRangeMention(ai.message, splitFirst.checkinISO, splitFirst.checkoutISO, "split quote first period");
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
		{
			name: "Long Arabic quote stays plain customer text",
			hotel: "ajyad",
			languageCode: "ar",
			steps: [
				{
					message: `\u0623\u0631\u063a\u0628 \u0641\u064a \u0625\u0642\u0627\u0645\u0629 \u0645\u0646 ${stay.checkinISO} \u0625\u0644\u0649 ${stay.checkoutISO} \u0644\u0634\u062e\u0635\u064a\u0646 \u0628\u0627\u0644\u063a\u064a\u0646\u060c \u063a\u0631\u0641\u0629 \u0645\u0632\u062f\u0648\u062c\u0629\u060c \u0648\u0623\u0631\u064a\u062f \u0627\u0644\u0633\u0639\u0631 \u0627\u0644\u0646\u0647\u0627\u0626\u064a \u0644\u0644\u062d\u062c\u0632 \u0627\u0644\u0645\u0628\u0627\u0634\u0631`,
					expect: ({ ai }) => {
						assertNoProtocolLeak(ai.message, "long Arabic quote");
						assertDiscountMarkup(ai.message, "long Arabic quote");
					},
				},
			],
		},
		{
			name: "Child age phrase does not become seven children",
			hotel: "ajyad",
			languageCode: "ar",
			steps: [
				{
					message: `\u0623\u0631\u064a\u062f \u062d\u062c\u0632 \u063a\u0631\u0641\u0629 \u062b\u0644\u0627\u062b\u064a\u0629 \u0645\u0646 ${triple.checkinISO} \u0625\u0644\u0649 ${triple.checkoutISO} \u0644\u0634\u062e\u0635 \u0628\u0627\u0644\u063a \u0648\u0637\u0641\u0644\u064a\u0646 7 \u0633\u0646\u0648\u0627\u062a`,
					expect: ({ ai }) => {
						assertNoProtocolLeak(ai.message, "child age quote");
						assertDiscountMarkup(ai.message, "child age quote");
						assert(
							!/7\s*(?:children|kids)|\u0667\s*(?:\u0623\u0637\u0641\u0627\u0644|\u0627\u0637\u0641\u0627\u0644)|7\s*(?:\u0623\u0637\u0641\u0627\u0644|\u0627\u0637\u0641\u0627\u0644)/iu.test(ai.message),
							"child age quote treated age as child count"
						);
					},
				},
			],
		},
		{
			name: "Three-room quote survives capacity wording",
			hotel: "ajyad",
			languageCode: "ar",
			steps: [
				{
					message: `\u0623\u0631\u064a\u062f 3 \u063a\u0631\u0641 \u0639\u0627\u0626\u0644\u064a\u0629 \u0645\u0646 ${family.checkinISO} \u0625\u0644\u0649 ${family.checkoutISO} \u0644\u0640 6 \u0628\u0627\u0644\u063a\u064a\u0646`,
					expect: ({ ai }) => {
						assertDiscountMarkup(ai.message, "three-room quote");
						assertMatches(ai.message, /3|\u0663|\u062b\u0644\u0627\u062b/i, "three-room count");
						assertMatches(ai.message, /\u0639\u0627\u0626\u0644|family/i, "three-room family type");
						assert(
							!/(?:double|quad|quadruple|\u0645\u0632\u062f\u0648\u062c|\u062b\u0646\u0627\u0626|\u0631\u0628\u0627\u0639)/iu.test(ai.message),
							"three-room quote changed family rooms to another room type"
						);
					},
				},
				{
					message: "\u0627\u0644\u063a\u0631\u0641 \u062a\u0633\u0639 5 \u0627\u0634\u062e\u0627\u0635\u061f",
					expect: ({ ai }) => {
						assertNoProtocolLeak(ai.message, "capacity follow-up");
						assert(
							!/(?:<s\b|message-price-new|150\s*(?:SAR|\u0631\u064a\u0627\u0644)|400\s*(?:SAR|\u0631\u064a\u0627\u0644)|50\s*(?:SAR|\u0631\u064a\u0627\u0644)|\u063a\u0631\u0641\u0629\s+\u0648\u0627\u062d\u062f\u0629|\u063a\u0631\u0641\u0629\s+\u0639\u0627\u0626\u0644\u064a\u0629\s+\u0648\u0627\u062d\u062f\u0629|one\s+room|1\s+room)/iu.test(ai.message),
							"capacity follow-up collapsed the multi-room quote or invented payment amounts"
						);
					},
				},
			],
		},
		{
			name: "Quote is shown before identity details",
			hotel: "ajyad",
			languageCode: "ar",
			steps: [
				{
					message: "\u0643\u0645 \u064a\u0628\u0639\u062f \u0627\u0644\u0641\u0646\u062f\u0642 \u0639\u0646 \u0627\u0644\u062d\u0631\u0645\u061f",
					expect: ({ ai }) => assertMatches(ai.message, /15|\u0661\u0665|\u062d\u0631\u0645|haram/i, "distance before quote"),
				},
				{
					message: `\u0623\u0631\u064a\u062f \u0627\u0644\u0633\u0639\u0631 \u0645\u0646 ${stay.checkinISO} \u0625\u0644\u0649 ${stay.checkoutISO} \u0644\u0634\u062e\u0635 \u0648\u0627\u062d\u062f \u0641\u064a \u063a\u0631\u0641\u0629 \u0645\u0632\u062f\u0648\u062c\u0629`,
					expect: ({ ai }) => {
						assertDiscountMarkup(ai.message, "quote before identity");
						assertNoPrematureIdentityRequest(ai.message, "quote before identity");
					},
				},
			],
		},
		{
			name: "Compound hotel facts stay consistent",
			hotel: "ajyad",
			languageCode: "ar",
			steps: [
				{
					message: "\u0627\u0644\u0645\u0648\u0642\u0639\u061f \u0648\u0647\u0644 \u064a\u0648\u062c\u062f \u0628\u0627\u0635\u061f \u0648\u0647\u0644 \u0641\u064a \u0641\u0637\u0648\u0631\u061f",
					expect: ({ ai }) => {
						assertMatches(ai.message, /\u062d\u0631\u0645|15|\u0661\u0665|maps|map|\u0645\u0648\u0642\u0639|\u0639\u0646\u0648\u0627\u0646/i, "compound location");
						assertMatches(ai.message, /\u0628\u0627\u0635|\u0646\u0642\u0644|\u0645\u0648\u0627\u0635\u0644\u0627\u062a|bus|shuttle|transport/i, "compound bus");
						assertNoMealPromise(ai.message, "compound meals");
					},
				},
			],
		},
		{
			name: "Live payment-at-arrival wording after confirmed booking is answered yes",
			hotel: "ajyad",
			languageCode: "ar",
			reservation: true,
			steps: [
				{
					message: `\u0627\u062d\u062a\u0627\u062c \u063a\u0631\u0641\u0629 \u0631\u0628\u0627\u0639\u064a\u0629 \u0644\u0640 4 \u0646\u0632\u0644\u0627\u0621 \u0645\u0646 ${quad.checkinISO} \u0625\u0644\u0649 ${quad.checkoutISO}`,
					expect: ({ ai }) => assertDiscountMarkup(ai.message, "live payment quote"),
				},
				{ message: "\u0646\u0639\u0645\u060c \u062a\u0627\u0628\u0639" },
				{
					message: `\u0627\u0644\u0627\u0633\u0645 \u0645\u062d\u0645\u062f \u0627\u0644\u0633\u064a\u062f \u0641\u0647\u0645\u0649 \u0648\u0627\u0644\u062c\u0648\u0627\u0644 ${scenarioPhone(35)} \u0648\u0627\u0644\u062c\u0646\u0633\u064a\u0629 \u0623\u0641\u063a\u0627\u0646\u064a`,
					expect: ({ ai }) =>
						assertMatches(ai.message, /email|\u0628\u0631\u064a\u062f|\u0627\u062e\u062a\u064a\u0627\u0631\u064a|\u0645\u062d\u0645\u062f\s+\u0627\u0644\u0633\u064a\u062f|review|\u0645\u0631\u0627\u062c\u0639\u0629|\u0625\u062a\u0645\u0627\u0645|\u0627\u0644\u062d\u062c\u0632/i, "live payment optional email or review"),
				},
				{ message: "\u0627\u0644\u0645\u062a\u0627\u0628\u0639\u0629 \u0628\u062f\u0648\u0646 \u0628\u0631\u064a\u062f \u0625\u0644\u0643\u062a\u0631\u0648\u0646\u064a" },
				{
					message: "\u0625\u062a\u0645\u0627\u0645 \u0627\u0644\u062d\u062c\u0632",
					expect: async ({ ai, caseId }) => {
						assertMatches(ai.message, /\u062a\u0623\u0643\u064a\u062f|confirmation|\d{8,}/i, "live payment confirmation");
						await assertReservationCreated(caseId, "live payment final submit");
					},
				},
				{
					message: "\u0647\u0644 \u064a\u0645\u0643\u0646 \u0627\u0644\u062f\u0641\u0639 \u0639\u0646\u062f \u0627\u0644\u0648\u0635\u0648\u0644",
					expect: ({ ai }) => {
						assertPayAtHotelAccepted(ai.message, "\u0647\u0644 \u064a\u0645\u0643\u0646 \u0627\u0644\u062f\u0641\u0639 \u0639\u0646\u062f \u0627\u0644\u0648\u0635\u0648\u0644", "live exact pay-at-arrival");
						assertMatches(ai.message, /\d{8,}|\u0631\u0642\u0645\s+\u0627\u0644\u062a\u0623\u0643\u064a\u062f|confirmation/i, "live exact payment confirmation number");
						assertMatches(ai.message, /\u0631\u0627\u0628\u0637\s+\u0627\u0644\u062f\u0641\u0639|payment\s+link|\u0639\u0631\u0628\u0648\u0646|deposit/i, "live exact payment link/deposit guidance");
					},
				},
			],
		},
		{
			name: "Bus Nusuk and location detours preserve review on request",
			hotel: "ajyad",
			languageCode: "ar",
			steps: [
				{
					message: `\u0623\u0631\u064a\u062f \u063a\u0631\u0641\u0629 \u0645\u0632\u062f\u0648\u062c\u0629 \u0644\u0634\u062e\u0635\u064a\u0646 \u0645\u0646 ${stay.checkinISO} \u0625\u0644\u0649 ${stay.checkoutISO}`,
					expect: ({ ai }) => assertDiscountMarkup(ai.message, "detour review quote"),
				},
				{
					message: "\u0642\u0628\u0644 \u0645\u0627 \u0623\u0643\u0645\u0644\u060c \u0647\u0644 \u0639\u0646\u062f\u0643\u0645 \u0623\u062a\u0648\u0628\u064a\u0633 \u0644\u0644\u062d\u0631\u0645\u061f",
					expect: ({ ai }) => assertConfirmedBusReply(ai.message, "detour bus"),
				},
				{
					message: "\u0648\u0646\u0633\u0643 \u0645\u062a\u0627\u062d\u061f",
					expect: ({ ai }) => assertNusukAvailable(ai.message, "detour Nusuk"),
				},
				{
					message: "\u0637\u064a\u0628 \u0627\u0644\u0645\u0648\u0642\u0639 \u0641\u064a\u0646 \u0648\u0643\u0645 \u064a\u0628\u0639\u062f \u0639\u0646 \u0627\u0644\u062d\u0631\u0645\u061f",
					expect: ({ ai }) => assertMatches(ai.message, /15|\u0661\u0665|2|\u0662|map|maps|\u0645\u0648\u0642\u0639|\u062d\u0631\u0645|\u0639\u0646\u0648\u0627\u0646/i, "detour location"),
				},
				{ message: "\u0646\u0639\u0645\u060c \u062a\u0627\u0628\u0639" },
				{
					message: `\u0627\u0644\u0627\u0633\u0645 \u0645\u0646\u0649 \u0643\u0648\u062f\u0643\u0633 \u0648\u0627\u0644\u062c\u0648\u0627\u0644 ${scenarioPhone(36)} \u0648\u0627\u0644\u062c\u0646\u0633\u064a\u0629 \u0645\u0635\u0631\u064a`,
					expect: ({ ai }) =>
						assertMatches(ai.message, /email|\u0628\u0631\u064a\u062f|\u0627\u062e\u062a\u064a\u0627\u0631\u064a|\u0645\u0646\u0649\s+\u0643\u0648\u062f\u0643\u0633|review|\u0645\u0631\u0627\u062c\u0639\u0629|\u0625\u062a\u0645\u0627\u0645|\u0627\u0644\u062d\u062c\u0632/i, "detour optional email or review"),
				},
				{
					message: "\u0627\u0644\u0645\u062a\u0627\u0628\u0639\u0629 \u0628\u062f\u0648\u0646 \u0628\u0631\u064a\u062f",
					expect: ({ ai }) => {
						assertMatches(ai.message, /\u0645\u0646[\u0649\u064a]\s+\u0643\u0648\u062f\u0643\u0633|Mona\s+Codex/i, "detour review name");
						assertDateRangeMention(ai.message, stay.checkinISO, stay.checkoutISO, "detour first review dates");
						assertMatches(ai.message, /\u0625\u062a\u0645\u0627\u0645|\u0623\u0643\u0645\u0644|\u0623\u0624\u0643\u062f|\u0635\u062d\u064a\u062d|\u0627\u0644\u0628\u064a\u0627\u0646\u0627\u062a|confirm|complete|correct/i, "detour review confirmation ask");
					},
				},
				{
					message: "\u0645\u0645\u0643\u0646 \u0623\u0634\u0648\u0641 \u062a\u0641\u0627\u0635\u064a\u0644 \u0627\u0644\u062d\u062c\u0632 \u0643\u0627\u0645\u0644\u0629 \u0645\u0631\u0629 \u062b\u0627\u0646\u064a\u0629 \u0642\u0628\u0644 \u0645\u0627 \u0623\u0623\u0643\u062f\u061f",
					expect: async ({ ai, caseId }) => {
						assertMatches(ai.message, /\u0645\u0646[\u0649\u064a]\s+\u0643\u0648\u062f\u0643\u0633|Mona\s+Codex/i, "repeat review name");
						assertDateRangeMention(ai.message, stay.checkinISO, stay.checkoutISO, "repeat review dates");
						assertDiscountMarkup(ai.message, "repeat review");
						const rows = await reservationsForCase(caseId);
						assert(rows.length === 0, "repeat review request created reservation before confirmation");
					},
				},
			],
		},
		{
			name: "Initial compound bus Nusuk location answer then booking continues",
			hotel: "ajyad",
			languageCode: "ar",
			steps: [
				{
					message: "\u0627\u0644\u0645\u0648\u0642\u0639 \u0641\u064a\u0646\u061f \u0648\u0647\u0644 \u0639\u0646\u062f\u0643\u0645 \u0628\u0627\u0635 \u0644\u0644\u062d\u0631\u0645\u061f \u0648\u0646\u0633\u0643 \u0645\u062a\u0627\u062d\u061f",
					expect: ({ ai }) => {
						assertMatches(ai.message, /15|\u0661\u0665|2|\u0662|map|maps|\u0645\u0648\u0642\u0639|\u062d\u0631\u0645|\u0639\u0646\u0648\u0627\u0646/i, "initial compound location");
						assertConfirmedBusReply(ai.message, "initial compound bus");
						assertNusukAvailable(ai.message, "initial compound Nusuk");
					},
				},
				{
					message: `\u0645\u0645\u062a\u0627\u0632\u060c \u0623\u0631\u064a\u062f \u0627\u0644\u0633\u0639\u0631 \u0644\u063a\u0631\u0641\u0629 \u0645\u0632\u062f\u0648\u062c\u0629 \u0644\u0634\u062e\u0635\u064a\u0646 \u0645\u0646 ${stay.checkinISO} \u0625\u0644\u0649 ${stay.checkoutISO}`,
					expect: ({ ai }) => {
						assertDiscountMarkup(ai.message, "compound then quote");
						assertNoPrematureIdentityRequest(ai.message, "compound then quote");
					},
				},
			],
		},
		{
			name: "Post-confirmation service facts stay factual and do not reopen booking",
			hotel: "ajyad",
			languageCode: "ar",
			reservation: true,
			steps: [
				{
					message: `\u0627\u062d\u062c\u0632 \u063a\u0631\u0641\u0629 \u0644\u0634\u062e\u0635\u064a\u0646 \u0645\u0646 ${stay.checkinISO} \u0625\u0644\u0649 ${stay.checkoutISO}`,
					expect: ({ ai }) => assertDiscountMarkup(ai.message, "post-confirmation facts quote"),
				},
				{ message: "\u0646\u0639\u0645 \u062a\u0627\u0628\u0639" },
				{ message: `\u0627\u0644\u0627\u0633\u0645 \u064a\u0627\u0633\u0631 \u0643\u0648\u062f\u0643\u0633 \u0648\u0627\u0644\u062c\u0648\u0627\u0644 ${scenarioPhone(38)} \u0648\u0627\u0644\u062c\u0646\u0633\u064a\u0629 \u0645\u0635\u0631\u064a` },
				{ message: "\u0627\u0644\u0645\u062a\u0627\u0628\u0639\u0629 \u0628\u062f\u0648\u0646 \u0628\u0631\u064a\u062f" },
				{
					message: "\u0625\u062a\u0645\u0627\u0645 \u0627\u0644\u062d\u062c\u0632",
					expect: async ({ ai, caseId }) => {
						assertMatches(ai.message, /\u062a\u0623\u0643\u064a\u062f|confirmation|\d{8,}/i, "post-confirmation facts confirmation");
						await assertReservationCreated(caseId, "post-confirmation facts submit");
					},
				},
				{
					message: "\u0628\u0639\u062f \u0627\u0644\u062d\u062c\u0632\u060c \u0639\u0646\u062f\u0643\u0645 \u0628\u0627\u0635\u061f \u0648\u0646\u0633\u0643\u061f \u0648\u0627\u0644\u0644\u0648\u0643\u064a\u0634\u0646\u061f",
					expect: ({ ai }) => {
						assertConfirmedBusReply(ai.message, "post-confirmation facts bus");
						assertNusukAvailable(ai.message, "post-confirmation facts Nusuk");
						assertMatches(ai.message, /15|\u0661\u0665|2|\u0662|map|maps|\u0645\u0648\u0642\u0639|\u062d\u0631\u0645|\u0639\u0646\u0648\u0627\u0646/i, "post-confirmation facts location");
						assert(!/\u0623\u0631\u0633\u0644\s+\u0644\u064a\s+\u062a\u0627\u0631\u064a\u062e|\u0623\u062d\u062a\u0627\u062c.*\u062a\u0627\u0631\u064a\u062e|send.*date|check.?in/i.test(ai.message), "post-confirmation service fact reopened booking details");
					},
				},
			],
		},
		{
			name: "Arabic Levant month checkout day-only quote",
			hotel: "ajyad",
			languageCode: "ar",
			steps: [
				{
					message: `\u0623\u0631\u064a\u062f \u063a\u0631\u0641\u0629 \u0631\u0628\u0627\u0639\u064a\u0629 \u0645\u0646 ${isoDay(quad.checkinISO)} ${levantMonthName(quad.checkinISO)} \u0648\u0627\u0644\u062e\u0631\u0648\u062c ${isoDay(quad.checkoutISO)} \u0623\u0631\u0628\u0639\u0629 \u0646\u0632\u0644\u0627\u0621`,
					expect: ({ ai }) => {
						assertDiscountMarkup(ai.message, "Arabic Levant day-only quote");
						assertDateRangeMention(
							ai.message,
							quad.checkinISO,
							quad.checkoutISO,
							"Arabic Levant day-only quote dates"
						);
						assertNoPrematureIdentityRequest(ai.message, "Arabic Levant day-only quote");
					},
				},
			],
		},
		{
			name: "Arabic slash range with extra booking facts quotes",
			hotel: "ajyad",
			languageCode: "ar",
			steps: [
				{
					message: `\u0623\u0631\u064a\u062f \u0633\u0639\u0631 \u063a\u0631\u0641\u0629 \u0631\u0628\u0627\u0639\u064a\u0629 \u0645\u0646 ${slashDayMonth(quad.checkinISO)} \u0627\u0644\u0649 ${slashDayMonth(quad.checkoutISO)} \u0623\u0631\u0628\u0639\u0629 \u0623\u0634\u062e\u0627\u0635`,
					expect: ({ ai }) => {
						assertDiscountMarkup(ai.message, "Arabic slash extra-facts quote");
						assertDateRangeMention(
							ai.message,
							quad.checkinISO,
							quad.checkoutISO,
							"Arabic slash extra-facts quote dates"
						);
						assertNoPrematureIdentityRequest(ai.message, "Arabic slash extra-facts quote");
					},
				},
			],
		},
		{
			name: "Arabic burst slash messages wait and quote all facts",
			hotel: "ajyad",
			languageCode: "ar",
			burst: true,
			steps: [
				{
					burst: [
						"\u0643\u0645 \u0627\u0644\u0633\u0639\u0631\u061f",
						"\u063a\u0631\u0641\u0629 \u0631\u0628\u0627\u0639\u064a\u0629",
						`\u0645\u0646 ${slashDayMonth(quad.checkinISO)} \u0627\u0644\u0649 ${slashDayMonth(quad.checkoutISO)}`,
						"\u0623\u0631\u0628\u0639\u0629 \u0623\u0634\u062e\u0627\u0635",
					],
					expect: ({ ai }) => {
						assertDiscountMarkup(ai.message, "Arabic burst slash quote");
						assertDateRangeMention(
							ai.message,
							quad.checkinISO,
							quad.checkoutISO,
							"Arabic burst slash quote dates"
						);
						assertNoPrematureIdentityRequest(ai.message, "Arabic burst slash quote");
					},
				},
			],
		},
		{
			name: "Arabic separate checkout follow-up quotes after bot asks",
			hotel: "ajyad",
			languageCode: "ar",
			steps: [
				{
					message: `\u0623\u0631\u064a\u062f \u0633\u0639\u0631 \u063a\u0631\u0641\u0629 \u0631\u0628\u0627\u0639\u064a\u0629 \u0644\u0623\u0631\u0628\u0639\u0629 \u0623\u0634\u062e\u0627\u0635 \u0627\u0644\u062f\u062e\u0648\u0644 ${slashDayMonth(quad.checkinISO)}`,
					expect: ({ ai }) => {
						assert(
							!/<s\b[^>]*message-price-old/i.test(ai.message),
							"checkin-only turn should not quote before checkout is known"
						);
						assertMatches(
							ai.message,
							/\u0627\u0644\u062e\u0631\u0648\u062c|\u0627\u0644\u0645\u063a\u0627\u062f\u0631\u0629|checkout|check.?out|departure/i,
							"checkin-only checkout request"
						);
					},
				},
				{
					message: slashDayMonth(quad.checkoutISO),
					expect: ({ ai }) => {
						assertDiscountMarkup(ai.message, "separate checkout follow-up quote");
						assertDateRangeMention(
							ai.message,
							quad.checkinISO,
							quad.checkoutISO,
							"separate checkout follow-up quote dates"
						);
						assertNoPrematureIdentityRequest(ai.message, "separate checkout follow-up quote");
					},
				},
			],
		},
		{
			name: "Arabic Ahmed price follow-up and on-demand room comparison",
			hotel: "ajyad",
			languageCode: "ar",
			clientName: "\u0627\u062d\u0645\u062f \u0627\u0644\u062d\u062f\u0627\u062f",
			reservation: true,
			steps: [
				{
					message: "\u0643\u0645 \u0633\u0639\u0631 \u063a\u0631\u0641 \u0645\u0632\u062f\u0648\u062c\u0629",
					expect: ({ ai }) => {
						assertMatches(
							ai.message,
							/\u062a\u0627\u0631\u064a\u062e|\u0627\u0644\u062f\u062e\u0648\u0644|\u0627\u0644\u062e\u0631\u0648\u062c|date|check/i,
							"Ahmed initial price detail request"
						);
					},
				},
				{
					message:
						`\u0645\u0646 ${slashDayMonth(ahmedComparisonStay.checkinISO)} \u0627\u0644\u0649 ${slashDayMonth(ahmedComparisonStay.checkoutISO)}`,
					expect: ({ ai }) => {
						assertDiscountMarkup(ai.message, "Ahmed date-only price quote");
						assertDateRangeMention(
							ai.message,
							ahmedComparisonStay.checkinISO,
							ahmedComparisonStay.checkoutISO,
							"Ahmed date-only quote dates"
						);
						assertNoGuestCountQuestion(ai.message, "Ahmed date-only quote");
					},
				},
				{
					message:
						"\u0639\u062f\u062f \u0627\u0644\u0636\u064a\u0648\u0641 4\n\u0646\u062d\u062a\u0627\u062c \u0625\u0644\u0649 \u063a\u0631\u0641\u062a\u064a\u0646 \u0645\u0632\u062f\u0648\u062c\u0629\n\u0623\u0648 \u063a\u0631\u0641\u0629 \u0648\u0627\u062d\u062f\u0629 \u0631\u0628\u0627\u0639\u064a\u0629",
					expect: ({ ai }) => {
						const priceCount = (String(ai.message || "").match(/message-price-new/g) || []).length;
						assert(priceCount >= 2, "Ahmed room comparison did not show two priced options");
						assertMatches(ai.message, /double|quad|\u0645\u0632\u062f\u0648\u062c|\u0631\u0628\u0627\u0639/i, "Ahmed comparison room labels");
						assertDateRangeMention(
							ai.message,
							ahmedComparisonStay.checkinISO,
							ahmedComparisonStay.checkoutISO,
							"Ahmed comparison dates"
						);
						assert(
							!/(?:\u0623\u064a\u0647\u0645\u0627|\u0627\u064a\u0647\u0645\u0627|\u062a\u0641\u0636\u0644).{0,60}\u061f/u.test(
								ai.message
							),
							"Ahmed comparison asked which option instead of pricing both"
						);
						const replies = Array.isArray(ai.quickReplies) ? ai.quickReplies : [];
						assert(replies.length >= 2, "Ahmed comparison did not send room-choice quick replies");
						assert(
							replies.every((reply) => String(reply.action || "") === "select_room_option"),
							"Ahmed comparison quick replies do not select a room option"
						);
						const replyText = replies
							.map((reply) => `${reply.label || ""} ${reply.value || ""}`)
							.join(" ");
						assertMatches(replyText, /double|\u0645\u0632\u062f\u0648\u062c/i, "Ahmed double quick reply");
						assertMatches(replyText, /quad|\u0631\u0628\u0627\u0639/i, "Ahmed quad quick reply");
					},
				},
				{
					message:
						"\u0623\u062e\u062a\u0627\u0631 \u063a\u0631\u0641\u062a\u064a\u0646 \u0645\u0632\u062f\u0648\u062c\u0629",
					expect: ({ ai }) => {
						assertDiscountMarkup(ai.message, "Ahmed typed double choice quote");
						assertDateRangeMention(
							ai.message,
							ahmedComparisonStay.checkinISO,
							ahmedComparisonStay.checkoutISO,
							"Ahmed typed double choice quote dates"
						);
						assertMatches(
							ai.message,
							/double|\u0645\u0632\u062f\u0648\u062c/i,
							"Ahmed typed double choice room label"
						);
					},
				},
				{
					message: "\u0646\u0639\u0645 \u062a\u0627\u0628\u0639",
					expect: ({ ai }) => {
						assertMatches(
							ai.message,
							/\u0627\u0633\u0645|\u062c\u0648\u0627\u0644|\u062c\u0646\u0633\u064a\u0629|name|phone|nationality/i,
							"Ahmed comparison details request"
						);
					},
				},
				{
					message: `\u0627\u0644\u0627\u0633\u0645 \u0623\u062d\u0645\u062f \u0627\u0644\u062d\u062f\u0627\u062f \u0648\u0627\u0644\u062c\u0648\u0627\u0644 ${scenarioPhone(43)} \u0648\u0627\u0644\u062c\u0646\u0633\u064a\u0629 \u0645\u0635\u0631\u064a`,
					expect: ({ ai }) => {
						assertMatches(
							ai.message,
							/\u0628\u0631\u064a\u062f|email|\u0645\u0631\u0627\u062c\u0639\u0629|review|\u0625\u062a\u0645\u0627\u0645|\u0627\u0644\u062d\u062c\u0632/i,
							"Ahmed comparison identity response"
						);
					},
				},
				{
					message: "\u0627\u0644\u0645\u062a\u0627\u0628\u0639\u0629 \u0628\u062f\u0648\u0646 \u0628\u0631\u064a\u062f",
					expect: ({ ai }) => {
						assertMatches(
							ai.message,
							/\u0645\u0631\u0627\u062c\u0639\u0629|\u0625\u062a\u0645\u0627\u0645 \u0627\u0644\u062d\u062c\u0632|\u062a\u0623\u0643\u064a\u062f|\u0628\u064a\u0627\u0646\u0627\u062a \u0627\u0644\u062d\u062c\u0632|review|complete/i,
							"Ahmed comparison official review"
						);
						assertMatches(ai.message, /double|\u0645\u0632\u062f\u0648\u062c/i, "Ahmed comparison review room");
						assert(
							!/quad|\u0631\u0628\u0627\u0639/i.test(String(ai.message || "")),
							"Ahmed comparison review leaked the unchosen quad option"
						);
					},
				},
				{
					message: "\u0625\u062a\u0645\u0627\u0645 \u0627\u0644\u062d\u062c\u0632",
					expect: async ({ ai, caseId }) => {
						assertMatches(ai.message, /\u062a\u0623\u0643\u064a\u062f|confirmation|\d{8,}/i, "Ahmed comparison final confirmation");
						const rows = await assertReservationCreated(caseId, "Ahmed comparison selected double submit");
						const reservation = rows[0] || {};
						assert(
							Number(reservation.total_rooms || 0) === 2,
							"Ahmed comparison reservation did not keep exactly 2 selected double rooms"
						);
						const pickedRooms = Array.isArray(reservation.pickedRoomsPricing)
							? reservation.pickedRoomsPricing
							: [];
						const pickedText = JSON.stringify(pickedRooms);
						assertMatches(pickedText, /double|doubleRooms|\u0645\u0632\u062f\u0648\u062c/i, "Ahmed comparison reservation picked double room");
						assert(
							!/quad|quadRooms|\u0631\u0628\u0627\u0639/i.test(pickedText),
							"Ahmed comparison reservation included the unchosen quad room"
						);
					},
				},
			],
		},
		{
			name: "Ten doubles use exact physical mixed allocation only after approval",
			hotel: "ajyad",
			languageCode: "en",
			clientName: "Omar Codex",
			reservation: true,
			steps: [
				{
					message: `I need 10 double rooms for 20 adults from ${physicalOverflow.checkinISO} to ${physicalOverflow.checkoutISO}. Please give me the exact total price.`,
					expect: ({ ai }) => {
						assertDiscountMarkup(ai.message, "ten-double mixed quote");
						assertMatches(ai.message, /original request|requested/i, "ten-double original request");
						assertMatches(ai.message, /recommended mix|recommend/i, "ten-double recommended mix");
						assertMatches(ai.message, /agree|approval|confirm/i, "ten-double approval gate");
						for (const line of physicalOverflow.expectedLines) {
							const labelPattern =
								line.roomTypeKey === "doubleRooms"
									? "double"
									: line.roomTypeKey === "tripleRooms"
									? "triple"
									: line.roomTypeKey === "quadRooms"
									? "quad(?:ruple)?"
									: line.roomTypeKey === "familyRooms"
									? "family|quintuple|six[ -]?bed"
									: "suite|room";
							const count = Number(line.count || 0);
							assertMatches(
								ai.message,
								new RegExp(`(?:${count}\\s*(?:x\\s*)?[^\\n]{0,45}(?:${labelPattern})|(?:${labelPattern})[^\\n]{0,45}\\b${count}\\b)`, "i"),
								`ten-double expected ${line.roomTypeKey} count`
							);
						}
					},
				},
				{
					message: "Yes, I agree to the exact recommended room mix.",
					expect: ({ ai }) =>
						assertMatches(ai.message, /full name|name|phone|nationality/i, "ten-double identity request"),
				},
				{
					message: "Does the double room have parking?",
					expect: async ({ ai, caseId }) => {
						assertMatches(ai.message, /parking/i, "ten-double room fact detour");
						const rows = await reservationsForCase(caseId);
						assert(rows.length === 0, "room fact question created the ten-room reservation");
					},
				},
				{
					message: `The booking name is Omar Codex, phone ${scenarioPhone(44)}, nationality Egyptian, 20 adults and no children.`,
					expect: ({ ai }) =>
						assertMatches(ai.message, /email|optional|review|complete booking/i, "ten-double identity response"),
				},
				{
					message: "Continue without email",
					expect: ({ ai }) => {
						assertMatches(ai.message, /review|complete booking|confirm/i, "ten-double official review");
						assertDiscountMarkup(ai.message, "ten-double official review price");
						assertDateRangeMention(
							ai.message,
							physicalOverflow.checkinISO,
							physicalOverflow.checkoutISO,
							"ten-double official review dates"
						);
					},
				},
				{
					message: "Yes, complete it. Can I pay at the hotel on arrival?",
					expect: async ({ ai, caseId }) => {
						assertPayAtHotelAccepted(ai.message, "pay at the hotel", "ten-double prebooking payment");
						assertMatches(ai.message, /not created|have not created|not booked/i, "ten-double no-create payment answer");
						const rows = await reservationsForCase(caseId);
						assert(rows.length === 0, "compound payment question created the ten-room reservation");
					},
				},
				{
					message: "Complete booking",
					expect: async ({ ai, caseId }) => {
						assertMatches(ai.message, /confirmation|confirmed|\d{8,}/i, "ten-double final confirmation");
						const rows = await assertReservationCreated(caseId, "ten-double exact mixed submit");
						assert(rows.length === 1, "ten-double flow created more than one reservation");
						const reservation = rows[0] || {};
						assert(
							Number(reservation.total_rooms || 0) === 10,
							"ten-double reservation total_rooms changed"
						);
						const picked = Array.isArray(reservation.pickedRoomsPricing)
							? reservation.pickedRoomsPricing
							: [];
						assert(picked.length === 10, "ten-double picked room rows changed");
						for (const line of physicalOverflow.expectedLines) {
							const exactCount = picked.filter(
								(row) => String(row.hotelRoomConfigId || "") === String(line.roomId || "")
							).length;
							assert(
								exactCount === Number(line.count || 0),
								`ten-double stored exact room count changed for ${line.roomId}`
							);
						}
						const expectedTotal = Number(physicalOverflow.result?.quote?.total || 0);
						assert(
							Math.abs(Number(reservation.total_amount || 0) - expectedTotal) < 0.01,
							`ten-double stored total ${reservation.total_amount} differs from exact quote ${expectedTotal}`
						);
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
	const totalScenarioCount = Number(ctx.totalScenarios || 0) || 34;
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
	if (!keepData) {
		const reservationsDeleted = await cleanupReservationsForCase(String(sc._id));
		if (reservationsDeleted) {
			console.log(
				`SCENARIO ${number}/${totalScenarioCount} CLEANUP reservationsDeleted=${reservationsDeleted}`
			);
		}
	}
}

async function deleteTrackedSupportCase(ownership = {}) {
	const document = await SupportCase.findById(ownership.caseId).lean();
	if (!document) return 0;
	assertOwnedSupportCaseDocument(document, ownership);
	const deleted = await SupportCase.deleteOne(supportCaseOwnershipFilter(ownership));
	assert(
		Number(deleted.deletedCount || 0) === 1,
		`Refusing ambiguous cleanup result for support case ${ownership.caseId}`
	);
	return 1;
}

async function cleanup() {
	const caseOwnerships = [...runState.caseOwnership.values()];

	// Prove every current-run relationship before the first final-cleanup delete.
	for (const ownership of caseOwnerships) {
		await loadOwnedSupportCase(ownership.caseId);
		await trackReservationsForCase(ownership.caseId);
	}
	for (const ownership of runState.reservationOwnership.values()) {
		const document = await Reservations.findById(ownership.reservationId).lean();
		if (document) assertOwnedReservationDocument(document, ownership);
	}

	let reservationsDeleted = 0;
	for (const ownership of runState.reservationOwnership.values()) {
		reservationsDeleted += await deleteTrackedReservation(ownership);
	}

	let casesDeleted = 0;
	for (const ownership of caseOwnerships) {
		casesDeleted += await deleteTrackedSupportCase(ownership);
	}

	const caseIds = caseOwnerships.map((item) => item.caseId);
	const reservationIds = [...runState.reservationOwnership.keys()];
	const remainingCases = caseIds.length
		? await SupportCase.countDocuments({ _id: { $in: caseIds } })
		: 0;
	const remainingReservations = reservationIds.length
		? await Reservations.countDocuments({ _id: { $in: reservationIds } })
		: 0;
	const untrackedExactMarkerCases = await SupportCase.countDocuments({
		"conversation.clientTag": marker,
	});
	assert(
		untrackedExactMarkerCases === 0,
		`Cleanup left ${untrackedExactMarkerCases} exact-marker support case(s); refusing any untracked deletion`
	);
	console.log(
		`CLEANUP marker=${marker} casesDeleted=${casesDeleted} reservationsDeleted=${reservationsDeleted} remainingCases=${remainingCases} remainingReservations=${remainingReservations}`
	);
	return {
		casesDeleted,
		reservationsDeleted,
		remainingCases,
		remainingReservations,
		untrackedExactMarkerCases,
	};
}

function assertThrows(fn, label = "") {
	let threw = false;
	try {
		fn();
	} catch (_error) {
		threw = true;
	}
	assert(threw, `${label || "operation"} was expected to throw`);
}

function runSelfTests() {
	const safeMarker = `codexqa-self-test-${crypto.randomUUID()}`;
	assertSafeRunMarker(safeMarker);
	assertThrows(
		() => assertSafeRunMarker("codex-prod"),
		"generic marker safety check"
	);

	const before = {
		conversation: [{ _id: "ai-1", isAi: true, message: "First answer" }],
	};
	const after = {
		conversation: [
			...before.conversation,
			{ _id: "ai-2", isAi: true, message: "Second answer" },
		],
	};
	assert(
		newAiEntriesSince(after, aiEntryIdentitySet(before)).length === 1,
		"new AI entry detection failed"
	);
	assert(
		newAiEntriesSince(before, aiEntryIdentitySet(before)).length === 0,
		"stale AI entry detection failed"
	);
	const jannatAfter = {
		conversation: [
			...before.conversation,
			{
				_id: "ai-jannat-2",
				isAi: true,
				isSystem: true,
				message: "Jannat support answer",
			},
		],
	};
	assert(
		newAiEntriesSince(jannatAfter, aiEntryIdentitySet(before)).length === 1,
		"Jannat isAi+isSystem reply was not treated as a new assistant answer"
	);

	const repeated = repliesSubstantiallyRepeat(
		{
			clientAction: "ai_reply",
			message:
				"Your room is available for the requested dates. The total price is 825 SAR. Would you like to continue with the booking?",
		},
		{
			clientAction: "ai_reply",
			message:
				"The room is available for the requested dates, with a total price of 825 SAR. Would you like to continue with the booking?",
		}
	);
	assert(repeated.repeated, "semantic repetition was not detected");
	const distinct = repliesSubstantiallyRepeat(
		{ clientAction: "hotel_fact_answered", message: "The bus goes to Martyrs parking." },
		{
			clientAction: "payment_at_hotel_policy",
			message: "You may pay at reception, and online payment is recommended.",
		}
	);
	assert(!distinct.repeated, "distinct adjacent answers were treated as redundant");
	const shortPunctuationRepeat = repliesSubstantiallyRepeat(
		{ clientAction: "ai_reply", message: "Yes, you may pay at the hotel." },
		{ clientAction: "ai_reply", message: "Yes — you may pay at the hotel! 🌷" }
	);
	assert(
		shortPunctuationRepeat.repeated,
		"short punctuation/emoji repetition was not detected"
	);
	const progressiveFollowup = repliesSubstantiallyRepeat(
		{
			clientAction: "quote_ready",
			message: "The double room remains available for your selected stay.",
		},
		{
			clientAction: "required_details_needed",
			message:
				"The double room remains available for your selected stay. To prepare the booking, please send the guest name, nationality, mobile contact, adult count, and child count.",
		}
	);
	assert(
		!progressiveFollowup.repeated,
		"a genuinely progressive follow-up was treated as redundant"
	);
	const requiredTransition = repliesSubstantiallyRepeat(
		{
			clientAction: "quote_ready",
			message:
				"The selected double room remains available for the requested stay. Please review the guest information carefully. Total 825 SAR for 11 nights.",
		},
		{
			clientAction: "review_reservation",
			message:
				"Official review: the selected double room remains available for the requested stay. Please review the guest information carefully and confirm. Total 825 SAR for 11 nights.",
		}
	);
	assert(
		!requiredTransition.repeated &&
			requiredTransition.reason === "required_structured_transition",
		"required quote-to-review facts were treated as redundant"
	);
	const changedConfirmation = repliesSubstantiallyRepeat(
		{
			clientAction: "reservation_confirmed",
			message:
				"Your selected room is now confirmed for the requested stay. Keep these official details for reception. Confirmation number 8940361462. Details https://example.com/a",
		},
		{
			clientAction: "reservation_confirmed",
			message:
				"Your selected room is now confirmed for the requested stay. Keep these official details for reception. Confirmation number 8940361463. Details https://example.com/b",
		}
	);
	assert(
		changedConfirmation.repeated,
		"changed confirmation facts incorrectly excused repeated surrounding prose"
	);

	const testCaseId = "507f1f77bcf86cd799439011";
	const caseOwnership = {
		caseId: testCaseId,
		marker,
		sourceWebsite: QA_SOURCE_WEBSITE,
		sourcePage: `${marker} scenario 99 self-test`,
		sourceUrl: `https://xhotelpro.com/codex-live-qa/${marker}/99`,
		clientContact: `codexqa.${marker}.99@example.com`.toLowerCase(),
	};
	const caseDocument = {
		_id: testCaseId,
		sourceWebsite: caseOwnership.sourceWebsite,
		sourcePage: caseOwnership.sourcePage,
		sourceUrl: caseOwnership.sourceUrl,
		clientContact: caseOwnership.clientContact,
		conversation: [
			{
				isSystem: true,
				clientTag: marker,
				messageBy: { customerEmail: SUPPORT_EMAIL },
			},
		],
	};
	assertOwnedSupportCaseDocument(caseDocument, caseOwnership);
	assertThrows(
		() =>
			assertOwnedSupportCaseDocument(
				{ ...caseDocument, sourceWebsite: "production-site" },
				caseOwnership
			),
		"support-case source ownership safety check"
	);
	const caseDeleteFilter = supportCaseOwnershipFilter(caseOwnership);
	assert(
		String(caseDeleteFilter._id) === testCaseId &&
			caseDeleteFilter.sourcePage === caseOwnership.sourcePage &&
			caseDeleteFilter.conversation?.$elemMatch?.clientTag === marker &&
			!JSON.stringify(caseDeleteFilter).includes("$regex"),
		"support-case cleanup filter is not exact-ID/exact-marker scoped"
	);
	runState.caseOwnership.set(testCaseId, caseOwnership);
	const reservationDocument = {
		_id: "507f191e810c19729de860ea",
		aiSupportCaseId: `${testCaseId}:split:1`,
		booking_source: "ai chat",
		createdBy: { role: "aiagent", email: SUPPORT_EMAIL },
		customer_details: { aiSupportCaseId: testCaseId },
	};
	const reservationOwnership = {
		reservationId: String(reservationDocument._id),
		caseId: testCaseId,
		marker,
		aiSupportCaseId: reservationDocument.aiSupportCaseId,
		customerSupportCaseId: testCaseId,
	};
	assertOwnedReservationDocument(reservationDocument, reservationOwnership);
	const reservationDeleteFilter = reservationOwnershipFilter(reservationOwnership);
	assert(
		String(reservationDeleteFilter._id) === reservationOwnership.reservationId &&
			reservationDeleteFilter.aiSupportCaseId === reservationOwnership.aiSupportCaseId &&
			!JSON.stringify(reservationDeleteFilter).includes("$regex"),
		"reservation cleanup filter is not exact-ID/exact-owner scoped"
	);
	assertThrows(
		() =>
			assertOwnedReservationDocument(
				{ ...reservationDocument, booking_source: "direct" },
				reservationOwnership
			),
		"reservation ownership safety check"
	);
	assertThrows(
		() =>
			assertOwnedReservationDocument(
				{ ...reservationDocument, aiSupportCaseId: "unrelated-case" },
				reservationOwnership
			),
		"reservation case-relationship safety check"
	);
	runState.caseOwnership.delete(testCaseId);
	console.log("PASS liveChatbotQa safety self-test");
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
		comparison: await findAvailableComparisonStay(hotels.ajyad, 2),
		physicalOverflow: await findAvailablePhysicalOverflowStay(hotels.ajyad, 2),
		split: await findAvailableSplitStay(hotels.ajyad, "doubleRooms", 2, 1),
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
		`LIVE_QA_STAYS double=${stays.double.checkinISO}->${stays.double.checkoutISO} triple=${stays.triple.checkinISO}->${stays.triple.checkoutISO} quad=${stays.quad.checkinISO}->${stays.quad.checkoutISO} family=${stays.family.checkinISO}->${stays.family.checkoutISO} comparison=${stays.comparison.checkinISO}->${stays.comparison.checkoutISO} physicalOverflow=${stays.physicalOverflow.checkinISO}->${stays.physicalOverflow.checkoutISO} split=${stays.split.first.checkinISO}->${stays.split.first.checkoutISO}+${stays.split.second.checkinISO}->${stays.split.second.checkoutISO}`
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

async function runLiveQa() {
	try {
		await main();
	} catch (error) {
		console.error(`LIVE_QA_FAIL marker=${marker}`, error?.stack || error);
		process.exitCode = 1;
	} finally {
		if (mongoose.connection.readyState === 1) {
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
		}
	}
}

if (require.main === module) {
	if (argv.includes("--self-test")) {
		try {
			runSelfTests();
		} catch (error) {
			console.error("LIVE_QA_SELF_TEST_FAIL", error?.stack || error);
			process.exitCode = 1;
		}
	} else {
		runLiveQa();
	}
}

module.exports = {
	__test: {
		assertOwnedReservationDocument,
		assertOwnedSupportCaseDocument,
		assertSafeRunMarker,
		aiEntryIdentitySet,
		newAiEntriesSince,
		repliesSubstantiallyRepeat,
		runSelfTests,
		semanticReplyComparison,
	},
};
