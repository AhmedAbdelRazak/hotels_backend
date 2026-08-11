/** @format */

"use strict";

/**
 * One-time, fail-closed replay preparation for Agoda reservation 2040450395.
 *
 * HotelRunner already owns the PMS reservation. This utility never edits that
 * reservation, its HotelRunner event, or its mirror. It reopens only the exact
 * authenticated-email audit and its exact HotelRunner-first coordinator job so
 * the ordinary production coordinator can perform its guarded commercial-only
 * reconciliation.
 *
 * Dry run (default):
 *   node scripts/recoverAgoda2040450395Commercial20260811.js
 *
 * Apply while the dedicated worker is stopped:
 *   node scripts/recoverAgoda2040450395Commercial20260811.js --apply \
 *     --repair-id=agoda-2040450395-hotelrunner-commercial-replay-20260811-v1 \
 *     --scope=2040450395 --proof=<dry-run-proof> \
 *     --release-sha=<40-char-sha> \
 *     --worker-stopped=xhotelpro-hotelrunner-sync.service
 */

const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

require("dotenv").config({ path: path.resolve(__dirname, "../.env") });

const BSON = require("bson");
const mongoose = require("mongoose");

mongoose.set("autoIndex", false);
mongoose.set("autoCreate", false);

const {
	canonicalEjsonSha256,
} = require("../services/tripHotelRunnerRepair20260805");
const {
	assertExactGitRelease,
} = require("../services/hotelrunnerWorkerRevision");
const {
	createArchiveFingerprint,
	validateArchivedDirectOtaEmail,
} = require("../services/hotelrunnerFirstOtaFallback");
const {
	buildHotelRunnerEmailCommercialEvidence,
	detectConfirmationMatchFields,
	directHotelRunnerCommercialEnrichmentSet,
	directHotelRunnerEmailCommercialGuard,
} = require("../services/otaReservationMapper");

const REPAIR_ID =
	"agoda-2040450395-hotelrunner-commercial-replay-20260811-v1";
const BACKUP_COLLECTION =
	"ota_agoda_2040450395_commercial_replay_backup_20260811_v1";
const WORKER_UNIT = "xhotelpro-hotelrunner-sync.service";
const SCOPE_ATTESTATION = "2040450395";
const PROOF_MAX_AGE_MS = 30 * 60 * 1000;
const CLOCK_SKEW_MS = 5_000;
const JOB_HOLD_MS = 60 * 1000;
const APPLY_LOCK_MS = PROOF_MAX_AGE_MS + 5 * 60 * 1000;
const APPLY_LOCK_ID = `${REPAIR_ID}:apply-lock`;
const TERMINAL_DECISION = "api_commercial_reconciliation_needs_review";
const TERMINAL_CODE =
	"hotelrunner_email_commercial_enrichment_guard_failed";
const TERMINAL_MESSAGE =
	"HotelRunner owns the reservation, but the archived email commercial evidence requires review.";
const TERMINAL_GUARD_ERROR =
	"Commercial enrichment gate failed: hotelrunner_amount.";
const REOPEN_DECISION =
	"incident_reopened_for_published_hotelrunner_amount_role_fix_20260811";
const AWAITING_MESSAGE =
	"The existing HotelRunner API reservation was queued for guarded commercial reconciliation after the published amount-role fix.";

const TARGET = Object.freeze({
	key: "agoda_2040450395",
	hotelId: "6a40b6a1a6efe70450536038",
	ownerId: "68b74714fb50e159d48c714d",
	provider: "agoda",
	channel: "agodaycs5",
	confirmationNumber: "2040450395",
	identityKey: "agoda:2040450395",
	pmsConfirmationNumber: "9323851739",
	hotelRunnerReservationId: "40429493",
	reservationId: "6a7b62c363ccd90ab04b1fb8",
	eventId: "6a7b62bed8cbed2f4bad47aa",
	mirrorId: "6a7b62bf63ccd90ab04b1fab",
	jobId: "6a7b6271d8cbed2f4bad47a9",
	auditId: "6a7b626f6d72d17a49d5663e",
	checkinDate: "2026-08-14",
	checkoutDate: "2026-08-15",
	terminalAt: "2026-08-11T18:00:03.901Z",
	jobUpdatedAt: "2026-08-11T18:00:03.909Z",
	auditUpdatedAt: "2026-08-11T18:00:03.905Z",
	rootTotal: 75,
	hotelRunnerReportedAmount: 53.97,
	guestGross: 87.22,
	hotelPayout: 53.97,
	otaExpense: 33.25,
	otaCommission: 13.09,
	platformMargin: -21.03,
});

const COLLECTION_NAMES = Object.freeze({
	jobs: "hotelrunnerotafallbackjobs",
	audits: "inboundemails",
	events: "hotelrunnerevents",
	mirrors: "hotelrunnerreservations",
	reservations: "reservations",
	hotels: "hoteldetails",
	backups: BACKUP_COLLECTION,
});

const EXACT_READ_OPTIONS = Object.freeze({
	readPreference: "primary",
	readConcern: Object.freeze({ level: "local" }),
	promoteBuffers: false,
	promoteLongs: false,
	promoteValues: false,
});

class RecoveryError extends Error {
	constructor(message, code = "AGODA_2040450395_RECOVERY_FAILED") {
		super(message);
		this.name = "RecoveryError";
		this.code = code;
	}
}

const fail = (message, code) => {
	throw new RecoveryError(message, code);
};
const clean = (value) => String(value?._id || value || "").trim();
const lower = (value) => clean(value).toLowerCase();
const id = (value) => lower(value?._id || value);
const oid = (value) => new mongoose.Types.ObjectId(clean(value));
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
const moneyCents = (value) => {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? Math.round(parsed * 100) : NaN;
};
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
// Raw-driver reads keep exact BSON numeric types for full-document CAS. Service
// validators, however, must see the same promoted JavaScript values that the
// ordinary Mongoose coordinator saw when it created the immutable hashes.
const promoteBsonForServices = (value) =>
	BSON.deserialize(BSON.serialize({ value }, { ignoreUndefined: false }), {
		promoteBuffers: true,
		promoteLongs: true,
		promoteValues: true,
	}).value;

function requireCondition(condition, field) {
	if (!condition) {
		fail(
			`Exact Agoda recovery scope failed: ${field}.`,
			"AGODA_2040450395_RECOVERY_SCOPE_DRIFT"
		);
	}
}

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
					"AGODA_2040450395_RECOVERY_ARGUMENT_INVALID"
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
					"AGODA_2040450395_RECOVERY_ARGUMENT_INVALID"
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
			"AGODA_2040450395_RECOVERY_ARGUMENT_INVALID"
		);
	}
	if (options.apply) {
		if (options.repairId !== REPAIR_ID) {
			fail(
				`--apply requires --repair-id=${REPAIR_ID}.`,
				"AGODA_2040450395_RECOVERY_REPAIR_ID_REQUIRED"
			);
		}
		if (options.scope !== SCOPE_ATTESTATION) {
			fail(
				`--apply requires --scope=${SCOPE_ATTESTATION}.`,
				"AGODA_2040450395_RECOVERY_SCOPE_REQUIRED"
			);
		}
		if (!/^\d{13}\.[a-f0-9]{64}$/i.test(options.proof)) {
			fail(
				"--apply requires the exact unexpired dry-run proof.",
				"AGODA_2040450395_RECOVERY_PROOF_REQUIRED"
			);
		}
		if (!validReleaseSha(options.releaseSha)) {
			fail(
				"--apply requires a full 40-character --release-sha.",
				"AGODA_2040450395_RECOVERY_RELEASE_REQUIRED"
			);
		}
		if (options.workerStopped !== WORKER_UNIT) {
			fail(
				`--apply requires --worker-stopped=${WORKER_UNIT}.`,
				"AGODA_2040450395_RECOVERY_WORKER_ATTESTATION_REQUIRED"
			);
		}
	}
	return options;
}

function parseProof(proof, now = new Date()) {
	const match = clean(proof).match(/^(\d{13})\.([a-f0-9]{64})$/i);
	if (!match) {
		fail(
			"Dry-run proof is malformed.",
			"AGODA_2040450395_RECOVERY_PROOF_INVALID"
		);
	}
	const plannedAt = new Date(Number(match[1]));
	const currentAt = new Date(now);
	const age = currentAt.getTime() - plannedAt.getTime();
	if (
		!Number.isFinite(plannedAt.getTime()) ||
		!Number.isFinite(currentAt.getTime()) ||
		age < -CLOCK_SKEW_MS ||
		age > PROOF_MAX_AGE_MS
	) {
		fail(
			"Dry-run proof expired or is not yet valid.",
			"AGODA_2040450395_RECOVERY_PROOF_EXPIRED"
		);
	}
	return { plannedAt, scopeHash: lower(match[2]) };
}

function collectionsFromDb(db) {
	return Object.fromEntries(
		Object.entries(COLLECTION_NAMES).map(([key, name]) => [
			key,
			db.collection(name),
		])
	);
}

async function toArray(cursor) {
	return cursor && typeof cursor.toArray === "function"
		? cursor.toArray()
		: cursor;
}

function reservationIdentityQuery() {
	return {
		hotelId: oid(TARGET.hotelId),
		$or: [
			{ otaIdentityKey: TARGET.identityKey },
			{ "supplierData.otaConfirmationNumber": TARGET.confirmationNumber },
			{ "supplierData.platformConfirmationNumber": TARGET.confirmationNumber },
			{ "supplierData.suppliedBookingNo": TARGET.confirmationNumber },
		],
	};
}

function directEligibleAuditQuery() {
	return {
		hotelId: oid(TARGET.hotelId),
		provider: TARGET.provider,
		confirmationNumber: TARGET.confirmationNumber,
		intent: "new_reservation",
		eventType: "new",
		"senderAuthentication.authenticatedAligned": true,
		"senderAuthentication.trustedProvider": TARGET.provider,
		"normalizedReservation.trustedTransportProvider": TARGET.provider,
		"normalizedReservation.sourceSenderAuthenticated": true,
		"normalizedReservation.sourceSenderTrusted": true,
	};
}

async function loadScope(collections) {
	const [
		job,
		audit,
		event,
		mirror,
		reservation,
		hotel,
		jobs,
		directAudits,
		events,
		mirrors,
		reservations,
	] = await Promise.all([
		collections.jobs.findOne({ _id: oid(TARGET.jobId) }, EXACT_READ_OPTIONS),
		collections.audits.findOne({ _id: oid(TARGET.auditId) }, EXACT_READ_OPTIONS),
		collections.events.findOne({ _id: oid(TARGET.eventId) }, EXACT_READ_OPTIONS),
		collections.mirrors.findOne({ _id: oid(TARGET.mirrorId) }, EXACT_READ_OPTIONS),
		collections.reservations.findOne(
			{ _id: oid(TARGET.reservationId) },
			EXACT_READ_OPTIONS
		),
		collections.hotels.findOne({ _id: oid(TARGET.hotelId) }, EXACT_READ_OPTIONS),
		toArray(
			collections.jobs.find(
				{
					hotelId: oid(TARGET.hotelId),
					provider: TARGET.provider,
					confirmationNumber: TARGET.confirmationNumber,
				},
				EXACT_READ_OPTIONS
			)
		),
		toArray(
			collections.audits.find(directEligibleAuditQuery(), EXACT_READ_OPTIONS)
		),
		toArray(
			collections.events.find(
				{
					hotelId: oid(TARGET.hotelId),
					providerNumber: TARGET.confirmationNumber,
				},
				EXACT_READ_OPTIONS
			)
		),
		toArray(
			collections.mirrors.find(
				{
					hotelId: oid(TARGET.hotelId),
					$or: [
						{ providerNumber: TARGET.confirmationNumber },
						{ providerNumberAliases: TARGET.confirmationNumber },
					],
				},
				EXACT_READ_OPTIONS
			)
		),
		toArray(collections.reservations.find(reservationIdentityQuery(), EXACT_READ_OPTIONS)),
	]);
	return {
		job,
		audit,
		event,
		mirror,
		reservation,
		hotel,
		directAuditIds: (directAudits || []).map((entry) => id(entry?._id)),
		counts: {
			jobs: jobs?.length || 0,
			directAudits: directAudits?.length || 0,
			events: events?.length || 0,
			mirrors: mirrors?.length || 0,
			reservations: reservations?.length || 0,
		},
	};
}

function validateArchive(scope) {
	const eligibleAudit = promoteBsonForServices(scope.audit);
	eligibleAudit.processingStatus = "awaiting_hotelrunner";
	const validation = validateArchivedDirectOtaEmail(eligibleAudit, {
		hotelId: TARGET.hotelId,
		provider: TARGET.provider,
		confirmationNumber: TARGET.confirmationNumber,
	});
	requireCondition(validation.ok === true, `audit.archive.${validation.code || "invalid"}`);
	for (const [field, actual] of [
		["archiveFingerprint", validation.archiveFingerprint],
		["normalizedReservationHash", validation.normalizedReservationHash],
		["resolvedHotelProofHash", validation.resolvedHotelProofHash],
		["lookupConfirmationHash", validation.lookupConfirmationHash],
		["inboundEmailHash", validation.inboundEmailHash],
	]) {
		requireCondition(lower(scope.job[field]) === lower(actual), `job.${field}`);
	}
	requireCondition(
		clean(validation.lookupConfirmationNumber) === TARGET.confirmationNumber,
		"audit.lookupConfirmationNumber"
	);
	return validation;
}

function defaultCommercialPreflight(scope) {
	const applicationScope = promoteBsonForServices(scope);
	const normalized = applicationScope.audit.normalizedReservation || {};
	const evidence = buildHotelRunnerEmailCommercialEvidence(normalized, {
		appliedAt: new Date(TARGET.terminalAt),
	});
	requireCondition(Boolean(evidence), "commercial.evidence");
	const matchedReservationBy = detectConfirmationMatchFields(
		applicationScope.reservation,
		TARGET.confirmationNumber,
		TARGET.provider,
		""
	);
	requireCondition(
		matchedReservationBy.includes("otaIdentityKey"),
		"reservation.canonicalIdentity"
	);
	const guard = directHotelRunnerEmailCommercialGuard({
		normalized,
		existing: applicationScope.reservation,
		hotelDetails: applicationScope.hotel,
		matchedReservationBy,
		evidence,
	});
	requireCondition(guard?.ok === true, `commercial.guard.${guard?.reason || "invalid"}`);
	requireCondition(guard.reportedTotalRole === "payout", "commercial.reportedRole");
	requireCondition(
		moneyCents(guard.hotelRunnerReportedTotal) ===
			moneyCents(TARGET.hotelRunnerReportedAmount),
		"commercial.reportedAmount"
	);
	const set = directHotelRunnerCommercialEnrichmentSet(normalized, evidence, {
		reportedTotalRole: guard.reportedTotalRole,
		existing: applicationScope.reservation,
		commercialPricing: guard.commercialPricing,
		materializeVerifiedOtaCollectPayment: true,
	});
	requireCondition(Boolean(set), "commercial.enrichmentSet");
	for (const [field, actual, expected] of [
		["gross", set.total_amount, TARGET.guestGross],
		["client", set["adminPricing.clientTotal"], TARGET.guestGross],
		["payout", set["adminPricing.netAfterExpensesTotal"], TARGET.hotelPayout],
		["expense", set["adminPricing.otaExpenseTotal"], TARGET.otaExpense],
		["margin", set["adminPricing.platformMarginTotal"], TARGET.platformMargin],
		["commission", set.commission_ota, TARGET.otaCommission],
		["paid", set.paid_amount, TARGET.guestGross],
	]) {
		requireCondition(moneyCents(actual) === moneyCents(expected), `commercial.${field}`);
	}
	requireCondition(set.payment === "paid online", "commercial.payment");
	requireCondition(set.financeStatus === "paid online", "commercial.financeStatus");
	requireCondition(
		moneyCents(guard.commercialPricing.rootTotal) === moneyCents(TARGET.rootTotal),
		"commercial.root"
	);
	return {
		reportedTotalRole: guard.reportedTotalRole,
		hotelRunnerReportedAmount: guard.hotelRunnerReportedTotal,
		rootTotal: guard.commercialPricing.rootTotal,
		guestGross: set.total_amount,
		hotelPayout: set["adminPricing.netAfterExpensesTotal"],
		otaExpense: set["adminPricing.otaExpenseTotal"],
		platformMargin: set["adminPricing.platformMarginTotal"],
		otaCommission: set.commission_ota,
		paidAmount: set.paid_amount,
	};
}

function validateScope(scope, { commercialPreflight = defaultCommercialPreflight } = {}) {
	for (const key of ["job", "audit", "event", "mirror", "reservation", "hotel"]) {
		requireCondition(Boolean(scope[key]), `${key}.exists`);
	}
	for (const key of [
		"jobs",
		"directAudits",
		"events",
		"mirrors",
		"reservations",
	]) {
		requireCondition(scope.counts?.[key] === 1, `counts.${key}`);
	}
	requireCondition(
		Array.isArray(scope.directAuditIds) &&
			scope.directAuditIds.length === 1 &&
			scope.directAuditIds[0] === TARGET.auditId,
		"directAudit.target"
	);
	const { job, audit, event, mirror, reservation, hotel } = scope;
	requireCondition(id(job._id) === TARGET.jobId, "job.id");
	requireCondition(Number(job.__v || 0) === 0, "job.version");
	requireCondition(id(job.hotelId) === TARGET.hotelId, "job.hotelId");
	requireCondition(lower(job.provider) === TARGET.provider, "job.provider");
	requireCondition(job.confirmationNumber === TARGET.confirmationNumber, "job.confirmation");
	requireCondition(lower(job.identityKey) === TARGET.identityKey, "job.identityKey");
	requireCondition(id(job.inboundEmailId) === TARGET.auditId, "job.auditId");
	requireCondition(lower(job.status) === "needs_review", "job.status");
	requireCondition(Number(job.attemptCount) === 1, "job.attemptCount");
	requireCondition(Number(job.lookupAttemptCount || 0) === 0, "job.lookupAttemptCount");
	requireCondition(lower(job.lastDecision) === TERMINAL_DECISION, "job.lastDecision");
	requireCondition(clean(job.lastErrorCode) === TERMINAL_CODE, "job.lastErrorCode");
	requireCondition(clean(job.lastErrorMessage) === TERMINAL_MESSAGE, "job.lastErrorMessage");
	requireCondition(dateMs(job.completedAt) === dateMs(TARGET.terminalAt), "job.completedAt");
	requireCondition(
		dateMs(job.inboundAuditFinalizedAt) === dateMs(TARGET.terminalAt),
		"job.auditFinalizedAt"
	);
	requireCondition(
		lower(job.inboundAuditFinalizationStatus) === "completed",
		"job.auditFinalizationStatus"
	);
	requireCondition(dateMs(job.updatedAt) === dateMs(TARGET.jobUpdatedAt), "job.updatedAt");
	requireCondition(id(job.reservationMongoId) === TARGET.reservationId, "job.reservationId");
	requireCondition(id(job.hotelRunnerEventId) === TARGET.eventId, "job.eventId");
	requireCondition(id(job.hotelRunnerMirrorId) === TARGET.mirrorId, "job.mirrorId");
	requireCondition(lower(job.ingressDecision?.status) === "api_observed", "job.ingressDecision");
	requireCondition(job.identityConflict !== true, "job.identityConflict");
	requireCondition(!clean(job.pendingTerminalStatus), "job.pendingTerminalStatus");
	requireCondition(!clean(job.leaseOwner) && !clean(job.leaseToken), "job.lease");

	requireCondition(id(audit._id) === TARGET.auditId, "audit.id");
	requireCondition(Number(audit.__v || 0) === 0, "audit.version");
	requireCondition(id(audit.hotelId) === TARGET.hotelId, "audit.hotelId");
	requireCondition(lower(audit.provider) === TARGET.provider, "audit.provider");
	requireCondition(audit.confirmationNumber === TARGET.confirmationNumber, "audit.confirmation");
	requireCondition(lower(audit.intent) === "new_reservation", "audit.intent");
	requireCondition(lower(audit.eventType) === "new", "audit.eventType");
	requireCondition(lower(audit.processingStatus) === "needs_review", "audit.status");
	requireCondition(lower(audit.automationAction) === "skipped", "audit.action");
	requireCondition(lower(audit.skipReason) === TERMINAL_CODE, "audit.skipReason");
	requireCondition(audit.automationComment === TERMINAL_MESSAGE, "audit.comment");
	requireCondition(audit.hasReservationConnection === true, "audit.connection");
	requireCondition(id(audit.reservationMongoId) === TARGET.reservationId, "audit.reservationId");
	requireCondition(
		clean(audit.pmsConfirmationNumber) === TARGET.pmsConfirmationNumber,
		"audit.pmsConfirmation"
	);
	requireCondition(
		Array.isArray(audit.matchedReservationBy) &&
			audit.matchedReservationBy.length === 1 &&
			audit.matchedReservationBy[0] === "hotelrunner_first_fallback",
		"audit.matchedReservationBy"
	);
	requireCondition(
		Array.isArray(audit.reconcileErrors) &&
			audit.reconcileErrors.length === 1 &&
			audit.reconcileErrors[0] === TERMINAL_GUARD_ERROR,
		"audit.reconcileErrors"
	);
	requireCondition(
		lower(audit.hotelRunnerFirstFallback?.status) === "needs_review" &&
			id(audit.hotelRunnerFirstFallback?.jobId) === TARGET.jobId &&
			clean(audit.hotelRunnerFirstFallback?.lastErrorCode) === TERMINAL_CODE,
		"audit.fallbackTerminal"
	);
	requireCondition(
		lower(audit.reconciliation?.hotelRunnerFirstFallback?.decision) ===
			TERMINAL_DECISION,
		"audit.reconciliationDecision"
	);
	requireCondition(dateMs(audit.updatedAt) === dateMs(TARGET.auditUpdatedAt), "audit.updatedAt");

	requireCondition(id(event._id) === TARGET.eventId, "event.id");
	requireCondition(id(event.hotelId) === TARGET.hotelId, "event.hotelId");
	requireCondition(lower(event.status) === "completed", "event.status");
	requireCondition(lower(event.source) === "push", "event.source");
	requireCondition(event.providerNumber === TARGET.confirmationNumber, "event.providerNumber");
	requireCondition(lower(event.channel) === TARGET.channel, "event.channel");
	requireCondition(event.hotelRunnerReservationId === TARGET.hotelRunnerReservationId, "event.hrId");
	requireCondition(id(event.reservationMongoId) === TARGET.reservationId, "event.reservationId");
	requireCondition(id(event.mirrorId) === TARGET.mirrorId, "event.mirrorId");
	requireCondition(event.integrityConflict !== true && !clean(event.errorCode), "event.integrity");
	requireCondition(lower(event.result?.status) === "created", "event.result");

	requireCondition(id(mirror._id) === TARGET.mirrorId, "mirror.id");
	requireCondition(id(mirror.hotelId) === TARGET.hotelId, "mirror.hotelId");
	requireCondition(lower(mirror.projectionStatus) === "created", "mirror.status");
	requireCondition(mirror.providerNumber === TARGET.confirmationNumber, "mirror.providerNumber");
	requireCondition(lower(mirror.channel) === TARGET.channel, "mirror.channel");
	requireCondition(mirror.hotelRunnerReservationId === TARGET.hotelRunnerReservationId, "mirror.hrId");
	requireCondition(id(mirror.reservationMongoId) === TARGET.reservationId, "mirror.reservationId");
	requireCondition(mirror.identityConflict !== true && !clean(mirror.lastErrorCode), "mirror.integrity");

	requireCondition(id(reservation._id) === TARGET.reservationId, "reservation.id");
	requireCondition(Number(reservation.__v || 0) === 0, "reservation.version");
	requireCondition(id(reservation.hotelId) === TARGET.hotelId, "reservation.hotelId");
	requireCondition(id(reservation.belongsTo) === TARGET.ownerId, "reservation.ownerId");
	requireCondition(lower(reservation.booking_source) === TARGET.provider, "reservation.source");
	requireCondition(lower(reservation.otaIdentityKey) === TARGET.identityKey, "reservation.identityKey");
	requireCondition(lower(reservation.supplierData?.otaProvider) === TARGET.provider, "reservation.provider");
	requireCondition(dateKey(reservation.checkin_date) === TARGET.checkinDate, "reservation.checkin");
	requireCondition(dateKey(reservation.checkout_date) === TARGET.checkoutDate, "reservation.checkout");
	requireCondition(Number(reservation.total_rooms) === 1, "reservation.rooms");
	requireCondition(reservation.total_amount == null, "reservation.clientTotal");
	requireCondition(moneyCents(reservation.sub_total) === moneyCents(TARGET.rootTotal), "reservation.subTotal");
	requireCondition(moneyCents(reservation.adminPricing?.rootTotal) === moneyCents(TARGET.rootTotal), "reservation.rootTotal");
	requireCondition(reservation.adminPricing?.clientTotal == null, "reservation.adminClientTotal");
	requireCondition(
		moneyCents(reservation.adminPricing?.sourceAmount) ===
			moneyCents(TARGET.hotelRunnerReportedAmount),
		"reservation.sourceAmount"
	);
	requireCondition(reservation.adminPricing?.commercialVerified !== true, "reservation.commercialVerified");
	requireCondition(!reservation.supplierData?.hotelRunnerEmailCommercialEvidence, "reservation.emailEvidence");
	requireCondition(
		moneyCents(reservation.supplierData?.hotelRunner?.pricing?.grandTotal) ===
			moneyCents(TARGET.hotelRunnerReportedAmount),
		"reservation.hotelRunnerGrandTotal"
	);
	requireCondition(
		lower(reservation.supplierData?.otaCommercialEvidence?.verificationState) ===
			"unresolved" &&
			lower(
				reservation.supplierData?.otaCommercialEvidence
					?.hotelRunnerReportedAmount?.role
			) === "unknown",
		"reservation.unresolvedApiEvidence"
	);
	requireCondition(
		Array.isArray(reservation.roomId) && reservation.roomId.length === 0 &&
			Array.isArray(reservation.bedNumber) && reservation.bedNumber.length === 0,
		"reservation.operationalState"
	);
	requireCondition(Number(reservation.paid_amount || 0) === 0, "reservation.paidAmount");
	requireCondition(id(hotel._id) === TARGET.hotelId, "hotel.id");
	requireCondition(id(hotel.belongsTo) === TARGET.ownerId, "hotel.ownerId");
	requireCondition(hotel.activateHotel === true && hotel.xHotelProActive !== false, "hotel.active");

	const archive = validateArchive(scope);
	const commercial = commercialPreflight(scope);
	return { archive, commercial };
}

function recoveryMarker(plannedAt, releaseSha, ownerToken = "") {
	return {
		repairId: REPAIR_ID,
		confirmationNumber: TARGET.confirmationNumber,
		releaseSha: lower(releaseSha),
		...(ownerToken ? { ownerTokenHash: sha256(ownerToken) } : {}),
		reopenedAt: new Date(plannedAt),
	};
}

function buildAuditUpdate(plannedAt, releaseSha, ownerToken = "") {
	const reopenedAt = new Date(plannedAt);
	return {
		$set: {
			processingStatus: "awaiting_hotelrunner",
			automationAction: "queued",
			skipReason: "",
			automationComment: AWAITING_MESSAGE,
			hasReservationConnection: true,
			reservationMongoId: oid(TARGET.reservationId),
			pmsConfirmationNumber: TARGET.pmsConfirmationNumber,
			matchedReservationBy: ["hotelrunner_first_fallback"],
			reconcileWarnings: [],
			reconcileErrors: [],
			"reconciliation.status": "awaiting_hotelrunner",
			"reconciliation.actionTaken": "queued",
			"reconciliation.skipReason": "",
			"reconciliation.automationComment": AWAITING_MESSAGE,
			"reconciliation.reservationId": oid(TARGET.reservationId),
			"reconciliation.hotelId": oid(TARGET.hotelId),
			"reconciliation.pmsConfirmationNumber": TARGET.pmsConfirmationNumber,
			"reconciliation.provider": TARGET.provider,
			"reconciliation.confirmationNumber": TARGET.confirmationNumber,
			"reconciliation.warnings": [],
			"reconciliation.errors": [],
			"reconciliation.matchedReservationBy": ["hotelrunner_first_fallback"],
			"reconciliation.hotelRunnerFirst": true,
			"hotelRunnerFirstFallback.status": "enqueued",
			"hotelRunnerFirstFallback.jobId": TARGET.jobId,
			"hotelRunnerFirstFallback.collision": false,
			"hotelRunnerFirstFallback.lastErrorCode": "",
			"hotelRunnerFirstFallback.lastErrorMessage": "",
			"hotelRunnerFirstFallback.commercialReplayRecovery": recoveryMarker(
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

function buildJobUpdate(
	plannedAt,
	releaseSha,
	appliedAt = plannedAt,
	ownerToken = ""
) {
	const reopenedAt = new Date(plannedAt);
	return {
		$set: {
			status: "awaiting_hotelrunner",
			nextAttemptAt: new Date(dateMs(appliedAt) + JOB_HOLD_MS),
			attemptCount: 0,
			lookupAttemptCount: 0,
			lastDecision: REOPEN_DECISION,
			lastErrorCode: "",
			lastErrorMessage: "",
			inboundAuditFinalizationStatus: "",
			commercialReplayRecovery: recoveryMarker(
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

function buildPlan(
	scope,
	plannedAt,
	releaseSha,
	appliedAt = plannedAt,
	ownerToken = "",
	dependencies = {}
) {
	if (!validReleaseSha(releaseSha)) {
		fail(
			"A full reviewed release SHA is required.",
			"AGODA_2040450395_RECOVERY_RELEASE_REQUIRED"
		);
	}
	const preflight = validateScope(scope, dependencies);
	const originalHashes = Object.fromEntries(
		["job", "audit", "event", "mirror", "reservation", "hotel"].map((role) => [
			role,
			canonicalEjsonSha256(scope[role]),
		])
	);
	const scopeHash = canonicalEjsonSha256({
		repairId: REPAIR_ID,
		releaseSha: lower(releaseSha),
		target: TARGET,
		originalHashes,
		commercial: preflight.commercial,
		mutationRoles: ["audit", "job"],
	});
	const documentPlans = [
		{
			role: "audit",
			collectionName: "audits",
			originalDocument: cloneFullBson(scope.audit),
			update: buildAuditUpdate(plannedAt, releaseSha, ownerToken),
		},
		{
			role: "job",
			collectionName: "jobs",
			originalDocument: cloneFullBson(scope.job),
			update: buildJobUpdate(
				plannedAt,
				releaseSha,
				appliedAt,
				ownerToken
			),
		},
	].map((entry) => {
		const expectedDocument = applyUpdateToDocument(
			entry.originalDocument,
			entry.update
		);
		return {
			...entry,
			expectedDocument,
			originalHash: canonicalEjsonSha256(entry.originalDocument),
			expectedHash: canonicalEjsonSha256(expectedDocument),
		};
	});
	return {
		plannedAt: new Date(plannedAt),
		releaseSha: lower(releaseSha),
		scopeHash,
		originalHashes,
		preflight,
		documentPlans,
	};
}

const proofToken = (plan) => `${dateMs(plan.plannedAt)}.${plan.scopeHash}`;

function createOwnerToken() {
	return crypto.randomBytes(32).toString("hex");
}

function backupRecord(documentPlan, plan, createdAt) {
	const record = {
		_id: `${REPAIR_ID}:${documentPlan.role}`,
		repairId: REPAIR_ID,
		confirmationNumber: TARGET.confirmationNumber,
		role: documentPlan.role,
		collectionName: COLLECTION_NAMES[documentPlan.collectionName],
		documentId: id(documentPlan.originalDocument._id),
		scopeHash: plan.scopeHash,
		originalHash: documentPlan.originalHash,
		originalDocument: cloneFullBson(documentPlan.originalDocument),
		evidenceHashes: cloneFullBson(plan.originalHashes),
		createdAt: new Date(createdAt),
	};
	return { ...record, recordHash: canonicalEjsonSha256(record) };
}

function verifyBackup(record, expected) {
	const unsigned = Object.fromEntries(
		Object.entries(record || {}).filter(([key]) => key !== "recordHash")
	);
	if (
		!record ||
		record._id !== expected._id ||
		record.repairId !== REPAIR_ID ||
		record.scopeHash !== expected.scopeHash ||
		record.originalHash !== expected.originalHash ||
		canonicalEjsonSha256(record.originalDocument) !== expected.originalHash ||
		canonicalEjsonSha256(unsigned) !== record.recordHash
	) {
		fail(
			`Durable ${expected.role} backup failed integrity.`,
			"AGODA_2040450395_RECOVERY_BACKUP_INVALID"
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

async function acquireApplyLock(collections, plan, releaseSha, now, ownerToken) {
	if (!validOwnerToken(ownerToken)) {
		fail(
			"A cryptographic recovery owner token is required.",
			"AGODA_2040450395_RECOVERY_OWNER_INVALID"
		);
	}
	// Deliberately non-reclaimable. Apply requires the worker to be inactive and
	// writes the audit first, while the job remains terminal and unclaimable,
	// then writes the job last with a future hold. A hard crash can therefore
	// leave only a harmless audit-only marker; it cannot release worker work.
	// The two permanent full-BSON backups make manual exact compensation
	// deterministic, while an automatic expired-owner takeover would have to
	// guess whether the former process crossed a CAS boundary.
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
			insertionError = new Error("Apply lock was not acknowledged.");
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
		`Another recovery owner holds the durable apply lock${
			insertionError ? ` (${insertionError.message})` : ""
		}.`,
		"AGODA_2040450395_RECOVERY_LOCK_HELD"
	);
}

async function finalizeApplyLock(collections, ownerToken, state, now) {
	const result = await collections.backups.updateOne(
		{ _id: APPLY_LOCK_ID, ownerToken, state: "active" },
		{ $set: { state, completedAt: new Date(now) } },
		{ writeConcern: { w: "majority" } }
	);
	if (
		Number(result?.matchedCount ?? result?.n ?? 0) === 1 &&
		Number(result?.modifiedCount ?? result?.nModified ?? 0) === 1
	) {
		return true;
	}
	const observed = await collections.backups.findOne(
		{ _id: APPLY_LOCK_ID },
		EXACT_READ_OPTIONS
	);
	if (observed?.ownerToken === ownerToken && observed?.state === state) return true;
	fail(
		"The durable recovery lock could not be finalized by its exact owner.",
		"AGODA_2040450395_RECOVERY_LOCK_LOST"
	);
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

async function replaceExact(
	collections,
	documentPlan,
	before,
	after,
	beforeHash,
	afterHash
) {
	let writeError = null;
	try {
		const result = await collections[documentPlan.collectionName].replaceOne(
			buildFullDocumentCasFilter(before),
			cloneFullBson(after),
			{ writeConcern: { w: "majority" } }
		);
		if (result?.acknowledged === false || !matchedOne(result)) {
			writeError = new Error("Full-document CAS did not replace one document.");
		}
	} catch (error) {
		writeError = error;
	}
	const observed = await readDocument(collections, documentPlan);
	const observedHash = observed ? canonicalEjsonSha256(observed) : "";
	if (observedHash === afterHash) return observed;
	if (observedHash === beforeHash) {
		fail(
			`${documentPlan.role} CAS was lost${
				writeError ? ` (${writeError.message})` : ""
			}.`,
			"AGODA_2040450395_RECOVERY_CAS_LOST"
		);
	}
	fail(
		`${documentPlan.role} reached an unknown concurrent state.`,
		"AGODA_2040450395_RECOVERY_THIRD_STATE"
	);
}

async function compensate(collections, changedPlans, cause) {
	const errors = [];
	for (const documentPlan of [...changedPlans].reverse()) {
		const observed = await readDocument(collections, documentPlan);
		const hash = observed ? canonicalEjsonSha256(observed) : "";
		if (hash === documentPlan.originalHash) continue;
		if (hash !== documentPlan.expectedHash) {
			errors.push(`${documentPlan.role}:third_state`);
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
			errors.push(`${documentPlan.role}:${error.code || "restore_failed"}`);
		}
	}
	if (errors.length) {
		fail(
			`Recovery stopped in an unsafe partial state (${cause.message}; ${errors.join(
				","
			)}).`,
			"AGODA_2040450395_RECOVERY_MANUAL_INTERVENTION_REQUIRED"
		);
	}
	fail(
		`Recovery failed and every changed document was restored exactly (${cause.message}).`,
		"AGODA_2040450395_RECOVERY_COMPENSATED"
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
			"AGODA_2040450395_RECOVERY_TOPOLOGY_UNATTESTED"
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
			"Release attestation does not match the exact clean deployed checkout.",
			"AGODA_2040450395_RECOVERY_RELEASE_MISMATCH"
		);
	}
	return releaseSha;
}

function validateWorkerUnitState(output = "") {
	const values = Object.fromEntries(
		String(output)
			.split(/\r?\n/)
			.map((line) => line.split("="))
			.filter((parts) => parts.length === 2)
	);
	if (values.LoadState !== "loaded" || values.ActiveState !== "inactive") {
		fail(
			"The dedicated HotelRunner worker must be loaded and inactive before apply.",
			"AGODA_2040450395_RECOVERY_WORKER_NOT_STOPPED"
		);
	}
	return true;
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
	return validateWorkerUnitState(output);
}

async function verifyEvidenceUnchanged(collections, plan) {
	for (const role of ["event", "mirror", "reservation", "hotel"]) {
		const collectionName =
			role === "event"
				? "events"
				: role === "mirror"
					? "mirrors"
					: role === "reservation"
						? "reservations"
						: "hotels";
		const documentId =
			role === "event"
				? TARGET.eventId
				: role === "mirror"
					? TARGET.mirrorId
					: role === "reservation"
						? TARGET.reservationId
						: TARGET.hotelId;
		const observed = await collections[collectionName].findOne(
			{ _id: oid(documentId) },
			EXACT_READ_OPTIONS
		);
		if (!observed || canonicalEjsonSha256(observed) !== plan.originalHashes[role]) {
			fail(
				`${role} evidence changed during recovery.`,
				"AGODA_2040450395_RECOVERY_EVIDENCE_CHANGED"
			);
		}
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
	commercialPreflight = defaultCommercialPreflight,
}) {
	const parsedProof = parseProof(proof, now);
	validateReleaseAttestation(await resolveReleaseAttestation(), releaseSha);
	await assertWorkerStopped();
	let scope = await loadScope(collections);
	let plan = buildPlan(
		scope,
		parsedProof.plannedAt,
		releaseSha,
		now,
		ownerToken,
		{ commercialPreflight }
	);
	if (plan.scopeHash !== parsedProof.scopeHash) {
		fail(
			"Live exact scope no longer matches the dry-run proof.",
			"AGODA_2040450395_RECOVERY_PROOF_MISMATCH"
		);
	}
	const backupCount = await ensureBackups(collections, plan, now);
	await acquireApplyLock(collections, plan, releaseSha, now, ownerToken);
	const compensateOwned = async (cause, changed) => {
		let compensationError;
		try {
			await compensate(collections, changed, cause);
		} catch (error) {
			compensationError = error;
		}
		try {
			await finalizeApplyLock(collections, ownerToken, "compensated", now);
		} catch (lockError) {
			if (compensationError) compensationError.lockFinalizationError = lockError;
			else compensationError = lockError;
		}
		throw compensationError;
	};
	try {
		await assertWorkerStopped();
		scope = await loadScope(collections);
		plan = buildPlan(
			scope,
			parsedProof.plannedAt,
			releaseSha,
			now,
			ownerToken,
			{ commercialPreflight }
		);
		if (plan.scopeHash !== parsedProof.scopeHash) {
			fail(
				"Exact scope changed after backup creation.",
				"AGODA_2040450395_RECOVERY_PROOF_MISMATCH"
			);
		}
	} catch (error) {
		return compensateOwned(error, []);
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
		await assertWorkerStopped();
		for (const documentPlan of plan.documentPlans) {
			const observed = await readDocument(collections, documentPlan);
			if (
				!observed ||
				canonicalEjsonSha256(observed) !== documentPlan.expectedHash
			) {
				throw new Error("Post-write document image did not match its plan.");
			}
		}
		await verifyEvidenceUnchanged(collections, plan);
	} catch (error) {
		return compensateOwned(error, changed);
	}
	try {
		await finalizeApplyLock(collections, ownerToken, "applied", now);
	} catch (error) {
		return compensateOwned(error, changed);
	}
	return { changed: changed.length, backupCount, plan };
}

function sanitizedOutput(plan, mode, extra = {}) {
	return {
		mode,
		repairId: REPAIR_ID,
		scope: SCOPE_ATTESTATION,
		target: {
			confirmationNumber: TARGET.confirmationNumber,
			reservationId: TARGET.reservationId,
			eventId: TARGET.eventId,
			mirrorId: TARGET.mirrorId,
			jobId: TARGET.jobId,
			auditId: TARGET.auditId,
		},
		proof: mode === "dry_run" ? proofToken(plan) : undefined,
		proofExpiresInMinutes:
			mode === "dry_run" ? PROOF_MAX_AGE_MS / 60_000 : undefined,
		backupCollection: BACKUP_COLLECTION,
		mutationOrder: ["audit", "job"],
		mutatesReservations: false,
		mutatesEvents: false,
		mutatesMirrors: false,
		expectedCommercialResult: {
			clientTotal: TARGET.guestGross,
			hotelPayout: TARGET.hotelPayout,
			hotelRoot: TARGET.rootTotal,
			otaExpense: TARGET.otaExpense,
		},
		...extra,
	};
}

async function main({
	argv = process.argv.slice(2),
	clock = () => new Date(),
	connect = (database) =>
		mongoose.connect(database, { autoIndex: false, autoCreate: false }),
	disconnect = () => mongoose.disconnect(),
	injectedDb = null,
	injectedCollections = null,
	resolveReleaseAttestation = currentReleaseAttestation,
	assertWorkerStopped = workerIsStopped,
	assertTopology = assertStandaloneWritablePrimary,
	commercialPreflight = defaultCommercialPreflight,
	skipConnect = false,
} = {}) {
	const options = parseArguments(argv);
	if (options.help) {
		return {
			usage:
				"Dry run: node scripts/recoverAgoda2040450395Commercial20260811.js. Apply requires --apply plus the exact repair, scope, proof, release SHA, and worker-stopped attestations.",
		};
	}
	const database =
		process.env.DATABASE || process.env.MONGO_URI || process.env.MONGODB_URI;
	if (!skipConnect && !database) {
		fail(
			"Missing DATABASE/MONGO connection string.",
			"AGODA_2040450395_RECOVERY_DATABASE_REQUIRED"
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
			const releaseSha = validateReleaseAttestation(
				await resolveReleaseAttestation()
			);
			const plan = buildPlan(
				await loadScope(collections),
				now,
				releaseSha,
				now,
				"",
				{ commercialPreflight }
			);
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
			commercialPreflight,
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
							error?.code ||
							"AGODA_2040450395_RECOVERY_UNEXPECTED",
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
	APPLY_LOCK_ID,
	AWAITING_MESSAGE,
	BACKUP_COLLECTION,
	COLLECTION_NAMES,
	EXACT_READ_OPTIONS,
	JOB_HOLD_MS,
	PROOF_MAX_AGE_MS,
	REPAIR_ID,
	SCOPE_ATTESTATION,
	TARGET,
	WORKER_UNIT,
	RecoveryError,
	applyRecovery,
	applyUpdateToDocument,
	assertStandaloneWritablePrimary,
	backupRecord,
	buildAuditUpdate,
	buildFullDocumentCasFilter,
	buildJobUpdate,
	buildPlan,
	cloneFullBson,
	collectionsFromDb,
	compensate,
	defaultCommercialPreflight,
	directEligibleAuditQuery,
	ensureBackups,
	loadScope,
	main,
	parseArguments,
	parseProof,
	promoteBsonForServices,
	proofToken,
	replaceExact,
	sanitizedOutput,
	validateReleaseAttestation,
	validateScope,
	validateWorkerUnitState,
	verifyBackup,
	verifyEvidenceUnchanged,
};
