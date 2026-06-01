/** @format */

const mongoose = require("mongoose");
const User = require("../models/user");
const HotelDetails = require("../models/hotel_details");
const OtaCalendarJob = require("../models/ota_calendar_job");
const {
	prepareOtaCalendarJob,
	SUPPORTED_OTAS,
	SUPPORTED_OTA_LABELS,
} = require("../services/otaCalendarOrchestrator");

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

const isOtaCalendarSuperAdmin = (actor = {}) => {
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

const findRoomById = (hotel = {}, roomId = "") =>
	(Array.isArray(hotel.roomCountDetails) ? hotel.roomCountDetails : []).find(
		(room) => String(room?._id || "") === String(roomId || "")
	);

exports.otaCalendarOptions = async (req, res) => {
	try {
		const actor = await loadActor(req);
		if (!actor || !isOtaCalendarSuperAdmin(actor)) {
			return res.status(403).json({
				error: "Only Super Admins can prepare OTA calendar jobs.",
			});
		}
		return res.json({
			ok: true,
			supportedOtas: SUPPORTED_OTAS.map((value) => ({
				value,
				label: SUPPORTED_OTA_LABELS[value],
				usernameConfigured: Boolean(
					process.env[
						{
							expedia: "OTA_EXPEDIA_USERNAME",
							agoda: "OTA_AGODA_USERNAME",
							airbnb: "OTA_AIRBNB_USERNAME",
							booking: "OTA_BOOKING_USERNAME",
						}[value]
					]
				),
			})),
			passwordEnvKey: "OTA_PASSWORD",
			passwordConfigured: Boolean(process.env.OTA_PASSWORD),
			executionMode: "supervised_manual",
			automationPolicy: {
				calendarOnly: true,
				noCaptchaBypass: true,
				manualVerificationRequired: true,
				manualSubmitRequired: true,
			},
		});
	} catch (error) {
		console.error("[ota-calendar] options failed:", error);
		return res.status(500).json({ error: "Could not load OTA calendar options." });
	}
};

exports.prepareOtaCalendar = async (req, res) => {
	try {
		const actor = await loadActor(req);
		if (!actor || actor.activeUser === false || !isOtaCalendarSuperAdmin(actor)) {
			return res.status(403).json({
				error: "Only Super Admins can prepare OTA calendar jobs.",
			});
		}

		const hotelId = req.body?.hotelId;
		const roomId = req.body?.roomId;
		if (!ObjectId.isValid(hotelId)) {
			return res.status(400).json({ error: "Valid hotelId is required." });
		}
		if (!roomId) {
			return res.status(400).json({ error: "roomId is required." });
		}

		const hotel = await HotelDetails.findById(hotelId)
			.select("_id hotelName hotelName_OtherLanguage roomCountDetails")
			.lean()
			.exec();
		if (!hotel) return res.status(404).json({ error: "Hotel not found." });

		const room = findRoomById(hotel, roomId);
		if (!room) {
			return res.status(404).json({ error: "Room type was not found in this hotel." });
		}

		const result = await prepareOtaCalendarJob({
			actor,
			hotel,
			room,
			payload: req.body || {},
		});
		if (!result.ok) {
			return res.status(result.statusCode || 400).json({ error: result.error });
		}
		return res.status(201).json({ ok: true, job: result.job });
	} catch (error) {
		console.error("[ota-calendar] prepare failed:", error);
		return res.status(500).json({ error: "Could not prepare OTA calendar job." });
	}
};

exports.readOtaCalendarJob = async (req, res) => {
	try {
		const actor = await loadActor(req);
		if (!actor || !isOtaCalendarSuperAdmin(actor)) {
			return res.status(403).json({
				error: "Only Super Admins can view OTA calendar jobs.",
			});
		}
		const { jobId } = req.params;
		if (!ObjectId.isValid(jobId)) {
			return res.status(400).json({ error: "Invalid OTA calendar job id." });
		}
		const job = await OtaCalendarJob.findById(jobId).lean().exec();
		if (!job) return res.status(404).json({ error: "OTA calendar job not found." });
		return res.json({ ok: true, job });
	} catch (error) {
		console.error("[ota-calendar] read failed:", error);
		return res.status(500).json({ error: "Could not load OTA calendar job." });
	}
};
