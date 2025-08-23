"use strict";

const express = require("express");
const router = express.Router();
const Ctrl = require("../controllers/paypal_reservation");

/* Route 1: JS SDK client token for Card Fields (3‑DS) */
router.get("/paypal/client-token", Ctrl.generateClientToken);

/* Route 2: One‑call reservation creation + PayPal handling */
router.post("/reservations/paypal/create", Ctrl.createReservationAndProcess);

/* Route 3: Post‑stay charge (MIT with vault token) — with hard cap guard */
router.post("/reservations/paypal/mit-charge", Ctrl.mitChargeReservation);

/* Route 4 (optional): Standalone credit precheck (auth+void on exact amount) */
router.post("/paypal/credit-precheck", Ctrl.creditPrecheck);

/* Route 5 (optional): Exchange setup_token → vault token */
router.post("/paypal/vault/exchange", Ctrl.vaultExchange);

/* Route 6 (optional): Update capture limit when reservation changes */
router.post("/reservations/paypal/update-limit", Ctrl.updateCaptureLimit);

/* Route 7 (optional): Inspect PayPal ledger for a reservation (debug/admin) */
router.get("/reservations/paypal/ledger/:reservationId", Ctrl.getLedger);

/* Route 8 (optional): Webhook endpoint */
router.post("/paypal/webhook", Ctrl.webhook);

router.post("/reservations/paypal/link-pay", Ctrl.linkPayReservation);

module.exports = router;
