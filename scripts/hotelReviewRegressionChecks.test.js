/** @format */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
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

test("public review serialization is minimal and includes only a verification badge", () => {
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
		"createdAt",
		"displayName",
		"rating",
		"updatedAt",
		"verifiedStay",
	]);
	assert.equal(publicReview.verifiedStay, true);
	assert.equal("firstName" in publicReview, false);
	assert.equal("confirmationNumber" in publicReview, false);
	assert.equal("roomLabel" in publicReview, false);
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
	const row = review.serializeAdminReview({
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
		"verifiedStay",
		"createdAt",
		"updatedAt",
	]) {
		assert.equal(Object.prototype.hasOwnProperty.call(row, field), true, field);
	}
	assert.equal(row.confirmationNumber, "7581369106");
	assert.equal(row.hotel._id, String(hotelId));
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
