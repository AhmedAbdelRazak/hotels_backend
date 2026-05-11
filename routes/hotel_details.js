/** @format */

const express = require("express");
const router = express.Router();
const {
	requireSignin,
	isAuth,
	isHotelOwner,
	isAdmin,
} = require("../controllers/auth");
const { userById } = require("../controllers/user");

const {
	create,
	hotelDetailsById,
	read,
	list,
	listForAdmin,
	updateHotelDetails,
	listOfHotelUser,
	listForAdminAll,
	reassignHotelOwner,
	hotelGeneralStats,
	managerExecutiveSummary,
	managerIncompleteReservations,
	hotelOpenReservations,
	hotelIncompleteReservations,
	saveOwnerPaymentMethod,
	getOwnerPaymentMethods,
	setOwnerDefaultPaymentMethod,
	removeOwnerPaymentMethod,
} = require("../controllers/hotel_details");

router.get(
	"/hotel-details/stats/:hotelId/:userId",
	requireSignin,
	isAuth,
	hotelGeneralStats
);

router.get(
	"/hotel-details/executive-summary/:userId",
	requireSignin,
	isAuth,
	managerExecutiveSummary
);

router.get(
	"/hotel-details/executive-incomplete-reservations/:userId",
	requireSignin,
	isAuth,
	managerIncompleteReservations
);

router.get(
	"/hotel-details/open-reservations/:hotelId/:userId",
	requireSignin,
	isAuth,
	hotelOpenReservations
);

router.get(
	"/hotel-details/incomplete-reservations/:hotelId/:userId",
	requireSignin,
	isAuth,
	hotelIncompleteReservations
);

router.get("/hotel-details/:hotelDetailsId", read); // Consolidated into a single route

router.post(
	"/hotel-details/create/:userId",
	requireSignin,
	isAuth,
	isHotelOwner,
	create
);

router.get("/hotel-details/account/:accountId", list); // Adjusted for clarity
router.get("/hotel-details/super-admin/:accountId", listOfHotelUser);
router.get(
	"/hotel-details/admin/:userId",
	requireSignin,
	isAdmin,
	listForAdmin
);

router.get(
	"/all/hotel-details/admin/:userId",
	requireSignin,
	isAdmin,
	listForAdminAll
);

router.put(
	"/hotel-details/update/:hotelId/:userId",
	requireSignin,
	isAuth,
	isHotelOwner,
	updateHotelDetails
);

router.put(
	"/hotel-details/reassign-owner/:hotelId/:userId",
	requireSignin,
	isAuth,
	reassignHotelOwner
);

/* Owner payment methods (save/list/manage) */
router.post("/hotels/:hotelId/paypal/owner/save-card", saveOwnerPaymentMethod);
router.get("/hotels/:hotelId/paypal/owner/methods", getOwnerPaymentMethods);
router.post(
	"/hotels/:hotelId/paypal/owner/methods/:vaultId/default",
	setOwnerDefaultPaymentMethod
);
router.delete(
	"/hotels/:hotelId/paypal/owner/methods/:vaultId",
	removeOwnerPaymentMethod
);

router.param("userId", userById);
router.param("hotelDetailsId", hotelDetailsById);

module.exports = router;
