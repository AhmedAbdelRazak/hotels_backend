// models/aiagent_learning.js
const mongoose = require("mongoose");
const { Schema, Types } = mongoose;

const participantSchema = new Schema(
	{
		speakerName: { type: String, default: "" },
		role: {
			type: String,
			enum: ["client", "support", "system", "unknown"],
			default: "unknown",
		},
	},
	{ _id: false }
);

const conversationTurnSchema = new Schema(
	{
		sequence: { type: Number, default: 0 },
		speakerName: { type: String, default: "" },
		role: {
			type: String,
			enum: ["client", "support", "system", "unknown"],
			default: "unknown",
		},
		message: { type: String, required: true },
		date: { type: Date, default: null },
	},
	{ _id: false }
);

const AIAgentLearningSchema = new Schema(
	{
		sourceType: {
			type: String,
			enum: ["support_case", "manual_chat"],
			default: "support_case",
			index: true,
		},

		// Canonical key for learning created from SupportCase records.
		caseId: {
			type: Types.ObjectId,
			ref: "SupportCase",
			default: null,
		},

		// Back-compat fields. Do not make these unique.
		supportCaseId: {
			type: Types.ObjectId,
			ref: "SupportCase",
			index: true,
			default: null,
		},
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

		model: { type: String, default: "" },
		messageCount: { type: Number, default: 0 },
		sourceHash: { type: String, default: "", index: true },

		chatTitle: {
			type: String,
			default: "",
			trim: true,
			maxlength: 140,
		},
		chatKeywords: {
			type: [String],
			default: [],
			index: true,
		},
		conversation: {
			type: [conversationTurnSchema],
			default: [],
		},
		language: { type: String, default: "English", maxlength: 80 },
		participants: { type: [participantSchema], default: [] },
		customerIntent: { type: String, default: "", maxlength: 500 },
		supportResolution: { type: String, default: "", maxlength: 800 },
		learningNotes: { type: [String], default: [] },
		responseGuidance: { type: [String], default: [] },
		hotelName: { type: String, default: "", trim: true, maxlength: 180 },
		source: {
			type: String,
			enum: ["support_case", "manual_paste", "messenger", "whatsapp", "other"],
			default: "support_case",
		},
		rawText: {
			type: String,
			default: "",
			select: false,
		},
		aiCleaned: { type: Boolean, default: false },
		analysisModel: { type: String, default: "" },
		confidenceScore: { type: Number, default: 0 },
		status: {
			type: String,
			enum: ["active", "archived"],
			default: "active",
			index: true,
		},
		createdBy: {
			userId: { type: Types.ObjectId, ref: "User", default: null },
			name: { type: String, default: "" },
			email: { type: String, default: "" },
		},

		// Analysis output for support-case generated guidance.
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

// Mirror support-case ids only when this record is tied to a SupportCase.
AIAgentLearningSchema.pre("save", function (next) {
	if (!this.caseId && (this.supportCaseId || this.sourceCaseId)) {
		this.caseId = this.supportCaseId || this.sourceCaseId;
	}
	if (!this.supportCaseId && this.caseId) this.supportCaseId = this.caseId;
	if (!this.sourceCaseId && this.caseId) this.sourceCaseId = this.caseId;
	next();
});

AIAgentLearningSchema.index({ hotelId: 1, updatedAt: -1 });
AIAgentLearningSchema.index({ sourceType: 1, status: 1, updatedAt: -1 });
AIAgentLearningSchema.index({
	hotelId: 1,
	sourceType: 1,
	status: 1,
	updatedAt: -1,
});
AIAgentLearningSchema.index({ chatKeywords: 1, sourceType: 1, status: 1 });

module.exports = mongoose.model("AiAgentLearning", AIAgentLearningSchema);
