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

test("OTA commission accepts localized digits, separators, and invisible bidi controls", () => {
	const localized = otaPricing.resolveRequestedOtaCommission({
		commission: "82.50\u200f",
		adminPricing: { commissionAmount: "٨٢٫٥٠" },
	});
	assert.deepEqual(localized, {
		ready: true,
		provided: true,
		amount: 82.5,
		sources: ["commission", "adminPricing.commissionAmount"],
	});
	assert.equal(otaPricing.parseOtaCommissionAmount("82,50").amount, 82.5);
	assert.equal(otaPricing.parseOtaCommissionAmount("٨٢٫٥٠").amount, 82.5);
	assert.equal(otaPricing.parseOtaCommissionAmount("۱٬۲۳۴").amount, 1234);

	for (const value of [
		"۱٬۲۳۴٫۵۰",
		"1,234.50",
		"1.234,50",
		"1 234,50",
	]) {
		assert.deepEqual(otaPricing.parseOtaCommissionAmount(value), {
			ready: true,
			amount: 1234.5,
			normalized: "1234.50",
		});
	}
});

test("OTA commission rejects malformed, negative, and contradictory explicit values", () => {
	assert.equal(
		otaPricing.parseOtaCommissionAmount("82.50 SAR").code,
		"ota_commission_invalid",
	);
	assert.equal(
		otaPricing.resolveRequestedOtaCommission({ commission: "" }).code,
		"ota_commission_invalid",
	);
	assert.equal(
		otaPricing.resolveRequestedOtaCommission({ commission: "-1" }).code,
		"ota_commission_negative",
	);
	assert.equal(
		otaPricing.resolveRequestedOtaCommission({ commission: 82.501 }).code,
		"ota_commission_invalid",
	);
	for (const ambiguous of ["82.500", "82,500"]) {
		assert.equal(
			otaPricing.resolveRequestedOtaCommission({ commission: ambiguous }).code,
			"ota_commission_invalid",
		);
	}
	assert.equal(
		otaPricing.resolveRequestedOtaCommission({ commission: "٨٢٬٥٠" }).code,
		"ota_commission_invalid",
	);
	assert.equal(
		otaPricing.resolveRequestedOtaCommission({
			commission: "82.50",
			adminPricing: { commissionAmount: "83.00" },
		}).code,
		"ota_commission_mismatch",
	);
});

test("omitted OTA commission is distinguishable from an explicit zero", () => {
	assert.deepEqual(otaPricing.resolveRequestedOtaCommission({}), {
		ready: true,
		provided: false,
		amount: null,
		sources: [],
	});
	assert.equal(
		otaPricing.resolveRequestedOtaCommission({ commission: 0 }).amount,
		0,
	);
});

test("omitted commission preserves inconsistent legacy commission fields exactly", () => {
	const now = new Date("2026-08-05T17:30:00.000Z");
	const reservation = {
		commission: 17.125,
		adminPricing: { commissionAmount: 82.5, rootTotal: 825 },
		financial_cycle: {
			commissionType: "percentage",
			commissionValue: 9.75,
			commissionAmount: 80.4375,
			commissionAssigned: true,
		},
	};
	const result = otaPricing.applyOtaCommissionSaveState({
		normalizedUpdate: {
			commission: 0,
			adminPricing: { rootTotal: 900, commissionAmount: 0 },
		},
		reservation: { toObject: () => reservation },
		commissionRequest: otaPricing.resolveRequestedOtaCommission({}),
		now,
		auditActorId: "actor-1",
	});

	assert.equal(result.commission, 17.125);
	assert.equal(result.adminPricing.commissionAmount, 82.5);
	assert.equal(result.financial_cycle.commissionType, "percentage");
	assert.equal(result.financial_cycle.commissionValue, 9.75);
	assert.equal(result.financial_cycle.commissionAmount, 80.4375);
	assert.equal(result.financial_cycle.commissionAssigned, true);
	assert.equal(result.financial_cycle.lastUpdatedAt, now);
});

test("explicit zero converges every saved commission amount to zero", () => {
	const result = otaPricing.applyOtaCommissionSaveState({
		normalizedUpdate: { adminPricing: {} },
		reservation: {
			commission: 17,
			adminPricing: { commissionAmount: 82 },
			financial_cycle: {
				commissionType: "percentage",
				commissionValue: 9,
				commissionAmount: 80,
			},
		},
		commissionRequest: otaPricing.resolveRequestedOtaCommission({
			commission: 0,
		}),
	});
	assert.equal(result.commission, 0);
	assert.equal(result.adminPricing.commissionAmount, 0);
	assert.equal(result.financial_cycle.commissionType, "amount");
	assert.equal(result.financial_cycle.commissionValue, 0);
	assert.equal(result.financial_cycle.commissionAmount, 0);
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

test("generic reservation edits cannot bypass the dedicated OTA pricing workflow", () => {
	const otaReservation = otaEmailReservation(roomId());
	assert.deepEqual(
		otaPricing.validateGenericOtaPricingRoute(otaReservation, {
			hasExplicitPricingIntent: true,
		}),
		{
			ready: false,
			status: 409,
			code: "ota_pricing_dedicated_route_required",
			message:
				"OTA pricing must be changed through the dedicated OTA pricing workflow so the original guest total, saved OTA room identity, nightly prices, and hotel base total remain validated together.",
		}
	);
	assert.equal(
		otaPricing.validateGenericOtaPricingRoute(otaReservation, {
			hasExplicitPricingIntent: false,
		}).ready,
		true,
	);
	assert.equal(
		otaPricing.validateGenericOtaPricingRoute(
			{ booking_source: "manual" },
			{ hasExplicitPricingIntent: true },
		).ready,
		true,
	);
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

test("an explicit platform pricing review can override the OTA source total", () => {
	const configId = roomId();
	const reservation = otaEmailReservation(configId, {
		total_amount: 180.32,
		adminPricing: {
			mode: "ota_review",
			clientTotal: 180.32,
			rootTotal: 120,
			netAfterExpensesTotal: 180.32,
		},
		pickedRoomsPricing: [
			reviewedRoom(configId, {
				pricingByDay: [
					{ date: "2026-08-01", clientPrice: 90.16, rootPrice: 60 },
					{ date: "2026-08-02", clientPrice: 90.16, rootPrice: 60 },
				],
			}),
		],
	});

	const rejected = otaPricing.validateOtaSourceClientPricing(
		reservation,
		reservation.pickedRoomsPricing,
	);
	assert.equal(rejected.ready, false);
	assert.equal(rejected.code, "ota_source_client_total_mismatch");

	const accepted = otaPricing.validateOtaSourceClientPricing(
		reservation,
		reservation.pickedRoomsPricing,
		{ allowSourceClientTotalOverride: true },
	);
	assert.equal(accepted.ready, true);
	assert.equal(accepted.sourceClientTotal, 200);
	assert.equal(accepted.effectiveClientTotal, 180.32);
	assert.equal(accepted.clientTotalOverridden, true);
});

test("a saved reviewed override remains valid during hotel release", () => {
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
	const reservation = otaEmailReservation(configId, {
		total_amount: 180.32,
		adminPricing: {
			mode: "ota_review",
			clientTotal: 180.32,
			rootTotal: 120,
			netAfterExpensesTotal: 180.32,
			clientTotalOverrideActive: true,
			clientTotalOverrideSar: 180.32,
		},
		pickedRoomsType: [
			reviewedRoom(configId, {
				pricingByDay: [
					{ date: "2026-08-01", clientPrice: 90.16, rootPrice: 60 },
					{ date: "2026-08-02", clientPrice: 90.16, rootPrice: 60 },
				],
			}),
		],
		pickedRoomsPricing: [
			reviewedRoom(configId, {
				pricingByDay: [
					{ date: "2026-08-01", clientPrice: 90.16, rootPrice: 60 },
					{ date: "2026-08-02", clientPrice: 90.16, rootPrice: 60 },
				],
			}),
		],
	});

	const release = otaPricing.validateOtaReleaseHotelBasePrice(reservation, {
		hotel,
	});
	assert.equal(release.ready, true);
	assert.equal(release.sourceClientTotal, 200);
	assert.equal(release.effectiveClientTotal, 180.32);
	assert.equal(release.clientTotalOverridden, true);
});

test("an authorized zero hotel base override preserves every other release invariant", () => {
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
	const zeroPriceRoom = reviewedRoom(configId, {
		pricingByDay: [
			{ date: "2026-08-01", clientPrice: 100, rootPrice: 0 },
			{ date: "2026-08-02", clientPrice: 100, rootPrice: 0 },
		],
	});
	const reservation = otaEmailReservation(configId, {
		sub_total: 0,
		adminPricing: {
			mode: "ota_review",
			clientTotal: 200,
			rootTotal: 0,
			netAfterExpensesTotal: 150,
		},
		pickedRoomsType: [zeroPriceRoom],
		pickedRoomsPricing: [zeroPriceRoom],
	});

	const normallyBlocked = otaPricing.validateOtaReleaseHotelBasePrice(
		reservation,
		{ hotel },
	);
	assert.equal(normallyBlocked.ready, false);
	assert.equal(normallyBlocked.code, "ota_hotel_base_price_required");

	const explicitlyAllowed = otaPricing.validateOtaReleaseHotelBasePrice(
		reservation,
		{ hotel, allowZeroHotelBasePrice: true },
	);
	assert.equal(explicitlyAllowed.ready, true);
	assert.equal(explicitlyAllowed.hotelBaseTotal, 0);
	assert.equal(explicitlyAllowed.dailyBaseTotal, 0);
	assert.equal(explicitlyAllowed.zeroHotelBasePriceOverride, true);
	assert.equal(explicitlyAllowed.dailyClientTotal, 200);
	assert.equal(explicitlyAllowed.canonicalRooms[0].hotelRoomConfigId, configId);

	const inconsistentNightlyPrice = {
		...reservation,
		pickedRoomsPricing: [
			reviewedRoom(configId, {
				pricingByDay: [
					{ date: "2026-08-01", clientPrice: 100, rootPrice: 0 },
					{ date: "2026-08-02", clientPrice: 100, rootPrice: 60 },
				],
			}),
		],
	};
	const inconsistent = otaPricing.validateOtaReleaseHotelBasePrice(
		inconsistentNightlyPrice,
		{ hotel, allowZeroHotelBasePrice: true },
	);
	assert.equal(inconsistent.ready, false);
	assert.equal(inconsistent.code, "ota_zero_hotel_base_price_mismatch");
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

test("pricing review preserves saved OTA room identity and accepts only pricing changes", () => {
	const persistedRooms = [
		reviewedRoom("", {
			hotelRoomConfigId: undefined,
			room_type: "familyRooms",
			displayName: "Family - 6 Persons",
			roomMappingStatus: "unreviewed",
		}),
	];
	const requestedRooms = [
		{
			...persistedRooms[0],
			chosenPrice: "88.00",
			pricingByDay: persistedRooms[0].pricingByDay.map((day) => ({
				...day,
				rootPrice: 55,
			})),
		},
	];

	const preserved = otaPricing.preservePersistedOtaRoomIdentity(
		requestedRooms,
		persistedRooms,
	);
	assert.equal(preserved.ready, true);
	assert.equal(preserved.rooms[0].room_type, "familyRooms");
	assert.equal(preserved.rooms[0].displayName, "Family - 6 Persons");
	assert.equal(preserved.rooms[0].count, 1);
	assert.equal(preserved.rooms[0].hotelRoomConfigId, undefined);
	assert.equal(preserved.rooms[0].chosenPrice, "88.00");
	assert.equal(preserved.rooms[0].pricingByDay[0].rootPrice, 55);
	const changedIdentity = otaPricing.preservePersistedOtaRoomIdentity(
		[
			{
				...requestedRooms[0],
				displayName: "Different PMS room",
			},
		],
		persistedRooms,
	);
	assert.equal(changedIdentity.ready, false);
	assert.equal(changedIdentity.code, "ota_room_structure_changed");
	assert.equal(changedIdentity.roomIndex, 0);

	const changedStructure = otaPricing.preservePersistedOtaRoomIdentity(
		[],
		persistedRooms,
	);
	assert.equal(changedStructure.ready, false);
	assert.equal(changedStructure.code, "ota_room_structure_changed");
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

test("room mapping options expose only active canonical PMS room identities", () => {
	const activeId = roomId();
	const inactiveId = roomId();
	const options = otaPricing.otaRoomMappingOptionsForHotel({
		roomCountDetails: [
			{
				_id: activeId,
				roomType: "tripleRooms",
				displayName: "Triple Premium",
				displayName_OtherLanguage: "Arabic triple",
				count: 4,
				activeRoom: true,
				pricingRate: [{ calendarDate: "2026-07-27", rootPrice: 75 }],
			},
			{
				_id: inactiveId,
				roomType: "familyRooms",
				displayName: "Inactive Family",
				count: 20,
				activeRoom: false,
			},
		],
	});

	assert.deepEqual(options, [
		{
			hotelRoomConfigId: activeId,
			room_type: "tripleRooms",
			displayName: "Triple Premium",
			displayNameOtherLanguage: "Arabic triple",
			configuredCount: 4,
		},
	]);
	assert.equal(Object.hasOwn(options[0], "pricingRate"), false);
});

test("release preserves saved OTA room identity and validates root/client totals", () => {
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

	const sourceRoomWithoutConfigId = otaEmailReservation(configId, {
		pickedRoomsType: [
			reviewedRoom(configId, {
				hotelRoomConfigId: undefined,
				room_type: "familyRooms",
				displayName: "Family - 6 Persons",
			}),
		],
		pickedRoomsPricing: [
			reviewedRoom(configId, {
				hotelRoomConfigId: undefined,
				room_type: "familyRooms",
				displayName: "Family - 6 Persons",
			}),
		],
	});
	const preservedAtRelease = otaPricing.validateOtaReleaseHotelBasePrice(
		sourceRoomWithoutConfigId,
		{ hotel },
	);
	assert.equal(preservedAtRelease.ready, true);
	assert.equal(preservedAtRelease.canonicalRooms[0].hotelRoomConfigId, undefined);
	assert.equal(
		preservedAtRelease.canonicalRooms[0].displayName,
		"Family - 6 Persons",
	);

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
	assert.equal(stale.ready, true);
	assert.equal(stale.canonicalRooms[0].displayName, "Deluxe Double");
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
