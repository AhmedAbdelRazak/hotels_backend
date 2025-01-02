/** @format */

const express = require("express");
const router = express.Router();
const { requireSignin, isAuth, isAdmin } = require("../controllers/auth");

const { userById } = require("../controllers/user");
const {
	createUpdateDocument,
	list,
	listOfAllActiveHotels,
	distinctRoomTypes,
	getHotelFromSlug,
	getListOfHotels,
	gettingRoomListFromQuery,
	createNewReservationClient,
	getUserAndReservationData,
	getHotelDetailsById,
	getHotelDistancesFromElHaram,
	gettingCurrencyConversion,
	getCurrencyRates,
	gettingByReservationId,
	paginatedReservationList,
	sendingEmailForPaymentLink,
	verifyReservationToken,
} = require("../controllers/janat");
const { createPayment } = require("../controllers/authorizenet");

router.post("/janat-website/:documentId", createUpdateDocument);
router.get("/janat-website-document", list);
router.get("/active-hotels", listOfAllActiveHotels);
router.get("/single-hotel/:hotelSlug", getHotelFromSlug);
router.get("/active-hotel-list", getListOfHotels);
router.get("/distinct-rooms", distinctRoomTypes);
router.get("/room-query-list/:query", gettingRoomListFromQuery);
router.post("/new-reservation-client", createNewReservationClient);
router.post("/reservation-verification", verifyReservationToken);
router.get("/user/reservations/:userId", getUserAndReservationData);
router.get("/user/hotel/:hotelId", getHotelDetailsById);
router.put("/getting-distances", getHotelDistancesFromElHaram);
router.post("/create-payment", createPayment);
router.get("/currencyapi-amounts/:saudimoney", gettingCurrencyConversion);
router.get(
	`/${process.env.GET_RESERVATION}/:reservationId`,
	gettingByReservationId
);
router.get("/currency-rates", getCurrencyRates);
router.get(
	"/all-reservations-list-admin/:userId",
	requireSignin,
	isAuth,
	isAdmin,
	paginatedReservationList
);

router.post(
	"/send-payment-link-email/:userId",
	requireSignin,
	isAuth,
	isAdmin,
	sendingEmailForPaymentLink
);

router.param("userId", userById);

module.exports = router;
