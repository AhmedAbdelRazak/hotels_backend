/** @format */

"use strict";

const plainObject = (value = {}) => {
	const plain =
		value && typeof value.toObject === "function" ? value.toObject() : value;
	return plain && typeof plain === "object" && !Array.isArray(plain) ? plain : {};
};

const normalizeActorId = (value) =>
	String(value?._id || value?.id || value || "").trim() || null;

const DIRECT_HOTELRUNNER_SERVER_FINANCE_FIELDS = Object.freeze([
	"commission",
	"commissionData",
	"commissionPaid",
	"commissionPaidAt",
	"commissionStatus",
	"commissionAgentApproval",
	"financial_cycle",
	"adminPricing",
	"adminPricingVisibility",
	"ota_financial_summary",
	"otaFinancialSummary",
	"hotelRunnerPricing",
	"hotelrunnerPricing",
	"moneyTransferredToHotel",
	"moneyTransferredAt",
]);

const stripUntrustedDirectHotelRunnerFinanceFields = (payload = {}) => {
	Object.keys(payload || {}).forEach((field) => {
		if (
			DIRECT_HOTELRUNNER_SERVER_FINANCE_FIELDS.some(
				(serverField) =>
					field === serverField || field.startsWith(`${serverField}.`)
			)
		) {
			delete payload[field];
		}
	});
	return payload;
};

const normalizeExplicitHotelRunnerCommission = (value) => {
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
	const cents = amount * 100;
	if (
		!Number.isFinite(amount) ||
		amount < 0 ||
		!Number.isSafeInteger(Math.round(cents)) ||
		Math.abs(cents - Math.round(cents)) > 1e-7
	) {
		return null;
	}
	return Number(amount.toFixed(2));
};

/**
 * Produces the complete server-owned evidence for an explicitly reviewed
 * HotelRunner platform commission. Callers must authorize the actor first.
 */
const buildTrustedDirectHotelRunnerCommissionAssignment = ({
	update = {},
	existingReservation = {},
	amount,
	actorId = "",
	assignedAt = new Date(),
} = {}) => {
	const normalizedAmount = normalizeExplicitHotelRunnerCommission(amount);
	if (normalizedAmount === null) {
		throw new TypeError("A valid HotelRunner commission amount is required.");
	}
	const existing = plainObject(existingReservation);
	const existingCommissionData = plainObject(existing.commissionData);
	const existingAdminPricing = plainObject(existing.adminPricing);
	const trustedAdminPricingUpdate = plainObject(update.adminPricing);
	const existingFinancialCycle = plainObject(existing.financial_cycle);
	const allowedFinancialCycleUpdate = plainObject(update.financial_cycle);
	const trustedActorId = normalizeActorId(actorId);
	const trustedAssignedAt =
		assignedAt instanceof Date && Number.isFinite(assignedAt.getTime())
			? assignedAt
			: new Date();
	const commissionStatus =
		normalizedAmount > 0
			? String(
					update.commissionStatus ||
						existing.commissionStatus ||
						"commission due"
			  ).trim() || "commission due"
			: "no commission due";

	return {
		...update,
		commission: normalizedAmount,
		adminPricing: {
			...existingAdminPricing,
			...trustedAdminPricingUpdate,
			commissionAmount: normalizedAmount,
		},
		commissionStatus,
		commissionData: {
			...existingCommissionData,
			assigned: true,
			amount: normalizedAmount,
			commissionAmount: normalizedAmount,
			commissionValue: normalizedAmount,
			status: commissionStatus,
			assignedAt: trustedAssignedAt,
			assignedBy: trustedActorId,
			proposedByAgent: false,
		},
		financial_cycle: {
			...existingFinancialCycle,
			...allowedFinancialCycleUpdate,
			commissionType: "amount",
			commissionValue: normalizedAmount,
			commissionAmount: normalizedAmount,
			commissionAssigned: true,
			commissionAssignedAt: trustedAssignedAt,
			commissionAssignedBy: trustedActorId,
		},
	};
};

module.exports = {
	DIRECT_HOTELRUNNER_SERVER_FINANCE_FIELDS,
	buildTrustedDirectHotelRunnerCommissionAssignment,
	normalizeExplicitHotelRunnerCommission,
	stripUntrustedDirectHotelRunnerFinanceFields,
};
