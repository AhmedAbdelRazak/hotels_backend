// aiagent/core/actions.js
const Reservations = require("../../models/reservations");
const { updateSupportCaseAppend } = require("./db");
const { asciiize, digitsToEnglish } = require("./nlu");

function log(caseId, msg, payload = {}) {
	console.log(`[aiagent] case=${caseId} ${msg}`, payload);
}
function onlyDigits(s = "") {
	return digitsToEnglish(String(s)).replace(/\D+/g, "");
}

async function uniqueConfirmation() {
	const tries = 30;
	for (let i = 0; i < tries; i++) {
		const num = String(Math.floor(100000 + Math.random() * 900000));
		const exists = await Reservations.findOne({ confirmation_number: num })
			.lean()
			.exec();
		if (!exists) return num;
	}
	return String(Date.now()).slice(-6);
}

function clonePricingRows(rows) {
	// exact daily structure as in OrderTaker
	return rows.map((d) => ({
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
	const confirmation_number = await uniqueConfirmation();

	const pickedRoomsType = buildPickedRoomsType({
		room,
		dailyRows: quoteData.rows,
		count: Number(slots.rooms || 1),
	});
	const totals = sumPickedRooms(pickedRoomsType);

	const doc = new Reservations({
		hotelId: hotel._id,
		hotelName: hotel.hotelName,
		belongsTo: hotel.belongsTo || undefined,

		// store Gregorian in YYYY-MM-DD (same as your OrderTaker expects)
		checkin_date: slots.checkinISO,
		checkout_date: slots.checkoutISO,
		days_of_residence: quoteData.nights,

		total_rooms: Number(slots.rooms || 1),
		total_guests: Number(slots.adults || 2) + Number(slots.children || 0),
		adults: Number(slots.adults || 2),
		children: Number(slots.children || 0),

		total_amount: totals.total_amount, // Grand total with commission
		commission: totals.commission, // Commission portion
		payment: "Not Paid",
		paid_amount: 0,
		commissionPaid: 0,
		booking_source: "AI Chat",
		pickedRoomsType,

		customer_details: {
			name: asciiize(slots.name || "Guest"),
			phone: onlyDigits(slots.phone || ""),
			email: asciiize(slots.email || ""),
			nationality: asciiize(slots.nationality || ""),
		},

		confirmation_number,
		advancePayment: 0,
	});

	const saved = await doc.save();

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

	const link1 = `https://jannatbooking.com/single-reservation/${conf}`;
	const link2 = `https://jannatbooking.com/client-payment/${rid}/${conf}`;

	const messages = [
		`Your reservation is confirmed. View details here:\n${link1}`,
		`For serious confirmation, you may pay a small deposit here (optional):\n${link2}`,
	];

	for (const text of messages) {
		const messageData = {
			messageBy: {
				customerName: "System",
				customerEmail: "management@xhotelpro.com",
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

module.exports = {
	createReservationForCase,
	postReservationLinks,
};
