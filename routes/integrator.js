/** @format */

const express = require("express");
const router = express.Router();
const {
	requireSignin,
	isAuth,
	requireAdminAccess,
} = require("../controllers/auth");
const { agodaDataDump, expediaDataDump } = require("../controllers/integrator");
const { userById } = require("../controllers/user");
const multer = require("multer");
const upload = multer({ dest: "uploads/" });

router.post(
	"/reservations/agoda-data-dump/xhotel-admin/:accountId/:belongsTo/:userId",
	upload.single("file"),
	requireSignin,
	isAuth,
	requireAdminAccess("Integrator"),
	agodaDataDump
);

router.post(
	"/reservations/expedia-data-dump/xhotel-admin/:accountId/:belongsTo/:userId",
	upload.single("file"),
	requireSignin,
	isAuth,
	requireAdminAccess("Integrator"),
	expediaDataDump
);

router.param("userId", userById);

module.exports = router;
