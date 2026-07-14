const test = require("node:test");
const assert = require("node:assert/strict");
const moment = require("moment-timezone");
const Reservations = require("../models/reservations");
const {
	PaidBreakdownDateFilterError,
	buildPaidBreakdownDateFilter,
	normalizePaidBreakdownDateField,
	parsePaidBreakdownDateOnly,
} = require("../services/paidBreakdownDateFilter");
const { paidBreakdownReportAdmin } = require("../controllers/adminreports");

const HOTEL_ID = "68b74714fb50e159d48c714d";

const expectDateFilterError = (callback, messagePattern) => {
	assert.throws(callback, (error) => {
		assert.ok(error instanceof PaidBreakdownDateFilterError);
		assert.equal(error.statusCode, 400);
		assert.match(error.message, messagePattern);
		return true;
	});
};

const makeResponse = () => ({
	statusCode: 200,
	payload: undefined,
	status(code) {
		this.statusCode = code;
		return this;
	},
	json(payload) {
		this.payload = payload;
		return payload;
	},
});

const clausesFor = (filter) =>
	Array.isArray(filter?.$and) ? filter.$and : filter ? [filter] : [];

const dateClauseFor = (filter, field) =>
	clausesFor(filter).find((clause) => clause?.[field]);

const hasSearchClause = (filter) =>
	clausesFor(filter).some((clause) =>
		clause?.$or?.some(
			(condition) => condition?.confirmation_number instanceof RegExp,
		),
	);

const withReservationReadMocks = async (callback) => {
	const originals = {
		countDocuments: Reservations.countDocuments,
		find: Reservations.find,
		aggregate: Reservations.aggregate,
	};
	const observed = {
		countFilter: null,
		findFilter: null,
		aggregateMatch: null,
	};

	Reservations.countDocuments = async (filter) => {
		observed.countFilter = filter;
		return 0;
	};
	Reservations.find = (filter) => {
		observed.findFilter = filter;
		return {
			sort() {
				return this;
			},
			skip() {
				return this;
			},
			limit() {
				return this;
			},
			populate() {
				return this;
			},
			lean: async () => [],
		};
	};
	Reservations.aggregate = async (pipeline) => {
		observed.aggregateMatch = pipeline?.[0]?.$match || null;
		return [];
	};

	try {
		await callback(observed);
	} finally {
		Reservations.countDocuments = originals.countDocuments;
		Reservations.find = originals.find;
		Reservations.aggregate = originals.aggregate;
	}
};

test("paid report date fields are strictly whitelisted", () => {
	assert.equal(normalizePaidBreakdownDateField(), "createdAt");
	assert.equal(normalizePaidBreakdownDateField("createdAt"), "createdAt");
	assert.equal(
		normalizePaidBreakdownDateField("checkin_date"),
		"checkin_date",
	);
	assert.equal(
		normalizePaidBreakdownDateField("checkout_date"),
		"checkout_date",
	);
	expectDateFilterError(
		() => normalizePaidBreakdownDateField("checkin"),
		/dateBy must be one of/,
	);
	expectDateFilterError(
		() => normalizePaidBreakdownDateField("$where"),
		/dateBy must be one of/,
	);
	expectDateFilterError(
		() => normalizePaidBreakdownDateField(["createdAt"]),
		/dateBy must be one of/,
	);
});

test("an absent range leaves the existing paid report unfiltered by date", () => {
	assert.equal(buildPaidBreakdownDateFilter(), null);
	assert.equal(
		buildPaidBreakdownDateFilter({ dateBy: "checkout_date" }),
		null,
	);
});

test("Riyadh date boundaries are half-open and inclusive of the selected days", () => {
	const filter = buildPaidBreakdownDateFilter({
		dateBy: "checkin_date",
		dateFrom: "2026-07-14",
		dateTo: "2026-07-15",
	});

	assert.deepEqual(Object.keys(filter), ["checkin_date"]);
	assert.equal(
		filter.checkin_date.$gte.toISOString(),
		"2026-07-13T21:00:00.000Z",
	);
	assert.equal(
		filter.checkin_date.$lt.toISOString(),
		"2026-07-15T21:00:00.000Z",
	);
});

test("one-sided paid report ranges retain only the requested boundary", () => {
	const fromOnly = buildPaidBreakdownDateFilter({
		dateFrom: "2026-07-14",
	});
	assert.deepEqual(Object.keys(fromOnly.createdAt), ["$gte"]);
	assert.equal(
		fromOnly.createdAt.$gte.toISOString(),
		"2026-07-13T21:00:00.000Z",
	);

	const toOnly = buildPaidBreakdownDateFilter({
		dateBy: "checkout_date",
		dateTo: "2026-07-14",
	});
	assert.deepEqual(Object.keys(toOnly.checkout_date), ["$lt"]);
	assert.equal(
		toOnly.checkout_date.$lt.toISOString(),
		"2026-07-14T21:00:00.000Z",
	);
});

test("date parsing stays ASCII and deterministic under a non-English global locale", () => {
	const previousLocale = moment.locale();
	try {
		moment.locale("ar-sa");
		const parsed = parsePaidBreakdownDateOnly("2026-07-14", "dateFrom");
		assert.equal(parsed.locale(), "en");
		assert.equal(parsed.format("YYYY-MM-DD"), "2026-07-14");
	} finally {
		moment.locale(previousLocale);
	}
});

test("malformed, localized, and impossible dates are rejected", () => {
	const invalidValues = [
		"2026-7-14",
		"2026/07/14",
		"2026-07-14T00:00:00Z",
		" 2026-07-14",
		"2026-07-14 ",
		"٢٠٢٦-٠٧-١٤",
		"2026-02-30",
		"2026-13-01",
		["2026-07-14"],
		{ date: "2026-07-14" },
	];

	invalidValues.forEach((value) => {
		expectDateFilterError(
			() => buildPaidBreakdownDateFilter({ dateFrom: value }),
			/dateFrom must/,
		);
	});
});

test("reversed ranges are rejected while a single-day range is valid", () => {
	expectDateFilterError(
		() =>
			buildPaidBreakdownDateFilter({
				dateFrom: "2026-07-15",
				dateTo: "2026-07-14",
			}),
		/dateFrom must be on or before dateTo/,
	);

	const sameDay = buildPaidBreakdownDateFilter({
		dateFrom: "2026-07-14",
		dateTo: "2026-07-14",
	});
	assert.equal(
		sameDay.createdAt.$lt.getTime() - sameDay.createdAt.$gte.getTime(),
		24 * 60 * 60 * 1000,
	);
});

test("admin rows, count, and scorecards receive the same selected date range", async () => {
	await withReservationReadMocks(async (observed) => {
		const req = {
			query: {
				hotelId: HOTEL_ID,
				searchQuery: "guest-123",
				dateBy: "checkout_date",
				dateFrom: "2026-07-14",
				dateTo: "2026-07-15",
			},
			profile: { role: 8000 },
		};
		const res = makeResponse();

		await paidBreakdownReportAdmin(req, res);

		assert.equal(res.statusCode, 200);
		assert.deepEqual(res.payload?.data, []);
		assert.equal(observed.findFilter, observed.countFilter);

		const rowDateClause = dateClauseFor(observed.countFilter, "checkout_date");
		const scorecardDateClause = dateClauseFor(
			observed.aggregateMatch,
			"checkout_date",
		);
		assert.ok(rowDateClause);
		assert.ok(scorecardDateClause);
		assert.deepEqual(rowDateClause, scorecardDateClause);
		assert.equal(hasSearchClause(observed.countFilter), true);
		assert.equal(hasSearchClause(observed.aggregateMatch), false);
	});
});

test("admin paid report preserves the unfiltered default when dates are omitted", async () => {
	await withReservationReadMocks(async (observed) => {
		for (const query of [
			{ hotelId: HOTEL_ID },
			{ hotelId: HOTEL_ID, dateBy: "checkin_date" },
		]) {
			const res = makeResponse();
			await paidBreakdownReportAdmin(
				{ query, profile: { role: 8000 } },
				res,
			);

			assert.equal(res.statusCode, 200);
			for (const field of ["createdAt", "checkin_date", "checkout_date"]) {
				assert.equal(dateClauseFor(observed.countFilter, field), undefined);
				assert.equal(dateClauseFor(observed.aggregateMatch, field), undefined);
			}
		}
	});
});

test("invalid admin date queries return 400 before reservation reads", async () => {
	const originals = {
		countDocuments: Reservations.countDocuments,
		find: Reservations.find,
		aggregate: Reservations.aggregate,
	};
	let readCount = 0;
	Reservations.countDocuments = async () => {
		readCount += 1;
		return 0;
	};
	Reservations.find = () => {
		readCount += 1;
		throw new Error("Unexpected reservation read");
	};
	Reservations.aggregate = async () => {
		readCount += 1;
		return [];
	};

	try {
		for (const query of [
			{
				hotelId: HOTEL_ID,
				dateBy: "createdAt",
				dateFrom: "2026-07-15",
				dateTo: "2026-07-14",
			},
			{
				hotelId: HOTEL_ID,
				dateBy: "constructor.prototype",
			},
		]) {
			const res = makeResponse();
			await paidBreakdownReportAdmin(
				{ query, profile: { role: 8000 } },
				res,
			);
			assert.equal(res.statusCode, 400);
			assert.match(res.payload?.error || "", /dateBy|dateFrom/);
		}
		assert.equal(readCount, 0);
	} finally {
		Reservations.countDocuments = originals.countDocuments;
		Reservations.find = originals.find;
		Reservations.aggregate = originals.aggregate;
	}
});
