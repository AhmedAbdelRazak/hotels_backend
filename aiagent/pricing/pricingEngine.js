/** @format */
const { eachDate } = require("../utils/date");

const hasCommissionValue = (value) =>
	value !== null && value !== undefined && value !== "";

function resolveCommissionRate(room, hotel) {
	const hotelCommission = hasCommissionValue(hotel?.commission)
		? Number(hotel.commission)
		: 10;
	const fallback =
		Number.isFinite(hotelCommission) && hotelCommission >= 0
			? hotelCommission
			: 10;
	const roomCommission = hasCommissionValue(room?.roomCommission)
		? Number(room.roomCommission)
		: fallback;

	return Number.isFinite(roomCommission) && roomCommission >= 0
		? roomCommission
		: fallback;
}

// Your rules:
// 1) If a date exists and price === 0 in the middle → BLOCKED (handled in availability.js)
// 2) If a date is missing from calendar → use basePrice
// 3) If basePrice blank or 0 → use defaultCost for that date
// Commission: use room.roomCommission when provided, including 0.

function resolveNightly(room, hotel, dateStr) {
	const row = (room.pricingRate || []).find((r) => r.calendarDate === dateStr);

	const basePrice = Number(room?.price?.basePrice || 0);
	const defaultCost = Number(room?.defaultCost || 0);

	// price/rootPrice semantics from your FE: rootPrice = hotel base, price = calendar override; keep both
	const priceCandidate = row ? Number(row.price || 0) : 0;
	const rootCandidate = row ? Number(row.rootPrice || 0) : 0;

	// When row missing: use basePrice; if basePrice 0 → defaultCost
	const priceNoRow = basePrice > 0 ? basePrice : defaultCost;

	// When row exists but gives 0 (not blocked scenario), we fall back to base → default
	const finalPrice = row && priceCandidate > 0 ? priceCandidate : priceNoRow;
	const finalRoot =
		row && rootCandidate > 0
			? rootCandidate
			: defaultCost > 0
			? defaultCost
			: finalPrice;

	const commission = resolveCommissionRate(room, hotel);
	const totalWithCommission = finalPrice + finalRoot * (commission / 100);

	return {
		date: dateStr,
		price: finalPrice, // nightly "no-commission" portion
		rootPrice: finalRoot,
		commissionRate: commission,
		totalPriceWithCommission: totalWithCommission,
		totalPriceWithoutCommission: finalPrice,
	};
}

function computeStayPricing(hotel, room, startStr, endStr) {
	const nightsArray = eachDate(startStr, endStr);
	const nightly = nightsArray.map((d) => resolveNightly(room, hotel, d));

	const totalWithCommission = nightly.reduce(
		(a, b) => a + Number(b.totalPriceWithCommission || 0),
		0
	);
	const perNight = nightly.length ? totalWithCommission / nightly.length : 0;

	return {
		nights: nightly.length,
		nightly,
		perNight,
		totalWithCommission,
		commissionTotal: nightly.reduce(
			(acc, d) =>
				acc + (Number(d.totalPriceWithCommission) - Number(d.rootPrice)),
			0
		),
		rootTotal: nightly.reduce((acc, d) => acc + Number(d.rootPrice), 0),
	};
}

module.exports = { computeStayPricing };
