/** @format */

"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { normalizeReservationStayPricing } = require("./reservationPricing");

const adminManagedRoom = () => ({
	room_type: "tripleRooms",
	displayName: "Triple Room - Premium Comfort",
	count: 1,
	pricingByDay: [
		{
			date: "2026-07-24",
			price: 57,
			totalPriceWithCommission: 57,
			totalPriceWithoutCommission: 75,
			clientPrice: 57,
			rootPrice: 75,
			netAfterExpenses: 57,
		},
		{
			date: "2026-07-25",
			price: 57,
			totalPriceWithCommission: 57,
			totalPriceWithoutCommission: 75,
			clientPrice: 57,
			rootPrice: 75,
			netAfterExpenses: 57,
		},
	],
});

test("admin-managed checkout extension preserves client and hotel pricing separately", async () => {
	const room = adminManagedRoom();
	const existing = {
		hotelId: "6a40b6a1a6efe70450536038",
		checkin_date: "2026-07-24",
		checkout_date: "2026-07-26",
		days_of_residence: 2,
		total_amount: 114,
		sub_total: 150,
		adminPricing: {
			mode: "ota_review",
			clientTotal: 114,
			rootTotal: 150,
		},
		adminPricingVisibility: { rootOnlyForHotelManagement: true },
		pickedRoomsType: [room],
		pickedRoomsPricing: [room],
	};

	const updates = await normalizeReservationStayPricing(existing, {
		checkout_date: "2026-07-27",
	});
	const rows = updates.pickedRoomsPricing[0].pricingByDay;

	assert.deepEqual(
		rows.map((row) => row.date),
		["2026-07-24", "2026-07-25", "2026-07-26"],
	);
	assert.deepEqual(
		rows.map((row) => row.clientPrice),
		[57, 57, 57],
	);
	assert.deepEqual(
		rows.map((row) => row.rootPrice),
		[75, 75, 75],
	);
	assert.equal(updates.days_of_residence, 3);
	assert.equal(updates.total_amount, 171);
	assert.equal(updates.sub_total, 225);
	assert.equal(updates.adminPricing.clientTotal, 171);
	assert.equal(updates.adminPricing.rootTotal, 225);
});

test("validated OTA room remapping preserves reviewed nightly prices and room count", async () => {
	const existingRoom = {
		...adminManagedRoom(),
		displayName: "Triple Bed Room With Air Conditioning",
	};
	const reviewedRoom = {
		...adminManagedRoom(),
		hotelRoomConfigId: "6a40e0981a6d1850eb25c27c",
		displayName: "Triple Room - Premium Comfort",
		count: 2,
		pricingByDay: adminManagedRoom().pricingByDay.map((day) => ({
			...day,
			price: 67.67,
			totalPriceWithCommission: 67.67,
			clientPrice: 67.67,
			rootPrice: 40,
			totalPriceWithoutCommission: 40,
			netAfterExpenses: 50,
		})),
	};
	const existing = {
		hotelId: "6a40b6a1a6efe70450536038",
		checkin_date: "2026-07-24",
		checkout_date: "2026-07-26",
		adminPricing: { mode: "ota_assignment_pending_pricing" },
		adminPricingVisibility: { rootOnlyForHotelManagement: true },
		pickedRoomsType: [existingRoom],
		pickedRoomsPricing: [existingRoom],
	};

	const updates = await normalizeReservationStayPricing(
		existing,
		{
			pickedRoomsType: [reviewedRoom],
			pickedRoomsPricing: [reviewedRoom],
			adminPricing: { mode: "ota_review" },
		},
		{
			hasExplicitAdminPricingIntent: true,
			preserveReviewedRoomPricing: true,
		},
	);

	assert.equal(updates.total_rooms, 2);
	assert.equal(updates.total_amount, 270.68);
	assert.equal(updates.sub_total, 160);
	assert.equal(updates.pickedRoomsPricing[0].hotelRoomConfigId, reviewedRoom.hotelRoomConfigId);
	assert.deepEqual(
		updates.pickedRoomsPricing[0].pricingByDay.map((day) => day.clientPrice),
		[67.67, 67.67],
	);
});
