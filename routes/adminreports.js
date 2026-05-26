/** @format */

const express = require("express");
const router = express.Router();
const {
	requireSignin,
	isAuth,
	isAdmin,
	isHotelOwner,
	requireAdminAccess,
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
	bookingSourcePaymentSummary,
	checkoutDatePaymentSummary,
	adminDashboardReport,
	hotelOccupancyCalendar,
	hotelOccupancyWarnings,
	hotelOccupancyDayReservations,
	paidBreakdownReportAdmin,
	paidBreakdownReportHotel,
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
	requireAdminAccess("HotelReports", "AdminDashboard"),
	reservationsByDay
);

// 2) Checkins By Day
router.get(
	"/adminreports/checkins-by-day/:userId",
	requireSignin,
	isAuth,
	requireAdminAccess("HotelReports", "AdminDashboard"),
	checkinsByDay
);

// 3) Checkouts By Day
router.get(
	"/adminreports/checkouts-by-day/:userId",
	requireSignin,
	isAuth,
	requireAdminAccess("HotelReports", "AdminDashboard"),
	checkoutsByDay
);

// 4) Reservations By Day By Hotel Name
router.get(
	"/adminreports/reservations-by-day-by-hotel/:userId",
	requireSignin,
	isAuth,
	requireAdminAccess("HotelReports", "AdminDashboard"),
	reservationsByDayByHotelName
);

// 5) Reservations By Booking Status
router.get(
	"/adminreports/reservations-by-booking-status/:userId",
	requireSignin,
	isAuth,
	requireAdminAccess("HotelReports", "AdminDashboard"),
	reservationsByBookingStatus
);

// 6) Reservations By Hotel Names
router.get(
	"/adminreports/reservations-by-hotel-names/:userId",
	requireSignin,
	isAuth,
	requireAdminAccess("HotelReports", "AdminDashboard"),
	reservationsByHotelNames
);

// 7) Top Hotels By Reservations
router.get(
	"/adminreports/top-hotels-by-reservations/:userId",
	requireSignin,
	isAuth,
	requireAdminAccess("HotelReports", "AdminDashboard"),
	topHotelsByReservations
);

// 8) Specific list for bookings
router.get(
	"/adminreports/specific-list/:userId",
	requireSignin,
	isAuth,
	requireAdminAccess("HotelReports", "AdminDashboard"),
	specificListOfReservations
);

router.get(
	"/adminreports/export-to-excel/:userId",
	requireSignin,
	isAuth,
	requireAdminAccess("HotelReports", "AdminDashboard"),
	exportToExcel
);

router.get(
	"/adminreports/booking-source-payment-summary/:userId",
	requireSignin,
	isAuth,
	requireAdminAccess("HotelReports", "AdminDashboard"),
	bookingSourcePaymentSummary
);

router.get(
	"/adminreports/checkout-date-payment-summary/:userId",
	requireSignin,
	isAuth,
	requireAdminAccess("HotelReports", "AdminDashboard"),
	checkoutDatePaymentSummary
);

router.get(
	"/adminreports/paid-breakdown/:userId",
	requireSignin,
	isAuth,
	requireAdminAccess("HotelReports", "AdminDashboard", "Financials"),
	paidBreakdownReportAdmin
);

router.get(
	"/adminreports/hotel-occupancy/:userId",
	requireSignin,
	isAuth,
	requireAdminAccess("HotelReports", "AdminDashboard"),
	hotelOccupancyCalendar
);

router.get(
	"/adminreports/hotel-occupancy-warnings/:userId",
	requireSignin,
	isAuth,
	requireAdminAccess("HotelReports", "AdminDashboard"),
	hotelOccupancyWarnings
);

router.get(
	"/adminreports/hotel-occupancy-day-reservations/:userId",
	requireSignin,
	isAuth,
	requireAdminAccess("HotelReports", "AdminDashboard"),
	hotelOccupancyDayReservations
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

router.get(
	"/hotel-adminreports/paid-breakdown/:userId",
	requireSignin,
	isAuth,
	paidBreakdownReportHotel
);

router.get(
	"/hotel-adminreports/hotel-occupancy/:userId",
	requireSignin,
	isAuth,
	hotelOccupancyCalendar
);

router.get(
	"/hotel-adminreports/hotel-occupancy-day-reservations/:userId",
	requireSignin,
	isAuth,
	hotelOccupancyDayReservations
);

router.get("/admin-dashboard-reports/:hotelId", adminDashboardReport);

module.exports = router;
