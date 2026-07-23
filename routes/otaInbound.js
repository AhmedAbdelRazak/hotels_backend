/** @format */

const express = require("express");
const router = express.Router();
const { requireSignin } = require("../controllers/auth");
const {
	parseInboundForm,
	requireInboundSecret,
	sendgridHealth,
	handleSendGridInbound,
	requireInboundEmailAdmin,
	releaseInboundEmailRetryClaim,
	listInboundEmails,
	singleInboundEmail,
} = require("../controllers/otaInbound");

router.get(["/inbound/sendgrid", "/ota/inbound/sendgrid"], sendgridHealth);

router.post(
	["/inbound/sendgrid", "/ota/inbound/sendgrid"],
	requireInboundSecret,
	parseInboundForm,
	handleSendGridInbound
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
router.post(
	"/inbound-emails/single/:inboundEmailId/retry-claim",
	requireSignin,
	requireInboundEmailAdmin,
	releaseInboundEmailRetryClaim
);

module.exports = router;
