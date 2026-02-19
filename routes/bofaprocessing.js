/** @format */
"use strict";

const express = require("express");
const router = express.Router();
const Ctrl = require("../controllers/bofaprocessing");
const { requireSignin } = require("../controllers/auth");

const urlencodedParser = express.urlencoded({ extended: false });
const jsonParser = express.json();

/*
 * Secure Acceptance checkout flow (guest browser posts card directly to BoA).
 */
router.post(
	"/bofa/checkout/session",
	jsonParser,
	Ctrl.createGuestCheckoutSession,
);
router.get("/bofa/checkout/callback/customer", (_req, res) =>
	res.status(200).json({ ok: true, source: "customer_response" }),
);
router.get("/bofa/checkout/callback/merchant", (_req, res) =>
	res.status(200).json({ ok: true, source: "merchant_post" }),
);
router.post(
	"/bofa/checkout/response/verify",
	urlencodedParser,
	Ctrl.verifyCheckoutResponseSignature,
);
router.post(
	"/bofa/checkout/callback/customer",
	urlencodedParser,
	Ctrl.handleCustomerResponsePagePost,
);
router.post(
	"/bofa/checkout/callback/merchant",
	urlencodedParser,
	Ctrl.handleMerchantPostNotification,
);

/*
 * OTA VCC flow (server-to-server REST Payments API).
 */
router.get(
	"/reservations/bofa/vcc-status/:reservationId",
	requireSignin,
	Ctrl.getReservationBofaVccStatus,
);
router.post(
	"/reservations/bofa/vcc-sale",
	requireSignin,
	jsonParser,
	Ctrl.captureReservationVccSale,
);
router.post(
	"/reservations/bofa/vcc-charge",
	requireSignin,
	jsonParser,
	Ctrl.captureReservationVccSale,
);

module.exports = router;
