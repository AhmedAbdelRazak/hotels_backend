/** @format */

const express = require("express");
const router = express.Router();
const { requireSignin, isAuth, requireAdminAccess } = require("../controllers/auth");
const {
	prepareOtaReservationSync,
	readOtaReservationSyncJob,
	runOtaReservationSyncCollector,
} = require("../controllers/expedia_reservation_sync");

router.post(
	"/admin/ota-reservation-sync/jobs/:userId/prepare",
	requireSignin,
	isAuth,
	requireAdminAccess("HotelsReservations", "AllReservations"),
	prepareOtaReservationSync
);

router.get(
	"/admin/ota-reservation-sync/jobs/:userId/:jobId",
	requireSignin,
	isAuth,
	requireAdminAccess("HotelsReservations", "AllReservations"),
	readOtaReservationSyncJob
);

router.post(
	"/admin/ota-reservation-sync/jobs/:userId/:jobId/run",
	requireSignin,
	isAuth,
	requireAdminAccess("HotelsReservations", "AllReservations"),
	runOtaReservationSyncCollector
);

router.post(
	"/admin/expedia-reservation-sync/jobs/:userId/prepare",
	requireSignin,
	isAuth,
	requireAdminAccess("HotelsReservations", "AllReservations"),
	prepareOtaReservationSync
);

router.get(
	"/admin/expedia-reservation-sync/jobs/:userId/:jobId",
	requireSignin,
	isAuth,
	requireAdminAccess("HotelsReservations", "AllReservations"),
	readOtaReservationSyncJob
);

router.post(
	"/admin/expedia-reservation-sync/jobs/:userId/:jobId/run",
	requireSignin,
	isAuth,
	requireAdminAccess("HotelsReservations", "AllReservations"),
	runOtaReservationSyncCollector
);

module.exports = router;
