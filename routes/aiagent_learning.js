// routes/aiagent_learning.js
const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/aiagent_learning");
const trainingChatCtrl = require("../controllers/aiagent_training_chats");
const {
	requireSignin,
	requireAdminAccess,
} = require("../controllers/auth");

const customerServiceAccess = [
	requireSignin,
	requireAdminAccess("CustomerService"),
];

// No auth (you trigger via Postman)
router.post("/aiagent-learning/build", ctrl.buildFromSupportCases);
router.get("/aiagent-learning/guidance", ctrl.previewGuidance);
router.delete("/aiagent-learning/clear", ctrl.clearGuidance);
router.get("/aiagent-learning/selftest", ctrl.selfTest);

router.post(
	"/aiagent-learning/chats",
	...customerServiceAccess,
	trainingChatCtrl.createTrainingChat
);
router.get(
	"/aiagent-learning/chats",
	...customerServiceAccess,
	trainingChatCtrl.listTrainingChats
);
router.delete(
	"/aiagent-learning/chats/:id",
	...customerServiceAccess,
	trainingChatCtrl.archiveTrainingChat
);

module.exports = router;
