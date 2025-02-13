/** @format */

const express = require("express");
const router = express.Router();
const {
	requireSignin,
	isAuth,
	isAdmin,
	isHotelOwner,
} = require("../controllers/auth");
const {
	reservationsByDay,
	checkinsByDay,
	checkoutsByDay,
	reservationsByDayByHotelName,
	reservationsByBookingStatus,
	reservationsByHotelNames,
	topHotelsByReservations,
	specificListOfReservations,
	exportToExcel,
	adminDashboardReport,
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

router.get(
	"/adminreports/export-to-excel/:userId",
	requireSignin,
	isAuth,
	isAdmin,
	exportToExcel
);

//Hotel Owner routes
// 1) Reservations By Day
router.get(
	"/hotel-adminreports/reservations-by-day/:userId",
	requireSignin,
	isAuth,
	reservationsByDay
);

// 2) Checkins By Day
router.get(
	"/hotel-adminreports/checkins-by-day/:userId",
	requireSignin,
	isAuth,
	checkinsByDay
);

// 3) Checkouts By Day
router.get(
	"/hotel-adminreports/checkouts-by-day/:userId",
	requireSignin,
	isAuth,
	checkoutsByDay
);

// 4) Reservations By Day By Hotel Name
router.get(
	"/hotel-adminreports/reservations-by-day-by-hotel/:userId",
	requireSignin,
	isAuth,
	reservationsByDayByHotelName
);

// 5) Reservations By Booking Status
router.get(
	"/hotel-adminreports/reservations-by-booking-status/:userId",
	requireSignin,
	isAuth,
	reservationsByBookingStatus
);

// 6) Reservations By Hotel Names
router.get(
	"/hotel-adminreports/reservations-by-hotel-names/:userId",
	requireSignin,
	isAuth,
	reservationsByHotelNames
);

// 7) Top Hotels By Reservations
router.get(
	"/hotel-adminreports/top-hotels-by-reservations/:userId",
	requireSignin,
	isAuth,
	topHotelsByReservations
);

// 8) Specific list for bookings
router.get(
	"/hotel-adminreports/specific-list/:userId",
	requireSignin,
	isAuth,
	specificListOfReservations
);

router.get(
	"/hotel-adminreports/export-to-excel/:userId",
	requireSignin,
	isAuth,
	exportToExcel
);

router.get("/admin-dashboard-reports/:hotelId", adminDashboardReport);

module.exports = router;
