/** @format */

const express = require("express");
const router = express.Router();
const { requireSignin, isAuth, requireAdminAccess } = require("../controllers/auth");
const {
	prepareExpediaReservationSync,
	readExpediaReservationSyncJob,
} = require("../controllers/expedia_reservation_sync");

router.post(
	"/admin/expedia-reservation-sync/jobs/:userId/prepare",
	requireSignin,
	isAuth,
	requireAdminAccess("HotelsReservations", "AllReservations"),
	prepareExpediaReservationSync
);

router.get(
	"/admin/expedia-reservation-sync/jobs/:userId/:jobId",
	requireSignin,
	isAuth,
	requireAdminAccess("HotelsReservations", "AllReservations"),
	readExpediaReservationSyncJob
);

module.exports = router;
