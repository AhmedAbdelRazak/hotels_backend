/** @format */

"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const HotelRunnerOtaFallbackJob = require("../models/hotelrunner_ota_fallback_job");
const Reservations = require("../models/reservations");
const {
	hashStable,
} = require("./hotelrunnerFirstOtaFallbackCanonical");

const ACTIVE_JOB_STATES = ["awaiting_hotelrunner", "retry", "processing"];
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
]);

class HotelRunnerFallbackIngressGateError extends Error {
	constructor(message, { code, retryable = true } = {}) {
		super(message);
		this.name = "HotelRunnerFallbackIngressGateError";
		this.code = code || "HOTELRUNNER_FALLBACK_INGRESS_GATE_ERROR";
		this.retryable = retryable !== false;
	}
}

const clean = (value = "") => String(value?._id || value || "").trim();
const lower = (value = "") => clean(value).toLowerCase();
const validObjectId = (value) => mongoose.Types.ObjectId.isValid(clean(value));
const validHash = (value) => /^[a-f0-9]{64}$/.test(lower(value));
const safeDate = (value) => {
	const parsed = value instanceof Date ? new Date(value) : new Date(value || "");
	return Number.isFinite(parsed.getTime()) ? parsed : null;
};
const randomToken = () => crypto.randomBytes(32).toString("hex");
const sha256 = (value) =>
	crypto.createHash("sha256").update(String(value), "utf8").digest("hex");
const hasExactKeys = (value, expected) =>
	Boolean(
		value &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		JSON.stringify(Object.keys(value).sort()) ===
			JSON.stringify([...expected].sort())
	);

function canonicalProvider(value = "") {
	const key = lower(value)
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, "");
	return PROVIDER_ALIASES.get(key) || "";
}

function canonicalConfirmation(value = "") {
	const normalized = lower(value).replace(/\s+/g, " ");
	return normalized && normalized.length <= 256 ? normalized : "";
}

function normalizeIngressIdentity({ hotelId, provider, confirmationNumber } = {}) {
	const normalized = {
		hotelId: clean(hotelId).toLowerCase(),
		provider: canonicalProvider(provider),
		confirmationNumber: canonicalConfirmation(confirmationNumber),
	};
	if (
		!validObjectId(normalized.hotelId) ||
		!normalized.provider ||
		!normalized.confirmationNumber
	) {
		return null;
	}
	return normalized;
}

function normalizeApiObservation(input = {}) {
	if (lower(input.source || "push") !== "push") return null;
	const identity = normalizeIngressIdentity(input);
	const observationKey = lower(input.observationKey || input.eventKey);
	const payloadHash = lower(input.payloadHash);
	const observedAt = safeDate(input.observedAt) || new Date();
	if (!identity || !validHash(observationKey) || !validHash(payloadHash)) {
		return null;
	}
	return {
		...identity,
		observationKey,
		payloadHash,
		observedAt,
	};
}

function authorizationBindingFromBoundary(boundary = {}) {
	const binding = {
		version: 1,
		jobId: clean(boundary.fallbackJobId).toLowerCase(),
		hotelId: clean(boundary.hotelId).toLowerCase(),
		provider: canonicalProvider(boundary.provider),
		confirmationNumber: canonicalConfirmation(boundary.confirmationNumber),
		identityKey: lower(boundary.identityKey),
		archiveFingerprint: lower(boundary.archiveFingerprint),
		inboundEmailId: clean(boundary.inboundEmailId).toLowerCase(),
		inboundEmailHash: lower(boundary.inboundEmailHash),
		normalizedReservationHash: lower(boundary.normalizedReservationHash),
		resolvedHotelProofHash: lower(boundary.resolvedHotelProofHash),
		hrIdFingerprint: lower(boundary.hrIdFingerprint),
		lookupConfirmationHash: lower(boundary.lookupConfirmationHash),
	};
	if (
		!validObjectId(binding.jobId) ||
		!validObjectId(binding.hotelId) ||
		!binding.provider ||
		!binding.confirmationNumber ||
		binding.identityKey !==
			`${binding.provider}:${binding.confirmationNumber}` ||
		!validObjectId(binding.inboundEmailId) ||
		![
			binding.archiveFingerprint,
			binding.inboundEmailHash,
			binding.normalizedReservationHash,
			binding.resolvedHotelProofHash,
			binding.hrIdFingerprint,
			binding.lookupConfirmationHash,
		].every(validHash)
	) {
		return null;
	}
	return binding;
}

function proofSnapshotFromBoundary(boundary = {}) {
	const proof = boundary.confirmedEmptyProof || {};
	const checkedAt = safeDate(proof.checkedAt);
	const expiresAt = safeDate(proof.expiresAt);
	const snapshot = {
		proofId: clean(proof.proofId),
		responseHash: lower(proof.responseHash),
		checkedAt: checkedAt?.toISOString() || "",
		expiresAt: expiresAt?.toISOString() || "",
	};
	if (
		!snapshot.proofId ||
		!validHash(snapshot.responseHash) ||
		!checkedAt ||
		!expiresAt ||
		expiresAt.getTime() <= checkedAt.getTime()
	) {
		return null;
	}
	return snapshot;
}

function normalizeAuthorizationBoundary(boundary = {}, at = new Date()) {
	const binding = authorizationBindingFromBoundary(boundary);
	const proof = proofSnapshotFromBoundary(boundary);
	const sourceProof = boundary.confirmedEmptyProof || {};
	const now = safeDate(at);
	const jobLeaseUntil = safeDate(boundary.jobLeaseUntil);
	const jobLeaseOwner = clean(boundary.jobLeaseOwner);
	const jobLeaseToken = lower(boundary.jobLeaseToken);
	if (
		!binding ||
		!proof ||
		lower(sourceProof.status) !== "confirmed_empty" ||
		Number(sourceProof.resultCount) !== 0 ||
		lower(sourceProof.hotelId) !== binding?.hotelId ||
		lower(sourceProof.hrIdFingerprint) !== binding?.hrIdFingerprint ||
		canonicalProvider(sourceProof.provider) !== binding?.provider ||
		canonicalConfirmation(sourceProof.confirmationNumber) !==
			binding?.confirmationNumber ||
		lower(sourceProof.lookupConfirmationHash) !==
			binding?.lookupConfirmationHash ||
		lower(sourceProof.archiveFingerprint) !== binding?.archiveFingerprint ||
		lower(sourceProof.resolvedHotelProofHash) !==
			binding?.resolvedHotelProofHash ||
		!now ||
		!jobLeaseOwner ||
		!jobLeaseToken ||
		!jobLeaseUntil ||
		jobLeaseUntil.getTime() <= now.getTime() ||
		new Date(proof.expiresAt).getTime() <= now.getTime()
	) {
		return null;
	}
	return {
		binding,
		bindingHash: hashStable(binding),
		proof,
		now,
		jobLeaseOwner,
		jobLeaseToken,
		jobLeaseUntil,
	};
}

function buildCreationAuthorization({ boundary, token, authorizedAt, leaseUntil } = {}) {
	const normalized = normalizeAuthorizationBoundary(boundary, authorizedAt);
	const normalizedToken = lower(token);
	const lease = safeDate(leaseUntil);
	if (
		!normalized ||
		!validHash(normalizedToken) ||
		!lease ||
		lease.getTime() <= normalized.now.getTime() ||
		lease.getTime() > normalized.jobLeaseUntil.getTime()
	) {
		return null;
	}
	return {
		version: 1,
		status: "email_authorized",
		token: normalizedToken,
		bindingHash: normalized.bindingHash,
		jobId: normalized.binding.jobId,
		archiveFingerprint: normalized.binding.archiveFingerprint,
		authorizedAt: normalized.now.toISOString(),
		leaseUntil: lease.toISOString(),
		proof: normalized.proof,
	};
}

function validateHotelRunnerFallbackCreationAuthorization(
	authorization,
	boundary,
	{ requireActiveLease = false, at = new Date() } = {}
) {
	const binding = authorizationBindingFromBoundary(boundary);
	const bindingHash = binding ? hashStable(binding) : "";
	const boundaryProof = proofSnapshotFromBoundary(boundary);
	const currentBoundary = requireActiveLease
		? normalizeAuthorizationBoundary(boundary, at)
		: null;
	if (
		!binding ||
		!boundaryProof ||
		(requireActiveLease && !currentBoundary) ||
		!authorization ||
		typeof authorization !== "object"
	) {
		return false;
	}
	const authorizedAt = safeDate(authorization.authorizedAt);
	const leaseUntil = safeDate(authorization.leaseUntil);
	const activeAt = safeDate(at);
	const authorizationProof = authorization.proof || {};
	const authorizationProofCheckedAt = safeDate(authorizationProof.checkedAt);
	const authorizationProofExpiresAt = safeDate(authorizationProof.expiresAt);
	return Boolean(
		hasExactKeys(authorization, [
			"version",
			"status",
			"token",
			"bindingHash",
			"jobId",
			"archiveFingerprint",
			"authorizedAt",
			"leaseUntil",
			"proof",
		]) &&
		hasExactKeys(authorizationProof, [
			"proofId",
			"responseHash",
			"checkedAt",
			"expiresAt",
		]) &&
		Number(authorization.version) === 1 &&
		lower(authorization.status) === "email_authorized" &&
		validHash(authorization.token) &&
		lower(authorization.bindingHash) === bindingHash &&
		lower(authorization.jobId) === binding.jobId &&
		lower(authorization.archiveFingerprint) ===
			binding.archiveFingerprint &&
		authorizedAt &&
		leaseUntil &&
		leaseUntil.getTime() > authorizedAt.getTime() &&
		clean(authorizationProof.proofId) &&
		validHash(authorizationProof.responseHash) &&
		authorizationProofCheckedAt &&
		authorizationProofExpiresAt &&
		authorizationProofExpiresAt.getTime() >
			authorizationProofCheckedAt.getTime() &&
		hashStable(authorizationProof) === hashStable(boundaryProof) &&
		(!requireActiveLease ||
			(activeAt &&
				leaseUntil.getTime() > activeAt.getTime()))
	);
}

function stableEqual(left, right) {
	try {
		return hashStable(left) === hashStable(right);
	} catch (_error) {
		return false;
	}
}

function reservationCarriesExactAuthorization(reservation, job, authorization) {
	const marker =
		reservation?.supplierData?.hotelRunnerFirstFallbackCreation;
	return Boolean(
		marker &&
		typeof marker === "object" &&
		!Array.isArray(marker) &&
		clean(reservation?.hotelId).toLowerCase() ===
			clean(job?.hotelId).toLowerCase() &&
		clean(marker.fallbackJobId).toLowerCase() ===
			clean(job?._id).toLowerCase() &&
		clean(marker.hotelId).toLowerCase() ===
			clean(job?.hotelId).toLowerCase() &&
		lower(marker.archiveFingerprint) === lower(job?.archiveFingerprint) &&
		lower(marker.archiveFingerprint) ===
			lower(authorization?.archiveFingerprint) &&
		stableEqual(marker.confirmedEmptyProof, authorization?.proof) &&
		stableEqual(marker.creationAuthorization, authorization)
	);
}

function openDecisionFilter() {
	return {
		$or: [
			{ "ingressDecision.status": "open" },
			{ "ingressDecision.status": "" },
			{ "ingressDecision.status": null },
			{ "ingressDecision.status": { $exists: false } },
		],
	};
}

async function leanResult(query) {
	let result = query;
	if (result && typeof result.lean === "function") result = result.lean();
	return result && typeof result.exec === "function" ? result.exec() : result;
}

function exactProofFilter(normalized) {
	const { binding, proof } = normalized;
	return {
		_id: binding.jobId,
		hotelId: binding.hotelId,
		provider: binding.provider,
		confirmationNumber: binding.confirmationNumber,
		identityKey: binding.identityKey,
		archiveFingerprint: binding.archiveFingerprint,
		inboundEmailId: binding.inboundEmailId,
		inboundEmailHash: binding.inboundEmailHash,
		normalizedReservationHash: binding.normalizedReservationHash,
		resolvedHotelProofHash: binding.resolvedHotelProofHash,
		hrIdFingerprint: binding.hrIdFingerprint,
		lookupConfirmationHash: binding.lookupConfirmationHash,
		"negativeLookupProof.status": "confirmed_empty",
		"negativeLookupProof.proofId": proof.proofId,
		"negativeLookupProof.hotelId": binding.hotelId,
		"negativeLookupProof.hrIdFingerprint": binding.hrIdFingerprint,
		"negativeLookupProof.provider": binding.provider,
		"negativeLookupProof.confirmationNumber": binding.confirmationNumber,
		"negativeLookupProof.lookupConfirmationHash":
			binding.lookupConfirmationHash,
		"negativeLookupProof.archiveFingerprint": binding.archiveFingerprint,
		"negativeLookupProof.resolvedHotelProofHash":
			binding.resolvedHotelProofHash,
		"negativeLookupProof.responseHash": proof.responseHash,
		"negativeLookupProof.resultCount": 0,
		"negativeLookupProof.checkedAt": new Date(proof.checkedAt),
		"negativeLookupProof.expiresAt": new Date(proof.expiresAt),
	};
}

function createMongooseIngressGateStore({
	JobModel = HotelRunnerOtaFallbackJob,
	ReservationModel = Reservations,
} = {}) {
	return {
		async markOpenApi(observation) {
			return leanResult(
				JobModel.findOneAndUpdate(
					{
						hotelId: observation.hotelId,
						provider: observation.provider,
						confirmationNumber: observation.confirmationNumber,
						status: { $in: ACTIVE_JOB_STATES },
						$and: [openDecisionFilter()],
					},
					{
						$set: {
							"ingressDecision.status": "api_observed",
							"ingressDecision.apiObservationKey":
								observation.observationKey,
							"ingressDecision.apiPayloadHash": observation.payloadHash,
							"ingressDecision.apiObservedAt": observation.observedAt,
							"ingressDecision.apiLastObservedAt": observation.observedAt,
						},
						$inc: { "ingressDecision.apiObservationCount": 1 },
					},
					{ new: true }
				)
			);
		},
		async touchApiObserved(job, observation) {
			return leanResult(
				JobModel.findOneAndUpdate(
					{
						_id: job._id,
						status: { $in: ACTIVE_JOB_STATES },
						"ingressDecision.status": "api_observed",
					},
					{
						$set: {
							"ingressDecision.apiLastObservedAt": observation.observedAt,
						},
						$inc: { "ingressDecision.apiObservationCount": 1 },
					},
					{ new: true }
				)
			);
		},
		async findIdentity(identity) {
			return leanResult(
				JobModel.findOne({
					hotelId: identity.hotelId,
					provider: identity.provider,
					confirmationNumber: identity.confirmationNumber,
				}).select("+result")
			);
		},
		async findJob(jobId) {
			return leanResult(JobModel.findById(jobId).select("+result"));
		},
		async authorizeOpen(normalized, authorization) {
			return leanResult(
				JobModel.findOneAndUpdate(
					{
						...exactProofFilter(normalized),
						status: "processing",
						leaseOwner: normalized.jobLeaseOwner,
						leaseToken: normalized.jobLeaseToken,
						leaseUntil: { $gte: new Date(authorization.leaseUntil) },
						$and: [openDecisionFilter()],
					},
					{
						$set: {
							"ingressDecision.status": "email_authorized",
							"ingressDecision.emailAuthorization": authorization,
							"ingressDecision.emailAuthorizationLeaseUntil":
								new Date(authorization.leaseUntil),
						},
					},
					{ new: true }
				)
			);
		},
		async releaseAuthorization(job, authorization, at, boundary) {
			return leanResult(
				JobModel.findOneAndUpdate(
					{
						_id: job._id,
						status: "processing",
						leaseOwner: boundary.jobLeaseOwner,
						leaseToken: boundary.jobLeaseToken,
						leaseUntil: { $gt: at },
						"ingressDecision.status": "email_authorized",
						"ingressDecision.emailAuthorization.token": authorization.token,
						"ingressDecision.emailAuthorization.bindingHash":
							authorization.bindingHash,
					},
					{
						$set: { "ingressDecision.status": "open" },
						$unset: {
							"ingressDecision.emailAuthorization": 1,
							"ingressDecision.emailAuthorizationLeaseUntil": 1,
						},
					},
					{ new: true }
				)
			);
		},
		async expireAuthorizationToOpen(job, authorization, at, boundary) {
			return leanResult(
				JobModel.findOneAndUpdate(
					{
						_id: job._id,
						status: "processing",
						leaseOwner: boundary.jobLeaseOwner,
						leaseToken: boundary.jobLeaseToken,
						leaseUntil: { $gt: at },
						"ingressDecision.status": "email_authorized",
						"ingressDecision.emailAuthorization.token": authorization.token,
						"ingressDecision.emailAuthorizationLeaseUntil": { $lte: at },
					},
					{
						$set: { "ingressDecision.status": "open" },
						$unset: {
							"ingressDecision.emailAuthorization": 1,
							"ingressDecision.emailAuthorizationLeaseUntil": 1,
						},
					},
					{ new: true }
				)
			);
		},
		async commitAuthorization(job, authorization, reservationId, committedAt) {
			return leanResult(
				JobModel.findOneAndUpdate(
					{
						_id: job._id,
						"ingressDecision.status": "email_authorized",
						"ingressDecision.emailAuthorization.token": authorization.token,
						"ingressDecision.emailAuthorization.bindingHash":
							authorization.bindingHash,
					},
					{
						$set: {
							"ingressDecision.status": "email_committed",
							"ingressDecision.emailReservationId": reservationId,
							"ingressDecision.emailCommittedAt": committedAt,
						},
						$unset: {
							"ingressDecision.emailAuthorizationLeaseUntil": 1,
						},
					},
					{ new: true }
				)
			);
		},
		async findReservationByAuthorization(job, authorization, reservationId = "") {
			const query = {
				hotelId: job.hotelId,
				"supplierData.hotelRunnerFirstFallbackCreation.fallbackJobId": clean(
					job._id
				),
				"supplierData.hotelRunnerFirstFallbackCreation.creationAuthorization.token":
					authorization.token,
				"supplierData.hotelRunnerFirstFallbackCreation.creationAuthorization.bindingHash":
					authorization.bindingHash,
			};
			if (validObjectId(reservationId)) query._id = reservationId;
			const matches = await leanResult(
				ReservationModel.find(query)
					.select(
						"_id hotelId supplierData.hotelRunnerFirstFallbackCreation"
					)
					.limit(2)
			);
			if (!Array.isArray(matches) || matches.length === 0) return null;
			if (matches.length !== 1) {
				throw new HotelRunnerFallbackIngressGateError(
					"Multiple reservations carry one fallback email authorization token.",
					{ code: "HOTELRUNNER_FALLBACK_AUTHORIZATION_DUPLICATE" }
				);
			}
			return matches[0];
		},
	};
}

function createHotelRunnerFallbackIngressGate({ dependencies = {} } = {}) {
	const store =
		dependencies.store || createMongooseIngressGateStore(dependencies);
	const clock = dependencies.clock || (() => new Date());
	const makeToken = dependencies.randomToken || randomToken;
	const now = () => {
		const parsed = safeDate(clock());
		if (!parsed) {
			throw new HotelRunnerFallbackIngressGateError(
				"HotelRunner ingress gate clock is invalid.",
				{ code: "HOTELRUNNER_FALLBACK_INGRESS_CLOCK_INVALID" }
			);
		}
		return parsed;
	};

	async function reservationForAuthorization(job, authorization, reservationId = "") {
		const reservation = await store.findReservationByAuthorization(
			job,
			authorization,
			reservationId
		);
		if (!reservation) return null;
		if (!reservationCarriesExactAuthorization(reservation, job, authorization)) {
			throw new HotelRunnerFallbackIngressGateError(
				"Reservation authorization marker does not exactly match the durable fallback decision.",
				{ code: "HOTELRUNNER_FALLBACK_AUTHORIZATION_MARKER_INVALID" }
			);
		}
		return reservation;
	}

	async function commitKnownReservation(job, authorization, reservation, at) {
		const committed = await store.commitAuthorization(
			job,
			authorization,
			reservation._id,
			at
		);
		if (committed) return committed;
		const current = await store.findJob(job._id);
		if (
			lower(current?.ingressDecision?.status) === "email_committed" &&
			clean(current?.ingressDecision?.emailReservationId) ===
				clean(reservation._id)
		) {
			return current;
		}
		throw new HotelRunnerFallbackIngressGateError(
			"Email fallback authorization could not be committed exactly.",
			{ code: "HOTELRUNNER_FALLBACK_EMAIL_COMMIT_CAS_LOST" }
		);
	}

	async function markApiObserved(input = {}) {
		const observation = normalizeApiObservation({
			...input,
			observedAt: input.observedAt || now(),
		});
		if (!observation) return { eligible: false, ordered: false };
		const marked = await store.markOpenApi(observation);
		if (marked) {
			return { eligible: true, ordered: true, decision: "api_observed", job: marked };
		}

		const job = await store.findIdentity(observation);
		if (!job || !ACTIVE_JOB_STATES.includes(lower(job.status))) {
			return { eligible: true, ordered: false, decision: "no_active_job", job };
		}
		const decision = lower(job.ingressDecision?.status) || "open";
		if (decision === "api_observed") {
			const touched = await store.touchApiObserved(job, observation);
			if (!touched) {
				throw new HotelRunnerFallbackIngressGateError(
					"HotelRunner API observation redelivery could not be ordered durably.",
					{ code: "HOTELRUNNER_FALLBACK_API_OBSERVATION_CAS_LOST" }
				);
			}
			return { eligible: true, ordered: true, decision, job: touched };
		}
		if (decision === "email_committed") {
			return { eligible: true, ordered: true, decision, job };
		}
		if (decision === "email_authorized") {
			const authorization = job.ingressDecision?.emailAuthorization;
			const leaseUntil = safeDate(
				job.ingressDecision?.emailAuthorizationLeaseUntil ||
					authorization?.leaseUntil
			);
			if (!authorization || !leaseUntil) {
				throw new HotelRunnerFallbackIngressGateError(
					"Active email fallback authorization is internally incomplete.",
					{ code: "HOTELRUNNER_FALLBACK_EMAIL_AUTHORIZATION_INVALID" }
				);
			}
			if (leaseUntil.getTime() > observation.observedAt.getTime()) {
				throw new HotelRunnerFallbackIngressGateError(
					"Email fallback identity commit is in progress; HotelRunner must retry this callback.",
					{ code: "HOTELRUNNER_FALLBACK_EMAIL_COMMIT_IN_PROGRESS" }
				);
			}
			const reservation = await reservationForAuthorization(job, authorization);
			if (reservation) {
				await commitKnownReservation(
					job,
					authorization,
					reservation,
					observation.observedAt
				);
				return {
					eligible: true,
					ordered: true,
					decision: "email_committed",
					job,
				};
			}
			// A callback cannot revoke an authorization merely because its owner
			// lease expired: the original insert acknowledgement may still be in
			// flight. Only a reclaimed coordinator, after repeating its local/vendor
			// checks, may reopen this decision. Until then HotelRunner must retry.
			throw new HotelRunnerFallbackIngressGateError(
				"Email fallback authorization needs coordinator recovery before this callback can be ordered.",
				{ code: "HOTELRUNNER_FALLBACK_EMAIL_COMMIT_RECOVERY_REQUIRED" }
			);
		}
		throw new HotelRunnerFallbackIngressGateError(
			"HotelRunner callback could not establish a durable ingress order.",
			{ code: "HOTELRUNNER_FALLBACK_API_ORDER_UNCERTAIN" }
		);
	}

	async function authorizeEmailCreation({ boundary } = {}) {
		const checkedAt = now();
		const normalized = normalizeAuthorizationBoundary(boundary, checkedAt);
		if (!normalized) {
			throw new HotelRunnerFallbackIngressGateError(
				"Email fallback creation authorization boundary is invalid or expired.",
				{ code: "HOTELRUNNER_FALLBACK_EMAIL_AUTHORIZATION_BOUNDARY_INVALID" }
			);
		}
		// The identity-commit exclusion shares the already-bounded worker lease.
		// A shorter independent timer would let a callback preempt a still-owned
		// mapper whose insert acknowledgement is in flight.
		const leaseUntil = new Date(normalized.jobLeaseUntil);
		if (leaseUntil.getTime() - checkedAt.getTime() < 1_000) {
			throw new HotelRunnerFallbackIngressGateError(
				"The owned fallback job lease is too short for an email create commit.",
				{ code: "HOTELRUNNER_FALLBACK_EMAIL_AUTHORIZATION_LEASE_SHORT" }
			);
		}
		const proposed = buildCreationAuthorization({
			boundary,
			token: makeToken(),
			authorizedAt: checkedAt,
			leaseUntil,
		});
		if (!proposed) {
			throw new HotelRunnerFallbackIngressGateError(
				"Email fallback creation authorization could not be constructed.",
				{ code: "HOTELRUNNER_FALLBACK_EMAIL_AUTHORIZATION_INVALID" }
			);
		}
		const authorized = await store.authorizeOpen(normalized, proposed);
		if (authorized) {
			const persisted = authorized.ingressDecision?.emailAuthorization;
			if (
				!validateHotelRunnerFallbackCreationAuthorization(persisted, boundary, {
					requireActiveLease: true,
					at: checkedAt,
				})
			) {
				throw new HotelRunnerFallbackIngressGateError(
					"Persisted email fallback authorization failed validation.",
					{ code: "HOTELRUNNER_FALLBACK_EMAIL_AUTHORIZATION_PERSIST_INVALID" }
				);
			}
			return persisted;
		}

		const job = await store.findJob(normalized.binding.jobId);
		const decision = lower(job?.ingressDecision?.status) || "open";
		if (decision === "api_observed") {
			throw new HotelRunnerFallbackIngressGateError(
				"HotelRunner callback won the fallback identity before email creation authorization.",
				{ code: "HOTELRUNNER_FALLBACK_API_OBSERVED_BEFORE_EMAIL" }
			);
		}
		if (decision === "email_committed") {
			throw new HotelRunnerFallbackIngressGateError(
				"The fallback email authorization was already committed to a reservation.",
				{ code: "HOTELRUNNER_FALLBACK_EMAIL_ALREADY_COMMITTED" }
			);
		}
		if (decision === "email_authorized") {
			const jobLease = safeDate(job?.leaseUntil);
			const callerStillOwnsJob = Boolean(
				lower(job?.status) === "processing" &&
				clean(job?.leaseOwner) === normalized.jobLeaseOwner &&
				lower(job?.leaseToken) === normalized.jobLeaseToken &&
				jobLease &&
				jobLease.getTime() > checkedAt.getTime()
			);
			if (!callerStillOwnsJob) {
				throw new HotelRunnerFallbackIngressGateError(
					"Email authorization belongs to a different or expired fallback worker lease.",
					{ code: "HOTELRUNNER_FALLBACK_EMAIL_AUTHORIZATION_LEASE_LOST" }
				);
			}
			const existing = job.ingressDecision?.emailAuthorization;
			const existingLease = safeDate(
				job.ingressDecision?.emailAuthorizationLeaseUntil ||
					existing?.leaseUntil
			);
			if (
				existing &&
				existingLease?.getTime() > checkedAt.getTime() &&
				validateHotelRunnerFallbackCreationAuthorization(existing, boundary, {
					requireActiveLease: true,
					at: checkedAt,
				})
			) {
				return existing;
			}
			if (existing && existingLease?.getTime() <= checkedAt.getTime()) {
				const reservation = await reservationForAuthorization(job, existing);
				if (reservation) {
					await commitKnownReservation(job, existing, reservation, checkedAt);
					throw new HotelRunnerFallbackIngressGateError(
						"A prior email create committed before its acknowledgement was lost.",
						{ code: "HOTELRUNNER_FALLBACK_EMAIL_ALREADY_COMMITTED" }
					);
				}
				const reopened = await store.expireAuthorizationToOpen(
					job,
					existing,
					checkedAt,
					normalized
				);
				if (reopened) return authorizeEmailCreation({ boundary });
			}
		}
		throw new HotelRunnerFallbackIngressGateError(
			"Email fallback creation authorization CAS was lost or the job lease changed.",
			{ code: "HOTELRUNNER_FALLBACK_EMAIL_AUTHORIZATION_CAS_LOST" }
		);
	}

	async function commitEmailCreation({
		boundary,
		authorization,
		reservationId,
	} = {}) {
		if (
			!validateHotelRunnerFallbackCreationAuthorization(authorization, boundary)
		) {
			throw new HotelRunnerFallbackIngressGateError(
				"Email fallback commit authorization is invalid.",
				{ code: "HOTELRUNNER_FALLBACK_EMAIL_COMMIT_AUTH_INVALID" }
			);
		}
		const job = await store.findJob(boundary.fallbackJobId);
		if (!job) {
			throw new HotelRunnerFallbackIngressGateError(
				"Email fallback job disappeared before commit.",
				{ code: "HOTELRUNNER_FALLBACK_EMAIL_COMMIT_JOB_MISSING" }
			);
		}
		const reservation = await reservationForAuthorization(
			job,
			authorization,
			reservationId
		);
		if (!reservation || clean(reservation._id) !== clean(reservationId)) {
			throw new HotelRunnerFallbackIngressGateError(
				"Created reservation does not carry the exact email authorization token.",
				{ code: "HOTELRUNNER_FALLBACK_EMAIL_COMMIT_RESERVATION_INVALID" }
			);
		}
		await commitKnownReservation(job, authorization, reservation, now());
		return { committed: true, reservationId: reservation._id };
	}

	async function releaseEmailCreation({ boundary, authorization } = {}) {
		if (
			!validateHotelRunnerFallbackCreationAuthorization(authorization, boundary)
		) {
			throw new HotelRunnerFallbackIngressGateError(
				"Email fallback release authorization is invalid.",
				{ code: "HOTELRUNNER_FALLBACK_EMAIL_RELEASE_AUTH_INVALID" }
			);
		}
		const job = await store.findJob(boundary.fallbackJobId);
		if (!job) return { released: false, committed: false };
		const reservation = await reservationForAuthorization(job, authorization);
		if (reservation) {
			await commitKnownReservation(job, authorization, reservation, now());
			return { released: false, committed: true, reservationId: reservation._id };
		}
		const releasedAt = now();
		const normalized = normalizeAuthorizationBoundary(boundary, releasedAt);
		if (!normalized) {
			throw new HotelRunnerFallbackIngressGateError(
				"Email fallback release lost its owned job/proof boundary.",
				{ code: "HOTELRUNNER_FALLBACK_EMAIL_RELEASE_BOUNDARY_EXPIRED" }
			);
		}
		const released = await store.releaseAuthorization(
			job,
			authorization,
			releasedAt,
			normalized
		);
		if (released) return { released: true, committed: false };
		const current = await store.findJob(job._id);
		if (lower(current?.ingressDecision?.status) === "open") {
			return { released: true, committed: false };
		}
		throw new HotelRunnerFallbackIngressGateError(
			"Email fallback authorization could not be released exactly.",
			{ code: "HOTELRUNNER_FALLBACK_EMAIL_RELEASE_CAS_LOST" }
		);
	}

	return {
		authorizeEmailCreation,
		commitEmailCreation,
		markApiObserved,
		releaseEmailCreation,
	};
}

let defaultGate = null;
const getDefaultGate = () => {
	if (!defaultGate) defaultGate = createHotelRunnerFallbackIngressGate();
	return defaultGate;
};

const markHotelRunnerFallbackApiObserved = (input) =>
	getDefaultGate().markApiObserved(input);
const authorizeHotelRunnerFirstFallbackEmailCreation = (input) =>
	getDefaultGate().authorizeEmailCreation(input);
const commitHotelRunnerFirstFallbackEmailCreation = (input) =>
	getDefaultGate().commitEmailCreation(input);
const releaseHotelRunnerFirstFallbackEmailCreation = (input) =>
	getDefaultGate().releaseEmailCreation(input);

module.exports = {
	ACTIVE_JOB_STATES,
	HotelRunnerFallbackIngressGateError,
	authorizationBindingFromBoundary,
	authorizeHotelRunnerFirstFallbackEmailCreation,
	buildCreationAuthorization,
	canonicalProvider,
	commitHotelRunnerFirstFallbackEmailCreation,
	createHotelRunnerFallbackIngressGate,
	createMongooseIngressGateStore,
	markHotelRunnerFallbackApiObserved,
	normalizeApiObservation,
	normalizeAuthorizationBoundary,
	normalizeIngressIdentity,
	proofSnapshotFromBoundary,
	releaseHotelRunnerFirstFallbackEmailCreation,
	reservationCarriesExactAuthorization,
	validateHotelRunnerFallbackCreationAuthorization,
};
