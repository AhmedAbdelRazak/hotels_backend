/** @format */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const {
	buildExcludePendingOtaReviewFilter,
	buildPendingOtaReviewFilter,
	canManageOtaReservations,
	isOtaPlatformReviewPending,
	platformOtaScopeFilter,
	strictPlatformOtaHotelScopeFilter,
	validateGenericPendingOtaReviewLifecycleUpdate,
	validateOtaPlatformReviewActionState,
} = require("./otaReservationVisibility");

const pendingOtaReviewReservation = (overrides = {}) => ({
	otaPlatformReview: { status: "pending" },
	reservation_status: "OTA Platform Review",
	state: "OTA Platform Review",
	pendingConfirmation: { status: "", reason: "" },
	agentDecisionSnapshot: { status: "", reason: "" },
	...overrides,
});

test("dedicated OTA actions require a pending and internally consistent review lifecycle", () => {
	assert.deepEqual(
		validateOtaPlatformReviewActionState(pendingOtaReviewReservation()),
		{ ready: true },
	);

	const inconsistent = validateOtaPlatformReviewActionState(
		pendingOtaReviewReservation({
			reservation_status: "confirmed",
			state: "confirmed",
		}),
	);
	assert.equal(inconsistent.ready, false);
	assert.equal(inconsistent.statusCode, 409);
	assert.equal(inconsistent.code, "ota_review_lifecycle_inconsistent");

	const released = validateOtaPlatformReviewActionState(
		pendingOtaReviewReservation({ otaPlatformReview: { status: "released" } }),
	);
	assert.equal(released.code, "ota_review_not_pending");
});

test("generic reservation updates cannot move a pending OTA review lifecycle", () => {
	for (const field of [
		"reservation_status",
		"state",
		"pendingConfirmation",
		"pendingConfirmation.status",
		"agentDecisionSnapshot",
		"agentDecisionSnapshot.status",
		"otaPlatformReview",
		"otaPlatformReview.status",
	]) {
		const result = validateGenericPendingOtaReviewLifecycleUpdate(
			pendingOtaReviewReservation(),
			{ [field]: "confirmed" },
		);
		assert.equal(result.ready, false);
		assert.equal(result.statusCode, 409);
		assert.equal(result.code, "ota_review_dedicated_lifecycle_route_required");
		assert.deepEqual(result.fields, [field]);
	}

	assert.deepEqual(
		validateGenericPendingOtaReviewLifecycleUpdate(
			pendingOtaReviewReservation(),
			{ customer_details: { name: "Guest" } },
		),
		{ ready: true },
	);
	const existing = pendingOtaReviewReservation();
	assert.deepEqual(
		validateGenericPendingOtaReviewLifecycleUpdate(existing, {
			reservation_status: "ota_platform_review",
			state: " OTA Platform Review ",
			pendingConfirmation: { reason: "", status: "" },
			agentDecisionSnapshot: { reason: "", status: "" },
			otaPlatformReview: { status: " PENDING " },
			"pendingConfirmation.status": "",
			"agentDecisionSnapshot.status": "",
			"otaPlatformReview.status": "PENDING",
		}),
		{ ready: true },
	);
	assert.deepEqual(
		validateGenericPendingOtaReviewLifecycleUpdate(
			pendingOtaReviewReservation({
				otaPlatformReview: { status: "released" },
			}),
			{ state: "confirmed" },
		),
		{ ready: true },
	);
});

test("the OTA review queue contains pending records only, never cancelled/closed records", () => {
	assert.deepEqual(buildPendingOtaReviewFilter(), {
		"otaPlatformReview.status": "pending",
	});
	assert.deepEqual(buildExcludePendingOtaReviewFilter(), {
		"otaPlatformReview.status": { $ne: "pending" },
	});
	assert.equal(
		isOtaPlatformReviewPending({
			reservation_status: "cancelled",
			otaPlatformReview: { status: "closed" },
		}),
		false,
	);
});

test("only active platform OTA staff receive pricing-management authority", () => {
	assert.equal(
		canManageOtaReservations({
			activeUser: true,
			role: 1000,
			accessTo: ["OTAReservations"],
		}),
		true,
	);
	assert.equal(
		canManageOtaReservations({
			activeUser: true,
			role: 1000,
			accessTo: ["AllReservations"],
		}),
		false,
	);
	assert.equal(
		canManageOtaReservations({
			activeUser: false,
			role: 1000,
			accessTo: ["OTAReservations"],
		}),
		false,
	);
});

test("role 1000 is scoped whether it is primary or granted through roles", () => {
	const hotelId = new mongoose.Types.ObjectId();
	for (const actor of [
		{ role: 1000, hotelIdsWork: [hotelId] },
		{ role: 2, roles: [1000], hotelIdsWork: [hotelId] },
	]) {
		const scope = platformOtaScopeFilter(actor);
		assert.ok(scope);
		assert.equal(String(scope.$or[0].hotelId.$in[0]), String(hotelId));
	}
});

test("a scoped OTA admin without assigned hotels is denied instead of global", () => {
	assert.deepEqual(platformOtaScopeFilter({ role: 1000 }), {
		_id: { $exists: false },
	});
	assert.deepEqual(strictPlatformOtaHotelScopeFilter({ roles: [1000] }), {
		_id: { $exists: false },
	});
});

test("inbound-email PII scope includes assigned hotels only", () => {
	const hotelId = new mongoose.Types.ObjectId();
	const scope = strictPlatformOtaHotelScopeFilter({
		role: 1000,
		hotelsToSupport: [hotelId],
	});
	assert.deepEqual(scope, { hotelId: { $in: [hotelId] } });
	assert.equal(JSON.stringify(scope).includes("$exists"), false);
});
