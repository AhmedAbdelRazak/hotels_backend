/** @format */

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
	shouldCountReservationForInventory,
} = require("./reservationStatus");

test("OTA release blocks inventory and platform-review reversion explicitly releases it", () => {
	const source = fs.readFileSync(require.resolve("../controllers/janat"), "utf8");
	const releaseStart = source.indexOf("exports.releaseOtaReservationToHotel");
	const revertStart = source.indexOf(
		"exports.revertOtaReservationToPlatformReview",
	);
	const revertEnd = source.indexOf("\nexports.", revertStart + 1);
	assert.ok(
		releaseStart > -1 &&
			revertStart > releaseStart &&
			revertEnd > revertStart,
	);

	const releaseRoute = source.slice(releaseStart, revertStart);
	const revertRoute = source.slice(revertStart, revertEnd);
	assert.match(
		releaseRoute,
		/pendingConfirmation:\s*{[\s\S]*?source:\s*"ota_platform_release",\s*inventoryBlocks:\s*true,/,
	);
	assert.match(
		revertRoute,
		/pendingConfirmation:\s*{[\s\S]*?source:\s*"ota_platform_reverted",\s*inventoryBlocks:\s*false,/,
	);

	const released = {
		reservation_status: "Pending Confirmation",
		state: "Pending Confirmation",
		pendingConfirmation: {
			status: "pending",
			source: "ota_platform_release",
			inventoryBlocks: true,
		},
	};
	const reverted = {
		reservation_status: "OTA Platform Review",
		state: "OTA Platform Review",
		pendingConfirmation: {
			status: "pending",
			source: "ota_platform_reverted",
			inventoryBlocks: false,
		},
	};

	assert.equal(shouldCountReservationForInventory(released), true);
	assert.equal(shouldCountReservationForInventory(reverted), false);
	assert.equal(
		shouldCountReservationForInventory({
			...released,
			reservation_status: "Pending Finance Review",
			state: "Pending Finance Review",
			pendingConfirmation: {
				...released.pendingConfirmation,
				status: "confirmed",
			},
		}),
		true,
		"the release marker must keep blocking after the hotel confirms into finance review",
	);
	assert.equal(
		shouldCountReservationForInventory({
			...released,
			reservation_status: "Finance Rejected",
			state: "Finance Rejected",
			pendingConfirmation: {
				...released.pendingConfirmation,
				status: "confirmed",
			},
		}),
		true,
		"finance rejection is a correction workflow, not a booking rejection",
	);
	assert.equal(
		shouldCountReservationForInventory({
			reservation_status: "Finance Rejected",
			state: "Finance Rejected",
			pendingConfirmation: { status: "confirmed" },
		}),
		false,
		"legacy finance rejection remains fail-closed until its release proof is reconciled",
	);
	assert.equal(
		shouldCountReservationForInventory({
			reservation_status: "Finance Rejected",
			state: "Finance Rejected",
			pendingConfirmation: {
				status: "confirmed",
				inventoryBlocks: false,
			},
		}),
		false,
		"an explicit non-blocking marker is never silently promoted",
	);
	assert.equal(
		shouldCountReservationForInventory(
			{
				reservation_status: "Finance Rejected",
				state: "Finance Rejected",
				pendingConfirmation: { status: "confirmed" },
			},
			{ includePendingConfirmation: true }
		),
		true,
		"an explicit caller override may inspect the active financial workflow",
	);
	assert.equal(
		shouldCountReservationForInventory({
			reservation_status: "Rejected",
			state: "Rejected",
			pendingConfirmation: { status: "rejected", inventoryBlocks: true },
		}),
		false,
		"hotel rejection remains terminal even if stale metadata says true",
	);
});

test("admin lifecycle reversion blocks inventory and terminal closure clears it", () => {
	const source = fs.readFileSync(
		require.resolve("../controllers/reservations"),
		"utf8"
	);
	const syncStart = source.indexOf("const buildAdminStatusWorkflowSyncUpdate");
	const reversionStart = source.indexOf(
		"const buildSuperAdminPendingReversionUpdate"
	);
	const nextSection = source.indexOf(
		"const canViewReservationHotel",
		reversionStart
	);
	assert.ok(syncStart > -1 && reversionStart > syncStart && nextSection > reversionStart);

	const syncSource = source.slice(syncStart, reversionStart);
	const reversionSource = source.slice(reversionStart, nextSection);
	assert.match(
		syncSource,
		/statusKey === "pendingconfirmation"[\s\S]*?status: "pending",\s*inventoryBlocks: true/
	);
	assert.match(
		syncSource,
		/\["cancelled", "canceled", "noshow"\][\s\S]*?status: closedStatus,\s*inventoryBlocks: false/
	);
	assert.match(
		reversionSource,
		/pendingConfirmation:\s*{[\s\S]*?status: "pending",\s*inventoryBlocks: true/
	);
	assert.match(
		syncSource,
		/status: "confirmed",\s*inventoryBlocks: true/
	);
	assert.match(
		syncSource,
		/statusKey === "rejected"[\s\S]*?status: "rejected",\s*inventoryBlocks: false/
	);
});

test("every direct pending lifecycle construction stamps its inventory decision", () => {
	const reservationSource = fs.readFileSync(
		require.resolve("../controllers/reservations"),
		"utf8"
	);
	for (const expected of [
		/status: "pending",\s*inventoryBlocks: true/,
		/status: "confirmed",\s*inventoryBlocks: true/,
		/status: STATUS_CANCELLED,\s*inventoryBlocks: false/,
		/status: "rejected",\s*inventoryBlocks: false/,
	]) {
		assert.match(reservationSource, expected);
	}
	const excelSource = fs.readFileSync(
		path.join(__dirname, "../controllers/reservation_excel_import.js"),
		"utf8"
	);
	assert.match(
		excelSource,
		/pendingConfirmation:\s*{\s*status: "pending",\s*inventoryBlocks: true/
	);
	const mapperSource = fs.readFileSync(
		require.resolve("./otaReservationMapper"),
		"utf8"
	);
	assert.match(mapperSource, /pendingConfirmation\.inventoryBlocks = false/);
	assert.match(mapperSource, /pendingConfirmation\.inventoryBlocks = true/);
});
