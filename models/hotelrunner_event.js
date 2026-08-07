/** @format */

const mongoose = require("mongoose");

const { ObjectId } = mongoose.Schema;

const hotelRunnerEventSchema = new mongoose.Schema(
	{
		hotelId: {
			type: ObjectId,
			ref: "HotelDetails",
			required: true,
			index: true,
		},
		eventKey: { type: String, trim: true, required: true, unique: true },
		messageUid: { type: String, trim: true, required: true },
		payloadHash: { type: String, trim: true, lowercase: true, required: true },
		canonicalHash: { type: String, trim: true, lowercase: true, default: "" },
		source: {
			type: String,
			trim: true,
			lowercase: true,
			enum: ["push", "pull"],
			default: "push",
		},
		hotelRunnerReservationId: { type: String, trim: true, required: true },
		hrNumber: { type: String, trim: true, default: "" },
		providerNumber: { type: String, trim: true, default: "" },
		channel: { type: String, trim: true, lowercase: true, default: "" },
		state: { type: String, trim: true, lowercase: true, default: "" },
		modified: { type: Boolean, default: false },
		sourceUpdatedAt: { type: Date, required: true, index: true },
		payload: { type: Object, required: true, select: false },
		status: {
			type: String,
			trim: true,
			lowercase: true,
			enum: [
				"pending",
				"processing",
				"completed",
				"ignored",
				"needs_mapping",
				"attention",
				"quarantined",
				"retry",
				"failed",
			],
			default: "pending",
			index: true,
		},
		attempts: { type: Number, default: 0 },
		nextAttemptAt: { type: Date, default: Date.now, index: true },
		leaseOwner: { type: String, trim: true, default: "" },
		leaseAcquiredAt: { type: Date, default: null },
		leaseUntil: { type: Date, default: null, index: true },
		finalRecoveryAttempted: { type: Boolean, default: false },
		finalRecoveryClaimedAt: { type: Date, default: null },
		integrityReason: { type: String, trim: true, default: "" },
		integrityConflict: { type: Boolean, default: false },
		integrityConflictCount: { type: Number, default: 0, min: 0 },
		integrityConflicts: { type: [Object], default: [], select: false },
		errorCode: { type: String, trim: true, default: "" },
		errorMessage: { type: String, trim: true, default: "" },
		reservationMongoId: {
			type: ObjectId,
			ref: "Reservations",
			default: null,
			index: true,
		},
		mirrorId: {
			type: ObjectId,
			ref: "HotelRunnerReservation",
			default: null,
		},
		result: { type: Object, default: {} },
		deliveryCount: { type: Number, default: 0 },
		lastReceivedAt: { type: Date, default: Date.now },
		remoteConfirmation: {
			status: {
				type: String,
				trim: true,
				lowercase: true,
				default: "not_required",
			},
			attempts: { type: Number, default: 0 },
			lastAttemptAt: { type: Date, default: null },
			confirmedAt: { type: Date, default: null },
			lastError: { type: String, trim: true, default: "" },
		},
		receivedAt: { type: Date, default: Date.now, index: true },
		processedAt: { type: Date, default: null },
	},
	{ timestamps: true, minimize: false }
);

hotelRunnerEventSchema.index(
	{ hotelId: 1, messageUid: 1 },
	{ name: "hotelrunner_property_message_uid" }
);
hotelRunnerEventSchema.index(
	{
		hotelId: 1,
		status: 1,
		nextAttemptAt: 1,
		leaseUntil: 1,
		sourceUpdatedAt: 1,
		createdAt: 1,
	},
	{ name: "hotelrunner_property_event_claim_queue" }
);
hotelRunnerEventSchema.index({
	hotelId: 1,
	hotelRunnerReservationId: 1,
	sourceUpdatedAt: 1,
});

module.exports = mongoose.model("HotelRunnerEvent", hotelRunnerEventSchema);
