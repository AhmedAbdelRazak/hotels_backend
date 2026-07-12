/** @format */

"use strict";

const express = require("express");

const HOTEL_REVIEW_JSON_LIMIT = "32kb";
const parseHotelReviewJson = express.json({ limit: HOTEL_REVIEW_JSON_LIMIT });

const hotelReviewJsonParser = (req, res, next) =>
	parseHotelReviewJson(req, res, (error) => {
		if (!error) return next();
		if (error.type === "entity.too.large" || Number(error.status) === 413) {
			return res.status(413).json({
				error: "The review request is too large.",
				code: "REVIEW_TOO_LARGE",
			});
		}
		if (
			error instanceof SyntaxError &&
			Number(error.status) === 400 &&
			Object.prototype.hasOwnProperty.call(error, "body")
		) {
			return res.status(400).json({
				error: "The review request contains invalid JSON.",
				code: "INVALID_REVIEW_JSON",
			});
		}
		return next(error);
	});

module.exports = {
	HOTEL_REVIEW_JSON_LIMIT,
	hotelReviewJsonParser,
};
