/** @format */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
	canEditHotelReservation,
	isExplicitRoomAssignmentOnlyUpdate,
	sanitizeHotelReservationUpdate,
	shouldPreserveWorkflowForRoomAssignmentOnly,
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

test("recognizes only an exact explicit room-assignment update", () => {
	assert.equal(
		isExplicitRoomAssignmentOnlyUpdate({
			roomId: ["room-419"],
			__roomAssignmentUpdateIntent: true,
		}),
		true,
	);
	assert.equal(
		isExplicitRoomAssignmentOnlyUpdate({
			roomId: [],
			__housingUpdateIntent: "true",
		}),
		true,
	);

	for (const payload of [
		{ roomId: ["room-419"] },
		{ roomId: ["room-419"], __roomAssignmentUpdateIntent: false },
		{ __roomAssignmentUpdateIntent: true },
		{
			roomId: ["room-419"],
			__roomAssignmentUpdateIntent: true,
			customer_details: { name: "Corrected guest" },
		},
		{
			roomId: ["room-419"],
			__roomAssignmentUpdateIntent: true,
			sendEmail: false,
		},
	]) {
		assert.equal(isExplicitRoomAssignmentOnlyUpdate(payload), false);
	}
});

test("preserves workflow only for the strict hotel-management room update", () => {
	const payload = {
		roomId: ["room-419"],
		__roomAssignmentUpdateIntent: true,
	};
	assert.equal(
		shouldPreserveWorkflowForRoomAssignmentOnly({
			hotelManagementReservationUpdate: true,
			payload,
		}),
		true,
	);
	assert.equal(
		shouldPreserveWorkflowForRoomAssignmentOnly({
			hotelManagementReservationUpdate: false,
			payload,
		}),
		false,
	);
	assert.equal(
		shouldPreserveWorkflowForRoomAssignmentOnly({
			hotelManagementReservationUpdate: true,
			payload: { ...payload, comment: "also correct the reservation" },
		}),
		false,
	);
});

test("room-only updates are wired out of rejected-reservation resubmission", () => {
	const controllerSource = fs.readFileSync(
		path.resolve(__dirname, "../controllers/reservations.js"),
		"utf8",
	);
	const resubmissionPredicate = controllerSource.match(
		/const shouldAdminEditResubmitRejectedReservation = \([\s\S]*?;\r?\n\r?\nconst buildAdminCorrectionResubmission/,
	)?.[0];

	assert.ok(resubmissionPredicate);
	assert.doesNotMatch(
		resubmissionPredicate,
		/isExplicitRoomAssignmentOnlyUpdate/,
	);
	assert.match(
		controllerSource,
		/shouldAdminUpdateResubmitRejectedReservation\(\{[\s\S]*?hotelManagementReservationUpdate:/,
	);
	assert.match(
		controllerSource,
		/!preserveWorkflowForRoomAssignmentOnly\s*&&\s*updatedReservation\.reservation_status/,
	);
});
