/** @format */

"use strict";

const mongoose = require("mongoose");

const { ObjectId } = mongoose.Schema;

const TERMINAL_FALLBACK_STATUSES = [
	"completed_api",
	"completed_email_fallback",
];

const hotelRunnerFallbackNotificationOutboxSchema = new mongoose.Schema(
	{
		jobId: {
			type: ObjectId,
			ref: "HotelRunnerOtaFallbackJob",
			required: true,
			unique: true,
			index: true,
		},
		dedupeKey: {
			type: String,
			trim: true,
			lowercase: true,
			required: true,
			unique: true,
		},
		terminalStatus: {
			type: String,
			trim: true,
			lowercase: true,
			enum: TERMINAL_FALLBACK_STATUSES,
			required: true,
		},
		hotelId: { type: ObjectId, ref: "HotelDetails", required: true, index: true },
		inboundEmailId: {
			type: ObjectId,
			ref: "InboundEmail",
			required: true,
			index: true,
		},
		inboundEmailHash: {
			type: String,
			trim: true,
			lowercase: true,
			maxlength: 64,
			required: true,
		},
		reservationMongoId: {
			type: ObjectId,
			ref: "Reservations",
			required: true,
			index: true,
		},
		provider: { type: String, trim: true, lowercase: true, required: true },
		confirmationNumber: {
			type: String,
			trim: true,
			lowercase: true,
			required: true,
		},
		reconciliationStatus: {
			type: String,
			trim: true,
			lowercase: true,
			default: "",
		},
		otaPlatformReviewStatus: {
			type: String,
			trim: true,
			lowercase: true,
			default: "",
		},
		ownerId: { type: ObjectId, ref: "User", default: null },
		status: {
			type: String,
			trim: true,
			lowercase: true,
			enum: ["pending", "processing", "retry", "completed"],
			default: "pending",
			index: true,
		},
		nextAttemptAt: { type: Date, required: true, index: true },
		attemptCount: { type: Number, min: 0, default: 0 },
		leaseOwner: { type: String, trim: true, default: "" },
		leaseToken: { type: String, trim: true, lowercase: true, default: "" },
		leaseAcquiredAt: { type: Date, default: null },
		leaseUntil: { type: Date, default: null, index: true },
		refresh: {
			status: {
				type: String,
				trim: true,
				lowercase: true,
				enum: ["pending", "completed"],
				default: "pending",
			},
			completedAt: { type: Date, default: null },
		},
		whatsapp: {
			status: {
				type: String,
				trim: true,
				lowercase: true,
				enum: [
					"pending",
					"not_required",
					"claimed",
					"completed",
					"failed",
					"unknown",
				],
				default: "pending",
			},
			attemptKey: { type: String, trim: true, lowercase: true, default: "" },
			claimedAt: { type: Date, default: null },
			completedAt: { type: Date, default: null },
			resultStatus: { type: String, trim: true, lowercase: true, default: "" },
		},
		lastErrorCode: { type: String, trim: true, default: "" },
		lastErrorMessage: { type: String, trim: true, default: "" },
		completedAt: { type: Date, default: null },
	},
	{ timestamps: true, minimize: false }
);

hotelRunnerFallbackNotificationOutboxSchema.index(
	{ status: 1, nextAttemptAt: 1, leaseUntil: 1, createdAt: 1 },
	{ name: "hotelrunner_fallback_notification_claim_queue" }
);

const HotelRunnerFallbackNotificationOutbox = mongoose.model(
	"HotelRunnerFallbackNotificationOutbox",
	hotelRunnerFallbackNotificationOutboxSchema
);

module.exports = HotelRunnerFallbackNotificationOutbox;
module.exports.TERMINAL_FALLBACK_STATUSES = TERMINAL_FALLBACK_STATUSES;
