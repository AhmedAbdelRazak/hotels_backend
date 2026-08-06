/** @format */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { getHotelRunnerConfig } = require("./hotelrunnerConfig");

const baseEnvironment = {
	HOTELRUNNER_API_TOKEN: "synthetic-token",
	HOTELRUNNER_API_HR_ID: "synthetic-hr-id",
	HOTELRUNNER_SUPPORTED_HOTELIDS: "64b000000000000000000001",
};

test("local projection is fail-closed until explicitly activated", () => {
	assert.equal(getHotelRunnerConfig(baseEnvironment).projectionEnabled, false);
	assert.equal(
		getHotelRunnerConfig({
			...baseEnvironment,
			HOTELRUNNER_PROJECTION_ENABLED: "true",
		}).projectionEnabled,
		true
	);
});
