// models/aiagent_training_chat.js
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
	},
	{ _id: false }
);

const aiAgentTrainingChatSchema = new Schema(
	{
		chatTitle: {
			type: String,
			required: true,
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

		summary: { type: String, default: "", maxlength: 2500 },
		language: { type: String, default: "English", maxlength: 80 },
		participants: { type: [participantSchema], default: [] },
		customerIntent: { type: String, default: "", maxlength: 500 },
		supportResolution: { type: String, default: "", maxlength: 800 },
		learningNotes: { type: [String], default: [] },
		responseGuidance: { type: [String], default: [] },

		hotelId: {
			type: Types.ObjectId,
			ref: "HotelDetails",
			default: null,
			index: true,
		},
		hotelName: { type: String, default: "", trim: true, maxlength: 180 },

		source: {
			type: String,
			enum: ["manual_paste", "messenger", "whatsapp", "other"],
			default: "manual_paste",
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
	},
	{ timestamps: true }
);

aiAgentTrainingChatSchema.index({ status: 1, updatedAt: -1 });
aiAgentTrainingChatSchema.index({ hotelId: 1, status: 1, updatedAt: -1 });
aiAgentTrainingChatSchema.index({ chatKeywords: 1, status: 1 });

module.exports = mongoose.model(
	"AiAgentTrainingChat",
	aiAgentTrainingChatSchema
);
