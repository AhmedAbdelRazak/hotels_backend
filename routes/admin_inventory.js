/** @format */

const express = require("express");
const router = express.Router();

const { requireSignin, isAuth } = require("../controllers/auth");
const { userById } = require("../controllers/user");
const {
	getHotelInventoryAvailability,
} = require("../controllers/hotel_inventory");

// Admin/PMS availability endpoint (separate from hotel manager endpoints)
router.get(
	"/admin/hotel-inventory/:hotelId/availability/:userId",
	requireSignin,
	isAuth,
	getHotelInventoryAvailability
);

router.param("userId", userById);

module.exports = router;
