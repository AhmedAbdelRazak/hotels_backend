/** @format */

const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema;

const hotelOpenAiKnowledgeCleanupJobSchema = new mongoose.Schema(
	{
		hotelId: { type: ObjectId, ref: "HotelDetails", required: true, index: true },
		vectorStoreId: { type: String, required: true, unique: true, index: true },
		fileId: { type: String, default: "" },
		status: {
			type: String,
			enum: [
				"pending",
				"processing",
				"retry",
				"completed",
				"cancelled",
				"failed",
			],
			default: "pending",
			index: true,
		},
		deleteAfter: { type: Date, required: true, index: true },
		attemptCount: { type: Number, default: 0 },
		consecutiveFailures: { type: Number, default: 0 },
		leaseOwner: { type: String, default: "" },
		leaseUntil: { type: Date, index: true },
		lastAttemptAt: { type: Date },
		completedAt: { type: Date },
		lastError: { type: String, default: "" },
	},
	{ timestamps: true }
);

hotelOpenAiKnowledgeCleanupJobSchema.index({
	status: 1,
	deleteAfter: 1,
	leaseUntil: 1,
});

module.exports = mongoose.model(
	"HotelOpenAiKnowledgeCleanupJob",
	hotelOpenAiKnowledgeCleanupJobSchema
);
