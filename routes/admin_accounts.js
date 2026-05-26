/** @format */

"use strict";

const express = require("express");
const router = express.Router();

const { requireSignin, isAuth, requireAdminAccess } = require("../controllers/auth");
const { userById } = require("../controllers/user");
const {
	listAdminAccounts,
	createAdminHotelStaffAccount,
	createAdminPlatformStaffAccount,
	updateAdminAccount,
} = require("../controllers/admin_accounts");

router.get(
	"/admin/accounts/:userId",
	requireSignin,
	isAuth,
	requireAdminAccess("AdminAccounts"),
	listAdminAccounts
);

router.post(
	"/admin/accounts/hotel-staff/:userId",
	requireSignin,
	isAuth,
	requireAdminAccess("AdminAccounts"),
	createAdminHotelStaffAccount
);

router.post(
	"/admin/accounts/platform-staff/:userId",
	requireSignin,
	isAuth,
	requireAdminAccess("AdminAccounts"),
	createAdminPlatformStaffAccount
);

router.put(
	"/admin/accounts/:accountId/:userId",
	requireSignin,
	isAuth,
	requireAdminAccess("AdminAccounts"),
	updateAdminAccount
);

router.param("userId", userById);

module.exports = router;
