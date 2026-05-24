/** @format */

"use strict";

const express = require("express");
const router = express.Router();
const { requireSignin, isAuth } = require("../controllers/auth");
const { userById } = require("../controllers/user");
const {
	overallSummary,
	overallReservations,
	exportOverallReservations,
	overallPendingReservations,
	exportOverallPendingReservations,
	overallFinancialActions,
	trackOverallFinancialReportExport,
	overallHousekeeping,
	overallAccounts,
	createSignupInvitation,
	createOverallSystemAdmin,
	updateOverallSystemAdmin,
	overallSettings,
} = require("../controllers/overall_dashboard");

router.get(
	"/overall-dashboard/summary/:userId",
	requireSignin,
	isAuth,
	overallSummary
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

router.param("userId", userById);

module.exports = router;
