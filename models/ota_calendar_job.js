/** @format */

const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema;

const otaCalendarJobSchema = new mongoose.Schema(
	{
		jobNumber: { type: String, trim: true, unique: true, index: true },
		status: {
			type: String,
			trim: true,
			lowercase: true,
			default: "prepared",
			index: true,
		},
		executionMode: {
			type: String,
			trim: true,
			lowercase: true,
			default: "supervised_manual",
		},
		operation: {
			type: String,
			trim: true,
			lowercase: true,
			default: "calendar_availability_update",
		},
		createdBy: { type: ObjectId, ref: "User", required: true, index: true },
		hotelId: { type: ObjectId, ref: "HotelDetails", required: true, index: true },
		roomId: { type: String, trim: true, required: true },
		roomType: { type: String, trim: true, default: "" },
		roomDisplayName: { type: String, trim: true, default: "" },
		dateFrom: { type: String, trim: true, required: true },
		dateTo: { type: String, trim: true, required: true },
		timezone: { type: String, trim: true, default: "Asia/Riyadh" },
		nightlyRateSar: { type: Number, default: null },
		rootRateSar: { type: Number, default: null },
		availability: { type: Number, default: null },
		closed: { type: Boolean, default: false },
		totalNights: { type: Number, default: 0 },
		selectedOtas: { type: [String], default: [] },
		otaTasks: { type: [Object], default: [] },
		calendarDays: { type: [Object], default: [] },
		credentialSummary: { type: Object, default: {} },
		automationPolicy: { type: Object, default: {} },
		orchestratorPlan: { type: Object, default: {} },
		manualVerification: { type: Object, default: {} },
		payloadSnapshot: { type: Object, default: {} },
		notes: { type: String, trim: true, default: "" },
		auditLog: { type: [Object], default: [] },
	},
	{ timestamps: true }
);

otaCalendarJobSchema.index({ hotelId: 1, roomId: 1, dateFrom: 1, dateTo: 1 });
otaCalendarJobSchema.index({ selectedOtas: 1, createdAt: -1 });

module.exports = mongoose.model("OtaCalendarJob", otaCalendarJobSchema);
