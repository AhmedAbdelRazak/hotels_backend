"use strict";

const {
	buildHotelRunnerReservationExpression,
	isHotelRunnerReservation,
} = require("./hotelrunnerReportPricing");

const HOTELRUNNER_PLATFORM_FINANCE_REASONS = Object.freeze({
	UNREVIEWED: "hotelrunner_platform_commission_unreviewed",
	INVALID: "hotelrunner_platform_commission_invalid",
	CONFLICT: "hotelrunner_platform_commission_conflict",
});

const hasOwn = (value, key) =>
	Object.prototype.hasOwnProperty.call(value || {}, key);

const finiteMoneyOrNull = (value) => {
	if (
		value === null ||
		value === undefined ||
		typeof value === "boolean" ||
		(typeof value !== "number" && typeof value !== "string")
	) {
		return null;
	}
	const normalized =
		typeof value === "string" ? value.replace(/,/g, "").trim() : value;
	if (normalized === "") return null;
	const amount = Number(normalized);
	return Number.isFinite(amount) && amount >= 0
		? Number(amount.toFixed(2))
		: null;
};

const resolveMoneyConsensus = (evidence = []) => {
	if (!evidence.length) return { status: "invalid" };
	const normalized = evidence.map((item) => ({
		...item,
		amount: finiteMoneyOrNull(item.value),
	}));
	if (normalized.some((item) => item.amount === null)) {
		return { status: "invalid" };
	}
	if (new Set(normalized.map((item) => item.amount.toFixed(2))).size !== 1) {
		return { status: "conflict" };
	}
	return {
		status: "valid",
		amount: normalized[0].amount,
		sources: normalized.map((item) => item.source),
	};
};

/**
 * HotelRunner's gross/local PMS base spread is not a PMS/platform commission.
 * A direct HotelRunner reservation may enter payout/charge workflows only after
 * staff explicitly assigns the platform commission (zero is a valid review).
 */
const resolveHotelRunnerPlatformCommission = (reservation = {}) => {
	if (!isHotelRunnerReservation(reservation)) {
		return {
			isHotelRunner: false,
			available: true,
			amount: null,
			reason: "",
		};
	}

	const cycle = reservation?.financial_cycle || {};
	const commissionData = reservation?.commissionData || {};
	const cycleAssigned = cycle.commissionAssigned === true;
	const dataAssigned = commissionData.assigned === true;

	if (!cycleAssigned && !dataAssigned) {
		return {
			isHotelRunner: true,
			available: false,
			amount: null,
			reason: HOTELRUNNER_PLATFORM_FINANCE_REASONS.UNREVIEWED,
		};
	}

	const groups = [];
	if (cycleAssigned) {
		groups.push(
			resolveMoneyConsensus(
				["commissionAmount", "commissionValue"]
					.filter((field) => hasOwn(cycle, field))
					.map((field) => ({
						value: cycle[field],
						source: `financial_cycle.${field}`,
					}))
			)
		);
	}

	if (dataAssigned) {
		const dataEvidence = ["amount", "commissionAmount", "commissionValue"]
			.filter((field) => hasOwn(commissionData, field))
			.map((field) => ({
				value: commissionData[field],
				source: `commissionData.${field}`,
			}));
		if (hasOwn(reservation, "commission")) {
			dataEvidence.push({
				value: reservation.commission,
				source: "commission",
			});
		}
		groups.push(resolveMoneyConsensus(dataEvidence));
	}

	if (groups.some((group) => group.status === "invalid")) {
		return {
			isHotelRunner: true,
			available: false,
			amount: null,
			reason: HOTELRUNNER_PLATFORM_FINANCE_REASONS.INVALID,
		};
	}
	if (
		groups.some((group) => group.status === "conflict") ||
		new Set(groups.map((group) => group.amount.toFixed(2))).size !== 1
	) {
		return {
			isHotelRunner: true,
			available: false,
			amount: null,
			reason: HOTELRUNNER_PLATFORM_FINANCE_REASONS.CONFLICT,
		};
	}

	return {
		isHotelRunner: true,
		available: true,
		amount: groups[0].amount,
		reason: "",
		source: groups
			.flatMap((group) => group.sources)
			.join(","),
	};
};

const summarizeHotelRunnerFinanceUnavailable = (reservations = []) => {
	const reasons = {};
	for (const reservation of Array.isArray(reservations) ? reservations : []) {
		const reason = String(
			reservation?.hotelrunner_finance_unavailable_reason || ""
		).trim();
		if (!reason) continue;
		reasons[reason] = (reasons[reason] || 0) + 1;
	}
	return {
		count: Object.values(reasons).reduce((sum, count) => sum + count, 0),
		reasons,
	};
};

const moneyFieldExpression = (field) => {
	const type = { $type: field };
	const present = { $ne: [type, "missing"] };
	const normalizedInput = {
		$cond: [
			{ $eq: [type, "string"] },
			{
				$trim: {
					input: {
						$replaceAll: {
							input: field,
							find: ",",
							replacement: "",
						},
					},
				},
			},
			field,
		],
	};
	const converted = {
		$convert: {
			input: normalizedInput,
			to: "double",
			onError: null,
			onNull: null,
		},
	};
	const valid = {
		$and: [
			{
				$in: [
					type,
					["double", "int", "long", "decimal", "string"],
				],
			},
			{ $ne: [converted, null] },
			{ $eq: [converted, converted] },
			{ $gte: [converted, 0] },
			{ $lte: [converted, Number.MAX_VALUE] },
		],
	};
	return { converted, present, valid };
};

const moneyConsensusExpression = (fields = []) => {
	const entries = fields.map((field) => ({
		field,
		...moneyFieldExpression(field),
	}));
	const pairwiseAgreement = [];
	for (let left = 0; left < entries.length; left += 1) {
		for (let right = left + 1; right < entries.length; right += 1) {
			pairwiseAgreement.push({
				$or: [
					{ $eq: [entries[left].present, false] },
					{ $eq: [entries[right].present, false] },
					{
						$eq: [
							{ $round: [entries[left].converted, 2] },
							{ $round: [entries[right].converted, 2] },
						],
					},
				],
			});
		}
	}
	return {
		hasEvidence: { $or: entries.map((entry) => entry.present) },
		allPresentValid: {
			$and: entries.map((entry) => ({
				$or: [{ $eq: [entry.present, false] }, entry.valid],
			})),
		},
		valuesAgree: { $and: pairwiseAgreement },
		amount: {
			$switch: {
				branches: entries.map((entry) => ({
					case: entry.present,
					then: entry.converted,
				})),
				default: null,
			},
		},
	};
};

/**
 * MongoDB counterpart of resolveHotelRunnerPlatformCommission(). Keeping this
 * beside the JavaScript resolver prevents aggregate reports from silently
 * reverting to gross/root spread or an unreviewed stored zero.
 */
const buildHotelRunnerPlatformFinanceAggregationExpressions = () => {
	const isHotelRunner = buildHotelRunnerReservationExpression();
	const cycleAssigned = { $eq: ["$financial_cycle.commissionAssigned", true] };
	const dataAssigned = { $eq: ["$commissionData.assigned", true] };
	const cycle = moneyConsensusExpression([
		"$financial_cycle.commissionAmount",
		"$financial_cycle.commissionValue",
	]);
	const data = moneyConsensusExpression([
		"$commissionData.amount",
		"$commissionData.commissionAmount",
		"$commissionData.commissionValue",
		"$commission",
	]);
	const hasAssignment = { $or: [cycleAssigned, dataAssigned] };
	const cycleValid = {
		$or: [
			{ $eq: [cycleAssigned, false] },
			{ $and: [cycle.hasEvidence, cycle.allPresentValid] },
		],
	};
	const dataValid = {
		$or: [
			{ $eq: [dataAssigned, false] },
			{ $and: [data.hasEvidence, data.allPresentValid] },
		],
	};
	const valuesAgree = {
		$and: [
			{ $or: [{ $eq: [cycleAssigned, false] }, cycle.valuesAgree] },
			{ $or: [{ $eq: [dataAssigned, false] }, data.valuesAgree] },
			{
				$or: [
					{ $eq: [cycleAssigned, false] },
					{ $eq: [dataAssigned, false] },
					{
						$eq: [
							{ $round: [cycle.amount, 2] },
							{ $round: [data.amount, 2] },
						],
					},
				],
			},
		],
	};
	const strictAvailable = {
		$and: [hasAssignment, cycleValid, dataValid, valuesAgree],
	};
	const strictAmount = {
		$cond: [cycleAssigned, cycle.amount, data.amount],
	};
	const strictReason = {
		$switch: {
			branches: [
				{
					case: { $eq: [hasAssignment, false] },
					then: HOTELRUNNER_PLATFORM_FINANCE_REASONS.UNREVIEWED,
				},
				{
					case: {
						$or: [
							{ $eq: [cycleValid, false] },
							{ $eq: [dataValid, false] },
						],
					},
					then: HOTELRUNNER_PLATFORM_FINANCE_REASONS.INVALID,
				},
				{
					case: { $eq: [valuesAgree, false] },
					then: HOTELRUNNER_PLATFORM_FINANCE_REASONS.CONFLICT,
				},
			],
			default: "",
		},
	};

	return {
		isHotelRunner,
		available: { $cond: [isHotelRunner, strictAvailable, true] },
		amount: {
			$cond: [strictAvailable, { $round: [strictAmount, 2] }, null],
		},
		reason: { $cond: [isHotelRunner, strictReason, ""] },
	};
};

module.exports = {
	HOTELRUNNER_PLATFORM_FINANCE_REASONS,
	buildHotelRunnerPlatformFinanceAggregationExpressions,
	resolveHotelRunnerPlatformCommission,
	summarizeHotelRunnerFinanceUnavailable,
};
