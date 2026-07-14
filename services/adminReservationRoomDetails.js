const mongoose = require("mongoose");

const asArray = (value) => {
	if (Array.isArray(value)) return value;
	return value === null || value === undefined ? [] : [value];
};

const normalizeObjectId = (value) => {
	const candidate =
		value && typeof value === "object"
			? value._id || value.id || value.roomId || value.room_id
			: value;
	const normalized = String(candidate || "").trim().toLowerCase();
	return /^[a-f\d]{24}$/i.test(normalized) &&
		mongoose.Types.ObjectId.isValid(normalized)
		? normalized
		: "";
};

const normalizeText = (value) =>
	value === null || value === undefined ? "" : String(value).trim();

const reservationRoomIds = (reservation = {}) => {
	const seen = new Set();
	return asArray(reservation.roomId).reduce((ids, roomRef) => {
		const roomId = normalizeObjectId(roomRef);
		if (!roomId || seen.has(roomId)) return ids;
		seen.add(roomId);
		ids.push(roomId);
		return ids;
	}, []);
};

const collectReservationRoomIds = (reservations = []) => {
	const seen = new Set();
	return asArray(reservations).reduce((ids, reservation) => {
		reservationRoomIds(reservation).forEach((roomId) => {
			if (seen.has(roomId)) return;
			seen.add(roomId);
			ids.push(roomId);
		});
		return ids;
	}, []);
};

const minimalRoomDetails = (room) => {
	const roomId = normalizeObjectId(room);
	const roomNumber = normalizeText(
		room?.room_number ?? room?.roomNumber ?? room?.room_no ?? room?.number,
	);
	if (!roomId || !roomNumber) return null;

	return {
		_id: roomId,
		room_number: roomNumber,
		room_type: normalizeText(room?.room_type ?? room?.roomType),
		display_name: normalizeText(
			room?.display_name ?? room?.displayName ?? room?.room_display_name,
		),
	};
};

/**
 * Resolve physical rooms for already-paginated reservation rows.
 *
 * `loadRooms` is intentionally injected so the controller can perform one bounded
 * Rooms query and the resolver remains deterministic and independently testable.
 */
const attachAdminReservationRoomDetails = async (
	reservations = [],
	loadRooms,
) => {
	const rows = asArray(reservations);
	const roomIds = collectReservationRoomIds(rows);
	let rooms = [];

	if (roomIds.length > 0) {
		if (typeof loadRooms !== "function") {
			throw new TypeError("loadRooms must be a function when room IDs are present");
		}
		const loadedRooms = await loadRooms(roomIds);
		rooms = Array.isArray(loadedRooms) ? loadedRooms : [];
	}

	const roomsById = new Map();
	rooms.forEach((room) => {
		const roomId = normalizeObjectId(room);
		if (roomId && !roomsById.has(roomId)) {
			roomsById.set(roomId, room);
		}
	});

	return rows.map((reservation = {}) => {
		const reservationHotelId = normalizeObjectId(reservation.hotelId);
		const roomDetails = reservationRoomIds(reservation).reduce(
			(details, roomId) => {
				const room = roomsById.get(roomId);
				if (!room) return details;

				const roomHotelId = normalizeObjectId(room.hotelId);
				if (
					!reservationHotelId ||
					!roomHotelId ||
					roomHotelId !== reservationHotelId
				) {
					return details;
				}

				const compact = minimalRoomDetails(room);
				if (compact) details.push(compact);
				return details;
			},
			[],
		);

		return { ...reservation, roomDetails };
	});
};

module.exports = {
	attachAdminReservationRoomDetails,
	collectReservationRoomIds,
	minimalRoomDetails,
	normalizeObjectId,
	reservationRoomIds,
};
