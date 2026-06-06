/** @format */

"use strict";

const express = require("express");
const router = express.Router();
const { requireSignin, isAuth } = require("../controllers/auth");
const { userById } = require("../controllers/user");
const {
	overallSummary,
	overallExecutiveReservationsReport,
	overallExecutiveInventoryReport,
	overallExecutiveInventoryDayReport,
	overallExecutivePaidReport,
	overallReservations,
	exportOverallReservations,
	trackOverallReservationSummaryExport,
	overallPendingReservations,
	exportOverallPendingReservations,
	overallRejectedReservations,
	exportOverallRejectedReservations,
	overallFinancialActions,
	trackOverallFinancialReportExport,
	overallHousekeeping,
	overallAccounts,
	createSignupInvitation,
	createOverallSystemAdmin,
	updateOverallSystemAdmin,
	overallSettings,
	overallRoomManagerOptions,
	saveOverallRoomManagerRoom,
	overallCalendarPricingOptions,
	saveOverallCalendarPricing,
	overallPriceVariantOptions,
	saveOverallPriceVariant,
} = require("../controllers/overall_dashboard");

router.get(
	"/overall-dashboard/summary/:userId",
	requireSignin,
	isAuth,
	overallSummary
);

router.get(
	"/overall-dashboard/executive-report/reservations/:userId",
	requireSignin,
	isAuth,
	overallExecutiveReservationsReport
);

router.get(
	"/overall-dashboard/executive-report/inventory/:userId",
	requireSignin,
	isAuth,
	overallExecutiveInventoryReport
);

router.get(
	"/overall-dashboard/executive-report/inventory-day/:userId",
	requireSignin,
	isAuth,
	overallExecutiveInventoryDayReport
);

router.get(
	"/overall-dashboard/executive-report/paid/:userId",
	requireSignin,
	isAuth,
	overallExecutivePaidReport
);

router.get(
	"/overall-dashboard/reservations/:userId",
	requireSignin,
	isAuth,
	overallReservations
);

router.get(
	"/overall-dashboard/reservations-export/:userId",
	requireSignin,
	isAuth,
	exportOverallReservations
);

router.post(
	"/overall-dashboard/reservation-summary-export/:userId",
	requireSignin,
	isAuth,
	trackOverallReservationSummaryExport
);

router.get(
	"/overall-dashboard/pending-reservations/:userId",
	requireSignin,
	isAuth,
	overallPendingReservations
);

router.get(
	"/overall-dashboard/pending-reservations-export/:userId",
	requireSignin,
	isAuth,
	exportOverallPendingReservations
);

router.get(
	"/overall-dashboard/rejected-reservations/:userId",
	requireSignin,
	isAuth,
	overallRejectedReservations
);

router.get(
	"/overall-dashboard/rejected-reservations-export/:userId",
	requireSignin,
	isAuth,
	exportOverallRejectedReservations
);

router.get(
	"/overall-dashboard/financial-actions/:userId",
	requireSignin,
	isAuth,
	overallFinancialActions
);

router.post(
	"/overall-dashboard/financial-report-export/:userId",
	requireSignin,
	isAuth,
	trackOverallFinancialReportExport
);

router.get(
	"/overall-dashboard/housekeeping/:userId",
	requireSignin,
	isAuth,
	overallHousekeeping
);

router.get(
	"/overall-dashboard/accounts/:userId",
	requireSignin,
	isAuth,
	overallAccounts
);

router.post(
	"/overall-dashboard/signup-invitation/:userId",
	requireSignin,
	isAuth,
	createSignupInvitation
);

router.post(
	"/overall-dashboard/system-admin/:userId",
	requireSignin,
	isAuth,
	createOverallSystemAdmin
);

router.put(
	"/overall-dashboard/system-admin/:accountId/:userId",
	requireSignin,
	isAuth,
	updateOverallSystemAdmin
);

router.get(
	"/overall-dashboard/settings/:userId",
	requireSignin,
	isAuth,
	overallSettings
);

router.get(
	"/overall-dashboard/settings-room-manager/:userId",
	requireSignin,
	isAuth,
	overallRoomManagerOptions
);

router.post(
	"/overall-dashboard/settings-room-manager/:userId",
	requireSignin,
	isAuth,
	saveOverallRoomManagerRoom
);

router.get(
	"/overall-dashboard/settings-price-variants/:userId",
	requireSignin,
	isAuth,
	overallPriceVariantOptions
);

router.post(
	"/overall-dashboard/settings-price-variants/:userId",
	requireSignin,
	isAuth,
	saveOverallPriceVariant
);

router.get(
	"/overall-dashboard/settings-calendar-pricing/:userId",
	requireSignin,
	isAuth,
	overallCalendarPricingOptions
);

router.post(
	"/overall-dashboard/settings-calendar-pricing/:userId",
	requireSignin,
	isAuth,
	saveOverallCalendarPricing
);

router.param("userId", userById);

module.exports = router;
