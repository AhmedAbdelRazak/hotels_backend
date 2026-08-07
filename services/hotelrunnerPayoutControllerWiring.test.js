"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

process.env.PAYPAL_CLIENT_ID_SANDBOX =
	process.env.PAYPAL_CLIENT_ID_SANDBOX || "hotelrunner-test-client";
process.env.PAYPAL_SECRET_KEY_SANDBOX =
	process.env.PAYPAL_SECRET_KEY_SANDBOX || "hotelrunner-test-secret";

const adminPayouts = require("../controllers/admin_payouts");
const paypalOwner = require("../controllers/paypal_owner");
const Reservations = require("../models/reservations");

const objectId = (suffix) => `64b0000000000000000000${suffix}`;

const responseRecorder = () => {
	const recorded = { statusCode: 200, body: null };
	return {
		recorded,
		res: {
			status(statusCode) {
				recorded.statusCode = statusCode;
				return this;
			},
			json(body) {
				recorded.body = body;
				return body;
			},
		},
	};
};

const grossRootRows = [
	{
		count: 1,
		pricingByDay: [
			{
				totalPriceWithCommission: 1000,
				rootPrice: 700,
			},
		],
	},
];

const directHotelRunner = (overrides = {}) => ({
	total_amount: 1000,
	sub_total: 700,
	commission: 0,
	adminPricing: { mode: "hotelrunner_api" },
	pickedRoomsType: grossRootRows,
	...overrides,
});

test("admin payout derivation excludes unreviewed HotelRunner spread", () => {
	const result =
		adminPayouts.__hotelRunnerPlatformFinanceTest.deriveReservationPayoutFinance(
			directHotelRunner()
		);
	assert.equal(result.available, false);
	assert.equal(result.commissionSAR, null);
	assert.equal(result.payoutSAR, null);
});

test("admin payout derivation uses only assigned HotelRunner platform commission", () => {
	const result =
		adminPayouts.__hotelRunnerPlatformFinanceTest.deriveReservationPayoutFinance(
			directHotelRunner({
				commission: 25,
				financial_cycle: {
					commissionAssigned: true,
					commissionAmount: 25,
				},
			})
		);
	assert.deepEqual(result, {
		available: true,
		commissionSAR: 25,
		payoutSAR: 975,
		reason: "",
	});
});

test("legacy payout derivation remains gross minus room commission", () => {
	const legacy = {
		total_amount: 1000,
		commission: 0,
		pickedRoomsType: grossRootRows,
	};
	assert.deepEqual(
		adminPayouts.__hotelRunnerPlatformFinanceTest.deriveReservationPayoutFinance(
			legacy
		),
		{
			available: true,
			commissionSAR: 300,
			payoutSAR: 700,
			reason: "",
		}
	);
	assert.deepEqual(
		paypalOwner.__hotelRunnerPlatformFinanceTest.deriveOwnerPayoutFinance(
			legacy,
			{ preferStoredCommission: false }
		),
		{
			available: true,
			commissionSAR: 300,
			payoutSAR: 700,
			reason: "",
		}
	);
});

test("PayPal charge candidate guard finds unreviewed HotelRunner rows", () => {
	const rows = [
		{ _id: "legacy", total_amount: 1000, pickedRoomsType: grossRootRows },
		{ _id: "hotelrunner", ...directHotelRunner() },
	];
	const unavailable =
		paypalOwner.__hotelRunnerPlatformFinanceTest.selectedHotelRunnerFinanceUnavailable(
			rows
		);
	assert.equal(unavailable.length, 1);
	assert.equal(unavailable[0].reservation._id, "hotelrunner");
});

test("admin commission mutation rejects unreviewed HotelRunner before update", async () => {
	const reservationId = objectId("01");
	const originalFindById = Reservations.findById;
	const originalUpdateOne = Reservations.updateOne;
	let updateCalls = 0;
	Reservations.findById = () => ({
		lean: async () => ({
			_id: reservationId,
			hotelId: objectId("02"),
			...directHotelRunner(),
		}),
	});
	Reservations.updateOne = async () => {
		updateCalls += 1;
		return { modifiedCount: 1 };
	};

	try {
		const { res, recorded } = responseRecorder();
		await adminPayouts.updateCommissionStatus(
			{
				body: { reservationId, commissionPaid: true },
				profile: {},
			},
			res
		);
		assert.equal(recorded.statusCode, 409);
		assert.equal(
			recorded.body?.code,
			"hotelrunner_platform_commission_unreviewed"
		);
		assert.equal(updateCalls, 0);
	} finally {
		Reservations.findById = originalFindById;
		Reservations.updateOne = originalUpdateOne;
	}
});

test("owner bulk mark rejects unreviewed HotelRunner before update", async () => {
	const reservationId = objectId("03");
	const hotelId = objectId("04");
	const originalFind = Reservations.find;
	const originalUpdateOne = Reservations.updateOne;
	let updateCalls = 0;
	Reservations.find = () => ({
		lean: async () => [
			{
				_id: reservationId,
				hotelId,
				...directHotelRunner(),
			},
		],
	});
	Reservations.updateOne = async () => {
		updateCalls += 1;
		return { modifiedCount: 1 };
	};

	try {
		const { res, recorded } = responseRecorder();
		await paypalOwner.markCommissionsPaid(
			{
				body: { hotelId, reservationIds: [reservationId] },
				profile: {},
			},
			res
		);
		assert.equal(recorded.statusCode, 409);
		assert.equal(
			recorded.body?.code,
			"hotelrunner_platform_finance_review_required"
		);
		assert.equal(recorded.body?.unavailable?.count, 1);
		assert.equal(updateCalls, 0);
	} finally {
		Reservations.find = originalFind;
		Reservations.updateOne = originalUpdateOne;
	}
});
