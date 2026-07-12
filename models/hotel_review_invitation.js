/** @format */

"use strict";

const mongoose = require("mongoose");
const { ObjectId } = mongoose.Schema;

const hotelReviewInvitationSchema = new mongoose.Schema(
	{
		// The raw bearer token is returned once and never persisted.
		tokenHash: {
			type: String,
			required: true,
			unique: true,
			immutable: true,
			select: false,
		},
		reservationId: {
			type: ObjectId,
			ref: "Reservations",
			required: true,
			immutable: true,
		},
		hotelId: {
			type: ObjectId,
			ref: "HotelDetails",
			required: true,
			immutable: true,
		},
		createdBy: {
			type: ObjectId,
			ref: "User",
			required: true,
			immutable: true,
		},
		language: {
			type: String,
			trim: true,
			lowercase: true,
			maxlength: 10,
			default: "en",
		},
		expiresAt: { type: Date, required: true, immutable: true },
		usedAt: { type: Date, default: null },
		usedByReviewId: {
			type: ObjectId,
			ref: "HotelReview",
			default: null,
		},
		revokedAt: { type: Date, default: null },
	},
	{ timestamps: true }
);

hotelReviewInvitationSchema.index(
	{ expiresAt: 1 },
	{ expireAfterSeconds: 0, name: "hotel_review_invitation_expiry" }
);
hotelReviewInvitationSchema.index(
	{ reservationId: 1, hotelId: 1, expiresAt: -1 },
	{ name: "hotel_review_invitation_reservation" }
);
hotelReviewInvitationSchema.index(
	{ reservationId: 1 },
	{
		unique: true,
		partialFilterExpression: { usedAt: null, revokedAt: null },
		name: "uniq_active_hotel_review_invitation",
	}
);

module.exports = mongoose.model(
	"HotelReviewInvitation",
	hotelReviewInvitationSchema
);
