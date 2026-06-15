/** @format */

const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema;

const otaReservationSyncJobSchema = new mongoose.Schema(
	{
		jobNumber: { type: String, trim: true, unique: true, index: true },
		status: {
			type: String,
			trim: true,
			lowercase: true,
			default: "prepared",
			index: true,
		},
		provider: {
			type: String,
			trim: true,
			lowercase: true,
			default: "expedia",
			index: true,
		},
		operation: {
			type: String,
			trim: true,
			lowercase: true,
			default: "reservation_sync_preview",
		},
		executionMode: {
			type: String,
			trim: true,
			lowercase: true,
			default: "supervised_read_only",
		},
		createdBy: { type: ObjectId, ref: "User", required: true, index: true },
		dateFrom: { type: String, trim: true, required: true },
		dateTo: { type: String, trim: true, required: true },
		timezone: { type: String, trim: true, default: "Asia/Riyadh" },
		hotelCount: { type: Number, default: 0 },
		targetHotels: { type: [Object], default: [] },
		credentialSummary: { type: Object, default: {} },
		syncPolicy: { type: Object, default: {} },
		collectorPlan: { type: Object, default: {} },
		collectorState: { type: Object, default: {} },
		previewBuckets: { type: Object, default: {} },
		collectorArtifacts: { type: Object, default: {} },
		applyResults: { type: Object, default: {} },
		payloadSnapshot: { type: Object, default: {} },
		resultSummary: { type: Object, default: {} },
		notes: { type: String, trim: true, default: "" },
		auditLog: { type: [Object], default: [] },
	},
	{ timestamps: true }
);

otaReservationSyncJobSchema.index({ provider: 1, status: 1, createdAt: -1 });
otaReservationSyncJobSchema.index({ dateFrom: 1, dateTo: 1, createdAt: -1 });

module.exports = mongoose.model(
	"OtaReservationSyncJob",
	otaReservationSyncJobSchema
);
