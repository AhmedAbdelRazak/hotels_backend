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
