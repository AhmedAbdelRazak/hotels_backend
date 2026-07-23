/** @format */
"use strict";

const express = require("express");
const router = express.Router();
const Hosted = require("../controllers/bofaHostedCheckout");
const { requireSignin } = require("../controllers/auth");

const urlencodedParser = express.urlencoded({ extended: false });
const jsonParser = express.json({ limit: "32kb", strict: true });

/*
 * Secure Acceptance embedded Hosted Checkout. Card data posts directly from
 * the browser to Bank of America and never enters this application server.
 */
router.post(
	"/bofa/checkout/session",
	requireSignin,
	jsonParser,
	Hosted.createSession,
);
router.get(
	"/bofa/checkout/callback/customer",
	Hosted.healthCallback("customer_response"),
);
router.get(
	"/bofa/checkout/callback/merchant",
	Hosted.healthCallback("merchant_post"),
);
router.post(
	"/bofa/checkout/callback/customer",
	urlencodedParser,
	Hosted.customerCallback,
);
router.post(
	"/bofa/checkout/callback/merchant",
	urlencodedParser,
	Hosted.merchantCallback,
);

/*
 * OTA VCC readiness and durable payment status.
 */
router.get("/bofa/health", requireSignin, Hosted.getHealth);
router.get(
	"/reservations/bofa/vcc-status/:reservationId",
	requireSignin,
	Hosted.getStatus,
);

module.exports = router;
