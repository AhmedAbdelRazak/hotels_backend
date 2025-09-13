// models/aiagent_learning.js
const mongoose = require("mongoose");
const { Schema, Types } = mongoose;

const AIAgentLearningSchema = new Schema(
	{
		// Canonical unique key
		caseId: {
			type: Types.ObjectId,
			ref: "SupportCase",
			required: true,
			unique: true,
			index: true,
		},

		// Back-compat fields — do NOT make these unique
		supportCaseId: {
			type: Types.ObjectId,
			ref: "SupportCase",
			index: true,
			default: null,
		},
		// Legacy field some DBs still have a unique index on
		sourceCaseId: {
			type: Types.ObjectId,
			ref: "SupportCase",
			index: true,
			default: null,
		},

		hotelId: {
			type: Types.ObjectId,
			ref: "HotelDetails",
			index: true,
			sparse: true,
		},

		// meta
		model: { type: String, default: "" },
		messageCount: { type: Number, default: 0 },
		sourceHash: { type: String, default: "", index: true },

		// analysis output
		summary: { type: String, default: "" },
		steps: [{ type: String }],
		decisionRules: [{ type: String }],
		recommendedResponses: [{ type: String }],
		commonQuestions: [{ type: String }],
		qualityScore: { type: Number, default: 0 },
		tags: [{ type: String }],
	},
	{ timestamps: true }
);

// Mirror related fields to keep them in sync and avoid nulls
AIAgentLearningSchema.pre("save", function (next) {
	if (!this.caseId && (this.supportCaseId || this.sourceCaseId)) {
		this.caseId = this.supportCaseId || this.sourceCaseId;
	}
	if (!this.supportCaseId && this.caseId) this.supportCaseId = this.caseId;
	if (!this.sourceCaseId && this.caseId) this.sourceCaseId = this.caseId;
	next();
});

AIAgentLearningSchema.index({ hotelId: 1, updatedAt: -1 });

module.exports = mongoose.model("AiAgentLearning", AIAgentLearningSchema);
