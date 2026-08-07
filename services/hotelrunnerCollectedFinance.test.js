"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

const reservationsController = require("../controllers/reservations");
const {
	__hotelRunnerCollectedFinanceTest: {
		collectedReservationFinanceAggregationPipeline,
	},
} = reservationsController;

const responseStub = () => ({
	statusCode: 200,
	body: null,
	status(code) {
		this.statusCode = code;
		return this;
	},
	json(body) {
		this.body = body;
		return this;
	},
	send(body) {
		this.body = body;
		return this;
	},
});

test("collected finance aggregation keeps HotelRunner net and expense out of legacy gross-minus-subtotal math", () => {
	const match = { hotelId: "hotel-1", payment: "collected" };
	const pipeline = collectedReservationFinanceAggregationPipeline(match);
	const group = pipeline[1].$group;
	const project = pipeline[2].$project;

	assert.equal(pipeline[0].$match, match);
	assert.equal(group.actual_amount.$sum.$cond[2], "$sub_total");
	assert.equal(group.legacyCommissionGross.$sum.$cond[2], "$total_amount");
	assert.equal(group.legacyCommissionBase.$sum.$cond[2], "$sub_total");
	assert.equal(group.hotelRunnerVerifiedOtaExpense.$sum.$cond[2], 0);

	const hotelRunnerNetBranch = JSON.stringify(
		group.actual_amount.$sum.$cond[1]
	);
	const hotelRunnerExpenseBranch = JSON.stringify(
		group.hotelRunnerVerifiedOtaExpense.$sum.$cond[1]
	);
	assert.match(hotelRunnerNetBranch, /netAfterExpensesTotal/);
	assert.match(hotelRunnerExpenseBranch, /otaExpenseTotal/);
	assert.doesNotMatch(hotelRunnerNetBranch, /sub_total/);
	assert.doesNotMatch(hotelRunnerExpenseBranch, /sub_total/);

	assert.ok(group.actualAmountUnavailableCount.$sum);
	assert.ok(group.commissionUnavailableCount.$sum);
	assert.deepEqual(project.commission, {
		$add: [
			{
				$subtract: [
					"$legacyCommissionGross",
					"$legacyCommissionBase",
				],
			},
			"$hotelRunnerVerifiedOtaExpense",
		],
	});
	assert.equal(project.actualAmountUnavailableCount, 1);
	assert.equal(project.commissionUnavailableCount, 1);
});

test("collected finance endpoints require an authorized signed-in hotel viewer", async () => {
	const params = {
		status: "all",
		page: "1",
		records: "20",
		hotelId: "64a40b6a1a6efe7045053603",
	};
	for (const handler of [
		reservationsController.CollectedReservations,
		reservationsController.aggregateCollectedReservations,
	]) {
		const response = responseStub();
		await handler({ params, auth: null }, response);
		assert.equal(response.statusCode, 401);
		assert.deepEqual(response.body, { error: "Authentication required." });
	}

	const routeSource = fs.readFileSync(
		require.resolve("../routes/reservations"),
		"utf8"
	);
	for (const routePrefix of [
		"/collected-reservations/list/",
		"/aggregated-collected-reservations/list/",
	]) {
		const offset = routeSource.indexOf(routePrefix);
		assert.notEqual(offset, -1);
		assert.match(routeSource.slice(offset, offset + 240), /requireSignin/);
	}
});
