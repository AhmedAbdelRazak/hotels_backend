/** @format */

"use strict";

const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const User = require("../models/user");
const HotelDetails = require("../models/hotel_details");
const Reservations = require("../models/reservations");
const Rooms = require("../models/rooms");
const HouseKeeping = require("../models/housekeeping");
const AgentWallet = require("../models/agent_wallet");
const SignupInvitation = require("../models/signup_invitation");
const PriceVariant = require("../models/price_variant");
const {
	buildHotelInventoryCalendarPayload,
	buildHotelInventoryDayPayload,
} = require("./hotel_inventory");
const {
	buildPendingConfirmationExclusionFilter,
} = require("../services/reservationStatus");
const {
	buildExcludePendingOtaReviewFilter,
} = require("../services/otaReservationVisibility");
const {
	trackFinancialReportExport,
	trackReservationExport,
	trackReservationSummaryExport,
	trackAccountCreation,
	trackAccountUpdate,
} = require("../services/activityTracker");
const {
	orchestrateRoomText,
} = require("../services/overallRoomTextOrchestrator");
const {
	normalizePriceVariantAssignments,
} = require("../services/priceVariantAssignmentService");
const {
	translatePriceVariantName,
} = require("../services/priceVariantNameTranslator");
const {
	buildAgentRow,
	buildGeneralRow,
	buildPricingPlan,
	ensurePlanSize,
	normalizeId: normalizeCalendarId,
	toDateKey: toCalendarDateKey,
} = require("../services/overallCalendarPricingOrchestrator");
const {
	sanitizeReservationAuditLogsCollectionForViewer,
} = require("../services/auditPrivacy");

const ObjectId = mongoose.Types.ObjectId;
const SYSTEM_ADMIN_ROLE = 10000;
const NEW_RESERVATION_PROCESS_START = new Date("2026-05-08T00:00:00.000Z");
const SIGNUP_INVITATION_PURPOSE = "public-signup-invitation";
const SIGNUP_INVITATION_DAYS = 30;
const EXECUTIVE_REPORT_START_DATE = new Date(Date.UTC(2025, 4, 1, 0, 0, 0, 0));
const EXECUTIVE_REPORT_TIMEZONE = "Asia/Riyadh";
const EXECUTIVE_PAID_BREAKDOWN_KEYS = [
	"paid_online_via_link",
	"paid_at_hotel_cash",
	"paid_at_hotel_card",
	"paid_to_hotel",
	"paid_online_jannatbooking",
	"paid_online_other_platforms",
	"paid_online_via_instapay",
	"paid_no_show",
];

const DONE_RESERVATION_STATUS =
	/checked[-_\s]?out|early[-_\s]?checked[-_\s]?out|closed|cancelled|canceled|no[-_\s]?show/i;
const CHECKED_OUT_STATUS = /checked[-_\s]?out|early[-_\s]?checked[-_\s]?out|closed/i;
const CONFIRMED_STATUS = /confirmed|^ok$/i;
const CANCELLED_STATUS = /cancelled|canceled/i;
const NO_SHOW_STATUS = /no[-_\s]?show/i;
const IN_HOUSE_STATUS = /house|in[-_\s]?house|checked[-_\s]?in/i;
const PENDING_CONFIRMATION_STATUS =
	/pending[-_\s]?confirmation|pending[-_\s]?finance[-_\s]?review|pending[-_\s]?agent[-_\s]?commission[-_\s]?approval|finance[-_\s]?rejected|rejected/i;
const PENDING_CONFIRMATION_ONLY_STATUS = /pending[-_\s]?confirmation/i;
const FINISHED_HOUSEKEEPING_STATUS = /^(finished|done|completed|clean)$/i;
const SUMMARY_DIRTY_ROOM_REASONS = new Set([
	"guest_checked_out",
	"housekeeping_task_open",
]);
const PENDING_FINANCE_REVIEW_STATUS = /pending[-_\s]?finance[-_\s]?review/i;
const PENDING_AGENT_COMMISSION_STATUS =
	/pending[-_\s]?agent[-_\s]?commission[-_\s]?approval/i;
const FINANCE_REJECTED_STATUS = /finance[-_\s]?rejected/i;
const REJECTED_STATUS = /^rejected$/i;
const ASSIGNED_COMMISSION_STATUSES = new Set([
	"commission due",
	"commission paid",
	"no commission due",
]);

const normalizeId = (value) => String(value?._id || value || "").trim();

const toBase64Url = (buffer) =>
	buffer
		.toString("base64")
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "");

const createInvitationCode = () => toBase64Url(crypto.randomBytes(24));

const hashInvitationCode = (code = "") =>
	crypto.createHash("sha256").update(String(code || "")).digest("hex");

const createInvitationRecord = async (payload = {}, actor = {}) => {
	for (let attempt = 0; attempt < 3; attempt += 1) {
		const code = createInvitationCode();
		try {
			await SignupInvitation.create({
				codeHash: hashInvitationCode(code),
				payload,
				createdBy: actor?._id || null,
				expiresAt: new Date(
					Date.now() + SIGNUP_INVITATION_DAYS * 24 * 60 * 60 * 1000
				),
			});
			return code;
		} catch (error) {
			if (error?.code !== 11000 || attempt === 2) throw error;
		}
	}
	return "";
};

const parseQueryList = (value) =>
	(Array.isArray(value) ? value : [value])
		.flatMap((item) => String(item || "").split(","))
		.map((item) => item.trim())
		.filter(Boolean);

const escapeRegex = (value = "") =>
	String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const publicSignupRoleOptions = new Set([
	"reception",
	"reservationemployee",
	"finance",
	"housekeeping",
	"housekeepingmanager",
	"hotelmanager",
]);

const normalizeInvitationType = (value = "") => {
	const normalized = String(value || "").trim().toLowerCase();
	if (["agent", "ordertaker", "order-taker", "external_agent"].includes(normalized)) {
		return "agent";
	}
	if (["job", "employee", "staff", "jobseeker", "job_applicant"].includes(normalized)) {
		return "job";
	}
	return "";
};

const normalizeInvitationRole = (value = "") => {
	const normalized = String(value || "").trim().toLowerCase();
	return publicSignupRoleOptions.has(normalized) ? normalized : "reception";
};

const configuredSuperAdminIds = () =>
	[process.env.SUPER_ADMIN_ID, process.env.REACT_APP_SUPER_ADMIN_ID]
		.flatMap((value) => String(value || "").split(","))
		.map((id) => String(id).trim())
		.filter(Boolean);

const isConfiguredSuperAdmin = (userOrId) => {
	const userId =
		typeof userOrId === "object" ? userOrId?._id || userOrId?.id : userOrId;
	return configuredSuperAdminIds().includes(String(userId || "").trim());
};

const roleNumbers = (user = {}) => {
	const account = user || {};
	return [
		Number(account.role),
		...(Array.isArray(account.roles) ? account.roles.map(Number) : []),
	];
};

const roleDescriptions = (user = {}) => {
	const account = user || {};
	return [
		String(account.roleDescription || "").toLowerCase(),
		...(Array.isArray(account.roleDescriptions)
			? account.roleDescriptions.map((item) => String(item || "").toLowerCase())
			: []),
	];
};

const normalizeRoleDescriptionKey = (value = "") =>
	String(value || "")
		.toLowerCase()
		.replace(/[\s_-]+/g, "");

const hasRole = (user = {}, role) => roleNumbers(user).includes(Number(role));

const hasRoleDescription = (user = {}, description = "") =>
	roleDescriptions(user)
		.map(normalizeRoleDescriptionKey)
		.includes(normalizeRoleDescriptionKey(description));

const isSuperAdmin = (user = {}) =>
	isConfiguredSuperAdmin(user) ||
	hasRole(user, 1000) ||
	hasRoleDescription(user, "super admin") ||
	hasRoleDescription(user, "superadmin");

const isSystemAdmin = (user = {}) =>
	hasRole(user, SYSTEM_ADMIN_ROLE) ||
	hasRoleDescription(user, "systemadmin") ||
	hasRoleDescription(user, "system admin");

const isRootOwner = (user = {}) =>
	hasRole(user, 2000) && !normalizeId(user.belongsToId);

const isOwnerLike = (user = {}) =>
	isSuperAdmin(user) || isRootOwner(user) || isSystemAdmin(user);

const isOrderTakingScope = (user = {}) => {
	const descriptions = roleDescriptions(user).map(normalizeRoleDescriptionKey);
	const accessTo = Array.isArray(user.accessTo) ? user.accessTo : [];
	return (
		hasRole(user, 7000) ||
		descriptions.includes("ordertaker") ||
		accessTo.includes("ownReservations")
	);
};

const includesId = (list = [], targetId = "") =>
	Array.isArray(list) &&
	list.some((item) => normalizeId(item) === normalizeId(targetId));

const uniqueValidIds = (values = []) => [
	...new Set(
		(Array.isArray(values) ? values : [values])
			.map(normalizeId)
			.filter((id) => id && ObjectId.isValid(id))
	),
];

const toObjectIds = (values = []) =>
	uniqueValidIds(values).map((id) => ObjectId(id));

const parseDateBoundary = (value = "", endOfDay = false) => {
	const text = String(value || "").trim();
	if (!text) return null;
	if (/[tT]/.test(text)) {
		const parsed = new Date(text);
		return Number.isNaN(parsed.getTime()) ? null : parsed;
	}
	const suffix = endOfDay ? "T23:59:59.999Z" : "T00:00:00.000Z";
	const parsed = new Date(`${text}${suffix}`);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const cleanDateRange = ({ dateFrom = "", dateTo = "", range = "all" } = {}) => {
	if (dateFrom || dateTo) {
		const start = parseDateBoundary(dateFrom, false);
		const end = parseDateBoundary(dateTo, true);
		return {
			from: start,
			to: end,
			range: "custom",
		};
	}

	const normalizedRange = String(range || "all").toLowerCase();
	if (normalizedRange === "all") {
		return { from: null, to: null, range: "all" };
	}

	const start = new Date();
	start.setHours(0, 0, 0, 0);
	const end = new Date();
	end.setHours(23, 59, 59, 999);

	if (normalizedRange === "yesterday") {
		start.setDate(start.getDate() - 1);
		end.setDate(end.getDate() - 1);
		return { from: start, to: end, range: "yesterday" };
	}

	if (normalizedRange === "last7") {
		start.setDate(start.getDate() - 6);
		return { from: start, to: end, range: "last7" };
	}

	return { from: start, to: end, range: "today" };
};

const normalizeDateField = (value = "") => {
	const normalized = String(value || "").trim();
	if (["checkin", "checkinDate", "check_in", "checkin_date"].includes(normalized))
		return "checkin_date";
	if (
		["checkout", "checkoutDate", "check_out", "checkout_date"].includes(
			normalized
		)
	)
		return "checkout_date";
	if (["createdAt", "created_at", "created"].includes(normalized))
		return "createdAt";
	if (["booked_at", "bookedAt", "bookingSortDate"].includes(normalized))
		return "booked_at";
	return "booked_at";
};

const selectedHotelIds = (hotels = []) =>
	hotels.map((hotel) => normalizeId(hotel._id)).filter((id) => ObjectId.isValid(id));

const selectedHotelObjectIds = (hotels = []) =>
	selectedHotelIds(hotels).map((id) => ObjectId(id));

const getDeclaredRoomsTotal = (hotel = {}) => {
	const directTotal = Number(hotel.overallRoomsCount || 0);
	if (directTotal > 0) return directTotal;

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

const extractReservationRoomIds = (roomId) => {
	if (!roomId) return [];
	if (Array.isArray(roomId)) return roomId.map(normalizeId).filter(Boolean);
	return [normalizeId(roomId)].filter(Boolean);
};

const setupSnapshot = (hotel = {}) => {
	const roomsDone = !!hotel?.roomCountDetails?.length;
	const photosDone = !!hotel?.hotelPhotos?.length;
	const locationDone =
		Array.isArray(hotel?.location?.coordinates) &&
		hotel.location.coordinates[0] !== 0 &&
		hotel.location.coordinates[1] !== 0;
	const dataDone = Boolean(
		hotel?.aboutHotel || hotel?.aboutHotelArabic || hotel?.overallRoomsCount
	);
	const bankDone = !!hotel?.paymentSettings?.length;
	return {
		roomsDone,
		photosDone,
		locationDone,
		dataDone,
		bankDone,
		settingsDone: roomsDone && photosDone && locationDone && dataDone,
		activationReady: roomsDone && photosDone && locationDone && dataDone,
		activeHotel:
			hotel?.activateHotel === true && hotel?.xHotelProActive !== false,
		ownerActivatedHotel: hotel?.activateHotel === true,
		xHotelProActive: hotel?.xHotelProActive !== false,
	};
};

const sanitizeUserForResponse = (user = {}) => {
	const plain = user?.toObject ? user.toObject() : { ...user };
	delete plain.hashed_password;
	delete plain.salt;
	delete plain.resetPasswordLink;
	return plain;
};

const sanitizeAccountForOverallResponse = (user = {}, allowedHotelIds = []) => {
	const plain = sanitizeUserForResponse(user);
	const allowed = new Set((allowedHotelIds || []).map(normalizeId).filter(Boolean));
	const keepAllowedHotels = (hotels = []) =>
		(Array.isArray(hotels) ? hotels : []).filter((hotel) =>
			allowed.has(normalizeId(hotel))
		);

	plain.hotelsToSupport = keepAllowedHotels(plain.hotelsToSupport);
	plain.hotelIdsOwner = keepAllowedHotels(plain.hotelIdsOwner);
	plain.priceVariantAssignments = (
		Array.isArray(plain.priceVariantAssignments) ? plain.priceVariantAssignments : []
	)
		.map((assignment) => ({
			priceVariantDataId: normalizeId(assignment.priceVariantDataId),
			priceVariantItemId: normalizeId(assignment.priceVariantItemId),
			pricingName: assignment.pricingName || "",
			pricingNameOtherLanguage: assignment.pricingNameOtherLanguage || "",
			hotelIds: keepAllowedHotels(assignment.hotelIds),
			assignedAt: assignment.assignedAt,
			assignedBy: normalizeId(assignment.assignedBy),
		}))
		.filter(
			(assignment) =>
				assignment.priceVariantDataId &&
				assignment.priceVariantItemId &&
				assignment.hotelIds.length
		);
	return plain;
};

const getActor = (req) => req.profile || null;

const getRequestedOwnerHotelFilter = async (ownerId = "", actor = {}) => {
	if (!ownerId || !ObjectId.isValid(ownerId)) return {};
	const owner = await User.findById(ownerId)
		.select("_id hotelIdsOwner")
		.lean()
		.exec();
	const ownerHotelIds = toObjectIds(owner?.hotelIdsOwner || []);
	return {
		$or: [
			{ belongsTo: ObjectId(ownerId) },
			...(ownerHotelIds.length ? [{ _id: { $in: ownerHotelIds } }] : []),
		],
	};
};

const getActorScopedHotelObjectIds = (actor = {}) =>
	toObjectIds([
		actor.hotelIdWork,
		...(Array.isArray(actor.hotelIdsWork) ? actor.hotelIdsWork : []),
		...(Array.isArray(actor.hotelIdsOwner) ? actor.hotelIdsOwner : []),
		...(Array.isArray(actor.hotelsToSupport) ? actor.hotelsToSupport : []),
	]);

const getAccessibleOverallHotels = async (actor = {}, query = {}) => {
	if (!actor?._id || actor.activeUser === false) return [];

	let hotelFilter = {};
	const scopedHotelIds = getActorScopedHotelObjectIds(actor);

	if (isSuperAdmin(actor)) {
		const ownerFilter = await getRequestedOwnerHotelFilter(
			normalizeId(query.ownerId),
			actor
		);
		if (Object.keys(ownerFilter).length) {
			hotelFilter = ownerFilter;
		} else {
			hotelFilter = {};
		}
	} else {
		const actorId = normalizeId(actor._id);
		const filters = [];
		if (isRootOwner(actor) && ObjectId.isValid(actorId)) {
			filters.push({ belongsTo: ObjectId(actorId) });
		}

		if (scopedHotelIds.length) {
			filters.push({ _id: { $in: scopedHotelIds } });
		}
		if (!filters.length) return [];
		hotelFilter = filters.length === 1 ? filters[0] : { $or: filters };
	}

	const hotels = await HotelDetails.find(hotelFilter)
		.select(
			"_id hotelName belongsTo hotelAddress hotelCountry hotelState hotelCity roomCountDetails overallRoomsCount hotelPhotos location aboutHotel aboutHotelArabic paymentSettings activateHotel xHotelProActive createdAt updatedAt"
		)
		.populate("belongsTo", "_id name email phone")
		.lean()
		.exec();

	if (isSuperAdmin(actor)) return hotels;

	return hotels.filter((hotel) => {
		const hotelId = normalizeId(hotel._id);
		const ownerId = normalizeId(hotel.belongsTo);
		const actorId = normalizeId(actor._id);
		return (
			(isRootOwner(actor) && actorId === ownerId) ||
			includesId(actor.hotelIdsOwner, hotelId) ||
			includesId(actor.hotelsToSupport, hotelId) ||
			(normalizeId(actor.hotelIdWork) === hotelId &&
				(!normalizeId(actor.belongsToId) ||
					normalizeId(actor.belongsToId) === ownerId))
		);
	});
};

const canAccessOverallSection = (actor = {}, section = "summary") => {
	if (isOwnerLike(actor)) return true;

	const roles = roleNumbers(actor);
	const descriptions = roleDescriptions(actor).map(normalizeRoleDescriptionKey);
	const hasAnyRole = (allowed = []) => allowed.some((role) => roles.includes(role));
	const hasAnyDescription = (allowed = []) =>
		allowed
			.map(normalizeRoleDescriptionKey)
			.some((role) => descriptions.includes(role));

	if (section === "reservations") {
		return (
			hasAnyRole([3000, 6000, 7000, 8000]) ||
			hasAnyDescription([
				"hotelmanager",
				"reception",
				"finance",
				"ordertaker",
				"reservationemployee",
			])
		);
	}

	if (section === "executive") {
		return (
			hasAnyRole([3000, 6000, 7000, 8000]) ||
			hasAnyDescription([
				"hotelmanager",
				"reception",
				"finance",
				"ordertaker",
				"reservationemployee",
			]) ||
			isOrderTakingScope(actor)
		);
	}

	if (section === "pending") {
		return (
			hasAnyRole([6000, 8000]) ||
			hasAnyDescription([
				"hotelmanager",
				"finance",
				"reservationemployee",
			]) ||
			isOrderTakingScope(actor)
		);
	}

	if (section === "financials") {
		return (
			hasAnyRole([6000]) ||
			hasAnyDescription(["hotelmanager", "finance"]) ||
			isOrderTakingScope(actor)
		);
	}

	if (section === "housekeeping") {
		return (
			hasAnyRole([4000, 5000]) ||
			hasAnyDescription(["hotelmanager", "housekeepingmanager", "housekeeping"])
		);
	}

	if (section === "hotel-map") {
		return (
			hasAnyRole([3000, 6000, 8000]) ||
			hasAnyDescription(["hotelmanager", "reception", "finance", "reservationemployee"])
		);
	}

	if (section === "settings") {
		return hasAnyRole([8000]) || hasAnyDescription(["hotelmanager", "reservationemployee"]);
	}

	return true;
};

const requireOverallSection = async (req, res, section) => {
	const actor = getActor(req);
	if (!actor || actor.activeUser === false) {
		res.status(401).json({ error: "Valid active user is required" });
		return null;
	}
	if (!canAccessOverallSection(actor, section)) {
		res.status(403).json({ error: "You cannot view this overall section" });
		return null;
	}
	const hotels = await getAccessibleOverallHotels(actor, req.query || {});
	return { actor, hotels };
};

const filterHotelIdsForQuery = (hotels = [], queryHotelId = "") => {
	const allIds = selectedHotelIds(hotels);
	const requestedIds = parseQueryList(queryHotelId);
	if (!requestedIds.length) return allIds;
	if (requestedIds.some((id) => !ObjectId.isValid(id))) return [];
	const requested = new Set(requestedIds);
	return allIds.filter((id) => requested.has(id));
};

const applyDateFilter = (match, query = {}) => {
	const dateField = normalizeDateField(query.dateBy || query.sortBy);
	const period = cleanDateRange(query);
	const dateFilter = {};
	if (period.from) dateFilter.$gte = period.from;
	if (period.to) dateFilter.$lte = period.to;
	if (Object.keys(dateFilter).length) match[dateField] = dateFilter;
	return { dateField, period };
};

const bucketDateFilterFromQuery = (query = {}) => {
	const bucketDateBy = query.bucketDateBy || query.bucketDateField || "";
	const bucketDateFrom = query.bucketDateFrom || query.bucketFrom || "";
	const bucketDateTo = query.bucketDateTo || query.bucketTo || "";
	if (!bucketDateBy || (!bucketDateFrom && !bucketDateTo)) return null;

	const dateField = normalizeDateField(bucketDateBy);
	const period = cleanDateRange({
		dateFrom: bucketDateFrom,
		dateTo: bucketDateTo,
		range: "custom",
	});
	const dateFilter = {};
	if (period.from) dateFilter.$gte = period.from;
	if (period.to) dateFilter.$lte = period.to;
	return Object.keys(dateFilter).length ? { [dateField]: dateFilter } : null;
};

const reservationPrimaryStatusMissingFilter = () => ({
	$or: [
		{ reservation_status: { $exists: false } },
		{ reservation_status: null },
		{ reservation_status: "" },
	],
});

const reservationStatusOrStateFallbackFilter = (statusMatcher) => ({
	$or: [
		{ reservation_status: statusMatcher },
		{
			$and: [
				reservationPrimaryStatusMissingFilter(),
				{ state: statusMatcher },
			],
		},
	],
});

const singleReservationStatusFilter = (status = "") => {
	const normalized = String(status || "").trim().toLowerCase();
	const statusKey = normalized.replace(/[_-]+/g, " ").replace(/\s+/g, " ");
	if (!normalized || normalized === "all") return null;
	if (statusKey === "active") {
		return {
			$nor: [
				{ reservation_status: DONE_RESERVATION_STATUS },
				{ state: DONE_RESERVATION_STATUS },
			],
		};
	}
	if (statusKey === "cancelled" || statusKey === "canceled")
		return reservationStatusOrStateFallbackFilter(CANCELLED_STATUS);
	if (statusKey === "confirmed" || statusKey === "ok")
		return reservationStatusOrStateFallbackFilter(CONFIRMED_STATUS);
	if (statusKey === "no show")
		return reservationStatusOrStateFallbackFilter(NO_SHOW_STATUS);
	if (["inhouse", "in house", "checked in"].includes(statusKey))
		return reservationStatusOrStateFallbackFilter(IN_HOUSE_STATUS);
	if (
		/^(early\s*)?checked\s*out$/.test(statusKey) ||
		statusKey === "closed"
	)
		return reservationStatusOrStateFallbackFilter(CHECKED_OUT_STATUS);
	if (statusKey === "pending finance review")
		return reservationStatusOrStateFallbackFilter(PENDING_FINANCE_REVIEW_STATUS);
	if (statusKey === "pending agent commission approval")
		return reservationStatusOrStateFallbackFilter(PENDING_AGENT_COMMISSION_STATUS);
	if (statusKey === "finance rejected")
		return reservationStatusOrStateFallbackFilter(FINANCE_REJECTED_STATUS);
	if (statusKey === "rejected") return rejectedWorkflowFilterForActor();
	if (statusKey === "pending") {
		return {
			$or: [
				{ reservation_status: PENDING_CONFIRMATION_STATUS },
				{
					$and: [
						reservationPrimaryStatusMissingFilter(),
						{ state: PENDING_CONFIRMATION_STATUS },
					],
				},
				{ "pendingConfirmation.status": { $in: ["pending", "rejected"] } },
				{ "agentDecisionSnapshot.status": { $in: ["pending", "rejected"] } },
			],
		};
	}
	const regex = new RegExp(escapeRegex(statusKey).replace(/\\ /g, "[-_\\s]?"), "i");
	return reservationStatusOrStateFallbackFilter(regex);
};

const reservationStatusFilter = (status = "") => {
	const statuses = parseQueryList(status).filter(
		(item) => String(item || "").trim().toLowerCase() !== "all"
	);
	if (!statuses.length) return null;
	const filters = statuses
		.map((item) => singleReservationStatusFilter(item))
		.filter(Boolean);
	if (!filters.length) return null;
	return filters.length === 1 ? filters[0] : { $or: filters };
};

const statusFilterNeedsCancelledScope = (status = "") =>
	parseQueryList(status).some((item) =>
		/cancel|canceled|no[-_\s]?show/i.test(String(item || ""))
	);

const isOrderTakerOnly = (actor = {}) => {
	const roles = roleNumbers(actor);
	const descriptions = roleDescriptions(actor).map(normalizeRoleDescriptionKey);
	const hasOrderTaking =
		roles.includes(7000) ||
		descriptions.includes("ordertaker") ||
		(Array.isArray(actor.accessTo) && actor.accessTo.includes("ownReservations"));
	const hasFullAccess =
		[1000, 2000, 3000, 8000, SYSTEM_ADMIN_ROLE].some((role) =>
			roles.includes(role)
		) ||
		descriptions.some((role) =>
			["hotelmanager", "reception", "reservationemployee", "systemadmin"].includes(
				role
			)
		);
	return hasOrderTaking && !hasFullAccess;
};

const isManagerOrAdminForPending = (actor = {}) =>
	isOwnerLike(actor) || hasRoleDescription(actor, "hotelmanager");

const isFinanceForPending = (actor = {}) =>
	hasRole(actor, 6000) || hasRoleDescription(actor, "finance");

const isReservationEmployeeForPending = (actor = {}) =>
	hasRole(actor, 8000) || hasRoleDescription(actor, "reservationemployee");

const pendingWorkflowScopeForActor = (actor = {}) => {
	if (
		isFinanceForPending(actor) &&
		!isManagerOrAdminForPending(actor) &&
		!isReservationEmployeeForPending(actor)
	) {
		return "commission";
	}
	if (
		isReservationEmployeeForPending(actor) &&
		!isManagerOrAdminForPending(actor) &&
		!isFinanceForPending(actor)
	) {
		return "pending";
	}
	return "all";
};

const newReservationProcessFilter = () => ({
	$or: [
		{ booked_at: { $gte: NEW_RESERVATION_PROCESS_START } },
		{
			$and: [
				{ $or: [{ booked_at: { $exists: false } }, { booked_at: null }] },
				{ createdAt: { $gte: NEW_RESERVATION_PROCESS_START } },
			],
		},
	],
});

const pendingConfirmationOnlyFilter = () => ({
	$or: [
		{ reservation_status: PENDING_CONFIRMATION_STATUS },
		{ state: PENDING_CONFIRMATION_STATUS },
		{ "pendingConfirmation.status": { $in: ["pending", "rejected"] } },
		{ "agentDecisionSnapshot.status": { $in: ["pending", "rejected"] } },
	],
});

const legacyPendingConfirmationStatusFilter = () => ({
	$or: [
		{ reservation_status: PENDING_CONFIRMATION_ONLY_STATUS },
		{
			$and: [
				reservationPrimaryStatusMissingFilter(),
				{ state: PENDING_CONFIRMATION_ONLY_STATUS },
			],
		},
		{ "pendingConfirmation.status": "pending" },
	],
});

const pendingFinanceReviewFilter = () => ({
	$or: [
		{ reservation_status: PENDING_FINANCE_REVIEW_STATUS },
		{ state: PENDING_FINANCE_REVIEW_STATUS },
		{ reservation_status: PENDING_AGENT_COMMISSION_STATUS },
		{ state: PENDING_AGENT_COMMISSION_STATUS },
		{ reservation_status: FINANCE_REJECTED_STATUS },
		{ state: FINANCE_REJECTED_STATUS },
		{
			$and: [
				pendingFinanceWorkflowReadyFilter(),
				{
					$or: [
						{ "financial_cycle.totalReviewStatus": { $exists: false } },
						{ "financial_cycle.totalReviewStatus": null },
						{ "financial_cycle.totalReviewStatus": "" },
						{ "financial_cycle.totalReviewStatus": "pending" },
					],
				},
			],
		},
		{ "financial_cycle.totalReviewStatus": "rejected" },
		{ "commissionAgentApproval.status": { $in: ["pending", "rejected"] } },
	],
});

const pendingFinanceWorkflowReadyFilter = () => ({
	$or: [
		{ "pendingConfirmation.status": "confirmed" },
		{ reservation_status: PENDING_FINANCE_REVIEW_STATUS },
		{ state: PENDING_FINANCE_REVIEW_STATUS },
		{ reservation_status: PENDING_AGENT_COMMISSION_STATUS },
		{ state: PENDING_AGENT_COMMISSION_STATUS },
		{ reservation_status: FINANCE_REJECTED_STATUS },
		{ state: FINANCE_REJECTED_STATUS },
	],
});

const pendingWorkflowFilterForActor = (actor = {}) => {
	const scope = pendingWorkflowScopeForActor(actor);
	const reasonFilters =
		scope === "commission"
			? [financialCommissionMissingFilter(), pendingFinanceReviewFilter()]
			: scope === "pending"
			? [pendingConfirmationOnlyFilter()]
			: [
					pendingConfirmationOnlyFilter(),
					financialCommissionMissingFilter(),
					pendingFinanceReviewFilter(),
			  ];
	const workflowFilters = [
		{
			$and: [
				newReservationProcessFilter(),
				...(scope === "commission" ? [pendingFinanceWorkflowReadyFilter()] : []),
				{ $or: reasonFilters },
			],
		},
	];

	if (scope !== "commission") {
		workflowFilters.push(legacyPendingConfirmationStatusFilter());
	}

	return {
		$or: workflowFilters,
	};
};

const rejectedWorkflowFilterForActor = () => ({
	$or: [
		{ reservation_status: REJECTED_STATUS },
		{ state: REJECTED_STATUS },
		{ reservation_status: FINANCE_REJECTED_STATUS },
		{ state: FINANCE_REJECTED_STATUS },
		{ "pendingConfirmation.status": "rejected" },
		{ "agentDecisionSnapshot.status": "rejected" },
		{ "financial_cycle.totalReviewStatus": "rejected" },
		{ "commissionAgentApproval.status": "rejected" },
	],
});

const buildReservationMatch = ({
	actor,
	hotels,
	query = {},
	pendingOnly = false,
	rejectedOnly = false,
}) => {
	const hotelIds = filterHotelIdsForQuery(hotels, query.hotelId);
	if (!hotelIds.length) return null;

	const match = { hotelId: { $in: hotelIds.map((id) => ObjectId(id)) } };
	const scorecardScope = String(query.scorecardScope || "").trim().toLowerCase();
	const actionRequiredOnly =
		["1", "true", "yes"].includes(
			String(query.actionRequiredOnly || "").toLowerCase()
		) || scorecardScope === "actionrequired";
	if (scorecardScope === "today") {
		const todayRange = riyadhTodayRange();
		match.createdAt = { $gte: todayRange.start, $lte: todayRange.end };
	} else if (!actionRequiredOnly) {
		applyDateFilter(match, query);
	}

	const clauses = [buildExcludePendingOtaReviewFilter()];
	const includeCancelled =
		String(query.includeCancelled || "").toLowerCase() === "true";
	const excludeCancelled =
		String(query.excludeCancelled || "").toLowerCase() === "true";
	if (
		excludeCancelled &&
		!includeCancelled &&
		!statusFilterNeedsCancelledScope(query.status)
	) {
		clauses.push({
			$nor: [
				{ reservation_status: CANCELLED_STATUS },
				{ state: CANCELLED_STATUS },
				{ reservation_status: NO_SHOW_STATUS },
				{ state: NO_SHOW_STATUS },
			],
		});
	}
	const statusFilter = reservationStatusFilter(query.status);
	if (statusFilter) clauses.push(statusFilter);
	const bookingSources = parseQueryList(query.bookingSource);
	if (bookingSources.length) {
		clauses.push({
			$or: bookingSources.map((source) => ({
				booking_source: new RegExp(escapeRegex(source), "i"),
			})),
		});
	}
	if (query.payment) {
		clauses.push({ payment: new RegExp(escapeRegex(query.payment), "i") });
	}
	const bucketDateFilter = bucketDateFilterFromQuery(query);
	if (bucketDateFilter) clauses.push(bucketDateFilter);
	if (isOrderTakerOnly(actor)) {
		const actorId = normalizeId(actor._id);
		if (ObjectId.isValid(actorId)) {
			clauses.push({
				$or: [
					{ createdByUserId: ObjectId(actorId) },
					{ "createdBy._id": actorId },
					{ orderTakeId: ObjectId(actorId) },
					{ "orderTaker._id": actorId },
				],
			});
		}
	}
	if (actionRequiredOnly) {
		clauses.push(pendingWorkflowFilterForActor(actor));
	}
	if (pendingOnly) {
		clauses.push(pendingWorkflowFilterForActor(actor));
	}
	if (rejectedOnly) {
		clauses.push(rejectedWorkflowFilterForActor(actor));
	}

	if (clauses.length) match.$and = clauses;
	return match;
};

const reservationSearchStage = (search = "") => {
	const trimmed = String(search || "").trim();
	if (!trimmed) return null;
	const isRoomSearch = /^r\d+$/i.test(trimmed);
	const queryValue = isRoomSearch ? trimmed.substring(1) : trimmed;
	const regex = new RegExp(escapeRegex(queryValue), "i");
	if (isRoomSearch) return { "roomDetails.room_number": regex };
	return {
		$or: [
			{ "customer_details.name": regex },
			{ "customer_details.phone": regex },
			{ "customer_details.email": regex },
			{ "customer_details.passport": regex },
			{ "customer_details.nationality": regex },
			{ confirmation_number: regex },
			{ reservation_id: regex },
			{ pms_number: regex },
			{ reservation_status: regex },
			{ booking_source: regex },
			{ payment: regex },
			{ "roomDetails.room_number": regex },
			{ "hotelDetails.hotelName": regex },
		],
	};
};

const reservationLookupStages = () => [
	{
		$lookup: {
			from: "rooms",
			localField: "roomId",
			foreignField: "_id",
			as: "roomDetails",
		},
	},
	{
		$lookup: {
			from: "hoteldetails",
			localField: "hotelId",
			foreignField: "_id",
			as: "hotelDetails",
		},
	},
	{ $unwind: { path: "$hotelDetails", preserveNullAndEmptyArrays: true } },
	{
		$addFields: {
			hotelName: { $ifNull: ["$hotelDetails.hotelName", ""] },
			hotelOwnerId: "$hotelDetails.belongsTo",
			bookingSortDate: { $ifNull: ["$booked_at", "$createdAt"] },
			hotelVisibleTotalAmount: hotelVisibleReservationAmountExpression(),
			total_amount: hotelVisibleReservationAmountExpression(),
		},
	},
];

const sortFromQuery = (query = {}) => {
	const allowed = new Set([
		"booked_at",
		"createdAt",
		"checkin_date",
		"checkout_date",
		"total_amount",
		"reservation_status",
		"booking_source",
		"hotelName",
		"updatedAt",
	]);
	const field = allowed.has(query.sortBy) ? query.sortBy : "bookingSortDate";
	const direction = String(query.sortOrder || "desc").toLowerCase() === "asc" ? 1 : -1;
	return { [field]: direction, _id: -1 };
};

const bookingSourceOptionsFromMatch = async (match) => {
	if (!match) return [];
	const rows = await Reservations.aggregate([
		{ $match: match },
		{
			$group: {
				_id: {
					$trim: {
						input: { $ifNull: ["$booking_source", ""] },
					},
				},
				count: { $sum: 1 },
			},
		},
		{ $match: { _id: { $ne: "" } } },
		{ $sort: { _id: 1 } },
	]);
	return rows.map((row) => ({
		source: row._id,
		count: row.count || 0,
	}));
};

const reservationFilterHotelsForResponse = (hotels = []) =>
	(Array.isArray(hotels) ? hotels : []).map((hotel = {}) => ({
		_id: hotel._id,
		hotelName: hotel.hotelName || "",
		belongsTo: hotel.belongsTo || hotel.ownerId || "",
	}));

const emptyReservationScorecards = () => ({
	totals: {
		reservationsCount: 0,
		totalAmount: 0,
		nights: 0,
		hotelsCount: 0,
		todayCreated: 0,
	},
	today: {
		reservationsCount: 0,
		totalAmount: 0,
		nights: 0,
		hotelsCount: 0,
	},
	actionRequired: {
		reservationsCount: 0,
		totalAmount: 0,
		nights: 0,
		hotelsCount: 0,
	},
	statusCounts: {
		confirmed: 0,
		pending: 0,
		inHouse: 0,
		checkedOut: 0,
		cancelled: 0,
		noShow: 0,
		other: 0,
	},
	todayStatusCounts: {
		confirmed: 0,
		pending: 0,
		inHouse: 0,
		checkedOut: 0,
		cancelled: 0,
		noShow: 0,
		other: 0,
	},
});

const riyadhTodayRange = () => {
	const parts = new Intl.DateTimeFormat("en-US", {
		timeZone: EXECUTIVE_REPORT_TIMEZONE,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).formatToParts(new Date());
	const partValue = (type) =>
		parts.find((part) => part.type === type)?.value || "";
	const dateText = `${partValue("year")}-${partValue("month")}-${partValue("day")}`;
	return {
		start: new Date(`${dateText}T00:00:00.000+03:00`),
		end: new Date(`${dateText}T23:59:59.999+03:00`),
	};
};

const reservationListRoomNightsExpression = () => ({
	$cond: [
		{ $gt: [reservationNumberExpression("$days_of_residence"), 0] },
		reservationNumberExpression("$days_of_residence"),
		{
			$cond: [
				{
					$and: [
						{ $ne: ["$checkin_date", null] },
						{ $ne: ["$checkout_date", null] },
					],
				},
				{
					$max: [
						0,
						{
							$dateDiff: {
								startDate: "$checkin_date",
								endDate: "$checkout_date",
								unit: "day",
							},
						},
					],
				},
				0,
			],
		},
	],
});

const reservationNumberExpression = (field) => ({
	$convert: {
		input: field,
		to: "double",
		onError: 0,
		onNull: 0,
	},
});

const hotelVisibleReservationAmountExpression = () => ({
	$cond: [
		{ $eq: ["$adminPricingVisibility.rootOnlyForHotelManagement", true] },
		{
			$let: {
				vars: {
					rootTotal: reservationNumberExpression("$adminPricing.rootTotal"),
					subTotal: reservationNumberExpression("$sub_total"),
					totalAmount: reservationNumberExpression("$total_amount"),
				},
				in: {
					$cond: [
						{ $gt: ["$$rootTotal", 0] },
						"$$rootTotal",
						{
							$cond: [
								{ $gt: ["$$subTotal", 0] },
								"$$subTotal",
								"$$totalAmount",
							],
						},
					],
				},
			},
		},
		reservationNumberExpression("$total_amount"),
	],
});

const hotelVisibleReservationAmount = (reservation = {}) => {
	if (
		reservation?.adminPricingVisibility?.rootOnlyForHotelManagement === true
	) {
		return (
			moneyNumber(reservation?.adminPricing?.rootTotal) ||
			moneyNumber(reservation.sub_total) ||
			moneyNumber(reservation.total_amount)
		);
	}
	return moneyNumber(reservation.total_amount);
};

const reservationScorecardGroupStage = () => ({
	$group: {
		_id: null,
		reservationsCount: { $sum: 1 },
		totalAmount: { $sum: hotelVisibleReservationAmountExpression() },
		nights: { $sum: reservationListRoomNightsExpression() },
		hotels: { $addToSet: "$hotelId" },
	},
});

const reservationScorecardProjectStage = () => ({
	$project: {
		_id: 0,
		reservationsCount: 1,
		totalAmount: 1,
		nights: 1,
		hotelsCount: { $size: "$hotels" },
	},
});

const reservationStatusBucketKey = (bucket = {}) => {
	const status = String(bucket.status || "");
	const state = String(bucket.state || "");
	const combined = `${status} ${state}`;
	const pendingConfirmationStatus = String(
		bucket.pendingConfirmationStatus || ""
	).toLowerCase();
	const agentDecisionStatus = String(bucket.agentDecisionStatus || "").toLowerCase();

	if (NO_SHOW_STATUS.test(combined)) return "noShow";
	if (CANCELLED_STATUS.test(combined)) return "cancelled";
	if (CHECKED_OUT_STATUS.test(combined)) return "checkedOut";
	if (IN_HOUSE_STATUS.test(combined)) return "inHouse";
	if (
		PENDING_CONFIRMATION_STATUS.test(combined) ||
		["pending", "rejected"].includes(pendingConfirmationStatus) ||
		["pending", "rejected"].includes(agentDecisionStatus)
	) {
		return "pending";
	}
	if (CONFIRMED_STATUS.test(combined)) return "confirmed";
	return "other";
};

const buildReservationScorecards = async ({
	actor,
	hotels,
	query,
	pendingOnly,
	rejectedOnly,
}) => {
	const scorecardQuery = {
		hotelId: (query || {}).hotelId || "",
	};
	const scorecardMatch = buildReservationMatch({
		actor,
		hotels,
		query: scorecardQuery,
		pendingOnly,
		rejectedOnly,
	});
	if (!scorecardMatch) return emptyReservationScorecards();

	const todayRange = riyadhTodayRange();

	const [facet = {}] = await Reservations.aggregate([
		{ $match: scorecardMatch },
		{
			$facet: {
				totals: [
					reservationScorecardGroupStage(),
					reservationScorecardProjectStage(),
				],
				today: [
					{
						$match: {
							createdAt: { $gte: todayRange.start, $lte: todayRange.end },
						},
					},
					reservationScorecardGroupStage(),
					reservationScorecardProjectStage(),
				],
				actionRequired: [
					{
						$match: rejectedOnly
							? rejectedWorkflowFilterForActor(actor)
							: pendingWorkflowFilterForActor(actor),
					},
					reservationScorecardGroupStage(),
					reservationScorecardProjectStage(),
				],
				todayStatuses: [
					{
						$match: {
							createdAt: { $gte: todayRange.start, $lte: todayRange.end },
						},
					},
					{
						$group: {
							_id: {
								status: { $ifNull: ["$reservation_status", ""] },
								state: { $ifNull: ["$state", ""] },
								pendingConfirmationStatus: {
									$ifNull: ["$pendingConfirmation.status", ""],
								},
								agentDecisionStatus: {
									$ifNull: ["$agentDecisionSnapshot.status", ""],
								},
							},
							count: { $sum: 1 },
						},
					},
				],
			},
		},
	]);

	const empty = emptyReservationScorecards();
	const totals = facet.totals?.[0] || empty.totals;
	const today = facet.today?.[0] || empty.today;
	const actionRequired = facet.actionRequired?.[0] || empty.actionRequired;
	const todayStatusCounts = { ...empty.todayStatusCounts };
	(facet.todayStatuses || []).forEach((row) => {
		const key = reservationStatusBucketKey(row._id || {});
		todayStatusCounts[key] =
			(todayStatusCounts[key] || 0) + Number(row.count || 0);
	});

	return {
		totals: {
			reservationsCount: Number(totals.reservationsCount || 0),
			totalAmount: moneyNumber(totals.totalAmount),
			nights: Number(totals.nights || 0),
			hotelsCount: Number(totals.hotelsCount || 0),
			todayCreated: Number(today.reservationsCount || 0),
		},
		today: {
			reservationsCount: Number(today.reservationsCount || 0),
			totalAmount: moneyNumber(today.totalAmount),
			nights: Number(today.nights || 0),
			hotelsCount: Number(today.hotelsCount || 0),
		},
		actionRequired: {
			reservationsCount: Number(actionRequired.reservationsCount || 0),
			totalAmount: moneyNumber(actionRequired.totalAmount),
			nights: Number(actionRequired.nights || 0),
			hotelsCount: Number(actionRequired.hotelsCount || 0),
		},
		statusCounts: todayStatusCounts,
		todayStatusCounts,
	};
};

const listReservations = async ({
	actor,
	hotels,
	query,
	pendingOnly = false,
	rejectedOnly = false,
}) => {
	const match = buildReservationMatch({
		actor,
		hotels,
		query,
		pendingOnly,
		rejectedOnly,
	});
	if (!match) {
		return {
			page: 1,
			limit: 0,
			total: 0,
			pages: 0,
			reservations: [],
			hotels: reservationFilterHotelsForResponse(hotels),
			bookingSources: [],
			scorecards: emptyReservationScorecards(),
		};
	}

	const page = Math.max(parseInt(query.page, 10) || 1, 1);
	const limit = Math.min(Math.max(parseInt(query.limit, 10) || 25, 1), 100);
	const exportAll = ["1", "true", "yes", "all"].includes(
		String(query.exportAll || "").toLowerCase()
	);
	const search = reservationSearchStage(query.search);
	const basePipeline = [{ $match: match }, ...reservationLookupStages()];
	if (search) basePipeline.push({ $match: search });
	const bookingSourceMatch = pendingOnly || rejectedOnly
		? buildReservationMatch({
				actor,
				hotels,
				query: { ...query, bookingSource: "" },
				pendingOnly,
				rejectedOnly,
		  })
		: null;

	const [countResult, rows, bookingSources, scorecards] = await Promise.all([
		Reservations.aggregate([...basePipeline, { $count: "total" }]),
		Reservations.aggregate([
			...basePipeline,
			{ $sort: sortFromQuery(query) },
			...(exportAll ? [] : [{ $skip: (page - 1) * limit }, { $limit: limit }]),
			{
				$project: {
					hotelDetails: 0,
				},
			},
		]),
		pendingOnly || rejectedOnly
			? bookingSourceOptionsFromMatch(bookingSourceMatch)
			: [],
		buildReservationScorecards({
			actor,
			hotels,
			query,
			pendingOnly,
			rejectedOnly,
		}),
	]);
	const total = countResult?.[0]?.total || 0;
	const hotelVisibleRows = sanitizeReservationAuditLogsCollectionForViewer(rows);
	return {
		page: exportAll ? 1 : page,
		limit: exportAll ? total : limit,
		total,
		pages: exportAll ? 1 : Math.ceil(total / limit),
		reservations: hotelVisibleRows,
		hotels: reservationFilterHotelsForResponse(hotels),
		bookingSources,
		scorecards,
	};
};

const moneyNumber = (value) => {
	if (value === null || value === undefined || value === "") return 0;
	const parsed = Number(String(value).replace(/,/g, "").trim());
	return Number.isFinite(parsed) ? parsed : 0;
};

const executivePaidBreakdownTotalExpression = () => ({
	$add: EXECUTIVE_PAID_BREAKDOWN_KEYS.map((key) => ({
		$ifNull: [`$paid_amount_breakdown.${key}`, 0],
	})),
});

const executiveStoredCommissionExpression = () => ({
	$cond: [
		{ $gt: [{ $ifNull: ["$commission", 0] }, 0] },
		{ $ifNull: ["$commission", 0] },
		{ $ifNull: ["$financial_cycle.commissionAmount", 0] },
	],
});

const executiveRoomNightsExpression = () => ({
	$cond: [
		{ $gt: [{ $ifNull: ["$days_of_residence", 0] }, 0] },
		{ $ifNull: ["$days_of_residence", 0] },
		{
			$cond: [
				{
					$and: [
						{ $ne: ["$checkin_date", null] },
						{ $ne: ["$checkout_date", null] },
					],
				},
				{
					$max: [
						0,
						{
							$dateDiff: {
								startDate: "$checkin_date",
								endDate: "$checkout_date",
								unit: "day",
							},
						},
					],
				},
				0,
			],
		},
	],
});

const executiveGroupTotals = () => ({
	reservationsCount: { $sum: 1 },
	total_amount: { $sum: hotelVisibleReservationAmountExpression() },
	roomNights: { $sum: executiveRoomNightsExpression() },
	commission: { $sum: executiveStoredCommissionExpression() },
	paidAmount: {
		$sum: {
			$cond: [
				{ $gt: ["$paidBreakdownTotal", 0] },
				"$paidBreakdownTotal",
				{ $ifNull: ["$paid_amount", 0] },
			],
		},
	},
	capturedCount: {
		$sum: { $cond: [{ $gt: ["$paidBreakdownTotal", 0] }, 1, 0] },
	},
});

const executiveDateString = (field) => ({
	$dateToString: {
		format: "%Y-%m-%d",
		date: `$${field}`,
		timezone: EXECUTIVE_REPORT_TIMEZONE,
	},
});

const mergeMatchDatePresence = (match = {}, field = "createdAt") => {
	const next = { ...match };
	const existing = next[field];
	const existingObject =
		existing &&
		typeof existing === "object" &&
		!Array.isArray(existing) &&
		!(existing instanceof Date);
	next[field] = {
		...(existingObject ? existing : {}),
		$ne: null,
	};
	return next;
};

const executiveHotelOptions = (hotels = []) =>
	hotels.map((hotel) => ({
		_id: normalizeId(hotel._id),
		hotelName: hotel.hotelName || "Hotel",
		ownerId: normalizeId(hotel.belongsTo),
		ownerName: hotel.belongsTo?.name || "",
	}));

const executiveReservationSearchFilter = (search = "", hotels = []) => {
	const trimmed = String(search || "").trim();
	if (!trimmed) return null;
	const regex = new RegExp(escapeRegex(trimmed), "i");
	const matchingHotelIds = hotels
		.filter((hotel) => regex.test(String(hotel.hotelName || "")))
		.map((hotel) => normalizeId(hotel._id))
		.filter((id) => ObjectId.isValid(id))
		.map((id) => ObjectId(id));

	return {
		$or: [
			{ confirmation_number: regex },
			{ reservation_id: regex },
			{ pms_number: regex },
			{ "customer_details.name": regex },
			{ "customer_details.fullName": regex },
			{ "customer_details.phone": regex },
			{ "customer_details.email": regex },
			{ booking_source: regex },
			{ payment: regex },
			{ reservation_status: regex },
			...(matchingHotelIds.length ? [{ hotelId: { $in: matchingHotelIds } }] : []),
		],
	};
};

const summaryOperationalReservationFilter = ({ includeCancelled = false } = {}) => {
	const excludedStatuses = [
		{ reservation_status: PENDING_CONFIRMATION_STATUS },
		{ state: PENDING_CONFIRMATION_STATUS },
	];
	if (!includeCancelled) {
		excludedStatuses.push(
			{ reservation_status: CANCELLED_STATUS },
			{ state: CANCELLED_STATUS },
			{ reservation_status: NO_SHOW_STATUS },
			{ state: NO_SHOW_STATUS }
		);
	}
	return {
		$nor: excludedStatuses,
		$and: [
			buildPendingConfirmationExclusionFilter(),
			buildExcludePendingOtaReviewFilter(),
		],
	};
};

const buildExecutiveReservationMatch = ({ actor, hotels, query = {} }) => {
	const hotelIds = filterHotelIdsForQuery(hotels, query.hotelId);
	if (!hotelIds.length) return null;

	const match = { hotelId: { $in: hotelIds.map((id) => ObjectId(id)) } };
	const dateField = normalizeDateField(query.dateBy || "createdAt");
	const period = cleanDateRange(query);
	const dateFilter = {};

	if (period.from) dateFilter.$gte = period.from;
	if (period.to) dateFilter.$lte = period.to;
	if (Object.keys(dateFilter).length) {
		match[dateField] = dateFilter;
	} else {
		match.createdAt = { $gte: EXECUTIVE_REPORT_START_DATE };
	}

	const clauses = [buildExcludePendingOtaReviewFilter()];
	const includeCancelled =
		String(query.includeCancelled || "").toLowerCase() === "true";
	const excludeCancelled =
		String(query.excludeCancelled ?? "true").toLowerCase() !== "false";
	if (!includeCancelled && excludeCancelled) {
		clauses.push({
			$nor: [
				{ reservation_status: CANCELLED_STATUS },
				{ state: CANCELLED_STATUS },
				{ reservation_status: NO_SHOW_STATUS },
				{ state: NO_SHOW_STATUS },
			],
		});
	}

	const statusFilter = reservationStatusFilter(query.status);
	if (statusFilter) clauses.push(statusFilter);

	const bookingSources = parseQueryList(query.bookingSource);
	if (bookingSources.length) {
		clauses.push({
			$or: bookingSources.map((source) => ({
				booking_source: new RegExp(escapeRegex(source), "i"),
			})),
		});
	}

	if (query.payment) {
		clauses.push({ payment: new RegExp(escapeRegex(query.payment), "i") });
	}
	const searchFilter = executiveReservationSearchFilter(query.search, hotels);
	if (searchFilter) clauses.push(searchFilter);

	if (isOrderTakerOnly(actor)) {
		const actorId = normalizeId(actor._id);
		if (ObjectId.isValid(actorId)) {
			clauses.push({
				$or: [
					{ createdByUserId: ObjectId(actorId) },
					{ "createdBy._id": actorId },
					{ orderTakeId: ObjectId(actorId) },
					{ "orderTaker._id": actorId },
				],
			});
		}
	}

	if (clauses.length) match.$and = clauses;
	return { match, hotelIds, dateField, period };
};

const aggregateExecutiveByDate = (match, field) =>
	Reservations.aggregate([
		{ $match: mergeMatchDatePresence(match, field) },
		{ $addFields: { paidBreakdownTotal: executivePaidBreakdownTotalExpression() } },
		{
			$group: {
				_id: executiveDateString(field),
				...executiveGroupTotals(),
			},
		},
		{
			$project: {
				_id: 0,
				groupKey: "$_id",
				reservationsCount: 1,
				total_amount: 1,
				commission: 1,
				paidAmount: 1,
				capturedCount: 1,
			},
		},
		{ $sort: { groupKey: 1 } },
	]);

const aggregateExecutiveByStatus = (match) =>
	Reservations.aggregate([
		{ $match: match },
		{ $addFields: { paidBreakdownTotal: executivePaidBreakdownTotalExpression() } },
		{
			$group: {
				_id: { $ifNull: ["$reservation_status", "unknown"] },
				...executiveGroupTotals(),
			},
		},
		{
			$project: {
				_id: 0,
				reservation_status: { $cond: [{ $eq: ["$_id", ""] }, "unknown", "$_id"] },
				reservationsCount: 1,
				total_amount: 1,
				commission: 1,
				paidAmount: 1,
				capturedCount: 1,
			},
		},
		{ $sort: { reservationsCount: -1, reservation_status: 1 } },
	]);

const aggregateExecutiveByHotel = (match, limit = 0) =>
	Reservations.aggregate([
		{ $match: match },
		{ $addFields: { paidBreakdownTotal: executivePaidBreakdownTotalExpression() } },
		...reservationLookupStages(),
		{
			$group: {
				_id: {
					hotelId: "$hotelId",
					hotelName: { $ifNull: ["$hotelName", "Unknown Hotel"] },
				},
				...executiveGroupTotals(),
			},
		},
		{
			$project: {
				_id: 0,
				hotelId: "$_id.hotelId",
				hotelName: "$_id.hotelName",
				reservationsCount: 1,
				total_amount: 1,
				commission: 1,
				paidAmount: 1,
				capturedCount: 1,
			},
		},
		{ $sort: { reservationsCount: -1, total_amount: -1, hotelName: 1 } },
		...(limit ? [{ $limit: limit }] : []),
	]);

const aggregateExecutiveByBookingSource = (match) =>
	Reservations.aggregate([
		{ $match: match },
		{ $addFields: { paidBreakdownTotal: executivePaidBreakdownTotalExpression() } },
		{
			$group: {
				_id: {
					$trim: {
						input: { $ifNull: ["$booking_source", ""] },
					},
				},
				...executiveGroupTotals(),
			},
		},
		{
			$project: {
				_id: 0,
				source: { $cond: [{ $eq: ["$_id", ""] }, "Unknown", "$_id"] },
				reservationsCount: 1,
				total_amount: 1,
				commission: 1,
				paidAmount: 1,
				capturedCount: 1,
			},
		},
		{ $sort: { reservationsCount: -1, total_amount: -1, source: 1 } },
	]);

const aggregateExecutiveReservationStats = (match) =>
	Reservations.aggregate([
		{ $match: match },
		{ $addFields: { paidBreakdownTotal: executivePaidBreakdownTotalExpression() } },
		{
			$group: {
				_id: null,
				...executiveGroupTotals(),
				hotelsWithReservations: { $addToSet: "$hotelId" },
				sourcesWithReservations: {
					$addToSet: {
						$trim: { input: { $ifNull: ["$booking_source", ""] } },
					},
				},
			},
		},
		{
			$project: {
				_id: 0,
				reservationsCount: 1,
				total_amount: 1,
				roomNights: 1,
				commission: 1,
				paidAmount: 1,
				capturedCount: 1,
				hotelsWithReservations: { $size: "$hotelsWithReservations" },
				sourcesWithReservations: {
					$size: {
						$filter: {
							input: "$sourcesWithReservations",
							as: "source",
							cond: { $ne: ["$$source", ""] },
						},
					},
				},
			},
		},
	]);

const ymdFromDate = (date) => {
	const parsed = date instanceof Date ? date : new Date(date);
	if (Number.isNaN(parsed.getTime())) return "";
	return parsed.toISOString().split("T")[0];
};

const startOfUtcDate = (date) => {
	const parsed = date instanceof Date ? date : new Date(date);
	return new Date(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
};

const addUtcDays = (date, days) => {
	const next = new Date(date);
	next.setUTCDate(next.getUTCDate() + days);
	return next;
};

const inventoryRangeFromQuery = (query = {}) => {
	const period = cleanDateRange({
		dateFrom:
			query.invStart ||
			query.start ||
			query.dateFrom ||
			query.fromDate ||
			"",
		dateTo: query.invEnd || query.end || query.dateTo || query.toDate || "",
		range: query.range,
	});
	let start = period.from ? startOfUtcDate(period.from) : null;
	let end = period.to ? startOfUtcDate(period.to) : null;

	if (!start && !end) {
		const now = new Date();
		start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
		end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
	} else if (start && !end) {
		end = addUtcDays(start, 30);
	} else if (!start && end) {
		start = addUtcDays(end, -30);
	}

	if (end < start) {
		const swap = start;
		start = end;
		end = swap;
	}

	const maxDays = 62;
	const days = [];
	let cursor = new Date(start);
	while (cursor <= end && days.length < maxDays) {
		days.push(ymdFromDate(cursor));
		cursor = addUtcDays(cursor, 1);
	}
	const adjustedEnd = days.length ? new Date(`${days[days.length - 1]}T23:59:59.999Z`) : end;
	return {
		start,
		end: adjustedEnd,
		endExclusive: addUtcDays(startOfUtcDate(adjustedEnd), 1),
		days,
		period,
	};
};

const summaryOccupancyRangeFromPeriod = (period = {}) => {
	let start = period.from ? startOfUtcDate(period.from) : null;
	let end = period.to ? startOfUtcDate(period.to) : null;

	if (!start && !end) {
		const now = new Date();
		start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
		end = start;
	} else if (start && !end) {
		end = start;
	} else if (!start && end) {
		start = end;
	}

	if (end < start) {
		const swap = start;
		start = end;
		end = swap;
	}

	return {
		start,
		end,
		endExclusive: addUtcDays(end, 1),
	};
};

const eachUtcDayInRange = (start, end) => {
	const days = [];
	let cursor = startOfUtcDate(start);
	const finalDay = startOfUtcDate(end);
	while (cursor <= finalDay) {
		days.push(new Date(cursor));
		cursor = addUtcDays(cursor, 1);
	}
	return days;
};

const isInHouseReservation = (reservation = {}) =>
	IN_HOUSE_STATUS.test(String(reservation.reservation_status || "")) ||
	IN_HOUSE_STATUS.test(String(reservation.state || ""));

const reservationOccupiesUtcDay = (reservation = {}, dayStart, dayEnd) => {
	if (!reservation?.checkin_date) return false;
	const checkin = startOfUtcDate(reservation.checkin_date);
	const checkout = reservation.checkout_date
		? startOfUtcDate(reservation.checkout_date)
		: null;
	return checkin < dayEnd && ((checkout && checkout > dayStart) || isInHouseReservation(reservation));
};

const reservationUnitCount = (reservation = {}) => {
	const roomIds = extractReservationRoomIds(reservation.roomId);
	if (roomIds.length) return roomIds.length;
	const totalRooms = Number(reservation.total_rooms || 0);
	if (totalRooms > 0) return totalRooms;
	const pickedTotal = (reservation.pickedRoomsType || []).reduce(
		(total, room) => total + Math.max(Number(room?.count || 0), 0),
		0
	);
	return Math.max(pickedTotal, 1);
};

const paidBreakdownTotal = (breakdown = {}) =>
	EXECUTIVE_PAID_BREAKDOWN_KEYS.reduce(
		(total, key) => total + moneyNumber(breakdown?.[key]),
		0
	);

const executivePaidNonZeroFilter = () => ({
	$or: [
		{ paid_amount: { $gt: 0 } },
		...EXECUTIVE_PAID_BREAKDOWN_KEYS.map((key) => ({
			[`paid_amount_breakdown.${key}`]: { $gt: 0 },
		})),
	],
});

const executivePaidSearchFilter = (searchQuery = "", hotels = []) => {
	const trimmed = String(searchQuery || "").trim();
	if (!trimmed) return null;
	const regex = new RegExp(escapeRegex(trimmed), "i");
	const matchingHotelIds = hotels
		.filter((hotel) => regex.test(String(hotel.hotelName || "")))
		.map((hotel) => normalizeId(hotel._id))
		.filter((id) => ObjectId.isValid(id))
		.map((id) => ObjectId(id));

	return {
		$or: [
			{ confirmation_number: regex },
			{ reservation_id: regex },
			{ pms_number: regex },
			{ "customer_details.name": regex },
			{ "customer_details.fullName": regex },
			{ "customer_details.phone": regex },
			{ "customer_details.email": regex },
			{ booking_source: regex },
			{ reservation_status: regex },
			...(matchingHotelIds.length ? [{ hotelId: { $in: matchingHotelIds } }] : []),
		],
	};
};

const buildExecutivePaidMatch = ({ hotels, query = {} }) => {
	const hotelIds = filterHotelIdsForQuery(hotels, query.hotelId);
	if (!hotelIds.length) return null;

	const match = {
		hotelId: { $in: hotelIds.map((id) => ObjectId(id)) },
		$and: [executivePaidNonZeroFilter(), buildExcludePendingOtaReviewFilter()],
	};
	const { dateField, period } = applyDateFilter(match, query);
	if (!match[dateField]) {
		match.createdAt = { $gte: EXECUTIVE_REPORT_START_DATE };
	}

	const includeCancelled =
		String(query.includeCancelled || "").toLowerCase() === "true";
	const excludeCancelled =
		String(query.excludeCancelled ?? "true").toLowerCase() !== "false";
	if (!includeCancelled && excludeCancelled) {
		match.$and.push({
			$nor: [
				{ reservation_status: CANCELLED_STATUS },
				{ state: CANCELLED_STATUS },
				{ reservation_status: NO_SHOW_STATUS },
				{ state: NO_SHOW_STATUS },
			],
		});
	}

	const statusFilter = reservationStatusFilter(query.status);
	if (statusFilter) match.$and.push(statusFilter);

	const bookingSources = parseQueryList(query.bookingSource);
	if (bookingSources.length) {
		match.$and.push({
			$or: bookingSources.map((source) => ({
				booking_source: new RegExp(escapeRegex(source), "i"),
			})),
		});
	}

	if (query.payment) {
		match.$and.push({ payment: new RegExp(escapeRegex(query.payment), "i") });
	}

	const searchFilter = executivePaidSearchFilter(
		query.searchQuery || query.search,
		hotels
	);
	if (searchFilter) match.$and.push(searchFilter);

	return { match, hotelIds, dateField, period };
};

const financialCommissionMissingFilter = () => ({
	$and: [
		{
			$or: [
				{ commission: { $exists: false } },
				{ commission: null },
				{ commission: "" },
				{ commission: "0" },
				{ commission: { $lte: 0 } },
			],
		},
		{
			$or: [
				{ "financial_cycle.commissionAmount": { $exists: false } },
				{ "financial_cycle.commissionAmount": null },
				{ "financial_cycle.commissionAmount": "" },
				{ "financial_cycle.commissionAmount": "0" },
				{ "financial_cycle.commissionAmount": { $lte: 0 } },
			],
		},
		{ "commissionData.assigned": { $ne: true } },
		{ "financial_cycle.commissionAssigned": { $ne: true } },
		{
			$or: [
				{ commissionStatus: { $exists: false } },
				{ commissionStatus: null },
				{ commissionStatus: "" },
				{
					commissionStatus: {
						$nin: Array.from(ASSIGNED_COMMISSION_STATUSES),
					},
				},
			],
		},
	],
});

const financialWorkflowReadyFilter = () => ({
	$or: [
		{ "pendingConfirmation.status": "confirmed" },
		{ "agentDecisionSnapshot.status": "confirmed" },
		{ reservation_status: PENDING_FINANCE_REVIEW_STATUS },
		{ state: PENDING_FINANCE_REVIEW_STATUS },
		{ reservation_status: PENDING_AGENT_COMMISSION_STATUS },
		{ state: PENDING_AGENT_COMMISSION_STATUS },
		{ reservation_status: FINANCE_REJECTED_STATUS },
		{ state: FINANCE_REJECTED_STATUS },
	],
});

const financialTotalReviewPendingFilter = () => ({
	$and: [
		financialWorkflowReadyFilter(),
		{
			$or: [
				{ reservation_status: PENDING_FINANCE_REVIEW_STATUS },
				{ state: PENDING_FINANCE_REVIEW_STATUS },
				{ "financial_cycle.totalReviewStatus": { $exists: false } },
				{ "financial_cycle.totalReviewStatus": null },
				{ "financial_cycle.totalReviewStatus": "" },
				{ "financial_cycle.totalReviewStatus": "pending" },
			],
		},
	],
});

const financialActionFilter = (action = "") => {
	const normalized = String(action || "").trim().toLowerCase();
	const commissionMissing = {
		$and: [financialWorkflowReadyFilter(), financialCommissionMissingFilter()],
	};
	const financeReview = financialTotalReviewPendingFilter();
	const agentApproval = {
		$or: [
			{ reservation_status: PENDING_AGENT_COMMISSION_STATUS },
			{ state: PENDING_AGENT_COMMISSION_STATUS },
			{ "commissionAgentApproval.status": "pending" },
		],
	};
	const financeRejected = {
		$or: [
			{ reservation_status: FINANCE_REJECTED_STATUS },
			{ state: FINANCE_REJECTED_STATUS },
			{ "financial_cycle.totalReviewStatus": "rejected" },
		],
	};
	const agentRejected = { "commissionAgentApproval.status": "rejected" };

	if (normalized === "commission_missing") return commissionMissing;
	if (normalized === "finance_review") return financeReview;
	if (normalized === "agent_commission") return agentApproval;
	if (normalized === "finance_rejected") return financeRejected;
	if (normalized === "agent_commission_rejected") return agentRejected;

	return {
		$or: [commissionMissing, financeReview],
	};
};

const hasFinancialCommissionAssigned = (reservation = {}) => {
	const commissionStatus = String(reservation.commissionStatus || "")
		.trim()
		.toLowerCase();
	return (
		moneyNumber(reservation.commission) > 0 ||
		moneyNumber(reservation?.financial_cycle?.commissionAmount) > 0 ||
		reservation?.commissionData?.assigned === true ||
		reservation?.financial_cycle?.commissionAssigned === true ||
		ASSIGNED_COMMISSION_STATUSES.has(commissionStatus)
	);
};

const financialActionReasons = (reservation = {}) => {
	const reasons = [];
	const statusText = String(reservation.reservation_status || reservation.state || "");
	const pendingConfirmationStatus = String(
		reservation?.pendingConfirmation?.status || ""
	)
		.trim()
		.toLowerCase();
	const agentDecisionStatus = String(
		reservation?.agentDecisionSnapshot?.status || ""
	)
		.trim()
		.toLowerCase();
	const totalReviewStatus = String(
		reservation?.financial_cycle?.totalReviewStatus || ""
	)
		.trim()
		.toLowerCase();
	const commissionApprovalStatus = String(
		reservation?.commissionAgentApproval?.status || ""
	)
		.trim()
		.toLowerCase();
	const financialWorkflowReady =
		pendingConfirmationStatus === "confirmed" ||
		agentDecisionStatus === "confirmed" ||
		PENDING_FINANCE_REVIEW_STATUS.test(statusText) ||
		PENDING_AGENT_COMMISSION_STATUS.test(statusText) ||
		FINANCE_REJECTED_STATUS.test(statusText);

	if (financialWorkflowReady && !hasFinancialCommissionAssigned(reservation)) {
		reasons.push("commission_missing");
	}
	if (
		financialWorkflowReady &&
		(PENDING_FINANCE_REVIEW_STATUS.test(statusText) ||
			!["approved", "rejected"].includes(totalReviewStatus))
	) {
		reasons.push("finance_review");
	}
	if (
		PENDING_AGENT_COMMISSION_STATUS.test(statusText) ||
		commissionApprovalStatus === "pending"
	) {
		reasons.push("agent_commission");
	}
	if (FINANCE_REJECTED_STATUS.test(statusText) || totalReviewStatus === "rejected") {
		reasons.push("finance_rejected");
	}
	if (commissionApprovalStatus === "rejected") {
		reasons.push("agent_commission_rejected");
	}
	return [...new Set(reasons)];
};

const buildFinancialActionsMatch = ({
	actor,
	hotels,
	query = {},
	includeBookingSource = true,
}) => {
	const hotelIds = filterHotelIdsForQuery(hotels, query.hotelId);
	if (!hotelIds.length) return null;

	const match = { hotelId: { $in: hotelIds.map((id) => ObjectId(id)) } };
	applyDateFilter(match, query);

	const clauses = [
		financialActionFilter(query.actionType),
		buildExcludePendingOtaReviewFilter(),
	];
	if (includeBookingSource && query.bookingSource) {
		clauses.push({
			booking_source: new RegExp(escapeRegex(query.bookingSource), "i"),
		});
	}
	const requestedAgentId = normalizeId(query.agentId);
	if (requestedAgentId && ObjectId.isValid(requestedAgentId)) {
		clauses.push({ $or: agentReservationOwnerClauses(requestedAgentId) });
	}
	if (isOrderTakerOnly(actor)) {
		const actorId = normalizeId(actor._id);
		if (ObjectId.isValid(actorId)) {
			clauses.push({
				$or: [
					{ createdByUserId: ObjectId(actorId) },
					{ "createdBy._id": actorId },
					{ orderTakeId: ObjectId(actorId) },
					{ "orderTaker._id": actorId },
				],
			});
		}
	}
	if (clauses.length) match.$and = clauses;
	return match;
};

const walletClaimDateFilter = (query = {}) => {
	const period = cleanDateRange(query);
	const filter = {};
	if (period.from) filter.$gte = period.from;
	if (period.to) filter.$lte = period.to;
	return Object.keys(filter).length ? { transactionDate: filter } : {};
};

const walletAgentRoleClause = () => ({
	$or: [
		{ role: 7000 },
		{ roles: 7000 },
		{ roleDescription: "ordertaker" },
		{ roleDescriptions: "ordertaker" },
	],
});

const walletAgentAssignmentClause = (hotelIds = []) => {
	const ids = uniqueValidIds(hotelIds);
	const objectIds = ids.map((id) => ObjectId(id));
	if (!ids.length) return {};
	return {
		$or: [
			{ hotelIdWork: { $in: ids } },
			{ hotelIdWork: { $in: objectIds } },
			{ hotelIdsWork: { $in: objectIds } },
			{ hotelsToSupport: { $in: objectIds } },
			{ hotelIdsOwner: { $in: objectIds } },
		],
	};
};

const walletAgentsForHotels = async (hotelIds = [], actor = {}) => {
	if (isOrderTakerOnly(actor)) {
		const actorId = normalizeId(actor._id);
		if (!ObjectId.isValid(actorId)) return [];
		const actorAccount = await User.findById(actorId)
			.select("_id name email phone companyName agentCommercialModel")
			.lean()
			.exec();
		return actorAccount ? [actorAccount] : [];
	}
	const assignment = walletAgentAssignmentClause(hotelIds);
	if (!Object.keys(assignment).length && !isSuperAdmin(actor)) return [];
	const query = isSuperAdmin(actor)
		? { activeUser: { $ne: false }, ...walletAgentRoleClause() }
		: {
				activeUser: { $ne: false },
				$and: [walletAgentRoleClause(), assignment],
		  };
	return User.find(query)
		.select("_id name email phone companyName agentCommercialModel")
		.sort({ companyName: 1, name: 1, email: 1 })
		.lean()
		.exec();
};

const walletAgentIdsForHotels = async (hotelIds = [], actor = {}) =>
	(await walletAgentsForHotels(hotelIds, actor))
		.map((agent) => normalizeId(agent._id))
		.filter(Boolean);

const listPendingWalletFinanceActions = async ({ actor = {}, hotels, query = {} }) => {
	const hotelIds = filterHotelIdsForQuery(hotels, query.hotelId);
	const exportAll = ["1", "true", "yes", "all"].includes(
		String(query.exportAll || "").toLowerCase()
	);
	const page = exportAll
		? 1
		: Math.max(parseInt(query.walletPage || query.claimPage, 10) || 1, 1);
	const limit = exportAll
		? Math.min(
				Math.max(parseInt(query.walletLimit || query.claimLimit, 10) || 5000, 1),
				5000
		  )
		: Math.min(
				Math.max(parseInt(query.walletLimit || query.claimLimit, 10) || 8, 1),
				50
		  );
	if (!hotelIds.length) {
		return { page, limit, total: 0, pages: 0, transactions: [] };
	}
	let visibleAgentIds = await walletAgentIdsForHotels(hotelIds, actor);
	const requestedAgentId = normalizeId(query.agentId);
	if (requestedAgentId && ObjectId.isValid(requestedAgentId)) {
		visibleAgentIds = visibleAgentIds.filter((id) => id === requestedAgentId);
	}
	if (!visibleAgentIds.length) {
		return { page, limit, total: 0, pages: 0, transactions: [] };
	}

	const hotelMap = new Map(
		hotels.map((hotel) => [normalizeId(hotel._id), hotel])
	);
	const match = {
		agentId: { $in: visibleAgentIds.map((id) => ObjectId(id)) },
		source: "agent_claim",
		status: "pending",
		reviewStatus: "pending",
		...walletClaimDateFilter(query),
	};
	const [total, transactions] = await Promise.all([
		AgentWallet.countDocuments(match),
		AgentWallet.find(match)
			.populate("agentId", "_id name email phone companyName")
			.sort({ updatedAt: -1, createdAt: -1 })
			.skip((page - 1) * limit)
			.limit(limit)
			.lean()
			.exec(),
	]);

	return {
		page,
		limit,
		total,
		pages: Math.ceil(total / limit),
		transactions: transactions.map((transaction) => {
			const currentHotelId =
				normalizeId(transaction.hotelId || transaction.legacyHotelId) ||
				hotelIds[0] ||
				"";
			const hotel = hotelMap.get(currentHotelId) || {};
			return {
				...transaction,
				hotelId: normalizeId(transaction.hotelId) || currentHotelId,
				legacyHotelId: normalizeId(transaction.legacyHotelId),
				hotelName: hotel.hotelName || "",
				ownerId: normalizeId(hotel.belongsTo || transaction.ownerId),
				agent: transaction.agentId || null,
				agentId: normalizeId(transaction.agentId),
				status: "pending",
				reviewStatus: "pending",
				financialStatus: "pending",
				reconciliationEligible: false,
			};
		}),
	};
};

const commissionMonthRange = (value = "") => {
	const raw = String(value || "").trim();
	const match = raw.match(/^(\d{4})-(\d{2})$/);
	if (!match) return null;
	const year = Number(match[1]);
	const monthIndex = Number(match[2]) - 1;
	if (!Number.isFinite(year) || monthIndex < 0 || monthIndex > 11) return null;
	const start = new Date(Date.UTC(year, monthIndex, 1, 0, 0, 0, 0));
	const endExclusive = new Date(Date.UTC(year, monthIndex + 1, 1, 0, 0, 0, 0));
	return { start, endExclusive };
};

const agentReservationOwnerClauses = (agentId = "") => {
	const id = normalizeId(agentId);
	if (!ObjectId.isValid(id)) return [];
	const objectId = ObjectId(id);
	return [
		{ createdByUserId: objectId },
		{ createdByUserId: id },
		{ orderTakeId: objectId },
		{ orderTakeId: id },
		{ "createdBy._id": id },
		{ "orderTaker._id": id },
		{ "agentWalletSnapshot.agent._id": id },
		{ "agent._id": id },
		{ agentId: objectId },
		{ agentId: id },
	];
};

const agentIdFromReservationRow = (reservation = {}, visibleAgentIds = []) => {
	const visible = new Set(visibleAgentIds.map(normalizeId).filter(Boolean));
	const candidates = [
		reservation.orderTakeId,
		reservation.createdByUserId,
		reservation.orderTaker?._id,
		reservation.createdBy?._id,
		reservation.agentWalletSnapshot?.agent?._id,
		reservation.agent?._id,
		reservation.agentId,
	]
		.map(normalizeId)
		.filter(Boolean);
	return (
		candidates.find((id) => visible.has(id)) ||
		candidates.find((id) => ObjectId.isValid(id)) ||
		""
	);
};

const commissionAmountFromReservation = (reservation = {}) =>
	moneyNumber(reservation.commission) ||
	moneyNumber(reservation?.commissionData?.amount) ||
	moneyNumber(reservation?.financial_cycle?.commissionAmount);

const listCommissionReconciliationActions = async ({
	actor = {},
	hotels,
	query = {},
}) => {
	const hotelIds = filterHotelIdsForQuery(hotels, query.hotelId);
	const exportAll = ["1", "true", "yes", "all"].includes(
		String(query.exportAll || "").toLowerCase()
	);
	const page = exportAll
		? 1
		: Math.max(parseInt(query.commissionPage, 10) || 1, 1);
	const limit = exportAll
		? Math.min(
				Math.max(parseInt(query.commissionLimit, 10) || 5000, 1),
				5000
		  )
		: Math.min(
				Math.max(parseInt(query.commissionLimit, 10) || 8, 1),
				50
		  );

	if (!hotelIds.length) {
		return { page, limit, total: 0, pages: 0, rows: [] };
	}

	let visibleAgentIds = await walletAgentIdsForHotels(hotelIds, actor);
	const requestedAgentId = normalizeId(query.agentId);
	if (requestedAgentId && ObjectId.isValid(requestedAgentId)) {
		visibleAgentIds = visibleAgentIds.filter((id) => id === requestedAgentId);
	}
	if (!visibleAgentIds.length) {
		return { page, limit, total: 0, pages: 0, rows: [] };
	}

	const monthRange = commissionMonthRange(query.commissionMonth);
	const now = new Date();
	const checkoutFilter = { $lte: now };
	if (monthRange) {
		checkoutFilter.$gte = monthRange.start;
		checkoutFilter.$lt = monthRange.endExclusive < now ? monthRange.endExclusive : now;
	}

	const agentClauses = visibleAgentIds.flatMap(agentReservationOwnerClauses);
	const match = {
		hotelId: { $in: hotelIds.map((id) => ObjectId(id)) },
		checkout_date: checkoutFilter,
		commissionPaid: { $ne: true },
		$and: [
			buildExcludePendingOtaReviewFilter(),
			{
				$or: [
					{ reservation_status: CHECKED_OUT_STATUS },
					{ state: CHECKED_OUT_STATUS },
					{ checkout_date: { $lte: now } },
				],
			},
			{
				$or: [
					{ commission: { $gt: 0 } },
					{ "commissionData.amount": { $gt: 0 } },
					{ "financial_cycle.commissionAmount": { $gt: 0 } },
					{ commissionStatus: /commission due/i },
				],
			},
			{ $or: agentClauses },
			{
				$and: [
					{ reservation_status: { $not: CANCELLED_STATUS } },
					{ state: { $not: CANCELLED_STATUS } },
					{ reservation_status: { $not: NO_SHOW_STATUS } },
					{ state: { $not: NO_SHOW_STATUS } },
				],
			},
		],
	};
	if (query.bookingSource) {
		match.$and.push({
			booking_source: new RegExp(escapeRegex(query.bookingSource), "i"),
		});
	}

	const search = reservationSearchStage(query.search);
	const basePipeline = [{ $match: match }, ...reservationLookupStages()];
	if (search) basePipeline.push({ $match: search });

	const [countResult, rows] = await Promise.all([
		Reservations.aggregate([...basePipeline, { $count: "total" }]),
		Reservations.aggregate([
			...basePipeline,
			{ $sort: { checkout_date: -1, bookingSortDate: -1, _id: -1 } },
			{ $skip: (page - 1) * limit },
			{ $limit: limit },
			{
				$project: {
					hotelDetails: 0,
					roomDetails: 0,
					adminChangeLog: 0,
					reservationAuditLog: 0,
				},
			},
		]),
	]);

	const rowAgentIds = [
		...new Set(
			rows
				.map((reservation) =>
					agentIdFromReservationRow(reservation, visibleAgentIds)
				)
				.filter((id) => ObjectId.isValid(id))
		),
	];
	const agents = rowAgentIds.length
		? await User.find({ _id: { $in: rowAgentIds.map((id) => ObjectId(id)) } })
				.select("_id name email phone companyName agentCommercialModel agentPayoutDetails")
				.lean()
				.exec()
		: [];
	const hotelVisibleRows = sanitizeReservationAuditLogsCollectionForViewer(rows);
	const agentMap = agents.reduce((map, agent) => {
		map[normalizeId(agent._id)] = agent;
		return map;
	}, {});
	const total = countResult?.[0]?.total || 0;

	return {
		page,
		limit,
		total,
		pages: Math.ceil(total / limit),
		rows: hotelVisibleRows.map((reservation) => {
			const agentId = agentIdFromReservationRow(reservation, visibleAgentIds);
			const fallbackAgent =
				reservation.orderTaker || reservation.createdBy || {};
			const agent = agentMap[agentId] || fallbackAgent || {};
			return {
				...reservation,
				agentId,
				agent: {
					_id: agentId,
					name: agent.name || agent.email || "",
					email: agent.email || "",
					phone: agent.phone || "",
					companyName: agent.companyName || "",
					agentCommercialModel: agent.agentCommercialModel || "",
					agentPayoutDetails: agent.agentPayoutDetails || {},
				},
				commissionAmount: commissionAmountFromReservation(reservation),
				reconciliationMonth: reservation.checkout_date
					? ymdFromDate(reservation.checkout_date).slice(0, 7)
					: "",
			};
		}),
	};
};

const listFinancialActions = async ({ actor, hotels, query = {} }) => {
	const selectedHotelIds = filterHotelIdsForQuery(hotels, query.hotelId);
	const match = buildFinancialActionsMatch({ actor, hotels, query });
	const [agentOptions, walletClaims, commissionReconciliation] = await Promise.all([
		walletAgentsForHotels(selectedHotelIds, actor),
		listPendingWalletFinanceActions({ actor, hotels, query }),
		listCommissionReconciliationActions({
			actor,
			hotels,
			query,
		}),
	]);
	const visibleAgentIds = agentOptions
		.map((agent) => normalizeId(agent._id))
		.filter(Boolean);
	if (!match) {
		return {
			page: 1,
			limit: 0,
			total: 0,
			pages: 0,
			reservations: [],
			walletClaims,
			commissionReconciliation,
			hotels,
			bookingSources: [],
			agentOptions,
		};
	}

	const page = Math.max(parseInt(query.page, 10) || 1, 1);
	const exportAll = ["1", "true", "yes", "all"].includes(
		String(query.exportAll || "").toLowerCase()
	);
	const pageForQuery = exportAll ? 1 : page;
	const limit = exportAll
		? Math.min(Math.max(parseInt(query.limit, 10) || 5000, 1), 5000)
		: Math.min(Math.max(parseInt(query.limit, 10) || 25, 1), 100);
	const bookingSourceMatch = buildFinancialActionsMatch({
		actor,
		hotels,
		query,
		includeBookingSource: false,
	});
	const search = reservationSearchStage(query.search);
	const basePipeline = [{ $match: match }, ...reservationLookupStages()];
	if (search) basePipeline.push({ $match: search });

	const [countResult, rows, bookingSources] = await Promise.all([
		Reservations.aggregate([...basePipeline, { $count: "total" }]),
		Reservations.aggregate([
			...basePipeline,
			{ $sort: sortFromQuery({ ...query, sortBy: query.sortBy || "updatedAt" }) },
			{ $skip: (pageForQuery - 1) * limit },
			{ $limit: limit },
			{ $project: { hotelDetails: 0 } },
		]),
		bookingSourceOptionsFromMatch(bookingSourceMatch),
	]);

	const total = countResult?.[0]?.total || 0;
	const hotelVisibleRows = sanitizeReservationAuditLogsCollectionForViewer(rows);
	const agentMap = agentOptions.reduce((map, agent) => {
		map[normalizeId(agent._id)] = agent;
		return map;
	}, {});
	return {
		page: pageForQuery,
		limit,
		total,
		pages: Math.ceil(total / limit),
		hotels,
		bookingSources,
		agentOptions,
		walletClaims,
		commissionReconciliation,
		reservations: hotelVisibleRows.map((reservation, index) => {
			const rawReservation = rows[index] || {};
			const commissionAmount =
				commissionAmountFromReservation(rawReservation) ||
				commissionAmountFromReservation(reservation);
			const agentId = agentIdFromReservationRow(reservation, visibleAgentIds);
			const fallbackAgent =
				reservation.agentWalletSnapshot?.agent ||
				reservation.agent ||
				reservation.orderTaker ||
				reservation.createdBy ||
				{};
			const agent = agentMap[agentId] || fallbackAgent || {};
			const agentPayload = agentId
				? {
						_id: agentId,
						name: agent.name || agent.email || "",
						email: agent.email || "",
						phone: agent.phone || "",
						companyName: agent.companyName || "",
						agentCommercialModel:
							agent.agentCommercialModel ||
							reservation.agentWalletSnapshot?.commercialModel ||
							reservation.agentWalletSnapshot?.agent?.agentCommercialModel ||
							"",
				  }
				: null;
			return {
				...reservation,
				agentId,
				agent: agentPayload,
				commissionAmount,
				financialActionReasons: financialActionReasons(rawReservation),
			};
		}),
	};
};

exports.overallSummary = async (req, res) => {
	try {
		const context = await requireOverallSection(req, res, "summary");
		if (!context) return;
		const { actor, hotels } = context;
		const selectedIds = filterHotelIdsForQuery(hotels, req.query?.hotelId);
		const selectedSet = new Set(selectedIds);
		const selectedHotels = hotels.filter((hotel) =>
			selectedSet.has(normalizeId(hotel._id))
		);
		const hotelIds = selectedIds.map((id) => ObjectId(id));
		const period = cleanDateRange(req.query || {});
		const dateField = normalizeDateField(req.query?.dateBy || "createdAt");
		const occupancyRange = summaryOccupancyRangeFromPeriod(period);

		if (!hotelIds.length) {
			return res.json({
				asOf: new Date(),
				period: { ...period, dateBy: dateField },
				stats: {},
				hotels: [],
				allHotels: executiveHotelOptions(hotels),
				bookingSources: [],
			});
		}

		const now = new Date();
		const todayStart = startOfUtcDate(now);
		const todayEndExclusive = addUtcDays(todayStart, 1);

		const reservationMatch = { hotelId: { $in: hotelIds } };
		const dateFilter = {};
		if (period.from) dateFilter.$gte = period.from;
		if (period.to) dateFilter.$lte = period.to;
		if (Object.keys(dateFilter).length) reservationMatch[dateField] = dateFilter;

		const statusValues = parseQueryList(req.query?.status).filter(
			(status) => String(status || "").trim().toLowerCase() !== "all"
		);
		const hasExplicitStatus = statusValues.length > 0;
		const includeCancelled =
			String(req.query?.includeCancelled || "").toLowerCase() === "true";
		const summaryClauses = [];
		summaryClauses.push(buildExcludePendingOtaReviewFilter());
		const statusFilter = reservationStatusFilter(req.query?.status);
		if (hasExplicitStatus && statusFilter) {
			summaryClauses.push(statusFilter);
		} else {
			summaryClauses.push(summaryOperationalReservationFilter({ includeCancelled }));
		}

		const bookingSourceFilters = parseQueryList(req.query?.bookingSource);
		if (bookingSourceFilters.length) {
			summaryClauses.push({
				$or: bookingSourceFilters.map((source) => ({
					booking_source: new RegExp(escapeRegex(source), "i"),
				})),
			});
		}
		if (req.query?.payment) {
			summaryClauses.push({
				payment: new RegExp(escapeRegex(req.query.payment), "i"),
			});
		}
		const searchFilter = executiveReservationSearchFilter(
			req.query?.search,
			selectedHotels
		);
		if (searchFilter) summaryClauses.push(searchFilter);
		if (summaryClauses.length) reservationMatch.$and = summaryClauses;

		const occupancyMatch = { hotelId: { $in: hotelIds } };
		const occupancyDateClauses = [
			{
				checkin_date: { $lt: occupancyRange.endExclusive },
				checkout_date: { $gt: occupancyRange.start },
			},
		];
		if (todayEndExclusive > occupancyRange.start) {
			occupancyDateClauses.push({
				checkin_date: { $lt: occupancyRange.endExclusive },
				$or: [
					{ reservation_status: IN_HOUSE_STATUS },
					{ state: IN_HOUSE_STATUS },
				],
			});
		}
		const occupancyClauses = [
			buildExcludePendingOtaReviewFilter(),
			{ $or: occupancyDateClauses },
		];
		if (hasExplicitStatus && statusFilter) {
			occupancyClauses.push(statusFilter);
		} else {
			occupancyClauses.push(summaryOperationalReservationFilter({ includeCancelled }));
		}
		if (bookingSourceFilters.length) {
			occupancyClauses.push({
				$or: bookingSourceFilters.map((source) => ({
					booking_source: new RegExp(escapeRegex(source), "i"),
				})),
			});
		}
		if (req.query?.payment) {
			occupancyClauses.push({
				payment: new RegExp(escapeRegex(req.query.payment), "i"),
			});
		}
		if (searchFilter) occupancyClauses.push(searchFilter);
		if (occupancyClauses.length) occupancyMatch.$and = occupancyClauses;

		const pendingReservationMatch = {
			hotelId: { $in: hotelIds },
			$and: [
				buildExcludePendingOtaReviewFilter(),
				{
					$or: [
						{ reservation_status: PENDING_CONFIRMATION_STATUS },
						{ state: PENDING_CONFIRMATION_STATUS },
						{ "pendingConfirmation.status": { $in: ["pending", "rejected"] } },
						{ "agentDecisionSnapshot.status": { $in: ["pending", "rejected"] } },
					],
				},
			],
		};
		if (Object.keys(dateFilter).length) pendingReservationMatch[dateField] = dateFilter;
		if (hasExplicitStatus && statusFilter) pendingReservationMatch.$and.push(statusFilter);
		if (bookingSourceFilters.length) {
			pendingReservationMatch.$and.push({
				$or: bookingSourceFilters.map((source) => ({
					booking_source: new RegExp(escapeRegex(source), "i"),
				})),
			});
		}
		if (req.query?.payment) {
			pendingReservationMatch.$and.push({
				payment: new RegExp(escapeRegex(req.query.payment), "i"),
			});
		}
		if (searchFilter) pendingReservationMatch.$and.push(searchFilter);

		const [
			rooms,
			occupancyReservations,
			reservationStats,
			pendingReservations,
			housekeepingStats,
			openHousekeepingTasks,
			activeAccounts,
			bookingSources,
		] = await Promise.all([
			Rooms.find({ hotelId: { $in: hotelIds } })
				.select("_id hotelId active activeRoom cleanRoom housekeepingDirtyReason")
				.lean()
				.exec(),
			Reservations.find(occupancyMatch)
				.select(
					"hotelId roomId total_rooms pickedRoomsType checkin_date checkout_date reservation_status state"
				)
				.lean()
				.exec(),
			Reservations.aggregate([
				{ $match: reservationMatch },
				{
					$group: {
						_id: "$hotelId",
						totalReservations: { $sum: 1 },
						totalAmount: { $sum: hotelVisibleReservationAmountExpression() },
						activeReservations: {
							$sum: {
								$cond: [
									{
										$not: [
											{
												$regexMatch: {
													input: { $ifNull: ["$reservation_status", ""] },
													regex: DONE_RESERVATION_STATUS,
												},
											},
										],
									},
									1,
									0,
								],
							},
						},
					},
				},
			]),
			Reservations.aggregate([
				{ $match: pendingReservationMatch },
				{ $group: { _id: "$hotelId", total: { $sum: 1 } } },
			]),
			HouseKeeping.aggregate([
				{ $match: { hotelId: { $in: hotelIds } } },
				{
					$group: {
						_id: "$hotelId",
						total: { $sum: 1 },
						open: {
							$sum: {
								$cond: [
									{
										$regexMatch: {
											input: { $ifNull: ["$task_status", ""] },
											regex: FINISHED_HOUSEKEEPING_STATUS,
										},
									},
									0,
									1,
								],
							},
						},
					},
				},
			]),
			HouseKeeping.find({
				hotelId: { $in: hotelIds },
				task_status: { $not: FINISHED_HOUSEKEEPING_STATUS },
			})
				.select("hotelId rooms roomStatus task_status")
				.lean()
				.exec(),
			User.countDocuments({
				activeUser: true,
				$or: [
					{ hotelIdWork: { $in: selectedHotelIds(selectedHotels) } },
					{ hotelsToSupport: { $in: hotelIds } },
					{ hotelIdsOwner: { $in: hotelIds } },
				],
			}),
			Reservations.aggregate([
				{ $match: reservationMatch },
				{
					$group: {
						_id: { $ifNull: ["$booking_source", "Unknown"] },
						count: { $sum: 1 },
						totalAmount: { $sum: hotelVisibleReservationAmountExpression() },
					},
				},
				{ $sort: { count: -1, _id: 1 } },
				{ $limit: 8 },
			]),
		]);

		const roomsByHotel = new Map();
		rooms.forEach((room) => {
			const hotelId = normalizeId(room.hotelId);
			if (!roomsByHotel.has(hotelId)) roomsByHotel.set(hotelId, []);
			roomsByHotel.get(hotelId).push(room);
		});

		const occupancyReservationsByHotel = new Map();
		occupancyReservations.forEach((reservation) => {
			const hotelId = normalizeId(reservation.hotelId);
			if (!occupancyReservationsByHotel.has(hotelId)) {
				occupancyReservationsByHotel.set(hotelId, []);
			}
			occupancyReservationsByHotel.get(hotelId).push(reservation);
		});
		const occupancyDays = eachUtcDayInRange(
			occupancyRange.start,
			occupancyRange.end
		);

		const reservationStatsByHotel = new Map(
			reservationStats.map((item) => [normalizeId(item._id), item])
		);
		const pendingByHotel = new Map(
			pendingReservations.map((item) => [normalizeId(item._id), item.total])
		);
		const housekeepingByHotel = new Map(
			housekeepingStats.map((item) => [normalizeId(item._id), item])
		);
		const openHousekeepingRoomIdsByHotel = new Map();
		const addOpenHousekeepingRoom = (hotelId = "", roomId = "") => {
			const normalizedHotelId = normalizeId(hotelId);
			const normalizedRoomId = normalizeId(roomId);
			if (!normalizedHotelId || !normalizedRoomId) return;
			if (!openHousekeepingRoomIdsByHotel.has(normalizedHotelId)) {
				openHousekeepingRoomIdsByHotel.set(normalizedHotelId, new Set());
			}
			openHousekeepingRoomIdsByHotel
				.get(normalizedHotelId)
				.add(normalizedRoomId);
		};
		openHousekeepingTasks.forEach((task) => {
			const taskHotelId = normalizeId(task.hotelId);
			if (Array.isArray(task.roomStatus) && task.roomStatus.length) {
				task.roomStatus.forEach((entry) => {
					if (
						!FINISHED_HOUSEKEEPING_STATUS.test(
							String(entry?.status || "")
						)
					) {
						addOpenHousekeepingRoom(taskHotelId, entry?.room);
					}
				});
				return;
			}
			(Array.isArray(task.rooms) ? task.rooms : []).forEach((roomId) =>
				addOpenHousekeepingRoom(taskHotelId, roomId)
			);
		});

		const hotelSummaries = selectedHotels.map((hotel) => {
			const hotelId = normalizeId(hotel._id);
			const hotelRooms = roomsByHotel.get(hotelId) || [];
			const physicalRoomsTotal = hotelRooms.length;
			const declaredRoomsTotal = getDeclaredRoomsTotal(hotel);
			const activeRoomsList = hotelRooms.filter(
				(room) => room.active !== false && room.activeRoom !== false
			);
			const totalRooms = physicalRoomsTotal
				? activeRoomsList.length
				: declaredRoomsTotal;
			const activeRooms = totalRooms;
			const activeRoomIds = new Set(
				activeRoomsList.map((room) => normalizeId(room._id))
			);
			const hotelOccupancyReservations =
				occupancyReservationsByHotel.get(hotelId) || [];
			let occupiedRooms = 0;
			let occupiedRoomIds = new Set();
			occupancyDays.forEach((dayStart) => {
				const dayEnd = addUtcDays(dayStart, 1);
				const dayRoomIds = new Set();
				let dayFallbackUnits = 0;
				hotelOccupancyReservations.forEach((reservation) => {
					if (!reservationOccupiesUtcDay(reservation, dayStart, dayEnd)) return;
					const roomIds = extractReservationRoomIds(reservation.roomId);
					if (roomIds.length) {
						if (physicalRoomsTotal) {
							roomIds
								.filter((roomId) => activeRoomIds.has(roomId))
								.forEach((roomId) => dayRoomIds.add(roomId));
						} else {
							roomIds.forEach((roomId) => dayRoomIds.add(roomId));
						}
						return;
					}
					dayFallbackUnits += reservationUnitCount(reservation);
				});
				const dayOccupiedRooms = Math.min(
					dayRoomIds.size + dayFallbackUnits,
					activeRooms
				);
				if (dayOccupiedRooms > occupiedRooms) {
					occupiedRooms = dayOccupiedRooms;
					occupiedRoomIds = new Set(dayRoomIds);
				}
			});
			const cleanlinessAvailable = activeRoomsList.length > 0;
			const openHousekeepingRoomIds =
				openHousekeepingRoomIdsByHotel.get(hotelId) || new Set();
			const dirtyRoomIds = new Set();
			activeRoomsList.forEach((room) => {
				const roomId = normalizeId(room._id);
				const dirtyReason = String(room.housekeepingDirtyReason || "")
					.trim()
					.toLowerCase();
				if (
					openHousekeepingRoomIds.has(roomId) ||
					(room.cleanRoom === false &&
						SUMMARY_DIRTY_ROOM_REASONS.has(dirtyReason))
				) {
					dirtyRoomIds.add(roomId);
				}
			});
			occupiedRoomIds.forEach((roomId) => dirtyRoomIds.delete(roomId));
			const dirtyRooms = cleanlinessAvailable ? dirtyRoomIds.size : null;
			const cleanRooms = cleanlinessAvailable
				? Math.max(activeRooms - occupiedRooms - dirtyRooms, 0)
				: null;
			const stats = reservationStatsByHotel.get(hotelId) || {};
			const housekeeping = housekeepingByHotel.get(hotelId) || {};

			return {
				_id: hotelId,
				hotelName: hotel.hotelName || "Hotel",
				ownerId: normalizeId(hotel.belongsTo),
				ownerName: hotel.belongsTo?.name || "",
				totalRooms,
				activeRooms,
				availableRooms: Math.max(activeRooms - occupiedRooms, 0),
				occupiedRooms,
				cleanRooms,
				dirtyRooms,
				cleanlinessAvailable,
				totalReservations: Number(stats.totalReservations || 0),
				activeReservations: Number(stats.activeReservations || 0),
				totalAmount: Number(stats.totalAmount || 0),
				pendingReservations: Number(pendingByHotel.get(hotelId) || 0),
				housekeepingTasks: Number(housekeeping.total || 0),
				openHousekeepingTasks: Number(housekeeping.open || 0),
				setup: setupSnapshot(hotel),
			};
		});
		const visibleHotelSummaries = req.query?.search
			? hotelSummaries.filter((hotel) => {
					const regex = new RegExp(escapeRegex(req.query.search), "i");
					return (
						hotel.totalReservations > 0 ||
						regex.test(hotel.hotelName || "") ||
						regex.test(hotel.ownerName || "")
					);
			  })
			: hotelSummaries;

		const totals = visibleHotelSummaries.reduce(
			(acc, hotel) => {
				acc.totalRooms += hotel.totalRooms;
				acc.activeRooms += hotel.activeRooms;
				acc.availableRooms += hotel.availableRooms;
				acc.occupiedRooms += hotel.occupiedRooms;
				acc.totalReservations += hotel.totalReservations;
				acc.activeReservations += hotel.activeReservations;
				acc.totalAmount += hotel.totalAmount;
				acc.pendingReservations += hotel.pendingReservations;
				acc.openHousekeepingTasks += hotel.openHousekeepingTasks;
				if (hotel.cleanlinessAvailable) {
					acc.cleanRooms += Number(hotel.cleanRooms || 0);
					acc.dirtyRooms += Number(hotel.dirtyRooms || 0);
				}
				return acc;
			},
			{
				totalHotels: visibleHotelSummaries.length,
				totalRooms: 0,
				activeRooms: 0,
				availableRooms: 0,
				occupiedRooms: 0,
				totalReservations: 0,
				activeReservations: 0,
				totalAmount: 0,
				pendingReservations: 0,
				openHousekeepingTasks: 0,
				cleanRooms: 0,
				dirtyRooms: 0,
				activeAccounts,
			}
		);
		totals.cleanlinessAvailable = visibleHotelSummaries.some(
			(hotel) => hotel.cleanlinessAvailable
		);

		return res.json({
			asOf: now,
			actor: {
				_id: normalizeId(actor._id),
				role: actor.role,
				roleDescription: actor.roleDescription || "",
			},
			period: {
				...period,
				dateBy: dateField,
				occupancyFrom: ymdFromDate(occupancyRange.start),
				occupancyTo: ymdFromDate(occupancyRange.end),
			},
			stats: totals,
			hotels: visibleHotelSummaries,
			allHotels: executiveHotelOptions(hotels),
			bookingSources: bookingSources.map((source) => ({
				source: source._id || "Unknown",
				count: source.count || 0,
				totalAmount: source.totalAmount || 0,
			})),
		});
	} catch (error) {
		console.error("overallSummary error:", error);
		return res.status(500).json({ error: "Could not load overall summary" });
	}
};

exports.overallExecutiveReservationsReport = async (req, res) => {
	try {
		const context = await requireOverallSection(req, res, "executive");
		if (!context) return;

		const built = buildExecutiveReservationMatch({
			actor: context.actor,
			hotels: context.hotels,
			query: req.query || {},
		});

		if (!built) {
			return res.json({
				asOf: new Date(),
				period: {},
				hotels: [],
				stats: {},
				reservationsByDay: [],
				checkinsByDay: [],
				checkoutsByDay: [],
				reservationsByBookingStatus: [],
				reservationsByHotelNames: [],
				topHotels: [],
				bookingSources: [],
			});
		}

		const topLimit = Math.min(
			Math.max(parseInt(req.query?.limit, 10) || 20, 1),
			100
		);
		const [
			statsRows,
			reservationsByDay,
			checkinsByDay,
			checkoutsByDay,
			reservationsByBookingStatus,
			reservationsByHotelNames,
			topHotels,
			bookingSources,
		] = await Promise.all([
			aggregateExecutiveReservationStats(built.match),
			aggregateExecutiveByDate(built.match, "createdAt"),
			aggregateExecutiveByDate(built.match, "checkin_date"),
			aggregateExecutiveByDate(built.match, "checkout_date"),
			aggregateExecutiveByStatus(built.match),
			aggregateExecutiveByHotel(built.match),
			aggregateExecutiveByHotel(built.match, topLimit),
			aggregateExecutiveByBookingSource(built.match),
		]);

		return res.json({
			asOf: new Date(),
			period: {
				...built.period,
				dateBy: built.dateField,
				reportStartDate: EXECUTIVE_REPORT_START_DATE,
			},
			hotels: executiveHotelOptions(context.hotels).filter((hotel) =>
				built.hotelIds.includes(hotel._id)
			),
			stats: {
				totalHotels: built.hotelIds.length,
				...(statsRows?.[0] || {}),
			},
			reservationsByDay,
			checkinsByDay,
			checkoutsByDay,
			reservationsByBookingStatus,
			reservationsByHotelNames,
			topHotels,
			bookingSources,
		});
	} catch (error) {
		console.error("overallExecutiveReservationsReport error:", error);
		return res.status(500).json({
			error: "Could not load executive reservations report",
		});
	}
};

exports.overallExecutiveInventoryReport = async (req, res) => {
	try {
		const context = await requireOverallSection(req, res, "executive");
		if (!context) return;

		const requestedHotelId = req.query?.hotelId || req.query?.invHotel || "";
		if (!requestedHotelId) {
			return res.status(400).json({
				error: "hotelId is required for inventory report",
				allHotels: executiveHotelOptions(context.hotels),
				hotels: [],
				days: [],
				stats: {},
				range: inventoryRangeFromQuery(req.query || {}),
			});
		}
		const hotelIds = filterHotelIdsForQuery(context.hotels, requestedHotelId);
		if (hotelIds.length !== 1) {
			return res.status(403).json({
				error: "You cannot view inventory for this hotel",
				allHotels: executiveHotelOptions(context.hotels),
				hotels: [],
				days: [],
				stats: {},
				range: inventoryRangeFromQuery(req.query || {}),
			});
		}
		const selectedHotels = context.hotels.filter((hotel) =>
			hotelIds.includes(normalizeId(hotel._id))
		);

		const range = inventoryRangeFromQuery(req.query || {});
		const hotelObjectIds = hotelIds.map((id) => ObjectId(id));
		const includeCancelled =
			String(req.query?.includeCancelled || "").toLowerCase() === "true";
		const excludeCancelled =
			String(req.query?.excludeCancelled ?? "true").toLowerCase() !== "false";
		const reservationMatch = {
			hotelId: { $in: hotelObjectIds },
			checkin_date: { $lt: range.endExclusive },
			checkout_date: { $gt: range.start },
		};
		if (!includeCancelled && excludeCancelled) {
			reservationMatch.$nor = [
				{ reservation_status: CANCELLED_STATUS },
				{ state: CANCELLED_STATUS },
				{ reservation_status: NO_SHOW_STATUS },
				{ state: NO_SHOW_STATUS },
			];
		}
		const reservationClauses = [buildExcludePendingOtaReviewFilter()];
		const statusFilter = reservationStatusFilter(req.query?.status);
		if (statusFilter) reservationClauses.push(statusFilter);
		const bookingSources = parseQueryList(req.query?.bookingSource);
		if (bookingSources.length) {
			reservationClauses.push({
				$or: bookingSources.map((source) => ({
					booking_source: new RegExp(escapeRegex(source), "i"),
				})),
			});
		}
		if (req.query?.payment) {
			reservationClauses.push({
				payment: new RegExp(escapeRegex(req.query.payment), "i"),
			});
		}
		const searchFilter = executiveReservationSearchFilter(
			req.query?.search,
			selectedHotels
		);
		if (searchFilter) reservationClauses.push(searchFilter);
		if (reservationClauses.length) {
			reservationMatch.$and = reservationClauses;
		}

		const [rooms, reservations] = await Promise.all([
			Rooms.find({ hotelId: { $in: hotelObjectIds } })
				.select("_id hotelId active activeRoom")
				.lean()
				.exec(),
			Reservations.find(reservationMatch)
				.select(
					"hotelId roomId total_rooms pickedRoomsType pickedRoomsPricing checkin_date checkout_date total_amount sub_total adminPricing adminPricingVisibility reservation_status state"
				)
				.lean()
				.exec(),
		]);

		const roomsByHotel = new Map();
		rooms.forEach((room) => {
			const hotelId = normalizeId(room.hotelId);
			if (!roomsByHotel.has(hotelId)) roomsByHotel.set(hotelId, []);
			roomsByHotel.get(hotelId).push(room);
		});

		const hotelRows = selectedHotels.map((hotel) => {
			const hotelId = normalizeId(hotel._id);
			const hotelRooms = roomsByHotel.get(hotelId) || [];
			const activePhysicalRooms = hotelRooms.filter(
				(room) => room.active !== false && room.activeRoom !== false
			).length;
			const declaredRooms = getDeclaredRoomsTotal(hotel);
			const capacity = activePhysicalRooms || declaredRooms;
			return {
				_id: hotelId,
				hotelName: hotel.hotelName || "Hotel",
				ownerId: normalizeId(hotel.belongsTo),
				ownerName: hotel.belongsTo?.name || "",
				totalRooms: capacity,
				occupiedRoomNights: 0,
				totalRoomNights: capacity * range.days.length,
				reservationsCount: 0,
				totalAmount: 0,
				todayOccupied: 0,
				todayAvailable: capacity,
			};
		});

		const hotelRowMap = new Map(hotelRows.map((hotel) => [hotel._id, hotel]));
		const dayRows = range.days.map((date) => ({
			date,
			capacity: hotelRows.reduce((total, hotel) => total + hotel.totalRooms, 0),
			occupied: 0,
			available: 0,
			reservationsCount: 0,
			occupancyRate: 0,
		}));
		const dayRowMap = new Map(dayRows.map((day) => [day.date, day]));
		const todayKey = ymdFromDate(new Date());

		reservations.forEach((reservation) => {
			const hotelId = normalizeId(reservation.hotelId);
			const hotelRow = hotelRowMap.get(hotelId);
			if (!hotelRow) return;
			const units = reservationUnitCount(reservation);
			const checkin = startOfUtcDate(reservation.checkin_date);
			const checkout = startOfUtcDate(reservation.checkout_date);
			hotelRow.reservationsCount += 1;
			hotelRow.totalAmount += hotelVisibleReservationAmount(reservation);

			range.days.forEach((date) => {
				const dayStart = new Date(`${date}T00:00:00.000Z`);
				const nextDay = addUtcDays(dayStart, 1);
				if (checkin < nextDay && checkout > dayStart) {
					const dayRow = dayRowMap.get(date);
					if (dayRow) {
						dayRow.occupied += units;
						dayRow.reservationsCount += 1;
					}
					hotelRow.occupiedRoomNights += units;
					if (date === todayKey) hotelRow.todayOccupied += units;
				}
			});
		});

		hotelRows.forEach((hotel) => {
			hotel.todayOccupied = Math.min(hotel.todayOccupied, hotel.totalRooms);
			hotel.todayAvailable = Math.max(hotel.totalRooms - hotel.todayOccupied, 0);
			hotel.occupancyRate = hotel.totalRoomNights
				? Math.round((hotel.occupiedRoomNights / hotel.totalRoomNights) * 10000) / 100
				: 0;
		});

		dayRows.forEach((day) => {
			day.occupied = Math.min(day.occupied, day.capacity);
			day.available = Math.max(day.capacity - day.occupied, 0);
			day.occupancyRate = day.capacity
				? Math.round((day.occupied / day.capacity) * 10000) / 100
				: 0;
		});

		const stats = hotelRows.reduce(
			(acc, hotel) => {
				acc.totalRooms += hotel.totalRooms;
				acc.todayOccupied += hotel.todayOccupied;
				acc.todayAvailable += hotel.todayAvailable;
				acc.occupiedRoomNights += hotel.occupiedRoomNights;
				acc.totalRoomNights += hotel.totalRoomNights;
				acc.reservationsCount += hotel.reservationsCount;
				acc.totalAmount += hotel.totalAmount;
				return acc;
			},
			{
				totalHotels: hotelRows.length,
				totalRooms: 0,
				todayOccupied: 0,
				todayAvailable: 0,
				occupiedRoomNights: 0,
				totalRoomNights: 0,
				reservationsCount: 0,
				totalAmount: 0,
			}
		);
		stats.occupancyRate = stats.totalRoomNights
			? Math.round((stats.occupiedRoomNights / stats.totalRoomNights) * 10000) / 100
			: 0;

		let calendar = null;
		let calendarError = "";
		if (hotelIds.length === 1) {
			try {
				calendar = await buildHotelInventoryCalendarPayload(hotelIds[0], {
					start: ymdFromDate(range.start),
					end: ymdFromDate(range.end),
					includeCancelled,
					paymentStatuses: req.query?.paymentStatuses,
				});
			} catch (calendarBuildError) {
				calendarError = calendarBuildError?.message || "Could not load inventory calendar";
			}
		}

		return res.json({
			asOf: new Date(),
			range: {
				start: ymdFromDate(range.start),
				end: ymdFromDate(range.end),
				days: range.days,
				period: range.period,
			},
			allHotels: executiveHotelOptions(context.hotels),
			hotels: hotelRows.sort((a, b) => b.occupancyRate - a.occupancyRate),
			days: dayRows,
			stats,
			calendar,
			calendarError,
		});
	} catch (error) {
		console.error("overallExecutiveInventoryReport error:", error);
		return res.status(500).json({
			error: "Could not load executive inventory report",
		});
	}
};

exports.overallExecutiveInventoryDayReport = async (req, res) => {
	try {
		const context = await requireOverallSection(req, res, "executive");
		if (!context) return;

		const requestedHotelId = req.query?.hotelId || req.query?.invHotel || "";
		if (!requestedHotelId) {
			return res.status(400).json({ error: "hotelId is required" });
		}

		const hotelIds = filterHotelIdsForQuery(context.hotels, requestedHotelId);
		if (hotelIds.length !== 1) {
			return res.status(403).json({
				error: "You cannot view inventory for this hotel",
			});
		}

		const payload = await buildHotelInventoryDayPayload(hotelIds[0], {
			date: req.query?.date,
			roomKey: req.query?.roomKey,
			includeCancelled:
				String(req.query?.includeCancelled || "").toLowerCase() === "true",
			paymentStatuses: req.query?.paymentStatuses,
		});

		return res.json(payload);
	} catch (error) {
		console.error("overallExecutiveInventoryDayReport error:", error);
		return res.status(error?.status || 500).json({
			error: error?.message || "Could not load inventory day report",
		});
	}
};

exports.overallExecutivePaidReport = async (req, res) => {
	try {
		const context = await requireOverallSection(req, res, "executive");
		if (!context) return;

		const built = buildExecutivePaidMatch({
			hotels: context.hotels,
			query: req.query || {},
		});
		if (!built) {
			return res.json({
				data: [],
				totalDocuments: 0,
				page: 1,
				limit: 0,
				hotels: [],
				allHotels: executiveHotelOptions(context.hotels),
				scorecards: {},
				byHotel: [],
				byBookingSource: [],
			});
		}

		const page = Math.max(parseInt(req.query?.page, 10) || 1, 1);
		const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 50, 1), 250);
		const skip = (page - 1) * limit;
		const breakdownTotalsProjection = EXECUTIVE_PAID_BREAKDOWN_KEYS.reduce(
			(acc, key) => ({
				...acc,
				[key]: { $sum: { $ifNull: [`$paid_amount_breakdown.${key}`, 0] } },
			}),
			{}
		);

		const [totalDocuments, reservations, scorecardRows, byHotel, byBookingSource] =
			await Promise.all([
				Reservations.countDocuments(built.match),
				Reservations.find(built.match)
					.sort({ checkin_date: -1, createdAt: -1 })
					.skip(skip)
					.limit(limit)
					.populate("hotelId", "hotelName belongsTo")
					.lean()
					.exec(),
				Reservations.aggregate([
					{ $match: built.match },
					{
						$addFields: {
							paidBreakdownTotal: executivePaidBreakdownTotalExpression(),
						},
					},
					{
						$group: {
							_id: null,
							reservationsCount: { $sum: 1 },
							totalAmount: { $sum: hotelVisibleReservationAmountExpression() },
							paidAmount: {
								$sum: {
									$cond: [
										{ $gt: ["$paidBreakdownTotal", 0] },
										"$paidBreakdownTotal",
										{ $ifNull: ["$paid_amount", 0] },
									],
								},
							},
							commission: { $sum: executiveStoredCommissionExpression() },
							...breakdownTotalsProjection,
						},
					},
				]),
				aggregateExecutiveByHotel(built.match),
				aggregateExecutiveByBookingSource(built.match),
			]);

		const data = sanitizeReservationAuditLogsCollectionForViewer(reservations).map((reservation) => {
			const paidTotal = paidBreakdownTotal(reservation.paid_amount_breakdown);
			const fallbackPaid = paidTotal || moneyNumber(reservation.paid_amount);
			return {
				...reservation,
				paid_breakdown_total: fallbackPaid,
				paid_breakdown_remaining: Math.max(
					moneyNumber(reservation.total_amount) - fallbackPaid,
					0
				),
			};
		});

		const scorecard = scorecardRows?.[0] || {};
		const breakdownTotals = EXECUTIVE_PAID_BREAKDOWN_KEYS.reduce((acc, key) => {
			acc[key] = moneyNumber(scorecard[key]);
			return acc;
		}, {});

		return res.json({
			data,
			totalDocuments,
			page,
			limit,
			pages: Math.ceil(totalDocuments / limit),
			hotels: executiveHotelOptions(context.hotels).filter((hotel) =>
				built.hotelIds.includes(hotel._id)
			),
			allHotels: executiveHotelOptions(context.hotels),
			scorecards: {
				reservationsCount: moneyNumber(scorecard.reservationsCount),
				totalAmount: moneyNumber(scorecard.totalAmount),
				paidAmount: moneyNumber(scorecard.paidAmount),
				remainingAmount: Math.max(
					moneyNumber(scorecard.totalAmount) - moneyNumber(scorecard.paidAmount),
					0
				),
				commission: moneyNumber(scorecard.commission),
				breakdownTotals,
			},
			byHotel,
			byBookingSource,
		});
	} catch (error) {
		console.error("overallExecutivePaidReport error:", error);
		return res.status(500).json({
			error: "Could not load executive paid report",
		});
	}
};

exports.overallReservations = async (req, res) => {
	try {
		const context = await requireOverallSection(req, res, "reservations");
		if (!context) return;
		const data = await listReservations({
			actor: context.actor,
			hotels: context.hotels,
			query: req.query || {},
		});
		return res.json(data);
	} catch (error) {
		console.error("overallReservations error:", error);
		return res.status(500).json({ error: "Could not load overall reservations" });
	}
};

exports.exportOverallReservations = async (req, res) => {
	try {
		const context = await requireOverallSection(req, res, "reservations");
		if (!context) return;
		const data = await listReservations({
			actor: context.actor,
			hotels: context.hotels,
			query: { ...(req.query || {}), exportAll: "true", page: 1 },
		});
		await trackReservationExport({
			req,
			actor: context.actor,
			hotels: context.hotels,
			query: req.query || {},
			dataset: "overall_reservations",
			totalRows: data.total,
			rows: data.reservations,
		});
		return res.json({ ...data, exportedAt: new Date(), exportTracked: true });
	} catch (error) {
		console.error("exportOverallReservations error:", error);
		return res
			.status(500)
			.json({ error: "Could not export overall reservations" });
	}
};

exports.overallPendingReservations = async (req, res) => {
	try {
		const context = await requireOverallSection(req, res, "pending");
		if (!context) return;
		const data = await listReservations({
			actor: context.actor,
			hotels: context.hotels,
			query: req.query || {},
			pendingOnly: true,
		});
		return res.json(data);
	} catch (error) {
		console.error("overallPendingReservations error:", error);
		return res
			.status(500)
			.json({ error: "Could not load pending reservations" });
	}
};

exports.exportOverallPendingReservations = async (req, res) => {
	try {
		const context = await requireOverallSection(req, res, "pending");
		if (!context) return;
		const data = await listReservations({
			actor: context.actor,
			hotels: context.hotels,
			query: { ...(req.query || {}), exportAll: "true", page: 1 },
			pendingOnly: true,
		});
		await trackReservationExport({
			req,
			actor: context.actor,
			hotels: context.hotels,
			query: req.query || {},
			dataset: "overall_pending_reservations",
			totalRows: data.total,
			rows: data.reservations,
		});
		return res.json({ ...data, exportedAt: new Date(), exportTracked: true });
	} catch (error) {
		console.error("exportOverallPendingReservations error:", error);
		return res
			.status(500)
			.json({ error: "Could not export pending reservations" });
	}
};

exports.overallRejectedReservations = async (req, res) => {
	try {
		const context = await requireOverallSection(req, res, "pending");
		if (!context) return;
		const data = await listReservations({
			actor: context.actor,
			hotels: context.hotels,
			query: req.query || {},
			rejectedOnly: true,
		});
		return res.json(data);
	} catch (error) {
		console.error("overallRejectedReservations error:", error);
		return res
			.status(500)
			.json({ error: "Could not load rejected reservations" });
	}
};

exports.exportOverallRejectedReservations = async (req, res) => {
	try {
		const context = await requireOverallSection(req, res, "pending");
		if (!context) return;
		const data = await listReservations({
			actor: context.actor,
			hotels: context.hotels,
			query: { ...(req.query || {}), exportAll: "true", page: 1 },
			rejectedOnly: true,
		});
		await trackReservationExport({
			req,
			actor: context.actor,
			hotels: context.hotels,
			query: req.query || {},
			dataset: "overall_rejected_reservations",
			totalRows: data.total,
			rows: data.reservations,
		});
		return res.json({ ...data, exportedAt: new Date(), exportTracked: true });
	} catch (error) {
		console.error("exportOverallRejectedReservations error:", error);
		return res
			.status(500)
			.json({ error: "Could not export rejected reservations" });
	}
};

exports.overallFinancialActions = async (req, res) => {
	try {
		if (isSuperAdmin(getActor(req)) && !normalizeId(req.query?.ownerId)) {
			req.query.includeAll = "true";
		}
		const context = await requireOverallSection(req, res, "financials");
		if (!context) return;
		const data = await listFinancialActions({
			actor: context.actor,
			hotels: context.hotels,
			query: req.query || {},
		});
		return res.json(data);
	} catch (error) {
		console.error("overallFinancialActions error:", error);
		return res
			.status(500)
			.json({ error: "Could not load financial actions" });
	}
};

const idsFromFinancialExportPayload = (payload = {}) => {
	const filters = payload.filters || {};
	const rows = [
		...(Array.isArray(payload.agents) ? payload.agents : []),
		...(Array.isArray(payload.transactions) ? payload.transactions : []),
		...(Array.isArray(payload.reservations) ? payload.reservations : []),
	];
	return uniqueValidIds([
		filters.hotelId,
		...(Array.isArray(filters.hotelIds) ? filters.hotelIds : []),
		...rows.map((row) => row.hotelId || row.HotelId || row._hotelId),
	]);
};

const idsFromReservationSummaryExportPayload = (payload = {}) => {
	const filters = payload.filters || {};
	const rows = Array.isArray(payload.reservations) ? payload.reservations : [];
	return uniqueValidIds([
		...parseQueryList(filters.hotelId),
		...parseQueryList(filters.hotelIds),
		...parseQueryList(payload.hotelId),
		...parseQueryList(payload.hotelIds),
		...rows.map((row) => row.hotelId || row.HotelId || row._hotelId),
	]);
};

exports.trackOverallReservationSummaryExport = async (req, res) => {
	try {
		const context = await requireOverallSection(req, res, "reservations");
		if (!context) return;
		const payload = req.body || {};
		const allowedHotelIds = new Set(selectedHotelIds(context.hotels));
		const payloadHotelIds = idsFromReservationSummaryExportPayload(payload);
		const blockedHotelId = payloadHotelIds.find((id) => !allowedHotelIds.has(id));
		if (blockedHotelId) {
			return res
				.status(403)
				.json({ error: "You cannot export reservation data for this hotel" });
		}

		const selectedPayloadHotels = payloadHotelIds.length
			? payloadHotelIds
			: filterHotelIdsForQuery(
					context.hotels,
					payload.filters?.hotelId || req.query?.hotelId
			  );
		const exportedHotels = selectedPayloadHotels.length
			? context.hotels.filter((hotel) =>
					selectedPayloadHotels.includes(normalizeId(hotel._id))
			  )
			: context.hotels;
		const tracked = await trackReservationSummaryExport({
			req,
			actor: context.actor,
			hotels: exportedHotels,
			filters: {
				...(payload.filters || {}),
				ownerId: payload.filters?.ownerId || req.query?.ownerId || "",
			},
			dataset: payload.dataset || "overall_reservation_summary",
			format: payload.format || "XLSX",
			dateBy: payload.dateBy || payload.filters?.dateBy || "createdAt",
			totalRows: payload.totalRows,
			summary: payload.summary || {},
			rows: Array.isArray(payload.reservations) ? payload.reservations : [],
		});

		if (!tracked) {
			return res
				.status(500)
				.json({ error: "Could not track reservation summary export" });
		}

		return res.json({
			exportTracked: true,
			exportedAt: new Date(),
		});
	} catch (error) {
		console.error("trackOverallReservationSummaryExport error:", error);
		return res
			.status(500)
			.json({ error: "Could not track reservation summary export" });
	}
};

exports.trackOverallFinancialReportExport = async (req, res) => {
	try {
		if (isSuperAdmin(getActor(req)) && !normalizeId(req.query?.ownerId)) {
			req.query.includeAll = "true";
		}
		const context = await requireOverallSection(req, res, "financials");
		if (!context) return;
		const payload = req.body || {};
		const allowedHotelIds = new Set(selectedHotelIds(context.hotels));
		const payloadHotelIds = idsFromFinancialExportPayload(payload);
		const blockedHotelId = payloadHotelIds.find((id) => !allowedHotelIds.has(id));
		if (blockedHotelId) {
			return res
				.status(403)
				.json({ error: "You cannot export financial data for this hotel" });
		}

		const exportedHotels = payloadHotelIds.length
			? context.hotels.filter((hotel) =>
					payloadHotelIds.includes(normalizeId(hotel._id))
			  )
			: context.hotels;
		const columns = [
			...(Array.isArray(payload.columns) ? payload.columns : []),
			...(Array.isArray(payload.agentColumns) ? payload.agentColumns : []),
			...(Array.isArray(payload.transactionColumns)
				? payload.transactionColumns
				: []),
			...(Array.isArray(payload.reservationColumns)
				? payload.reservationColumns
				: []),
		];
		const tracked = await trackFinancialReportExport({
			req,
			actor: context.actor,
			hotels: exportedHotels,
			filters: {
				...(payload.filters || {}),
				ownerId: payload.filters?.ownerId || req.query?.ownerId || "",
			},
			dataset: payload.dataset || "overall_financial_report",
			format: payload.format || "XLSX",
			totalRows: payload.totalRows,
			columns: [...new Set(columns.map(String).filter(Boolean))],
			totals: payload.totals || {},
			agents: Array.isArray(payload.agents) ? payload.agents : [],
			transactions: Array.isArray(payload.transactions)
				? payload.transactions
				: [],
			reservations: Array.isArray(payload.reservations)
				? payload.reservations
				: [],
		});

		if (!tracked) {
			return res
				.status(500)
				.json({ error: "Could not track financial report export" });
		}

		return res.json({
			exportTracked: true,
			exportedAt: new Date(),
		});
	} catch (error) {
		console.error("trackOverallFinancialReportExport error:", error);
		return res
			.status(500)
			.json({ error: "Could not track financial report export" });
	}
};

const applyHousekeepingStatusFilter = (match, status = "") => {
	const normalized = String(status || "").trim().toLowerCase();
	if (!normalized || normalized === "all") return;
	if (normalized === "finished" || normalized === "clean") {
		match.task_status = FINISHED_HOUSEKEEPING_STATUS;
		return;
	}
	if (normalized === "open" || normalized === "unfinished") {
		match.task_status = { $not: FINISHED_HOUSEKEEPING_STATUS };
		return;
	}
	match.task_status = new RegExp(escapeRegex(normalized), "i");
};

exports.overallHousekeeping = async (req, res) => {
	try {
		const context = await requireOverallSection(req, res, "housekeeping");
		if (!context) return;
		const hotelIds = filterHotelIdsForQuery(context.hotels, req.query?.hotelId);
		const hotelOptions = context.hotels.map((hotel) => ({
			_id: normalizeId(hotel._id),
			hotelName: hotel.hotelName || "Hotel",
			ownerId: normalizeId(hotel.belongsTo),
		}));
		if (!hotelIds.length) {
			return res.json({
				page: 1,
				limit: 0,
				total: 0,
				pages: 0,
				hotels: hotelOptions,
				tasks: [],
			});
		}

		const page = Math.max(parseInt(req.query?.page, 10) || 1, 1);
		const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 25, 1), 100);
		const match = { hotelId: { $in: hotelIds.map((id) => ObjectId(id)) } };
		applyHousekeepingStatusFilter(match, req.query?.status);

		const period = cleanDateRange({
			dateFrom: req.query?.dateFrom || req.query?.fromDate || "",
			dateTo: req.query?.dateTo || req.query?.toDate || "",
			range: req.query?.range || "all",
		});
		const dateFilter = {};
		if (period.from) dateFilter.$gte = period.from;
		if (period.to) dateFilter.$lte = period.to;
		if (Object.keys(dateFilter).length) match.taskDate = dateFilter;

		const basePipeline = [
			{ $match: match },
			{
				$lookup: {
					from: "hoteldetails",
					localField: "hotelId",
					foreignField: "_id",
					as: "hotelDetails",
				},
			},
			{ $unwind: { path: "$hotelDetails", preserveNullAndEmptyArrays: true } },
			{
				$lookup: {
					from: "users",
					localField: "assignedTo",
					foreignField: "_id",
					as: "assignedToUser",
				},
			},
			{
				$lookup: {
					from: "users",
					localField: "cleanedBy",
					foreignField: "_id",
					as: "cleanedByUser",
				},
			},
			{
				$lookup: {
					from: "rooms",
					localField: "rooms",
					foreignField: "_id",
					as: "roomDetails",
				},
			},
			{
				$addFields: {
					hotelName: { $ifNull: ["$hotelDetails.hotelName", ""] },
					hotelOwnerId: "$hotelDetails.belongsTo",
					assignedToName: {
						$ifNull: [{ $arrayElemAt: ["$assignedToUser.name", 0] }, ""],
					},
					cleanedByName: {
						$ifNull: [{ $arrayElemAt: ["$cleanedByUser.name", 0] }, ""],
					},
				},
			},
		];

		const search = String(req.query?.search || "").trim();
		if (search) {
			const regex = new RegExp(escapeRegex(search), "i");
			basePipeline.push({
				$match: {
					$or: [
						{ hotelName: regex },
						{ confirmation_number: regex },
						{ task_status: regex },
						{ task_comment: regex },
						{ customTask: regex },
						{ assignedToName: regex },
						{ cleanedByName: regex },
						{ "roomDetails.room_number": regex },
					],
				},
			});
		}

		const [countResult, tasks, statusStats] = await Promise.all([
			HouseKeeping.aggregate([...basePipeline, { $count: "total" }]),
			HouseKeeping.aggregate([
				...basePipeline,
				{ $sort: { taskDate: -1, createdAt: -1 } },
				{ $skip: (page - 1) * limit },
				{ $limit: limit },
				{
					$project: {
						hotelDetails: 0,
						assignedToUser: 0,
						cleanedByUser: 0,
					},
				},
			]),
			HouseKeeping.aggregate([
				{ $match: match },
				{ $group: { _id: "$task_status", total: { $sum: 1 } } },
				{ $sort: { total: -1 } },
			]),
		]);

		const total = countResult?.[0]?.total || 0;
		return res.json({
			page,
			limit,
			total,
			pages: Math.ceil(total / limit),
			stats: statusStats.map((item) => ({
				status: item._id || "unfinished",
				total: item.total || 0,
			})),
			hotels: hotelOptions,
			tasks,
		});
	} catch (error) {
		console.error("overallHousekeeping error:", error);
		return res.status(500).json({ error: "Could not load housekeeping overall" });
	}
};

const accountRoleFilter = (role = "") => {
	const requestedRoles = parseQueryList(role)
		.map((item) => item.toLowerCase())
		.filter((item) => item && item !== "all");
	if (requestedRoles.length > 1) {
		const roleClauses = requestedRoles
			.map((item) => accountRoleFilter(item))
			.filter(Boolean);
		return roleClauses.length ? { $or: roleClauses } : null;
	}
	const normalized = requestedRoles[0] || "";
	if (!normalized || normalized === "all") return null;
	if (normalized === "systemadmin" || normalized === "system admin") {
		return {
			$or: [
				{ role: SYSTEM_ADMIN_ROLE },
				{ roles: SYSTEM_ADMIN_ROLE },
				{ roleDescription: "systemadmin" },
				{ roleDescriptions: "systemadmin" },
			],
		};
	}
	const roleMap = {
		hotelmanager: 2000,
		reception: 3000,
		housekeepingmanager: 4000,
		housekeeping: 5000,
		finance: 6000,
		ordertaker: 7000,
		reservationemployee: 8000,
	};
	if (roleMap[normalized]) {
		return {
			$or: [
				{ role: roleMap[normalized] },
				{ roles: roleMap[normalized] },
				{ roleDescription: normalized },
				{ roleDescriptions: normalized },
			],
		};
	}
	const numeric = Number(normalized);
	if (Number.isFinite(numeric) && numeric > 0) {
		return { $or: [{ role: numeric }, { roles: numeric }] };
	}
	return {
		$or: [
			{ roleDescription: normalized },
			{ roleDescriptions: normalized },
		],
	};
};

const accountScopeQuery = (hotels = [], actor = {}) => {
	const hotelIds = selectedHotelIds(hotels);
	const hotelObjectIds = hotelIds.map((id) => ObjectId(id));
	const ownerIds = [
		...new Set(hotels.map((hotel) => normalizeId(hotel.belongsTo)).filter(Boolean)),
	];
	const ownerObjectIds = ownerIds
		.filter((id) => ObjectId.isValid(id))
		.map((id) => ObjectId(id));
	const hotelAssignmentClauses = [
		...(hotelIds.length ? [{ hotelIdWork: { $in: hotelIds } }] : []),
		...(hotelObjectIds.length ? [{ hotelsToSupport: { $in: hotelObjectIds } }] : []),
	];
	const systemAdminHotelClauses = [
		...hotelAssignmentClauses,
		...(hotelObjectIds.length ? [{ hotelIdsOwner: { $in: hotelObjectIds } }] : []),
	];
	const relationshipClauses = [
		...(ownerObjectIds.length ? [{ _id: { $in: ownerObjectIds } }] : []),
		...(ownerIds.length ? [{ belongsToId: { $in: ownerIds } }] : []),
		...hotelAssignmentClauses,
		...(systemAdminHotelClauses.length
			? [
					{
						$and: [
							accountRoleFilter("systemadmin"),
							{ $or: systemAdminHotelClauses },
						],
					},
			  ]
			: []),
	].filter(Boolean);
	const platformAdminExclusion =
		ownerObjectIds.length
			? [
					{
						$and: [
							{
								$or: [
									{ role: 1000 },
									{ roles: 1000 },
									...configuredSuperAdminIds()
										.filter((id) => ObjectId.isValid(id))
										.map((id) => ({ _id: ObjectId(id) })),
								],
							},
							{ _id: { $nin: ownerObjectIds } },
						],
					},
			  ]
			: [
					{
						$or: [
							{ role: 1000 },
							{ roles: 1000 },
							...configuredSuperAdminIds()
								.filter((id) => ObjectId.isValid(id))
								.map((id) => ({ _id: ObjectId(id) })),
						],
					},
			  ];

	return {
		$and: [
			{ $or: relationshipClauses.length ? relationshipClauses : [{ _id: null }] },
			{ $nor: platformAdminExclusion },
		],
	};
};

exports.overallAccounts = async (req, res) => {
	try {
		const context = await requireOverallSection(req, res, "accounts");
		if (!context) return;
		if (!isOwnerLike(context.actor) && !hasRoleDescription(context.actor, "hotelmanager")) {
			return res.status(403).json({ error: "You cannot view overall accounts" });
		}

		const hotelIds = filterHotelIdsForQuery(context.hotels, req.query?.hotelId);
		const scopedHotels = context.hotels.filter((hotel) =>
			hotelIds.includes(normalizeId(hotel._id))
		);
		if (!scopedHotels.length) {
			return res.json({
				page: 1,
				limit: 0,
				total: 0,
				pages: 0,
				hotels: context.hotels.map((hotel) => ({
					_id: normalizeId(hotel._id),
					hotelName: hotel.hotelName || "Hotel",
					ownerId: normalizeId(hotel.belongsTo),
				})),
				accounts: [],
			});
		}

		const page = Math.max(parseInt(req.query?.page, 10) || 1, 1);
		const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 25, 1), 100);
		const filters = [accountScopeQuery(scopedHotels, context.actor)];
		const roleFilter = accountRoleFilter(req.query?.role);
		if (roleFilter) filters.push(roleFilter);
		const requestedStatuses = parseQueryList(req.query?.status)
			.map((item) => item.toLowerCase())
			.filter((item) => item && item !== "all");
		const wantsActive = requestedStatuses.includes("active");
		const wantsInactive = requestedStatuses.includes("inactive");
		if (wantsActive && !wantsInactive) {
			filters.push({ activeUser: true });
		}
		if (wantsInactive && !wantsActive) {
			filters.push({ activeUser: false });
		}
		const search = String(req.query?.search || "").trim();
		if (search) {
			const regex = new RegExp(escapeRegex(search), "i");
			filters.push({
				$or: [
					{ name: regex },
					{ email: regex },
					{ phone: regex },
					{ companyName: regex },
					{ roleDescription: regex },
				],
			});
		}

		const query = filters.length === 1 ? filters[0] : { $and: filters };
		const [total, accounts] = await Promise.all([
			User.countDocuments(query),
			User.find(query)
				.select(
					"_id name email emailIsPlaceholder phone companyName companyOfficialName companyEin companyDocuments agentCommercialModel agentOpeningWalletCredit agentWalletOpeningBalances priceVariantAssignments agentPayoutDetails agentApproval applicationReview role roleDescription roles roleDescriptions activeUser hotelIdWork hotelIdsWork belongsToId hotelsToSupport hotelIdsOwner accessTo createdAt updatedAt"
				)
				.populate("hotelsToSupport", "_id hotelName belongsTo")
				.populate("hotelIdsOwner", "_id hotelName belongsTo")
				.sort({ role: 1, name: 1 })
				.skip((page - 1) * limit)
				.limit(limit)
				.lean()
				.exec(),
		]);

		return res.json({
			page,
			limit,
			total,
			pages: Math.ceil(total / limit),
			hotels: context.hotels.map((hotel) => ({
				_id: normalizeId(hotel._id),
				hotelName: hotel.hotelName || "Hotel",
				ownerId: normalizeId(hotel.belongsTo),
			})),
			accounts: accounts.map((account) =>
				sanitizeAccountForOverallResponse(account, hotelIds)
			),
		});
	} catch (error) {
		console.error("overallAccounts error:", error);
		return res.status(500).json({ error: "Could not load overall accounts" });
	}
};

exports.createSignupInvitation = async (req, res) => {
	try {
		const context = await requireOverallSection(req, res, "accounts");
		if (!context) return;
		if (!isOwnerLike(context.actor) && !hasRoleDescription(context.actor, "hotelmanager")) {
			return res.status(403).json({ error: "You cannot create signup invitations" });
		}

		const payload = req.body || {};
		const accountType = normalizeInvitationType(
			payload.accountType || payload.signupIntent || payload.applicationType
		);
		if (!accountType) {
			return res.status(400).json({ error: "Please select an invitation type" });
		}

		const selectedIds = uniqueValidIds(
			parseQueryList(
				payload.hotelIds ||
					payload.hotelId ||
					payload.hotelIdsWork ||
					payload.hotelsToSupport
			)
		);
		const hotelIds =
			accountType === "job" ? selectedIds.slice(0, 1) : selectedIds;
		if (!hotelIds.length) {
			return res.status(400).json({ error: "Please select at least one hotel" });
		}
		const hotelValidation = await validateHotelSubset(
			hotelIds,
			context.hotels,
			context.actor
		);
		if (!hotelValidation.ok) {
			const status =
				hotelValidation.error === "You cannot assign one or more hotels"
					? 403
					: 400;
			return res.status(status).json({
				error:
					hotelValidation.error === "You cannot assign one or more hotels"
						? "You cannot invite for one or more hotels"
						: hotelValidation.error,
			});
		}

		const selectedHotels = hotelValidation.hotels
			.map((hotel) => ({
				_id: normalizeId(hotel._id),
				hotelName: hotel.hotelName || "Hotel",
				ownerId: normalizeId(hotel.belongsTo),
			}));
		const roleDescription =
			accountType === "agent"
				? "ordertaker"
				: normalizeInvitationRole(
						payload.roleDescription ||
							payload.requestedRoleDescription ||
							payload.jobRole
				  );
		let priceVariantAssignments = [];
		if (accountType === "agent") {
			try {
				priceVariantAssignments = await normalizePriceVariantAssignments({
					assignments: payload.priceVariantAssignments,
					hotelIds,
					actor: context.actor,
				});
			} catch (error) {
				return res.status(400).json({
					error: error.message || "Invalid price variant assignment",
				});
			}
		}
		const invitationPayload = {
			purpose: SIGNUP_INVITATION_PURPOSE,
			accountType,
			signupIntent: accountType,
			roleDescription,
			hotelIds,
			hotelNames: selectedHotels.map((hotel) => hotel.hotelName),
			ownerIds: [...new Set(selectedHotels.map((hotel) => hotel.ownerId).filter(Boolean))],
			name: String(payload.name || "").trim(),
			email: String(payload.email || "").trim().toLowerCase(),
			phone: String(payload.phone || "").trim(),
			companyName: String(payload.companyName || "").trim(),
			companyOfficialName: String(payload.companyOfficialName || "").trim(),
			companyEin: String(payload.companyEin || "").trim(),
			agentCommercialModel: String(payload.agentCommercialModel || "wallet_inventory")
				.trim()
				.toLowerCase(),
			agentOpeningWalletCredit: Number(payload.agentOpeningWalletCredit || 0) || 0,
			priceVariantAssignments,
			applicationNotes: String(payload.applicationNotes || "").trim().slice(0, 1000),
			createdBy: {
				_id: normalizeId(context.actor._id),
				name: context.actor.name || "",
				role: context.actor.roleDescription || context.actor.role || "",
			},
		};
		const token = jwt.sign(invitationPayload, process.env.JWT_SECRET, {
			expiresIn: `${SIGNUP_INVITATION_DAYS}d`,
		});
		const code = await createInvitationRecord(invitationPayload, context.actor);
		return res.json({
			code,
			token,
			expiresIn: `${SIGNUP_INVITATION_DAYS}d`,
			invitation: invitationPayload,
		});
	} catch (error) {
		console.error("createSignupInvitation error:", error);
		return res.status(500).json({ error: "Could not create signup invitation" });
	}
};

const canManageSystemAdminAccounts = (actor = {}) => isOwnerLike(actor);

const validateHotelSubset = async (requestedIds = [], hotels = [], actor = {}) => {
	const picked = uniqueValidIds(requestedIds);
	if (!picked.length) return { ok: false, ids: [], error: "Please select hotels" };
	const hotelMap = new Map(
		hotels.map((hotel) => [normalizeId(hotel._id), hotel]).filter(([id]) => id)
	);
	if (isSuperAdmin(actor)) {
		const missingFromContext = picked.filter((id) => !hotelMap.has(id));
		if (missingFromContext.length) {
			const foundHotels = await HotelDetails.find({
				_id: { $in: picked.map((id) => ObjectId(id)) },
			})
				.select("_id hotelName belongsTo")
				.populate("belongsTo", "_id name email phone")
				.lean()
				.exec();
			foundHotels.forEach((hotel) => {
				hotelMap.set(normalizeId(hotel._id), hotel);
			});
		}
		const missingHotel = picked.find((id) => !hotelMap.has(id));
		if (missingHotel) {
			return {
				ok: false,
				ids: [],
				hotels: [],
				error: "One or more selected hotels were not found",
			};
		}
		return {
			ok: true,
			ids: picked,
			hotels: picked.map((id) => hotelMap.get(id)).filter(Boolean),
		};
	}
	const allowed = new Set(hotelMap.keys());
	const blocked = picked.find((id) => !allowed.has(id));
	if (blocked) {
		return {
			ok: false,
			ids: [],
			hotels: [],
			error: "You cannot assign one or more hotels",
		};
	}
	return {
		ok: true,
		ids: picked,
		hotels: picked.map((id) => hotelMap.get(id)).filter(Boolean),
	};
};

const accountScopedHotelIds = (account = {}) =>
	uniqueValidIds([
		account.hotelIdWork,
		...(Array.isArray(account.hotelIdsWork) ? account.hotelIdsWork : []),
		...(Array.isArray(account.hotelIdsOwner) ? account.hotelIdsOwner : []),
		...(Array.isArray(account.hotelsToSupport)
			? account.hotelsToSupport
			: []),
	]);

exports.createOverallSystemAdmin = async (req, res) => {
	try {
		const context = await requireOverallSection(req, res, "accounts");
		if (!context) return;
		if (!canManageSystemAdminAccounts(context.actor)) {
			return res.status(403).json({ error: "You cannot create hotel system admins" });
		}

		const payload = req.body || {};
		const name = String(payload.name || "").trim();
		const email = String(payload.email || "").trim().toLowerCase();
		const phone = String(payload.phone || "").trim();
		const password = String(payload.password || "");
		const hotelValidation = await validateHotelSubset(
			payload.hotelIdsOwner || payload.hotelIds || payload.hotelsToSupport || [],
			context.hotels,
			context.actor
		);

		if (!name || !email || !phone || !password) {
			return res.status(400).json({ error: "Please fill all required fields" });
		}
		if (password.length < 6) {
			return res
				.status(400)
				.json({ error: "Password should be 6 characters or more" });
		}
		if (!hotelValidation.ok) {
			return res.status(400).json({ error: hotelValidation.error });
		}

		const duplicate = await User.findOne({
			$or: [{ email }, { phone }],
		})
			.select("_id")
			.lean()
			.exec();
		if (duplicate) {
			return res.status(400).json({
				error: "User already exists, please try a different email/phone",
			});
		}

		const hotelObjectIds = hotelValidation.ids.map((id) => ObjectId(id));
		const user = new User({
			name,
			email,
			password,
			phone,
			role: SYSTEM_ADMIN_ROLE,
			roleDescription: "systemadmin",
			roles: [SYSTEM_ADMIN_ROLE],
			roleDescriptions: ["systemadmin"],
			hotelIdsOwner: hotelObjectIds,
			hotelIdWork: hotelValidation.ids[0],
			hotelIdsWork: hotelObjectIds,
			hotelsToSupport: hotelObjectIds,
			belongsToId: "",
			activeUser: payload.activeUser === false ? false : true,
			accessTo: Array.isArray(payload.accessTo)
				? [
						...new Set(
							payload.accessTo
								.map((item) => String(item || "").trim())
								.filter(Boolean)
						),
				  ]
				: ["overall"],
			acceptedTermsAndConditions: true,
		});

		await user.save();
		await trackAccountCreation({
			req,
			actor: context.actor,
			account: user,
			source: "overall_system_admin_create",
			hotelId: hotelValidation.ids[0],
			hotelIds: hotelValidation.ids,
			ownerIds: [
				...new Set(
					(hotelValidation.hotels || [])
						.map((hotel) => normalizeId(hotel.belongsTo))
						.filter(Boolean)
				),
			],
		});
		return res.json({
			message: "Hotel System Admin account created successfully",
			user: sanitizeUserForResponse(user),
		});
	} catch (error) {
		console.error("createOverallSystemAdmin error:", error);
		return res.status(500).json({ error: "Could not create hotel system admin" });
	}
};

exports.updateOverallSystemAdmin = async (req, res) => {
	try {
		const context = await requireOverallSection(req, res, "accounts");
		if (!context) return;
		if (!canManageSystemAdminAccounts(context.actor)) {
			return res.status(403).json({ error: "You cannot update hotel system admins" });
		}

		const { accountId } = req.params;
		if (!ObjectId.isValid(accountId)) {
			return res.status(400).json({ error: "Invalid account id" });
		}

		const account = await User.findById(accountId).exec();
		if (!account) {
			return res.status(404).json({ error: "Account was not found" });
		}
		const accountBefore = account.toObject
			? account.toObject({ depopulate: true })
			: { ...account };

		const currentHotelValidation = await validateHotelSubset(
			accountScopedHotelIds(account),
			context.hotels,
			context.actor
		);
		if (!isSuperAdmin(context.actor) && !currentHotelValidation.ok) {
			return res.status(403).json({ error: "You cannot update this account" });
		}

		const payload = req.body || {};
		if ("name" in payload) {
			const name = String(payload.name || "").trim();
			if (!name) return res.status(400).json({ error: "Name is required" });
			account.name = name;
		}
		if ("email" in payload) {
			const email = String(payload.email || "").trim().toLowerCase();
			if (!email) return res.status(400).json({ error: "Email is required" });
			const duplicateEmail = await User.findOne({
				_id: { $ne: account._id },
				email: { $regex: new RegExp(`^${escapeRegex(email)}$`, "i") },
			})
				.select("_id")
				.lean()
				.exec();
			if (duplicateEmail) {
				return res.status(400).json({ error: "Email already in use" });
			}
			account.email = email;
		}
		if ("phone" in payload) {
			const phone = String(payload.phone || "").trim();
			if (!phone) return res.status(400).json({ error: "Phone is required" });
			const duplicatePhone = await User.findOne({
				_id: { $ne: account._id },
				phone,
			})
				.select("_id")
				.lean()
				.exec();
			if (duplicatePhone) {
				return res.status(400).json({ error: "Phone already in use" });
			}
			account.phone = phone;
		}
		if ("password" in payload && payload.password) {
			if (String(payload.password).length < 6) {
				return res
					.status(400)
					.json({ error: "Password should be 6 characters or more" });
			}
			account.password = String(payload.password);
		}
		if ("activeUser" in payload) {
			if (
				normalizeId(account._id) === normalizeId(context.actor._id) &&
				payload.activeUser === false
			) {
				return res
					.status(400)
					.json({ error: "You cannot deactivate your own account" });
			}
			account.activeUser = payload.activeUser === true || payload.activeUser === "true";
		}
		if ("accessTo" in payload && Array.isArray(payload.accessTo)) {
			account.accessTo = [
				...new Set(
					payload.accessTo
						.map((item) => String(item || "").trim())
						.filter(Boolean)
				),
			];
		}
		if (
			"hotelIdsOwner" in payload ||
			"hotelIds" in payload ||
			"hotelsToSupport" in payload
		) {
			const hotelValidation = await validateHotelSubset(
				payload.hotelIdsOwner || payload.hotelIds || payload.hotelsToSupport || [],
				context.hotels,
				context.actor
			);
			if (!hotelValidation.ok) {
				return res.status(400).json({ error: hotelValidation.error });
			}
			const hotelObjectIds = hotelValidation.ids.map((id) => ObjectId(id));
			account.hotelIdsOwner = hotelObjectIds;
			account.hotelIdWork = hotelValidation.ids[0];
			account.hotelIdsWork = hotelObjectIds;
			account.hotelsToSupport = hotelObjectIds;
		}

		account.role = SYSTEM_ADMIN_ROLE;
		account.roleDescription = "systemadmin";
		account.roles = [SYSTEM_ADMIN_ROLE];
		account.roleDescriptions = ["systemadmin"];
		account.belongsToId = "";

		await account.save();
		await trackAccountUpdate({
			req,
			actor: context.actor,
			accountBefore,
			accountAfter: account,
			source: "overall_system_admin_update",
			hotelId:
				normalizeId(account.hotelIdWork) ||
				(account.hotelsToSupport || [])[0] ||
				(account.hotelIdsOwner || [])[0],
			hotelIds: accountScopedHotelIds(account),
			ownerIds: [
				...new Set(
					(context.hotels || [])
						.filter((hotel) => accountScopedHotelIds(account).includes(normalizeId(hotel._id)))
						.map((hotel) => normalizeId(hotel.belongsTo))
						.filter(Boolean)
				),
			],
		});
		return res.json({
			message: "Hotel System Admin account updated successfully",
			user: sanitizeUserForResponse(account),
		});
	} catch (error) {
		console.error("updateOverallSystemAdmin error:", error);
		return res.status(500).json({ error: "Could not update hotel system admin" });
	}
};

const ROOM_TYPE_COLORS = {
	standardRooms: "#003366",
	singleRooms: "#8B0000",
	doubleRooms: "#004d00",
	twinRooms: "#800080",
	queenRooms: "#FF8C00",
	kingRooms: "#2F4F4F",
	tripleRooms: "#8B4513",
	quadRooms: "#00008B",
	studioRooms: "#696969",
	suite: "#483D8B",
	masterSuite: "#556B2F",
	familyRooms: "#A52A2A",
	individualBed: "#064E3B",
};

const compactRoomText = (value = "", limit = 500) =>
	String(value || "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, limit);

const normalizeRoomIdentity = (value = "") =>
	compactRoomText(value, 500).toLowerCase();

const toWholeNumber = (value, fallback = 0) => {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : fallback;
};

const toMoneyNumber = (value, fallback = 0) => {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const toBooleanDefault = (value, fallback = true) =>
	value === undefined || value === null ? fallback : value === true || value === "true";

const normalizeRoomArray = (items = []) =>
	Array.isArray(items)
		? items
				.map((item) => compactRoomText(item, 90))
				.filter((item, index, list) => item && list.indexOf(item) === index)
		: [];

const randomDarkRoomColor = () => {
	const part = () =>
		Math.floor(Math.random() * 130)
			.toString(16)
			.padStart(2, "0");
	return `#${part()}${part()}${part()}`;
};

const pickRoomColor = (roomType = "", existingRooms = []) => {
	const existingColors = new Set(
		(existingRooms || []).map((room) => room?.roomColor).filter(Boolean)
	);
	const preferred = ROOM_TYPE_COLORS[roomType];
	if (preferred && !existingColors.has(preferred)) return preferred;
	let candidate = randomDarkRoomColor();
	let attempts = 0;
	while (existingColors.has(candidate) && attempts < 20) {
		candidate = randomDarkRoomColor();
		attempts += 1;
	}
	return candidate;
};

const roomToPlain = (room = {}) =>
	room && typeof room.toObject === "function" ? room.toObject() : { ...room };

const serializeOverallRoom = (room = {}) => {
	const plain = roomToPlain(room);
	return {
		_id: normalizeId(plain._id),
		roomType: plain.roomType || "",
		displayName: plain.displayName || "",
		displayName_OtherLanguage: plain.displayName_OtherLanguage || "",
		description: plain.description || "",
		description_OtherLanguage: plain.description_OtherLanguage || "",
		count: Number(plain.count || 0),
		price: {
			basePrice: Number(plain?.price?.basePrice || plain.basePrice || 0),
		},
		defaultCost: Number(plain.defaultCost || plain.rootPrice || 0),
		amenities: Array.isArray(plain.amenities) ? plain.amenities : [],
		views: Array.isArray(plain.views) ? plain.views : [],
		extraAmenities: Array.isArray(plain.extraAmenities)
			? plain.extraAmenities
			: [],
		activeRoom: plain.activeRoom !== false,
		bedsCount: Number(plain.bedsCount || 1),
		roomForGender: plain.roomForGender || "Unisex",
		roomColor: plain.roomColor || "",
		roomCommission: Number(plain.roomCommission || 0),
		commisionIncluded: plain.commisionIncluded === true,
	};
};

const serializeOverallRoomHotel = (hotel = {}) => {
	const rooms = Array.isArray(hotel.roomCountDetails)
		? hotel.roomCountDetails
		: [];
	return {
		_id: normalizeId(hotel._id),
		hotelName: hotel.hotelName || "Hotel",
		ownerId: normalizeId(hotel.belongsTo),
		ownerName: hotel.belongsTo?.name || "",
		overallRoomsCount: Number(hotel.overallRoomsCount || 0),
		roomTypes: rooms.length,
		rooms: rooms.map(serializeOverallRoom),
		setup: setupSnapshot(hotel),
		updatedAt: hotel.updatedAt,
	};
};

const sumRoomCounts = (rooms = []) =>
	(rooms || []).reduce((total, room) => total + toWholeNumber(room?.count, 0), 0);

const requestedRoomHotelIds = (body = {}, action = "add") => {
	const rawIds =
		action === "add" && Array.isArray(body.hotelIds)
			? body.hotelIds
			: [body.hotelId];
	return rawIds.map(normalizeId).filter(Boolean);
};

const roomCountForHotel = (body = {}, hotelId = "", fallback = 1) => {
	const roomInput = body.room || {};
	const countMap =
		body.countsByHotelId ||
		body.hotelCounts ||
		roomInput.countsByHotelId ||
		roomInput.hotelCounts ||
		{};
	return toWholeNumber(
		countMap[hotelId] ??
			countMap[String(hotelId)] ??
			roomInput.count ??
			body.count,
		fallback
	);
};

const pricingEntryForHotel = (body = {}, hotelId = "") => {
	const roomInput = body.room || {};
	const priceMap =
		body.basePricesByHotelId ||
		body.hotelBasePrices ||
		body.pricesByHotelId ||
		body.basePriceByHotelId ||
		roomInput.basePricesByHotelId ||
		roomInput.hotelBasePrices ||
		roomInput.pricesByHotelId ||
		roomInput.basePriceByHotelId ||
		{};
	return priceMap[hotelId] ?? priceMap[String(hotelId)];
};

const roomPricingForHotel = (
	body = {},
	hotelId = "",
	fallbackBasePrice = 0,
	fallbackDefaultCost = fallbackBasePrice
) => {
	const roomInput = body.room || {};
	const rawEntry = pricingEntryForHotel(body, hotelId);
	const entry =
		rawEntry && typeof rawEntry === "object" && !Array.isArray(rawEntry)
			? rawEntry
			: {};
	const rawBasePrice =
		entry?.price?.basePrice ??
		entry.price ??
		entry.basePrice ??
		rawEntry ??
		roomInput.basePrice ??
		roomInput?.price?.basePrice ??
		body.basePrice;
	const basePrice = toMoneyNumber(rawBasePrice, fallbackBasePrice);
	const defaultCost = toMoneyNumber(
		entry.defaultCost ??
			entry.rootPrice ??
			entry.cost ??
			roomInput.defaultCost ??
			roomInput.rootPrice ??
			body.defaultCost ??
			body.rootPrice,
		basePrice || fallbackDefaultCost || fallbackBasePrice
	);
	return {
		basePrice,
		defaultCost: defaultCost || basePrice,
	};
};

const findRoomDuplicate = (rooms = [], candidate = {}, ignoreRoomId = "") => {
	const roomType = normalizeRoomIdentity(candidate.roomType);
	const englishName = normalizeRoomIdentity(candidate.displayName);
	const arabicName = normalizeRoomIdentity(candidate.displayName_OtherLanguage);
	return (rooms || []).find((room) => {
		if (ignoreRoomId && normalizeId(room?._id) === normalizeId(ignoreRoomId)) {
			return false;
		}
		if (normalizeRoomIdentity(room?.roomType) !== roomType) return false;
		const existingEnglish = normalizeRoomIdentity(room?.displayName);
		const existingArabic = normalizeRoomIdentity(room?.displayName_OtherLanguage);
		return (
			(englishName && existingEnglish && englishName === existingEnglish) ||
			(arabicName && existingArabic && arabicName === existingArabic)
		);
	});
};

const buildRoomFieldsFromBody = async (body = {}, existingRoom = {}) => {
	const roomInput = body.room || body;
	const existing = roomToPlain(existingRoom);
	const roomType =
		compactRoomText(roomInput.roomType || existing.roomType, 80) ||
		compactRoomText(roomInput.customRoomType || "", 80);
	const rawName = compactRoomText(
		roomInput.name ||
			roomInput.displayName ||
			roomInput.displayName_OtherLanguage ||
			existing.displayName ||
			existing.displayName_OtherLanguage,
		180
	);
	const shouldRegenerateDescription =
		roomInput.regenerateDescription === true ||
		roomInput.regenerateDescription === "true" ||
		body.regenerateDescription === true ||
		body.regenerateDescription === "true";
	const rawDescription = shouldRegenerateDescription
		? ""
		: compactRoomText(
				roomInput.descriptionInput ||
					roomInput.description ||
					roomInput.description_OtherLanguage ||
					existing.description ||
					existing.description_OtherLanguage,
				1200
		  );
	const orchestrated = await orchestrateRoomText({
		name: rawName,
		description: rawDescription,
		roomType,
		language: body.language || roomInput.language || "English",
		amenities: normalizeRoomArray(roomInput.amenities ?? existing.amenities),
		views: normalizeRoomArray(roomInput.views ?? existing.views),
		extraAmenities: normalizeRoomArray(
			roomInput.extraAmenities ?? existing.extraAmenities
		),
	});
	const basePrice = toMoneyNumber(
		roomInput.basePrice ?? roomInput?.price?.basePrice,
		toMoneyNumber(existing?.price?.basePrice ?? existing.basePrice, 0)
	);
	const defaultCost = toMoneyNumber(
		roomInput.defaultCost ?? roomInput.rootPrice,
		toMoneyNumber(existing.defaultCost ?? existing.rootPrice, basePrice)
	);
	const bedsCountSource =
		roomInput.bedsCount ?? existing.bedsCount ?? orchestrated.bedsCount ?? 1;

	return {
		roomType,
		displayName: orchestrated.displayName,
		displayName_OtherLanguage: orchestrated.displayName_OtherLanguage,
		description: orchestrated.description,
		description_OtherLanguage: orchestrated.description_OtherLanguage,
		count: toWholeNumber(roomInput.count ?? roomInput.roomCount, existing.count || 0),
		price: {
			...(existing.price && typeof existing.price === "object"
				? existing.price
				: {}),
			basePrice,
		},
		defaultCost,
		amenities: normalizeRoomArray(roomInput.amenities ?? existing.amenities),
		views: normalizeRoomArray(roomInput.views ?? existing.views),
		extraAmenities: normalizeRoomArray(
			roomInput.extraAmenities ?? existing.extraAmenities
		),
		activeRoom: toBooleanDefault(roomInput.activeRoom, existing.activeRoom !== false),
		bedsCount: Math.max(1, toWholeNumber(bedsCountSource, 1)),
		roomForGender: compactRoomText(
			roomInput.roomForGender || existing.roomForGender || "Unisex",
			40
		),
		commisionIncluded: toBooleanDefault(
			roomInput.commisionIncluded,
			existing.commisionIncluded === true
		),
		roomCommission: toMoneyNumber(
			roomInput.roomCommission,
			toMoneyNumber(existing.roomCommission, 10)
		),
		ai: {
			applied: orchestrated.aiApplied === true,
			model: orchestrated.aiModel || "",
			skippedReason: orchestrated.aiSkippedReason || "",
			error: orchestrated.aiError || "",
		},
	};
};

exports.overallRoomManagerOptions = async (req, res) => {
	try {
		const context = await requireOverallSection(req, res, "settings");
		if (!context) return;
		return res.json({
			hotels: context.hotels.map(serializeOverallRoomHotel),
		});
	} catch (error) {
		console.error("overallRoomManagerOptions error:", error);
		return res
			.status(500)
			.json({ error: "Could not load room manager options" });
	}
};

exports.saveOverallRoomManagerRoom = async (req, res) => {
	try {
		const context = await requireOverallSection(req, res, "settings");
		if (!context) return;
		const action = String(req.body?.action || "add").toLowerCase();
		const hotelIds = requestedRoomHotelIds(req.body, action);
		if (!hotelIds.length || hotelIds.some((hotelId) => !ObjectId.isValid(hotelId))) {
			return res.status(400).json({ error: "Valid hotel selection is required" });
		}
		const allowedHotelIds = new Set(context.hotels.map((hotel) => normalizeId(hotel._id)));
		const forbiddenHotelIds = hotelIds.filter((hotelId) => !allowedHotelIds.has(hotelId));
		if (forbiddenHotelIds.length) {
			return res
				.status(403)
				.json({ error: "You cannot update rooms for this hotel" });
		}

		if (action === "update") {
			const hotelId = hotelIds[0];
			const hotel = await HotelDetails.findById(hotelId).exec();
			if (!hotel) return res.status(404).json({ error: "Hotel not found" });
			const rooms = Array.isArray(hotel.roomCountDetails)
				? hotel.roomCountDetails
				: [];
			const roomId = normalizeId(req.body?.roomId || req.body?.room?._id);
			if (!roomId) {
				return res.status(400).json({ error: "roomId is required" });
			}
			const roomIndex = rooms.findIndex(
				(room) => normalizeId(room?._id) === roomId
			);
			if (roomIndex < 0) {
				return res.status(404).json({ error: "Room type was not found" });
			}
			const existingRoom = roomToPlain(rooms[roomIndex]);
			const fields = await buildRoomFieldsFromBody(req.body, existingRoom);
			if (!fields.roomType || !fields.displayName) {
				return res
					.status(400)
					.json({ error: "Room type and room name are required" });
			}
			const duplicate = findRoomDuplicate(rooms, fields, roomId);
			if (duplicate) {
				return res.status(409).json({
					error: "Another room with the same type and name already exists",
				});
			}
			const { ai, ...roomFields } = fields;
			const updatedRoomPayload = {
				...existingRoom,
				...roomFields,
				roomColor:
					existingRoom.roomColor ||
					pickRoomColor(fields.roomType, rooms.map(roomToPlain)),
			};
			if (typeof rooms.set === "function") {
				rooms.set(roomIndex, updatedRoomPayload);
			} else {
				rooms[roomIndex] = updatedRoomPayload;
			}
			hotel.roomCountDetails = rooms;
			hotel.overallRoomsCount = sumRoomCounts(rooms);
			hotel.markModified("roomCountDetails");
			await hotel.save();
			const updatedRoom = hotel.roomCountDetails.id(roomId) || hotel.roomCountDetails[roomIndex];
			return res.json({
				ok: true,
				action,
				hotel: serializeOverallRoomHotel(hotel),
				room: serializeOverallRoom(updatedRoom),
				ai,
			});
		}

		const hotels = await HotelDetails.find({ _id: { $in: hotelIds } }).exec();
		if (hotels.length !== hotelIds.length) {
			return res.status(404).json({ error: "One or more hotels were not found" });
		}
		const hotelsById = new Map(hotels.map((hotel) => [normalizeId(hotel._id), hotel]));
		const orderedHotels = hotelIds.map((hotelId) => hotelsById.get(hotelId)).filter(Boolean);
		const fields = await buildRoomFieldsFromBody(req.body, {});
		if (!fields.roomType || !fields.displayName) {
			return res
				.status(400)
				.json({ error: "Room type and room name are required" });
		}
		const duplicateHotels = orderedHotels.filter((hotel) =>
			findRoomDuplicate(
				Array.isArray(hotel.roomCountDetails) ? hotel.roomCountDetails : [],
				fields
			)
		);
		if (duplicateHotels.length) {
			return res.status(409).json({
				error: "A room with the same type and name already exists in one or more selected hotels",
				hotels: duplicateHotels.map((hotel) => ({
					_id: normalizeId(hotel._id),
					hotelName: hotel.hotelName || "Hotel",
				})),
			});
		}
		const hotelPricingRows = orderedHotels.map((hotel) => {
			const hotelId = normalizeId(hotel._id);
			return {
				hotel,
				hotelId,
				pricing: roomPricingForHotel(
					req.body,
					hotelId,
					fields.price?.basePrice || 0,
					fields.defaultCost || fields.price?.basePrice || 0
				),
			};
		});
		const missingBasePriceHotels = hotelPricingRows.filter(
			(row) => !(Number(row.pricing?.basePrice) > 0)
		);
		if (missingBasePriceHotels.length) {
			return res.status(400).json({
				error: "Base price is required for every selected hotel",
				hotels: missingBasePriceHotels.map(({ hotel }) => ({
					_id: normalizeId(hotel._id),
					hotelName: hotel.hotelName || "Hotel",
				})),
			});
		}
		const { ai, ...roomFields } = fields;
		const savedHotels = [];
		const savedRooms = [];
		for (const { hotel, hotelId, pricing } of hotelPricingRows) {
			const existingRooms = Array.isArray(hotel.roomCountDetails)
				? hotel.roomCountDetails
				: [];
			const nextRoom = {
				...roomFields,
				count: roomCountForHotel(req.body, hotelId, fields.count || 1),
				price: {
					...(roomFields.price && typeof roomFields.price === "object"
						? roomFields.price
						: {}),
					basePrice: pricing.basePrice,
				},
				defaultCost: pricing.defaultCost || pricing.basePrice,
				pricedExtras: [],
				pricingRate: [],
				agentInventory: [],
				agentPricingRate: [],
				photos: [],
				offers: [],
				monthly: [],
				roomColor: pickRoomColor(fields.roomType, existingRooms.map(roomToPlain)),
			};
			hotel.roomCountDetails.push(nextRoom);
			hotel.overallRoomsCount = sumRoomCounts(hotel.roomCountDetails);
			hotel.markModified("roomCountDetails");
			await hotel.save();
			const savedRoom =
				hotel.roomCountDetails[hotel.roomCountDetails.length - 1] || nextRoom;
			savedHotels.push(serializeOverallRoomHotel(hotel));
			savedRooms.push(serializeOverallRoom(savedRoom));
		}
		return res.status(201).json({
			ok: true,
			action: "add",
			hotel: savedHotels[0],
			hotels: savedHotels,
			room: savedRooms[0],
			rooms: savedRooms,
			createdCount: savedHotels.length,
			ai,
		});
	} catch (error) {
		console.error("saveOverallRoomManagerRoom error:", error);
		return res.status(500).json({ error: "Could not save room settings" });
	}
};

const serializeCalendarRoom = (room = {}) => {
	const plain = roomToPlain(room);
	return {
		_id: normalizeId(plain._id),
		roomType: plain.roomType || "",
		displayName: plain.displayName || plain.displayName_OtherLanguage || plain.roomType || "",
		displayName_OtherLanguage: plain.displayName_OtherLanguage || "",
		roomForGender: plain.roomForGender || "",
		count: Number(plain.count || 0),
		activeRoom: plain.activeRoom !== false,
		roomColor: plain.roomColor || "",
		basePrice: Number(plain?.price?.basePrice || plain.basePrice || 0),
		defaultCost: Number(plain.defaultCost || plain.rootPrice || 0),
		pricingRate: (Array.isArray(plain.pricingRate) ? plain.pricingRate : []).map(
			(row) => ({
				calendarDate: toCalendarDateKey(row?.calendarDate),
				status: row?.status === "blocked" || row?.blocked === true ? "blocked" : "open",
				blocked: row?.blocked === true || row?.status === "blocked",
				sellingPrice: Number(row?.sellingPrice ?? row?.price ?? 0),
				price: Number(row?.price ?? row?.sellingPrice ?? 0),
				rootPrice: Number(row?.rootPrice || 0),
				commissionPercent: Number(row?.commissionPercent || 0),
				color: row?.color || "",
			})
		),
		pricingDays: Array.isArray(plain.pricingRate) ? plain.pricingRate.length : 0,
		agentPricingDays: Array.isArray(plain.agentPricingRate)
			? plain.agentPricingRate.length
			: 0,
	};
};

const serializeCalendarHotel = (hotel = {}) => {
	const rooms = Array.isArray(hotel.roomCountDetails)
		? hotel.roomCountDetails
		: [];
	return {
		_id: normalizeId(hotel._id),
		hotelName: hotel.hotelName || "Hotel",
		ownerId: normalizeId(hotel.belongsTo),
		ownerName: hotel.belongsTo?.name || "",
		rooms: rooms.map(serializeCalendarRoom),
		roomTypes: rooms.length,
		overallRoomsCount: Number(hotel.overallRoomsCount || 0),
		updatedAt: hotel.updatedAt,
	};
};

const buildCalendarAgentQuery = (hotelIds = [], agentIds = []) => {
	const ids = uniqueValidIds(hotelIds);
	const objectIds = ids.map((id) => ObjectId(id));
	return {
		...(agentIds.length
			? { _id: { $in: agentIds.filter(ObjectId.isValid).map((id) => ObjectId(id)) } }
			: {}),
		$and: [
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
			{
				$or: [
					{ hotelIdWork: { $in: ids } },
					{ hotelIdsWork: { $in: objectIds } },
					{ hotelsToSupport: { $in: objectIds } },
					{ hotelIdsOwner: { $in: objectIds } },
				],
			},
		],
	};
};

const serializeCalendarAgent = (agent = {}) => ({
	_id: normalizeId(agent._id),
	name: agent.name || agent.email || "Agent",
	email: agent.email || "",
	companyName: agent.companyName || agent.companyOfficialName || "",
	agentCommercialModel: agent.agentCommercialModel || "",
	hotelIds: uniqueValidIds([
		agent.hotelIdWork,
		...(Array.isArray(agent.hotelIdsWork) ? agent.hotelIdsWork : []),
		...(Array.isArray(agent.hotelsToSupport) ? agent.hotelsToSupport : []),
		...(Array.isArray(agent.hotelIdsOwner) ? agent.hotelIdsOwner : []),
	]),
});

const requestedCalendarHotelIds = (body = {}) =>
	uniqueValidIds(
		Array.isArray(body.hotelIds) ? body.hotelIds : [body.hotelId]
	);

const requestedCalendarRoomSelections = (body = {}) =>
	(Array.isArray(body.roomSelections) ? body.roomSelections : [])
		.map((selection) => ({
			hotelId: normalizeId(selection?.hotelId),
			roomId: normalizeId(selection?.roomId),
		}))
		.filter((selection) => selection.hotelId && selection.roomId);

const requestedCalendarRows = (body = {}) =>
	(Array.isArray(body.rows) ? body.rows : [])
		.map((row) => ({
			hotelId: normalizeId(row?.hotelId),
			roomId: normalizeId(row?.roomId),
			calendarDate: toCalendarDateKey(
				row?.calendarDate || row?.date || row?.pricingDate
			),
			status: String(row?.status || "open").toLowerCase() === "blocked"
				? "blocked"
				: "open",
			sellingPrice: row?.sellingPrice ?? row?.price,
			commissionPercent: row?.commissionPercent ?? row?.commission,
		}))
		.filter((row) => row.hotelId && row.roomId && row.calendarDate);

const requestedCalendarPriceVariantSelections = (body = {}) => {
	const rawSelections = Array.isArray(body.priceVariantSelections)
		? body.priceVariantSelections
		: Array.isArray(body.priceVariantAssignments)
		  ? body.priceVariantAssignments
		  : [];
	const selections = rawSelections.length
		? rawSelections
		: body.priceVariantDataId || body.priceVariantItemId
		  ? [
					{
						priceVariantDataId: body.priceVariantDataId,
						priceVariantItemId: body.priceVariantItemId,
					},
			  ]
		  : [];
	const byKey = new Map();
	selections.forEach((selection) => {
		const priceVariantDataId = normalizeId(
			selection?.priceVariantDataId || selection?.dataId
		);
		const priceVariantItemId = normalizeId(
			selection?.priceVariantItemId || selection?.itemId
		);
		if (!priceVariantDataId || !priceVariantItemId) return;
		const key = `${priceVariantDataId}:${priceVariantItemId}`;
		byKey.set(key, { priceVariantDataId, priceVariantItemId });
	});
	return [...byKey.values()];
};

const isAgentPriceVariantAssignmentRequest = (body = {}) => {
	const mode = String(
		body.assignmentMode || body.agentPricingMode || body.pricingMode || ""
	).toLowerCase();
	return ["price_variants", "price-variants", "variants", "variant"].includes(
		mode
	);
};

const sortCalendarRows = (rows = []) =>
	[...(Array.isArray(rows) ? rows : [])].sort((left, right) =>
		toCalendarDateKey(left?.calendarDate).localeCompare(
			toCalendarDateKey(right?.calendarDate)
		)
	);

const mergeGeneralCalendarRows = (existing = [], nextRows = [], dateSet = new Set()) =>
	sortCalendarRows([
		...(Array.isArray(existing) ? existing : []).filter(
			(row) => !dateSet.has(toCalendarDateKey(row?.calendarDate))
		),
		...nextRows,
	]);

const normalizeCalendarPricingOperation = (body = {}) => {
	const operation = String(
		body.operation || body.pricingOperation || body.action || ""
	).toLowerCase();
	return ["add", "create", "new"].includes(operation) ? "add" : "update";
};

const findGeneralCalendarPricingDuplicates = ({
	hotelDocs = [],
	roomSelections = [],
	explicitRows = [],
	defaultDates = [],
} = {}) => {
	const hotelMap = new Map(
		(Array.isArray(hotelDocs) ? hotelDocs : []).map((hotel) => [
			normalizeId(hotel._id),
			hotel,
		])
	);
	const explicitMode = Array.isArray(explicitRows) && explicitRows.length > 0;
	const duplicates = [];
	(Array.isArray(roomSelections) ? roomSelections : []).forEach((selection) => {
		const hotel = hotelMap.get(normalizeId(selection.hotelId));
		const rooms = Array.isArray(hotel?.roomCountDetails)
			? hotel.roomCountDetails
			: [];
		const room = rooms.find(
			(item) => normalizeId(item?._id) === normalizeId(selection.roomId)
		);
		if (!room) return;
		const roomPlain = roomToPlain(room);
		const candidateDates = explicitMode
			? explicitRows
					.filter(
						(row) =>
							normalizeId(row.hotelId) === normalizeId(selection.hotelId) &&
							normalizeId(row.roomId) === normalizeId(selection.roomId)
					)
					.map((row) => row.calendarDate)
			: defaultDates;
		if (!candidateDates.length) return;
		const existingDateSet = new Set(
			(Array.isArray(roomPlain.pricingRate) ? roomPlain.pricingRate : [])
				.map((row) => toCalendarDateKey(row?.calendarDate))
				.filter(Boolean)
		);
		[...new Set(candidateDates)].forEach((calendarDate) => {
			if (!existingDateSet.has(calendarDate)) return;
			duplicates.push({
				hotelId: normalizeId(hotel?._id),
				hotelName: hotel?.hotelName || "Hotel",
				roomId: normalizeId(roomPlain._id),
				roomType: roomPlain.roomType || "",
				displayName:
					roomPlain.displayName ||
					roomPlain.displayName_OtherLanguage ||
					roomPlain.roomType ||
					"",
				calendarDate,
			});
		});
	});
	return duplicates;
};

const mergeAgentCalendarRows = (
	existing = [],
	nextRows = [],
	dateSet = new Set(),
	agentSet = new Set()
) =>
	sortCalendarRows([
		...(Array.isArray(existing) ? existing : []).filter((row) => {
			const rowAgentId = normalizeCalendarId(row?.agentId);
			const rowDate = toCalendarDateKey(row?.calendarDate);
			return !(agentSet.has(rowAgentId) && dateSet.has(rowDate));
		}),
		...nextRows,
	]);

const replaceAgentCalendarRowsForAgents = (
	existing = [],
	nextRows = [],
	agentSet = new Set()
) =>
	sortCalendarRows([
		...(Array.isArray(existing) ? existing : []).filter(
			(row) => !agentSet.has(normalizeCalendarId(row?.agentId))
		),
		...nextRows,
	]);

const MAX_PRICE_VARIANT_ITEMS = 100;

const normalizePriceVariantMonths = (values = []) =>
	[
		...new Set(
			(Array.isArray(values) ? values : [values])
				.map((value) => Number(value))
				.filter((value) => Number.isInteger(value) && value >= 0 && value <= 11)
		),
	].sort((left, right) => left - right);

const normalizePriceVariantItemName = (value = "") =>
	String(value || "").trim().slice(0, 140);

const requestedPriceVariantItems = (body = {}) => {
	const rawItems = Array.isArray(body.pricingItems) ? body.pricingItems : [];
	if (rawItems.length) return rawItems;
	if (body.name || body.pricingName || body.sellingPrice || body.price) {
		return [body];
	}
	return [];
};

const buildPriceVariantItems = ({ body = {}, dates = [], calendarType = "hijri" }) => {
	const rawItems = requestedPriceVariantItems(body);
	if (!rawItems.length) {
		return { ok: false, error: "Please add at least one pricing item" };
	}
	if (rawItems.length > MAX_PRICE_VARIANT_ITEMS) {
		return {
			ok: false,
			error: `Please save ${MAX_PRICE_VARIANT_ITEMS} pricing items or fewer at once`,
		};
	}

	const items = [];
	for (let index = 0; index < rawItems.length; index += 1) {
		const item = rawItems[index] || {};
		const name = normalizePriceVariantItemName(
			item.name || item.pricingName || item.label
		);
		if (!name) {
			return {
				ok: false,
				error: `Pricing name is required for price ${index + 1}`,
			};
		}
		const status = ["blocked", "closed", "restricted"].includes(
			String(item.status || body.status || "open").toLowerCase()
		)
			? "blocked"
			: "open";
		const plan = buildPricingPlan({
			scope: "price-variants",
			dates,
			sellingPrice: item.sellingPrice ?? item.price,
			commissionPercent: item.commissionPercent ?? item.commission,
			status,
			calendarType,
			source: "price-variants",
		});
		if (!plan.ok) {
			return {
				ok: false,
				error: `${name}: ${plan.error}`,
			};
		}
		items.push({
			...(ObjectId.isValid(normalizeId(item._id || item.id))
				? { _id: ObjectId(normalizeId(item._id || item.id)) }
				: {}),
			name,
			nameOtherLanguage: normalizePriceVariantItemName(
				item.nameOtherLanguage || item.nameAr || item.arabicName
			),
			status,
			sellingPrice: plan.sellingPrice,
			commissionPercent: plan.commissionPercent,
			rootPrice: plan.rootPrice,
			color: plan.color,
			sortOrder: Number.isFinite(Number(item.sortOrder))
				? Number(item.sortOrder)
				: index,
		});
	}
	return { ok: true, items };
};

const roomPricingInputForRoom = (item = {}, room = {}) => {
	const roomPrices = Array.isArray(item.roomPrices) ? item.roomPrices : [];
	const roomId = normalizeId(room.roomId);
	const hotelId = normalizeId(room.hotelId);
	return (
		roomPrices.find((entry) => normalizeId(entry?.roomId) === roomId) ||
		roomPrices.find((entry) => normalizeId(entry?.roomKey) === `${hotelId}::${roomId}`) ||
		roomPrices.find((entry) => normalizeId(entry?.key) === `${hotelId}::${roomId}`) ||
		null
	);
};

const normalizePriceVariantPeriods = (body = {}, dates = []) => {
	const rawPeriods = Array.isArray(body.periods) ? body.periods : [];
	const periods = rawPeriods
		.map((period, index) => {
			const periodKey = String(
				period?.periodKey || period?.key || `period-${index + 1}`
			).trim();
			const startDate = toCalendarDateKey(period?.startDate);
			const endDate = toCalendarDateKey(period?.endDate);
			if (!periodKey || !startDate || !endDate || endDate < startDate) {
				return null;
			}
			return {
				periodKey,
				label: String(period?.label || periodKey).trim(),
				calendarType:
					period?.calendarType === "gregorian" ? "gregorian" : "hijri",
				periodMode: period?.periodMode === "custom" ? "custom" : "months",
				year: Number.isFinite(Number(period?.year)) ? Number(period.year) : null,
				month: Number.isInteger(Number(period?.month))
					? Number(period.month)
					: null,
				startDate,
				endDate,
			};
		})
		.filter(Boolean);
	if (periods.length) return periods;
	const sortedDates = [...new Set((Array.isArray(dates) ? dates : []).filter(Boolean))].sort();
	if (!sortedDates.length) return [];
	return [
		{
			periodKey: "default",
			label: "Default",
			calendarType: body.calendarType === "gregorian" ? "gregorian" : "hijri",
			periodMode: body.periodMode === "custom" ? "custom" : "months",
			year: null,
			month: null,
			startDate: sortedDates[0],
			endDate: sortedDates[sortedDates.length - 1],
		},
	];
};

const periodPricingInputForPeriod = (roomInput = {}, period = {}) => {
	const periodPrices = Array.isArray(roomInput.periodPrices)
		? roomInput.periodPrices
		: [];
	return (
		periodPrices.find(
			(entry) => String(entry?.periodKey || "").trim() === period.periodKey
		) || null
	);
};

const normalizePricingBasis = (item = {}, index = 0, baseItemId = null) => {
	const source = item.pricingBasis && typeof item.pricingBasis === "object"
		? item.pricingBasis
		: {};
	const mode = index === 0 ? "manual" : source.mode === "manual" ? "manual" : "derived";
	const direction =
		source.direction === "increase" ? "increase" : "decrease";
	const adjustmentType =
		source.adjustmentType === "percentage" ? "percentage" : "money";
	const amount = Number(source.amount || 0);
	return {
		mode,
		basePriceVariantItemId: mode === "derived" ? baseItemId : null,
		direction,
		adjustmentType,
		amount: Number.isFinite(amount) && amount > 0 ? Number(amount.toFixed(2)) : 0,
	};
};

const isPricingVariantRequest = (body = {}) =>
	body.variantMode === true ||
	body.dataType === "price_variant" ||
	body.mode === "price_variants" ||
	body.basePriceSource === "calendar_main_price";

const roundPricingNumber = (value = 0, fallback = 0) => {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	return Number(parsed.toFixed(2));
};

const normalizeVariantPricingBasis = (item = {}) => {
	const source = item.pricingBasis && typeof item.pricingBasis === "object"
		? item.pricingBasis
		: item;
	const direction =
		source.direction === "decrease" ? "decrease" : "increase";
	const adjustmentType =
		source.adjustmentType === "money" ? "money" : "percentage";
	const amount = Number(source.amount ?? source.adjustmentValue ?? 0);
	return {
		mode: "calendar_base",
		basePriceVariantItemId: null,
		direction,
		adjustmentType,
		amount: Number.isFinite(amount) && amount > 0 ? Number(amount.toFixed(2)) : 0,
	};
};

const applyDerivedPricingAdjustment = (basePrice = 0, basis = {}) => {
	const amount = Number(basis.amount || 0);
	const sign = basis.direction === "decrease" ? -1 : 1;
	const nextPrice =
		basis.adjustmentType === "percentage"
			? Number(basePrice || 0) * (1 + sign * (amount / 100))
			: Number(basePrice || 0) + sign * amount;
	return Number(Math.max(nextPrice, 0).toFixed(2));
};

const PRICING_VARIANT_DAY_MONTHS = 18;

const addUtcMonths = (date = new Date(), monthCount = 0) => {
	const next = new Date(date.getTime());
	next.setUTCMonth(next.getUTCMonth() + monthCount);
	return next;
};

const nextPricingVariantDateKeys = (
	monthCount = PRICING_VARIANT_DAY_MONTHS
) => {
	const start = new Date();
	start.setUTCHours(0, 0, 0, 0);
	const end = addUtcMonths(start, monthCount);
	end.setUTCDate(end.getUTCDate() - 1);
	const dates = [];
	const cursor = new Date(start.getTime());
	while (cursor <= end) {
		dates.push(cursor.toISOString().slice(0, 10));
		cursor.setUTCDate(cursor.getUTCDate() + 1);
	}
	return dates;
};

const variantOverrideRowsFromBody = (body = {}) =>
	(Array.isArray(body.variantPreviewRows)
		? body.variantPreviewRows
		: Array.isArray(body.previewRows)
		  ? body.previewRows
		  : []
	)
		.map((row = {}) => {
			const calendarDate = toCalendarDateKey(
				row.calendarDate || row.date || row.pricingDate
			);
			const hotelId = normalizeId(row.hotelId);
			const roomId = normalizeId(row.roomId);
			if (!calendarDate || !hotelId || !roomId) return null;
			const status = ["blocked", "closed", "restricted"].includes(
				String(row.status || (row.blocked ? "blocked" : "open")).toLowerCase()
			)
				? "blocked"
				: "open";
			return {
				priceVariantItemId: normalizeId(row.priceVariantItemId),
				pricingIndex: Number.isInteger(Number(row.pricingIndex))
					? Number(row.pricingIndex)
					: 0,
				hotelId,
				roomId,
				roomKey: normalizeId(row.roomKey),
				calendarDate,
				status,
				sellingPrice: roundPricingNumber(row.sellingPrice ?? row.price, 0),
				commissionPercent: Math.min(
					100,
					Math.max(0, roundPricingNumber(row.commissionPercent ?? row.commission, 0))
				),
				mainCalendarPrice: roundPricingNumber(row.mainCalendarPrice, 0),
				baseSource: String(row.baseSource || "").trim(),
				manualOverride: row.manualOverride !== false,
			};
		})
		.filter(Boolean);

const variantOverrideMapFromBody = (body = {}) => {
	const map = new Map();
	variantOverrideRowsFromBody(body).forEach((row) => {
		const keys = [
			`${row.priceVariantItemId}::${row.hotelId}::${row.roomId}::${row.calendarDate}`,
			`${row.pricingIndex}::${row.hotelId}::${row.roomId}::${row.calendarDate}`,
			`${row.roomKey}::${row.calendarDate}`,
		].filter((key) => key && !key.startsWith("::"));
		keys.forEach((key) => map.set(key, row));
	});
	return map;
};

const variantOverrideForRoomDate = ({
	overrideMap = new Map(),
	itemId = "",
	itemIndex = 0,
	room = {},
	date = "",
}) => {
	const keys = [
		`${normalizeId(itemId)}::${normalizeId(room.hotelId)}::${normalizeId(
			room.roomId
		)}::${date}`,
		`${itemIndex}::${normalizeId(room.hotelId)}::${normalizeId(
			room.roomId
		)}::${date}`,
		`${normalizeId(room.roomKey)}::${date}`,
	];
	return keys.map((key) => overrideMap.get(key)).find(Boolean) || null;
};

const roomBasePricingSnapshot = (room = {}) => {
	const plain = roomToPlain(room);
	const basePrice = roundPricingNumber(
		plain?.price?.basePrice ?? plain.basePrice,
		0
	);
	const defaultCost = roundPricingNumber(
		plain.defaultCost ?? plain.rootPrice,
		0
	);
	return {
		basePrice,
		defaultCost,
		hasBasePricing: basePrice > 0 && defaultCost > 0,
	};
};

const validateRoomsReadyForPricingVariants = (hotel = {}) => {
	const activeRooms = (Array.isArray(hotel?.roomCountDetails)
		? hotel.roomCountDetails
		: []
	).filter((room) => room?.activeRoom !== false);
	const missingRooms = activeRooms
		.map((room) => {
			const plain = roomToPlain(room);
			const snapshot = roomBasePricingSnapshot(room);
			return {
				roomId: normalizeId(plain._id),
				roomType: plain.roomType || "",
				displayName:
					plain.displayName || plain.displayName_OtherLanguage || plain.roomType || "",
				basePrice: snapshot.basePrice,
				defaultCost: snapshot.defaultCost,
				hasBasePricing: snapshot.hasBasePricing,
			};
		})
		.filter((room) => !room.hasBasePricing);
	return {
		ok: activeRooms.length > 0 && missingRooms.length === 0,
		activeRooms,
		missingRooms,
	};
};

const resolveCalendarBasePricingForRoom = (room = {}, calendarDate = "") => {
	const plain = roomToPlain(room);
	const snapshot = roomBasePricingSnapshot(room);
	const dateKey = toCalendarDateKey(calendarDate);
	const rows = Array.isArray(plain.pricingRate) ? plain.pricingRate : [];
	const calendarRow = dateKey
		? rows.find((row) => toCalendarDateKey(row?.calendarDate) === dateKey)
		: null;
	if (calendarRow) {
		const blocked =
			calendarRow.blocked === true ||
			String(calendarRow.status || "").toLowerCase() === "blocked" ||
			String(calendarRow.color || "").toLowerCase() === "black";
		if (blocked) {
			return {
				status: "blocked",
				sellingPrice: snapshot.basePrice,
				mainCalendarPrice: 0,
				commissionPercent: 0,
				source: "calendar",
				fallbackSource: "room-base",
			};
		}
		const rowPrice = roundPricingNumber(
			calendarRow.sellingPrice ?? calendarRow.price,
			0
		);
		if (rowPrice > 0) {
			return {
				status: "open",
				sellingPrice: rowPrice,
				mainCalendarPrice: rowPrice,
				commissionPercent: roundPricingNumber(calendarRow.commissionPercent, 0),
				source: "calendar",
			};
		}
	}
	return {
		status: snapshot.hasBasePricing ? "open" : "missing",
		sellingPrice: snapshot.basePrice,
		mainCalendarPrice: snapshot.basePrice,
		commissionPercent: 0,
		source: "room-base",
	};
};

const isCalendarBasePricingSelection = (selection = null) =>
	selection?.doc?.dataType === "price_variant" ||
	selection?.doc?.basePriceSource === "calendar_main_price" ||
	selection?.item?.pricingBasis?.mode === "calendar_base";

const buildPricingVariantItemsForRooms = async ({
	body = {},
	calendarType = "hijri",
	rooms = [],
	roomDocs = [],
}) => {
	const rawItems = requestedPriceVariantItems(body);
	if (!rawItems.length) {
		return { ok: false, error: "Please add at least one price variant" };
	}
	if (rawItems.length > MAX_PRICE_VARIANT_ITEMS) {
		return {
			ok: false,
			error: `Please save ${MAX_PRICE_VARIANT_ITEMS} price variants or fewer at once`,
		};
	}
	if (!rooms.length || !roomDocs.length) {
		return { ok: false, error: "No rooms are available for the selected hotels" };
	}

	const roomPricing = rooms.map((room) => ({
		hotelId: ObjectId(room.hotelId),
		roomId: ObjectId(room.roomId),
		roomType: room.roomType,
		displayName: room.displayName,
		displayNameOtherLanguage: room.displayNameOtherLanguage,
		roomForGender: room.roomForGender,
		pricingItems: [],
	}));
	const globalItems = [];
	const variantDates = nextPricingVariantDateKeys();
	const overrideMap = variantOverrideMapFromBody(body);

	for (let index = 0; index < rawItems.length; index += 1) {
		const item = rawItems[index] || {};
		const submittedName = normalizePriceVariantItemName(
			item.name ||
				item.pricingName ||
				item.label ||
				item.nameOtherLanguage ||
				item.nameAr ||
				item.arabicName
		);
		if (!submittedName) {
			return {
				ok: false,
				error: `Variant name is required for variant ${index + 1}`,
			};
		}
		const translatedName = body.skipNameTranslation
			? {
					name: item.name || submittedName,
					nameOtherLanguage: item.nameOtherLanguage || submittedName,
			  }
			: await translatePriceVariantName({
					name: submittedName,
					nameOtherLanguage: "",
			  });
		const name = normalizePriceVariantItemName(
			translatedName.name || submittedName
		);
		const nameOtherLanguage = normalizePriceVariantItemName(
			translatedName.nameOtherLanguage || submittedName
		);
		const itemId = ObjectId.isValid(normalizeId(item._id || item.id))
			? ObjectId(normalizeId(item._id || item.id))
			: new ObjectId();
		const status = ["blocked", "closed", "restricted"].includes(
			String(item.status || body.status || "open").toLowerCase()
		)
			? "blocked"
			: "open";
		const pricingBasis = normalizeVariantPricingBasis(item);
		const commissionPercent = Math.min(
			100,
			Math.max(
				0,
				roundPricingNumber(item.commissionPercent ?? item.commission, 0)
			)
		);
		let representativePeriod = null;

		for (let roomIndex = 0; roomIndex < roomDocs.length; roomIndex += 1) {
			const roomDoc = roomDocs[roomIndex];
			const roomMeta = {
				...(rooms[roomIndex] || {}),
				roomKey: `${normalizeId(rooms[roomIndex]?.hotelId)}::${normalizeId(
					rooms[roomIndex]?.roomId
				)}`,
			};
			const periodPrices = [];

			for (const calendarDate of variantDates) {
				const base = resolveCalendarBasePricingForRoom(roomDoc, calendarDate);
				const override = variantOverrideForRoomDate({
					overrideMap,
					itemId,
					itemIndex: index,
					room: roomMeta,
					date: calendarDate,
				});
				const baseUnavailable = base.status === "missing";
				const defaultBlocked =
					status === "blocked" || baseUnavailable || base.status === "blocked";
				const periodStatus = override?.manualOverride
					? override.status === "blocked" || status === "blocked" || baseUnavailable
						? "blocked"
						: "open"
					: defaultBlocked
					  ? "blocked"
					  : "open";
				const derivedSellingPrice = applyDerivedPricingAdjustment(
					base.sellingPrice,
					pricingBasis
				);
				const periodSellingPrice =
					periodStatus === "blocked"
						? 0
						: override?.manualOverride
						  ? override.sellingPrice || derivedSellingPrice
						  : derivedSellingPrice;
				const periodCommission =
					periodStatus === "blocked"
						? 0
						: override?.manualOverride
						  ? override.commissionPercent
						  : commissionPercent;
				const periodPlan = buildPricingPlan({
					scope: "price-variants",
					dates: [calendarDate],
					sellingPrice: periodSellingPrice,
					commissionPercent: periodCommission,
					status: periodStatus,
					calendarType,
					source: "price-variant",
				});
				if (!periodPlan.ok) {
					return {
						ok: false,
						error: `${name} / ${
							roomMeta.displayName || roomMeta.roomType || "Room"
						} / ${calendarDate}: ${periodPlan.error}`,
					};
				}
				const periodPayload = {
					periodKey: calendarDate,
					label: calendarDate,
					calendarType,
					periodMode: "custom",
					year: null,
					month: null,
					startDate: calendarDate,
					endDate: calendarDate,
					status: periodPlan.blocked ? "blocked" : "open",
					sellingPrice: periodPlan.sellingPrice,
					mainCalendarPrice: roundPricingNumber(
						base.mainCalendarPrice ?? base.sellingPrice,
						0
					),
					commissionPercent: periodPlan.commissionPercent,
					baseSource: base.source || "",
					manualOverride: Boolean(override?.manualOverride),
					rootPrice: periodPlan.rootPrice,
					color: periodPlan.color,
				};
				periodPrices.push(periodPayload);
				if (!representativePeriod && periodPayload.status === "open") {
					representativePeriod = periodPayload;
				}
			}

			const roomRepresentativePeriod =
				periodPrices.find((period) => period.status === "open") ||
				periodPrices[0] ||
				{};
			roomPricing[roomIndex].pricingItems.push({
				priceVariantItemId: itemId,
				name,
				nameOtherLanguage,
				status: roomRepresentativePeriod.status || status,
				sellingPrice: roomRepresentativePeriod.sellingPrice || 0,
				commissionPercent: roomRepresentativePeriod.commissionPercent || 0,
				rootPrice: roomRepresentativePeriod.rootPrice || 0,
				color: roomRepresentativePeriod.color || "black",
				sortOrder: Number.isFinite(Number(item.sortOrder))
					? Number(item.sortOrder)
					: index,
				periodPrices,
			});
		}

		const globalRepresentativePeriod = representativePeriod || {
			status: status === "blocked" ? "blocked" : "open",
			sellingPrice: 0,
			commissionPercent,
			rootPrice: 0,
			color: status === "blocked" ? "black" : "",
		};

		globalItems.push({
			_id: itemId,
			name,
			nameOtherLanguage,
			status,
			sellingPrice: globalRepresentativePeriod.sellingPrice || 0,
			commissionPercent: globalRepresentativePeriod.commissionPercent || 0,
			rootPrice: globalRepresentativePeriod.rootPrice || 0,
			color: globalRepresentativePeriod.color || "",
			sortOrder: Number.isFinite(Number(item.sortOrder))
				? Number(item.sortOrder)
				: index,
			pricingBasis,
		});
	}

	return { ok: true, items: globalItems, roomPricing };
};

const buildPriceVariantItemsForRooms = async ({
	body = {},
	dates = [],
	calendarType = "hijri",
	rooms = [],
	periods = [],
}) => {
	const rawItems = requestedPriceVariantItems(body);
	if (!rawItems.length) {
		return { ok: false, error: "Please add at least one pricing item" };
	}
	if (rawItems.length > MAX_PRICE_VARIANT_ITEMS) {
		return {
			ok: false,
			error: `Please save ${MAX_PRICE_VARIANT_ITEMS} pricing items or fewer at once`,
		};
	}
	if (!rooms.length) {
		return { ok: false, error: "No rooms are available for the selected hotels" };
	}
	if (!periods.length) {
		return { ok: false, error: "Please select at least one pricing period" };
	}

	const globalItems = [];
	const roomPricing = rooms.map((room) => ({
		hotelId: ObjectId(room.hotelId),
		roomId: ObjectId(room.roomId),
		roomType: room.roomType,
		displayName: room.displayName,
		displayNameOtherLanguage: room.displayNameOtherLanguage,
		roomForGender: room.roomForGender,
		pricingItems: [],
	}));
	const baseValues = new Map();
	let baseItemId = null;

	for (let index = 0; index < rawItems.length; index += 1) {
		const item = rawItems[index] || {};
		const submittedName = normalizePriceVariantItemName(
			item.name ||
				item.pricingName ||
				item.label ||
				item.nameOtherLanguage ||
				item.nameAr ||
				item.arabicName
		);
		if (!submittedName) {
			return {
				ok: false,
				error: `Pricing name is required for price ${index + 1}`,
			};
		}
		const translatedName = await translatePriceVariantName({
			name: submittedName,
			nameOtherLanguage: "",
		});
		const name = normalizePriceVariantItemName(
			translatedName.name || submittedName
		);
		const nameOtherLanguage = normalizePriceVariantItemName(
			translatedName.nameOtherLanguage || submittedName
		);
		const itemId = ObjectId.isValid(normalizeId(item._id || item.id))
			? ObjectId(normalizeId(item._id || item.id))
			: new ObjectId();
		if (index === 0) baseItemId = itemId;
		const pricingBasis = normalizePricingBasis(item, index, baseItemId);
		const status = ["blocked", "closed", "restricted"].includes(
			String(item.status || body.status || "open").toLowerCase()
		)
			? "blocked"
			: "open";

		let representativePlan = null;
		for (let roomIndex = 0; roomIndex < rooms.length; roomIndex += 1) {
			const room = rooms[roomIndex];
			const roomInput = roomPricingInputForRoom(item, room) || {};
			const periodPrices = [];
			for (const period of periods) {
				const periodInput = periodPricingInputForPeriod(roomInput, period) || {};
				const baseKey = `${normalizeId(room.roomId)}::${period.periodKey}`;
				const baseEntry = baseValues.get(baseKey);
				const periodStatus = ["blocked", "closed", "restricted"].includes(
					String(
						periodInput.status ||
							(periodInput.blocked ? "blocked" : "") ||
							status
					).toLowerCase()
				)
					? "blocked"
					: "open";
				const effectiveStatus =
					pricingBasis.mode === "derived" && baseEntry?.status === "blocked"
						? "blocked"
						: periodStatus;
				const sellingPrice =
					pricingBasis.mode === "derived" && baseEntry
						? applyDerivedPricingAdjustment(
								baseEntry.sellingPrice,
								pricingBasis
						  )
						: periodInput.sellingPrice ??
						  periodInput.price ??
						  roomInput.sellingPrice ??
						  roomInput.price ??
						  item.sellingPrice ??
						  item.price;
				const commissionPercent =
					periodInput.commissionPercent ??
					periodInput.commission ??
					roomInput.commissionPercent ??
					roomInput.commission ??
					item.commissionPercent ??
					item.commission;
				const plan = buildPricingPlan({
					scope: "price-variants",
					dates: [period.startDate],
					sellingPrice,
					commissionPercent,
					status: effectiveStatus,
					calendarType,
					source: "price-variants",
				});
				if (!plan.ok) {
					return {
						ok: false,
						error: `${name} / ${
							room.displayName || room.roomType || "Room"
						} / ${period.label || period.periodKey}: ${plan.error}`,
					};
				}
				if (!representativePlan) representativePlan = plan;
				if (index === 0) {
					baseValues.set(baseKey, {
						sellingPrice: plan.sellingPrice,
						commissionPercent: plan.commissionPercent,
						status: plan.blocked ? "blocked" : "open",
					});
				}
				periodPrices.push({
					...period,
					status: plan.blocked ? "blocked" : "open",
					sellingPrice: plan.sellingPrice,
					commissionPercent: plan.commissionPercent,
					rootPrice: plan.rootPrice,
					color: plan.color,
				});
			}
			const representativePeriod = periodPrices[0] || {};
			roomPricing[roomIndex].pricingItems.push({
				priceVariantItemId: itemId,
				name,
				nameOtherLanguage,
				status,
				sellingPrice: representativePeriod.sellingPrice || 0,
				commissionPercent: representativePeriod.commissionPercent || 0,
				rootPrice: representativePeriod.rootPrice || 0,
				color: representativePlan?.color || "",
				sortOrder: Number.isFinite(Number(item.sortOrder))
					? Number(item.sortOrder)
					: index,
				periodPrices,
			});
		}

		globalItems.push({
			_id: itemId,
			name,
			nameOtherLanguage,
			status,
			sellingPrice: representativePlan?.sellingPrice || 0,
			commissionPercent: representativePlan?.commissionPercent || 0,
			rootPrice: representativePlan?.rootPrice || 0,
			color: representativePlan?.color || "",
			sortOrder: Number.isFinite(Number(item.sortOrder))
				? Number(item.sortOrder)
				: index,
			pricingBasis,
		});
	}

	return { ok: true, items: globalItems, roomPricing };
};

const serializePriceVariantRoom = (hotel = {}, room = {}) => {
	const plain = roomToPlain(room);
	return {
		hotelId: normalizeId(hotel._id),
		roomId: normalizeId(plain._id),
		roomType: plain.roomType || "",
		displayName: plain.displayName || plain.displayName_OtherLanguage || "",
		displayNameOtherLanguage: plain.displayName_OtherLanguage || "",
		roomForGender: plain.roomForGender || "",
	};
};

const serializePriceVariant = (doc = {}, hotelMap = new Map()) => {
	const plain = doc.toObject ? doc.toObject() : doc;
	const hotelIds = uniqueValidIds(plain.hotelIds);
	return {
		_id: normalizeId(plain._id),
		ownerId: normalizeId(plain.ownerId),
		hotelIds,
		hotelNames: hotelIds
			.map((hotelId) => hotelMap.get(hotelId)?.hotelName || "")
			.filter(Boolean),
		roomSelections: (Array.isArray(plain.roomSelections)
			? plain.roomSelections
			: []
		).map((room) => ({
			hotelId: normalizeId(room.hotelId),
			roomId: normalizeId(room.roomId),
			roomType: room.roomType || "",
			displayName: room.displayName || "",
			displayNameOtherLanguage: room.displayNameOtherLanguage || "",
			roomForGender: room.roomForGender || "",
		})),
		dataType: plain.dataType || "price_variant",
		basePriceSource: plain.basePriceSource || "manual",
		calendarType: plain.calendarType || "hijri",
		periodMode: plain.periodMode || "months",
		hijriYear: plain.hijriYear ?? null,
		hijriMonths: normalizePriceVariantMonths(plain.hijriMonths),
		gregorianYear: plain.gregorianYear ?? null,
		gregorianMonths: normalizePriceVariantMonths(plain.gregorianMonths),
		startDate: plain.startDate || "",
		endDate: plain.endDate || "",
		dates: Array.isArray(plain.dates) ? plain.dates : [],
		pricingItems: (Array.isArray(plain.pricingItems) ? plain.pricingItems : []).map(
			(item) => ({
				_id: normalizeId(item._id),
				name: item.name || "",
				nameOtherLanguage: item.nameOtherLanguage || "",
				status: item.status || "open",
				sellingPrice: Number(item.sellingPrice || 0),
				commissionPercent: Number(item.commissionPercent || 0),
				rootPrice: Number(item.rootPrice || 0),
				color: item.color || "",
				sortOrder: Number(item.sortOrder || 0),
				pricingBasis:
					item.pricingBasis && typeof item.pricingBasis === "object"
						? {
								mode: item.pricingBasis.mode || "manual",
								basePriceVariantItemId: normalizeId(
									item.pricingBasis.basePriceVariantItemId
								),
								direction: item.pricingBasis.direction || "increase",
								adjustmentType: item.pricingBasis.adjustmentType || "money",
								amount: Number(item.pricingBasis.amount || 0),
						  }
						: {
								mode: "manual",
								basePriceVariantItemId: "",
								direction: "increase",
								adjustmentType: "money",
								amount: 0,
						  },
				assignedAgents: (Array.isArray(item.assignedAgents)
					? item.assignedAgents
					: []
				).map((assignment) => ({
					agentId: normalizeId(assignment.agentId),
					agentName: assignment.agentName || "",
					agentEmail: assignment.agentEmail || "",
					companyName: assignment.companyName || "",
					hotelIds: uniqueValidIds(assignment.hotelIds),
					assignedAt: assignment.assignedAt,
					assignedBy: normalizeId(assignment.assignedBy),
				})),
			})
		),
		roomPricing: (Array.isArray(plain.roomPricing) ? plain.roomPricing : []).map(
			(room) => ({
				hotelId: normalizeId(room.hotelId),
				roomId: normalizeId(room.roomId),
				roomType: room.roomType || "",
				displayName: room.displayName || "",
				displayNameOtherLanguage: room.displayNameOtherLanguage || "",
				roomForGender: room.roomForGender || "",
				pricingItems: (Array.isArray(room.pricingItems)
					? room.pricingItems
					: []
				).map((item) => ({
					priceVariantItemId: normalizeId(item.priceVariantItemId),
					name: item.name || "",
					nameOtherLanguage: item.nameOtherLanguage || "",
					status: item.status || "open",
					sellingPrice: Number(item.sellingPrice || 0),
					commissionPercent: Number(item.commissionPercent || 0),
					rootPrice: Number(item.rootPrice || 0),
					color: item.color || "",
					sortOrder: Number(item.sortOrder || 0),
					periodPrices: (plain.dataType === "price_variant"
						? (Array.isArray(item.periodPrices) ? item.periodPrices : []).filter(
								(period) => period?.manualOverride === true
						  )
						: Array.isArray(item.periodPrices)
						  ? item.periodPrices
						  : []
					).map((period) => ({
						periodKey: period.periodKey || "",
						label: period.label || "",
						calendarType: period.calendarType || "hijri",
						periodMode: period.periodMode || "months",
						year: period.year ?? null,
						month: period.month ?? null,
						startDate: period.startDate || "",
						endDate: period.endDate || "",
						status: period.status === "blocked" ? "blocked" : "open",
						sellingPrice: Number(period.sellingPrice || 0),
						mainCalendarPrice: Number(period.mainCalendarPrice || 0),
						commissionPercent: Number(period.commissionPercent || 0),
						baseSource: period.baseSource || "",
						manualOverride: period.manualOverride === true,
						rootPrice: Number(period.rootPrice || 0),
						color: period.color || "",
					})),
				})),
			})
		),
		active: plain.active !== false,
		createdAt: plain.createdAt,
		updatedAt: plain.updatedAt,
	};
};

const decoratePlanWithPriceVariant = (plan = {}, selection = null) => {
	if (!selection) return plan;
	return {
		...plan,
		source: "price-variants",
		priceVariantDataId: selection.priceVariantDataId,
		priceVariantItemId: selection.priceVariantItemId,
		priceVariantName: selection.item?.name || "",
		priceVariantNameOtherLanguage: selection.item?.nameOtherLanguage || "",
	};
};

const resolvePriceVariantSelection = async ({
	context,
	hotelIds = [],
	priceVariantDataId = "",
	priceVariantItemId = "",
}) => {
	const dataId = normalizeId(priceVariantDataId);
	const itemId = normalizeId(priceVariantItemId);
	if (!dataId && !itemId) return { ok: true, selection: null };
	if (!ObjectId.isValid(dataId) || !ObjectId.isValid(itemId)) {
		return { ok: false, error: "Valid price variant selection is required" };
	}
	const allowedHotelIds = new Set(
		(context?.hotels || []).map((hotel) => normalizeId(hotel._id))
	);
	const doc = await PriceVariant.findOne({
		_id: ObjectId(dataId),
		active: { $ne: false },
	}).exec();
	if (!doc) {
		return { ok: false, error: "Selected price variant was not found" };
	}
	const docHotelIds = new Set(uniqueValidIds(doc.hotelIds));
	const selectedHotelIds = uniqueValidIds(hotelIds);
	const blockedHotel = selectedHotelIds.find(
		(hotelId) => !allowedHotelIds.has(hotelId) || !docHotelIds.has(hotelId)
	);
	if (blockedHotel) {
		return {
			ok: false,
			error: "Selected price variant is not available for one or more selected hotels",
		};
	}
	const item = (Array.isArray(doc.pricingItems) ? doc.pricingItems : []).find(
		(row) => normalizeId(row?._id) === itemId
	);
	if (!item) {
		return { ok: false, error: "Selected price variant item was not found" };
	}
	return {
		ok: true,
		selection: {
			doc,
			item,
			priceVariantDataId: dataId,
			priceVariantItemId: itemId,
		},
	};
};

const priceVariantValues = (selection = null, fallback = {}) => {
	if (!selection?.item) {
		return {
			status: fallback.status,
			sellingPrice: fallback.sellingPrice,
			commissionPercent: fallback.commissionPercent,
		};
	}
	return {
		status: selection.item.status || "open",
		sellingPrice: selection.item.sellingPrice,
		commissionPercent: selection.item.commissionPercent,
	};
};

const priceVariantValuesForRoom = (
	selection = null,
	fallback = {},
	roomSelection = {}
) => {
	if (!selection?.doc || !selection?.priceVariantItemId) {
		return priceVariantValues(selection, fallback);
	}
	if (isCalendarBasePricingSelection(selection)) {
		const itemStatus =
			selection.item?.status === "blocked" ? "blocked" : "open";
		const commissionPercent = Math.min(
			100,
			Math.max(0, roundPricingNumber(selection.item?.commissionPercent, 0))
		);
		const roomDoc =
			roomSelection.room || roomSelection.roomDoc || roomSelection.roomDetails || null;
		if (!roomDoc) {
			return priceVariantValues(selection, fallback);
		}
		const calendarDate = toCalendarDateKey(
			roomSelection.calendarDate || roomSelection.date || roomSelection.pricingDate
		);
		const roomPricing = (Array.isArray(selection.doc.roomPricing)
			? selection.doc.roomPricing
			: []
		).find(
			(room) =>
				normalizeId(room.hotelId) === normalizeId(roomSelection.hotelId) &&
				normalizeId(room.roomId) === normalizeId(roomSelection.roomId)
		);
		const roomItem = (Array.isArray(roomPricing?.pricingItems)
			? roomPricing.pricingItems
			: []
		).find(
			(item) =>
				normalizeId(item.priceVariantItemId) ===
				normalizeId(selection.priceVariantItemId)
		);
		const manualPeriodPrice = (Array.isArray(roomItem?.periodPrices)
			? roomItem.periodPrices
			: []
		).find((period) => {
			if (!calendarDate || period?.manualOverride !== true) return false;
			const startDate = toCalendarDateKey(period.startDate);
			const endDate = toCalendarDateKey(period.endDate);
			return startDate && endDate && calendarDate >= startDate && calendarDate <= endDate;
		});
		if (manualPeriodPrice && itemStatus !== "blocked") {
			const baseValues = resolveCalendarBasePricingForRoom(roomDoc, calendarDate);
			if (baseValues.status !== "open") {
				return {
					status: "blocked",
					sellingPrice: 0,
					commissionPercent: 0,
				};
			}
			return {
				status: manualPeriodPrice.status === "blocked" ? "blocked" : "open",
				sellingPrice:
					manualPeriodPrice.status === "blocked"
						? 0
						: roundPricingNumber(manualPeriodPrice.sellingPrice, 0),
				commissionPercent:
					manualPeriodPrice.status === "blocked"
						? 0
						: Math.min(
								100,
								Math.max(
									0,
									roundPricingNumber(manualPeriodPrice.commissionPercent, 0)
								)
						  ),
			};
		}
		const baseValues = resolveCalendarBasePricingForRoom(
			roomDoc,
			calendarDate
		);
		if (itemStatus === "blocked" || baseValues.status === "blocked") {
			return {
				status: "blocked",
				sellingPrice: 0,
				commissionPercent: 0,
			};
		}
		if (baseValues.status !== "open" || !(baseValues.sellingPrice > 0)) {
			return priceVariantValues(selection, fallback);
		}
		return {
			status: "open",
			sellingPrice: applyDerivedPricingAdjustment(
				baseValues.sellingPrice,
				normalizeVariantPricingBasis(selection.item)
			),
			commissionPercent,
		};
	}
	const roomPricing = (Array.isArray(selection.doc.roomPricing)
		? selection.doc.roomPricing
		: []
	).find(
		(room) =>
			normalizeId(room.hotelId) === normalizeId(roomSelection.hotelId) &&
			normalizeId(room.roomId) === normalizeId(roomSelection.roomId)
	);
	const roomItem = (Array.isArray(roomPricing?.pricingItems)
		? roomPricing.pricingItems
		: []
	).find(
		(item) =>
			normalizeId(item.priceVariantItemId) ===
			normalizeId(selection.priceVariantItemId)
	);
	if (!roomItem) return priceVariantValues(selection, fallback);
	const calendarDate = toCalendarDateKey(
		roomSelection.calendarDate || roomSelection.date || roomSelection.pricingDate
	);
	const periodPrice = (Array.isArray(roomItem.periodPrices)
		? roomItem.periodPrices
		: []
	).find((period) => {
		if (!calendarDate) return false;
		const startDate = toCalendarDateKey(period.startDate);
		const endDate = toCalendarDateKey(period.endDate);
		return startDate && endDate && calendarDate >= startDate && calendarDate <= endDate;
	});
	if (periodPrice) {
		return {
			status:
				periodPrice.status ||
				roomItem.status ||
				selection.item.status ||
				"open",
			sellingPrice: periodPrice.sellingPrice,
			commissionPercent: periodPrice.commissionPercent,
		};
	}
	return {
		status: roomItem.status || selection.item.status || "open",
		sellingPrice: roomItem.sellingPrice,
		commissionPercent: roomItem.commissionPercent,
	};
};

const mergePriceVariantItemAssignments = ({
	existingAssignments = [],
	agentDocs = [],
	hotelIds = [],
	actor = {},
}) => {
	const byAgentId = new Map(
		(Array.isArray(existingAssignments) ? existingAssignments : []).map((item) => [
			normalizeId(item.agentId),
			{
				agentId: item.agentId,
				agentName: item.agentName || "",
				agentEmail: item.agentEmail || "",
				companyName: item.companyName || "",
				hotelIds: uniqueValidIds(item.hotelIds).map((hotelId) => ObjectId(hotelId)),
				assignedAt: item.assignedAt || new Date(),
				assignedBy: item.assignedBy || null,
			},
		])
	);
	agentDocs.forEach((agent) => {
		const agentId = normalizeId(agent._id);
		if (!agentId || !ObjectId.isValid(agentId)) return;
		byAgentId.set(agentId, {
			agentId: ObjectId(agentId),
			agentName: agent.name || agent.email || "",
			agentEmail: agent.email || "",
			companyName: agent.companyName || agent.companyOfficialName || "",
			hotelIds: uniqueValidIds(hotelIds).map((hotelId) => ObjectId(hotelId)),
			assignedAt: new Date(),
			assignedBy: actor?._id || null,
		});
	});
	return [...byAgentId.values()];
};

const recordPriceVariantAssignments = async ({
	selection = null,
	agentDocs = [],
	hotelIds = [],
	actor = {},
}) => {
	if (!selection || !agentDocs.length) return null;
	const doc = await PriceVariant.findById(selection.priceVariantDataId).exec();
	if (!doc) return null;
	const item = doc.pricingItems.id(selection.priceVariantItemId);
	if (!item) return null;
	item.assignedAgents = mergePriceVariantItemAssignments({
		existingAssignments: item.assignedAgents,
		agentDocs,
		hotelIds,
		actor,
	});
	doc.markModified("pricingItems");
	await doc.save();

	const agentIds = agentDocs.map((agent) => normalizeId(agent._id)).filter(ObjectId.isValid);
	if (agentIds.length) {
		const priceVariantDataId = ObjectId(selection.priceVariantDataId);
		const priceVariantItemId = ObjectId(selection.priceVariantItemId);
		await User.updateMany(
			{ _id: { $in: agentIds.map((id) => ObjectId(id)) } },
			{
				$pull: {
					priceVariantAssignments: {
						priceVariantDataId,
						priceVariantItemId,
					},
				},
			}
		).exec();
		await User.updateMany(
			{ _id: { $in: agentIds.map((id) => ObjectId(id)) } },
			{
				$push: {
					priceVariantAssignments: {
						priceVariantDataId,
						priceVariantItemId,
						pricingName: selection.item?.name || "",
						pricingNameOtherLanguage: selection.item?.nameOtherLanguage || "",
						hotelIds: uniqueValidIds(hotelIds).map((hotelId) => ObjectId(hotelId)),
						assignedAt: new Date(),
						assignedBy: actor?._id || null,
					},
				},
			}
		).exec();
	}
	return doc;
};

const saveAgentPriceVariantAssignments = async ({
	context = {},
	hotelDocs = [],
	hotelIds = [],
	agentDocs = [],
	selections = [],
} = {}) => {
	const requestedSelections = Array.isArray(selections) ? selections : [];
	if (!requestedSelections.length) {
		return {
			ok: false,
			status: 400,
			error: "Please select at least one price variant",
		};
	}
	if (requestedSelections.length > 100) {
		return {
			ok: false,
			status: 400,
			error: "Please assign 100 price variants or fewer at once",
		};
	}
	const selectedHotelIds = uniqueValidIds(hotelIds);
	const selectedHotelSet = new Set(selectedHotelIds);
	const allowedHotelIds = new Set(
		(context?.hotels || []).map((hotel) => normalizeId(hotel._id))
	);
	const dataIds = uniqueValidIds(
		requestedSelections.map((selection) => selection.priceVariantDataId)
	);
	const docs = await PriceVariant.find({
		_id: { $in: dataIds.map((id) => ObjectId(id)) },
		active: { $ne: false },
		hotelIds: { $in: selectedHotelIds.map((id) => ObjectId(id)) },
	}).exec();
	const docsById = new Map(docs.map((doc) => [normalizeId(doc._id), doc]));
	const hotelMap = new Map(
		(Array.isArray(hotelDocs) ? hotelDocs : []).map((hotel) => [
			normalizeId(hotel._id),
			hotel,
		])
	);
	const agentSet = new Set(agentDocs.map((agent) => normalizeId(agent._id)));
	const rowsByRoomKey = new Map();
	const savedDocsById = new Map();
	const resolvedSelections = [];
	let plannedRows = 0;

	for (const requested of requestedSelections) {
		const doc = docsById.get(normalizeId(requested.priceVariantDataId));
		if (!doc) {
			return {
				ok: false,
				status: 400,
				error: "Selected price variant is not available for the selected hotels",
			};
		}
		const item = (Array.isArray(doc.pricingItems) ? doc.pricingItems : []).find(
			(row) => normalizeId(row?._id) === normalizeId(requested.priceVariantItemId)
		);
		if (!item) {
			return {
				ok: false,
				status: 400,
				error: "Selected price variant item was not found",
			};
		}
		const docHotelIds = uniqueValidIds(doc.hotelIds);
		const scopedHotelIds = selectedHotelIds.filter(
			(hotelId) =>
				selectedHotelSet.has(hotelId) &&
				allowedHotelIds.has(hotelId) &&
				docHotelIds.includes(hotelId)
		);
		if (!scopedHotelIds.length) {
			return {
				ok: false,
				status: 400,
				error: `${item.name || "Selected price variant"} does not match the selected hotels`,
			};
		}
		const selection = {
			doc,
			item,
			priceVariantDataId: normalizeId(doc._id),
			priceVariantItemId: normalizeId(item._id),
		};
		resolvedSelections.push({ selection, scopedHotelIds });

		(Array.isArray(doc.roomPricing) ? doc.roomPricing : []).forEach(
			(roomPricing) => {
				const hotelId = normalizeId(roomPricing.hotelId);
				if (!scopedHotelIds.includes(hotelId)) return;
				const hotel = hotelMap.get(hotelId);
				const rooms = Array.isArray(hotel?.roomCountDetails)
					? hotel.roomCountDetails
					: [];
				const roomId = normalizeId(roomPricing.roomId);
				const roomIndex = rooms.findIndex(
					(room) => normalizeId(room?._id) === roomId
				);
				if (roomIndex < 0) return;
				const room = roomToPlain(rooms[roomIndex]);
				const roomItem = (Array.isArray(roomPricing.pricingItems)
					? roomPricing.pricingItems
					: []
				).find(
					(price) =>
						normalizeId(price.priceVariantItemId) ===
						normalizeId(item._id)
				);
				if (!roomItem) return;
				const periodPrices = Array.isArray(roomItem.periodPrices)
					? roomItem.periodPrices
					: [];
				const roomKey = `${hotelId}:${roomId}`;
				const roomRows = rowsByRoomKey.get(roomKey) || [];
				periodPrices.forEach((period) => {
					const calendarDate = toCalendarDateKey(
						period.startDate || period.periodKey || period.label
					);
					if (!calendarDate) return;
					const rowPlan = buildPricingPlan({
						scope: "price-variants",
						dates: [calendarDate],
						sellingPrice: period.sellingPrice,
						commissionPercent: period.commissionPercent,
						status: period.status,
						calendarType: period.calendarType || doc.calendarType,
						source: "price-variants",
					});
					if (!rowPlan.ok) return;
					const decoratedPlan = decoratePlanWithPriceVariant(rowPlan, selection);
					if (!decoratedPlan.ok) return;
					agentDocs.forEach((agent) => {
						roomRows.push(
							buildAgentRow(decoratedPlan, room, calendarDate, agent)
						);
						plannedRows += 1;
					});
				});
				rowsByRoomKey.set(roomKey, roomRows);
			}
		);
	}

	if (plannedRows > 25000) {
		return {
			ok: false,
			status: 400,
			error:
				"This would assign too many agent calendar rows. Please split it into fewer variants or hotels.",
		};
	}

	for (const { selection, scopedHotelIds } of resolvedSelections) {
		const savedDoc = await recordPriceVariantAssignments({
			selection,
			agentDocs,
			hotelIds: scopedHotelIds,
			actor: context.actor,
		});
		if (savedDoc) savedDocsById.set(normalizeId(savedDoc._id), savedDoc);
	}

	const updatedHotels = [];
	let updatedRows = 0;
	for (const hotel of hotelDocs) {
		const hotelId = normalizeId(hotel._id);
		if (!selectedHotelSet.has(hotelId)) continue;
		const rooms = Array.isArray(hotel.roomCountDetails)
			? hotel.roomCountDetails
			: [];
		let hotelChanged = false;
		rooms.forEach((room, roomIndex) => {
			const roomId = normalizeId(room?._id);
			const roomRows = rowsByRoomKey.get(`${hotelId}:${roomId}`) || [];
			const roomPlain = roomToPlain(room);
			const existingAgentRows = (Array.isArray(roomPlain.agentPricingRate)
				? roomPlain.agentPricingRate
				: []
			).filter((row) => agentSet.has(normalizeCalendarId(row?.agentId)));
			if (!roomRows.length && !existingAgentRows.length) return;
			rooms[roomIndex].agentPricingRate = replaceAgentCalendarRowsForAgents(
				roomPlain.agentPricingRate,
				roomRows,
				agentSet
			);
			updatedRows += roomRows.length;
			hotelChanged = true;
		});
		if (hotelChanged) {
			hotel.roomCountDetails = rooms;
			hotel.markModified("roomCountDetails");
			await hotel.save();
			updatedHotels.push(serializeCalendarHotel(hotel));
		}
	}

	return {
		ok: true,
		updatedRows,
		updatedHotels,
		priceVariantData: [...savedDocsById.values()],
		assignedPriceVariants: requestedSelections.length,
		assignedAgents: agentDocs.length,
	};
};

const propagatePriceVariantUpdates = async (doc = {}, changedItemIds = []) => {
	const priceVariantDataId = normalizeId(doc?._id);
	if (!priceVariantDataId) return { updatedRows: 0, updatedHotels: 0 };
	const changedIds = new Set(uniqueValidIds(changedItemIds));
	const items = (Array.isArray(doc.pricingItems) ? doc.pricingItems : []).filter(
		(item) => {
			const itemId = normalizeId(item?._id);
			return itemId && (!changedIds.size || changedIds.has(itemId));
		}
	);
	if (!items.length) return { updatedRows: 0, updatedHotels: 0 };
	const itemsById = new Map(items.map((item) => [normalizeId(item._id), item]));
	const hotelDocs = await HotelDetails.find({
		"roomCountDetails.agentPricingRate.priceVariantDataId": priceVariantDataId,
	}).exec();
	let updatedRows = 0;
	let updatedHotels = 0;
	for (const hotel of hotelDocs) {
		let hotelChanged = false;
		const rooms = Array.isArray(hotel.roomCountDetails)
			? hotel.roomCountDetails
			: [];
		rooms.forEach((room) => {
			const roomId = normalizeId(room?._id);
			const hotelId = normalizeId(hotel._id);
			const rows = Array.isArray(room.agentPricingRate)
				? room.agentPricingRate
				: [];
			rows.forEach((row) => {
				const rowVariantDataId = normalizeId(row?.priceVariantDataId);
				if (rowVariantDataId !== priceVariantDataId) return;
				const itemId = normalizeId(row?.priceVariantItemId);
				const item = itemsById.get(itemId);
				if (!item) return;
				const values = priceVariantValuesForRoom(
					{
						doc,
						item,
						priceVariantDataId,
						priceVariantItemId: itemId,
					},
					{
						status: item.status,
						sellingPrice: item.sellingPrice,
						commissionPercent: item.commissionPercent,
					},
					{ hotelId, roomId, calendarDate: row.calendarDate, room }
				);
				const plan = buildPricingPlan({
					scope: "price-variants",
					dates: ["2000-01-01"],
					sellingPrice: values.sellingPrice,
					commissionPercent: values.commissionPercent,
					status: values.status,
					calendarType: doc.calendarType,
					source: "price-variants",
				});
				if (!plan) return;
				const decoratedPlan = decoratePlanWithPriceVariant(plan, {
					priceVariantDataId,
					priceVariantItemId: itemId,
					item,
				});
				if (!decoratedPlan.ok) return;
				row.price = decoratedPlan.sellingPrice;
				row.rootPrice = decoratedPlan.rootPrice;
				row.sellingPrice = decoratedPlan.sellingPrice;
				row.commissionPercent = decoratedPlan.commissionPercent;
				row.commissionRate = decoratedPlan.commissionRateForPms;
				row.color = decoratedPlan.color;
				row.source = "price-variants";
				row.priceVariantName = decoratedPlan.priceVariantName;
				row.priceVariantNameOtherLanguage =
					decoratedPlan.priceVariantNameOtherLanguage;
				if (decoratedPlan.blocked) {
					row.status = "blocked";
					row.blocked = true;
				} else {
					row.status = "open";
					row.blocked = false;
				}
				updatedRows += 1;
				hotelChanged = true;
			});
		});
		if (hotelChanged) {
			hotel.roomCountDetails = rooms;
			hotel.markModified("roomCountDetails");
			await hotel.save();
			updatedHotels += 1;
		}
	}
	return { updatedRows, updatedHotels };
};

const rebuildCalendarBasedPriceVariant = async (doc = {}) => {
	const hotelIds = uniqueValidIds(doc?.hotelIds);
	if (!hotelIds.length) {
		return { rebuilt: false, updatedRows: 0, updatedHotels: 0 };
	}
	const hotelDocs = await HotelDetails.find({
		_id: { $in: hotelIds.map((hotelId) => ObjectId(hotelId)) },
	}).exec();
	const hotelMap = new Map(
		hotelDocs.map((hotel) => [normalizeId(hotel._id), hotel])
	);
	const roomPairs = hotelIds.flatMap((hotelId) => {
		const hotel = hotelMap.get(hotelId);
		return (Array.isArray(hotel?.roomCountDetails)
			? hotel.roomCountDetails
			: []
		)
			.filter((room) => room?.activeRoom !== false)
			.map((roomDoc) => ({
				hotel,
				roomDoc,
				room: serializePriceVariantRoom(hotel, roomDoc),
			}))
			.filter((entry) => entry.room.roomId);
	});
	if (!roomPairs.length) {
		return { rebuilt: false, updatedRows: 0, updatedHotels: 0 };
	}
	const missingRooms = hotelDocs.flatMap((hotel) =>
		validateRoomsReadyForPricingVariants(hotel).missingRooms.map((room) => ({
			...room,
			hotelId: normalizeId(hotel._id),
			hotelName: hotel.hotelName || "Hotel",
		}))
	);
	if (missingRooms.length) {
		throw new Error(
			"Cannot refresh price variants until every active room has a base price and default cost"
		);
	}
	const existingItemsById = new Map(
		(Array.isArray(doc.pricingItems) ? doc.pricingItems : []).map((item) => [
			normalizeId(item._id),
			item,
		])
	);
	const pricingItems = await buildPricingVariantItemsForRooms({
		body: {
			skipNameTranslation: true,
			pricingItems: (Array.isArray(doc.pricingItems) ? doc.pricingItems : []).map(
				(item) => ({
					_id: normalizeId(item._id),
					name: item.name || item.nameOtherLanguage || "Price variant",
					nameOtherLanguage: item.nameOtherLanguage || item.name || "",
					status: item.status || "open",
					commissionPercent: item.commissionPercent || 0,
					sortOrder: item.sortOrder,
					pricingBasis: item.pricingBasis || {},
				})
			),
		},
		calendarType: doc.calendarType === "gregorian" ? "gregorian" : "hijri",
		rooms: roomPairs.map((entry) => entry.room),
		roomDocs: roomPairs.map((entry) => entry.roomDoc),
	});
	if (!pricingItems.ok) {
		throw new Error(pricingItems.error || "Could not refresh price variants");
	}
	const pricingItemPayload = pricingItems.items.map((item) => {
		const existingItem = existingItemsById.get(normalizeId(item._id));
		return {
			...item,
			assignedAgents: Array.isArray(existingItem?.assignedAgents)
				? existingItem.assignedAgents
				: [],
		};
	});
	doc.roomSelections = roomPairs.map(({ room }) => ({
		hotelId: ObjectId(room.hotelId),
		roomId: ObjectId(room.roomId),
		roomType: room.roomType,
		displayName: room.displayName,
		displayNameOtherLanguage: room.displayNameOtherLanguage,
		roomForGender: room.roomForGender,
	}));
	doc.roomPricing = pricingItems.roomPricing;
	doc.pricingItems = pricingItemPayload;
	doc.dataType = "price_variant";
	doc.basePriceSource = "calendar_main_price";
	doc.periodMode = "custom";
	doc.dates = [];
	doc.hijriMonths = [];
	doc.gregorianMonths = [];
	doc.startDate = "";
	doc.endDate = "";
	doc.markModified("roomSelections");
	doc.markModified("roomPricing");
	doc.markModified("pricingItems");
	const saved = await doc.save();
	const propagation = await propagatePriceVariantUpdates(saved);
	return {
		rebuilt: true,
		updatedRows: propagation.updatedRows || 0,
		updatedHotels: propagation.updatedHotels || 0,
	};
};

const propagateCalendarBasePricingVariants = async ({ hotelIds = [] } = {}) => {
	const ids = uniqueValidIds(hotelIds);
	if (!ids.length) {
		return {
			variantDocs: 0,
			rebuiltVariantDocs: 0,
			updatedRows: 0,
			updatedHotels: 0,
		};
	}
	const docs = await PriceVariant.find({
		active: { $ne: false },
		hotelIds: { $in: ids.map((hotelId) => ObjectId(hotelId)) },
		$or: [
			{ dataType: "price_variant" },
			{ basePriceSource: "calendar_main_price" },
			{ "pricingItems.pricingBasis.mode": "calendar_base" },
		],
	}).exec();
	const summary = {
		variantDocs: docs.length,
		rebuiltVariantDocs: 0,
		updatedRows: 0,
		updatedHotels: 0,
	};
	for (const doc of docs) {
		const result = await rebuildCalendarBasedPriceVariant(doc);
		if (result.rebuilt) summary.rebuiltVariantDocs += 1;
		summary.updatedRows += result.updatedRows || 0;
		summary.updatedHotels += result.updatedHotels || 0;
	}
	return summary;
};

exports.overallCalendarPricingOptions = async (req, res) => {
	try {
		const context = await requireOverallSection(req, res, "settings");
		if (!context) return;
		const hotelIds = context.hotels.map((hotel) => normalizeId(hotel._id));
		const agents = hotelIds.length
			? await User.find(buildCalendarAgentQuery(hotelIds))
					.select(
						"_id name email phone companyName companyOfficialName agentCommercialModel hotelIdWork hotelIdsWork hotelsToSupport hotelIdsOwner"
					)
					.sort({ name: 1, email: 1 })
					.lean()
					.exec()
			: [];
		const priceVariantData = hotelIds.length
			? await PriceVariant.find({
					active: { $ne: false },
					hotelIds: { $in: hotelIds.map((hotelId) => ObjectId(hotelId)) },
			  })
					.sort({ createdAt: -1 })
					.limit(200)
					.lean()
					.exec()
			: [];
		const hotelMap = new Map(
			context.hotels.map((hotel) => [normalizeId(hotel._id), hotel])
		);
		return res.json({
			hotels: context.hotels.map(serializeCalendarHotel),
			agents: agents.map(serializeCalendarAgent),
			priceVariantData: priceVariantData.map((item) =>
				serializePriceVariant(item, hotelMap)
			),
		});
	} catch (error) {
		console.error("overallCalendarPricingOptions error:", error);
		return res
			.status(500)
			.json({ error: "Could not load calendar pricing options" });
	}
};

exports.overallPriceVariantOptions = async (req, res) => {
	try {
		const context = await requireOverallSection(req, res, "settings");
		if (!context) return;
		const hotelIds = context.hotels.map((hotel) => normalizeId(hotel._id));
		const hotelMap = new Map(
			context.hotels.map((hotel) => [normalizeId(hotel._id), hotel])
		);
		const priceVariantData = hotelIds.length
			? await PriceVariant.find({
					active: { $ne: false },
					hotelIds: { $in: hotelIds.map((hotelId) => ObjectId(hotelId)) },
			  })
					.sort({ createdAt: -1 })
					.limit(200)
					.lean()
					.exec()
			: [];
		return res.json({
			hotels: context.hotels.map(serializeCalendarHotel),
			priceVariantData: priceVariantData.map((item) =>
				serializePriceVariant(item, hotelMap)
			),
		});
	} catch (error) {
		console.error("overallPriceVariantOptions error:", error);
		return res
			.status(500)
			.json({ error: "Could not load price variants options" });
	}
};

exports.saveOverallPriceVariant = async (req, res) => {
	try {
		const context = await requireOverallSection(req, res, "settings");
		if (!context) return;
		const body = req.body || {};
		const variantMode = isPricingVariantRequest(body);
		const hotelIds = requestedCalendarHotelIds(body);
		const dates = [
			...new Set(
				(Array.isArray(body.dates) ? body.dates : [])
					.map(toCalendarDateKey)
					.filter(Boolean)
			),
		].sort();
		const calendarType = body.calendarType === "gregorian" ? "gregorian" : "hijri";
		const periodMode = variantMode
			? "custom"
			: body.periodMode === "custom"
			  ? "custom"
			  : "months";
		const periods = variantMode ? [] : normalizePriceVariantPeriods(body, dates);

		if (
			!hotelIds.length ||
			hotelIds.some((hotelId) => !ObjectId.isValid(hotelId))
		) {
			return res.status(400).json({
				error: "Please select at least one valid hotel for price variants",
			});
		}
		const allowedHotelIds = new Set(context.hotels.map((hotel) => normalizeId(hotel._id)));
		const forbiddenHotelIds = hotelIds.filter((hotelId) => !allowedHotelIds.has(hotelId));
		if (forbiddenHotelIds.length) {
			return res
				.status(403)
				.json({
					error: "You cannot save price variants for one or more selected hotels",
				});
		}

		const hotelDocs = await HotelDetails.find({ _id: { $in: hotelIds } }).exec();
		if (hotelDocs.length !== hotelIds.length) {
			return res.status(404).json({ error: "One or more hotels were not found" });
		}
		const hotelMap = new Map(hotelDocs.map((hotel) => [normalizeId(hotel._id), hotel]));
		const roomPairs = hotelIds.flatMap((hotelId) => {
			const hotel = hotelMap.get(hotelId);
			return (Array.isArray(hotel?.roomCountDetails)
				? hotel.roomCountDetails
				: []
			)
				.filter((room) => room?.activeRoom !== false)
				.map((roomDoc) => ({
					hotel,
					roomDoc,
					room: serializePriceVariantRoom(hotel, roomDoc),
				}))
				.filter((entry) => entry.room.roomId);
		});
		const activeRoomDocs = roomPairs.map((entry) => entry.roomDoc);
		const serializedRooms = roomPairs.map((entry) => entry.room);
		if (!serializedRooms.length) {
			return res
				.status(400)
				.json({ error: "No rooms are available for the selected hotels" });
		}
		if (variantMode) {
			const readinessByHotel = hotelIds.map((hotelId) => {
				const hotel = hotelMap.get(hotelId);
				const readiness = validateRoomsReadyForPricingVariants(hotel);
				return {
					hotelId,
					hotelName: hotel?.hotelName || "",
					...readiness,
					missingRooms: readiness.missingRooms.map((room) => ({
						...room,
						hotelId,
						hotelName: hotel?.hotelName || "",
					})),
				};
			});
			const missingRooms = readinessByHotel.flatMap(
				(readiness) => readiness.missingRooms
			);
			const hotelsWithoutRooms = readinessByHotel
				.filter((readiness) => !readiness.activeRooms.length)
				.map((readiness) => ({
					hotelId: readiness.hotelId,
					hotelName: readiness.hotelName,
				}));
			if (missingRooms.length || hotelsWithoutRooms.length) {
				return res.status(400).json({
					error:
						"Please add the main calendar/base price for every active room before creating price variants",
					missingRooms: missingRooms.slice(0, 25),
					hotelsWithoutRooms,
				});
			}
		}

		const pricingItems = variantMode
			? await buildPricingVariantItemsForRooms({
					body,
					calendarType,
					rooms: serializedRooms,
					roomDocs: activeRoomDocs,
			  })
			: await buildPriceVariantItemsForRooms({
					body,
					dates,
					calendarType,
					rooms: serializedRooms,
					periods,
			  });
		if (!pricingItems.ok) {
			return res.status(400).json({ error: pricingItems.error });
		}

		const priceVariantDataId = normalizeId(
			body.priceVariantDataId || body._id
		);
		let existingDoc = null;
		if (priceVariantDataId) {
			if (!ObjectId.isValid(priceVariantDataId)) {
				return res.status(400).json({ error: "Valid price variant id is required" });
			}
			existingDoc = await PriceVariant.findOne({
				_id: ObjectId(priceVariantDataId),
				active: { $ne: false },
			}).exec();
			if (!existingDoc) {
				return res.status(404).json({ error: "Price variants was not found" });
			}
			const existingHotelIds = uniqueValidIds(existingDoc.hotelIds);
			const blockedExistingHotel = existingHotelIds.find(
				(hotelId) => !allowedHotelIds.has(hotelId)
			);
			if (blockedExistingHotel) {
				return res.status(403).json({
					error: "You cannot update this price variants",
				});
			}
		}

		const ownerIds = uniqueValidIds(hotelDocs.map((hotel) => hotel.belongsTo));
		const queryOwnerId = normalizeId(req.query?.ownerId);
		const ownerId =
			ownerIds.length === 1
				? ownerIds[0]
				: ownerIds.includes(queryOwnerId)
				  ? queryOwnerId
				  : null;
		const roomSelectionPayload = serializedRooms.map((room) => ({
			hotelId: ObjectId(room.hotelId),
			roomId: ObjectId(room.roomId),
			roomType: room.roomType,
			displayName: room.displayName,
			displayNameOtherLanguage: room.displayNameOtherLanguage,
			roomForGender: room.roomForGender,
		}));
		const existingItemsById = new Map(
			(Array.isArray(existingDoc?.pricingItems) ? existingDoc.pricingItems : []).map(
				(item) => [normalizeId(item._id), item]
			)
		);
		const pricingItemPayload = pricingItems.items.map((item) => {
			const existingItem = existingItemsById.get(normalizeId(item._id));
			return {
				...item,
				assignedAgents: Array.isArray(existingItem?.assignedAgents)
					? existingItem.assignedAgents
					: item.assignedAgents || [],
			};
		});
		const payload = {
			ownerId: ownerId && ObjectId.isValid(ownerId) ? ObjectId(ownerId) : null,
			hotelIds: hotelIds.map((hotelId) => ObjectId(hotelId)),
			roomSelections: roomSelectionPayload,
			roomPricing: pricingItems.roomPricing,
			dataType: "price_variant",
			basePriceSource: variantMode ? "calendar_main_price" : "manual",
			calendarType,
			periodMode,
			hijriYear: variantMode
				? null
				: Number.isFinite(Number(body.hijriYear))
				? Number(body.hijriYear)
				: null,
			hijriMonths: variantMode
				? []
				: normalizePriceVariantMonths(body.hijriMonths),
			gregorianYear: variantMode
				? null
				: Number.isFinite(Number(body.gregorianYear))
				? Number(body.gregorianYear)
				: null,
			gregorianMonths: variantMode
				? []
				: normalizePriceVariantMonths(body.gregorianMonths),
			startDate: variantMode ? "" : toCalendarDateKey(body.startDate),
			endDate: variantMode ? "" : toCalendarDateKey(body.endDate),
			dates: variantMode ? [] : dates,
			pricingItems: pricingItemPayload,
			updatedBy: context.actor?._id || null,
		};

		if (existingDoc) {
			Object.assign(existingDoc, payload);
			existingDoc.markModified("pricingItems");
			existingDoc.markModified("roomPricing");
			const saved = await existingDoc.save();
			const propagation = await propagatePriceVariantUpdates(
				saved,
				pricingItemPayload.map((item) => normalizeId(item._id)).filter(Boolean)
			);
			return res.json({
				ok: true,
				action: "update",
				priceVariantData: serializePriceVariant(saved, hotelMap),
				propagation,
			});
		}

		const created = await PriceVariant.create({
			...payload,
			createdBy: context.actor?._id || null,
		});

		return res.status(201).json({
			ok: true,
			action: "create",
			priceVariantData: serializePriceVariant(created, hotelMap),
			propagation: { updatedRows: 0, updatedHotels: 0 },
		});
	} catch (error) {
		console.error("saveOverallPriceVariant error:", error);
		return res.status(500).json({ error: "Could not save price variants" });
	}
};

exports.saveOverallCalendarPricing = async (req, res) => {
	try {
		const context = await requireOverallSection(req, res, "settings");
		if (!context) return;
		const body = req.body || {};
		const scope = String(body.scope || "general").toLowerCase() === "agents"
			? "agents"
			: "general";
		const pricingOperation =
			scope === "general" ? normalizeCalendarPricingOperation(body) : "update";
		const variantAssignmentMode =
			scope === "agents" && isAgentPriceVariantAssignmentRequest(body);
		const explicitRows = requestedCalendarRows(body);
		const explicitRowMode = explicitRows.length > 0;
		const hotelIds = explicitRowMode
			? uniqueValidIds(explicitRows.map((row) => row.hotelId))
			: requestedCalendarHotelIds(body);
		const roomSelections = explicitRowMode
			? [
					...new Map(
						explicitRows.map((row) => [
							`${row.hotelId}:${row.roomId}`,
							{ hotelId: row.hotelId, roomId: row.roomId },
						])
					).values(),
			  ]
			: requestedCalendarRoomSelections(body);
		const agentIds =
			scope === "agents"
				? uniqueValidIds(Array.isArray(body.agentIds) ? body.agentIds : [body.agentId])
				: [];
		const priceVariantSelections = variantAssignmentMode
			? requestedCalendarPriceVariantSelections(body)
			: [];

		if (!hotelIds.length || hotelIds.some((hotelId) => !ObjectId.isValid(hotelId))) {
			return res.status(400).json({ error: "Valid hotel selection is required" });
		}
		if (!variantAssignmentMode && !roomSelections.length) {
			return res.status(400).json({ error: "Please select at least one room" });
		}
		if (scope === "agents" && !agentIds.length) {
			return res.status(400).json({ error: "Please select at least one agent" });
		}
		if (variantAssignmentMode && !priceVariantSelections.length) {
			return res.status(400).json({
				error: "Please select at least one price variant",
			});
		}

		const allowedHotelIds = new Set(context.hotels.map((hotel) => normalizeId(hotel._id)));
		const forbiddenHotelIds = hotelIds.filter((hotelId) => !allowedHotelIds.has(hotelId));
		if (forbiddenHotelIds.length) {
			return res
				.status(403)
				.json({ error: "You cannot update calendar pricing for this hotel" });
		}
		const blockedRoomSelection = roomSelections.find(
			(selection) => !allowedHotelIds.has(selection.hotelId)
		);
		if (blockedRoomSelection) {
			return res
				.status(403)
				.json({ error: "You cannot update one or more selected rooms" });
		}

		if (variantAssignmentMode) {
			const hotelDocs = await HotelDetails.find({ _id: { $in: hotelIds } }).exec();
			if (hotelDocs.length !== hotelIds.length) {
				return res.status(404).json({ error: "One or more hotels were not found" });
			}
			const agentDocs = await User.find(buildCalendarAgentQuery(hotelIds, agentIds))
				.select("_id name email companyName companyOfficialName")
				.lean()
				.exec();
			if (agentDocs.length !== agentIds.length) {
				return res.status(404).json({
					error: "One or more selected agents were not found for these hotels",
				});
			}
			const assignmentResult = await saveAgentPriceVariantAssignments({
				context,
				hotelDocs,
				hotelIds,
				agentDocs,
				selections: priceVariantSelections,
			});
			if (!assignmentResult.ok) {
				return res
					.status(assignmentResult.status || 400)
					.json({ error: assignmentResult.error });
			}
			const hotelMap = new Map(
				(context.hotels || []).map((hotel) => [normalizeId(hotel._id), hotel])
			);
			return res.json({
				ok: true,
				scope,
				assignmentMode: "price_variants",
				updatedRows: assignmentResult.updatedRows,
				updatedHotels: assignmentResult.updatedHotels,
				priceVariantDataList: (assignmentResult.priceVariantData || []).map(
					(doc) => serializePriceVariant(doc, hotelMap)
				),
				summary: {
					hotels: hotelIds.length,
					agents: agentIds.length,
					priceVariants: assignmentResult.assignedPriceVariants || 0,
					rows: assignmentResult.updatedRows,
				},
			});
		}

		const variantSelectionResult =
			scope === "agents"
				? await resolvePriceVariantSelection({
						context,
						hotelIds,
						priceVariantDataId: body.priceVariantDataId,
						priceVariantItemId: body.priceVariantItemId,
				  })
				: { ok: true, selection: null };
		if (!variantSelectionResult.ok) {
			return res.status(400).json({ error: variantSelectionResult.error });
		}
		const variantSelection = variantSelectionResult.selection;
		const basePricingValues = priceVariantValues(variantSelection, {
			status: body.status,
			sellingPrice: body.sellingPrice ?? body.price,
			commissionPercent: body.commissionPercent ?? body.commission,
		});

		const plan = explicitRowMode
			? null
			: buildPricingPlan({
					scope,
					dates: body.dates,
					sellingPrice: basePricingValues.sellingPrice,
					commissionPercent: basePricingValues.commissionPercent,
					status: basePricingValues.status,
					calendarType: body.calendarType,
			  });
		const decoratedPlan = plan
			? decoratePlanWithPriceVariant(plan, variantSelection)
			: null;
		if (!explicitRowMode && !decoratedPlan.ok) {
			return res.status(400).json({ error: decoratedPlan.error });
		}
		if (explicitRowMode) {
			const invalidRow = explicitRows.find((row) => {
				const rowPricingValues = priceVariantValuesForRoom(
					variantSelection,
					{
						status: row.status,
						sellingPrice: row.sellingPrice,
						commissionPercent: row.commissionPercent,
					},
					row
				);
				const rowPlan = buildPricingPlan({
					scope,
					dates: [row.calendarDate],
					sellingPrice: rowPricingValues.sellingPrice,
					commissionPercent: rowPricingValues.commissionPercent,
					status: rowPricingValues.status,
					calendarType: body.calendarType,
				});
				return !rowPlan.ok;
			});
			if (invalidRow) {
				return res.status(400).json({
					error: "One or more calendar rows has invalid pricing",
					row: invalidRow,
				});
			}
		}

		const sizeCheck = explicitRowMode
			? {
					ok:
						explicitRows.length * (scope === "agents" ? agentIds.length : 1) <=
						25000,
					error:
						"This would update too many rows. Please split it into smaller batches.",
			  }
			: ensurePlanSize({
					dates: decoratedPlan.dates,
					roomCount: roomSelections.length,
					agentCount: scope === "agents" ? agentIds.length : 1,
			  });
		if (!sizeCheck.ok) return res.status(400).json({ error: sizeCheck.error });

		const hotelDocs = await HotelDetails.find({ _id: { $in: hotelIds } }).exec();
		if (hotelDocs.length !== hotelIds.length) {
			return res.status(404).json({ error: "One or more hotels were not found" });
		}
		const hotelMap = new Map(hotelDocs.map((hotel) => [normalizeId(hotel._id), hotel]));
		const missingRoom = roomSelections.find((selection) => {
			const hotel = hotelMap.get(selection.hotelId);
			const rooms = Array.isArray(hotel?.roomCountDetails)
				? hotel.roomCountDetails
				: [];
			return !rooms.some((room) => normalizeId(room?._id) === selection.roomId);
		});
		if (missingRoom) {
			return res.status(404).json({
				error: "One or more selected rooms were not found",
				missingRooms: [missingRoom],
			});
		}
		const defaultDateSet = new Set(decoratedPlan?.dates || []);
		if (scope === "general" && pricingOperation === "add") {
			const duplicateRows = findGeneralCalendarPricingDuplicates({
				hotelDocs,
				roomSelections,
				explicitRows,
				defaultDates: [...defaultDateSet],
			});
			if (duplicateRows.length) {
				return res.status(409).json({
					error:
						"Main calendar pricing already exists for one or more selected rooms and dates. Please use the Update tab to change existing pricing.",
					duplicates: duplicateRows.slice(0, 50),
					duplicateCount: duplicateRows.length,
				});
			}
		}

		const agentDocs =
			scope === "agents"
				? await User.find(buildCalendarAgentQuery(hotelIds, agentIds))
						.select("_id name email companyName companyOfficialName")
						.lean()
						.exec()
				: [];
		if (scope === "agents" && agentDocs.length !== agentIds.length) {
			return res.status(404).json({
				error: "One or more selected agents were not found for these hotels",
			});
		}
		const agentSet = new Set(agentIds.map(normalizeId));
		const agentMap = new Map(agentDocs.map((agent) => [normalizeId(agent._id), agent]));
		let updatedRows = 0;
		const updatedHotels = [];
		const calendarType = body.calendarType === "gregorian" ? "gregorian" : "hijri";

		for (const hotel of hotelDocs) {
			const hotelId = normalizeId(hotel._id);
			const hotelSelections = roomSelections.filter(
				(selection) => selection.hotelId === hotelId
			);
			if (!hotelSelections.length) continue;
			const rooms = Array.isArray(hotel.roomCountDetails)
				? hotel.roomCountDetails
				: [];
			hotelSelections.forEach((selection) => {
				const roomIndex = rooms.findIndex(
					(room) => normalizeId(room?._id) === selection.roomId
				);
				const room = roomToPlain(rooms[roomIndex]);
				const roomRows = explicitRowMode
					? explicitRows.filter(
							(row) =>
								row.hotelId === selection.hotelId &&
								row.roomId === selection.roomId
					  )
					: [];
				const roomDateSet = explicitRowMode
					? new Set(roomRows.map((row) => row.calendarDate))
					: defaultDateSet;
				if (scope === "agents") {
					const nextRows = [];
					if (explicitRowMode) {
						roomRows.forEach((row) => {
							const rowPricingValues = priceVariantValuesForRoom(
								variantSelection,
								{
									status: row.status,
									sellingPrice: row.sellingPrice,
									commissionPercent: row.commissionPercent,
								},
								{ ...row, room: rooms[roomIndex] }
							);
							const rowPlan = buildPricingPlan({
								scope,
								dates: [row.calendarDate],
								sellingPrice: rowPricingValues.sellingPrice,
								commissionPercent: rowPricingValues.commissionPercent,
								status: rowPricingValues.status,
								calendarType,
							});
							if (!rowPlan.ok) return;
							const nextRowPlan = decoratePlanWithPriceVariant(
								rowPlan,
								variantSelection
							);
							agentIds.forEach((agentId) => {
								const agent = agentMap.get(normalizeId(agentId));
								nextRows.push(
									buildAgentRow(nextRowPlan, room, row.calendarDate, agent)
								);
							});
						});
					} else {
						agentIds.forEach((agentId) => {
							const agent = agentMap.get(normalizeId(agentId));
							decoratedPlan.dates.forEach((calendarDate) => {
								const roomPricingValues = priceVariantValuesForRoom(
									variantSelection,
									basePricingValues,
									{ ...selection, calendarDate, room: rooms[roomIndex] }
								);
								const roomPlan = variantSelection
									? decoratePlanWithPriceVariant(
											buildPricingPlan({
												scope,
												dates: [calendarDate],
												sellingPrice: roomPricingValues.sellingPrice,
												commissionPercent:
													roomPricingValues.commissionPercent,
												status: roomPricingValues.status,
												calendarType,
											}),
											variantSelection
									  )
									: decoratedPlan;
								if (!roomPlan.ok) return;
								nextRows.push(
									buildAgentRow(roomPlan, room, calendarDate, agent)
								);
							});
						});
					}
					rooms[roomIndex].agentPricingRate = mergeAgentCalendarRows(
						room.agentPricingRate,
						nextRows,
						roomDateSet,
						agentSet
					);
					updatedRows += nextRows.length;
				} else {
					const nextRows = explicitRowMode
						? roomRows
								.map((row) => {
									const rowPlan = buildPricingPlan({
										scope,
										dates: [row.calendarDate],
										sellingPrice: row.sellingPrice,
										commissionPercent: row.commissionPercent,
										status: row.status,
										calendarType,
									});
									return rowPlan.ok
										? buildGeneralRow(rowPlan, room, row.calendarDate)
										: null;
								})
								.filter(Boolean)
						: decoratedPlan.dates.map((calendarDate) =>
								buildGeneralRow(decoratedPlan, room, calendarDate)
						  );
					rooms[roomIndex].pricingRate = mergeGeneralCalendarRows(
						room.pricingRate,
						nextRows,
						roomDateSet
					);
					updatedRows += nextRows.length;
				}
			});
			hotel.roomCountDetails = rooms;
			hotel.markModified("roomCountDetails");
			await hotel.save();
			updatedHotels.push(serializeCalendarHotel(hotelMap.get(hotelId) || hotel));
		}

		const variantPropagation =
			scope === "general"
				? await propagateCalendarBasePricingVariants({ hotelIds })
				: { variantDocs: 0, updatedRows: 0, updatedHotels: 0 };

		const assignedPriceVariant =
			scope === "agents" && variantSelection
				? await recordPriceVariantAssignments({
						selection: variantSelection,
						agentDocs,
						hotelIds,
						actor: context.actor,
				  })
				: null;

		return res.json({
			ok: true,
			scope,
			operation: pricingOperation,
			updatedRows,
			updatedHotels,
			priceVariant: variantSelection
				? {
						priceVariantDataId: variantSelection.priceVariantDataId,
						priceVariantItemId: variantSelection.priceVariantItemId,
						name: variantSelection.item?.name || "",
						assignedAgents: agentIds.length,
				  }
				: null,
			priceVariantData: assignedPriceVariant
				? serializePriceVariant(assignedPriceVariant, hotelMap)
				: null,
			summary: {
				days: explicitRowMode
					? new Set(explicitRows.map((row) => row.calendarDate)).size
					: decoratedPlan.dates.length,
				rows: explicitRowMode ? explicitRows.length : undefined,
				rooms: roomSelections.length,
				agents: scope === "agents" ? agentIds.length : 0,
				sellingPrice: decoratedPlan?.sellingPrice ?? null,
				rootPrice: decoratedPlan?.rootPrice ?? null,
				commissionPercent: decoratedPlan?.commissionPercent ?? null,
				blocked: decoratedPlan?.blocked ?? null,
				variantPropagation,
			},
		});
	} catch (error) {
		console.error("saveOverallCalendarPricing error:", error);
		return res.status(500).json({ error: "Could not save calendar pricing" });
	}
};

exports.overallSettings = async (req, res) => {
	try {
		const section =
			String(req.query?.purpose || "").toLowerCase() === "hotel-map"
				? "hotel-map"
				: "settings";
		const context = await requireOverallSection(req, res, section);
		if (!context) return;
		const hotels = context.hotels.map((hotel) => ({
			_id: normalizeId(hotel._id),
			hotelName: hotel.hotelName || "Hotel",
			ownerId: normalizeId(hotel.belongsTo),
			ownerName: hotel.belongsTo?.name || "",
			hotelAddress: hotel.hotelAddress || "",
			hotelCity: hotel.hotelCity || "",
			hotelState: hotel.hotelState || "",
			hotelCountry: hotel.hotelCountry || "",
			activateHotel:
				hotel.activateHotel === true && hotel.xHotelProActive !== false,
			ownerActivatedHotel: hotel.activateHotel === true,
			xHotelProActive: hotel.xHotelProActive !== false,
			overallRoomsCount: hotel.overallRoomsCount || 0,
			roomTypes: Array.isArray(hotel.roomCountDetails)
				? hotel.roomCountDetails.length
				: 0,
			photos: Array.isArray(hotel.hotelPhotos) ? hotel.hotelPhotos.length : 0,
			setup: setupSnapshot(hotel),
			createdAt: hotel.createdAt,
			updatedAt: hotel.updatedAt,
		}));
		return res.json({
			total: hotels.length,
			hotels,
		});
	} catch (error) {
		console.error("overallSettings error:", error);
		return res.status(500).json({ error: "Could not load overall settings" });
	}
};
