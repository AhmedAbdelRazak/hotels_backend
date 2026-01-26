"use strict";

const express = require("express");
const router = express.Router();
const Ctrl = require("../controllers/paypal_reservation");

/* Route 1: JS SDK client token for Card Fields (3‑DS) */
router.get("/paypal/token-generated", Ctrl.generateClientToken);
router.post("/paypal/token-generated", Ctrl.generateClientToken);
router.post("/paypal/order/create", Ctrl.createPayPalOrder);
router.post("/reservations/paypal/pending", Ctrl.preparePendingReservation);
router.post("/reservations/paypal/pending-cancel", Ctrl.cancelPendingReservation);

/* Route 2: One‑call reservation creation + PayPal handling
   - Handles: Not Paid (with/without card), Deposit Paid, Paid Online
*/
router.post("/reservations/paypal/create", Ctrl.createReservationAndProcess);

/* Route 3: Post‑stay charge (MIT with vault token) — with hard cap guard */
router.post("/reservations/paypal/mit-charge", Ctrl.mitChargeReservation);

/* Route 4: Standalone credit precheck (auth+void on exact amount) */
router.post("/paypal/credit-precheck", Ctrl.creditPrecheck);

/* Route 5: Exchange setup_token → vault token */
router.post("/paypal/vault/exchange", Ctrl.vaultExchange);

/* Route 6: Update capture limit when reservation changes */
router.post("/reservations/paypal/update-limit", Ctrl.updateCaptureLimit);

/* Route 7: Inspect PayPal ledger for a reservation (debug/admin) */
router.get("/reservations/paypal/ledger/:reservationId", Ctrl.getLedger);

/* Route 8: Webhook endpoint (optional) */
router.post("/paypal/webhook", Ctrl.webhook);

/* Route 9: Link‑pay (guest pays against an existing reservation) */
router.post("/reservations/paypal/link-pay", Ctrl.linkPayReservation);

/* Route 10: Verification endpoint (create reservation from email JWT) */
router.post(
	"/paypal/reservation-verification",
	Ctrl.verifyReservationAndCreate
);

/* OPTIONAL: “Save card later” button to attach a vault token */
router.post("/reservations/attach-vault", Ctrl.attachVaultToReservation);

module.exports = router;
