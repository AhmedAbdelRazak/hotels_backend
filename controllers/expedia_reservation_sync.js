/** @format */

const mongoose = require("mongoose");
const User = require("../models/user");
const OtaReservationSyncJob = require("../models/ota_reservation_sync_job");
const {
	prepareOtaReservationSyncJob,
} = require("../services/expediaReservationSync");

const { ObjectId } = mongoose.Types;

const configuredSuperAdminIds = () =>
	[process.env.SUPER_ADMIN_ID, process.env.REACT_APP_SUPER_ADMIN_ID]
		.flatMap((value) => String(value || "").split(","))
		.map((id) => id.trim())
		.filter(Boolean);

const normalizeRoleDescription = (value = "") =>
	String(value || "")
		.toLowerCase()
		.replace(/[\s_-]+/g, "");

const actorRoleNumbers = (actor = {}) => [
	Number(actor.role),
	...(Array.isArray(actor.roles) ? actor.roles.map(Number) : []),
];

const actorRoleDescriptions = (actor = {}) => [
	actor.roleDescription,
	...(Array.isArray(actor.roleDescriptions) ? actor.roleDescriptions : []),
].map(normalizeRoleDescription);

const canPrepareOtaSync = (actor = {}) => {
	const actorId = String(actor?._id || actor?.id || "").trim();
	return (
		configuredSuperAdminIds().includes(actorId) ||
		actorRoleNumbers(actor).includes(1000) ||
		actorRoleDescriptions(actor).includes("superadmin")
	);
};

const loadActor = async (req) => {
	if (req.profile?._id) return req.profile;
	const actorId = req.auth?._id || req.auth?.id;
	if (!actorId || !ObjectId.isValid(actorId)) return null;
	return User.findById(actorId)
		.select("_id role roles roleDescription roleDescriptions activeUser name email")
		.lean()
		.exec();
};

const prepareOtaReservationSync = async (req, res) => {
	try {
		const actor = await loadActor(req);
		if (!actor || actor.activeUser === false || !canPrepareOtaSync(actor)) {
			return res.status(403).json({
				error: "Only Super Admins can prepare OTA reservation sync jobs.",
			});
		}

		const result = await prepareOtaReservationSyncJob({
			actor,
			payload: req.body || {},
		});
		if (!result.ok) {
			return res.status(result.statusCode || 400).json({ error: result.error });
		}
		return res.status(201).json({ ok: true, job: result.job });
	} catch (error) {
		console.error("[ota-reservation-sync] prepare failed:", error);
		return res
			.status(500)
			.json({ error: "Could not prepare OTA reservation sync job." });
	}
};

const readOtaReservationSyncJob = async (req, res) => {
	try {
		const actor = await loadActor(req);
		if (!actor || !canPrepareOtaSync(actor)) {
			return res.status(403).json({
				error: "Only Super Admins can view OTA reservation sync jobs.",
			});
		}
		const { jobId } = req.params;
		if (!ObjectId.isValid(jobId)) {
			return res.status(400).json({ error: "Invalid OTA sync job id." });
		}
		const job = await OtaReservationSyncJob.findById(jobId).lean().exec();
		if (!job) {
			return res
				.status(404)
				.json({ error: "OTA reservation sync job not found." });
		}
		return res.json({ ok: true, job });
	} catch (error) {
		console.error("[ota-reservation-sync] read failed:", error);
		return res
			.status(500)
			.json({ error: "Could not load OTA reservation sync job." });
	}
};

exports.prepareOtaReservationSync = prepareOtaReservationSync;
exports.readOtaReservationSyncJob = readOtaReservationSyncJob;
exports.prepareExpediaReservationSync = prepareOtaReservationSync;
exports.readExpediaReservationSyncJob = readOtaReservationSyncJob;
