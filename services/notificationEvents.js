const HotelDetails = require("../models/hotel_details");

const normalizeId = (value) => String(value?._id || value || "").trim();

const emitHotelNotificationRefresh = async (req, hotelId, payload = {}) => {
	const io = req?.app?.get("io");
	const normalizedHotelId = normalizeId(hotelId);
	if (!io || !normalizedHotelId) return;

	const basePayload = {
		type: payload.type || "hotel_notification_refresh",
		hotelId: normalizedHotelId,
		reservationId: normalizeId(payload.reservationId),
		emittedAt: new Date().toISOString(),
	};

	io.to(`hotel-notifications:${normalizedHotelId}`).emit(
		"hotelNotificationsUpdated",
		basePayload
	);

	let ownerId = normalizeId(payload.ownerId);
	if (!ownerId) {
		const hotel = await HotelDetails.findById(normalizedHotelId)
			.select("belongsTo")
			.lean()
			.exec();
		ownerId = normalizeId(hotel?.belongsTo);
	}

	if (ownerId) {
		io.to(`owner-notifications:${ownerId}`).emit("hotelNotificationsUpdated", {
			...basePayload,
			ownerId,
		});
	}
};

module.exports = {
	emitHotelNotificationRefresh,
};
