/** @format */

const express = require("express");
const router = express.Router();
const {
	requireSignin,
	isAuth,
	requireAdminAccess,
} = require("../controllers/auth");
const { userById } = require("../controllers/user");
const hotelRunner = require("../controllers/hotelrunner");

const requireHotelRunnerAdmin = requireAdminAccess(
	"HotelRunnerIntegration",
	"AdminDashboard"
);

router.get("/hotelrunner/callback", hotelRunner.hotelRunnerCallbackHealth);
router.post(
	"/hotelrunner/callback",
	hotelRunner.requireHotelRunnerCallbackAuth,
	hotelRunner.parseHotelRunnerCallbackForm,
	hotelRunner.handleHotelRunnerCallback
);

router.get(
	"/hotelrunner/admin/status/:userId",
	requireSignin,
	isAuth,
	requireHotelRunnerAdmin,
	hotelRunner.hotelRunnerAdminStatus
);
router.get(
	"/hotelrunner/admin/room-mappings/:userId",
	requireSignin,
	isAuth,
	requireHotelRunnerAdmin,
	hotelRunner.listHotelRunnerRoomMappings
);
router.put(
	"/hotelrunner/admin/room-mappings/:mappingId/:userId",
	requireSignin,
	isAuth,
	requireHotelRunnerAdmin,
	hotelRunner.updateHotelRunnerRoomMapping
);

router.param("userId", userById);

module.exports = router;
