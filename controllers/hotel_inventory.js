const mongoose = require("mongoose");
const moment = require("moment");
const HotelDetails = require("../models/hotel_details");
const Reservations = require("../models/reservations");
const Rooms = require("../models/rooms");

const normalizeKey = (value) =>
	String(value || "")
		.replace(/[\u2013\u2014\u2212]/g, "-")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();

const normalizeLower = (value) => String(value || "").trim().toLowerCase();

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

const isReservationActive = (reservation, includeCancelled) => {
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

const buildPricingByDayFromDetail = (detail, startStr, endStr) => {
	if (!detail) return [];
	const start = moment(startStr, "YYYY-MM-DD", true).startOf("day");
	const end = moment(endStr, "YYYY-MM-DD", true).startOf("day");
	if (!start.isValid() || !end.isValid()) return [];
	const pricingRate = Array.isArray(detail.pricingRate) ? detail.pricingRate : [];
	const basePrice = Number(detail?.price?.basePrice) || 0;
	const rows = [];
	for (let d = start.clone(); d.isSameOrBefore(end, "day"); d.add(1, "day")) {
		const dateString = d.format("YYYY-MM-DD");
		const match = pricingRate.find((rate) => rate.calendarDate === dateString);
		const price = Number(match?.price) || basePrice;
		rows.push({ date: dateString, price });
	}
	return rows;
};

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
		const hotel = await HotelDetails.findById(hotelId).select(
			"hotelName roomCountDetails"
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

		const reservations = await Reservations.find({
			hotelId,
			checkin_date: { $lt: endDate },
			checkout_date: { $gt: startDate },
		})
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
		res.status(500).json({ error: "Failed to load hotel inventory calendar" });
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
		const hotel = await HotelDetails.findById(hotelId).select(
			"hotelName roomCountDetails"
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

		const reservations = await Reservations.find({
			hotelId,
			checkin_date: { $lt: dayEnd },
			checkout_date: { $gt: dayStart },
		})
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
		res.status(500).json({ error: "Failed to load day reservations" });
	}
};

exports.getHotelInventoryAvailability = async (req, res) => {
	const { hotelId } = req.params;
	const { start, end, includeCancelled } = req.query;

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
			"hotelName roomCountDetails"
		);
		if (!hotel) {
			return res.status(404).json({ error: "Hotel not found" });
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
			.lean();

		const reservationPayloads = reservations
			.filter((reservation) =>
				isReservationActive(reservation, includeCancelled === "true")
			)
			.map((reservation) => ({
				reservation,
				counts: extractReservationRoomCounts(reservation, roomsById),
			}));

		const statsByKey = new Map();
		roomTypeMap.forEach((rt) => {
			statsByKey.set(rt.key, {
				minAvailable: Number(rt.count) || 0,
				maxReserved: 0,
				maxOccupied: 0,
			});
		});

		range.days.forEach((dayMoment) => {
			const reservedCounts = {};
			const occupiedCounts = {};

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
			const displayName = detail?.displayName || detail?.display_name || rt.label;
			const roomType = detail?.roomType || detail?.room_type || rt.roomType || "";
			return {
				room_type: roomType || displayName,
				displayName: displayName || roomType || "",
				total_available: effectiveCapacity,
				reserved: Number(stats.maxReserved) || 0,
				occupied: Number(stats.maxOccupied) || 0,
				available: Math.max(Number(stats.minAvailable) || 0, 0),
				start_date: startStr,
				end_date: endStr,
				pricingByDay: buildPricingByDayFromDetail(detail, startStr, endStr),
				roomColor: rt.color || "#000",
			};
		});

		res.json(availability);
	} catch (err) {
		console.error("Error in getHotelInventoryAvailability:", err);
		res.status(500).json({ error: "Failed to load availability" });
	}
};
