/** @format */

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
	bookableFixedPackageRows,
	canonicalPackageDateKey,
	fixedPackageEligibility,
	fixedPackageSelectionsMatch,
	hasFixedPackageReservationSignal,
	packageSelectionSignature,
	saudiTodayKey,
	validateFixedPackageReservationPayload,
} = require("../services/fixedPackagePolicy");

const splitMoney = (amount, count) => {
	const cents = Math.round(Number(amount) * 100);
	const base = Math.floor(cents / count);
	const remainder = cents - base * count;
	return Array.from({ length: count }, (_value, index) =>
		Number(((base + (index < remainder ? 1 : 0)) / 100).toFixed(2)),
	);
};

const dateKeys = (from, nights) => {
	const cursor = new Date(`${from}T00:00:00.000Z`);
	return Array.from({ length: nights }, () => {
		const key = cursor.toISOString().slice(0, 10);
		cursor.setUTCDate(cursor.getUTCDate() + 1);
		return key;
	});
};

const baseHotel = ({ monthly = [], offers = [] } = {}) => ({
	_id: "hotel-1",
	activateHotel: true,
	xHotelProActive: true,
	roomCountDetails: [
		{
			_id: "room-1",
			activeRoom: true,
			roomType: "tripleRooms",
			displayName: "Triple Room",
			displayName_OtherLanguage: "غرفة ثلاثية",
			monthly,
			offers,
		},
	],
});

const packageRow = ({
	type = "monthly",
	id = "package-1",
	from = "2026-07-16",
	to = "2026-08-16",
	guestTotal = 3800,
	rootTotal = 3000,
} = {}) =>
	type === "monthly"
		? {
				_id: id,
				monthName: "Authoritative monthly package",
				monthFrom: `${from}T00:00:00.000Z`,
				monthTo: `${to}T00:00:00.000Z`,
				monthPrice: guestTotal,
				monthRootPrice: rootTotal,
		  }
		: {
				_id: id,
				offerName: "25 Shaaban to 5 Shawwal (display only)",
				offerFrom: `${from}T00:00:00.000Z`,
				offerTo: `${to}T00:00:00.000Z`,
				offerPrice: guestTotal,
				offerRootPrice: rootTotal,
		  };

const packagePayload = ({
	type = "monthly",
	packageId = "package-1",
	from = "2026-07-16",
	to = "2026-08-16",
	guestTotal = 3800,
	rootTotal = 3000,
	payment = "pending_payment",
	displayName = "Triple Room",
	roomType = "tripleRooms",
} = {}) => {
	const nights = Math.round(
		(Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) /
			86400000,
	);
	const markup = String(payment).toLowerCase() === "not paid" ? 1.1 : 1;
	const checkoutGuestTotal = Number((guestTotal * markup).toFixed(2));
	const guestParts = splitMoney(checkoutGuestTotal, nights);
	const rootParts = splitMoney(rootTotal, nights);
	const pricingByDay = dateKeys(from, nights).map((date, index) => ({
		date,
		price: guestParts[index],
		rootPrice: rootParts[index],
		totalPriceWithoutCommission: guestParts[index],
		totalPriceWithCommission: guestParts[index],
	}));
	return {
		hotelId: "hotel-1",
		checkin_date: from,
		checkout_date: to,
		days_of_residence: nights,
		total_amount: checkoutGuestTotal,
		paid_amount: 0,
		payment,
		pickedRoomsType: [
			{
				room_type: roomType,
				displayName,
				count: 1,
				fromPackagesOffers: true,
				lockDates: true,
				datesLocked: true,
				pricingByDay,
				totalPriceWithCommission: checkoutGuestTotal,
				hotelShouldGet: rootTotal,
				packageMeta: {
					type,
					pkgId: packageId,
					roomId: "room-1",
					usesSelectedStayDates: false,
					totalSar: guestTotal,
					totalRootSar: rootTotal,
					nights,
					from,
					to,
				},
			},
		],
	};
};

const NOW = new Date("2026-07-15T22:00:00.000Z"); // 2026-07-16 in Riyadh

test("canonical package dates preserve the stored ISO date prefix", () => {
	assert.equal(
		canonicalPackageDateKey("2026-07-16T23:59:59.000-11:00"),
		"2026-07-16",
	);
	assert.equal(canonicalPackageDateKey("not-a-date"), "");
	assert.equal(saudiTodayKey(NOW), "2026-07-16");
});

test("eligibility is based on stored dates, includes today, and rejects started rows", () => {
	const today = packageRow({ from: "2026-07-16", to: "2026-08-16" });
	const yesterday = packageRow({
		id: "old",
		from: "2026-07-15",
		to: "2026-08-15",
	});
	assert.equal(fixedPackageEligibility(today, "monthly", { now: NOW }).eligible, true);
	assert.equal(
		fixedPackageEligibility(yesterday, "monthly", { now: NOW }).code,
		"fixed_package_already_started",
	);
});

test("public filtering keeps every future subdocument distinct and sorts start then id", () => {
	const rows = [
		packageRow({ id: "b", from: "2026-08-01", to: "2026-09-01" }),
		packageRow({ id: "z", from: "2026-07-15", to: "2026-08-15" }),
		packageRow({ id: "c", from: "2026-07-20", to: "2026-08-20" }),
		packageRow({ id: "a", from: "2026-07-20", to: "2026-08-20" }),
	];
	assert.deepEqual(
		bookableFixedPackageRows(rows, "monthly", { now: NOW }).map((row) => row._id),
		["a", "c", "b"],
	);
});

test("monthly configured price is the full package total and validates exact rows", () => {
	const configured = packageRow();
	const hotel = baseHotel({ monthly: [configured] });
	const payload = packagePayload();
	const result = validateFixedPackageReservationPayload({ payload, hotel, now: NOW });
	assert.equal(result.valid, true);
	assert.equal(result.expectedGuestTotal, 3800);
	assert.equal(result.expectedRootTotal, 3000);
	assert.equal(result.nights, 31);
});

test("offer price is also a package total and is never multiplied by its 39 nights", () => {
	const configured = packageRow({
		type: "offer",
		from: "2027-02-02",
		to: "2027-03-13",
		guestTotal: 3800,
		rootTotal: 3000,
	});
	const hotel = baseHotel({ offers: [configured] });
	const payload = packagePayload({
		type: "offer",
		from: "2027-02-02",
		to: "2027-03-13",
		guestTotal: 3800,
		rootTotal: 3000,
	});
	const result = validateFixedPackageReservationPayload({ payload, hotel, now: NOW });
	assert.equal(result.valid, true);
	assert.equal(result.nights, 39);
	assert.equal(result.expectedGuestTotal, 3800);

	payload.pickedRoomsType[0].packageMeta.totalSar = 3800 * 39;
	payload.total_amount = 3800 * 39;
	assert.equal(
		validateFixedPackageReservationPayload({ payload, hotel, now: NOW }).code,
		"fixed_package_guest_total_mismatch",
	);
});

test("distinct package rows sharing one window stay separate and sum exact totals", () => {
	const first = packageRow({ id: "offer-a", guestTotal: 900, rootTotal: 800 });
	const second = packageRow({ id: "offer-b", guestTotal: 1300, rootTotal: 1000 });
	const hotel = baseHotel({ monthly: [first, second] });
	const payload = packagePayload({
		packageId: "offer-a",
		guestTotal: 900,
		rootTotal: 800,
	});
	const secondPayload = packagePayload({
		packageId: "offer-b",
		guestTotal: 1300,
		rootTotal: 1000,
	});
	payload.pickedRoomsType.push(secondPayload.pickedRoomsType[0]);
	payload.total_amount = 2200;

	const result = validateFixedPackageReservationPayload({ payload, hotel, now: NOW });
	assert.equal(result.valid, true);
	assert.equal(result.expectedGuestTotal, 2200);
	assert.deepEqual(
		result.selections.map((selection) => selection.packageId),
		["offer-a", "offer-b"],
	);
});

test("pay-in-hotel accepts only the existing 1.1 guest markup and keeps root unchanged", () => {
	const configured = packageRow();
	const hotel = baseHotel({ monthly: [configured] });
	const payload = packagePayload({ payment: "Not Paid" });
	const result = validateFixedPackageReservationPayload({ payload, hotel, now: NOW });
	assert.equal(result.valid, true);
	assert.equal(result.expectedGuestTotal, 4180);
	assert.equal(result.expectedBaseGuestTotal, 3800);
	assert.equal(result.expectedRootTotal, 3000);
	assert.equal(result.payInHotelMarkupApplied, true);
	assert.equal(result.guestMarkup, 1.1);
});

test("internal OrderTaker can explicitly retain the configured package total", () => {
	const configured = packageRow();
	const hotel = baseHotel({ monthly: [configured] });
	const payload = packagePayload();
	payload.payment = "Not Paid";
	payload.paid_amount = 0;

	const publicResult = validateFixedPackageReservationPayload({
		payload,
		hotel,
		now: NOW,
	});
	assert.equal(publicResult.code, "fixed_package_daily_guest_total_mismatch");

	const internalResult = validateFixedPackageReservationPayload({
		payload,
		hotel,
		now: NOW,
		applyPayInHotelMarkup: false,
	});
	assert.equal(internalResult.valid, true);
	assert.equal(internalResult.expectedGuestTotal, 3800);
	assert.equal(internalResult.expectedRootTotal, 3000);
	assert.equal(internalResult.payInHotel, true);
	assert.equal(internalResult.payInHotelMarkupApplied, false);
	assert.equal(internalResult.guestMarkup, 1);
});

test("validator binds package id, room id, room identity, dates, and totals", () => {
	const configured = packageRow();
	const hotel = baseHotel({ monthly: [configured] });
	const wrongRoomName = packagePayload({ displayName: "Quadruple Room" });
	assert.equal(
		validateFixedPackageReservationPayload({
			payload: wrongRoomName,
			hotel,
			now: NOW,
		}).code,
		"fixed_package_room_identity_mismatch",
	);

	const sliced = packagePayload();
	sliced.checkout_date = "2026-08-15";
	assert.equal(
		validateFixedPackageReservationPayload({ payload: sliced, hotel, now: NOW }).code,
		"fixed_package_top_level_window_mismatch",
	);

	const badCount = packagePayload();
	badCount.pickedRoomsType[0].count = 2;
	assert.equal(
		validateFixedPackageReservationPayload({ payload: badCount, hotel, now: NOW }).code,
		"fixed_package_reference_invalid",
	);
});

test("optional room total must equal the exact daily-row sum", () => {
	const configured = packageRow();
	const hotel = baseHotel({ monthly: [configured] });
	const payload = packagePayload();
	payload.pickedRoomsType[0].totalPriceWithCommission += 1;
	assert.equal(
		validateFixedPackageReservationPayload({ payload, hotel, now: NOW }).code,
		"fixed_package_room_guest_total_mismatch",
	);
});

test("non-package reservations remain untouched", () => {
	const result = validateFixedPackageReservationPayload({
		payload: {
			hotelId: "hotel-1",
			pickedRoomsType: [{ room_type: "tripleRooms", count: 1 }],
		},
		hotel: {},
		now: NOW,
	});
	assert.deepEqual(result, { applies: false, valid: true });
});

test("package signal detection checks either supported room array", () => {
	const signalledRoom = packagePayload().pickedRoomsType[0];
	assert.equal(hasFixedPackageReservationSignal({}), false);
	assert.equal(
		hasFixedPackageReservationSignal({
			pickedRoomsType: [{ room_type: "tripleRooms" }],
		}),
		false,
	);
	assert.equal(
		hasFixedPackageReservationSignal({ pickedRoomsType: [signalledRoom] }),
		true,
	);
	assert.equal(
		hasFixedPackageReservationSignal({ pickedRoomsPricing: [signalledRoom] }),
		true,
	);

	const mismatchedArrays = {
		pickedRoomsType: [{ room_type: "tripleRooms" }],
		pickedRoomsPricing: [signalledRoom],
	};
	assert.equal(
		validateFixedPackageReservationPayload({
			payload: mismatchedArrays,
			hotel: baseHotel({ monthly: [packageRow()] }),
			now: NOW,
		}).code,
		"fixed_package_room_payload_mismatch",
	);
});

test("pending and final selection signatures are stable but detect package changes", () => {
	const first = packageRow();
	const second = packageRow({ id: "package-2" });
	const hotel = baseHotel({ monthly: [first, second] });
	const pending = validateFixedPackageReservationPayload({
		payload: packagePayload(),
		hotel,
		now: NOW,
	});
	const sameFinal = validateFixedPackageReservationPayload({
		payload: packagePayload({ payment: "Paid Online" }),
		hotel,
		now: NOW,
	});
	const changedFinal = validateFixedPackageReservationPayload({
		payload: packagePayload({ packageId: "package-2", payment: "Paid Online" }),
		hotel,
		now: NOW,
	});
	assert.equal(packageSelectionSignature(pending), packageSelectionSignature(sameFinal));
	assert.notEqual(
		packageSelectionSignature(pending),
		packageSelectionSignature(changedFinal),
	);
	assert.equal(fixedPackageSelectionsMatch(pending, sameFinal), true);
	assert.equal(fixedPackageSelectionsMatch(pending, changedFinal), false);
});

test("pending reuse rejects package/standard applicability mismatches both ways", () => {
	const configured = packageRow();
	const hotel = baseHotel({ monthly: [configured] });
	const fixedPackage = validateFixedPackageReservationPayload({
		payload: packagePayload(),
		hotel,
		now: NOW,
	});
	const standard = { applies: false, valid: true };
	assert.equal(fixedPackageSelectionsMatch(fixedPackage, standard), false);
	assert.equal(fixedPackageSelectionsMatch(standard, fixedPackage), false);
	assert.equal(
		fixedPackageSelectionsMatch(standard, { applies: false, valid: true }),
		true,
	);
});
