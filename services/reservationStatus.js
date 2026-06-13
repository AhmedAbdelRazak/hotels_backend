const PENDING_CONFIRMATION_STATUS_REGEX =
	/(?:pending[\s_-]?confirmation|pending[\s_-]?finance[\s_-]?review|pending[\s_-]?agent[\s_-]?commission[\s_-]?approval|^pending$)/i;
const PENDING_DECISION_STATUS_REGEX = /^pending$/i;
const INVENTORY_EXCLUDED_STATUS_REGEX = /cancel|reject|void|no[_\s-]?show/i;
const INVENTORY_COMPLETED_STATUS_REGEX = /checked[_\s-]?out|checkedout/i;
const INVENTORY_NON_BLOCKING_STATUS_REGEX =
	/cancel|reject|void|no[_\s-]?show|checked[_\s-]?out|checkedout/i;

const normalizeStatus = (value = "") =>
	String(value || "")
		.trim()
		.toLowerCase();

const isPendingConfirmationReservation = (reservation = {}) => {
	const reservationStatus = normalizeStatus(reservation.reservation_status);
	const state = normalizeStatus(reservation.state);
	const pendingStatus = normalizeStatus(reservation?.pendingConfirmation?.status);
	const decisionStatus = normalizeStatus(reservation?.agentDecisionSnapshot?.status);

	return (
		PENDING_CONFIRMATION_STATUS_REGEX.test(reservationStatus) ||
		PENDING_CONFIRMATION_STATUS_REGEX.test(state) ||
		PENDING_DECISION_STATUS_REGEX.test(pendingStatus) ||
		PENDING_DECISION_STATUS_REGEX.test(decisionStatus)
	);
};

const shouldCountReservationForInventory = (
	reservation = {},
	{
		includeCancelled = false,
		includePendingConfirmation = false,
		includeCompleted = false,
	} = {}
) => {
	if (
		!includePendingConfirmation &&
		isPendingConfirmationReservation(reservation)
	) {
		return reservation?.pendingConfirmation?.inventoryBlocks === true;
	}

	if (includeCancelled) return true;

	const status = normalizeStatus(
		reservation.reservation_status || reservation.state || ""
	);
	if (!status) return true;

	if (includeCompleted && INVENTORY_COMPLETED_STATUS_REGEX.test(status)) {
		return !INVENTORY_EXCLUDED_STATUS_REGEX.test(status);
	}

	return !INVENTORY_NON_BLOCKING_STATUS_REGEX.test(status);
};

const buildPendingConfirmationExclusionFilter = () => ({
	$nor: [
		{ reservation_status: PENDING_CONFIRMATION_STATUS_REGEX },
		{ state: PENDING_CONFIRMATION_STATUS_REGEX },
		{ "pendingConfirmation.status": PENDING_DECISION_STATUS_REGEX },
		{ "agentDecisionSnapshot.status": PENDING_DECISION_STATUS_REGEX },
	],
});

module.exports = {
	PENDING_CONFIRMATION_STATUS_REGEX,
	PENDING_DECISION_STATUS_REGEX,
	isPendingConfirmationReservation,
	shouldCountReservationForInventory,
	buildPendingConfirmationExclusionFilter,
};
