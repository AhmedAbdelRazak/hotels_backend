const mongoose = require("mongoose");

const expenseSchema = new mongoose.Schema(
	{
		label: { type: String, required: true, trim: true },
		description: { type: String, default: "", trim: true },
		amount: { type: Number, required: true, min: 0 },
		paid_amount: { type: Number, required: true, min: 0, default: 0 },
		currency: { type: String, default: "SAR" },
		receipt: {
			public_id: { type: String, required: true, trim: true },
			url: { type: String, required: true, trim: true },
			fileName: { type: String, default: "", trim: true },
			fileType: { type: String, default: "", trim: true },
		},
		hotelId: { type: mongoose.Schema.Types.ObjectId, ref: "HotelDetails" },
		createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
		updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
		expenseDate: { type: Date, required: true },
	},
	{ timestamps: true }
);

module.exports = mongoose.model("Expense", expenseSchema);
