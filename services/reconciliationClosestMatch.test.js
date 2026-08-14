/** @format */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
	HARD_MAX_CANDIDATES,
	HARD_MAX_SELECTED,
	findClosestReconciliationMatch,
} = require("./reconciliationClosestMatch");

const candidate = (
	id,
	amountCents,
	checkinDate = "2026-01-01",
	checkoutDate = "2026-01-02"
) => ({ id, amountCents, checkinDate, checkoutDate });

test("finds an exact integer-cent subset and reports a guaranteed optimum", () => {
	const result = findClosestReconciliationMatch(
		[candidate("a", 301), candidate("b", 699), candidate("c", 1400)],
		1000
	);
	assert.deepEqual(result.selectedIds, ["a", "b"]);
	assert.equal(result.matchedCents, 1000);
	assert.equal(result.differenceCents, 0);
	assert.equal(result.direction, "exact");
	assert.equal(result.exactMatch, true);
	assert.equal(result.optimalityGuaranteed, true);
	assert.equal(result.timedOut, false);
});

test("returns the nearest under-target proposal", () => {
	const result = findClosestReconciliationMatch(
		[candidate("a", 451), candidate("b", 448)],
		1000
	);
	assert.equal(result.matchedCents, 899);
	assert.equal(result.differenceCents, -101);
	assert.equal(result.direction, "under");
	assert.equal(result.exactMatch, false);
});

test("returns an over-target proposal when every non-empty choice is over", () => {
	const result = findClosestReconciliationMatch(
		[candidate("a", 1101), candidate("b", 1300)],
		1000
	);
	assert.deepEqual(result.selectedIds, ["a"]);
	assert.equal(result.matchedCents, 1101);
	assert.equal(result.differenceCents, 101);
	assert.equal(result.direction, "over");
});

test("ties prefer under target, then fewer reservations", () => {
	const underTie = findClosestReconciliationMatch(
		[candidate("over", 1100), candidate("under", 900)],
		1000
	);
	assert.deepEqual(underTie.selectedIds, ["under"]);

	const fewerRows = findClosestReconciliationMatch(
		[
			candidate("part-1", 400),
			candidate("part-2", 600),
			candidate("whole", 1000),
		],
		1000
	);
	assert.deepEqual(fewerRows.selectedIds, ["whole"]);
});

test("exact two-sum prepass avoids a 500-row exact reconstruction", () => {
	const tinyRows = Array.from({ length: 500 }, (_, index) =>
		candidate(
			`tiny-${String(index).padStart(3, "0")}`,
			1,
			"2026-01-01",
			"2026-01-02"
		)
	);
	const result = findClosestReconciliationMatch(
		[
			...tinyRows,
			candidate("four-hundred", 400, "2026-01-02", "2026-01-03"),
			candidate("one-hundred", 100, "2026-01-03", "2026-01-04"),
		],
		500
	);
	assert.deepEqual(result.selectedIds, ["four-hundred", "one-hundred"]);
	assert.equal(result.selectedCount, 2);
	assert.equal(result.exactMatch, true);
	assert.equal(result.selectionLimitExceeded, false);
});

test("exact two-sum prepass prefers 4 + 6 over chronological 2 + 3 + 5", () => {
	const amounts = [2, 3, 5, 4, 6];
	const inputs = amounts.map((amountCents, index) =>
		candidate(
			`row-${index + 1}`,
			amountCents,
			`2026-01-0${index + 1}`,
			`2026-01-0${index + 2}`
		)
	);
	const result = findClosestReconciliationMatch(inputs, 10);
	assert.deepEqual(result.selectedIds, ["row-4", "row-5"]);
	assert.equal(result.selectedCount, 2);
	assert.equal(result.exactMatch, true);
	assert.equal(result.optimalityGuaranteed, true);
	assert.equal(result.selectionLimitExceeded, false);
});

test("equal financial ties are stable by chronology and then id", () => {
	const inputs = [
		candidate("z-later", 500, "2026-01-03", "2026-01-04"),
		candidate("z-earlier", 500, "2026-01-01", "2026-01-02"),
		candidate("a-same-day", 500, "2026-01-01", "2026-01-02"),
	];
	const result = findClosestReconciliationMatch(inputs, 500);
	assert.deepEqual(result.selectedIds, ["a-same-day"]);
});

test("input ordering cannot change a deterministic proposal", () => {
	const inputs = [
		candidate("d", 277, "2026-01-04", "2026-01-05"),
		candidate("b", 349, "2026-01-02", "2026-01-03"),
		candidate("a", 431, "2026-01-01", "2026-01-02"),
		candidate("c", 193, "2026-01-03", "2026-01-04"),
	];
	const first = findClosestReconciliationMatch(inputs, 710);
	const second = findClosestReconciliationMatch([...inputs].reverse(), 710);
	assert.deepEqual(first.selectedIds, second.selectedIds);
	assert.equal(first.matchedCents, second.matchedCents);
});

test("never returns more reservations than the mutation cap", () => {
	const inputs = Array.from({ length: 700 }, (_, index) =>
		candidate(`tiny-${String(index).padStart(4, "0")}`, 1)
	);
	const result = findClosestReconciliationMatch(inputs, 501);
	assert.equal(result.selectedCount, HARD_MAX_SELECTED);
	assert.equal(result.selectedIds.length, HARD_MAX_SELECTED);
	assert.equal(result.matchedCents, HARD_MAX_SELECTED);
	assert.equal(result.selectionLimitExceeded, true);
	assert.equal(result.optimalityGuaranteed, false);
});

test("supports a stricter internal maxSelectedCount option", () => {
	const inputs = Array.from({ length: 10 }, (_, index) =>
		candidate(`row-${index}`, 2)
	);
	const result = findClosestReconciliationMatch(inputs, 10, {
		maxSelectedCount: 3,
	});
	assert.equal(result.selectedCount, 3);
	assert.equal(result.matchedCents, 6);
	assert.equal(result.selectionLimitExceeded, true);
});

test("hard candidate cap rejects an unbounded request", () => {
	const inputs = Array.from({ length: HARD_MAX_CANDIDATES + 1 }, (_, index) =>
		candidate(`row-${index}`, 100)
	);
	assert.throws(
		() =>
			findClosestReconciliationMatch(inputs, 1000, {
				maxCandidates: HARD_MAX_CANDIDATES + 1000,
			}),
		(error) => {
			assert.equal(error.code, "closest_match_candidate_limit_exceeded");
			assert.equal(error.statusCode, 422);
			return true;
		}
	);
});

test("validates exact cents and duplicate ids instead of coercing values", () => {
	assert.throws(
		() => findClosestReconciliationMatch([candidate("bad", 10.5)], 100),
		(error) => error.code === "invalid_closest_match_candidate_amount"
	);
	assert.throws(
		() =>
			findClosestReconciliationMatch(
				[candidate("duplicate", 50), candidate("duplicate", 60)],
				100
			),
		(error) => error.code === "duplicate_closest_match_candidate_id"
	);
});

test("handles 5,000 candidates within all hard output bounds", {
	timeout: 15000,
}, () => {
	const inputs = Array.from({ length: HARD_MAX_CANDIDATES }, (_, index) =>
		candidate(
			`bulk-${String(index).padStart(4, "0")}`,
			5001 + ((index * 7919) % 250003),
			`2026-01-${String((index % 28) + 1).padStart(2, "0")}`,
			`2026-02-${String((index % 28) + 1).padStart(2, "0")}`
		)
	);
	const result = findClosestReconciliationMatch(inputs, 2000003);
	assert.equal(result.candidateCount, HARD_MAX_CANDIDATES);
	assert.ok(result.selectedCount > 0);
	assert.ok(result.selectedCount <= HARD_MAX_SELECTED);
	assert.equal(result.selectedIds.length, result.selectedCount);
	assert.ok(Number.isSafeInteger(result.matchedCents));
	assert.ok(Number.isSafeInteger(result.differenceCents));
});
