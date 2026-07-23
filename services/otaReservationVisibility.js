/** @format */

"use strict";

const mongoose = require("mongoose");

const OTA_PLATFORM_REVIEW_PENDING = "pending";
const OTA_PLATFORM_REVIEW_RELEASED = "released";
const OTA_PLATFORM_REVIEW_RESERVATION_STATUS = "OTA Platform Review";
const OTA_RELEASED_RESERVATION_STATUS = "Pending Confirmation";

const normalizeId = (value) => String(value?._id || value?.id || value || "").trim();

const configuredSuperAdminIds = () =>
	[process.env.SUPER_ADMIN_ID, process.env.REACT_APP_SUPER_ADMIN_ID]
		.flatMap((value) => String(value || "").split(","))
		.map((id) => id.trim())
		.filter(Boolean);

const isConfiguredSuperAdmin = (user = {}) =>
	configuredSuperAdminIds().includes(normalizeId(user._id || user));

const accountRoleNumbers = (account = {}) =>
	[
		Number(account.role),
		...(Array.isArray(account.roles) ? account.roles.map(Number) : []),
	].filter(Boolean);

const accountRoleDescriptions = (account = {}) => [
	String(account.roleDescription || "").toLowerCase(),
	...(Array.isArray(account.roleDescriptions)
		? account.roleDescriptions.map((item) => String(item || "").toLowerCase())
		: []),
];

const canManageOtaReservations = (account = {}) => {
	if (!account || account.activeUser === false) return false;
	if (isConfiguredSuperAdmin(account)) return true;
	const accessTo = Array.isArray(account.accessTo)
		? account.accessTo.map((item) => String(item || "").trim())
		: [];
	const roleNumbers = accountRoleNumbers(account);
	const descriptions = accountRoleDescriptions(account);
	const isSuperAdminStyle = descriptions.some((description) =>
		/(^|\s)super[\s_-]?admin(\s|$)/i.test(description)
	);
	const isPlatformAdmin = roleNumbers.includes(1000) || isSuperAdminStyle;
	return isPlatformAdmin && accessTo.includes("OTAReservations");
};

const buildPendingOtaReviewFilter = () => ({
	"otaPlatformReview.status": OTA_PLATFORM_REVIEW_PENDING,
});

const buildExcludePendingOtaReviewFilter = () => ({
	"otaPlatformReview.status": { $ne: OTA_PLATFORM_REVIEW_PENDING },
});

const appendExcludePendingOtaReviewFilter = (filter = {}) => {
	const base = filter && typeof filter === "object" ? filter : {};
	if (!Object.keys(base).length) return buildExcludePendingOtaReviewFilter();
	return { $and: [base, buildExcludePendingOtaReviewFilter()] };
};

const addExcludePendingOtaReviewToMutableFilter = (filter = {}) => {
	if (!filter || typeof filter !== "object") return filter;
	filter.$and = [
		...(Array.isArray(filter.$and) ? filter.$and : []),
		buildExcludePendingOtaReviewFilter(),
	];
	return filter;
};

const isOtaPlatformReviewPending = (reservation = {}) =>
	String(reservation?.otaPlatformReview?.status || "").toLowerCase() ===
	OTA_PLATFORM_REVIEW_PENDING;

const assignedHotelIdsFromUser = (user = {}) =>
	[
		user.hotelIdWork,
		...(Array.isArray(user.hotelIdsWork) ? user.hotelIdsWork : []),
		...(Array.isArray(user.hotelsToSupport) ? user.hotelsToSupport : []),
		...(Array.isArray(user.hotelIdsOwner) ? user.hotelIdsOwner : []),
	]
		.map(normalizeId)
		.filter((id, index, arr) => id && arr.indexOf(id) === index);

const isScopedPlatformOtaActor = (actor = {}) =>
	Boolean(actor) &&
	!isConfiguredSuperAdmin(actor) &&
	accountRoleNumbers(actor).includes(1000);

const assignedHotelObjectIdsForOtaActor = (actor = {}) =>
	assignedHotelIdsFromUser(actor)
		.filter((id) => mongoose.Types.ObjectId.isValid(id))
		.map((id) => mongoose.Types.ObjectId(id));

const platformOtaScopeFilter = (actor = {}) => {
	if (!isScopedPlatformOtaActor(actor)) {
		return null;
	}
	const hotelIds = assignedHotelObjectIdsForOtaActor(actor);
	if (!hotelIds.length) return { _id: { $exists: false } };
	return {
		$or: [
			{
				hotelId: {
					$in: hotelIds,
				},
			},
			{ hotelId: { $exists: false } },
			{ hotelId: null },
		],
	};
};

const strictPlatformOtaHotelScopeFilter = (actor = {}) => {
	if (!isScopedPlatformOtaActor(actor)) return null;
	const hotelIds = assignedHotelObjectIdsForOtaActor(actor);
	return hotelIds.length
		? { hotelId: { $in: hotelIds } }
		: { _id: { $exists: false } };
};

const applyPlatformOtaScope = (actor = {}, filter = {}) => {
	const scope = platformOtaScopeFilter(actor);
	if (!scope) return filter;
	return { $and: [filter, scope] };
};

const buildOtaReviewSnapshot = ({
	status = OTA_PLATFORM_REVIEW_PENDING,
	source = "ota_email",
	inboundEmailId = "",
	provider = "",
	providerLabel = "",
	confirmationNumber = "",
	releasedBy = null,
	releasedAt = null,
	priceAtRelease = 0,
} = {}) => ({
	status,
	source,
	inboundEmailId: normalizeId(inboundEmailId),
	provider: String(provider || ""),
	providerLabel: String(providerLabel || ""),
	confirmationNumber: String(confirmationNumber || ""),
	createdAt: new Date(),
	releasedAt,
	releasedBy,
	priceAtRelease,
});

module.exports = {
	OTA_PLATFORM_REVIEW_PENDING,
	OTA_PLATFORM_REVIEW_RELEASED,
	OTA_PLATFORM_REVIEW_RESERVATION_STATUS,
	OTA_RELEASED_RESERVATION_STATUS,
	appendExcludePendingOtaReviewFilter,
	addExcludePendingOtaReviewToMutableFilter,
	applyPlatformOtaScope,
	assignedHotelIdsFromUser,
	buildExcludePendingOtaReviewFilter,
	buildOtaReviewSnapshot,
	buildPendingOtaReviewFilter,
	canManageOtaReservations,
	isConfiguredSuperAdmin,
	isOtaPlatformReviewPending,
	isScopedPlatformOtaActor,
	normalizeId,
	platformOtaScopeFilter,
	strictPlatformOtaHotelScopeFilter,
};
