/** @format */

"use strict";

const LATE_EVIDENCE_WAITING_ERROR =
	"hotelrunner_currency_waiting_for_email_bridge";

function lateEvidenceIdleFailureFilter() {
	return {
		status: "failed",
		errorCode: LATE_EVIDENCE_WAITING_ERROR,
		integrityReason: { $in: ["", null] },
		integrityConflict: { $ne: true },
		leaseOwner: { $in: ["", null] },
		leaseUntil: { $in: [null] },
	};
}

function isLateEvidenceIdleFailure(
	event = {},
	{ projectionEligible = false } = {}
) {
	return Boolean(
		projectionEligible === true &&
			event.status === "failed" &&
			event.errorCode === LATE_EVIDENCE_WAITING_ERROR &&
			(event.integrityReason === "" || event.integrityReason == null) &&
			event.integrityConflict !== true &&
			(event.leaseOwner === "" || event.leaseOwner == null) &&
			event.leaseUntil == null
	);
}

module.exports = {
	LATE_EVIDENCE_WAITING_ERROR,
	isLateEvidenceIdleFailure,
	lateEvidenceIdleFailureFilter,
};
