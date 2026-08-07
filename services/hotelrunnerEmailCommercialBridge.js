/** @format */

const DefaultInboundEmailModel = require("../models/inbound_email");
const {
	buildHotelRunnerEmailCommercialEvidence,
	verifiedHotelRunnerEmailCommercialEvidence,
} = require("./otaReservationMapper");

const AMOUNT_TOLERANCE = 0.02;
const CREATION_ACTIONS = new Set(["created", "created_unmapped_ota_review"]);
const LEGACY_HOTELRUNNER_EVIDENCE_INVALIDATION =
	"hotelrunner_commercial_evidence_stale";

// Intentionally excludes message bodies, addresses, subjects, guest details,
// payment credentials, and every other field that is not needed for this gate.
const HOTELRUNNER_EMAIL_COMMERCIAL_BRIDGE_PROJECTION = [
	"_id",
	"provider",
	"confirmationNumber",
	"reservationMongoId",
	"hasReservationConnection",
	"processingStatus",
	"automationAction",
	"normalizedReservation.inboundEmailId",
	"normalizedReservation.provider",
	"normalizedReservation.confirmationNumber",
	"normalizedReservation.reservationId",
	"normalizedReservation.sourceSenderTrusted",
	"normalizedReservation.sourceSenderAuthenticated",
	"normalizedReservation.requiresManualReview",
	"normalizedReservation.checkinDate",
	"normalizedReservation.checkoutDate",
	"normalizedReservation.roomCount",
	"normalizedReservation.amount",
	"normalizedReservation.totalAmountSar",
	"normalizedReservation.sourceAmount",
	"normalizedReservation.sourceCurrency",
	"normalizedReservation.currency",
	"normalizedReservation.totalPayoutSar",
	"normalizedReservation.netAfterExpensesTotal",
	"normalizedReservation.sourceExchangeRateToSar",
	"normalizedReservation.sourceExchangeRateSource",
	"normalizedReservation.exchangeRateToSar",
	"normalizedReservation.exchangeRateSource",
	"normalizedReservation.paymentCollectionModel",
	"normalizedReservation.paymentInstructions",
	"normalizedReservation.paymentSummary.sourceCurrency",
	"normalizedReservation.paymentSummary.sourceTotalGuestPaymentAmount",
	"normalizedReservation.paymentSummary.sourceTotalPayoutAmount",
	"normalizedReservation.paymentSummary.totalGuestPaymentAmount",
	"normalizedReservation.paymentSummary.totalPayoutAmount",
	"normalizedReservation.paymentSummary.currency",
	"normalizedReservation.paymentSummary.exchangeRateToSar",
	"normalizedReservation.paymentSummary.exchangeRateSource",
	"normalizedReservation.otaPayoutFallbackReason",
	"normalizedReservation.sourcePresence.confirmationNumber",
	"normalizedReservation.sourcePresence.hotelName",
	"normalizedReservation.sourcePresence.roomName",
	"normalizedReservation.sourcePresence.checkinDate",
	"normalizedReservation.sourcePresence.checkoutDate",
	"normalizedReservation.sourcePresence.roomCount",
	"normalizedReservation.sourcePresence.amount",
	"normalizedReservation.sourcePresence.paymentCollectionModel",
	"normalizedReservation.sourcePresence.paymentInstructions",
	"normalizedReservation.source.receivedAt",
].join(" ");

const clean = (value = "") => String(value == null ? "" : value).trim();
const lower = (value = "") => clean(value).toLowerCase();
const upper = (value = "") => clean(value).toUpperCase();
const round2 = (value) => Number(Number(value).toFixed(2));
const positiveAmount = (value) => {
	const numeric = Number(value);
	return Number.isFinite(numeric) && numeric > 0 ? round2(numeric) : null;
};
const amountMatches = (left, right) =>
	left !== null &&
	right !== null &&
	Math.abs(round2(left) - round2(right)) <= AMOUNT_TOLERANCE;

function id(value) {
	if (value == null) return "";
	if (typeof value === "object") {
		if (typeof value.toHexString === "function") {
			return clean(value.toHexString()).toLowerCase();
		}
		if (value._id != null && value._id !== value) return id(value._id);
	}
	return clean(value).toLowerCase();
}

function providerKey(value = "") {
	const compact = lower(value).replace(/[^a-z0-9]+/g, "");
	if (["trip", "tripcom", "ctrip", "ctripcom"].includes(compact)) return "trip";
	if (["agoda", "agodacom"].includes(compact)) return "agoda";
	if (["booking", "bookingcom"].includes(compact)) return "booking";
	if (["expedia", "expediacom"].includes(compact)) return "expedia";
	if (["hotels", "hotelscom"].includes(compact)) return "hotels";
	if (["airbnb", "airbnbcom"].includes(compact)) return "airbnb";
	if (["hotelrunner", "hotelrunnercom"].includes(compact)) return "hotelrunner";
	return compact;
}

function dateKey(value) {
	if (!value) return "";
	if (typeof value === "string") {
		const match = value.trim().match(/^(\d{4}-\d{2}-\d{2})(?:$|T)/);
		if (match) return match[1];
	}
	const parsed = value instanceof Date ? value : new Date(value);
	return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : "";
}

function roomCountFromHotelRunner(normalized = {}) {
	const declared = Number(normalized.totalRooms);
	const rooms = Array.isArray(normalized.rooms) ? normalized.rooms.length : 0;
	if (!Number.isSafeInteger(declared) || declared < 1) return null;
	if (rooms < 1 || rooms !== declared) return null;
	return declared;
}

function exactIdentityMatches({ existing = {}, inbound = {}, normalized = {}, provider = "" }) {
	const expectedProvider = providerKey(provider);
	const providerNumber = lower(normalized.providerNumber);
	const inboundProvider = providerKey(inbound.provider);
	const inboundConfirmation = lower(
		inbound.confirmationNumber || inbound.reservationId
	);
	if (!expectedProvider || !providerNumber || inboundConfirmation !== providerNumber) {
		return false;
	}
	const expectedIdentity = `${expectedProvider}:${providerNumber}`;
	if (expectedProvider === "trip") {
		if (!["trip", "hotelrunner"].includes(inboundProvider)) return false;
		return lower(existing.otaCrossTransportIdentityKey) === expectedIdentity;
	}
	if (inboundProvider !== expectedProvider) return false;
	return [existing.otaIdentityKey, existing.otaCrossTransportIdentityKey]
		.map(lower)
		.includes(expectedIdentity);
}

async function executeProjectedLookup(InboundEmailModel, inboundEmailId) {
	if (!InboundEmailModel || typeof InboundEmailModel.findById !== "function") {
		return { error: "inbound_email_model_required" };
	}
	try {
		let query = InboundEmailModel.findById(inboundEmailId);
		if (query && typeof query.select === "function") {
			query = query.select(HOTELRUNNER_EMAIL_COMMERCIAL_BRIDGE_PROJECTION);
		}
		if (query && typeof query.lean === "function") query = query.lean();
		const record = query && typeof query.exec === "function" ? await query.exec() : await query;
		return { record };
	} catch (_error) {
		return { error: "inbound_email_lookup_failed" };
	}
}

function explicitCommercialEvidence(existing, inbound, inboundEmailId) {
	const priorMarker = existing?.supplierData?.hotelRunnerEmailCommercialEvidence;
	const built = buildHotelRunnerEmailCommercialEvidence(
		{
			...inbound,
			// Older persisted normalized audits did not retain this convenience
			// field. The exact top-level audit id was already verified above.
			inboundEmailId: inbound.inboundEmailId || id(inboundEmailId),
		},
		{
			appliedAt: priorMarker?.appliedAt || new Date(),
		}
	);
	if (!built) return null;
	if (
		priorMarker &&
		clean(priorMarker.evidenceHash) !== clean(built.evidenceHash)
	) {
		return null;
	}
	const storedFallbackReasons = [
		existing?.supplierData?.otaPayoutFallbackReason,
		existing?.adminPricing?.payoutFallbackReason,
		existing?.ota_financial_summary?.payoutFallbackReason,
	]
		.map(lower)
		.filter(Boolean);
	if (
		storedFallbackReasons.some(
			(reason) => reason !== LEGACY_HOTELRUNNER_EVIDENCE_INVALIDATION
		)
	) {
		return null;
	}
	// The old HotelRunner adapter deliberately invalidated commercialVerified
	// when its generic gross interpretation differed from an OTA-email payout.
	// Re-enable those two derived flags only on this in-memory candidate. Every
	// stored amount, fallback marker, deduction marker, identity, and payment
	// summary remains untouched and must pass the existing materialization gate.
	const candidate = {
		...existing,
		adminPricing: {
			...(existing.adminPricing || {}),
			commercialVerified: true,
			payoutFallbackReason: "",
		},
		ota_financial_summary: {
			...(existing.ota_financial_summary || {}),
			show: true,
			commercialVerified: true,
			payoutFallbackReason: "",
		},
		supplierData: {
			...(existing.supplierData || {}),
			hotelRunnerEmailCommercialEvidence: built,
			otaPayoutFallbackReason: "",
		},
	};
	const verified = verifiedHotelRunnerEmailCommercialEvidence(candidate, {
		provider: built.provider,
		grossTotalSar: built.grossTotalSar,
		currency: "SAR",
	});
	if (!verified || clean(verified.evidenceHash) !== clean(built.evidenceHash)) {
		return null;
	}
	return { ...built };
}

/**
 * Loads only the exact inbound-email audit referenced by the existing
 * reservation and decides whether it is safe to bridge HotelRunner's source
 * currency/amount semantics to that already-created PMS record.
 */
async function loadHotelRunnerEmailCommercialBridge(
	{ existing = {}, normalized = {}, provider = "" } = {},
	{ InboundEmailModel } = {}
) {
	const reject = (reason) => ({ ok: false, reason, amountRole: "" });
	// Prefer the immutable creation-audit reference. A later modification or
	// cancellation email may legitimately replace `otaLastInboundEmailId`, but
	// it must never become the source of original gross/payout evidence.
	const inboundEmailId =
		existing?.supplierData?.otaInboundEmailId ||
		existing?.supplierData?.otaLastInboundEmailId;
	if (!id(inboundEmailId)) return reject("missing_inbound_email_reference");

	const lookup = await executeProjectedLookup(
		InboundEmailModel || DefaultInboundEmailModel,
		inboundEmailId
	);
	if (lookup.error) return reject(lookup.error);
	const record = lookup.record;
	if (!record) return reject("inbound_email_not_found");
	if (id(record._id) !== id(inboundEmailId)) {
		return reject("inbound_email_reference_mismatch");
	}
	if (
		id(record.reservationMongoId) !== id(existing._id) ||
		record.hasReservationConnection !== true
	) {
		return reject("reservation_link_mismatch");
	}
	if (
		lower(record.processingStatus) !== "created" ||
		!CREATION_ACTIONS.has(lower(record.automationAction))
	) {
		return reject("inbound_email_not_creation");
	}

	const inbound = record.normalizedReservation || {};
	if (
		id(inbound.inboundEmailId) &&
		id(inbound.inboundEmailId) !== id(record._id)
	) {
		return reject("inbound_email_reference_mismatch");
	}
	if (
		(providerKey(record.provider) &&
			providerKey(record.provider) !== providerKey(inbound.provider)) ||
		(lower(record.confirmationNumber) &&
			lower(record.confirmationNumber) !==
				lower(inbound.confirmationNumber || inbound.reservationId))
	) {
		return reject("provider_identity_mismatch");
	}
	if (
		inbound.sourceSenderTrusted !== true ||
		inbound.sourceSenderAuthenticated !== true
	) {
		return reject("source_not_authenticated");
	}
	if (inbound.requiresManualReview === true) {
		return reject("source_requires_manual_review");
	}
	const sourcePresence = inbound.sourcePresence || {};
	if (
		!["confirmationNumber", "checkinDate", "checkoutDate", "roomCount", "amount"].every(
			(field) => sourcePresence[field] === true
		)
	) {
		return reject("source_facts_incomplete");
	}
	if (!exactIdentityMatches({ existing, inbound, normalized, provider })) {
		return reject("provider_identity_mismatch");
	}

	const hotelRunnerCheckin = dateKey(normalized.checkinDate);
	const hotelRunnerCheckout = dateKey(normalized.checkoutDate);
	if (
		!hotelRunnerCheckin ||
		!hotelRunnerCheckout ||
		dateKey(inbound.checkinDate) !== hotelRunnerCheckin ||
		dateKey(inbound.checkoutDate) !== hotelRunnerCheckout ||
		dateKey(existing.checkin_date) !== hotelRunnerCheckin ||
		dateKey(existing.checkout_date) !== hotelRunnerCheckout
	) {
		return reject("stay_mismatch");
	}

	const hotelRunnerRoomCount = roomCountFromHotelRunner(normalized);
	const inboundRoomCount = Number(inbound.roomCount);
	const existingRoomCount = Number(existing.total_rooms);
	if (
		!hotelRunnerRoomCount ||
		!Number.isSafeInteger(inboundRoomCount) ||
		!Number.isSafeInteger(existingRoomCount) ||
		inboundRoomCount !== hotelRunnerRoomCount ||
		existingRoomCount !== hotelRunnerRoomCount
	) {
		return reject("room_count_mismatch");
	}

	const sourceCurrency = upper(
		inbound.sourceCurrency || inbound.paymentSummary?.sourceCurrency
	);
	const hotelRunnerCurrency = upper(normalized.currency);
	if (!sourceCurrency || sourceCurrency !== hotelRunnerCurrency) {
		return reject("currency_mismatch");
	}
	const paymentSourceCurrency = upper(inbound.paymentSummary?.sourceCurrency);
	if (paymentSourceCurrency && paymentSourceCurrency !== sourceCurrency) {
		return reject("currency_mismatch");
	}

	const sourceAmount = positiveAmount(inbound.sourceAmount);
	const summaryGross = positiveAmount(
		inbound.paymentSummary?.sourceTotalGuestPaymentAmount
	);
	if (!sourceAmount || (summaryGross && !amountMatches(sourceAmount, summaryGross))) {
		return reject("source_amount_invalid");
	}
	const totalCents = Number(normalized.totalCents);
	const hotelRunnerAmount = Number.isSafeInteger(totalCents) && totalCents > 0
		? round2(totalCents / 100)
		: null;
	if (!hotelRunnerAmount) return reject("hotelrunner_amount_invalid");

	const evidence = explicitCommercialEvidence(existing, inbound, record._id);
	const grossTotalSar = positiveAmount(
		evidence?.grossTotalSar ?? inbound.totalAmountSar
	);
	const base = {
		ok: true,
		reason: "",
		grossTotalSar,
		sourceCurrency,
		sourceAmount,
		hotelRunnerAmount,
		evidence: evidence || null,
	};
	if (amountMatches(hotelRunnerAmount, sourceAmount)) {
		return { ...base, amountRole: "gross" };
	}

	const sourcePayout = positiveAmount(
		inbound.paymentSummary?.sourceTotalPayoutAmount
	);
	if (sourcePayout && amountMatches(hotelRunnerAmount, sourcePayout)) {
		if (providerKey(provider) !== "agoda") {
			return reject("payout_role_not_supported");
		}
		if (!evidence) return reject("payout_evidence_required");
		return { ...base, amountRole: "payout" };
	}
	return reject("amount_mismatch");
}

module.exports = {
	HOTELRUNNER_EMAIL_COMMERCIAL_BRIDGE_PROJECTION,
	loadHotelRunnerEmailCommercialBridge,
};
