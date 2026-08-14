/** @format */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Reservations = require("../models/reservations");
const {
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
	status: "reconciled",
	paymentBreakdownKeys: ["paid_at_hotel_cash"],
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

const mockMutationReads = (rows) => {
	const originalFind = Reservations.find;
	Reservations.find = () => ({
		select() {
			return this;
		},
		lean: async () => rows,
	});
	return () => {
		Reservations.find = originalFind;
	};
};

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
				note: "Payout batch 42",
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
						reservations: [
							validSnapshot({
								displayedAmountsCents: {
									paid_at_hotel_cash: 1234,
									paid_at_hotel_card: 4567,
								},
							}),
						],
						note: "New combined payout",
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
			assert.equal(cardEntry.note, "New combined payout");
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
			assert.equal(observed.filter.$expr.$and.length, 2);
			assert.equal(originalCashProvenance.batchId, "original-cash-batch");
			assert.equal(originalCashProvenance.note, "Original cash payout");
		} finally {
			restoreFind();
			Reservations.updateOne = originalUpdateOne;
		}
	});
});

test("marking a mixed reservation waiting preserves already-waiting and stale category provenance", async () => {
	await withSuperAdminEnvironment(async () => {
		const restoreFind = mockMutationReads([
			currentReservation({
				paid_amount_breakdown: {
					paid_at_hotel_cash: 12.34,
					paid_at_hotel_card: 45.67,
					paid_online_other_platforms: 89,
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
						status: "waiting",
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
						note: "Return platform payout to waiting",
					})
				),
				res
			);

			assert.equal(res.statusCode, 200);
			assert.equal(
				observed.update.$set[
					"payment_reconciliation.breakdown.paid_at_hotel_cash"
				],
				undefined
			);
			assert.equal(
				observed.update.$set[
					"payment_reconciliation.breakdown.paid_at_hotel_card"
				],
				undefined
			);
			const platformEntry =
				observed.update.$set[
					"payment_reconciliation.breakdown.paid_online_other_platforms"
				];
			assert.equal(platformEntry.status, "waiting");
			assert.equal(platformEntry.amountCents, 8900);
			assert.equal(platformEntry.reconciledAt, null);
			assert.equal(platformEntry.reconciledBy, null);
			assert.deepEqual(observed.update.$push.adminChangeLog.from, {
				paid_online_other_platforms: "reconciled",
			});
			assert.deepEqual(observed.update.$push.adminChangeLog.to, {
				paid_online_other_platforms: "waiting",
			});
			assert.deepEqual(
				observed.update.$push.adminChangeLog.paymentBreakdownKeys,
				["paid_online_other_platforms"]
			);
			assert.deepEqual(
				observed.update.$push.reservationAuditLog.paymentBreakdownKeys,
				["paid_online_other_platforms"]
			);
			assert.equal(observed.filter.$expr.$and.length, 3);
			assert.deepEqual(
				Object.keys(observed.update.$set)
					.filter((path) => path.startsWith("payment_reconciliation.breakdown."))
					.sort(),
				[
					"payment_reconciliation.breakdown.paid_online_other_platforms",
				]
			);
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
				superAdminRequest(validBody()),
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
					reconciledReservationsCount: 0,
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
					},
				},
				res
			);
			assert.equal(res.statusCode, 200);
			assert.equal(res.payload.totalDocuments, 1);
			assert.equal(res.payload.data[0].ota_total_amount, 300);
			assert.equal(
				res.payload.data[0].pricing_breakdown_client_total,
				300
			);
			assert.equal(res.payload.data[0].selected_breakdown_total_cents, 1734);
			assert.equal(res.payload.data[0].reconciliation_status, "waiting");
			assert.equal(res.payload.data[0].payment_reconciliation, undefined);
			assert.equal(res.payload.data[0].payment_details, undefined);
			assert.equal(
				res.payload.data[0].customer_details.cardNumber,
				undefined
			);
			assert.equal(res.payload.data[0].customer_details.name, "Safe Guest");
			assert.deepEqual(
				Object.keys(
					res.payload.data[0].reconciliation_by_breakdown
						.paid_at_hotel_cash
				).sort(),
				["amount", "amountCents", "reconciled", "stale", "status"].sort()
			);
			assert.equal(res.payload.scorecards.totalAmountCents, 1734);
			assert.equal(res.payload.scorecards.reconciledAmountCents, 1234);
			assert.equal(res.payload.scorecards.waitingAmountCents, 500);
			const rowFilter = observedFilters.find((item) => item.kind === "count").filter;
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
