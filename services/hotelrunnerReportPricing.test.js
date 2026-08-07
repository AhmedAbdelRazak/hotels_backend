const assert = require("node:assert/strict");
const test = require("node:test");

const {
	buildHotelRunnerProfitAggregationFields,
	buildHotelRunnerSafeCommissionExpression,
	buildHotelRunnerSafeNetExpression,
	buildHotelRunnerUnverifiedExpenseCountExpression,
	buildHotelRunnerUnverifiedNetCountExpression,
	isHotelRunnerReservation,
	verifiedHotelRunnerProfitMetrics,
	verifiedHotelRunnerOtaExpense,
} = require("./hotelrunnerReportPricing");

test("direct HotelRunner ownership requires an exact persisted integration marker", () => {
	assert.equal(
		isHotelRunnerReservation({
			supplierData: { hotelRunner: { transport: "hotelrunner_api" } },
		}),
		true
	);
	assert.equal(
		isHotelRunnerReservation({ booking_source: "HotelRunner-looking text" }),
		false
	);
});

test("HotelRunner report pricing never derives OTA expense from gross minus local base", () => {
	const reservation = {
		total_amount: 1000,
		sub_total: 700,
		adminPricing: {
			mode: "hotelrunner_api",
			commercialVerified: false,
		},
	};

	assert.deepEqual(verifiedHotelRunnerOtaExpense(reservation), {
		isHotelRunner: true,
		available: false,
		amount: null,
	});
});

test("HotelRunner report pricing exposes only an explicit verified expense", () => {
	const reservation = {
		adminPricing: {
			mode: "hotelrunner_api",
			commercialVerified: true,
			otaExpenseTotal: 150,
		},
	};

	assert.deepEqual(verifiedHotelRunnerOtaExpense(reservation), {
		isHotelRunner: true,
		available: true,
		amount: 150,
	});
});

test("unverified summary values cannot be borrowed by a verified admin flag", () => {
	const reservation = {
		adminPricing: {
			mode: "hotelrunner_api",
			commercialVerified: true,
		},
		ota_financial_summary: {
			commercialVerified: false,
			otaExpenseTotal: 150,
		},
	};

	assert.equal(verifiedHotelRunnerOtaExpense(reservation).available, false);
});

test("an empty snake-case summary cannot hide verified camel-case evidence", () => {
	assert.deepEqual(
		verifiedHotelRunnerOtaExpense({
			adminPricing: { mode: "hotelrunner_api" },
			ota_financial_summary: {},
			otaFinancialSummary: {
				commercialVerified: true,
				otaExpenseTotal: 95,
			},
		}),
		{ isHotelRunner: true, available: true, amount: 95 },
	);
});

test("conflicting verified HotelRunner commercial sources fail closed", () => {
	const reservation = {
		adminPricing: {
			mode: "hotelrunner_api",
			commercialVerified: true,
			netAfterExpensesTotal: 850,
			otaExpenseTotal: 150,
		},
		ota_financial_summary: {
			commercialVerified: true,
			netAfterExpenses: 825,
			netAfterOtaExpenses: 825,
			otaExpenseTotal: 175,
		},
	};

	assert.deepEqual(verifiedHotelRunnerOtaExpense(reservation), {
		isHotelRunner: true,
		available: false,
		amount: null,
	});
	const metrics = verifiedHotelRunnerProfitMetrics(reservation);
	assert.deepEqual(metrics.netAfterExpenses, {
		available: false,
		amount: null,
	});
	assert.deepEqual(metrics.otaExpense, {
		available: false,
		amount: null,
	});
});

test("same-source alias conflicts and invalid verified money fail closed", () => {
	const aliasConflict = verifiedHotelRunnerProfitMetrics({
		adminPricing: { mode: "hotelrunner_api" },
		ota_financial_summary: {
			commercialVerified: true,
			netAfterExpenses: 850,
			netAfterOtaExpenses: 800,
		},
	});
	assert.deepEqual(aliasConflict.netAfterExpenses, {
		available: false,
		amount: null,
	});

	assert.deepEqual(
		verifiedHotelRunnerOtaExpense({
			adminPricing: {
				mode: "hotelrunner_api",
				commercialVerified: true,
				otaExpenseTotal: { forged: 150 },
			},
		}),
		{ isHotelRunner: true, available: false, amount: null },
	);
	for (const nonFinite of [Number.POSITIVE_INFINITY, Number.NaN]) {
		assert.deepEqual(
			verifiedHotelRunnerOtaExpense({
				adminPricing: {
					mode: "hotelrunner_api",
					commercialVerified: true,
					otaExpenseTotal: nonFinite,
				},
			}),
			{ isHotelRunner: true, available: false, amount: null },
		);
	}
});

test("non-HotelRunner report pricing remains outside the safety override", () => {
	assert.deepEqual(
		verifiedHotelRunnerOtaExpense({
			adminPricing: {
				mode: "ota_platform_sync",
				commercialVerified: true,
				otaExpenseTotal: 150,
			},
		}),
		{ isHotelRunner: false, available: false, amount: null }
	);
});

test("Mongo report expressions wrap legacy commission and track unavailable HotelRunner evidence", () => {
	const legacy = { $subtract: ["$total_amount", "$sub_total"] };
	const commission = buildHotelRunnerSafeCommissionExpression(legacy);
	const unavailable = buildHotelRunnerUnverifiedExpenseCountExpression();

	assert.equal(commission.$cond[2], legacy);
	assert.equal(commission.$cond[1].$cond[2], 0);
	assert.equal(unavailable.$cond[1], 1);
	assert.equal(unavailable.$cond[2], 0);
});

test("Mongo report expressions preserve legacy net but fail closed for unverified HotelRunner net", () => {
	const legacy = "$sub_total";
	const net = buildHotelRunnerSafeNetExpression(legacy);
	const unavailable = buildHotelRunnerUnverifiedNetCountExpression();

	assert.equal(net.$cond[2], legacy);
	assert.equal(net.$cond[1].$cond[2], 0);
	assert.equal(unavailable.$cond[1], 1);
	assert.equal(unavailable.$cond[2], 0);
	assert.match(
		JSON.stringify(net.$cond[1]),
		/adminPricing\.netAfterExpensesTotal/
	);
	assert.doesNotMatch(JSON.stringify(net.$cond[1]), /sub_total/);
});

test("HotelRunner profit metrics keep gross-minus-room-subtotal out of net and profit", () => {
	const metrics = verifiedHotelRunnerProfitMetrics({
		total_amount: 1000,
		sub_total: 700,
		adminPricing: {
			mode: "hotelrunner_api",
			clientTotal: 1000,
			rootTotal: 700,
			commercialVerified: false,
		},
	});

	assert.equal(metrics.isHotelRunner, true);
	for (const metric of [
		metrics.netAfterExpenses,
		metrics.otaExpense,
		metrics.commission,
		metrics.platformMargin,
		metrics.profit,
	]) {
		assert.equal(metric.available, false);
		assert.equal(metric.amount, null);
	}
});

test("HotelRunner profit metrics expose each commercially verified field independently", () => {
	const metrics = verifiedHotelRunnerProfitMetrics({
		adminPricing: {
			mode: "hotelrunner_api",
			commercialVerified: true,
			netAfterExpensesTotal: 850,
			otaExpenseTotal: 150,
			commissionAmount: 0,
			platformMarginTotal: 25,
		},
	});

	assert.deepEqual(metrics.netAfterExpenses, {
		available: true,
		amount: 850,
	});
	assert.deepEqual(metrics.otaExpense, { available: true, amount: 150 });
	assert.deepEqual(metrics.commission, { available: true, amount: 0 });
	assert.deepEqual(metrics.platformMargin, {
		available: true,
		amount: 25,
	});
	assert.deepEqual(metrics.profit, { available: true, amount: 25 });
});

test("verified HotelRunner payout does not manufacture missing platform profit", () => {
	const metrics = verifiedHotelRunnerProfitMetrics({
		adminPricing: {
			mode: "hotelrunner_api",
			commercialVerified: true,
			netAfterExpensesTotal: 850,
			otaExpenseTotal: 150,
		},
	});

	assert.equal(metrics.netAfterExpenses.available, true);
	assert.equal(metrics.otaExpense.available, true);
	assert.equal(metrics.platformMargin.available, false);
	assert.equal(metrics.commission.available, false);
	assert.equal(metrics.profit.available, false);
});

test("HotelRunner profit aggregation fields require same-source verification and finite money", () => {
	const fields = buildHotelRunnerProfitAggregationFields();
	assert.ok(fields.profitIsHotelRunner?.$or);
	assert.ok(fields.profitHotelRunnerNetAvailable?.$and);
	assert.ok(fields.profitHotelRunnerOtaExpenseAvailable?.$and);
	assert.ok(fields.profitHotelRunnerCommissionAvailable?.$and);
	assert.ok(fields.profitHotelRunnerPlatformMarginAvailable?.$and);
	const serialized = JSON.stringify(fields);
	assert.match(serialized, /adminPricing\.commercialVerified/);
	assert.match(serialized, /adminPricing\.netAfterExpensesTotal/);
	assert.match(serialized, /adminPricing\.platformMarginTotal/);
	assert.match(serialized, /"onError":null/);
	assert.match(serialized, /"\$setUnion"/);
	assert.match(serialized, /"\$round"/);
	assert.match(serialized, /"\$type"/);
	assert.match(serialized, /"\$lte"/);
	assert.match(serialized, /1\.7976931348623157e\+308/);
	assert.doesNotMatch(serialized, /sub_total/);
});
