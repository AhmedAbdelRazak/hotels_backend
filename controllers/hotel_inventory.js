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

exports.getHotelInventoryCalendar = async (req, res) => {
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

		const reservationPayloads = reservations
			.filter((reservation) =>
				isReservationActive(reservation, includeCancelled === "true")
			)
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
	const { date, roomKey, includeCancelled } = req.query;

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

		const filteredReservations = [];
		let occupied = 0;

		reservations.forEach((reservation) => {
			if (!isReservationActive(reservation, includeCancelled === "true"))
				return;
			if (!reservationCoversDay(reservation, day)) return;

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
			filteredReservations.push(reservation);
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
