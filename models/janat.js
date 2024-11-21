/** @format */

const mongoose = require("mongoose");

const janatSchema = new mongoose.Schema(
	{
		janatLogo: {
			type: Object,
			trim: true,
			default: {
				public_id: "",
				url: "",
			},
		},

		homeMainBanners: {
			type: Array,
			trim: true,
			default: [
				{
					public_id: "",
					url: "",
				},
			],
		},

		homeSecondBanner: {
			type: Object,
			trim: true,
			default: {
				public_id: "",
				url: "",
			},
		},

		contactUsBanner: {
			type: Object,
			trim: true,
			default: {
				public_id: "",
				url: "",
			},
		},

		aboutUsBanner: {
			type: Object,
			trim: true,
			default: {
				public_id: "",
				url: "",
			},
		},

		aboutUsPhoto: {
			type: Object,
			trim: true,
			default: {
				public_id: "",
				url: "",
			},
		},

		hotelPageBanner: {
			type: Object,
			trim: true,
			default: {
				public_id: "",
				url: "",
			},
		},

		termsAndConditionEnglish: {
			type: String,
			trim: true,
		},

		termsAndConditionArabic: {
			type: String,
			trim: true,
		},

		termsAndConditionEnglish_B2B: {
			type: String,
			trim: true,
		},

		termsAndConditionArabic_B2B: {
			type: String,
			trim: true,
		},

		aboutUsEnglish: {
			type: String,
			trim: true,
		},

		aboutUsArabic: {
			type: String,
			trim: true,
		},

		middleSectionEnglish: {
			type: String,
			trim: true,
		},

		middleSectionArabic: {
			type: String,
			trim: true,
		},
	},
	{ timestamps: true }
);

module.exports = mongoose.model("Janat", janatSchema);
