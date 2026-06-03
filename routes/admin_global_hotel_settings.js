/** @format */

"use strict";

const express = require("express");
const router = express.Router();
const {
	requireSignin,
	isAuth,
	requireAdminAccess,
} = require("../controllers/auth");
const { userById } = require("../controllers/user");
const {
	adminGlobalHotelSettingsOverview,
	adminGlobalRoomManagerOptions,
	saveAdminGlobalRoomManagerRoom,
	adminGlobalCalendarPricingOptions,
	saveAdminGlobalCalendarPricing,
} = require("../controllers/admin_global_hotel_settings");

const requireGlobalHotelSettingsAccess = requireAdminAccess(
	"AdminDashboard",
	"HotelReports"
);

router.get(
	"/admin/global-hotel-settings/overview/:userId",
	requireSignin,
	isAuth,
	requireGlobalHotelSettingsAccess,
	adminGlobalHotelSettingsOverview
);

router.get(
	"/admin/global-hotel-settings/room-manager/:userId",
	requireSignin,
	isAuth,
	requireGlobalHotelSettingsAccess,
	adminGlobalRoomManagerOptions
);

router.post(
	"/admin/global-hotel-settings/room-manager/:userId",
	requireSignin,
	isAuth,
	requireGlobalHotelSettingsAccess,
	saveAdminGlobalRoomManagerRoom
);

router.get(
	"/admin/global-hotel-settings/calendar-pricing/:userId",
	requireSignin,
	isAuth,
	requireGlobalHotelSettingsAccess,
	adminGlobalCalendarPricingOptions
);

router.post(
	"/admin/global-hotel-settings/calendar-pricing/:userId",
	requireSignin,
	isAuth,
	requireGlobalHotelSettingsAccess,
	saveAdminGlobalCalendarPricing
);

router.param("userId", userById);

module.exports = router;
