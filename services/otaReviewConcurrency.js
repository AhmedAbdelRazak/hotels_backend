/** @format */

"use strict";

const OTA_REVIEW_CONCURRENT_CHANGE_CODE = "ota_review_concurrent_change";

const reservationVersion = (reservation = {}) => {
	const parsed = Number(reservation.__v);
	return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
};

const buildReservationSnapshotFilter = (
	reservation = {},
	{
		requirePendingReview = false,
		expectedReviewStatus,
		includeHotel = false,
	} = {},
) => {
	const filter = {
		_id: reservation._id,
		__v: reservationVersion(reservation),
	};
	if (reservation.updatedAt) filter.updatedAt = reservation.updatedAt;
	if (requirePendingReview) {
		filter["otaPlatformReview.status"] = "pending";
	} else if (expectedReviewStatus !== undefined) {
		filter["otaPlatformReview.status"] = expectedReviewStatus;
	}
	if (includeHotel) filter.hotelId = reservation.hotelId || null;
	return filter;
};

const addReservationVersionBump = (update = {}) => ({
	...update,
	$inc: {
		...(update.$inc || {}),
		__v: 1,
	},
});

module.exports = {
	OTA_REVIEW_CONCURRENT_CHANGE_CODE,
	addReservationVersionBump,
	buildReservationSnapshotFilter,
	reservationVersion,
};
