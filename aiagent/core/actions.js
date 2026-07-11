// aiagent/core/actions.js
const crypto = require("crypto");
const mongoose = require("mongoose");
const Reservations = require("../../models/reservations");
const UncompleteReservations = require("../../models/Uncompleted");
const SupportCase = require("../../models/supportcase");
const {
	validateReservationInventoryForCreate,
	captureReservationAvailabilitySnapshot,
} = require("../../controllers/reservations");
const {
	updateSupportCaseAppend,
	getHotelByIdWithPricingDates,
} = require("./db");
const { asciiize, digitsToEnglish } = require("./nlu");
const {
	priceRoomForStay,
	resolveRoomForStay,
	roomCapacity,
	roomSellableInventory,
	roomIsSellable,
} = require("./selectors");
const {
	markReservationPendingConfirmation,
} = require("../../services/pendingConfirmationPolicy");
const {
	dispatchReservationConfirmation,
	reservationPublicLinks,
} = require("../../services/reservationConfirmationDispatcher");
const {
	scheduleReservationConfirmedConversion,
} = require("../../services/conversionTracking");

const DAY_MS = 24 * 60 * 60 * 1000;
const AI_RESERVATION_ACTOR = {
	_id: "jannat-ai-support",
	name: "Jannat AI Support",
	email: "support@jannatbooking.com",
	role: "aiagent",
	roleDescription: "AI Chat",
};
const AI_RESERVATION_LOCK_TTL_MS = 2 * 60 * 1000;
const AI_RESERVATION_QUERY_MAX_TIME_MS = intFromEnv(
	"AI_RESERVATION_QUERY_MAX_TIME_MS",
	2500,
	{ min: 500, max: 10000 }
);
const AI_RESERVATION_CREATE_SLOW_LOG_MS = intFromEnv(
	"AI_RESERVATION_CREATE_SLOW_LOG_MS",
	800,
	{ min: 100, max: 10000 }
);

function intFromEnv(name, fallback, { min = 0, max = 60000 } = {}) {
	const parsed = parseInt(process.env[name] || "", 10);
	const value = Number.isFinite(parsed) ? parsed : fallback;
	return Math.min(max, Math.max(min, value));
}

function log(caseId, msg, payload = {}) {
	if (String(process.env.AI_AGENT_DEBUG || "").toLowerCase() !== "true") {
		return;
	}
	console.log(`[aiagent] case=${caseId} ${msg}`, payload);
}
function logSlowReservationCreateStep(caseId, step, elapsedMs, payload = {}) {
	if (elapsedMs < AI_RESERVATION_CREATE_SLOW_LOG_MS) return;
	console.log("[aiagent] reservation create step slow", {
		caseId: String(caseId || ""),
		step,
		elapsedMs,
		...payload,
	});
}
async function timedReservationCreateStep(caseId, step, fn, payload = {}) {
	const startedAt = Date.now();
	try {
		const result = await fn();
		logSlowReservationCreateStep(caseId, step, Date.now() - startedAt, payload);
		return result;
	} catch (error) {
		logSlowReservationCreateStep(caseId, `${step}.failed`, Date.now() - startedAt, {
			...payload,
			error: String(error?.message || error || "").slice(0, 200),
		});
		throw error;
	}
}
function sleep(ms = 0) {
	return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}
function onlyDigits(s = "") {
	return digitsToEnglish(String(s)).replace(/\D+/g, "");
}

function cleanText(value = "", max = 120) {
	return digitsToEnglish(String(value || ""))
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, max);
}

function compactArabic(value = "") {
	return String(value || "")
		.replace(/[\u064b-\u065f\u0670]/g, "")
		.replace(/\u0640/g, "")
		.replace(/\s+/g, "")
		.trim();
}

function isShortAffirmativeToken(value = "") {
	const compact = compactArabic(value).toLowerCase().replace(/[^a-z0-9\u0600-\u06FF]+/g, "");
	if (!compact) return false;
	return new Set([
		"yes",
		"y",
		"ok",
		"okay",
		"sure",
		"correct",
		"confirm",
		"confirmed",
		"\u0646\u0639\u0645",
		"\u062a\u0645\u0627\u0645",
		"\u0627\u0643\u064a\u062f",
		"\u0627\u064a",
		"\u0623\u064a",
		"\u0627\u064a\u0648\u0646",
		"\u0623\u064a\u0648\u0646",
		"\u0627\u064a\u0648\u0647",
		"\u0623\u064a\u0648\u0647",
		"\u0627\u064a\u0648\u0627",
		"\u0623\u064a\u0648\u0627",
		"\u0627\u064a\u0648\u0629",
		"\u0623\u064a\u0648\u0629",
		"\u0627\u0647",
		"\u0623\u0647",
		"\u0622\u0647",
	]).has(compact);
}

function stripGuestNameFieldPrefix(value = "") {
	let cleaned = String(value || "").replace(/\s+/g, " ").trim();
	for (let index = 0; index < 3; index += 1) {
		const next = cleaned
			.replace(
				/^(?:full\s*name|guest\s*name|passport\s*name|name|nombre\s+completo|nombre\s+del\s+huesped|nombre\s+del\s+hu[e\u00e9]sped|nombre\s+en\s+pasaporte|nombre|nom\s+complet|nom\s+du\s+client|nom)\s*[:\uFF1A-]?\s+/i,
				""
			)
			.replace(
				/^(?:\u0648?\u0627\u0633\u0645\u064a|\u0648?\u0627\u0633\u0645\u0649|\u0627\u0644\u0627\u0633\u0645(?:\s+\u0627\u0644\u0643\u0627\u0645\u0644)?|\u0627\u0633\u0645)\s*[:\uFF1A-]?\s+/i,
				""
			)
			.replace(/^[\s:.,;|()[\]{}-]+|[\s:.,;|()[\]{}-]+$/g, "")
			.trim();
		if (!next || next === cleaned) break;
		cleaned = next;
	}
	return cleaned;
}

function rejectedAiGuestName(value = "") {
	const name = cleanText(value, 120);
	const lower = name.toLowerCase();
	const compact = compactArabic(name);
	if (
		/\b(?:please|send|give|show|details|number|hurry|quick|quickly|faster|speed|urgent|reservation|booking|confirmation|nationality|country)\b/i.test(
			lower
		)
	) {
		return true;
	}
	if (
		/(?:\u0645\u0645\u0643\u0646|\u0644\u0648\s+\u0633\u0645\u062d\u062a|\u0628\u0633\u0631\u0639\u0647|\u0628\u0633\u0631\u0639\u0629|\u0633\u0631\u0639\u0647|\u0633\u0631\u0639\u0629|\u0645\u0633\u062a\u0639\u062c\u0644|\u062a\u0641\u0627\u0635\u064a\u0644|\u0631\u0642\u0645|\u062d\u062c\u0632|\u062c\u0646\u0633\u064a|\u0627\u0644\u062c\u0646\u0633\u064a\u0629)/i.test(
			name
		)
	) {
		return true;
	}
	if (
		/(?:\b(?:you|u)\s+(?:know|already\s+know)\b|(?:\u0639\u0627\u0631\u0641|\u0639\u0627\u0631\u0641\u0629|\u0639\u0627\u0631\u0641\u0627\u0647|\u0639\u0627\u0631\u0641\u0627\u0647\u0627)|\u064a\u0627\s+(?:\u0639\u064a\u0634\u0629|\u0639\u0627\u0626\u0634\u0629|\u0627\u064a\u0645\u0627\u0646|\u0625\u064a\u0645\u0627\u0646|\u0631\u0627\u0646\u064a\u0627|\u0635\u0641\u064a\u0629|\u0635\u0641\u064a\u0647|\u0632\u064a\u0646\u0628|\u0644\u064a\u0646\u0627))/iu.test(
			name
		)
	) {
		return true;
	}
	if (/^(?:\u0627\u0646\u062a|\u0627\u0646\u062a\u064a|\u0627\u0646\u062a\u0649|\u062d\u0636\u0631\u062a\u0643|\u0645\u0646\u062a\u064a|\u0645\u0646\u062a\u0649|\u0645\u0627\u0646\u062a\u064a|\u0645\u0627\u0646\u062a\u0649)(?:\s|$)/iu.test(name)) {
		return true;
	}
	return [
		"\u0628\u0648\u0631\u0643\u064a\u0646\u0627\u0641\u0627\u0633\u0648",
		"\u0627\u0631\u062f\u0646\u064a",
		"\u0627\u0631\u062f\u0646\u0649",
		"\u0623\u0631\u062f\u0646\u064a",
		"\u0623\u0631\u062f\u0646\u0649",
		"\u0647\u0646\u0627\u0643\u0634\u064a\u0621\u063a\u064a\u0631\u0635\u062d\u064a\u062d",
		"\u0627\u0631\u064a\u062f\u062a\u0639\u062f\u064a\u0644\u0634\u064a\u0621",
		"\u0623\u0631\u064a\u062f\u062a\u0639\u062f\u064a\u0644\u0634\u064a\u0621",
		"\u0627\u062a\u0645\u0627\u0645\u0627\u0644\u062d\u062c\u0632",
		"\u0625\u062a\u0645\u0627\u0645\u0627\u0644\u062d\u062c\u0632",
	].includes(compact);
}

function looksLikeReservationActionName(value = "") {
	const name = cleanText(value, 120);
	const lower = name.toLowerCase();
	const compact = compactArabic(name);
	if (isShortAffirmativeToken(name)) return true;
	if (
		/^(?:something\s+is\s+wrong|change\s+something|change\s+details|complete\s+booking|confirm|confirmed|continue|proceed|yes|ok|okay|correct)$/i.test(
			lower
		)
	) {
		return true;
	}
	if (
		/^(?:wrong|incorrect|mistake|not\s+correct|invalid|revise|edit|change)$/i.test(
			lower
		)
	) {
		return true;
	}
	return new Set([
		"\u0647\u0646\u0627\u0643\u0634\u064a\u0621\u063a\u064a\u0631\u0635\u062d\u064a\u062d",
		"\u0634\u064a\u0621\u063a\u064a\u0631\u0635\u062d\u064a\u062d",
		"\u063a\u064a\u0631\u0635\u062d\u064a\u062d",
		"\u0627\u0631\u064a\u062f\u062a\u0639\u062f\u064a\u0644\u0634\u064a\u0621",
		"\u0623\u0631\u064a\u062f\u062a\u0639\u062f\u064a\u0644\u0634\u064a\u0621",
		"\u062a\u0639\u062f\u064a\u0644\u0627\u0644\u0639\u0631\u0636",
		"\u0627\u062a\u0645\u0627\u0645\u0627\u0644\u062d\u062c\u0632",
		"\u0625\u062a\u0645\u0627\u0645\u0627\u0644\u062d\u062c\u0632",
		"\u0646\u0639\u0645\u062a\u0627\u0628\u0639",
		"\u0646\u0639\u0645",
		"\u062a\u0645\u0627\u0645",
	]).has(compact);
}

function usableFullName(value = "") {
	const name = stripGuestNameFieldPrefix(cleanText(value, 120));
	if (!name || name.length < 4) return "";
	if (onlyDigits(name) || /^(?:guest|unknown|test|n\/a|na|null|none)$/i.test(name)) {
		return "";
	}
	if (looksLikeReservationActionName(name)) return "";
	if (rejectedAiGuestName(name)) return "";
	if (
		/(?:\u0644\u0627\s+\u0627\u0639\u0631\u0641|\u0644\u0627\s+\u0623\u0639\u0631\u0641|\u0645\u0634\s+\u0639\u0627\u0631\u0641|\u0645\u0634\s+\u0639\u0627\u0631\u0641\u0647|\u0627\u0643\u062a\u0628\u0647\s+\u0628\u0627\u0644\u0627\u0646\u062c\u0644\u064a\u0632)/i.test(
			name
		)
	) {
		return "";
	}
	const tokens = name
		.split(/\s+/)
		.filter((token) => /[A-Za-z\u0590-\u08FF\u0900-\u097F]{2,}/.test(token));
	const letterCount = (name.match(/[A-Za-z\u0590-\u08FF\u0900-\u097F]/g) || []).length;
	return tokens.length >= 2 || letterCount >= 8 ? name : "";
}

function roomCapacityForKey(roomTypeKey = "") {
	const capacities = {
		singleRooms: 1,
		doubleRooms: 2,
		tripleRooms: 3,
		quadRooms: 4,
		familyRooms: 5,
		suite: 6,
	};
	return capacities[String(roomTypeKey || "")] || 0;
}

function roomGuestCapacity(room = {}, roomTypeKey = "") {
	const verifiedCapacity = roomCapacity(room);
	if (verifiedCapacity > 0) return verifiedCapacity;
	const typeCapacity = roomCapacityForKey(
		roomTypeKey || room?.roomType || room?.room_type
	);
	const direct = normalizedGuestCount(
		room?.maxGuests ??
			room?.maxOccupancy ??
			room?.occupancy ??
			room?.capacity ??
			room?.roomCapacity,
		null
	);
	if (Number.isFinite(direct) && direct > 0 && direct <= 30) {
		return Math.floor(direct);
	}
	if (typeCapacity) return typeCapacity;
	const bedsCount = normalizedGuestCount(room?.bedsCount, null);
	if (Number.isFinite(bedsCount) && bedsCount > 0 && bedsCount <= 30) {
		return Math.floor(bedsCount);
	}
	return 0;
}

function matchingHotelRoom(
	hotel = {},
	roomTypeKey = "",
	displayName = "",
	roomId = ""
) {
	const rooms = Array.isArray(hotel?.roomCountDetails) ? hotel.roomCountDetails : [];
	const activeRooms = rooms.filter((item) => item && item.activeRoom !== false);
	return (
		activeRooms.find(
			(item) => roomId && String(item._id || "") === String(roomId)
		) ||
		activeRooms.find((item) => displayName && item.displayName === displayName) ||
		activeRooms.find((item) => roomTypeKey && item.roomType === roomTypeKey) ||
		null
	);
}

function selectedRoomGuestCapacity({ hotel = {}, slots = {}, quoteData = {}, room = null } = {}) {
	const quoteRooms = Array.isArray(quoteData?.rooms) ? quoteData.rooms : [];
	if (quoteRooms.length) {
		return quoteRooms.reduce((total, line = {}) => {
			const lineQuote = line.quote || {};
			const lineRoom = line.room || lineQuote.room || null;
			const roomTypeKey =
				line.roomTypeKey ||
				lineRoom?.roomType ||
				lineRoom?.room_type ||
				lineQuote.roomTypeKey ||
				lineQuote.roomType ||
				"";
			const displayName = lineRoom?.displayName || lineQuote.roomLabel || line.roomLabel || "";
			const hotelRoom =
				lineRoom ||
				matchingHotelRoom(
					hotel,
					roomTypeKey,
					displayName,
					line.roomId || lineQuote.roomId
				) ||
				{};
			const capacity = roomGuestCapacity(hotelRoom, roomTypeKey);
			const count = roomSelectionCount(line.count ?? line.rooms ?? line.quantity, 1);
			return capacity > 0 ? total + capacity * count : total;
		}, 0);
	}
	const roomTypeKey =
		slots.roomTypeKey ||
		quoteData.roomTypeKey ||
		room?.roomType ||
		room?.room_type ||
		"";
	const hotelRoom =
		room ||
		matchingHotelRoom(hotel, roomTypeKey, quoteData.roomLabel || quoteData.displayName || "") ||
		{};
	const capacity = roomGuestCapacity(hotelRoom, roomTypeKey);
	if (!capacity) return 0;
	return capacity * roomSelectionCount(slots.rooms, 1);
}

function assertGuestCountFitsSelectedRooms({ hotel, slots, quoteData, room, guest }) {
	const totalGuests = Number(guest?.adults || 0) + Number(guest?.children || 0);
	const capacity = selectedRoomGuestCapacity({ hotel, slots, quoteData, room });
	if (capacity > 0 && totalGuests > capacity) {
		throw new Error(
			`AI reservation guest count exceeds selected room capacity: ${totalGuests} guests for capacity ${capacity}.`
		);
	}
}

function assertQuoteWithinPhysicalInventory({ hotel = {}, slots = {}, quoteData = {}, room = null } = {}) {
	const quoteRooms = Array.isArray(quoteData?.rooms) ? quoteData.rooms : [];
	const lines = quoteRooms.length
		? quoteRooms
		: [
				{
					room,
					roomId: room?._id,
					roomTypeKey: room?.roomType || slots.roomTypeKey,
					count: slots.rooms || 1,
				},
		  ];
	const usedByRoomId = new Map();
	for (const line of lines) {
		const lineQuote = line?.quote || {};
		const embeddedRoom = line?.room || lineQuote.room || null;
		const resolvedRoom =
			embeddedRoom ||
			resolveRoomForStay(hotel, {
				roomId: line?.roomId || lineQuote.roomId,
				displayName:
					line?.roomDisplayName ||
					line?.roomLabel ||
					lineQuote.roomDisplayName ||
					lineQuote.roomLabel,
				roomType:
					line?.roomTypeKey ||
					line?.roomType ||
					lineQuote.roomTypeKey ||
					lineQuote.roomType,
			});
		if (!resolvedRoom) {
			throw new Error("AI reservation room configuration is no longer active.");
		}
		const roomId = String(resolvedRoom._id || "").trim();
		if (!roomId) {
			throw new Error("AI reservation room configuration has no stable room ID.");
		}
		const configuredUnits = roomSellableInventory(resolvedRoom);
		if (configuredUnits < 1) {
			throw new Error("AI reservation room configuration has no physical sellable units.");
		}
		if (roomCapacity(resolvedRoom) < 1) {
			throw new Error("AI reservation room capacity requires management verification.");
		}
		const nextUsed =
			Number(usedByRoomId.get(roomId) || 0) +
			roomSelectionCount(line?.count ?? line?.rooms ?? line?.quantity, 1);
		if (nextUsed > configuredUnits) {
			throw new Error(
				`AI reservation exceeds physical room inventory for ${resolvedRoom.displayName || resolvedRoom.roomType}: requested ${nextUsed}, configured ${configuredUnits}.`
			);
		}
		usedByRoomId.set(roomId, nextUsed);
	}
}

function normalizedGuestCount(value, fallback = null) {
	const normalized = digitsToEnglish(String(value ?? "")).replace(/[^\d.-]/g, "");
	const number = Number(normalized);
	return Number.isFinite(number) ? number : fallback;
}

function validateRequiredGuestDetails(slots = {}) {
	const name = usableFullName(slots.fullName || slots.name || "");
	const phone = onlyDigits(slots.phone || "");
	const nationality = cleanText(slots.nationality || "", 80);
	const adults = normalizedGuestCount(slots.adults, null);
	const children = normalizedGuestCount(slots.children, null);
	const missing = [];
	if (!name) missing.push("full name");
	if (!phone || phone.length < 5) missing.push("phone");
	if (!nationality) missing.push("nationality");
	if (!Number.isFinite(adults) || adults < 1) missing.push("adults count");
	if (!Number.isFinite(children) || children < 0) missing.push("children count");
	if (missing.length) {
		throw new Error(`AI reservation is missing required guest details: ${missing.join(", ")}.`);
	}
	return {
		name,
		phone,
		email: asciiize(slots.email || "").trim().toLowerCase(),
		nationality: asciiize(nationality).trim() || nationality,
		adults,
		children,
		rooms: Math.max(1, normalizedGuestCount(slots.rooms, 1)),
	};
}

function generateReservationConfirmationCandidate() {
	return String(Math.floor(1000000000 + Math.random() * 9000000000));
}

async function confirmationNumberExists(candidate) {
	const [existsInReservations, existsInPending] = await Promise.all([
		Reservations.exists({ confirmation_number: candidate })
			.maxTimeMS(AI_RESERVATION_QUERY_MAX_TIME_MS)
			.exec(),
		UncompleteReservations.exists({ confirmation_number: candidate })
			.maxTimeMS(AI_RESERVATION_QUERY_MAX_TIME_MS)
			.exec(),
	]);
	return Boolean(existsInReservations || existsInPending);
}

async function uniqueConfirmation() {
	const tries = 30;
	for (let i = 0; i < tries; i += 1) {
		const candidate = generateReservationConfirmationCandidate();
		if (!(await confirmationNumberExists(candidate))) return candidate;
	}
	const fallback = `${Date.now()}`.slice(-10).padStart(10, "1");
	if (!(await confirmationNumberExists(fallback))) return fallback;
	throw new Error("Could not generate a unique reservation confirmation number.");
}

function clonePricingRows(rows) {
	// exact daily structure as in OrderTaker
	return (rows || []).map((d) => ({
		date: d.date, // YYYY-MM-DD
		price: Number(d.price),
		rootPrice: Number(d.rootPrice),
		commissionRate: Number(d.commissionRate),
		totalPriceWithCommission: Number(d.totalPriceWithCommission),
		totalPriceWithoutCommission: Number(d.totalPriceWithoutCommission),
	}));
}

function buildPickedRoomsType({ room, dailyRows, count = 1 }) {
	const totalWith = dailyRows.reduce(
		(a, d) => a + Number(d.totalPriceWithCommission),
		0
	);
	const totalRoot = dailyRows.reduce((a, d) => a + Number(d.rootPrice), 0);
	const nights = Math.max(1, dailyRows.length);
	const chosenAvg = nights > 0 ? totalWith / nights : 0;

	const oneEntry = () => ({
		hotelRoomConfigId: String(room._id || "").trim(),
		room_type: String(room.roomType || room._id || "unknown").trim(),
		displayName: String(room.displayName || room.roomType || "").trim(),
		chosenPrice: Number(chosenAvg.toFixed(2)).toFixed(2),
		count: 1,
		pricingByDay: clonePricingRows(dailyRows),
		totalPriceWithCommission: Number(totalWith.toFixed(2)),
		hotelShouldGet: Number(totalRoot.toFixed(2)),
	});

	// Flatten one object per room count
	return Array.from({ length: Math.max(1, Number(count)) }, () => oneEntry());
}

function roomSelectionCount(value, fallback = 1) {
	const number = Number(String(value ?? "").replace(/[^\d.-]/g, ""));
	if (!Number.isFinite(number)) return fallback;
	return Math.min(50, Math.max(1, Math.floor(number)));
}

function buildPickedRoomsTypeFromQuote({ quoteData = {}, room = null, count = 1 }) {
	const quoteRooms = Array.isArray(quoteData.rooms) ? quoteData.rooms : [];
	if (quoteRooms.length) {
		return quoteRooms.flatMap((line = {}) => {
			const lineQuote = line.quote || {};
			const lineRoom = line.room || lineQuote.room || null;
			const lineRows = Array.isArray(line.pricingByDay)
				? line.pricingByDay
				: Array.isArray(lineQuote.pricingByDay)
				? lineQuote.pricingByDay
				: [];
			if (!lineRoom || !lineRows.length) return [];
			return buildPickedRoomsType({
				room: lineRoom,
				dailyRows: lineRows,
				count: roomSelectionCount(line.count, 1),
			});
		});
	}
	const dailyRows = Array.isArray(quoteData?.rows)
		? quoteData.rows
		: Array.isArray(quoteData?.pricingByDay)
		? quoteData.pricingByDay
		: [];
	return buildPickedRoomsType({
		room,
		dailyRows,
		count,
	});
}

function sumPickedRooms(picked) {
	let totalWith = 0;
	let totalRoot = 0;
	for (const r of picked) {
		totalWith += Number(r.totalPriceWithCommission || 0);
		totalRoot += Number(r.hotelShouldGet || 0);
	}
	return {
		total_amount: Number(totalWith.toFixed(2)),
		commission: Number((totalWith - totalRoot).toFixed(2)),
	};
}

function normalizeId(value = "") {
	return String(value?._id || value || "").trim();
}

function todayISO() {
	return new Date().toISOString().slice(0, 10);
}

function dateOnlyISO(value = "") {
	if (!value) return "";
	if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) {
		return value.slice(0, 10);
	}
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

function addDaysISO(iso, days) {
	const date = new Date(`${iso}T00:00:00.000Z`);
	if (Number.isNaN(date.getTime())) return "";
	date.setUTCDate(date.getUTCDate() + Number(days || 0));
	return date.toISOString().slice(0, 10);
}

function nightsBetweenISO(checkinISO, checkoutISO) {
	const start = Date.parse(`${checkinISO}T00:00:00.000Z`);
	const end = Date.parse(`${checkoutISO}T00:00:00.000Z`);
	if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
	return Math.round((end - start) / DAY_MS);
}

function reservationUpdatePricingDateKeys(checkinISO, checkoutISO) {
	const nights = nightsBetweenISO(checkinISO, checkoutISO);
	if (!nights || nights > 90) return [];
	return Array.from({ length: nights }, (_unused, index) =>
		addDaysISO(checkinISO, index)
	).filter(Boolean);
}

function moneyValue(value) {
	if (value === null || value === undefined || value === "") return null;
	const number = Number(value);
	return Number.isFinite(number) ? Number(number.toFixed(2)) : null;
}

function quoteChangedBeforeInsertError(reason = "quote_changed", details = {}) {
	const error = new Error(
		"The hotel room, availability, or price changed during final verification. A fresh quote and review are required before creating the reservation."
	);
	error.code = "AI_RESERVATION_REQUOTE_REQUIRED";
	error.reason = reason;
	error.details = details;
	return error;
}

function quotedRoomId(line = {}, fallbackRoom = null) {
	const lineQuote = line?.quote || {};
	return String(
		line?.roomId ||
			line?.hotelRoomConfigId ||
			line?.room?._id ||
			lineQuote?.roomId ||
			lineQuote?.room?._id ||
			fallbackRoom?._id ||
			""
	).trim();
}

function quotedPricingRows(line = {}, quoteData = {}) {
	const lineQuote = line?.quote || {};
	if (Array.isArray(line?.pricingByDay)) return line.pricingByDay;
	if (Array.isArray(lineQuote?.pricingByDay)) return lineQuote.pricingByDay;
	if (Array.isArray(quoteData?.rows)) return quoteData.rows;
	if (Array.isArray(quoteData?.pricingByDay)) return quoteData.pricingByDay;
	return [];
}

function quoteLinesForFinalVerification({ quoteData = {}, room = null, slots = {} } = {}) {
	if (Array.isArray(quoteData?.rooms) && quoteData.rooms.length) {
		return quoteData.rooms;
	}
	return [
		{
			roomId: quoteData?.room?._id || room?._id,
			room: quoteData?.room || room,
			roomTypeKey: quoteData?.roomTypeKey || room?.roomType || slots?.roomTypeKey,
			count: quoteData?.totalRooms || quoteData?.roomCount || slots?.rooms || 1,
			pricingByDay: quoteData?.rows || quoteData?.pricingByDay || [],
			quote: quoteData,
		},
	];
}

function assertFinalQuoteMoneyEqual(actual, expected, reason, details = {}) {
	const actualMoney = moneyValue(actual);
	const expectedMoney = moneyValue(expected);
	if (
		actualMoney === null ||
		expectedMoney === null ||
		actualMoney !== expectedMoney
	) {
		throw quoteChangedBeforeInsertError(reason, {
			...details,
			expected: expectedMoney,
			actual: actualMoney,
		});
	}
}

async function revalidateQuoteImmediatelyBeforeInsert({
	hotel = {},
	slots = {},
	quoteData = {},
	room = null,
	loadHotel = getHotelByIdWithPricingDates,
} = {}) {
	const hotelId = normalizeId(hotel?._id);
	const dateKeys = reservationUpdatePricingDateKeys(
		slots.checkinISO,
		slots.checkoutISO
	);
	if (!hotelId || !dateKeys.length) {
		throw quoteChangedBeforeInsertError("invalid_hotel_or_dates", {
			hotelId,
			checkinISO: slots.checkinISO || "",
			checkoutISO: slots.checkoutISO || "",
		});
	}
	const freshHotel = await loadHotel(hotelId, dateKeys);
	if (!freshHotel || normalizeId(freshHotel._id) !== hotelId) {
		throw quoteChangedBeforeInsertError("fresh_hotel_missing_or_mismatched", {
			hotelId,
		});
	}
	const freshRooms = Array.isArray(freshHotel.roomCountDetails)
		? freshHotel.roomCountDetails
		: [];
	const quoteLines = quoteLinesForFinalVerification({ quoteData, room, slots });
	if (!quoteLines.length) {
		throw quoteChangedBeforeInsertError("quote_room_lines_missing");
	}

	const usedByRoomId = new Map();
	let totalRooms = 0;
	let totalGuestPrice = 0;
	let totalHotelShouldGet = 0;
	for (let lineIndex = 0; lineIndex < quoteLines.length; lineIndex += 1) {
		const line = quoteLines[lineIndex] || {};
		const roomId = quotedRoomId(line, room);
		if (!roomId) {
			throw quoteChangedBeforeInsertError("quote_room_id_missing", { lineIndex });
		}
		const expectedRoom = line?.room || line?.quote?.room || (lineIndex === 0 ? room : null);
		if (!expectedRoom || String(expectedRoom._id || "").trim() !== roomId) {
			throw quoteChangedBeforeInsertError("quote_room_snapshot_missing_or_mismatched", {
				lineIndex,
				roomId,
			});
		}
		const freshRoom = freshRooms.find(
			(candidate) => String(candidate?._id || "").trim() === roomId
		);
		if (!freshRoom || !roomIsSellable(freshRoom)) {
			throw quoteChangedBeforeInsertError("room_no_longer_sellable", {
				lineIndex,
				roomId,
			});
		}
		if (!roomIsSellable(expectedRoom)) {
			throw quoteChangedBeforeInsertError("reviewed_room_snapshot_not_sellable", {
				lineIndex,
				roomId,
			});
		}

		const expectedInventory = roomSellableInventory(expectedRoom);
		const freshInventory = roomSellableInventory(freshRoom);
		if (freshInventory !== expectedInventory) {
			throw quoteChangedBeforeInsertError("physical_inventory_changed", {
				lineIndex,
				roomId,
				expectedInventory,
				freshInventory,
			});
		}
		const expectedCapacity = roomCapacity(expectedRoom);
		const freshCapacity = roomCapacity(freshRoom);
		if (freshCapacity !== expectedCapacity) {
			throw quoteChangedBeforeInsertError("room_capacity_changed", {
				lineIndex,
				roomId,
				expectedCapacity,
				freshCapacity,
			});
		}
		assertFinalQuoteMoneyEqual(
			freshRoom?.price?.basePrice,
			expectedRoom?.price?.basePrice,
			"room_base_price_changed",
			{ lineIndex, roomId }
		);

		const count = roomSelectionCount(
			line?.count ?? line?.rooms ?? line?.quantity,
			1
		);
		const nextUsed = Number(usedByRoomId.get(roomId) || 0) + count;
		if (nextUsed > freshInventory) {
			throw quoteChangedBeforeInsertError("physical_inventory_exceeded", {
				lineIndex,
				roomId,
				requested: nextUsed,
				available: freshInventory,
			});
		}
		usedByRoomId.set(roomId, nextUsed);
		totalRooms += count;

		const freshQuote = priceRoomForStay(
			freshHotel,
			{ roomId, roomType: freshRoom.roomType, displayName: freshRoom.displayName },
			slots.checkinISO,
			slots.checkoutISO
		);
		if (!freshQuote?.available) {
			throw quoteChangedBeforeInsertError("room_became_unavailable", {
				lineIndex,
				roomId,
				reason: freshQuote?.reason || "not_available",
				firstBlockedDate: freshQuote?.firstBlockedDate || "",
			});
		}
		const expectedRows = quotedPricingRows(line, quoteData);
		const freshRows = Array.isArray(freshQuote.pricingByDay)
			? freshQuote.pricingByDay
			: [];
		if (expectedRows.length !== dateKeys.length || freshRows.length !== dateKeys.length) {
			throw quoteChangedBeforeInsertError("nightly_pricing_length_changed", {
				lineIndex,
				roomId,
				expectedRows: expectedRows.length,
				freshRows: freshRows.length,
				nights: dateKeys.length,
			});
		}
		for (let nightIndex = 0; nightIndex < dateKeys.length; nightIndex += 1) {
			const expectedRow = expectedRows[nightIndex] || {};
			const freshRow = freshRows[nightIndex] || {};
			const date = dateKeys[nightIndex];
			if (String(expectedRow.date || "") !== date || String(freshRow.date || "") !== date) {
				throw quoteChangedBeforeInsertError("nightly_pricing_date_changed", {
					lineIndex,
					nightIndex,
					roomId,
					date,
				});
			}
			for (const field of [
				"price",
				"rootPrice",
				"commissionRate",
				"totalPriceWithCommission",
				"totalPriceWithoutCommission",
			]) {
				assertFinalQuoteMoneyEqual(
					freshRow[field],
					expectedRow[field],
					"nightly_pricing_changed",
					{ lineIndex, nightIndex, roomId, date, field }
				);
			}
		}

		const freshOneRoomTotal = moneyValue(
			freshQuote?.totals?.totalPriceWithCommission
		);
		const freshOneRoomRoot = moneyValue(freshQuote?.totals?.hotelShouldGet);
		if (freshOneRoomTotal === null || freshOneRoomRoot === null) {
			throw quoteChangedBeforeInsertError("fresh_quote_totals_missing", {
				lineIndex,
				roomId,
			});
		}
		totalGuestPrice += freshOneRoomTotal * count;
		totalHotelShouldGet += freshOneRoomRoot * count;
	}

	const quotedRoomCount = Number(
		quoteData?.totalRooms ?? quoteData?.roomCount ?? totalRooms
	);
	if (!Number.isFinite(quotedRoomCount) || quotedRoomCount !== totalRooms) {
		throw quoteChangedBeforeInsertError("quoted_room_count_changed", {
			expected: quotedRoomCount,
			actual: totalRooms,
		});
	}
	const freshTotal = moneyValue(totalGuestPrice);
	const freshHotelShouldGet = moneyValue(totalHotelShouldGet);
	const freshCommission = moneyValue(totalGuestPrice - totalHotelShouldGet);
	assertFinalQuoteMoneyEqual(
		freshTotal,
		quoteData?.total ?? quoteData?.totals?.totalPriceWithCommission,
		"quote_total_changed"
	);
	if (quoteData?.totals && Object.prototype.hasOwnProperty.call(quoteData.totals, "hotelShouldGet")) {
		assertFinalQuoteMoneyEqual(
			freshHotelShouldGet,
			quoteData.totals.hotelShouldGet,
			"quote_hotel_settlement_changed"
		);
	}
	if (quoteData?.totals && Object.prototype.hasOwnProperty.call(quoteData.totals, "totalCommission")) {
		assertFinalQuoteMoneyEqual(
			freshCommission,
			quoteData.totals.totalCommission,
			"quote_commission_changed"
		);
	}

	return {
		freshHotel,
		dateKeys,
		totalRooms,
		total: freshTotal,
		hotelShouldGet: freshHotelShouldGet,
		commission: freshCommission,
	};
}

function roomToken(value = "") {
	return String(value || "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "");
}

function reservationLifecycleBlocksAiUpdate(reservation = {}) {
	const status = String(reservation.reservation_status || reservation.state || "")
		.toLowerCase()
		.replace(/[_-]+/g, " ");
	return /\b(cancelled|canceled|no show|checked out|inhouse|in house|rejected)\b/.test(
		status
	);
}

function reservationLifecycleStatus(reservation = {}) {
	return String(reservation.reservation_status || reservation.state || "")
		.toLowerCase()
		.replace(/[_-]+/g, " ")
		.trim();
}

function asValidDate(value) {
	if (!value) return null;
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}

function reservationConfirmationAge(reservation = {}, now = new Date()) {
	const pendingStatus = String(reservation.pendingConfirmation?.status || "")
		.toLowerCase()
		.trim();
	const decisionStatus = String(reservation.agentDecisionSnapshot?.status || "")
		.toLowerCase()
		.trim();
	const lifecycleStatus = reservationLifecycleStatus(reservation);
	const looksConfirmed =
		pendingStatus === "confirmed" ||
		decisionStatus === "confirmed" ||
		/\bconfirmed\b/.test(lifecycleStatus);
	const candidates = [
		{
			value: reservation.pendingConfirmation?.confirmedAt,
			source: "pendingConfirmation.confirmedAt",
			requiresConfirmed: false,
		},
		{
			value: reservation.agentDecisionSnapshot?.decidedAt,
			source: "agentDecisionSnapshot.decidedAt",
			requiresConfirmed: true,
		},
		{
			value: reservation.booked_at,
			source: "booked_at",
			requiresConfirmed: true,
		},
		{
			value: reservation.createdAt,
			source: "createdAt",
			requiresConfirmed: true,
		},
	];
	const nowDate = asValidDate(now) || new Date();
	for (const candidate of candidates) {
		if (candidate.requiresConfirmed && !looksConfirmed) continue;
		const date = asValidDate(candidate.value);
		if (!date) continue;
		const ageDays = Math.max(
			0,
			Math.floor((nowDate.getTime() - date.getTime()) / DAY_MS)
		);
		return {
			confirmedAt: date,
			confirmedAtSource: candidate.source,
			ageDays,
			looksConfirmed,
		};
	}
	return {
		confirmedAt: null,
		confirmedAtSource: "",
		ageDays: null,
		looksConfirmed,
	};
}

function reservationDaysBeforeCheckin(reservation = {}, now = new Date()) {
	const checkinISO = dateOnlyISO(reservation.checkin_date);
	const today = dateOnlyISO(now);
	if (!checkinISO || !today) return { checkinISO, daysBeforeCheckin: null };
	const checkinMs = Date.parse(`${checkinISO}T00:00:00.000Z`);
	const todayMs = Date.parse(`${today}T00:00:00.000Z`);
	if (!Number.isFinite(checkinMs) || !Number.isFinite(todayMs)) {
		return { checkinISO, daysBeforeCheckin: null };
	}
	return {
		checkinISO,
		daysBeforeCheckin: Math.ceil((checkinMs - todayMs) / DAY_MS),
	};
}

function reservationOneNightAmount(reservation = {}) {
	const total = Number(reservation.total_amount || 0);
	if (!Number.isFinite(total) || total <= 0) return null;
	const nights = nightsBetweenISO(
		dateOnlyISO(reservation.checkin_date),
		dateOnlyISO(reservation.checkout_date)
	);
	if (!Number.isFinite(nights) || nights <= 0) return null;
	return Number((total / nights).toFixed(2));
}

function reservationCancellationTerminalStatus(reservation = {}) {
	const status = reservationLifecycleStatus(reservation);
	if (/\b(cancelled|canceled)\b/.test(status)) return "already_cancelled";
	if (/\b(no show|checked out|inhouse|in house|rejected)\b/.test(status)) {
		return "locked_status";
	}
	const pendingStatus = String(reservation.pendingConfirmation?.status || "")
		.toLowerCase()
		.trim();
	if (/^(cancelled|canceled)$/.test(pendingStatus)) return "already_cancelled";
	if (/^(rejected)$/.test(pendingStatus)) return "locked_status";
	return "";
}

async function getReservationCancellationPolicyForCase({
	confirmation,
	hotel = null,
	now = new Date(),
} = {}) {
	const normalizedConfirmation = String(confirmation || "").trim().toLowerCase();
	if (!normalizedConfirmation) return { ok: false, code: "missing_confirmation" };
	const reservation = await Reservations.findOne({
		confirmation_number: normalizedConfirmation,
	})
		.select(
			"_id confirmation_number hotelId belongsTo reservation_status state pendingConfirmation agentDecisionSnapshot booked_at createdAt checkin_date checkout_date customer_details total_amount financial_cycle commissionAgentApproval"
		)
		.lean()
		.exec();
	if (!reservation) return { ok: false, code: "not_found" };

	const reservationHotelId = normalizeId(reservation.hotelId);
	const activeHotelId = normalizeId(hotel?._id);
	if (activeHotelId && reservationHotelId && activeHotelId !== reservationHotelId) {
		return { ok: false, code: "hotel_mismatch", reservation };
	}

	const terminalCode = reservationCancellationTerminalStatus(reservation);
	if (terminalCode) {
		return { ok: false, code: terminalCode, reservation };
	}

	const thresholdDays = 14;
	const confirmationAge = reservationConfirmationAge(reservation, now);
	const checkinTiming = reservationDaysBeforeCheckin(reservation, now);
	const financeLocked =
		String(reservation.financial_cycle?.status || "").toLowerCase() === "closed" ||
		String(reservation.commissionAgentApproval?.status || "").toLowerCase() ===
			"approved";
	const base = {
		reservation,
		thresholdDays,
		financeLocked,
		oneNightAmount: reservationOneNightAmount(reservation),
		...confirmationAge,
		...checkinTiming,
	};

	if (!Number.isFinite(checkinTiming.daysBeforeCheckin)) {
		return {
			ok: true,
			code: "missing_checkin_date",
			eligibleForCancellation: false,
			refundPolicy: "needs_review",
			...base,
		};
	}

	if (checkinTiming.daysBeforeCheckin >= thresholdDays) {
		return {
			ok: true,
			code: "full_refund",
			eligibleForCancellation: true,
			refundPolicy: "full_refund",
			...base,
		};
	}

	if (checkinTiming.daysBeforeCheckin > 3) {
		return {
			ok: true,
			code: "one_night_fee",
			eligibleForCancellation: true,
			refundPolicy: "one_night_fee",
			...base,
		};
	}

	return {
		ok: true,
		code: "non_refundable",
		eligibleForCancellation: false,
		refundPolicy: "non_refundable",
		...base,
	};
}

function reservationRoomSelection(reservation = {}) {
	const picked = Array.isArray(reservation.pickedRoomsType)
		? reservation.pickedRoomsType
		: Array.isArray(reservation.pickedRoomsPricing)
		? reservation.pickedRoomsPricing
		: [];
	const rows = picked.filter(
		(row) =>
			row?.hotelRoomConfigId ||
			row?.roomId ||
			row?.room_type ||
			row?.roomType ||
			row?.displayName ||
			row?.display_name
	);
	if (!rows.length) {
		return { supported: false, reason: "missing_room_selection" };
	}
	const grouped = new Map();
	for (const row of rows) {
		const roomId = String(row.hotelRoomConfigId || row.roomId || "").trim();
		const roomType = String(row.room_type || row.roomType || "").trim();
		const displayName = String(row.displayName || row.display_name || "").trim();
		const legacyKey = `${roomToken(roomType)}|${roomToken(displayName)}`;
		const key = roomId ? `id:${roomId}` : `legacy:${legacyKey}`;
		const existing = grouped.get(key) || {
			roomId,
			hotelRoomConfigId: roomId,
			roomType,
			displayName,
			count: 0,
		};
		existing.count += roomSelectionCount(row.count, 1);
		grouped.set(key, existing);
	}
	if (grouped.size > 1) {
		return { supported: false, reason: "multiple_room_configurations" };
	}
	const selection = Array.from(grouped.values())[0] || {};
	return {
		supported: true,
		roomId: selection.roomId || "",
		hotelRoomConfigId: selection.hotelRoomConfigId || "",
		roomType: selection.roomType || "",
		displayName: selection.displayName || "",
		count: Math.max(
			1,
			Number(selection.count || 0) || Number(reservation.total_rooms || 1) || 1
		),
	};
}

function findHotelRoomForSelection(hotel = {}, selection = {}, roomTypeOverride = "") {
	const selectionRoomType = String(selection.roomType || "").trim();
	const explicitOverride = String(roomTypeOverride || "").trim();
	const overrideChangesRoomType = Boolean(
		explicitOverride &&
			roomToken(explicitOverride) !== roomToken(selectionRoomType)
	);
	const rawRoomType = explicitOverride || selectionRoomType;
	const rawDisplay = overrideChangesRoomType
		? ""
		: String(selection.displayName || "").trim();
	const stableRoomId = overrideChangesRoomType
		? ""
		: selection.roomId || selection.hotelRoomConfigId || selection._id;
	const resolved = resolveRoomForStay(hotel, {
		roomId: stableRoomId,
		roomType: rawRoomType,
		displayName: rawDisplay,
		requestedCapacity: selection.capacityGuests,
	});
	if (resolved) return resolved;
	const rooms = Array.isArray(hotel.roomCountDetails) ? hotel.roomCountDetails : [];
	const activeRooms = rooms.filter((room) => room?.activeRoom !== false);
	const typeToken = roomToken(rawRoomType);
	const displayToken = roomToken(rawDisplay);
	return (
		activeRooms.find((room) => roomToken(room.roomType) === typeToken) ||
		activeRooms.find((room) => roomToken(room.displayName) === displayToken) ||
		activeRooms.find((room) => {
			const roomTypeToken = roomToken(room.roomType);
			const roomDisplayToken = roomToken(room.displayName);
			return (
				(typeToken &&
					(roomTypeToken.includes(typeToken) ||
						typeToken.includes(roomTypeToken) ||
						roomDisplayToken.includes(typeToken))) ||
				(displayToken &&
					(roomDisplayToken.includes(displayToken) ||
						displayToken.includes(roomDisplayToken) ||
						roomTypeToken.includes(displayToken)))
			);
		}) ||
		null
	);
}

function inventoryFailureMessage(candidate = {}, fallback = "") {
	return (
		candidate?.inventoryValidation?.message ||
		candidate?.inventoryValidation?.issues?.[0]?.message ||
		candidate?.message ||
		fallback ||
		"Selected room is no longer available."
	);
}

async function buildReservationUpdateCandidate({
	reservation,
	hotel,
	selection,
	checkinISO,
	checkoutISO,
	roomTypeOverride = "",
}) {
	const nights = nightsBetweenISO(checkinISO, checkoutISO);
	if (!nights || nights > 90 || checkinISO < todayISO()) {
		return {
			allowed: false,
			code: "bad_dates",
			message: "The requested dates are not valid for an automatic update.",
		};
	}

	const room = findHotelRoomForSelection(hotel, selection, roomTypeOverride);
	if (!room) {
		return {
			allowed: false,
			code: "room_not_found",
			message: "The reservation room type could not be matched to active hotel inventory.",
		};
	}
	const configuredUnits = roomSellableInventory(room);
	if (configuredUnits < 1 || Number(selection.count || 1) > configuredUnits) {
		return {
			allowed: false,
			code: "physical_room_inventory_insufficient",
			message: `The requested room count exceeds the configured physical inventory (${configuredUnits}).`,
			room,
		};
	}

	const quote = priceRoomForStay(
		hotel,
		{ roomId: room._id, roomType: room.roomType, displayName: room.displayName },
		checkinISO,
		checkoutISO
	);
	if (!quote?.available) {
		return {
			allowed: false,
			code: quote?.reason || "pricing_unavailable",
			message: "The room is blocked or not priced for the requested dates.",
			room,
			quote,
		};
	}

	const pickedRoomsType = buildPickedRoomsType({
		room,
		dailyRows: quote.pricingByDay,
		count: selection.count,
	});
	const totals = sumPickedRooms(pickedRoomsType);
	const payload = {
		...reservation,
		hotelId: reservation.hotelId || hotel._id,
		hotelName: reservation.hotelName || hotel.hotelName,
		checkin_date: checkinISO,
		checkout_date: checkoutISO,
		days_of_residence: nights,
		total_rooms: selection.count,
		total_amount: totals.total_amount,
		commission: totals.commission,
		pickedRoomsType,
		pickedRoomsPricing: pickedRoomsType,
	};
	const inventoryValidation = await validateReservationInventoryForCreate(payload, {
		allowOverbook: true,
		excludeReservationId: reservation._id,
	});
	if (!inventoryValidation.allowed) {
		return {
			allowed: false,
			code: "inventory_unavailable",
			message: inventoryFailureMessage({ inventoryValidation }),
			room,
			quote,
			pickedRoomsType,
			totals,
			inventoryValidation,
		};
	}

	return {
		allowed: true,
		code: "available",
		room,
		quote,
		pickedRoomsType,
		totals,
		nights,
		inventoryValidation,
		payload,
	};
}

function reservationUpdateCandidateChange(reviewed = {}, refreshed = {}, selection = {}) {
	if (!reviewed?.allowed || !refreshed?.allowed) {
		return { changed: true, reason: "candidate_no_longer_allowed" };
	}
	const reviewedRoom = reviewed.room || {};
	const refreshedRoom = refreshed.room || {};
	const reviewedRoomId = String(reviewedRoom._id || "").trim();
	const refreshedRoomId = String(refreshedRoom._id || "").trim();
	if (!reviewedRoomId || reviewedRoomId !== refreshedRoomId) {
		return {
			changed: true,
			reason: "room_configuration_changed",
			reviewedRoomId,
			refreshedRoomId,
		};
	}
	if (!roomIsSellable(reviewedRoom) || !roomIsSellable(refreshedRoom)) {
		return { changed: true, reason: "room_sellability_changed", roomId: reviewedRoomId };
	}
	for (const [reason, reviewedValue, refreshedValue] of [
		[
			"physical_inventory_changed",
			roomSellableInventory(reviewedRoom),
			roomSellableInventory(refreshedRoom),
		],
		[
			"room_capacity_changed",
			roomCapacity(reviewedRoom),
			roomCapacity(refreshedRoom),
		],
		["room_type_changed", String(reviewedRoom.roomType || ""), String(refreshedRoom.roomType || "")],
		[
			"room_display_name_changed",
			String(reviewedRoom.displayName || ""),
			String(refreshedRoom.displayName || ""),
		],
		[
			"room_bed_configuration_changed",
			Number(reviewedRoom.bedsCount || 0),
			Number(refreshedRoom.bedsCount || 0),
		],
		[
			"room_gender_configuration_changed",
			String(reviewedRoom.roomForGender || ""),
			String(refreshedRoom.roomForGender || ""),
		],
	]) {
		if (reviewedValue !== refreshedValue) {
			return {
				changed: true,
				reason,
				roomId: reviewedRoomId,
				reviewedValue,
				refreshedValue,
			};
		}
	}
	if (
		moneyValue(reviewedRoom?.price?.basePrice) !==
		moneyValue(refreshedRoom?.price?.basePrice)
	) {
		return { changed: true, reason: "room_base_price_changed", roomId: reviewedRoomId };
	}

	const expectedCount = roomSelectionCount(selection.count, 1);
	const pickedRoomSummary = (candidate = {}) => {
		const rows = Array.isArray(candidate.pickedRoomsType)
			? candidate.pickedRoomsType
			: [];
		return {
			count: rows.reduce(
				(total, row) => total + roomSelectionCount(row?.count, 1),
				0
			),
			roomIds: [
				...new Set(
					rows
						.map((row) => String(row?.hotelRoomConfigId || "").trim())
						.filter(Boolean)
				),
			],
		};
	};
	const reviewedPicked = pickedRoomSummary(reviewed);
	const refreshedPicked = pickedRoomSummary(refreshed);
	if (
		reviewedPicked.count !== expectedCount ||
		refreshedPicked.count !== expectedCount ||
		reviewedPicked.roomIds.length !== 1 ||
		refreshedPicked.roomIds.length !== 1 ||
		reviewedPicked.roomIds[0] !== reviewedRoomId ||
		refreshedPicked.roomIds[0] !== refreshedRoomId
	) {
		return {
			changed: true,
			reason: "room_count_or_identity_changed",
			expectedCount,
			reviewedPicked,
			refreshedPicked,
		};
	}

	const reviewedQuote = reviewed.quote || {};
	const refreshedQuote = refreshed.quote || {};
	if (!reviewedQuote.available || !refreshedQuote.available) {
		return { changed: true, reason: "quote_became_unavailable" };
	}
	if (Number(reviewed.nights || 0) !== Number(refreshed.nights || 0)) {
		return { changed: true, reason: "stay_nights_changed" };
	}
	const reviewedRows = Array.isArray(reviewedQuote.pricingByDay)
		? reviewedQuote.pricingByDay
		: [];
	const refreshedRows = Array.isArray(refreshedQuote.pricingByDay)
		? refreshedQuote.pricingByDay
		: [];
	if (!reviewedRows.length || reviewedRows.length !== refreshedRows.length) {
		return { changed: true, reason: "nightly_pricing_length_changed" };
	}
	for (let index = 0; index < reviewedRows.length; index += 1) {
		const reviewedRow = reviewedRows[index] || {};
		const refreshedRow = refreshedRows[index] || {};
		if (String(reviewedRow.date || "") !== String(refreshedRow.date || "")) {
			return { changed: true, reason: "nightly_pricing_date_changed", index };
		}
		for (const field of [
			"price",
			"rootPrice",
			"commissionRate",
			"totalPriceWithCommission",
			"totalPriceWithoutCommission",
		]) {
			if (moneyValue(reviewedRow[field]) !== moneyValue(refreshedRow[field])) {
				return {
					changed: true,
					reason: "nightly_pricing_changed",
					index,
					field,
				};
			}
		}
	}
	for (const [reason, reviewedValue, refreshedValue] of [
		[
			"update_total_changed",
			reviewed?.totals?.total_amount,
			refreshed?.totals?.total_amount,
		],
		[
			"update_commission_changed",
			reviewed?.totals?.commission,
			refreshed?.totals?.commission,
		],
		[
			"update_hotel_settlement_changed",
			reviewedQuote?.totals?.hotelShouldGet,
			refreshedQuote?.totals?.hotelShouldGet,
		],
	]) {
		if (moneyValue(reviewedValue) !== moneyValue(refreshedValue)) {
			return { changed: true, reason };
		}
	}
	return { changed: false, reason: "" };
}

async function revalidateReservationUpdateImmediatelyBeforeMutation({
	reservation = {},
	selection = {},
	reviewedCandidate = {},
	hotelId = "",
	pricingDateKeys = [],
	checkinISO = "",
	checkoutISO = "",
	roomTypeOverride = "",
	loadHotel = getHotelByIdWithPricingDates,
	buildCandidate = buildReservationUpdateCandidate,
} = {}) {
	const expectedHotelId = normalizeId(hotelId || reservation.hotelId);
	const freshHotel = expectedHotelId
		? await loadHotel(expectedHotelId, pricingDateKeys)
		: null;
	if (
		!freshHotel ||
		normalizeId(freshHotel._id) !== expectedHotelId ||
		!Array.isArray(freshHotel.roomCountDetails)
	) {
		return {
			ok: false,
			code: "unavailable",
			requiresRequote: true,
			reason: "fresh_hotel_inventory_missing",
			message: "The hotel inventory changed before the update could be saved.",
		};
	}
	const refreshedCandidate = await buildCandidate({
		reservation,
		hotel: freshHotel,
		selection,
		checkinISO,
		checkoutISO,
		roomTypeOverride,
	});
	if (!refreshedCandidate?.allowed) {
		return {
			ok: false,
			code: "unavailable",
			requiresRequote: true,
			reason: refreshedCandidate?.code || "candidate_no_longer_available",
			message:
				refreshedCandidate?.message ||
				"The selected room or dates are no longer available for this update.",
			candidate: refreshedCandidate,
		};
	}
	const comparison = reservationUpdateCandidateChange(
		reviewedCandidate,
		refreshedCandidate,
		selection
	);
	if (comparison.changed) {
		return {
			ok: false,
			code: "requote_required",
			requiresRequote: true,
			reason: comparison.reason,
			message:
				"The room configuration or price changed during final verification. Please review a fresh quote before updating the reservation.",
			candidate: refreshedCandidate,
		};
	}
	return {
		ok: true,
		freshHotel,
		candidate: refreshedCandidate,
	};
}

function recommendationSummary(candidate, kind, checkinISO, checkoutISO) {
	return {
		kind,
		checkinISO,
		checkoutISO,
		nights: nightsBetweenISO(checkinISO, checkoutISO),
		roomType: candidate.room?.roomType || "",
		roomName: candidate.room?.displayName || candidate.room?.roomType || "",
		total: candidate.totals?.total_amount || 0,
		currency: candidate.quote?.currency || "SAR",
	};
}

async function findReservationUpdateRecommendations({
	reservation,
	hotel,
	selection,
	requestedCheckinISO,
	requestedCheckoutISO,
}) {
	const stayNights = nightsBetweenISO(requestedCheckinISO, requestedCheckoutISO);
	const sameRoomCloseDates = [];
	const alternativeRooms = [];
	const seen = new Set();
	const trySameRoom = async (checkinISO, checkoutISO, kind = "same_room_near_dates") => {
		if (!checkinISO || !checkoutISO || checkinISO >= checkoutISO) return;
		if (checkinISO < todayISO()) return;
		const key = `${checkinISO}|${checkoutISO}|${kind}`;
		if (seen.has(key) || sameRoomCloseDates.length >= 3) return;
		seen.add(key);
		const candidate = await buildReservationUpdateCandidate({
			reservation,
			hotel,
			selection,
			checkinISO,
			checkoutISO,
		});
		if (candidate.allowed) {
			sameRoomCloseDates.push(
				recommendationSummary(candidate, kind, checkinISO, checkoutISO)
			);
		}
	};

	if (stayNights > 0) {
		for (const offset of [-3, -2, -1, 1, 2, 3]) {
			await trySameRoom(
				addDaysISO(requestedCheckinISO, offset),
				addDaysISO(requestedCheckoutISO, offset)
			);
		}
		for (const offset of [-3, -2, -1, 1, 2, 3]) {
			await trySameRoom(
				addDaysISO(requestedCheckinISO, offset),
				requestedCheckoutISO,
				"same_room_adjust_checkin"
			);
			await trySameRoom(
				requestedCheckinISO,
				addDaysISO(requestedCheckoutISO, offset),
				"same_room_adjust_checkout"
			);
		}
	}

	const activeRooms = Array.isArray(hotel.roomCountDetails)
		? hotel.roomCountDetails.filter((room) => room?.activeRoom !== false)
		: [];
	const currentRoom = findHotelRoomForSelection(hotel, selection);
	for (const room of activeRooms) {
		if (alternativeRooms.length >= 3) break;
		if (currentRoom && roomToken(room.roomType) === roomToken(currentRoom.roomType)) {
			continue;
		}
		const candidate = await buildReservationUpdateCandidate({
			reservation,
			hotel,
			selection,
			checkinISO: requestedCheckinISO,
			checkoutISO: requestedCheckoutISO,
			roomTypeOverride: room.roomType,
		});
		if (candidate.allowed) {
			alternativeRooms.push(
				recommendationSummary(
					candidate,
					"alternative_room_same_dates",
					requestedCheckinISO,
					requestedCheckoutISO
				)
			);
		}
	}

	return { sameRoomCloseDates, alternativeRooms };
}

function emitAiReservationUpdateRefresh(io, reservation = {}, payload = {}) {
	if (!io) return;
	const hotelId = normalizeId(reservation.hotelId);
	if (!hotelId) return;
	const basePayload = {
		type: "pending_confirmation",
		source: "ai_chat_reservation_update",
		hotelId,
		reservationId: normalizeId(reservation._id),
		ownerId: normalizeId(reservation.belongsTo),
		confirmation_number: reservation.confirmation_number || "",
		emittedAt: new Date().toISOString(),
		...payload,
	};
	io.to(`hotel-notifications:${hotelId}`).emit(
		"hotelNotificationsUpdated",
		basePayload
	);
	io.to("platform-notifications").emit("hotelNotificationsUpdated", basePayload);
	if (basePayload.ownerId) {
		io.to(`owner-notifications:${basePayload.ownerId}`).emit(
			"hotelNotificationsUpdated",
			basePayload
		);
	}
	io.emit("reservationUpdated", basePayload);
}

async function updateReservationDatesForCase({
	caseId,
	hotel,
	confirmation,
	checkinISO,
	checkoutISO,
	roomTypeOverride = "",
	io = null,
	dryRun = false,
}) {
	const normalizedConfirmation = String(confirmation || "").trim().toLowerCase();
	if (!normalizedConfirmation) return { ok: false, code: "missing_confirmation" };
	const reservation = await Reservations.findOne({
		confirmation_number: normalizedConfirmation,
	})
		.lean()
		.exec();
	if (!reservation) return { ok: false, code: "not_found" };

	const reservationHotelId = normalizeId(reservation.hotelId);
	const suppliedHotelId = normalizeId(hotel?._id);
	if (
		reservationHotelId &&
		suppliedHotelId &&
		reservationHotelId !== suppliedHotelId
	) {
		return { ok: false, code: "hotel_mismatch", reservation };
	}
	const hydrationHotelId = reservationHotelId || suppliedHotelId;
	const pricingDateKeys = reservationUpdatePricingDateKeys(checkinISO, checkoutISO);
	if (!pricingDateKeys.length) {
		return { ok: false, code: "bad_dates", reservation };
	}
	let activeHotel = null;
	if (hydrationHotelId && pricingDateKeys.length) {
		activeHotel = await getHotelByIdWithPricingDates(
			hydrationHotelId,
			pricingDateKeys
		);
	}
	const activeHotelId = normalizeId(activeHotel?._id);
	if (activeHotelId && reservationHotelId && activeHotelId !== reservationHotelId) {
		return { ok: false, code: "hotel_mismatch", reservation };
	}
	if (!activeHotel || !Array.isArray(activeHotel.roomCountDetails)) {
		return { ok: false, code: "hotel_inventory_missing", reservation };
	}
	if (reservationLifecycleBlocksAiUpdate(reservation)) {
		return { ok: false, code: "unsupported_status", reservation };
	}

	const selection = reservationRoomSelection(reservation);
	if (!selection.supported) {
		return { ok: false, code: selection.reason || "unsupported_room_selection", reservation };
	}

	const candidate = await buildReservationUpdateCandidate({
		reservation,
		hotel: activeHotel,
		selection,
		checkinISO,
		checkoutISO,
		roomTypeOverride,
	});
	if (!candidate.allowed) {
		const recommendations = await findReservationUpdateRecommendations({
			reservation,
			hotel: activeHotel,
			selection,
			requestedCheckinISO: checkinISO,
			requestedCheckoutISO: checkoutISO,
		});
		return {
			ok: false,
			code: "unavailable",
			message: inventoryFailureMessage(candidate),
			reservation,
			selection,
			requested: { checkinISO, checkoutISO },
			recommendations,
		};
	}

	const now = new Date();
	const existingCycle =
		reservation.financial_cycle && typeof reservation.financial_cycle === "object"
			? reservation.financial_cycle
			: {};
	const rootTotal = candidate.pickedRoomsType.reduce(
		(total, row) => total + Number(row.hotelShouldGet || 0),
		0
	);
	const existingAdminPricing =
		reservation.adminPricing && typeof reservation.adminPricing === "object"
			? reservation.adminPricing
			: {};
	const updateFields = {
		checkin_date: checkinISO,
		checkout_date: checkoutISO,
		days_of_residence: candidate.nights,
		total_rooms: selection.count,
		total_amount: candidate.totals.total_amount,
		commission: candidate.totals.commission,
		pickedRoomsType: candidate.pickedRoomsType,
		pickedRoomsPricing: candidate.pickedRoomsType,
		adminPricing: {
			...existingAdminPricing,
			mode: existingAdminPricing.mode || "standard",
			clientTotal: candidate.totals.total_amount,
			rootTotal: Number(rootTotal.toFixed(2)),
			platformMarginTotal: candidate.totals.commission,
		},
		agentDecisionSnapshot: {
			status: "pending",
			reason: "AI chat updated reservation dates after availability check.",
			decidedAt: now,
			decidedBy: AI_RESERVATION_ACTOR,
			lastUpdatedAt: now,
			lastUpdatedBy: AI_RESERVATION_ACTOR,
		},
		pendingConfirmation:
			reservation.pendingConfirmation && typeof reservation.pendingConfirmation === "object"
				? reservation.pendingConfirmation
				: {},
		financial_cycle: {
			...existingCycle,
			status: "open",
			totalReviewStatus: "pending",
			totalRejectionReason: "",
			financeRejectionType: "",
			financeRejectionLabel: "",
			financeRejectionComment: "",
			amountReviewStatus: "pending",
			lastUpdatedAt: now,
			lastUpdatedBy: AI_RESERVATION_ACTOR,
		},
		adminLastUpdatedAt: now,
		adminLastUpdatedBy: {
			name: AI_RESERVATION_ACTOR.name,
			role: AI_RESERVATION_ACTOR.role,
		},
		updatedAt: now,
	};
	markReservationPendingConfirmation(updateFields, {
		actor: AI_RESERVATION_ACTOR,
		source: "ai_chat_reservation_update",
		operationalStatus: true,
		clientVisibleStatus: "confirmed",
		inventoryBlocks: true,
		now,
	});
	captureReservationAvailabilitySnapshot(
		updateFields,
		candidate.inventoryValidation,
		"ai_chat_reservation_update"
	);

	const auditEntry = {
		at: now,
		by: AI_RESERVATION_ACTOR,
		action: "ai_chat_reservation_date_update",
		source: "ai_chat",
		note: "AI chat updated the reservation after checking room availability.",
		from: {
			checkin_date: dateOnlyISO(reservation.checkin_date),
			checkout_date: dateOnlyISO(reservation.checkout_date),
			total_amount: reservation.total_amount || 0,
			roomType: selection.roomType,
		},
		to: {
			checkin_date: checkinISO,
			checkout_date: checkoutISO,
			total_amount: candidate.totals.total_amount,
			roomType: candidate.room?.roomType || selection.roomType,
		},
		supportCaseId: caseId ? String(caseId) : "",
	};
	const adminChangeEntry = {
		at: now,
		by: {
			name: AI_RESERVATION_ACTOR.name,
			role: AI_RESERVATION_ACTOR.role,
		},
		field: "reservation_dates",
		from: `${dateOnlyISO(reservation.checkin_date)} - ${dateOnlyISO(
			reservation.checkout_date
		)}`,
		to: `${checkinISO} - ${checkoutISO}`,
		note: "AI chat availability-checked date update; reservation returned to pending confirmation.",
	};

	if (dryRun) {
		return {
			ok: true,
			dryRun: true,
			reservation: {
				...reservation,
				...updateFields,
			},
			previousReservation: reservation,
			selection,
			quote: candidate.quote,
			checkinISO,
			checkoutISO,
		};
	}
	const finalUpdateVerification = await revalidateReservationUpdateImmediatelyBeforeMutation({
		reservation,
		selection,
		reviewedCandidate: candidate,
		hotelId: hydrationHotelId,
		pricingDateKeys,
		checkinISO,
		checkoutISO,
		roomTypeOverride,
	});
	if (!finalUpdateVerification.ok) {
		return {
			ok: false,
			code: finalUpdateVerification.code,
			requiresRequote: true,
			reason: finalUpdateVerification.reason,
			message: finalUpdateVerification.message,
			reservation,
			selection,
			requested: { checkinISO, checkoutISO },
			quote: finalUpdateVerification.candidate?.quote || candidate.quote,
		};
	}

	const updatedReservation = await Reservations.findByIdAndUpdate(
		reservation._id,
		{
			$set: updateFields,
			$push: {
				reservationAuditLog: auditEntry,
				adminChangeLog: adminChangeEntry,
			},
		},
		{ new: true }
	)
		.lean()
		.exec();

	emitAiReservationUpdateRefresh(io, updatedReservation, {
		reason: "ai_chat_reservation_update",
	});
	log(caseId, "reservation.updated", {
		reservationId: normalizeId(updatedReservation?._id),
		confirmation: updatedReservation?.confirmation_number,
		checkinISO,
		checkoutISO,
		total: updatedReservation?.total_amount,
	});

	return {
		ok: true,
		reservation: updatedReservation,
		previousReservation: reservation,
		selection,
		quote: candidate.quote,
		checkinISO,
		checkoutISO,
	};
}

function cleanCaseId(value = "") {
	return String(value || "").trim();
}

function aiReservationFingerprint({ caseId, hotel, slots, quoteData, room, guest }) {
	const parts = [
		cleanCaseId(caseId),
		String(hotel?._id || ""),
		String(slots?.checkinISO || ""),
		String(slots?.checkoutISO || ""),
		String(slots?.roomTypeKey || room?.roomType || room?._id || ""),
		String(
			quoteData?.selectionKey ||
				(Array.isArray(quoteData?.roomSelections)
					? quoteData.roomSelections
							.map((selection) =>
								[
									selection?.roomTypeKey || selection?.roomType || "",
									selection?.count || 1,
								].join(":")
							)
							.join("+")
					: "")
		),
		String(guest?.name || slots?.fullName || slots?.name || ""),
		String(guest?.phone || slots?.phone || ""),
		String(guest?.nationality || slots?.nationality || ""),
		String(guest?.adults ?? slots?.adults ?? ""),
		String(guest?.children ?? slots?.children ?? ""),
		String(guest?.rooms ?? slots?.rooms ?? ""),
		String(quoteData?.nights || ""),
		String(quoteData?.total || quoteData?.total_amount || ""),
	];
	return crypto.createHash("sha1").update(parts.join("|")).digest("hex");
}

async function findAiReservationForCase(caseId, options = {}) {
	const includeSupportCaseReservation = options.includeSupportCaseReservation !== false;
	const caseKey = cleanCaseId(caseId);
	if (!caseKey) return null;
	const direct = await Reservations.findOne({ aiSupportCaseId: caseKey })
		.sort({ createdAt: -1, _id: -1 })
		.maxTimeMS(AI_RESERVATION_QUERY_MAX_TIME_MS)
		.lean()
		.exec()
		.catch(() => null);
	if (direct) return direct;
	if (!includeSupportCaseReservation || !mongoose.Types.ObjectId.isValid(caseKey)) {
		return null;
	}
	const sc = await SupportCase.findById(caseKey)
		.select("aiReservation")
		.maxTimeMS(AI_RESERVATION_QUERY_MAX_TIME_MS)
		.lean()
		.exec()
		.catch(() => null);
	const confirmation = String(sc?.aiReservation?.confirmationNumber || "")
		.trim()
		.toLowerCase();
	const reservationId = sc?.aiReservation?.reservationId || null;
	const clauses = [];
	if (reservationId) clauses.push({ _id: reservationId });
	if (confirmation) clauses.push({ confirmation_number: confirmation });
	if (!clauses.length) return null;
	return Reservations.findOne({ $or: clauses })
		.maxTimeMS(AI_RESERVATION_QUERY_MAX_TIME_MS)
		.lean()
		.exec()
		.catch(() => null);
}

async function acquireAiReservationLock(caseId, fingerprint) {
	const caseKey = cleanCaseId(caseId);
	if (!caseKey) return { locked: false, existing: null };
	const lockedAt = new Date();
	const staleBefore = new Date(lockedAt.getTime() - AI_RESERVATION_LOCK_TTL_MS);
	const lock = await SupportCase.updateOne(
		{
			_id: caseKey,
			$or: [
				{ "aiReservation.status": { $exists: false } },
				{ "aiReservation.status": "" },
				{ "aiReservation.status": "failed" },
				{
					"aiReservation.status": "creating",
					"aiReservation.lockedAt": { $lt: staleBefore },
				},
			],
		},
		{
			$set: {
				"aiReservation.status": "creating",
				"aiReservation.reservationId": null,
				"aiReservation.confirmationNumber": "",
				"aiReservation.fingerprint": fingerprint,
				"aiReservation.lockedAt": lockedAt,
				"aiReservation.createdAt": null,
				"aiReservation.lastError": "",
			},
		},
		{}
	)
		.maxTimeMS(AI_RESERVATION_QUERY_MAX_TIME_MS)
		.exec()
		.catch(() => null);
	if (lock?.modifiedCount || lock?.matchedCount) {
		return { locked: true, existing: null };
	}
	const racedExisting = await findAiReservationForCase(caseKey);
	return { locked: false, existing: racedExisting || null };
}

async function waitForAiReservationForCase(caseId, attempts = 8) {
	for (let i = 0; i < attempts; i += 1) {
		await sleep(500);
		const existing = await findAiReservationForCase(caseId);
		if (existing) return existing;
	}
	return null;
}

async function markAiReservationCreated(caseId, fingerprint, reservation) {
	const caseKey = cleanCaseId(caseId);
	if (!caseKey || !reservation?._id || !mongoose.Types.ObjectId.isValid(caseKey)) return;
	await SupportCase.updateOne(
		{ _id: caseKey, "aiReservation.fingerprint": fingerprint },
		{
			$set: {
				"aiReservation.status": "created",
				"aiReservation.reservationId": reservation._id,
				"aiReservation.confirmationNumber": reservation.confirmation_number || "",
				"aiReservation.lockedAt": null,
				"aiReservation.createdAt": new Date(),
				"aiReservation.lastError": "",
			},
		}
	)
		.maxTimeMS(AI_RESERVATION_QUERY_MAX_TIME_MS)
		.exec()
		.catch(() => {});
}

async function markAiReservationFailed(caseId, fingerprint, error) {
	const caseKey = cleanCaseId(caseId);
	if (!caseKey || !mongoose.Types.ObjectId.isValid(caseKey)) return;
	await SupportCase.updateOne(
		{ _id: caseKey, "aiReservation.fingerprint": fingerprint },
		{
			$set: {
				"aiReservation.status": "failed",
				"aiReservation.lockedAt": null,
				"aiReservation.lastError": String(error?.message || error || "").slice(
					0,
					240
				),
			},
		}
	)
		.maxTimeMS(AI_RESERVATION_QUERY_MAX_TIME_MS)
		.exec()
		.catch(() => {});
}

async function createReservationForCase({
	caseId,
	reservationCaseId = "",
	useSupportCaseReservationLock = true,
	markSupportCaseReservation = true,
	hotel,
	slots,
	quoteData,
	room,
}) {
	const hasRoomQuoteLines = Array.isArray(quoteData?.rooms) && quoteData.rooms.length > 0;
	const dailyRows = Array.isArray(quoteData?.rows)
		? quoteData.rows
		: Array.isArray(quoteData?.pricingByDay)
		? quoteData.pricingByDay
		: [];
	if (!hasRoomQuoteLines && !dailyRows.length) {
		throw new Error("AI reservation quote is missing daily pricing rows.");
	}
	const guest = validateRequiredGuestDetails(slots);
	assertQuoteWithinPhysicalInventory({ hotel, slots, quoteData, room });
	assertGuestCountFitsSelectedRooms({ hotel, slots, quoteData, room, guest });
	const caseKey = cleanCaseId(caseId);
	const reservationCaseKey = cleanCaseId(reservationCaseId || caseKey);
	const lookupKey = reservationCaseKey || caseKey;
	const usesDedicatedReservationKey = Boolean(
		reservationCaseKey && caseKey && reservationCaseKey !== caseKey
	);
	const existing = await timedReservationCreateStep(
		caseId,
		"existing_lookup",
		() =>
			findAiReservationForCase(lookupKey, {
				includeSupportCaseReservation: !usesDedicatedReservationKey,
			}),
		{ lookupKey: Boolean(lookupKey) }
	);
	if (existing) {
		log(caseId, "reservation.existing_returned", {
			reservationId: String(existing._id),
			confirmation: existing.confirmation_number,
			lookupKey,
		});
		return existing;
	}
	const fingerprint = aiReservationFingerprint({
		caseId: lookupKey || caseKey,
		hotel,
		slots,
		quoteData,
		room,
		guest,
	});
	const shouldUseSupportCaseLock = Boolean(
		caseKey &&
			!usesDedicatedReservationKey &&
			useSupportCaseReservationLock &&
			mongoose.Types.ObjectId.isValid(caseKey)
	);
	const lock = shouldUseSupportCaseLock
		? await timedReservationCreateStep(
				caseId,
				"lock",
				() => acquireAiReservationLock(caseKey, fingerprint),
				{ caseKey: Boolean(caseKey) }
		  )
		: { locked: false, existing: null };
	if (lock.existing) {
		log(caseId, "reservation.duplicate_returned", {
			reservationId: String(lock.existing._id),
			confirmation: lock.existing.confirmation_number,
		});
		return lock.existing;
	}
	if (shouldUseSupportCaseLock && !lock.locked) {
		const racedExisting = await waitForAiReservationForCase(caseKey);
		if (racedExisting) {
			log(caseId, "reservation.race_existing_returned", {
				reservationId: String(racedExisting._id),
				confirmation: racedExisting.confirmation_number,
			});
			return racedExisting;
		}
		throw new Error("AI reservation creation is already in progress for this support case.");
	}
	const confirmation_number = await timedReservationCreateStep(
		caseId,
		"confirmation_number",
		() => uniqueConfirmation()
	);

	const pickedRoomsType = buildPickedRoomsTypeFromQuote({
		quoteData,
		room,
		dailyRows,
		count: guest.rooms,
	});
	if (!pickedRoomsType.length) {
		throw new Error("AI reservation quote is missing room pricing rows.");
	}
	const totals = sumPickedRooms(pickedRoomsType);
	const totalRooms = pickedRoomsType.reduce(
		(total, row) => total + Math.max(1, Number(row.count || 1)),
		0
	);

	const reservationPayload = {
		hotelId: hotel._id,
		hotelName: hotel.hotelName,
		belongsTo: hotel.belongsTo || undefined,

		// store Gregorian in YYYY-MM-DD (same as your OrderTaker expects)
		checkin_date: slots.checkinISO,
		checkout_date: slots.checkoutISO,
		days_of_residence: quoteData.nights,

		total_rooms: totalRooms,
		total_guests: guest.adults + guest.children,
		adults: guest.adults,
		children: guest.children,

		total_amount: totals.total_amount, // Grand total with commission
		commission: totals.commission, // Commission portion
		payment: "Not Paid",
		financeStatus: "not paid",
		paid_amount: 0,
		commissionPaid: 0,
		booking_source: "AI Chat",
		createdBy: AI_RESERVATION_ACTOR,
		orderTaker: AI_RESERVATION_ACTOR,
		orderTakenAt: new Date(),
		aiSupportCaseId: lookupKey,
		aiReservationFingerprint: fingerprint,
		pickedRoomsType,
		pickedRoomsPricing: pickedRoomsType,
		adminPricingVisibility: {
			rootOnlyForHotelManagement: true,
			source: "ai_chat_reservation_create",
			appliedAt: new Date(),
			appliedBy: AI_RESERVATION_ACTOR,
		},

		customer_details: {
			name: guest.name,
			phone: guest.phone,
			email: guest.email,
			nationality: guest.nationality,
			aiSupportCaseId: caseKey,
			aiReservationCaseId: lookupKey,
		},

		confirmation_number,
		advancePayment: 0,
	};

	let saved = null;
	try {
		const inventoryValidation = await timedReservationCreateStep(
			caseId,
			"inventory_validation",
			() =>
				validateReservationInventoryForCreate(reservationPayload, {
					allowOverbook: true,
				}),
			{
				hotelId: String(hotel?._id || ""),
				checkin: slots.checkinISO,
				checkout: slots.checkoutISO,
			}
		);
		if (!inventoryValidation.allowed) {
			const message =
				inventoryValidation.message ||
				inventoryValidation.issues?.[0]?.message ||
				"Selected room is no longer available.";
			throw new Error(message);
		}
		captureReservationAvailabilitySnapshot(
			reservationPayload,
			inventoryValidation,
			"ai_chat_reservation_create"
		);
		markReservationPendingConfirmation(reservationPayload, {
			actor: AI_RESERVATION_ACTOR,
			source: "ai_chat_reservation_create",
			operationalStatus: true,
			clientVisibleStatus: "confirmed",
			inventoryBlocks: true,
		});
		const finalQuoteVerification = await timedReservationCreateStep(
			caseId,
			"final_quote_verification",
			() =>
				revalidateQuoteImmediatelyBeforeInsert({
					hotel,
					slots,
					quoteData,
					room,
				}),
			{
				hotelId: String(hotel?._id || ""),
				checkin: slots.checkinISO,
				checkout: slots.checkoutISO,
			}
		);
		assertFinalQuoteMoneyEqual(
			finalQuoteVerification.total,
			reservationPayload.total_amount,
			"reservation_payload_total_changed"
		);
		assertFinalQuoteMoneyEqual(
			finalQuoteVerification.commission,
			reservationPayload.commission,
			"reservation_payload_commission_changed"
		);
		if (Number(reservationPayload.total_rooms || 0) !== finalQuoteVerification.totalRooms) {
			throw quoteChangedBeforeInsertError("reservation_payload_room_count_changed", {
				expected: finalQuoteVerification.totalRooms,
				actual: Number(reservationPayload.total_rooms || 0),
			});
		}
		saved = await timedReservationCreateStep(
			caseId,
			"reservation_insert",
			() => Reservations.create(reservationPayload)
		);
		if (markSupportCaseReservation && shouldUseSupportCaseLock) {
			await timedReservationCreateStep(
				caseId,
				"support_case_mark_created",
				() => markAiReservationCreated(caseKey, fingerprint, saved)
			);
		}
	} catch (error) {
		if (error?.code === 11000 && lookupKey) {
			const duplicateExisting = await findAiReservationForCase(lookupKey, {
				includeSupportCaseReservation: !usesDedicatedReservationKey,
			});
			if (duplicateExisting) {
				log(caseId, "reservation.duplicate_key_existing_returned", {
					reservationId: String(duplicateExisting._id),
					confirmation: duplicateExisting.confirmation_number,
				});
				return duplicateExisting;
			}
		}
		if (markSupportCaseReservation && shouldUseSupportCaseLock) {
			await markAiReservationFailed(caseKey, fingerprint, error);
		}
		throw error;
	}

	log(caseId, "reservation.created", {
		reservationId: String(saved._id),
		confirmation: saved.confirmation_number,
		total: saved.total_amount,
	});
	scheduleReservationConfirmedConversion(saved, {
		source: "ai_chat",
		caseId,
		hotel,
	});

	return saved;
}

function deliveryStatusFromResult(result = {}, channels = {}) {
	const guestEmail = result?.email?.guest || null;
	const guestWhatsApp = result?.whatsapp?.guest || null;
	const emailRequested = channels.email !== false;
	const whatsappRequested = channels.whatsapp !== false;
	const emailStatus = !emailRequested
		? "not_requested"
		: guestEmail?.ok
		? "sent"
		: guestEmail?.skipped
		? "skipped"
		: guestEmail
		? "failed"
		: "not_attempted";
	const whatsappStatus = !whatsappRequested
		? "not_requested"
		: guestWhatsApp?.sid || guestWhatsApp?.ok
		? "sent"
		: guestWhatsApp?.skipped
		? "skipped"
		: guestWhatsApp
		? "failed"
		: "not_attempted";
	return {
		emailStatus,
		emailError: guestEmail?.error || guestEmail?.reason || "",
		whatsappStatus,
		whatsappError: guestWhatsApp?.error || guestWhatsApp?.reason || "",
	};
}

async function markAiConfirmationDelivery(caseId, result = {}, options = {}) {
	const caseKey = cleanCaseId(caseId);
	if (!caseKey) return;
	const nowDate = new Date();
	const status = deliveryStatusFromResult(result, {
		email: options.includeGuestEmail !== false,
		whatsapp: options.includeGuestWhatsApp !== false,
	});
	const set = {
		"aiReservation.confirmationDelivery.lastAttemptAt": nowDate,
		"aiReservation.confirmationDelivery.lastMode": options.mode || "initial",
		"aiReservation.confirmationDelivery.emailStatus": status.emailStatus,
		"aiReservation.confirmationDelivery.emailLastError": status.emailError,
		"aiReservation.confirmationDelivery.whatsappStatus": status.whatsappStatus,
		"aiReservation.confirmationDelivery.whatsappLastError": status.whatsappError,
	};
	if (status.emailStatus === "sent") {
		set["aiReservation.confirmationDelivery.emailSentAt"] = nowDate;
	}
	if (status.whatsappStatus === "sent") {
		set["aiReservation.confirmationDelivery.whatsappSentAt"] = nowDate;
	}
	await SupportCase.updateOne({ _id: caseKey }, { $set: set }).catch(() => {});
}

async function dispatchAiReservationConfirmation({
	caseId,
	reservation,
	mode = "initial",
	includeGuestEmail = true,
	includeInternalEmail = true,
	includeOwnerEmail = true,
	includeGuestWhatsApp = true,
	includeAdminWhatsApp = true,
	guestEmail = "",
} = {}) {
	const caseKey = cleanCaseId(caseId);
	const reservationId = reservation?._id || reservation?.id || null;
	const hydrated = reservationId
		? await Reservations.findById(reservationId).lean().exec()
		: reservation;
	if (!hydrated) {
		const links = reservationPublicLinks(reservation || {});
		return {
			ok: false,
			links,
			email: {
				guest: {
					ok: false,
					error: "reservation_not_found",
				},
			},
			whatsapp: {},
		};
	}
	const result = await dispatchReservationConfirmation(hydrated, {
		guestEmail,
		includeGuestEmail,
		includeInternalEmail,
		includeOwnerEmail,
		includeGuestWhatsApp,
		includeAdminWhatsApp,
		includePdf: false,
	});
	await markAiConfirmationDelivery(caseKey, result, {
		mode,
		includeGuestEmail,
		includeGuestWhatsApp,
	});
	return result;
}

async function postReservationLinks(io, sc, reservation) {
	const caseId = String(sc._id);
	const conf = reservation.confirmation_number;
	const rid = String(reservation._id);
	const publicBase = String(
		process.env.CLIENT_URL ||
			process.env.REACT_APP_MAIN_URL_JANNAT ||
			"https://jannatbooking.com"
	).replace(/\/+$/, "");

	const link1 = `${publicBase}/single-reservation/${conf}`;
	const link2 = `${publicBase}/client-payment/${rid}/${conf}`;
	const languageCode = String(sc.preferredLanguageCode || sc.languageCode || "").toLowerCase();
	const recentText = Array.isArray(sc.conversation)
		? sc.conversation
				.slice(-6)
				.map((entry) => entry?.message || "")
				.join(" ")
		: "";
	const ar = /^ar\b/.test(languageCode) || /[\u0600-\u06FF]/.test(recentText);
	const messages = ar
		? [
				[
					`أكيد، هذه روابط الحجز:`,
					`- تفاصيل الحجز/الإيصال: ${link1}`,
					`- رابط الدفع: ${link2}`,
					`رقم التأكيد: ${conf}`,
				].join("\n"),
		  ]
		: [
				[
					`Your reservation links are ready:`,
					`- Reservation details/receipt: ${link1}`,
					`- Payment link: ${link2}`,
					`Confirmation number: ${conf}`,
				].join("\n"),
		  ];

	for (const text of messages) {
		const messageData = {
			messageBy: {
				customerName: "Jannat Booking Support",
				customerEmail: "support@jannatbooking.com",
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
	}
}

async function pushReservationLinks(io, caseId, _st, payload = {}) {
	const reservationId = payload.reservationId || payload._id || "";
	const confirmation =
		payload.confirmation || payload.confirmation_number || payload.conf || "";
	if (!reservationId || !confirmation) return;
	const sc = await SupportCase.findById(caseId).lean().exec().catch(() => null);
	return postReservationLinks(
		io,
		sc || { _id: caseId },
		{
			_id: reservationId,
			confirmation_number: confirmation,
		}
	);
}

const exportedActions = {
	createReservationForCase,
	updateReservationDatesForCase,
	getReservationCancellationPolicyForCase,
	dispatchAiReservationConfirmation,
	postReservationLinks,
	pushReservationLinks,
};
if (String(process.env.AI_AGENT_TEST_EXPORTS || "").toLowerCase() === "true") {
	exportedActions.__test = {
		buildPickedRoomsType,
		buildPickedRoomsTypeFromQuote,
		sumPickedRooms,
		usableFullName,
		looksLikeReservationActionName,
		selectedRoomGuestCapacity,
		assertGuestCountFitsSelectedRooms,
		reservationRoomSelection,
		findHotelRoomForSelection,
		reservationUpdatePricingDateKeys,
		revalidateQuoteImmediatelyBeforeInsert,
		quoteChangedBeforeInsertError,
		reservationUpdateCandidateChange,
		revalidateReservationUpdateImmediatelyBeforeMutation,
	};
}

module.exports = exportedActions;
