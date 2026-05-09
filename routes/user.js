/** @format */

"use strict";

const express = require("express");
const router = express.Router();

const {
	requireSignin,
	isAuth,
	isAdmin,
	isHotelOwner,
} = require("../controllers/auth");

const {
	userById,
	read,
	update,
	allUsersList,
	updateUserByAdmin,
	updatedUserId,
	getSingleUser,
	houseKeepingStaff,
	listHotelStaffUsers,
	updateHotelStaffUser,
	allHotelAccounts,
} = require("../controllers/user");

/* Admin-only secret probe */
router.get("/secret/:userId", requireSignin, isAuth, isAdmin, (req, res) => {
	res.json({ user: req.profile });
});

/* Self read/update */
router.get("/user/:userId", requireSignin, isAuth, read);
router.put("/user/:userId", requireSignin, isAuth, update);

/* Admin lists */
router.get("/allUsers/:userId", requireSignin, isAuth, isAdmin, allUsersList);
router.get(
	"/all-hotel-accounts/:userId",
	requireSignin,
	isAuth,
	isAdmin,
	allHotelAccounts
);

/* Read account data (requires auth) */
router.get(
	"/account-data/:accountId/:userId",
	requireSignin,
	isAuth,
	getSingleUser
);

/* Admin updates target user (owner account) */
router.put(
	"/user/:updatedUserId/:userId",
	requireSignin,
	isAuth,
	isAdmin,
	updateUserByAdmin
);

/* Housekeeping staff list */
router.get("/house-keeping-staff/:hotelId", requireSignin, houseKeepingStaff);

/* Hotel-scoped staff management */
router.get(
	"/hotel-staff/:hotelId/:userId",
	requireSignin,
	isAuth,
	listHotelStaffUsers
);
router.put(
	"/hotel-staff/:staffId/:hotelId/:userId",
	requireSignin,
	isAuth,
	updateHotelStaffUser
);

/* Param resolvers */
router.param("userId", userById);
router.param("updatedUserId", updatedUserId);

module.exports = router;
