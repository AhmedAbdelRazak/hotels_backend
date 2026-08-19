/** @format */

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

const {
	POLICY_DATE,
	REPAIR_ID,
	TARGETS,
	parseArguments,
} = require("./recoverBilingualAgoda20260819");
const {
	RecoverySafetyError,
	recoveryPolicyForTargets,
} = require("./recoverMissedDirectOtaReservations20260813");

const PLAN_AT = new Date("2026-08-19T13:00:00.000Z");
const PROOF = `${PLAN_AT.getTime()}.${"a".repeat(64)}`;

test("bilingual Agoda recovery manifest is exact, immutable, and contains no guest PII", () => {
	assert.equal(TARGETS.length, 2);
	assert.equal(Object.isFrozen(TARGETS), true);
	for (const target of TARGETS) {
		assert.equal(Object.isFrozen(target), true);
		assert.equal(target.provider, "agoda");
		assert.equal(target.roomCount, 1);
		for (const field of ["emailHash", "textHash", "messageIdHash", "dedupeKeyHash", "guestKeyHash"]) {
			assert.match(target[field], /^[a-f0-9]{64}$/);
		}
		for (const field of ["guestName", "guestPhone", "guestEmail"]) {
			assert.equal(field in target, false);
		}
		assert.equal(target.expectedNightGross.length, target.roomCount);
		assert.equal(target.expectedNightPayout.length, target.roomCount);
		assert.equal(target.expectedNightRoot.length, target.roomCount);
	}
	assert.deepEqual(
		TARGETS.map((target) => ({
			identity: `${target.provider}:${target.confirmationNumber}`,
			auditId: target.auditId,
			stay: [target.checkinDate, target.checkoutDate],
			mapping: [target.roomConfigId, target.roomType],
			commercial: [target.grossSar, target.payoutSar, target.expenseSar, target.otaCommissionSar, target.rootSar, target.platformMarginSar],
		})),
		[
			{
				identity: "agoda:2042704614",
				auditId: "6a859405e772c432428fe5fb",
				stay: ["2026-08-19", "2026-08-20"],
				mapping: ["6a40df5f1a6d1850eb25c183", "doubleRooms"],
				commercial: [69.58, 38.77, 30.81, 9.74, 75, -36.23],
			},
			{
				identity: "agoda:2042712859",
				auditId: "6a859b80e772c432428fed8b",
				stay: ["2026-08-20", "2026-08-21"],
				mapping: ["6a40e4ec1a6d1850eb25c635", "familyRooms"],
				commercial: [84.72, 53.29, 31.43, 11.86, 75, -21.71],
			},
		]
	);
});

test("bilingual Agoda recovery arguments are proof-gated to this repair", () => {
	assert.deepEqual(parseArguments([]), { apply: false, repairId: "", proof: "" });
	assert.throws(
		() => parseArguments(["--apply", "--repair-id=wrong", `--proof=${PROOF}`]),
		RecoverySafetyError
	);
	assert.deepEqual(
		parseArguments(["--apply", `--repair-id=${REPAIR_ID}`, `--proof=${PROOF}`]),
		{ apply: true, repairId: REPAIR_ID, proof: PROOF }
	);
	assert.deepEqual(recoveryPolicyForTargets(TARGETS), {
		repairId: REPAIR_ID,
		policyDate: POLICY_DATE,
	});
});

test("bilingual Agoda wrapper delegates only to the shared proof-gated engine", () => {
	const wrapper = fs.readFileSync(require.resolve("./recoverBilingualAgoda20260819"), "utf8");
	assert.equal(/require\(["'][^"']*hotelrunner/i.test(wrapper), false);
	assert.match(wrapper, /runForTargets\(TARGETS,/);
	assert.match(wrapper, /contains no guest PII/i);
});
