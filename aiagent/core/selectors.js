// aiagent/core/selectors.js
// Pricing + availability helpers used by the orchestrator.
// Returns nightly rows shaped exactly like your FE's transformPickedRooms() expects.

const {
	isCalendarRowBlocked,
	normalizeRoomCapacity,
} = require("../../services/hotelOpenAiKnowledge");

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_PRICING_COVERAGE_THROUGH = "2027-04-15";

const num = (v, f = 0) => {
	const n = parseFloat(v);
	return Number.isFinite(n) ? n : f;
};

const cleanText = (value) => String(value || "").trim();

const roomIdText = (value = {}) =>
	cleanText(value?.roomId || value?._id || value?.id || "");

const roomDisplayText = (value = {}) =>
	cleanText(value?.displayName || value?.roomDisplayName || value?.display_name || "");

function roomCapacity(room = {}) {
	const normalized = normalizeRoomCapacity(room);
	return normalized.eligibleForCapacityRecommendation
		? Number(normalized.maxGuests || 0) || 0
		: 0;
}

function roomSellableInventory(room = {}) {
	const configuredRooms = Math.max(0, Math.floor(Number(room?.count || 0) || 0));
	if (cleanText(room.roomType) !== "individualBed") return configuredRooms;
	const normalized = normalizeRoomCapacity(room);
	const bedsPerSharedRoom = Math.max(
		0,
		Math.floor(Number(normalized.sharedRoomBedCount || 0) || 0)
	);
	return configuredRooms * bedsPerSharedRoom;
}

function roomIsSellable(room = {}) {
	const basePrice = Number(room?.price?.basePrice);
	return Boolean(
		room?.activeRoom === true &&
		roomSellableInventory(room) > 0 &&
		roomCapacity(room) > 0 &&
		Number.isFinite(basePrice) &&
		basePrice > 0
	);
}

function canonicalRoomTypeKey(room = {}) {
	const raw = cleanText(room.roomType);
	if (
		[
			"singleRooms",
			"doubleRooms",
			"tripleRooms",
			"quadRooms",
			"familyRooms",
			"suite",
			"individualBed",
			"other",
		].includes(raw)
	) {
		return raw;
	}
	const capacity = roomCapacity(room);
	if (capacity === 1) return "singleRooms";
	if (capacity === 2) return "doubleRooms";
	if (capacity === 3) return "tripleRooms";
	if (capacity === 4) return "quadRooms";
	if (capacity >= 5) return "familyRooms";
	return raw;
}

function resolveRoomForStay(hotel = {}, reference = {}) {
	const activeRooms = (Array.isArray(hotel?.roomCountDetails)
		? hotel.roomCountDetails
		: []
	).filter(roomIsSellable);
	const requestedId = roomIdText(reference);
	if (requestedId) {
		const exactId = activeRooms.find((room) => roomIdText(room) === requestedId);
		if (exactId) return exactId;
	}
	const requestedDisplay = roomDisplayText(reference).toLowerCase();
	if (requestedDisplay) {
		const exactDisplay = activeRooms.find(
			(room) => roomDisplayText(room).toLowerCase() === requestedDisplay
		);
		if (exactDisplay) return exactDisplay;
	}
	let requestedType = cleanText(reference?.roomTypeKey || reference?.roomType);
	if (
		requestedType === "singleRooms" &&
		!activeRooms.some((room) => canonicalRoomTypeKey(room) === "singleRooms") &&
		activeRooms.some((room) => canonicalRoomTypeKey(room) === "doubleRooms")
	) {
		requestedType = "doubleRooms";
	}
	const candidates = requestedType
		? activeRooms.filter((room) => canonicalRoomTypeKey(room) === requestedType)
		: [];
	if (!candidates.length) return null;
	if (candidates.length === 1) return candidates[0];
	const requestedCapacity = Math.max(
		0,
		Number(reference?.requestedCapacity || 0) || 0,
		Number(reference?.requestedGuests || 0) || 0,
		Number(reference?.requestedBeds || 0) || 0
	);
	return [...candidates]
		.sort((left, right) => {
			const leftCapacity = roomCapacity(left);
			const rightCapacity = roomCapacity(right);
			const leftFits = requestedCapacity > 0 && leftCapacity >= requestedCapacity;
			const rightFits = requestedCapacity > 0 && rightCapacity >= requestedCapacity;
			if (leftFits !== rightFits) return leftFits ? -1 : 1;
			if (leftCapacity !== rightCapacity) return leftCapacity - rightCapacity;
			return roomDisplayText(left).localeCompare(roomDisplayText(right));
		})[0];
}

function addDays(iso, days) {
	const d = new Date(`${iso}T00:00:00.000Z`);
	if (Number.isNaN(d.getTime())) return "";
	d.setUTCDate(d.getUTCDate() + Number(days || 0));
	return d.toISOString().slice(0, 10);
}

function validISODate(value = "") {
	if (value instanceof Date && !Number.isNaN(value.getTime())) {
		return value.toISOString().slice(0, 10);
	}
	const text = String(value || "").slice(0, 10);
	if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return "";
	const date = new Date(`${text}T00:00:00.000Z`);
	if (Number.isNaN(date.getTime())) return "";
	return date.toISOString().slice(0, 10);
}

function eachDate(checkinISO, checkoutISO) {
	const start = validISODate(checkinISO);
	const end = validISODate(checkoutISO);
	if (!start || !end || start >= end) return [];
	const list = [];
	let cur = start;
	while (cur < end && list.length < 60) {
		list.push(cur);
		cur = addDays(cur, 1);
	}
	return cur === end ? list : [];
}

function calendarDateKey(value = "") {
	return String(value || "").slice(0, 10);
}

function pricingRatesForDates(room = {}, dates = []) {
	const targetDates = new Set(dates.map(calendarDateKey).filter(Boolean));
	const rateMap = {};
	if (!targetDates.size) return rateMap;
	const pricingRates = Array.isArray(room.pricingRate) ? room.pricingRate : [];
	let matchedDates = 0;
	for (const rate of pricingRates) {
		const key = calendarDateKey(rate?.calendarDate);
		if (!key || !targetDates.has(key)) continue;
		if (!rateMap[key]) matchedDates += 1;
		rateMap[key] = rate;
		if (matchedDates >= targetDates.size) break;
	}
	return rateMap;
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
function priceRoomForStay(hotel, roomReference = {}, checkinISO, checkoutISO) {
	const room = resolveRoomForStay(hotel, roomReference);
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
	if (!dates.length) {
		return {
			available: false,
			reason: "bad_dates",
			currency: hotel?.currency || "SAR",
			room,
		};
	}
	const nights = dates.length;
	const coverageFrom = cleanText(hotel?.openaiKnowledge?.coverageFrom).slice(0, 10);
	const coverageThrough = cleanText(
		hotel?.openaiKnowledge?.coverageThrough ||
			process.env.HOTEL_OPENAI_KNOWLEDGE_HORIZON_END ||
			DEFAULT_PRICING_COVERAGE_THROUGH
	).slice(0, 10);
	if (
		(/^20\d{2}-\d{2}-\d{2}$/.test(coverageFrom) && dates[0] < coverageFrom) ||
		(/^20\d{2}-\d{2}-\d{2}$/.test(coverageThrough) &&
			dates[dates.length - 1] > coverageThrough)
	) {
		return {
			available: false,
			reason: "outside_pricing_coverage",
			firstBlockedDate:
				dates.find(
					(date) =>
						(coverageFrom && date < coverageFrom) ||
						(coverageThrough && date > coverageThrough)
				) || dates[0],
			currency: hotel?.currency || "SAR",
			room,
		};
	}

	// baselines
	const basePrice = num(room?.price?.basePrice, 0); // exact guest fallback price
	const defaultCost = num(room?.defaultCost, 0); // internal settlement value only
	if (!(basePrice > 0)) {
		return {
			available: false,
			reason: "invalid_base_price",
			currency: hotel?.currency || "SAR",
			room,
		};
	}

	// Map only the requested stay dates. Some hotels keep large calendar arrays,
	// and the chatbot only needs exact rows for the guest's requested nights.
	const rateMap = pricingRatesForDates(room, dates);

	const pricingByDay = [];
	const perNight = [];
	let blocked = false;
	let firstBlockedDate = "";
	const blockedDates = [];

	for (const d of dates) {
		const r = rateMap[d];

		const calendarPrice = r ? Number(r.price) : NaN;
		const dayPrice =
			Number.isFinite(calendarPrice) && calendarPrice > 0
				? calendarPrice
				: basePrice;
		const calendarRoot = r ? Number(r.rootPrice) : NaN;
		const dayRoot =
			Number.isFinite(calendarRoot) && calendarRoot > 0
				? calendarRoot
				: defaultCost > 0
				? defaultCost
				: dayPrice;
		const dayComm = r ? num(r.commissionRate, 0) : 0;

		// Calendar status/black/zero guest price are explicit blocks. Internal
		// root/cost values never make a guest-facing date unavailable.
		if (r && isCalendarRowBlocked(r)) {
			blocked = true;
			if (!firstBlockedDate) firstBlockedDate = d;
			blockedDates.push(d);
			break;
		}

		// Public chatbot rule: the calendar guest price is final. If a calendar
		// row is missing, use basePrice exactly. Never add root price or commission.
		const final = dayPrice;

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
			firstBlockedDate,
			blockedDates: blockedDates.slice(0, 10),
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
	const rooms = (hotel?.roomCountDetails || []).filter(roomIsSellable);
	return rooms.map((r) => {
		const q = priceRoomForStay(
			hotel,
			{ roomId: roomIdText(r), roomType: r.roomType, displayName: r.displayName },
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
	resolveRoomForStay,
	roomCapacity,
	roomSellableInventory,
	roomIsSellable,
	canonicalRoomTypeKey,
	eachDate,
	roomHasAmenity,
	hotelHasAmenity,
	findAmenityMatch,
};
