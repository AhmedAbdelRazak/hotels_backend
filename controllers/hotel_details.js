const HotelDetails = require("../models/hotel_details");
const mongoose = require("mongoose");
const _ = require("lodash");
const axios = require("axios");
const User = require("../models/user");
const Reservations = require("../models/reservations");
const Rooms = require("../models/rooms");
const UncompleteReservations = require("../models/Uncompleted");

const isConfiguredSuperAdmin = (user) => {
	const configuredIds = [
		process.env.SUPER_ADMIN_ID,
		process.env.REACT_APP_SUPER_ADMIN_ID,
	]
		.filter(Boolean)
		.map((id) => String(id).trim());
	return configuredIds.includes(String(user?._id || "").trim());
};

const canReassignPropertyOwner = (user) =>
	Boolean(user) && (Number(user.role) === 1000 || isConfiguredSuperAdmin(user));

const normalizeId = (value) => String(value?._id || value || "").trim();

const includesId = (list = [], targetId) =>
	Array.isArray(list) &&
	list.some((item) => normalizeId(item) === normalizeId(targetId));

const canViewHotelStats = (user, hotel) => {
	if (!user || !hotel) return false;
	if (Number(user.role) === 1000 || isConfiguredSuperAdmin(user)) return true;

	const hotelId = normalizeId(hotel._id);
	const ownerId = normalizeId(hotel.belongsTo);
	const userId = normalizeId(user._id);

	if (Number(user.role) === 2000 && userId === ownerId) return true;
	if (includesId(user.hotelIdsOwner, hotelId)) return true;
	if (includesId(user.hotelsToSupport, hotelId)) return true;

	return (
		normalizeId(user.hotelIdWork) === hotelId &&
		normalizeId(user.belongsToId) === ownerId
	);
};

const DONE_RESERVATION_STATUS =
	/checked[-_\s]?out|early[-_\s]?checked[-_\s]?out|closed|cancelled|canceled|no[-_\s]?show/i;
const CONFIRMED_RESERVATION_STATUS = /^confirmed$/i;
const FINANCIAL_CYCLE_REQUIRED_FROM = new Date("2026-05-08T00:00:00.000Z");

const getDeclaredRoomsTotal = (hotel = {}) => {
	const directTotal = Number(hotel.overallRoomsCount || 0);
	if (directTotal > 0) return directTotal;

	return (hotel.roomCountDetails || []).reduce((total, room) => {
		const possibleCount =
			Number(room.count) ||
			Number(room.roomCount) ||
			Number(room.totalRooms) ||
			Number(room.availableRooms) ||
			0;
		return total + possibleCount;
	}, 0);
};

const extractReservationRoomIds = (roomId) => {
	if (!roomId) return [];
	if (Array.isArray(roomId)) return roomId.map(normalizeId).filter(Boolean);
	return [normalizeId(roomId)].filter(Boolean);
};

const getTodayEnd = () => {
	const endOfDay = new Date();
	endOfDay.setHours(23, 59, 59, 999);
	return endOfDay;
};

const buildOperationalOpenReservationFilter = (hotelObjectId) => ({
	hotelId: hotelObjectId,
	checkout_date: { $lte: getTodayEnd() },
	reservation_status: { $not: DONE_RESERVATION_STATUS },
});

const buildFinancialCycleRequiredDateFilter = () => ({
	$or: [
		{
			booked_at: { $gte: FINANCIAL_CYCLE_REQUIRED_FROM },
		},
		{
			$and: [
				{ $or: [{ booked_at: { $exists: false } }, { booked_at: null }] },
				{ createdAt: { $gte: FINANCIAL_CYCLE_REQUIRED_FROM } },
			],
		},
	],
});

const buildDashboardOpenReservationFilter = buildOperationalOpenReservationFilter;

const buildDashboardIncompleteReservationFilter = (hotelObjectId) => ({
	hotelId: hotelObjectId,
	$or: [
		{
			checkout_date: { $lte: getTodayEnd() },
			reservation_status: { $not: DONE_RESERVATION_STATUS },
		},
		{
			$and: [
				buildFinancialCycleRequiredDateFilter(),
				{ "financial_cycle.status": { $ne: "closed" } },
			],
		},
	],
});

const buildStoredHotelIdFilter = (hotelId) => ({
	$expr: { $eq: [{ $toString: "$hotelId" }, String(hotelId)] },
});

const makeReason = (code, en, ar) => ({ code, en, ar });

const compactReasons = (reasons = []) => {
	const seen = new Set();
	return reasons.filter((reason) => {
		const key = reason?.code || reason?.en;
		if (!key || seen.has(key)) return false;
		seen.add(key);
		return true;
	});
};

const serializeReasonText = (reasons = [], language = "en") =>
	reasons
		.map((reason) => reason?.[language] || reason?.en || "")
		.filter(Boolean)
		.join(language === "ar" ? "؛ " : "; ");

const isDueCheckoutWithoutDoneStatus = (reservation = {}) => {
	if (!reservation.checkout_date) return false;
	const checkoutDate = new Date(reservation.checkout_date);
	if (Number.isNaN(checkoutDate.getTime())) return false;

	return (
		checkoutDate <= getTodayEnd() &&
		!DONE_RESERVATION_STATUS.test(String(reservation.reservation_status || ""))
	);
};

const getOpenReservationReasons = (reservation = {}) => {
	const reasons = [];
	const cycle = reservation.financial_cycle || {};
	const cycleStatus = String(cycle.status || "").toLowerCase();
	const collectionModel = String(cycle.collectionModel || "").toLowerCase();

	if (cycleStatus !== "closed") {
		if (collectionModel === "pms_collected" && !reservation.moneyTransferredToHotel) {
			reasons.push(
				makeReason(
					"pms_transfer_pending",
					"PMS collected the payment, but transfer to the hotel is not marked complete.",
					"تم تحصيل المبلغ من النظام، لكن تحويل المبلغ للفندق غير مكتمل."
				)
			);
		} else if (collectionModel === "hotel_collected" && !reservation.commissionPaid) {
			reasons.push(
				makeReason(
					"hotel_commission_pending",
					"Hotel collected the payment, but commission is not marked paid.",
					"الفندق حصّل المبلغ، لكن العمولة غير مؤكدة السداد."
				)
			);
		} else if (
			collectionModel === "mixed" &&
			(!reservation.moneyTransferredToHotel || !reservation.commissionPaid)
		) {
			reasons.push(
				makeReason(
					"mixed_cycle_pending",
					"Mixed payment cycle still needs reconciliation.",
					"دورة دفع مختلطة ما زالت تحتاج مطابقة مالية."
				)
			);
		} else {
			reasons.push(
				makeReason(
					"financial_cycle_open",
					"Financial cycle is not closed yet.",
					"الدورة المالية لم تغلق بعد."
				)
			);
		}
	}

	if (isDueCheckoutWithoutDoneStatus(reservation)) {
		const status = reservation.reservation_status || "confirmed";
		reasons.push(
			makeReason(
				"checkout_due_status_open",
				`Checkout date is due, but reservation status is still ${status}.`,
				`تاريخ المغادرة مستحق، لكن حالة الحجز ما زالت ${status}.`
			)
		);
	}

	if (!reasons.length) {
		reasons.push(
			makeReason(
				"open_follow_up",
				"Reservation needs follow-up before it can be closed.",
				"الحجز يحتاج متابعة قبل إغلاقه."
			)
		);
	}

	return compactReasons(reasons);
};

const hasValidDate = (value) => {
	if (!value) return false;
	const date = new Date(value);
	return !Number.isNaN(date.getTime());
};

const hasPickedRoomType = (reservation = {}) =>
	Array.isArray(reservation.pickedRoomsType) &&
	reservation.pickedRoomsType.some((room) =>
		Boolean(room?.room_type || room?.roomType || room?.displayName)
	);

const getIncompleteReservationReasons = (reservation = {}) => {
	const reasons = [];
	const customer = reservation.customer_details || {};
	const status = String(
		reservation.reservation_status || reservation.state || ""
	).toLowerCase();
	const contactExists = Boolean(customer.phone || customer.email);

	if (reservation.rootCause) {
		reasons.push(
			makeReason(
				"root_cause",
				`Saved reason: ${reservation.rootCause}`,
				`السبب المسجل: ${reservation.rootCause}`
			)
		);
	}

	if (!reservation.confirmation_number) {
		reasons.push(
			makeReason(
				"missing_confirmation",
				"Missing confirmation number.",
				"رقم التأكيد غير موجود."
			)
		);
	}

	if (!customer.name) {
		reasons.push(
			makeReason("missing_guest_name", "Missing guest name.", "اسم الضيف غير موجود.")
		);
	}

	if (!contactExists) {
		reasons.push(
			makeReason(
				"missing_guest_contact",
				"Missing guest phone or email.",
				"رقم الهاتف أو البريد الإلكتروني للضيف غير موجود."
			)
		);
	}

	if (!hasValidDate(reservation.checkin_date) || !hasValidDate(reservation.checkout_date)) {
		reasons.push(
			makeReason(
				"missing_stay_dates",
				"Missing check-in or checkout date.",
				"تاريخ الوصول أو المغادرة غير مكتمل."
			)
		);
	}

	if (!hasPickedRoomType(reservation) || Number(reservation.total_rooms || 0) <= 0) {
		reasons.push(
			makeReason(
				"missing_room_details",
				"Missing room type or room count.",
				"نوع الغرفة أو عدد الغرف غير مكتمل."
			)
		);
	}

	if (!reservation.booking_source) {
		reasons.push(
			makeReason("missing_source", "Missing booking source.", "مصدر الحجز غير موجود.")
		);
	}

	if (reservation.guestAgreedOnTermsAndConditions === false) {
		reasons.push(
			makeReason(
				"terms_not_completed",
				"Guest terms and conditions were not completed.",
				"لم يتم استكمال موافقة الضيف على الشروط والأحكام."
			)
		);
	}

	if (status.includes("uncomplete") || status.includes("incomplete")) {
		reasons.push(
			makeReason(
				"saved_as_incomplete",
				"Reservation is still saved as incomplete.",
				"الحجز ما زال محفوظاً كحجز غير مكتمل."
			)
		);
	}

	if (!reasons.length) {
		reasons.push(
			makeReason(
				"incomplete_follow_up",
				"Reservation data needs review before completion.",
				"بيانات الحجز تحتاج مراجعة قبل الإكمال."
			)
		);
	}

	return compactReasons(reasons);
};

const getReservationBookedOrCreatedAt = (reservation = {}) => {
	const value = reservation.booked_at || reservation.createdAt;
	if (!value) return null;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
};

const isFinancialCycleRequired = (reservation = {}) => {
	const bookedOrCreatedAt = getReservationBookedOrCreatedAt(reservation);
	return Boolean(
		bookedOrCreatedAt && bookedOrCreatedAt >= FINANCIAL_CYCLE_REQUIRED_FROM
	);
};

const isFinancialCycleOpen = (reservation = {}) =>
	String(reservation?.financial_cycle?.status || "").toLowerCase() !== "closed";

const getDashboardFinancialReasons = (reservation = {}) => {
	const cycle = reservation.financial_cycle || {};
	const collectionModel = String(cycle.collectionModel || "").toLowerCase();

	if (!isFinancialCycleRequired(reservation) || !isFinancialCycleOpen(reservation)) {
		return [];
	}

	if (collectionModel === "pms_collected" && !reservation.moneyTransferredToHotel) {
		return [
			makeReason(
				"pms_transfer_pending",
				"PMS collected the payment, but transfer to the hotel is not marked complete.",
				"تم تحصيل المبلغ من النظام، لكن تحويل المبلغ للفندق غير مكتمل."
			),
		];
	}

	if (collectionModel === "hotel_collected" && !reservation.commissionPaid) {
		return [
			makeReason(
				"hotel_commission_pending",
				"Hotel collected the payment, but commission is not marked paid.",
				"الفندق حصل المبلغ، لكن العمولة غير مؤكدة السداد."
			),
		];
	}

	if (
		collectionModel === "mixed" &&
		(!reservation.moneyTransferredToHotel || !reservation.commissionPaid)
	) {
		return [
			makeReason(
				"mixed_cycle_pending",
				"Mixed payment cycle still needs reconciliation.",
				"دورة دفع مختلطة ما زالت تحتاج مطابقة مالية."
			),
		];
	}

	return [
		makeReason(
			"financial_cycle_open_after_cutoff",
			"Financial cycle is open.",
			"الدورة المالية مفتوحة."
		),
	];
};

const getOperationalDueReservationReasons = (reservation = {}) => {
	const reasons = [];

	if (isDueCheckoutWithoutDoneStatus(reservation)) {
		const status = reservation.reservation_status || "confirmed";
		reasons.push(
			makeReason(
				"checkout_due_status_open",
				`Checkout date is today or older, but reservation status is still ${status}.`,
				`تاريخ المغادرة اليوم أو أقدم، لكن حالة الحجز ما زالت ${status}.`
			)
		);
	}

	return reasons;
};

const getDashboardOpenReservationReasons = (reservation = {}) => {
	const reasons = getOperationalDueReservationReasons(reservation);

	return compactReasons(
		reasons.length
			? reasons
			: [
					makeReason(
						"open_follow_up",
						"Reservation needs follow-up before it can be closed.",
						"الحجز يحتاج متابعة قبل إغلاقه."
					),
			  ]
	);
};

const getDashboardIncompleteReservationReasons = (reservation = {}) => {
	const reasons = [...getOperationalDueReservationReasons(reservation)];
	const financialReasons = getDashboardFinancialReasons(reservation);

	if (financialReasons.length) {
		reasons.push(...financialReasons);
	}

	return compactReasons(
		reasons.length
			? reasons
			: [
					makeReason(
						"incomplete_follow_up",
						"Reservation needs operational or financial review before completion.",
						"الحجز يحتاج مراجعة تشغيلية أو مالية قبل الإغلاق."
					),
			  ]
	);
};

const attachReasonFields = (reservation, reasonGetter) => {
	const reasons = reasonGetter(reservation);
	return {
		...reservation,
		reasonDetails: reasons,
		reasons: reasons.map((reason) => reason.en),
		reasonsArabic: reasons.map((reason) => reason.ar),
		reason: serializeReasonText(reasons, "en"),
		reasonArabic: serializeReasonText(reasons, "ar"),
	};
};

exports.hotelDetailsById = (req, res, next, id) => {
	if (!mongoose.Types.ObjectId.isValid(id)) {
		return res.status(400).json({ error: "Invalid hotel ID" });
	}

	HotelDetails.findById(id).exec((err, hotelDetails) => {
		if (err || !hotelDetails) {
			return res.status(400).json({
				error: "Hotel details were not found",
			});
		}
		req.hotelDetails = hotelDetails;
		next();
	});
};

exports.create = (req, res) => {
	const hotelDetails = new HotelDetails(req.body);
	hotelDetails.save((err, data) => {
		if (err) {
			console.log(err, "err");
			return res.status(400).json({
				error: "Cannot create hotel details",
			});
		}
		res.json({ data });
	});
};

exports.read = (req, res) => {
	return res.json(req.hotelDetails);
};

exports.hotelGeneralStats = async (req, res) => {
	try {
		const { hotelId } = req.params;

		if (!mongoose.Types.ObjectId.isValid(hotelId)) {
			return res.status(400).json({ error: "Invalid hotel ID" });
		}

		const hotelObjectId = mongoose.Types.ObjectId(hotelId);
		const hotel = await HotelDetails.findById(hotelObjectId).lean().exec();

		if (!hotel) {
			return res.status(404).json({ error: "Hotel details were not found" });
		}

		if (!canViewHotelStats(req.profile, hotel)) {
			return res
				.status(403)
				.json({ error: "You do not have access to these hotel stats" });
		}

		const now = new Date();
		const startOfDay = new Date(now);
		startOfDay.setHours(0, 0, 0, 0);
		const endOfDay = new Date(now);
		endOfDay.setHours(23, 59, 59, 999);

		const dashboardOpenFilter =
			buildDashboardOpenReservationFilter(hotelObjectId);
		const dashboardIncompleteFilter =
			buildDashboardIncompleteReservationFilter(hotelObjectId);
		const [rooms, totalReservations, openReservations, uncompleted, sources] =
			await Promise.all([
				Rooms.find({ hotelId: hotelObjectId })
					.select("_id active activeRoom cleanRoom room_type display_name")
					.lean()
					.exec(),
				Reservations.countDocuments({ hotelId: hotelObjectId }),
				Reservations.countDocuments(dashboardOpenFilter),
				Reservations.countDocuments(dashboardIncompleteFilter),
				Reservations.aggregate([
					{ $match: { hotelId: hotelObjectId } },
					{
						$group: {
							_id: {
								$ifNull: ["$booking_source", "Unknown"],
							},
							count: { $sum: 1 },
						},
					},
					{ $sort: { count: -1, _id: 1 } },
					{ $limit: 5 },
				]),
			]);

		const todayReservations = await Reservations.find({
			hotelId: hotelObjectId,
			checkin_date: { $lte: endOfDay },
			checkout_date: { $gte: startOfDay },
			reservation_status: { $not: DONE_RESERVATION_STATUS },
		})
			.select("roomId reservation_status")
			.lean()
			.exec();

		const physicalRoomsTotal = rooms.length;
		const declaredRoomsTotal = getDeclaredRoomsTotal(hotel);
		const totalRooms = physicalRoomsTotal || declaredRoomsTotal;
		const activeRoomsList = rooms.filter(
			(room) => room.active !== false && room.activeRoom !== false
		);
		const activeRooms = physicalRoomsTotal
			? activeRoomsList.length
			: declaredRoomsTotal;
		const activeRoomIds = new Set(activeRoomsList.map((room) => normalizeId(room._id)));
		const occupiedRoomIds = new Set();

		todayReservations.forEach((reservation) => {
			extractReservationRoomIds(reservation.roomId).forEach((id) => {
				if (!activeRoomIds.size || activeRoomIds.has(id)) {
					occupiedRoomIds.add(id);
				}
			});
		});

		const occupiedRooms = occupiedRoomIds.size;
		const availableRooms = Math.max(activeRooms - occupiedRooms, 0);
		const inactiveRooms = Math.max(totalRooms - activeRooms, 0);

		const photosDone = !!hotel?.hotelPhotos?.length;
		const roomsDone = !!hotel?.roomCountDetails?.length;
		const locationDone =
			Array.isArray(hotel?.location?.coordinates) &&
			hotel.location.coordinates[0] !== 0 &&
			hotel.location.coordinates[1] !== 0;
		const dataDone = Boolean(
			hotel?.aboutHotel || hotel?.aboutHotelArabic || hotel?.overallRoomsCount
		);
		const bankDone = !!hotel?.paymentSettings?.length;
		const settingsDone = roomsDone && photosDone && locationDone && dataDone;
		const activationReady = roomsDone && photosDone && locationDone && dataDone;

		return res.json({
			hotelId: normalizeId(hotel._id),
			asOf: now,
			setup: {
				roomsDone,
				photosDone,
				locationDone,
				dataDone,
				bankDone,
				settingsDone,
				activationReady,
				activeHotel: !!hotel.activateHotel,
			},
			stats: {
				totalRooms,
				activeRooms,
				availableRooms,
				occupiedRooms,
				inactiveRooms,
				totalReservations,
				activeReservations: todayReservations.length,
				nonDoneReservations: openReservations,
				openReservations,
				uncompletedReservations: uncompleted,
				bookingSources: sources.map((source) => ({
					source: source._id || "Unknown",
					count: source.count || 0,
				})),
			},
		});
	} catch (err) {
		console.error("hotelGeneralStats error:", err);
		return res.status(500).json({ error: "Could not load hotel stats" });
	}
};

exports.hotelOpenReservations = async (req, res) => {
	try {
		const { hotelId } = req.params;
		if (!mongoose.Types.ObjectId.isValid(hotelId)) {
			return res.status(400).json({ error: "Invalid hotel ID" });
		}

		const hotelObjectId = mongoose.Types.ObjectId(hotelId);
		const hotel = await HotelDetails.findById(hotelObjectId).lean().exec();
		if (!hotel) {
			return res.status(404).json({ error: "Hotel details were not found" });
		}

		if (!canViewHotelStats(req.profile, hotel)) {
			return res
				.status(403)
				.json({ error: "You do not have access to these reservations" });
		}

		const {
			page = 1,
			limit = 10,
			search = "",
			sortBy = "booked_at",
			sortOrder = "asc",
			dateBy = "booked_at",
			dateFrom = "",
			dateTo = "",
			exportAll = "",
		} = req.query || {};

		const currentPage = Math.max(parseInt(page, 10) || 1, 1);
		const pageSize = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 30);
		const shouldExportAll = ["1", "true", "yes", "all"].includes(
			String(exportAll).toLowerCase()
		);
		const allowedSorts = ["booked_at", "checkin_date", "checkout_date"];
		const sortField = allowedSorts.includes(sortBy) ? sortBy : "booked_at";
		const dateField = allowedSorts.includes(dateBy) ? dateBy : "booked_at";
		const direction = String(sortOrder).toLowerCase() === "desc" ? -1 : 1;

		const filters = [buildDashboardOpenReservationFilter(hotelObjectId)];
		const trimmedSearch = String(search || "").trim();

		if (trimmedSearch) {
			const searchRegex = new RegExp(
				trimmedSearch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
				"i"
			);
			filters.push({
				$or: [
					{ confirmation_number: searchRegex },
					{ "customer_details.name": searchRegex },
				],
			});
		}

		if (dateFrom || dateTo) {
			const dateRange = {};
			if (dateFrom) {
				const from = new Date(`${dateFrom}T00:00:00.000Z`);
				if (!Number.isNaN(from.getTime())) dateRange.$gte = from;
			}
			if (dateTo) {
				const to = new Date(`${dateTo}T23:59:59.999Z`);
				if (!Number.isNaN(to.getTime())) dateRange.$lte = to;
			}
			if (Object.keys(dateRange).length) {
				filters.push({ [dateField]: dateRange });
			}
		}

		const filter = filters.length > 1 ? { $and: filters } : filters[0];
		let reservationsQuery = Reservations.find(filter)
			.select(
				"confirmation_number customer_details.name booking_source booked_at checkin_date checkout_date total_amount payment reservation_status financial_cycle commission commissionPaid moneyTransferredToHotel createdByUserId createdBy orderTakeId orderTaker orderTakenAt"
			)
			.sort({ [sortField]: direction, _id: 1 })
			.lean();
		if (!shouldExportAll) {
			reservationsQuery = reservationsQuery
				.skip((currentPage - 1) * pageSize)
				.limit(pageSize);
		}

		const [total, reservations] = await Promise.all([
			Reservations.countDocuments(filter),
			reservationsQuery.exec(),
		]);

		return res.json({
			page: shouldExportAll ? 1 : currentPage,
			limit: shouldExportAll ? total : pageSize,
			total,
			pages: shouldExportAll ? 1 : Math.ceil(total / pageSize),
			reservations: reservations.map((reservation) =>
				attachReasonFields(reservation, getDashboardOpenReservationReasons)
			),
		});
	} catch (err) {
		console.error("hotelOpenReservations error:", err);
		return res.status(500).json({ error: "Could not load open reservations" });
	}
};

exports.hotelIncompleteReservations = async (req, res) => {
	try {
		const { hotelId } = req.params;
		if (!mongoose.Types.ObjectId.isValid(hotelId)) {
			return res.status(400).json({ error: "Invalid hotel ID" });
		}

		const hotelObjectId = mongoose.Types.ObjectId(hotelId);
		const hotel = await HotelDetails.findById(hotelObjectId).lean().exec();
		if (!hotel) {
			return res.status(404).json({ error: "Hotel details were not found" });
		}

		if (!canViewHotelStats(req.profile, hotel)) {
			return res
				.status(403)
				.json({ error: "You do not have access to these reservations" });
		}

		const {
			page = 1,
			limit = 10,
			search = "",
			sortBy = "booked_at",
			sortOrder = "asc",
			dateBy = "booked_at",
			dateFrom = "",
			dateTo = "",
			exportAll = "",
		} = req.query || {};

		const currentPage = Math.max(parseInt(page, 10) || 1, 1);
		const pageSize = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 30);
		const shouldExportAll = ["1", "true", "yes", "all"].includes(
			String(exportAll).toLowerCase()
		);
		const allowedSorts = ["booked_at", "checkin_date", "checkout_date"];
		const sortField = allowedSorts.includes(sortBy) ? sortBy : "booked_at";
		const dateField = allowedSorts.includes(dateBy) ? dateBy : "booked_at";
		const direction = String(sortOrder).toLowerCase() === "desc" ? -1 : 1;

		const filters = [buildDashboardIncompleteReservationFilter(hotelObjectId)];
		const trimmedSearch = String(search || "").trim();

		if (trimmedSearch) {
			const searchRegex = new RegExp(
				trimmedSearch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
				"i"
			);
			filters.push({
				$or: [
					{ confirmation_number: searchRegex },
					{ "customer_details.name": searchRegex },
				],
			});
		}

		if (dateFrom || dateTo) {
			const dateRange = {};
			if (dateFrom) {
				const from = new Date(`${dateFrom}T00:00:00.000Z`);
				if (!Number.isNaN(from.getTime())) dateRange.$gte = from;
			}
			if (dateTo) {
				const to = new Date(`${dateTo}T23:59:59.999Z`);
				if (!Number.isNaN(to.getTime())) dateRange.$lte = to;
			}
			if (Object.keys(dateRange).length) {
				filters.push({ [dateField]: dateRange });
			}
		}

		const filter = filters.length > 1 ? { $and: filters } : filters[0];
		let reservationsQuery = Reservations.find(filter)
			.select(
				"confirmation_number customer_details.name booking_source booked_at createdAt checkin_date checkout_date total_amount payment reservation_status financial_cycle commission commissionPaid moneyTransferredToHotel createdByUserId createdBy orderTakeId orderTaker orderTakenAt"
			)
			.sort({ [sortField]: direction, _id: 1 })
			.lean();
		if (!shouldExportAll) {
			reservationsQuery = reservationsQuery
				.skip((currentPage - 1) * pageSize)
				.limit(pageSize);
		}

		const [total, reservations] = await Promise.all([
			Reservations.countDocuments(filter),
			reservationsQuery.exec(),
		]);

		return res.json({
			page: shouldExportAll ? 1 : currentPage,
			limit: shouldExportAll ? total : pageSize,
			total,
			pages: shouldExportAll ? 1 : Math.ceil(total / pageSize),
			reservations: reservations.map((reservation) =>
				attachReasonFields(
					{
						...reservation,
						reservationId: reservation._id,
					},
					getDashboardIncompleteReservationReasons
				)
			),
		});
	} catch (err) {
		console.error("hotelIncompleteReservations error:", err);
		return res
			.status(500)
			.json({ error: "Could not load incomplete reservations" });
	}
};

const hasRoomIdentity = (room = {}) => {
	const rt = typeof room.roomType === "string" ? room.roomType.trim() : "";
	const dn =
		typeof room.displayName === "string" ? room.displayName.trim() : "";
	return rt.length > 0 && dn.length > 0;
};

const normalizeIdentity = (room = {}) => {
	const out = { ...room };
	if (typeof out.roomType === "string") out.roomType = out.roomType.trim();
	if (typeof out.displayName === "string")
		out.displayName = out.displayName.trim();
	return out;
};

// Keep your existing color uniqueness behavior; only minor safety guards
const ensureUniqueRoomColors = (roomCountDetails = []) => {
	const colorMap = {};
	roomCountDetails.forEach((room) => {
		if (!room || !room.roomType) return;

		if (!colorMap[room.roomType]) {
			colorMap[room.roomType] = new Set();
		}

		const used = colorMap[room.roomType];

		// If duplicate, generate new color (assumes generateUniqueDarkColor exists in your codebase)
		if (room.roomColor && used.has(room.roomColor)) {
			const generator =
				typeof generateUniqueDarkColor === "function"
					? generateUniqueDarkColor
					: (existing = []) => {
							// simple fallback
							const rnd = () =>
								Math.floor(Math.random() * 128)
									.toString(16)
									.padStart(2, "0");
							let candidate = `#${rnd()}${rnd()}${rnd()}`;
							let tries = 0;
							const set = new Set(existing);
							while (set.has(candidate) && tries < 20) {
								candidate = `#${rnd()}${rnd()}${rnd()}`;
								tries += 1;
							}
							return candidate;
					  };
			const existing = Array.from(used);
			room.roomColor = generator(existing);
			console.log(
				`Duplicate color found for roomType ${room.roomType}. Generated new color: ${room.roomColor}`
			);
		}

		if (room.roomColor) used.add(room.roomColor);
	});
};

/**
 * Constructs the fields to be updated in the HotelDetails document.
 * Merges roomCountDetails and paymentSettings while ensuring unique room colors.
 * Critically: prevents creating a new "blank" room (must have roomType + displayName).
 */
const constructUpdatedFields = (hotelDetails, updateData, fromPage) => {
	const updatedFields = {};

	// Process roomCountDetails if provided
	if (
		updateData.roomCountDetails &&
		Array.isArray(updateData.roomCountDetails)
	) {
		// Clone existing rooms safely (Mongoose doc or plain object)
		let updatedRoomCountDetails = (hotelDetails.roomCountDetails || []).map(
			(existingRoom) =>
				typeof existingRoom?.toObject === "function"
					? existingRoom.toObject()
					: { ...existingRoom }
		);

		updateData.roomCountDetails.forEach((incoming) => {
			const newRoomRaw = incoming || {};
			const newRoom = normalizeIdentity(newRoomRaw);
			const identityOK = hasRoomIdentity(newRoom);

			if (fromPage === "AddNew") {
				// DO NOT create a room unless it has roomType + displayName
				if (!identityOK) {
					console.warn(
						`Skipping room without roomType/displayName during AddNew: ${JSON.stringify(
							newRoomRaw
						)}`
					);
					return;
				}

				// Match existing by identity (roomType + displayName)
				const existingIndex = updatedRoomCountDetails.findIndex(
					(room) =>
						(room.roomType || "").toString().trim() === newRoom.roomType &&
						(room.displayName || "").toString().trim() === newRoom.displayName
				);

				if (existingIndex !== -1) {
					// Merge
					updatedRoomCountDetails[existingIndex] = {
						...updatedRoomCountDetails[existingIndex],
						...newRoom,
					};
				} else {
					if (newRoom.activeRoom === undefined) newRoom.activeRoom = true;
					updatedRoomCountDetails.push(newRoom);
					console.log(`Added new room: ${JSON.stringify(newRoom)}`);
				}
			} else {
				// Non-AddNew: match/update by _id only (your existing behavior)
				if (newRoom._id) {
					const existingIndex = updatedRoomCountDetails.findIndex(
						(room) => room._id?.toString?.() === newRoom._id.toString()
					);

					if (existingIndex !== -1) {
						// Merge but protect identity from being blanked by accidental empty values
						const existing = updatedRoomCountDetails[existingIndex];
						const merged = { ...existing, ...newRoom };
						if (!hasRoomIdentity(newRoom)) {
							// keep existing identity if incoming lacks it
							merged.roomType = existing.roomType;
							merged.displayName = existing.displayName;
						}
						updatedRoomCountDetails[existingIndex] = merged;
					} else {
						// Only allow adding a *new* room here if it also has identity
						if (identityOK) {
							if (newRoom.activeRoom === undefined) newRoom.activeRoom = true;
							updatedRoomCountDetails.push(newRoom);
							console.log(`Added new room with _id: ${newRoom._id}`);
						} else {
							console.warn(
								`Skipping room without identity and no match by _id on non-AddNew: ${JSON.stringify(
									newRoomRaw
								)}`
							);
						}
					}
				} else {
					// No _id on non-AddNew → skip (your previous code warned too)
					console.warn(
						`Skipping room without _id on non-AddNew page: ${JSON.stringify(
							newRoomRaw
						)}`
					);
				}
			}
		});

		// Ensure all room colors are unique within the same roomType
		ensureUniqueRoomColors(updatedRoomCountDetails);

		// Assign the updated rooms
		updatedFields.roomCountDetails = updatedRoomCountDetails;
	}

	// Merge paymentSettings if provided
	if (updateData.paymentSettings && Array.isArray(updateData.paymentSettings)) {
		updatedFields.paymentSettings = updateData.paymentSettings;
		console.log(
			`Merged paymentSettings: ${JSON.stringify(
				updateData.paymentSettings,
				null,
				2
			)}`
		);
	}

	// Process other fields (excluding roomCountDetails and paymentSettings)
	Object.keys(updateData).forEach((key) => {
		if (key !== "roomCountDetails" && key !== "paymentSettings") {
			updatedFields[key] = updateData[key];
			console.log(`Updated field ${key}: ${updateData[key]}`);
		}
	});

	return updatedFields;
};

/**
 * Distance calculation helper (unchanged except minor guards)
 */
const calcDistances = async (coords, hotelState = "") => {
	const [lng, lat] = coords; // hotel stores [lng, lat]
	const elHaram = [39.8262, 21.4225];
	const prophetsMosque = [39.6142, 24.4672];

	const dest = (hotelState || "").toLowerCase().includes("madinah")
		? prophetsMosque
		: elHaram;

	const apiKey = process.env.GOOGLE_MAPS_API_KEY;
	if (!apiKey) {
		console.warn("GOOGLE_MAPS_API_KEY missing; skipping live distance call.");
		return { walkingToElHaram: "N/A", drivingToElHaram: "N/A" };
	}

	const makeURL = (mode) =>
		`https://maps.googleapis.com/maps/api/distancematrix/json?origins=${lat},${lng}&destinations=${dest[1]},${dest[0]}&mode=${mode}&key=${apiKey}`;

	try {
		const [walkResp, driveResp] = await Promise.all([
			axios.get(makeURL("walking")),
			axios.get(makeURL("driving")),
		]);

		const walkEl = walkResp.data?.rows?.[0]?.elements?.[0];
		const driveEl = driveResp.data?.rows?.[0]?.elements?.[0];

		return {
			walkingToElHaram:
				walkEl && walkEl.status === "OK" ? walkEl.duration.text : "N/A",
			drivingToElHaram:
				driveEl && driveEl.status === "OK" ? driveEl.duration.text : "N/A",
		};
	} catch (err) {
		console.error("Distance API error:", err.message || err);
		return { walkingToElHaram: "N/A", drivingToElHaram: "N/A" };
	}
};

/* ────────────────── UPDATE HANDLER ────────────────── */

exports.updateHotelDetails = async (req, res) => {
	const hotelDetailsId = req.params.hotelId;
	const updateData = req.body;
	const fromPage = req.body.fromPage; // e.g. "AddNew"

	try {
		/* 1. Fetch existing doc */
		const hotelDetails = await HotelDetails.findById(hotelDetailsId).exec();
		if (!hotelDetails)
			return res.status(404).json({ error: "Hotel details not found" });

		/* 2. Merge incoming data with helper */
		const updatedFields = constructUpdatedFields(
			hotelDetails,
			updateData,
			fromPage
		);
		updatedFields.fromPage = fromPage;

		/* 🔒 Ensure booleans that can be false are not dropped */
		if (Object.prototype.hasOwnProperty.call(updateData, "aiToRespond")) {
			updatedFields.aiToRespond = toBoolean(updateData.aiToRespond); // ← NEW
		}

		/* 3. Detect coordinate change */
		const newCoords = updateData?.location?.coordinates;
		const oldCoords = hotelDetails.location?.coordinates;
		const coordsChanged =
			Array.isArray(newCoords) &&
			newCoords.length === 2 &&
			(!oldCoords ||
				oldCoords[0] !== newCoords[0] ||
				oldCoords[1] !== newCoords[1]);

		if (coordsChanged) {
			/* 3a. Compute fresh distances */
			const distances = await calcDistances(
				newCoords,
				updateData.hotelState ||
					updatedFields.hotelState ||
					hotelDetails.hotelState
			);

			/* 3b. Attach to update payload */
			updatedFields.distances = distances;
			console.log(
				`Distances recalculated for hotel ${hotelDetailsId}:`,
				distances
			);
		}

		/* 4. Persist */
		const newDoc = await HotelDetails.findByIdAndUpdate(
			hotelDetailsId,
			{ $set: updatedFields },
			{ new: true, runValidators: true }
		).exec();

		if (!newDoc)
			return res.status(500).json({ error: "Failed to update hotel details" });

		return res.json(newDoc);
	} catch (err) {
		console.error("updateHotelDetails error:", err);
		return res.status(500).json({ error: "Internal server error" });
	}
};

exports.reassignHotelOwner = async (req, res) => {
	try {
		if (!canReassignPropertyOwner(req.profile)) {
			return res
				.status(403)
				.json({ error: "Only platform admins can reassign a property owner" });
		}

		const { hotelId } = req.params;
		const { newOwnerId, transferExistingReservations = true } = req.body || {};

		if (
			!mongoose.Types.ObjectId.isValid(hotelId) ||
			!mongoose.Types.ObjectId.isValid(newOwnerId)
		) {
			return res.status(400).json({ error: "Invalid hotel or owner id" });
		}

		const hotelObjectId = mongoose.Types.ObjectId(hotelId);
		const newOwnerObjectId = mongoose.Types.ObjectId(newOwnerId);

		const [hotelDetails, newOwner] = await Promise.all([
			HotelDetails.findById(hotelObjectId).exec(),
			User.findById(newOwnerObjectId).exec(),
		]);

		if (!hotelDetails) {
			return res.status(404).json({ error: "Hotel details not found" });
		}
		if (!newOwner || Number(newOwner.role) !== 2000) {
			return res
				.status(400)
				.json({ error: "Please select a valid hotel owner account" });
		}
		if (newOwner.activeUser === false) {
			return res.status(400).json({ error: "Selected owner account is inactive" });
		}

		const oldOwnerId = hotelDetails.belongsTo
			? mongoose.Types.ObjectId(hotelDetails.belongsTo)
			: null;
		const sameOwner =
			oldOwnerId && String(oldOwnerId) === String(newOwnerObjectId);

		if (sameOwner) {
			const populated = await HotelDetails.findById(hotelObjectId)
				.populate("belongsTo", "name email phone role activeUser hotelIdsOwner")
				.exec();
			return res.json({
				message: "Property already belongs to this owner",
				hotel: populated,
				counts: {
					hotelUpdated: 0,
					oldOwnerUpdated: 0,
					newOwnerUpdated: 0,
					reservationsUpdated: 0,
					uncompletedReservationsUpdated: 0,
					roomsUpdated: 0,
					scopedStaffUpdated: 0,
				},
			});
		}

		hotelDetails.belongsTo = newOwnerObjectId;
		await hotelDetails.save();

		const counts = {
			hotelUpdated: 1,
			oldOwnerUpdated: 0,
			newOwnerUpdated: 0,
			reservationsUpdated: 0,
			uncompletedReservationsUpdated: 0,
			roomsUpdated: 0,
			scopedStaffUpdated: 0,
		};

		if (oldOwnerId) {
			const oldOwnerResult = await User.updateOne(
				{ _id: oldOwnerId },
				{ $pull: { hotelIdsOwner: hotelObjectId } }
			).exec();
			counts.oldOwnerUpdated =
				oldOwnerResult.modifiedCount || oldOwnerResult.nModified || 0;
		}

		const newOwnerResult = await User.updateOne(
			{ _id: newOwnerObjectId },
			{ $addToSet: { hotelIdsOwner: hotelObjectId } }
		).exec();
		counts.newOwnerUpdated =
			newOwnerResult.modifiedCount || newOwnerResult.nModified || 0;

		if (transferExistingReservations) {
			const reservationsResult = await Reservations.updateMany(
				{ hotelId: hotelObjectId },
				{ $set: { belongsTo: newOwnerObjectId } }
			).exec();
			counts.reservationsUpdated =
				reservationsResult.modifiedCount || reservationsResult.nModified || 0;

			const uncompletedResult = await UncompleteReservations.updateMany(
				{ hotelId: hotelObjectId },
				{ $set: { belongsTo: newOwnerObjectId } }
			).exec();
			counts.uncompletedReservationsUpdated =
				uncompletedResult.modifiedCount || uncompletedResult.nModified || 0;
		}

		const roomsResult = await Rooms.updateMany(
			{ hotelId: hotelObjectId },
			{ $set: { belongsTo: newOwnerObjectId } }
		).exec();
		counts.roomsUpdated = roomsResult.modifiedCount || roomsResult.nModified || 0;

		const staffResult = await User.updateMany(
			{ hotelIdWork: String(hotelObjectId) },
			{ $set: { belongsToId: String(newOwnerObjectId) } }
		).exec();
		counts.scopedStaffUpdated =
			staffResult.modifiedCount || staffResult.nModified || 0;

		const populated = await HotelDetails.findById(hotelObjectId)
			.populate("belongsTo", "name email phone role activeUser hotelIdsOwner")
			.exec();

		return res.json({
			message: "Property owner reassigned successfully",
			hotel: populated,
			counts,
		});
	} catch (err) {
		console.error("reassignHotelOwner error:", err);
		return res.status(500).json({ error: "Property reassignment failed" });
	}
};

/* Helper: robust boolean coercion */
function toBoolean(v) {
	if (typeof v === "boolean") return v;
	if (typeof v === "number") return v !== 0;
	if (typeof v === "string") {
		const s = v.trim().toLowerCase();
		// accept common truthy/falsey forms just in case a gateway sends strings
		if (["true", "1", "yes", "on"].includes(s)) return true;
		if (["false", "0", "no", "off", ""].includes(s)) return false;
	}
	return !!v; // fallback
}

exports.list = (req, res) => {
	const userId = mongoose.Types.ObjectId(req.params.accountId);

	HotelDetails.find({ belongsTo: userId })
		.populate("belongsTo", "name email") // Select only necessary fields
		.exec((err, data) => {
			if (err) {
				console.log(err, "err");
				return res.status(400).json({ error: err });
			}
			res.json(data);
		});
};

exports.remove = (req, res) => {
	const hotelDetails = req.hotelDetails;

	hotelDetails.remove((err) => {
		if (err) {
			return res.status(400).json({ error: "Error while removing" });
		}
		res.json({ message: "Hotel details deleted" });
	});
};

exports.getHotelDetails = (req, res) => {
	return res.json(req.hotelDetails);
};

exports.listForAdmin = async (req, res) => {
	try {
		/* 1️⃣  Parse & sanitise query params */
		let { page = 1, limit = 15, status, q = "", filter = "all" } = req.query;

		page = Math.max(parseInt(page, 10) || 1, 1);
		limit = Math.min(Math.max(parseInt(limit, 10) || 15, 1), 50);
		const skip = (page - 1) * limit;

		/* 2️⃣  Base filter (status) */
		const baseMatch = {};
		if (status === "active") baseMatch.activateHotel = true;
		if (status === "inactive") baseMatch.activateHotel = false;

		/* 3️⃣  Search filter (if q present) */
		const search = q.trim();
		let searchMatch = {};
		if (search) {
			// escape regex special chars then make case‑insensitive regex
			const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const regex = new RegExp(escaped, "i");
			searchMatch = {
				$or: [
					{ hotelName: regex },
					{ hotelCountry: regex },
					{ hotelCity: regex },
					{ hotelAddress: regex },
					{ phone: regex },
					{ "owner.name": regex },
					{ "owner.email": regex },
				],
			};
		}

		/* 4️⃣  Build pipeline core (+ computed flags) */
		const pipelineCore = [
			{ $match: baseMatch },
			{
				$lookup: {
					from: "users",
					localField: "belongsTo",
					foreignField: "_id",
					as: "owner",
				},
			},
			{ $unwind: { path: "$owner", preserveNullAndEmptyArrays: true } },
			// computed completeness flags
			{
				$addFields: {
					roomsDone: {
						$gt: [{ $size: { $ifNull: ["$roomCountDetails", []] } }, 0],
					},
					photosDone: {
						$gt: [{ $size: { $ifNull: ["$hotelPhotos", []] } }, 0],
					},
					locationDone: {
						$let: {
							vars: { coords: { $ifNull: ["$location.coordinates", []] } },
							in: {
								$and: [
									{ $gte: [{ $size: "$$coords" }, 2] },
									{ $ne: [{ $arrayElemAt: ["$$coords", 0] }, 0] },
									{ $ne: [{ $arrayElemAt: ["$$coords", 1] }, 0] },
								],
							},
						},
					},
					dataDone: {
						$or: [
							{ $gt: [{ $strLenCP: { $ifNull: ["$aboutHotel", ""] } }, 0] },
							{
								$gt: [{ $strLenCP: { $ifNull: ["$aboutHotelArabic", ""] } }, 0],
							},
							{ $gt: [{ $ifNull: ["$overallRoomsCount", 0] }, 0] },
						],
					},
					bankDone: {
						$gt: [{ $size: { $ifNull: ["$paymentSettings", []] } }, 0],
					},
				},
			},
			{
				$addFields: {
					activationReady: {
						$and: ["$roomsDone", "$photosDone", "$locationDone", "$dataDone"],
					},
					fullyComplete: {
						$and: [
							"$roomsDone",
							"$photosDone",
							"$locationDone",
							"$dataDone",
							"$bankDone",
						],
					},
				},
			},
		];

		if (search) pipelineCore.push({ $match: searchMatch });

		/* 5️⃣  Step-based filter mapping (optional) */
		const stepFilterMatch =
			filter === "missing_rooms"
				? { roomsDone: false }
				: filter === "missing_photos"
				? { photosDone: false }
				: filter === "missing_location"
				? { locationDone: false }
				: filter === "missing_data"
				? { dataDone: false }
				: filter === "missing_bank"
				? { bankDone: false }
				: filter === "activation_ready"
				? { activationReady: true }
				: filter === "fully_complete"
				? { fullyComplete: true }
				: filter === "missing_any"
				? {
						$or: [
							{ roomsDone: { $ne: true } },
							{ photosDone: { $ne: true } },
							{ locationDone: { $ne: true } },
							{ dataDone: { $ne: true } },
						],
				  }
				: {}; // 'all' or unknown => no extra filter

		/* 6️⃣  Group definition for summaries */
		const summaryGroup = {
			_id: null,
			total: { $sum: 1 },
			active: {
				$sum: {
					$cond: [{ $eq: ["$activateHotel", true] }, 1, 0],
				},
			},
			inactive: {
				$sum: {
					$cond: [{ $ne: ["$activateHotel", true] }, 1, 0],
				},
			},

			roomsDone: {
				$sum: { $cond: [{ $eq: ["$roomsDone", true] }, 1, 0] },
			},
			roomsMissing: {
				$sum: { $cond: [{ $ne: ["$roomsDone", true] }, 1, 0] },
			},

			photosDone: {
				$sum: { $cond: [{ $eq: ["$photosDone", true] }, 1, 0] },
			},
			photosMissing: {
				$sum: { $cond: [{ $ne: ["$photosDone", true] }, 1, 0] },
			},

			locationDone: {
				$sum: { $cond: [{ $eq: ["$locationDone", true] }, 1, 0] },
			},
			locationMissing: {
				$sum: { $cond: [{ $ne: ["$locationDone", true] }, 1, 0] },
			},

			dataDone: {
				$sum: { $cond: [{ $eq: ["$dataDone", true] }, 1, 0] },
			},
			dataMissing: {
				$sum: { $cond: [{ $ne: ["$dataDone", true] }, 1, 0] },
			},

			bankDone: {
				$sum: { $cond: [{ $eq: ["$bankDone", true] }, 1, 0] },
			},
			bankMissing: {
				$sum: { $cond: [{ $ne: ["$bankDone", true] }, 1, 0] },
			},

			activationReady: {
				$sum: { $cond: [{ $eq: ["$activationReady", true] }, 1, 0] },
			},
			activationNotReady: {
				$sum: { $cond: [{ $ne: ["$activationReady", true] }, 1, 0] },
			},

			fullyComplete: {
				$sum: { $cond: [{ $eq: ["$fullyComplete", true] }, 1, 0] },
			},
			notFullyComplete: {
				$sum: { $cond: [{ $ne: ["$fullyComplete", true] }, 1, 0] },
			},
		};

		/* 7️⃣  Final aggregation with facet */
		const pipeline = [
			...pipelineCore,
			{ $sort: { createdAt: -1 } },
			{
				$facet: {
					data: [
						...(Object.keys(stepFilterMatch).length
							? [{ $match: stepFilterMatch }]
							: []),
						{ $skip: skip },
						{ $limit: limit },
					],
					totalCount: [
						...(Object.keys(stepFilterMatch).length
							? [{ $match: stepFilterMatch }]
							: []),
						{ $count: "count" },
					],
					summaryOverall: [{ $group: summaryGroup }],
					summaryCurrent: [
						...(Object.keys(stepFilterMatch).length
							? [{ $match: stepFilterMatch }]
							: []),
						{ $group: summaryGroup },
					],
				},
			},
		];

		const result = await HotelDetails.aggregate(pipeline).exec();

		const facet = result[0] || {};
		const hotels = Array.isArray(facet.data) ? facet.data : [];
		const total =
			facet.totalCount && facet.totalCount[0] ? facet.totalCount[0].count : 0;

		const cleaned = hotels.map((h) => {
			const out = { ...h };
			if (h.owner) {
				out.belongsTo = {
					_id: h.owner._id,
					name: h.owner.name,
					email: h.owner.email,
				};
			}
			delete out.owner;
			return out;
		});

		const safeSummary = (arr) =>
			arr && arr[0]
				? arr[0]
				: {
						total: 0,
						active: 0,
						inactive: 0,
						roomsDone: 0,
						roomsMissing: 0,
						photosDone: 0,
						photosMissing: 0,
						locationDone: 0,
						locationMissing: 0,
						dataDone: 0,
						dataMissing: 0,
						bankDone: 0,
						bankMissing: 0,
						activationReady: 0,
						activationNotReady: 0,
						fullyComplete: 0,
						notFullyComplete: 0,
				  };

		return res.json({
			total,
			page,
			pages: Math.ceil(total / limit),
			results: cleaned.length,
			hotels: cleaned,
			summary: {
				overall: safeSummary(facet.summaryOverall),
				currentView: safeSummary(facet.summaryCurrent),
			},
		});
	} catch (err) {
		console.error("listForAdmin error:", err);
		return res.status(400).json({ error: "Failed to fetch hotel list" });
	}
};

exports.listForAdminAll = async (req, res) => {
	try {
		/* 1️⃣  Parse & sanitise query params (optional filters) */
		let { status, q = "" } = req.query;

		/* 2️⃣  Base filter (status) */
		const baseMatch = {};
		if (status === "active") baseMatch.activateHotel = true;
		if (status === "inactive") baseMatch.activateHotel = false;

		/* 3️⃣  Search filter (if q present) */
		const search = (typeof q === "string" ? q : "").trim();
		let searchMatch = {};
		if (search) {
			// escape regex special chars then make case‑insensitive regex
			const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const regex = new RegExp(escaped, "i");

			searchMatch = {
				$or: [
					{ hotelName: regex },
					{ hotelCountry: regex },
					{ hotelCity: regex },
					{ hotelAddress: regex },
					{ phone: regex },
					{ "owner.name": regex },
					{ "owner.email": regex },
				],
			};
		}

		/* 4️⃣  Build aggregation pipeline (same join as listForAdmin) */
		const pipeline = [
			{ $match: baseMatch },
			{
				$lookup: {
					from: "users", // collection name
					localField: "belongsTo",
					foreignField: "_id",
					as: "owner",
				},
			},
			{ $unwind: { path: "$owner", preserveNullAndEmptyArrays: true } },
		];

		if (search) pipeline.push({ $match: searchMatch });

		pipeline.push({ $sort: { createdAt: -1 } }); // newest first

		/* 5️⃣  Run the aggregation (no pagination; return all) */
		const docs = await HotelDetails.aggregate(pipeline)
			.allowDiskUse(true) // safer if dataset is large
			.exec();

		/* 6️⃣  Minimal owner projection (id, name, email) */
		const hotels = (docs || []).map((h) => {
			if (h.owner) {
				h.belongsTo = {
					_id: h.owner._id,
					name: h.owner.name,
					email: h.owner.email,
				};
			}
			delete h.owner;
			return h;
		});

		/* 7️⃣  Send (no page/pages since it's "all") */
		return res.json({
			total: hotels.length,
			results: hotels.length,
			hotels,
		});
	} catch (err) {
		console.error("listForAdminAll error:", err);
		return res.status(400).json({ error: "Failed to fetch all hotels" });
	}
};

exports.listOfHotelUser = async (req, res) => {
	try {
		const { accountId } = req.params;

		// Find all hotel details where the belongsTo field matches the accountId
		const hotels = await HotelDetails.find({ belongsTo: accountId });

		if (!hotels.length) {
			return res.status(404).json({
				message: "No hotels found for this user.",
			});
		}

		res.status(200).json(hotels);
	} catch (error) {
		console.error("Error fetching hotels:", error);
		res.status(500).json({
			error: "An error occurred while fetching the hotels.",
		});
	}
};

/** ─────────────────────────────────────────────────────────────────────
 *  Owner payment method save/list/default/remove
 *  - Reuses paypalExchangeSetupToVault(setup_token_id)
 *  - Persists a sanitized record under HotelDetails.ownerPaymentMethods[]
 *  - Never stores PAN/CVV
 *  - Optional: verifies that requester owns the hotel (req.user)
 *  Endpoints wired below in routes
 *  ──────────────────────────────────────────────────────────────────── */

exports.saveOwnerPaymentMethod = async (req, res) => {
	try {
		const { hotelId } = req.params;
		const { setup_token, label, setDefault } = req.body || {};

		if (!mongoose.Types.ObjectId.isValid(hotelId)) {
			return res.status(400).json({ message: "Invalid hotelId." });
		}
		if (!setup_token) {
			return res.status(400).json({ message: "setup_token is required." });
		}

		const hotel = await HotelDetails.findById(hotelId).select(
			"_id belongsTo ownerPaymentMethods"
		);
		if (!hotel) return res.status(404).json({ message: "Hotel not found." });

		// Optional auth guard: only owner/admin can attach a payment method
		if (
			req.user &&
			String(hotel.belongsTo) !== String(req.user._id) &&
			String(req.user.role || "").toLowerCase() !== "admin"
		) {
			return res.status(403).json({ message: "Not allowed." });
		}

		// 1) Exchange setup_token -> PayPal vault payment token (no PAN/CVV)
		let tokenData;
		try {
			tokenData = await paypalExchangeSetupToVault(setup_token);
		} catch (e) {
			console.error("Owner vault exchange failed:", e?.response?.data || e);
			return res
				.status(400)
				.json({ message: "Unable to save card with PayPal." });
		}

		const vaultId = tokenData.id;
		const metaCard = tokenData?.payment_source?.card || {};
		const brand = metaCard.brand || null;
		const last4 = metaCard.last_digits || null;
		const exp = metaCard.expiry || null;

		// 2) De-dup: if same vault_id already saved (or same fingerprint), bail out
		const fingerprint = `${(brand || "").toUpperCase()}-${last4 || ""}-${
			exp || ""
		}`;
		const exists = (hotel.ownerPaymentMethods || []).some(
			(m) =>
				m.vault_id === vaultId ||
				`${(m.card_brand || "").toUpperCase()}-${m.card_last4 || ""}-${
					m.card_exp || ""
				}` === fingerprint
		);
		if (exists) {
			return res
				.status(409)
				.json({ message: "This payment method is already saved." });
		}

		// 3) If caller wants this to be default (or it's the first card), flip defaults off first
		const shouldBeDefault =
			!!setDefault || (hotel.ownerPaymentMethods || []).length === 0;
		if (shouldBeDefault && (hotel.ownerPaymentMethods || []).length > 0) {
			await HotelDetails.updateOne(
				{ _id: hotelId },
				{ $set: { "ownerPaymentMethods.$[].default": false } }
			);
		}

		// 4) Build sanitized payment-method record
		const record = {
			label:
				label ||
				`${brand ? brand.toUpperCase() : "CARD"} •••• ${last4 || "••••"}${
					exp ? ` (${exp})` : ""
				}`,
			vault_id: vaultId,
			vault_status: tokenData.status || "ACTIVE",
			vaulted_at: new Date(tokenData.create_time || Date.now()),
			card_brand: brand,
			card_last4: last4,
			card_exp: exp,
			billing_address: metaCard.billing_address || undefined,
			default: shouldBeDefault,
			active: true,
		};

		const updated = await HotelDetails.findByIdAndUpdate(
			hotelId,
			{ $push: { ownerPaymentMethods: record } },
			{ new: true }
		).lean();

		// return just the safe methods (no secrets anyway)
		const methods = (updated.ownerPaymentMethods || []).map((m) => ({
			label: m.label,
			vault_id: m.vault_id,
			vault_status: m.vault_status,
			vaulted_at: m.vaulted_at,
			card_brand: m.card_brand,
			card_last4: m.card_last4,
			card_exp: m.card_exp,
			billing_address: m.billing_address,
			default: m.default,
			active: m.active,
		}));

		return res.status(201).json({
			ok: true,
			message: "Payment method saved.",
			method: record,
			methods,
		});
	} catch (error) {
		console.error(
			"saveOwnerPaymentMethod error:",
			error?.response?.data || error
		);
		return res
			.status(500)
			.json({ message: "Failed to save owner payment method." });
	}
};

// (nice-to-have) list/manage helpers — optional but handy
exports.getOwnerPaymentMethods = async (req, res) => {
	try {
		const { hotelId } = req.params;
		if (!mongoose.Types.ObjectId.isValid(hotelId)) {
			return res.status(400).json({ message: "Invalid hotelId." });
		}
		const hotel = await HotelDetails.findById(hotelId)
			.select("ownerPaymentMethods belongsTo")
			.lean();
		if (!hotel) return res.status(404).json({ message: "Hotel not found." });

		if (
			req.user &&
			String(hotel.belongsTo) !== String(req.user._id) &&
			String(req.user.role || "").toLowerCase() !== "admin"
		) {
			return res.status(403).json({ message: "Not allowed." });
		}

		return res.json({ methods: hotel.ownerPaymentMethods || [] });
	} catch (e) {
		console.error("getOwnerPaymentMethods error:", e);
		return res.status(500).json({ message: "Failed to fetch methods." });
	}
};

exports.setOwnerDefaultPaymentMethod = async (req, res) => {
	try {
		const { hotelId, vaultId } = req.params;
		if (!mongoose.Types.ObjectId.isValid(hotelId) || !vaultId) {
			return res.status(400).json({ message: "Invalid params." });
		}
		const hotel = await HotelDetails.findById(hotelId)
			.select("belongsTo")
			.lean();
		if (!hotel) return res.status(404).json({ message: "Hotel not found." });

		if (
			req.user &&
			String(hotel.belongsTo) !== String(req.user._id) &&
			String(req.user.role || "").toLowerCase() !== "admin"
		) {
			return res.status(403).json({ message: "Not allowed." });
		}

		await HotelDetails.updateOne(
			{ _id: hotelId },
			{ $set: { "ownerPaymentMethods.$[].default": false } }
		);
		const updated = await HotelDetails.findOneAndUpdate(
			{ _id: hotelId, "ownerPaymentMethods.vault_id": vaultId },
			{ $set: { "ownerPaymentMethods.$.default": true } },
			{ new: true }
		).lean();

		if (!updated) return res.status(404).json({ message: "Method not found." });
		return res.json({
			ok: true,
			message: "Default updated.",
			methods: updated.ownerPaymentMethods,
		});
	} catch (e) {
		console.error("setOwnerDefaultPaymentMethod error:", e);
		return res.status(500).json({ message: "Failed to set default." });
	}
};

exports.removeOwnerPaymentMethod = async (req, res) => {
	try {
		const { hotelId, vaultId } = req.params;
		if (!mongoose.Types.ObjectId.isValid(hotelId) || !vaultId) {
			return res.status(400).json({ message: "Invalid params." });
		}
		const hotel = await HotelDetails.findById(hotelId)
			.select("belongsTo")
			.lean();
		if (!hotel) return res.status(404).json({ message: "Hotel not found." });

		if (
			req.user &&
			String(hotel.belongsTo) !== String(req.user._id) &&
			String(req.user.role || "").toLowerCase() !== "admin"
		) {
			return res.status(403).json({ message: "Not allowed." });
		}

		// Soft delete: active=false (keeps audit & avoids dangling defaults)
		const updated = await HotelDetails.findOneAndUpdate(
			{ _id: hotelId, "ownerPaymentMethods.vault_id": vaultId },
			{
				$set: {
					"ownerPaymentMethods.$.active": false,
					"ownerPaymentMethods.$.default": false,
				},
			},
			{ new: true }
		).lean();

		if (!updated) return res.status(404).json({ message: "Method not found." });
		return res.json({
			ok: true,
			message: "Payment method removed.",
			methods: updated.ownerPaymentMethods,
		});
	} catch (e) {
		console.error("removeOwnerPaymentMethod error:", e);
		return res
			.status(500)
			.json({ message: "Failed to remove payment method." });
	}
};
