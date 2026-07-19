const moment = require("moment-timezone");

const EXECUTIVE_SUMMARY_TIMEZONE = "Asia/Riyadh";
const EXECUTIVE_DAY_OFFSETS = Object.freeze({
	today: 0,
	yesterday: -1,
	tomorrow: 1,
});
const OPERATIONAL_EXCLUDED_STATUSES = Object.freeze([
	"cancelled",
	"canceled",
	"rejected",
	"deleted",
	"no show",
	"no_show",
	"noshow",
]);

const normalizeExecutiveDayFilter = (value = "") => {
	const normalized = String(value || "")
		.trim()
		.toLowerCase();
	return Object.prototype.hasOwnProperty.call(EXECUTIVE_DAY_OFFSETS, normalized)
		? normalized
		: "today";
};

const buildExecutiveDateWindow = (value = "today", now = new Date()) => {
	const filter = normalizeExecutiveDayFilter(value);
	const target = moment
		.tz(now, EXECUTIVE_SUMMARY_TIMEZONE)
		.startOf("day")
		.add(EXECUTIVE_DAY_OFFSETS[filter], "day");
	const end = target.clone().add(1, "day");

	return {
		filter,
		timezone: EXECUTIVE_SUMMARY_TIMEZONE,
		date: target.format("YYYY-MM-DD"),
		label: target.format("dddd, MMMM D, YYYY"),
		start: target.clone().utc().toDate(),
		end: end.utc().toDate(),
	};
};

const buildOperationalStatusFilter = () => ({
	reservation_status: { $nin: [...OPERATIONAL_EXCLUDED_STATUSES] },
	state: { $nin: [...OPERATIONAL_EXCLUDED_STATUSES] },
});

const buildExecutiveReservationMatch = ({ start, end }) => {
	const range = { $gte: start, $lt: end };
	return {
		$or: [
			{
				checkin_date: range,
				...buildOperationalStatusFilter(),
			},
			{
				checkout_date: range,
				...buildOperationalStatusFilter(),
			},
			{ createdAt: range },
		],
	};
};

const safeDate = (value) => {
	const date = value instanceof Date ? value : new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
};

const dateIsWithinWindow = (value, window) => {
	const date = safeDate(value);
	return Boolean(date && date >= window.start && date < window.end);
};

const normalizeStatus = (value = "") =>
	String(value || "")
		.trim()
		.toLowerCase();

const isOperationalReservation = (reservation = {}) =>
	![reservation.reservation_status, reservation.state]
		.map(normalizeStatus)
		.some((status) => OPERATIONAL_EXCLUDED_STATUSES.includes(status));

const isoOrNull = (value) => {
	const date = safeDate(value);
	return date ? date.toISOString() : null;
};

const safeNumber = (value, fallback = 0) => {
	const number = Number(value);
	return Number.isFinite(number) ? number : fallback;
};

const reservationHotel = (reservation = {}) => {
	const hotel = reservation.hotelId;
	if (!hotel || typeof hotel !== "object") {
		return {
			id: String(hotel || ""),
			name: "Unknown Hotel",
			nameArabic: "",
		};
	}
	return {
		id: String(hotel._id || hotel.id || ""),
		name: String(hotel.hotelName || "Unknown Hotel"),
		nameArabic: String(hotel.hotelName_OtherLanguage || ""),
	};
};

const serializeExecutiveReservation = (reservation, activityTypes) => {
	const hotel = reservationHotel(reservation);
	return {
		id: String(reservation._id || reservation.id || ""),
		confirmationNumber: String(reservation.confirmation_number || "N/A"),
		hotel,
		guestName: String(
			reservation.customer_details?.name || reservation.customer_details?.fullName || "Guest"
		),
		status: String(reservation.reservation_status || reservation.state || "unknown"),
		bookingSource: String(reservation.booking_source || "N/A"),
		checkinDate: isoOrNull(reservation.checkin_date),
		checkoutDate: isoOrNull(reservation.checkout_date),
		createdAt: isoOrNull(reservation.createdAt),
		rooms: Math.max(0, safeNumber(reservation.total_rooms)),
		guests: Math.max(0, safeNumber(reservation.total_guests)),
		totalAmount: safeNumber(reservation.total_amount),
		currency: String(reservation.currency || "SAR").toUpperCase(),
		activityTypes,
	};
};

const buildExecutiveReservationSummary = (
	reservations = [],
	window = buildExecutiveDateWindow("today")
) => {
	const rows = [];
	let checkins = 0;
	let checkouts = 0;
	let newReservations = 0;

	for (const reservation of Array.isArray(reservations) ? reservations : []) {
		const activityTypes = [];
		const operational = isOperationalReservation(reservation);

		if (operational && dateIsWithinWindow(reservation.checkin_date, window)) {
			activityTypes.push("checkin");
			checkins += 1;
		}
		if (operational && dateIsWithinWindow(reservation.checkout_date, window)) {
			activityTypes.push("checkout");
			checkouts += 1;
		}
		if (dateIsWithinWindow(reservation.createdAt, window)) {
			activityTypes.push("new-reservation");
			newReservations += 1;
		}

		if (activityTypes.length) {
			rows.push(serializeExecutiveReservation(reservation, activityTypes));
		}
	}

	return {
		filter: window.filter,
		date: window.date,
		dateLabel: window.label,
		timezone: window.timezone,
		generatedAt: new Date().toISOString(),
		summary: {
			checkins,
			checkouts,
			newReservations,
			totalUniqueReservations: rows.length,
		},
		reservations: rows,
	};
};

module.exports = {
	EXECUTIVE_SUMMARY_TIMEZONE,
	OPERATIONAL_EXCLUDED_STATUSES,
	buildExecutiveDateWindow,
	buildExecutiveReservationMatch,
	buildExecutiveReservationSummary,
	normalizeExecutiveDayFilter,
};
