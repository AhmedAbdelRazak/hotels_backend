"use strict";

const normalizeId = (value) => String(value?._id || value?.id || value || "").trim();

const dateOnlyKey = (value) => {
	if (!value) return "";
	if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) {
		return value.slice(0, 10);
	}
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString().slice(0, 10);
};

const agentIdFromReservation = (reservation = {}) =>
	normalizeId(
		reservation.agentId ||
			reservation.orderTakeId ||
			reservation.createdByUserId ||
			reservation.requestingUserId ||
			reservation.orderTaker?._id ||
			reservation.createdBy?._id
	);

const agentInventoryRows = (room = {}) =>
	Array.isArray(room?.agentInventory) ? room.agentInventory : [];

const agentPricingRows = (room = {}) =>
	Array.isArray(room?.agentPricingRate) ? room.agentPricingRate : [];

const getAgentInventoryRow = (room = {}, agentId = "") => {
	const target = normalizeId(agentId);
	if (!target) return null;
	return (
		agentInventoryRows(room).find((row) => normalizeId(row.agentId) === target) ||
		null
	);
};

const hasAgentInventory = (room = {}, agentId = "") =>
	Boolean(getAgentInventoryRow(room, agentId));

const getAgentAssignedStock = (room = {}, agentId = "") => {
	const row = getAgentInventoryRow(room, agentId);
	if (!row) return null;
	const stock = Number(row.stock);
	return Number.isFinite(stock) && stock >= 0 ? stock : 0;
};

const getAgentPricingRows = (room = {}, agentId = "") => {
	const target = normalizeId(agentId);
	if (!target) return [];
	return agentPricingRows(room).filter((row) => normalizeId(row.agentId) === target);
};

const getAgentPricingForDate = (room = {}, agentId = "", date = "") => {
	const targetDate = dateOnlyKey(date);
	if (!targetDate) return null;
	return (
		getAgentPricingRows(room, agentId).find(
			(row) => dateOnlyKey(row.calendarDate) === targetDate
		) || null
	);
};

const canUseAgentOverrides = (actor = {}, hotel = {}, agentId = "") => {
	const targetAgentId = normalizeId(agentId);
	if (!actor || !targetAgentId || actor.activeUser === false) return false;
	const actorId = normalizeId(actor._id);
	const hotelId = normalizeId(hotel._id);
	const ownerId = normalizeId(hotel.belongsTo);
	const roles = [
		Number(actor.role),
		...(Array.isArray(actor.roles) ? actor.roles.map(Number) : []),
	].filter((role) => Number.isFinite(role));
	const descriptions = [
		String(actor.roleDescription || "").toLowerCase(),
		...(Array.isArray(actor.roleDescriptions)
			? actor.roleDescriptions.map((item) => String(item || "").toLowerCase())
			: []),
	];
	const assignedHotelIds = [
		actor.hotelIdWork,
		...(Array.isArray(actor.hotelIdsWork) ? actor.hotelIdsWork : []),
		...(Array.isArray(actor.hotelsToSupport) ? actor.hotelsToSupport : []),
		...(Array.isArray(actor.hotelIdsOwner) ? actor.hotelIdsOwner : []),
	]
		.map(normalizeId)
		.filter(Boolean);
	const assignedToHotel = !hotelId || assignedHotelIds.includes(hotelId);
	const isPlatform = roles.includes(1000);
	const isOwnerLike =
		actorId === ownerId ||
		roles.includes(2000) ||
		roles.includes(10000) ||
		descriptions.includes("hotelmanager") ||
		descriptions.includes("systemadmin");
	const isHotelReviewStaff =
		roles.includes(6000) ||
		roles.includes(8000) ||
		descriptions.includes("finance") ||
		descriptions.includes("reservationemployee");
	const isAgentSelf =
		actorId === targetAgentId &&
		(roles.includes(7000) ||
			descriptions.includes("ordertaker") ||
			(Array.isArray(actor.accessTo) && actor.accessTo.includes("ownReservations")));

	return (
		isPlatform ||
		(assignedToHotel && (isOwnerLike || isHotelReviewStaff || isAgentSelf))
	);
};

module.exports = {
	agentIdFromReservation,
	canUseAgentOverrides,
	dateOnlyKey,
	getAgentAssignedStock,
	getAgentInventoryRow,
	getAgentPricingForDate,
	getAgentPricingRows,
	hasAgentInventory,
	normalizeId,
};
