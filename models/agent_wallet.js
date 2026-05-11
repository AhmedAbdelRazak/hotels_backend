/** @format */

const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema;

const agentWalletSchema = new mongoose.Schema(
	{
		hotelId: {
			type: ObjectId,
			ref: "HotelDetails",
			required: true,
			index: true,
		},
		ownerId: {
			type: ObjectId,
			ref: "User",
			default: null,
			index: true,
		},
		agentId: {
			type: ObjectId,
			ref: "User",
			required: true,
			index: true,
		},
		transactionType: {
			type: String,
			enum: ["deposit", "debit", "adjustment", "refund"],
			default: "deposit",
			index: true,
		},
		amount: {
			type: Number,
			required: true,
			default: 0,
		},
		currency: {
			type: String,
			default: "SAR",
			trim: true,
			uppercase: true,
		},
		note: {
			type: String,
			trim: true,
			default: "",
		},
		reference: {
			type: String,
			trim: true,
			default: "",
		},
		transactionDate: {
			type: Date,
			default: Date.now,
			index: true,
		},
		reservationId: {
			type: ObjectId,
			ref: "Reservations",
			default: null,
		},
		confirmationNumber: {
			type: String,
			trim: true,
			default: "",
		},
		attachments: [
			{
				public_id: {
					type: String,
					trim: true,
					default: "",
				},
				url: {
					type: String,
					trim: true,
					default: "",
				},
				fileName: {
					type: String,
					trim: true,
					default: "",
				},
				fileType: {
					type: String,
					trim: true,
					default: "",
				},
				fileSize: {
					type: Number,
					default: 0,
				},
				uploadedAt: {
					type: Date,
					default: Date.now,
				},
				uploadedBy: {
					type: Object,
					default: null,
				},
			},
		],
		status: {
			type: String,
			enum: ["posted", "void"],
			default: "posted",
			index: true,
		},
		createdBy: {
			type: Object,
			default: {
				_id: "",
				name: "",
				email: "",
				role: "",
			},
		},
		updatedBy: {
			type: Object,
			default: null,
		},
		voidedAt: {
			type: Date,
			default: null,
		},
		voidedBy: {
			type: Object,
			default: null,
		},
	},
	{ timestamps: true }
);

agentWalletSchema.index({ hotelId: 1, agentId: 1, transactionDate: -1 });

module.exports = mongoose.model("AgentWallet", agentWalletSchema);
