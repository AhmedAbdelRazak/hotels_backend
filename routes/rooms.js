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
	roomById,
	read,
	update,
	list,
	listForAdmin,
	listOfRoomsSummary,
	getDistinctRoomTypes,
	getDistinctRoomTypesFromReservations,
	reservedRoomsSummary,
	roomsInventorySummary,
	deleteRooms,
	remove,
} = require("../controllers/rooms");

router.get("/room-single/:roomId", read);

router.post(
	"/room/create/:userId",
	requireSignin,
	isAuth,
	isHotelOwner,
	create
);

router.put(
	"/room/:roomId/:userId",
	requireSignin,
	isAuth,
	isHotelOwner,
	update
);

router.delete(
	"/room/:roomId/:userId",
	requireSignin,
	isAuth,
	isHotelOwner,
	remove
);

router.get("/room/:accountId/:mainUserId", list);
router.delete("/room-deletion/:hotelId", deleteRooms);
router.get("/distinct", getDistinctRoomTypes);
router.get(
	"/reservations-distinct-rooms",
	getDistinctRoomTypesFromReservations
);
// router.delete("/room/delete", removeDuplicates);

router.get("/room/:checkin/:checkout/:accoundId", listOfRoomsSummary);
router.get("/room-admin", isAuth, isAdmin, listForAdmin);
router.get(
	"/room-inventory-reserved/:startdate/:enddate/:belongsTo/:accountId",
	reservedRoomsSummary
);
router.get("/inventory-report/:belongsTo/:accountId", roomsInventorySummary);

router.param("userId", userById);
router.param("roomId", roomById);

module.exports = router;
