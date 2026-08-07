/** @format */

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");
const {
	assertRoomDiscoveryConfigSafe,
} = require("../workers/hotelrunnerSyncWorker");

const closedConfig = () => ({
	projectionEnabled: false,
	pullEnabled: false,
	roomListSyncEnabled: false,
	confirmDeliveryEnabled: false,
});

test("room-list-only bootstrap accepts only a fully closed effective gate set", () => {
	assert.equal(assertRoomDiscoveryConfigSafe(closedConfig()), true);

	for (const [property, key] of [
		["projectionEnabled", "HOTELRUNNER_PROJECTION_ENABLED"],
		["pullEnabled", "HOTELRUNNER_PULL_ENABLED"],
		["roomListSyncEnabled", "HOTELRUNNER_ROOM_LIST_SYNC_ENABLED"],
		["confirmDeliveryEnabled", "HOTELRUNNER_CONFIRM_DELIVERY_ENABLED"],
	]) {
		assert.throws(
			() =>
				assertRoomDiscoveryConfigSafe({
					...closedConfig(),
					[property]: true,
				}),
			(error) => {
				assert.equal(error.code, "HOTELRUNNER_ROOM_DISCOVERY_GATE_OPEN");
				assert.deepEqual(error.openGates, [key]);
				assert.equal(error.message.includes(key), true);
				return true;
			}
		);
	}
});

test("room-list-only bootstrap reports every open gate by name", () => {
	assert.throws(
		() =>
			assertRoomDiscoveryConfigSafe({
				projectionEnabled: true,
				pullEnabled: true,
				roomListSyncEnabled: true,
				confirmDeliveryEnabled: true,
			}),
		(error) => {
			assert.equal(error.code, "HOTELRUNNER_ROOM_DISCOVERY_GATE_OPEN");
			assert.equal(error.openGates.length, 4);
			return true;
		}
	);
});

test("worker and reservation-index verifier disable implicit Mongoose writes before model imports", () => {
	for (const entrypoint of [
		require.resolve("../workers/hotelrunnerSyncWorker"),
		require.resolve("../scripts/verifyHotelRunnerReservationIndexes"),
	]) {
		const source = fs.readFileSync(entrypoint, "utf8");
		const firstServiceImport = source.indexOf('require("../services/');
		const autoIndexDisable = source.indexOf('mongoose.set("autoIndex", false)');
		const autoCreateDisable = source.indexOf('mongoose.set("autoCreate", false)');
		const connectCall = source.indexOf("mongoose.connect(");

		assert.notEqual(firstServiceImport, -1, entrypoint);
		assert.ok(autoIndexDisable > -1 && autoIndexDisable < firstServiceImport, entrypoint);
		assert.ok(autoCreateDisable > -1 && autoCreateDisable < firstServiceImport, entrypoint);
		assert.ok(autoIndexDisable < connectCall, entrypoint);
		assert.ok(autoCreateDisable < connectCall, entrypoint);
		assert.match(source, /mongoose\.connect\([\s\S]*?autoIndex:\s*false/);
		assert.match(source, /mongoose\.connect\([\s\S]*?autoCreate:\s*false/);
		assert.doesNotMatch(
			source,
			/Reservations\.(?:init|createIndexes|syncIndexes)\s*\(/
		);
	}
});
