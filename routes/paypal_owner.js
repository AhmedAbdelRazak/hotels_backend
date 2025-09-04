/** routes/paypal_owner.js */
const express = require("express");
const router = express.Router();

const {
	listOwnerPaymentMethods,
	saveOwnerCard,
	setOwnerDefaultCard,
	removeOwnerCard,
	generateClientToken,
} = require("../controllers/paypal_owner");

// If you use param middleware for :hotelId you can keep it; not required here

// PayPal JS SDK client token (frontend calls this)
router.get("/paypal/token-generated", generateClientToken);

// Owner/company cards for a hotel
router.get("/hotels/:hotelId/paypal/owner/methods", listOwnerPaymentMethods);
router.post("/hotels/:hotelId/paypal/owner/save-card", saveOwnerCard);
router.post(
	"/hotels/:hotelId/paypal/owner/methods/:vaultId/default",
	setOwnerDefaultCard
);
router.delete(
	"/hotels/:hotelId/paypal/owner/methods/:vaultId",
	removeOwnerCard
);

module.exports = router;
