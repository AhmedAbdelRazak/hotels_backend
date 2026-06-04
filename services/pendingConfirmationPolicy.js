"use strict";

const STATUS_PENDING_CONFIRMATION = "Pending Confirmation";
const STATUS_CONFIRMED = "confirmed";

const normalizeStatus = (value = "") =>
	String(value || "")
		.trim()
		.toLowerCase();

const actorSnapshot = (actor) => {
	if (!actor) return null;
	if (typeof actor !== "object") return String(actor);

	const id = actor._id || actor.id || "";
	const snapshot = {};
	if (id) snapshot._id = String(id);
	["name", "email", "role", "roleDescription", "companyName"].forEach((key) => {
		if (actor[key] !== undefined && actor[key] !== null && actor[key] !== "") {
			snapshot[key] = actor[key];
		}
	});
	return Object.keys(snapshot).length ? snapshot : null;
};

const buildPendingConfirmation = ({
	existing = {},
	actor = null,
	source = "reservation_create",
	clientVisibleStatus = STATUS_CONFIRMED,
	inventoryBlocks = true,
	now = new Date(),
} = {}) => {
	const plainExisting =
		existing && typeof existing === "object" ? existing : {};
	return {
		...plainExisting,
		status: "pending",
		rejectionReason: "",
		confirmationReason: "",
		confirmedAt: null,
		rejectedAt: null,
		requestedAt: plainExisting.requestedAt || now,
		lastUpdatedAt: now,
		lastUpdatedBy: actorSnapshot(actor) || plainExisting.lastUpdatedBy || null,
		source,
		inventoryBlocks: inventoryBlocks === true,
		clientVisibleStatus:
			clientVisibleStatus === false ? "" : normalizeStatus(clientVisibleStatus),
	};
};

const markReservationPendingConfirmation = (
	reservationPayload = {},
	{
		actor = null,
		source = "reservation_create",
		operationalStatus = false,
		clientVisibleStatus = STATUS_CONFIRMED,
		inventoryBlocks = true,
		now = new Date(),
	} = {}
) => {
	if (!reservationPayload || typeof reservationPayload !== "object") {
		return reservationPayload;
	}

	const resolvedActor =
		actor ||
		reservationPayload.orderTaker ||
		reservationPayload.createdBy ||
		reservationPayload.createdByUserId ||
		reservationPayload.orderTakeId ||
		null;

	reservationPayload.pendingConfirmation = buildPendingConfirmation({
		existing: reservationPayload.pendingConfirmation,
		actor: resolvedActor,
		source,
		clientVisibleStatus,
		inventoryBlocks,
		now,
	});

	if (operationalStatus) {
		reservationPayload.reservation_status = STATUS_PENDING_CONFIRMATION;
		reservationPayload.state = STATUS_PENDING_CONFIRMATION;
	} else {
		reservationPayload.reservation_status =
			reservationPayload.reservation_status || STATUS_CONFIRMED;
		reservationPayload.state = reservationPayload.state || STATUS_CONFIRMED;
	}

	return reservationPayload;
};

const applyClientVisibleReservationStatus = (reservation = {}) => {
	if (!reservation || typeof reservation !== "object") return reservation;
	const pending = reservation.pendingConfirmation || {};
	const visibleStatus = normalizeStatus(pending.clientVisibleStatus);
	if (!visibleStatus) return reservation;

	const pendingStatus = normalizeStatus(pending.status);
	const rawStatus = normalizeStatus(
		reservation.reservation_status || reservation.state || ""
	);
	const trueTerminalStatus =
		pendingStatus === "cancelled" ||
		pendingStatus === "canceled" ||
		pendingStatus === "rejected" ||
		rawStatus === "rejected" ||
		/cancel|no[_\s-]?show/.test(rawStatus);

	if (trueTerminalStatus) return reservation;
	return {
		...reservation,
		reservation_status: visibleStatus,
		state: visibleStatus,
	};
};

const hidePendingConfirmationForClient = (reservation = {}) => {
	const visibleReservation = applyClientVisibleReservationStatus(reservation);
	if (!visibleReservation || typeof visibleReservation !== "object") {
		return visibleReservation;
	}
	const sanitized = { ...visibleReservation };
	delete sanitized.pendingConfirmation;
	delete sanitized.agentDecisionSnapshot;
	return sanitized;
};

module.exports = {
	STATUS_PENDING_CONFIRMATION,
	STATUS_CONFIRMED,
	buildPendingConfirmation,
	markReservationPendingConfirmation,
	applyClientVisibleReservationStatus,
	hidePendingConfirmationForClient,
};
