const express = require("express");
const router = express.Router();
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const { requireSignin, isAuth } = require("../controllers/auth");
const { userById } = require("../controllers/user");
const {
	processPayment,
	processPaymentWithCommission,
	processSubscription,
	createPaymentIntent,
	createCheckoutSession,
	stripeWebhook,
} = require("../controllers/stripe");

// Stripe payment routes
router.post("/stripe/payment/:reservationId", processPayment);
// Route for creating Payment Intent and returning the client secret
router.post("/create-payment-intent", createPaymentIntent);

router.post("/stripe/commission-payment", processPaymentWithCommission);

// Stripe subscription routes
router.post("/stripe/subscription", processSubscription);

router.post("/create-checkout-session", createCheckoutSession);
router.post(
	"/webhook",
	express.raw({ type: "application/json" }),
	stripeWebhook
);

// User parameter to automatically load user data
router.param("userId", userById);

module.exports = router;
