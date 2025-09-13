// ai-agent/tools.js
const axios = require("axios");
const mongoose = require("mongoose");
const SupportCase = require("../models/supportcase");
const Reservations = require("../models/reservations");
const HotelDetails = require("../models/hotel_details");
const {
	ensureE164Phone,
	waSendReservationUpdate,
} = require("../controllers/whatsappsender");

const API_BASE =
	process.env.SELF_API_BASE ||
	`http://localhost:${process.env.PORT || 8080}/api`;

const toolSchemas = [
	{
		type: "function",
		name: "get_hotel_facts",
		description:
			"Fetch core facts for a hotel (name, address, distances, offers).",
		parameters: {
			type: "object",
			properties: { hotelId: { type: "string" } },
			required: ["hotelId"],
		},
	},
	{
		type: "function",
		name: "search_rooms",
		description:
			"Search active hotels/rooms matching dates/destination/roomType/adults/children.",
		parameters: {
			type: "object",
			properties: {
				startDate: { type: "string" },
				endDate: { type: "string" },
				roomType: { type: "string" },
				adults: { type: "number" },
				children: { type: "number" },
				destination: { type: "string" },
			},
			required: ["startDate", "endDate", "roomType", "adults"],
		},
	},
	{
		type: "function",
		name: "create_reservation_not_paid",
		description:
			"Create a NOT PAID reservation and send verification via email + WhatsApp.",
		parameters: {
			type: "object",
			properties: {
				hotelId: { type: "string" },
				name: { type: "string" },
				email: { type: "string" },
				phone: { type: "string" },
				nationality: { type: "string" },
				checkin_date: { type: "string" },
				checkout_date: { type: "string" },
				adults: { type: "number" },
				children: { type: "number" },
				pickedRoomsType: { type: "array", items: { type: "object" } },
				booking_source: { type: "string", description: "e.g., 'AI Agent'" },
			},
			required: [
				"hotelId",
				"name",
				"email",
				"phone",
				"nationality",
				"checkin_date",
				"checkout_date",
				"adults",
				"pickedRoomsType",
			],
		},
	},
	{
		type: "function",
		name: "send_payment_link",
		description: "Email + WhatsApp a payment link for a reservation.",
		parameters: {
			type: "object",
			properties: {
				reservationId: { type: "string" },
				amountInSAR: { type: "number" },
			},
			required: ["reservationId", "amountInSAR"],
		},
	},
	{
		type: "function",
		name: "update_reservation",
		description:
			"Update reservation (dates, rooms, guest details). Triggers invoice + WA update.",
		parameters: {
			type: "object",
			properties: {
				reservationId: { type: "string" },
				updates: { type: "object" },
			},
			required: ["reservationId", "updates"],
		},
	},
	{
		type: "function",
		name: "cancel_reservation",
		description: "Cancel a reservation by confirmation number or _id.",
		parameters: {
			type: "object",
			properties: {
				confirmationOrId: { type: "string" },
				reason: { type: "string" },
			},
			required: ["confirmationOrId"],
		},
	},
	{
		type: "function",
		name: "mark_seen_by_customer",
		description: "Mark current support case messages as seen by the customer.",
		parameters: {
			type: "object",
			properties: { caseId: { type: "string" } },
			required: ["caseId"],
		},
	},
	{
		type: "function",
		name: "escalate_to_human",
		description: "Assign/flag a case for a human supporter with optional note.",
		parameters: {
			type: "object",
			properties: {
				caseId: { type: "string" },
				supporterName: { type: "string" },
				note: { type: "string" },
			},
			required: ["caseId"],
		},
	},
];

const resolvers = {
	async get_hotel_facts({ hotelId }) {
		const hotel = await HotelDetails.findById(hotelId).lean();
		if (!hotel) return { ok: false, error: "Hotel not found" };
		return {
			ok: true,
			data: {
				hotelName: hotel.hotelName,
				address: hotel.hotelAddress,
				city: hotel.hotelCity,
				phone: hotel.phone,
				distances: hotel.distances || {},
				offersCount: (hotel.roomCountDetails || []).reduce(
					(sum, r) => sum + ((r.offers || []).length || 0),
					0
				),
				monthlyCount: (hotel.roomCountDetails || []).reduce(
					(sum, r) => sum + ((r.monthly || []).length || 0),
					0
				),
			},
		};
	},

	async search_rooms({
		startDate,
		endDate,
		roomType,
		adults,
		children = 0,
		destination = "",
	}) {
		const q = [
			startDate,
			endDate,
			roomType,
			adults,
			children,
			destination,
		].join("_");
		const { data } = await axios.get(
			`${API_BASE}/getting-roomList-from-query/${q}`
		);
		return { ok: true, data };
	},

	async create_reservation_not_paid(payload) {
		// Use your existing controller flow (Not Paid -> verification)
		const body = {
			hotelId: payload.hotelId,
			customerDetails: {
				name: payload.name,
				email: payload.email,
				phone: payload.phone,
				nationality: payload.nationality,
				passport: "Not Provided",
				passportExpiry: "1/1/2027",
			},
			paymentDetails: {
				cardNumber: "",
				cardExpiryDate: "",
				cardCVV: "",
				cardHolderName: "",
			},
			pickedRoomsType: payload.pickedRoomsType,
			total_amount: payload.pickedRoomsType.reduce(
				(s, r) => s + (Number(r.totalPriceWithCommission) || 0),
				0
			),
			commission: payload.pickedRoomsType.reduce(
				(s, r) =>
					s +
					((Number(r.totalPriceWithCommission) || 0) -
						(Number(r.hotelShouldGet) || 0)),
				0
			),
			total_rooms: payload.pickedRoomsType.reduce(
				(s, r) => s + (Number(r.count) || 1),
				0
			),
			total_guests: Number(payload.adults || 0) + Number(payload.children || 0),
			adults: payload.adults || 0,
			children: payload.children || 0,
			checkin_date: payload.checkin_date,
			checkout_date: payload.checkout_date,
			days_of_residence: Math.max(
				1,
				Math.ceil(
					(new Date(payload.checkout_date) - new Date(payload.checkin_date)) /
						86400000
				)
			),
			booking_source: payload.booking_source || "AI Agent",
			payment: "Not Paid",
			paid_amount: 0,
			commissionPaid: false,
			belongsTo: null,
			userId: null,
		};
		const { data } = await axios.post(
			`${API_BASE}/create-new-reservation-client`,
			body
		);
		return { ok: true, data };
	},

	async send_payment_link({ reservationId, amountInSAR }) {
		const { data } = await axios.post(
			`${API_BASE}/send-email-payment-triggering/${reservationId}`,
			{
				reservationId,
				amountInSAR,
			}
		);
		return { ok: true, data };
	},

	async update_reservation({ reservationId, updates }) {
		const { data } = await axios.put(
			`${API_BASE}/update-reservation-details/${reservationId}`,
			updates
		);
		return { ok: true, data };
	},

	async cancel_reservation({ confirmationOrId, reason }) {
		// soft cancel: just update reservation_status = 'cancelled'
		let reservation = null;
		if (mongoose.Types.ObjectId.isValid(confirmationOrId)) {
			reservation = await Reservations.findById(confirmationOrId).exec();
		}
		if (!reservation) {
			reservation = await Reservations.findOne({
				confirmation_number: confirmationOrId,
			}).exec();
		}
		if (!reservation) return { ok: false, error: "Reservation not found" };

		reservation.reservation_status = "cancelled";
		if (reason) reservation.cancellation_reason = reason;
		await reservation.save();

		try {
			const link = `${process.env.CLIENT_URL}/single-reservations/${reservation.confirmation_number}`;
			await waSendReservationUpdate(
				reservation,
				`Your reservation was cancelled per your request. Ref: ${link}`
			);
		} catch (_) {}
		return {
			ok: true,
			data: { confirmation_number: reservation.confirmation_number },
		};
	},

	async mark_seen_by_customer({ caseId }) {
		await axios.put(`${API_BASE}/support-cases/${caseId}/seen/client`);
		return { ok: true };
	},

	async escalate_to_human({ caseId, supporterName = "Live Agent", note }) {
		// set supporterName / add conversation note / leave case open
		await SupportCase.findByIdAndUpdate(caseId, {
			supporterName,
			$push: note
				? {
						conversation: {
							messageBy: {
								customerName: supporterName,
								customerEmail: "support@jannatbooking.com",
								userId: "human-support",
							},
							message: note,
							inquiryAbout: "escalation",
							inquiryDetails: note,
							seenByAdmin: true,
							seenByHotel: true,
							seenByCustomer: false,
						},
				  }
				: {},
		});
		return { ok: true };
	},
};

module.exports = { toolSchemas, resolvers };
