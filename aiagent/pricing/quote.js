// hotels_backend/aiagent/pricing/quote.js
import dayjs from "dayjs";

const num = (v, f = 0) => (Number.isFinite(+v) ? +v : f);

export function quoteRoom(hotel, roomTypeKey, checkinISO, checkoutISO) {
	const room = (hotel?.roomCountDetails || []).find(
		(r) => r.roomType === roomTypeKey
	);
	if (!room) return { available: false, reason: "room_not_found" };

	const start = dayjs(checkinISO).startOf("day");
	const end = dayjs(checkoutISO).startOf("day");
	const nights = Math.max(1, end.diff(start, "day"));

	const basePrice = num(room?.price?.basePrice, 0); // no‑commission portion
	const defaultCost = num(room?.defaultCost, 0); // hotel’s base (root) cost
	const hotelComm = num(hotel?.commission, 10);
	const roomComm = num(room?.roomCommission, hotelComm);
	const commissionRate = roomComm > 0 ? roomComm : 10;

	const map = {};
	(room.pricingRate || []).forEach((r) => (map[r.calendarDate] = r));

	let blocked = false;
	const perNight = [];
	const rows = [];

	let d = start.clone();
	while (d.isBefore(end)) {
		const key = d.format("YYYY-MM-DD");
		const r = map[key];

		const price = r ? num(r.price, basePrice) : basePrice;
		const rootPrice = r ? num(r.rootPrice, defaultCost) : defaultCost;

		// Any day with 0 means the room is blocked for that night
		if (r && (num(r.price, 0) === 0 || num(r.rootPrice, 0) === 0)) {
			blocked = true;
			break;
		}

		const final = price + rootPrice * (commissionRate / 100);

		perNight.push(final);
		rows.push({
			date: key,
			price,
			rootPrice,
			commissionRate,
			totalPriceWithCommission: Number(final.toFixed(2)),
			totalPriceWithoutCommission: Number(price.toFixed(2)),
		});

		d = d.add(1, "day");
	}

	if (blocked) return { available: false, reason: "blocked_by_calendar" };

	const total = perNight.reduce((a, b) => a + num(b), 0);

	return {
		available: true,
		roomType: roomTypeKey,
		nights,
		perNight,
		total: Number(total.toFixed(2)),
		currency: hotel?.currency || "SAR",
		pricingByDay: rows,
	};
}
