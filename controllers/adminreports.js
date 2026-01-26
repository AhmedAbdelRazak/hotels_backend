const Reservations = require("../models/reservations");
const HotelDetails = require("../models/hotel_details");
const mongoose = require("mongoose");
const moment = require("moment-timezone");
const ObjectId = mongoose.Types.ObjectId;

const DEFAULT_TIMEZONE = "Asia/Riyadh";
const PAGE_START_DATE_UTC = new Date(Date.UTC(2025, 4, 1, 0, 0, 0, 0));

/* ------------------------------------------------------------------
   1) Payment Status Helper
      Based on your examples:

      - "not paid" => no card data in customer_details
      - "captured" => finalCaptureTransactionId OR payment_details.captured == true
      - otherwise => "not captured"
   ------------------------------------------------------------------ */
function getPaymentStatus(reservation) {
	const hasCardData =
		reservation?.customer_details?.cardNumber ||
		reservation?.customer_details?.cardHolderName ||
		reservation?.customer_details?.cardExpiryDate ||
		reservation?.customer_details?.cardCVV;

	if (!hasCardData) {
		return "not paid";
	}

	// If card data is present, check capture flags
	const pd = reservation?.payment_details;
	if (pd?.finalCaptureTransactionId || pd?.captured === true) {
		return "captured";
	}

	return "not captured";
}

/* ------------------------------------------------------------------
   2) Safe Number Helper
   ------------------------------------------------------------------ */
function safeNumber(val) {
	const parsed = Number(val);
	return isNaN(parsed) ? 0 : parsed;
}

const PAID_BREAKDOWN_TOTAL_KEYS = [
	"paid_online_via_link",
	"paid_at_hotel_cash",
	"paid_at_hotel_card",
	"paid_to_zad",
	"paid_online_jannatbooking",
	"paid_online_other_platforms",
	"paid_online_via_instapay",
];

const PAID_BREAKDOWN_QUERY_KEYS = PAID_BREAKDOWN_TOTAL_KEYS.map(
	(key) => `paid_amount_breakdown.${key}`,
);

const escapeRegex = (value) =>
	String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const buildPaidBreakdownSearchFilter = (searchQuery) => {
	const trimmed = (searchQuery || "").trim();
	if (!trimmed) return null;
	const regex = new RegExp(escapeRegex(trimmed), "i");
	return {
		$or: [
			{ confirmation_number: regex },
			{ "customer_details.name": regex },
			{ "customer_details.fullName": regex },
			{ "customer_details.phone": regex },
			{ "customer_details.email": regex },
		],
	};
};

const buildPaidBreakdownNonZeroFilter = () => ({
	$or: PAID_BREAKDOWN_QUERY_KEYS.map((key) => ({ [key]: { $gt: 0 } })),
});

const computePaidBreakdownTotal = (breakdown = {}) =>
	PAID_BREAKDOWN_TOTAL_KEYS.reduce(
		(sum, key) => sum + safeNumber(breakdown?.[key]),
		0,
	);

/* ------------------------------------------------------------------
   3) Commission Calculation
      - If hotelId == "675c41a3fd79ed7586b970ee" => 10% of total_amount
      - Otherwise => ScoreCard logic:
           For each room in pickedRoomsType => for each day in pricingByDay:
             finalRate = day.commissionRate < 1 ? day.commissionRate : day.commissionRate/100
             dayCommission = (rootPrice * finalRate) + (totalPriceWithoutComm - rootPrice)
             multiplied by room.count
   ------------------------------------------------------------------ */
function computeReservationCommission(reservation) {
	if (!reservation) return 0;

	const specialHotelId = "675c41a3fd79ed7586b970ee";
	const currentHotelId = String(
		reservation.hotelId?._id || reservation.hotelId || ""
	);

	// Special override for that specific hotelId => 10% of total_amount
	if (currentHotelId === specialHotelId) {
		return 0.1 * safeNumber(reservation.total_amount);
	}

	// Otherwise, do the normal ScoreCard logic
	if (!Array.isArray(reservation.pickedRoomsType)) {
		return 0;
	}

	let totalCommission = 0;
	for (const room of reservation.pickedRoomsType) {
		if (!Array.isArray(room.pricingByDay)) continue;

		for (const day of room.pricingByDay) {
			const rootPrice = safeNumber(day.rootPrice);
			let rawRate = safeNumber(day.commissionRate);
			const finalRate = rawRate < 1 ? rawRate : rawRate / 100;

			const totalPriceWithoutComm = safeNumber(day.totalPriceWithoutCommission);

			// ScoreCard formula:
			// dayCommission = (rootPrice * finalRate) + (totalPriceWithoutComm - rootPrice)
			const dayCommission =
				rootPrice * finalRate + (totalPriceWithoutComm - rootPrice);

			// multiply by how many rooms of this type
			totalCommission += dayCommission * safeNumber(room.count);
		}
	}

	return totalCommission;
}

/* ------------------------------------------------------------------
   4) Enhanced "findFilteredReservations"
      - Must match booking_source in [online jannat booking, generated link, jannat employee]
      - Must have createdAt >= 2024-09-01
      - If `?hotels=all` or not provided => no hotel filter
      - Else parse commaâ€separated hotel names, match them (caseâ€insensitive)
        to actual hotels, then filter reservations by those IDs
      - If `?excludeCancelled=true`, filter out cancelled reservations
   ------------------------------------------------------------------ */
async function findFilteredReservations(req) {
	const baseFilter = {
		createdAt: { $gte: PAGE_START_DATE_UTC },
	};

	// If ?excludeCancelled=true, exclude reservation_status = 'cancelled'
	if (req.query.excludeCancelled === "true") {
		baseFilter.reservation_status = { $ne: "cancelled" };
	}

	// Check for ?hotels=...
	const hotelsParam = req?.query?.hotels; // e.g. "Abraj Al Kiswah,Abraj Al Mesk"
	if (hotelsParam && hotelsParam !== "all") {
		const hotelNamesArr = hotelsParam.split(","); // ["Abraj Al Kiswah","Abraj Al Mesk"]
		// For each name, create a case-insensitive exact match
		const regexArr = hotelNamesArr.map(
			(name) => new RegExp(`^${name.trim()}$`, "i")
		);

		// Find matching hotel IDs
		const matchedHotels = await HotelDetails.find(
			{ hotelName: { $in: regexArr } },
			{ _id: 1 }
		).lean();

		const matchedIds = matchedHotels.map((h) => h._id);
		// If no matches, we effectively want zero reservations
		if (matchedIds.length === 0) {
			// Force an impossible match
			baseFilter.hotelId = { $in: [] };
		} else {
			baseFilter.hotelId = { $in: matchedIds };
		}
	}

	// Now fetch reservations
	const reservations = await Reservations.find(baseFilter)
		.populate("hotelId", "hotelName")
		.lean();

	return reservations;
}

/* ------------------------------------------------------------------
   5) Helper to group reservations by an arbitrary "group key" function.
      Each group will:
         - sum total_amount,
         - sum commission,
         - count how many reservations,
         - track paymentStatusCounts if needed
   ------------------------------------------------------------------ */
function groupReservations(reservations, groupKeyFn) {
	const groupsMap = {}; // key -> { ...aggregatedData }

	for (const r of reservations) {
		// Compute the "bucket" or "group" for this reservation
		const key = groupKeyFn(r);
		if (!groupsMap[key]) {
			groupsMap[key] = {
				groupKey: key,
				reservationsCount: 0,
				total_amount: 0,
				commission: 0,
				paymentStatusCounts: {
					captured: 0,
					notCaptured: 0,
					notPaid: 0,
				},
			};
		}

		groupsMap[key].reservationsCount++;
		groupsMap[key].total_amount += safeNumber(r.total_amount);
		groupsMap[key].commission += computeReservationCommission(r);

		// Payment status aggregator
		const pStatus = getPaymentStatus(r);
		if (pStatus === "captured") groupsMap[key].paymentStatusCounts.captured++;
		else if (pStatus === "not captured")
			groupsMap[key].paymentStatusCounts.notCaptured++;
		else if (pStatus === "not paid")
			groupsMap[key].paymentStatusCounts.notPaid++;
	}

	// Convert to an array
	return Object.values(groupsMap);
}

// "roomTypes" array for mapping room_type => label
const ROOM_TYPES_MAPPING = [
	{ value: "standardRooms", label: "Standard Rooms" },
	{ value: "singleRooms", label: "Single Rooms" },
	{ value: "doubleRooms", label: "Double Room" },
	{ value: "twinRooms", label: "Twin Rooms" },
	{ value: "queenRooms", label: "Queen Rooms" },
	{ value: "kingRooms", label: "King Rooms" },
	{ value: "tripleRooms", label: "Triple Room" },
	{ value: "quadRooms", label: "Quad Rooms" },
	{ value: "studioRooms", label: "Studio Rooms" },
	{ value: "suite", label: "Suite" },
	{ value: "masterSuite", label: "Master Suite" },
	{ value: "familyRooms", label: "Family Rooms" },
	{
		value: "individualBed",
		label: "Rooms With Individual Beds (Shared Rooms)",
	},
];

/* ------------------------------------------------------------------
   6) reservationsByDay
      Group by the DAY portion of createdAt
   ------------------------------------------------------------------ */
exports.reservationsByDay = async (req, res) => {
	try {
		const reservations = await findFilteredReservations(req);

		const results = groupReservations(reservations, (r) => {
			// Convert createdAt -> "YYYY-MM-DD"
			return new Date(r.createdAt).toISOString().split("T")[0];
		});

		return res.json(results);
	} catch (err) {
		console.error("Error in reservationsByDay:", err);
		return res.status(500).json({ error: err.message });
	}
};

/* ------------------------------------------------------------------
   7) checkinsByDay
   ------------------------------------------------------------------ */
exports.checkinsByDay = async (req, res) => {
	try {
		const reservations = await findFilteredReservations(req);

		const validReservations = reservations.filter((r) => !!r.checkin_date);

		const results = groupReservations(validReservations, (r) => {
			return new Date(r.checkin_date).toISOString().split("T")[0];
		});

		return res.json(results);
	} catch (err) {
		console.error("Error in checkinsByDay:", err);
		return res.status(500).json({ error: err.message });
	}
};

/* ------------------------------------------------------------------
   8) checkoutsByDay
   ------------------------------------------------------------------ */
exports.checkoutsByDay = async (req, res) => {
	try {
		const reservations = await findFilteredReservations(req);
		const validReservations = reservations.filter((r) => !!r.checkout_date);

		const results = groupReservations(validReservations, (r) => {
			return new Date(r.checkout_date).toISOString().split("T")[0];
		});

		return res.json(results);
	} catch (err) {
		console.error("Error in checkoutsByDay:", err);
		return res.status(500).json({ error: err.message });
	}
};

/* ------------------------------------------------------------------
   9) reservationsByDayByHotelName
      Group by (day portion of createdAt + hotelName).
   ------------------------------------------------------------------ */
exports.reservationsByDayByHotelName = async (req, res) => {
	try {
		const reservations = await findFilteredReservations(req);

		const results = groupReservations(reservations, (r) => {
			const day = new Date(r.createdAt).toISOString().split("T")[0];
			const hotelName = r.hotelId?.hotelName || "Unknown Hotel";
			return `${day}__${hotelName}`;
		});

		// Transform key => separate date & hotelName
		const transformed = results.map((group) => {
			const [datePart, hotelName] = group.groupKey.split("__");
			return {
				date: datePart,
				hotelName,
				reservationsCount: group.reservationsCount,
				total_amount: group.total_amount,
				commission: group.commission,
				paymentStatusCounts: group.paymentStatusCounts,
			};
		});

		return res.json(transformed);
	} catch (err) {
		console.error("Error in reservationsByDayByHotelName:", err);
		return res.status(500).json({ error: err.message });
	}
};

/* ------------------------------------------------------------------
   10) reservationsByBookingStatus
       Group by reservation_status
   ------------------------------------------------------------------ */
exports.reservationsByBookingStatus = async (req, res) => {
	try {
		const reservations = await findFilteredReservations(req);

		const results = groupReservations(reservations, (r) => {
			return r.reservation_status || "unknown";
		});

		// Transform the groupKey -> reservation_status
		const transformed = results.map((group) => ({
			reservation_status: group.groupKey,
			reservationsCount: group.reservationsCount,
			total_amount: group.total_amount,
			commission: group.commission,
			paymentStatusCounts: group.paymentStatusCounts,
		}));

		return res.json(transformed);
	} catch (err) {
		console.error("Error in reservationsByBookingStatus:", err);
		return res.status(500).json({ error: err.message });
	}
};

/* ------------------------------------------------------------------
   11) reservationsByHotelNames
       Group by hotelName
   ------------------------------------------------------------------ */
exports.reservationsByHotelNames = async (req, res) => {
	try {
		const reservations = await findFilteredReservations(req);

		const results = groupReservations(reservations, (r) => {
			return r.hotelId?.hotelName || "Unknown Hotel";
		});

		// Transform groupKey -> hotelName
		const transformed = results.map((group) => ({
			hotelName: group.groupKey,
			reservationsCount: group.reservationsCount,
			total_amount: group.total_amount,
			commission: group.commission,
			paymentStatusCounts: group.paymentStatusCounts,
		}));

		return res.json(transformed);
	} catch (err) {
		console.error("Error in reservationsByHotelNames:", err);
		return res.status(500).json({ error: err.message });
	}
};

/* ------------------------------------------------------------------
   12) topHotelsByReservations
       Sort descending by reservationsCount, then slice top N
   ------------------------------------------------------------------ */
exports.topHotelsByReservations = async (req, res) => {
	try {
		const limit = Number(req.query.limit) || 5;
		const reservations = await findFilteredReservations(req);

		// Group by hotelName
		const grouped = groupReservations(reservations, (r) => {
			return r.hotelId?.hotelName || "Unknown Hotel";
		});

		// Sort descending by "reservationsCount"
		grouped.sort((a, b) => b.reservationsCount - a.reservationsCount);

		// Slice top N
		const topHotels = grouped.slice(0, limit).map((g) => ({
			hotelName: g.groupKey,
			reservationsCount: g.reservationsCount,
			total_amount: g.total_amount,
			commission: g.commission,
			paymentStatusCounts: g.paymentStatusCounts,
		}));

		return res.json(topHotels);
	} catch (err) {
		console.error("Error in topHotelsByReservations:", err);
		return res.status(500).json({ error: err.message });
	}
};

// ------------------------------------------------------
// Helper objects + functions used in specificListOfReservations
// ------------------------------------------------------
const MONTH_NAME_MAP = {
	january: 0,
	february: 1,
	march: 2,
	april: 3,
	may: 4,
	june: 5,
	july: 6,
	august: 7,
	september: 8,
	october: 9,
	november: 10,
	december: 11,
};

/**
 * For "YYYY-MM-DD" => { start, end } of that day
 */
function dayRangeFromString(dayStr) {
	const dateObj = new Date(dayStr + "T00:00:00.000Z");
	if (isNaN(dateObj.getTime())) {
		return null;
	}

	const start = new Date(dateObj);
	start.setUTCHours(0, 0, 0, 0);

	const end = new Date(dateObj);
	end.setUTCHours(23, 59, 59, 999);

	return { start, end };
}

/**
 * For "december-2024" => { start, end } for that month
 */
function monthRangeFromString(monthYearStr) {
	const parts = monthYearStr.split("-");
	if (parts.length !== 2) return null;

	const monthPart = parts[0].toLowerCase();
	const yearPart = parts[1];

	const yearNum = parseInt(yearPart, 10);
	if (isNaN(yearNum)) return null;

	const monthIndex = MONTH_NAME_MAP[monthPart];
	if (typeof monthIndex !== "number") return null;

	const start = new Date(Date.UTC(yearNum, monthIndex, 1, 0, 0, 0, 0));
	const nextMonth = new Date(Date.UTC(yearNum, monthIndex + 1, 1, 0, 0, 0, 0));
	const end = new Date(nextMonth.getTime() - 1);

	return { start, end };
}

/* ------------------------------------------------------------------
   specificListOfReservations
   Uses its own custom logic to parse query params for date ranges, etc.
   Also respects ?excludeCancelled=true to filter out cancelled reservations
------------------------------------------------------------------ */
exports.specificListOfReservations = async (req, res) => {
	// -------------------- LOCAL HELPERS (for this endpoint only) --------------------

	// Parse "YYYY-MM-DD" into a UTC day range [start, end]
	function dayRangeFromString(dateStr) {
		if (!dateStr) return null;

		// Expecting "YYYY-MM-DD"
		const isoLike = `${dateStr}T00:00:00.000Z`;
		const date = new Date(isoLike);
		if (Number.isNaN(date.getTime())) return null;

		const start = new Date(date);
		start.setUTCHours(0, 0, 0, 0);

		const end = new Date(date);
		end.setUTCHours(23, 59, 59, 999);

		return { start, end };
	}

	// Month name map for "october-2025" style inputs
	const MONTH_NAME_MAP = {
		january: 0,
		february: 1,
		march: 2,
		april: 3,
		may: 4,
		june: 5,
		july: 6,
		august: 7,
		september: 8,
		october: 9,
		november: 10,
		december: 11,
	};

	// Parse either "YYYY-MM" or "october-2025" into a UTC month range [start, end]
	function monthRangeFromString(input) {
		if (!input || typeof input !== "string") return null;

		const value = input.trim().toLowerCase();

		let yearNum;
		let monthIndex;

		// Case 1: "YYYY-MM"
		if (/^\d{4}-\d{1,2}$/.test(value)) {
			const [y, m] = value.split("-");
			yearNum = parseInt(y, 10);
			const mNum = parseInt(m, 10);
			if (!yearNum || !mNum || mNum < 1 || mNum > 12) return null;
			monthIndex = mNum - 1;
		} else {
			// Case 2: "october-2025"
			const parts = value.split("-");
			if (parts.length !== 2) return null;

			const [monthName, yearStr] = parts;
			yearNum = parseInt(yearStr, 10);
			if (!yearNum || !(monthName in MONTH_NAME_MAP)) return null;

			monthIndex = MONTH_NAME_MAP[monthName];
		}

		const start = new Date(Date.UTC(yearNum, monthIndex, 1, 0, 0, 0, 0));
		const nextMonth = new Date(
			Date.UTC(yearNum, monthIndex + 1, 1, 0, 0, 0, 0)
		);
		const end = new Date(nextMonth.getTime() - 1);

		return { start, end };
	}

	function isToday(date) {
		const today = new Date();
		return (
			date.getDate() === today.getDate() &&
			date.getMonth() === today.getMonth() &&
			date.getFullYear() === today.getFullYear()
		);
	}

	function isYesterday(date) {
		const today = new Date();
		const yesterday = new Date(today);
		yesterday.setDate(today.getDate() - 1);
		return (
			date.getDate() === yesterday.getDate() &&
			date.getMonth() === yesterday.getMonth() &&
			date.getFullYear() === yesterday.getFullYear()
		);
	}

	function isThisWeek(date) {
		const now = new Date();
		// Start of current week (Sunday)
		const startOfWeek = new Date(now);
		startOfWeek.setDate(now.getDate() - now.getDay());
		startOfWeek.setHours(0, 0, 0, 0);

		const endOfWeek = new Date(startOfWeek);
		endOfWeek.setDate(startOfWeek.getDate() + 6);
		endOfWeek.setHours(23, 59, 59, 999);

		return date >= startOfWeek && date <= endOfWeek;
	}

	function isLastWeek(date) {
		const now = new Date();
		// Start of this week (Sunday)
		const startOfThisWeek = new Date(now);
		startOfThisWeek.setDate(now.getDate() - now.getDay());
		startOfThisWeek.setHours(0, 0, 0, 0);

		// End of last week is 1 ms before startOfThisWeek
		const endOfLastWeek = new Date(startOfThisWeek.getTime() - 1);

		// Start of last week is 7 days prior
		const startOfLastWeek = new Date(startOfThisWeek);
		startOfLastWeek.setDate(startOfThisWeek.getDate() - 7);
		startOfLastWeek.setHours(0, 0, 0, 0);

		return date >= startOfLastWeek && date <= endOfLastWeek;
	}

	function safeNumber(val) {
		const parsed = Number(val);
		return Number.isNaN(parsed) ? 0 : parsed;
	}

	function computeReservationCommission(reservation) {
		if (!reservation || !reservation.pickedRoomsType) return 0;

		const hotelName = reservation.hotelId?.hotelName?.toLowerCase() || "";
		const totalAmount = safeNumber(reservation.total_amount);

		// Special: 'sahet al hegaz' => flat 10% of total_amount
		if (hotelName === "sahet al hegaz") {
			return 0.1 * totalAmount;
		}

		let totalCommission = 0;
		reservation.pickedRoomsType.forEach((room) => {
			if (!room.pricingByDay || room.pricingByDay.length === 0) return;

			room.pricingByDay.forEach((day) => {
				const rootPrice = safeNumber(day.rootPrice);
				const rawRate = safeNumber(day.commissionRate);
				const finalRate = rawRate < 1 ? rawRate : rawRate / 100;
				const totalPriceWithoutComm = safeNumber(
					day.totalPriceWithoutCommission
				);

				const dayCommission =
					rootPrice * finalRate + (totalPriceWithoutComm - rootPrice);

				totalCommission += dayCommission * safeNumber(room.count);
			});
		});

		return totalCommission;
	}

	// ------------------------------ MAIN LOGIC ------------------------------

	try {
		// 1) Base filter: all reservations created on/after PAGE_START_DATE_UTC
		//    (adjust this date if you want a different "start of reporting" cutoff)
		const PAGE_START_DATE_UTC = new Date(Date.UTC(2025, 4, 1, 0, 0, 0, 0)); // 2025-05-01 UTC
		const baseFilter = {
			createdAt: { $gte: PAGE_START_DATE_UTC },
		};

		// 2) Build customFilter from query
		const customFilter = {};
		const query = req.query;

		// excludeCancelled=true -> filter out reservation_status = "cancelled"
		if (query.excludeCancelled === "true") {
			customFilter.reservation_status = { $ne: "cancelled" };
		}

		// 3) Parse dynamic keys for date / month / status
		Object.keys(query).forEach((key) => {
			// (a) createdAt DATE
			if (key.startsWith("createdAtDate_")) {
				const dateStr = key.replace("createdAtDate_", "");
				const range = dayRangeFromString(dateStr);
				if (range) {
					customFilter.createdAt = { $gte: range.start, $lte: range.end };
				}
			}

			// (b) createdAt MONTH (supports "YYYY-MM" and "october-2025")
			if (key.startsWith("createdAtMonth_")) {
				const monthStr = key.replace("createdAtMonth_", "");
				const range = monthRangeFromString(monthStr);
				if (range) {
					customFilter.createdAt = { $gte: range.start, $lte: range.end };
				}
			}

			// (c) checkin DATE
			if (key.startsWith("checkinDate_")) {
				const dateStr = key.replace("checkinDate_", "");
				const range = dayRangeFromString(dateStr);
				if (range) {
					if (!customFilter.checkin_date) customFilter.checkin_date = {};
					customFilter.checkin_date.$gte = range.start;
					customFilter.checkin_date.$lte = range.end;
				}
			}

			// (d) checkin MONTH
			if (key.startsWith("checkinMonth_")) {
				const monthStr = key.replace("checkinMonth_", "");
				const range = monthRangeFromString(monthStr);
				if (range) {
					if (!customFilter.checkin_date) customFilter.checkin_date = {};
					customFilter.checkin_date.$gte = range.start;
					customFilter.checkin_date.$lte = range.end;
				}
			}

			// (e) checkout DATE
			if (key.startsWith("checkoutDate_")) {
				const dateStr = key.replace("checkoutDate_", "");
				const range = dayRangeFromString(dateStr);
				if (range) {
					if (!customFilter.checkout_date) customFilter.checkout_date = {};
					customFilter.checkout_date.$gte = range.start;
					customFilter.checkout_date.$lte = range.end;
				}
			}

			// (f) checkout MONTH
			if (key.startsWith("checkoutMonth_")) {
				const monthStr = key.replace("checkoutMonth_", "");
				const range = monthRangeFromString(monthStr);
				if (range) {
					if (!customFilter.checkout_date) customFilter.checkout_date = {};
					customFilter.checkout_date.$gte = range.start;
					customFilter.checkout_date.$lte = range.end;
				}
			}

			// (g) reservationstatus_...
			if (key.startsWith("reservationstatus_")) {
				const statusValue = key.replace("reservationstatus_", "");
				// This overrides excludeCancelled if both are present, which is what you want
				customFilter.reservation_status = statusValue;
			}
		});

		// 4) hotels param => EXACT name match(es), case-insensitive
		const hotelsParam = query.hotels;
		if (hotelsParam && hotelsParam !== "all") {
			const hotelsArr = hotelsParam.split(",");
			const regexArr = hotelsArr.map(
				(hName) => new RegExp(`^${hName.trim()}$`, "i")
			);

			const matchedHotels = await HotelDetails.find(
				{ hotelName: { $in: regexArr } },
				{ _id: 1 }
			).lean();
			const matchedIds = matchedHotels.map((h) => h._id);

			if (matchedIds.length === 0) {
				// force no results
				customFilter.hotelId = { $in: [] };
			} else {
				customFilter.hotelId = { $in: matchedIds };
			}
		}

		// 5) "hotelId" param => partial search by hotelName (only if "hotels" param wasn't used)
		if (!hotelsParam && query.hotelId) {
			const hotelNameRegex = new RegExp(query.hotelId, "i");
			const matchedHotels = await HotelDetails.find(
				{ hotelName: hotelNameRegex },
				{ _id: 1 }
			).lean();

			if (matchedHotels.length > 0) {
				const hotelIds = matchedHotels.map((h) => h._id);
				customFilter.hotelId = { $in: hotelIds };
			} else {
				customFilter.hotelId = { $in: [] };
			}
		}

		// 6) Combine baseFilter + customFilter
		const finalFilter =
			Object.keys(customFilter).length > 0
				? { $and: [baseFilter, customFilter] }
				: baseFilter;

		// 7) Pagination params (used only for metadata; data itself is full set)
		const page = parseInt(query.page || "1", 10);
		const limit = parseInt(query.limit || "50", 10);

		// 8) Fetch ALL matching docs (sorted) â€“ frontend does client-side pagination
		const reservations = await Reservations.find(finalFilter)
			.sort({ createdAt: -1 })
			.populate("hotelId", "_id hotelName")
			.lean();

		const totalDocuments = reservations.length;
		const totalPages = Math.ceil(totalDocuments / limit);

		// -------------------- SCORECARDS (based on the same filtered set) --------------------
		const allReservations = Array.isArray(reservations) ? reservations : [];

		// 1) Today & Yesterday reservations (by createdAt)
		const todayReservations = allReservations.filter((r) =>
			isToday(new Date(r.createdAt))
		).length;

		const yesterdayReservations = allReservations.filter((r) =>
			isYesterday(new Date(r.createdAt))
		).length;

		const todayRatio =
			yesterdayReservations > 0
				? ((todayReservations - yesterdayReservations) /
						yesterdayReservations) *
				  100
				: todayReservations * 100;

		// 2) This Week vs Last Week (by createdAt)
		const weeklyReservations = allReservations.filter((r) =>
			isThisWeek(new Date(r.createdAt))
		).length;

		const lastWeekReservations = allReservations.filter((r) =>
			isLastWeek(new Date(r.createdAt))
		).length;

		const weeklyRatio =
			lastWeekReservations > 0
				? ((weeklyReservations - lastWeekReservations) / lastWeekReservations) *
				  100
				: weeklyReservations * 100;

		// 3) Top 3 Hotels by Count
		const hotelCounts = allReservations.reduce((acc, reservation) => {
			const name = reservation.hotelId?.hotelName || "Unknown Hotel";
			acc[name] = (acc[name] || 0) + 1;
			return acc;
		}, {});
		const topHotels = Object.entries(hotelCounts)
			.map(([name, count]) => ({ name, reservations: count }))
			.sort((a, b) => b.reservations - a.reservations)
			.slice(0, 3);

		// 4) Overall reservations (everything that matched finalFilter)
		const totalMatchedReservations = allReservations.length;

		// 5) Commission stats (non-cancelled)
		const nonCancelled = allReservations.filter(
			(r) => r.reservation_status !== "cancelled"
		);

		// Today Commission
		const todayCommission = nonCancelled
			.filter((r) => isToday(new Date(r.createdAt)))
			.reduce((sum, r) => sum + computeReservationCommission(r), 0);

		// Yesterday Commission
		const yesterdayCommission = nonCancelled
			.filter((r) => isYesterday(new Date(r.createdAt)))
			.reduce((sum, r) => sum + computeReservationCommission(r), 0);

		const todayCommissionRatio =
			yesterdayCommission > 0
				? ((todayCommission - yesterdayCommission) / yesterdayCommission) * 100
				: todayCommission * 100;

		// Weekly Commission
		const weeklyCommission = nonCancelled
			.filter((r) => isThisWeek(new Date(r.createdAt)))
			.reduce((sum, r) => sum + computeReservationCommission(r), 0);

		const lastWeekCommission = nonCancelled
			.filter((r) => isLastWeek(new Date(r.createdAt)))
			.reduce((sum, r) => sum + computeReservationCommission(r), 0);

		const weeklyCommissionRatio =
			lastWeekCommission > 0
				? ((weeklyCommission - lastWeekCommission) / lastWeekCommission) * 100
				: weeklyCommission * 100;

		// Top 3 Hotels by Commission
		const hotelCommissions = nonCancelled.reduce((acc, reservation) => {
			const name = reservation.hotelId?.hotelName || "Unknown Hotel";
			const comm = computeReservationCommission(reservation);
			acc[name] = (acc[name] || 0) + comm;
			return acc;
		}, {});
		const topHotelsByCommission = Object.entries(hotelCommissions)
			.map(([name, commission]) => ({ name, commission }))
			.sort((a, b) => b.commission - a.commission)
			.slice(0, 3);

		// Overall Commission
		const overallCommission = nonCancelled.reduce(
			(acc, r) => acc + computeReservationCommission(r),
			0
		);

		const scorecards = {
			// row 1
			todayReservations,
			yesterdayReservations,
			todayRatio,
			weeklyReservations,
			lastWeekReservations,
			weeklyRatio,
			topHotels,
			totalReservations: totalMatchedReservations,

			// row 2
			todayCommission,
			yesterdayCommission,
			todayCommissionRatio,
			weeklyCommission,
			lastWeekCommission,
			weeklyCommissionRatio,
			topHotelsByCommission,
			overallCommission,
		};

		// 9) Return final payload
		return res.json({
			success: true,
			data: reservations, // full set; frontend paginates on the client
			totalDocuments,
			currentPage: page,
			totalPages,
			scorecards,
		});
	} catch (err) {
		console.error("Error in specificListOfReservations:", err);
		return res.status(500).json({ error: err.message });
	}
};

/* ------------------ HELPER FUNCTIONS FOR DATE RANGES ------------------ */

/**
 * dayRangeFromString("2024-10-05") => {start: 2024-10-05T00:00:00, end: 2024-10-05T23:59:59.999Z}
 */
function dayRangeFromString(dateStr) {
	if (!dateStr) return null;
	const date = new Date(dateStr);
	if (isNaN(date.getTime())) return null;

	const start = new Date(date);
	start.setHours(0, 0, 0, 0);
	const end = new Date(start);
	end.setHours(23, 59, 59, 999);

	return { start, end };
}

/**
 * monthRangeFromString("2024-10") => entire month from 2024-10-01T00:00:00 to 2024-10-31T23:59:59.999Z
 */

function monthRangeFromString(monthStr) {
	if (!monthStr) return null;
	// e.g. "2024-10"
	const [year, month] = monthStr.split("-");
	const y = parseInt(year, 10);
	const m = parseInt(month, 10);
	if (!y || !m) return null;

	// Start at the 1st of that month
	const start = new Date(y, m - 1, 1, 0, 0, 0, 0);
	// End at the last day of that month
	const end = new Date(y, m, 0, 23, 59, 59, 999); // m,0 => last day of month (js trick)
	return { start, end };
}

exports.exportToExcel = async (req, res) => {
	try {
		const userId = req.params.userId;

		// 1) Base filter: booking_source + createdAt >= 2024-09-01
		const PAGE_START_DATE_UTC = new Date(Date.UTC(2025, 4, 1, 0, 0, 0, 0)); // May is month 4 (0-indexed)
		const baseFilter = {
			createdAt: { $gte: PAGE_START_DATE_UTC },
		};

		// 2) Parse query for date range, hotels, + NEW: filterType & searchQuery
		const dateField = req.query.dateField || "createdAt"; // "createdAt", "checkin_date", "checkout_date"
		const fromStr = req.query.from; // e.g. "2025-01-01"
		const toStr = req.query.to; // e.g. "2025-02-01"
		const hotelsParam = req.query.hotels || "all";

		const filterType = req.query.filterType || ""; // NEW
		const searchQuery = (req.query.searchQuery || "").trim().toLowerCase(); // NEW

		// Convert from/to to Date objects
		let fromDate = null;
		let toDate = null;
		if (fromStr) {
			fromDate = new Date(`${fromStr}T00:00:00.000Z`);
			if (isNaN(fromDate.getTime())) fromDate = null;
		}
		if (toStr) {
			toDate = new Date(`${toStr}T23:59:59.999Z`);
			if (isNaN(toDate.getTime())) toDate = null;
		}

		// 3) Combine baseFilter + date range
		const finalFilter = { ...baseFilter };
		if (fromDate && toDate) {
			finalFilter[dateField] = { $gte: fromDate, $lte: toDate };
		} else if (fromDate) {
			finalFilter[dateField] = { $gte: fromDate };
		} else if (toDate) {
			finalFilter[dateField] = { $lte: toDate };
		}

		// 4) If hotelsParam != "all", filter by hotelName
		if (hotelsParam !== "all") {
			const splitted = hotelsParam.split(",");
			const regexArr = splitted.map((h) => new RegExp(`^${h.trim()}$`, "i"));

			const matchedHotels = await HotelDetails.find(
				{ hotelName: { $in: regexArr } },
				{ _id: 1 }
			).lean();

			const matchedIds = matchedHotels.map((h) => h._id);
			if (matchedIds.length === 0) {
				return res.json([]); // no hotels matched => empty
			}
			finalFilter.hotelId = { $in: matchedIds };
		}

		// 5) Fetch reservations
		const reservations = await Reservations.find(finalFilter)
			.populate("hotelId", "hotelName")
			.populate("belongsTo", "name phone email")
			.populate("payment_details")
			.lean();

		// ------------------------- NEW: Payment Status & Filter Helpers -------------------------
		// A) Payment Status logic with "Paid Offline"
		//    if captured => "Captured"
		//    else if onsite_paid_amount>0 => "Paid Offline"
		//    else if doc.payment === "not paid" => "Not Paid"
		//    else => "Not Captured"
		function computePaymentStatus(r) {
			const isCaptured = r.payment_details?.captured;
			const onsitePaid = r.payment_details?.onsite_paid_amount || 0;

			if (isCaptured) {
				return "Captured";
			} else if (onsitePaid > 0) {
				return "Paid Offline";
			} else if (r.payment === "not paid") {
				return "Not Paid";
			}
			return "Not Captured";
		}

		// B) filterType logic (no paginationâ€”just filter)
		function passesFilter(r) {
			const payStatus = (r.payment_status || "").toLowerCase();
			const resStatus = (r.reservation_status || "").toLowerCase();

			switch (filterType) {
				case "notPaid":
					return payStatus === "not paid";
				case "notCaptured":
					return payStatus === "not captured";
				case "captured":
					return payStatus === "captured";
				case "paidOffline":
					return payStatus === "paid offline";

				case "cancelled":
					return resStatus === "cancelled";
				case "notCancelled":
					return resStatus !== "cancelled";

				default:
					return true; // no extra filter
			}
		}

		// C) Build "enriched" array with new payment status
		let enrichedReservations = reservations.map((r) => {
			return {
				...r,
				payment_status: computePaymentStatus(r),
			};
		});

		// D) Filter by filterType
		enrichedReservations = enrichedReservations.filter(passesFilter);

		// E) If searchQuery provided, do a case-insensitive check
		if (searchQuery) {
			enrichedReservations = enrichedReservations.filter((r) => {
				const cnum = (r.confirmation_number || "").toLowerCase();
				const phone = (r.customer_details?.phone || "").toLowerCase();
				const name = (r.customer_details?.name || "").toLowerCase();
				const hname = (r.hotelId?.hotelName || "").toLowerCase();

				return (
					cnum.includes(searchQuery) ||
					phone.includes(searchQuery) ||
					name.includes(searchQuery) ||
					hname.includes(searchQuery)
				);
			});
		}
		// --------------------------------------------------------------------------

		// 6) Transform each final doc into the shape for export
		const transformed = enrichedReservations.map((r) => {
			// "Paid Offline" amount
			const paidOffline = r.payment_details?.onsite_paid_amount || 0;

			// Distinct room types
			let roomTypeString = "";
			let roomCount = 0;
			if (Array.isArray(r.pickedRoomsType) && r.pickedRoomsType.length > 0) {
				const distinctTypes = new Set(
					r.pickedRoomsType.map((x) => x.room_type)
				);
				const mappedLabels = [...distinctTypes].map((typeVal) => {
					const found = ROOM_TYPES_MAPPING.find((rt) => rt.value === typeVal);
					return found ? found.label : typeVal;
				});
				roomTypeString = mappedLabels.join(", ");
				roomCount = r.pickedRoomsType.length;
			}

			return {
				confirmation_number: r.confirmation_number || "",
				customer_name: r.customer_details?.name || "",
				customer_phone: r.customer_details?.phone || "",
				hotel_name: r.hotelId?.hotelName || "",
				reservation_status: r.reservation_status || "",
				checkin_date: r.checkin_date || null,
				checkout_date: r.checkout_date || null,
				payment_status: r.payment_status || "", // from computePaymentStatus
				total_amount: r.total_amount || 0,
				paid_amount: r.paid_amount || 0,
				paid_offline: paidOffline, // NEW field
				room_type: roomTypeString,
				room_count: roomCount,
				createdAt: r.createdAt || null,
			};
		});

		// 7) Return all matching (no pagination)
		return res.json(transformed);
	} catch (err) {
		console.error("Error in exportToExcel:", err);
		return res.status(500).json({ error: "Failed to export to excel" });
	}
};

// Create a quick lookup { "doubleRooms": "Double Room", ... }
const roomTypeLabelMap = {};
ROOM_TYPES_MAPPING.forEach((rt) => {
	roomTypeLabelMap[rt.value] = rt.label;
});

// Parse hotelId if given
// -------------------------------
// Helpers (keep at top of file)
// -------------------------------

// Parse hotelId if given
function tryConvertToObjectId(value) {
	if (!value) return null;
	if (mongoose.Types.ObjectId.isValid(value)) {
		return new mongoose.Types.ObjectId(value);
	}
	return null;
}

// Helper to check if two dates are the same day (robust to non-Date input)
function isSameDay(date1, date2, timezone = DEFAULT_TIMEZONE) {
	if (!date1 || !date2) return false;
	const d1 = moment.tz(date1, timezone);
	const d2 = moment.tz(date2, timezone);
	return d1.isSame(d2, "day");
}

// Always provide a full empty report so the frontend can render a zero-state
function makeEmptyReport() {
	return {
		firstRow: {
			arrivals: 0,
			departures: 0,
			inHouse: 0,
			booking: 0,
			overAllBookings: 0,
			tomorrowArrivals: 0,
		},
		secondRow: {
			cancellations: 0,
			noShow: 0,
			occupancy: { booked: 0, available: 0, overallRoomsCount: 0 },
			latestCheckouts: [],
			upcomingCheckins: [],
		},
		thirdRow: {
			roomsTable: [],
			housekeeping: { clean: 0, cleaning: 0, dirty: 0 },
		},
		fourthRow: {
			topChannels: [],
			roomNightsByType: [],
			roomRevenueByType: [],
		},
		fifthRow: {
			bookingLine: { categories: [], checkIn: [], checkOut: [] },
			visitorsLine: { categories: [], yesterday: [], today: [] },
		},
		donutChartCard: { availableRooms: 0, totalRooms: 0 },
		horizontalBarChartCard: { pending: 0, done: 0, finish: 0 },
	};
}

// -------------------------------
// MAIN CONTROLLER
// -------------------------------
exports.adminDashboardReport = async (req, res) => {
	try {
		// 1) Base filter (hotel scope only for accuracy across all dates)
		const baseFilter = {};
		console.log("Admin Dashboard Report Data:");

		// 2) Optional hotelId param => /admin-dashboard-reports/:hotelId
		const { hotelId } = req.params;
		if (hotelId && hotelId !== "all") {
			const objId = tryConvertToObjectId(hotelId);
			if (!objId) {
				// Keep 400, but still send consistent data shape
				return res.status(400).json({
					success: false,
					message: `Invalid hotelId '${hotelId}'`,
					data: makeEmptyReport(),
				});
			}
			baseFilter.hotelId = objId;
		}

		const displayMode = "displayName";
		const cancelledRegex = /cancelled|canceled/i;
		const noShowRegex = /no[_\s]?show/i;
		const excludedStatusRegex = /cancelled|canceled|no[_\s]?show/i;
		const inHouseRegex = /in\s?house/i;
		const checkoutRegex =
			/checked[_-]?out|checkedout|completed|closed|early[_\s-]?checked[_\s-]?out/i;
		const activeStatusFilter = { $not: excludedStatusRegex };

		const toNumber = (value, fallback = 0) => {
			const parsed = Number(value);
			return Number.isFinite(parsed) ? parsed : fallback;
		};

		const getReservationUnits = (room, reservation) => {
			const roomType = String(room?.room_type || room?.roomType || "").trim();
			if (
				roomType === "individualBed" &&
				Array.isArray(reservation?.bedNumber) &&
				reservation.bedNumber.length > 0
			) {
				return reservation.bedNumber.length;
			}

			const countVal = toNumber(room?.count, 0);
			return countVal > 0 ? countVal : 1;
		};

		const getRoomDisplayName = (room) => {
			const displayName =
				room?.displayName || room?.display_name || room?.label || "";
			return String(displayName || "").trim();
		};

		const statusNotExcluded = { reservation_status: activeStatusFilter };
		const statusNotCheckout = { reservation_status: { $not: checkoutRegex } };

		// Helper to merge baseFilter + condition
		const withBaseFilter = (cond) => ({ $and: [baseFilter, cond] });

		// Safe wrappers so one failed query doesn't doom the whole report
		const safeCount = async (cond) => {
			try {
				return await Reservations.countDocuments(withBaseFilter(cond));
			} catch (e) {
				console.error("safeCount failed", cond, e);
				return 0;
			}
		};
		const safeFind = async ({
			cond = {},
			select = "",
			sort = null,
			limit = null,
		}) => {
			try {
				let q = Reservations.find(withBaseFilter(cond)).select(select).lean();
				if (sort) q = q.sort(sort);
				if (limit) q = q.limit(limit);
				return await q;
			} catch (e) {
				console.error("safeFind failed", cond, e);
				return [];
			}
		};
		const safeAggregate = async (pipeline) => {
			try {
				return await Reservations.aggregate(pipeline);
			} catch (e) {
				console.error("safeAggregate failed", e);
				return [];
			}
		};

		// 3) Check if there are ANY documents matching baseFilter
		const totalMatches = await Reservations.countDocuments(baseFilter).catch(
			(e) => {
				console.error("countDocuments(baseFilter) failed", e);
				return 0;
			}
		);

		if (totalMatches === 0) {
			// Always return data so frontend renders zero-state
			return res.json({
				success: true,
				message: "No Reservations Found",
				data: makeEmptyReport(),
			});
		}
		// 4) Define "today" using hotel timezone (default: Asia/Riyadh)
		const timezone = DEFAULT_TIMEZONE;
		const nowMoment = moment.tz(timezone);
		const now = nowMoment.toDate();
		const startOfToday = nowMoment.clone().startOf("day").toDate();
		const endOfToday = nowMoment.clone().endOf("day").toDate();

		// We'll do 10 days after "today" (inclusive of today: 0..9)
		const endOf10Days = nowMoment
			.clone()
			.startOf("day")
			.add(9, "days")
			.endOf("day")
			.toDate();

		// ============== FIRST ROW ==============
		const arrivalsCount = await safeCount({
			checkin_date: { $gte: startOfToday, $lte: endOfToday },
			...statusNotExcluded,
		});

		const departuresCount = await safeCount({
			checkout_date: { $gte: startOfToday, $lte: endOfToday },
			...statusNotExcluded,
		});

		const inHouseCount = await safeCount({
			$and: [
				{ checkin_date: { $lte: endOfToday } },
				{ checkout_date: { $gt: startOfToday } },
				statusNotExcluded,
				statusNotCheckout,
			],
		});

		const bookingsTodayCount = await safeCount({
			$and: [
				statusNotExcluded,
				{
					$expr: {
						$and: [
							{
								$gte: [
									{ $ifNull: ["$booked_at", "$createdAt"] },
									startOfToday,
								],
							},
							{
								$lte: [{ $ifNull: ["$booked_at", "$createdAt"] }, endOfToday],
							},
						],
					},
				},
			],
		});

		const overAllBookingsCount = await safeCount({
			$and: [statusNotExcluded, statusNotCheckout],
		});

		const tomorrowStart = nowMoment
			.clone()
			.add(1, "day")
			.startOf("day")
			.toDate();
		const tomorrowEnd = nowMoment
			.clone()
			.add(1, "day")
			.endOf("day")
			.toDate();

		const tomorrowArrivalsCount = await safeCount({
			checkin_date: { $gte: tomorrowStart, $lte: tomorrowEnd },
			...statusNotExcluded,
		});

		const firstRow = {
			arrivals: arrivalsCount,
			departures: departuresCount,
			inHouse: inHouseCount,
			booking: bookingsTodayCount,
			overAllBookings: overAllBookingsCount,
			tomorrowArrivals: tomorrowArrivalsCount,
		};

		// ============== SECOND ROW ==============
		const cancellationsCount = await safeCount({
			reservation_status: cancelledRegex,
			updatedAt: { $gte: startOfToday, $lte: endOfToday },
		});

		const noShowCount = await safeCount({
			reservation_status: noShowRegex,
			updatedAt: { $gte: startOfToday, $lte: endOfToday },
		});

		// Inventory across hotels (displayName-aware, beds for individualBed)
		const hotelsQuery =
			hotelId && hotelId !== "all"
				? { _id: new mongoose.Types.ObjectId(hotelId) }
				: {};
		const matchedHotels = await HotelDetails.find(hotelsQuery)
			.lean()
			.catch((e) => {
				console.error("HotelDetails.find failed", e);
				return [];
			});

		const aggregatedRoomTypes = new Map();
		for (const h of matchedHotels) {
			const baseRoomTypes = buildBaseRoomTypes(
				h?.roomCountDetails || [],
				displayMode
			);
			for (const rt of baseRoomTypes) {
				if (!aggregatedRoomTypes.has(rt.key)) {
					aggregatedRoomTypes.set(rt.key, { ...rt });
					continue;
				}
				const prev = aggregatedRoomTypes.get(rt.key);
				prev.totalRooms += toNumber(rt.totalRooms);
				prev.rawRoomCount += toNumber(rt.rawRoomCount);
				if (!prev.displayName && rt.displayName)
					prev.displayName = rt.displayName;
				if (!prev.label && rt.label) prev.label = rt.label;
				if (!prev.color && rt.color) prev.color = rt.color;
				if (!prev.roomType && rt.roomType) prev.roomType = rt.roomType;
				if (!prev.bedsCount && rt.bedsCount) prev.bedsCount = rt.bedsCount;
			}
		}

		const baseRoomTypes = Array.from(aggregatedRoomTypes.values());
		const baseTotalsLookup = {};
		let baseTotalRoomsAll = 0;
		for (const rt of baseRoomTypes) {
			const totalRooms = toNumber(rt.totalRooms);
			baseTotalsLookup[rt.key] = totalRooms;
			baseTotalRoomsAll += totalRooms;
		}

		const roomTypes = [...baseRoomTypes];
		const roomTypeByKey = new Map();
		const keyNormToKey = new Map();
		const displayNormToKeys = new Map();
		const roomTypeNormToKeys = new Map();

		const addToSetMap = (map, k, val) => {
			if (!k) return;
			if (!map.has(k)) map.set(k, new Set());
			map.get(k).add(val);
		};

		const indexRoomType = (rt) => {
			roomTypeByKey.set(rt.key, rt);
			const nk = normalizeRoomKeyLabel(rt.key);
			if (nk) keyNormToKey.set(nk, rt.key);

			const aliases = new Set(
				[rt.displayName, rt.label, rt.key].filter(Boolean)
			);
			for (const a of aliases)
				addToSetMap(displayNormToKeys, normalizeRoomKeyLabel(a), rt.key);

			if (rt.roomType) {
				addToSetMap(
					roomTypeNormToKeys,
					normalizeRoomKeyLabel(rt.roomType),
					rt.key
				);
			}
		};

		for (const rt of baseRoomTypes) indexRoomType(rt);

		const pickFromSet = (set, raw) => {
			if (!set || set.size === 0) return null;
			if (set.size === 1) return Array.from(set)[0];
			const rawLower = String(raw || "")
				.trim()
				.toLowerCase();
			if (!rawLower) return Array.from(set)[0];

			for (const key of set) {
				const rt = roomTypeByKey.get(key);
				if (!rt) continue;
				for (const c of [rt.displayName, rt.label]) {
					if (
						String(c || "")
							.trim()
							.toLowerCase() === rawLower
					)
						return key;
				}
			}
			return Array.from(set)[0];
		};

		const resolveRoomKey = (room = {}) => {
			const rawKey = room?.key || room?.roomKey || "";
			const rawRoomType = room?.room_type || room?.roomType || "";
			const rawDisplay =
				room?.displayName || room?.display_name || room?.label || "";

			const nk = normalizeRoomKeyLabel(rawKey);
			if (nk && keyNormToKey.has(nk)) return keyNormToKey.get(nk);

			const nd = normalizeRoomKeyLabel(rawDisplay);
			const nrt = normalizeRoomKeyLabel(rawRoomType);

			if (displayMode === "displayName") {
				if (nd) {
					const set = displayNormToKeys.get(nd);
					const picked = pickFromSet(set, rawDisplay);
					if (picked) return picked;
				}
				if (nrt) {
					const set = roomTypeNormToKeys.get(nrt);
					if (set && set.size === 1) return Array.from(set)[0];
				}
				return null;
			}

			if (nrt) {
				const set = roomTypeNormToKeys.get(nrt);
				if (set && set.size) return Array.from(set)[0];
			}
			if (nd) {
				const set = displayNormToKeys.get(nd);
				const picked = pickFromSet(set, rawDisplay);
				if (picked) return picked;
			}
			return null;
		};

		const deriveKeyFromRoom = (room = {}) => {
			const rawRoomType = String(
				room?.room_type || room?.roomType || ""
			).trim();
			const rawDisplay = getRoomDisplayName(room);

			const labelCandidate =
				displayMode === "displayName"
					? rawDisplay ||
					  getRoomTypeLabel(rawRoomType) ||
					  rawRoomType ||
					  "Unknown Room"
					: getRoomTypeLabel(rawRoomType) ||
					  rawDisplay ||
					  rawRoomType ||
					  "Unknown Room";

			let key = normalizeRoomKeyLabel(labelCandidate);
			if (!key)
				key =
					normalizeRoomKeyLabel(rawDisplay) ||
					normalizeRoomKeyLabel(rawRoomType);
			if (!key) key = `unknown-room-${Math.random().toString(36).slice(2, 8)}`;

			return {
				key,
				label: labelCandidate,
				roomType: rawRoomType,
				displayName: rawDisplay,
			};
		};

		const ensureDerivedRoomType = (room = {}) => {
			const { key, label, roomType, displayName } = deriveKeyFromRoom(room);
			if (roomTypeByKey.has(key)) return key;

			const derived = {
				key,
				roomType,
				displayName,
				label,
				totalRooms: 0,
				rawRoomCount: 0,
				bedsCount: 0,
				color: null,
				derived: true,
			};

			roomTypes.push(derived);
			indexRoomType(derived);
			baseTotalsLookup[key] = 0;

			return key;
		};

		const isExcludedStatus = (status) =>
			excludedStatusRegex.test(String(status || ""));
		const isCheckoutStatus = (status) =>
			checkoutRegex.test(String(status || ""));

		// Next 10 days => usage (used to derive today's occupancy + derived inventory)
		const relevantFor10Days = await safeFind({
			cond: {
				...statusNotExcluded,
				checkin_date: { $lte: endOf10Days },
				checkout_date: { $gt: startOfToday },
			},
			select: "checkin_date checkout_date pickedRoomsType reservation_status bedNumber",
		});

		const usageArray10 = new Array(10).fill(0);
		const derivedUsageArray10 = new Array(10).fill(0);
		const dayList10 = Array.from({ length: 10 }, (_, i) =>
			nowMoment.clone().startOf("day").add(i, "days").toDate()
		);

		for (const doc of relevantFor10Days) {
			if (!Array.isArray(doc?.pickedRoomsType)) continue;
			const cIn = doc.checkin_date;
			const cOut = doc.checkout_date;

			if (isExcludedStatus(doc.reservation_status)) continue;
			if (isCheckoutStatus(doc.reservation_status)) continue;

			for (const rtObj of doc.pickedRoomsType) {
				const units = getReservationUnits(rtObj, doc);
				if (!units) continue;

				const resolvedKey = resolveRoomKey(rtObj);
				const isDerived = !resolvedKey;
				if (!resolvedKey) ensureDerivedRoomType(rtObj);

				for (let i = 0; i < 10; i++) {
					const dayDate = dayList10[i];
					if (dayDate >= cIn && dayDate < cOut) {
						usageArray10[i] += units;
						if (isDerived) derivedUsageArray10[i] += units;
					}
				}
			}
		}

		const bookedToday = usageArray10[0] || 0;
		const derivedBookedToday = derivedUsageArray10[0] || 0;
		const totalUnitsToday = baseTotalRoomsAll + derivedBookedToday;
		const occupancy = {
			booked: bookedToday,
			available: Math.max(totalUnitsToday - bookedToday, 0),
			overallRoomsCount: totalUnitsToday,
		};

		// latestCheckouts
		const latestCheckoutsRaw = await safeFind({
			cond: { reservation_status: checkoutRegex },
			sort: { checkout_date: -1 },
			limit: 4,
		});

		const latestCheckouts = latestCheckoutsRaw.map((r) => ({
			key: String(r._id),
			guest: r?.customer_details?.name || "N/A",
			guestId: r?.customer_details?.passport || "",
			accommodation: Array.isArray(r?.pickedRoomsType)
				? r.pickedRoomsType
						.map((rt) => getRoomDisplayName(rt) || rt?.room_type)
						.filter(Boolean)
						.join(", ")
				: "",
			stay:
				r?.checkin_date && r?.checkout_date
					? `${r.checkin_date.toISOString().slice(0, 10)} - ${r.checkout_date
							.toISOString()
							.slice(0, 10)}`
					: "",
			status: "Check out",
			amount: typeof r?.total_amount === "number" ? `$${r.total_amount}` : "",
		}));

		// upcomingCheckins => next 10 days (including today)
		const upcomingRaw = await safeFind({
			cond: {
				...statusNotExcluded,
				checkin_date: { $gte: startOfToday, $lte: endOf10Days },
			},
			sort: { checkin_date: 1 },
		});

		const upcomingCheckins = upcomingRaw.map((doc) => {
			let nights = doc?.days_of_residence || 0;
			if (!nights && doc?.checkin_date && doc?.checkout_date) {
				const diff = doc.checkout_date - doc.checkin_date;
				nights = Math.ceil(diff / (1000 * 60 * 60 * 24));
			}
			let dateRange = "";
			if (doc?.checkin_date && doc?.checkout_date) {
				const ci = doc.checkin_date.toISOString().slice(0, 10);
				const co = doc.checkout_date.toISOString().slice(0, 10);
				dateRange = `${ci} - ${co}`;
			}
			const guestsCount =
				doc?.total_guests || (doc?.adults || 0) + (doc?.children || 0);
			const flag = isSameDay(doc?.checkin_date, now) ? 1 : 0;

			return {
				_id: String(doc?._id),
				name: doc?.customer_details?.name || "N/A",
				confirmation_number: doc?.confirmation_number || "N/A",
				room_type:
					getRoomDisplayName(doc?.pickedRoomsType?.[0]) ||
					doc?.pickedRoomsType?.[0]?.room_type ||
					"N/A",
				nights,
				dateRange,
				number_of_guests: guestsCount,
				flag,
				reservation_status: doc?.reservation_status || "",
			};
		});

		const secondRow = {
			cancellations: cancellationsCount,
			noShow: noShowCount,
			occupancy, // { booked, available, overallRoomsCount }
			latestCheckouts,
			upcomingCheckins,
		};

		// ============== THIRD ROW ==============
		// Next 7 days usage => usageByDay7 (displayName-aware + beds for individualBed)
		const rangeEnd = nowMoment
			.clone()
			.startOf("day")
			.add(7, "days")
			.toDate(); // up to 7 days from today

		const relevantForNext7 = await safeFind({
			cond: {
				...statusNotExcluded,
				checkin_date: { $lte: rangeEnd },
				checkout_date: { $gt: startOfToday },
			},
			select: "checkin_date checkout_date pickedRoomsType reservation_status bedNumber",
		});

		const usageByDay7 = {};
		for (const rt of baseRoomTypes) {
			usageByDay7[rt.key] = [0, 0, 0, 0, 0, 0, 0];
		}

		const dayList7 = Array.from({ length: 7 }, (_, i) =>
			nowMoment.clone().startOf("day").add(i, "days").toDate()
		);

		for (const doc of relevantForNext7) {
			if (!Array.isArray(doc?.pickedRoomsType)) continue;
			const cIn = doc?.checkin_date;
			const cOut = doc?.checkout_date;

			if (isExcludedStatus(doc.reservation_status)) continue;
			if (isCheckoutStatus(doc.reservation_status)) continue;

			for (const rtObj of doc.pickedRoomsType) {
				const units = getReservationUnits(rtObj, doc);
				if (!units) continue;

				let key = resolveRoomKey(rtObj);
				if (!key) key = ensureDerivedRoomType(rtObj);

				if (!usageByDay7[key]) {
					usageByDay7[key] = [0, 0, 0, 0, 0, 0, 0];
				}

				for (let i = 0; i < 7; i++) {
					const dayDate = dayList7[i];
					if (dayDate >= cIn && dayDate < cOut) {
						usageByDay7[key][i] += units;
					}
				}
			}
		}

		const dynamicRoomsTable = [];
		let rowKeyCounter = 1;
		const allTypeKeys = new Set([
			...Object.keys(baseTotalsLookup),
			...Object.keys(usageByDay7),
		]);
		for (const key of allTypeKeys) {
			const rt = roomTypeByKey.get(key);
			const label = rt?.label || rt?.displayName || rt?.roomType || key;
			const total = toNumber(baseTotalsLookup[key], 0);
			const dailyUsage = usageByDay7[key] || [0, 0, 0, 0, 0, 0, 0];
			const sold = toNumber(dailyUsage[0], 0);
			const peakBooked = Math.max(...dailyUsage);
			const totalForDisplay = total > 0 ? total : peakBooked;
			const available = Math.max(totalForDisplay - sold, 0);
			const availabilityNext7 = Math.max(totalForDisplay - peakBooked, 0);

			dynamicRoomsTable.push({
				key: String(rowKeyCounter++),
				type: label,
				sold,
				total: totalForDisplay,
				bookingNext7: peakBooked,
				availabilityNext7,
				available,
			});
		}

		dynamicRoomsTable.sort((a, b) =>
			String(a.type || "").localeCompare(String(b.type || ""), undefined, {
				sensitivity: "base",
			})
		);

		// You can wire this to real housekeeping if you have it
		const housekeeping = { clean: 25, cleaning: 0, dirty: 0 };
		const thirdRow = { roomsTable: dynamicRoomsTable, housekeeping };

		// ============== FOURTH ROW ==============
		const pipelineTopChannels = [
			{ $match: { $and: [baseFilter, statusNotExcluded] } },
			{ $group: { _id: "$booking_source", count: { $sum: 1 } } },
			{ $sort: { count: -1 } },
			{ $limit: 5 },
		];
		const topChannelsAgg = await safeAggregate(pipelineTopChannels);
		const topChannels = topChannelsAgg.map((tc) => ({
			name: tc?._id || "Other",
			value: tc?.count || 0,
			fillColor: "#4285F4",
		}));

		const roomStatsReservations = await safeFind({
			cond: statusNotExcluded,
			select:
				"pickedRoomsType checkin_date checkout_date days_of_residence total_amount reservation_status bedNumber",
		});

		const roomNightsByKey = {};
		const roomRevenueByKey = {};
		const dayMs = 24 * 60 * 60 * 1000;

		const getReservationNights = (reservation) => {
			const ci = new Date(reservation?.checkin_date || "");
			const co = new Date(reservation?.checkout_date || "");
			if (!Number.isNaN(ci.getTime()) && !Number.isNaN(co.getTime())) {
				const diff = Math.round((co - ci) / dayMs);
				if (diff > 0) return diff;
			}
			const fallback = toNumber(reservation?.days_of_residence, 0);
			return fallback > 0 ? fallback : 0;
		};

		const getRoomNights = (room, fallbackNights) => {
			if (Array.isArray(room?.pricingByDay) && room.pricingByDay.length > 0) {
				return room.pricingByDay.length;
			}
			return fallbackNights;
		};

		const sumRoomPricing = (room) => {
			if (!Array.isArray(room?.pricingByDay) || room.pricingByDay.length === 0) {
				return null;
			}

			const total = room.pricingByDay.reduce((sum, day) => {
				const dayTotal = toNumber(
					day?.totalPriceWithCommission ??
						day?.price ??
						day?.totalPriceWithoutCommission ??
						day?.rootPrice,
					0
				);
				return sum + dayTotal;
			}, 0);

			return total;
		};

		for (const reservation of roomStatsReservations) {
			if (!Array.isArray(reservation?.pickedRoomsType)) continue;
			if (isExcludedStatus(reservation.reservation_status)) continue;

			const fallbackNights = getReservationNights(reservation);

			const roomEntries = reservation.pickedRoomsType.map((room) => {
				const units = getReservationUnits(room, reservation);
				let key = resolveRoomKey(room);
				if (!key) key = ensureDerivedRoomType(room);

				const nights = getRoomNights(room, fallbackNights);
				const hasPricingByDay = Array.isArray(room?.pricingByDay)
					? room.pricingByDay.length > 0
					: false;
				const chosenPrice = toNumber(room?.chosenPrice, 0);

				let revenue = null;
				if (hasPricingByDay) {
					const pricingTotal = sumRoomPricing(room);
					revenue =
						pricingTotal === null ? 0 : pricingTotal * Math.max(units, 1);
				} else if (chosenPrice > 0 && nights > 0) {
					revenue = chosenPrice * nights * Math.max(units, 1);
				}

				return {
					key,
					units: Math.max(units, 0),
					nights: Math.max(nights, 0),
					revenue,
					hasPricing: revenue !== null,
				};
			});

			const knownRevenue = roomEntries.reduce(
				(sum, entry) => sum + (entry.hasPricing ? entry.revenue : 0),
				0
			);
			const unknownUnits = roomEntries.reduce(
				(sum, entry) => sum + (!entry.hasPricing ? entry.units : 0),
				0
			);
			const totalAmount = toNumber(reservation?.total_amount, 0);
			const remaining = Math.max(totalAmount - knownRevenue, 0);

			for (const entry of roomEntries) {
				if (!entry.key) continue;

				const roomsNights = entry.nights * entry.units;
				if (roomsNights > 0) {
					roomNightsByKey[entry.key] =
						(roomNightsByKey[entry.key] || 0) + roomsNights;
				}

				let finalRevenue = entry.revenue;
				if (!entry.hasPricing) {
					finalRevenue =
						unknownUnits > 0 ? remaining * (entry.units / unknownUnits) : 0;
				}
				if (finalRevenue > 0) {
					roomRevenueByKey[entry.key] =
						(roomRevenueByKey[entry.key] || 0) + finalRevenue;
				}
			}
		}

		const resolveRoomLabel = (key) => {
			const rt = roomTypeByKey.get(key);
			if (!rt) return key || "Unspecified";
			return rt.label || rt.displayName || rt.roomType || key || "Unspecified";
		};

		const roomStatKeys = new Set([
			...Object.keys(roomNightsByKey),
			...Object.keys(roomRevenueByKey),
		]);

		const roomNightsByType = Array.from(roomStatKeys)
			.map((key) => ({
				type: resolveRoomLabel(key),
				value: toNumber(roomNightsByKey[key], 0),
				fillColor: "#E74C3C",
			}))
			.sort((a, b) => b.value - a.value);

		const roomRevenueByType = Array.from(roomStatKeys)
			.map((key) => ({
				type: resolveRoomLabel(key),
				value: toNumber(roomRevenueByKey[key], 0),
				fillColor: "#FF7373",
			}))
			.sort((a, b) => b.value - a.value);
		const fourthRow = { topChannels, roomNightsByType, roomRevenueByType };

		// ============== FIFTH ROW ==============
		const lineEnd = nowMoment.clone().endOf("day").toDate();
		const lineStart = nowMoment
			.clone()
			.startOf("day")
			.subtract(6, "days")
			.toDate();

		const pipelineCheckIn = [
			{
				$match: {
					$and: [
						baseFilter,
						{ checkin_date: { $gte: lineStart, $lte: lineEnd } },
						{ reservation_status: activeStatusFilter },
					],
				},
			},
			{
				$group: {
					_id: {
						$dateToString: {
							format: "%Y-%m-%d",
							date: "$checkin_date",
							timezone,
						},
					},
					count: { $sum: 1 },
				},
			},
			{ $sort: { _id: 1 } },
		];

		const pipelineCheckOut = [
			{
				$match: {
					$and: [
						baseFilter,
						{ checkout_date: { $gte: lineStart, $lte: lineEnd } },
						{ reservation_status: activeStatusFilter },
					],
				},
			},
			{
				$group: {
					_id: {
						$dateToString: {
							format: "%Y-%m-%d",
							date: "$checkout_date",
							timezone,
						},
					},
					count: { $sum: 1 },
				},
			},
			{ $sort: { _id: 1 } },
		];

		const [checkInAgg, checkOutAgg] = await Promise.all([
			safeAggregate(pipelineCheckIn),
			safeAggregate(pipelineCheckOut),
		]);

		const lineChartCategories = [];
		const checkInData = [];
		const checkOutData = [];

		let dayCursor = moment.tz(lineStart, timezone).startOf("day");
		const endCursor = moment.tz(lineEnd, timezone).startOf("day");
		while (dayCursor.isSameOrBefore(endCursor, "day")) {
			const label = dayCursor.format("YYYY-MM-DD");
			lineChartCategories.push(label);

			const foundIn = checkInAgg.find((x) => x?._id === label);
			checkInData.push(foundIn ? foundIn.count : 0);

			const foundOut = checkOutAgg.find((x) => x?._id === label);
			checkOutData.push(foundOut ? foundOut.count : 0);

			dayCursor = dayCursor.clone().add(1, "day");
		}

		// Replace visitorsLine with real data when available
		const visitorsLine = {
			categories: ["10am", "2pm", "6pm", "11pm"],
			yesterday: [10, 20, 30, 40],
			today: [20, 40, 35, 50],
		};

		const fifthRow = {
			bookingLine: {
				categories: lineChartCategories,
				checkIn: checkInData,
				checkOut: checkOutData,
			},
			visitorsLine,
		};

		// ============== DonutChartCard => dynamic
		const donutChartCard = {
			availableRooms: occupancy.available,
			totalRooms: occupancy.overallRoomsCount,
		};

		// ============== HorizontalBarChartCard => Booked Room Today (pending/done/finish)
		const [pendingCount, doneCount, finishCount] = await Promise.all([
			safeCount({
				reservation_status: "pending",
				checkin_date: { $gte: startOfToday, $lte: endOfToday },
			}),
			safeCount({
				reservation_status: "done",
				checkin_date: { $gte: startOfToday, $lte: endOfToday },
			}),
			safeCount({
				reservation_status: "finish",
				checkin_date: { $gte: startOfToday, $lte: endOfToday },
			}),
		]);
		const horizontalBarChartCard = {
			pending: pendingCount,
			done: doneCount,
			finish: finishCount,
		};

		// ============== Final response ==============
		const responseData = {
			firstRow,
			secondRow,
			thirdRow,
			fourthRow,
			fifthRow,
			donutChartCard,
			horizontalBarChartCard,
		};

		return res.json({ success: true, data: responseData });
	} catch (err) {
		console.error("Error in adminDashboardReport:", err);
		// Return consistent shape so frontend can render zero-state even on 500
		return res.status(500).json({
			success: false,
			message: err.message || "Failed to get admin dashboard report",
			data: makeEmptyReport(),
		});
	}
};

// -------------------------------
// Hotel Occupancy (accurate resolver + derived rooms)
// -------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
const MANUAL_CAPTURED_CONFIRMATIONS = new Set(["2944008828"]);

function safeNumber(val, fallback = 0) {
	const n = Number(val);
	return Number.isFinite(n) ? n : fallback;
}

function setNoCacheHeaders(res) {
	res.set("Cache-Control", "no-store");
	res.set("Pragma", "no-cache");
	res.set("Expires", "0");
	res.set("ETag", Date.now().toString());
}

function normalizeRoomKeyLabel(str = "") {
	const raw = String(str || "").trim();
	if (!raw) return "";
	return raw
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[\u200B-\u200D\uFEFF]/g, "")
		.replace(/[\u2010-\u2015\u2212]/g, "-") // normalize dashes
		.replace(/[’'`]/g, "")
		.replace(/[^a-z0-9\u0600-\u06FF]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-+|-+$/g, "");
}

function humanizeRoomType(val = "") {
	const raw = String(val || "").trim();
	if (!raw) return "Room";
	const spaced = raw
		.replace(/_/g, " ")
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.replace(/\s+/g, " ")
		.trim();
	return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function getRoomTypeLabel(roomTypeVal) {
	// Use your existing roomTypeLabelMap if present
	if (
		typeof roomTypeLabelMap !== "undefined" &&
		roomTypeLabelMap &&
		roomTypeLabelMap[roomTypeVal]
	) {
		return roomTypeLabelMap[roomTypeVal];
	}
	return humanizeRoomType(roomTypeVal);
}

function parseMonthParam(monthStr) {
	const now = new Date();
	const [yearStr, monthPart] = String(monthStr || "").split("-");
	let year = parseInt(yearStr, 10);
	let monthIndex = parseInt(monthPart, 10) - 1;

	if (
		!Number.isFinite(year) ||
		!Number.isFinite(monthIndex) ||
		monthIndex < 0 ||
		monthIndex > 11
	) {
		year = now.getUTCFullYear();
		monthIndex = now.getUTCMonth();
	}

	const start = new Date(Date.UTC(year, monthIndex, 1, 0, 0, 0, 0));
	const endExclusive = new Date(Date.UTC(year, monthIndex + 1, 1, 0, 0, 0, 0));
	const daysInMonth = Math.max(1, Math.round((endExclusive - start) / DAY_MS));

	return {
		start,
		endExclusive,
		daysInMonth,
		label: `${year}-${String(monthIndex + 1).padStart(2, "0")}`,
		year,
		monthIndex,
	};
}

function parseCustomRange(startStr, endStr) {
	if (!startStr || !endStr) return null;

	const startRaw = new Date(startStr);
	const endRaw = new Date(endStr);
	if (Number.isNaN(startRaw.getTime()) || Number.isNaN(endRaw.getTime()))
		return null;

	const start = new Date(
		Date.UTC(
			startRaw.getUTCFullYear(),
			startRaw.getUTCMonth(),
			startRaw.getUTCDate()
		)
	);

	let endExclusive = new Date(
		Date.UTC(endRaw.getUTCFullYear(), endRaw.getUTCMonth(), endRaw.getUTCDate())
	);

	// If endStr is "YYYY-MM-DD" (no time), treat it as inclusive end date -> endExclusive = +1 day
	const endHasExplicitTime = String(endStr).includes("T");
	const endIsMidnightUTC =
		endRaw.getUTCHours() === 0 &&
		endRaw.getUTCMinutes() === 0 &&
		endRaw.getUTCSeconds() === 0 &&
		endRaw.getUTCMilliseconds() === 0;

	const treatEndInclusive = !endHasExplicitTime || !endIsMidnightUTC;
	if (treatEndInclusive)
		endExclusive = new Date(endExclusive.getTime() + DAY_MS);

	if (start >= endExclusive) return null;

	const daysInMonth = Math.max(1, Math.round((endExclusive - start) / DAY_MS));
	const inclusiveEnd = new Date(endExclusive.getTime() - DAY_MS);

	return {
		start,
		endExclusive,
		daysInMonth,
		label: `${start.toISOString().slice(0, 10)} - ${inclusiveEnd
			.toISOString()
			.slice(0, 10)}`,
		year: start.getUTCFullYear(),
		monthIndex: start.getUTCMonth(),
	};
}

function normalizePaymentStatus(value = "") {
	const raw = String(value || "")
		.toLowerCase()
		.trim();
	if (!raw) return "";
	if (["captured", "paid online", "paid_online"].includes(raw))
		return "captured";
	if (["paid offline", "paid_offline", "onsite"].includes(raw))
		return "paid offline";
	if (["not paid", "not_paid", "unpaid"].includes(raw)) return "not paid";
	if (["not captured", "not_captured"].includes(raw)) return "not captured";
	return raw;
}

function parsePaymentStatusFilter(rawStatuses) {
	if (!rawStatuses) return new Set();
	const incoming = Array.isArray(rawStatuses)
		? rawStatuses
		: String(rawStatuses || "").split(",");
	const filtered = new Set();
	incoming.forEach((item) => {
		const norm = normalizePaymentStatus(item);
		if (norm) filtered.add(norm);
	});
	return filtered;
}

/**
 * ✅ Payment logic EXACTLY matching EnhancedContentTable:
 * Captured / Paid Offline / Not Paid / Not Captured
 */
function paymentMeta(reservation = {}) {
	const pd = reservation?.paypal_details || {};
	const pmt = String(reservation?.payment || "")
		.toLowerCase()
		.trim();
	const isCardPayment = /\bcredit\b|\bdebit\b/.test(pmt);

	const legacyCaptured = !!reservation?.payment_details?.captured;

	const onsitePaidAmount = safeNumber(
		reservation?.payment_details?.onsite_paid_amount
	);
	const payOffline = onsitePaidAmount > 0 || pmt === "paid offline";

	const capTotal = safeNumber(pd?.captured_total_usd);
	const limitUsd =
		typeof pd?.bounds?.limit_usd === "number"
			? safeNumber(pd.bounds.limit_usd)
			: 0;
	const pendingUsd = safeNumber(pd?.pending_total_usd);

	const initialCompleted =
		String(pd?.initial?.capture_status || "").toUpperCase() === "COMPLETED";
	const anyMitCompleted =
		Array.isArray(pd?.mit) &&
		pd.mit.some(
			(c) => String(c?.capture_status || "").toUpperCase() === "COMPLETED"
		);

	const manualOverrideCaptured = MANUAL_CAPTURED_CONFIRMATIONS.has(
		String(reservation?.confirmation_number || "").trim()
	);

	const isCaptured =
		manualOverrideCaptured ||
		legacyCaptured ||
		capTotal > 0 ||
		initialCompleted ||
		anyMitCompleted ||
		pmt === "paid online" ||
		isCardPayment;

	const isNotPaid = pmt === "not paid" && !isCaptured && !payOffline;

	let status = "Not Captured";
	if (isCaptured) status = "Captured";
	else if (payOffline) status = "Paid Offline";
	else if (isNotPaid) status = "Not Paid";

	let hint = "";
	const pieces = [];
	if (capTotal > 0) pieces.push(`captured $${capTotal.toFixed(2)}`);
	if (limitUsd > 0) pieces.push(`limit $${limitUsd.toFixed(2)}`);
	if (pendingUsd > 0) pieces.push(`pending $${pendingUsd.toFixed(2)}`);
	if (pieces.length) hint = `PayPal: ${pieces.join(" / ")}`;

	const totalAmount = safeNumber(reservation?.total_amount);
	const paidAmount =
		status === "Captured"
			? totalAmount
			: status === "Paid Offline"
			? onsitePaidAmount
			: 0;

	return {
		status,
		normalizedStatus: normalizePaymentStatus(status),
		label: status,
		totalAmount,
		paidAmount,
		onsitePaidAmount,
		hint,
	};
}

const PAYMENT_STATUS_ORDER = [
	"Captured",
	"Paid Offline",
	"Not Captured",
	"Not Paid",
];

function buildBookingSourcePaymentSummary(
	reservations = [],
	paymentStatusFilter = new Set()
) {
	const rowsMap = new Map();
	const columnTotals = {};
	const statusSet = new Set(PAYMENT_STATUS_ORDER);
	let overallTotal = 0;

	for (const status of PAYMENT_STATUS_ORDER) {
		columnTotals[status] = 0;
	}

	for (const reservation of reservations) {
		if (!reservation) continue;

		const pay = paymentMeta(reservation);
		if (paymentStatusFilter.size && !paymentStatusFilter.has(pay.normalizedStatus))
			continue;

		const bookingSource =
			String(reservation?.booking_source || "").trim() || "Unknown";
		const amount = safeNumber(pay.totalAmount);

		if (!rowsMap.has(bookingSource)) {
			rowsMap.set(bookingSource, {
				booking_source: bookingSource,
				totalsByStatus: {},
				rowTotal: 0,
			});
		}

		const row = rowsMap.get(bookingSource);
		row.totalsByStatus[pay.status] =
			safeNumber(row.totalsByStatus[pay.status]) + amount;
		row.rowTotal = safeNumber(row.rowTotal) + amount;

		if (columnTotals[pay.status] == null) columnTotals[pay.status] = 0;
		columnTotals[pay.status] += amount;
		overallTotal += amount;
		statusSet.add(pay.status);
	}

	const statuses = [
		...PAYMENT_STATUS_ORDER,
		...Array.from(statusSet).filter(
			(status) => !PAYMENT_STATUS_ORDER.includes(status)
		),
	];

	const rows = Array.from(rowsMap.values())
		.map((row) => {
			statuses.forEach((status) => {
				if (row.totalsByStatus[status] == null) {
					row.totalsByStatus[status] = 0;
				}
			});
			return row;
		})
		.sort((a, b) => {
			const diff = safeNumber(b.rowTotal) - safeNumber(a.rowTotal);
			if (diff !== 0) return diff;
			return String(a.booking_source || "").localeCompare(
				String(b.booking_source || ""),
				undefined,
				{ sensitivity: "base" }
			);
		});

	statuses.forEach((status) => {
		if (columnTotals[status] == null) columnTotals[status] = 0;
	});

	return {
		statuses,
		rows,
		columnTotals,
		overallTotal,
		currency: "SAR",
	};
}

async function resolveHotelIdsByNames(hotelsParam) {
	if (!hotelsParam || hotelsParam === "all") return [];
	const names = String(hotelsParam)
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean);
	if (!names.length) return [];
	const regexArr = names.map((name) => new RegExp(`^${name}$`, "i"));
	const matchedHotels = await HotelDetails.find(
		{ hotelName: { $in: regexArr } },
		{ _id: 1 }
	).lean();
	return matchedHotels.map((h) => h._id);
}

exports.bookingSourcePaymentSummary = async (req, res) => {
	try {
		const {
			hotelId,
			hotels,
			month,
			start,
			end,
			includeCancelled,
			excludeCancelled,
			paymentStatuses,
		} = req.query || {};

		let resolvedHotelId = null;
		if (hotelId && hotelId !== "all") {
			if (!ObjectId.isValid(hotelId)) {
				return res.status(400).json({
					success: false,
					message: "Invalid hotelId",
				});
			}
			resolvedHotelId = new ObjectId(hotelId);
		}

		let hotelIds = [];
		if (!resolvedHotelId && hotels && hotels !== "all") {
			hotelIds = await resolveHotelIdsByNames(hotels);
			if (!hotelIds.length) {
				return res.json({
					success: true,
					data: buildBookingSourcePaymentSummary([], new Set()),
				});
			}
		}

		const range =
			parseCustomRange(start, end) || (month ? parseMonthParam(month) : null);

		const query = {};
		if (resolvedHotelId) {
			query.hotelId = resolvedHotelId;
		} else if (hotelIds.length) {
			query.hotelId = { $in: hotelIds };
		}

		const includeCancelledFlag =
			String(includeCancelled || "").toLowerCase() === "true";
		const excludeCancelledFlag =
			String(excludeCancelled || "").toLowerCase() === "true";

		if (!includeCancelledFlag) {
			const excludedStatuses = excludeCancelledFlag
				? ["cancelled"]
				: ["cancelled", "no show", "no_show", "noshow"];
			query.reservation_status = { $nin: excludedStatuses };
		}

		if (range?.start && range?.endExclusive) {
			query.checkin_date = { $lt: range.endExclusive };
			query.checkout_date = { $gt: range.start };
		} else {
			query.createdAt = { $gte: PAGE_START_DATE_UTC };
		}

		const reservations = await Reservations.find(query)
			.select(
				"booking_source total_amount payment payment_details paypal_details confirmation_number reservation_status"
			)
			.lean();

		const paymentStatusFilter = parsePaymentStatusFilter(paymentStatuses);
		const summary = buildBookingSourcePaymentSummary(
			reservations,
			paymentStatusFilter
		);

		return res.json({
			success: true,
			data: summary,
			range: range?.label || null,
		});
	} catch (err) {
		console.error("Error in bookingSourcePaymentSummary:", err);
		return res.status(500).json({
			success: false,
			message: err.message || "Failed to build booking source summary",
		});
	}
};

function buildReservationBaseQuery({
	hotelId,
	start,
	endExclusive,
	includeCancelled,
}) {
	const q = {
		hotelId: new ObjectId(hotelId),
		checkin_date: { $lt: endExclusive },
		checkout_date: { $gt: start },
	};

	const inc = String(includeCancelled || "").toLowerCase() === "true";
	if (!inc) {
		q.reservation_status = {
			$nin: ["cancelled", "no show", "no_show", "noshow"],
		};
	}
	return q;
}

function buildDayBaseQuery({ hotelId, dayStart, dayEnd, includeCancelled }) {
	const q = {
		hotelId: new ObjectId(hotelId),
		checkin_date: { $lt: dayEnd },
		checkout_date: { $gt: dayStart },
	};

	const inc = String(includeCancelled || "").toLowerCase() === "true";
	if (!inc) {
		q.reservation_status = {
			$nin: ["cancelled", "no show", "no_show", "noshow"],
		};
	}
	return q;
}

function buildBaseRoomTypes(
	roomCountDetails = [],
	displayMode = "displayName"
) {
	const rawRooms = Array.isArray(roomCountDetails) ? roomCountDetails : [];
	const aggregated = new Map();

	for (const r of rawRooms) {
		if (!r) continue;

		const roomTypeVal = String(r.roomType || r.room_type || "").trim();
		const displayNameVal = String(r.displayName || "").trim();

		const rawCount = safeNumber(r.count);
		if (rawCount <= 0) continue;

		const baseKeyRaw =
			displayMode === "displayName"
				? displayNameVal || roomTypeVal || String(r._id || "")
				: roomTypeVal || String(r._id || "");

		let key = normalizeRoomKeyLabel(baseKeyRaw);
		if (!key)
			key =
				normalizeRoomKeyLabel(String(r._id || "")) ||
				`room-${Math.random().toString(36).slice(2, 8)}`;

		const bedsMultiplier =
			roomTypeVal === "individualBed"
				? Math.max(1, Math.round(safeNumber(r.bedsCount, 1)))
				: 1;

		const totalRooms = rawCount * bedsMultiplier;

		if (!aggregated.has(key)) {
			aggregated.set(key, {
				key,
				roomType: roomTypeVal,
				displayName: displayNameVal,
				label:
					displayMode === "displayName"
						? displayNameVal || getRoomTypeLabel(roomTypeVal)
						: getRoomTypeLabel(roomTypeVal) || displayNameVal || "Room",
				totalRooms,
				rawRoomCount: rawCount,
				bedsCount: safeNumber(r.bedsCount),
				color: r.roomColor || null,
				derived: false,
			});
		} else {
			const prev = aggregated.get(key);
			prev.totalRooms += totalRooms;
			prev.rawRoomCount += rawCount;
		}
	}

	return Array.from(aggregated.values());
}

function initDayCell(capacity = 0) {
	return {
		capacity: safeNumber(capacity),
		booked: 0,
		occupied: 0,
		available: safeNumber(capacity),
		occupancyRate: 0,
		bookingRate: 0,
		overbooked: false,
		overage: 0,
	};
}

function initDaySkeleton(roomTypes = []) {
	const rooms = {};
	for (const rt of roomTypes) {
		rooms[rt.key] = initDayCell(rt.totalRooms);
	}
	return {
		rooms,
		totals: {
			capacity: 0,
			booked: 0,
			occupied: 0,
			available: 0,
			occupancyRate: 0,
			bookingRate: 0,
			overbooked: false,
			overage: 0,
		},
	};
}

// -------------------------------
// Core compute (used by calendar + warnings)
// -------------------------------
async function computeOccupancy({
	hotelId,
	start,
	endExclusive,
	daysInMonth,
	label,
	year,
	monthIndex,
	displayMode,
	includeCancelled,
	paymentStatusFilter,
}) {
	const hotel = await HotelDetails.findById(hotelId)
		.select("hotelName roomCountDetails")
		.lean();
	if (!hotel) {
		return {
			error: { code: 404, message: "Hotel not found for occupancy view" },
		};
	}

	// Base inventory
	const baseRoomTypes = buildBaseRoomTypes(
		hotel.roomCountDetails || [],
		displayMode
	);

	const baseTotalRoomsAll = baseRoomTypes.reduce(
		(sum, rt) => sum + safeNumber(rt.totalRooms),
		0
	);
	const totalPhysicalRooms = baseRoomTypes.reduce(
		(sum, rt) => sum + safeNumber(rt.rawRoomCount),
		0
	);

	// Indexes
	const roomTypeByKey = new Map();
	const keyNormToKey = new Map();
	const displayNormToKeys = new Map(); // norm(displayName/label) -> Set(keys)
	const roomTypeNormToKeys = new Map(); // norm(roomType) -> Set(keys)

	const roomTypes = [...baseRoomTypes];

	const addToSetMap = (map, k, val) => {
		if (!k) return;
		if (!map.has(k)) map.set(k, new Set());
		map.get(k).add(val);
	};

	const indexRoomType = (rt) => {
		roomTypeByKey.set(rt.key, rt);

		const normKey = normalizeRoomKeyLabel(rt.key);
		if (normKey) keyNormToKey.set(normKey, rt.key);

		const aliases = new Set([rt.displayName, rt.label, rt.key].filter(Boolean));
		for (const a of aliases)
			addToSetMap(displayNormToKeys, normalizeRoomKeyLabel(a), rt.key);

		if (rt.roomType)
			addToSetMap(
				roomTypeNormToKeys,
				normalizeRoomKeyLabel(rt.roomType),
				rt.key
			);
	};

	for (const rt of baseRoomTypes) indexRoomType(rt);

	// Days skeleton (we will add derived keys to all days if discovered)
	const days = [];
	for (let i = 0; i < daysInMonth; i++) {
		const dateObj = new Date(start.getTime() + i * DAY_MS);
		const isoDate = dateObj.toISOString().slice(0, 10);
		days.push({ date: isoDate, ...initDaySkeleton(roomTypes) });
	}

	const ensureKeyInDays = (key, capacityDefault = 0) => {
		for (const d of days) {
			if (!d.rooms[key]) d.rooms[key] = initDayCell(capacityDefault);
		}
	};

	const pickFromSet = (set, raw, kind) => {
		if (!set || set.size === 0) return null;
		if (set.size === 1) return Array.from(set)[0];

		// If ambiguous, try exact raw match against stored room types
		const rawLower = String(raw || "")
			.trim()
			.toLowerCase();
		if (!rawLower) return null;

		for (const key of set) {
			const rt = roomTypeByKey.get(key);
			if (!rt) continue;

			const candidates =
				kind === "display"
					? [rt.displayName, rt.label]
					: kind === "roomType"
					? [rt.roomType]
					: [];

			for (const c of candidates) {
				if (
					String(c || "")
						.trim()
						.toLowerCase() === rawLower
				)
					return key;
			}
		}

		// fallback deterministic
		return Array.from(set)[0];
	};

	// ✅ KEY FIX: in displayName mode, match displayName FIRST to avoid familyRooms collisions
	const resolveRoomKey = (room = {}) => {
		const rawKey = room?.key || room?.roomKey || "";
		const rawRoomType = room?.room_type || room?.roomType || "";
		const rawDisplay =
			room?.displayName || room?.display_name || room?.label || "";

		const normKey = normalizeRoomKeyLabel(rawKey);
		if (normKey && keyNormToKey.has(normKey)) return keyNormToKey.get(normKey);

		const normDisplay = normalizeRoomKeyLabel(rawDisplay);
		const normRoomType = normalizeRoomKeyLabel(rawRoomType);

		if (displayMode === "displayName") {
			if (normDisplay) {
				const set = displayNormToKeys.get(normDisplay);
				const picked = pickFromSet(set, rawDisplay, "display");
				if (picked) return picked;
			}

			// Only use roomType fallback if UNIQUE
			if (normRoomType) {
				const set = roomTypeNormToKeys.get(normRoomType);
				if (set && set.size === 1) return Array.from(set)[0];
			}

			return null;
		}

		// roomType mode: roomType first
		if (normRoomType) {
			const set = roomTypeNormToKeys.get(normRoomType);
			if (set && set.size) return Array.from(set)[0];
		}

		if (normDisplay) {
			const set = displayNormToKeys.get(normDisplay);
			const picked = pickFromSet(set, rawDisplay, "display");
			if (picked) return picked;
		}

		return null;
	};

	const deriveKeyFromRoom = (room = {}) => {
		const rawRoomType = String(room?.room_type || room?.roomType || "").trim();
		const rawDisplay = String(
			room?.displayName || room?.display_name || room?.label || ""
		).trim();

		const labelCandidate =
			displayMode === "displayName"
				? rawDisplay ||
				  getRoomTypeLabel(rawRoomType) ||
				  rawRoomType ||
				  "Unknown Room"
				: getRoomTypeLabel(rawRoomType) ||
				  rawDisplay ||
				  rawRoomType ||
				  "Unknown Room";

		let key = normalizeRoomKeyLabel(labelCandidate);
		if (!key)
			key =
				normalizeRoomKeyLabel(rawDisplay) || normalizeRoomKeyLabel(rawRoomType);
		if (!key) key = `unknown-room-${Math.random().toString(36).slice(2, 8)}`;

		return {
			key,
			label: labelCandidate,
			roomType: rawRoomType,
			displayName: rawDisplay,
		};
	};

	const ensureDerivedRoomType = (room = {}) => {
		const { key, label, roomType, displayName } = deriveKeyFromRoom(room);

		if (roomTypeByKey.has(key)) return key;

		const rt = {
			key,
			roomType,
			displayName,
			label,
			totalRooms: 0, // unknown -> capacity will be booked/day
			rawRoomCount: 0,
			bedsCount: 0,
			color: null,
			derived: true,
		};

		roomTypes.push(rt);
		indexRoomType(rt);
		ensureKeyInDays(key, 0);

		return key;
	};

	const baseQuery = buildReservationBaseQuery({
		hotelId,
		start,
		endExclusive,
		includeCancelled,
	});

	const reservations = await Reservations.find(baseQuery)
		.select(
			"confirmation_number checkin_date checkout_date pickedRoomsType reservation_status total_amount payment payment_details paypal_details"
		)
		.lean();

	let totalAmount = 0;
	const paymentBreakdown = {};

	// 1) Count bookings into day.rooms[key].booked
	for (const reservation of reservations) {
		if (
			!reservation ||
			!reservation.checkin_date ||
			!reservation.checkout_date ||
			!Array.isArray(reservation.pickedRoomsType)
		)
			continue;

		const pay = paymentMeta(reservation);
		if (
			paymentStatusFilter.size &&
			!paymentStatusFilter.has(pay.normalizedStatus)
		)
			continue;

		totalAmount += pay.totalAmount;

		if (!paymentBreakdown[pay.status]) {
			paymentBreakdown[pay.status] = {
				status: pay.status,
				label: pay.label,
				count: 0,
				totalAmount: 0,
				paidAmount: 0,
				onsitePaidAmount: 0,
			};
		}
		paymentBreakdown[pay.status].count += 1;
		paymentBreakdown[pay.status].totalAmount += pay.totalAmount;
		paymentBreakdown[pay.status].paidAmount += pay.paidAmount;
		paymentBreakdown[pay.status].onsitePaidAmount += pay.onsitePaidAmount;

		const ci = new Date(reservation.checkin_date);
		const co = new Date(reservation.checkout_date);
		ci.setUTCHours(0, 0, 0, 0);
		co.setUTCHours(0, 0, 0, 0);

		const overlapStart = Math.max(ci.getTime(), start.getTime());
		const overlapEnd = Math.min(co.getTime(), endExclusive.getTime());
		if (overlapStart >= overlapEnd) continue;

		for (const room of reservation.pickedRoomsType) {
			if (!room) continue;

			let key = resolveRoomKey(room);
			if (!key) key = ensureDerivedRoomType(room);

			const count = safeNumber(room?.count);
			if (!count) continue;

			for (let ts = overlapStart; ts < overlapEnd; ts += DAY_MS) {
				const dayIndex = Math.floor((ts - start.getTime()) / DAY_MS);
				const dayEntry = days[dayIndex];
				if (!dayEntry) continue;

				if (!dayEntry.rooms[key]) dayEntry.rooms[key] = initDayCell(0);
				dayEntry.rooms[key].booked += count;
			}
		}
	}

	// 2) Post-process day cells (capacity/occupied/available/rates) + summary
	const warnings = [];
	const occupancyByType = {};
	for (const rt of roomTypes) {
		occupancyByType[rt.key] = {
			key: rt.key,
			label: rt.label,
			color: rt.color || null,
			totalRooms: safeNumber(rt.totalRooms),
			capacityNights: 0,
			bookedNights: 0,
			occupiedNights: 0,
			derived: !!rt.derived,
		};
	}

	let bookedRoomNights = 0;
	let occupiedRoomNights = 0;
	let capacityRoomNights = 0;

	let peakDay = {
		date: null,
		occupancyRate: 0,
		booked: 0,
		occupied: 0,
		capacity: 0,
	};

	for (const day of days) {
		let dayCapacity = 0;
		let dayBooked = 0;
		let dayOccupied = 0;
		let dayAvail = 0;

		for (const rt of roomTypes) {
			const cell = day.rooms[rt.key] || initDayCell(0);

			const booked = safeNumber(cell.booked);
			const capacity = rt.derived ? booked : safeNumber(rt.totalRooms); // ✅ derived rooms => capacity = booked (1/1 style)
			const occupied = Math.min(booked, capacity);
			const available = Math.max(capacity - occupied, 0);

			cell.capacity = capacity;
			cell.occupied = occupied;
			cell.available = available;

			cell.occupancyRate = capacity > 0 ? occupied / capacity : 0;
			cell.bookingRate = capacity > 0 ? booked / capacity : 0;

			cell.overbooked = !rt.derived && booked > capacity;
			cell.overage = cell.overbooked ? Math.max(booked - capacity, 0) : 0;

			day.rooms[rt.key] = cell;

			dayCapacity += capacity;
			dayBooked += booked;
			dayOccupied += occupied;
			dayAvail += available;

			occupancyByType[rt.key].capacityNights += capacity;
			occupancyByType[rt.key].bookedNights += booked;
			occupancyByType[rt.key].occupiedNights += occupied;

			if (cell.overbooked) {
				warnings.push({
					date: day.date,
					roomType: rt.label || rt.key,
					roomKey: rt.key,
					booked,
					capacity,
					overage: cell.overage,
				});
			}
		}

		day.totals.capacity = dayCapacity;
		day.totals.booked = dayBooked;
		day.totals.occupied = dayOccupied;
		day.totals.available = dayAvail;
		day.totals.occupancyRate = dayCapacity > 0 ? dayOccupied / dayCapacity : 0;
		day.totals.bookingRate = dayCapacity > 0 ? dayBooked / dayCapacity : 0;
		day.totals.overbooked = dayBooked > dayCapacity;
		day.totals.overage = day.totals.overbooked
			? Math.max(dayBooked - dayCapacity, 0)
			: 0;

		bookedRoomNights += dayBooked;
		occupiedRoomNights += dayOccupied;
		capacityRoomNights += dayCapacity;

		if (day.totals.occupancyRate > peakDay.occupancyRate) {
			peakDay = {
				date: day.date,
				occupancyRate: day.totals.occupancyRate,
				booked: dayBooked,
				occupied: dayOccupied,
				capacity: dayCapacity,
			};
		}
	}

	// roomTypes stable sorting by label (nice UI)
	roomTypes.sort((a, b) =>
		String(a.label || "").localeCompare(String(b.label || ""), undefined, {
			sensitivity: "base",
		})
	);

	const occupancyByTypeArr = Object.values(occupancyByType).map((v) => ({
		key: v.key,
		label: v.label,
		color: v.color,
		totalRooms: v.totalRooms,
		capacityNights: v.capacityNights,
		bookedNights: v.bookedNights,
		occupiedNights: v.occupiedNights,
		derived: v.derived,
		occupancyRate:
			v.capacityNights > 0 ? v.occupiedNights / v.capacityNights : 0,
		bookingRate: v.capacityNights > 0 ? v.bookedNights / v.capacityNights : 0,
	}));

	const remainingRoomNights = Math.max(
		capacityRoomNights - occupiedRoomNights,
		0
	);

	const paymentBreakdownArr = Object.values(paymentBreakdown).sort(
		(a, b) => (b.count || 0) - (a.count || 0)
	);

	return {
		success: true,
		hotel: { _id: hotel._id, hotelName: hotel.hotelName },
		month: {
			label,
			year,
			monthIndex,
			start: start.toISOString(),
			endExclusive: endExclusive.toISOString(),
			daysInMonth,
		},
		roomTypes,
		days,
		summary: {
			// legacy-compatible keys
			soldRoomNights: occupiedRoomNights,
			availableRoomNights: capacityRoomNights,
			totalRoomsAll: baseTotalRoomsAll,
			totalPhysicalRooms,

			// explicit keys
			capacityRoomNights,
			bookedRoomNights,
			occupiedRoomNights,
			remainingRoomNights,

			averageOccupancyRate:
				capacityRoomNights > 0 ? occupiedRoomNights / capacityRoomNights : 0,
			peakDay,

			occupancyByType: occupancyByTypeArr,
			warnings,
			totalAmount,
			paymentBreakdown: paymentBreakdownArr,
		},
		displayMode,
	};
}

// -------------------------------
// Calendar endpoint
// -------------------------------
exports.hotelOccupancyCalendar = async (req, res) => {
	try {
		setNoCacheHeaders(res);

		const hotelId = req.query.hotelId;
		if (!hotelId || !ObjectId.isValid(hotelId)) {
			return res.status(400).json({
				success: false,
				message: "hotelId (Mongo ObjectId) is required",
			});
		}

		const customRange = parseCustomRange(req.query.start, req.query.end);
		const { start, endExclusive, daysInMonth, label, year, monthIndex } =
			customRange || parseMonthParam(req.query.month);

		const displayMode =
			(req.query.display === "roomType" && "roomType") || "displayName";

		const includeCancelled =
			String(req.query.includeCancelled || "").toLowerCase() === "true";
		const paymentStatusFilter = parsePaymentStatusFilter(
			req.query.paymentStatuses || req.query.paymentStatus
		);

		const result = await computeOccupancy({
			hotelId,
			start,
			endExclusive,
			daysInMonth,
			label,
			year,
			monthIndex,
			displayMode,
			includeCancelled,
			paymentStatusFilter,
		});

		if (result?.error) {
			return res
				.status(result.error.code || 500)
				.json({ success: false, message: result.error.message });
		}

		return res.json(result);
	} catch (err) {
		console.error("Error in hotelOccupancyCalendar:", err);
		return res.status(500).json({
			success: false,
			message: err.message || "Failed to compute hotel occupancy",
		});
	}
};

// -------------------------------
// Warnings endpoint (reuses same compute for exact parity)
// -------------------------------
exports.hotelOccupancyWarnings = async (req, res) => {
	try {
		setNoCacheHeaders(res);

		const hotelId = req.query.hotelId;
		if (!hotelId || !ObjectId.isValid(hotelId)) {
			return res.status(400).json({
				success: false,
				message: "hotelId (Mongo ObjectId) is required",
			});
		}

		const customRange = parseCustomRange(req.query.start, req.query.end);
		const { start, endExclusive, daysInMonth, label, year, monthIndex } =
			customRange || parseMonthParam(req.query.month);

		const displayMode =
			(req.query.display === "roomType" && "roomType") || "displayName";

		const includeCancelled =
			String(req.query.includeCancelled || "").toLowerCase() === "true";
		const paymentStatusFilter = parsePaymentStatusFilter(
			req.query.paymentStatuses || req.query.paymentStatus
		);

		const result = await computeOccupancy({
			hotelId,
			start,
			endExclusive,
			daysInMonth,
			label,
			year,
			monthIndex,
			displayMode,
			includeCancelled,
			paymentStatusFilter,
		});

		if (result?.error) {
			return res
				.status(result.error.code || 500)
				.json({ success: false, message: result.error.message });
		}

		return res.json({
			success: true,
			hotel: result.hotel,
			month: result.month,
			warnings: result?.summary?.warnings || [],
			displayMode: result.displayMode,
		});
	} catch (err) {
		console.error("Error in hotelOccupancyWarnings:", err);
		return res.status(500).json({
			success: false,
			message: err.message || "Failed to compute hotel occupancy warnings",
		});
	}
};

// -------------------------------
// Day Reservations endpoint (supports derived keys too)
// -------------------------------
exports.hotelOccupancyDayReservations = async (req, res) => {
	try {
		setNoCacheHeaders(res);

		const { hotelId, date, roomKey, roomLabel } = req.query;

		if (!hotelId || !ObjectId.isValid(hotelId)) {
			return res.status(400).json({
				success: false,
				message: "hotelId (Mongo ObjectId) is required",
			});
		}
		if (!date) {
			return res
				.status(400)
				.json({ success: false, message: "date (YYYY-MM-DD) is required" });
		}

		const dayStart = new Date(`${date}T00:00:00.000Z`);
		if (Number.isNaN(dayStart.getTime())) {
			return res
				.status(400)
				.json({ success: false, message: "date must be in YYYY-MM-DD format" });
		}
		const dayEnd = new Date(dayStart.getTime() + DAY_MS);

		const displayMode =
			(req.query.display === "roomType" && "roomType") || "displayName";
		const includeCancelled =
			String(req.query.includeCancelled || "").toLowerCase() === "true";
		const paymentStatusFilter = parsePaymentStatusFilter(
			req.query.paymentStatuses || req.query.paymentStatus
		);

		const hotel = await HotelDetails.findById(hotelId)
			.select("hotelName roomCountDetails")
			.lean();
		if (!hotel) {
			return res.status(404).json({
				success: false,
				message: "Hotel not found for occupancy view",
			});
		}

		const baseRoomTypes = buildBaseRoomTypes(
			hotel.roomCountDetails || [],
			displayMode
		);
		const baseTotalsLookup = baseRoomTypes.reduce((acc, rt) => {
			acc[rt.key] = safeNumber(rt.totalRooms);
			return acc;
		}, {});
		const baseTotalRoomsAll = baseRoomTypes.reduce(
			(sum, rt) => sum + safeNumber(rt.totalRooms),
			0
		);

		// Build same resolver logic (displayName-first in displayName mode)
		const roomTypeByKey = new Map();
		const keyNormToKey = new Map();
		const displayNormToKeys = new Map();
		const roomTypeNormToKeys = new Map();

		const addToSetMap = (map, k, val) => {
			if (!k) return;
			if (!map.has(k)) map.set(k, new Set());
			map.get(k).add(val);
		};

		const indexRoomType = (rt) => {
			roomTypeByKey.set(rt.key, rt);
			const nk = normalizeRoomKeyLabel(rt.key);
			if (nk) keyNormToKey.set(nk, rt.key);

			const aliases = new Set(
				[rt.displayName, rt.label, rt.key].filter(Boolean)
			);
			for (const a of aliases)
				addToSetMap(displayNormToKeys, normalizeRoomKeyLabel(a), rt.key);

			if (rt.roomType)
				addToSetMap(
					roomTypeNormToKeys,
					normalizeRoomKeyLabel(rt.roomType),
					rt.key
				);
		};

		for (const rt of baseRoomTypes) indexRoomType(rt);

		const pickFromSet = (set, raw) => {
			if (!set || set.size === 0) return null;
			if (set.size === 1) return Array.from(set)[0];
			const rawLower = String(raw || "")
				.trim()
				.toLowerCase();
			if (!rawLower) return Array.from(set)[0];

			for (const key of set) {
				const rt = roomTypeByKey.get(key);
				if (!rt) continue;
				for (const c of [rt.displayName, rt.label]) {
					if (
						String(c || "")
							.trim()
							.toLowerCase() === rawLower
					)
						return key;
				}
			}
			return Array.from(set)[0];
		};

		const resolveRoomKey = (room = {}) => {
			const rawKey = room?.key || room?.roomKey || "";
			const rawRoomType = room?.room_type || room?.roomType || "";
			const rawDisplay =
				room?.displayName || room?.display_name || room?.label || "";

			const nk = normalizeRoomKeyLabel(rawKey);
			if (nk && keyNormToKey.has(nk)) return keyNormToKey.get(nk);

			const nd = normalizeRoomKeyLabel(rawDisplay);
			const nrt = normalizeRoomKeyLabel(rawRoomType);

			if (displayMode === "displayName") {
				if (nd) {
					const set = displayNormToKeys.get(nd);
					const picked = pickFromSet(set, rawDisplay);
					if (picked) return picked;
				}
				if (nrt) {
					const set = roomTypeNormToKeys.get(nrt);
					if (set && set.size === 1) return Array.from(set)[0];
				}
				return null;
			}

			if (nrt) {
				const set = roomTypeNormToKeys.get(nrt);
				if (set && set.size) return Array.from(set)[0];
			}
			if (nd) {
				const set = displayNormToKeys.get(nd);
				const picked = pickFromSet(set, rawDisplay);
				if (picked) return picked;
			}
			return null;
		};

		const deriveKeyFromRoom = (room = {}) => {
			const rawRoomType = String(
				room?.room_type || room?.roomType || ""
			).trim();
			const rawDisplay = String(
				room?.displayName || room?.display_name || room?.label || ""
			).trim();

			const labelCandidate =
				displayMode === "displayName"
					? rawDisplay ||
					  getRoomTypeLabel(rawRoomType) ||
					  rawRoomType ||
					  "Unknown Room"
					: getRoomTypeLabel(rawRoomType) ||
					  rawDisplay ||
					  rawRoomType ||
					  "Unknown Room";

			let key = normalizeRoomKeyLabel(labelCandidate);
			if (!key)
				key =
					normalizeRoomKeyLabel(rawDisplay) ||
					normalizeRoomKeyLabel(rawRoomType);
			if (!key) key = `unknown-room-${Math.random().toString(36).slice(2, 8)}`;

			return { key, label: labelCandidate };
		};

		const targetKeyNorm = roomKey ? normalizeRoomKeyLabel(roomKey) : null;

		const baseQuery = buildDayBaseQuery({
			hotelId,
			dayStart,
			dayEnd,
			includeCancelled,
		});

		const reservations = await Reservations.find(baseQuery)
			.select(
				"confirmation_number customer_details hotelId checkin_date checkout_date pickedRoomsType reservation_status total_amount payment payment_details paypal_details createdAt booking_source reservedBy room_numbers"
			)
			.populate("hotelId", "hotelName")
			.lean();

		const reservationsForDay = [];
		let bookedForTarget = 0;

		// track derived totals when roomKey is null (Total column)
		let derivedBookedTotal = 0;

		for (const reservation of reservations) {
			if (!reservation || !Array.isArray(reservation.pickedRoomsType)) continue;

			const pay = paymentMeta(reservation);
			if (
				paymentStatusFilter.size &&
				!paymentStatusFilter.has(pay.normalizedStatus)
			)
				continue;

			let matchedCount = 0;
			const roomBreakdownMap = {};

			for (const room of reservation.pickedRoomsType) {
				if (!room) continue;

				const resolved = resolveRoomKey(room);
				const derived = deriveKeyFromRoom(room);

				const effectiveKey = resolved || derived.key;
				const effectiveLabel = resolved
					? roomTypeByKey.get(resolved)?.label || derived.label
					: derived.label;

				const count = safeNumber(room?.count);
				if (!count) continue;

				const matchesRequested = !targetKeyNorm
					? true
					: normalizeRoomKeyLabel(effectiveKey) === targetKeyNorm;

				if (!matchesRequested) continue;

				matchedCount += count;

				if (!roomBreakdownMap[effectiveKey]) {
					roomBreakdownMap[effectiveKey] = {
						key: effectiveKey,
						label: effectiveLabel,
						count: 0,
					};
				}
				roomBreakdownMap[effectiveKey].count += count;
			}

			if (matchedCount > 0) {
				bookedForTarget += matchedCount;

				const breakdown = Object.values(roomBreakdownMap);

				reservationsForDay.push({
					...reservation,
					payment_status: pay.status,
					payment_status_hint: pay.hint,
					roomsForDay: matchedCount,
					roomBreakdown: breakdown,
				});
			}
		}

		// If total column (roomKey null), compute derivedBookedTotal from breakdown keys that are not in baseTotalsLookup
		if (!targetKeyNorm) {
			for (const resItem of reservationsForDay) {
				for (const rb of resItem.roomBreakdown || []) {
					if (!rb?.key) continue;
					const k = String(rb.key);
					if (!baseTotalsLookup[k]) {
						derivedBookedTotal += safeNumber(rb.count);
					}
				}
			}
		}

		let capacity = 0;
		let labelOut = "All room types";

		if (targetKeyNorm) {
			// If key exists in hotel inventory -> use real capacity, else derived capacity = booked (1/1)
			const exactKey = Object.keys(baseTotalsLookup).find(
				(k) => normalizeRoomKeyLabel(k) === targetKeyNorm
			);
			if (exactKey) {
				capacity = safeNumber(baseTotalsLookup[exactKey]);
				labelOut = roomTypeByKey.get(exactKey)?.label || roomLabel || exactKey;
			} else {
				capacity = bookedForTarget;
				labelOut = roomLabel || roomKey || "Derived room";
			}
		} else {
			// Total capacity = base inventory + derived booked (derived capacity=booked)
			capacity = baseTotalRoomsAll + derivedBookedTotal;
		}

		return res.json({
			success: true,
			hotel: { _id: hotel._id, hotelName: hotel.hotelName },
			date: dayStart.toISOString().slice(0, 10),
			roomKey: roomKey || null,
			roomLabel: labelOut,
			capacity,
			booked: bookedForTarget,
			overbooked: bookedForTarget > capacity,
			overage: Math.max(bookedForTarget - capacity, 0),
			displayMode,
			reservations: reservationsForDay,
		});
	} catch (err) {
		console.error("Error in hotelOccupancyDayReservations:", err);
		return res.status(500).json({
			success: false,
			message: err.message || "Failed to load reservations for this day",
		});
	}
};

const parseReportPagination = (req) => {
	const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
	const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 200, 1), 500);
	const skip = (page - 1) * limit;
	return { page, limit, skip };
};

const buildPaidBreakdownFilter = ({ hotelId, searchQuery }) => {
	const filters = [];
	if (hotelId) {
		filters.push({ hotelId: new ObjectId(hotelId) });
	}
	filters.push(buildPaidBreakdownNonZeroFilter());
	const searchFilter = buildPaidBreakdownSearchFilter(searchQuery);
	if (searchFilter) filters.push(searchFilter);
	return filters.length > 1 ? { $and: filters } : filters[0];
};

const buildPaidBreakdownScorecards = async (filter) => {
	const breakdownSum = {
		$add: PAID_BREAKDOWN_TOTAL_KEYS.map((key) => ({
			$ifNull: [`$paid_amount_breakdown.${key}`, 0],
		})),
	};
	const breakdownTotalsGroup = PAID_BREAKDOWN_TOTAL_KEYS.reduce((acc, key) => {
		acc[key] = { $sum: { $ifNull: [`$paid_amount_breakdown.${key}`, 0] } };
		return acc;
	}, {});
	const result = await Reservations.aggregate([
		{ $match: filter },
		{
			$addFields: {
				paid_breakdown_total: breakdownSum,
				total_amount_safe: { $ifNull: ["$total_amount", 0] },
			},
		},
		{
			$group: {
				_id: null,
				totalAmount: { $sum: "$total_amount_safe" },
				paidAmount: { $sum: "$paid_breakdown_total" },
				...breakdownTotalsGroup,
			},
		},
	]);
	const summary = result[0] || {};
	const breakdownTotals = PAID_BREAKDOWN_TOTAL_KEYS.reduce((acc, key) => {
		acc[key] = safeNumber(summary[key]);
		return acc;
	}, {});
	return {
		totalAmount: safeNumber(summary.totalAmount),
		paidAmount: safeNumber(summary.paidAmount),
		breakdownTotals,
	};
};

exports.paidBreakdownReportAdmin = async (req, res) => {
	try {
		const hotelId = req.query.hotelId;
		if (!hotelId || !ObjectId.isValid(hotelId)) {
			return res.status(400).json({ error: "Valid hotelId is required" });
		}

		const { page, limit, skip } = parseReportPagination(req);
		const searchQuery = req.query.searchQuery || "";
		const baseFilter = buildPaidBreakdownFilter({ hotelId });
		const finalFilter = buildPaidBreakdownFilter({ hotelId, searchQuery });

		const totalDocuments = await Reservations.countDocuments(finalFilter);
		const reservations = await Reservations.find(finalFilter)
			.sort({ checkin_date: -1, createdAt: -1 })
			.skip(skip)
			.limit(limit)
			.populate("hotelId", "hotelName belongsTo")
			.lean();

		const scorecards = await buildPaidBreakdownScorecards(baseFilter);
		const data = reservations.map((reservation) => {
			const breakdown = reservation.paid_amount_breakdown || {};
			const paidTotal = computePaidBreakdownTotal(breakdown);
			return {
				...reservation,
				paid_breakdown_total: paidTotal,
				paid_breakdown_remaining: Math.max(
					safeNumber(reservation.total_amount) - paidTotal,
					0,
				),
			};
		});

		return res.json({ data, totalDocuments, page, limit, scorecards });
	} catch (err) {
		console.error("Error in paidBreakdownReportAdmin:", err);
		return res.status(500).json({ error: err.message });
	}
};

exports.paidBreakdownReportHotel = async (req, res) => {
	try {
		const hotelId = req.query.hotelId || req.params.hotelId;
		if (!hotelId || !ObjectId.isValid(hotelId)) {
			return res.status(400).json({ error: "Valid hotelId is required" });
		}

		const { page, limit, skip } = parseReportPagination(req);
		const searchQuery = req.query.searchQuery || "";
		const baseFilter = buildPaidBreakdownFilter({ hotelId });
		const finalFilter = buildPaidBreakdownFilter({ hotelId, searchQuery });

		const totalDocuments = await Reservations.countDocuments(finalFilter);
		const reservations = await Reservations.find(finalFilter)
			.sort({ checkin_date: -1, createdAt: -1 })
			.skip(skip)
			.limit(limit)
			.populate("hotelId", "hotelName belongsTo")
			.lean();

		const scorecards = await buildPaidBreakdownScorecards(baseFilter);
		const data = reservations.map((reservation) => {
			const breakdown = reservation.paid_amount_breakdown || {};
			const paidTotal = computePaidBreakdownTotal(breakdown);
			return {
				...reservation,
				paid_breakdown_total: paidTotal,
				paid_breakdown_remaining: Math.max(
					safeNumber(reservation.total_amount) - paidTotal,
					0,
				),
			};
		});

		return res.json({ data, totalDocuments, page, limit, scorecards });
	} catch (err) {
		console.error("Error in paidBreakdownReportHotel:", err);
		return res.status(500).json({ error: err.message });
	}
};
