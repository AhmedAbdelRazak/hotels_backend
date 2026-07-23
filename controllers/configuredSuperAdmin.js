"use strict";

const User = require("../models/user");
const {
	configuredSuperAdminIds,
	isConfiguredSuperAdminId,
} = require("../services/bofaVccPolicy");

exports.requireConfiguredSuperAdmin = async (req, res, next) => {
	try {
		const actorId = String(req?.auth?._id || "").trim();
		if (configuredSuperAdminIds().length === 0) {
			return res.status(503).json({
				code: "SUPER_ADMIN_NOT_CONFIGURED",
				message: "Payment capture is disabled because no super admin is configured.",
			});
		}
		if (!actorId || !isConfiguredSuperAdminId(actorId)) {
			return res.status(403).json({
				code: "CAPTURE_SUPER_ADMIN_REQUIRED",
				message: "Only a configured super admin can access payment capture.",
			});
		}
		const actor = await User.findById(actorId)
			.select("_id activeUser")
			.lean();
		if (!actor || actor.activeUser === false) {
			return res.status(403).json({
				code: "CAPTURE_SUPER_ADMIN_INACTIVE",
				message: "The configured super-admin account is not active.",
			});
		}
		req.paymentCaptureActor = actor;
		return next();
	} catch (error) {
		return res.status(500).json({
			code: "CAPTURE_AUTHORIZATION_FAILED",
			message: "Payment-capture authorization could not be verified.",
		});
	}
};
