const mongoose = require("mongoose");
const moment = require("moment");
const HotelDetails = require("../models/hotel_details");
const Reservations = require("../models/reservations");
const Rooms = require("../models/rooms");
const User = require("../models/user");
const {
	shouldCountReservationForInventory,
} = require("../services/reservationStatus");
const {
	addHotelManagementReservationVisibilityToFilter,
	withHotelManagementSourceViewContext,
} = require("../services/reservationVisibility");
const {
	agentIdFromReservation,
	canUseAgentOverrides,
	getAgentAssignedStock,
	getAgentPricingForDate,
	hasAgentInventory,
	normalizeId,
} = require("../services/agentRoomOverrides");

const normalizeKey = (value) =>
	String(value || "")
		.replace(/[\u2013\u2014\u2212]/g, "-")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();

const normalizeLower = (value) => String(value || "").trim().toLowerCase();

const resolveReservationVisibilityActorForRequest = async (req = {}) => {
	const actorId = normalizeId(req.profile?._id || req.auth?._id || req.auth?.id);
	if (!actorId || !mongoose.Types.ObjectId.isValid(actorId)) return null;
	const actor = await User.findById(actorId)
		.select(
			"_id role roleDescription roles roleDescriptions accessTo hotelIdWork hotelIdsWork hotelIdsOwner hotelsToSupport belongsToId accountScope platformEmployee platformEmployeeType activeUser"
		)
		.lean()
		.exec();
	return withHotelManagementSourceViewContext(actor, req);
};

const dateOnlyKey = (value) => {
	if (!value) return "";
	if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) {
		return value.slice(0, 10);
	}
	const parsed = moment(value);
	return parsed.isValid() ? parsed.format("YYYY-MM-DD") : "";
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

const isSharedLabel = (label = "") => {
	const lowered = normalizeLower(label);
	return (
		lowered.includes("shared") ||
		lowered.includes("women only") ||
		lowered.includes("men only") ||
		lowered.includes("dorm")
	);
};

const isBedBasedRoom = ({ roomType, label, individualBeds } = {}) => {
	if (individualBeds) return true;
	const loweredType = normalizeLower(roomType);
	if (loweredType === "individualbed") return true;
	if (loweredType.includes("shared")) return true;
	return isSharedLabel(label);
};

const getDateRange = (startStr, endStr) => {
	const start = moment(startStr, "YYYY-MM-DD", true).startOf("day");
	const end = moment(endStr, "YYYY-MM-DD", true).startOf("day");
	if (!start.isValid() || !end.isValid()) {
		return null;
	}
	if (end.isBefore(start)) {
		return null;
	}
	const days = [];
	const cursor = start.clone();
	while (cursor.isSameOrBefore(end, "day")) {
		days.push(cursor.clone());
		cursor.add(1, "day");
	}
	return { start, end, days };
};

const isReservationActive = (
	reservation,
	includeCancelled,
	includePendingConfirmation = false,
	{ includeCompleted = false } = {}
) => {
	if (
		!shouldCountReservationForInventory(reservation, {
			includeCancelled,
			includePendingConfirmation,
			includeCompleted,
		})
	) {
		return false;
	}
	if (includeCancelled) return true;
	const status = String(reservation?.reservation_status || "").toLowerCase();
	if (!status) return true;
	if (status.includes("cancel")) return false;
	if (status.includes("no_show") || status.includes("no show")) return false;
	return true;
};

const MANUAL_CAPTURED_CONFIRMATIONS = new Set(["2944008828"]);

const safeNumber = (val, fallback = 0) => {
	const parsed = Number(val);
	return Number.isFinite(parsed) ? parsed : fallback;
};

const n2 = (value) => Number(safeNumber(value, 0).toFixed(2));

const positiveNumber = (value, fallback = 0) => {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const normalizeCommissionPercent = (value, fallback = 10) => {
	let parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 0) parsed = Number(fallback);
	if (!Number.isFinite(parsed) || parsed < 0) parsed = 10;
	if (parsed > 0 && parsed <= 1) parsed *= 100;
	return parsed;
};

const resolveDetailBasePrice = (detail = {}) => {
	const explicitBasePrice =
		detail?.price && typeof detail.price === "object"
			? detail.price.basePrice
			: detail?.price;
	return positiveNumber(
		explicitBasePrice,
		positiveNumber(detail?.basePrice, 0)
	);
};

const resolveDetailRootPrice = (detail = {}, basePrice = 0) =>
	positiveNumber(
		detail?.defaultCost,
		positiveNumber(
			detail?.rootPrice,
			positiveNumber(
				detail?.price && typeof detail.price === "object"
					? detail.price.defaultCost
					: undefined,
				basePrice
			)
		)
	);

const loadInventoryActor = async (actorId = "") => {
	const normalized = normalizeId(actorId);
	if (!mongoose.Types.ObjectId.isValid(normalized)) return null;
	return User.findById(normalized)
		.select(
			"_id role roles roleDescription roleDescriptions accessTo hotelIdWork hotelIdsWork hotelsToSupport hotelIdsOwner belongsToId activeUser"
		)
		.lean()
		.exec();
};

const normalizePaymentStatus = (value = "") => {
	const raw = String(value || "")
		.toLowerCase()
		.trim();
	if (!raw) return "";
	if (["captured", "paid online", "paid_online"].includes(raw))
		return "captured";
	if (["paid offline", "paid_offline", "onsite"].includes(raw))
		return "paid offline";
	if (["not paid", "not_paid", "unpaid"].includes(raw)) return "not paid";
	if (["not captured", "not_captured"].includes(raw)) return "not captured";
	return raw;
};

const parsePaymentStatusFilter = (rawStatuses) => {
	if (!rawStatuses) return new Set();
	const incoming = Array.isArray(rawStatuses)
		? rawStatuses
		: String(rawStatuses || "").split(",");
	const filtered = new Set();
	incoming.forEach((item) => {
		const norm = normalizePaymentStatus(item);
		if (norm) filtered.add(norm);
	});
	return filtered;
};

const paymentMeta = (reservation = {}) => {
	const pd = reservation?.paypal_details || {};
	const pmt = String(reservation?.payment || "")
		.toLowerCase()
		.trim();
	const isCardPayment = /\bcredit\b|\bdebit\b/.test(pmt);

	const legacyCaptured = !!reservation?.payment_details?.captured;

	const onsitePaidAmount = safeNumber(
		reservation?.payment_details?.onsite_paid_amount,
	);
	const payOffline = onsitePaidAmount > 0 || pmt === "paid offline";

	const breakdown = reservation?.paid_amount_breakdown || {};
	const breakdownCaptured = Object.keys(breakdown).some((key) => {
		if (key === "payment_comments") return false;
		return safeNumber(breakdown[key]) > 0;
	});

	const capTotal = safeNumber(pd?.captured_total_usd);
	const limitUsd =
		typeof pd?.bounds?.limit_usd === "number"
			? safeNumber(pd.bounds.limit_usd)
			: 0;
	const pendingUsd = safeNumber(pd?.pending_total_usd);

	const initialCompleted =
		String(pd?.initial?.capture_status || "").toUpperCase() === "COMPLETED";
	const anyMitCompleted =
		Array.isArray(pd?.mit) &&
		pd.mit.some(
			(c) => String(c?.capture_status || "").toUpperCase() === "COMPLETED",
		);

	const manualOverrideCaptured = MANUAL_CAPTURED_CONFIRMATIONS.has(
		String(reservation?.confirmation_number || "").trim(),
	);

	const isCaptured =
		manualOverrideCaptured ||
		legacyCaptured ||
		breakdownCaptured ||
		capTotal > 0 ||
		initialCompleted ||
		anyMitCompleted ||
		pmt === "paid online" ||
		isCardPayment;

	const isNotPaid = pmt === "not paid" && !isCaptured && !payOffline;

	let status = "Not Captured";
	if (isCaptured) status = "Captured";
	else if (payOffline) status = "Paid Offline";
	else if (isNotPaid) status = "Not Paid";

	let hint = "";
	const pieces = [];
	if (capTotal > 0) pieces.push(`captured $${capTotal.toFixed(2)}`);
	if (limitUsd > 0) pieces.push(`limit $${limitUsd.toFixed(2)}`);
	if (pendingUsd > 0) pieces.push(`pending $${pendingUsd.toFixed(2)}`);
	if (pieces.length) hint = `PayPal: ${pieces.join(" / ")}`;

	const totalAmount = safeNumber(reservation?.total_amount);
	const paidAmount =
		status === "Captured"
			? totalAmount
			: status === "Paid Offline"
			  ? onsitePaidAmount
			  : 0;

	return {
		status,
		normalizedStatus: normalizePaymentStatus(status),
		label: status,
		hint,
		paidAmount,
	};
};

const reservationCoversDay = (reservation, day) => {
	const checkin = moment(reservation?.checkin_date).startOf("day");
	const checkout = moment(reservation?.checkout_date).startOf("day");
	if (!checkin.isValid() || !checkout.isValid()) return false;
	return day.isSameOrAfter(checkin, "day") && day.isBefore(checkout, "day");
};

const buildRoomTypeMap = (roomCountDetails = []) => {
	const map = new Map();
	roomCountDetails.forEach((detail) => {
		if (!detail) return;
		const rawCount = Number(detail.count) || 0;
		if (rawCount <= 0) return;
		const displayName = detail.displayName || detail.display_name || "";
		const roomType = detail.roomType || detail.room_type || "";
		const label = displayName || roomType;
		const key = normalizeKey(label);
		if (!key) return;
		const bedsCount = Number(detail.bedsCount) || 1;
		const bedBased = isBedBasedRoom({ roomType, label });
		const multiplier = bedBased ? Math.max(1, Math.round(bedsCount)) : 1;
		const count = rawCount * multiplier;
		if (map.has(key)) {
			const existing = map.get(key);
			existing.count += count;
			existing.rawCount += rawCount;
			existing.isBedBased = existing.isBedBased || bedBased;
			if (!existing.bedsCount && bedsCount) {
				existing.bedsCount = bedsCount;
			}
			return;
		}
		map.set(key, {
			key,
			label: label || "Room",
			roomType,
			color: detail.roomColor || "#000",
			count,
			rawCount,
			bedsCount,
			isBedBased: bedBased,
			derived: false,
		});
	});
	return map;
};

const extractReservationRoomCounts = (reservation, roomsById) => {
	const counts = [];
	const bedNumbers = Array.isArray(reservation?.bedNumber)
		? reservation.bedNumber
		: [];
	let bedCountUsed = false;
	const takeBedCount = () => {
		if (bedCountUsed) return null;
		if (!bedNumbers.length) return null;
		bedCountUsed = true;
		return bedNumbers.length;
	};
	const addCount = (displayName, roomType, count) => {
		const key = normalizeKey(displayName || roomType);
		if (!key) return;
		const safeCount = Number(count) || 1;
		counts.push({
			key,
			label: displayName || roomType || "Room",
			roomType: roomType || "",
			count: safeCount,
		});
	};

	const picked = Array.isArray(reservation?.pickedRoomsType)
		? reservation.pickedRoomsType
		: [];
	if (picked.length > 0) {
		picked.forEach((item) => {
			if (!item) return;
			const displayName = item.displayName || item.display_name;
			const roomType = item.room_type || item.roomType;
			const bedBased = isBedBasedRoom({
				roomType,
				label: displayName,
			});
			let count = Number(item.count) || 1;
			if (bedBased) {
				const bedCount = takeBedCount();
				if (bedCount != null) count = bedCount;
			}
			addCount(displayName, roomType, count);
		});
		if (counts.length > 0) return counts;
	}

	const roomIds = Array.isArray(reservation?.roomId) ? reservation.roomId : [];
	if (roomIds.length > 0) {
		roomIds.forEach((room) => {
			const roomId = room?._id || room?.id || room;
			const roomInfo =
				typeof room === "object" ? room : roomsById.get(String(roomId));
			const displayName = roomInfo?.display_name;
			const roomType = roomInfo?.room_type;
			const bedBased = isBedBasedRoom({
				roomType,
				label: displayName,
				individualBeds: roomInfo?.individualBeds,
			});
			let count = 1;
			if (bedBased) {
				const bedCount = takeBedCount();
				if (bedCount != null) count = bedCount;
			}
			addCount(displayName, roomType, count);
		});
	}

	return counts;
};

const ensureRoomType = (roomTypeMap, key, label, roomType) => {
	if (!roomTypeMap.has(key)) {
		const bedBased = isBedBasedRoom({ roomType, label });
		roomTypeMap.set(key, {
			key,
			label: label || roomType || "Room",
			roomType: roomType || "",
			color: "#000",
			count: 0,
			rawCount: 0,
			bedsCount: 0,
			isBedBased: bedBased,
			derived: true,
		});
	}
};

const buildPricingByDayFromDetail = (
	detail,
	startStr,
	endStr,
	hotelCommission = 10,
	agentId = ""
) => {
	if (!detail) return [];
	const start = moment(startStr, "YYYY-MM-DD", true).startOf("day");
	const end = moment(endStr, "YYYY-MM-DD", true).startOf("day");
	if (!start.isValid() || !end.isValid()) return [];
	const pricingRate = Array.isArray(detail.pricingRate) ? detail.pricingRate : [];
	const basePrice = resolveDetailBasePrice(detail);
	const defaultRootPrice = resolveDetailRootPrice(detail, basePrice);
	const fallbackCommission = normalizeCommissionPercent(
		detail?.roomCommission,
		hotelCommission
	);
	const rows = [];
	for (let d = start.clone(); d.isSameOrBefore(end, "day"); d.add(1, "day")) {
		const dateString = d.format("YYYY-MM-DD");
		const match = pricingRate.find(
			(rate) => dateOnlyKey(rate?.calendarDate) === dateString
		);
		const agentMatch = getAgentPricingForDate(detail, agentId, dateString);
		const effectiveRate = agentMatch || match;
		const calendarBlocked = calendarRateIsBlocked(effectiveRate);
		const price = calendarBlocked
			? 0
			: positiveNumber(effectiveRate?.price, basePrice || defaultRootPrice);
		const rootPrice = calendarBlocked
			? 0
			: positiveNumber(
					effectiveRate?.rootPrice ?? effectiveRate?.defaultCost,
					defaultRootPrice || price
			  );
		const commissionRate = calendarBlocked
			? 0
			: normalizeCommissionPercent(effectiveRate?.commissionRate, fallbackCommission);
		const totalPriceWithCommission = calendarBlocked
			? 0
			: n2(price + rootPrice * (commissionRate / 100));
		rows.push({
			date: dateString,
			price,
			rootPrice,
			commissionRate,
			totalPriceWithCommission,
			totalPriceWithoutCommission: price,
			basePrice,
			defaultRootPrice,
			calendarBlocked,
			agentPricingApplied: Boolean(agentMatch),
		});
	}
	return rows;
};

const isAuthenticatedInventoryRequest = (req = {}) =>
	Boolean(req.auth?._id || req.auth?.id);

const sanitizePricingByDayForPublic = (pricingByDay = []) =>
	(Array.isArray(pricingByDay) ? pricingByDay : []).map((day) => ({
		date: day?.date,
		price: day?.price,
		calendarBlocked: Boolean(day?.calendarBlocked),
	}));

const sanitizeAvailabilityForPublic = (availability = []) =>
	(Array.isArray(availability) ? availability : []).map((row) => ({
		room_type: row?.room_type || "",
		displayName: row?.displayName || "",
		total_available: row?.total_available,
		available: row?.available,
		globalAvailable: row?.globalAvailable,
		start_date: row?.start_date,
		end_date: row?.end_date,
		pricingByDay: sanitizePricingByDayForPublic(row?.pricingByDay),
		blockedDates: Array.isArray(row?.blockedDates) ? row.blockedDates : [],
		calendarBlocked: Boolean(row?.calendarBlocked),
		roomColor: row?.roomColor || "#000",
	}));

const inventoryHttpError = (status, message) => {
	const error = new Error(message);
	error.status = status;
	return error;
};

const buildHotelInventoryCalendarPayload = async (
	hotelId,
	{
		start,
		end,
		includeCancelled,
		paymentStatuses,
		reservationVisibilityActor,
		includeCompletedStays = false,
		includeHistoricalReservations = false,
	} = {}
) => {
	if (!mongoose.Types.ObjectId.isValid(hotelId)) {
		throw inventoryHttpError(400, "Invalid hotelId");
	}

	const range = getDateRange(start, end);
	if (!range) {
		throw inventoryHttpError(
			400,
			"start/end must be valid YYYY-MM-DD dates"
		);
	}

	const hotel = await HotelDetails.findById(hotelId).select(
		"hotelName roomCountDetails"
	);
	if (!hotel) {
		throw inventoryHttpError(404, "Hotel not found");
	}

	const roomTypeMap = buildRoomTypeMap(hotel.roomCountDetails || []);
	const rooms = await Rooms.find({ hotelId })
		.select("_id display_name room_type individualBeds")
		.lean();
	const roomsById = new Map(rooms.map((room) => [String(room._id), room]));

	const startDate = range.start.toDate();
	const endDate = range.end.clone().add(1, "day").toDate();

	const reservationQuery = {
		hotelId,
		checkin_date: { $lt: endDate },
		checkout_date: { $gt: startDate },
	};
	if (!includeHistoricalReservations) {
		addHotelManagementReservationVisibilityToFilter(
			reservationQuery,
			reservationVisibilityActor
		);
	}

	const reservations = await Reservations.find(reservationQuery)
		.populate("roomId", "display_name room_type individualBeds")
		.lean();

	const paymentStatusFilter = parsePaymentStatusFilter(paymentStatuses);
	const includeCancelledFlag =
		includeCancelled === true || String(includeCancelled || "") === "true";
	const reservationPayloads = reservations
		.filter((reservation) =>
			isReservationActive(reservation, includeCancelledFlag, false, {
				includeCompleted: includeCompletedStays,
			})
		)
		.filter((reservation) => {
			if (paymentStatusFilter.size === 0) return true;
			const meta = paymentMeta(reservation);
			return paymentStatusFilter.has(meta.normalizedStatus);
		})
		.map((reservation) => ({
			reservation,
			counts: extractReservationRoomCounts(reservation, roomsById),
		}));

	const days = [];
	const warnings = [];
	const occupancyByType = {};

	roomTypeMap.forEach((rt) => {
		occupancyByType[rt.key] = {
			key: rt.key,
			label: rt.label,
			roomType: rt.roomType,
			color: rt.color || null,
			totalRooms: Number(rt.count) || 0,
			capacityNights: 0,
			bookedNights: 0,
			occupiedNights: 0,
			availableNights: 0,
			occupancyRate: 0,
			bookingRate: 0,
			derived: rt.derived,
		};
	});

	let capacityRoomNights = 0;
	let bookedRoomNights = 0;
	let occupiedRoomNights = 0;
	let remainingRoomNights = 0;
	let peakDay = {
		date: null,
		occupancyRate: 0,
		booked: 0,
		occupied: 0,
		capacity: 0,
	};

	range.days.forEach((dayMoment) => {
		const dayKey = dayMoment.format("YYYY-MM-DD");
		const dayRooms = {};

		roomTypeMap.forEach((rt) => {
			dayRooms[rt.key] = {
				capacity: rt.count,
				booked: 0,
				occupied: 0,
				available: Number(rt.count) || 0,
				occupancyRate: 0,
				bookingRate: 0,
				overbooked: false,
				overage: 0,
			};
		});

		reservationPayloads.forEach(({ reservation, counts }) => {
			if (!reservationCoversDay(reservation, dayMoment)) return;
			counts.forEach((line) => {
				if (!line || !line.key) return;
				ensureRoomType(roomTypeMap, line.key, line.label, line.roomType);
				if (!dayRooms[line.key]) {
					dayRooms[line.key] = {
						capacity: 0,
						booked: 0,
						occupied: 0,
						available: 0,
						occupancyRate: 0,
						bookingRate: 0,
						overbooked: false,
						overage: 0,
					};
				}
				dayRooms[line.key].booked += Number(line.count) || 0;
			});
		});

		let dayCapacity = 0;
		let dayBooked = 0;
		let dayOccupied = 0;
		let dayAvailable = 0;

		Object.keys(dayRooms).forEach((key) => {
			const cell = dayRooms[key];
			const roomTypeMeta = roomTypeMap.get(key) || {};
			const rawCapacity =
				Number(cell.capacity) || Number(roomTypeMeta.count) || 0;
			const booked = Number(cell.booked ?? cell.occupied) || 0;
			const capacity = rawCapacity === 0 && booked > 0 ? booked : rawCapacity;
			const occupied = Math.min(booked, capacity);
			const available = Math.max(capacity - occupied, 0);

			cell.capacity = capacity;
			cell.booked = booked;
			cell.occupied = occupied;
			cell.available = available;
			cell.occupancyRate = capacity > 0 ? occupied / capacity : 0;
			cell.bookingRate = capacity > 0 ? booked / capacity : 0;
			cell.overbooked =
				!roomTypeMeta.derived && rawCapacity > 0 && booked > rawCapacity;
			cell.overage = cell.overbooked ? Math.max(booked - rawCapacity, 0) : 0;

			dayCapacity += capacity;
			dayBooked += booked;
			dayOccupied += occupied;
			dayAvailable += available;

			if (!occupancyByType[key]) {
				occupancyByType[key] = {
					key,
					label: roomTypeMeta.label || key,
					roomType: roomTypeMeta.roomType || "",
					color: roomTypeMeta.color || null,
					totalRooms: Number(roomTypeMeta.count) || 0,
					capacityNights: 0,
					bookedNights: 0,
					occupiedNights: 0,
					availableNights: 0,
					occupancyRate: 0,
					bookingRate: 0,
					derived: true,
				};
			}
			occupancyByType[key].capacityNights += capacity;
			occupancyByType[key].bookedNights += booked;
			occupancyByType[key].occupiedNights += occupied;

			if (cell.overbooked) {
				warnings.push({
					date: dayKey,
					roomType: roomTypeMeta.label || key,
					roomKey: key,
					booked,
					occupied,
					capacity,
					overage: cell.overage,
				});
			}
		});

		capacityRoomNights += dayCapacity;
		bookedRoomNights += dayBooked;
		occupiedRoomNights += dayOccupied;
		remainingRoomNights += dayAvailable;

		const dayOccupancyRate =
			dayCapacity > 0 ? dayOccupied / dayCapacity : 0;
		const dayBookingRate = dayCapacity > 0 ? dayBooked / dayCapacity : 0;
		const dayOverbooked = dayCapacity > 0 && dayBooked > dayCapacity;
		const dayOverage = dayOverbooked ? Math.max(dayBooked - dayCapacity, 0) : 0;

		if (dayOccupancyRate > peakDay.occupancyRate) {
			peakDay = {
				date: dayKey,
				occupancyRate: dayOccupancyRate,
				booked: dayBooked,
				occupied: dayOccupied,
				capacity: dayCapacity,
			};
		}

		days.push({
			date: dayKey,
			totals: {
				capacity: dayCapacity,
				booked: dayBooked,
				occupied: dayOccupied,
				available: dayAvailable,
				occupancyRate: dayOccupancyRate,
				bookingRate: dayBookingRate,
				overbooked: dayOverbooked,
				overage: dayOverage,
			},
			rooms: dayRooms,
		});
	});

	Object.values(occupancyByType).forEach((entry) => {
		entry.occupancyRate =
			entry.capacityNights > 0
				? entry.occupiedNights / entry.capacityNights
				: 0;
		entry.bookingRate =
			entry.capacityNights > 0
				? entry.bookedNights / entry.capacityNights
				: 0;
		entry.availableNights = Math.max(
			entry.capacityNights - entry.occupiedNights,
			0
		);
	});

	const baseRoomTypes = Array.from(roomTypeMap.values()).filter(
		(rt) => !rt.derived
	);
	const totalUnits = baseRoomTypes.reduce(
		(sum, rt) => sum + (Number(rt.count) || 0),
		0
	);
	const totalRooms = baseRoomTypes.reduce(
		(sum, rt) => sum + (Number(rt.rawCount) || 0),
		0
	);

	const summary = {
		totalRoomsAll: totalUnits,
		totalPhysicalRooms: totalRooms,
		totalUnits,
		totalRooms,
		soldRoomNights: occupiedRoomNights,
		availableRoomNights: capacityRoomNights,
		capacityRoomNights,
		bookedRoomNights,
		occupiedRoomNights,
		remainingRoomNights:
			remainingRoomNights || Math.max(capacityRoomNights - occupiedRoomNights, 0),
		averageOccupancyRate:
			capacityRoomNights > 0 ? occupiedRoomNights / capacityRoomNights : 0,
		averageBookingRate:
			capacityRoomNights > 0 ? bookedRoomNights / capacityRoomNights : 0,
		peakDay,
		occupancyByType: Object.values(occupancyByType),
		warnings,
	};

	return {
		hotel: { _id: hotel._id, hotelName: hotel.hotelName },
		range: {
			start: range.start.format("YYYY-MM-DD"),
			end: range.end.format("YYYY-MM-DD"),
		},
		roomTypes: Array.from(roomTypeMap.values()),
		days,
		summary,
	};
};

const buildHotelInventoryDayPayload = async (
	hotelId,
	{
		date,
		roomKey,
		includeCancelled,
		paymentStatuses,
		reservationVisibilityActor,
		includeCompletedStays = false,
		includeHistoricalReservations = false,
	} = {}
) => {
	if (!mongoose.Types.ObjectId.isValid(hotelId)) {
		throw inventoryHttpError(400, "Invalid hotelId");
	}
	if (!date) {
		throw inventoryHttpError(400, "date is required (YYYY-MM-DD)");
	}

	const day = moment(date, "YYYY-MM-DD", true).startOf("day");
	if (!day.isValid()) {
		throw inventoryHttpError(400, "Invalid date format");
	}

	const hotel = await HotelDetails.findById(hotelId).select(
		"hotelName roomCountDetails"
	);
	if (!hotel) {
		throw inventoryHttpError(404, "Hotel not found");
	}

	const roomTypeMap = buildRoomTypeMap(hotel.roomCountDetails || []);

	const rooms = await Rooms.find({ hotelId })
		.select("_id display_name room_type individualBeds")
		.lean();
	const roomsById = new Map(rooms.map((room) => [String(room._id), room]));

	const dayStart = day.toDate();
	const dayEnd = day.clone().add(1, "day").toDate();

	const reservationQuery = {
		hotelId,
		checkin_date: { $lt: dayEnd },
		checkout_date: { $gt: dayStart },
	};
	if (!includeHistoricalReservations) {
		addHotelManagementReservationVisibilityToFilter(
			reservationQuery,
			reservationVisibilityActor
		);
	}

	const reservations = await Reservations.find(reservationQuery)
		.populate("roomId", "display_name room_type individualBeds")
		.lean();

	const paymentStatusFilter = parsePaymentStatusFilter(paymentStatuses);
	const includeCancelledFlag =
		includeCancelled === true || String(includeCancelled || "") === "true";
	const filteredReservations = [];
	let booked = 0;

	reservations.forEach((reservation) => {
		if (
			!isReservationActive(reservation, includeCancelledFlag, false, {
				includeCompleted: includeCompletedStays,
			})
		) return;
		if (!reservationCoversDay(reservation, day)) return;
		const meta = paymentMeta(reservation);
		if (
			paymentStatusFilter.size > 0 &&
			!paymentStatusFilter.has(meta.normalizedStatus)
		) {
			return;
		}

		const counts = extractReservationRoomCounts(reservation, roomsById);
		if (roomKey) {
			const matches = counts.some((line) => line.key === roomKey);
			if (!matches) return;
		}
		const roomCount = counts.reduce((sum, line) => {
			if (roomKey && line.key !== roomKey) return sum;
			return sum + (Number(line.count) || 0);
		}, 0);
		booked += roomCount;
		filteredReservations.push({
			...reservation,
			payment_status: meta.label,
			payment_status_hint: meta.hint,
		});
	});

	const roomLabel = roomKey ? roomTypeMap.get(roomKey)?.label || roomKey : null;
	let capacity = roomKey
		? Number(roomTypeMap.get(roomKey)?.count) || 0
		: Array.from(roomTypeMap.values()).reduce(
				(sum, rt) => sum + (Number(rt.count) || 0),
				0
		  );
	if (capacity === 0 && booked > 0) {
		capacity = booked;
	}
	const occupied = Math.min(booked, capacity);
	const available = Math.max(capacity - occupied, 0);
	const overbooked = capacity > 0 && booked > capacity;

	return {
		hotel: { _id: hotel._id, hotelName: hotel.hotelName },
		date: day.format("YYYY-MM-DD"),
		roomKey: roomKey || null,
		roomLabel: roomLabel || null,
		capacity,
		booked,
		occupied,
		available,
		occupancyRate: capacity > 0 ? occupied / capacity : 0,
		bookingRate: capacity > 0 ? booked / capacity : 0,
		overbooked,
		overage: overbooked ? booked - capacity : 0,
		reservations: filteredReservations,
	};
};

exports.buildHotelInventoryCalendarPayload = buildHotelInventoryCalendarPayload;
exports.buildHotelInventoryDayPayload = buildHotelInventoryDayPayload;

exports.getHotelInventoryCalendar = async (req, res) => {
	const { hotelId } = req.params;
	const { start, end, includeCancelled, paymentStatuses } = req.query;

	if (!mongoose.Types.ObjectId.isValid(hotelId)) {
		return res.status(400).json({ error: "Invalid hotelId" });
	}

	const range = getDateRange(start, end);
	if (!range) {
		return res
			.status(400)
			.json({ error: "start/end must be valid YYYY-MM-DD dates" });
	}

	try {
		const calendarVisibilityActor =
			await resolveReservationVisibilityActorForRequest(req);
		const payload = await buildHotelInventoryCalendarPayload(hotelId, {
			start,
			end,
			includeCancelled: includeCancelled === "true",
			paymentStatuses,
			reservationVisibilityActor: calendarVisibilityActor,
		});
		return res.json(payload);

		const hotel = await HotelDetails.findById(hotelId).select(
			"hotelName belongsTo roomCountDetails commission"
		);
		if (!hotel) {
			return res.status(404).json({ error: "Hotel not found" });
		}

		const roomTypeMap = buildRoomTypeMap(hotel.roomCountDetails || []);
		const baseKeys = new Set(
			Array.from(roomTypeMap.values())
				.filter((rt) => !rt.derived)
				.map((rt) => rt.key)
		);

		const rooms = await Rooms.find({ hotelId })
			.select("_id display_name room_type individualBeds")
			.lean();
		const roomsById = new Map(
			rooms.map((room) => [String(room._id), room])
		);

		const startDate = range.start.toDate();
		const endDate = range.end.clone().add(1, "day").toDate();
		const visibilityActor =
			await resolveReservationVisibilityActorForRequest(req);

		const reservationQuery = {
			hotelId,
			checkin_date: { $lt: endDate },
			checkout_date: { $gt: startDate },
		};
		addHotelManagementReservationVisibilityToFilter(
			reservationQuery,
			visibilityActor
		);

		const reservations = await Reservations.find(reservationQuery)
			.populate("roomId", "display_name room_type individualBeds")
			.lean();

		const paymentStatusFilter = parsePaymentStatusFilter(paymentStatuses);
		const reservationPayloads = reservations
			.filter((reservation) =>
				isReservationActive(reservation, includeCancelled === "true")
			)
			.filter((reservation) => {
				if (paymentStatusFilter.size === 0) return true;
				const meta = paymentMeta(reservation);
				return paymentStatusFilter.has(meta.normalizedStatus);
			})
			.map((reservation) => ({
				reservation,
				counts: extractReservationRoomCounts(reservation, roomsById),
			}));

		const days = [];
		const warnings = [];
		const occupancyByType = {};

		roomTypeMap.forEach((rt) => {
			occupancyByType[rt.key] = {
				key: rt.key,
				label: rt.label,
				roomType: rt.roomType,
				capacityNights: 0,
				occupiedNights: 0,
				occupancyRate: 0,
				derived: rt.derived,
			};
		});

		let capacityRoomNights = 0;
		let occupiedRoomNights = 0;

		range.days.forEach((dayMoment) => {
			const dayKey = dayMoment.format("YYYY-MM-DD");
			const dayRooms = {};

			roomTypeMap.forEach((rt) => {
				dayRooms[rt.key] = {
					capacity: rt.count,
					occupied: 0,
					occupancyRate: 0,
					overbooked: false,
					overage: 0,
				};
			});

			reservationPayloads.forEach(({ reservation, counts }) => {
				if (!reservationCoversDay(reservation, dayMoment)) return;
				counts.forEach((line) => {
					if (!line || !line.key) return;
					ensureRoomType(roomTypeMap, line.key, line.label, line.roomType);
					if (!dayRooms[line.key]) {
						dayRooms[line.key] = {
							capacity: 0,
							occupied: 0,
							occupancyRate: 0,
							overbooked: false,
							overage: 0,
						};
					}
					dayRooms[line.key].occupied += Number(line.count) || 0;
				});
			});

			let dayCapacity = 0;
			let dayOccupied = 0;

			Object.keys(dayRooms).forEach((key) => {
				const cell = dayRooms[key];
				const capacity = Number(cell.capacity) || 0;
				const occupied = Number(cell.occupied) || 0;
				const derivedCapacity =
					capacity === 0 && occupied > 0 ? occupied : capacity;
				cell.capacity = derivedCapacity;
				cell.occupancyRate = derivedCapacity > 0 ? occupied / derivedCapacity : 0;
				cell.overbooked =
					capacity > 0 && occupied > capacity && derivedCapacity === capacity;
				cell.overage = cell.overbooked ? occupied - capacity : 0;
				dayOccupied += occupied;
				if (baseKeys.has(key)) {
					dayCapacity += derivedCapacity;
				}

				if (!occupancyByType[key]) {
					occupancyByType[key] = {
						key,
						label: key,
						roomType: "",
						capacityNights: 0,
						occupiedNights: 0,
						occupancyRate: 0,
						derived: true,
					};
				}
				occupancyByType[key].capacityNights += derivedCapacity;
				occupancyByType[key].occupiedNights += occupied;
			});

			if (dayCapacity > 0 && dayOccupied > dayCapacity) {
				warnings.push({
					date: dayKey,
					occupied: dayOccupied,
					capacity: dayCapacity,
					overage: dayOccupied - dayCapacity,
				});
			}

			capacityRoomNights += dayCapacity;
			occupiedRoomNights += dayOccupied;

			days.push({
				date: dayKey,
				totals: {
					capacity: dayCapacity,
					occupied: dayOccupied,
					occupancyRate: dayCapacity > 0 ? dayOccupied / dayCapacity : 0,
				},
				rooms: dayRooms,
			});
		});

		Object.values(occupancyByType).forEach((entry) => {
			entry.occupancyRate =
				entry.capacityNights > 0
					? entry.occupiedNights / entry.capacityNights
					: 0;
		});

		const baseRoomTypes = Array.from(roomTypeMap.values()).filter(
			(rt) => !rt.derived
		);
		const totalUnits = baseRoomTypes.reduce(
			(sum, rt) => sum + (Number(rt.count) || 0),
			0
		);
		const totalRooms = baseRoomTypes.reduce(
			(sum, rt) => sum + (Number(rt.rawCount) || 0),
			0
		);

		const summary = {
			totalRoomsAll: totalUnits,
			totalPhysicalRooms: totalRooms,
			totalUnits,
			totalRooms,
			capacityRoomNights,
			occupiedRoomNights,
			remainingRoomNights: Math.max(capacityRoomNights - occupiedRoomNights, 0),
			averageOccupancyRate:
				capacityRoomNights > 0 ? occupiedRoomNights / capacityRoomNights : 0,
			occupancyByType: Object.values(occupancyByType),
			warnings,
		};

		res.json({
			hotel: { _id: hotel._id, hotelName: hotel.hotelName },
			range: { start: range.start.format("YYYY-MM-DD"), end: range.end.format("YYYY-MM-DD") },
			roomTypes: Array.from(roomTypeMap.values()),
			days,
			summary,
		});
	} catch (err) {
		console.error("Error in getHotelInventoryCalendar:", err);
		res.status(err?.status || 500).json({
			error: err?.message || "Failed to load hotel inventory calendar",
		});
	}
};

exports.getHotelInventoryDay = async (req, res) => {
	const { hotelId } = req.params;
	const { date, roomKey, includeCancelled, paymentStatuses } = req.query;

	if (!mongoose.Types.ObjectId.isValid(hotelId)) {
		return res.status(400).json({ error: "Invalid hotelId" });
	}
	if (!date) {
		return res.status(400).json({ error: "date is required (YYYY-MM-DD)" });
	}

	const day = moment(date, "YYYY-MM-DD", true).startOf("day");
	if (!day.isValid()) {
		return res.status(400).json({ error: "Invalid date format" });
	}

	try {
		const dayVisibilityActor =
			await resolveReservationVisibilityActorForRequest(req);
		const payload = await buildHotelInventoryDayPayload(hotelId, {
			date,
			roomKey,
			includeCancelled: includeCancelled === "true",
			paymentStatuses,
			reservationVisibilityActor: dayVisibilityActor,
		});
		return res.json(payload);

		const hotel = await HotelDetails.findById(hotelId).select(
			"hotelName roomCountDetails commission"
		);
		if (!hotel) {
			return res.status(404).json({ error: "Hotel not found" });
		}

		const roomTypeMap = buildRoomTypeMap(hotel.roomCountDetails || []);

		const rooms = await Rooms.find({ hotelId })
			.select("_id display_name room_type individualBeds")
			.lean();
		const roomsById = new Map(
			rooms.map((room) => [String(room._id), room])
		);

		const dayStart = day.toDate();
		const dayEnd = day.clone().add(1, "day").toDate();
		const visibilityActor =
			await resolveReservationVisibilityActorForRequest(req);

		const reservationQuery = {
			hotelId,
			checkin_date: { $lt: dayEnd },
			checkout_date: { $gt: dayStart },
		};
		addHotelManagementReservationVisibilityToFilter(
			reservationQuery,
			visibilityActor
		);

		const reservations = await Reservations.find(reservationQuery)
			.populate("roomId", "display_name room_type individualBeds")
			.lean();

		const paymentStatusFilter = parsePaymentStatusFilter(paymentStatuses);
		const filteredReservations = [];
		let occupied = 0;

		reservations.forEach((reservation) => {
			if (!isReservationActive(reservation, includeCancelled === "true"))
				return;
			if (!reservationCoversDay(reservation, day)) return;
			const meta = paymentMeta(reservation);
			if (
				paymentStatusFilter.size > 0 &&
				!paymentStatusFilter.has(meta.normalizedStatus)
			) {
				return;
			}

			const counts = extractReservationRoomCounts(reservation, roomsById);
			if (roomKey) {
				const matches = counts.some((line) => line.key === roomKey);
				if (!matches) return;
			}
			const roomCount = counts.reduce((sum, line) => {
				if (roomKey && line.key !== roomKey) return sum;
				return sum + (Number(line.count) || 0);
			}, 0);
			occupied += roomCount;
			filteredReservations.push({
				...reservation,
				payment_status: meta.label,
				payment_status_hint: meta.hint,
			});
		});

		const roomLabel = roomKey
			? roomTypeMap.get(roomKey)?.label || roomKey
			: null;
		let capacity = roomKey
			? Number(roomTypeMap.get(roomKey)?.count) || 0
			: Array.from(roomTypeMap.values()).reduce(
					(sum, rt) => sum + (Number(rt.count) || 0),
					0
			  );
		if (capacity === 0 && occupied > 0) {
			capacity = occupied;
		}

		res.json({
			hotel: { _id: hotel._id, hotelName: hotel.hotelName },
			date: day.format("YYYY-MM-DD"),
			roomKey: roomKey || null,
			roomLabel: roomLabel || null,
			capacity,
			occupied,
			overbooked: capacity > 0 && occupied > capacity,
			overage: capacity > 0 && occupied > capacity ? occupied - capacity : 0,
			reservations: filteredReservations,
		});
	} catch (err) {
		console.error("Error in getHotelInventoryDay:", err);
		res.status(err?.status || 500).json({
			error: err?.message || "Failed to load day reservations",
		});
	}
};

exports.getHotelInventoryAvailability = async (req, res) => {
	const { hotelId } = req.params;
	const { start, end, includeCancelled } = req.query;
	const requestedAgentId = normalizeId(req.query.agentId);
	const includePendingConfirmation =
		String(req.query.includePendingConfirmation || "").toLowerCase() === "true";
	const isAuthenticated = isAuthenticatedInventoryRequest(req);

	if (!mongoose.Types.ObjectId.isValid(hotelId)) {
		return res.status(400).json({ error: "Invalid hotelId" });
	}

	const range = getDateRange(start, end);
	if (!range) {
		return res
			.status(400)
			.json({ error: "start/end must be valid YYYY-MM-DD dates" });
	}

	try {
		const hotel = await HotelDetails.findById(hotelId).select(
			"hotelName roomCountDetails commission"
		);
		if (!hotel) {
			return res.status(404).json({ error: "Hotel not found" });
		}
		let agentOverrideId = "";
		if (requestedAgentId) {
			if (!isAuthenticated) {
				return res.status(401).json({
					error: "Authentication required for agent inventory",
				});
			}
			const actor = await loadInventoryActor(req.auth?._id);
			if (!canUseAgentOverrides(actor, hotel, requestedAgentId)) {
				return res.status(403).json({ error: "Not authorized for agent inventory" });
			}
			agentOverrideId = requestedAgentId;
		}

		const roomCountDetails = Array.isArray(hotel.roomCountDetails)
			? hotel.roomCountDetails
			: [];
		if (roomCountDetails.length === 0) {
			return res.json([]);
		}

		const roomTypeMap = buildRoomTypeMap(roomCountDetails);
		const roomKeyByType = new Map();
		const detailByKey = new Map();
		roomCountDetails.forEach((detail) => {
			const roomType = detail?.roomType || detail?.room_type || "";
			const displayName = detail?.displayName || detail?.display_name || "";
			const label = displayName || roomType;
			const key = normalizeKey(label);
			if (key) {
				detailByKey.set(key, detail);
			}
			const typeKey = normalizeKey(roomType);
			if (typeKey && !roomKeyByType.has(typeKey)) {
				roomKeyByType.set(typeKey, key);
			}
		});
		const agentAssignedStockByKey = new Map();
		if (agentOverrideId) {
			detailByKey.forEach((detail, key) => {
				if (!hasAgentInventory(detail, agentOverrideId)) return;
				agentAssignedStockByKey.set(
					key,
					Math.max(0, Number(getAgentAssignedStock(detail, agentOverrideId) || 0))
				);
			});
		}

		const rooms = await Rooms.find({ hotelId })
			.select("_id display_name room_type individualBeds")
			.lean();
		const roomsById = new Map(
			rooms.map((room) => [String(room._id), room])
		);

		const startDate = range.start.toDate();
		const endDate = range.end.clone().add(1, "day").toDate();

		const reservations = await Reservations.find({
			hotelId,
			checkin_date: { $lt: endDate },
			checkout_date: { $gt: startDate },
		})
			.populate("roomId", "display_name room_type individualBeds")
			.select("checkin_date checkout_date reservation_status state pendingConfirmation agentDecisionSnapshot pickedRoomsType pickedRoomsPricing roomId bedNumber orderTakeId createdByUserId requestingUserId orderTaker createdBy")
			.lean();

		const reservationPayloads = reservations
			.filter((reservation) =>
				isReservationActive(
					reservation,
					isAuthenticated && includeCancelled === "true",
					Boolean(agentOverrideId) ||
						(isAuthenticated && includePendingConfirmation)
				)
			)
			.map((reservation) => ({
				reservation,
				counts: extractReservationRoomCounts(reservation, roomsById),
			}));

		const statsByKey = new Map();
		const agentStatsByKey = new Map();
		roomTypeMap.forEach((rt) => {
			statsByKey.set(rt.key, {
				minAvailable: Number(rt.count) || 0,
				maxReserved: 0,
				maxOccupied: 0,
			});
			if (agentAssignedStockByKey.has(rt.key)) {
				agentStatsByKey.set(rt.key, {
					minAvailable: agentAssignedStockByKey.get(rt.key) || 0,
					maxReserved: 0,
					maxOccupied: 0,
				});
			}
		});

		range.days.forEach((dayMoment) => {
			const reservedCounts = {};
			const occupiedCounts = {};
			const agentReservedCounts = {};
			const agentOccupiedCounts = {};

			reservationPayloads.forEach(({ reservation, counts }) => {
				if (!reservationCoversDay(reservation, dayMoment)) return;
				const hasRoomId =
					Array.isArray(reservation.roomId) && reservation.roomId.length > 0;
				counts.forEach((line) => {
					if (!line || !line.key) return;
					let key = line.key;
					if (!roomTypeMap.has(key) && line.roomType) {
						const fallbackKey = roomKeyByType.get(normalizeKey(line.roomType));
						if (fallbackKey) key = fallbackKey;
					}
					ensureRoomType(roomTypeMap, key, line.label, line.roomType);
					if (!statsByKey.has(key)) {
						statsByKey.set(key, {
							minAvailable: 0,
							maxReserved: 0,
							maxOccupied: 0,
						});
					}
					const bucket = hasRoomId ? occupiedCounts : reservedCounts;
					bucket[key] = (bucket[key] || 0) + (Number(line.count) || 0);
					if (
						agentOverrideId &&
						agentAssignedStockByKey.has(key) &&
						agentIdFromReservation(reservation) === agentOverrideId
					) {
						const agentBucket = hasRoomId
							? agentOccupiedCounts
							: agentReservedCounts;
						agentBucket[key] =
							(agentBucket[key] || 0) + (Number(line.count) || 0);
					}
				});
			});

			roomTypeMap.forEach((rt) => {
				const reserved = Number(reservedCounts[rt.key]) || 0;
				const occupied = Number(occupiedCounts[rt.key]) || 0;
				const used = reserved + occupied;
				const capacity = Number(rt.count) || 0;
				const effectiveCapacity = capacity === 0 && used > 0 ? used : capacity;
				const available = effectiveCapacity - used;
				const stats = statsByKey.get(rt.key) || {
					minAvailable: effectiveCapacity,
					maxReserved: 0,
					maxOccupied: 0,
				};
				stats.minAvailable = Math.min(stats.minAvailable, available);
				stats.maxReserved = Math.max(stats.maxReserved, reserved);
				stats.maxOccupied = Math.max(stats.maxOccupied, occupied);
				statsByKey.set(rt.key, stats);

				if (agentAssignedStockByKey.has(rt.key)) {
					const agentReserved = Number(agentReservedCounts[rt.key]) || 0;
					const agentOccupied = Number(agentOccupiedCounts[rt.key]) || 0;
					const agentUsed = agentReserved + agentOccupied;
					const agentCapacity = agentAssignedStockByKey.get(rt.key) || 0;
					const agentAvailable = agentCapacity - agentUsed;
					const agentStats = agentStatsByKey.get(rt.key) || {
						minAvailable: agentCapacity,
						maxReserved: 0,
						maxOccupied: 0,
					};
					agentStats.minAvailable = Math.min(
						agentStats.minAvailable,
						agentAvailable
					);
					agentStats.maxReserved = Math.max(
						agentStats.maxReserved,
						agentReserved
					);
					agentStats.maxOccupied = Math.max(
						agentStats.maxOccupied,
						agentOccupied
					);
					agentStatsByKey.set(rt.key, agentStats);
				}
			});
		});

		const startStr = range.start.format("YYYY-MM-DD");
		const endStr = range.end.format("YYYY-MM-DD");
		const availability = Array.from(roomTypeMap.values()).map((rt) => {
			const stats = statsByKey.get(rt.key) || {
				minAvailable: Number(rt.count) || 0,
				maxReserved: 0,
				maxOccupied: 0,
			};
			const usedMax = (Number(stats.maxReserved) || 0) + (Number(stats.maxOccupied) || 0);
			const capacity = Number(rt.count) || 0;
			const effectiveCapacity = capacity === 0 && usedMax > 0 ? usedMax : capacity;
			const detail = detailByKey.get(rt.key);
			const agentStats = agentStatsByKey.get(rt.key);
			const agentAssignedStock = agentAssignedStockByKey.has(rt.key)
				? agentAssignedStockByKey.get(rt.key)
				: null;
			const displayName = detail?.displayName || detail?.display_name || rt.label;
			const roomType = detail?.roomType || detail?.room_type || rt.roomType || "";
			const pricingByDay = buildPricingByDayFromDetail(
				detail,
				startStr,
				endStr,
				hotel?.commission,
				agentOverrideId
			);
			const blockedDates = pricingByDay
				.filter((day) => day.calendarBlocked)
				.map((day) => day.date);
			return {
				room_type: roomType || displayName,
				displayName: displayName || roomType || "",
				total_available: effectiveCapacity,
				reserved: Number(stats.maxReserved) || 0,
				occupied: Number(stats.maxOccupied) || 0,
				available: Math.max(
					Number(agentStats?.minAvailable ?? stats.minAvailable) || 0,
					0
				),
				globalAvailable: Math.max(Number(stats.minAvailable) || 0, 0),
				agentAssignedStock,
				agentReserved: Number(agentStats?.maxReserved || 0),
				agentOccupied: Number(agentStats?.maxOccupied || 0),
				agentInventoryApplied: agentAssignedStock !== null,
				start_date: startStr,
				end_date: endStr,
				pricingByDay,
				blockedDates,
				calendarBlocked: blockedDates.length > 0,
				roomColor: rt.color || "#000",
			};
		});

		res.json(
			isAuthenticated
				? availability
				: sanitizeAvailabilityForPublic(availability)
		);
	} catch (err) {
		console.error("Error in getHotelInventoryAvailability:", err);
		res.status(500).json({ error: "Failed to load availability" });
	}
};
