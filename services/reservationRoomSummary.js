const asArray = (value) => (Array.isArray(value) ? value : []);

const cleanText = (value) =>
	String(value === null || value === undefined ? "" : value).trim();

const uniqueText = (values = []) => {
	const seen = new Set();
	return values.reduce((result, value) => {
		const text = cleanText(value);
		const key = text.toLowerCase();
		if (!text || seen.has(key)) return result;
		seen.add(key);
		result.push(text);
		return result;
	}, []);
};

const roomTypeLabel = (room = {}) => {
	if (!room || typeof room !== "object") return "";
	const type = cleanText(room.room_type || room.roomType);
	const displayName = cleanText(room.display_name || room.displayName);
	if (!type) return displayName;
	if (!displayName || displayName.toLowerCase() === type.toLowerCase()) {
		return type;
	}
	return `${type} - ${displayName}`;
};

const assignedRoomRecords = (reservation = {}) => [
	...asArray(reservation.roomDetails),
	...asArray(reservation.roomId).filter(
		(room) => room && typeof room === "object"
	),
];

const nestedPickedRoomRecords = (reservation = {}) =>
	asArray(reservation.pickedRoomsType).flatMap((room) => [
		room,
		...asArray(room?.roomDetails),
		...asArray(room?.roomId).filter(
			(assignedRoom) => assignedRoom && typeof assignedRoom === "object"
		),
	]);

const reservationRoomTypes = (reservation = {}) => {
	const reservedTypes = uniqueText(
		nestedPickedRoomRecords(reservation).map(roomTypeLabel)
	);
	if (reservedTypes.length > 0) return reservedTypes;

	return uniqueText(assignedRoomRecords(reservation).map(roomTypeLabel));
};

const roomNumbersFromRecord = (room = {}) => {
	if (!room || typeof room !== "object") return [];
	return [
		room.room_number,
		room.roomNumber,
		...asArray(room.room_numbers),
		...asArray(room.roomNumbers),
	];
};

const reservationRoomNumbers = (reservation = {}) =>
	uniqueText([
		...asArray(reservation.room_numbers),
		...asArray(reservation.roomNumbers),
		reservation.room_number,
		reservation.roomNumber,
		...assignedRoomRecords(reservation).flatMap(roomNumbersFromRecord),
		...nestedPickedRoomRecords(reservation).flatMap(roomNumbersFromRecord),
	]);

module.exports = {
	reservationRoomNumbers,
	reservationRoomTypes,
};
