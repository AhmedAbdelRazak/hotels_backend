"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
	buildHotelRunnerPlatformFinanceAggregationExpressions,
} = require("./hotelrunnerPlatformFinance");
const {
	__hotelRunnerAgentFinanceTestHelpers: {
		reservationCommissionFinance,
		decorateReservationCommissionFinance,
	},
} = require("../controllers/agent_wallet");
const {
	__hotelRunnerExecutiveFinanceTestHelpers: {
		decorateExecutiveReservationCommission,
		executiveCommissionComputedFields,
		executiveCommissionCountProjection,
		executiveGroupTotals,
	},
} = require("../controllers/overall_dashboard");

const hotelRunnerReservation = (overrides = {}) => ({
	total_amount: 1000,
	sub_total: 700,
	commission: 0,
	adminPricing: { mode: "hotelrunner_api" },
	supplierData: {
		hotelRunner: {
			transport: "hotelrunner_api",
			reservationId: "hr-report-test",
		},
	},
	...overrides,
});

test("agent and executive rows expose unreviewed HotelRunner commission as unavailable", () => {
	const source = hotelRunnerReservation();
	const agentFinance = reservationCommissionFinance(source);
	assert.equal(agentFinance.available, false);
	assert.equal(agentFinance.amount, null);

	const agentRow = decorateReservationCommissionFinance(source);
	assert.equal(agentRow.report_commission, null);
	assert.equal(agentRow.hotelrunner_finance_available, false);
	assert.equal(
		agentRow.hotelrunner_finance_unavailable_reason,
		"hotelrunner_platform_commission_unreviewed"
	);

	const executiveRow = decorateExecutiveReservationCommission(source);
	assert.equal(executiveRow.report_commission, null);
	assert.equal(executiveRow.commission_finance_available, false);
});

test("reviewed HotelRunner zero remains available while conflicts fail closed", () => {
	const reviewedZero = hotelRunnerReservation({
		financial_cycle: { commissionAssigned: true, commissionAmount: 0 },
	});
	assert.deepEqual(
		reservationCommissionFinance(reviewedZero),
		{
			isHotelRunner: true,
			available: true,
			amount: 0,
			reason: "",
		}
	);
	assert.equal(
		decorateExecutiveReservationCommission(reviewedZero).report_commission,
		0
	);

	const conflicting = hotelRunnerReservation({
		commissionData: { assigned: true, amount: 25 },
		financial_cycle: { commissionAssigned: true, commissionAmount: 30 },
	});
	const conflict = reservationCommissionFinance(conflicting);
	assert.equal(conflict.available, false);
	assert.equal(conflict.amount, null);
	assert.equal(conflict.reason, "hotelrunner_platform_commission_conflict");

	const invalid = reservationCommissionFinance(
		hotelRunnerReservation({
			financial_cycle: {
				commissionAssigned: true,
				commissionAmount: false,
			},
		})
	);
	assert.equal(invalid.available, false);
	assert.equal(invalid.amount, null);
	assert.equal(invalid.reason, "hotelrunner_platform_commission_invalid");
});

test("legacy commission behavior remains unchanged on both report paths", () => {
	const legacy = {
		commission: 0,
		financial_cycle: { commissionAmount: 25 },
	};
	assert.deepEqual(reservationCommissionFinance(legacy), {
		isHotelRunner: false,
		available: true,
		amount: 25,
		reason: "",
	});
	assert.equal(
		decorateExecutiveReservationCommission(legacy).report_commission,
		25
	);
});

test("executive aggregate contract carries strict availability and excluded counts", () => {
	const strict = buildHotelRunnerPlatformFinanceAggregationExpressions();
	const computed = executiveCommissionComputedFields();
	const totals = executiveGroupTotals();
	const projection = executiveCommissionCountProjection();

	assert.deepEqual(computed.executiveCommissionAvailable, strict.available);
	assert.match(
		JSON.stringify(computed.executiveCommissionAmount),
		/executiveStoredCommission|financial_cycle\.commissionAmount/
	);
	assert.doesNotMatch(
		JSON.stringify({ strict, computed }),
		/sub_total|rootTotal|total_amount/
	);
	assert.deepEqual(totals.commission, {
		$sum: "$executiveCommissionAmount",
	});
	assert.deepEqual(totals.commissionUnavailableCount, {
		$sum: { $cond: ["$executiveCommissionAvailable", 0, 1] },
	});
	assert.deepEqual(projection, {
		commissionUnavailableCount: 1,
		commissionUnreviewedCount: 1,
		commissionInvalidCount: 1,
		commissionConflictCount: 1,
	});
});
