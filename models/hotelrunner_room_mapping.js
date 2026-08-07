/** @format */

const mongoose = require("mongoose");

const { ObjectId } = mongoose.Schema;

const hotelRunnerRoomMappingSchema = new mongoose.Schema(
	{
		hotelId: {
			type: ObjectId,
			ref: "HotelDetails",
			required: true,
			index: true,
		},
		invCode: { type: String, trim: true, required: true },
		rateCodes: { type: [String], default: [] },
		ratePlanCodes: { type: [String], default: [] },
		externalName: { type: String, trim: true, default: "" },
		externalNamePresentation: { type: String, trim: true, default: "" },
		isMaster: { type: Boolean, default: false },
		// A payload alone cannot tell us whether an inventory code is HotelRunner's
		// unmatched master fallback. Only the room-list endpoint may set this proof.
		roomListVerifiedAt: { type: Date, default: null },
		// Every complete room-list response receives one shared generation. This
		// makes it possible to distinguish a current verification from an older
		// mapping that disappeared from HotelRunner's latest complete response.
		roomListSyncGeneration: { type: String, trim: true, default: "" },
		roomListLastSeenAt: { type: Date, default: null },
		roomListRetiredAt: { type: Date, default: null },
		roomListVerificationState: {
			type: String,
			trim: true,
			lowercase: true,
			enum: ["unverified", "refreshing", "verified", "conflict", "retired"],
			default: "unverified",
		},
		variantConflict: { type: Boolean, default: false },
		variantConflictFields: { type: [String], default: [] },
		localRoomConfigId: { type: ObjectId, default: null },
		status: {
			type: String,
			trim: true,
			lowercase: true,
			enum: ["pending", "active", "disabled", "conflict"],
			default: "pending",
			index: true,
		},
		discoveredFrom: {
			type: String,
			trim: true,
			lowercase: true,
			enum: ["payload", "room_list", "manual"],
			default: "payload",
		},
		lastSeenAt: { type: Date, default: Date.now },
		updatedBy: { type: ObjectId, ref: "User", default: null },
		notes: { type: String, trim: true, default: "" },
	},
	{ timestamps: true }
);

hotelRunnerRoomMappingSchema.index(
	{ hotelId: 1, invCode: 1 },
	{ unique: true, name: "uniq_hotelrunner_inventory_mapping" }
);
hotelRunnerRoomMappingSchema.index({
	hotelId: 1,
	status: 1,
	invCode: 1,
});
hotelRunnerRoomMappingSchema.index({
	hotelId: 1,
	roomListSyncGeneration: 1,
});

module.exports = mongoose.model(
	"HotelRunnerRoomMapping",
	hotelRunnerRoomMappingSchema
);
