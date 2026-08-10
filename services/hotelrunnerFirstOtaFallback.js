/** @format */

const crypto = require("crypto");
const os = require("os");
const mongoose = require("mongoose");

const HotelRunnerOtaFallbackJob = require("../models/hotelrunner_ota_fallback_job");
const HotelRunnerEvent = require("../models/hotelrunner_event");
const HotelRunnerReservation = require("../models/hotelrunner_reservation");
const InboundEmail = require("../models/inbound_email");
const Reservations = require("../models/reservations");
const HotelDetails = require("../models/hotel_details");
const { hasDirectHotelRunnerProjection } = require("./hotelrunnerOtaEmailBoundary");
const { createHotelRunnerClient } = require("./hotelrunnerClient");
const {
	loadConfiguredHotel,
	persistHotelRunnerDelivery,
} = require("./hotelrunnerEventService");
const {
	normalizeHotelRunnerReservation,
} = require("./hotelrunnerPayload");
const {
	hashStable,
	sha256,
	stableStringify,
} = require("./hotelrunnerFirstOtaFallbackCanonical");
const {
	reservationHasExactHotelRunnerFirstFallbackCreationMarker,
} = require("./hotelrunnerFirstOtaFallbackProvenance");
const {
	isLateEvidenceIdleFailure,
} = require("./hotelrunnerLateEvidencePolicy");

const DEFAULT_GRACE_MS = 180 * 1000;
const MIN_GRACE_MS = 30 * 1000;
const MAX_GRACE_MS = 15 * 60 * 1000;
const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const MIN_LEASE_MS = 30 * 1000;
const MAX_LEASE_MS = 15 * 60 * 1000;
const DEFAULT_NEGATIVE_PROOF_TTL_MS = 2 * 60 * 1000;
const MIN_NEGATIVE_PROOF_TTL_MS = 30 * 1000;
const MAX_NEGATIVE_PROOF_TTL_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 12;
const MIN_MAX_ATTEMPTS = 3;
const MAX_MAX_ATTEMPTS = 30;
const MAX_ERROR_LENGTH = 500;
const ACTIVE_JOB_STATES = [
	"awaiting_hotelrunner",
	"retry",
	"processing",
];
const ACTIVE_HOTELRUNNER_EVENT_STATES = ["pending", "processing", "retry"];
const TARGETED_LOOKUP_EVENT_MARKER_PATH =
	"result.hotelRunnerFirstFallbackTargetedLookup";
const BLOCKED_HOTELRUNNER_EVENT_STATES = new Set([
	"attention",
	"failed",
	"quarantined",
]);
const PENDING_HOTELRUNNER_EVENT_STATES = new Set(
	ACTIVE_HOTELRUNNER_EVENT_STATES
);
const COMPLETED_MIRROR_STATES = new Set(["created", "updated", "cancelled"]);
const BLOCKED_MIRROR_STATES = new Set(["quarantined"]);
const DIRECT_OTA_PROVIDERS = new Set([
	"agoda",
	"airbnb",
	"booking",
	"expedia",
	"hotels",
	"trip",
]);
const PROVIDER_ALIASES = new Map([
	["agoda", "agoda"],
	["agodacom", "agoda"],
	["agodaycs5", "agoda"],
	["airbnb", "airbnb"],
	["airbnbcom", "airbnb"],
	["booking", "booking"],
	["bookingcom", "booking"],
	["expedia", "expedia"],
	["expediacom", "expedia"],
	["hotels", "hotels"],
	["hotelscom", "hotels"],
	["trip", "trip"],
	["tripcom", "trip"],
	["ctrip", "trip"],
	["ctripcom", "trip"],
	// Transport-only namespace. buildIdentity still rejects this because it is
	// deliberately absent from DIRECT_OTA_PROVIDERS.
	["hotelrunner", "hotelrunner"],
	["hotelrunnercom", "hotelrunner"],
]);

let fallbackIndexesPromise = null;

class HotelRunnerFirstFallbackError extends Error {
	constructor(message, { code, retryable = false } = {}) {
		super(message);
		this.name = "HotelRunnerFirstFallbackError";
		this.code = code || "HOTELRUNNER_FIRST_FALLBACK_ERROR";
		this.retryable = retryable === true;
	}
}

const clean = (value = "") => String(value == null ? "" : value).trim();
const lower = (value = "") => clean(value).toLowerCase();
const stringId = (value) => clean(value?._id || value);
const validSha256 = (value) => /^[a-f0-9]{64}$/.test(lower(value));
const safeDate = (value) => {
	const parsed = value instanceof Date ? new Date(value) : new Date(value || "");
	return Number.isFinite(parsed.getTime()) ? parsed : null;
};
const boundedInteger = (value, fallback, min, max) => {
	const parsed = Number.parseInt(String(value ?? ""), 10);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(max, Math.max(min, parsed));
};
const mutationMatched = (result) =>
	Number(result?.matchedCount ?? result?.n ?? 0) === 1;

function safeErrorMessage(error, fallback = "HotelRunner-first fallback failed.") {
	return clean(error?.message || error || fallback)
		.replace(/[\r\n\t]+/g, " ")
		.replace(
			/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi,
			"$1[REDACTED]@"
		)
		.replace(
			/(token|hr_id|authorization|cookie)\s*[=:]\s*[^\s,&]+/gi,
			"$1=[REDACTED]"
		)
		.slice(0, MAX_ERROR_LENGTH);
}

const randomHex = (bytes = 16) => crypto.randomBytes(bytes).toString("hex");

function canonicalProvider(value = "") {
	const key = lower(value)
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, "");
	return PROVIDER_ALIASES.get(key) || "";
}

function canonicalConfirmation(value = "") {
	const confirmation = lower(value).replace(/\s+/g, " ");
	if (
		!confirmation ||
		confirmation.length > 256 ||
		/[\u0000-\u001f\u007f]/.test(confirmation)
	) {
		return "";
	}
	return confirmation;
}

function buildIdentity({ hotelId, provider, confirmationNumber } = {}) {
	const normalizedHotelId = stringId(hotelId).toLowerCase();
	const normalizedProvider = canonicalProvider(provider);
	const normalizedConfirmation = canonicalConfirmation(confirmationNumber);
	if (!mongoose.Types.ObjectId.isValid(normalizedHotelId)) {
		throw new HotelRunnerFirstFallbackError(
			"A valid configured HotelRunner hotel is required.",
			{ code: "HOTELRUNNER_FALLBACK_HOTEL_INVALID" }
		);
	}
	if (!DIRECT_OTA_PROVIDERS.has(normalizedProvider)) {
		throw new HotelRunnerFirstFallbackError(
			"The OTA provider is not eligible for direct-email fallback.",
			{ code: "HOTELRUNNER_FALLBACK_PROVIDER_INVALID" }
		);
	}
	if (!normalizedConfirmation) {
		throw new HotelRunnerFirstFallbackError(
			"A canonical OTA confirmation number is required.",
			{ code: "HOTELRUNNER_FALLBACK_CONFIRMATION_INVALID" }
		);
	}
	return {
		hotelId: normalizedHotelId,
		provider: normalizedProvider,
		confirmationNumber: normalizedConfirmation,
		identityKey: `${normalizedProvider}:${normalizedConfirmation}`,
	};
}

function normalizedResolvedHotelProof(value = {}) {
	const hotelId = stringId(value.hotelId).toLowerCase();
	const belongsTo = stringId(value.belongsTo).toLowerCase();
	const currency = clean(value.currency).toUpperCase();
	if (
		Number(value.version) !== 1 ||
		!mongoose.Types.ObjectId.isValid(hotelId) ||
		!mongoose.Types.ObjectId.isValid(belongsTo) ||
		!/^[A-Z]{3}$/.test(currency) ||
		value.activateHotel !== true ||
		value.xHotelProActive !== true
	) {
		return null;
	}
	return {
		version: 1,
		hotelId,
		belongsTo,
		currency,
		activateHotel: true,
		xHotelProActive: true,
	};
}

const resolvedHotelProofFromHotel = (hotel = {}) =>
	normalizedResolvedHotelProof({
		version: 1,
		hotelId: hotel._id,
		belongsTo: hotel.belongsTo,
		currency: hotel.currency || "SAR",
		activateHotel: hotel.activateHotel === true,
		xHotelProActive: hotel.xHotelProActive === true,
	});

function createArchiveFingerprint({ identity, audit } = {}) {
	const normalizedReservation = audit?.normalizedReservation;
	const normalizedReservationHash = hashStable(normalizedReservation);
	const inboundEmailHash = lower(audit?.emailHash);
	const inboundEmailId = stringId(audit?._id).toLowerCase();
	const lookupConfirmationNumber = clean(
		normalizedReservation?.confirmationNumber ||
			normalizedReservation?.reservationId
	);
	const lookupConfirmationHash = sha256(lookupConfirmationNumber);
	const resolvedHotelProof = normalizedResolvedHotelProof(
		audit?.hotelRunnerFirstFallback?.resolvedHotelProof
	);
	if (!resolvedHotelProof || resolvedHotelProof.hotelId !== identity.hotelId) {
		throw new HotelRunnerFirstFallbackError(
			"The archived email is missing its immutable resolved-hotel proof.",
			{ code: "HOTELRUNNER_FALLBACK_RESOLVED_HOTEL_PROOF_INVALID" }
		);
	}
	const resolvedHotelProofHash = hashStable(resolvedHotelProof);
	const archiveFingerprint = hashStable({
		hotelId: identity.hotelId,
		provider: identity.provider,
		confirmationNumber: identity.confirmationNumber,
		lookupConfirmationNumber,
		lookupConfirmationHash,
		inboundEmailId,
		inboundEmailHash,
		normalizedReservationHash,
		resolvedHotelProofHash,
	});
	return {
		inboundEmailId,
		inboundEmailHash,
		lookupConfirmationNumber,
		lookupConfirmationHash,
		resolvedHotelProof,
		normalizedReservationHash,
		resolvedHotelProofHash,
		archiveFingerprint,
	};
}

function validateArchivedDirectOtaEmail(audit, expected = {}) {
	if (!audit || typeof audit !== "object" || !audit._id) {
		return { ok: false, code: "archived_email_not_found" };
	}
	let identity;
	try {
		identity = buildIdentity(expected);
	} catch (error) {
		return { ok: false, code: lower(error?.code) || "identity_invalid" };
	}
	if (stringId(audit.hotelId).toLowerCase() !== identity.hotelId) {
		return { ok: false, code: "archived_email_hotel_mismatch" };
	}
	const normalized = audit.normalizedReservation;
	if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
		return { ok: false, code: "normalized_reservation_missing" };
	}
	const providers = [audit.provider, normalized.provider].map(canonicalProvider);
	if (providers.some((provider) => provider !== identity.provider)) {
		return { ok: false, code: "archived_email_provider_mismatch" };
	}
	const confirmations = [
		audit.confirmationNumber,
		normalized.confirmationNumber || normalized.reservationId,
	].map(canonicalConfirmation);
	if (
		confirmations.some(
			(confirmation) => confirmation !== identity.confirmationNumber
		)
	) {
		return { ok: false, code: "archived_email_confirmation_mismatch" };
	}
	if (lower(audit.intent) !== "new_reservation" || lower(normalized.intent) !== "new_reservation") {
		return { ok: false, code: "archived_email_not_new_reservation" };
	}
	if (lower(audit.eventType) !== "new" || lower(normalized.eventType) !== "new") {
		return { ok: false, code: "archived_email_not_new_event" };
	}
	const authentication = audit.senderAuthentication || {};
	if (
		authentication.authenticatedAligned !== true ||
		canonicalProvider(authentication.trustedProvider) !== identity.provider ||
		normalized.sourceSenderAuthenticated !== true ||
		canonicalProvider(normalized.trustedTransportProvider) !== identity.provider
	) {
		return { ok: false, code: "archived_email_not_authenticated_direct_ota" };
	}
	const sourcePresence = normalized.sourcePresence || {};
	if (
		normalized.sourceSenderTrusted !== true ||
		sourcePresence.hotelName !== true ||
		(sourcePresence.confirmationNumber !== true &&
			sourcePresence.reservationId !== true) ||
		!clean(normalized.hotelName || normalized.hotelId) ||
		!validSha256(normalized?.source?.textHash) ||
		!safeDate(normalized?.source?.receivedAt)
	) {
		return { ok: false, code: "archived_email_source_facts_incomplete" };
	}
	if (
		!normalized.inboundEmailId ||
		stringId(normalized.inboundEmailId) !== stringId(audit._id)
	) {
		return { ok: false, code: "normalized_inbound_email_id_mismatch" };
	}
	if (!validSha256(audit.emailHash)) {
		return { ok: false, code: "archived_email_hash_invalid" };
	}
	const eligibleStatuses = new Set([
		"parsed_awaiting_hotelrunner",
		"awaiting_hotelrunner",
	]);
	if (!eligibleStatuses.has(lower(audit.processingStatus))) {
		return { ok: false, code: "archived_email_status_ineligible" };
	}
	let fingerprints;
	try {
		fingerprints = createArchiveFingerprint({ identity, audit });
	} catch (error) {
		return {
			ok: false,
			code: lower(error?.code) || "archived_email_hash_failed",
		};
	}
	return {
		ok: true,
		identity,
		normalizedReservation: normalized,
		...fingerprints,
	};
}

function retryDelayMs(attemptCount, random = Math.random) {
	const exponent = Math.min(8, Math.max(0, Number(attemptCount || 1) - 1));
	const base = Math.min(30 * 60 * 1000, 5_000 * 2 ** exponent);
	const sample = Math.max(0, Math.min(1, Number(random()) || 0));
	return base + Math.floor(base * 0.1 * sample);
}

async function leanResult(query) {
	let current = query;
	if (current && typeof current.lean === "function") current = current.lean();
	return current && typeof current.exec === "function" ? current.exec() : current;
}

function identityFilter(identity) {
	return {
		hotelId: identity.hotelId,
		provider: identity.provider,
		confirmationNumber: identity.confirmationNumber,
	};
}

function leaseAvailableFilter(now) {
	return {
		$or: [
			{ leaseUntil: { $exists: false } },
			{ leaseUntil: null },
			{ leaseUntil: { $lte: now } },
		],
	};
}

function ownedJobFilter(job, now) {
	return {
		_id: job._id,
		status: "processing",
		leaseOwner: job.leaseOwner,
		leaseToken: job.leaseToken,
		archiveFingerprint: job.archiveFingerprint,
		resolvedHotelProofHash: job.resolvedHotelProofHash,
		leaseUntil: { $gt: now },
	};
}

function createMongooseJobStore({ JobModel = HotelRunnerOtaFallbackJob } = {}) {
	return {
		async upsertIdentity(document, now) {
			const filter = identityFilter(document);
			const update = {
				$setOnInsert: document,
				$set: { lastSeenAt: now },
				$inc: { seenCount: 1 },
			};
			try {
				return await leanResult(
					JobModel.findOneAndUpdate(filter, update, {
						new: true,
						upsert: true,
						setDefaultsOnInsert: true,
					})
				);
			} catch (error) {
				if (Number(error?.code) !== 11000) throw error;
				return leanResult(JobModel.findOne(filter));
			}
		},

		async recordCollision(job, collision, now) {
			const collisionUpdate = {
				$set: {
					identityConflict: true,
					lastErrorCode: "HOTELRUNNER_FALLBACK_IDENTITY_COLLISION",
					lastErrorMessage:
						"A different archived OTA email claimed the same HotelRunner fallback identity.",
				},
				$push: {
					identityCollisions: {
						$each: [collision],
						$slice: -10,
					},
				},
			};
			const inactive = await leanResult(
				JobModel.findOneAndUpdate(
					{
						_id: job._id,
						archiveFingerprint: job.archiveFingerprint,
						status: { $in: ACTIVE_JOB_STATES },
						$or: [
							{ status: { $in: ["awaiting_hotelrunner", "retry"] } },
							{ leaseUntil: { $exists: false } },
							{ leaseUntil: null },
							{ leaseUntil: { $lte: now } },
						],
					},
					{
						$set: {
							...collisionUpdate.$set,
							status: "retry",
							completedAt: null,
							nextAttemptAt: now,
							lastDecision: "identity_collision_pending_review",
						},
						$push: collisionUpdate.$push,
						$unset: {
							leaseOwner: 1,
							leaseToken: 1,
							leaseAcquiredAt: 1,
							leaseUntil: 1,
							negativeLookupProof: 1,
						},
					},
					{ new: true }
				)
			);
			if (inactive) return inactive;
			// A newly-arrived conflicting email must never revoke a live mapper
			// lease. Record the conflict for audit and let the already-owned first
			// archive finish its exact CAS transition; the conflicting audit itself
			// remains needs-review.
			const active = await leanResult(
				JobModel.findOneAndUpdate(
					{
						_id: job._id,
						archiveFingerprint: job.archiveFingerprint,
						status: "processing",
						leaseUntil: { $gt: now },
					},
					collisionUpdate,
					{ new: true }
				)
			);
			if (active) return active;
			// Terminal decisions are immutable. A later distinct archive is recorded
			// as collision evidence, but it cannot reopen or rewrite the completed
			// job (the new audit is finalized needs-review by its caller).
			return leanResult(
				JobModel.findOneAndUpdate(
					{
						_id: job._id,
						archiveFingerprint: job.archiveFingerprint,
						status: {
							$in: [
								"completed_api",
								"completed_email_fallback",
								"needs_review",
							],
						},
					},
					collisionUpdate,
					{ new: true }
				)
			);
		},

		claim({ hotelId, instanceId, leaseToken, now, leaseUntil, maxAttempts }) {
			return leanResult(
				JobModel.findOneAndUpdate(
					{
						hotelId,
						status: { $in: ACTIVE_JOB_STATES },
						attemptCount: { $lt: maxAttempts },
						nextAttemptAt: { $lte: now },
						...leaseAvailableFilter(now),
					},
					{
						$set: {
							status: "processing",
							leaseOwner: instanceId,
							leaseToken,
							leaseAcquiredAt: now,
							leaseUntil,
							lastStartedAt: now,
						},
						$inc: { attemptCount: 1 },
					},
					{ new: true, sort: { nextAttemptAt: 1, createdAt: 1 } }
				)
			);
		},

		markExhausted({
			hotelId,
			now,
			maxAttempts,
			instanceId,
			leaseToken,
			leaseUntil,
		}) {
			return leanResult(
				JobModel.findOneAndUpdate(
					{
						hotelId,
						status: { $in: ACTIVE_JOB_STATES },
						attemptCount: { $gte: maxAttempts },
						nextAttemptAt: { $lte: now },
						...leaseAvailableFilter(now),
					},
					{
						$set: {
							status: "processing",
							leaseOwner: instanceId,
							leaseToken,
							leaseAcquiredAt: now,
							leaseUntil,
							lastStartedAt: now,
						},
					},
					{ new: true, sort: { nextAttemptAt: 1, createdAt: 1 } }
				)
			);
		},

		renewOwned(job, now, leaseUntil) {
			return leanResult(
				JobModel.findOneAndUpdate(
					ownedJobFilter(job, now),
					{ $set: { leaseUntil } },
					{ new: true }
				)
			);
		},

		updateOwned(job, update, now) {
			return leanResult(
				JobModel.findOneAndUpdate(ownedJobFilter(job, now), update, {
					new: true,
				})
			);
		},

		findByIdentity(identity) {
			return leanResult(JobModel.findOne(identityFilter(identity)));
		},

		findById(jobId) {
			return leanResult(JobModel.findById(jobId));
		},

		async hasDueWork({ hotelId, now }) {
			const query = JobModel.exists({
				hotelId,
				status: { $in: ACTIVE_JOB_STATES },
				nextAttemptAt: { $lte: now },
				...leaseAvailableFilter(now),
			});
			return Boolean(
				query && typeof query.exec === "function" ? await query.exec() : await query
			);
		},
	};
}

function ensureHotelRunnerFirstFallbackIndexes(
	{ JobModel = HotelRunnerOtaFallbackJob } = {},
	{ useCachedPromise = JobModel === HotelRunnerOtaFallbackJob } = {}
) {
	if (useCachedPromise && fallbackIndexesPromise) return fallbackIndexesPromise;
	const creation = Promise.resolve().then(() => JobModel.createIndexes());
	if (!useCachedPromise) return creation;
	fallbackIndexesPromise = creation.catch((error) => {
		fallbackIndexesPromise = null;
		throw error;
	});
	return fallbackIndexesPromise;
}

function resetHotelRunnerFirstFallbackIndexesForTests() {
	fallbackIndexesPromise = null;
}

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function findManyLean(Model, filter, projection = "", sort = {}, limit = 10) {
	let query = Model.find(filter);
	if (projection && typeof query.select === "function") query = query.select(projection);
	if (sort && typeof query.sort === "function") query = query.sort(sort);
	if (limit && typeof query.limit === "function") query = query.limit(limit);
	return leanResult(query);
}

async function defaultInspectLocalHotelRunnerState(
	identity,
	{
		EventModel = HotelRunnerEvent,
		MirrorModel = HotelRunnerReservation,
		ReservationModel = Reservations,
	} = {}
) {
	const exactConfirmation = new RegExp(
		`^${escapeRegex(identity.confirmationNumber)}$`,
		"i"
	);
	const [events, mirrors] = await Promise.all([
		findManyLean(
			EventModel,
			{ hotelId: identity.hotelId, providerNumber: exactConfirmation },
			"_id hotelId status source hotelRunnerReservationId providerNumber channel reservationMongoId mirrorId receivedAt sourceUpdatedAt integrityReason integrityConflict errorCode errorMessage leaseOwner leaseUntil result",
			{ sourceUpdatedAt: -1 },
			10
		),
		findManyLean(
			MirrorModel,
			{
				hotelId: identity.hotelId,
				$or: [
					{ providerNumber: exactConfirmation },
					{ providerNumberAliases: exactConfirmation },
				],
			},
			"_id hotelId hotelRunnerReservationId providerNumber providerNumberAliases channel reservationMongoId projectionStatus identityConflict lastErrorCode lastErrorMessage",
			{ observedSourceUpdatedAt: -1 },
			10
		),
	]);
	const linkedIds = Array.from(
		new Set(
			[...(events || []), ...(mirrors || [])]
				.map((record) => stringId(record?.reservationMongoId))
				.filter(Boolean)
		)
	);
	const reservationQuery = {
		hotelId: identity.hotelId,
		$or: [
			{ otaIdentityKey: identity.identityKey },
			...(identity.provider === "trip"
				? [{ otaCrossTransportIdentityKey: identity.identityKey }]
				: []),
			{ "supplierData.hotelRunner.providerNumber": exactConfirmation },
			{
				"otaPlatformReview.confirmationNumber": exactConfirmation,
				"otaPlatformReview.provider": identity.provider,
			},
			...(linkedIds.length ? [{ _id: { $in: linkedIds } }] : []),
		],
	};
	const reservations = await findManyLean(
		ReservationModel,
		reservationQuery,
		"_id hotelId otaIdentityKey otaCrossTransportIdentityKey reservation_id booking_source customer_details.confirmation_number2 supplierData otaPlatformReview",
		{ updatedAt: -1 },
		10
	);
	return { events: events || [], mirrors: mirrors || [], reservations: reservations || [] };
}

function parseIdentityKey(value = "") {
	const text = lower(value);
	const separator = text.indexOf(":");
	if (separator < 1) return null;
	const provider = canonicalProvider(text.slice(0, separator));
	const confirmationNumber = canonicalConfirmation(text.slice(separator + 1));
	return provider && confirmationNumber ? { provider, confirmationNumber } : null;
}

function reservationMatchesIdentity(reservation, identity) {
	if (
		!reservation ||
		stringId(reservation.hotelId).toLowerCase() !== identity.hotelId
	) {
		return false;
	}
	const identityKeys = [
		parseIdentityKey(reservation.otaIdentityKey),
		parseIdentityKey(reservation.otaCrossTransportIdentityKey),
	].filter(Boolean);
	if (
		identityKeys.some(
			(key) =>
				key.confirmationNumber !== identity.confirmationNumber ||
				key.provider !== identity.provider
		)
	) {
		return false;
	}
	const providerEvidence = [
		reservation?.supplierData?.otaProvider,
		reservation?.otaPlatformReview?.provider,
		reservation?.supplierData?.hotelRunner?.channel,
	]
		.filter((value) => clean(value))
		.map(canonicalProvider);
	if (
		providerEvidence.some((provider) => provider !== identity.provider) ||
		(!identityKeys.length && !providerEvidence.length)
	) {
		return false;
	}
	const confirmations = [
		...identityKeys.map((key) => key.confirmationNumber),
		reservation.reservation_id,
		reservation?.customer_details?.confirmation_number2,
		reservation?.supplierData?.suppliedBookingNo,
		reservation?.supplierData?.otaConfirmationNumber,
		reservation?.supplierData?.platformConfirmationNumber,
		reservation?.otaPlatformReview?.confirmationNumber,
		reservation?.supplierData?.hotelRunner?.providerNumber,
	]
		.map(canonicalConfirmation)
		.filter(Boolean);
	return (
		confirmations.length > 0 &&
		confirmations.every(
			(confirmation) => confirmation === identity.confirmationNumber
		)
	);
}

function directReservationMatchesIdentity(reservation, identity) {
	return Boolean(
		hasDirectHotelRunnerProjection(reservation) &&
		reservationMatchesIdentity(reservation, identity)
	);
}

function isSafeInventoryAttentionProjection(
	event,
	{ directReservations = [], events = [], mirrors = [] } = {}
) {
	if (lower(event?.status) !== "attention") return false;
	if (
		directReservations.length !== 1 ||
		events.length !== 1 ||
		mirrors.length !== 1
	) {
		return false;
	}

	const reservation = directReservations[0];
	const mirror = mirrors[0];
	const reservationId = stringId(reservation?._id);
	const mirrorId = stringId(mirror?._id);
	const eventResultStatus = lower(event?.result?.status);
	const inventoryIssueCount = event?.result?.inventoryIssueCount;
	const inventorySummary = event?.result?.inventorySummary;
	const summaryIssueCount = inventorySummary?.issueCount;
	const inventoryIssues = inventorySummary?.issues;
	const missingInvCodes = event?.result?.missingInvCodes;
	const staleInvCodes = event?.result?.staleInvCodes;
	const eventHotelRunnerId = clean(event?.hotelRunnerReservationId);
	const mirrorHotelRunnerId = clean(mirror?.hotelRunnerReservationId);
	const reservationHotelRunnerId = clean(
		reservation?.supplierData?.hotelRunner?.reservationId
	);

	return Boolean(
		reservationId &&
		mirrorId &&
		["created", "updated"].includes(eventResultStatus) &&
		lower(mirror.projectionStatus) === eventResultStatus &&
		Number.isSafeInteger(inventoryIssueCount) &&
		inventoryIssueCount > 0 &&
		inventorySummary &&
		typeof inventorySummary === "object" &&
		!Array.isArray(inventorySummary) &&
		inventorySummary.overbooked === true &&
		Number.isSafeInteger(summaryIssueCount) &&
		summaryIssueCount === inventoryIssueCount &&
		Array.isArray(inventoryIssues) &&
		inventoryIssues.length === inventoryIssueCount &&
		inventoryIssues.length <= 25 &&
		inventoryIssues.every(
			(issue) =>
				issue &&
				typeof issue === "object" &&
				!Array.isArray(issue) &&
				lower(issue.code) === "inventory_overbook"
		) &&
		Array.isArray(missingInvCodes) &&
		missingInvCodes.length === 0 &&
		Array.isArray(staleInvCodes) &&
		staleInvCodes.length === 0 &&
		event?.result?.commercialEvidenceStale === false &&
		!clean(event?.result?.attentionCode) &&
		!clean(event?.result?.code) &&
		!clean(event?.errorCode) &&
		!clean(event?.errorMessage) &&
		!clean(event?.integrityReason) &&
		event?.integrityConflict === false &&
		event?.result?.integrityConflict === false &&
		mirror?.identityConflict === false &&
		!clean(mirror?.lastErrorCode) &&
		!clean(mirror?.lastErrorMessage) &&
		stringId(event?.reservationMongoId) === reservationId &&
		stringId(event?.mirrorId) === mirrorId &&
		stringId(mirror?.reservationMongoId) === reservationId &&
		eventHotelRunnerId &&
		eventHotelRunnerId === mirrorHotelRunnerId &&
		eventHotelRunnerId === reservationHotelRunnerId
	);
}

async function defaultLoadReservationById(
	reservationId,
	{ ReservationModel = Reservations } = {}
) {
	let query = ReservationModel.findById(reservationId);
	if (query && typeof query.select === "function") {
		query = query.select(
			"_id hotelId otaIdentityKey otaCrossTransportIdentityKey reservation_id customer_details.confirmation_number2 supplierData otaPlatformReview"
		);
	}
	return leanResult(query);
}

function eventHasProjectableTargetedMarker(event = {}, identity = {}) {
	const marker = event?.result?.hotelRunnerFirstFallbackTargetedLookup;
	return Boolean(
		marker &&
		Number(marker.version) === 1 &&
		lower(marker.origin) === "targeted_identity_lookup" &&
		marker.projectable === true &&
		clean(marker.jobId) &&
		canonicalProvider(marker.provider) === identity.provider &&
		canonicalConfirmation(marker.confirmationNumber) ===
			identity.confirmationNumber &&
		validSha256(marker.archiveFingerprint) &&
		safeDate(marker.markedAt)
	);
}

function eventIsProjectionEligible(
	event = {},
	identity = {},
	projectionNotBefore = null
) {
	if (eventHasProjectableTargetedMarker(event, identity)) return true;
	if (lower(event.source) !== "push") return false;
	const cutoff = safeDate(projectionNotBefore);
	if (!cutoff) return true;
	const receivedAt = safeDate(event.receivedAt);
	const sourceUpdatedAt = safeDate(event.sourceUpdatedAt);
	return Boolean(
		receivedAt &&
		sourceUpdatedAt &&
		receivedAt.getTime() >= cutoff.getTime() &&
		sourceUpdatedAt.getTime() >= cutoff.getTime()
	);
}

function classifyLocalHotelRunnerState(
	raw = {},
	identity = {},
	{ projectionNotBefore = null } = {}
) {
	if (raw && ["absent", "api", "pending", "needs_review", "uncertain"].includes(raw.kind)) {
		return raw;
	}
	if (
		!raw ||
		!Array.isArray(raw.events) ||
		!Array.isArray(raw.mirrors) ||
		!Array.isArray(raw.reservations)
	) {
		return { kind: "uncertain", code: "local_inspection_invalid" };
	}
	const candidates = [...raw.events, ...raw.mirrors];
	const hotelRunnerIds = new Set(
		candidates
			.map((record) => clean(record?.hotelRunnerReservationId))
			.filter(Boolean)
	);
	if (hotelRunnerIds.size > 1) {
		return { kind: "needs_review", code: "multiple_hotelrunner_identity_candidates" };
	}
	for (const record of candidates) {
		if (
			stringId(record.hotelId).toLowerCase() !== identity.hotelId ||
			canonicalConfirmation(record.providerNumber) !== identity.confirmationNumber ||
			canonicalProvider(record.channel) !== identity.provider
		) {
			return { kind: "needs_review", code: "hotelrunner_identity_evidence_conflict" };
		}
	}
	const lateEvidenceWaitingEvents = raw.events.filter(
		(event) =>
			isLateEvidenceIdleFailure(event, {
				projectionEligible: eventIsProjectionEligible(
					event,
					identity,
					projectionNotBefore
				),
			})
	);
	const lateEvidenceWaitingEventSet = new Set(lateEvidenceWaitingEvents);
	const directReservations = raw.reservations.filter((reservation) =>
		directReservationMatchesIdentity(reservation, identity)
	);
	const safeInventoryAttentionEventSet = new Set(
		raw.events.filter((event) =>
			isSafeInventoryAttentionProjection(event, {
				directReservations,
				events: raw.events,
				mirrors: raw.mirrors,
			})
		)
	);
	if (
		raw.events.some((event) =>
				event.integrityConflict === true ||
				(BLOCKED_HOTELRUNNER_EVENT_STATES.has(lower(event.status)) &&
					!lateEvidenceWaitingEventSet.has(event) &&
					!safeInventoryAttentionEventSet.has(event))
		) ||
		raw.mirrors.some(
			(mirror) =>
				mirror.identityConflict === true ||
				BLOCKED_MIRROR_STATES.has(lower(mirror.projectionStatus))
		)
	) {
		return { kind: "needs_review", code: "hotelrunner_local_record_blocked" };
	}
	if (directReservations.length > 1) {
		return { kind: "needs_review", code: "multiple_direct_api_reservations" };
	}
	if (
		raw.reservations.length > directReservations.length &&
		raw.reservations.some((reservation) => hasDirectHotelRunnerProjection(reservation))
	) {
		return { kind: "needs_review", code: "direct_api_reservation_identity_conflict" };
	}
	if (directReservations.length === 1) {
		const reservation = directReservations[0];
		return {
			kind: "api",
			code: "direct_api_reservation_found",
			reservationId: stringId(reservation._id),
			eventId: stringId(raw.events.find((event) => event.reservationMongoId)?._id),
			mirrorId: stringId(raw.mirrors.find((mirror) => mirror.reservationMongoId)?._id),
		};
	}
	const lateEvidenceWaitingEvent = lateEvidenceWaitingEvents[0];
	if (lateEvidenceWaitingEvent) {
		return {
			kind: "pending",
			code: "hotelrunner_late_evidence_pending",
			eventId: stringId(lateEvidenceWaitingEvent._id),
			eventSource: lower(lateEvidenceWaitingEvent.source),
			lookupEventProjectable: true,
		};
	}
	const needsMappingEvents = raw.events.filter(
		(event) => lower(event.status) === "needs_mapping"
	);
	const needsMappingMirrors = raw.mirrors.filter(
		(mirror) => lower(mirror.projectionStatus) === "needs_mapping"
	);
	const staleMappingCode = "hotelrunner_room_mapping_stale";
	const staleMappingEvents = needsMappingEvents.filter(
		(event) =>
			lower(event?.errorCode) === staleMappingCode &&
			lower(event?.result?.code) === staleMappingCode
	);
	const staleMappingEventIds = new Set(
		staleMappingEvents
			.map((event) => clean(event.hotelRunnerReservationId))
			.filter(Boolean)
	);
	const staleMappingMirrors = needsMappingMirrors.filter((mirror) => {
		const errorCode = lower(mirror.lastErrorCode);
		return (
			errorCode === staleMappingCode ||
			(!errorCode &&
				staleMappingEventIds.has(clean(mirror.hotelRunnerReservationId)))
		);
	});
	if (
		needsMappingEvents.length > staleMappingEvents.length ||
		needsMappingMirrors.length > staleMappingMirrors.length
	) {
		return { kind: "needs_review", code: "hotelrunner_local_record_blocked" };
	}
	const needsMappingEvent = staleMappingEvents[0];
	const needsMappingMirror = staleMappingMirrors[0];
	if (needsMappingEvent || needsMappingMirror) {
		return {
			kind: "pending",
			code: "hotelrunner_mapping_pending",
			eventId: stringId(needsMappingEvent?._id),
			mirrorId: stringId(needsMappingMirror?._id),
			eventSource: lower(needsMappingEvent?.source),
			lookupEventProjectable: Boolean(
				needsMappingEvent &&
					eventIsProjectionEligible(
						needsMappingEvent,
						identity,
						projectionNotBefore
					)
			),
		};
	}
	const projectionEligibleEvents = raw.events.filter((event) =>
		eventIsProjectionEligible(event, identity, projectionNotBefore)
	);
	const pendingEvent = projectionEligibleEvents.find((event) =>
		PENDING_HOTELRUNNER_EVENT_STATES.has(lower(event.status))
	);
	if (
		pendingEvent ||
		raw.mirrors.some((mirror) => lower(mirror.projectionStatus) === "pending")
	) {
		return {
			kind: "pending",
			code: "hotelrunner_projection_pending",
			eventId: stringId(pendingEvent?._id),
			eventSource: lower(pendingEvent?.source),
			lookupEventProjectable: Boolean(
				eventIsProjectionEligible(
					pendingEvent,
					identity,
					projectionNotBefore
				) ||
					pendingEvent?.result?.hotelRunnerFirstFallbackTargetedLookup
						?.projectable === true
			),
		};
	}
	if (projectionEligibleEvents.length || raw.mirrors.length) {
		const projectedMirrorWithoutReservation = raw.mirrors.some((mirror) =>
			COMPLETED_MIRROR_STATES.has(lower(mirror.projectionStatus))
		);
		return {
			kind: "needs_review",
			code: projectedMirrorWithoutReservation
				? "hotelrunner_projection_link_missing"
				: "hotelrunner_local_record_unclassified",
		};
	}
	if (raw.events.length) {
		return {
			kind: "absent",
			code: "hotelrunner_legacy_event_not_projection_eligible",
		};
	}
	return { kind: "absent", code: "hotelrunner_identity_absent" };
}

function responseCountHints(envelope) {
	return [
		envelope?.count,
		envelope?.total,
		envelope?.total_count,
		envelope?.total_entries,
	]
		.filter((value) => value !== undefined && value !== null && value !== "")
		.map(Number)
		.filter(Number.isFinite);
}

function documentedPagination(envelope = {}) {
	const count = Number(envelope.count);
	const currentPage = Number(envelope.current_page);
	const pages = Number(envelope.pages);
	return {
		valid: Boolean(
			Number.isSafeInteger(count) &&
			count >= 0 &&
			Number.isSafeInteger(currentPage) &&
			currentPage === 1 &&
			Number.isSafeInteger(pages) &&
			pages >= 0
		),
		count,
		currentPage,
		pages,
	};
}

function classifyHotelRunnerLookupEnvelope(
	envelope,
	identity,
	{
		normalizeReservation = normalizeHotelRunnerReservation,
		checkedAt = new Date(),
	} = {}
) {
	let responseHash = "";
	try {
		responseHash = hashStable(envelope);
	} catch (_error) {
		return { kind: "uncertain", code: "lookup_response_not_serializable" };
	}
	if (!envelope || typeof envelope !== "object" || !Array.isArray(envelope.reservations)) {
		return { kind: "uncertain", code: "lookup_response_invalid", responseHash };
	}
	const reservations = envelope.reservations;
	const pagination = documentedPagination(envelope);
	if (!pagination.valid) {
		return {
			kind: "uncertain",
			code: "lookup_pagination_metadata_invalid",
			responseHash,
			resultCount: reservations.length,
		};
	}
	const hints = responseCountHints(envelope);
	const pages = pagination.pages;
	if (
		hints.some((count) => count < reservations.length) ||
		(Number.isFinite(pages) && pages < 0)
	) {
		return {
			kind: "uncertain",
			code: "lookup_response_count_conflict",
			responseHash,
			resultCount: reservations.length,
		};
	}
	if (reservations.length === 0) {
		if (
			pagination.count !== 0 ||
			!([0, 1].includes(pages)) ||
			hints.some((count) => count > 0)
		) {
			return {
				kind: "uncertain",
				code: "lookup_empty_response_conflict",
				responseHash,
				resultCount: 0,
			};
		}
		return {
			kind: "empty",
			code: "lookup_confirmed_empty",
			responseHash,
			resultCount: 0,
		};
	}
	if (
		reservations.length !== 1 ||
		pagination.count !== 1 ||
		hints.some((count) => count > 1) ||
		pages !== 1
	) {
		return {
			kind: "ambiguous",
			code: "lookup_multiple_candidates",
			responseHash,
			resultCount: reservations.length,
		};
	}
	let normalized;
	try {
		normalized = normalizeReservation(reservations[0], { receivedAt: checkedAt });
	} catch (_error) {
		return {
			kind: "uncertain",
			code: "lookup_candidate_normalization_failed",
			responseHash,
			resultCount: 1,
		};
	}
	if (
		!normalized ||
		(Array.isArray(normalized.issues) && normalized.issues.length) ||
		!clean(normalized.hotelRunnerReservationId)
	) {
		return {
			kind: "uncertain",
			code: "lookup_candidate_invalid",
			responseHash,
			resultCount: 1,
		};
	}
	if (
		canonicalConfirmation(normalized.providerNumber) !== identity.confirmationNumber ||
		canonicalProvider(normalized.channel) !== identity.provider
	) {
		return {
			kind: "ambiguous",
			code: "lookup_candidate_identity_mismatch",
			responseHash,
			resultCount: 1,
		};
	}
	return {
		kind: "match",
		code: "lookup_exact_match",
		responseHash,
		resultCount: 1,
		rawReservation: reservations[0],
		normalized,
	};
}

function buildConfirmedEmptyProof({ job, lookup, now, proofTtlMs, proofId }) {
	return {
		proofId,
		status: "confirmed_empty",
		hotelId: stringId(job.hotelId).toLowerCase(),
		hrIdFingerprint: lower(job.hrIdFingerprint),
		provider: job.provider,
		confirmationNumber: job.confirmationNumber,
		lookupConfirmationHash: job.lookupConfirmationHash,
		archiveFingerprint: job.archiveFingerprint,
		resolvedHotelProofHash: job.resolvedHotelProofHash,
		responseHash: lookup.responseHash,
		resultCount: 0,
		checkedAt: now,
		expiresAt: new Date(now.getTime() + proofTtlMs),
	};
}

function confirmedEmptyProofMatchesDurableJob(job, proof) {
	if (!proof || !job?.negativeLookupProof) return false;
	try {
		return hashStable(proof) === hashStable(job.negativeLookupProof);
	} catch (_error) {
		return false;
	}
}

function confirmedEmptyProofBindingValid(job, proof) {
	const checkedAt = safeDate(proof?.checkedAt);
	const expiresAt = safeDate(proof?.expiresAt);
	return Boolean(
		proof &&
		confirmedEmptyProofMatchesDurableJob(job, proof) &&
		clean(proof.proofId) &&
		lower(proof.status) === "confirmed_empty" &&
		stringId(proof.hotelId).toLowerCase() === stringId(job.hotelId).toLowerCase() &&
		validSha256(proof.hrIdFingerprint) &&
		lower(proof.hrIdFingerprint) === lower(job.hrIdFingerprint) &&
		canonicalProvider(proof.provider) === job.provider &&
		canonicalConfirmation(proof.confirmationNumber) === job.confirmationNumber &&
		clean(job.lookupConfirmationNumber) &&
		canonicalConfirmation(job.lookupConfirmationNumber) === job.confirmationNumber &&
		validSha256(job.lookupConfirmationHash) &&
		lower(job.lookupConfirmationHash) ===
			lower(sha256(clean(job.lookupConfirmationNumber))) &&
		validSha256(proof.lookupConfirmationHash) &&
		lower(proof.lookupConfirmationHash) === lower(job.lookupConfirmationHash) &&
		lower(proof.archiveFingerprint) === lower(job.archiveFingerprint) &&
		validSha256(proof.resolvedHotelProofHash) &&
		lower(proof.resolvedHotelProofHash) === lower(job.resolvedHotelProofHash) &&
		validSha256(proof.responseHash) &&
		Number(proof.resultCount) === 0 &&
		checkedAt &&
		expiresAt &&
		checkedAt.getTime() < expiresAt.getTime()
	);
}

function validConfirmedEmptyProof(job, proof, now = new Date()) {
	const checkedAt = safeDate(proof?.checkedAt);
	const expiresAt = safeDate(proof?.expiresAt);
	const referenceTime = safeDate(now);
	return Boolean(
		confirmedEmptyProofBindingValid(job, proof) &&
		referenceTime &&
		checkedAt.getTime() <= referenceTime.getTime() &&
		expiresAt.getTime() > referenceTime.getTime()
	);
}

function expiredConfirmedEmptyProof(job, proof, now = new Date()) {
	const checkedAt = safeDate(proof?.checkedAt);
	const expiresAt = safeDate(proof?.expiresAt);
	const referenceTime = safeDate(now);
	return Boolean(
		confirmedEmptyProofBindingValid(job, proof) &&
		referenceTime &&
		checkedAt.getTime() <= referenceTime.getTime() &&
		expiresAt.getTime() <= referenceTime.getTime()
	);
}

async function defaultLoadArchivedEmail(inboundEmailId, { InboundModel = InboundEmail } = {}) {
	return leanResult(InboundModel.findById(inboundEmailId));
}

function buildHotelRunnerPriorityWorkQuery(hotelId, now = new Date()) {
	return buildHotelRunnerPriorityWorkQueryForConfig(hotelId, now);
}

function buildHotelRunnerProjectionEligibilityFilter(projectionNotBefore = null) {
	const push = { source: "push" };
	if (
		projectionNotBefore instanceof Date &&
		Number.isFinite(projectionNotBefore.getTime())
	) {
		push.receivedAt = { $gte: projectionNotBefore };
		push.sourceUpdatedAt = { $gte: projectionNotBefore };
	}
	return {
		$or: [
			push,
			{
				source: { $in: ["pull", "push"] },
				[`${TARGETED_LOOKUP_EVENT_MARKER_PATH}.version`]: 1,
				[`${TARGETED_LOOKUP_EVENT_MARKER_PATH}.origin`]:
					"targeted_identity_lookup",
				[`${TARGETED_LOOKUP_EVENT_MARKER_PATH}.projectable`]: true,
				[`${TARGETED_LOOKUP_EVENT_MARKER_PATH}.jobId`]: {
					$exists: true,
					$type: "string",
					$ne: "",
				},
				[`${TARGETED_LOOKUP_EVENT_MARKER_PATH}.provider`]: {
					$in: [...DIRECT_OTA_PROVIDERS],
				},
				[`${TARGETED_LOOKUP_EVENT_MARKER_PATH}.confirmationNumber`]: {
					$exists: true,
					$type: "string",
					$ne: "",
				},
				[`${TARGETED_LOOKUP_EVENT_MARKER_PATH}.archiveFingerprint`]: {
					$regex: /^[a-f0-9]{64}$/,
				},
				[`${TARGETED_LOOKUP_EVENT_MARKER_PATH}.markedAt`]: { $type: "date" },
			},
		],
	};
}

function buildHotelRunnerPriorityWorkQueryForConfig(
	hotelId,
	now = new Date(),
	projectionNotBefore = null
) {
	return {
		hotelId,
		$and: [
			buildHotelRunnerProjectionEligibilityFilter(projectionNotBefore),
			{
				$or: [
					{
						status: { $in: ["pending", "retry"] },
						nextAttemptAt: { $lte: now },
						...leaseAvailableFilter(now),
					},
					{
						status: "processing",
						leaseUntil: { $gt: now },
					},
					{
						status: "processing",
						nextAttemptAt: { $lte: now },
						...leaseAvailableFilter(now),
					},
				],
			},
		],
	};
}

async function defaultPriorityQueueClear(
	identity,
	{
		EventModel = HotelRunnerEvent,
		checkedAt = new Date(),
		projectionNotBefore = null,
	} = {}
) {
	const query = EventModel.exists(
		buildHotelRunnerPriorityWorkQueryForConfig(
			identity.hotelId,
			checkedAt,
			projectionNotBefore
		)
	);
	const exists = query && typeof query.exec === "function" ? await query.exec() : await query;
	return !exists;
}

async function defaultMarkLookupEventProjectable(
	{ eventId, job, identity, markedAt },
	{ EventModel = HotelRunnerEvent } = {}
) {
	if (!mongoose.Types.ObjectId.isValid(clean(eventId))) {
		throw new HotelRunnerFirstFallbackError(
			"A targeted HotelRunner lookup event identifier is required.",
			{ code: "HOTELRUNNER_LOOKUP_EVENT_ID_INVALID", retryable: true }
		);
	}
	const update = await EventModel.updateOne(
		{
			_id: eventId,
			hotelId: identity.hotelId,
			source: { $in: ["pull", "push"] },
			providerNumber: new RegExp(
				`^${escapeRegex(identity.confirmationNumber)}$`,
				"i"
			),
		},
		{
			$set: {
				[TARGETED_LOOKUP_EVENT_MARKER_PATH]: {
					version: 1,
					origin: "targeted_identity_lookup",
					projectable: true,
					jobId: stringId(job._id),
					provider: identity.provider,
					confirmationNumber: identity.confirmationNumber,
					archiveFingerprint: job.archiveFingerprint,
					markedAt,
				},
			},
		}
	).exec();
	if (!mutationMatched(update)) {
		throw new HotelRunnerFirstFallbackError(
			"The targeted HotelRunner lookup event could not be marked projectable.",
			{ code: "HOTELRUNNER_LOOKUP_EVENT_MARKER_CAS_LOST", retryable: true }
		);
	}
	return true;
}

async function defaultFinalizeInboundAudit(
	{ job, status, details = {}, finalizedAt },
	{ InboundModel = InboundEmail } = {}
) {
	const reservationId = clean(details.reservationId);
	const resultStatus = lower(details.result?.status);
	const processingStatus =
		status === "needs_review"
			? "needs_review"
			: resultStatus || status;
	const actionTaken =
		status === "needs_review"
			? "skipped"
			: clean(details.result?.actionTaken) || resultStatus || "updated";
	const skipReason = status === "needs_review" ? lower(details.code) : "";
	const automationComment =
		details.message ||
		(status === "completed_api"
			? "HotelRunner API owned the reservation; authenticated OTA email commercial evidence was reconciled."
			: status === "completed_email_fallback"
				? "HotelRunner exact lookup confirmed no reservation before authenticated OTA email fallback."
				: "HotelRunner-first processing requires review.");
	const warnings = Array.isArray(details.result?.warnings)
		? details.result.warnings
		: [];
	const errors = Array.isArray(details.result?.errors)
		? details.result.errors
		: status === "needs_review" && automationComment
			? [automationComment]
			: [];
	const exactAuditFilter = details.integrityRejected === true
		? {
				_id: job.inboundEmailId,
				emailHash: job.inboundEmailHash,
				processingStatus: {
					$in: ["parsed_awaiting_hotelrunner", "awaiting_hotelrunner"],
				},
			  }
		: {
				_id: job.inboundEmailId,
				emailHash: job.inboundEmailHash,
				hotelId: job.hotelId,
				provider: job.provider,
				confirmationNumber: job.confirmationNumber,
				intent: "new_reservation",
				eventType: "new",
			  };
	const auditUpdate = {
		$set: {
			processingStatus,
			...(details.integrityRejected === true
				? {}
				: { hotelId: job.hotelId }),
			...(reservationId ? { reservationMongoId: reservationId } : {}),
			...(clean(details.result?.pmsConfirmationNumber)
				? {
						pmsConfirmationNumber: clean(
							details.result.pmsConfirmationNumber
						),
					}
				: {}),
			hasReservationConnection: Boolean(reservationId),
			automationAction: actionTaken,
			skipReason,
			automationComment,
			reconcileWarnings: warnings,
			reconcileErrors: errors,
			reconciliation: {
				status: processingStatus,
				actionTaken,
				skipReason,
				automationComment,
				reservationId: reservationId || null,
				hotelId: job.hotelId,
				pmsConfirmationNumber: clean(
					details.result?.pmsConfirmationNumber
				),
				provider: job.provider,
				confirmationNumber: job.confirmationNumber,
				warnings,
				errors,
				matchedReservationBy: reservationId
					? ["hotelrunner_first_fallback"]
					: [],
				hotelRunnerFirstFallback: {
					version: 1,
					jobId: stringId(job._id),
					status,
					decision: details.decision || status,
					eventId: clean(details.eventId),
					mirrorId: clean(details.mirrorId),
					reservationId,
					finalizedAt,
				},
			},
			"hotelRunnerFirstFallback.status": status,
			"hotelRunnerFirstFallback.jobId": stringId(job._id),
			"hotelRunnerFirstFallback.finalizedAt": finalizedAt,
			"hotelRunnerFirstFallback.lastErrorCode": details.code || "",
			"hotelRunnerFirstFallback.lastErrorMessage": details.message || "",
		},
		...(reservationId
			? { $addToSet: { matchedReservationBy: "hotelrunner_first_fallback" } }
			: {}),
	};
	const update = await InboundModel.updateOne(
		exactAuditFilter,
		auditUpdate
	).exec();
	if (mutationMatched(update)) return true;

	if (details.integrityRejected === true) {
		// The audit and queue job cannot be committed atomically. If a process
		// dies after the audit transition but before the owned job CAS, a replay
		// must prove the exact prior terminal marker and converge without
		// overwriting the original integrity reason.
		const idempotent = await InboundModel.updateOne(
			{
				_id: job.inboundEmailId,
				emailHash: job.inboundEmailHash,
				processingStatus: "needs_review",
				automationAction: "skipped",
				"hotelRunnerFirstFallback.jobId": stringId(job._id),
				"hotelRunnerFirstFallback.status": "needs_review",
				"reconciliation.hotelRunnerFirstFallback.jobId": stringId(job._id),
				"reconciliation.hotelRunnerFirstFallback.status": "needs_review",
				"reconciliation.hotelRunnerFirstFallback.decision":
					"archived_email_integrity_rejected",
			},
			{
				$set: {
					"hotelRunnerFirstFallback.status": "needs_review",
				},
			}
		).exec();
		if (mutationMatched(idempotent)) return true;
	}

	if (!mutationMatched(update)) {
		throw new HotelRunnerFirstFallbackError(
			"The archived inbound email could not be finalized by exact identity.",
			{ code: "HOTELRUNNER_FALLBACK_AUDIT_FINALIZE_CAS_LOST", retryable: true }
		);
	}
	return true;
}

async function defaultFindRecoverableArchivedEmails(
	{ hotelId, staleBefore, limit },
	{ InboundModel = InboundEmail } = {}
) {
	return findManyLean(
		InboundModel,
		{
			hotelId,
			processingStatus: {
				$in: ["parsed_awaiting_hotelrunner", "awaiting_hotelrunner"],
			},
			"hotelRunnerFirstFallback.status": {
				$in: ["archive_ready", "recovery_pending"],
			},
			intent: "new_reservation",
			eventType: "new",
			receivedAt: { $lte: staleBefore },
		},
		"_id hotelId provider confirmationNumber receivedAt",
		{ receivedAt: 1, _id: 1 },
		limit
	);
}

async function defaultMarkRecoveredArchivedEmail(
	{ candidate, job, status, markedAt },
	{ InboundModel = InboundEmail } = {}
) {
	const collision = status === "collision";
	const collisionMessage =
		"A conflicting archived OTA email already owns this HotelRunner fallback identity.";
	const update = await InboundModel.updateOne(
		{
			_id: candidate._id,
			hotelId: candidate.hotelId,
			processingStatus: {
				$in: ["parsed_awaiting_hotelrunner", "awaiting_hotelrunner"],
			},
			"hotelRunnerFirstFallback.status": {
				$in: ["archive_ready", "recovery_pending", "enqueued"],
			},
		},
		{
			$set: {
				"hotelRunnerFirstFallback.status":
					collision ? "identity_collision" : "enqueued",
				"hotelRunnerFirstFallback.jobId": stringId(job?._id) || null,
				"hotelRunnerFirstFallback.queuedAt": markedAt,
				"hotelRunnerFirstFallback.collision": collision,
				"hotelRunnerFirstFallback.lastErrorCode": collision
					? "HOTELRUNNER_FALLBACK_IDENTITY_COLLISION"
					: "",
				"hotelRunnerFirstFallback.lastErrorMessage": collision
					? collisionMessage
					: "",
				...(collision
					? {
							processingStatus: "needs_review",
							automationAction: "skipped",
							skipReason: "hotelrunner_fallback_identity_collision",
							automationComment: collisionMessage,
							reconcileWarnings: [],
							reconcileErrors: [collisionMessage],
							reconciliation: {
								status: "needs_review",
								actionTaken: "skipped",
								skipReason:
									"hotelrunner_fallback_identity_collision",
								automationComment: collisionMessage,
								reservationId: null,
								hotelId: candidate.hotelId,
								warnings: [],
								errors: [collisionMessage],
							},
						}
					: {}),
			},
		}
	).exec();
	if (!mutationMatched(update)) {
		throw new HotelRunnerFirstFallbackError(
			"The recovered inbound audit queue marker could not be repaired exactly.",
			{
				code: "HOTELRUNNER_FALLBACK_RECOVERY_MARKER_CAS_LOST",
				retryable: true,
			}
		);
	}
	return true;
}

async function defaultLoadReconciliationReservation(
	reservationId,
	{ ReservationModel = Reservations } = {}
) {
	let query = ReservationModel.findById(reservationId);
	if (query && typeof query.lean === "function") query = query.lean();
	return leanResult(query);
}

async function defaultLoadReconciliationHotel(
	hotelId,
	{ HotelModel = HotelDetails } = {}
) {
	let query = HotelModel.findById(hotelId);
	if (query && typeof query.lean === "function") query = query.lean();
	return leanResult(query);
}

function archivedReconciliationNeedsReview(reason, message, reservationId = null) {
	return {
		status: "needs_review",
		actionTaken: "skipped",
		skipReason: reason,
		automationComment: message,
		warnings: [],
		errors: [message],
		reservationId,
		hotelId: null,
		pmsConfirmationNumber: "",
		matchedReservationBy: [],
	};
}

function exactArchivedReconciliationContext(input = {}) {
	let identity;
	try {
		identity = buildIdentity(input.identity);
	} catch (_error) {
		return null;
	}
	const job = input.job || {};
	const normalized = input.normalizedReservation || {};
	const archiveFingerprint = lower(input.archiveFingerprint);
	const lookupConfirmationNumber = clean(job.lookupConfirmationNumber);
	if (
		stringId(job.hotelId).toLowerCase() !== identity.hotelId ||
		canonicalProvider(job.provider) !== identity.provider ||
		canonicalConfirmation(job.confirmationNumber) !==
			identity.confirmationNumber ||
		(lower(job.identityKey) && lower(job.identityKey) !== identity.identityKey) ||
		!validSha256(job.hrIdFingerprint) ||
		!validSha256(job.inboundEmailHash) ||
		!validSha256(job.normalizedReservationHash) ||
		lower(job.normalizedReservationHash) !== hashStable(normalized) ||
		!validSha256(job.resolvedHotelProofHash) ||
		!lookupConfirmationNumber ||
		canonicalConfirmation(lookupConfirmationNumber) !==
			identity.confirmationNumber ||
		!validSha256(job.lookupConfirmationHash) ||
		lower(job.lookupConfirmationHash) !==
			lower(sha256(lookupConfirmationNumber)) ||
		lookupConfirmationNumber !==
			clean(normalized.confirmationNumber || normalized.reservationId) ||
		!validSha256(archiveFingerprint) ||
		lower(job.archiveFingerprint) !== archiveFingerprint ||
		stringId(input.inboundEmailId).toLowerCase() !==
			stringId(job.inboundEmailId).toLowerCase() ||
		canonicalProvider(normalized.provider) !== identity.provider ||
		canonicalConfirmation(
			normalized.confirmationNumber || normalized.reservationId
		) !== identity.confirmationNumber ||
		stringId(normalized.inboundEmailId).toLowerCase() !==
			stringId(job.inboundEmailId).toLowerCase() ||
		lower(normalized.intent) !== "new_reservation" ||
		lower(normalized.eventType) !== "new" ||
		normalized.sourceSenderTrusted !== true ||
		normalized.sourceSenderAuthenticated !== true
	) {
		return null;
	}
	return { identity, job, normalized, archiveFingerprint };
}

async function defaultReconcileArchivedEmail(input = {}, dependencies = {}) {
	const exact = exactArchivedReconciliationContext(input);
	if (!exact) {
		return archivedReconciliationNeedsReview(
			"hotelrunner_first_reconciliation_context_invalid",
			"The archived HotelRunner-first reconciliation context did not match its immutable queued identity; no reservation was selected or changed."
		);
	}
	// Lazy loading prevents the large OTA mapper/controller graph from being
	// initialized by a worker that has no due fallback job.
	const mapper =
		dependencies.otaReservationMapper || require("./otaReservationMapper");
	if (input.mode === "api_commercial_enrichment") {
		const reservationId = stringId(input.reservationId);
		if (
			!reservationId ||
			lower(input.local?.kind) !== "api" ||
			stringId(input.local?.reservationId) !== reservationId
		) {
			return archivedReconciliationNeedsReview(
				"hotelrunner_first_api_target_invalid",
				"The direct HotelRunner reservation target was missing or changed; no commercial mutation was attempted."
			);
		}
		const loadReservation =
			dependencies.loadReconciliationReservation ||
			((id) => defaultLoadReconciliationReservation(id, dependencies));
		const existing = await loadReservation(reservationId);
		if (
			!existing ||
			stringId(existing._id) !== reservationId ||
			!directReservationMatchesIdentity(existing, exact.identity)
		) {
			return archivedReconciliationNeedsReview(
				"hotelrunner_first_api_target_identity_conflict",
				"The supplied direct HotelRunner reservation did not match the queued hotel, provider, and confirmation identity; no fields were changed."
			);
		}
		const loadHotel =
			dependencies.loadReconciliationHotel ||
			((id) => defaultLoadReconciliationHotel(id, dependencies));
		const hotel = await loadHotel(exact.identity.hotelId);
		const currentHotelProof = resolvedHotelProofFromHotel(hotel);
		if (
			!hotel ||
			!currentHotelProof ||
			hashStable(currentHotelProof) !== exact.job.resolvedHotelProofHash ||
			stringId(hotel._id).toLowerCase() !== exact.identity.hotelId ||
			hotel.activateHotel !== true ||
			hotel.xHotelProActive === false ||
			!stringId(hotel.belongsTo) ||
			stringId(hotel.belongsTo) !== stringId(existing.belongsTo)
		) {
			return archivedReconciliationNeedsReview(
				"hotelrunner_first_api_hotel_identity_conflict",
				"The current direct HotelRunner reservation no longer belongs to the exact active queued hotel; no commercial mutation was attempted.",
				reservationId
			);
		}
		const matchedReservationBy = mapper.detectConfirmationMatchFields(
			existing,
			exact.identity.confirmationNumber,
			exact.identity.provider,
			exact.identity.provider === "trip" ? exact.identity.identityKey : ""
		);
		if (
			!matchedReservationBy.some((field) =>
				["otaIdentityKey", "otaCrossTransportIdentityKey"].includes(field)
			)
		) {
			return archivedReconciliationNeedsReview(
				"hotelrunner_first_api_target_identity_conflict",
				"The supplied reservation lacked the exact canonical OTA identity required for commercial-only reconciliation; no fields were changed.",
				reservationId
			);
		}
		const result = await mapper.reconcileDirectHotelRunnerOwnedEmail({
			normalized: exact.normalized,
			existing,
			hotelDetails: hotel,
			matchedReservationBy,
			warnings: [...(exact.normalized.warnings || [])],
			errors: [...(exact.normalized.errors || [])],
		});
		if (!result || resultReservationId(result) !== reservationId) {
			return archivedReconciliationNeedsReview(
				"hotelrunner_first_api_commercial_result_invalid",
				"Commercial-only reconciliation did not return the exact supplied direct HotelRunner reservation.",
				reservationId
			);
		}
		return result;
	}
	if (input.mode === "confirmed_empty_email_fallback") {
		const checkedAt = safeDate(
			(dependencies.clock || (() => new Date()))()
		);
		const currentProof = Boolean(
			checkedAt &&
			validConfirmedEmptyProof(
				exact.job,
				input.confirmedEmptyProof,
				checkedAt
			)
		);
		const expiredReplayProof = Boolean(
			checkedAt &&
			expiredConfirmedEmptyProof(
				exact.job,
				input.confirmedEmptyProof,
				checkedAt
			)
		);
		if (
			!checkedAt ||
			(!currentProof && !expiredReplayProof)
		) {
			return archivedReconciliationNeedsReview(
				"hotelrunner_first_negative_proof_invalid",
				"The HotelRunner confirmed-empty proof was stale or did not match the queued identity; no email fallback mutation was attempted."
			);
		}
		if (expiredReplayProof) {
			return mapper.reconcileOtaReservation(exact.normalized, {
				hotelRunnerFirstFallbackBoundary: {
					mode: input.mode,
					identity: exact.identity,
					job: exact.job,
					archiveFingerprint: exact.archiveFingerprint,
					confirmedEmptyProof: input.confirmedEmptyProof,
				},
				hotelRunnerFirstFallbackNow: checkedAt,
				hotelRunnerFirstFallbackIngressGate:
					dependencies.hotelRunnerFirstFallbackIngressGate,
			});
		}
		const inspectLocal =
			dependencies.inspectLocalHotelRunnerStateForReconciliation ||
			((identity) =>
				defaultInspectLocalHotelRunnerState(identity, dependencies));
		const local = classifyLocalHotelRunnerState(
			await inspectLocal(exact.identity),
			exact.identity,
			{ projectionNotBefore: dependencies.projectionNotBefore || null }
		);
		if (local.kind !== "absent") {
			return archivedReconciliationNeedsReview(
				"hotelrunner_first_local_state_changed_after_negative_proof",
				"HotelRunner or PMS identity state changed after the confirmed-empty proof; no email fallback mutation was attempted."
			);
		}
		const loadHotel =
			dependencies.loadReconciliationHotel ||
			((id) => defaultLoadReconciliationHotel(id, dependencies));
		const currentHotel = await loadHotel(exact.identity.hotelId);
		const currentHotelProof = resolvedHotelProofFromHotel(currentHotel);
		if (
			!currentHotelProof ||
			hashStable(currentHotelProof) !== exact.job.resolvedHotelProofHash
		) {
			return archivedReconciliationNeedsReview(
				"hotelrunner_first_current_hotel_proof_changed",
				"The configured hotel ownership, currency, or active state changed after the archived proof; no email fallback mutation was attempted."
			);
		}
		const mutationCheckedAt = safeDate(
			(dependencies.clock || (() => new Date()))()
		);
		if (
			!mutationCheckedAt ||
			!validConfirmedEmptyProof(
				exact.job,
				input.confirmedEmptyProof,
				mutationCheckedAt
			)
		) {
			return archivedReconciliationNeedsReview(
				"hotelrunner_first_negative_proof_expired_before_mutation",
				"The confirmed-empty proof expired before the final mutation boundary; no email fallback mutation was attempted."
			);
		}
		return mapper.reconcileOtaReservation(exact.normalized, {
			hotelRunnerFirstFallbackBoundary: {
				mode: input.mode,
				identity: exact.identity,
				job: exact.job,
				archiveFingerprint: exact.archiveFingerprint,
				confirmedEmptyProof: input.confirmedEmptyProof,
			},
			hotelRunnerFirstFallbackNow: mutationCheckedAt,
			hotelRunnerFirstFallbackIngressGate:
				dependencies.hotelRunnerFirstFallbackIngressGate,
		});
	}
	return archivedReconciliationNeedsReview(
		"hotelrunner_first_reconciliation_mode_invalid",
		"The HotelRunner-first reconciliation mode was not recognized; no reservation mutation was attempted."
	);
}

function resultReservationId(result) {
	return stringId(result?.reservationId || result?.reservationMongoId);
}

function validReconciliationResult(result, { mode = "" } = {}) {
	const status = lower(result?.status);
	const allowed =
		mode === "api"
			? new Set(["updated", "duplicate_reservation"])
			: mode === "email_fallback"
				? new Set(["created", "duplicate_reservation"])
				: new Set();
	return Boolean(
		result &&
		resultReservationId(result) &&
		allowed.has(status)
	);
}

function createHotelRunnerFirstOtaFallbackCoordinator({
	config,
	instanceId = `${os.hostname()}:${process.pid}:${randomHex(6)}`,
	graceMs = DEFAULT_GRACE_MS,
	leaseMs = DEFAULT_LEASE_MS,
	negativeProofTtlMs = DEFAULT_NEGATIVE_PROOF_TTL_MS,
	maxAttempts = DEFAULT_MAX_ATTEMPTS,
	dependencies = {},
} = {}) {
	if (
		!config?.configured ||
		config.projectionEnabled !== true ||
		!mongoose.Types.ObjectId.isValid(clean(config.hotelId)) ||
		!validSha256(config.hrIdFingerprint)
	) {
		throw new HotelRunnerFirstFallbackError(
			"HotelRunner-first fallback requires one configured, projection-enabled property.",
			{ code: "HOTELRUNNER_FALLBACK_CONFIG_INVALID" }
		);
	}
	const configuredHotelId = clean(config.hotelId).toLowerCase();
	const effectiveGraceMs = boundedInteger(
		graceMs,
		DEFAULT_GRACE_MS,
		MIN_GRACE_MS,
		MAX_GRACE_MS
	);
	const effectiveLeaseMs = boundedInteger(
		leaseMs,
		DEFAULT_LEASE_MS,
		MIN_LEASE_MS,
		MAX_LEASE_MS
	);
	const effectiveProofTtlMs = boundedInteger(
		negativeProofTtlMs,
		DEFAULT_NEGATIVE_PROOF_TTL_MS,
		MIN_NEGATIVE_PROOF_TTL_MS,
		MAX_NEGATIVE_PROOF_TTL_MS
	);
	const effectiveMaxAttempts = boundedInteger(
		maxAttempts,
		DEFAULT_MAX_ATTEMPTS,
		MIN_MAX_ATTEMPTS,
		MAX_MAX_ATTEMPTS
	);
	const now = () => {
		const value = (dependencies.clock || (() => new Date()))();
		const parsed = safeDate(value);
		if (!parsed) {
			throw new HotelRunnerFirstFallbackError("Coordinator clock is invalid.", {
				code: "HOTELRUNNER_FALLBACK_CLOCK_INVALID",
			});
		}
		return parsed;
	};
	const random = dependencies.random || Math.random;
	const makeToken = dependencies.randomToken || (() => randomHex(16));
	const store =
		dependencies.jobStore ||
		createMongooseJobStore({ JobModel: dependencies.JobModel });
	const ensureIndexes =
		dependencies.jobStore || dependencies.skipIndexInitialization === true
			? async () => true
			: () =>
					ensureHotelRunnerFirstFallbackIndexes({
						JobModel: dependencies.JobModel || HotelRunnerOtaFallbackJob,
					});
	const loadArchivedEmail =
		dependencies.loadArchivedEmail ||
		((id) => defaultLoadArchivedEmail(id, dependencies));
	const loadReservationById =
		dependencies.loadReservationById ||
		((id) => defaultLoadReservationById(id, dependencies));
	const loadCurrentHotel =
		dependencies.loadCurrentHotel || (() => loadConfiguredHotel(config));
	const inspectLocal =
		dependencies.inspectLocalHotelRunnerState ||
		((identity) => defaultInspectLocalHotelRunnerState(identity, dependencies));
	const priorityQueueClear =
		dependencies.isHotelRunnerPriorityQueueClear ||
		((identity, _job, checkedAt) =>
			defaultPriorityQueueClear(identity, {
				...dependencies,
				checkedAt,
				projectionNotBefore: config.projectionNotBefore,
			}));
	const markLookupEventProjectable =
		dependencies.markHotelRunnerLookupEventProjectable ||
		((context) => defaultMarkLookupEventProjectable(context, dependencies));
	const finalizeInboundAudit =
		dependencies.finalizeInboundAudit ||
		((context) => defaultFinalizeInboundAudit(context, dependencies));
	const findRecoverableArchivedEmails =
		dependencies.findRecoverableArchivedEmails ||
		((context) => defaultFindRecoverableArchivedEmails(context, dependencies));
	const markRecoveredArchivedEmail =
		dependencies.markRecoveredArchivedEmail ||
		((context) => defaultMarkRecoveredArchivedEmail(context, dependencies));
	const reconcileApiEmail =
		dependencies.reconcileApiReservationEmail ||
		((context) =>
			defaultReconcileArchivedEmail(context, {
				...dependencies,
				projectionNotBefore: config.projectionNotBefore,
			}));
	const reconcileEmailFallback =
		dependencies.reconcileEmailFallback ||
		((context) =>
			defaultReconcileArchivedEmail(context, {
				...dependencies,
				projectionNotBefore: config.projectionNotBefore,
			}));
	const enqueueTerminalNotification =
		dependencies.enqueueTerminalNotification ||
		((job) =>
			require("./hotelrunnerFallbackNotificationOutbox")
				.enqueueHotelRunnerFallbackTerminalNotification({ job }));
	const logger = dependencies.logger || console;
	let client = dependencies.client || null;
	const lookupReservation =
		dependencies.lookupHotelRunnerReservation ||
		(async (options) => {
			if (!client) {
				client = createHotelRunnerClient({
					config,
					hotelId: configuredHotelId,
					quotaDependencies: dependencies.quotaDependencies,
				});
			}
			return client.retrieveReservations(options);
		});
	const persistMatch =
		dependencies.persistHotelRunnerLookupMatch ||
		(async ({ rawReservation, checkedAt }) => {
			const hotel = await loadConfiguredHotel(config, dependencies);
			return persistHotelRunnerDelivery(
				{
					config,
					hotel,
					rawReservation,
					source: "pull",
					receivedAt: checkedAt,
				},
				dependencies
			);
		});

	const identityForJob = (job) =>
		buildIdentity({
			hotelId: job.hotelId,
			provider: job.provider,
			confirmationNumber: job.confirmationNumber,
		});
	const fallbackCreationBoundaryForJob = (job, proof) => {
		const identity = identityForJob(job);
		return {
			mode: "confirmed_empty_email_fallback",
			fallbackJobId: stringId(job._id),
			hotelId: identity.hotelId,
			provider: identity.provider,
			confirmationNumber: identity.confirmationNumber,
			identityKey: identity.identityKey,
			inboundEmailId: stringId(job.inboundEmailId).toLowerCase(),
			inboundEmailHash: lower(job.inboundEmailHash),
			normalizedReservationHash: lower(job.normalizedReservationHash),
			resolvedHotelProofHash: lower(job.resolvedHotelProofHash),
			archiveFingerprint: lower(job.archiveFingerprint),
			hrIdFingerprint: lower(job.hrIdFingerprint),
			lookupConfirmationNumber: clean(job.lookupConfirmationNumber),
			lookupConfirmationHash: lower(job.lookupConfirmationHash),
			confirmedEmptyProof: proof,
			...(job?.ingressDecision?.emailAuthorization
				? {
						creationAuthorization:
							job.ingressDecision.emailAuthorization,
				  }
				: {}),
		};
	};

	function leaseLostError() {
		return new HotelRunnerFirstFallbackError(
			"HotelRunner-first fallback lease was lost before a state transition.",
			{ code: "HOTELRUNNER_FALLBACK_LEASE_LOST", retryable: true }
		);
	}

	function replaceJobSnapshot(target, source) {
		for (const key of Object.keys(target)) delete target[key];
		Object.assign(target, source);
		return target;
	}

	async function renewLease(job) {
		const checkedAt = now();
		const renewed = await store.renewOwned(
			job,
			checkedAt,
			new Date(checkedAt.getTime() + effectiveLeaseMs)
		);
		if (!renewed) throw leaseLostError();
		return replaceJobSnapshot(job, renewed);
	}

	async function updateOwned(job, update) {
		const updated = await store.updateOwned(job, update, now());
		if (!updated) throw leaseLostError();
		return replaceJobSnapshot(job, updated);
	}

	async function completePreparedTerminal(job) {
		const status = lower(job.pendingTerminalStatus);
		const details =
			job.pendingTerminalDetails &&
			typeof job.pendingTerminalDetails === "object"
				? job.pendingTerminalDetails
				: {};
		const completedAt = safeDate(job.pendingTerminalAt) || now();
		if (
			!["completed_api", "completed_email_fallback", "needs_review"].includes(
				status
			)
		) {
			throw new HotelRunnerFirstFallbackError(
				"The prepared HotelRunner-first terminal transition is invalid.",
				{ code: "HOTELRUNNER_FALLBACK_TERMINAL_PREPARE_INVALID" }
			);
		}
		if (details.skipAuditFinalization !== true) {
			await finalizeInboundAudit({
				job,
				status,
				details,
				finalizedAt: completedAt,
			});
		}
		const notificationRequired = [
			"completed_api",
			"completed_email_fallback",
		].includes(status);
		const terminalJob = await updateOwned(job, {
			$set: {
				status,
				completedAt,
				lastDecision: details.decision || status,
				lastErrorCode: details.code || "",
				lastErrorMessage: details.message || "",
				result: details.result || {},
				inboundAuditFinalizationStatus:
					details.skipAuditFinalization === true ? "retry" : "completed",
				notificationOutboxStatus: notificationRequired ? "pending" : "",
				...(details.skipAuditFinalization === true
					? {}
					: { inboundAuditFinalizedAt: completedAt }),
				...(details.eventId ? { hotelRunnerEventId: details.eventId } : {}),
				...(details.mirrorId ? { hotelRunnerMirrorId: details.mirrorId } : {}),
				...(details.reservationId
					? { reservationMongoId: details.reservationId }
					: {}),
			},
			$unset: {
				pendingTerminalStatus: 1,
				pendingTerminalDetails: 1,
				pendingTerminalAt: 1,
				leaseOwner: 1,
				leaseToken: 1,
				leaseAcquiredAt: 1,
				leaseUntil: 1,
			},
		});
		if (notificationRequired) {
			try {
				await enqueueTerminalNotification(terminalJob);
			} catch (error) {
				// The pending marker is committed with the terminal result and is
				// recovered by the PM2 outbox consumer. Notification delivery can
				// never roll back or replace the reservation decision.
				logger.error?.("[hotelrunner-first] terminal notification enqueue deferred", {
					jobId: stringId(terminalJob._id),
					code:
						clean(error?.code) ||
						"HOTELRUNNER_FALLBACK_NOTIFICATION_ENQUEUE_FAILED",
					message: safeErrorMessage(error),
				});
			}
		}
		return terminalJob;
	}

	async function finishOwned(job, status, details = {}) {
		const completedAt = now();
		await updateOwned(job, {
			$set: {
				pendingTerminalStatus: status,
				pendingTerminalDetails: details,
				pendingTerminalAt: completedAt,
				inboundAuditFinalizationStatus:
					details.skipAuditFinalization === true ? "retry" : "pending",
			},
		});
		return completePreparedTerminal(job);
	}

	async function retryOwned(job, error, options = {}) {
		const preparedTerminalStatus = lower(job.pendingTerminalStatus);
		const consumeAttempt = preparedTerminalStatus
			? false
			: options.consumeAttempt !== false;
		if (
			consumeAttempt &&
			Number(job.attemptCount || 0) >= effectiveMaxAttempts
		) {
			return finishOwned(job, "needs_review", {
				decision: "retry_exhausted",
				code: "HOTELRUNNER_FALLBACK_RETRY_EXHAUSTED",
				message:
					"HotelRunner-first processing exhausted its bounded retry budget; email fallback was not allowed.",
			});
		}
		const retryAt = now();
		const delay = Number.isFinite(options.delayMs)
			? Math.max(1000, options.delayMs)
			: retryDelayMs(job.attemptCount, random);
		const unset = {
			leaseOwner: 1,
			leaseToken: 1,
			leaseAcquiredAt: 1,
			leaseUntil: 1,
		};
		if (options.clearNegativeProof === true) unset.negativeLookupProof = 1;
		const update = {
			$set: {
				status: "retry",
				nextAttemptAt: new Date(retryAt.getTime() + delay),
				completedAt: null,
				lastDecision: preparedTerminalStatus
					? "terminal_audit_finalization_retry"
					: options.decision || "retry",
				lastErrorCode:
					(preparedTerminalStatus
						? "HOTELRUNNER_FALLBACK_TERMINAL_AUDIT_RETRY"
						: options.code) ||
					clean(error?.code) ||
					"HOTELRUNNER_FALLBACK_RETRY",
				lastErrorMessage: safeErrorMessage(error),
			},
			$unset: unset,
		};
		if (!consumeAttempt) update.$inc = { attemptCount: -1 };
		return updateOwned(job, update);
	}

	const retryApiObservedEventPending = (job, error = null) =>
		retryOwned(
			job,
			error ||
				new Error(
					"HotelRunner callback was ordered before its event became visible."
				),
			{
				decision: "hotelrunner_api_observed_event_pending",
				code: "HOTELRUNNER_FALLBACK_API_OBSERVED_EVENT_PENDING",
				delayMs: 5_000,
				consumeAttempt: false,
				clearNegativeProof: true,
			}
		);

	async function loadAndValidateAudit(job) {
		const audit = await loadArchivedEmail(job.inboundEmailId);
		const validation = validateArchivedDirectOtaEmail(
			audit,
			identityForJob(job)
		);
		if (
			!validation.ok ||
			validation.archiveFingerprint !== job.archiveFingerprint ||
			validation.normalizedReservationHash !== job.normalizedReservationHash ||
			validation.resolvedHotelProofHash !== job.resolvedHotelProofHash ||
			validation.lookupConfirmationNumber !== job.lookupConfirmationNumber ||
			validation.lookupConfirmationHash !== job.lookupConfirmationHash ||
			validation.inboundEmailHash !== job.inboundEmailHash ||
			validation.inboundEmailId !== stringId(job.inboundEmailId).toLowerCase()
		) {
			return {
				ok: false,
				code: validation.code || "archived_email_integrity_changed",
			};
		}
		return { ok: true, audit, validation };
	}

	async function inspect(job) {
		const identity = identityForJob(job);
		const raw = await inspectLocal(identity, job);
		return classifyLocalHotelRunnerState(raw, identity, {
			projectionNotBefore: config.projectionNotBefore,
		});
	}

	async function queueIsClear(job) {
		const result = await priorityQueueClear(identityForJob(job), job, now());
		return result === true || result?.clear === true;
	}

	async function currentHotelProofMatches(job, auditResult) {
		const hotel = await loadCurrentHotel();
		const proof = resolvedHotelProofFromHotel(hotel);
		return Boolean(
			proof &&
			proof.hotelId === configuredHotelId &&
			hashStable(proof) === job.resolvedHotelProofHash &&
			hashStable(proof) === auditResult.validation.resolvedHotelProofHash
		);
	}

	async function finishHotelProofConflict(job) {
		return finishOwned(job, "needs_review", {
			decision: "resolved_hotel_proof_changed",
			code: "HOTELRUNNER_FALLBACK_RESOLVED_HOTEL_PROOF_CHANGED",
			message:
				"The configured HotelRunner hotel owner, active state, or property currency changed after the email was archived; no reservation mutation was allowed.",
		});
	}

	async function reconcileAgainstApi(job, auditResult, local) {
		await renewLease(job);
		if (!(await currentHotelProofMatches(job, auditResult))) {
			return finishHotelProofConflict(job);
		}
		const result = await reconcileApiEmail({
			mode: "api_commercial_enrichment",
			job,
			identity: identityForJob(job),
			inboundEmailId: stringId(job.inboundEmailId),
			normalizedReservation: auditResult.validation.normalizedReservation,
			archiveFingerprint: job.archiveFingerprint,
			reservationId: local.reservationId || "",
			local,
		});
		await renewLease(job);
		if (!validReconciliationResult(result, { mode: "api" })) {
			if (lower(result?.status) === "needs_review") {
				return finishOwned(job, "needs_review", {
					decision: "api_commercial_reconciliation_needs_review",
					code: clean(result?.skipReason) || "API_EMAIL_RECONCILIATION_NEEDS_REVIEW",
					message:
						"HotelRunner owns the reservation, but the archived email commercial evidence requires review.",
					result,
					reservationId: local.reservationId,
					eventId: local.eventId,
					mirrorId: local.mirrorId,
				});
			}
			throw new HotelRunnerFirstFallbackError(
				"HotelRunner API reservation email enrichment returned no verified reservation.",
				{ code: "HOTELRUNNER_FALLBACK_API_RECONCILIATION_UNCERTAIN", retryable: true }
			);
		}
		const reconciledId = resultReservationId(result);
		if (local.reservationId && reconciledId !== stringId(local.reservationId)) {
			return finishOwned(job, "needs_review", {
				decision: "api_reconciliation_identity_conflict",
				code: "HOTELRUNNER_FALLBACK_API_RECONCILIATION_IDENTITY_CONFLICT",
				message:
					"Email commercial evidence reconciled to a different reservation than the direct HotelRunner marker.",
				result,
			});
		}
		return finishOwned(job, "completed_api", {
			decision: "completed_api_with_email_commercial_evidence",
			result,
			reservationId: reconciledId,
			eventId: local.eventId,
			mirrorId: local.mirrorId,
		});
	}

	async function handleLocalState(job, auditResult, local) {
		if (local.kind === "api") {
			return reconcileAgainstApi(job, auditResult, local);
		}
		if (local.kind === "pending") {
			if (
				job.hotelRunnerEventOrigin === "targeted_identity_lookup" &&
				stringId(job.hotelRunnerEventId) &&
				stringId(job.hotelRunnerEventId) === stringId(local.eventId) &&
				local.lookupEventProjectable !== true
			) {
				const markedAt = now();
				await renewLease(job);
				await markLookupEventProjectable({
					eventId: stringId(job.hotelRunnerEventId),
					job,
					identity: identityForJob(job),
					markedAt,
				});
				await updateOwned(job, {
					$set: {
						lookupEventProjectableAt: markedAt,
						lastDecision: "targeted_lookup_event_marked_projectable",
					},
				});
			}
			return retryOwned(job, new Error("HotelRunner projection is still pending."), {
				decision: "hotelrunner_projection_pending",
				code: "HOTELRUNNER_FALLBACK_PROJECTION_PENDING",
				delayMs: 5_000,
				consumeAttempt: false,
			});
		}
		if (local.kind === "needs_review") {
			return finishOwned(job, "needs_review", {
				decision: "hotelrunner_local_state_needs_review",
				code: clean(local.code).toUpperCase(),
				message:
					"HotelRunner evidence exists but cannot be selected safely; email fallback was not allowed.",
				result: local,
				reservationId: local.reservationId,
				eventId: local.eventId,
				mirrorId: local.mirrorId,
			});
		}
		if (local.kind === "uncertain") {
			return retryOwned(job, new Error("HotelRunner local state is uncertain."), {
				decision: "hotelrunner_local_state_uncertain",
				code: clean(local.code).toUpperCase(),
				clearNegativeProof: true,
			});
		}
		return null;
	}

	async function applyEmailFallback(job, auditResult, proof) {
		if (!validConfirmedEmptyProof(job, proof, now())) {
			throw new HotelRunnerFirstFallbackError(
				"Email fallback requires a current, identity-bound confirmed-empty HotelRunner proof.",
				{ code: "HOTELRUNNER_FALLBACK_NEGATIVE_PROOF_INVALID", retryable: true }
			);
		}
		await renewLease(job);
		if (lower(job.ingressDecision?.status) === "api_observed") {
			return retryApiObservedEventPending(job);
		}
		if (!(await currentHotelProofMatches(job, auditResult))) {
			return finishHotelProofConflict(job);
		}
		const result = await reconcileEmailFallback({
			mode: "confirmed_empty_email_fallback",
			job,
			identity: identityForJob(job),
			inboundEmailId: stringId(job.inboundEmailId),
			normalizedReservation: auditResult.validation.normalizedReservation,
			archiveFingerprint: job.archiveFingerprint,
			confirmedEmptyProof: proof,
		});
		await renewLease(job);
		if (!validReconciliationResult(result, { mode: "email_fallback" })) {
			if (lower(result?.status) === "needs_review") {
				return finishOwned(job, "needs_review", {
					decision: "email_fallback_needs_review",
					code: clean(result?.skipReason) || "EMAIL_FALLBACK_NEEDS_REVIEW",
					message:
						"HotelRunner confirmed no matching reservation, but the archived email requires manual review.",
					result,
					reservationId: resultReservationId(result),
				});
			}
			throw new HotelRunnerFirstFallbackError(
				"Email fallback returned no verified reservation.",
				{ code: "HOTELRUNNER_EMAIL_FALLBACK_RESULT_UNCERTAIN", retryable: true }
			);
		}
		const reconciledId = resultReservationId(result);
		const persistedReservation = await loadReservationById(reconciledId);
		if (
			!persistedReservation ||
			stringId(persistedReservation._id) !== reconciledId ||
			!reservationMatchesIdentity(
				persistedReservation,
				identityForJob(job)
			)
		) {
			return finishOwned(job, "needs_review", {
				decision: "email_fallback_result_identity_conflict",
				code: "HOTELRUNNER_EMAIL_FALLBACK_RESULT_IDENTITY_CONFLICT",
				message:
					"The email fallback result did not resolve to the exact queued hotel and OTA identity.",
				result,
			});
		}
		return finishOwned(job, "completed_email_fallback", {
			decision: "completed_email_fallback_after_confirmed_empty_lookup",
			result,
			reservationId: reconciledId,
		});
	}

	async function applyExpiredEmailFallbackReplay(job, auditResult, proof) {
		if (!expiredConfirmedEmptyProof(job, proof, now())) return null;
		await renewLease(job);
		if (!(await currentHotelProofMatches(job, auditResult))) {
			return finishHotelProofConflict(job);
		}
		const result = await reconcileEmailFallback({
			mode: "confirmed_empty_email_fallback",
			job,
			identity: identityForJob(job),
			inboundEmailId: stringId(job.inboundEmailId),
			normalizedReservation: auditResult.validation.normalizedReservation,
			archiveFingerprint: job.archiveFingerprint,
			confirmedEmptyProof: proof,
		});
		await renewLease(job);
		if (
			lower(result?.status) === "needs_review" &&
			clean(result?.skipReason) ===
				"hotelrunner_first_fallback_expired_replay_not_found"
		) {
			return retryOwned(
				job,
				new Error(
					"Expired fallback proof had no exact prior creation marker."
				),
				{
					decision: "expired_fallback_replay_not_found",
					code: "HOTELRUNNER_FALLBACK_EXPIRED_REPLAY_NOT_FOUND",
					clearNegativeProof: true,
					consumeAttempt: false,
				}
			);
		}
		if (
			lower(result?.status) !== "duplicate_reservation" ||
			clean(result?.skipReason) !==
				"hotelrunner_first_fallback_creation_replay_adopted" ||
			!resultReservationId(result)
		) {
			return finishOwned(job, "needs_review", {
				decision: "expired_fallback_replay_marker_conflict",
				code:
					clean(result?.skipReason) ||
					"HOTELRUNNER_FALLBACK_EXPIRED_REPLAY_MARKER_CONFLICT",
				message:
					"An expired fallback proof could not be linked to one exact immutable prior creation marker; no reservation was changed.",
				result,
			});
		}
		const reconciledId = resultReservationId(result);
		const persistedReservation = await loadReservationById(reconciledId);
		const markerBoundary = fallbackCreationBoundaryForJob(job, proof);
		if (
			!persistedReservation ||
			stringId(persistedReservation._id) !== reconciledId ||
			!reservationMatchesIdentity(
				persistedReservation,
				identityForJob(job)
			) ||
			!reservationHasExactHotelRunnerFirstFallbackCreationMarker(
				persistedReservation,
				markerBoundary
			)
		) {
			return finishOwned(job, "needs_review", {
				decision: "expired_fallback_replay_persisted_marker_conflict",
				code: "HOTELRUNNER_FALLBACK_EXPIRED_REPLAY_MARKER_CONFLICT",
				message:
					"The replay result did not contain the exact immutable fallback creation marker; no reservation was adopted.",
				result,
			});
		}
		return finishOwned(job, "completed_email_fallback", {
			decision: "completed_email_fallback_expired_proof_replay",
			result,
			reservationId: reconciledId,
		});
	}

	async function processClaimedJob(job) {
		if (clean(job.pendingTerminalStatus)) {
			return completePreparedTerminal(job);
		}
		if (lower(job.hrIdFingerprint) !== lower(config.hrIdFingerprint)) {
			return finishOwned(job, "needs_review", {
				decision: "hotelrunner_configuration_identity_changed",
				code: "HOTELRUNNER_FALLBACK_HR_ID_FINGERPRINT_MISMATCH",
				message:
					"The HotelRunner property credentials changed after this email was queued; no API lookup or email fallback was allowed.",
			});
		}
		if (job.identityConflict === true) {
			return finishOwned(job, "needs_review", {
				decision: "identity_collision",
				code: "HOTELRUNNER_FALLBACK_IDENTITY_COLLISION",
				message:
					"Conflicting archived OTA emails claimed the same HotelRunner fallback identity; no reservation mutation was allowed.",
			});
		}
		const auditResult = await loadAndValidateAudit(job);
		if (!auditResult.ok) {
			return finishOwned(job, "needs_review", {
				decision: "archived_email_integrity_rejected",
				code: clean(auditResult.code).toUpperCase(),
				message:
					"The archived direct-OTA email no longer matches the immutable queued evidence.",
				integrityRejected: true,
			});
		}
		if (!(await currentHotelProofMatches(job, auditResult))) {
			return finishHotelProofConflict(job);
		}

		let local = await inspect(job);
		const localResult = await handleLocalState(job, auditResult, local);
		if (localResult) return localResult;
		if (lower(job.ingressDecision?.status) === "api_observed") {
			// Callback persistence linearizes on the job before the event upsert. A
			// process/storage failure may therefore leave a short, intentional gap in
			// which local inspection is still absent. Never query-authorize email in
			// that gap; HotelRunner redelivery/event visibility must win.
			return retryApiObservedEventPending(job);
		}

		if (!(await queueIsClear(job))) {
			return retryOwned(job, new Error("HotelRunner event projection has priority work."), {
				decision: "hotelrunner_priority_queue_not_clear",
				code: "HOTELRUNNER_FALLBACK_PRIORITY_QUEUE_NOT_CLEAR",
				delayMs: 5_000,
				consumeAttempt: false,
			});
		}

		let proof = job.negativeLookupProof;
		const expiredReplayResult = await applyExpiredEmailFallbackReplay(
			job,
			auditResult,
			proof
		);
		if (expiredReplayResult) return expiredReplayResult;
		if (!validConfirmedEmptyProof(job, proof, now())) {
			await renewLease(job);
			// This read-only vendor call deliberately runs outside any MongoDB
			// transaction. Its result is classified first and only then persisted by
			// an owned CAS transition.
			const checkedAt = now();
			const envelope = await lookupReservation({
				reservationNumber: job.lookupConfirmationNumber,
				undelivered: false,
				page: 1,
				perPage: 50,
			});
			await renewLease(job);
			const lookup = classifyHotelRunnerLookupEnvelope(
				envelope,
				identityForJob(job),
				{
					normalizeReservation:
						dependencies.normalizeHotelRunnerReservation ||
						normalizeHotelRunnerReservation,
					checkedAt,
				}
			);
			await updateOwned(job, {
				$set: {
					lastLookup: {
						status: lookup.kind,
						checkedAt,
						responseHash: lookup.responseHash || "",
						resultCount:
							lookup.resultCount === undefined ? null : lookup.resultCount,
						code: lookup.code || "",
					},
					lastDecision: `lookup_${lookup.kind}`,
				},
				$inc: { lookupAttemptCount: 1 },
			});

			if (lookup.kind === "uncertain") {
				return retryOwned(job, new Error("HotelRunner exact lookup was uncertain."), {
					decision: "hotelrunner_lookup_uncertain",
					code: clean(lookup.code).toUpperCase(),
					clearNegativeProof: true,
				});
			}
			if (lookup.kind === "ambiguous") {
				return finishOwned(job, "needs_review", {
					decision: "hotelrunner_lookup_ambiguous",
					code: clean(lookup.code).toUpperCase(),
					message:
						"HotelRunner returned ambiguous identity evidence; email fallback was not allowed.",
					result: {
						lookupStatus: lookup.kind,
						resultCount: lookup.resultCount,
						responseHash: lookup.responseHash,
					},
				});
			}
			if (lookup.kind === "match") {
				await renewLease(job);
				const persisted = await persistMatch({
					job,
					identity: identityForJob(job),
					rawReservation: lookup.rawReservation,
					normalized: lookup.normalized,
					checkedAt,
				});
				await renewLease(job);
				if (
					persisted?.integrityConflict === true ||
					["attention", "failed", "needs_mapping", "quarantined"].includes(
						lower(persisted?.status)
					)
				) {
					return finishOwned(job, "needs_review", {
						decision: "hotelrunner_lookup_match_persist_conflict",
						code: "HOTELRUNNER_LOOKUP_MATCH_PERSIST_CONFLICT",
						message:
							"The exact HotelRunner lookup matched, but its durable event requires review.",
						result: {
							status: persisted?.status || "",
							integrityConflict: persisted?.integrityConflict === true,
						},
						eventId: stringId(persisted?.eventId),
					});
				}
				const eventId = stringId(persisted?.eventId);
				if (!eventId) {
					throw new HotelRunnerFirstFallbackError(
						"The exact HotelRunner match was not linked to a durable event.",
						{ code: "HOTELRUNNER_LOOKUP_EVENT_ID_MISSING", retryable: true }
					);
				}
				await updateOwned(job, {
					$set: {
						hotelRunnerEventId: eventId,
						hotelRunnerEventOrigin: "targeted_identity_lookup",
						lastDecision: "targeted_lookup_event_persisted",
					},
				});
				const markedAt = now();
				await markLookupEventProjectable({
					eventId,
					job,
					identity: identityForJob(job),
					markedAt,
				});
				await updateOwned(job, {
					$set: { lookupEventProjectableAt: markedAt },
				});
				return retryOwned(
					job,
					new Error("Exact HotelRunner reservation was queued for API projection."),
					{
						decision: "hotelrunner_lookup_match_queued_for_projection",
						code: "HOTELRUNNER_LOOKUP_MATCH_QUEUED",
						delayMs: 1_000,
						clearNegativeProof: true,
						consumeAttempt: false,
					}
				);
			}

			proof = buildConfirmedEmptyProof({
				job,
				lookup,
				now: checkedAt,
				proofTtlMs: effectiveProofTtlMs,
				proofId: makeToken(),
			});
			await updateOwned(job, {
				$set: {
					negativeLookupProof: proof,
					lastDecision: "hotelrunner_lookup_confirmed_empty",
				},
			});
		}

		// A callback may have arrived while the exact lookup was in flight. The
		// identity state and the property-wide event queue are both checked again
		// before the email mapper is allowed to mutate anything.
		local = await inspect(job);
		const finalLocalResult = await handleLocalState(job, auditResult, local);
		if (finalLocalResult) return finalLocalResult;
		if (!(await queueIsClear(job))) {
			return retryOwned(job, new Error("HotelRunner callback arrived before fallback."), {
				decision: "hotelrunner_priority_queue_changed_before_fallback",
				code: "HOTELRUNNER_FALLBACK_PRIORITY_QUEUE_CHANGED",
				delayMs: 5_000,
				consumeAttempt: false,
			});
		}
		if (!validConfirmedEmptyProof(job, proof, now())) {
			return retryOwned(job, new Error("Confirmed-empty proof expired before fallback."), {
				decision: "hotelrunner_negative_proof_expired",
				code: "HOTELRUNNER_FALLBACK_NEGATIVE_PROOF_EXPIRED",
				clearNegativeProof: true,
			});
		}
		return applyEmailFallback(job, auditResult, proof);
	}

	async function enqueueArchivedEmail({
		inboundEmailId,
		hotelId,
		provider,
		confirmationNumber,
	} = {}) {
		await ensureIndexes();
		const identity = buildIdentity({ hotelId, provider, confirmationNumber });
		if (identity.hotelId !== configuredHotelId) {
			throw new HotelRunnerFirstFallbackError(
				"The archived OTA email does not belong to this HotelRunner property.",
				{ code: "HOTELRUNNER_FALLBACK_PROPERTY_MISMATCH" }
			);
		}
		if (!mongoose.Types.ObjectId.isValid(clean(inboundEmailId))) {
			throw new HotelRunnerFirstFallbackError(
				"A persisted inbound email identifier is required.",
				{ code: "HOTELRUNNER_FALLBACK_INBOUND_EMAIL_ID_INVALID" }
			);
		}
		const audit = await loadArchivedEmail(inboundEmailId);
		if (stringId(audit?._id) !== clean(inboundEmailId)) {
			throw new HotelRunnerFirstFallbackError(
				"The persisted inbound email could not be loaded exactly.",
				{ code: "HOTELRUNNER_FALLBACK_ARCHIVE_NOT_FOUND" }
			);
		}
		const validation = validateArchivedDirectOtaEmail(audit, identity);
		if (!validation.ok) {
			throw new HotelRunnerFirstFallbackError(
				"The archived email is not an authenticated direct-OTA new reservation.",
				{ code: clean(validation.code).toUpperCase() }
			);
		}
		const queuedAt = now();
		const receivedAt = safeDate(audit.receivedAt);
		const graceAnchor =
			receivedAt && receivedAt.getTime() <= queuedAt.getTime() + 60_000
				? receivedAt
				: queuedAt;
		const notBefore = new Date(graceAnchor.getTime() + effectiveGraceMs);
		const document = {
			...identity,
			lookupConfirmationNumber: validation.lookupConfirmationNumber,
			lookupConfirmationHash: validation.lookupConfirmationHash,
			hrIdFingerprint: config.hrIdFingerprint,
			inboundEmailId: validation.inboundEmailId,
			inboundEmailHash: validation.inboundEmailHash,
			normalizedReservationHash: validation.normalizedReservationHash,
			resolvedHotelProofHash: validation.resolvedHotelProofHash,
			archiveFingerprint: validation.archiveFingerprint,
			status: "awaiting_hotelrunner",
			notBefore,
			nextAttemptAt: notBefore,
		};
		let job = await store.upsertIdentity(document, queuedAt);
		if (!job) {
			throw new HotelRunnerFirstFallbackError(
				"The HotelRunner-first fallback job could not be persisted.",
				{ code: "HOTELRUNNER_FALLBACK_ENQUEUE_FAILED", retryable: true }
			);
		}
		if (job.archiveFingerprint !== validation.archiveFingerprint) {
			job = await store.recordCollision(
				job,
				{
					inboundEmailId: validation.inboundEmailId,
					inboundEmailHash: validation.inboundEmailHash,
					normalizedReservationHash: validation.normalizedReservationHash,
					lookupConfirmationHash: validation.lookupConfirmationHash,
					archiveFingerprint: validation.archiveFingerprint,
					observedAt: queuedAt,
				},
				queuedAt
			);
			if (!job) {
				throw new HotelRunnerFirstFallbackError(
					"The OTA identity changed concurrently while recording a collision.",
					{ code: "HOTELRUNNER_FALLBACK_COLLISION_CAS_LOST", retryable: true }
				);
			}
			return { job, queued: false, collision: true };
		}
		return { job, queued: true, collision: false };
	}

	async function recoverOrphanedArchivedEmails({
		staleBefore = new Date(now().getTime() - 30_000),
		limit = 100,
	} = {}) {
		const cutoff = safeDate(staleBefore);
		if (!cutoff) {
			throw new HotelRunnerFirstFallbackError(
				"Archived-email recovery requires a valid cutoff.",
				{ code: "HOTELRUNNER_FALLBACK_RECOVERY_CUTOFF_INVALID" }
			);
		}
		const boundedLimit = boundedInteger(limit, 100, 1, 250);
		const candidates = await findRecoverableArchivedEmails({
			hotelId: configuredHotelId,
			staleBefore: cutoff,
			limit: boundedLimit,
		});
		if (!Array.isArray(candidates)) {
			throw new HotelRunnerFirstFallbackError(
				"Archived-email recovery returned an invalid candidate list.",
				{ code: "HOTELRUNNER_FALLBACK_RECOVERY_SCAN_INVALID", retryable: true }
			);
		}
		const results = [];
		for (const candidate of candidates.slice(0, boundedLimit)) {
			try {
				const identity = buildIdentity({
					hotelId: candidate.hotelId,
					provider: candidate.provider,
					confirmationNumber: candidate.confirmationNumber,
				});
				const existing = await store.findByIdentity(identity);
				if (
					existing &&
					stringId(existing.inboundEmailId) === stringId(candidate._id)
				) {
					await markRecoveredArchivedEmail({
						candidate,
						job: existing,
						status: "already_queued",
						markedAt: now(),
					});
					results.push({
						inboundEmailId: stringId(candidate._id),
						status: "already_queued",
						jobId: stringId(existing._id),
					});
					continue;
				}
				const enqueued = await enqueueArchivedEmail({
					inboundEmailId: candidate._id,
					...identity,
				});
				await markRecoveredArchivedEmail({
					candidate,
					job: enqueued.job,
					status: enqueued.collision ? "collision" : "enqueued",
					markedAt: now(),
				});
				results.push({
					inboundEmailId: stringId(candidate._id),
					status: enqueued.collision ? "collision" : "enqueued",
					jobId: stringId(enqueued.job?._id),
				});
			} catch (error) {
				results.push({
					inboundEmailId: stringId(candidate?._id),
					status: "held",
					code: clean(error?.code) || "HOTELRUNNER_FALLBACK_RECOVERY_HELD",
				});
			}
		}
		return {
			scanned: candidates.length,
			enqueued: results.filter((result) => result.status === "enqueued").length,
			alreadyQueued: results.filter((result) => result.status === "already_queued")
				.length,
			held: results.filter((result) => result.status === "held").length,
			results,
		};
	}

	async function claimJob() {
		const claimedAt = now();
		return store.claim({
			hotelId: configuredHotelId,
			instanceId,
			leaseToken: makeToken(),
			now: claimedAt,
			leaseUntil: new Date(claimedAt.getTime() + effectiveLeaseMs),
			maxAttempts: effectiveMaxAttempts,
		});
	}

	async function hasDueWork() {
		return store.hasDueWork({ hotelId: configuredHotelId, now: now() });
	}

	async function markExhaustedJob() {
		const claimedAt = now();
		const job = await store.markExhausted({
			hotelId: configuredHotelId,
			now: claimedAt,
			maxAttempts: effectiveMaxAttempts,
			instanceId,
			leaseToken: makeToken(),
			leaseUntil: new Date(claimedAt.getTime() + effectiveLeaseMs),
		});
		if (!job) return null;
		if (clean(job.pendingTerminalStatus)) {
			return completePreparedTerminal(job);
		}
		return finishOwned(job, "needs_review", {
			decision: "retry_exhausted",
			code: "HOTELRUNNER_FALLBACK_RETRY_EXHAUSTED",
			message:
				"HotelRunner-first processing exhausted its bounded retry budget; email fallback was not allowed.",
		});
	}

	async function runOnce() {
		const exhausted = await markExhaustedJob();
		if (exhausted) return exhausted;
		const job = await claimJob();
		if (!job) return null;
		try {
			return await processClaimedJob(job);
		} catch (error) {
			if (error?.code === "HOTELRUNNER_FALLBACK_LEASE_LOST") return null;
			try {
				if (
					error?.code ===
					"HOTELRUNNER_FALLBACK_API_OBSERVED_BEFORE_EMAIL"
				) {
					return await retryApiObservedEventPending(job, error);
				}
				return await retryOwned(job, error, {
					decision: "processing_error_fail_closed",
					code: clean(error?.code) || "HOTELRUNNER_FALLBACK_PROCESSING_ERROR",
					clearNegativeProof:
						error?.code !== "HOTELRUNNER_FALLBACK_PROJECTION_PENDING",
				});
			} catch (retryError) {
				if (retryError?.code === "HOTELRUNNER_FALLBACK_LEASE_LOST") return null;
				throw retryError;
			}
		}
	}

	async function runUntilIdle({ maxCycles = 100 } = {}) {
		let processed = 0;
		while (processed < maxCycles && (await runOnce())) processed += 1;
		return processed;
	}

	return {
		claimJob,
		configuredHotelId,
		effectiveGraceMs,
		effectiveLeaseMs,
		effectiveMaxAttempts,
		effectiveProofTtlMs,
		enqueueArchivedEmail,
		ensureIndexes,
		hasDueWork,
		instanceId,
		markExhaustedJob,
		processClaimedJob,
		recoverOrphanedArchivedEmails,
		runOnce,
		runUntilIdle,
	};
}

module.exports = {
	ACTIVE_HOTELRUNNER_EVENT_STATES,
	ACTIVE_JOB_STATES,
	DEFAULT_GRACE_MS,
	DEFAULT_LEASE_MS,
	DEFAULT_MAX_ATTEMPTS,
	DEFAULT_NEGATIVE_PROOF_TTL_MS,
	DIRECT_OTA_PROVIDERS,
	HotelRunnerFirstFallbackError,
	TARGETED_LOOKUP_EVENT_MARKER_PATH,
	buildConfirmedEmptyProof,
	buildHotelRunnerProjectionEligibilityFilter,
	buildHotelRunnerPriorityWorkQuery,
	buildHotelRunnerPriorityWorkQueryForConfig,
	buildIdentity,
	canonicalConfirmation,
	canonicalProvider,
	classifyHotelRunnerLookupEnvelope,
	classifyLocalHotelRunnerState,
	createArchiveFingerprint,
	createHotelRunnerFirstOtaFallbackCoordinator,
	createMongooseJobStore,
	defaultFinalizeInboundAudit,
	defaultFindRecoverableArchivedEmails,
	defaultInspectLocalHotelRunnerState,
	defaultMarkRecoveredArchivedEmail,
	defaultMarkLookupEventProjectable,
	defaultReconcileArchivedEmail,
	directReservationMatchesIdentity,
	hashStable,
	ensureHotelRunnerFirstFallbackIndexes,
	resetHotelRunnerFirstFallbackIndexesForTests,
	retryDelayMs,
	reservationMatchesIdentity,
	safeErrorMessage,
	stableStringify,
	validateArchivedDirectOtaEmail,
	validConfirmedEmptyProof,
};
