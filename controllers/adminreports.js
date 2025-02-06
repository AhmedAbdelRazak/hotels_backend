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
	const startOfSep2024 = new Date("2024-09-01T00:00:00.000Z");

	// Base filter for booking_source & createdAt
	const baseFilter = {
		$or: [
			{ booking_source: { $regex: /^online jannat booking$/i } },
			{ booking_source: { $regex: /^generated link$/i } },
			{ booking_source: { $regex: /^jannat employee$/i } },
		],
		createdAt: { $gte: startOfSep2024 },
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
	try {
		// 1) Base filter: booking_source, createdAt >= 2024-09-01
		const startOfSep2024 = new Date("2024-09-01T00:00:00.000Z");
		const baseFilter = {
			$or: [
				{ booking_source: { $regex: /^online jannat booking$/i } },
				{ booking_source: { $regex: /^generated link$/i } },
				{ booking_source: { $regex: /^jannat employee$/i } },
			],
			createdAt: { $gte: startOfSep2024 },
		};

		// 2) Build customFilter from query
		const customFilter = {};
		const query = req.query;

		// If excludeCancelled=true, exclude reservation_status=cancelled
		if (query.excludeCancelled === "true") {
			customFilter.reservation_status = { $ne: "cancelled" };
		}

		// 3) Parse other keys for date or status filters
		Object.keys(query).forEach((key) => {
			// (a) createdAt DATE
			if (key.startsWith("createdAtDate_")) {
				const dateStr = key.replace("createdAtDate_", "");
				const range = dayRangeFromString(dateStr);
				if (range) {
					customFilter.createdAt = { $gte: range.start, $lte: range.end };
				}
			}

			// (b) createdAt MONTH
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
				customFilter.reservation_status = statusValue;
			}
		});

		// 4) hotels param => EXACT match(s) for hotelName, ignoring case
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
				customFilter.hotelId = { $in: [] };
			} else {
				customFilter.hotelId = { $in: matchedIds };
			}
		}
		// Otherwise, if no hotels= or hotels=all => do nothing special

		// 5) "hotelId" param (old partial approach) => only if "hotels" param wasn't used
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

		// 6) Combine baseFilter + customFilter with $and
		const finalFilter = { $and: [baseFilter, customFilter] };

		// 7) Query the DB
		const reservations = await Reservations.find(finalFilter)
			.populate("hotelId", "_id hotelName")
			.lean();

		return res.json(reservations);
	} catch (err) {
		console.error("Error in specificListOfReservations:", err);
		return res.status(500).json({ error: err.message });
	}
};
