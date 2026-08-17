/** @format */

"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");
const Reservations = require("../models/reservations");
const Rooms = require("../models/rooms");
const PaymentReconciliationBatch = require("../models/payment_reconciliation_batch");
const { PAYOUT_PURPOSES } = PaymentReconciliationBatch;
const reconciliationAttachment = require("../services/reconciliationAttachment");
const {
	runClosestReconciliationMatch,
} = require("../services/reconciliationClosestMatchRunner");
const {
	buildExcludePendingOtaReviewFilter,
} = require("../services/otaReservationVisibility");
const {
	addHotelManagementReservationVisibilityToFilter,
} = require("../services/reservationVisibility");
const {
	buildExcludeCancelledReservationsFilter,
} = require("../services/reservationStatus");
const {
	PaidBreakdownDateFilterError,
	buildPaidBreakdownDateFilter,
} = require("../services/paidBreakdownDateFilter");
const {
	attachAdminReservationRoomDetails,
} = require("../services/adminReservationRoomDetails");
const {
	ADMIN_REPORT_FINANCIAL_AMOUNT_PROJECTION,
	resolveAdminReportFinancialAmount,
} = require("../services/adminReportFinancialAmount");
const {
	PAYMENT_BREAKDOWN_KEYS,
	PaymentReconciliationError,
	buildPaymentBreakdownSelectionFilter,
	buildReconciliationStatusFilter,
	effectivePaymentReconciliation,
	effectivelyReconciledExpression,
	normalizePaymentBreakdownKeys,
	normalizeReconciliationStatus,
	paymentAmountCents,
	paymentAmountCentsExpression,
	resolveCompletePricingBreakdownClientTotal,
	summarizeReservationReconciliation,
} = require("../services/paymentReconciliation");

const ObjectId = mongoose.Types.ObjectId;
const MAX_RECONCILIATION_PAGE_SIZE = 500;
const MAX_RECONCILIATION_UPDATE_RESERVATIONS = 500;
const MAX_RECONCILIATION_COMMENT_LENGTH = 1000;
const MAX_CLOSEST_MATCH_CANDIDATES = 5000;
const BATCH_FINALIZATION_ATTEMPTS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const RECONCILIATION_REPORT_SORT = Object.freeze({
	checkin_date: 1,
	checkout_date: 1,
	createdAt: 1,
	_id: 1,
});
const RECONCILIATION_REPORT_ROW_PROJECTION = [
	"_id",
	"__v",
	"updatedAt",
	"createdAt",
	"hotelId",
	"confirmation_number",
	"booking_source",
	"reservation_status",
	"state",
	"customer_details.name",
	"customer_details.fullName",
	"checkin_date",
	"checkout_date",
	"days_of_residence",
	"roomId",
	"room_numbers",
	"roomNumbers",
	"room_number",
	"roomNumber",
	"paid_amount_breakdown",
	ADMIN_REPORT_FINANCIAL_AMOUNT_PROJECTION,
	"+payment_reconciliation",
].join(" ");

const closestMatchCandidateProjection = (paymentBreakdownKey) =>
	[
		"_id",
		"__v",
		"updatedAt",
		"checkin_date",
		"checkout_date",
		"reservation_status",
		"state",
		`paid_amount_breakdown.${paymentBreakdownKey}`,
	].join(" ");

const closestMatchReservationPriority = (status) => {
	const normalized = String(status || "")
		.trim()
		.toLowerCase()
		.replace(/[\s-]+/g, "_");
	if (normalized === "checked_out" || normalized === "checkedout") return 0;
	if (normalized === "in_house" || normalized === "inhouse") return 1;
	if (normalized === "no_show" || normalized === "noshow") return 2;
	if (normalized === "confirmed") return 3;
	return 4;
};

const normalizeId = (value) => {
	const candidate = value?._id || value;
	if (typeof candidate?.toHexString === "function") {
		return candidate.toHexString().trim();
	}
	return String(value?._id || value?.id || value || "").trim();
};

const configuredSuperAdminIds = () =>
	[process.env.SUPER_ADMIN_ID, process.env.REACT_APP_SUPER_ADMIN_ID]
		.flatMap((value) => String(value || "").split(","))
		.map((id) => id.trim())
		.filter(Boolean);

const isConfiguredSuperAdminId = (value) =>
	configuredSuperAdminIds().includes(normalizeId(value));

const assignedHotelIdsFromUser = (user = {}) =>
	[
		user.hotelIdWork,
		...(Array.isArray(user.hotelIdsWork) ? user.hotelIdsWork : []),
		...(Array.isArray(user.hotelsToSupport) ? user.hotelsToSupport : []),
		...(Array.isArray(user.hotelIdsOwner) ? user.hotelIdsOwner : []),
	]
		.map(normalizeId)
		.filter((id, index, all) => id && all.indexOf(id) === index);

const actorCanAccessHotel = (req = {}, hotelId) => {
	const actor = req.profile || {};
	const actorId = normalizeId(req.auth?._id || req.auth?.id || actor._id);
	if (isConfiguredSuperAdminId(actorId)) return true;
	const roleNumbers = [
		Number(actor.role),
		...(Array.isArray(actor.roles) ? actor.roles.map(Number) : []),
	].filter(Number.isFinite);
	if (!roleNumbers.includes(1000)) return true;
	return assignedHotelIdsFromUser(actor).includes(String(hotelId || ""));
};

const escapeRegex = (value) =>
	String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const buildSearchFilter = (searchQuery) => {
	const search = String(searchQuery || "").trim();
	if (!search) return null;
	const regex = new RegExp(escapeRegex(search), "i");
	return {
		$or: [
			{ confirmation_number: regex },
			{ booking_source: regex },
			{ "customer_details.name": regex },
			{ "customer_details.fullName": regex },
			{ "customer_details.phone": regex },
			{ "customer_details.email": regex },
		],
	};
};

const buildReportFilter = ({
	hotelId,
	actor,
	selectedKeys,
	reconciliationStatus = "all",
	searchQuery = "",
	dateBy,
	dateFrom,
	dateTo,
	dateRanges,
}) => {
	const filters = [
		{ hotelId: new ObjectId(hotelId) },
		buildExcludeCancelledReservationsFilter(),
		buildExcludePendingOtaReviewFilter(),
		buildPaymentBreakdownSelectionFilter(selectedKeys),
	];
	const dateFilter = buildPaidBreakdownDateFilter({
		dateBy,
		dateFrom,
		dateTo,
		dateRanges,
	});
	if (dateFilter) filters.push(dateFilter);
	const searchFilter = buildSearchFilter(searchQuery);
	if (searchFilter) filters.push(searchFilter);
	const statusFilter = buildReconciliationStatusFilter(
		selectedKeys,
		reconciliationStatus
	);
	if (statusFilter) filters.push(statusFilter);
	const filter = { $and: filters };
	addHotelManagementReservationVisibilityToFilter(filter, actor);
	return filter;
};

const parsePagination = (query = {}) => {
	const page = Math.max(Number.parseInt(query.page, 10) || 1, 1);
	const limit = Math.min(
		Math.max(Number.parseInt(query.limit, 10) || 200, 1),
		MAX_RECONCILIATION_PAGE_SIZE
	);
	return { page, limit, skip: (page - 1) * limit };
};

const attachRoomDetails = async (reservations = []) => {
	try {
		return await attachAdminReservationRoomDetails(reservations, (roomIds) =>
			Rooms.find({ _id: { $in: roomIds } })
				.select("_id hotelId room_number room_type display_name")
				.lean()
				.exec()
		);
	} catch (error) {
		console.error(
			"[RECONCILIATION REPORT] Room details enrichment failed:",
			error?.message || error
		);
		return (Array.isArray(reservations) ? reservations : []).map((reservation) => ({
			...reservation,
			roomDetails: [],
		}));
	}
};

const reservationNights = (reservation = {}) => {
	const checkin = new Date(reservation.checkin_date);
	const checkout = new Date(reservation.checkout_date);
	if (
		Number.isFinite(checkin.getTime()) &&
		Number.isFinite(checkout.getTime()) &&
		checkout > checkin
	) {
		return Math.max(Math.round((checkout - checkin) / DAY_MS), 1);
	}
	const stored = Number(reservation.days_of_residence);
	return Number.isFinite(stored) && stored > 0 ? stored : 0;
};

const responseReconciliationBreakdown = (
	byBreakdown = {},
	storedBreakdown = {}
) =>
	Object.fromEntries(
		Object.entries(byBreakdown).map(([key, entry = {}]) => [
			key,
			{
				amount: entry.amount,
				amountCents: entry.amountCents,
				status: entry.status,
				reconciled: entry.reconciled === true,
				stale: entry.stale === true,
				hasStoredEntry: Object.prototype.hasOwnProperty.call(
					storedBreakdown && typeof storedBreakdown === "object"
						? storedBreakdown
						: {},
					key
				),
			},
		])
	);

const responsePaidBreakdown = (breakdown = {}) =>
	Object.fromEntries(
		PAYMENT_BREAKDOWN_KEYS.map((key) => [key, breakdown?.[key] ?? 0])
	);

const reportRow = (reservation = {}, selectedKeys = PAYMENT_BREAKDOWN_KEYS) => {
	const reconciliation = summarizeReservationReconciliation(
		reservation,
		selectedKeys
	);
	const allCategoryReconciliation = summarizeReservationReconciliation(
		reservation,
		PAYMENT_BREAKDOWN_KEYS
	);
	const otaTotal = resolveAdminReportFinancialAmount(reservation, "gross");
	const otaTotalAvailable =
		otaTotal.available === true && otaTotal.currency === "SAR";
	const pricingBreakdown = resolveCompletePricingBreakdownClientTotal(reservation);
	return {
		_id: reservation._id,
		__v: reservation.__v,
		updatedAt: reservation.updatedAt,
		createdAt: reservation.createdAt,
		hotelId: reservation.hotelId,
		customer_details: {
			name: String(
				reservation?.customer_details?.name ||
					reservation?.customer_details?.fullName ||
					""
			),
			fullName: String(
				reservation?.customer_details?.fullName ||
					reservation?.customer_details?.name ||
					""
			),
		},
		confirmation_number: reservation.confirmation_number,
		booking_source: reservation.booking_source,
		reservation_status: reservation.reservation_status,
		state: reservation.state,
		checkin_date: reservation.checkin_date,
		checkout_date: reservation.checkout_date,
		nights: reservationNights(reservation),
		roomDetails: Array.isArray(reservation.roomDetails)
			? reservation.roomDetails
			: [],
		room_numbers: reservation.room_numbers,
		roomNumbers: reservation.roomNumbers,
		room_number: reservation.room_number,
		roomNumber: reservation.roomNumber,
		paid_amount_breakdown: responsePaidBreakdown(
			reservation.paid_amount_breakdown
		),
		selected_breakdown_total: reconciliation.totalAmount,
		selected_breakdown_total_cents: reconciliation.totalAmountCents,
		reconciliation_status: reconciliation.reconciliationStatus,
		reconciliation_by_breakdown: responseReconciliationBreakdown(
			allCategoryReconciliation.byBreakdown,
			reservation?.payment_reconciliation?.breakdown
		),
		selected_positive_payment_breakdown_keys:
			reconciliation.selectedPositiveKeys,
		ota_total_amount: otaTotalAvailable ? otaTotal.amount : null,
		ota_total_amount_cents: otaTotalAvailable ? otaTotal.amountCents : null,
		ota_total_available: otaTotalAvailable,
		ota_total_currency: otaTotalAvailable ? otaTotal.currency : "",
		ota_total_source: otaTotal.sourceMode || "",
		ota_total_reason: otaTotalAvailable ? "" : otaTotal.reason || "unavailable",
		pricing_breakdown_client_total: pricingBreakdown.amount,
		pricing_breakdown_client_total_cents: pricingBreakdown.amountCents,
		pricing_breakdown_client_total_available: pricingBreakdown.available,
		pricing_breakdown_client_total_currency: pricingBreakdown.currency,
		pricing_breakdown_client_total_source: pricingBreakdown.source,
		pricing_breakdown_client_total_reason: pricingBreakdown.reason,
	};
};

const buildScorecardPipeline = (filter, selectedKeys) => {
	const totalCents = {
		$add: selectedKeys.map(paymentAmountCentsExpression),
	};
	const reconciledCents = {
		$add: selectedKeys.map((key) => ({
			$cond: [
				effectivelyReconciledExpression(key),
				paymentAmountCentsExpression(key),
				0,
			],
		})),
	};
	const anyPositive = {
		$or: selectedKeys.map((key) => ({
			$gt: [paymentAmountCentsExpression(key), 0],
		})),
	};
	const anyReconciled = {
		$or: selectedKeys.map(effectivelyReconciledExpression),
	};
	const anyWaiting = {
		$or: selectedKeys.map((key) => ({
			$and: [
				{ $gt: [paymentAmountCentsExpression(key), 0] },
				{ $not: [effectivelyReconciledExpression(key)] },
			],
		})),
	};
	return [
		{ $match: filter },
		{
			$project: {
				totalCents,
				reconciledCents,
				hasPositive: anyPositive,
				rowReconciled: anyReconciled,
				rowWaiting: anyWaiting,
			},
		},
		{
			$group: {
				_id: null,
				totalAmountCents: { $sum: "$totalCents" },
				reconciledAmountCents: { $sum: "$reconciledCents" },
				reservationsCount: {
					$sum: { $cond: ["$hasPositive", 1, 0] },
				},
				reconciledReservationsCount: {
					$sum: { $cond: ["$rowReconciled", 1, 0] },
				},
				waitingReservationsCount: {
					$sum: { $cond: ["$rowWaiting", 1, 0] },
				},
			},
		},
	];
};

const scorecardsFromAggregate = (result = {}) => {
	const safeInteger = (value) => {
		const parsed = Number(value);
		return Number.isSafeInteger(Math.round(parsed)) ? Math.round(parsed) : 0;
	};
	const totalAmountCents = safeInteger(result.totalAmountCents);
	const reconciledAmountCents = Math.min(
		Math.max(safeInteger(result.reconciledAmountCents), 0),
		Math.max(totalAmountCents, 0)
	);
	const waitingAmountCents = Math.max(
		totalAmountCents - reconciledAmountCents,
		0
	);
	const reservationsCount = Math.max(safeInteger(result.reservationsCount), 0);
	const reconciledReservationsCount = Math.min(
		Math.max(safeInteger(result.reconciledReservationsCount), 0),
		reservationsCount
	);
	const waitingReservationsCount = Math.min(
		Math.max(safeInteger(result.waitingReservationsCount), 0),
		reservationsCount
	);
	return {
		currency: "SAR",
		totalAmount: totalAmountCents / 100,
		totalAmountCents,
		reconciledAmount: reconciledAmountCents / 100,
		reconciledAmountCents,
		waitingAmount: waitingAmountCents / 100,
		waitingAmountCents,
		reservationsCount,
		reconciledReservationsCount,
		waitingReservationsCount,
	};
};

exports.reconciliationReport = async (req, res) => {
	try {
		const hotelId = String(req.query?.hotelId || "").trim();
		if (!hotelId || !ObjectId.isValid(hotelId)) {
			return res.status(400).json({
				code: "invalid_hotel_id",
				error: "Valid hotelId is required",
			});
		}
		if (!actorCanAccessHotel(req, hotelId)) {
			return res.status(403).json({
				code: "reconciliation_hotel_access_denied",
				error: "Reconciliation report access denied for this hotel",
			});
		}

		const keyQuery =
			req.query?.paymentBreakdownKeys ??
			req.query?.["paymentBreakdownKeys[]"];
		const selectedKeys = normalizePaymentBreakdownKeys(keyQuery, {
			defaultKeys: PAYMENT_BREAKDOWN_KEYS,
		});
		const reconciliationStatus = normalizeReconciliationStatus(
			req.query?.reconciliationStatus
		);
		const includeScorecards =
			String(req.query?.includeScorecards || "")
				.trim()
				.toLowerCase() !== "false";
		const { page, limit, skip } = parsePagination(req.query);
		const dateOptions = {
			dateBy: req.query?.dateBy,
			dateFrom: req.query?.dateFrom,
			dateTo: req.query?.dateTo,
			dateRanges: req.query?.dateRanges,
		};
		const scorecardFilter = buildReportFilter({
			hotelId,
			actor: req.profile,
			selectedKeys,
			...dateOptions,
		});
		const rowFilter = buildReportFilter({
			hotelId,
			actor: req.profile,
			selectedKeys,
			reconciliationStatus,
			searchQuery: req.query?.searchQuery,
			...dateOptions,
		});

		const [totalDocuments, reservations, scorecardResults] =
			await Promise.all([
				Reservations.countDocuments(rowFilter),
				Reservations.find(rowFilter)
					.select(RECONCILIATION_REPORT_ROW_PROJECTION)
					.sort(RECONCILIATION_REPORT_SORT)
					.skip(skip)
					.limit(limit)
					.populate("hotelId", "hotelName")
					.lean(),
				includeScorecards
					? Reservations.aggregate(
							buildScorecardPipeline(scorecardFilter, selectedKeys)
					  )
					: Promise.resolve([]),
			]);
		const reservationsWithRooms = await attachRoomDetails(reservations);
		const data = reservationsWithRooms.map((reservation) =>
			reportRow(reservation, selectedKeys)
		);
		const scorecards = includeScorecards
			? scorecardsFromAggregate(scorecardResults?.[0] || {})
			: null;

		return res.json({
			data,
			totalDocuments,
			page,
			limit,
			selectedPaymentBreakdownKeys: selectedKeys,
			reconciliationStatus,
			scorecards,
		});
	} catch (error) {
		if (
			error instanceof PaymentReconciliationError ||
			error instanceof PaidBreakdownDateFilterError
		) {
			return res.status(error.statusCode || 400).json({
				code: error.code || "invalid_reconciliation_report_filter",
				error: error.message,
			});
		}
		console.error("Error in reconciliationReport:", error);
		return res.status(500).json({
			code: "reconciliation_report_failed",
			error: "Could not load the reconciliation report",
		});
	}
};

const plainObject = (value) =>
	value && typeof value === "object" && !Array.isArray(value) ? value : null;

const mutationBody = (req = {}) => {
	const body = plainObject(req.body);
	if (!body) {
		throw new PaymentReconciliationError(
			"A request body is required",
			"reconciliation_body_required"
		);
	}
	if (typeof body.payload !== "string") return body;
	let parsed;
	try {
		parsed = JSON.parse(body.payload);
	} catch (_error) {
		throw new PaymentReconciliationError(
			"The reconciliation multipart payload must be valid JSON",
			"invalid_reconciliation_payload"
		);
	}
	if (!plainObject(parsed)) {
		throw new PaymentReconciliationError(
			"The reconciliation multipart payload must be a JSON object",
			"invalid_reconciliation_payload"
		);
	}
	return parsed;
};

const parseSnapshot = (value, selectedKeys, seenIds) => {
	const snapshot = plainObject(value);
	if (!snapshot) {
		throw new PaymentReconciliationError(
			"Each reservations item must be an object",
			"invalid_reservation_snapshot"
		);
	}
	const reservationId = normalizeId(
		snapshot.reservationId || snapshot._id
	).toLowerCase();
	if (!ObjectId.isValid(reservationId)) {
		throw new PaymentReconciliationError(
			"Each reservationId must be a valid Mongo ObjectId",
			"invalid_reservation_id"
		);
	}
	if (seenIds.has(reservationId)) {
		throw new PaymentReconciliationError(
			`Duplicate reservationId: ${reservationId}`,
			"duplicate_reservation_id"
		);
	}
	seenIds.add(reservationId);

	const version = snapshot.__v ?? snapshot.version;
	if (!Number.isSafeInteger(version) || version < 0) {
		throw new PaymentReconciliationError(
			`Reservation ${reservationId} requires a non-negative integer __v`,
			"invalid_reservation_version"
		);
	}
	const updatedAt = new Date(snapshot.updatedAt);
	if (!snapshot.updatedAt || !Number.isFinite(updatedAt.getTime())) {
		throw new PaymentReconciliationError(
			`Reservation ${reservationId} requires a valid updatedAt snapshot`,
			"invalid_reservation_updated_at"
		);
	}

	const displayedAmountsCents = plainObject(snapshot.displayedAmountsCents);
	if (!displayedAmountsCents) {
		throw new PaymentReconciliationError(
			`Reservation ${reservationId} requires displayedAmountsCents`,
			"displayed_amounts_required"
		);
	}
	const suppliedKeys = Object.keys(displayedAmountsCents);
	if (
		suppliedKeys.length !== selectedKeys.length ||
		suppliedKeys.some((key) => !selectedKeys.includes(key))
	) {
		throw new PaymentReconciliationError(
			`Reservation ${reservationId} must snapshot exactly the selected payment categories`,
			"displayed_amount_keys_mismatch"
		);
	}
	for (const key of selectedKeys) {
		const cents = displayedAmountsCents[key];
		if (!Number.isSafeInteger(cents) || cents < 0) {
			throw new PaymentReconciliationError(
				`Reservation ${reservationId} has an invalid displayed cent amount for ${key}`,
				"invalid_displayed_amount_cents"
			);
		}
	}

	return {
		reservationId,
		version,
		updatedAt,
		displayedAmountsCents: { ...displayedAmountsCents },
	};
};

const validateMutationRequest = (req = {}) => {
	const body = mutationBody(req);
	if (Object.prototype.hasOwnProperty.call(body, "attachment")) {
		throw new PaymentReconciliationError(
			"Attachments must be sent as the multipart attachment file field",
			"untrusted_reconciliation_attachment"
		);
	}
	const hotelId = String(body.hotelId || "").trim();
	if (!ObjectId.isValid(hotelId)) {
		throw new PaymentReconciliationError(
			"Valid hotelId is required",
			"invalid_hotel_id"
		);
	}
	const selectedKeys = normalizePaymentBreakdownKeys(
		body.paymentBreakdownKeys,
		{ defaultKeys: [], required: true }
	);
	const requestedAction = String(body.action || "")
		.trim()
		.toLowerCase();
	const legacyStatus = body.status
		? normalizeReconciliationStatus(body.status, { allowAll: false })
		: "";
	const action =
		requestedAction ||
		(legacyStatus === "reconciled"
			? "reconcile"
			: legacyStatus === "waiting"
			? "reset"
			: "");
	if (!["reconcile", "reset"].includes(action)) {
		throw new PaymentReconciliationError(
			"action must be reconcile or reset",
			"invalid_reconciliation_action"
		);
	}
	if (
		requestedAction &&
		legacyStatus &&
		((requestedAction === "reconcile" && legacyStatus !== "reconciled") ||
			(requestedAction === "reset" && legacyStatus !== "waiting"))
	) {
		throw new PaymentReconciliationError(
			"action and status must describe the same reconciliation change",
			"reconciliation_action_status_mismatch"
		);
	}
	if (!Array.isArray(body.reservations) || !body.reservations.length) {
		throw new PaymentReconciliationError(
			"At least one reservation snapshot is required",
			"reservation_snapshots_required"
		);
	}
	if (body.reservations.length > MAX_RECONCILIATION_UPDATE_RESERVATIONS) {
		throw new PaymentReconciliationError(
			`No more than ${MAX_RECONCILIATION_UPDATE_RESERVATIONS} reservations can be updated at once`,
			"reconciliation_batch_too_large",
			413
		);
	}
	const suppliedComment = body.comment ?? body.note;
	if (suppliedComment !== undefined && typeof suppliedComment !== "string") {
		throw new PaymentReconciliationError(
			"comment must be text",
			"invalid_reconciliation_comment"
		);
	}
	const comment = String(suppliedComment || "").trim();
	if (comment.length > MAX_RECONCILIATION_COMMENT_LENGTH) {
		throw new PaymentReconciliationError(
			`comment cannot exceed ${MAX_RECONCILIATION_COMMENT_LENGTH} characters`,
			"reconciliation_comment_too_long"
		);
	}
	const payoutPurpose = String(body.payoutPurpose || "").trim();
	if (action === "reconcile" && !PAYOUT_PURPOSES.includes(payoutPurpose)) {
		throw new PaymentReconciliationError(
			"A valid payoutPurpose is required when reconciling",
			"invalid_reconciliation_payout_purpose"
		);
	}
	if (action === "reset" && payoutPurpose) {
		throw new PaymentReconciliationError(
			"payoutPurpose is not accepted when resetting reconciliation",
			"reset_payout_purpose_not_allowed"
		);
	}
	if (action === "reset" && req.file) {
		throw new PaymentReconciliationError(
			"An attachment is not accepted when resetting reconciliation",
			"reset_attachment_not_allowed"
		);
	}
	const expectedActionAmountCents = body.expectedActionAmountCents;
	if (
		!Number.isSafeInteger(expectedActionAmountCents) ||
		expectedActionAmountCents < 0
	) {
		throw new PaymentReconciliationError(
			"expectedActionAmountCents must be a non-negative safe integer",
			"invalid_expected_action_amount_cents"
		);
	}
	const seenIds = new Set();
	const snapshots = body.reservations.map((snapshot) =>
		parseSnapshot(snapshot, selectedKeys, seenIds)
	);
	return {
		hotelId,
		selectedKeys,
		action,
		status: action === "reconcile" ? "reconciled" : "waiting",
		snapshots,
		comment,
		payoutPurpose,
		expectedActionAmountCents,
	};
};

const authenticatedMutationActor = (req = {}) => {
	const actorId = normalizeId(req.auth?._id || req.auth?.id);
	if (!configuredSuperAdminIds().length) {
		return {
			allowed: false,
			statusCode: 503,
			code: "reconciliation_super_admin_not_configured",
			message: "Reconciliation updates are disabled because no super admin is configured.",
		};
	}
	if (!actorId || !isConfiguredSuperAdminId(actorId)) {
		return {
			allowed: false,
			statusCode: 403,
			code: "reconciliation_super_admin_required",
			message: "Only a configured super admin can update reconciliation status.",
		};
	}
	if (
		!req.profile ||
		normalizeId(req.profile._id) !== actorId ||
		req.profile.activeUser === false
	) {
		return {
			allowed: false,
			statusCode: 403,
			code: "reconciliation_super_admin_inactive",
			message: "The configured super-admin account is not active.",
		};
	}
	return {
		allowed: true,
		actor: {
			_id: new ObjectId(actorId),
			name: String(req.profile.name || req.profile.email || "Super Admin").slice(
				0,
				160
			),
			role: "super_admin",
		},
	};
};

exports.requireConfiguredReconciliationSuperAdmin = (req, res, next) => {
	const authorization = authenticatedMutationActor(req);
	if (!authorization.allowed) {
		return res.status(authorization.statusCode).json({
			code: authorization.code,
			error: authorization.message,
		});
	}
	req.reconciliationMutationActor = authorization.actor;
	return next();
};

const dateMillis = (value) => {
	const parsed = new Date(value);
	return Number.isFinite(parsed.getTime()) ? parsed.getTime() : null;
};

const comparableBatchItem = (item = {}) => ({
	reservationId: normalizeId(item.reservationId),
	paymentBreakdownKey: String(item.paymentBreakdownKey || ""),
	amountCents: Number(item.amountCents),
	from: String(item.from || ""),
	to: String(item.to || ""),
});

const finalizedBatchMatches = (batch, intended) => {
	if (!batch || typeof batch !== "object") return false;
	for (const field of [
		"status",
		"appliedAmountCents",
		"appliedReservationCount",
		"appliedItemCount",
	]) {
		if (batch[field] !== intended[field]) return false;
	}
	const persistedItems = Array.isArray(batch.appliedItems)
		? batch.appliedItems.map(comparableBatchItem)
		: [];
	const intendedItems = Array.isArray(intended.appliedItems)
		? intended.appliedItems.map(comparableBatchItem)
		: [];
	return JSON.stringify(persistedItems) === JSON.stringify(intendedItems);
};

const finalizePaymentReconciliationBatch = async (batchId, intended) => {
	let lastError = null;
	for (
		let attempt = 0;
		attempt < BATCH_FINALIZATION_ATTEMPTS;
		attempt += 1
	) {
		try {
			const result = await PaymentReconciliationBatch.updateOne(
				{ batchId, status: "applying" },
				{ $set: intended }
			);
			const matched = Number(result?.matchedCount ?? result?.n ?? 0);
			if (matched === 1) return;
			lastError = new Error(
				"Reconciliation batch was not in the applying state"
			);
		} catch (error) {
			lastError = error;
		}

		try {
			const persisted = await PaymentReconciliationBatch.findOne({ batchId })
				.select(
					"status appliedAmountCents appliedReservationCount appliedItemCount appliedItems"
				)
				.lean();
			if (finalizedBatchMatches(persisted, intended)) return;
		} catch (error) {
			lastError = error;
		}
	}
	const error = new Error(
		`Could not confirm reconciliation batch finalization after ${BATCH_FINALIZATION_ATTEMPTS} attempts`
	);
	error.cause = lastError;
	throw error;
};

const rawReconciliationEntry = (reservation = {}, key) => {
	const entry = reservation?.payment_reconciliation?.breakdown?.[key];
	return entry && typeof entry === "object" && !Array.isArray(entry)
		? entry
		: null;
};

const reconciliationKeysNeedingAction = (reservation, selectedKeys, action) =>
	selectedKeys.filter((key) => {
		if (action === "reset") return Boolean(rawReconciliationEntry(reservation, key));
		const effective = effectivePaymentReconciliation(reservation, key);
		return effective.positive && !effective.reconciled;
	});

const buildSnapshotUpdateFilter = (
	reservation,
	hotelId,
	selectedKeys,
	positiveKeys,
	actor
) => {
	const filter = {
		_id: reservation._id,
		hotelId: new ObjectId(hotelId),
		__v: Number.isSafeInteger(reservation.__v) ? reservation.__v : 0,
		updatedAt: reservation.updatedAt,
		...buildExcludeCancelledReservationsFilter(),
		...buildExcludePendingOtaReviewFilter(),
	};
	for (const key of selectedKeys) {
		const path = `paid_amount_breakdown.${key}`;
		if (
			reservation.paid_amount_breakdown &&
			Object.prototype.hasOwnProperty.call(
				reservation.paid_amount_breakdown,
				key
			)
		) {
			filter[path] = { $eq: reservation.paid_amount_breakdown[key] };
		} else {
			filter[path] = { $exists: false };
		}
	}
	if (positiveKeys.length) {
		filter.$expr = {
			$and: positiveKeys.map((key) => ({
				$gt: [paymentAmountCentsExpression(key), 0],
			})),
		};
	}
	addHotelManagementReservationVisibilityToFilter(filter, actor);
	return filter;
};

const buildReconciliationUpdate = ({
	reservation,
	changedKeys,
	action,
	actor,
	batchId,
	now,
}) => {
	const set = {
		"payment_reconciliation.lastUpdatedAt": now,
		"payment_reconciliation.lastUpdatedBy": actor,
		"payment_reconciliation.lastBatchId": batchId,
		updatedAt: now,
	};
	const unset = {};
	const previous = {};
	for (const key of changedKeys) {
		const current = effectivePaymentReconciliation(reservation, key);
		const rawEntry = rawReconciliationEntry(reservation, key);
		previous[key] = String(rawEntry?.status || current.status || "waiting");
		if (action === "reset") {
			unset[`payment_reconciliation.breakdown.${key}`] = 1;
		} else {
			set[`payment_reconciliation.breakdown.${key}`] = {
				status: "reconciled",
				amountCents: current.amountCents,
				reconciledAt: now,
				reconciledBy: actor,
				updatedAt: now,
				updatedBy: actor,
				batchId,
			};
		}
	}
	const audit = {
		at: now,
		by: actor,
		field: "payment_reconciliation",
		from: previous,
		to: Object.fromEntries(
			changedKeys.map((key) => [
				key,
				action === "reset" ? "default" : "reconciled",
			])
		),
		paymentBreakdownKeys: changedKeys,
		batchId,
		action,
	};
	return {
		$set: set,
		...(Object.keys(unset).length ? { $unset: unset } : {}),
		$inc: { __v: 1 },
		$push: {
			adminChangeLog: audit,
			reservationAuditLog: {
				...audit,
				type: "payment_reconciliation_status_update",
			},
		},
	};
};

exports.updateReconciliationStatus = async (req, res) => {
	const authorization = authenticatedMutationActor(req);
	if (!authorization.allowed) {
		return res.status(authorization.statusCode).json({
			code: authorization.code,
			error: authorization.message,
		});
	}

	try {
		const {
			hotelId,
			selectedKeys,
			action,
			status,
			snapshots,
			comment,
			payoutPurpose,
			expectedActionAmountCents,
		} = validateMutationRequest(req);
		if (req.file) {
			reconciliationAttachment.validateReconciliationAttachment(req.file);
		}
		const ids = snapshots.map((snapshot) => new ObjectId(snapshot.reservationId));
		const mutationScopeFilter = {
			_id: { $in: ids },
			hotelId: new ObjectId(hotelId),
			...buildExcludeCancelledReservationsFilter(),
			...buildExcludePendingOtaReviewFilter(),
		};
		addHotelManagementReservationVisibilityToFilter(
			mutationScopeFilter,
			req.profile
		);
		const reservations = await Reservations.find(mutationScopeFilter)
			.select(
				"_id hotelId __v updatedAt paid_amount_breakdown +payment_reconciliation"
			)
			.lean();
		const byId = new Map(
			reservations.map((reservation) => [normalizeId(reservation._id), reservation])
		);
		const conflicts = [];
		const unchanged = [];
		const skipped = [];
		const pendingUpdates = [];
		let plannedActionAmountCents = 0;

		for (const snapshot of snapshots) {
			const reservation = byId.get(snapshot.reservationId);
			if (!reservation) {
				conflicts.push({
					reservationId: snapshot.reservationId,
					code: "reservation_not_found_or_hotel_mismatch",
				});
				continue;
			}
			const amountMismatch = selectedKeys.find(
				(key) =>
					paymentAmountCents(reservation, key) !==
					snapshot.displayedAmountsCents[key]
			);
			if (amountMismatch) {
				conflicts.push({
					reservationId: snapshot.reservationId,
					code: "displayed_amount_changed",
					paymentBreakdownKey: amountMismatch,
				});
				continue;
			}
			const changedKeys = reconciliationKeysNeedingAction(
				reservation,
				selectedKeys,
				action
			);
			if (action === "reconcile" && !changedKeys.length) {
				const hasPositive = selectedKeys.some(
					(key) => paymentAmountCents(reservation, key) > 0
				);
				if (hasPositive) {
					unchanged.push(snapshot.reservationId);
					continue;
				}
				skipped.push({
					reservationId: snapshot.reservationId,
					code: "no_positive_selected_amount",
				});
				continue;
			}
			if (!changedKeys.length) {
				unchanged.push(snapshot.reservationId);
				continue;
			}
			const version = Number.isSafeInteger(reservation.__v)
				? reservation.__v
				: 0;
			if (
				version !== snapshot.version ||
				dateMillis(reservation.updatedAt) !== snapshot.updatedAt.getTime()
			) {
				conflicts.push({
					reservationId: snapshot.reservationId,
					code: "reservation_snapshot_changed",
				});
				continue;
			}
			const items = changedKeys.map((key) => {
				const effective = effectivePaymentReconciliation(reservation, key);
				const rawEntry = rawReconciliationEntry(reservation, key);
				return {
					reservationId: new ObjectId(snapshot.reservationId),
					paymentBreakdownKey: key,
					amountCents: effective.amountCents,
					from: String(rawEntry?.status || effective.status || "waiting"),
					to: action === "reset" ? "default" : "reconciled",
				};
			});
			for (const item of items) {
				const nextAmount = plannedActionAmountCents + item.amountCents;
				if (!Number.isSafeInteger(nextAmount)) {
					throw new PaymentReconciliationError(
						"The reconciliation amount is outside the supported range",
						"reconciliation_amount_out_of_range"
					);
				}
				plannedActionAmountCents = nextAmount;
			}
			pendingUpdates.push({
				reservation,
				changedKeys,
				positiveKeys: action === "reconcile" ? changedKeys : [],
				items,
			});
		}

		// Known stale rows abort before any write. A race that occurs after this
		// preflight is still reported explicitly below with the successfully
		// updated ids, so partial success can never be mistaken for full success.
		if (conflicts.length) {
			return res.status(409).json({
				success: false,
				code: "reconciliation_conflict",
				updatedCount: 0,
				updated: [],
				unchanged,
				skipped,
				conflictCount: conflicts.length,
				conflicts,
			});
		}
		if (plannedActionAmountCents !== expectedActionAmountCents) {
			return res.status(409).json({
				success: false,
				code: "reconciliation_confirmed_amount_changed",
				expectedActionAmountCents,
				serverActionAmountCents: plannedActionAmountCents,
				updatedCount: 0,
				updated: [],
				unchanged,
				skipped,
				conflictCount: 0,
				conflicts: [],
			});
		}
		if (!pendingUpdates.length) {
			return res.json({
				success: true,
				code: "reconciliation_unchanged",
				batchId: "",
				action,
				status,
				paymentBreakdownKeys: selectedKeys,
				plannedActionAmountCents: 0,
				appliedActionAmountCents: 0,
				updatedCount: 0,
				updated: [],
				unchanged,
				skipped,
				conflictCount: 0,
				conflicts: [],
			});
		}

		const now = new Date();
		const batchId = crypto.randomUUID();
		let attachment = null;
		if (req.file) {
			attachment = await reconciliationAttachment.uploadReconciliationAttachment(
				req.file
			);
		}
		const plannedItems = pendingUpdates.flatMap((pending) => pending.items);
		try {
			await PaymentReconciliationBatch.create({
				batchId,
				hotelId: new ObjectId(hotelId),
				action,
				paymentBreakdownKeys: selectedKeys,
				payoutPurpose: action === "reconcile" ? payoutPurpose : "",
				comment,
				attachment,
				plannedAmountCents: plannedActionAmountCents,
				appliedAmountCents: 0,
				plannedReservationCount: pendingUpdates.length,
				appliedReservationCount: 0,
				plannedItemCount: plannedItems.length,
				appliedItemCount: 0,
				plannedItems,
				appliedItems: [],
				status: "applying",
				actor: authorization.actor,
				startedAt: now,
			});
		} catch (error) {
			if (attachment) {
				await reconciliationAttachment.removeReconciliationAttachment(attachment);
			}
			throw error;
		}
		const updated = [];
		const appliedItems = [];
		for (const pending of pendingUpdates) {
			try {
				const result = await Reservations.updateOne(
					buildSnapshotUpdateFilter(
						pending.reservation,
						hotelId,
						selectedKeys,
						pending.positiveKeys,
						req.profile
					),
					buildReconciliationUpdate({
						reservation: pending.reservation,
						changedKeys: pending.changedKeys,
						action,
						actor: authorization.actor,
						batchId,
						now,
					}),
					{ timestamps: false }
				);
				const matched = Number(result?.matchedCount ?? result?.n ?? 0);
				if (matched === 1) {
					updated.push(normalizeId(pending.reservation._id));
					appliedItems.push(...pending.items);
				} else {
					conflicts.push({
						reservationId: normalizeId(pending.reservation._id),
						code: "reservation_snapshot_changed",
					});
				}
			} catch (_error) {
				conflicts.push({
					reservationId: normalizeId(pending.reservation._id),
					code: "reconciliation_update_failed",
				});
			}
		}
		const appliedActionAmountCents = appliedItems.reduce(
			(sum, item) => sum + item.amountCents,
			0
		);
		const batchStatus = conflicts.length
			? updated.length
				? "partial"
				: "failed"
			: "complete";
		const finalBatchState = {
			status: batchStatus,
			appliedAmountCents: appliedActionAmountCents,
			appliedReservationCount: updated.length,
			appliedItemCount: appliedItems.length,
			appliedItems,
			completedAt: new Date(),
		};
		try {
			await finalizePaymentReconciliationBatch(batchId, finalBatchState);
		} catch (error) {
			console.error("Error finalizing reconciliation batch:", error);
			return res.status(500).json({
				success: false,
				code: "reconciliation_batch_finalize_failed",
				batchId,
				action,
				status,
				plannedActionAmountCents,
				appliedActionAmountCents,
				updatedCount: updated.length,
				updated,
				conflictCount: conflicts.length,
				conflicts,
			});
		}

		const statusCode = conflicts.length ? 409 : 200;
		return res.status(statusCode).json({
			success: conflicts.length === 0,
			code: conflicts.length ? "reconciliation_conflict" : "reconciliation_updated",
			batchId,
			action,
			status,
			paymentBreakdownKeys: selectedKeys,
			plannedActionAmountCents,
			appliedActionAmountCents,
			updatedCount: updated.length,
			updated,
			unchanged,
			skipped,
			conflictCount: conflicts.length,
			conflicts,
			updatedAt: now.toISOString(),
		});
	} catch (error) {
		if (
			error instanceof PaymentReconciliationError ||
			error instanceof reconciliationAttachment.ReconciliationAttachmentError
		) {
			return res.status(error.statusCode).json({
				code: error.code,
				error: error.message,
			});
		}
		console.error("Error in updateReconciliationStatus:", error);
		return res.status(500).json({
			code: "reconciliation_update_failed",
			error: "Could not update reconciliation status",
		});
	}
};

exports.closestReconciliationMatch = async (req, res) => {
	const authorization = authenticatedMutationActor(req);
	if (!authorization.allowed) {
		return res.status(authorization.statusCode).json({
			code: authorization.code,
			error: authorization.message,
		});
	}

	try {
		const body = plainObject(req.body);
		if (!body) {
			throw new PaymentReconciliationError(
				"A JSON request body is required",
				"reconciliation_body_required"
			);
		}
		const hotelId = String(body.hotelId || "").trim();
		if (!ObjectId.isValid(hotelId)) {
			throw new PaymentReconciliationError(
				"Valid hotelId is required",
				"invalid_hotel_id"
			);
		}
		if (!actorCanAccessHotel(req, hotelId)) {
			return res.status(403).json({
				code: "reconciliation_hotel_access_denied",
				error: "Reconciliation report access denied for this hotel",
			});
		}
		const selectedKeys = normalizePaymentBreakdownKeys(
			body.paymentBreakdownKey,
			{ defaultKeys: [], required: true }
		);
		if (selectedKeys.length !== 1) {
			throw new PaymentReconciliationError(
				"Exactly one paymentBreakdownKey is required",
				"closest_match_single_payment_key_required"
			);
		}
		const paymentBreakdownKey = selectedKeys[0];
		const targetAmountCents = body.targetAmountCents;
		if (!Number.isSafeInteger(targetAmountCents) || targetAmountCents <= 0) {
			throw new PaymentReconciliationError(
				"targetAmountCents must be a positive safe integer",
				"invalid_closest_match_target_cents"
			);
		}
		const filter = buildReportFilter({
			hotelId,
			actor: req.profile,
			selectedKeys,
			reconciliationStatus: "waiting",
			searchQuery: body.searchQuery,
			dateBy: body.dateBy,
			dateFrom: body.dateFrom,
			dateTo: body.dateTo,
			dateRanges:
				Array.isArray(body.dateRanges) && body.dateRanges.length === 0
					? undefined
					: body.dateRanges,
		});
		const candidatesRows = await Reservations.find(filter)
			.select(closestMatchCandidateProjection(paymentBreakdownKey))
			.sort(RECONCILIATION_REPORT_SORT)
			.limit(MAX_CLOSEST_MATCH_CANDIDATES + 1)
			.lean();
		if (candidatesRows.length > MAX_CLOSEST_MATCH_CANDIDATES) {
			return res.status(422).json({
				code: "closest_match_candidate_limit_exceeded",
				error:
					"More than 5,000 reservations match this range. Narrow the filters before finding a closest match.",
				candidateLimit: MAX_CLOSEST_MATCH_CANDIDATES,
			});
		}
		const candidates = candidatesRows.map((reservation) => {
			const priorityRank = closestMatchReservationPriority(
				reservation.reservation_status || reservation.state
			);
			return {
				id: normalizeId(reservation._id),
				amountCents: paymentAmountCents(reservation, paymentBreakdownKey),
				priorityRank,
				priorityDate:
					priorityRank === 0
						? reservation.checkout_date
						: reservation.checkin_date,
				checkinDate: reservation.checkin_date,
				checkoutDate: reservation.checkout_date,
			};
		});
		const match = await runClosestReconciliationMatch(
			candidates,
			targetAmountCents,
			{ maxSelectedCount: MAX_RECONCILIATION_UPDATE_RESERVATIONS }
		);
		if (Number(match?.selectedCount || 0) > MAX_RECONCILIATION_UPDATE_RESERVATIONS) {
			return res.status(422).json({
				code: "closest_match_selection_limit_exceeded",
				error:
					"The closest proposal requires more than 500 reservations. Narrow the filters or reconcile in more than one batch.",
				selectionLimit: MAX_RECONCILIATION_UPDATE_RESERVATIONS,
			});
		}
		const selectedIdList = (
			Array.isArray(match?.selectedIds) ? match.selectedIds : []
		).map((id) => String(id || "").trim());
		const selectedIds = new Set(selectedIdList);
		const candidatesById = new Map(
			candidatesRows.map((reservation) => [
				normalizeId(reservation._id),
				reservation,
			])
		);
		if (
			selectedIds.size !== selectedIdList.length ||
			selectedIdList.length !== Number(match?.selectedCount) ||
			candidates.length !== Number(match?.candidateCount) ||
			selectedIdList.some(
				(id) => !ObjectId.isValid(id) || !candidatesById.has(id)
			)
		) {
			throw new Error("Closest-match worker returned inconsistent selection ids");
		}
		const initialSelectedRows = selectedIdList.map((id) => candidatesById.get(id));
		const initialSelectedAmountCents = initialSelectedRows.reduce(
			(sum, reservation) => {
				const next =
					sum + paymentAmountCents(reservation, paymentBreakdownKey);
				if (!Number.isSafeInteger(next)) {
					throw new Error(
						"Closest-match proposal amount is outside the safe range"
					);
				}
				return next;
			},
			0
		);
		const initialDifferenceCents =
			initialSelectedAmountCents - targetAmountCents;
		const initialDirection =
			initialDifferenceCents === 0
				? "exact"
				: initialDifferenceCents < 0
				? "under"
				: "over";
		if (
			initialSelectedAmountCents !== Number(match?.matchedCents) ||
			initialDifferenceCents !== Number(match?.differenceCents) ||
			initialDirection !== String(match?.direction || "") ||
			(initialDifferenceCents === 0) !== (match?.exactMatch === true)
		) {
			throw new Error("Closest-match worker returned inconsistent diagnostics");
		}

		const selectedRows = selectedIdList.length
			? await Reservations.find({
					$and: [
						filter,
						{
							_id: {
								$in: selectedIdList.map((id) => new ObjectId(id)),
							},
						},
					],
			  })
					.select(RECONCILIATION_REPORT_ROW_PROJECTION)
					.sort(RECONCILIATION_REPORT_SORT)
					.limit(selectedIdList.length)
					.lean()
			: [];
		const refetchedById = new Map(
			selectedRows.map((reservation) => [
				normalizeId(reservation._id),
				reservation,
			])
		);
		const candidatesChanged =
			selectedRows.length !== selectedIdList.length ||
			selectedIdList.some((id) => {
				const initial = candidatesById.get(id);
				const refetched = refetchedById.get(id);
				return (
					!refetched ||
					initial?.__v !== refetched.__v ||
					dateMillis(initial?.updatedAt) !== dateMillis(refetched.updatedAt) ||
					paymentAmountCents(initial, paymentBreakdownKey) !==
						paymentAmountCents(refetched, paymentBreakdownKey)
				);
			});
		if (candidatesChanged) {
			return res.status(409).json({
				code: "closest_match_candidates_changed",
				error:
					"One or more reservations changed while preparing the closest match. Please run it again.",
			});
		}

		const selectedAmountCents = selectedRows.reduce((sum, reservation) => {
			const next = sum + paymentAmountCents(reservation, paymentBreakdownKey);
			if (!Number.isSafeInteger(next)) {
				throw new Error("Closest-match proposal amount is outside the safe range");
			}
			return next;
		}, 0);
		const selectedDifferenceCents = selectedAmountCents - targetAmountCents;
		const selectedDirection =
			selectedDifferenceCents === 0
				? "exact"
				: selectedDifferenceCents < 0
				? "under"
				: "over";
		const selectedRowsWithRooms = await attachRoomDetails(selectedRows);
		const data = selectedRowsWithRooms.map((reservation) =>
			reportRow(reservation, selectedKeys)
		);
		const reservations = selectedRows.map((reservation) => ({
			reservationId: normalizeId(reservation._id),
			__v: Number.isSafeInteger(reservation.__v) ? reservation.__v : 0,
			updatedAt: reservation.updatedAt,
			displayedAmountsCents: {
				[paymentBreakdownKey]: paymentAmountCents(
					reservation,
					paymentBreakdownKey
				),
			},
		}));

		return res.json({
			code: "reconciliation_closest_match",
			hotelId,
			paymentBreakdownKey,
			targetAmountCents,
			matchedAmountCents: selectedAmountCents,
			differenceCents: selectedDifferenceCents,
			direction: selectedDirection,
			exactMatch: selectedDifferenceCents === 0,
			optimalityGuaranteed: match?.optimalityGuaranteed === true,
			resolutionCents: Number(match?.resolutionCents || 1),
			candidateCount: candidates.length,
			selectedCount: reservations.length,
			elapsedMs: Number(match?.elapsedMs || 0),
			timedOut: match?.timedOut === true,
			selectionLimitExceeded: match?.selectionLimitExceeded === true,
			data,
			reservations,
		});
	} catch (error) {
		if (
			error instanceof PaymentReconciliationError ||
			error instanceof PaidBreakdownDateFilterError ||
			Number.isInteger(error?.statusCode)
		) {
			return res.status(error.statusCode || 400).json({
				code: error.code || "invalid_closest_match_request",
				error: error.message,
			});
		}
		console.error("Error in closestReconciliationMatch:", error);
		return res.status(500).json({
			code: "reconciliation_closest_match_failed",
			error: "Could not prepare the closest reconciliation match",
		});
	}
};

exports._private = {
	BATCH_FINALIZATION_ATTEMPTS,
	MAX_CLOSEST_MATCH_CANDIDATES,
	MAX_RECONCILIATION_UPDATE_RESERVATIONS,
	actorCanAccessHotel,
	buildReconciliationUpdate,
	buildExcludeCancelledReservationsFilter,
	closestMatchReservationPriority,
	buildReportFilter,
	buildScorecardPipeline,
	buildSnapshotUpdateFilter,
	closestMatchCandidateProjection,
	finalizePaymentReconciliationBatch,
	finalizedBatchMatches,
	reportRow,
	RECONCILIATION_REPORT_ROW_PROJECTION,
	RECONCILIATION_REPORT_SORT,
	scorecardsFromAggregate,
	validateMutationRequest,
};
