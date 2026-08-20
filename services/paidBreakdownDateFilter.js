const moment = require("moment-timezone");

const PAID_BREAKDOWN_REPORT_TIMEZONE = "Asia/Riyadh";
const DEFAULT_PAID_BREAKDOWN_DATE_FIELD = "createdAt";
const DEFAULT_PAID_BREAKDOWN_UPDATED_FILTER = "all";
const PAID_BREAKDOWN_UPDATED_AT_FIELD = "paid_amount_breakdown_updated_at";
const PAID_BREAKDOWN_UPDATED_FILTERS = new Set([
	DEFAULT_PAID_BREAKDOWN_UPDATED_FILTER,
	"yesterday",
	"today",
]);
const PAID_BREAKDOWN_DATE_FIELDS = new Set([
	"createdAt",
	"checkin_date",
	"checkout_date",
]);
const ASCII_DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PAID_BREAKDOWN_DATE_RANGES = 12;

// One URL parameter, with no whitespace or locale-dependent characters:
// YYYY-MM-DD..YYYY-MM-DD,YYYY-MM-DD..YYYY-MM-DD
//
// The parser sorts ranges by start/end date and removes exact duplicates so the
// same selection always produces the same Mongo filter and serialized value.
const PAID_BREAKDOWN_DATE_RANGE_ITEM_PATTERN =
	/^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/;

class PaidBreakdownDateFilterError extends Error {
	constructor(message) {
		super(message);
		this.name = "PaidBreakdownDateFilterError";
		this.statusCode = 400;
	}
}

const hasQueryValue = (value) =>
	value !== undefined && value !== null && value !== "";

const normalizePaidBreakdownDateField = (value) => {
	if (!hasQueryValue(value)) return DEFAULT_PAID_BREAKDOWN_DATE_FIELD;
	if (typeof value !== "string" || !PAID_BREAKDOWN_DATE_FIELDS.has(value)) {
		throw new PaidBreakdownDateFilterError(
			"dateBy must be one of createdAt, checkin_date, or checkout_date",
		);
	}
	return value;
};

const normalizePaidBreakdownUpdatedFilter = (value) => {
	if (!hasQueryValue(value)) return DEFAULT_PAID_BREAKDOWN_UPDATED_FILTER;
	if (typeof value !== "string") {
		throw new PaidBreakdownDateFilterError(
			"breakdownUpdated must be one of all, yesterday, or today"
		);
	}

	const normalized = value.trim().toLowerCase();
	if (!PAID_BREAKDOWN_UPDATED_FILTERS.has(normalized)) {
		throw new PaidBreakdownDateFilterError(
			"breakdownUpdated must be one of all, yesterday, or today"
		);
	}
	return normalized;
};

const latestLegacyPaidBreakdownAuditAtExpression = () => ({
	$arrayElemAt: [
		{
			$map: {
				input: {
					$filter: {
						input: { $ifNull: ["$adminChangeLog", []] },
						as: "change",
						cond: {
							$eq: ["$$change.field", "paid_amount_breakdown"],
						},
					},
				},
				as: "change",
				in: "$$change.at",
			},
		},
		-1,
	],
});

const buildPaidBreakdownUpdatedFilter = (
	value,
	referenceDate = new Date()
) => {
	const normalized = normalizePaidBreakdownUpdatedFilter(value);
	if (normalized === DEFAULT_PAID_BREAKDOWN_UPDATED_FILTER) return null;

	const start = moment
		.tz(referenceDate, PAID_BREAKDOWN_REPORT_TIMEZONE)
		.startOf("day");
	if (normalized === "yesterday") start.subtract(1, "day");
	const endExclusive = start.clone().add(1, "day");
	const range = {
		$gte: start.toDate(),
		$lt: endExclusive.toDate(),
	};

	// New saves use the dedicated server-managed timestamp. Existing records use
	// the append-only admin audit entry only while that timestamp is absent.
	return {
		$or: [
			{ [PAID_BREAKDOWN_UPDATED_AT_FIELD]: range },
			{
				$and: [
					{ [PAID_BREAKDOWN_UPDATED_AT_FIELD]: null },
					{
						$expr: {
							$let: {
								vars: {
									updatedAt:
										latestLegacyPaidBreakdownAuditAtExpression(),
								},
								in: {
									$and: [
										{ $gte: ["$$updatedAt", range.$gte] },
										{ $lt: ["$$updatedAt", range.$lt] },
									],
								},
							},
						},
					},
				],
			},
		],
	};
};

const parsePaidBreakdownDateOnly = (value, parameterName) => {
	if (!hasQueryValue(value)) return null;
	if (typeof value !== "string" || !ASCII_DATE_ONLY_PATTERN.test(value)) {
		throw new PaidBreakdownDateFilterError(
			`${parameterName} must use the YYYY-MM-DD format`,
		);
	}
	const text = value;

	const parsed = moment.tz(
		text,
		"YYYY-MM-DD",
		true,
		PAID_BREAKDOWN_REPORT_TIMEZONE,
	).locale("en");
	if (!parsed.isValid() || parsed.format("YYYY-MM-DD") !== text) {
		throw new PaidBreakdownDateFilterError(
			`${parameterName} must be a valid calendar date`,
		);
	}
	return parsed.startOf("day");
};

const normalizePaidBreakdownDateRanges = (
	ranges,
	parameterName = "dateRanges"
) => {
	if (!Array.isArray(ranges)) {
		throw new PaidBreakdownDateFilterError(
			`${parameterName} must be an array of date ranges`
		);
	}
	if (ranges.length > MAX_PAID_BREAKDOWN_DATE_RANGES) {
		throw new PaidBreakdownDateFilterError(
			`${parameterName} cannot contain more than ${MAX_PAID_BREAKDOWN_DATE_RANGES} ranges`
		);
	}

	const normalized = ranges.map((range, index) => {
		if (!range || typeof range !== "object" || Array.isArray(range)) {
			throw new PaidBreakdownDateFilterError(
				`${parameterName}[${index}] must contain both dateFrom and dateTo`
			);
		}

		const dateFrom = range.dateFrom;
		const dateTo = range.dateTo;
		if (!hasQueryValue(dateFrom) || !hasQueryValue(dateTo)) {
			throw new PaidBreakdownDateFilterError(
				`${parameterName}[${index}] must contain both dateFrom and dateTo`
			);
		}

		const start = parsePaidBreakdownDateOnly(
			dateFrom,
			`${parameterName}[${index}].dateFrom`
		);
		const endDay = parsePaidBreakdownDateOnly(
			dateTo,
			`${parameterName}[${index}].dateTo`
		);
		if (start.valueOf() > endDay.valueOf()) {
			throw new PaidBreakdownDateFilterError(
				`${parameterName}[${index}].dateFrom must be on or before dateTo`
			);
		}

		return {
			dateFrom,
			dateTo,
			start,
			endExclusive: endDay.clone().add(1, "day").startOf("day"),
		};
	});

	normalized.sort(
		(left, right) =>
			left.dateFrom.localeCompare(right.dateFrom) ||
			left.dateTo.localeCompare(right.dateTo)
	);

	return normalized.filter(
		(range, index) =>
			index === 0 ||
			range.dateFrom !== normalized[index - 1].dateFrom ||
			range.dateTo !== normalized[index - 1].dateTo
	);
};

const parsePaidBreakdownDateRanges = (value) => {
	if (!hasQueryValue(value)) return [];
	if (typeof value !== "string") {
		throw new PaidBreakdownDateFilterError(
			"dateRanges must use the YYYY-MM-DD..YYYY-MM-DD format"
		);
	}

	const serializedRanges = value.split(",");
	if (serializedRanges.length > MAX_PAID_BREAKDOWN_DATE_RANGES) {
		throw new PaidBreakdownDateFilterError(
			`dateRanges cannot contain more than ${MAX_PAID_BREAKDOWN_DATE_RANGES} ranges`
		);
	}

	const ranges = serializedRanges.map((serializedRange, index) => {
		const match = PAID_BREAKDOWN_DATE_RANGE_ITEM_PATTERN.exec(serializedRange);
		if (!match) {
			throw new PaidBreakdownDateFilterError(
				`dateRanges[${index}] must use the YYYY-MM-DD..YYYY-MM-DD format`
			);
		}
		return { dateFrom: match[1], dateTo: match[2] };
	});

	return normalizePaidBreakdownDateRanges(ranges);
};

const serializePaidBreakdownDateRanges = (ranges = []) =>
	normalizePaidBreakdownDateRanges(ranges)
		.map((range) => `${range.dateFrom}..${range.dateTo}`)
		.join(",");

const buildPaidBreakdownDateFilter = ({
	dateBy,
	dateFrom,
	dateTo,
	dateRanges,
} = {}) => {
	const dateField = normalizePaidBreakdownDateField(dateBy);
	const hasSerializedRanges = hasQueryValue(dateRanges);
	if (
		hasSerializedRanges &&
		(hasQueryValue(dateFrom) || hasQueryValue(dateTo))
	) {
		throw new PaidBreakdownDateFilterError(
			"dateRanges cannot be combined with dateFrom or dateTo"
		);
	}

	if (hasSerializedRanges) {
		const ranges = parsePaidBreakdownDateRanges(dateRanges);
		return {
			$or: ranges.map((range) => ({
				[dateField]: {
					$gte: range.start.toDate(),
					$lt: range.endExclusive.toDate(),
				},
			})),
		};
	}

	const start = parsePaidBreakdownDateOnly(dateFrom, "dateFrom");
	const endDay = parsePaidBreakdownDateOnly(dateTo, "dateTo");

	if (start && endDay && start.valueOf() > endDay.valueOf()) {
		throw new PaidBreakdownDateFilterError(
			"dateFrom must be on or before dateTo",
		);
	}

	if (!start && !endDay) return null;

	const range = {};
	if (start) range.$gte = start.toDate();
	if (endDay) range.$lt = endDay.clone().add(1, "day").startOf("day").toDate();

	return { [dateField]: range };
};

module.exports = {
	PAID_BREAKDOWN_REPORT_TIMEZONE,
	DEFAULT_PAID_BREAKDOWN_DATE_FIELD,
	DEFAULT_PAID_BREAKDOWN_UPDATED_FILTER,
	PAID_BREAKDOWN_UPDATED_AT_FIELD,
	MAX_PAID_BREAKDOWN_DATE_RANGES,
	PaidBreakdownDateFilterError,
	normalizePaidBreakdownDateField,
	normalizePaidBreakdownUpdatedFilter,
	parsePaidBreakdownDateOnly,
	parsePaidBreakdownDateRanges,
	serializePaidBreakdownDateRanges,
	buildPaidBreakdownDateFilter,
	buildPaidBreakdownUpdatedFilter,
};
