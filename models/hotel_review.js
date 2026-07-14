/** @format */

"use strict";

const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema;

const moderationSchema = new mongoose.Schema(
	{
		reason: { type: String, trim: true, maxlength: 500, default: "" },
		changedBy: { type: ObjectId, ref: "User", default: null },
		changedAt: { type: Date, default: null },
		ratingVisible: { type: Boolean, default: undefined },
		commentVisible: { type: Boolean, default: undefined },
	},
	{ _id: false }
);

const moderationHistorySchema = new mongoose.Schema(
	{
		fromStatus: {
			type: String,
			enum: ["active", "inactive"],
			required: true,
		},
		toStatus: {
			type: String,
			enum: ["active", "inactive"],
			required: true,
		},
		fromRatingVisible: { type: Boolean, default: undefined },
		toRatingVisible: { type: Boolean, default: undefined },
		fromCommentVisible: { type: Boolean, default: undefined },
		toCommentVisible: { type: Boolean, default: undefined },
		reason: { type: String, trim: true, maxlength: 500, default: "" },
		changedBy: { type: ObjectId, ref: "User", required: true },
		changedAt: { type: Date, default: Date.now },
	},
	{ _id: false }
);

const hotelReviewSchema = new mongoose.Schema(
	{
		hotelId: {
			type: ObjectId,
			ref: "HotelDetails",
			required: true,
			immutable: true,
		},
		hotelNameSnapshot: {
			type: String,
			trim: true,
			maxlength: 180,
			required: true,
		},
		hotelSlug: {
			type: String,
			trim: true,
			lowercase: true,
			maxlength: 220,
			required: true,
		},
		rating: {
			type: Number,
			required: true,
			min: 1,
			max: 5,
			validate: {
				validator: Number.isInteger,
				message: "Rating must be a whole number from 1 to 5.",
			},
		},
		comment: {
			type: String,
			trim: true,
			maxlength: 2000,
			default: "",
		},
		status: {
			type: String,
			enum: ["active", "inactive"],
			default: "active",
			required: true,
		},
		// Optional by design: missing values belong to legacy rows and inherit the
		// existing active/inactive behavior. New writes set both explicitly.
		ratingVisible: {
			type: Boolean,
			default: undefined,
		},
		commentVisible: {
			type: Boolean,
			default: undefined,
		},

		// Only the masked display name is public. Full identity fields must be
		// explicitly selected by an authorized administrative query.
		displayName: {
			type: String,
			trim: true,
			maxlength: 100,
			required: true,
		},
		firstName: {
			type: String,
			trim: true,
			maxlength: 80,
			required: true,
			select: false,
		},
		lastName: {
			type: String,
			trim: true,
			maxlength: 80,
			default: "",
			select: false,
		},
		userId: {
			type: ObjectId,
			ref: "User",
			default: null,
			select: false,
		},
		authenticatedReviewer: {
			type: Boolean,
			default: false,
			select: false,
		},

		// Reservation linkage is private. It supports verified internal follow-up
		// without exposing confirmation numbers or room assignments publicly.
		reservationId: {
			type: ObjectId,
			ref: "Reservations",
			default: null,
			select: false,
		},
		invitationId: {
			type: ObjectId,
			ref: "HotelReviewInvitation",
			default: null,
			select: false,
		},
		verifiedStay: {
			type: Boolean,
			default: false,
			select: false,
		},
		verificationMethod: {
			type: String,
			enum: ["none", "confirmation", "invitation"],
			default: "none",
			select: false,
		},
		confirmationNumberEncrypted: {
			type: String,
			default: "",
			select: false,
		},
		confirmationNumberLookupHash: {
			type: String,
			default: "",
			select: false,
		},
		confirmationNumberMasked: {
			type: String,
			trim: true,
			maxlength: 32,
			default: "",
			select: false,
		},
		roomLabel: {
			type: String,
			trim: true,
			maxlength: 500,
			default: "",
			select: false,
		},

		language: {
			type: String,
			trim: true,
			lowercase: true,
			maxlength: 10,
			default: "en",
		},
		source: {
			type: String,
			enum: ["jannatbooking-hotel-page"],
			default: "jannatbooking-hotel-page",
		},
		moderation: {
			type: moderationSchema,
			default: undefined,
			select: false,
		},
		moderationHistory: {
			type: [moderationHistorySchema],
			default: [],
			select: false,
		},
	},
	{ timestamps: true }
);

hotelReviewSchema.index(
	{ hotelId: 1, status: 1, _id: -1 },
	{ name: "hotel_review_public_feed" }
);
hotelReviewSchema.index(
	{ status: 1, _id: -1 },
	{ name: "hotel_review_admin_feed" }
);
hotelReviewSchema.index(
	{ hotelId: 1, status: 1, rating: 1 },
	{ name: "hotel_review_summary_reconciliation" }
);
hotelReviewSchema.index(
	{ hotelId: 1, updatedAt: -1 },
	{ name: "hotel_review_latest_mutation" }
);
hotelReviewSchema.index(
	{ hotelId: 1, reservationId: 1 },
	{
		unique: true,
		partialFilterExpression: { reservationId: { $type: "objectId" } },
		name: "uniq_hotel_review_per_reservation",
	}
);
hotelReviewSchema.index(
	{ userId: 1, hotelId: 1, _id: -1 },
	{
		partialFilterExpression: { userId: { $type: "objectId" } },
		name: "hotel_review_user_history",
	}
);
hotelReviewSchema.index(
	{ confirmationNumberLookupHash: 1 },
	{
		partialFilterExpression: {
			confirmationNumberLookupHash: { $type: "string", $gt: "" },
		},
		name: "hotel_review_confirmation_lookup",
	}
);

module.exports = mongoose.model("HotelReview", hotelReviewSchema);
