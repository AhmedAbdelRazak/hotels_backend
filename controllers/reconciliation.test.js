/** @format */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");
const Reservations = require("../models/reservations");
const PaymentReconciliationBatch = require("../models/payment_reconciliation_batch");
const reconciliationAttachment = require("../services/reconciliationAttachment");
const {
	_private,
	closestReconciliationMatch,
	reconciliationReport,
	updateReconciliationStatus,
} = require("./reconciliation");
const {
	paymentAmountCentsExpression,
} = require("../services/paymentReconciliation");

const USER_ID = "64a000000000000000000001";
const HOTEL_ID = "64a000000000000000000002";
const OTHER_HOTEL_ID = "64a000000000000000000099";
const RESERVATION_ID = "64a000000000000000000003";
const UPDATED_AT = new Date("2026-08-14T10:00:00.000Z");

const response = () => ({
	statusCode: 200,
	payload: null,
	status(code) {
		this.statusCode = code;
		return this;
	},
	json(payload) {
		this.payload = payload;
		return payload;
	},
});

const superAdminRequest = (body = {}) => ({
	auth: { _id: USER_ID },
	profile: {
		_id: USER_ID,
		name: "Configured Admin",
		email: "admin@example.com",
		activeUser: true,
		role: 1000,
	},
	body,
});

const validSnapshot = (overrides = {}) => ({
	reservationId: RESERVATION_ID,
	__v: 2,
	updatedAt: UPDATED_AT.toISOString(),
	displayedAmountsCents: { paid_at_hotel_cash: 1234 },
	...overrides,
});

const validBody = (overrides = {}) => ({
	hotelId: HOTEL_ID,
	action: "reconcile",
	status: "reconciled",
	paymentBreakdownKeys: ["paid_at_hotel_cash"],
	payoutPurpose: "paid_out_to_zad",
	comment: "Payout batch 42",
	expectedActionAmountCents: 1234,
	reservations: [validSnapshot()],
	...overrides,
});

const currentReservation = (overrides = {}) => ({
	_id: RESERVATION_ID,
	hotelId: HOTEL_ID,
	__v: 2,
	updatedAt: UPDATED_AT,
	paid_amount_breakdown: { paid_at_hotel_cash: 12.34 },
	payment_reconciliation: { breakdown: {} },
	...overrides,
});

const withSuperAdminEnvironment = async (callback) => {
	const previousServer = process.env.SUPER_ADMIN_ID;
	const previousClient = process.env.REACT_APP_SUPER_ADMIN_ID;
	process.env.SUPER_ADMIN_ID = USER_ID;
	delete process.env.REACT_APP_SUPER_ADMIN_ID;
	try {
		await callback();
	} finally {
		if (previousServer === undefined) delete process.env.SUPER_ADMIN_ID;
		else process.env.SUPER_ADMIN_ID = previousServer;
		if (previousClient === undefined) {
			delete process.env.REACT_APP_SUPER_ADMIN_ID;
		} else {
			process.env.REACT_APP_SUPER_ADMIN_ID = previousClient;
		}
	}
};

test("closest-match reservation priority follows the reconciliation business order", () => {
	assert.deepEqual(
		[
			"checked_out",
			"inhouse",
			"no_show",
			"confirmed",
			"pending",
		].map(_private.closestMatchReservationPriority),
		[0, 1, 2, 3, 4]
	);
	assert.equal(_private.closestMatchReservationPriority("checked out"), 0);
	assert.equal(_private.closestMatchReservationPriority("no-show"), 2);
});

const mockMutationReads = (rows) => {
	const originalFind = Reservations.find;
	const originalBatchCreate = PaymentReconciliationBatch.create;
	const originalBatchUpdateOne = PaymentReconciliationBatch.updateOne;
	const created = [];
	const finalized = [];
	Reservations.find = () => ({
		select() {
			return this;
		},
		lean: async () => rows,
	});
	PaymentReconciliationBatch.create = async (payload) => {
		created.push(payload);
		return payload;
	};
	PaymentReconciliationBatch.updateOne = async (filter, update) => {
		finalized.push({ filter, update });
		return { matchedCount: 1, modifiedCount: 1 };
	};
	const restore = () => {
		Reservations.find = originalFind;
		PaymentReconciliationBatch.create = originalBatchCreate;
		PaymentReconciliationBatch.updateOne = originalBatchUpdateOne;
	};
	restore.created = created;
	restore.finalized = finalized;
	return restore;
};

const completedBatchState = (overrides = {}) => ({
	status: "complete",
	appliedAmountCents: 1234,
	appliedReservationCount: 1,
	appliedItemCount: 1,
	appliedItems: [
		{
			reservationId: RESERVATION_ID,
			paymentBreakdownKey: "paid_at_hotel_cash",
			amountCents: 1234,
			from: "waiting",
			to: "reconciled",
		},
	],
	completedAt: new Date("2026-08-14T12:00:00.000Z"),
	...overrides,
});

test("batch finalization accepts a transient ambiguous write only after exact state verification", async () => {
	const originalUpdateOne = PaymentReconciliationBatch.updateOne;
	const originalFindOne = PaymentReconciliationBatch.findOne;
	const intended = completedBatchState();
	let persisted = null;
	let updateCalls = 0;
	let readCalls = 0;
	let observedFilter = null;
	PaymentReconciliationBatch.updateOne = async (filter, update) => {
		updateCalls += 1;
		observedFilter = filter;
		persisted = { ...update.$set };
		throw new Error("network response lost after commit");
	};
	PaymentReconciliationBatch.findOne = (filter) => ({
		select() {
			return this;
		},
		async lean() {
			readCalls += 1;
			assert.deepEqual(filter, { batchId: "batch-transient" });
			return persisted;
		},
	});
	try {
		await _private.finalizePaymentReconciliationBatch(
			"batch-transient",
			intended
		);
		assert.equal(updateCalls, 1);
		assert.equal(readCalls, 1);
		assert.deepEqual(observedFilter, {
			batchId: "batch-transient",
			status: "applying",
		});
	} finally {
		PaymentReconciliationBatch.updateOne = originalUpdateOne;
		PaymentReconciliationBatch.findOne = originalFindOne;
	}
});

test("batch finalization stops after three attempts when final state cannot be verified", async () => {
	const originalUpdateOne = PaymentReconciliationBatch.updateOne;
	const originalFindOne = PaymentReconciliationBatch.findOne;
	let updateCalls = 0;
	let readCalls = 0;
	PaymentReconciliationBatch.updateOne = async () => {
		updateCalls += 1;
		return { matchedCount: 0, modifiedCount: 0 };
	};
	PaymentReconciliationBatch.findOne = () => ({
		select() {
			return this;
		},
		async lean() {
			readCalls += 1;
			return completedBatchState({
				status: "partial",
				appliedAmountCents: 1200,
			});
		},
	});
	try {
		await assert.rejects(
			_private.finalizePaymentReconciliationBatch(
				"batch-permanent-failure",
				completedBatchState()
			),
			/after 3 attempts/
		);
		assert.equal(updateCalls, 3);
		assert.equal(readCalls, 3);
	} finally {
		PaymentReconciliationBatch.updateOne = originalUpdateOne;
		PaymentReconciliationBatch.findOne = originalFindOne;
	}
});

test("mutation requires the configured active super admin before any database read", async () => {
	const previousServer = process.env.SUPER_ADMIN_ID;
	process.env.SUPER_ADMIN_ID = "64a000000000000000000088";
	const originalFind = Reservations.find;
	let reads = 0;
	Reservations.find = () => {
		reads += 1;
		throw new Error("unexpected read");
	};
	try {
		const res = response();
		await updateReconciliationStatus(
			superAdminRequest(validBody()),
			res
		);
		assert.equal(res.statusCode, 403);
		assert.equal(res.payload.code, "reconciliation_super_admin_required");
		assert.equal(reads, 0);
	} finally {
		Reservations.find = originalFind;
		if (previousServer === undefined) delete process.env.SUPER_ADMIN_ID;
		else process.env.SUPER_ADMIN_ID = previousServer;
	}
});

test("mutation rejects unknown keys, duplicates, bad statuses, and oversized requests before reads", async () => {
	await withSuperAdminEnvironment(async () => {
		const originalFind = Reservations.find;
		let reads = 0;
		Reservations.find = () => {
			reads += 1;
			throw new Error("unexpected read");
		};
		try {
			const cases = [
				{
					body: validBody({ paymentBreakdownKeys: ["$where"] }),
					status: 400,
					code: "invalid_payment_breakdown_key",
				},
				{
					body: validBody({ status: "partial" }),
					status: 400,
					code: "invalid_reconciliation_status",
				},
				{
					body: validBody({ payoutPurpose: "client_supplied_other" }),
					status: 400,
					code: "invalid_reconciliation_payout_purpose",
				},
				{
					body: validBody({ comment: "x".repeat(1001) }),
					status: 400,
					code: "reconciliation_comment_too_long",
				},
				{
					body: validBody({ expectedActionAmountCents: 12.34 }),
					status: 400,
					code: "invalid_expected_action_amount_cents",
				},
				{
					body: validBody({ attachment: { url: "https://attacker.invalid" } }),
					status: 400,
					code: "untrusted_reconciliation_attachment",
				},
				{
					body: validBody({
						reservations: [validSnapshot(), validSnapshot()],
					}),
					status: 400,
					code: "duplicate_reservation_id",
				},
				{
					body: validBody({
						reservations: Array.from({ length: 501 }, (_, index) => ({
							...validSnapshot(),
							reservationId: (index + 1).toString(16).padStart(24, "0"),
						})),
					}),
					status: 413,
					code: "reconciliation_batch_too_large",
				},
			];
			for (const item of cases) {
				const res = response();
				await updateReconciliationStatus(
					superAdminRequest(item.body),
					res
				);
				assert.equal(res.statusCode, item.status);
				assert.equal(res.payload.code, item.code);
			}
			assert.equal(reads, 0);
		} finally {
			Reservations.find = originalFind;
		}
	});
});

test("confirmed action cents are checked before batch creation or reservation writes", async () => {
	await withSuperAdminEnvironment(async () => {
		const restoreFind = mockMutationReads([currentReservation()]);
		const originalUpdateOne = Reservations.updateOne;
		let writes = 0;
		Reservations.updateOne = async () => {
			writes += 1;
			return { matchedCount: 1 };
		};
		try {
			const res = response();
			await updateReconciliationStatus(
				superAdminRequest(
					validBody({ expectedActionAmountCents: 1200 })
				),
				res
			);
			assert.equal(res.statusCode, 409);
			assert.equal(res.payload.code, "reconciliation_confirmed_amount_changed");
			assert.equal(res.payload.serverActionAmountCents, 1234);
			assert.equal(writes, 0);
			assert.equal(restoreFind.created.length, 0);
		} finally {
			restoreFind();
			Reservations.updateOne = originalUpdateOne;
		}
	});
});

test("multipart reconciliation uploads one verified attachment and stores no URL", async () => {
	await withSuperAdminEnvironment(async () => {
		const restoreFind = mockMutationReads([currentReservation()]);
		const originalUpdateOne = Reservations.updateOne;
		const originalUpload =
			reconciliationAttachment.uploadReconciliationAttachment;
		let uploads = 0;
		Reservations.updateOne = async () => ({ matchedCount: 1, modifiedCount: 1 });
		reconciliationAttachment.uploadReconciliationAttachment = async () => {
			uploads += 1;
			return {
				publicId: "private/reconciliation-proof",
				resourceType: "image",
				format: "png",
				version: 1,
				bytes: 8,
				originalName: "proof.png",
				mimeType: "image/png",
				uploadedAt: new Date(),
			};
		};
		try {
			const req = superAdminRequest({ payload: JSON.stringify(validBody()) });
			req.file = {
				originalname: "proof.png",
				mimetype: "image/png",
				buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			};
			const res = response();
			await updateReconciliationStatus(req, res);
			assert.equal(res.statusCode, 200);
			assert.equal(uploads, 1);
			assert.equal(restoreFind.created.length, 1);
			assert.equal(
				restoreFind.created[0].attachment.publicId,
				"private/reconciliation-proof"
			);
			assert.equal(restoreFind.created[0].attachment.url, undefined);
		} finally {
			restoreFind();
			Reservations.updateOne = originalUpdateOne;
			reconciliationAttachment.uploadReconciliationAttachment = originalUpload;
		}
	});
});

test("an uploaded attachment is cleaned up when the applying batch cannot be created", async () => {
	await withSuperAdminEnvironment(async () => {
		const restoreFind = mockMutationReads([currentReservation()]);
		const originalUpdateOne = Reservations.updateOne;
		const originalUpload =
			reconciliationAttachment.uploadReconciliationAttachment;
		const originalRemove =
			reconciliationAttachment.removeReconciliationAttachment;
		const originalConsoleError = console.error;
		let writes = 0;
		let removals = 0;
		Reservations.updateOne = async () => {
			writes += 1;
			return { matchedCount: 1 };
		};
		reconciliationAttachment.uploadReconciliationAttachment = async () => ({
			publicId: "private/cleanup-proof",
			resourceType: "image",
			bytes: 8,
			originalName: "proof.png",
			mimeType: "image/png",
			uploadedAt: new Date(),
		});
		reconciliationAttachment.removeReconciliationAttachment = async () => {
			removals += 1;
			return true;
		};
		PaymentReconciliationBatch.create = async () => {
			throw new Error("batch unavailable");
		};
		console.error = () => {};
		try {
			const req = superAdminRequest({ payload: JSON.stringify(validBody()) });
			req.file = {
				originalname: "proof.png",
				mimetype: "image/png",
				buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
			};
			const res = response();
			await updateReconciliationStatus(req, res);
			assert.equal(res.statusCode, 500);
			assert.equal(removals, 1);
			assert.equal(writes, 0);
		} finally {
			restoreFind();
			Reservations.updateOne = originalUpdateOne;
			reconciliationAttachment.uploadReconciliationAttachment = originalUpload;
			reconciliationAttachment.removeReconciliationAttachment = originalRemove;
			console.error = originalConsoleError;
		}
	});
});

test("mutation uses server-derived cents and writes only reconciliation, audit, timestamp, and version paths", async () => {
	await withSuperAdminEnvironment(async () => {
		const restoreFind = mockMutationReads([currentReservation()]);
		const originalUpdateOne = Reservations.updateOne;
		let observed = null;
		Reservations.updateOne = async (filter, update, options) => {
			observed = { filter, update, options };
			return { matchedCount: 1, modifiedCount: 1 };
		};
		try {
			const body = validBody({
				actor: { _id: "attacker", name: "Attacker" },
				comment: "Payout batch 42",
			});
			const res = response();
			await updateReconciliationStatus(superAdminRequest(body), res);

			assert.equal(res.statusCode, 200);
			assert.equal(res.payload.updatedCount, 1);
			assert.deepEqual(res.payload.updated, [RESERVATION_ID]);
			assert.equal(String(observed.filter._id), RESERVATION_ID);
			assert.equal(String(observed.filter.hotelId), HOTEL_ID);
			assert.equal(observed.filter.__v, 2);
			assert.equal(observed.filter.updatedAt, UPDATED_AT);
			assert.deepEqual(
				observed.filter["paid_amount_breakdown.paid_at_hotel_cash"],
				{ $eq: 12.34 }
			);
			assert.ok(observed.filter.$expr.$and[0].$gt[0].$convert);
			assert.equal(observed.filter.$expr.$and[0].$gt[1], 0);
			assert.deepEqual(observed.filter["otaPlatformReview.status"], {
				$ne: "pending",
			});
			assert.ok(observed.filter.reservation_status.$not.test("cancelled"));
			assert.equal(observed.filter.reservation_status.$not.test("confirmed"), false);
			assert.ok(observed.filter.state.$not.test("canceled"));
			assert.deepEqual(observed.update.$inc, { __v: 1 });
			assert.deepEqual(observed.options, { timestamps: false });

			const setPaths = Object.keys(observed.update.$set);
			assert.ok(
				setPaths.every(
					(path) => path === "updatedAt" || path.startsWith("payment_reconciliation.")
				)
			);
			const entry =
				observed.update.$set[
					"payment_reconciliation.breakdown.paid_at_hotel_cash"
				];
			assert.equal(entry.amountCents, 1234);
			assert.equal(entry.status, "reconciled");
			assert.equal(entry.reconciledBy.name, "Configured Admin");
			assert.notEqual(entry.reconciledBy.name, "Attacker");
			assert.equal(entry.note, undefined);
			assert.equal(restoreFind.created.length, 1);
			assert.equal(restoreFind.created[0].payoutPurpose, "paid_out_to_zad");
			assert.equal(restoreFind.created[0].comment, "Payout batch 42");
			assert.equal(restoreFind.created[0].plannedAmountCents, 1234);
			assert.equal(restoreFind.created[0].attachment, null);
			assert.equal(restoreFind.finalized.length, 1);
			assert.equal(
				restoreFind.finalized[0].update.$set.appliedAmountCents,
				1234
			);
			assert.deepEqual(Object.keys(observed.update.$push).sort(), [
				"adminChangeLog",
				"reservationAuditLog",
			]);
			for (const forbidden of [
				"paid_amount_breakdown",
				"total_amount",
				"pickedRoomsType",
				"customer_details",
				"reservation_status",
				"commission",
				"financial_cycle",
			]) {
				assert.equal(observed.update.$set[forbidden], undefined);
			}
		} finally {
			restoreFind();
			Reservations.updateOne = originalUpdateOne;
		}
	});
});

test("marking a mixed reservation reconciled preserves provenance for categories already effectively reconciled", async () => {
	await withSuperAdminEnvironment(async () => {
		const originalCashProvenance = {
			status: "reconciled",
			amountCents: 1234,
			reconciledAt: new Date("2026-08-10T08:00:00.000Z"),
			reconciledBy: { _id: USER_ID, name: "Original Admin" },
			updatedAt: new Date("2026-08-10T08:00:00.000Z"),
			updatedBy: { _id: USER_ID, name: "Original Admin" },
			batchId: "original-cash-batch",
			note: "Original cash payout",
		};
		const restoreFind = mockMutationReads([
			currentReservation({
				paid_amount_breakdown: {
					paid_at_hotel_cash: 12.34,
					paid_at_hotel_card: 45.67,
				},
				payment_reconciliation: {
					breakdown: {
						paid_at_hotel_cash: originalCashProvenance,
						paid_at_hotel_card: {
							status: "waiting",
							amountCents: 4567,
							batchId: "original-card-batch",
							note: "Awaiting card payout",
						},
					},
				},
			}),
		]);
		const originalUpdateOne = Reservations.updateOne;
		let observed = null;
		Reservations.updateOne = async (filter, update, options) => {
			observed = { filter, update, options };
			return { matchedCount: 1, modifiedCount: 1 };
		};
		try {
			const selectedKeys = ["paid_at_hotel_cash", "paid_at_hotel_card"];
			const res = response();
			await updateReconciliationStatus(
				superAdminRequest(
					validBody({
						paymentBreakdownKeys: selectedKeys,
						expectedActionAmountCents: 4567,
						reservations: [
							validSnapshot({
								displayedAmountsCents: {
									paid_at_hotel_cash: 1234,
									paid_at_hotel_card: 4567,
								},
							}),
						],
						comment: "New combined payout",
					})
				),
				res
			);

			assert.equal(res.statusCode, 200);
			assert.equal(res.payload.updatedCount, 1);
			assert.equal(
				observed.update.$set[
					"payment_reconciliation.breakdown.paid_at_hotel_cash"
				],
				undefined
			);
			const cardEntry =
				observed.update.$set[
					"payment_reconciliation.breakdown.paid_at_hotel_card"
				];
			assert.equal(cardEntry.status, "reconciled");
			assert.equal(cardEntry.amountCents, 4567);
			assert.equal(cardEntry.note, undefined);
			assert.equal(restoreFind.created[0].comment, "New combined payout");
			assert.deepEqual(observed.update.$push.adminChangeLog.from, {
				paid_at_hotel_card: "waiting",
			});
			assert.deepEqual(observed.update.$push.adminChangeLog.to, {
				paid_at_hotel_card: "reconciled",
			});
			assert.deepEqual(
				observed.update.$push.adminChangeLog.paymentBreakdownKeys,
				["paid_at_hotel_card"]
			);
			assert.deepEqual(
				observed.update.$push.reservationAuditLog.paymentBreakdownKeys,
				["paid_at_hotel_card"]
			);
			assert.deepEqual(
				observed.filter["paid_amount_breakdown.paid_at_hotel_cash"],
				{ $eq: 12.34 }
			);
			assert.deepEqual(
				observed.filter["paid_amount_breakdown.paid_at_hotel_card"],
				{ $eq: 45.67 }
			);
			assert.equal(observed.filter.$expr.$and.length, 1);
			assert.equal(originalCashProvenance.batchId, "original-cash-batch");
			assert.equal(originalCashProvenance.note, "Original cash payout");
		} finally {
			restoreFind();
			Reservations.updateOne = originalUpdateOne;
		}
	});
});

test("reset removes every selected stored category and preserves all other reservation data", async () => {
	await withSuperAdminEnvironment(async () => {
		const restoreFind = mockMutationReads([
			currentReservation({
				paid_amount_breakdown: {
					paid_at_hotel_cash: 12.34,
					paid_at_hotel_card: 45.67,
					paid_online_other_platforms: 89,
					paid_online_via_link: 10,
				},
				payment_reconciliation: {
					breakdown: {
						paid_at_hotel_cash: {
							status: "waiting",
							amountCents: 1234,
							batchId: "waiting-cash-batch",
							note: "Keep waiting cash provenance",
						},
						paid_at_hotel_card: {
							status: "reconciled",
							amountCents: 4500,
							reconciledAt: new Date("2026-08-09T08:00:00.000Z"),
							batchId: "stale-card-batch",
							note: "Keep stale card provenance",
						},
						paid_online_other_platforms: {
							status: "reconciled",
							amountCents: 8900,
							reconciledAt: new Date("2026-08-11T08:00:00.000Z"),
							batchId: "platform-batch",
							note: "Platform payout",
						},
						paid_online_via_link: {
							status: "reconciled",
							amountCents: 1000,
							batchId: "must-survive",
						},
					},
				},
			}),
		]);
		const originalUpdateOne = Reservations.updateOne;
		let observed = null;
		Reservations.updateOne = async (filter, update) => {
			observed = { filter, update };
			return { matchedCount: 1, modifiedCount: 1 };
		};
		try {
			const selectedKeys = [
				"paid_at_hotel_cash",
				"paid_at_hotel_card",
				"paid_online_other_platforms",
			];
			const res = response();
			await updateReconciliationStatus(
				superAdminRequest(
					validBody({
						action: "reset",
						status: "waiting",
						payoutPurpose: undefined,
						expectedActionAmountCents: 14701,
						paymentBreakdownKeys: selectedKeys,
						reservations: [
							validSnapshot({
								displayedAmountsCents: {
									paid_at_hotel_cash: 1234,
									paid_at_hotel_card: 4567,
									paid_online_other_platforms: 8900,
								},
							}),
						],
						comment: "Reset accidental payout",
					})
				),
				res
			);

			assert.equal(res.statusCode, 200);
			assert.deepEqual(
				Object.keys(observed.update.$unset).sort(),
				selectedKeys
					.map((key) => `payment_reconciliation.breakdown.${key}`)
					.sort()
			);
			assert.ok(Object.values(observed.update.$unset).every((value) => value === 1));
			assert.equal(
				observed.update.$unset[
					"payment_reconciliation.breakdown.paid_online_via_link"
				],
				undefined
			);
			assert.deepEqual(observed.update.$push.adminChangeLog.from, {
				paid_at_hotel_cash: "waiting",
				paid_at_hotel_card: "reconciled",
				paid_online_other_platforms: "reconciled",
			});
			assert.deepEqual(observed.update.$push.adminChangeLog.to, {
				paid_at_hotel_cash: "default",
				paid_at_hotel_card: "default",
				paid_online_other_platforms: "default",
			});
			assert.deepEqual(
				observed.update.$push.adminChangeLog.paymentBreakdownKeys,
				selectedKeys
			);
			assert.deepEqual(
				observed.update.$push.reservationAuditLog.paymentBreakdownKeys,
				selectedKeys
			);
			assert.equal(observed.filter.$expr, undefined);
			assert.equal(
				Object.keys(observed.update.$set).some((path) =>
					path.startsWith("payment_reconciliation.breakdown.")
				),
				false
			);
			assert.equal(restoreFind.created[0].action, "reset");
			assert.equal(restoreFind.created[0].payoutPurpose, "");
			assert.equal(restoreFind.created[0].plannedAmountCents, 14701);
		} finally {
			restoreFind();
			Reservations.updateOne = originalUpdateOne;
		}
	});
});

test("known stale snapshots abort the entire batch before writes", async () => {
	await withSuperAdminEnvironment(async () => {
		const otherReservationId = "64a000000000000000000004";
		const restoreFind = mockMutationReads([
			currentReservation(),
			currentReservation({
				_id: otherReservationId,
				__v: 3,
				paid_amount_breakdown: { paid_at_hotel_cash: 20 },
			}),
		]);
		const originalUpdateOne = Reservations.updateOne;
		let writes = 0;
		Reservations.updateOne = async () => {
			writes += 1;
			return { matchedCount: 1 };
		};
		try {
			const res = response();
			await updateReconciliationStatus(
				superAdminRequest(
					validBody({
						reservations: [
							validSnapshot(),
							validSnapshot({
								reservationId: otherReservationId,
								displayedAmountsCents: { paid_at_hotel_cash: 1999 },
							}),
						],
					})
				),
				res
			);
			assert.equal(res.statusCode, 409);
			assert.equal(res.payload.updatedCount, 0);
			assert.equal(res.payload.conflicts[0].code, "displayed_amount_changed");
			assert.equal(writes, 0);
		} finally {
			restoreFind();
			Reservations.updateOne = originalUpdateOne;
		}
	});
});

test("an optimistic race is explicit and an already-applied retry is idempotent", async () => {
	await withSuperAdminEnvironment(async () => {
		const originalUpdateOne = Reservations.updateOne;
		let writes = 0;
		Reservations.updateOne = async () => {
			writes += 1;
			return { matchedCount: 0 };
		};
		let restoreFind = mockMutationReads([currentReservation()]);
		try {
			const conflictResponse = response();
			await updateReconciliationStatus(
				superAdminRequest(validBody()),
				conflictResponse
			);
			assert.equal(conflictResponse.statusCode, 409);
			assert.equal(conflictResponse.payload.updatedCount, 0);
			assert.equal(
				conflictResponse.payload.conflicts[0].code,
				"reservation_snapshot_changed"
			);
		} finally {
			restoreFind();
		}

		restoreFind = mockMutationReads([
			currentReservation({
				__v: 9,
				updatedAt: new Date("2026-08-14T11:00:00.000Z"),
				payment_reconciliation: {
					breakdown: {
						paid_at_hotel_cash: {
							status: "reconciled",
							amountCents: 1234,
						},
					},
				},
			}),
		]);
		try {
			const retryResponse = response();
			await updateReconciliationStatus(
				superAdminRequest(
					validBody({ expectedActionAmountCents: 0 })
				),
				retryResponse
			);
			assert.equal(retryResponse.statusCode, 200);
			assert.deepEqual(retryResponse.payload.unchanged, [RESERVATION_ID]);
			assert.equal(retryResponse.payload.updatedCount, 0);
			assert.equal(writes, 1);
		} finally {
			restoreFind();
			Reservations.updateOne = originalUpdateOne;
		}
	});
});

test("report rows expose only safe stored-entry existence across every reconciliation state", () => {
	const row = _private.reportRow(
		{
			_id: RESERVATION_ID,
			paid_amount_breakdown: {
				paid_at_hotel_cash: 10,
				paid_at_hotel_card: 20,
				paid_online_other_platforms: 30,
				paid_no_show: 0,
			},
			payment_reconciliation: {
				breakdown: {
					paid_at_hotel_cash: {
						status: "reconciled",
						amountCents: 1000,
						reconciledBy: { email: "private-actor@example.com" },
						batchId: "private-effective-batch",
						note: "private effective note",
					},
					paid_at_hotel_card: {
						status: "reconciled",
						amountCents: 1900,
						batchId: "private-stale-batch",
						note: "private stale note",
					},
					paid_online_other_platforms: {
						status: "waiting",
						amountCents: 3000,
						batchId: "private-waiting-batch",
						note: "private waiting note",
					},
					paid_no_show: {
						status: "waiting",
						amountCents: 0,
						batchId: "private-zero-batch",
						note: "private zero note",
					},
				},
			},
		},
		["paid_at_hotel_cash"]
	);
	const byBreakdown = row.reconciliation_by_breakdown;
	assert.equal(byBreakdown.paid_online_via_link.hasStoredEntry, false);
	assert.equal(byBreakdown.paid_at_hotel_cash.hasStoredEntry, true);
	assert.equal(byBreakdown.paid_at_hotel_cash.reconciled, true);
	assert.equal(byBreakdown.paid_at_hotel_card.hasStoredEntry, true);
	assert.equal(byBreakdown.paid_at_hotel_card.stale, true);
	assert.equal(
		byBreakdown.paid_online_other_platforms.hasStoredEntry,
		true
	);
	assert.equal(byBreakdown.paid_online_other_platforms.status, "waiting");
	assert.equal(byBreakdown.paid_no_show.hasStoredEntry, true);
	assert.equal(byBreakdown.paid_no_show.amountCents, 0);
	assert.equal(byBreakdown.paid_no_show.status, "not_applicable");
	for (const safeEntry of Object.values(byBreakdown)) {
		assert.equal(typeof safeEntry.hasStoredEntry, "boolean");
		assert.deepEqual(Object.keys(safeEntry).sort(), [
			"amount",
			"amountCents",
			"hasStoredEntry",
			"reconciled",
			"stale",
			"status",
		]);
	}
	assert.equal(row.payment_reconciliation, undefined);
	const serialized = JSON.stringify(row);
	for (const privateValue of [
		"private-actor@example.com",
		"private-effective-batch",
		"private-stale-batch",
		"private-waiting-batch",
		"private-zero-batch",
		"private effective note",
		"private stale note",
		"private waiting note",
		"private zero note",
	]) {
		assert.equal(serialized.includes(privateValue), false);
	}
});

test("report enforces hotel scope before reservation reads", async () => {
	const originalFind = Reservations.find;
	const originalCount = Reservations.countDocuments;
	let reads = 0;
	Reservations.find = () => {
		reads += 1;
		throw new Error("unexpected read");
	};
	Reservations.countDocuments = async () => {
		reads += 1;
		return 0;
	};
	try {
		const res = response();
		await reconciliationReport(
			{
				auth: { _id: "64a000000000000000000077" },
				profile: {
					_id: "64a000000000000000000077",
					role: 1000,
					hotelIdWork: OTHER_HOTEL_ID,
				},
				query: { hotelId: HOTEL_ID },
			},
			res
		);
		assert.equal(res.statusCode, 403);
		assert.equal(res.payload.code, "reconciliation_hotel_access_denied");
		assert.equal(reads, 0);
	} finally {
		Reservations.find = originalFind;
		Reservations.countDocuments = originalCount;
	}
});

test("report returns canonical OTA, independent nightly, and reconciliation totals", async () => {
	await withSuperAdminEnvironment(async () => {
		const row = {
			_id: RESERVATION_ID,
			hotelId: HOTEL_ID,
			__v: 2,
			updatedAt: UPDATED_AT,
			createdAt: UPDATED_AT,
			checkin_date: "2026-08-10T00:00:00.000Z",
			checkout_date: "2026-08-12T00:00:00.000Z",
			confirmation_number: "safe-confirmation",
			booking_source: "direct",
			customer_details: {
				name: "Safe Guest",
				cardNumber: "encrypted-card-secret",
				cardCVV: "encrypted-cvv-secret",
			},
			payment_details: { processorSecret: "must-not-return" },
			currency: "SAR",
			total_amount: 300,
			paid_amount_breakdown: {
				paid_at_hotel_cash: 12.34,
				paid_at_hotel_card: 5,
			},
			payment_reconciliation: {
				breakdown: {
					paid_at_hotel_cash: {
						status: "reconciled",
						amountCents: 1234,
					},
				},
			},
			pickedRoomsPricing: [
				{
					count: 1,
					pricingByDay: [
						{ date: "2026-08-10", clientPrice: 140 },
						{ date: "2026-08-11", clientPrice: 160 },
					],
				},
			],
		};
		const originalFind = Reservations.find;
		const originalCount = Reservations.countDocuments;
		const originalAggregate = Reservations.aggregate;
		const observedFilters = [];
		Reservations.countDocuments = async (filter) => {
			observedFilters.push({ kind: "count", filter });
			return 1;
		};
		Reservations.find = (filter) => {
			const call = { kind: "find", filter, projection: "" };
			observedFilters.push(call);
			return {
				sort(sort) {
					call.sort = sort;
					return this;
				},
				skip() {
					return this;
				},
				limit() {
					return this;
				},
				populate() {
					return this;
				},
				select(projection) {
					call.projection = projection;
					return this;
				},
				lean: async () => [row],
			};
		};
		Reservations.aggregate = async (pipeline) => {
			observedFilters.push({ kind: "aggregate", pipeline });
			return [
				{
					totalAmountCents: 1734,
					reconciledAmountCents: 1234,
					reservationsCount: 1,
					reconciledReservationsCount: 1,
					waitingReservationsCount: 1,
				},
			];
		};
		try {
			const res = response();
			await reconciliationReport(
				{
					auth: { _id: USER_ID },
					profile: { _id: USER_ID, role: 1000, activeUser: true },
					query: {
						hotelId: HOTEL_ID,
						paymentBreakdownKeys:
							"paid_at_hotel_cash,paid_at_hotel_card",
						searchQuery: "guest",
						breakdownUpdated: "last_7_days",
					},
				},
				res
			);
			assert.equal(res.statusCode, 200);
			assert.equal(res.payload.breakdownUpdated, "last_7_days");
			assert.equal(res.payload.totalDocuments, 1);
			assert.equal(res.payload.data[0].ota_total_amount, 300);
			assert.equal(
				res.payload.data[0].pricing_breakdown_client_total,
				300
			);
			assert.equal(res.payload.data[0].selected_breakdown_total_cents, 1734);
			assert.equal(res.payload.data[0].reconciliation_status, "mixed");
			assert.equal(res.payload.data[0].payment_reconciliation, undefined);
			assert.equal(res.payload.data[0].payment_details, undefined);
			assert.equal(
				res.payload.data[0].customer_details.cardNumber,
				undefined
			);
			assert.equal(res.payload.data[0].customer_details.name, "Safe Guest");
			assert.equal(
				Object.keys(res.payload.data[0].reconciliation_by_breakdown).length,
				8
			);
			assert.deepEqual(
				Object.keys(
					res.payload.data[0].reconciliation_by_breakdown
						.paid_at_hotel_cash
				).sort(),
				[
					"amount",
					"amountCents",
					"hasStoredEntry",
					"reconciled",
					"stale",
					"status",
				].sort()
			);
			assert.equal(
				res.payload.data[0].reconciliation_by_breakdown
					.paid_at_hotel_cash.hasStoredEntry,
				true
			);
			assert.equal(
				res.payload.data[0].reconciliation_by_breakdown
					.paid_online_via_link.hasStoredEntry,
				false
			);
			assert.deepEqual(
				observedFilters.find((item) => item.kind === "find").sort,
				{
					checkin_date: 1,
					checkout_date: 1,
					createdAt: 1,
					_id: 1,
				}
			);
			assert.equal(res.payload.scorecards.totalAmountCents, 1734);
			assert.equal(res.payload.scorecards.reconciledAmountCents, 1234);
			assert.equal(res.payload.scorecards.waitingAmountCents, 500);
			assert.equal(res.payload.scorecards.reconciledReservationsCount, 1);
			assert.equal(res.payload.scorecards.waitingReservationsCount, 1);
			const scorecardPipeline = observedFilters.find(
				(item) => item.kind === "aggregate"
			).pipeline;
			assert.equal(
				scorecardPipeline[1].$project.rowReconciled.$or.length,
				2
			);
			assert.equal(
				scorecardPipeline[1].$project.rowWaiting.$or.length,
				2
			);
			assert.ok(
				scorecardPipeline[2].$group.waitingReservationsCount
			);
			const rowFilter = observedFilters.find((item) => item.kind === "count").filter;
			const updateClauseFor = (filter) =>
				filter.$and.find((clause) =>
					clause?.$or?.some(
						(condition) =>
							condition?.paid_amount_breakdown_updated_at
					)
				);
			assert.deepEqual(
				updateClauseFor(rowFilter),
				updateClauseFor(scorecardPipeline[0].$match)
			);
			const categoryClause = rowFilter.$and.find(
				(clause) =>
					Array.isArray(clause?.$expr?.$or) &&
					clause.$expr.$or.some(
						(condition) =>
							JSON.stringify(condition?.$gt?.[0]) ===
							JSON.stringify(
								paymentAmountCentsExpression("paid_at_hotel_cash")
							)
					)
			);
			assert.equal(categoryClause.$expr.$or.length, 2);
			const rowProjection = observedFilters.find(
				(item) =>
					item.kind === "find" &&
					String(item.projection).includes("customer_details.name")
			)?.projection;
			assert.ok(rowProjection);
			assert.match(rowProjection, /\+payment_reconciliation/);
			assert.doesNotMatch(rowProjection, /,/);
			for (const token of [
				"total_amount",
				"adminPricing",
				"ota_financial_summary",
				"pickedRoomsPricing",
				"pickedRoomsType",
			]) {
				assert.ok(rowProjection.split(/\s+/).includes(token));
			}
			assert.doesNotMatch(
				rowProjection,
				/(^|\s)customer_details(\s|$)/
			);
		} finally {
			Reservations.find = originalFind;
			Reservations.countDocuments = originalCount;
			Reservations.aggregate = originalAggregate;
		}
	});
});

test("report includeScorecards=false skips the unpaginated scorecard read", async () => {
	await withSuperAdminEnvironment(async () => {
		const originalFind = Reservations.find;
		const originalCount = Reservations.countDocuments;
		const originalAggregate = Reservations.aggregate;
		let findCalls = 0;
		let aggregateCalls = 0;
		Reservations.countDocuments = async () => 0;
		Reservations.aggregate = async () => {
			aggregateCalls += 1;
			return [];
		};
		Reservations.find = () => {
			findCalls += 1;
			return {
				select() {
					return this;
				},
				sort() {
					return this;
				},
				skip() {
					return this;
				},
				limit() {
					return this;
				},
				populate() {
					return this;
				},
				lean: async () => [],
			};
		};
		try {
			const res = response();
			await reconciliationReport(
				{
					auth: { _id: USER_ID },
					profile: { _id: USER_ID, role: 1000, activeUser: true },
					query: { hotelId: HOTEL_ID, includeScorecards: "false", page: "2" },
				},
				res
			);
			assert.equal(res.statusCode, 200);
			assert.equal(findCalls, 1);
			assert.equal(aggregateCalls, 0);
			assert.equal(res.payload.scorecards, null);
		} finally {
			Reservations.find = originalFind;
			Reservations.countDocuments = originalCount;
			Reservations.aggregate = originalAggregate;
		}
	});
});

test("closest match is a waiting-only read that returns report rows and CAS snapshots", async () => {
	await withSuperAdminEnvironment(async () => {
		const rows = [
			{
				...currentReservation({
					_id: new mongoose.Types.ObjectId("64a000000000000000000011"),
					paid_amount_breakdown: { paid_at_hotel_cash: 10 },
				}),
				createdAt: new Date("2026-08-01T00:00:00.000Z"),
				checkin_date: new Date("2026-08-10T00:00:00.000Z"),
				checkout_date: new Date("2026-08-11T00:00:00.000Z"),
				customer_details: { name: "Ten" },
			},
			{
				...currentReservation({
					_id: new mongoose.Types.ObjectId("64a000000000000000000012"),
					paid_amount_breakdown: { paid_at_hotel_cash: 15 },
				}),
				createdAt: new Date("2026-08-02T00:00:00.000Z"),
				checkin_date: new Date("2026-08-11T00:00:00.000Z"),
				checkout_date: new Date("2026-08-12T00:00:00.000Z"),
				customer_details: { name: "Fifteen" },
			},
			{
				...currentReservation({
					_id: new mongoose.Types.ObjectId("64a000000000000000000013"),
					paid_amount_breakdown: { paid_at_hotel_cash: 25 },
				}),
				createdAt: new Date("2026-08-03T00:00:00.000Z"),
				checkin_date: new Date("2026-08-12T00:00:00.000Z"),
				checkout_date: new Date("2026-08-13T00:00:00.000Z"),
				customer_details: { name: "Twenty Five" },
			},
		];
		const originalFind = Reservations.find;
		const originalUpdateOne = Reservations.updateOne;
		const observed = [];
		let writes = 0;
		Reservations.find = (filter) => {
			const call = { filter };
			observed.push(call);
			return {
				select(projection) {
					call.projection = projection;
					return this;
				},
				sort(sort) {
					call.sort = sort;
					return this;
				},
				limit(limit) {
					call.limit = limit;
					return this;
				},
				lean: async () => {
					if (observed.length === 1) return rows;
					const selectedIds = new Set(
						(filter?.$and?.[1]?._id?.$in || []).map(String)
					);
					return rows.filter((row) => selectedIds.has(String(row._id)));
				},
			};
		};
		Reservations.updateOne = async () => {
			writes += 1;
		};
		try {
			const res = response();
			await closestReconciliationMatch(
				{
					auth: { _id: USER_ID },
					profile: { _id: USER_ID, role: 1000, activeUser: true },
					body: {
						hotelId: HOTEL_ID,
						paymentBreakdownKey: "paid_at_hotel_cash",
						targetAmountCents: 3500,
						dateBy: "checkin_date",
						dateFrom: "2026-08-01",
						dateTo: "2026-08-31",
						dateRanges: [],
					},
				},
				res
			);
			assert.equal(res.statusCode, 200);
			assert.equal(res.payload.exactMatch, true);
			assert.equal(res.payload.matchedAmountCents, 3500);
			assert.equal(res.payload.selectedCount, 2);
			assert.equal(res.payload.data.length, 2);
			assert.equal(res.payload.reservations.length, 2);
			assert.ok(
				res.payload.reservations.every(
					(snapshot) =>
						snapshot.displayedAmountsCents.paid_at_hotel_cash > 0 &&
						Number.isInteger(snapshot.__v)
				)
			);
			assert.equal(writes, 0);
			assert.equal(observed.length, 2);
			assert.equal(observed[0].limit, 5001);
			assert.deepEqual(observed[0].sort, {
				checkin_date: 1,
				checkout_date: 1,
				createdAt: 1,
				_id: 1,
			});
			assert.equal(
				observed[0].projection,
				"_id __v updatedAt checkin_date checkout_date reservation_status state paid_amount_breakdown.paid_at_hotel_cash"
			);
			assert.doesNotMatch(
				observed[0].projection,
				/\+payment_reconciliation|customer_details|pickedRoomsPricing/
			);
			assert.match(observed[1].projection, /\+payment_reconciliation/);
			assert.equal(observed[1].limit, 2);
			assert.deepEqual(observed[1].sort, observed[0].sort);
			assert.equal(observed[1].filter.$and[0], observed[0].filter);
			assert.ok(
				observed[0].filter.$and.some(
					(clause) =>
						clause?.$expr?.$or?.some(
							(condition) => Array.isArray(condition?.$and)
						)
				)
			);
			assert.ok(
				observed[0].filter.$and.some((clause) =>
					clause?.reservation_status?.$not?.test("cancelled")
				)
			);
		} finally {
			Reservations.find = originalFind;
			Reservations.updateOne = originalUpdateOne;
		}
	});
});

test("closest match returns 409 without writes when a selected candidate changes before refetch", async () => {
	await withSuperAdminEnvironment(async () => {
		const initial = {
			...currentReservation(),
			createdAt: new Date("2026-08-01T00:00:00.000Z"),
			checkin_date: new Date("2026-08-10T00:00:00.000Z"),
			checkout_date: new Date("2026-08-11T00:00:00.000Z"),
		};
		const changed = {
			...initial,
			__v: initial.__v + 1,
			updatedAt: new Date("2026-08-14T10:00:01.000Z"),
		};
		const originalFind = Reservations.find;
		const originalUpdateOne = Reservations.updateOne;
		let reads = 0;
		let writes = 0;
		Reservations.find = () => ({
			select() {
				return this;
			},
			sort() {
				return this;
			},
			limit() {
				return this;
			},
			async lean() {
				reads += 1;
				return reads === 1 ? [initial] : [changed];
			},
		});
		Reservations.updateOne = async () => {
			writes += 1;
			return { matchedCount: 1 };
		};
		try {
			const res = response();
			await closestReconciliationMatch(
				{
					auth: { _id: USER_ID },
					profile: { _id: USER_ID, role: 1000, activeUser: true },
					body: {
						hotelId: HOTEL_ID,
						paymentBreakdownKey: "paid_at_hotel_cash",
						targetAmountCents: 1234,
					},
				},
				res
			);
			assert.equal(res.statusCode, 409);
			assert.equal(res.payload.code, "closest_match_candidates_changed");
			assert.equal(reads, 2);
			assert.equal(writes, 0);
		} finally {
			Reservations.find = originalFind;
			Reservations.updateOne = originalUpdateOne;
		}
	});
});

test("closest match scans 5,000 candidates with only the narrow allowlisted projection", async () => {
	await withSuperAdminEnvironment(async () => {
		const rows = Array.from({ length: 5000 }, (_, index) => ({
			_id: (index + 1).toString(16).padStart(24, "0"),
			__v: 1,
			updatedAt: UPDATED_AT,
			createdAt: new Date("2026-08-01T00:00:00.000Z"),
			checkin_date: new Date("2026-08-10T00:00:00.000Z"),
			checkout_date: new Date("2026-08-11T00:00:00.000Z"),
			paid_amount_breakdown: { paid_at_hotel_cash: 1 },
			payment_reconciliation: { breakdown: {} },
		}));
		const originalFind = Reservations.find;
		const originalUpdateOne = Reservations.updateOne;
		const observed = [];
		let writes = 0;
		Reservations.find = (filter) => {
			const call = { filter };
			observed.push(call);
			return {
				select(projection) {
					call.projection = projection;
					return this;
				},
				sort(sort) {
					call.sort = sort;
					return this;
				},
				limit(limit) {
					call.limit = limit;
					return this;
				},
				async lean() {
					if (observed.length === 1) return rows;
					const selectedIds = new Set(
						(filter?.$and?.[1]?._id?.$in || []).map(String)
					);
					return rows.filter((row) => selectedIds.has(row._id));
				},
			};
		};
		Reservations.updateOne = async () => {
			writes += 1;
			return { matchedCount: 1 };
		};
		try {
			const res = response();
			await closestReconciliationMatch(
				{
					auth: { _id: USER_ID },
					profile: { _id: USER_ID, role: 1000, activeUser: true },
					body: {
						hotelId: HOTEL_ID,
						paymentBreakdownKey: "paid_at_hotel_cash",
						targetAmountCents: 100,
					},
				},
				res
			);
			assert.equal(res.statusCode, 200);
			assert.equal(res.payload.candidateCount, 5000);
			assert.equal(res.payload.selectedCount, 1);
			assert.equal(observed.length, 2);
			assert.equal(
				observed[0].projection,
				"_id __v updatedAt checkin_date checkout_date reservation_status state paid_amount_breakdown.paid_at_hotel_cash"
			);
			assert.doesNotMatch(
				observed[0].projection,
				/\+payment_reconciliation|customer_details|adminPricing|pickedRoomsPricing/
			);
			assert.match(observed[1].projection, /\+payment_reconciliation/);
			assert.equal(observed[1].limit, 1);
			assert.equal(writes, 0);
		} finally {
			Reservations.find = originalFind;
			Reservations.updateOne = originalUpdateOne;
		}
	});
});

test("closest match rejects an honestly over-limit candidate range without mutation", async () => {
	await withSuperAdminEnvironment(async () => {
		const originalFind = Reservations.find;
		const originalUpdateOne = Reservations.updateOne;
		let writes = 0;
		let projection = "";
		Reservations.find = () => ({
			select(value) {
				projection = value;
				return this;
			},
			sort() {
				return this;
			},
			limit() {
				return this;
			},
			lean: async () => Array.from({ length: 5001 }, () => ({})),
		});
		Reservations.updateOne = async () => {
			writes += 1;
		};
		try {
			const res = response();
			await closestReconciliationMatch(
				{
					auth: { _id: USER_ID },
					profile: { _id: USER_ID, role: 1000, activeUser: true },
					body: {
						hotelId: HOTEL_ID,
						paymentBreakdownKey: "paid_at_hotel_cash",
						targetAmountCents: 100,
					},
				},
				res
			);
			assert.equal(res.statusCode, 422);
			assert.equal(res.payload.code, "closest_match_candidate_limit_exceeded");
			assert.equal(
				projection,
				"_id __v updatedAt checkin_date checkout_date reservation_status state paid_amount_breakdown.paid_at_hotel_cash"
			);
			assert.equal(writes, 0);
		} finally {
			Reservations.find = originalFind;
			Reservations.updateOne = originalUpdateOne;
		}
	});
});
