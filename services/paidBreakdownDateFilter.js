const moment = require("moment-timezone");

const PAID_BREAKDOWN_REPORT_TIMEZONE = "Asia/Riyadh";
const DEFAULT_PAID_BREAKDOWN_DATE_FIELD = "createdAt";
const PAID_BREAKDOWN_DATE_FIELDS = new Set([
	"createdAt",
	"checkin_date",
	"checkout_date",
]);
const ASCII_DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

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

const buildPaidBreakdownDateFilter = ({
	dateBy,
	dateFrom,
	dateTo,
} = {}) => {
	const dateField = normalizePaidBreakdownDateField(dateBy);
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
	PaidBreakdownDateFilterError,
	normalizePaidBreakdownDateField,
	parsePaidBreakdownDateOnly,
	buildPaidBreakdownDateFilter,
};
