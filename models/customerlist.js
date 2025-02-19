/** @format */

const mongoose = require("mongoose");

const customerlistSchema = new mongoose.Schema(
	{
		name: {
			type: String,
			trim: true,
			lowercase: true,
		},

		email: {
			type: String,
			trim: true,
			default: "",
		},

		phone: {
			type: String,
			trim: true,
			default: "",
		},

		country: {
			type: String,
			trim: true,
			default: "",
		},

		database: {
			type: String,
			trim: true,
			default: "",
		},

		schema: {
			type: String,
			trim: true,
			default: "",
		},

		email_phone: {
			type: Object,
			trim: true,
			default: {
				phoneCheck: false,
				emailCheck: false,
			},
		},
	},
	{ timestamps: true }
);

module.exports = mongoose.model("CustomerList", customerlistSchema);
