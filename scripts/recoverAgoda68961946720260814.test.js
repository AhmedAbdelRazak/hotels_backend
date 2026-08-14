/** @format */

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

const {
	POLICY_DATE,
	REPAIR_ID,
	TARGET,
	TARGETS,
	parseArguments,
} = require("./recoverAgoda68961946720260814");
const {
	RecoverySafetyError,
	recoveryMarkerMatches,
	recoveryPolicyForTargets,
	runForTargets,
	stampRecoveryProvenance,
} = require("./recoverMissedDirectOtaReservations20260813");

const PLAN_AT = new Date("2026-08-14T05:30:00.000Z");
const PROOF = `${PLAN_AT.getTime()}.${"a".repeat(64)}`;

test("single-target recovery manifest is exact, immutable, and contains no guest PII", () => {
	assert.equal(TARGETS.length, 1);
	assert.equal(TARGETS[0], TARGET);
	assert.equal(Object.isFrozen(TARGETS), true);
	assert.equal(Object.isFrozen(TARGET), true);
	assert.deepEqual(
		{
			identity: `${TARGET.provider}:${TARGET.confirmationNumber}`,
			auditId: TARGET.auditId,
			stay: [TARGET.checkinDate, TARGET.checkoutDate],
			rooms: TARGET.roomCount,
			guests: TARGET.totalGuests,
			mapping: [TARGET.roomConfigId, TARGET.roomType],
			commercial: [TARGET.grossSar, TARGET.payoutSar, TARGET.expenseSar, TARGET.otaCommissionSar, TARGET.rootSar, TARGET.platformMarginSar],
		},
		{
			identity: "agoda:689619467",
			auditId: "6a7ea0f60fac145d862c1c84",
			stay: ["2026-08-14", "2026-08-15"],
			rooms: 2,
			guests: 4,
			mapping: ["6a40df5f1a6d1850eb25c183", "doubleRooms"],
			commercial: [121.52, 75.2, 46.32, 18.22, 150, -74.8],
		}
	);
	for (const field of ["emailHash", "textHash", "messageIdHash", "dedupeKeyHash", "guestKeyHash"]) {
		assert.match(TARGET[field], /^[a-f0-9]{64}$/);
	}
	for (const field of ["guestName", "guestPhone", "guestEmail"]) {
		assert.equal(field in TARGET, false);
	}
	assert.deepEqual(TARGET.expectedNightGross, [[60.76], [60.76]]);
	assert.deepEqual(TARGET.expectedNightPayout, [[37.6], [37.6]]);
	assert.deepEqual(TARGET.expectedNightRoot, [[75], [75]]);
});

test("dedicated arguments require this recovery ID and the shared proof format", () => {
	assert.deepEqual(parseArguments([]), { apply: false, repairId: "", proof: "" });
	assert.throws(
		() => parseArguments(["--apply", "--repair-id=wrong", `--proof=${PROOF}`]),
		RecoverySafetyError
	);
	assert.deepEqual(
		parseArguments(["--apply", `--repair-id=${REPAIR_ID}`, `--proof=${PROOF}`]),
		{ apply: true, repairId: REPAIR_ID, proof: PROOF }
	);
});

test("shared engine binds custom policy to provenance and rejects mixed or wrong apply scope", async () => {
	assert.deepEqual(recoveryPolicyForTargets(TARGETS), {
		repairId: REPAIR_ID,
		policyDate: POLICY_DATE,
	});
	const reservation = { supplierData: {}, reservationAuditLog: [] };
	stampRecoveryProvenance(TARGET, reservation, PLAN_AT);
	stampRecoveryProvenance(TARGET, reservation, PLAN_AT);
	assert.equal(recoveryMarkerMatches(TARGET, reservation), true);
	assert.equal(reservation.supplierData.directOtaArchiveRecovery.repairId, REPAIR_ID);
	assert.equal(reservation.supplierData.directOtaArchiveRecovery.policyDate, POLICY_DATE);
	assert.equal(reservation.reservationAuditLog.length, 1);
	assert.throws(
		() => recoveryPolicyForTargets([TARGET, { ...TARGET, confirmationNumber: "synthetic", auditId: "a".repeat(24), repairId: "different-recovery-policy-v1" }]),
		/one recovery policy/
	);
	for (const incomplete of [
		{ ...TARGET, provider: "" },
		{ ...TARGET, confirmationNumber: "" },
	]) {
		assert.throws(
			() => recoveryPolicyForTargets([incomplete]),
			/identities must be complete/
		);
	}
	await assert.rejects(
		() => runForTargets(TARGETS, { apply: true, repairId: "wrong", proof: PROOF }, { skipConnect: true }),
		/requires --repair-id/
	);
});

test("dedicated wrapper imports no HotelRunner runtime and legacy entrypoints delegate to scoped engine", () => {
	const wrapper = fs.readFileSync(require.resolve("./recoverAgoda68961946720260814"), "utf8");
	const engine = fs.readFileSync(require.resolve("./recoverMissedDirectOtaReservations20260813"), "utf8");
	assert.equal(/require\(["'][^"']*hotelrunner/i.test(wrapper), false);
	assert.match(wrapper, /runForTargets\(TARGETS,/);
	assert.match(engine, /return buildPlanForTargets\(TARGETS, plannedAt, dependencies\)/);
	assert.match(engine, /return runForTargets\(TARGETS, options, dependencies,/);
});
