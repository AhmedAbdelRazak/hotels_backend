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
});

const supportCaseSchema = new Schema({
	createdAt: {
		type: Date,
		default: Date.now,
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
	managerRatingAI: {
		type: Number,
		default: 0,
	},

	managerComments: {
		type: String,
		default: "",
	},
});

const SupportCase = mongoose.model("SupportCase", supportCaseSchema);

module.exports = SupportCase;
