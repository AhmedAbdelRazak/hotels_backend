/** @format */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const {
	platformOtaScopeFilter,
	strictPlatformOtaHotelScopeFilter,
} = require("./otaReservationVisibility");

test("role 1000 is scoped whether it is primary or granted through roles", () => {
	const hotelId = new mongoose.Types.ObjectId();
	for (const actor of [
		{ role: 1000, hotelIdsWork: [hotelId] },
		{ role: 2, roles: [1000], hotelIdsWork: [hotelId] },
	]) {
		const scope = platformOtaScopeFilter(actor);
		assert.ok(scope);
		assert.equal(String(scope.$or[0].hotelId.$in[0]), String(hotelId));
	}
});

test("a scoped OTA admin without assigned hotels is denied instead of global", () => {
	assert.deepEqual(platformOtaScopeFilter({ role: 1000 }), {
		_id: { $exists: false },
	});
	assert.deepEqual(strictPlatformOtaHotelScopeFilter({ roles: [1000] }), {
		_id: { $exists: false },
	});
});

test("inbound-email PII scope includes assigned hotels only", () => {
	const hotelId = new mongoose.Types.ObjectId();
	const scope = strictPlatformOtaHotelScopeFilter({
		role: 1000,
		hotelsToSupport: [hotelId],
	});
	assert.deepEqual(scope, { hotelId: { $in: [hotelId] } });
	assert.equal(JSON.stringify(scope).includes("$exists"), false);
});

