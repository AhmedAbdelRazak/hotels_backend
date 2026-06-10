/** @format */

const express = require("express");
const router = express.Router();

const { requireSignin, isAuth } = require("../controllers/auth");
const { userById } = require("../controllers/user");
const {
	createUpdateZadWebsiteDocument,
	listZadWebsiteDocuments,
	listOfAllActiveZadHotels,
	getZadHotelFromSlug,
	getZadListOfHotels,
	distinctZadRoomTypes,
	gettingZadRoomListFromQuery,
	listOfAllActiveZadHotelsMonthlyAndOffers,
	getZadScopeHealth,
} = require("../controllers/zadcontroller");

router.get("/zad-website-document", listZadWebsiteDocuments);
router.post(
	"/zad-website/:documentId/:userId",
	requireSignin,
	isAuth,
	createUpdateZadWebsiteDocument
);

router.get("/zad/scope-health", getZadScopeHealth);
router.get("/zad/active-hotels", listOfAllActiveZadHotels);
router.get("/zad/active-hotel-list", getZadListOfHotels);
router.get("/zad/distinct-rooms", distinctZadRoomTypes);
router.get("/zad/single-hotel/:hotelSlug", getZadHotelFromSlug);
router.get("/zad/room-query-list/:query", gettingZadRoomListFromQuery);
router.get(
	"/zad/hotels/active-with-deals",
	listOfAllActiveZadHotelsMonthlyAndOffers
);

router.param("userId", userById);

module.exports = router;

