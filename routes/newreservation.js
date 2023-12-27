/** @format */

const express = require("express");
const router = express.Router();
const {
	requireSignin,
	isAuth,
	isHotelOwner,
	isAdmin,
} = require("../controllers/auth");
const { userById } = require("../controllers/user");

const {
	create,
	newReservationById,
	read,
	update,
	list,
	listForAdmin,
	list2,
} = require("../controllers/newreservation");

router.get("/new-reservation-single/:newreservationId", read);

router.post(
	"/new-reservation/create/:userId",
	requireSignin,
	isAuth,
	isHotelOwner,
	create
);

router.put(
	"/new-reservation/:newreservationId/:userId",
	requireSignin,
	isAuth,
	isHotelOwner,
	update
);

router.get("/new-reservation/:accountId", list);
router.get("/new-reservation2/:accountId", list2);
router.get("/new-reservation-admin", isAuth, isAdmin, listForAdmin);

router.param("userId", userById);
router.param("newreservationId", newReservationById);

module.exports = router;
