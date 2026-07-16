/** @format */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const express = require("express");
const fetch = require("node-fetch");
const mongoose = require("mongoose");

process.env.HOTEL_REVIEW_DATA_SECRET =
	process.env.HOTEL_REVIEW_DATA_SECRET || "hotel-review-regression-secret";

const HotelReview = require("../models/hotel_review");
const HotelReviewSummary = require("../models/hotel_review_summary");
const HotelReviewInvitation = require("../models/hotel_review_invitation");
const { __test: review } = require("../controllers/hoteldetails");
const visibility = require("../services/hotelReviewVisibility");
const {
	hotelReviewJsonParser,
} = require("../services/hotelReviewJsonParser");

test("guest review input requires a whole-number rating and both names", () => {
	const valid = review.validateReviewPayload({
		rating: "5",
		comment: "A comfortable stay.",
		firstName: "Ahmed",
		lastName: "Abdelrazak",
		confirmationNumber: "  ABC-123  ",
	});
	assert.equal(valid.rating, 5);
	assert.equal(valid.firstName, "Ahmed");
	assert.equal(valid.lastName, "Abdelrazak");
	assert.equal(valid.confirmationNumber, "abc-123");

	assert.throws(
		() =>
			review.validateReviewPayload({
				rating: 5,
				firstName: "Ahmed",
				lastName: "",
			}),
		/Last name is required/
	);
	assert.throws(
		() =>
			review.validateReviewPayload({
				rating: 4.5,
				firstName: "Ahmed",
				lastName: "A",
			}),
		/whole-number rating/
	);
});

test("authenticated review validation ignores spoofed submitted names", () => {
	const value = review.validateReviewPayload(
		{
			rating: 4,
			comment: "Thank you",
			firstName: { forged: true },
			lastName: "Forged",
		},
		{ authenticated: true }
	);
	assert.equal(value.firstName, "");
	assert.equal(value.lastName, "");
});

test("rating parsing rejects coercible booleans, arrays, and objects", () => {
	assert.equal(review.parseStrictRating(5), 5);
	assert.equal(review.parseStrictRating(" 4 "), 4);
	for (const invalid of [true, false, [5], [], { value: 5 }, "4.0", "05", 4.5]) {
		assert.equal(review.parseStrictRating(invalid), null, JSON.stringify(invalid));
	}
});

test("review fields reject markup, control characters, and oversized comments", () => {
	assert.throws(
		() =>
			review.validateReviewPayload({
				rating: 1,
				comment: "<script>alert(1)</script>",
				firstName: "A",
				lastName: "B",
			}),
		/plain text/
	);
	assert.throws(
		() =>
			review.validateReviewPayload({
				rating: 1,
				comment: "bad\u0000text",
				firstName: "A",
				lastName: "B",
			}),
		/unsupported characters/
	);
	assert.throws(
		() =>
			review.validateReviewPayload({
				rating: 1,
				comment: "x".repeat(2001),
				firstName: "A",
				lastName: "B",
			}),
		/too long/
	);
});

test("public display names retain the first name and mask the surname", () => {
	assert.equal(review.buildPublicDisplayName("Ahmed", "Abdelrazak"), "Ahmed A.");
	assert.equal(
		review.buildPublicDisplayName("\u0623\u062d\u0645\u062f", "\u0645\u062d\u0645\u062f"),
		"\u0623\u062d\u0645\u062f \u0645."
	);
	assert.equal(review.buildPublicDisplayName("Mona", ""), "Mona");
});

test("hotel slugs are canonical and safely matched", () => {
	assert.equal(review.canonicalHotelSlug(" Zad Ajyad "), "zad-ajyad");
	const regex = review.buildHotelSlugRegex("zad-ajyad");
	assert.equal(regex.test("zad ajyad"), true);
	assert.equal(regex.test("zad-ajyad"), true);
	assert.equal(regex.test("unrelated"), false);
});

test("summary serialization exposes real-review state and a complete breakdown", () => {
	const summary = review.serializeSummary({
		ratingCount: 3,
		ratingSum: 13,
		breakdown: { oneStar: 0, twoStar: 0, threeStar: 1, fourStar: 0, fiveStar: 2 },
	});
	assert.deepEqual(summary, {
		ratingCount: 3,
		ratingSum: 13,
		averageRating: 4.33,
		breakdown: { "1": 0, "2": 0, "3": 1, "4": 0, "5": 2 },
		hasRealRating: true,
	});
	assert.equal(review.serializeSummary(null).hasRealRating, false);
});

test("summary freshness and repair guards reject stale or concurrently changed rows", () => {
	const id = new mongoose.Types.ObjectId();
	const updatedAt = new Date("2026-07-12T12:00:00.000Z");
	const summary = {
		_id: id,
		updatedAt,
		ratingCount: 2,
		ratingSum: 9,
		breakdown: { oneStar: 0, twoStar: 0, threeStar: 0, fourStar: 1, fiveStar: 1 },
	};
	assert.equal(
		review.summaryIsFreshForSource(summary, {
			latestReview: { updatedAt },
			activeCount: 2,
		}),
		true
	);
	assert.equal(
		review.summaryIsFreshForSource(summary, {
			latestReview: { updatedAt: new Date("2026-07-12T12:00:01.000Z") },
			activeCount: 2,
		}),
		false
	);
	assert.equal(
		review.summaryIsFreshForSource(summary, {
			latestReview: { updatedAt },
			activeCount: 3,
		}),
		false
	);
	assert.deepEqual(review.buildSummaryCompareAndSwapFilter(summary), {
		_id: id,
		updatedAt,
		ratingCount: 2,
		ratingSum: 9,
		"breakdown.oneStar": 0,
		"breakdown.twoStar": 0,
		"breakdown.threeStar": 0,
		"breakdown.fourStar": 1,
		"breakdown.fiveStar": 1,
	});
});

test("public review serialization shows both legacy-active rating and comment", () => {
	const publicReview = review.serializePublicReview({
		_id: new mongoose.Types.ObjectId(),
		rating: 5,
		comment: "Excellent",
		displayName: "Ahmed A.",
		verifiedStay: true,
		firstName: "Ahmed",
		lastName: "Abdelrazak",
		confirmationNumberEncrypted: "secret",
		roomLabel: "Room 101",
		status: "active",
		createdAt: new Date("2026-07-12T00:00:00.000Z"),
		updatedAt: new Date("2026-07-12T00:00:00.000Z"),
	});
	assert.deepEqual(Object.keys(publicReview).sort(), [
		"_id",
		"comment",
		"commentVisible",
		"createdAt",
		"displayName",
		"rating",
		"ratingVisible",
		"updatedAt",
		"verifiedStay",
	]);
	assert.equal(publicReview.verifiedStay, true);
	assert.equal(publicReview.ratingVisible, true);
	assert.equal(publicReview.commentVisible, true);
	assert.equal("firstName" in publicReview, false);
	assert.equal("confirmationNumber" in publicReview, false);
	assert.equal("roomLabel" in publicReview, false);
});

test("public serialization can hide only the comment", () => {
	const publicReview = review.serializePublicReview({
		_id: new mongoose.Types.ObjectId(),
		rating: 4,
		comment: "Private comment",
		status: "active",
		ratingVisible: true,
		commentVisible: false,
	});
	assert.equal(publicReview.rating, 4);
	assert.equal(publicReview.comment, "");
	assert.equal(publicReview.ratingVisible, true);
	assert.equal(publicReview.commentVisible, false);
});

test("public serialization can hide only the rating", () => {
	const publicReview = review.serializePublicReview({
		_id: new mongoose.Types.ObjectId(),
		rating: 2,
		comment: "Comment stays public",
		status: "active",
		ratingVisible: false,
		commentVisible: true,
	});
	assert.equal(publicReview.rating, null);
	assert.equal(publicReview.comment, "Comment stays public");
	assert.equal(publicReview.ratingVisible, false);
	assert.equal(publicReview.commentVisible, true);
});

test("public list pagination filter includes rating-only and comment-only rows", () => {
	const hotelId = new mongoose.Types.ObjectId();
	const filter = review.buildPublicReviewListFilter(hotelId);
	assert.equal(filter.hotelId, hotelId);
	assert.deepEqual(
		filter.$or,
		visibility.publicReviewContentMongoFilter().$or,
	);
	assert.equal(filter.$or.length, 2);
	assert.ok(filter.$or[1].$and[1].comment.$regex.test("public comment"));
	assert.equal(filter.$or[1].$and[1].comment.$regex.test("   "), false);
});

test("fully hidden reviews are omitted from the public response", () => {
	assert.equal(
		review.serializePublicReview({
			_id: new mongoose.Types.ObjectId(),
			rating: 5,
			comment: "Hidden",
			status: "active",
			ratingVisible: false,
			commentVisible: false,
		}),
		null,
	);
	assert.equal(
		review.serializePublicReview({
			_id: new mongoose.Types.ObjectId(),
			rating: 5,
			comment: "Legacy hidden",
			status: "inactive",
		}),
		null,
	);
	assert.equal(
		review.serializePublicReview({
			_id: new mongoose.Types.ObjectId(),
			rating: 5,
			comment: "Malformed visibility must fail closed",
			status: "active",
			ratingVisible: "true",
			commentVisible: "true",
		}),
		null,
	);
});

test("a missing comment cannot create a comment-only public row", () => {
	const source = {
		_id: new mongoose.Types.ObjectId(),
		rating: 3,
		comment: "",
		status: "active",
		ratingVisible: false,
		commentVisible: true,
	};
	assert.equal(review.serializePublicReview(source), null);
	assert.deepEqual(
		visibility.resolveHotelReviewVisibility(source),
		{
			ratingVisible: false,
			commentVisible: false,
			commentConfiguredVisible: true,
			hasComment: false,
			hasPublicContent: false,
			status: "inactive",
		},
	);
	const transition = review.buildReviewVisibilityTransition(source, {
		hasCommentVisible: true,
		commentVisible: true,
	});
	assert.equal(transition.next.commentVisible, false);
	assert.equal(transition.next.status, "inactive");
	assert.equal(transition.normalizesBlankComment, true);
	assert.equal(transition.changed, true);
});

test("rating-hidden rows are excluded by every rating aggregation policy", () => {
	const hotelId = new mongoose.Types.ObjectId();
	const expectedVisibilityFilter =
		visibility.effectiveRatingVisibilityMongoFilter();
	assert.deepEqual(
		review.buildHotelReviewSummaryPipeline(hotelId)[0].$match,
		{
			hotelId,
			...expectedVisibilityFilter,
		},
	);
	assert.equal(
		visibility.resolveHotelReviewVisibility({
			status: "active",
			ratingVisible: false,
			commentVisible: true,
			comment: "Still public",
		}).ratingVisible,
		false,
	);
	const adminGroup = review.adminSummaryPipeline({})[1].$group;
	assert.deepEqual(
		adminGroup.visibleRatingCount.$sum.$cond[0],
		visibility.effectiveRatingVisibilityAggregationExpression(),
	);
	assert.deepEqual(
		adminGroup.activeRatingSum.$sum.$cond[0],
		visibility.effectiveRatingVisibilityAggregationExpression(),
	);
	assert.equal(
		review.serializeAdminSummary({
			total: 2,
			active: 2,
			inactive: 0,
			visibleRatingCount: 1,
			visibleCommentCount: 2,
			activeRatingSum: 5,
		}).averageRating,
		5,
	);
	assert.deepEqual(
		adminGroup.visibleCommentCount.$sum.$cond[0],
		visibility.effectiveCommentVisibilityAggregationExpression(),
	);
	const commentExpression =
		visibility.effectiveCommentVisibilityAggregationExpression();
	assert.deepEqual(commentExpression.$and[1], {
		$ne: [
			{ $trim: { input: { $ifNull: ["$comment", ""] } } },
			"",
		],
	});
});

test("admin active and inactive filters use effective public visibility", async () => {
	const active = await review.buildAdminReviewFilters({ status: "active" });
	assert.deepEqual(active.listFilter, {
		$and: [{}, visibility.publicReviewContentMongoFilter()],
	});
	const inactive = await review.buildAdminReviewFilters({ status: "inactive" });
	assert.deepEqual(inactive.listFilter, {
		$and: [
			{},
			{ $nor: [visibility.publicReviewContentMongoFilter()] },
		],
	});
});

test("legacy status projection hides every partial row during rollback", () => {
	assert.equal(
		visibility.legacyRollbackSafeReviewStatus({
			ratingVisible: true,
			commentVisible: true,
			hasComment: true,
		}),
		"active",
	);
	assert.equal(
		visibility.legacyRollbackSafeReviewStatus({
			ratingVisible: true,
			commentVisible: false,
			hasComment: true,
		}),
		"inactive",
	);
	assert.equal(
		visibility.legacyRollbackSafeReviewStatus({
			ratingVisible: false,
			commentVisible: true,
			hasComment: true,
		}),
		"inactive",
	);
	assert.equal(
		visibility.legacyRollbackSafeReviewStatus({
			ratingVisible: true,
			commentVisible: false,
			hasComment: false,
		}),
		"active",
	);
});

test("confirmation values use authenticated encryption and deterministic private lookup", () => {
	const secret = "test-secret";
	const encrypted = review.encryptReviewSensitiveValue("abc-123", secret);
	assert.equal(encrypted.includes("abc-123"), false);
	assert.equal(review.decryptReviewSensitiveValue(encrypted, secret), "abc-123");
	assert.equal(review.decryptReviewSensitiveValue(encrypted, "wrong-secret"), "");

	const firstHash = review.confirmationNumberLookupHash(" ABC-123 ", secret);
	const secondHash = review.confirmationNumberLookupHash("abc-123", secret);
	assert.equal(firstHash, secondHash);
	assert.notEqual(firstHash, review.confirmationNumberLookupHash("abc-124", secret));
});

test("private invitation values stay in the browser fragment, never the HTTP URL", () => {
	const token = "a".repeat(43);
	const value = review.buildReviewInvitationUrl({
		baseUrl: "https://jannatbooking.com",
		hotelSlug: "zad-ajyad",
		language: "en",
		confirmationNumber: "7581369106",
		reviewToken: token,
	});
	const url = new URL(value);
	assert.equal(url.pathname, "/single-hotel/zad-ajyad");
	assert.equal(url.searchParams.get("review"), "1");
	assert.equal(url.searchParams.get("confirmationNumber"), null);
	assert.equal(url.searchParams.get("reviewToken"), null);
	assert.equal(
		url.hash,
		`#reviews?reviewToken=${token}&confirmationNumber=7581369106`
	);
	const httpRequestUrl = `${url.origin}${url.pathname}${url.search}`;
	assert.equal(httpRequestUrl.includes(token), false);
	assert.equal(httpRequestUrl.includes("7581369106"), false);
	assert.equal(value.includes("Ahmed"), false);
	assert.equal(value.includes("Room"), false);
});

test("room prefill prefers assigned room numbers and falls back to room types", () => {
	assert.equal(
		review.buildRoomLabel({
			roomId: [
				{ room_number: "101", room_type: "double" },
				{ room_number: "102", room_type: "double" },
			],
		}),
		"Rooms 101, 102"
	);
	assert.equal(
		review.buildRoomLabel({
			roomId: [],
			pickedRoomsType: [{ displayName: "Deluxe Double" }],
		}),
		"Deluxe Double"
	);
});

test("manual confirmation enriches private context without claiming verification", () => {
	const reservationId = new mongoose.Types.ObjectId();
	const manual = review.buildReviewReservationContext({
		manualReservation: {
			_id: reservationId,
			roomId: [{ room_number: "101", room_type: "double" }],
		},
		submittedConfirmationNumber: "ABC-123",
	});
	assert.equal(manual.reservationId, null);
	assert.equal(manual.invitationId, null);
	assert.equal(manual.verifiedStay, false);
	assert.equal(manual.verificationMethod, "confirmation");
	assert.equal(manual.roomLabel, "Room 101");
	assert.equal(
		review.decryptReviewSensitiveValue(manual.confirmationNumberEncrypted),
		"abc-123"
	);

	const invitationId = new mongoose.Types.ObjectId();
	const invited = review.buildReviewReservationContext({
		invitation: { _id: invitationId },
		invitationReservation: {
			_id: reservationId,
			confirmation_number: "abc-123",
			roomId: [{ room_number: "101" }],
		},
	});
	assert.equal(String(invited.reservationId), String(reservationId));
	assert.equal(String(invited.invitationId), String(invitationId));
	assert.equal(invited.verifiedStay, true);
	assert.equal(invited.verificationMethod, "invitation");
});

test("invitation actor scope is global only for reservation-wide permissions", () => {
	const hotelId = new mongoose.Types.ObjectId();
	const otherHotelId = new mongoose.Types.ObjectId();
	const actorId = new mongoose.Types.ObjectId();
	assert.equal(
		review.canCreateReviewInvitationForHotel(
			{ _id: actorId, accessTo: ["AllReservations"] },
			otherHotelId,
			{ superAdminIds: [] }
		),
		true
	);
	assert.equal(
		review.canCreateReviewInvitationForHotel(
			{
				_id: actorId,
				accessTo: ["JannatBookingWebsite"],
				hotelIdsWork: [hotelId],
			},
			hotelId,
			{ superAdminIds: [] }
		),
		true
	);
	assert.equal(
		review.canCreateReviewInvitationForHotel(
			{ _id: actorId, accessTo: ["JannatBookingWebsite"] },
			otherHotelId,
			{ superAdminIds: [] }
		),
		false
	);
	assert.equal(
		review.canCreateReviewInvitationForHotel(
			{ _id: actorId, accessTo: ["JannatBookingWebsite"] },
			otherHotelId,
			{ superAdminIds: [String(actorId)] }
		),
		true
	);
});

test("review invitation replacement requires an explicit boolean confirmation", () => {
	assert.equal(review.isExplicitInvitationReplacement({ replace: true }), true);
	for (const value of [false, "true", "false", 1, 0, null, undefined]) {
		assert.equal(
			review.isExplicitInvitationReplacement({ replace: value }),
			false,
			JSON.stringify(value)
		);
	}
	assert.equal(review.isExplicitInvitationReplacement(), false);

	const conflict = review.activeReviewInvitationExistsError();
	assert.equal(conflict.status, 409);
	assert.equal(conflict.code, "ACTIVE_REVIEW_INVITATION_EXISTS");
	assert.match(conflict.message, /Confirm replacement/i);

	const concurrentReplacement = review.reviewInvitationWriteConflictError();
	assert.equal(concurrentReplacement.status, 409);
	assert.equal(concurrentReplacement.code, "INVITATION_WRITE_CONFLICT");
});

test("pagination and moderation inputs remain bounded and explicit", () => {
	assert.deepEqual(review.parsePagination({ page: "999999", limit: "999" }), {
		page: 10000,
		limit: 12,
	});
	assert.equal(review.requestedModerationStatus({ status: "inactive" }), "inactive");
	assert.equal(review.requestedModerationStatus({ active: true }), "active");
	assert.throws(() => review.requestedModerationStatus({ status: "deleted" }), /active or inactive/);
	assert.deepEqual(review.requestedReviewVisibilityPatch({ status: "inactive" }), {
		mode: "legacy-status",
		hasRatingVisible: true,
		hasCommentVisible: true,
		ratingVisible: false,
		commentVisible: false,
	});
	assert.deepEqual(review.requestedReviewVisibilityPatch({ commentVisible: false }), {
		mode: "visibility",
		hasRatingVisible: false,
		hasCommentVisible: true,
		commentVisible: false,
	});
	assert.throws(
		() =>
			review.requestedReviewVisibilityPatch({
				status: "active",
				ratingVisible: false,
			}),
		/visibility fields or legacy status/i,
	);
	assert.throws(
		() => review.requestedReviewVisibilityPatch({ ratingVisible: "false" }),
		/must be true or false/i,
	);
	assert.deepEqual(
		review.parsePagination(
			{ page: "2", limit: "100" },
			{ defaultLimit: 20, maxLimit: 50 }
		),
		{ page: 2, limit: 50 }
	);
});

test("admin review rows provide the PMS-compatible straightforward fields", () => {
	const reviewId = new mongoose.Types.ObjectId();
	const hotelId = new mongoose.Types.ObjectId();
	const reservationId = new mongoose.Types.ObjectId();
	const sourceReview = {
		_id: reviewId,
		firstName: "Ahmed",
		lastName: "Abdelrazak",
		displayName: "Ahmed A.",
		hotelId: { _id: hotelId, hotelName: "zad ajyad" },
		reservationId: { _id: reservationId, confirmation_number: "7581369106" },
		roomLabel: "Room 101",
		rating: 5,
		comment: "Excellent",
		status: "active",
		verifiedStay: true,
		createdAt: new Date(),
		updatedAt: new Date(),
	};
	const row = review.serializeAdminReview(sourceReview, {
		includeReservationId: true,
	});
	for (const field of [
		"firstName",
		"lastName",
		"displayName",
		"confirmationNumber",
		"roomLabel",
		"hotel",
		"rating",
		"comment",
		"status",
		"ratingVisible",
		"commentVisible",
		"verifiedStay",
		"createdAt",
		"updatedAt",
	]) {
		assert.equal(Object.prototype.hasOwnProperty.call(row, field), true, field);
	}
	assert.equal(row.confirmationNumber, "7581369106");
	assert.equal(row.reservationId, String(reservationId));
	assert.equal(row.hotel._id, String(hotelId));
	assert.equal(row.ratingVisible, true);
	assert.equal(row.commentVisible, true);
	assert.equal(review.serializeAdminReview(sourceReview).reservationId, null);
});

test("review reservation ids require exact active admin permissions", () => {
	const superId = new mongoose.Types.ObjectId();
	const assignedHotelId = new mongoose.Types.ObjectId();
	const otherHotelId = new mongoose.Types.ObjectId();
	assert.equal(
		review.canViewHotelReviewReservationDetails(
			{ _id: superId, activeUser: true, role: 1000, accessTo: [] },
			{ superAdminIds: [String(superId)] }
		),
		true
	);
	assert.equal(
		review.canViewHotelReviewReservationDetailsForHotel(
			{
				activeUser: true,
				role: 1000,
				accessTo: ["JannatBookingWebsite", "AllReservations"],
				hotelsToSupport: [assignedHotelId],
			},
			assignedHotelId,
			{ superAdminIds: [] }
		),
		true
	);
	assert.equal(
		review.canViewHotelReviewReservationDetailsForHotel(
			{
				activeUser: true,
				role: 1000,
				accessTo: ["JannatBookingWebsite", "AllReservations"],
				hotelsToSupport: [assignedHotelId],
			},
			otherHotelId,
			{ superAdminIds: [] }
		),
		false
	);
	assert.equal(
		review.canViewHotelReviewReservationDetailsForHotel(
			{ _id: superId, activeUser: true },
			otherHotelId,
			{ superAdminIds: [String(superId)] }
		),
		true
	);
	assert.equal(
		review.canViewHotelReviewReservationDetails(
			{
				activeUser: true,
				role: 1000,
				accessTo: ["JannatBookingWebsite", "AllReservations"],
			},
			{ superAdminIds: [] }
		),
		true
	);
	for (const actor of [
		{
			activeUser: false,
			role: 1000,
			accessTo: ["JannatBookingWebsite", "AllReservations"],
		},
		{ activeUser: true, role: 1000, accessTo: ["JannatBookingWebsite"] },
		{ activeUser: true, role: 1000, accessTo: ["AllReservations"] },
		{
			activeUser: true,
			role: 2000,
			accessTo: ["JannatBookingWebsite", "HotelsReservations"],
		},
	]) {
		assert.equal(
			review.canViewHotelReviewReservationDetails(actor, {
				superAdminIds: [],
			}),
			false
		);
	}
});

test("review reservation details route requires website and reservation access", () => {
	const routesSource = fs.readFileSync(
		require.resolve("../routes/hoteldetails"),
		"utf8"
	);
	assert.match(
		routesSource,
		/router\.get\(\s*"\/admin\/hotel-reviews\/reservation-details\/:reservationId\/:userId"\s*,\s*requireSignin\s*,\s*isAuth\s*,\s*requireAdminAccess\("JannatBookingWebsite"\)\s*,\s*requireAdminAccess\("AllReservations",\s*"HotelsReservations"\)\s*,\s*requireHotelReviewReservationScope\s*,\s*singleReservationById\s*\)/
	);
});

test("review reservation details enforce assigned hotels for platform employees", async () => {
	const reservationId = new mongoose.Types.ObjectId();
	const assignedHotelId = new mongoose.Types.ObjectId();
	const actorId = new mongoose.Types.ObjectId();
	const queries = [];
	const middleware = review.buildRequireHotelReviewReservationScope({
		ReservationModel: {
			exists: async (query) => {
				queries.push(query);
				return { _id: reservationId };
			},
		},
		superAdminIds: [],
	});
	const response = () => ({
		statusCode: 200,
		body: null,
		setHeader() {},
		status(code) {
			this.statusCode = code;
			return this;
		},
		json(body) {
			this.body = body;
			return this;
		},
	});
	let nextCalls = 0;
	const allowedResponse = response();
	await middleware(
		{
			params: { reservationId: String(reservationId) },
			profile: {
				_id: actorId,
				role: 1000,
				accessTo: ["JannatBookingWebsite", "AllReservations"],
				hotelIdWork: assignedHotelId,
			},
		},
		allowedResponse,
		() => {
			nextCalls += 1;
		}
	);
	assert.equal(nextCalls, 1);
	assert.equal(queries.length, 1);
	assert.equal(String(queries[0]._id), String(reservationId));
	assert.deepEqual(
		queries[0].hotelId.$in.map(String),
		[String(assignedHotelId)]
	);

	const deniedMiddleware = review.buildRequireHotelReviewReservationScope({
		ReservationModel: { exists: async () => null },
		superAdminIds: [],
	});
	const deniedResponse = response();
	await deniedMiddleware(
		{
			params: { reservationId: String(reservationId) },
			profile: {
				_id: actorId,
				roles: [1000],
				accessTo: ["JannatBookingWebsite", "HotelsReservations"],
				hotelsToSupport: [assignedHotelId],
			},
		},
		deniedResponse,
		() => {
			nextCalls += 1;
		}
	);
	assert.equal(deniedResponse.statusCode, 404);
	assert.deepEqual(deniedResponse.body, { message: "Reservation not found." });
	assert.equal(nextCalls, 1);

	const websiteOnlyResponse = response();
	await middleware(
		{
			params: { reservationId: String(reservationId) },
			profile: {
				_id: actorId,
				role: 1000,
				activeUser: true,
				accessTo: ["JannatBookingWebsite"],
				hotelIdWork: assignedHotelId,
			},
		},
		websiteOnlyResponse,
		() => {
			nextCalls += 1;
		}
	);
	assert.equal(websiteOnlyResponse.statusCode, 404);
	assert.equal(queries.length, 1);
	assert.equal(nextCalls, 1);
});

test("review schemas enforce status/rating and hide sensitive fields by default", () => {
	const hotelId = new mongoose.Types.ObjectId();
	const valid = new HotelReview({
		hotelId,
		hotelNameSnapshot: "zad ajyad",
		hotelSlug: "zad-ajyad",
		rating: 5,
		displayName: "Ahmed A.",
		firstName: "Ahmed",
		lastName: "Abdelrazak",
	});
	assert.equal(valid.validateSync(), undefined);
	assert.equal(valid.ratingVisible, undefined);
	assert.equal(valid.commentVisible, undefined);
	valid.rating = 4.5;
	assert.ok(valid.validateSync()?.errors?.rating);
	assert.equal(HotelReview.schema.path("firstName").options.select, false);
	assert.equal(
		HotelReview.schema.path("confirmationNumberLookupHash").options.select,
		false
	);
	assert.equal(HotelReviewInvitation.schema.path("tokenHash").options.select, false);

	const summaryHotelIndexes = HotelReviewSummary.schema
		.indexes()
		.filter(([fields]) => fields.hotelId === 1);
	assert.equal(summaryHotelIndexes.length, 1);
	const activeInvitationIndexes = HotelReviewInvitation.schema
		.indexes()
		.filter(([, options]) => options.name === "uniq_active_hotel_review_invitation");
	assert.equal(activeInvitationIndexes.length, 1);
	assert.equal(activeInvitationIndexes[0][1].unique, true);
});

test("visibility compare-and-swap guards status and both current flags", () => {
	const id = new mongoose.Types.ObjectId();
	assert.deepEqual(
		visibility.buildHotelReviewVisibilityCasFilter({
			_id: id,
			status: "active",
			ratingVisible: true,
			commentVisible: false,
		}),
		{
			_id: id,
			status: "active",
			ratingVisible: true,
			commentVisible: false,
		},
	);
	assert.deepEqual(
		visibility.buildHotelReviewVisibilityCasFilter({
			_id: id,
			status: "inactive",
		}),
		{
			_id: id,
			status: "inactive",
			ratingVisible: { $in: [null] },
			commentVisible: { $in: [null] },
		},
	);
	assert.deepEqual(
		visibility.buildHotelReviewVisibilityCasFilter({
			_id: id,
			status: "active",
			ratingVisible: "malformed",
			commentVisible: 1,
		}),
		{
			_id: id,
			status: "active",
			ratingVisible: "malformed",
			commentVisible: 1,
		},
	);
});

test("comment visibility moderation uses rollback-safe status without a rating delta", () => {
	const transition = review.buildReviewVisibilityTransition(
		{
			status: "active",
			rating: 5,
			comment: "Visible",
		},
		{
			hasCommentVisible: true,
			commentVisible: false,
		},
	);
	assert.equal(transition.changed, true);
	assert.equal(transition.ratingVisibilityChanged, false);
	assert.deepEqual(transition.next, {
		ratingVisible: true,
		commentVisible: false,
		status: "inactive",
	});
	assert.equal(
		review.visibilityTransitionMatchesReview(transition, {
			status: "inactive",
			comment: "Visible",
			ratingVisible: true,
			commentVisible: false,
		}),
		true,
	);
	assert.equal(
		review.visibilityTransitionMatchesReview(transition, {
			status: "active",
			comment: "Visible",
			ratingVisible: true,
			commentVisible: false,
		}),
		false,
	);
	const changedAt = new Date("2026-07-13T12:00:00.000Z");
	const actorId = new mongoose.Types.ObjectId();
	assert.deepEqual(
		review.buildReviewModerationAudit({
			sourceReview: { status: "active" },
			transition,
			reason: "Hide guest comment",
			actorId,
			changedAt,
		}).history,
		{
			fromStatus: "active",
			toStatus: "inactive",
			fromRatingVisible: true,
			toRatingVisible: true,
			fromCommentVisible: true,
			toCommentVisible: false,
			reason: "Hide guest comment",
			changedBy: actorId,
			changedAt,
		},
	);
});

test("comment-only public visibility stays available while legacy status is inactive", () => {
	const transition = review.buildReviewVisibilityTransition(
		{
			status: "active",
			rating: 2,
			comment: "Public comment",
		},
		{
			hasRatingVisible: true,
			ratingVisible: false,
		},
	);
	assert.deepEqual(transition.next, {
		ratingVisible: false,
		commentVisible: true,
		status: "inactive",
	});
	assert.equal(transition.ratingVisibilityChanged, true);
	assert.deepEqual(
		visibility.resolveHotelReviewVisibility({
			status: transition.next.status,
			comment: "Public comment",
			ratingVisible: transition.next.ratingVisible,
			commentVisible: transition.next.commentVisible,
		}),
		{
			ratingVisible: false,
			commentVisible: true,
			commentConfiguredVisible: true,
			hasComment: true,
			hasPublicContent: true,
			status: "active",
		},
	);
});

test("summary deltas touch only count, sum, and the selected star bucket", () => {
	assert.deepEqual(review.summaryDeltaUpdate(4, -1), {
		$inc: {
			ratingCount: -1,
			ratingSum: -4,
			"breakdown.fourStar": -1,
		},
	});
});

test("materialized review summaries must balance every star bucket", () => {
	assert.equal(
		review.summaryHasValidInvariants({
			ratingCount: 3,
			ratingSum: 13,
			breakdown: {
				oneStar: 0,
				twoStar: 0,
				threeStar: 1,
				fourStar: 0,
				fiveStar: 2,
			},
		}),
		true
	);
	assert.equal(
		review.summaryHasValidInvariants({
			ratingCount: 3,
			ratingSum: 14,
			breakdown: {
				oneStar: 0,
				twoStar: 0,
				threeStar: 1,
				fourStar: 0,
				fiveStar: 2,
			},
		}),
		false
	);
	assert.equal(
		review.summaryHasValidInvariants({
			ratingCount: 2,
			ratingSum: 10,
			breakdown: {
				oneStar: 0,
				twoStar: 0,
				threeStar: 0,
				fourStar: 0,
				fiveStar: 1,
			},
		}),
		false
	);
});

test("standalone fallback is limited to explicit unsupported-transaction errors", () => {
	assert.equal(
		review.isUnsupportedTransactionError({
			code: 20,
			message:
				"Transaction numbers are only allowed on a replica set member or mongos",
		}),
		true
	);
	assert.equal(
		review.isUnsupportedTransactionError({
			message: "Transactions are not supported by this deployment",
		}),
		true
	);
	assert.equal(
		review.isUnsupportedTransactionError({
			code: 11000,
			message: "duplicate key",
		}),
		false
	);
	assert.equal(
		review.isUnsupportedTransactionError({ message: "network timeout" }),
		false
	);
});

test("every moderation error clears public aggregates before responding", () => {
	const controllerSource = fs.readFileSync(
		require.resolve("../controllers/hoteldetails"),
		"utf8",
	);
	const moderationController = controllerSource.indexOf(
		"exports.updateHotelReviewStatus = async",
	);
	const errorResponse = controllerSource.indexOf(
		'return sendControllerError(res, error, "moderate review");',
		moderationController,
	);
	const outerCatch = controllerSource.lastIndexOf(
		"} catch (error) {",
		errorResponse,
	);
	const cacheInvalidation = controllerSource.lastIndexOf(
		"invalidatePublicHotelGuestReviewSummaryCache();",
		errorResponse,
	);

	assert.ok(moderationController >= 0);
	assert.ok(outerCatch > moderationController);
	assert.ok(cacheInvalidation > outerCatch);
	assert.ok(errorResponse > cacheInvalidation);
	assert.ok(errorResponse - cacheInvalidation < 500);
});

test("transaction runner ends its session before executing standalone fallback", async () => {
	const originalStartSession = mongoose.startSession;
	const events = [];
	let sessionStarts = 0;
	review.resetTransactionSupportCache();
	mongoose.startSession = async () => {
		sessionStarts += 1;
		return {
			withTransaction: async (callback) => {
				events.push("transaction-started");
				await callback();
				throw new Error(
					"Transaction numbers are only allowed on a replica set member or mongos"
				);
			},
			endSession: async () => {
				events.push("session-ended");
			},
		};
	};
	try {
		const result = await review.runReviewTransaction(
			async () => {
				events.push("primary-work");
				return "transaction";
			},
			async () => {
				events.push("fallback-work");
				return "standalone";
			}
		);
		assert.equal(result, "standalone");
		assert.deepEqual(events, [
			"transaction-started",
			"primary-work",
			"session-ended",
			"fallback-work",
		]);
		const secondResult = await review.runReviewTransaction(
			async () => "should-not-run",
			async () => "cached-standalone"
		);
		assert.equal(secondResult, "cached-standalone");
		assert.equal(sessionStarts, 1);
	} finally {
		mongoose.startSession = originalStartSession;
		review.resetTransactionSupportCache();
	}
});

test("standalone hotel mutex serializes one hotel's mutations and cleans up", async () => {
	const hotelId = new mongoose.Types.ObjectId();
	const events = [];
	let releaseFirst;
	const firstGate = new Promise((resolve) => {
		releaseFirst = resolve;
	});
	const first = review.withHotelReviewFallbackMutex(hotelId, async () => {
		events.push("first-start");
		await firstGate;
		events.push("first-end");
	});
	const second = review.withHotelReviewFallbackMutex(hotelId, async () => {
		events.push("second-start");
		events.push("second-end");
	});
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(events, ["first-start"]);
	releaseFirst();
	await Promise.all([first, second]);
	assert.deepEqual(events, [
		"first-start",
		"first-end",
		"second-start",
		"second-end",
	]);
	await review.withHotelReviewFallbackMutex(hotelId, async () => {
		events.push("third");
	});
	assert.equal(events.at(-1), "third");
});

test("review JSON parser enforces 32 KB only on review paths", async () => {
	const app = express();
	app.use(
		["/api/hotel-reviews", "/api/admin/hotel-reviews"],
		hotelReviewJsonParser
	);
	app.use(express.json({ limit: "50mb" }));
	app.post("/api/hotel-reviews/echo", (req, res) =>
		res.json({ length: String(req.body?.value || "").length })
	);
	app.post("/api/legacy/echo", (req, res) =>
		res.json({ length: String(req.body?.value || "").length })
	);
	app.post("/api/admin/hotel-reviews/echo", (req, res) =>
		res.json({ length: String(req.body?.value || "").length })
	);
	const server = http.createServer(app);
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	const base = `http://127.0.0.1:${address.port}`;
	const largeBody = JSON.stringify({ value: "x".repeat(40 * 1024) });
	try {
		const smallResponse = await fetch(`${base}/api/hotel-reviews/echo`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ value: "safe" }),
		});
		assert.equal(smallResponse.status, 200);
		assert.equal((await smallResponse.json()).length, 4);

		const reviewResponse = await fetch(`${base}/api/hotel-reviews/echo`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: largeBody,
		});
		assert.equal(reviewResponse.status, 413);
		assert.equal((await reviewResponse.json()).code, "REVIEW_TOO_LARGE");
		const adminResponse = await fetch(`${base}/api/admin/hotel-reviews/echo`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: largeBody,
		});
		assert.equal(adminResponse.status, 413);

		const legacyResponse = await fetch(`${base}/api/legacy/echo`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: largeBody,
		});
		assert.equal(legacyResponse.status, 200);
		assert.equal((await legacyResponse.json()).length, 40 * 1024);
	} finally {
		await new Promise((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve()))
		);
	}
});
