"use strict";

const express = require("express");
const router = express.Router();
const Ctrl = require("../controllers/paypal_owner");

/* Owner vault: client token + setup tokens + save/delete */
router.get("/paypal-owner/token-generated", Ctrl.generateClientToken);
router.post("/paypal-owner/setup-token", Ctrl.createSetupToken);
router.post("/paypal-owner/vault/exchange", Ctrl.vaultExchangeAndSave);
router.get("/paypal-owner/payment-methods/:hotelId", Ctrl.listPaymentMethods);
router.post("/paypal-owner/payment-methods/set-default", Ctrl.setDefaultMethod);
router.post("/paypal-owner/payment-methods/activate", Ctrl.activateMethod);
router.post("/paypal-owner/payment-methods/deactivate", Ctrl.deactivateMethod);
router.post("/paypal-owner/payment-methods/delete", Ctrl.deleteMethod);

/* Commissions & finance */
router.get("/paypal-owner/commissions", Ctrl.listHotelCommissions);
router.post("/paypal-owner/commissions/mark-paid", Ctrl.markCommissionsPaid);
router.post("/paypal-owner/commissions/charge", Ctrl.chargeOwnerCommissions);
router.get("/finance/overview", Ctrl.getHotelFinanceOverview);

module.exports = router;
