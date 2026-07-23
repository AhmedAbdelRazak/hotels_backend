/** @format */
"use strict";

const express = require("express");
const router = express.Router();
const { requireSignin } = require("../controllers/auth");
const {
	requireConfiguredSuperAdmin,
} = require("../controllers/configuredSuperAdmin");
const Ctrl = require("../controllers/braintree_reservation");

router.get(
	"/braintree/vcc/token-generated",
	requireSignin,
	requireConfiguredSuperAdmin,
	Ctrl.generateBraintreeVccClientToken,
);

router.get(
	"/reservations/braintree/vcc-status/:reservationId",
	requireSignin,
	requireConfiguredSuperAdmin,
	Ctrl.getReservationBraintreeVccStatus,
);

router.post(
	"/reservations/braintree/vcc-charge",
	requireSignin,
	requireConfiguredSuperAdmin,
	Ctrl.chargeReservationViaBraintreeVcc,
);

module.exports = router;

