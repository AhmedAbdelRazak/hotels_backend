/** @format */

"use strict";

const express = require("express");
const router = express.Router();

const {
	requireSignin,
	optionalSignin,
	isAuth,
	requireAdminAccess,
} = require("../controllers/auth");
const { userById } = require("../controllers/user");
const { singleReservationById } = require("../controllers/reservations");
const {
	listPublicHotelReviews,
	submitHotelReview,
	resolveHotelReviewInvitation,
	createHotelReviewInvitation,
	listAdminHotelReviews,
	requireHotelReviewReservationScope,
	updateHotelReviewStatus,
} = require("../controllers/hoteldetails");

// Administrative routes are deliberately declared before public dynamic routes.
router.get(
	"/admin/hotel-reviews/:userId",
	requireSignin,
	isAuth,
	requireAdminAccess("JannatBookingWebsite"),
	listAdminHotelReviews
);

router.patch(
	"/admin/hotel-reviews/:reviewId/status/:userId",
	requireSignin,
	isAuth,
	requireAdminAccess("JannatBookingWebsite"),
	updateHotelReviewStatus
);

router.get(
	"/admin/hotel-reviews/reservation-details/:reservationId/:userId",
	requireSignin,
	isAuth,
	requireAdminAccess("JannatBookingWebsite"),
	requireAdminAccess("AllReservations", "HotelsReservations"),
	requireHotelReviewReservationScope,
	singleReservationById
);

router.post(
	"/hotel-reviews/invitations/:reservationId/:userId",
	requireSignin,
	isAuth,
	requireAdminAccess(
		"JannatBookingWebsite",
		"AllReservations",
		"HotelsReservations"
	),
	createHotelReviewInvitation
);

router.post(
	"/hotel-reviews/invitations/resolve",
	resolveHotelReviewInvitation
);

router.get("/hotel-reviews/hotel/:hotelSlug", listPublicHotelReviews);
router.post(
	"/hotel-reviews/hotel/:hotelSlug",
	optionalSignin,
	submitHotelReview
);

router.param("userId", userById);

module.exports = router;
