const assert = require("node:assert/strict");
const test = require("node:test");

const {
	__hotelRunnerProfitReportTestHelpers: {
		normalizeProfitRow,
		normalizeProfitTimelineRow,
		profitComputedFieldsStages,
		profitGroupAccumulators,
		profitSummaryProjectStage,
	},
} = require("../controllers/overall_dashboard");

test("profit aggregation routes HotelRunner net and expense only through verified fields", () => {
	const stages = profitComputedFieldsStages("createdAt");
	const commercialStage = stages[1].$addFields;

	assert.equal(commercialStage.profitHotelTotal.$cond[0], "$profitIsHotelRunner");
	assert.deepEqual(commercialStage.profitHotelTotal.$cond[1].$cond, [
		"$profitHotelRunnerNetAvailable",
		"$profitHotelRunnerNet",
		0,
	]);
	assert.equal(commercialStage.profitOtaExpense.$cond[0], "$profitIsHotelRunner");
	assert.deepEqual(commercialStage.profitOtaExpense.$cond[1].$cond, [
		"$profitHotelRunnerOtaExpenseAvailable",
		"$profitHotelRunnerOtaExpense",
		0,
	]);

	const serializedHotelRunnerBranches = JSON.stringify({
		hotelTotal: commercialStage.profitHotelTotal.$cond[1],
		otaExpense: commercialStage.profitOtaExpense.$cond[1],
	});
	assert.doesNotMatch(serializedHotelRunnerBranches, /sub_total/);
	assert.doesNotMatch(serializedHotelRunnerBranches, /profitSpreadAmount/);
});

test("profit aggregation preserves legacy branches while excluding incomplete HotelRunner profit", () => {
	const stages = profitComputedFieldsStages("createdAt");
	const commissionStage = stages[3].$addFields.profitCommission;
	const platformStage = stages[4].$addFields.profitPlatformMargin;
	const availabilityStage = stages[5].$addFields;
	const finalStage = stages[6].$addFields;

	assert.equal(commissionStage.$cond[0], "$profitIsHotelRunner");
	assert.match(JSON.stringify(commissionStage.$cond[2]), /profitStoredCommission/);
	assert.equal(platformStage.$cond[0], "$profitIsHotelRunner");
	assert.match(JSON.stringify(platformStage.$cond[2]), /profitSpreadAmount/);
	assert.deepEqual(availabilityStage.profitMarginAvailable.$cond[1].$and, [
		"$profitCommissionAvailable",
		"$profitPlatformMarginAvailable",
	]);
	assert.equal(finalStage.profitMargin.$cond[0], "$profitMarginAvailable");
	assert.deepEqual(finalStage.profitAvailableClientTotal.$cond, [
		"$profitMarginAvailable",
		"$profitClientTotal",
		0,
	]);
});

test("profit group totals carry excluded counts and use only covered gross for rate", () => {
	const accumulators = profitGroupAccumulators();
	assert.deepEqual(accumulators.commercialUnavailableCount, {
		$sum: "$profitCommercialUnavailableCount",
	});
	assert.deepEqual(accumulators.profitUnavailableCount, {
		$sum: "$profitUnavailableCount",
	});
	const projection = profitSummaryProjectStage().$project;
	assert.match(JSON.stringify(projection.profitRate), /profitAvailableClientTotal/);
});

test("profit response preserves per-row and grouped HotelRunner availability", () => {
	const row = normalizeProfitRow({
		profitIsHotelRunner: true,
		profitClientTotal: 1000,
		profitHotelTotal: 0,
		profitHotelTotalAvailable: false,
		profitOtaExpense: 0,
		profitOtaExpenseAvailable: false,
		profitCommissionAvailable: false,
		profitPlatformMarginAvailable: false,
		profitMarginAvailable: false,
	});
	assert.equal(row.profitMetrics.isHotelRunner, true);
	assert.equal(row.profitMetrics.clientTotal, 1000);
	assert.equal(row.profitMetrics.hotelTotalAvailable, false);
	assert.equal(row.profitMetrics.otaExpenseAvailable, false);
	assert.equal(row.profitMetrics.profitAvailable, false);

	const timeline = normalizeProfitTimelineRow({
		clientTotal: 1500,
		profitMargin: 50,
		profitAvailableClientTotal: 500,
		commercialUnavailableCount: 1,
		profitUnavailableCount: 1,
	});
	assert.equal(timeline.profitRate, 10);
	assert.equal(timeline.commercialUnavailableCount, 1);
	assert.equal(timeline.profitUnavailableCount, 1);
});
