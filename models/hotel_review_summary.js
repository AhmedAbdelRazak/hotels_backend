/** @format */

"use strict";

const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema;

const breakdownSchema = new mongoose.Schema(
	{
		oneStar: { type: Number, min: 0, default: 0 },
		twoStar: { type: Number, min: 0, default: 0 },
		threeStar: { type: Number, min: 0, default: 0 },
		fourStar: { type: Number, min: 0, default: 0 },
		fiveStar: { type: Number, min: 0, default: 0 },
	},
	{ _id: false }
);

const hotelReviewSummarySchema = new mongoose.Schema(
	{
		hotelId: {
			type: ObjectId,
			ref: "HotelDetails",
			required: true,
			immutable: true,
		},
		ratingCount: { type: Number, min: 0, default: 0 },
		ratingSum: { type: Number, min: 0, default: 0 },
		breakdown: { type: breakdownSchema, default: () => ({}) },
	},
	{ timestamps: true }
);

hotelReviewSummarySchema.index(
	{ hotelId: 1 },
	{ unique: true, name: "uniq_hotel_review_summary" }
);

module.exports = mongoose.model("HotelReviewSummary", hotelReviewSummarySchema);
