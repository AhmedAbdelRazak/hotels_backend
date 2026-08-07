"use strict";

const mongoose = require("mongoose");
const User = require("../models/user");
const HotelDetails = require("../models/hotel_details");

const PAYPAL_OWNER_CAPABILITIES = Object.freeze({
	TOKEN: "token",
	PAYMENT_METHODS: "payment_methods",
	FINANCE: "finance",
});

const ACTOR_SELECT =
	"_id name email role roles roleDescription roleDescriptions activeUser accessTo hotelIdWork hotelIdsWork belongsToId hotelsToSupport hotelIdsOwner accountScope platformEmployee";

const normalizeId = (value) => {
	if (!value) return "";
	if (typeof value === "object" && value._id) return String(value._id).trim();
	if (typeof value === "object" && typeof value.id === "string") {
		return value.id.trim();
	}
	return String(value).trim();
};

const configuredSuperAdminIds = () =>
	[process.env.SUPER_ADMIN_ID, process.env.REACT_APP_SUPER_ADMIN_ID]
		.flatMap((value) => String(value || "").split(","))
		.map((id) => id.trim())
		.filter(Boolean);

const isConfiguredSuperAdmin = (actor = {}) =>
	configuredSuperAdminIds().includes(normalizeId(actor));

const roleNumbers = (actor = {}) =>
	[
		actor?.role,
		...(Array.isArray(actor?.roles) ? actor.roles : []),
	]
		.map(Number)
		.filter((role, index, roles) =>
			Number.isFinite(role) && roles.indexOf(role) === index
		);

const roleDescriptions = (actor = {}) =>
	[
		actor?.roleDescription,
		...(Array.isArray(actor?.roleDescriptions)
			? actor.roleDescriptions
			: []),
	]
		.map((role) => String(role || "").trim().toLowerCase())
		.filter((role, index, roles) => role && roles.indexOf(role) === index);

const includesId = (values = [], targetId = "") =>
	(Array.isArray(values) ? values : []).some(
		(value) => normalizeId(value) === normalizeId(targetId)
	);

const assignedHotelIds = (actor = {}) =>
	[
		actor?.hotelIdWork,
		...(Array.isArray(actor?.hotelIdsWork) ? actor.hotelIdsWork : []),
		...(Array.isArray(actor?.hotelIdsOwner) ? actor.hotelIdsOwner : []),
		...(Array.isArray(actor?.hotelsToSupport)
			? actor.hotelsToSupport
			: []),
	]
		.map(normalizeId)
		.filter((id, index, ids) => id && ids.indexOf(id) === index);

const hasAnyRole = (actor, values = []) => {
	const allowed = new Set(values.map(Number));
	return roleNumbers(actor).some((role) => allowed.has(role));
};

const hasAnyDescription = (actor, values = []) => {
	const allowed = new Set(values.map((value) => String(value).toLowerCase()));
	return roleDescriptions(actor).some((role) => allowed.has(role));
};

const canUseCapability = (actor = {}, capability) => {
	if (!actor || actor.activeUser === false) return false;
	if (isConfiguredSuperAdmin(actor)) return true;
	if (hasAnyRole(actor, [1000])) return true;

	if (capability === PAYPAL_OWNER_CAPABILITIES.FINANCE) {
		return (
			hasAnyRole(actor, [2000, 6000, 10000]) ||
			hasAnyDescription(actor, [
				"finance",
				"hotelmanager",
				"systemadmin",
				"system admin",
			])
		);
	}

	if (capability === PAYPAL_OWNER_CAPABILITIES.PAYMENT_METHODS) {
		return (
			hasAnyRole(actor, [2000, 6000, 8000, 10000]) ||
			hasAnyDescription(actor, [
				"finance",
				"hotelmanager",
				"reservationemployee",
				"systemadmin",
				"system admin",
			])
		);
	}

	if (capability === PAYPAL_OWNER_CAPABILITIES.TOKEN) {
		return (
			canUseCapability(actor, PAYPAL_OWNER_CAPABILITIES.FINANCE) ||
			canUseCapability(actor, PAYPAL_OWNER_CAPABILITIES.PAYMENT_METHODS)
		);
	}

	return false;
};

const hasHotelScope = (actor = {}, hotel = {}) => {
	if (!actor || actor.activeUser === false || !hotel?._id) return false;
	if (isConfiguredSuperAdmin(actor)) return true;

	const actorId = normalizeId(actor);
	const hotelId = normalizeId(hotel);
	const ownerId = normalizeId(hotel.belongsTo);
	const roles = roleNumbers(actor);

	if (roles.includes(2000) && actorId && actorId === ownerId) return true;

	const assigned = assignedHotelIds(actor).includes(hotelId);
	if (!assigned) return false;

	// Platform/system admins are still constrained to their explicit hotel scope.
	if (roles.includes(1000) || roles.includes(10000)) return true;
	if (includesId(actor.hotelsToSupport, hotelId)) return true;

	const actorOwnerId = normalizeId(actor.belongsToId);
	return !actorOwnerId || Boolean(ownerId && actorOwnerId === ownerId);
};

const canAccessPayPalOwnerHotel = (
	actor = {},
	hotel = {},
	capability = PAYPAL_OWNER_CAPABILITIES.FINANCE
) => canUseCapability(actor, capability) && hasHotelScope(actor, hotel);

const findActorById = async (actorId) => {
	if (!mongoose.Types.ObjectId.isValid(String(actorId || ""))) return null;
	return User.findById(actorId).select(ACTOR_SELECT).lean().exec();
};

const loadActor = async (req = {}) => {
	const authId = normalizeId(req.auth?._id || req.auth?.id);
	if (!authId) return null;
	if (req.profile && normalizeId(req.profile) === authId) return req.profile;
	const actor = await findActorById(authId);
	if (actor) req.profile = actor;
	return actor;
};

const hotelIdFromRequest = (req = {}) =>
	normalizeId(req.params?.hotelId || req.body?.hotelId || req.query?.hotelId);

const requirePayPalOwnerActor =
	(capability = PAYPAL_OWNER_CAPABILITIES.TOKEN) => async (req, res, next) => {
		try {
			const actor = await loadActor(req);
			if (!canUseCapability(actor, capability)) {
				return res.status(403).json({
					message: "Owner payment access denied.",
				});
			}
			return next();
		} catch (_error) {
			return res.status(403).json({
				message: "Owner payment access denied.",
			});
		}
	};

const requirePayPalOwnerHotelAccess =
	(capability = PAYPAL_OWNER_CAPABILITIES.FINANCE) =>
	async (req, res, next) => {
		try {
			const hotelId = hotelIdFromRequest(req);
			if (!mongoose.Types.ObjectId.isValid(hotelId)) {
				return res.status(400).json({ message: "Invalid hotelId." });
			}

			const actor = await loadActor(req);
			if (!canUseCapability(actor, capability)) {
				return res.status(403).json({
					message: "Hotel financial access denied.",
				});
			}

			const hotel = await HotelDetails.findById(hotelId)
				.select("_id belongsTo")
				.lean()
				.exec();
			if (!canAccessPayPalOwnerHotel(actor, hotel, capability)) {
				return res.status(403).json({
					message: "Hotel financial access denied.",
				});
			}

			req.paypalOwnerHotel = hotel;
			return next();
		} catch (_error) {
			return res.status(403).json({
				message: "Hotel financial access denied.",
			});
		}
	};

module.exports = {
	PAYPAL_OWNER_CAPABILITIES,
	assignedHotelIds,
	canAccessPayPalOwnerHotel,
	canUseCapability,
	hasHotelScope,
	hotelIdFromRequest,
	requirePayPalOwnerActor,
	requirePayPalOwnerHotelAccess,
};
