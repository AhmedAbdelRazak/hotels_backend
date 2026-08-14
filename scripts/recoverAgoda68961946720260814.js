/** @format */

"use strict";

// Closed-scope recovery for one authenticated Agoda archive. The shared dated
// engine remains dry-run by default and requires an exact, unexpired proof for
// apply. This wrapper contains hashes and booking facts only, never guest PII.

const mongoose = require("mongoose");
const {
	parseArgumentsForRepair,
	runForTargets,
} = require("./recoverMissedDirectOtaReservations20260813");

const REPAIR_ID = "agoda-689619467-direct-email-recovery-20260814-v1";
const POLICY_DATE = "2026-08-14";
const NPM_SCRIPT = "ota:recover-agoda-689619467-20260814";

const TARGET = Object.freeze({
	repairId: REPAIR_ID,
	policyDate: POLICY_DATE,
	provider: "agoda",
	confirmationNumber: "689619467",
	auditId: "6a7ea0f60fac145d862c1c84",
	emailHash: "5df8fd762c3bd54ccbc771f277351d5b69ee49329e101ba9c78848297896084f",
	textHash: "1e32ddbeb776f599360f66fa661b53e885fbb5c94cbb1315e5a27b10f038578b",
	messageIdHash: "95bc83ec4df5eb9dc9bf2ce9c438152674ae8b9ba4f1bb7f4e537ebdd07c2aba",
	dedupeKeyHash: "c660f00c6a311684c33edca64d8345b77c9be480475e094c9a078e42b21eff4a",
	from: '"agoda.com" <no-reply@agoda.com>',
	subject: "Agoda Booking ID 689619467 - CONFIRMED Hotel Country: Saudi Arabia Check-in August 14, 2026 / Language_English",
	sourceReceivedAt: "2026-08-14T05:00:34.000Z",
	receivedAt: "2026-08-14T05:00:38.677Z",
	createdAt: "2026-08-14T05:00:38.694Z",
	updatedAt: "2026-08-14T05:01:21.627Z",
	version: 0,
	guestKeyHash: "2c9578865e3c88736b142153dd85e8889255c49b8ce7ccdb926d2504ccb05c2b",
	propertyId: "90720772",
	roomConfigId: "6a40df5f1a6d1850eb25c183",
	roomType: "doubleRooms",
	checkinDate: "2026-08-14",
	checkoutDate: "2026-08-15",
	roomCount: 2,
	totalGuests: 4,
	sourceCurrency: "SAR",
	sourceGross: 121.52,
	sourcePayout: 75.2,
	grossSar: 121.52,
	payoutSar: 75.2,
	expenseSar: 46.32,
	otaCommissionSar: 18.22,
	rootSar: 150,
	platformMarginSar: -74.8,
	expectedNightGross: Object.freeze([
		Object.freeze([60.76]),
		Object.freeze([60.76]),
	]),
	expectedNightPayout: Object.freeze([
		Object.freeze([37.6]),
		Object.freeze([37.6]),
	]),
	expectedNightRoot: Object.freeze([
		Object.freeze([75]),
		Object.freeze([75]),
	]),
	expectedOverbooked: true,
	expectedRoomMatchType: "explicit_capacity",
	expectedRoomMatchScore: 0.98,
});
const TARGETS = Object.freeze([TARGET]);

function parseArguments(argv = process.argv.slice(2)) {
	return parseArgumentsForRepair(argv, REPAIR_ID);
}

async function run(options = parseArguments(), dependencies = {}) {
	return runForTargets(TARGETS, options, dependencies, { npmScript: NPM_SCRIPT });
}

if (require.main === module) {
	run()
		.catch((error) => {
			console.error(JSON.stringify({
				success: false,
				code: error.code || "RECOVERY_FAILED",
				message: String(error.message || "").trim(),
			}, null, 2));
			process.exitCode = 1;
		})
		.finally(async () => {
			if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
		});
}

module.exports = {
	NPM_SCRIPT,
	POLICY_DATE,
	REPAIR_ID,
	TARGET,
	TARGETS,
	parseArguments,
	run,
};
