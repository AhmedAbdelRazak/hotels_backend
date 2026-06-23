// aiagent/core/actions.js
const crypto = require("crypto");
const Reservations = require("../../models/reservations");
const UncompleteReservations = require("../../models/Uncompleted");
const HotelDetails = require("../../models/hotel_details");
const SupportCase = require("../../models/supportcase");
const {
	validateReservationInventoryForCreate,
	captureReservationAvailabilitySnapshot,
} = require("../../controllers/reservations");
const { updateSupportCaseAppend } = require("./db");
const { asciiize, digitsToEnglish } = require("./nlu");
const { priceRoomForStay } = require("./selectors");
const {
	markReservationPendingConfirmation,
} = require("../../services/pendingConfirmationPolicy");
const {
	dispatchReservationConfirmation,
	reservationPublicLinks,
} = require("../../services/reservationConfirmationDispatcher");

const DAY_MS = 24 * 60 * 60 * 1000;
const AI_RESERVATION_ACTOR = {
	_id: "jannat-ai-support",
	name: "Jannat AI Support",
	email: "support@jannatbooking.com",
	role: "aiagent",
	roleDescription: "AI Chat",
};
const AI_RESERVATION_LOCK_TTL_MS = 2 * 60 * 1000;

function log(caseId, msg, payload = {}) {
	if (String(process.env.AI_AGENT_DEBUG || "").toLowerCase() !== "true") {
		return;
	}
	console.log(`[aiagent] case=${caseId} ${msg}`, payload);
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
	return [
		"\u0628\u0648\u0631\u0643\u064a\u0646\u0627\u0641\u0627\u0633\u0648",
		"\u0627\u0631\u062f\u0646\u064a",
		"\u0627\u0631\u062f\u0646\u0649",
		"\u0623\u0631\u062f\u0646\u064a",
		"\u0623\u0631\u062f\u0646\u0649",
	].includes(compact);
}

function usableFullName(value = "") {
	const name = cleanText(value, 120);
	if (!name || name.length < 4) return "";
	if (onlyDigits(name) || /^(?:guest|unknown|test|n\/a|na|null|none)$/i.test(name)) {
		return "";
	}
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
		Reservations.exists({ confirmation_number: candidate }),
		UncompleteReservations.exists({ confirmation_number: candidate }),
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
		(row) => row?.room_type || row?.roomType || row?.displayName || row?.display_name
	);
	if (!rows.length) {
		return { supported: false, reason: "missing_room_selection" };
	}
	const uniqueRoomKeys = new Set(
		rows
			.map((row) => roomToken(row.room_type || row.roomType || row.displayName || row.display_name))
			.filter(Boolean)
	);
	if (uniqueRoomKeys.size > 1) {
		return { supported: false, reason: "multiple_room_types" };
	}
	const first = rows[0] || {};
	const count = rows.reduce(
		(total, row) => total + Math.max(1, Number(row.count || 1)),
		0
	);
	return {
		supported: true,
		roomType: String(first.room_type || first.roomType || "").trim(),
		displayName: String(first.displayName || first.display_name || "").trim(),
		count: Math.max(1, count || Number(reservation.total_rooms || 1) || 1),
	};
}

function findHotelRoomForSelection(hotel = {}, selection = {}, roomTypeOverride = "") {
	const rooms = Array.isArray(hotel.roomCountDetails) ? hotel.roomCountDetails : [];
	const activeRooms = rooms.filter((room) => room?.activeRoom !== false);
	const rawRoomType = String(roomTypeOverride || selection.roomType || "").trim();
	const rawDisplay = String(selection.displayName || "").trim();
	const exact =
		activeRooms.find((room) => rawRoomType && room.roomType === rawRoomType) ||
		activeRooms.find((room) => rawDisplay && room.displayName === rawDisplay);
	if (exact) return exact;
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

	const quote = priceRoomForStay(
		hotel,
		{ roomType: room.roomType },
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
		allowOverbook: false,
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
	let activeHotel = hotel;
	if (
		(!activeHotel || !Array.isArray(activeHotel.roomCountDetails)) &&
		reservationHotelId
	) {
		activeHotel = await HotelDetails.findById(reservationHotelId).lean().exec();
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

async function findAiReservationForCase(caseId) {
	const caseKey = cleanCaseId(caseId);
	if (!caseKey) return null;
	const direct = await Reservations.findOne({ aiSupportCaseId: caseKey })
		.sort({ createdAt: -1, _id: -1 })
		.catch(() => null);
	if (direct) return direct;
	const sc = await SupportCase.findById(caseKey)
		.select("aiReservation")
		.lean()
		.catch(() => null);
	const confirmation = String(sc?.aiReservation?.confirmationNumber || "")
		.trim()
		.toLowerCase();
	const reservationId = sc?.aiReservation?.reservationId || null;
	const clauses = [];
	if (reservationId) clauses.push({ _id: reservationId });
	if (confirmation) clauses.push({ confirmation_number: confirmation });
	if (!clauses.length) return null;
	return Reservations.findOne({ $or: clauses }).catch(() => null);
}

async function acquireAiReservationLock(caseId, fingerprint) {
	const caseKey = cleanCaseId(caseId);
	if (!caseKey) return { locked: false, existing: null };
	const existing = await findAiReservationForCase(caseKey);
	if (existing) return { locked: false, existing };
	const lockedAt = new Date();
	const staleBefore = new Date(lockedAt.getTime() - AI_RESERVATION_LOCK_TTL_MS);
	const lock = await SupportCase.findOneAndUpdate(
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
		{ new: true }
	)
		.select("_id aiReservation")
		.lean()
		.catch(() => null);
	if (lock) return { locked: true, existing: null };
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
	if (!caseKey || !reservation?._id) return;
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
	).catch(() => {});
}

async function markAiReservationFailed(caseId, fingerprint, error) {
	const caseKey = cleanCaseId(caseId);
	if (!caseKey) return;
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
	).catch(() => {});
}

async function createReservationForCase({
	caseId,
	hotel,
	slots,
	quoteData,
	room,
}) {
	const dailyRows = Array.isArray(quoteData?.rows)
		? quoteData.rows
		: Array.isArray(quoteData?.pricingByDay)
		? quoteData.pricingByDay
		: [];
	if (!dailyRows.length) {
		throw new Error("AI reservation quote is missing daily pricing rows.");
	}
	const guest = validateRequiredGuestDetails(slots);
	const caseKey = cleanCaseId(caseId);
	const fingerprint = aiReservationFingerprint({
		caseId: caseKey,
		hotel,
		slots,
		quoteData,
		room,
		guest,
	});
	const lock = await acquireAiReservationLock(caseKey, fingerprint);
	if (lock.existing) {
		log(caseId, "reservation.duplicate_returned", {
			reservationId: String(lock.existing._id),
			confirmation: lock.existing.confirmation_number,
		});
		return lock.existing;
	}
	if (caseKey && !lock.locked) {
		const existing = await waitForAiReservationForCase(caseKey);
		if (existing) {
			log(caseId, "reservation.race_existing_returned", {
				reservationId: String(existing._id),
				confirmation: existing.confirmation_number,
			});
			return existing;
		}
		throw new Error("AI reservation creation is already in progress for this support case.");
	}
	const confirmation_number = await uniqueConfirmation();

	const pickedRoomsType = buildPickedRoomsType({
		room,
		dailyRows,
		count: guest.rooms,
	});
	const totals = sumPickedRooms(pickedRoomsType);

	const reservationPayload = {
		hotelId: hotel._id,
		hotelName: hotel.hotelName,
		belongsTo: hotel.belongsTo || undefined,

		// store Gregorian in YYYY-MM-DD (same as your OrderTaker expects)
		checkin_date: slots.checkinISO,
		checkout_date: slots.checkoutISO,
		days_of_residence: quoteData.nights,

		total_rooms: guest.rooms,
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
		aiSupportCaseId: caseKey,
		aiReservationFingerprint: fingerprint,
		pickedRoomsType,
		pickedRoomsPricing: pickedRoomsType,

		customer_details: {
			name: guest.name,
			phone: guest.phone,
			email: guest.email,
			nationality: guest.nationality,
			aiSupportCaseId: caseKey,
		},

		confirmation_number,
		advancePayment: 0,
	};

	let saved = null;
	try {
		const inventoryValidation = await validateReservationInventoryForCreate(
			reservationPayload,
			{ allowOverbook: false }
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
			source: "ai_chat_reservation_create",
			operationalStatus: true,
			clientVisibleStatus: "confirmed",
			inventoryBlocks: true,
		});
		saved = await Reservations.create(reservationPayload);
		await markAiReservationCreated(caseKey, fingerprint, saved);
	} catch (error) {
		if (error?.code === 11000 && caseKey) {
			const existing = await findAiReservationForCase(caseKey);
			if (existing) {
				log(caseId, "reservation.duplicate_key_existing_returned", {
					reservationId: String(existing._id),
					confirmation: existing.confirmation_number,
				});
				return existing;
			}
		}
		await markAiReservationFailed(caseKey, fingerprint, error);
		throw error;
	}

	log(caseId, "reservation.created", {
		reservationId: String(saved._id),
		confirmation: saved.confirmation_number,
		total: saved.total_amount,
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

	const messages = [
		`Your reservation is confirmed. [Please click here to find more details](${link1})`,
		`For serious confirmation, you may pay a small deposit here (optional):\n${link2}`,
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
	return postReservationLinks(
		io,
		{ _id: caseId },
		{
			_id: reservationId,
			confirmation_number: confirmation,
		}
	);
}

module.exports = {
	createReservationForCase,
	updateReservationDatesForCase,
	getReservationCancellationPolicyForCase,
	dispatchAiReservationConfirmation,
	postReservationLinks,
	pushReservationLinks,
};
