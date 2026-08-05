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
	String(reservation?.otaPlatformReview?.status || "").trim().toLowerCase() ===
	OTA_PLATFORM_REVIEW_PENDING;

const normalizeOtaReviewLifecycleStatus = (value = "") =>
	String(value || "")
		.trim()
		.toLowerCase()
		.replace(/[\s_-]+/g, " ");

const isOtaPlatformReviewLifecycleConsistent = (reservation = {}) => {
	const expected = normalizeOtaReviewLifecycleStatus(
		OTA_PLATFORM_REVIEW_RESERVATION_STATUS,
	);
	return [reservation.reservation_status, reservation.state].every(
		(value) => normalizeOtaReviewLifecycleStatus(value) === expected,
	);
};

const validateOtaPlatformReviewActionState = (reservation = {}) => {
	if (!isOtaPlatformReviewPending(reservation)) {
		return {
			ready: false,
			statusCode: 409,
			code: "ota_review_not_pending",
			message:
				"This OTA reservation is no longer pending platform review.",
		};
	}
	if (!isOtaPlatformReviewLifecycleConsistent(reservation)) {
		return {
			ready: false,
			statusCode: 409,
			code: "ota_review_lifecycle_inconsistent",
			message:
				"This OTA review has inconsistent lifecycle statuses. Its reservation status and state must both remain OTA Platform Review until the dedicated release workflow is used.",
			details: {
				otaPlatformReviewStatus: String(
					reservation?.otaPlatformReview?.status || "",
				),
				reservationStatus: String(reservation.reservation_status || ""),
				state: String(reservation.state || ""),
			},
		};
	}
	return { ready: true };
};

const PENDING_OTA_REVIEW_GENERIC_LIFECYCLE_FIELDS = Object.freeze([
	"reservation_status",
	"state",
	"pendingConfirmation",
	"agentDecisionSnapshot",
	"otaPlatformReview",
]);

const comparableOtaLifecycleValue = (value, fieldName = "") => {
	if (value === undefined) return { __type: "undefined" };
	if (value === null) return null;
	if (fieldName === "status" && typeof value === "string") {
		return value.trim().toLowerCase();
	}
	if (value instanceof Date) return value.toISOString();
	if (
		value &&
		typeof value === "object" &&
		(value._bsontype === "ObjectID" || value._bsontype === "ObjectId")
	) {
		return String(value);
	}
	if (value && typeof value.toObject === "function") {
		return comparableOtaLifecycleValue(value.toObject(), fieldName);
	}
	if (Array.isArray(value)) {
		return value.map((item) => comparableOtaLifecycleValue(item));
	}
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.keys(value)
				.filter((key) => value[key] !== undefined)
				.sort()
				.map((key) => [key, comparableOtaLifecycleValue(value[key], key)]),
		);
	}
	return value;
};

const otaLifecycleValuesEqual = (left, right) =>
	JSON.stringify(comparableOtaLifecycleValue(left)) ===
	JSON.stringify(comparableOtaLifecycleValue(right));

const otaLifecyclePathValue = (source = {}, path = "") =>
	String(path || "")
		.split(".")
		.filter(Boolean)
		.reduce(
			(value, key) =>
				value === null || value === undefined ? undefined : value[key],
			source,
		);

const otaLifecycleUpdateChangesValue = (
	reservation = {},
	field = "",
	value,
) => {
	const existingValue = otaLifecyclePathValue(reservation, field);
	if (field === "reservation_status" || field === "state") {
		return (
			normalizeOtaReviewLifecycleStatus(value) !==
			normalizeOtaReviewLifecycleStatus(existingValue)
		);
	}
	if (field.endsWith(".status")) {
		return (
			String(value || "").trim().toLowerCase() !==
			String(existingValue || "").trim().toLowerCase()
		);
	}
	return !otaLifecycleValuesEqual(value, existingValue);
};

const validateGenericPendingOtaReviewLifecycleUpdate = (
	reservation = {},
	updates = {},
) => {
	if (!isOtaPlatformReviewPending(reservation)) return { ready: true };
	const fields = Object.entries(updates || {})
		.filter(([candidate]) =>
			PENDING_OTA_REVIEW_GENERIC_LIFECYCLE_FIELDS.some(
				(field) => candidate === field || candidate.startsWith(`${field}.`),
			),
		)
		.filter(([field, value]) =>
			otaLifecycleUpdateChangesValue(reservation, field, value),
		)
		.map(([field]) => field);
	if (!fields.length) return { ready: true };
	return {
		ready: false,
		statusCode: 409,
		code: "ota_review_dedicated_lifecycle_route_required",
		message:
			"A pending OTA platform review cannot be confirmed, cancelled, or otherwise moved through the generic reservation update route. Use the dedicated OTA release or review workflow.",
		fields,
	};
};

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
	isOtaPlatformReviewLifecycleConsistent,
	isScopedPlatformOtaActor,
	normalizeId,
	platformOtaScopeFilter,
	strictPlatformOtaHotelScopeFilter,
	validateGenericPendingOtaReviewLifecycleUpdate,
	validateOtaPlatformReviewActionState,
};
