/** @format */

const express = require("express");
const router = express.Router();
const { requireSignin, isAuth, requireAdminAccess } = require("../controllers/auth");
const {
	prepareOtaReservationSync,
	readOtaReservationSyncJob,
	runOtaReservationSyncCollector,
	submitOtaReservationSyncMfa,
	applyOtaReservationSyncJob,
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
	"/admin/ota-reservation-sync/jobs/:userId/:jobId/mfa",
	requireSignin,
	isAuth,
	requireAdminAccess("HotelsReservations", "AllReservations"),
	submitOtaReservationSyncMfa
);

router.post(
	"/admin/ota-reservation-sync/jobs/:userId/:jobId/apply",
	requireSignin,
	isAuth,
	requireAdminAccess("HotelsReservations", "AllReservations"),
	applyOtaReservationSyncJob
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

router.post(
	"/admin/expedia-reservation-sync/jobs/:userId/:jobId/mfa",
	requireSignin,
	isAuth,
	requireAdminAccess("HotelsReservations", "AllReservations"),
	submitOtaReservationSyncMfa
);

router.post(
	"/admin/expedia-reservation-sync/jobs/:userId/:jobId/apply",
	requireSignin,
	isAuth,
	requireAdminAccess("HotelsReservations", "AllReservations"),
	applyOtaReservationSyncJob
);

module.exports = router;
