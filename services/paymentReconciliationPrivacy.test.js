/** @format */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
	sanitizeReservationAuditLogsCollectionForViewer,
	sanitizeReservationAuditLogsForViewer,
} = require("./auditPrivacy");

const CONFIGURED_ID = "64a000000000000000000001";
const OTHER_ADMIN_ID = "64a000000000000000000002";
const rawReservation = () => ({
	_id: "64a000000000000000000003",
	confirmation_number: "safe-confirmation",
	payment_reconciliation: {
		breakdown: {
			paid_at_hotel_cash: {
				status: "reconciled",
				amountCents: 10000,
				reconciledBy: { _id: CONFIGURED_ID, name: "Private Admin" },
				batchId: "private-batch",
				note: "private note",
			},
		},
	},
	adminChangeLog: [
		{ field: "safe_field", note: "safe audit" },
		{
			field: "payment_reconciliation",
			by: { _id: CONFIGURED_ID, name: "Private Admin" },
			batchId: "private-batch",
			note: "private note",
		},
	],
	reservationAuditLog: [
		{ type: "safe_type", note: "safe audit" },
		{
			type: "payment_reconciliation_status_update",
			by: { _id: CONFIGURED_ID, name: "Private Admin" },
			batchId: "private-batch",
			note: "private note",
		},
	],
});

test("audit sanitizer removes raw reconciliation from every non-configured viewer", () => {
	const previous = process.env.SUPER_ADMIN_ID;
	process.env.SUPER_ADMIN_ID = CONFIGURED_ID;
	try {
		for (const viewer of [
			{ role: "client" },
			{ _id: OTHER_ADMIN_ID, role: 1000 },
			{ _id: OTHER_ADMIN_ID, role: 8000 },
		]) {
			const sanitized = sanitizeReservationAuditLogsForViewer(
				rawReservation(),
				viewer
			);
			assert.equal(sanitized.confirmation_number, "safe-confirmation");
			assert.equal(sanitized.payment_reconciliation, undefined);
			assert.deepEqual(sanitized.adminChangeLog, [
				{ field: "safe_field", note: "safe audit" },
			]);
			assert.deepEqual(sanitized.reservationAuditLog, [
				{ type: "safe_type", note: "safe audit" },
			]);
		}

		const collection = sanitizeReservationAuditLogsCollectionForViewer(
			[rawReservation()],
			{ _id: OTHER_ADMIN_ID, role: 1000 }
		);
		assert.equal(collection[0].payment_reconciliation, undefined);
		assert.equal(collection[0].adminChangeLog.length, 1);
		assert.equal(collection[0].reservationAuditLog.length, 1);
	} finally {
		if (previous === undefined) delete process.env.SUPER_ADMIN_ID;
		else process.env.SUPER_ADMIN_ID = previous;
	}
});

test("only the configured super admin retains raw reconciliation audit metadata", () => {
	const previous = process.env.SUPER_ADMIN_ID;
	process.env.SUPER_ADMIN_ID = CONFIGURED_ID;
	try {
		const sanitized = sanitizeReservationAuditLogsForViewer(rawReservation(), {
			_id: CONFIGURED_ID,
			role: 1000,
		});
		assert.equal(
			sanitized.payment_reconciliation.breakdown.paid_at_hotel_cash.batchId,
			"private-batch"
		);
		assert.equal(sanitized.adminChangeLog[1].batchId, "private-batch");
		assert.equal(
			sanitized.reservationAuditLog[1].note,
			"private note"
		);
	} finally {
		if (previous === undefined) delete process.env.SUPER_ADMIN_ID;
		else process.env.SUPER_ADMIN_ID = previous;
	}
});
