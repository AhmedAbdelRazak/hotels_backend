/** @format */

const crypto = require("crypto");
const DefaultInboundEmailModel = require("../models/inbound_email");
const DefaultFallbackJobModel = require("../models/hotelrunner_ota_fallback_job");
const {
	agodaMultiRoomAllocationReviewAllowsCommercialOnly,
	buildHotelRunnerEmailCommercialEvidence,
	decimalMoneyCents,
	directEmailRoomLabelMatchesProjectedSource,
	resolveHotel,
	resolveRoomMatch,
	verifiedHotelRunnerEmailCommercialEvidence,
} = require("./otaReservationMapper");
const {
	canonicalConfirmation,
	canonicalProvider,
	hashStable,
	validateArchivedDirectOtaEmail,
} = require("./hotelrunnerFirstOtaFallback");

const AMOUNT_TOLERANCE = 0.02;
const HOTELRUNNER_QUEUED_PROPERTY_MONEY_MAX_DRIFT_CENTS = 50;
const CREATION_ACTIONS = new Set(["created", "created_unmapped_ota_review"]);
const LEGACY_HOTELRUNNER_EVIDENCE_INVALIDATION =
	"hotelrunner_commercial_evidence_stale";
const ACTIVE_QUEUED_BRIDGE_JOB_STATES = new Set([
	"awaiting_hotelrunner",
	"processing",
	"retry",
]);

const HOTELRUNNER_QUEUED_EMAIL_COMMERCIAL_JOB_PROJECTION = [
	"_id",
	"hotelId",
	"provider",
	"lookupConfirmationNumber",
	"lookupConfirmationHash",
	"confirmationNumber",
	"identityKey",
	"hrIdFingerprint",
	"inboundEmailId",
	"inboundEmailHash",
	"normalizedReservationHash",
	"resolvedHotelProofHash",
	"archiveFingerprint",
	"status",
	"identityConflict",
	"leaseOwner",
	"leaseToken",
	"leaseAcquiredAt",
	"leaseUntil",
].join(" ");

// The queue fingerprint covers the complete normalized work item, so this
// projection intentionally loads that one immutable object. It still excludes
// raw message bodies, addresses, subjects, attachments, and payment secrets.
const HOTELRUNNER_QUEUED_EMAIL_COMMERCIAL_AUDIT_PROJECTION = [
	"_id",
	"hotelId",
	"provider",
	"confirmationNumber",
	"intent",
	"eventType",
	"emailHash",
	"senderAuthentication",
	"reservationMongoId",
	"hasReservationConnection",
	"processingStatus",
	"automationAction",
	"hotelRunnerFirstFallback",
	"normalizedReservation",
].join(" ");

// Intentionally excludes message bodies, addresses, subjects, guest details,
// payment credentials, and every other field that is not needed for this gate.
const HOTELRUNNER_EMAIL_COMMERCIAL_BRIDGE_PROJECTION = [
	"_id",
	"hotelId",
	"provider",
	"confirmationNumber",
	"intent",
	"eventType",
	"emailHash",
	"senderAuthentication",
	"reservationMongoId",
	"hasReservationConnection",
	"processingStatus",
	"automationAction",
	"hotelRunnerFirstFallback",
	"normalizedReservation.inboundEmailId",
	"normalizedReservation.provider",
	"normalizedReservation.trustedTransportProvider",
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
	"normalizedReservation.propertyCurrency",
	"normalizedReservation.propertyConversionVerified",
	"normalizedReservation.currencyConversionEvidence",
	"normalizedReservation.totalPayoutSar",
	"normalizedReservation.netAfterExpensesTotal",
	"normalizedReservation.otaCommissionSar",
	"normalizedReservation.otaCommissionCurrency",
	"normalizedReservation.otaCommissionSource",
	"normalizedReservation.otaDeductionConflict",
	"normalizedReservation.otaDeductionComponents",
	"normalizedReservation.targetedPromotionsLabelPresent",
	"normalizedReservation.nightlyPricingSource",
	"normalizedReservation.nightlyPricingSar",
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
	"normalizedReservation.source.textHash",
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

function rematerializeBoundedVerifiedPropertyMoney(inbound = {}, evidence = {}) {
	const paymentSummary = inbound.paymentSummary || {};
	if (
		Number(evidence.version) !== 2 ||
		evidence.verified !== true ||
		upper(evidence.currency) !== "SAR" ||
		inbound.propertyConversionVerified !== true ||
		upper(inbound.sourceCurrency || paymentSummary.sourceCurrency) === "SAR"
	) {
		return inbound;
	}
	const grossCents = decimalMoneyCents(evidence.grossTotalSar);
	const payoutCents = decimalMoneyCents(evidence.payoutTotalSar);
	if (
		!Number.isSafeInteger(grossCents) ||
		grossCents <= 0 ||
		!Number.isSafeInteger(payoutCents) ||
		payoutCents <= 0
	) {
		return inbound;
	}
	const derivedAmounts = [
		[inbound.amount, grossCents],
		[inbound.totalAmountSar, grossCents],
		[paymentSummary.totalGuestPaymentAmount, grossCents],
		[inbound.totalPayoutSar, payoutCents],
		[inbound.netAfterExpensesTotal, payoutCents],
		[paymentSummary.totalPayoutAmount, payoutCents],
	]
		.filter(([value]) => value !== null && value !== undefined && value !== "")
		.map(([value, expected]) => {
			const actual = decimalMoneyCents(value);
			return Number.isSafeInteger(actual) ? actual - expected : null;
		});
	if (
		!derivedAmounts.length ||
		derivedAmounts.some(
			(drift) =>
				!Number.isSafeInteger(drift) ||
				Math.abs(drift) >
					HOTELRUNNER_QUEUED_PROPERTY_MONEY_MAX_DRIFT_CENTS
		) ||
		!derivedAmounts.some((drift) => drift !== 0)
	) {
		return inbound;
	}
	const gross = grossCents / 100;
	const payout = payoutCents / 100;
	// Queued audits may contain small derived property-money differences. The
	// immutable source amounts and trusted conversion evidence were already
	// validated before this point, so rematerialize only a bounded SAR 0.50
	// drift per derived alias in memory; the archived audit remains untouched.
	return {
		...inbound,
		amount: gross,
		totalAmountSar: gross,
		totalPayoutSar: payout,
		netAfterExpensesTotal: payout,
		paymentSummary: {
			...paymentSummary,
			totalGuestPaymentAmount: gross,
			totalPayoutAmount: payout,
		},
	};
}

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
	if (["agoda", "agodacom", "agodaycs5"].includes(compact)) return "agoda";
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

async function executeProjectedLookup(
	InboundEmailModel,
	inboundEmailId,
	projection = HOTELRUNNER_EMAIL_COMMERCIAL_BRIDGE_PROJECTION
) {
	if (!InboundEmailModel || typeof InboundEmailModel.findById !== "function") {
		return { error: "inbound_email_model_required" };
	}
	try {
		let query = InboundEmailModel.findById(inboundEmailId);
		if (query && typeof query.select === "function") {
			query = query.select(projection);
		}
		if (query && typeof query.lean === "function") query = query.lean();
		const record = query && typeof query.exec === "function" ? await query.exec() : await query;
		return { record };
	} catch (_error) {
		return { error: "inbound_email_lookup_failed" };
	}
}

async function executeProjectedJobLookup(JobModel, filter) {
	if (!JobModel || typeof JobModel.find !== "function") {
		return { error: "fallback_job_model_required" };
	}
	try {
		let query = JobModel.find(filter);
		if (query && typeof query.select === "function") {
			query = query.select(HOTELRUNNER_QUEUED_EMAIL_COMMERCIAL_JOB_PROJECTION);
		}
		if (query && typeof query.sort === "function") query = query.sort({ _id: 1 });
		if (query && typeof query.limit === "function") query = query.limit(2);
		if (query && typeof query.lean === "function") query = query.lean();
		const records =
			query && typeof query.exec === "function" ? await query.exec() : await query;
		return { records: Array.isArray(records) ? records : [] };
	} catch (_error) {
		return { error: "fallback_job_lookup_failed" };
	}
}

const validSha256 = (value) => /^[a-f0-9]{64}$/.test(lower(value));

function exactSha256(left, right) {
	const actual = lower(left);
	const expected = lower(right);
	if (!validSha256(actual) || !validSha256(expected)) {
		return false;
	}
	const actualBuffer = Buffer.from(actual, "hex");
	const expectedBuffer = Buffer.from(expected, "hex");
	return (
		actualBuffer.length === expectedBuffer.length &&
		crypto.timingSafeEqual(actualBuffer, expectedBuffer)
	);
}

const sha256 = (value) =>
	crypto.createHash("sha256").update(String(value), "utf8").digest("hex");

function validDate(value) {
	const parsed = value instanceof Date ? value : new Date(value || "");
	return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function activeQueuedBridgeJob(job = {}, now = new Date()) {
	const status = lower(job.status);
	if (!ACTIVE_QUEUED_BRIDGE_JOB_STATES.has(status)) {
		return false;
	}
	const leaseUntil = validDate(job.leaseUntil);
	const leaseActive = Boolean(leaseUntil && leaseUntil.getTime() > now.getTime());
	if (status === "processing") {
		const leaseAcquiredAt = validDate(job.leaseAcquiredAt);
		return Boolean(
			leaseActive &&
			clean(job.leaseOwner) &&
			clean(job.leaseToken) &&
			leaseAcquiredAt &&
			leaseAcquiredAt.getTime() <= now.getTime() + 5 * 60 * 1000
		);
	}
	// Awaiting/retry jobs are coordinator-owned by identity, not by a processing
	// lease. A stray live lease on either state is inconsistent and fails closed.
	return !leaseActive;
}

function exactHotelRunnerQueuedIdentity({ normalized = {}, provider = "", hotel, config }) {
	const hotelId = id(hotel?._id);
	const configuredHotelId = id(config?.hotelId);
	const canonical = canonicalProvider(provider);
	const incomingProvider = canonicalProvider(
		normalized.channel || normalized.channelDisplay || normalized.sourceDisplay
	);
	const confirmationNumber = canonicalConfirmation(normalized.providerNumber);
	if (
		!hotelId ||
		hotelId !== configuredHotelId ||
		!canonical ||
		incomingProvider !== canonical ||
		!confirmationNumber ||
		!validSha256(config?.hrIdFingerprint)
	) {
		return null;
	}
	return { hotelId, provider: canonical, confirmationNumber };
}

function hotelRunnerQueuedSourceAmount(inbound = {}, normalized = {}) {
	const paymentSummary = inbound.paymentSummary || {};
	const sourceAmount = positiveAmount(inbound.sourceAmount);
	const sourceGross = positiveAmount(
		paymentSummary.sourceTotalGuestPaymentAmount ?? sourceAmount
	);
	const sourcePayout = positiveAmount(paymentSummary.sourceTotalPayoutAmount);
	const totalCents = Number(normalized.totalCents);
	const hotelRunnerAmount =
		Number.isSafeInteger(totalCents) && totalCents > 0
			? round2(totalCents / 100)
			: null;
	if (!sourceAmount || !sourceGross || !hotelRunnerAmount) return null;
	if (!amountMatches(sourceAmount, sourceGross)) return null;
	if (amountMatches(hotelRunnerAmount, sourceGross)) {
		return { amountRole: "gross", sourceAmount, hotelRunnerAmount };
	}
	if (sourcePayout && amountMatches(hotelRunnerAmount, sourcePayout)) {
		return { amountRole: "payout", sourceAmount, hotelRunnerAmount };
	}
	return null;
}

/**
 * Loads the immutable authenticated OTA archive owned by an active
 * HotelRunner-first queue job. This phase intentionally performs no write and
 * does not authorize creation until the adapter separately verifies the exact
 * HotelRunner-to-PMS room mapping.
 */
async function loadHotelRunnerQueuedEmailCommercialBridge(
	{ normalized = {}, provider = "", hotel = null, config = {} } = {},
	{
		FallbackJobModel = DefaultFallbackJobModel,
		InboundEmailModel = DefaultInboundEmailModel,
		resolveArchivedHotel = resolveHotel,
		now = () => new Date(),
	} = {}
) {
	const reject = (reason) => ({ ok: false, reason, amountRole: "" });
	const identity = exactHotelRunnerQueuedIdentity({
		normalized,
		provider,
		hotel,
		config,
	});
	if (!identity) return reject("queued_identity_invalid");
	if (
		hotel?.activateHotel !== true ||
		hotel?.xHotelProActive !== true ||
		!id(hotel?.belongsTo) ||
		upper(hotel?.currency || "SAR") !== "SAR"
	) {
		return reject("queued_hotel_invalid");
	}

	const jobLookup = await executeProjectedJobLookup(FallbackJobModel, {
		hotelId: identity.hotelId,
		provider: identity.provider,
		confirmationNumber: identity.confirmationNumber,
	});
	if (jobLookup.error) return reject(jobLookup.error);
	if (jobLookup.records.length !== 1) {
		return reject(
			jobLookup.records.length > 1
				? "fallback_job_identity_ambiguous"
				: "fallback_job_not_found"
		);
	}
	const [job] = jobLookup.records;
	const checkedAt = validDate(now());
	if (job.identityConflict === true) {
		return reject("fallback_job_identity_conflict");
	}
	if (!checkedAt || !activeQueuedBridgeJob(job, checkedAt)) {
		return reject("fallback_job_not_active");
	}
	if (
		id(job.hotelId) !== identity.hotelId ||
		canonicalProvider(job.provider) !== identity.provider ||
		canonicalConfirmation(job.lookupConfirmationNumber) !==
			identity.confirmationNumber ||
		!exactSha256(
			job.lookupConfirmationHash,
			sha256(clean(job.lookupConfirmationNumber))
		) ||
		canonicalConfirmation(job.confirmationNumber) !==
			identity.confirmationNumber ||
		lower(job.identityKey) !==
			`${identity.provider}:${identity.confirmationNumber}` ||
		!id(job.inboundEmailId)
	) {
		return reject("fallback_job_identity_mismatch");
	}
	if (!exactSha256(job.hrIdFingerprint, config.hrIdFingerprint)) {
		return reject("fallback_job_config_mismatch");
	}

	const auditLookup = await executeProjectedLookup(
		InboundEmailModel,
		job.inboundEmailId,
		HOTELRUNNER_QUEUED_EMAIL_COMMERCIAL_AUDIT_PROJECTION
	);
	if (auditLookup.error) return reject(auditLookup.error);
	const audit = auditLookup.record;
	if (!audit || id(audit._id) !== id(job.inboundEmailId)) {
		return reject("queued_inbound_email_not_found");
	}
	const archive = validateArchivedDirectOtaEmail(audit, identity);
	if (!archive.ok) return reject(archive.code || "queued_archive_invalid");
	if (
		!exactSha256(job.inboundEmailHash, archive.inboundEmailHash) ||
		clean(job.lookupConfirmationNumber) !==
			clean(archive.lookupConfirmationNumber) ||
		!exactSha256(
			job.lookupConfirmationHash,
			archive.lookupConfirmationHash
		) ||
		!exactSha256(
			job.normalizedReservationHash,
			archive.normalizedReservationHash
		) ||
		!exactSha256(job.resolvedHotelProofHash, archive.resolvedHotelProofHash) ||
		!exactSha256(job.archiveFingerprint, archive.archiveFingerprint)
	) {
		return reject("queued_archive_fingerprint_mismatch");
	}
	const markerJobId = id(audit.hotelRunnerFirstFallback?.jobId);
	const markerStatus = lower(audit.hotelRunnerFirstFallback?.status);
	if (
		!["archive_ready", "enqueued", "recovery_pending"].includes(
			markerStatus
		) ||
		(markerJobId && markerJobId !== id(job._id))
	) {
		return reject("queued_archive_job_reference_mismatch");
	}
	if (
		!["awaiting_hotelrunner", "parsed_awaiting_hotelrunner"].includes(
			lower(audit.processingStatus)
		) ||
		audit.hasReservationConnection === true ||
		id(audit.reservationMongoId) ||
		lower(audit.automationAction) !== "queued"
	) {
		return reject("queued_archive_lifecycle_mismatch");
	}

	const inbound = archive.normalizedReservation;
	const sourcePresence = inbound.sourcePresence || {};
	if (
		![
			"confirmationNumber",
			"hotelName",
			"roomName",
			"checkinDate",
			"checkoutDate",
			"roomCount",
			"amount",
		].every((field) => sourcePresence[field] === true)
	) {
		return reject("queued_source_facts_incomplete");
	}
	if (
		canonicalProvider(inbound.provider) !== identity.provider ||
		canonicalProvider(inbound.trustedTransportProvider) !== identity.provider ||
		canonicalConfirmation(
			inbound.confirmationNumber || inbound.reservationId
		) !== identity.confirmationNumber
	) {
		return reject("queued_provider_identity_mismatch");
	}
	if (
		dateKey(inbound.checkinDate) !== dateKey(normalized.checkinDate) ||
		dateKey(inbound.checkoutDate) !== dateKey(normalized.checkoutDate)
	) {
		return reject("queued_stay_mismatch");
	}
	const hotelRunnerRoomCount = roomCountFromHotelRunner(normalized);
	if (
		!hotelRunnerRoomCount ||
		!Number.isSafeInteger(Number(inbound.roomCount)) ||
		Number(inbound.roomCount) !== hotelRunnerRoomCount
	) {
		return reject("queued_room_count_mismatch");
	}
	const sourceCurrency = upper(
		inbound.sourceCurrency || inbound.paymentSummary?.sourceCurrency
	);
	if (
		!sourceCurrency ||
		sourceCurrency !== upper(normalized.currency) ||
		(upper(inbound.paymentSummary?.sourceCurrency) &&
			upper(inbound.paymentSummary?.sourceCurrency) !== sourceCurrency)
	) {
		return reject("queued_currency_mismatch");
	}
	const sourceAmounts = hotelRunnerQueuedSourceAmount(inbound, normalized);
	if (!sourceAmounts) return reject("queued_amount_mismatch");

	let resolvedHotel;
	try {
		resolvedHotel = await resolveArchivedHotel(inbound, null);
	} catch (_error) {
		return reject("queued_hotel_lookup_failed");
	}
	if (
		!resolvedHotel ||
		id(resolvedHotel._id) !== identity.hotelId ||
		id(resolvedHotel.belongsTo) !== id(hotel.belongsTo) ||
		upper(resolvedHotel.currency || "SAR") !==
			upper(hotel.currency || "SAR") ||
		resolvedHotel.activateHotel !== true ||
		resolvedHotel.xHotelProActive !== true
	) {
		return reject("queued_hotel_mismatch");
	}
	const currentResolvedHotelProof = {
		version: 1,
		hotelId: identity.hotelId,
		belongsTo: id(hotel.belongsTo),
		currency: upper(hotel.currency || "SAR"),
		activateHotel: hotel.activateHotel === true,
		xHotelProActive: hotel.xHotelProActive === true,
	};
	if (
		!currentResolvedHotelProof.belongsTo ||
		currentResolvedHotelProof.currency !== "SAR" ||
		currentResolvedHotelProof.activateHotel !== true ||
		currentResolvedHotelProof.xHotelProActive !== true ||
		!exactSha256(
			hashStable(currentResolvedHotelProof),
			archive.resolvedHotelProofHash
		) ||
		!exactSha256(
			hashStable(currentResolvedHotelProof),
			job.resolvedHotelProofHash
		)
	) {
		return reject("queued_hotel_proof_mismatch");
	}
	const evidence = buildHotelRunnerEmailCommercialEvidence(inbound, {
		appliedAt: checkedAt,
	});
	if (
		!evidence ||
		canonicalProvider(evidence.provider) !== identity.provider ||
		lower(evidence.otaIdentityKey) !==
			`${identity.provider}:${identity.confirmationNumber}` ||
		id(evidence.inboundEmailId) !== id(audit._id) ||
		!exactSha256(evidence.sourceTextHash, inbound.source?.textHash)
	) {
		return reject("queued_commercial_evidence_invalid");
	}
	const materializedInbound = rematerializeBoundedVerifiedPropertyMoney(
		inbound,
		evidence
	);

	return {
		ok: true,
		reason: "",
		...sourceAmounts,
		grossTotalSar: positiveAmount(evidence.grossTotalSar),
		sourceCurrency,
		evidence,
		jobId: id(job._id),
		inboundEmailId: id(audit._id),
		inboundEmailHash: lower(archive.inboundEmailHash),
		normalizedReservationHash: lower(archive.normalizedReservationHash),
		resolvedHotelProofHash: lower(archive.resolvedHotelProofHash),
		archiveFingerprint: lower(archive.archiveFingerprint),
		normalizedReservation: materializedInbound,
	};
}

function validateHotelRunnerQueuedEmailCommercialBridgeRooms(
	bridge = {},
	{ hotel = null, resolvedRooms = [] } = {},
	{ resolveArchivedRoom = resolveRoomMatch } = {}
) {
	const reject = (reason) => ({ ok: false, reason, amountRole: "" });
	if (bridge?.ok !== true || !bridge.evidence) {
		return reject(bridge?.reason || "queued_bridge_missing");
	}
	const inbound = bridge.normalizedReservation;
	if (!inbound || !hotel || !Array.isArray(resolvedRooms)) {
		return reject("queued_room_context_missing");
	}
	const declaredRoomCount = Number(inbound.roomCount);
	if (
		!Number.isSafeInteger(declaredRoomCount) ||
		declaredRoomCount < 1 ||
		resolvedRooms.length !== declaredRoomCount
	) {
		return reject("queued_room_block_invalid");
	}
	const configuredRoomIds = new Set(
		(hotel.roomCountDetails || [])
			.filter((room) => room?.activeRoom !== false && id(room?._id))
			.map((room) => id(room._id))
	);
	const resolvedRoomIds = resolvedRooms.map((resolved) =>
		id(resolved?.roomDetails?._id)
	);
	const resolvedMappingIds = resolvedRooms.map((resolved) =>
		id(resolved?.mapping?.localRoomConfigId)
	);
	if (
		resolvedRoomIds.some(
			(roomId, index) =>
				!roomId ||
				!configuredRoomIds.has(roomId) ||
				resolvedMappingIds[index] !== roomId
		)
	) {
		return reject("queued_room_identity_mismatch");
	}
	if (agodaMultiRoomAllocationReviewAllowsCommercialOnly(inbound)) {
		// The exact sole Agoda allocation warning proves commercial totals but not
		// per-room types. HotelRunner's verified inv_code mappings own allocation;
		// the email may not override or partially select those rooms.
		return { ...bridge };
	}
	const exactProjectedSourceRoomMatch = resolvedRooms.every((resolved) =>
		[
			resolved?.sourceRoom?.namePresentation,
			resolved?.sourceRoom?.name,
		]
			.filter(Boolean)
			.some((label) =>
				directEmailRoomLabelMatchesProjectedSource(inbound.roomName, label)
			)
	);
	if (exactProjectedSourceRoomMatch) {
		// HotelRunner's inv_code mapping already owns PMS room allocation. An
		// exact OTA label plus known commercial suffixes may prove that the email
		// belongs to those API rooms without letting the email choose a room.
		return { ...bridge };
	}
	let roomMatch;
	try {
		roomMatch = resolveArchivedRoom(hotel, inbound.roomName, {
			normalized: inbound,
		});
	} catch (_error) {
		return reject("queued_room_lookup_failed");
	}
	const expectedRoomId = id(roomMatch?.roomDetails?._id);
	if (
		!expectedRoomId ||
		resolvedRoomIds.some((roomId) => roomId !== expectedRoomId)
	) {
		return reject("queued_room_identity_mismatch");
	}
	return { ...bridge };
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

function queuedApiCreationAuditMatches(existing = {}, record = {}, inboundEmailId) {
	const provenance =
		existing?.supplierData?.hotelRunnerFirstFallbackCommercialBridge;
	if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) {
		return false;
	}
	return Boolean(
		Number(provenance.version) === 1 &&
		id(provenance.jobId) &&
		id(provenance.jobId) === id(record.hotelRunnerFirstFallback?.jobId) &&
		id(provenance.inboundEmailId) === id(inboundEmailId) &&
		exactSha256(provenance.inboundEmailHash, record.emailHash) &&
		validSha256(provenance.normalizedReservationHash) &&
		validSha256(provenance.resolvedHotelProofHash) &&
		validSha256(provenance.archiveFingerprint) &&
		lower(record.hotelRunnerFirstFallback?.status) === "completed_api" &&
		lower(record.intent) === "new_reservation" &&
		lower(record.eventType) === "new" &&
		clean(existing?.supplierData?.hotelRunner?.transport).toLowerCase() ===
			"hotelrunner_api" &&
		Number(existing?.supplierData?.otaSourceAuthority) === 4 &&
		clean(existing?.supplierData?.otaAutomationPipeline).toLowerCase() ===
			"hotelrunner-background-worker"
	);
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
	const ordinaryEmailCreation = Boolean(
		lower(record.processingStatus) === "created" &&
			CREATION_ACTIONS.has(lower(record.automationAction))
	);
	const queuedApiCreation = queuedApiCreationAuditMatches(
		existing,
		record,
		inboundEmailId
	);
	if (!ordinaryEmailCreation && !queuedApiCreation) {
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
	if (
		inbound.requiresManualReview === true &&
		!(
			queuedApiCreation &&
			agodaMultiRoomAllocationReviewAllowsCommercialOnly(inbound)
		)
	) {
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
	// A provider/source amount can still prove transport identity without proving
	// property money. Never surface a stored fallback conversion as commercial
	// SAR: only the fully verified evidence contract may provide this value.
	const grossTotalSar = positiveAmount(evidence?.grossTotalSar);
	const base = {
		ok: true,
		reason: "",
		grossTotalSar,
		sourceCurrency,
		sourceAmount,
		hotelRunnerAmount,
		evidence: evidence || null,
	};
	const sourceGross = positiveAmount(
		inbound.paymentSummary?.sourceTotalGuestPaymentAmount
	);
	if (amountMatches(hotelRunnerAmount, sourceGross || sourceAmount)) {
		// An authenticated HotelRunner relay proves that the two transports refer
		// to the same source amount, but it does not prove the commercial role of
		// that amount. Only provider-authenticated evidence may promote it to gross.
		return { ...base, amountRole: evidence ? "gross" : "unknown" };
	}

	const sourcePayout = positiveAmount(
		inbound.paymentSummary?.sourceTotalPayoutAmount
	);
	if (sourcePayout && amountMatches(hotelRunnerAmount, sourcePayout)) {
		if (!evidence) return reject("payout_evidence_required");
		return { ...base, amountRole: "payout" };
	}
	return reject("amount_mismatch");
}

module.exports = {
	ACTIVE_QUEUED_BRIDGE_JOB_STATES,
	HOTELRUNNER_EMAIL_COMMERCIAL_BRIDGE_PROJECTION,
	HOTELRUNNER_QUEUED_EMAIL_COMMERCIAL_AUDIT_PROJECTION,
	HOTELRUNNER_QUEUED_EMAIL_COMMERCIAL_JOB_PROJECTION,
	loadHotelRunnerEmailCommercialBridge,
	loadHotelRunnerQueuedEmailCommercialBridge,
	validateHotelRunnerQueuedEmailCommercialBridgeRooms,
};
