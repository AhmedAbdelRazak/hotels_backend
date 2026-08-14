/** @format */

"use strict";

const express = require("express");
const router = express.Router();
const {
	requireSignin,
	isAuth,
	requireAdminAccess,
} = require("../controllers/auth");
const { userById } = require("../controllers/user");
const {
	reconciliationReport,
	updateReconciliationStatus,
} = require("../controllers/reconciliation");

router.param("userId", userById);

const canReadReconciliation = [
	requireSignin,
	isAuth,
	requireAdminAccess("HotelReports", "AdminDashboard", "Financials", "Payouts"),
];

router.get(
	"/reconciliation/report/:userId",
	...canReadReconciliation,
	reconciliationReport
);

// The controller performs an additional configured-super-admin check before
// any database read or write. Keeping the regular admin middleware here also
// preserves the existing signed-in user/route identity boundary.
router.patch(
	"/reconciliation/status/:userId",
	...canReadReconciliation,
	updateReconciliationStatus
);

module.exports = router;
