/** @format */

const express = require("express");
const router = express.Router();
const { requireSignin } = require("../controllers/auth");

const {
	create,
	list,
	totalDocumentCount,
	updateHouseKeepingTask,
	listOfTasksForEmployee,
	listHousekeepingSupplies,
	upsertHousekeepingSupplyItem,
	createHousekeepingSupplyRequest,
	updateHousekeepingSupplyRequest,
} = require("../controllers/housekeeping");

router.post("/house-keeping/create/:hotelId", requireSignin, create);

router.get("/house-keeping-list/:page/:records/:hotelId", requireSignin, list);
router.get(
	"/house-keeping-total-records/:hotelId",
	requireSignin,
	totalDocumentCount
);
router.put(
	"/house-keeping-update-document/:taskId",
	requireSignin,
	updateHouseKeepingTask
);
router.get("/house-keeping-employee/:userId", requireSignin, listOfTasksForEmployee);
router.get("/house-keeping-supplies/:hotelId", requireSignin, listHousekeepingSupplies);
router.post(
	"/house-keeping-supplies/:hotelId/item",
	requireSignin,
	upsertHousekeepingSupplyItem
);
router.post(
	"/house-keeping-supplies/:hotelId/request",
	requireSignin,
	createHousekeepingSupplyRequest
);
router.put(
	"/house-keeping-supplies/request/:requestId",
	requireSignin,
	updateHousekeepingSupplyRequest
);

module.exports = router;
