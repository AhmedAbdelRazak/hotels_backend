/** @format */

"use strict";

const {
	hasDirectHotelRunnerProjection,
} = require("./hotelrunnerOtaEmailBoundary");
const {
	resolveHotelRunnerPlatformCommission,
} = require("./hotelrunnerPlatformFinance");

const DIRECT_HOTELRUNNER_COMMISSION_SETTLEMENT_FIELDS = Object.freeze([
	"commissionPaid",
	"commissionPaidAt",
	"commissionStatus",
]);

/**
 * A guest payment and the platform commission are separate money movements.
 *
 * Existing PayPal flows historically mark commissionPaid while persisting a
 * guest authorization/capture. Keep that legacy behaviour for non-HotelRunner
 * reservations. For a reservation projected directly by HotelRunner, permit
 * the legacy flag only after the canonical finance resolver proves that staff
 * independently reviewed a consistent commission amount (including zero).
 *
 * The returned object is a copy; callers' update objects are never mutated.
 */
const guardDirectHotelRunnerGuestPaymentCommissionSet = ({
	reservation = {},
	set = {},
} = {}) => {
	const guardedSet = { ...(set || {}) };
	if (!hasDirectHotelRunnerProjection(reservation)) {
		return {
			set: guardedSet,
			isDirectHotelRunner: false,
			commissionAvailable: true,
			suppressed: false,
			reason: "",
		};
	}

	const platformCommission = resolveHotelRunnerPlatformCommission(reservation);
	if (platformCommission.available === true) {
		return {
			set: guardedSet,
			isDirectHotelRunner: true,
			commissionAvailable: true,
			suppressed: false,
			reason: "",
		};
	}

	DIRECT_HOTELRUNNER_COMMISSION_SETTLEMENT_FIELDS.forEach((field) => {
		delete guardedSet[field];
	});
	return {
		set: guardedSet,
		isDirectHotelRunner: true,
		commissionAvailable: false,
		suppressed: true,
		reason: platformCommission.reason || "hotelrunner_platform_commission_unavailable",
	};
};

module.exports = {
	DIRECT_HOTELRUNNER_COMMISSION_SETTLEMENT_FIELDS,
	guardDirectHotelRunnerGuestPaymentCommissionSet,
};
