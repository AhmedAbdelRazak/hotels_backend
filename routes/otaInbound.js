// routes/otaInbound.js
const express = require("express");
const multer = require("multer");

const router = express.Router();
const upload = multer();

// Health check (so curl GET works)
router.get("/inbound/sendgrid", (req, res) => {
  res.status(200).json({ ok: true, msg: "SendGrid inbound endpoint is live" });
});

// SendGrid Inbound Parse webhook (POST)
router.post("/inbound/sendgrid", upload.none(), async (req, res) => {
  try {
    const from = req.body.from || "";
    const to = req.body.to || "";
    const subject = req.body.subject || "";

    // IMPORTANT: don't log full email body (Expedia includes VCC card data)
    console.log("[SendGrid Inbound]", { from, to, subject, at: new Date().toISOString() });

    // TODO later: detect provider + parse + upsert reservation into Mongo

    return res.status(200).send("OK");
  } catch (err) {
    console.error("Inbound error:", err.message);
    // Return 200 so SendGrid doesn't retry aggressively
    return res.status(200).send("OK");
  }
});

module.exports = router;