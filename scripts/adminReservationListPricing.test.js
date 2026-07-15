const test = require("node:test");
const assert = require("node:assert/strict");
const {
	compactAdminPricingForReservationList,
} = require("../services/adminReservationListPricing");

test("keeps an unavailable net total as null for exact frontend fallback", () => {
	const source = {
		mode: "standard",
		clientTotal: 1200,
		rootTotal: 900,
		platformMarginTotal: 300,
	};

	assert.deepEqual(compactAdminPricingForReservationList(source), {
		mode: "standard",
		clientTotal: 1200,
		rootTotal: 900,
		platformMarginTotal: 300,
		otaExpenseTotal: 0,
		netAfterExpensesTotal: null,
	});
	assert.equal(
		Object.prototype.hasOwnProperty.call(source, "netAfterExpensesTotal"),
		false,
	);
});

test("preserves positive and negative net totals", () => {
	for (const value of [950.5, -25]) {
		assert.equal(
			compactAdminPricingForReservationList({
				mode: "admin_three_price",
				netAfterExpensesTotal: value,
			}).netAfterExpensesTotal,
			value,
		);
	}
});

test("distinguishes schema-default zero from a genuine pricing zero", () => {
	for (const [mode, value] of [
		["", 0],
		["standard", 0],
		["standard", "0,000"],
		["not_ota", 0],
		["admin_three_price_not_calculated", 0],
	]) {
		assert.equal(
			compactAdminPricingForReservationList({
				mode,
				netAfterExpensesTotal: value,
			}).netAfterExpensesTotal,
			null,
		);
	}
	assert.equal(
		compactAdminPricingForReservationList({
			mode: "admin_three_price",
			netAfterExpensesTotal: 0,
		}).netAfterExpensesTotal,
		0,
	);
	assert.equal(
		compactAdminPricingForReservationList({
			mode: "ota_review",
			netAfterExpensesTotal: "0",
		}).netAfterExpensesTotal,
		"0",
	);
});

test("normalizes null, undefined, and blank net totals to unavailable", () => {
	for (const value of [null, undefined, "", "   "]) {
		assert.equal(
			compactAdminPricingForReservationList({
				mode: "standard",
				netAfterExpensesTotal: value,
			}).netAfterExpensesTotal,
			null,
		);
	}
});
