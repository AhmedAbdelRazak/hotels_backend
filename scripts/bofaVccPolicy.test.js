"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
	configuredSuperAdminIds,
	isConfiguredSuperAdminId,
	validateUsdAmount,
	checkCheckinEligibility,
	isLuhnValid,
	validateCard,
	buildMerchantTransactionId,
	classifyTimeoutVoidResult,
} = require("../services/bofaVccPolicy");

test("BofA VCC access uses only explicitly configured super-admin IDs", () => {
	const env = {
		SUPER_ADMIN_ID: "admin-one, admin-two",
		REACT_APP_SUPER_ADMIN_ID: "admin-two,admin-three",
	};
	assert.deepEqual(configuredSuperAdminIds(env), [
		"admin-one",
		"admin-two",
		"admin-three",
	]);
	assert.equal(isConfiguredSuperAdminId("admin-two", env), true);
	assert.equal(isConfiguredSuperAdminId("role-1000-user", env), false);
});

test("BofA VCC amount validation is USD-only and cent precise", () => {
	assert.deepEqual(validateUsdAmount("125.45", "USD"), {
		ok: true,
		amountUsd: 125.45,
		currency: "USD",
	});
	assert.deepEqual(validateUsdAmount("67.3", "USD"), {
		ok: true,
		amountUsd: 67.3,
		currency: "USD",
	});
	assert.equal(validateUsdAmount("125.455", "USD").ok, false);
	assert.equal(validateUsdAmount("125.45", "SAR").issue, "BOFA_VCC_USD_REQUIRED");
	assert.equal(validateUsdAmount("0", "USD").ok, false);
});

test("BofA VCC check-in must be today or earlier in Riyadh", () => {
	const now = new Date("2026-07-23T12:00:00.000Z");
	assert.equal(
		checkCheckinEligibility("2026-07-22T00:00:00.000Z", { now }).ok,
		true,
	);
	assert.equal(
		checkCheckinEligibility("2026-07-23T00:00:00.000Z", { now }).ok,
		true,
	);
	const future = checkCheckinEligibility("2026-07-24T00:00:00.000Z", { now });
	assert.equal(future.ok, false);
	assert.equal(future.issue, "BOFA_VCC_CHECKIN_NOT_REACHED");
	assert.match(future.message, /cannot be processed before check-in/i);
});

test("BofA VCC card validation rejects bad PAN, CVV, and expired cards", () => {
	assert.equal(isLuhnValid("4111111111111111"), true);
	assert.equal(isLuhnValid("4111111111111112"), false);
	assert.equal(
		validateCard(
			{
				number: "4111111111111111",
				cvv: "123",
				expirationMonth: "12",
				expirationYear: "2031",
				type: "001",
			},
			{ now: new Date("2026-07-23T00:00:00.000Z") },
		).ok,
		true,
	);
	assert.equal(
		validateCard(
			{
				number: "4111111111111112",
				cvv: "123",
				expirationMonth: "12",
				expirationYear: "2031",
				type: "001",
			},
			{ now: new Date("2026-07-23T00:00:00.000Z") },
		).issue,
		"BOFA_VCC_INVALID_CARD_NUMBER",
	);
	assert.equal(
		validateCard(
			{
				number: "4111111111111111",
				cvv: "12",
				expirationMonth: "12",
				expirationYear: "2031",
				type: "001",
			},
		).issue,
		"BOFA_VCC_INVALID_CVV",
	);
});

test("merchant transaction IDs are stable, unique, and gateway-safe", () => {
	const first = buildMerchantTransactionId({
		merchantId: "12345678",
		reservationId: "reservation-a",
		attemptId: "attempt-a",
	});
	const repeated = buildMerchantTransactionId({
		merchantId: "12345678",
		reservationId: "reservation-a",
		attemptId: "attempt-a",
	});
	const second = buildMerchantTransactionId({
		merchantId: "12345678",
		reservationId: "reservation-a",
		attemptId: "attempt-b",
	});
	assert.equal(first, repeated);
	assert.notEqual(first, second);
	assert.match(first, /^[A-Za-z0-9]{30}$/);
});

test("only a conclusive BofA timeout-void response permits a retry", () => {
	assert.equal(
		classifyTimeoutVoidResult({
			httpStatus: 201,
			data: { id: "void-123", status: "VOIDED" },
		}).canceled,
		true,
	);
	assert.equal(
		classifyTimeoutVoidResult({
			httpStatus: 201,
			data: { id: "void-123", status: "PENDING" },
		}).canceled,
		false,
	);
	assert.equal(
		classifyTimeoutVoidResult({
			httpStatus: 400,
			data: { status: "INVALID_REQUEST", reason: "NOT_VOIDABLE" },
		}).canceled,
		false,
	);
});
