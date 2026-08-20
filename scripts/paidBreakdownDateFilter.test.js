const test = require("node:test");
const assert = require("node:assert/strict");
const moment = require("moment-timezone");
const Reservations = require("../models/reservations");
const {
	MAX_PAID_BREAKDOWN_DATE_RANGES,
	PaidBreakdownDateFilterError,
	buildPaidBreakdownDateFilter,
	buildPaidBreakdownUpdatedFilter,
	normalizePaidBreakdownDateField,
	normalizePaidBreakdownUpdatedFilter,
	parsePaidBreakdownDateOnly,
	parsePaidBreakdownDateRanges,
	serializePaidBreakdownDateRanges,
} = require("../services/paidBreakdownDateFilter");
const { paidBreakdownReportAdmin } = require("../controllers/adminreports");
const {
	paymentAmountCentsExpression,
} = require("../services/paymentReconciliation");

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

const dateRangeClausesFor = (filter, field) =>
	clausesFor(filter).flatMap((clause) =>
		Array.isArray(clause?.$or)
			? clause.$or.filter((condition) => condition?.[field])
			: [],
	);

const breakdownUpdatedClauseFor = (filter) =>
	clausesFor(filter).find((clause) =>
		clause?.$or?.some(
			(condition) => condition?.paid_amount_breakdown_updated_at
		)
	);

const withReservationReadMocks = async (
	callback,
	{
		rowReservations = [],
		financialReservations = [],
		aggregateResult = [],
		count = rowReservations.length,
	} = {},
) => {
	const originals = {
		countDocuments: Reservations.countDocuments,
		find: Reservations.find,
		aggregate: Reservations.aggregate,
	};
	const observed = {
		countFilter: null,
		findCalls: [],
		aggregateMatch: null,
		aggregatePipeline: null,
	};

	Reservations.countDocuments = async (filter) => {
		observed.countFilter = filter;
		return count;
	};
	Reservations.find = (filter) => {
		const call = { filter, projection: null, includesReconciliation: false };
		observed.findCalls.push(call);
		const chain = {
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
			select(projection) {
				if (projection === "+payment_reconciliation") {
					call.includesReconciliation = true;
				} else {
					call.projection = projection;
				}
				return this;
			},
			lean: async () =>
				call.projection ? financialReservations : rowReservations,
		};
		return chain;
	};
	Reservations.aggregate = async (pipeline) => {
		observed.aggregatePipeline = pipeline;
		observed.aggregateMatch = pipeline?.[0]?.$match || null;
		return aggregateResult;
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

test("payment breakdown update scope defaults to all and rejects unknown values", () => {
	assert.equal(normalizePaidBreakdownUpdatedFilter(), "all");
	assert.equal(normalizePaidBreakdownUpdatedFilter(" ALL "), "all");
	assert.equal(normalizePaidBreakdownUpdatedFilter("Yesterday"), "yesterday");
	assert.equal(normalizePaidBreakdownUpdatedFilter("today"), "today");
	assert.equal(
		normalizePaidBreakdownUpdatedFilter("LAST_7_DAYS"),
		"last_7_days"
	);
	assert.equal(buildPaidBreakdownUpdatedFilter(), null);
	for (const value of ["tomorrow", "$where", ["today"], { day: "today" }]) {
		expectDateFilterError(
			() => normalizePaidBreakdownUpdatedFilter(value),
			/breakdownUpdated must be one of/
		);
	}
});

test("relative update scopes use Riyadh half-open days with a legacy audit fallback", () => {
	const referenceDate = new Date("2026-08-20T18:30:00.000Z");
	const today = buildPaidBreakdownUpdatedFilter("today", referenceDate);
	const yesterday = buildPaidBreakdownUpdatedFilter(
		"yesterday",
		referenceDate
	);
	const lastSevenDays = buildPaidBreakdownUpdatedFilter(
		"last_7_days",
		referenceDate
	);

	const todayRange = today.$or[0].paid_amount_breakdown_updated_at;
	assert.equal(todayRange.$gte.toISOString(), "2026-08-19T21:00:00.000Z");
	assert.equal(todayRange.$lt.toISOString(), "2026-08-20T21:00:00.000Z");
	const yesterdayRange =
		yesterday.$or[0].paid_amount_breakdown_updated_at;
	assert.equal(
		yesterdayRange.$gte.toISOString(),
		"2026-08-18T21:00:00.000Z"
	);
	assert.equal(
		yesterdayRange.$lt.toISOString(),
		"2026-08-19T21:00:00.000Z"
	);
	const lastSevenDaysRange =
		lastSevenDays.$or[0].paid_amount_breakdown_updated_at;
	assert.equal(
		lastSevenDaysRange.$gte.toISOString(),
		"2026-08-13T21:00:00.000Z"
	);
	assert.equal(
		lastSevenDaysRange.$lt.toISOString(),
		"2026-08-20T21:00:00.000Z"
	);

	const legacyFallback = today.$or[1];
	assert.deepEqual(legacyFallback.$and[0], {
		paid_amount_breakdown_updated_at: null,
	});
	const expressionText = JSON.stringify(legacyFallback.$and[1]);
	assert.match(expressionText, /adminChangeLog/);
	assert.match(expressionText, /paid_amount_breakdown/);
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

test("serialized noncontiguous ranges preserve their gap as one sorted Mongo $or", () => {
	const filter = buildPaidBreakdownDateFilter({
		dateBy: "checkout_date",
		dateRanges:
			"2026-03-01..2026-03-31,2026-01-01..2026-01-31",
	});

	assert.deepEqual(Object.keys(filter), ["$or"]);
	assert.equal(filter.$or.length, 2);
	assert.deepEqual(
		filter.$or.map((clause) => ({
			gte: clause.checkout_date.$gte.toISOString(),
			lt: clause.checkout_date.$lt.toISOString(),
		})),
		[
			{
				gte: "2025-12-31T21:00:00.000Z",
				lt: "2026-01-31T21:00:00.000Z",
			},
			{
				gte: "2026-02-28T21:00:00.000Z",
				lt: "2026-03-31T21:00:00.000Z",
			},
		],
	);

	const includedByFilter = (isoTimestamp) => {
		const timestamp = new Date(isoTimestamp).getTime();
		return filter.$or.some((clause) => {
			const range = clause.checkout_date;
			return timestamp >= range.$gte.getTime() && timestamp < range.$lt.getTime();
		});
	};
	assert.equal(includedByFilter("2026-01-15T12:00:00.000Z"), true);
	assert.equal(includedByFilter("2026-02-15T12:00:00.000Z"), false);
	assert.equal(includedByFilter("2026-03-15T12:00:00.000Z"), true);
});

test("date range parsing and serialization sort and dedupe deterministically", () => {
	const serialized = serializePaidBreakdownDateRanges([
		{ dateFrom: "2026-07-01", dateTo: "2026-07-31" },
		{ dateFrom: "2026-01-01", dateTo: "2026-01-31" },
		{ dateFrom: "2026-07-01", dateTo: "2026-07-31" },
		{ dateFrom: "2026-01-01", dateTo: "2026-01-15" },
	]);
	assert.equal(
		serialized,
		"2026-01-01..2026-01-15,2026-01-01..2026-01-31,2026-07-01..2026-07-31",
	);

	const parsed = parsePaidBreakdownDateRanges(
		"2026-07-01..2026-07-31,2026-01-01..2026-01-31,2026-07-01..2026-07-31",
	);
	assert.deepEqual(
		parsed.map(({ dateFrom, dateTo }) => ({ dateFrom, dateTo })),
		[
			{ dateFrom: "2026-01-01", dateTo: "2026-01-31" },
			{ dateFrom: "2026-07-01", dateTo: "2026-07-31" },
		],
	);
	assert.equal(serializePaidBreakdownDateRanges([]), "");
});

test("dateRanges accepts at most twelve input ranges before deduplication", () => {
	const rangeForMonth = (month) => {
		const padded = String(month).padStart(2, "0");
		return `2026-${padded}-01..2026-${padded}-01`;
	};
	const twelve = Array.from(
		{ length: MAX_PAID_BREAKDOWN_DATE_RANGES },
		(_, index) => rangeForMonth(index + 1),
	).join(",");
	assert.equal(
		buildPaidBreakdownDateFilter({ dateRanges: twelve }).$or.length,
		MAX_PAID_BREAKDOWN_DATE_RANGES,
	);

	const thirteenDuplicates = Array.from(
		{ length: MAX_PAID_BREAKDOWN_DATE_RANGES + 1 },
		() => "2026-01-01..2026-01-01",
	).join(",");
	expectDateFilterError(
		() => buildPaidBreakdownDateFilter({ dateRanges: thirteenDuplicates }),
		/cannot contain more than 12 ranges/,
	);
});

test("dateRanges rejects malformed, one-sided, reversed, injected, and mixed inputs", () => {
	const invalidSerializedValues = [
		"2026-01-01..",
		"..2026-01-31",
		"2026-01-31..2026-01-01",
		"2026-02-30..2026-03-01",
		"2026-01-01...2026-01-31",
		"2026-01-01/2026-01-31",
		" 2026-01-01..2026-01-31",
		"2026-01-01..2026-01-31 ",
		"2026-01-01..2026-01-31,",
		"2026-01-01..2026-01-31,$where..2026-02-01",
		'{"$gte":"2026-01-01"}',
		["2026-01-01..2026-01-31"],
		{ range: "2026-01-01..2026-01-31" },
	];

	invalidSerializedValues.forEach((dateRanges) => {
		expectDateFilterError(
			() => buildPaidBreakdownDateFilter({ dateRanges }),
			/dateRanges/,
		);
	});

	for (const scalarBoundary of [
		{ dateFrom: "2026-01-01" },
		{ dateTo: "2026-01-31" },
		{ dateFrom: "2026-01-01", dateTo: "2026-01-31" },
	]) {
		expectDateFilterError(
			() =>
				buildPaidBreakdownDateFilter({
					dateRanges: "2026-03-01..2026-03-31",
					...scalarBoundary,
				}),
			/cannot be combined/,
		);
	}
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

test("admin paid rows and scorecards exclude only cancelled reservation statuses", async () => {
	await withReservationReadMocks(async (observed) => {
		const res = makeResponse();
		await paidBreakdownReportAdmin(
			{
				query: { hotelId: HOTEL_ID },
				profile: { role: 8000 },
			},
			res,
		);

		assert.equal(res.statusCode, 200);
		for (const filter of [observed.countFilter, observed.aggregateMatch]) {
			const exclusion = clausesFor(filter).find(
				(clause) =>
					clause?.reservation_status?.$not instanceof RegExp &&
					clause?.state?.$not instanceof RegExp,
			);
			assert.ok(exclusion);
			for (const cancelled of ["cancelled", "canceled", "cancelled_by_guest"]) {
				assert.equal(exclusion.reservation_status.$not.test(cancelled), true);
				assert.equal(exclusion.state.$not.test(cancelled), true);
			}
			for (const included of [
				"checked_out",
				"inhouse",
				"no_show",
				"confirmed",
				"pending",
				"rejected",
			]) {
				assert.equal(exclusion.reservation_status.$not.test(included), false);
				assert.equal(exclusion.state.$not.test(included), false);
			}
		}
	});
});

test("admin rows/count and scorecards share date scope while search stays row-only", async () => {
	await withReservationReadMocks(async (observed) => {
		const req = {
			query: {
				hotelId: HOTEL_ID,
				searchQuery: "guest-123",
				dateBy: "checkout_date",
				dateFrom: "2026-07-14",
				dateTo: "2026-07-15",
				breakdownUpdated: "today",
			},
			profile: { role: 8000 },
		};
		const res = makeResponse();

		await paidBreakdownReportAdmin(req, res);

		assert.equal(res.statusCode, 200);
		assert.deepEqual(res.payload?.data, []);
		assert.equal(res.payload?.totalMode, "gross");
		assert.equal(res.payload?.scorecards?.totalMode, "gross");
		assert.equal(observed.findCalls.length, 2);
		const [rowFind, financialScorecardFind] = observed.findCalls;
		assert.equal(rowFind.projection, null);
		assert.equal(rowFind.filter, observed.countFilter);
		assert.equal(financialScorecardFind.filter, observed.aggregateMatch);
		assert.match(
			financialScorecardFind.projection,
			/\badminPricing\b/,
		);

		const rowDateClause = dateClauseFor(observed.countFilter, "checkout_date");
		const scorecardDateClause = dateClauseFor(
			observed.aggregateMatch,
			"checkout_date",
		);
		assert.ok(rowDateClause);
		assert.ok(scorecardDateClause);
		assert.deepEqual(rowDateClause, scorecardDateClause);
		assert.deepEqual(
			breakdownUpdatedClauseFor(observed.countFilter),
			breakdownUpdatedClauseFor(observed.aggregateMatch)
		);
		assert.equal(res.payload.breakdownUpdated, "today");
		assert.equal(hasSearchClause(observed.countFilter), true);
		assert.equal(hasSearchClause(observed.aggregateMatch), false);
	});
});

test("admin multi-date ranges reach rows/count and both net scorecard reads", async () => {
	await withReservationReadMocks(async (observed) => {
		const res = makeResponse();
		await paidBreakdownReportAdmin(
			{
				query: {
					hotelId: HOTEL_ID,
					dateBy: "checkin_date",
					dateRanges:
						"2026-01-01..2026-01-31,2026-03-01..2026-03-31",
					totalMode: "NET",
				},
				profile: { role: 8000 },
			},
			res,
		);

		assert.equal(res.statusCode, 200);
		assert.equal(res.payload?.totalMode, "net");
		assert.equal(res.payload?.scorecards?.totalMode, "net");
		assert.equal(observed.findCalls.length, 2);
		const [rowFind, financialScorecardFind] = observed.findCalls;
		assert.equal(rowFind.filter, observed.countFilter);
		assert.equal(financialScorecardFind.filter, observed.aggregateMatch);

		const rowRanges = dateRangeClausesFor(
			observed.countFilter,
			"checkin_date",
		);
		const scorecardRanges = dateRangeClausesFor(
			observed.aggregateMatch,
			"checkin_date",
		);
		assert.equal(rowRanges.length, 2);
		assert.deepEqual(rowRanges, scorecardRanges);
	});
});

test("admin paid report preserves the unfiltered default when dates are omitted", async () => {
	await withReservationReadMocks(async (observed) => {
		for (const query of [
			{ hotelId: HOTEL_ID },
			{ hotelId: HOTEL_ID, dateBy: "checkin_date" },
		]) {
			const findCallStart = observed.findCalls.length;
			const res = makeResponse();
			await paidBreakdownReportAdmin(
				{ query, profile: { role: 8000 } },
				res,
			);

			assert.equal(res.statusCode, 200);
			const currentFindCalls = observed.findCalls.slice(findCallStart);
			assert.equal(currentFindCalls.length, 2);
			assert.equal(currentFindCalls[0].filter, observed.countFilter);
			assert.equal(currentFindCalls[1].filter, observed.aggregateMatch);
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
			{
				hotelId: HOTEL_ID,
				breakdownUpdated: "tomorrow",
			},
		]) {
			const res = makeResponse();
			await paidBreakdownReportAdmin(
				{ query, profile: { role: 8000 } },
				res,
			);
			assert.equal(res.statusCode, 400);
			assert.match(
				res.payload?.error || "",
				/dateBy|dateFrom|breakdownUpdated/
			);
		}
		assert.equal(readCount, 0);
	} finally {
		Reservations.countDocuments = originals.countDocuments;
		Reservations.find = originals.find;
		Reservations.aggregate = originals.aggregate;
	}
});

test("paid report returns mixed rows with overlapping clickable reconciliation counts", async () => {
	const row = {
		_id: "68b74714fb50e159d48c714e",
		hotelId: HOTEL_ID,
		currency: "SAR",
		total_amount: 200,
		paid_amount_breakdown: {
			paid_at_hotel_cash: 100,
			paid_at_hotel_card: 25,
			paid_online_other_platforms: 75,
		},
		payment_reconciliation: {
			breakdown: {
				paid_at_hotel_cash: {
					status: "reconciled",
					amountCents: 10000,
					reconciledBy: { email: "private-paid-actor@example.com" },
					batchId: "private-paid-entry-batch",
					note: "private paid entry note",
				},
			},
		},
		adminChangeLog: [
			{ field: "safe_field", note: "safe audit" },
			{
				field: "payment_reconciliation",
				batchId: "private-batch",
				note: "private note",
			},
		],
		reservationAuditLog: [
			{ type: "safe_type", note: "safe audit" },
			{
				type: "payment_reconciliation_status_update",
				batchId: "private-batch",
				note: "private note",
			},
		],
	};
	await withReservationReadMocks(
		async (observed) => {
			const res = makeResponse();
			await paidBreakdownReportAdmin(
				{
					query: {
						hotelId: HOTEL_ID,
						searchQuery: "guest-123",
						dateBy: "createdAt",
						dateFrom: "2026-07-01",
						paymentBreakdownKeys:
							"paid_at_hotel_cash,paid_at_hotel_card",
						reconciliationStatus: "waiting",
					},
					profile: { role: 8000 },
				},
				res
			);

			assert.equal(res.statusCode, 200);
			assert.deepEqual(res.payload.selectedPaymentBreakdownKeys, [
				"paid_at_hotel_cash",
				"paid_at_hotel_card",
			]);
			assert.equal(res.payload.reconciliationStatus, "waiting");
			assert.equal(res.payload.data[0].selected_breakdown_total_cents, 12500);
			assert.equal(res.payload.data[0].reconciliation_status, "mixed");
			assert.equal(res.payload.data[0].payment_reconciliation, undefined);
			assert.deepEqual(res.payload.data[0].adminChangeLog, [
				{ field: "safe_field", note: "safe audit" },
			]);
			assert.deepEqual(res.payload.data[0].reservationAuditLog, [
				{ type: "safe_type", note: "safe audit" },
			]);
			assert.deepEqual(
				Object.keys(
					res.payload.data[0].reconciliation_by_breakdown
						.paid_at_hotel_cash
				).sort(),
				[
					"amount",
					"amountCents",
					"hasStoredEntry",
					"reconciled",
					"stale",
					"status",
				].sort()
			);
			assert.equal(
				res.payload.data[0].reconciliation_by_breakdown
					.paid_at_hotel_cash.hasStoredEntry,
				true
			);
			assert.equal(
				res.payload.data[0].reconciliation_by_breakdown
					.paid_at_hotel_card.hasStoredEntry,
				false
			);
			const serializedRow = JSON.stringify(res.payload.data[0]);
			for (const privateValue of [
				"private-paid-actor@example.com",
				"private-paid-entry-batch",
				"private paid entry note",
			]) {
				assert.equal(serializedRow.includes(privateValue), false);
			}
			assert.equal(res.payload.reconciliationSummary.totalAmountCents, 12500);
			assert.equal(
				res.payload.reconciliationSummary.reconciledAmountCents,
				10000
			);
			assert.equal(
				res.payload.reconciliationSummary.reconciledReservationsCount,
				1
			);
			assert.equal(
				res.payload.reconciliationSummary.waitingReservationsCount,
				1
			);

			const rowClauses = clausesFor(observed.countFilter);
			const rowCategoryClause = rowClauses.find(
				(clause) =>
					Array.isArray(clause?.$expr?.$or) &&
					clause.$expr.$or.some(
						(condition) =>
							JSON.stringify(condition?.$gt?.[0]) ===
							JSON.stringify(
								paymentAmountCentsExpression("paid_at_hotel_cash")
							)
					)
			);
			assert.equal(rowCategoryClause.$expr.$or.length, 2);
			assert.ok(rowClauses.some((clause) => clause?.$expr));
			assert.equal(hasSearchClause(observed.countFilter), true);
			assert.ok(dateClauseFor(observed.countFilter, "createdAt"));

			const scorecardClauses = clausesFor(observed.aggregateMatch);
			const scorecardCategoryClause = scorecardClauses.find(
				(clause) =>
					Array.isArray(clause?.$or) &&
					clause.$or.some(
						(condition) =>
							condition?.["paid_amount_breakdown.paid_online_via_link"]
					)
			);
			assert.equal(scorecardCategoryClause.$or.length, 8);
			assert.equal(scorecardClauses.some((clause) => clause?.$expr), false);
			assert.equal(hasSearchClause(observed.aggregateMatch), false);
			assert.deepEqual(
				dateClauseFor(observed.aggregateMatch, "createdAt"),
				dateClauseFor(observed.countFilter, "createdAt")
			);
			const scorecardFields = observed.aggregatePipeline[1].$addFields;
			assert.equal(
				scorecardFields.reconciliation_row_reconciled.$or.length,
				2
			);
			assert.equal(
				scorecardFields.reconciliation_row_waiting.$or.length,
				2
			);
			assert.ok(
				observed.aggregatePipeline[2].$group
					.reconciliationWaitingReservationsCount
			);
		},
		{
			rowReservations: [row],
			financialReservations: [row],
			aggregateResult: [
				{
					totalAmount: 200,
					paidAmount: 200,
					reconciliationTotalCents: 12500,
					reconciliationReconciledCents: 10000,
					reconciliationReservationsCount: 1,
				reconciliationReconciledReservationsCount: 1,
				reconciliationWaitingReservationsCount: 1,
				},
			],
			count: 1,
		}
	);
});

test("paid endpoint includes a mixed row in both reconciled and waiting category filters", async () => {
	const row = {
		_id: "68b74714fb50e159d48c714f",
		hotelId: HOTEL_ID,
		currency: "SAR",
		total_amount: 150,
		paid_amount_breakdown: {
			paid_at_hotel_cash: 100,
			paid_at_hotel_card: 50,
		},
		payment_reconciliation: {
			breakdown: {
				paid_at_hotel_cash: {
					status: "reconciled",
					amountCents: 10000,
				},
			},
		},
	};
	for (const requestedStatus of ["reconciled", "waiting"]) {
		await withReservationReadMocks(
			async (observed) => {
				const res = makeResponse();
				await paidBreakdownReportAdmin(
					{
						query: {
							hotelId: HOTEL_ID,
							paymentBreakdownKeys:
								"paid_at_hotel_cash,paid_at_hotel_card",
							reconciliationStatus: requestedStatus,
							includeScorecards: "false",
						},
						profile: { role: 8000 },
					},
					res
				);
				assert.equal(res.statusCode, 200);
				assert.equal(res.payload.reconciliationStatus, requestedStatus);
				assert.equal(res.payload.data[0].reconciliation_status, "mixed");
				const statusClause = clausesFor(observed.countFilter).find(
					(clause) =>
						clause?.$expr?.$or?.length === 2 &&
						clause.$expr.$or.every(
							(condition) => Array.isArray(condition?.$and)
						)
				);
				assert.ok(statusClause);
				if (requestedStatus === "reconciled") {
					assert.equal(statusClause.$expr.$or[0].$and.length, 3);
					assert.equal(statusClause.$expr.$or[0].$and[1].$eq.length, 2);
				} else {
					assert.equal(statusClause.$expr.$or[0].$and.length, 2);
					assert.ok(statusClause.$expr.$or[0].$and[1].$not);
				}
			},
			{
				rowReservations: [row],
				financialReservations: [row],
				count: 1,
			}
		);
	}
});

test("paid report rejects injected category keys and invalid reconciliation statuses before reads", async () => {
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
			{ hotelId: HOTEL_ID, paymentBreakdownKeys: "$where" },
			{ hotelId: HOTEL_ID, reconciliationStatus: "partial" },
			{ hotelId: HOTEL_ID, reconciliationStatus: "mixed" },
		]) {
			const res = makeResponse();
			await paidBreakdownReportAdmin(
				{ query, profile: { role: 8000 } },
				res
			);
			assert.equal(res.statusCode, 400);
			assert.match(res.payload?.error || "", /payment|reconciliation/i);
		}
		assert.equal(readCount, 0);
	} finally {
		Reservations.countDocuments = originals.countDocuments;
		Reservations.find = originals.find;
		Reservations.aggregate = originals.aggregate;
	}
});
