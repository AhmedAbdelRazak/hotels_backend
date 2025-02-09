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

		// 5) "hotelId" param => partial approach (if "hotels" param wasn't used)
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

		// 7) Handle pagination & sorting
		const page = parseInt(query.page || "1", 10);
		const limit = parseInt(query.limit || "50", 10);

		// (A) Count how many total match
		const totalDocuments = await Reservations.countDocuments(finalFilter);

		// (B) Fetch the actual docs (sorted desc by createdAt)
		const reservations = await Reservations.find(finalFilter)
			.sort({ createdAt: -1 })
			.skip((page - 1) * limit)
			.limit(limit)
			.populate("hotelId", "_id hotelName")
			.lean();

		const totalPages = Math.ceil(totalDocuments / limit);

		// ================== FETCH ALL FOR SCORECARDS (NO SKIP/LIMIT) ==================
		const allForStats = await Reservations.find(finalFilter)
			.populate("hotelId", "_id hotelName")
			.lean();

		// ================== HELPER FUNCTIONS (like your paginated version) ==================
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
			return isNaN(parsed) ? 0 : parsed;
		}

		function computeReservationCommission(reservation) {
			if (!reservation || !reservation.pickedRoomsType) return 0;

			const hotelName = reservation.hotelId?.hotelName?.toLowerCase() || "";
			const totalAmount = safeNumber(reservation.total_amount);

			// If 'sahet al hegaz', override => 10% of total_amount
			if (hotelName === "sahet al hegaz") {
				return 0.1 * totalAmount;
			}

			// Otherwise, normal logic
			let totalCommission = 0;
			reservation.pickedRoomsType.forEach((room) => {
				if (!room.pricingByDay || room.pricingByDay.length === 0) return;

				room.pricingByDay.forEach((day) => {
					const rootPrice = safeNumber(day.rootPrice);
					let rawRate = safeNumber(day.commissionRate);
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

		// ================== SCORECARDS CALCULATION ==================
		const allReservations = Array.isArray(allForStats) ? allForStats : [];

		// For row 1, do NOT exclude cancelled (unless excludeCancelled was forced),
		// but here we've already applied "excludeCancelled" if user requested it
		// through finalFilter. So "allReservations" is everything that matches finalFilter.

		// 1) Today & Yesterday reservations
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

		// 2) This Week vs Last Week
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

		// 5) Commission stats (exclude cancelled if the finalFilter excludes them,
		//    otherwise you'll see them in allReservations).
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

		// 6) Build the final scorecards object
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

		// 8) Return the response (everything remains intact + scorecards)
		return res.json({
			success: true,
			data: reservations,
			totalDocuments,
			currentPage: page,
			totalPages,
			scorecards, // <--- appended here
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

exports.exportToExcel = async (req, res) => {
	try {
		const userId = req.params.userId;

		// 1) Base filter: booking_source + createdAt >= 2024-09-01
		const startOfSep2024 = new Date("2024-09-01T00:00:00.000Z");
		const baseFilter = {
			$or: [
				{ booking_source: { $regex: /^online jannat booking$/i } },
				{ booking_source: { $regex: /^generated link$/i } },
				{ booking_source: { $regex: /^jannat employee$/i } },
			],
			createdAt: { $gte: startOfSep2024 },
		};

		// 2) Parse query
		const dateField = req.query.dateField || "createdAt"; // "createdAt", "checkin_date", "checkout_date"
		const fromStr = req.query.from; // e.g. "2025-01-01"
		const toStr = req.query.to; // e.g. "2025-02-01"
		const hotelsParam = req.query.hotels || "all";

		// Convert from/to to actual Date objects (midnight to end-of-day)
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

		// 5) Fetch reservations (with .populate for hotel & belongsTo)
		const reservations = await Reservations.find(finalFilter)
			.populate("hotelId", "hotelName")
			.populate("belongsTo", "name phone email") // or whichever fields you store
			.lean();

		// 6) Transform each doc to match your "original component" fields
		const transformed = reservations.map((r) => {
			// A) Payment Status logic
			let paymentStatus = "";
			if (r.payment === "not paid") {
				paymentStatus = "Not Paid";
			} else if (r.payment_details?.captured) {
				paymentStatus = "Captured";
			} else {
				paymentStatus = "Not Captured";
			}

			// B) "Paid Onsite"
			const paidOnsite = r.payment_details?.onside_paid_amount || 0;

			// C) "Name" and "Phone" from r.customer_details
			const customerName = r.customer_details?.name || "";
			const customerPhone = r.customer_details?.phone || "";

			// D) "Hotel Name" from r.hotelId.hotelName
			const hotelName = r.hotelId?.hotelName || "";

			// E) "Checkin/Checkout"
			const checkinDate = r.checkin_date || null; // store raw Date
			const checkoutDate = r.checkout_date || null; // store raw Date

			// F) Distinct "Room Type" from r.pickedRoomsType
			let roomTypeString = "";
			let roomCount = 0;
			if (Array.isArray(r.pickedRoomsType) && r.pickedRoomsType.length > 0) {
				// unique room_type
				const distinctTypes = new Set(
					r.pickedRoomsType.map((x) => x.room_type)
				);
				// map to the "nice labels"
				const mappedLabels = [...distinctTypes].map((typeVal) => {
					const found = ROOM_TYPES_MAPPING.find((rt) => rt.value === typeVal);
					return found ? found.label : typeVal;
				});
				roomTypeString = mappedLabels.join(", ");
				roomCount = r.pickedRoomsType.length;
			}

			// G) "Paid Amount"
			const paidAmount = r.paid_amount || 0;

			// H) "Created At"
			const createdDate = r.createdAt || null;

			return {
				// Mirror the original export fields
				confirmation_number: r.confirmation_number || "",
				customer_name: customerName,
				customer_phone: customerPhone,
				hotel_name: hotelName,
				reservation_status: r.reservation_status || "",
				checkin_date: checkinDate,
				checkout_date: checkoutDate,
				payment_status: paymentStatus,
				total_amount: r.total_amount || 0,
				paid_amount: paidAmount,
				room_type: roomTypeString,
				room_count: roomCount,
				paid_onsite: paidOnsite,
				createdAt: createdDate,
			};
		});

		// 7) Return the *transformed* docs.
		//    The front-end's doExportToExcel will see these fields
		//    and create the correct columns with no blanks.
		return res.json(transformed);
	} catch (err) {
		console.error("Error in exportToExcel:", err);
		return res.status(500).json({ error: "Failed to export to excel" });
	}
};
