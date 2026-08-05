/** @format */

process.env.SENDGRID_API_KEY = /^SG\./.test(process.env.SENDGRID_API_KEY || "")
	? process.env.SENDGRID_API_KEY
	: "SG.test";

const test = require("node:test");
const assert = require("node:assert/strict");
const { __private } = require("./expediaReservationCollector");

test("Expedia collector classifies an existing reservation with a provider-scoped lookup", async () => {
	const calls = [];
	const existing = {
		_id: "reservation-2",
		hotelId: "hotel-2",
		confirmation_number: "pms-456",
		otaIdentityKey: "expedia:exp-456",
		reservation_id: "exp-456",
		reservation_status: "confirmed",
		customer_details: {
			confirmation_number2: "exp-456",
		},
		supplierData: {
			otaProvider: "expedia",
			otaConfirmationNumber: "exp-456",
			platformConfirmationNumber: "exp-456",
		},
	};

	const classification = await __private.classifyCandidate(
		{
			confirmationNumber: "EXP-456",
			statusToApply: "cancelled",
			statusRaw: "Cancelled",
		},
		{
			findReservation: async (...args) => {
				calls.push(args);
				return existing;
			},
		}
	);

	assert.equal(calls.length, 1);
	assert.equal(calls[0][0], "exp-456");
	assert.equal(calls[0][1], "expedia");
	assert.match(calls[0][2], /confirmation_number/);
	assert.equal(classification.bucket, "statusChanged");
	assert.equal(classification.item.matchedLookupValue, "exp-456");
	assert.ok(classification.item.matchedReservationBy.includes("otaIdentityKey"));
	assert.ok(
		classification.item.matchedReservationBy.includes(
			"supplierData.otaConfirmationNumber"
		)
	);
});
