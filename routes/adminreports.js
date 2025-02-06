/** @format */

const express = require("express");
const router = express.Router();
const { requireSignin, isAuth, isAdmin } = require("../controllers/auth");
const {
	reservationsByDay,
	checkinsByDay,
	checkoutsByDay,
	reservationsByDayByHotelName,
	reservationsByBookingStatus,
	reservationsByHotelNames,
	topHotelsByReservations,
	specificListOfReservations,
	// ... any other exported controllers
} = require("../controllers/adminreports");

const { userById } = require("../controllers/user");

// PARAM Middlewares
router.param("userId", userById);

/**
 * Admin Report Routes
 * All routes use:
 *  - requireSignin (must be logged in)
 *  - isAuth (must be the correct user or admin)
 *  - isAdmin (must have admin privileges)
 *
 * Example usage:
 *   GET /api/adminreports/reservations-by-day/:userId
 * where :userId is the authenticated user's ID.
 */

// 1) Reservations By Day
router.get(
	"/adminreports/reservations-by-day/:userId",
	requireSignin,
	isAuth,
	isAdmin,
	reservationsByDay
);

// 2) Checkins By Day
router.get(
	"/adminreports/checkins-by-day/:userId",
	requireSignin,
	isAuth,
	isAdmin,
	checkinsByDay
);

// 3) Checkouts By Day
router.get(
	"/adminreports/checkouts-by-day/:userId",
	requireSignin,
	isAuth,
	isAdmin,
	checkoutsByDay
);

// 4) Reservations By Day By Hotel Name
router.get(
	"/adminreports/reservations-by-day-by-hotel/:userId",
	requireSignin,
	isAuth,
	isAdmin,
	reservationsByDayByHotelName
);

// 5) Reservations By Booking Status
router.get(
	"/adminreports/reservations-by-booking-status/:userId",
	requireSignin,
	isAuth,
	isAdmin,
	reservationsByBookingStatus
);

// 6) Reservations By Hotel Names
router.get(
	"/adminreports/reservations-by-hotel-names/:userId",
	requireSignin,
	isAuth,
	isAdmin,
	reservationsByHotelNames
);

// 7) Top Hotels By Reservations
router.get(
	"/adminreports/top-hotels-by-reservations/:userId",
	requireSignin,
	isAuth,
	isAdmin,
	topHotelsByReservations
);

// 8) Specific list for bookings
router.get(
	"/adminreports/specific-list/:userId",
	requireSignin,
	isAuth,
	isAdmin,
	specificListOfReservations
);

module.exports = router;
