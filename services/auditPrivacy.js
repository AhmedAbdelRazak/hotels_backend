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
	roleNumbers(viewer).includes(1000) ||
	roleKeys(viewer).includes("superadmin");

const PRIVILEGED_AUDIT_ROLE_KEYS = new Set([
	"admin",
	"administrator",
	"platformadmin",
	"superadmin",
	"systemadmin",
	"systemadministrator",
]);

const isPrivilegedAuditActor = (actor) => {
	if (!actor || typeof actor !== "object") return false;
	if (isConfiguredSuperAdmin(actor)) return true;
	if (roleNumbers(actor).some((role) => role === 1000 || role === 10000)) {
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

const sanitizeReservationAuditLogsForViewer = (reservation, viewer = {}) => {
	if (!reservation || isSuperAdminViewer(viewer)) return reservation;

	const plain = toPlain(reservation);
	const sanitized = { ...plain };

	["adminChangeLog", "reservationAuditLog"].forEach((field) => {
		if (!Array.isArray(plain?.[field])) return;
		sanitized[field] = plain[field].filter(
			(entry) => !shouldHideAuditEntry(entry, viewer)
		);
	});

	const stripPrivilegedActorAtPath = (path = "") => {
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
		}
	};

	[
		"adminLastUpdatedBy",
		"pendingConfirmation.lastUpdatedBy",
		"agentDecisionSnapshot.decidedBy",
		"agentDecisionSnapshot.lastUpdatedBy",
		"financial_cycle.lastUpdatedBy",
		"financial_cycle.commissionAssignedBy",
		"financial_cycle.closedBy",
		"commissionAgentApproval.approvedBy",
		"commissionAgentApproval.rejectedBy",
		"commissionAgentApproval.lastUpdatedBy",
	].forEach(stripPrivilegedActorAtPath);

	return sanitized;
};

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
	resolveAuditViewerFromRequest,
	sanitizeReservationAuditLogsCollectionForViewer,
	sanitizeReservationAuditLogsForViewer,
	shouldHideAuditEntry,
};
