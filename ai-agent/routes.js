// ai-agent/routes.js
const express = require("express");
const router = express.Router();

router.get("/health", (req, res) => res.json({ ok: true, agent: "ready" }));

module.exports = router;
