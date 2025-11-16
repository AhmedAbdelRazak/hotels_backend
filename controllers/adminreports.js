const Reservations = require("../models/reservations");
const HotelDetails = require("../models/hotel_details");
const mongoose = require("mongoose");
const ObjectId = mongoose.Types.ObjectId;

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
      - Else parse comma‐separated hotel names, match them (case‐insensitive)
        to actual hotels, then filter reservations by those IDs
      - If `?excludeCancelled=true`, filter out cancelled reservations
   ------------------------------------------------------------------ */
async function findFilteredReservations(req) {
	const PAGE_START_DATE_UTC = new Date(Date.UTC(2025, 4, 1, 0, 0, 0, 0)); // May is month 4 (0-indexed)
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

		// 8) Fetch ALL matching docs (sorted) – frontend does client-side pagination
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

		// B) filterType logic (no pagination—just filter)
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
function isSameDay(date1, date2) {
	if (!date1 || !date2) return false;
	const d1 = date1 instanceof Date ? date1 : new Date(date1);
	const d2 = date2 instanceof Date ? date2 : new Date(date2);
	return (
		d1.getFullYear() === d2.getFullYear() &&
		d1.getMonth() === d2.getMonth() &&
		d1.getDate() === d2.getDate()
	);
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
		// 1) Base filter (booking_source + createdAt >= 2024-09-01)
		const PAGE_START_DATE_UTC = new Date(Date.UTC(2025, 4, 1, 0, 0, 0, 0)); // May is month 4 (0-indexed)
		const baseFilter = {
			createdAt: { $gte: PAGE_START_DATE_UTC },
		};
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

		// 4) Define “today”
		const now = new Date();
		const startOfToday = new Date(
			now.getFullYear(),
			now.getMonth(),
			now.getDate(),
			0,
			0,
			0,
			0
		);
		const endOfToday = new Date(
			now.getFullYear(),
			now.getMonth(),
			now.getDate(),
			23,
			59,
			59,
			999
		);

		// We'll do 10 days after "today" (inclusive of today: 0..9)
		const endOf10Days = new Date(startOfToday);
		endOf10Days.setDate(endOf10Days.getDate() + 9);

		// ============== FIRST ROW ==============
		const arrivalsCount = await safeCount({
			checkin_date: { $gte: startOfToday, $lte: endOfToday },
			reservation_status: { $ne: "cancelled" },
		});

		const departuresCount = await safeCount({
			checkout_date: { $gte: startOfToday, $lte: endOfToday },
			reservation_status: { $ne: "cancelled" },
		});

		const inHouseCount = await safeCount({
			checkin_date: { $lte: endOfToday },
			checkout_date: { $gt: startOfToday },
			reservation_status: { $ne: "cancelled" },
		});

		const bookingsTodayCount = await safeCount({
			createdAt: { $gte: startOfToday, $lte: endOfToday },
			reservation_status: { $ne: "cancelled" },
		});

		const overAllBookingsCount = await safeCount({
			reservation_status: { $ne: "cancelled" },
		});

		const tomorrowStart = new Date(
			now.getFullYear(),
			now.getMonth(),
			now.getDate() + 1,
			0,
			0,
			0,
			0
		);
		const tomorrowEnd = new Date(
			now.getFullYear(),
			now.getMonth(),
			now.getDate() + 1,
			23,
			59,
			59,
			999
		);

		const tomorrowArrivalsCount = await safeCount({
			checkin_date: { $gte: tomorrowStart, $lte: tomorrowEnd },
			reservation_status: { $ne: "cancelled" },
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
			reservation_status: "cancelled",
			updatedAt: { $gte: startOfToday, $lte: endOfToday },
		});

		const noShowCount = await safeCount({
			reservation_status: /no\s?show/i,
			updatedAt: { $gte: startOfToday, $lte: endOfToday },
		});

		// totalRoomsAcrossHotels => sum of all .roomCountDetails[].count
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

		let totalRoomsAcrossHotels = 0;
		for (const h of matchedHotels) {
			for (const detail of h?.roomCountDetails || []) {
				totalRoomsAcrossHotels += detail?.count || 0;
			}
		}

		// Next 10 days => peak usage
		const relevantFor10Days = await safeFind({
			cond: {
				reservation_status: { $ne: "cancelled" },
				checkin_date: { $lte: endOf10Days },
				checkout_date: { $gt: startOfToday },
			},
			select: "checkin_date checkout_date pickedRoomsType",
		});

		const usageArray10 = new Array(10).fill(0);
		const dayList10 = [];
		for (let i = 0; i < 10; i++) {
			const d = new Date(startOfToday);
			d.setDate(d.getDate() + i);
			dayList10.push(d);
		}

		for (const doc of relevantFor10Days) {
			if (!Array.isArray(doc?.pickedRoomsType)) continue;
			const cIn = doc.checkin_date;
			const cOut = doc.checkout_date;

			let totalRoomsUsed = 0;
			for (const rtObj of doc.pickedRoomsType) {
				totalRoomsUsed += rtObj?.count || 1;
			}

			for (let i = 0; i < 10; i++) {
				const dayDate = dayList10[i];
				if (dayDate >= cIn && dayDate < cOut) {
					usageArray10[i] += totalRoomsUsed;
				}
			}
		}

		const peakUsageIn10Days = Math.max(...usageArray10);
		const occupancy = {
			booked: peakUsageIn10Days,
			available: Math.max(totalRoomsAcrossHotels - peakUsageIn10Days, 0),
			overallRoomsCount: totalRoomsAcrossHotels,
		};

		// latestCheckouts
		const latestCheckoutsRaw = await safeFind({
			cond: { reservation_status: { $in: ["completed", "checked-out"] } },
			sort: { checkout_date: -1 },
			limit: 4,
		});

		const latestCheckouts = latestCheckoutsRaw.map((r) => ({
			key: String(r._id),
			guest: r?.customer_details?.name || "N/A",
			guestId: r?.customer_details?.passport || "",
			accommodation: Array.isArray(r?.pickedRoomsType)
				? r.pickedRoomsType
						.map((rt) => rt?.room_type)
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
				reservation_status: { $ne: "cancelled" },
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
					(doc?.pickedRoomsType?.[0] && doc.pickedRoomsType[0].room_type) ||
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
		const reservationsForRooms = await Reservations.find(baseFilter)
			.select("pickedRoomsType")
			.lean()
			.catch((e) => {
				console.error("Reservations.find(baseFilter) for rooms failed", e);
				return [];
			});

		const roomStatsMap = {};
		for (const r of reservationsForRooms) {
			if (!Array.isArray(r?.pickedRoomsType)) continue;
			for (const rtObj of r.pickedRoomsType) {
				const typeVal = rtObj?.room_type;
				if (!typeVal) continue;
				if (!roomStatsMap[typeVal]) roomStatsMap[typeVal] = { sold: 0 };
				roomStatsMap[typeVal].sold += rtObj?.count || 1;
			}
		}

		// combinedInventory => from matchedHotels roomCountDetails
		const combinedInventory = {};
		for (const h of matchedHotels) {
			for (const detail of h?.roomCountDetails || []) {
				const rtVal = detail?.roomType;
				if (!rtVal) continue;
				combinedInventory[rtVal] =
					(combinedInventory[rtVal] || 0) + (detail?.count || 0);
			}
		}

		// Next 7 days usage => usageByDay7
		const rangeEnd = new Date(startOfToday);
		rangeEnd.setDate(rangeEnd.getDate() + 7); // up to 7 days from today

		const relevantForNext7 = await safeFind({
			cond: {
				reservation_status: { $ne: "cancelled" },
				checkin_date: { $lte: rangeEnd },
				checkout_date: { $gt: startOfToday },
			},
			select: "checkin_date checkout_date pickedRoomsType",
		});

		const usageByDay7 = {};
		const allTypeVals = new Set([
			...Object.keys(combinedInventory),
			...Object.keys(roomStatsMap),
		]);

		for (const typeVal of allTypeVals) {
			usageByDay7[typeVal] = [0, 0, 0, 0, 0, 0, 0];
		}

		const dayList7 = [];
		for (let i = 0; i < 7; i++) {
			const dd = new Date(startOfToday);
			dd.setDate(dd.getDate() + i);
			dayList7.push(dd);
		}

		for (const doc of relevantForNext7) {
			if (!Array.isArray(doc?.pickedRoomsType)) continue;
			const cIn = doc?.checkin_date;
			const cOut = doc?.checkout_date;

			for (const rtObj of doc.pickedRoomsType) {
				const typeVal = rtObj?.room_type;
				if (!typeVal) continue;
				const countVal = rtObj?.count || 1;

				for (let i = 0; i < 7; i++) {
					const dayDate = dayList7[i];
					if (dayDate >= cIn && dayDate < cOut) {
						usageByDay7[typeVal][i] += countVal;
					}
				}
			}
		}

		const availabilityNext7 = {};
		for (const typeVal of allTypeVals) {
			const inv = combinedInventory[typeVal] || 0;
			const peak = Math.max(...usageByDay7[typeVal]);
			availabilityNext7[typeVal] = Math.max(inv - peak, 0);
		}

		const dynamicRoomsTable = [];
		let rowKeyCounter = 1;
		for (const typeVal of allTypeVals) {
			const label = roomTypeLabelMap[typeVal] || typeVal;
			const total = combinedInventory[typeVal] || 0;
			const sold = roomStatsMap[typeVal]?.sold || 0;
			const available = Math.max(total - sold, 0);
			const next7 = availabilityNext7[typeVal] || 0;

			dynamicRoomsTable.push({
				key: String(rowKeyCounter++),
				type: label,
				sold,
				total,
				bookingNext7: next7,
				availabilityNext7: next7,
				available,
			});
		}

		// You can wire this to real housekeeping if you have it
		const housekeeping = { clean: 25, cleaning: 0, dirty: 0 };
		const thirdRow = { roomsTable: dynamicRoomsTable, housekeeping };

		// ============== FOURTH ROW ==============
		const pipelineTopChannels = [
			{ $match: baseFilter },
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

		const pipelineRoomTypes = [
			{ $match: baseFilter },
			{ $unwind: "$pickedRoomsType" },
			{
				$group: {
					_id: "$pickedRoomsType.room_type",
					nights: { $sum: { $ifNull: ["$days_of_residence", 0] } },
					revenue: { $sum: { $ifNull: ["$total_amount", 0] } },
				},
			},
			{ $sort: { revenue: -1 } },
		];
		const roomTypesAgg = await safeAggregate(pipelineRoomTypes);
		const roomNightsByType = roomTypesAgg.map((rta) => ({
			type: roomTypeLabelMap[rta?._id] || rta?._id,
			value: rta?.nights || 0,
			fillColor: "#E74C3C",
		}));
		const roomRevenueByType = roomTypesAgg.map((rta) => ({
			type: roomTypeLabelMap[rta?._id] || rta?._id,
			value: rta?.revenue || 0,
			fillColor: "#FF7373",
		}));
		const fourthRow = { topChannels, roomNightsByType, roomRevenueByType };

		// ============== FIFTH ROW ==============
		const lineStart = new Date(
			now.getFullYear(),
			now.getMonth(),
			now.getDate(),
			0,
			0,
			0,
			0
		);
		lineStart.setDate(lineStart.getDate() - 10);

		const lineEnd = new Date(
			now.getFullYear(),
			now.getMonth(),
			now.getDate(),
			23,
			59,
			59,
			999
		);
		lineEnd.setDate(lineEnd.getDate() + 10);

		const pipelineCheckIn = [
			{
				$match: {
					$and: [
						baseFilter,
						{ checkin_date: { $gte: lineStart, $lte: lineEnd } },
						{ reservation_status: { $ne: "cancelled" } },
					],
				},
			},
			{
				$group: {
					_id: {
						y: { $year: "$checkin_date" },
						m: { $month: "$checkin_date" },
						d: { $dayOfMonth: "$checkin_date" },
					},
					count: { $sum: 1 },
				},
			},
			{ $sort: { "_id.y": 1, "_id.m": 1, "_id.d": 1 } },
		];

		const pipelineCheckOut = [
			{
				$match: {
					$and: [
						baseFilter,
						{ checkout_date: { $gte: lineStart, $lte: lineEnd } },
						{ reservation_status: { $ne: "cancelled" } },
					],
				},
			},
			{
				$group: {
					_id: {
						y: { $year: "$checkout_date" },
						m: { $month: "$checkout_date" },
						d: { $dayOfMonth: "$checkout_date" },
					},
					count: { $sum: 1 },
				},
			},
			{ $sort: { "_id.y": 1, "_id.m": 1, "_id.d": 1 } },
		];

		const [checkInAgg, checkOutAgg] = await Promise.all([
			safeAggregate(pipelineCheckIn),
			safeAggregate(pipelineCheckOut),
		]);

		const lineChartCategories = [];
		const checkInData = [];
		const checkOutData = [];

		let dayCursor = new Date(lineStart);
		while (dayCursor <= lineEnd) {
			const y = dayCursor.getFullYear();
			const m = dayCursor.getMonth() + 1;
			const d = dayCursor.getDate();

			const label = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(
				2,
				"0"
			)}`;
			lineChartCategories.push(label);

			const foundIn = checkInAgg.find(
				(x) => x?._id?.y === y && x?._id?.m === m && x?._id?.d === d
			);
			checkInData.push(foundIn ? foundIn.count : 0);

			const foundOut = checkOutAgg.find(
				(x) => x?._id?.y === y && x?._id?.m === m && x?._id?.d === d
			);
			checkOutData.push(foundOut ? foundOut.count : 0);

			dayCursor.setDate(dayCursor.getDate() + 1);
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
