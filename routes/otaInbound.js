/** @format */

const express = require("express");
const router = express.Router();
const { requireSignin } = require("../controllers/auth");
const {
	parseInboundForm,
	inboundEmailHealth,
	handleInboundEmail,
	requireInboundEmailAdmin,
	listInboundEmails,
	singleInboundEmail,
} = require("../controllers/otaInbound");

router.get(["/inbound/email", "/ota/inbound/email"], inboundEmailHealth);

router.post(
	["/inbound/email", "/ota/inbound/email"],
	parseInboundForm,
	handleInboundEmail
);

router.get(
	"/inbound-emails/single/:inboundEmailId",
	requireSignin,
	requireInboundEmailAdmin,
	singleInboundEmail
);
router.get(
	"/inbound-emails/:page/:records",
	requireSignin,
	requireInboundEmailAdmin,
	listInboundEmails
);

module.exports = router;
