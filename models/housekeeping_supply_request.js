const mongoose = require("mongoose");

const supplyRequestItemSchema = new mongoose.Schema(
	{
		supplyId: { type: mongoose.Schema.Types.ObjectId, ref: "HousekeepingSupply" },
		name: { type: String, required: true, trim: true },
		category: { type: String, default: "cleaning", trim: true, lowercase: true },
		quantity: { type: Number, required: true, min: 0.01 },
		unit: { type: String, default: "unit", trim: true },
		estimatedUnitCost: { type: Number, default: 0, min: 0 },
		estimatedTotal: { type: Number, default: 0, min: 0 },
	},
	{ _id: false }
);

const housekeepingSupplyRequestSchema = new mongoose.Schema(
	{
		hotelId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: "HotelDetails",
			required: true,
			index: true,
		},
		items: { type: [supplyRequestItemSchema], default: [] },
		totalEstimatedCost: { type: Number, default: 0, min: 0 },
		actualCost: { type: Number, default: 0, min: 0 },
		vendor: { type: String, default: "", trim: true },
		priority: {
			type: String,
			enum: ["normal", "urgent"],
			default: "normal",
			lowercase: true,
		},
		status: {
			type: String,
			enum: [
				"pending_finance",
				"approved",
				"rejected",
				"purchased",
				"received",
				"cancelled",
			],
			default: "pending_finance",
			index: true,
		},
		requestNotes: { type: String, default: "", trim: true },
		financeNotes: { type: String, default: "", trim: true },
		receivingNotes: { type: String, default: "", trim: true },
		requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
		financeReviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
		financeReviewedAt: Date,
		receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
		receivedAt: Date,
	},
	{ timestamps: true }
);

housekeepingSupplyRequestSchema.index({ hotelId: 1, status: 1, createdAt: -1 });

module.exports = mongoose.model(
	"HousekeepingSupplyRequest",
	housekeepingSupplyRequestSchema
);
