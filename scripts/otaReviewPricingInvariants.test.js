/** @format */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const mongoose = require("mongoose");

const otaPricing = require("../services/otaReviewPricingInvariants");

const roomId = () => String(new mongoose.Types.ObjectId());

const reviewedRoom = (configId, overrides = {}) => ({
	room_type: "doubleRooms",
	displayName: "Deluxe Double",
	hotelRoomConfigId: configId,
	count: 1,
	pricingByDay: [
		{
			date: "2026-08-01",
			clientPrice: 100,
			totalPriceWithCommission: 100,
			rootPrice: 60,
			totalPriceWithoutCommission: 60,
		},
		{
			date: "2026-08-02",
			clientPrice: 100,
			totalPriceWithCommission: 100,
			rootPrice: 60,
			totalPriceWithoutCommission: 60,
		},
	],
	...overrides,
});

const otaEmailReservation = (configId, overrides = {}) => ({
	hotelId: new mongoose.Types.ObjectId(),
	checkin_date: "2026-08-01",
	checkout_date: "2026-08-03",
	total_amount: 200,
	sub_total: 120,
	supplierData: {
		otaCreatedFromEmail: true,
		otaAmountSar: 200,
		otaTotalPayoutSar: 150,
	},
	adminPricing: {
		mode: "ota_review",
		clientTotal: 200,
		rootTotal: 120,
		netAfterExpensesTotal: 150,
	},
	otaPlatformReview: { lastPricingUpdatedAt: new Date() },
	pickedRoomsType: [reviewedRoom(configId)],
	pickedRoomsPricing: [reviewedRoom(configId)],
	...overrides,
});

test("source guest total is locked independently from the OTA payout", () => {
	const resolved = otaPricing.resolveOtaSourceClientTotal(
		otaEmailReservation(roomId()),
	);

	assert.deepEqual(resolved, {
		amount: 200,
		source: "supplierData.otaAmountSar",
	});
});

test("nightly client pricing must reconcile to the immutable OTA guest total", () => {
	const configId = roomId();
	const reservation = otaEmailReservation(configId);
	assert.equal(
		otaPricing.validateOtaSourceClientPricing(
			reservation,
			reservation.pickedRoomsPricing,
		).ready,
		true,
	);

	const payoutMistakenForClientTotal = {
		...reservation,
		total_amount: 150,
		adminPricing: { ...reservation.adminPricing, clientTotal: 150 },
		pickedRoomsPricing: [
			reviewedRoom(configId, {
				pricingByDay: [
					{ date: "2026-08-01", clientPrice: 75, rootPrice: 60 },
					{ date: "2026-08-02", clientPrice: 75, rootPrice: 60 },
				],
			}),
		],
	};
	const rejected = otaPricing.validateOtaSourceClientPricing(
		payoutMistakenForClientTotal,
		payoutMistakenForClientTotal.pickedRoomsPricing,
	);
	assert.equal(rejected.ready, false);
	assert.equal(rejected.code, "ota_source_client_total_mismatch");
	assert.equal(rejected.sourceClientTotal, 200);
	assert.equal(rejected.dailyClientTotal, 150);
});

test("source-total locking does not apply to manual/non-email pricing", () => {
	const rooms = [reviewedRoom(roomId())];
	const manualReservation = {
		total_amount: 150,
		adminPricing: { clientTotal: 150 },
	};
	const validation = otaPricing.validateOtaSourceClientPricing(
		manualReservation,
		rooms,
	);
	assert.equal(validation.ready, true);
});

test("hotel assignment invalidates room ids and hotel-specific root pricing only", () => {
	const invalidated = otaPricing.invalidateOtaRoomPricingForHotelAssignment([
		reviewedRoom(roomId(), {
			roomId: roomId(),
			hotelShouldGet: 120,
			pricingByDay: [
				{
					date: "2026-08-01",
					clientPrice: 200,
					netAfterExpenses: 150,
					rootPrice: 120,
					totalPriceWithoutCommission: 120,
				},
			],
		}),
	]);

	assert.equal(invalidated[0].hotelRoomConfigId, undefined);
	assert.equal(invalidated[0].roomId, undefined);
	assert.equal(invalidated[0].roomMappingStatus, "unreviewed");
	assert.equal(invalidated[0].hotelShouldGet, 0);
	assert.equal(invalidated[0].pricingByDay[0].rootPrice, 0);
	assert.equal(invalidated[0].pricingByDay[0].clientPrice, 200);
	assert.equal(invalidated[0].pricingByDay[0].netAfterExpenses, 150);
});

test("pricing review stamps only an exact unambiguous current hotel room id", () => {
	const doubleObjectId = new mongoose.Types.ObjectId();
	const doubleId = String(doubleObjectId);
	const firstFamilyId = roomId();
	const secondFamilyId = roomId();
	const hotel = {
		roomCountDetails: [
			{
				_id: doubleObjectId,
				roomType: "doubleRooms",
				displayName: "Deluxe Double",
				activeRoom: true,
			},
			{
				_id: firstFamilyId,
				roomType: "familyRooms",
				displayName: "Family Five",
				activeRoom: true,
			},
			{
				_id: secondFamilyId,
				roomType: "familyRooms",
				displayName: "Family Six",
				activeRoom: true,
			},
		],
	};

	const exact = otaPricing.canonicalizeOtaReviewedRooms(
		[reviewedRoom("", { hotelRoomConfigId: undefined })],
		hotel,
	);
	assert.equal(exact.ready, true);
	assert.equal(exact.rooms[0].hotelRoomConfigId, doubleId);
	assert.equal(exact.rooms[0].roomMappingStatus, "reviewed");

	const ambiguous = otaPricing.canonicalizeOtaReviewedRooms(
		[
			reviewedRoom("", {
				hotelRoomConfigId: undefined,
				room_type: "familyRooms",
				displayName: "",
			}),
		],
		hotel,
	);
	assert.equal(ambiguous.ready, false);
	assert.equal(ambiguous.code, "ota_room_mapping_ambiguous");
});

test("release validates the current room identity and both root/client totals", () => {
	const configId = roomId();
	const hotel = {
		roomCountDetails: [
			{
				_id: configId,
				roomType: "doubleRooms",
				displayName: "Deluxe Double",
				activeRoom: true,
			},
		],
	};
	const reservation = otaEmailReservation(configId);
	const valid = otaPricing.validateOtaReleaseHotelBasePrice(reservation, {
		hotel,
	});
	assert.equal(valid.ready, true);
	assert.equal(valid.sourceClientTotal, 200);
	assert.equal(valid.dailyClientTotal, 200);
	assert.equal(valid.hotelBaseTotal, 120);

	const legacyWithoutConfigId = otaEmailReservation(configId, {
		pickedRoomsType: [
			reviewedRoom(configId, { hotelRoomConfigId: undefined }),
		],
		pickedRoomsPricing: [
			reviewedRoom(configId, { hotelRoomConfigId: undefined }),
		],
	});
	const migratedAtRelease = otaPricing.validateOtaReleaseHotelBasePrice(
		legacyWithoutConfigId,
		{ hotel },
	);
	assert.equal(migratedAtRelease.ready, true);
	assert.equal(migratedAtRelease.canonicalRooms[0].hotelRoomConfigId, configId);

	const renamedHotel = {
		roomCountDetails: [
			{
				...hotel.roomCountDetails[0],
				displayName: "Renamed Deluxe Double",
			},
		],
	};
	const stale = otaPricing.validateOtaReleaseHotelBasePrice(reservation, {
		hotel: renamedHotel,
	});
	assert.equal(stale.ready, false);
	assert.equal(stale.code, "ota_room_mapping_stale");
});

test("matching totals cannot hide a missing nightly stay date", () => {
	const configId = roomId();
	const reservation = otaEmailReservation(configId, {
		pickedRoomsPricing: [
			reviewedRoom(configId, {
				pricingByDay: [
					{ date: "2026-08-01", clientPrice: 200, rootPrice: 120 },
				],
			}),
		],
	});
	const validation = otaPricing.validateOtaSourceClientPricing(
		reservation,
		reservation.pickedRoomsPricing,
	);
	assert.equal(validation.ready, false);
	assert.equal(validation.code, "ota_daily_date_coverage_mismatch");
	assert.deepEqual(validation.missingDates, ["2026-08-02"]);
});

test("duplicate and checkout-date nightly rows fail coverage", () => {
	const configId = roomId();
	for (const dates of [
		["2026-08-01", "2026-08-01"],
		["2026-08-01", "2026-08-03"],
	]) {
		const reservation = otaEmailReservation(configId, {
			pickedRoomsPricing: [
				reviewedRoom(configId, {
					pricingByDay: dates.map((date) => ({
						date,
						clientPrice: 100,
						rootPrice: 60,
					})),
				}),
			],
		});
		const validation = otaPricing.validateOtaSourceClientPricing(
			reservation,
			reservation.pickedRoomsPricing,
		);
		assert.equal(validation.ready, false, dates.join(","));
		assert.equal(validation.code, "ota_daily_date_coverage_mismatch");
	}
});

test("invalid OTA stay dates fail before pricing can be released", () => {
	const configId = roomId();
	const reservation = otaEmailReservation(configId, {
		checkout_date: "2026-08-01",
	});
	const validation = otaPricing.validateOtaSourceClientPricing(
		reservation,
		reservation.pickedRoomsPricing,
	);
	assert.equal(validation.ready, false);
	assert.equal(validation.code, "ota_stay_dates_invalid");
});

test("every room in a multi-room review needs complete stay-date coverage", () => {
	const firstId = roomId();
	const secondId = roomId();
	const reservation = otaEmailReservation(firstId, {
		total_amount: 400,
		supplierData: { otaCreatedFromEmail: true, otaAmountSar: 400 },
		adminPricing: { mode: "ota_review", clientTotal: 400, rootTotal: 240 },
		pickedRoomsPricing: [
			reviewedRoom(firstId),
			reviewedRoom(secondId, {
				pricingByDay: [
					{ date: "2026-08-01", clientPrice: 200, rootPrice: 120 },
				],
			}),
		],
	});
	const validation = otaPricing.validateOtaSourceClientPricing(
		reservation,
		reservation.pickedRoomsPricing,
	);
	assert.equal(validation.ready, false);
	assert.equal(validation.code, "ota_daily_date_coverage_mismatch");
	assert.equal(validation.roomIndex, 1);
});

test("OTA sync reservations receive the same source-total and nightly coverage guards", () => {
	const configId = roomId();
	const reservation = otaEmailReservation(configId, {
		supplierData: {
			otaCreatedFromEmail: false,
			otaCreatedFromSync: true,
			otaAutomationPipeline: "ota-reservation-sync-orchestrator",
			otaAmountSar: 200,
		},
		otaPlatformReview: {
			status: "pending",
			source: "ota_sync_create",
			lastPricingUpdatedAt: new Date(),
		},
		pickedRoomsPricing: [
			reviewedRoom(configId, {
				pricingByDay: [
					{ date: "2026-08-01", clientPrice: 200, rootPrice: 120 },
				],
			}),
		],
	});

	assert.equal(otaPricing.isOtaSyncReservation(reservation), true);
	assert.equal(otaPricing.isOtaSourceReservation(reservation), true);
	const validation = otaPricing.validateOtaSourceClientPricing(
		reservation,
		reservation.pickedRoomsPricing,
	);
	assert.equal(validation.ready, false);
	assert.equal(validation.code, "ota_daily_date_coverage_mismatch");
});

test("terminal OTA statuses cannot be released even with otherwise valid pricing", () => {
	const configId = roomId();
	const hotel = {
		roomCountDetails: [
			{
				_id: configId,
				roomType: "doubleRooms",
				displayName: "Deluxe Double",
				activeRoom: true,
			},
		],
	};
	for (const status of [
		"cancelled",
		"void",
		"no_show",
		"inhouse",
		"checked_in",
		"checked_out",
		"early_checked_out",
		"closed",
	]) {
		const reservation = otaEmailReservation(configId, {
			reservation_status: status,
		});
		const validation = otaPricing.validateOtaReleaseHotelBasePrice(reservation, {
			hotel,
		});
		assert.equal(validation.ready, false, status);
		assert.equal(validation.code, "ota_terminal_status_release_blocked", status);
	}
});
