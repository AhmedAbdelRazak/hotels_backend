/** @format */

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

test("OTA pricing review gates and atomically records direct HotelRunner commission changes", () => {
	const source = fs.readFileSync(require.resolve("../controllers/janat"), "utf8");
	const updateStart = source.indexOf("exports.updateOtaReservationPricing");
	const releaseStart = source.indexOf("exports.releaseOtaReservationToHotel");
	assert.ok(updateStart > -1 && releaseStart > updateStart);
	const route = source.slice(updateStart, releaseStart);

	assert.match(
		route,
		/directHotelRunnerReservation\s*&&\s*commissionRequest\.provided\s*===\s*true\s*&&\s*!isConfiguredSuperAdmin\(actor\)/
	);
	assert.match(
		route,
		/code:\s*"hotelrunner_platform_commission_superadmin_only"/
	);
	assert.match(
		route,
		/buildTrustedDirectHotelRunnerCommissionAssignment\s*\(/
	);
	assert.match(
		route,
		/Reservations\.findOneAndUpdate\(\s*buildReservationSnapshotFilter\(reservation,\s*\{\s*requirePendingReview:\s*true,\s*includeHotel:\s*true,?\s*\}\),\s*addReservationVersionBump\(/
	);
});

test("public reservation edits strip direct HotelRunner finance fields before assignment", () => {
	const source = fs.readFileSync(require.resolve("../controllers/janat"), "utf8");
	const updateStart = source.indexOf("exports.updateReservationDetails");
	const compileStart = source.indexOf("exports.compileCustomerList");
	assert.ok(updateStart > -1 && compileStart > updateStart);
	const route = source.slice(updateStart, compileStart);
	const stripOffset = route.indexOf(
		"stripUntrustedDirectHotelRunnerFinanceFields(updateData)"
	);
	const assignmentOffset = route.indexOf("Object.keys(updateData).forEach");
	assert.ok(stripOffset > -1 && assignmentOffset > stripOffset);
});
