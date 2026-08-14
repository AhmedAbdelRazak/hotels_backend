/** @format */

"use strict";

const PAYMENT_BREAKDOWN_KEYS = Object.freeze([
	"paid_online_via_link",
	"paid_at_hotel_cash",
	"paid_at_hotel_card",
	"paid_to_hotel",
	"paid_online_jannatbooking",
	"paid_online_other_platforms",
	"paid_online_via_instapay",
	"paid_no_show",
]);

const PAYMENT_BREAKDOWN_KEY_SET = new Set(PAYMENT_BREAKDOWN_KEYS);
const RECONCILIATION_STATUSES = Object.freeze([
	"all",
	"reconciled",
	"waiting",
]);
const RECONCILIATION_STATUS_SET = new Set(RECONCILIATION_STATUSES);

class PaymentReconciliationError extends Error {
	constructor(message, code = "invalid_reconciliation_request", statusCode = 400) {
		super(message);
		this.name = "PaymentReconciliationError";
		this.code = code;
		this.statusCode = statusCode;
	}
}

const hasOwn = (source, field) =>
	Boolean(
		source &&
			typeof source === "object" &&
			!Array.isArray(source) &&
			Object.prototype.hasOwnProperty.call(source, field)
	);

const parseKeyInput = (value) => {
	if (value === undefined || value === null || value === "") return [];
	const values = Array.isArray(value) ? value : [value];
	const parsed = [];
	for (const item of values) {
		if (typeof item !== "string") {
			throw new PaymentReconciliationError(
				"paymentBreakdownKeys must contain only payment category names",
				"invalid_payment_breakdown_keys"
			);
		}
		for (const candidate of item.split(",")) {
			const key = candidate.trim();
			if (!key || !PAYMENT_BREAKDOWN_KEY_SET.has(key)) {
				throw new PaymentReconciliationError(
					`Unknown payment breakdown key: ${key || "(empty)"}`,
					"invalid_payment_breakdown_key"
				);
			}
			if (!parsed.includes(key)) parsed.push(key);
		}
	}
	return parsed;
};

const normalizePaymentBreakdownKeys = (
	value,
	{ defaultKeys = PAYMENT_BREAKDOWN_KEYS, required = false } = {}
) => {
	const supplied = !(value === undefined || value === null || value === "");
	const parsed = parseKeyInput(value);
	if (parsed.length) return parsed;
	if (required || (supplied && parsed.length === 0)) {
		throw new PaymentReconciliationError(
			"At least one payment breakdown key is required",
			"payment_breakdown_keys_required"
		);
	}
	return Array.from(defaultKeys || []);
};

const normalizeReconciliationStatus = (value, { allowAll = true } = {}) => {
	if (value === undefined || value === null || value === "") return "all";
	if (typeof value !== "string") {
		throw new PaymentReconciliationError(
			"reconciliationStatus must be all, reconciled, or waiting",
			"invalid_reconciliation_status"
		);
	}
	const status = value.trim().toLowerCase();
	if (
		!RECONCILIATION_STATUS_SET.has(status) ||
		(!allowAll && status === "all")
	) {
		throw new PaymentReconciliationError(
			allowAll
				? "reconciliationStatus must be all, reconciled, or waiting"
				: "status must be reconciled or waiting",
			"invalid_reconciliation_status"
		);
	}
	return status;
};

const moneyToCents = (value) => {
	if (value === null || value === undefined || value === "") return 0;
	if (typeof value === "boolean") return 0;
	let normalized = value;
	if (typeof value === "string") {
		normalized = value.replace(/,/g, "").trim();
		if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) return 0;
	}
	const amount = Number(normalized);
	if (!Number.isFinite(amount)) return 0;
	const cents = Math.round(amount * 100);
	return Number.isSafeInteger(cents) ? cents : 0;
};

const paymentAmountCents = (reservation = {}, key) => {
	if (!PAYMENT_BREAKDOWN_KEY_SET.has(key)) return 0;
	return Math.max(moneyToCents(reservation?.paid_amount_breakdown?.[key]), 0);
};

const reconciliationEntryFor = (reservation = {}, key) => {
	if (!PAYMENT_BREAKDOWN_KEY_SET.has(key)) return null;
	const entry = reservation?.payment_reconciliation?.breakdown?.[key];
	return entry && typeof entry === "object" && !Array.isArray(entry)
		? entry
		: null;
};

const effectivePaymentReconciliation = (reservation = {}, key) => {
	const amountCents = paymentAmountCents(reservation, key);
	const entry = reconciliationEntryFor(reservation, key);
	const storedAmountCents =
		typeof entry?.amountCents === "number" &&
		Number.isSafeInteger(entry.amountCents)
			? entry.amountCents
			: null;
	const reconciled = Boolean(
		amountCents > 0 &&
			entry?.status === "reconciled" &&
			storedAmountCents !== null &&
			storedAmountCents === amountCents
	);
	return {
		amount: amountCents / 100,
		amountCents,
		positive: amountCents > 0,
		status: amountCents > 0 ? (reconciled ? "reconciled" : "waiting") : "not_applicable",
		reconciled,
		stale:
			amountCents > 0 &&
			entry?.status === "reconciled" &&
			storedAmountCents !== amountCents,
		storedStatus: typeof entry?.status === "string" ? entry.status : "",
		storedAmountCents,
		reconciledAt: reconciled ? entry?.reconciledAt || null : null,
		reconciledBy: reconciled ? entry?.reconciledBy || null : null,
		updatedAt: entry?.updatedAt || null,
		updatedBy: entry?.updatedBy || null,
		batchId: String(entry?.batchId || ""),
		note: String(entry?.note || ""),
	};
};

const summarizeReservationReconciliation = (
	reservation = {},
	selectedKeys = PAYMENT_BREAKDOWN_KEYS
) => {
	const keys = normalizePaymentBreakdownKeys(selectedKeys, {
		defaultKeys: PAYMENT_BREAKDOWN_KEYS,
	});
	const byBreakdown = {};
	const selectedPositiveKeys = [];
	let totalAmountCents = 0;
	let reconciledAmountCents = 0;

	for (const key of keys) {
		const effective = effectivePaymentReconciliation(reservation, key);
		byBreakdown[key] = effective;
		if (!effective.positive) continue;
		selectedPositiveKeys.push(key);
		totalAmountCents += effective.amountCents;
		if (effective.reconciled) {
			reconciledAmountCents += effective.amountCents;
		}
	}

	const waitingAmountCents = totalAmountCents - reconciledAmountCents;
	const reconciliationStatus =
		selectedPositiveKeys.length > 0 &&
		selectedPositiveKeys.every((key) => byBreakdown[key].reconciled)
			? "reconciled"
			: "waiting";

	return {
		selectedKeys: keys,
		selectedPositiveKeys,
		byBreakdown,
		reconciliationStatus,
		totalAmount: totalAmountCents / 100,
		totalAmountCents,
		reconciledAmount: reconciledAmountCents / 100,
		reconciledAmountCents,
		waitingAmount: waitingAmountCents / 100,
		waitingAmountCents,
	};
};

const summarizeReconciliationReservations = (
	reservations = [],
	selectedKeys = PAYMENT_BREAKDOWN_KEYS
) => {
	let totalAmountCents = 0;
	let reconciledAmountCents = 0;
	let reservationsCount = 0;
	let reconciledReservationsCount = 0;
	let waitingReservationsCount = 0;

	for (const reservation of Array.isArray(reservations) ? reservations : []) {
		const summary = summarizeReservationReconciliation(
			reservation,
			selectedKeys
		);
		if (!summary.selectedPositiveKeys.length) continue;
		reservationsCount += 1;
		totalAmountCents += summary.totalAmountCents;
		reconciledAmountCents += summary.reconciledAmountCents;
		if (summary.reconciliationStatus === "reconciled") {
			reconciledReservationsCount += 1;
		} else {
			waitingReservationsCount += 1;
		}
	}

	const waitingAmountCents = totalAmountCents - reconciledAmountCents;
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

const paymentAmountExpression = (key) => {
	if (!PAYMENT_BREAKDOWN_KEY_SET.has(key)) {
		throw new PaymentReconciliationError(
			"Unknown payment breakdown key",
			"invalid_payment_breakdown_key"
		);
	}
	return {
		$convert: {
			input: `$paid_amount_breakdown.${key}`,
			to: "double",
			onError: 0,
			onNull: 0,
		},
	};
};

const paymentAmountCentsExpression = (key) => {
	const scaledAmount = { $multiply: [paymentAmountExpression(key), 100] };
	return {
		$convert: {
			// Payment amounts are non-negative. floor(x + 0.5) intentionally
			// mirrors JavaScript Math.round instead of MongoDB $round's
			// half-to-even rule (notably for persisted half-cent values).
			input: {
				$cond: [
					{ $gt: [scaledAmount, 0] },
					{ $floor: { $add: [scaledAmount, 0.5] } },
					0,
				],
			},
			to: "long",
			onError: 0,
			onNull: 0,
		},
	};
};

const effectivelyReconciledExpression = (key) => ({
	$and: [
		{ $gt: [paymentAmountCentsExpression(key), 0] },
		{ $eq: [`$payment_reconciliation.breakdown.${key}.status`, "reconciled"] },
		{
			$eq: [
				`$payment_reconciliation.breakdown.${key}.amountCents`,
				paymentAmountCentsExpression(key),
			],
		},
	],
});

const buildPaymentBreakdownSelectionFilter = (selectedKeys) => {
	const keys = normalizePaymentBreakdownKeys(selectedKeys, {
		defaultKeys: PAYMENT_BREAKDOWN_KEYS,
	});
	return {
		$expr: {
			$or: keys.map((key) => ({
				$gt: [paymentAmountCentsExpression(key), 0],
			})),
		},
	};
};

const buildReconciliationStatusFilter = (selectedKeys, requestedStatus) => {
	const status = normalizeReconciliationStatus(requestedStatus);
	if (status === "all") return null;
	const keys = normalizePaymentBreakdownKeys(selectedKeys, {
		defaultKeys: PAYMENT_BREAKDOWN_KEYS,
	});
	const anyPositive = {
		$or: keys.map((key) => ({
			$gt: [paymentAmountCentsExpression(key), 0],
		})),
	};
	const everyPositiveIsReconciled = {
		$and: keys.map((key) => ({
			$or: [
				{ $lte: [paymentAmountCentsExpression(key), 0] },
				effectivelyReconciledExpression(key),
			],
		})),
	};
	return {
		$expr: {
			$and: [
				anyPositive,
				status === "reconciled"
					? everyPositiveIsReconciled
					: { $not: [everyPositiveIsReconciled] },
			],
		},
	};
};

const dateOnlyKey = (value) => {
	if (!value) return "";
	if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value)) {
		return value.slice(0, 10);
	}
	const parsed = new Date(value);
	return Number.isFinite(parsed.getTime())
		? parsed.toISOString().slice(0, 10)
		: "";
};

const expectedStayDateKeys = (reservation = {}) => {
	const startKey = dateOnlyKey(reservation.checkin_date);
	const endKey = dateOnlyKey(reservation.checkout_date);
	if (!startKey || !endKey) return [];
	const start = new Date(`${startKey}T00:00:00.000Z`);
	const end = new Date(`${endKey}T00:00:00.000Z`);
	if (!(end > start)) return [];
	const dates = [];
	for (
		let cursor = start;
		cursor < end && dates.length < 3660;
		cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000)
	) {
		dates.push(cursor.toISOString().slice(0, 10));
	}
	return dates;
};

const explicitDailyClientCents = (day = {}) => {
	for (const field of [
		"clientPrice",
		"mainPrice",
		"totalPriceWithCommission",
		"price",
	]) {
		if (!hasOwn(day, field)) continue;
		const raw = day[field];
		if (raw === null || raw === undefined || raw === "" || typeof raw === "boolean") {
			return null;
		}
		const numeric = Number(typeof raw === "string" ? raw.replace(/,/g, "") : raw);
		if (!Number.isFinite(numeric) || numeric < 0) return null;
		const cents = Math.round(numeric * 100);
		return Number.isSafeInteger(cents) ? cents : null;
	}
	return null;
};

const unavailablePricingBreakdown = (reason) => ({
	available: false,
	amount: null,
	amountCents: null,
	currency: "SAR",
	source: "",
	reason,
});

/**
 * Independently total the complete persisted daily guest/client prices. This
 * intentionally has no fallback to total_amount, room totals, root price, or
 * the canonical OTA resolver; callers can display both values side by side.
 */
const resolveCompletePricingRoomsTotal = (
	rooms,
	expectedDates,
	source
) => {
	let totalAmountCents = 0;
	for (const room of rooms) {
		const count = Number(room?.count ?? 1);
		const days = Array.isArray(room?.pricingByDay) ? room.pricingByDay : [];
		if (!Number.isSafeInteger(count) || count <= 0 || !days.length) {
			return unavailablePricingBreakdown("incomplete_daily_pricing");
		}
		if (expectedDates.length && days.length !== expectedDates.length) {
			return unavailablePricingBreakdown("incomplete_stay_daily_pricing");
		}
		if (expectedDates.length) {
			const dayDates = days.map((day) => dateOnlyKey(day?.date || day?.calendarDate));
			if (
				dayDates.some((date) => !date) ||
				dayDates.some((date, index) => date !== expectedDates[index])
			) {
				return unavailablePricingBreakdown("incomplete_stay_daily_pricing");
			}
		}
		for (const day of days) {
			const dayCents = explicitDailyClientCents(day);
			if (dayCents === null) {
				return unavailablePricingBreakdown("incomplete_daily_client_price");
			}
			const nextTotal = totalAmountCents + dayCents * count;
			if (!Number.isSafeInteger(nextTotal)) {
				return unavailablePricingBreakdown("daily_pricing_out_of_range");
			}
			totalAmountCents = nextTotal;
		}
	}

	return {
		available: true,
		amount: totalAmountCents / 100,
		amountCents: totalAmountCents,
		currency: "SAR",
		source,
		reason: "",
	};
};

const resolveCompletePricingBreakdownClientTotal = (reservation = {}) => {
	const candidates = [
		[
			Array.isArray(reservation.pickedRoomsPricing)
				? reservation.pickedRoomsPricing
				: [],
			"pickedRoomsPricing.pricingByDay",
		],
		[
			Array.isArray(reservation.pickedRoomsType)
				? reservation.pickedRoomsType
				: [],
			"pickedRoomsType.pricingByDay",
		],
	].filter(([rooms]) => rooms.length > 0);
	if (!candidates.length) {
		return unavailablePricingBreakdown("daily_pricing_not_recorded");
	}
	const expectedDates = expectedStayDateKeys(reservation);
	let firstUnavailable = null;
	for (const [rooms, source] of candidates) {
		const resolved = resolveCompletePricingRoomsTotal(
			rooms,
			expectedDates,
			source
		);
		if (resolved.available) return resolved;
		firstUnavailable ||= resolved;
	}
	return firstUnavailable;
};

module.exports = {
	PAYMENT_BREAKDOWN_KEYS,
	RECONCILIATION_STATUSES,
	PaymentReconciliationError,
	buildPaymentBreakdownSelectionFilter,
	buildReconciliationStatusFilter,
	effectivePaymentReconciliation,
	effectivelyReconciledExpression,
	moneyToCents,
	normalizePaymentBreakdownKeys,
	normalizeReconciliationStatus,
	paymentAmountCents,
	paymentAmountCentsExpression,
	resolveCompletePricingBreakdownClientTotal,
	summarizeReconciliationReservations,
	summarizeReservationReconciliation,
};
