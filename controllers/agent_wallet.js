/** @format */

"use strict";

const mongoose = require("mongoose");
const cloudinary = require("cloudinary");
const AgentWallet = require("../models/agent_wallet");
const Reservations = require("../models/reservations");
const User = require("../models/user");
const HotelDetails = require("../models/hotel_details");
const ActivityTracker = require("../models/activity_tracker");
const { emitHotelNotificationRefresh } = require("../services/notificationEvents");

const ObjectId = mongoose.Types.ObjectId;

cloudinary.config({
	cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
	api_key: process.env.CLOUDINARY_API_KEY,
	api_secret: process.env.CLOUDINARY_API_SECRET,
});

const configuredSuperAdminIds = () =>
	[process.env.SUPER_ADMIN_ID, process.env.REACT_APP_SUPER_ADMIN_ID]
		.flatMap((value) => String(value || "").split(","))
		.map((id) => String(id).trim())
		.filter(Boolean);

const normalizeId = (value) => {
	if (!value) return "";
	if (typeof value === "object") return String(value._id || value.id || "");
	return String(value);
};

const includesId = (values = [], id) =>
	(Array.isArray(values) ? values : [])
		.map(normalizeId)
		.filter(Boolean)
		.includes(String(id || ""));

const roleNumbers = (user = {}) => {
	const account = user || {};
	return [
		...new Set([account.role, ...(Array.isArray(account.roles) ? account.roles : [])]
			.map(Number)
			.filter(Boolean)),
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

const hasRole = (user, role) => roleNumbers(user).includes(Number(role));
const hasRoleDescription = (user, description) =>
	roleDescriptions(user).includes(String(description || "").toLowerCase());

const isSuperAdmin = (user = {}) =>
	configuredSuperAdminIds().includes(normalizeId(user._id));

const isPlatformAdmin = (user = {}) =>
	isSuperAdmin(user) ||
	hasRole(user, 1000) ||
	hasRoleDescription(user, "superadmin") ||
	hasRoleDescription(user, "super admin");

const isOrderTaker = (user = {}) =>
	hasRole(user, 7000) ||
	hasRoleDescription(user, "ordertaker") ||
	(Array.isArray(user.accessTo) && user.accessTo.includes("ownReservations"));

const actorSelect =
	"_id name email companyName phone agentCommercialModel agentOpeningWalletCredit agentWalletOpeningBalances role roleDescription roles roleDescriptions accessTo hotelIdWork hotelIdsWork belongsToId hotelsToSupport hotelIdsOwner activeUser";

const getActor = async (req, fallbackUserId) => {
	const actorId = req.auth?._id || fallbackUserId;
	if (!actorId || !ObjectId.isValid(actorId)) return null;
	return User.findById(actorId).select(actorSelect).lean().exec();
};

const getHotel = async (hotelId) => {
	if (!ObjectId.isValid(hotelId)) return null;
	return HotelDetails.findById(hotelId)
		.select("_id hotelName belongsTo")
		.lean()
		.exec();
};

const uniqueValidIds = (values = []) => [
	...new Set(
		(Array.isArray(values) ? values : [values])
			.map(normalizeId)
			.filter((id) => id && ObjectId.isValid(id))
	),
];

const toObjectIds = (values = []) => uniqueValidIds(values).map((id) => ObjectId(id));

const userHotelScopeIds = (user = {}) =>
	uniqueValidIds([
		user.hotelIdWork,
		...(Array.isArray(user.hotelIdsWork) ? user.hotelIdsWork : []),
		...(Array.isArray(user.hotelIdsOwner) ? user.hotelIdsOwner : []),
		...(Array.isArray(user.hotelsToSupport) ? user.hotelsToSupport : []),
	]);

const applyOwnerScopeToHotelQuery = (query = {}, ownerId = "") => {
	const scopedOwnerId = normalizeId(ownerId);
	if (!ObjectId.isValid(scopedOwnerId)) return query;
	return {
		$and: [query, { belongsTo: ObjectId(scopedOwnerId) }],
	};
};

const getAccessibleWalletHotels = async (actor = {}, query = {}) => {
	if (!actor || actor.activeUser === false) return [];
	const requestedOwnerId = normalizeId(query.ownerId);

	if (isPlatformAdmin(actor)) {
		return HotelDetails.find(
			applyOwnerScopeToHotelQuery({}, requestedOwnerId)
		)
			.select("_id hotelName belongsTo")
			.lean()
			.exec();
	}

	const actorId = normalizeId(actor._id);
	if (hasRole(actor, 2000) && actorId && !normalizeId(actor.belongsToId)) {
		const scopedIds = toObjectIds([
			...(Array.isArray(actor.hotelIdsOwner) ? actor.hotelIdsOwner : []),
			...(Array.isArray(actor.hotelsToSupport) ? actor.hotelsToSupport : []),
		]);
		return HotelDetails.find(applyOwnerScopeToHotelQuery({
			$or: [
				{ belongsTo: ObjectId(actorId) },
				...(scopedIds.length ? [{ _id: { $in: scopedIds } }] : []),
			],
		}, requestedOwnerId))
			.select("_id hotelName belongsTo")
			.lean()
			.exec();
	}

	const scopedIds = toObjectIds(userHotelScopeIds(actor));
	if (!scopedIds.length) return [];
	return HotelDetails.find(
		applyOwnerScopeToHotelQuery({ _id: { $in: scopedIds } }, requestedOwnerId)
	)
		.select("_id hotelName belongsTo")
		.lean()
		.exec();
};

const hotelIdsFromHotels = (hotels = []) =>
	uniqueValidIds((Array.isArray(hotels) ? hotels : []).map((hotel) => hotel?._id));

const hotelMapFromHotels = (hotels = []) =>
	(Array.isArray(hotels) ? hotels : []).reduce((map, hotel) => {
		const id = normalizeId(hotel?._id);
		if (id) map.set(id, hotel);
		return map;
	}, new Map());

const ownerIdForWalletContext = (actor = {}, hotels = []) => {
	const actorId = normalizeId(actor._id);
	if (hasRole(actor, 2000) && actorId && !normalizeId(actor.belongsToId)) {
		return actorId;
	}
	const ownerIds = [
		...new Set(
			(Array.isArray(hotels) ? hotels : [])
				.map((hotel) => normalizeId(hotel?.belongsTo))
				.filter(Boolean)
		),
	];
	return ownerIds.length === 1 ? ownerIds[0] : "";
};

const canAccessHotelFinancials = (actor = {}, hotel = {}) => {
	if (!actor || actor.activeUser === false || !hotel?._id) return false;
	const hotelId = normalizeId(hotel._id);
	const ownerId = normalizeId(hotel.belongsTo);
	const actorId = normalizeId(actor._id);

	if (isPlatformAdmin(actor)) return true;
	if (actorId === ownerId && hasRole(actor, 2000)) return true;
	if (includesId(actor.hotelIdsOwner, hotelId)) return true;
	if (includesId(actor.hotelsToSupport, hotelId)) return true;
	if (normalizeId(actor.hotelIdWork) === hotelId) return true;

	return false;
};

const canManageHotelFinancials = (actor = {}, hotel = {}) => {
	if (!canAccessHotelFinancials(actor, hotel)) return false;
	if (isPlatformAdmin(actor)) return true;
	if (
		hasRole(actor, 2000) ||
		hasRole(actor, 10000) ||
		hasRoleDescription(actor, "hotelmanager") ||
		hasRoleDescription(actor, "systemadmin") ||
		hasRoleDescription(actor, "system admin")
	) return true;
	if (hasRole(actor, 6000) || hasRoleDescription(actor, "finance")) return true;
	return false;
};

const canOverrideApprovedFinancials = (actor = {}, hotel = {}) => {
	if (!canAccessHotelFinancials(actor, hotel)) return false;
	return (
		isPlatformAdmin(actor) ||
		hasRole(actor, 2000) ||
		hasRole(actor, 10000) ||
		hasRoleDescription(actor, "hotelmanager") ||
		hasRoleDescription(actor, "systemadmin") ||
		hasRoleDescription(actor, "system admin")
	);
};

const canManageRole = (actor = {}) =>
	isPlatformAdmin(actor) ||
	hasRole(actor, 2000) ||
	hasRole(actor, 10000) ||
	hasRoleDescription(actor, "hotelmanager") ||
	hasRoleDescription(actor, "systemadmin") ||
	hasRoleDescription(actor, "system admin") ||
	hasRole(actor, 6000) ||
	hasRoleDescription(actor, "finance");

const canReadAgentWalletRole = (actor = {}) =>
	canManageRole(actor) ||
	hasRole(actor, 8000) ||
	hasRoleDescription(actor, "reservationemployee");

const actorCanSeeAgent = (actor = {}, agentId = "") =>
	canReadAgentWalletRole(actor) ||
	normalizeId(actor._id) === normalizeId(agentId);

const buildAgentRoleQuery = () => ({
	activeUser: { $ne: false },
	$or: [
		{ role: 7000 },
		{ roles: 7000 },
		{ roleDescription: "ordertaker" },
		{ roleDescriptions: "ordertaker" },
	],
});

const buildAgentHotelAssignmentClause = (hotelIds = []) => {
	const ids = uniqueValidIds(hotelIds);
	const objectIds = toObjectIds(ids);
	if (!ids.length) return {};
	return {
		$or: [
			{ hotelIdWork: { $in: ids } },
			...(objectIds.length
				? [
						{ hotelIdWork: { $in: objectIds } },
						{ hotelIdsWork: { $in: objectIds } },
						{ hotelsToSupport: { $in: objectIds } },
						{ hotelIdsOwner: { $in: objectIds } },
				  ]
				: []),
		],
	};
};

const buildAgentWalletScopeQuery = (hotelIds = [], actor = {}) => {
	const roleQuery = buildAgentRoleQuery();
	if (isPlatformAdmin(actor)) return roleQuery;
	const assignmentClause = buildAgentHotelAssignmentClause(hotelIds);
	if (!Object.keys(assignmentClause).length) {
		return { ...roleQuery, _id: { $exists: false } };
	}
	return {
		activeUser: roleQuery.activeUser,
		$and: [{ $or: roleQuery.$or }, assignmentClause],
	};
};

const agentAssignedHotelIds = (agent = {}) =>
	userHotelScopeIds(agent);

const agentOverlapsHotelScope = (agent = {}, hotelIds = []) => {
	const allowed = new Set(uniqueValidIds(hotelIds));
	if (!allowed.size) return false;
	return agentAssignedHotelIds(agent).some((id) => allowed.has(id));
};

const actorCanAccessAgentInScope = (actor = {}, agent = {}, hotelIds = []) => {
	const agentId = normalizeId(agent?._id || agent);
	if (!actorCanSeeAgent(actor, agentId)) return false;
	if (normalizeId(actor._id) === agentId) return true;
	if (isPlatformAdmin(actor)) return true;
	return agentOverlapsHotelScope(agent, hotelIds);
};

const canManageGlobalWallet = (actor = {}, hotels = []) =>
	Boolean(actor && actor.activeUser !== false && canManageRole(actor)) &&
	(isPlatformAdmin(actor) || hotelIdsFromHotels(hotels).length > 0);

const canOverrideApprovedGlobalFinancials = (actor = {}, hotels = []) =>
	Boolean(actor && actor.activeUser !== false) &&
	(isPlatformAdmin(actor) ||
		hasRole(actor, 2000) ||
		hasRole(actor, 10000) ||
		hasRoleDescription(actor, "hotelmanager") ||
		hasRoleDescription(actor, "systemadmin") ||
		hasRoleDescription(actor, "system admin")) &&
	(isPlatformAdmin(actor) || hotelIdsFromHotels(hotels).length > 0);

const buildAgentReservationMatch = (hotelIds, agentId) => ({
	hotelId: { $in: toObjectIds(hotelIds) },
	$or: [
		{ createdByUserId: ObjectId(agentId) },
		{ orderTakeId: ObjectId(agentId) },
		{ "createdBy._id": String(agentId) },
		{ "orderTaker._id": String(agentId) },
	],
});

const buildDateFilter = (field, startDate, endDate) => {
	const filter = {};
	if (startDate) {
		const start = new Date(startDate);
		if (!Number.isNaN(start.getTime())) filter.$gte = start;
	}
	if (endDate) {
		const end = new Date(endDate);
		if (!Number.isNaN(end.getTime())) {
			end.setHours(23, 59, 59, 999);
			filter.$lte = end;
		}
	}
	return Object.keys(filter).length ? { [field]: filter } : {};
};

const moneyNumber = (value) => {
	if (value === null || value === undefined || value === "") return 0;
	const parsed = Number(String(value).replace(/,/g, "").trim());
	return Number.isFinite(parsed) ? parsed : 0;
};

const n2 = (value) => Number(moneyNumber(value).toFixed(2));

const AGENT_COMMERCIAL_MODELS = new Set([
	"wallet_inventory",
	"commission_only",
	"mixed",
]);

const normalizeAgentCommercialModel = (value) => {
	const normalized = String(value || "").trim().toLowerCase();
	return AGENT_COMMERCIAL_MODELS.has(normalized)
		? normalized
		: "wallet_inventory";
};

const agentOpeningWalletCreditGlobal = (agent = {}) => {
	const balances = Array.isArray(agent.agentWalletOpeningBalances)
		? agent.agentWalletOpeningBalances
		: [];
	const topLevelCredit = n2(agent.agentOpeningWalletCredit);
	if (topLevelCredit) return topLevelCredit;
	const balanceAmounts = balances.map((entry) => n2(entry?.amount)).filter(Boolean);
	return n2(balanceAmounts.length ? Math.max(...balanceAmounts) : 0);
};

const reservationIsDeductible = (reservation = {}) => {
	const status = String(
		reservation.reservation_status || reservation.state || ""
	).toLowerCase();
	return !/(cancelled|canceled|rejected)/i.test(status);
};

const walletTransactionFinancialStatus = (transaction = {}) => {
	const status = String(transaction.status || "").trim().toLowerCase();
	const reviewStatus = String(transaction.reviewStatus || "").trim().toLowerCase();
	if (status === "rejected" || reviewStatus === "rejected") return "rejected";
	if (status === "pending" || reviewStatus === "pending") return "pending";
	if (status === "void") return "void";
	if (
		status === "posted" ||
		reviewStatus === "approved" ||
		reviewStatus === "not_required" ||
		(!status && !reviewStatus)
	) {
		return "accepted";
	}
	return status || reviewStatus || "accepted";
};

const normalizeWalletRejectionType = (body = {}) => {
	const raw = String(
		body.rejectionType ||
			body.rejectType ||
			(body.finalRejection || body.permanentRejection ? "final" : "")
	)
		.trim()
		.toLowerCase()
		.replace(/[\s-]+/g, "_");
	return raw === "final" || raw === "total" || raw === "permanent"
		? "final"
		: "correction_required";
};

const walletTransactionReconciliationEligible = (transaction = {}) =>
	walletTransactionFinancialStatus(transaction) === "accepted";

const decorateWalletTransactionForReport = (transaction = {}) => ({
	...transaction,
	financialStatus: walletTransactionFinancialStatus(transaction),
	reconciliationEligible: walletTransactionReconciliationEligible(transaction),
	correctionAllowed:
		String(transaction.rejectionType || "").toLowerCase() !== "final",
});

const commissionAmount = (reservation = {}) =>
	n2(
		moneyNumber(reservation.commission) ||
			moneyNumber(reservation.financial_cycle?.commissionAmount)
	);

const actorSnapshot = (actor = {}) => ({
	_id: normalizeId(actor._id),
	name: actor.name || actor.email || "",
	email: actor.email || "",
	role: actor.role || "",
	roleDescription: actor.roleDescription || "",
});

const normalizeTrackerRoleKey = (value = "") =>
	String(value || "")
		.toLowerCase()
		.replace(/[\s_-]+/g, "")
		.trim();

const trackerVisibilityForActor = (actor = {}) => {
	const values = [
		actor.role,
		actor.roleDescription,
		...(Array.isArray(actor.roles) ? actor.roles : []),
		...(Array.isArray(actor.roleDescriptions) ? actor.roleDescriptions : []),
	];
	const roleNumbers = values
		.map((role) => Number(role))
		.filter((role) => Number.isFinite(role));
	const roleKeys = values.map(normalizeTrackerRoleKey).filter(Boolean);
	const privileged =
		roleNumbers.some((role) => role === 1000 || role === 10000) ||
		roleKeys.some((role) =>
			[
				"admin",
				"administrator",
				"platformadmin",
				"superadmin",
				"systemadmin",
				"systemadministrator",
			].includes(role)
		);
	return privileged ? "super_admin_only" : "standard";
};

const trackerObjectId = (value) => {
	const normalized = normalizeId(value);
	return ObjectId.isValid(normalized) ? ObjectId(normalized) : null;
};

const requestSnapshot = (req = {}) => ({
	ipAddress: req.ip || req.headers?.["x-forwarded-for"] || "",
	userAgent: req.headers?.["user-agent"] || "",
	method: req.method || "",
	path: req.originalUrl || req.url || "",
});

const trackWalletActivity = async (
	req,
	{
		action,
		description = "",
		actor = {},
		transaction = {},
		hotel = {},
		change = {},
		metadata = {},
	} = {}
) => {
	try {
		const actorDetails = actorSnapshot(actor);
		await ActivityTracker.create({
			action,
			category: "agent_wallet",
			source: "hotel_management",
			description,
			visibility: trackerVisibilityForActor(actorDetails),
			actor: actorDetails,
			entityType: "agent_wallet_transaction",
			entityModel: "AgentWallet",
			entityId: trackerObjectId(transaction?._id),
			hotelId: trackerObjectId(transaction?.hotelId || hotel?._id),
			ownerId: trackerObjectId(transaction?.ownerId || hotel?.belongsTo),
			change,
			metadata: {
				agentId: normalizeId(transaction?.agentId),
				transactionType: transaction?.transactionType || "",
				amount: transaction?.amount || 0,
				status: transaction?.status || "",
				reviewStatus: transaction?.reviewStatus || "",
				source: transaction?.source || "",
				reference: transaction?.reference || "",
				attachmentsCount: Array.isArray(transaction?.attachments)
					? transaction.attachments.length
					: 0,
				...metadata,
			},
			request: requestSnapshot(req),
		});
	} catch (error) {
		console.error("trackWalletActivity error:", error);
	}
};

const allowedTransactionTypes = ["deposit", "debit", "adjustment", "refund"];

const normalizeTransactionType = (value) =>
	allowedTransactionTypes.includes(String(value || "").toLowerCase())
		? String(value).toLowerCase()
		: "deposit";

const parseTransactionDate = (value) => {
	if (!value) return new Date();
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
};

const maxWalletAttachments = 8;
const maxWalletAttachmentBytes = 10 * 1024 * 1024;
const maxWalletAttachmentTotalBytes = 32 * 1024 * 1024;
const walletAttachmentTypes = new Set([
	"application/pdf",
	"image/jpeg",
	"image/jpg",
	"image/png",
	"image/webp",
]);

const cleanFileName = (value = "") =>
	String(value || "wallet-attachment")
		.replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
		.trim()
		.slice(0, 140) || "wallet-attachment";

const dataUrlMimeType = (value = "") => {
	const match = String(value).match(/^data:([^;]+);base64,/i);
	return match ? match[1].toLowerCase() : "";
};

const base64ByteSize = (value = "") => {
	const raw = String(value).split(",").pop() || "";
	const clean = raw.replace(/\s/g, "");
	return Math.ceil((clean.length * 3) / 4);
};

const normalizeExistingAttachment = (item = {}) => {
	if (!item.url || !item.public_id) return null;
	return {
		public_id: String(item.public_id || ""),
		url: String(item.url || ""),
		fileName: cleanFileName(item.fileName || "Attachment"),
		fileType: String(item.fileType || "").toLowerCase(),
		fileSize: moneyNumber(item.fileSize),
		uploadedAt: item.uploadedAt || new Date(),
		uploadedBy: item.uploadedBy || null,
	};
};

const uploadWalletAttachment = async (item = {}, actor = {}) => {
	const existing = normalizeExistingAttachment(item);
	if (existing && !item.data) return existing;

	const data = String(item.data || "");
	if (!data) return null;

	const mimeType = String(item.fileType || dataUrlMimeType(data) || "")
		.toLowerCase()
		.trim();

	if (!walletAttachmentTypes.has(mimeType)) {
		throw new Error("Only PDF and image attachments are allowed.");
	}

	const fileSize = moneyNumber(item.fileSize) || base64ByteSize(data);
	if (fileSize > maxWalletAttachmentBytes) {
		throw new Error("Each wallet attachment must be 10MB or smaller.");
	}

	const response = await cloudinary.v2.uploader.upload(data, {
		folder: "janat/wallet-attachments",
		resource_type: "auto",
		use_filename: true,
		unique_filename: true,
	});

	return {
		public_id: response.public_id,
		url: response.secure_url,
		fileName: cleanFileName(item.fileName || response.original_filename || ""),
		fileType: mimeType,
		fileSize,
		uploadedAt: new Date(),
		uploadedBy: actorSnapshot(actor),
	};
};

const buildWalletAttachments = async (items = [], actor = {}) => {
	const list = Array.isArray(items) ? items : [];
	if (list.length > maxWalletAttachments) {
		throw new Error(`You can attach up to ${maxWalletAttachments} files.`);
	}
	const totalSize = list.reduce(
		(sum, item) =>
			sum + (moneyNumber(item.fileSize) || (item.data ? base64ByteSize(item.data) : 0)),
		0
	);
	if (totalSize > maxWalletAttachmentTotalBytes) {
		throw new Error("Wallet attachments must be 32MB total or smaller.");
	}
	const attachments = await Promise.all(
		list.map((item) => uploadWalletAttachment(item, actor))
	);
	return attachments.filter(Boolean);
};

const hotelsForAgentInScope = (agent = {}, hotels = []) => {
	const assigned = new Set(agentAssignedHotelIds(agent));
	const scoped = Array.isArray(hotels) ? hotels : [];
	const matched = scoped.filter((hotel) => assigned.has(normalizeId(hotel?._id)));
	return matched.length ? matched : scoped.slice(0, 1);
};

const emitWalletNotificationRefresh = async (req, hotels = [], payload = {}) => {
	const targets = Array.isArray(hotels) ? hotels : [];
	await Promise.all(
		targets.map((hotel) =>
			emitHotelNotificationRefresh(req, hotel?._id, {
				...payload,
				ownerId: payload.ownerId || hotel?.belongsTo,
				walletScope: "agent_global",
			})
		)
	);
};

const calculateAgentWalletSummary = async ({
	agent,
	hotelIds = [],
	hotels = [],
	startDate,
	endDate,
}) => {
	const agentId = normalizeId(agent._id);
	const scopeHotelIds = uniqueValidIds(hotelIds);
	const scopeHotelMap = hotelMapFromHotels(hotels);
	const walletDateFilter = buildDateFilter("transactionDate", startDate, endDate);
	const reservationDateFilter = Object.keys(
		buildDateFilter("createdAt", startDate, endDate)
	).length
		? {
				$or: [
					buildDateFilter("booked_at", startDate, endDate),
					{
						booked_at: { $in: [null, ""] },
						...buildDateFilter("createdAt", startDate, endDate),
					},
				],
		  }
		: {};

	const walletDisplayMatch = {
		agentId: ObjectId(agentId),
		status: { $ne: "void" },
	};
	const walletPostedMatch = {
		agentId: ObjectId(agentId),
		status: { $nin: ["pending", "rejected", "void"] },
		reviewStatus: { $nin: ["pending", "rejected"] },
		$or: [
			{ status: "posted" },
			{ status: { $exists: false } },
			{ status: null },
			{ status: "" },
		],
	};
	const reservationBaseMatch = buildAgentReservationMatch(scopeHotelIds, agentId);

	const [transactions, reservations, allTransactions, allReservations] =
		await Promise.all([
			AgentWallet.find({
				...walletDisplayMatch,
				...walletDateFilter,
			})
			.sort({ transactionDate: -1, createdAt: -1 })
			.lean()
			.exec(),
			Reservations.find({
				...reservationBaseMatch,
				...reservationDateFilter,
			})
			.select(
				"_id hotelId confirmation_number customer_details.name booking_source booked_at createdAt checkin_date checkout_date reservation_status state total_amount commission commissionPaid commissionStatus commissionAgentApproval financial_cycle pendingConfirmation"
			)
				.sort({ booked_at: -1, createdAt: -1 })
				.lean()
				.exec(),
			AgentWallet.find(walletPostedMatch).lean().exec(),
			Reservations.find(reservationBaseMatch)
				.select(
					"_id hotelId reservation_status state total_amount commission commissionPaid commissionAgentApproval financial_cycle pendingConfirmation"
				)
				.lean()
				.exec(),
		]);

	const transactionTotals = allTransactions.reduce(
		(acc, tx) => {
			const amount = n2(tx.amount);
			if (tx.transactionType === "deposit" || tx.transactionType === "refund") {
				acc.credits += amount;
			} else if (tx.transactionType === "debit") {
				acc.manualDebits += amount;
			} else {
				acc.adjustments += amount;
			}
			return acc;
		},
		{ credits: 0, manualDebits: 0, adjustments: 0 }
	);

	const reservationTotals = allReservations.reduce(
		(acc, reservation) => {
			const amount = n2(reservation.total_amount);
			const commission = commissionAmount(reservation);
			const status = String(
				reservation.reservation_status || reservation.state || ""
			).toLowerCase();

			acc.totalReservations += 1;
			acc.totalReservationValue += amount;
			acc.totalCommission += commission;
			if (reservationIsDeductible(reservation)) {
				acc.walletDeducted += amount;
			}
			if (/pending/.test(status)) acc.pendingConfirmation += 1;
			if (reservation.commissionPaid) acc.commissionPaid += commission;
			return acc;
		},
		{
			totalReservations: 0,
			totalReservationValue: 0,
			walletDeducted: 0,
			totalCommission: 0,
			commissionPaid: 0,
			pendingConfirmation: 0,
		}
	);

	const commercialModel = normalizeAgentCommercialModel(
		agent.agentCommercialModel
	);
	const isCommissionOnly = commercialModel === "commission_only";
	const openingWalletCredit = agentOpeningWalletCreditGlobal(agent);
	const reservationWalletDeducted = isCommissionOnly
		? 0
		: reservationTotals.walletDeducted;

	const walletAdded = n2(
		openingWalletCredit + transactionTotals.credits + transactionTotals.adjustments
	);
	const walletUsed = n2(reservationWalletDeducted + transactionTotals.manualDebits);
	const balance = n2(walletAdded - walletUsed);
	const decoratedTransactions = transactions.map((transaction) => {
		const txHotelId = normalizeId(transaction.hotelId || transaction.legacyHotelId);
		const txHotel = scopeHotelMap.get(txHotelId) || {};
		return decorateWalletTransactionForReport({
			...transaction,
			hotelId: normalizeId(transaction.hotelId),
			legacyHotelId: normalizeId(transaction.legacyHotelId),
			hotelName: txHotel.hotelName || (txHotelId ? "" : "General wallet"),
		});
	});
	const decoratedReservations = reservations.map((reservation) => {
		const reservationHotelId = normalizeId(reservation.hotelId);
		const hotel = scopeHotelMap.get(reservationHotelId) || {};
		return {
			...reservation,
			hotelId: reservationHotelId,
			hotelName: hotel.hotelName || "",
		};
	});
	const pendingWalletClaims = decoratedTransactions.filter(
		(tx) => tx.source === "agent_claim" && tx.status === "pending"
	);
	const rejectedWalletClaims = decoratedTransactions.filter(
		(tx) => tx.source === "agent_claim" && tx.status === "rejected"
	);

	return {
		agent: {
			_id: agentId,
			name: agent.name || agent.email || "",
			email: agent.email || "",
			phone: agent.phone || "",
			companyName: agent.companyName || "",
			agentCommercialModel: commercialModel,
			agentOpeningWalletCredit: openingWalletCredit,
			agentPayoutDetails: agent.agentPayoutDetails || {},
			assignedHotelIds: agentAssignedHotelIds(agent),
		},
		commercialModel,
		openingWalletCredit,
		walletRequired: !isCommissionOnly,
		walletAdded,
		walletUsed,
		balance,
		manualDebits: n2(transactionTotals.manualDebits),
		totalReservations: reservationTotals.totalReservations,
		totalReservationValue: n2(reservationTotals.totalReservationValue),
		walletDeducted: n2(reservationWalletDeducted),
		reservationValueNotWalletDeducted: n2(
			reservationTotals.walletDeducted - reservationWalletDeducted
		),
		totalCommission: n2(reservationTotals.totalCommission),
		commissionPaid: n2(reservationTotals.commissionPaid),
		commissionDue: n2(
			reservationTotals.totalCommission - reservationTotals.commissionPaid
		),
		pendingConfirmation: reservationTotals.pendingConfirmation,
		pendingWalletClaims: pendingWalletClaims.length,
		pendingWalletClaimAmount: n2(
			pendingWalletClaims.reduce((sum, tx) => sum + moneyNumber(tx.amount), 0)
		),
		rejectedWalletClaims: rejectedWalletClaims.length,
		rejectedWalletClaimAmount: n2(
			rejectedWalletClaims.reduce((sum, tx) => sum + moneyNumber(tx.amount), 0)
		),
		transactions: decoratedTransactions,
		reservations: decoratedReservations,
	};
};

exports.agentWalletSummary = async (req, res) => {
	try {
		const { userId } = req.params;
		const { agentId = "", startDate = "", endDate = "" } = req.query || {};

		const actor = await getActor(req, userId);
		const scopeHotels = await getAccessibleWalletHotels(actor, req.query);
		const scopeHotelIds = hotelIdsFromHotels(scopeHotels);

		if (!actor || actor.activeUser === false) {
			return res.status(403).json({ error: "Access denied" });
		}
		if (!scopeHotelIds.length && !isPlatformAdmin(actor)) {
			return res.status(403).json({ error: "No wallet hotel scope is available" });
		}

		const requestedAgentId = normalizeId(agentId);
		let agents = [];
		if (isOrderTaker(actor) && !canManageRole(actor)) {
			agents = [actor];
		} else if (requestedAgentId) {
			if (!ObjectId.isValid(requestedAgentId)) {
				return res.status(400).json({ error: "Invalid agent id" });
			}
			const agent = await User.findOne({
				_id: ObjectId(requestedAgentId),
				...buildAgentRoleQuery(),
			})
				.select(
					"_id name email phone companyName agentCommercialModel agentOpeningWalletCredit agentWalletOpeningBalances agentPayoutDetails hotelIdWork hotelIdsWork hotelsToSupport hotelIdsOwner"
				)
				.lean()
				.exec();
			if (
				!agent ||
				!actorCanAccessAgentInScope(actor, agent, scopeHotelIds)
			) {
				return res.status(403).json({ error: "Agent access denied" });
			}
			agents = [agent];
		} else {
			agents = await User.find(buildAgentWalletScopeQuery(scopeHotelIds, actor))
				.select(
					"_id name email phone companyName agentCommercialModel agentOpeningWalletCredit agentWalletOpeningBalances agentPayoutDetails hotelIdWork hotelIdsWork hotelsToSupport hotelIdsOwner"
				)
				.sort({ companyName: 1, name: 1 })
				.lean()
				.exec();
		}

		const summaries = await Promise.all(
			agents.map((agent) =>
				calculateAgentWalletSummary({
					agent,
					hotelIds: scopeHotelIds,
					hotels: scopeHotels,
					startDate,
					endDate,
				})
			)
		);

		const totals = summaries.reduce(
			(acc, item) => {
				acc.walletAdded += item.walletAdded;
				acc.walletUsed += item.walletUsed;
				acc.balance += item.balance;
				acc.totalReservations += item.totalReservations;
				acc.totalReservationValue += item.totalReservationValue;
				acc.totalCommission += item.totalCommission;
				acc.commissionPaid += item.commissionPaid;
				acc.commissionDue += item.commissionDue;
				acc.pendingConfirmation += item.pendingConfirmation;
				acc.pendingWalletClaims += item.pendingWalletClaims || 0;
				acc.pendingWalletClaimAmount += item.pendingWalletClaimAmount || 0;
				acc.rejectedWalletClaims += item.rejectedWalletClaims || 0;
				acc.rejectedWalletClaimAmount += item.rejectedWalletClaimAmount || 0;
				return acc;
			},
			{
				walletAdded: 0,
				walletUsed: 0,
				balance: 0,
				totalReservations: 0,
				totalReservationValue: 0,
				totalCommission: 0,
				commissionPaid: 0,
				commissionDue: 0,
				pendingConfirmation: 0,
				pendingWalletClaims: 0,
				pendingWalletClaimAmount: 0,
				rejectedWalletClaims: 0,
				rejectedWalletClaimAmount: 0,
			}
		);

		Object.keys(totals).forEach((key) => {
			if (typeof totals[key] === "number") totals[key] = n2(totals[key]);
		});

		return res.json({
			walletScope: "agent_global",
			hotels: scopeHotels.map((hotel) => ({
				_id: normalizeId(hotel._id),
				hotelName: hotel.hotelName || "",
				belongsTo: normalizeId(hotel.belongsTo),
			})),
			agents: summaries,
			totals,
			canManage: canManageGlobalWallet(actor, scopeHotels),
		});
	} catch (error) {
		console.error("agentWalletSummary error:", error);
		return res.status(500).json({ error: error.message });
	}
};

exports.createAgentWalletTransaction = async (req, res) => {
	try {
		const { userId } = req.params;
		const body = req.body || {};
		const actor = await getActor(req, userId);
		const scopeHotels = await getAccessibleWalletHotels(actor, req.query);
		const scopeHotelIds = hotelIdsFromHotels(scopeHotels);

		if (!actor || !canManageGlobalWallet(actor, scopeHotels)) {
			return res.status(403).json({ error: "Access denied" });
		}

		const agentId = normalizeId(body.agentId);
		if (!ObjectId.isValid(agentId)) {
			return res.status(400).json({ error: "Valid agent is required" });
		}

		const agent = await User.findOne({
			_id: ObjectId(agentId),
			...buildAgentRoleQuery(),
		})
			.select(
				"_id name email phone companyName agentCommercialModel agentOpeningWalletCredit agentWalletOpeningBalances hotelIdWork hotelIdsWork hotelsToSupport hotelIdsOwner"
			)
			.lean()
			.exec();
		if (!agent || !actorCanAccessAgentInScope(actor, agent, scopeHotelIds)) {
			return res.status(404).json({ error: "Agent was not found for your wallet scope" });
		}

		const amount = n2(body.amount);
		if (!amount) {
			return res.status(400).json({ error: "Amount is required" });
		}

		let attachments = [];
		try {
			attachments = await buildWalletAttachments(body.attachments, actor);
		} catch (uploadError) {
			return res.status(400).json({ error: uploadError.message });
		}

		const transaction = await AgentWallet.create({
			hotelId: null,
			ownerId: ObjectId.isValid(ownerIdForWalletContext(actor, scopeHotels))
				? ObjectId(ownerIdForWalletContext(actor, scopeHotels))
				: null,
			agentId: ObjectId(agentId),
			transactionType: normalizeTransactionType(body.transactionType),
			amount,
			currency: "SAR",
			source: "manual",
			status: "posted",
			reviewStatus: "approved",
			reviewedAt: new Date(),
			reviewedBy: actorSnapshot(actor),
			note: String(body.note || "").trim(),
			reference: String(body.reference || "").trim(),
			transactionDate: parseTransactionDate(body.transactionDate),
			attachments,
			createdBy: actorSnapshot(actor),
		});

		await trackWalletActivity(req, {
			action: "agent_wallet_manual_transaction_created",
			description: "Manual agent wallet movement was created by finance.",
			actor,
			transaction,
			hotel: {},
			metadata: { walletScope: "agent_global" },
		});

		const summary = await calculateAgentWalletSummary({
			agent,
			hotelIds: scopeHotelIds,
			hotels: scopeHotels,
			startDate: body.startDate || "",
			endDate: body.endDate || "",
		});

		return res.json({ transaction, summary });
	} catch (error) {
		console.error("createAgentWalletTransaction error:", error);
		return res.status(500).json({ error: error.message });
	}
};

exports.updateAgentWalletTransaction = async (req, res) => {
	try {
		const { userId, transactionId } = req.params;
		const body = req.body || {};

		const actor = await getActor(req, userId);
		const scopeHotels = await getAccessibleWalletHotels(actor, req.query);
		const scopeHotelIds = hotelIdsFromHotels(scopeHotels);

		if (!actor || !canManageGlobalWallet(actor, scopeHotels)) {
			return res.status(403).json({ error: "Access denied" });
		}

		if (!ObjectId.isValid(transactionId)) {
			return res.status(400).json({ error: "Invalid transaction id" });
		}

		const transaction = await AgentWallet.findOne({
			_id: ObjectId(transactionId),
			status: { $ne: "void" },
		}).exec();

		if (!transaction) {
			return res.status(404).json({ error: "Wallet transaction was not found" });
		}

		if (transaction.reservationId) {
			return res
				.status(400)
				.json({ error: "Reservation wallet deductions cannot be edited here" });
		}
		const agent = await User.findById(transaction.agentId)
			.select("_id hotelIdWork hotelIdsWork hotelsToSupport hotelIdsOwner")
			.lean()
			.exec();
		if (!agent || !actorCanAccessAgentInScope(actor, agent, scopeHotelIds)) {
			return res.status(403).json({ error: "Agent access denied" });
		}
		if (
			transaction.source === "agent_claim" &&
			transaction.status === "posted" &&
			!canOverrideApprovedGlobalFinancials(actor, scopeHotels)
		) {
			return res.status(403).json({
				error:
					"Approved wallet claims can only be changed by hotel managers or admins.",
			});
		}

		const amount = n2(body.amount);
		if (!amount) {
			return res.status(400).json({ error: "Amount is required" });
		}

		let attachments = [];
		try {
			attachments = await buildWalletAttachments(body.attachments, actor);
		} catch (uploadError) {
			return res.status(400).json({ error: uploadError.message });
		}

		transaction.transactionType = normalizeTransactionType(body.transactionType);
		transaction.amount = amount;
		transaction.note = String(body.note || "").trim();
		transaction.reference = String(body.reference || "").trim();
		transaction.transactionDate = parseTransactionDate(body.transactionDate);
		transaction.attachments = attachments;
		transaction.updatedBy = actorSnapshot(actor);

		await transaction.save();

		await trackWalletActivity(req, {
			action: "agent_wallet_transaction_updated",
			description: "Agent wallet movement was updated.",
			actor,
			transaction,
			hotel: {},
			change: {
				field: "wallet_transaction",
				from: "previous_values",
				to: {
					transactionType: transaction.transactionType,
					amount: transaction.amount,
					transactionDate: transaction.transactionDate,
				},
			},
		});

		return res.json({ transaction });
	} catch (error) {
		console.error("updateAgentWalletTransaction error:", error);
		return res.status(500).json({ error: error.message });
	}
};

exports.voidAgentWalletTransaction = async (req, res) => {
	try {
		const { userId, transactionId } = req.params;
		const actor = await getActor(req, userId);
		const scopeHotels = await getAccessibleWalletHotels(actor, req.query);
		const scopeHotelIds = hotelIdsFromHotels(scopeHotels);

		if (!actor || !canManageGlobalWallet(actor, scopeHotels)) {
			return res.status(403).json({ error: "Access denied" });
		}

		if (!ObjectId.isValid(transactionId)) {
			return res.status(400).json({ error: "Invalid transaction id" });
		}

		const transaction = await AgentWallet.findOne({
			_id: ObjectId(transactionId),
			status: { $ne: "void" },
		}).exec();

		if (!transaction) {
			return res.status(404).json({ error: "Wallet transaction was not found" });
		}

		if (transaction.reservationId) {
			return res
				.status(400)
				.json({ error: "Reservation wallet deductions cannot be deleted here" });
		}
		const agent = await User.findById(transaction.agentId)
			.select("_id hotelIdWork hotelIdsWork hotelsToSupport hotelIdsOwner")
			.lean()
			.exec();
		if (!agent || !actorCanAccessAgentInScope(actor, agent, scopeHotelIds)) {
			return res.status(403).json({ error: "Agent access denied" });
		}
		if (
			transaction.source === "agent_claim" &&
			transaction.status === "posted" &&
			!canOverrideApprovedGlobalFinancials(actor, scopeHotels)
		) {
			return res.status(403).json({
				error:
					"Approved wallet claims can only be changed by hotel managers or admins.",
			});
		}

		transaction.status = "void";
		transaction.voidedAt = new Date();
		transaction.voidedBy = actorSnapshot(actor);
		await transaction.save();

		await trackWalletActivity(req, {
			action: "agent_wallet_transaction_voided",
			description: "Agent wallet movement was voided.",
			actor,
			transaction,
			hotel: {},
			change: {
				field: "status",
				from: "posted",
				to: "void",
			},
		});

		return res.json({ deleted: true, transactionId });
	} catch (error) {
		console.error("voidAgentWalletTransaction error:", error);
		return res.status(500).json({ error: error.message });
	}
};

exports.createAgentWalletClaim = async (req, res) => {
	try {
		const { userId } = req.params;
		const body = req.body || {};
		const actor = await getActor(req, userId);
		const scopeHotels = await getAccessibleWalletHotels(actor, req.query);

		if (!actor || actor.activeUser === false || !scopeHotels.length) {
			return res.status(403).json({ error: "Access denied" });
		}
		if (!isOrderTaker(actor) || canManageRole(actor)) {
			return res.status(403).json({
				error: "Only the assigned external agent can submit a wallet credit claim.",
			});
		}
		if (
			normalizeAgentCommercialModel(actor.agentCommercialModel) ===
			"commission_only"
		) {
			return res.status(400).json({
				error: "This agent is commission-only and does not have wallet credit.",
			});
		}

		const amount = n2(body.amount);
		if (!amount) {
			return res.status(400).json({ error: "Amount is required" });
		}

		if (!Array.isArray(body.attachments) || !body.attachments.length) {
			return res.status(400).json({
				error:
					"Please attach a transfer receipt, PDF, or image before submitting a wallet claim.",
				errorArabic:
					"\u064a\u062c\u0628 \u0625\u0631\u0641\u0627\u0642 \u0625\u064a\u0635\u0627\u0644 \u0623\u0648 PDF \u0623\u0648 \u0635\u0648\u0631\u0629 \u0642\u0628\u0644 \u0625\u0631\u0633\u0627\u0644 \u0645\u0637\u0627\u0644\u0628\u0629 \u0627\u0644\u0645\u062d\u0641\u0638\u0629.",
			});
		}

		let attachments = [];
		try {
			attachments = await buildWalletAttachments(body.attachments, actor);
		} catch (uploadError) {
			return res.status(400).json({ error: uploadError.message });
		}
		if (!attachments.length) {
			return res.status(400).json({
				error:
					"Please attach a transfer receipt, PDF, or image before submitting a wallet claim.",
				errorArabic:
					"\u064a\u062c\u0628 \u0625\u0631\u0641\u0627\u0642 \u0625\u064a\u0635\u0627\u0644 \u0623\u0648 PDF \u0623\u0648 \u0635\u0648\u0631\u0629 \u0642\u0628\u0644 \u0625\u0631\u0633\u0627\u0644 \u0645\u0637\u0627\u0644\u0628\u0629 \u0627\u0644\u0645\u062d\u0641\u0638\u0629.",
			});
		}

		const transaction = await AgentWallet.create({
			hotelId: null,
			ownerId: ObjectId.isValid(ownerIdForWalletContext(actor, scopeHotels))
				? ObjectId(ownerIdForWalletContext(actor, scopeHotels))
				: null,
			agentId: ObjectId(normalizeId(actor._id)),
			transactionType: "deposit",
			amount,
			currency: "SAR",
			source: "agent_claim",
			status: "pending",
			reviewStatus: "pending",
			note: String(body.note || "").trim(),
			reference: String(body.reference || "").trim(),
			transactionDate: parseTransactionDate(body.transactionDate),
			attachments,
			createdBy: actorSnapshot(actor),
		});

		await trackWalletActivity(req, {
			action: "agent_wallet_claim_submitted",
			description: "Agent submitted a wallet credit claim for finance approval.",
			actor,
			transaction,
			hotel: {},
			change: {
				field: "reviewStatus",
				from: "not_submitted",
				to: "pending",
			},
		});

		emitWalletNotificationRefresh(req, hotelsForAgentInScope(actor, scopeHotels), {
			type: "agent_wallet_claim",
			walletTransactionId: transaction._id,
			agentId: actor._id,
		}).catch((error) =>
			console.error("Error emitting wallet claim notification:", error)
		);

		return res.json({ transaction });
	} catch (error) {
		console.error("createAgentWalletClaim error:", error);
		return res.status(500).json({ error: error.message });
	}
};

exports.reviewAgentWalletClaim = async (req, res) => {
	try {
		const { userId, transactionId } = req.params;
		const body = req.body || {};
		const action = String(body.action || "").trim().toLowerCase();
		const actor = await getActor(req, userId);
		const scopeHotels = await getAccessibleWalletHotels(actor, req.query);
		const scopeHotelIds = hotelIdsFromHotels(scopeHotels);

		if (!actor || !canManageGlobalWallet(actor, scopeHotels)) {
			return res.status(403).json({ error: "Access denied" });
		}
		if (!["approve", "reject"].includes(action)) {
			return res.status(400).json({ error: "Action must be approve or reject" });
		}
		if (!ObjectId.isValid(transactionId)) {
			return res.status(400).json({ error: "Invalid transaction id" });
		}

		const transaction = await AgentWallet.findOne({
			_id: ObjectId(transactionId),
			source: "agent_claim",
			status: "pending",
			reviewStatus: "pending",
		}).exec();

		if (!transaction) {
			return res.status(404).json({ error: "Pending wallet claim was not found" });
		}
		const agent = await User.findById(transaction.agentId)
			.select("_id hotelIdWork hotelIdsWork hotelsToSupport hotelIdsOwner")
			.lean()
			.exec();
		if (!agent || !actorCanAccessAgentInScope(actor, agent, scopeHotelIds)) {
			return res.status(403).json({ error: "Agent access denied" });
		}

		const now = new Date();
		if (action === "approve") {
			const previousStatus = transaction.status;
			const previousReviewStatus = transaction.reviewStatus;
			transaction.status = "posted";
			transaction.reviewStatus = "approved";
			transaction.reviewedAt = now;
			transaction.reviewedBy = actorSnapshot(actor);
			transaction.rejectionReason = "";
			transaction.rejectionType = "";
			transaction.updatedBy = actorSnapshot(actor);
			await transaction.save();

			await trackWalletActivity(req, {
				action: "agent_wallet_claim_approved",
				description: "Finance approved an agent wallet credit claim.",
				actor,
				transaction,
				hotel: {},
				change: {
					field: "reviewStatus",
					from: previousReviewStatus || previousStatus || "pending",
					to: "approved",
				},
			});
		} else {
			const previousStatus = transaction.status;
			const previousReviewStatus = transaction.reviewStatus;
			const rejectionReason = String(body.rejectionReason || body.reason || "").trim();
			const rejectionType = normalizeWalletRejectionType(body);
			if (!rejectionReason) {
				return res.status(400).json({ error: "Rejection reason is required" });
			}
			transaction.status = "rejected";
			transaction.reviewStatus = "rejected";
			transaction.reviewedAt = now;
			transaction.reviewedBy = actorSnapshot(actor);
			transaction.rejectionReason = rejectionReason;
			transaction.rejectionType = rejectionType;
			transaction.updatedBy = actorSnapshot(actor);
			await transaction.save();

			await trackWalletActivity(req, {
				action: "agent_wallet_claim_rejected",
				description: "Finance rejected an agent wallet credit claim.",
				actor,
				transaction,
				hotel: {},
				change: {
					field: "reviewStatus",
					from: previousReviewStatus || previousStatus || "pending",
					to: "rejected",
				},
				metadata: {
					rejectionReason,
					rejectionType,
					correctionAllowed: rejectionType !== "final",
				},
			});
		}

		emitWalletNotificationRefresh(req, hotelsForAgentInScope(agent, scopeHotels), {
			type: action === "approve" ? "agent_wallet_claim_approved" : "agent_wallet_claim_rejected",
			walletTransactionId: transaction._id,
			agentId: transaction.agentId,
			rejectionType: transaction.rejectionType || "",
		}).catch((error) =>
			console.error("Error emitting wallet claim review notification:", error)
		);

		return res.json({ transaction });
	} catch (error) {
		console.error("reviewAgentWalletClaim error:", error);
		return res.status(500).json({ error: error.message });
	}
};

exports.agentTodoList = async (req, res) => {
	try {
		const { userId } = req.params;
		const { agentId = "" } = req.query || {};
		const actor = await getActor(req, userId);
		const scopeHotels = await getAccessibleWalletHotels(actor, req.query);
		const scopeHotelIds = hotelIdsFromHotels(scopeHotels);

		if (!actor || actor.activeUser === false || !scopeHotelIds.length) {
			return res.status(403).json({ error: "Access denied" });
		}

		const requestedAgentId = normalizeId(agentId) || normalizeId(actor._id);
		if (!ObjectId.isValid(requestedAgentId)) {
			return res.status(400).json({ error: "Valid agent is required" });
		}
		const requestedAgent = await User.findById(requestedAgentId)
			.select("_id hotelIdWork hotelIdsWork hotelsToSupport hotelIdsOwner")
			.lean()
			.exec();
		if (
			!requestedAgent ||
			!actorCanAccessAgentInScope(actor, requestedAgent, scopeHotelIds)
		) {
			return res.status(403).json({ error: "Agent access denied" });
		}

		const reservationMatch = buildAgentReservationMatch(
			scopeHotelIds,
			requestedAgentId
		);
		const reservationQuery = {
			...reservationMatch,
			$and: [
				...(Array.isArray(reservationMatch.$and) ? reservationMatch.$and : []),
				{
					$or: [
						{ reservation_status: /pending[\s_-]?confirmation/i },
						{ state: /pending[\s_-]?confirmation/i },
						{ "pendingConfirmation.status": "rejected" },
						{ "commissionAgentApproval.status": { $in: ["pending", "rejected"] } },
					],
				},
			],
		};
		delete reservationQuery.$or;
		reservationQuery.$and.unshift({ $or: reservationMatch.$or || [] });

		const [reservations, walletClaims] = await Promise.all([
			Reservations.find(reservationQuery)
				.select(
					"_id confirmation_number customer_details booking_source booked_at createdAt checkin_date checkout_date reservation_status state total_amount commission commissionStatus commissionPaid commissionAgentApproval pendingConfirmation financial_cycle"
				)
				.sort({ updatedAt: -1, createdAt: -1 })
				.limit(100)
				.lean()
				.exec(),
			AgentWallet.find({
				agentId: ObjectId(requestedAgentId),
				source: "agent_claim",
				status: { $in: ["pending", "rejected"] },
			})
				.sort({ updatedAt: -1, createdAt: -1 })
				.limit(50)
				.lean()
				.exec(),
		]);

		const reservationTodos = reservations.flatMap((reservation) => {
			const todos = [];
			const approvalStatus = String(
				reservation?.commissionAgentApproval?.status || ""
			).toLowerCase();
			if (approvalStatus === "pending") {
				todos.push({
					type: "commission_agent_approval",
					severity: "high",
					reservationId: normalizeId(reservation._id),
					confirmation_number: reservation.confirmation_number,
					guestName: reservation.customer_details?.name || "",
					amount: commissionAmount(reservation),
					status: approvalStatus,
					title: "Commission marked paid needs your approval",
				});
			}
			if (approvalStatus === "rejected") {
				todos.push({
					type: "commission_agent_rejected",
					severity: "medium",
					reservationId: normalizeId(reservation._id),
					confirmation_number: reservation.confirmation_number,
					guestName: reservation.customer_details?.name || "",
					amount: commissionAmount(reservation),
					status: approvalStatus,
					rejectionReason:
						reservation.commissionAgentApproval?.rejectionReason || "",
					title: "Commission payment is disputed",
				});
			}
			const pendingStatus = String(
				reservation?.pendingConfirmation?.status || ""
			).toLowerCase();
			const reservationStatus = String(
				reservation.reservation_status || reservation.state || ""
			).toLowerCase();
			if (/pending[\s_-]?confirmation/i.test(reservationStatus)) {
				todos.push({
					type: "pending_confirmation",
					severity: "medium",
					reservationId: normalizeId(reservation._id),
					confirmation_number: reservation.confirmation_number,
					guestName: reservation.customer_details?.name || "",
					status: reservation.reservation_status || reservation.state || "",
					title: "Reservation is waiting for hotel confirmation",
				});
			}
			if (pendingStatus === "rejected") {
				todos.push({
					type: "reservation_rejected",
					severity: "high",
					reservationId: normalizeId(reservation._id),
					confirmation_number: reservation.confirmation_number,
					guestName: reservation.customer_details?.name || "",
					status: pendingStatus,
					rejectionReason:
						reservation.pendingConfirmation?.rejectionReason ||
						reservation.agentDecisionSnapshot?.reason ||
						"",
					title: "Reservation was rejected by the hotel",
				});
			}
			return todos;
		});

		const walletTodos = walletClaims.map((claim) => ({
			type:
				claim.status === "pending"
					? "wallet_claim_pending"
					: "wallet_claim_rejected",
			severity:
				claim.status === "pending"
					? "low"
					: claim.rejectionType === "final"
					? "high"
					: "medium",
			walletTransactionId: normalizeId(claim._id),
			amount: n2(claim.amount),
			status: claim.status,
			rejectionReason: claim.rejectionReason || "",
			rejectionType: claim.rejectionType || "correction_required",
			correctionAllowed: claim.rejectionType !== "final",
			reference: claim.reference || "",
			attachments: claim.attachments || [],
			title:
				claim.status === "pending"
					? "Wallet credit claim is waiting for approval"
					: claim.rejectionType === "final"
					? "Wallet credit claim was finally rejected"
					: "Wallet credit claim needs correction",
		}));

		const data = [...reservationTodos, ...walletTodos];
		return res.json({ total: data.length, data });
	} catch (error) {
		console.error("agentTodoList error:", error);
		return res.status(500).json({ error: error.message });
	}
};
