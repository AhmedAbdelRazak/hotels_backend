/** @format */

"use strict";

const isLegacyReviewActive = (review = {}) =>
	String(review?.status || "").trim().toLowerCase() === "active";

const configuredVisibility = (review = {}, field) => {
	const value = review?.[field];
	if (typeof value === "boolean") return value;
	if (value === undefined || value === null) return isLegacyReviewActive(review);
	return false;
};

const hasReviewComment = (review = {}) =>
	String(review?.comment || "").trim().length > 0;

const resolveHotelReviewVisibility = (review = {}) => {
	const ratingVisible = configuredVisibility(review, "ratingVisible");
	const commentConfiguredVisible = configuredVisibility(
		review,
		"commentVisible",
	);
	const hasComment = hasReviewComment(review);
	const commentVisible = commentConfiguredVisible && hasComment;
	return {
		ratingVisible,
		commentVisible,
		commentConfiguredVisible,
		hasComment,
		hasPublicContent: ratingVisible || commentVisible,
		status: ratingVisible || commentVisible ? "active" : "inactive",
	};
};

// `status` remains a rollback safety projection for servers that predate the
// split visibility fields and would expose both rating and comment whenever a
// row is active. Partial rows therefore stay inactive in storage even though
// current readers expose whichever explicit part is public.
const legacyRollbackSafeReviewStatus = ({
	ratingVisible = false,
	commentVisible = false,
	hasComment = false,
} = {}) =>
	ratingVisible === true && (!hasComment || commentVisible === true)
		? "active"
		: "inactive";

// Missing/null visibility fields are legacy records. Their existing status is
// authoritative, so active legacy rows remain visible and inactive rows remain
// hidden without a migration.
const effectiveVisibilityMongoFilter = (field) => ({
	$or: [
		{ [field]: true },
		{
			$and: [{ [field]: { $in: [null] } }, { status: "active" }],
		},
	],
});

const effectiveRatingVisibilityMongoFilter = () =>
	effectiveVisibilityMongoFilter("ratingVisible");

const effectiveCommentVisibilityMongoFilter = () =>
	effectiveVisibilityMongoFilter("commentVisible");

const publicReviewContentMongoFilter = () => ({
	$or: [
		effectiveRatingVisibilityMongoFilter(),
		{
			$and: [
				effectiveCommentVisibilityMongoFilter(),
				{ comment: { $type: "string", $regex: /\S/ } },
			],
		},
	],
});

const effectiveVisibilityAggregationExpression = (field) => ({
	$eq: [
		{
			$ifNull: [`$${field}`, { $eq: ["$status", "active"] }],
		},
		true,
	],
});

const effectiveRatingVisibilityAggregationExpression = () =>
	effectiveVisibilityAggregationExpression("ratingVisible");

const effectiveCommentVisibilityAggregationExpression = () => ({
	$and: [
		effectiveVisibilityAggregationExpression("commentVisible"),
		{
			$ne: [
				{ $trim: { input: { $ifNull: ["$comment", ""] } } },
				"",
			],
		},
	],
});

const publicReviewContentAggregationExpression = () => ({
	$or: [
		effectiveRatingVisibilityAggregationExpression(),
		effectiveCommentVisibilityAggregationExpression(),
	],
});

const visibilityFieldCasValue = (value) =>
	value === undefined || value === null ? { $in: [null] } : value;

const buildHotelReviewVisibilityCasFilter = (review = {}) => ({
	_id: review._id,
	status: review.status,
	ratingVisible: visibilityFieldCasValue(review.ratingVisible),
	commentVisible: visibilityFieldCasValue(review.commentVisible),
});

module.exports = {
	buildHotelReviewVisibilityCasFilter,
	effectiveCommentVisibilityAggregationExpression,
	effectiveCommentVisibilityMongoFilter,
	effectiveRatingVisibilityAggregationExpression,
	effectiveRatingVisibilityMongoFilter,
	hasReviewComment,
	legacyRollbackSafeReviewStatus,
	publicReviewContentAggregationExpression,
	publicReviewContentMongoFilter,
	resolveHotelReviewVisibility,
};
