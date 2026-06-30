const express = require("express");
const router = express.Router();
const supportCaseController = require("../controllers/supportcase");
const {
	requireSignin,
	requireAdminAccess,
} = require("../controllers/auth");

// Middleware to attach io to req
const attachIo = (req, res, next) => {
	req.io = req.app.get("io");
	next();
};

// Create a new support case
router.post(
	"/support-cases/contact",
	attachIo,
	supportCaseController.createContactSupportCase
);

router.post(
	"/support-cases/new",
	attachIo,
	supportCaseController.createNewSupportCase
);

const customerServiceAccess = [
	requireSignin,
	requireAdminAccess("CustomerService"),
];

router.get(
	"/support-cases/recipients/:userId",
	...customerServiceAccess,
	supportCaseController.getSupportChatRecipients
);

router.get(
	"/support-cases/notifications/summary/:userId",
	...customerServiceAccess,
	supportCaseController.getSupportCaseNotificationSummary
);

router.get(
	"/support-cases/active",
	...customerServiceAccess,
	supportCaseController.getOpenSupportCases
);
router.get(
	"/support-cases-clients/active",
	...customerServiceAccess,
	supportCaseController.getOpenSupportCasesClients
);
router.get(
	"/support-cases-clients/escalated",
	...customerServiceAccess,
	supportCaseController.getEscalatedSupportCasesClients
);
router.get(
	"/support-cases-hotels/active/:hotelId",
	supportCaseController.getOpenSupportCasesForHotel
);

router.get(
	"/support-cases-hotels-clients/active/:hotelId",
	requireSignin,
	supportCaseController.getOpenSupportCasesForHotelClients
);

router.get(
	"/support-cases-hotels/detail/:hotelId/:id",
	requireSignin,
	supportCaseController.getSupportCaseForHotelById
);

router.put(
	"/support-cases-hotels/detail/:hotelId/:id",
	requireSignin,
	attachIo,
	supportCaseController.updateSupportCaseForHotel
);

router.get(
	"/support-cases/closed",
	...customerServiceAccess,
	supportCaseController.getCloseSupportCases
);
router.get(
	"/support-cases/closed/clients",
	...customerServiceAccess,
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
router.get(
	"/support-cases/client/:id",
	supportCaseController.getPublicClientSupportCaseById
);

router.put(
	"/support-cases/client/:id",
	attachIo,
	supportCaseController.updatePublicClientSupportCase
);

router.get(
	"/support-cases/:id",
	...customerServiceAccess,
	supportCaseController.getSupportCaseById
);

// Update a support case by ID
router.put(
	"/support-cases/:id",
	...customerServiceAccess,
	attachIo,
	supportCaseController.updateSupportCase
);

// Fetch unseen messages by Super Admin or PMS Owner
router.get(
	"/support-cases/:hotelId/unseen/admin-owner",
	...customerServiceAccess,
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

router.get(
	"/support-cases-customer/:caseId/unseen-count",
	supportCaseController.getUnseenMessagesCountByCustomerCase
);

// Update seen status for Admin or Owner
router.put(
	"/support-cases/:id/seen/admin-owner",
	...customerServiceAccess,
	supportCaseController.updateSeenStatusForAdminOrOwner
);

// Update seen status for Client
router.put(
	"/support-cases/:id/seen/client",
	supportCaseController.updateSeenStatusForClient
);

router.get(
	"/support-cases/unseen/count",
	...customerServiceAccess,
	supportCaseController.getUnseenMessagesCountByAdmin
);

router.put(
	"/support-cases/:id/seen-by-admin",
	...customerServiceAccess,
	supportCaseController.markAllMessagesAsSeenByAdmin
);

router.put(
	"/support-cases/:id/seen-by-hotel",
	supportCaseController.markAllMessagesAsSeenByHotels
);

router.put(
	"/mark-all-cases-as-seen",
	...customerServiceAccess,
	supportCaseController.markEverythingAsSeen
);

router.delete(
	"/support-cases/:caseId/messages/:messageId",
	...customerServiceAccess,
	attachIo, // Attach the `io` instance
	supportCaseController.deleteMessageFromConversation
);

module.exports = router;
