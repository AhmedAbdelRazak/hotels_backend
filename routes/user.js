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

/* Housekeeping list (public for your usage; protect if needed) */
router.get("/house-keeping-staff/:hotelId", houseKeepingStaff);

/* Param resolvers */
router.param("userId", userById);
router.param("updatedUserId", updatedUserId);

module.exports = router;
