/** @format */

"use strict";

const express = require("express");

const GUEST_CARD_JSON_LIMIT = "4kb";
const parseGuestCardJson = express.json({
  limit: GUEST_CARD_JSON_LIMIT,
  strict: true,
});

const guestCardJsonParser = (req, res, next) =>
  parseGuestCardJson(req, res, (error) => {
    if (!error) return next();
    if (error.type === "entity.too.large" || Number(error.status) === 413) {
      return res.status(413).json({
        success: false,
        error: "The Guest Card email request is too large.",
        code: "GUEST_CARD_REQUEST_TOO_LARGE",
      });
    }
    if (
      error instanceof SyntaxError &&
      Number(error.status) === 400 &&
      Object.hasOwn(error, "body")
    ) {
      return res.status(400).json({
        success: false,
        error: "The Guest Card email request contains invalid JSON.",
        code: "INVALID_GUEST_CARD_JSON",
      });
    }
    return next(error);
  });

module.exports = {
  GUEST_CARD_JSON_LIMIT,
  guestCardJsonParser,
};
