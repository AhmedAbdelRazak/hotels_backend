/** @format */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const HotelReview = require("../models/hotel_review");
const {
	effectiveRatingVisibilityMongoFilter,
} = require("../services/hotelReviewVisibility");

const {
	guestReviewSummaryForHotel,
	loadActiveGuestReviewSummaryMap,
	__test: summary,
} = require("../services/jannatGuestReviewSummary");

test("guest review summary serialization exposes a compact real-rating shape", () => {
	assert.deepEqual(
		summary.serializeGuestReviewSummary({
			ratingCount: 4,
			ratingSum: 17,
			oneStar: 0,
			twoStar: 0,
			threeStar: 1,
			fourStar: 1,
			fiveStar: 2,
		}),
		{
			ratingCount: 4,
			ratingSum: 17,
			averageRating: 4.25,
			breakdown: { "1": 0, "2": 0, "3": 1, "4": 1, "5": 2 },
			hasRealRating: true,
		}
	);
	assert.deepEqual(summary.emptyGuestReviewSummary(), {
		ratingCount: 0,
		ratingSum: 0,
		averageRating: 0,
		breakdown: { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 },
		hasRealRating: false,
	});
});

test("bulk summary pipeline uses effective rating visibility and deduplicates ids", () => {
	const first = new mongoose.Types.ObjectId();
	const second = new mongoose.Types.ObjectId();
	const pipeline = summary.buildActiveGuestReviewSummaryPipeline([
		first,
		String(first),
		second,
		"not-an-object-id",
	]);

	assert.equal(pipeline.length, 2);
	assert.deepEqual(
		pipeline[0].$match.$or,
		effectiveRatingVisibilityMongoFilter().$or,
	);
	assert.deepEqual(
		pipeline[0].$match.hotelId.$in.map(String),
		[String(first), String(second)]
	);
	assert.equal(pipeline[1].$group._id, "$hotelId");
	assert.deepEqual(summary.buildActiveGuestReviewSummaryPipeline([]), []);
	assert.equal(
		HotelReview.schema.indexes().some(([fields]) =>
			fields.hotelId === 1 && fields.status === 1 && fields.rating === 1
		),
		true
	);
});

test("hotels without active reviews receive independent zero summaries", () => {
	const first = guestReviewSummaryForHotel(new Map(), new mongoose.Types.ObjectId());
	const second = guestReviewSummaryForHotel(new Map(), new mongoose.Types.ObjectId());
	first.breakdown["5"] = 10;

	assert.equal(first.hasRealRating, false);
	assert.equal(second.breakdown["5"], 0);
});

test("bulk loader executes one aggregation and maps only grouped summaries", async () => {
	const hotelId = new mongoose.Types.ObjectId();
	const originalAggregate = HotelReview.aggregate;
	let aggregateCalls = 0;
	let capturedPipeline = null;
	HotelReview.aggregate = (pipeline) => {
		aggregateCalls += 1;
		capturedPipeline = pipeline;
		return {
			exec: async () => [
				{
					_id: hotelId,
					ratingCount: 2,
					ratingSum: 9,
					fourStar: 1,
					fiveStar: 1,
				},
			],
		};
	};

	try {
		const summaries = await loadActiveGuestReviewSummaryMap([
			hotelId,
			new mongoose.Types.ObjectId(),
		]);
		assert.equal(aggregateCalls, 1);
		assert.deepEqual(
			capturedPipeline[0].$match.$or,
			effectiveRatingVisibilityMongoFilter().$or,
		);
		assert.deepEqual(summaries.get(String(hotelId)), {
			ratingCount: 2,
			ratingSum: 9,
			averageRating: 4.5,
			breakdown: { "1": 0, "2": 0, "3": 0, "4": 1, "5": 1 },
			hasRealRating: true,
		});
	} finally {
		HotelReview.aggregate = originalAggregate;
	}
});
