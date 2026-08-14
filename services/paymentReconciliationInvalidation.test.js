/** @format */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
	PAYMENT_BREAKDOWN_KEYS,
} = require("./paymentReconciliation");
const {
	RECONCILIATION_BREAKDOWN_ROOT,
	planPaymentReconciliationInvalidation,
	planPaymentReconciliationInvalidationForModifiedPaths,
	withPaymentReconciliationInvalidation,
} = require("./paymentReconciliationInvalidation");
const Reservations = require("../models/reservations");

const namedPreHook = (operation, name) =>
	(Reservations.schema.s.hooks._pres.get(operation) || [])
		.map((entry) => entry.fn)
		.find((fn) => fn?.name === name);

const invokeMiddleware = (middleware, context) =>
	new Promise((resolve, reject) => {
		middleware.call(context, (error) => (error ? reject(error) : resolve()));
	});

test("plans only fixed monetary category changes and ignores payment comments", () => {
	const plan = planPaymentReconciliationInvalidation({
		$set: {
			"paid_amount_breakdown.paid_at_hotel_cash": 125,
			"paid_amount_breakdown.payment_comments": "cash corrected",
		},
		$inc: {
			"paid_amount_breakdown.paid_at_hotel_card": 10,
		},
		$unset: {
			"paid_amount_breakdown.paid_online_other_platforms": 1,
		},
		$setOnInsert: {
			paid_amount_breakdown: { paid_at_hotel_cash: 999 },
		},
	});

	assert.equal(plan.invalidateAll, false);
	assert.deepEqual(plan.keys, [
		"paid_at_hotel_cash",
		"paid_at_hotel_card",
		"paid_online_other_platforms",
	]);
});

test("root replacement or unset clears every reconciliation category", () => {
	for (const update of [
		{ $set: { paid_amount_breakdown: { paid_at_hotel_cash: 10 } } },
		{ $unset: { paid_amount_breakdown: 1 } },
		{ paid_amount_breakdown: { payment_comments: "root replacement" } },
	]) {
		const plan = planPaymentReconciliationInvalidation(update);
		assert.equal(plan.invalidateAll, true);
		assert.deepEqual(plan.keys, PAYMENT_BREAKDOWN_KEYS);
	}
});

test("rename invalidates both monetary source and destination", () => {
	const plan = planPaymentReconciliationInvalidation({
		$rename: {
			"paid_amount_breakdown.paid_at_hotel_cash":
				"paid_amount_breakdown.paid_at_hotel_card",
		},
	});
	assert.deepEqual(plan.keys, [
		"paid_at_hotel_cash",
		"paid_at_hotel_card",
	]);
});

test("category updates atomically unset only affected snapshots and preserve audit operators", () => {
	const audit = { type: "payment_correction", at: new Date() };
	const update = {
		$inc: { "paid_amount_breakdown.paid_at_hotel_cash": 5 },
		$set: {
			"customer_details.name": "Updated Guest",
			"payment_reconciliation.breakdown.paid_at_hotel_cash.status":
				"reconciled",
		},
		$push: { reservationAuditLog: audit },
		$rename: {
			legacyReconciliation:
				"payment_reconciliation.breakdown.paid_at_hotel_cash",
		},
	};
	const result = withPaymentReconciliationInvalidation(update);

	assert.notStrictEqual(result, update);
	assert.deepEqual(result.$inc, update.$inc);
	assert.equal(result.$set["customer_details.name"], "Updated Guest");
	assert.equal(
		result.$set[
			"payment_reconciliation.breakdown.paid_at_hotel_cash.status"
		],
		undefined
	);
	assert.strictEqual(result.$push.reservationAuditLog, audit);
	assert.equal(result.$rename, undefined);
	assert.equal(
		result.$unset[
			"payment_reconciliation.breakdown.paid_at_hotel_cash"
		],
		1
	);
});

test("root updates clear the breakdown without removing existing audit writes", () => {
	const result = withPaymentReconciliationInvalidation({
		$set: {
			paid_amount_breakdown: { paid_at_hotel_cash: 50 },
			"payment_reconciliation.breakdown.paid_at_hotel_cash": {
				status: "reconciled",
			},
		},
		$push: { adminChangeLog: { field: "paid_amount_breakdown" } },
	});

	assert.deepEqual(result.$set[RECONCILIATION_BREAKDOWN_ROOT], {});
	assert.deepEqual(result.$set.paid_amount_breakdown, {
		paid_at_hotel_cash: 50,
	});
	assert.deepEqual(result.$push, {
		adminChangeLog: { field: "paid_amount_breakdown" },
	});
});

test("reconciliation-only PATCH updates and payment comments are unaffected", () => {
	for (const update of [
		{
			$set: {
				"payment_reconciliation.breakdown.paid_at_hotel_cash": {
					status: "reconciled",
				},
			},
			$push: { reservationAuditLog: { type: "reconciliation" } },
		},
		{
			$set: {
				"paid_amount_breakdown.payment_comments": "receipt checked",
			},
		},
	]) {
		assert.strictEqual(withPaymentReconciliationInvalidation(update), update);
	}
});

test("replaceOne resets server-managed reconciliation but preserves reservation audits", () => {
	const replacement = {
		confirmation_number: "replace-test",
		adminChangeLog: [{ type: "replacement" }],
		payment_reconciliation: {
			lastBatchId: "previous-batch",
			breakdown: {
				paid_at_hotel_cash: { status: "reconciled", amountCents: 1000 },
			},
		},
	};
	const result = withPaymentReconciliationInvalidation(replacement, {
		replacement: true,
	});

	assert.deepEqual(result.adminChangeLog, replacement.adminChangeLog);
	assert.deepEqual(result.payment_reconciliation, {
		breakdown: {},
		lastUpdatedAt: null,
		lastUpdatedBy: null,
		lastBatchId: "",
	});
	assert.deepEqual(replacement.payment_reconciliation.breakdown, {
		paid_at_hotel_cash: { status: "reconciled", amountCents: 1000 },
	});
});

test("pipeline writes append a final invalidation stage", () => {
	const categoryResult = withPaymentReconciliationInvalidation([
		{
			$set: {
				"paid_amount_breakdown.paid_online_via_link": 20,
			},
		},
	]);
	assert.deepEqual(categoryResult.at(-1), {
		$unset: [
			"payment_reconciliation.breakdown.paid_online_via_link",
		],
	});

	const rootResult = withPaymentReconciliationInvalidation([
		{ $unset: "paid_amount_breakdown" },
	]);
	assert.deepEqual(rootResult.at(-1), {
		$set: { "payment_reconciliation.breakdown": {} },
	});

	const projectionResult = withPaymentReconciliationInvalidation([
		{ $project: { confirmation_number: 1 } },
	]);
	assert.deepEqual(projectionResult.at(-1), {
		$set: { "payment_reconciliation.breakdown": {} },
	});
});

test("document modified-path planning ignores comments and distinguishes root edits", () => {
	assert.deepEqual(
		planPaymentReconciliationInvalidationForModifiedPaths([
			"paid_amount_breakdown.payment_comments",
			"customer_details.name",
		]),
		{ invalidateAll: false, keys: [] }
	);
	assert.deepEqual(
		planPaymentReconciliationInvalidationForModifiedPaths([
			"paid_amount_breakdown.paid_no_show",
		]),
		{ invalidateAll: false, keys: ["paid_no_show"] }
	);
	assert.equal(
		planPaymentReconciliationInvalidationForModifiedPaths([
			"paid_amount_breakdown",
		]).invalidateAll,
		true
	);
});

test("reservation schema registers invalidation for every query update operation", async () => {
	for (const operation of [
		"updateOne",
		"updateMany",
		"findOneAndUpdate",
		"replaceOne",
	]) {
		assert.equal(
			typeof namedPreHook(
				operation,
				"invalidateReconciliationOnQueryUpdate"
			),
			"function"
		);
	}

	const hook = namedPreHook(
		"updateOne",
		"invalidateReconciliationOnQueryUpdate"
	);
	let update = {
		$inc: { "paid_amount_breakdown.paid_no_show": 15 },
		$push: { reservationAuditLog: { type: "payment_correction" } },
	};
	await invokeMiddleware(hook, {
		op: "updateOne",
		getUpdate: () => update,
		setUpdate: (value) => {
			update = value;
		},
	});
	assert.equal(
		update.$unset["payment_reconciliation.breakdown.paid_no_show"],
		1
	);
	assert.deepEqual(update.$push, {
		reservationAuditLog: { type: "payment_correction" },
	});
});

test("reservation save middleware clears existing root edits but ignores comments and new docs", async () => {
	const hook = namedPreHook("save", "invalidateReconciliationOnSave");
	assert.equal(typeof hook, "function");

	const calls = [];
	await invokeMiddleware(hook, {
		isNew: false,
		directModifiedPaths: () => ["paid_amount_breakdown"],
		set: (path, value) => calls.push(["set", path, value]),
		markModified: (path) => calls.push(["markModified", path]),
	});
	assert.deepEqual(calls, [
		["set", RECONCILIATION_BREAKDOWN_ROOT, {}],
		["markModified", RECONCILIATION_BREAKDOWN_ROOT],
	]);

	for (const context of [
		{
			isNew: false,
			directModifiedPaths: () => [
				"paid_amount_breakdown.payment_comments",
			],
		},
		{
			isNew: true,
			directModifiedPaths: () => ["paid_amount_breakdown"],
		},
	]) {
		const unexpectedCalls = [];
		await invokeMiddleware(hook, {
			...context,
			set: (...args) => unexpectedCalls.push(["set", ...args]),
			markModified: (...args) =>
				unexpectedCalls.push(["markModified", ...args]),
		});
		assert.deepEqual(unexpectedCalls, []);
	}
});

test("save invalidation remains a narrow atomic write when reconciliation was not selected", async () => {
	const hook = namedPreHook("save", "invalidateReconciliationOnSave");
	const reservation = Reservations.hydrate(
		{
			_id: "64b000000000000000000001",
			confirmation_number: "invalidation-save-test",
			paid_amount_breakdown: { paid_at_hotel_cash: 10 },
		},
		{ payment_reconciliation: 0 }
	);
	assert.equal(reservation.isSelected("payment_reconciliation"), false);
	reservation.set("paid_amount_breakdown.paid_at_hotel_cash", 20);
	await invokeMiddleware(hook, reservation);
	const delta = reservation.$__delta()?.[1] || {};

	assert.equal(
		delta.$unset?.[
			"payment_reconciliation.breakdown.paid_at_hotel_cash"
		],
		1
	);
	assert.equal(delta.$set?.payment_reconciliation, undefined);
	assert.equal(
		delta.$set?.["payment_reconciliation.lastUpdatedAt"],
		undefined
	);

	const rootReservation = Reservations.hydrate(
		{
			_id: "64b000000000000000000002",
			confirmation_number: "invalidation-root-save-test",
			paid_amount_breakdown: { paid_at_hotel_cash: 10 },
		},
		{ payment_reconciliation: 0 }
	);
	rootReservation.set("paid_amount_breakdown", {
		paid_at_hotel_cash: 25,
		payment_comments: "corrected",
	});
	await invokeMiddleware(hook, rootReservation);
	const rootDelta = rootReservation.$__delta()?.[1] || {};
	assert.deepEqual(
		rootDelta.$set?.["payment_reconciliation.breakdown"],
		{}
	);
	assert.equal(rootDelta.$set?.payment_reconciliation, undefined);
});
