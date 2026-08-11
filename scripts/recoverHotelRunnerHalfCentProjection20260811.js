/** @format */

"use strict";

/**
 * Exact replay preparation for the two Trip.com reservations quarantined by
 * the 2026-08-11 half-cent USD->SAR materialization defect.
 *
 * This utility never creates or edits a PMS reservation and never mutates a
 * HotelRunner mirror. It reopens the authenticated direct-email evidence and
 * fallback job first, then releases the matching event last for the normal
 * worker to project idempotently.
 *
 * Dry run (default):
 *   node scripts/recoverHotelRunnerHalfCentProjection20260811.js
 *
 * Apply only while the dedicated worker is stopped, using the proof printed by
 * the dry run and the exact deployed Git revision:
 *   node scripts/recoverHotelRunnerHalfCentProjection20260811.js --apply \
 *     --repair-id=hotelrunner-half-cent-projection-20260811-v1 \
 *     --scope=1658113971008322,1567954036129867 \
 *     --proof=<dry-run-proof> --release-sha=<40-char-sha> \
 *     --worker-stopped=xhotelpro-hotelrunner-sync.service
 */

const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const mongoose = require("mongoose");
const BSON = require("bson");
const {
	canonicalEjsonSha256,
} = require("../services/tripHotelRunnerRepair20260805");
const {
	assertExactGitRelease,
} = require("../services/hotelrunnerWorkerRevision");
const { roundedMoneyProduct } = require("../services/otaMoney");

mongoose.set("autoIndex", false);
mongoose.set("autoCreate", false);

const REPAIR_ID = "hotelrunner-half-cent-projection-20260811-v1";
const BACKUP_COLLECTION =
	"ota_hotelrunner_half_cent_projection_backup_20260811_v1";
const HOTEL_ID = "6a40b6a1a6efe70450536038";
const WORKER_UNIT = "xhotelpro-hotelrunner-sync.service";
const SCOPE_ATTESTATION = "1658113971008322,1567954036129867";
const PROOF_MAX_AGE_MS = 30 * 60 * 1000;
const CLOCK_SKEW_MS = 5_000;
const JOB_HOLD_MS = 5 * 60 * 1000;
const EVENT_HOLD_MS = 2 * 60 * 1000;
const APPLY_LOCK_ID = `${REPAIR_ID}:apply-lock`;
const APPLY_LOCK_MS = PROOF_MAX_AGE_MS + 5 * 60 * 1000;
const FAILURE_CODE =
	"hotelrunner_queued_email_commercial_materialization_failed";
const FAILURE_REASON = "queued_commercial_materialization_invalid";
const TERMINAL_DECISION = "hotelrunner_local_state_needs_review";
const TERMINAL_CODE = "HOTELRUNNER_LOCAL_RECORD_BLOCKED";
const TERMINAL_MESSAGE =
	"HotelRunner evidence exists but cannot be selected safely; email fallback was not allowed.";
const REOPEN_DECISION = "incident_reopened_for_half_cent_projection_20260811";
const AWAITING_MESSAGE =
	"Authenticated direct-OTA reservation was reopened for HotelRunner API projection after the exact half-cent repair.";

const COLLECTION_NAMES = Object.freeze({
	events: "hotelrunnerevents",
	mirrors: "hotelrunnerreservations",
	jobs: "hotelrunnerotafallbackjobs",
	audits: "inboundemails",
	reservations: "reservations",
	backups: BACKUP_COLLECTION,
});
const EXACT_READ_OPTIONS = Object.freeze({
	readPreference: "primary",
	readConcern: Object.freeze({ level: "local" }),
	promoteBuffers: false,
	promoteLongs: false,
	promoteValues: false,
});

const TARGETS = Object.freeze(
	[
		{
			key: "trip_1658113971008322",
			confirmationNumber: "1658113971008322",
			hotelRunnerReservationId: "40415862",
			hrNumber: "R313239908",
			eventId: "6a7ad033d8cbed2f4bad478c",
			mirrorId: "6a7ad03459d8ef904b9c8d71",
			jobId: "6a7ad012d8cbed2f4bad478b",
			auditId: "6a7ad00ed8921baafa81f9f2",
			preallocatedReservationId: "6a7ad03959d8ef904b9c8d7f",
			checkinDate: "2026-08-14",
			checkoutDate: "2026-08-16",
		},
		{
			key: "trip_1567954036129867",
			confirmationNumber: "1567954036129867",
			hotelRunnerReservationId: "40428128",
			hrNumber: "R395056014",
			eventId: "6a7b5235d8cbed2f4bad47a4",
			mirrorId: "6a7b523559d8ef904b9de5de",
			jobId: "6a7b5233d8cbed2f4bad47a3",
			auditId: "6a7b5230d8921baafa82bf6a",
			preallocatedReservationId: "6a7b523a59d8ef904b9de5eb",
			checkinDate: "2026-08-13",
			checkoutDate: "2026-08-15",
		},
	].map((target) =>
		Object.freeze({
			...target,
			hotelId: HOTEL_ID,
			provider: "trip",
			channel: "tripcom",
			identityKey: `trip:${target.confirmationNumber}`,
			hotelRunnerTotal: 27.44,
			sourceGross: 29.06,
			sourcePayout: 27.44,
			exchangeRate: 3.75,
			legacyPropertyGross: 108.97,
			exactPropertyGross: 108.98,
			propertyPayout: 102.9,
			invCode: "HR:1332547",
		})
	)
);

class RecoveryError extends Error {
	constructor(message, code = "HOTELRUNNER_HALF_CENT_RECOVERY_FAILED") {
		super(message);
		this.name = "RecoveryError";
		this.code = code;
	}
}

const fail = (message, code) => {
	throw new RecoveryError(message, code);
};
const clean = (value) => String(value ?? "").trim();
const lower = (value) => clean(value).toLowerCase();
const id = (value) => lower(value?._id || value);
const oid = (value) => new mongoose.Types.ObjectId(clean(value));
const hasOwn = (value, key) =>
	Boolean(value) && Object.prototype.hasOwnProperty.call(value, key);
const dateMs = (value) => {
	const parsed = value instanceof Date ? value : new Date(value || "");
	return Number.isFinite(parsed.getTime()) ? parsed.getTime() : NaN;
};
const dateKey = (value) => {
	const milliseconds = dateMs(value);
	return Number.isFinite(milliseconds)
		? new Date(milliseconds).toISOString().slice(0, 10)
		: clean(value).slice(0, 10);
};
const moneyCents = (value) => Math.round(Number(value) * 100);
const validSha256 = (value) => /^[a-f0-9]{64}$/i.test(clean(value));
const validReleaseSha = (value) => /^[a-f0-9]{40}$/i.test(clean(value));
const validOwnerToken = (value) => /^[a-f0-9]{64}$/i.test(clean(value));
const sha256 = (value) =>
	crypto.createHash("sha256").update(String(value)).digest("hex");
const cloneFullBson = (value) =>
	BSON.deserialize(BSON.serialize({ value }, { ignoreUndefined: false }), {
		promoteBuffers: false,
		promoteLongs: false,
		promoteValues: false,
	}).value;

function setDocumentPath(document, dotted, value) {
	const parts = String(dotted).split(".");
	const final = parts.pop();
	let cursor = document;
	for (const part of parts) {
		if (!cursor[part] || typeof cursor[part] !== "object") cursor[part] = {};
		cursor = cursor[part];
	}
	cursor[final] = cloneFullBson(value);
}

function unsetDocumentPath(document, dotted) {
	const parts = String(dotted).split(".");
	const final = parts.pop();
	const parent = parts.reduce((value, key) => value?.[key], document);
	if (parent && typeof parent === "object") delete parent[final];
}

function applyUpdateToDocument(original, update) {
	const document = cloneFullBson(original);
	for (const [key, value] of Object.entries(update.$set || {})) {
		setDocumentPath(document, key, value);
	}
	for (const key of Object.keys(update.$unset || {})) {
		unsetDocumentPath(document, key);
	}
	for (const [key, increment] of Object.entries(update.$inc || {})) {
		const current = String(key)
			.split(".")
			.reduce((value, part) => value?.[part], document);
		setDocumentPath(document, key, Number(current || 0) + Number(increment));
	}
	return document;
}

function buildFullDocumentCasFilter(document) {
	return {
		_id: cloneFullBson(document._id),
		$expr: {
			$eq: [
				{ $objectToArray: "$$ROOT" },
				{
					$literal: Object.entries(cloneFullBson(document)).map(
						([key, value]) => ({ k: key, v: value })
					),
				},
			],
		},
	};
}

function parseArguments(argv = []) {
	const options = {
		apply: false,
		help: false,
		repairId: "",
		scope: "",
		proof: "",
		releaseSha: "",
		workerStopped: "",
	};
	for (const argument of argv) {
		if (argument === "--apply") options.apply = true;
		else if (argument === "--help" || argument === "-h") options.help = true;
		else {
			const match = argument.match(
				/^--(repair-id|scope|proof|release-sha|worker-stopped)=(.*)$/
			);
			if (!match) {
				fail(
					`Unknown argument: ${argument}`,
					"HOTELRUNNER_HALF_CENT_RECOVERY_ARGUMENT_INVALID"
				);
			}
			const key = {
				"repair-id": "repairId",
				scope: "scope",
				proof: "proof",
				"release-sha": "releaseSha",
				"worker-stopped": "workerStopped",
			}[match[1]];
			if (options[key]) {
				fail(
					`--${match[1]} may only be supplied once.`,
					"HOTELRUNNER_HALF_CENT_RECOVERY_ARGUMENT_INVALID"
				);
			}
			options[key] = clean(match[2]);
		}
	}
	const applyOnly = [
		options.repairId,
		options.scope,
		options.proof,
		options.releaseSha,
		options.workerStopped,
	].some(Boolean);
	if (!options.apply && applyOnly) {
		fail(
			"Repair, scope, proof, release, and worker attestations are apply-only.",
			"HOTELRUNNER_HALF_CENT_RECOVERY_ARGUMENT_INVALID"
		);
	}
	if (options.apply) {
		if (options.repairId !== REPAIR_ID) {
			fail(
				`--apply requires --repair-id=${REPAIR_ID}.`,
				"HOTELRUNNER_HALF_CENT_RECOVERY_REPAIR_ID_REQUIRED"
			);
		}
		if (options.scope !== SCOPE_ATTESTATION) {
			fail(
				`--apply requires --scope=${SCOPE_ATTESTATION}.`,
				"HOTELRUNNER_HALF_CENT_RECOVERY_SCOPE_ATTESTATION_REQUIRED"
			);
		}
		if (!/^\d{13}\.[a-f0-9]{64}$/i.test(options.proof)) {
			fail(
				"--apply requires the exact unexpired dry-run proof.",
				"HOTELRUNNER_HALF_CENT_RECOVERY_PROOF_REQUIRED"
			);
		}
		if (!validReleaseSha(options.releaseSha)) {
			fail(
				"--apply requires a full 40-character --release-sha.",
				"HOTELRUNNER_HALF_CENT_RECOVERY_RELEASE_REQUIRED"
			);
		}
		if (options.workerStopped !== WORKER_UNIT) {
			fail(
				`--apply requires --worker-stopped=${WORKER_UNIT}.`,
				"HOTELRUNNER_HALF_CENT_RECOVERY_WORKER_ATTESTATION_REQUIRED"
			);
		}
	}
	return options;
}

function parseProof(proof, now = new Date()) {
	const match = lower(proof).match(/^(\d{13})\.([a-f0-9]{64})$/);
	if (!match) {
		fail(
			"The dry-run proof format is invalid.",
			"HOTELRUNNER_HALF_CENT_RECOVERY_PROOF_INVALID"
		);
	}
	const plannedAtMs = Number(match[1]);
	const nowMs = dateMs(now);
	if (
		!Number.isSafeInteger(plannedAtMs) ||
		plannedAtMs > nowMs + CLOCK_SKEW_MS ||
		nowMs - plannedAtMs > PROOF_MAX_AGE_MS
	) {
		fail(
			"The dry-run proof is expired or from the future.",
			"HOTELRUNNER_HALF_CENT_RECOVERY_PROOF_EXPIRED"
		);
	}
	return { plannedAt: new Date(plannedAtMs), scopeHash: match[2] };
}

function collectionsFromDb(db) {
	return Object.fromEntries(
		Object.entries(COLLECTION_NAMES).map(([key, name]) => [key, db.collection(name)])
	);
}

async function reservationMatches(collection, target) {
	const hotelId = oid(target.hotelId);
	const aliases = [target.confirmationNumber, target.hrNumber];
	const exactIdentityQueries = [
		{ _id: oid(target.preallocatedReservationId) },
		{
			hotelId,
			"supplierData.hotelRunner.reservationId":
				target.hotelRunnerReservationId,
		},
		{
			hotelId,
			"supplierData.hotelRunner.hrNumber": target.hrNumber,
		},
		{
			hotelId,
			"supplierData.hotelRunner.providerNumber": target.confirmationNumber,
		},
		{ hotelId, otaIdentityKey: target.identityKey },
		{ hotelId, otaCrossTransportIdentityKey: target.identityKey },
		...aliases.flatMap((alias) => [
			{ hotelId, reservation_id: alias },
			{ hotelId, hr_number: alias },
			{ hotelId, "customer_details.confirmation_number2": alias },
			{ hotelId, "supplierData.suppliedBookingNo": alias },
			{ hotelId, "supplierData.otaConfirmationNumber": alias },
			{ hotelId, "supplierData.platformConfirmationNumber": alias },
		]),
	];
	const matches = [];
	for (const query of exactIdentityQueries) {
		const match = await collection.findOne(query, {
			...EXACT_READ_OPTIONS,
			projection: { _id: 1 },
		});
		if (match && !matches.some((entry) => id(entry._id) === id(match._id))) {
			matches.push(match);
		}
	}
	return matches;
}

async function loadTargetScope(collections, target) {
	const options = EXACT_READ_OPTIONS;
	const [event, mirror, job, audit, reservations] = await Promise.all([
		collections.events.findOne({ _id: oid(target.eventId) }, options),
		collections.mirrors.findOne({ _id: oid(target.mirrorId) }, options),
		collections.jobs.findOne({ _id: oid(target.jobId) }, options),
		collections.audits.findOne({ _id: oid(target.auditId) }, options),
		reservationMatches(collections.reservations, target),
	]);
	return { target, event, mirror, job, audit, reservations };
}

async function loadScopes(collections) {
	const scopes = [];
	for (const target of TARGETS) {
		scopes.push(await loadTargetScope(collections, target));
	}
	return scopes;
}

function requireCondition(condition, target, label) {
	if (!condition) {
		fail(
			`${target.key}: exact precondition failed (${label}).`,
			"HOTELRUNNER_HALF_CENT_RECOVERY_SCOPE_DRIFT"
		);
	}
}

function validateScope(scope) {
	const { target, event, mirror, job, audit, reservations } = scope;
	for (const [role, document] of Object.entries({ event, mirror, job, audit })) {
		requireCondition(Boolean(document), target, `${role}.missing`);
		requireCondition(id(document?.hotelId) === target.hotelId, target, `${role}.hotelId`);
	}
	requireCondition(reservations.length === 0, target, "reservation.already_exists");
	requireCondition(id(event._id) === target.eventId, target, "event._id");
	requireCondition(id(event.mirrorId) === target.mirrorId, target, "event.mirrorId");
	requireCondition(clean(event.hotelRunnerReservationId) === target.hotelRunnerReservationId, target, "event.hotelRunnerReservationId");
	requireCondition(clean(event.hrNumber) === target.hrNumber, target, "event.hrNumber");
	requireCondition(clean(event.providerNumber) === target.confirmationNumber, target, "event.providerNumber");
	requireCondition(lower(event.channel) === target.channel, target, "event.channel");
	requireCondition(lower(event.state) === "confirmed", target, "event.state");
	requireCondition(lower(event.status) === "quarantined", target, "event.status");
	requireCondition(Number(event.attempts) === 1, target, "event.attempts");
	requireCondition(clean(event.errorCode) === FAILURE_CODE, target, "event.errorCode");
	requireCondition(lower(event.result?.status) === "quarantined", target, "event.result.status");
	requireCondition(clean(event.result?.code) === FAILURE_CODE, target, "event.result.code");
	requireCondition(!id(event.reservationMongoId), target, "event.reservationMongoId");
	requireCondition(Number.isFinite(dateMs(event.processedAt)), target, "event.processedAt");
	requireCondition(!clean(event.leaseOwner) && !Number.isFinite(dateMs(event.leaseUntil)), target, "event.lease");

	requireCondition(id(mirror._id) === target.mirrorId, target, "mirror._id");
	requireCondition(clean(mirror.hotelRunnerReservationId) === target.hotelRunnerReservationId, target, "mirror.hotelRunnerReservationId");
	requireCondition(clean(mirror.hrNumber) === target.hrNumber, target, "mirror.hrNumber");
	requireCondition(clean(mirror.providerNumber) === target.confirmationNumber, target, "mirror.providerNumber");
	requireCondition(lower(mirror.channel) === target.channel, target, "mirror.channel");
	requireCondition(lower(mirror.projectionStatus) === "quarantined", target, "mirror.projectionStatus");
	requireCondition(clean(mirror.lastErrorCode) === FAILURE_CODE, target, "mirror.lastErrorCode");
	requireCondition(lower(mirror.lastResult?.status) === "quarantined", target, "mirror.lastResult.status");
	requireCondition(clean(mirror.lastResult?.code) === FAILURE_CODE, target, "mirror.lastResult.code");
	requireCondition(clean(mirror.lastResult?.bridgeReason) === FAILURE_REASON, target, "mirror.lastResult.bridgeReason");
	requireCondition(id(mirror.reservationMongoId) === target.preallocatedReservationId, target, "mirror.preallocatedReservationMongoId");
	requireCondition(lower(mirror.linkMethod) === "preallocated_create", target, "mirror.linkMethod");
	requireCondition(mirror.linkEvidence?.planned === true, target, "mirror.linkEvidence.planned");
	requireCondition(!mirror.appliedSourceUpdatedAt && !clean(mirror.appliedCanonicalHash), target, "mirror.appliedWatermark");
	requireCondition(mirror.identityConflict !== true, target, "mirror.identityConflict");
	requireCondition(clean(mirror.observedCanonicalHash) === clean(event.canonicalHash), target, "event/mirror.canonicalHash");
	const snapshot = mirror.normalizedSnapshot || {};
	requireCondition(lower(snapshot.currency) === "usd", target, "mirror.snapshot.currency");
	requireCondition(moneyCents(snapshot.totalCents / 100) === moneyCents(target.hotelRunnerTotal), target, "mirror.snapshot.total");
	requireCondition(dateKey(snapshot.checkinDate) === target.checkinDate && dateKey(snapshot.checkoutDate) === target.checkoutDate, target, "mirror.snapshot.stay");
	requireCondition(Number(snapshot.totalRooms) === 1 && Array.isArray(snapshot.rooms) && snapshot.rooms.length === 1, target, "mirror.snapshot.rooms");
	requireCondition(clean(snapshot.rooms[0]?.invCode) === target.invCode, target, "mirror.snapshot.invCode");

	requireCondition(id(job._id) === target.jobId, target, "job._id");
	requireCondition(lower(job.provider) === target.provider, target, "job.provider");
	requireCondition(lower(job.confirmationNumber) === target.confirmationNumber, target, "job.confirmationNumber");
	requireCondition(lower(job.identityKey) === target.identityKey, target, "job.identityKey");
	requireCondition(id(job.inboundEmailId) === target.auditId, target, "job.inboundEmailId");
	requireCondition(lower(job.status) === "needs_review", target, "job.status");
	requireCondition(Number(job.attemptCount) === 1, target, "job.attemptCount");
	requireCondition(lower(job.lastDecision) === TERMINAL_DECISION, target, "job.lastDecision");
	requireCondition(clean(job.lastErrorCode) === TERMINAL_CODE, target, "job.lastErrorCode");
	requireCondition(clean(job.lastErrorMessage) === TERMINAL_MESSAGE, target, "job.lastErrorMessage");
	requireCondition(lower(job.inboundAuditFinalizationStatus) === "completed", target, "job.auditFinalization");
	requireCondition(Number.isFinite(dateMs(job.completedAt)) && Number.isFinite(dateMs(job.inboundAuditFinalizedAt)), target, "job.completedAt");
	requireCondition(lower(job.ingressDecision?.status) === "api_observed" && Number(job.ingressDecision?.apiObservationCount) === 1, target, "job.ingressDecision");
	requireCondition(!id(job.reservationMongoId) && !id(job.hotelRunnerEventId) && !id(job.hotelRunnerMirrorId), target, "job.links");
	for (const field of ["leaseOwner", "leaseToken", "leaseAcquiredAt", "leaseUntil", "pendingTerminalStatus", "pendingTerminalDetails", "pendingTerminalAt"]) {
		requireCondition(!hasOwn(job, field), target, `job.${field}.absent`);
	}

	requireCondition(id(audit._id) === target.auditId, target, "audit._id");
	requireCondition(lower(audit.provider) === target.provider && lower(audit.confirmationNumber) === target.confirmationNumber, target, "audit.identity");
	requireCondition(lower(audit.intent) === "new_reservation" && lower(audit.eventType) === "new", target, "audit.lifecycle");
	requireCondition(audit.senderAuthentication?.authenticatedAligned === true && lower(audit.senderAuthentication?.trustedProvider) === target.provider, target, "audit.authentication");
	requireCondition(lower(audit.processingStatus) === "needs_review" && lower(audit.automationAction) === "skipped", target, "audit.terminalStatus");
	requireCondition(lower(audit.skipReason) === "hotelrunner_local_record_blocked", target, "audit.skipReason");
	requireCondition(audit.hasReservationConnection !== true && !id(audit.reservationMongoId), target, "audit.reservationLink");
	requireCondition(id(audit.hotelRunnerFirstFallback?.jobId) === target.jobId, target, "audit.fallback.jobId");
	requireCondition(lower(audit.hotelRunnerFirstFallback?.status) === "needs_review", target, "audit.fallback.status");
	requireCondition(clean(audit.hotelRunnerFirstFallback?.lastErrorCode) === TERMINAL_CODE, target, "audit.fallback.code");
	for (const [label, value] of Object.entries({
		jobInboundEmailHash: job.inboundEmailHash,
		jobArchiveFingerprint: job.archiveFingerprint,
		jobNormalizedReservationHash: job.normalizedReservationHash,
		jobResolvedHotelProofHash: job.resolvedHotelProofHash,
		auditEmailHash: audit.emailHash,
	})) {
		requireCondition(validSha256(value), target, label);
	}
	requireCondition(lower(job.inboundEmailHash) === lower(audit.emailHash), target, "job/audit.emailHash");
	const inbound = audit.normalizedReservation || {};
	requireCondition(lower(inbound.provider) === target.provider && lower(inbound.confirmationNumber || inbound.reservationId) === target.confirmationNumber, target, "audit.normalized.identity");
	requireCondition(inbound.sourceSenderAuthenticated === true && inbound.sourceSenderTrusted === true, target, "audit.normalized.trust");
	requireCondition(inbound.propertyConversionVerified === true && lower(inbound.sourceCurrency) === "usd" && lower(inbound.propertyCurrency) === "sar", target, "audit.normalized.currency");
	requireCondition(moneyCents(inbound.sourceAmount) === moneyCents(target.sourceGross), target, "audit.normalized.sourceGross");
	requireCondition(moneyCents(inbound.paymentSummary?.sourceTotalGuestPaymentAmount) === moneyCents(target.sourceGross), target, "audit.normalized.paymentSourceGross");
	requireCondition(moneyCents(inbound.totalAmountSar) === moneyCents(target.legacyPropertyGross), target, "audit.normalized.legacyGross");
	requireCondition(moneyCents(inbound.amount) === moneyCents(target.legacyPropertyGross), target, "audit.normalized.legacyAmount");
	requireCondition(moneyCents(inbound.paymentSummary?.totalGuestPaymentAmount) === moneyCents(target.legacyPropertyGross), target, "audit.normalized.paymentLegacyGross");
	requireCondition(moneyCents(inbound.totalPayoutSar) === moneyCents(target.propertyPayout), target, "audit.normalized.propertyPayout");
	requireCondition(moneyCents(inbound.netAfterExpensesTotal) === moneyCents(target.propertyPayout), target, "audit.normalized.netAfterExpensesTotal");
	requireCondition(moneyCents(inbound.paymentSummary?.totalPayoutAmount) === moneyCents(target.propertyPayout), target, "audit.normalized.paymentPropertyPayout");
	requireCondition(moneyCents(inbound.sourcePayoutAmount) === moneyCents(target.sourcePayout), target, "audit.normalized.sourcePayoutAlias");
	requireCondition(moneyCents(inbound.paymentSummary?.sourceTotalPayoutAmount) === moneyCents(target.sourcePayout), target, "audit.normalized.sourcePayout");
	requireCondition(roundedMoneyProduct(target.sourceGross, target.exchangeRate) === target.exactPropertyGross, target, "incident.exactGrossProduct");
	requireCondition(roundedMoneyProduct(target.sourcePayout, target.exchangeRate) === target.propertyPayout, target, "incident.exactPayoutProduct");
	requireCondition(moneyCents(target.exactPropertyGross) - moneyCents(target.legacyPropertyGross) === 1, target, "incident.exactOneCentDrift");
	requireCondition(Number(inbound.exchangeRateToSar) === target.exchangeRate && Number(inbound.sourceExchangeRateToSar) === target.exchangeRate && Number(inbound.paymentSummary?.exchangeRateToSar) === target.exchangeRate, target, "audit.normalized.exchangeRate");
	requireCondition(lower(inbound.exchangeRateSource) === "exchange_rate_api_stored" && lower(inbound.sourceExchangeRateSource) === "exchange_rate_api_stored", target, "audit.normalized.exchangeRateSource");
	const exchangeEvidence = inbound.currencyConversionEvidence || {};
	requireCondition(exchangeEvidence.trusted === true && exchangeEvidence.verified === true && lower(exchangeEvidence.sourceCurrency) === "usd" && lower(exchangeEvidence.propertyCurrency) === "sar" && Number(exchangeEvidence.rate) === target.exchangeRate && lower(exchangeEvidence.provenance?.provider) === "exchange_rate_api", target, "audit.normalized.trustedStoredFx");
	return true;
}

function recoveryMarker(target, plannedAt, releaseSha, ownerToken = "") {
	return {
		repairId: REPAIR_ID,
		confirmationNumber: target.confirmationNumber,
		releaseSha: lower(releaseSha),
		...(ownerToken ? { ownerTokenHash: sha256(ownerToken) } : {}),
		reopenedAt: new Date(plannedAt),
	};
}

function buildJobUpdate(
	target,
	plannedAt,
	releaseSha,
	appliedAt = plannedAt,
	ownerToken = ""
) {
	const reopenedAt = new Date(plannedAt);
	const holdBase = new Date(appliedAt);
	return {
		$set: {
			status: "awaiting_hotelrunner",
			nextAttemptAt: new Date(holdBase.getTime() + JOB_HOLD_MS),
			attemptCount: 0,
			lookupAttemptCount: 0,
			lastDecision: REOPEN_DECISION,
			lastErrorCode: "",
			lastErrorMessage: "",
			inboundAuditFinalizationStatus: "",
			hotelRunnerHalfCentRecovery: recoveryMarker(
				target,
				reopenedAt,
				releaseSha,
				ownerToken
			),
			updatedAt: reopenedAt,
		},
		$unset: {
			completedAt: "",
			inboundAuditFinalizedAt: "",
			pendingTerminalStatus: "",
			pendingTerminalDetails: "",
			pendingTerminalAt: "",
			leaseOwner: "",
			leaseToken: "",
			leaseAcquiredAt: "",
			leaseUntil: "",
			notificationOutboxStatus: "",
			notificationOutboxId: "",
			notificationOutboxEnqueuedAt: "",
		},
		$inc: { __v: 1 },
	};
}

function buildAuditUpdate(target, plannedAt, releaseSha, ownerToken = "") {
	const reopenedAt = new Date(plannedAt);
	return {
		$set: {
			processingStatus: "awaiting_hotelrunner",
			automationAction: "queued",
			skipReason: "",
			automationComment: AWAITING_MESSAGE,
			hasReservationConnection: false,
			reservationMongoId: null,
			pmsConfirmationNumber: "",
			matchedReservationBy: [],
			reconcileWarnings: [],
			reconcileErrors: [],
			"reconciliation.status": "awaiting_hotelrunner",
			"reconciliation.actionTaken": "queued",
			"reconciliation.skipReason": "",
			"reconciliation.automationComment": AWAITING_MESSAGE,
			"reconciliation.reservationId": null,
			"reconciliation.hotelId": oid(target.hotelId),
			"reconciliation.pmsConfirmationNumber": "",
			"reconciliation.provider": target.provider,
			"reconciliation.confirmationNumber": target.confirmationNumber,
			"reconciliation.warnings": [],
			"reconciliation.errors": [],
			"reconciliation.matchedReservationBy": [],
			"reconciliation.hotelRunnerFirst": true,
			"hotelRunnerFirstFallback.status": "enqueued",
			"hotelRunnerFirstFallback.jobId": target.jobId,
			"hotelRunnerFirstFallback.collision": false,
			"hotelRunnerFirstFallback.lastErrorCode": "",
			"hotelRunnerFirstFallback.lastErrorMessage": "",
			"hotelRunnerFirstFallback.recovery": recoveryMarker(
				target,
				reopenedAt,
				releaseSha,
				ownerToken
			),
			updatedAt: reopenedAt,
		},
		$unset: {
			"hotelRunnerFirstFallback.finalizedAt": "",
			"reconciliation.hotelRunnerFirstFallback": "",
		},
		$inc: { __v: 1 },
	};
}

function buildEventUpdate(
	target,
	plannedAt,
	releaseSha,
	appliedAt = plannedAt,
	ownerToken = ""
) {
	const reopenedAt = new Date(plannedAt);
	const marker = recoveryMarker(target, reopenedAt, releaseSha, ownerToken);
	return {
		$set: {
			status: "pending",
			attempts: 0,
			nextAttemptAt: new Date(dateMs(appliedAt) + EVENT_HOLD_MS),
			processedAt: null,
			errorCode: "",
			errorMessage: "",
			finalRecoveryAttempted: false,
			finalRecoveryClaimedAt: null,
			result: {
				status: "pending",
				code: "",
				incidentRecovery: marker,
			},
			hotelRunnerHalfCentRecovery: marker,
			updatedAt: reopenedAt,
		},
		$unset: {
			leaseOwner: "",
			leaseAcquiredAt: "",
			leaseUntil: "",
		},
		$inc: { __v: 1 },
	};
}

function buildPlan(
	scopes,
	plannedAt,
	releaseSha,
	appliedAt = plannedAt,
	ownerToken = ""
) {
	if (!validReleaseSha(releaseSha)) {
		fail(
			"A full reviewed release SHA is required to bind the recovery plan.",
			"HOTELRUNNER_HALF_CENT_RECOVERY_RELEASE_REQUIRED"
		);
	}
	for (const scope of scopes) validateScope(scope);
	const originalHashes = {};
	for (const scope of scopes) {
		originalHashes[scope.target.key] = {
			event: canonicalEjsonSha256(scope.event),
			mirror: canonicalEjsonSha256(scope.mirror),
			job: canonicalEjsonSha256(scope.job),
			audit: canonicalEjsonSha256(scope.audit),
		};
	}
	const scopeHash = canonicalEjsonSha256({
		repairId: REPAIR_ID,
		releaseSha: lower(releaseSha),
		targets: TARGETS.map((target) => ({
			key: target.key,
			confirmationNumber: target.confirmationNumber,
			eventId: target.eventId,
			mirrorId: target.mirrorId,
			jobId: target.jobId,
			auditId: target.auditId,
			preallocatedReservationId: target.preallocatedReservationId,
		})),
		originalHashes,
		reservationMatches: 0,
	});
	const documentPlans = [];
	for (const scope of scopes) {
		for (const [role, collectionName, update] of [
			[
				"job",
				"jobs",
				buildJobUpdate(
					scope.target,
					plannedAt,
					releaseSha,
					appliedAt,
					ownerToken
				),
			],
			[
				"audit",
				"audits",
				buildAuditUpdate(scope.target, plannedAt, releaseSha, ownerToken),
			],
		]) {
			const originalDocument = cloneFullBson(scope[role]);
			const expectedDocument = applyUpdateToDocument(originalDocument, update);
			documentPlans.push({
				target: scope.target,
				role,
				collectionName,
				originalDocument,
				expectedDocument,
				originalHash: canonicalEjsonSha256(originalDocument),
				expectedHash: canonicalEjsonSha256(expectedDocument),
			});
		}
	}
	// Events are deliberately last: no worker-replayable event is exposed until
	// both immutable email evidence chains are active.
	for (const scope of scopes) {
		const originalDocument = cloneFullBson(scope.event);
		const expectedDocument = applyUpdateToDocument(
			originalDocument,
			buildEventUpdate(
				scope.target,
				plannedAt,
				releaseSha,
				appliedAt,
				ownerToken
			)
		);
		documentPlans.push({
			target: scope.target,
			role: "event",
			collectionName: "events",
			originalDocument,
			expectedDocument,
			originalHash: canonicalEjsonSha256(originalDocument),
			expectedHash: canonicalEjsonSha256(expectedDocument),
		});
	}
	return {
		plannedAt: new Date(plannedAt),
		scopeHash,
		originalHashes,
		documentPlans,
	};
}

const proofToken = (plan) => `${dateMs(plan.plannedAt)}.${plan.scopeHash}`;

function createOwnerToken() {
	return crypto.randomBytes(32).toString("hex");
}

async function acquireApplyLock(collections, plan, releaseSha, now, ownerToken) {
	if (!validOwnerToken(ownerToken)) {
		fail(
			"A cryptographic recovery owner token is required.",
			"HOTELRUNNER_HALF_CENT_RECOVERY_OWNER_INVALID"
		);
	}
	// This one-time lock is intentionally not auto-reclaimed. A process-level
	// crash leaves a durable manual-review fence; an unattended takeover must
	// never guess whether an earlier owner crossed the first CAS boundary.
	const lock = {
		_id: APPLY_LOCK_ID,
		repairId: REPAIR_ID,
		state: "active",
		scopeHash: plan.scopeHash,
		proof: proofToken(plan),
		releaseSha: lower(releaseSha),
		ownerToken,
		ownerTokenHash: sha256(ownerToken),
		acquiredAt: new Date(now),
		leaseUntil: new Date(dateMs(now) + APPLY_LOCK_MS),
	};
	let insertionError = null;
	try {
		const result = await collections.backups.insertOne(lock, {
			writeConcern: { w: "majority" },
		});
		if (result?.acknowledged === false) {
			insertionError = new Error("Apply-lock insertion was not acknowledged.");
		}
	} catch (error) {
		insertionError = error;
	}
	const observed = await collections.backups.findOne(
		{ _id: APPLY_LOCK_ID },
		EXACT_READ_OPTIONS
	);
	if (
		observed?.ownerToken === ownerToken &&
		observed?.state === "active" &&
		observed?.scopeHash === plan.scopeHash
	) {
		return observed;
	}
	fail(
		`Another recovery owner already holds the durable apply lock${
			insertionError ? ` (${insertionError.message})` : ""
		}.`,
		"HOTELRUNNER_HALF_CENT_RECOVERY_LOCK_HELD"
	);
}

async function finalizeApplyLock(collections, ownerToken, state, now) {
	const result = await collections.backups.updateOne(
		{ _id: APPLY_LOCK_ID, ownerToken, state: "active" },
		{
			$set: {
				state,
				completedAt: new Date(now),
			},
		},
		{ writeConcern: { w: "majority" } }
	);
	if (matchedOne(result)) return true;
	const observed = await collections.backups.findOne(
		{ _id: APPLY_LOCK_ID },
		EXACT_READ_OPTIONS
	);
	if (observed?.ownerToken === ownerToken && observed?.state === state) return true;
	fail(
		"The durable apply lock could not be finalized by its exact owner.",
		"HOTELRUNNER_HALF_CENT_RECOVERY_LOCK_LOST"
	);
}

function backupRecord(documentPlan, plan, createdAt) {
	const record = {
		_id: `${REPAIR_ID}:${documentPlan.target.key}:${documentPlan.role}`,
		repairId: REPAIR_ID,
		targetKey: documentPlan.target.key,
		confirmationNumber: documentPlan.target.confirmationNumber,
		role: documentPlan.role,
		collectionName: COLLECTION_NAMES[documentPlan.collectionName],
		documentId: id(documentPlan.originalDocument._id),
		scopeHash: plan.scopeHash,
		originalHash: documentPlan.originalHash,
		originalDocument: cloneFullBson(documentPlan.originalDocument),
		createdAt: new Date(createdAt),
	};
	return { ...record, recordHash: canonicalEjsonSha256(record) };
}

function verifyBackup(record, expected) {
	if (
		!record ||
		record._id !== expected._id ||
		record.repairId !== REPAIR_ID ||
		record.scopeHash !== expected.scopeHash ||
		record.originalHash !== expected.originalHash ||
		canonicalEjsonSha256(record.originalDocument) !== expected.originalHash ||
		canonicalEjsonSha256(
			Object.fromEntries(
				Object.entries(record).filter(([key]) => key !== "recordHash")
			)
		) !== record.recordHash
	) {
		fail(
			`Durable backup integrity failed for ${expected._id}.`,
			"HOTELRUNNER_HALF_CENT_RECOVERY_BACKUP_INVALID"
		);
	}
	return true;
}

async function ensureBackups(collections, plan, now) {
	for (const documentPlan of plan.documentPlans) {
		const desired = backupRecord(documentPlan, plan, now);
		let existing = await collections.backups.findOne(
			{ _id: desired._id },
			EXACT_READ_OPTIONS
		);
		if (!existing) {
			let insertionError = null;
			try {
				const result = await collections.backups.insertOne(desired, {
					writeConcern: { w: "majority" },
				});
				if (result?.acknowledged === false) {
					insertionError = new Error("Backup insertion was not acknowledged.");
				}
			} catch (error) {
				insertionError = error;
			}
			existing = await collections.backups.findOne(
				{ _id: desired._id },
				EXACT_READ_OPTIONS
			);
			if (!existing && insertionError) throw insertionError;
		}
		verifyBackup(existing, desired);
	}
	return plan.documentPlans.length;
}

const matchedOne = (result) =>
	Number(result?.matchedCount ?? result?.n ?? 0) === 1 &&
	Number(result?.modifiedCount ?? result?.nModified ?? 0) === 1;

async function readDocument(collections, documentPlan) {
	return collections[documentPlan.collectionName].findOne(
		{ _id: cloneFullBson(documentPlan.originalDocument._id) },
		EXACT_READ_OPTIONS
	);
}

async function replaceExact(collections, documentPlan, before, after, beforeHash, afterHash) {
	let writeError = null;
	try {
		const result = await collections[documentPlan.collectionName].replaceOne(
			buildFullDocumentCasFilter(before),
			cloneFullBson(after),
			{ writeConcern: { w: "majority" } }
		);
		if (result?.acknowledged === false || !matchedOne(result)) {
			writeError = new Error("Exact full-document CAS did not replace one document.");
		}
	} catch (error) {
		writeError = error;
	}
	const observed = await readDocument(collections, documentPlan);
	const observedHash = observed ? canonicalEjsonSha256(observed) : "";
	if (observedHash === afterHash) return observed;
	if (observedHash === beforeHash) {
		fail(
			`${documentPlan.target.key}:${documentPlan.role} CAS was lost${
				writeError ? ` (${writeError.message})` : ""
			}.`,
			"HOTELRUNNER_HALF_CENT_RECOVERY_CAS_LOST"
		);
	}
	fail(
		`${documentPlan.target.key}:${documentPlan.role} reached an unknown concurrent state.`,
		"HOTELRUNNER_HALF_CENT_RECOVERY_THIRD_STATE"
	);
}

async function compensate(collections, documentPlans, cause) {
	const errors = [];
	for (const documentPlan of [...documentPlans].reverse()) {
		const observed = await readDocument(collections, documentPlan);
		const hash = observed ? canonicalEjsonSha256(observed) : "";
		if (hash === documentPlan.originalHash) continue;
		if (hash !== documentPlan.expectedHash) {
			errors.push(`${documentPlan.target.key}:${documentPlan.role}:third_state`);
			continue;
		}
		try {
			await replaceExact(
				collections,
				documentPlan,
				documentPlan.expectedDocument,
				documentPlan.originalDocument,
				documentPlan.expectedHash,
				documentPlan.originalHash
			);
		} catch (error) {
			errors.push(`${documentPlan.target.key}:${documentPlan.role}:${error.code}`);
		}
	}
	const finalStates = [];
	for (const documentPlan of documentPlans) {
		const observed = await readDocument(collections, documentPlan);
		finalStates.push(
			observed && canonicalEjsonSha256(observed) === documentPlan.originalHash
		);
	}
	if (errors.length || finalStates.some((state) => !state)) {
		fail(
			`Recovery stopped after an unsafe partial state (${cause.message}); manual review is required.`,
			"HOTELRUNNER_HALF_CENT_RECOVERY_MANUAL_INTERVENTION_REQUIRED"
		);
	}
	fail(
		`Recovery failed and all six writes were restored exactly (${cause.message}).`,
		"HOTELRUNNER_HALF_CENT_RECOVERY_COMPENSATED"
	);
}

async function assertStandaloneWritablePrimary(admin) {
	let hello;
	try {
		hello = await admin.command({ hello: 1 });
	} catch (_) {
		hello = await admin.command({ isMaster: 1 });
	}
	if (
		Number(hello?.ok) !== 1 ||
		(hello?.isWritablePrimary !== true && hello?.ismaster !== true) ||
		hello?.setName ||
		hello?.msg === "isdbgrid" ||
		Array.isArray(hello?.hosts) ||
		hello?.serviceId
	) {
		fail(
			"Recovery requires a positively identified standalone writable primary.",
			"HOTELRUNNER_HALF_CENT_RECOVERY_TOPOLOGY_UNATTESTED"
		);
	}
	return true;
}

function currentReleaseAttestation() {
	return assertExactGitRelease({ repositoryRoot: path.resolve(__dirname, "..") });
}

function validateReleaseAttestation(attestation, expectedReleaseSha = "") {
	const releaseSha = lower(attestation?.releaseSha);
	const treeSha = lower(attestation?.treeSha);
	if (
		!validReleaseSha(releaseSha) ||
		!(validReleaseSha(treeSha) || validSha256(treeSha)) ||
		!Number.isFinite(dateMs(attestation?.capturedAt)) ||
		(expectedReleaseSha && releaseSha !== lower(expectedReleaseSha))
	) {
		fail(
			"The release attestation does not match the exact clean deployed checkout.",
			"HOTELRUNNER_HALF_CENT_RECOVERY_RELEASE_MISMATCH"
		);
	}
	return releaseSha;
}

function workerIsStopped() {
	let output = "";
	try {
		output = execFileSync(
			"systemctl",
			["show", WORKER_UNIT, "--property=LoadState", "--property=ActiveState"],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
		);
	} catch (error) {
		output = clean(error?.stdout);
	}
	const values = Object.fromEntries(
		String(output)
			.split(/\r?\n/)
			.map((line) => line.split("="))
			.filter((parts) => parts.length === 2)
	);
	if (values.LoadState !== "loaded" || values.ActiveState !== "inactive") {
		fail(
			`The dedicated worker must be loaded and inactive before apply.`,
			"HOTELRUNNER_HALF_CENT_RECOVERY_WORKER_NOT_STOPPED"
		);
	}
	return true;
}

async function applyRecovery({
	collections,
	proof,
	releaseSha,
	now = new Date(),
	resolveReleaseAttestation = currentReleaseAttestation,
	assertWorkerStopped = workerIsStopped,
	ownerToken = createOwnerToken(),
}) {
	const parsedProof = parseProof(proof, now);
	const releaseAttestation = await resolveReleaseAttestation();
	validateReleaseAttestation(releaseAttestation, releaseSha);
	await assertWorkerStopped();
	let scopes = await loadScopes(collections);
	let plan = buildPlan(
		scopes,
		parsedProof.plannedAt,
		releaseSha,
		now,
		ownerToken
	);
	if (plan.scopeHash !== parsedProof.scopeHash) {
		fail(
			"The live exact scope no longer matches the dry-run proof.",
			"HOTELRUNNER_HALF_CENT_RECOVERY_PROOF_MISMATCH"
		);
	}
	const backupCount = await ensureBackups(collections, plan, now);
	await acquireApplyLock(collections, plan, releaseSha, now, ownerToken);
	const compensateOwned = async (cause) => {
		let compensationError;
		try {
			await compensate(collections, plan.documentPlans, cause);
		} catch (error) {
			compensationError = error;
		}
		try {
			await finalizeApplyLock(collections, ownerToken, "compensated", now);
		} catch (lockError) {
			compensationError.lockFinalizationError = lockError;
		}
		throw compensationError;
	};
	// Recheck every mutable and identity precondition after all durable backups
	// exist and immediately before the first CAS.
	try {
		await assertWorkerStopped();
		scopes = await loadScopes(collections);
		plan = buildPlan(
			scopes,
			parsedProof.plannedAt,
			releaseSha,
			now,
			ownerToken
		);
		if (plan.scopeHash !== parsedProof.scopeHash) {
			fail(
				"The exact scope changed after backup creation.",
				"HOTELRUNNER_HALF_CENT_RECOVERY_PROOF_MISMATCH"
			);
		}
	} catch (error) {
		return compensateOwned(error);
	}
	const changed = [];
	try {
		for (const documentPlan of plan.documentPlans) {
			await replaceExact(
				collections,
				documentPlan,
				documentPlan.originalDocument,
				documentPlan.expectedDocument,
				documentPlan.originalHash,
				documentPlan.expectedHash
			);
			changed.push(documentPlan);
		}
	} catch (error) {
		return compensateOwned(error);
	}
	try {
		await assertWorkerStopped();
	} catch (error) {
		return compensateOwned(error);
	}
	try {
		for (const documentPlan of plan.documentPlans) {
			const observed = await readDocument(collections, documentPlan);
			if (
				!observed ||
				canonicalEjsonSha256(observed) !== documentPlan.expectedHash
			) {
				throw new Error(
					"Post-write verification did not match the exact expected image."
				);
			}
		}
		for (const target of TARGETS) {
			if ((await reservationMatches(collections.reservations, target)).length) {
				throw new Error(
					"A PMS reservation appeared while the worker was attested stopped."
				);
			}
		}
	} catch (error) {
		return compensateOwned(error);
	}
	try {
		await finalizeApplyLock(collections, ownerToken, "applied", now);
	} catch (error) {
		return compensateOwned(error);
	}
	return { changed: changed.length, backupCount, plan };
}

function sanitizedOutput(plan, mode, extra = {}) {
	return {
		mode,
		repairId: REPAIR_ID,
		scope: SCOPE_ATTESTATION,
		targets: TARGETS.map((target) => ({
			confirmationNumber: target.confirmationNumber,
			eventId: target.eventId,
			mirrorId: target.mirrorId,
			jobId: target.jobId,
			auditId: target.auditId,
			preallocatedReservationId: target.preallocatedReservationId,
		})),
		proof: mode === "dry_run" ? proofToken(plan) : undefined,
		proofExpiresInMinutes:
			mode === "dry_run" ? PROOF_MAX_AGE_MS / 60_000 : undefined,
		backupCollection: BACKUP_COLLECTION,
		mutationOrder: ["job", "audit", "job", "audit", "event", "event"],
		mutatesMirrors: false,
		mutatesReservations: false,
		...extra,
	};
}

async function connectDatabase(database) {
	await mongoose.connect(database, {
		autoIndex: false,
		autoCreate: false,
		readPreference: "primary",
	});
}

async function main(
	argv = process.argv.slice(2),
	{
		clock = () => new Date(),
		connect = connectDatabase,
		disconnect = async () => mongoose.disconnect(),
		collections: injectedCollections = null,
		db: injectedDb = null,
		resolveReleaseAttestation = currentReleaseAttestation,
		assertWorkerStopped = workerIsStopped,
		assertTopology = assertStandaloneWritablePrimary,
		skipConnect = false,
	} = {}
) {
	const options = parseArguments(argv);
	if (options.help) {
		return {
			usage: [
				"node scripts/recoverHotelRunnerHalfCentProjection20260811.js",
				`node scripts/recoverHotelRunnerHalfCentProjection20260811.js --apply --repair-id=${REPAIR_ID} --scope=${SCOPE_ATTESTATION} --proof=<dry-run-proof> --release-sha=<40-char-sha> --worker-stopped=${WORKER_UNIT}`,
			],
		};
	}
	const database =
		process.env.DATABASE || process.env.MONGO_URI || process.env.MONGODB_URI;
	if (!skipConnect && !database) {
		fail(
			"Missing DATABASE/MONGO connection string.",
			"HOTELRUNNER_HALF_CENT_RECOVERY_DATABASE_REQUIRED"
		);
	}
	let connectedHere = false;
	try {
		if (!skipConnect) {
			await connect(database);
			connectedHere = true;
		}
		const db = injectedDb || mongoose.connection.db;
		const collections = injectedCollections || collectionsFromDb(db);
		const now = clock();
		if (!options.apply) {
			const releaseAttestation = await resolveReleaseAttestation();
			const releaseSha = validateReleaseAttestation(releaseAttestation);
			const plan = buildPlan(await loadScopes(collections), now, releaseSha, now);
			return sanitizedOutput(plan, "dry_run", { releaseSha });
		}
		await assertTopology(db.admin());
		const result = await applyRecovery({
			collections,
			proof: options.proof,
			releaseSha: options.releaseSha,
			now,
			resolveReleaseAttestation,
			assertWorkerStopped,
		});
		return sanitizedOutput(result.plan, "apply", {
			changedDocuments: result.changed,
			backupCount: result.backupCount,
			releaseSha: lower(options.releaseSha),
		});
	} finally {
		if (connectedHere) await disconnect();
	}
}

if (require.main === module) {
	main()
		.then((output) => console.log(JSON.stringify(output, null, 2)))
		.catch((error) => {
			console.error(
				JSON.stringify(
					{
						ok: false,
						code:
							error?.code || "HOTELRUNNER_HALF_CENT_RECOVERY_UNEXPECTED",
						message: error?.message || "Recovery failed.",
					},
					null,
					2
				)
			);
			process.exitCode = 1;
		});
}

module.exports = {
	AWAITING_MESSAGE,
	BACKUP_COLLECTION,
	COLLECTION_NAMES,
	EXACT_READ_OPTIONS,
	FAILURE_CODE,
	FAILURE_REASON,
	JOB_HOLD_MS,
	PROOF_MAX_AGE_MS,
	REPAIR_ID,
	SCOPE_ATTESTATION,
	TARGETS,
	WORKER_UNIT,
	RecoveryError,
	applyRecovery,
	applyUpdateToDocument,
	assertStandaloneWritablePrimary,
	backupRecord,
	buildAuditUpdate,
	buildEventUpdate,
	buildFullDocumentCasFilter,
	buildJobUpdate,
	buildPlan,
	cloneFullBson,
	collectionsFromDb,
	compensate,
	ensureBackups,
	loadScopes,
	main,
	parseArguments,
	parseProof,
	proofToken,
	replaceExact,
	reservationMatches,
	validateScope,
	validateReleaseAttestation,
	verifyBackup,
};
