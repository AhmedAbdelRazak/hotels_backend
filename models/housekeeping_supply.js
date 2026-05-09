const mongoose = require("mongoose");

const housekeepingSupplySchema = new mongoose.Schema(
	{
		hotelId: {
			type: mongoose.Schema.Types.ObjectId,
			ref: "HotelDetails",
			required: true,
			index: true,
		},
		name: { type: String, required: true, trim: true },
		category: { type: String, default: "cleaning", trim: true, lowercase: true },
		unit: { type: String, default: "unit", trim: true },
		currentStock: { type: Number, default: 0, min: 0 },
		minimumStock: { type: Number, default: 0, min: 0 },
		estimatedUnitCost: { type: Number, default: 0, min: 0 },
		lastPurchasePrice: { type: Number, default: 0, min: 0 },
		supplier: { type: String, default: "", trim: true },
		notes: { type: String, default: "", trim: true },
		isActive: { type: Boolean, default: true },
		createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
		updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
	},
	{ timestamps: true }
);

housekeepingSupplySchema.index(
	{ hotelId: 1, name: 1 },
	{ unique: true, collation: { locale: "en", strength: 2 } }
);

module.exports = mongoose.model("HousekeepingSupply", housekeepingSupplySchema);
