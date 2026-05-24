/** @format */

const mongoose = require("mongoose");
const { ObjectId, Mixed } = mongoose.Schema.Types;

const actorSnapshotSchema = new mongoose.Schema(
	{
		_id: { type: ObjectId, ref: "User", default: null, index: true },
		name: { type: String, trim: true, default: "" },
		email: { type: String, trim: true, lowercase: true, default: "" },
		role: { type: String, trim: true, default: "" },
		roleDescription: { type: String, trim: true, default: "" },
	},
	{ _id: false }
);

const activityTrackerSchema = new mongoose.Schema(
	{
		action: {
			type: String,
			required: true,
			trim: true,
			lowercase: true,
			index: true,
		},
		category: {
			type: String,
			trim: true,
			lowercase: true,
			default: "general",
			index: true,
		},
		source: { type: String, trim: true, lowercase: true, default: "" },
		description: { type: String, trim: true, default: "" },
		visibility: {
			type: String,
			enum: ["standard", "super_admin_only"],
			default: "standard",
			index: true,
		},

		actor: { type: actorSnapshotSchema, default: () => ({}) },

		entityType: { type: String, trim: true, default: "" },
		entityModel: { type: String, trim: true, default: "" },
		entityId: { type: ObjectId, default: null, index: true },

		hotelId: { type: ObjectId, ref: "HotelDetails", default: null, index: true },
		ownerId: { type: ObjectId, ref: "User", default: null, index: true },
		reservationId: {
			type: ObjectId,
			ref: "Reservations",
			default: null,
			index: true,
		},
		confirmationNumber: {
			type: String,
			trim: true,
			lowercase: true,
			default: "",
			index: true,
		},

		exportDetails: {
			dataset: { type: String, trim: true, default: "" },
			format: { type: String, trim: true, uppercase: true, default: "" },
			totalRows: { type: Number, default: 0 },
			dateRange: { type: Mixed, default: {} },
			filters: { type: Mixed, default: {} },
			columns: [{ type: String, trim: true }],
			hotelIds: [{ type: ObjectId, ref: "HotelDetails" }],
		},

		change: {
			field: { type: String, trim: true, default: "" },
			from: { type: Mixed, default: null },
			to: { type: Mixed, default: null },
		},

		metadata: { type: Mixed, default: {} },
		request: {
			ipAddress: { type: String, trim: true, default: "" },
			userAgent: { type: String, trim: true, default: "" },
			method: { type: String, trim: true, uppercase: true, default: "" },
			path: { type: String, trim: true, default: "" },
		},
	},
	{ timestamps: true }
);

activityTrackerSchema.index({ "actor._id": 1, createdAt: -1 });
activityTrackerSchema.index({ action: 1, createdAt: -1 });
activityTrackerSchema.index({ hotelId: 1, action: 1, createdAt: -1 });
activityTrackerSchema.index({ ownerId: 1, action: 1, createdAt: -1 });
activityTrackerSchema.index({ reservationId: 1, createdAt: -1 });
activityTrackerSchema.index({ confirmationNumber: 1, createdAt: -1 });

module.exports = mongoose.model("ActivityTracker", activityTrackerSchema);
