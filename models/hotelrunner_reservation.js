/** @format */

const mongoose = require("mongoose");

const { ObjectId } = mongoose.Schema;

const hotelRunnerReservationSchema = new mongoose.Schema(
	{
		hotelId: {
			type: ObjectId,
			ref: "HotelDetails",
			required: true,
			index: true,
		},
		hrIdFingerprint: { type: String, trim: true, lowercase: true, required: true },
		hotelRunnerReservationId: { type: String, trim: true, required: true },
		hrNumber: { type: String, trim: true, default: "" },
		providerNumber: { type: String, trim: true, default: "" },
		hrNumberAliases: { type: [String], default: [] },
		providerNumberAliases: { type: [String], default: [] },
		channel: { type: String, trim: true, lowercase: true, default: "" },
		channelDisplay: { type: String, trim: true, default: "" },
		sourceDisplay: { type: String, trim: true, default: "" },
		state: { type: String, trim: true, lowercase: true, default: "" },
		modified: { type: Boolean, default: false },
		observedSourceUpdatedAt: { type: Date, required: true, index: true },
		observedCanonicalHash: {
			type: String,
			trim: true,
			lowercase: true,
			required: true,
		},
		appliedSourceUpdatedAt: { type: Date, default: null, index: true },
		appliedCanonicalHash: {
			type: String,
			trim: true,
			lowercase: true,
			default: "",
		},
		lastMessageUid: { type: String, trim: true, required: true },
		reservationMongoId: {
			type: ObjectId,
			ref: "Reservations",
			default: null,
			index: true,
		},
		linkMethod: { type: String, trim: true, lowercase: true, default: "" },
		linkedAt: { type: Date, default: null },
		linkEvidence: { type: Object, default: {} },
		identityConflict: { type: Boolean, default: false },
		projectionStatus: {
			type: String,
			trim: true,
			lowercase: true,
			enum: [
				"pending",
				"created",
				"updated",
				"cancelled",
				"ignored",
				"needs_mapping",
				"quarantined",
			],
			default: "pending",
			index: true,
		},
		projectionVersion: { type: Number, default: 0 },
		normalizedSnapshot: { type: Object, required: true, select: false },
		lastAppliedProjection: { type: Object, default: {}, select: false },
		lastResult: { type: Object, default: {} },
		lastErrorCode: { type: String, trim: true, default: "" },
		lastErrorMessage: { type: String, trim: true, default: "" },
	},
	{ timestamps: true, minimize: false }
);

hotelRunnerReservationSchema.index(
	{ hotelId: 1, hotelRunnerReservationId: 1 },
	{ unique: true, name: "uniq_hotelrunner_property_reservation" }
);
hotelRunnerReservationSchema.index({ hotelId: 1, hrNumber: 1 });
hotelRunnerReservationSchema.index({ hotelId: 1, providerNumber: 1 });
hotelRunnerReservationSchema.index(
	{ reservationMongoId: 1 },
	{
		unique: true,
		name: "uniq_hotelrunner_linked_pms_reservation",
		partialFilterExpression: { reservationMongoId: { $type: "objectId" } },
	}
);
hotelRunnerReservationSchema.index({
	hotelId: 1,
	state: 1,
	observedSourceUpdatedAt: -1,
});

module.exports = mongoose.model(
	"HotelRunnerReservation",
	hotelRunnerReservationSchema
);
