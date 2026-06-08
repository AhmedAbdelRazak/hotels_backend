// aiagent/core/actions.js
const Reservations = require("../../models/reservations");
const UncompleteReservations = require("../../models/Uncompleted");
const {
	validateReservationInventoryForCreate,
	captureReservationAvailabilitySnapshot,
} = require("../../controllers/reservations");
const { updateSupportCaseAppend } = require("./db");
const { asciiize, digitsToEnglish } = require("./nlu");
const {
	markReservationPendingConfirmation,
} = require("../../services/pendingConfirmationPolicy");

function log(caseId, msg, payload = {}) {
	if (String(process.env.AI_AGENT_DEBUG || "").toLowerCase() !== "true") {
		return;
	}
	console.log(`[aiagent] case=${caseId} ${msg}`, payload);
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

function usableFullName(value = "") {
	const name = cleanText(value, 120);
	if (!name || name.length < 4) return "";
	if (onlyDigits(name) || /^(?:guest|unknown|test|n\/a|na|null|none)$/i.test(name)) {
		return "";
	}
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
		pickedRoomsType,
		pickedRoomsPricing: pickedRoomsType,

		customer_details: {
			name: guest.name,
			phone: guest.phone,
			email: guest.email,
			nationality: guest.nationality,
		},

		confirmation_number,
		advancePayment: 0,
	};

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
		operationalStatus: false,
		clientVisibleStatus: "confirmed",
		inventoryBlocks: true,
	});
	const saved = await Reservations.create(reservationPayload);

	log(caseId, "reservation.created", {
		reservationId: String(saved._id),
		confirmation: saved.confirmation_number,
		total: saved.total_amount,
	});

	return saved;
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
	postReservationLinks,
	pushReservationLinks,
};
