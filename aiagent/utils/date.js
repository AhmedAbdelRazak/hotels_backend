/** @format */
const dayjs = require("dayjs");

function normalizeDate(s) {
	const d = dayjs(s);
	if (!d.isValid()) return null;
	return d.format("YYYY-MM-DD");
}
function isValidRange(a, b) {
	const A = dayjs(a),
		B = dayjs(b);
	return A.isValid() && B.isValid() && B.isAfter(A, "day");
}
function eachDate(startStr, endStr) {
	// list of nights: [checkin, ..., checkout-1]
	const start = dayjs(startStr);
	const end = dayjs(endStr).subtract(1, "day");
	const arr = [];
	for (
		let d = start;
		d.isBefore(end) || d.isSame(end, "day");
		d = d.add(1, "day")
	) {
		arr.push(d.format("YYYY-MM-DD"));
	}
	return arr;
}
function betweenISO(a, b) {
	const A = dayjs(a),
		B = dayjs(b);
	return A.isBefore(B, "day")
		? [A.format("YYYY-MM-DD"), B.format("YYYY-MM-DD")]
		: [B.format("YYYY-MM-DD"), A.format("YYYY-MM-DD")];
}

module.exports = { normalizeDate, isValidRange, eachDate, betweenISO };
