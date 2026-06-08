const mongoose = require("mongoose");
const Schema = mongoose.Schema;

const conversationSchema = new Schema({
	messageBy: {
		customerName: { type: String, required: true },
		customerEmail: { type: String, required: true },
		userId: { type: String },
	},
	message: {
		type: String,
		required: true,
	},
	date: {
		type: Date,
		default: Date.now,
	},
	inquiryAbout: {
		type: String,
		required: true,
	},
	inquiryDetails: {
		type: String,
		required: false,
	},
	seenByAdmin: {
		type: Boolean,
		default: false,
	},
	seenByHotel: {
		type: Boolean,
		default: false,
	},
	seenByCustomer: {
		type: Boolean,
		default: false,
	},
	isAi: {
		type: Boolean,
		default: false,
	},
	isSystem: {
		type: Boolean,
		default: false,
	},
	clientTag: {
		type: String,
		default: "",
	},
	preferredLanguage: {
		type: String,
		default: "",
	},
	preferredLanguageCode: {
		type: String,
		default: "",
	},
	quickReplies: [
		{
			label: { type: String, trim: true, maxlength: 80 },
			value: { type: String, trim: true, maxlength: 240 },
			action: { type: String, trim: true, maxlength: 60 },
		},
	],
});

const supportCaseSchema = new Schema({
	createdAt: {
		type: Date,
		default: Date.now,
	},
	updatedAt: {
		type: Date,
		default: Date.now,
	},
	closedAt: {
		type: Date,
		default: null,
	},
	rating: {
		type: Number,
		default: null,
	},
	closedBy: {
		type: String,
		enum: ["client", "csr", null],
		default: null,
	},
	supporterId: {
		type: Schema.Types.ObjectId,
		ref: "User",
	},
	supporterName: {
		type: String,
		default: "",
	},
	targetUserId: {
		type: Schema.Types.ObjectId,
		ref: "User",
		default: null,
	},
	targetUserName: {
		type: String,
		default: "",
	},
	targetUserRole: {
		type: String,
		default: "",
	},
	caseStatus: {
		type: String,
		default: "open",
	},
	hotelId: {
		type: Schema.Types.ObjectId,
		ref: "HotelDetails",
		required: false,
	},
	openedBy: {
		type: String,
		enum: ["super admin", "hotel owner", "client"],
		required: true,
	},
	preferredLanguage: {
		type: String,
		default: "English",
	},
	preferredLanguageCode: {
		type: String,
		default: "en",
	},
	clientName: {
		type: String,
		default: "",
	},
	clientContact: {
		type: String,
		default: "",
	},
	clientContactType: {
		type: String,
		enum: ["", "email", "phone"],
		default: "",
	},
	conversation: [conversationSchema],
	displayName1: {
		type: String,
		required: true, // Ensure the displayName1 is always provided
	},
	displayName2: {
		type: String,
		required: true, // Ensure the displayName2 is always provided
	},
	aiRelated: {
		type: Boolean,
		default: false,
	},
	aiToRespond: {
		type: Boolean,
		default: false,
	},
	aiResponderName: {
		type: String,
		default: "",
	},
	aiPausedAt: {
		type: Date,
		default: null,
	},
	aiHandoffReason: {
		type: String,
		default: "",
	},
	escalationStatus: {
		type: String,
		enum: ["none", "active", "addressed"],
		default: "none",
	},
	escalationReason: {
		type: String,
		default: "",
	},
	escalationSource: {
		type: String,
		enum: ["", "ai", "admin", "client", "system"],
		default: "",
	},
	escalatedAt: {
		type: Date,
		default: null,
	},
	escalatedBy: {
		type: Schema.Types.ObjectId,
		ref: "User",
		default: null,
	},
	escalationAddressedAt: {
		type: Date,
		default: null,
	},
	escalationAddressedBy: {
		type: Schema.Types.ObjectId,
		ref: "User",
		default: null,
	},
	escalationAddressedNote: {
		type: String,
		default: "",
	},
	humanTakeoverAt: {
		type: Date,
		default: null,
	},
	humanTakeoverBy: {
		type: Schema.Types.ObjectId,
		ref: "User",
		default: null,
	},
	managerRatingAI: {
		type: Number,
		default: 0,
	},

	managerComments: {
		type: String,
		default: "",
	},
});

supportCaseSchema.index({ openedBy: 1, caseStatus: 1, updatedAt: 1 });
supportCaseSchema.index({ openedBy: 1, clientContact: 1, updatedAt: -1 });
supportCaseSchema.index({
	openedBy: 1,
	caseStatus: 1,
	escalationStatus: 1,
	updatedAt: -1,
});
supportCaseSchema.index({ openedBy: 1, hotelId: 1, displayName1: 1, updatedAt: -1 });
supportCaseSchema.index({
	openedBy: 1,
	"conversation.messageBy.customerEmail": 1,
	updatedAt: -1,
});
supportCaseSchema.index({
	openedBy: 1,
	"conversation.messageBy.userId": 1,
	updatedAt: -1,
});

const SupportCase = mongoose.model("SupportCase", supportCaseSchema);

module.exports = SupportCase;
