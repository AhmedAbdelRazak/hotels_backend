/** @format */

"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const CHILD_PROBE_FLAG = "XHOTELPRO_HOTEL_INVENTORY_UTC_PROBE";

const queryResult = (value) => {
	const promise = Promise.resolve(value);
	const query = {
		select() {
			return query;
		},
		populate() {
			return query;
		},
		lean() {
			return query;
		},
		exec() {
			return promise;
		},
		then(resolve, reject) {
			return promise.then(resolve, reject);
		},
		catch(reject) {
			return promise.catch(reject);
		},
	};
	return query;
};

const runUtcDateOnlyProbe = async () => {
	const HotelDetails = require("../models/hotel_details");
	const Reservations = require("../models/reservations");
	const Rooms = require("../models/rooms");
	const inventory = require("./hotel_inventory");

	const hotelId = "64a000000000000000000006";
	const hotel = {
		_id: hotelId,
		hotelName: "UTC Boundary Hotel",
		commission: 10,
		roomCountDetails: [
			{
				roomType: "doubleRooms",
				displayName: "Double Room",
				count: 2,
				bedsCount: 1,
				price: 99,
				defaultCost: 80,
				pricingRate: [
					{
						calendarDate: new Date("2026-08-14T00:00:00.000Z"),
						price: 175,
						rootPrice: 150,
						commissionRate: 10,
					},
				],
			},
		],
	};
	const reservation = {
		_id: "64b000000000000000000006",
		confirmation_number: "UTC-BOUNDARY-1",
		checkin_date: new Date("2026-08-14T00:00:00.000Z"),
		checkout_date: new Date("2026-08-15T00:00:00.000Z"),
		reservation_status: "confirmed",
		state: "confirmed",
		pendingConfirmation: { status: "confirmed" },
		pickedRoomsType: [
			{
				room_type: "doubleRooms",
				displayName: "Double Room",
				count: 1,
			},
		],
		pickedRoomsPricing: [],
		roomId: [],
		bedNumber: [],
	};
	const reservationQueries = [];

	HotelDetails.findById = () => queryResult(hotel);
	Rooms.find = () => queryResult([]);
	Reservations.find = (query) => {
		reservationQueries.push(query);
		return queryResult([reservation]);
	};

	const calendar = await inventory.buildHotelInventoryCalendarPayload(hotelId, {
		start: "2026-08-14",
		end: "2026-08-14",
		includeHistoricalReservations: true,
	});
	const day = await inventory.buildHotelInventoryDayPayload(hotelId, {
		date: "2026-08-14",
		includeHistoricalReservations: true,
	});

	let availabilityStatus = 200;
	let availabilityBody;
	await inventory.getHotelInventoryAvailability(
		{
			params: { hotelId },
			query: { start: "2026-08-14", end: "2026-08-14" },
			auth: { _id: "64c000000000000000000006" },
		},
		{
			status(code) {
				availabilityStatus = code;
				return this;
			},
			json(body) {
				availabilityBody = body;
				return body;
			},
		},
	);

	const isoBounds = (query) => ({
		start: query.checkout_date.$gt.toISOString(),
		endExclusive: query.checkin_date.$lt.toISOString(),
	});
	return {
		resolvedTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
		// This proves the probe really runs west of UTC, where the old local-time
		// implementation shifted the UTC-midnight stay to August 13.
		localCalendarDay: new Date("2026-08-14T00:00:00.000Z").getDate(),
		queries: reservationQueries.map(isoBounds),
		calendar: {
			range: calendar.range,
			date: calendar.days[0]?.date,
			booked: calendar.days[0]?.totals?.booked,
		},
		day: {
			date: day.date,
			booked: day.booked,
			confirmations: day.reservations.map(
				(row) => row.confirmation_number,
			),
		},
		availabilityStatus,
		availability: Array.isArray(availabilityBody)
			? availabilityBody.map((row) => ({
					start: row.start_date,
					end: row.end_date,
					reserved: row.reserved,
					available: row.available,
					pricingDates: row.pricingByDay.map((price) => price.date),
					prices: row.pricingByDay.map((price) => price.price),
			  }))
			: availabilityBody,
	};
};

if (process.env[CHILD_PROBE_FLAG] === "1") {
	runUtcDateOnlyProbe()
		.then((result) => process.stdout.write(JSON.stringify(result)))
		.catch((error) => {
			process.stderr.write(`${error.stack || error}\n`);
			process.exitCode = 1;
		});
} else {
	test("inventory treats UTC-midnight stay and rate dates as date-only values under Pacific time", () => {
		const child = spawnSync(process.execPath, [__filename], {
			cwd: __dirname,
			encoding: "utf8",
			env: {
				...process.env,
				TZ: "America/Los_Angeles",
				[CHILD_PROBE_FLAG]: "1",
			},
		});
		assert.equal(child.status, 0, child.stderr || child.stdout);
		const result = JSON.parse(child.stdout);

		assert.equal(result.localCalendarDay, 13);
		assert.equal(result.resolvedTimezone, "America/Los_Angeles");
		assert.deepEqual(result.queries, [
			{
				start: "2026-08-14T00:00:00.000Z",
				endExclusive: "2026-08-15T00:00:00.000Z",
			},
			{
				start: "2026-08-14T00:00:00.000Z",
				endExclusive: "2026-08-15T00:00:00.000Z",
			},
			{
				start: "2026-08-14T00:00:00.000Z",
				endExclusive: "2026-08-15T00:00:00.000Z",
			},
		]);
		assert.deepEqual(result.calendar, {
			range: { start: "2026-08-14", end: "2026-08-14" },
			date: "2026-08-14",
			booked: 1,
		});
		assert.deepEqual(result.day, {
			date: "2026-08-14",
			booked: 1,
			confirmations: ["UTC-BOUNDARY-1"],
		});
		assert.equal(result.availabilityStatus, 200);
		assert.deepEqual(result.availability, [
			{
				start: "2026-08-14",
				end: "2026-08-14",
				reserved: 1,
				available: 1,
				pricingDates: ["2026-08-14"],
				prices: [175],
			},
		]);
	});
}
