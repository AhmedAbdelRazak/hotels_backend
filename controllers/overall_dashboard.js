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
const {
	buildHotelInventoryCalendarPayload,
	buildHotelInventoryDayPayload,
} = require("./hotel_inventory");
const {
	buildPendingConfirmationExclusionFilter,
} = require("../services/reservationStatus");
const {
	trackFinancialReportExport,
	trackReservationExport,
	trackReservationSummaryExport,
	trackAccountCreation,
	trackAccountUpdate,
} = require("../services/activityTracker");

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
const FINISHED_HOUSEKEEPING_STATUS = /finished|done|completed|clean/i;
const PENDING_FINANCE_REVIEW_STATUS = /pending[-_\s]?finance[-_\s]?review/i;
const PENDING_AGENT_COMMISSION_STATUS =
	/pending[-_\s]?agent[-_\s]?commission[-_\s]?approval/i;
const FINANCE_REJECTED_STATUS = /finance[-_\s]?rejected/i;
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
		.filter(Boolean)
		.map((id) => String(id).trim());

const isConfiguredSuperAdmin = (userOrId) => {
	const userId =
		typeof userOrId === "object" ? userOrId?._id || userOrId?.id : userOrId;
	return configuredSuperAdminIds().includes(String(userId || "").trim());
};

const roleNumbers = (user = {}) => [
	Number(user.role),
	...(Array.isArray(user.roles) ? user.roles.map(Number) : []),
];

const roleDescriptions = (user = {}) => [
	String(user.roleDescription || "").toLowerCase(),
	...(Array.isArray(user.roleDescriptions)
		? user.roleDescriptions.map((item) => String(item || "").toLowerCase())
		: []),
];

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

const cleanDateRange = ({ dateFrom = "", dateTo = "", range = "all" } = {}) => {
	if (dateFrom || dateTo) {
		const start = dateFrom ? new Date(`${dateFrom}T00:00:00.000Z`) : null;
		const end = dateTo ? new Date(`${dateTo}T23:59:59.999Z`) : null;
		return {
			from: start && !Number.isNaN(start.getTime()) ? start : null,
			to: end && !Number.isNaN(end.getTime()) ? end : null,
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
		activeHotel: !!hotel?.activateHotel,
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
	return plain;
};

const getActor = (req) => req.profile || null;

const getRequestedOwnerHotelFilter = async (ownerId = "") => {
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
		const ownerFilter = await getRequestedOwnerHotelFilter(normalizeId(query.ownerId));
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
			"_id hotelName belongsTo hotelAddress hotelCountry hotelState hotelCity roomCountDetails overallRoomsCount hotelPhotos location aboutHotel aboutHotelArabic paymentSettings activateHotel createdAt updatedAt"
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
			hasAnyRole([3000, 6000, 8000]) ||
			hasAnyDescription([
				"hotelmanager",
				"reception",
				"finance",
				"reservationemployee",
			])
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

	return {
		$and: [
			newReservationProcessFilter(),
			...(scope === "commission" ? [pendingFinanceWorkflowReadyFilter()] : []),
			{ $or: reasonFilters },
		],
	};
};

const buildReservationMatch = ({ actor, hotels, query = {}, pendingOnly = false }) => {
	const hotelIds = filterHotelIdsForQuery(hotels, query.hotelId);
	if (!hotelIds.length) return null;

	const match = { hotelId: { $in: hotelIds.map((id) => ObjectId(id)) } };
	applyDateFilter(match, query);

	const clauses = [];
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
	if (pendingOnly) {
		clauses.push(pendingWorkflowFilterForActor(actor));
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

const listReservations = async ({ actor, hotels, query, pendingOnly = false }) => {
	const match = buildReservationMatch({ actor, hotels, query, pendingOnly });
	if (!match) {
		return {
			page: 1,
			limit: 0,
			total: 0,
			pages: 0,
			reservations: [],
			hotels,
			bookingSources: [],
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
	const bookingSourceMatch = pendingOnly
		? buildReservationMatch({
				actor,
				hotels,
				query: { ...query, bookingSource: "" },
				pendingOnly,
		  })
		: null;

	const [countResult, rows, bookingSources] = await Promise.all([
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
		pendingOnly ? bookingSourceOptionsFromMatch(bookingSourceMatch) : [],
	]);
	const total = countResult?.[0]?.total || 0;
	return {
		page: exportAll ? 1 : page,
		limit: exportAll ? total : limit,
		total,
		pages: exportAll ? 1 : Math.ceil(total / limit),
		reservations: rows,
		hotels,
		bookingSources,
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

const executiveGroupTotals = () => ({
	reservationsCount: { $sum: 1 },
	total_amount: { $sum: { $ifNull: ["$total_amount", 0] } },
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

const summaryOperationalReservationFilter = () => ({
	$nor: [
		{ reservation_status: CANCELLED_STATUS },
		{ state: CANCELLED_STATUS },
		{ reservation_status: NO_SHOW_STATUS },
		{ state: NO_SHOW_STATUS },
		{ reservation_status: PENDING_CONFIRMATION_STATUS },
		{ state: PENDING_CONFIRMATION_STATUS },
	],
	$and: [buildPendingConfirmationExclusionFilter()],
});

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

	const clauses = [];
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
			},
		},
		{
			$project: {
				_id: 0,
				reservationsCount: 1,
				total_amount: 1,
				commission: 1,
				paidAmount: 1,
				capturedCount: 1,
				hotelsWithReservations: { $size: "$hotelsWithReservations" },
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
		$and: [executivePaidNonZeroFilter()],
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

	const clauses = [financialActionFilter(query.actionType)];
	if (includeBookingSource && query.bookingSource) {
		clauses.push({
			booking_source: new RegExp(escapeRegex(query.bookingSource), "i"),
		});
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

	const hotelMap = new Map(
		hotels.map((hotel) => [normalizeId(hotel._id), hotel])
	);
	const match = {
		hotelId: { $in: hotelIds.map((id) => ObjectId(id)) },
		source: "agent_claim",
		status: "pending",
		reviewStatus: "pending",
		...walletClaimDateFilter(query),
	};
	if (isOrderTakerOnly(actor)) {
		const actorId = normalizeId(actor._id);
		if (!ObjectId.isValid(actorId)) {
			return { page, limit, total: 0, pages: 0, transactions: [] };
		}
		match.agentId = ObjectId(actorId);
	}
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
			const hotel = hotelMap.get(normalizeId(transaction.hotelId)) || {};
			return {
				...transaction,
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

const listFinancialActions = async ({ actor, hotels, query = {} }) => {
	const match = buildFinancialActionsMatch({ actor, hotels, query });
	const walletClaims = await listPendingWalletFinanceActions({ actor, hotels, query });
	if (!match) {
		return {
			page: 1,
			limit: 0,
			total: 0,
			pages: 0,
			reservations: [],
			walletClaims,
			hotels,
			bookingSources: [],
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
	return {
		page: pageForQuery,
		limit,
		total,
		pages: Math.ceil(total / limit),
		hotels,
		bookingSources,
		walletClaims,
		reservations: rows.map((reservation) => ({
			...reservation,
			financialActionReasons: financialActionReasons(reservation),
		})),
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
		const startOfDay = new Date(now);
		startOfDay.setHours(0, 0, 0, 0);
		const endOfDay = new Date(now);
		endOfDay.setHours(23, 59, 59, 999);

		const reservationMatch = { hotelId: { $in: hotelIds } };
		const dateFilter = {};
		if (period.from) dateFilter.$gte = period.from;
		if (period.to) dateFilter.$lte = period.to;
		if (Object.keys(dateFilter).length) reservationMatch[dateField] = dateFilter;

		const statusValues = parseQueryList(req.query?.status).filter(
			(status) => String(status || "").trim().toLowerCase() !== "all"
		);
		const hasExplicitStatus = statusValues.length > 0;
		const summaryClauses = [];
		const statusFilter = reservationStatusFilter(req.query?.status);
		if (hasExplicitStatus && statusFilter) {
			summaryClauses.push(statusFilter);
		} else if (String(req.query?.includeCancelled || "").toLowerCase() !== "true") {
			summaryClauses.push(summaryOperationalReservationFilter());
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

		const pendingReservationMatch = {
			hotelId: { $in: hotelIds },
			$and: [
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
			todayReservations,
			reservationStats,
			pendingReservations,
			housekeepingStats,
			activeAccounts,
			bookingSources,
		] = await Promise.all([
			Rooms.find({ hotelId: { $in: hotelIds } })
				.select("_id hotelId active activeRoom")
				.lean()
				.exec(),
			Reservations.find({
				hotelId: { $in: hotelIds },
				checkin_date: { $lte: endOfDay },
				checkout_date: { $gte: startOfDay },
				reservation_status: { $not: DONE_RESERVATION_STATUS },
				...buildPendingConfirmationExclusionFilter(),
			})
				.select("hotelId roomId")
				.lean()
				.exec(),
			Reservations.aggregate([
				{ $match: reservationMatch },
				{
					$group: {
						_id: "$hotelId",
						totalReservations: { $sum: 1 },
						totalAmount: { $sum: { $ifNull: ["$total_amount", 0] } },
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
						totalAmount: { $sum: { $ifNull: ["$total_amount", 0] } },
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

		const occupiedByHotel = new Map();
		todayReservations.forEach((reservation) => {
			const hotelId = normalizeId(reservation.hotelId);
			if (!occupiedByHotel.has(hotelId)) occupiedByHotel.set(hotelId, new Set());
			extractReservationRoomIds(reservation.roomId).forEach((roomId) =>
				occupiedByHotel.get(hotelId).add(roomId)
			);
		});

		const reservationStatsByHotel = new Map(
			reservationStats.map((item) => [normalizeId(item._id), item])
		);
		const pendingByHotel = new Map(
			pendingReservations.map((item) => [normalizeId(item._id), item.total])
		);
		const housekeepingByHotel = new Map(
			housekeepingStats.map((item) => [normalizeId(item._id), item])
		);

		const hotelSummaries = selectedHotels.map((hotel) => {
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
				acc.availableRooms += hotel.availableRooms;
				acc.occupiedRooms += hotel.occupiedRooms;
				acc.totalReservations += hotel.totalReservations;
				acc.activeReservations += hotel.activeReservations;
				acc.totalAmount += hotel.totalAmount;
				acc.pendingReservations += hotel.pendingReservations;
				acc.openHousekeepingTasks += hotel.openHousekeepingTasks;
				return acc;
			},
			{
				totalHotels: visibleHotelSummaries.length,
				totalRooms: 0,
				availableRooms: 0,
				occupiedRooms: 0,
				totalReservations: 0,
				activeReservations: 0,
				totalAmount: 0,
				pendingReservations: 0,
				openHousekeepingTasks: 0,
				activeAccounts,
			}
		);

		return res.json({
			asOf: now,
			actor: {
				_id: normalizeId(actor._id),
				role: actor.role,
				roleDescription: actor.roleDescription || "",
			},
			period: { ...period, dateBy: dateField },
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
		const reservationClauses = [];
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
					"hotelId roomId total_rooms pickedRoomsType checkin_date checkout_date total_amount reservation_status state"
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
			hotelRow.totalAmount += moneyNumber(reservation.total_amount);

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
							totalAmount: { $sum: { $ifNull: ["$total_amount", 0] } },
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

		const data = reservations.map((reservation) => {
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
					"_id name email emailIsPlaceholder phone companyName companyOfficialName companyEin companyDocuments agentCommercialModel agentOpeningWalletCredit agentWalletOpeningBalances agentApproval applicationReview role roleDescription roles roleDescriptions activeUser hotelIdWork hotelIdsWork belongsToId hotelsToSupport hotelIdsOwner accessTo createdAt updatedAt"
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
			activateHotel: !!hotel.activateHotel,
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
