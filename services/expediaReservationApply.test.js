/** @format */

process.env.SENDGRID_API_KEY = /^SG\./.test(process.env.SENDGRID_API_KEY || "")
	? process.env.SENDGRID_API_KEY
	: "SG.test";

const test = require("node:test");
const assert = require("node:assert/strict");
const Reservations = require("../models/reservations");
const HotelDetails = require("../models/hotel_details");
const { reconcileOtaReservation } = require("./otaReservationMapper");
const { __private } = require("./expediaReservationApply");

const expediaReservation = (confirmationNumber = "exp-123") => ({
	_id: "reservation-1",
	hotelId: "hotel-1",
	confirmation_number: "pms-123",
	otaIdentityKey: `expedia:${confirmationNumber}`,
	reservation_id: confirmationNumber,
	customer_details: {
		confirmation_number2: confirmationNumber,
	},
	supplierData: {
		otaProvider: "expedia",
		otaConfirmationNumber: confirmationNumber,
		platformConfirmationNumber: confirmationNumber,
	},
});

test("Expedia apply lookup passes the provider before the projection", async () => {
	const calls = [];
	const existing = expediaReservation();
	const result = await __private.findExistingForCandidate(
		{ confirmationNumber: "EXP-123" },
		{
			findReservation: async (...args) => {
				calls.push(args);
				return existing;
			},
		}
	);

	assert.equal(result.existing, existing);
	assert.equal(result.matchedLookupValue, "exp-123");
	assert.equal(calls.length, 1);
	assert.equal(calls[0][0], "exp-123");
	assert.equal(calls[0][1], "expedia");
	assert.match(calls[0][2], /confirmation_number/);
});

test("Expedia apply match explanations remain provider scoped", () => {
	const fields = __private.detectExpediaConfirmationMatchFields(
		expediaReservation(),
		"EXP-123"
	);

	assert.ok(fields.includes("otaIdentityKey"));
	assert.ok(fields.includes("supplierData.otaConfirmationNumber"));
});

test("Expedia sync lifecycle events carry the immutable job timestamp", () => {
	const createdAt = new Date("2026-08-04T12:34:56.000Z");
	const normalized = __private.candidateToNormalized({
		candidate: {
			confirmationNumber: "EXP-STATUS-123",
			hotelId: "hotel-1",
			hotelName: "Example Hotel",
			roomName: "Double Room",
			checkinDate: "2026-08-10",
			checkoutDate: "2026-08-11",
			guestName: "Example Guest",
			amount: 100,
		},
		job: {
			_id: "job-1",
			jobNumber: "JOB-1",
			createdAt,
		},
		intent: "reservation_status",
		eventType: "cancelled",
		statusToApply: "cancelled",
	});

	assert.equal(normalized.source.receivedAt, createdAt);
	assert.equal(normalized.source.from, "expedia-sync");
});

test("an existing Expedia cancellation applies and persists the immutable job watermark", async () => {
	const originalReservationFind = Reservations.find;
	const originalReservationUpdateOne = Reservations.updateOne;
	const originalHotelFindById = HotelDetails.findById;
	let updateSet = null;
	const existing = expediaReservation("exp-status-123");
	existing.state = "confirmed";
	existing.reservation_status = "confirmed";
	existing.supplierData.otaLastSourceReceivedAt =
		"2026-08-04T10:00:00.000Z";
	existing.otaPlatformReview = {
		provider: "expedia",
		confirmationNumber: "exp-status-123",
	};
	Reservations.find = () => ({
		limit() {
			return this;
		},
		async exec() {
			return [existing];
		},
	});
	Reservations.updateOne = async (_filter, update) => {
		updateSet = update.$set;
		return { matchedCount: 1 };
	};
	HotelDetails.findById = () => ({
		select() {
			return this;
		},
		async lean() {
			return { _id: "hotel-1", hotelName: "Example Hotel" };
		},
	});

	try {
		const jobCreatedAt = new Date("2026-08-04T11:00:00.000Z");
		const normalized = __private.candidateToNormalized({
			candidate: {
				confirmationNumber: "exp-status-123",
				hotelId: "hotel-1",
				hotelName: "Example Hotel",
			},
			job: {
				_id: "job-status-1",
				jobNumber: "JOB-STATUS-1",
				createdAt: jobCreatedAt,
			},
			intent: "reservation_status",
			eventType: "cancelled",
			statusToApply: "cancelled",
		});
		const result = await reconcileOtaReservation(normalized);

		assert.equal(result.status, "cancelled");
		assert.equal(updateSet.state, "cancelled");
		assert.equal(updateSet.reservation_status, "cancelled");
		assert.equal(
			updateSet["supplierData.otaLastSourceReceivedAt"].toISOString(),
			jobCreatedAt.toISOString()
		);
	} finally {
		Reservations.find = originalReservationFind;
		Reservations.updateOne = originalReservationUpdateOne;
		HotelDetails.findById = originalHotelFindById;
	}
});
