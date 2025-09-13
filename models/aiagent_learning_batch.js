// models/aiagent_learning_batch.js
const mongoose = require("mongoose");
const { Schema, Types } = mongoose;

const AIAgentLearningBatch = new Schema(
	{
		batchKey: { type: String, index: true },
		model: { type: String, default: "" },
		params: { type: Object, default: {} },

		supportCaseIds: [{ type: Types.ObjectId, ref: "SupportCase" }],
		learningIds: [{ type: Types.ObjectId, ref: "AiAgentLearning" }],

		counts: {
			candidates: { type: Number, default: 0 },
			created: { type: Number, default: 0 },
			updated: { type: Number, default: 0 },
			skipped: { type: Number, default: 0 },
			totalAnalyzed: { type: Number, default: 0 },
		},

		combinedSummary: { type: String, default: "" },
		topics: [{ type: String }],
		combinedPlaybook: [
			new Schema(
				{
					title: String,
					steps: [String],
					dos: [String],
					donts: [String],
					exemplar: String,
				},
				{ _id: false }
			),
		],
	},
	{ timestamps: true }
);

AIAgentLearningBatch.index({ createdAt: -1 });

module.exports = mongoose.model("AiAgentLearningBatch", AIAgentLearningBatch);
