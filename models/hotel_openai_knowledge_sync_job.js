/** @format */

const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema;

const hotelOpenAiKnowledgeSyncJobSchema = new mongoose.Schema(
	{
		hotelId: {
			type: ObjectId,
			ref: "HotelDetails",
			required: true,
			unique: true,
			index: true,
		},
		status: {
			type: String,
			enum: ["pending", "processing", "retry", "completed", "failed"],
			default: "pending",
			index: true,
		},
		generation: { type: Number, default: 0 },
		runAfter: { type: Date, default: Date.now, index: true },
		lastTrigger: { type: String, default: "" },
		lastTriggerPaths: { type: [String], default: [] },
		lastObservedAt: { type: Date },
		lastObservedHotelUpdatedAt: { type: Date },
		lastKnownVectorStoreId: { type: String, default: "" },
		lastKnownFileId: { type: String, default: "" },
		attemptCount: { type: Number, default: 0 },
		consecutiveFailures: { type: Number, default: 0 },
		leaseOwner: { type: String, default: "" },
		leaseAcquiredAt: { type: Date },
		leaseUntil: { type: Date, index: true },
		lastStartedAt: { type: Date },
		lastCompletedAt: { type: Date },
		lastResult: { type: String, default: "" },
		lastSourceSha256: { type: String, default: "" },
		lastError: { type: String, default: "" },
	},
	{ timestamps: true }
);

hotelOpenAiKnowledgeSyncJobSchema.index({
	status: 1,
	runAfter: 1,
	leaseUntil: 1,
});

module.exports = mongoose.model(
	"HotelOpenAiKnowledgeSyncJob",
	hotelOpenAiKnowledgeSyncJobSchema
);
