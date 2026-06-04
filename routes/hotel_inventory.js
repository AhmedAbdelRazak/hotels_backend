/** @format */

const express = require("express");
const router = express.Router();
const { optionalSignin } = require("../controllers/auth");

const {
	getHotelInventoryCalendar,
	getHotelInventoryDay,
	getHotelInventoryAvailability,
} = require("../controllers/hotel_inventory");

router.get("/hotel-inventory/:hotelId/calendar", getHotelInventoryCalendar);
router.get("/hotel-inventory/:hotelId/day", getHotelInventoryDay);
router.get(
	"/hotel-inventory/:hotelId/availability",
	optionalSignin,
	getHotelInventoryAvailability
);

module.exports = router;
