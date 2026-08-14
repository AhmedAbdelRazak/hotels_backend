/** @format */

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

process.env.SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "SG.test";
process.env.JWT_SECRET2 =
	process.env.JWT_SECRET2 || "offline-payment-reconciliation-write-guard";
process.env.AI_AGENT_TEST_EXPORTS = "true";

const HotelDetails = require("../models/hotel_details");
const Reservations = require("../models/reservations");
const reservationsController = require("../controllers/reservations");
const janatController = require("../controllers/janat");
const {
	PAYMENT_BREAKDOWN_KEYS,
} = require("../services/paymentReconciliation");
const {
	withPaymentReconciliationInvalidation,
} = require("../services/paymentReconciliationInvalidation");

const createResponse = () => ({
	statusCode: 200,
	payload: undefined,
	status(code) {
		this.statusCode = code;
		return this;
	},
	json(payload) {
		this.payload = payload;
		return payload;
	},
	send(payload) {
		this.payload = payload;
		return payload;
	},
});

const forgedReconciliationPayload = () => ({
	comment: "this legitimate field must survive",
	payment_reconciliation: {
		status: "reconciled",
		reconciledBy: "forged-actor",
	},
	"payment_reconciliation.status": "reconciled",
	"payment_reconciliation.entries.0.status": "reconciled",
});

test("generic authenticated updates strip reconciliation root and dotted keys", () => {
	const update = forgedReconciliationPayload();

	reservationsController.__test.stripServerManagedReservationUpdateFields(
		update,
	);

	assert.deepEqual(update, {
		comment: "this legitimate field must survive",
	});
});

test("authenticated create strips client-supplied reconciliation before validation", async () => {
	const req = {
		body: forgedReconciliationPayload(),
		params: { hotelId: "not-a-valid-hotel-id" },
		auth: { _id: "not-a-valid-user-id" },
	};
	const res = createResponse();

	await reservationsController.create(req, res);

	assert.equal(res.statusCode, 400);
	assert.deepEqual(req.body, {
		comment: "this legitimate field must survive",
	});
});

test("public create strips client-supplied reconciliation before database work", async (t) => {
	const originalFindOne = HotelDetails.findOne;
	let databaseLookupStarted = false;
	HotelDetails.findOne = async () => {
		databaseLookupStarted = true;
		return null;
	};
	t.after(() => {
		HotelDetails.findOne = originalFindOne;
	});

	const req = {
		body: {
			...forgedReconciliationPayload(),
			booking_source: "Online Jannat Booking",
		},
	};
	const res = createResponse();

	await janatController.createNewReservationClient(req, res);

	assert.equal(databaseLookupStarted, true);
	assert.equal(res.statusCode, 400);
	assert.equal(req.body.payment_reconciliation, undefined);
	assert.equal(req.body["payment_reconciliation.status"], undefined);
	assert.equal(
		req.body["payment_reconciliation.entries.0.status"],
		undefined,
	);
	assert.equal(req.body.comment, "this legitimate field must survive");
});

test("public reservation update cannot replace or patch reconciliation", async (t) => {
	const originalFindById = Reservations.findById;
	const originalConsoleError = console.error;
	const persistedReconciliation = {
		status: "waiting_reconciliation",
		entries: [],
	};
	let saveAttempted = false;
	const stopAfterAssignment = new Error("stop after guarded assignment");
	const reservation = {
		_id: "64b74714fb50e159d48c714d",
		hotelId: "64b74714fb50e159d48c7150",
		customer_details: {},
		payment_reconciliation: persistedReconciliation,
		markModified() {},
		toObject() {
			return {
				_id: this._id,
				hotelId: this.hotelId,
				customer_details: this.customer_details,
				comment: this.comment,
				payment_reconciliation: this.payment_reconciliation,
			};
		},
		async save() {
			saveAttempted = true;
			assert.equal(this.payment_reconciliation, persistedReconciliation);
			assert.deepEqual(this.payment_reconciliation, {
				status: "waiting_reconciliation",
				entries: [],
			});
			assert.equal(this["payment_reconciliation.status"], undefined);
			assert.equal(
				this["payment_reconciliation.entries.0.status"],
				undefined,
			);
			assert.equal(this.comment, "this legitimate field must survive");
			throw stopAfterAssignment;
		},
	};
	Reservations.findById = () => ({
		exec: async () => reservation,
	});
	console.error = () => {};
	t.after(() => {
		Reservations.findById = originalFindById;
		console.error = originalConsoleError;
	});

	const req = {
		params: { reservationId: String(reservation._id) },
		body: forgedReconciliationPayload(),
	};
	const res = createResponse();

	await janatController.updateReservationDetails(req, res);

	assert.equal(saveAttempted, true);
	assert.equal(res.statusCode, 500);
});

const existingPaidReservation = () => ({
	paid_amount: 175,
	paid_amount_breakdown: {
		paid_online_via_link: 100,
		paid_at_hotel_cash: 50,
		paid_at_hotel_card: 25,
		paid_to_hotel: 0,
		paid_online_jannatbooking: 0,
		paid_online_other_platforms: 0,
		paid_online_via_instapay: 0,
		paid_no_show: 0,
		payment_comments: "original note",
	},
});

const fullPaymentEditorPayload = (overrides = {}) => {
	const existing = existingPaidReservation();
	return {
		unrelated_field: "must survive",
		paid_amount: 175,
		paid_amount_breakdown: {
			...existing.paid_amount_breakdown,
			...overrides,
		},
	};
};

test("generic payment-editor no-op emits no breakdown mutation", () => {
	const existing = existingPaidReservation();
	const narrowed =
		reservationsController.__test.buildNarrowPaidBreakdownPersistenceUpdate(
			fullPaymentEditorPayload(),
			existing,
		);

	assert.deepEqual(narrowed, { unrelated_field: "must survive" });
	assert.strictEqual(withPaymentReconciliationInvalidation(narrowed), narrowed);
});

test("generic payment-editor comment-only save preserves reconciliation", () => {
	const existing = existingPaidReservation();
	const narrowed =
		reservationsController.__test.buildNarrowPaidBreakdownPersistenceUpdate(
			fullPaymentEditorPayload({ payment_comments: "receipt checked" }),
			existing,
		);

	assert.deepEqual(narrowed, {
		unrelated_field: "must survive",
		"paid_amount_breakdown.payment_comments": "receipt checked",
	});
	assert.strictEqual(withPaymentReconciliationInvalidation(narrowed), narrowed);
});

test("generic payment-editor monetary save invalidates only the changed category", () => {
	const existing = existingPaidReservation();
	const narrowed =
		reservationsController.__test.buildNarrowPaidBreakdownPersistenceUpdate(
			{
				...fullPaymentEditorPayload({ paid_at_hotel_card: 35 }),
				paid_amount: 185,
			},
			existing,
		);

	assert.deepEqual(narrowed, {
		unrelated_field: "must survive",
		paid_amount: 185,
		"paid_amount_breakdown.paid_at_hotel_card": 35,
	});
	const invalidated = withPaymentReconciliationInvalidation(narrowed);
	assert.deepEqual(invalidated.$set, {
		unrelated_field: "must survive",
		paid_amount: 185,
		"paid_amount_breakdown.paid_at_hotel_card": 35,
	});
	assert.deepEqual(invalidated.$unset, {
		"payment_reconciliation.breakdown.paid_at_hotel_card": 1,
	});
});

test("unknown root writers remain conservatively invalidated", () => {
	const invalidated = withPaymentReconciliationInvalidation({
		$set: {
			paid_amount_breakdown: { payment_comments: "unknown root writer" },
		},
	});

	assert.deepEqual(
		invalidated.$set["payment_reconciliation.breakdown"],
		{},
	);
	assert.equal(PAYMENT_BREAKDOWN_KEYS.length, 8);
});
