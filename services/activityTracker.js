/** @format */

"use strict";

const mongoose = require("mongoose");
const ActivityTracker = require("../models/activity_tracker");

const ObjectId = mongoose.Types.ObjectId;
const EXPORT_RECORD_LIMIT = 1000;

const normalizeId = (value) => String(value?._id || value?.id || value || "").trim();

const toObjectId = (value) => {
	const id = normalizeId(value);
	return id && ObjectId.isValid(id) ? ObjectId(id) : null;
};

const toPlain = (value) => {
	if (!value) return value;
	if (typeof value.toObject === "function") return value.toObject();
	return value;
};

const cleanForAudit = (value) => {
	if (value === undefined) return undefined;
	if (value === null) return null;
	if (value instanceof Date) return value.toISOString();
	if (value && typeof value === "object" && value._bsontype) {
		return value.toString();
	}
	if (Array.isArray(value)) return value.map(cleanForAudit);
	if (value && typeof value === "object") {
		return Object.entries(toPlain(value)).reduce((acc, [key, item]) => {
			if (key === "__v") return acc;
			acc[key] = cleanForAudit(item);
			return acc;
		}, {});
	}
	return value;
};

const auditStringify = (value) => {
	try {
		return JSON.stringify(cleanForAudit(value));
	} catch (error) {
		return String(value);
	}
};

const getByPath = (source = {}, path = "") =>
	String(path || "")
		.split(".")
		.reduce((current, part) => (current == null ? undefined : current[part]), source);

const actorSnapshot = (actor = {}) => {
	const actorId = toObjectId(actor._id || actor.id);
	const roleValue = actor.roleDescription || actor.role || "";
	return {
		_id: actorId,
		name: actor.name || actor.email || "System",
		email: actor.email || "",
		role: String(roleValue || ""),
		roleDescription: actor.roleDescription || "",
	};
};

const normalizeRoleKey = (value = "") =>
	String(value || "")
		.toLowerCase()
		.replace(/[\s_-]+/g, "")
		.trim();

const privilegedActorRoleKeys = new Set([
	"admin",
	"administrator",
	"platformadmin",
	"superadmin",
	"systemadmin",
	"systemadministrator",
]);

const isPrivilegedTrackerActor = (actor = {}) => {
	const values = [
		actor.role,
		actor.roleDescription,
		actor.userRole,
		actor.adminRole,
		...(Array.isArray(actor.roles) ? actor.roles : []),
		...(Array.isArray(actor.roleDescriptions) ? actor.roleDescriptions : []),
	];
	const roleNumbers = values
		.map((role) => Number(role))
		.filter((role) => Number.isFinite(role));
	const roleKeys = values.map(normalizeRoleKey).filter(Boolean);
	return (
		roleNumbers.some((role) => role === 1000 || role === 10000) ||
		roleKeys.some((role) => privilegedActorRoleKeys.has(role))
	);
};

const trackerVisibility = (payload = {}) =>
	payload.visibility ||
	(isPrivilegedTrackerActor(payload.actor) ? "super_admin_only" : "standard");

const requestSnapshot = (req) => ({
	ipAddress:
		String(req?.headers?.["x-forwarded-for"] || "")
			.split(",")[0]
			.trim() ||
		req?.ip ||
		req?.connection?.remoteAddress ||
		"",
	userAgent: req?.headers?.["user-agent"] || "",
	method: req?.method || "",
	path: req?.originalUrl || req?.url || "",
});

const safeCreateTracker = async (payload, req) => {
	try {
		await ActivityTracker.create({
			...payload,
			visibility: trackerVisibility(payload),
			request: {
				...requestSnapshot(req),
				...(payload.request || {}),
			},
		});
		return true;
	} catch (error) {
		console.error("Activity tracker create error:", error);
		return false;
	}
};

const safeInsertTrackers = async (entries = [], req) => {
	if (!entries.length) return;
	const request = requestSnapshot(req);
	try {
		await ActivityTracker.insertMany(
			entries.map((entry) => ({
				...entry,
				visibility: trackerVisibility(entry),
				request: {
					...request,
					...(entry.request || {}),
				},
			})),
			{ ordered: false }
		);
	} catch (error) {
		console.error("Activity tracker insert error:", error);
	}
};

const cleanExportFilters = (query = {}) => {
	const allowedKeys = [
		"ownerId",
		"hotelId",
		"search",
		"status",
		"bookingSource",
		"payment",
		"dateBy",
		"sortBy",
		"sortOrder",
		"dateFrom",
		"dateTo",
		"fromDate",
		"toDate",
		"range",
	];
	return allowedKeys.reduce((acc, key) => {
		if (query[key] !== undefined && query[key] !== null && query[key] !== "") {
			acc[key] = query[key];
		}
		return acc;
	}, {});
};

const cleanFinancialExportFilters = (filters = {}) => {
	const allowedKeys = [
		"ownerId",
		"hotelId",
		"hotelIds",
		"agentId",
		"agentIds",
		"startDate",
		"endDate",
		"dateFrom",
		"dateTo",
		"range",
		"scope",
		"source",
		"reportType",
	];
	return allowedKeys.reduce((acc, key) => {
		const value = filters[key];
		if (
			value !== undefined &&
			value !== null &&
			value !== "" &&
			(!Array.isArray(value) || value.length)
		) {
			acc[key] = cleanForAudit(value);
		}
		return acc;
	}, {});
};

const exportDateRange = (query = {}) => ({
	dateBy: query.dateBy || query.sortBy || "booked_at",
	from: query.dateFrom || query.fromDate || "",
	to: query.dateTo || query.toDate || "",
	range: query.range || (query.dateFrom || query.dateTo ? "custom" : "all"),
});

const financialExportDateRange = (filters = {}) => {
	const from = filters.startDate || filters.dateFrom || "";
	const to = filters.endDate || filters.dateTo || "";
	return {
		dateBy: "transaction_date",
		from,
		to,
		range: filters.range || (from || to ? "custom" : "all"),
	};
};

const uniqueStrings = (values = []) => [
	...new Set(
		(Array.isArray(values) ? values : [values])
			.map((value) => String(value || "").trim())
			.filter(Boolean)
	),
];

const financialAgentId = (row = {}) =>
	normalizeId(row.agentId || row.agent?._id || row.agent || row._agentId);

const financialHotelId = (row = {}) =>
	normalizeId(row.hotelId || row.hotel?._id || row.hotel || row._hotelId);

const financialReservationId = (row = {}) =>
	normalizeId(row.reservationId || row._id || row.id || row._reservationId);

const financialConfirmationNumber = (row = {}) =>
	String(
		row.confirmationNumber ||
			row.confirmation_number ||
			row.Confirmation ||
			row.confirmation ||
			""
	).trim();

const capAuditRows = (rows = []) =>
	(Array.isArray(rows) ? rows : [])
		.slice(0, EXPORT_RECORD_LIMIT)
		.map(cleanForAudit);

const trackFinancialReportExport = async ({
	req,
	actor,
	hotels = [],
	filters = {},
	dataset = "overall_financial_report",
	format = "XLSX",
	totalRows = 0,
	columns = [],
	totals = {},
	agents = [],
	transactions = [],
	reservations = [],
}) => {
	const agentRows = Array.isArray(agents) ? agents : [];
	const transactionRows = Array.isArray(transactions) ? transactions : [];
	const reservationRows = Array.isArray(reservations) ? reservations : [];
	const rowCounts = {
		agents: agentRows.length,
		transactions: transactionRows.length,
		reservations: reservationRows.length,
	};
	const allRows = [...agentRows, ...transactionRows, ...reservationRows];
	const hotelIds = (Array.isArray(hotels) ? hotels : [])
		.map((hotel) => toObjectId(hotel?._id || hotel))
		.filter(Boolean);
	const agentIds = uniqueStrings([
		...(Array.isArray(filters.agentIds) ? filters.agentIds : []),
		filters.agentId,
		...agentRows.map(financialAgentId),
		...transactionRows.map(financialAgentId),
		...reservationRows.map(financialAgentId),
	]);
	const exportedHotelIds = uniqueStrings([
		...(Array.isArray(filters.hotelIds) ? filters.hotelIds : []),
		filters.hotelId,
		...allRows.map(financialHotelId),
	]);
	const confirmationNumbers = uniqueStrings(
		reservationRows.map(financialConfirmationNumber)
	);
	const reservationIds = uniqueStrings(reservationRows.map(financialReservationId));
	const transactionReferences = uniqueStrings(
		transactionRows.map(
			(row) => row.reference || row.Reference || row.transactionId || row._id || ""
		)
	);
	const trackerTotalRows =
		Number(totalRows || 0) ||
		rowCounts.agents + rowCounts.transactions + rowCounts.reservations;

	return safeCreateTracker(
		{
			action: "financial_report_exported",
			category: "financials",
			source: "overall_dashboard",
			description: `${dataset} exported to Excel`,
			actor: actorSnapshot(actor),
			entityType: "financial_report_export",
			exportDetails: {
				dataset,
				format,
				totalRows: trackerTotalRows,
				dateRange: financialExportDateRange(filters),
				filters: cleanFinancialExportFilters(filters),
				columns: Array.isArray(columns) ? columns.map(String) : [],
				hotelIds,
			},
			metadata: {
				rowCounts,
				totals: cleanForAudit(totals),
				agentIds,
				hotelIds: exportedHotelIds,
				reservationIds,
				confirmationNumbers,
				transactionReferences,
				recordsStoredLimit: EXPORT_RECORD_LIMIT,
				recordsTruncated:
					rowCounts.agents > EXPORT_RECORD_LIMIT ||
					rowCounts.transactions > EXPORT_RECORD_LIMIT ||
					rowCounts.reservations > EXPORT_RECORD_LIMIT,
				agents: capAuditRows(agentRows),
				transactions: capAuditRows(transactionRows),
				reservations: capAuditRows(reservationRows),
			},
		},
		req
	);
};

const trackReservationExport = async ({
	req,
	actor,
	hotels = [],
	query = {},
	dataset = "overall_reservations",
	totalRows = 0,
	rows = [],
}) => {
	const reservationRows = Array.isArray(rows) ? rows : [];
	const cappedRows = reservationRows.slice(0, EXPORT_RECORD_LIMIT);
	await safeCreateTracker(
		{
			action: "reservations_exported",
			category: "reservations",
			source: "overall_dashboard",
			description: `${dataset} exported to Excel`,
			actor: actorSnapshot(actor),
			entityType: "reservation_export",
			exportDetails: {
				dataset,
				format: "XLSX",
				totalRows: Number(totalRows || reservationRows.length || 0),
				dateRange: exportDateRange(query),
				filters: cleanExportFilters(query),
				columns: [
					"index",
					"hotel",
					"confirmation_number",
					"guest",
					"phone",
					"email",
					"booking_source",
					"reservation_status",
					"booked_at",
					"checkin_date",
					"checkout_date",
					"total_amount",
					"paid_amount",
					"payment",
					"rooms",
				],
				hotelIds: (Array.isArray(hotels) ? hotels : [])
					.map((hotel) => toObjectId(hotel?._id))
					.filter(Boolean),
			},
			metadata: {
				reservationIds: cappedRows.map((reservation) =>
					normalizeId(reservation._id)
				),
				confirmationNumbers: cappedRows
					.map((reservation) => reservation.confirmation_number || "")
					.filter(Boolean),
				recordsStoredLimit: EXPORT_RECORD_LIMIT,
				recordsTruncated: reservationRows.length > EXPORT_RECORD_LIMIT,
			},
		},
		req
	);
};

const trackedReservationFields = [
	{ path: "reservation_status", label: "reservation_status" },
	{ path: "state", label: "state" },
	{ path: "pendingConfirmation.status", label: "pending_confirmation_status" },
	{ path: "agentDecisionSnapshot.status", label: "agent_decision_status" },
	{ path: "financial_cycle.status", label: "financial_cycle_status" },
	{
		path: "financial_cycle.totalReviewStatus",
		label: "financial_cycle_total_review_status",
	},
	{ path: "commissionStatus", label: "commission_status" },
	{
		path: "commissionAgentApproval.status",
		label: "agent_commission_approval_status",
	},
	{ path: "roomId", label: "room_assignment" },
	{ path: "bedNumber", label: "bed_assignment" },
	{ path: "housedBy", label: "housed_by" },
	{ path: "inhouse_date", label: "inhouse_date" },
];

const actionFromChange = (field = "", value = "") => {
	const normalized = String(value || "").toLowerCase();
	if (/cancel/.test(normalized)) return "reservation_cancelled";
	if (/reject|disput/.test(normalized)) return "reservation_rejected";
	if (/confirm/.test(normalized)) return "reservation_confirmed";
	if (/in[-_\s]?house|checked[-_\s]?in|house/.test(normalized))
		return "reservation_housed";
	if (/checked[-_\s]?out|closed/.test(normalized)) return "reservation_checked_out";
	if (/finance|commission|payment|payout/.test(field))
		return "reservation_finance_status_changed";
	if (/room|bed|housed|inhouse/.test(field)) return "reservation_housing_changed";
	return "reservation_status_changed";
};

const auditFields = (auditEntries = []) =>
	(Array.isArray(auditEntries) ? auditEntries : [])
		.map((entry) => entry?.field)
		.filter(Boolean);

const trackReservationStatusChange = async ({
	req,
	actor,
	reservationBefore,
	reservationAfter,
	auditEntries = [],
	source = "reservation_update",
}) => {
	const before = toPlain(reservationBefore) || {};
	const after = toPlain(reservationAfter) || {};
	const changedAuditFields = new Set(auditFields(auditEntries));
	const relevantFields = trackedReservationFields.filter(
		(field) =>
			!changedAuditFields.size ||
			changedAuditFields.has(field.path) ||
			changedAuditFields.has(field.path.split(".")[0])
	);

	const entries = relevantFields.reduce((acc, field) => {
		const from = getByPath(before, field.path);
		const to = getByPath(after, field.path);
		if (auditStringify(from) === auditStringify(to)) return acc;

		const action = actionFromChange(field.label, to);
		acc.push({
			action,
			category: "reservations",
			source,
			description: `${field.label} changed from ${String(
				cleanForAudit(from) ?? ""
			)} to ${String(cleanForAudit(to) ?? "")}`,
			actor: actorSnapshot(actor),
			entityType: "reservation",
			entityModel: "Reservations",
			entityId: toObjectId(after._id),
			reservationId: toObjectId(after._id),
			hotelId: toObjectId(after.hotelId || before.hotelId),
			ownerId: toObjectId(after.belongsTo || before.belongsTo),
			confirmationNumber:
				after.confirmation_number || before.confirmation_number || "",
			change: {
				field: field.label,
				from: cleanForAudit(from),
				to: cleanForAudit(to),
			},
			metadata: {
				auditFields: [...changedAuditFields],
				sourceAction: source,
			},
		});
		return acc;
	}, []);

	await safeInsertTrackers(entries, req);
};

const accountTrackedFields = [
	{ path: "name", label: "name" },
	{ path: "email", label: "email" },
	{ path: "phone", label: "phone" },
	{ path: "companyName", label: "company_name" },
	{ path: "companyOfficialName", label: "company_official_name" },
	{ path: "companyEin", label: "company_tax_id" },
	{ path: "role", label: "primary_role" },
	{ path: "roleDescription", label: "primary_role_description" },
	{ path: "roles", label: "roles" },
	{ path: "roleDescriptions", label: "role_descriptions" },
	{ path: "activeUser", label: "active_user" },
	{ path: "hotelIdWork", label: "primary_hotel" },
	{ path: "hotelIdsWork", label: "work_hotels" },
	{ path: "hotelIdsOwner", label: "owner_hotels" },
	{ path: "hotelsToSupport", label: "support_hotels" },
	{ path: "belongsToId", label: "belongs_to_owner" },
	{ path: "accessTo", label: "access_to" },
	{ path: "agentCommercialModel", label: "agent_commercial_model" },
	{ path: "agentOpeningWalletCredit", label: "agent_opening_wallet_credit" },
	{ path: "agentWalletOpeningBalances", label: "agent_wallet_opening_balances" },
	{ path: "agentApproval.status", label: "agent_approval_status" },
	{ path: "applicationReview.status", label: "application_review_status" },
	{
		path: "companyDocuments",
		label: "company_documents",
		transform: (documents = []) =>
			(Array.isArray(documents) ? documents : []).map((document) => ({
				fileName: document?.fileName || document?.name || "",
				fileType: document?.fileType || document?.type || "",
				fileSize: Number(document?.fileSize || document?.size || 0),
			})),
	},
];

const accountHotelIds = (account = {}) =>
	uniqueStrings([
		account.hotelIdWork,
		...(Array.isArray(account.hotelIdsWork) ? account.hotelIdsWork : []),
		...(Array.isArray(account.hotelIdsOwner) ? account.hotelIdsOwner : []),
		...(Array.isArray(account.hotelsToSupport) ? account.hotelsToSupport : []),
	]);

const accountOwnerIds = (account = {}) =>
	uniqueStrings([
		account.belongsToId,
		...(Array.isArray(account.applicationReview?.approvedHotelIds)
			? []
			: []),
	]);

const accountFieldValue = (account = {}, field = {}) => {
	const value = getByPath(account, field.path);
	return field.transform ? cleanForAudit(field.transform(value)) : cleanForAudit(value);
};

const accountChangeAction = (changes = []) => {
	const fields = changes.map((change) => change.field);
	if (fields.some((field) => /role/.test(field))) return "account_role_changed";
	if (fields.includes("active_user")) return "account_activation_changed";
	if (
		fields.some((field) =>
			/(hotel|owner|support|belongs_to_owner)/.test(field)
		)
	) {
		return "account_scope_changed";
	}
	if (fields.includes("password")) return "account_password_changed";
	return "account_updated";
};

const trackAccountUpdate = async ({
	req,
	actor,
	accountBefore,
	accountAfter,
	source = "account_update",
	hotelId = null,
	ownerId = null,
	hotelIds = [],
	ownerIds = [],
}) => {
	const before = toPlain(accountBefore) || {};
	const after = toPlain(accountAfter) || {};
	const changes = accountTrackedFields.reduce((acc, field) => {
		const from = accountFieldValue(before, field);
		const to = accountFieldValue(after, field);
		if (auditStringify(from) === auditStringify(to)) return acc;
		acc.push({ field: field.label, from, to });
		return acc;
	}, []);

	if (
		before.hashed_password &&
		after.hashed_password &&
		String(before.hashed_password) !== String(after.hashed_password)
	) {
		changes.push({ field: "password", from: "unchanged", to: "changed" });
	}

	if (!changes.length) return true;

	const normalizedHotelIds = uniqueStrings([
		...accountHotelIds(before),
		...accountHotelIds(after),
		...(Array.isArray(hotelIds) ? hotelIds : [hotelIds]),
	]);
	const normalizedOwnerIds = uniqueStrings([
		...accountOwnerIds(before),
		...accountOwnerIds(after),
		...(Array.isArray(ownerIds) ? ownerIds : [ownerIds]),
		ownerId,
	]);

	return safeCreateTracker(
		{
			action: accountChangeAction(changes),
			category: "accounts",
			source,
			description: `${after.name || after.email || "Account"} updated`,
			actor: actorSnapshot(actor),
			entityType: "user_account",
			entityModel: "User",
			entityId: toObjectId(after._id || before._id),
			hotelId: toObjectId(hotelId || normalizedHotelIds[0]),
			ownerId: toObjectId(ownerId || normalizedOwnerIds[0]),
			change: changes.length === 1 ? changes[0] : undefined,
			metadata: {
				changes,
				changedFields: changes.map((change) => change.field),
				account: {
					_id: normalizeId(after._id || before._id),
					name: after.name || before.name || "",
					email: after.email || before.email || "",
					role: after.roleDescription || after.role || "",
					activeUser: after.activeUser,
				},
				hotelIds: normalizedHotelIds,
				ownerIds: normalizedOwnerIds,
			},
		},
		req
	);
};

const trackAccountCreation = async ({
	req,
	actor,
	account,
	source = "account_create",
	hotelId = null,
	ownerId = null,
	hotelIds = [],
	ownerIds = [],
}) => {
	const created = toPlain(account) || {};
	const normalizedHotelIds = uniqueStrings([
		...accountHotelIds(created),
		...(Array.isArray(hotelIds) ? hotelIds : [hotelIds]),
	]);
	const normalizedOwnerIds = uniqueStrings([
		...accountOwnerIds(created),
		...(Array.isArray(ownerIds) ? ownerIds : [ownerIds]),
		ownerId,
	]);

	return safeCreateTracker(
		{
			action: "account_created",
			category: "accounts",
			source,
			description: `${created.name || created.email || "Account"} created`,
			actor: actorSnapshot(actor),
			entityType: "user_account",
			entityModel: "User",
			entityId: toObjectId(created._id),
			hotelId: toObjectId(hotelId || normalizedHotelIds[0]),
			ownerId: toObjectId(ownerId || normalizedOwnerIds[0]),
			metadata: {
				account: {
					_id: normalizeId(created._id),
					name: created.name || "",
					email: created.email || "",
					role: created.roleDescription || created.role || "",
					activeUser: created.activeUser,
				},
				hotelIds: normalizedHotelIds,
				ownerIds: normalizedOwnerIds,
				accessTo: cleanForAudit(created.accessTo || []),
			},
		},
		req
	);
};

module.exports = {
	trackFinancialReportExport,
	trackReservationExport,
	trackReservationStatusChange,
	trackAccountUpdate,
	trackAccountCreation,
};
