/** @format */

const express = require("express");
const router = express.Router();
const { requireSignin, isAuth } = require("../controllers/auth");
const { userById } = require("../controllers/user");
const {
	otaCalendarOptions,
	prepareOtaCalendar,
	readOtaCalendarJob,
} = require("../controllers/ota_calendar");

router.get("/ota-calendar/options/:userId", requireSignin, isAuth, otaCalendarOptions);
router.post("/ota-calendar/jobs/:userId/prepare", requireSignin, isAuth, prepareOtaCalendar);
router.get("/ota-calendar/jobs/:userId/:jobId", requireSignin, isAuth, readOtaCalendarJob);

router.param("userId", userById);

module.exports = router;
