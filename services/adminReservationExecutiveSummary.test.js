const assert = require("node:assert/strict");
const test = require("node:test");
const {
	buildExecutiveDateWindow,
	buildExecutiveReservationMatch,
	buildExecutiveReservationSummary,
	normalizeExecutiveDayFilter,
} = require("./adminReservationExecutiveSummary");

test("executive day filters normalize and use Riyadh calendar boundaries", () => {
	const now = new Date("2026-07-19T02:00:00.000Z");
	assert.equal(normalizeExecutiveDayFilter("Tomorrow"), "tomorrow");
	assert.equal(normalizeExecutiveDayFilter("not-valid"), "today");

	const today = buildExecutiveDateWindow("today", now);
	assert.equal(today.date, "2026-07-19");
	assert.equal(today.start.toISOString(), "2026-07-18T21:00:00.000Z");
	assert.equal(today.end.toISOString(), "2026-07-19T21:00:00.000Z");

	const yesterday = buildExecutiveDateWindow("yesterday", now);
	assert.equal(yesterday.date, "2026-07-18");
	const tomorrow = buildExecutiveDateWindow("tomorrow", now);
	assert.equal(tomorrow.date, "2026-07-20");
});

test("executive match is one read-only OR query with active arrival rules", () => {
	const window = buildExecutiveDateWindow("today", new Date("2026-07-19T02:00:00.000Z"));
	const match = buildExecutiveReservationMatch(window);
	assert.equal(match.$or.length, 3);
	assert.deepEqual(match.$or[0].checkin_date, {
		$gte: window.start,
		$lt: window.end,
	});
	assert.ok(match.$or[0].reservation_status.$nin.includes("cancelled"));
	assert.deepEqual(match.$or[2], {
		createdAt: { $gte: window.start, $lt: window.end },
	});
});

test("executive summary categorizes unique rows without exposing private fields", () => {
	const window = buildExecutiveDateWindow("today", new Date("2026-07-19T02:00:00.000Z"));
	const reservations = [
		{
			_id: "r1",
			confirmation_number: "CONF-1",
			reservation_status: "confirmed",
			checkin_date: "2026-07-19T00:00:00.000Z",
			checkout_date: "2026-07-21T00:00:00.000Z",
			createdAt: "2026-07-19T03:00:00.000Z",
			customer_details: {
				name: "Safe Guest",
				cardNumber: "must-not-leak",
			},
			hotelId: { _id: "h1", hotelName: "Zad Ajyad" },
			total_amount: 560,
			total_rooms: 1,
			total_guests: 2,
		},
		{
			_id: "r2",
			confirmation_number: "CONF-2",
			reservation_status: "confirmed",
			checkout_date: "2026-07-19T04:00:00.000Z",
			createdAt: "2026-07-17T03:00:00.000Z",
		},
		{
			_id: "r3",
			confirmation_number: "CONF-3",
			reservation_status: "cancelled",
			checkin_date: "2026-07-19T02:00:00.000Z",
			createdAt: "2026-07-19T05:00:00.000Z",
		},
	];

	const result = buildExecutiveReservationSummary(reservations, window);
	assert.deepEqual(result.summary, {
		checkins: 1,
		checkouts: 1,
		newReservations: 2,
		totalUniqueReservations: 3,
	});
	assert.deepEqual(result.reservations[0].activityTypes, ["checkin", "new-reservation"]);
	assert.deepEqual(result.reservations[2].activityTypes, ["new-reservation"]);
	assert.equal(JSON.stringify(result).includes("must-not-leak"), false);
});
