/** @format */
"use strict";

const express = require("express");
const router = express.Router();
const { requireSignin } = require("../controllers/auth");
const Ctrl = require("../controllers/braintree_reservation");

router.get(
	"/braintree/vcc/token-generated",
	requireSignin,
	Ctrl.generateBraintreeVccClientToken,
);

router.get(
	"/reservations/braintree/vcc-status/:reservationId",
	requireSignin,
	Ctrl.getReservationBraintreeVccStatus,
);

router.post(
	"/reservations/braintree/vcc-charge",
	requireSignin,
	Ctrl.chargeReservationViaBraintreeVcc,
);

module.exports = router;

