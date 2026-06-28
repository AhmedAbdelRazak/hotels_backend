const HotelDetails = require("../models/hotel_details");
const mongoose = require("mongoose");
const _ = require("lodash");
const axios = require("axios");
const User = require("../models/user");
const Reservations = require("../models/reservations");
const Rooms = require("../models/rooms");
const UncompleteReservations = require("../models/Uncompleted");
const {
	buildPendingConfirmationExclusionFilter,
} = require("../services/reservationStatus");
const {
	buildExcludePendingOtaReviewFilter,
} = require("../services/otaReservationVisibility");
const {
	addHotelManagementReservationVisibilityToFilter,
	maskBookingSourceSummaryRowsForHotelManagement,
	shouldMaskHotelManagementReservationSource,
	withHotelManagementSourceViewContext,
} = require("../services/reservationVisibility");
const {
	sanitizeReservationAuditLogsCollectionForViewer,
} = require("../services/auditPrivacy");
const {
	sanitizeHotelPolicyQA,
} = require("../services/hotelPolicyQa");

const isConfiguredSuperAdmin = (user) => {
	const configuredIds = [
		process.env.SUPER_ADMIN_ID,
		process.env.REACT_APP_SUPER_ADMIN_ID,
	]
		.flatMap((value) => String(value || "").split(","))
		.map((id) => String(id).trim())
		.filter(Boolean);
	return configuredIds.includes(String(user?._id || "").trim());
};

const canReassignPropertyOwner = (user) =>
	Boolean(user) && isConfiguredSuperAdmin(user);

const normalizeId = (value) => String(value?._id || value || "").trim();
const HOTEL_DETAILS_SUMMARY_SELECT = [
	"_id",
	"hotelName",
	"hotelName_OtherLanguage",
	"hotelCountry",
	"hotelState",
	"hotelCity",
	"phone",
	"hotelAddress",
	"hotelFloors",
	"hotelRooms",
	"overallRoomsCount",
	"distances",
	"hotelRating",
	"parkingLot",
	"hasBusService",
	"busDetails",
	"hasMealsService",
	"mealsDetails",
	"isNusuk",
	"isNusukText",
	"hotelPolicyQA",
	"subscribed",
	"wholeSaleHotel",
	"propertyType",
	"activateHotel",
	"xHotelProActive",
	"aiToRespond",
	"belongsTo",
	"createdAt",
	"updatedAt",
].join(" ");

const HOTEL_DETAILS_RESERVATION_DETAILS_SELECT = [
	"_id",
	"hotelName",
	"hotelName_OtherLanguage",
	"belongsTo",
	"commission",
	"roomCountDetails._id",
	"roomCountDetails.roomType",
	"roomCountDetails.room_type",
	"roomCountDetails.displayName",
	"roomCountDetails.display_name",
	"roomCountDetails.displayName_OtherLanguage",
	"roomCountDetails.price",
	"roomCountDetails.defaultCost",
	"roomCountDetails.roomCommission",
	"roomCountDetails.pricingRate",
	"roomCountDetails.roomColor",
	"roomCountDetails.count",
	"roomCountDetails.activeRoom",
	"roomCountDetails.offers",
	"roomCountDetails.monthly",
].join(" ");

const HOTEL_DETAILS_ROOM_WORKSPACE_FIELDS = [
	"roomCountDetails._id",
	"roomCountDetails.roomType",
	"roomCountDetails.room_type",
	"roomCountDetails.count",
	"roomCountDetails.price",
	"roomCountDetails.photos",
	"roomCountDetails.displayName",
	"roomCountDetails.display_name",
	"roomCountDetails.displayName_OtherLanguage",
	"roomCountDetails.description",
	"roomCountDetails.description_OtherLanguage",
	"roomCountDetails.amenities",
	"roomCountDetails.views",
	"roomCountDetails.extraAmenities",
	"roomCountDetails.pricedExtras",
	"roomCountDetails.pricingRate",
	"roomCountDetails.roomColor",
	"roomCountDetails.activeRoom",
	"roomCountDetails.commisionIncluded",
	"roomCountDetails.refundPolicyDays",
	"roomCountDetails.roomSize",
	"roomCountDetails.defaultCost",
	"roomCountDetails.roomCommission",
	"roomCountDetails.bedsCount",
	"roomCountDetails.roomForGender",
	"roomCountDetails.offers",
	"roomCountDetails.monthly",
];

const HOTEL_DETAILS_ROOM_WORKSPACE_COMPACT_FIELDS =
	HOTEL_DETAILS_ROOM_WORKSPACE_FIELDS.filter(
		(field) =>
			![
				"roomCountDetails.pricingRate",
				"roomCountDetails.offers",
				"roomCountDetails.monthly",
			].includes(field)
	);

const HOTEL_DETAILS_MANAGEMENT_SELECT = [
	"_id",
	"hotelName",
	"hotelName_OtherLanguage",
	"hotelCountry",
	"hotelState",
	"hotelCity",
	"aboutHotel",
	"aboutHotelArabic",
	"phone",
	"hotelAddress",
	"hotelFloors",
	"hotelRooms",
	"overallRoomsCount",
	"distances",
	"hotelPhotos",
	"hotelRating",
	"parkingLot",
	"hasBusService",
	"busDetails",
	"hasMealsService",
	"mealsDetails",
	"isNusuk",
	"isNusukText",
	"hotelPolicyQA",
	"subscribed",
	"acceptedTermsAndConditions",
	"wholeSaleHotel",
	"propertyType",
	"pictures_testing",
	"location_testing",
	"rooms_pricing_testing",
	"activateHotel",
	"xHotelProActive",
	"aiToRespond",
	"currency",
	"location",
	"commission",
	"guestPaymentAcceptance",
	"paymentSettings",
	"ownerPaymentMethods",
	"belongsTo",
	...HOTEL_DETAILS_ROOM_WORKSPACE_FIELDS,
	"createdAt",
	"updatedAt",
].join(" ");

const HOTEL_DETAILS_MANAGEMENT_COMPACT_SELECT = [
	"_id",
	"hotelName",
	"hotelName_OtherLanguage",
	"hotelCountry",
	"hotelState",
	"hotelCity",
	"aboutHotel",
	"aboutHotelArabic",
	"phone",
	"hotelAddress",
	"hotelFloors",
	"hotelRooms",
	"overallRoomsCount",
	"distances",
	"hotelPhotos",
	"hotelRating",
	"parkingLot",
	"hasBusService",
	"busDetails",
	"hasMealsService",
	"mealsDetails",
	"isNusuk",
	"isNusukText",
	"hotelPolicyQA",
	"subscribed",
	"acceptedTermsAndConditions",
	"wholeSaleHotel",
	"propertyType",
	"pictures_testing",
	"location_testing",
	"rooms_pricing_testing",
	"activateHotel",
	"xHotelProActive",
	"aiToRespond",
	"currency",
	"location",
	"commission",
	"guestPaymentAcceptance",
	"paymentSettings",
	"ownerPaymentMethods",
	"belongsTo",
	...HOTEL_DETAILS_ROOM_WORKSPACE_COMPACT_FIELDS,
	"createdAt",
	"updatedAt",
].join(" ");

const HOTEL_DETAILS_RESERVATION_WORKSPACE_SELECT = [
	"_id",
	"hotelName",
	"hotelName_OtherLanguage",
	"hotelCountry",
	"hotelState",
	"hotelCity",
	"hotelAddress",
	"overallRoomsCount",
	"distances",
	"hotelRating",
	"parkingLot",
	"hasBusService",
	"busDetails",
	"hasMealsService",
	"mealsDetails",
	"isNusuk",
	"isNusukText",
	"hotelPolicyQA",
	"wholeSaleHotel",
	"propertyType",
	"activateHotel",
	"xHotelProActive",
	"currency",
	"commission",
	"guestPaymentAcceptance",
	"paymentSettings",
	"belongsTo",
	...HOTEL_DETAILS_ROOM_WORKSPACE_FIELDS,
	"createdAt",
	"updatedAt",
].join(" ");

const isHotelDetailsSummaryRequest = (req = {}) => {
	const view = String(req.query?.view || req.query?.payload || "").toLowerCase();
	return ["summary", "lite", "compact"].includes(view);
};

const isHotelDetailsReservationDetailsRequest = (req = {}) => {
	const view = String(req.query?.view || req.query?.payload || "").toLowerCase();
	return ["reservation-details", "reservation-detail", "details-modal"].includes(
		view
	);
};

const isHotelDetailsManagementRequest = (req = {}) => {
	const view = String(req.query?.view || req.query?.payload || "").toLowerCase();
	return ["management", "settings", "pms-management"].includes(view);
};

const includesPricingRowsRequest = (req = {}) =>
	["1", "true", "yes", "full"].includes(
		String(req.query?.includePricingRows || "").toLowerCase()
	);

const isHotelDetailsReservationWorkspaceRequest = (req = {}) => {
	const view = String(req.query?.view || req.query?.payload || "").toLowerCase();
	return ["reservation-workspace", "new-reservation", "reservation"].includes(
		view
	);
};

const includesId = (list = [], targetId) =>
	Array.isArray(list) &&
	list.some((item) => normalizeId(item) === normalizeId(targetId));

const canViewHotelStats = (user, hotel) => {
	if (!user || !hotel) return false;
	if (isConfiguredSuperAdmin(user)) return true;

	const hotelId = normalizeId(hotel._id);
	const ownerId = normalizeId(hotel.belongsTo);
	const userId = normalizeId(user._id);

	if (Number(user.role) === 2000 && userId === ownerId) return true;
	if (includesId(user.hotelIdsOwner, hotelId)) return true;
	if (includesId(user.hotelsToSupport, hotelId)) return true;

	return (
		normalizeId(user.hotelIdWork) === hotelId &&
		normalizeId(user.belongsToId) === ownerId
	);
};

const actorRoleNumbers = (actor = {}) =>
	[
		Number(actor.role),
		...(Array.isArray(actor.roles) ? actor.roles.map(Number) : []),
	].filter((role) => Number.isFinite(role));

const actorRoleDescriptions = (actor = {}) => [
	String(actor.roleDescription || "").toLowerCase(),
	...(Array.isArray(actor.roleDescriptions)
		? actor.roleDescriptions.map((item) => String(item || "").toLowerCase())
		: []),
];

const isAgentAccount = (actor = {}) => {
	const roles = actorRoleNumbers(actor);
	const descriptions = actorRoleDescriptions(actor);
	return (
		roles.includes(7000) ||
		descriptions.includes("ordertaker") ||
		(Array.isArray(actor.accessTo) && actor.accessTo.includes("ownReservations"))
	);
};

const canManageHotelAgentOverrides = (actor = {}, hotel = {}) => {
	if (!actor || !hotel || actor.activeUser === false) return false;
	if (isConfiguredSuperAdmin(actor)) return true;

	const roles = actorRoleNumbers(actor);
	const descriptions = actorRoleDescriptions(actor);
	const actorId = normalizeId(actor._id);
	const hotelId = normalizeId(hotel._id);
	const ownerId = normalizeId(hotel.belongsTo);
	const assignedHotelIds = assignedHotelIdsFromUser(actor);
	const assignedToHotel = !hotelId || assignedHotelIds.includes(hotelId);

	if (roles.includes(1000)) return true;
	if (actorId && actorId === ownerId) return true;
	if (roles.includes(2000) && (assignedToHotel || actorId === ownerId)) return true;
	if (
		assignedToHotel &&
		(roles.includes(10000) ||
			roles.includes(8000) ||
			descriptions.includes("hotelmanager") ||
			descriptions.includes("reservationemployee") ||
			descriptions.includes("systemadmin") ||
			Array.isArray(actor.accessTo) && actor.accessTo.includes("settings"))
	) {
		return true;
	}

	return false;
};

const sanitizeAgentRoomOverridesForViewer = (hotelDetails, viewer = null) => {
	const hotel =
		hotelDetails && typeof hotelDetails.toObject === "function"
			? hotelDetails.toObject()
			: { ...(hotelDetails || {}) };
	const actorId = normalizeId(viewer?._id);
	const canManage = canManageHotelAgentOverrides(viewer, hotel);
	const canSeeSelf = actorId && isAgentAccount(viewer);

	if (!Array.isArray(hotel.roomCountDetails)) return hotel;

	hotel.roomCountDetails = hotel.roomCountDetails.map((room = {}) => {
		const nextRoom =
			room && typeof room.toObject === "function" ? room.toObject() : { ...room };
		if (canManage) return nextRoom;
		if (canSeeSelf) {
			nextRoom.agentInventory = Array.isArray(nextRoom.agentInventory)
				? nextRoom.agentInventory.filter(
						(row) => normalizeId(row.agentId) === actorId
				  )
				: [];
			nextRoom.agentPricingRate = Array.isArray(nextRoom.agentPricingRate)
				? nextRoom.agentPricingRate.filter(
						(row) => normalizeId(row.agentId) === actorId
				  )
				: [];
			return nextRoom;
		}

		delete nextRoom.agentInventory;
		delete nextRoom.agentPricingRate;
		return nextRoom;
	});

	return hotel;
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

const applyAdminHotelScope = (req, match = {}) => {
	const actor = req.profile;
	if (!actor || isConfiguredSuperAdmin(actor) || Number(actor.role) !== 1000) {
		return match;
	}
	const hotelIds = assignedHotelIdsFromUser(actor).filter((id) =>
		mongoose.Types.ObjectId.isValid(id)
	);
	return {
		...match,
		_id: { $in: hotelIds.map((id) => mongoose.Types.ObjectId(id)) },
	};
};

const DONE_RESERVATION_STATUS =
	/checked[-_\s]?out|early[-_\s]?checked[-_\s]?out|closed|cancelled|canceled|no[-_\s]?show/i;
const CONFIRMED_RESERVATION_STATUS = /^confirmed$/i;
const EARLY_CLOSED_RESERVATION_STATUS =
	/cancelled|canceled|no[-_\s]?show/i;
const PENDING_RECONCILIATION_STATUS =
	/pending[-_\s]?confirmation|pending[-_\s]?finance[-_\s]?review|pending[-_\s]?agent[-_\s]?commission[-_\s]?approval|finance[-_\s]?rejected|rejected/i;
const FINANCIAL_CYCLE_REQUIRED_FROM = new Date("2026-05-08T00:00:00.000Z");
const ASSIGNED_COMMISSION_STATUSES = new Set([
	"commission due",
	"commission paid",
	"no commission due",
]);

const getDeclaredRoomsTotal = (hotel = {}) => {
	const directTotal = Number(hotel.overallRoomsCount || 0);
	if (directTotal > 0) return directTotal;

	const projectedTotal = Number(hotel.roomCountDetailsDeclaredCount || 0);
	if (projectedTotal > 0) return projectedTotal;

	return (hotel.roomCountDetails || []).reduce((total, room) => {
		const possibleCount =
			Number(room.count) ||
			Number(room.roomCount) ||
			Number(room.totalRooms) ||
			Number(room.availableRooms) ||
			0;
		return total + possibleCount;
	}, 0);
};

const DASHBOARD_HOTEL_STATS_PROJECT = {
	_id: 1,
	hotelName: 1,
	belongsTo: 1,
	overallRoomsCount: 1,
	activateHotel: 1,
	xHotelProActive: 1,
	location: 1,
	aboutHotel: 1,
	aboutHotelArabic: 1,
	roomCountDetailsCount: { $size: { $ifNull: ["$roomCountDetails", []] } },
	hotelPhotosCount: { $size: { $ifNull: ["$hotelPhotos", []] } },
	paymentSettingsCount: { $size: { $ifNull: ["$paymentSettings", []] } },
	roomCountDetailsDeclaredCount: {
		$sum: {
			$map: {
				input: { $ifNull: ["$roomCountDetails", []] },
				as: "room",
				in: {
					$convert: {
						input: "$$room.count",
						to: "double",
						onError: 0,
						onNull: 0,
					},
				},
			},
		},
	},
};

const getHotelActivationChecklist = (hotel = {}) => {
	const coords = hotel?.location?.coordinates;
	const roomsDone =
		Array.isArray(hotel?.roomCountDetails) && hotel.roomCountDetails.length > 0;
	const photosDone =
		Array.isArray(hotel?.hotelPhotos) && hotel.hotelPhotos.length > 0;
	const locationDone =
		Array.isArray(coords) &&
		coords.length >= 2 &&
		coords[0] !== 0 &&
		coords[1] !== 0;
	const dataDone = Boolean(
		hotel?.aboutHotel || hotel?.aboutHotelArabic || hotel?.overallRoomsCount
	);
	const bankDone =
		Array.isArray(hotel?.paymentSettings) && hotel.paymentSettings.length > 0;

	return {
		roomsDone,
		photosDone,
		locationDone,
		dataDone,
		bankDone,
		activationReady: roomsDone && photosDone && locationDone && dataDone,
		fullyComplete: roomsDone && photosDone && locationDone && dataDone && bankDone,
	};
};

const extractReservationRoomIds = (roomId) => {
	if (!roomId) return [];
	if (Array.isArray(roomId)) return roomId.map(normalizeId).filter(Boolean);
	return [normalizeId(roomId)].filter(Boolean);
};

const getTodayEnd = () => {
	const endOfDay = new Date();
	endOfDay.setHours(23, 59, 59, 999);
	return endOfDay;
};

const buildOperationalOpenReservationFilter = (hotelObjectId) => ({
	hotelId: hotelObjectId,
	checkout_date: { $lte: getTodayEnd() },
	reservation_status: { $not: DONE_RESERVATION_STATUS },
	...buildExcludePendingOtaReviewFilter(),
});

const buildFinancialCycleRequiredDateFilter = () => ({
	$or: [
		{
			booked_at: { $gte: FINANCIAL_CYCLE_REQUIRED_FROM },
		},
		{
			$and: [
				{ $or: [{ booked_at: { $exists: false } }, { booked_at: null }] },
				{ createdAt: { $gte: FINANCIAL_CYCLE_REQUIRED_FROM } },
			],
		},
	],
});

const buildDashboardOpenReservationFilter = buildOperationalOpenReservationFilter;

const buildDashboardOpenReservationFilterForHotels = (hotelObjectIds = []) => ({
	hotelId: { $in: hotelObjectIds },
	checkout_date: { $lte: getTodayEnd() },
	reservation_status: { $not: DONE_RESERVATION_STATUS },
	...buildExcludePendingOtaReviewFilter(),
});

const buildDashboardFinancialReconciliationBranch = () => ({
	$and: [
		buildFinancialCycleRequiredDateFilter(),
		{ reservation_status: { $not: EARLY_CLOSED_RESERVATION_STATUS } },
		{
			$or: [
				{ reservation_status: PENDING_RECONCILIATION_STATUS },
				{ state: PENDING_RECONCILIATION_STATUS },
				{ "financial_cycle.status": { $ne: "closed" } },
				{ "financial_cycle.totalReviewStatus": "rejected" },
				{ "commissionAgentApproval.status": { $in: ["pending", "rejected"] } },
			],
		},
	],
});

const buildDashboardIncompleteReservationFilter = (hotelObjectId) => ({
	hotelId: hotelObjectId,
	...buildExcludePendingOtaReviewFilter(),
	$or: [
		{
			checkout_date: { $lte: getTodayEnd() },
			reservation_status: { $not: DONE_RESERVATION_STATUS },
		},
		buildDashboardFinancialReconciliationBranch(),
	],
});

const buildDashboardIncompleteReservationFilterForHotels = (hotelObjectIds = []) => ({
	hotelId: { $in: hotelObjectIds },
	...buildExcludePendingOtaReviewFilter(),
	$or: [
		{
			checkout_date: { $lte: getTodayEnd() },
			reservation_status: { $not: DONE_RESERVATION_STATUS },
		},
		buildDashboardFinancialReconciliationBranch(),
	],
});

const EXECUTIVE_DATE_FIELDS = new Set([
	"createdAt",
	"checkin_date",
	"checkout_date",
]);

const normalizeExecutiveDateField = (value = "") => {
	const normalized = String(value || "").trim();
	if (["checkin", "checkinDate", "check_in"].includes(normalized)) {
		return "checkin_date";
	}
	if (["checkout", "checkoutDate", "check_out"].includes(normalized)) {
		return "checkout_date";
	}
	if (["booked_at", "bookedAt", "created_at"].includes(normalized)) {
		return "createdAt";
	}
	return EXECUTIVE_DATE_FIELDS.has(normalized) ? normalized : "createdAt";
};

const executiveDateRange = (range = "all") => {
	const normalized = String(range || "all").trim().toLowerCase();
	if (normalized === "all") {
		return { range: "all", from: null, to: new Date() };
	}

	const now = new Date();
	const start = new Date(now);
	start.setHours(0, 0, 0, 0);
	const end = new Date(now);
	end.setHours(23, 59, 59, 999);

	if (normalized === "yesterday") {
		start.setDate(start.getDate() - 1);
		end.setDate(end.getDate() - 1);
		return { range: "yesterday", from: start, to: end };
	}

	if (normalized === "last7") {
		start.setDate(start.getDate() - 6);
		return { range: "last7", from: start, to: end };
	}

	if (["last90", "last3months", "past3months"].includes(normalized)) {
		start.setDate(start.getDate() - 89);
		return { range: "last90", from: start, to: end };
	}

	return { range: "today", from: start, to: end };
};

const buildExecutiveReservationFilterForHotels = (
	hotelObjectIds = [],
	{ range = "all", dateBy = "createdAt" } = {}
) => {
	const filter = {
		hotelId: { $in: hotelObjectIds },
		...buildExcludePendingOtaReviewFilter(),
	};
	const period = executiveDateRange(range);
	if (!period.from || !period.to) return filter;

	const dateField = normalizeExecutiveDateField(dateBy);
	const dateFilter = { $gte: period.from, $lte: period.to };
	if (dateField === "createdAt") {
		return {
			...filter,
			$or: [
				{ createdAt: dateFilter },
				{
					$and: [
						{ $or: [{ createdAt: { $exists: false } }, { createdAt: null }] },
						{ booked_at: dateFilter },
					],
				},
			],
		};
	}

	return {
		...filter,
		[dateField]: dateFilter,
	};
};

const buildStoredHotelIdFilter = (hotelId) => ({
	$expr: { $eq: [{ $toString: "$hotelId" }, String(hotelId)] },
});

const makeReason = (code, en, ar) => ({ code, en, ar });

const compactReasons = (reasons = []) => {
	const seen = new Set();
	return reasons.filter((reason) => {
		const key = reason?.code || reason?.en;
		if (!key || seen.has(key)) return false;
		seen.add(key);
		return true;
	});
};

const serializeReasonText = (reasons = [], language = "en") =>
	reasons
		.map((reason) => reason?.[language] || reason?.en || "")
		.filter(Boolean)
		.join(language === "ar" ? "؛ " : "; ");

const isDueCheckoutWithoutDoneStatus = (reservation = {}) => {
	if (!reservation.checkout_date) return false;
	const checkoutDate = new Date(reservation.checkout_date);
	if (Number.isNaN(checkoutDate.getTime())) return false;

	return (
		checkoutDate <= getTodayEnd() &&
		!DONE_RESERVATION_STATUS.test(String(reservation.reservation_status || ""))
	);
};

const getOpenReservationReasons = (reservation = {}) => {
	const reasons = [];
	const cycle = reservation.financial_cycle || {};
	const cycleStatus = String(cycle.status || "").toLowerCase();
	const collectionModel = String(cycle.collectionModel || "").toLowerCase();

	if (cycleStatus !== "closed") {
		if (collectionModel === "pms_collected" && !reservation.moneyTransferredToHotel) {
			reasons.push(
				makeReason(
					"pms_transfer_pending",
					"PMS collected the payment, but transfer to the hotel is not marked complete.",
					"تم تحصيل المبلغ من النظام، لكن تحويل المبلغ للفندق غير مكتمل."
				)
			);
		} else if (collectionModel === "hotel_collected" && !reservation.commissionPaid) {
			reasons.push(
				makeReason(
					"hotel_commission_pending",
					"Hotel collected the payment, but commission is not marked paid.",
					"الفندق حصّل المبلغ، لكن دفع العمولة غير مكتمل."
				)
			);
		} else if (
			collectionModel === "mixed" &&
			(!reservation.moneyTransferredToHotel || !reservation.commissionPaid)
		) {
			reasons.push(
				makeReason(
					"mixed_cycle_pending",
					"Mixed payment cycle still needs reconciliation.",
					"دورة دفع مختلطة ما زالت تحتاج مطابقة مالية."
				)
			);
		} else {
			reasons.push(
				makeReason(
					"financial_cycle_open",
					"Financial cycle is not closed yet.",
					"الدورة المالية لم تغلق بعد."
				)
			);
		}
	}

	if (isDueCheckoutWithoutDoneStatus(reservation)) {
		const status = reservation.reservation_status || "confirmed";
		reasons.push(
			makeReason(
				"checkout_due_status_open",
				`Checkout date is due, but reservation status is still ${status}.`,
				`تاريخ المغادرة مستحق، لكن حالة الحجز ما زالت ${status}.`
			)
		);
	}

	if (!reasons.length) {
		reasons.push(
			makeReason(
				"open_follow_up",
				"Reservation needs follow-up before it can be closed.",
				"الحجز يحتاج متابعة قبل إغلاقه."
			)
		);
	}

	return compactReasons(reasons);
};

const hasValidDate = (value) => {
	if (!value) return false;
	const date = new Date(value);
	return !Number.isNaN(date.getTime());
};

const hasPickedRoomType = (reservation = {}) =>
	Array.isArray(reservation.pickedRoomsType) &&
	reservation.pickedRoomsType.some((room) =>
		Boolean(room?.room_type || room?.roomType || room?.displayName)
	);

const getIncompleteReservationReasons = (reservation = {}) => {
	const reasons = [];
	const customer = reservation.customer_details || {};
	const status = String(
		reservation.reservation_status || reservation.state || ""
	).toLowerCase();
	const contactExists = Boolean(customer.phone || customer.email);

	if (reservation.rootCause) {
		reasons.push(
			makeReason(
				"root_cause",
				`Saved reason: ${reservation.rootCause}`,
				`السبب المسجل: ${reservation.rootCause}`
			)
		);
	}

	if (!reservation.confirmation_number) {
		reasons.push(
			makeReason(
				"missing_confirmation",
				"Missing confirmation number.",
				"رقم التأكيد غير موجود."
			)
		);
	}

	if (!customer.name) {
		reasons.push(
			makeReason("missing_guest_name", "Missing guest name.", "اسم الضيف غير موجود.")
		);
	}

	if (!contactExists) {
		reasons.push(
			makeReason(
				"missing_guest_contact",
				"Missing guest phone or email.",
				"رقم الهاتف أو البريد الإلكتروني للضيف غير موجود."
			)
		);
	}

	if (!hasValidDate(reservation.checkin_date) || !hasValidDate(reservation.checkout_date)) {
		reasons.push(
			makeReason(
				"missing_stay_dates",
				"Missing check-in or checkout date.",
				"تاريخ الوصول أو المغادرة غير مكتمل."
			)
		);
	}

	if (!hasPickedRoomType(reservation) || Number(reservation.total_rooms || 0) <= 0) {
		reasons.push(
			makeReason(
				"missing_room_details",
				"Missing room type or room count.",
				"نوع الغرفة أو عدد الغرف غير مكتمل."
			)
		);
	}

	if (!reservation.booking_source) {
		reasons.push(
			makeReason("missing_source", "Missing booking source.", "مصدر الحجز غير موجود.")
		);
	}

	if (reservation.guestAgreedOnTermsAndConditions === false) {
		reasons.push(
			makeReason(
				"terms_not_completed",
				"Guest terms and conditions were not completed.",
				"لم يتم استكمال موافقة الضيف على الشروط والأحكام."
			)
		);
	}

	if (status.includes("uncomplete") || status.includes("incomplete")) {
		reasons.push(
			makeReason(
				"saved_as_incomplete",
				"Reservation is still saved as incomplete.",
				"الحجز ما زال محفوظاً كحجز غير مكتمل."
			)
		);
	}

	if (!reasons.length) {
		reasons.push(
			makeReason(
				"incomplete_follow_up",
				"Reservation data needs review before completion.",
				"بيانات الحجز تحتاج مراجعة قبل الإكمال."
			)
		);
	}

	return compactReasons(reasons);
};

const getReservationBookedOrCreatedAt = (reservation = {}) => {
	const value = reservation.booked_at || reservation.createdAt;
	if (!value) return null;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
};

const isFinancialCycleRequired = (reservation = {}) => {
	const bookedOrCreatedAt = getReservationBookedOrCreatedAt(reservation);
	return Boolean(
		bookedOrCreatedAt && bookedOrCreatedAt >= FINANCIAL_CYCLE_REQUIRED_FROM
	);
};

const isFinancialCycleOpen = (reservation = {}) =>
	String(reservation?.financial_cycle?.status || "").toLowerCase() !== "closed";

const moneyNumber = (value) => {
	if (value === null || value === undefined || value === "") return 0;
	if (typeof value === "number") return Number.isFinite(value) ? value : 0;
	const parsed = Number(String(value).replace(/,/g, "").trim());
	return Number.isFinite(parsed) ? parsed : 0;
};

const hasDashboardAssignedCommission = (reservation = {}) => {
	const commissionStatus = String(reservation?.commissionStatus || "")
		.trim()
		.toLowerCase();
	return (
		moneyNumber(reservation?.commission) > 0 ||
		moneyNumber(reservation?.financial_cycle?.commissionAmount) > 0 ||
		reservation?.commissionData?.assigned === true ||
		reservation?.financial_cycle?.commissionAssigned === true ||
		ASSIGNED_COMMISSION_STATUSES.has(commissionStatus)
	);
};

const getDashboardFinancialReasonsLegacy = (reservation = {}) => {
	const cycle = reservation.financial_cycle || {};
	const collectionModel = String(cycle.collectionModel || "").toLowerCase();

	if (!isFinancialCycleRequired(reservation) || !isFinancialCycleOpen(reservation)) {
		return [];
	}

	if (collectionModel === "pms_collected" && !reservation.moneyTransferredToHotel) {
		return [
			makeReason(
				"pms_transfer_pending",
				"PMS collected the payment, but transfer to the hotel is not marked complete.",
				"تم تحصيل المبلغ من النظام، لكن تحويل المبلغ للفندق غير مكتمل."
			),
		];
	}

	if (collectionModel === "hotel_collected" && !reservation.commissionPaid) {
		return [
			makeReason(
				"hotel_commission_pending",
				"Hotel collected the payment, but commission is not marked paid.",
				"الفندق حصل المبلغ، لكن دفع العمولة غير مكتمل."
			),
		];
	}

	if (
		collectionModel === "mixed" &&
		(!reservation.moneyTransferredToHotel || !reservation.commissionPaid)
	) {
		return [
			makeReason(
				"mixed_cycle_pending",
				"Mixed payment cycle still needs reconciliation.",
				"دورة دفع مختلطة ما زالت تحتاج مطابقة مالية."
			),
		];
	}

	return [
		makeReason(
			"financial_cycle_open_after_cutoff",
			"Financial cycle is open.",
			"الدورة المالية مفتوحة."
		),
	];
};

const getDashboardFinancialReasons = (reservation = {}) => {
	const cycle = reservation.financial_cycle || {};
	const collectionModel = String(cycle.collectionModel || "").toLowerCase();
	const statusText = String(reservation.reservation_status || reservation.state || "");
	const totalReviewStatus = String(cycle.totalReviewStatus || "")
		.trim()
		.toLowerCase();
	const commissionApprovalStatus = String(
		reservation?.commissionAgentApproval?.status || ""
	)
		.trim()
		.toLowerCase();

	if (
		!isFinancialCycleRequired(reservation) ||
		EARLY_CLOSED_RESERVATION_STATUS.test(statusText)
	) {
		return [];
	}

	const reasons = [];

	if (/pending[-_\s]?confirmation/i.test(statusText)) {
		reasons.push(
			makeReason(
				"pending_confirmation",
				"Reservation is waiting for the reservation team confirmation.",
				"الحجز ينتظر تأكيد فريق الحجوزات."
			)
		);
	}

	if (
		String(reservation?.pendingConfirmation?.status || "").toLowerCase() ===
			"rejected" ||
		(/rejected/i.test(statusText) && !/finance[-_\s]?rejected/i.test(statusText))
	) {
		const rejectionReason =
			reservation?.pendingConfirmation?.rejectionReason ||
			reservation?.agentDecisionSnapshot?.reason ||
			"Reservation team rejected it and the agent must update it.";
		reasons.push(
			makeReason(
				"pending_rejected",
				`Reservation team rejected it: ${rejectionReason}`,
				`رفض فريق الحجوزات الحجز: ${rejectionReason}`
			)
		);
	}

	if (/pending[-_\s]?finance[-_\s]?review/i.test(statusText)) {
		reasons.push(
			makeReason(
				"finance_review_pending",
				"Reservation was accepted by reservations and is waiting for finance review.",
				"الحجز مقبول من قسم الحجوزات وينتظر مراجعة المالية."
			)
		);
	}

	if (
		/pending[-_\s]?agent[-_\s]?commission[-_\s]?approval/i.test(statusText) ||
		commissionApprovalStatus === "pending"
	) {
		reasons.push(
			makeReason(
				"agent_commission_pending",
				"Finance marked commission as paid; the agent still needs to approve it.",
				"تم تحديد العمولة كمدفوعة ويجب أن يوافق الوكيل عليها."
			)
		);
	}

	if (
		/finance[-_\s]?rejected/i.test(statusText) ||
		totalReviewStatus === "rejected"
	) {
		reasons.push(
			makeReason(
				"finance_total_rejected",
				`Finance rejected the total amount${cycle.totalRejectionReason ? `: ${cycle.totalRejectionReason}` : "."}`,
				`رفضت المالية المبلغ الإجمالي${cycle.totalRejectionReason ? `: ${cycle.totalRejectionReason}` : "."}`
			)
		);
	}

	if (commissionApprovalStatus === "rejected") {
		reasons.push(
			makeReason(
				"agent_commission_rejected",
				`Agent rejected the commission status${reservation?.commissionAgentApproval?.rejectionReason ? `: ${reservation.commissionAgentApproval.rejectionReason}` : "."}`,
				`رفض الوكيل حالة العمولة${reservation?.commissionAgentApproval?.rejectionReason ? `: ${reservation.commissionAgentApproval.rejectionReason}` : "."}`
			)
		);
	}

	if (!hasDashboardAssignedCommission(reservation)) {
		reasons.push(
			makeReason(
				"commission_missing",
				"Finance has not assigned or reviewed commission yet.",
				"لم تحدد المالية العمولة أو تراجعها بعد."
			)
		);
	}

	if (collectionModel === "pms_collected" && !reservation.moneyTransferredToHotel) {
		reasons.push(
			makeReason(
				"pms_transfer_pending",
				"PMS collected the payment, but transfer to the hotel is not marked complete.",
				"تم تحصيل المبلغ من النظام، لكن تحويل المبلغ للفندق غير مكتمل."
			)
		);
	}

	if (collectionModel === "hotel_collected" && !reservation.commissionPaid) {
		reasons.push(
			makeReason(
				"hotel_commission_pending",
				"Hotel collected the payment, but commission is not marked paid.",
				"الفندق حصل المبلغ، لكن دفع العمولة غير مكتمل."
			)
		);
	}

	if (
		collectionModel === "mixed" &&
		(!reservation.moneyTransferredToHotel || !reservation.commissionPaid)
	) {
		reasons.push(
			makeReason(
				"mixed_cycle_pending",
				"Mixed payment cycle still needs reconciliation.",
				"دورة دفع مختلطة ما زالت تحتاج مطابقة مالية."
			)
		);
	}

	if (collectionModel === "agent_wallet") {
		reasons.push(
			makeReason(
				"agent_wallet_reconciliation_open",
				"Hotel amount is covered by the agent wallet; finance still needs to close commission and reconciliation.",
				"المبلغ مغطى من محفظة الوكيل وتحتاج المالية إلى إغلاق العمولة والمطابقة."
			)
		);
	}

	if (isFinancialCycleOpen(reservation) && !reasons.length) {
		reasons.push(
			makeReason(
				"financial_cycle_open_after_cutoff",
				"Financial cycle is open.",
				"الدورة المالية مفتوحة."
			)
		);
	}

	if (
		/checked[-_\s]?out|early[-_\s]?checked[-_\s]?out/i.test(statusText) &&
		isFinancialCycleOpen(reservation)
	) {
		reasons.push(
			makeReason(
				"checked_out_finance_open",
				"Guest is checked out, but payment, commission, or wallet reconciliation is still open.",
				"غادر الضيف لكن تسوية الدفع أو العمولة أو المحفظة ما زالت مفتوحة."
			)
		);
	}

	if (!isFinancialCycleOpen(reservation) && !reasons.length) {
		return [];
	}

	return compactReasons(reasons);
};

const getOperationalDueReservationReasons = (reservation = {}) => {
	const reasons = [];

	if (isDueCheckoutWithoutDoneStatus(reservation)) {
		const status = reservation.reservation_status || "confirmed";
		reasons.push(
			makeReason(
				"checkout_due_status_open",
				`Checkout date is today or older, but reservation status is still ${status}.`,
				`تاريخ المغادرة اليوم أو أقدم، لكن حالة الحجز ما زالت ${status}.`
			)
		);
	}

	return reasons;
};

const getDashboardOpenReservationReasons = (reservation = {}) => {
	const reasons = getOperationalDueReservationReasons(reservation);

	return compactReasons(
		reasons.length
			? reasons
			: [
					makeReason(
						"open_follow_up",
						"Reservation needs follow-up before it can be closed.",
						"الحجز يحتاج متابعة قبل إغلاقه."
					),
			  ]
	);
};

const getDashboardIncompleteReservationReasons = (reservation = {}) => {
	const reasons = [...getOperationalDueReservationReasons(reservation)];
	const financialReasons = getDashboardFinancialReasons(reservation);

	if (financialReasons.length) {
		reasons.push(...financialReasons);
	}

	return compactReasons(
		reasons.length
			? reasons
			: [
					makeReason(
						"incomplete_follow_up",
						"Reservation needs operational or financial review before completion.",
						"الحجز يحتاج مراجعة تشغيلية أو مالية قبل الإغلاق."
					),
			  ]
	);
};

const attachReasonFields = (reservation, reasonGetter) => {
	const reasons = reasonGetter(reservation);
	return {
		...reservation,
		reasonDetails: reasons,
		reasons: reasons.map((reason) => reason.en),
		reasonsArabic: reasons.map((reason) => reason.ar),
		reason: serializeReasonText(reasons, "en"),
		reasonArabic: serializeReasonText(reasons, "ar"),
	};
};

const toValidObjectIds = (values = []) =>
	[
		...new Set(
			(Array.isArray(values) ? values : [values])
				.map(normalizeId)
				.filter((id) => mongoose.Types.ObjectId.isValid(id))
		),
	].map((id) => mongoose.Types.ObjectId(id));

const getDashboardAccessibleHotels = async (user = {}) => {
	if (!user?._id) return [];

	if (Number(user.role) === 1000 || isConfiguredSuperAdmin(user)) {
		return HotelDetails.aggregate([
			{ $match: {} },
			{ $project: DASHBOARD_HOTEL_STATS_PROJECT },
		]).exec();
	}

	const scopedHotelIds = toValidObjectIds([
		user.hotelIdWork,
		...(Array.isArray(user.hotelIdsOwner) ? user.hotelIdsOwner : []),
		...(Array.isArray(user.hotelsToSupport) ? user.hotelsToSupport : []),
	]);
	const filters = [];

	if (Number(user.role) === 2000 && mongoose.Types.ObjectId.isValid(user._id)) {
		filters.push({ belongsTo: mongoose.Types.ObjectId(user._id) });
	}

	if (scopedHotelIds.length) {
		filters.push({ _id: { $in: scopedHotelIds } });
	}

	if (!filters.length) return [];

	const hotels = await HotelDetails.aggregate([
		{ $match: filters.length === 1 ? filters[0] : { $or: filters } },
		{ $project: DASHBOARD_HOTEL_STATS_PROJECT },
	]).exec();

	return hotels.filter((hotel) => canViewHotelStats(user, hotel));
};

exports.hotelDetailsById = (req, res, next, id) => {
	if (!mongoose.Types.ObjectId.isValid(id)) {
		return res.status(400).json({ error: "Invalid hotel ID" });
	}

	const summaryRequest = isHotelDetailsSummaryRequest(req);
	const reservationDetailsRequest = isHotelDetailsReservationDetailsRequest(req);
	const managementRequest = isHotelDetailsManagementRequest(req);
	const reservationWorkspaceRequest =
		isHotelDetailsReservationWorkspaceRequest(req);
	const query = HotelDetails.findById(id);
	if (summaryRequest) {
		query.select(HOTEL_DETAILS_SUMMARY_SELECT).lean();
	}
	if (reservationDetailsRequest) {
		query.select(HOTEL_DETAILS_RESERVATION_DETAILS_SELECT).lean();
	}
	if (managementRequest) {
		query
			.select(
				includesPricingRowsRequest(req)
					? HOTEL_DETAILS_MANAGEMENT_SELECT
					: HOTEL_DETAILS_MANAGEMENT_COMPACT_SELECT
			)
			.lean();
	}
	if (reservationWorkspaceRequest) {
		query.select(HOTEL_DETAILS_RESERVATION_WORKSPACE_SELECT).lean();
	}

	query.exec((err, hotelDetails) => {
		if (err || !hotelDetails) {
			return res.status(400).json({
				error: "Hotel details were not found",
			});
		}
		const isLeanPayload =
			summaryRequest ||
			reservationDetailsRequest ||
			managementRequest ||
			reservationWorkspaceRequest;
		req.hotelDetails = isLeanPayload
			? {
					...hotelDetails,
					isHotelDetailsSummary: summaryRequest,
					isReservationDetailsHotel: reservationDetailsRequest,
					isHotelDetailsManagement: managementRequest,
					isReservationWorkspaceHotel: reservationWorkspaceRequest,
			  }
			: hotelDetails;
		next();
	});
};

exports.create = (req, res) => {
	const hotelDetails = new HotelDetails({
		...req.body,
		hotelPolicyQA: sanitizeHotelPolicyQA(req.body?.hotelPolicyQA),
	});
	hotelDetails.save((err, data) => {
		if (err) {
			console.log(err, "err");
			return res.status(400).json({
				error: "Cannot create hotel details",
			});
		}
		res.json({ data });
	});
};

exports.read = async (req, res) => {
	try {
		let viewer = null;
		if (req.auth?._id && mongoose.Types.ObjectId.isValid(req.auth._id)) {
			viewer = await User.findById(req.auth._id).lean().exec();
		}
		return res.json(sanitizeAgentRoomOverridesForViewer(req.hotelDetails, viewer));
	} catch (error) {
		console.log("hotel details read error:", error);
		return res
			.status(500)
			.json({ error: "Could not load hotel details securely." });
	}
};

exports.hotelGeneralStats = async (req, res) => {
	try {
		const { hotelId } = req.params;

		if (!mongoose.Types.ObjectId.isValid(hotelId)) {
			return res.status(400).json({ error: "Invalid hotel ID" });
		}

		const hotelObjectId = mongoose.Types.ObjectId(hotelId);
		const hotel = await HotelDetails.findById(hotelObjectId).lean().exec();

		if (!hotel) {
			return res.status(404).json({ error: "Hotel details were not found" });
		}

		if (!canViewHotelStats(req.profile, hotel)) {
			return res
				.status(403)
				.json({ error: "You do not have access to these hotel stats" });
		}

		const now = new Date();
		const startOfDay = new Date(now);
		startOfDay.setHours(0, 0, 0, 0);
		const endOfDay = new Date(now);
		endOfDay.setHours(23, 59, 59, 999);
		const period = executiveDateRange(req.query?.range || "all");
		const dateBy = normalizeExecutiveDateField(req.query?.dateBy || "createdAt");
		const actor = withHotelManagementSourceViewContext(req.profile, req);
		const reservationStatsFilter = buildExecutiveReservationFilterForHotels(
			[hotelObjectId],
			{ range: period.range, dateBy }
		);
		addHotelManagementReservationVisibilityToFilter(
			reservationStatsFilter,
			actor
		);

		const dashboardOpenFilter =
			buildDashboardOpenReservationFilter(hotelObjectId);
		const dashboardIncompleteFilter =
			buildDashboardIncompleteReservationFilter(hotelObjectId);
		addHotelManagementReservationVisibilityToFilter(
			dashboardOpenFilter,
			actor
		);
		addHotelManagementReservationVisibilityToFilter(
			dashboardIncompleteFilter,
			actor
		);
		const todayReservationFilter = {
			hotelId: hotelObjectId,
			checkin_date: { $lte: endOfDay },
			checkout_date: { $gte: startOfDay },
			reservation_status: { $not: DONE_RESERVATION_STATUS },
			...buildPendingConfirmationExclusionFilter(),
			...buildExcludePendingOtaReviewFilter(),
		};
		addHotelManagementReservationVisibilityToFilter(
			todayReservationFilter,
			actor
		);
		const [rooms, totalReservations, openReservations, uncompleted, sources] =
			await Promise.all([
				Rooms.find({ hotelId: hotelObjectId })
					.select("_id active activeRoom cleanRoom room_type display_name")
					.lean()
					.exec(),
				Reservations.countDocuments(reservationStatsFilter),
				Reservations.countDocuments(dashboardOpenFilter),
				Reservations.countDocuments(dashboardIncompleteFilter),
				Reservations.aggregate([
					{ $match: reservationStatsFilter },
					{
						$group: {
							_id: {
								$ifNull: ["$booking_source", "Unknown"],
							},
							count: { $sum: 1 },
						},
					},
					{ $sort: { count: -1, _id: 1 } },
					{ $limit: 5 },
				]),
			]);

		const todayReservations = await Reservations.find(todayReservationFilter)
			.select("roomId reservation_status")
			.lean()
			.exec();

		const physicalRoomsTotal = rooms.length;
		const declaredRoomsTotal = getDeclaredRoomsTotal(hotel);
		const totalRooms = physicalRoomsTotal || declaredRoomsTotal;
		const activeRoomsList = rooms.filter(
			(room) => room.active !== false && room.activeRoom !== false
		);
		const activeRooms = physicalRoomsTotal
			? activeRoomsList.length
			: declaredRoomsTotal;
		const activeRoomIds = new Set(activeRoomsList.map((room) => normalizeId(room._id)));
		const occupiedRoomIds = new Set();

		todayReservations.forEach((reservation) => {
			extractReservationRoomIds(reservation.roomId).forEach((id) => {
				if (!activeRoomIds.size || activeRoomIds.has(id)) {
					occupiedRoomIds.add(id);
				}
			});
		});

		const occupiedRooms = occupiedRoomIds.size;
		const availableRooms = Math.max(activeRooms - occupiedRooms, 0);
		const inactiveRooms = Math.max(totalRooms - activeRooms, 0);

		const photosDone =
			Number(hotel?.hotelPhotosCount || 0) > 0 || !!hotel?.hotelPhotos?.length;
		const roomsDone =
			Number(hotel?.roomCountDetailsCount || 0) > 0 ||
			!!hotel?.roomCountDetails?.length;
		const locationDone =
			Array.isArray(hotel?.location?.coordinates) &&
			hotel.location.coordinates[0] !== 0 &&
			hotel.location.coordinates[1] !== 0;
		const dataDone = Boolean(
			hotel?.aboutHotel || hotel?.aboutHotelArabic || hotel?.overallRoomsCount
		);
		const bankDone =
			Number(hotel?.paymentSettingsCount || 0) > 0 ||
			!!hotel?.paymentSettings?.length;
		const settingsDone = roomsDone && photosDone && locationDone && dataDone;
		const activationReady = roomsDone && photosDone && locationDone && dataDone;

		return res.json({
			hotelId: normalizeId(hotel._id),
			asOf: now,
			period: {
				reservationsFrom: period.from,
				reservationsTo: period.to || now,
				range: period.range,
				dateBy,
			},
			setup: {
				roomsDone,
				photosDone,
				locationDone,
				dataDone,
				bankDone,
				settingsDone,
				activationReady,
				activeHotel:
					hotel.activateHotel === true && hotel.xHotelProActive !== false,
				ownerActivatedHotel: hotel.activateHotel === true,
				xHotelProActive: hotel.xHotelProActive !== false,
			},
			stats: {
				totalRooms,
				activeRooms,
				availableRooms,
				occupiedRooms,
				inactiveRooms,
				totalReservations,
				activeReservations: todayReservations.length,
				nonDoneReservations: openReservations,
				openReservations,
				uncompletedReservations: uncompleted,
				bookingSources: shouldMaskHotelManagementReservationSource(actor)
					? maskBookingSourceSummaryRowsForHotelManagement(
							sources.map((source) => ({
								source: source._id || "Unknown",
								count: source.count || 0,
							}))
					  )
					: sources.map((source) => ({
							source: source._id || "Unknown",
							count: source.count || 0,
					  })),
			},
		});
	} catch (err) {
		console.error("hotelGeneralStats error:", err);
		return res.status(500).json({ error: "Could not load hotel stats" });
	}
};

const groupedCountMap = (rows = []) => {
	const map = new Map();
	rows.forEach((row) => {
		map.set(normalizeId(row._id), Number(row.count || 0));
	});
	return map;
};

const groupedSourceMap = (rows = []) => {
	const map = new Map();
	rows.forEach((row) => {
		const hotelId = normalizeId(row._id?.hotelId);
		if (!hotelId) return;
		if (!map.has(hotelId)) map.set(hotelId, []);
		map.get(hotelId).push({
			source: row._id?.source || "Unknown",
			count: Number(row.count || 0),
		});
	});
	map.forEach((sources, hotelId) => {
		sources.sort((left, right) => {
			if (right.count !== left.count) return right.count - left.count;
			return String(left.source).localeCompare(String(right.source));
		});
		map.set(hotelId, sources.slice(0, 5));
	});
	return map;
};

const getManagerDashboardStatsBulkPayload = async ({
	actor,
	range = "all",
	dateBy = "createdAt",
} = {}) => {
	const period = executiveDateRange(range);
	const normalizedDateBy = normalizeExecutiveDateField(dateBy);
	const hotels = await getDashboardAccessibleHotels(actor);
	const hotelObjectIds = hotels
		.map((hotel) => hotel._id)
		.filter(Boolean)
		.map((id) => mongoose.Types.ObjectId(id));
	const now = new Date();

	if (!hotelObjectIds.length) {
		const emptySummary = {
			asOf: now,
			period: {
				reservationsFrom: null,
				reservationsTo: now,
				range: period.range,
				dateBy: normalizedDateBy,
			},
			stats: {
				totalHotels: 0,
				totalRooms: 0,
				availableRooms: 0,
				reservationsPastThreeMonths: 0,
				incompleteReservations: 0,
			},
		};
		return {
			...emptySummary,
			summary: emptySummary,
			hotelStatsById: {},
			hotels: [],
		};
	}

	const startOfDay = new Date(now);
	startOfDay.setHours(0, 0, 0, 0);
	const endOfDay = new Date(now);
	endOfDay.setHours(23, 59, 59, 999);

	const todayReservationFilter = {
		hotelId: { $in: hotelObjectIds },
		checkin_date: { $lte: endOfDay },
		checkout_date: { $gte: startOfDay },
		reservation_status: { $not: DONE_RESERVATION_STATUS },
		...buildPendingConfirmationExclusionFilter(),
		...buildExcludePendingOtaReviewFilter(),
	};
	const recentReservationFilter = buildExecutiveReservationFilterForHotels(
		hotelObjectIds,
		{
			range: period.range,
			dateBy: normalizedDateBy,
		}
	);
	const openReservationFilter =
		buildDashboardOpenReservationFilterForHotels(hotelObjectIds);
	const incompleteReservationFilter =
		buildDashboardIncompleteReservationFilterForHotels(hotelObjectIds);

	addHotelManagementReservationVisibilityToFilter(
		todayReservationFilter,
		actor
	);
	addHotelManagementReservationVisibilityToFilter(
		recentReservationFilter,
		actor
	);
	addHotelManagementReservationVisibilityToFilter(
		openReservationFilter,
		actor
	);
	addHotelManagementReservationVisibilityToFilter(
		incompleteReservationFilter,
		actor
	);

	const [
		rooms,
		todayReservations,
		recentCounts,
		openCounts,
		incompleteCounts,
		sourceCounts,
	] = await Promise.all([
		Rooms.find({ hotelId: { $in: hotelObjectIds } })
			.select("_id hotelId active activeRoom cleanRoom room_type display_name")
			.lean()
			.exec(),
		Reservations.find(todayReservationFilter)
			.select("hotelId roomId reservation_status")
			.lean()
			.exec(),
		Reservations.aggregate([
			{ $match: recentReservationFilter },
			{ $group: { _id: "$hotelId", count: { $sum: 1 } } },
		]),
		Reservations.aggregate([
			{ $match: openReservationFilter },
			{ $group: { _id: "$hotelId", count: { $sum: 1 } } },
		]),
		Reservations.aggregate([
			{ $match: incompleteReservationFilter },
			{ $group: { _id: "$hotelId", count: { $sum: 1 } } },
		]),
		Reservations.aggregate([
			{ $match: recentReservationFilter },
			{
				$group: {
					_id: {
						hotelId: "$hotelId",
						source: { $ifNull: ["$booking_source", "Unknown"] },
					},
					count: { $sum: 1 },
				},
			},
		]),
	]);

	const roomsByHotel = new Map();
	rooms.forEach((room) => {
		const hotelId = normalizeId(room.hotelId);
		if (!roomsByHotel.has(hotelId)) roomsByHotel.set(hotelId, []);
		roomsByHotel.get(hotelId).push(room);
	});

	const activeReservationsByHotel = new Map();
	const occupiedByHotel = new Map();
	todayReservations.forEach((reservation) => {
		const hotelId = normalizeId(reservation.hotelId);
		activeReservationsByHotel.set(
			hotelId,
			Number(activeReservationsByHotel.get(hotelId) || 0) + 1
		);
		if (!occupiedByHotel.has(hotelId)) occupiedByHotel.set(hotelId, new Set());
		const occupiedSet = occupiedByHotel.get(hotelId);
		extractReservationRoomIds(reservation.roomId).forEach((roomId) => {
			if (roomId) occupiedSet.add(roomId);
		});
	});

	const recentByHotel = groupedCountMap(recentCounts);
	const openByHotel = groupedCountMap(openCounts);
	const incompleteByHotel = groupedCountMap(incompleteCounts);
	const sourcesByHotel = groupedSourceMap(sourceCounts);
	const hotelStatsById = {};
	let totalRoomsAll = 0;
	let availableRoomsAll = 0;
	let totalReservationsAll = 0;
	let incompleteReservationsAll = 0;

	hotels.forEach((hotel) => {
		const hotelId = normalizeId(hotel._id);
		const hotelRooms = roomsByHotel.get(hotelId) || [];
		const physicalRoomsTotal = hotelRooms.length;
		const declaredRoomsTotal = getDeclaredRoomsTotal(hotel);
		const totalRooms = physicalRoomsTotal || declaredRoomsTotal;
		const activeRoomsList = hotelRooms.filter(
			(room) => room.active !== false && room.activeRoom !== false
		);
		const activeRooms = physicalRoomsTotal
			? activeRoomsList.length
			: declaredRoomsTotal;
		const activeRoomIds = new Set(
			activeRoomsList.map((room) => normalizeId(room._id))
		);
		const rawOccupied = occupiedByHotel.get(hotelId) || new Set();
		const occupiedRooms = activeRoomIds.size
			? [...rawOccupied].filter((roomId) => activeRoomIds.has(roomId)).length
			: Math.min(rawOccupied.size, activeRooms);
		const availableRooms = Math.max(activeRooms - occupiedRooms, 0);
		const inactiveRooms = Math.max(totalRooms - activeRooms, 0);
		const totalReservations = Number(recentByHotel.get(hotelId) || 0);
		const openReservations = Number(openByHotel.get(hotelId) || 0);
		const uncompleted = Number(incompleteByHotel.get(hotelId) || 0);
		const photosDone =
			Number(hotel?.hotelPhotosCount || 0) > 0 || !!hotel?.hotelPhotos?.length;
		const roomsDone =
			Number(hotel?.roomCountDetailsCount || 0) > 0 ||
			!!hotel?.roomCountDetails?.length;
		const locationDone =
			Array.isArray(hotel?.location?.coordinates) &&
			hotel.location.coordinates[0] !== 0 &&
			hotel.location.coordinates[1] !== 0;
		const dataDone = Boolean(
			hotel?.aboutHotel || hotel?.aboutHotelArabic || hotel?.overallRoomsCount
		);
		const bankDone =
			Number(hotel?.paymentSettingsCount || 0) > 0 ||
			!!hotel?.paymentSettings?.length;
		const bookingSources = sourcesByHotel.get(hotelId) || [];
		const statsPayload = {
			hotelId,
			asOf: now,
			period: {
				reservationsFrom: period.from,
				reservationsTo: period.to || now,
				range: period.range,
				dateBy: normalizedDateBy,
			},
			setup: {
				roomsDone,
				photosDone,
				locationDone,
				dataDone,
				bankDone,
				settingsDone: roomsDone && photosDone && locationDone && dataDone,
				activationReady: roomsDone && photosDone && locationDone && dataDone,
				activeHotel:
					hotel.activateHotel === true && hotel.xHotelProActive !== false,
				ownerActivatedHotel: hotel.activateHotel === true,
				xHotelProActive: hotel.xHotelProActive !== false,
			},
			stats: {
				totalRooms,
				activeRooms,
				availableRooms,
				occupiedRooms,
				inactiveRooms,
				totalReservations,
				activeReservations: Number(activeReservationsByHotel.get(hotelId) || 0),
				nonDoneReservations: openReservations,
				openReservations,
				uncompletedReservations: uncompleted,
				bookingSources: shouldMaskHotelManagementReservationSource(actor)
					? maskBookingSourceSummaryRowsForHotelManagement(bookingSources)
					: bookingSources,
			},
		};
		hotelStatsById[hotelId] = statsPayload;
		totalRoomsAll += totalRooms;
		availableRoomsAll += availableRooms;
		totalReservationsAll += totalReservations;
		incompleteReservationsAll += uncompleted;
	});

	const summary = {
		asOf: now,
		period: {
			reservationsFrom: period.from,
			reservationsTo: period.to || now,
			range: period.range,
			dateBy: normalizedDateBy,
		},
		stats: {
			totalHotels: hotels.length,
			totalRooms: totalRoomsAll,
			availableRooms: availableRoomsAll,
			reservationsPastThreeMonths: totalReservationsAll,
			incompleteReservations: incompleteReservationsAll,
		},
	};

	return {
		...summary,
		summary,
		hotelStatsById,
		hotels: Object.values(hotelStatsById),
	};
};

exports.managerDashboardStatsBulk = async (req, res) => {
	try {
		const payload = await getManagerDashboardStatsBulkPayload({
			actor: req.profile,
			range: req.query?.range || "all",
			dateBy: req.query?.dateBy || "createdAt",
		});
		return res.json(payload);
	} catch (err) {
		console.error("managerDashboardStatsBulk error:", err);
		return res.status(500).json({ error: "Could not load dashboard stats" });
	}
};

exports.managerExecutiveSummary = async (req, res) => {
	try {
		const payload = await getManagerDashboardStatsBulkPayload({
			actor: req.profile,
			range: req.query?.range || "all",
			dateBy: req.query?.dateBy || "createdAt",
		});
		return res.json(payload.summary || payload);
	} catch (err) {
		console.error("managerExecutiveSummary error:", err);
		return res.status(500).json({ error: "Could not load executive summary" });
	}
};

exports.managerIncompleteReservations = async (req, res) => {
	try {
		const actor = withHotelManagementSourceViewContext(req.profile, req);
		const hotels = await getDashboardAccessibleHotels(req.profile);
		const hotelObjectIds = hotels
			.map((hotel) => hotel._id)
			.filter(Boolean)
			.map((id) => mongoose.Types.ObjectId(id));

		const hotelNameById = new Map(
			hotels.map((hotel) => [normalizeId(hotel._id), hotel.hotelName || "Hotel"])
		);
		const hotelOwnerById = new Map(
			hotels.map((hotel) => [normalizeId(hotel._id), normalizeId(hotel.belongsTo)])
		);

		if (!hotelObjectIds.length) {
			return res.json({
				page: 1,
				limit: 0,
				total: 0,
				pages: 0,
				reservations: [],
			});
		}

		const {
			page = 1,
			limit = 10,
			search = "",
			sortBy = "booked_at",
			sortOrder = "asc",
			dateBy = "booked_at",
			dateFrom = "",
			dateTo = "",
			exportAll = "",
		} = req.query || {};

		const currentPage = Math.max(parseInt(page, 10) || 1, 1);
		const pageSize = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 50);
		const shouldExportAll = ["1", "true", "yes", "all"].includes(
			String(exportAll).toLowerCase()
		);
		const allowedSorts = ["booked_at", "checkin_date", "checkout_date"];
		const sortField = allowedSorts.includes(sortBy) ? sortBy : "booked_at";
		const dateField = allowedSorts.includes(dateBy) ? dateBy : "booked_at";
		const direction = String(sortOrder).toLowerCase() === "desc" ? -1 : 1;

		const baseIncompleteFilter =
			buildDashboardIncompleteReservationFilterForHotels(hotelObjectIds);
		addHotelManagementReservationVisibilityToFilter(
			baseIncompleteFilter,
			req.profile
		);
		const filters = [baseIncompleteFilter];
		const trimmedSearch = String(search || "").trim();

		if (trimmedSearch) {
			const searchRegex = new RegExp(
				trimmedSearch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
				"i"
			);
			const matchingHotelIds = hotels
				.filter((hotel) => searchRegex.test(String(hotel.hotelName || "")))
				.map((hotel) => hotel._id)
				.filter(Boolean)
				.map((id) => mongoose.Types.ObjectId(id));
			const searchConditions = [
				{ confirmation_number: searchRegex },
				{ "customer_details.name": searchRegex },
			];
			if (matchingHotelIds.length) {
				searchConditions.push({ hotelId: { $in: matchingHotelIds } });
			}
			filters.push({
				$or: searchConditions,
			});
		}

		if (dateFrom || dateTo) {
			const dateRange = {};
			if (dateFrom) {
				const from = new Date(`${dateFrom}T00:00:00.000Z`);
				if (!Number.isNaN(from.getTime())) dateRange.$gte = from;
			}
			if (dateTo) {
				const to = new Date(`${dateTo}T23:59:59.999Z`);
				if (!Number.isNaN(to.getTime())) dateRange.$lte = to;
			}
			if (Object.keys(dateRange).length) {
				filters.push({ [dateField]: dateRange });
			}
		}

		const filter = filters.length > 1 ? { $and: filters } : filters[0];
		let reservationsQuery = Reservations.find(filter)
			.select(
				"hotelId confirmation_number customer_details.name booking_source booked_at createdAt checkin_date checkout_date total_amount sub_total adminPricing adminPricingVisibility pickedRoomsType pickedRoomsPricing payment reservation_status state pendingConfirmation agentDecisionSnapshot financial_cycle commission commissionStatus commissionData commissionPaid commissionAgentApproval moneyTransferredToHotel createdByUserId createdBy orderTakeId orderTaker orderTakenAt"
			)
			.sort({ [sortField]: direction, _id: 1 })
			.lean();

		if (!shouldExportAll) {
			reservationsQuery = reservationsQuery
				.skip((currentPage - 1) * pageSize)
				.limit(pageSize);
		}

		const [total, reservations] = await Promise.all([
			Reservations.countDocuments(filter),
			reservationsQuery.exec(),
		]);

		const hotelVisibleReservations =
			sanitizeReservationAuditLogsCollectionForViewer(reservations, actor);

		return res.json({
			page: shouldExportAll ? 1 : currentPage,
			limit: shouldExportAll ? total : pageSize,
			total,
			pages: shouldExportAll ? 1 : Math.ceil(total / pageSize),
			reservations: hotelVisibleReservations.map((reservation) =>
				attachReasonFields(
					{
						...reservation,
						reservationId: reservation._id,
						hotelName:
							hotelNameById.get(normalizeId(reservation.hotelId)) || "Hotel",
						hotelOwnerId:
							hotelOwnerById.get(normalizeId(reservation.hotelId)) ||
							normalizeId(req.profile?._id),
					},
					getDashboardIncompleteReservationReasons
				)
			),
		});
	} catch (err) {
		console.error("managerIncompleteReservations error:", err);
		return res
			.status(500)
			.json({ error: "Could not load incomplete reservations" });
	}
};

exports.hotelOpenReservations = async (req, res) => {
	try {
		const actor = withHotelManagementSourceViewContext(req.profile, req);
		const { hotelId } = req.params;
		if (!mongoose.Types.ObjectId.isValid(hotelId)) {
			return res.status(400).json({ error: "Invalid hotel ID" });
		}

		const hotelObjectId = mongoose.Types.ObjectId(hotelId);
		const hotel = await HotelDetails.findById(hotelObjectId).lean().exec();
		if (!hotel) {
			return res.status(404).json({ error: "Hotel details were not found" });
		}

		if (!canViewHotelStats(req.profile, hotel)) {
			return res
				.status(403)
				.json({ error: "You do not have access to these reservations" });
		}

		const {
			page = 1,
			limit = 10,
			search = "",
			sortBy = "booked_at",
			sortOrder = "asc",
			dateBy = "booked_at",
			dateFrom = "",
			dateTo = "",
			exportAll = "",
		} = req.query || {};

		const currentPage = Math.max(parseInt(page, 10) || 1, 1);
		const pageSize = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 30);
		const shouldExportAll = ["1", "true", "yes", "all"].includes(
			String(exportAll).toLowerCase()
		);
		const allowedSorts = ["booked_at", "checkin_date", "checkout_date"];
		const sortField = allowedSorts.includes(sortBy) ? sortBy : "booked_at";
		const dateField = allowedSorts.includes(dateBy) ? dateBy : "booked_at";
		const direction = String(sortOrder).toLowerCase() === "desc" ? -1 : 1;

		const baseOpenFilter = buildDashboardOpenReservationFilter(hotelObjectId);
		addHotelManagementReservationVisibilityToFilter(baseOpenFilter, req.profile);
		const filters = [baseOpenFilter];
		const trimmedSearch = String(search || "").trim();

		if (trimmedSearch) {
			const searchRegex = new RegExp(
				trimmedSearch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
				"i"
			);
			filters.push({
				$or: [
					{ confirmation_number: searchRegex },
					{ "customer_details.name": searchRegex },
				],
			});
		}

		if (dateFrom || dateTo) {
			const dateRange = {};
			if (dateFrom) {
				const from = new Date(`${dateFrom}T00:00:00.000Z`);
				if (!Number.isNaN(from.getTime())) dateRange.$gte = from;
			}
			if (dateTo) {
				const to = new Date(`${dateTo}T23:59:59.999Z`);
				if (!Number.isNaN(to.getTime())) dateRange.$lte = to;
			}
			if (Object.keys(dateRange).length) {
				filters.push({ [dateField]: dateRange });
			}
		}

		const filter = filters.length > 1 ? { $and: filters } : filters[0];
		let reservationsQuery = Reservations.find(filter)
			.select(
				"confirmation_number customer_details.name booking_source booked_at checkin_date checkout_date total_amount sub_total adminPricing adminPricingVisibility pickedRoomsType pickedRoomsPricing payment reservation_status state pendingConfirmation agentDecisionSnapshot financial_cycle commission commissionStatus commissionData commissionPaid commissionAgentApproval moneyTransferredToHotel createdByUserId createdBy orderTakeId orderTaker orderTakenAt"
			)
			.sort({ [sortField]: direction, _id: 1 })
			.lean();
		if (!shouldExportAll) {
			reservationsQuery = reservationsQuery
				.skip((currentPage - 1) * pageSize)
				.limit(pageSize);
		}

		const [total, reservations] = await Promise.all([
			Reservations.countDocuments(filter),
			reservationsQuery.exec(),
		]);

		const hotelVisibleReservations =
			sanitizeReservationAuditLogsCollectionForViewer(reservations, actor);

		return res.json({
			page: shouldExportAll ? 1 : currentPage,
			limit: shouldExportAll ? total : pageSize,
			total,
			pages: shouldExportAll ? 1 : Math.ceil(total / pageSize),
			reservations: hotelVisibleReservations.map((reservation) =>
				attachReasonFields(reservation, getDashboardOpenReservationReasons)
			),
		});
	} catch (err) {
		console.error("hotelOpenReservations error:", err);
		return res.status(500).json({ error: "Could not load open reservations" });
	}
};

exports.hotelIncompleteReservations = async (req, res) => {
	try {
		const actor = withHotelManagementSourceViewContext(req.profile, req);
		const { hotelId } = req.params;
		if (!mongoose.Types.ObjectId.isValid(hotelId)) {
			return res.status(400).json({ error: "Invalid hotel ID" });
		}

		const hotelObjectId = mongoose.Types.ObjectId(hotelId);
		const hotel = await HotelDetails.findById(hotelObjectId).lean().exec();
		if (!hotel) {
			return res.status(404).json({ error: "Hotel details were not found" });
		}

		if (!canViewHotelStats(req.profile, hotel)) {
			return res
				.status(403)
				.json({ error: "You do not have access to these reservations" });
		}

		const {
			page = 1,
			limit = 10,
			search = "",
			sortBy = "booked_at",
			sortOrder = "asc",
			dateBy = "booked_at",
			dateFrom = "",
			dateTo = "",
			exportAll = "",
		} = req.query || {};

		const currentPage = Math.max(parseInt(page, 10) || 1, 1);
		const pageSize = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 30);
		const shouldExportAll = ["1", "true", "yes", "all"].includes(
			String(exportAll).toLowerCase()
		);
		const allowedSorts = ["booked_at", "checkin_date", "checkout_date"];
		const sortField = allowedSorts.includes(sortBy) ? sortBy : "booked_at";
		const dateField = allowedSorts.includes(dateBy) ? dateBy : "booked_at";
		const direction = String(sortOrder).toLowerCase() === "desc" ? -1 : 1;

		const baseIncompleteFilter =
			buildDashboardIncompleteReservationFilter(hotelObjectId);
		addHotelManagementReservationVisibilityToFilter(
			baseIncompleteFilter,
			req.profile
		);
		const filters = [baseIncompleteFilter];
		const trimmedSearch = String(search || "").trim();

		if (trimmedSearch) {
			const searchRegex = new RegExp(
				trimmedSearch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
				"i"
			);
			filters.push({
				$or: [
					{ confirmation_number: searchRegex },
					{ "customer_details.name": searchRegex },
				],
			});
		}

		if (dateFrom || dateTo) {
			const dateRange = {};
			if (dateFrom) {
				const from = new Date(`${dateFrom}T00:00:00.000Z`);
				if (!Number.isNaN(from.getTime())) dateRange.$gte = from;
			}
			if (dateTo) {
				const to = new Date(`${dateTo}T23:59:59.999Z`);
				if (!Number.isNaN(to.getTime())) dateRange.$lte = to;
			}
			if (Object.keys(dateRange).length) {
				filters.push({ [dateField]: dateRange });
			}
		}

		const filter = filters.length > 1 ? { $and: filters } : filters[0];
		let reservationsQuery = Reservations.find(filter)
			.select(
				"confirmation_number customer_details.name booking_source booked_at createdAt checkin_date checkout_date total_amount sub_total adminPricing adminPricingVisibility pickedRoomsType pickedRoomsPricing payment reservation_status state pendingConfirmation agentDecisionSnapshot financial_cycle commission commissionStatus commissionData commissionPaid commissionAgentApproval moneyTransferredToHotel createdByUserId createdBy orderTakeId orderTaker orderTakenAt"
			)
			.sort({ [sortField]: direction, _id: 1 })
			.lean();
		if (!shouldExportAll) {
			reservationsQuery = reservationsQuery
				.skip((currentPage - 1) * pageSize)
				.limit(pageSize);
		}

		const [total, reservations] = await Promise.all([
			Reservations.countDocuments(filter),
			reservationsQuery.exec(),
		]);

		const hotelVisibleReservations =
			sanitizeReservationAuditLogsCollectionForViewer(reservations, actor);

		return res.json({
			page: shouldExportAll ? 1 : currentPage,
			limit: shouldExportAll ? total : pageSize,
			total,
			pages: shouldExportAll ? 1 : Math.ceil(total / pageSize),
			reservations: hotelVisibleReservations.map((reservation) =>
				attachReasonFields(
					{
						...reservation,
						reservationId: reservation._id,
					},
					getDashboardIncompleteReservationReasons
				)
			),
		});
	} catch (err) {
		console.error("hotelIncompleteReservations error:", err);
		return res
			.status(500)
			.json({ error: "Could not load incomplete reservations" });
	}
};

const hasRoomIdentity = (room = {}) => {
	const rt = typeof room.roomType === "string" ? room.roomType.trim() : "";
	const dn =
		typeof room.displayName === "string" ? room.displayName.trim() : "";
	return rt.length > 0 && dn.length > 0;
};

const normalizeIdentity = (room = {}) => {
	const out = { ...room };
	if (typeof out.roomType === "string") out.roomType = out.roomType.trim();
	if (typeof out.displayName === "string")
		out.displayName = out.displayName.trim();
	return out;
};

const hasNumberValue = (value) =>
	value !== undefined && value !== null && value !== "";

const toFiniteNumber = (value, fallback = 0) => {
	if (!hasNumberValue(value)) return fallback;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
};

const toPositiveNumber = (value, fallback = 0) => {
	if (!hasNumberValue(value)) return fallback;
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const toDateKey = (value) => {
	if (!value) return "";
	if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) {
		return value.slice(0, 10);
	}
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString().slice(0, 10);
};

const isBlockedPricingRate = (rate = {}) => {
	if (!rate || typeof rate !== "object") return false;
	const color = String(rate.color || "").toLowerCase();
	const price = Number(rate.price);
	const rootPrice = Number(rate.rootPrice);
	return (
		color === "black" ||
		(Number.isFinite(price) && price <= 0) ||
		(Number.isFinite(rootPrice) && rootPrice <= 0 && color === "black")
	);
};

const normalizeRoomPricing = (room = {}) => {
	const out = { ...room };
	const explicitBasePrice =
		out.price && typeof out.price === "object"
			? out.price.basePrice
			: out.price;
	const basePrice = toFiniteNumber(
		explicitBasePrice ?? out.basePrice,
		toFiniteNumber(out.defaultCost ?? out.rootPrice, 0)
	);
	const defaultCost = toFiniteNumber(
		out.defaultCost ??
			out.rootPrice ??
			(out.price && typeof out.price === "object"
				? out.price.defaultCost
				: undefined),
		basePrice
	);

	out.price = {
		...(out.price && typeof out.price === "object" ? out.price : {}),
		basePrice,
	};
	out.defaultCost = defaultCost;

	out.pricingRate = Array.isArray(out.pricingRate)
		? out.pricingRate.map((rate) => {
				const next = { ...rate };
				if (isBlockedPricingRate(next)) {
					return { ...next, price: 0, rootPrice: 0 };
				}

				const regularPrice = hasNumberValue(next.price)
					? toPositiveNumber(next.price, basePrice || defaultCost)
					: basePrice || defaultCost;
				const rootPrice = hasNumberValue(next.rootPrice)
					? toPositiveNumber(next.rootPrice, defaultCost || regularPrice)
					: defaultCost || regularPrice;

				return {
					...next,
					price: regularPrice,
					rootPrice,
				};
		  })
		: [];
	out.agentInventory = Array.isArray(out.agentInventory)
		? out.agentInventory
				.map((row) => ({
					...row,
					agentId: normalizeId(row?.agentId),
					stock: Math.max(0, Math.floor(toFiniteNumber(row?.stock, 0))),
				}))
				.filter((row) => row.agentId)
		: [];
	out.agentPricingRate = Array.isArray(out.agentPricingRate)
		? out.agentPricingRate
				.map((rate) => {
					const next = { ...rate, agentId: normalizeId(rate?.agentId) };
					const calendarDate = toDateKey(next.calendarDate);
					if (!next.agentId || !calendarDate) return null;
					if (isBlockedPricingRate(next)) {
						return { ...next, calendarDate, price: 0, rootPrice: 0 };
					}
					const regularPrice = hasNumberValue(next.price)
						? toPositiveNumber(next.price, basePrice || defaultCost)
						: basePrice || defaultCost;
					const rootPrice = hasNumberValue(next.rootPrice)
						? toPositiveNumber(next.rootPrice, defaultCost || regularPrice)
						: defaultCost || regularPrice;
					return {
						...next,
						calendarDate,
						price: regularPrice,
						rootPrice,
					};
				})
				.filter(Boolean)
		: [];

	return out;
};

const objectIdOrNull = (value) => {
	const id = normalizeId(value);
	return mongoose.Types.ObjectId.isValid(id) ? mongoose.Types.ObjectId(id) : null;
};

const getRoomFromHotel = (hotel = {}, roomId) =>
	(hotel.roomCountDetails || []).find(
		(room) => normalizeId(room?._id) === normalizeId(roomId)
	);

const asPlainObject = (doc = {}) =>
	doc && typeof doc.toObject === "function" ? doc.toObject() : { ...doc };

const scopedHotelAgentQuery = (hotel = {}, agentId) => {
	const hotelId = normalizeId(hotel._id);
	const hotelObjectId = objectIdOrNull(hotelId);
	const ownerId = normalizeId(hotel.belongsTo);

	return {
		_id: objectIdOrNull(agentId),
		$and: [
			{
				$or: [
					{ belongsToId: ownerId },
					{ hotelsToSupport: hotelObjectId },
					{ hotelIdsWork: hotelObjectId },
					{ hotelIdWork: hotelId },
				],
			},
			{
				$or: [
					{ hotelIdWork: hotelId },
					{ hotelIdsWork: hotelObjectId },
					{ hotelsToSupport: hotelObjectId },
				],
			},
			{
				$or: [
					{ role: 7000 },
					{ roles: 7000 },
					{ roleDescription: "ordertaker" },
					{ roleDescriptions: "ordertaker" },
				],
			},
			{
				$or: [
					{ activeUser: { $exists: false } },
					{ activeUser: { $ne: false } },
				],
			},
			{
				$or: [
					{ "agentApproval.status": { $exists: false } },
					{ "agentApproval.status": null },
					{ "agentApproval.status": { $regex: /^approved$/i } },
				],
			},
		],
	};
};

const agentOverrideSnapshot = (agent = {}) => ({
	agentId: normalizeId(agent._id),
	agentName: agent.name || agent.email || "",
	agentEmail: agent.email || "",
	companyName: agent.companyName || agent.companyOfficialName || "",
});

const normalizeStockValue = (value) =>
	Math.max(0, Math.floor(toFiniteNumber(value, 0)));

const normalizeAgentPricingPayload = (rows = [], agentSnapshot = {}, room = {}) => {
	const normalizedRoom = normalizeRoomPricing(room);
	const basePrice = toFiniteNumber(
		normalizedRoom?.price?.basePrice,
		toFiniteNumber(normalizedRoom?.defaultCost ?? normalizedRoom?.rootPrice, 0)
	);
	const defaultCost = toFiniteNumber(
		normalizedRoom?.defaultCost ?? normalizedRoom?.rootPrice,
		basePrice
	);

	return (Array.isArray(rows) ? rows : [])
		.map((row) => {
			const calendarDate = toDateKey(row?.calendarDate);
			if (!calendarDate) return null;
			if (
				row?.blocked === true ||
				row?.isBlocked === true ||
				String(row?.status || "").toLowerCase() === "blocked" ||
				isBlockedPricingRate(row)
			) {
				return {
					...agentSnapshot,
					calendarDate,
					price: 0,
					rootPrice: 0,
					color: "black",
					status: "blocked",
					blocked: true,
				};
			}

			const price = toPositiveNumber(row?.price, basePrice || defaultCost);
			const rootPrice = toPositiveNumber(
				row?.rootPrice,
				defaultCost || price
			);
			if (!(price > 0) || !(rootPrice > 0)) return null;

			return {
				...agentSnapshot,
				calendarDate,
				price,
				rootPrice,
			};
		})
		.filter(Boolean);
};

// Keep your existing color uniqueness behavior; only minor safety guards
const ensureUniqueRoomColors = (roomCountDetails = []) => {
	const colorMap = {};
	roomCountDetails.forEach((room) => {
		if (!room || !room.roomType) return;

		if (!colorMap[room.roomType]) {
			colorMap[room.roomType] = new Set();
		}

		const used = colorMap[room.roomType];

		// If duplicate, generate new color (assumes generateUniqueDarkColor exists in your codebase)
		if (room.roomColor && used.has(room.roomColor)) {
			const generator =
				typeof generateUniqueDarkColor === "function"
					? generateUniqueDarkColor
					: (existing = []) => {
							// simple fallback
							const rnd = () =>
								Math.floor(Math.random() * 128)
									.toString(16)
									.padStart(2, "0");
							let candidate = `#${rnd()}${rnd()}${rnd()}`;
							let tries = 0;
							const set = new Set(existing);
							while (set.has(candidate) && tries < 20) {
								candidate = `#${rnd()}${rnd()}${rnd()}`;
								tries += 1;
							}
							return candidate;
					  };
			const existing = Array.from(used);
			room.roomColor = generator(existing);
			console.log(
				`Duplicate color found for roomType ${room.roomType}. Generated new color: ${room.roomColor}`
			);
		}

		if (room.roomColor) used.add(room.roomColor);
	});
};

/**
 * Constructs the fields to be updated in the HotelDetails document.
 * Merges roomCountDetails and paymentSettings while ensuring unique room colors.
 * Critically: prevents creating a new "blank" room (must have roomType + displayName).
 */
const constructUpdatedFields = (hotelDetails, updateData, fromPage) => {
	const updatedFields = {};

	// Process roomCountDetails if provided
	if (
		updateData.roomCountDetails &&
		Array.isArray(updateData.roomCountDetails)
	) {
		// Clone existing rooms safely (Mongoose doc or plain object)
		let updatedRoomCountDetails = (hotelDetails.roomCountDetails || []).map(
			(existingRoom) =>
				typeof existingRoom?.toObject === "function"
					? existingRoom.toObject()
					: { ...existingRoom }
		);

		updateData.roomCountDetails.forEach((incoming) => {
			const newRoomRaw = incoming || {};
			const newRoom = normalizeIdentity(newRoomRaw);
			const identityOK = hasRoomIdentity(newRoom);

			if (fromPage === "AddNew") {
				// DO NOT create a room unless it has roomType + displayName
				if (!identityOK) {
					console.warn(
						`Skipping room without roomType/displayName during AddNew: ${JSON.stringify(
							newRoomRaw
						)}`
					);
					return;
				}

				// Match existing by identity (roomType + displayName)
				const existingIndex = updatedRoomCountDetails.findIndex(
					(room) =>
						(room.roomType || "").toString().trim() === newRoom.roomType &&
						(room.displayName || "").toString().trim() === newRoom.displayName
				);

				if (existingIndex !== -1) {
					// Merge
					updatedRoomCountDetails[existingIndex] = normalizeRoomPricing({
						...updatedRoomCountDetails[existingIndex],
						...newRoom,
					});
				} else {
					if (newRoom.activeRoom === undefined) newRoom.activeRoom = true;
					const normalizedNewRoom = normalizeRoomPricing(newRoom);
					updatedRoomCountDetails.push(normalizedNewRoom);
					console.log(`Added new room: ${JSON.stringify(newRoom)}`);
				}
			} else {
				// Non-AddNew: match/update by _id only (your existing behavior)
				if (newRoom._id) {
					const existingIndex = updatedRoomCountDetails.findIndex(
						(room) => room._id?.toString?.() === newRoom._id.toString()
					);

					if (existingIndex !== -1) {
						// Merge but protect identity from being blanked by accidental empty values
						const existing = updatedRoomCountDetails[existingIndex];
						const merged = normalizeRoomPricing({ ...existing, ...newRoom });
						if (!hasRoomIdentity(newRoom)) {
							// keep existing identity if incoming lacks it
							merged.roomType = existing.roomType;
							merged.displayName = existing.displayName;
						}
						updatedRoomCountDetails[existingIndex] = merged;
					} else {
						// Only allow adding a *new* room here if it also has identity
						if (identityOK) {
							if (newRoom.activeRoom === undefined) newRoom.activeRoom = true;
							const normalizedNewRoom = normalizeRoomPricing(newRoom);
							updatedRoomCountDetails.push(normalizedNewRoom);
							console.log(`Added new room with _id: ${newRoom._id}`);
						} else {
							console.warn(
								`Skipping room without identity and no match by _id on non-AddNew: ${JSON.stringify(
									newRoomRaw
								)}`
							);
						}
					}
				} else {
					// No _id on non-AddNew → skip (your previous code warned too)
					console.warn(
						`Skipping room without _id on non-AddNew page: ${JSON.stringify(
							newRoomRaw
						)}`
					);
				}
			}
		});

		// Ensure all room colors are unique within the same roomType
		ensureUniqueRoomColors(updatedRoomCountDetails);
		updatedRoomCountDetails = updatedRoomCountDetails.map(normalizeRoomPricing);

		// Assign the updated rooms
		updatedFields.roomCountDetails = updatedRoomCountDetails;
	}

	// Merge paymentSettings if provided
	if (updateData.paymentSettings && Array.isArray(updateData.paymentSettings)) {
		updatedFields.paymentSettings = updateData.paymentSettings;
		console.log(
			`Merged paymentSettings: ${JSON.stringify(
				updateData.paymentSettings,
				null,
				2
			)}`
		);
	}

	if (Object.prototype.hasOwnProperty.call(updateData, "hotelPolicyQA")) {
		updatedFields.hotelPolicyQA = sanitizeHotelPolicyQA(updateData.hotelPolicyQA);
	}

	// Process other fields (excluding roomCountDetails and paymentSettings)
	Object.keys(updateData).forEach((key) => {
		if (
			key !== "roomCountDetails" &&
			key !== "paymentSettings" &&
			key !== "hotelPolicyQA"
		) {
			updatedFields[key] = updateData[key];
			console.log(`Updated field ${key}: ${updateData[key]}`);
		}
	});

	return updatedFields;
};

/**
 * Distance calculation helper (unchanged except minor guards)
 */
const calcDistances = async (coords, hotelState = "") => {
	const [lng, lat] = coords; // hotel stores [lng, lat]
	const elHaram = [39.8262, 21.4225];
	const prophetsMosque = [39.6142, 24.4672];

	const dest = (hotelState || "").toLowerCase().includes("madinah")
		? prophetsMosque
		: elHaram;

	const apiKey = process.env.GOOGLE_MAPS_API_KEY;
	if (!apiKey) {
		console.warn("GOOGLE_MAPS_API_KEY missing; skipping live distance call.");
		return { walkingToElHaram: "N/A", drivingToElHaram: "N/A" };
	}

	const makeURL = (mode) =>
		`https://maps.googleapis.com/maps/api/distancematrix/json?origins=${lat},${lng}&destinations=${dest[1]},${dest[0]}&mode=${mode}&key=${apiKey}`;

	try {
		const [walkResp, driveResp] = await Promise.all([
			axios.get(makeURL("walking")),
			axios.get(makeURL("driving")),
		]);

		const walkEl = walkResp.data?.rows?.[0]?.elements?.[0];
		const driveEl = driveResp.data?.rows?.[0]?.elements?.[0];

		return {
			walkingToElHaram:
				walkEl && walkEl.status === "OK" ? walkEl.duration.text : "N/A",
			drivingToElHaram:
				driveEl && driveEl.status === "OK" ? driveEl.duration.text : "N/A",
		};
	} catch (err) {
		console.error("Distance API error:", err.message || err);
		return { walkingToElHaram: "N/A", drivingToElHaram: "N/A" };
	}
};

/* ────────────────── UPDATE HANDLER ────────────────── */

exports.updateRoomAgentOverrides = async (req, res) => {
	try {
		const { hotelId, roomId } = req.params;
		const { action } = req.body || {};
		const normalizedAction = String(action || "").trim();

		if (
			!mongoose.Types.ObjectId.isValid(hotelId) ||
			!mongoose.Types.ObjectId.isValid(roomId)
		) {
			return res.status(400).json({ error: "Invalid hotel or room id" });
		}

		const hotel = await HotelDetails.findById(hotelId).exec();
		if (!hotel) return res.status(404).json({ error: "Hotel details not found" });

		if (!canManageHotelAgentOverrides(req.profile, hotel)) {
			return res
				.status(403)
				.json({ error: "Not allowed to update agent room settings" });
		}

		const room = getRoomFromHotel(hotel, roomId);
		if (!room) return res.status(404).json({ error: "Room was not found" });

		const roomObjectId = objectIdOrNull(roomId);
		const agentId = normalizeId(req.body?.agentId);
		const needsAgentValidation = ["saveStock", "savePricingRange"].includes(
			normalizedAction
		);
		let agentSnapshot = null;

		if (
			[
				"saveStock",
				"removeStock",
				"savePricingRange",
				"removePricingDate",
			].includes(normalizedAction) &&
			!mongoose.Types.ObjectId.isValid(agentId)
		) {
			return res.status(400).json({ error: "Please choose a valid agent" });
		}

		if (needsAgentValidation) {
			const agent = await User.findOne(scopedHotelAgentQuery(hotel, agentId))
				.select("_id name email companyName companyOfficialName")
				.lean()
				.exec();

			if (!agent) {
				return res
					.status(403)
					.json({ error: "This agent is not assigned to this hotel" });
			}

			agentSnapshot = agentOverrideSnapshot(agent);
		}

		const plainRoom = asPlainObject(room);
		let updatePath = "";
		let nextRows = [];

		if (normalizedAction === "saveStock") {
			updatePath = "roomCountDetails.$.agentInventory";
			nextRows = [
				...(Array.isArray(plainRoom.agentInventory)
					? plainRoom.agentInventory.filter(
							(row) => normalizeId(row?.agentId) !== agentId
					  )
					: []),
				{
					...agentSnapshot,
					stock: normalizeStockValue(req.body?.stock),
				},
			];
		} else if (normalizedAction === "removeStock") {
			updatePath = "roomCountDetails.$.agentInventory";
			nextRows = (Array.isArray(plainRoom.agentInventory)
				? plainRoom.agentInventory
				: []
			).filter((row) => normalizeId(row?.agentId) !== agentId);
		} else if (normalizedAction === "savePricingRange") {
			updatePath = "roomCountDetails.$.agentPricingRate";
			const pricingRows = normalizeAgentPricingPayload(
				req.body?.pricingRows,
				agentSnapshot,
				plainRoom
			);
			if (!pricingRows.length) {
				return res
					.status(400)
					.json({ error: "Please provide a valid pricing range" });
			}
			const dates = new Set(pricingRows.map((row) => row.calendarDate));
			nextRows = [
				...(Array.isArray(plainRoom.agentPricingRate)
					? plainRoom.agentPricingRate.filter(
							(row) =>
								normalizeId(row?.agentId) !== agentId ||
								!dates.has(toDateKey(row?.calendarDate))
					  )
					: []),
				...pricingRows,
			];
		} else if (normalizedAction === "removePricingDate") {
			updatePath = "roomCountDetails.$.agentPricingRate";
			const calendarDate = toDateKey(req.body?.calendarDate);
			if (!calendarDate) {
				return res.status(400).json({ error: "Please provide a valid date" });
			}
			nextRows = (Array.isArray(plainRoom.agentPricingRate)
				? plainRoom.agentPricingRate
				: []
			).filter(
				(row) =>
					normalizeId(row?.agentId) !== agentId ||
					toDateKey(row?.calendarDate) !== calendarDate
			);
		} else {
			return res.status(400).json({ error: "Unsupported agent override action" });
		}

		const updatedHotel = await HotelDetails.findOneAndUpdate(
			{ _id: hotel._id, "roomCountDetails._id": roomObjectId },
			{ $set: { [updatePath]: nextRows } },
			{ new: true, runValidators: true }
		)
			.lean()
			.exec();

		if (!updatedHotel) {
			return res.status(404).json({ error: "Room was not found" });
		}

		const updatedRoom = getRoomFromHotel(updatedHotel, roomId) || {};
		return res.json({
			ok: true,
			saved: true,
			action: normalizedAction,
			roomId: normalizeId(roomId),
			agentInventory: Array.isArray(updatedRoom.agentInventory)
				? updatedRoom.agentInventory
				: [],
			agentPricingRate: Array.isArray(updatedRoom.agentPricingRate)
				? updatedRoom.agentPricingRate
				: [],
		});
	} catch (err) {
		console.error("updateRoomAgentOverrides error:", err);
		return res.status(500).json({ error: "Could not save agent room settings" });
	}
};

exports.updateHotelDetails = async (req, res) => {
	const hotelDetailsId = req.params.hotelId;
	const updateData = req.body;
	const fromPage = req.body.fromPage; // e.g. "AddNew"

	try {
		/* 1. Fetch existing doc */
		const hotelDetails = await HotelDetails.findById(hotelDetailsId).exec();
		if (!hotelDetails)
			return res.status(404).json({ error: "Hotel details not found" });

		/* 2. Merge incoming data with helper */
		const updatedFields = constructUpdatedFields(
			hotelDetails,
			updateData,
			fromPage
		);
		updatedFields.fromPage = fromPage;

		/* 🔒 Ensure booleans that can be false are not dropped */
		if (Object.prototype.hasOwnProperty.call(updateData, "aiToRespond")) {
			updatedFields.aiToRespond = toBoolean(updateData.aiToRespond); // ← NEW
		}
		if (Object.prototype.hasOwnProperty.call(updateData, "activateHotel")) {
			updatedFields.activateHotel = toBoolean(updateData.activateHotel);
		}
		if (Object.prototype.hasOwnProperty.call(updateData, "xHotelProActive")) {
			updatedFields.xHotelProActive = toBoolean(updateData.xHotelProActive);
		}
		if (Object.prototype.hasOwnProperty.call(updateData, "busDetails")) {
			updatedFields.busDetails = String(updateData.busDetails || "").trim();
		}
		if (Object.prototype.hasOwnProperty.call(updateData, "hasBusService")) {
			updatedFields.hasBusService = toBoolean(updateData.hasBusService);
			if (!updatedFields.hasBusService) updatedFields.busDetails = "";
		}
		if (Object.prototype.hasOwnProperty.call(updateData, "mealsDetails")) {
			updatedFields.mealsDetails = String(updateData.mealsDetails || "").trim();
		}
		if (Object.prototype.hasOwnProperty.call(updateData, "hasMealsService")) {
			updatedFields.hasMealsService = toBoolean(updateData.hasMealsService);
			if (!updatedFields.hasMealsService) updatedFields.mealsDetails = "";
		}
		if (Object.prototype.hasOwnProperty.call(updateData, "isNusukText")) {
			updatedFields.isNusukText = String(updateData.isNusukText || "").trim();
		}
		if (Object.prototype.hasOwnProperty.call(updateData, "isNusuk")) {
			updatedFields.isNusuk = toBoolean(updateData.isNusuk);
			if (!updatedFields.isNusuk) updatedFields.isNusukText = "";
		}

		/* 3. Detect coordinate change */
		const newCoords = updateData?.location?.coordinates;
		const oldCoords = hotelDetails.location?.coordinates;
		const coordsChanged =
			Array.isArray(newCoords) &&
			newCoords.length === 2 &&
			(!oldCoords ||
				oldCoords[0] !== newCoords[0] ||
				oldCoords[1] !== newCoords[1]);

		if (coordsChanged) {
			/* 3a. Compute fresh distances */
			const distances = await calcDistances(
				newCoords,
				updateData.hotelState ||
					updatedFields.hotelState ||
					hotelDetails.hotelState
			);

			/* 3b. Attach to update payload */
			updatedFields.distances = distances;
			console.log(
				`Distances recalculated for hotel ${hotelDetailsId}:`,
				distances
			);
		}

		/* 4. Persist */
		const newDoc = await HotelDetails.findByIdAndUpdate(
			hotelDetailsId,
			{ $set: updatedFields },
			{ new: true, runValidators: true }
		).exec();

		if (!newDoc)
			return res.status(500).json({ error: "Failed to update hotel details" });

		return res.json(newDoc);
	} catch (err) {
		console.error("updateHotelDetails error:", err);
		return res.status(500).json({ error: "Internal server error" });
	}
};

exports.updateAdminHotelActivation = async (req, res) => {
	try {
		const hotelDetailsId = req.params.hotelId;
		if (!mongoose.Types.ObjectId.isValid(hotelDetailsId)) {
			return res.status(400).json({ error: "Invalid hotel id" });
		}

		const hotelObjectId = mongoose.Types.ObjectId(hotelDetailsId);
		const scopedMatch = applyAdminHotelScope(req, { _id: hotelObjectId });
		const hotelDetails = await HotelDetails.findOne(scopedMatch)
			.select(
				"_id roomCountDetails hotelPhotos location aboutHotel aboutHotelArabic overallRoomsCount activateHotel xHotelProActive"
			)
			.exec();
		if (!hotelDetails) {
			return res.status(404).json({ error: "Hotel details not found" });
		}

		const hasOwnerActivation = Object.prototype.hasOwnProperty.call(
			req.body,
			"activateHotel"
		);
		const hasPlatformActivation = Object.prototype.hasOwnProperty.call(
			req.body,
			"xHotelProActive"
		);

		if (!hasOwnerActivation && !hasPlatformActivation) {
			return res.status(400).json({ error: "No activation change was provided" });
		}

		const updates = {};
		if (hasOwnerActivation) {
			updates.activateHotel = toBoolean(req.body.activateHotel);
		}
		if (hasPlatformActivation) {
			updates.xHotelProActive = toBoolean(req.body.xHotelProActive);
		}

		const activatingPublicHotel =
			updates.activateHotel === true || updates.xHotelProActive === true;
		if (activatingPublicHotel) {
			const checklist = getHotelActivationChecklist(hotelDetails);
			if (!checklist.activationReady) {
				return res.status(400).json({
					error: "Finish rooms, photos, location, and hotel data before activation.",
					checklist,
				});
			}
		}

		updates.fromPage = req.body.fromPage || "AdminHotelActivation";
		updates.updatedAt = new Date();

		const newDoc = await HotelDetails.findByIdAndUpdate(
			hotelObjectId,
			{ $set: updates },
			{ new: true, runValidators: true }
		)
			.select("_id hotelName activateHotel xHotelProActive fromPage updatedAt")
			.lean()
			.exec();

		if (!newDoc) {
			return res.status(500).json({ error: "Failed to update hotel activation" });
		}

		return res.json(newDoc);
	} catch (err) {
		console.error("updateAdminHotelActivation error:", err);
		return res.status(500).json({ error: "Internal server error" });
	}
};

exports.reassignHotelOwner = async (req, res) => {
	try {
		if (!canReassignPropertyOwner(req.profile)) {
			return res
				.status(403)
				.json({ error: "Only platform admins can reassign a property owner" });
		}

		const { hotelId } = req.params;
		const { newOwnerId, transferExistingReservations = true } = req.body || {};

		if (
			!mongoose.Types.ObjectId.isValid(hotelId) ||
			!mongoose.Types.ObjectId.isValid(newOwnerId)
		) {
			return res.status(400).json({ error: "Invalid hotel or owner id" });
		}

		const hotelObjectId = mongoose.Types.ObjectId(hotelId);
		const newOwnerObjectId = mongoose.Types.ObjectId(newOwnerId);

		const [hotelDetails, newOwner] = await Promise.all([
			HotelDetails.findById(hotelObjectId).exec(),
			User.findById(newOwnerObjectId).exec(),
		]);

		if (!hotelDetails) {
			return res.status(404).json({ error: "Hotel details not found" });
		}
		if (!newOwner || Number(newOwner.role) !== 2000) {
			return res
				.status(400)
				.json({ error: "Please select a valid hotel owner account" });
		}
		if (newOwner.activeUser === false) {
			return res.status(400).json({ error: "Selected owner account is inactive" });
		}

		const oldOwnerId = hotelDetails.belongsTo
			? mongoose.Types.ObjectId(hotelDetails.belongsTo)
			: null;
		const sameOwner =
			oldOwnerId && String(oldOwnerId) === String(newOwnerObjectId);

		if (sameOwner) {
			const populated = await HotelDetails.findById(hotelObjectId)
				.populate("belongsTo", "name email phone role activeUser hotelIdsOwner")
				.exec();
			return res.json({
				message: "Property already belongs to this owner",
				hotel: populated,
				counts: {
					hotelUpdated: 0,
					oldOwnerUpdated: 0,
					newOwnerUpdated: 0,
					reservationsUpdated: 0,
					uncompletedReservationsUpdated: 0,
					roomsUpdated: 0,
					scopedStaffUpdated: 0,
				},
			});
		}

		hotelDetails.belongsTo = newOwnerObjectId;
		await hotelDetails.save();

		const counts = {
			hotelUpdated: 1,
			oldOwnerUpdated: 0,
			newOwnerUpdated: 0,
			reservationsUpdated: 0,
			uncompletedReservationsUpdated: 0,
			roomsUpdated: 0,
			scopedStaffUpdated: 0,
		};

		if (oldOwnerId) {
			const oldOwnerResult = await User.updateOne(
				{ _id: oldOwnerId },
				{ $pull: { hotelIdsOwner: hotelObjectId } }
			).exec();
			counts.oldOwnerUpdated =
				oldOwnerResult.modifiedCount || oldOwnerResult.nModified || 0;
		}

		const newOwnerResult = await User.updateOne(
			{ _id: newOwnerObjectId },
			{ $addToSet: { hotelIdsOwner: hotelObjectId } }
		).exec();
		counts.newOwnerUpdated =
			newOwnerResult.modifiedCount || newOwnerResult.nModified || 0;

		if (transferExistingReservations) {
			const reservationsResult = await Reservations.updateMany(
				{ hotelId: hotelObjectId },
				{ $set: { belongsTo: newOwnerObjectId } }
			).exec();
			counts.reservationsUpdated =
				reservationsResult.modifiedCount || reservationsResult.nModified || 0;

			const uncompletedResult = await UncompleteReservations.updateMany(
				{ hotelId: hotelObjectId },
				{ $set: { belongsTo: newOwnerObjectId } }
			).exec();
			counts.uncompletedReservationsUpdated =
				uncompletedResult.modifiedCount || uncompletedResult.nModified || 0;
		}

		const roomsResult = await Rooms.updateMany(
			{ hotelId: hotelObjectId },
			{ $set: { belongsTo: newOwnerObjectId } }
		).exec();
		counts.roomsUpdated = roomsResult.modifiedCount || roomsResult.nModified || 0;

		const staffResult = await User.updateMany(
			{ hotelIdWork: String(hotelObjectId) },
			{ $set: { belongsToId: String(newOwnerObjectId) } }
		).exec();
		counts.scopedStaffUpdated =
			staffResult.modifiedCount || staffResult.nModified || 0;

		const populated = await HotelDetails.findById(hotelObjectId)
			.populate("belongsTo", "name email phone role activeUser hotelIdsOwner")
			.exec();

		return res.json({
			message: "Property owner reassigned successfully",
			hotel: populated,
			counts,
		});
	} catch (err) {
		console.error("reassignHotelOwner error:", err);
		return res.status(500).json({ error: "Property reassignment failed" });
	}
};

/* Helper: robust boolean coercion */
function toBoolean(v) {
	if (typeof v === "boolean") return v;
	if (typeof v === "number") return v !== 0;
	if (typeof v === "string") {
		const s = v.trim().toLowerCase();
		// accept common truthy/falsey forms just in case a gateway sends strings
		if (["true", "1", "yes", "on"].includes(s)) return true;
		if (["false", "0", "no", "off", ""].includes(s)) return false;
	}
	return !!v; // fallback
}

exports.list = (req, res) => {
	const userId = mongoose.Types.ObjectId(req.params.accountId);

	HotelDetails.find({ belongsTo: userId })
		.populate("belongsTo", "name email") // Select only necessary fields
		.exec((err, data) => {
			if (err) {
				console.log(err, "err");
				return res.status(400).json({ error: err });
			}
			res.json(
				(Array.isArray(data) ? data : []).map((hotel) =>
					sanitizeAgentRoomOverridesForViewer(hotel, null)
				)
			);
		});
};

exports.remove = (req, res) => {
	const hotelDetails = req.hotelDetails;

	hotelDetails.remove((err) => {
		if (err) {
			return res.status(400).json({ error: "Error while removing" });
		}
		res.json({ message: "Hotel details deleted" });
	});
};

exports.getHotelDetails = (req, res) => {
	return res.json(sanitizeAgentRoomOverridesForViewer(req.hotelDetails, null));
};

exports.listForAdmin = async (req, res) => {
	try {
		/* 1️⃣  Parse & sanitise query params */
		let { page = 1, limit = 15, status, q = "", filter = "all" } = req.query;

		page = Math.max(parseInt(page, 10) || 1, 1);
		limit = Math.min(Math.max(parseInt(limit, 10) || 15, 1), 50);
		const skip = (page - 1) * limit;

		/* 2️⃣  Base filter (status) */
		const baseMatch = applyAdminHotelScope(req, {});
		if (status === "active") {
			baseMatch.activateHotel = true;
			baseMatch.xHotelProActive = { $ne: false };
		}
		if (status === "inactive") {
			baseMatch.$or = [
				{ activateHotel: { $ne: true } },
				{ xHotelProActive: false },
			];
		}

		/* 3️⃣  Search filter (if q present) */
		const search = q.trim();
		let searchMatch = {};
		if (search) {
			// escape regex special chars then make case‑insensitive regex
			const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const regex = new RegExp(escaped, "i");
			searchMatch = {
				$or: [
					{ hotelName: regex },
					{ hotelCountry: regex },
					{ hotelCity: regex },
					{ hotelAddress: regex },
					{ phone: regex },
					{ "owner.name": regex },
					{ "owner.email": regex },
				],
			};
		}

		/* 4️⃣  Build pipeline core (+ computed flags) */
		const pipelineCore = [
			{ $match: baseMatch },
			{
				$lookup: {
					from: "users",
					localField: "belongsTo",
					foreignField: "_id",
					as: "owner",
				},
			},
			{ $unwind: { path: "$owner", preserveNullAndEmptyArrays: true } },
			// computed completeness flags
			{
				$addFields: {
					roomsDone: {
						$gt: [{ $size: { $ifNull: ["$roomCountDetails", []] } }, 0],
					},
					photosDone: {
						$gt: [{ $size: { $ifNull: ["$hotelPhotos", []] } }, 0],
					},
					locationDone: {
						$let: {
							vars: { coords: { $ifNull: ["$location.coordinates", []] } },
							in: {
								$and: [
									{ $gte: [{ $size: "$$coords" }, 2] },
									{ $ne: [{ $arrayElemAt: ["$$coords", 0] }, 0] },
									{ $ne: [{ $arrayElemAt: ["$$coords", 1] }, 0] },
								],
							},
						},
					},
					dataDone: {
						$or: [
							{ $gt: [{ $strLenCP: { $ifNull: ["$aboutHotel", ""] } }, 0] },
							{
								$gt: [{ $strLenCP: { $ifNull: ["$aboutHotelArabic", ""] } }, 0],
							},
							{ $gt: [{ $ifNull: ["$overallRoomsCount", 0] }, 0] },
						],
					},
					bankDone: {
						$gt: [{ $size: { $ifNull: ["$paymentSettings", []] } }, 0],
					},
				},
			},
			{
				$addFields: {
					activationReady: {
						$and: ["$roomsDone", "$photosDone", "$locationDone", "$dataDone"],
					},
					fullyComplete: {
						$and: [
							"$roomsDone",
							"$photosDone",
							"$locationDone",
							"$dataDone",
							"$bankDone",
						],
					},
				},
			},
		];

		if (search) pipelineCore.push({ $match: searchMatch });

		/* 5️⃣  Step-based filter mapping (optional) */
		const stepFilterMatch =
			filter === "missing_rooms"
				? { roomsDone: false }
				: filter === "missing_photos"
				? { photosDone: false }
				: filter === "missing_location"
				? { locationDone: false }
				: filter === "missing_data"
				? { dataDone: false }
				: filter === "missing_bank"
				? { bankDone: false }
				: filter === "activation_ready"
				? { activationReady: true }
				: filter === "fully_complete"
				? { fullyComplete: true }
				: filter === "missing_any"
				? {
						$or: [
							{ roomsDone: { $ne: true } },
							{ photosDone: { $ne: true } },
							{ locationDone: { $ne: true } },
							{ dataDone: { $ne: true } },
						],
				  }
				: {}; // 'all' or unknown => no extra filter

		/* 6️⃣  Group definition for summaries */
		const summaryGroup = {
			_id: null,
			total: { $sum: 1 },
			active: {
				$sum: {
					$cond: [
						{
							$and: [
								{ $eq: ["$activateHotel", true] },
								{ $ne: ["$xHotelProActive", false] },
							],
						},
						1,
						0,
					],
				},
			},
			inactive: {
				$sum: {
					$cond: [
						{
							$or: [
								{ $ne: ["$activateHotel", true] },
								{ $eq: ["$xHotelProActive", false] },
							],
						},
						1,
						0,
					],
				},
			},

			roomsDone: {
				$sum: { $cond: [{ $eq: ["$roomsDone", true] }, 1, 0] },
			},
			roomsMissing: {
				$sum: { $cond: [{ $ne: ["$roomsDone", true] }, 1, 0] },
			},

			photosDone: {
				$sum: { $cond: [{ $eq: ["$photosDone", true] }, 1, 0] },
			},
			photosMissing: {
				$sum: { $cond: [{ $ne: ["$photosDone", true] }, 1, 0] },
			},

			locationDone: {
				$sum: { $cond: [{ $eq: ["$locationDone", true] }, 1, 0] },
			},
			locationMissing: {
				$sum: { $cond: [{ $ne: ["$locationDone", true] }, 1, 0] },
			},

			dataDone: {
				$sum: { $cond: [{ $eq: ["$dataDone", true] }, 1, 0] },
			},
			dataMissing: {
				$sum: { $cond: [{ $ne: ["$dataDone", true] }, 1, 0] },
			},

			bankDone: {
				$sum: { $cond: [{ $eq: ["$bankDone", true] }, 1, 0] },
			},
			bankMissing: {
				$sum: { $cond: [{ $ne: ["$bankDone", true] }, 1, 0] },
			},

			activationReady: {
				$sum: { $cond: [{ $eq: ["$activationReady", true] }, 1, 0] },
			},
			activationNotReady: {
				$sum: { $cond: [{ $ne: ["$activationReady", true] }, 1, 0] },
			},

			fullyComplete: {
				$sum: { $cond: [{ $eq: ["$fullyComplete", true] }, 1, 0] },
			},
			notFullyComplete: {
				$sum: { $cond: [{ $ne: ["$fullyComplete", true] }, 1, 0] },
			},
		};

		/* 7️⃣  Final aggregation with facet */
		const compactHotelListProject = {
			_id: 1,
			hotelName: 1,
			hotelName_OtherLanguage: 1,
			hotelCountry: 1,
			hotelState: 1,
			hotelCity: 1,
			hotelAddress: 1,
			phone: 1,
			activateHotel: 1,
			xHotelProActive: 1,
			aiToRespond: 1,
			belongsTo: 1,
			createdAt: 1,
			updatedAt: 1,
			overallRoomsCount: 1,
			aboutHotel: 1,
			aboutHotelArabic: 1,
			location: 1,
			roomsDone: 1,
			photosDone: 1,
			locationDone: 1,
			dataDone: 1,
			bankDone: 1,
			activationReady: 1,
			fullyComplete: 1,
			roomsCount: { $size: { $ifNull: ["$roomCountDetails", []] } },
			photosCount: { $size: { $ifNull: ["$hotelPhotos", []] } },
			owner: {
				_id: "$owner._id",
				name: "$owner.name",
				email: "$owner.email",
			},
		};

		const pipeline = [
			...pipelineCore,
			{ $project: compactHotelListProject },
			{ $sort: { createdAt: -1 } },
			{
				$facet: {
					data: [
						...(Object.keys(stepFilterMatch).length
							? [{ $match: stepFilterMatch }]
							: []),
						{ $skip: skip },
						{ $limit: limit },
					],
					totalCount: [
						...(Object.keys(stepFilterMatch).length
							? [{ $match: stepFilterMatch }]
							: []),
						{ $count: "count" },
					],
					summaryOverall: [{ $group: summaryGroup }],
					summaryCurrent: [
						...(Object.keys(stepFilterMatch).length
							? [{ $match: stepFilterMatch }]
							: []),
						{ $group: summaryGroup },
					],
				},
			},
		];

		const result = await HotelDetails.aggregate(pipeline).exec();

		const facet = result[0] || {};
		const hotels = Array.isArray(facet.data) ? facet.data : [];
		const total =
			facet.totalCount && facet.totalCount[0] ? facet.totalCount[0].count : 0;

		const cleaned = hotels.map((h) => {
			const out = { ...h };
			if (h.owner) {
				out.belongsTo = {
					_id: h.owner._id,
					name: h.owner.name,
					email: h.owner.email,
				};
			}
			delete out.owner;
			return sanitizeAgentRoomOverridesForViewer(out, null);
		});

		const safeSummary = (arr) =>
			arr && arr[0]
				? arr[0]
				: {
						total: 0,
						active: 0,
						inactive: 0,
						roomsDone: 0,
						roomsMissing: 0,
						photosDone: 0,
						photosMissing: 0,
						locationDone: 0,
						locationMissing: 0,
						dataDone: 0,
						dataMissing: 0,
						bankDone: 0,
						bankMissing: 0,
						activationReady: 0,
						activationNotReady: 0,
						fullyComplete: 0,
						notFullyComplete: 0,
				  };

		return res.json({
			total,
			page,
			pages: Math.ceil(total / limit),
			results: cleaned.length,
			hotels: cleaned,
			summary: {
				overall: safeSummary(facet.summaryOverall),
				currentView: safeSummary(facet.summaryCurrent),
			},
		});
	} catch (err) {
		console.error("listForAdmin error:", err);
		return res.status(400).json({ error: "Failed to fetch hotel list" });
	}
};

exports.listForAdminAll = async (req, res) => {
	try {
		/* 1️⃣  Parse & sanitise query params (optional filters) */
		let { status, q = "", summary = "", view = "", payload = "" } = req.query;
		const summaryOnly = ["1", "true", "yes", "summary"].includes(
			String(summary || "").toLowerCase()
		);
		const viewKey = String(view || payload || "").toLowerCase();
		const orderTakerView = ["order-taker", "ordertaker"].includes(viewKey);
		const calculatorView = ["calculator", "reservation-calculator"].includes(
			viewKey
		);
		const calculatorOptionsView = [
			"calculator-options",
			"calculator-lite",
			"reservation-calculator-options",
		].includes(viewKey);

		/* 2️⃣  Base filter (status) */
		const baseMatch = applyAdminHotelScope(req, {});
		if (status === "active") {
			baseMatch.activateHotel = true;
			baseMatch.xHotelProActive = { $ne: false };
		}
		if (status === "inactive") {
			baseMatch.$or = [
				{ activateHotel: { $ne: true } },
				{ xHotelProActive: false },
			];
		}

		/* 3️⃣  Search filter (if q present) */
		const search = (typeof q === "string" ? q : "").trim();
		let searchMatch = {};
		if (search) {
			// escape regex special chars then make case‑insensitive regex
			const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const regex = new RegExp(escaped, "i");

			searchMatch = {
				$or: [
					{ hotelName: regex },
					{ hotelCountry: regex },
					{ hotelCity: regex },
					{ hotelAddress: regex },
					{ phone: regex },
					{ "owner.name": regex },
					{ "owner.email": regex },
				],
			};
		}

		/* 4️⃣  Build aggregation pipeline (same join as listForAdmin) */
		const calculatorOnlyView = calculatorView || calculatorOptionsView;
		const needsOwnerLookup = !calculatorOnlyView || Boolean(search);
		const pipeline = [{ $match: baseMatch }];
		if (needsOwnerLookup) {
			pipeline.push(
				{
					$lookup: {
						from: "users", // collection name
						localField: "belongsTo",
						foreignField: "_id",
						as: "owner",
					},
				},
				{ $unwind: { path: "$owner", preserveNullAndEmptyArrays: true } }
			);
		}

		if (search) pipeline.push({ $match: searchMatch });

		if (summaryOnly || orderTakerView || calculatorView || calculatorOptionsView) {
			const compactProject = calculatorOnlyView
				? {
						_id: 1,
						hotelName: 1,
						activateHotel: 1,
						xHotelProActive: 1,
						commission: 1,
				  }
				: {
						_id: 1,
						hotelName: 1,
						hotelName_OtherLanguage: 1,
						hotelCountry: 1,
						hotelState: 1,
						hotelCity: 1,
						hotelAddress: 1,
						phone: 1,
						activateHotel: 1,
						xHotelProActive: 1,
						aiToRespond: 1,
						belongsTo: 1,
						createdAt: 1,
						updatedAt: 1,
						overallRoomsCount: 1,
						location: 1,
						roomsCount: { $size: { $ifNull: ["$roomCountDetails", []] } },
						photosCount: { $size: { $ifNull: ["$hotelPhotos", []] } },
						owner: {
							_id: "$owner._id",
							name: "$owner.name",
							email: "$owner.email",
						},
				  };
			if (orderTakerView || calculatorOnlyView) {
				if (!calculatorOnlyView) compactProject.commission = 1;
				const roomProjection = {
					_id: "$$room._id",
					roomType: "$$room.roomType",
					room_type: "$$room.room_type",
					displayName: "$$room.displayName",
					display_name: "$$room.display_name",
				};
				if (orderTakerView || calculatorView) {
					roomProjection.price = "$$room.price";
					roomProjection.defaultCost = "$$room.defaultCost";
					roomProjection.roomCommission = "$$room.roomCommission";
					roomProjection.pricingRate = "$$room.pricingRate";
				}
				compactProject.roomCountDetails = {
					$map: {
						input: { $ifNull: ["$roomCountDetails", []] },
						as: "room",
						in: roomProjection,
					},
				};
			}
			if (orderTakerView) {
				compactProject.roomCountDetails.$map.in.offers = "$$room.offers";
				compactProject.roomCountDetails.$map.in.monthly = "$$room.monthly";
			}
			pipeline.push({
				$project: compactProject,
			});
		}

		pipeline.push({ $sort: { createdAt: -1 } }); // newest first

		/* 5️⃣  Run the aggregation (no pagination; return all) */
		const docs = await HotelDetails.aggregate(pipeline)
			.allowDiskUse(true) // safer if dataset is large
			.exec();

		/* 6️⃣  Minimal owner projection (id, name, email) */
		const hotels = (docs || []).map((h) => {
			if (h.owner) {
				h.belongsTo = {
					_id: h.owner._id,
					name: h.owner.name,
					email: h.owner.email,
				};
			}
			delete h.owner;
			return sanitizeAgentRoomOverridesForViewer(h, null);
		});

		/* 7️⃣  Send (no page/pages since it's "all") */
		return res.json({
			total: hotels.length,
			results: hotels.length,
			hotels,
		});
	} catch (err) {
		console.error("listForAdminAll error:", err);
		return res.status(400).json({ error: "Failed to fetch all hotels" });
	}
};

exports.listOfHotelUser = async (req, res) => {
	try {
		const { accountId } = req.params;

		// Find all hotel details where the belongsTo field matches the accountId
		const hotels = await HotelDetails.find({ belongsTo: accountId });

		if (!hotels.length) {
			return res.status(404).json({
				message: "No hotels found for this user.",
			});
		}

		res
			.status(200)
			.json(hotels.map((hotel) => sanitizeAgentRoomOverridesForViewer(hotel, null)));
	} catch (error) {
		console.error("Error fetching hotels:", error);
		res.status(500).json({
			error: "An error occurred while fetching the hotels.",
		});
	}
};

/** ─────────────────────────────────────────────────────────────────────
 *  Owner payment method save/list/default/remove
 *  - Reuses paypalExchangeSetupToVault(setup_token_id)
 *  - Persists a sanitized record under HotelDetails.ownerPaymentMethods[]
 *  - Never stores PAN/CVV
 *  - Optional: verifies that requester owns the hotel (req.user)
 *  Endpoints wired below in routes
 *  ──────────────────────────────────────────────────────────────────── */

exports.saveOwnerPaymentMethod = async (req, res) => {
	try {
		const { hotelId } = req.params;
		const { setup_token, label, setDefault } = req.body || {};

		if (!mongoose.Types.ObjectId.isValid(hotelId)) {
			return res.status(400).json({ message: "Invalid hotelId." });
		}
		if (!setup_token) {
			return res.status(400).json({ message: "setup_token is required." });
		}

		const hotel = await HotelDetails.findById(hotelId).select(
			"_id belongsTo ownerPaymentMethods"
		);
		if (!hotel) return res.status(404).json({ message: "Hotel not found." });

		// Optional auth guard: only owner/admin can attach a payment method
		if (
			req.user &&
			String(hotel.belongsTo) !== String(req.user._id) &&
			String(req.user.role || "").toLowerCase() !== "admin"
		) {
			return res.status(403).json({ message: "Not allowed." });
		}

		// 1) Exchange setup_token -> PayPal vault payment token (no PAN/CVV)
		let tokenData;
		try {
			tokenData = await paypalExchangeSetupToVault(setup_token);
		} catch (e) {
			console.error("Owner vault exchange failed:", e?.response?.data || e);
			return res
				.status(400)
				.json({ message: "Unable to save card with PayPal." });
		}

		const vaultId = tokenData.id;
		const metaCard = tokenData?.payment_source?.card || {};
		const brand = metaCard.brand || null;
		const last4 = metaCard.last_digits || null;
		const exp = metaCard.expiry || null;

		// 2) De-dup: if same vault_id already saved (or same fingerprint), bail out
		const fingerprint = `${(brand || "").toUpperCase()}-${last4 || ""}-${
			exp || ""
		}`;
		const exists = (hotel.ownerPaymentMethods || []).some(
			(m) =>
				m.vault_id === vaultId ||
				`${(m.card_brand || "").toUpperCase()}-${m.card_last4 || ""}-${
					m.card_exp || ""
				}` === fingerprint
		);
		if (exists) {
			return res
				.status(409)
				.json({ message: "This payment method is already saved." });
		}

		// 3) If caller wants this to be default (or it's the first card), flip defaults off first
		const shouldBeDefault =
			!!setDefault || (hotel.ownerPaymentMethods || []).length === 0;
		if (shouldBeDefault && (hotel.ownerPaymentMethods || []).length > 0) {
			await HotelDetails.updateOne(
				{ _id: hotelId },
				{ $set: { "ownerPaymentMethods.$[].default": false } }
			);
		}

		// 4) Build sanitized payment-method record
		const record = {
			label:
				label ||
				`${brand ? brand.toUpperCase() : "CARD"} •••• ${last4 || "••••"}${
					exp ? ` (${exp})` : ""
				}`,
			vault_id: vaultId,
			vault_status: tokenData.status || "ACTIVE",
			vaulted_at: new Date(tokenData.create_time || Date.now()),
			card_brand: brand,
			card_last4: last4,
			card_exp: exp,
			billing_address: metaCard.billing_address || undefined,
			default: shouldBeDefault,
			active: true,
		};

		const updated = await HotelDetails.findByIdAndUpdate(
			hotelId,
			{ $push: { ownerPaymentMethods: record } },
			{ new: true }
		).lean();

		// return just the safe methods (no secrets anyway)
		const methods = (updated.ownerPaymentMethods || []).map((m) => ({
			label: m.label,
			vault_id: m.vault_id,
			vault_status: m.vault_status,
			vaulted_at: m.vaulted_at,
			card_brand: m.card_brand,
			card_last4: m.card_last4,
			card_exp: m.card_exp,
			billing_address: m.billing_address,
			default: m.default,
			active: m.active,
		}));

		return res.status(201).json({
			ok: true,
			message: "Payment method saved.",
			method: record,
			methods,
		});
	} catch (error) {
		console.error(
			"saveOwnerPaymentMethod error:",
			error?.response?.data || error
		);
		return res
			.status(500)
			.json({ message: "Failed to save owner payment method." });
	}
};

// (nice-to-have) list/manage helpers — optional but handy
exports.getOwnerPaymentMethods = async (req, res) => {
	try {
		const { hotelId } = req.params;
		if (!mongoose.Types.ObjectId.isValid(hotelId)) {
			return res.status(400).json({ message: "Invalid hotelId." });
		}
		const hotel = await HotelDetails.findById(hotelId)
			.select("ownerPaymentMethods belongsTo")
			.lean();
		if (!hotel) return res.status(404).json({ message: "Hotel not found." });

		if (
			req.user &&
			String(hotel.belongsTo) !== String(req.user._id) &&
			String(req.user.role || "").toLowerCase() !== "admin"
		) {
			return res.status(403).json({ message: "Not allowed." });
		}

		return res.json({ methods: hotel.ownerPaymentMethods || [] });
	} catch (e) {
		console.error("getOwnerPaymentMethods error:", e);
		return res.status(500).json({ message: "Failed to fetch methods." });
	}
};

exports.setOwnerDefaultPaymentMethod = async (req, res) => {
	try {
		const { hotelId, vaultId } = req.params;
		if (!mongoose.Types.ObjectId.isValid(hotelId) || !vaultId) {
			return res.status(400).json({ message: "Invalid params." });
		}
		const hotel = await HotelDetails.findById(hotelId)
			.select("belongsTo")
			.lean();
		if (!hotel) return res.status(404).json({ message: "Hotel not found." });

		if (
			req.user &&
			String(hotel.belongsTo) !== String(req.user._id) &&
			String(req.user.role || "").toLowerCase() !== "admin"
		) {
			return res.status(403).json({ message: "Not allowed." });
		}

		await HotelDetails.updateOne(
			{ _id: hotelId },
			{ $set: { "ownerPaymentMethods.$[].default": false } }
		);
		const updated = await HotelDetails.findOneAndUpdate(
			{ _id: hotelId, "ownerPaymentMethods.vault_id": vaultId },
			{ $set: { "ownerPaymentMethods.$.default": true } },
			{ new: true }
		).lean();

		if (!updated) return res.status(404).json({ message: "Method not found." });
		return res.json({
			ok: true,
			message: "Default updated.",
			methods: updated.ownerPaymentMethods,
		});
	} catch (e) {
		console.error("setOwnerDefaultPaymentMethod error:", e);
		return res.status(500).json({ message: "Failed to set default." });
	}
};

exports.removeOwnerPaymentMethod = async (req, res) => {
	try {
		const { hotelId, vaultId } = req.params;
		if (!mongoose.Types.ObjectId.isValid(hotelId) || !vaultId) {
			return res.status(400).json({ message: "Invalid params." });
		}
		const hotel = await HotelDetails.findById(hotelId)
			.select("belongsTo")
			.lean();
		if (!hotel) return res.status(404).json({ message: "Hotel not found." });

		if (
			req.user &&
			String(hotel.belongsTo) !== String(req.user._id) &&
			String(req.user.role || "").toLowerCase() !== "admin"
		) {
			return res.status(403).json({ message: "Not allowed." });
		}

		// Soft delete: active=false (keeps audit & avoids dangling defaults)
		const updated = await HotelDetails.findOneAndUpdate(
			{ _id: hotelId, "ownerPaymentMethods.vault_id": vaultId },
			{
				$set: {
					"ownerPaymentMethods.$.active": false,
					"ownerPaymentMethods.$.default": false,
				},
			},
			{ new: true }
		).lean();

		if (!updated) return res.status(404).json({ message: "Method not found." });
		return res.json({
			ok: true,
			message: "Payment method removed.",
			methods: updated.ownerPaymentMethods,
		});
	} catch (e) {
		console.error("removeOwnerPaymentMethod error:", e);
		return res
			.status(500)
			.json({ message: "Failed to remove payment method." });
	}
};
