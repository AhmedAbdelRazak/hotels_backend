"use strict";

const express = require("express");
const router = express.Router();
const Ctrl = require("../controllers/paypal_owner");
const { requireSignin } = require("../controllers/auth");
const {
	PAYPAL_OWNER_CAPABILITIES,
	requirePayPalOwnerActor,
	requirePayPalOwnerHotelAccess,
} = require("../services/paypalOwnerAccess");

const canRequestOwnerToken = [
	requireSignin,
	requirePayPalOwnerActor(PAYPAL_OWNER_CAPABILITIES.TOKEN),
];
const canManageOwnerPaymentMethods = [
	requireSignin,
	requirePayPalOwnerHotelAccess(PAYPAL_OWNER_CAPABILITIES.PAYMENT_METHODS),
];
const canUseOwnerFinance = [
	requireSignin,
	requirePayPalOwnerHotelAccess(PAYPAL_OWNER_CAPABILITIES.FINANCE),
];

/* Owner vault: client token + setup tokens + save/delete */
router.get(
	"/paypal-owner/token-generated",
	...canRequestOwnerToken,
	Ctrl.generateClientToken
);
router.post(
	"/paypal-owner/setup-token",
	...canRequestOwnerToken,
	Ctrl.createSetupToken
);
router.post(
	"/paypal-owner/vault/exchange",
	...canManageOwnerPaymentMethods,
	Ctrl.vaultExchangeAndSave
);
router.get(
	"/paypal-owner/payment-methods/:hotelId",
	...canManageOwnerPaymentMethods,
	Ctrl.listPaymentMethods
);
router.post(
	"/paypal-owner/payment-methods/set-default",
	...canManageOwnerPaymentMethods,
	Ctrl.setDefaultMethod
);
router.post(
	"/paypal-owner/payment-methods/activate",
	...canManageOwnerPaymentMethods,
	Ctrl.activateMethod
);
router.post(
	"/paypal-owner/payment-methods/deactivate",
	...canManageOwnerPaymentMethods,
	Ctrl.deactivateMethod
);
router.post(
	"/paypal-owner/payment-methods/delete",
	...canManageOwnerPaymentMethods,
	Ctrl.deleteMethod
);

/* Commissions & finance */
router.get(
	"/paypal-owner/commissions",
	...canUseOwnerFinance,
	Ctrl.listHotelCommissions
);
router.post(
	"/paypal-owner/commissions/mark-paid",
	...canUseOwnerFinance,
	Ctrl.markCommissionsPaid
);
router.post(
	"/paypal-owner/commissions/charge",
	...canUseOwnerFinance,
	Ctrl.chargeOwnerCommissions
);
router.get(
	"/finance/overview",
	...canUseOwnerFinance,
	Ctrl.getHotelFinanceOverview
);

module.exports = router;
