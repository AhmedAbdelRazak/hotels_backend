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

const directHotelRunnerReservation = () => {
	const room = adminManagedRoom();
	return {
		hotelId: "6a40b6a1a6efe70450536038",
		belongsTo: "6a40b6a1a6efe70450536039",
		checkin_date: "2026-07-24",
		checkout_date: "2026-07-26",
		days_of_residence: 2,
		total_amount: 1000,
		sub_total: 150,
		commission: 0,
		adminPricing: {
			mode: "hotelrunner_api",
			clientTotal: 1000,
			rootTotal: 150,
			commercialVerified: false,
		},
		ota_financial_summary: {
			show: true,
			clientTotal: 1000,
			hotelVisibleAmount: 150,
			netAfterExpenses: 56.39,
			otaExpenseTotal: 34.75,
		},
		pickedRoomsType: [room],
		pickedRoomsPricing: [room],
		supplierData: {
			otaAutomationPipeline: "hotelrunner-background-worker",
			otaSourceAuthority: 4,
			hotelRunner: {
				transport: "hotelrunner_api",
				reservationId: "hr-reservation-1",
			},
		},
	};
};

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

test("ordinary HotelRunner date edits reject source-owned stay changes", async () => {
	const existing = directHotelRunnerReservation();
	const changes = [
		{
			payload: { checkin_date: "2026-07-23" },
			details: { checkinChanged: true, checkoutChanged: false },
		},
		{
			payload: { checkout_date: "2026-07-27" },
			details: { checkinChanged: false, checkoutChanged: true },
		},
	];

	for (const change of changes) {
		await assert.rejects(
			() =>
				normalizeReservationStayPricing(existing, {
					...change.payload,
					days_of_residence: 3,
					total_amount: 171,
					sub_total: 225,
					commission: 21,
					adminPricing: { mode: "admin_three_price", clientTotal: 171 },
					pickedRoomsType: existing.pickedRoomsType,
					pickedRoomsPricing: existing.pickedRoomsPricing,
				}),
			(error) => {
				assert.equal(error.statusCode, 409);
				assert.equal(
					error.code,
					"hotelrunner_source_stay_dates_require_projection"
				);
				assert.deepEqual(error.details, change.details);
				return true;
			}
		);
	}

	assert.equal(existing.checkout_date, "2026-07-26");
	assert.equal(existing.days_of_residence, 2);
	assert.deepEqual(
		existing.pickedRoomsPricing[0].pricingByDay.map((day) => day.date),
		["2026-07-24", "2026-07-25"]
	);
});

test("no-op HotelRunner stay-date submissions remain allowed", async () => {
	const existing = directHotelRunnerReservation();
	const updates = await normalizeReservationStayPricing(existing, {
		checkin_date: "2026-07-24T18:00:00.000Z",
		checkout_date: "2026-07-26T09:00:00.000Z",
		days_of_residence: 2,
	});

	assert.equal(updates.checkin_date, "2026-07-24T18:00:00.000Z");
	assert.equal(updates.checkout_date, "2026-07-26T09:00:00.000Z");
	assert.equal(updates.days_of_residence, 2);
});

test("ordinary HotelRunner property reassignment is rejected", async () => {
	const existing = directHotelRunnerReservation();
	for (const change of [
		{
			payload: { hotelId: "6a40b6a1a6efe70450536040" },
			details: { hotelChanged: true, ownerChanged: false },
		},
		{
			payload: { belongsTo: "6a40b6a1a6efe70450536041" },
			details: { hotelChanged: false, ownerChanged: true },
		},
	]) {
		await assert.rejects(
			() => normalizeReservationStayPricing(existing, change.payload),
			(error) => {
				assert.equal(error.statusCode, 409);
				assert.equal(
					error.code,
					"hotelrunner_source_property_requires_projection"
				);
				assert.deepEqual(error.details, change.details);
				return true;
			}
		);
	}
});

test("ordinary HotelRunner room-count changes fail closed before repricing", async () => {
	const existing = directHotelRunnerReservation();
	await assert.rejects(
		() =>
			normalizeReservationStayPricing(existing, {
				pickedRoomsType: [
					{ ...existing.pickedRoomsType[0], count: 2 },
				],
			}),
		(error) => {
			assert.equal(
				error.code,
				"hotelrunner_source_pricing_requires_pricing_payload"
			);
			assert.equal(error.statusCode, 409);
			return true;
		}
	);
});

test("authorized platform-admin pricing replaces complete HotelRunner pricing without changing source commission", async () => {
	const existing = directHotelRunnerReservation();
	existing.commission_ota = 34.75;
	const room = {
		...existing.pickedRoomsPricing[0],
		chosenPrice: 91.14,
		pricingByDay: existing.pickedRoomsPricing[0].pricingByDay.map((day) => ({
			...day,
			price: 91.14,
			clientPrice: 91.14,
			mainPrice: 91.14,
			totalPriceWithCommission: 91.14,
			rootPrice: 75,
			totalPriceWithoutCommission: 75,
			netAfterExpenses: 56.39,
			otaExpenseAmount: 34.75,
		})),
	};

	const updates = await normalizeReservationStayPricing(
		existing,
		{
			pickedRoomsType: [room],
			pickedRoomsPricing: [room],
		},
		{
			hasExplicitAdminPricingIntent: true,
			allowAuthorizedHotelRunnerPricingOverride: true,
		},
	);

	assert.equal(updates.total_amount, 182.28);
	assert.equal(updates.sub_total, 150);
	assert.equal(updates.commission, 0);
	assert.equal(updates.commission_ota, undefined);
	assert.equal(existing.commission_ota, 34.75);
	assert.equal(updates.ota_financial_summary.clientTotal, 182.28);
	assert.equal(updates.ota_financial_summary.hotelVisibleAmount, 150);
	assert.equal(updates.ota_financial_summary.netAfterExpenses, 56.39);
	assert.equal(updates.ota_financial_summary.otaExpenseTotal, 34.75);
	assert.deepEqual(
		updates.pickedRoomsPricing[0].pricingByDay.map((day) => day.price),
		[91.14, 91.14],
	);
});

test("authorized platform-admin extension accepts complete HotelRunner nightly pricing", async () => {
	const existing = directHotelRunnerReservation();
	const room = {
		...existing.pickedRoomsPricing[0],
		pricingByDay: [
			...existing.pickedRoomsPricing[0].pricingByDay,
			{
				date: "2026-07-26",
				price: 91.14,
				clientPrice: 91.14,
				totalPriceWithCommission: 91.14,
				rootPrice: 75,
				totalPriceWithoutCommission: 75,
			},
		],
	};
	const updates = await normalizeReservationStayPricing(
		existing,
		{
			checkout_date: "2026-07-27",
			pickedRoomsType: [room],
			pickedRoomsPricing: [room],
		},
		{
			hasExplicitAdminPricingIntent: true,
			allowAuthorizedHotelRunnerPricingOverride: true,
		},
	);

	assert.equal(updates.days_of_residence, 3);
	assert.equal(updates.total_amount, 171);
	assert.equal(updates.sub_total, 225);
	assert.equal(updates.ota_financial_summary.clientTotal, 171);
	assert.equal(updates.ota_financial_summary.hotelVisibleAmount, 225);
	assert.equal(updates.ota_financial_summary.otaExpenseTotal, 34.75);
	assert.deepEqual(
		updates.pickedRoomsPricing[0].pricingByDay.map((day) => day.date),
		["2026-07-24", "2026-07-25", "2026-07-26"],
	);
	assert.deepEqual(
		updates.pickedRoomsPricing[0].pricingByDay.map((day) => day.price),
		[57, 57, 57],
	);
});

test("authorized HotelRunner room configuration change preserves saved nightly rows and exact total", async () => {
	const existing = directHotelRunnerReservation();
	const changedRoom = {
		...existing.pickedRoomsPricing[0],
		room_type: "familyRooms",
		displayName: "Spacious Six-Bed Room",
		hotelRoomConfigId: "6a4a84216022cd7f31729011",
		chosenPrice: 999,
		pricingByDay: existing.pickedRoomsPricing[0].pricingByDay.map((day) => ({
			...day,
			price: 999,
			totalPriceWithCommission: 999,
			rootPrice: 888,
		})),
	};
	const beforeRows = JSON.parse(
		JSON.stringify(existing.pickedRoomsPricing[0].pricingByDay),
	);

	const updates = await normalizeReservationStayPricing(
		existing,
		{
			pickedRoomsType: [changedRoom],
			pickedRoomsPricing: [changedRoom],
		},
		{
			hasExplicitAdminPricingIntent: true,
			allowAuthorizedHotelRunnerPricingOverride: true,
		},
	);

	assert.equal(updates.pickedRoomsPricing[0].room_type, "familyRooms");
	assert.equal(
		updates.pickedRoomsPricing[0].hotelRoomConfigId,
		"6a4a84216022cd7f31729011",
	);
	assert.deepEqual(updates.pickedRoomsPricing[0].pricingByDay, beforeRows);
	assert.equal(updates.total_amount, existing.total_amount);
	assert.equal(updates.sub_total, existing.sub_total);
	assert.deepEqual(
		updates.ota_financial_summary,
		existing.ota_financial_summary,
	);
});

test("a client pricing-intent flag cannot override HotelRunner source pricing", async () => {
	const existing = directHotelRunnerReservation();
	const room = {
		...existing.pickedRoomsPricing[0],
		pricingByDay: existing.pickedRoomsPricing[0].pricingByDay.map((day) => ({
			...day,
			price: 80,
			totalPriceWithCommission: 80,
			clientPrice: 80,
			rootPrice: 60,
			totalPriceWithoutCommission: 60,
			netAfterExpenses: 70,
		})),
	};
	const updates = await normalizeReservationStayPricing(
		existing,
		{
			pickedRoomsType: [room],
			pickedRoomsPricing: [room],
		},
		{ allowHotelRunnerSourcePricingOverride: true },
	);

	assert.equal(updates.total_amount, undefined);
	assert.equal(updates.sub_total, undefined);
	assert.equal(updates.pickedRoomsType, undefined);
	assert.equal(updates.pickedRoomsPricing, undefined);
	assert.equal(updates.adminPricing, undefined);
});

test("HotelRunner finance-only updates are not stripped by pricing protection", async () => {
	const updates = await normalizeReservationStayPricing(
		directHotelRunnerReservation(),
		{
			commission: 25,
			commissionStatus: "commission due",
		},
	);
	assert.equal(updates.commission, 25);
	assert.equal(updates.commissionStatus, "commission due");
});
