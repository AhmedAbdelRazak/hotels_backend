"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { buildRoomListScope } = require("../controllers/rooms").__test;

const HOTEL_ID = "64a000000000000000000001";
const OWNER_ID = "6553f1c6d06c5cea2f98a838";

test("room list scope accepts valid hotel and owner identifiers", () => {
	const scope = buildRoomListScope(HOTEL_ID, OWNER_ID);
	assert.equal(String(scope.hotelId), HOTEL_ID);
	assert.equal(String(scope.belongsTo), OWNER_ID);
});

test("room list scope rejects serialized objects before ObjectId conversion", () => {
	assert.equal(buildRoomListScope("[object Object]", OWNER_ID), null);
	assert.equal(buildRoomListScope({ _id: HOTEL_ID }, OWNER_ID), null);
});

test("room list scope rejects an invalid owner identifier", () => {
	assert.equal(buildRoomListScope(HOTEL_ID, "not-an-owner-id"), null);
});
