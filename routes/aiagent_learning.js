// routes/aiagent_learning.js
const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/aiagent_learning");

// No auth (you trigger via Postman)
router.post("/aiagent-learning/build", ctrl.buildFromSupportCases);
router.get("/aiagent-learning/guidance", ctrl.previewGuidance);
router.delete("/aiagent-learning/clear", ctrl.clearGuidance);
router.get("/aiagent-learning/selftest", ctrl.selfTest);

module.exports = router;
