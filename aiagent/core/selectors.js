// aiagent/core/selectors.js
// Pricing + availability helpers used by the orchestrator.
// Returns nightly rows shaped exactly like your FE's transformPickedRooms() expects.

const DAY_MS = 24 * 60 * 60 * 1000;

const num = (v, f = 0) => {
	const n = parseFloat(v);
	return Number.isFinite(n) ? n : f;
};

function addDays(iso, days) {
	const d = new Date(iso + "T00:00:00");
	d.setDate(d.getDate() + days);
	return d.toISOString().slice(0, 10);
}

function eachDate(checkinISO, checkoutISO) {
	const list = [];
	let cur = checkinISO;
	while (cur < checkoutISO) {
		list.push(cur);
		cur = addDays(cur, 1);
	}
	return list;
}

/** Commission fallback: roomCommission > hotel.commission > 10 */
function resolveCommissionRate(hotel, room) {
	const h = num(hotel?.commission, 10);
	const r = num(room?.roomCommission, h);
	return r > 0 ? r : 10;
}

/** Quick amenity check on a room object with robust fallbacks */
function roomHasAmenity(room, key) {
	if (!room) return false;
	const keyLow = String(key).toLowerCase();

	const hit = (s) =>
		String(s || "")
			.toLowerCase()
			.includes(keyLow);

	// Arrays we often see
	const arrays = [
		room.amenities,
		room.features,
		room.roomFeatures,
		room.facilities,
	].filter(Boolean);

	for (const arr of arrays) {
		if (Array.isArray(arr) && arr.some(hit)) return true;
	}

	// Booleans we often see
	if (keyLow === "wifi" && (room.wifi || room.hasWifi || room.freeWifi))
		return true;
	if (
		keyLow === "parking" &&
		(room.parking || room.freeParking || room.hasParking)
	)
		return true;
	if (
		keyLow === "breakfast" &&
		(room.breakfast || room.freeBreakfast || room.hasBreakfast)
	)
		return true;
	if (keyLow === "ac" && (room.ac || room.airConditioning || room.hasAc))
		return true;

	// String fields
	if (hit(room.description) || hit(room.details) || hit(room.notes))
		return true;

	return false;
}

/** Hotel‑level amenity check (fallback) */
function hotelHasAmenity(hotel, key) {
	if (!hotel) return false;
	const keyLow = String(key).toLowerCase();
	const hit = (s) =>
		String(s || "")
			.toLowerCase()
			.includes(keyLow);

	const arrays = [hotel.amenities, hotel.features, hotel.facilities].filter(
		Boolean
	);
	for (const arr of arrays) {
		if (Array.isArray(arr) && arr.some(hit)) return true;
	}
	if (hit(hotel.description) || hit(hotel.details) || hit(hotel.notes))
		return true;
	return false;
}

/**
 * Price one room type for a stay.
 * Shape:
 * {
 *   available, reason|null, nights, currency, room,
 *   pricingByDay: [{date, price, rootPrice, commissionRate, totalPriceWithCommission, totalPriceWithoutCommission}],
 *   perNight: [finals...],
 *   totals: { totalPriceWithCommission, hotelShouldGet, totalCommission }
 * }
 */
function priceRoomForStay(hotel, { roomType }, checkinISO, checkoutISO) {
	const room = (hotel?.roomCountDetails || []).find(
		(r) => r.roomType === roomType
	);
	if (!room) {
		return {
			available: false,
			reason: "room_not_found",
			currency: hotel?.currency || "SAR",
			room: null,
		};
	}

	// dates
	if (!checkinISO || !checkoutISO || checkinISO >= checkoutISO) {
		return {
			available: false,
			reason: "bad_dates",
			currency: hotel?.currency || "SAR",
			room,
		};
	}

	const dates = eachDate(checkinISO, checkoutISO);
	const nights = Math.max(1, dates.length);

	// baselines
	const basePrice = num(room?.price?.basePrice, 0); // no‑commission portion (what FE stores in totalPriceWithoutCommission)
	const defaultCost = num(room?.defaultCost, 0); // rootPrice (hotel cost)
	const commissionRate = resolveCommissionRate(hotel, room);

	// map special calendar rows
	const rateMap = {};
	(room.pricingRate || []).forEach((r) => {
		if (r && r.calendarDate) rateMap[r.calendarDate] = r;
	});

	const pricingByDay = [];
	const perNight = [];
	let blocked = false;

	for (const d of dates) {
		const r = rateMap[d];

		const dayPrice = r ? num(r.price, basePrice) : basePrice;
		const dayRoot = r ? num(r.rootPrice, defaultCost) : defaultCost;
		const dayComm = r ? num(r.commissionRate, commissionRate) : commissionRate;

		// "Blocked": any day priced at 0 in either field
		if (r && (num(r.price, 0) === 0 || num(r.rootPrice, 0) === 0)) {
			blocked = true;
			break;
		}

		const final = dayPrice + dayRoot * (dayComm / 100);

		pricingByDay.push({
			date: d,
			price: Number(dayPrice.toFixed(2)),
			rootPrice: Number(dayRoot.toFixed(2)),
			commissionRate: Number(dayComm.toFixed(2)),
			totalPriceWithCommission: Number(final.toFixed(2)),
			totalPriceWithoutCommission: Number(dayPrice.toFixed(2)),
		});

		perNight.push(Number(final.toFixed(2)));
	}

	if (blocked) {
		return {
			available: false,
			reason: "blocked",
			currency: hotel?.currency || "SAR",
			room,
			nights,
		};
	}

	const totalWithComm = pricingByDay.reduce(
		(a, b) => a + num(b.totalPriceWithCommission, 0),
		0
	);
	const hotelShouldGet = pricingByDay.reduce(
		(a, b) => a + num(b.rootPrice, 0),
		0
	);
	const totalCommission = Number((totalWithComm - hotelShouldGet).toFixed(2));

	return {
		available: true,
		reason: null,
		room,
		nights,
		pricingByDay,
		perNight,
		currency: hotel?.currency || "SAR",
		totals: {
			totalPriceWithCommission: Number(totalWithComm.toFixed(2)),
			hotelShouldGet: Number(hotelShouldGet.toFixed(2)),
			totalCommission,
		},
	};
}

/** List best 1 quote per active room for the same stay (used for alternatives) */
function listAvailableRoomsForStay(hotel, checkinISO, checkoutISO) {
	const rooms = (hotel?.roomCountDetails || []).filter((r) => r.activeRoom);
	return rooms.map((r) => {
		const q = priceRoomForStay(
			hotel,
			{ roomType: r.roomType },
			checkinISO,
			checkoutISO
		);
		return {
			available: !!q.available,
			reason: q.reason || null,
			room: r,
			currency: q.currency,
			nights: q.nights || 0,
			totals: q.totals || null,
		};
	});
}

/** Amenity synonyms */
function findAmenityMatch(text = "") {
	const t = String(text).toLowerCase();

	// Wi‑Fi
	if (/\b(wi[\-\s]?fi|wifi|wireless|انترنت|إنترنت|واي\s?فاي)\b/.test(t))
		return "wifi";
	// Parking
	if (/\b(parking|garage|موقف|مواقف)\b/.test(t)) return "parking";
	// Breakfast
	if (/\b(breakfast|افطار|فطور)\b/.test(t)) return "breakfast";
	// Air conditioning
	if (/\b(air\s*conditioning|a\.?c\.?|ac|تكييف)\b/.test(t)) return "ac";

	return null;
}

module.exports = {
	priceRoomForStay,
	listAvailableRoomsForStay,
	roomHasAmenity,
	hotelHasAmenity,
	findAmenityMatch,
};
