/** @format */

const express = require("express");
const router = express.Router();

const {
	signup,
	signin,
	signout,
	forgotPassword,
	resetPassword,
	googleLogin,
	propertySignup,
	createHotelStaffUser,
	requireSignin,
	isAuth,
} = require("../controllers/auth");
const { userById } = require("../controllers/user");

router.post("/signup", signup);
router.post("/property-listing", propertySignup);
router.post(
	"/hotel-staff/create/:userId",
	requireSignin,
	isAuth,
	createHotelStaffUser
);
router.post("/signin", signin);
router.get("/signout", signout);

router.put("/forgot-password", forgotPassword);
router.put("/reset-password", resetPassword);
router.post("/forgot-password", forgotPassword);
router.post("/reset-password", resetPassword);

router.post("/google-login", googleLogin);

router.param("userId", userById);

module.exports = router;
