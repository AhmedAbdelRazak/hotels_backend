/** @format */

const mongoose = require("mongoose");

const hotelOpenAiKnowledgeSyncCheckpointSchema = new mongoose.Schema(
	{
		_id: { type: String, required: true },
		resumeToken: { type: mongoose.Schema.Types.Mixed, default: null },
		lastEventAt: { type: Date },
		lastReconciledAt: { type: Date },
		lastReconciliationReason: { type: String, default: "" },
	},
	{ timestamps: true }
);

module.exports = mongoose.model(
	"HotelOpenAiKnowledgeSyncCheckpoint",
	hotelOpenAiKnowledgeSyncCheckpointSchema
);
