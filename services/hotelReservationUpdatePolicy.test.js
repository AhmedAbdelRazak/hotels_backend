/** @format */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
	canEditHotelReservation,
	sanitizeHotelReservationUpdate,
} = require("./hotelReservationUpdatePolicy");

const hotel = { _id: "hotel-1", belongsTo: "owner-1" };

test("hotel owners and assigned reservation staff can edit", () => {
	assert.equal(
		canEditHotelReservation({ _id: "owner-1", activeUser: true }, hotel),
		true,
	);
	assert.equal(
		canEditHotelReservation(
			{
				_id: "reception-1",
				activeUser: true,
				role: 3000,
				hotelIdsWork: ["hotel-1"],
			},
			hotel,
		),
		true,
	);
	assert.equal(
		canEditHotelReservation(
			{
				_id: "booking-1",
				activeUser: true,
				roleDescription: "booking responsible",
				hotelsToSupport: ["hotel-1"],
			},
			hotel,
		),
		true,
	);
});

test("unassigned, inactive, finance, and order-taker accounts cannot edit", () => {
	for (const actor of [
		{ _id: "reception-1", activeUser: true, role: 3000 },
		{
			_id: "reception-1",
			activeUser: false,
			role: 3000,
			hotelIdsWork: ["hotel-1"],
		},
		{
			_id: "finance-1",
			activeUser: true,
			role: 6000,
			hotelIdsWork: ["hotel-1"],
		},
		{
			_id: "agent-1",
			activeUser: true,
			role: 7000,
			hotelIdsWork: ["hotel-1"],
		},
	]) {
		assert.equal(canEditHotelReservation(actor, hotel), false);
	}
});

test("hotel update payload drops lifecycle, ownership, and audit fields", () => {
	assert.deepEqual(
		sanitizeHotelReservationUpdate({
			checkin_date: "2026-07-25",
			checkout_date: "2026-07-27",
			reservation_status: "confirmed",
			hotelId: "other-hotel",
			belongsTo: "other-owner",
			reservationAuditLog: [{ action: "forged" }],
		}),
		{
			checkin_date: "2026-07-25",
			checkout_date: "2026-07-27",
		},
	);
});
