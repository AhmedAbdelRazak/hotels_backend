/** @format */

"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");
const Reservations = require("../models/reservations");
const Rooms = require("../models/rooms");
const {
	buildExcludePendingOtaReviewFilter,
} = require("../services/otaReservationVisibility");
const {
	addHotelManagementReservationVisibilityToFilter,
} = require("../services/reservationVisibility");
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
const MAX_RECONCILIATION_NOTE_LENGTH = 500;
const DAY_MS = 24 * 60 * 60 * 1000;
const RECONCILIATION_REPORT_ROW_PROJECTION = [
	"_id",
	"__v",
	"updatedAt",
	"createdAt",
	"hotelId",
	"confirmation_number",
	"booking_source",
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

const normalizeId = (value) =>
	String(value?._id || value?.id || value || "").trim();

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

const responseReconciliationBreakdown = (byBreakdown = {}) =>
	Object.fromEntries(
		Object.entries(byBreakdown).map(([key, entry = {}]) => [
			key,
			{
				amount: entry.amount,
				amountCents: entry.amountCents,
				status: entry.status,
				reconciled: entry.reconciled === true,
				stale: entry.stale === true,
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
			reconciliation.byBreakdown
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
	const everyPositiveReconciled = {
		$and: selectedKeys.map((key) => ({
			$or: [
				{ $lte: [paymentAmountCentsExpression(key), 0] },
				effectivelyReconciledExpression(key),
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
				rowReconciled: {
					$and: [anyPositive, everyPositiveReconciled],
				},
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
		waitingReservationsCount:
			reservationsCount - reconciledReservationsCount,
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
					.sort({ checkin_date: -1, createdAt: -1, _id: -1 })
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
	const selectedKeys = normalizePaymentBreakdownKeys(
		body.paymentBreakdownKeys,
		{ defaultKeys: [], required: true }
	);
	const status = normalizeReconciliationStatus(body.status, { allowAll: false });
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
	if (body.note !== undefined && typeof body.note !== "string") {
		throw new PaymentReconciliationError(
			"note must be text",
			"invalid_reconciliation_note"
		);
	}
	const note = String(body.note || "").trim();
	if (note.length > MAX_RECONCILIATION_NOTE_LENGTH) {
		throw new PaymentReconciliationError(
			`note cannot exceed ${MAX_RECONCILIATION_NOTE_LENGTH} characters`,
			"reconciliation_note_too_long"
		);
	}
	const seenIds = new Set();
	const snapshots = body.reservations.map((snapshot) =>
		parseSnapshot(snapshot, selectedKeys, seenIds)
	);
	return { hotelId, selectedKeys, status, snapshots, note };
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

const dateMillis = (value) => {
	const parsed = new Date(value);
	return Number.isFinite(parsed.getTime()) ? parsed.getTime() : null;
};

const reconciliationKeysNeedingTarget = (
	reservation,
	positiveKeys,
	status
) =>
	positiveKeys.filter((key) => {
		const effective = effectivePaymentReconciliation(reservation, key);
		return status === "reconciled" ? !effective.reconciled : effective.reconciled;
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
	filter.$expr = {
		$and: positiveKeys.map((key) => ({
			$gt: [paymentAmountCentsExpression(key), 0],
		})),
	};
	addHotelManagementReservationVisibilityToFilter(filter, actor);
	return filter;
};

const buildReconciliationUpdate = ({
	reservation,
	changedKeys,
	status,
	actor,
	note,
	batchId,
	now,
}) => {
	const set = {
		"payment_reconciliation.lastUpdatedAt": now,
		"payment_reconciliation.lastUpdatedBy": actor,
		"payment_reconciliation.lastBatchId": batchId,
		updatedAt: now,
	};
	const previous = {};
	for (const key of changedKeys) {
		const current = effectivePaymentReconciliation(reservation, key);
		previous[key] = current.status;
		set[`payment_reconciliation.breakdown.${key}`] = {
			status,
			amountCents: current.amountCents,
			reconciledAt: status === "reconciled" ? now : null,
			reconciledBy: status === "reconciled" ? actor : null,
			updatedAt: now,
			updatedBy: actor,
			batchId,
			note,
		};
	}
	const audit = {
		at: now,
		by: actor,
		field: "payment_reconciliation",
		from: previous,
		to: Object.fromEntries(changedKeys.map((key) => [key, status])),
		paymentBreakdownKeys: changedKeys,
		batchId,
		note,
	};
	return {
		$set: set,
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
		const { hotelId, selectedKeys, status, snapshots, note } =
			validateMutationRequest(req);
		const ids = snapshots.map((snapshot) => new ObjectId(snapshot.reservationId));
		const mutationScopeFilter = {
			_id: { $in: ids },
			hotelId: new ObjectId(hotelId),
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
			const positiveKeys = selectedKeys.filter(
				(key) => paymentAmountCents(reservation, key) > 0
			);
			if (!positiveKeys.length) {
				skipped.push({
					reservationId: snapshot.reservationId,
					code: "no_positive_selected_amount",
				});
				continue;
			}
			const changedKeys = reconciliationKeysNeedingTarget(
				reservation,
				positiveKeys,
				status
			);
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
			pendingUpdates.push({ reservation, positiveKeys, changedKeys });
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

		const now = new Date();
		const batchId = crypto.randomUUID();
		const updated = [];
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
						status,
						actor: authorization.actor,
						note,
						batchId,
						now,
					}),
					{ timestamps: false }
				);
				const matched = Number(result?.matchedCount ?? result?.n ?? 0);
				if (matched === 1) {
					updated.push(normalizeId(pending.reservation._id));
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

		const statusCode = conflicts.length ? 409 : 200;
		return res.status(statusCode).json({
			success: conflicts.length === 0,
			code: conflicts.length ? "reconciliation_conflict" : "reconciliation_updated",
			batchId,
			status,
			paymentBreakdownKeys: selectedKeys,
			updatedCount: updated.length,
			updated,
			unchanged,
			skipped,
			conflictCount: conflicts.length,
			conflicts,
			updatedAt: now.toISOString(),
		});
	} catch (error) {
		if (error instanceof PaymentReconciliationError) {
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

exports._private = {
	MAX_RECONCILIATION_UPDATE_RESERVATIONS,
	actorCanAccessHotel,
	buildReconciliationUpdate,
	buildReportFilter,
	buildScorecardPipeline,
	buildSnapshotUpdateFilter,
	reportRow,
	RECONCILIATION_REPORT_ROW_PROJECTION,
	scorecardsFromAggregate,
	validateMutationRequest,
};
