const express = require("express");
const router = express.Router();
const supportCaseController = require("../controllers/supportcase");

// Middleware to attach io to req
const attachIo = (req, res, next) => {
	req.io = req.app.get("io");
	next();
};

// Create a new support case
router.post(
	"/support-cases/new",
	attachIo,
	supportCaseController.createNewSupportCase
);

router.get("/support-cases/active", supportCaseController.getOpenSupportCases);
router.get(
	"/support-cases-clients/active",
	supportCaseController.getOpenSupportCasesClients
);
router.get(
	"/support-cases-hotels/active/:hotelId",
	supportCaseController.getOpenSupportCasesForHotel
);

router.get("/support-cases/closed", supportCaseController.getCloseSupportCases);
router.get(
	"/support-cases/closed/clients",
	supportCaseController.getCloseSupportCasesClients
);
router.get(
	"/support-cases-hotels/closed/:hotelId",
	supportCaseController.getCloseSupportCasesForHotel
);

router.get(
	"/support-cases-hotels-clients/closed/:hotelId",
	supportCaseController.getCloseSupportCasesForHotelClients
);

// Get a specific support case by ID
router.get("/support-cases/:id", supportCaseController.getSupportCaseById);

// Update a support case by ID
router.put(
	"/support-cases/:id",
	attachIo,
	supportCaseController.updateSupportCase
);

// Fetch unseen messages by Super Admin or PMS Owner
router.get(
	"/support-cases/:hotelId/unseen/admin-owner",
	supportCaseController.getUnseenMessagesCountByAdmin
);

// Fetch unseen messages by Hotel Owner
router.get(
	"/support-cases/:hotelId/unseen/hotel-owner",
	supportCaseController.getUnseenMessagesCountByHotelOwner
);

// Fetch unseen messages by Regular Client
router.get(
	"/support-cases-client/:clientId/unseen",
	supportCaseController.getUnseenMessagesByClient
);

// Update seen status for Admin or Owner
router.put(
	"/support-cases/:id/seen/admin-owner",
	supportCaseController.updateSeenStatusForAdminOrOwner
);

// Update seen status for Client
router.put(
	"/support-cases/:id/seen/client",
	supportCaseController.updateSeenStatusForClient
);

router.get(
	"/support-cases/unseen/count",
	supportCaseController.getUnseenMessagesCountByAdmin
);

router.put(
	"/support-cases/:id/seen-by-admin",
	supportCaseController.markAllMessagesAsSeenByAdmin
);

router.put(
	"/support-cases/:id/seen-by-hotel",
	supportCaseController.markAllMessagesAsSeenByHotels
);

router.put(
	"/mark-all-cases-as-seen",
	supportCaseController.markEverythingAsSeen
);

module.exports = router;
