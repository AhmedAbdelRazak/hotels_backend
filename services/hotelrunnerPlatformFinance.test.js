"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
	HOTELRUNNER_PLATFORM_FINANCE_REASONS,
	buildHotelRunnerPlatformFinanceAggregationExpressions,
	resolveHotelRunnerPlatformCommission,
	summarizeHotelRunnerFinanceUnavailable,
} = require("./hotelrunnerPlatformFinance");

const hotelRunnerReservation = (overrides = {}) => ({
	total_amount: 1000,
	sub_total: 700,
	commission: 0,
	adminPricing: {
		mode: "hotelrunner_api",
		commercialVerified: false,
		otaExpenseTotal: null,
	},
	pickedRoomsType: [
		{
			count: 1,
			pricingByDay: [
				{
					totalPriceWithCommission: 1000,
					rootPrice: 700,
				},
			],
		},
	],
	...overrides,
});

test("direct HotelRunner gross/local-base spread is unavailable until staff review", () => {
	assert.deepEqual(
		resolveHotelRunnerPlatformCommission(hotelRunnerReservation()),
		{
			isHotelRunner: true,
			available: false,
			amount: null,
			reason: HOTELRUNNER_PLATFORM_FINANCE_REASONS.UNREVIEWED,
		}
	);
});

test("explicit staff-reviewed HotelRunner commission is accepted, including zero", () => {
	const assigned = resolveHotelRunnerPlatformCommission(
		hotelRunnerReservation({
			commission: 25,
			commissionData: { assigned: true, amount: 25 },
			financial_cycle: { commissionAssigned: true, commissionAmount: 25 },
		})
	);
	assert.equal(assigned.available, true);
	assert.equal(assigned.amount, 25);

	const reviewedZero = resolveHotelRunnerPlatformCommission(
		hotelRunnerReservation({
			financial_cycle: { commissionAssigned: true, commissionAmount: 0 },
		})
	);
	assert.equal(reviewedZero.available, true);
	assert.equal(reviewedZero.amount, 0);
});

test("conflicting assigned HotelRunner commission evidence fails closed", () => {
	const result = resolveHotelRunnerPlatformCommission(
		hotelRunnerReservation({
			commissionData: { assigned: true, amount: 25 },
			financial_cycle: { commissionAssigned: true, commissionAmount: 30 },
		})
	);
	assert.equal(result.available, false);
	assert.equal(
		result.reason,
		HOTELRUNNER_PLATFORM_FINANCE_REASONS.CONFLICT
	);
});

test("assigned financial-cycle aliases require complete valid consensus", () => {
	const agreed = resolveHotelRunnerPlatformCommission(
		hotelRunnerReservation({
			financial_cycle: {
				commissionAssigned: true,
				commissionAmount: "1,234.50",
				commissionValue: 1234.5,
			},
		})
	);
	assert.equal(agreed.available, true);
	assert.equal(agreed.amount, 1234.5);

	for (const [financial_cycle, reason] of [
		[
			{ commissionAssigned: true },
			HOTELRUNNER_PLATFORM_FINANCE_REASONS.INVALID,
		],
		[
			{
				commissionAssigned: true,
				commissionAmount: 25,
				commissionValue: null,
			},
			HOTELRUNNER_PLATFORM_FINANCE_REASONS.INVALID,
		],
		[
			{
				commissionAssigned: true,
				commissionAmount: 25,
				commissionValue: 30,
			},
			HOTELRUNNER_PLATFORM_FINANCE_REASONS.CONFLICT,
		],
	]) {
		const result = resolveHotelRunnerPlatformCommission(
			hotelRunnerReservation({ financial_cycle })
		);
		assert.equal(result.available, false);
		assert.equal(result.reason, reason);
	}
});

test("assigned commission-data aliases and top-level commission require consensus", () => {
	const agreed = resolveHotelRunnerPlatformCommission(
		hotelRunnerReservation({
			commission: 25,
			commissionData: {
				assigned: true,
				amount: "25.00",
				commissionAmount: 25,
				commissionValue: 25.004,
			},
		})
	);
	assert.equal(agreed.available, true);
	assert.equal(agreed.amount, 25);

	const cases = [
		{
			overrides: {
				commission: 25,
				commissionData: {
					assigned: true,
					amount: 25,
					commissionValue: 30,
				},
			},
			reason: HOTELRUNNER_PLATFORM_FINANCE_REASONS.CONFLICT,
		},
		{
			overrides: {
				commission: 30,
				commissionData: { assigned: true, amount: 25 },
			},
			reason: HOTELRUNNER_PLATFORM_FINANCE_REASONS.CONFLICT,
		},
		{
			overrides: {
				commission: 25,
				commissionData: {
					assigned: true,
					amount: 25,
					commissionValue: "not-money",
				},
			},
			reason: HOTELRUNNER_PLATFORM_FINANCE_REASONS.INVALID,
		},
		{
			overrides: {
				commission: false,
				commissionData: { assigned: true, amount: 25 },
			},
			reason: HOTELRUNNER_PLATFORM_FINANCE_REASONS.INVALID,
		},
	];
	for (const scenario of cases) {
		const result = resolveHotelRunnerPlatformCommission(
			hotelRunnerReservation(scenario.overrides)
		);
		assert.equal(result.available, false);
		assert.equal(result.reason, scenario.reason);
	}

	const missing = hotelRunnerReservation({ commissionData: { assigned: true } });
	delete missing.commission;
	assert.equal(
		resolveHotelRunnerPlatformCommission(missing).reason,
		HOTELRUNNER_PLATFORM_FINANCE_REASONS.INVALID
	);
});

test("assigned groups must agree and malformed evidence takes precedence", () => {
	const agreedZero = resolveHotelRunnerPlatformCommission(
		hotelRunnerReservation({
			commission: 0,
			commissionData: {
				assigned: true,
				amount: 0,
				commissionAmount: "0.00",
			},
			financial_cycle: {
				commissionAssigned: true,
				commissionAmount: 0,
				commissionValue: "0",
			},
		})
	);
	assert.equal(agreedZero.available, true);
	assert.equal(agreedZero.amount, 0);

	const differentGroups = resolveHotelRunnerPlatformCommission(
		hotelRunnerReservation({
			commission: 25,
			commissionData: { assigned: true, amount: 25 },
			financial_cycle: { commissionAssigned: true, commissionAmount: 30 },
		})
	);
	assert.equal(
		differentGroups.reason,
		HOTELRUNNER_PLATFORM_FINANCE_REASONS.CONFLICT
	);

	const malformedAndConflicting = resolveHotelRunnerPlatformCommission(
		hotelRunnerReservation({
			commission: 25,
			commissionData: {
				assigned: true,
				amount: 25,
				commissionValue: Infinity,
			},
			financial_cycle: {
				commissionAssigned: true,
				commissionAmount: 30,
				commissionValue: 31,
			},
		})
	);
	assert.equal(
		malformedAndConflicting.reason,
		HOTELRUNNER_PLATFORM_FINANCE_REASONS.INVALID
	);
});

test("Mongo platform-finance expressions inspect every alias without first-value fallback", () => {
	const expressions = buildHotelRunnerPlatformFinanceAggregationExpressions();
	const amountShape = JSON.stringify(expressions.amount);
	for (const field of [
		"$financial_cycle.commissionAmount",
		"$financial_cycle.commissionValue",
		"$commissionData.amount",
		"$commissionData.commissionAmount",
		"$commissionData.commissionValue",
		"$commission",
	]) {
		assert.ok(amountShape.includes(field), field);
	}
	assert.ok(amountShape.includes('"missing"'));
	assert.ok(amountShape.includes('"$type"'));
	assert.ok(amountShape.includes('"$round"'));
	assert.ok(amountShape.includes('"$replaceAll"'));
	assert.equal(amountShape.includes('"$ifNull"'), false);

	const reasonSwitch = expressions.reason.$cond[1].$switch;
	assert.equal(
		reasonSwitch.branches[1].then,
		HOTELRUNNER_PLATFORM_FINANCE_REASONS.INVALID
	);
	assert.equal(
		reasonSwitch.branches[2].then,
		HOTELRUNNER_PLATFORM_FINANCE_REASONS.CONFLICT
	);
	assert.equal(reasonSwitch.default, "");
});

test("legacy non-HotelRunner reservations remain outside the guard", () => {
	assert.deepEqual(
		resolveHotelRunnerPlatformCommission({
			total_amount: 1000,
			sub_total: 700,
		}),
		{
			isHotelRunner: false,
			available: true,
			amount: null,
			reason: "",
		}
	);
});

test("unavailable summaries expose bounded reason counts without amounts", () => {
	assert.deepEqual(
		summarizeHotelRunnerFinanceUnavailable([
			{
				hotelrunner_finance_unavailable_reason:
					HOTELRUNNER_PLATFORM_FINANCE_REASONS.UNREVIEWED,
			},
			{
				hotelrunner_finance_unavailable_reason:
					HOTELRUNNER_PLATFORM_FINANCE_REASONS.UNREVIEWED,
			},
			{
				hotelrunner_finance_unavailable_reason:
					HOTELRUNNER_PLATFORM_FINANCE_REASONS.CONFLICT,
			},
			{},
		]),
		{
			count: 3,
			reasons: {
				[HOTELRUNNER_PLATFORM_FINANCE_REASONS.UNREVIEWED]: 2,
				[HOTELRUNNER_PLATFORM_FINANCE_REASONS.CONFLICT]: 1,
			},
		}
	);
});
