/** @format */

"use strict";

const mongoose = require("mongoose");
const moment = require("moment-timezone");
const HotelDetails = require("../models/hotel_details");
const {
	agentIdFromReservation,
	getAgentPricingForDate,
} = require("./agentRoomOverrides");

class ReservationPricingError extends Error {
	constructor(message, statusCode = 400, code = "reservation_pricing_error", details = {}) {
		super(message);
		this.name = "ReservationPricingError";
		this.statusCode = statusCode;
		this.code = code;
		this.details = details;
	}
}

const moneyNumber = (value) => {
	if (value === null || value === undefined || value === "") return 0;
	if (typeof value === "number") {
		return Number.isFinite(value) ? value : 0;
	}
	const parsed = Number(String(value).replace(/,/g, "").trim());
	return Number.isFinite(parsed) ? parsed : 0;
};

const hasNumericInput = (value) =>
	value !== null && value !== undefined && value !== "";

const nullableNumber = (value) => {
	if (!hasNumericInput(value)) return null;
	if (typeof value === "number") {
		return Number.isFinite(value) ? value : null;
	}
	const parsed = Number(String(value).replace(/,/g, "").trim());
	return Number.isFinite(parsed) ? parsed : null;
};

const n2 = (value) => Number(moneyNumber(value).toFixed(2));

const hasOwn = (object, key) =>
	Object.prototype.hasOwnProperty.call(object || {}, key);

const firstNumericInput = (...values) => {
	for (const value of values) {
		const parsed = nullableNumber(value);
		if (parsed !== null) return parsed;
	}
	return null;
};

const resolveClientPrice = (day = {}) =>
	n2(
		firstNumericInput(
			day.clientPrice,
			day.mainPrice,
			day.totalPriceWithCommission,
			day.price
		) ?? 0
	);

const resolveNetAfterExpenses = (day = {}, clientPrice = 0) => {
	const explicitNet = firstNumericInput(
		day.netAfterExpenses,
		day.netAfterOtaExpenses,
		day.netAfterOtherExpenses
	);
	if (explicitNet !== null) return n2(explicitNet);

	const explicitExpense = firstNumericInput(
		day.otaExpenseAmount,
		day.otherExpenseAmount,
		day.expenseAmount
	);
	if (explicitExpense !== null) return n2(clientPrice - explicitExpense);

	return n2(clientPrice);
};

const buildAdminPricingDayFields = (day = {}, clientPrice = 0, rootPrice = 0) => {
	const netAfterExpenses = resolveNetAfterExpenses(day, clientPrice);
	const otaExpenseAmount = n2(clientPrice - netAfterExpenses);
	const platformMargin = n2(netAfterExpenses - rootPrice);
	const otaExpenseRate =
		clientPrice > 0 ? n2((otaExpenseAmount / clientPrice) * 100) : 0;
	const platformMarginRate =
		netAfterExpenses > 0 ? n2((platformMargin / netAfterExpenses) * 100) : 0;

	return {
		clientPrice: n2(clientPrice),
		mainPrice: n2(clientPrice),
		netAfterExpenses,
		netAfterOtaExpenses: netAfterExpenses,
		otaExpenseAmount,
		otaExpenseRate,
		platformMargin,
		platformMarginRate,
	};
};

const toPlainObject = (value) => {
	if (!value) return {};
	if (typeof value.toObject === "function") return value.toObject();
	return value;
};

const normalizeId = (value) =>
	String(value?._id || value || "")
		.trim();

const dateOnlyKey = (value) => {
	if (!value) return "";
	if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) {
		return value.slice(0, 10);
	}
	const parsed = moment.utc(value);
	return parsed.isValid() ? parsed.format("YYYY-MM-DD") : "";
};

const buildStayDateKeys = (checkinDate, checkoutDate) => {
	const startKey = dateOnlyKey(checkinDate);
	const endKey = dateOnlyKey(checkoutDate);
	const start = moment.utc(startKey, "YYYY-MM-DD", true);
	const endExclusive = moment.utc(endKey, "YYYY-MM-DD", true);
	if (!start.isValid() || !endExclusive.isValid() || !endExclusive.isAfter(start)) {
		return [];
	}

	const days = [];
	for (
		const day = start.clone();
		day.isBefore(endExclusive, "day");
		day.add(1, "day")
	) {
		days.push(day.format("YYYY-MM-DD"));
	}
	return days;
};

const normalizeText = (value) =>
	String(value || "")
		.trim()
		.toLowerCase();

const normalizeCommissionPercent = (raw, fallback = 10) => {
	let value = nullableNumber(raw);
	if (value === null || value < 0) value = nullableNumber(fallback);
	if (value === null || value < 0) value = 10;
	if (value > 0 && value <= 1) value *= 100;
	return value;
};

const resolveDetailBasePrice = (detail = {}) => {
	const candidates = [
		detail?.price?.basePrice,
		detail?.basePrice,
		detail?.roomPrice,
		detail?.price,
	];
	const resolved = candidates.map(moneyNumber).find((value) => value > 0);
	return resolved || 0;
};

const resolveDetailDefaultCost = (detail = {}, basePrice = 0) => {
	const candidates = [
		detail?.defaultCost,
		detail?.cost,
		detail?.rootPrice,
		detail?.price?.defaultCost,
		basePrice,
	];
	const resolved = candidates.map(moneyNumber).find((value) => value > 0);
	return resolved || 0;
};

const resolveDailyPrice = (rate, basePrice, defaultCost) => {
	const calendarPrice = moneyNumber(rate?.price);
	if (rate && calendarPrice > 0) return calendarPrice;
	if (basePrice > 0) return basePrice;
	if (defaultCost > 0) return defaultCost;
	return 0;
};

const resolveDailyRootPrice = (rate, defaultCost, finalPrice) => {
	const calendarRoot = moneyNumber(rate?.rootPrice);
	if (rate && calendarRoot > 0) return calendarRoot;
	if (defaultCost > 0) return defaultCost;
	return finalPrice > 0 ? finalPrice : 0;
};

const calendarRateIsBlocked = (rate = {}) => {
	if (!rate || typeof rate !== "object") return false;
	const price = Number(rate.price);
	const rootPrice = Number(rate.rootPrice);
	const color = String(rate.color || "").toLowerCase();
	return (
		(Number.isFinite(price) && price <= 0) ||
		(Number.isFinite(rootPrice) && rootPrice <= 0 && color === "black") ||
		color === "black"
	);
};

const findRoomDetail = (details = [], selection = {}) => {
	const roomType = normalizeText(selection.room_type || selection.roomType);
	const displayName = normalizeText(
		selection.displayName || selection.display_name
	);

	const exact = details.find(
		(detail) =>
			normalizeText(detail?.roomType || detail?.room_type) === roomType &&
			normalizeText(detail?.displayName || detail?.display_name) === displayName
	);
	if (exact) return exact;

	const byRoomType = details.find(
		(detail) => normalizeText(detail?.roomType || detail?.room_type) === roomType
	);
	if (byRoomType) return byRoomType;

	return details.find(
		(detail) =>
			displayName &&
			normalizeText(detail?.displayName || detail?.display_name) === displayName
	);
};

const normalizeRoomCount = (count) => {
	const parsed = Number(count);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
};

const getRoomType = (room = {}) =>
	String(room.room_type || room.roomType || "").trim();

const getRoomDisplayName = (room = {}) =>
	String(room.displayName || room.display_name || "").trim();

const dayMatchesStay = (day = {}, expectedDate) =>
	dateOnlyKey(day.date || day.calendarDate) === expectedDate;

const roomHasCompleteStayPricing = (room = {}, stayDates = []) => {
	if (!stayDates.length) return false;
	const rows = Array.isArray(room.pricingByDay) ? room.pricingByDay : [];
	return (
		rows.length === stayDates.length &&
		rows.every((day, index) => {
			const final = moneyNumber(day?.totalPriceWithCommission ?? day?.price);
			const root = moneyNumber(day?.rootPrice);
			return dayMatchesStay(day, stayDates[index]) && final > 0 && root >= 0;
		})
	);
};

const roomsHaveCompleteStayPricing = (rooms = [], stayDates = []) =>
	Array.isArray(rooms) &&
	rooms.length > 0 &&
	rooms.every((room) => roomHasCompleteStayPricing(room, stayDates));

const normalizeProvidedPricingDay = (day = {}) => {
	const finalPrice = resolveClientPrice(day);
	const totalPriceWithCommission = finalPrice;
	const totalPriceWithoutCommission = n2(
		day.totalPriceWithoutCommission ?? day.clientPrice ?? day.mainPrice ?? finalPrice
	);
	const rootPrice = resolveDayRootPrice(day, totalPriceWithoutCommission || finalPrice);
	const adminPricingDayFields = buildAdminPricingDayFields(
		day,
		finalPrice,
		rootPrice
	);
	return {
		...day,
		date: dateOnlyKey(day.date || day.calendarDate),
		price: finalPrice,
		rootPrice,
		commissionRate: n2(day.commissionRate),
		totalPriceWithCommission,
		totalPriceWithoutCommission,
		...adminPricingDayFields,
	};
};

const resolveDayRootPrice = (day = {}, fallback = 0) => {
	if (hasNumericInput(day.rootPrice)) {
		const explicitRoot = moneyNumber(day.rootPrice);
		if (explicitRoot >= 0) return n2(explicitRoot);
	}

	const withoutCommission = moneyNumber(day.totalPriceWithoutCommission);
	if (withoutCommission > 0) return n2(withoutCommission);

	const finalPrice = moneyNumber(day.totalPriceWithCommission ?? day.price);
	if (finalPrice > 0) return n2(finalPrice);

	return n2(fallback);
};

const summarizePricingDays = (pricingByDay = []) => {
	const rows = Array.isArray(pricingByDay) ? pricingByDay : [];
	return rows.reduce(
		(acc, day) => {
			const clientPrice = resolveClientPrice(day);
			const rootPrice = resolveDayRootPrice(day, clientPrice);
			const netAfterExpenses = resolveNetAfterExpenses(day, clientPrice);
			acc.clientTotal = n2(acc.clientTotal + clientPrice);
			acc.rootTotal = n2(acc.rootTotal + rootPrice);
			acc.netAfterExpensesTotal = n2(
				acc.netAfterExpensesTotal + netAfterExpenses
			);
			acc.otaExpenseTotal = n2(
				acc.otaExpenseTotal + (clientPrice - netAfterExpenses)
			);
			acc.platformMarginTotal = n2(
				acc.platformMarginTotal + (netAfterExpenses - rootPrice)
			);
			return acc;
		},
		{
			clientTotal: 0,
			rootTotal: 0,
			netAfterExpensesTotal: 0,
			otaExpenseTotal: 0,
			platformMarginTotal: 0,
		}
	);
};

const normalizeProvidedRoomPricing = (room = {}) => {
	const pricingByDay = Array.isArray(room.pricingByDay)
		? room.pricingByDay.map(normalizeProvidedPricingDay)
		: [];
	const totalWithCommission = n2(
		pricingByDay.reduce(
			(sum, day) => sum + moneyNumber(day.totalPriceWithCommission ?? day.price),
			0
		)
	);
	const hotelShouldGet = n2(
		pricingByDay.reduce((sum, day) => sum + moneyNumber(day.rootPrice), 0)
	);
	const adminPricing = summarizePricingDays(pricingByDay);
	const averageNight =
		pricingByDay.length > 0
			? n2(totalWithCommission / pricingByDay.length)
			: n2(room.chosenPrice);

	return {
		...room,
		room_type: getRoomType(room),
		displayName: getRoomDisplayName(room) || getRoomType(room),
		chosenPrice: averageNight.toFixed(2),
		count: normalizeRoomCount(room.count),
		pricingByDay,
		totalPriceWithCommission: totalWithCommission,
		hotelShouldGet,
		adminPricing,
	};
};

const getPricingDayFinal = (day = {}) =>
	moneyNumber(day.totalPriceWithCommission ?? day.price);

const findPricingDayForDate = (rows = [], date) =>
	(Array.isArray(rows) ? rows : []).find(
		(day) => dateOnlyKey(day?.date || day?.calendarDate) === date
	);

const averagePricingFinal = (rows = []) => {
	const pricedRows = (Array.isArray(rows) ? rows : [])
		.map(getPricingDayFinal)
		.filter((value) => value > 0);
	if (!pricedRows.length) return 0;
	return n2(pricedRows.reduce((sum, value) => sum + value, 0) / pricedRows.length);
};

const getRoomNightlyPrice = (room = {}) => {
	const chosenPrice = moneyNumber(room.chosenPrice);
	if (chosenPrice > 0) return n2(chosenPrice);
	return averagePricingFinal(room.pricingByDay);
};

const getDayValue = (day = {}, field, fallback) =>
	hasOwn(day, field) ? n2(day[field]) : n2(fallback);

const buildDayWithNightlyPrice = (template = {}, date, nightlyPrice) => {
	const finalPrice = n2(nightlyPrice);
	const totalPriceWithoutCommission = getDayValue(
		template,
		"totalPriceWithoutCommission",
		finalPrice
	);
	const rootPrice = resolveDayRootPrice(
		{ ...template, totalPriceWithoutCommission },
		totalPriceWithoutCommission || finalPrice
	);
	return {
		...template,
		date,
		price: finalPrice,
		rootPrice,
		commissionRate: getDayValue(template, "commissionRate", 0),
		totalPriceWithCommission: finalPrice,
		totalPriceWithoutCommission,
		...buildAdminPricingDayFields(template, finalPrice, rootPrice),
	};
};

const projectRoomPricingToNightlyPrice = (room = {}, stayDates = []) => {
	const nightlyPrice = getRoomNightlyPrice(room);
	if (!(nightlyPrice > 0) || !stayDates.length) return room;
	const rows = Array.isArray(room.pricingByDay) ? room.pricingByDay : [];
	const firstTemplate = rows[0] || {};
	return {
		...room,
		pricingByDay: stayDates.map((date, index) => {
			const template =
				findPricingDayForDate(rows, date) || rows[index] || firstTemplate;
			return buildDayWithNightlyPrice(template, date, nightlyPrice);
		}),
	};
};

const comparableRoomDay = (day = {}) => ({
	date: dateOnlyKey(day.date || day.calendarDate),
	price: n2(day.totalPriceWithCommission ?? day.price),
	rootPrice: n2(day.rootPrice),
	commissionRate: n2(day.commissionRate),
	totalPriceWithCommission: n2(day.totalPriceWithCommission ?? day.price),
	totalPriceWithoutCommission: n2(
		day.totalPriceWithoutCommission ?? day.totalPriceWithCommission ?? day.price
	),
	clientPrice: n2(day.clientPrice ?? day.totalPriceWithCommission ?? day.price),
	netAfterExpenses: n2(
		day.netAfterExpenses ??
			day.netAfterOtaExpenses ??
			day.totalPriceWithCommission ??
			day.price
	),
	otaExpenseAmount: n2(day.otaExpenseAmount),
	platformMargin: n2(day.platformMargin),
});

const comparableRoom = (room = {}) => ({
	room_type: getRoomType(room),
	displayName: getRoomDisplayName(room),
	count: normalizeRoomCount(room.count),
	chosenPrice: n2(room.chosenPrice),
	pricingByDay: Array.isArray(room.pricingByDay)
		? room.pricingByDay.map(comparableRoomDay)
		: [],
});

const roomsAreSame = (left = [], right = []) =>
	JSON.stringify((Array.isArray(left) ? left : []).map(comparableRoom)) ===
	JSON.stringify((Array.isArray(right) ? right : []).map(comparableRoom));

const roomIdentity = (room = {}) =>
	`${normalizeText(getRoomType(room))}|${normalizeText(getRoomDisplayName(room))}`;

const roomIdentitiesAreSame = (left = [], right = []) => {
	const leftRooms = Array.isArray(left) ? left : [];
	const rightRooms = Array.isArray(right) ? right : [];
	if (leftRooms.length !== rightRooms.length) return false;
	return leftRooms.every(
		(room, index) => roomIdentity(room) === roomIdentity(rightRooms[index])
	);
};

const findExistingRoomFor = (existingRooms = [], room = {}, index = 0) => {
	const byIndex = Array.isArray(existingRooms) ? existingRooms[index] : null;
	if (byIndex && roomIdentity(byIndex) === roomIdentity(room)) return byIndex;
	return (Array.isArray(existingRooms) ? existingRooms : []).find(
		(existingRoom) => roomIdentity(existingRoom) === roomIdentity(room)
	);
};

const pricingRowsAreSame = (left = [], right = []) =>
	JSON.stringify((Array.isArray(left) ? left : []).map(comparableRoomDay)) ===
	JSON.stringify((Array.isArray(right) ? right : []).map(comparableRoomDay));

const shouldPreferChosenNightlyPrice = (room = {}, existingRoom = null) => {
	const chosenPrice = getRoomNightlyPrice(room);
	if (!(chosenPrice > 0)) return false;
	if (!existingRoom) return true;
	const existingChosen = getRoomNightlyPrice(existingRoom);
	const chosenChanged = n2(chosenPrice) !== n2(existingChosen);
	const pricingUnchanged = pricingRowsAreSame(
		room.pricingByDay,
		existingRoom.pricingByDay
	);
	return chosenChanged && pricingUnchanged;
};

const buildCanonicalRoomPricing = ({
	hotel,
	room,
	stayDates,
	preferChosenPrice = false,
	preferCalendarPrice = false,
	allowBlockedCalendar = false,
	warnings = [],
	agentId = "",
}) => {
	const details = Array.isArray(hotel?.roomCountDetails)
		? hotel.roomCountDetails
		: [];
	const roomType = getRoomType(room);
	const displayName = getRoomDisplayName(room);
	const detail = findRoomDetail(details, { room_type: roomType, displayName });

	if (!detail) {
		throw new ReservationPricingError(
			`Could not recalculate pricing for ${displayName || roomType || "selected room"}. Please reselect the room type before saving.`,
			409,
			"room_pricing_not_found",
			{ room_type: roomType, displayName }
		);
	}

	const rates = Array.isArray(detail.pricingRate) ? detail.pricingRate : [];
	const agentOverrideId = normalizeId(agentId || agentIdFromReservation(room));
	const basePrice = resolveDetailBasePrice(detail);
	const defaultCost = resolveDetailDefaultCost(detail, basePrice);
	const fallbackCommission = normalizeCommissionPercent(
		detail?.roomCommission,
		hotel?.commission ?? 10
	);
	const normalizedRoomType = roomType || detail.roomType || detail.room_type || "";
	const normalizedDisplayName =
		displayName || detail.displayName || detail.display_name || normalizedRoomType;
	const providedRows = Array.isArray(room.pricingByDay) ? room.pricingByDay : [];
	const firstProvidedRow = providedRows[0] || {};
	const roomNightlyPrice = getRoomNightlyPrice(room);
	const pricingByDay = stayDates.map((date, index) => {
		const agentRate = getAgentPricingForDate(detail, agentOverrideId, date);
		const hotelRate = rates.find((item) => item?.calendarDate === date);
		const rate = agentRate || hotelRate;
		const blockedOnCalendar = calendarRateIsBlocked(rate);
		if (blockedOnCalendar && !allowBlockedCalendar) {
			throw new ReservationPricingError(
				`${normalizedDisplayName || normalizedRoomType} is blocked on the hotel calendar for ${date}.`,
				409,
				"calendar_date_blocked",
				{
					room_type: normalizedRoomType,
					displayName: normalizedDisplayName,
					date,
				}
			);
		}
		if (blockedOnCalendar) {
			warnings.push({
				code: "calendar_date_blocked_override",
				message: `${normalizedDisplayName || normalizedRoomType} is blocked on the hotel calendar for ${date}. The reservation was allowed because it was created by hotel staff.`,
				room_type: normalizedRoomType,
				displayName: normalizedDisplayName,
				date,
			});
		}

		const effectiveRate = blockedOnCalendar ? null : rate;
		const dayPrice = resolveDailyPrice(effectiveRate, basePrice, defaultCost);
		const rootPrice = resolveDailyRootPrice(
			effectiveRate,
			defaultCost || basePrice,
			dayPrice
		);
		const commissionRate = normalizeCommissionPercent(
			effectiveRate?.commissionRate,
			fallbackCommission
		);
		const calendarTotalPriceWithCommission = n2(
			dayPrice + rootPrice * (commissionRate / 100)
		);
		const canonicalDailyPrice =
			calendarTotalPriceWithCommission > 0
				? calendarTotalPriceWithCommission
				: 0;
		const providedDay =
			findPricingDayForDate(providedRows, date) ||
			providedRows[index] ||
			firstProvidedRow;
		const providedFinal = getPricingDayFinal(providedDay);
		const totalPriceWithCommission =
			preferChosenPrice && roomNightlyPrice > 0
				? roomNightlyPrice
				: preferCalendarPrice && canonicalDailyPrice > 0
				  ? canonicalDailyPrice
				: providedFinal > 0
				  ? n2(providedFinal)
				  : roomNightlyPrice > 0
				    ? roomNightlyPrice
				    : canonicalDailyPrice;
		const totalPriceWithoutCommission = getDayValue(
			providedDay,
			"totalPriceWithoutCommission",
			dayPrice || totalPriceWithCommission
		);
		const resolvedRootPrice = resolveDayRootPrice(
			{ ...providedDay, totalPriceWithoutCommission },
			rootPrice || totalPriceWithoutCommission || totalPriceWithCommission
		);
		const resolvedCommissionRate = getDayValue(
			providedDay,
			"commissionRate",
			commissionRate
		);

		if (!(totalPriceWithCommission > 0)) {
			throw new ReservationPricingError(
				`${normalizedDisplayName || normalizedRoomType} has no valid price for ${date}.`,
				409,
				"calendar_price_missing",
				{
					room_type: normalizedRoomType,
					displayName: normalizedDisplayName,
					date,
				}
			);
		}

		const adminPricingDayFields = buildAdminPricingDayFields(
			providedDay,
			totalPriceWithCommission,
			resolvedRootPrice
		);

		return {
			date,
			// Stored reservation rows have historically used price as the final
			// nightly amount. Keep that shape while also storing the no-commission
			// portion explicitly for reports that need it.
			price: totalPriceWithCommission,
			rootPrice: resolvedRootPrice,
			commissionRate: resolvedCommissionRate,
			totalPriceWithCommission,
			totalPriceWithoutCommission,
			...adminPricingDayFields,
		};
	});

	return normalizeProvidedRoomPricing({
		...room,
		room_type: normalizedRoomType,
		displayName: normalizedDisplayName,
		count: normalizeRoomCount(room.count),
		pricingByDay,
	});
};

const normalizeReservationCreationPricing = async (
	reservationPayload = {},
	options = {}
) => {
	const updates = { ...reservationPayload };
	const warnings = [];
	const stayDates = buildStayDateKeys(updates.checkin_date, updates.checkout_date);
	const rooms = Array.isArray(updates.pickedRoomsType)
		? updates.pickedRoomsType
		: [];
	const pricingRooms = Array.isArray(updates.pickedRoomsPricing)
		? updates.pickedRoomsPricing
		: [];
	const primaryRooms = rooms.length > 0 ? rooms : pricingRooms;
	const nextHotelId = normalizeId(updates.hotelId);
	const agentId = normalizeId(
		options.agentId ||
			agentIdFromReservation(updates) ||
			updates.requestingUserId ||
			updates.createdByUserId
	);

	if (!stayDates.length || !primaryRooms.length) {
		return { reservation: updates, warnings };
	}

	if (!mongoose.Types.ObjectId.isValid(nextHotelId)) {
		throw new ReservationPricingError(
			"A valid hotel is required to calculate reservation pricing.",
			400,
			"invalid_hotel_for_pricing"
		);
	}

	const hotel = await HotelDetails.findById(nextHotelId)
		.select("_id hotelName commission currency roomCountDetails")
		.lean()
		.exec();
	if (!hotel) {
		throw new ReservationPricingError(
			"Hotel pricing details were not found.",
			404,
			"hotel_pricing_not_found",
			{ hotelId: nextHotelId }
		);
	}

	const nextRooms = primaryRooms.map((room, index) => {
		const existingRoom = findExistingRoomFor(primaryRooms, room, index);
		return buildCanonicalRoomPricing({
			hotel,
			room,
			stayDates,
			preferChosenPrice: shouldPreferChosenNightlyPrice(room, existingRoom),
			preferCalendarPrice: true,
			allowBlockedCalendar: !!options.allowBlockedCalendar,
			warnings,
			agentId,
		});
	});

	const totals = summarizeRooms(nextRooms);
	updates.pickedRoomsType = nextRooms;
	updates.pickedRoomsPricing = nextRooms;
	updates.total_rooms = nextRooms.reduce(
		(sum, room) => sum + normalizeRoomCount(room.count),
		0
	);
	updates.days_of_residence = stayDates.length;
	updates.total_amount = totals.total_amount;
	updates.sub_total = totals.sub_total;
	updates.adminPricing = totals.adminPricing;

	return { reservation: updates, warnings };
};

const summarizeRooms = (rooms = []) => {
	const totals = rooms.reduce(
		(acc, room) => {
			const count = normalizeRoomCount(room.count);
			const pricingByDay = Array.isArray(room.pricingByDay)
				? room.pricingByDay
				: [];
			const roomTotal = pricingByDay.reduce(
				(sum, day) =>
					sum + moneyNumber(day.totalPriceWithCommission ?? day.price),
				0
			);
			const roomRoot = pricingByDay.reduce(
				(sum, day) =>
					sum +
					resolveDayRootPrice(
						day,
						moneyNumber(day.totalPriceWithCommission ?? day.price)
					),
				0
			);
			const roomAdminPricing = summarizePricingDays(pricingByDay);
			acc.totalAmount += roomTotal * count;
			acc.subTotal += roomRoot * count;
			acc.netAfterExpenses += roomAdminPricing.netAfterExpensesTotal * count;
			acc.otaExpenses += roomAdminPricing.otaExpenseTotal * count;
			acc.platformMargin += roomAdminPricing.platformMarginTotal * count;
			return acc;
		},
		{
			totalAmount: 0,
			subTotal: 0,
			netAfterExpenses: 0,
			otaExpenses: 0,
			platformMargin: 0,
		}
	);
	const totalAmount = n2(totals.totalAmount);
	const subTotal = n2(totals.subTotal);
	const netAfterExpensesTotal = n2(totals.netAfterExpenses);
	const otaExpenseTotal = n2(totals.otaExpenses);
	const platformMarginTotal = n2(totals.platformMargin);

	return {
		total_amount: totalAmount,
		sub_total: subTotal,
		commission: n2(totalAmount - subTotal),
		adminPricing: {
			mode: "admin_three_price",
			clientTotal: totalAmount,
			rootTotal: subTotal,
			netAfterExpensesTotal,
			otaExpenseTotal,
			platformMarginTotal,
		},
	};
};

const resetCommissionAssignmentForPricingChange = (updates, existing) => {
	const existingCommissionData = toPlainObject(existing.commissionData);
	updates.commission = 0;
	updates.commissionPaid = false;
	updates.commissionStatus = "";
	updates.commissionData = {
		...existingCommissionData,
		assigned: false,
		amount: 0,
		status: "",
		assignedAt: null,
		assignedBy: null,
		resetAt: new Date(),
		resetReason: "reservation_pricing_changed",
	};
	updates.__commissionAssignmentReset = true;
};

const getRoomSource = (existingReservation, updatePayload, field) => {
	if (hasOwn(updatePayload, field)) {
		const candidate = updatePayload[field];
		if (
			Array.isArray(candidate) &&
			candidate.length === 0 &&
			Array.isArray(existingReservation[field]) &&
			existingReservation[field].length > 0
		) {
			return existingReservation[field];
		}
		return candidate;
	}
	return existingReservation[field];
};

const normalizeReservationStayPricing = async (
	existingReservation,
	updatePayload = {}
) => {
	const existing = toPlainObject(existingReservation);
	const updates = { ...updatePayload };
	const checkinTouched = hasOwn(updates, "checkin_date");
	const checkoutTouched = hasOwn(updates, "checkout_date");
	const dateTouched = checkinTouched || checkoutTouched;
	const hotelTouched = hasOwn(updates, "hotelId");
	const roomFieldsSent =
		hasOwn(updates, "pickedRoomsType") || hasOwn(updates, "pickedRoomsPricing");

	const nextHotelId = normalizeId(
		hotelTouched ? updates.hotelId : existing.hotelId
	);
	const agentId = normalizeId(
		agentIdFromReservation(updates) || agentIdFromReservation(existing)
	);
	const nextCheckin = checkinTouched ? updates.checkin_date : existing.checkin_date;
	const nextCheckout = checkoutTouched
		? updates.checkout_date
		: existing.checkout_date;
	const stayDates = buildStayDateKeys(nextCheckin, nextCheckout);

	if (dateTouched && stayDates.length === 0) {
		throw new ReservationPricingError(
			"Checkout date must be after check-in date.",
			400,
			"invalid_stay_dates"
		);
	}

	if (!stayDates.length) {
		return updates;
	}

	const dateChanged =
		(checkinTouched &&
			dateOnlyKey(nextCheckin) !== dateOnlyKey(existing.checkin_date)) ||
		(checkoutTouched &&
			dateOnlyKey(nextCheckout) !== dateOnlyKey(existing.checkout_date));
	const hotelChanged =
		hotelTouched && nextHotelId !== normalizeId(existing.hotelId);

	if (dateChanged) {
		updates.days_of_residence = stayDates.length;
	}

	const sourceRooms = getRoomSource(existing, updates, "pickedRoomsType");
	const sourceRoomsPricing = getRoomSource(
		existing,
		updates,
		"pickedRoomsPricing"
	);
	const rooms = Array.isArray(sourceRooms) ? sourceRooms : [];
	const pricingRooms = Array.isArray(sourceRoomsPricing)
		? sourceRoomsPricing
		: [];
	const hasRooms = rooms.length > 0 || pricingRooms.length > 0;
	const primaryRooms = rooms.length > 0 ? rooms : pricingRooms;
	const existingRooms = Array.isArray(existing.pickedRoomsType)
		? existing.pickedRoomsType
		: [];
	const existingPricingRooms = Array.isArray(existing.pickedRoomsPricing)
		? existing.pickedRoomsPricing
		: [];
	const existingPrimaryRooms =
		rooms.length > 0 ? existingRooms : existingPricingRooms;
	const roomsChanged =
		hasOwn(updates, "pickedRoomsType") && !roomsAreSame(rooms, existingRooms);
	const pricingRoomsChanged =
		hasOwn(updates, "pickedRoomsPricing") &&
		!roomsAreSame(pricingRooms, existingPricingRooms);
	const roomsTouched = roomsChanged || pricingRoomsChanged;
	const roomIdentityChanged =
		(hasOwn(updates, "pickedRoomsType") &&
			!roomIdentitiesAreSame(rooms, existingRooms)) ||
		(hasOwn(updates, "pickedRoomsPricing") &&
			!roomIdentitiesAreSame(pricingRooms, existingPricingRooms));
	const primaryRoomsComplete = roomsHaveCompleteStayPricing(
		primaryRooms,
		stayDates
	);
	const mustReprice =
		hasRooms &&
		(hotelChanged ||
			roomIdentityChanged ||
			(!primaryRoomsComplete && (dateChanged || roomsTouched)));
	const canUseProvidedPricing =
		hasRooms && !hotelChanged && primaryRoomsComplete && roomsTouched;

	if (!hasRooms) {
		return updates;
	}

	if (roomFieldsSent && !roomsTouched && !dateChanged && !hotelChanged) {
		delete updates.pickedRoomsType;
		delete updates.pickedRoomsPricing;
		delete updates.total_rooms;
		delete updates.days_of_residence;
		delete updates.total_amount;
		delete updates.sub_total;
		delete updates.commission;
		return updates;
	}

	let nextRooms;
	if (mustReprice) {
		if (!mongoose.Types.ObjectId.isValid(nextHotelId)) {
			throw new ReservationPricingError(
				"A valid hotel is required to recalculate reservation pricing.",
				400,
				"invalid_hotel_for_pricing"
			);
		}
		const hotel = await HotelDetails.findById(nextHotelId)
			.select("_id hotelName commission currency roomCountDetails")
			.lean()
			.exec();
		if (!hotel) {
			throw new ReservationPricingError(
				"Hotel pricing details were not found.",
				404,
				"hotel_pricing_not_found",
				{ hotelId: nextHotelId }
			);
		}
		nextRooms = primaryRooms.map((room, index) => {
			const existingRoom = findExistingRoomFor(
				existingPrimaryRooms,
				room,
				index
			);
			return buildCanonicalRoomPricing({
				hotel,
				room,
				stayDates,
				preferChosenPrice:
					!roomIdentityChanged &&
					shouldPreferChosenNightlyPrice(room, existingRoom),
				preferCalendarPrice: roomIdentityChanged,
				agentId,
			});
		});
	} else if (canUseProvidedPricing) {
		nextRooms = primaryRooms.map((room, index) => {
			const existingRoom = findExistingRoomFor(
				existingPrimaryRooms,
				room,
				index
			);
			const roomForPricing = shouldPreferChosenNightlyPrice(room, existingRoom)
				? projectRoomPricingToNightlyPrice(room, stayDates)
				: room;
			return normalizeProvidedRoomPricing(roomForPricing);
		});
	} else {
		return updates;
	}

	const totals = summarizeRooms(nextRooms);
	updates.pickedRoomsType = nextRooms;
	if (
		hasOwn(updates, "pickedRoomsPricing") ||
		(Array.isArray(existing.pickedRoomsPricing) &&
			existing.pickedRoomsPricing.length > 0)
	) {
		updates.pickedRoomsPricing = nextRooms;
	}
	updates.total_rooms = nextRooms.reduce(
		(sum, room) => sum + normalizeRoomCount(room.count),
		0
	);
	updates.days_of_residence = stayDates.length;
	updates.total_amount = totals.total_amount;
	updates.sub_total = totals.sub_total;
	updates.adminPricing = totals.adminPricing;
	resetCommissionAssignmentForPricingChange(updates, existing);

	return updates;
};

module.exports = {
	ReservationPricingError,
	buildCanonicalRoomPricing,
	buildStayDateKeys,
	dateOnlyKey,
	normalizeReservationCreationPricing,
	normalizeReservationStayPricing,
	roomsHaveCompleteStayPricing,
	summarizeRooms,
};
