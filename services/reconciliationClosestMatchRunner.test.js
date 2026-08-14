/** @format */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
	runClosestReconciliationMatch,
} = require("./reconciliationClosestMatchRunner");

test("worker runner returns the documented proposal interface", async () => {
	const result = await runClosestReconciliationMatch(
		[
			{
				id: "one",
				amountCents: 250,
				checkinDate: "2026-01-01",
				checkoutDate: "2026-01-02",
			},
			{
				id: "two",
				amountCents: 750,
				checkinDate: "2026-01-02",
				checkoutDate: "2026-01-03",
			},
		],
		1000
	);
	assert.deepEqual(result.selectedIds, ["one", "two"]);
	assert.equal(result.matchedCents, 1000);
	assert.equal(result.differenceCents, 0);
	assert.equal(result.direction, "exact");
	assert.equal(result.exactMatch, true);
	assert.equal(result.optimalityGuaranteed, true);
	assert.equal(result.resolutionCents, 1);
	assert.equal(result.candidateCount, 2);
	assert.equal(result.selectedCount, 2);
	assert.equal(typeof result.elapsedMs, "number");
	assert.equal(result.timedOut, false);
});

test("worker runner rejects a timeout with a typed service error", async () => {
	await assert.rejects(
		runClosestReconciliationMatch(
			[
				{
					id: "one",
					amountCents: 100,
					checkinDate: null,
					checkoutDate: null,
				},
			],
			100,
			{ timeoutMs: 0 }
		),
		(error) => {
			assert.equal(error.code, "closest_match_timeout");
			assert.equal(error.statusCode, 503);
			assert.equal(error.elapsedMs, 0);
			return true;
		}
	);
});

test("worker validation errors retain safe codes and status", async () => {
	await assert.rejects(
		runClosestReconciliationMatch(
			[{ id: "bad", amountCents: "100" }],
			100
		),
		(error) => {
			assert.equal(error.code, "invalid_closest_match_candidate_amount");
			assert.equal(error.statusCode, 400);
			return true;
		}
	);
});

test("runner preflight rejects oversized and primitive candidates", async () => {
	const oversized = Array.from({ length: 5001 }, (_, index) => ({
		id: `row-${index}`,
		amountCents: 1,
	}));
	await assert.rejects(
		runClosestReconciliationMatch(oversized, 100),
		(error) => {
			assert.equal(error.code, "closest_match_candidate_limit_exceeded");
			assert.equal(error.statusCode, 422);
			return true;
		}
	);
	await assert.rejects(
		runClosestReconciliationMatch(["not-an-object"], 100),
		(error) => {
			assert.equal(error.code, "invalid_closest_match_candidate");
			assert.equal(error.statusCode, 400);
			return true;
		}
	);
});
