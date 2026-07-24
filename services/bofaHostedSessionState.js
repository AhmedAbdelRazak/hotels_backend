"use strict";

const clean = (value, max = 255) =>
	String(value == null ? "" : value)
		.trim()
		.slice(0, max);

const hasGatewayIdentifier = (reservation) => {
	const sa = reservation?.bofa_payment?.secure_acceptance || {};
	const vcc = reservation?.bofa_payment?.vcc || {};
	return !!(
		clean(sa.last_transaction_id) ||
		clean(sa.last_request_id) ||
		clean(vcc.last_transaction_id) ||
		clean(vcc.last_request_id)
	);
};

const canResumeActiveHostedSession = (reservation, now = new Date()) => {
	const sa = reservation?.bofa_payment?.secure_acceptance || {};
	const vcc = reservation?.bofa_payment?.vcc || {};
	const callbacks = Array.isArray(sa.callbacks) ? sa.callbacks : [];
	const expiresAt = sa.expires_at ? new Date(sa.expires_at) : null;
	const charged = !!vcc.charged || !!reservation?.payment_details?.bofaVccCharged;
	return (
		sa.status === "pending" &&
		!!vcc.processing &&
		!charged &&
		callbacks.length === 0 &&
		!sa.last_callback_at &&
		!hasGatewayIdentifier(reservation) &&
		!!clean(sa.last_reference_number, 50) &&
		!!clean(sa.last_transaction_uuid, 64) &&
		Number(sa.amount_usd || 0) > 0 &&
		expiresAt instanceof Date &&
		!Number.isNaN(expiresAt.getTime()) &&
		expiresAt > now
	);
};

const canReleaseAbandonedHostedSession = (reservation, referenceNumber = "") => {
	const sa = reservation?.bofa_payment?.secure_acceptance || {};
	const vcc = reservation?.bofa_payment?.vcc || {};
	const callbacks = Array.isArray(sa.callbacks) ? sa.callbacks : [];
	const savedReference = clean(sa.last_reference_number, 50);
	const expectedReference = clean(referenceNumber, 50);
	const charged = !!vcc.charged || !!reservation?.payment_details?.bofaVccCharged;

	return (
		sa.status === "expired_unconfirmed" &&
		!!vcc.outcome_unknown &&
		!charged &&
		callbacks.length === 0 &&
		!sa.last_callback_at &&
		!hasGatewayIdentifier(reservation) &&
		!!savedReference &&
		(!expectedReference || expectedReference === savedReference)
	);
};

const buildAbandonedSessionAudit = (reservation, { actorId = "", at = new Date() } = {}) => {
	const sa = reservation?.bofa_payment?.secure_acceptance || {};
	return {
		at,
		reason: "super_admin_confirmed_card_was_not_submitted",
		confirmed_by: clean(actorId, 64),
		reference_number: clean(sa.last_reference_number, 50),
		transaction_uuid: clean(sa.last_transaction_uuid, 64),
		amount_usd: Number(sa.amount_usd || 0),
		signed_at: sa.last_signed_at || null,
		expired_at: sa.expires_at || null,
		callback_count: 0,
		gateway_identifiers_present: false,
	};
};

module.exports = {
	buildAbandonedSessionAudit,
	canResumeActiveHostedSession,
	canReleaseAbandonedHostedSession,
	hasGatewayIdentifier,
};
