/** @format */

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

const {
	NPM_SCRIPT,
	POLICY_DATE,
	REPAIR_ID,
	TARGET,
	assertPendingPaymentSourceBoundary,
	markerMatches,
	parseArguments,
	stampRecoveryProvenance,
} = require("./recoverAirbnbPendingPayment20260819");
const {
	RecoverySafetyError,
} = require("./recoverMissedDirectOtaReservations20260813");

const PLAN_AT = new Date("2026-08-19T17:30:00.000Z");
const PROOF = `${PLAN_AT.getTime()}.${"a".repeat(64)}`;

test("Airbnb pending-payment recovery manifest is frozen, exact, and contains no guest PII", () => {
	assert.equal(Object.isFrozen(TARGET), true);
	assert.equal(TARGET.repairId, REPAIR_ID);
	assert.equal(TARGET.policyDate, POLICY_DATE);
	assert.equal(TARGET.provider, "airbnb");
	assert.equal(TARGET.confirmationNumber, "hmkpa39adt");
	assert.equal(TARGET.auditId, "6a85df6ad528708d33e9288c");
	assert.equal(TARGET.hotelId, "6a40b6a1a6efe70450536038");
	assert.equal(TARGET.ownerId, "68b74714fb50e159d48c714d");
	assert.equal(TARGET.listingId, "1742269093942004753");
	assert.deepEqual([TARGET.checkinDate, TARGET.checkoutDate], ["2026-08-19", "2026-08-21"]);
	assert.deepEqual([TARGET.roomCount, TARGET.adults, TARGET.children, TARGET.totalGuests], [1, 2, 2, 4]);
	for (const field of [
		"emailHash",
		"textHash",
		"messageIdHash",
		"dedupeKeyHash",
		"subjectHash",
		"bodyHtmlHash",
		"storedNormalizedHash",
		"guestKeyHash",
	]) {
		assert.match(TARGET[field], /^[a-f0-9]{64}$/);
	}
	for (const field of ["guestName", "guestPhone", "guestEmail", "subject"]) {
		assert.equal(field in TARGET, false);
	}
});

test("Airbnb recovery arguments require this exact repair and a formatted proof", () => {
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

test("source boundary accepts only explicit payment-processing language without commercial fields", () => {
	const valid = {
		subject: "Reservation confirmed",
		bodyText: [
			"Reservation confirmed",
			"View earnings",
			"Allow time for payment processing. Learn more",
		].join("\n"),
	};
	assert.equal(assertPendingPaymentSourceBoundary(valid), true);
	assert.throws(
		() => assertPendingPaymentSourceBoundary({
			...valid,
			bodyText: `${valid.bodyText}\nTotal (SAR)\n100.00`,
		}),
		RecoverySafetyError
	);
	assert.throws(
		() => assertPendingPaymentSourceBoundary({
			...valid,
			bodyText: "Reservation confirmed\nView earnings",
		}),
		RecoverySafetyError
	);
});

test("recovery provenance explicitly records that no commercial amount was invented", () => {
	const document = { supplierData: {}, reservationAuditLog: [] };
	stampRecoveryProvenance(document, PLAN_AT);
	stampRecoveryProvenance(document, PLAN_AT);
	assert.equal(markerMatches(document), true);
	assert.deepEqual(document.supplierData.directOtaArchiveRecovery, {
		repairId: REPAIR_ID,
		policyDate: POLICY_DATE,
		inboundEmailId: TARGET.auditId,
		provider: TARGET.provider,
		confirmationNumber: TARGET.confirmationNumber,
		emailHash: TARGET.emailHash,
		textHash: TARGET.textHash,
		appliedAt: PLAN_AT,
		ordinaryOtaReconciler: true,
		orderTakerNormalizationUsed: false,
		commercialAmountsInvented: false,
		paymentProcessingPending: true,
	});
	assert.equal(document.reservationAuditLog.length, 1);
});

test("Airbnb recovery uses the ordinary reconciler with proof and outbound-network fences", () => {
	const source = fs.readFileSync(
		require.resolve("./recoverAirbnbPendingPayment20260819"),
		"utf8"
	);
	assert.equal(NPM_SCRIPT, "ota:recover-airbnb-pending-payment-20260819");
	assert.match(source, /reconcileOtaReservation/);
	assert.match(source, /withOutboundHttpBlocked/);
	assert.match(source, /lastMomentGuard/);
	assert.match(source, /commercialAmountsInvented:\s*false/);
	assert.match(source, /lower\(document\.state\)/);
	assert.match(source, /lower\(document\.reservation_status\)/);
	assert.equal(/require\(["'][^"']*hotelrunner/i.test(source), false);
});
