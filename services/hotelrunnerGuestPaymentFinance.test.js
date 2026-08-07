/** @format */

"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
	guardDirectHotelRunnerGuestPaymentCommissionSet,
} = require("./hotelrunnerGuestPaymentFinance");
const {
	HOTELRUNNER_PLATFORM_FINANCE_REASONS,
} = require("./hotelrunnerPlatformFinance");

const directHotelRunnerReservation = (overrides = {}) => ({
	supplierData: {
		hotelRunner: {
			transport: "hotelrunner_api",
			reservationId: "R-GUEST-PAYMENT-1",
		},
		otaSourceAuthority: 4,
		otaAutomationPipeline: "hotelrunner-background-worker",
	},
	adminPricing: { mode: "hotelrunner_api" },
	...overrides,
});

test("non-HotelRunner guest payments retain legacy commission-paid behaviour", () => {
	const set = {
		payment: "paid online",
		commissionPaid: true,
		commissionStatus: "commission paid",
		commissionPaidAt: new Date("2026-08-06T23:00:00.000Z"),
		financeStatus: "paid",
	};
	const result = guardDirectHotelRunnerGuestPaymentCommissionSet({
		reservation: { booking_source: "website" },
		set,
	});

	assert.equal(result.isDirectHotelRunner, false);
	assert.equal(result.suppressed, false);
	assert.deepEqual(result.set, set);
	assert.notEqual(result.set, set);
});

test("unreviewed direct HotelRunner guest payment keeps payment state but suppresses commission settlement", () => {
	const set = {
		"payment_details.captured": true,
		"payment_details.finalCaptureTransactionId": "CAPTURE-1",
		payment: "paid online",
		commissionPaid: true,
		commissionStatus: "commission paid",
		commissionPaidAt: new Date("2026-08-06T23:00:00.000Z"),
		financeStatus: "paid",
	};
	const result = guardDirectHotelRunnerGuestPaymentCommissionSet({
		reservation: directHotelRunnerReservation(),
		set,
	});

	assert.equal(result.isDirectHotelRunner, true);
	assert.equal(result.commissionAvailable, false);
	assert.equal(result.suppressed, true);
	assert.equal(
		result.reason,
		HOTELRUNNER_PLATFORM_FINANCE_REASONS.UNREVIEWED
	);
	assert.deepEqual(result.set, {
		"payment_details.captured": true,
		"payment_details.finalCaptureTransactionId": "CAPTURE-1",
		payment: "paid online",
		financeStatus: "paid",
	});
	assert.equal(set.commissionPaid, true, "the caller's set object is not mutated");
});

test("reviewed direct HotelRunner commission, including zero, passes the canonical gate", () => {
	for (const amount of [0, 25.5]) {
		const result = guardDirectHotelRunnerGuestPaymentCommissionSet({
			reservation: directHotelRunnerReservation({
				commission: amount,
				commissionData: {
					assigned: true,
					amount,
					commissionAmount: amount,
					commissionValue: amount,
				},
				financial_cycle: {
					commissionAssigned: true,
					commissionAmount: amount,
					commissionValue: amount,
				},
			}),
			set: {
				payment: "deposit paid",
				commissionPaid: true,
				financeStatus: "authorized",
			},
		});

		assert.equal(result.commissionAvailable, true);
		assert.equal(result.suppressed, false);
		assert.equal(result.set.commissionPaid, true);
	}
});

test("conflicting direct HotelRunner commission evidence fails closed", () => {
	const result = guardDirectHotelRunnerGuestPaymentCommissionSet({
		reservation: directHotelRunnerReservation({
			commission: 25,
			commissionData: { assigned: true, amount: 25 },
			financial_cycle: {
				commissionAssigned: true,
				commissionAmount: 30,
			},
		}),
		set: { payment: "paid online", commissionPaid: true },
	});

	assert.equal(result.suppressed, true);
	assert.equal(
		result.reason,
		HOTELRUNNER_PLATFORM_FINANCE_REASONS.CONFLICT
	);
	assert.equal(result.set.payment, "paid online");
	assert.equal("commissionPaid" in result.set, false);
});

test("every existing-reservation PayPal authorization and capture path uses the guard", () => {
	const source = fs.readFileSync(
		path.join(__dirname, "..", "controllers", "paypal_reservation.js"),
		"utf8"
	);
	const section = (start, end) => {
		const from = source.indexOf(start);
		const to = source.indexOf(end, from + start.length);
		assert.notEqual(from, -1, `missing ${start}`);
		assert.notEqual(to, -1, `missing ${end}`);
		return source.slice(from, to);
	};
	const occurrences = (value, pattern) => (value.match(pattern) || []).length;

	const webhookCapture = section(
		"async function reconcileLinkPendingReviewCapture",
		"async function releasePendingReviewCapture"
	);
	assert.equal(
		occurrences(
			webhookCapture,
			/guardDirectHotelRunnerGuestPaymentCommissionSet\s*\(/g
		),
		1
	);
	assert.match(webhookCapture, /\$set:\s*guardedSetAfter/);

	const merchantInitiatedCapture = section(
		"exports.mitChargeReservation = async",
		"exports.creditPrecheck = async"
	);
	assert.equal(
		occurrences(
			merchantInitiatedCapture,
			/guardDirectHotelRunnerGuestPaymentCommissionSet\s*\(/g
		),
		1
	);
	assert.match(merchantInitiatedCapture, /reservation:\s*updated\s*\|\|\s*r/);
	assert.match(merchantInitiatedCapture, /\$set:\s*paymentStateSet/);

	const paymentLink = section(
		"exports.linkPayReservation = async",
		"exports.getReservationVccStatus = async"
	);
	assert.equal(
		occurrences(
			paymentLink,
			/guardDirectHotelRunnerGuestPaymentCommissionSet\s*\(/g
		),
		2,
		"payment-link authorization and capture must each be guarded"
	);
	assert.match(paymentLink, /\$set:\s*guardedSetOps/);
	assert.match(paymentLink, /\$set:\s*paymentStateSet/);
});
