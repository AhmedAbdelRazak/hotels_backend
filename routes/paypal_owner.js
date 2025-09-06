"use strict";

const express = require("express");
const router = express.Router();
const Ctrl = require("../controllers/paypal_owner");

/* JS SDK client token (owner) */
router.get("/paypal-owner/token-generated", Ctrl.generateClientToken);

/* Setup token → used by Card Fields & Buttons (vault without purchase) */
router.post("/paypal-owner/setup-token", Ctrl.createSetupToken);

/* Exchange setup_token → vault token and save on hotel */
router.post("/paypal-owner/vault/exchange", Ctrl.vaultExchangeAndSave);

/* List / default / activate / deactivate / delete (soft) */
router.get("/paypal-owner/payment-methods/:hotelId", Ctrl.listPaymentMethods);
router.post("/paypal-owner/payment-methods/set-default", Ctrl.setDefaultMethod);
router.post("/paypal-owner/payment-methods/activate", Ctrl.activateMethod);
router.post("/paypal-owner/payment-methods/deactivate", Ctrl.deactivateMethod);
router.post("/paypal-owner/payment-methods/delete", Ctrl.deleteMethod);
/* List checked-out + (Paid Offline | Not Paid) reservations for a hotel */
router.get(
	"/paypal-owner/commission/candidates",
	Ctrl.listCommissionCandidates
);

/* Mark commission as paid for a batch of reservations */
router.post("/paypal-owner/commission/mark-paid", Ctrl.markCommissionPaid);

module.exports = router;
