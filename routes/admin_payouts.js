"use strict";

const express = require("express");
const router = express.Router();
const Ctrl = require("../controllers/admin_payouts");
const {
	requireSignin,
	requireAdminAccess,
} = require("../controllers/auth");

const canUsePayouts = [
	requireSignin,
	requireAdminAccess("Payouts", "Financials"),
];

/* Read */
router.get("/admin-payouts/commissions", ...canUsePayouts, Ctrl.listAdminPayouts);
router.get("/admin-payouts/overview", ...canUsePayouts, Ctrl.getAdminPayoutsOverview);
router.get("/admin-payouts/hotels-lite", ...canUsePayouts, Ctrl.listHotelsLite);

/* Admin updates (audit logged in simple top-level fields) */
router.patch("/admin-payouts/commission-status", ...canUsePayouts, Ctrl.updateCommissionStatus);
router.patch("/admin-payouts/transfer-status", ...canUsePayouts, Ctrl.updateTransferStatus);
router.patch(
	"/admin-payouts/update-reservation",
	...canUsePayouts,
	Ctrl.updateReservationPayoutFlags
);

/* NEW: Auto reconcile a single hotel */
router.post("/admin-payouts/reconcile", ...canUsePayouts, Ctrl.autoReconcileHotel);

module.exports = router;
