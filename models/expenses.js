const mongoose = require("mongoose");

const expenseSchema = new mongoose.Schema(
	{
		label: { type: String, required: true, trim: true },
		description: { type: String, default: "", trim: true },
		amount: { type: Number, required: true, min: 0 },
		currency: { type: String, default: "SAR" },
		hotelId: { type: mongoose.Schema.Types.ObjectId, ref: "HotelDetails" },
		createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
		updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
		expenseDate: { type: Date, default: Date.now },
	},
	{ timestamps: true }
);

module.exports = mongoose.model("Expense", expenseSchema);
