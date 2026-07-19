const moment = require("moment-timezone");

const EXECUTIVE_SUMMARY_TIMEZONE = "Asia/Riyadh";
const EXECUTIVE_SUMMARY_TIMEZONE_LABEL = "Makkah Time";
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

const buildExecutiveComparisonWindow = (
	window = buildExecutiveDateWindow("today")
) => {
	const target = moment
		.tz(window.start, EXECUTIVE_SUMMARY_TIMEZONE)
		.startOf("day")
		.subtract(1, "day");

	return {
		filter: "comparison",
		timezone: EXECUTIVE_SUMMARY_TIMEZONE,
		date: target.format("YYYY-MM-DD"),
		label: target.format("dddd, MMMM D, YYYY"),
		start: target.clone().utc().toDate(),
		end: target.clone().add(1, "day").utc().toDate(),
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

const finiteNumberOrNull = (value) => {
	if (value === null || value === undefined || String(value).trim() === "") return null;
	const number = Number(value);
	return Number.isFinite(number) ? number : null;
};

const roundCurrency = (value) =>
	Math.round((safeNumber(value) + Number.EPSILON) * 100) / 100;

const reservationNights = (reservation = {}) => {
	const checkin = safeDate(reservation.checkin_date);
	const checkout = safeDate(reservation.checkout_date);
	if (!checkin || !checkout) return 0;
	return Math.max(
		0,
		moment
			.tz(checkout, EXECUTIVE_SUMMARY_TIMEZONE)
			.startOf("day")
			.diff(
				moment.tz(checkin, EXECUTIVE_SUMMARY_TIMEZONE).startOf("day"),
				"days"
			)
	);
};

const roomCount = (room = {}) => {
	const count = finiteNumberOrNull(room.count);
	return count !== null && count > 0 ? count : 1;
};

const roomDailyPrice = (day = {}) => {
	for (const value of [
		day.clientPrice,
		day.price,
		day.mainPrice,
		day.totalPriceWithCommission,
	]) {
		const price = finiteNumberOrNull(value);
		if (price !== null && price >= 0) return price;
	}
	return null;
};

const expectedStayAmount = (
	reservation = {},
	nights = reservationNights(reservation)
) => {
	if (nights <= 0) return null;
	const rooms =
		Array.isArray(reservation.pickedRoomsPricing) &&
		reservation.pickedRoomsPricing.length
			? reservation.pickedRoomsPricing
			: reservation.pickedRoomsType;
	if (!Array.isArray(rooms) || !rooms.length) return null;

	let expected = 0;
	for (const room of rooms) {
		const count = roomCount(room);
		const dailyPrices = (Array.isArray(room.pricingByDay) ? room.pricingByDay : [])
			.map(roomDailyPrice)
			.filter((price) => price !== null);

		if (dailyPrices.length === nights) {
			expected += dailyPrices.reduce((sum, price) => sum + price, 0) * count;
			continue;
		}

		const chosenPrice = finiteNumberOrNull(room.chosenPrice);
		if (chosenPrice === null || chosenPrice < 0) return null;
		expected += chosenPrice * nights * count;
	}

	return roundCurrency(expected);
};

const reconcileReservationAmount = (reservation = {}) => {
	const nights = reservationNights(reservation);
	const totalAmount = finiteNumberOrNull(reservation.total_amount);
	if (totalAmount === null || totalAmount < 0) {
		return {
			nights,
			averageNightlyAmount: null,
			amountQuality: { status: "invalid", expectedAmount: null, difference: null },
		};
	}

	const expectedAmount = expectedStayAmount(reservation, nights);
	const difference =
		expectedAmount === null ? null : roundCurrency(totalAmount - expectedAmount);
	const tolerance = Math.max(0.05, Math.abs(totalAmount) * 0.00001);
	return {
		nights,
		averageNightlyAmount: nights > 0 ? roundCurrency(totalAmount / nights) : null,
		amountQuality: {
			status:
				expectedAmount === null
					? "unverified"
					: Math.abs(difference) <= tolerance
					  ? "verified"
					  : "discrepancy",
			expectedAmount,
			difference,
		},
	};
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
	const amountAudit = reconcileReservationAmount(reservation);
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
		...amountAudit,
		activityTypes,
	};
};

const executiveActivityTypesForWindow = (reservation, window) => {
	const activityTypes = [];
	const operational = isOperationalReservation(reservation);

	if (operational && dateIsWithinWindow(reservation.checkin_date, window)) {
		activityTypes.push("checkin");
	}
	if (operational && dateIsWithinWindow(reservation.checkout_date, window)) {
		activityTypes.push("checkout");
	}
	if (dateIsWithinWindow(reservation.createdAt, window)) {
		activityTypes.push("new-reservation");
	}

	return activityTypes;
};

const activityMetricKey = (activityType) =>
	activityType === "checkin"
		? "checkins"
		: activityType === "checkout"
		  ? "checkouts"
		  : "newReservations";

const emptyActivityMetrics = () => ({
	checkins: { count: 0, sarAmount: 0, excludedNonSarCount: 0, invalidAmountCount: 0 },
	checkouts: { count: 0, sarAmount: 0, excludedNonSarCount: 0, invalidAmountCount: 0 },
	newReservations: {
		count: 0,
		sarAmount: 0,
		excludedNonSarCount: 0,
		invalidAmountCount: 0,
	},
});

const addReservationToActivityMetrics = (metrics, reservation, activityTypes) => {
	const currency = String(reservation.currency || "SAR")
		.trim()
		.toUpperCase();
	const amount = finiteNumberOrNull(reservation.total_amount);

	for (const activityType of activityTypes) {
		const metric = metrics[activityMetricKey(activityType)];
		metric.count += 1;
		if (currency !== "SAR") {
			metric.excludedNonSarCount += 1;
		} else if (amount === null || amount < 0) {
			metric.invalidAmountCount += 1;
		} else {
			metric.sarAmount = roundCurrency(metric.sarAmount + amount);
		}
	}
};

const percentageVariance = (current, previous) => {
	if (previous === 0) return current === 0 ? 0 : null;
	return Math.round((((current - previous) / previous) * 100 + Number.EPSILON) * 10) / 10;
};

const varianceState = (current, previous) => {
	if (previous === 0 && current > 0) return "new";
	if (current > previous) return "increase";
	if (current < previous) return "decrease";
	return "unchanged";
};

const compareActivityMetrics = (currentMetrics, previousMetrics) =>
	Object.fromEntries(
		Object.keys(currentMetrics).map((key) => {
			const current = currentMetrics[key];
			const previous = previousMetrics[key];
			return [
				key,
				{
					...current,
					previousCount: previous.count,
					previousSarAmount: roundCurrency(previous.sarAmount),
					variancePercent: percentageVariance(current.count, previous.count),
					amountVariancePercent: percentageVariance(
						current.sarAmount,
						previous.sarAmount
					),
					varianceState: varianceState(current.count, previous.count),
				},
			];
		})
	);

const buildExecutiveReservationSummary = (
	reservations = [],
	window = buildExecutiveDateWindow("today"),
	comparisonWindow = buildExecutiveComparisonWindow(window)
) => {
	const rows = [];
	const currentMetrics = emptyActivityMetrics();
	const previousMetrics = emptyActivityMetrics();

	for (const reservation of Array.isArray(reservations) ? reservations : []) {
		const activityTypes = executiveActivityTypesForWindow(reservation, window);
		const comparisonActivityTypes = executiveActivityTypesForWindow(
			reservation,
			comparisonWindow
		);
		addReservationToActivityMetrics(currentMetrics, reservation, activityTypes);
		addReservationToActivityMetrics(
			previousMetrics,
			reservation,
			comparisonActivityTypes
		);

		if (activityTypes.length) {
			rows.push(serializeExecutiveReservation(reservation, activityTypes));
		}
	}
	const metrics = compareActivityMetrics(currentMetrics, previousMetrics);

	const totalsByCurrency = rows.reduce((totals, row) => {
		const currency = row.currency || "SAR";
		totals[currency] = roundCurrency((totals[currency] || 0) + row.totalAmount);
		return totals;
	}, {});
	const currencies = Object.keys(totalsByCurrency);
	const primaryCurrency = currencies.length <= 1 ? currencies[0] || "SAR" : null;
	const verifiedAmounts = rows.filter(
		(row) => row.amountQuality?.status === "verified"
	).length;
	const amountsNeedingReview = rows.filter((row) =>
		["invalid", "discrepancy"].includes(row.amountQuality?.status)
	).length;

	return {
		filter: window.filter,
		date: window.date,
		dateLabel: window.label,
		timezone: window.timezone,
		timezoneLabel: EXECUTIVE_SUMMARY_TIMEZONE_LABEL,
		timezoneOffset: "UTC+03:00",
		generatedAt: new Date().toISOString(),
		comparison: {
			date: comparisonWindow.date,
			dateLabel: comparisonWindow.label,
		},
		summary: {
			checkins: metrics.checkins.count,
			checkouts: metrics.checkouts.count,
			newReservations: metrics.newReservations.count,
			metrics,
			totalUniqueReservations: rows.length,
			totalAmount: primaryCurrency ? totalsByCurrency[primaryCurrency] || 0 : null,
			currency: primaryCurrency,
			totalsByCurrency,
			mixedCurrencies: currencies.length > 1,
			verifiedAmounts,
			amountsNeedingReview,
		},
		reservations: rows,
	};
};

module.exports = {
	EXECUTIVE_SUMMARY_TIMEZONE,
	EXECUTIVE_SUMMARY_TIMEZONE_LABEL,
	OPERATIONAL_EXCLUDED_STATUSES,
	buildExecutiveComparisonWindow,
	buildExecutiveDateWindow,
	buildExecutiveReservationMatch,
	buildExecutiveReservationSummary,
	reconcileReservationAmount,
	normalizeExecutiveDayFilter,
};
