/** @format */
const { eachDate } = require("../utils/date");

// A date is "blocked" if a pricingRate exists for that date with price = 0
// and it is not only at edges; you asked: "if all the dates are in the calendar but one date in the middle is zero → blocked"
function isRangeAvailable(room, startStr, endStr) {
	const pricing = Array.isArray(room?.pricingRate) ? room.pricingRate : [];
	const set = new Map(pricing.map((d) => [d.calendarDate, d]));

	let blocked = false;
	let blockedOn = null;

	const dates = eachDate(startStr, endStr); // inclusive of last night
	// We treat all interior nights (excluding the first/last) for zero-price blocking
	const interior = dates.slice(1, dates.length - 1);

	for (const d of interior) {
		const row = set.get(d);
		if (row && Number(row.price) === 0) {
			blocked = true;
			blockedOn = d;
			break;
		}
	}

	return { available: !blocked, blocked, blockedOn };
}

module.exports = { isRangeAvailable };
