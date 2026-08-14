/** @format */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Reservations = require("../models/reservations");
const {
	PAYMENT_BREAKDOWN_KEYS,
	PaymentReconciliationError,
	buildPaymentBreakdownSelectionFilter,
	buildReconciliationStatusFilter,
	effectivePaymentReconciliation,
	effectivelyReconciledExpression,
	moneyToCents,
	normalizePaymentBreakdownKeys,
	normalizeReconciliationStatus,
	paymentAmountCents,
	paymentAmountCentsExpression,
	resolveCompletePricingBreakdownClientTotal,
	summarizeReconciliationReservations,
	summarizeReservationReconciliation,
} = require("./paymentReconciliation");

test("reservation reconciliation defaults empty and is private from ordinary reads", () => {
	const schemaPath = Reservations.schema.path("payment_reconciliation");
	assert.equal(schemaPath.options.select, false);
	const first = new Reservations();
	const second = new Reservations();
	assert.deepEqual(first.payment_reconciliation, {
		breakdown: {},
		lastUpdatedAt: null,
		lastUpdatedBy: null,
		lastBatchId: "",
	});
	first.payment_reconciliation.breakdown.paid_at_hotel_cash = {
		status: "reconciled",
	};
	assert.deepEqual(second.payment_reconciliation.breakdown, {});
});

test("payment reconciliation exposes exactly the eight supported breakdown keys", () => {
	assert.deepEqual(PAYMENT_BREAKDOWN_KEYS, [
		"paid_online_via_link",
		"paid_at_hotel_cash",
		"paid_at_hotel_card",
		"paid_to_hotel",
		"paid_online_jannatbooking",
		"paid_online_other_platforms",
		"paid_online_via_instapay",
		"paid_no_show",
	]);
	assert.deepEqual(
		normalizePaymentBreakdownKeys("paid_at_hotel_cash,paid_at_hotel_card"),
		["paid_at_hotel_cash", "paid_at_hotel_card"]
	);
	assert.deepEqual(
		normalizePaymentBreakdownKeys([
			"paid_at_hotel_card",
			"paid_at_hotel_card",
		]),
		["paid_at_hotel_card"]
	);
	for (const injected of [
		"$where",
		"paid_at_hotel_cash.$gt",
		"__proto__",
		["paid_at_hotel_cash", "$expr"],
		{ $gt: "" },
	]) {
		assert.throws(
			() => normalizePaymentBreakdownKeys(injected),
			(error) =>
				error instanceof PaymentReconciliationError &&
				error.statusCode === 400
		);
	}
	assert.throws(
		() => normalizeReconciliationStatus("partially_reconciled"),
		PaymentReconciliationError
	);
});

test("legacy, missing, and stale snapshots are waiting", () => {
	const legacy = {
		paid_amount_breakdown: { paid_at_hotel_cash: 72.85 },
	};
	assert.equal(
		effectivePaymentReconciliation(legacy, "paid_at_hotel_cash").status,
		"waiting"
	);

	const stale = {
		...legacy,
		payment_reconciliation: {
			breakdown: {
				paid_at_hotel_cash: {
					status: "reconciled",
					amountCents: 7000,
				},
			},
		},
	};
	const effective = effectivePaymentReconciliation(
		stale,
		"paid_at_hotel_cash"
	);
	assert.equal(effective.status, "waiting");
	assert.equal(effective.stale, true);
	assert.equal(effective.amountCents, 7285);

	const malformedSnapshot = {
		...legacy,
		payment_reconciliation: {
			breakdown: {
				paid_at_hotel_cash: {
					status: "reconciled",
					amountCents: "7285",
				},
			},
		},
	};
	assert.equal(
		effectivePaymentReconciliation(
			malformedSnapshot,
			"paid_at_hotel_cash"
		).status,
		"waiting"
	);
});

test("multi-category rows require any positive amount but reconcile every selected positive amount", () => {
	const reservation = {
		paid_amount_breakdown: {
			paid_at_hotel_cash: 100,
			paid_at_hotel_card: 0,
			paid_online_other_platforms: 50,
		},
		payment_reconciliation: {
			breakdown: {
				paid_at_hotel_cash: {
					status: "reconciled",
					amountCents: 10000,
				},
			},
		},
	};
	const cashAndZeroCard = summarizeReservationReconciliation(reservation, [
		"paid_at_hotel_cash",
		"paid_at_hotel_card",
	]);
	assert.deepEqual(cashAndZeroCard.selectedPositiveKeys, ["paid_at_hotel_cash"]);
	assert.equal(cashAndZeroCard.reconciliationStatus, "reconciled");

	const cashAndOnline = summarizeReservationReconciliation(reservation, [
		"paid_at_hotel_cash",
		"paid_online_other_platforms",
	]);
	assert.equal(cashAndOnline.reconciliationStatus, "waiting");
	assert.equal(cashAndOnline.reconciledAmountCents, 10000);
	assert.equal(cashAndOnline.waitingAmountCents, 5000);

	const selection = buildPaymentBreakdownSelectionFilter([
		"paid_at_hotel_cash",
		"paid_at_hotel_card",
	]);
	assert.equal(selection.$expr.$or.length, 2);
	assert.deepEqual(
		selection.$expr.$or[0].$gt[0],
		paymentAmountCentsExpression("paid_at_hotel_cash")
	);
	assert.equal(selection.$expr.$or[0].$gt[1], 0);
});

test("Mongo inclusion and status filters use rounded cents for positivity", () => {
	const key = "paid_at_hotel_cash";
	const cents = paymentAmountCentsExpression(key);
	const selection = buildPaymentBreakdownSelectionFilter([key]);
	assert.deepEqual(selection.$expr.$or[0], { $gt: [cents, 0] });

	const reconciled = effectivelyReconciledExpression(key);
	assert.deepEqual(reconciled.$and[0], { $gt: [cents, 0] });

	const waiting = buildReconciliationStatusFilter([key], "waiting");
	const [anyPositive, notEveryReconciled] = waiting.$expr.$and;
	assert.deepEqual(anyPositive.$or[0], { $gt: [cents, 0] });
	assert.deepEqual(notEveryReconciled.$not[0].$and[0].$or[0], {
		$lte: [cents, 0],
	});

	assert.equal(paymentAmountCents({ paid_amount_breakdown: { [key]: 0.004 } }, key), 0);
});

test("scorecard cents always reconcile exactly", () => {
	const rows = [
		{
			paid_amount_breakdown: {
				paid_at_hotel_cash: 19.99,
				paid_at_hotel_card: 10.01,
			},
			payment_reconciliation: {
				breakdown: {
					paid_at_hotel_cash: {
						status: "reconciled",
						amountCents: 1999,
					},
				},
			},
		},
		{
			paid_amount_breakdown: { paid_at_hotel_cash: 0.1 },
		},
	];
	const summary = summarizeReconciliationReservations(rows, [
		"paid_at_hotel_cash",
		"paid_at_hotel_card",
	]);
	assert.equal(summary.totalAmountCents, 3010);
	assert.equal(summary.reconciledAmountCents, 1999);
	assert.equal(summary.waitingAmountCents, 1011);
	assert.equal(
		summary.reconciledAmountCents + summary.waitingAmountCents,
		summary.totalAmountCents
	);
	assert.equal(summary.reservationsCount, 2);
	assert.equal(summary.reconciledReservationsCount, 0);
	assert.equal(summary.waitingReservationsCount, 2);
});

test("Mongo cents expression mirrors JavaScript half-cent rounding", () => {
	assert.equal(moneyToCents(10.005), 1001);

	const expression = paymentAmountCentsExpression("paid_at_hotel_cash");
	assert.equal(expression.$convert.to, "long");
	assert.deepEqual(expression.$convert.onError, 0);
	assert.deepEqual(expression.$convert.onNull, 0);
	assert.ok(expression.$convert.input.$cond[1].$floor);
	assert.equal(JSON.stringify(expression).includes('"$round"'), false);
});

test("daily pricing client total is independent, complete, and count aware", () => {
	const resolved = resolveCompletePricingBreakdownClientTotal({
		checkin_date: "2026-08-10T00:00:00.000Z",
		checkout_date: "2026-08-12T00:00:00.000Z",
		total_amount: 9999,
		pickedRoomsPricing: [
			{
				count: 2,
				pricingByDay: [
					{ date: "2026-08-10", clientPrice: 100.25 },
					{ date: "2026-08-11", totalPriceWithCommission: 120.75 },
				],
			},
		],
	});
	assert.deepEqual(resolved, {
		available: true,
		amount: 442,
		amountCents: 44200,
		currency: "SAR",
		source: "pickedRoomsPricing.pricingByDay",
		reason: "",
	});

	const incomplete = resolveCompletePricingBreakdownClientTotal({
		checkin_date: "2026-08-10",
		checkout_date: "2026-08-12",
		pickedRoomsType: [
			{
				count: 1,
				pricingByDay: [{ date: "2026-08-10", price: 100 }],
			},
		],
	});
	assert.equal(incomplete.available, false);
	assert.equal(incomplete.amount, null);
	assert.equal(incomplete.reason, "incomplete_stay_daily_pricing");

	const completeFallback = resolveCompletePricingBreakdownClientTotal({
		checkin_date: "2026-08-10",
		checkout_date: "2026-08-12",
		pickedRoomsPricing: [
			{ count: 1, pricingByDay: [{ date: "2026-08-10", price: 999 }] },
		],
		pickedRoomsType: [
			{
				count: 1,
				pricingByDay: [
					{ date: "2026-08-10", price: 100 },
					{ date: "2026-08-11", price: 110 },
				],
			},
		],
	});
	assert.equal(completeFallback.available, true);
	assert.equal(completeFallback.amountCents, 21000);
	assert.equal(
		completeFallback.source,
		"pickedRoomsType.pricingByDay"
	);
});
