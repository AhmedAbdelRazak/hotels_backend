/** @format */

"use strict";

const mongoose = require("mongoose");
const HotelReview = require("../models/hotel_review");

const serializeGuestReviewSummary = (row = {}) => {
	const ratingCount = Math.max(0, Math.trunc(Number(row.ratingCount || 0)));
	const ratingSum = Math.max(0, Number(row.ratingSum || 0));
	const averageRating = ratingCount
		? Number((ratingSum / ratingCount).toFixed(2))
		: 0;

	return {
		ratingCount,
		ratingSum,
		averageRating,
		breakdown: {
			"1": Math.max(0, Math.trunc(Number(row.oneStar || 0))),
			"2": Math.max(0, Math.trunc(Number(row.twoStar || 0))),
			"3": Math.max(0, Math.trunc(Number(row.threeStar || 0))),
			"4": Math.max(0, Math.trunc(Number(row.fourStar || 0))),
			"5": Math.max(0, Math.trunc(Number(row.fiveStar || 0))),
		},
		hasRealRating: ratingCount > 0,
	};
};

const emptyGuestReviewSummary = () => serializeGuestReviewSummary();

const normalizedHotelObjectIds = (hotelIds = []) => {
	const uniqueIds = new Map();
	(Array.isArray(hotelIds) ? hotelIds : []).forEach((value) => {
		const id = String(value?._id || value?.id || value || "").trim();
		if (!mongoose.Types.ObjectId.isValid(id) || uniqueIds.has(id)) return;
		uniqueIds.set(id, mongoose.Types.ObjectId(id));
	});
	return [...uniqueIds.values()];
};

const buildActiveGuestReviewSummaryPipeline = (hotelIds = []) => {
	const objectIds = normalizedHotelObjectIds(hotelIds);
	if (!objectIds.length) return [];

	return [
		{
			$match: {
				hotelId: { $in: objectIds },
				status: "active",
			},
		},
		{
			$group: {
				_id: "$hotelId",
				ratingCount: { $sum: 1 },
				ratingSum: { $sum: "$rating" },
				oneStar: { $sum: { $cond: [{ $eq: ["$rating", 1] }, 1, 0] } },
				twoStar: { $sum: { $cond: [{ $eq: ["$rating", 2] }, 1, 0] } },
				threeStar: { $sum: { $cond: [{ $eq: ["$rating", 3] }, 1, 0] } },
				fourStar: { $sum: { $cond: [{ $eq: ["$rating", 4] }, 1, 0] } },
				fiveStar: { $sum: { $cond: [{ $eq: ["$rating", 5] }, 1, 0] } },
			},
		},
	];
};

const loadActiveGuestReviewSummaryMap = async (hotelIds = []) => {
	const pipeline = buildActiveGuestReviewSummaryPipeline(hotelIds);
	if (!pipeline.length) return new Map();

	const rows = await HotelReview.aggregate(pipeline).exec();
	return new Map(
		rows.map((row) => [
			String(row._id),
			serializeGuestReviewSummary(row),
		])
	);
};

const guestReviewSummaryForHotel = (summaryMap, hotelId) => {
	const id = String(hotelId?._id || hotelId?.id || hotelId || "").trim();
	const summary = summaryMap instanceof Map ? summaryMap.get(id) : null;
	return summary || emptyGuestReviewSummary();
};

module.exports = {
	guestReviewSummaryForHotel,
	loadActiveGuestReviewSummaryMap,
	__test: {
		buildActiveGuestReviewSummaryPipeline,
		emptyGuestReviewSummary,
		normalizedHotelObjectIds,
		serializeGuestReviewSummary,
	},
};
