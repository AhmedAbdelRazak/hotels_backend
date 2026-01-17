const mongoose = require("mongoose");
const Expense = require("../models/expenses");
const Reservations = require("../models/reservations");
const HotelDetails = require("../models/hotel_details");

const ObjectId = mongoose.Types.ObjectId;

const populateExpense = (query) =>
	query
		.populate("hotelId", "hotelName")
		.populate("createdBy", "name email")
		.populate("updatedBy", "name email");

const PAYMENT_STATUS_ORDER = [
	"Captured",
	"Paid Offline",
	"Not Captured",
	"Not Paid",
];

const MANUAL_CAPTURED_CONFIRMATIONS = new Set(["2944008828"]);

const safeNumber = (value, fallback = 0) => {
	const num = Number(value);
	return Number.isFinite(num) ? num : fallback;
};

const parseYearValue = (value) => {
	const year = Number(value);
	if (!Number.isInteger(year) || year < 1900) return null;
	return year;
};

const getPaymentStatus = (reservation = {}) => {
	const pd = reservation?.paypal_details || {};
	const pmt = String(reservation?.payment || "").toLowerCase().trim();
	const isCardPayment = /\bcredit\b|\bdebit\b/.test(pmt);

	const legacyCaptured = !!reservation?.payment_details?.captured;
	const onsitePaidAmount = safeNumber(
		reservation?.payment_details?.onsite_paid_amount
	);
	const payOffline = onsitePaidAmount > 0 || pmt === "paid offline";

	const capTotal = safeNumber(pd?.captured_total_usd);
	const initialCompleted =
		String(pd?.initial?.capture_status || "").toUpperCase() === "COMPLETED";
	const anyMitCompleted =
		Array.isArray(pd?.mit) &&
		pd.mit.some(
			(item) =>
				String(item?.capture_status || "").toUpperCase() === "COMPLETED"
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

	if (isCaptured) return "Captured";
	if (payOffline) return "Paid Offline";
	if (isNotPaid) return "Not Paid";
	return "Not Captured";
};

exports.expenseById = async (req, res, next, id) => {
	if (!ObjectId.isValid(id)) {
		return res.status(400).json({ error: "Invalid expense ID" });
	}

	try {
		const expense = await populateExpense(Expense.findById(id)).exec();
		if (!expense) {
			return res.status(404).json({ error: "Expense not found" });
		}
		req.expense = expense;
		next();
	} catch (error) {
		return res.status(400).json({ error: "Failed to load expense" });
	}
};

exports.createExpense = async (req, res) => {
	try {
		const {
			label,
			description,
			amount,
			paid_amount,
			currency,
			hotelId,
			expenseDate,
			receipt,
		} =
			req.body;

		if (!label || !String(label).trim()) {
			return res.status(400).json({ error: "Expense label is required" });
		}
		if (amount === undefined || amount === null || Number.isNaN(Number(amount))) {
			return res.status(400).json({ error: "Expense amount is required" });
		}
		if (
			paid_amount === undefined ||
			paid_amount === null ||
			Number.isNaN(Number(paid_amount))
		) {
			return res.status(400).json({ error: "Paid amount is required" });
		}
		if (!hotelId || !ObjectId.isValid(hotelId)) {
			return res.status(400).json({ error: "Valid hotel ID is required" });
		}
		if (!expenseDate) {
			return res.status(400).json({ error: "Expense date is required" });
		}
		if (!receipt || !receipt.url || !receipt.public_id) {
			return res
				.status(400)
				.json({ error: "Receipt upload is required" });
		}

		const expenseData = {
			label: String(label).trim(),
			description: description ? String(description).trim() : "",
			amount: Number(amount),
			paid_amount: Number(paid_amount),
			currency: currency ? String(currency).trim() : "SAR",
			hotelId: ObjectId(hotelId),
		};

		const parsedDate = new Date(expenseDate);
		if (Number.isNaN(parsedDate.getTime())) {
			return res.status(400).json({ error: "Invalid expense date" });
		}
		expenseData.expenseDate = parsedDate;

		const receiptPayload = {
			public_id: String(receipt.public_id).trim(),
			url: String(receipt.url).trim(),
			fileName: receipt.fileName ? String(receipt.fileName).trim() : "",
			fileType: receipt.fileType ? String(receipt.fileType).trim() : "",
		};
		expenseData.receipt = receiptPayload;

		const actorId = req.profile?._id || req.auth?._id;
		if (actorId) {
			expenseData.createdBy = actorId;
			expenseData.updatedBy = actorId;
		}

		const expense = new Expense(expenseData);
		const savedExpense = await expense.save();

		const populated = await populateExpense(
			Expense.findById(savedExpense._id)
		).exec();

		return res.json(populated);
	} catch (error) {
		console.error("Error creating expense:", error);
		return res.status(400).json({
			error: "Unable to create expense. Please check the data and try again.",
		});
	}
};

exports.readExpense = (req, res) => {
	return res.json(req.expense);
};

exports.listExpenses = async (req, res) => {
	try {
		const { hotelId } = req.query;
		const filter = {};

		if (hotelId) {
			if (!ObjectId.isValid(hotelId)) {
				return res.status(400).json({ error: "Invalid hotel ID" });
			}
			filter.hotelId = ObjectId(hotelId);
		}

		const expenses = await populateExpense(
			Expense.find(filter).sort({ expenseDate: -1, createdAt: -1 })
		).exec();

		return res.json(expenses);
	} catch (error) {
		console.error("Error listing expenses:", error);
		return res
			.status(400)
			.json({ error: "Unable to load expenses at the moment." });
	}
};

exports.listExpenseHotels = async (req, res) => {
	try {
		const hotelIds = await Expense.distinct("hotelId", {
			hotelId: { $ne: null },
		});

		if (!hotelIds.length) {
			return res.json([]);
		}

		const hotels = await HotelDetails.find(
			{ _id: { $in: hotelIds } },
			{ _id: 1, hotelName: 1 }
		)
			.sort({ hotelName: 1 })
			.lean()
			.exec();

		return res.json(hotels);
	} catch (error) {
		console.error("Error listing expense hotels:", error);
		return res
			.status(400)
			.json({ error: "Unable to load expense hotels at the moment." });
	}
};

exports.financialReport = async (req, res) => {
	try {
		const { hotelId, year, excludeCancelled, paymentStatuses } = req.query;
		const parsedYear = parseYearValue(year);
		const excludeCancelledFlag =
			String(excludeCancelled || "true").toLowerCase() !== "false";
		const rawStatusParam = Array.isArray(paymentStatuses)
			? paymentStatuses
			: typeof paymentStatuses === "string"
			  ? paymentStatuses.split(",")
			  : [];
		const normalizedStatusFilter = new Set(
			rawStatusParam
				.map((status) => String(status || "").trim().toLowerCase())
				.filter(Boolean)
		);
		const hasStatusFilter = normalizedStatusFilter.size > 0;

		if (hotelId && !ObjectId.isValid(hotelId)) {
			return res.status(400).json({ error: "Invalid hotel ID" });
		}

		const hotelObjectId = hotelId ? ObjectId(hotelId) : null;

		const expenseYearMatch = { expenseDate: { $ne: null } };
		if (hotelObjectId) {
			expenseYearMatch.hotelId = hotelObjectId;
		}

		const reservationYearMatch = { checkout_date: { $ne: null } };
		if (hotelObjectId) {
			reservationYearMatch.hotelId = hotelObjectId;
		}
		if (excludeCancelledFlag) {
			reservationYearMatch.reservation_status = { $ne: "cancelled" };
		}

		const [expenseYearsAgg, reservationYearsAgg] = await Promise.all([
			Expense.aggregate([
				{ $match: expenseYearMatch },
				{ $group: { _id: { $year: "$expenseDate" } } },
				{ $sort: { _id: 1 } },
			]),
			Reservations.aggregate([
				{ $match: reservationYearMatch },
				{ $group: { _id: { $year: "$checkout_date" } } },
				{ $sort: { _id: 1 } },
			]),
		]);

		const expenseYears = expenseYearsAgg
			.map((item) => item?._id)
			.filter((item) => Number.isInteger(item));
		const reservationYears = reservationYearsAgg
			.map((item) => item?._id)
			.filter((item) => Number.isInteger(item));

		const yearIntersection = expenseYears.filter((item) =>
			reservationYears.includes(item)
		);
		const availableYears = [...new Set(yearIntersection)].sort((a, b) => a - b);

		const fallbackYear = new Date().getFullYear();
		const targetYear =
			parsedYear && availableYears.includes(parsedYear)
				? parsedYear
				: availableYears.length
				? availableYears[availableYears.length - 1]
				: fallbackYear;

		const startDate = new Date(Date.UTC(targetYear, 0, 1));
		const endDate = new Date(Date.UTC(targetYear + 1, 0, 1));

		const expenseMatch = {
			expenseDate: { $gte: startDate, $lt: endDate },
		};
		if (hotelObjectId) {
			expenseMatch.hotelId = hotelObjectId;
		}

		const reservationMatch = {
			checkout_date: { $gte: startDate, $lt: endDate },
		};
		if (hotelObjectId) {
			reservationMatch.hotelId = hotelObjectId;
		}
		if (excludeCancelledFlag) {
			reservationMatch.reservation_status = { $ne: "cancelled" };
		}

		const [expenseMonthlyAgg, reservations] = await Promise.all([
			Expense.aggregate([
				{ $match: expenseMatch },
				{
					$group: {
						_id: { month: { $month: "$expenseDate" } },
						totalAmount: { $sum: "$amount" },
						count: { $sum: 1 },
					},
				},
			]),
			Reservations.find(reservationMatch)
				.select(
					"payment payment_details paypal_details total_amount confirmation_number checkout_date"
				)
				.lean()
				.exec(),
		]);

		const expenseByMonth = new Map();
		expenseMonthlyAgg.forEach((item) => {
			const month = item?._id?.month;
			if (!month) return;
			expenseByMonth.set(month, {
				total: safeNumber(item.totalAmount),
				count: safeNumber(item.count),
			});
		});

		const revenueByMonth = new Map();

		const monthLabels = [
			"Jan",
			"Feb",
			"Mar",
			"Apr",
			"May",
			"Jun",
			"Jul",
			"Aug",
			"Sep",
			"Oct",
			"Nov",
			"Dec",
		];

		let totalRevenue = 0;
		let totalExpenses = 0;
		let reservationCount = 0;
		let expenseCount = 0;

		const paymentStatusMap = new Map();
		PAYMENT_STATUS_ORDER.forEach((status) => {
			paymentStatusMap.set(status, {
				status,
				reservations: 0,
				revenue: 0,
			});
		});

		reservations.forEach((reservation) => {
			const status = getPaymentStatus(reservation);
			if (hasStatusFilter && !normalizedStatusFilter.has(status.toLowerCase())) {
				return;
			}

			const amount = safeNumber(reservation?.total_amount);
			const checkoutDate = reservation?.checkout_date
				? new Date(reservation.checkout_date)
				: null;
			const month = checkoutDate ? checkoutDate.getUTCMonth() + 1 : null;

			if (month) {
				const revenueInfo = revenueByMonth.get(month) || {
					total: 0,
					count: 0,
				};
				revenueInfo.total += amount;
				revenueInfo.count += 1;
				revenueByMonth.set(month, revenueInfo);
			}

			totalRevenue += amount;
			reservationCount += 1;

			if (!paymentStatusMap.has(status)) {
				paymentStatusMap.set(status, {
					status,
					reservations: 0,
					revenue: 0,
				});
			}
			const entry = paymentStatusMap.get(status);
			entry.reservations += 1;
			entry.revenue += amount;
		});

		const monthly = [];
		for (let month = 1; month <= 12; month += 1) {
			const expenseInfo = expenseByMonth.get(month) || {
				total: 0,
				count: 0,
			};
			const revenueInfo = revenueByMonth.get(month) || {
				total: 0,
				count: 0,
			};

			const revenue = safeNumber(revenueInfo.total);
			const expenses = safeNumber(expenseInfo.total);
			const net = revenue - expenses;
			const expenseRatio = revenue > 0 ? (expenses / revenue) * 100 : 0;

			totalExpenses += expenses;
			expenseCount += safeNumber(expenseInfo.count);

			monthly.push({
				monthKey: `${targetYear}-${String(month).padStart(2, "0")}`,
				monthLabel: `${monthLabels[month - 1]} ${targetYear}`,
				revenue,
				expenses,
				net,
				expenseRatio,
				reservationCount: safeNumber(revenueInfo.count),
				expenseCount: safeNumber(expenseInfo.count),
			});
		}

		let paymentStatus = Array.from(paymentStatusMap.values()).sort((a, b) => {
			const aIndex = PAYMENT_STATUS_ORDER.indexOf(a.status);
			const bIndex = PAYMENT_STATUS_ORDER.indexOf(b.status);
			if (aIndex === -1 && bIndex === -1) return 0;
			if (aIndex === -1) return 1;
			if (bIndex === -1) return -1;
			return aIndex - bIndex;
		});
		if (hasStatusFilter) {
			paymentStatus = paymentStatus.filter((entry) =>
				normalizedStatusFilter.has(entry.status.toLowerCase())
			);
		}

		const net = totalRevenue - totalExpenses;
		const expenseRatio = totalRevenue > 0 ? (totalExpenses / totalRevenue) * 100 : 0;
		const margin = totalRevenue > 0 ? (net / totalRevenue) * 100 : 0;

		const hotel =
			hotelObjectId &&
			(await HotelDetails.findById(hotelObjectId, {
				_id: 1,
				hotelName: 1,
			})
				.lean()
				.exec());

		return res.json({
			year: targetYear,
			availableYears,
			hotel: hotel || null,
			currency: "SAR",
			totals: {
				revenue: totalRevenue,
				expenses: totalExpenses,
				net,
				expenseRatio,
				margin,
				reservationCount,
				expenseCount,
			},
			monthly,
			paymentStatus,
		});
	} catch (error) {
		console.error("Error building financial report:", error);
		return res
			.status(400)
			.json({ error: "Unable to load financial report at the moment." });
	}
};

exports.updateExpense = async (req, res) => {
	try {
		const {
			label,
			description,
			amount,
			paid_amount,
			currency,
			hotelId,
			expenseDate,
			receipt,
		} =
			req.body;

		const updateFields = {};

		if (label !== undefined) {
			if (!String(label).trim()) {
				return res.status(400).json({ error: "Expense label cannot be empty" });
			}
			updateFields.label = String(label).trim();
		}

		if (description !== undefined) {
			updateFields.description = description
				? String(description).trim()
				: "";
		}

		if (amount !== undefined) {
			if (amount === null || Number.isNaN(Number(amount))) {
				return res.status(400).json({ error: "Expense amount is invalid" });
			}
			updateFields.amount = Number(amount);
		}

		if (paid_amount !== undefined) {
			if (paid_amount === null || Number.isNaN(Number(paid_amount))) {
				return res.status(400).json({ error: "Paid amount is invalid" });
			}
			updateFields.paid_amount = Number(paid_amount);
		}

		if (currency !== undefined) {
			updateFields.currency = String(currency).trim() || "SAR";
		}

		if (hotelId !== undefined) {
			if (!ObjectId.isValid(hotelId)) {
				return res.status(400).json({ error: "Invalid hotel ID" });
			}
			updateFields.hotelId = ObjectId(hotelId);
		}

		if (expenseDate !== undefined) {
			const parsedDate = new Date(expenseDate);
			if (Number.isNaN(parsedDate.getTime())) {
				return res.status(400).json({ error: "Invalid expense date" });
			}
			updateFields.expenseDate = parsedDate;
		}

		if (receipt !== undefined) {
			if (!receipt || !receipt.url || !receipt.public_id) {
				return res
					.status(400)
					.json({ error: "Receipt upload is required" });
			}
			updateFields.receipt = {
				public_id: String(receipt.public_id).trim(),
				url: String(receipt.url).trim(),
				fileName: receipt.fileName ? String(receipt.fileName).trim() : "",
				fileType: receipt.fileType ? String(receipt.fileType).trim() : "",
			};
		}

		const actorId = req.profile?._id || req.auth?._id;
		if (actorId) {
			updateFields.updatedBy = actorId;
		}

		if (!Object.keys(updateFields).length) {
			return res
				.status(400)
				.json({ error: "No valid fields provided for update" });
		}

		const updatedExpense = await populateExpense(
			Expense.findByIdAndUpdate(req.expense._id, updateFields, {
				new: true,
				runValidators: true,
			})
		).exec();

		if (!updatedExpense) {
			return res.status(404).json({ error: "Expense not found" });
		}

		return res.json(updatedExpense);
	} catch (error) {
		console.error("Error updating expense:", error);
		return res
			.status(400)
			.json({ error: "Unable to update expense. Please try again." });
	}
};

exports.removeExpense = async (req, res) => {
	try {
		const expense = await Expense.findByIdAndDelete(req.expense._id);
		if (!expense) {
			return res.status(404).json({ error: "Expense not found" });
		}
		return res.json({ message: "Expense deleted successfully" });
	} catch (error) {
		console.error("Error deleting expense:", error);
		return res
			.status(400)
			.json({ error: "Unable to delete expense. Please try again." });
	}
};
