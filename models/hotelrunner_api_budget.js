/** @format */

const mongoose = require("mongoose");

const hotelRunnerApiBudgetSchema = new mongoose.Schema(
	{
		bucketKey: { type: String, trim: true, required: true, unique: true },
		scope: {
			type: String,
			trim: true,
			lowercase: true,
			enum: ["property_day", "property_minute", "application_minute"],
			required: true,
		},
		count: { type: Number, default: 0 },
		limit: { type: Number, required: true },
		expiresAt: { type: Date, required: true },
	},
	{ timestamps: true }
);

hotelRunnerApiBudgetSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model(
	"HotelRunnerApiBudget",
	hotelRunnerApiBudgetSchema
);
