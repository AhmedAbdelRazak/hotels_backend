/** @format */

"use strict";

// Closed-scope recovery for the two authenticated Agoda archives that used the
// current bilingual voucher layout. The shared dated engine is dry-run by
// default and requires an exact, unexpired proof for apply. This manifest keeps
// hashes and booking facts only; it deliberately contains no guest PII.

const mongoose = require("mongoose");
const {
	parseArgumentsForRepair,
	runForTargets,
} = require("./recoverMissedDirectOtaReservations20260813");

const REPAIR_ID = "bilingual-agoda-direct-email-recovery-20260819-v1";
const POLICY_DATE = "2026-08-19";
const NPM_SCRIPT = "ota:recover-bilingual-agoda-20260819";

const TARGETS = Object.freeze([
	Object.freeze({
		repairId: REPAIR_ID,
		policyDate: POLICY_DATE,
		provider: "agoda",
		confirmationNumber: "2042704614",
		auditId: "6a859405e772c432428fe5fb",
		emailHash: "579d308dda040580fc985ebd2487f296648115dd4444dcd81434a1dcbac0c939",
		textHash: "c97c43e1aae4de6691edb69745b718fdabec64757e1cadbb25e44658d423f51e",
		messageIdHash: "6f25803bbbcd46c46758040657e19fbc0929be6b9ba58d11df8e8bf05808a64e",
		dedupeKeyHash: "fcfc2761ad5f736b2b3b59952b7cdca1f23cbba28094c7983145e7c2fb974b0a",
		from: '"agoda.com" <no-reply@agoda.com>',
		subject: "Agoda Booking ID 2042704614 - CONFIRMED Hotel Country: Saudi Arabia Check-in 19-Aug-2026 (19-08-2026) / Language_English",
		sourceReceivedAt: "2026-08-19T11:31:10.000Z",
		receivedAt: "2026-08-19T11:31:17.748Z",
		createdAt: "2026-08-19T11:31:17.765Z",
		updatedAt: "2026-08-19T11:31:30.239Z",
		version: 0,
		guestKeyHash: "1e297a69c943663e6f99293b849c26b887566b120d0dec7b2574f11954fca19d",
		propertyId: "90720772",
		roomConfigId: "6a40df5f1a6d1850eb25c183",
		roomType: "doubleRooms",
		checkinDate: "2026-08-19",
		checkoutDate: "2026-08-20",
		roomCount: 1,
		totalGuests: 2,
		sourceCurrency: "SAR",
		sourceGross: 69.58,
		sourcePayout: 38.77,
		grossSar: 69.58,
		payoutSar: 38.77,
		expenseSar: 30.81,
		otaCommissionSar: 9.74,
		rootSar: 75,
		platformMarginSar: -36.23,
		expectedNightGross: Object.freeze([Object.freeze([69.58])]),
		expectedNightPayout: Object.freeze([Object.freeze([38.77])]),
		expectedNightRoot: Object.freeze([Object.freeze([75])]),
		expectedOverbooked: true,
		expectedRoomMatchType: "explicit_capacity",
		expectedRoomMatchScore: 0.98,
	}),
	Object.freeze({
		repairId: REPAIR_ID,
		policyDate: POLICY_DATE,
		provider: "agoda",
		confirmationNumber: "2042712859",
		auditId: "6a859b80e772c432428fed8b",
		emailHash: "2d7a10018b74148fe6c07d6446b931545513c7ecca26bff5c9924f70344362cc",
		textHash: "b02eb75c700387d3e32a5391fb091701214177fe501fe80103009c37807ee91f",
		messageIdHash: "72cde7c355e671178bb1f7f60da9670e484fe1001df45f7ba68cd55bf03df7d3",
		dedupeKeyHash: "47225fd4c863655059fbc5e92f8dc30de3ae2e57bf963d6c6b1e46b82d51235c",
		from: '"agoda.com" <no-reply@agoda.com>',
		subject: "Agoda Booking ID 2042712859 - CONFIRMED Hotel Country: Saudi Arabia Check-in 20-Aug-2026 (20-08-2026) / Language_English",
		sourceReceivedAt: "2026-08-19T12:03:05.000Z",
		receivedAt: "2026-08-19T12:03:12.105Z",
		createdAt: "2026-08-19T12:03:12.120Z",
		updatedAt: "2026-08-19T12:03:23.801Z",
		version: 0,
		guestKeyHash: "1e297a69c943663e6f99293b849c26b887566b120d0dec7b2574f11954fca19d",
		propertyId: "90720772",
		roomConfigId: "6a40e4ec1a6d1850eb25c635",
		roomType: "familyRooms",
		checkinDate: "2026-08-20",
		checkoutDate: "2026-08-21",
		roomCount: 1,
		totalGuests: 4,
		sourceCurrency: "SAR",
		sourceGross: 84.72,
		sourcePayout: 53.29,
		grossSar: 84.72,
		payoutSar: 53.29,
		expenseSar: 31.43,
		otaCommissionSar: 11.86,
		rootSar: 75,
		platformMarginSar: -21.71,
		expectedNightGross: Object.freeze([Object.freeze([84.72])]),
		expectedNightPayout: Object.freeze([Object.freeze([53.29])]),
		expectedNightRoot: Object.freeze([Object.freeze([75])]),
		expectedOverbooked: false,
		expectedRoomMatchType: "explicit_capacity",
		expectedRoomMatchScore: 0.98,
	}),
]);

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
	TARGETS,
	parseArguments,
	run,
};
