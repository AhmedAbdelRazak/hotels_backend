/** @format */

"use strict";

const normalizeId = (value) =>
	String(value?._id || value?.id || value || "").trim();

const configuredSuperAdminIds = () =>
	[process.env.SUPER_ADMIN_ID, process.env.REACT_APP_SUPER_ADMIN_ID]
		.flatMap((value) => String(value || "").split(","))
		.map((value) => value.trim())
		.filter(Boolean);

const isConfiguredSuperAdmin = (actor = {}) => {
	const actorId = normalizeId(actor);
	return Boolean(actorId) && configuredSuperAdminIds().includes(actorId);
};

const roleNumbers = (actor = {}) =>
	[
		Number(actor.role),
		...(Array.isArray(actor.roles) ? actor.roles.map(Number) : []),
	].filter((role) => Number.isFinite(role));

const normalizeRoleKey = (value = "") =>
	String(value || "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "");

const roleKeys = (actor = {}) =>
	[
		actor.roleDescription,
		...(Array.isArray(actor.roleDescriptions) ? actor.roleDescriptions : []),
	]
		.map(normalizeRoleKey)
		.filter(Boolean);

const assignedHotelIds = (actor = {}) =>
	[
		actor.hotelIdWork,
		...(Array.isArray(actor.hotelIdsWork) ? actor.hotelIdsWork : []),
		...(Array.isArray(actor.hotelsToSupport) ? actor.hotelsToSupport : []),
		...(Array.isArray(actor.hotelIdsOwner) ? actor.hotelIdsOwner : []),
	]
		.map(normalizeId)
		.filter((value, index, values) => value && values.indexOf(value) === index);

const HOTEL_RESERVATION_EDITOR_ROLE_NUMBERS = new Set([
	2000,
	3000,
	8000,
	10000,
]);

const HOTEL_RESERVATION_EDITOR_ROLE_KEYS = new Set([
	"owner",
	"hotelowner",
	"hotelmanager",
	"reception",
	"frontdesk",
	"reservationemployee",
	"reservationmanager",
	"reservationsmanager",
	"bookingresponsible",
	"bookingmanager",
	"systemadmin",
]);

const hasHotelReservationEditorRole = (actor = {}) =>
	roleNumbers(actor).some((role) =>
		HOTEL_RESERVATION_EDITOR_ROLE_NUMBERS.has(role),
	) ||
	roleKeys(actor).some((role) => HOTEL_RESERVATION_EDITOR_ROLE_KEYS.has(role));

const canEditHotelReservation = (actor = {}, hotel = {}) => {
	if (isConfiguredSuperAdmin(actor)) return true;
	if (!actor || actor.activeUser === false || !hotel) return false;

	const actorId = normalizeId(actor);
	const hotelId = normalizeId(hotel);
	const ownerId = normalizeId(hotel.belongsTo);
	if (!actorId || !hotelId || !ownerId) return false;

	// The actual hotel owner is authoritative even when a legacy owner account
	// does not carry the newer role-description fields.
	if (actorId === ownerId) return true;
	if (!hasHotelReservationEditorRole(actor)) return false;

	return assignedHotelIds(actor).includes(hotelId);
};

const HOTEL_RESERVATION_UPDATE_FIELDS = new Set([
	"customer_details",
	"customerDetails",
	"checkin_date",
	"checkout_date",
	"__reservationDateUpdateIntent",
	"days_of_residence",
	"total_guests",
	"adults",
	"children",
	"comment",
	"booking_comment",
	"booking_source",
	"payment",
	"paid_amount",
	"roomId",
	"pickedRoomsType",
	"pickedRoomsPricing",
	"total_rooms",
	"total_amount",
	"sub_total",
	"sendEmail",
	"hotelName",
]);

const sanitizeHotelReservationUpdate = (payload = {}) =>
	Object.entries(payload && typeof payload === "object" ? payload : {}).reduce(
		(result, [key, value]) => {
			if (HOTEL_RESERVATION_UPDATE_FIELDS.has(key)) result[key] = value;
			return result;
		},
		{},
	);

module.exports = {
	assignedHotelIds,
	canEditHotelReservation,
	hasHotelReservationEditorRole,
	isConfiguredSuperAdmin,
	normalizeId,
	sanitizeHotelReservationUpdate,
};
