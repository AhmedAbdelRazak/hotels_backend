/** @format */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const {
	addReservationVersionBump,
	buildReservationSnapshotFilter,
} = require("../services/otaReviewConcurrency");

test("OTA review writes are tied to the exact pending reservation snapshot", () => {
	const reservation = {
		_id: new mongoose.Types.ObjectId(),
		hotelId: new mongoose.Types.ObjectId(),
		__v: 7,
		updatedAt: new Date("2026-07-23T12:00:00.000Z"),
	};
	const filter = buildReservationSnapshotFilter(reservation, {
		requirePendingReview: true,
		includeHotel: true,
	});

	assert.equal(filter._id, reservation._id);
	assert.equal(filter.hotelId, reservation.hotelId);
	assert.equal(filter.__v, 7);
	assert.equal(filter.updatedAt, reservation.updatedAt);
	assert.equal(filter["otaPlatformReview.status"], "pending");
});

test("revert guards can require the exact observed review status", () => {
	const reservation = {
		_id: new mongoose.Types.ObjectId(),
		__v: 3,
		otaPlatformReview: { status: "released" },
	};
	const filter = buildReservationSnapshotFilter(reservation, {
		expectedReviewStatus: reservation.otaPlatformReview.status,
	});
	assert.equal(filter["otaPlatformReview.status"], "released");
});

test("every guarded mutation advances the reservation version", () => {
	const update = addReservationVersionBump({
		$set: { state: "pending" },
		$inc: { retryCount: 1 },
	});

	assert.deepEqual(update.$set, { state: "pending" });
	assert.deepEqual(update.$inc, { retryCount: 1, __v: 1 });
});
