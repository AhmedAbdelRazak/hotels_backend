"use strict";

const express = require("express");
const router = express.Router();
const Ctrl = require("../controllers/admin_payouts");

/* Read */
router.get("/admin-payouts/commissions", Ctrl.listAdminPayouts);
router.get("/admin-payouts/overview", Ctrl.getAdminPayoutsOverview);
router.get("/admin-payouts/hotels-lite", Ctrl.listHotelsLite);

/* Admin updates (audit logged in simple top-level fields) */
router.patch("/admin-payouts/commission-status", Ctrl.updateCommissionStatus);
router.patch("/admin-payouts/transfer-status", Ctrl.updateTransferStatus);
router.patch(
	"/admin-payouts/update-reservation",
	Ctrl.updateReservationPayoutFlags
);

/* NEW: Auto reconcile a single hotel */
router.post("/admin-payouts/reconcile", Ctrl.autoReconcileHotel);

module.exports = router;
