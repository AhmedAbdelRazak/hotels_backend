/** @format */

const express = require("express");
const router = express.Router();
const { requireSignin, isAuth, isAdmin } = require("../controllers/auth");
const { userById } = require("../controllers/user");

const {
	createNewTrackingUncompleteReservation,
	listOfActualUncompleteReservation,
} = require("../controllers/uncompletedReservations");

router.post(
	"/create-uncomplete-reservation-document",
	createNewTrackingUncompleteReservation
);
router.get(
	"/uncomplete-reservations-list/:userId",
	requireSignin,
	isAuth,
	isAdmin,
	listOfActualUncompleteReservation
);

router.param("userId", userById);

module.exports = router;
