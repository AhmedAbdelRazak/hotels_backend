/** @format */

"use strict";

const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const User = require("../models/user");

const ObjectId = mongoose.Types.ObjectId;

const normalizeId = (value) => String(value?._id || value?.id || value || "").trim();

const normalizeRoleKey = (value = "") =>
	String(value || "")
		.toLowerCase()
		.replace(/[\s_-]+/g, "")
		.trim();

const configuredSuperAdminIds = () =>
	[process.env.SUPER_ADMIN_ID, process.env.REACT_APP_SUPER_ADMIN_ID]
		.flatMap((value) => String(value || "").split(","))
		.map((id) => String(id).trim())
		.filter(Boolean);

const isConfiguredSuperAdmin = (userOrId) =>
	configuredSuperAdminIds().includes(normalizeId(userOrId));

const roleValues = (actor = {}) => [
	actor.role,
	actor.roleDescription,
	actor.userRole,
	actor.adminRole,
	...(Array.isArray(actor.roles) ? actor.roles : []),
	...(Array.isArray(actor.roleDescriptions) ? actor.roleDescriptions : []),
];

const roleNumbers = (actor = {}) =>
	roleValues(actor)
		.map((role) => Number(role))
		.filter((role) => Number.isFinite(role));

const roleKeys = (actor = {}) =>
	roleValues(actor).map(normalizeRoleKey).filter(Boolean);

const isSuperAdminViewer = (viewer = {}) =>
	isConfiguredSuperAdmin(viewer) ||
	roleNumbers(viewer).some((role) => Number(role) === 1000) ||
	roleKeys(viewer).some((role) =>
		[
			"platformadmin",
			"superadmin",
		].includes(role)
	);

const moneyNumber = (value) => {
	if (value === null || value === undefined || value === "") return 0;
	if (typeof value === "number") return Number.isFinite(value) ? value : 0;
	const parsed = Number(String(value).replace(/,/g, "").trim());
	return Number.isFinite(parsed) ? parsed : 0;
};

const n2 = (value) => Number(moneyNumber(value).toFixed(2));

const HOTEL_VISIBLE_PAYMENT_KEYS = [
	"paid_online_via_link",
	"paid_at_hotel_cash",
	"paid_at_hotel_card",
	"paid_to_hotel",
	"paid_online_jannatbooking",
	"paid_online_other_platforms",
	"paid_online_via_instapay",
	"paid_no_show",
];

const paymentBreakdownTotal = (breakdown = {}) =>
	HOTEL_VISIBLE_PAYMENT_KEYS.reduce(
		(sum, key) => sum + moneyNumber(breakdown?.[key]),
		0
	);

const scalePaymentBreakdownToHotelAmount = (breakdown = {}, rootTotal = 0) => {
	if (!breakdown || typeof breakdown !== "object") return breakdown;
	const total = paymentBreakdownTotal(breakdown);
	if (!(total > 0) || total <= rootTotal) return { ...breakdown };

	const ratio = rootTotal > 0 ? rootTotal / total : 0;
	const sanitized = { ...breakdown };
	let allocated = 0;
	const keysWithValue = HOTEL_VISIBLE_PAYMENT_KEYS.filter(
		(key) => moneyNumber(breakdown[key]) > 0
	);

	keysWithValue.forEach((key, index) => {
		const isLast = index === keysWithValue.length - 1;
		const nextValue = isLast
			? n2(Math.max(rootTotal - allocated, 0))
			: n2(moneyNumber(breakdown[key]) * ratio);
		sanitized[key] = nextValue;
		allocated = n2(allocated + nextValue);
	});

	return sanitized;
};

const scaleFinancialCyclePaymentsToHotelAmount = (cycle = {}, rootTotal = 0) => {
	if (!cycle || typeof cycle !== "object") return cycle;
	const pmsCollected = moneyNumber(cycle.pmsCollectedAmount);
	const hotelCollected = moneyNumber(cycle.hotelCollectedAmount);
	const totalCollected = pmsCollected + hotelCollected;
	if (!(totalCollected > 0) || totalCollected <= rootTotal) return { ...cycle };

	const ratio = rootTotal > 0 ? rootTotal / totalCollected : 0;
	const nextPmsCollected = n2(pmsCollected * ratio);
	const nextHotelCollected = n2(Math.max(rootTotal - nextPmsCollected, 0));

	return {
		...cycle,
		pmsCollectedAmount: nextPmsCollected,
		hotelCollectedAmount: nextHotelCollected,
	};
};

const sanitizePaidAmountForRootOnly = (reservation = {}, rootTotal = 0) => {
	const paidFromBreakdown = paymentBreakdownTotal(reservation?.paid_amount_breakdown);
	const paidAmount = moneyNumber(reservation?.paid_amount);
	const rawPaidAmount = paidFromBreakdown > 0 ? paidFromBreakdown : paidAmount;
	if (!(rawPaidAmount > 0)) return 0;
	if (!(rootTotal > 0)) return 0;
	return n2(Math.min(rawPaidAmount, rootTotal));
};

const normalizeRoomCount = (count) => {
	const parsed = Number(count);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
};

const hasViewerIdentity = (viewer = {}) =>
	!!normalizeId(viewer) || roleValues(viewer).some((role) => role !== undefined && role !== null && role !== "");

const ADMIN_PRICING_ROLE_KEYS = new Set([
	"platformadmin",
	"superadmin",
]);

const canViewAdminPricing = (viewer = {}) =>
	isSuperAdminViewer(viewer) ||
	roleNumbers(viewer).some((role) => Number(role) === 1000) ||
	roleKeys(viewer).some((role) => ADMIN_PRICING_ROLE_KEYS.has(role));

const adminRootOnlyPricingEnabled = (reservation = {}) =>
	reservation?.adminPricingVisibility?.rootOnlyForHotelManagement === true;

const shouldApplyRootOnlyPricing = (reservation = {}, viewer = {}) =>
	adminRootOnlyPricingEnabled(reservation) &&
	(!hasViewerIdentity(viewer) || !canViewAdminPricing(viewer));

const OTA_EMAIL_AUDIT_SUPPLIER_FIELDS = [
	"otaCreatedFromEmail",
	"otaInboundEmailId",
	"otaLastInboundEmailId",
	"otaProvider",
	"otaPaymentCollectionModel",
	"otaConfirmationNumber",
	"platformConfirmationNumber",
];

const redactOtaEmailAuditFieldsForHotelViewer = (reservation = {}) => {
	if (!reservation || typeof reservation !== "object") return reservation;
	const sanitized = { ...reservation };

	if (sanitized.supplierData && typeof sanitized.supplierData === "object") {
		sanitized.supplierData = { ...sanitized.supplierData };
		OTA_EMAIL_AUDIT_SUPPLIER_FIELDS.forEach((field) => {
			delete sanitized.supplierData[field];
		});
	}

	delete sanitized.otaPlatformReview;
	return sanitized;
};

const hasExplicitMoneyField = (source = {}, field) =>
	Object.prototype.hasOwnProperty.call(source || {}, field) &&
	source[field] !== null &&
	source[field] !== undefined &&
	source[field] !== "";

const rootPriceFromDay = (day = {}) => {
	if (hasExplicitMoneyField(day, "rootPrice")) {
		const explicitRoot = moneyNumber(day.rootPrice);
		if (explicitRoot >= 0) return n2(explicitRoot);
	}
	if (hasExplicitMoneyField(day, "totalPriceWithoutCommission")) {
		const withoutCommission = moneyNumber(day.totalPriceWithoutCommission);
		if (withoutCommission >= 0) return n2(withoutCommission);
	}
	return 0;
};

const stripAdminPricingDayFields = (day = {}) => {
	const rootPrice = rootPriceFromDay(day);
	const sanitized = {
		...day,
		price: rootPrice,
		rootPrice,
		commissionRate: 0,
		totalPriceWithCommission: rootPrice,
		totalPriceWithoutCommission: rootPrice,
	};

	[
		"clientPrice",
		"mainPrice",
		"netAfterExpenses",
		"netAfterOtaExpenses",
		"netAfterOtherExpenses",
		"otaExpenseAmount",
		"otherExpenseAmount",
		"expenseAmount",
		"otaExpenseRate",
		"platformMargin",
		"platformMarginRate",
	].forEach((field) => {
		delete sanitized[field];
	});

	return sanitized;
};

const rootTotalForRooms = (rooms = []) =>
	(Array.isArray(rooms) ? rooms : []).reduce((reservationTotal, room) => {
		const pricingByDay = Array.isArray(room?.pricingByDay)
			? room.pricingByDay
			: [];
		const roomRoot = pricingByDay.reduce(
			(sum, day) => sum + rootPriceFromDay(day),
			0
		);
		if (roomRoot > 0) return reservationTotal + roomRoot * normalizeRoomCount(room?.count);
		return reservationTotal + moneyNumber(room?.hotelShouldGet || room?.totalPriceWithCommission);
	}, 0);

const sanitizeRoomsToRootOnly = (rooms = []) =>
	(Array.isArray(rooms) ? rooms : []).map((room) => {
		const pricingByDay = Array.isArray(room?.pricingByDay)
			? room.pricingByDay.map(stripAdminPricingDayFields)
			: [];
		const roomRootTotal = n2(
			pricingByDay.reduce((sum, day) => sum + moneyNumber(day.rootPrice), 0)
		);
		const averageRoot =
			pricingByDay.length > 0 ? n2(roomRootTotal / pricingByDay.length) : 0;
		const sanitized = {
			...room,
			chosenPrice: averageRoot > 0 ? averageRoot.toFixed(2) : room?.chosenPrice,
			pricingByDay,
			totalPriceWithCommission: roomRootTotal,
			hotelShouldGet: roomRootTotal,
		};
		delete sanitized.adminPricing;
		return sanitized;
	});

const sanitizeReservationPricingForHotelViewer = (reservation = {}) => {
	const sanitized = redactOtaEmailAuditFieldsForHotelViewer(reservation);
	const sourceRooms = Array.isArray(sanitized.pickedRoomsType)
		? sanitized.pickedRoomsType
		: [];
	const sourcePricingRooms = Array.isArray(sanitized.pickedRoomsPricing)
		? sanitized.pickedRoomsPricing
		: [];
	const sanitizedRooms = sanitizeRoomsToRootOnly(sourceRooms);
	const sanitizedPricingRooms = sanitizeRoomsToRootOnly(sourcePricingRooms);
	const roomRootTotal = rootTotalForRooms(
		sourceRooms.length ? sourceRooms : sourcePricingRooms
	);
	const adminRootTotal = moneyNumber(sanitized?.adminPricing?.rootTotal);
	const fallbackSubTotal = moneyNumber(sanitized.sub_total);
	const rootTotal = n2(
		adminRootTotal > 0
			? adminRootTotal
			: roomRootTotal > 0
			? roomRootTotal
			: fallbackSubTotal > 0
			? fallbackSubTotal
			: 0
	);

	sanitized.pickedRoomsType = sanitizedRooms;
	if (sourcePricingRooms.length) {
		sanitized.pickedRoomsPricing = sanitizedPricingRooms;
	}
	sanitized.total_amount = rootTotal;
	sanitized.sub_total = rootTotal;
	sanitized.paid_amount = sanitizePaidAmountForRootOnly(sanitized, rootTotal);
	if (
		sanitized.paid_amount_breakdown &&
		typeof sanitized.paid_amount_breakdown === "object"
	) {
		sanitized.paid_amount_breakdown = scalePaymentBreakdownToHotelAmount(
			sanitized.paid_amount_breakdown,
			rootTotal
		);
	}
	sanitized.commission = 0;
	if (sanitized.financial_cycle && typeof sanitized.financial_cycle === "object") {
		const hotelVisibleCycle = scaleFinancialCyclePaymentsToHotelAmount(
			sanitized.financial_cycle,
			rootTotal
		);
		sanitized.financial_cycle = {
			...hotelVisibleCycle,
			commissionAmount: 0,
			commissionValue: 0,
			commissionDueToPms: 0,
			hotelPayoutDue: rootTotal,
		};
	}
	delete sanitized.adminPricing;
	delete sanitized.adminPricingVisibility;

	return sanitized;
};

const clientPriceFromDay = (day = {}) => {
	const explicitClient =
		day.clientPrice ?? day.mainPrice ?? day.totalPriceWithCommission ?? day.price;
	const clientPrice = moneyNumber(explicitClient);
	if (clientPrice > 0) return n2(clientPrice);
	const withoutCommission = moneyNumber(day.totalPriceWithoutCommission);
	return withoutCommission > 0 ? n2(withoutCommission) : rootPriceFromDay(day);
};

const stripAdminPricingDayFieldsForClient = (day = {}) => {
	const clientPrice = clientPriceFromDay(day);
	const sanitized = {
		...day,
		price: clientPrice,
		clientPrice,
		mainPrice: clientPrice,
		totalPriceWithCommission: clientPrice,
	};

	[
		"rootPrice",
		"netAfterExpenses",
		"netAfterOtaExpenses",
		"netAfterOtherExpenses",
		"otaExpenseAmount",
		"otherExpenseAmount",
		"expenseAmount",
		"otaExpenseRate",
		"platformMargin",
		"platformMarginRate",
	].forEach((field) => {
		delete sanitized[field];
	});

	return sanitized;
};

const sanitizeRoomsToClientOnly = (rooms = []) =>
	(Array.isArray(rooms) ? rooms : []).map((room) => {
		const pricingByDay = Array.isArray(room?.pricingByDay)
			? room.pricingByDay.map(stripAdminPricingDayFieldsForClient)
			: [];
		const clientTotal = n2(
			pricingByDay.reduce(
				(sum, day) => sum + moneyNumber(day.totalPriceWithCommission),
				0
			)
		);
		const averageClient =
			pricingByDay.length > 0 ? n2(clientTotal / pricingByDay.length) : 0;
		const sanitized = {
			...room,
			chosenPrice:
				averageClient > 0 ? averageClient.toFixed(2) : room?.chosenPrice,
			pricingByDay,
			totalPriceWithCommission:
				clientTotal > 0 ? clientTotal : room?.totalPriceWithCommission,
		};
		delete sanitized.adminPricing;
		return sanitized;
	});

const sanitizeReservationPricingForClientViewer = (reservation = {}) => {
	const sanitized = redactOtaEmailAuditFieldsForHotelViewer(reservation);
	if (Array.isArray(sanitized.pickedRoomsType)) {
		sanitized.pickedRoomsType = sanitizeRoomsToClientOnly(
			sanitized.pickedRoomsType
		);
	}
	if (Array.isArray(sanitized.pickedRoomsPricing)) {
		sanitized.pickedRoomsPricing = sanitizeRoomsToClientOnly(
			sanitized.pickedRoomsPricing
		);
	}
	delete sanitized.adminPricing;
	delete sanitized.adminPricingVisibility;
	return sanitized;
};

const PRIVILEGED_AUDIT_ROLE_KEYS = new Set([
	"admin",
	"administrator",
	"ordertaker",
	"platformadmin",
	"reservationemployee",
	"superadmin",
	"systemadmin",
	"systemadministrator",
]);

const isPrivilegedAuditActor = (actor) => {
	if (!actor || typeof actor !== "object") return false;
	if (isConfiguredSuperAdmin(actor)) return true;
	if (
		roleNumbers(actor).some((role) =>
			[1000, 7000, 8000, 10000].includes(role)
		)
	) {
		return true;
	}
	if (roleKeys(actor).some((role) => PRIVILEGED_AUDIT_ROLE_KEYS.has(role))) {
		return true;
	}
	return isPrivilegedAuditActor(actor.previewedBy);
};

const auditEntryActors = (entry = {}) =>
	[
		entry.by,
		entry.actor,
		entry.user,
		entry.admin,
		entry.updatedBy,
		entry.createdBy,
		entry.performedBy,
		entry.lastUpdatedBy,
		entry.previewedBy,
	].filter((actor) => actor && typeof actor === "object");

const shouldHideAuditEntry = (entry = {}, viewer = {}) =>
	!isSuperAdminViewer(viewer) &&
	auditEntryActors(entry).some(isPrivilegedAuditActor);

const toPlain = (value) => {
	if (!value) return value;
	if (typeof value.toObject === "function") return value.toObject();
	return value;
};

const sanitizeReservationAuditLogsForViewer = (
	reservation,
	viewer = {},
	options = {}
) => {
	if (!reservation || isSuperAdminViewer(viewer)) return reservation;

	const plain = toPlain(reservation);
	const sanitized = redactOtaEmailAuditFieldsForHotelViewer(plain);

	["adminChangeLog", "reservationAuditLog"].forEach((field) => {
		if (!Array.isArray(plain?.[field])) return;
		sanitized[field] = plain[field].filter(
			(entry) => !shouldHideAuditEntry(entry, viewer)
		);
	});

	const stripValueAtPath = (path = "") => {
		const parts = path.split(".");
		const last = parts.pop();
		let sourceParent = plain;
		let targetParent = sanitized;

		for (const part of parts) {
			if (!sourceParent?.[part] || typeof sourceParent[part] !== "object") {
				return;
			}
			if (targetParent[part] === sourceParent[part]) {
				targetParent[part] = Array.isArray(sourceParent[part])
					? [...sourceParent[part]]
					: { ...sourceParent[part] };
			}
			sourceParent = sourceParent[part];
			targetParent = targetParent[part];
		}

		if (targetParent && Object.prototype.hasOwnProperty.call(targetParent, last)) {
			targetParent[last] = null;
		}
	};

	const stripPrivilegedActorAtPath = (path = "", relatedTimestampPaths = []) => {
		const parts = path.split(".");
		const last = parts.pop();
		let sourceParent = plain;
		let targetParent = sanitized;

		for (const part of parts) {
			if (!sourceParent?.[part] || typeof sourceParent[part] !== "object") {
				return;
			}
			if (targetParent[part] === sourceParent[part]) {
				targetParent[part] = Array.isArray(sourceParent[part])
					? [...sourceParent[part]]
					: { ...sourceParent[part] };
			}
			sourceParent = sourceParent[part];
			targetParent = targetParent[part];
		}

		if (targetParent?.[last] && isPrivilegedAuditActor(targetParent[last])) {
			targetParent[last] = null;
			relatedTimestampPaths.forEach(stripValueAtPath);
		}
	};

	[
		["adminLastUpdatedBy", ["adminLastUpdatedAt"]],
		[
			"pendingConfirmation.lastUpdatedBy",
			[
				"pendingConfirmation.lastUpdatedAt",
				"pendingConfirmation.confirmedAt",
				"pendingConfirmation.rejectedAt",
			],
		],
		["agentDecisionSnapshot.decidedBy", ["agentDecisionSnapshot.decidedAt"]],
		[
			"agentDecisionSnapshot.lastUpdatedBy",
			["agentDecisionSnapshot.lastUpdatedAt"],
		],
		["financial_cycle.lastUpdatedBy", ["financial_cycle.lastUpdatedAt"]],
		[
			"financial_cycle.commissionAssignedBy",
			["financial_cycle.commissionAssignedAt"],
		],
		["financial_cycle.closedBy", ["financial_cycle.closedAt"]],
		["commissionAgentApproval.approvedBy", ["commissionAgentApproval.approvedAt"]],
		["commissionAgentApproval.rejectedBy", ["commissionAgentApproval.rejectedAt"]],
		[
			"commissionAgentApproval.lastUpdatedBy",
			["commissionAgentApproval.lastUpdatedAt"],
		],
	].forEach(([path, timestamps]) =>
		stripPrivilegedActorAtPath(path, timestamps)
	);

	return !options.preservePricing && shouldApplyRootOnlyPricing(plain, viewer)
		? sanitizeReservationPricingForHotelViewer(sanitized)
		: sanitized;
};

const sanitizeReservationAdminWorkflowForPublicViewer = (reservation) =>
	sanitizeReservationPricingForClientViewer(
		sanitizeReservationAuditLogsForViewer(
			reservation,
			{ role: "client" },
			{ preservePricing: true }
		)
	);

const sanitizeReservationAuditLogsCollectionForViewer = (
	reservations = [],
	viewer = {}
) =>
	Array.isArray(reservations)
		? reservations.map((reservation) =>
				sanitizeReservationAuditLogsForViewer(reservation, viewer)
		  )
		: reservations;

const getBearerToken = (req = {}) => {
	const header =
		req.headers?.authorization ||
		req.headers?.Authorization ||
		req.get?.("authorization") ||
		"";
	const match = String(header).match(/^Bearer\s+(.+)$/i);
	return match ? match[1] : "";
};

const resolveAuditViewerFromRequest = async (req = {}, fallbackViewer = null) => {
	if (
		fallbackViewer &&
		(isSuperAdminViewer(fallbackViewer) || roleValues(fallbackViewer).some(Boolean))
	) {
		return fallbackViewer;
	}

	let actorId = normalizeId(fallbackViewer || req.auth?._id);
	if (!actorId) {
		const token = getBearerToken(req);
		if (token && process.env.JWT_SECRET) {
			try {
				const decoded = jwt.verify(token, process.env.JWT_SECRET);
				actorId = normalizeId(decoded?._id);
			} catch (error) {
				actorId = "";
			}
		}
	}

	if (!actorId || !ObjectId.isValid(actorId)) return fallbackViewer || null;

	const user = await User.findById(actorId)
		.select("_id name email role roleDescription roles roleDescriptions")
		.lean()
		.exec();

	return user || fallbackViewer || null;
};

module.exports = {
	isPrivilegedAuditActor,
	isSuperAdminViewer,
	redactOtaEmailAuditFieldsForHotelViewer,
	resolveAuditViewerFromRequest,
	sanitizeReservationAdminWorkflowForPublicViewer,
	sanitizeReservationAuditLogsCollectionForViewer,
	sanitizeReservationAuditLogsForViewer,
	shouldHideAuditEntry,
};
