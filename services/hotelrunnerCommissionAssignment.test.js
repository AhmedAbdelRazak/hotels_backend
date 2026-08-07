/** @format */

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
	buildTrustedDirectHotelRunnerCommissionAssignment,
	normalizeExplicitHotelRunnerCommission,
	stripUntrustedDirectHotelRunnerFinanceFields,
} = require("./hotelrunnerCommissionAssignment");
const {
	resolveHotelRunnerPlatformCommission,
} = require("./hotelrunnerPlatformFinance");

test("HotelRunner commission parsing accepts only explicit non-negative cents", () => {
	assert.equal(normalizeExplicitHotelRunnerCommission("1,025.50"), 1025.5);
	assert.equal(normalizeExplicitHotelRunnerCommission(0), 0);
	for (const invalid of [null, undefined, "", true, -1, "1.001", Infinity, {}]) {
		assert.equal(normalizeExplicitHotelRunnerCommission(invalid), null);
	}
});

test("trusted HotelRunner assignment overwrites stale aliases with one atomic consensus", () => {
	const assignedAt = new Date("2026-08-06T22:00:00.000Z");
	const existing = {
		commission: 10,
		commissionStatus: "commission due",
		adminPricing: { mode: "hotelrunner_api", commissionAmount: 10 },
		supplierData: {
			hotelRunner: {
				transport: "hotelrunner_api",
				reservationId: "R-ASSIGNMENT-1",
			},
			otaAutomationPipeline: "hotelrunner-background-worker",
		},
		commissionData: {
			assigned: true,
			amount: 10,
			commissionAmount: 11,
			commissionValue: 12,
			history: ["preserved"],
		},
		financial_cycle: {
			status: "open",
			commissionAssigned: true,
			commissionAmount: 13,
			commissionValue: 14,
		},
	};
	const update = buildTrustedDirectHotelRunnerCommissionAssignment({
		update: {
			commissionStatus: "commission due",
			financial_cycle: { notes: "reviewed" },
		},
		existingReservation: existing,
		amount: "25.50",
		actorId: "configured-super-admin",
		assignedAt,
	});

	assert.equal(update.commission, 25.5);
	assert.equal(update.adminPricing.commissionAmount, 25.5);
	assert.deepEqual(update.commissionData.history, ["preserved"]);
	for (const value of [
		update.commissionData.amount,
		update.commissionData.commissionAmount,
		update.commissionData.commissionValue,
		update.financial_cycle.commissionAmount,
		update.financial_cycle.commissionValue,
	]) {
		assert.equal(value, 25.5);
	}
	assert.equal(update.commissionData.assigned, true);
	assert.equal(update.financial_cycle.commissionAssigned, true);
	assert.equal(update.commissionData.assignedBy, "configured-super-admin");
	assert.equal(
		update.financial_cycle.commissionAssignedBy,
		"configured-super-admin"
	);
	assert.equal(update.commissionData.assignedAt, assignedAt);
	assert.equal(update.financial_cycle.commissionAssignedAt, assignedAt);

	const resolved = resolveHotelRunnerPlatformCommission({
		...existing,
		...update,
	});
	assert.equal(resolved.available, true);
	assert.equal(resolved.amount, 25.5);
});

test("public HotelRunner edits strip all server-owned finance roots and dotted aliases", () => {
	const payload = {
		comment: "keep guest note",
		commission: 25,
		commissionData: { assigned: true },
		"commissionData.amount": 25,
		commissionPaid: true,
		commissionStatus: "commission paid",
		commissionAgentApproval: { status: "approved" },
		financial_cycle: { commissionAssigned: true },
		"financial_cycle.commissionAmount": 25,
		adminPricing: { commissionAmount: 25 },
		"adminPricing.commissionAmount": 25,
		moneyTransferredToHotel: true,
	};

	assert.deepEqual(stripUntrustedDirectHotelRunnerFinanceFields(payload), {
		comment: "keep guest note",
	});
});
