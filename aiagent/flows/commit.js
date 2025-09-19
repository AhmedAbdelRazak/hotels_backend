/** @format */
const { Reservation } = require("../core/db");

function genConfirmation() {
	let s = "";
	while (s.length < 10) s += Math.floor(Math.random() * 10).toString();
	return s;
}

async function commitNewReservation(state) {
	if (!Reservation) throw new Error("[aiagent] Reservation model not found");
	const draft = state.draftReservation;
	if (!draft) throw new Error("[aiagent] No reservation draft");

	const reservedBy = `${
		state.agentName || "Aisha | Customer Support"
	} (aiagent)`;

	const doc = {
		reservation_id: "",
		hr_number: "",
		confirmation_number: genConfirmation(),
		pms_number: "",
		booking_source: "aiagent chat",

		customer_details: {
			name: state.profile?.name || "",
			email: state.answers?.email || "",
			phone: state.answers?.phone || "",
			passport: "Not Provided",
			passportExpiry: "1/1/2027",
			nationality: state.answers?.nationality || "",
			postalCode: "00000",
			reservedBy,
			state: "confirmed",
		},

		reservation_status: "confirmed",
		total_guests: draft.total_guests || 1,
		adults: draft.adults || 1,
		children: draft.children || 0,

		pickedRoomsPricing: [],
		total_rooms: draft.total_rooms || 1,
		cancel_reason: "",
		booked_at: new Date(),
		inhouse_date: null,

		sub_total: draft.pickedRoomsType?.[0]?.hotelShouldGet || 0,
		extras_total: 0,
		tax_total: 0,
		total_amount: draft.total_amount,
		currency: draft.currency || "sar",

		checkin_date: draft.checkin_date,
		checkout_date: draft.checkout_date,
		days_of_residence: draft.days_of_residence,

		comment: "",
		financeStatus: "not paid",
		payment: "not paid",
		paid_amount: 0,
		commission: draft.commission,
		commissionPaid: false,

		pickedRoomsType: draft.pickedRoomsType,
		roomId: [],
		bedNumber: [],
		belongsTo: draft.belongsTo || "",
		hotelId: draft.hotelId,

		housedBy: { name: "" },
		moneyTransferredToHotel: false,
		guestAgreedOnTermsAndConditions: false,
		affiliateReservation: false,

		affiliateData: {},
		supplierData: {},
		advancePayment: {},
		wholeSaleReservation: false,
		moneyTransferredAt: null,
		adminLastUpdatedAt: null,
		adminLastUpdatedBy: {},
		adminChangeLog: [],
		sentFrom: "aiagent",
	};

	const created = await Reservation.create(doc);
	return created.toObject();
}

async function commitUpdateReservation(state) {
	if (!Reservation) throw new Error("[aiagent] Reservation model not found");
	const resv = state.existingReservation;
	const draft = state.draftReservation;
	if (!resv || !draft)
		throw new Error("[aiagent] Missing reservation or draft");

	const reservedBy = `${
		state.agentName || "Aisha | Customer Support"
	} (aiagent)`;

	const update = {
		checkin_date: draft.checkin_date,
		checkout_date: draft.checkout_date,
		days_of_residence: draft.days_of_residence,
		pickedRoomsType: draft.pickedRoomsType,
		total_amount: draft.total_amount,
		commission: draft.commission,
		currency: draft.currency,
		reservation_status: "confirmed",
		customer_details: {
			...(resv.customer_details || {}),
			name: state.profile?.name || resv.customer_details?.name || "",
			email: state.answers?.email || resv.customer_details?.email || "",
			phone: state.answers?.phone || resv.customer_details?.phone || "",
			nationality:
				state.answers?.nationality || resv.customer_details?.nationality || "",
			reservedBy,
		},
		adminLastUpdatedAt: new Date(),
		adminChangeLog: [
			...(Array.isArray(resv.adminChangeLog) ? resv.adminChangeLog : []),
			{ at: new Date(), by: reservedBy, note: "Updated via aiagent chat" },
		],
	};

	const updated = await Reservation.findByIdAndUpdate(resv._id, update, {
		new: true,
	}).lean();
	return updated;
}

module.exports = { commitNewReservation, commitUpdateReservation };
